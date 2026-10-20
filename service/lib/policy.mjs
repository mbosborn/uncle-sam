import { createHash } from 'node:crypto';

// Pure guards only. Adapters must obtain verified facts and persist delivery receipts.
export const SLACK_IDS = Object.freeze({
  robin: 'U0A4F08721B', alexis: 'U0476A5BC82', jamie: 'U0CB213D6D6',
  aa: 'U0BF89D1279', project: 'U0F9EF97D89',
});
export const REQUIRED_TRIAL_DOCUMENTS = Object.freeze([
  'nda', 'ciiaa', 'terms_of_work', 'work_trial_agreement',
]);
const DAY = 86_400_000;
const blocked = (reason, extra = {}) => ({ allowed: false, reason, ...extra });
const permitted = (extra = {}) => ({ allowed: true, reason: null, ...extra });
const present = value => typeof value === 'string' && value.trim().length > 0;

export function canonicalPageId(value) {
  if (!present(value)) throw new TypeError('Candidate page ID is required');
  const compact = value.trim().replaceAll('-', '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(compact)) throw new TypeError('Invalid candidate page ID');
  return compact.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
}

export function canonicalCandidate(candidate) {
  if (!candidate || candidate.emailVerified !== true || !present(candidate.fullName)) {
    throw new TypeError('Full candidate name and verified email are required');
  }
  const email = candidate.email?.trim();
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new TypeError('A verified candidate email is required');
  }
  // Preserve the local part; do not conflate aliases or similarly named candidates.
  const at = email.lastIndexOf('@');
  return { pageId: canonicalPageId(candidate.pageId), fullName: candidate.fullName.trim(),
    email: email.slice(0, at) + email.slice(at).toLowerCase(), emailVerified: true };
}

function identity(candidate) {
  try { return { candidate: canonicalCandidate(candidate) }; }
  catch (error) { return { error: blocked('missing_or_invalid_identity', { detail: error.message }) }; }
}

function matchesCandidate(candidate, evidence) {
  try {
    return canonicalPageId(evidence.candidatePageId) === candidate.pageId &&
      canonicalCandidate({ ...candidate, pageId: evidence.candidatePageId,
        email: evidence.candidateEmail }).email === candidate.email;
  } catch { return false; }
}

/** Semantic identity survives process restarts, duplicate sources and policy edits. */
export function requestKey({ candidate, occurrenceId, action, recipientIds }) {
  const { pageId } = canonicalCandidate(candidate);
  if (!present(occurrenceId) || !present(action)) throw new TypeError('Occurrence and action are required');
  if (!Array.isArray(recipientIds) || !recipientIds.length ||
      recipientIds.some(id => typeof id !== 'string' || !/^[UW][A-Z0-9]+$/.test(id))) {
    throw new TypeError('Verified Slack recipient IDs are required');
  }
  const recipients = [...new Set(recipientIds)].sort();
  const canonical = JSON.stringify([pageId, occurrenceId.trim(), action.trim(), recipients]);
  return `usam:v1:${createHash('sha256').update(canonical).digest('hex')}`;
}

function validDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === date;
}

/** ISO datetime with explicit offset. Date-only and implicit local time are rejected. */
export function instantMs(value, precision = 'exact') {
  if (typeof value !== 'string') throw new TypeError('Explicit datetime with timezone required');
  const m = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/);
  if (!m || !validDate(m[1]) || +m[2] > 23 || +m[3] > 59 || (m[4] && +m[4] > 59)) {
    throw new TypeError('Invalid explicit datetime');
  }
  if (m[6] !== 'Z' && (+m[6].slice(1, 3) > 23 || +m[6].slice(4) > 59)) {
    throw new TypeError('Invalid timezone offset');
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new TypeError('Invalid datetime');
  const effectivePrecision = precision;
  if (!['exact', 'minute', 'second'].includes(effectivePrecision)) throw new TypeError('Invalid precision');
  // Truncated timestamps describe a bucket; use its upper edge, never an early boundary.
  const unit = effectivePrecision === 'minute' ? 60_000 : effectivePrecision === 'second' ? 1000 : 0;
  return unit ? Math.floor(ms / unit) * unit + unit : ms;
}

function boundaryMs(value, precision) {
  if (precision !== undefined && !['exact', 'minute', 'second'].includes(precision)) {
    throw new TypeError('Invalid precision');
  }
  // A caller cannot restore seconds that the source representation omitted.
  const minuteOnly = typeof value === 'string' && /T\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(value);
  return instantMs(value, minuteOnly ? 'minute' : precision ?? 'exact');
}

function validZone(timeZone) {
  if (!present(timeZone)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone }).format(0); return true; }
  catch { return false; }
}

export function localDate(value, timeZone) {
  if (!validZone(timeZone)) throw new TypeError('Valid trial timezone required');
  if (typeof value === 'string' && validDate(value)) return value;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit',
    day: '2-digit' }).formatToParts(new Date(instantMs(value)));
  const get = type => parts.find(part => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function nextCalendarDate(date) {
  if (!validDate(date)) throw new TypeError('Valid calendar date required');
  return new Date(Date.parse(`${date}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
}

export function modeGate({ mode, baselineComplete, activatedAt, eventOccurredAt,
  baselined = false, isFixture = false, connectionsReady, routingReady } = {}) {
  if (mode === 'Off') return blocked('mode_off');
  if (mode === 'Test') return isFixture === true
    ? permitted({ dryRun: true, liveActionsAllowed: false }) : blocked('test_requires_fixture');
  if (mode !== 'Live') return blocked('invalid_mode');
  if (isFixture) return blocked('fixture_in_live');
  if (baselineComplete !== true) return blocked('baseline_incomplete');
  if (connectionsReady !== true || routingReady !== true) return blocked('connections_or_routing_unverified');
  if (baselined) return blocked('historical_baseline');
  try {
    if (instantMs(eventOccurredAt) < instantMs(activatedAt)) return blocked('before_activation');
  } catch { return blocked('activation_or_event_time_unverified'); }
  return permitted({ dryRun: false, liveActionsAllowed: true });
}

/** Natural language is parsed elsewhere; an affirmative reply must match this exact scope. */
export function validateScopedConfirmation({ candidate, occurrenceId, action, revision,
  contextId, confirmation, hold = false, conflictingAuthority = false } = {}) {
  const who = identity(candidate);
  if (who.error) return who.error;
  if (hold) return blocked('hold');
  if (conflictingAuthority) return blocked('conflicting_authority');
  if (!present(occurrenceId) || !present(action) || !present(revision) || !present(contextId)) {
    return blocked('missing_confirmation_scope');
  }
  const c = confirmation;
  if (!c || ![SLACK_IDS.robin, SLACK_IDS.alexis].includes(c.authorId)) return blocked('unauthorized_confirmer');
  if (c.affirmative !== true || c.superseded === true) return blocked('not_current_affirmative_confirmation');
  if (!matchesCandidate(who.candidate, c) || c.occurrenceId !== occurrenceId ||
      c.action !== action || c.revision !== revision || c.contextId !== contextId) {
    return blocked('confirmation_scope_mismatch');
  }
  if (!present(c.sourceUrl)) return blocked('missing_confirmation_evidence');
  try { boundaryMs(c.confirmedAt, c.precision); } catch { return blocked('missing_confirmation_time'); }
  return permitted({ authorId: c.authorId, sourceUrl: c.sourceUrl, confirmedAt: c.confirmedAt });
}

export function evaluateTrialAuthorization({ candidate, occurrenceId, instruction, dates,
  hold = false, holdReason, cancelled = false, conflictingAuthority = false } = {}) {
  const noStage = reason => blocked(reason, { stageAllowed: false, onboardingAllowed: false });
  const who = identity(candidate);
  if (who.error) return { ...who.error, stageAllowed: false, onboardingAllowed: false };
  if (cancelled) return noStage('trial_cancelled');
  if (conflictingAuthority) return noStage('conflicting_authority');
  const i = instruction;
  if (!i || i.authorId !== SLACK_IDS.robin || i.explicit !== true || i.current !== true ||
      i.action !== 'work_trial' || !present(occurrenceId) || i.occurrenceId !== occurrenceId ||
      !matchesCandidate(who.candidate, i) || !present(i.sourceUrl)) return noStage('rishi_trial_instruction_required');
  try { instantMs(i.occurredAt); } catch { return noStage('trial_instruction_time_unverified'); }
  const scope = { candidatePageId: who.candidate.pageId, candidateEmail: who.candidate.email, occurrenceId };
  const pause = (reason, extra = {}) => permitted({ ...scope, stageAllowed: true, onboardingAllowed: false,
    onboardingReason: reason, ...extra });
  if (hold) return pause('hold', { holdReason: present(holdReason) ? holdReason.trim() : 'Hold recorded; reason not supplied' });
  if (!dates || dates.candidateAgreed !== true || !present(dates.agreementSourceUrl)) {
    return pause('candidate_agreed_dates_required');
  }
  if (!matchesCandidate(who.candidate, dates) || dates.occurrenceId !== occurrenceId) {
    return pause('trial_date_agreement_scope_mismatch');
  }
  try {
    const start = localDate(dates.start, dates.timeZone);
    const end = localDate(dates.end, dates.timeZone);
    if (end < start || (!validDate(dates.start) && !validDate(dates.end) &&
      instantMs(dates.end) < instantMs(dates.start))) return pause('invalid_trial_date_order');
  } catch { return pause('trial_dates_or_timezone_unverified'); }
  return permitted({ ...scope, stageAllowed: true, onboardingAllowed: true, onboardingReason: null });
}

export function evaluateOnboardingReadiness({ candidate, occurrenceId, authorization, packetSent = false,
  signedDocuments = [], jamieReady = false, aaReady = false, combinedNoticeSent = false,
  hold = false, cancelled = false, exclusions = [] } = {}) {
  const who = identity(candidate);
  if (who.error) return who.error;
  if (combinedNoticeSent) return blocked('combined_notice_already_sent');
  if (cancelled) return blocked('trial_cancelled');
  if (hold) return blocked('hold');
  if (authorization?.onboardingAllowed !== true) return blocked('onboarding_not_authorized');
  if (!present(occurrenceId) || !matchesCandidate(who.candidate, authorization) ||
      authorization.occurrenceId !== occurrenceId) return blocked('onboarding_scope_mismatch');
  const itemIds = [...REQUIRED_TRIAL_DOCUMENTS.map(name => `${name}_signature`), 'jamie_onboarding', 'aa_okta'];
  if (!Array.isArray(exclusions)) return blocked('onboarding_exclusion_unverified');
  const notApplicable = new Set();
  const exclusionEvidence = [];
  for (const exclusion of exclusions) {
    if (!exclusion || exclusion.authorId !== SLACK_IDS.robin || exclusion.explicit !== true ||
        exclusion.current !== true || exclusion.superseded === true ||
        exclusion.action !== 'exclude_onboarding_item' || !itemIds.includes(exclusion.item) ||
        !matchesCandidate(who.candidate, exclusion) || exclusion.occurrenceId !== occurrenceId ||
        !present(exclusion.sourceUrl)) return blocked('onboarding_exclusion_unverified');
    try { instantMs(exclusion.occurredAt); } catch { return blocked('onboarding_exclusion_unverified'); }
    notApplicable.add(exclusion.item);
    exclusionEvidence.push({ item: exclusion.item, authorId: exclusion.authorId,
      sourceUrl: exclusion.sourceUrl, occurredAt: exclusion.occurredAt });
  }
  const signed = new Set(Array.isArray(signedDocuments) ? signedDocuments : []);
  const missingDocuments = REQUIRED_TRIAL_DOCUMENTS.filter(name => !signed.has(name));
  const pending = [...missingDocuments.map(name => `${name}_signature`),
    ...(jamieReady === true ? [] : ['jamie_onboarding']), ...(aaReady === true ? [] : ['aa_okta'])]
    .filter(item => !notApplicable.has(item));
  const result = { packetSent: packetSent === true, pending,
    notApplicable: [...notApplicable], exclusionEvidence };
  // Packet sent is intentionally independent of signatures and general setup readiness.
  return pending.length ? blocked('onboarding_incomplete', result)
    : permitted({ ...result, action: 'combined_readiness_notice' });
}

export function evaluateOffboarding({ candidate, occurrenceId, now, timeZone, latestConfirmedEnd,
  endEvidenceUrl, latestStateVerified, hired = false, cancelled = false, setupStarted = false,
  hold = false, offboardingConfirmation, reminderSentForSchedule } = {}) {
  const base = { requestAaRemoval: false, deletesAccess: false };
  const deny = (reason, extra = {}) => blocked(reason, { ...base, ...extra });
  const who = identity(candidate);
  if (who.error) return { ...who.error, ...base };
  if (!present(occurrenceId)) return deny('missing_trial_occurrence');
  if (latestStateVerified !== true) return deny('latest_trial_state_unverified');
  let current;
  try { current = instantMs(now); } catch { return deny('current_time_unverified'); }
  const c = offboardingConfirmation;
  if (c?.authorId === SLACK_IDS.jamie && c.explicit === true && c.action === 'offboarded' &&
      c.current === true && c.superseded !== true &&
      c.occurrenceId === occurrenceId && matchesCandidate(who.candidate, c) && present(c.sourceUrl)) {
    try {
      if (boundaryMs(c.confirmedAt, c.precision) > current) return deny('offboarding_confirmation_in_future');
      return deny('offboarding_complete', { completed: true });
    }
    catch { return deny('offboarding_confirmation_time_unverified'); }
  }
  if (hold) return deny('hold');
  if (hired) return deny('hire_continues_access');
  if (cancelled) return setupStarted
    ? permitted({ ...base, action: 'request_jamie_cleanup', completed: false })
    : deny('cancelled_before_setup');
  if (!present(endEvidenceUrl)) return deny('trial_end_unverified');
  try {
    const endDate = localDate(latestConfirmedEnd, timeZone);
    const dueDate = nextCalendarDate(endDate);
    const today = localDate(now, timeZone);
    const scheduleKey = JSON.stringify([occurrenceId, timeZone, endDate]);
    if (reminderSentForSchedule === scheduleKey) return deny('offboarding_reminder_already_sent', { dueDate, scheduleKey });
    if (today < dueDate) return deny('offboarding_not_due', { dueDate, scheduleKey });
    return permitted({ ...base, action: 'remind_jamie_offboarding', dueDate, scheduleKey, completed: false });
  } catch { return deny('trial_end_or_timezone_unverified'); }
}

/** Eligibility information for the EXISTING sender; this module never sends email. */
export function evaluateRejectionEligibility({ candidate, occurrenceId, revision, contextId,
  confirmation, decisionAt, decisionPrecision, latestInterviewEnd, now,
  outcome, hold = false, conflictingAuthority = false, historical = false,
  priorSendVerified = false, recipientChanged = false, deliveryState,
  sourceAccessVerified } = {}) {
  const denied = reason => blocked(reason, { sender: 'existing_rejection_agent', sendsEmail: false });
  if (hold) return denied('hold');
  if (historical || deliveryState === 'Historical - no auto-send') return denied('historical_rejection');
  if (outcome !== 'Not Selected') return denied('outcome_not_rejected');
  if (priorSendVerified || deliveryState === 'Sent') return denied('rejection_already_sent');
  if (recipientChanged) return denied('recipient_changed');
  if (['Sending', 'Uncertain', 'Needs attention', 'Cancelled'].includes(deliveryState)) return denied('delivery_requires_reconciliation');
  if (![undefined, null, '', 'Scheduled'].includes(deliveryState)) return denied('unknown_delivery_state');
  if (sourceAccessVerified !== true) return denied('material_sources_unverified');
  const confirmed = validateScopedConfirmation({ candidate, occurrenceId, action: 'reject', revision,
    contextId, confirmation, conflictingAuthority });
  if (!confirmed.allowed) return denied(confirmed.reason);
  const end = latestInterviewEnd;
  if (!end || end.verified !== true || end.actuallyCompleted !== true || end.isLatest !== true ||
      !present(end.sourceUrl)) return denied('latest_actual_interview_end_unverified');
  if (!matchesCandidate(canonicalCandidate(candidate), end) || end.occurrenceId !== occurrenceId) {
    return denied('interview_end_scope_mismatch');
  }
  try {
    const actualEnd = boundaryMs(end.at, end.precision);
    const current = instantMs(now);
    if (actualEnd > current) return denied('actual_interview_end_in_future');
    const decision = Math.max(boundaryMs(decisionAt, decisionPrecision),
      boundaryMs(confirmation.confirmedAt, confirmation.precision));
    if (decision > current) return denied('decision_in_future');
    const eligibleAt = new Date(Math.max(decision, actualEnd + DAY)).toISOString();
    const extra = { eligibleAt, sender: 'existing_rejection_agent', sendsEmail: false };
    return current >= Date.parse(eligibleAt) ? permitted(extra) : blocked('rejection_not_due', extra);
  } catch { return denied('rejection_timing_unverified'); }
}
