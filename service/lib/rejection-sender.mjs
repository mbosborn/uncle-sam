/**
 * Uncle Sam sending rejection emails itself from Project's Gmail (Project, 2026-10-15: "this is also how the rejections should
 * work"). It replaces the separate Notion rejection agent, whose instructions now say Uncle Sam sends, and keeps its rules:
 *
 *  - Only a human decision: Outcome = Not Selected (set by a person, or by Uncle Sam on a confirmed reject). Rows that were
 *    already Not Selected with no rejection status when Uncle Sam took over are a baseline and never enrolled.
 *  - Earliest send = max(decision, latest interview end + 24 hours), to the minute, rounded up. The decision time is when Uncle
 *    Sam first sees the Not Selected (never earlier than the real one, so never early). No interview end on record: Needs
 *    attention, which the stuck-rejection flow restarts or brings to Project.
 *  - Never for a hold, a changed recipient, the [TEST] fixture, Prathmesh Mise, or anyone already rejected (Project's Sent mail
 *    is searched for an earlier rejection to the address, whoever's decision it was). Outcome changed away: Cancelled.
 *  - Reserve (Sending + attempt), read back, send once with the approved text and Project's signature once, record Sent, sent
 *    at and the message link, close the record (Stage Closed, Action Status Complete, Self-DM Tracker off). An unclear send
 *    is Needs attention with the attempt kept (the stuck flow tells Project to check Sent first); it is never retried. A clear
 *    refusal before sending puts the row back to Scheduled for the next tick.
 *
 * Runs each tick only when UNCLE_SAM_REJECTION_SENDER = "uncle-sam", the control row is Live, and Project's Gmail is connected
 * with the read box (for the duplicate check). Never throws.
 */
import { noticeStore } from './stuck-rejections.mjs';

export const REJECTION_SUBJECT = 'Update on Company Interview Process';
/** Historical activation baseline text is not a delivery attempt. Only this exact, empty-queue state qualifies. */
export function isNonSendingRejectionBaseline(s) {
  return s?.status === 'Cancelled' && s.attempt === 'Already Not Selected before the October 13, 2026 delayed-rejection activation. Excluded from automatic backfill; no send is asserted. Review separately if outreach is still needed.'
    && !s.decisionAt && !s.decisionKey && !s.queuedTo && !s.scheduledFor && !s.sentAt && !s.messageUrl;
}
export const REJECTION_FIXTURE_ID = '7c2e55f4-cc62-4728-80f8-964951e2c868';
export const REJECTION_EXCLUDED = Object.freeze(['eb6d0a25-84cd-4f6b-96c4-b81992430044', REJECTION_FIXTURE_ID]); // Prathmesh Mise; the dry-run fixture
const DAY = 24 * 3600_000;
const iso = ms => new Date(ms).toISOString();
const ceilMinute = ms => Math.ceil(ms / 60_000) * 60_000;
const time = value => { const ms = Date.parse(value ?? ''); return Number.isFinite(ms) && /T\d{2}:\d{2}/.test(String(value)) ? ms : null; };

/** The approved rejection, word for word (the sender's "Approved email", as sent to every candidate since Oct 13). */
export function rejectionBody(fullName) {
  const first = String(fullName ?? '').replace(/\s*⭐\s*$/u, '').trim().split(/\s+/)[0] ?? '';
  const greeting = /^[\p{L}][\p{L}'’-]{0,40}$/u.test(first) ? `Hi ${first},` : 'Hi,';
  return [greeting,
    'Thank you for your interest in Company and for the time you invested in interviewing with us. We are very appreciative.',
    'After careful consideration, I’m writing to let you know that we will not be moving forward with your candidacy at this time. We are fortunate to have a lot of interest and, though you were strong in a lot of areas, we are proceeding with candidates who more fully align with the role requirements.',
    'Thanks again for the time and energy you put into interviewing with us. It means a lot to our team.',
    'Best,'].join('\n\n');
}

export function rejectionSenderEnabled(env = {}) { return env.UNCLE_SAM_REJECTION_SENDER === 'uncle-sam'; }

/**
 * `findInterviewEnd(email)` (optional; set once Uncle Sam reads Google Calendar directly) gives the latest ended interview with
 * that address as { at, sourceUrl }: it fills a missing interview end, and a later one than recorded moves the send later.
 */
export async function runRejectionSender({ env, db, notion, gmail, findInterviewEnd = null, clock = Date.now, runId = 'tick', log = () => {} }) {
  const summary = { state: 'off', enrolled: 0, needsAttention: 0, sent: 0, alreadySent: 0, cancelled: 0, waiting: 0, error: null };
  try {
    if (!rejectionSenderEnabled(env) || env.UNCLE_SAM_AUTOMATIC_ACTIVITY !== 'enabled' || !gmail || !db?.prepare) return summary;
    if ((await notion.readControl())?.mode !== 'Live') return { ...summary, state: 'not_live' };
    if (!(await gmail.canSearch())) return { ...summary, state: 'waiting_for_gmail_read' };
    summary.state = 'on';
    const store = noticeStore(db);
    const rows = await notion.listRejectionQueue();
    // The first run's blank Not Selected rows are history from before the switch, never enrolled.
    let baseline = await store.get('rejections:baseline');
    if (!baseline) {
      baseline = { at: clock(), pageIds: rows.filter(r => !r.sender.status).map(r => r.candidate.pageId) };
      await store.put('rejections:baseline', baseline, clock());
    }
    const ignored = new Set([...baseline.pageIds, ...REJECTION_EXCLUDED]);
    for (const { candidate: c } of rows) {
      if (ignored.has(c.pageId) || c.archived || /^\[(?:TEST|FIXTURE)\]/i.test(c.fullName)) continue;
      try { await handle(c.pageId); } catch (error) { log(`uncle_sam_rejection page=${c.pageId} error=${error?.code ?? 'failed'}`); }
    }
    return summary;
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'rejection_sender_failed';
    log(`uncle_sam_rejection_sender error=${code}`);
    return { ...summary, error: code };
  }

  async function latest(email) {
    if (typeof findInterviewEnd !== 'function' || !email) return null;
    try { const found = await findInterviewEnd(email); return found && time(found.at) !== null && /^https:\/\//.test(found.sourceUrl ?? '') ? found : null; } catch { return null; }
  }

  async function note(pageId, text, sourceUrl) {
    try { await notion.appendCandidateNote({ pageId, text: `${iso(clock()).slice(0, 10)} · ${text}`, ...(sourceUrl ? { sourceUrl } : {}) }); } catch { /* history only */ }
  }

  async function handle(pageId) {
    const { candidate: c, sender: s } = await notion.getRejectionState(pageId); // fresh, right before acting
    const now = clock();
    if (!s.status) {
      if (c.fields.Outcome !== 'Not Selected') return;
      if (!c.email) {
        await notion.writeRejection({ pageId, fields: { status: 'Needs attention' } });
        await note(pageId, 'Rejection email not queued by Uncle Sam: there is no email on the record.'); summary.needsAttention++; return;
      }
      let end = time(s.lastInterviewEnd), fromCalendar = null;
      const decisionAt = iso(Math.floor(now / 60_000) * 60_000), decisionKey = `${c.pageId}|${decisionAt}`;
      const seen = await latest(c.email);
      if (seen && (end === null || Date.parse(seen.at) > end)) { fromCalendar = seen; end = Date.parse(seen.at); }
      if (end === null) {
        await notion.writeRejection({ pageId, fields: { decisionAt, decisionKey, queuedTo: c.email, status: 'Needs attention' } });
        await note(pageId, 'Rejection email not queued yet by Uncle Sam: no interview end time is on the record (the email goes 24 hours after it).'); summary.needsAttention++; return;
      }
      const due = ceilMinute(Math.max(now, end + DAY));
      await notion.writeRejection({ pageId, fields: { decisionAt, decisionKey, queuedTo: c.email, scheduledFor: iso(due), status: 'Scheduled', ...(fromCalendar ? { interviewEnd: fromCalendar } : {}) } });
      await note(pageId, `Rejection email queued by Uncle Sam: goes from Project's Gmail at ${iso(due)} (24 hours after the last interview, ${fromCalendar ? `${fromCalendar.at}, from the calendar` : s.lastInterviewEnd}).`, fromCalendar?.sourceUrl);
      summary.enrolled++; return;
    }
    if (s.status !== 'Scheduled') return;
    if (c.fields.Outcome !== 'Not Selected') {
      await notion.writeRejection({ pageId, fields: { status: 'Cancelled' } });
      await note(pageId, `Rejection email cancelled by Uncle Sam: the Outcome is now ${c.fields.Outcome || 'blank'}. Nothing was sent.`); summary.cancelled++; return;
    }
    if (s.hold) { summary.waiting++; return; }
    const end = time(s.lastInterviewEnd), decided = time(s.decisionAt), scheduled = time(s.scheduledFor);
    if (end === null || decided === null || scheduled === null || !s.decisionKey || !s.queuedTo) {
      await notion.writeRejection({ pageId, fields: { status: 'Needs attention' } });
      await note(pageId, 'Rejection email stopped by Uncle Sam: the queue is missing the interview end, decision time, key, recipient or send time.'); summary.needsAttention++; return;
    }
    // A later interview on the calendar than the one recorded moves the email later (never earlier).
    const seen = await latest(c.email);
    if (seen && Date.parse(seen.at) > end) {
      const later = ceilMinute(Math.max(decided, Date.parse(seen.at) + DAY));
      await notion.writeRejection({ pageId, fields: { interviewEnd: seen, scheduledFor: iso(later) } });
      await note(pageId, `Rejection email moved later by Uncle Sam: a later interview ended ${seen.at} (calendar), so it goes at ${iso(later)}.`, seen.sourceUrl);
      summary.waiting++; return;
    }
    const due = ceilMinute(Math.max(decided, end + DAY));
    if (due > scheduled) { await notion.writeRejection({ pageId, fields: { scheduledFor: iso(due) } }); summary.waiting++; return; } // a later interview moved it
    if (now < Math.max(due, scheduled)) { summary.waiting++; return; }
    if (!c.email || c.email.toLowerCase() !== s.queuedTo.toLowerCase()) {
      await notion.writeRejection({ pageId, fields: { status: 'Needs attention' } });
      await note(pageId, `Rejection email stopped by Uncle Sam: the email on the record (${c.email || 'none'}) is not the one it was queued to (${s.queuedTo}).`); summary.needsAttention++; return;
    }
    // Anyone already rejected (from Project's Gmail, on any decision) is never emailed again.
    const earlier = await gmail.searchSent(`to:${s.queuedTo} ("${REJECTION_SUBJECT}" OR "not be moving forward")`);
    if (earlier.length) {
      await notion.writeRejection({ pageId, fields: { sentAt: earlier[0].sentAt, messageUrl: earlier[0].url, close: true, status: 'Sent' } });
      await note(pageId, 'A rejection to this address was already in Project\'s Sent mail, so Uncle Sam did not send another; recorded it as sent.', earlier[0].url);
      summary.alreadySent++; return;
    }
    const attempt = `${s.decisionKey} | uncle-sam ${runId} | ${iso(now)}`;
    const reserved = await notion.writeRejection({ pageId, fields: { attempt, status: 'Sending' } });
    if (reserved.sender.attempt !== attempt || reserved.candidate.fields.Outcome !== 'Not Selected' || reserved.sender.hold) {
      await notion.writeRejection({ pageId, fields: { status: 'Needs attention' } });
      await note(pageId, 'Rejection email stopped by Uncle Sam: the record changed while it was reserving the send. Nothing was sent.'); summary.needsAttention++; return;
    }
    let sent;
    try { sent = await gmail.send({ to: s.queuedTo, subject: REJECTION_SUBJECT, body: rejectionBody(c.fullName) }); }
    catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'gmail_error';
      if (error?.uncertain) {
        await notion.writeRejection({ pageId, fields: { status: 'Needs attention' } }); // the attempt stays: may have gone out
        await note(pageId, `Rejection email send by Uncle Sam got no clear answer (${code}); it may have gone out. Not retried: check Project's Sent mail first.`);
        summary.needsAttention++; return;
      }
      await notion.writeRejection({ pageId, fields: { attempt: '', status: 'Scheduled' } }); // certainly not sent: next tick
      log(`uncle_sam_rejection_not_sent page=${pageId} error=${code}`); summary.waiting++; return;
    }
    await notion.writeRejection({ pageId, fields: { sentAt: sent.sentAt, messageUrl: sent.url, close: true, status: 'Sent' } });
    await note(pageId, `Rejection email sent from Project's Gmail by Uncle Sam to ${s.queuedTo} (decision ${s.decisionKey}).`, sent.url);
    summary.sent++;
  }
}

/**
 * Sends that may or may not have gone out (Project, 2026-10-16: "uncle sam should catch this by himself and i shouldnt be
 * notified as long as there is strict confirmation"). A row left "Sending" (the run was cut off mid-send) or put in Needs
 * attention by an unclear send is settled from Project's Sent mail, the one independent record of what went out:
 *  - 15 minutes after the attempt, Sent mail is searched for a rejection to that address. Found: recorded Sent with the
 *    message link and the record closed, as if the send had answered.
 *  - Not found in two searches at least 10 minutes apart, 30 minutes or more after the attempt: confirmed not sent. Queued
 *    again (Scheduled; the sender's own Sent-mail check runs once more right before sending), or Cancelled when the Outcome is
 *    no longer Not Selected.
 *  - Project hears only when it cannot be settled: Sent mail unreadable for a day, or the same rejection unclear twice. Then
 *    the stuck-rejection notice asks him (stuck-rejections.mjs skips these rows until then).
 * Notes on the record say what was found. Never throws.
 */
export const CONFIRM_AFTER_MS = 15 * 60_000;
export const CONFIRM_NOT_SENT_MS = 30 * 60_000;
export const SECOND_LOOK_MS = 10 * 60_000;
export const attemptTime = attempt => { const m = /\|\s*(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s*$/.exec(attempt ?? ''); return m ? Date.parse(m[1]) : null; };
export const gaveUpKey = pageId => `rejection-confirm:gaveup:${pageId}`;
export async function confirmUnclearSends({ env, db, notion, gmail, clock = Date.now, log = () => {} }) {
  const summary = { unclear: 0, confirmedSent: 0, requeued: 0, cancelled: 0, waiting: 0, gaveUp: 0, error: null };
  try {
    if (!rejectionSenderEnabled(env) || env.UNCLE_SAM_AUTOMATIC_ACTIVITY !== 'enabled' || !gmail || !db?.prepare || typeof notion?.listUnclearRejections !== 'function') return summary;
    if ((await notion.readControl())?.mode !== 'Live') return summary;
    const kv = noticeStore(db), now = clock();
    const canSearch = await gmail.canSearch().catch(() => false);
    for (const row of await notion.listUnclearRejections()) {
      const { candidate: c, sender: s } = row;
      const pageId = c.pageId;
      if (await kv.get(gaveUpKey(pageId))) continue;
      const at = attemptTime(s.attempt);
      if (!s.attempt || at === null) continue; // no attempt on record: the stuck-rejection flow's case
      summary.unclear++;
      if (now - at < CONFIRM_AFTER_MS) { summary.waiting++; continue; }
      const key = `rejection-confirm:${pageId}:${at}`;
      const state = (await kv.get(key)) ?? { looks: [] };
      const giveUp = async reason => {
        await kv.put(gaveUpKey(pageId), { at: now, reason }, now);
        // The stuck-rejection notice then asks Project (the row must be Needs attention for it to see it).
        if (s.status !== 'Needs attention') await notion.writeRejection({ pageId, fields: { status: 'Needs attention' } }).catch(() => null);
        await note(notion, pageId, `Rejection email: Uncle Sam could not confirm from Project's Sent mail whether it went out (${reason}). Project is asked.`, clock);
        summary.gaveUp++;
      };
      if (!canSearch) { if (now - at > 24 * 3600_000) await giveUp('Sent mail unreadable for a day'); else summary.waiting++; continue; }
      const to = s.queuedTo || c.email;
      if (!to) { await giveUp('no address to search'); continue; }
      let found;
      try { found = await gmail.searchSent(`to:${to} ("${REJECTION_SUBJECT}" OR "not be moving forward")`); }
      catch { if (now - at > 24 * 3600_000) await giveUp('Sent mail search failing for a day'); else summary.waiting++; continue; }
      if (found.length) {
        await notion.writeRejection({ pageId, fields: { attempt: s.attempt, sentAt: found[0].sentAt, messageUrl: found[0].url, close: true, status: 'Sent' } });
        await note(notion, pageId, `Rejection email confirmed sent from Project's Sent mail (the send had not answered clearly); recorded as Sent by Uncle Sam.`, clock, found[0].url);
        summary.confirmedSent++; continue;
      }
      const looks = [...state.looks, now];
      await kv.put(key, { looks }, now);
      if (now - at < CONFIRM_NOT_SENT_MS || looks.length < 2 || now - looks[0] < SECOND_LOOK_MS) { summary.waiting++; continue; }
      // Confirmed not sent.
      if (c.fields?.Outcome !== 'Not Selected') {
        await notion.writeRejection({ pageId, fields: { attempt: '', status: 'Cancelled' } });
        await note(notion, pageId, `Rejection email cancelled by Uncle Sam: the send had not answered clearly, Project's Sent mail shows nothing went out, and the Outcome is now ${c.fields?.Outcome || 'blank'}.`, clock);
        summary.cancelled++; continue;
      }
      const tries = (await kv.get(`rejection-confirm:requeued:${pageId}`))?.count ?? 0;
      if (tries >= 1) { await giveUp('a second send was also unclear'); continue; }
      await kv.put(`rejection-confirm:requeued:${pageId}`, { count: tries + 1, at: now }, now);
      await notion.writeRejection({ pageId, fields: { attempt: '', status: 'Scheduled' } });
      await note(notion, pageId, `Rejection email queued again by Uncle Sam: the earlier send had not answered clearly, and Project's Sent mail (checked twice, 10+ minutes apart) shows it did not go out. The sender checks Sent mail once more before sending.`, clock);
      summary.requeued++;
    }
    return summary;
  } catch (error) { return { ...summary, error: typeof error?.code === 'string' ? error.code : 'confirm_unclear_failed' }; }
}
async function note(notion, pageId, text, clock, sourceUrl = null) {
  try { await notion.appendCandidateNote({ pageId, text: `${new Date(clock()).toISOString().slice(0, 10)} · ${text}`, ...(sourceUrl ? { sourceUrl } : {}) }); } catch { /* history only */ }
}
