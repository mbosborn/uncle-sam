import { canonicalCandidate, canonicalPageId, instantMs, validateScopedConfirmation } from './policy.mjs';

export const REJECTION_SENDER = 'existing_rejection_agent';
const DAY = 86_400_000;
const PEOPLE = new Set(['U0F9EF97D89', 'U0A4F08721B', 'U0476A5BC82', 'U0BF89D1279', 'U030A09DBFF', 'U0CB213D6D6']);
const REQUIRED = ['resolveEvidence', 'readControls', 'readCandidate', 'claim', 'authorizeClaim',
  'appendEvidence', 'readEvidence', 'patchCandidate', 'readSenderReceipt', 'finishClaim', 'markUncertain'];
const present = value => typeof value === 'string' && value.trim().length > 0;
const samePage = (a, b) => { try { return canonicalPageId(a) === canonicalPageId(b); } catch { return false; } };
const failure = reason => ({ status: 'blocked', reason, sender: REJECTION_SENDER, sendsEmail: false });
const url = value => { try { return new URL(value).protocol === 'https:'; } catch { return false; } };
const ceilMinute = ms => Math.ceil(ms / 60_000) * 60_000;

class HandoffError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const requireFact = (condition, reason) => { if (!condition) throw new HandoffError(reason); };

function conservativeTime(value, precision) {
  const minuteOnly = typeof value === 'string' && /T\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(value);
  return instantMs(value, minuteOnly ? 'minute' : precision ?? 'exact');
}

function eventTime(value, now, precision) {
  let ms;
  try { ms = conservativeTime(value, precision); } catch { throw new HandoffError('invalid_evidence_time'); }
  requireFact(ms <= now, 'future_evidence');
  return ms;
}

function contextOf(raw, input, kind, now) {
  requireFact(raw && raw.eventId === input.eventId && raw.kind === kind && raw.current === true &&
    raw.sourceAccessVerified === true && raw.isFixture === false && raw.historical === false &&
    present(raw.requestKey) && present(raw.revision), 'trusted_evidence_required');
  let candidate;
  try { candidate = canonicalCandidate(raw.candidate); } catch { throw new HandoffError('identity_unverified'); }
  const occurredAtMs = eventTime(raw.occurredAt, now, raw.occurredAtPrecision);
  requireFact(PEOPLE.has(raw.authorId) && url(raw.sourceUrl), 'source_identity_unverified');
  const common = { candidate, eventId: raw.eventId, requestKey: raw.requestKey, revision: raw.revision,
    occurredAt: raw.occurredAt, occurredAtMs, sourceUrl: raw.sourceUrl, authorId: raw.authorId, kind };
  if (kind === 'hold') {
    requireFact(raw.explicitHold === true && raw.candidateScopeVerified === true, 'exact_hold_required');
    return { ...common, evidence: { kind, eventId: raw.eventId, candidatePageId: candidate.pageId,
      candidateEmail: candidate.email, sourceUrl: raw.sourceUrl, authorId: raw.authorId,
      occurredAt: raw.occurredAt, occurredAtPrecision: raw.occurredAtPrecision ?? 'exact', revision: raw.revision } };
  }
  requireFact(raw.priorSendVerified === false && raw.conflictingAuthority === false && raw.hold === false,
    'current_decision_or_prior_send_unverified');
  const confirmed = validateScopedConfirmation({ candidate, occurrenceId: raw.occurrenceId,
    action: 'reject', revision: raw.revision, contextId: raw.contextId, confirmation: raw.confirmation });
  requireFact(confirmed.allowed, confirmed.reason ?? 'confirmation_unverified');
  requireFact(raw.confirmation.current === true && raw.confirmation.authorId === raw.authorId &&
    raw.confirmation.sourceUrl === raw.sourceUrl && raw.confirmation.sourceEventId === input.eventId,
    'confirmation_source_mismatch');
  const confirmedMs = eventTime(raw.confirmation.confirmedAt, now, raw.confirmation.precision);
  requireFact(confirmedMs === occurredAtMs, 'confirmation_event_time_mismatch');
  const end = raw.latestInterviewEnd;
  requireFact(end && end.verified === true && end.actuallyCompleted === true && end.isLatest === true &&
    end.laterInterviewUnresolved === false && samePage(end.candidatePageId, candidate.pageId) &&
    end.candidateEmail === candidate.email && end.occurrenceId === raw.occurrenceId && url(end.sourceUrl),
    'latest_actual_interview_end_unverified');
  let endMs;
  try {
    endMs = conservativeTime(end.at, end.precision);
  } catch { throw new HandoffError('interview_time_unverified'); }
  requireFact(endMs <= now, 'future_interview_end');
  const evidence = { kind, eventId: raw.eventId, candidatePageId: candidate.pageId,
    candidateEmail: candidate.email, fullName: candidate.fullName, occurrenceId: raw.occurrenceId,
    contextId: raw.contextId, revision: raw.revision, sourceUrl: raw.sourceUrl, authorId: raw.authorId,
    confirmedAt: raw.confirmation.confirmedAt, confirmationPrecision: raw.confirmation.precision ?? 'exact',
    occurredAt: raw.occurredAt, occurredAtPrecision: raw.occurredAtPrecision ?? 'exact', interviewEndSource: end.sourceUrl,
    interviewEndOriginal: end.at, interviewEndPrecision: end.precision ?? 'exact',
    interviewEndStored: new Date(ceilMinute(endMs)).toISOString() };
  return { ...common, evidence, endMs };
}

function checkCandidate(page, ctx, kind) {
  requireFact(page && samePage(page.pageId, ctx.candidate.pageId) && page.email === ctx.candidate.email &&
    page.archived === false && page.isFixture === false, 'candidate_identity_or_state_unverified');
  requireFact(typeof page.rejection?.hold === 'boolean', 'current_hold_unverified');
  if (kind === 'hold') return;
  requireFact(page.rejection.hold === false, 'current_hold');
  requireFact(page.priorSendVerified === false, 'prior_send_unverified');
  requireFact(!['Withdrawn or Unavailable', 'On Hold', 'Hired'].includes(page.outcome), 'current_outcome_blocks_rejection');
  requireFact(['Not Yet Decided', 'Proceeding', 'Not Selected'].includes(page.outcome), 'current_outcome_unverified');
  requireFact([null, '', 'Scheduled'].includes(page.rejection.status), 'delivery_requires_reconciliation');
  requireFact(page.outcome === 'Not Selected' || page.rejection.status !== 'Scheduled', 'queue_outcome_conflict');
  if (page.lastInterviewEndedAt) {
    let storedEnd;
    try { storedEnd = instantMs(page.lastInterviewEndedAt); } catch { throw new HandoffError('current_interview_timing_conflict'); }
    requireFact(storedEnd <= instantMs(ctx.evidence.interviewEndStored), 'current_interview_timing_conflict');
  }
}

function checkControls(controls, ctx, now) {
  for (const name of ['runtime', 'notion']) {
    const control = controls?.[name];
    requireFact(control?.mode === 'Live', `${name}_not_live`);
    requireFact(control.baselineComplete === true && control.connectionsReady === true,
      `${name}_baseline_or_connections_unverified`);
    const activated = eventTime(control.activatedAt, now);
    requireFact(ctx.occurredAtMs >= activated, 'before_activation');
  }
}

function senderState(receipt, ctx, now) {
  requireFact(receipt?.source === REJECTION_SENDER && receipt.readbackVerified === true &&
    samePage(receipt.candidatePageId, ctx.candidate.pageId), 'sender_receipt_unverified');
  if (receipt.status === 'Needs attention') return { status: 'needs_attention', reason: 'existing_sender_needs_attention' };
  const event = receipt.genuineEvent;
  requireFact(event?.type === 'outcome_change' && samePage(event.candidatePageId, ctx.candidate.pageId) &&
    ['Not Yet Decided', 'Proceeding'].includes(event.beforeOutcome) && event.afterOutcome === 'Not Selected',
    'genuine_sender_event_unverified');
  const decisionMs = eventTime(event.occurredAt, now, event.precision);
  requireFact(decisionMs >= ctx.occurredAtMs && receipt.queuedTo === ctx.candidate.email &&
    receipt.decisionKey === `${ctx.candidate.pageId}|${event.occurredAt}`, 'sender_decision_scope_mismatch');
  const storedDecision = eventTime(receipt.decisionAt, now, receipt.decisionPrecision);
  requireFact(storedDecision >= decisionMs && storedDecision <= ceilMinute(decisionMs), 'sender_decision_time_mismatch');
  let due;
  // A stored deadline must itself be explicit and conservative; do not round an
  // early saved deadline up in our readback and then claim the sender is safe.
  try { due = instantMs(receipt.scheduledFor); } catch { throw new HandoffError('sender_deadline_unverified'); }
  requireFact(due >= Math.max(ctx.occurredAtMs, decisionMs, storedDecision,
    instantMs(ctx.evidence.interviewEndStored) + DAY), 'sender_deadline_too_early');
  requireFact(typeof receipt.hold === 'boolean', 'sender_hold_unverified');
  if (receipt.status === 'Scheduled') return { status: receipt.hold ? 'held' : 'scheduled',
    scheduledFor: receipt.scheduledFor, decisionKey: receipt.decisionKey };
  if (receipt.status === 'Sent') {
    const sent = receipt.sent;
    requireFact(sent?.verified === true && sent.from === 'project@company.example' &&
      sent.to === ctx.candidate.email && Array.isArray(sent.cc) && sent.cc.length === 0 &&
      Array.isArray(sent.bcc) && sent.bcc.length === 0 && url(sent.messageUrl) &&
      (sent.precision === undefined || sent.precision === 'exact') &&
      /T\d{2}:\d{2}:\d{2}/.test(sent.at ?? '') &&
      eventTime(sent.at, now) >= due, 'sender_sent_evidence_unverified');
    return { status: 'sent', sentAt: sent.at, messageUrl: sent.messageUrl, decisionKey: receipt.decisionKey };
  }
  throw new HandoffError('sender_handoff_not_verified');
}

/**
 * Bounded integration core only. Dependencies must be trusted server adapters, not
 * request JSON or model-provided facts. Claims are durable Operations/D1 receipts,
 * not a second email queue. No sender, draft, schedule or hold-release API exists.
 * readSenderReceipt must reconcile the existing sender's actual trigger/run data.
 * Notion writes are not atomic: a hold/pause after the last read can race an in-flight
 * Outcome patch; the existing sender's final recheck is still mandatory.
 */
export function createRejectionHandoff(deps = {}) {
  requireFact(REQUIRED.every(name => typeof deps[name] === 'function'), 'missing_handoff_dependency');
  const timeoutMs = deps.timeoutMs ?? 8000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new TypeError('Invalid timeout');
  const clock = deps.clock ?? Date.now;
  const call = async (name, args) => {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(() => deps[name]({ ...args, signal: controller.signal })),
        new Promise((_, reject) => { timer = setTimeout(() => {
          controller.abort(); reject(new HandoffError('adapter_timeout'));
        }, timeoutMs); })]);
    } finally { clearTimeout(timer); }
  };

  const run = async (kind, input = {}) => {
    if (input.dryRun === true) return { status: 'dry_run', validated: false, executed: false,
      sender: REJECTION_SENDER, sendsEmail: false, reason: 'no_adapters_called' };
    if (deps.env?.UNCLE_SAM_AUTOMATIC_ACTIVITY !== 'enabled') return failure('automatic_activity_disabled');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.eventId ?? '') ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.attemptId ?? '')) return failure('invalid_identifiers');
    let ctx, claimed = false, writeStarted = false, outcomeCommitted = false;
    const now = () => { const value = clock(); requireFact(Number.isSafeInteger(value) && value >= 0, 'invalid_clock'); return value; };
    const refresh = async ({ checkQueue = true } = {}) => {
      requireFact(deps.env?.UNCLE_SAM_AUTOMATIC_ACTIVITY === 'enabled', 'automatic_activity_disabled');
      const fresh = contextOf(await call('resolveEvidence', { eventId: input.eventId, kind }), input, kind, now());
      requireFact(JSON.stringify(fresh.evidence) === JSON.stringify(ctx.evidence), 'evidence_changed');
      const page = await call('readCandidate', { candidatePageId: ctx.candidate.pageId });
      if (checkQueue) checkCandidate(page, ctx, kind);
      else requireFact(page && samePage(page.pageId, ctx.candidate.pageId) && page.email === ctx.candidate.email,
        'candidate_identity_or_state_unverified');
      checkControls(await call('readControls', {}), ctx, now());
      requireFact((await call('authorizeClaim', { requestKey: ctx.requestKey, attemptId: input.attemptId }))?.allowed === true,
        'claim_or_pause_changed');
      return page;
    };
    const finish = async result => {
      requireFact((await call('finishClaim', { requestKey: ctx.requestKey, attemptId: input.attemptId,
        result: { ...result, outcomeCommitted } }))?.recorded === true, 'handoff_receipt_not_persisted');
      return { ...result, outcomeCommitted, sender: REJECTION_SENDER, sendsEmail: false };
    };
    try {
      ctx = contextOf(await call('resolveEvidence', { eventId: input.eventId, kind }), input, kind, now());
      checkControls(await call('readControls', {}), ctx, now());
      const current = await call('readCandidate', { candidatePageId: ctx.candidate.pageId });
      checkCandidate(current, ctx, kind);
      requireFact((await call('claim', { requestKey: ctx.requestKey, eventId: input.eventId,
        attemptId: input.attemptId, kind }))?.claimed === true, 'handoff_not_claimable');
      claimed = true;

      // A repeated event never toggles Outcome away and back to manufacture a trigger.
      if (kind === 'rejection' && current.outcome === 'Not Selected') {
        return await finish({ ...senderState(await call('readSenderReceipt', { candidatePageId: ctx.candidate.pageId }), ctx, now()), reused: true });
      }

      if (kind === 'hold') {
        await refresh();
        writeStarted = true;
        await call('patchCandidate', { candidatePageId: ctx.candidate.pageId,
          properties: { 'Rejection email hold': true } });
        const held = await call('readCandidate', { candidatePageId: ctx.candidate.pageId });
        checkCandidate(held, ctx, kind);
        requireFact(held.rejection.hold === true, 'hold_readback_failed');
        // Never rewrite status, attempts, sent-at or message URL, even if already Sent.
        await refresh();
        await call('appendEvidence', { candidatePageId: ctx.candidate.pageId, requestKey: ctx.requestKey,
          attemptId: input.attemptId, evidence: ctx.evidence });
        const saved = await call('readEvidence', { candidatePageId: ctx.candidate.pageId, requestKey: ctx.requestKey });
        requireFact(JSON.stringify(saved?.evidence) === JSON.stringify(ctx.evidence), 'evidence_readback_failed');
        return await finish({ status: 'held', deliveryAlreadySent: held.rejection.status === 'Sent' });
      }

      await refresh();
      writeStarted = true;
      await call('appendEvidence', { candidatePageId: ctx.candidate.pageId, requestKey: ctx.requestKey,
        attemptId: input.attemptId, evidence: ctx.evidence });
      const saved = await call('readEvidence', { candidatePageId: ctx.candidate.pageId, requestKey: ctx.requestKey });
      requireFact(JSON.stringify(saved?.evidence) === JSON.stringify(ctx.evidence), 'evidence_readback_failed');
      await refresh();
      await call('patchCandidate', { candidatePageId: ctx.candidate.pageId, properties: {
        'Last interview ended at': ctx.evidence.interviewEndStored,
        'Interview timing source': ctx.evidence.interviewEndSource,
      } });
      const timed = await refresh();
      requireFact(timed.lastInterviewEndedAt === ctx.evidence.interviewEndStored &&
        timed.interviewTimingSource === ctx.evidence.interviewEndSource, 'timing_readback_failed');
      requireFact(timed.outcome !== 'Not Selected', 'outcome_changed_during_handoff');
      await call('patchCandidate', { candidatePageId: ctx.candidate.pageId, properties: { Outcome: 'Not Selected' } });
      outcomeCommitted = true;
      const outcome = await call('readCandidate', { candidatePageId: ctx.candidate.pageId });
      requireFact(outcome && samePage(outcome.pageId, ctx.candidate.pageId) && outcome.email === ctx.candidate.email &&
        outcome.outcome === 'Not Selected', 'outcome_readback_failed');
      const receipt = await call('readSenderReceipt', { candidatePageId: ctx.candidate.pageId });
      return await finish({ ...senderState(receipt, ctx, now()), reused: false });
    } catch (error) {
      const reason = error instanceof HandoffError ? error.code : 'handoff_adapter_failed';
      if (!claimed) return failure(reason);
      // Even an evidence write can finish after a timeout. Preserve the reservation
      // and reconcile before retrying; never recreate the sender event blindly.
      let uncertaintyRecorded = false;
      try { uncertaintyRecorded = (await call('markUncertain', { requestKey: ctx.requestKey,
        attemptId: input.attemptId, reason, outcomeCommitted, writeStarted }))?.recorded === true; } catch {}
      return { status: 'needs_attention', reason, uncertaintyRecorded, outcomeCommitted,
        writesMayHaveCompleted: writeStarted, sender: REJECTION_SENDER, sendsEmail: false };
    }
  };
  return Object.freeze({ handoff: input => run('rejection', input), hold: input => run('hold', input) });
}
