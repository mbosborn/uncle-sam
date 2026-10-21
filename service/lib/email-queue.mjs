/**
 * Every automatic email to a work trialer waits 30 minutes before it goes, quietly, so Project can still stop it (Project,
 * 2026-10-20: "even if he says roger that for automated emails they should delay 30 minutes but i don't need to know that" /
 * "just in case i do want to cancel" / "i don't need a reminder asking if i want to cancel").
 *
 *  - The work-trial documents and their confirmation email (docusign-send.mjs via runtime's packets.send) are queued here
 *    (kv emailq:packet:<pageId>) and sent on the first run 30 minutes later, after the record is read again: closed, On Hold, an
 *    unanswered pay concern (trial-terms.mjs) or paperwork already out -> not sent. Nothing is said when it goes; Project hears
 *    only if it couldn't.
 *  - The invitation (trial-invite.mjs), the payout setup email and its 24-hour reminder (payout-setup.mjs) keep their own queues
 *    with the same wait; the Company accounts email (onboarding.mjs) waits 30 minutes after its heads-up.
 *  - "cancel <name>" (or "stop" / "don't send") in Project's DM stops whatever is still waiting for that person; a bare "cancel"
 *    does it when exactly one person has something waiting.
 *  - holdReason: the one check every automatic email to a trialer makes when it is queued and again when it goes (closed,
 *    Stage Closed/Hired, On Hold, an unanswered pay concern). Project hears once per person, email and reason.
 */
import { noticeStore } from './stuck-rejections.mjs';

export const HOLD_MS = 30 * 60_000;
const CLOSED = ['Not Selected', 'Withdrawn or Unavailable', 'Hired'];
const firstOf = full => String(full ?? '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/[^\p{L}\s'.-]/gu, ' ').trim().split(/\s+/)[0] || 'them';
const dayOnly = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

/**
 * Why nothing may go to this person now: 'gone' (no record, or archived), 'closed' (Not Selected, Withdrawn, Hired),
 * 'stage_closed' (Stage Closed or Hired), 'on_hold', 'pay_concern' (an unanswered trial-terms.mjs hold), or null.
 */
export async function holdReason({ kv, candidate }) {
  if (!candidate || candidate.archived) return 'gone';
  const f = candidate.fields ?? {};
  if (CLOSED.includes(f.Outcome)) return 'closed';
  if (['Closed', 'Hired'].includes(f.Stage)) return 'stage_closed';
  if (f.Outcome === 'On Hold') return 'on_hold';
  if (candidate.pageId && kv && await kv.get(`trialterms:hold:${candidate.pageId}`)) return 'pay_concern';
  return null;
}
const HOLD_WORDS = { closed: 'they are closed on the tracker', stage_closed: 'they are closed on the tracker', on_hold: 'they are On Hold',
  pay_concern: 'they pushed back on the pay and haven\'t had an answer' };
/** "📋 I didn't send Priya's payout setup email: they are On Hold." */
export const holdText = (name, what, why, after = '') => `📋 I didn't send ${firstOf(name)}'s ${what}: ${HOLD_WORDS[why] ?? why}.${after ? ` ${after}` : ''}`;
/** Project told once per person, email and reason (never for a record that is gone). */
export async function tellHold({ kv, poster, pageId, name, what, why, now, after = '' }) {
  if (typeof poster !== 'function' || !why || why === 'gone') return false;
  if (!(await kv.claim(`holdtold:${what}:${pageId}:${why}`, { at: now }, now))) return false;
  await poster(holdText(name, what, why, after)).catch(() => {});
  return true;
}
/** The record, or { transient: true } when Notion could not be read (tried again next run); a missing page is null. */
export async function readCandidate(notion, pageId) {
  try { return { candidate: await notion.getCandidate(pageId) }; }
  catch (error) {
    const gone = ['notion_http_404', 'candidate_not_in_recruiting_source', 'invalid_page_id', 'invalid_candidate_page'].includes(error?.code);
    return gone ? { candidate: null } : { candidate: null, transient: true };
  }
}
/** A documents packet still waiting in this queue. */
export const packetWaiting = q => !!q && !q.done && !q.cancelled && !q.dropped && !q.validationBlocked && !q.deliveryUncertain && !q.dispatchingAt;

/** Queue documents at the approved rate. A forced rate correction replaces pending terms and restarts the delay. */
export async function queuePacket({ db, who, rate, clock = Date.now, force = false }) {
  const kv = noticeStore(db), now = clock();
  if (!who?.pageId) return { reason: 'no_candidate' };
  const key = `emailq:packet:${who.pageId}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const was = await kv.get(key);
    if (was?.dispatchingAt && !was.done) return { reason: 'dispatch_started', at: was.dispatchingAt };
    if (was?.validationBlocked || was?.deliveryUncertain) return { reason: 'held', at: was.at };
    const changedRate = Number.isFinite(rate) && rate >= 10 && rate <= 5000 && rate !== was?.rate;
    if (packetWaiting(was) && !(force && changedRate)) return { reason: 'already_queued', at: was.at };
    // Automatic rediscovery cannot undo a person's cancellation or compensation correction.
    if (was?.cancelled && !force) return { reason: 'cancelled', at: was.cancelled };
    const at = now + HOLD_MS;
    const next = { kind: 'packet', pageId: who.pageId, email: who.email ?? null, name: who.fullName ?? null, rate,
      trialStart: who.trialStart ?? null, trialEnd: who.trialEnd ?? null, at, queuedAt: now, revision: crypto.randomUUID() };
    if (await kv.compareAndSwap(key, was, next, now)) return { reason: 'queued', at };
  }
  return { reason: 'queue_changed' };
}

/** A payout queue entry (setup email or reminder) still waiting. */
const payoutWaiting = q => !!q && !q.sentAt && !q.cancelled && !q.dropped && !q.failed;
/** A Company accounts email still waiting its 30 minutes (onboarding.mjs): proposed, not yet being created, not stopped. */
export const accountWaiting = state => { const a = state?.account; return !!a?.proposedAt && !a.createClaimed && !a.stopped && !a.halted && !a.fallback && !a.dropped; };

/** What is still waiting for this person: [{ kind, key }]. */
export async function waitingFor({ db, pageId }) {
  const kv = noticeStore(db), out = [];
  const packet = await kv.get(`emailq:packet:${pageId}`);
  if (packetWaiting(packet)) out.push({ kind: 'work trial documents', key: `emailq:packet:${pageId}`, value: packet });
  const invite = await kv.get(`trialinvite:${pageId}`);
  if (invite && !invite.sentAt && !invite.dropped && !invite.dispatchingAt && !invite.deliveryUncertain) out.push({ kind: 'work trial invitation', key: `trialinvite:${pageId}`, value: invite });
  const payout = await kv.get(`payout:queued:${pageId}`);
  if (payoutWaiting(payout)) out.push({ kind: 'payout setup email', key: `payout:queued:${pageId}`, value: payout });
  const remind = await kv.get(`payout:remindq:${pageId}`);
  if (payoutWaiting(remind)) out.push({ kind: 'payout reminder email', key: `payout:remindq:${pageId}`, value: remind });
  const onboarding = await kv.get(`onboarding:${pageId}`);
  if (accountWaiting(onboarding)) out.push({ kind: 'Company accounts email', key: `onboarding:${pageId}`, value: { ...onboarding, name: onboarding.account.name ?? onboarding.name ?? null } });
  const first = await kv.get(`checkin:first:${pageId}`);
  if (first?.emailEligible && !first.cancelled) {
    const key = `checkin:confirmation:${pageId}:${first.at}${first.revision ? `:${first.revision.id}` : ''}`;
    const receipt = await kv.get(key);
    if (!receipt) out.push({ kind: 'first check-in confirmation', key: `checkin:first:${pageId}`, value: first });
    else if (['queued', 'retryable'].includes(receipt.state) && !receipt.cancelled)
      out.push({ kind: 'first check-in confirmation', key, value: receipt });
  }
  return out;
}

/** Everyone with something still waiting: [{ pageId, name, items }]. */
export async function allWaiting({ db }) {
  const kv = noticeStore(db), ids = new Set();
  for (const prefix of ['emailq:packet:', 'trialinvite:', 'payout:queued:', 'payout:remindq:', 'onboarding:', 'checkin:first:']) for (const k of await kv.names(prefix)) ids.add(k.slice(prefix.length));
  const out = [];
  for (const pageId of ids) {
    if (!/^[0-9a-f-]{8,}$/i.test(pageId)) continue;
    const items = await waitingFor({ db, pageId });
    if (items.length) out.push({ pageId, name: items[0].value.name ?? null, items });
  }
  return out;
}

export async function cancelWaiting({ db, pageId, clock = Date.now }) {
  const kv = noticeStore(db), now = clock(), items = await waitingFor({ db, pageId });
  const done = [];
  for (const it of items) {
    if (it.key.startsWith('onboarding:')) {
      // Read again: the account may have started being created since (then it is too late to stop it here).
      const state = await kv.get(it.key);
      if (!accountWaiting(state)) continue;
      await kv.put(it.key, { ...state, account: { ...state.account, stopped: now, stoppedBy: 'cancel_command' } }, now);
    } else if (it.key.startsWith('trialinvite:')) {
      if (!(await kv.compareAndSwap(it.key, it.value, { ...it.value, dropped: 'cancelled_by_mason' }, now))) continue;
    }
    else if (!(await kv.compareAndSwap(it.key, it.value, { ...it.value, cancelled: now }, now))) continue;
    done.push(it.kind);
  }
  return done;
}

/** Sends what is due (`packets.sendNow`, the real send). Never throws. */
export async function runEmailQueue({ db, notion, packets, poster = null, clock = Date.now, log = () => {} }) {
  const summary = { sent: 0, dropped: 0, error: null };
  try {
    if (!db?.prepare || typeof packets?.sendNow !== 'function') return summary;
    const kv = noticeStore(db), now = clock();
    for (const key of await kv.names('emailq:packet:')) {
      const q = await kv.get(key);
      if (!packetWaiting(q) || now < q.at) continue;
      const read = await readCandidate(notion, q.pageId);
      if (read.transient) continue; // Notion unreadable: tried again next run, never dropped for it
      const c = read.candidate, f = c?.fields ?? {};
      const why = (await holdReason({ kv, candidate: c })) ?? (['Sent', 'Signed'].includes(f.Paperwork) ? 'already_out' : null);
      if (why) {
        if (!(await kv.compareAndSwap(key, q, { ...q, dropped: why, at: now }, now))) continue;
        summary.dropped++;
        if (poster && !['already_out', 'gone'].includes(why)) await poster(holdText(q.name, 'work trial documents', why)).catch(() => {});
        continue;
      }
      // Approval belongs to this candidate identity. A changed address requires a
      // fresh instruction; never redirect an already queued packet automatically.
      if (!q.email || String(c.email ?? '').toLowerCase() !== q.email.toLowerCase() || c.emailVerified === false
        || (q.name && String(c.fullName ?? '').trim().toLowerCase() !== q.name.trim().toLowerCase())) {
        await kv.compareAndSwap(key, q, { ...q, dropped: 'identity_changed', at: now }, now);
        await tellHold({ kv, poster, pageId: q.pageId, name: q.name, what: 'work trial documents', why: 'the candidate identity changed since approval', now });
        summary.dropped++; continue;
      }
      const currentRate = c.payment?.dailyRate;
      if (currentRate != null && q.rate != null && currentRate !== q.rate) {
        await tellHold({ kv, poster, pageId: q.pageId, name: q.name, what: 'work trial documents',
          why: `pay differs between the queued instruction and tracker (queued $${q.rate}/day, tracker $${currentRate}/day)`, now });
        continue;
      }
      // A corrected rate or cancellation arriving during the candidate read wins over this stale worker.
      const sending = { ...q, dispatchingAt: now };
      if (!(await kv.compareAndSwap(key, q, sending, now))) continue;
      if (!(await kv.claim(`emailq:sending:${q.pageId}:${q.revision ?? q.queuedAt}`, { at: now }, now))) continue;
      let out;
      // The record as it is now: its email, name and trial dates (changed dates are used, not the queued ones).
      try { out = await packets.sendNow({ who: { ...q, pageId: q.pageId, email: c.email ?? q.email, fullName: c.fullName ?? q.name,
        trialStart: dayOnly(f['Trial Start']) ?? q.trialStart ?? null, trialEnd: dayOnly(f['Trial End']) ?? q.trialEnd ?? null }, rate: q.rate }); }
      catch (error) { out = error?.code === 'docusign_document_validation_failed'
        ? { reason: 'validation_blocked', text: `🚨 Blocked ${firstOf(q.name)}'s documents: ${error.detail ?? 'document validation failed'}. No send was attempted.` }
        : { reason: 'failed', text: `🚨 The document operation for ${firstOf(q.name)} did not complete (${error?.code ?? 'failed'}). Check its status before retrying.` }; }
      await kv.compareAndSwap(key, sending, { ...q,
        ...(out?.reason === 'validation_blocked' ? { validationBlocked: now, envelopeId: out.envelopeId ?? null }
          : out?.reason === 'uncertain' ? { deliveryUncertain: now, envelopeId: out.envelopeId ?? null }
            : { done: now }),
        result: out?.reason ?? 'unknown' }, now);
      if (['sent', 'addendum_sent'].includes(out?.reason)) summary.sent++;
      else if (!['already_sent', 'already_has_packet', 'already_has_addendum', 'already_has_agreement'].includes(out?.reason) && poster && out?.text) await poster(out.text).catch(() => {});
      log(`uncle_sam_email_queue packet ${q.pageId.slice(0, 8)} ${out?.reason ?? 'unknown'}`);
    }
    return summary;
  } catch (error) { return { ...summary, error: typeof error?.code === 'string' ? error.code : 'email_queue_failed' }; }
}

const CANCEL = /^\s*(?:<@[^>]+>\s*)?(?:cancel|stop|hold off|hold|don'?t send|do not send)\b[\s,:-]*(.*)$/i;
/**
 * "cancel Priya" / "stop sending Priya's documents" / a bare "cancel" in Project's DM. Returns an outcome, or null when the message
 * isn't this or nothing is waiting (so other handlers still see it).
 */
export async function handleCancelCommand({ event, db, findCandidate, poster, masonId, clock = Date.now, sideEffects = [] }) {
  if (!db?.prepare || event?.authorId !== masonId) return null;
  const m = CANCEL.exec(String(event.text ?? '').replace(/\*Sent using\*[\s\S]*$/i, '').trim());
  if (!m) return null;
  const waiting = await allWaiting({ db });
  if (!waiting.length) return null;
  const reply = t => poster(event.threadTs ?? event.messageTs)(t).catch(() => {});
  const rest = m[1].replace(/\b(sending|send|the|his|her|their|emails?|documents?|docs|papers|invite|invitation|payout|setup|reminder|stripe|company|accounts?|to)\b/gi, ' ').replace(/['’]s\b/g, '').replace(/\s+/g, ' ').trim();
  let target = null;
  if (rest && typeof findCandidate === 'function') {
    const who = await findCandidate(rest).catch(() => null);
    target = who?.pageId ? waiting.find(w => w.pageId === who.pageId) ?? null : null;
    if (!target) target = waiting.find(w => String(w.name ?? '').toLowerCase().includes(rest.toLowerCase())) ?? null;
    if (!target) return null;
  } else if (!rest) {
    if (!/^\s*(?:<@[^>]+>\s*)?cancel\b/i.test(String(event.text ?? ''))) return null; // a bare "stop" or "hold" belongs to other threads
    if (waiting.length > 1) { await reply(`📋 Which one? Waiting to go: ${waiting.map(w => firstOf(w.name)).join(', ')}. Say "cancel <name>".`); return { kind: 'email_cancel', reason: 'which' }; }
    target = waiting[0];
  } else return null;
  const kinds = await cancelWaiting({ db, pageId: target.pageId, clock });
  if (!kinds.length) { await reply(`📋 Too late: ${firstOf(target.name)}'s ${target.items.map(i => i.kind).join(' and ')} already started going out.`); return { kind: 'email_cancel', reason: 'too_late' }; }
  sideEffects.push('email_cancelled');
  await reply(`🛑 Cancelled. ${firstOf(target.name)}'s ${kinds.join(' and ')} won't go out.`);
  return { kind: 'email_cancel', reason: null };
}
