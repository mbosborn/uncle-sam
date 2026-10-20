/**
 * Never the same message twice when two runs overlap (Project, 2026-10-16: "two ticks running can still double-send a DM, and I
 * want to prevent that"). Each guard is exercised with the two runs truly at once (Promise.all), against SQLite.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { takeTickLease, releaseTickLease, withLease, INTERVIEW_FOLLOWUPS_LEASE } from '../service/lib/tick-lease.mjs';
import { noticeStore } from '../service/lib/stuck-rejections.mjs';
import { applyConnectEvent } from '../service/lib/docusign.mjs';
import { runStaleSweep } from '../service/lib/stale-work.mjs';
import { sendWorkTrialPacket, prepareDocusignLink, completeDocusignConnection } from '../service/lib/docusign-send.mjs';

const NOW = Date.parse('2026-10-16T18:00:00Z');
function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  sqlite.exec('CREATE TABLE uncle_sam_wispr (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  // Every call yields first, so two runs started together really interleave between their reads and writes.
  const tick = () => new Promise(r => setImmediate(r));
  const prepare = sql => ({ bind: (...a) => ({ first: async () => { await tick(); return sqlite.prepare(sql).get(...a) ?? null; },
    run: async () => { await tick(); return sqlite.prepare(sql).run(...a); }, all: async () => { await tick(); return { results: sqlite.prepare(sql).all(...a) }; } }) });
  return { prepare, sqlite };
}

test('the tick lease: two ticks at once, one runs; a lease left by a killed tick lapses after its TTL', async () => {
  const db = d1();
  const [a, b] = await Promise.all([takeTickLease(db, { now: NOW }), takeTickLease(db, { now: NOW })]);
  assert.equal([a, b].filter(Boolean).length, 1);
  assert.equal(await takeTickLease(db, { now: NOW + 5 * 60_000 }), null, 'still held inside the TTL');
  assert.ok(await takeTickLease(db, { now: NOW + 6 * 60_000 + 1 }), 'a dead tick blocks for at most the TTL');
  await releaseTickLease(db, a ?? b);
});

test('interview follow-ups: the tick and the minute run at once, only one picks who is asked', async () => {
  const db = d1();
  let inside = 0, most = 0, ran = 0;
  const plan = async () => { inside++; most = Math.max(most, inside); ran++; await new Promise(r => setTimeout(r, 20)); inside--; return ['asked'] };
  const results = await Promise.all([withLease(db, INTERVIEW_FOLLOWUPS_LEASE, plan, { now: NOW }), withLease(db, INTERVIEW_FOLLOWUPS_LEASE, plan, { now: NOW })]);
  assert.equal(most, 1); assert.equal(ran, 1);
  assert.deepEqual(results.map(r => r.skipped ?? 'ran').sort(), ['in_progress', 'ran']);
  // Released when done: the next run goes ahead.
  assert.deepEqual(await withLease(db, INTERVIEW_FOLLOWUPS_LEASE, plan, { now: NOW + 1000 }), { value: ['asked'] });
  // A throw still lets go.
  await assert.rejects(withLease(db, INTERVIEW_FOLLOWUPS_LEASE, async () => { throw new Error('boom'); }, { now: NOW + 2000 }), /boom/);
  assert.ok((await withLease(db, INTERVIEW_FOLLOWUPS_LEASE, plan, { now: NOW + 3000 })).value);
});

test('a "tell once" claim: ten at once, exactly one wins; with a max age, an old claim can be taken over', async () => {
  const kv = noticeStore(d1());
  const wins = await Promise.all(Array.from({ length: 10 }, () => kv.claim('told:x', { at: NOW }, NOW)));
  assert.equal(wins.filter(Boolean).length, 1);
  assert.equal(await kv.claim('told:x', { at: NOW }, NOW + 86400_000), false, 'without a max age, never again');
  assert.equal(await kv.claim('told:x', { at: NOW }, NOW + 1000, { maxAgeMs: 7 * 86400_000 }), false);
  assert.equal(await kv.claim('told:x', { at: NOW }, NOW + 8 * 86400_000, { maxAgeMs: 7 * 86400_000 }), true);
});

test('DocuSign sends two events for one signing at the same moment: Project hears "signed" once', async () => {
  const db = d1(), posted = [];
  const candidate = { pageId: '3f26ba36-8537-8000-8000-00000000000a', fullName: 'Jane Fixture', email: 'jane@example.invalid', fields: { Paperwork: 'Sent' } };
  const notion = { findCandidatesByEmail: async () => [candidate], upsertOperationsRecord: async () => ({ verified: true }),
    setPaperwork: async () => ({ verified: true }), appendCandidateNote: async () => ({ verified: true }) };
  const ev = name => ({ event: name, generatedDateTime: '2026-10-16T17:10:00Z', data: { envelopeId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', envelopeSummary: {
    status: 'sent', emailSubject: 'Work Trial Docs -- Jane Fixture', recipients: { signers: [
      { email: 'jane@example.invalid', name: 'Jane Fixture', status: 'completed', signedDateTime: '2026-10-16T17:10:00Z' },
      { email: 'project@company.example', name: 'Project Owner', status: 'sent' }] } } } });
  await Promise.all([applyConnectEvent({ event: ev('recipient-completed'), db, notion, poster: async t => posted.push(t), clock: () => NOW }),
    applyConnectEvent({ event: ev('envelope-updated'), db, notion, poster: async t => posted.push(t), clock: () => NOW })]);
  assert.equal(posted.length, 1);
  assert.match(posted[0], /signed all their DocuSign paperwork.*It's waiting on your countersignature; DocuSign emailed you the link\./);
});

test('two stale sweeps at once tell Project once', async () => {
  const db = d1();
  db.sqlite.exec("CREATE TABLE uncle_sam_events (event_id TEXT PRIMARY KEY, source TEXT, payload_json TEXT, status TEXT, wake_state TEXT, wake_attempt_id TEXT, wake_control_version INTEGER, wake_pause_generation INTEGER, wake_error TEXT, observed_at INTEGER, processed_at INTEGER, receipt_json TEXT)");
  db.sqlite.exec("CREATE TABLE uncle_sam_request_events (request_key TEXT, event_id TEXT)");
  db.sqlite.exec("CREATE TABLE uncle_sam_requests (request_key TEXT, action TEXT, payload_json TEXT, claim_token TEXT, state TEXT, claimed_at INTEGER, last_error TEXT, updated_at INTEGER)");
  db.sqlite.prepare("INSERT INTO uncle_sam_events (event_id, source, payload_json, status, wake_state, wake_error, observed_at) VALUES ('e1', 'slack', '{\"type\":\"message\",\"text\":\"hi\"}', 'Observed', 'NeedsAttention', 'x', ?)").run(NOW);
  const posted = [];
  await Promise.all([runStaleSweep({ db, clock: () => NOW, poster: async t => posted.push(t) }), runStaleSweep({ db, clock: () => NOW, poster: async t => posted.push(t) })]);
  assert.equal(posted.length, 1);
});

test('the work-trial packet: two sends at once (two taps, or a tap and a typed message) make one envelope', async () => {
  const db = d1();
  const env = { WISPR_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'), DOCUSIGN_INTEGRATION_KEY: 'c807de29-de8c-43ec-8dbe-8b991f9f16a3', DOCUSIGN_SECRET_KEY: '11111111-2222-3333-4444-555555555555' };
  const link = await prepareDocusignLink({ env, db, clock: () => NOW });
  await completeDocusignConnection({ env, db, clock: () => NOW, code: 'c', state: new URL(link.url).searchParams.get('state'),
    fetchImpl: async url => String(url).endsWith('/oauth/userinfo') ? Response.json({ sub: 'u1', email: 'project@company.example', accounts: [{ account_id: 'dcd9d815-f64e-4870-a725-4e81cb766cc0', base_uri: 'https://na4.docusign.net' }] })
      : Response.json({ access_token: 'at', refresh_token: 'rt', expires_in: 28800 }) });
  let made = 0;
  const sender = { envelopesFor: async () => { await new Promise(r => setTimeout(r, 5)); return []; },
    sendPacket: async () => { made++; await new Promise(r => setTimeout(r, 5)); return { ok: true, envelopeId: '99999999-9999-9999-9999-999999999999' }; } };
  const who = { pageId: 'p', fullName: 'Jane Doe', email: 'jane@example.com', dailyRate: 250 };
  const out = await Promise.all([sendWorkTrialPacket({ env, db, sender, who, clock: () => NOW }), sendWorkTrialPacket({ env, db, sender, who, clock: () => NOW })]);
  assert.equal(made, 1);
  assert.deepEqual(out.map(o => o.reason).sort(), ['already_sent', 'sent']);
});

test('what reads as a no-show in a typed report', async () => {
  const { looksLikeNoShow } = await import('../service/lib/no-show.mjs');
  for (const t of ['he did not attend the meeting', "she didn't show", 'no show', 'never joined', 'candidate was a no-show', "he didn't join the call"]) assert.ok(looksLikeNoShow(t), t);
  for (const t of ['he asked to reschedule', 'we moved it to Monday', 'cancelled, he had a conflict', 'great call, strong yes']) assert.ok(!looksLikeNoShow(t), t);
});

test('a second miss: an earlier no-show, cancellation or reschedule makes this the second time', async () => {
  const { earlierMisses, missesText } = await import('../service/lib/no-show.mjs');
  const reqs = [
    { action: 'noshow.choice', occurrenceId: 'noshow:cal:1', receipt: { reply: { choice: 'reschedule' } } },
    { action: 'noshow.choice', occurrenceId: 'noshow:cal:2', receipt: { reply: { choice: 'happened' } } },
    { action: 'interview.feedback_request', occurrenceId: 'cal:3', receipt: { reply: { kind: 'did_not_happen', text: 'What happened: Rescheduled' } } },
    { action: 'interview.feedback_request', occurrenceId: 'cal:1', receipt: { reply: { kind: 'did_not_happen', text: 'no show' } } },
    { action: 'interview.feedback_request', occurrenceId: 'cal:9', receipt: { reply: { kind: 'did_not_happen', text: 'no show' } } },
  ];
  const m = earlierMisses(reqs, 'noshow:cal:9');
  assert.equal(m.count, 2);
  assert.equal(missesText(m.kinds), 'a no-show and a reschedule');
  assert.equal(earlierMisses([], 'noshow:cal:9').count, 0);
});
