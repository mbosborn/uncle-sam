import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalCandidate, canonicalPageId, requestKey, instantMs, localDate, nextCalendarDate,
  modeGate, validateScopedConfirmation, evaluateTrialAuthorization, evaluateOnboardingReadiness,
  evaluateOffboarding, evaluateRejectionEligibility, SLACK_IDS, REQUIRED_TRIAL_DOCUMENTS,
} from '../src/policy.mjs';

const candidate = Object.freeze({ pageId: '11111111-2222-3333-4444-555555555555',
  fullName: 'Reagan Turner', email: 'reagan.one@example.com', emailVerified: true });
const secondSumit = Object.freeze({ ...candidate, pageId: '11111111-2222-3333-4444-666666666666',
  email: 'reagan.two@example.com' });
const occurrenceId = 'trial:instruction:1791830000.123456';
const scoped = { candidatePageId: candidate.pageId, candidateEmail: candidate.email, occurrenceId };
const confirmation = Object.freeze({ ...scoped, action: 'reject', revision: '2', contextId: 'DTEST:123.456',
  authorId: SLACK_IDS.robin, affirmative: true, sourceUrl: 'https://example.com/confirmation',
  confirmedAt: '2026-10-13T11:00:00Z' });
const confirmationInput = { candidate, occurrenceId, action: 'reject', revision: '2',
  contextId: 'DTEST:123.456', confirmation };
const instruction = Object.freeze({ ...scoped, action: 'work_trial', explicit: true, current: true,
  authorId: SLACK_IDS.robin, sourceUrl: 'https://example.com/trial', occurredAt: '2026-10-13T10:00:00Z' });
const dates = Object.freeze({ ...scoped, start: '2026-10-14', end: '2026-10-16', timeZone: 'America/Los_Angeles',
  candidateAgreed: true, agreementSourceUrl: 'https://example.com/agreed' });
const trial = { candidate, occurrenceId, instruction, dates };
const authorized = evaluateTrialAuthorization(trial);
const rejection = { ...confirmationInput, decisionAt: '2026-10-13T11:00:00Z',
  latestInterviewEnd: { ...scoped, at: '2026-10-13T10:00:00Z', verified: true, actuallyCompleted: true,
    isLatest: true, sourceUrl: 'https://example.com/actual-end' },
  now: '2026-10-14T10:00:00Z', outcome: 'Not Selected', sourceAccessVerified: true };
const offboarding = { candidate, occurrenceId, latestConfirmedEnd: '2026-10-16',
  timeZone: 'America/Los_Angeles', endEvidenceUrl: 'https://example.com/end', latestStateVerified: true,
  now: '2026-10-17T07:00:00Z' };

test('canonical IDs preserve identity across formatting; names never establish identity', () => {
  assert.equal(canonicalPageId('11111111222233334444555555555555'), candidate.pageId);
  assert.deepEqual(canonicalCandidate(candidate), candidate);
  for (const patch of [{ pageId: undefined }, { email: undefined }, { emailVerified: false }, { fullName: '' }]) {
    assert.throws(() => canonicalCandidate({ ...candidate, ...patch }));
  }
  assert.throws(() => canonicalPageId('Reagan Turner'));
});

test('request key survives restarts, duplicate sources, recipient ordering and policy changes', () => {
  const request = { candidate, occurrenceId, action: 'onboarding.request', recipientIds: [SLACK_IDS.project, SLACK_IDS.jamie] };
  const original = requestKey(request);
  const restarted = JSON.parse(JSON.stringify(request));
  assert.equal(original, requestKey({ ...restarted, recipientIds: [SLACK_IDS.jamie, SLACK_IDS.project, SLACK_IDS.jamie],
    sourceEventId: 'another-channel', policyVersion: '99' }));
  assert.equal(original, requestKey({ ...request, candidate: { ...candidate, pageId: candidate.pageId.replaceAll('-', '') } }));
  for (const patch of [{ candidate: secondSumit }, { occurrenceId: 'second-trial' },
    { action: 'offboarding.request' }, { recipientIds: [SLACK_IDS.aa] }]) {
    assert.notEqual(original, requestKey({ ...request, ...patch }));
  }
  assert.throws(() => requestKey({ ...request, recipientIds: [] }));
  assert.throws(() => requestKey({ ...request, occurrenceId: '' }));
});

test('mode gates require fixtures in Test and baseline plus current event and routes in Live', () => {
  assert.equal(modeGate({ mode: 'Off' }).allowed, false);
  assert.equal(modeGate({ mode: 'Test' }).reason, 'test_requires_fixture');
  assert.deepEqual(modeGate({ mode: 'Test', isFixture: true }),
    { allowed: true, reason: null, dryRun: true, liveActionsAllowed: false });
  const live = { mode: 'Live', baselineComplete: true, activatedAt: '2026-10-13T10:00:00Z',
    eventOccurredAt: '2026-10-13T10:00:00Z', connectionsReady: true, routingReady: true };
  assert.equal(modeGate(live).allowed, true);
  for (const patch of [{ baselineComplete: false }, { isFixture: true }, { baselined: true },
    { routingReady: false }, { connectionsReady: false }, { activatedAt: null },
    { eventOccurredAt: '2026-10-13T09:59:59Z' }]) assert.equal(modeGate({ ...live, ...patch }).allowed, false);
});

test('only current, candidate-specific Robin/Alexis scoped confirmation authorizes', () => {
  assert.equal(validateScopedConfirmation(confirmationInput).allowed, true);
  assert.equal(validateScopedConfirmation({ ...confirmationInput,
    confirmation: { ...confirmation, authorId: SLACK_IDS.alexis } }).allowed, true);
  for (const patch of [{ authorId: SLACK_IDS.aa }, { affirmative: false }, { superseded: true },
    { revision: '1' }, { contextId: 'another-thread' }, { occurrenceId: 'previous-round' },
    { candidatePageId: secondSumit.pageId }, { candidateEmail: secondSumit.email },
    { action: 'take_home' }, { sourceUrl: '' }, { confirmedAt: '2026-10-13' }]) {
    assert.equal(validateScopedConfirmation({ ...confirmationInput, confirmation: { ...confirmation, ...patch } }).allowed, false);
  }
  assert.equal(validateScopedConfirmation({ ...confirmationInput, hold: true }).reason, 'hold');
  assert.equal(validateScopedConfirmation({ ...confirmationInput, conflictingAuthority: true }).allowed, false);
});

test('only explicit Robin trial instruction advances; dates and hold gate setup separately', () => {
  assert.equal(authorized.stageAllowed, true);
  assert.equal(authorized.onboardingAllowed, true);
  for (const authorId of [SLACK_IDS.alexis, SLACK_IDS.aa, SLACK_IDS.jamie]) {
    assert.equal(evaluateTrialAuthorization({ ...trial, instruction: { ...instruction, authorId } }).stageAllowed, false);
  }
  assert.equal(evaluateTrialAuthorization({ ...trial, instruction: { ...instruction, explicit: false }, score: 100 }).stageAllowed, false);
  assert.equal(evaluateTrialAuthorization({ ...trial, candidate: secondSumit }).stageAllowed, false);
  for (const dates of [undefined, { ...trial.dates, candidateAgreed: false }, { ...trial.dates, end: null }]) {
    const result = evaluateTrialAuthorization({ ...trial, dates });
    assert.equal(result.stageAllowed, true);
    assert.equal(result.onboardingAllowed, false);
  }
  const held = evaluateTrialAuthorization({ ...trial, hold: true, holdReason: 'Candidate finishing current contract' });
  assert.equal(held.stageAllowed, true);
  assert.equal(held.onboardingAllowed, false);
  assert.equal(held.holdReason, 'Candidate finishing current contract');
  assert.equal(evaluateTrialAuthorization({ ...trial, dates: { ...dates, start: '2026-02-30' } }).onboardingAllowed, false);
  assert.equal(evaluateTrialAuthorization({ ...trial, dates: { ...dates, start: '2026-10-17' } }).onboardingAllowed, false);
  assert.equal(evaluateTrialAuthorization({ ...trial, cancelled: true }).stageAllowed, false);
});

test('packet sent and individual ready responses do not imply signed or combined completion', () => {
  const ready = { candidate, occurrenceId, authorization: authorized, packetSent: true,
    signedDocuments: REQUIRED_TRIAL_DOCUMENTS, jamieReady: true, aaReady: true };
  assert.equal(evaluateOnboardingReadiness(ready).allowed, true);
  const done = evaluateOnboardingReadiness({ candidate, occurrenceId, authorization: authorized, packetSent: true });
  assert.equal(done.allowed, false);
  assert.equal(done.pending.length, 6);
  for (const patch of [{ signedDocuments: ['nda', 'ciiaa', 'terms_of_work'] },
    { signedDocuments: ['nda', 'nda', 'nda', 'nda'] }, { jamieReady: false }, { aaReady: false },
    { hold: true }, { cancelled: true }, { combinedNoticeSent: true }, { candidate: secondSumit },
    { occurrenceId: 'other-trial' }]) {
    assert.equal(evaluateOnboardingReadiness({ ...ready, ...patch }).allowed, false);
  }
});

test('candidate-agreed dates cannot be borrowed from a namesake or another trial', () => {
  for (const patch of [{ candidatePageId: secondSumit.pageId }, { candidateEmail: secondSumit.email },
    { occurrenceId: 'previous-trial' }, { candidatePageId: undefined }, { candidateEmail: undefined },
    { occurrenceId: undefined }]) {
    const result = evaluateTrialAuthorization({ ...trial, dates: { ...dates, ...patch } });
    assert.equal(result.stageAllowed, true);
    assert.equal(result.onboardingAllowed, false);
    assert.equal(result.onboardingReason, 'trial_date_agreement_scope_mismatch');
  }
  const changedEmail = evaluateOnboardingReadiness({ candidate: { ...candidate, email: secondSumit.email },
    occurrenceId, authorization: authorized, signedDocuments: REQUIRED_TRIAL_DOCUMENTS,
    jamieReady: true, aaReady: true });
  assert.equal(changedEmail.reason, 'onboarding_scope_mismatch');
});

test('only explicit current Robin exclusions for this candidate and trial mark readiness items not applicable', () => {
  const exclusion = { ...scoped, authorId: SLACK_IDS.robin, explicit: true, current: true,
    action: 'exclude_onboarding_item', item: 'aa_okta',
    sourceUrl: 'https://example.com/no-okta', occurredAt: '2026-10-13T10:30:00Z' };
  const ready = { candidate, occurrenceId, authorization: authorized, packetSent: true,
    signedDocuments: REQUIRED_TRIAL_DOCUMENTS, jamieReady: true, aaReady: false, exclusions: [exclusion] };
  const result = evaluateOnboardingReadiness(ready);
  assert.equal(result.allowed, true);
  assert.deepEqual(result.notApplicable, ['aa_okta']);
  assert.deepEqual(result.pending, []);
  assert.equal(result.exclusionEvidence[0].sourceUrl, exclusion.sourceUrl);
  for (const patch of [{ authorId: SLACK_IDS.alexis }, { authorId: SLACK_IDS.aa }, { explicit: false },
    { current: false }, { superseded: true }, { candidatePageId: secondSumit.pageId },
    { candidateEmail: secondSumit.email }, { occurrenceId: 'old-trial' }, { candidatePageId: undefined },
    { candidateEmail: undefined }, { occurrenceId: undefined }, { sourceUrl: '' },
    { occurredAt: '2026-10-13' }, { item: 'unknown_item' }, { action: 'work_trial' }]) {
    const invalid = evaluateOnboardingReadiness({ ...ready, exclusions: [{ ...exclusion, ...patch }] });
    assert.equal(invalid.allowed, false);
    assert.equal(invalid.reason, 'onboarding_exclusion_unverified');
  }
  assert.equal(evaluateOnboardingReadiness({ ...ready, exclusions: { aa_okta: true } }).allowed, false);
  assert.equal(evaluateOnboardingReadiness({ ...ready, hold: true }).allowed, false);
  assert.equal(evaluateOnboardingReadiness({ ...ready, cancelled: true }).allowed, false);
  assert.equal(evaluateOnboardingReadiness({ ...ready, combinedNoticeSent: true }).allowed, false);
});

test('offboarding waits until next local calendar day, including weekends', () => {
  assert.equal(evaluateOffboarding({ ...offboarding, now: '2026-10-17T06:59:59Z' }).reason, 'offboarding_not_due');
  const due = evaluateOffboarding(offboarding); // Saturday local midnight after Friday end.
  assert.equal(due.allowed, true);
  assert.equal(due.dueDate, '2026-10-17');
  assert.equal(due.requestAaRemoval, false);
  assert.equal(due.deletesAccess, false);
  assert.equal(evaluateOffboarding({ ...offboarding, reminderSentForSchedule: due.scheduleKey }).reason, 'offboarding_reminder_already_sent');
  const extended = evaluateOffboarding({ ...offboarding, latestConfirmedEnd: '2026-10-20', reminderSentForSchedule: due.scheduleKey });
  assert.equal(extended.reason, 'offboarding_not_due');
  assert.equal(extended.dueDate, '2026-10-21');
  assert.notEqual(extended.scheduleKey, due.scheduleKey);
});

test('offboarding follows IANA timezone across DST and east-of-UTC boundaries', () => {
  assert.equal(evaluateOffboarding({ ...offboarding, latestConfirmedEnd: '2026-11-01',
    now: '2026-11-02T07:59:59Z' }).allowed, false);
  assert.equal(evaluateOffboarding({ ...offboarding, latestConfirmedEnd: '2026-11-01',
    now: '2026-11-02T08:00:00Z' }).allowed, true);
  assert.equal(evaluateOffboarding({ ...offboarding, timeZone: 'Asia/Kolkata',
    now: '2026-10-16T18:29:59Z' }).allowed, false);
  assert.equal(evaluateOffboarding({ ...offboarding, timeZone: 'Asia/Kolkata',
    now: '2026-10-16T18:30:00Z' }).allowed, true);
  assert.equal(localDate('2026-10-16T18:30:00Z', 'Asia/Kolkata'), '2026-10-17');
  assert.equal(nextCalendarDate('2028-02-28'), '2028-02-29');
});

test('latest state, hires, cancellation cleanup and Jamie completion suppress obsolete offboarding', () => {
  assert.equal(evaluateOffboarding({ ...offboarding, latestStateVerified: false }).allowed, false);
  assert.equal(evaluateOffboarding({ ...offboarding, now: '2026-10-17' }).allowed, false);
  assert.equal(evaluateOffboarding({ ...offboarding, hired: true }).reason, 'hire_continues_access');
  assert.equal(evaluateOffboarding({ ...offboarding, cancelled: true }).reason, 'cancelled_before_setup');
  assert.equal(evaluateOffboarding({ ...offboarding, cancelled: true, setupStarted: true }).action, 'request_jamie_cleanup');
  const finished = { ...scoped, action: 'offboarded', explicit: true, current: true, authorId: SLACK_IDS.jamie,
    sourceUrl: 'https://example.com/offboarded', confirmedAt: '2026-10-17T07:00:00Z' };
  const result = evaluateOffboarding({ ...offboarding, offboardingConfirmation: finished });
  assert.equal(result.completed, true);
  assert.equal(result.allowed, false);
  assert.equal(result.requestAaRemoval, false);
  assert.notEqual(evaluateOffboarding({ ...offboarding, offboardingConfirmation: { ...finished, authorId: SLACK_IDS.aa } }).completed, true);
});

test('future, superseded, foreign, or stale-state offboarding evidence never marks completion', () => {
  const finished = { ...scoped, action: 'offboarded', explicit: true, current: true,
    authorId: SLACK_IDS.jamie, sourceUrl: 'https://example.com/offboarded', confirmedAt: offboarding.now };
  const ready = { ...offboarding, offboardingConfirmation: finished };
  assert.equal(evaluateOffboarding(ready).completed, true);
  for (const patch of [{ confirmedAt: '2026-10-17T07:00:00.001Z' },
    { confirmedAt: '2026-10-18T07:00:00Z' }, { confirmedAt: offboarding.now, precision: 'minute' }]) {
    const future = evaluateOffboarding({ ...ready, offboardingConfirmation: { ...finished, ...patch } });
    assert.equal(future.reason, 'offboarding_confirmation_in_future');
    assert.notEqual(future.completed, true);
  }
  assert.equal(evaluateOffboarding({ ...ready, latestStateVerified: false }).reason, 'latest_trial_state_unverified');
  assert.equal(evaluateOffboarding({ ...ready, now: undefined }).reason, 'current_time_unverified');
  for (const patch of [{ current: false }, { current: undefined }, { superseded: true },
    { candidatePageId: secondSumit.pageId }, { candidateEmail: secondSumit.email },
    { occurrenceId: 'old-trial' }]) {
    assert.notEqual(evaluateOffboarding({ ...ready, offboardingConfirmation: { ...finished, ...patch } }).completed, true);
  }
});

test('rejection is blocked at +1h and +23h59m; eligible exactly +24h and after +36h decision', () => {
  for (const now of ['2026-10-13T11:00:00Z', '2026-10-14T09:59:00Z', '2026-10-14T09:59:59.999Z']) {
    const result = evaluateRejectionEligibility({ ...rejection, now });
    assert.equal(result.allowed, false);
    assert.equal(result.eligibleAt, '2026-10-14T10:00:00.000Z');
  }
  assert.equal(evaluateRejectionEligibility(rejection).allowed, true);
  const late = '2026-10-14T22:00:00Z';
  const result = evaluateRejectionEligibility({ ...rejection, decisionAt: late,
    confirmation: { ...confirmation, confirmedAt: late }, now: late });
  assert.equal(result.allowed, true);
  assert.equal(result.eligibleAt, '2026-10-14T22:00:00.000Z');
  assert.equal(result.sendsEmail, false);
});

test('rejection uses 24 elapsed hours across spring and fall DST, with explicit non-UTC offsets', () => {
  for (const [end, early, due] of [
    ['2026-03-07T12:00:00-08:00', '2026-03-08T12:59:59-07:00', '2026-03-08T13:00:00-07:00'],
    ['2026-10-31T12:00:00-07:00', '2026-11-01T10:59:59-08:00', '2026-11-01T11:00:00-08:00'],
    ['2026-10-13T15:30:00+05:30', '2026-10-14T09:59:59Z', '2026-10-14T10:00:00Z'],
  ]) {
    const input = { ...rejection, latestInterviewEnd: { ...rejection.latestInterviewEnd, at: end },
      decisionAt: end, confirmation: { ...confirmation, confirmedAt: end } };
    assert.equal(evaluateRejectionEligibility({ ...input, now: early }).allowed, false);
    assert.equal(evaluateRejectionEligibility({ ...input, now: due }).allowed, true);
  }
});

test('lost precision rounds deadline upward and later actual interview end moves deadline', () => {
  const truncated = { ...rejection, latestInterviewEnd: { ...rejection.latestInterviewEnd, at: '2026-10-13T10:00Z' } };
  assert.equal(evaluateRejectionEligibility(truncated).eligibleAt, '2026-10-14T10:01:00.000Z');
  assert.equal(evaluateRejectionEligibility(truncated).allowed, false);
  assert.equal(evaluateRejectionEligibility({ ...truncated, now: '2026-10-14T10:01:00Z' }).allowed, true);
  assert.equal(evaluateRejectionEligibility({ ...rejection,
    latestInterviewEnd: { ...rejection.latestInterviewEnd, at: '2026-10-13T12:00:32Z' } }).eligibleAt,
  '2026-10-14T12:00:32.000Z');
});

test('rejection requires latest verified actual completion and cannot retry uncertain or prior sends', () => {
  for (const patch of [{ verified: false }, { actuallyCompleted: false }, { isLatest: false },
    { sourceUrl: '' }, { at: '2026-10-13' }, { at: '2026-02-30T10:00:00Z' }, { at: '2026-10-15T10:00:00Z' }]) {
    assert.equal(evaluateRejectionEligibility({ ...rejection, latestInterviewEnd: { ...rejection.latestInterviewEnd, ...patch } }).allowed, false);
  }
  for (const patch of [{ hold: true }, { historical: true }, { priorSendVerified: true },
    { recipientChanged: true }, { sourceAccessVerified: false }, { outcome: 'Withdrawn or Unavailable' },
    { deliveryState: 'Sending' }, { deliveryState: 'Uncertain' }, { deliveryState: 'Needs attention' },
    { deliveryState: 'Sent' }, { deliveryState: 'Cancelled' }, { candidate: secondSumit }]) {
    assert.equal(evaluateRejectionEligibility({ ...rejection, ...patch }).allowed, false);
  }
  assert.equal(evaluateRejectionEligibility({ ...rejection, latestInterviewEnd: undefined }).allowed, false);
  assert.throws(() => instantMs('2026-10-13T10:00:00'));
  assert.throws(() => instantMs('2026-02-30T10:00:00Z'));
});

test('verified interview-end evidence must belong to the exact candidate and occurrence', () => {
  for (const patch of [{ candidatePageId: secondSumit.pageId }, { candidateEmail: secondSumit.email },
    { occurrenceId: 'earlier-interview' }, { candidatePageId: undefined },
    { candidateEmail: undefined }, { occurrenceId: undefined }]) {
    const result = evaluateRejectionEligibility({ ...rejection,
      latestInterviewEnd: { ...rejection.latestInterviewEnd, ...patch } });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'interview_end_scope_mismatch');
  }
});

test('historical and unknown delivery statuses fail closed without a separate historical flag', () => {
  assert.equal(evaluateRejectionEligibility({ ...rejection, deliveryState: 'Historical - no auto-send' }).reason,
    'historical_rejection');
  for (const deliveryState of ['historical', 'Ready', 'Failed', 'scheduled', false, 0]) {
    assert.equal(evaluateRejectionEligibility({ ...rejection, deliveryState }).reason, 'unknown_delivery_state');
  }
  for (const deliveryState of [undefined, null, '', 'Scheduled']) {
    assert.equal(evaluateRejectionEligibility({ ...rejection, deliveryState }).allowed, true);
  }
});

test('rejection preserves source precision for end, decision, and confirmation without exact overrides', () => {
  for (const precision of [undefined, 'exact', 'second', 'minute']) {
    const input = { ...rejection, latestInterviewEnd: { ...rejection.latestInterviewEnd,
      at: '2026-10-13T10:00Z', precision } };
    assert.equal(evaluateRejectionEligibility(input).allowed, false);
    assert.equal(evaluateRejectionEligibility(input).eligibleAt, '2026-10-14T10:01:00.000Z');
    assert.equal(evaluateRejectionEligibility({ ...input, now: '2026-10-14T10:01:00Z' }).allowed, true);
  }
  for (const patch of [
    { confirmation: { ...confirmation, confirmedAt: '2026-10-14T10:00:00Z', precision: 'minute' } },
    { confirmation: { ...confirmation, confirmedAt: '2026-10-14T10:00Z', precision: 'exact' } },
    { decisionAt: '2026-10-14T10:00Z', decisionPrecision: 'exact' },
    { decisionAt: '2026-10-14T10:00:00Z', decisionPrecision: 'minute' },
  ]) {
    const input = { ...rejection, ...patch };
    assert.equal(evaluateRejectionEligibility(input).allowed, false);
    assert.equal(evaluateRejectionEligibility({ ...input, now: '2026-10-14T10:00:59.999Z' }).allowed, false);
    const due = evaluateRejectionEligibility({ ...input, now: '2026-10-14T10:01:00Z' });
    assert.equal(due.allowed, true);
    assert.equal(due.eligibleAt, '2026-10-14T10:01:00.000Z');
  }
  const second = { ...rejection,
    confirmation: { ...confirmation, confirmedAt: rejection.now, precision: 'second' } };
  assert.equal(evaluateRejectionEligibility(second).allowed, false);
  assert.equal(evaluateRejectionEligibility({ ...second, now: '2026-10-14T10:00:01Z' }).allowed, true);
  assert.equal(evaluateRejectionEligibility({ ...rejection,
    confirmation: { ...confirmation, precision: 'unknown' } }).allowed, false);
  assert.equal(evaluateRejectionEligibility({ ...rejection,
    latestInterviewEnd: { ...rejection.latestInterviewEnd, at: '2026-10-13T10:00Z', precision: 'unknown' } }).allowed, false);
});
