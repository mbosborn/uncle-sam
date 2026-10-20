import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runOffboarding, handleOffboardReply, accountOf } from '../service/lib/offboarding.mjs';
import { noticeStore } from '../service/lib/stuck-rejections.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const PROJECT = 'U0F9EF97D89', DM = 'D0C95KBR09J';
const at = s => Date.parse(s);
const person = (pageId, fullName, fields) => ({ pageId, fullName, email: `${pageId}@example.invalid`, fields: { Stage: 'Trial', Outcome: 'Proceeding', 'Trial End': '2026-10-19', ...fields } });
function world(people, users) {
  const said = [], suspended = [], deleted = [];
  let ts = 0;
  const notion = { readControl: async () => ({ mode: 'Live' }), listTrialsEnded: async () => people, appendCandidateNote: async () => null };
  const admin = {
    get: async a => users.find(u => u.primaryEmail === a) ?? null,
    findByName: async n => users.filter(u => u.name === n),
    suspend: async a => { suspended.push(a); users.find(u => u.primaryEmail === a).suspended = true; return { suspended: true }; },
    remove: async a => { deleted.push(a); return { deleted: true }; },
  };
  const poster = async t => { said.push(t); return `179220${String(++ts).padStart(4, '0')}.000100`; };
  return { notion, admin, poster, said, suspended, deleted };
}

test('No heads-up (Project, 2026-10-18): suspended at noon the day after the trial, quietly before; Slack is one tap for Project; once', async () => {
  const db = d1();
  await noticeStore(db).put('onboarding:p-arlen', { address: 'arlen@company.example' }, 0);
  const w = world([person('p-arlen', 'Arlen Archer')], [{ primaryEmail: 'arlen@company.example', name: 'Arlen Archer', suspended: false, isAdmin: false }]);
  const run = now => runOffboarding({ env: { UNCLE_SAM_OFFBOARD_DELETE: 'off' }, db, notion: w.notion, admin: w.admin, poster: w.poster, masonChannel: DM, clock: () => now, force: true });
  await run(at('2026-10-19T19:30:00Z'));
  assert.equal(w.said.length, 0, 'the day the trial ends: no message');
  assert.equal((await run(at('2026-10-20T16:00:00Z'))).suspended, 0, 'the next morning: not 24 hours yet');
  assert.equal((await run(at('2026-10-20T19:05:00Z'))).suspended, 1);
  assert.deepEqual(w.suspended, ['arlen@company.example']);
  assert.match(w.said[0], /^🫡 Suspended Arlen Archer's Company account\. Deactivate them in Slack/);
  await run(at('2026-10-20T20:00:00Z'));
  assert.equal(w.suspended.length, 1, 'once');
});

test('"keep Reagan\'s account" holds it; hired or offered, admins, staff and other people\'s accounts are never touched', async () => {
  const db = d1();
  const users = [{ primaryEmail: 'reagan@company.example', name: 'Reagan Turner', suspended: false, isAdmin: false }, { primaryEmail: 'avery@company.example', name: 'Avery James Carter', suspended: false, isAdmin: false },
    { primaryEmail: 'robin@company.example', name: 'Robin Cooper', suspended: false, isAdmin: true }];
  const reagan = person('p-reagan', 'Reagan Turner (Mercor)');
  const w = world([reagan, person('p-avery', 'Avery James Carter ⭐', { Stage: 'Extended Offer' })], users);
  const { handleRestoreAccount } = await import('../service/lib/restore-account.mjs');
  const out = await handleRestoreAccount({ event: { authorId: PROJECT, channelId: DM, messageTs: '1792200099.000100', text: "keep reagan's account, we might extend" }, db,
    notion: { findCandidatesByName: async () => [reagan] }, claude: { complete: async () => ({ content: [{ type: 'tool_use', name: 'who', input: { name: 'Reagan', address: '', restore: false, keep: true } }] }) },
    masonId: PROJECT, poster: () => async t => w.said.push(t), clock: () => at('2026-10-19T20:00:00Z') });
  assert.equal(out.reason, 'held');
  assert.equal(w.said[0], 'Roger that 🫡');
  await runOffboarding({ db, notion: w.notion, admin: w.admin, poster: w.poster, masonChannel: DM, clock: () => at('2026-10-20T20:00:00Z'), force: true });
  assert.deepEqual([w.suspended, w.deleted, w.said.length], [[], [], 1], 'held; Avery is at Extended Offer');
  // Someone else's address, an admin, or two people with the name: refused.
  assert.match((await accountOf({ db, admin: w.admin, candidate: { pageId: 'p-x', fullName: 'Robin Cooper' } })).why, /not a work-trial address|admin|no Google account/);
  const two = world([], [{ primaryEmail: 'a.k@company.example', name: 'Arlen Archer' }, { primaryEmail: 'arlen2@company.example', name: 'Arlen Archer' }]);
  assert.match((await accountOf({ db, admin: two.admin, candidate: { pageId: 'p-y', fullName: 'Arlen Archer' } })).why, /2 Google accounts carry the name/);
  await noticeStore(db).put('onboarding:p-z', { address: 'reagan@company.example' }, 0);
  assert.match((await accountOf({ db, admin: w.admin, candidate: { pageId: 'p-z', fullName: 'Aarlen Archer' } })).why, /belongs to Reagan Turner/);
});

test('Delete right away (Project, 2026-10-18): 24 hours after the trial the account is deleted, once, and remembered for "restore"', async () => {
  const db = d1();
  await noticeStore(db).put('onboarding:p-arlen', { address: 'arlen@company.example' }, 0);
  const w = world([person('p-arlen', 'Arlen Archer')], [{ primaryEmail: 'arlen@company.example', name: 'Arlen Archer', suspended: false, isAdmin: false }]);
  w.admin.remove = async a => { w.deleted.push(a); return { deleted: true, id: 'G9' }; };
  const run = now => runOffboarding({ db, notion: w.notion, admin: w.admin, poster: w.poster, masonChannel: DM, clock: () => now, force: true });
  await run(at('2026-10-19T19:30:00Z'));
  await run(at('2026-10-20T19:05:00Z'));
  assert.deepEqual([w.deleted, w.suspended], [['arlen@company.example'], []]);
  assert.match(w.said[0], /^🫡 Deleted Arlen Archer's Company account\. Deactivate them in Slack/);
  assert.equal((await noticeStore(db).get('deleted-account:arlen@company.example')).id, 'G9');
  await run(at('2026-10-20T20:00:00Z'));
  assert.equal(w.deleted.length, 1, 'once');
});

test('Google refusing admin access (Elliot, Oct 18): retried every run, not halted; Project hears once after 6 hours; works once access is back', async () => {
  const db = d1();
  const w = world([person('p-elliot', 'Elliot Woods', { 'Trial End': '2026-10-18' })], [{ primaryEmail: 'elliot@company.example', name: 'Elliot Woods', suspended: false, isAdmin: false }]);
  // What the old heads-up left behind.
  await noticeStore(db).put('offboard:p-elliot', { toldEnd: '2026-10-18', address: null, halted: "Google didn't answer (admin_search_http_403)" }, 0);
  let refuse = true;
  const findByName = w.admin.findByName;
  w.admin.findByName = async n => { if (refuse) throw Object.assign(new Error('x'), { code: 'admin_search_http_403' }); return findByName(n); };
  const run = now => runOffboarding({ db, notion: w.notion, admin: w.admin, poster: w.poster, masonChannel: DM, clock: () => now, force: true });
  await run(at('2026-10-19T19:05:00Z'));
  await run(at('2026-10-19T22:00:00Z'));
  assert.equal(w.said.length, 0, 'quiet while Uncle Sam keeps trying');
  await run(at('2026-10-20T01:10:00Z'));
  await run(at('2026-10-20T01:40:00Z'));
  assert.equal(w.said.length, 1);
  assert.match(w.said[0], /^🚨 I still can't delete Elliot Woods's Company account: Google refuses my admin access \(admin_search_http_403\)/);
  refuse = false;
  await run(at('2026-10-20T02:10:00Z'));
  assert.deepEqual(w.deleted, ['elliot@company.example']);
});
