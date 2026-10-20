import { createHash } from 'node:crypto';
import { canonicalCandidate, canonicalPageId, instantMs, requestKey, SLACK_IDS } from './policy.mjs';

// Pure plans, not connected adapters. A dispatcher must separately apply mode/baseline,
// durable reservations, current-source rechecks, and verified write/send readback.
export const DHANA_ID = 'U030A09DBFF';
export const REMINDER_TIME_ZONE = 'America/Los_Angeles';
const permitted = extra => ({ allowed: true, reason: null, ...extra });
const blocked = (reason, extra = {}) => ({ allowed: false, reason, ...extra });
const present = value => typeof value === 'string' && value.trim().length > 0;
const slackUser = value => typeof value === 'string' && /^[UW][A-Z0-9]+$/.test(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = ms => new Date(ms).toISOString();
function candidateOrNull(candidate) { try { return canonicalCandidate(candidate); } catch { return null; } }
function scoped(candidate, occurrenceId, evidence) {
  try {
    return present(occurrenceId) && evidence?.occurrenceId === occurrenceId &&
      canonicalPageId(evidence.candidatePageId) === candidate.pageId &&
      canonicalCandidate({ ...candidate, email: evidence.candidateEmail }).email === candidate.email;
  } catch { return false; }
}
function sourced(candidate, occurrenceId, evidence) {
  return scoped(candidate, occurrenceId, evidence) && evidence.verified === true &&
    evidence.current === true && evidence.superseded !== true && present(evidence.sourceUrl);
}
function atOrNull(value) { try { return instantMs(value); } catch { return null; } }
function privateRoute(route, recipientId) {
  return route?.verified === true && route.kind === 'im' && /^D[A-Z0-9]+$/.test(route.conversationId ?? '') &&
    Array.isArray(route.recipientIds) && route.recipientIds.length === 1 && route.recipientIds[0] === recipientId;
}
/** An interviewer's own DM, or (several interviewers who took it together) one private group DM with exactly them. */
function interviewerRoute(route, recipients) {
  if (recipients.length === 1) return privateRoute(route, recipients[0]);
  const same = Array.isArray(route?.recipientIds) && route.recipientIds.length === recipients.length && recipients.every(id => route.recipientIds.includes(id));
  return route?.verified === true && route.kind === 'mpim' && /^[CG][A-Z0-9]+$/.test(route.conversationId ?? '') && same && recipients.length <= 4;
}

function wallParts(ms) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: REMINDER_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    second: '2-digit', hourCycle: 'h23' }).formatToParts(ms);
  const part = name => Number(parts.find(p => p.type === name).value);
  return [part('year'), part('month'), part('day'), part('hour'), part('minute'), part('second')];
}
const wallMs = parts => Date.UTC(parts[0], parts[1] - 1, ...parts.slice(2));

/** Monday-Friday, the same Los Angeles wall time. This is not +24 elapsed hours. */
export function nextBusinessDayReminder(promptSentAt) {
  const original = instantMs(promptSentAt);
  const parts = wallParts(original);
  const local = new Date(wallMs(parts));
  do { local.setUTCDate(local.getUTCDate() + 1); }
  while ([0, 6].includes(local.getUTCDay()));
  const target = local.getTime();
  let result = target;
  for (let i = 0; i < 4; i++) result += target - wallMs(wallParts(result));
  if (wallMs(wallParts(result)) !== target) throw new TypeError('Unresolvable reminder wall time');
  return iso(result + ((original % 1000) + 1000) % 1000);
}

/** Recompute at execution time from the latest calendar version and current feedback. */
/** How long after an interview ends its interviewer is asked (Project, 2026-10-16: five minutes, was ten). */
// Three minutes after the calendar says the interview ended (Project, 2026-10-16; was five).
export const FEEDBACK_PROMPT_DELAY_MS = 3 * 60_000;
/** With the call's Google Meet record (meet.mjs): 30 seconds after the last interviewer left (a dropped connection that
 * rejoins at once is not an end), so with the every-minute check the question lands within about a minute. Without a
 * record: the calendar end plus 3 minutes (Project, 2026-10-16). */
export const MEET_SETTLE_MS = 30_000;
/** A Meet end is believed only near the booked slot (a reused link's other calls are not this interview). */
const meetEndOf = (value, end) => { const at = atOrNull(value); return at !== null && at >= end - 3 * 3600_000 && at <= end + 3 * 3600_000 ? at : null; };

export function evaluateInterviewFeedback({ candidate, occurrenceId, schedule, now,
  latestStateVerified, feedbackChecked, feedback, didNotHappen, expectedScheduleKey,
  promptReceipt, reminderReceipt, route, hold = false } = {}) {
  const person = candidateOrNull(candidate);
  if (!person) return blocked('missing_or_invalid_identity');
  if (candidate.isDemo === true || candidate.isTest === true) return blocked('excluded_candidate');
  if (hold) return blocked('hold');
  if (latestStateVerified !== true || feedbackChecked !== true) return blocked('interview_sources_unverified');
  const recipients = Array.isArray(schedule?.interviewerIds) && schedule.interviewerIds.length ? [...new Set(schedule.interviewerIds)].sort() : [schedule?.interviewerId];
  if (!sourced(person, occurrenceId, schedule) || !slackUser(schedule.interviewerId) || !recipients.every(slackUser) || !recipients.includes(schedule.interviewerId)) return blocked('interview_schedule_unverified');
  if (schedule.status === 'cancelled') return blocked('interview_cancelled');
  if (schedule.status !== 'confirmed') return blocked('interview_schedule_not_active');
  const end = atOrNull(schedule.scheduledEnd), current = atOrNull(now);
  if (end === null || current === null) return blocked('interview_timing_unverified');
  const scheduleKey = digest([person.pageId, occurrenceId, recipients.length > 1 ? recipients.join(',') : schedule.interviewerId, end]);
  const promptKey = requestKey({ candidate: person, occurrenceId, action: 'interview.feedback_request', recipientIds: recipients });
  const reminderKey = requestKey({ candidate: person, occurrenceId, action: 'interview.feedback_reminder', recipientIds: recipients });
  const meetEnded = meetEndOf(schedule.meetEndedAt, end);
  const due = meetEnded !== null ? meetEnded + MEET_SETTLE_MS : end + FEEDBACK_PROMPT_DELAY_MS;
  const extra = { scheduleKey, promptKey, reminderKey, dueAt: iso(due),
    interviewCompleted: false, sendsEmail: false };
  if (expectedScheduleKey !== undefined && expectedScheduleKey !== scheduleKey) return blocked('obsolete_schedule', extra);
  for (const [evidence, reason] of [[feedback, 'feedback_received'], [didNotHappen, 'interview_did_not_happen']]) {
    if (evidence) return sourced(person, occurrenceId, evidence) && evidence.confirmed === true
      ? blocked(reason, extra) : blocked('interview_response_unverified', extra);
  }
  if (!interviewerRoute(route, recipients)) return blocked('interviewer_private_route_unverified', extra);
  if (!promptReceipt) return current < due ? blocked('feedback_prompt_not_due', extra)
    : permitted({ ...extra, action: 'prompt_interviewer', dispatchAction: 'interview.feedback_request', occurrenceId, requestKey: promptKey,
      askWhetherInterviewHappened: true, conversationId: route.conversationId });
  if (!sourced(person, occurrenceId, promptReceipt) || promptReceipt.requestKey !== promptKey ||
      promptReceipt.state !== 'sent' || atOrNull(promptReceipt.sentAt) === null) {
    return blocked('feedback_prompt_delivery_requires_reconciliation', extra);
  }
  if (promptReceipt.scheduleKey !== scheduleKey) return blocked('rescheduled_after_prompt_requires_review', extra);
  const sent = instantMs(promptReceipt.sentAt);
  const receiptMeet = meetEndOf(promptReceipt.meetEndedAt, end);
  if (sent < (receiptMeet !== null ? receiptMeet + MEET_SETTLE_MS : end + FEEDBACK_PROMPT_DELAY_MS) || sent > current) return blocked('feedback_prompt_receipt_timing_invalid', extra);
  if (reminderReceipt) return sourced(person, occurrenceId, reminderReceipt) && reminderReceipt.requestKey === reminderKey &&
    reminderReceipt.state === 'sent' ? blocked('feedback_reminder_already_sent', extra)
      : blocked('feedback_reminder_delivery_requires_reconciliation', extra);
  const reminderDueAt = nextBusinessDayReminder(promptReceipt.sentAt);
  return current < instantMs(reminderDueAt) ? blocked('feedback_reminder_not_due', { ...extra, reminderDueAt })
    : permitted({ ...extra, reminderDueAt, action: 'remind_interviewer', dispatchAction: 'interview.feedback_reminder', occurrenceId, requestKey: reminderKey,
      conversationId: route.conversationId });
}

/** Interview/take-home authority is separate from Robin-only work-trial authority. */
export function evaluateAdvanceInstruction({ candidate, occurrenceId, instruction, currentSourcesVerified,
  hold = false, conflictingAuthority = false, now } = {}) {
  const person = candidateOrNull(candidate);
  if (!person) return blocked('missing_or_invalid_identity');
  if (candidate.isDemo === true || candidate.isTest === true) return blocked('excluded_candidate');
  if (currentSourcesVerified !== true) return blocked('material_sources_unverified');
  if (hold) return blocked('hold');
  if (conflictingAuthority) return blocked('conflicting_authority');
  const action = instruction?.action;
  if (!['advance_interview', 'send_take_home'].includes(action)) return blocked('unsupported_advancement_action');
  const authorized = [SLACK_IDS.robin, SLACK_IDS.alexis, SLACK_IDS.aa, DHANA_ID,
    ...(action === 'send_take_home' ? [SLACK_IDS.project] : [])];
  if (!sourced(person, occurrenceId, instruction) || instruction.explicit !== true ||
      !authorized.includes(instruction.authorId)) return blocked('explicit_authorized_instruction_required');
  const occurred = atOrNull(instruction.occurredAt), current = atOrNull(now);
  if (occurred === null || current === null || occurred > current) return blocked('instruction_timing_unverified');
  return permitted({ action, candidatePageId: person.pageId, candidateEmail: person.email, occurrenceId,
    authorId: instruction.authorId, sourceUrl: instruction.sourceUrl, sendsInterviewEmail: false });
}

export function takeHomeRequestKey({ candidate, occurrenceId }) {
  const person = canonicalCandidate(candidate);
  if (!present(occurrenceId)) throw new TypeError('Take-home attempt ID required');
  return `usam:take-home:v1:${digest([person.pageId, occurrenceId, 'send_take_home', [person.email]])}`;
}

/** Link creation and delivery are distinct. Failed delivery never requests a new link. */
export function evaluateTakeHomeDelivery(input = {}) {
  const authority = evaluateAdvanceInstruction(input);
  if (!authority.allowed) return authority;
  if (authority.action !== 'send_take_home') return blocked('take_home_instruction_required');
  const person = canonicalCandidate(input.candidate), occurrenceId = input.occurrenceId;
  const key = takeHomeRequestKey(input);
  const extra = { requestKey: key, sendsEmail: false, changesPortal: false };
  const { portal, scorecard, invitationCheck, ownership, template } = input;
  if (!sourced(person, occurrenceId, portal)) return blocked('portal_state_unverified', extra);
  if (!sourced(person, occurrenceId, scorecard) || scorecard.type !== 'Take-home' ||
      scorecard.assessmentKind !== 'Scorecard' || !present(scorecard.pageId)) return blocked('applicable_scorecard_unverified', extra);
  try {
    if (canonicalPageId(portal.scorecardPageId) !== canonicalPageId(scorecard.pageId)) throw new Error();
  } catch { return blocked('portal_scorecard_link_unverified', extra); }
  if (!sourced(person, occurrenceId, invitationCheck) || invitationCheck.sentSearchCompleted !== true) return blocked('prior_invitation_unverified', extra);
  if (invitationCheck.state === 'sent') return blocked('take_home_already_sent', extra);
  if (!['not_sent', 'failed_before_send'].includes(invitationCheck.state)) return blocked('delivery_requires_reconciliation', extra);
  if (ownership?.state !== 'owned' || ownership.requestKey !== key || ownership.current !== true) return blocked('delivery_ownership_unverified', extra);
  if (portal.linkState === 'verified_absent') return portal.link != null
    ? blocked('contradictory_link_state', extra)
    : permitted({ ...extra, action: 'create_and_persist_candidate_link',
      deliveryAllowed: false, mustReuseCreatedLink: true });
  if (portal.linkState !== 'existing' || !sourced(person, occurrenceId, portal.link)) return blocked('link_state_requires_reconciliation', extra);
  let url;
  try { url = new URL(portal.link.url); if (url.protocol !== 'https:' || url.username || url.password) throw new Error(); }
  catch { return blocked('assignment_link_invalid', extra); }
  const link = portal.link.url;
  if (portal.link.persisted !== true) return blocked('assignment_link_not_persisted', { ...extra, link });
  if (invitationCheck.checkedAssignmentLink !== link) return blocked('exact_link_sent_reconciliation_required', { ...extra, link });
  if (!sourced(person, occurrenceId, template) || template.approved !== true || template.renderedVerified !== true ||
      template.signatureVerified !== true || template.recipient !== person.email || template.ccRulesVerified !== true ||
      template.exactAssignmentLink !== link || template.sender !== 'project@company.example') return blocked('approved_email_content_unverified', { ...extra, link });
  return permitted({ ...extra, action: 'deliver_approved_take_home_via_existing_sender', link,
    deliveryAllowed: true, mustReuseCreatedLink: true, requiresGmailSentReadback: true });
}

export function evaluateSubmissionGrading({ candidate, occurrenceId, submission, humanReview,
  latestStateVerified, route, requestReceipt, hold = false } = {}) {
  const person = candidateOrNull(candidate);
  if (!person) return blocked('missing_or_invalid_identity');
  if (candidate.isDemo === true || candidate.isTest === true) return blocked('excluded_candidate');
  if (hold) return blocked('hold');
  if (latestStateVerified !== true || !sourced(person, occurrenceId, submission) ||
      submission.uploaded !== true || !present(submission.submissionId) || !present(submission.url)) return blocked('submission_unverified');
  const dispatchOccurrenceId = `${occurrenceId}:submission:${submission.submissionId}`;
  const key = requestKey({ candidate: person, occurrenceId: dispatchOccurrenceId,
    action: 'takehome.grading_request', recipientIds: [DHANA_ID] });
  const extra = { requestKey: key, updatesPortal: false, updatesPortalScore: false,
    recipientId: DHANA_ID, submissionUrl: submission.url };
  if (humanReview && (!sourced(person, occurrenceId, humanReview) ||
      humanReview.submissionId !== submission.submissionId)) return blocked('human_review_evidence_unverified', extra);
  if (humanReview?.kind === 'human' && humanReview.completed === true && slackUser(humanReview.authorId)) return blocked('submission_already_human_reviewed', extra);
  if (humanReview?.kind === 'human' && humanReview.completed === true) return blocked('human_review_author_unverified', extra);
  if (requestReceipt) return sourced(person, occurrenceId, requestReceipt) && requestReceipt.requestKey === key &&
    requestReceipt.state === 'sent' ? blocked('grading_request_already_sent', extra)
      : blocked('grading_request_delivery_requires_reconciliation', extra);
  if (!privateRoute(route, DHANA_ID)) return blocked('grader_private_route_unverified', extra);
  return permitted({ ...extra, action: 'request_private_grading', dispatchAction: 'takehome.grading_request',
    occurrenceId: dispatchOccurrenceId, assessmentOccurrenceId: occurrenceId, conversationId: route.conversationId });
}

const STATUS = Object.freeze({
  assignment_pending: ['Needs Project', '🔴 Red'],
  request_delivered: ['Waiting on Candidate', '🟡 Yellow'],
  booking_verified: ['Meeting Booked', '🟣 Purple'],
  interview_completed: ['Awaiting Feedback', '🔵 Blue'],
});
const RECRUITING_SOURCE = 'c4d27962-20e2-49ce-b694-f3b4cacddc05';
const hasOption = (property, value) => Array.isArray(property?.options) &&
  property.options.some(option => (typeof option === 'string' ? option : option?.name) === value);

/**
 * Candidate brief and Next action are existing Notion text properties. Do not
 * invent editor blocks or change the page layout. The live Color mode schema
 * says Automatic follows Action Status; selecting a Dot color creates a manual
 * override. Preserve BOTH color properties, even for Automatic records.
 * statusColorLabel is display metadata using verified option labels, never a
 * property patch. The adapter must re-fetch/check the schema before writing.
 */
export function planConciseCandidateUpdate({ candidate, occurrenceId, layout, record,
  briefBullets, nextAction, statusEvidence, source, inputKind, previewConfirmation } = {}) {
  const person = candidateOrNull(candidate);
  if (!person) return blocked('missing_or_invalid_identity');
  if (!sourced(person, occurrenceId, layout) || layout.dataSourceId !== RECRUITING_SOURCE ||
      layout.properties?.['Candidate brief']?.type !== 'text' || layout.properties?.['Next action']?.type !== 'text' ||
      !sourced(person, occurrenceId, record) || !['Automatic', 'Manual override'].includes(record.colorMode) ||
      layout.properties?.['Color mode']?.type !== 'select' || !hasOption(layout.properties['Color mode'], record.colorMode) ||
      layout.properties?.['Dot color']?.type !== 'select' || !hasOption(layout.properties['Dot color'], record.dotColor)) return blocked('existing_layout_or_record_unverified');
  if (!sourced(person, occurrenceId, source) || !slackUser(source.authorId) ||
      atOrNull(source.occurredAt) === null || !present(source.sourceEventId) || !present(source.rawText)) return blocked('feedback_source_unverified');
  if (!Array.isArray(briefBullets) || briefBullets.length < 3 || briefBullets.length > 6 ||
      briefBullets.some(b => !present(b) || b.length > 240 || /[\r\n]/.test(b) || !/^[^:]{1,40}: \S/.test(b)) ||
      !present(nextAction) || nextAction.length > 400) return blocked('concise_update_required');
  if (!['structured', 'direct_command', 'pasted_notes'].includes(inputKind)) return blocked('input_kind_unverified');
  const previewKey = digest([person.pageId, occurrenceId, briefBullets, nextAction, source.sourceUrl]);
  if (inputKind === 'pasted_notes') {
    if (briefBullets.length > 5) return blocked('pasted_preview_requires_three_to_five_bullets');
    if (!sourced(person, occurrenceId, previewConfirmation) || !slackUser(previewConfirmation.authorId) ||
        atOrNull(previewConfirmation.confirmedAt) === null || previewConfirmation.confirmed !== true ||
        previewConfirmation.previewKey !== previewKey) return blocked('editable_preview_confirmation_required',
      { previewKey, preview: { briefBullets: [...briefBullets], nextAction } });
  }
  const properties = { 'Candidate brief': briefBullets.join('\n'), 'Next action': nextAction };
  let statusColorLabel = null;
  if (statusEvidence) {
    if (!sourced(person, occurrenceId, statusEvidence) || !Object.hasOwn(STATUS, statusEvidence.kind)) return blocked('action_status_evidence_unverified');
    const guards = {
      assignment_pending: () => present(statusEvidence.task) && slackUser(statusEvidence.ownerId),
      request_delivered: () => statusEvidence.delivered === true && statusEvidence.candidateOwesAction === true,
      booking_verified: () => statusEvidence.activeBooking === true && present(statusEvidence.bookingId),
      interview_completed: () => statusEvidence.actuallyCompleted === true && statusEvidence.feedbackPending === true,
    };
    if (!guards[statusEvidence.kind]()) return blocked('action_status_fact_unverified');
    const [status, color] = STATUS[statusEvidence.kind];
    if (layout.properties?.['Action Status']?.type !== 'select' ||
        !hasOption(layout.properties['Action Status'], status) ||
        !hasOption(layout.properties['Dot color'], color)) return blocked('action_status_schema_mismatch');
    properties['Action Status'] = status;
    statusColorLabel = color;
  }
  return permitted({ previewKey, properties, statusColorLabel, preservesColorSelection: true,
    historySource: { sourceUrl: source.sourceUrl, candidatePageId: person.pageId, occurrenceId,
      sourceEventId: source.sourceEventId, authorId: source.authorId, occurredAt: source.occurredAt,
      rawText: source.rawText, parsedBrief: [...briefBullets],
      ...(inputKind === 'pasted_notes' ? { confirmation: { authorId: previewConfirmation.authorId,
        confirmedAt: previewConfirmation.confirmedAt, sourceUrl: previewConfirmation.sourceUrl, previewKey } } : {}) },
    requiresReadback: true, replacesLayout: false, changesStage: false });
}
