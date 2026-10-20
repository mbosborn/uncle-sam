import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runRejectionSender, rejectionBody, REJECTION_SUBJECT } from '../service/lib/rejection-sender.mjs';

const NOW = Date.parse('2026-10-16T18:00:00.000Z');
const ENV = { UNCLE_SAM_REJECTION_SENDER: 'uncle-sam', UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled' };
const id = n => `3f26ba36-8537-8000-8000-${String(n).padStart(12, '0')}`;

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a),
    all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
function fakeNotion(rows) {
  const notes = [], writes = [];
  const state = pageId => { const r = rows.get(pageId); return { candidate: structuredClone(r.candidate), sender: structuredClone(r.sender) }; };
  return { notes, writes, readControl: async () => ({ mode: 'Live' }),
    listRejectionQueue: async () => [...rows.values()].filter(r => (r.candidate.fields.Outcome === 'Not Selected' && !r.sender.status) || r.sender.status === 'Scheduled').map(r => state(r.candidate.pageId)),
    getRejectionState: async pageId => state(pageId),
    async writeRejection({ pageId, fields }) {
      writes.push({ pageId, fields }); const s = rows.get(pageId).sender;
      for (const [k, v] of Object.entries(fields)) if (!['close', 'interviewEnd'].includes(k)) s[k] = v === '' ? null : v;
      if (fields.close) rows.get(pageId).candidate.fields.Stage = 'Closed';
      return state(pageId);
    },
    appendCandidateNote: async n => { notes.push(n); } };
}
function fakeGmail({ earlier = [], error = null } = {}) {
  const sends = [], searches = [];
  return { sends, searches, canSearch: async () => true, async searchSent(q) { searches.push(q); return earlier; },
    async send(m) { sends.push(m); if (error) { const e = new Error(error.code); Object.assign(e, error); throw e; }
      return { id: 'abc123def', url: 'https://mail.google.com/mail/?authuser=project@company.example#all/abc123def', sentAt: new Date(NOW).toISOString() }; } };
}
const row = (n, { outcome = 'Not Selected', email = `c${n}@example.invalid`, name = `Jane Doe${n}`, ...sender } = {}) =>
  [id(n), { candidate: { pageId: id(n), fullName: name, email, archived: false, fields: { Outcome: outcome, Stage: 'Interview' }, url: 'https://www.notion.so/x' },
    sender: { status: null, hold: false, attempt: null, decisionAt: null, decisionKey: null, queuedTo: null, scheduledFor: null, lastInterviewEnd: null, ...sender } }];

test('the approved rejection text, word for word, with the first name', () => {
  assert.equal(rejectionBody('Daniy Sadiq ⭐'), 'Hi Daniy,\n\nThank you for your interest in Company and for the time you invested in interviewing with us. We are very appreciative.\n\nAfter careful consideration, I’m writing to let you know that we will not be moving forward with your candidacy at this time. We are fortunate to have a lot of interest and, though you were strong in a lot of areas, we are proceeding with candidates who more fully align with the role requirements.\n\nThanks again for the time and energy you put into interviewing with us. It means a lot to our team.\n\nBest,');
  assert.match(rejectionBody('(unknown)'), /^Hi,\n\n/);
});

test('Project, Oct 15: Uncle Sam enrolls a new Not Selected 24h after the interview, sends once when due, records it and closes the record; history is a baseline', async () => {
  const rows = new Map([row(1, { status: null })]); // already Not Selected and blank before the switch: baseline
  const notion = fakeNotion(rows), gmail = fakeGmail(), db = d1();
  let now = NOW;
  await runRejectionSender({ env: ENV, db, notion, gmail, clock: () => now });
  assert.equal(notion.writes.length, 0, 'history is never enrolled');
  rows.set(...row(2, { lastInterviewEnd: '2026-10-16T10:00:00.000Z' }));
  const first = await runRejectionSender({ env: ENV, db, notion, gmail, clock: () => now });
  assert.equal(first.enrolled, 1);
  const s = rows.get(id(2)).sender;
  assert.deepEqual([s.status, s.queuedTo, s.scheduledFor, s.decisionAt], ['Scheduled', 'c2@example.invalid', '2026-10-17T10:00:00.000Z', '2026-10-16T18:00:00.000Z']);
  now = Date.parse('2026-10-17T09:59:00.000Z');
  assert.equal((await runRejectionSender({ env: ENV, db, notion, gmail, clock: () => now })).waiting, 1);
  assert.equal(gmail.sends.length, 0, 'never early');
  now = Date.parse('2026-10-17T10:00:00.000Z');
  const sent = await runRejectionSender({ env: ENV, db, notion, gmail, clock: () => now });
  assert.equal(sent.sent, 1);
  assert.deepEqual(gmail.sends, [{ to: 'c2@example.invalid', subject: REJECTION_SUBJECT, body: rejectionBody('Jane Doe2') }]);
  assert.equal(gmail.searches[0], `to:c2@example.invalid ("${REJECTION_SUBJECT}" OR "not be moving forward")`);
  assert.equal(rows.get(id(2)).sender.status, 'Sent'); assert.equal(rows.get(id(2)).candidate.fields.Stage, 'Closed');
  assert.match(rows.get(id(2)).sender.attempt, /^3f26.*\| uncle-sam tick \| 2026-10-17T10:00:00\.000Z$/);
  await runRejectionSender({ env: ENV, db, notion, gmail, clock: () => now + 3600_000 });
  assert.equal(gmail.sends.length, 1, 'once');
});

test('Uncle Sam never sends for a hold, a changed decision or recipient, someone already rejected, or with no interview end; an unclear send is never retried', async () => {
  const due = { status: 'Scheduled', decisionAt: '2026-10-15T10:00:00.000Z', decisionKey: 'k', scheduledFor: '2026-10-16T10:00:00.000Z', lastInterviewEnd: '2026-10-15T10:00:00.000Z' };
  const rows = new Map([row(1, { ...due, hold: true, queuedTo: 'c1@example.invalid' }), row(2, { ...due, outcome: 'On Hold', queuedTo: 'c2@example.invalid' }),
    row(3, { ...due, queuedTo: 'old@example.invalid' }), row(4, { ...due, queuedTo: 'c4@example.invalid' }), row(9, { lastInterviewEnd: null })]);
  const db = d1();
  await runRejectionSender({ env: ENV, db, notion: fakeNotion(new Map()), gmail: fakeGmail(), clock: () => NOW }); // empty baseline
  const notion = fakeNotion(rows), gmail = fakeGmail({ earlier: [{ id: 'x1', url: 'https://mail.google.com/x1', sentAt: '2026-10-15T20:00:00.000Z' }] });
  const r = await runRejectionSender({ env: ENV, db, notion, gmail, clock: () => NOW });
  assert.equal(gmail.sends.length, 0);
  assert.equal(rows.get(id(1)).sender.status, 'Scheduled', 'hold: waits');
  assert.equal(rows.get(id(2)).sender.status, 'Cancelled');
  assert.equal(rows.get(id(3)).sender.status, 'Needs attention', 'recipient changed');
  assert.equal(rows.get(id(4)).sender.status, 'Sent'); assert.equal(rows.get(id(4)).sender.messageUrl, 'https://mail.google.com/x1');
  assert.equal(rows.get(id(9)).sender.status, 'Needs attention', 'no interview end');
  assert.equal(r.alreadySent, 1);
  const rows2 = new Map([row(5, { ...due, queuedTo: 'c5@example.invalid' })]);
  const unclear = fakeGmail({ error: { code: 'gmail_timeout', uncertain: true } });
  await runRejectionSender({ env: ENV, db, notion: fakeNotion(rows2), gmail: unclear, clock: () => NOW });
  assert.equal(rows2.get(id(5)).sender.status, 'Needs attention'); assert.ok(rows2.get(id(5)).sender.attempt, 'the attempt stays');
  await runRejectionSender({ env: ENV, db, notion: fakeNotion(rows2), gmail: unclear, clock: () => NOW + 600_000 });
  assert.equal(unclear.sends.length, 1, 'never retried');
  const rows3 = new Map([row(6, { ...due, queuedTo: 'c6@example.invalid' })]);
  const refused = fakeGmail({ error: { code: 'gmail_signature_http_403', uncertain: false } });
  await runRejectionSender({ env: ENV, db, notion: fakeNotion(rows3), gmail: refused, clock: () => NOW });
  assert.equal(rows3.get(id(6)).sender.status, 'Scheduled'); assert.equal(rows3.get(id(6)).sender.attempt, null, 'certainly not sent: back in the queue');
  assert.equal((await runRejectionSender({ env: { ...ENV, UNCLE_SAM_REJECTION_SENDER: '' }, db, notion: fakeNotion(rows3), gmail: refused, clock: () => NOW })).state, 'off');
});

test('Reading the calendar: a missing interview end is filled from it, and a later interview moves the email later', async () => {
  const db = d1();
  await runRejectionSender({ env: ENV, db, notion: fakeNotion(new Map()), gmail: fakeGmail(), clock: () => NOW });
  const rows = new Map([row(7, {}), row(8, { status: 'Scheduled', decisionAt: '2026-10-15T10:00:00.000Z', decisionKey: 'k8', queuedTo: 'c8@example.invalid',
    scheduledFor: '2026-10-16T10:00:00.000Z', lastInterviewEnd: '2026-10-15T10:00:00.000Z' })]);
  const ends = { 'c7@example.invalid': { at: '2026-10-16T15:00:00.000Z', sourceUrl: 'https://calendar.google.com/e7' }, 'c8@example.invalid': { at: '2026-10-16T12:00:00.000Z', sourceUrl: 'https://calendar.google.com/e8' } };
  const gmail = fakeGmail();
  await runRejectionSender({ env: ENV, db, notion: fakeNotion(rows), gmail, findInterviewEnd: async email => ends[email] ?? null, clock: () => NOW });
  assert.equal(rows.get(id(7)).sender.status, 'Scheduled'); assert.equal(rows.get(id(7)).sender.scheduledFor, '2026-10-17T15:00:00.000Z');
  assert.equal(rows.get(id(8)).sender.scheduledFor, '2026-10-17T12:00:00.000Z', 'moved later, not sent');
  assert.equal(gmail.sends.length, 0);
});
