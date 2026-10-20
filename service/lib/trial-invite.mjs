/**
 * The work-trial invitation, when someone is moved to a work trial with no dates yet (Project, 2026-10-18: "Once Interviewer says yes,
 * a take-home assessment is good. Then, assuming that we do not have the dates that their work trial is, it needs to be like:
 * 'Congratulations, we'd like to move you forward with a work trial. Please confirm the dates you are available. Ideally, 3 days,
 * but 2 days is also fine. We can accommodate weekends and adapt our time zones. Our standard trial rate is [rate]. Looking
 * forward to hearing from you.'" / "make sure it's in a good time zone for the person that we're sending it to").
 *
 *  - Project's Send on the work-trial offer (work-trial-offer.mjs) is the go-ahead and sets the rate; with no Trial Start/End on the
 *    record, the invitation goes instead of the DocuSign packet. With dates (Robin fast-tracked them with dates), the packet and
 *    its confirmation email go as before, which confirm the dates and the pay.
 *  - The wording lives in Notion: "Email · Work Trial · Invitation" in Recruiting Guides & Templates.
 *  - Sent from Project's Gmail between 9 AM and 6 PM on a weekday in their own time zone (checkin-times.mjs trialTimeZone, which
 *    reads Project's answer, the India pipeline, the notes (Clay's "based in"), and trial-location.mjs's emails/LinkedIn); unknown:
 *    Pacific. Queued until then (kv trialinvite:<pageId>), every tick.
 *  - Re-read before sending: closed, On Hold, an unanswered pay concern (trial-terms.mjs), paperwork already out, or dates already
 *    on the record (the packet path takes over) -> not sent; Project hears why (not for the dates). Once each.
 *  - Project's own invitation (his Sent mail to them mentions the work trial in the last 60 days): not sent; he hears one line, and
 *    the documents email later replies in his thread (work-trial-offer.mjs sendTrialConfirmation).
 *  - Queued once: a waiting or sent invitation is never queued again; a dropped one only on a person's explicit word (force).
 *  - Their reply with dates is read by trial-terms.mjs, which fills the dates; with the rate already on the record, the packet then
 *    goes by itself.
 */
import { noticeStore } from './stuck-rejections.mjs';
import { readCandidate } from './email-queue.mjs';
import { trialTimeZone, zonedWall } from './checkin-times.mjs';
import { rateText, validRate } from './work-trial-offer.mjs';

export const INVITE_TEMPLATE_ID = '6a92e616-71ed-437b-90fd-8a8d1803fabb';
const FROM_H = 9, TO_H = 18;
const CLOSED = ['Not Selected', 'Withdrawn or Unavailable', 'Hired'];
/** Project's Sent mail to them about the work trial (his own wording or the template's). */
export const handInviteQuery = email => `to:${email} "work trial" -subject:payment newer_than:60d`;
/** The documents email threads only under a real invitation (its template phrase), never under any mail that says "work trial". */
export const inviteThreadQuery = email => `to:${email} "move you forward with a work trial" newer_than:60d`;
const firstOf = full => String(full ?? '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/[^\p{L}\s'.-]/gu, ' ').trim().split(/\s+/)[0] || 'them';
const dayOnly = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const parts = (ms, tz) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short' })
  .formatToParts(ms).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));

/** The next moment at or after `now` that is 9 AM – 6 PM on a weekday in `tz`. */
export function nextGoodTime(now, tz) {
  for (let i = 0; i < 9 * 24; i++) {
    const at = i === 0 ? now : (() => { const p = parts(now + i * 3600_000, tz); return zonedWall(`${p.year}-${p.month}-${p.day}`, tz, Number(p.hour), 0); })();
    const p = parts(at, tz), h = Number(p.hour);
    if (!['Sat', 'Sun'].includes(p.weekday) && h >= FROM_H && h < TO_H && at >= now) return at;
  }
  return now;
}

/** The invitation filled for one person, or null when the template changed shape. */
export function fillInvite(template, { firstName, rate }) {
  if (!template?.subject || !template?.body || !firstName || !validRate(rate)) return null;
  if (!template.body.includes('{{first_name}}') || !template.body.includes('{{daily_rate}}')) return null;
  const fill = t => t.replaceAll('{{first_name}}', firstName).replaceAll('{{daily_rate}}', rateText(rate));
  const subject = fill(template.subject), body = fill(template.body);
  if (/\{\{[^}]*\}\}/.test(subject + body)) return null;
  return { subject, body };
}

/**
 * Queues the invitation at their next good hour. -> { reason: 'queued', at, tz } | { reason: 'already_queued' | 'already_sent', at, tz }
 * | { reason: 'dropped', dropped }. A waiting or sent one is never queued again; a dropped one (cancelled, closed, ...) only with
 * `force`, which only a person's explicit word passes (a fresh push-through, Project's tap or his rate reply).
 */
export async function queueTrialInvite({ db, candidate, rate, calledBy = null, clock = Date.now, force = false }) {
  const kv = noticeStore(db), now = clock();
  const was = await kv.get(`trialinvite:${candidate.pageId}`);
  if (was && !was.dropped) return { reason: was.sentAt ? 'already_sent' : 'already_queued', at: was.at ?? null, tz: was.tz ?? null };
  if (was?.dropped && !force) return { reason: 'dropped', dropped: was.dropped };
  const { tz } = await trialTimeZone({ candidate, kv }).catch(() => ({ tz: null }));
  const zone = tz ?? 'America/Los_Angeles';
  // Not known yet: a short wait so their emails, LinkedIn or Clay can place them (trial-location.mjs) before it goes.
  // Never sooner than 30 minutes, so Project can still cancel it (email-queue.mjs, Project 2026-10-20).
  const at = tz ? nextGoodTime(now + 30 * 60_000, zone) : now + 35 * 60_000;
  await kv.put(`trialinvite:${candidate.pageId}`, { pageId: candidate.pageId, email: candidate.email, name: candidate.fullName, rate, tz: zone, at, calledBy, queuedAt: now }, now);
  return { reason: 'queued', at, tz: zone };
}

export async function runTrialInvites({ db, notion, gmail, parseTemplate, poster = null, clock = Date.now, log = () => {} }) {
  const summary = { sent: 0, dropped: 0, error: null };
  try {
    if (!db?.prepare || !gmail) return summary;
    const kv = noticeStore(db), now = clock();
    for (const key of await kv.names('trialinvite:')) {
      const q = await kv.get(key);
      if (!q?.pageId || q.sentAt || q.dropped || now < q.at) continue;
      const retry = async code => {
        const attempts = (q.retryAttempts ?? 0) + 1;
        await kv.compareAndSwap(key, q, { ...q, retryAttempts: attempts, lastError: code,
          at: now + Math.min(3600_000, 300_000 * 2 ** Math.min(attempts - 1, 4)) }, now);
        summary.error = code;
        log(`uncle_sam_trial_invites retry error=${code}`);
      };
      const read = await readCandidate(notion, q.pageId);
      if (read.transient) { await retry('candidate_read_unavailable'); continue; }
      const c = read.candidate;
      const f = c?.fields ?? {};
      const why = !c || c.archived ? 'gone' : CLOSED.includes(f.Outcome) || ['Closed', 'Hired'].includes(f.Stage) ? 'closed' : f.Outcome === 'On Hold' ? 'on_hold'
        : (await kv.get(`trialterms:hold:${q.pageId}`)) ? 'pay_concern' : ['Sent', 'Signed'].includes(f.Paperwork) ? 'already_out'
        : dayOnly(f['Trial Start']) && dayOnly(f['Trial End']) ? 'dates_on_record' : !c.email ? 'no_email' : null;
      if (why) {
        await kv.put(key, { ...q, dropped: why, at: now }, now);
        summary.dropped++;
        // As the documents queue (email-queue.mjs): Project hears why, except when it's gone, already out, or the packet takes over.
        const said = { closed: 'they are closed on the tracker', on_hold: 'they are On Hold', pay_concern: "they pushed back on the pay and haven't had an answer", no_email: 'there is no email on their record' }[why];
        if (poster && said) await poster(`📋 I didn't send ${firstOf(q.name)}'s work trial invite: ${said}.`).catch(() => {});
        continue;
      }
      // Their time zone, read again now (it may have been found since it was queued): only at a good hour there.
      const found = (await trialTimeZone({ candidate: c, kv }).catch(() => ({ tz: null }))).tz ?? q.tz;
      const goodAt = nextGoodTime(now, found);
      if (goodAt > now) { await kv.put(key, { ...q, tz: found, at: goodAt }, now); continue; }
      let template = null;
      try { template = parseTemplate(await notion.getEmailTemplate(INVITE_TEMPLATE_ID)); } catch (error) { await retry(error?.code ?? 'template_read_unavailable'); continue; }
      const first = String(c.fullName).replace(/\s*\([^)]*\)\s*/g, ' ').trim().split(/\s+/)[0];
      const email = fillInvite(template, { firstName: first, rate: q.rate });
      if (!email) { await kv.put(key, { ...q, dropped: 'template' }, now); if (poster) await poster(`📋 I didn't send ${first} the work trial invite: the "Email · Work Trial · Invitation" template in Notion changed shape.`).catch(() => {}); continue; }
      // Project already invited them himself (Project, 2026-10-20: never twice, by hand included). No search permission: it goes as before;
      // any other search failure: nothing goes and he hears it (as the take-home invite).
      if (typeof gmail.searchSent === 'function') {
        let earlier = [];
        try { earlier = await gmail.searchSent(handInviteQuery(c.email)); }
        catch (error) {
          if (error?.code !== 'gmail_search_not_granted') {
            await retry(error?.code ?? 'sent_mail_read_unavailable');
            continue;
          }
        }
        if (earlier?.length) {
          const mine = earlier[0];
          await kv.put(key, { ...q, dropped: 'sent_by_hand', at: now, handSent: { messageId: mine.id ?? null, threadId: mine.threadId ?? null, subject: mine.subject ?? null, url: mine.url ?? null } }, now);
          summary.dropped++;
          if (poster) await poster(`📋 You already emailed ${first} about the work trial${mine.url ? ` (<${mine.url}|email>)` : ''}, so I didn't send the invite.`).catch(() => {});
          continue;
        }
      }
      if (!(await kv.claim(`trialinvite:sent:${q.pageId}`, { at: now }, now))) { await kv.put(key, { ...q, dropped: 'already_sent', at: now }, now); continue; }
      try {
        const sent = await gmail.send({ to: c.email, subject: email.subject, body: email.body });
        await kv.put(key, { ...q, sentAt: now, url: sent?.url ?? null, messageId: sent?.id ?? null, threadId: sent?.threadId ?? null, subject: email.subject }, now);
        summary.sent++;
        await notion.appendCandidateNote?.({ pageId: c.pageId, text: `${new Date(now).toISOString().slice(0, 10)} · Work trial invite emailed from Project's Gmail: asked for their dates, rate ${rateText(q.rate)} per day (by Uncle Sam).` })?.catch?.(() => null);
      } catch (error) {
        const definitelyUnsent = error?.uncertain === false || error?.detail?.uncertain === false;
        const retryable = /(?:http_(?:408|429|5\d\d)|timeout|network_error)$/.test(error?.code ?? '');
        if (definitelyUnsent) await kv.del(`trialinvite:sent:${q.pageId}`);
        if (definitelyUnsent && retryable) { await retry(error.code); continue; }
        await kv.put(key, { ...q, dropped: `send_failed:${error?.code ?? 'failed'}`, deliveryUncertain: !definitelyUnsent }, now);
        if (poster) await poster(definitelyUnsent
          ? `🚨 ${first}'s work trial invite was refused (${error?.code ?? 'failed'}). Check the connection or message before retrying.`
          : `🚨 Delivery of ${first}'s work trial invite is uncertain (${error?.code ?? 'failed'}). Check Sent mail before retrying; I won't send another automatically.`).catch(() => {});
      }
    }
    return summary;
  } catch (error) {
    summary.error = typeof error?.code === 'string' ? error.code : 'trial_invites_failed';
    log(`uncle_sam_trial_invites ${JSON.stringify(summary)}`);
    return summary;
  }
}
