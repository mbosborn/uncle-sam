// Worker-compatible transport boundary. No SDK, credentials, storage, or sends live here.
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const CONVERSATION_TYPES = ['im', 'mpim', 'channel', 'group'];
const MCP_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_SLACK_BYTES = 256 * 1024;
const MAX_MCP_BYTES = 64 * 1024;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.length > 0;
const eventIdValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

export class ProtocolError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'ProtocolError';
    this.code = code;
    this.status = status;
  }
}

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

function cryptoApi(injected) {
  const api = injected ?? globalThis.crypto;
  if (!api?.subtle) throw new ProtocolError('crypto_unavailable', 503);
  return api;
}

function limitValue(value, fallback) {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new ProtocolError('invalid_configuration', 503);
  return limit;
}

async function readBoundedBody(request, maxBytes) {
  const declared = request.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    throw new ProtocolError('body_too_large', 413);
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ProtocolError('body_too_large', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function requireJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) {
    throw new ProtocolError('unsupported_media_type', 415);
  }
}

function stringSet(value) {
  if (!(Array.isArray(value) || value instanceof Set)) throw new ProtocolError('invalid_configuration', 503);
  const set = new Set(value);
  if (!set.size || [...set].some(item => !nonempty(item))) throw new ProtocolError('invalid_configuration', 503);
  return set;
}

function scopeSets(config) {
  return { apps: stringSet(config.allowedAppIds), teams: stringSet(config.allowedTeamIds) };
}

function requireEnvelopeScope(payload, scopes, challenge = false) {
  // Slack's signed URL challenge has neither team_id nor api_app_id. The app-specific
  // signing secret authenticates it; reject a conflicting ID if one is supplied.
  if ((!challenge || payload.api_app_id !== undefined) && !scopes.apps.has(payload.api_app_id)) {
    throw new ProtocolError('app_not_allowed', 403);
  }
  if ((!challenge || payload.team_id !== undefined) && !scopes.teams.has(payload.team_id)) {
    throw new ProtocolError('workspace_not_allowed', 403);
  }
}

/** Validate the exact raw bytes before parsing JSON; allow no more than ±5 minutes. */
export async function verifySlackRequest(request, config = {}) {
  if (request.method !== 'POST') throw new ProtocolError('method_not_allowed', 405);
  requireJson(request);
  const bytes = await signedBody(request, config);
  let payload;
  try { payload = JSON.parse(decoder.decode(bytes)); }
  catch { throw new ProtocolError('invalid_json'); }
  if (!isObject(payload)) throw new ProtocolError('invalid_envelope');
  requireEnvelopeScope(payload, scopeSets(config), payload.type === 'url_verification');
  return { payload };
}

/**
 * A signed interactivity request (a button click or a form submission): the same signature and ±5 minute check as events,
 * over the raw form body, then the `payload` JSON, which must come from this app in this workspace.
 */
export async function verifySlackInteraction(request, config = {}) {
  if (request.method !== 'POST') throw new ProtocolError('method_not_allowed', 405);
  if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) throw new ProtocolError('unsupported_media_type', 415);
  const bytes = await signedBody(request, config);
  let payload;
  try { payload = JSON.parse(new URLSearchParams(decoder.decode(bytes)).get('payload') ?? ''); }
  catch { throw new ProtocolError('invalid_json'); }
  if (!isObject(payload) || !isObject(payload.user) || !isObject(payload.team)) throw new ProtocolError('invalid_envelope');
  const scopes = scopeSets(config);
  if (!scopes.apps.has(payload.api_app_id)) throw new ProtocolError('app_not_allowed', 403);
  if (!scopes.teams.has(payload.team.id) || (payload.user.team_id !== undefined && !scopes.teams.has(payload.user.team_id))) throw new ProtocolError('workspace_not_allowed', 403);
  if (payload.is_enterprise_install === true) throw new ProtocolError('workspace_not_allowed', 403);
  if (!/^[UW][A-Z0-9]+$/.test(payload.user.id ?? '')) throw new ProtocolError('invalid_envelope');
  return payload;
}

async function signedBody(request, config) {
  if (!nonempty(config.signingSecret)) throw new ProtocolError('invalid_configuration', 503);
  scopeSets(config); // a broken allowlist fails before anything is read
  const timestamp = request.headers.get('x-slack-request-timestamp') ?? '';
  const signature = request.headers.get('x-slack-signature') ?? '';
  if (!/^\d{1,15}$/.test(timestamp) || !/^v0=[a-f0-9]{64}$/.test(signature)) {
    throw new ProtocolError('invalid_signature', 401);
  }
  const seconds = Number(timestamp);
  const nowMs = typeof config.now === 'function' ? config.now() : Date.now();
  if (!Number.isFinite(nowMs)) throw new ProtocolError('invalid_configuration', 503);
  if (!Number.isSafeInteger(seconds) || Math.abs(Math.floor(nowMs / 1000) - seconds) > 300) {
    throw new ProtocolError('stale_request', 401);
  }
  const bytes = await readBoundedBody(request, limitValue(config.maxBodyBytes, MAX_SLACK_BYTES));
  const prefix = encoder.encode(`v0:${timestamp}:`);
  const signed = new Uint8Array(prefix.length + bytes.length);
  signed.set(prefix);
  signed.set(bytes, prefix.length);
  const crypto = cryptoApi(config.crypto);
  const key = await crypto.subtle.importKey('raw', encoder.encode(config.signingSecret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const received = Uint8Array.from(signature.slice(3).match(/../g), pair => Number.parseInt(pair, 16));
  if (!await crypto.subtle.verify('HMAC', key, received, signed)) throw new ProtocolError('invalid_signature', 401);
  return bytes;
}

function conversationType(event, allowlist = {}) {
  const matches = CONVERSATION_TYPES.filter(type => {
    const values = allowlist[type] ?? [];
    if (!(Array.isArray(values) || values instanceof Set)) throw new ProtocolError('invalid_configuration', 503);
    return new Set(values).has(event.channel);
  });
  // Exact IDs are authoritative; app_mention may omit channel_type. Never infer from
  // an ID prefix, since private channels can also have C-prefixed IDs.
  if (matches.length !== 1) return null;
  return event.channel_type === undefined || event.channel_type === matches[0] ? matches[0] : null;
}

/**
 * Someone @-mentioning the bot is asking it a question. That is never a workflow message: it gets its own event type so it can
 * not be read as feedback, a hold or a rejection, and it is accepted only when the deployment turned questions on
 * (config.questions === true). The mention may come from any conversation the bot was invited to, so the route allowlist does
 * not apply, but never from a Slack Connect channel: there the reply would be visible to people outside the workspace.
 */
function classifyQuestion(payload, event, config) {
  const ignored = reason => ({ accepted: false, reason });
  if (config.questions !== true) return ignored('questions_disabled');
  if (payload.is_ext_shared_channel === true || event.is_ext_shared_channel === true) return ignored('externally_shared_channel');
  const teams = scopeSets(config).teams;
  for (const team of [event.user_team, event.source_team]) {
    if (team !== undefined && team !== null && !teams.has(team)) return ignored('other_workspace_user');
  }
  if (event.subtype !== undefined && event.subtype !== null) return ignored('subtype');
  if (event.hidden === true) return ignored('hidden_event');
  if (!eventIdValid(payload.event_id) || !/^[UW][A-Z0-9]+$/.test(event.user ?? '') || !/^[CDG][A-Z0-9]+$/.test(event.channel ?? '') ||
      !/^\d+\.\d+$/.test(event.ts ?? '') || typeof event.text !== 'string') throw new ProtocolError('invalid_message');
  if (event.thread_ts !== undefined && !/^\d+\.\d+$/.test(event.thread_ts)) throw new ProtocolError('invalid_message');
  return { accepted: true, event: {
    eventId: payload.event_id, appId: payload.api_app_id, teamId: payload.team_id,
    type: 'qa_question', channelId: event.channel, channelType: null,
    authorId: event.user, messageTs: event.ts, threadTs: event.thread_ts ?? null, text: event.text,
  } };
}

/**
 * A plain message from a conversation that is not a workflow route. Two kinds can matter, both only with questions on:
 *   - a direct message to the bot from someone without a workflow DM is a question (`qa_question`, channelType 'im');
 *   - a reply inside a thread of a shared conversation the bot is in, without @-mentioning it, is a possible answer to a
 *     "which one did you mean" question (`qa_followup`). Ingress keeps it only when that thread has such an open question,
 *     so unrelated thread chatter is never stored. A message that @-mentions the bot is left to its app_mention copy.
 * Everything else stays ignored. Returns null for "not a question".
 */
function classifyUnrouted(payload, event, config) {
  if (config.questions !== true) return null;
  if (payload.is_ext_shared_channel === true || event.is_ext_shared_channel === true) return null;
  const teams = scopeSets(config).teams;
  for (const team of [event.user_team, event.source_team]) if (team !== undefined && team !== null && !teams.has(team)) return null;
  const direct = event.channel_type === 'im' && /^D[A-Z0-9]+$/.test(event.channel ?? '');
  const inThread = ['channel', 'group'].includes(event.channel_type) && /^[CG][A-Z0-9]+$/.test(event.channel ?? '') &&
    event.thread_ts !== undefined && event.thread_ts !== event.ts;
  if (!direct && !inThread) return null;
  if (!eventIdValid(payload.event_id) || !/^[UW][A-Z0-9]+$/.test(event.user ?? '') || !/^\d+\.\d+$/.test(event.ts ?? '') ||
      typeof event.text !== 'string') throw new ProtocolError('invalid_message');
  if (event.thread_ts !== undefined && !/^\d+\.\d+$/.test(event.thread_ts)) throw new ProtocolError('invalid_message');
  if (inThread && (!nonempty(config.botUserId) || event.text.includes(`<@${config.botUserId}`))) return null;
  return { accepted: true, event: {
    eventId: payload.event_id, appId: payload.api_app_id, teamId: payload.team_id,
    type: direct ? 'qa_question' : 'qa_followup', channelId: event.channel, channelType: direct ? 'im' : null,
    authorId: event.user, messageTs: event.ts, threadTs: event.thread_ts ?? null, text: event.text,
  } };
}

/** Call only with a verified envelope. This classifies messages, never human decisions. */
export function classifySlackEvent(payload, config = {}) {
  const ignored = reason => ({ accepted: false, reason });
  requireEnvelopeScope(payload, scopeSets(config));
  if (payload.type !== 'event_callback') return ignored('unsupported_envelope');
  const event = payload.event;
  if (!isObject(event)) throw new ProtocolError('invalid_event');
  if (!['message', 'app_mention'].includes(event.type)) return ignored('unsupported_event');
  if (event.bot_id || event.bot_profile ||
      (nonempty(config.botUserId) && event.user === config.botUserId)) return ignored('bot_or_self');
  if (event.type === 'app_mention') return classifyQuestion(payload, event, config);
  // Amendments revoke reliance on an earlier message; their new text is never a
  // replacement hiring instruction. Missing deletion authors are not invented.
  if (event.type === 'message' && ['message_changed', 'message_deleted'].includes(event.subtype)) {
    const type = conversationType(event, config.allowedConversations);
    if (!type) return ignored('conversation_not_allowed');
    const target = event.subtype === 'message_deleted' ? event.deleted_ts : event.message?.ts;
    const changedAt = event.event_ts ?? event.ts;
    if (!eventIdValid(payload.event_id) || !/^\d{1,13}\.\d{1,6}$/.test(target ?? '') ||
        !/^\d{1,13}\.\d{1,6}$/.test(changedAt ?? '')) throw new ProtocolError('invalid_amendment');
    const author = event.message?.user ?? event.previous_message?.user ?? null;
    return { accepted: true, event: {
      eventId: payload.event_id, appId: payload.api_app_id, teamId: payload.team_id,
      type: 'source_amendment', amendment: event.subtype, channelId: event.channel,
      channelType: type, authorId: /^[UW][A-Z0-9]+$/.test(author ?? '') ? author : null,
      messageTs: changedAt, targetMessageTs: target, threadTs: null,
      text: typeof event.message?.text === 'string' ? event.message.text : '',
    } };
  }
  // Other subtypes and system messages cannot become new instructions.
  if (event.subtype !== undefined && event.subtype !== null) return ignored('subtype');
  if (event.hidden === true) return ignored('hidden_event');
  const type = conversationType(event, config.allowedConversations);
  if (!type) return classifyUnrouted(payload, event, config) ?? ignored('conversation_not_allowed');
  if (!eventIdValid(payload.event_id) || !/^[UW][A-Z0-9]+$/.test(event.user ?? '') ||
      !/^\d+\.\d+$/.test(event.ts ?? '') || typeof event.text !== 'string') {
    throw new ProtocolError('invalid_message');
  }
  if (event.thread_ts !== undefined && !/^\d+\.\d+$/.test(event.thread_ts)) {
    throw new ProtocolError('invalid_message');
  }
  return { accepted: true, event: {
    eventId: payload.event_id,
    appId: payload.api_app_id,
    teamId: payload.team_id,
    type: event.type,
    channelId: event.channel,
    channelType: type,
    authorId: event.user,
    messageTs: event.ts,
    threadTs: event.thread_ts ?? null,
    text: event.text,
  } };
}

/**
 * acceptEvent must durably insert/deduplicate by eventId before resolving. Keep it
 * fast enough for Slack's three-second ACK; run Notion/LLM work after persistence.
 * Retries inside the valid timestamp window intentionally reach the same durable store.
 */
export async function handleSlackRequest(request, config, { acceptEvent } = {}) {
  try {
    const { payload } = await verifySlackRequest(request, config);
    if (payload.type === 'url_verification') {
      if (!nonempty(payload.challenge) || payload.challenge.length > 4096) throw new ProtocolError('invalid_challenge');
      return json({ challenge: payload.challenge });
    }
    const result = classifySlackEvent(payload, config);
    if (!result.accepted) return json({ ok: true });
    if (typeof acceptEvent !== 'function') throw new ProtocolError('event_store_unavailable', 503);
    try {
      if (await acceptEvent(result.event) === false) throw new Error('not persisted');
    } catch { throw new ProtocolError('event_store_unavailable', 503); }
    return json({ ok: true });
  } catch (error) {
    if (error instanceof ProtocolError) return json({ error: error.code }, error.status,
      error.status === 405 ? { allow: 'POST' } : {});
    return json({ error: 'request_failed' }, 503);
  }
}

/** Fixed-size digest comparison avoids a length-dependent early-return secret comparison. */
export async function constantTimeSecretEqual(left, right, injectedCrypto) {
  const crypto = cryptoApi(injectedCrypto);
  const [a, b] = await Promise.all([left, right].map(value =>
    crypto.subtle.digest('SHA-256', encoder.encode(value))));
  const aa = new Uint8Array(a), bb = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < aa.length; i++) difference |= aa[i] ^ bb[i];
  return difference === 0;
}

const MCP_TOOLS = [
  { name: 'health', description: 'Read the bridge health summary. Does not send messages or change records.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: 'get_event', description: 'Read one previously authenticated and allowlisted Slack event by its event ID.',
    inputSchema: { type: 'object', properties: { event_id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' } },
      required: ['event_id'], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
];
const rpcError = (id, code, message, status = 200) => json({ jsonrpc: '2.0', id, error: { code, message } }, status);
const rpcResult = (id, result) => json({ jsonrpc: '2.0', id, result });
const toolResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value ?? null) }] });
const toolError = code => ({ isError: true, content: [{ type: 'text', text: code }] });

function additionalToolMap(tools) {
  if (!Array.isArray(tools)) throw new ProtocolError('invalid_configuration', 503);
  const map = new Map();
  const names = new Set(MCP_TOOLS.map(tool => tool.name));
  for (const tool of tools) {
    if (!isObject(tool) || !/^[A-Za-z0-9_-]{1,64}$/.test(tool.name ?? '') || names.has(tool.name) ||
        !nonempty(tool.description) || !isObject(tool.inputSchema) || tool.inputSchema.type !== 'object' ||
        typeof tool.handler !== 'function' || typeof tool.readOnlyHint !== 'boolean') {
      throw new ProtocolError('invalid_configuration', 503);
    }
    names.add(tool.name);
    map.set(tool.name, { handler: tool.handler, descriptor: {
      name: tool.name,
      description: tool.description,
      inputSchema: structuredClone(tool.inputSchema),
      // Hints describe tools to the client; the handler, not these hints, enforces policy.
      annotations: { readOnlyHint: tool.readOnlyHint },
    } });
  }
  return map;
}

/**
 * Stateless MCP HTTP handler, read-only by default. getEvent must expose only events admitted by
 * the Slack verifier. getHealth must return sanitized status, never environment secrets.
 * Optional additionalTools are explicit capabilities, all behind the same bearer auth.
 * Their handlers receive arguments and must validate their schema, enforce authorization
 * and deduplication, and return JSON-serializable data. No mutation is built into this module.
 */
export function createMcpHandler({ bearerToken, getHealth,
  getEvent, additionalTools = [], maxBodyBytes = MAX_MCP_BYTES, crypto: injectedCrypto } = {}) {
  const extra = additionalToolMap(additionalTools);
  const listedTools = [...MCP_TOOLS, ...[...extra.values()].map(tool => tool.descriptor)];
  const health = getHealth ?? (async () => ({ status: 'ok',
    readOnly: listedTools.every(tool => tool.annotations.readOnlyHint) }));
  return async request => {
    if (!nonempty(bearerToken) || /\s/.test(bearerToken)) return json({ error: 'mcp_not_configured' }, 503);
    const header = request.headers.get('authorization') ?? '';
    const supplied = header.length <= 4096 ? /^Bearer ([^\s]+)$/i.exec(header)?.[1] : undefined;
    try {
      if (!supplied || !await constantTimeSecretEqual(supplied, bearerToken, injectedCrypto)) {
        return json({ error: 'unauthorized' }, 401, { 'www-authenticate': 'Bearer' });
      }
    } catch { return json({ error: 'authentication_unavailable' }, 503); }
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST' });
    let message;
    try {
      requireJson(request);
      const bytes = await readBoundedBody(request, limitValue(maxBodyBytes, MAX_MCP_BYTES));
      try { message = JSON.parse(decoder.decode(bytes)); }
      catch { return rpcError(null, -32700, 'Parse error', 400); }
    } catch (error) {
      return json({ error: error instanceof ProtocolError ? error.code : 'request_failed' },
        error instanceof ProtocolError ? error.status : 503);
    }
    const validId = message?.id === undefined || typeof message?.id === 'string' ||
      (typeof message?.id === 'number' && Number.isFinite(message.id));
    if (!isObject(message) || message.jsonrpc !== '2.0' || !nonempty(message.method) || !validId ||
        (message.params !== undefined && !isObject(message.params))) {
      return rpcError(null, -32600, 'Invalid Request', 400);
    }
    // Notifications have no response and may not invoke even read-only dependencies.
    if (message.id === undefined) return new Response(null, { status: 202, headers: { 'cache-control': 'no-store' } });
    const { id, method, params = {} } = message;
    if (method === 'initialize') return rpcResult(id, {
      protocolVersion: MCP_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : MCP_VERSIONS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'uncle-sam-bridge', version: '0.1.0' },
    });
    if (method === 'ping') return rpcResult(id, {});
    if (method === 'tools/list') return rpcResult(id, { tools: listedTools });
    if (method !== 'tools/call') return rpcError(id, -32601, 'Method not found');
    const args = params.arguments ?? {};
    if (!isObject(args)) return rpcError(id, -32602, 'Invalid params');
    if (!listedTools.some(tool => tool.name === params.name)) return rpcError(id, -32602, 'Unknown tool');
    try {
      const added = extra.get(params.name);
      if (added) return rpcResult(id, toolResult(await added.handler(args)));
      if (params.name === 'health') {
        if (Object.keys(args).length) return rpcError(id, -32602, 'Invalid params');
        return rpcResult(id, toolResult(await health()));
      }
      if (Object.keys(args).length !== 1 || !eventIdValid(args.event_id)) return rpcError(id, -32602, 'Invalid params');
      if (typeof getEvent !== 'function') return rpcResult(id, toolError('event_store_unavailable'));
      const event = await getEvent(args.event_id);
      return rpcResult(id, event == null ? toolError('event_not_found') : toolResult(event));
    } catch { return rpcResult(id, toolError('tool_failed')); }
  };
}
