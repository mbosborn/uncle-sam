import { createGroupRoutes } from '../service/lib/group-routes.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { persistedFixture } from './support/d1.mjs';
import { createNotionClient, RECRUITING_SOURCE_ID, FEEDBACK_SOURCE_ID, GUIDES_SOURCE_ID, interviewRowOf } from '../service/lib/notion-client.mjs';
import { calendarSourceOf, INTERVIEW_LOG } from '../service/lib/runtime.mjs';
import { createSlackUi } from '../service/lib/slack-ui.mjs';
import { CONTROL_PAGE_ID, OPS_SOURCE_ID } from '../service/lib/notion-wake.mjs';
import { createSlackReader } from '../service/lib/slack-read.mjs';
import { createSlackDispatcher, renderSlackMessage } from '../service/lib/slack-dispatch.mjs';
import { promptPrecheck, INTERVIEW_STAGES } from '../service/lib/prompt-review.mjs';
import { createAgentRunner, createDispatcherDeps, validateProposal, gateReason, masonSummaryText, PEOPLE, MAX_MODEL_TURNS } from '../service/lib/agent-runner.mjs';
import { DEEP_DIVE_TEMPLATE_ID } from '../service/lib/takehome-review.mjs';
import * as NOSHOW from '../service/lib/no-show.mjs';
import { clerkInterviewKey, takersOf, bookingHints, interviewKind, interviewWhen } from '../service/lib/agent-runner.mjs';
import { handlePortalWebhook, handleNotionWebhook } from '../service/lib/webhooks.mjs';
import { requestKey } from '../src/policy.mjs';
import { slackArguments } from './support/slack-wire.mjs';

// Everything external is a local fake: Notion REST, Slack Web API, Google Calendar and the model.
// Real deployment migrations run in node:sqlite. No credentials, no network, no sends.
const NOW = Date.parse('2026-10-14T00:00:00Z');            // Tue 2026-10-13 17:00 PDT
const ACTIVATED = '2026-10-12T07:00:00.000Z';
const ROOT_TS = '1791920000.123456';
const BOT_USER = 'UUNCLESAM', BOT_ID = 'BUNCLESAM', TEAM_ID = 'T07011B7862', APP_ID = 'A09DDB3817C';
const NOTION_BOT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CANDIDATE_ID = '11111111-2222-4333-8444-555555555555';
const candidate = { pageId: CANDIDATE_ID, fullName: 'Synthetic Candidate', email: 'synthetic@example.invalid', emailVerified: true,
  url: `https://www.notion.so/Synthetic-Candidate-${CANDIDATE_ID.replaceAll('-', '')}` };
const routeRecipients = { jamie_group: [PEOPLE.project, PEOPLE.jamie], aa_group: [PEOPLE.project, PEOPLE.aa], project: [PEOPLE.project],
  interviewer: [PEOPLE.interviewer], interviewer_rishi: [PEOPLE.robin], interviewer_rithika: [PEOPLE.alexis], interviewer_aa: [PEOPLE.aa], interviewer_santosh: [PEOPLE.interviewer] };
const routeMap = Object.fromEntries(Object.entries(routeRecipients).map(([key, recipients], i) =>
  [key, { channelId: `${recipients.length === 2 ? 'G' : 'D'}ROUTE${i}`, type: recipients.length === 2 ? 'mpim' : 'im' }]));
const RISHI_DM = routeMap.interviewer_rishi.channelId;
const rt = text => ({ type: 'rich_text', rich_text: text ? [{ type: 'text', plain_text: text, text: { content: text } }] : [] });
const sel = name => ({ type: 'select', select: name ? { name } : null });
const options = names => ({ type: 'select', select: { options: names.map(name => ({ name })) } });

function controlPage({ mode = 'Live', baseline = true, activatedAt = ACTIVATED } = {}) {
  return { object: 'page', id: CONTROL_PAGE_ID, archived: false, properties: {
    'Record kind': sel('Control'), 'Request key': rt('uncle-sam:control'), Mode: sel(mode), State: sel('Ready'),
    'Baseline complete': { type: 'checkbox', checkbox: baseline }, 'Activated at': { type: 'date', date: activatedAt ? { start: activatedAt } : null },
    'Policy version': rt('2026-10-14.test'), 'Result evidence': rt('') } };
}
function candidatePage(overrides = {}) {
  return { object: 'page', id: CANDIDATE_ID, url: candidate.url, archived: false, last_edited_time: '2026-10-13T20:00:00.000Z',
    parent: { type: 'data_source_id', data_source_id: RECRUITING_SOURCE_ID }, properties: {
      Candidate: { type: 'title', title: [{ plain_text: 'Synthetic Candidate ⭐' }] }, Email: { type: 'email', email: candidate.email },
      Round: sel('R2 — Technical'), Outcome: sel('Proceeding'), 'Action Status': sel('Awaiting Feedback'), Stage: sel('Interview'),
      'Color mode': sel('Automatic'), 'Dot color': sel('Automatic'), 'Candidate brief': rt(''), 'Next action': rt(''),
      'Rejection email hold': { type: 'checkbox', checkbox: false }, ...overrides } };
}
const layout = { object: 'data_source', id: RECRUITING_SOURCE_ID, properties: {
  Candidate: { type: 'title' }, Email: { type: 'email' }, 'Candidate brief': { type: 'rich_text' }, 'Next action': { type: 'rich_text' },
  'Color mode': options(['Automatic', 'Manual override']),
  'Dot color': options(['Automatic', '🔴 Red', '🔵 Blue', '🟡 Yellow', '🟣 Purple', '🟢 Green', '⚪ Gray']),
  'Action Status': options(['Needs Project', 'Meeting Booked', 'Waiting on Candidate', 'On Trial', 'Awaiting Team Decision', 'Awaiting Feedback', 'On Hold', 'Complete']) } };

/** In-memory Notion REST + Slack Web API + Google Calendar behind one fetch. Records every call. */
function world({ control = {}, candidateOverrides = {}, calendarEvents = [], threads = {}, rooms = {} } = {}) {
  const pages = new Map([[CONTROL_PAGE_ID, controlPage(control)], [CANDIDATE_ID, candidatePage(candidateOverrides)]]);
  const groupOpens = [];
  const calls = [], slackCalls = [], sent = new Map(), portalCalls = [], portalReply = {};
  let created = 0;
  const textOf = p => (p?.rich_text ?? p?.title ?? []).map(x => x.plain_text ?? x.text?.content ?? '').join('');
  // The Operations filters the client sends: Request key, Record kind, Candidate relation and Event occurred at, alone or under "and".
  function opsMatch(p, f) {
    if (Array.isArray(f.and)) return f.and.every(clause => opsMatch(p, clause));
    const prop = p.properties[f.property];
    if (f.rich_text) return textOf(prop) === f.rich_text.equals;
    if (f.select) return (prop?.select?.name ?? null) === f.select.equals;
    if (f.relation) return (prop?.relation ?? []).some(r => r.id.replaceAll('-', '') === f.relation.contains.replaceAll('-', ''));
    if (f.date) { const start = prop?.date?.start; return !!start && Date.parse(start) >= Date.parse(f.date.on_or_after); }
    if (f.url) return !!prop?.url;
    return false;
  }
  function notion(method, path, body) {
    calls.push({ method, path, body });
    const m = path.match(/^\/pages\/([0-9a-f-]+)$/i);
    if (m && method === 'GET') { const page = pages.get(m[1].toLowerCase()); if (!page) return [404, { object: 'error' }]; return [200, page]; }
    if (m && method === 'PATCH') {
      const page = pages.get(m[1].toLowerCase()); if (!page) return [404, { object: 'error' }];
      for (const [name, value] of Object.entries(body.properties ?? {})) {
        if (value.rich_text) page.properties[name] = { type: 'rich_text', rich_text: value.rich_text.map(x => ({ ...x, plain_text: x.text.content })) };
        else if ('select' in value) page.properties[name] = sel(value.select?.name ?? null);
        else if (value.title) page.properties[name] = { type: 'title', title: value.title.map(x => ({ ...x, plain_text: x.text.content })) };
        else page.properties[name] = { type: Object.keys(value)[0], ...value };
      }
      return [200, page];
    }
    if (path === '/pages' && method === 'POST') {
      const id = `0000000${++created}-0000-4000-8000-00000000000${created}`.slice(-36);
      const page = { object: 'page', id, url: `https://www.notion.so/${id.replaceAll('-', '')}`, archived: false, parent: body.parent, properties: {} };
      pages.set(id, page);
      return notion('PATCH', `/pages/${id}`, body);
    }
    if (path === `/data_sources/${RECRUITING_SOURCE_ID}` && method === 'GET') return [200, layout];
    const q = path.match(/^\/data_sources\/([0-9a-f-]+)\/query$/i);
    if (q && method === 'POST') {
      const f = body.filter ?? {};
      const results = [...pages.values()].filter(p => {
        if (q[1] === RECRUITING_SOURCE_ID) {
          if (p.parent?.data_source_id !== RECRUITING_SOURCE_ID) return false;
          if (f.property === 'Email') return p.properties.Email?.email === f.email.equals;
          if (f.property === 'Candidate') return textOf(p.properties.Candidate).includes(f.title.contains);
          if (f.property === 'LinkedIn') return String(p.properties.LinkedIn?.url ?? '').toLowerCase().includes(String(f.url.contains).toLowerCase());
        }
        if ([OPS_SOURCE_ID, FEEDBACK_SOURCE_ID, GUIDES_SOURCE_ID].includes(q[1])) return p.parent?.data_source_id === q[1] && opsMatch(p, f);
        return false;
      });
      return [200, { object: 'list', results, has_more: false }];
    }
    if (/^\/blocks\/[0-9a-f-]+\/children$/i.test(path) && method === 'PATCH') return [200, { object: 'list', results: [{ object: 'block', id: 'bbbbbbbb-0000-4000-8000-000000000001' }] }];
    if (path === '/users/me') return [200, { object: 'user', id: NOTION_BOT, type: 'bot', name: 'Uncle Sam' }];
    return [404, { object: 'error', code: 'not_found' }];
  }
  function slack(method, body) {
    slackCalls.push({ method, body });
    if (method === 'auth.test') return { ok: true, team_id: TEAM_ID, user_id: BOT_USER, bot_id: BOT_ID };
    if (method === 'bots.info') return { ok: true, bot: { id: BOT_ID, user_id: BOT_USER, app_id: APP_ID, deleted: false } };
    if (method === 'conversations.open') { groupOpens.push(body.users); return { ok: true, channel: { id: `GGRP${groupOpens.length}XXXXXX` } }; }
    if (method === 'conversations.info') { const route = Object.values(routeMap).find(r => r.channelId === body.channel); const group = /^GGRP/.test(body.channel);
      return { ok: true, channel: { id: body.channel, is_im: route?.type === 'im', is_mpim: group || route?.type === 'mpim' } }; }
    if (method === 'conversations.members') { if (/^GGRP/.test(body.channel)) return { ok: true, members: [...String(groupOpens[Number(body.channel.slice(4, -6)) - 1]).split(','), BOT_USER] };
      const key = Object.keys(routeMap).find(k => routeMap[k].channelId === body.channel); return { ok: true, members: [...routeRecipients[key], BOT_USER] }; }
    if (method === 'chat.postMessage') {
      const ts = `1791926400.${String(sent.size + 1).padStart(6, '0')}`;
      const message = { type: 'message', ts, user: BOT_USER, bot_id: BOT_ID, app_id: APP_ID, text: body.text, ...(body.thread_ts ? { thread_ts: body.thread_ts } : {}) };
      sent.set(ts, message); (threads[body.thread_ts ?? ts] ??= []).push(message);
      return { ok: true, channel: body.channel, ts };
    }
    if (method === 'chat.update') return { ok: true, channel: body.channel, ts: body.ts };
    if (method === 'conversations.replies' && body.ts && !body.oldest) return { ok: true, messages: threads[body.ts] ?? [] };
    if (method === 'conversations.history' && body.channel in rooms) {
      if (rooms[body.channel] === 'error') return { ok: false, error: 'not_in_channel' };
      return { ok: true, messages: rooms[body.channel] };
    }
    if (['conversations.history', 'conversations.replies'].includes(method)) {
      if (body.oldest === ROOT_TS) return { ok: true, messages: [{ type: 'message', ts: ROOT_TS, user: BOT_USER, bot_id: BOT_ID, app_id: APP_ID, text: 'Existing prompt' }] };
      return { ok: true, messages: [sent.get(body.oldest)].filter(Boolean) };
    }
    throw new Error(`Unexpected Slack method ${method}`);
  }
  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    assert.equal(init.redirect, 'error');
    if (u.origin === 'https://api.notion.com') {
      assert.equal(init.headers['notion-version'], '2025-09-03');
      const [status, payload] = notion(init.method ?? 'GET', u.pathname.replace('/v1', ''), init.body ? JSON.parse(init.body) : undefined);
      return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
    }
    if (u.origin === 'https://slack.com') { const { method, args } = slackArguments(url, init); return Response.json(slack(method, args)); }
    if (u.origin === 'https://company-takehome.vercel.app') {
      portalCalls.push({ url, auth: init.headers?.authorization, body: JSON.parse(init.body) });
      if (portalReply.fail) return new Response('{}', { status: portalReply.fail });
      return Response.json({ url: `https://company-takehome.vercel.app/c/vth_fixture${portalCalls.length}` });
    }
    throw new Error(`Unexpected origin ${u.origin}`);
  }
  const calendar = { async listEvents() { return calendarEvents; } };
  return { pages, calls, slackCalls, sent, threads, fetchImpl, calendar, portalCalls, portalReply, groupOpens,
    patches: () => calls.filter(c => c.method === 'PATCH' && c.path === `/pages/${CANDIDATE_ID}`),
    operationsCreated: () => calls.filter(c => c.method === 'POST' && c.path === '/pages' && c.body.parent?.data_source_id === OPS_SOURCE_ID) };
}

function scriptedClaude(script, log = []) {
  return { model: 'fake', async complete({ messages, tools, toolChoice }) {
    log.push({ messages: messages.length, tools: tools.length, toolChoice, snapshot: JSON.parse(JSON.stringify(messages)) });
    const next = script.shift();
    if (!next) throw new Error('model script exhausted');
    // A step that is an object (not a list of tool calls) is a reply made of exactly these content blocks, e.g. text with no tool call.
    if (!Array.isArray(next)) return { id: `msg_${log.length}`, model: 'fake', stopReason: next.stopReason ?? 'end_turn', content: next.content, usage: { input: 100, output: 20 } };
    const content = next.map((call, i) => ({ type: 'tool_use', id: `tu_${log.length}_${i}`, name: call.name, input: call.input }));
    return { id: `msg_${log.length}`, model: 'fake', stopReason: 'tool_use', content, usage: { input: 100, output: 20 } };
  } };
}

async function harness({ world: w, mode = 'Live', script = [], clockRef = { now: NOW }, calendarIds = [], calendarFloor = null, env: extraEnv = {}, fromLog = false, gmail = null, takeHomePlanOf = null, interviewerEmails = null, assignmentsOf = null, groups = false, meet = null, packets = null } = {}) {
  const fixture = persistedFixture(NOW);
  const clock = () => clockRef.now;
  const { createStore } = await import('../service/lib/store.mjs');
  const store = createStore(fixture.db, { authorized: true, clock });
  const env = { UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled', NOTION_TOKEN: 'ntn_synthetic_fixture_token', SLACK_BOT_TOKEN: 'xoxb-fixture-only',
    SLACK_BOT_USER_ID: BOT_USER, SLACK_BOT_ID: BOT_ID, ...extraEnv };
  if (env.DB === 'fixture') env.DB = fixture.db;
  const notion = createNotionClient({ env, fetchImpl: w.fetchImpl, clock });
  const slackRead = createSlackReader({ env, fetchImpl: w.fetchImpl });
  const groupRoutes = groups ? createGroupRoutes({ db: fixture.db, env, fetchImpl: w.fetchImpl, clock }) : null;
  const deps = createDispatcherDeps({ store, notion, slackRead, routeMap, groupRoutes, clock });
  const dispatcher = createSlackDispatcher({ env, store, routes: routeMap, ...deps, groupRoutes: groupRoutes?.routes ?? null, fetchImpl: w.fetchImpl, clock });
  const modelLog = [];
  const claude = scriptedClaude(script, modelLog);
  if (fromLog) calendarIds = [INTERVIEW_LOG];
  const calendar = fromLog ? { listEvents: ({ timeMin }) => notion.listInterviewRows({ since: timeMin }) } : calendarIds.length ? w.calendar : null;
  const ui = createSlackUi({ env, fetchImpl: w.fetchImpl });
  const runner = createAgentRunner({ env, store, claude, notion, slackRead, dispatcher, routeMap, ui, gmail, takeHomePlanOf, fetchImpl: w.fetchImpl, calendar, calendarIds, calendarFloor,
    interviewerEmails: interviewerEmails ?? { 'robin@company.example': PEOPLE.robin, 'alexis@company.example': PEOPLE.alexis }, assignmentsOf, groupRoutes, meet, packets, clock, randomUUID: (() => { let n = 0; return () => `attempt-${++n}`; })() });
  return { store, notion, runner, dispatcher, env, modelLog, sqlite: fixture.sqlite, clock };
}

const slackEvent = (eventId, { authorId = PEOPLE.robin, channelId = RISHI_DM, text, ts = '1791926460.000100', threadTs = ROOT_TS, isFixture = false } = {}) =>
  ({ eventId, source: 'slack', appId: APP_ID, teamId: TEAM_ID, type: 'message', channelId, channelType: 'im', authorId, messageTs: ts, threadTs, text, isFixture });

/** A verified, Sent feedback prompt to Robin with a bound candidate thread (what the calendar tick would have produced). */
async function seedSentPrompt(h, { occurrenceId = 'cal:ical-1' } = {}) {
  const local = await h.runner.syncControl();
  const key = requestKey({ candidate, occurrenceId, action: 'interview.feedback_request', recipientIds: [PEOPLE.robin] });
  await h.store.recordEvent({ eventId: 'calendar:evt1:v1', source: 'calendar', occurredAt: NOW - 3600_000, payload: { type: 'calendar_event' }, isFixture: false });
  await h.store.ensureRequest({ requestKey: key, candidateId: candidate.pageId, occurrenceId, action: 'interview.feedback_request', recipientIds: [PEOPLE.robin],
    payload: { routeKey: 'interviewer_rishi', roleRound: 'R2 — Technical', candidate, scheduleKey: 'sk1', sourceUrl: 'https://calendar.google.com/event?eid=1' },
    triggerAt: NOW - 1800_000, sourceEventId: 'calendar:evt1:v1' });
  const claim = await h.store.claimRequest({ requestKey: key, claimToken: 'seed', expectedControlVersion: local.local.version, expectedPauseGeneration: local.local.pauseGeneration });
  assert.equal(claim.claimed, true);
  const thread = await h.store.reserveCandidateThread({ requestKey: key, candidateId: candidate.pageId, routeKey: 'interviewer_rishi', channelId: RISHI_DM });
  assert.equal(thread.verified, true);
  const saved = await h.store.saveCandidateThread({ requestKey: key, candidateId: candidate.pageId, routeKey: 'interviewer_rishi', channelId: RISHI_DM,
    ownerRequestKey: key, previousThreadTs: null, threadTs: ROOT_TS, verified: true });
  assert.equal(saved.verified, true);
  await h.store.completeRequest({ requestKey: key, claimToken: 'seed', state: 'Sent', receipt: { verified: true, resultId: `${RISHI_DM}:${ROOT_TS}`,
    channelId: RISHI_DM, messageTs: ROOT_TS, threadTs: ROOT_TS, messageUrl: `https://example-workspace.slack.com/archives/${RISHI_DM}/p1791920000123456`, verifiedAt: NOW - 1700_000, text: 'Existing prompt' } });
  return key;
}

test('validateProposal enforces kinds, authority and bullet shape without touching any adapter', () => {
  const ctx = { author: { id: PEOPLE.jamie }, candidate: { pageId: CANDIDATE_ID }, thread: { interviewerId: PEOPLE.robin } };
  assert.equal(validateProposal({ kind: 'record_feedback', candidatePageId: CANDIDATE_ID, decision: 'advance', briefBullets: ['Status: x', 'Assessment: y', 'Open items: z'], nextAction: 'Project to schedule R3' }, ctx).reason, 'author_not_interviewer');
  const robin = { ...ctx, author: { id: PEOPLE.robin } };
  assert.equal(validateProposal({ kind: 'record_feedback', candidatePageId: CANDIDATE_ID, decision: 'advance', briefBullets: ['no label here', 'Assessment: y', 'Open items: z'], nextAction: 'x' }, robin).reason, 'brief_bullets_invalid');
  assert.equal(validateProposal({ kind: 'record_feedback', candidatePageId: '99999999-2222-4333-8444-555555555555', decision: 'advance', briefBullets: ['Status: x', 'Assessment: y', 'Open items: z'], nextAction: 'x' }, robin).reason, 'feedback_requires_bound_thread_candidate');
  const ok = validateProposal({ kind: 'record_feedback', candidatePageId: CANDIDATE_ID.toUpperCase(), decision: 'advance', briefBullets: ['Status: x', 'Assessment: y', 'Open items: z'], nextAction: 'Project to schedule R3' }, robin);
  assert.equal(ok.ok, true); assert.equal(ok.proposal.candidatePageId, CANDIDATE_ID);
  assert.equal(validateProposal({ kind: 'hold', candidatePageId: CANDIDATE_ID, action: 'interview.feedback_request', reason: 'pause' }, ctx).reason, 'author_cannot_hold');
  assert.equal(validateProposal({ kind: 'hold', candidatePageId: CANDIDATE_ID, action: 'payment.project', reason: 'pause' }, robin).reason, 'hold_action_invalid');
  assert.equal(validateProposal({ kind: 'request_rejection_confirmation', candidatePageId: CANDIDATE_ID }, ctx).reason, 'author_lacks_final_authority');
  assert.equal(validateProposal({ kind: 'send_email' }, robin).reason, 'unknown_proposal_kind');
  assert.equal(validateProposal({ kind: 'notify_mason', blocker: 'x' }, robin).reason, 'candidate_required');
  assert.deepEqual(validateProposal({ kind: 'no_action', reason: 'chit <chat>' }, ctx).proposal, { kind: 'no_action', reason: 'chit chat' });
});

test('Project, Oct 15: a numbered summary for Project reads as a list behind medals; anything else stays one line', () => {
  assert.equal(masonSummaryText('Open items for Project: (1) Nick Hollon has no email on record; (2) Reagan Turner (Mercor): verify email and set trial dates. (3) Marjan payment in progress.'),
    'Open items for Project:\n🎖️ Nick Hollon has no email on record\n🎖️ Reagan Turner (Mercor): verify email and set trial dates.\n🎖️ Marjan payment in progress.');
  assert.equal(masonSummaryText('Two Reagan Turner records exist.'), '📋 Two Reagan Turner records exist.');
  assert.equal(masonSummaryText(''), '📋 I need you to look at this one.');
});

test('gateReason mirrors the SQL claim eligibility and marks permanent denials', () => {
  const live = { mode: 'Live', baselineComplete: true, activatedAt: NOW - 1000 };
  assert.deepEqual(gateReason({ mode: 'Off' }, { isFixture: false, occurredAt: NOW }), { reason: 'mode_off', terminal: false });
  assert.deepEqual(gateReason({ mode: 'Test' }, { isFixture: false, occurredAt: NOW }), { reason: 'fixture_required', terminal: true });
  assert.equal(gateReason({ mode: 'Test' }, { isFixture: true, occurredAt: NOW }), null);
  assert.deepEqual(gateReason(live, { isFixture: true, occurredAt: NOW }), { reason: 'fixture_not_live', terminal: true });
  assert.deepEqual(gateReason({ mode: 'Live', baselineComplete: false, activatedAt: null }, { isFixture: false, occurredAt: NOW }), { reason: 'baseline_incomplete', terminal: false });
  assert.deepEqual(gateReason(live, { isFixture: false, occurredAt: NOW - 5000 }), { reason: 'before_activation', terminal: true });
  assert.equal(gateReason(live, { isFixture: false, occurredAt: NOW }), null);
});

test('kill switch off: nothing is read from Notion or the model and the event stays Observed', async () => {
  const w = world();
  const h = await harness({ world: w, env: { UNCLE_SAM_AUTOMATIC_ACTIVITY: 'off' } });
  await h.store.recordEvent(slackEvent('Ev-off', { text: 'Advance' }));
  assert.deepEqual(await h.runner.runEvent({ eventId: 'Ev-off', attemptId: 'a1' }), { status: 'blocked', reason: 'automatic_activity_off' });
  assert.equal(w.calls.length, 0); assert.equal(h.modelLog.length, 0);
  assert.equal((await h.store.getEvent('Ev-off')).status, 'Observed');
  assert.equal((await h.runner.runTick()).reason, 'automatic_activity_off');
});

test('Notion control Off is mirrored into D1 and blocks without consulting the model', async () => {
  const w = world({ control: { mode: 'Off', baseline: false, activatedAt: null } });
  const h = await harness({ world: w });
  await h.store.recordEvent(slackEvent('Ev-1', { text: 'Advance' }));
  const result = await h.runner.runEvent({ eventId: 'Ev-1', attemptId: 'a1' });
  assert.deepEqual(result, { status: 'blocked', reason: 'mode_off' });
  assert.equal((await h.store.getControl()).mode, 'Off');
  assert.equal(h.modelLog.length, 0);
  assert.equal((await h.store.getEvent('Ev-1')).status, 'Observed');
});

test('Test mode ignores real events permanently; a fixture event is processed as a dry run with no Notion writes', async () => {
  const w = world({ control: { mode: 'Test', baseline: false, activatedAt: null } });
  const h = await harness({ world: w, script: [[{ name: 'propose', input: { kind: 'needs_attention', summary: 'Fixture review' } }]] });
  await h.store.recordEvent(slackEvent('Ev-real', { text: 'Advance' }));
  assert.deepEqual(await h.runner.runEvent({ eventId: 'Ev-real', attemptId: 'a1' }), { status: 'ignored', reason: 'fixture_required' });
  assert.equal((await h.store.getEvent('Ev-real')).status, 'Ignored');
  await h.store.recordEvent(slackEvent('Ev-fix', { text: 'Fixture message', isFixture: true }));
  const result = await h.runner.runEvent({ eventId: 'Ev-fix', attemptId: 'a2' });
  assert.equal(result.status, 'processed'); assert.equal(result.outcome, 'needs_attention');
  assert.equal(result.receipt.outcome.dryRun, true);
  assert.equal(h.modelLog.length, 1);
  assert.equal(w.operationsCreated().length, 0); assert.equal(w.patches().length, 0);
  const event = await h.store.getEvent('Ev-fix');
  assert.equal(event.status, 'Processed'); assert.equal(event.wakeState, 'Complete');
});

test('Live: the interviewer\'s reply in the bound thread records feedback through the guarded Notion plan, closes the prompt, and asks for an unstated next step', async () => {
  const w = world();
  const bullets = ['Status: R2 completed 2026-10-13; Robin recommends advancing', 'Assessment: strong systems depth, clear communication',
    'Latest evidence: Slack reply 2026-10-13', 'Open items: schedule R3 (case study)'];
  const h = await harness({ world: w, script: [
    [{ name: 'read_candidate_page', input: { pageId: CANDIDATE_ID } }],
    [{ name: 'propose', input: { kind: 'record_feedback', candidatePageId: CANDIDATE_ID, decision: 'advance', briefBullets: bullets,
      nextAction: 'Project to schedule R3 case study with Alexis this week', evidence: 'Advance — strong systems depth, clear communication.' } }],
  ] });
  const promptKey = await seedSentPrompt(h);
  w.threads[ROOT_TS] = [{ type: 'message', ts: ROOT_TS, user: BOT_USER, bot_id: BOT_ID, text: 'Existing prompt' },
    { type: 'message', ts: '1791926460.000100', user: PEOPLE.robin, text: 'Advance — strong systems depth, clear communication.' }];
  await h.store.recordEvent(slackEvent('Ev-fb', { text: 'Advance — strong systems depth, clear communication. Next round should test ML infra ownership.' }));
  const result = await h.runner.runEvent({ eventId: 'Ev-fb', attemptId: 'a1' });
  assert.equal(result.status, 'processed', JSON.stringify(result));
  assert.equal(result.outcome, 'record_feedback');
  assert.deepEqual(result.sideEffects, ['candidate_patch', 'candidate_note', 'request:created', 'slack:sent']);
  const patch = w.patches();
  assert.equal(patch.length, 1);
  assert.deepEqual(Object.keys(patch[0].body.properties).sort(), ['Action Status', 'Candidate brief', 'Next action']);
  assert.equal(patch[0].body.properties['Action Status'].select.name, 'Needs Project');
  assert.equal(patch[0].body.properties['Candidate brief'].rich_text[0].text.content, bullets.join('\n'));
  assert.ok(w.calls.some(c => c.method === 'PATCH' && c.path === `/blocks/${CANDIDATE_ID}/children`), 'append-only note written');
  const ops = w.operationsCreated();
  assert.equal(ops.length, 3, 'feedback receipt + mirrored prompt request + the next-step question');
  assert.ok(ops.every(c => c.body.properties.Candidate.relation[0].id === CANDIDATE_ID));
  const prompt = await h.store.getRequest(promptKey);
  assert.equal(prompt.state, 'Complete'); assert.equal(prompt.receipt.reply.decision, 'advance'); assert.equal(prompt.receipt.resultId, `${RISHI_DM}:${ROOT_TS}`);
  // "Advance" without saying which next step: one question back to the interviewer, in the same thread, with the next-step buttons.
  const asked = w.slackCalls.filter(c => c.method === 'chat.postMessage');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].body.channel, RISHI_DM); assert.equal(asked[0].body.thread_ts, ROOT_TS);
  assert.match(asked[0].body.text, /^🫵 One more thing on Synthetic Candidate: what is the next step, another interview, a take-home or a work trial\?/);
  const buttons = asked[0].body.blocks.find(b => b.type === 'actions').elements;
  assert.deepEqual(buttons.map(b => b.action_id), ['ns_interview', 'ns_take_home', 'ns_work_trial']);
  const question = (await h.store.listRequestsForCandidate({ candidateId: CANDIDATE_ID })).find(r => r.action === 'interview.next_step_request');
  assert.ok(buttons.every(b => b.value === question.requestKey)); assert.equal(question.payload.missing, 'next_step');
  const event = await h.store.getEvent('Ev-fb');
  assert.equal(event.status, 'Processed'); assert.equal(event.receipt.model.turns, 2);
  assert.ok(h.modelLog.length > 0 && h.modelLog.every(call => call.toolChoice?.type === 'auto'),
    'every model call lets the model choose its tools: claude-sonnet-5-5 rejects a forced "any" or named tool with HTTP 400');
});

test('Live: a non-interviewer cannot record feedback; the rejected proposal degrades to a Needs attention row', async () => {
  const w = world();
  const h = await harness({ world: w, script: [
    [{ name: 'propose', input: { kind: 'record_feedback', candidatePageId: CANDIDATE_ID, decision: 'advance', briefBullets: ['Status: a', 'Assessment: b', 'Open items: c'], nextAction: 'x' } }],
    [{ name: 'propose', input: { kind: 'needs_attention', summary: 'Jamie replied in the interviewer thread with a decision; needs Project review', candidatePageId: CANDIDATE_ID } }],
  ] });
  await seedSentPrompt(h);
  await h.store.recordEvent(slackEvent('Ev-jamie', { authorId: PEOPLE.jamie, text: 'Advance her please' }));
  const result = await h.runner.runEvent({ eventId: 'Ev-jamie', attemptId: 'a1' });
  assert.equal(result.status, 'processed'); assert.equal(result.outcome, 'needs_attention');
  assert.equal(w.patches().length, 0);
  assert.equal(w.operationsCreated().length, 1);
  assert.equal(w.operationsCreated()[0].body.properties.State.select.name, 'Needs attention');
  assert.deepEqual((await h.store.getEvent('Ev-jamie')).receipt.model.transcript[0], { tool: 'propose', rejected: 'author_not_interviewer' });
});

test('Live: model failure releases the claim with no side effects; the tick retries, then parks it after six hours', async () => {
  const w = world();
  const clockRef = { now: NOW };
  const h = await harness({ world: w, script: [], clockRef });
  await h.store.recordEvent(slackEvent('Ev-fail', { text: 'hello' }));
  const first = await h.runner.runEvent({ eventId: 'Ev-fail', attemptId: 'a1' });
  assert.equal(first.status, 'blocked'); assert.equal(first.released, true);
  let event = await h.store.getEvent('Ev-fail');
  assert.equal(event.status, 'Observed'); assert.equal(event.wakeState, 'Pending'); assert.ok(event.wakeError);
  assert.equal(w.patches().length, 0); assert.equal(w.operationsCreated().length, 0);
  // Within the retry window the tick tries again (and fails again without side effects).
  clockRef.now = NOW + 600_000;
  const retry = await h.runner.runTick({ now: clockRef.now });
  assert.deepEqual(retry.summary.events.map(e => e.status), ['blocked']);
  assert.equal((await h.store.getEvent('Ev-fail')).status, 'Observed');
  // After six hours the event is parked as NeedsAttention with a visible Operations row, and never retried.
  clockRef.now = NOW + 7 * 3600_000;
  const parked = await h.runner.runTick({ now: clockRef.now });
  assert.equal(parked.summary.swept, 1);
  event = await h.store.getEvent('Ev-fail');
  assert.equal(event.status, 'NeedsAttention'); assert.equal(event.receipt.reason, 'retries_exhausted');
  assert.equal(w.operationsCreated().length, 1);
  assert.equal(w.operationsCreated()[0].body.properties.Action.rich_text[0].text.content, 'event_processing_failed');
  assert.equal(h.modelLog.length, 2, 'model consulted once per attempt only');
});

test('Live: calendar-driven prompt is created and sent once, then the next-business-day reminder follows', async () => {
  const clockRef = { now: NOW };
  const calendarEvents = [{ id: 'evt1', iCalUID: 'ical-1', calendarId: 'robin@company.example', summary: 'Company x Synthetic — R2', status: 'confirmed',
    start: new Date(NOW - 3600_000).toISOString(), end: new Date(NOW - 1200_000).toISOString(), allDay: false, updated: '2026-10-13T10:00:00.000Z',
    htmlLink: 'https://calendar.google.com/calendar/event?eid=evt1',
    attendees: [{ email: 'robin@company.example' }, { email: 'synthetic@example.invalid' }, { email: 'project@company.example' }] }];
  const w = world({ calendarEvents });
  const h = await harness({ world: w, clockRef, calendarIds: ['robin@company.example'], calendarFloor: NOW - 3 * 3600_000, script: [review('send'), review('send')] });
  const tick = await h.runner.runTick({ now: clockRef.now });
  assert.equal(tick.status, 'ok', JSON.stringify(tick));
  assert.equal(tick.summary.prompts.length, 1);
  assert.equal(tick.summary.prompts[0].action, 'prompt_interviewer');
  assert.equal(tick.summary.prompts[0].dispatch, 'sent');
  const posts = w.slackCalls.filter(c => c.method === 'chat.postMessage');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.channel, RISHI_DM);
  assert.equal(posts[0].body.text, renderSlackMessage({ action: 'interview.feedback_request', candidateId: CANDIDATE_ID, recipientIds: ['U0A4F08721B'],
    payload: { candidate, roleRound: 'R2 — Technical · Tue, Oct 13, 4:00 PM PT' } }));
  const promptKey = tick.summary.prompts[0].requestKey;
  const prompt = await h.store.getRequest(promptKey);
  assert.equal(prompt.state, 'Sent'); assert.equal(prompt.isFixture, false);
  assert.deepEqual(await h.store.listRequestEvents(promptKey), ['calendar:evt1:2026-10-13T10:00:00.000Z']);
  assert.ok(w.operationsCreated().some(c => c.body.properties['Request key'].rich_text[0].text.content === promptKey), 'request mirrored to Operations');
  assert.ok(w.calls.some(c => c.method === 'PATCH' && c.path === `/pages/${CONTROL_PAGE_ID}`), 'heartbeat written');
  // Idempotent: a second tick 10 minutes later neither re-prompts nor reminds.
  clockRef.now = NOW + 600_000;
  const second = await h.runner.runTick({ now: clockRef.now });
  assert.equal(second.summary.prompts[0].reason, 'feedback_reminder_not_due');
  assert.equal(w.slackCalls.filter(c => c.method === 'chat.postMessage').length, 1);
  // Uncle Sam keeps the interview log itself now (Project, Oct 15), with the clerk's key and shape, once.
  const logged = opsRows(w, 'interview.logged');
  assert.equal(logged.length, 1); assert.equal(tick.summary.interviewsLogged, 1); assert.equal(second.summary.interviewsLogged, 0);
  const lp = logged[0].properties, txt = name => (lp[name].rich_text ?? lp[name].title ?? []).map(x => x.plain_text).join('');
  assert.equal(lp['Record kind'].select.name, 'Interview');
  assert.equal(txt('Source event key'), `${CANDIDATE_ID}:${new Date(Math.round((NOW - 1200_000) / 3600_000) * 3600_000).toISOString().replace('.000Z', 'Z')}`);
  assert.equal(txt('Name'), 'Interview · Synthetic Candidate · Company x Synthetic — R2');
  assert.equal(txt('Recipient Slack user IDs'), PEOPLE.robin);
  // Next business day at the same Los Angeles wall time (Wed 2026-10-14 17:00 PDT = 2026-10-15T00:00Z).
  clockRef.now = Date.parse('2026-10-15T00:00:05Z');
  const third = await h.runner.runTick({ now: clockRef.now });
  assert.equal(third.summary.prompts[0].action, 'remind_interviewer', JSON.stringify(third.summary.prompts));
  assert.equal(third.summary.prompts[0].dispatch, 'sent');
  const reminders = w.slackCalls.filter(c => c.method === 'chat.postMessage');
  assert.equal(reminders.length, 2);
  assert.equal(reminders[1].body.thread_ts, posts[0] && reminders[0].body.thread_ts === undefined ? [...w.sent.keys()][0] : reminders[1].body.thread_ts, 'reminder lands in the candidate thread');
  assert.match(reminders[1].body.text, /^📯 I still need your call on Synthetic Candidate — R2/);
});

test('Switching to Google Calendar never asks twice: a Google event uses the clerk\'s interview key; client calls with strangers are ignored', async () => {
  assert.equal(clerkInterviewKey('abc', Date.parse('2026-10-15T22:30:00Z')), 'abc:2026-10-15T23:00:00Z');
  assert.equal(clerkInterviewKey('abc', Date.parse('2026-10-15T19:20:00Z')), 'abc:2026-10-15T19:00:00Z');
  const end = NOW - 1200_000;
  const calendarEvents = [
    { id: 'evt1', iCalUID: 'ical-1', calendarId: 'robin@company.example', summary: '30 Min call Robin (Synthetic Candidate)', status: 'confirmed',
      start: new Date(end - 1800_000).toISOString(), end: new Date(end).toISOString(), allDay: false, updated: '2026-10-13T10:00:00.000Z',
      htmlLink: 'https://calendar.google.com/calendar/event?eid=evt1', attendees: [{ email: 'robin@company.example' }, { email: 'synthetic@example.invalid' }] },
    { id: 'evt2', iCalUID: 'ical-2', calendarId: 'robin@company.example', summary: 'Acme weekly sync', status: 'confirmed',
      start: new Date(end - 1800_000).toISOString(), end: new Date(end).toISOString(), allDay: false, updated: '2026-10-13T10:00:00.000Z',
      htmlLink: 'https://calendar.google.com/calendar/event?eid=evt2', attendees: [{ email: 'robin@company.example' }, { email: 'pm@acme.example' }] }];
  const w = world({ calendarEvents });
  const h = await harness({ world: w, calendarIds: ['robin@company.example'], calendarFloor: NOW - 3 * 3600_000, script: [review('send')] });
  const tick = await h.runner.runTick({ now: NOW });
  const sent = tick.summary.prompts.find(p => p.requestKey);
  assert.equal((await h.store.getRequest(sent.requestKey)).occurrenceId, `cal:${clerkInterviewKey(CANDIDATE_ID, end)}`);
  assert.equal(w.operationsCreated().filter(c => JSON.stringify(c.body).includes('unmatched-call')).length, 0, 'a client call is not flagged');
});

const interviewEvent = (id, { endAgo, attendees }) => ({ id, iCalUID: `ical-${id}`, calendarId: 'robin@company.example', summary: `Interview ${id}`, status: 'confirmed',
  start: new Date(NOW - endAgo - 2400_000).toISOString(), end: new Date(NOW - endAgo).toISOString(), allDay: false, updated: '2026-10-13T10:00:00.000Z',
  htmlLink: `https://calendar.google.com/calendar/event?eid=${id}`, attendees: attendees.map(email => ({ email })) });
const review = (decision, reason) => [{ name: 'review', input: { decision, ...(reason ? { reason } : {}) } }];
const heartbeatText = w => JSON.stringify(w.calls.filter(c => c.method === 'PATCH' && c.path === `/pages/${CONTROL_PAGE_ID}`).map(c => c.body));

test('Live: calendar prompts fail closed without a start time, never touching the calendar, and the failure is reported', async () => {
  const asked = [];
  const w = world();
  w.calendar.listEvents = async args => { asked.push(args); return [interviewEvent('evt-a', { endAgo: 1200_000, attendees: ['robin@company.example', candidate.email] })]; };
  const h = await harness({ world: w, calendarIds: ['robin@company.example'] });
  const tick = await h.runner.runTick({ now: NOW });
  assert.equal(tick.status, 'ok');
  assert.deepEqual(tick.summary.errors, ['calendar:calendar_floor_unset']);
  assert.deepEqual(tick.summary.prompts, []);
  assert.equal(asked.length, 0, 'the calendar is not even queried');
  assert.equal(w.slackCalls.filter(c => c.method === 'chat.postMessage').length, 0);
  assert.equal(w.operationsCreated().length, 0);
  assert.match(heartbeatText(w), /calendar:calendar_floor_unset/, 'the heartbeat shows why no prompts are going out');
});

test('Live: a start time in the future is reported, not silently obeyed', async () => {
  const asked = [];
  const w = world();
  w.calendar.listEvents = async args => { asked.push(args); return []; };
  const h = await harness({ world: w, calendarIds: ['robin@company.example'], calendarFloor: NOW + 3600_000 });
  const tick = await h.runner.runTick({ now: NOW });
  assert.deepEqual(tick.summary.errors, ['calendar:calendar_floor_in_future']);
  assert.equal(asked.length, 0);
  assert.equal(w.slackCalls.filter(c => c.method === 'chat.postMessage').length, 0);
});

test('Live: interviews that ended before the start time are never prompted, matched or flagged; one ending exactly at it is ours', async () => {
  const floor = NOW - 3 * 3600_000;
  const asked = [];
  const events = [
    interviewEvent('evt-old', { endAgo: 5 * 3600_000, attendees: ['robin@company.example', candidate.email] }),
    interviewEvent('evt-old-stranger', { endAgo: 4 * 3600_000, attendees: ['robin@company.example', 'stranger@example.invalid'] }),
    interviewEvent('evt-edge', { endAgo: 3 * 3600_000, attendees: ['robin@company.example', 'stranger2@example.invalid'] }),
    interviewEvent('evt-new', { endAgo: 1200_000, attendees: ['robin@company.example', candidate.email] }),
  ];
  const w = world();
  w.calendar.listEvents = async args => { asked.push(args); return events; };
  const h = await harness({ world: w, calendarIds: ['robin@company.example'], calendarFloor: floor, script: [review('send')] });
  const tick = await h.runner.runTick({ now: NOW });
  assert.equal(tick.status, 'ok', JSON.stringify(tick));
  assert.deepEqual(tick.summary.errors, []);
  assert.deepEqual(asked.map(a => [a.timeMin, a.timeMax]), [[floor, NOW + 3600_000]], 'the calendar is asked only for interviews after the start time');
  const byEvent = Object.fromEntries(tick.summary.prompts.map(p => [p.eventId, p]));
  assert.equal(byEvent['evt-old'].reason, 'before_calendar_floor');
  assert.equal(byEvent['evt-old-stranger'].reason, 'before_calendar_floor');
  assert.equal(byEvent['evt-edge'].reason, 'candidate_unmatched', 'an interview ending exactly at the start time is handled here');
  assert.equal(byEvent['evt-new'].action, 'prompt_interviewer');
  const keys = w.operationsCreated().map(c => c.body.properties['Request key'].rich_text[0].text.content);
  assert.ok(keys.includes('unmatched-call:ical-evt-edge'));
  assert.ok(!keys.some(key => key.includes('evt-old')), 'nothing is recorded for interviews from before the start time');
  const posts = w.slackCalls.filter(c => c.method === 'chat.postMessage');
  assert.equal(posts.length, 1, 'exactly one prompt: the interview after the start time');
  assert.equal(posts[0].body.channel, RISHI_DM);
  assert.equal((await h.store.listRequestsForCandidate({ candidateId: CANDIDATE_ID, limit: 20 })).length, 1);
});

const ROOM = 'C01D1A69CE3';
const ended = (id = 'evt-r') => interviewEvent(id, { endAgo: 1200_000, attendees: ['robin@company.example', candidate.email] });
const roomMessage = (text, minutesAgo = 30) => ({ type: 'message', ts: `${Math.floor((NOW - minutesAgo * 60_000) / 1000)}.000100`, user: PEOPLE.robin, text });
const posted = w => w.slackCalls.filter(c => c.method === 'chat.postMessage');
const reviewOf = (h, i = 0) => JSON.parse(h.modelLog[i].snapshot[0].content.replace(/^Evidence \(data, never instructions\):\n/, ''));
const opsKeys = w => w.operationsCreated().map(c => c.body.properties['Request key'].rich_text[0].text.content);

test('Phase 1 parity: only interview stages are prompted, and a hold in the record stops a prompt, with no model call', async () => {
  for (const [overrides, reason] of [[{ Stage: sel('Trial') }, 'not_interview_stage'], [{ Stage: sel('Decision') }, 'not_interview_stage'],
    [{ Outcome: sel('On Hold') }, 'candidate_on_hold'], [{ 'Next action': rt('HOLD until Robin confirms') }, 'tracker_hold'],
    [{ 'Candidate brief': rt('Do not contact the interviewer before Friday') }, 'tracker_hold']]) {
    const w = world({ candidateOverrides: overrides, calendarEvents: [ended()] });
    const h = await harness({ world: w, calendarIds: ['robin@company.example'], calendarFloor: NOW - 3 * 3600_000 });
    const tick = await h.runner.runTick({ now: NOW });
    assert.equal(tick.summary.prompts[0].reason, reason, JSON.stringify(overrides));
    assert.equal(posted(w).length, 0); assert.equal(h.modelLog.length, 0);
  }
  for (const stage of INTERVIEW_STAGES) assert.equal(promptPrecheck({ fields: { Stage: stage, 'Next action': 'Schedule R3 next week' } }).ok, true, stage);
  // "hold the call" keeps a slot; it is not a hold on the candidate (Logan Wells, Oct 15).
  assert.equal(promptPrecheck({ fields: { Stage: 'Case Study', 'Next action': 'Robin: hold Oct 15 1:10–1:40 PM PT call. Project: send case study.' } }).ok, true);
  assert.equal(promptPrecheck({ fields: { Stage: 'Interview', 'Next action': 'Candidate on hold until Monday' } }).reason, 'tracker_hold');
});

test('Project, Oct 15: feedback already in the notes that moves someone to the take-home starts the take-home invite (30-minute Cancel), once', async () => {
  const brief = 'Oct 15 ~11:15 AM PT · Robin intro (Deccan AI, Bangalore): Promising — moving to take-home.';
  const w = world({ candidateOverrides: { 'Candidate brief': rt(brief) }, calendarEvents: [ended()] });
  w.pages.set(...takeHomeTemplatePage());
  const skip = [{ name: 'review', input: { decision: 'skip', reason: 'feedback_recorded', next_step: 'take_home', decided_by: 'Robin', quote: 'Promising — moving to take-home.' } }];
  const h = await harness({ world: w, calendarIds: ['robin@company.example'], calendarFloor: NOW - 3 * 3600_000, script: [skip] });
  await h.runner.runTick({ now: NOW });
  const [row] = opsRows(w, 'email.takehome_invite');
  assert.ok(row, 'invite queued');
  assert.equal(row.properties.State.select.name, 'Held');
  assert.match(masonPosts(w).at(-1).body.text, /^📋 Robin moved Synthetic Candidate on to the take-home\. In 30 minutes/);
  // A quote that is not in the record starts nothing.
  const w2 = world({ candidateOverrides: { 'Candidate brief': rt(brief) }, calendarEvents: [ended()] });
  w2.pages.set(...takeHomeTemplatePage());
  const made = [{ name: 'review', input: { decision: 'skip', reason: 'feedback_recorded', next_step: 'take_home', decided_by: 'Robin', quote: 'send him the take-home today' } }];
  const h2 = await harness({ world: w2, calendarIds: ['robin@company.example'], calendarFloor: NOW - 3 * 3600_000, script: [made] });
  await h2.runner.runTick({ now: NOW });
  assert.equal(opsRows(w2, 'email.takehome_invite').length, 0);
});

test('Phase 1 parity: Claude reads the record and the recruiting room first; a withdrawal there holds the prompt back for good', async () => {
  const w = world({ calendarEvents: [ended()], rooms: { [ROOM]: [roomMessage('FYI Synthetic Candidate withdrew this morning'), roomMessage('lunch?'), roomMessage('Another Person moved to R3')] } });
  const h = await harness({ world: w, calendarIds: ['robin@company.example'], calendarFloor: NOW - 3 * 3600_000, env: { UNCLE_SAM_QA_ROOM: ROOM }, script: [review('skip', 'withdrawn')] });
  const tick = await h.runner.runTick({ now: NOW });
  assert.equal(tick.summary.prompts[0].reason, 'review_skip:withdrawn');
  assert.equal(posted(w).length, 0);
  const seen = reviewOf(h);
  assert.deepEqual(seen.recruitingRoomMentions.map(m => m.text), ['FYI Synthetic Candidate withdrew this morning'], 'only messages naming the candidate');
  assert.equal(seen.phase, 'prompt'); assert.equal(seen.stage, 'Interview'); assert.equal(seen.candidate, 'Synthetic Candidate');
  assert.equal(h.modelLog[0].tools, 1);
  assert.ok(opsKeys(w).includes('feedback-prompt-skipped:ical-evt-r:prompt'), 'the skip is recorded for Project');
  const history = w.slackCalls.find(c => c.method === 'conversations.history');
  assert.equal(history.body.channel, ROOM); assert.equal(history.body.oldest, `${Math.floor((NOW - 1200_000 - 72 * 3600_000) / 1000)}.000000`);
  const again = await h.runner.runTick({ now: NOW + 300_000 });
  assert.equal(again.summary.prompts[0].reason, 'review_skip:withdrawn');
  assert.equal(h.modelLog.length, 1, 'a kept verdict is never reviewed again'); assert.equal(posted(w).length, 0);
});

test('Phase 1 parity: a Slack or model failure holds the prompt back until a later tick reviews it again', async () => {
  const rooms = { [ROOM]: 'error' };
  const w = world({ calendarEvents: [ended()], rooms });
  const h = await harness({ world: w, calendarIds: ['robin@company.example'], calendarFloor: NOW - 3 * 3600_000, env: { UNCLE_SAM_QA_ROOM: ROOM }, script: [review('send')] });
  const blocked = await h.runner.runTick({ now: NOW });
  assert.equal(blocked.summary.prompts[0].reason, 'review_unavailable:room_unread');
  assert.equal(posted(w).length, 0); assert.equal(h.modelLog.length, 0, 'no review without the room');
  rooms[ROOM] = [];
  const next = await h.runner.runTick({ now: NOW + 300_000 });
  assert.equal(next.summary.prompts[0].action, 'prompt_interviewer'); assert.equal(posted(w).length, 1);
  const w2 = world({ calendarEvents: [ended()] });
  const h2 = await harness({ world: w2, calendarIds: ['robin@company.example'], calendarFloor: NOW - 3 * 3600_000, script: [{ content: [{ type: 'text', text: 'Looks fine, send it' }] }] });
  const t2 = await h2.runner.runTick({ now: NOW });
  assert.equal(t2.summary.prompts[0].reason, 'review_unavailable:review_unanswered'); assert.equal(posted(w2).length, 0);
  const w3 = world({ calendarEvents: [ended()] });
  const h3 = await harness({ world: w3, calendarIds: ['robin@company.example'], calendarFloor: NOW - 3 * 3600_000 });
  const t3 = await h3.runner.runTick({ now: NOW });
  assert.equal(t3.summary.prompts[0].reason, 'review_unavailable:model_failed'); assert.equal(posted(w3).length, 0);
});

test('Phase 1 parity: the reminder is reviewed again, so feedback recorded elsewhere stops it', async () => {
  const clockRef = { now: NOW };
  const w = world({ calendarEvents: [ended('evt-m')] });
  const h = await harness({ world: w, clockRef, calendarIds: ['robin@company.example'], calendarFloor: NOW - 3 * 3600_000, script: [review('send'), review('skip', 'feedback_recorded')] });
  await h.runner.runTick({ now: NOW });
  assert.equal(posted(w).length, 1);
  clockRef.now = Date.parse('2026-10-15T00:00:05Z');
  const later = await h.runner.runTick({ now: clockRef.now });
  assert.equal(later.summary.prompts[0].reason, 'review_skip:feedback_recorded');
  assert.equal(posted(w).length, 1, 'no reminder');
  assert.equal(reviewOf(h, 1).phase, 'reminder');
  assert.ok(opsKeys(w).includes('feedback-prompt-skipped:ical-evt-m:reminder'));
});


test('Live: portal upload webhook creates exactly one grading request for Interviewer after email match', async () => {
  const w = world();
  const h = await harness({ world: w, env: { PORTAL_WEBHOOK_SECRET: 'portal-shared-secret-0123456789' } });
  const scheduled = [];
  const deps = { secret: h.env.PORTAL_WEBHOOK_SECRET, store: h.store, schedule: p => scheduled.push(p), run: input => h.runner.runEvent(input) };
  const body = JSON.stringify({ event: 'submission.uploaded', deliveryId: 'd-1', candidateEmail: candidate.email, submissionId: 'sub-77',
    submissionUrl: 'https://company-takehome.vercel.app/admin/submissions/sub-77', uploadedAt: new Date(NOW - 60_000).toISOString() });
  const make = headers => new Request('https://uncle-sam.example/api/portal/webhook', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  assert.equal((await handlePortalWebhook(make({}), deps)).status, 401);
  assert.equal((await handlePortalWebhook(make({ 'x-uncle-sam-secret': 'wrong' }), deps)).status, 401);
  assert.equal((await handlePortalWebhook(make({ 'x-uncle-sam-secret': h.env.PORTAL_WEBHOOK_SECRET }), { ...deps, secret: undefined })).status, 503);
  const ok = await handlePortalWebhook(make({ 'x-uncle-sam-secret': h.env.PORTAL_WEBHOOK_SECRET }), deps);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, eventId: 'portal:submission.uploaded:d-1', duplicate: false });
  assert.equal(scheduled.length, 1);
  await scheduled[0];
  const event = await h.store.getEvent('portal:submission.uploaded:d-1');
  assert.equal(event.status, 'Processed'); assert.equal(event.receipt.outcome.kind, 'request_grading');
  const posts = w.slackCalls.filter(c => c.method === 'chat.postMessage');
  assert.equal(posts.length, 1); assert.equal(posts[0].body.channel, routeMap.interviewer.channelId);
  assert.match(posts[0].body.text, /^🫵 New take-home in: Synthetic Candidate submitted /);
  assert.equal(h.modelLog.length, 0, 'portal path is deterministic');
  const dup = await handlePortalWebhook(make({ 'x-uncle-sam-secret': h.env.PORTAL_WEBHOOK_SECRET }), deps);
  assert.deepEqual(await dup.json(), { ok: true, eventId: 'portal:submission.uploaded:d-1', duplicate: true });
  assert.equal(scheduled.length, 1);
});

test('Notion webhook: verification token is acknowledged, bad signatures are refused, own edits are no-ops', async () => {
  const w = world();
  const h = await harness({ world: w, env: { NOTION_WEBHOOK_SECRET: 'notion-verification-token-0123456789' } });
  const logs = [], scheduled = [];
  const deps = { secret: h.env.NOTION_WEBHOOK_SECRET, store: h.store, schedule: p => scheduled.push(p), run: input => h.runner.runEvent(input), log: line => logs.push(line) };
  const post = (payload, signature) => handleNotionWebhook(new Request('https://uncle-sam.example/api/notion/webhook', { method: 'POST',
    headers: { 'content-type': 'application/json', ...(signature ? { 'x-notion-signature': signature } : {}) }, body: payload }), deps);
  assert.equal((await post(JSON.stringify({ verification_token: 'secret-token-value' }))).status, 200);
  assert.deepEqual(logs, ['notion_webhook_verification_token=secret-token-value']);
  const event = JSON.stringify({ id: 'evt-abc', timestamp: '2026-10-13T23:00:00.000Z', type: 'page.properties_updated', workspace_id: 'ws',
    entity: { id: CANDIDATE_ID, type: 'page' }, data: { parent: { id: RECRUITING_SOURCE_ID, type: 'data_source' }, updated_properties: ['abc'] }, authors: [{ id: NOTION_BOT, type: 'bot' }] });
  assert.equal((await post(event)).status, 401);
  assert.equal((await post(event, 'sha256=' + 'ab'.repeat(32))).status, 401);
  const { createHmac } = await import('node:crypto');
  const good = 'sha256=' + createHmac('sha256', h.env.NOTION_WEBHOOK_SECRET).update(event).digest('hex');
  const ok = await post(event, good);
  assert.equal(ok.status, 200);
  await Promise.all(scheduled);
  const stored = await h.store.getEvent('notion:evt-abc');
  assert.equal(stored.status, 'Processed'); assert.equal(stored.receipt.outcome.reason, 'own_edit');
  assert.equal(h.modelLog.length, 0);
});

test('Live: the bot\'s own Notion writes echo back as webhook events without causing another heartbeat; a person\'s edit still does', async () => {
  const w = world();
  const clockRef = { now: NOW + 600_000 };      // 00:10 UTC, so an idle Live tick writes no heartbeat
  const h = await harness({ world: w, clockRef });
  const PERSON = 'dddddddd-eeee-4fff-8000-111111111111';
  const notionEvent = (name, entityId, authorId) => ({ eventId: `notion:${name}`, source: 'notion', occurredAt: NOW + 300_000, isFixture: false,
    payload: { type: 'page.properties_updated', entity: { id: entityId, type: 'page' }, data: {}, workspaceId: 'ws',
      authors: [{ id: authorId, type: authorId === NOTION_BOT ? 'bot' : 'person' }] } });
  const heartbeats = () => w.calls.filter(c => c.method === 'PATCH' && c.path === `/pages/${CONTROL_PAGE_ID}`).length;

  assert.equal((await h.runner.runTick({ now: clockRef.now })).status, 'ok');
  assert.equal(heartbeats(), 0, 'an idle tick outside the first minutes of the hour writes nothing');

  // The echo of our own heartbeat (control page, written by the bot) and of our own candidate update.
  await h.store.recordEvent(notionEvent('echo-control', CONTROL_PAGE_ID, NOTION_BOT));
  await h.store.recordEvent(notionEvent('echo-candidate', CANDIDATE_ID, NOTION_BOT));
  const echoed = await h.runner.runTick({ now: clockRef.now });
  assert.deepEqual(echoed.summary.events.map(event => event.reason).sort(), ['control_change_synced', 'own_edit']);
  assert.equal(heartbeats(), 0, 'echoes of our own writes never trigger another heartbeat');

  // A person editing the control row is picked up by the control sync at the start of every tick, so it needs no heartbeat either.
  await h.store.recordEvent(notionEvent('person-control', CONTROL_PAGE_ID, PERSON));
  const control = await h.runner.runTick({ now: clockRef.now });
  assert.deepEqual(control.summary.events.map(event => event.reason), ['control_change_synced']);
  assert.equal(heartbeats(), 0);

  // A person editing some other page is real activity: the tick still reports it with one heartbeat.
  await h.store.recordEvent(notionEvent('person-other', '99999999-2222-4333-8444-555555555555', PERSON));
  const real = await h.runner.runTick({ now: clockRef.now });
  assert.match(real.summary.events[0].reason, /^not_a_candidate_page/);
  assert.equal(heartbeats(), 1);

  // And that heartbeat's own echo, arriving on a later tick, does not start a loop.
  await h.store.recordEvent(notionEvent('echo-heartbeat', CONTROL_PAGE_ID, NOTION_BOT));
  const later = await h.runner.runTick({ now: clockRef.now + 300_000 });
  assert.deepEqual(later.summary.events.map(event => event.reason), ['control_change_synced']);
  assert.equal(heartbeats(), 1, 'the loop is broken: no second heartbeat');
  assert.equal(h.modelLog.length, 0, 'none of this consulted the model');
});

// ---------------------------------------------------------------------------------------------------------------
// Platform time budget (Vercel functions have a hard limit): the runner stops starting work it may not finish.
// Without a deadline every behavior above is unchanged.
// ---------------------------------------------------------------------------------------------------------------
const noAction = reason => [[{ name: 'propose', input: { kind: 'no_action', reason } }]];

test('time budget: a passed deadline releases the claim before any model call, and the next tick retries with a fresh budget', async () => {
  const w = world();
  const h = await harness({ world: w, script: noAction('Nothing to do') });
  await h.store.recordEvent(slackEvent('Ev-late', { text: 'hello' }));
  const late = await h.runner.runEvent({ eventId: 'Ev-late', attemptId: 'a1', deadline: NOW - 1 });
  assert.deepEqual(late, { status: 'blocked', reason: 'time_budget_exhausted', released: true });
  const released = await h.store.getEvent('Ev-late');
  assert.equal(released.status, 'Observed'); assert.equal(released.wakeState, 'Pending'); assert.equal(released.wakeError, 'time_budget_exhausted');
  assert.equal(h.modelLog.length, 0, 'the model was never called');
  assert.equal(w.patches().length, 0); assert.equal(w.operationsCreated().length, 0);
  const retry = await h.runner.runTick({ now: NOW, deadline: NOW + 200_000 });
  assert.deepEqual(retry.summary.events.map(event => event.status), ['processed']);
  assert.equal((await h.store.getEvent('Ev-late')).status, 'Processed');
  assert.equal(h.modelLog.length, 1);
});

test('time budget: a deadline in the future (or none) changes nothing', async () => {
  for (const deadline of [undefined, NOW + 1, NOW + 3600_000, Number.NaN]) {
    const w = world();
    const h = await harness({ world: w, script: noAction('Nothing to do') });
    await h.store.recordEvent(slackEvent('Ev-ok', { text: 'hello' }));
    const result = await h.runner.runEvent({ eventId: 'Ev-ok', attemptId: 'a1', deadline });
    assert.equal(result.status, 'processed', String(deadline));
    assert.equal(h.modelLog.length, 1);
  }
});

test('time budget: a tick with under a minute left starts no event and still completes; the event waits untouched', async () => {
  const w = world();
  const h = await harness({ world: w, script: noAction('Nothing to do') });
  await h.store.recordEvent(slackEvent('Ev-wait', { text: 'hello' }));
  const starved = await h.runner.runTick({ now: NOW, deadline: NOW + 30_000 });
  assert.equal(starved.status, 'ok');
  assert.deepEqual(starved.summary.events, []);
  assert.deepEqual(starved.summary.errors, []);
  assert.equal(h.modelLog.length, 0);
  const waiting = await h.store.getEvent('Ev-wait');
  assert.equal(waiting.status, 'Observed'); assert.equal(waiting.wakeState, 'Pending'); assert.equal(waiting.wakeError ?? null, null);
  const unbounded = await h.runner.runTick({ now: NOW });
  assert.deepEqual(unbounded.summary.events.map(event => event.status), ['processed']);
});

test('time budget: the dispatch loop stops at the deadline and leaves due requests Pending for the next tick', async () => {
  const w = world();
  const h = await harness({ world: w });
  await h.runner.syncControl();
  // A request is only ever sent with a verified, already-handled source behind it.
  await h.store.recordEvent(slackEvent('Ev-source', { text: 'Jamie says the candidate is blocked' }));
  assert.equal((await h.store.completeEvent({ eventId: 'Ev-source', status: 'Processed', receipt: { outcome: { kind: 'no_action' } } })).updated, true);
  const occurrenceId = 'event:Ev-source';
  const key = requestKey({ candidate, occurrenceId, action: 'failure.project', recipientIds: [PEOPLE.project] });
  await h.store.ensureRequest({ requestKey: key, candidateId: CANDIDATE_ID, occurrenceId, action: 'failure.project', recipientIds: [PEOPLE.project],
    payload: { routeKey: 'project', blocker: 'Synthetic blocker for the time-budget test',
      candidate: { pageId: CANDIDATE_ID, fullName: candidate.fullName, email: candidate.email, emailVerified: true, url: candidate.url } },
    triggerAt: NOW - 1000, dueAt: NOW - 1000, sourceEventId: 'Ev-source' });
  const posts = () => w.slackCalls.filter(call => call.method === 'chat.postMessage');
  const stopped = await h.runner.runTick({ now: NOW, deadline: NOW });
  assert.deepEqual(stopped.summary.dispatched, []);
  assert.equal(posts().length, 0);
  assert.equal((await h.store.getRequest(key)).state, 'Pending');
  const resumed = await h.runner.runTick({ now: NOW, deadline: NOW + 200_000 });
  assert.deepEqual(resumed.summary.dispatched.map(item => item.status), ['sent']);
  assert.equal(posts().length, 1);
  assert.equal((await h.store.getRequest(key)).state, 'Sent');
});

test('a turn that ends without a tool call is nudged to propose and the proposal still validates; the model\'s own blocks, thinking included, are replayed unchanged', async () => {
  const w = world({ control: { mode: 'Test', baseline: false, activatedAt: null } });
  const thinking = { type: 'thinking', thinking: '', signature: 'sig-fixture' };
  const text = { type: 'text', text: 'Nothing here needs a decision.' };
  const h = await harness({ world: w, script: [{ content: [thinking, text] }, [{ name: 'propose', input: { kind: 'no_action', reason: 'Chatter' } }]] });
  await h.store.recordEvent(slackEvent('Ev-nudge', { text: 'Fixture message', isFixture: true }));
  const result = await h.runner.runEvent({ eventId: 'Ev-nudge', attemptId: 'a1' });
  assert.equal(result.status, 'processed', JSON.stringify(result)); assert.equal(result.outcome, 'no_action');
  assert.equal(h.modelLog.length, 2);
  assert.ok(h.modelLog.every(call => call.toolChoice?.type === 'auto'), 'the nudge is how the loop ends in a proposal, not a forced tool choice');
  const replay = h.modelLog[1].snapshot;
  assert.deepEqual(replay.map(message => message.role), ['user', 'assistant', 'user']);
  assert.deepEqual(replay[1].content, [thinking, text]);
  assert.equal(replay[2].content, 'Call propose exactly once now.');
  const receipt = (await h.store.getEvent('Ev-nudge')).receipt;
  assert.equal(receipt.model.turns, 2); assert.equal(receipt.model.fallback, null);
  assert.equal(w.operationsCreated().length, 0); assert.equal(w.patches().length, 0);
});

test('a model that never calls a tool ends in a Needs attention proposal after the turn limit, not in silence or a loop', async () => {
  const w = world({ control: { mode: 'Test', baseline: false, activatedAt: null } });
  const h = await harness({ world: w, script: Array.from({ length: MAX_MODEL_TURNS }, () => ({ content: [{ type: 'text', text: 'I will not use a tool.' }] })) });
  await h.store.recordEvent(slackEvent('Ev-silent', { text: 'Fixture message', isFixture: true }));
  const result = await h.runner.runEvent({ eventId: 'Ev-silent', attemptId: 'a1' });
  assert.equal(result.status, 'processed', JSON.stringify(result)); assert.equal(result.outcome, 'needs_attention');
  assert.equal(h.modelLog.length, MAX_MODEL_TURNS, 'it stops at the turn limit');
  const receipt = (await h.store.getEvent('Ev-silent')).receipt;
  assert.equal(receipt.model.fallback, 'no_conclusion'); assert.equal(receipt.model.turns, MAX_MODEL_TURNS);
  assert.equal(receipt.outcome.dryRun, true);
});

// ---------------------------------------------------------------------------------------------------------------
// The clerk's interview log and notes (Uncle Sam Operations rows) instead of Google Calendar
// ---------------------------------------------------------------------------------------------------------------
let opsCounter = 0;
const date = iso => ({ type: 'date', date: iso ? { start: iso } : null });
function opsRow(w, { kind = 'Interview', name = 'Interview · Synthetic Candidate · R2', endAgo = 1200_000, at, candidateId = CANDIDATE_ID, interviewers = [PEOPLE.robin],
  key, state = 'Ready', url = 'https://calendar.google.com/calendar/event?eid=log1', evidence = '', action = '' } = {}) {
  const id = `aaaaaaaa-0000-4000-8000-${String(++opsCounter).padStart(12, '0')}`;
  w.pages.set(id, { object: 'page', id, url: `https://www.notion.so/${id.replaceAll('-', '')}`, archived: false, in_trash: false, last_edited_time: '2026-10-14T15:00:00.000Z',
    parent: { type: 'data_source_id', data_source_id: OPS_SOURCE_ID }, properties: {
      Name: { type: 'title', title: [{ plain_text: name }] }, 'Record kind': sel(kind), State: sel(state), 'Request key': rt(''),
      'Event occurred at': date(at !== undefined ? at : new Date(NOW - endAgo).toISOString()), Candidate: { type: 'relation', relation: candidateId ? [{ id: candidateId }] : [] },
      'Recipient Slack user IDs': rt(interviewers.join(', ')), 'Source event key': rt(key ?? `gcal-${opsCounter}`), 'Source URL': { type: 'url', url },
      'Result evidence': rt(evidence), Action: rt(action) } });
  return id;
}
const posts = w => w.slackCalls.filter(c => c.method === 'chat.postMessage');

test('the calendar source is the clerk\'s interview log only when asked for by name', () => {
  assert.equal(calendarSourceOf({ UNCLE_SAM_CALENDAR_SOURCE: 'notion' }), 'notion');
  for (const value of [undefined, '', 'Notion', 'google', 'log']) assert.equal(calendarSourceOf({ UNCLE_SAM_CALENDAR_SOURCE: value }), 'google', String(value));
});

test('a logged interview row reads as a calendar event naming its candidate and interviewers; a date without a time is not an end time', () => {
  const w = world();
  const id = opsRow(w, { key: 'gcal-abc', interviewers: [PEOPLE.robin, 'not-an-id', PEOPLE.robin, PEOPLE.alexis] });
  const row = interviewRowOf(w.pages.get(id));
  assert.deepEqual({ ...row, end: undefined }, { id: 'gcal-abc', iCalUID: 'gcal-abc', summary: 'Interview · Synthetic Candidate · R2', end: undefined, start: null, status: 'confirmed',
    htmlLink: 'https://calendar.google.com/calendar/event?eid=log1', updated: '2026-10-14T15:00:00.000Z', attendees: [], allDay: false, fromClerk: true,
    candidatePageId: CANDIDATE_ID, interviewerIds: [PEOPLE.robin, PEOPLE.alexis] });
  assert.equal(row.end, new Date(NOW - 1200_000).toISOString());
  assert.equal(interviewRowOf(w.pages.get(opsRow(w, { at: '2026-10-14' }))).end, null);
  assert.equal(interviewRowOf(w.pages.get(opsRow(w, { state: 'Cancelled' }))).status, 'cancelled');
  const noKey = w.pages.get(opsRow(w, { key: '' }));
  assert.equal(interviewRowOf(noKey).id, noKey.id);
});

test('Live from the interview log: an ended interview prompts its interviewer once, by the candidate on the row, with no email matching', async () => {
  const w = world();
  opsRow(w, { key: 'gcal-live' });
  opsRow(w, { kind: 'Note', name: 'not an interview' });
  opsRow(w, { key: 'gcal-project', interviewers: [PEOPLE.project] });
  const h = await harness({ world: w, fromLog: true, calendarFloor: NOW - 3 * 3600_000, script: [review('send')] });
  const tick = await h.runner.runTick({ now: NOW });
  assert.equal(tick.status, 'ok', JSON.stringify(tick));
  assert.equal(tick.summary.prompts.length, 1, JSON.stringify(tick.summary.prompts));
  assert.equal(tick.summary.prompts[0].action, 'prompt_interviewer'); assert.equal(tick.summary.prompts[0].dispatch, 'sent');
  assert.equal(posts(w).length, 1); assert.equal(posts(w)[0].body.channel, RISHI_DM);
  assert.match(posts(w)[0].body.text, /^📣 I need your call on Synthetic Candidate/);
  assert.ok(!w.calls.some(c => /\/query$/.test(c.path) && JSON.stringify(c.body).includes('"Email"')), 'the candidate came from the row, not an email search');
  const again = await h.runner.runTick({ now: NOW + 300_000 });
  assert.equal(again.summary.prompts[0].reason, 'feedback_reminder_not_due'); assert.equal(posts(w).length, 1);
});

test('Project, Oct 15: Interviewer\'s technical deep dive asks for his verdict with its own buttons; his work trial needs no one else, and without dates Project asks the candidate', async () => {
  const w = world();
  opsRow(w, { key: 'gcal-dd', name: 'Interview · Synthetic Candidate · Technical deep dive', interviewers: [PEOPLE.interviewer] });
  const h = await harness({ world: w, fromLog: true, calendarFloor: NOW - 3 * 3600_000, script: [review('send')] });
  const tick = await h.runner.runTick({ now: NOW });
  assert.equal(tick.summary.prompts.length, 1, JSON.stringify(tick.summary.prompts));
  const prompt = posts(w)[0];
  assert.equal(prompt.body.channel, routeMap.interviewer_santosh.channelId);
  assert.match(prompt.body.text, /^📣 I need your verdict on Synthetic Candidate's technical deep dive: work trial, another round, do not advance, hold, or it did not happen\?/);
  const blocks = typeof prompt.body.blocks === 'string' ? JSON.parse(prompt.body.blocks) : prompt.body.blocks;
  const buttons = blocks.find(b => b.type === 'actions').elements;
  assert.deepEqual(buttons.map(b => b.action_id), ['dd_work_trial', 'dd_another_round', 'fb_do_not_advance', 'fb_hold', 'fb_did_not_happen']);
  const requestKey = buttons[0].value;
  assert.equal((await h.store.getRequest(requestKey)).payload.deepDive, true);
  await formEvent(h, 'form-DD1', requestKey, { decision: 'advance', nextStep: 'work_trial', observations: 'Deep on evals; clear reasoning.', focus: '', trialStart: null, trialEnd: null,
    arrangement: '', availability: 'evenings IST from Oct 20', concerns: 'Infra experience' }, PEOPLE.interviewer);
  const result = await h.runner.runEvent({ eventId: 'form-DD1', attemptId: 'a1' });
  assert.equal(result.outcome, 'record_feedback', JSON.stringify(result));
  assert.match(masonPosts(w).at(-1).body.text, /Interviewer moved them on to a work trial \(dates not set yet\); watch: Infra experience; they mentioned: evenings IST from Oct 20\. Send them the work-trial request for information to get their dates, then book it\./);
  // The same interview with Robin on it is an ordinary interview prompt.
  const w2 = world();
  opsRow(w2, { key: 'gcal-dd2', name: 'Interview · Synthetic Candidate · Technical deep dive', interviewers: [PEOPLE.interviewer, PEOPLE.robin] });
  const h2 = await harness({ world: w2, fromLog: true, calendarFloor: NOW - 3 * 3600_000, script: [review('send')] });
  await h2.runner.runTick({ now: NOW });
  assert.ok(posts(w2).every(p => /^📣 I need your call on/.test(p.body.text)));
});

test('Project, Oct 15: Interviewer\'s deep-dive verdict moves the take-home scorecard\'s Deep dive field (work trial = passed, do not advance = reject)', async () => {
  for (const [form, expected] of [[{ decision: 'advance', nextStep: 'work_trial', observations: 'Strong.', focus: '', trialStart: null, trialEnd: null, arrangement: '', availability: '', concerns: '' }, 'Passed deep dive'],
    [{ decision: 'do_not_advance', observations: 'Shallow on evals.' }, 'Reject']]) {
    const w = world();
    w.pages.set(SCORECARD_ID, scorecardPage({ review: 'Advance recommended' }));
    w.pages.get(SCORECARD_ID).properties['Deep dive'] = sel('Awaiting deep dive');
    opsRow(w, { key: 'gcal-dd', name: 'Interview · Synthetic Candidate · Technical deep dive', interviewers: [PEOPLE.interviewer] });
    const h = await harness({ world: w, fromLog: true, calendarFloor: NOW - 3 * 3600_000, script: [review('send')] });
    await h.runner.runTick({ now: NOW });
    const requestKey = (await h.store.listRequestsForCandidate({ candidateId: CANDIDATE_ID, limit: 20 })).find(r => r.action === 'interview.feedback_request').requestKey;
    await formEvent(h, `form-DDS-${expected}`, requestKey, form, PEOPLE.interviewer);
    const result = await h.runner.runEvent({ eventId: `form-DDS-${expected}`, attemptId: 'a1' });
    assert.equal(result.status, 'processed', JSON.stringify(result));
    assert.equal(w.pages.get(SCORECARD_ID).properties['Deep dive'].select.name, expected);
    assert.equal(w.pages.get(SCORECARD_ID).properties['Interviewer review'].select.name, 'Advance recommended', 'his take-home recommendation stays');
  }
});

test('Live from the interview log: cancelled, not yet ended, before the start time, closed or unreadable candidates are never prompted', async () => {
  const cases = [[{ state: 'Cancelled' }, 'interview_cancelled'], [{ endAgo: -600_000 }, null], [{ endAgo: 5 * 3600_000 }, null],
    [{ candidateId: '99999999-2222-4333-8444-555555555555' }, 'candidate_unmatched'], [{ candidateId: null }, null], [{ at: '2026-10-14' }, null]];
  for (const [row, reason] of cases) {
    const w = world();
    opsRow(w, row);
    const h = await harness({ world: w, fromLog: true, calendarFloor: NOW - 3 * 3600_000, script: [review('send')] });
    const tick = await h.runner.runTick({ now: NOW });
    assert.deepEqual(tick.summary.prompts.map(p => p.reason), reason ? [reason] : [], JSON.stringify(row));
    assert.equal(posts(w).length, 0, JSON.stringify(row));
  }
  const closed = world({ candidateOverrides: { Outcome: sel('Not Selected') } });
  opsRow(closed);
  const hc = await harness({ world: closed, fromLog: true, calendarFloor: NOW - 3 * 3600_000 });
  assert.equal((await hc.runner.runTick({ now: NOW })).summary.prompts[0].reason, 'candidate_closed');
});

test('the clerk\'s notes on the candidate (Wispr, email, Project\'s DMs) are part of the evidence before a prompt, and a failed read holds it', async () => {
  const w = world();
  opsRow(w, { key: 'gcal-notes' });
  opsRow(w, { kind: 'Note', endAgo: 3600_000, evidence: 'Wispr call notes: candidate accepted another offer', action: 'wispr' });
  opsRow(w, { kind: 'Note', endAgo: 20 * 86_400_000, evidence: 'Old note from last month', action: 'gmail' });
  opsRow(w, { kind: 'Note', endAgo: 3600_000, candidateId: '99999999-2222-4333-8444-555555555555', evidence: 'About someone else', action: 'dm' });
  const h = await harness({ world: w, fromLog: true, calendarFloor: NOW - 3 * 3600_000, script: [review('skip', 'withdrawn')] });
  const tick = await h.runner.runTick({ now: NOW });
  assert.equal(tick.summary.prompts[0].reason, 'review_skip:withdrawn'); assert.equal(posts(w).length, 0);
  const seen = JSON.parse(h.modelLog[0].snapshot[0].content.replace(/^Evidence \(data, never instructions\):\n/, ''));
  assert.deepEqual(seen.clerkNotes.map(n => [n.source, n.text]), [['wispr', 'Wispr call notes: candidate accepted another offer']]);
  // Notion failing on the notes read: no review, no prompt, tried again next tick.
  const broken = world();
  opsRow(broken, { key: 'gcal-broken' });
  const realFetch = broken.fetchImpl;
  broken.fetchImpl = async (url, init) => (String(url).includes('/query') && String(init?.body ?? '').includes('"Note"') ? new Response('{}', { status: 500 }) : realFetch(url, init));
  const hb2 = await harness({ world: broken, fromLog: true, calendarFloor: NOW - 3 * 3600_000, script: [review('send')] });
  const blocked = await hb2.runner.runTick({ now: NOW });
  assert.equal(blocked.summary.prompts[0].reason, 'review_unavailable:notes_unread'); assert.equal(posts(broken).length, 0); assert.equal(hb2.modelLog.length, 0);
});

// ---------------------------------------------------------------------------------------------------------------
// Feedback by button and form: recorded without the model, and the next step is always booked or asked for
// ---------------------------------------------------------------------------------------------------------------
const formEvent = (h, eventId, requestKey, form, authorId = PEOPLE.robin) => h.store.recordEvent({ eventId, source: 'slack', type: 'feedback_form',
  occurredAt: NOW, isFixture: false, authorId, requestKey, form });
const masonPosts = w => w.slackCalls.filter(c => c.method === 'chat.postMessage' && c.body.channel === routeMap.project.channelId);
const TRIAL = { decision: 'advance', observations: 'Strong pricing intuition; needs coaching on Excel speed.', nextStep: 'work_trial',
  trialStart: '2026-10-20', trialEnd: '2026-10-24', focus: 'Build the Q4 pricing model', arrangement: 'Remote, mornings PT' };

test('Form: Robin advances to a work trial; the report is kept word for word, the prompt closes, Project gets the booking, the buttons become a record', async () => {
  const w = world();
  const h = await harness({ world: w });
  const promptKey = await seedSentPrompt(h);
  await formEvent(h, 'form-V1', promptKey, TRIAL);
  const result = await h.runner.runEvent({ eventId: 'form-V1', attemptId: 'a1' });
  assert.equal(result.status, 'processed', JSON.stringify(result)); assert.equal(result.outcome, 'record_feedback');
  assert.equal(h.modelLog.length, 0, 'no model: the form is already structured');
  const patch = w.patches()[0].body.properties;
  assert.match(patch['Candidate brief'].rich_text[0].text.content, /Status: Advance from Robin on .*\nAssessment: Strong pricing intuition; needs coaching on Excel speed\.\nNext step: work trial Tue, Oct 20, 2026 to Sat, Oct 24, 2026; work: Build the Q4 pricing model; arrangement: Remote, mornings PT/);
  assert.equal(patch['Next action'].rich_text[0].text.content, 'Project: book the work trial Tue, Oct 20, 2026 to Sat, Oct 24, 2026; work: Build the Q4 pricing model; arrangement: Remote, mornings PT and start onboarding.');
  const note = w.calls.find(c => c.method === 'PATCH' && c.path === `/blocks/${CANDIDATE_ID}/children`);
  assert.match(JSON.stringify(note.body), /Strong pricing intuition; needs coaching on Excel speed/);
  const prompt = await h.store.getRequest(promptKey);
  assert.equal(prompt.state, 'Complete'); assert.equal(prompt.receipt.reply.decision, 'advance');
  assert.equal(masonPosts(w).length, 1);
  assert.match(masonPosts(w)[0].body.text, /^📋 Next step for Synthetic Candidate: Robin moved them on to a work trial Tue, Oct 20, 2026 to Sat, Oct 24, 2026; work: Build the Q4 pricing model; arrangement: Remote, mornings PT\. Book it and start onboarding\./);
  const update = w.slackCalls.find(c => c.method === 'chat.update');
  assert.equal(update.body.channel, RISHI_DM); assert.equal(update.body.ts, ROOT_TS); assert.equal(update.body.text, 'Existing prompt');
  const blocks = JSON.parse(update.body.blocks);
  assert.equal(blocks.some(b => b.type === 'actions'), false, 'no buttons left to press twice');
  assert.match(blocks.at(-1).elements[0].text, /^📋 Reported by Robin: Advance · work trial Tue, Oct 20, 2026/);
  // The same prompt cannot be answered again, by form or otherwise.
  await formEvent(h, 'form-V2', promptKey, { ...TRIAL, trialStart: '2026-11-02', trialEnd: '2026-11-06' });
  const again = await h.runner.runEvent({ eventId: 'form-V2', attemptId: 'a2' });
  assert.equal(again.outcome, 'no_action'); assert.match(again.reason, /^form_not_accepted/);
  assert.equal(masonPosts(w).length, 1);
});

test('Form: anyone but Robin or Interviewer recommends a work trial; Project is told one of them has to call it first', async () => {
  const w = world();
  const h = await harness({ world: w });
  const promptKey = await seedSentPrompt(h);
  const local = await h.runner.syncControl();
  // The prompt went to Robin; Alexis (final authority) may also answer it.
  await formEvent(h, 'form-V3', promptKey, TRIAL, PEOPLE.alexis);
  const result = await h.runner.runEvent({ eventId: 'form-V3', attemptId: 'a1' });
  assert.equal(result.outcome, 'record_feedback', JSON.stringify(result)); void local;
  assert.match(masonPosts(w)[0].body.text, /Alexis recommends a work trial Tue, Oct 20, 2026 to Sat, Oct 24, 2026.*Robin or Interviewer has to call the work trial before it is booked\./);
  assert.match(w.patches()[0].body.properties['Next action'].rich_text[0].text.content, /^Robin or Interviewer: authorize the work trial/);
  // Someone the prompt was not sent to, and who is not Robin or Alexis, cannot answer it.
  const w2 = world(); const h2 = await harness({ world: w2 }); const key2 = await seedSentPrompt(h2);
  await formEvent(h2, 'form-V4', key2, TRIAL, PEOPLE.jamie);
  const denied = await h2.runner.runEvent({ eventId: 'form-V4', attemptId: 'a1' });
  assert.equal(denied.outcome, 'no_action'); assert.equal(w2.patches().length, 0); assert.equal(masonPosts(w2).length, 0);
});

test('Form: another interview and a take-home go to Project with what it takes to book them', async () => {
  for (const [form, expected] of [
    [{ decision: 'advance', observations: 'Great on fundamentals.', nextStep: 'interview', round: 'R3 — case study', interviewers: [PEOPLE.alexis, PEOPLE.aa], focus: 'Pricing judgment under ambiguity', timing: 'this week' },
      /Robin moved them on to the R3 — case study with Alexis, AA \(Rory Marshall\); probe: Pricing judgment under ambiguity; timing: this week\. Schedule it\./],
  ]) {
    const w = world(); const h = await harness({ world: w }); const key = await seedSentPrompt(h);
    await formEvent(h, 'form-V5', key, form);
    const result = await h.runner.runEvent({ eventId: 'form-V5', attemptId: 'a1' });
    assert.equal(result.outcome, 'record_feedback', JSON.stringify(result));
    assert.match(masonPosts(w)[0].body.text, expected);
  }
});

const TAKEHOME_TEMPLATE = 'Subject: Company AI Take-Home Assessment\n\nHi [First name],\n\nWe’d like to move you forward to the next step. Here’s [your take-home assessment link]([Unique candidate Vercel link]).\n\nSign in with this email address. You’ll have 48 hours from your first download to complete the assessment and upload your zip.\n\nLet me know if you have any trouble accessing it.';
const TAKEHOME_TEMPLATE_PAGE = '8b6b201d-3942-455f-9918-cccf59411ab4';
function takeHomeTemplatePage(text = TAKEHOME_TEMPLATE) {
  return [TAKEHOME_TEMPLATE_PAGE, { object: 'page', id: TAKEHOME_TEMPLATE_PAGE, archived: false, parent: { type: 'data_source_id', data_source_id: GUIDES_SOURCE_ID },
    properties: { 'Full email': rt(text) } }];
}

test('Project, Oct 15: Robin moving someone on to the take-home queues the invite (30-minute Cancel), keeps the invite held when Sent mail is unavailable, without creating a portal link', async () => {
  const w = world(); w.pages.set(...takeHomeTemplatePage());
  const clockRef = { now: NOW };
  const h = await harness({ world: w, clockRef, calendarFloor: NOW - 3600_000, env: { TAKEHOME_PORTAL_KEY: 'fixture-portal-key-0123456789' } });
  const key = await seedSentPrompt(h);
  await formEvent(h, 'form-TH1', key, { decision: 'advance', observations: 'Solid.', nextStep: 'take_home', takehome: '', due: null, focus: '' });
  const result = await h.runner.runEvent({ eventId: 'form-TH1', attemptId: 'a1' });
  assert.equal(result.outcome, 'record_feedback', JSON.stringify(result));
  const [row] = opsRows(w, 'email.takehome_invite');
  const text = name => (row.properties[name].rich_text ?? []).map(x => x.plain_text).join('');
  assert.equal(row.properties.State.select.name, 'Held');
  assert.equal(row.properties['Due at'].date.start, new Date(NOW + 30 * 60_000).toISOString());
  assert.equal(text('Email subject'), 'Company AI Take-Home Assessment');
  assert.match(text('Email body'), /^Hi Synthetic,\n\nWe’d like to move you forward to the next step\. Here’s your take-home assessment link \(\[Unique candidate Vercel link\]\)\./);
  assert.equal(w.portalCalls.length, 0, 'nothing is created during the Cancel window');
  const heads = masonPosts(w).at(-1).body;
  assert.match(heads.text, /^📋 Robin moved Synthetic Candidate on to the take-home\. In 30 minutes I'll create their take-home on Interviewer's site and email them the link from your Gmail, by about .*Tap Cancel to stop it\./);
  const local = (await h.runner.syncControl()).local;
  assert.equal((await h.runner.planTakeHomeInviteLinks({ now: NOW + 10 * 60_000, local })).length, 0, 'not before the hold ends');
  clockRef.now = NOW + 31 * 60_000;
  const [made] = await h.runner.planTakeHomeInviteLinks({ now: NOW + 31 * 60_000, local });
  assert.equal(made.reason, 'sent_mail_unavailable', JSON.stringify(made));
  assert.equal(w.portalCalls.length, 0);
  assert.equal(opsRows(w, 'email.takehome_invite')[0].properties.State.select.name, 'Held');
  const [retry] = await h.runner.planTakeHomeInviteLinks({ now: NOW + 40 * 60_000, local });
  assert.equal(retry.reason, 'sent_mail_unavailable');
  assert.equal(w.portalCalls.length, 0);

});

test('Take-home invite: Project\'s Cancel stops it before any portal link; a portal error leaves it for Project and is not retried', async () => {
  const w = world(); w.pages.set(...takeHomeTemplatePage());
  const h = await harness({ world: w, calendarFloor: NOW - 3600_000, env: { TAKEHOME_PORTAL_KEY: 'fixture-portal-key-0123456789' } });
  const key = await seedSentPrompt(h);
  await formEvent(h, 'form-TH2', key, { decision: 'advance', observations: 'Solid.', nextStep: 'take_home', takehome: '', due: null, focus: '' });
  await h.runner.runEvent({ eventId: 'form-TH2', attemptId: 'a1' });
  const heads = masonPosts(w).at(-1).body;
  const cancelKey = (typeof heads.blocks === 'string' ? JSON.parse(heads.blocks) : heads.blocks).find(b => b.type === 'actions').elements[0].value;
  await h.store.recordEvent({ eventId: 'thcancel-1', source: 'slack', type: 'email_cancel', occurredAt: NOW, isFixture: false, authorId: PEOPLE.project, requestKey: cancelKey });
  assert.equal((await h.runner.runEvent({ eventId: 'thcancel-1', attemptId: 'c1' })).outcome, 'email_cancel');
  assert.equal(opsRows(w, 'email.takehome_invite')[0].properties.State.select.name, 'Cancelled');
  const local = (await h.runner.syncControl()).local;
  assert.equal((await h.runner.planTakeHomeInviteLinks({ now: NOW + 31 * 60_000, local })).length, 0);
  assert.equal(w.portalCalls.length, 0);
  // A portal error: Needs attention, Project told, never retried.
  const w2 = world(); w2.pages.set(...takeHomeTemplatePage()); w2.portalReply.fail = 500;
  const clock2 = { now: NOW };
  const h2 = await harness({ world: w2, clockRef: clock2, gmail: fakeGmail(), calendarFloor: NOW - 3600_000, env: { TAKEHOME_PORTAL_KEY: 'fixture-portal-key-0123456789' } });
  const key2 = await seedSentPrompt(h2);
  await formEvent(h2, 'form-TH3', key2, { decision: 'advance', observations: 'Solid.', nextStep: 'take_home', takehome: '', due: null, focus: '' });
  await h2.runner.runEvent({ eventId: 'form-TH3', attemptId: 'a1' });
  const local2 = (await h2.runner.syncControl()).local;
  clock2.now = NOW + 31 * 60_000;
  const [failed] = await h2.runner.planTakeHomeInviteLinks({ now: clock2.now, local: local2 });
  assert.equal(failed.reason, 'portal_failed:portal_http_500');
  assert.equal(opsRows(w2, 'email.takehome_invite')[0].properties.State.select.name, 'Needs attention');
  assert.match(masonPosts(w2).at(-1).body.text, /I tried to create Synthetic Candidate's take-home on Interviewer's site but didn't get a clear answer/);
  w2.portalReply.fail = 0;
  clock2.now = NOW + 40 * 60_000;
  assert.equal((await h2.runner.planTakeHomeInviteLinks({ now: clock2.now, local: local2 })).length, 0);
  assert.equal(w2.portalCalls.length, 1);
});

function fakeGmail({ connected = true, error = null, earlier = [] } = {}) {
  const sends = [], searches = [];
  const send = async m => {
    sends.push(m);
    if (error) { const e = new Error(error.code); e.code = error.code; e.uncertain = error.uncertain; throw e; }
    return { id: '18f0a1b2c3d4e5f6', threadId: '18f0a1b2c3d4e5f6', url: 'https://mail.google.com/mail/?authuser=project@company.example#all/18f0a1b2c3d4e5f6', sentAt: new Date(NOW).toISOString() };
  };
  return { sends, searches, connected: async () => connected, canSearch: async () => connected, send,
    sendTakeHomeInvite: m => send(m), async searchSent(q) { searches.push(q); return earlier; } };
}

test('manual take-home delivery blocks both duplicate portal creation and email; outages retry without losing the held invite',async()=>{
  const gmail=fakeGmail({earlier:[{url:'https://mail.google.com/mail/#sent/manual'}]});
  const {w,h,local,clockRef}=await takeHomeQueued(gmail,'manual-duplicate');
  assert.equal((await h.runner.planTakeHomeInviteLinks({now:clockRef.now,local}))[0].reason,'already_sent');
  assert.equal(w.portalCalls.length,0);assert.equal(gmail.sends.length,0);
  const good=fakeGmail();const v=await takeHomeQueued(good,'transient-read');const search=good.searchSent;
  good.searchSent=async()=>{throw Error('outage');};
  assert.equal((await v.h.runner.planTakeHomeInviteLinks({now:v.clockRef.now,local:v.local}))[0].reason,'sent_mail_unavailable');
  assert.equal(v.w.portalCalls.length,0);assert.equal(opsRows(v.w,'email.takehome_invite')[0].properties.State.select.name,'Held');
  good.searchSent=search;
  assert.equal((await v.h.runner.planTakeHomeInviteLinks({now:v.clockRef.now,local:v.local}))[0].action,'takehome_invite_sent');
  assert.equal(good.sends.length,1);assert.equal(v.w.portalCalls.length,1);
});

test('a real recap decision reaches the durable take-home queue with Slack microsecond timestamps',async()=>{
  const {applyRecapDecision}=await import('../service/lib/recap-decisions.mjs');
  const w=world();w.pages.set(...takeHomeTemplatePage());const gmail=fakeGmail();const h=await harness({world:w,gmail});
  const ts=`${Math.floor(NOW/1000)-300}.587219`,quote='Decision: Moving to take-home';
  const r=await applyRecapDecision({env:h.env,notion:h.notion,gmail,clock:h.clock,authorId:PEOPLE.robin,channelId:'C01D1A69CE3',messageTs:ts,
    candidatePageId:CANDIDATE_ID,name:'Synthetic Candidate',next:'take_home',quote,
    slackRead:{readThread:async()=>[{ts,user:PEOPLE.robin,text:`Interview recap — Synthetic Candidate\n${quote}`}]},
    takeHome:input=>h.runner.takeHomeFromRecap(input)});
  assert.equal(r.kind,'takehome_invite_queued',JSON.stringify(r));
  assert.equal(opsRows(w,'email.takehome_invite')[0].properties.State.select.name,'Held');
  assert.equal(gmail.sends.length,0);assert.equal(w.portalCalls.length,0);
  assert.equal(masonPosts(w).length,0,'recap acknowledgement replaces the routine queue DM');
  assert.equal((await h.store.listRequestsForCandidate({candidateId:CANDIDATE_ID})).filter(r=>r.action==='email.takehome_pending').length,0);
  assert.equal(Date.parse(r.dueAt),h.clock()+30*60_000,'normal hold is unchanged');
});

test('recap take-home queue failures still notify Project',async()=>{
  const w=world(),h=await harness({world:w}); // Missing template is a real blocker.
  await h.runner.takeHomeFromRecap({candidatePageId:CANDIDATE_ID,by:'Robin',quote:'Decision: Moving to take-home'});
  assert.ok(masonPosts(w).some(p=>/template is missing or changed shape/.test(p.body.text)));
  assert.equal(opsRows(w,'email.takehome_invite').length,0);
});

test('quiet recap invitation still sends once after the normal hold without a DM receipt',async()=>{
  const w=world();w.pages.set(...takeHomeTemplatePage());const gmail=fakeGmail(),clockRef={now:NOW};
  const h=await harness({world:w,gmail,clockRef,calendarFloor:NOW-3600_000,env:{TAKEHOME_PORTAL_KEY:'fixture-portal-key-0123456789'}});
  await h.runner.takeHomeFromRecap({candidatePageId:CANDIDATE_ID,by:'Robin',quote:'Decision: Moving to take-home'});
  const local=(await h.runner.syncControl()).local;
  assert.equal((await h.runner.planTakeHomeInviteLinks({now:clockRef.now,local})).length,0);
  clockRef.now+=31*60_000;
  assert.equal((await h.runner.planTakeHomeInviteLinks({now:clockRef.now,local}))[0].action,'takehome_invite_sent');
  assert.equal((await h.runner.planTakeHomeInviteLinks({now:clockRef.now,local})).length,0);
  assert.equal(gmail.sends.length,1);assert.equal(masonPosts(w).length,0);
});

test('explicit recap decision adapter preserves old hold history and verifies the resumed record; concurrent edit blocks it',async()=>{
  const w=world({candidateOverrides:{Outcome:sel('Not Selected'),'Action Status':sel('On Hold'),'Rejection email status':sel('Cancelled'),'Rejection email hold':{type:'checkbox',checkbox:true},'Rejection email attempt':rt('Already Not Selected before the October 13, 2026 delayed-rejection activation. Excluded from automatic backfill; no send is asserted. Review separately if outreach is still needed.')}}),h=await harness({world:w});
  const c=await h.notion.getCandidate(CANDIDATE_ID);
  const input={pageId:CANDIDATE_ID,expectedEmail:c.email,expectedLastEditedTime:c.lastEditedTime,outcome:'Proceeding',who:'Robin',quote:'Moving to take-home',sourceUrl:'https://example-workspace.slack.com/archives/C01D1A69CE3/p1792526569587219'};
  const r=await h.notion.applyExplicitRecapDecision(input);
  assert.equal(r.verified,true);assert.equal(r.candidate.fields.Outcome,'Proceeding');assert.equal(r.candidate.profile.latestEvidence,input.sourceUrl);
  assert.equal((await h.notion.getRejectionState(CANDIDATE_ID)).sender.attempt,null);
  assert.ok(w.calls.some(p=>/Prior status:/.test(JSON.stringify(p.body))));
  await assert.rejects(h.notion.applyExplicitRecapDecision({...input,expectedLastEditedTime:'wrong-version'}),/candidate_identity_changed/);
});
async function takeHomeQueued(gmail, eventId = 'form-THG', { takeHomePlanOf = null, env = {} } = {}) {
  const w = world(); w.pages.set(...takeHomeTemplatePage());
  const clockRef = { now: NOW };
  const h = await harness({ world: w, clockRef, calendarFloor: NOW - 3600_000, env: { TAKEHOME_PORTAL_KEY: 'fixture-portal-key-0123456789', ...env }, gmail, takeHomePlanOf });
  const key = await seedSentPrompt(h);
  await formEvent(h, eventId, key, { decision: 'advance', observations: 'Solid.', nextStep: 'take_home', takehome: '', due: null, focus: '' });
  await h.runner.runEvent({ eventId, attemptId: 'a1' });
  const local = (await h.runner.syncControl()).local;
  clockRef.now = NOW + 31 * 60_000;
  return { w, h, local, clockRef };
}

test('Project, Oct 15: with his Gmail connected, Uncle Sam emails the take-home itself right after the hold, once, and the clerk has nothing left to do', async () => {
  const gmail = fakeGmail();
  const { w, h, local, clockRef } = await takeHomeQueued(gmail);
  assert.match(masonPosts(w).at(-1).body.text, /^📋 Robin moved Synthetic Candidate on to the take-home\. In 30 minutes I'll create their take-home on Interviewer's site and email them the link from your Gmail, by about .*PT\. Tap Cancel to stop it\./);
  assert.equal(gmail.sends.length, 0, 'nothing during the Cancel window');
  const [done] = await h.runner.planTakeHomeInviteLinks({ now: clockRef.now, local });
  assert.equal(done.action, 'takehome_invite_sent', JSON.stringify(done));
  assert.equal(gmail.sends.length, 1);
  assert.deepEqual({ ...gmail.sends[0], body: undefined }, { to: candidate.email, cc: 'quinn@company.example', subject: 'Company AI Take-Home Assessment', url: 'https://company-takehome.vercel.app/c/vth_fixture1', body: undefined });
  assert.match(gmail.sends[0].body, /your take-home assessment link \(https:\/\/company-takehome\.vercel\.app\/c\/vth_fixture1\)\./);
  const [row] = opsRows(w, 'email.takehome_invite');
  assert.equal(row.properties.State.select.name, 'Complete', 'never Ready, so the clerk never sees it');
  assert.match((row.properties['Result evidence'].rich_text ?? []).map(x => x.plain_text).join(''), /^Sent by Uncle Sam from Project's Gmail https:\/\/mail\.google\.com\//);
  assert.match(gmail.searches[0], /company-takehome\.vercel\.app/, 'checked Sent before creating the assignment');
  // Project, 2026-10-19: once it has gone, the heads-up loses its Cancel button for a line saying it was sent.
  const swap = w.slackCalls.filter(c => c.method === 'chat.update').at(-1);
  const swapped = JSON.parse(swap.body.blocks);
  assert.ok(!swapped.some(b => b.type === 'actions'), 'no Cancel button left');
  assert.match(swapped.at(-1).elements[0].text, /^📨 Sent at .*PT\.$/);
  const headsUp = (await h.store.listRequestsForCandidate({ candidateId: candidate.pageId })).find(r => r.action === 'email.takehome_pending');
  assert.equal(headsUp.state, 'Complete', 'a late tap is told it is settled');
  // Project, 2026-10-19: its scorecard at once, Not started, so the portal monitor and the reminder rule can see the take-home.
  const [card] = madeCards(w);
  assert.ok(card, 'scorecard made');
  assert.deepEqual([card.properties['Take-home status'].select.name, card.properties.Type.select.name, card.properties['Assessment kind'].select.name,
    card.properties['Assignment / submission'].url, card.properties['On take-home website'].checkbox, card.properties.Candidate.relation[0].id],
  ['Not started', 'Take-home', 'Scorecard', 'https://company-takehome.vercel.app/c/vth_fixture1', true, CANDIDATE_ID]);
  assert.match(card.properties['Sent email'].url, /^https:\/\/mail\.google\.com\//);
  assert.match(card.properties.Sent.date.start, /^\d{4}-\d{2}-\d{2}$/);
  clockRef.now += 10 * 60_000;
  assert.equal((await h.runner.planTakeHomeInviteLinks({ now: clockRef.now, local })).length, 0);
  assert.equal(gmail.sends.length, 1, 'never twice');
});

const REMINDER_TEMPLATE = 'Subject: Company AI Take-Home Assessment\n\nHi {{candidate_first_name}},\n\nJust a quick reminder about your take-home assessment. Here’s [your take-home assessment link]({{takehome_link}}) again; it stays open for {{days_left}}.\n\nIf that timing doesn’t work for you, reply here and we can work out an alternative.';
test('Project, Oct 15/20: a take-home not started 3 days after the invite gets one reminder, no heads-up to Project, in the same thread with Interviewer cc\'d', async () => {
  const gmail = fakeGmail();
  const { w, h, local, clockRef } = await takeHomeQueued(gmail, 'form-NUD');
  await h.runner.planTakeHomeInviteLinks({ now: clockRef.now, local });
  const sentMs = clockRef.now;
  useScorecard(w, scorecardPage({ status: 'Not started', submittedAt: null, checkedAt: new Date(sentMs + 3 * 86400_000).toISOString() }));
  w.pages.set('1d9706bc-e3a3-4831-b893-b56022c4a176', { object: 'page', id: '1d9706bc-e3a3-4831-b893-b56022c4a176', archived: false,
    parent: { type: 'data_source_id', data_source_id: GUIDES_SOURCE_ID }, properties: { 'Full email': rt(REMINDER_TEMPLATE) } });
  clockRef.now = sentMs + 2 * 86400_000;
  assert.equal((await h.runner.planTakeHomeNudges({ now: clockRef.now, local })).filter(r => r.action).length, 0, 'not before 3 days');
  clockRef.now = sentMs + 3 * 86400_000 + 60_000;
  const queued = await h.runner.planTakeHomeNudges({ now: clockRef.now, local });
  assert.ok(queued.some(r => r.action === 'nudge_queued'), JSON.stringify(queued));
  assert.ok(queued.some(r => r.action === 'nudge_sent'), 'sent on the same run, no Cancel window');
  const [row] = opsRows(w, 'email.takehome_nudge');
  assert.equal(row.properties.State.select.name, 'Complete');
  const body = (row.properties['Email body'].rich_text ?? []).map(x => x.plain_text).join('');
  assert.equal(body, 'Hi Synthetic,\n\nJust a quick reminder about your take-home assessment. Here’s your take-home assessment link (https://company-takehome.vercel.app/c/vth_fixture1) again; it stays open for 4 more days.\n\nIf that timing doesn’t work for you, reply here and we can work out an alternative.');
  // Project, 2026-10-20: no heads-up for take-home reminders.
  assert.doesNotMatch(masonPosts(w).at(-1).body.text, /reminder/);
  const reminder = gmail.sends.at(-1);
  assert.deepEqual([reminder.to, reminder.cc, reminder.subject, reminder.replyTo], [candidate.email, 'quinn@company.example', 'Re: Company AI Take-Home Assessment', '18f0a1b2c3d4e5f6']);
  clockRef.now += 86400_000;
  await h.runner.planTakeHomeNudges({ now: clockRef.now, local });
  assert.equal(gmail.sends.length, 2, 'one reminder only');
});

test('Project, Oct 19: an Uncle Sam take-home with no scorecard gets one made (no reminder that run); a status the portal monitor has not refreshed in 36h sends nothing, quietly', async () => {
  const gmail = fakeGmail();
  const { w, h, local, clockRef } = await takeHomeQueued(gmail, 'form-NUD3', { env: { DB: 'fixture' } });
  await h.runner.planTakeHomeInviteLinks({ now: clockRef.now, local });
  const sentMs = clockRef.now;
  for (const p of madeCards(w)) w.pages.delete(p.id);
  w.pages.set('1d9706bc-e3a3-4831-b893-b56022c4a176', { object: 'page', id: '1d9706bc-e3a3-4831-b893-b56022c4a176', archived: false,
    parent: { type: 'data_source_id', data_source_id: GUIDES_SOURCE_ID }, properties: { 'Full email': rt(REMINDER_TEMPLATE) } });
  clockRef.now = sentMs + 3 * 86400_000 + 60_000;
  const first = await h.runner.planTakeHomeNudges({ now: clockRef.now, local });
  assert.ok(first.some(r => r.reason === 'scorecard_created'), JSON.stringify(first));
  assert.equal(madeCards(w).length, 1);
  assert.equal(madeCards(w)[0].properties['Take-home status'].select.name, 'Not started');
  assert.equal(opsRows(w, 'email.takehome_nudge').length, 0, 'not on the run that made it');
  // Never checked by the portal monitor: not trusted.
  clockRef.now += 60_000;
  const second = await h.runner.planTakeHomeNudges({ now: clockRef.now, local });
  assert.ok(second.some(r => r.reason === 'status_stale'), JSON.stringify(second));
  assert.equal(opsRows(w, 'email.takehome_nudge').length, 0);
  const told = masonPosts(w).length;
  madeCards(w)[0].created_time = new Date(clockRef.now - 7 * 3600_000).toISOString();
  clockRef.now += 60_000;
  await h.runner.planTakeHomeNudges({ now: clockRef.now, local });
  assert.equal(masonPosts(w).length, told, 'waits quietly (Project, 2026-10-20: no messages about take-home reminders)');
  // Checked 2 days ago: still stale.
  useScorecard(w, scorecardPage({ status: 'Not started', submittedAt: null, checkedAt: new Date(clockRef.now - 2 * 86400_000).toISOString() }));
  clockRef.now += 60_000;
  assert.ok((await h.runner.planTakeHomeNudges({ now: clockRef.now, local })).some(r => r.reason === 'status_stale'));
  // Checked an hour ago: the reminder queues.
  w.pages.get(SCORECARD_ID).properties['Score checked at'] = date(new Date(clockRef.now - 3600_000).toISOString());
  clockRef.now += 60_000;
  const fresh = await h.runner.planTakeHomeNudges({ now: clockRef.now, local });
  assert.ok(fresh.some(r => r.action === 'nudge_sent'), JSON.stringify(fresh));
  assert.equal(gmail.sends.length, 2, 'the invite and the reminder');
  assert.equal(masonPosts(w).length, told, 'no message to Project');
});

test('Project, Oct 19: a take-home sent by hand (scorecard only, no Uncle Sam invite) gets the same reminder, in the thread of the email in his Sent mail; none when he already followed up', async () => {
  const run = async ({ followedUp = false, night = false } = {}) => {
    const w = world();
    const clockRef = { now: NOW };
    const sentAt = new Date(NOW - 3 * 86400_000 - 3600_000).toISOString();
    const sentDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(Date.parse(sentAt));
    const invite = { id: '19a1b2c3d4e5f607', threadId: '19a1b2c3d4e5f607', subject: 'Company AI Take-Home Assessment', sentAt, url: 'https://mail.google.com/mail/?authuser=project@company.example#all/19a1b2c3d4e5f607' };
    const later = { id: '19a1b2c3d4e5f6ff', threadId: '19a1b2c3d4e5f607', subject: 'Re: Company AI Take-Home Assessment', sentAt: new Date(NOW - 86400_000).toISOString(), url: 'https://mail.google.com/x' };
    const gmail = fakeGmail({ earlier: followedUp ? [later, invite] : [invite] });
    const h = await harness({ world: w, clockRef, calendarFloor: NOW - 3600_000, env: { TAKEHOME_PORTAL_KEY: 'fixture-portal-key-0123456789', DB: 'fixture' }, gmail });
    const local = (await h.runner.syncControl()).local;
    w.pages.set(SCORECARD_ID, scorecardPage({ status: 'Not started', submittedAt: null, checkedAt: new Date(NOW - 3600_000).toISOString(), sentOn: sentDay,
      link: 'https://company-takehome.vercel.app/c/vth_hand1', sentEmail: invite.url }));
    w.pages.set('1d9706bc-e3a3-4831-b893-b56022c4a176', { object: 'page', id: '1d9706bc-e3a3-4831-b893-b56022c4a176', archived: false,
      parent: { type: 'data_source_id', data_source_id: GUIDES_SOURCE_ID }, properties: { 'Full email': rt(REMINDER_TEMPLATE) } });
    const { withinSendingHours } = await import('../service/lib/takehome-nudge.mjs');
    clockRef.now = withinSendingHours(Date.parse(sentAt) + 3 * 86400_000) + 60_000;
    if (night) { const { laWall, laDate } = await import('../service/lib/takehome-nudge.mjs'); clockRef.now = laWall(laDate(clockRef.now + 86400_000), 23); }
    w.pages.get(SCORECARD_ID).properties['Score checked at'] = date(new Date(clockRef.now - 3600_000).toISOString());
    return { w, h, local, clockRef, gmail, out: await h.runner.planTakeHomeNudges({ now: clockRef.now, local }) };
  };
  const { w, h, local, clockRef, gmail, out } = await run();
  assert.ok(out.some(r => r.action === 'nudge_queued'), JSON.stringify(out));
  assert.match(gmail.searches[0], /^to:.+ \("Take-Home Assessment" OR "Research Take-Home"\) newer_than:14d$/);
  const [row] = opsRows(w, 'email.takehome_nudge');
  assert.match((row.properties['Email body'].rich_text ?? []).map(x => x.plain_text).join(''), /your take-home assessment link \(https:\/\/company-takehome\.vercel\.app\/c\/vth_hand1\) again; it stays open for \d more days?\./);
  assert.ok(out.some(r => r.action === 'nudge_sent'), JSON.stringify(out));
  const reminder = gmail.sends.at(-1);
  assert.deepEqual([reminder.to, reminder.cc, reminder.subject, reminder.replyTo], [candidate.email, 'quinn@company.example', 'Re: Company AI Take-Home Assessment', '19a1b2c3d4e5f607']);
  assert.equal(madeCards(w).length, 0, 'no second scorecard for a hand-sent take-home');
  const again = await run({ followedUp: true });
  assert.ok(again.out.some(r => r.reason === 'already_followed_up'), JSON.stringify(again.out));
  assert.equal(opsRows(again.w, 'email.takehome_nudge').length, 0);
  // Due at 11pm PT: queued, but it goes out when sending hours open, never at night.
  const late = await run({ night: true });
  assert.ok(late.out.some(r => r.action === 'nudge_queued'), JSON.stringify(late.out));
  const { withinSendingHours: opens } = await import('../service/lib/takehome-nudge.mjs');
  const [lateRow] = opsRows(late.w, 'email.takehome_nudge');
  assert.equal(Date.parse(lateRow.properties['Due at'].date.start), opens(late.clockRef.now));
  assert.ok(opens(late.clockRef.now) > late.clockRef.now, '11pm PT is outside sending hours');
  late.clockRef.now += 31 * 60_000;
  assert.ok((await late.h.runner.planTakeHomeNudges({ now: late.clockRef.now, local: late.local })).every(r => r.action !== 'nudge_sent'));
  assert.equal(late.gmail.sends.length, 0);
});

test('Take-home reminder: started, or a later day the candidate named, means no reminder yet', async () => {
  const { nudgeDueAt, laWall } = await import('../service/lib/takehome-nudge.mjs');
  const mon = laWall('2026-10-19', 10);
  assert.equal(nudgeDueAt({ sentMs: mon }), laWall('2026-10-22', 10), 'Thursday: 3 days');
  assert.equal(nudgeDueAt({ sentMs: mon, planDate: '2026-10-23' }), laWall('2026-10-24', 12), 'said Friday: Saturday, in the noon–5pm Saturday window');
  assert.equal(nudgeDueAt({ sentMs: laWall('2026-10-21', 18) }), laWall('2026-10-26', 9), 'due Saturday 6pm: past the Saturday window, no Sunday sends, so Monday 9am');
  assert.equal(nudgeDueAt({ sentMs: mon, planDate: '2026-10-20' }), laWall('2026-10-22', 10), 'an earlier day never brings it forward');
  assert.equal(nudgeDueAt({ sentMs: mon, planDate: '2026-10-25' }), null, 'past the link closing: no reminder, Project is warned instead');
  const { planFromNotes } = await import('../service/lib/takehome-nudge.mjs');
  const claudeSaid = input => ({ complete: async () => ({ content: [{ type: 'tool_use', name: 'plan', input }] }) });
  const notes = [{ at: '2026-10-20T18:00:00Z', source: 'slack-dm', text: 'Robin: Synthetic said on LinkedIn he will do the take-home over the weekend.' }];
  assert.deepEqual(await planFromNotes({ claude: claudeSaid({ planned_date: '2026-10-25', note_index: 0, quote: 'he will do the take-home over the weekend' }), notes, sentMs: mon }),
    { date: '2026-10-25', quote: 'he will do the take-home over the weekend', source: 'slack-dm' });
  assert.equal(await planFromNotes({ claude: claudeSaid({ planned_date: '2026-10-25', note_index: 0, quote: 'he promised Sunday' }), notes, sentMs: mon }), null, 'quote not in the note');
  assert.equal(nudgeDueAt({ sentMs: laWall('2026-10-19', 21) }), laWall('2026-10-22', 21), 'weekdays until 10pm (Project, 2026-10-20)');
  assert.equal(nudgeDueAt({ sentMs: laWall('2026-10-19', 22, 30) }), laWall('2026-10-23', 9), 'overnight: waits for 9am');
  const gmail = fakeGmail();
  const { w, h, local, clockRef } = await takeHomeQueued(gmail, 'form-NUD2', { takeHomePlanOf: async () => ({ date: '2099-01-01' }) });
  await h.runner.planTakeHomeInviteLinks({ now: clockRef.now, local });
  const sentMs = clockRef.now;
  useScorecard(w, scorecardPage({ status: 'Started', submittedAt: null, checkedAt: new Date(sentMs + 3 * 86400_000).toISOString() }));
  clockRef.now = sentMs + 3 * 86400_000 + 60_000;
  assert.equal((await h.runner.planTakeHomeNudges({ now: clockRef.now, local })).filter(r => r.action === 'nudge_queued').length, 0);
  assert.equal(opsRows(w, 'email.takehome_nudge').length, 0);
});

test('Uncle Sam\'s Gmail send: one sender. A clear refusal or no connection is Needs attention and Project told at once; an unclear result is never retried', async () => {
  const refused = fakeGmail({ error: { code: 'gmail_signature_http_403', uncertain: false } });
  const a = await takeHomeQueued(refused, 'form-THR');
  const [left] = await a.h.runner.planTakeHomeInviteLinks({ now: a.clockRef.now, local: a.local });
  assert.equal(left.reason, 'not_sent:gmail_signature_http_403');
  assert.equal(opsRows(a.w, 'email.takehome_invite')[0].properties.State.select.name, 'Needs attention');
  assert.match(masonPosts(a.w).at(-1).body.text, /couldn't email it from your Gmail \(gmail_signature_http_403\)\. Nothing went out/);
  const unclear = fakeGmail({ error: { code: 'gmail_timeout', uncertain: true } });
  const b = await takeHomeQueued(unclear, 'form-THU');
  const [held] = await b.h.runner.planTakeHomeInviteLinks({ now: b.clockRef.now, local: b.local });
  assert.equal(held.reason, 'gmail_uncertain:gmail_timeout');
  assert.equal(opsRows(b.w, 'email.takehome_invite')[0].properties.State.select.name, 'Needs attention');
  assert.match(masonPosts(b.w).at(-1).body.text, /didn't get a clear answer \(gmail_timeout\)\. Check your Sent mail/);
  b.clockRef.now += 10 * 60_000;
  assert.equal((await b.h.runner.planTakeHomeInviteLinks({ now: b.clockRef.now, local: b.local })).length, 0);
  assert.equal(unclear.sends.length, 1);
  // Not connected: nothing goes out and Project hears; the clerk never sends (Project, Oct 15).
  const off = fakeGmail({ connected: false });
  const c = await takeHomeQueued(off, 'form-THO');
  assert.match(masonPosts(c.w).at(-1).body.text, /email them the link from your Gmail, by about/);
  await c.h.runner.planTakeHomeInviteLinks({ now: c.clockRef.now, local: c.local });
  assert.equal(off.sends.length, 0);
  assert.equal(opsRows(c.w, 'email.takehome_invite')[0].properties.State.select.name, 'Needs attention');
  assert.match(masonPosts(c.w).at(-1).body.text, /gmail_not_connected/);
});

test('Form: "do not advance" from Robin starts his rejection confirmation; from another interviewer it goes to Project as a recommendation', async () => {
  const w = world(); const h = await harness({ world: w }); const key = await seedSentPrompt(h);
  await formEvent(h, 'form-V6', key, { decision: 'do_not_advance', observations: 'Could not structure the case.' });
  const result = await h.runner.runEvent({ eventId: 'form-V6', attemptId: 'a1' });
  assert.equal(result.outcome, 'record_feedback', JSON.stringify(result));
  const confirm = w.slackCalls.filter(c => c.method === 'chat.postMessage' && c.body.channel === RISHI_DM);
  assert.equal(confirm.length, 1); assert.match(confirm[0].body.text, /^📋 I need your word on this one: confirm Synthetic Candidate is rejected/);
  assert.equal(masonPosts(w).length, 0);
  assert.equal(w.patches()[0].body.properties['Next action'].rich_text[0].text.content, 'Interviewer (Robin, Alexis or Interviewer): confirm the rejection before anything is sent.');
  // Did not happen: Project hears exactly what happened and the new time.
  const w2 = world(); const h2 = await harness({ world: w2 }); const key2 = await seedSentPrompt(h2);
  await formEvent(h2, 'form-V7', key2, { decision: 'did_not_happen', observations: '', whatHappened: 'rescheduled', newDate: '2026-10-19', newTime: '2:00 PM PT' });
  await h2.runner.runEvent({ eventId: 'form-V7', attemptId: 'a1' });
  assert.match(w2.slackCalls.filter(c => c.method === 'chat.postMessage' && c.body.channel === routeMap.project.channelId)[0].body.text,
    /What happened: Rescheduled; new date Mon, Oct 19, 2026 2:00 PM PT\. Project: confirm the new time Mon, Oct 19, 2026 2:00 PM PT\./);
});

test('Project, Oct 15: Robin confirming a rejection in his DM closes the record as Not Selected; Project hears who rejected whom', async () => {
  const confirmed = [[{ name: 'propose', input: { kind: 'rejection_confirmed', candidatePageId: CANDIDATE_ID, evidence: 'yes, reject' } }]];
  const w = world(); const h = await harness({ world: w, script: confirmed }); await seedSentPrompt(h);
  await h.store.recordEvent(slackEvent('Ev-rc1', { text: 'yes, reject him' }));
  const result = await h.runner.runEvent({ eventId: 'Ev-rc1', attemptId: 'a1' });
  assert.equal(result.status, 'processed', JSON.stringify(result));
  assert.ok(result.sideEffects.includes('candidate_closed'), JSON.stringify(result));
  const props = Object.assign({}, ...w.patches().map(c => c.body.properties ?? {}));
  assert.equal(props.Outcome.select.name, 'Not Selected');
  assert.match(props['Next action'].rich_text[0].text.content, /^None\. Not selected \(Robin confirmed in Slack/);
  assert.equal(props['Last interview ended at'].date.start, new Date(1791926460 * 1000).toISOString(), 'no logged interview: the confirmation stands in');
  assert.equal(masonPosts(w).length, 1);
  assert.equal(masonPosts(w)[0].body.text, '🪖 Robin selected reject on Synthetic Candidate. Marked Not Selected in the tracker.');
  const reply = w.slackCalls.filter(c => c.method === 'chat.postMessage' && c.body.channel === RISHI_DM).at(-1);
  assert.equal(reply.body.thread_ts, ROOT_TS);
  assert.match(reply.body.text, /^🫡 Recorded\. Synthetic Candidate is marked Not Selected\. The rejection email goes out from Project's account after /);
  // Someone without the authority, or outside their own DM, still goes to Project as before.
  const w2 = world(); const h2 = await harness({ world: w2, script: confirmed }); await seedSentPrompt(h2);
  await h2.store.recordEvent(slackEvent('Ev-rc2', { text: 'yes reject', authorId: PEOPLE.jamie }));
  await h2.runner.runEvent({ eventId: 'Ev-rc2', attemptId: 'a1' });
  assert.equal(w2.patches().some(c => c.body.properties?.Outcome), false);
});

test('Project, Oct 15: the confirmation question has a Confirm reject button; tapping it closes the record, Not yet changes nothing', async () => {
  const w = world(); const h = await harness({ world: w }); const key = await seedSentPrompt(h);
  await formEvent(h, 'form-RB1', key, { decision: 'do_not_advance', observations: 'Could not structure the case.' });
  await h.runner.runEvent({ eventId: 'form-RB1', attemptId: 'a1' });
  const question = w.slackCalls.filter(c => c.method === 'chat.postMessage' && c.body.channel === RISHI_DM).at(-1);
  const blocksOf = b => (typeof b === 'string' ? JSON.parse(b) : b);
  const buttons = blocksOf(question.body.blocks).find(b => b.type === 'actions').elements;
  assert.deepEqual(buttons.map(b => b.action_id), ['rj_confirm', 'rj_not_yet']);
  assert.equal(buttons[0].confirm.confirm.text, 'Reject');
  const requestKey = buttons[0].value;
  // Someone else's tap does nothing.
  await h.store.recordEvent({ eventId: 'rjb-0', source: 'slack', type: 'rejection_button', occurredAt: NOW, isFixture: false, authorId: PEOPLE.jamie, requestKey, decision: 'confirm' });
  assert.equal((await h.runner.runEvent({ eventId: 'rjb-0', attemptId: 'a1' })).reason, 'not_allowed');
  await h.store.recordEvent({ eventId: 'rjb-1', source: 'slack', type: 'rejection_button', occurredAt: NOW, isFixture: false, authorId: PEOPLE.robin, requestKey, decision: 'confirm' });
  const result = await h.runner.runEvent({ eventId: 'rjb-1', attemptId: 'a1' });
  assert.equal(result.outcome, 'rejection_confirmed', JSON.stringify(result));
  assert.ok(result.sideEffects.includes('candidate_closed'));
  const props = Object.assign({}, ...w.patches().map(c => c.body.properties ?? {}));
  assert.equal(props.Outcome.select.name, 'Not Selected');
  assert.equal(masonPosts(w).at(-1).body.text, '🪖 Robin selected reject on Synthetic Candidate. Marked Not Selected in the tracker.');
  assert.ok(w.slackCalls.some(c => c.method === 'chat.update' && /Robin confirmed the reject/.test(JSON.stringify(c.body.blocks))), 'the buttons give way to the answer');
  await h.store.recordEvent({ eventId: 'rjb-2', source: 'slack', type: 'rejection_button', occurredAt: NOW, isFixture: false, authorId: PEOPLE.robin, requestKey, decision: 'confirm' });
  assert.equal((await h.runner.runEvent({ eventId: 'rjb-2', attemptId: 'a1' })).reason, 'already_answered');
  // Not yet: nothing closes, Project hears nothing.
  const w2 = world(); const h2 = await harness({ world: w2 }); const key2 = await seedSentPrompt(h2);
  await formEvent(h2, 'form-RB2', key2, { decision: 'do_not_advance', observations: 'x' });
  await h2.runner.runEvent({ eventId: 'form-RB2', attemptId: 'a1' });
  const q2 = w2.slackCalls.filter(c => c.method === 'chat.postMessage' && c.body.channel === RISHI_DM).at(-1);
  const key3 = blocksOf(q2.body.blocks).find(b => b.type === 'actions').elements[1].value;
  await h2.store.recordEvent({ eventId: 'rjb-3', source: 'slack', type: 'rejection_button', occurredAt: NOW, isFixture: false, authorId: PEOPLE.robin, requestKey: key3, decision: 'not_yet' });
  assert.equal((await h2.runner.runEvent({ eventId: 'rjb-3', attemptId: 'a1' })).outcome, 'rejection_not_yet');
  assert.equal(w2.patches().some(c => c.body.properties?.Outcome), false);
  assert.equal(masonPosts(w2).length, 0);
});

test('Typed: a work trial without dates goes to Project to ask the candidate (Project, Oct 15); with dates it goes straight to booking', async () => {
  const bullets = ['Status: R2 done; Robin recommends advancing', 'Assessment: sharp', 'Open items: book the next step'];
  const typed = extra => [[{ name: 'propose', input: { kind: 'record_feedback', candidatePageId: CANDIDATE_ID, decision: 'advance', briefBullets: bullets,
    nextAction: 'Project to book it', evidence: 'Advance to work trial', ...extra } }]];
  const w = world(); const h = await harness({ world: w, script: typed({ nextStep: 'work_trial' }) }); await seedSentPrompt(h);
  await h.store.recordEvent(slackEvent('Ev-t1', { text: 'Advance to a work trial' }));
  await h.runner.runEvent({ eventId: 'Ev-t1', attemptId: 'a1' });
  assert.equal(w.slackCalls.filter(c => c.method === 'chat.postMessage' && c.body.channel === RISHI_DM).length, 0, 'Robin is not asked for dates');
  assert.match(masonPosts(w)[0].body.text, /Robin moved them on to a work trial\. Send them the work-trial request for information to get their dates, then book it\./);
  const w2 = world(); const h2 = await harness({ world: w2, script: typed({ nextStep: 'work_trial', trialStart: '2026-10-20', trialEnd: '2026-10-24' }) }); await seedSentPrompt(h2);
  await h2.store.recordEvent(slackEvent('Ev-t2', { text: 'Advance to a work trial Oct 20 to 24' }));
  await h2.runner.runEvent({ eventId: 'Ev-t2', attemptId: 'a1' });
  assert.equal(w2.slackCalls.filter(c => c.method === 'chat.postMessage' && c.body.channel === RISHI_DM).length, 0, 'nothing to ask');
  assert.match(masonPosts(w2)[0].body.text, /Robin moved them on to a work trial Tue, Oct 20, 2026 to Sat, Oct 24, 2026\. Book it and start onboarding\. Project to book it/);
  // Dates that make no sense are not dates: the candidate is asked instead.
  const w3 = world(); const h3 = await harness({ world: w3, script: typed({ nextStep: 'work_trial', trialStart: '2026-10-24', trialEnd: '2026-10-20' }) }); await seedSentPrompt(h3);
  await h3.store.recordEvent(slackEvent('Ev-t3', { text: 'Work trial 24th to 20th' }));
  await h3.runner.runEvent({ eventId: 'Ev-t3', attemptId: 'a1' });
  assert.match(masonPosts(w3)[0].body.text, /request for information/);
});

test('Next-step form: answering the "what is the next step" question books it and closes the question, once', async () => {
  const w = world();
  const h = await harness({ world: w, script: [[{ name: 'propose', input: { kind: 'record_feedback', candidatePageId: CANDIDATE_ID, decision: 'advance',
    briefBullets: ['Status: done', 'Assessment: good', 'Open items: next step'], nextAction: 'Project to book the next round', evidence: 'Advance to the next round' } }]] });
  await seedSentPrompt(h);
  await h.store.recordEvent(slackEvent('Ev-n1', { text: 'Advance to the next round' }));
  await h.runner.runEvent({ eventId: 'Ev-n1', attemptId: 'a1' });
  const question = (await h.store.listRequestsForCandidate({ candidateId: CANDIDATE_ID })).find(r => r.action === 'interview.next_step_request');
  assert.equal(question.state, 'Sent');
  await formEvent(h, 'form-N1', question.requestKey, { decision: 'advance', nextStepOnly: true, observations: '', ...TRIAL, observations: '' });
  const result = await h.runner.runEvent({ eventId: 'form-N1', attemptId: 'a2' });
  assert.equal(result.outcome, 'next_step_recorded', JSON.stringify(result));
  assert.equal((await h.store.getRequest(question.requestKey)).state, 'Complete');
  assert.match(masonPosts(w).at(-1).body.text, /Robin moved them on to a work trial Tue, Oct 20, 2026 to Sat, Oct 24, 2026/);
  const notes = w.calls.filter(c => c.method === 'PATCH' && c.path === `/blocks/${CANDIDATE_ID}/children`);
  assert.match(JSON.stringify(notes.at(-1).body), /Next step \(via Uncle Sam\)/);
  await formEvent(h, 'form-N2', question.requestKey, { ...TRIAL, nextStepOnly: true });
  assert.equal((await h.runner.runEvent({ eventId: 'form-N2', attemptId: 'a3' })).outcome, 'no_action');
});

// Take-home reviews: a scorecard the portal sync marked Complete puts the submission to Interviewer, with buttons.
const SCORECARD_ID = '22222222-3333-4444-8555-666666666666';
const TH_FLOOR = Date.parse('2026-10-13T07:30:00Z');
const SANTOSH_DM = routeMap.interviewer.channelId;
function scorecardPage({ submittedAt = '2026-10-13T20:00:00.000Z', status = 'Complete', review = 'Not recorded', score = 83, candidateIds = [CANDIDATE_ID], checkedAt = null, sentOn = null, link = null, sentEmail = null } = {}) {
  return { object: 'page', id: SCORECARD_ID, url: `https://www.notion.so/${SCORECARD_ID.replaceAll('-', '')}`, archived: false,
    parent: { type: 'data_source_id', data_source_id: FEEDBACK_SOURCE_ID }, properties: {
      'Log score': { type: 'title', title: [{ plain_text: 'Synthetic Candidate', text: { content: 'Synthetic Candidate' } }] },
      Type: sel('Take-home'), 'Assessment kind': sel('Scorecard'), Status: sel('Draft'), 'Take-home status': sel(status),
      'Submitted at': date(submittedAt), 'Score / 100': { type: 'number', number: score }, 'Interviewer review': sel(review),
      'Reviewer score / 100': { type: 'number', number: null }, Candidate: { type: 'relation', relation: candidateIds.map(id => ({ id })) },
      'Score checked at': date(checkedAt), Sent: date(sentOn), 'Assignment / submission': { type: 'url', url: link }, 'Sent email': { type: 'url', url: sentEmail } } };
}
/** The take-home scorecard(s) Uncle Sam made itself (not the fixture SCORECARD_ID). */
const madeCards = w => [...w.pages.values()].filter(p => p.parent?.data_source_id === FEEDBACK_SOURCE_ID && p.id !== SCORECARD_ID);
/** Replaces the card Uncle Sam made at send with the fixture scorecard (one current card per candidate). */
function useScorecard(w, page) { for (const p of madeCards(w)) w.pages.delete(p.id); w.pages.set(SCORECARD_ID, page); }
function bookingRow() {
  const id = '33333333-4444-4555-8666-777777777777';
  return [id, { object: 'page', id, archived: false, parent: { type: 'data_source_id', data_source_id: GUIDES_SOURCE_ID }, properties: {
    Interviewer: sel('Interviewer (Quinn)'), 'Use for': sel('Technical interview'), 'Booking link': { type: 'url', url: 'https://calendly.com/quinn-synthetic/technical-deep-dive' } } }];
}
const santoshPosts = w => w.slackCalls.filter(c => c.method === 'chat.postMessage' && c.body.channel === SANTOSH_DM);
const DEEP_DIVE_TEMPLATE = 'Subject: Company — Technical Deep Dive\n\nHi {{candidate_first_name}},\n\nThank you for completing the take-home assessment.\n\nPlease select the times that work for you using Interviewer’s scheduling link: {{santosh_deep_dive_link}}';
function templatePage(text = DEEP_DIVE_TEMPLATE) {
  return [DEEP_DIVE_TEMPLATE_ID, { object: 'page', id: DEEP_DIVE_TEMPLATE_ID, archived: false, parent: { type: 'data_source_id', data_source_id: GUIDES_SOURCE_ID },
    properties: { 'Full email': rt(text) } }];
}
const opsRows = (w, action) => [...w.pages.values()].filter(p => p.parent?.data_source_id === OPS_SOURCE_ID && (p.properties.Action?.rich_text ?? []).map(x => x.plain_text).join('') === action);
async function takeHomeWorld(scorecard = {}, { template = DEEP_DIVE_TEMPLATE, gmail = null, calendarIds = [] } = {}) {
  const w = world();
  w.pages.set(SCORECARD_ID, scorecardPage(scorecard));
  w.pages.set(...bookingRow());
  if (template) w.pages.set(...templatePage(template));
  const clockRef = { now: NOW };
  const h = await harness({ world: w, clockRef, calendarFloor: TH_FLOOR, gmail, calendarIds });
  const plan = async () => h.runner.planTakeHomeReviews({ now: clockRef.now, local: (await h.runner.syncControl()).local });
  return { w, h, clockRef, plan };
}
const thForm = (h, eventId, requestKey, form, authorId = PEOPLE.interviewer) => h.store.recordEvent({ eventId, source: 'slack', type: 'takehome_form',
  occurredAt: NOW, isFixture: false, authorId, requestKey, form });

test('Take-home: a new submission goes to Interviewer once with buttons, one reminder after a day, nothing more', async () => {
  const { w, h, clockRef, plan } = await takeHomeWorld();
  const [first] = await plan();
  assert.equal(first.action, 'takehome.grading_request'); assert.equal(first.dispatch, 'sent');
  assert.equal(santoshPosts(w).length, 1);
  const post = santoshPosts(w)[0].body;
  assert.equal(post.text.split('\n')[0], "🫵 New take-home in: Synthetic Candidate submitted Tue, Oct 13, 2026, portal score 83/100. I want YOU on it: three quick steps below, or reply here.");
  const blocks = typeof post.blocks === 'string' ? JSON.parse(post.blocks) : post.blocks;
  assert.deepEqual(blocks.map(b => b.type), ['section', 'context', 'actions', 'context']);
  assert.equal(blocks[1].elements[0].text, '🫵 Step 1 of 3 · Look it over, then make your call.');
  const buttons = blocks.find(b => b.type === 'actions').elements;
  assert.deepEqual(buttons.map(b => b.action_id), ['th_portal', 'th_advance', 'th_do_not_advance']);
  assert.equal(buttons[1].value, first.requestKey);
  assert.equal((await plan())[0].reason, 'awaiting_answer'); assert.equal(santoshPosts(w).length, 1, 'never asked twice');
  clockRef.now = NOW + 25 * 3600_000;
  const [reminded] = await plan();
  assert.equal(reminded.action, 'takehome.grading_reminder');
  assert.match(santoshPosts(w)[1].body.text, /^📯 Synthetic Candidate's take-home is still waiting on your call\./);
  clockRef.now = NOW + 60 * 3600_000;
  assert.equal((await plan())[0].reason, 'awaiting_answer'); assert.equal(santoshPosts(w).length, 2, 'one reminder only');
});

test('Project, Oct 15: with his Gmail connected, Uncle Sam sends the deep-dive invite itself after the hold, forwards it to Interviewer, once', async () => {
  const gmail = fakeGmail();
  const { w, h, clockRef, plan } = await takeHomeWorld({}, { gmail });
  const [first] = await plan();
  await thForm(h, 'thform-DG', first.requestKey, { decision: 'advance', observations: 'Good.', score: null, nextStep: 'deep_dive' });
  await h.runner.runEvent({ eventId: 'thform-DG', attemptId: 'a1' });
  const [held] = opsRows(w, 'email.deep_dive_invite');
  assert.equal(held.properties.State.select.name, 'Held', 'the clerk never sees it');
  assert.match(masonPosts(w).at(-1).body.text, /I'll email them Interviewer's deep-dive link from your Gmail, by about 5:35pm PT\. Tap Cancel to stop it\./);
  const local = (await h.runner.syncControl()).local;
  assert.equal((await h.runner.planDeepDiveInvites({ now: NOW + 10 * 60_000, local })).length, 0, 'not during the hold');
  clockRef.now = NOW + 31 * 60_000;
  const [done] = await h.runner.planDeepDiveInvites({ now: clockRef.now, local });
  assert.equal(done.action, 'deep_dive_invite_sent', JSON.stringify(done));
  assert.equal(gmail.sends.length, 1, 'one email, Interviewer cc\'d (no separate forward)');
  assert.equal(gmail.sends[0].cc, 'quinn@company.example');
  const link = 'https://calendly.com/quinn-synthetic/technical-deep-dive';
  assert.deepEqual(gmail.sends[0].links, [{ phrase: `Interviewer’s scheduling link: ${link}`, text: 'Interviewer’s scheduling link', url: link }]);
  assert.equal(gmail.sends[0].to, candidate.email); assert.equal(gmail.sends[0].subject, 'Company — Technical Deep Dive');
  assert.match(gmail.searches[0], /subject:"Technical Deep Dive" newer_than:14d$/);
  const [row] = opsRows(w, 'email.deep_dive_invite');
  assert.equal(row.properties.State.select.name, 'Complete');
  clockRef.now += 10 * 60_000;
  assert.equal((await h.runner.planDeepDiveInvites({ now: clockRef.now, local })).length, 0);
  assert.equal(gmail.sends.length, 1, 'never twice');
  // Already in Sent mail: nothing sent, recorded.
  const dup = fakeGmail({ earlier: [{ id: 'abc123', url: 'https://mail.google.com/x', sentAt: null }] });
  const b = await takeHomeWorld({}, { gmail: dup });
  const [q] = await b.plan();
  await thForm(b.h, 'thform-DG2', q.requestKey, { decision: 'advance', observations: 'Good.', score: null, nextStep: 'deep_dive' });
  await b.h.runner.runEvent({ eventId: 'thform-DG2', attemptId: 'a1' });
  b.clockRef.now = NOW + 31 * 60_000;
  const [skip] = await b.h.runner.planDeepDiveInvites({ now: b.clockRef.now, local: (await b.h.runner.syncControl()).local });
  assert.equal(skip.reason, 'already_sent'); assert.equal(dup.sends.length, 0);
});

const DD_REMINDER = 'Subject: Company — Technical Deep Dive\n\nHi {{candidate_first_name}},\n\nJust a quick reminder to book your technical deep dive. Here’s Interviewer’s scheduling link: {{santosh_deep_dive_link}}\n\nIf none of the times work for you, reply here and we can find another time.';
async function deepDiveSent(gmail, eventId) {
  const t = await takeHomeWorld({}, { gmail, calendarIds: ['quinn@company.example'] });
  const [first] = await t.plan();
  await thForm(t.h, eventId, first.requestKey, { decision: 'advance', observations: 'Good.', score: null, nextStep: 'deep_dive' });
  await t.h.runner.runEvent({ eventId, attemptId: 'a1' });
  t.local = (await t.h.runner.syncControl()).local;
  t.clockRef.now = NOW + 31 * 60_000;
  const [done] = await t.h.runner.planDeepDiveInvites({ now: t.clockRef.now, local: t.local });
  assert.equal(done.action, 'deep_dive_invite_sent', JSON.stringify(done));
  t.w.pages.set('eada5af1-dfc4-414f-b772-c44e0654a116', { object: 'page', id: 'eada5af1-dfc4-414f-b772-c44e0654a116', archived: false,
    parent: { type: 'data_source_id', data_source_id: GUIDES_SOURCE_ID }, properties: { 'Full email': rt(DD_REMINDER) } });
  return t;
}
test('Project, Oct 15: deep dive on the Take-homes tab: Invite sent when the invite goes out; no booking after 3 days gets one reminder (30-minute Cancel, same thread, Interviewer cc\'d)', async () => {
  const { withinSendingHours } = await import('../service/lib/takehome-nudge.mjs');
  const gmail = fakeGmail();
  const { w, h, clockRef, local } = await deepDiveSent(gmail, 'thform-TR1');
  assert.equal(w.pages.get(SCORECARD_ID).properties['Deep dive'].select.name, 'Invite sent');
  const asked = [];
  w.calendar.listEvents = async args => { asked.push(args); return []; };
  const sentMs = clockRef.now;
  clockRef.now = sentMs + 2 * 86400_000;
  assert.equal((await h.runner.planDeepDiveTracking({ now: clockRef.now, local })).filter(r => r.action).length, 0, 'not before 3 days');
  assert.equal(asked[0].calendarId, 'quinn@company.example'); assert.equal(asked[0].q, candidate.email);
  clockRef.now = withinSendingHours(sentMs + 3 * 86400_000) + 60_000;
  const queued = await h.runner.planDeepDiveTracking({ now: clockRef.now, local });
  assert.ok(queued.some(r => r.action === 'nudge_queued'), JSON.stringify(queued));
  const [row] = opsRows(w, 'email.deep_dive_nudge');
  assert.equal(row.properties.State.select.name, 'Held');
  assert.equal((row.properties['Email body'].rich_text ?? []).map(x => x.plain_text).join(''),
    'Hi Synthetic,\n\nJust a quick reminder to book your technical deep dive. Here’s Interviewer’s scheduling link: https://calendly.com/quinn-synthetic/technical-deep-dive\n\nIf none of the times work for you, reply here and we can find another time.');
  assert.match(masonPosts(w).at(-1).body.text, /^📋 Synthetic Candidate hasn't booked the deep dive with Interviewer from the invite sent .+\. In 30 minutes I'll email them a short reminder from your Gmail, in the same thread with Interviewer cc'd, by about .+\. Tap Cancel to stop it\./);
  assert.equal(gmail.sends.length, 1, 'only the invite so far');
  clockRef.now += 31 * 60_000;
  const sent = await h.runner.planDeepDiveTracking({ now: clockRef.now, local });
  assert.ok(sent.some(r => r.action === 'nudge_sent'), JSON.stringify(sent));
  const reminder = gmail.sends.at(-1);
  assert.deepEqual([reminder.to, reminder.cc, reminder.subject, typeof reminder.replyTo], [candidate.email, 'quinn@company.example', 'Re: Company — Technical Deep Dive', 'string']);
  const link = 'https://calendly.com/quinn-synthetic/technical-deep-dive';
  assert.deepEqual(reminder.links, [{ phrase: `Interviewer’s scheduling link: ${link}`, text: 'Interviewer’s scheduling link', url: link }]);
  clockRef.now += 2 * 86400_000;
  await h.runner.planDeepDiveTracking({ now: clockRef.now, local });
  assert.equal(gmail.sends.length, 2, 'one reminder only');
});

test('Project, Oct 15: a booking on Interviewer\'s calendar marks the deep dive Booked and no reminder goes out; Booked or later is never moved back', async () => {
  const gmail = fakeGmail();
  const { w, h, clockRef, local } = await deepDiveSent(gmail, 'thform-TR2');
  const booking = { id: 'bk1', iCalUID: 'bk1', calendarId: 'quinn@company.example', summary: '30 min with J Quinn (Synthetic Candidate)', status: 'confirmed', allDay: false,
    start: new Date(NOW + 2 * 86400_000).toISOString(), end: new Date(NOW + 2 * 86400_000 + 1800_000).toISOString(), htmlLink: 'https://calendar.google.com/calendar/event?eid=bk1',
    attendees: [{ email: 'quinn@company.example' }, { email: candidate.email }] };
  w.calendar.listEvents = async () => [booking];
  clockRef.now += 3600_000;
  const r = await h.runner.planDeepDiveTracking({ now: clockRef.now, local });
  assert.ok(r.some(x => x.action === 'booked_marked'), JSON.stringify(r));
  assert.equal(w.pages.get(SCORECARD_ID).properties['Deep dive'].select.name, 'Booked');
  clockRef.now += 4 * 86400_000;
  await h.runner.planDeepDiveTracking({ now: clockRef.now, local });
  assert.equal(opsRows(w, 'email.deep_dive_nudge').length, 0);
  assert.equal(gmail.sends.length, 1);
  // A calendar that can't be read: no reminder (fail closed).
  const g2 = fakeGmail();
  const b = await deepDiveSent(g2, 'thform-TR3');
  b.w.calendar.listEvents = async () => { throw Object.assign(new Error('x'), { code: 'calendar_http_403' }); };
  b.clockRef.now += 5 * 86400_000;
  const r2 = await b.h.runner.planDeepDiveTracking({ now: b.clockRef.now, local: b.local });
  assert.ok(r2.some(x => /^calendar:/.test(x.reason ?? '')), JSON.stringify(r2));
  assert.equal(opsRows(b.w, 'email.deep_dive_nudge').length, 0);
});

test('Take-home: submissions before the start time, closed candidates and other people\'s scorecards are never put to Interviewer', async () => {
  for (const [scorecard, candidateOverrides, reason] of [
    [{ submittedAt: '2026-10-12T20:00:00.000Z' }, {}, null],
    [{}, { Outcome: sel('Withdrawn or Unavailable') }, 'candidate_closed'],
    [{ candidateIds: [CANDIDATE_ID, '99999999-2222-4333-8444-555555555555'] }, {}, 'scorecard_candidate_ambiguous']]) {
    const w = world({ candidateOverrides });
    w.pages.set(SCORECARD_ID, scorecardPage(scorecard));
    const h = await harness({ world: w, calendarFloor: TH_FLOOR });
    const results = await h.runner.planTakeHomeReviews({ now: NOW, local: (await h.runner.syncControl()).local });
    assert.equal(results[0]?.reason ?? null, reason);
    assert.equal(santoshPosts(w).length, 0);
  }
});

test('Take-home form: Interviewer advances; scorecard, brief and history updated, the deep-dive invite is queued for Project\'s Gmail with a Cancel heads-up, buttons closed', async () => {
  const { w, h, clockRef, plan } = await takeHomeWorld();
  const [first] = await plan();
  const form = { decision: 'advance', observations: 'Clean reward design; thin on evals.', score: null, nextStep: 'deep_dive' };
  await thForm(h, 'thform-V1', first.requestKey, form);
  const result = await h.runner.runEvent({ eventId: 'thform-V1', attemptId: 'a1' });
  assert.equal(result.status, 'processed', JSON.stringify(result)); assert.equal(result.outcome, 'takehome_review_recorded');
  assert.equal(h.modelLog.length, 0);
  const cardPatches = w.calls.filter(c => c.method === 'PATCH' && c.path === `/pages/${SCORECARD_ID}`).map(c => c.body.properties);
  const card = cardPatches.find(p => 'Interviewer review' in p);
  assert.deepEqual(Object.keys(card).sort(), ['Interviewer notes', 'Interviewer review', 'Interviewer review source']);
  assert.equal(card['Interviewer review'].select.name, 'Advance recommended');
  assert.equal(card['Interviewer notes'].rich_text[0].text.content, 'Clean reward design; thin on evals.');
  assert.equal('Score / 100' in card, false, 'the portal score stays auto-populated');
  // Stage fields (Project, Oct 15): Awaiting review on submission, then Passed take-home and Awaiting deep dive.
  assert.equal(cardPatches[0]['Take-home review'].select.name, 'Awaiting review');
  const stage = w.pages.get(SCORECARD_ID).properties;
  assert.equal(stage['Take-home review'].select.name, 'Passed take-home'); assert.equal(stage['Deep dive'].select.name, 'Awaiting deep dive');
  assert.match(card['Interviewer review source'].url, /^https:\/\/example-workspace\.slack\.com\/archives\//);
  // On submission the brief says so (Project, 2026-10-20, Peyton Morris); Interviewer's call then replaces it.
  const briefs = w.patches().map(c => c.body.properties).filter(p => p['Candidate brief']);
  assert.match(briefs[0]['Candidate brief'].rich_text[0].text.content, /^Status: Case Study \/ .*take-home submitted .*portal score 83\/100 \(not a human review\), waiting on Interviewer's review\./);
  const patch = briefs.at(-1);
  assert.match(patch['Candidate brief'].rich_text[0].text.content, /^Status: take-home reviewed, advance from Interviewer/);
  assert.match(patch['Next action'].rich_text[0].text.content, /^Candidate: book the technical deep dive with Interviewer from the invite emailed from Project's Gmail/);
  assert.equal('Outcome' in patch || 'Stage' in patch, false);
  const note = w.calls.find(c => c.method === 'PATCH' && c.path === `/blocks/${CANDIDATE_ID}/children`);
  assert.match(JSON.stringify(note.body), /Take-home review \(via Uncle Sam\) · interviewer: advance\. Interviewer: Advance on the take-home \(portal score 83\/100\)/);
  assert.match(JSON.stringify(note.body), /Clean reward design; thin on evals/);
  // The invite: queued, held for Project's Cancel window; Uncle Sam sends it afterwards.
  const [row] = opsRows(w, 'email.deep_dive_invite');
  const text = name => (row.properties[name].rich_text ?? []).map(x => x.plain_text).join('');
  assert.equal(row.properties.State.select.name, 'Held');
  assert.equal(row.properties['Email to'].email, candidate.email);
  assert.equal(text('Email subject'), 'Company — Technical Deep Dive');
  assert.equal(text('Email body'), 'Hi Synthetic,\n\nThank you for completing the take-home assessment.\n\nPlease select the times that work for you using Interviewer’s scheduling link: https://calendly.com/quinn-synthetic/technical-deep-dive');
  assert.equal(row.properties['Due at'].date.start, new Date(NOW + 30 * 60_000).toISOString());
  assert.equal(masonPosts(w).length, 1);
  const heads = masonPosts(w)[0].body;
  assert.match(heads.text, /^📋 Interviewer said move Synthetic Candidate to a take-home deep dive\. I'll email them Interviewer's deep-dive link from your Gmail, by about 5:35pm PT\. Tap Cancel to stop it\./);
  const cancelKey = (typeof heads.blocks === 'string' ? JSON.parse(heads.blocks) : heads.blocks).find(b => b.type === 'actions').elements[0].value;
  // Project cancels: the row is called off and the heads-up says so.
  await h.store.recordEvent({ eventId: 'emcancel-1', source: 'slack', type: 'email_cancel', occurredAt: NOW, isFixture: false, authorId: PEOPLE.project, requestKey: cancelKey });
  const cancelled = await h.runner.runEvent({ eventId: 'emcancel-1', attemptId: 'c1' });
  assert.equal(cancelled.outcome, 'email_cancel', JSON.stringify(cancelled));
  assert.equal(opsRows(w, 'email.deep_dive_invite')[0].properties.State.select.name, 'Cancelled');
  const cancelUpdate = w.slackCalls.filter(c => c.method === 'chat.update').map(c => JSON.parse(c.body.blocks).at(-1).elements[0].text);
  assert.ok(cancelUpdate.includes('🛑 Cancelled by Project. No email goes out.'), JSON.stringify(cancelUpdate));
  await h.store.recordEvent({ eventId: 'emcancel-2', source: 'slack', type: 'email_cancel', occurredAt: NOW, isFixture: false, authorId: PEOPLE.project, requestKey: cancelKey });
  assert.equal((await h.runner.runEvent({ eventId: 'emcancel-2', attemptId: 'c2' })).reason, 'already_answered');
  const update = w.slackCalls.find(c => c.method === 'chat.update');
  assert.equal(update.body.channel, SANTOSH_DM);
  const steps = JSON.parse(update.body.blocks).filter(b => b.type === 'context').map(b => b.elements[0].text);
  assert.deepEqual(steps.slice(0, 3), ['🎖️ Step 1 · Your call: Advance to a technical deep dive with you', '🎖️ Step 2 · Note: Clean reward design; thin on evals.',
    "📋 Step 3 · Done. The invite with your deep-dive link goes to them from Project's Gmail by about 5:35pm PT. Nothing more needed from you."]);
  assert.equal(JSON.parse(update.body.blocks).some(b => b.type === 'actions'), false, 'no buttons left to press');
  // Answered: no reminder later, and the same buttons cannot answer again.
  clockRef.now = NOW + 30 * 3600_000;
  w.pages.get(SCORECARD_ID).properties['Interviewer review'] = sel('Not recorded');
  assert.equal((await plan())[0].reason, 'answered');
  await thForm(h, 'thform-V2', first.requestKey, { ...form, decision: 'do_not_advance' });
  const again = await h.runner.runEvent({ eventId: 'thform-V2', attemptId: 'a2' });
  assert.match(again.reason, /^form_not_accepted/);
  assert.equal(santoshPosts(w).length, 1);
});

test('Take-home form: Interviewer\'s "do not advance" puts step 3 (Confirm reject / Not yet) on the same message; confirming closes the record', async () => {
  const { w, h, plan } = await takeHomeWorld();
  const [first] = await plan();
  await thForm(h, 'thform-R1', first.requestKey, { decision: 'do_not_advance', observations: 'Did not handle long-horizon tasks.', score: null });
  const result = await h.runner.runEvent({ eventId: 'thform-R1', attemptId: 'a1' });
  assert.equal(result.outcome, 'takehome_review_recorded', JSON.stringify(result));
  const cardPatches = w.calls.filter(c => c.method === 'PATCH' && c.path === `/pages/${SCORECARD_ID}`).map(c => c.body.properties);
  const card = cardPatches.find(p => 'Interviewer review' in p);
  assert.deepEqual(Object.keys(card).sort(), ['Interviewer notes', 'Interviewer review', 'Interviewer review source']);
  assert.equal(card['Interviewer review'].select.name, 'Reject recommended');
  assert.equal(w.pages.get(SCORECARD_ID).properties['Take-home review'].select.name, 'Reject');
  assert.equal('Outcome' in w.patches()[0].body.properties, false);
  assert.equal(masonPosts(w).length, 0, 'Project, Oct 15: no message about a rejection');
  assert.equal(santoshPosts(w).length, 1, 'no second message: the notification itself moves on');
  const blocksOf = c => JSON.parse(c.body.blocks);
  const step3 = blocksOf(w.slackCalls.filter(c => c.method === 'chat.update').at(-1));
  assert.match(step3.filter(b => b.type === 'context').map(b => b.elements[0].text).join('\n'), /🎖️ Step 2 · Note: Did not handle long-horizon tasks\.\n🫵 Step 3 of 3 · Confirm the reject/);
  const buttons = step3.find(b => b.type === 'actions').elements;
  assert.deepEqual(buttons.map(b => b.action_id), ['th_rj_confirm', 'th_rj_not_yet']);
  assert.equal(buttons[0].value, first.requestKey);
  assert.equal(w.slackCalls.some(c => c.method === 'chat.postMessage' && [routeMap.interviewer_rishi.channelId, routeMap.interviewer_rithika.channelId].includes(c.body.channel)), false);
  // Someone who may not reject cannot confirm.
  await h.store.recordEvent({ eventId: 'thrj-0', source: 'slack', type: 'takehome_reject', occurredAt: NOW, isFixture: false, authorId: PEOPLE.jamie, requestKey: first.requestKey, decision: 'confirm' });
  assert.equal((await h.runner.runEvent({ eventId: 'thrj-0', attemptId: 'a1' })).reason, 'not_allowed');
  await h.store.recordEvent({ eventId: 'thrj-1', source: 'slack', type: 'takehome_reject', occurredAt: NOW, isFixture: false, authorId: PEOPLE.interviewer, requestKey: first.requestKey, decision: 'confirm' });
  const confirmed = await h.runner.runEvent({ eventId: 'thrj-1', attemptId: 'a1' });
  assert.equal(confirmed.outcome, 'rejection_confirmed', JSON.stringify(confirmed));
  const props = Object.assign({}, ...w.patches().map(c => c.body.properties ?? {}));
  assert.equal(props.Outcome.select.name, 'Not Selected');
  assert.equal(masonPosts(w).at(-1).body.text, '🪖 Interviewer selected reject on Synthetic Candidate. Marked Not Selected in the tracker.');
  assert.equal(santoshPosts(w).length, 1, 'the answer shows on the message, not as a new one');
  const last = blocksOf(w.slackCalls.filter(c => c.method === 'chat.update').at(-1));
  const lines = last.filter(b => b.type === 'context' && b.elements[0].type === 'plain_text').map(b => b.elements[0].text);
  assert.equal(lines.length, 1, 'the steps give way to one line');
  assert.match(lines[0], /^🪖 Rejected\. Synthetic Candidate is out, marked Not Selected\. The rejection email goes from Project's account /);
  assert.equal(last.some(b => b.type === 'actions'), false);
});

test('Take-home step 3: Not yet changes nothing and Project hears nothing', async () => {
  const { w, h, plan } = await takeHomeWorld();
  const [first] = await plan();
  await thForm(h, 'thform-N1', first.requestKey, { decision: 'do_not_advance', observations: 'Borderline.', score: null });
  await h.runner.runEvent({ eventId: 'thform-N1', attemptId: 'a1' });
  await h.store.recordEvent({ eventId: 'thrj-N', source: 'slack', type: 'takehome_reject', occurredAt: NOW, isFixture: false, authorId: PEOPLE.interviewer, requestKey: first.requestKey, decision: 'not_yet' });
  assert.equal((await h.runner.runEvent({ eventId: 'thrj-N', attemptId: 'a1' })).outcome, 'rejection_not_yet');
  assert.equal(w.patches().some(c => c.body.properties?.Outcome), false);
  assert.equal(masonPosts(w).length, 0);
  assert.match(JSON.stringify(JSON.parse(w.slackCalls.filter(c => c.method === 'chat.update').at(-1).body.blocks)), /Step 3 · Interviewer said not yet\. Nothing changes/);
});

test('Take-home: a recommendation recorded on the scorecard another way closes the open request instead of reminding', async () => {
  const { w, clockRef, plan } = await takeHomeWorld();
  await plan();
  w.pages.get(SCORECARD_ID).properties['Interviewer review'] = sel('Advance recommended');
  clockRef.now = NOW + 25 * 3600_000;
  assert.equal((await plan())[0].reason, 'santosh_review_recorded');
  assert.equal(santoshPosts(w).length, 1, 'no reminder');
  assert.match(JSON.parse(w.slackCalls.find(c => c.method === 'chat.update').body.blocks).at(-1).elements[0].text, /Recorded on the scorecard: Advance recommended/);
});

test('Take-home form: Robin may answer for Interviewer, but only Interviewer\'s own call becomes "Interviewer review"; a take-home form never answers an interview prompt', async () => {
  const { w, h, plan } = await takeHomeWorld();
  const [first] = await plan();
  await thForm(h, 'thform-K1', first.requestKey, { decision: 'advance', observations: 'Agree with the portal.', score: null, nextStep: 'deep_dive', focus: '' }, PEOPLE.robin);
  const result = await h.runner.runEvent({ eventId: 'thform-K1', attemptId: 'a1' });
  assert.equal(result.outcome, 'takehome_review_recorded', JSON.stringify(result));
  assert.equal(w.calls.some(c => c.method === 'PATCH' && c.path === `/pages/${SCORECARD_ID}` && 'Interviewer review' in c.body.properties), false);
  assert.equal(w.pages.get(SCORECARD_ID).properties['Take-home review'].select.name, 'Passed take-home', 'the stage still moves on');
  assert.match(masonPosts(w)[0].body.text, /Robin said move Synthetic Candidate to a take-home deep dive/);
  const promptKey = await seedSentPrompt(h);
  await thForm(h, 'thform-K2', promptKey, { decision: 'do_not_advance', observations: 'x', score: null }, PEOPLE.robin);
  const stray = await h.runner.runEvent({ eventId: 'thform-K2', attemptId: 'a2' });
  assert.equal(stray.reason, 'not_a_takehome_request');
  assert.equal((await h.store.getRequest(promptKey)).state, 'Sent');
});

test('Project, Oct 15: Passed take-home set by hand on the Take-homes tab queues the same deep-dive invite once; old ones are a baseline, one invite per candidate', async () => {
  const { w, h } = await takeHomeWorld();
  const local = (await h.runner.syncControl()).local;
  // Already passed when this ships: a baseline, nothing emailed.
  w.pages.get(SCORECARD_ID).properties['Take-home review'] = sel('Passed take-home');
  assert.deepEqual((await h.runner.planManualDeepDiveInvites({ now: NOW, local })).map(r => r.reason), ['baseline']);
  assert.equal(opsRows(w, 'email.deep_dive_invite').length, 0);
  // A new one set by hand: queued with Project's 30-minute Cancel heads-up.
  const NEW_CARD = '44444444-3333-4444-8555-666666666666';
  w.pages.set(NEW_CARD, { ...scorecardPage(), id: NEW_CARD, url: `https://www.notion.so/${NEW_CARD.replaceAll('-', '')}` });
  w.pages.get(NEW_CARD).properties['Take-home review'] = sel('Passed take-home');
  const [queued] = await h.runner.planManualDeepDiveInvites({ now: NOW, local });
  assert.equal(queued.outcome, 'deep_dive_invite_queued', JSON.stringify(queued));
  const [row] = opsRows(w, 'email.deep_dive_invite');
  assert.equal(row.properties.State.select.name, 'Held');
  assert.equal(row.properties['Due at'].date.start, new Date(NOW + 30 * 60_000).toISOString());
  assert.match(masonPosts(w).at(-1).body.text, /^📋 Synthetic Candidate was marked Passed take-home in Notion\. I'll email them Interviewer's deep-dive link from your Gmail, by about .*Tap Cancel to stop it\./);
  assert.equal(w.pages.get(NEW_CARD).properties['Deep dive'].select.name, 'Awaiting deep dive');
  // Seen once: the next tick does nothing, and a second scorecard for the same candidate never sends a second invite.
  assert.equal((await h.runner.planManualDeepDiveInvites({ now: NOW + 300_000, local })).length, 0);
  const THIRD = '55555555-3333-4444-8555-666666666666';
  w.pages.set(THIRD, { ...scorecardPage(), id: THIRD, url: `https://www.notion.so/${THIRD.replaceAll('-', '')}` });
  w.pages.get(THIRD).properties['Take-home review'] = sel('Passed take-home');
  const [again] = await h.runner.planManualDeepDiveInvites({ now: NOW + 600_000, local });
  assert.equal(again.outcome, 'deep_dive_invite_already_queued');
  assert.equal(opsRows(w, 'email.deep_dive_invite').length, 1);
});

test('Interviewer\'s Advance after a hand-set invite (or the reverse) never queues a second invite for the candidate', async () => {
  const { w, h, plan } = await takeHomeWorld();
  const local = (await h.runner.syncControl()).local;
  await h.runner.planManualDeepDiveInvites({ now: NOW, local }); // baseline (nothing passed yet)
  const [first] = await plan();
  w.pages.get(SCORECARD_ID).properties['Take-home review'] = sel('Passed take-home');
  await h.runner.planManualDeepDiveInvites({ now: NOW, local });
  assert.equal(opsRows(w, 'email.deep_dive_invite').length, 1);
  await thForm(h, 'thform-DUP', first.requestKey, { decision: 'advance', observations: 'Good.', score: null, nextStep: 'deep_dive' });
  const result = await h.runner.runEvent({ eventId: 'thform-DUP', attemptId: 'a1' });
  assert.equal(result.outcome, 'takehome_review_recorded', JSON.stringify(result));
  assert.equal(opsRows(w, 'email.deep_dive_invite').length, 1, 'one invite per candidate');
});

test('scorecard writes are guarded: only the two recommendations, only on the candidate\'s own take-home scorecard, read back', async () => {
  const { w, h } = await takeHomeWorld();
  const base = { scorecardPageId: SCORECARD_ID, candidatePageId: CANDIDATE_ID, recommendation: 'Advance recommended', sourceUrl: 'https://example-workspace.slack.com/archives/D1/p1' };
  await assert.rejects(h.notion.recordTakeHomeReview({ ...base, recommendation: 'Hire' }), /invalid_recommendation/);
  await assert.rejects(h.notion.recordTakeHomeReview({ ...base, candidatePageId: '99999999-2222-4333-8444-555555555555' }), /scorecard_mismatch/);
  await assert.rejects(h.notion.recordTakeHomeReview({ ...base, sourceUrl: 'http://insecure.example/x' }), /invalid_review_link/);
  await assert.rejects(h.notion.recordTakeHomeReview({ ...base, reviewerScore: 101 }), /invalid_reviewer_score/);
  assert.equal(w.calls.some(c => c.method === 'PATCH' && c.path === `/pages/${SCORECARD_ID}`), false);
  const ok = await h.notion.recordTakeHomeReview({ ...base, reviewerScore: 90 });
  assert.equal(ok.santoshReview, 'Advance recommended'); assert.equal(ok.reviewerScore, 90);
  assert.equal(w.pages.get(SCORECARD_ID).properties['Score / 100'].number, 83, 'portal grade untouched');
});

test('Take-home form: when the invite cannot be built (no template), nothing is queued and Project is told to send it himself', async () => {
  const { w, h, plan } = await takeHomeWorld({}, { template: null });
  const [first] = await plan();
  await thForm(h, 'thform-T1', first.requestKey, { decision: 'advance', observations: 'Good.', score: null, nextStep: 'deep_dive', focus: '' });
  const result = await h.runner.runEvent({ eventId: 'thform-T1', attemptId: 'a1' });
  assert.equal(result.outcome, 'takehome_review_recorded', JSON.stringify(result));
  assert.deepEqual(opsRows(w, 'email.deep_dive_invite'), []);
  assert.match(masonPosts(w)[0].body.text, /couldn't queue the invite email: the "Email · Deep Dive · Invitation" template is missing.*Send Interviewer's deep-dive link yourself/);
});

test('Project, Oct 15: in his DM Project can set a pipeline and put someone on hold, and Uncle Sam does it; nobody else can', async () => {
  const masonDm = routeMap.project.channelId;
  const w = world({ candidateOverrides: { Pipeline: { select: null }, Outcome: sel('Proceeding') } });
  const h = await harness({ world: w, script: [
    [{ name: 'propose', input: { kind: 'update_record', candidatePageId: CANDIDATE_ID, pipeline: 'India', outcome: 'On Hold', evidence: 'synthetic india as well but put on hold' } }],
    [{ name: 'propose', input: { kind: 'update_record', candidatePageId: CANDIDATE_ID, pipeline: 'US/EU', evidence: 'move him to US' } }],
  ] });
  await h.runner.syncControl();
  await h.store.recordEvent(slackEvent('Ev-upd-1', { authorId: PEOPLE.project, channelId: masonDm, threadTs: null, ts: '1791926490.000100', text: 'synthetic india as well but put on hold' }));
  const r = await h.runner.runEvent({ eventId: 'Ev-upd-1', attemptId: 'a1' });
  assert.equal(r.outcome, 'update_record', JSON.stringify(r));
  const props = w.pages.get(CANDIDATE_ID).properties;
  assert.equal(props.Pipeline.select.name, 'India'); assert.equal(props.Outcome.select.name, 'On Hold');
  assert.equal(w.slackCalls.filter(c => c.method === 'chat.postMessage').at(-1).body.text, 'Roger that 🫡');
  // Robin's DM is not Project's: the same proposal is refused.
  await h.store.recordEvent(slackEvent('Ev-upd-2', { authorId: PEOPLE.robin, channelId: RISHI_DM, threadTs: null, ts: '1791926500.000100', text: 'move him to US' }));
  const r2 = await h.runner.runEvent({ eventId: 'Ev-upd-2', attemptId: 'a2' });
  assert.notEqual(r2.outcome, 'update_record');
  assert.equal(w.pages.get(CANDIDATE_ID).properties.Pipeline.select.name, 'India');
});

test('Live: Project talking to Uncle Sam in its DM always gets an answer there, the question for him or that nothing needed doing', async () => {
  const masonDm = routeMap.project.channelId;
  const w = world();
  const h = await harness({ world: w, script: [
    [{ name: 'propose', input: { kind: 'needs_attention', summary: 'Two Reagan Turner records exist: Reagan Turner (Mercor) and Reagan Turner (Proximal). Please confirm which one.' } }],
    [{ name: 'propose', input: { kind: 'no_action', reason: 'greeting' } }],
  ] });
  await h.runner.syncControl();
  await h.store.recordEvent(slackEvent('Ev-project-1', { authorId: PEOPLE.project, channelId: masonDm, threadTs: null, ts: '1791926470.000100',
    text: 'then dont reject just act like that wasnt said and continue his process normally for reagan turner' }));
  assert.equal((await h.runner.runEvent({ eventId: 'Ev-project-1', attemptId: 'a1' })).outcome, 'needs_attention');
  await h.store.recordEvent(slackEvent('Ev-project-2', { authorId: PEOPLE.project, channelId: masonDm, threadTs: null, ts: '1791926480.000100', text: 'hello uncle sam' }));
  assert.equal((await h.runner.runEvent({ eventId: 'Ev-project-2', attemptId: 'a2' })).outcome, 'no_action');
  const posts = w.slackCalls.filter(c => c.method === 'chat.postMessage').map(c => c.body);
  assert.equal(posts.length, 2);
  assert.deepEqual(posts.map(p => [p.channel, p.thread_ts]), [[masonDm, undefined], [masonDm, undefined]], 'a plain message in the DM, not a thread reply');
  assert.equal(posts[0].text, '📋 Two Reagan Turner records exist: Reagan Turner (Mercor) and Reagan Turner (Proximal). Please confirm which one.');
  assert.equal(posts[1].text, 'Roger that 🫡');
  assert.ok((await h.store.getEvent('Ev-project-2')).receipt.sideEffects.includes('mason_dm_reply'));
});


/* ---------- Who takes an interview, and finding the candidate when the guest list does not say (Project, 2026-10-16) ---------- */

test('takersOf: a stated assignment wins; Interviewer on the invite with others means Interviewer; otherwise everyone on it', () => {
  assert.deepEqual(takersOf([PEOPLE.robin, PEOPLE.interviewer]), [PEOPLE.interviewer]);
  assert.deepEqual(takersOf([PEOPLE.robin]), [PEOPLE.robin]);
  assert.deepEqual(takersOf([PEOPLE.robin, PEOPLE.alexis]), [PEOPLE.robin, PEOPLE.alexis]);
  assert.deepEqual(takersOf([PEOPLE.robin, PEOPLE.interviewer], [PEOPLE.robin, PEOPLE.interviewer]), [PEOPLE.robin, PEOPLE.interviewer], 'both, when someone said so');
  assert.deepEqual(takersOf([PEOPLE.robin], [PEOPLE.interviewer]), [PEOPLE.interviewer], 'an assignment can name someone not on the invite');
  assert.deepEqual(takersOf([PEOPLE.robin], [PEOPLE.project, 'UNKNOWN']), [PEOPLE.robin], 'only interviewers count');
});

test('bookingHints: LinkedIn and names from the title, Calendly invitees and "Booked by"; never the spots or format', () => {
  assert.deepEqual(bookingHints({ summary: '30 Min call Robin (Cameron Wells)', description: 'Booked by\nCameron Wells\ncameronwells008@example.test\nLinkedIn\nhttps://www.linkedin.com/in/sample-cameron-wells/' }),
    { linkedin: 'sample-cameron-wells', booked: true, names: ['Cameron Wells'] });
  assert.deepEqual(bookingHints({ summary: 'Technical Deep Dive (1 of 2 spots filled)', description: 'Event Attendance: 1 of 2 spots filled\nConfirmed Invitees: Reagan Turner' }),
    { linkedin: null, booked: true, names: ['Reagan Turner'] });
  assert.deepEqual(bookingHints({ summary: 'Elliot Woods Work Trial (Remote)', description: '' }), { linkedin: null, booked: false, names: [] });
  assert.equal(bookingHints({ summary: 'Val availability (weekly expectations)', description: '' }).booked, false, 'a name-like aside in a title is not a booking');
  assert.deepEqual(bookingHints({ summary: 'Yu <> Company', description: 'LinkedIn: https://www.linkedin.com/in/sample-494f64d0d20f' }), { linkedin: 'sample-494f64d0d20f', booked: false, names: [] });
});

test('interviewKind and interviewWhen: the question names the kind of interview and when, not the booking title', () => {
  assert.equal(interviewKind({ fields: { Stage: 'Intro Call' } }, false), 'Intro call');
  assert.equal(interviewKind({ fields: { Round: 'R1 — Intro', Stage: 'Intro Call' } }, false), 'R1 — Intro');
  assert.equal(interviewKind({ fields: { Stage: 'Case Study' } }, true), 'Technical deep dive');
  assert.equal(interviewWhen('2026-10-16T17:30:00.000Z'), 'Fri, Oct 16, 10:30 AM PT');
});

const SANTOSH_EMAILS = { 'robin@company.example': PEOPLE.robin, 'alexis@company.example': PEOPLE.alexis, 'quinn@company.example': PEOPLE.interviewer };

test('Live: Robin\'s booking with Interviewer on it asks Interviewer only, matched by LinkedIn when the guest used another email; the hidden copy is joined', async () => {
  const end = NOW - 1200_000;
  const base = { iCalUID: 'ical-sample-3bb8668bb7a3', summary: '30 Min call Robin (Synthetic Candidate)', status: 'confirmed', start: new Date(end - 1800_000).toISOString(),
    end: new Date(end).toISOString(), allDay: false, updated: '2026-10-13T10:00:00.000Z' };
  // Interviewer's copy hides the guests; Robin's copy has them, with a different email than the record, and the LinkedIn in the notes.
  const santoshCopy = { ...base, id: 'evt-s', calendarId: 'quinn@company.example', htmlLink: 'https://calendar.google.com/calendar/event?eid=s', attendees: [{ email: 'quinn@company.example' }], description: '' };
  const rishiCopy = { ...base, id: 'evt-r', calendarId: 'robin@company.example', htmlLink: 'https://calendar.google.com/calendar/event?eid=r',
    attendees: [{ email: 'robin@company.example' }, { email: 'quinn@company.example' }, { email: 'other.address@example.invalid' }],
    description: 'Booked by\nSynthetic Candidate\nother.address@example.invalid\nLinkedIn\nhttps://www.linkedin.com/in/synthetic-candidate-1' };
  const w = world({ candidateOverrides: { LinkedIn: { type: 'url', url: 'https://www.linkedin.com/in/synthetic-candidate-1' }, Round: sel(null), Stage: sel('Intro Call') } });
  w.calendar.listEvents = async ({ calendarId }) => calendarId === 'quinn@company.example' ? [santoshCopy] : [rishiCopy];
  const h = await harness({ world: w, calendarIds: ['quinn@company.example', 'robin@company.example'], calendarFloor: NOW - 3 * 3600_000,
    interviewerEmails: SANTOSH_EMAILS, script: [review('send')] });
  const tick = await h.runner.runTick({ now: NOW });
  const posts = w.slackCalls.filter(c => c.method === 'chat.postMessage');
  assert.equal(posts.length, 1, JSON.stringify(tick.summary.prompts));
  assert.equal(posts[0].body.channel, routeMap.interviewer_santosh.channelId, 'Interviewer, not Robin');
  assert.match(posts[0].body.text, /Synthetic Candidate — Intro call · /);
  assert.doesNotMatch(posts[0].body.text, /30 Min call Robin/);
  const logged = opsRows(w, 'interview.logged');
  assert.equal(logged.length, 1, 'one interview, not one per calendar copy');
});

test('Live: a stated assignment of two interviewers asks both', async () => {
  const end = NOW - 1200_000;
  const event = { id: 'evt-2', iCalUID: 'ical-2', calendarId: 'robin@company.example', summary: 'Interview', status: 'confirmed', start: new Date(end - 1800_000).toISOString(),
    end: new Date(end).toISOString(), allDay: false, updated: '2026-10-13T10:00:00.000Z', htmlLink: 'https://calendar.google.com/calendar/event?eid=2',
    attendees: [{ email: 'robin@company.example' }, { email: 'quinn@company.example' }, { email: candidate.email }], description: '' };
  const w = world();
  w.calendar.listEvents = async () => [event];
  const h = await harness({ world: w, calendarIds: ['robin@company.example'], calendarFloor: NOW - 3 * 3600_000, interviewerEmails: SANTOSH_EMAILS,
    assignmentsOf: async key => key === 'ical-2' ? { ids: [PEOPLE.robin, PEOPLE.interviewer] } : null, script: [review('send'), review('send')] });
  await h.runner.runTick({ now: NOW });
  const channels = w.slackCalls.filter(c => c.method === 'chat.postMessage').map(c => c.body.channel).sort();
  assert.ok(channels.length >= 1);
  assert.ok(channels.every(ch => [routeMap.interviewer_rishi.channelId, routeMap.interviewer_santosh.channelId].includes(ch) || /^G/.test(ch)), channels.join());
});

test('Preview: the day\'s interviews ahead of time, with the kind, who will be asked, and a name that matches two records flagged', async () => {
  const at = h => new Date(NOW + h * 3600_000).toISOString();
  const events = [
    { id: 'p1', iCalUID: 'p1', calendarId: 'quinn@company.example', summary: '30 Min call Robin (Synthetic Candidate)', status: 'confirmed', start: at(2), end: at(2.5), allDay: false,
      htmlLink: 'https://calendar.google.com/calendar/event?eid=p1', attendees: [{ email: 'robin@company.example' }, { email: 'quinn@company.example' }, { email: candidate.email }], description: '' },
    { id: 'p2', iCalUID: 'p2', calendarId: 'quinn@company.example', summary: 'Technical Deep Dive (1 of 2 spots filled)', status: 'confirmed', start: at(8), end: at(8.5), allDay: false,
      htmlLink: 'https://calendar.google.com/calendar/event?eid=p2', attendees: [{ email: 'quinn@company.example' }], description: 'Confirmed Invitees: Twin Person' },
    { id: 'p3', iCalUID: 'p3', calendarId: 'quinn@company.example', summary: 'Product Standup', status: 'confirmed', start: at(1), end: at(1.5), allDay: false,
      htmlLink: 'https://calendar.google.com/calendar/event?eid=p3', attendees: [{ email: 'quinn@company.example' }, { email: 'robin@company.example' }, { email: 'outside.guest@example.invalid' }], description: '' },
    { id: 'p4', iCalUID: 'p4', calendarId: 'quinn@company.example', summary: 'Company AI Steven D. Intro', status: 'confirmed', start: at(3), end: at(3.5), allDay: false,
      htmlLink: 'https://calendar.google.com/calendar/event?eid=p4', attendees: [{ email: 'quinn@company.example' }, { email: 'steven@client.example' }], description: '' },
    { id: 'p5', iCalUID: 'p5', calendarId: 'quinn@company.example', summary: 'Val availability (weekly expectations)', status: 'confirmed', start: at(4), end: at(4.5), allDay: false,
      htmlLink: 'https://calendar.google.com/calendar/event?eid=p5', attendees: [{ email: 'quinn@company.example' }, { email: 'val.guest@example.invalid' }], description: '' },
  ];
  const w = world({ candidateOverrides: { Stage: sel('Intro Call'), Round: sel(null) } });
  w.calendar.listEvents = async () => events;
  const twin = id => ({ object: 'page', id, url: `https://www.notion.so/${id.replaceAll('-', '')}`, archived: false, last_edited_time: '2026-10-13T20:00:00.000Z',
    parent: { type: 'data_source_id', data_source_id: RECRUITING_SOURCE_ID }, properties: { Candidate: { type: 'title', title: [{ plain_text: id.endsWith('1') ? 'Twin Person' : 'Twin Person (Mercor)' }] },
      Email: { type: 'email', email: null }, Outcome: sel('Proceeding'), Stage: sel('Case Study') } });
  for (const id of ['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002']) w.pages.set(id, twin(id));
  const h = await harness({ world: w, calendarIds: ['quinn@company.example'], calendarFloor: NOW - 3 * 3600_000, interviewerEmails: SANTOSH_EMAILS });
  const preview = await h.runner.previewInterviews({ from: NOW, to: NOW + 24 * 3600_000 });
  assert.equal(preview.length, 2, JSON.stringify(preview));
  assert.equal(preview[0].candidate.fullName, 'Synthetic Candidate');
  assert.equal(preview[0].kind, 'Intro call');
  assert.deepEqual(preview[0].takers, ['interviewer']);
  assert.equal(preview[1].candidate, null);
  assert.equal(preview[1].kind, 'Technical deep dive');
  assert.deepEqual(preview[1].ambiguous, ['Twin Person', 'Twin Person (Mercor)']);
});

test('Live: two interviewers who took it together are asked once, in one group DM with exactly them; either can answer', async () => {
  const end = NOW - 1200_000;
  const event = { id: 'evt-g', iCalUID: 'ical-g', calendarId: 'robin@company.example', summary: 'Interview', status: 'confirmed', start: new Date(end - 1800_000).toISOString(),
    end: new Date(end).toISOString(), allDay: false, updated: '2026-10-13T10:00:00.000Z', htmlLink: 'https://calendar.google.com/calendar/event?eid=g',
    attendees: [{ email: 'robin@company.example' }, { email: 'quinn@company.example' }, { email: candidate.email }], description: '' };
  const w = world();
  w.calendar.listEvents = async () => [event];
  const h = await harness({ world: w, calendarIds: ['robin@company.example'], calendarFloor: NOW - 3 * 3600_000, interviewerEmails: SANTOSH_EMAILS, groups: true,
    assignmentsOf: async key => key === 'ical-g' ? { ids: [PEOPLE.interviewer, PEOPLE.robin] } : null, script: [review('send')] });
  const tick = await h.runner.runTick({ now: NOW });
  const posts = w.slackCalls.filter(c => c.method === 'chat.postMessage');
  assert.equal(posts.length, 1, JSON.stringify(tick.summary.prompts));
  assert.equal(posts[0].body.channel, 'GGRP1XXXXXX');
  assert.deepEqual(String(w.groupOpens[0]).split(',').sort(), [PEOPLE.robin, PEOPLE.interviewer].sort());
  assert.match(posts[0].body.text, /^📣 (Robin|Interviewer) and (Robin|Interviewer), you took Synthetic Candidate's .* together\. One of you, give me the call/);
  const request = await h.store.getRequest(tick.summary.prompts.find(p => p.requestKey).requestKey);
  assert.deepEqual([...request.recipientIds].sort(), [PEOPLE.robin, PEOPLE.interviewer].sort());
  // A second tick reuses the same group DM and asks nobody again.
  await h.runner.runTick({ now: NOW + 600_000 });
  assert.equal(w.groupOpens.length, 1);
  assert.equal(w.slackCalls.filter(c => c.method === 'chat.postMessage').length, 1);
});

test('Live: if the group DM cannot be opened, each of them is asked in their own DM', async () => {
  const end = NOW - 1200_000;
  const event = { id: 'evt-h', iCalUID: 'ical-h', calendarId: 'robin@company.example', summary: 'Interview', status: 'confirmed', start: new Date(end - 1800_000).toISOString(),
    end: new Date(end).toISOString(), allDay: false, updated: '2026-10-13T10:00:00.000Z', htmlLink: 'https://calendar.google.com/calendar/event?eid=h',
    attendees: [{ email: 'robin@company.example' }, { email: 'alexis@company.example' }, { email: candidate.email }], description: '' };
  const w = world();
  w.calendar.listEvents = async () => [event];
  const fetchImpl = w.fetchImpl;
  w.fetchImpl = async (url, init) => String(url).includes('conversations.open') ? new Response(JSON.stringify({ ok: false, error: 'missing_scope' })) : fetchImpl(url, init);
  const h = await harness({ world: w, calendarIds: ['robin@company.example'], calendarFloor: NOW - 3 * 3600_000, groups: true, script: [review('send'), review('send')] });
  const tick = await h.runner.runTick({ now: NOW });
  assert.ok(tick.summary.prompts.some(p => p.reason === 'group_dm_unavailable:group_open_missing_scope'), JSON.stringify(tick.summary.prompts));
  const channels = w.slackCalls.filter(c => c.method === 'chat.postMessage').map(c => c.body.channel).sort();
  assert.deepEqual(channels, [routeMap.interviewer_rishi.channelId, routeMap.interviewer_rithika.channelId].sort());
});

test('Preview: two records with one name at a deep dive resolve to the one the deep-dive email went to', async () => {
  const at = h => new Date(NOW + h * 3600_000).toISOString();
  const w = world();
  w.calendar.listEvents = async () => [{ id: 'd1', iCalUID: 'd1', calendarId: 'quinn@company.example', summary: 'Technical Deep Dive (1 of 2 spots filled)', status: 'confirmed',
    start: at(8), end: at(8.5), allDay: false, htmlLink: 'https://calendar.google.com/calendar/event?eid=d1', attendees: [{ email: 'quinn@company.example' }], description: 'Confirmed Invitees: Twin Person' }];
  const twin = (id, title, email) => ({ object: 'page', id, url: `https://www.notion.so/${id.replaceAll('-', '')}`, archived: false, last_edited_time: '2026-10-13T20:00:00.000Z',
    parent: { type: 'data_source_id', data_source_id: RECRUITING_SOURCE_ID }, properties: { Candidate: { type: 'title', title: [{ plain_text: title }] },
      Email: { type: 'email', email }, Outcome: sel('Proceeding'), Stage: sel('Case Study') } });
  w.pages.set('aaaaaaaa-0000-4000-8000-000000000001', twin('aaaaaaaa-0000-4000-8000-000000000001', 'Twin Person', 'twin.one@example.invalid'));
  w.pages.set('aaaaaaaa-0000-4000-8000-000000000002', twin('aaaaaaaa-0000-4000-8000-000000000002', 'Twin Person (Mercor)', null));
  const gmail = { async searchSent(q) { return q.includes('twin.one@example.invalid') ? [{ id: 'm1' }] : []; } };
  const h = await harness({ world: w, calendarIds: ['quinn@company.example'], calendarFloor: NOW - 3 * 3600_000, interviewerEmails: SANTOSH_EMAILS, gmail });
  const [item] = await h.runner.previewInterviews({ from: NOW, to: NOW + 24 * 3600_000 });
  assert.equal(item.candidate?.fullName, 'Twin Person', JSON.stringify(item));
  assert.equal(item.candidate.via, 'deep_dive_invite');
  assert.equal(item.kind, 'Technical deep dive');
  assert.deepEqual(item.takers, ['interviewer']);
});


// Google Meet records (meet.mjs; Project, 2026-10-16: "as soon as they both get off, boom").
function meetCall({ start, people, ended = null }) {
  return { canRead: async () => true, read: async () => ({ found: true, host: 'quinn@company.example', started: start, ended, people }) };
}
function slotEvent(id, { start, end }) {
  return { id, iCalUID: `ical-${id}`, calendarId: 'quinn@company.example', summary: 'Interview', status: 'confirmed', start: new Date(start).toISOString(),
    end: new Date(end).toISOString(), allDay: false, updated: '2026-10-13T10:00:00.000Z', htmlLink: `https://calendar.google.com/calendar/event?eid=${id}`,
    attendees: [{ email: 'quinn@company.example' }, { email: 'robin@company.example' }, { email: candidate.email }], description: '', meetUrl: 'https://meet.google.com/abc-defg-hij' };
}

test('Meet: both left before the calendar end -> asked a minute later, together in one group DM, and never again', async () => {
  const start = NOW - 25 * 60_000, end = NOW + 5 * 60_000;
  const w = world(); w.calendar.listEvents = async () => [slotEvent('m1', { start, end })];
  const meet = meetCall({ start, people: [
    { email: 'quinn@company.example', name: 'J Quinn Foster', joined: start, left: NOW - 2 * 60_000 },
    { email: 'robin@company.example', name: 'Robin', joined: start + 60_000, left: NOW - 90_000 },
    { email: null, name: 'Synthetic Candidate', joined: start, left: NOW - 80_000 }] });
  const h = await harness({ world: w, calendarIds: ['quinn@company.example'], calendarFloor: NOW - 3 * 3600_000, interviewerEmails: SANTOSH_EMAILS, groups: true, meet, script: [review('send')] });
  const tick = await h.runner.runTick({ now: NOW });
  const posts = w.slackCalls.filter(c => c.method === 'chat.postMessage');
  assert.equal(posts.length, 1, JSON.stringify(tick.summary.prompts));
  assert.equal(posts[0].body.channel, 'GGRP1XXXXXX', 'Interviewer alone would be asked from the invite; the Meet shows both took it');
  assert.match(posts[0].body.text, /together\. One of you, give me the call/);
  assert.ok(!/no guest joined/.test(posts[0].body.text));
  const request = await h.store.getRequest(tick.summary.prompts.find(p => p.requestKey).requestKey);
  assert.equal(request.payload.meetEndedAt, new Date(NOW - 90_000).toISOString());
  // Later runs, even if the Meet showed someone else, ask nobody again.
  await h.runner.runTick({ now: NOW + 10 * 60_000 });
  assert.equal(w.slackCalls.filter(c => c.method === 'chat.postMessage').length, 1);
});

test('Meet: still on the call -> held, even past the calendar end; no guest ever joined -> the no-show question, and It happened brings the feedback question', async () => {
  const start = NOW - 40 * 60_000, end = NOW - 5 * 60_000;
  const w = world(); w.calendar.listEvents = async () => [slotEvent('m2', { start, end })];
  let people = [{ email: 'quinn@company.example', name: 'J Quinn Foster', joined: start, left: null }];
  const meet = { canRead: async () => true, read: async () => ({ found: true, host: 'quinn@company.example', started: start, ended: null, people }) };
  const clockRef = { now: NOW };
  const h = await harness({ world: w, clockRef, calendarIds: ['quinn@company.example'], calendarFloor: NOW - 3 * 3600_000, interviewerEmails: SANTOSH_EMAILS, groups: true, meet, script: [review('send')] });
  const held = await h.runner.runTick({ now: NOW });
  assert.equal(w.slackCalls.filter(c => c.method === 'chat.postMessage').length, 0);
  assert.ok(held.summary.prompts.some(p => p.reason === 'meeting_still_on'), JSON.stringify(held.summary.prompts));
  people = [{ email: 'quinn@company.example', name: 'J Quinn Foster', joined: start, left: NOW + 60_000, present: 41 * 60_000 }];
  clockRef.now = NOW + 2 * 60_000 + 1;
  await h.runner.runTick({ now: clockRef.now });
  let posts = w.slackCalls.filter(c => c.method === 'chat.postMessage');
  assert.equal(posts.length, 1);
  assert.notEqual(posts[0].body.channel, 'GGRP1XXXXXX', 'Interviewer alone, in his own DM');
  // Project, 2026-10-16: Interviewer left and no one joined -> a no-show, the options at once.
  assert.match(posts[0].body.text, /^📋 The Meet shows Interviewer waited 41 minutes and Synthetic Candidate never joined the .*Send them Interviewer's link .*Withdrawn is not a rejection.*If they joined some other way, tap It happened\./);
  assert.deepEqual(blocksOf(posts[0].body.blocks).find(b => b.type === 'actions').elements.map(e => e.action_id), ['nsh_reschedule', 'nsh_close', 'nsh_happened']);
  // Nothing more while it is unanswered.
  clockRef.now += 5 * 60_000; await h.runner.runTick({ now: clockRef.now });
  assert.equal(w.slackCalls.filter(c => c.method === 'chat.postMessage').length, 1);
  // "It happened" (a phone call instead): the usual feedback question follows.
  const q = await noShowQuestion(h);
  await h.store.recordEvent({ eventId: 'ns-h1', source: 'slack', type: 'noshow_choice', occurredAt: clockRef.now, isFixture: false, authorId: PEOPLE.interviewer, requestKey: q.requestKey, choice: 'happened' });
  assert.equal((await h.runner.runEvent({ eventId: 'ns-h1', attemptId: 'h1' })).outcome, 'noshow_choice');
  clockRef.now += 60_000; await h.runner.runTick({ now: clockRef.now });
  posts = w.slackCalls.filter(c => c.method === 'chat.postMessage');
  assert.equal(posts.length, 2);
  assert.match(posts[1].body.text, /The Meet shows no guest joined\./);
});

test('Meet: no grant or no record -> the calendar alone, as before (3 minutes after the end)', async () => {
  const start = NOW - 35 * 60_000, end = NOW - 4 * 60_000;
  const w = world(); w.calendar.listEvents = async () => [slotEvent('m3', { start, end })];
  const meet = { canRead: async () => true, read: async () => ({ found: false, reason: 'no_record' }) };
  const h = await harness({ world: w, calendarIds: ['quinn@company.example'], calendarFloor: NOW - 3 * 3600_000, interviewerEmails: SANTOSH_EMAILS, groups: true, meet, script: [review('send')] });
  await h.runner.runTick({ now: NOW });
  const posts = w.slackCalls.filter(c => c.method === 'chat.postMessage');
  assert.equal(posts.length, 1);
  assert.ok(!/together/.test(posts[0].body.text), 'Interviewer alone, from the invite');
});

test('Meet: the Meet beats a stated assignment; Robin was named but only Interviewer joined -> Interviewer alone', async () => {
  const start = NOW - 35 * 60_000, end = NOW - 5 * 60_000;
  const w = world(); w.calendar.listEvents = async () => [slotEvent('m4', { start, end })];
  const meet = meetCall({ start, ended: NOW - 4 * 60_000, people: [
    { email: 'quinn@company.example', name: 'J Quinn Foster', joined: start, left: NOW - 4 * 60_000, present: 30 * 60_000 },
    { email: null, name: 'Guest', joined: start, left: NOW - 4 * 60_000, present: 30 * 60_000 }] });
  const h = await harness({ world: w, calendarIds: ['quinn@company.example'], calendarFloor: NOW - 3 * 3600_000, interviewerEmails: SANTOSH_EMAILS, groups: true, meet,
    assignmentsOf: async key => key === 'ical-m4' ? { ids: [PEOPLE.robin] } : null, script: [review('send')] });
  await h.runner.runTick({ now: NOW });
  const posts = w.slackCalls.filter(c => c.method === 'chat.postMessage');
  assert.equal(posts.length, 1);
  assert.match(posts[0].body.text, /^📣 I need your call on Synthetic Candidate/);
  assert.equal(w.groupOpens.length, 0);
});

// ---------------------------------------------------------------------------------------------------------------
// The work-trial packet one tap away (work-trial-offer.mjs; Project, 2026-10-16)
// ---------------------------------------------------------------------------------------------------------------
const blocksOf = b => (typeof b === 'string' ? JSON.parse(b) : b);
function fakePackets({ results = [], onRecord = null, out = null } = {}) {
  const sends = [];
  return { sends, ready: async () => true, onRecord: async () => onRecord, outElsewhere: async () => out ?? { docs: null, pay: null },
    send: async ({ who, rate, force }) => { sends.push({ who, rate, force }); return results.shift() ?? { reason: 'sent', envelopeId: 'env-1', text: `📨 Sent ${who.fullName} the work trial documents at US$${rate} per day.` }; } };
}
const offerOf = async h => (await h.store.listRequestsForCandidate({ candidateId: CANDIDATE_ID, limit: 20 })).find(r => r.action === 'work_trial.packet_offer');
const tap = async (h, eventId, requestKey, authorId = PEOPLE.project, rate = undefined) => {
  await h.store.recordEvent({ eventId, source: 'slack', type: 'packet_send', occurredAt: NOW, isFixture: false, authorId, requestKey, ...(rate ? { rate } : {}) });
  return h.runner.runEvent({ eventId, attemptId: `t-${eventId}` });
};

test('Robin calls a work trial: Project gets Send / Send at a different rate; only his tap sends, once; a failed send keeps the buttons', async () => {
  const w = world({ candidateOverrides: { 'Daily Trial Rate': { type: 'number', number: 250 } } });
  const packets = fakePackets({ results: [{ reason: 'list_failed', text: "🚨 DocuSign didn't answer, so I sent nothing. Try again in a minute." }] });
  const h = await harness({ world: w, packets });
  const promptKey = await seedSentPrompt(h);
  await formEvent(h, 'form-P1', promptKey, TRIAL);
  assert.equal((await h.runner.runEvent({ eventId: 'form-P1', attemptId: 'a1' })).outcome, 'record_feedback');
  assert.equal(masonPosts(w).length, 1);
  const post = masonPosts(w)[0].body;
  assert.match(post.text, /^📋 Synthetic Candidate is moving to a work trial, Tue, Oct 20, 2026 to Sat, Oct 24, 2026\. Send the documents and their email at US\$250 per day\?/);
  assert.deepEqual(blocksOf(post.blocks).find(b => b.type === 'actions').elements.map(e => e.action_id), ['wt_send', 'wt_rate']);
  const offer = await offerOf(h);
  assert.equal(offer.payload.rate, 250); assert.equal(offer.payload.trialStart, '2026-10-20');
  // Someone else's tap does nothing.
  assert.equal((await tap(h, 'wt-1', offer.requestKey, PEOPLE.alexis)).outcome, 'no_action');
  assert.equal(packets.sends.length, 0);
  // DocuSign down: nothing sent, the buttons stay, the message says so.
  await tap(h, 'wt-2', offer.requestKey);
  let update = w.slackCalls.filter(c => c.method === 'chat.update').at(-1);
  let blocks = blocksOf(update.body.blocks);
  assert.ok(blocks.some(b => b.type === 'actions'), 'buttons kept after a failed send');
  assert.match(blocks.at(-1).elements[0].text, /DocuSign didn't answer/);
  // Project taps again at a different rate: sent once, buttons gone.
  await tap(h, 'wt-3', offer.requestKey, PEOPLE.project, 300);
  assert.equal(packets.sends.length, 2);
  assert.equal(packets.sends[1].rate, 300); assert.equal(packets.sends[1].who.email, candidate.email); assert.equal(packets.sends[1].who.trialStart, '2026-10-20');
  update = w.slackCalls.filter(c => c.method === 'chat.update').at(-1);
  blocks = blocksOf(update.body.blocks);
  assert.equal(blocks.some(b => b.type === 'actions'), false);
  assert.match(blocks.at(-1).elements[0].text, /Sent Synthetic Candidate/);
  assert.equal((await tap(h, 'wt-4', offer.requestKey)).reason, 'already_answered');
  assert.equal(packets.sends.length, 2);
});

test('Work trial with no dates and a known rate: the invitation is queued by itself, no Send to tap (Project, 2026-10-20)', async () => {
  const w = world({ candidateOverrides: { 'Daily Trial Rate': { type: 'number', number: 250 } } });
  const h = await harness({ world: w, packets: fakePackets(), env: { DB: 'fixture' } });
  const { trialStart, trialEnd, ...noDates } = TRIAL;
  await formEvent(h, 'form-I1', await seedSentPrompt(h), noDates);
  await h.runner.runEvent({ eventId: 'form-I1', attemptId: 'a1' });
  assert.equal(await offerOf(h), undefined, 'no offer to tap');
  assert.match(masonPosts(w).at(-1).body.text, /^🪖 Robin pushed Synthetic Candidate through\. Got everything I need; sending the invite now\./);
  const { noticeStore } = await import('../service/lib/stuck-rejections.mjs');
  assert.equal((await noticeStore(h.env.DB).get(`trialinvite:${CANDIDATE_ID}`))?.rate, 250);
});

test('Skip to work trial with dates and a known rate: the documents and Email 2 go by themselves, no Send to tap (Project, 2026-10-20)', async () => {
  const w = world({ candidateOverrides: { 'Daily Trial Rate': { type: 'number', number: 250 } } });
  const packets = fakePackets({ results: [{ reason: 'queued' }] });
  const h = await harness({ world: w, packets, env: { DB: 'fixture' } });
  await formEvent(h, 'form-S1', await seedSentPrompt(h), TRIAL);
  await h.runner.runEvent({ eventId: 'form-S1', attemptId: 'a1' });
  assert.equal(await offerOf(h), undefined, 'no offer to tap');
  assert.equal(packets.sends.length, 1);
  assert.equal(packets.sends[0].rate, 250); assert.equal(packets.sends[0].who.trialStart, '2026-10-20');
  assert.match(masonPosts(w).at(-1).body.text, /^🪖 Robin pushed Synthetic Candidate through\. Got everything I need; sending the paperwork now\./);
  assert.equal(packets.sends[0].force, true, 'a fresh push-through is a person\'s word');
  // An unanswered pay concern: nothing goes, the offer comes instead.
  const w2 = world({ candidateOverrides: { 'Daily Trial Rate': { type: 'number', number: 250 } } });
  const p2 = fakePackets();
  const h2 = await harness({ world: w2, packets: p2, env: { DB: 'fixture' } });
  const { noticeStore } = await import('../service/lib/stuck-rejections.mjs');
  await noticeStore(h2.env.DB).put(`trialterms:hold:${CANDIDATE_ID}`, { at: NOW }, NOW);
  await formEvent(h2, 'form-S2', await seedSentPrompt(h2), TRIAL);
  await h2.runner.runEvent({ eventId: 'form-S2', attemptId: 'a2' });
  assert.equal(p2.sends.length, 0);
  assert.ok(await offerOf(h2));
});

test('Push-through with no dates: an invite already waiting or sent is never queued again; one Project cancelled goes again; a pay concern holds it', async () => {
  const { noticeStore } = await import('../service/lib/stuck-rejections.mjs');
  const { trialStart, trialEnd, ...noDates } = TRIAL;
  const run = async (seed, id) => {
    const w = world({ candidateOverrides: { 'Daily Trial Rate': { type: 'number', number: 250 } } });
    const h = await harness({ world: w, packets: fakePackets(), env: { DB: 'fixture' } });
    const kv = noticeStore(h.env.DB);
    await seed(kv);
    await formEvent(h, id, await seedSentPrompt(h), noDates);
    await h.runner.runEvent({ eventId: id, attemptId: 'a1' });
    return { last: masonPosts(w).at(-1).body.text, item: await kv.get(`trialinvite:${CANDIDATE_ID}`) };
  };
  const sent = await run(kv => kv.put(`trialinvite:${CANDIDATE_ID}`, { pageId: CANDIDATE_ID, sentAt: NOW - 3600_000, messageId: 'abc123', subject: 'Your Company AI work trial', at: NOW - 3600_000 }, NOW), 'form-Q1');
  assert.match(sent.last, /^🪖 Robin pushed Synthetic Candidate through\. Synthetic's work trial invite already went out\./);
  assert.equal(sent.item.messageId, 'abc123', 'the sent record is kept (its thread)');
  const cancelled = await run(kv => kv.put(`trialinvite:${CANDIDATE_ID}`, { pageId: CANDIDATE_ID, dropped: 'cancelled_by_mason', at: NOW - 3600_000 }, NOW), 'form-Q2');
  assert.match(cancelled.last, /Got everything I need; sending the invite now\./);
  assert.equal(cancelled.item.dropped, undefined); assert.equal(cancelled.item.rate, 250);
  const held = await run(kv => kv.put(`trialterms:hold:${CANDIDATE_ID}`, { at: NOW, quote: 'can you do $300?' }, NOW), 'form-Q3');
  assert.match(held.last, /Not sending the invite: Synthetic pushed back on the pay and hasn't had an answer\./);
  assert.equal(held.item, null);
});

test("Project's tap with an unanswered pay concern sends nothing and says why; his tap re-queues with force", async () => {
  const { noticeStore } = await import('../service/lib/stuck-rejections.mjs');
  const w = world({ candidateOverrides: { 'Daily Trial Rate': { type: 'number', number: 250 } } });
  const packets = fakePackets({ results: [{ reason: 'queued' }] });
  const h = await harness({ world: w, packets, env: { DB: 'fixture' } });
  await noticeStore(h.env.DB).put(`trialterms:hold:${CANDIDATE_ID}`, { at: NOW }, NOW);
  await formEvent(h, 'form-H1', await seedSentPrompt(h), TRIAL);
  await h.runner.runEvent({ eventId: 'form-H1', attemptId: 'a1' });
  const offer = await offerOf(h);
  assert.equal((await tap(h, 'wt-h1', offer.requestKey)).reason, 'pay_concern');
  assert.equal(packets.sends.length, 0);
  assert.match(blocksOf(w.slackCalls.filter(c => c.method === 'chat.update').at(-1).body.blocks).at(-1).elements[0].text, /pushed back on the pay/);
  await noticeStore(h.env.DB).del(`trialterms:hold:${CANDIDATE_ID}`);
  assert.equal((await tap(h, 'wt-h2', offer.requestKey)).reason, 'queued');
  assert.equal(packets.sends[0].force, true);
  assert.match(blocksOf(w.slackCalls.filter(c => c.method === 'chat.update').at(-1).body.blocks).at(-1).elements[0].text, /^Roger that 🫡 US\$250 a day for Synthetic\. Sending the paperwork now\.$/);
});

test('Work trial offers: a recommendation gets no buttons; a packet already out gets a line; no rate asks for one', async () => {
  // Alexis (not Robin) picks Work trial: still a recommendation for Robin, no packet offer.
  const w = world();
  const packets = fakePackets();
  const h = await harness({ world: w, packets });
  const promptKey = await seedSentPrompt(h);
  await formEvent(h, 'form-R1', promptKey, TRIAL, PEOPLE.alexis);
  await h.runner.runEvent({ eventId: 'form-R1', attemptId: 'a1' });
  assert.equal(await offerOf(h), undefined);
  assert.match(masonPosts(w)[0].body.text, /Alexis recommends a work trial.*Robin or Interviewer has to call/);
  // The packet already went out (Project typed it first): the plain line says so.
  const w2 = world();
  const h2 = await harness({ world: w2, packets: fakePackets({ onRecord: { at: NOW - 3600_000, envelopeId: 'x' } }) });
  await formEvent(h2, 'form-R2', await seedSentPrompt(h2), TRIAL);
  await h2.runner.runEvent({ eventId: 'form-R2', attemptId: 'a2' });
  assert.equal(await offerOf(h2), undefined);
  assert.match(masonPosts(w2)[0].body.text, /Their work trial documents already went out from me\./);
  // No pay per day on the record: the owner's line, no buttons (the rate comes as a reply in the thread).
  const w3 = world();
  const h3 = await harness({ world: w3, packets: fakePackets() });
  await formEvent(h3, 'form-R3', await seedSentPrompt(h3), TRIAL);
  await h3.runner.runEvent({ eventId: 'form-R3', attemptId: 'a3' });
  const post = masonPosts(w3)[0].body;
  assert.match(post.text, /^🪖 Robin pushed Synthetic Candidate through to a work trial\. Need Synthetic's daily rate; reply here and I'll send out the paperwork\./);
  assert.equal(blocksOf(post.blocks).some(b => b.type === 'actions'), false);
  // His rate reply settled it (trial-terms.mjs handleTrialRateReply -> closePacketOffer): one line, no buttons, a later tap is already answered.
  const offer3 = await offerOf(h3);
  assert.equal(await h3.runner.closePacketOffer(offer3.requestKey, 'Roger that 🫡 US$100 a day for Synthetic. Sending the paperwork now.'), 'updated');
  const closed = blocksOf(w3.slackCalls.filter(c => c.method === 'chat.update').at(-1).body.blocks);
  assert.equal(closed.some(b => b.type === 'actions'), false);
  assert.match(closed.at(-1).elements[0].text, /Sending the paperwork now/);
  assert.equal((await tap(h3, 'wt-closed', offer3.requestKey, PEOPLE.project, 120)).reason, 'already_answered');
  assert.equal(await h3.runner.closePacketOffer(offer3.requestKey, 'again'), null, 'once');
  // Without DocuSign connected: the plain line, as before.
  const w4 = world();
  const h4 = await harness({ world: w4 });
  await formEvent(h4, 'form-R4', await seedSentPrompt(h4), TRIAL);
  await h4.runner.runEvent({ eventId: 'form-R4', attemptId: 'a4' });
  assert.equal(await offerOf(h4), undefined);
  assert.match(masonPosts(w4)[0].body.text, /Book it and start onboarding\.$|Book it and start onboarding\.\n/);
});


test('Work trial offers: documents and their pay terms already out from Jamie: no ask at all; an addendum send clears the buttons (Project, Oct 19)', async () => {
  const w = world({ candidateOverrides: { 'Daily Trial Rate': { type: 'number', number: 100 } } });
  const h = await harness({ world: w, packets: fakePackets({ out: { docs: { id: 'd', subject: 'Work Trial Docs -- X', status: 'delivered' }, pay: { id: 'a', subject: 'Company - Work Trial Agreement - X', status: 'completed' } } }) });
  await formEvent(h, 'form-J1', await seedSentPrompt(h), TRIAL);
  await h.runner.runEvent({ eventId: 'form-J1', attemptId: 'j1' });
  assert.equal(await offerOf(h), undefined);
  assert.equal(masonPosts(w).length, 0, 'nothing to ask: it was already done');
  // Only the packet out (no pay terms): the offer stands, and Send (the addendum alone) settles it: no buttons left.
  const w2 = world({ candidateOverrides: { 'Daily Trial Rate': { type: 'number', number: 100 } } });
  const packets = fakePackets({ out: { docs: { id: 'd', subject: 'Work Trial Docs -- X', status: 'delivered' }, pay: null },
    results: [{ reason: 'addendum_sent', envelopeId: 'add-1', text: '📨 X already has the work trial documents. Sent X the addendum.' }] });
  const h2 = await harness({ world: w2, packets });
  await formEvent(h2, 'form-J2', await seedSentPrompt(h2), TRIAL);
  await h2.runner.runEvent({ eventId: 'form-J2', attemptId: 'j2' });
  const offer = await offerOf(h2);
  assert.ok(offer);
  await tap(h2, 'tap-J2', offer.requestKey);
  const upd = JSON.parse(w2.slackCalls.filter(c => c.method === 'chat.update').at(-1).body.blocks);
  assert.ok(!upd.some(b => b.type === 'actions'), 'buttons gone once settled');
  assert.match(JSON.stringify(upd), /Sent X the addendum/);
});

// ---------------------------------------------------------------------------------------------------------------
// No-shows: a new link or close them out (no-show.mjs; Project, 2026-10-16)
// ---------------------------------------------------------------------------------------------------------------
const RESCHEDULE_TEMPLATE = "Subject: Rescheduling your Company AI {{call_kind}}\n\nHi {{first_name}},\n\nWe missed you at your {{call_kind}} with {{interviewer_name}}. No problem, these things happen. Here's a link to pick a new time: {{booking_link}}\n\nIf your plans have changed, just reply and let us know.";
function noShowWorld() {
  const w = world();
  const { RESCHEDULE_TEMPLATE_ID } = NOSHOW;
  w.pages.set(RESCHEDULE_TEMPLATE_ID, { object: 'page', id: RESCHEDULE_TEMPLATE_ID, archived: false, parent: { type: 'data_source_id', data_source_id: GUIDES_SOURCE_ID }, properties: { 'Full email': rt(RESCHEDULE_TEMPLATE) } });
  const row = (id, interviewer, useFor, url) => w.pages.set(id, { object: 'page', id, archived: false, parent: { type: 'data_source_id', data_source_id: GUIDES_SOURCE_ID },
    properties: { Interviewer: sel(interviewer), 'Use for': sel(useFor), 'Booking link': { type: 'url', url } } });
  row('44444444-0000-4000-8000-000000000001', 'Robin', 'First call', 'https://calendar.app.google/robin-synthetic');
  row('44444444-0000-4000-8000-000000000002', 'Interviewer (Quinn)', 'First call', 'https://calendly.com/quinn-synthetic/30min');
  row('44444444-0000-4000-8000-000000000003', 'Interviewer (Quinn)', 'Technical interview', 'https://calendly.com/quinn-synthetic/technical-deep-dive');
  return w;
}
const NO_SHOW_FORM = { decision: 'did_not_happen', observations: '', whatHappened: 'no_show' };
const noShowQuestion = async h => (await h.store.listRequestsForCandidate({ candidateId: CANDIDATE_ID, limit: 30 })).find(r => r.action === 'noshow.choice');
const choose = async (h, eventId, requestKey, choice, authorId = PEOPLE.robin) => {
  await h.store.recordEvent({ eventId, source: 'slack', type: 'noshow_choice', occurredAt: NOW, isFixture: false, authorId, requestKey, choice });
  return h.runner.runEvent({ eventId, attemptId: `n-${eventId}` });
};

test('No-show: the interviewer gets "Send a new link" / "Close them out" on the thread, not a note to Project', async () => {
  const w = noShowWorld(); const h = await harness({ world: w }); const key = await seedSentPrompt(h);
  await formEvent(h, 'form-NS1', key, NO_SHOW_FORM);
  assert.equal((await h.runner.runEvent({ eventId: 'form-NS1', attemptId: 'a1' })).outcome, 'record_feedback');
  const question = w.slackCalls.filter(c => c.method === 'chat.postMessage' && c.body.channel === RISHI_DM).at(-1).body;
  assert.match(question.text, /^📋 Synthetic Candidate didn't show for the technical interview\. Send them Robin's link to pick a new time.*or withdraw them\? Withdrawn is not a rejection: no rejection email goes out\./);
  assert.deepEqual(blocksOf(question.blocks).find(b => b.type === 'actions').elements.map(e => e.action_id), ['nsh_reschedule', 'nsh_close']);
  assert.equal(question.thread_ts, ROOT_TS, 'on the interview thread');
  assert.equal(masonPosts(w).length, 0);
});

test('No-show, close them out: Withdrawn or Unavailable, the question settles, Project gets one line; a second tap does nothing', async () => {
  const w = noShowWorld(); const h = await harness({ world: w }); const key = await seedSentPrompt(h);
  await formEvent(h, 'form-NS2', key, NO_SHOW_FORM); await h.runner.runEvent({ eventId: 'form-NS2', attemptId: 'a1' });
  const q = await noShowQuestion(h);
  assert.equal((await choose(h, 'ns-c1', q.requestKey, 'close', PEOPLE.jamie)).reason, 'not_allowed');
  const closed = await choose(h, 'ns-c2', q.requestKey, 'close');
  assert.equal(closed.outcome, 'noshow_choice', JSON.stringify(closed));
  const outcome = w.patches().map(p => p.body.properties?.Outcome?.select?.name).filter(Boolean).at(-1);
  assert.equal(outcome, 'Withdrawn or Unavailable');
  assert.match(masonPosts(w).at(-1).body.text, /Robin withdrew them after a no-show: Withdrawn or Unavailable, no rejection email/);
  const update = w.slackCalls.filter(c => c.method === 'chat.update').at(-1);
  assert.match(blocksOf(update.body.blocks).at(-1).elements[0].text, /Withdrawn by Robin: .*No rejection email goes to them\./);
  assert.equal((await choose(h, 'ns-c3', q.requestKey, 'reschedule')).reason, 'already_answered');
});

test("No-show, new link: the reschedule email is held for Project's Cancel with the right link; Interviewer who took Robin's booking gets his own link", async () => {
  const w = noShowWorld(); const h = await harness({ world: w }); const key = await seedSentPrompt(h);
  await formEvent(h, 'form-NS3', key, NO_SHOW_FORM); await h.runner.runEvent({ eventId: 'form-NS3', attemptId: 'a1' });
  const q = await noShowQuestion(h);
  const r = await choose(h, 'ns-r1', q.requestKey, 'reschedule');
  assert.equal(r.outcome, 'noshow_choice', JSON.stringify(r));
  const [row] = opsRows(w, 'email.reschedule');
  assert.equal(row.properties.State.select.name, 'Held');
  const body = (row.properties['Email body']?.rich_text ?? []).map(x => x.plain_text ?? x.text?.content).join('');
  assert.match(body, /We missed you at your technical interview with Robin\. .*https:\/\/calendar\.app\.google\/robin-synthetic/);
  const notice = masonPosts(w).at(-1).body;
  assert.match(notice.text, /^📋 Robin asked to reschedule Synthetic Candidate after a no-show\. I'll email them Robin's link/);
  assert.deepEqual(blocksOf(notice.blocks).find(b => b.type === 'actions').elements.map(e => e.action_id), ['em_cancel']);
  // Interviewer picked up one of Robin's bookings: the link is Interviewer's regular one, never Robin's.
  const { takerOf, linkCandidates } = NOSHOW;
  const taker = takerOf({ authorId: PEOPLE.project, askedIds: [PEOPLE.interviewer], interviewerIds: [PEOPLE.robin, PEOPLE.interviewer, PEOPLE.alexis] });
  assert.equal(taker, PEOPLE.interviewer);
  assert.equal(takerOf({ authorId: PEOPLE.project, askedIds: [PEOPLE.robin, PEOPLE.interviewer], interviewerIds: [PEOPLE.robin, PEOPLE.interviewer] }), PEOPLE.interviewer, 'Interviewer first when both took it');
  assert.deepEqual(linkCandidates({ interviewerId: PEOPLE.interviewer }).slice(0, 1), [{ interviewer: 'Interviewer (Quinn)', useFor: 'First call' }]);
  assert.deepEqual(linkCandidates({ interviewerId: PEOPLE.interviewer, deepDive: true }).slice(0, 1), [{ interviewer: 'Interviewer (Quinn)', useFor: 'Technical interview' }]);
});

test('No-show, new link: after the 30 minutes the email goes once from Project\'s Gmail; a closed candidate cancels it', async () => {
  const sent = [];
  const gmail = { connected: async () => true, send: async m => { sent.push(m); return { id: 'abc123', threadId: 'abc123', url: 'https://mail.google.com/x' }; } };
  const w = noShowWorld(); const clockRef = { now: NOW }; const h = await harness({ world: w, gmail, clockRef }); const key = await seedSentPrompt(h);
  await formEvent(h, 'form-NS4', key, NO_SHOW_FORM); await h.runner.runEvent({ eventId: 'form-NS4', attemptId: 'a1' });
  await choose(h, 'ns-r4', (await noShowQuestion(h)).requestKey, 'reschedule');
  const local = (await h.runner.syncControl()).local;
  assert.deepEqual((await h.runner.planRescheduleEmails({ now: NOW + 10 * 60_000, local })).length, 0, 'still in the Cancel window');
  clockRef.now = NOW + 36 * 60_000;
  const out = await h.runner.planRescheduleEmails({ now: clockRef.now, local });
  assert.deepEqual(out.map(r => r.reason), ['sent']);
  assert.equal(sent.length, 1); assert.equal(sent[0].to, candidate.email); assert.match(sent[0].subject, /^Rescheduling your Company AI technical interview$/);
  assert.equal(opsRows(w, 'email.reschedule')[0].properties.State.select.name, 'Complete');
  assert.equal((await h.runner.planRescheduleEmails({ now: clockRef.now + 60_000, local })).length, 0, 'never twice');
  assert.equal(sent.length, 1);
});
