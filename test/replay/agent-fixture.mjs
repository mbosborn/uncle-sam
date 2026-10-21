import assert from 'node:assert/strict';
import { slackArguments } from '../support/slack-wire.mjs';

// REST fixture adapted from agent-runner.test.mjs. Production clients still parse,
// validate, write and read back every page/message. Unknown calls fail closed.
export function agentFixture(modules, NOW) {
  const { PEOPLE } = modules.agent;
  const { RECRUITING_SOURCE_ID, FEEDBACK_SOURCE_ID, GUIDES_SOURCE_ID } = modules.notion;
  const { CONTROL_PAGE_ID, OPS_SOURCE_ID } = modules.wake;
  const { requestKey } = modules.policy;
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

async function seedSentPrompt(h, { occurrenceId = 'cal:ical-1', author = PEOPLE.robin } = {}) {
  const route = author === PEOPLE.interviewer ? 'interviewer_santosh' : 'interviewer_rishi';
  const dm = routeMap[route].channelId;
  const local = await h.runner.syncControl();
  const key = requestKey({ candidate, occurrenceId, action: 'interview.feedback_request', recipientIds: [author] });
  await h.store.recordEvent({ eventId: 'calendar:evt1:v1', source: 'calendar', occurredAt: NOW - 3600_000, payload: { type: 'calendar_event' }, isFixture: false });
  await h.store.ensureRequest({ requestKey: key, candidateId: candidate.pageId, occurrenceId, action: 'interview.feedback_request', recipientIds: [author],
    payload: { routeKey: route, roleRound: 'R2 — Technical', candidate, scheduleKey: 'sk1', sourceUrl: 'https://calendar.google.com/event?eid=1' },
    triggerAt: NOW - 1800_000, sourceEventId: 'calendar:evt1:v1' });
  const claim = await h.store.claimRequest({ requestKey: key, claimToken: 'seed', expectedControlVersion: local.local.version, expectedPauseGeneration: local.local.pauseGeneration });
  assert.equal(claim.claimed, true);
  const thread = await h.store.reserveCandidateThread({ requestKey: key, candidateId: candidate.pageId, routeKey: route, channelId: dm });
  assert.equal(thread.verified, true);
  const saved = await h.store.saveCandidateThread({ requestKey: key, candidateId: candidate.pageId, routeKey: route, channelId: dm,
    ownerRequestKey: key, previousThreadTs: null, threadTs: ROOT_TS, verified: true });
  assert.equal(saved.verified, true);
  await h.store.completeRequest({ requestKey: key, claimToken: 'seed', state: 'Sent', receipt: { verified: true, resultId: `${dm}:${ROOT_TS}`,
    channelId: dm, messageTs: ROOT_TS, threadTs: ROOT_TS, messageUrl: `https://example-workspace.slack.com/archives/${dm}/p1791920000123456`, verifiedAt: NOW - 1700_000, text: 'Existing prompt' } });
  return key;
}

return { world, seedSentPrompt, routeMap, CANDIDATE_ID, candidate, rt, sel, BOT_USER, BOT_ID, ROOT_TS };
}
