import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { oktaConfigured, createOktaClient, probeOkta, oktaReady, oktaConnected, setUpOkta, handleOktaGroups, hireGroups } from '../service/lib/okta.mjs';
import { runOnboarding } from '../service/lib/onboarding.mjs';
import { handleOktaCommand } from '../service/lib/project-commands.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const ENV = Object.freeze({ OKTA_DOMAIN: 'example.okta.com', OKTA_API_TOKEN: '00abcdefghijklmnopqrstuvwxyz0123456789ABCD' });
const at = iso => Date.parse(iso);
const PROJECT = 'U0F9EF97D89';

/** A tiny fake Okta org behind fetch. */
function fakeOrg({ users = [], failCreate = null } = {}) {
  const org = { users: users.map(u => ({ ...u })), groups: [{ id: '00gEVERYONE0001', type: 'BUILT_IN', profile: { name: 'Everyone' } }, { id: '00gENGINEER0001', type: 'OKTA_GROUP', profile: { name: 'Engineering' } }, { id: '00gCONTRACT0001', type: 'OKTA_GROUP', profile: { name: 'Contractors' } }], calls: [] };
  org.fetch = async (url, init = {}) => {
    const u = new URL(url), method = init.method ?? 'GET', path = u.pathname.replace('/api/v1', '');
    org.calls.push(`${method} ${path}${u.search}`);
    assert.equal(u.host, 'example.okta.com');
    assert.match(init.headers.authorization, /^SSWS 00/);
    if (path === '/users/me') return Response.json({ profile: { login: 'project@company.example', firstName: 'Project', lastName: 'Owner' } });
    if (path === '/groups') return Response.json(org.groups);
    let m;
    if ((m = /^\/users\/([^/]+)$/.exec(path)) && method === 'GET') {
      const user = org.users.find(x => x.profile.login === decodeURIComponent(m[1]) || x.id === m[1]);
      return user ? Response.json(user) : Response.json({ errorSummary: 'Not found' }, { status: 404 });
    }
    if (path === '/users' && method === 'POST') {
      if (failCreate) return Response.json({ errorSummary: failCreate.summary }, { status: failCreate.status });
      const body = JSON.parse(init.body);
      const user = { id: `00u${org.users.length + 1}NEW`, status: 'PROVISIONED', profile: body.profile, groupIds: body.groupIds ?? [] };
      org.users.push(user);
      return Response.json(user);
    }
    if ((m = /^\/users\/([^/]+)\/groups$/.exec(path))) return Response.json([]);
    if ((m = /^\/groups\/([^/]+)\/users\/([^/]+)$/.exec(path))) return new Response(null, { status: 204 });
    if ((m = /^\/users\/([^/]+)\/lifecycle\/(suspend|activate)$/.exec(path))) { const user = org.users.find(x => x.id === m[1]); user.status = m[2] === 'suspend' ? 'SUSPENDED' : 'ACTIVE'; return Response.json({}); }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return org;
}

test('Okta: off until a domain and token are both in; UNCLE_SAM_OKTA=off stops it', () => {
  assert.equal(oktaConfigured({}), false);
  assert.equal(oktaConfigured({ OKTA_DOMAIN: 'example.okta.com' }), false);
  assert.equal(oktaConfigured(ENV), true);
  assert.equal(oktaConfigured({ ...ENV, OKTA_DOMAIN: 'https://example.okta.com/' }), true);
  assert.equal(oktaConfigured({ ...ENV, UNCLE_SAM_OKTA: 'off' }), false);
});

test('Okta: the connection check tells Project once, asks which groups, and nothing is set up until he picks', async () => {
  const db = d1(), org = fakeOrg(), said = [];
  const r = await probeOkta({ env: ENV, db, fetchImpl: org.fetch, poster: async t => said.push(t), clock: () => at('2026-10-19T17:00:00Z') });
  assert.equal(r.state, 'ok');
  assert.equal(said.length, 1);
  assert.match(said[0], /^🔐 Okta is connected \(example\.okta\.com, acting as project@company\.example\)\. Which groups should new hires go in\? .*Everyone, Engineering, Contractors/);
  assert.doesNotMatch(said[0], /00abcdef/, 'never the token');
  assert.equal(await oktaConnected({ env: ENV, db }), true);
  assert.equal(await oktaReady({ env: ENV, db }), false, 'no groups picked yet');
  assert.equal((await probeOkta({ env: ENV, db, fetchImpl: org.fetch, poster: async t => said.push(t), clock: () => at('2026-10-19T18:00:00Z') })).state, 'ok');
  assert.equal(said.length, 1, 'once per key');
  const okta = createOktaClient({ env: ENV, fetchImpl: org.fetch }), replies = [];
  const ev = text => ({ authorId: PROJECT, channelId: 'D0C95KBR09J', messageTs: '1.1', text });
  assert.equal(await handleOktaGroups({ event: ev('thanks'), env: ENV, db, masonId: PROJECT, okta, poster: () => async t => replies.push(t) }), null);
  assert.equal((await handleOktaGroups({ event: ev('okta groups: engineering, Contractors, Interns'), env: ENV, db, masonId: PROJECT, okta, poster: () => async t => replies.push(t) })).reason, null);
  assert.equal(replies[0], 'Roger that 🫡 New hires go in: Engineering, Contractors. From now on I set them up in Okta myself. Not found: Interns.');
  assert.deepEqual((await hireGroups({ env: ENV, db })).map(g => g.id), ['00gENGINEER0001', '00gCONTRACT0001']);
  assert.equal(await oktaReady({ env: ENV, db }), true);
  assert.equal(await oktaReady({ env: { ...ENV, OKTA_GROUP_IDS: 'none' }, db: d1() }), false, 'still needs the connection check');
});

test('Okta: a bad key is told once, AA keeps the asks', async () => {
  const db = d1(), said = [];
  const fetchImpl = async () => Response.json({ errorSummary: 'Invalid token provided' }, { status: 401 });
  assert.equal((await probeOkta({ env: ENV, db, fetchImpl, poster: async t => said.push(t), clock: () => at('2026-10-19T17:00:00Z') })).state, 'failed');
  await probeOkta({ env: ENV, db, fetchImpl, poster: async t => said.push(t), clock: () => at('2026-10-19T18:00:00Z') });
  assert.equal(said.length, 1);
  assert.match(said[0], /^🚨 The Okta key doesn't work yet \(okta_http_401: Invalid token provided\)\. .*AA keeps getting the Okta asks/);
  assert.equal(await oktaReady({ env: ENV, db }), false);
});

async function readyDb(org) {
  const db = d1();
  await probeOkta({ env: ENV, db, fetchImpl: org.fetch, poster: null, clock: () => at('2026-10-19T17:00:00Z') });
  const okta = createOktaClient({ env: ENV, fetchImpl: org.fetch });
  await handleOktaGroups({ event: { authorId: PROJECT, messageTs: '1.1', text: 'okta groups: Contractors' }, env: ENV, db, masonId: PROJECT, okta, poster: () => async () => {} });
  return { db, okta };
}
const WHO = { pageId: 'p-rk', fullName: 'Rylan King ⭐', address: 'rylan@company.example', personalEmail: 'rylanking@example.test' };
const NAMES = { givenName: 'Rylan', familyName: 'King' };

test('Okta: one hire is created once, activated, in the picked groups; the same person again is "existing"; another person on the login is a mismatch', async () => {
  const org = fakeOrg(), { db, okta } = await readyDb(org);
  const r = await setUpOkta({ env: ENV, db, okta, who: WHO, names: NAMES });
  assert.equal(r.reason, 'created');
  const made = org.users.at(-1);
  assert.deepEqual(made.profile, { firstName: 'Rylan', lastName: 'King', login: 'rylan@company.example', email: 'rylan@company.example', secondEmail: 'rylanking@example.test' });
  assert.deepEqual(made.groupIds, ['00gCONTRACT0001']);
  assert.ok(org.calls.includes('POST /users?activate=true'));
  assert.equal((await setUpOkta({ env: ENV, db, okta, who: WHO, names: NAMES })).reason, 'existing');
  assert.equal(org.users.length, 1, 'never twice');
  const other = await setUpOkta({ env: ENV, db, okta, who: { ...WHO, fullName: 'Someone Else' }, names: { givenName: 'Someone', familyName: 'Else' } });
  assert.equal(other.reason, 'mismatch');
  assert.equal((await setUpOkta({ env: ENV, db, okta, who: { ...WHO, address: 'rk@example.test' }, names: NAMES })).code, 'no_company_address');
});

test('Okta: a refusal is told and can be retried; a 5xx on create is uncertain and never retried', async () => {
  const org = fakeOrg({ failCreate: { status: 400, summary: 'Api validation failed: login' } }), { db, okta } = await readyDb(org);
  const r = await setUpOkta({ env: ENV, db, okta, who: WHO, names: NAMES });
  assert.deepEqual([r.reason, r.code, r.why], ['refused', 'okta_http_400', 'Api validation failed: login']);
  const org2 = fakeOrg({ failCreate: { status: 502, summary: 'Bad gateway' } }), w2 = await readyDb(org2);
  assert.equal((await setUpOkta({ env: ENV, db: w2.db, okta: w2.okta, who: WHO, names: NAMES })).reason, 'uncertain');
  const again = await setUpOkta({ env: ENV, db: w2.db, okta: w2.okta, who: WHO, names: NAMES });
  assert.deepEqual([again.reason, again.code], ['uncertain', 'already_claimed']);
  assert.equal(org2.calls.filter(c => c.startsWith('POST /users')).length, 1);
});

// The onboarding step: with Okta ready, Uncle Sam sets it up himself and AA is never asked.
const ROUTES = Object.freeze({ jamie_group: { channelId: 'C0JAMIE001', type: 'mpim' }, aa_group: { channelId: 'C0AAGRP001', type: 'mpim' }, project: { channelId: 'D0MASON001', type: 'im' } });
const PAGE = '3f26ba36-8537-812b-9f29-c3980210a54b';
const person = (fields = {}) => ({ pageId: PAGE, fullName: 'Rylan King ⭐', email: 'rylanking@example.test', url: 'https://www.notion.so/x',
  fields: { Stage: 'Trial', Paperwork: 'Signed', 'Trial Start': '2026-10-21', 'Trial End': '2026-10-23', 'Next action': 'Trial Oct 21–23.', 'Candidate brief': '', ...fields } });
function slackWorld(candidate) {
  const w = { posts: [], notes: [], project: [], n: 0 };
  w.notion = { readControl: async () => ({ mode: 'Live' }), listTrialCandidates: async () => [candidate], getCandidate: async () => candidate,
    listCandidateNotes: async () => [], appendCandidateNote: async n => { w.notes.push(n); return { verified: true }; }, upsertOperationsRecord: async () => ({ verified: true }) };
  w.fetch = async (url, init) => {
    if (url === 'https://slack.com/api/users.list') return Response.json({ ok: true, members: [], response_metadata: { next_cursor: '' } });
    const body = JSON.parse(init.body), ts = `17921${String(++w.n).padStart(5, '0')}.000100`;
    w.posts.push({ ...body, ts });
    return Response.json({ ok: true, ts });
  };
  return w;
}

test('Onboarding with Okta ready: the address known, Uncle Sam creates the Okta account, notes it, tells Project; AA gets nothing', async () => {
  const org = fakeOrg(), { db, okta } = await readyDb(org), c = person(), w = slackWorld(c);
  const env = { ...ENV, UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled', SLACK_BOT_TOKEN: 'xoxb-fixture-only', UNCLE_SAM_EMAIL_OWNER: 'jamie' };
  const kv = (await import('../service/lib/stuck-rejections.mjs')).noticeStore(db);
  await kv.put(`onboarding:${PAGE}`, { jamie: { sentAt: at('2026-10-19T19:00:00Z') }, jamieDone: { via: 'reply', at: at('2026-10-19T20:00:00Z') }, address: 'rylan@company.example' }, at('2026-10-19T20:00:00Z'));
  const run = now => runOnboarding({ env, db, notion: w.notion, routeMap: ROUTES, fetchImpl: w.fetch, clock: () => now, claude: null, poster: async t => w.project.push(t), okta });
  await run(at('2026-10-19T20:05:00Z'));
  assert.equal(w.posts.filter(p => p.channel === 'C0AAGRP001').length, 0, 'AA is not asked');
  assert.equal(org.users.length, 1);
  assert.equal(w.project.at(-1), '🔐 Rylan King is in Okta.');
  assert.match(w.notes.at(-1).text, /Uncle Sam created the Okta account rylan@company\.example for the work trial starting 2026-10-21/);
  await run(at('2026-10-19T20:10:00Z'));
  assert.equal(org.users.length, 1);
  assert.equal(w.posts.filter(p => p.channel === 'C0AAGRP001').length, 0);
});

test('Onboarding with Okta refusing: Project is told and AA is asked as before', async () => {
  const org = fakeOrg({ failCreate: { status: 400, summary: 'Api validation failed' } }), { db, okta } = await readyDb(org), c = person(), w = slackWorld(c);
  const env = { ...ENV, UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled', SLACK_BOT_TOKEN: 'xoxb-fixture-only', UNCLE_SAM_EMAIL_OWNER: 'jamie' };
  const kv = (await import('../service/lib/stuck-rejections.mjs')).noticeStore(db);
  await kv.put(`onboarding:${PAGE}`, { jamie: { sentAt: at('2026-10-19T19:00:00Z') }, jamieDone: { via: 'reply', at: at('2026-10-19T20:00:00Z') }, address: 'rylan@company.example' }, at('2026-10-19T20:00:00Z'));
  await runOnboarding({ env, db, notion: w.notion, routeMap: ROUTES, fetchImpl: w.fetch, clock: () => at('2026-10-19T20:05:00Z'), claude: null, poster: async t => w.project.push(t), okta });
  assert.match(w.project[0], /^📋 Okta refused Rylan King's account \(okta_http_400: Api validation failed\)\. I'm asking AA instead\.$/);
  assert.equal(w.posts.filter(p => p.channel === 'C0AAGRP001').length, 1);
});

test('Project\'s "ask AA to set up X\'s Okta" with Okta ready: done directly', async () => {
  const org = fakeOrg(), { db, okta } = await readyDb(org), replies = [];
  const out = await handleOktaCommand({ event: { authorId: PROJECT, channelId: 'D0C95KBR09J', messageTs: '1792.1', text: 'ask AA to set up Rylan King\'s okta, rylan@company.example' },
    env: { ...ENV, SLACK_BOT_TOKEN: 'xoxb-fixture-only' }, db, notion: { appendCandidateNote: async () => null }, findCandidate: async () => ({ pageId: PAGE, fullName: 'Rylan King', trialStart: '2026-10-21' }),
    poster: () => async t => replies.push(t), masonId: PROJECT, routeMap: ROUTES, fetchImpl: async () => Response.json({ ok: true, members: [], response_metadata: { next_cursor: '' } }),
    clock: () => at('2026-10-19T20:00:00Z'), okta });
  assert.equal(out.reason, 'created');
  assert.equal(replies[0], 'Roger that 🫡');
});

test('a connected key is used once a day so it never expires; a revoked key is told once and AA takes over', async () => {
  const { probeOkta } = await import('../service/lib/okta.mjs');
  const { DatabaseSync } = await import('node:sqlite');
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const db = { prepare: sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) }) };
  const env = { OKTA_DOMAIN: 'example.okta.com', OKTA_API_TOKEN: '00abcdefghijklmnopqrstuvwxyz1234' };
  let status = 200, calls = 0; const said = [];
  const fetchImpl = async url => { calls++; if (status !== 200) return new Response(JSON.stringify({ errorSummary: 'Invalid token' }), { status });
    return new Response(JSON.stringify(/\/users\/me/.test(url) ? { profile: { login: 'project@company.example', firstName: 'Project', lastName: 'Owner' } } : []), { status: 200 }); };
  const T0 = Date.parse('2026-10-19T18:00:00Z');
  assert.equal((await probeOkta({ env, db, fetchImpl, poster: async t => said.push(t), clock: () => T0 })).state, 'ok');
  const c0 = calls;
  await probeOkta({ env, db, fetchImpl, poster: async t => said.push(t), clock: () => T0 + 3600_000 });
  assert.equal(calls, c0, 'not again within the day');
  await probeOkta({ env, db, fetchImpl, poster: async t => said.push(t), clock: () => T0 + 21 * 3600_000 });
  assert.equal(calls, c0 + 1, 'one call a day');
  status = 401;
  assert.equal((await probeOkta({ env, db, fetchImpl, poster: async t => said.push(t), clock: () => T0 + 42 * 3600_000 })).state, 'failed');
  assert.match(said.at(-1), /Okta key stopped working/);
});
