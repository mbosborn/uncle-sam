import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import * as schema from '../service/db/schema.ts';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { createStore } from '../service/lib/store.mjs';

const quote = s => `"${s.replaceAll('"', '""')}"`;
const migrationDirectory = new URL('../service/drizzle/', import.meta.url);
// Execute the actual deployment migrations, not a hand-maintained schema replica.
function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const files = readdirSync(migrationDirectory).filter(name => name.endsWith('.sql')).sort();
  assert.ok(files.length > 0, 'Deployment migrations must exist');
  for (const name of files) sqlite.exec(readFileSync(new URL(name, migrationDirectory), 'utf8'));
  function prepare(sql, params = []) {
    return {
      bind(...values) { return prepare(sql, values); },
      async first(column) { const row = sqlite.prepare(sql).get(...params); return column ? row?.[column] ?? null : row ?? null; },
      async all() { return { results: sqlite.prepare(sql).all(...params), success: true }; },
      async run() { const result = sqlite.prepare(sql).run(...params); return { success: true, meta: { changes: result.changes } }; },
      sql, params,
    };
  }
  return { sqlite, prepare, async batch(statements) {
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(s => ({ success: true, results: sqlite.prepare(s.sql).all(...s.params) }));
      sqlite.exec('COMMIT'); return results;
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
}

const START = Date.parse('2026-10-14T00:00:00Z');
function fixture() {
  const db = database();
  let time = START;
  return { db, store: createStore(db, { authorized: true, clock: () => time }),
    advance(ms) { time += ms; }, restart() { return createStore(db, { authorized: true, clock: () => time }); } };
}
const input = (requestKey = 'request-1', overrides = {}) => ({ requestKey, candidateId: 'candidate-1',
  occurrenceId: 'round-1', action: 'onboarding.jamie', recipientIds: ['UJAMIE', 'UMASON'],
  payload: { fullName: 'Synthetic Candidate', instruction: 'fixture only' }, triggerAt: START, dueAt: START, ...overrides });
const slack = (eventId = 'event-1', overrides = {}) => ({ eventId, appId: 'APPTEST', teamId: 'TTEST',
  channelId: 'GTEST', channelType: 'mpim', authorId: 'UTEST', messageTs: `${START / 1000}.123456`,
  threadTs: `${START / 1000}.123456`, text: 'Synthetic event text', ...overrides });
async function live(store) {
  const c = await store.getControl();
  return (await store.updateControl({ expectedVersion: c.version, mode: 'Live', baselineComplete: true, activatedAt: START })).control;
}
const claim = (requestKey, c, claimToken = 'attempt-1') => ({ requestKey, claimToken,
  expectedControlVersion: c.version, expectedPauseGeneration: c.pauseGeneration });

test('deployment migrations produce every current Drizzle column and preserve foreign key integrity', () => {
  const db = database();
  for (const table of Object.values(schema)) {
    const cfg = getTableConfig(table);
    const actual = db.sqlite.prepare(`PRAGMA table_info(${quote(cfg.name)})`).all();
    assert.deepEqual(actual.map(c => [c.name, c.type.toLowerCase(), c.notnull]),
      cfg.columns.map(c => [c.name, c.getSQLType().toLowerCase(), +c.notNull]));
  }
  assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
});

test('unauthenticated store reveals no event/control/request data and cannot mutate', async () => {
  const { db, store } = fixture();
  await store.recordEvent(slack('private-event', { text: 'PRIVATE_SENTINEL' }));
  const publicStore = createStore(db);
  assert.deepEqual(publicStore.getPublicStatus(), { service: 'Uncle Sam', authenticated: false });
  for (const fn of [() => publicStore.getControl(), () => publicStore.getEvent('private-event'),
    () => publicStore.getStatus(), () => publicStore.listUnprocessedEvents(),
    () => publicStore.getRequest('request-1'), () => publicStore.recordEvent(slack())]) {
    await assert.rejects(fn, /Unauthorized/);
  }
  assert.equal(JSON.stringify(await store.getStatus()).includes('PRIVATE_SENTINEL'), false);
});

test('controls default Off/baseline false and persist through restart with CAS and immutable activation', async () => {
  const f = fixture();
  const initial = await f.store.getControl();
  assert.equal(initial.mode, 'Off'); assert.equal(initial.baselineComplete, false);
  assert.equal(initial.version, 0); assert.equal(initial.pauseGeneration, 0);
  await assert.rejects(() => f.store.updateControl({ expectedVersion: 0, mode: 'Live' }), /baseline/);
  const active = await live(f.store);
  assert.deepEqual(await f.restart().getControl(), active);
  assert.equal((await f.store.updateControl({ expectedVersion: 0, mode: 'Off' })).updated, false);
  await assert.rejects(() => f.store.updateControl({ expectedVersion: active.version, activatedAt: START + 1 }), /immutable/);
  const paused = (await f.store.updateControl({ expectedVersion: active.version, mode: 'Off' })).control;
  assert.equal(paused.pauseGeneration, active.pauseGeneration + 1);
});

test('event and semantic request uniqueness preserve first payload and link repeated source evidence', async () => {
  const f = fixture();
  assert.equal((await f.store.recordEvent(slack())).created, true);
  assert.equal((await f.store.recordEvent(slack('event-1', { text: 'amended replay' }))).created, false);
  const saved = await f.store.getEvent('event-1');
  assert.equal(saved.text, 'Synthetic event text');
  assert.equal(saved.occurredAt, START + 123); assert.equal(saved.observedAt, START);
  await f.store.recordEvent(slack('event-2'));
  assert.equal((await f.store.ensureRequest(input('request-1', { sourceEventId: 'event-1' }))).created, true);
  assert.equal((await f.restart().ensureRequest(input('request-1', { sourceEventId: 'event-2',
    recipientIds: ['UMASON', 'UJAMIE', 'UJAMIE'], payload: { changed: true } }))).created, false);
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM uncle_sam_request_events').get().n, 2);
  assert.equal((await f.store.getRequest('request-1')).payload.fullName, 'Synthetic Candidate');
  await assert.rejects(() => f.store.ensureRequest(input('request-1', { candidateId: 'other-namesake' })), /collision/);
  await assert.rejects(() => f.store.ensureRequest(input('missing-event-request', { sourceEventId: 'missing-event' })), /FOREIGN KEY/);
  assert.equal(await f.store.getRequest('missing-event-request'), null);
  await assert.rejects(() => f.store.recordEvent(slack('huge', { text: 'x'.repeat(262145) })), /exceeds/);
  assert.equal(await f.store.getEvent('huge'), null);
});

test('claim is atomic; concurrent workers and process restarts cannot both send', async () => {
  const f = fixture(); const c = await live(f.store);
  await f.store.ensureRequest(input());
  const results = await Promise.all([f.store.claimRequest(claim('request-1', c, 'worker-a')),
    f.restart().claimRequest(claim('request-1', c, 'worker-b'))]);
  assert.equal(results.filter(r => r.claimed).length, 1);
  const token = results.find(r => r.claimed).request.claimToken;
  assert.equal((await f.store.authorizeDispatch({ requestKey: 'request-1', claimToken: token })).allowed, true);
  assert.equal((await f.store.authorizeDispatch({ requestKey: 'request-1', claimToken: 'wrong' })).allowed, false);
  f.advance(7 * 86400000);
  assert.equal((await f.restart().claimRequest(claim('request-1', c, 'retry'))).claimed, false);
  assert.equal((await f.store.getRequest('request-1')).state, 'Sending');
});

test('pause generation invalidates old claims even after Live resumes; genuine receipts remain recordable', async () => {
  const f = fixture(); const c = await live(f.store);
  await f.store.ensureRequest(input()); await f.store.claimRequest(claim('request-1', c));
  const off = (await f.store.updateControl({ expectedVersion: c.version, mode: 'Off' })).control;
  await f.store.updateControl({ expectedVersion: off.version, mode: 'Live' });
  assert.equal((await f.store.authorizeDispatch({ requestKey: 'request-1', claimToken: 'attempt-1' })).allowed, false);
  await assert.rejects(() => f.store.completeRequest({ requestKey: 'request-1', claimToken: 'attempt-1', receipt: {} }), /verified/);
  assert.equal((await f.store.completeRequest({ requestKey: 'request-1', claimToken: 'attempt-1',
    receipt: { verified: true, resultId: 'verified-prior-message' } })).updated, true);
  assert.equal((await f.store.getRequest('request-1')).state, 'Sent');
});

test('uncertain sends stay unretryable; only matching verified reconciliation can finish', async () => {
  const f = fixture(); const c = await live(f.store);
  await f.store.ensureRequest(input()); await f.store.claimRequest(claim('request-1', c));
  await f.store.markUncertain({ requestKey: 'request-1', claimToken: 'attempt-1', reason: 'response lost' });
  f.advance(86400000);
  assert.equal((await f.restart().claimRequest(claim('request-1', c, 'retry'))).claimed, false);
  assert.equal((await f.store.cancelRequest({ requestKey: 'request-1', reason: 'cannot erase uncertainty' })).updated, false);
  assert.equal((await f.store.completeRequest({ requestKey: 'request-1', claimToken: 'wrong', receipt: { verified: true, resultId: 'x' } })).updated, false);
  assert.equal((await f.store.completeRequest({ requestKey: 'request-1', claimToken: 'attempt-1', receipt: { verified: true, resultId: 'found-message' } })).updated, true);
});

test('action hold applies to future requests, leaves unrelated actions eligible and resists stale release', async () => {
  const f = fixture(); await live(f.store);
  await f.store.recordEvent(slack('hold-event')); await f.store.recordEvent(slack('release-event'));
  const holdInput = { holdKey: 'hold-1', candidateId: 'candidate-1', action: 'onboarding.jamie',
    reason: 'Candidate asked to wait', sourceEventId: 'hold-event' };
  const h = await f.store.setActionHold(holdInput);
  const repeat = await f.store.setActionHold(holdInput);
  assert.equal(repeat.changed, false); assert.equal(repeat.control.version, h.control.version);
  await f.store.ensureRequest(input());
  await f.store.ensureRequest(input('other-action', { action: 'payment.project' }));
  assert.equal((await f.store.claimRequest(claim('request-1', h.control))).claimed, false);
  assert.equal((await f.store.claimRequest(claim('other-action', h.control))).claimed, true);
  assert.equal((await f.store.releaseActionHold({ holdKey: 'hold-1', expectedVersion: 0, sourceEventId: 'release-event' })).changed, false);
  const release = await f.store.releaseActionHold({ holdKey: 'hold-1', expectedVersion: h.hold.version, sourceEventId: 'release-event' });
  assert.equal(release.changed, true);
  assert.equal((await f.store.claimRequest(claim('request-1', release.control, 'after-release'))).claimed, true);
});

test('hold after claim blocks dispatch and failed hold batch rolls back control mutation', async () => {
  const f = fixture(); const c = await live(f.store);
  await f.store.ensureRequest(input()); await f.store.claimRequest(claim('request-1', c));
  await assert.rejects(() => f.store.setActionHold({ holdKey: 'missing-source', candidateId: 'candidate-1', action: 'onboarding.jamie',
    reason: 'Hold', sourceEventId: 'does-not-exist' }), /FOREIGN KEY/);
  assert.equal((await f.store.getControl()).version, c.version);
  await f.store.recordEvent(slack());
  await f.store.setActionHold({ holdKey: 'valid', candidateId: 'candidate-1', action: 'onboarding.jamie', reason: 'Wait', sourceEventId: 'event-1' });
  assert.equal((await f.store.authorizeDispatch({ requestKey: 'request-1', claimToken: 'attempt-1' })).allowed, false);
});

test('Off, historical baseline and old triggers cannot claim; Test only simulates fixtures', async () => {
  const f = fixture(); const c = await f.store.getControl();
  await f.store.ensureRequest(input());
  assert.equal((await f.store.claimRequest(claim('request-1', c))).claimed, false);
  const testing = (await f.store.updateControl({ expectedVersion: c.version, mode: 'Test' })).control;
  assert.equal((await f.store.claimRequest(claim('request-1', testing))).claimed, false);
  await f.store.ensureRequest(input('fixture', { isFixture: true }));
  assert.equal((await f.store.claimRequest(claim('fixture', testing))).dryRun, true);
  assert.equal((await f.store.authorizeDispatch({ requestKey: 'fixture', claimToken: 'attempt-1' })).allowed, false);
  assert.equal((await f.store.markSimulated({ requestKey: 'fixture', claimToken: 'attempt-1', result: 'would send' })).updated, true);
  const active = await live(f.store);
  await f.store.ensureRequest(input('baseline', { baselined: true }));
  await f.store.ensureRequest(input('old', { triggerAt: START - 1 }));
  await f.store.ensureRequest(input('future', { dueAt: START + 1 }));
  for (const key of ['baseline', 'old', 'future', 'fixture']) assert.equal((await f.store.claimRequest(claim(key, active))).claimed, false);
});

test('event wake claims deduplicate concurrent retries and never re-create an uncertain page', async () => {
  const f = fixture(); await live(f.store); await f.store.recordEvent(slack());
  const claims = await Promise.all([f.store.claimEventWake({ eventId: 'event-1', attemptId: 'wake-a' }),
    f.restart().claimEventWake({ eventId: 'event-1', attemptId: 'wake-b' })]);
  assert.equal(claims.filter(c => c.claimed).length, 1);
  const event = await f.store.getEvent('event-1');
  assert.equal((await f.store.authorizeEventWake({ eventId: 'event-1', attemptId: event.wakeAttemptId })).allowed, true);
  await f.store.markWakeUncertain({ eventId: 'event-1', attemptId: event.wakeAttemptId, reason: 'Create timed out' });
  assert.equal((await f.store.listWakePendingEvents()).length, 0);
  assert.equal((await f.restart().claimEventWake({ eventId: 'event-1', attemptId: 'retry' })).claimed, false);
  assert.equal((await f.store.releaseEventWake({ eventId: 'event-1', attemptId: event.wakeAttemptId, preCreateFailure: true, reason: 'Not valid for uncertain' })).updated, false);
  assert.equal((await f.store.markEventNotionWake({ eventId: 'event-1', attemptId: event.wakeAttemptId, pageId: 'reconciled-page' })).recorded, true);
  assert.equal((await f.store.getEvent('event-1')).wakeState, 'Complete');
});

test('wake pause prevents stale creation; only proven pre-create failure releases a claim', async () => {
  const f = fixture(); const c = await live(f.store); await f.store.recordEvent(slack());
  await f.store.claimEventWake({ eventId: 'event-1', attemptId: 'wake-a' });
  await f.store.updateControl({ expectedVersion: c.version, mode: 'Off' });
  assert.equal((await f.store.authorizeEventWake({ eventId: 'event-1', attemptId: 'wake-a' })).allowed, false);
  await assert.rejects(() => f.store.releaseEventWake({ eventId: 'event-1', attemptId: 'wake-a', reason: 'failure' }), /pre-create/);
  assert.equal((await f.store.releaseEventWake({ eventId: 'event-1', attemptId: 'wake-a', reason: 'Paused before request', preCreateFailure: true })).updated, true);
  assert.equal((await f.store.claimEventWake({ eventId: 'event-1', attemptId: 'wake-b' })).claimed, false);
});

test('event acknowledgment, wake metadata, fixture provenance and bounded recovery lists persist', async () => {
  const f = fixture(); const control = await f.store.getControl();
  await f.store.updateControl({ expectedVersion: control.version, mode: 'Test' });
  await f.store.recordEvent({ ...slack('untrusted'), payload: { isFixture: true, text: 'not trusted fixture' } });
  assert.equal((await f.store.getEvent('untrusted')).isFixture, false);
  assert.equal((await f.store.claimEventWake({ eventId: 'untrusted', attemptId: 'x' })).claimed, false);
  await f.store.recordEvent(slack('trusted', { isFixture: true }));
  assert.equal((await f.store.claimEventWake({ eventId: 'trusted', attemptId: 'x' })).claimed, true);
  assert.equal((await f.store.markEventNotionWake({ eventId: 'trusted', attemptId: 'x', pageId: 'notion-page' })).recorded, true);
  assert.equal((await f.store.listWakePendingEvents()).some(e => e.eventId === 'trusted'), false);
  await f.store.markEventProcessed({ eventId: 'trusted', receipt: { action: 'fixture checked', resultId: 'receipt-1' } });
  assert.equal((await f.restart().getEvent('trusted')).receipt.resultId, 'receipt-1');
  assert.equal((await f.store.listUnprocessedEvents()).some(e => e.eventId === 'trusted'), false);
  for (let i = 0; i < 55; i++) await f.store.recordEvent(slack(`more-${i}`));
  assert.equal((await f.store.listUnprocessedEvents({ limit: 100 })).length, 50);
  assert.equal((await f.store.listWakePendingEvents({ limit: 100 })).length, 50);
});

const amendment = (id = 'edit-1', overrides = {}) => slack(id, {
  type: 'source_amendment', amendment: 'message_changed',
  targetMessageTs: String(START / 1000) + '.123456', messageTs: String(START / 1000 + 60) + '.000001',
  text: 'wait', ...overrides,
});
test('first candidate thread has one durable owner and Jamie/AA routes remain separate', async () => {
  const f = fixture(); const c = await live(f.store);
  await f.store.ensureRequest(input('first'));
  await f.store.ensureRequest(input('racing'));
  const scope = { candidateId: 'candidate-1', routeKey: 'jamie_group', channelId: 'GJAMIE' };
  const results = await Promise.all(['first', 'racing'].map(requestKey =>
    f.store.reserveCandidateThread({ ...scope, requestKey })));
  assert.equal(results.filter(r => r.verified).length, 1);
  const owner = results.find(r => r.verified).ownerRequestKey;
  const other = owner === 'first' ? 'racing' : 'first';
  assert.equal((await f.restart().reserveCandidateThread({ ...scope, requestKey: other })).verified, false);
  await f.store.claimRequest(claim(owner, c));
  assert.equal((await f.store.saveCandidateThread({ ...scope, requestKey: owner, ownerRequestKey: owner,
    previousThreadTs: null, threadTs: '1791948000.000001', verified: true })).verified, true);
  assert.equal((await f.restart().reserveCandidateThread({ ...scope, requestKey: other })).threadTs, '1791948000.000001');
  assert.equal((await f.store.reserveCandidateThread({ ...scope, channelId: 'GCHANGED', requestKey: other })).verified, false);
  const aa = await f.store.reserveCandidateThread({ ...scope, requestKey: other, routeKey: 'aa_group', channelId: 'GAA' });
  assert.equal(aa.verified, true); assert.equal(aa.threadTs, null);
  await assert.rejects(() => f.store.saveCandidateThread({ ...scope, requestKey: owner, ownerRequestKey: owner,
    previousThreadTs: null, threadTs: '1791948000.000001' }), /Verified/);
  assert.equal((await f.store.saveCandidateThread({ ...scope, requestKey: owner, ownerRequestKey: owner,
    previousThreadTs: '1791948000.000001', threadTs: '1791948000.000002', verified: true })).verified, false);
});
test('source edit after a claim blocks dispatch after restart and preserves genuine receipts', async () => {
  const f = fixture(); const c = await live(f.store);
  await f.store.recordEvent(slack());
  await f.store.ensureRequest(input('changed', { sourceEventId: 'event-1' }));
  await f.store.claimRequest(claim('changed', c));
  assert.equal((await f.store.authorizeDispatch({ requestKey: 'changed', claimToken: 'attempt-1' })).allowed, true);
  await f.store.recordEvent(amendment());
  assert.equal((await f.restart().authorizeDispatch({ requestKey: 'changed', claimToken: 'attempt-1' })).allowed, false);
  await f.store.completeRequest({ requestKey: 'changed', claimToken: 'attempt-1',
    receipt: { verified: true, resultId: 'actual-in-flight-message' } });
  assert.equal((await f.store.getRequest('changed')).state, 'Sent');
});

test('out-of-order delete blocks future reliance on the original and duplicate observations stay harmless', async () => {
  const f = fixture(); const c = await live(f.store);
  await f.store.recordEvent(amendment('delete-1', { amendment: 'message_deleted', authorId: null, text: '' }));
  await f.store.recordEvent(slack());
  await f.store.ensureRequest(input('late', { sourceEventId: 'event-1' }));
  assert.equal((await f.store.claimRequest(claim('late', c))).claimed, false);
  assert.equal((await f.store.recordEvent(amendment('delete-1'))).created, false);
});

test('source invalidation requires the same app, workspace, conversation and message', async () => {
  for (const changed of [{ appId: 'OTHERAPP' }, { teamId: 'OTHERTEAM' }, { channelId: 'GOTHER' },
    { targetMessageTs: String(START / 1000) + '.999999' }, { isFixture: true }]) {
    const f = fixture(); const c = await live(f.store);
    await f.store.recordEvent(slack()); await f.store.recordEvent(amendment('edit-1', changed));
    await f.store.ensureRequest(input('valid', { sourceEventId: 'event-1' }));
    assert.equal((await f.store.claimRequest(claim('valid', c))).claimed, true);
  }
});
