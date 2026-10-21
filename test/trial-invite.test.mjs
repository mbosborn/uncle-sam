import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { nextGoodTime, fillInvite, queueTrialInvite, runTrialInvites } from '../service/lib/trial-invite.mjs';
import { parseTemplate } from '../service/lib/takehome-review.mjs';
import { noticeStore } from '../service/lib/stuck-rejections.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const TEMPLATE = "Subject: Your Company AI work trial\n\nHi {{first_name}},\n\nCongratulations, we'd like to move you forward with a work trial. Please confirm the dates you're available. Ideally 3 days, but 2 days is also fine. We can accommodate weekends and adapt to your time zone.\n\nOur standard trial rate is {{daily_rate}} per day.\n\nOnce we've confirmed your dates, I'll send over the work trial documents to sign.\n\nLooking forward to hearing from you.";
const SANA = { pageId: 'p-sana', fullName: 'Sana Iyer', email: 'sana@example.com', fields: { Stage: 'Trial', Pipeline: 'India', 'India Stage': 'Pre Work Trial' } };

test('the invite goes at a good hour in their time zone: 9 AM – 6 PM on a weekday', () => {
  const at = nextGoodTime(Date.parse('2026-10-19T07:00:00Z'), 'Asia/Kolkata'); // Mon 12:30 PM IST: now
  assert.equal(at, Date.parse('2026-10-19T07:00:00Z'));
  const late = nextGoodTime(Date.parse('2026-10-19T15:00:00Z'), 'Asia/Kolkata'); // Mon 8:30 PM IST -> Tue 9:00 AM IST
  assert.equal(new Date(late).toISOString(), '2026-10-20T03:30:00.000Z');
  const sat = nextGoodTime(Date.parse('2026-10-24T18:00:00Z'), 'America/Los_Angeles'); // Sat 11 AM PT -> Mon 9 AM PT
  assert.equal(new Date(sat).toISOString(), '2026-10-26T16:00:00.000Z');
});

test('Project\'s Send with no dates: queued for their morning, sent once with the standard rate, not if dates are on the record by then', async () => {
  const db = d1(), sent = [];
  const notion = { getCandidate: async () => SANA, getEmailTemplate: async () => TEMPLATE, appendCandidateNote: async () => null };
  const q = await queueTrialInvite({ db, candidate: SANA, rate: 100, clock: () => Date.parse('2026-10-19T15:00:00Z') });
  assert.equal(q.tz, 'Asia/Kolkata');
  const gmail = { send: async x => { sent.push(x); return { id: 'm1' }; } };
  await runTrialInvites({ db, notion, gmail, parseTemplate, clock: () => Date.parse('2026-10-19T16:00:00Z') });
  assert.equal(sent.length, 0, 'not at night their time');
  await runTrialInvites({ db, notion, gmail, parseTemplate, clock: () => Date.parse('2026-10-20T03:31:00Z') });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'sana@example.com');
  assert.match(sent[0].body, /^Hi Sana,\n\nCongratulations, we'd like to move you forward with a work trial\./);
  assert.match(sent[0].body, /Our standard trial rate is US\$100 per day\./);
  await runTrialInvites({ db, notion, gmail, parseTemplate, clock: () => Date.parse('2026-10-20T04:00:00Z') });
  assert.equal(sent.length, 1, 'once');
  const db2 = d1(), sent2 = [];
  await queueTrialInvite({ db: db2, candidate: SANA, rate: 100, clock: () => Date.parse('2026-10-20T03:31:00Z') });
  await runTrialInvites({ db: db2, notion: { ...notion, getCandidate: async () => ({ ...SANA, fields: { ...SANA.fields, 'Trial Start': '2026-10-24', 'Trial End': '2026-10-26' } }) },
    gmail: { send: async x => sent2.push(x) }, parseTemplate, clock: () => Date.parse('2026-10-20T03:32:00Z') });
  assert.equal(sent2.length, 0, 'dates arrived: the packet path takes over');
  assert.equal(fillInvite(parseTemplate(TEMPLATE), { firstName: 'Sana', rate: null }), null);
});

const T0 = Date.parse('2026-10-20T03:31:00Z'); // Tue 9:01 AM IST
const due = () => T0 + 3600_000;
const setup = async ({ candidate = SANA, gmailExtra = {}, seed = null } = {}) => {
  const db = d1(), sent = [], said = [];
  if (seed) await seed(noticeStore(db));
  const notion = { getCandidate: async () => candidate, getEmailTemplate: async () => TEMPLATE, appendCandidateNote: async () => null };
  const gmail = { send: async x => { sent.push(x); return { id: 'abc123', threadId: 'abc123', url: 'https://mail/x' }; }, ...gmailExtra };
  await queueTrialInvite({ db, candidate: SANA, rate: 100, clock: () => T0 });
  const run = () => runTrialInvites({ db, notion, gmail, parseTemplate, poster: async t => said.push(t), clock: due });
  return { db, sent, said, run, kv: noticeStore(db) };
};

test('queued once: a waiting or sent invite is never queued again; a dropped one only with force (a person\'s word)', async () => {
  const db = d1(), kv = noticeStore(db);
  assert.equal((await queueTrialInvite({ db, candidate: SANA, rate: 100, clock: () => T0 })).reason, 'queued');
  assert.equal((await queueTrialInvite({ db, candidate: SANA, rate: 120, clock: () => T0 + 1 })).reason, 'already_queued');
  assert.equal((await kv.get('trialinvite:p-sana')).rate, 100);
  await kv.put('trialinvite:p-sana', { ...(await kv.get('trialinvite:p-sana')), sentAt: T0, messageId: 'abc123' }, T0);
  assert.equal((await queueTrialInvite({ db, candidate: SANA, rate: 120, clock: () => T0 + 2, force: true })).reason, 'already_sent');
  assert.equal((await kv.get('trialinvite:p-sana')).messageId, 'abc123', 'the sent record (its thread) is kept');
  await kv.put('trialinvite:p-sana', { pageId: 'p-sana', dropped: 'cancelled_by_mason' }, T0);
  assert.deepEqual(await queueTrialInvite({ db, candidate: SANA, rate: 120, clock: () => T0 + 3 }), { reason: 'dropped', dropped: 'cancelled_by_mason' });
  assert.equal((await queueTrialInvite({ db, candidate: SANA, rate: 120, clock: () => T0 + 4, force: true })).reason, 'queued');
  assert.equal((await kv.get('trialinvite:p-sana')).rate, 120);
});

test('sent: the subject and thread are kept for the documents email to reply in', async () => {
  const w = await setup();
  await w.run();
  assert.equal(w.sent.length, 1);
  const item = await w.kv.get('trialinvite:p-sana');
  assert.deepEqual([item.messageId, item.threadId, item.subject], ['abc123', 'abc123', 'Your Company AI work trial']);
});

test('an invite Project sent himself: found in his Sent mail, nothing sent, one line; search not granted goes on; another search error sends nothing and says so', async () => {
  const queries = [];
  const hand = await setup({ gmailExtra: { searchSent: async q => { queries.push(q); return [{ id: 'f00d01', threadId: 'f00d01', subject: 'Work trial at Company', url: 'https://mail/h' }]; } } });
  await hand.run();
  assert.equal(hand.sent.length, 0);
  assert.equal(queries[0], 'to:sana@example.com "work trial" -subject:payment newer_than:60d');
  const item = await hand.kv.get('trialinvite:p-sana');
  assert.equal(item.dropped, 'sent_by_hand'); assert.deepEqual(item.handSent, { messageId: 'f00d01', threadId: 'f00d01', subject: 'Work trial at Company', url: 'https://mail/h' });
  assert.deepEqual(hand.said, ['📋 You already emailed Sana about the work trial (<https://mail/h|email>), so I didn\'t send the invite.']);
  const notGranted = await setup({ gmailExtra: { searchSent: async () => { throw Object.assign(new Error('x'), { code: 'gmail_search_not_granted' }); } } });
  await notGranted.run();
  assert.equal(notGranted.sent.length, 1);
  const broken = await setup({ gmailExtra: { searchSent: async () => { throw Object.assign(new Error('x'), { code: 'gmail_search_http_500' }); } } });
  await broken.run();
  assert.equal(broken.sent.length, 0);
  assert.equal((await broken.kv.get('trialinvite:p-sana')).dropped, undefined);
  assert.equal((await broken.kv.get('trialinvite:p-sana')).lastError, 'gmail_search_http_500');
  await broken.run();
  assert.equal(broken.said.length, 0, 'temporary read failures retry quietly');
});

test('re-read before it goes: a pay concern, On Hold, closed or paperwork out -> not sent, and Project hears why (not for paperwork out)', async () => {
  const held = await setup({ seed: kv => kv.put('trialterms:hold:p-sana', { at: T0 }, T0) });
  await held.run();
  assert.deepEqual([held.sent.length, (await held.kv.get('trialinvite:p-sana')).dropped], [0, 'pay_concern']);
  assert.deepEqual(held.said, ["📋 I didn't send Sana's work trial invite: they pushed back on the pay and haven't had an answer."]);
  const onHold = await setup({ candidate: { ...SANA, fields: { ...SANA.fields, Outcome: 'On Hold' } } });
  await onHold.run();
  assert.deepEqual(onHold.said, ["📋 I didn't send Sana's work trial invite: they are On Hold."]);
  const closed = await setup({ candidate: { ...SANA, fields: { ...SANA.fields, Outcome: 'Withdrawn or Unavailable' } } });
  await closed.run();
  assert.deepEqual(closed.said, ["📋 I didn't send Sana's work trial invite: they are closed on the tracker."]);
  const out = await setup({ candidate: { ...SANA, fields: { ...SANA.fields, Paperwork: 'Sent' } } });
  await out.run();
  assert.deepEqual([out.sent.length, out.said.length, (await out.kv.get('trialinvite:p-sana')).dropped], [0, 0, 'already_out']);
});

test('a send that certainly failed frees the claim so a later push can send; an uncertain one never sends twice', async () => {
  const fail = async uncertain => {
    const w = await setup({ gmailExtra: { send: async () => { throw Object.assign(new Error('x'), { code: 'gmail_send_http_500', uncertain }); } } });
    await w.run();
    return w;
  };
  const sure = await fail(false);
  assert.equal(await sure.kv.get('trialinvite:sent:p-sana'), null);
  const maybe = await fail(true);
  assert.ok(await maybe.kv.get('trialinvite:sent:p-sana'));
  // A fresh instruction cannot overwrite unresolved delivery evidence.
  await queueTrialInvite({ db: maybe.db, candidate: SANA, rate: 100, clock: () => T0, force: true });
  await runTrialInvites({ db: maybe.db, notion: { getCandidate: async () => SANA, getEmailTemplate: async () => TEMPLATE }, gmail: { send: async () => { throw new Error('must not send'); } }, parseTemplate, clock: due });
  assert.equal((await maybe.kv.get('trialinvite:p-sana')).deliveryUncertain, true);
  assert.equal((await maybe.kv.get('trialinvite:p-sana')).dropped, 'send_failed:gmail_send_http_500');
});

test('temporary candidate, template and Sent-mail outages retry without dropping the invitation', async () => {
  for (const phase of ['candidate', 'template', 'sent']) {
    const db = d1(), kv = noticeStore(db), sent = []; let down = true;
    const read = () => { if (down) throw Object.assign(Error('outage'), { code: 'provider_http_503' }); };
    const notion = { getCandidate: async () => { if (phase === 'candidate') read(); return SANA; },
      getEmailTemplate: async () => { if (phase === 'template') read(); return TEMPLATE; }, appendCandidateNote: async () => {} };
    const gmail = { searchSent: async () => { if (phase === 'sent') read(); return []; }, send: async p => { sent.push(p); return { id: 'abc123' }; } };
    await queueTrialInvite({ db, candidate: SANA, rate: 100, clock: () => T0 });
    const run = at => runTrialInvites({ db, notion, gmail, parseTemplate, clock: () => at });
    await run(due());
    const pending = await kv.get('trialinvite:p-sana'); assert.equal(pending.dropped, undefined); assert.equal(sent.length, 0);
    down = false; await run(pending.at); await run(pending.at + 300000);
    assert.equal(sent.length, 1, phase);
  }
});

test('definitely refused temporary sends retry; ambiguous delivery stays held', async () => {
  const db = d1(), kv = noticeStore(db); let attempts = 0;
  await queueTrialInvite({ db, candidate: SANA, rate: 100, clock: () => T0 });
  const run = at => runTrialInvites({ db, notion: { getCandidate: async () => SANA, getEmailTemplate: async () => TEMPLATE },
    gmail: { send: async () => { attempts++; if (attempts === 1) throw Object.assign(Error('limited'), { code: 'gmail_send_http_429', uncertain: false }); return { id: 'abc123' }; } }, parseTemplate, clock: () => at });
  await run(due()); const pending = await kv.get('trialinvite:p-sana');
  assert.equal(pending.dropped, undefined); assert.equal(await kv.get('trialinvite:sent:p-sana'), null);
  await run(pending.at); await run(pending.at + 300000); assert.equal(attempts, 2);
});
