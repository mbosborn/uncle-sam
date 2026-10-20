import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { juiceboxAuth, juiceboxSession, peopleIn, argsFor, fetchLeads, sendFeedback, createAgent, linkedinSlug, toolNamed, juiceboxConnectText } from '../service/lib/juicebox.mjs';
import { resourceMetadataOf, wellKnown } from '../service/lib/mcp-oauth.mjs';
import { probeUnipile, webhookAuthentic, webhookSecret, readWebhook, unipileConfigured } from '../service/lib/unipile.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const ENV = { WISPR_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'), UNCLE_SAM_PUBLIC_URL: 'https://your-project.example.com' };
const NOW = Date.parse('2026-10-19T17:00:00Z');
const TOOLS = [
  { name: 'search_shortlist', description: 'List shortlisted candidates', inputSchema: { type: 'object', required: ['project_id'], properties: { project_id: { type: 'string' }, limit: { type: 'integer', maximum: 100 } } } },
  { name: 'get_candidate_details', description: 'Details', inputSchema: { type: 'object', required: ['candidate_id'], properties: { candidate_id: { type: 'string' } } } },
  { name: 'create_agent', description: 'Creates or fine-tunes an agent', inputSchema: { type: 'object', properties: { agent_id: { type: 'string' }, description: { type: 'string' }, feedback: { type: 'string' } } } },
  { name: 'start_sourcing', description: 'Start', inputSchema: { type: 'object', required: ['agent_id'], properties: { agent_id: { type: 'string' } } } },
];

/** A fake Juicebox: OAuth discovery, registration, tokens, and an MCP server. */
function fakeJuicebox() {
  const w = { calls: [], toolCalls: [], tokens: 0 };
  w.fetch = async (url, init = {}) => {
    const u = new URL(url);
    w.calls.push(`${init.method ?? 'GET'} ${u.host}${u.pathname}`);
    if (u.host === 'mcp.juicebox.ai' && u.pathname === '/v1') {
      const auth = init.headers?.authorization;
      if (!auth) return new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="https://mcp.juicebox.ai/.well-known/oauth-protected-resource/v1"' } });
      const msg = JSON.parse(init.body);
      if (msg.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18' } }, { headers: { 'mcp-session-id': 's1' } });
      if (!msg.id) return new Response(null, { status: 202 });
      if (msg.method === 'tools/list') return Response.json({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
      w.toolCalls.push([msg.params.name, msg.params.arguments]);
      const results = {
        search_shortlist: { candidates: [{ full_name: 'Priya Shah', linkedin_url: 'https://www.linkedin.com/in/Priya-Shah-1a2b/', candidate_id: 'c1', experience: [{ title: 'ML Engineer', company: { name: 'Zepto' } }, { title: 'Intern', company_name: 'Flipkart' }], location: 'Bengaluru' },
          { first_name: 'Arjun', last_name: 'Rao', profile: { url: 'https://linkedin.com/in/arjunrao' }, current_title: 'Data Scientist' }] },
        get_candidate_details: { candidate: { name: 'Priya Shah', linkedin: 'https://www.linkedin.com/in/priya-shah-1a2b', total_years_of_experience: 4, emails: [{ address: 'priya@example.test' }] } },
        create_agent: { agent: { id: 'agt_77' } }, start_sourcing: { ok: true } };
      return Response.json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(results[msg.params.name] ?? {}) }] } });
    }
    if (u.pathname === '/.well-known/oauth-protected-resource/v1') return Response.json({ resource: 'https://mcp.juicebox.ai/v1', authorization_servers: ['https://auth.juicebox.ai'], scopes_supported: ['mcp'] });
    if (u.host === 'auth.juicebox.ai' && u.pathname === '/.well-known/oauth-authorization-server') return Response.json({ authorization_endpoint: 'https://auth.juicebox.ai/authorize', token_endpoint: 'https://auth.juicebox.ai/token', registration_endpoint: 'https://auth.juicebox.ai/register', scopes_supported: ['mcp', 'offline_access'] });
    if (u.pathname === '/register') return Response.json({ client_id: 'cli_1' });
    if (u.pathname === '/token') { w.tokens++; const body = new URLSearchParams(init.body); w.lastGrant = body.get('grant_type'); return Response.json({ access_token: `at${w.tokens}`, refresh_token: 'rt', expires_in: 3600 }); }
    return new Response('', { status: 404 });
  };
  return w;
}

test('Juicebox sign-in: discovered from the 401, registered once, PKCE link, one-use callback, tokens sealed and refreshed', async () => {
  const db = d1(), w = fakeJuicebox();
  let now = NOW;
  const auth = juiceboxAuth({ env: ENV, db, fetchImpl: w.fetch, clock: () => now });
  const link = await auth.connectLink();
  assert.equal(link.status, 'link');
  const u = new URL(link.url);
  assert.equal(u.origin + u.pathname, 'https://auth.juicebox.ai/authorize');
  assert.equal(u.searchParams.get('client_id'), 'cli_1');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('scope'), 'mcp offline_access');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://your-project.example.com/api/juicebox/callback');
  assert.equal((await auth.connectLink()).status, 'pending');
  await assert.rejects(auth.complete({ code: 'c', state: 'wrong' }), { code: 'mcp_link_invalid' });
  await auth.connectLink({ force: true });
  const state = new URL((await juiceboxAuth({ env: ENV, db, fetchImpl: w.fetch, clock: () => now }).connectLink()).url).searchParams.get('state');
  await auth.complete({ code: 'code1', state });
  await assert.rejects(auth.complete({ code: 'code1', state }), { code: 'mcp_link_invalid' }, 'one use');
  assert.equal(await auth.accessToken(), 'at1');
  now += 3700_000;
  assert.equal(await auth.accessToken(), 'at2');
  assert.equal(w.lastGrant, 'refresh_token');
  assert.equal(w.calls.filter(c => c.endsWith('/register')).length, 1);
  assert.equal((await juiceboxConnectText({ env: ENV, db, fetchImpl: w.fetch, clock: () => now })).status, 'connected');
  assert.equal(resourceMetadataOf('Bearer resource_metadata="http://insecure"'), null);
  assert.deepEqual(wellKnown('https://x.ai/v1', 'oauth-protected-resource'), ['https://x.ai/.well-known/oauth-protected-resource/v1', 'https://x.ai/.well-known/oauth-protected-resource']);
});

test('Juicebox tools: people read from any result shape; arguments filled from the schema; leads, details, agent and feedback', async () => {
  const db = d1(), w = fakeJuicebox();
  const auth = juiceboxAuth({ env: ENV, db, fetchImpl: w.fetch, clock: () => NOW });
  await auth.connectLink();
  const state = new URL((await auth.connectLink({ force: true })).url).searchParams.get('state');
  await auth.complete({ code: 'c', state });
  const session = await juiceboxSession({ env: ENV, db, fetchImpl: w.fetch, clock: () => NOW });
  assert.equal(session.tools.length, 4);
  const leads = await fetchLeads({ session, source: { projectId: 'prj_1' } });
  assert.deepEqual(leads.map(l => [l.slug, l.name, l.title, l.company]), [['priya-shah-1a2b', 'Priya Shah', 'ML Engineer', 'Zepto'], ['arjunrao', 'Arjun Rao', 'Data Scientist', '']]);
  assert.deepEqual(leads[0].past, ['Intern at Flipkart']);
  assert.deepEqual(w.toolCalls[0], ['search_shortlist', { project_id: 'prj_1', limit: 50 }]);
  assert.equal(await argsFor({ tool: TOOLS[0], known: {} }), null, 'a required id it can\'t fill and no model');
  const made = await createAgent({ session, brief: 'ML engineers in India' });
  assert.equal(made.agentId, 'agt_77');
  assert.deepEqual(w.toolCalls.at(-1), ['start_sourcing', { agent_id: 'agt_77' }]);
  await sendFeedback({ session, agentId: 'agt_77', feedback: 'GOOD FIT: Priya' });
  assert.deepEqual(w.toolCalls.at(-1), ['create_agent', { agent_id: 'agt_77', feedback: 'GOOD FIT: Priya' }]);
  assert.equal(linkedinSlug('https://in.linkedin.com/in/Ab%C3%A9-x'), 'abé-x');
  assert.equal(toolNamed([{ name: 'juicebox__search_shortlist' }], 'search_shortlist').name, 'juicebox__search_shortlist');
  assert.equal(peopleIn({ a: [{ name: 'No Link' }] }).length, 0);
});

test('Unipile: the connection check finds the LinkedIn account, adds both webhooks with the secret header, and tells Project once', async () => {
  const db = d1(), env = { UNIPILE_DSN: 'api8.unipile.com:13851', UNIPILE_API_KEY: 'k'.repeat(40), CRON_SECRET: 's'.repeat(40) }, said = [], hooks = [];
  assert.equal(unipileConfigured(env), true);
  assert.equal(unipileConfigured({ ...env, UNIPILE_DSN: 'evil.com' }), false);
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    assert.equal(init.headers['x-api-key'], 'k'.repeat(40));
    if (u.pathname === '/api/v1/accounts') return Response.json({ items: [{ id: 'acc_1', type: 'LINKEDIN', name: 'Project Owner', connection_params: { im: { premiumFeatures: ['premium'] } } }, { id: 'acc_2', type: 'WHATSAPP' }] });
    if (u.pathname === '/api/v1/users/me') return Response.json({ provider_id: 'ME', first_name: 'Project', last_name: 'Owner' });
    if (u.pathname === '/api/v1/webhooks' && (init.method ?? 'GET') === 'GET') return Response.json({ items: [] });
    if (u.pathname === '/api/v1/webhooks') { hooks.push(JSON.parse(init.body)); return Response.json({ webhook_id: `w${hooks.length}` }); }
    return new Response('', { status: 404 });
  };
  const out = await probeUnipile({ env, db, fetchImpl, poster: async t => said.push(t), clock: () => NOW });
  assert.equal(out.state, 'ok');
  assert.deepEqual(hooks.map(h => [h.source, h.request_url]), [['messaging', 'https://your-project.example.com/api/unipile/webhook'], ['users', 'https://your-project.example.com/api/unipile/webhook']]);
  const secret = hooks[0].headers.find(h => h.key === 'X-Uncle-Sam-Secret').value;
  assert.equal(secret, await webhookSecret(env));
  assert.equal(await webhookAuthentic(env, new Headers({ 'x-uncle-sam-secret': secret })), true);
  assert.equal(await webhookAuthentic(env, new Headers({ 'x-uncle-sam-secret': 'nope' })), false);
  assert.match(said[0], /^🔗 LinkedIn is connected through Unipile as Project Owner \(premium\)\./);
  assert.doesNotMatch(said[0], /kkkk/);
  assert.equal((await probeUnipile({ env, db, fetchImpl, poster: async t => said.push(t), clock: () => NOW + 60_000 })).state, 'ok');
  assert.equal(said.length, 1);
  assert.deepEqual(readWebhook({ event: 'message_received', account_id: 'a', chat_id: 'c', message_id: 'm', message: 'hi', sender: { attendee_provider_id: 'P' } }).kind, 'message');
  assert.equal(readWebhook({ event: 'new_relation', user_provider_id: 'P', user_public_identifier: 'Priya' }).slug, 'priya');
  assert.equal(readWebhook({ event: 'account_status' }).kind, 'other');
});

test('The tool check after connecting says what this Juicebox account is missing', async () => {
  const { toolCheckText } = await import('../service/lib/juicebox.mjs');
  assert.equal(toolCheckText(TOOLS.concat([{ name: 'get_project' }])), 'Every tool I use is there.');
  assert.match(toolCheckText([{ name: 'get_data' }, { name: 'create_agent' }]), /^Missing on this Juicebox account: reading the shortlist, reading a project, profile details, starting the Agent \(some need the Business plan\)\. Without the shortlist or a project I can't pull profiles; Clay's companies still work\.$/);
});
