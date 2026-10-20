/**
 * A remote MCP server reached with its own OAuth sign-in (authorization code + PKCE, dynamic client registration), found by
 * the MCP authorization spec's discovery: the server's 401 names its protected-resource metadata, which names the
 * authorization server, whose metadata names the endpoints. Used for Juicebox (juicebox.mjs); Wispr keeps its own fixed
 * endpoints (wispr.mjs). Tokens are sealed with the bot's token key (seal/unseal in wispr.mjs) in uncle_sam_notices.
 *
 * Nothing here knows any one server: the caller passes a key prefix (e.g. "juicebox"), the MCP URL and the callback URL.
 */
import { seal, unseal, rpcReplyOf } from './wispr.mjs';
import { noticeStore } from './stuck-rejections.mjs';

export class McpOAuthError extends Error {
  constructor(code, extra = {}) { super(code); this.code = code; Object.assign(this, extra); }
}
const fail = (code, extra) => { throw new McpOAuthError(code, extra); };
const b64u = bytes => Buffer.from(bytes).toString('base64url');
const random = n => crypto.getRandomValues(new Uint8Array(n));
const MAX_BODY = 2 * 1024 * 1024;
export const LINK_TTL_MS = 24 * 3600_000;

async function http(fetchImpl, url, init = {}, timeoutMs = 20_000) {
  try { return await fetchImpl(url, { redirect: 'error', ...init, signal: AbortSignal.timeout(timeoutMs) }); }
  catch (error) { fail(error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'mcp_timeout' : 'mcp_network'); }
}
async function bodyJson(response, code) {
  const text = await response.text().catch(() => '');
  if (text.length > MAX_BODY) fail('mcp_response_too_large');
  try { return JSON.parse(text); } catch { fail(code); }
}
const httpsOk = url => { try { return new URL(url).protocol === 'https:'; } catch { return false; } };

/** resource_metadata="..." out of a WWW-Authenticate header. */
export function resourceMetadataOf(header) {
  const m = /resource_metadata="([^"]+)"/i.exec(String(header ?? ''));
  return m && httpsOk(m[1]) ? m[1] : null;
}

/** The well-known URLs to try for a base URL, path-inserted form first (RFC 8414 §3 / RFC 9728 §3). */
export function wellKnown(base, suffix) {
  const u = new URL(base), path = u.pathname.replace(/\/+$/, '');
  return [...new Set([`${u.origin}/.well-known/${suffix}${path}`, `${u.origin}/.well-known/${suffix}`])];
}

/**
 * Finds the authorization server for an MCP URL. -> { authorizationEndpoint, tokenEndpoint, registrationEndpoint, scopes, resource }
 */
export async function discover({ mcpUrl, fetchImpl = globalThis.fetch }) {
  let metadataUrl = null;
  const probe = await http(fetchImpl, mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'uncle-sam', version: '1' } } }) });
  if (probe.status === 401) metadataUrl = resourceMetadataOf(probe.headers.get('www-authenticate'));
  try { await probe.body?.cancel?.(); } catch { /* freed */ }
  let resource = { resource: mcpUrl };
  for (const url of [metadataUrl, ...wellKnown(mcpUrl, 'oauth-protected-resource')].filter(Boolean)) {
    const r = await http(fetchImpl, url, { headers: { accept: 'application/json' } }).catch(() => null);
    if (r?.ok) { resource = await bodyJson(r, 'mcp_resource_metadata_invalid'); break; }
    try { await r?.body?.cancel?.(); } catch { /* freed */ }
  }
  const issuer = (Array.isArray(resource.authorization_servers) ? resource.authorization_servers : []).find(httpsOk) ?? new URL(mcpUrl).origin;
  let as = null;
  for (const url of [...wellKnown(issuer, 'oauth-authorization-server'), ...wellKnown(issuer, 'openid-configuration')]) {
    const r = await http(fetchImpl, url, { headers: { accept: 'application/json' } }).catch(() => null);
    if (r?.ok) { as = await bodyJson(r, 'mcp_as_metadata_invalid'); break; }
    try { await r?.body?.cancel?.(); } catch { /* freed */ }
  }
  if (!as || !httpsOk(as.authorization_endpoint) || !httpsOk(as.token_endpoint)) fail('mcp_discovery_failed');
  const scopes = [...new Set([...(Array.isArray(resource.scopes_supported) ? resource.scopes_supported : []),
    ...((as.scopes_supported ?? []).includes('offline_access') ? ['offline_access'] : [])])].filter(s => typeof s === 'string' && s.length < 100);
  return { authorizationEndpoint: as.authorization_endpoint, tokenEndpoint: as.token_endpoint,
    registrationEndpoint: httpsOk(as.registration_endpoint) ? as.registration_endpoint : null, scopes, resource: typeof resource.resource === 'string' ? resource.resource : mcpUrl };
}

/** One server's sign-in and tokens, kept under `<prefix>:...` in uncle_sam_notices (tokens sealed). */
export function mcpOAuth({ env, db, prefix, mcpUrl, callbackUrl, clientName, fetchImpl = globalThis.fetch, clock = Date.now }) {
  const kv = noticeStore(db);
  const K = name => `${prefix}:${name}`;
  async function server() {
    const saved = await kv.get(K('as'));
    if (saved?.tokenEndpoint && saved.callbackUrl === callbackUrl) return saved;
    const found = await discover({ mcpUrl, fetchImpl });
    let clientId = env[`${prefix.toUpperCase()}_CLIENT_ID`] || null;
    if (!clientId) {
      if (!found.registrationEndpoint) fail('mcp_no_registration');
      const r = await http(fetchImpl, found.registrationEndpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ client_name: clientName, redirect_uris: [callbackUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
          token_endpoint_auth_method: 'none', ...(found.scopes.length ? { scope: found.scopes.join(' ') } : {}) }) });
      if (!r.ok) fail(`mcp_register_http_${r.status}`);
      clientId = (await bodyJson(r, 'mcp_register_invalid'))?.client_id;
      if (typeof clientId !== 'string' || !clientId || clientId.length > 300) fail('mcp_register_invalid');
    }
    const value = { ...found, clientId, callbackUrl, at: clock() };
    await kv.put(K('as'), value, clock());
    return value;
  }
  return Object.freeze({
    async connected() { return !!(await kv.get(K('tokens'))); },
    async record() { return kv.get(K('tokens')); },
    /** -> { status: 'connected' | 'pending' | 'link', url?, expiresAt? } */
    async connectLink({ force = false } = {}) {
      const now = clock();
      if (!force && await kv.get(K('tokens'))) return { status: 'connected' };
      const pending = await kv.get(K('pending'));
      if (!force && pending && pending.expiresAt > now) return { status: 'pending', expiresAt: pending.expiresAt, url: pending.url };
      const as = await server();
      const state = b64u(random(32)), verifier = b64u(random(48));
      const challenge = b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
      const url = new URL(as.authorizationEndpoint);
      for (const [k, v] of Object.entries({ response_type: 'code', client_id: as.clientId, redirect_uri: callbackUrl, state, code_challenge: challenge,
        code_challenge_method: 'S256', resource: as.resource, ...(as.scopes.length ? { scope: as.scopes.join(' ') } : {}) })) url.searchParams.set(k, v);
      const expiresAt = now + LINK_TTL_MS;
      await kv.put(K('pending'), { state, verifier: await seal(env, verifier), expiresAt, url: url.toString() }, now);
      return { status: 'link', url: url.toString(), expiresAt };
    },
    /** The callback: one use, 24 hours. */
    async complete({ code, state }) {
      const now = clock();
      if (typeof code !== 'string' || !code || code.length > 4000 || typeof state !== 'string' || !state || state.length > 200) fail('mcp_callback_invalid');
      const pending = await kv.get(K('pending'));
      if (!pending || pending.state !== state) fail('mcp_link_invalid');
      await kv.del(K('pending'));
      if (pending.expiresAt <= now) fail('mcp_link_expired');
      const as = await kv.get(K('as'));
      if (!as?.tokenEndpoint) fail('mcp_client_missing');
      const r = await http(fetchImpl, as.tokenEndpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: callbackUrl, client_id: as.clientId, code_verifier: await unseal(env, pending.verifier), resource: as.resource }).toString() });
      if (!r.ok) fail(`mcp_token_http_${r.status}`);
      const t = await bodyJson(r, 'mcp_token_invalid');
      if (typeof t.access_token !== 'string' || !t.access_token) fail('mcp_token_invalid');
      const saved = { access: t.access_token, refresh: typeof t.refresh_token === 'string' ? t.refresh_token : null, expiresAt: now + 1000 * (Number(t.expires_in) > 0 ? Number(t.expires_in) : 3600) };
      await kv.put(K('tokens'), { sealed: await seal(env, JSON.stringify(saved)), connectedAt: now }, now);
      await kv.del(K('linkTold'));
      return { connectedAt: now };
    },
    /** A current access token, refreshed when near expiry. A refused refresh disconnects (the next connect link goes out). */
    async accessToken() {
      const now = clock();
      const record = await kv.get(K('tokens'));
      if (!record) fail('mcp_not_connected');
      const t = JSON.parse(await unseal(env, record.sealed));
      if (t.expiresAt - 120_000 > now) return t.access;
      if (!t.refresh) { await kv.del(K('tokens')); fail('mcp_disconnected'); }
      const as = await kv.get(K('as'));
      const r = await http(fetchImpl, as.tokenEndpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: as.clientId, resource: as.resource }).toString() });
      if (r.status === 400 || r.status === 401) { await kv.del(K('tokens')); fail('mcp_disconnected'); }
      if (!r.ok) fail(`mcp_refresh_http_${r.status}`);
      const f = await bodyJson(r, 'mcp_refresh_invalid');
      if (typeof f.access_token !== 'string' || !f.access_token) fail('mcp_refresh_invalid');
      const next = { access: f.access_token, refresh: typeof f.refresh_token === 'string' && f.refresh_token ? f.refresh_token : t.refresh, expiresAt: now + 1000 * (Number(f.expires_in) > 0 ? Number(f.expires_in) : 3600) };
      await kv.put(K('tokens'), { ...record, sealed: await seal(env, JSON.stringify(next)) }, now);
      return next.access;
    },
    async disconnect() { await kv.del(K('tokens')); },
  });
}

/** A minimal MCP client over Streamable HTTP for any server: initialize, tools/list, tools/call. */
export async function mcpClient({ mcpUrl, accessToken, fetchImpl = globalThis.fetch, timeoutMs = 60_000 }) {
  let sessionId = null, version = '2025-06-18', id = 0;
  async function post(payload, expectReply = true) {
    const r = await http(fetchImpl, mcpUrl, { method: 'POST', body: JSON.stringify(payload), headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json',
      accept: 'application/json, text/event-stream', 'mcp-protocol-version': version, ...(sessionId ? { 'mcp-session-id': sessionId } : {}) } }, timeoutMs);
    if (r.status === 401 || r.status === 403) { try { await r.body?.cancel?.(); } catch { /* freed */ } fail('mcp_unauthorized'); }
    if (!r.ok) { try { await r.body?.cancel?.(); } catch { /* freed */ } fail(`mcp_http_${r.status}`); }
    sessionId = r.headers.get('mcp-session-id') ?? sessionId;
    if (!expectReply) { try { await r.body?.cancel?.(); } catch { /* freed */ } return null; }
    const text = await r.text();
    if (text.length > MAX_BODY) fail('mcp_response_too_large');
    // The server's own error message is kept (a JSON-RPC error says why a call was refused).
    const rpcError = (() => {
      for (const chunk of [text, ...text.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5))]) {
        try { const m = JSON.parse(chunk); for (const x of Array.isArray(m) ? m : [m]) if (x?.id === payload.id && x.error) return x.error; } catch { /* not this chunk */ }
      }
      return null;
    })();
    if (rpcError) fail('mcp_rpc_error', { reason: String(rpcError.message ?? rpcError.code ?? '').replace(/\s+/g, ' ').slice(0, 300) });
    try { return rpcReplyOf(text, payload.id); } catch (error) { fail(String(error?.code ?? 'mcp_rpc').replace(/^wispr_/, 'mcp_')); }
  }
  const init = await post({ jsonrpc: '2.0', id: ++id, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'uncle-sam', version: '1' } } });
  if (typeof init?.protocolVersion === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(init.protocolVersion)) version = init.protocolVersion;
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, false);
  return Object.freeze({
    async tools() {
      const out = [];
      let cursor;
      for (let page = 0; page < 5; page++) {
        const r = await post({ jsonrpc: '2.0', id: ++id, method: 'tools/list', params: cursor ? { cursor } : {} });
        out.push(...(Array.isArray(r?.tools) ? r.tools : []));
        cursor = r?.nextCursor;
        if (!cursor) break;
      }
      return out.map(t => ({ name: String(t.name), description: String(t.description ?? '').slice(0, 1500), inputSchema: t.inputSchema ?? { type: 'object' } }));
    },
    /** -> parsed JSON (structuredContent, or the text parsed), or { text } when it isn't JSON. Tool errors throw mcp_tool_error. */
    async call(name, args = {}) {
      const r = await post({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } });
      const text = (r?.content ?? []).filter(c => c?.type === 'text').map(c => c.text).join('\n');
      if (r?.isError) fail('mcp_tool_error', { reason: text.replace(/\s+/g, ' ').slice(0, 300) });
      if (r?.structuredContent && typeof r.structuredContent === 'object') return r.structuredContent;
      try { return JSON.parse(text); } catch { return { text: text.slice(0, 60_000) }; }
    },
  });
}
