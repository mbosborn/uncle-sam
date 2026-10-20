import test from 'node:test';
import assert from 'node:assert/strict';
import { takeHomeButtons, takeHomeModal, takeHomeMetaOf, readTakeHomeSubmission, takeHomeBooking, takeHomeNextAction,
  takeHomeReportText, takeHomeBriefBullets, TAKEHOME_CALLBACK, PORTAL_ADMIN_URL, parseTemplate, fillDeepDiveEmail, nextClerkRun, clerkRunText,
  cancelButtons, takeHomeRejectButtons, takeHomeStepLines, takeHomeStepBlocks, takeHomeDoneModal, TH_REJECT_BUTTONS } from '../service/lib/takehome-review.mjs';

const KEY = `usam:v1:${'b'.repeat(64)}`;
const state = values => ({ values: Object.fromEntries(Object.entries(values).map(([id, a]) => [id, { [id]: a }])) });
const textIn = value => ({ type: 'plain_text_input', value });
const num = value => ({ type: 'number_input', value });
const ids = view => view.blocks.filter(b => b.type === 'input').map(b => b.block_id);

test('step 1: look it over first, then the call; buttons carry the request key; the portal button is a plain link', () => {
  const b = takeHomeButtons(KEY);
  assert.deepEqual(b.elements.map(e => e.action_id), ['th_portal', 'th_advance', 'th_do_not_advance']);
  assert.deepEqual(b.elements.map(e => e.text.text), ['Open the portal', 'Advance to deep dive', 'Do not advance']);
  assert.equal(b.elements[1].value, KEY); assert.equal(b.elements[2].value, KEY);
  assert.equal(b.elements[0].url, PORTAL_ADMIN_URL); assert.equal(b.elements[0].value, undefined);
});

test('step 2 is one sentence of notes and nothing else; the portal score is never asked for', () => {
  const advance = takeHomeModal({ meta: { requestKey: KEY, decision: 'advance' }, candidateName: 'A', scoreLine: 'portal score 83/100' });
  assert.equal(advance.callback_id, TAKEHOME_CALLBACK);
  assert.equal(advance.title.text, 'Step 2 of 3 · Note'); assert.equal(advance.submit.text, 'Send');
  assert.deepEqual(ids(advance), ['observations']);
  assert.match(JSON.stringify(advance), /Step 3: I'll email them your deep-dive link from Project's Gmail/);
  assert.match(advance.blocks[0].text.text, /portal score 83\/100/);
  assert.equal(advance.blocks.some(b => b.dispatch_action), false, 'nothing to redraw');
  const reject = takeHomeModal({ meta: { requestKey: KEY, decision: 'do_not_advance' }, candidateName: 'A' });
  assert.deepEqual(ids(reject), ['observations']); assert.equal(reject.submit.text, 'Next');
  assert.match(JSON.stringify(reject), /you confirm the reject on my message/);
  const kept = takeHomeModal({ meta: { requestKey: KEY, decision: 'advance' }, candidateName: 'A', values: { observations: 'clean code' } });
  const note = kept.blocks.find(b => b.block_id === 'observations');
  assert.equal(note.element.initial_value, 'clean code');
  assert.equal(note.label.text, 'Notes (one sentence)'); assert.equal(note.element.multiline, false); assert.equal(note.element.max_length, 300);
  assert.match(takeHomeDoneModal({ decision: 'do_not_advance' }).blocks[0].text.text, /Last step: confirm the reject on my message/);
});

test('step 3 after "do not advance": Confirm reject asks once more; the steps so far show on the message', () => {
  const b = takeHomeRejectButtons(KEY, 'Synthetic Candidate');
  assert.deepEqual(b.elements.map(e => e.action_id), Object.keys(TH_REJECT_BUTTONS));
  assert.equal(b.elements[0].style, 'danger'); assert.match(b.elements[0].confirm.text.text, /^Synthetic Candidate is marked Not Selected/);
  assert.ok(b.elements.every(e => e.value === KEY));
  assert.deepEqual(takeHomeStepLines({ decision: 'do_not_advance', observations: 'Thin on evals.' }),
    ['🎖️ Step 1 · Your call: Do not advance', '🎖️ Step 2 · Note: Thin on evals.']);
  const blocks = takeHomeStepBlocks({ body: 'hello', steps: ['one', 'two'], actions: b, link: '<https://x|record>' });
  assert.deepEqual(blocks.map(x => x.type), ['section', 'context', 'context', 'actions', 'context']);
});

test('metadata is checked, never trusted', () => {
  assert.equal(takeHomeMetaOf({ private_metadata: '{"requestKey":"x","decision":"advance"}' }), null);
  assert.equal(takeHomeMetaOf({ private_metadata: `{"requestKey":"${KEY}","decision":"hold"}` }), null);
  assert.deepEqual(takeHomeMetaOf({ private_metadata: `{"requestKey":"${KEY}","decision":"advance","nextStep":"x","extra":1}` }), { requestKey: KEY, decision: 'advance' });
});

test('submission: one sentence required, at most 300 characters; Advance becomes the deep dive', () => {
  const meta = { requestKey: KEY, decision: 'advance' };
  let r = readTakeHomeSubmission({ state: state({ observations: textIn(' ') }) }, meta);
  assert.equal(r.ok, false); assert.ok(r.errors.observations);
  r = readTakeHomeSubmission({ state: state({ observations: textIn('solid <b>') }) }, meta);
  assert.equal(r.ok, true);
  assert.deepEqual(r.form, { decision: 'advance', observations: 'solid b', score: null, nextStep: 'deep_dive' });
  r = readTakeHomeSubmission({ state: state({ observations: textIn('x'.repeat(400)) }) }, meta);
  assert.equal(r.form.observations.length, 300);
  r = readTakeHomeSubmission({ state: state({ observations: textIn('weak tests') }) }, { requestKey: KEY, decision: 'do_not_advance' });
  assert.deepEqual(r.form, { decision: 'do_not_advance', observations: 'weak tests', score: null });
});

test('follow-ups: an Advance is the emailed invite; a rejection is never final', () => {
  const advance = { decision: 'advance', observations: 'good', score: 70, nextStep: 'deep_dive', focus: 'evals' };
  assert.match(takeHomeBooking({ decision: 'do_not_advance' }, 'Interviewer'), /Robin, Alexis or Interviewer decide/);
  assert.match(takeHomeNextAction(advance), /^Candidate: book the technical deep dive with Interviewer from the invite emailed from Project's Gmail/);
  assert.match(takeHomeNextAction({ decision: 'do_not_advance' }), /confirm the rejection/);
  const report = takeHomeReportText(advance, 'Interviewer', 'portal score 83/100');
  assert.match(report, /Advance on the take-home \(portal score 83\/100\)/); assert.doesNotMatch(report, /own score|probe/);
  assert.match(report, /Next step: technical deep dive with Interviewer, invite emailed from Project's Gmail\./);
  const bullets = takeHomeBriefBullets(advance, 'Interviewer', 'Thu, Oct 15, 2026', 'portal score 83/100');
  assert.ok(bullets.length >= 3 && bullets.length <= 6);
  assert.ok(bullets.every(b => /^[A-Z][a-z ]+: /.test(b)));
  const cancel = cancelButtons(`usam:v1:${'c'.repeat(64)}`).elements[0];
  assert.equal(cancel.action_id, 'em_cancel'); assert.equal(cancel.style, 'danger');
});

const TEMPLATE = 'Subject: Company — Technical Deep Dive\n\nHi {{candidate_first_name}},\n\nThank you for completing the take-home assessment.\n\nPlease select the times that work for you using Interviewer’s scheduling link: {{santosh_deep_dive_link}}';
const LINK = 'https://calendly.com/quinn-company-ai/technical-deep-dive';

test('the deep-dive template fills in only its two placeholders, and anything off means nothing is queued', () => {
  const template = parseTemplate(TEMPLATE);
  assert.equal(template.subject, 'Company — Technical Deep Dive');
  const filled = fillDeepDiveEmail(template, { firstName: 'Hayden', link: LINK });
  assert.equal(filled.subject, 'Company — Technical Deep Dive');
  assert.equal(filled.body, `Hi Hayden,\n\nThank you for completing the take-home assessment.\n\nPlease select the times that work for you using Interviewer’s scheduling link: ${LINK}`);
  assert.equal(parseTemplate('Hi there, no subject line'), null);
  assert.equal(fillDeepDiveEmail(parseTemplate(`${TEMPLATE}\n\n[Role]`), { firstName: 'Hayden', link: LINK }), null, 'an unknown placeholder');
  assert.equal(fillDeepDiveEmail(parseTemplate(TEMPLATE.replace('{{santosh_deep_dive_link}}', 'the link')), { firstName: 'Hayden', link: LINK }), null, 'no link in the body');
  assert.equal(fillDeepDiveEmail(template, { firstName: ' ', link: LINK }), null);
  assert.equal(fillDeepDiveEmail(template, { firstName: 'Hayden', link: 'http://insecure.example' }), null);
  assert.equal(fillDeepDiveEmail(template, { firstName: 'Hayden', link: 'https://calendly.com/d/example-single-use/technical-deep-dive' }), null, 'a single-use link');
});

test('the send time is the clerk\'s first run at least 30 minutes on: weekdays at :31, 9:31am to 11:31pm Pacific', () => {
  const at = iso => Date.parse(iso);
  assert.equal(new Date(nextClerkRun(at('2026-10-15T18:40:00Z'))).toISOString(), '2026-10-15T19:31:00.000Z');   // Thu 11:40am PT -> 12:31pm
  assert.equal(new Date(nextClerkRun(at('2026-10-15T16:31:00Z'))).toISOString(), '2026-10-15T16:31:00.000Z');   // exactly 9:31am PT
  assert.equal(new Date(nextClerkRun(at('2026-10-17T06:45:00Z'))).toISOString(), '2026-10-19T16:31:00.000Z');   // Fri 11:45pm PT -> Mon 9:31am
  assert.equal(new Date(nextClerkRun(at('2026-10-15T13:00:00Z'))).toISOString(), '2026-10-15T16:31:00.000Z');   // 6am PT -> 9:31am
  assert.equal(clerkRunText(at('2026-10-15T19:31:00Z'), at('2026-10-15T18:40:00Z')), 'at 12:31pm PT');
  assert.equal(clerkRunText(at('2026-10-19T16:31:00Z'), at('2026-10-17T06:45:00Z')), 'Mon at 9:31am PT');
});
