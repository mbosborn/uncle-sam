import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { feedbackModal, readSubmission, metaOf, valuesOf, decisionButtons, nextStepButtons, deepDiveButtons, reportText, nextActionOf, briefBulletsOf, dayText, todayLA,
  INTERVIEWER_CHOICES, FEEDBACK_CALLBACK, ROBIN } from '../service/lib/feedback-form.mjs';
import { createInteractionHandler } from '../service/lib/slack-interactions.mjs';
import { createStore } from '../service/lib/store.mjs';
import { persistedFixture } from './support/d1.mjs';
import { APP_ID, TEAM_ID } from '../service/lib/identity.mjs';

const KEY = `usam:v1:${'a'.repeat(64)}`;
const ALEXIS = 'U0476A5BC82', JAMIE = 'U0CB213D6D6';
const TODAY = '2026-10-15';
const blockIds = view => view.blocks.map(b => b.block_id).filter(Boolean);
const inputOf = (view, id) => view.blocks.find(b => b.block_id === id);
/** A submitted view: the form as built, with Slack's state for the given values. */
function submitted(meta, values) {
  const view = feedbackModal({ meta, candidateName: 'Synthetic Candidate', roleRound: 'R2', who: ROBIN });
  const state = {};
  for (const block of view.blocks.filter(b => b.type === 'input')) {
    const el = block.element, v = values[block.block_id];
    const entry = { type: el.type };
    if (el.type === 'plain_text_input') entry.value = v ?? null;
    if (el.type === 'radio_buttons') entry.selected_option = v ? { value: v } : null;
    if (el.type === 'datepicker') entry.selected_date = v ?? null;
    if (el.type === 'multi_static_select') entry.selected_options = (v ?? []).map(value => ({ value }));
    state[block.block_id] = { [el.action_id]: entry };
  }
  return { ...view, id: 'V0FORM1', hash: 'h1', state: { values: state } };
}

test('the prompt buttons carry the request key; decision and next-step sets are fixed', () => {
  const d = decisionButtons(KEY);
  assert.deepEqual(d.elements.map(e => [e.action_id, e.text.text, e.value]), [['fb_advance', 'Advance', KEY], ['fb_do_not_advance', 'Do not advance', KEY],
    ['fb_hold', 'Hold', KEY], ['fb_did_not_happen', "Didn't happen", KEY]]);
  assert.equal(d.elements[0].style, 'primary'); assert.ok(d.elements.slice(1).every(e => !e.style), 'only the approving button is styled');
  assert.deepEqual(nextStepButtons(KEY).elements.map(e => e.action_id), ['ns_interview', 'ns_take_home', 'ns_work_trial']);
});

test('the form asks for what each answer needs, and for "advance" always the next step and what it takes to book it', () => {
  const base = { requestKey: KEY };
  const open = feedbackModal({ meta: { ...base, decision: 'advance' }, candidateName: 'A', who: ROBIN });
  assert.equal(open.callback_id, FEEDBACK_CALLBACK); assert.equal(open.submit.text, 'Send report');
  assert.deepEqual(blockIds(open), ['observations', 'next_step']);
  assert.equal(inputOf(open, 'next_step').dispatch_action, true, 'choosing a next step redraws the form');
  const trial = feedbackModal({ meta: { ...base, decision: 'advance', nextStep: 'work_trial' }, candidateName: 'A', who: ROBIN });
  assert.deepEqual(blockIds(trial), ['observations', 'next_step', 'focus', 'trial_start', 'trial_end', 'availability', 'arrangement']);
  assert.deepEqual(['focus', 'trial_start', 'trial_end', 'availability', 'arrangement'].map(id => inputOf(trial, id).optional), [true, true, true, true, true],
    'Project, Oct 15: dates are optional; Oct 16: the process is set, so the trial work is optional too');
  assert.equal(JSON.stringify(trial).includes('Only Robin or Interviewer'), false);
  assert.equal(JSON.stringify(feedbackModal({ meta: { ...base, decision: 'advance', nextStep: 'work_trial' }, candidateName: 'A', who: INTERVIEWER })).includes('Only Robin or Interviewer'), false, 'Project, Oct 16: Interviewer calls a work trial on any interview');
  assert.ok(JSON.stringify(feedbackModal({ meta: { ...base, decision: 'advance', nextStep: 'work_trial' }, candidateName: 'A', who: ALEXIS })).includes('Only Robin or Interviewer can call a work trial'));
  const interview = feedbackModal({ meta: { ...base, decision: 'advance', nextStep: 'interview' }, candidateName: 'A', who: ROBIN });
  assert.deepEqual(blockIds(interview), ['observations', 'next_step', 'round', 'interviewers', 'focus', 'timing']);
  assert.deepEqual(inputOf(interview, 'interviewers').element.options.map(o => o.value), Object.keys(INTERVIEWER_CHOICES));
  assert.deepEqual(blockIds(feedbackModal({ meta: { ...base, decision: 'advance', nextStep: 'take_home' }, candidateName: 'A', who: ROBIN })), ['observations', 'next_step', 'takehome', 'due', 'focus']);
  assert.deepEqual(blockIds(feedbackModal({ meta: { ...base, decision: 'advance', nextStep: 'interview', nextStepOnly: true }, candidateName: 'A', who: ROBIN })),
    ['next_step', 'round', 'interviewers', 'focus', 'timing'], 'answering only the next step does not ask for the feedback again');
  assert.deepEqual(blockIds(feedbackModal({ meta: { ...base, decision: 'do_not_advance' }, candidateName: 'A', who: ROBIN })), ['observations']);
  assert.deepEqual(blockIds(feedbackModal({ meta: { ...base, decision: 'hold' }, candidateName: 'A', who: ROBIN })), ['waiting_on', 'check_back', 'observations']);
  assert.deepEqual(blockIds(feedbackModal({ meta: { ...base, decision: 'did_not_happen' }, candidateName: 'A', who: ROBIN })), ['what_happened', 'new_date', 'new_time', 'observations']);
  // What was typed survives a redraw.
  const kept = feedbackModal({ meta: { ...base, decision: 'advance', nextStep: 'interview' }, candidateName: 'A', who: ROBIN,
    values: { observations: 'Sharp', round: 'R3', interviewers: [ALEXIS, 'UNKNOWN1'], focus: 'Cases' } });
  assert.equal(inputOf(kept, 'observations').element.initial_value, 'Sharp');
  assert.deepEqual(inputOf(kept, 'interviewers').element.initial_options.map(o => o.value), [ALEXIS]);
  assert.ok(JSON.stringify(open).length < 20000);
});

test('a submitted form is checked field by field; a work trial needs real dates from today on', () => {
  const advance = { requestKey: KEY, decision: 'advance' };
  const errs = (meta, values) => { const r = readSubmission(submitted(meta, values), meta, { today: TODAY }); return r.ok ? null : Object.keys(r.errors).sort(); };
  assert.deepEqual(errs(advance, {}), ['next_step', 'observations']);
  assert.equal(errs({ ...advance, nextStep: 'work_trial' }, { observations: 'x', next_step: 'work_trial' }), null, 'the process is set: no trial work needed (Project, Oct 16)');
  assert.equal(errs({ ...advance, nextStep: 'work_trial' }, { observations: 'x', next_step: 'work_trial', focus: 'f' }), null, 'no dates is fine');
  assert.deepEqual(errs({ ...advance, nextStep: 'work_trial' }, { observations: 'x', next_step: 'work_trial', trial_start: '2026-10-20', focus: 'f' }), ['trial_end'], 'both dates or neither');
  assert.deepEqual(errs({ ...advance, nextStep: 'work_trial' }, { observations: 'x', next_step: 'work_trial', trial_start: '2026-10-14', trial_end: '2026-10-20', focus: 'f' }), ['trial_start']);
  assert.deepEqual(errs({ ...advance, nextStep: 'work_trial' }, { observations: 'x', next_step: 'work_trial', trial_start: '2026-10-20', trial_end: '2026-10-19', focus: 'f' }), ['trial_end']);
  assert.deepEqual(errs({ ...advance, nextStep: 'interview' }, { observations: 'x', next_step: 'interview' }), ['interviewers', 'round']);
  assert.equal(errs({ ...advance, nextStep: 'take_home' }, { observations: 'x', next_step: 'take_home' }), null, 'blank means the standard take-home');
  assert.deepEqual(errs({ ...advance, nextStep: 'take_home' }, { observations: 'x', next_step: 'take_home', takehome: 'Model', due: '2026-10-01' }), ['due']);
  assert.deepEqual(errs({ requestKey: KEY, decision: 'do_not_advance' }, {}), ['observations']);
  assert.deepEqual(errs({ requestKey: KEY, decision: 'hold' }, {}), ['waiting_on']);
  assert.deepEqual(errs({ requestKey: KEY, decision: 'did_not_happen' }, {}), ['what_happened']);
  const ok = readSubmission(submitted({ ...advance, nextStep: 'work_trial' }, { observations: 'Strong <b>x</b>\u0007', next_step: 'work_trial', trial_start: '2026-10-20', trial_end: '2026-10-24', focus: 'Pricing' }), { ...advance, nextStep: 'work_trial' }, { today: TODAY });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.form, { decision: 'advance', nextStepOnly: false, observations: 'Strong b x /b', nextStep: 'work_trial', trialStart: '2026-10-20', trialEnd: '2026-10-24', focus: 'Pricing', arrangement: '', availability: '', concerns: '' });
  const only = readSubmission(submitted({ ...advance, nextStep: 'take_home', nextStepOnly: true }, { next_step: 'take_home', takehome: 'Model' }), { ...advance, nextStepOnly: true }, { today: TODAY });
  assert.equal(only.ok, true, 'the next-step question does not ask for feedback again');
});

test('metadata is only trusted for its shape; reports read like a person wrote them', () => {
  assert.equal(metaOf({ private_metadata: 'nope' }), null);
  assert.equal(metaOf({ private_metadata: JSON.stringify({ requestKey: 'usam:v1:short', decision: 'advance' }) }), null);
  assert.equal(metaOf({ private_metadata: JSON.stringify({ requestKey: KEY, decision: 'hire' }) }), null);
  assert.deepEqual(metaOf({ private_metadata: JSON.stringify({ requestKey: KEY, decision: 'advance', nextStep: 'x', nextStepOnly: 'yes' }) }), { requestKey: KEY, decision: 'advance', nextStep: null, nextStepOnly: false });
  assert.equal(dayText('2026-10-20'), 'Tue, Oct 20, 2026'); assert.equal(dayText('nope'), '');
  assert.equal(todayLA(Date.parse('2026-10-15T06:30:00Z')), '2026-10-14', 'Los Angeles date, not UTC');
  const form = { decision: 'advance', observations: 'Sharp', nextStep: 'work_trial', trialStart: '2026-10-20', trialEnd: '2026-10-24', focus: 'Pricing', arrangement: '' };
  assert.equal(reportText(form, 'Robin'), 'Robin: Advance.\nWhat stood out: Sharp\nNext step: work trial Tue, Oct 20, 2026 to Sat, Oct 24, 2026; work: Pricing.');
  assert.match(nextActionOf(form, ROBIN), /^Project: book the work trial/); assert.match(nextActionOf(form, ALEXIS), /^Robin or Interviewer: authorize the work trial/); assert.match(nextActionOf(form, INTERVIEWER), /^Project: book the work trial/);
  for (const f of [form, { decision: 'hold', observations: '', waitingOn: 'references' }, { decision: 'did_not_happen', observations: '', whatHappened: 'no_show' }, { decision: 'do_not_advance', observations: 'Weak' }]) {
    const bullets = briefBulletsOf(f, 'Robin', '2026-10-15');
    assert.ok(bullets.length >= 3 && bullets.length <= 6, JSON.stringify(f)); assert.ok(bullets.every(b => /^[^:]{1,40}: \S/.test(b) && !b.includes('\n')));
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The interactivity endpoint
// ---------------------------------------------------------------------------------------------------------------
const SECRET = 'test-only-slack-signing-secret';
const NOW = Date.parse('2026-10-15T17:00:00Z');
function signed(payload, { secret = SECRET, at = NOW } = {}) {
  const raw = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const ts = String(Math.floor(at / 1000));
  const sig = `v0=${createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex')}`;
  return new Request('https://uncle-sam.example/api/slack/interactions', { method: 'POST', body: raw,
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-slack-request-timestamp': ts, 'x-slack-signature': sig } });
}
const envelope = (userId, extra) => ({ api_app_id: APP_ID, team: { id: TEAM_ID }, user: { id: userId, team_id: TEAM_ID }, ...extra });
const click = (userId, actionId, value = KEY) => envelope(userId, { type: 'block_actions', trigger_id: 'trig-1', actions: [{ action_id: actionId, value }] });

async function endpoint({ state = 'Sent', reply = null, action = 'interview.feedback_request', recipients = [ROBIN], deepDive = false } = {}) {
  const fixture = persistedFixture(NOW);
  const store = createStore(fixture.db, { authorized: true, clock: () => NOW });
  const requests = new Map([[KEY, { requestKey: KEY, action, state, candidateId: '11111111-2222-4333-8444-555555555555', occurrenceId: 'cal:1',
    recipientIds: recipients, payload: { roleRound: 'R2 — Technical', scoreLine: 'portal score 83/100', candidate: { fullName: 'Synthetic Candidate' }, ...(deepDive ? { deepDive: true } : {}) }, receipt: { channelId: 'DROUTE1', ...(reply ? { reply } : {}) } }]]);
  const fakeStore = { getRequest: async key => requests.get(key) ?? null, listRequestsForCandidate: async () => [...requests.values()],
    recordEvent: input => store.recordEvent(input), getEvent: id => store.getEvent(id) };
  const ui = { calls: [], viewsOpen: async input => { ui.calls.push(['open', input]); return { ok: true }; }, viewsUpdate: async input => { ui.calls.push(['update', input]); return { ok: true }; } };
  const runs = [];
  const handle = createInteractionHandler({ store: fakeStore, ui, clock: () => NOW, schedule: p => runs.push(p), run: async input => input,
    verify: { signingSecret: SECRET, allowedAppIds: [APP_ID], allowedTeamIds: [TEAM_ID], now: () => NOW } });
  return { handle, ui, runs, store, requests };
}

test('a click from the interviewer (or Robin or Alexis) opens the form; anyone else, or a second answer, gets a notice instead', async () => {
  const e = await endpoint();
  assert.equal((await e.handle(signed(click(ROBIN, 'fb_advance')))).status, 200);
  const [kind, { triggerId, view }] = e.ui.calls[0];
  assert.equal(kind, 'open'); assert.equal(triggerId, 'trig-1'); assert.equal(view.callback_id, FEEDBACK_CALLBACK);
  assert.deepEqual(JSON.parse(view.private_metadata), { requestKey: KEY, decision: 'advance' });
  await e.handle(signed(click(ALEXIS, 'fb_hold')));
  assert.equal(e.ui.calls[1][1].view.callback_id, FEEDBACK_CALLBACK, 'final authority may answer');
  await e.handle(signed(click(JAMIE, 'fb_advance')));
  assert.match(JSON.stringify(e.ui.calls[2][1].view), /This call belongs to the interviewer/);
  const answered = await endpoint({ reply: { kind: 'feedback' } });
  await answered.handle(signed(click(ROBIN, 'fb_advance')));
  assert.match(JSON.stringify(answered.ui.calls[0][1].view), /already reported/);
  const gone = await endpoint();
  await gone.handle(signed(click(ROBIN, 'fb_advance', `usam:v1:${'b'.repeat(64)}`)));
  assert.match(JSON.stringify(gone.ui.calls[0][1].view), /no longer on the books/);
  // Next-step buttons only work on a next-step question; there they open the form with the step chosen.
  const stray = await endpoint();
  await stray.handle(signed(click(ROBIN, 'ns_work_trial')));
  assert.equal(stray.ui.calls.length, 0);
  const question = await endpoint({ action: 'interview.next_step_request' });
  await question.handle(signed(click(ROBIN, 'ns_work_trial')));
  assert.deepEqual(JSON.parse(question.ui.calls[0][1].view.private_metadata), { requestKey: KEY, decision: 'advance', nextStep: 'work_trial', nextStepOnly: true });
});

test('Interviewer\'s deep dive: its own buttons; Work trial opens the verdict form on the work trial, his verdict needs no one else, dates optional', async () => {
  assert.deepEqual(deepDiveButtons(KEY).elements.map(b => b.action_id), ['dd_work_trial', 'dd_another_round', 'fb_do_not_advance', 'fb_hold', 'fb_did_not_happen']);
  const e = await endpoint({ deepDive: true, recipients: [INTERVIEWER] });
  await e.handle(signed(click(INTERVIEWER, 'dd_work_trial')));
  const view = e.ui.calls[0][1].view;
  assert.deepEqual(JSON.parse(view.private_metadata), { requestKey: KEY, decision: 'advance', nextStep: 'work_trial', deepDive: true });
  assert.equal(view.title.text, 'Deep dive verdict');
  assert.deepEqual(blockIds(view), ['observations', 'next_step', 'concerns', 'focus', 'trial_start', 'trial_end', 'availability', 'arrangement']);
  assert.equal(inputOf(view, 'focus').optional, true);
  assert.deepEqual(inputOf(view, 'next_step').element.options.map(o => o.text.text), ['Work trial', 'Another round']);
  assert.ok(JSON.stringify(view).includes('Your verdict sends them to the work trial'));
  const stray = await endpoint({ recipients: [INTERVIEWER] });
  await stray.handle(signed(click(INTERVIEWER, 'dd_work_trial')));
  assert.equal(stray.ui.calls.length, 0, 'deep-dive buttons only work on a deep-dive prompt');
  const meta = { requestKey: KEY, decision: 'advance', nextStep: 'work_trial', deepDive: true };
  const read = readSubmission(submitted(meta, { observations: 'Strong', next_step: 'work_trial' }), meta, { today: TODAY });
  assert.equal(read.ok, true); assert.equal(read.form.deepDive, true);
  assert.match(nextActionOf(read.form, INTERVIEWER), /^Project: send the work-trial request for information/);
  assert.match(nextActionOf({ ...read.form, deepDive: false }, INTERVIEWER), /^Project: send the work-trial request/, 'Interviewer calls it on any interview (Project, Oct 16)');
});

test('choosing a next step in the form redraws it with that step\'s fields and keeps what was typed', async () => {
  const e = await endpoint();
  const view = submitted({ requestKey: KEY, decision: 'advance' }, { observations: 'Sharp' });
  await e.handle(signed(envelope(ROBIN, { type: 'block_actions', view, actions: [{ action_id: 'next_step', selected_option: { value: 'work_trial' } }] })));
  const [kind, input] = e.ui.calls[0];
  assert.equal(kind, 'update'); assert.equal(input.viewId, 'V0FORM1'); assert.equal(input.hash, 'h1');
  assert.deepEqual(blockIds(input.view), ['observations', 'next_step', 'focus', 'trial_start', 'trial_end', 'availability', 'arrangement']);
  assert.equal(inputOf(input.view, 'observations').element.initial_value, 'Sharp');
});

test('a submission with gaps comes back with errors under the fields; a complete one is stored once and recorded in the background', async () => {
  const e = await endpoint();
  const meta = { requestKey: KEY, decision: 'advance', nextStep: 'work_trial' };
  const gaps = await e.handle(signed(envelope(ROBIN, { type: 'view_submission', view: submitted(meta, { next_step: 'work_trial' }) })));
  const body = await gaps.json();
  assert.equal(body.response_action, 'errors'); assert.deepEqual(Object.keys(body.errors).sort(), ['observations']);
  assert.equal(e.runs.length, 0);
  const good = await e.handle(signed(envelope(ROBIN, { type: 'view_submission', view: submitted(meta, { observations: 'Sharp', next_step: 'work_trial', trial_start: '2026-10-20', trial_end: '2026-10-24', focus: 'Pricing' }) })));
  const done = await good.json();
  assert.equal(done.response_action, 'update'); assert.match(JSON.stringify(done.view), /Report received: Advance · Work trial/);
  const stored = await e.store.getEvent('form-V0FORM1');
  assert.equal(stored.type, 'feedback_form'); assert.equal(stored.authorId, ROBIN); assert.equal(stored.requestKey, KEY);
  assert.equal(stored.form.trialStart, '2026-10-20'); assert.equal(e.runs.length, 1);
  // Someone who may not answer cannot submit either, even with a form in hand.
  const late = await e.handle(signed(envelope(JAMIE, { type: 'view_submission', view: submitted(meta, {}) })));
  assert.match(JSON.stringify(await late.json()), /belongs to the interviewer/);
});

test('only signed requests from this app and workspace are read', async () => {
  const e = await endpoint();
  assert.equal((await e.handle(signed(click(ROBIN, 'fb_advance'), { secret: 'wrong-secret-value' }))).status, 401);
  assert.equal((await e.handle(signed(click(ROBIN, 'fb_advance'), { at: NOW - 600_000 }))).status, 401, 'replayed late');
  assert.equal((await e.handle(signed({ ...click(ROBIN, 'fb_advance'), api_app_id: 'A0OTHER' }))).status, 403);
  assert.equal((await e.handle(signed({ ...click(ROBIN, 'fb_advance'), team: { id: 'T0OTHER' } }))).status, 403);
  assert.equal((await e.handle(new Request('https://x.example/', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }))).status, 415);
  assert.equal(e.ui.calls.length, 0);
});

// Take-home reviews: Interviewer's buttons open the take-home form, never the interview one, and the other way round.
import { takeHomeModal, TAKEHOME_CALLBACK } from '../service/lib/takehome-review.mjs';
const INTERVIEWER = 'U030A09DBFF';
function thSubmitted(meta, values) {
  const view = takeHomeModal({ meta, candidateName: 'Synthetic Candidate' });
  const state = {};
  for (const block of view.blocks.filter(b => b.type === 'input')) {
    const el = block.element, v = values[block.block_id];
    const entry = { type: el.type };
    if (el.type === 'plain_text_input' || el.type === 'number_input') entry.value = v ?? null;
    if (el.type === 'radio_buttons') entry.selected_option = v ? { value: v } : null;
    if (el.type === 'multi_static_select') entry.selected_options = (v ?? []).map(value => ({ value }));
    state[block.block_id] = { [block.block_id]: entry };
  }
  return { ...view, id: 'V0TH1', hash: 'h1', state: { values: state } };
}

test('take-home: Interviewer\'s buttons open the take-home form; interview buttons and the portal link do nothing there', async () => {
  const e = await endpoint({ action: 'takehome.grading_request', recipients: [INTERVIEWER] });
  await e.handle(signed(click(INTERVIEWER, 'th_advance')));
  const [kind, { view }] = e.ui.calls[0];
  assert.equal(kind, 'open'); assert.equal(view.callback_id, TAKEHOME_CALLBACK);
  assert.match(view.blocks[0].text.text, /Synthetic Candidate — take-home \(portal score 83\/100\)/);
  await e.handle(signed(click(INTERVIEWER, 'fb_advance')));
  await e.handle(signed(envelope(INTERVIEWER, { type: 'block_actions', trigger_id: 't', actions: [{ action_id: 'th_portal' }] })));
  assert.equal(e.ui.calls.length, 1);
  await e.handle(signed(click(JAMIE, 'th_do_not_advance')));
  assert.match(JSON.stringify(e.ui.calls[1][1].view), /belongs to the interviewer/);
  const interview = await endpoint();
  await interview.handle(signed(click(ROBIN, 'th_advance')));
  assert.match(JSON.stringify(interview.ui.calls[0][1].view), /no longer on the books/);
});

test('take-home: a review with gaps comes back with errors; a complete one is stored once as a takehome_form', async () => {
  const e = await endpoint({ action: 'takehome.grading_request', recipients: [INTERVIEWER] });
  const meta = { requestKey: KEY, decision: 'advance' };
  const gaps = await (await e.handle(signed(envelope(INTERVIEWER, { type: 'view_submission', view: thSubmitted(meta, { observations: ' ' }) })))).json();
  assert.equal(gaps.response_action, 'errors'); assert.deepEqual(Object.keys(gaps.errors).sort(), ['observations']);
  assert.equal(e.runs.length, 0);
  const done = await (await e.handle(signed(envelope(INTERVIEWER, { type: 'view_submission', view: thSubmitted(meta, { observations: 'Solid' }) })))).json();
  assert.match(JSON.stringify(done.view), /Roger that 🫡 I'll queue the deep-dive invite/);
  const stored = await e.store.getEvent('thform-V0TH1');
  assert.equal(stored.type, 'takehome_form'); assert.equal(stored.authorId, INTERVIEWER); assert.equal(stored.form.score, null); assert.equal(stored.form.nextStep, 'deep_dive'); assert.equal(stored.form.observations, 'Solid');
  assert.equal(e.runs.length, 1);
  // An interview form cannot be pointed at a take-home request.
  const wrong = await (await e.handle(signed(envelope(INTERVIEWER, { type: 'view_submission', view: submitted({ requestKey: KEY, decision: 'hold' }, { waiting_on: 'x' }) })))).json();
  assert.match(JSON.stringify(wrong), /no longer valid/);
});

test('take-home step 3: Confirm reject / Not yet only after a "do not advance", only by someone who may reject, first click counts', async () => {
  const reply = { kind: 'takehome_review', decision: 'do_not_advance', form: { decision: 'do_not_advance', observations: 'x' } };
  const press = (who, id, ts) => signed(envelope(who, { type: 'block_actions', trigger_id: `t-${ts}`, actions: [{ action_id: id, value: KEY, action_ts: ts }] }));
  const e = await endpoint({ action: 'takehome.grading_request', recipients: [INTERVIEWER], state: 'Complete', reply });
  await e.handle(press(JAMIE, 'th_rj_confirm', '1792090000.000100'));
  assert.match(JSON.stringify(e.ui.calls[0][1].view), /belongs to the person it was sent to/);
  await e.handle(press(INTERVIEWER, 'th_rj_confirm', '1792090001.000100'));
  assert.equal(e.runs.length, 1); assert.equal(e.ui.calls.length, 1, 'no modal for a good click');
  const stored = await e.store.getEvent(`threject-${KEY.slice(-40)}`);
  assert.equal(stored.type, 'takehome_reject'); assert.equal(stored.decision, 'confirm'); assert.equal(stored.authorId, INTERVIEWER);
  await e.handle(press(INTERVIEWER, 'th_rj_not_yet', '1792090002.000100'));
  assert.match(JSON.stringify(e.ui.calls[1][1].view), /already answered/); assert.equal(e.runs.length, 1);
  const advanced = await endpoint({ action: 'takehome.grading_request', recipients: [INTERVIEWER], state: 'Complete', reply: { ...reply, decision: 'advance' } });
  await advanced.handle(press(INTERVIEWER, 'th_rj_confirm', '1792090003.000100'));
  assert.match(JSON.stringify(advanced.ui.calls[0][1].view), /no longer on the books/); assert.equal(advanced.runs.length, 0);
});

test('the Cancel on a queued deep-dive email: only Project (or Robin or Alexis) can press it, and it is carried out in the background', async () => {
  const PROJECT = 'U0F9EF97D89';
  const e = await endpoint({ action: 'email.deep_dive_pending', recipients: [PROJECT] });
  await e.handle(signed(envelope(JAMIE, { type: 'block_actions', trigger_id: 't1', actions: [{ action_id: 'em_cancel', value: KEY, action_ts: '1792090000.000100' }] })));
  assert.match(JSON.stringify(e.ui.calls[0][1].view), /Only Project can cancel this email/);
  assert.equal(e.runs.length, 0);
  await e.handle(signed(envelope(PROJECT, { type: 'block_actions', trigger_id: 't2', actions: [{ action_id: 'em_cancel', value: KEY, action_ts: '1792090001.000200' }] })));
  assert.equal(e.ui.calls.length, 1, 'no modal for a good click');
  assert.equal(e.runs.length, 1);
  const stored = await e.store.getEvent(`emcancel-1792090001000200-${KEY.slice(-12)}`);
  assert.equal(stored.type, 'email_cancel'); assert.equal(stored.authorId, PROJECT); assert.equal(stored.requestKey, KEY);
  const other = await endpoint();
  await other.handle(signed(envelope(ROBIN, { type: 'block_actions', trigger_id: 't3', actions: [{ action_id: 'em_cancel', value: KEY }] })));
  assert.match(JSON.stringify(other.ui.calls[0][1].view), /no longer on the books/);
});

test('A click on a question marked Uncertain (its readback failed) confirms it was delivered and opens the form; others still get the notice (Oct 16)', async () => {
  const e = await endpoint({ state: 'Uncertain', recipients: [INTERVIEWER] });
  const healed = [];
  e.requests.get(KEY).requestKey = KEY;
  const fake = e.requests.get(KEY);
  const handle = createInteractionHandler({ ui: e.ui, clock: () => NOW, schedule: () => {}, run: async x => x, log: line => healed.push(line),
    store: { getRequest: async () => fake, listRequestsForCandidate: async () => [fake], recordEvent: async () => ({ created: true }),
      confirmDeliveredByClick: async ({ requestKey, channelId, messageTs, userId }) => { if (userId !== INTERVIEWER) return { updated: false }; fake.state = 'Sent'; fake.receipt = { channelId, messageTs }; return { updated: true }; } },
    verify: { signingSecret: SECRET, allowedAppIds: [APP_ID], allowedTeamIds: [TEAM_ID], now: () => NOW } });
  const fromMessage = user => envelope(user, { type: 'block_actions', trigger_id: 'trig-1', container: { type: 'message', channel_id: 'D0C8LHFDQNB', message_ts: '1792178753.416649' }, actions: [{ action_id: 'fb_advance', value: KEY }] });
  await handle(signed(fromMessage(JAMIE)));
  assert.match(JSON.stringify(e.ui.calls[0][1].view), /This call belongs to the interviewer|That request is closed/);
  await handle(signed(fromMessage(INTERVIEWER)));
  assert.equal(e.ui.calls[1][1].view.callback_id, FEEDBACK_CALLBACK);
  assert.equal(fake.state, 'Sent');
  assert.ok(healed.some(l => /^uncle_sam_click healed=true/.test(l)));
  assert.ok(healed.some(l => /^uncle_sam_click user=U030A09DBFF action=fb_advance .* form_opened$/.test(l)));
});

test('Store: confirmDeliveredByClick turns only an Uncertain request of that recipient into Sent, with the thread', async () => {
  const fixture = persistedFixture(NOW);
  const store = createStore(fixture.db, { authorized: true, clock: () => NOW });
  assert.deepEqual(await store.confirmDeliveredByClick({ requestKey: KEY, channelId: 'D1', messageTs: '1.1', userId: 'U1' }), { updated: false });
});

test('the work-trial packet offer: Send and the rate form are Project\'s only; the rate is checked; each tap is one event for the runner', async () => {
  const PROJECT = 'U0F9EF97D89';
  const press = (who, id, ts) => signed(envelope(who, { type: 'block_actions', trigger_id: `t-${ts}`, actions: [{ action_id: id, value: KEY, action_ts: ts }] }));
  const e = await endpoint({ action: 'work_trial.packet_offer', recipients: [PROJECT] });
  e.requests.get(KEY).payload.rate = 250;
  await e.handle(press(ROBIN, 'wt_send', '1792090000.000100'));
  assert.match(JSON.stringify(e.ui.calls[0][1].view), /This one is Project's call/);
  assert.equal(e.runs.length, 0);
  await e.handle(press(PROJECT, 'wt_send', '1792090001.000200'));
  assert.equal(e.ui.calls.length, 1, 'no modal for Send');
  assert.equal(e.runs.length, 1);
  const sent = await e.store.getEvent(`wtsend-1792090001000200-${KEY.slice(-12)}`);
  assert.equal(sent.type, 'packet_send'); assert.equal(sent.authorId, PROJECT); assert.equal(sent.requestKey, KEY); assert.equal(sent.rate, undefined);
  // "Send at a different rate" opens the one-field form with the current rate.
  await e.handle(press(PROJECT, 'wt_rate', '1792090002.000300'));
  const form = e.ui.calls[1][1].view;
  assert.equal(form.callback_id, 'uncle_sam_wt_rate');
  assert.equal(form.blocks[1].element.initial_value, '250');
  const submit = value => signed(envelope(PROJECT, { type: 'view_submission', view: { id: 'VRATE1', callback_id: 'uncle_sam_wt_rate', private_metadata: form.private_metadata,
    state: { values: { rate: { value: { type: 'number_input', value } } } } } }));
  const bad = await (await e.handle(submit('5'))).json();
  assert.equal(bad.response_action, 'errors'); assert.match(bad.errors.rate, /between 10 and 5000/);
  assert.equal(e.runs.length, 1);
  const good = await (await e.handle(submit('300'))).json();
  assert.equal(good.response_action, 'update'); assert.match(JSON.stringify(good.view), /at US\$300 per day/);
  assert.equal(e.runs.length, 2);
  assert.equal((await e.store.getEvent('wtrate-VRATE1')).rate, 300);
  // Settled: no more taps.
  const settled = await endpoint({ action: 'work_trial.packet_offer', recipients: [PROJECT], reply: { kind: 'packet_send' } });
  await settled.handle(press(PROJECT, 'wt_send', '1792090003.000100'));
  assert.match(JSON.stringify(settled.ui.calls[0][1].view), /already settled/);
  assert.equal(settled.runs.length, 0);
});

test('fast open: a form button opens a "one moment" modal from the click alone, then the form (or notice) replaces it; a dead end closes into a notice', async () => {
  const fast = async () => {
    const e = await endpoint();
    e.ui.viewsOpen = async input => { e.ui.calls.push(['open', input]); return { ok: true, body: { view: { id: 'V-LOADING' } } }; };
    const handle = createInteractionHandler({ store: { getRequest: async k => e.requests.get(k) ?? null, listRequestsForCandidate: async () => [...e.requests.values()], recordEvent: x => e.store.recordEvent(x), getEvent: id => e.store.getEvent(id) },
      ui: e.ui, clock: () => NOW, schedule: () => {}, run: async x => x, fastOpen: true,
      verify: { signingSecret: SECRET, allowedAppIds: [APP_ID], allowedTeamIds: [TEAM_ID], now: () => NOW } });
    return { ...e, handle };
  };
  const e = await fast();
  await e.handle(signed(click(ROBIN, 'fb_advance')));
  assert.deepEqual(e.ui.calls.map(c => c[0]), ['open', 'update']);
  assert.match(JSON.stringify(e.ui.calls[0][1].view), /One moment/);
  assert.equal(e.ui.calls[1][1].viewId, 'V-LOADING');
  assert.equal(e.ui.calls[1][1].view.callback_id, FEEDBACK_CALLBACK);
  // Someone else's click: the notice replaces the loading modal.
  const other = await fast();
  await other.handle(signed(click(JAMIE, 'fb_advance')));
  assert.deepEqual(other.ui.calls.map(c => c[0]), ['open', 'update']);
  assert.match(JSON.stringify(other.ui.calls[1][1].view), /belongs to the interviewer/);
  // A take-home request clicked with an interview button: nothing to show, so it closes into a notice rather than spinning.
  const dead = await fast();
  dead.requests.get(KEY).action = 'takehome.grading_request';
  await dead.handle(signed(click(ROBIN, 'fb_advance')));
  assert.deepEqual(dead.ui.calls.map(c => c[0]), ['open', 'update']);
  assert.match(JSON.stringify(dead.ui.calls[1][1].view), /no longer on the books/);
});

test('no-show buttons: the interviewer asked, Robin, Alexis or Project; the first tap counts; anyone else gets a notice', async () => {
  const PROJECT = 'U0F9EF97D89';
  const press = (who, id, ts) => signed(envelope(who, { type: 'block_actions', trigger_id: `t-${ts}`, actions: [{ action_id: id, value: KEY, action_ts: ts }] }));
  const e = await endpoint({ action: 'noshow.choice', recipients: [INTERVIEWER] });
  await e.handle(press(JAMIE, 'nsh_close', '1792090000.000100'));
  assert.match(JSON.stringify(e.ui.calls[0][1].view), /belongs to the interviewer/);
  await e.handle(press(INTERVIEWER, 'nsh_reschedule', '1792090001.000100'));
  assert.equal(e.runs.length, 1);
  const stored = await e.store.getEvent(`noshow-${KEY.slice(-40)}`);
  assert.equal(stored.type, 'noshow_choice'); assert.equal(stored.choice, 'reschedule'); assert.equal(stored.authorId, INTERVIEWER);
  await e.handle(press(PROJECT, 'nsh_close', '1792090002.000100'));
  assert.match(JSON.stringify(e.ui.calls.at(-1)[1].view), /already answered/);
  assert.equal(e.runs.length, 1);
});
