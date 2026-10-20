import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { queuePacket, runEmailQueue, holdReason, tellHold, cancelWaiting, waitingFor, HOLD_MS } from '../service/lib/email-queue.mjs';
import { noticeStore } from '../service/lib/stuck-rejections.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const NOW = Date.parse('2026-10-20T18:00:00Z');
const who = { pageId: '3f26ba36-8537-8000-8000-0000000000a1', fullName: 'Priya Shah', email: 'priya@example.com', trialStart: '2026-10-24', trialEnd: '2026-10-25' };
const candidate = (fields = {}) => ({ ...who, fields: { Stage: 'Trial', Outcome: 'Proceeding', 'Trial Start': '2026-10-24', 'Trial End': '2026-10-25', ...fields } });

test('holdReason: closed, Stage closed, On Hold, a pay concern, gone, or nothing; Project told once per reason', async () => {
  const kv = noticeStore(d1());
  assert.equal(await holdReason({ kv, candidate: null }), 'gone');
  assert.equal(await holdReason({ kv, candidate: { ...candidate(), archived: true } }), 'gone');
  assert.equal(await holdReason({ kv, candidate: candidate({ Outcome: 'Withdrawn or Unavailable' }) }), 'closed');
  assert.equal(await holdReason({ kv, candidate: candidate({ Stage: 'Hired' }) }), 'stage_closed');
  assert.equal(await holdReason({ kv, candidate: candidate({ Outcome: 'On Hold' }) }), 'on_hold');
  await kv.put(`trialterms:hold:${who.pageId}`, { at: NOW }, NOW);
  assert.equal(await holdReason({ kv, candidate: candidate() }), 'pay_concern');
  await kv.del(`trialterms:hold:${who.pageId}`);
  assert.equal(await holdReason({ kv, candidate: candidate() }), null);
  const said = [];
  for (let i = 0; i < 2; i++) await tellHold({ kv, poster: async t => said.push(t), pageId: who.pageId, name: who.fullName, what: 'payout setup email', why: 'on_hold', now: NOW });
  await tellHold({ kv, poster: async t => said.push(t), pageId: who.pageId, name: who.fullName, what: 'payout setup email', why: 'gone', now: NOW });
  assert.deepEqual(said, ["📋 I didn't send Priya's payout setup email: they are On Hold."]);
});

test('queuePacket: cancelled by Project stays cancelled unless forced', async () => {
  const db = d1();
  await queuePacket({ db, who, rate: 100, clock: () => NOW });
  await cancelWaiting({ db, pageId: who.pageId, clock: () => NOW + 1000 });
  assert.equal((await queuePacket({ db, who, rate: 100, clock: () => NOW + 2000 })).reason, 'cancelled');
  assert.equal((await queuePacket({ db, who, rate: 100, clock: () => NOW + 3000, force: true })).reason, 'queued');
  assert.equal((await waitingFor({ db, pageId: who.pageId })).length, 1);
});

test('runEmailQueue: the record\'s current trial dates are used; Notion down is tried again, not dropped', async () => {
  const db = d1(), sends = [];
  const packets = { sendNow: async a => { sends.push(a); return { reason: 'sent' }; } };
  await queuePacket({ db, who, rate: 100, clock: () => NOW });
  let down = true;
  const notion = { getCandidate: async () => { if (down) throw Object.assign(new Error('x'), { code: 'notion_http_503' }); return candidate({ 'Trial Start': '2026-10-26', 'Trial End': '2026-10-28T00:00:00.000Z' }); } };
  await runEmailQueue({ db, notion, packets, clock: () => NOW + HOLD_MS });
  assert.equal(sends.length, 0);
  assert.equal((await waitingFor({ db, pageId: who.pageId })).length, 1, 'still waiting');
  down = false;
  await runEmailQueue({ db, notion, packets, clock: () => NOW + HOLD_MS + 300_000 });
  assert.equal(sends.length, 1);
  assert.deepEqual([sends[0].who.trialStart, sends[0].who.trialEnd], ['2026-10-26', '2026-10-28']);
  // A page that no longer exists is dropped quietly.
  const db2 = d1(), said = [];
  await queuePacket({ db: db2, who, rate: 100, clock: () => NOW });
  await runEmailQueue({ db: db2, notion: { getCandidate: async () => { throw Object.assign(new Error('x'), { code: 'notion_http_404' }); } }, packets, poster: async t => said.push(t), clock: () => NOW + HOLD_MS });
  assert.equal((await waitingFor({ db: db2, pageId: who.pageId })).length, 0);
  assert.deepEqual(said, []);
});
