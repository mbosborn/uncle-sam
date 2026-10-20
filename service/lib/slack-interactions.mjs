/**
 * POST /api/slack/interactions: button clicks and form submissions from Uncle Sam's feedback prompts.
 *
 *   click on a decision or next-step button -> check the request and who clicked, then open the form (views.open has to
 *     happen inside Slack's 3-second window, so it is done before answering)
 *   change of "Next step" inside the form    -> redraw the form with that step's fields (views.update), keeping what was typed
 *   submit                                   -> check every field; on errors Slack shows them under the fields; otherwise the
 *     report is stored as one event (`feedback_form`, keyed by the form's view id) and the runner records it in the background
 *
 * Nothing here writes to Notion or posts a message. Who may answer: the interviewer the prompt was sent to, or Robin or
 * Alexis. A prompt that already has an answer cannot be answered twice.
 *
 * Take-home reviews (takehome-review.mjs) work the same way: Interviewer's Advance to deep dive / Do not advance buttons open
 * the one-sentence note form and a submit is stored as one `takehome_form` event; after a "do not advance", Confirm reject /
 * Not yet on the same message is stored as one `takehome_reject` event per request (the first click counts). The "Open
 * the portal" button is a plain link; its click needs no answer.
 */
import { verifySlackInteraction, ProtocolError } from './protocol.mjs';
import { DECISION_BUTTONS, SHORTCUT_BUTTONS, NEXT_STEP_BUTTONS, NEXT_STEPS, SUGGESTED_STEP, DEEP_DIVE_BUTTONS, REJECTION_BUTTONS, FEEDBACK_CALLBACK, feedbackModal, noticeModal, doneModal, metaOf, valuesOf, readSubmission, todayLA } from './feedback-form.mjs';
import { NOSHOW_CHOICE, NOSHOW_BUTTONS } from './no-show.mjs';
import { PACKET_OFFER, WT_SEND, WT_RATE, WT_RATE_CALLBACK, rateModal, rateDoneModal, rateMetaOf, readRate, validRate } from './work-trial-offer.mjs';
import { TAKEHOME_ACTIONS, TAKEHOME_CALLBACK, TH_BUTTONS, TH_REJECT_BUTTONS, takeHomeModal, takeHomeDoneModal, takeHomeMetaOf, readTakeHomeSubmission } from './takehome-review.mjs';

export const FORM_ACTIONS = Object.freeze(['interview.feedback_request', 'interview.feedback_reminder', 'interview.next_step_request', ...TAKEHOME_ACTIONS]);
const FINAL_AUTHORITY = Object.freeze(['U0A4F08721B', 'U0476A5BC82']);
const REJECT_AUTHORITY = Object.freeze([...FINAL_AUTHORITY, 'U030A09DBFF']);
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const empty = () => new Response(null, { status: 200 });

/** Whether this user may answer this stored request now. Returns null when they may, otherwise the line to show them. */
export async function answerBlock(store, request, userId) {
  if (!request || !FORM_ACTIONS.includes(request.action)) return '📁 That request is no longer on the books.';
  if (!(request.recipientIds ?? []).includes(userId) && !FINAL_AUTHORITY.includes(userId)) return '🔒 This call belongs to the interviewer it was sent to.';
  if (!['Sent', 'Complete'].includes(request.state)) return '📁 That request is closed.';
  if (request.receipt?.reply) return '📋 This one is already reported. Reply in the thread if something changed.';
  if (request.action !== 'interview.next_step_request') {
    // A reply on the prompt or its reminder answers both.
    const family = TAKEHOME_ACTIONS.includes(request.action) ? 'takehome.grading_' : 'interview.feedback_';
    for (const sibling of (await store.listRequestsForCandidate({ candidateId: request.candidateId, limit: 20 }))) {
      if (sibling.occurrenceId === request.occurrenceId && sibling.action.startsWith(family) && sibling.receipt?.reply) return '📋 This one is already reported. Reply in the thread if something changed.';
    }
  }
  return null;
}

/** Whether this user may tap Send on this work-trial offer now: Project only, once. */
export function packetBlock(stored, userId) {
  if (!stored || stored.action !== PACKET_OFFER) return '📁 That offer is no longer on the books.';
  if (!(stored.recipientIds ?? []).includes(userId)) return "🔒 This one is Project's call.";
  if (!['Sent', 'Complete'].includes(stored.state) || stored.receipt?.reply) return '📋 This one is already settled.';
  return null;
}

const takeHomeHeader = stored => ({ candidateName: stored?.payload?.candidate?.fullName ?? 'This candidate', scoreLine: stored?.payload?.scoreLine ?? null });

/** Buttons that open a form: with fastOpen, a modal opens from the click itself before anything is read. */
const FORM_OPENERS = new Set([...Object.keys(DECISION_BUTTONS), ...Object.keys(SHORTCUT_BUTTONS), ...Object.keys(NEXT_STEP_BUTTONS), ...Object.keys(DEEP_DIVE_BUTTONS), ...Object.keys(TH_BUTTONS), WT_RATE]);

export function createInteractionHandler({ verify, store, ui, schedule, run, clock = Date.now, log = () => {}, fastOpen = false } = {}) {
  return async function handle(request) {
    let payload;
    try { payload = await verifySlackInteraction(request, verify); }
    catch (error) { return error instanceof ProtocolError ? json({ error: error.code }, error.status) : json({ error: 'request_failed' }, 503); }
    const userId = payload.user.id;
    // A click comes from the message itself: a question marked Uncertain (its readback failed) is in their DM after all.
    const heal = async stored => {
      if (stored?.state !== 'Uncertain' || payload.container?.type !== 'message' || typeof store.confirmDeliveredByClick !== 'function') return stored;
      const fixed = await store.confirmDeliveredByClick({ requestKey: stored.requestKey, channelId: payload.container.channel_id, messageTs: payload.container.message_ts,
        threadTs: payload.container.thread_ts ?? payload.message?.thread_ts ?? null, text: payload.message?.text ?? null, userId }).catch(() => ({ updated: false }));
      log(`uncle_sam_click healed=${fixed.updated} request=${String(stored.requestKey).slice(-8)}`);
      return fixed.updated ? await store.getRequest(stored.requestKey) : stored;
    };
    const told = (kind, action, request, outcome) => log(`uncle_sam_${kind} user=${userId} action=${String(action).slice(0, 40)} request=${String(request ?? '').slice(-8)} ${outcome}`);
    try {
      if (payload.type === 'block_actions') {
        const action = payload.actions?.[0] ?? {};
        // A cold start can eat Slack's 3-second window before the database answers, and then the form never opens (audit,
        // 2026-10-16). With fastOpen, a button that opens a form opens a "one moment" modal first, from the click alone, and
        // the real form (or the notice) replaces it. A click that ends without one closes into a short notice.
        let viewId = null, replaced = false, uiNow = ui;
        if (fastOpen && FORM_OPENERS.has(action.action_id) && payload.trigger_id) {
          const first = await ui.viewsOpen({ triggerId: payload.trigger_id, view: noticeModal('⏳ One moment.') });
          viewId = first.ok ? first.body?.view?.id ?? null : null;
          if (!first.ok) log(`uncle_sam_interaction views.open failed ${first.code} (fast)`);
          if (viewId) uiNow = { ...ui, viewsOpen: ({ view }) => { replaced = true; return ui.viewsUpdate({ viewId, view }); } };
        }
        const done = async () => {
          if (viewId && !replaced) await ui.viewsUpdate({ viewId, view: noticeModal('📁 That button is no longer on the books.') }).catch(() => {});
          return empty();
        };
        if (action.action_id === 'th_portal') return done();
        // Project's Cancel on a queued deep-dive invite email: checked here, carried out by the runner in the background.
        if (action.action_id === 'em_cancel') {
          const stored = await heal(typeof action.value === 'string' && /^usam:v1:[0-9a-f]{64}$/.test(action.value) ? await store.getRequest(action.value) : null);
          const blocked = !stored || !['email.deep_dive_pending', 'email.takehome_pending', 'email.takehome_nudge_pending', 'email.deep_dive_nudge_pending', 'email.reschedule_pending'].includes(stored.action) ? '📁 That email is no longer on the books.'
            : !((stored.recipientIds ?? []).includes(userId) || FINAL_AUTHORITY.includes(userId)) ? '🔒 Only Project can cancel this email.'
              : !['Sent', 'Complete'].includes(stored.state) || stored.receipt?.reply ? '📋 This one is already settled.' : null;
          if (blocked) {
            const opened = await uiNow.viewsOpen({ triggerId: payload.trigger_id, view: noticeModal(blocked) });
            if (!opened.ok) log(`uncle_sam_interaction views.open failed ${opened.code}`);
            return done();
          }
          const eventId = `emcancel-${String(action.action_ts ?? clock()).replace(/[^0-9]/g, '').slice(0, 40)}-${action.value.slice(-12)}`;
          await store.recordEvent({ eventId, source: 'slack', type: 'email_cancel', occurredAt: clock(), isFixture: false, authorId: userId, requestKey: action.value });
          if (typeof schedule === 'function' && typeof run === 'function') schedule(run({ eventId, attemptId: crypto.randomUUID() }).catch(() => undefined));
          return done();
        }
        // Send / Send at a different rate on a work-trial packet offer (work-trial-offer.mjs): Project only; carried out by the runner.
        if (action.action_id === WT_SEND || action.action_id === WT_RATE) {
          const stored = await heal(typeof action.value === 'string' && /^usam:v1:[0-9a-f]{64}$/.test(action.value) ? await store.getRequest(action.value) : null);
          const blocked = packetBlock(stored, userId);
          told('click', action.action_id, action.value, blocked ? `blocked="${blocked.slice(2, 40)}"` : 'ok');
          if (blocked || action.action_id === WT_RATE) {
            const view = blocked ? noticeModal(blocked) : rateModal({ requestKey: action.value, name: stored.payload?.candidate?.fullName ?? 'this candidate', current: stored.payload?.rate ?? null,
              invite: !(stored.payload?.trialStart && stored.payload?.trialEnd) });
            const opened = await uiNow.viewsOpen({ triggerId: payload.trigger_id, view });
            if (!opened.ok) log(`uncle_sam_interaction views.open failed ${opened.code}`);
            return done();
          }
          if (!validRate(stored.payload?.rate)) return done();
          const eventId = `wtsend-${String(action.action_ts ?? clock()).replace(/[^0-9]/g, '').slice(0, 40)}-${action.value.slice(-12)}`;
          await store.recordEvent({ eventId, source: 'slack', type: 'packet_send', occurredAt: clock(), isFixture: false, authorId: userId, requestKey: action.value });
          if (typeof schedule === 'function' && typeof run === 'function') schedule(run({ eventId, attemptId: crypto.randomUUID() }).catch(() => undefined));
          return done();
        }
        // Send a new link / Close them out on a no-show question (no-show.mjs): whoever it was asked of, Robin, Alexis or Project;
        // the first tap counts; carried out by the runner.
        const noShow = NOSHOW_BUTTONS[action.action_id];
        if (noShow) {
          const stored = await heal(typeof action.value === 'string' && /^usam:v1:[0-9a-f]{64}$/.test(action.value) ? await store.getRequest(action.value) : null);
          let blocked = !stored || stored.action !== NOSHOW_CHOICE ? '📁 That question is no longer on the books.'
            : !((stored.recipientIds ?? []).includes(userId) || FINAL_AUTHORITY.includes(userId) || userId === 'U0F9EF97D89') ? '🔒 This call belongs to the interviewer it was sent to.'
              : !['Sent', 'Complete'].includes(stored.state) || stored.receipt?.reply ? '📋 This one is already answered.' : null;
          const eventId = `noshow-${action.value.slice(-40)}`;
          if (!blocked) {
            const saved = await store.recordEvent({ eventId, source: 'slack', type: 'noshow_choice', occurredAt: clock(), isFixture: false, authorId: userId, requestKey: action.value, choice: noShow });
            if (!saved.created) blocked = '📋 This one is already answered.';
          }
          told('click', action.action_id, action.value, blocked ? `blocked="${blocked.slice(2, 40)}"` : 'ok');
          if (blocked) {
            const opened = await uiNow.viewsOpen({ triggerId: payload.trigger_id, view: noticeModal(blocked) });
            if (!opened.ok) log(`uncle_sam_interaction views.open failed ${opened.code}`);
            return done();
          }
          if (typeof schedule === 'function' && typeof run === 'function') schedule(run({ eventId, attemptId: crypto.randomUUID() }).catch(() => undefined));
          return done();
        }
        // Confirm reject / Not yet under a rejection confirmation question: only the person it was sent to; carried out by the runner.
        const rejection = REJECTION_BUTTONS[action.action_id];
        if (rejection) {
          const stored = await heal(typeof action.value === 'string' && /^usam:v1:[0-9a-f]{64}$/.test(action.value) ? await store.getRequest(action.value) : null);
          const blocked = !stored || stored.action !== 'rejection.confirmation_request' ? '📁 That question is no longer on the books.'
            : !(stored.recipientIds ?? []).includes(userId) ? '🔒 This call belongs to the person it was sent to.'
              : !['Sent', 'Complete'].includes(stored.state) || stored.receipt?.reply ? '📋 This one is already answered.' : null;
          if (blocked) {
            const opened = await uiNow.viewsOpen({ triggerId: payload.trigger_id, view: noticeModal(blocked) });
            if (!opened.ok) log(`uncle_sam_interaction views.open failed ${opened.code}`);
            return done();
          }
          const eventId = `rjbutton-${String(action.action_ts ?? clock()).replace(/[^0-9]/g, '').slice(0, 40)}-${action.value.slice(-12)}`;
          await store.recordEvent({ eventId, source: 'slack', type: 'rejection_button', occurredAt: clock(), isFixture: false, authorId: userId,
            requestKey: action.value, decision: rejection });
          if (typeof schedule === 'function' && typeof run === 'function') schedule(run({ eventId, attemptId: crypto.randomUUID() }).catch(() => undefined));
          return done();
        }
        // Step 3 of a take-home review after "do not advance": Confirm reject / Not yet on the same message. Only someone who may
        // reject (Robin, Alexis or Interviewer) and who could answer the take-home; the first click is the answer.
        const thReject = TH_REJECT_BUTTONS[action.action_id];
        if (thReject) {
          const stored = await heal(typeof action.value === 'string' && /^usam:v1:[0-9a-f]{64}$/.test(action.value) ? await store.getRequest(action.value) : null);
          const reply = stored?.receipt?.reply;
          let blocked = !stored || !TAKEHOME_ACTIONS.includes(stored.action) || reply?.kind !== 'takehome_review' || reply.decision !== 'do_not_advance'
            ? '📁 That question is no longer on the books.'
            : !REJECT_AUTHORITY.includes(userId) || !((stored.recipientIds ?? []).includes(userId) || FINAL_AUTHORITY.includes(userId))
              ? '🔒 This call belongs to the person it was sent to.' : null;
          const eventId = `threject-${action.value.slice(-40)}`;
          if (!blocked) {
            const saved = await store.recordEvent({ eventId, source: 'slack', type: 'takehome_reject', occurredAt: clock(), isFixture: false, authorId: userId,
              requestKey: action.value, decision: thReject });
            if (!saved.created) blocked = '📋 This one is already answered.';
          }
          if (blocked) {
            const opened = await uiNow.viewsOpen({ triggerId: payload.trigger_id, view: noticeModal(blocked) });
            if (!opened.ok) log(`uncle_sam_interaction views.open failed ${opened.code}`);
            return done();
          }
          if (typeof schedule === 'function' && typeof run === 'function') schedule(run({ eventId, attemptId: crypto.randomUUID() }).catch(() => undefined));
          return done();
        }
        const takeHomeDecision = TH_BUTTONS[action.action_id];
        if (takeHomeDecision) {
          const stored = await heal(typeof action.value === 'string' && /^usam:v1:[0-9a-f]{64}$/.test(action.value) ? await store.getRequest(action.value) : null);
          const blocked = await answerBlock(store, stored, userId) ?? (TAKEHOME_ACTIONS.includes(stored.action) ? null : '📁 That request is no longer on the books.');
          told('click', action.action_id, action.value, blocked ? `blocked="${blocked.slice(2, 40)}"` : 'form_opened');
          const view = blocked ? noticeModal(blocked) : takeHomeModal({ meta: { requestKey: action.value, decision: takeHomeDecision }, ...takeHomeHeader(stored) });
          const opened = await uiNow.viewsOpen({ triggerId: payload.trigger_id, view });
          if (!opened.ok) log(`uncle_sam_interaction views.open failed ${opened.code}`);
          return done();
        }
        // Inside the form: the next step changed, so redraw it with that step's fields.
        if (payload.view?.callback_id === FEEDBACK_CALLBACK && action.action_id === 'next_step') {
          const meta = metaOf(payload.view);
          const stored = meta ? await store.getRequest(meta.requestKey) : null;
          if (!meta || !stored) return done();
          const next = { ...meta, nextStep: action.selected_option?.value ?? null };
          const view = feedbackModal({ meta: next, candidateName: stored.payload?.candidate?.fullName ?? 'This candidate', roleRound: stored.payload?.roleRound, who: userId, values: valuesOf(payload.view) });
          const updated = await ui.viewsUpdate({ viewId: payload.view.id, hash: payload.view.hash, view });
          if (!updated.ok) log(`uncle_sam_interaction views.update failed ${updated.code}`);
          return done();
        }
        const deepDiveButton = DEEP_DIVE_BUTTONS[action.action_id];
        const shortcutButton = SHORTCUT_BUTTONS[action.action_id];
        const decision = DECISION_BUTTONS[action.action_id] ?? deepDiveButton?.decision ?? shortcutButton?.decision;
        const nextStep = NEXT_STEP_BUTTONS[action.action_id];
        if (!decision && !nextStep) return done();
        const stored = await heal(typeof action.value === 'string' && /^usam:v1:[0-9a-f]{64}$/.test(action.value) ? await store.getRequest(action.value) : null);
        const blocked = await answerBlock(store, stored, userId);
        told('click', action.action_id, action.value, blocked ? `blocked="${blocked.slice(2, 40)}"` : 'form_opened');
        if (TAKEHOME_ACTIONS.includes(stored?.action)) return done(); // interview buttons never answer a take-home request
        const nextStepOnly = stored?.action === 'interview.next_step_request';
        const deepDive = stored?.payload?.deepDive === true;
        if (!blocked && deepDiveButton && !deepDive) return done(); // deep-dive buttons only belong on a deep-dive prompt
        // Advance on a question that named the expected next step (the invite and the record, prompt-review.mjs) starts the form
        // with that step picked; the interviewer can change it.
        const suggested = decision === 'advance' && !deepDive && NEXT_STEPS.includes(SUGGESTED_STEP[stored?.payload?.likelyNext]) ? SUGGESTED_STEP[stored.payload.likelyNext] : undefined;
        const pickedStep = nextStep ?? deepDiveButton?.nextStep ?? shortcutButton?.nextStep ?? suggested;
        const meta = { requestKey: action.value, decision: nextStep || nextStepOnly ? 'advance' : decision, ...(pickedStep ? { nextStep: pickedStep } : {}),
          ...(nextStepOnly ? { nextStepOnly: true } : {}), ...(deepDive ? { deepDive: true } : {}), ...(shortcutButton ? { shortcut: true } : {}) };
        if (!blocked && nextStep && !nextStepOnly) return done(); // next-step buttons only belong on a next-step question
        const view = blocked ? noticeModal(blocked)
          : feedbackModal({ meta, candidateName: stored.payload?.candidate?.fullName ?? 'This candidate', roleRound: stored.payload?.roleRound, who: userId });
        const opened = await uiNow.viewsOpen({ triggerId: payload.trigger_id, view });
        if (!opened.ok) log(`uncle_sam_interaction views.open failed ${opened.code}`);
        return done();
      }
      if (payload.type === 'view_submission' && payload.view?.callback_id === WT_RATE_CALLBACK) {
        const meta = rateMetaOf(payload.view);
        const stored = meta ? await store.getRequest(meta.requestKey) : null;
        const blocked = meta ? packetBlock(stored, userId) : '📁 That form is no longer valid.';
        if (blocked) return json({ response_action: 'update', view: noticeModal(blocked) });
        const read = readRate(payload.view);
        if (!read.ok) return json({ response_action: 'errors', errors: read.errors });
        const eventId = `wtrate-${String(payload.view.id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 100)}`;
        await store.recordEvent({ eventId, source: 'slack', type: 'packet_send', occurredAt: clock(), isFixture: false, authorId: userId, requestKey: meta.requestKey, rate: read.rate });
        told('form', 'packet_rate', meta.requestKey, `recorded event=${eventId.slice(0, 30)}`);
        if (typeof schedule === 'function' && typeof run === 'function') schedule(run({ eventId, attemptId: crypto.randomUUID() }).catch(() => undefined));
        return json({ response_action: 'update', view: rateDoneModal({ name: stored.payload?.candidate?.fullName ?? 'them', rate: read.rate, invite: !(stored.payload?.trialStart && stored.payload?.trialEnd) }) });
      }
      if (payload.type === 'view_submission' && payload.view?.callback_id === TAKEHOME_CALLBACK) {
        const meta = takeHomeMetaOf(payload.view);
        const stored = meta ? await store.getRequest(meta.requestKey) : null;
        const blocked = meta ? (await answerBlock(store, stored, userId) ?? (TAKEHOME_ACTIONS.includes(stored.action) ? null : '📁 That form is no longer valid.')) : '📁 That form is no longer valid.';
        if (blocked) return json({ response_action: 'update', view: noticeModal(blocked) });
        const read = readTakeHomeSubmission(payload.view, meta);
        if (!read.ok) return json({ response_action: 'errors', errors: read.errors });
        const eventId = `thform-${String(payload.view.id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 100)}`;
        await store.recordEvent({ eventId, source: 'slack', type: 'takehome_form', occurredAt: clock(), isFixture: false,
          authorId: userId, requestKey: meta.requestKey, form: read.form, channelId: stored.receipt?.channelId ?? null });
        told('form', 'takehome_form', meta.requestKey, `recorded event=${eventId.slice(0, 30)}`);
        if (typeof schedule === 'function' && typeof run === 'function') schedule(run({ eventId, attemptId: crypto.randomUUID() }).catch(() => undefined));
        return json({ response_action: 'update', view: takeHomeDoneModal(read.form) });
      }
      if (payload.type === 'view_submission' && payload.view?.callback_id === FEEDBACK_CALLBACK) {
        const meta = metaOf(payload.view);
        const stored = meta ? await store.getRequest(meta.requestKey) : null;
        const blocked = meta ? (await answerBlock(store, stored, userId) ?? (TAKEHOME_ACTIONS.includes(stored.action) ? '📁 That form is no longer valid.' : null)) : '📁 That form is no longer valid.';
        if (blocked) return json({ response_action: 'update', view: noticeModal(blocked) });
        const read = readSubmission(payload.view, meta, { today: todayLA(clock()) });
        if (!read.ok) return json({ response_action: 'errors', errors: read.errors });
        const eventId = `form-${String(payload.view.id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 100)}`;
        await store.recordEvent({ eventId, source: 'slack', type: 'feedback_form', occurredAt: clock(), isFixture: false,
          authorId: userId, requestKey: meta.requestKey, form: read.form, channelId: stored.receipt?.channelId ?? null });
        told('form', 'feedback_form', meta.requestKey, `recorded event=${eventId.slice(0, 30)} decision=${read.form?.decision ?? meta.decision}`);
        if (typeof schedule === 'function' && typeof run === 'function') schedule(run({ eventId, attemptId: crypto.randomUUID() }).catch(() => undefined));
        return json({ response_action: 'update', view: doneModal(read.form) });
      }
      return empty();
    } catch (error) {
      log(`uncle_sam_interaction failed ${typeof error?.code === 'string' ? error.code : 'unexpected'}`);
      return payload.type === 'view_submission' ? json({ response_action: 'errors', errors: { [Object.keys(payload.view?.state?.values ?? {})[0] ?? 'observations']: 'Something went wrong on my side. Try Send again in a minute.' } }) : empty();
    }
  };
}
