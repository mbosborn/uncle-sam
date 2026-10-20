import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { handleSlackRequest, verifySlackRequest, classifySlackEvent, createMcpHandler,
  constantTimeSecretEqual } from '../src/slack-protocol.mjs';

const NOW = 1_791_948_000_000;
const config = {
  signingSecret: 'test-only-slack-signing-secret',
  allowedAppIds: ['A09DDB3817C'], allowedTeamIds: ['T07011B7862'], botUserId: 'UBOT',
  allowedConversations: { im: ['DTEST'], mpim: ['GTRIAL'], channel: ['CTEST'], group: ['CPRIVATE'] },
  now: () => NOW, crypto: webcrypto,
};
const envelope = (event = {}, outer = {}) => ({ type: 'event_callback', event_id: 'EvTEST',
  api_app_id: 'A09DDB3817C', team_id: 'T07011B7862',
  event: { type: 'message', channel: 'DTEST', channel_type: 'im', user: 'URISHI',
    text: 'Review candidate — keep the original whitespace.  ', ts: '1791948000.001', ...event }, ...outer });

async function signed(payload, { timestamp = Math.floor(NOW / 1000), body, signatureBody,
  secret = config.signingSecret, headers = {} } = {}) {
  const raw = body ?? JSON.stringify(payload);
  const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await webcrypto.subtle.sign('HMAC', key,
    new TextEncoder().encode(`v0:${timestamp}:${signatureBody ?? raw}`));
  const signature = `v0=${Buffer.from(mac).toString('hex')}`;
  return new Request('https://bridge.example/slack/events', { method: 'POST', body: raw,
    headers: { 'content-type': 'application/json', 'x-slack-signature': signature,
      'x-slack-request-timestamp': String(timestamp), ...headers } });
}

test('valid signed messages retain exact text and route through every conversation allowlist', async () => {
  for (const [channel_type, channel] of [['im', 'DTEST'], ['mpim', 'GTRIAL'], ['channel', 'CTEST'], ['group', 'CPRIVATE']]) {
    const persisted = [];
    const response = await handleSlackRequest(await signed(envelope({ channel_type, channel })), config,
      { acceptEvent: async event => { persisted.push(event); } });
    assert.equal(response.status, 200);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].channelType, channel_type);
    assert.equal(persisted[0].text, envelope().event.text);
    assert.equal(persisted[0].authorId, 'URISHI');
  }
});

test('signature binds raw bytes, including whitespace and UTF-8', async () => {
  const pretty = JSON.stringify(envelope(), null, 2);
  assert.equal((await handleSlackRequest(await signed(null, { body: pretty }), config,
    { acceptEvent: async () => {} })).status, 200);
  const modified = await signed(null, { body: pretty, signatureBody: JSON.stringify(envelope()) });
  assert.equal((await handleSlackRequest(modified, config)).status, 401);
  assert.equal((await handleSlackRequest(await signed(envelope(), { secret: 'spoofed-secret' }), config)).status, 401);
});

test('missing or malformed signatures fail closed before storage', async () => {
  for (const signature of ['', 'v1=' + 'a'.repeat(64), 'v0=xyz']) {
    const response = await handleSlackRequest(await signed(envelope(), {
      headers: { 'x-slack-signature': signature } }), config, { acceptEvent: () => assert.fail('must not persist') });
    assert.equal(response.status, 401);
  }
});

test('past and future replay windows are bounded to five minutes inclusive', async () => {
  for (const delta of [-301, 301]) assert.equal((await handleSlackRequest(await signed(envelope(), {
    timestamp: NOW / 1000 + delta }), config)).status, 401);
  for (const delta of [-300, 300]) assert.equal((await handleSlackRequest(await signed(envelope(), {
    timestamp: NOW / 1000 + delta }), config, { acceptEvent: async () => {} })).status, 200);
});

test('signed cross-workspace and wrong-app messages are rejected', async () => {
  for (const outer of [{ team_id: 'TOTHER' }, { api_app_id: 'AOTHER' }, { team_id: undefined }, { api_app_id: undefined }]) {
    const response = await handleSlackRequest(await signed(envelope({}, outer)), config,
      { acceptEvent: () => assert.fail('must not persist') });
    assert.equal(response.status, 403);
  }
});

test('URL challenge requires the correct signature even without event-envelope IDs', async () => {
  const challenge = { type: 'url_verification', challenge: 'fixture-challenge' };
  const response = await handleSlackRequest(await signed(challenge), config);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { challenge: 'fixture-challenge' });
  assert.equal((await handleSlackRequest(await signed(challenge, { secret: 'wrong' }), config)).status, 401);
  assert.equal((await handleSlackRequest(await signed({ ...challenge, team_id: 'TOTHER' }), config)).status, 403);
});

test('oversized actual and declared bodies are rejected without trusting content-length', async () => {
  const payload = envelope({ text: 'x'.repeat(300) });
  for (const headers of [{}, { 'content-length': '1' }, { 'content-length': '1000000' }]) {
    const response = await handleSlackRequest(await signed(payload, { headers }), { ...config, maxBodyBytes: 128 },
      { acceptEvent: () => assert.fail('must not persist') });
    assert.equal(response.status, 413);
  }
});

test('ignore bots, self, non-amendment subtypes, hidden messages, and unknown or mismatched routes', async () => {
  const cases = [{ bot_id: 'BTEST' }, { bot_profile: {} }, { user: 'UBOT' },
    { subtype: 'message_replied' }, { subtype: 'bot_message' }, { hidden: true },
    { channel: 'DOTHER' }, { channel: 'DTEST', channel_type: 'channel' }, { type: 'reaction_added' }];
  for (const event of cases) {
    const response = await handleSlackRequest(await signed(envelope(event)), config,
      { acceptEvent: () => assert.fail('ignored event must not persist') });
    assert.equal(response.status, 200);
  }
});

test('an app mention is never a workflow message: ignored unless questions are on, and then a question event', () => {
  const mention = envelope({ type: 'app_mention', channel_type: undefined, channel: 'CPRIVATE' });
  assert.deepEqual(classifySlackEvent(mention, config), { accepted: false, reason: 'questions_disabled' });
  const asking = classifySlackEvent(mention, { ...config, questions: true });
  assert.equal(asking.accepted, true);
  assert.equal(asking.event.type, 'qa_question');
  assert.equal(asking.event.channelType, null);
  // Message events still need one exact configured conversation.
  const overlapping = { ...config, allowedConversations: { im: ['DTEST'], mpim: ['DTEST'] } };
  assert.equal(classifySlackEvent(envelope(), overlapping).accepted, false);
});

test('signed edits/deletes persist only source invalidation, never a new command', async () => {
  for (const change of [
    { subtype: 'message_changed', message: { ts: '1791947990.000001', user: 'URISHI', text: 'Wait' } },
    { subtype: 'message_deleted', deleted_ts: '1791947990.000001' },
  ]) {
    const persisted = [];
    const response = await handleSlackRequest(await signed(envelope({ ...change, hidden: true,
      user: undefined, event_ts: '1791948000.000003' })), config,
      { acceptEvent: async e => { persisted.push(e); return true; } });
    assert.equal(response.status, 200);
    assert.equal(persisted[0].type, 'source_amendment');
    assert.equal(persisted[0].targetMessageTs, '1791947990.000001');
    assert.equal(persisted[0].messageTs, '1791948000.000003');
    if (change.subtype === 'message_deleted') assert.equal(persisted[0].authorId, null);
  }
});

test('amendments reject missing targets and retain signature/workspace/conversation boundaries', async () => {
  const payload = envelope({ subtype: 'message_deleted', hidden: true, user: undefined,
    deleted_ts: '1791947990.000001' });
  assert.equal((await handleSlackRequest(await signed(payload, { secret: 'wrong' }), config)).status, 401);
  assert.equal((await handleSlackRequest(await signed({ ...payload, team_id: 'TOTHER' }), config)).status, 403);
  assert.equal((await handleSlackRequest(await signed(envelope({ subtype: 'message_deleted' })), config)).status, 400);
  const outside = envelope({ ...payload.event, channel: 'DOTHER' });
  assert.equal((await handleSlackRequest(await signed(outside), config,
    { acceptEvent: () => assert.fail('outside route must not persist') })).status, 200);
  assert.equal(classifySlackEvent(payload, { ...config, botUserId: undefined }).accepted, true);
});

test('malformed authenticated JSON and invalid event identity do not reach storage', async () => {
  const badJson = await handleSlackRequest(await signed(null, { body: '{broken' }), config);
  assert.equal(badJson.status, 400);
  for (const payload of [[], envelope({}, { event_id: undefined }), envelope({ ts: 'not-a-time' }), envelope({ user: null })]) {
    const response = await handleSlackRequest(await signed(payload), config,
      { acceptEvent: () => assert.fail('must not persist') });
    assert.equal(response.status, 400);
  }
});

test('durable store failure remains retryable and duplicate deliveries share one event key', async () => {
  const unavailable = await handleSlackRequest(await signed(envelope()), config,
    { acceptEvent: async () => { throw new Error('sensitive backend failure'); } });
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.text()).includes('sensitive'), false);
  const stored = new Map();
  for (let i = 0; i < 2; i++) {
    const response = await handleSlackRequest(await signed(envelope()), config,
      { acceptEvent: async event => { if (!stored.has(event.eventId)) stored.set(event.eventId, event); } });
    assert.equal(response.status, 200);
  }
  assert.equal(stored.size, 1);
  await assert.rejects(() => verifySlackRequest(new Request('https://bridge.example'), config),
    error => error.code === 'method_not_allowed');
});

const TOKEN = 'fixture-only-mcp-bearer';
function mcpRequest(message, { token = TOKEN, method = 'POST', body } = {}) {
  return new Request('https://bridge.example/mcp', { method,
    headers: { 'content-type': 'application/json', ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
    ...(method === 'POST' ? { body: body ?? JSON.stringify(message) } : {}) });
}
const rpc = (method, params = {}) => ({ jsonrpc: '2.0', id: 1, method, params });

test('MCP requires bearer auth for initialize, discovery, and event reads', async () => {
  const handler = createMcpHandler({ bearerToken: TOKEN, crypto: webcrypto,
    getEvent: () => assert.fail('unauthenticated read') });
  for (const token of [null, 'wrong', `${TOKEN}suffix`, '']) {
    const response = await handler(mcpRequest(rpc('tools/list'), { token }));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), 'Bearer');
  }
  assert.equal(await constantTimeSecretEqual(TOKEN, TOKEN, webcrypto), true);
  assert.equal(await constantTimeSecretEqual(TOKEN, `${TOKEN}suffix`, webcrypto), false);
});

test('MCP negotiates initialize, exposes only read-only tools, and fetches through dependencies', async () => {
  const fetched = [];
  const handler = createMcpHandler({ bearerToken: TOKEN, crypto: webcrypto,
    getHealth: async () => ({ status: 'healthy', pending: 2 }),
    getEvent: async id => { fetched.push(id); return { eventId: id, text: 'verified text' }; } });
  const init = await (await handler(mcpRequest(rpc('initialize', { protocolVersion: '2025-03-26' })))).json();
  assert.equal(init.result.protocolVersion, '2025-03-26');
  const listed = await (await handler(mcpRequest(rpc('tools/list')))).json();
  assert.deepEqual(listed.result.tools.map(t => t.name), ['health', 'get_event']);
  assert.ok(listed.result.tools.every(t => t.annotations.readOnlyHint));
  const health = await (await handler(mcpRequest(rpc('tools/call', { name: 'health' })))).json();
  assert.deepEqual(JSON.parse(health.result.content[0].text), { status: 'healthy', pending: 2 });
  const event = await (await handler(mcpRequest(rpc('tools/call', { name: 'get_event', arguments: { event_id: 'EvTEST' } })))).json();
  assert.deepEqual(fetched, ['EvTEST']);
  assert.equal(JSON.parse(event.result.content[0].text).text, 'verified text');
  const send = await (await handler(mcpRequest(rpc('tools/call', { name: 'send_message', arguments: {} })))).json();
  assert.equal(send.error.code, -32602);
});

test('MCP handles notifications without reads, rejects bad input and bounds bodies', async () => {
  const handler = createMcpHandler({ bearerToken: TOKEN, crypto: webcrypto, maxBodyBytes: 200,
    getEvent: () => assert.fail('invalid call must not read') });
  const notification = await handler(mcpRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  assert.equal(notification.status, 202);
  assert.equal(await notification.text(), '');
  assert.equal((await handler(mcpRequest(null, { method: 'GET' }))).status, 405);
  assert.equal((await handler(mcpRequest(null, { body: 'x'.repeat(201) }))).status, 413);
  assert.equal((await (await handler(mcpRequest(null, { body: '{bad' }))).json()).error.code, -32700);
  assert.equal((await (await handler(mcpRequest([rpc('ping')]))).json()).error.code, -32600);
  const bad = await (await handler(mcpRequest(rpc('tools/call', {
    name: 'get_event', arguments: { event_id: '../../other-record' } })))).json();
  assert.equal(bad.error.code, -32602);
});

test('MCP dependency failures do not disclose exceptions; missing events are explicit', async () => {
  const failed = createMcpHandler({ bearerToken: TOKEN, crypto: webcrypto,
    getEvent: async () => { throw new Error('secret-token-in-backend-message'); } });
  const response = await failed(mcpRequest(rpc('tools/call', { name: 'get_event', arguments: { event_id: 'EvTEST' } })));
  const text = await response.text();
  assert.equal(text.includes('secret-token'), false);
  assert.equal(JSON.parse(text).result.isError, true);
  const missing = createMcpHandler({ bearerToken: TOKEN, crypto: webcrypto, getEvent: async () => null });
  const result = await (await missing(mcpRequest(rpc('tools/call', { name: 'get_event', arguments: { event_id: 'EvMISS' } })))).json();
  assert.equal(result.result.content[0].text, 'event_not_found');
});

test('MCP extensions are explicit, authenticated, and receive only supplied arguments', async () => {
  const called = [];
  const handler = createMcpHandler({ bearerToken: TOKEN, crypto: webcrypto, additionalTools: [
    { name: 'list_pending', description: 'Read pending fixture IDs.', readOnlyHint: true,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async args => { called.push(args); return ['EvTEST']; } },
    { name: 'bounded_action', description: 'Test capability with its own validation.', readOnlyHint: false,
      inputSchema: { type: 'object', properties: { approved: { type: 'boolean' } }, required: ['approved'],
        additionalProperties: false },
      handler: async args => {
        if (Object.keys(args).length !== 1 || args.approved !== true) throw new Error('fixture rejected');
        called.push(args);
        return { accepted: true };
      } },
  ] });
  assert.equal((await handler(mcpRequest(rpc('tools/call', { name: 'bounded_action', arguments: { approved: true } }),
    { token: 'wrong' }))).status, 401);
  assert.deepEqual(called, []);
  const listed = await (await handler(mcpRequest(rpc('tools/list')))).json();
  assert.deepEqual(listed.result.tools.map(t => t.name), ['health', 'get_event', 'list_pending', 'bounded_action']);
  assert.equal(listed.result.tools[3].annotations.readOnlyHint, false);
  assert.equal('handler' in listed.result.tools[3], false);
  const pending = await (await handler(mcpRequest(rpc('tools/call', { name: 'list_pending' })))).json();
  assert.deepEqual(JSON.parse(pending.result.content[0].text), ['EvTEST']);
  const rejected = await (await handler(mcpRequest(rpc('tools/call', { name: 'bounded_action', arguments: {} })))).json();
  assert.equal(rejected.result.isError, true);
  const accepted = await (await handler(mcpRequest(rpc('tools/call', {
    name: 'bounded_action', arguments: { approved: true } })))).json();
  assert.deepEqual(JSON.parse(accepted.result.content[0].text), { accepted: true });
  assert.deepEqual(called, [{}, { approved: true }]);
  const health = await (await handler(mcpRequest(rpc('tools/call', { name: 'health' })))).json();
  assert.equal(JSON.parse(health.result.content[0].text).readOnly, false);
});

test('MCP extension configuration cannot shadow built-ins or silently label writable tools read-only', () => {
  const base = { name: 'fixture', description: 'A fixture.', inputSchema: { type: 'object' },
    handler: async () => null, readOnlyHint: true };
  for (const additionalTools of [null, [{ ...base, name: 'health' }], [base, base],
    [{ ...base, readOnlyHint: undefined }], [{ ...base, handler: null }], [{ ...base, inputSchema: {} }]]) {
    assert.throws(() => createMcpHandler({ bearerToken: TOKEN, additionalTools }),
      error => error.code === 'invalid_configuration');
  }
});

test('MCP missing token and unavailable crypto fail closed without invoking extensions', async () => {
  const extra = { name: 'fixture', description: 'A fixture.', inputSchema: { type: 'object' },
    readOnlyHint: false, handler: () => assert.fail('closed authentication must not invoke tool') };
  for (const bearerToken of [undefined, '', 'invalid token']) {
    const handler = createMcpHandler({ bearerToken, crypto: webcrypto, additionalTools: [extra] });
    assert.equal((await handler(mcpRequest(rpc('tools/call', { name: 'fixture' })))).status, 503);
  }
  const brokenCrypto = createMcpHandler({ bearerToken: TOKEN, crypto: {}, additionalTools: [extra] });
  assert.equal((await brokenCrypto(mcpRequest(rpc('tools/call', { name: 'fixture' })))).status, 503);
});
