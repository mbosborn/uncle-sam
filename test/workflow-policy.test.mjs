import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SLACK_IDS, requestKey } from '../src/policy.mjs';
import { DHANA_ID, nextBusinessDayReminder, evaluateInterviewFeedback, evaluateAdvanceInstruction,
  takeHomeRequestKey, evaluateTakeHomeDelivery, evaluateSubmissionGrading,
  planConciseCandidateUpdate } from '../src/workflow-policy.mjs';
const displaySchema = JSON.parse(readFileSync(new URL('./fixtures/recruiting-display-schema.json', import.meta.url), 'utf8'));

const candidate = Object.freeze({ pageId: '11111111-2222-3333-4444-555555555555',
  fullName: 'Reagan Turner', email: 'reagan@example.com', emailVerified: true });
const occurrenceId = 'interview:calendar-recurring-instance-1';
const scope = { candidatePageId: candidate.pageId, candidateEmail: candidate.email, occurrenceId,
  verified: true, current: true, sourceUrl: 'https://example.com/source' };
const route = recipientId => ({ verified: true, kind: 'im', conversationId: 'DTEST123', recipientIds: [recipientId] });
const interview = { candidate, occurrenceId, now: '2026-10-13T18:10:00Z', latestStateVerified: true,
  feedbackChecked: true, schedule: { ...scope, interviewerId: SLACK_IDS.robin,
    scheduledEnd: '2026-10-13T18:00:00Z', status: 'confirmed' }, route: route(SLACK_IDS.robin) };
const instruction = { ...scope, action: 'send_take_home', explicit: true, authorId: SLACK_IDS.project,
  occurredAt: '2026-10-13T18:00:00Z' };
const advance = { candidate, occurrenceId, instruction, currentSourcesVerified: true,
  now: '2026-10-13T18:10:00Z' };
const assignmentUrl = 'https://company-takehome.vercel.app/assignment/test-fixture';
const link = { ...scope, url: assignmentUrl, persisted: true };
const delivery = { ...advance, portal: { ...scope, linkState: 'existing', link, scorecardPageId: '22222222-2222-3333-4444-555555555555' },
  scorecard: { ...scope, pageId: '22222222-2222-3333-4444-555555555555', type: 'Take-home', assessmentKind: 'Scorecard' },
  invitationCheck: { ...scope, sentSearchCompleted: true, state: 'not_sent', checkedAssignmentLink: assignmentUrl },
  ownership: { state: 'owned', current: true, requestKey: takeHomeRequestKey(advance) },
  template: { ...scope, approved: true, renderedVerified: true, signatureVerified: true,
    recipient: candidate.email, ccRulesVerified: true, exactAssignmentLink: assignmentUrl, sender: 'project@company.example' } };
const submission = { candidate, occurrenceId, latestStateVerified: true, route: route(DHANA_ID),
  submission: { ...scope, uploaded: true, submissionId: 'upload:1', url: 'https://example.com/submission' } };
const update = { candidate, occurrenceId, inputKind: 'structured', source: { ...scope, authorId: SLACK_IDS.robin,
  occurredAt: '2026-10-13T18:00:00Z', sourceEventId: 'slack:source-message', rawText: 'Advance to the next interview; ask about evaluations.' },
  layout: { ...scope, dataSourceId: displaySchema.source.slice('collection://'.length), properties: displaySchema.properties },
  record: { ...scope, colorMode: 'Automatic', dotColor: 'Automatic', Stage: 'Interview', Score: 7 },
  briefBullets: ['Status: Interview feedback received.', 'Assessment: Strong systems examples.', 'Open: Clarify evaluation experience.'],
  nextAction: 'Robin: assign the next interviewer.',
  statusEvidence: { ...scope, kind: 'assignment_pending', task: 'Assign interviewer', ownerId: SLACK_IDS.robin } };

test('interview waits three minutes and asks whether it happened without asserting completion', () => {
  assert.equal(evaluateInterviewFeedback({ ...interview, now: '2026-10-13T18:02:59.999Z' }).reason, 'feedback_prompt_not_due');
  assert.equal(evaluateInterviewFeedback({ ...interview, now: '2026-10-13T18:03:00Z' }).allowed, true);
  const due = evaluateInterviewFeedback(interview);
  assert.equal(due.allowed, true);
  assert.equal(due.action, 'prompt_interviewer');
  assert.equal(due.dispatchAction, 'interview.feedback_request');
  assert.equal(due.requestKey, requestKey({ candidate, occurrenceId: due.occurrenceId,
    action: due.dispatchAction, recipientIds: [SLACK_IDS.robin] }));
  assert.equal(due.askWhetherInterviewHappened, true);
  assert.equal(due.interviewCompleted, false);
  assert.equal(due.sendsEmail, false);
});

test('cancelled, rescheduled, answered, and inaccessible interview jobs fail closed', () => {
  const first = evaluateInterviewFeedback(interview);
  const rescheduled = { ...interview, schedule: { ...interview.schedule, scheduledEnd: '2026-10-14T18:00:00Z' } };
  const current = evaluateInterviewFeedback(rescheduled);
  assert.equal(current.reason, 'feedback_prompt_not_due');
  assert.notEqual(current.scheduleKey, first.scheduleKey);
  assert.equal(current.promptKey, first.promptKey);
  assert.equal(evaluateInterviewFeedback({ ...rescheduled, expectedScheduleKey: first.scheduleKey }).reason, 'obsolete_schedule');
  assert.equal(evaluateInterviewFeedback({ ...interview, schedule: { ...interview.schedule, status: 'cancelled' } }).reason, 'interview_cancelled');
  assert.equal(evaluateInterviewFeedback({ ...interview, feedback: { ...scope, confirmed: true } }).reason, 'feedback_received');
  assert.equal(evaluateInterviewFeedback({ ...interview, didNotHappen: { ...scope, confirmed: true } }).reason, 'interview_did_not_happen');
  for (const patch of [{ latestStateVerified: false }, { feedbackChecked: false }, { route: route(DHANA_ID) },
    { hold: true },
    { candidate: { ...candidate, isDemo: true } }, { schedule: { ...interview.schedule, current: false } },
    { schedule: { ...interview.schedule, candidateEmail: 'namesake@example.com' } },
    { feedback: { ...scope, confirmed: true, occurrenceId: 'earlier-round' } }]) {
    assert.equal(evaluateInterviewFeedback({ ...interview, ...patch }).allowed, false);
  }
});

test('one-business-day reminder retains Los Angeles wall time across both DST transitions and weekends', () => {
  for (const [sent, expected] of [
    ['2026-03-06T10:15:30.125-08:00', '2026-03-09T17:15:30.125Z'],
    ['2026-10-30T10:15:30.125-07:00', '2026-11-02T18:15:30.125Z'],
    ['2026-10-13T10:15:30-07:00', '2026-10-14T17:15:30.000Z'],
    ['2026-10-17T23:59:59-07:00', '2026-10-20T06:59:59.000Z'],
    ['2026-10-18T00:00:00-07:00', '2026-10-19T07:00:00.000Z'],
  ]) assert.equal(nextBusinessDayReminder(sent), expected);
  assert.throws(() => nextBusinessDayReminder('2026-10-13'));
});

test('reminder requires actual prompt receipt, is sent once, and stops on new feedback or reschedule', () => {
  const first = evaluateInterviewFeedback(interview);
  const prompted = { ...interview, promptReceipt: { ...scope, state: 'sent', requestKey: first.promptKey,
    scheduleKey: first.scheduleKey, sentAt: interview.now }, now: '2026-10-14T18:09:59.999Z' };
  assert.equal(evaluateInterviewFeedback(prompted).reason, 'feedback_reminder_not_due');
  const due = evaluateInterviewFeedback({ ...prompted, now: '2026-10-14T18:10:00Z' });
  assert.equal(due.action, 'remind_interviewer');
  assert.equal(due.dispatchAction, 'interview.feedback_reminder');
  assert.equal(due.requestKey, requestKey({ candidate, occurrenceId: due.occurrenceId,
    action: due.dispatchAction, recipientIds: [SLACK_IDS.robin] }));
  assert.equal(due.reminderDueAt, '2026-10-14T18:10:00.000Z');
  assert.equal(evaluateInterviewFeedback({ ...prompted, reminderReceipt: { ...scope, requestKey: due.requestKey,
    state: 'sent' } }).reason, 'feedback_reminder_already_sent');
  assert.equal(evaluateInterviewFeedback({ ...prompted, feedback: { ...scope, confirmed: true } }).reason, 'feedback_received');
  assert.equal(evaluateInterviewFeedback({ ...prompted, schedule: { ...interview.schedule,
    scheduledEnd: '2026-10-14T18:00:00Z' } }).reason, 'rescheduled_after_prompt_requires_review');
  for (const patch of [{ state: 'uncertain' }, { requestKey: 'other-request' }, { sentAt: '2026-10-13T18:02:59Z' },
    { sentAt: '2026-10-15T18:10:00Z' }, { current: false }]) {
    assert.equal(evaluateInterviewFeedback({ ...prompted, promptReceipt: { ...prompted.promptReceipt, ...patch } }).allowed, false);
  }
});

test('advance authority excludes trial and negotiation, and Project authority is specific to take-homes', () => {
  for (const authorId of [SLACK_IDS.robin, SLACK_IDS.alexis, SLACK_IDS.aa, DHANA_ID]) {
    for (const action of ['advance_interview', 'send_take_home']) {
      assert.equal(evaluateAdvanceInstruction({ ...advance, instruction: { ...instruction, action, authorId } }).allowed, true);
    }
  }
  assert.equal(evaluateAdvanceInstruction(advance).allowed, true);
  for (const patch of [{ action: 'advance_interview' }, { action: 'work_trial', authorId: SLACK_IDS.robin },
    { action: 'negotiate_offer' }, { explicit: false }, { current: false }, { superseded: true },
    { authorId: SLACK_IDS.jamie }, { candidateEmail: 'other@example.com' }, { occurredAt: '2026-10-14T18:00:00Z' }]) {
    assert.equal(evaluateAdvanceInstruction({ ...advance, instruction: { ...instruction, ...patch } }).allowed, false);
  }
  for (const patch of [{ hold: true }, { conflictingAuthority: true }, { currentSourcesVerified: false }]) {
    assert.equal(evaluateAdvanceInstruction({ ...advance, ...patch }).allowed, false);
  }
});

test('take-home creates only when verified absent and persists/reuses exact link after email failure', () => {
  const result = evaluateTakeHomeDelivery(delivery);
  assert.equal(result.allowed, true);
  assert.equal(result.link, assignmentUrl);
  assert.equal(result.requiresGmailSentReadback, true);
  assert.equal(result.sendsEmail, false);
  const missing = evaluateTakeHomeDelivery({ ...delivery, portal: { ...delivery.portal, linkState: 'verified_absent', link: undefined } });
  assert.equal(missing.action, 'create_and_persist_candidate_link');
  assert.equal(missing.deliveryAllowed, false);
  const failed = evaluateTakeHomeDelivery({ ...delivery, invitationCheck: { ...delivery.invitationCheck, state: 'failed_before_send' } });
  assert.equal(failed.action, 'deliver_approved_take_home_via_existing_sender');
  assert.equal(failed.link, assignmentUrl);
  assert.equal(failed.requestKey, result.requestKey);
  assert.equal(evaluateTakeHomeDelivery({ ...delivery, portal: { ...delivery.portal, link: { ...link, persisted: false } } }).reason, 'assignment_link_not_persisted');
});

test('take-home unknown/SENT/uncertain/foreign state and missing ownership block delivery and duplicate links', () => {
  for (const state of ['sent', 'uncertain', 'sending', 'unknown', undefined]) {
    assert.equal(evaluateTakeHomeDelivery({ ...delivery, invitationCheck: { ...delivery.invitationCheck, state } }).allowed, false);
  }
  for (const patch of [
    { ownership: { ...delivery.ownership, state: 'concurrent_owner' } },
    { ownership: { ...delivery.ownership, requestKey: 'foreign-key' } },
    { invitationCheck: { ...delivery.invitationCheck, sentSearchCompleted: false } },
    { invitationCheck: { ...delivery.invitationCheck, checkedAssignmentLink: 'https://example.com/different' } },
    { scorecard: { ...delivery.scorecard, superseded: true } },
    { scorecard: { ...delivery.scorecard, type: 'Work Trial' } },
    { portal: { ...delivery.portal, linkState: 'uncertain' } },
    { portal: { ...delivery.portal, linkState: 'verified_absent' } },
    { portal: { ...delivery.portal, scorecardPageId: '11111111-2222-3333-4444-555555555555' } },
    { portal: { ...delivery.portal, link: { ...link, occurrenceId: 'old-attempt' } } },
    { template: { ...delivery.template, exactAssignmentLink: 'https://example.com/another-link' } },
    { template: { ...delivery.template, sender: 'bot@example.com' } },
    { template: { ...delivery.template, recipient: 'namesake@example.com' } },
    { template: { ...delivery.template, ccRulesVerified: false } },
  ]) assert.equal(evaluateTakeHomeDelivery({ ...delivery, ...patch }).allowed, false);
});

test('take-home semantic key survives policy/source changes but distinguishes recipient and authorized attempt', () => {
  const key = takeHomeRequestKey(advance);
  assert.equal(key, takeHomeRequestKey({ ...advance, policyVersion: 99, sourceUrl: 'https://example.com/duplicate' }));
  assert.notEqual(key, takeHomeRequestKey({ ...advance, occurrenceId: 'second-attempt' }));
  assert.notEqual(key, takeHomeRequestKey({ ...advance, candidate: { ...candidate, email: 'other@example.com' } }));
});

test('a new upload requests private human grading even with an automated grade or acknowledgment', () => {
  const first = evaluateSubmissionGrading({ ...submission, portalGrade: 100 });
  assert.equal(first.allowed, true);
  assert.equal(first.recipientId, DHANA_ID);
  assert.equal(first.dispatchAction, 'takehome.grading_request');
  assert.equal(first.assessmentOccurrenceId, occurrenceId);
  assert.equal(first.requestKey, requestKey({ candidate, occurrenceId: first.occurrenceId,
    action: first.dispatchAction, recipientIds: [DHANA_ID] }));
  assert.equal(first.updatesPortalScore, false);
  assert.equal(evaluateSubmissionGrading({ ...submission, humanReview: { ...scope, submissionId: 'upload:1',
    kind: 'human', authorId: DHANA_ID, completed: false } }).allowed, true);
  assert.equal(evaluateSubmissionGrading({ ...submission, humanReview: { ...scope, submissionId: 'upload:1',
    kind: 'portal_automatic', completed: true } }).allowed, true);
  assert.equal(evaluateSubmissionGrading({ ...submission, humanReview: { ...scope, submissionId: 'upload:1',
    kind: 'human', authorId: DHANA_ID, completed: true } }).reason, 'submission_already_human_reviewed');
  const second = evaluateSubmissionGrading({ ...submission, submission: { ...submission.submission, submissionId: 'upload:2' } });
  assert.notEqual(second.requestKey, first.requestKey);
});

test('grading requests deduplicate persisted receipts and block uncertain delivery or public/missing route', () => {
  const first = evaluateSubmissionGrading(submission);
  const receipt = { ...scope, state: 'sent', requestKey: first.requestKey };
  assert.equal(evaluateSubmissionGrading({ ...submission, requestReceipt: receipt }).reason, 'grading_request_already_sent');
  for (const patch of [{ route: undefined }, { route: { ...submission.route, kind: 'channel' } },
    { route: { ...submission.route, conversationId: 'CPUBLIC123' } },
    { route: { ...submission.route, recipientIds: [DHANA_ID, SLACK_IDS.project] } },
    { requestReceipt: { ...receipt, state: 'uncertain' } },
    { requestReceipt: { ...receipt, requestKey: 'another-upload' } },
    { submission: { ...submission.submission, superseded: true } },
    { humanReview: { ...scope, submissionId: 'earlier-upload', completed: true } },
    { latestStateVerified: false }, { candidate: { ...candidate, isTest: true } }]) {
    assert.equal(evaluateSubmissionGrading({ ...submission, ...patch }).allowed, false);
  }
});

test('concise updates target existing text properties and preserve automatic/manual color, stage, scores and layout', () => {
  const snapshot = JSON.stringify(update);
  const result = planConciseCandidateUpdate(update);
  assert.equal(result.allowed, true);
  assert.deepEqual(result.properties, { 'Candidate brief': update.briefBullets.join('\n'),
    'Next action': update.nextAction, 'Action Status': 'Needs Project' });
  assert.equal(result.blockUpdates, undefined);
  assert.equal(result.statusColorLabel, '🔴 Red');
  assert.equal(result.preservesColorSelection, true);
  assert.equal(result.replacesLayout, false);
  assert.equal(result.changesStage, false);
  assert.equal(result.requiresReadback, true);
  assert.equal(result.historySource.rawText, update.source.rawText);
  assert.equal(result.historySource.authorId, SLACK_IDS.robin);
  assert.equal(JSON.stringify(update), snapshot);
  const manual = planConciseCandidateUpdate({ ...update, record: { ...update.record, colorMode: 'Manual override', dotColor: '🟢 Green' } });
  assert.deepEqual(manual.properties, result.properties);
  assert.equal(Object.hasOwn(manual.properties, 'Dot color'), false);
  assert.equal(Object.hasOwn(manual.properties, 'Color mode'), false);
  const withoutStatus = planConciseCandidateUpdate({ ...update, statusEvidence: undefined });
  assert.equal(withoutStatus.allowed, true);
  assert.equal(Object.hasOwn(withoutStatus.properties, 'Action Status'), false);
});

test('live schema fixture blocks invented content blocks and lowercase Notion color options', () => {
  assert.equal(displaySchema.properties['Candidate brief'].type, 'text');
  assert.equal(displaySchema.properties['Next action'].type, 'text');
  assert.equal(displaySchema.properties['Dot color'].options.includes('red'), false);
  assert.equal(displaySchema.properties['Dot color'].options.includes('🔴 Red'), true);
  assert.match(displaySchema.properties['Color mode'].description, /Choosing a dot color saves a manual override/);
  assert.match(displaySchema.properties['Candidate brief'].description, /3–6 labeled lines/);
  const notionOptions = Object.fromEntries(Object.entries(displaySchema.properties).map(([name, property]) =>
    [name, property.options ? { ...property, options: property.options.map(option => ({ name: option })) } : property]));
  assert.equal(planConciseCandidateUpdate({ ...update, layout: { ...update.layout, properties: notionOptions } }).allowed, true);
  const oldBlocks = { ...scope, candidateBriefContentBlockId: 'brief-content', nextActionContentBlockId: 'next-content' };
  assert.equal(planConciseCandidateUpdate({ ...update, layout: oldBlocks }).allowed, false);
  const wrongOptions = { ...displaySchema.properties,
    'Dot color': { type: 'select', options: ['Automatic', 'red', 'yellow', 'blue', 'purple'] } };
  assert.equal(planConciseCandidateUpdate({ ...update, layout: { ...update.layout, properties: wrongOptions } }).reason,
    'action_status_schema_mismatch');
  const wrongTextType = { ...displaySchema.properties, 'Candidate brief': { type: 'block' } };
  assert.equal(planConciseCandidateUpdate({ ...update, layout: { ...update.layout, properties: wrongTextType } }).reason,
    'existing_layout_or_record_unverified');
});

test('pasted notes need an editable 3-5 bullet preview and exact scoped confirmation; structured/direct commands do not', () => {
  const pasted = { ...update, inputKind: 'pasted_notes' };
  const preview = planConciseCandidateUpdate(pasted);
  assert.equal(preview.reason, 'editable_preview_confirmation_required');
  const confirmed = { ...scope, confirmed: true, previewKey: preview.previewKey,
    authorId: SLACK_IDS.robin, confirmedAt: '2026-10-13T18:01:00Z' };
  assert.equal(planConciseCandidateUpdate({ ...pasted, previewConfirmation: confirmed }).allowed, true);
  assert.equal(planConciseCandidateUpdate({ ...pasted, briefBullets: ['Evidence: Different interpretation.', ...update.briefBullets],
    previewConfirmation: confirmed }).allowed, false);
  assert.equal(planConciseCandidateUpdate({ ...pasted, previewConfirmation: { ...confirmed, candidateEmail: 'other@example.com' } }).allowed, false);
  assert.equal(planConciseCandidateUpdate({ ...pasted, briefBullets: Array(6).fill('Evidence: Verified detail.') }).reason,
    'pasted_preview_requires_three_to_five_bullets');
  assert.equal(planConciseCandidateUpdate({ ...update, briefBullets: ['One.', 'Two.', 'Three.'] }).reason, 'concise_update_required');
  assert.equal(planConciseCandidateUpdate({ ...update, inputKind: 'direct_command' }).allowed, true);
});

test('status facts distinguish delivered requests, active bookings and actual completion from plans/acknowledgments', () => {
  const cases = [
    ['request_delivered', { delivered: true, candidateOwesAction: true }, 'Waiting on Candidate', '🟡 Yellow'],
    ['booking_verified', { activeBooking: true, bookingId: 'calendar-event' }, 'Meeting Booked', '🟣 Purple'],
    ['interview_completed', { actuallyCompleted: true, feedbackPending: true }, 'Awaiting Feedback', '🔵 Blue'],
  ];
  for (const [kind, facts, status, color] of cases) {
    const result = planConciseCandidateUpdate({ ...update, statusEvidence: { ...scope, kind, ...facts } });
    assert.equal(result.properties['Action Status'], status);
    assert.equal(result.statusColorLabel, color);
    assert.equal(displaySchema.properties['Dot color'].options.includes(color), true);
    assert.equal(Object.hasOwn(result.properties, 'Dot color'), false);
    assert.equal(planConciseCandidateUpdate({ ...update, statusEvidence: { ...scope, kind, acknowledged: true,
      scheduledEnd: interview.schedule.scheduledEnd } }).reason, 'action_status_fact_unverified');
  }
  for (const patch of [{ layout: { ...update.layout, verified: false } },
    { briefBullets: Array(7).fill('Evidence: Too many.') }, { briefBullets: ['Long'.repeat(100)] },
    { source: { ...scope, occurrenceId: 'another-round' } },
    { statusEvidence: { ...scope, kind: 'offer_accepted' } }]) {
    assert.equal(planConciseCandidateUpdate({ ...update, ...patch }).allowed, false);
  }
});
