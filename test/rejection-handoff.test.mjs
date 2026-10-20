import test from 'node:test';
import assert from 'node:assert/strict';
import { createRejectionHandoff, REJECTION_SENDER } from '../service/lib/rejection-handoff.mjs';

const PAGE = '11111111-2222-4333-8444-555555555555';
const OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const EMAIL = 'fixture@example.test';
const NOW = Date.parse('2026-10-14T04:00:00Z');
const EVENT = 'EvREJECTION';
const SOURCE = 'https://example-workspace.slack.com/archives/DTEST/p1791949940000000';
const clone = value => structuredClone(value);
function evidence(kind = 'rejection') {
  return { eventId: EVENT, kind, current: true, sourceAccessVerified: true, isFixture: false,
    historical: false, requestKey: 'candidate-occurrence-rejection', revision: 'decision-1',
    candidate: { pageId: PAGE, fullName: 'Fixture Person', email: EMAIL, emailVerified: true },
    occurredAt: '2026-10-14T03:59:00Z', authorId: 'U0A4F08721B', sourceUrl: SOURCE,
    priorSendVerified: false, conflictingAuthority: false, hold: false,
    occurrenceId: 'interview-1', contextId: 'candidate-thread-1',
    explicitHold: kind === 'hold', candidateScopeVerified: true,
    confirmation: { affirmative: true, current: true, superseded: false, action: 'reject',
      authorId: 'U0A4F08721B', candidatePageId: PAGE, candidateEmail: EMAIL,
      occurrenceId: 'interview-1', contextId: 'candidate-thread-1', revision: 'decision-1',
      sourceUrl: SOURCE, sourceEventId: EVENT, confirmedAt: '2026-10-14T03:59:00Z' },
    latestInterviewEnd: { verified: true, actuallyCompleted: true, isLatest: true,
      laterInterviewUnresolved: false, candidatePageId: PAGE, candidateEmail: EMAIL,
      occurrenceId: 'interview-1', sourceUrl: SOURCE, at: '2026-10-13T12:00:00Z' } };
}
const controls = () => Object.fromEntries(['runtime', 'notion'].map(key => [key,
  { mode: 'Live', baselineComplete: true, connectionsReady: true, activatedAt: '2026-10-14T03:00:00Z' }]));
const candidate = () => ({ pageId: PAGE, email: EMAIL, archived: false, isFixture: false,
  outcome: 'Proceeding', priorSendVerified: false, rejection: { status: null, hold: false } });
const receipt = () => ({ source: REJECTION_SENDER, readbackVerified: true, candidatePageId: PAGE,
  status: 'Scheduled', queuedTo: EMAIL, decisionKey: `${PAGE}|2026-10-14T04:00:00Z`,
  decisionAt: '2026-10-14T04:00:00Z', scheduledFor: '2026-10-14T12:00:00Z', hold: false,
  genuineEvent: { type: 'outcome_change', candidatePageId: PAGE, beforeOutcome: 'Proceeding',
    afterOutcome: 'Not Selected', occurredAt: '2026-10-14T04:00:00Z' } });

function harness(options = {}) {
  const calls = [], mutations = [], uncertain = [];
  let saved, state = 'new', reads = 0, resolves = 0, controlReads = 0;
  const data = { candidate: candidate(), evidence: evidence(options.kind), receipt: receipt(), controls: controls(), ...options.data };
  const deps = {
    env: { UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled' }, clock: () => NOW, timeoutMs: 50,
    resolveEvidence: async args => { assert.equal(args.eventId, EVENT); options.onResolve?.(data, ++resolves); return clone(data.evidence); },
    readControls: async () => { options.onControls?.(data, ++controlReads); return clone(data.controls); },
    readCandidate: async args => { assert.equal(args.candidatePageId, PAGE); options.onRead?.(data, ++reads); return clone(data.candidate); },
    claim: async () => { if (state !== 'new') return { claimed: false }; state = 'claimed'; return { claimed: true }; },
    authorizeClaim: async () => ({ allowed: state === 'claimed' }),
    appendEvidence: async args => { mutations.push({ type: 'evidence', evidence: clone(args.evidence) }); saved = clone(args.evidence); },
    readEvidence: async () => ({ evidence: saved }),
    patchCandidate: async args => {
      mutations.push({ type: 'patch', properties: clone(args.properties) });
      options.onPatch?.(data, args.properties);
      if ('Outcome' in args.properties) data.candidate.outcome = args.properties.Outcome;
      if ('Rejection email hold' in args.properties) data.candidate.rejection.hold = args.properties['Rejection email hold'];
      if ('Last interview ended at' in args.properties) data.candidate.lastInterviewEndedAt = args.properties['Last interview ended at'];
      if ('Interview timing source' in args.properties) data.candidate.interviewTimingSource = args.properties['Interview timing source'];
    },
    readSenderReceipt: async () => clone(data.receipt),
    finishClaim: async () => { state = 'complete'; return { recorded: true }; },
    markUncertain: async args => { state = 'uncertain'; uncertain.push(args); return { recorded: true }; },
    ...options.deps,
  };
  for (const [key, fn] of Object.entries(deps)) if (typeof fn === 'function' && key !== 'clock') {
    deps[key] = async args => { calls.push(key); assert.ok(args.signal instanceof AbortSignal); return fn(args); };
  }
  return { data, deps, calls, mutations, uncertain, service: createRejectionHandoff(deps),
    input: { eventId: EVENT, attemptId: 'attempt-1' } };
}

test('global off and explicit dry run call no adapters and do not validate delivery', async () => {
  for (const enabled of [undefined, 'off', 'true', 'Live']) {
    const h = harness({ deps: { env: { UNCLE_SAM_AUTOMATIC_ACTIVITY: enabled } } });
    assert.equal((await h.service.handoff(h.input)).reason, 'automatic_activity_disabled');
    assert.equal(h.calls.length, 0);
  }
  const h = harness();
  for (const action of ['hold', 'handoff']) {
    assert.deepEqual(await h.service[action]({ ...h.input, dryRun: true }), {
      status: 'dry_run', validated: false, executed: false, sender: REJECTION_SENDER,
      sendsEmail: false, reason: 'no_adapters_called',
    });
  }
  assert.equal(h.calls.length, 0);
});

test('persisted decision evidence and timing readback precede Outcome; queue belongs to existing sender', async () => {
  const h = harness();
  const result = await h.service.handoff({ ...h.input, candidate: { pageId: OTHER }, hold: false });
  assert.equal(result.status, 'scheduled');
  assert.equal(result.sendsEmail, false);
  assert.equal(result.outcomeCommitted, true);
  assert.equal(h.mutations.length, 3);
  assert.equal(h.mutations[0].type, 'evidence');
  assert.deepEqual(h.mutations[1].properties, {
    'Last interview ended at': '2026-10-13T12:00:00.000Z', 'Interview timing source': SOURCE,
  });
  assert.deepEqual(h.mutations[2].properties, { Outcome: 'Not Selected' });
  assert.ok(h.calls.indexOf('readEvidence') < h.calls.indexOf('patchCandidate'));
  assert.equal(h.mutations.some(m => Object.keys(m.properties ?? {}).some(k => /scheduled|queued|status|sent/i.test(k))), false);
});

test('unscoped yes, wrong authority, missing source access and unresolved interview fail before mutation', async () => {
  for (const mutate of [
    d => { d.evidence.confirmation.candidatePageId = OTHER; },
    d => { d.evidence.confirmation.contextId = 'unrelated-thread'; },
    d => { d.evidence.confirmation.authorId = 'U0CB213D6D6'; },
    d => { d.evidence.sourceAccessVerified = false; },
    d => { d.evidence.confirmation.sourceEventId = 'unrelated-event'; },
    d => { d.evidence.latestInterviewEnd.actuallyCompleted = false; },
    d => { d.evidence.latestInterviewEnd.laterInterviewUnresolved = true; },
    d => { d.evidence.latestInterviewEnd.at = '2026-10-13'; },
    d => { d.evidence.latestInterviewEnd.at = '2026-10-14T05:00:00Z'; },
    d => { d.evidence.confirmation.superseded = true; },
    d => { d.evidence.priorSendVerified = true; },
  ]) {
    const h = harness(); mutate(h.data);
    assert.equal((await h.service.handoff(h.input)).status, 'blocked');
    assert.equal(h.mutations.length, 0);
  }
});

test('fixtures, historical events, incomplete baseline and either paused control block all effects', async () => {
  for (const mutate of [
    d => { d.evidence.isFixture = true; }, d => { d.evidence.historical = true; },
    d => { d.controls.notion.mode = 'Off'; }, d => { d.controls.runtime.mode = 'Test'; },
    d => { d.controls.notion.baselineComplete = false; },
    d => { d.controls.runtime.activatedAt = '2026-10-14T04:00:00Z'; },
    d => { d.controls.runtime.connectionsReady = false; },
  ]) {
    const h = harness(); mutate(h.data);
    assert.equal((await h.service.handoff(h.input)).status, 'blocked');
    assert.equal(h.calls.includes('claim'), false);
    assert.equal(h.mutations.length, 0);
  }
});

test('current holds, sent or uncertain attempts, withdrawals and recipient changes cannot reject', async () => {
  for (const mutate of [
    d => { d.candidate.rejection.hold = true; }, d => { d.candidate.rejection.hold = undefined; },
    d => { d.candidate.rejection.status = 'Sent'; }, d => { d.candidate.rejection.status = 'Sending'; },
    d => { d.candidate.rejection.status = 'Needs attention'; }, d => { d.candidate.rejection.status = 'Cancelled'; },
    d => { d.candidate.rejection.status = 'Historical - no auto-send'; },
    d => { d.candidate.outcome = 'Withdrawn or Unavailable'; },
    d => { d.candidate.email = 'namesake@example.test'; },
  ]) {
    const h = harness(); mutate(h.data);
    assert.equal((await h.service.handoff(h.input)).status, 'blocked');
    assert.equal(h.mutations.length, 0);
  }
});

test('later hold or changed source before Outcome stops the handoff and retains a reconciliation receipt', async () => {
  const laterHold = harness({ onRead: (d, count) => { if (count === 4) d.candidate.rejection.hold = true; } });
  assert.equal((await laterHold.service.handoff(laterHold.input)).reason, 'current_hold');
  assert.equal(laterHold.mutations.some(m => m.properties?.Outcome), false);
  assert.equal(laterHold.uncertain.length, 1);
  const changed = harness({ onResolve: (d, count) => { if (count === 3) d.evidence.revision = 'superseded'; } });
  assert.equal((await changed.service.handoff(changed.input)).status, 'needs_attention');
  assert.equal(changed.mutations.some(m => m.properties?.Outcome), false);
});

test('pause after evidence persistence stops subsequent candidate writes', async () => {
  const h = harness({ onControls: (d, count) => { if (count === 3) d.controls.notion.mode = 'Off'; } });
  assert.equal((await h.service.handoff(h.input)).reason, 'notion_not_live');
  assert.equal(h.mutations.length, 1);
  assert.equal(h.mutations[0].type, 'evidence');
});

test('failed evidence or timing readback prevents Outcome transition', async () => {
  const h = harness({ deps: { readEvidence: async () => ({ evidence: {} }) } });
  assert.equal((await h.service.handoff(h.input)).reason, 'evidence_readback_failed');
  assert.equal(h.mutations.some(m => m.type === 'patch'), false);
  const timing = harness({ onRead: (d, count) => { if (count === 4) d.candidate.lastInterviewEndedAt = null; } });
  assert.equal((await timing.service.handoff(timing.input)).reason, 'timing_readback_failed');
  assert.equal(timing.mutations.some(m => m.properties?.Outcome), false);
});

test('precision is rounded upward before it reaches the sender', async () => {
  const h = harness();
  h.data.evidence.latestInterviewEnd.at = '2026-10-13T12:00:00.001Z';
  h.data.receipt.scheduledFor = '2026-10-14T12:01:00Z';
  assert.equal((await h.service.handoff(h.input)).status, 'scheduled');
  assert.equal(h.mutations[1].properties['Last interview ended at'], '2026-10-13T12:01:00.000Z');
});

test('minute-only and declared precision use conservative confirmation boundaries', async () => {
  for (const minuteOnly of [true, false]) {
    const h = harness({ deps: { clock: () => Date.parse('2026-10-14T03:59:30Z') } });
    if (minuteOnly) {
      h.data.evidence.occurredAt = '2026-10-14T03:59Z';
      h.data.evidence.confirmation.confirmedAt = '2026-10-14T03:59Z';
    } else {
      h.data.evidence.occurredAtPrecision = 'minute';
      h.data.evidence.confirmation.precision = 'minute';
    }
    assert.equal((await h.service.handoff(h.input)).reason, 'future_evidence');
    assert.equal(h.mutations.length, 0);
  }
});

test('sender cannot use an early deadline from truncated event time or ignore saved interview rounding', async () => {
  const h = harness();
  h.data.evidence.occurredAt = '2026-10-14T03:58:00Z';
  h.data.evidence.confirmation.confirmedAt = '2026-10-14T03:58:00Z';
  h.data.evidence.latestInterviewEnd.at = '2026-10-12T12:00:00Z';
  h.data.receipt.genuineEvent.occurredAt = '2026-10-14T03:59Z';
  h.data.receipt.decisionKey = `${PAGE}|2026-10-14T03:59Z`;
  h.data.receipt.scheduledFor = '2026-10-14T03:59:59Z';
  assert.equal((await h.service.handoff(h.input)).reason, 'sender_deadline_too_early');
  const rounded = harness();
  rounded.data.evidence.latestInterviewEnd.at = '2026-10-13T12:00:00.001Z';
  rounded.data.receipt.scheduledFor = '2026-10-14T12:00:30Z';
  assert.equal((await rounded.service.handoff(rounded.input)).reason, 'sender_deadline_too_early');
});

test('newer timing on the current candidate cannot be overwritten with earlier evidence', async () => {
  const h = harness(); h.data.candidate.lastInterviewEndedAt = '2026-10-13T16:00:00Z';
  assert.equal((await h.service.handoff(h.input)).reason, 'current_interview_timing_conflict');
  assert.equal(h.mutations.length, 0);
});

test('hosted activity kill switch changing after evidence stops the Outcome trigger', async () => {
  const h = harness({ deps: { readEvidence: async args => {
    h.deps.env.UNCLE_SAM_AUTOMATIC_ACTIVITY = 'off';
    return { evidence: h.mutations[0].evidence };
  } } });
  assert.equal((await h.service.handoff(h.input)).reason, 'automatic_activity_disabled');
  assert.equal(h.mutations.some(m => m.type === 'patch'), false);
});

test('existing Not Selected reuses verified sender state without manufacturing another Outcome event', async () => {
  const h = harness(); h.data.candidate.outcome = 'Not Selected'; h.data.candidate.rejection.status = 'Scheduled';
  const result = await h.service.handoff(h.input);
  assert.equal(result.reused, true);
  assert.equal(result.outcomeCommitted, false);
  assert.equal(result.status, 'scheduled');
  assert.equal(h.mutations.length, 0);
});

test('Scheduled without genuine event, wrong queued recipient or early deadline is never called scheduled', async () => {
  for (const mutate of [
    d => { delete d.receipt.genuineEvent; }, d => { d.receipt.queuedTo = 'wrong@example.test'; },
    d => { d.receipt.decisionKey = 'invented'; }, d => { d.receipt.scheduledFor = '2026-10-14T11:59:59Z'; },
    d => { d.receipt.readbackVerified = false; }, d => { d.receipt.genuineEvent.beforeOutcome = 'Not Selected'; },
  ]) {
    const h = harness(); mutate(h.data);
    const result = await h.service.handoff(h.input);
    assert.equal(result.status, 'needs_attention');
    assert.equal(result.outcomeCommitted, true);
    assert.equal(h.uncertain.length, 1);
  }
});

test('sender Needs attention is reported faithfully without inventing queue state', async () => {
  const h = harness(); h.data.receipt.status = 'Needs attention'; delete h.data.receipt.genuineEvent;
  const result = await h.service.handoff(h.input);
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.reason, 'existing_sender_needs_attention');
  assert.equal('scheduledFor' in result, false);
});

test('Sent requires exact verified Gmail evidence and never invokes a send adapter', async () => {
  const h = harness();
  h.data.evidence.latestInterviewEnd.at = '2026-10-13T02:00:00Z';
  h.data.receipt.scheduledFor = '2026-10-14T04:00:00Z';
  h.data.receipt.status = 'Sent';
  h.data.receipt.sent = { verified: true, from: 'project@company.example', to: EMAIL, cc: [], bcc: [],
    at: '2026-10-14T04:00:00Z', messageUrl: 'https://mail.google.com/mail/u/0/#sent/fixture' };
  assert.equal((await h.service.handoff(h.input)).status, 'sent');
  const invalid = harness({ data: clone(h.data) }); invalid.data.candidate.outcome = 'Proceeding';
  invalid.data.receipt.sent.verified = false;
  assert.equal((await invalid.service.handoff(invalid.input)).reason, 'sender_sent_evidence_unverified');
});

test('hold writes only true immediately, preserves Sent evidence, and then records its source', async () => {
  const h = harness({ kind: 'hold' });
  h.data.candidate.rejection = { hold: false, status: 'Sent', sentAt: '2026-10-13T20:00:00Z',
    messageUrl: 'https://mail.google.com/mail/u/0/#sent/prior', attempt: 'prior' };
  const prior = clone(h.data.candidate.rejection);
  const result = await h.service.hold(h.input);
  assert.equal(result.status, 'held'); assert.equal(result.deliveryAlreadySent, true);
  assert.deepEqual(h.mutations[0], { type: 'patch', properties: { 'Rejection email hold': true } });
  assert.equal(h.mutations[1].type, 'evidence');
  assert.deepEqual(h.data.candidate.rejection, { ...prior, hold: true });
});

test('missing exact hold scope cannot patch; sender-held queue is reported held', async () => {
  const bad = harness({ kind: 'hold' }); bad.data.evidence.candidateScopeVerified = false;
  assert.equal((await bad.service.hold(bad.input)).reason, 'exact_hold_required');
  assert.equal(bad.mutations.length, 0);
  const h = harness(); h.data.receipt.hold = true;
  assert.equal((await h.service.handoff(h.input)).status, 'held');
});

test('concurrent duplicate events own one handoff and complete claims cannot be replayed', async () => {
  const h = harness();
  const results = await Promise.all([h.service.handoff(h.input),
    h.service.handoff({ ...h.input, attemptId: 'attempt-2' })]);
  assert.equal(results.filter(r => r.status === 'scheduled').length, 1);
  assert.equal(h.mutations.filter(m => m.properties?.Outcome).length, 1);
  assert.equal((await h.service.handoff({ ...h.input, attemptId: 'attempt-3' })).reason, 'handoff_not_claimable');
});

test('uncertain write timeout is durable, redacted, bounded and never automatically retried', async () => {
  const h = harness({ deps: { timeoutMs: 5, patchCandidate: async () => new Promise(() => {}) } });
  const result = await h.service.handoff(h.input);
  assert.equal(result.status, 'needs_attention'); assert.equal(result.reason, 'adapter_timeout');
  assert.equal(result.uncertaintyRecorded, true); assert.equal(result.writesMayHaveCompleted, true);
  const callsBefore = h.calls.filter(v => v === 'patchCandidate').length;
  assert.equal((await h.service.handoff({ ...h.input, attemptId: 'retry' })).reason, 'handoff_not_claimable');
  assert.equal(h.calls.filter(v => v === 'patchCandidate').length, callsBefore);
  const secret = harness({ deps: { appendEvidence: async () => { throw new Error('secret-token-value'); } } });
  assert.equal(JSON.stringify(await secret.service.handoff(secret.input)).includes('secret-token-value'), false);
});
