import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { queuePacket, runEmailQueue, handleCancelCommand, HOLD_MS } from '../service/lib/email-queue.mjs';
import { noticeStore } from '../service/lib/stuck-rejections.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const NOW = Date.parse('2026-10-20T18:00:00Z');
const PROJECT = 'U0F9EF97D89';
const who = { pageId: '3f26ba36-8537-8000-8000-0000000000a1', fullName: 'Priya Shah', email: 'priya@example.com', trialStart: '2026-10-24', trialEnd: '2026-10-25' };
const candidate = (fields = {}) => ({ ...who, fields: { Stage: 'Trial', Outcome: 'Proceeding', ...fields } });

test('Email queue (Project, 2026-10-20): the documents wait 30 minutes, go once and quietly; a re-read record or a pay concern stops them', async () => {
  const db = d1(), sends = [], said = [];
  const packets = { sendNow: async a => { sends.push(a); return { reason: 'sent', text: 'sent' }; } };
  const notion = { getCandidate: async () => candidate() };
  assert.equal((await queuePacket({ db, who, rate: 100, clock: () => NOW })).reason, 'queued');
  assert.equal((await queuePacket({ db, who, rate: 100, clock: () => NOW })).reason, 'already_queued');
  await runEmailQueue({ db, notion, packets, poster: async t => said.push(t), clock: () => NOW + HOLD_MS - 60_000 });
  assert.equal(sends.length, 0, 'not before 30 minutes');
  await runEmailQueue({ db, notion, packets, poster: async t => said.push(t), clock: () => NOW + HOLD_MS });
  await runEmailQueue({ db, notion, packets, poster: async t => said.push(t), clock: () => NOW + HOLD_MS + 600_000 });
  assert.equal(sends.length, 1); assert.equal(sends[0].rate, 100); assert.equal(sends[0].who.trialStart, '2026-10-24');
  assert.deepEqual(said, [], 'nothing said when it goes');
  // On Hold by the time it's due: not sent, Project told.
  const db2 = d1(), sends2 = [], said2 = [];
  await queuePacket({ db: db2, who, rate: 100, clock: () => NOW });
  await runEmailQueue({ db: db2, notion: { getCandidate: async () => candidate({ Outcome: 'On Hold' }) }, packets: { sendNow: async a => { sends2.push(a); return { reason: 'sent' }; } }, poster: async t => said2.push(t), clock: () => NOW + HOLD_MS });
  assert.equal(sends2.length, 0); assert.match(said2[0], /On Hold/);
});

test('"cancel Priya" (or a bare "cancel" with one waiting) stops whatever is waiting for her; nothing waiting -> not this command', async () => {
  const db = d1(), said = [], sends = [];
  const poster = () => async t => said.push(t);
  const find = async name => (/priya/i.test(name) ? { pageId: who.pageId, fullName: who.fullName } : null);
  const ev = text => ({ authorId: PROJECT, text, channelId: 'D1', messageTs: '1.1' });
  assert.equal(await handleCancelCommand({ event: ev('cancel priya'), db, findCandidate: find, poster, masonId: PROJECT, clock: () => NOW }), null, 'nothing waiting');
  await queuePacket({ db, who, rate: 100, clock: () => NOW });
  await noticeStore(db).put(`payout:queued:${who.pageId}`, { pageId: who.pageId, name: who.fullName, at: NOW + HOLD_MS }, NOW);
  assert.equal(await handleCancelCommand({ event: ev('stop'), db, findCandidate: find, poster, masonId: PROJECT, clock: () => NOW }), null, 'a bare stop is not this');
  const out = await handleCancelCommand({ event: ev('cancel Priya'), db, findCandidate: find, poster, masonId: PROJECT, clock: () => NOW });
  assert.equal(out.kind, 'email_cancel');
  assert.match(said[0], /^🛑 Cancelled\. Priya's work trial documents and payout setup email won't go out\./);
  await runEmailQueue({ db, notion: { getCandidate: async () => candidate() }, packets: { sendNow: async a => { sends.push(a); return { reason: 'sent' }; } }, clock: () => NOW + HOLD_MS });
  assert.equal(sends.length, 0);
});

test('a document validation block stays held, is never marked done and never repeats on later ticks', async () => {
  const db = d1(), kv = noticeStore(db), said = []; let sends = 0;
  await queuePacket({ db, who, rate: 100, clock: () => NOW });
  const packets = { sendNow: async () => { sends++; return { reason: 'validation_blocked', envelopeId: 'blocked-envelope', text: 'Blocked: wrong name in NDA.' }; } };
  const inputs = { db, notion: { getCandidate: async () => candidate() }, packets, poster: async text => said.push(text) };
  const first = await runEmailQueue({ ...inputs, clock: () => NOW + HOLD_MS });
  assert.equal(first.sent, 0);
  const held = await kv.get(`emailq:packet:${who.pageId}`);
  assert.equal(held.validationBlocked, NOW + HOLD_MS); assert.equal(held.envelopeId, 'blocked-envelope');
  assert.equal(held.result, 'validation_blocked'); assert.equal(held.done, undefined);
  await runEmailQueue({ ...inputs, clock: () => NOW + 3 * 3600_000 });
  assert.equal(sends, 1); assert.deepEqual(said, ['Blocked: wrong name in NDA.']);
});

test('uncertain document delivery stays pending reconciliation without claiming completion or retrying', async () => {
  const db = d1(), kv = noticeStore(db), said = []; let sends = 0;
  await queuePacket({ db, who, rate: 100, clock: () => NOW });
  const packets = { sendNow: async () => { sends++; return { reason: 'uncertain', envelopeId: 'uncertain-envelope', text: 'Delivery not confirmed; review existing envelope.' }; } };
  const inputs = { db, notion: { getCandidate: async () => candidate() }, packets, poster: async text => said.push(text) };
  assert.equal((await runEmailQueue({ ...inputs, clock: () => NOW + HOLD_MS })).sent, 0);
  const held = await kv.get(`emailq:packet:${who.pageId}`);
  assert.equal(held.deliveryUncertain, NOW + HOLD_MS); assert.equal(held.envelopeId, 'uncertain-envelope');
  assert.equal(held.result, 'uncertain'); assert.equal(held.done, undefined);
  await runEmailQueue({ ...inputs, clock: () => NOW + 2 * 86400_000 });
  assert.equal(sends, 1); assert.equal(said.length, 1);
});

test('a validation exception from fresh candidate lookup is held rather than marked delivered', async () => {
  const db = d1(), kv = noticeStore(db); let attempts = 0;
  await queuePacket({ db, who, rate: 100, clock: () => NOW });
  const packets = { sendNow: async () => { attempts++; throw Object.assign(new Error('blocked'), { code: 'docusign_document_validation_failed', detail: 'candidate_record_unavailable' }); } };
  await runEmailQueue({ db, notion: { getCandidate: async () => candidate() }, packets, clock: () => NOW + HOLD_MS });
  const held = await kv.get(`emailq:packet:${who.pageId}`);
  assert.equal(held.result, 'validation_blocked'); assert.equal(held.done, undefined);
  await runEmailQueue({ db, notion: { getCandidate: async () => candidate() }, packets, clock: () => NOW + HOLD_MS + 3600_000 });
  assert.equal(attempts, 1);
});
