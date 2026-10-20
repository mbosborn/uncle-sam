import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createStore } from '../service/lib/store.mjs';
import { requestKey } from '../src/policy.mjs';
import { createSlackDispatcher, renderSlackMessage, renderSlackBlocks, SLACK_MESSAGE_KINDS } from '../service/lib/slack-dispatch.mjs';
import { slackArguments } from './support/slack-wire.mjs';

// Real deployment migrations and repository reservations; only Slack and source
// evidence adapters are fixtures. No credentials, live database or sends.
function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const dir = new URL('../service/drizzle/', import.meta.url);
  for (const file of readdirSync(dir).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(file, dir), 'utf8'));
  function prepare(sql, params = []) {
    return { sql, params, bind(...values) { return prepare(sql, values); },
      async first(column) { const row = sqlite.prepare(sql).get(...params); return column ? row?.[column] ?? null : row ?? null; },
      async all() { return { results: sqlite.prepare(sql).all(...params), success: true }; },
      async run() { const row = sqlite.prepare(sql).run(...params); return { success: true, meta: { changes: row.changes } }; } };
  }
  return { sqlite, prepare, async batch(statements) {
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      const result = statements.map(s => ({ success: true, results: sqlite.prepare(s.sql).all(...s.params) }));
      sqlite.exec('COMMIT'); return result;
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
}
const NOW = Date.parse('2026-10-14T00:00:00Z');
const ROOT_TS = '1791920000.123456';
const BOT_USER = 'UUNCLESAM', BOT_ID = 'BUNCLESAM', TEAM_ID = 'T07011B7862', APP_ID = 'A09DDB3817C';
const people = { project: 'U0F9EF97D89', jamie: 'U0CB213D6D6', aa: 'U0BF89D1279',
  robin: 'U0A4F08721B', alexis: 'U0476A5BC82', interviewer: 'U030A09DBFF' };
const routeRecipients = { jamie_group: [people.project, people.jamie], aa_group: [people.project, people.aa],
  project: [people.project], interviewer: [people.interviewer], interviewer_rishi: [people.robin],
  interviewer_rithika: [people.alexis], interviewer_aa: [people.aa], interviewer_santosh: [people.interviewer] };
const candidate = { pageId: '11111111-2222-3333-4444-555555555555', fullName: 'Synthetic Candidate',
  email: 'synthetic@example.invalid', emailVerified: true,
  url: 'https://app.notion.com/p/11111111222233334444555555555555' };
const defaults = { interviewerName: 'Interviewer', callKind: 'intro call', roleRound: 'Engineer / round 1', submissionUrl: 'https://example.invalid/submission', submittedDay: 'Thu, Oct 15, 2026', sentDay: 'Mon, Oct 12', closes: 'Mon at 5:31pm PT', status: 'not started', scoreLine: 'portal score 83/100', who: 'Interviewer', when: 'at 12:31pm PT',
  role: 'Engineer', companyEmailStatus: 'pending confirmation', confirmedStart: 'October 20, 2026',
  confirmedEnd: 'October 24, 2026', timezone: 'America/Los_Angeles', arrangement: 'Remote',
  deadline: 'October 19, 2026 5pm PT', trialInstructions: 'Use agreed trial access only',
  compensationStatus: 'Agreed details in linked candidate record', companyEmail: 'synthetic@company.example',
  verifiedReadinessSummary: 'All four signed; Jamie onboarding ready; AA Okta ready.',
  completedSetup: 'Documents sent; email setup pending', blocker: 'Candidate-agreed trial dates missing',
  paymentQuestion: 'Please review the agreed trial compensation.',
  booking: 'Robin moved them on to a work trial Tue, Oct 20, 2026 to Fri, Oct 24, 2026; work: pricing model. Book it and start onboarding.' };

async function fixture(options = {}) {
  const db = database(), calls = [], authCalls = [], savedThreads = [];
  const store = createStore(db, { authorized: true, clock: () => NOW });
  const mode = options.mode ?? 'Live', isFixture = options.isFixture ?? mode === 'Test';
  if (mode !== 'Off') await store.updateControl({ expectedVersion: 0, mode,
    ...(mode === 'Live' ? { baselineComplete: true, activatedAt: NOW } : {}) });
  const action = options.action ?? 'takehome.grading_request', routeKey = options.routeKey ?? 'interviewer';
  const payload = { ...defaults, candidate, routeKey, ...options.payload };
  const request = { candidateId: candidate.pageId, candidate: payload.candidate, occurrenceId: 'occurrence-1',
    action, recipientIds: options.recipientIds ?? routeRecipients[routeKey], payload, triggerAt: options.triggerAt ?? NOW, isFixture };
  request.requestKey = options.requestKey ?? requestKey(request);
  await store.recordEvent({ eventId: 'source-1', source: 'slack', messageTs: `${NOW / 1000}.000000`,
    teamId: TEAM_ID, appId: APP_ID, channelId: 'DSOURCE', authorId: people.robin,
    text: 'Synthetic verified instruction', isFixture });
  await store.ensureRequest({ ...request, sourceEventId: 'source-1' });
  const routes = Object.fromEntries(Object.entries(routeRecipients).map(([key, recipients], i) =>
    [key, { channelId: `${recipients.length === 2 ? 'G' : 'D'}ROUTE${i}`, type: recipients.length === 2 ? 'mpim' : 'im' }]));
  Object.assign(routes, options.routes);
  const sentMessages = new Map();
  const env = { SLACK_BOT_TOKEN: 'xoxb-fixture-only', SLACK_BOT_USER_ID: BOT_USER, SLACK_BOT_ID: BOT_ID,
    UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled', ...options.env };
  let sends = 0;
  const config = { env, store, routes, clock: () => NOW,
    async authorizePreparedAction({ request: saved, messageText, phase }) {
      authCalls.push(phase);
      if (options.onAuthorize) await options.onAuthorize({ phase, store, env });
      const result = { verified: true, sourceLinksVerified: true, holdsChecked: true, priorDeliveryChecked: true,
        checkedAt: NOW, expiresAt: NOW + 60000, sourceEventIds: ['source-1'],
        scope: { requestKey: saved.requestKey, candidateId: saved.candidateId,
          candidateEmail: saved.payload.candidate.email, occurrenceId: saved.occurrenceId,
          action: saved.action, recipientIds: saved.recipientIds, messageText } };
      return options.authorization ? options.authorization(result, phase) : result;
    },
    async readControl() { const c = await store.getControl(); return { ...c, verified: true, readAt: NOW, ...options.externalControl }; },
    async getCandidateThread(input) { return { ...input, verified: true, threadTs: options.newThread ? null : ROOT_TS,
      ownerRequestKey: request.requestKey, ...options.thread }; },
    async saveCandidateThread(input) { savedThreads.push(input); return { verified: true, threadTs: input.threadTs, ...options.savedThread }; },
    async fetchImpl(url, init) {
      const { method, args: body, type } = slackArguments(url, init);
      assert.equal(new URL(url).origin, 'https://slack.com');
      assert.equal(init.redirect, 'error');
      calls.push({ method, body, type });
      if (options.onCall) await options.onCall({ method, body, store, env });
      let result;
      if (method === 'auth.test') result = { ok: true, team_id: TEAM_ID, user_id: BOT_USER, bot_id: BOT_ID, ...options.identity };
      else if (method === 'bots.info') result = { ok: true, bot: { id: BOT_ID, user_id: BOT_USER, app_id: APP_ID, deleted: false, ...options.bot } };
      else if (method === 'conversations.info') {
        const route = Object.values(routes).find(r => r.channelId === body.channel);
        result = { ok: true, channel: { id: body.channel, is_im: route.type === 'im', is_mpim: route.type === 'mpim', ...options.channel } };
      } else if (method === 'conversations.members') {
        const key = Object.keys(routes).find(key => routes[key].channelId === body.channel);
        result = { ok: true, members: [...routeRecipients[key], BOT_USER], ...options.members };
      } else if (method === 'chat.postMessage') {
        sends++;
        if (options.postThrows) throw new Error('SECRET_SENTINEL');
        const ts = `1791926400.${String(sends).padStart(6, '0')}`;
        const message = { type: 'message', ts, user: BOT_USER, bot_id: BOT_ID, app_id: APP_ID,
          text: body.text, ...(body.thread_ts ? { thread_ts: body.thread_ts } : {}), ...options.readbackMessage };
        sentMessages.set(ts, message);
        result = { ok: true, channel: body.channel, ts, ...options.postResult };
      } else if (['conversations.history', 'conversations.replies'].includes(method)) {
        if (body.oldest === ROOT_TS) result = { ok: true, messages: [{ type: 'message', ts: ROOT_TS, text: 'Existing candidate context' }] };
        else result = { ok: true, messages: options.readbackMissing ? [] : [sentMessages.get(body.oldest)].filter(Boolean) };
      } else throw new Error(`Unexpected method ${method}`);
      return Response.json(result);
    },
  };
  Object.assign(config, options.dependencies);
  return { store, db, request, config, calls, authCalls, savedThreads, env,
    get sends() { return sends; }, dispatch: (claimToken = 'attempt-1') => createSlackDispatcher(config)({ requestKey: request.requestKey, claimToken }) };
}

test('missing trusted authority dependency blocks; a serialized approved flag cannot authorize', async () => {
  const f = await fixture({ dependencies: { authorizePreparedAction: undefined }, payload: { approved: true } });
  assert.equal((await f.dispatch()).reason, 'trusted_dependencies_missing');
  assert.equal(f.calls.length, 0);
  assert.equal((await f.store.getRequest(f.request.requestKey)).state, 'Pending');
});

test('Off and independent automatic-activity kill switch never call Slack', async () => {
  for (const options of [{ mode: 'Off' }, { env: { UNCLE_SAM_AUTOMATIC_ACTIVITY: undefined } }]) {
    const f = await fixture(options);
    assert.equal((await f.dispatch()).status, 'blocked');
    assert.equal(f.calls.length, 0); assert.equal(f.authCalls.length, 0);
  }
});

test('Test records only a fixture simulation, never Slack delivery, even with live-looking credentials', async () => {
  const f = await fixture({ mode: 'Test', env: { UNCLE_SAM_AUTOMATIC_ACTIVITY: undefined } });
  assert.deepEqual(await f.dispatch(), { status: 'simulated', delivered: false, requestKey: f.request.requestKey });
  assert.equal(f.calls.length, 0);
  const saved = await f.store.getRequest(f.request.requestKey);
  assert.equal(saved.state, 'Simulated'); assert.equal(saved.receipt.simulated, true);
  assert.equal(saved.receipt.result.delivered, false);
  const production = await fixture({ mode: 'Test', isFixture: false });
  assert.equal((await production.dispatch()).reason, 'fixture_required');
  assert.equal(production.calls.length, 0);
});

test('only bounded message kinds and candidate-specific Notion links render', async () => {
  assert.equal(SLACK_MESSAGE_KINDS.includes('email.interview_scheduling'), false);
  const f = await fixture();
  for (const action of SLACK_MESSAGE_KINDS) {
    const text = renderSlackMessage({ ...f.request, action });
    assert.ok(text.includes(candidate.fullName)); assert.ok(text.includes(candidate.url)); assert.ok(text.length < 2800);
  }
  assert.throws(() => renderSlackMessage({ ...f.request, action: 'chat.postMessage' }), /unsupported_message_kind/);
  assert.throws(() => renderSlackMessage({ ...f.request, payload: { ...f.request.payload,
    candidate: { ...candidate, url: 'https://app.notion.com/p/99999999999999999999999999999999' } } }), /candidate_link_mismatch/);
});

test('every message speaks in Uncle Sam\'s voice, keeps the decision words and fields verbatim, and uses only his own emojis', async () => {
  const f = await fixture();
  const said = action => renderSlackMessage({ ...f.request, action }).split('\n')[0];
  const name = candidate.fullName;
  const expected = {
    // To Robin: the take-home and the work trial are one tap (Project, Oct 19).
    'interview.feedback_request': `📣 I need your call on ${name} — Engineer / round 1: send the take-home, skip to a work trial, another interview, do not advance, hold, or it did not happen? Tap a button below or reply here.`,
    'interview.feedback_reminder': `📯 I still need your call on ${name} — Engineer / round 1. Tap a button below or report your interview feedback in this thread.`,
    'interview.next_step_request': `🫵 One more thing on ${name}: what is the next step, another interview, a take-home or a work trial? Tap one below and I'll take what I need to book it.`,
    'next_step.project': `📋 Next step for ${name}: Robin moved them on to a work trial Tue, Oct 20, 2026 to Fri, Oct 24, 2026; work: pricing model. Book it and start onboarding.`,
    'work_trial.packet_offer': `🪖 ${name} is confirmed for a work trial. Need ${name.split(' ')[0]}'s daily rate; reply here and I'll send out the invite.`,
    'noshow.choice': `📋 ${name} didn't show for the intro call. Send them Interviewer's link to pick a new time (from Project's Gmail, after his 30-minute Cancel), or withdraw them? Withdrawn is not a rejection: no rejection email goes out.`,
    'email.reschedule_pending': `📋 Interviewer asked to reschedule ${name} after a no-show. I'll email them Interviewer's link to pick a new time from your Gmail, at 12:31pm PT. Tap Cancel to stop it.`,
    'takehome.grading_request': `🫵 New take-home in: ${name} submitted Thu, Oct 15, 2026, portal score 83/100. I want YOU on it: three quick steps below, or reply here.`,
    'takehome.grading_reminder': `📯 ${name}'s take-home is still waiting on your call. Pick it up at step 1 below, or reply here.`,
    'email.deep_dive_pending': `📋 Interviewer said move ${name} to a take-home deep dive. I'll email them Interviewer's deep-dive link from your Gmail at 12:31pm PT. Tap Cancel to stop it.`,
    'rejection.confirmation_request': `📋 I need your word on this one: confirm ${name} is rejected and I should send the rejection from Project’s email after the 24-hour rule? Tap Confirm reject below.`,
    'onboarding.address_update': `📡 Update from headquarters: ${name}'s confirmed Company address is synthetic@company.example. Use it for the existing Okta request.`,
    'onboarding.ready_notice': `🫡 ${name} is ready to report for duty: onboarding is ready. All four signed; Jamie onboarding ready; AA Okta ready.`,
    'offboarding.reminder': `🎖️ Jamie: ${name}'s confirmed trial ended October 24, 2026. Time to muster them out: please offboard and explicitly confirm here when offboarding is complete.`,
    'offboarding.cancellation': `🛑 Jamie: stand down on ${name}'s trial setup, it is cancelled. Already completed: Documents sent; email setup pending. Please stop pending setup, offboard as needed, and explicitly confirm completion here.`,
    'failure.project': `🚨 Project, I need YOU on this one: ${name} needs attention. Candidate-agreed trial dates missing`,
    'payment.project': `💵 ${name}: a payment question for Project; I don't handle pay. Please review the agreed trial compensation.`,
  };
  for (const [action, text] of Object.entries(expected)) assert.equal(said(action), text, action);
  const details = `${name} — Engineer; personal email: ${candidate.email}; Company email: pending confirmation. Confirmed trial: October 20, 2026 to October 24, 2026 (America/Los_Angeles). Remote. Deadline: October 19, 2026 5pm PT. Instructions: Use agreed trial access only.`;
  assert.equal(said('onboarding.jamie'), `🪖 Jamie: a new recruit is reporting for a work trial. Please handle onboarding for ${details} Send NDA, CIIAA, Terms of Work, and the new work-trial agreement. Confirm documents sent, all four signed, and other required onboarding ready separately. Paperwork compensation: Agreed details in linked candidate record.`);
  assert.equal(said('onboarding.aa'), `🔐 AA: a new recruit needs Okta, and only Okta: ${details} Reply here when Okta is ready.`);
  for (const action of SLACK_MESSAGE_KINDS) {
    const text = renderSlackMessage({ ...f.request, action });
    assert.doesNotMatch(text, /!/, action); assert.equal((text.match(/\p{Extended_Pictographic}/gu) ?? []).filter(emoji => !['🫵', '🫡', '🪖', '🎖', '📋', '📣', '📯', '📡', '🔐', '🛑', '🚨', '💵'].includes(emoji)).length, 0, action);
    assert.ok(text.endsWith(`\n${candidate.url}`), action);
  }
});

test('verified delivery reuses candidate thread, disables broadcasts/unfurls, and persists readback receipt', async () => {
  const f = await fixture(); const result = await f.dispatch();
  assert.equal(result.status, 'sent'); assert.equal(f.sends, 1);
  assert.deepEqual(f.authCalls, ['prepare', 'before_send']);
  const post = f.calls.find(c => c.method === 'chat.postMessage');
  assert.equal(post.body.thread_ts, ROOT_TS); assert.equal(post.body.reply_broadcast, false);
  assert.equal(post.body.unfurl_links, false); assert.equal(post.body.unfurl_media, false);
  assert.equal(post.body.mrkdwn, false); assert.equal(post.body.parse, 'none');
  assert.equal(f.calls.at(-1).method, 'conversations.replies');
  assert.equal(f.savedThreads[0].verified, true);
  const saved = await f.store.getRequest(f.request.requestKey);
  assert.equal(saved.state, 'Sent'); assert.equal(saved.receipt.verified, true);
  assert.equal(saved.receipt.messageTs, '1791926400.000001');
  assert.deepEqual(saved.receipt.sourceEventIds, ['source-1']);
  assert.equal(saved.receipt.messageUrl, `https://example-workspace.slack.com/archives/${post.body.channel}/p1791926400000001`);
  assert.equal((await f.dispatch('retry')).reason, 'request_not_pending'); assert.equal(f.sends, 1);
});

test('Slack calls use the encoding each method really reads: a form for every check, JSON only for the post', async () => {
  const f = await fixture(); await f.dispatch();
  const checks = f.calls.filter(c => c.method !== 'chat.postMessage');
  assert.deepEqual([...new Set(checks.map(c => c.method))].sort(), ['auth.test', 'bots.info', 'conversations.history', 'conversations.info', 'conversations.members', 'conversations.replies']);
  assert.deepEqual([...new Set(checks.map(c => c.type))], ['application/x-www-form-urlencoded']);
  assert.equal(f.calls.find(c => c.method === 'chat.postMessage').type, 'application/json');
});

test('first candidate thread requires its exact durable owner and saves verified root before delivery receipt', async () => {
  const f = await fixture({ newThread: true });
  assert.equal((await f.dispatch()).status, 'sent');
  assert.equal(f.calls.find(c => c.method === 'chat.postMessage').body.thread_ts, undefined);
  assert.equal(f.savedThreads[0].threadTs, '1791926400.000001');
  assert.equal(f.savedThreads[0].previousThreadTs, null);
  const wrongOwner = await fixture({ newThread: true, thread: { ownerRequestKey: 'another-request' } });
  assert.equal((await wrongOwner.dispatch()).reason, 'candidate_thread_unverified');
  assert.equal(wrongOwner.calls.length, 0);
});

test('Jamie and AA remain separate exact-member groups; direct interviewer requests never include Project', async () => {
  for (const [action, routeKey] of [['onboarding.jamie', 'jamie_group'], ['onboarding.aa', 'aa_group'], ['interview.feedback_request', 'interviewer_rishi']]) {
    const f = await fixture({ action, routeKey });
    assert.equal((await f.dispatch()).status, 'sent');
    const saved = await f.store.getRequest(f.request.requestKey);
    assert.deepEqual(saved.receipt.recipientIds, [...routeRecipients[routeKey]].sort());
    if (routeKey === 'interviewer_rishi') assert.equal(saved.receipt.recipientIds.includes(people.project), false);
  }
  const merged = await fixture({ action: 'onboarding.jamie', routeKey: 'jamie_group',
    routes: { aa_group: { channelId: 'GROUTE0', type: 'mpim' } } });
  assert.equal((await merged.dispatch()).reason, 'owner_groups_must_be_separate'); assert.equal(merged.calls.length, 0);
});

test('missing route, wrong recipient set, wrong bot identity, shared conversation, and extra member all block', async () => {
  const cases = [
    [{ routes: { interviewer: null } }, 'route_not_configured'],
    [{ recipientIds: [people.project] }, 'recipient_scope_mismatch'],
    [{ identity: { team_id: 'TOTHER' } }, 'slack_identity_mismatch'],
    [{ identity: { user_id: people.project } }, 'slack_identity_mismatch'],
    [{ identity: { bot_id: 'BOTHER' } }, 'slack_identity_mismatch'],
    [{ bot: { app_id: 'AOTHER' } }, 'slack_app_identity_mismatch'],
    [{ channel: { is_ext_shared: true } }, 'slack_route_mismatch'],
    [{ members: { members: [people.interviewer, BOT_USER, people.project] } }, 'slack_members_mismatch'],
    [{ members: { response_metadata: { next_cursor: 'never-ending' } } }, 'slack_members_mismatch'],
  ];
  for (const [options, reason] of cases) {
    const f = await fixture(options);
    assert.equal((await f.dispatch()).reason, reason); assert.equal(f.sends, 0);
    assert.equal((await f.store.getRequest(f.request.requestKey)).state, 'Pending');
  }
});

test('authorization must match candidate, email, occurrence, rendered content, recipients, and fresh linked evidence', async () => {
  const amendments = [
    a => ({ ...a, verified: false }), a => ({ ...a, sourceLinksVerified: false }),
    a => ({ ...a, holdsChecked: false }), a => ({ ...a, priorDeliveryChecked: false }),
    a => ({ ...a, checkedAt: NOW - 60001 }), a => ({ ...a, expiresAt: NOW }),
    a => ({ ...a, sourceEventIds: [] }), a => ({ ...a, sourceEventIds: ['not-persisted'] }),
    a => ({ ...a, scope: { ...a.scope, candidateEmail: 'namesake@example.invalid' } }),
    a => ({ ...a, scope: { ...a.scope, occurrenceId: 'another-round' } }),
    a => ({ ...a, scope: { ...a.scope, messageText: 'arbitrary message' } }),
  ];
  for (const authorization of amendments) {
    const f = await fixture({ authorization });
    assert.equal((await f.dispatch()).status, 'blocked'); assert.equal(f.calls.length, 0);
  }
  const f = await fixture({ requestKey: 'policy-version-created-duplicate' });
  assert.equal((await f.dispatch()).reason, 'semantic_request_key_mismatch'); assert.equal(f.calls.length, 0);
});

test('Notion control mismatch, incomplete baseline, and old trigger fail before Slack', async () => {
  for (const externalControl of [{ mode: 'Off' }, { baselineComplete: false }, { activatedAt: NOW - 1 }, { readAt: NOW - 60001 }]) {
    const f = await fixture({ externalControl });
    assert.equal((await f.dispatch()).status, 'blocked'); assert.equal(f.calls.length, 0);
  }
  const historical = await fixture({ triggerAt: NOW - 1 });
  assert.equal((await historical.dispatch()).reason, 'live_gate_ineligible'); assert.equal(historical.calls.length, 0);
});

test('later hold after claim blocks immediately before post and retains a durable lock', async () => {
  const f = await fixture({ async onAuthorize({ phase, store }) {
    if (phase === 'before_send') await store.setActionHold({ holdKey: 'later-hold', candidateId: candidate.pageId,
      action: 'takehome.grading_request', reason: 'Wait', sourceEventId: 'source-1' });
  } });
  const result = await f.dispatch();
  assert.equal(result.status, 'blocked'); assert.equal(result.reason, 'dispatch_paused_or_stale'); assert.equal(f.sends, 0);
  assert.equal((await f.store.getRequest(f.request.requestKey)).state, 'Uncertain');
  assert.equal((await f.dispatch('retry')).reason, 'request_not_pending');
});

test('pause-and-resume after claim cannot reuse old reservation; automatic kill switch is rechecked', async () => {
  for (const change of ['pause_resume', 'kill_switch']) {
    const f = await fixture({ async onAuthorize({ phase, store, env }) {
      if (phase !== 'before_send') return;
      if (change === 'kill_switch') { env.UNCLE_SAM_AUTOMATIC_ACTIVITY = 'off'; return; }
      const c = await store.getControl(); const paused = await store.updateControl({ expectedVersion: c.version, mode: 'Off' });
      await store.updateControl({ expectedVersion: paused.control.version, mode: 'Live' });
    } });
    assert.equal((await f.dispatch()).status, 'blocked'); assert.equal(f.sends, 0);
    assert.equal((await f.store.getRequest(f.request.requestKey)).state, 'Uncertain');
  }
});

test('changed source authority during final recheck prevents send', async () => {
  const f = await fixture({ authorization: (a, phase) => phase === 'before_send' ? null : a });
  assert.equal((await f.dispatch()).reason, 'prepared_authorization_unverified');
  assert.equal(f.sends, 0); assert.equal((await f.store.getRequest(f.request.requestKey)).state, 'Uncertain');
});

test('source amendment events cannot themselves supply action authority', async () => {
  const f = await fixture({ authorization: a => ({ ...a, sourceEventIds: ['amendment-1'] }) });
  await f.store.recordEvent({ eventId: 'amendment-1', source: 'slack', type: 'source_amendment',
    occurredAt: NOW, isFixture: false, teamId: TEAM_ID, appId: APP_ID,
    channelId: 'DSOURCE', targetMessageTs: `${NOW / 1000}.000000`, amendmentKind: 'deleted' });
  assert.equal((await f.dispatch()).reason, 'source_evidence_unverified');
  assert.equal(f.calls.length, 0);
});

test('newly discovered authority sources are durably linked and amendments stop dispatch after claim', async () => {
  const secondTs = `${NOW / 1000}.123456`;
  const f = await fixture({
    authorization: (a, phase) => ({ ...a, sourceEventIds: phase === 'before_send' ? ['source-1', 'source-2'] : ['source-1'] }),
    async onAuthorize({ phase, store }) {
      if (phase === 'before_send') await store.recordEvent({ eventId: 'amendment-2', source: 'slack', type: 'source_amendment',
        occurredAt: NOW, isFixture: false, teamId: TEAM_ID, appId: APP_ID,
        channelId: 'DSOURCE', targetMessageTs: secondTs, amendmentKind: 'deleted' });
    },
  });
  await f.store.recordEvent({ eventId: 'source-2', source: 'slack', messageTs: secondTs,
    teamId: TEAM_ID, appId: APP_ID, channelId: 'DSOURCE', authorId: people.robin,
    text: 'Additional source authority', isFixture: false });
  assert.equal((await f.dispatch()).reason, 'dispatch_paused_or_stale'); assert.equal(f.sends, 0);
  const linked = f.db.sqlite.prepare('SELECT event_id FROM uncle_sam_request_events WHERE request_key = ? ORDER BY event_id').all(f.request.requestKey);
  assert.deepEqual(linked.map(row => row.event_id), ['source-1', 'source-2']);
  assert.equal((await f.store.getRequest(f.request.requestKey)).state, 'Uncertain');
});

test('actual repository thread reservation and CAS support verified first-send and later thread reuse', async () => {
  const f = await fixture({ newThread: true });
  f.config.getCandidateThread = input => f.store.reserveCandidateThread(input);
  f.config.saveCandidateThread = input => f.store.saveCandidateThread(input);
  assert.equal((await f.dispatch()).status, 'sent');
  const next = { ...f.request, occurrenceId: 'occurrence-2' };
  next.requestKey = requestKey(next);
  await f.store.ensureRequest({ ...next, sourceEventId: 'source-1' });
  assert.equal((await createSlackDispatcher(f.config)({ requestKey: next.requestKey, claimToken: 'second-send' })).status, 'sent');
  assert.equal(f.sends, 2);
  const posts = f.calls.filter(c => c.method === 'chat.postMessage');
  assert.equal(posts[0].body.thread_ts, undefined);
  assert.equal(posts[1].body.thread_ts, '1791926400.000001');
  const threads = f.db.sqlite.prepare('SELECT * FROM uncle_sam_candidate_threads').all();
  assert.equal(threads.length, 1); assert.equal(threads[0].thread_ts, '1791926400.000001');
});

test('concurrent workers cannot both post a durable semantic request', async () => {
  const f = await fixture();
  const results = await Promise.all([f.dispatch('worker-a'), f.dispatch('worker-b')]);
  assert.equal(results.filter(r => r.status === 'sent').length, 1); assert.equal(f.sends, 1);
});

test('timeout, bad acknowledgement, missing/mismatched readback and failed thread save never retry blindly', async () => {
  const cases = [ { postThrows: true }, { postResult: { channel: 'DOTHER' } }, { postResult: { ok: false } },
    { readbackMissing: true }, { readbackMessage: { text: 'Wrong candidate' } },
    { readbackMessage: { user: people.project } }, { readbackMessage: { app_id: 'AOTHER' } },
    { readbackMessage: { thread_ts: '1791920000.999999' } }, { savedThread: { verified: false } } ];
  for (const options of cases) {
    const f = await fixture(options); const result = await f.dispatch();
    assert.equal(result.status, 'uncertain'); assert.equal(result.locked, true);
    assert.equal(result.delivered, options.savedThread ? true : null);
    assert.equal(JSON.stringify(result).includes('SECRET_SENTINEL'), false);
    const saved = await f.store.getRequest(f.request.requestKey);
    assert.equal(saved.state, 'Uncertain'); assert.equal(saved.receipt, null);
    assert.equal((await f.dispatch('restart-retry')).reason, 'request_not_pending'); assert.equal(f.sends, 1);
  }
});

test('a pause racing after the network call cannot erase verified delivery or permit a second send', async () => {
  const f = await fixture({ async onCall({ method, store }) {
    if (method === 'chat.postMessage') {
      const c = await store.getControl(); await store.updateControl({ expectedVersion: c.version, mode: 'Off' });
    }
  } });
  assert.equal((await f.dispatch()).status, 'sent');
  assert.equal((await f.store.getControl()).mode, 'Off');
  assert.equal((await f.store.getRequest(f.request.requestKey)).state, 'Sent');
  assert.equal((await f.dispatch('retry')).reason, 'request_not_pending'); assert.equal(f.sends, 1);
});

test('Readback: Slack stores emoji as :shortcodes: and escapes &, so a delivered question still counts as delivered (River Collins, Oct 16)', async () => {
  const { sameSlackText } = await import('../service/lib/slack-dispatch.mjs');
  assert.equal(sameSlackText(':mega: I need your call on A &amp; B', '📣 I need your call on A & B'), true);
  assert.equal(sameSlackText(':saluting_face: Got it', '🫡 Got it'), true);
  assert.equal(sameSlackText(':mega: I need your call on A', '📣 I need your call on B'), false);
});

test('the feedback question names the expected next step and asks a line on why, not what to test (Project, 2026-10-16)', async () => {
  const f = await fixture();
  // Someone without the one-tap buttons (Alexis).
  const alexis = { ...f.request, recipientIds: ['U0476A5BC82'] };
  const tailored = renderSlackMessage({ ...alexis, action: 'interview.feedback_request', payload: { ...f.request.payload, likelyNext: 'take_home' } }).split('\n')[0];
  assert.match(tailored, /By the invite and the record, a take-home comes next\. If you advance, confirm it and give me a line on why they were good\.$/);
  assert.ok(!/should test/.test(tailored)); assert.ok(!tailored.includes('!'));
  const plain = renderSlackMessage({ ...alexis, action: 'interview.feedback_request', payload: { ...f.request.payload, likelyNext: 'offer' } }).split('\n')[0];
  assert.match(plain, /If advancing, tell me the next step \(another interview, a take-home or a work trial with dates\) and a line on why they were good\.$/);
});

test('A work-trial offer with no rate has no buttons (his reply in the thread is the answer); with a rate, Send / Send at a different rate', async () => {
  const f = await fixture();
  const noRate = { ...f.request, action: 'work_trial.packet_offer', payload: { ...f.request.payload, by: 'Robin' } };
  delete noRate.payload.rate;
  const blocks = renderSlackBlocks(noRate, renderSlackMessage(noRate));
  assert.equal(blocks.some(b => b.type === 'actions'), false);
  assert.match(blocks.at(-1).elements[0].text, /reply here with the rate/);
  assert.match(renderSlackMessage(noRate), /^🪖 Robin pushed .+ through to a work trial\. Need \S+'s daily rate; reply here and I'll send out the (invite|paperwork)\.\n/);
  const withRate = { ...noRate, payload: { ...noRate.payload, rate: 150 } };
  assert.deepEqual(renderSlackBlocks(withRate, renderSlackMessage(withRate)).find(b => b.type === 'actions').elements.map(e => e.action_id), ['wt_send', 'wt_rate']);
  const { rateModal, rateDoneModal, packetButtons } = await import('../service/lib/work-trial-offer.mjs');
  assert.equal(packetButtons('k', false), null);
  const key = `usam:v1:${'a'.repeat(64)}`;
  assert.match(JSON.stringify(rateModal({ requestKey: key, name: 'Jane Doe', invite: true })), /The invite asking for their dates says this/);
  assert.match(JSON.stringify(rateModal({ requestKey: key, name: 'Jane Doe' })), /the documents go out when you tap Send/);
  assert.match(JSON.stringify(rateDoneModal({ name: 'Jane Doe', rate: 100, invite: true })), /Sending Jane Doe the work trial invite at US\$100 per day/);
  assert.match(JSON.stringify(rateDoneModal({ name: 'Jane Doe', rate: 100 })), /the work trial documents at US\$100/);
});

test('Robin\'s and Interviewer\'s interview prompts: Send take-home and Skip to work trial; Skip asks for the dates, required (Project, Oct 19)', async () => {
  const { decisionButtons, feedbackModal, readSubmission, metaOf } = await import('../service/lib/feedback-form.mjs');
  const f = await fixture();
  const blocks = renderSlackBlocks({ ...f.request, action: 'interview.feedback_request', recipientIds: ['U0A4F08721B'] }, renderSlackMessage({ ...f.request, action: 'interview.feedback_request' }));
  const actions = blocks.find(b => b.type === 'actions');
  assert.deepEqual(actions.elements.map(e => [e.action_id, e.text.text]), [['fb_take_home', 'Send take-home'], ['fb_work_trial', 'Skip to work trial'], ['fb_advance', 'Another interview'],
    ['fb_do_not_advance', 'Do not advance'], ['fb_hold', 'Hold'], ['fb_did_not_happen', "Didn't happen"]]);
  const alexis = renderSlackBlocks({ ...f.request, action: 'interview.feedback_request', recipientIds: ['U0476A5BC82'] }, 'x\ny').find(b => b.type === 'actions');
  assert.equal(alexis.elements[0].action_id, 'fb_advance');
  assert.deepEqual(decisionButtons('k').elements.map(e => e.action_id), ['fb_advance', 'fb_do_not_advance', 'fb_hold', 'fb_did_not_happen']);
  // Skip to work trial: no next-step radio, the dates required, "why" optional.
  const meta = { requestKey: `usam:v1:${'a'.repeat(64)}`, decision: 'advance', nextStep: 'work_trial', shortcut: true };
  const modal = feedbackModal({ meta, candidateName: 'A B', roleRound: 'R1', who: 'U0A4F08721B' });
  assert.ok(!modal.blocks.some(b => b.block_id === 'next_step'));
  assert.equal(modal.blocks.find(b => b.block_id === 'trial_start').optional, false);
  const view = d => ({ private_metadata: JSON.stringify(meta), state: { values: { trial_start: { trial_start: { type: 'datepicker', selected_date: d.start ?? null } }, trial_end: { trial_end: { type: 'datepicker', selected_date: d.end ?? null } } } } });
  const m = metaOf(view({}));
  assert.equal(m.shortcut, true);
  const missing = readSubmission(view({}), m, { today: '2026-10-19' });
  assert.deepEqual(Object.keys(missing.errors).sort(), ['trial_end', 'trial_start']);
  const ok = readSubmission(view({ start: '2026-10-24', end: '2026-10-25' }), m, { today: '2026-10-19' });
  assert.deepEqual([ok.ok, ok.form.nextStep, ok.form.trialStart, ok.form.trialEnd], [true, 'work_trial', '2026-10-24', '2026-10-25']);
  // Send take-home: one tap, nothing required.
  const th = { ...meta, nextStep: 'take_home' };
  const sent = readSubmission({ private_metadata: JSON.stringify(th), state: { values: {} } }, metaOf({ private_metadata: JSON.stringify(th) }), { today: '2026-10-19' });
  assert.deepEqual([sent.ok, sent.form.nextStep], [true, 'take_home']);
});
