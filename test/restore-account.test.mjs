import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleRestoreAccount, RESTORE_ASK } from '../service/lib/restore-account.mjs';
import { noticeStore } from '../service/lib/stuck-rejections.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const PROJECT = 'U0F9EF97D89', NOW = Date.parse('2026-10-26T18:00:00Z');
const KENDALL = { pageId: '44444444-4444-4444-4444-444444444444', fullName: 'Kendall Porter', fields: { Stage: 'Closed' }, profile: {} };
const ev = (text, ts = '9.1') => ({ authorId: PROJECT, channelId: 'D1', messageTs: ts, text });
const claudeFor = (name, address = '') => ({ complete: async () => ({ content: [{ type: 'tool_use', name: 'who', input: { name, address, restore: true } }] }) });
const notion = { findCandidatesByName: async n => (/kendall/i.test(n) ? [KENDALL] : []), appendCandidateNote: async () => {}, getCandidate: async () => KENDALL };

function fakeAdmin({ live = {}, deleted = [] } = {}) {
  const calls = [];
  const users = { ...live };
  return { calls, users,
    get: async a => (users[a] ? { primaryEmail: a, name: users[a].name, suspended: users[a].suspended, isAdmin: false } : null),
    findByName: async () => Object.entries(users).map(([a, u]) => ({ primaryEmail: a, name: u.name, suspended: u.suspended, isAdmin: false })),
    listDeleted: async () => deleted,
    unsuspend: async a => { calls.push(['unsuspend', a]); users[a].suspended = false; },
    undelete: async id => { calls.push(['undelete', id]); const d = deleted.find(x => x.id === id); users[d.primaryEmail] = { name: d.name, suspended: true }; } };
}

test('"restore Kendall\'s account" after the post-trial delete: restored by the id Uncle Sam saved, turned on, Slack is a link; once per message', async () => {
  const db = d1(), said = [];
  await noticeStore(db).put('deleted-account:kendall@company.example', { id: 'G2', pageId: KENDALL.pageId, name: 'Kendall Porter', at: NOW - 86400_000 }, NOW);
  const admin = fakeAdmin({ deleted: [{ id: 'G1', primaryEmail: 'kendall@company.example', name: 'Kendall Porter', deletedAt: 1 }, { id: 'G2', primaryEmail: 'kendall@company.example', name: 'Kendall Porter', deletedAt: 2 }] });
  const out = await handleRestoreAccount({ event: ev("restore kendall's account"), db, notion, claude: claudeFor('Kendall'), admin, masonId: PROJECT, poster: () => async t => said.push(t), clock: () => NOW });
  assert.equal(out.reason, 'done');
  assert.deepEqual(admin.calls, [['undelete', 'G2'], ['unsuspend', 'kendall@company.example']]);
  assert.equal(said[0], 'Roger that 🫡 Reactivate Kendall Porter in Slack: <https://example-workspace.slack.com/admin|Manage members>.');
  assert.equal((await noticeStore(db).get(`offboard:${KENDALL.pageId}`)).held.by, 'Project (restore)');
  const again = await handleRestoreAccount({ event: ev("restore kendall's account"), db, notion, claude: claudeFor('Kendall'), admin, masonId: PROJECT, poster: () => async t => said.push(t), clock: () => NOW });
  assert.equal(again.reason, 'duplicate');
  assert.equal(admin.calls.length, 2);
});

test('A suspended account by address is turned back on; an active one is left alone; past the window says so', async () => {
  const said = [];
  const poster = () => async t => said.push(t);
  const admin = fakeAdmin({ live: { 'avery@company.example': { name: 'Avery Carter', suspended: true }, 'elliot@company.example': { name: 'Elliot Shah', suspended: false } } });
  assert.equal((await handleRestoreAccount({ event: ev('reactivate avery@company.example', '1'), db: d1(), notion, claude: claudeFor('', ''), admin, masonId: PROJECT, poster, clock: () => NOW })).reason, 'done');
  assert.deepEqual(admin.calls, [['unsuspend', 'avery@company.example']]);
  assert.match(said[0], /^Roger that 🫡 Reactivate/);
  assert.equal((await handleRestoreAccount({ event: ev('restore elliot@company.example', '2'), db: d1(), notion, claude: claudeFor(''), admin, masonId: PROJECT, poster, clock: () => NOW })).reason, 'already_active');
  assert.equal((await handleRestoreAccount({ event: ev('restore old@company.example', '3'), db: d1(), notion, claude: claudeFor(''), admin, masonId: PROJECT, poster, clock: () => NOW })).reason, 'too_late');
  assert.match(said.at(-1), /past Google's ~20-day restore window/);
});

test('Not Project, not a restore ask, no name: no guessing; two matching accounts get the which-one question', async () => {
  const said = [], poster = () => async t => said.push(t);
  assert.equal(await handleRestoreAccount({ event: { ...ev('restore kendall'), authorId: 'U0X' }, db: d1(), notion, claude: claudeFor('Kendall'), admin: fakeAdmin(), masonId: PROJECT, poster }), null);
  assert.equal(RESTORE_ASK.test('what time is the sync'), false);
  assert.equal(RESTORE_ASK.test('can you bring him back'), true);
  assert.equal((await handleRestoreAccount({ event: ev('restore it'), db: d1(), notion, claude: claudeFor(''), admin: fakeAdmin(), masonId: PROJECT, poster })).reason, 'no_name');
  const admin = fakeAdmin({ deleted: [{ id: 'A', primaryEmail: 'sam@company.example', name: 'Sam Lee', deletedAt: 1 }, { id: 'B', primaryEmail: 'sam.lee@company.example', name: 'Sam Lee', deletedAt: 2 }] });
  assert.equal((await handleRestoreAccount({ event: ev('restore sam lee'), db: d1(), notion, claude: claudeFor('Sam Lee'), admin, masonId: PROJECT, poster })).reason, 'which_address');
  assert.match(said.at(-1), /Which one: sam@company\.example, sam\.lee@company\.example\?/);
  assert.equal(admin.calls.length, 0);
});
