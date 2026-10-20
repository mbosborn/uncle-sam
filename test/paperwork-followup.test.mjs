import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { reminderAt, unsignedWarnings, countersignWarnings, trialStartMs, runPaperworkFollowUps, followUpPromise } from '../service/lib/paperwork-followup.mjs';

const H = 3600_000;
const ENV_ID = '99999999-9999-9999-9999-999999999999';
function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const put = (db, name, value) => db.prepare('INSERT INTO uncle_sam_notices (name, value, updated_at) VALUES (?, ?, 0)').bind(name, JSON.stringify(value)).run();
const get = async (db, name) => JSON.parse((await db.prepare('SELECT value FROM uncle_sam_notices WHERE name = ?').bind(name).first())?.value ?? 'null');

test('the reminder: 48 hours, pulled in to 24 hours before the start, never before 4 hours', () => {
  const start = trialStartMs('2026-10-26'); // Mon 9 am PT
  assert.equal(new Date(start).toISOString(), '2026-10-26T16:00:00.000Z');
  assert.equal(reminderAt({ sentAt: start - 7 * 24 * H, start }), start - 5 * 24 * H, 'a week ahead: +48h');
  assert.equal(reminderAt({ sentAt: start - 36 * H, start }), start - 24 * H, 'Project: sent 36h ahead -> 24h before');
  assert.equal(reminderAt({ sentAt: start - 10 * H, start }), start - 6 * H, 'sent 10h ahead -> +4h');
  assert.equal(reminderAt({ sentAt: start + 2 * H, start }), start + 6 * H, 'sent after the start -> +4h');
  assert.equal(reminderAt({ sentAt: 0 }), 48 * H, 'no start date -> +48h');
});

test("Project's notices: the 24-hour warning, the trial day, and 4 days for a far-off or missing start", () => {
  const start = trialStartMs('2026-10-26');
  assert.deepEqual(unsignedWarnings({ sentAt: start - 36 * H, start }).map(w => [w.key, (w.at - start) / H]), [['day_before', -24], ['trial_day', 0]]);
  assert.deepEqual(unsignedWarnings({ sentAt: start - 10 * 24 * H, start }).map(w => [w.key, (w.at - start) / H]), [['stale', -144], ['day_before', -24], ['trial_day', 0]]);
  assert.deepEqual(unsignedWarnings({ sentAt: start - 10 * H, start }).map(w => [w.key, (w.at - start) / H]), [['day_before', -6], ['trial_day', 0]]);
  assert.deepEqual(unsignedWarnings({ sentAt: start - 6 * H, start }).map(w => w.key), ['day_before'], 'too close for a separate trial-day notice');
  assert.deepEqual(unsignedWarnings({ sentAt: 0 }).map(w => [w.key, w.at / H]), [['stale', 96]]);
  assert.deepEqual(countersignWarnings({ signedAt: start - 5 * 24 * H, start }).map(w => [w.key, (w.at - start) / H]), [['countersign', -96], ['countersign_trial_day', 0]]);
  assert.deepEqual(countersignWarnings({ signedAt: start - 30 * H, start }).map(w => [w.key, (w.at - start) / H]), [['countersign', -24], ['countersign_trial_day', 0]]);
  assert.deepEqual(countersignWarnings({ signedAt: start - 20 * H, start }).map(w => [w.key, (w.at - start) / H]), [['countersign', -18], ['countersign_trial_day', 0]]);
  assert.match(followUpPromise({ sentAt: start - 36 * H, startDate: '2026-10-26' }), /^If they haven't signed by Sun, Oct 25, 9:00 AM PT, I'll send one DocuSign reminder and tell you\.$/);
});

function world({ envelope, candidate, own = false, resendOk = true }) {
  const calls = [], said = [], notes = [];
  const sender = {
    envelope: async () => structuredClone(envelope()),
    reminders: async () => ({ enabled: own }),
    resend: async id => { calls.push(id); return resendOk ? { ok: true } : { ok: false, code: 'FAILED_EMAIL_SENDING' }; },
  };
  const notion = { getCandidate: async () => candidate(), findCandidatesByEmail: async () => [candidate()], appendCandidateNote: async n => notes.push(n) };
  return { calls, said, notes, sender, notion, poster: async t => said.push(t) };
}
const signer = (status, extra = {}) => ({ name: 'Jane Doe', email: 'jane@example.com', status, sentAt: null, signedAt: null, ...extra });
const project = status => ({ name: 'Project Owner', email: 'project@company.example', status });

test('a last-second packet (36h before the start): reminded 24h before, Project told then, and on the trial day; never twice', async () => {
  const db = d1();
  const start = trialStartMs('2026-10-26'), sentAt = start - 36 * H;
  await put(db, 'docusign:packet:jane@example.com', { at: sentAt, envelopeId: ENV_ID, pageId: 'p1', name: 'Jane Doe' });
  let me = signer('sent');
  const w = world({ envelope: () => ({ status: 'sent', signers: [me, project('created')] }), candidate: () => ({ pageId: 'p1', fullName: 'Jane Doe', fields: { 'Trial Start': '2026-10-26', Outcome: 'Proceeding' } }) });
  const run = at => runPaperworkFollowUps({ db, ...w, clock: () => at });
  await run(start - 25 * H);
  assert.equal(w.calls.length, 0, 'not yet');
  await run(start - 24 * H + 60_000);
  assert.equal(w.calls.length, 1, 'reminded 24h before');
  assert.equal(w.said.length, 1);
  assert.match(w.said[0], /^⏳ Jane Doe hasn't signed the work trial documents \(not opened\); I reminded them just now\. Their trial starts tomorrow \(Mon Oct 26\)\. Their accounts won't be requested until they sign\. Say "resend Jane's DocuSign"/);
  assert.equal(w.notes.length, 1);
  for (let t = start - 23 * H; t < start; t += H) await run(t);
  assert.equal(w.calls.length, 1, 'one reminder only');
  assert.equal(w.said.length, 1);
  me = signer('delivered');
  await run(start + 60_000);
  assert.equal(w.said.length, 2);
  assert.match(w.said[1], /^🚨 Jane Doe's trial starts today and they still haven't signed the work trial documents \(opened but not signed\)/);
  await run(start + 2 * H);
  assert.equal(w.said.length, 2);
});

test('the reminder is skipped after a recent resend or when DocuSign reminds on its own; a refused reminder is told, not retried', async () => {
  const start = trialStartMs('2026-11-09'), sentAt = start - 7 * 24 * H;
  for (const [resentAt, own] of [[sentAt + 40 * H, false], [null, true]]) {
    const db = d1();
    await put(db, 'docusign:packet:jane@example.com', { at: sentAt, envelopeId: ENV_ID, pageId: 'p1' });
    if (resentAt) await put(db, `docusign:resent:${ENV_ID}`, { at: resentAt });
    const w = world({ own, envelope: () => ({ status: 'sent', signers: [signer('sent'), project('created')] }), candidate: () => ({ pageId: 'p1', fullName: 'Jane Doe', fields: { 'Trial Start': '2026-11-09' } }) });
    await runPaperworkFollowUps({ db, ...w, clock: () => sentAt + 48 * H + 60_000 });
    await runPaperworkFollowUps({ db, ...w, clock: () => sentAt + 80 * H });
    assert.equal(w.calls.length, 0, own ? 'DocuSign reminds' : 'resent 8 hours before');
  }
  const db = d1();
  await put(db, 'docusign:packet:jane@example.com', { at: sentAt, envelopeId: ENV_ID, pageId: 'p1' });
  const w = world({ resendOk: false, envelope: () => ({ status: 'sent', signers: [signer('sent'), project('created')] }), candidate: () => ({ pageId: 'p1', fullName: 'Jane Doe', fields: { 'Trial Start': '2026-11-09' } }) });
  await runPaperworkFollowUps({ db, ...w, clock: () => sentAt + 48 * H + 60_000 });
  await runPaperworkFollowUps({ db, ...w, clock: () => sentAt + 50 * H });
  assert.equal(w.calls.length, 1);
  assert.equal(w.said.length, 1);
  assert.match(w.said[0], /DocuSign refused my reminder to Jane Doe \(FAILED_EMAIL_SENDING\)/);
});

test("waiting on Project's countersignature: nudged 24h later, or sooner before the start; Project's DMs wait for the morning", async () => {
  const db = d1();
  const start = trialStartMs('2026-10-26');
  const signedAt = Date.parse('2026-10-22T06:00:00Z'); // Wed 11 pm PT
  await put(db, 'docusign:packet:jane@example.com', { at: signedAt - 5 * H, envelopeId: ENV_ID, pageId: 'p1' });
  const w = world({ envelope: () => ({ status: 'sent', signers: [signer('completed', { signedAt }), project('sent')] }), candidate: () => ({ pageId: 'p1', fullName: 'Jane Doe', fields: { 'Trial Start': '2026-10-26' } }) });
  const run = at => runPaperworkFollowUps({ db, ...w, clock: () => at });
  await run(signedAt + 60_000);
  await run(signedAt + 24 * H + 60_000); // Thu 11 pm PT: night, held
  assert.equal(w.said.length, 0);
  await run(Date.parse('2026-10-23T14:05:00Z')); // Fri 7:05 am PT
  assert.equal(w.said.length, 1);
  assert.match(w.said[0], /^📋 Jane Doe signed the work trial documents 32 hours ago; they're waiting on your countersignature\. Their trial starts on Mon Oct 26\./);
  assert.equal(w.calls.length, 0, 'the candidate is never reminded once they signed');
});

test('declined, voided, bounced and closed: Project told once; declined or voided frees the packet to be sent again', async () => {
  const cases = [
    [{ status: 'declined', signers: [signer('declined', { declinedReason: 'Rate too low' }), project('created')] }, /^🚨 Jane Doe declined the work trial documents in DocuSign: “Rate too low”\./, 'declined'],
    [{ status: 'voided', voidedReason: 'Envelope has expired.', signers: [signer('sent'), project('created')] }, /expired in DocuSign before they signed/, 'expired'],
    [{ status: 'sent', signers: [signer('autoresponded'), project('created')] }, /couldn't deliver Jane Doe's work trial documents to jane@example\.com/, undefined],
    [{ status: 'sent', signers: [signer('sent'), project('created')] }, /closed on the tracker \(Withdrawn or Unavailable\)/, undefined, 'Withdrawn or Unavailable'],
    [{ status: 'completed', signers: [signer('completed'), project('completed')] }, null, undefined],
  ];
  for (const [envelope, pattern, closed, outcome] of cases) {
    const db = d1();
    await put(db, 'docusign:packet:jane@example.com', { at: Date.parse('2026-10-20T16:00:00Z'), envelopeId: ENV_ID, pageId: 'p1' });
    const w = world({ envelope: () => envelope, candidate: () => ({ pageId: 'p1', fullName: 'Jane Doe', fields: { Outcome: outcome } }) });
    await runPaperworkFollowUps({ db, ...w, clock: () => Date.parse('2026-10-20T18:00:00Z') });
    await runPaperworkFollowUps({ db, ...w, clock: () => Date.parse('2026-10-20T19:00:00Z') });
    assert.equal(w.said.length, pattern ? 1 : 0, JSON.stringify(envelope.status));
    if (pattern) assert.match(w.said[0], pattern);
    assert.equal((await get(db, 'docusign:packet:jane@example.com')).closed, closed);
    assert.equal(w.calls.length, 0);
  }
});
