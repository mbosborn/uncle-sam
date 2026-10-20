/**
 * Bounded outbound transport; not an authority engine or a generic Slack tool.
 * Only trusted server code may construct this adapter. None of its dependency
 * callbacks may be supplied by an MCP caller or copied from a request payload.
 * In particular authorizePreparedAction must re-read current source threads,
 * candidate identity, policy guards, prior delivery and holds on EACH call.
 * Missing dependencies fail closed. No conversations are created here.
 */
import { GROUP_ROUTES, isGroupRoute } from './group-routes.mjs';
import { slackWire } from './slack-wire.mjs';
import { decisionButtons, deepDiveButtons, nextStepButtons, rejectionButtons, ROBIN, INTERVIEWER } from './feedback-form.mjs';
import { takeHomeButtons, cancelButtons, takeHomeStepBlocks, TH_STEP_ONE } from './takehome-review.mjs';
import { packetButtons, validRate, rateText, datesLine } from './work-trial-offer.mjs';
import { noShowButtons } from './no-show.mjs';
import { bodyBlock, trustedLinkedin } from './name-links.mjs';
const TEAM_ID = 'T07011B7862';
const APP_ID = 'A09DDB3817C';
const PEOPLE = Object.freeze({ project: 'U0F9EF97D89', jamie: 'U0CB213D6D6',
  aa: 'U0BF89D1279', robin: 'U0A4F08721B', alexis: 'U0476A5BC82', interviewer: 'U030A09DBFF' });
const ROUTES = Object.freeze({
  jamie_group: ['project', 'jamie'], aa_group: ['project', 'aa'], project: ['project'],
  interviewer_rishi: ['robin'], interviewer_rithika: ['alexis'],
  interviewer_aa: ['aa'], interviewer_santosh: ['interviewer'], interviewer: ['interviewer'],
  ...GROUP_ROUTES,
});
// An interview question goes to the interviewer's own DM, or to a group DM of the interviewers who took it together.
const INTERVIEW_ROUTES = ['interviewer_rishi', 'interviewer_rithika', 'interviewer_aa', 'interviewer_santosh', ...Object.keys(GROUP_ROUTES)];
const ACTION_ROUTES = Object.freeze({
  'interview.feedback_request': INTERVIEW_ROUTES, 'interview.feedback_reminder': INTERVIEW_ROUTES,
  'interview.next_step_request': INTERVIEW_ROUTES, 'next_step.project': ['project'], 'work_trial.packet_offer': ['project'], 'noshow.choice': [...INTERVIEW_ROUTES, 'project'], 'email.reschedule_pending': ['project'], 'email.deep_dive_pending': ['project'], 'email.takehome_pending': ['project'], 'email.takehome_nudge_pending': ['project'], 'email.deep_dive_nudge_pending': ['project'], 'takehome.expiry_mason': ['project'],
  'takehome.grading_request': ['interviewer'], 'takehome.grading_reminder': ['interviewer'],
  'rejection.confirmation_request': ['interviewer_rishi', 'interviewer_rithika', 'interviewer_santosh', 'interviewer'],
  'onboarding.jamie': ['jamie_group'], 'onboarding.aa': ['aa_group'],
  'onboarding.address_update': ['aa_group'], 'onboarding.ready_notice': ['project'],
  'offboarding.reminder': ['jamie_group'], 'offboarding.cancellation': ['jamie_group'],
  'failure.project': ['project'], 'payment.project': ['project'],
});
export const SLACK_MESSAGE_KINDS = Object.freeze(Object.keys(ACTION_ROUTES));
const tsPattern = /^\d{1,13}\.\d{1,6}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sorted = value => [...new Set(value)].sort();
/**
 * The text Slack stores is not byte for byte what was posted: emoji come back as :shortcodes: (📣 -> :mega:) and &, <, > are
 * escaped. Every feedback question since Oct 15 was marked Uncertain over this, so its buttons answered "That request is
 * closed" (Interviewer's Advance on River Collins, Oct 16). Compared without emoji and escapes; everything else must match.
 */
export function sameSlackText(stored, posted) {
  const flat = value => String(value ?? '').replace(/:[a-z0-9_+'-]+:/gi, ' ').replace(/[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\uFE0F\u200D]/gu, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
  return flat(stored) === flat(posted);
}
const sameSet = (a, b) => Array.isArray(a) && Array.isArray(b) && JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
class DispatchError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new DispatchError(code); };
function field(value, max = 300) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f<>]/u.test(value)) fail('invalid_message_field');
  return value.trim();
}
function link(value) {
  const text = field(value, 2048);
  let url; try { url = new URL(text); } catch { fail('invalid_message_link'); }
  if (url.protocol !== 'https:' || url.username || url.password) fail('invalid_message_link');
  return text;
}
function candidateOf(request) {
  const candidate = request.payload?.candidate;
  if (!candidate || !uuidPattern.test(candidate.pageId ?? '') || candidate.pageId !== request.candidateId ||
      candidate.emailVerified !== true || typeof candidate.email !== 'string' || candidate.email.length > 254 ||
      !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(candidate.email)) fail('candidate_identity_unverified');
  const fullName = field(candidate.fullName, 160);
  const url = link(candidate.url);
  const parsed = new URL(url);
  if (!['notion.so', 'www.notion.so', 'app.notion.com', 'notion.com', 'www.notion.com'].includes(parsed.hostname) ||
      !parsed.pathname.replaceAll('-', '').toLowerCase().includes(candidate.pageId.replaceAll('-', ''))) fail('candidate_link_mismatch');
  // Their LinkedIn, only in the canonical form trusted code builds; anything else is dropped (the plain name shows).
  return { ...candidate, fullName, url, linkedin: trustedLinkedin(candidate.linkedin) };
}

/**
 * Fixed, concise templates in Uncle Sam's voice (the 1917 recruiting-poster figure: grave, plain-spoken, first person,
 * says what to do next; see the spec page, "Voice: Uncle Sam"). The decision words and every field stay verbatim.
 * No caller-controlled free-form message or Slack blocks.
 */
const EXPECTED_NEXT = Object.freeze({ take_home: 'a take-home', another_interview: 'another interview', deep_dive: 'the technical deep dive with Interviewer', work_trial: 'a work trial' });

export function renderSlackMessage(request) {
  if (!SLACK_MESSAGE_KINDS.includes(request?.action)) fail('unsupported_message_kind');
  const c = candidateOf(request), p = request.payload;
  let text;
  switch (request.action) {
    case 'interview.feedback_request': {
      // Tailored to the interview (Project, 2026-10-16): the next step the invite and the record point to. What a round tests is the
      // same for everybody (the process is set), so the ask is a line on why they were good, not what the next step should test.
      const expected = EXPECTED_NEXT[p.likelyNext];
      // The call's Meet record shows no guest ever joined (meet.mjs): say so, the "did not happen" button is right there.
      const noGuest = p.meetNoInterviewer === true ? ' The Meet shows no one from Company joined.' : p.meetNoGuest === true ? ' The Meet shows no guest joined.' : '';
      const tail = expected
        ? `By the invite and the record, ${expected} comes next. If you advance, confirm it and give me a line on why they were good.`
        : `If advancing, tell me the next step (another interview, a take-home or a work trial with dates) and a line on why they were good.`;
      if (Array.isArray(p.together) && p.together.length > 1) { text = `📣 ${p.together.map(n => field(n, 40)).join(' and ')}, you took ${c.fullName}'s ${field(p.roleRound)} together. One of you, give me the call: advance, do not advance, hold, or interview did not happen?${noGuest} Tap a button below or reply here. ${tail}`; break; }
      if (p.deepDive) { text = `📣 I need your verdict on ${c.fullName}'s technical deep dive: work trial, another round, do not advance, hold, or it did not happen?${noGuest} Tap a button below or reply here.`; break; }
      // Robin and Interviewer: the take-home or the work trial is one tap (feedback-form.mjs SHORTCUT_BUTTONS; Project, 2026-10-19).
      if ((request.recipientIds ?? []).some(id => id === ROBIN || id === INTERVIEWER)) { text = `📣 I need your call on ${c.fullName} — ${field(p.roleRound)}: send the take-home, skip to a work trial, another interview, do not advance, hold, or it did not happen?${noGuest} Tap a button below or reply here.`; break; }
      text = `📣 I need your call on ${c.fullName} — ${field(p.roleRound)}: advance, do not advance, hold, or interview did not happen?${noGuest} Tap a button below or reply here. ${tail}`; break;
    }
    case 'interview.feedback_reminder':
      if (Array.isArray(p.together) && p.together.length > 1) { text = `📯 ${p.together.map(n => field(n, 40)).join(' and ')}, I still need one of you to give me the call on ${c.fullName} — ${field(p.roleRound)}. Tap a button below or reply here.`; break; }
      if (p.deepDive) { text = `📯 I still need your verdict on ${c.fullName}'s technical deep dive. Tap a button below or reply here.`; break; }
      text = `📯 I still need your call on ${c.fullName} — ${field(p.roleRound)}. Tap a button below or report your interview feedback in this thread.`; break;
    case 'interview.next_step_request':
      text = p.missing === 'trial_dates'
        ? `🫵 One more thing on ${c.fullName}: I need the work trial dates before it can be booked. Tap Work trial below and give me the start and end.`
        : `🫵 One more thing on ${c.fullName}: what is the next step, another interview, a take-home or a work trial? Tap one below and I'll take what I need to book it.`;
      break;
    // Uncle Sam's own one-line news ("🪖 X is confirmed for a work trial. Sending ...") goes as it is, without the prefix.
    case 'next_step.project': text = /^🪖 /.test(String(p.booking ?? '')) && String(p.booking).includes(c.fullName) ? field(p.booking, 900) : `📋 Next step for ${c.fullName}: ${field(p.booking, 900)}`; break;
    case 'noshow.choice': {
      // No-show (no-show.mjs): a new link, or close them out. The interviewer decides.
      const kind = p.callKind ? field(p.callKind, 40) : 'call';
      const who = field(p.interviewerName ?? 'the interviewer', 40);
      text = (p.detected ? `📋 The Meet shows ${who} waited ${Number.isInteger(p.waitedMin) && p.waitedMin > 0 && p.waitedMin < 600 ? `${p.waitedMin} minute${p.waitedMin === 1 ? '' : 's'}` : 'a few minutes'} and ${c.fullName} never joined the ${kind}.`
        : `📋 ${c.fullName} didn't show for the ${kind}.`)
        // A second miss (Project, 2026-10-16): a reminder, and a nudge to withdraw, with the new link still there.
        + (p.secondTime ? ` This is their second time: they already had ${p.earlier ? field(p.earlier, 120) : 'a missed call'}. You can send another link, but I'd withdraw them.`
          : ` Send them ${field(p.interviewerName ?? 'your', 40)}'s link to pick a new time (from Project's Gmail, after his 30-minute Cancel), or withdraw them?`)
        + ' Withdrawn is not a rejection: no rejection email goes out.' + (p.detected ? ' If they joined some other way, tap It happened.' : '');
      break;
    }
    case 'email.reschedule_pending':
      text = `📋 ${field(p.who, 40)} asked to reschedule ${c.fullName} after a no-show. I'll email them ${field(p.interviewerName, 40)}'s link to pick a new time from your Gmail, ${field(p.when, 60)}. Tap Cancel to stop it.`; break;
    case 'work_trial.packet_offer': {
      // Work-trial-offer.mjs: Robin's or Interviewer's call, with the packet one tap away.
      if (p.rate !== undefined && !validRate(p.rate)) fail('invalid_message_field');
      const rate = p.rate !== undefined ? rateText(p.rate) : null;
      // The dates and the pay, so Project checks them before he taps (Project, 2026-10-16); Send also emails the candidate the confirmation.
      // No dates yet (Project, 2026-10-18): Send emails them the invitation asking for their dates (trial-invite.mjs), not the packet.
      // No rate: one short question, answered by a reply in the thread (trial-terms.mjs handleTrialRateReply; Project, 2026-10-20).
      const first = String(c.fullName ?? '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/[^\p{L}\s'.-]/gu, ' ').trim().split(/\s+/)[0] || c.fullName;
      // The owner's line exactly (Project, 2026-10-20); no buttons with it: his reply in the thread is the answer.
      if (!rate) { const by = typeof p.by === 'string' && /^[\p{L}'-]{2,30}$/u.test(p.by) ? p.by : null; text = `🪖 ${by ? `${by} pushed ${c.fullName} through to` : `${c.fullName} is confirmed for`} a work trial. Need ${first}'s daily rate; reply here and I'll send out ${p.trialStart && p.trialEnd ? 'the paperwork' : 'the invite'}.`; break; }
      text = !(p.trialStart && p.trialEnd)
        ? `📋 ${c.fullName} is moving to a work trial. Send them the invite asking for their dates at ${rate} per day?`
        // Dates on the record (Robin's fast-track): the documents and a confirmation of the dates that asks them to say if they're
        // wrong (Project, 2026-10-18: "it should be more like a confirmation and let me know if these dates are incorrect").
        : `📋 ${c.fullName} is moving to a work trial, ${datesLine(p.trialStart, p.trialEnd).replace(/^Dates: /, '').replace(/\.$/, '')}. Send the documents and their email at ${rate} per day?`;
      break;
    }
    case 'email.deep_dive_pending':
      text = p.manual
        ? `📋 ${c.fullName} was marked Passed take-home in Notion. I'll email them Interviewer's deep-dive link from your Gmail${p.botSends ? ',' : ''} ${field(p.when, 60)}. Tap Cancel to stop it.`
        : `📋 ${field(p.who, 40)} said move ${c.fullName} to a take-home deep dive. I'll email them Interviewer's deep-dive link from your Gmail${p.botSends ? ',' : ''} ${field(p.when, 60)}. Tap Cancel to stop it.`; break;
    case 'email.takehome_pending':
      text = p.soon
        ? `📋 Sending ${c.fullName} the take-home: I'll create it on Interviewer's site and email them the link from your Gmail with Interviewer cc'd, ${field(p.when, 60)}. Tap Cancel to stop it.`
        : p.botSends
        ? `📋 ${field(p.who, 40)} moved ${c.fullName} on to the take-home. In 30 minutes I'll create their take-home on Interviewer's site and email them the link from your Gmail, ${field(p.when, 60)}. Tap Cancel to stop it.`
        : `📋 ${field(p.who, 40)} moved ${c.fullName} on to the take-home. In 30 minutes I'll create their take-home on Interviewer's site and the clerk emails them the link from your Gmail ${field(p.when, 60)}. Tap Cancel to stop it.`; break;
    case 'email.takehome_nudge_pending':
      text = `📋 ${c.fullName} hasn't started the take-home sent ${field(p.sentDay, 40)}${p.planNote ? ` (${field(p.planNote, 120)})` : ''}. In 30 minutes I'll email them a short reminder from your Gmail, in the same thread with Interviewer cc'd, ${field(p.when, 60)}. Tap Cancel to stop it.`; break;
    case 'email.deep_dive_nudge_pending':
      text = `📋 ${c.fullName} hasn't booked the deep dive with Interviewer from the invite sent ${field(p.sentDay, 40)}. In 30 minutes I'll email them a short reminder from your Gmail, in the same thread with Interviewer cc'd, ${field(p.when, 60)}. Tap Cancel to stop it.`; break;
    case 'takehome.expiry_mason':
      text = `📯 ${c.fullName}'s take-home link closes ${field(p.closes, 60)} and it's ${field(p.status, 40)}. ${p.planNote ? `${field(p.planNote, 160)} ` : ''}Extend it on Interviewer's site if they need more time.`; break;
    case 'takehome.grading_request':
      text = `🫵 New take-home in: ${c.fullName} submitted ${field(p.submittedDay, 60)}${p.scoreLine ? `, ${field(p.scoreLine, 80)}` : ''}. I want YOU on it: three quick steps below, or reply here.`; break;
    case 'takehome.grading_reminder':
      text = `📯 ${c.fullName}'s take-home is still waiting on your call. Pick it up at step 1 below, or reply here.`; break;
    case 'rejection.confirmation_request':
      text = `📋 I need your word on this one: confirm ${c.fullName} is rejected and I should send the rejection from Project’s email after the 24-hour rule? Tap Confirm reject below.`; break;
    case 'onboarding.jamie':
    case 'onboarding.aa': {
      const details = `${c.fullName} — ${field(p.role)}; personal email: ${c.email}; Company email: ${field(p.companyEmailStatus)}. Confirmed trial: ${field(p.confirmedStart)} to ${field(p.confirmedEnd)} (${field(p.timezone, 100)}). ${field(p.arrangement)}. Deadline: ${field(p.deadline)}. Instructions: ${field(p.trialInstructions, 600)}.`;
      text = request.action === 'onboarding.jamie'
        ? `🪖 Jamie: a new recruit is reporting for a work trial. Please handle onboarding for ${details} Send NDA, CIIAA, Terms of Work, and the new work-trial agreement. Confirm documents sent, all four signed, and other required onboarding ready separately. Paperwork compensation: ${field(p.compensationStatus)}.`
        : `🔐 AA: a new recruit needs Okta, and only Okta: ${details} Reply here when Okta is ready.`;
      break;
    }
    case 'onboarding.address_update':
      if (!/^[^\s@]+@company\.example$/i.test(p.companyEmail ?? '')) fail('invalid_company_email');
      text = `📡 Update from headquarters: ${c.fullName}'s confirmed Company address is ${p.companyEmail}. Use it for the existing Okta request.`; break;
    case 'onboarding.ready_notice':
      // The trusted authority resolver proves each included/excluded item; this
      // transport never infers readiness from an unqualified "done".
      text = `🫡 ${c.fullName} is ready to report for duty: onboarding is ready. ${field(p.verifiedReadinessSummary, 600)}`; break;
    case 'offboarding.reminder':
      text = `🎖️ Jamie: ${c.fullName}'s confirmed trial ended ${field(p.confirmedEnd)}. Time to muster them out: please offboard and explicitly confirm here when offboarding is complete.`; break;
    case 'offboarding.cancellation':
      text = `🛑 Jamie: stand down on ${c.fullName}'s trial setup, it is cancelled. Already completed: ${field(p.completedSetup, 600)}. Please stop pending setup, offboard as needed, and explicitly confirm completion here.`; break;
    case 'failure.project': text = `🚨 Project, I need YOU on this one: ${c.fullName} needs attention. ${field(p.blocker, 700)}`; break;
    case 'payment.project': text = `💵 ${c.fullName}: a payment question for Project; I don't handle pay. ${field(p.paymentQuestion, 700)}`; break;
  }
  text += `\n${c.url}`;
  if (text.length > 2800) fail('message_too_long');
  return text;
}

/**
 * The Block Kit layout for the kinds that carry buttons (the text stays the message's fallback and its readback check):
 * the message as plain text, the buttons (whose value is this request's key, re-checked on every click), and a link to
 * the record. Every other kind is plain text.
 */
export function renderSlackBlocks(request, text) {
  // Robin's and Interviewer's prompts carry Send take-home and Skip to work trial (feedback-form.mjs SHORTCUT_BUTTONS).
  const shortcuts = (request?.recipientIds ?? []).some(id => id === ROBIN || id === INTERVIEWER);
  const feedbackButtons = request?.payload?.deepDive === true ? deepDiveButtons : key => decisionButtons(key, { shortcuts });
  const buttons = { 'interview.feedback_request': feedbackButtons, 'interview.feedback_reminder': feedbackButtons,
    'interview.next_step_request': nextStepButtons, 'takehome.grading_request': takeHomeButtons, 'takehome.grading_reminder': takeHomeButtons,
    'email.deep_dive_pending': cancelButtons, 'email.takehome_pending': cancelButtons, 'email.takehome_nudge_pending': cancelButtons, 'email.deep_dive_nudge_pending': cancelButtons, 'rejection.confirmation_request': key => rejectionButtons(key, candidateOf(request).fullName),
    'work_trial.packet_offer': key => packetButtons(key, validRate(request?.payload?.rate)), 'email.reschedule_pending': cancelButtons,
    'noshow.choice': key => noShowButtons(key, { secondTime: request?.payload?.secondTime === true, detected: request?.payload?.detected === true }) }[request?.action];
  const c = candidateOf(request);
  const body = text.slice(0, text.lastIndexOf('\n'));
  const recordLink = `<${c.url}|Open ${c.fullName.replace(/[&<>|*_~`]/g, ' ')}'s record>`;
  // A plain notice stays plain text unless the candidate's name can link to their LinkedIn (Project, 2026-10-15).
  if (!buttons) return c.linkedin ? [bodyBlock(body, c), { type: 'context', elements: [{ type: 'mrkdwn', text: recordLink }] }] : null;
  // A take-home notification walks Interviewer through its steps on this one message (takehome-review.mjs).
  if (['takehome.grading_request', 'takehome.grading_reminder'].includes(request.action)) {
    return takeHomeStepBlocks({ body, bodyBlock: bodyBlock(body, c), steps: [TH_STEP_ONE], actions: buttons(request.requestKey), link: recordLink });
  }
  // A work-trial offer with no rate has no buttons: the rate comes as a reply in the thread (trial-terms.mjs).
  const actions = buttons(request.requestKey);
  return [bodyBlock(body, c), ...(actions ? [actions] : []),
    { type: 'context', elements: [{ type: 'mrkdwn', text: actions ? `${recordLink} · or reply here in your own words` : `${recordLink} · reply here with the rate` }] }];
}

function externalGate(external, local, request, now) {
  if (external?.verified !== true || !Number.isSafeInteger(external.readAt) || external.readAt > now ||
      now - external.readAt > 60000 || external.mode !== local.mode) fail('external_control_unverified');
  if (local.mode === 'Off') fail('mode_off');
  if (local.mode === 'Test') { if (!request.isFixture) fail('fixture_required'); return; }
  if (local.mode !== 'Live' || request.isFixture || !local.baselineComplete || !external.baselineComplete ||
      !Number.isSafeInteger(local.activatedAt) || external.activatedAt !== local.activatedAt ||
      request.triggerAt < local.activatedAt) fail('live_gate_ineligible');
}

/**
 * routes is a server-only map of routeKey -> {channelId, type:'im'|'mpim'}.
 * getCandidateThread must return an existing verified binding, or an atomic
 * durable first-thread reservation owned by this request. It must never guess
 * "no thread" after a missing/failed lookup. saveCandidateThread must perform
 * compare-and-set and readback, preserving that reservation on uncertain sends.
 * No default implementations intentionally exist for these authority boundaries.
 */
export function createSlackDispatcher({ env = {}, store, routes = {}, authorizePreparedAction,
  readControl, getCandidateThread, saveCandidateThread, fetchImpl = globalThis.fetch,
  clock = Date.now, groupRoutes = null } = {}) {
  const routeConfig = structuredClone(routes);
  // Group DMs are opened as needed (group-routes.mjs); they are read live from the shared table, never from the fixed map.
  const routeOf = key => routeConfig[key] ?? (isGroupRoute(key) ? groupRoutes?.[key] : undefined);
  async function api(method, parameters = {}) {
    let response;
    try {
      response = await fetchImpl(`https://slack.com/api/${method}`, {
        method: 'POST', redirect: 'error', ...slackWire(method, env.SLACK_BOT_TOKEN, parameters), signal: AbortSignal.timeout(15000),
      });
    } catch { fail('slack_transport_failed'); }
    if (!response.ok) fail('slack_http_failed');
    let body; try { body = await response.json(); } catch { fail('slack_response_invalid'); }
    if (body?.ok !== true) fail('slack_api_failed'); // Never store raw error bodies or secrets.
    return body;
  }
  async function authorize(request, text, phase) {
    const result = await authorizePreparedAction({ request: structuredClone(request), messageText: text, phase });
    const scope = result?.scope, now = clock();
    if (result?.verified !== true || result.sourceLinksVerified !== true || result.holdsChecked !== true ||
        result.priorDeliveryChecked !== true || !Number.isSafeInteger(result.checkedAt) || result.checkedAt > now ||
        now - result.checkedAt > 60000 || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= now ||
        result.expiresAt > result.checkedAt + 60000 || scope?.requestKey !== request.requestKey ||
        scope.candidateId !== request.candidateId || scope.candidateEmail !== request.payload.candidate.email ||
        scope.occurrenceId !== request.occurrenceId || scope.action !== request.action ||
        !sameSet(scope.recipientIds, request.recipientIds) || scope.messageText !== text ||
        !Array.isArray(result.sourceEventIds) || !result.sourceEventIds.length || result.sourceEventIds.length > 50) fail('prepared_authorization_unverified');
    for (const eventId of sorted(result.sourceEventIds)) {
      if (typeof eventId !== 'string' || !eventId) fail('source_evidence_unverified');
      const event = await store.getEvent(eventId);
      if (!event || event.eventId !== eventId || event.isFixture !== request.isFixture ||
          !['Observed', 'Processed'].includes(event.status) || event.type === 'source_amendment') fail('source_evidence_unverified');
    }
    // The final SQL amendment guard must see EVERY supporting source, including
    // sources the resolver learned after the original request was prepared.
    for (const eventId of sorted(result.sourceEventIds)) {
      const linked = await store.linkEventToRequest({ requestKey: request.requestKey, eventId });
      if (linked?.linked !== true) fail('source_link_unverified');
    }
    if (clock() >= result.expiresAt) fail('prepared_authorization_expired');
    return { sourceEventIds: sorted(result.sourceEventIds), expiresAt: result.expiresAt };
  }
  async function verifyRoute(route, recipients) {
    const identity = await api('auth.test');
    if (identity.team_id !== TEAM_ID || identity.user_id !== env.SLACK_BOT_USER_ID ||
        identity.bot_id !== env.SLACK_BOT_ID) fail('slack_identity_mismatch');
    const { bot } = await api('bots.info', { bot: env.SLACK_BOT_ID });
    if (bot?.id !== env.SLACK_BOT_ID || bot.user_id !== env.SLACK_BOT_USER_ID ||
        bot.app_id !== APP_ID || bot.deleted !== false) fail('slack_app_identity_mismatch');
    const { channel } = await api('conversations.info', { channel: route.channelId });
    if (channel?.id !== route.channelId || channel.is_archived || channel.is_shared || channel.is_ext_shared ||
        channel.is_org_shared || (route.type === 'im' ? channel.is_im !== true : channel.is_mpim !== true)) fail('slack_route_mismatch');
    const members = new Set(); let cursor;
    for (let page = 0; page < 5; page++) {
      const result = await api('conversations.members', { channel: route.channelId, limit: 200, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(result.members) || result.members.some(id => !/^[UW][A-Z0-9]+$/.test(id))) fail('slack_members_unverified');
      for (const id of result.members) members.add(id);
      const next = result.response_metadata?.next_cursor;
      if (next != null && typeof next !== 'string') fail('slack_members_unverified');
      cursor = next?.trim();
      if (!cursor) break;
    }
    if (cursor || !sameSet([...members], [...recipients, env.SLACK_BOT_USER_ID])) fail('slack_members_mismatch');
  }
  async function exactMessage(channelId, messageTs, threadTs) {
    const bounds = { channel: channelId, oldest: messageTs, latest: messageTs, inclusive: true, limit: 15 };
    const body = threadTs
      ? await api('conversations.replies', { ...bounds, ts: threadTs })
      : await api('conversations.history', bounds);
    if (!Array.isArray(body.messages)) fail('slack_message_unverified');
    const matches = body.messages.filter(message => message.ts === messageTs);
    if (matches.length !== 1) fail('slack_message_unverified');
    return matches[0];
  }
  return async function dispatch({ requestKey, claimToken } = {}) {
    let claimed = false, postAttempted = false, readbackVerified = false;
    try {
      if (typeof requestKey !== 'string' || typeof claimToken !== 'string' || !claimToken.trim()) fail('invalid_dispatch_input');
      if (!store || typeof authorizePreparedAction !== 'function' || typeof readControl !== 'function' ||
          typeof getCandidateThread !== 'function' || typeof saveCandidateThread !== 'function') fail('trusted_dependencies_missing');
      const request = await store.getRequest(requestKey);
      if (!request || request.state !== 'Pending') return { status: 'blocked', reason: 'request_not_pending' };
      const local = await store.getControl();
      if (local.mode === 'Off') return { status: 'blocked', reason: 'mode_off' };
      if (local.mode === 'Live' && env.UNCLE_SAM_AUTOMATIC_ACTIVITY !== 'enabled') fail('automatic_activity_off');
      externalGate(await readControl(), local, request, clock());
      const text = renderSlackMessage(request);
      const routeKey = request.payload.routeKey, route = routeOf(routeKey);
      if (!ACTION_ROUTES[request.action].includes(routeKey) || !route || !/^[CDG][A-Z0-9]+$/.test(route.channelId ?? '') ||
          route.type !== (ROUTES[routeKey].length >= 2 ? 'mpim' : 'im')) fail('route_not_configured');
      if (routeConfig.jamie_group && routeConfig.aa_group &&
          routeConfig.jamie_group.channelId === routeConfig.aa_group.channelId) fail('owner_groups_must_be_separate');
      const recipients = ROUTES[routeKey].map(person => PEOPLE[person]);
      if (!sameSet(request.recipientIds, recipients)) fail('recipient_scope_mismatch');
      const canonical = JSON.stringify([request.candidateId, request.occurrenceId.trim(), request.action, sorted(recipients)]);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
      const expectedKey = `usam:v1:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
      if (requestKey !== expectedKey) fail('semantic_request_key_mismatch');
      await authorize(request, text, 'prepare');
      const threadInput = { requestKey, candidateId: request.candidateId, routeKey, channelId: route.channelId };
      const thread = await getCandidateThread(threadInput);
      if (thread?.verified !== true || thread.candidateId !== request.candidateId || thread.routeKey !== routeKey ||
          thread.channelId !== route.channelId || (thread.threadTs !== null && !tsPattern.test(thread.threadTs ?? '')) ||
          typeof thread.ownerRequestKey !== 'string' || !thread.ownerRequestKey.trim() ||
          (thread.threadTs === null && thread.ownerRequestKey !== requestKey)) fail('candidate_thread_unverified');
      if (local.mode === 'Live') {
        if (!/^xoxb-[A-Za-z0-9-]+$/.test(env.SLACK_BOT_TOKEN ?? '') ||
            !/^[UW][A-Z0-9]+$/.test(env.SLACK_BOT_USER_ID ?? '') || !/^B[A-Z0-9]+$/.test(env.SLACK_BOT_ID ?? '')) fail('slack_credentials_not_configured');
        await verifyRoute(route, recipients);
        if (thread.threadTs) {
          const root = await exactMessage(route.channelId, thread.threadTs, null);
          if (root.type !== 'message' || root.hidden || root.subtype === 'tombstone' ||
              (root.thread_ts && root.thread_ts !== root.ts)) fail('candidate_thread_missing');
        }
      }
      const claim = await store.claimRequest({ requestKey, claimToken,
        expectedControlVersion: local.version, expectedPauseGeneration: local.pauseGeneration });
      if (!claim.claimed) return { status: 'blocked', reason: 'request_not_claimable' };
      claimed = true;
      if (claim.dryRun) {
        const result = { channelId: route.channelId, routeKey, threadTs: thread.threadTs, text, delivered: false };
        const saved = await store.markSimulated({ requestKey, claimToken, result });
        if (!saved.updated || (await store.getRequest(requestKey))?.state !== 'Simulated') fail('simulation_receipt_unverified');
        return { status: 'simulated', delivered: false, requestKey };
      }
      const authorization = await authorize(request, text, 'before_send');
      externalGate(await readControl(), await store.getControl(), request, clock());
      if (env.UNCLE_SAM_AUTOMATIC_ACTIVITY !== 'enabled') fail('automatic_activity_off');
      if (clock() >= authorization.expiresAt) fail('prepared_authorization_expired');
      // Nothing with side effects or network I/O is allowed between this final
      // atomic hold/pause/source-amendment check and chat.postMessage.
      const finalGate = await store.authorizeDispatch({ requestKey, claimToken });
      if (!finalGate.allowed) fail('dispatch_paused_or_stale');
      const blocks = renderSlackBlocks(request, text);
      const body = { channel: route.channelId, text, ...(blocks ? { blocks } : {}), mrkdwn: false, parse: 'none',
        unfurl_links: false, unfurl_media: false, reply_broadcast: false,
        ...(thread.threadTs ? { thread_ts: thread.threadTs } : {}) };
      postAttempted = true;
      const sent = await api('chat.postMessage', body);
      if (sent.channel !== route.channelId || !tsPattern.test(sent.ts ?? '')) fail('slack_post_result_unverified');
      const message = await exactMessage(route.channelId, sent.ts, thread.threadTs);
      if (message.type !== 'message' || message.user !== env.SLACK_BOT_USER_ID || message.bot_id !== env.SLACK_BOT_ID ||
          (message.app_id ?? message.bot_profile?.app_id) !== APP_ID || !sameSlackText(message.text, text) || message.hidden || message.edited ||
          (thread.threadTs ? message.thread_ts !== thread.threadTs : message.thread_ts != null && message.thread_ts !== sent.ts)) fail('slack_message_unverified');
      readbackVerified = true;
      const persisted = await saveCandidateThread({ ...threadInput, verified: true, ownerRequestKey: thread.ownerRequestKey,
        previousThreadTs: thread.threadTs, threadTs: thread.threadTs ?? sent.ts, messageTs: sent.ts });
      if (persisted?.verified !== true || persisted.threadTs !== (thread.threadTs ?? sent.ts)) fail('thread_receipt_unverified');
      const receipt = { verified: true, resultId: `${route.channelId}:${sent.ts}`, channelId: route.channelId,
        messageTs: sent.ts, threadTs: thread.threadTs ?? sent.ts, routeKey, appId: APP_ID, teamId: TEAM_ID,
        botUserId: env.SLACK_BOT_USER_ID, recipientIds: sorted(recipients), sourceEventIds: authorization.sourceEventIds,
        text, verifiedAt: clock(), messageUrl: `https://example-workspace.slack.com/archives/${route.channelId}/p${sent.ts.replace('.', '').padEnd(sent.ts.indexOf('.') + 6, '0')}` };
      const completed = await store.completeRequest({ requestKey, claimToken, receipt });
      const readback = await store.getRequest(requestKey);
      if (!completed.updated || readback?.state !== 'Sent' || readback.receipt?.resultId !== receipt.resultId) fail('delivery_receipt_unverified');
      return { status: 'sent', delivered: true, requestKey, receipt };
    } catch (error) {
      const reason = error instanceof DispatchError ? error.code : 'dispatch_dependency_failed';
      if (claimed) {
        // Retain the claim indefinitely. Even a confirmed pre-send interruption
        // requires reviewed re-arm; the store intentionally has no blind retry.
        try { await store.markUncertain({ requestKey, claimToken, reason: `${postAttempted ? 'delivery_uncertain' : 'not_sent'}:${reason}` }); } catch { /* The unreleased Sending claim still blocks retries. */ }
      }
      return { status: postAttempted ? 'uncertain' : 'blocked', reason,
        delivered: readbackVerified ? true : postAttempted ? null : false, locked: claimed };
    }
  };
}
