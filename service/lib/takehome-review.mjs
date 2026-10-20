/**
 * Take-home review by button and form (Slack Block Kit). Pure: builds the buttons, the modal and the step-by-step message,
 * and reads a submitted form back into a checked, structured review. The runner sends the request and records the answer
 * (agent-runner.mjs, takehome_form and takehome_reject events); the interactivity endpoint (slack-interactions.mjs) opens
 * the modal and records clicks.
 *
 * Project, 2026-10-15: a take-home submission reaches Interviewer as a notification that walks him through three steps on the
 * same message, which updates in place as he goes:
 *   Step 1  the call: Open the portal to look it over, then Advance to deep dive or Do not advance.
 *   Step 2  one sentence of notes (a one-field form; Slack only takes typing in a form). It goes to the scorecard's
 *           "Interviewer notes" beside the portal score, which stays the auto-populated portal grade.
 *   Step 3  Advance: nothing to do; the deep-dive invite with his booking link is queued from Project's Gmail (Project can
 *           cancel it for 30 minutes). Do not advance: Confirm reject / Not yet on the same message; Confirm is a firm
 *           reject and closes the record, and Project hears who rejected whom.
 * Typing a reply in the thread keeps working.
 */
export const TAKEHOME_CALLBACK = 'uncle_sam_takehome';
export const TAKEHOME_ACTIONS = Object.freeze(['takehome.grading_request', 'takehome.grading_reminder']);
export const TH_DECISIONS = Object.freeze(['advance', 'do_not_advance']);
export const TH_BUTTONS = Object.freeze({ th_advance: 'advance', th_do_not_advance: 'do_not_advance' });
/** Step 3 after a "do not advance": the reject is confirmed on the same message. */
export const TH_REJECT_BUTTONS = Object.freeze({ th_rj_confirm: 'confirm', th_rj_not_yet: 'not_yet' });
export const TH_DECISION_LABEL = Object.freeze({ advance: 'Advance', do_not_advance: 'Do not advance' });
/** The one next step after an Advance. */
export const TH_NEXT = Object.freeze({ deep_dive: 'Technical deep dive with me' });
/** Interviewer's recommendation as the scorecard's "Interviewer review" option. */
export const TH_REVIEW_OPTION = Object.freeze({ advance: 'Advance recommended', do_not_advance: 'Reject recommended' });
export const PORTAL_ADMIN_URL = 'https://company-takehome.vercel.app/admin';
/** Interviewer's note is one sentence (shown in the Take-homes view next to the portal score). */
export const NOTE_MAX = 300;

const pt = (text, emoji = true) => ({ type: 'plain_text', text: String(text).slice(0, 3000), emoji });
const clean = (value, max) => String(value ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f<>]/gu, ' ').replace(/[ \t]+/g, ' ').trim().slice(0, max);
const option = (value, label) => ({ text: pt(label), value });
const button = (actionId, text, value, style) => ({ type: 'button', action_id: actionId, text: pt(text), value, ...(style ? { style } : {}) });
const input = (blockId, label, element, { optional = false, hint, dispatch = false } = {}) => ({ type: 'input', block_id: blockId, label: pt(label),
  element, optional, ...(hint ? { hint: pt(hint) } : {}), ...(dispatch ? { dispatch_action: true } : {}) });
const text = (actionId, { multiline = false, placeholder, initial, max = 2000 } = {}) => ({ type: 'plain_text_input', action_id: actionId, multiline,
  max_length: max, ...(placeholder ? { placeholder: pt(placeholder) } : {}), ...(initial ? { initial_value: String(initial).slice(0, max) } : {}) });
const context = line => ({ type: 'context', elements: [pt(line)] });

/** Step 1's buttons under a take-home notification or its reminder. `value` carries the request key (re-checked on click). */
export function takeHomeButtons(requestKey) {
  return { type: 'actions', block_id: 'uncle_sam_takehome', elements: [
    { type: 'button', action_id: 'th_portal', text: pt('Open the portal'), url: PORTAL_ADMIN_URL },
    button('th_advance', 'Advance to deep dive', requestKey, 'primary'), button('th_do_not_advance', 'Do not advance', requestKey)] };
}

/** Step 3's buttons after a "do not advance", on the same message. */
export function takeHomeRejectButtons(requestKey, candidateName = 'this candidate') {
  const name = String(candidateName).replace(/[&<>|*_~`]/g, ' ').slice(0, 80);
  return { type: 'actions', block_id: 'uncle_sam_takehome_reject', elements: [
    { ...button('th_rj_confirm', 'Confirm reject', requestKey, 'danger'), confirm: { title: pt('Confirm the rejection'),
      text: pt(`${name} is marked Not Selected and the rejection email goes out from Project's account after the 24-hour rule.`), confirm: pt('Reject'), deny: pt('Go back'), style: 'danger' } },
    button('th_rj_not_yet', 'Not yet', requestKey)] };
}

export const TH_STEP_ONE = '🫵 Step 1 of 3 · Look it over, then make your call.';

/** The steps so far, as lines under the notification. */
export function takeHomeStepLines(form, { note = true } = {}) {
  const call = form.decision === 'advance' ? 'Advance to a technical deep dive with you' : 'Do not advance';
  return [`🎖️ Step 1 · Your call: ${call}`, ...(note && form.observations ? [`🎖️ Step 2 · Note: ${form.observations}`] : [])];
}

/** The notification as it stands: its text, one context line per step, then any buttons still to press. */
export function takeHomeStepBlocks({ body, bodyBlock = null, steps = [], actions = null, link = null }) {
  return [bodyBlock ?? { type: 'section', text: pt(body) }, ...steps.map(line => context(line)), ...(actions ? [actions] : []),
    ...(link ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: link }] }] : [])];
}

/**
 * The form. `meta` = { requestKey, decision } (round-tripped in private_metadata, re-checked against the stored request on
 * submit); `values` = anything already typed.
 */
export function takeHomeModal({ meta, candidateName, scoreLine, values = {} }) {
  const { decision } = meta;
  const v = name => values[name];
  const call = decision === 'advance' ? 'Advance to a technical deep dive with you' : 'Do not advance';
  const blocks = [{ type: 'section', text: pt(`${candidateName} — take-home${scoreLine ? ` (${scoreLine})` : ''}\nYour call: ${call}`) },
    input('observations', 'Notes (one sentence)', text('observations', { initial: v('observations'), max: NOTE_MAX,
      placeholder: decision === 'advance' ? 'e.g. Clean reward design, thin on evals' : 'Why not. Kept internal, never sent to the candidate.' })),
    context(decision === 'advance'
      ? "📋 Step 3: I'll email them your deep-dive link from Project's Gmail. Nothing more needed from you."
      : "📋 Step 3: you confirm the reject on my message. Nothing goes out before that.")];
  return { type: 'modal', callback_id: TAKEHOME_CALLBACK, private_metadata: JSON.stringify(meta).slice(0, 3000), title: pt('Step 2 of 3 · Note'),
    submit: pt(decision === 'advance' ? 'Send' : 'Next'), close: pt('Cancel'), blocks };
}

export function takeHomeDoneModal(form) {
  return { type: 'modal', title: pt('Uncle Sam'), close: pt('Close'), blocks: [{ type: 'section',
    text: pt(form.decision === 'advance' ? "Roger that 🫡 I'll queue the deep-dive invite from Project's Gmail. Nothing more needed from you."
      : 'Roger that 🫡 Last step: confirm the reject on my message.') }] };
}

/** Every value typed so far, by block id (for keeping it across a views.update). */
export function takeHomeValuesOf(view) {
  const out = {};
  for (const [blockId, actions] of Object.entries(view?.state?.values ?? {})) {
    const a = Object.values(actions ?? {})[0] ?? {};
    if (a.type === 'plain_text_input' || a.type === 'number_input') out[blockId] = a.value ?? '';
  }
  return out;
}

/** The metadata the form carried, checked: never trusted beyond its shape (the runner re-reads the request). */
export function takeHomeMetaOf(view) {
  let meta; try { meta = JSON.parse(view?.private_metadata ?? ''); } catch { return null; }
  if (!meta || typeof meta.requestKey !== 'string' || !/^usam:v1:[0-9a-f]{64}$/.test(meta.requestKey) || !TH_DECISIONS.includes(meta.decision)) return null;
  return { requestKey: meta.requestKey, decision: meta.decision };
}

/** Reads a submitted form into a review, or field errors keyed by block id (Slack shows them under each field). */
export function readTakeHomeSubmission(view, meta) {
  const v = takeHomeValuesOf(view), errors = {};
  const need = (id, message, value = v[id]) => { if (value == null || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && !value.length)) errors[id] = message; };
  const form = { decision: meta.decision, observations: clean(v.observations, NOTE_MAX), score: null };
  need('observations', meta.decision === 'advance' ? 'One sentence on what stood out, so it is kept in their history.' : 'One sentence on why not, so it is kept in their history.');
  if (meta.decision === 'advance') Object.assign(form, { nextStep: 'deep_dive' });
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, form };
}

/** One line on the next step, as people read it. */
export function takeHomeNextStepText(form) {
  return form.nextStep === 'deep_dive' ? "technical deep dive with Interviewer, invite emailed from Project's Gmail" : '';
}

/** The whole review as text, for the candidate's history (kept word for word). */
export function takeHomeReportText(form, who, scoreLine) {
  const lines = [`${who}: ${TH_DECISION_LABEL[form.decision]} on the take-home${scoreLine ? ` (${scoreLine})` : ''}.`];
  if (form.observations) lines.push(`Notes: ${form.observations}`);
  if (form.nextStep) lines.push(`Next step: ${takeHomeNextStepText(form)}.`);
  return lines.join('\n');
}

/** What still has to happen, and by whom (the candidate's Next action). */
export function takeHomeNextAction(form) {
  if (form.decision === 'do_not_advance') return 'Interviewer (Robin, Alexis or Interviewer): confirm the rejection before anything is sent.';
  return "Candidate: book the technical deep dive with Interviewer from the invite emailed from Project's Gmail. Project: watch for the booking.";
}

/** The note to Project after a "do not advance" (an Advance queues the invite email instead; see deepDiveNotice). */
export function takeHomeBooking(form, who) {
  return `${who} recommends not advancing after the take-home. Robin, Alexis or Interviewer decide; nothing goes to the candidate until one of them confirms.`;
}

// ---------------------------------------------------------------------------------------------------------------
// The deep-dive invite: after Interviewer's Advance, Uncle Sam queues the "Email · Deep Dive · Invitation" template, filled in,
// on an Operations row; Project gets a heads-up with a Cancel button; the clerk sends it from Project's Gmail on its first run
// at least 30 minutes later (weekdays, hourly at :31 from 9:31 to 23:31 Pacific).
// ---------------------------------------------------------------------------------------------------------------
export const DEEP_DIVE_TEMPLATE_ID = '7832a757-daba-4d42-90b8-f948a35f47a4';
export const DEEP_DIVE_HOLD_MS = 30 * 60_000;
export const DEEP_DIVE_ACTION = 'email.deep_dive_invite';
// The one reminder when they still haven't booked 3 days after the invite (Project, 2026-10-15): "Email · Deep Dive · Reminder".
export const DEEP_DIVE_REMINDER_TEMPLATE_ID = 'eada5af1-dfc4-414f-b772-c44e0654a116';
export const DEEP_DIVE_NUDGE_ACTION = 'email.deep_dive_nudge';
export const DEEP_DIVE_NUDGE_AFTER_MS = 3 * 86400_000;
const PLACEHOLDER = /\{\{[^}]*\}\}|\[[A-Z][^\]]*\]/;

/** "Subject: …" on the first line, a blank line, then the body: the shape of every Template Emails row. */
export function parseTemplate(fullEmail) {
  const text = String(fullEmail ?? '').replace(/\r\n/g, '\n').trim();
  const match = /^Subject:[ \t]*(.+)\n\s*\n([\s\S]+)$/.exec(text);
  if (!match) return null;
  return { subject: match[1].trim(), body: match[2].trim() };
}

/**
 * The template filled in for one candidate. Only the two placeholders it may carry; anything else still in brackets or
 * braces means the template changed shape, so nothing is queued.
 */
export function fillDeepDiveEmail(template, { firstName, link }) {
  if (!template || typeof firstName !== 'string' || !firstName.trim() || typeof link !== 'string' || !/^https:\/\//.test(link)) return null;
  // A Calendly "/d/" link is single-use: it broke for every candidate after the first (Oct 14). Only Interviewer's reusable link.
  if (/^https:\/\/(?:www\.)?calendly\.com\/d\//i.test(link)) return null;
  const fill = text => text.replaceAll('{{candidate_first_name}}', firstName.trim()).replaceAll('{{santosh_deep_dive_link}}', link);
  const subject = fill(template.subject), body = fill(template.body);
  if (PLACEHOLDER.test(subject) || PLACEHOLDER.test(body) || !body.includes(link) || subject.length > 200 || body.length > 1900) return null;
  return { subject, body };
}

/** The clerk's first run at or after `ms`: weekdays, hourly at :31 from 9:31 to 23:31 America/Los_Angeles. */
export function nextClerkRun(ms) {
  const parts = t => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', hour: 'numeric',
    minute: 'numeric', hourCycle: 'h23' }).formatToParts(t).map(p => [p.type, p.value]));
  let t = Math.ceil(ms / 60_000) * 60_000;
  for (let i = 0; i < 8 * 24 * 60; i++, t += 60_000) {
    const p = parts(t), hour = Number(p.hour), minute = Number(p.minute);
    if (!['Sat', 'Sun'].includes(p.weekday) && minute === 31 && hour >= 9 && hour <= 23) return t;
  }
  return null;
}

/** "at 2:31pm PT" today, or "Mon at 9:31am PT". */
export function clerkRunText(ms, now) {
  const fmt = (t, o) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', ...o }).format(t);
  const time = fmt(ms, { hour: 'numeric', minute: '2-digit' }).replace(' ', '').toLowerCase();
  const sameDay = fmt(ms, { dateStyle: 'short' }) === fmt(now, { dateStyle: 'short' });
  return `${sameDay ? '' : `${fmt(ms, { weekday: 'short' })} `}at ${time} PT`;
}

/** The Cancel button under Project's heads-up. `value` carries that heads-up's request key (re-checked on click). */
export function cancelButtons(requestKey) {
  return { type: 'actions', block_id: 'uncle_sam_email_cancel', elements: [button('em_cancel', 'Cancel the email', requestKey, 'danger')] };
}

/** Three to six "Label: text" lines for the Candidate brief. */
export function takeHomeBriefBullets(form, who, dayLine, scoreLine) {
  const cut = s => clean(String(s).replace(/\s+/g, ' '), 220);
  const bullets = [cut(`Status: take-home reviewed, ${TH_DECISION_LABEL[form.decision].toLowerCase()} from ${who} on ${dayLine}`)];
  bullets.push(cut(`Assessment: ${scoreLine ? `${scoreLine}; ` : ''}${form.observations || 'no notes given'}`));
  if (form.nextStep) bullets.push(cut(`Next step: ${takeHomeNextStepText(form)}`));
  bullets.push(cut(`Open items: ${takeHomeNextAction(form)}`));
  return bullets.slice(0, 6);
}
