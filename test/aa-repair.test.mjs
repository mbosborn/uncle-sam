import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { repairAaMessages } from '../service/lib/project-commands.mjs';
import { noticeStore } from '../service/lib/stuck-rejections.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const TEXT = "🔐 AA: Rowan Blake reports for a work trial tomorrow (Mon Oct 19). Their Company email is rowand@company.example. Set up Okta. Reply here when it's done.";

test('AA\'s wrong request (Oct 18, "in Slack as @Claude") is edited in place, once', async () => {
  const db = d1(), edits = [];
  await noticeStore(db).put('onboarding:p-ad', { address: 'rowand@company.example', aa: { ts: '1792391918.000100', channelId: 'D0AA', sentAt: 1, repairText: TEXT } }, 1);
  const run = () => repairAaMessages({ db, clock: () => 2, update: async x => edits.push(x), remove: async () => { throw new Error('no'); }, post: async () => { throw new Error('no'); } });
  assert.equal((await run()).repaired, 1);
  assert.deepEqual(edits, [{ channel: 'D0AA', ts: '1792391918.000100', text: TEXT }]);
  assert.equal((await run()).repaired, 0, 'once');
  const state = await noticeStore(db).get('onboarding:p-ad');
  assert.equal(state.aa.repairText, undefined);
  assert.equal(state.aa.repairedHow, 'edited');
});

test('the edit refused: the old one is deleted and the corrected one posted as if nothing happened; the thread follows', async () => {
  const db = d1(), removed = [], posted = [];
  await noticeStore(db).put('onboarding:p-ad', { aa: { ts: '1.1', channelId: 'D0AA', repairText: TEXT } }, 1);
  await repairAaMessages({ db, clock: () => 2, update: async () => { throw Object.assign(new Error('x'), { code: 'slack_cant_update_message' }); },
    remove: async x => removed.push(x), post: async x => { posted.push(x); return '2.2'; } });
  assert.deepEqual([removed[0].ts, posted[0].text], ['1.1', TEXT]);
  assert.equal((await noticeStore(db).get('onboarding:p-ad')).aa.ts, '2.2');
  assert.equal((await noticeStore(db).get('onboarding:thread:D0AA:2.2')).who, 'aa');
});
