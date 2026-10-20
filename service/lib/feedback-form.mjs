/**
 * Interview feedback by button and form (Slack Block Kit). Pure: builds the buttons and the modal, and reads a submitted
 * form back into a checked, structured report. The runner records it (agent-runner.mjs, feedback_form events); the
 * interactivity endpoint (slack-interactions.mjs) opens and updates the modal.
 *
 * The buttons replace only the yes/no part of an interviewer's reply. The form always asks for what is needed to book the
 * next step: for "advance", which next step (another interview, a take-home or a work trial) and its details, with dates
 * for a work trial. Typing a reply in the thread keeps working exactly as before.
 */
export const FEEDBACK_CALLBACK = 'uncle_sam_feedback';
export const DECISIONS = Object.freeze(['advance', 'do_not_advance', 'hold', 'did_not_happen']);
export const NEXT_STEPS = Object.freeze(['interview', 'take_home', 'work_trial']);
/** The next step a feedback question expected (prompt-review.mjs likely_next) as the form's step; a deep dive is another interview. */
export const SUGGESTED_STEP = Object.freeze({ take_home: 'take_home', another_interview: 'interview', deep_dive: 'interview', work_trial: 'work_trial' });
/** Button action ids: the four decisions on a feedback prompt, the three next steps on a "what's next" question. */
export const DECISION_BUTTONS = Object.freeze({ fb_advance: 'advance', fb_do_not_advance: 'do_not_advance', fb_hold: 'hold', fb_did_not_happen: 'did_not_happen' });
export const NEXT_STEP_BUTTONS = Object.freeze({ ns_interview: 'interview', ns_take_home: 'take_home', ns_work_trial: 'work_trial' });
export const DECISION_LABEL = Object.freeze({ advance: 'Advance', do_not_advance: 'Do not advance', hold: 'Hold', did_not_happen: "Didn't happen" });
export const NEXT_STEP_LABEL = Object.freeze({ interview: 'Another interview', take_home: 'Take-home', work_trial: 'Work trial' });
/** Who can be picked to run the next interview: the verified interviewers (Slack ID -> name used in Notion). */
export const INTERVIEWER_CHOICES = Object.freeze({ U0A4F08721B: 'Robin', U0476A5BC82: 'Alexis', U0BF89D1279: 'AA (Rory Marshall)', U030A09DBFF: 'Interviewer (Quinn)' });
export const ROBIN = 'U0A4F08721B';
export const INTERVIEWER = 'U030A09DBFF';
/**
 * Interviewer's technical deep dive (after he advances a take-home): his own buttons. Work trial and Another round open the
 * form on that next step; the other three are the usual decisions. Project, 2026-10-15: after a deep dive, Interviewer decides
 * whether the candidate goes to the work trial.
 */
export const DEEP_DIVE_BUTTONS = Object.freeze({ dd_work_trial: Object.freeze({ decision: 'advance', nextStep: 'work_trial' }),
  dd_another_round: Object.freeze({ decision: 'advance', nextStep: 'interview' }) });
const DEEP_DIVE_STEPS = Object.freeze({ work_trial: 'Work trial', interview: 'Another round' });
/** Who can send a candidate to the work trial: Robin or Interviewer, on any interview (Project, 2026-10-16: "if interviewer says work trial then its a work trial"). */
export const workTrialAuthorized = (form, whoId) => whoId === ROBIN || whoId === INTERVIEWER;
const hasDates = form => !!(form?.trialStart && form?.trialEnd);
const HAPPENED = Object.freeze({ no_show: 'No-show', rescheduled: 'Rescheduled', cancelled: 'Cancelled' });

const pt = (text, emoji = true) => ({ type: 'plain_text', text: String(text).slice(0, 3000), emoji });
const clean = (value, max) => String(value ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f<>]/gu, ' ').replace(/[ \t]+/g, ' ').trim().slice(0, max);
const isoDate = value => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? value : null);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** "2026-10-20" -> "Tue, Oct 20, 2026". */
export function dayText(value) {
  const date = isoDate(value); if (!date) return '';
  const d = new Date(`${date}T12:00:00Z`);
  return `${DAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
/** Today's date in Los Angeles as YYYY-MM-DD. */
export const todayLA = (now = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

const button = (actionId, text, value, style) => ({ type: 'button', action_id: actionId, text: pt(text), value, ...(style ? { style } : {}) });
/** The four decision buttons under a feedback prompt or reminder. `value` carries the request key (re-checked on click). */
/**
 * Robin's (and Interviewer's) one-tap next steps on an interview prompt (Project, 2026-10-19: "robin should also have a button that has
 * skip to work trial and then if he clicks that it forces him to put in dates" / "he should also have the option to just send
 * them the take home"): Send take-home queues it (Project's 30-minute Cancel, as before); Skip to work trial asks for the dates.
 */
export const SHORTCUT_BUTTONS = Object.freeze({ fb_take_home: Object.freeze({ decision: 'advance', nextStep: 'take_home' }),
  fb_work_trial: Object.freeze({ decision: 'advance', nextStep: 'work_trial' }) });
export function decisionButtons(requestKey, { shortcuts = false } = {}) {
  return { type: 'actions', block_id: 'uncle_sam_decision', elements: [
    ...(shortcuts ? [button('fb_take_home', 'Send take-home', requestKey, 'primary'), button('fb_work_trial', 'Skip to work trial', requestKey)] : []),
    button('fb_advance', shortcuts ? 'Another interview' : 'Advance', requestKey, shortcuts ? undefined : 'primary'), button('fb_do_not_advance', 'Do not advance', requestKey),
    button('fb_hold', 'Hold', requestKey), button('fb_did_not_happen', "Didn't happen", requestKey)] };
}
/**
 * Under a rejection confirmation question (Project, 2026-10-15: a second button to confirm, not a typed "yes"). Confirm asks once
 * more in Slack's own dialog, since it closes the record and queues the email.
 */
export const REJECTION_BUTTONS = Object.freeze({ rj_confirm: 'confirm', rj_not_yet: 'not_yet' });
export function rejectionButtons(requestKey, candidateName = 'this candidate') {
  const name = String(candidateName).replace(/[&<>|*_~`]/g, ' ').slice(0, 80);
  return { type: 'actions', block_id: 'uncle_sam_rejection_confirm', elements: [
    { ...button('rj_confirm', 'Confirm reject', requestKey, 'danger'), confirm: { title: pt('Confirm the rejection'),
      text: pt(`${name} is marked Not Selected and the rejection email goes out from Project's account after the 24-hour rule.`), confirm: pt('Reject'), deny: pt('Go back'), style: 'danger' } },
    button('rj_not_yet', 'Not yet', requestKey)] };
}
/** The deep-dive verdict buttons. */
export function deepDiveButtons(requestKey) {
  return { type: 'actions', block_id: 'uncle_sam_deep_dive', elements: [
    button('dd_work_trial', 'Work trial', requestKey, 'primary'), button('dd_another_round', 'Another round', requestKey),
    button('fb_do_not_advance', 'Do not advance', requestKey), button('fb_hold', 'Hold', requestKey), button('fb_did_not_happen', "Didn't happen", requestKey)] };
}
/** The three next-step buttons under a "what's the next step" question. */
export function nextStepButtons(requestKey) {
  return { type: 'actions', block_id: 'uncle_sam_next_step', elements: [
    button('ns_interview', 'Another interview', requestKey), button('ns_take_home', 'Take-home', requestKey), button('ns_work_trial', 'Work trial', requestKey)] };
}

const input = (blockId, label, element, { optional = false, hint, dispatch = false } = {}) => ({ type: 'input', block_id: blockId, label: pt(label),
  element, optional, ...(hint ? { hint: pt(hint) } : {}), ...(dispatch ? { dispatch_action: true } : {}) });
const text = (actionId, { multiline = false, placeholder, initial, max = 2000 } = {}) => ({ type: 'plain_text_input', action_id: actionId, multiline,
  max_length: max, ...(placeholder ? { placeholder: pt(placeholder) } : {}), ...(initial ? { initial_value: String(initial).slice(0, max) } : {}) });
const date = (actionId, initial) => ({ type: 'datepicker', action_id: actionId, ...(isoDate(initial) ? { initial_date: initial } : {}) });
const option = (value, label) => ({ text: pt(label), value });
const radios = (actionId, choices, initial) => ({ type: 'radio_buttons', action_id: actionId, options: Object.entries(choices).map(([v, l]) => option(v, l)),
  ...(initial && choices[initial] ? { initial_option: option(initial, choices[initial]) } : {}) });
const context = line => ({ type: 'context', elements: [pt(line)] });

/**
 * The form. `meta` = { requestKey, decision, nextStep?, nextStepOnly? } (round-tripped in private_metadata and re-checked
 * against the stored request on submit); `who` = the clicking user's Slack ID; `values` = what is already typed, so a
 * change of next step keeps it.
 */
export function feedbackModal({ meta, candidateName, roleRound, who, values = {} }) {
  const { decision, nextStep, nextStepOnly, deepDive, shortcut } = meta;
  const v = name => values[name];
  const blocks = [{ type: 'section', text: pt(`${candidateName}${roleRound ? ` — ${roleRound}` : ''}\nYour call: ${DECISION_LABEL[decision]}${nextStepOnly ? ' (next step)' : ''}`) }];
  if (decision === 'advance') {
    if (!nextStepOnly) blocks.push(input('observations', 'Why (what stood out)', text('observations', { multiline: true, initial: v('observations'),
      placeholder: deepDive ? 'A sentence is enough: why they were strong, any notes' : 'A sentence is enough: why they were good, any notes or concerns' }), { optional: !!shortcut }));
    // A shortcut button already picked the next step: no radio to pick it again.
    if (!shortcut) blocks.push(input('next_step', 'Next step', radios('next_step', deepDive ? DEEP_DIVE_STEPS : NEXT_STEP_LABEL, nextStep), { dispatch: true }));
    if (nextStep === 'interview') {
      blocks.push(input('round', 'Which round', text('round', { initial: v('round'), placeholder: 'e.g. R3 — case study', max: 120 })));
      blocks.push(input('interviewers', 'Who should interview', { type: 'multi_static_select', action_id: 'interviewers', placeholder: pt('Pick one or more'),
        options: Object.entries(INTERVIEWER_CHOICES).map(([id, name]) => option(id, name)),
        ...(Array.isArray(v('interviewers')) && v('interviewers').length ? { initial_options: v('interviewers').filter(id => INTERVIEWER_CHOICES[id]).map(id => option(id, INTERVIEWER_CHOICES[id])) } : {}) }));
      // The process is set, so what the round tests is the same for everybody (Project, 2026-10-16): optional.
      blocks.push(input('focus', 'Anything to probe', text('focus', { multiline: true, initial: v('focus'), max: 800 }), { optional: true }));
      blocks.push(input('timing', 'Timing or availability', text('timing', { initial: v('timing'), placeholder: 'e.g. this week, mornings PT', max: 300 }), { optional: true }));
    } else if (nextStep === 'take_home') {
      blocks.push(input('takehome', 'Which take-home', text('takehome', { initial: v('takehome'), placeholder: 'Leave blank for the standard take-home', max: 160 }), { optional: true }));
      blocks.push(input('due', 'Due by', date('due', v('due')), { optional: true }));
      blocks.push(input('focus', 'Anything to look for', text('focus', { multiline: true, initial: v('focus'), max: 800 }), { optional: true }));
    } else if (nextStep === 'work_trial') {
      if (deepDive) blocks.push(input('concerns', 'Anything to watch in the trial', text('concerns', { multiline: true, initial: v('concerns'), placeholder: 'Gaps to test, areas to support', max: 800 }), { optional: true }));
      blocks.push(input('focus', "What they'll work on", text('focus', { multiline: true, initial: v('focus'), placeholder: 'Leave blank for the usual trial work', max: 800 }), { optional: true }));
      const noDates = "Leave blank if their dates aren't agreed. I'll get them from the candidate.";
      // Skip to work trial: the dates are required.
      blocks.push(input('trial_start', 'Trial start', date('trial_start', v('trial_start')), shortcut ? {} : { optional: true, hint: noDates }));
      blocks.push(input('trial_end', 'Trial end', date('trial_end', v('trial_end')), shortcut ? {} : { optional: true }));
      blocks.push(input('availability', 'Availability they mentioned', text('availability', { initial: v('availability'), placeholder: 'e.g. evenings IST, free from Oct 20', max: 300 }), { optional: true }));
      blocks.push(input('arrangement', 'Arrangement', text('arrangement', { initial: v('arrangement'), placeholder: 'Remote or on-site, hours, who supervises', max: 300 }), { optional: true }));
      if (workTrialAuthorized({ deepDive }, who)) blocks.push(context(deepDive ? '🫡 Your verdict sends them to the work trial. Project books it.' : '🫡 Your call sends them to the work trial. Project books it.'));
      else blocks.push(context('📋 Only Robin or Interviewer can call a work trial. This goes to them as your recommendation.'));
    } else blocks.push(context('🫵 Pick the next step and I will ask for what I need to book it.'));
  } else if (decision === 'do_not_advance') {
    blocks.push(input('observations', 'Why not', text('observations', { multiline: true, initial: v('observations'), placeholder: 'Kept internal. Never sent to the candidate.' })));
    blocks.push(context('📋 Robin or Alexis confirm before any rejection goes out.'));
  } else if (decision === 'hold') {
    blocks.push(input('waiting_on', 'What are we waiting on', text('waiting_on', { initial: v('waiting_on'), max: 300 })));
    blocks.push(input('check_back', 'Check back on', date('check_back', v('check_back')), { optional: true }));
    blocks.push(input('observations', 'Notes', text('observations', { multiline: true, initial: v('observations') }), { optional: true }));
  } else if (decision === 'did_not_happen') {
    blocks.push(input('what_happened', 'What happened', radios('what_happened', HAPPENED, v('what_happened'))));
    blocks.push(input('new_date', 'New date (if rescheduled)', date('new_date', v('new_date')), { optional: true }));
    blocks.push(input('new_time', 'New time (if rescheduled)', text('new_time', { initial: v('new_time'), placeholder: 'e.g. 2:00 PM PT', max: 60 }), { optional: true }));
    blocks.push(input('observations', 'Notes', text('observations', { multiline: true, initial: v('observations') }), { optional: true }));
  }
  blocks.push(context("🇺🇸 Uncle Sam records this word for word in the candidate's history. Nothing is sent until you submit."));
  return { type: 'modal', callback_id: FEEDBACK_CALLBACK, private_metadata: JSON.stringify(meta).slice(0, 3000), title: pt(deepDive ? 'Deep dive verdict' : 'Interview report'),
    submit: pt('Send report'), close: pt('Cancel'), blocks };
}

/** A small read-only modal for a click that cannot open the form (already answered, not yours, gone). */
export function noticeModal(message) {
  return { type: 'modal', title: pt('Uncle Sam'), close: pt('Close'), blocks: [{ type: 'section', text: pt(message) }] };
}
export function doneModal(form) {
  return noticeModal(`🫡 Report received: ${DECISION_LABEL[form.decision]}${form.nextStep ? ` · ${NEXT_STEP_LABEL[form.nextStep]}` : ''}. I'll record it and take it from here.`);
}

/** Every value typed so far, by block id (for keeping it across a views.update). */
export function valuesOf(view) {
  const out = {};
  for (const [blockId, actions] of Object.entries(view?.state?.values ?? {})) {
    const a = Object.values(actions ?? {})[0] ?? {};
    if (a.type === 'plain_text_input') out[blockId] = a.value ?? '';
    else if (a.type === 'radio_buttons') out[blockId] = a.selected_option?.value ?? null;
    else if (a.type === 'datepicker') out[blockId] = a.selected_date ?? null;
    else if (a.type === 'multi_static_select') out[blockId] = (a.selected_options ?? []).map(o => o.value);
  }
  return out;
}

/** The metadata the form carried, checked: never trusted beyond its shape (the runner re-reads the request). */
export function metaOf(view) {
  let meta; try { meta = JSON.parse(view?.private_metadata ?? ''); } catch { return null; }
  if (!meta || typeof meta.requestKey !== 'string' || !/^usam:v1:[0-9a-f]{64}$/.test(meta.requestKey) || !DECISIONS.includes(meta.decision)) return null;
  return { requestKey: meta.requestKey, decision: meta.decision, nextStep: NEXT_STEPS.includes(meta.nextStep) ? meta.nextStep : null, nextStepOnly: meta.nextStepOnly === true,
    ...(meta.deepDive === true ? { deepDive: true } : {}), ...(meta.shortcut === true && ['take_home', 'work_trial'].includes(meta.nextStep) ? { shortcut: true } : {}) };
}

/**
 * Reads a submitted form into a report, or field errors keyed by block id (Slack shows them under each field).
 * `today` = YYYY-MM-DD in Los Angeles.
 */
export function readSubmission(view, meta, { today }) {
  const v = valuesOf(view), errors = {};
  const need = (id, message, value = v[id]) => { if (value == null || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && !value.length)) errors[id] = message; };
  const form = { decision: meta.decision, nextStepOnly: meta.nextStepOnly === true, observations: clean(v.observations, 2000), ...(meta.deepDive === true ? { deepDive: true } : {}) };
  if (meta.decision === 'advance') {
    if (!meta.nextStepOnly && !meta.shortcut) need('observations', 'A sentence on why they were good, so it is kept in their history.');
    form.nextStep = meta.shortcut ? meta.nextStep : NEXT_STEPS.includes(v.next_step) ? v.next_step : null;
    if (!form.nextStep) errors.next_step = 'Pick the next step so it can be booked.';
    if (form.nextStep === 'interview') {
      need('round', 'Which round is next?'); need('interviewers', 'Who should run it?');
      Object.assign(form, { round: clean(v.round, 120), interviewers: (v.interviewers ?? []).filter(id => INTERVIEWER_CHOICES[id]), focus: clean(v.focus, 800), timing: clean(v.timing, 300) });
    } else if (form.nextStep === 'take_home') {
      Object.assign(form, { takehome: clean(v.takehome, 160) || 'standard', due: isoDate(v.due), focus: clean(v.focus, 800) });
      if (form.due && form.due < today) errors.due = 'Pick a date from today on.';
    } else if (form.nextStep === 'work_trial') {
      Object.assign(form, { trialStart: isoDate(v.trial_start), trialEnd: isoDate(v.trial_end), focus: clean(v.focus, 800), arrangement: clean(v.arrangement, 300),
        availability: clean(v.availability, 300), concerns: clean(v.concerns, 800) });
      // Skip to work trial: the dates are required (Project, 2026-10-19).
      if (meta.shortcut && !form.trialStart) errors.trial_start = 'Add the trial start.';
      if (meta.shortcut && !form.trialEnd) errors.trial_end = 'Add the trial end.';
      // Dates are optional (Project, 2026-10-15): without them the candidate is asked for their availability. Both or neither.
      if (form.trialStart && !form.trialEnd) errors.trial_end = 'Add the end too, or clear the start.';
      if (form.trialEnd && !form.trialStart) errors.trial_start = 'Add the start too, or clear the end.';
      if (form.trialStart && form.trialStart < today) errors.trial_start = 'Pick a start date from today on.';
      if (form.trialStart && form.trialEnd && form.trialEnd < form.trialStart) errors.trial_end = 'The end has to be on or after the start.';
    }
  } else if (meta.decision === 'do_not_advance') {
    need('observations', 'Tell me why, so it is kept in their history.');
  } else if (meta.decision === 'hold') {
    need('waiting_on', 'What are we waiting on?');
    Object.assign(form, { waitingOn: clean(v.waiting_on, 300), checkBack: isoDate(v.check_back) });
  } else if (meta.decision === 'did_not_happen') {
    form.whatHappened = HAPPENED[v.what_happened] ? v.what_happened : null;
    if (!form.whatHappened) errors.what_happened = 'Pick what happened.';
    Object.assign(form, { newDate: isoDate(v.new_date), newTime: clean(v.new_time, 60) });
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, form };
}

const names = ids => ids.map(id => INTERVIEWER_CHOICES[id]).filter(Boolean).join(', ');
/** One line on the next step, as people read it ("Work trial Tue, Oct 20, 2026 to Fri, Oct 24, 2026: ..."). */
export function nextStepText(form) {
  switch (form.nextStep) {
    case 'interview': return `${form.round} with ${names(form.interviewers)}${form.focus ? `; probe: ${form.focus}` : ''}${form.timing ? `; timing: ${form.timing}` : ''}`;
    case 'take_home': return `take-home: ${form.takehome}${form.due ? `, due ${dayText(form.due)}` : ''}${form.focus ? `; look for: ${form.focus}` : ''}`;
    case 'work_trial': return `work trial ${hasDates(form) ? `${dayText(form.trialStart)} to ${dayText(form.trialEnd)}` : '(dates not set yet)'}${form.focus ? `; work: ${form.focus}` : ''}${form.concerns ? `; watch: ${form.concerns}` : ''}${form.availability ? `; they mentioned: ${form.availability}` : ''}${form.arrangement ? `; arrangement: ${form.arrangement}` : ''}`;
    default: return '';
  }
}

/** The whole report as text, for the candidate's history (kept word for word). */
export function reportText(form, who) {
  const lines = [`${who}: ${DECISION_LABEL[form.decision]}${form.nextStepOnly ? ' (next step)' : ''}.`];
  if (form.observations) lines.push(`${form.decision === 'do_not_advance' ? 'Why not' : form.decision === 'advance' ? 'What stood out' : 'Notes'}: ${form.observations}`);
  if (form.nextStep) lines.push(`Next step: ${nextStepText(form)}.`);
  if (form.waitingOn) lines.push(`Waiting on: ${form.waitingOn}${form.checkBack ? `; check back ${dayText(form.checkBack)}` : ''}.`);
  if (form.whatHappened) lines.push(`What happened: ${HAPPENED[form.whatHappened]}${form.newDate ? `; new date ${dayText(form.newDate)}${form.newTime ? ` ${form.newTime}` : ''}` : ''}.`);
  return lines.join('\n');
}

/** What still has to happen, and by whom (the candidate's Next action). */
export function nextActionOf(form, whoId) {
  switch (form.decision) {
    case 'advance':
      if (form.nextStep === 'work_trial') {
        if (!workTrialAuthorized(form, whoId)) return `Robin or Interviewer: authorize the ${nextStepText(form)}. Then Project books it.`;
        return hasDates(form) ? `Project: book the ${nextStepText(form)} and start onboarding.`
          : `Project: send the work-trial request for information to get their dates, then book the ${nextStepText(form)}.`;
      }
      if (form.nextStep === 'interview') return `Project: schedule ${nextStepText(form)}.`;
      return `Project: send the ${nextStepText(form)}.`;
    case 'do_not_advance': return 'Interviewer (Robin, Alexis or Interviewer): confirm the rejection before anything is sent.';
    case 'hold': return `Decide after: ${form.waitingOn}${form.checkBack ? `; check back ${dayText(form.checkBack)}` : ''}.`;
    default: return form.whatHappened === 'rescheduled' && form.newDate ? `Project: confirm the new time ${dayText(form.newDate)}${form.newTime ? ` ${form.newTime}` : ''}.` : 'Project: reschedule or close the round.';
  }
}

/** Three to six "Label: text" lines for the Candidate brief. */
export function briefBulletsOf(form, who, on) {
  const cut = s => clean(String(s).replace(/\s+/g, ' '), 220);
  const bullets = [cut(`Status: ${DECISION_LABEL[form.decision]} from ${who} on ${dayText(on)}`)];
  bullets.push(cut(`Assessment: ${form.observations || 'no notes given'}`));
  if (form.nextStep) bullets.push(cut(`Next step: ${nextStepText(form)}`));
  if (form.waitingOn) bullets.push(cut(`Open items: waiting on ${form.waitingOn}`));
  if (form.whatHappened) bullets.push(cut(`Latest evidence: ${HAPPENED[form.whatHappened]}${form.newDate ? `, new date ${dayText(form.newDate)}` : ''}`));
  if (bullets.length < 3) bullets.push(cut(`Open items: ${nextActionOf(form)}`));
  return bullets.slice(0, 6);
}
