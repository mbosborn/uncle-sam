import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runManualRejects, HOLD_MS } from '../service/lib/manual-reject.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const ENV = { UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled' };
const NOW = Date.parse('2026-10-16T18:00:00Z');
const CAND = '3f26ba36-8537-8000-8000-0000000000c1';
function world({ cards = [], requests = [] } = {}) {
  const w = { cards, closed: [], notes: [], posts: [], candidate: { pageId: CAND, fullName: 'Pat Doe ⭐', email: 'pat@example.invalid', fields: { Outcome: 'Proceeding', Stage: 'Case Study' } } };
  w.notion = { readControl: async () => ({ mode: 'Live' }), listStageRejects: async () => w.cards, getCandidate: async () => w.candidate,
    closeCandidate: async args => { w.closed.push(args); w.candidate.fields = { Outcome: 'Not Selected', Stage: 'Closed' }; return { verified: true }; },
    appendCandidateNote: async n => { w.notes.push(n); return { verified: true }; } };
  w.store = { listRequestsForCandidate: async () => requests };
  w.run = (now, db) => runManualRejects({ env: ENV, db, notion: w.notion, store: w.store, poster: async t => w.posts.push(t), clock: () => now });
  return w;
}
const card = (extra = {}) => ({ pageId: '3f46ba36-8537-8000-8000-0000000000d1', url: 'https://www.notion.so/card', candidateIds: [CAND], takeHomeReview: 'Reject', deepDive: null, submittedAt: '2026-10-14T10:00:00Z', ...extra });

test('Manual Reject: rows already Reject on the first run are history; a new one waits 30 minutes, then the candidate is Not Selected', async () => {
  const db = d1(), w = world({ cards: [card({ pageId: '3f46ba36-8537-8000-8000-0000000000aa' })] });
  assert.equal((await w.run(NOW, db)).state, 'baselined');
  await w.run(NOW + 60_000, db);
  assert.equal(w.closed.length + w.posts.length, 0, 'history is never acted on');
  w.cards.push(card());
  await w.run(NOW + 120_000, db);
  assert.equal(w.closed.length, 0);
  assert.match(w.posts[0], /^📋 Pat Doe's take-home is marked Reject on the Take-homes tab\. In 30 minutes I record them Not Selected/);
  await w.run(NOW + 120_000 + HOLD_MS - 60_000, db);
  assert.equal(w.closed.length, 0, 'not before 30 minutes');
  await w.run(NOW + 120_000 + HOLD_MS + 1000, db);
  assert.equal(w.closed.length, 1);
  assert.equal(w.closed[0].outcome, 'Not Selected');
  assert.equal(w.closed[0].interviewEnd.at, '2026-10-14T10:00:00.000Z', 'the submission is the last completed step');
  assert.match(w.posts.at(-1), /^🫡 Pat Doe is marked Not Selected\. The rejection email goes out within a few minutes/);
  await w.run(NOW + 2 * HOLD_MS, db);
  assert.equal(w.closed.length, 1, 'once');
});

test('Manual Reject: set back within 30 minutes stands it down; Uncle Sam\'s own pending confirmation and closed candidates are left alone', async () => {
  const db = d1(), w = world();
  await w.run(NOW, db);
  w.cards.push(card({ takeHomeReview: null, deepDive: 'Reject' }));
  await w.run(NOW + 60_000, db);
  assert.match(w.posts[0], /deep dive is marked Reject/);
  w.cards.length = 0;
  await w.run(NOW + 120_000, db);
  assert.match(w.posts.at(-1), /^🫡 Stood down: Pat Doe's deep dive is no longer Reject/);
  await w.run(NOW + HOLD_MS + 180_000, db);
  assert.equal(w.closed.length, 0);
  const db2 = d1(), w2 = world({ requests: [{ action: 'rejection.confirmation_request', createdAt: NOW - 3600_000 }] });
  await w2.run(NOW, db2); w2.cards.push(card());
  await w2.run(NOW + 60_000, db2); await w2.run(NOW + HOLD_MS + 120_000, db2);
  assert.equal(w2.closed.length + w2.posts.length, 0, 'waits for the confirmation step');
});
