/**
 * One tap for the work-trial packet (Project, 2026-10-16: "When Robin picks Work trial in his feedback form, I DM you 'Send Jane
 * the work trial docs at $X/day?' with Send and Change rate buttons ... in some cases, I believe Interviewer can also pick work
 * trialers").
 *
 * Who can send someone to a work trial (feedback-form.mjs workTrialAuthorized): Robin or Interviewer, on any interview (Project,
 * 2026-10-16: "if interviewer says work trial then its a work trial and same thing with take home"). When one of them does it (the form, a typed reply, or a quoted verdict in their recap in
 * #int-recruitment), Project's "Next step" DM carries the question and two buttons instead of a plain line:
 *   Send                      -> the packet goes out at the pay per day on the record (docusign-send.mjs sendWorkTrialPacket)
 *   Send at a different rate  -> a one-field form for the pay per day, then the packet goes out at that rate
 * No pay per day on the record: only the second button. Nothing goes to the candidate until Project taps.
 *
 * Edge cases:
 *   - Anyone else picks Work trial (Alexis, AA): a recommendation, so Project gets the plain line and no buttons; the buttons
 *     come when Robin or Interviewer calls it.
 *   - Robin and Interviewer both call it (his deep dive, then Robin's interview; or a form and a recap): one offer per candidate.
 *   - The packet already went out from Uncle Sam (Project typed it first): no buttons; the line says so.
 *   - No email on the record, DocuSign not connected: the plain line, as before.
 *   - At the tap, the record is read again: closed (Not Selected, Withdrawn, Hired) or On Hold -> nothing is sent and the
 *     message says why; someone else's packet already out in DocuSign -> nothing new.
 *   - Two taps (or Send and then the rate form): one packet; the claim in sendWorkTrialPacket holds.
 *   - A tap that could not send (DocuSign down, rate refused): the buttons stay and the message says what happened.
 *   - Only Project's taps count; anyone else gets "This one is Project's call."
 */
import { inviteThreadQuery } from './trial-invite.mjs';

export const WT_SEND = 'wt_send';
export const WT_RATE = 'wt_rate';
export const WT_RATE_CALLBACK = 'uncle_sam_wt_rate';
export const PACKET_OFFER = 'work_trial.packet_offer';
export const MIN_RATE = 10, MAX_RATE = 5000;
const pt = text => ({ type: 'plain_text', text: String(text).slice(0, 150), emoji: true });
const button = (actionId, text, value, style) => ({ type: 'button', action_id: actionId, text: pt(text), value, ...(style ? { style } : {}) });

/** Who may call a work trial in a recap (as feedback-form.mjs workTrialAuthorized): Robin or Interviewer, any round. */
export function mayCallWorkTrialInRecap({ by }) { return by === 'Robin' || by === 'Interviewer'; }

export const validRate = n => Number.isFinite(n) && n >= MIN_RATE && n <= MAX_RATE;
export const rateText = n => `US$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/** Send / Send at a different rate; none without a rate (Project gives it by replying in the thread, trial-terms.mjs). */
export function packetButtons(requestKey, hasRate) {
  if (!hasRate) return null;
  return { type: 'actions', block_id: 'uncle_sam_wt_packet', elements: [
    button(WT_SEND, 'Send', requestKey, 'primary'),
    button(WT_RATE, 'Send at a different rate', requestKey)] };
}

/** `invite`: no dates on the offer, so Send emails the invitation asking for them (trial-invite.mjs), not the documents. */
export function rateModal({ requestKey, name, current = null, invite = false }) {
  return { type: 'modal', callback_id: WT_RATE_CALLBACK, private_metadata: JSON.stringify({ requestKey }),
    title: pt('Work trial documents'), submit: pt('Send'), close: pt('Cancel'),
    blocks: [
      { type: 'section', text: { type: 'plain_text', text: invite
        ? `Pay per day for ${String(name).slice(0, 120)}. The invite asking for their dates says this, and it goes out when you tap Send.`
        : `Pay per day for ${String(name).slice(0, 120)}. The compensation addendum says this, and the documents go out when you tap Send.`, emoji: true } },
      { type: 'input', block_id: 'rate', label: pt('US$ per day'), element: { type: 'number_input', action_id: 'value', is_decimal_allowed: true,
        min_value: String(MIN_RATE), max_value: String(MAX_RATE), ...(validRate(current) ? { initial_value: String(current) } : {}) } }] };
}

export function rateDoneModal({ name, rate, invite = false }) {
  return { type: 'modal', title: pt(invite ? 'Work trial invite' : 'Work trial documents'), close: pt('Close'),
    blocks: [{ type: 'section', text: { type: 'plain_text', text: `🫡 Sending ${String(name).slice(0, 120)} the work trial ${invite ? 'invite' : 'documents'} at ${rateText(rate)} per day. The result shows on the message.`, emoji: true } }] };
}

export function rateMetaOf(view) {
  try { const m = JSON.parse(view?.private_metadata ?? ''); return /^usam:v1:[0-9a-f]{64}$/.test(m?.requestKey ?? '') ? m : null; } catch { return null; }
}
export function readRate(view) {
  const raw = view?.state?.values?.rate?.value?.value;
  const n = Number(String(raw ?? '').replace(/[$,\s]/g, ''));
  return validRate(n) ? { ok: true, rate: Math.round(n * 100) / 100 } : { ok: false, errors: { rate: `Give a pay per day between ${MIN_RATE} and ${MAX_RATE}.` } };
}

/** "Tue, Oct 20, 2026" for the offer message; null for anything not a YYYY-MM-DD date. */
export function shortDay(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ''))) return null;
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(Date.parse(`${date}T12:00:00Z`));
}
/** The offer's dates line (Project, 2026-10-16: "this message should also include the dates of their work trial"). */
export function datesLine(start, end) {
  const a = shortDay(start), b = shortDay(end);
  return a && b ? `Dates: ${a} to ${b}.` : a ? `Dates: from ${a}, end not on the record yet.` : 'Dates: not on the record yet (the email tells them they will be confirmed).';
}

/**
 * The confirmation email to the candidate, sent from Project's Gmail with the packet on the same tap (Project, 2026-10-16: "a
 * template email ... confirming the details of your work trial, I have sent you this and this doc via DocuSign and once that's
 * signed I'll send you an email with access to the Slack before the work trial. There will be daily morning and night
 * check-ins during your work trial. We look forward to working with you"). The wording lives in Notion (Recruiting Guides &
 * Templates, "Email · Work Trial · Documents sent (confirmation)") so it can be edited there.
 */
export const TRIAL_CONFIRM_TEMPLATE_ID = '496f01e6-f630-4e38-982b-8a421994abca';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDay = (date, withYear) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ''))) return null;
  const d = new Date(`${date}T12:00:00Z`);
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' }).format(d);
  return `${weekday}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}${withYear ? `, ${d.getUTCFullYear()}` : ''}`;
};
export function trialDatesText(start, end) {
  const a = longDay(start, !end || start.slice(0, 4) !== String(end).slice(0, 4)), b = longDay(end, true);
  return a && b ? `${a} to ${b}` : a ? `starting ${longDay(start, true)}; the end date will be confirmed with you shortly` : 'to be confirmed with you shortly';
}
export const documentsText = addendum => (addendum
  ? 'four documents to sign through DocuSign: the NDA, the CIIAA, our Terms of Service and your Work Trial Compensation Addendum'
  : 'three documents to sign through DocuSign: the NDA, the CIIAA and our Terms of Service');

/** The template filled for one person, or null when it changed shape (a placeholder left, a required one missing). */
/** After the invitation (which already said congratulations), the confirmation opens with thanks instead (Project, 2026-10-20). */
export const AFTER_INVITE_OPENING = 'Thanks for confirming your dates.';
/** Always in the documents email, by the DocuSign line, whether or not the Notion template has one (Project, 2026-10-20). */
export const PLEASE_SIGN = 'Please sign them as soon as you can.';
export function fillTrialConfirmation(template, { firstName, start = null, end = null, rate = null, addendum = true, afterInvite = false }) {
  if (!template?.subject || !template?.body || typeof firstName !== 'string' || !firstName.trim()) return null;
  if (!template.body.includes('{{first_name}}') || !template.body.includes('{{documents}}')) return null;
  let body = template.body;
  if (!/please sign/i.test(body)) {
    body = body.includes('{{documents}}.') ? body.replace('{{documents}}.', `{{documents}}. ${PLEASE_SIGN}`)
      : body.split('\n').map(line => (line.includes('{{documents}}') ? `${line}\n${PLEASE_SIGN}` : line)).join('\n');
  }
  // After the invitation they just gave the dates and already saw the rate: no Dates / Pay lines, no "if these dates are
  // incorrect" (Project, 2026-10-20: "get rid of this"), no second congratulations in any shape, and "Thanks for confirming your
  // dates." first, under the greeting.
  if (afterInvite) {
    const lines = body.split('\n').filter(line => !/\{\{(trial_dates|daily_rate)\}\}/.test(line) && !/^\s*If any of these dates are incorrect/i.test(line)
      && !/congrat/i.test(line) && !/^\s*Confirming the details\b/i.test(line));
    const greeting = lines.findIndex(line => line.trim());
    const at = greeting >= 0 && /^\s*(hi|hello|hey|dear)\b/i.test(lines[greeting]) ? greeting + 1 : 0;
    lines.splice(at, 0, ...(at ? ['', AFTER_INVITE_OPENING] : [AFTER_INVITE_OPENING, '']));
    body = lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
  }
  // No addendum (or no rate): the Pay line goes.
  if (!addendum || !validRate(rate)) body = body.split('\n').filter(line => !line.includes('{{daily_rate}}')).join('\n');
  const fill = text => text.replaceAll('{{first_name}}', firstName.trim()).replaceAll('{{documents}}', documentsText(addendum))
    .replaceAll('{{trial_dates}}', trialDatesText(start, end)).replaceAll('{{daily_rate}}', validRate(rate) ? rateText(rate) : '');
  const subject = fill(template.subject), filled = fill(body);
  if (/\{\{[^}]*\}\}|\[[A-Z][^\]]*\]/.test(subject + filled) || subject.length > 200 || filled.length > 2500) return null;
  return { subject, body: filled };
}

/**
 * Sends the confirmation once per envelope (an atomic claim first; never retried). Returns the line for Project's message.
 * `parseTemplate` turns the Notion "Full email" text into { subject, body }.
 */
export async function sendTrialConfirmation({ gmail, notion, kv, parseTemplate, who, rate, addendum, envelopeId, now, log = () => {} }) {
  const first = String(who?.fullName ?? '').trim().split(/\s+/)[0] ?? '';
  if (!gmail || !(await gmail.connected().catch(() => false))) return `I didn't email ${first} the confirmation: your Gmail isn't connected for me.`;
  let template = null;
  try { template = parseTemplate(await notion.getEmailTemplate(TRIAL_CONFIRM_TEMPLATE_ID)); } catch { template = null; }
  // Sent the invitation earlier: this is the next email in that conversation, as a reply in its thread, without a second
  // congratulations (Project, 2026-10-20: "do you see how this would be redundant in a string").
  const invite = who.pageId ? await kv.get(`trialinvite:${who.pageId}`).catch(() => null) : null;
  const sameTo = String(invite?.email ?? '').toLowerCase() === String(who.email ?? '').toLowerCase();
  let afterInvite = !!invite?.sentAt && sameTo;
  let inviteId = afterInvite ? invite.messageId ?? null : null;
  let inviteSubject = afterInvite ? invite.subject ?? null : null;
  // Project's own invitation that Uncle Sam found and so didn't send (trial-invite.mjs): that thread.
  if (!afterInvite && sameTo && invite?.dropped === 'sent_by_hand' && invite.handSent?.messageId) {
    afterInvite = true; inviteId = invite.handSent.messageId; inviteSubject = invite.handSent.subject ?? null;
  }
  // An invitation sent by hand (or to this address before Uncle Sam kept a record) counts too: Project's Sent mail is checked, so
  // there's never a second congratulations (Project, 2026-10-20: "make sure there is no double congrats").
  if (!afterInvite && who.email && typeof gmail.searchSent === 'function') {
    const found = await gmail.searchSent(inviteThreadQuery(who.email)).catch(() => []);
    if (found?.length) { afterInvite = true; inviteId = found[0].id ?? null; inviteSubject = found[0].subject ?? null; }
  }
  const email = fillTrialConfirmation(template, { firstName: first, start: who.trialStart ?? null, end: who.trialEnd ?? null, rate, addendum, afterInvite });
  if (!email) return `I didn't email ${first} the confirmation: the template in Notion has changed shape. Send it by hand.`;
  if (!(await kv.claim(`trial-confirm:${envelopeId}`, { at: now, to: who.email }, now))) return '';
  // The reply carries the invitation's own subject: Gmail only threads a reply whose subject matches.
  const base = String(inviteSubject ?? email.subject).trim();
  const thread = afterInvite && /^[0-9a-f]{6,40}$/.test(inviteId ?? '') ? { replyTo: inviteId, subject: /^re:/i.test(base) ? base : `Re: ${base}` } : {};
  try {
    const sent = await gmail.send({ to: who.email, subject: email.subject, body: email.body, ...thread });
    await kv.put(`trial-confirm:${envelopeId}`, { at: now, to: who.email, id: sent.id }, now);
    if (who.pageId) await notion.appendCandidateNote({ pageId: who.pageId, sourceUrl: sent.url,
      text: `${new Date(now).toISOString().slice(0, 10)} · Work-trial confirmation emailed from Project's Gmail with the DocuSign packet (by Uncle Sam).` }).catch(() => null);
    log(`uncle_sam_trial_confirm sent=${String(envelopeId).slice(0, 8)}`);
    return `Emailed ${first} the confirmation from your Gmail.`;
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'failed';
    return error?.uncertain || error?.detail?.uncertain ? `The confirmation email to ${first} may or may not have gone out (${code}); check your Sent folder before sending it again.`
      : `I couldn't email ${first} the confirmation (${code}). Send it by hand.`;
  }
}

/**
 * The tracker, updated on the same tap the documents go out (notion-client.mjs recordPacketSent), plus a dated note naming the
 * documents, the envelope, the pay per day and who called the trial. Returns the line for Project's reply ('' when there is no
 * record to update). Never throws.
 */
export async function recordPacketOnTracker({ notion, who, rate = null, addendum = false, envelopeId, now, calledBy = null, addendumOnly = false }) {
  if (!who?.pageId || typeof notion?.recordPacketSent !== 'function') return '';
  const first = String(who.fullName ?? '').trim().split(/\s+/)[0] || 'They';
  const day = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric' }).format(now);
  const pay = validRate(rate) ? rate : null;
  try {
    await notion.recordPacketSent({ pageId: who.pageId, expectedEmail: who.email ?? null, dailyRate: pay,
      nextAction: `${first}: sign the work trial documents in DocuSign (${addendumOnly ? 'compensation addendum' : 'packet'} sent ${day}). Project countersigns after. ${who.trialStart ? 'Jamie and AA set up accounts two days before the trial.' : `Trial dates not on the record yet: get them from ${first}.`}` });
  } catch (error) {
    if (error?.code === 'candidate_rate_changed') return `The packet was sent at ${rateText(pay)}, but the tracker now has different pay. I preserved the tracker rate; review the terms before any further send.`;
    return `I couldn't update the tracker (${typeof error?.code === 'string' ? error.code : 'failed'}): set Paperwork to Sent${pay ? ` and the rate to ${rateText(pay)}` : ''} by hand.`;
  }
  const docs = addendumOnly ? 'the compensation addendum on its own (the NDA, CIIAA and Terms of Service went out earlier)' : `NDA, CIIAA, Terms of Service${addendum ? ', compensation addendum' : ''}`;
  await notion.appendCandidateNote?.({ pageId: who.pageId,
    text: `${new Date(now).toISOString().slice(0, 10)} · Work trial documents sent through DocuSign by Uncle Sam on Project's instruction${calledBy ? ` (work trial called by ${calledBy})` : ''}: ${docs}. Envelope ${String(envelopeId ?? '').slice(0, 36)}.${pay ? ` Pay per day: ${rateText(pay)}.` : ''} Tracker: Paperwork Sent, Stage Trial, Waiting on Candidate.` }).catch(() => null);
  return 'Tracker updated.'; // Project, 2026-10-18: just "Tracker updated", not the field list
}
