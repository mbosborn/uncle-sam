import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { wrangleAuth, wrangleSession, searchPeople, resolvePeople, enrichEmail, savePicks, searchText, runWrangleSearch, handleWrangleCommand, wrangleToolCheck } from '../service/lib/wrangle.mjs';
import { addToPool, readPool } from '../service/lib/clay-sourcing.mjs';
import { runDailySourcing, registerPostedBatch } from '../service/lib/sourcing.mjs';
import { enqueueOutreach, runOutreach } from '../service/lib/outreach.mjs';
import { laDate, laWall } from '../service/lib/takehome-nudge.mjs';
import { noticeStore } from '../service/lib/stuck-rejections.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const ENV = { WISPR_TOKEN_KEY: Buffer.alloc(32, 9).toString('base64'), UNCLE_SAM_PUBLIC_URL: 'https://your-project.example.com' };
const at = s => Date.parse(s);
const MORNING = at('2026-10-19T15:05:00Z'); // 8:05 AM PT
const PROJECT = 'U0F9EF97D89';
const TOOLS = [
  { name: 'people_search', description: 'Search', inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, mode: { type: 'string' }, limit: { type: 'integer', maximum: 200 } } } },
  { name: 'resolve_people', description: 'Resolve', inputSchema: { type: 'object', required: ['linkedinUrls'], properties: { linkedinUrls: { type: 'array' } } } },
  { name: 'enrich_email', description: 'Email', inputSchema: { type: 'object', properties: { personId: { type: 'string' }, linkedinUrl: { type: 'string' } } } },
  { name: 'create_collection', description: 'Create', inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, icon: { type: 'string' }, color: { type: 'string' } } } },
  { name: 'add_to_collection', description: 'Add', inputSchema: { type: 'object', required: ['collectionId', 'people'], properties: { collectionId: { type: 'string' }, people: { type: 'array' }, idempotencyKey: { type: 'string' } } } },
  { name: 'credit_snapshot', description: 'Credits', inputSchema: { type: 'object', properties: {} } },
];
/** A fake Wrangle: OAuth discovery exactly as app.usewrangle.com publishes it, and an MCP server. */
function fakeWrangle() {
  const w = { calls: [] };
  w.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/api/mcp/remote') {
      if (!init.headers?.authorization) return new Response('', { status: 401 });
      const msg = JSON.parse(init.body);
      if (msg.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18' } });
      if (!msg.id) return new Response(null, { status: 202 });
      if (msg.method === 'tools/list') return Response.json({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
      w.calls.push([msg.params.name, msg.params.arguments]);
      const r = {
        people_search: { people: [{ personId: 'w1', name: 'Priya Shah', linkedinUrl: 'https://www.linkedin.com/in/priya-shah', title: 'ML Engineer', currentCompany: { name: 'Zepto' }, location: 'Bengaluru' },
          { personId: 'w2', name: 'Arjun Rao', linkedinUrl: 'https://linkedin.com/in/arjunrao', title: 'Data Scientist', currentCompany: 'Swiggy' }] },
        resolve_people: { rows: [{ personId: 'w2', name: 'Arjun Rao', linkedinUrl: 'https://www.linkedin.com/in/arjunrao', title: 'Data Scientist', currentCompany: 'Swiggy' }] },
        enrich_email: { results: [{ personId: 'w1', emails: [{ address: 'Priya@example.test', type: 'work' }] }] },
        create_collection: { collection: { collectionId: 'col_9', name: 'x' } }, add_to_collection: { added: 1 }, credit_snapshot: { remaining: 5400, used: 99 } };
      return Response.json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(r[msg.params.name] ?? {}) }] } });
    }
    if (u.pathname === '/.well-known/oauth-protected-resource/api/mcp/remote') return Response.json({ resource: 'https://app.usewrangle.com/api/mcp/remote', authorization_servers: ['https://app.usewrangle.com'], scopes_supported: ['search'] });
    if (u.pathname === '/.well-known/oauth-authorization-server') return Response.json({ issuer: 'https://app.usewrangle.com', authorization_endpoint: 'https://app.usewrangle.com/api/mcp/oauth/authorize', token_endpoint: 'https://app.usewrangle.com/api/mcp/oauth/token', registration_endpoint: 'https://app.usewrangle.com/api/mcp/oauth/register', scopes_supported: ['search'] });
    if (u.pathname === '/api/mcp/oauth/register') return Response.json({ client_id: 'wr_cli' });
    if (u.pathname === '/api/mcp/oauth/token') return Response.json({ access_token: 'wat', refresh_token: 'wrt', expires_in: 3600 });
    return new Response('', { status: 404 });
  };
  return w;
}
async function connected(db, w, now = MORNING) {
  const auth = wrangleAuth({ env: ENV, db, fetchImpl: w.fetch, clock: () => now });
  const link = await auth.connectLink();
  const u = new URL(link.url);
  assert.equal(u.origin + u.pathname, 'https://app.usewrangle.com/api/mcp/oauth/authorize');
  assert.equal(u.searchParams.get('scope'), 'search');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://your-project.example.com/api/wrangle/callback');
  await auth.complete({ code: 'c', state: u.searchParams.get('state') });
  return wrangleSession({ env: ENV, db, fetchImpl: w.fetch, clock: () => now });
}

test('Wrangle: signs in through its published OAuth; search, resolve, email, save picks and credits fill their arguments from the schemas', async () => {
  const db = d1(), w = fakeWrangle();
  const session = await connected(db, w);
  const people = await searchPeople({ session, query: 'ML engineers in Bengaluru at startups' });
  assert.deepEqual(people.map(p => [p.slug, p.name, p.title, p.company, p.personId, p.from]), [['priya-shah', 'Priya Shah', 'ML Engineer', 'Zepto', 'w1', 'wrangle'], ['arjunrao', 'Arjun Rao', 'Data Scientist', 'Swiggy', 'w2', 'wrangle']]);
  assert.deepEqual(w.calls[0], ['people_search', { query: 'ML engineers in Bengaluru at startups', mode: 'fast', limit: 25 }]);
  assert.equal((await resolvePeople({ session, urls: ['https://www.linkedin.com/in/arjunrao'] })).get('arjunrao').title, 'Data Scientist');
  assert.equal(await enrichEmail({ session, person: people[0] }), 'priya@example.test');
  assert.deepEqual(w.calls.at(-1), ['enrich_email', { personId: 'w1', linkedinUrl: 'https://www.linkedin.com/in/priya-shah' }]);
  const saved = await savePicks({ db, session, people: [people[0]] });
  assert.equal(saved.collectionId, 'col_9');
  assert.equal(w.calls.at(-1)[0], 'add_to_collection');
  assert.deepEqual(w.calls.at(-1)[1].people, [{ personId: 'w1' }]);
  await savePicks({ db, session, people: [people[1]] });
  assert.equal(w.calls.filter(c => c[0] === 'create_collection').length, 1, 'the collection is made once');
  assert.equal(wrangleToolCheck(session.tools), 'Every tool I use is there.');
  assert.equal(await searchText({ claude: null, brief: 'ML engineers', taste: { bullets: ['startup background'] } }), 'ML engineers. startup background');
});

test('The morning: one Wrangle search from 8 AM PT into the pool; the ten at 8:30 come from it; no brief means one nudge and no search', async () => {
  const db = d1(), w = fakeWrangle(), kv = noticeStore(db), said = [];
  await connected(db, w);
  const run = now => runWrangleSearch({ env: ENV, db, fetchImpl: w.fetch, clock: () => now, addToPool, laDate, laWall, poster: async t => said.push(t) });
  assert.equal((await run(MORNING)).state, 'no_brief');
  await run(MORNING + 60_000);
  assert.equal(said.length, 1);
  assert.match(said[0], /^📋 Wrangle is connected, but I don't know who to search for yet/);
  await kv.put('sourcing:config', { brief: 'ML engineers in India, startup background' }, MORNING);
  assert.equal((await run(at('2026-10-19T14:00:00Z'))).state, 'too_early');
  const out = await run(MORNING + 120_000);
  assert.deepEqual([out.state, out.found, out.added], ['ran', 2, 2]);
  assert.equal((await run(MORNING + 300_000)).state, 'done_today');
  assert.equal(w.calls.filter(c => c[0] === 'people_search').length, 1, 'one search a day');
  const dms = [];
  const daily = await runDailySourcing({ db, claude: { complete: async () => ({ content: [{ type: 'tool_use', name: 'pick', input: { picks: (await readPool(db)).map(p => ({ slug: p.slug, why: 'fixture fit' })) } }] }) }, notion: { readControl: async () => ({ mode: 'Live' }) }, clock: () => at('2026-10-19T15:31:00Z'), poster: async t => { dms.push(t); return '1.2'; }, poolLeads: () => readPool(db) });
  assert.equal(daily.picked, 2);
  assert.match(dms[0], /^New candidates:\n\n• /);
  assert.match(dms[0], /<https:\/\/www\.linkedin\.com\/in\/priya-shah\|Priya Shah> — ML Engineer, Zepto\./);
});

test('Lists of bare links get real names; Wrangle finds the email before Clay; Project\'s wrangle status', async () => {
  const db = d1(), w = fakeWrangle();
  const session = await connected(db, w);
  const batch = await registerPostedBatch({ db, channelId: 'C01D1A69CE3', clock: () => MORNING, message: { ts: '1792500000.000100', user: PROJECT, text: 'https://www.linkedin.com/in/arjunrao\nhttps://www.linkedin.com/in/priya-shah' },
    resolve: urls => resolvePeople({ session, urls }) });
  assert.deepEqual(batch.people.map(p => [p.name, p.title]), [['Arjun Rao', 'Data Scientist'], ['Priya Shah', undefined]]);
  await noticeStore(db).put('outreach:config', { email: true }, MORNING);
  await enqueueOutreach({ db, person: { slug: 'priya-shah', linkedin: 'https://www.linkedin.com/in/priya-shah', name: 'Priya Shah', personId: 'w1' }, clock: () => MORNING });
  const mails = [];
  const clay = { startWith: async () => assert.fail('Clay is not needed when Wrangle finds it') };
  await runOutreach({ env: { OUTREACH_BOOKING_URL: 'https://calendar.app.google/x' }, db, notion: { readControl: async () => ({ mode: 'Live' }), getEmailTemplate: async () => null, findCandidatesByLinkedIn: async () => [] },
    gmail: { send: async m => { mails.push(m); return { id: 'abc1', threadId: 't' }; }, listInbox: async () => [] }, clay, findEmail: p => enrichEmail({ session, person: p }),
    masonPost: async () => '1.1', clock: () => MORNING });
  assert.equal(mails[0]?.to, 'priya@example.test');
  const replies = [];
  const out = await handleWrangleCommand({ event: { authorId: PROJECT, channelId: 'D1', messageTs: '1.1', text: 'wrangle credits' }, env: ENV, db, masonId: PROJECT, fetchImpl: w.fetch, clock: () => MORNING, poster: () => async t => replies.push(t) });
  assert.equal(out.reason, 'status');
  assert.match(replies[0], /^📋 Wrangle is connected\. Every tool I use is there\. 5400 credits left \(99 used this period\)\./);
});
