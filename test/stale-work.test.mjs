import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runStaleSweep, retryable, describeEvent, STALE_MS } from '../service/lib/stale-work.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE uncle_sam_events (event_id TEXT PRIMARY KEY, source TEXT, payload_json TEXT, status TEXT, wake_state TEXT, wake_attempt_id TEXT,
      wake_control_version INTEGER, wake_pause_generation INTEGER, wake_error TEXT, observed_at INTEGER, processed_at INTEGER, receipt_json TEXT);
    CREATE TABLE uncle_sam_request_events (request_key TEXT, event_id TEXT, linked_at INTEGER);
    CREATE TABLE uncle_sam_requests (request_key TEXT PRIMARY KEY, action TEXT, payload_json TEXT, state TEXT, claim_token TEXT, claimed_at INTEGER, last_error TEXT, updated_at INTEGER);`);
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare, sqlite };
}
const addEvent = (db, id, { source = 'notion', type = 'page.properties_updated', attempt = 'a1', text } = {}) =>
  db.sqlite.prepare(`INSERT INTO uncle_sam_events (event_id, source, payload_json, status, wake_state, wake_attempt_id, observed_at) VALUES (?, ?, ?, 'Observed', 'Sending', ?, 0)`)
    .run(id, source, JSON.stringify({ type, ...(text ? { text } : {}) }), attempt);
const row = (db, id) => db.sqlite.prepare('SELECT * FROM uncle_sam_events WHERE event_id = ?').get(id);

test('a claim still held 15 minutes after it was first seen is released once, never while a run may be going', async () => {
  const db = d1(); let now = 1_000_000; const said = [];
  addEvent(db, 'notion:1');
  const sweep = () => runStaleSweep({ db, clock: () => now, poster: async t => said.push(t) });
  assert.equal((await sweep()).watched, 1);
  now += STALE_MS - 1; assert.equal((await sweep()).retried, 0);
  assert.equal(row(db, 'notion:1').wake_state, 'Sending');
  now += 1; assert.equal((await sweep()).retried, 1);
  assert.equal(row(db, 'notion:1').wake_state, 'Pending');
  assert.equal(row(db, 'notion:1').wake_attempt_id, null);
  // Claimed again and stuck again: closed and told once, never a third run.
  db.sqlite.prepare("UPDATE uncle_sam_events SET wake_state = 'Sending', wake_attempt_id = 'a2' WHERE event_id = 'notion:1'").run();
  await sweep(); now += STALE_MS; const r = await sweep();
  assert.equal(r.closed, 1);
  assert.equal(row(db, 'notion:1').status, 'NeedsAttention');
  assert.equal(said.length, 1);
  assert.match(said[0], /will not run it again/);
  await sweep(); assert.equal(said.length, 1);
});

test('an event that already queued a message, or a typed Slack message, is never run again', async () => {
  const db = d1(); let now = 0; const said = [];
  addEvent(db, 'notion:2');
  db.sqlite.prepare("INSERT INTO uncle_sam_request_events VALUES ('usam:v1:x', 'notion:2', 0)").run();
  addEvent(db, 'slack:m', { source: 'slack', type: 'message', text: 'move Dylan on' });
  addEvent(db, 'slack:f', { source: 'slack', type: 'feedback_form' });
  const sweep = () => runStaleSweep({ db, clock: () => now, poster: async t => said.push(t) });
  await sweep(); now += STALE_MS; const r = await sweep();
  assert.equal(r.closed, 2); assert.equal(r.retried, 1);
  assert.equal(row(db, 'notion:2').status, 'NeedsAttention');
  assert.equal(row(db, 'slack:m').status, 'NeedsAttention');
  assert.equal(row(db, 'slack:f').wake_state, 'Pending');
  assert.equal(said.length, 2);
  assert.ok(said.some(t => /already queued/.test(t)));
  assert.ok(said.some(t => /move Dylan on/.test(t)));
});

test('a message stuck mid-send becomes Uncertain and is never sent again; Project is told once', async () => {
  const db = d1(); let now = 10 * 60_000; const said = [];
  db.sqlite.prepare("INSERT INTO uncle_sam_requests VALUES ('usam:v1:abc', 'interview.feedback_request', ?, 'Sending', 'c1', 0, NULL, 0)")
    .run(JSON.stringify({ candidate: { fullName: 'Dylan Hayes' } }));
  const sweep = () => runStaleSweep({ db, clock: () => now, poster: async t => said.push(t) });
  await sweep(); now += STALE_MS; const r = await sweep();
  assert.equal(r.uncertain, 1);
  assert.equal(db.sqlite.prepare('SELECT state FROM uncle_sam_requests').get().state, 'Uncertain');
  assert.match(said[0], /Dylan Hayes/); assert.match(said[0], /will not send it again/);
  await sweep(); assert.equal(said.length, 1);
});

test('quiet failures are told once', async () => {
  const db = d1(); const said = [];
  db.sqlite.prepare(`INSERT INTO uncle_sam_events (event_id, source, payload_json, status, wake_state, wake_error, observed_at, processed_at, receipt_json)
    VALUES ('notion:3', 'notion', '{}', 'NeedsAttention', 'Pending', 'notion_timeout', 0, 5, '{"reason":"retries_exhausted"}')`).run();
  await runStaleSweep({ db, clock: () => 10, poster: async t => said.push(t) });
  await runStaleSweep({ db, clock: () => 20, poster: async t => said.push(t) });
  assert.equal(said.length, 1); assert.match(said[0], /notion_timeout/);
});

test('what is retryable and how events are described', () => {
  assert.equal(retryable({ source: 'notion', payload_json: '{}' }), true);
  assert.equal(retryable({ source: 'slack', payload_json: '{"type":"email_cancel"}' }), true);
  assert.equal(retryable({ source: 'slack', payload_json: '{"type":"qa_question"}' }), false);
  assert.match(describeEvent({ source: 'slack', payload_json: '{"type":"feedback_form"}' }), /feedback form/);
});
