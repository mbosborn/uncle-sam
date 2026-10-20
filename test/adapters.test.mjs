import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeClient, ClaudeError, ANTHROPIC_VERSION, DEFAULT_OPENROUTER_MODEL, DEFAULT_MAX_TOKENS, isModelName } from '../service/lib/anthropic.mjs';
import { createNotionClient, controlOf, candidateOf, normalizeLayout, RECRUITING_SOURCE_ID } from '../service/lib/notion-client.mjs';
import { CONTROL_PAGE_ID } from '../service/lib/notion-wake.mjs';
import { parseRouteMap, routesFromMap, parseInterviewerEmails, parseCalendarFloor, describeConfiguration, createRuntime, llmRouteOf, llmSettingsOf } from '../service/lib/runtime.mjs';
import { persistedFixture } from './support/d1.mjs';
import { normalizeCalendarEvent, parseServiceAccount, CalendarError } from '../service/lib/google-calendar.mjs';

// Adapter contracts with local fakes only. No network, no credentials.
const rt = text => ({ type: 'rich_text', rich_text: text ? [{ plain_text: text, text: { content: text } }] : [] });
const sel = name => ({ type: 'select', select: name ? { name } : null });

test('Claude client: one bounded POST with the pinned API version; errors carry codes, never bodies', async () => {
  const calls = [];
  const client = createClaudeClient({ apiKey: 'sk-ant-synthetic', model: 'claude-sonnet-4-5', timeoutMs: 5000, maxResponseBytes: 2048,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const scenario = calls.length;
      if (scenario === 1) return Response.json({ id: 'msg_1', type: 'message', model: 'claude-sonnet-4-5', stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'propose', input: { kind: 'no_action' } }], usage: { input_tokens: 12, output_tokens: 4 } });
      if (scenario === 2) return new Response(JSON.stringify({ error: { message: 'SECRET_SENTINEL leaked?' } }), { status: 429 });
      if (scenario === 3) return new Response('x'.repeat(5000), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response('not json', { status: 200 });
    } });
  const ok = await client.complete({ system: 'sys', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'propose', input_schema: { type: 'object' } }], toolChoice: { type: 'any' } });
  assert.equal(ok.stopReason, 'tool_use'); assert.deepEqual(ok.usage, { input: 12, output: 4 });
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].init.headers['anthropic-version'], ANTHROPIC_VERSION);
  assert.equal(calls[0].init.redirect, 'error');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'claude-sonnet-4-5'); assert.equal(body.system, 'sys'); assert.deepEqual(body.tool_choice, { type: 'auto' }, 'a forced tool is asked as auto: the configured model refuses forced tools');
  for (const [code] of [['anthropic_http_429'], ['response_too_large'], ['invalid_response']]) {
    const error = await client.complete({ messages: [{ role: 'user', content: 'x' }] }).catch(e => e);
    assert.ok(error instanceof ClaudeError); assert.equal(error.code, code);
    assert.ok(!String(error.message).includes('SECRET_SENTINEL'));
  }
  assert.throws(() => createClaudeClient({ apiKey: '' }), /anthropic_not_configured/);
  assert.throws(() => createClaudeClient({ apiKey: 'k', model: 'bad model name!' }), /invalid_model/);
  await assert.rejects(client.complete({ messages: [] }), /messages_required/);
});

test('controlOf accepts only the real control row; candidateOf strips the decorative star and verifies the email', () => {
  const page = { object: 'page', id: CONTROL_PAGE_ID, properties: { 'Record kind': sel('Control'), 'Request key': rt('uncle-sam:control'), Mode: sel('Live'),
    'Baseline complete': { type: 'checkbox', checkbox: true }, 'Activated at': { type: 'date', date: { start: '2026-10-12T07:00:00.000Z' } }, 'Policy version': rt('v') } };
  assert.deepEqual(controlOf(page), { mode: 'Live', baselineComplete: true, activatedAt: Date.parse('2026-10-12T07:00:00.000Z'), policyVersion: 'v', state: null, questions: 'On' });
  assert.equal(controlOf({ ...page, properties: { ...page.properties, Questions: { type: 'select', select: { name: 'Off' } } } }).questions, 'Off');
  assert.equal(controlOf({ ...page, properties: { ...page.properties, Questions: { type: 'select', select: { name: 'On' } } } }).questions, 'On');
  assert.throws(() => controlOf({ ...page, id: '00000000-0000-4000-8000-000000000000' }), /invalid_control/);
  assert.throws(() => controlOf({ ...page, properties: { ...page.properties, Mode: sel('Maybe') } }), /invalid_control_mode/);
  assert.throws(() => controlOf({ ...page, archived: true }), /invalid_control/);
  const id = '11111111-2222-4333-8444-555555555555';
  const candidate = candidateOf({ object: 'page', id, url: 'https://www.notion.so/x', parent: { type: 'data_source_id', data_source_id: RECRUITING_SOURCE_ID },
    properties: { Candidate: { type: 'title', title: [{ plain_text: 'Jane Doe ⭐' }] }, Email: { type: 'email', email: 'Jane@Example.invalid' }, Outcome: sel('Proceeding'),
      Owner: { type: 'multi_select', multi_select: [{ name: 'AA (Rory A)' }] }, 'Rejection email hold': { type: 'checkbox', checkbox: true } } });
  assert.equal(candidate.fullName, 'Jane Doe'); assert.equal(candidate.email, 'Jane@Example.invalid'); assert.equal(candidate.emailVerified, true);
  assert.equal(candidate.inRecruitingSource, true); assert.deepEqual(candidate.fields.Owner, ['AA (Rory A)']); assert.equal(candidate.fields['Rejection email hold'], true);
  const noEmail = candidateOf({ object: 'page', id, parent: { type: 'data_source_id', data_source_id: RECRUITING_SOURCE_ID }, properties: { Candidate: { type: 'title', title: [{ plain_text: 'X' }] }, Email: { type: 'email', email: 'not an email' } } });
  assert.equal(noEmail.emailVerified, false); assert.equal(noEmail.email, null);
  const layout = normalizeLayout({ id: RECRUITING_SOURCE_ID, properties: { 'Candidate brief': { type: 'rich_text' }, 'Dot color': { type: 'select', select: { options: [{ name: 'Automatic' }] } } } });
  assert.deepEqual(layout.properties, { 'Candidate brief': { type: 'text' }, 'Dot color': { type: 'select', options: ['Automatic'] } });
});

test('applyCandidatePlan writes only brief/next action/Action Status, reads back, and refuses when identity or manual colors change', async () => {
  const id = '11111111-2222-4333-8444-555555555555';
  const page = { object: 'page', id, url: 'https://www.notion.so/x', archived: false, parent: { type: 'data_source_id', data_source_id: RECRUITING_SOURCE_ID },
    properties: { Candidate: { type: 'title', title: [{ plain_text: 'Jane' }] }, Email: { type: 'email', email: 'jane@example.invalid' }, 'Color mode': sel('Manual override'), 'Dot color': sel('🔴 Red'),
      'Candidate brief': rt(''), 'Next action': rt(''), 'Action Status': sel('Awaiting Feedback') } };
  const calls = [];
  let dotColorAfterPatch = '🔴 Red';
  const client = createNotionClient({ env: { NOTION_TOKEN: 'ntn_synthetic' }, fetchImpl: async (url, init) => {
    calls.push({ method: init.method ?? 'GET', path: new URL(url).pathname });
    assert.equal(init.headers.authorization, 'Bearer ntn_synthetic');
    if (init.method === 'PATCH') {
      for (const [name, value] of Object.entries(JSON.parse(init.body).properties)) {
        page.properties[name] = value.rich_text ? { type: 'rich_text', rich_text: value.rich_text.map(x => ({ ...x, plain_text: x.text.content })) } : sel(value.select.name);
      }
      page.properties['Dot color'] = sel(dotColorAfterPatch);
    }
    return Response.json(page);
  } });
  await assert.rejects(client.applyCandidatePlan({ pageId: id, properties: { Outcome: 'Not Selected' } }), /candidate_patch_not_allowed/);
  await assert.rejects(client.applyCandidatePlan({ pageId: id, properties: { 'Candidate brief': 'x' }, expectedEmail: 'someone-else@example.invalid' }), /candidate_identity_changed/);
  const result = await client.applyCandidatePlan({ pageId: id, properties: { 'Candidate brief': 'Status: ok', 'Next action': 'Project: schedule', 'Action Status': 'Needs Project' }, expectedEmail: 'jane@example.invalid' });
  assert.equal(result.verified, true);
  assert.equal(calls.filter(c => c.method === 'PATCH').length, 1);
  dotColorAfterPatch = '🟢 Green'; // a manual colour silently changing under us must fail closed
  await assert.rejects(client.applyCandidatePlan({ pageId: id, properties: { 'Next action': 'again' }, expectedEmail: 'jane@example.invalid' }), /color_selection_changed/);
  await assert.rejects(createNotionClient({ env: {} }).readControl(), /notion_not_configured/);
});

test('route map, interviewer e-mails and configuration summary validate shapes and never expose values', () => {
  const map = parseRouteMap(JSON.stringify({ interviewer_rishi: { channelId: 'D1', type: 'im' }, jamie_group: { channelId: 'G2', type: 'mpim' } }));
  assert.deepEqual(routesFromMap(map), { im: ['D1'], mpim: ['G2'], group: [], channel: [] });
  assert.throws(() => parseRouteMap(JSON.stringify({ jamie_group: { channelId: 'D1', type: 'im' } })), /invalid_route_map/);
  assert.throws(() => parseRouteMap(JSON.stringify({ unknown_route: { channelId: 'D1', type: 'im' } })), /invalid_route_map/);
  assert.deepEqual(parseRouteMap(undefined), {});
  assert.deepEqual(parseInterviewerEmails('{"Robin@company.example":"U0A4F08721B"}'), { 'robin@company.example': 'U0A4F08721B' });
  assert.throws(() => parseInterviewerEmails('{"robin@company.example":"not-a-user"}'), /invalid_interviewer_emails/);
  const summary = describeConfiguration({ DB: {}, SLACK_BOT_TOKEN: 'xoxb-abc-def', NOTION_TOKEN: 'ntn_x', ANTHROPIC_API_KEY: 'sk', UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled',
    SLACK_ROUTE_MAP_JSON: JSON.stringify({ project: { channelId: 'D9', type: 'im' } }) });
  assert.equal(summary.automaticActivity, 'enabled'); assert.equal(summary.routes, 1); assert.equal(summary.slackBot, true); assert.equal(summary.calendar, false);
  assert.ok(!JSON.stringify(summary).includes('xoxb-abc-def') && !JSON.stringify(summary).includes('ntn_x'));
});

test('calendar start time: parsed strictly with a zone, summarised without its value, and wired into the runtime without ever stopping the bot', () => {
  for (const blank of [undefined, null, '', '   ']) assert.equal(parseCalendarFloor(blank), null);
  const at = Date.parse('2026-10-15T14:20:00Z');
  for (const text of ['2026-10-15T14:20:00Z', '2026-10-15T14:20Z', '2026-10-15T07:20:00-07:00', ' 2026-10-15T14:20:00Z ']) assert.equal(parseCalendarFloor(text), at, text);
  assert.equal(parseCalendarFloor('2026-10-15T14:20:00.250Z'), at + 250);
  for (const bad of ['2026-10-15', '2026-10-15T14:20:00', '2026-10-15 14:20:00Z', 'soon', '2026-10-15T25:00:00Z', '1760538000000', 1760538000000, '{}'])
    assert.throws(() => parseCalendarFloor(bad), /invalid_calendar_floor/, String(bad));
  assert.equal(describeConfiguration({}).calendarFloor, 'unset');
  assert.equal(describeConfiguration({ UNCLE_SAM_CALENDAR_FLOOR: '2099-01-01T00:00:00Z' }).calendarFloor, 'set');
  assert.equal(describeConfiguration({ UNCLE_SAM_CALENDAR_FLOOR: 'soon' }).calendarFloor, 'invalid');
  assert.ok(!JSON.stringify(describeConfiguration({ UNCLE_SAM_CALENDAR_FLOOR: '2099-01-01T00:00:00Z' })).includes('2099'), 'the value itself is not echoed');
  const base = { DB: persistedFixture(at).db, NOTION_TOKEN: 'ntn_synthetic_fixture_token', SLACK_BOT_TOKEN: 'xoxb-fixture-only', SLACK_BOT_USER_ID: 'UUNCLESAM', SLACK_BOT_ID: 'BUNCLESAM' };
  const wired = createRuntime({ ...base, UNCLE_SAM_CALENDAR_FLOOR: '2026-10-15T14:20:00Z' });
  assert.equal(wired.calendarFloor, at); assert.equal(wired.runner.calendarFloor, at, 'the runner is given the same start time');
  assert.equal(createRuntime(base).runner.calendarFloor, null);
  assert.equal(createRuntime({ ...base, UNCLE_SAM_CALENDAR_FLOOR: 'soon' }).runner.calendarFloor, null, 'a typo keeps only the calendar path off; the rest of the bot still runs');
});

test('calendar normalization keeps only https links and lower-cases attendees; service account JSON is validated', () => {
  const event = normalizeCalendarEvent({ id: 'e1', iCalUID: 'u1', summary: 'Company x Jane', status: 'confirmed', start: { dateTime: '2026-10-13T22:00:00Z' },
    end: { dateTime: '2026-10-13T22:45:00Z' }, htmlLink: 'http://insecure.example/e1', attendees: [{ email: 'Robin@company.example', responseStatus: 'accepted' }, { email: 'jane@example.invalid' }] }, 'cal-1');
  assert.equal(event.htmlLink, null); assert.equal(event.attendees[0].email, 'robin@company.example'); assert.equal(event.allDay, false); assert.equal(event.calendarId, 'cal-1');
  assert.equal(normalizeCalendarEvent({ id: 'e2', start: { date: '2026-10-13' }, end: { date: '2026-10-14' } }, 'c').allDay, true);
  assert.throws(() => parseServiceAccount('{"type":"user"}'), CalendarError);
  assert.throws(() => parseServiceAccount('not json'), CalendarError);
  assert.equal(parseServiceAccount({ type: 'service_account', client_email: 'svc@proj.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n' }).clientEmail, 'svc@proj.iam.gserviceaccount.com');
});

test('Claude client over OpenRouter: an Anthropic-shaped request, bearer auth, pinned to Anthropic with no fallback; errors name the route and carry no body', async () => {
  const KEY = 'sk-or-v1-fixtureOpenRouterKeyValue0123456789';
  const calls = [];
  const client = createClaudeClient({ route: 'openrouter', apiKey: KEY, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) return Response.json({ id: 'msg_or', type: 'message', role: 'assistant', model: 'anthropic/claude-sonnet-5.5', stop_reason: 'tool_use', provider: 'Anthropic',
      content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 'tu_1', name: 'propose', input: { kind: 'no_action' } }], usage: { input_tokens: 9, output_tokens: 3 } });
    if (calls.length === 2) return new Response(JSON.stringify({ error: { message: `${KEY} is out of credit` } }), { status: 402 });
    return Response.json({ id: 'msg_x', type: 'message', content: [], provider: { name: 'an object is not trusted' } });
  } });
  assert.equal(client.route, 'openrouter'); assert.equal(client.model, DEFAULT_OPENROUTER_MODEL); assert.equal(DEFAULT_OPENROUTER_MODEL, 'anthropic/claude-sonnet-5.5');
  const ok = await client.complete({ system: 'sys', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'propose', input_schema: { type: 'object' } }], toolChoice: { type: 'auto' } });
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/messages');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${KEY}`);
  assert.equal('x-api-key' in calls[0].init.headers, false, 'the OpenRouter key is never sent as an Anthropic key');
  assert.equal(calls[0].init.redirect, 'error');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'anthropic/claude-sonnet-5.5'); assert.deepEqual(body.provider, { only: ['anthropic'], allow_fallbacks: false });
  assert.equal(body.max_tokens, DEFAULT_MAX_TOKENS); assert.deepEqual(body.tool_choice, { type: 'auto' }); assert.equal(body.system, 'sys');
  assert.equal(ok.stopReason, 'tool_use'); assert.deepEqual(ok.usage, { input: 9, output: 3 }); assert.equal(ok.servedBy, 'Anthropic');
  assert.equal(ok.content[0].type, 'thinking', 'blocks come back untouched so the runner can replay them');
  const denied = await client.complete({ messages: [{ role: 'user', content: 'x' }] }).catch(error => error);
  assert.ok(denied instanceof ClaudeError); assert.equal(denied.code, 'openrouter_http_402'); assert.equal(denied.status, 402);
  assert.equal(String(denied.message).includes(KEY), false, 'the response body, which here repeats the key, is never kept');
  assert.equal((await client.complete({ messages: [{ role: 'user', content: 'x' }] })).servedBy, null, 'a provider that is not a short string is ignored');
  assert.equal(JSON.stringify(calls.map(call => call.init.body)).includes(KEY), false, 'the key travels only in the Authorization header');
});

test('Claude client: the direct route keeps its x-api-key header and gets the larger default token limit; each route accepts only its own model names', async () => {
  const bodies = [];
  const direct = createClaudeClient({ apiKey: 'sk-ant-synthetic', fetchImpl: async (url, init) => {
    bodies.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return Response.json({ id: 'msg_d', type: 'message', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } });
  } });
  assert.equal(direct.route, 'anthropic');
  await direct.complete({ messages: [{ role: 'user', content: 'a' }] });
  await direct.complete({ messages: [{ role: 'user', content: 'b' }], maxTokens: 123 });
  assert.equal(bodies[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(bodies[0].headers['x-api-key'], 'sk-ant-synthetic'); assert.equal('authorization' in bodies[0].headers, false);
  assert.equal('provider' in bodies[0].body, false, 'the routing preferences belong to OpenRouter only');
  assert.equal(bodies[0].body.max_tokens, DEFAULT_MAX_TOKENS); assert.equal(bodies[1].body.max_tokens, 123);
  assert.ok(DEFAULT_MAX_TOKENS >= 8192, 'the new models think by default and thinking counts against the limit');
  assert.equal(isModelName('openrouter', 'anthropic/claude-sonnet-5.5'), true);
  assert.equal(isModelName('openrouter', '~anthropic/claude-sonnet-latest'), true);
  assert.equal(isModelName('anthropic', 'claude-sonnet-5-5'), true);
  for (const bad of ['claude-sonnet-5-5', 'anthropic/', 'bad model/name', 'a/b/c', '../x', '', 42, null]) assert.equal(isModelName('openrouter', bad), false, String(bad));
  assert.equal(isModelName('anthropic', 'anthropic/claude-sonnet-5.5'), false, 'a vendor/model name is not an Anthropic id');
  assert.equal(isModelName('nowhere', 'claude-sonnet-5-5'), false); assert.equal(isModelName('__proto__', 'claude-sonnet-5-5'), false);
  assert.throws(() => createClaudeClient({ route: 'openrouter', apiKey: 'k', model: 'claude-sonnet-5-5' }), /invalid_model/);
  assert.throws(() => createClaudeClient({ apiKey: 'k', model: 'anthropic/claude-sonnet-5.5' }), /invalid_model/);
  assert.throws(() => createClaudeClient({ route: 'openrouter', apiKey: '' }), /openrouter_not_configured/);
  assert.throws(() => createClaudeClient({ route: 'openrouter', apiKey: 'has space' }), /openrouter_not_configured/);
  assert.throws(() => createClaudeClient({ route: 'nowhere', apiKey: 'k' }), /invalid_route/);
  assert.throws(() => createClaudeClient({ route: '__proto__', apiKey: 'k' }), /invalid_route/);
});

test('model route: Anthropic\'s own key wins, OpenRouter is the alternative, and the summary and the runtime agree without exposing a key', () => {
  assert.equal(llmRouteOf({}), 'none');
  assert.equal(llmRouteOf({ OPENROUTER_API_KEY: 'o' }), 'openrouter');
  assert.equal(llmRouteOf({ ANTHROPIC_API_KEY: 'a', OPENROUTER_API_KEY: 'o' }), 'anthropic');
  assert.equal(llmRouteOf({ ANTHROPIC_API_KEY: '', OPENROUTER_API_KEY: 'o' }), 'openrouter', 'an empty Anthropic key is no key');
  assert.equal(llmSettingsOf({}), null);
  assert.deepEqual(llmSettingsOf({ OPENROUTER_API_KEY: 'o', OPENROUTER_MODEL: 'anthropic/claude-sonnet-5.5', ANTHROPIC_MODEL: 'ignored-on-this-route' }),
    { route: 'openrouter', apiKey: 'o', model: 'anthropic/claude-sonnet-5.5' });
  assert.deepEqual(llmSettingsOf({ ANTHROPIC_API_KEY: 'a', OPENROUTER_API_KEY: 'o', OPENROUTER_MODEL: 'anthropic/claude-sonnet-5.5' }), { route: 'anthropic', apiKey: 'a' });
  const both = describeConfiguration({ ANTHROPIC_API_KEY: 'a', OPENROUTER_API_KEY: 'o', ANTHROPIC_MODEL: 'claude-sonnet-5-5', OPENROUTER_MODEL: 'anthropic/claude-sonnet-5.5' });
  assert.equal(both.llm, 'anthropic'); assert.equal(both.model, 'claude-sonnet-5-5');
  const only = describeConfiguration({ OPENROUTER_API_KEY: 'sk-or-v1-secretmarker', OPENROUTER_MODEL: 'anthropic/claude-sonnet-5.5' });
  assert.equal(only.llm, 'openrouter'); assert.equal(only.openrouter, true); assert.equal(only.anthropic, false); assert.equal(only.model, 'anthropic/claude-sonnet-5.5');
  assert.equal(JSON.stringify(only).includes('secretmarker'), false);
  assert.equal(describeConfiguration({}).llm, 'none'); assert.equal(describeConfiguration({}).model, 'default');
  const base = { DB: persistedFixture(Date.parse('2026-10-14T15:20:00Z')).db, NOTION_TOKEN: 'ntn_synthetic_fixture_token', SLACK_BOT_TOKEN: 'xoxb-fixture-only', SLACK_BOT_USER_ID: 'UUNCLESAM', SLACK_BOT_ID: 'BUNCLESAM' };
  assert.equal(createRuntime(base).claude, null, 'no key, no model: events that need it are reported, the rest still runs');
  const viaOpenRouter = createRuntime({ ...base, OPENROUTER_API_KEY: 'sk-or-v1-fixture-key-value-0123456789' }).claude;
  assert.equal(viaOpenRouter.route, 'openrouter'); assert.equal(viaOpenRouter.model, 'anthropic/claude-sonnet-5.5');
  const direct = createRuntime({ ...base, ANTHROPIC_API_KEY: 'sk-ant-fixture', OPENROUTER_API_KEY: 'sk-or-v1-fixture-key-value-0123456789', ANTHROPIC_MODEL: 'claude-sonnet-5-5' }).claude;
  assert.equal(direct.route, 'anthropic'); assert.equal(direct.model, 'claude-sonnet-5-5');
  assert.throws(() => createRuntime({ ...base, OPENROUTER_API_KEY: 'sk-or-v1-fixture-key-value-0123456789', OPENROUTER_MODEL: 'claude-sonnet-5-5' }), /invalid_model/, 'a model name from the wrong route stops the runtime instead of failing on every call');
});

test('calendar listing follows Google\'s next page, so a busy calendar is read past the first page', async () => {
  const { createCalendarReader } = await import('../service/lib/google-calendar.mjs');
  const calls = [];
  const page = (n, next) => ({ items: Array.from({ length: n }, (_, i) => ({ id: `e${calls.length}-${i}`, start: { dateTime: '2026-10-20T17:00:00Z' }, end: { dateTime: '2026-10-20T17:30:00Z' } })), ...(next ? { nextPageToken: next } : {}) });
  const reader = createCalendarReader({ tokenProvider: async () => 'tok', clock: () => 0, fetchImpl: async url => {
    const u = new URL(url); calls.push(u.searchParams.get('pageToken'));
    return Response.json(calls.length === 1 ? page(250, 'p2') : page(40, null));
  } });
  const events = await reader.listEvents({ calendarId: 'robin@company.example', timeMin: 0, timeMax: 86400_000 });
  assert.equal(events.length, 290);
  assert.deepEqual(calls, [null, 'p2']);
});

test('createCandidate: someone who answered Robin\'s message goes in at Outreach with their LinkedIn and no email; a LinkedIn already on the tracker is refused', async () => {
  const id = '22222222-3333-4444-8555-666666666666';
  let created = null, existing = false;
  const client = createNotionClient({ env: { NOTION_TOKEN: 'ntn_synthetic' }, fetchImpl: async (url, init) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/query')) return Response.json({ object: 'list', results: existing ? [{ object: 'page', id, parent: { type: 'data_source_id', data_source_id: RECRUITING_SOURCE_ID },
      properties: { Candidate: { type: 'title', title: [{ plain_text: 'Priya Shah' }] }, LinkedIn: { type: 'url', url: 'https://www.linkedin.com/in/priya-shah-1a2b' } } }] : [], has_more: false });
    if (init.method === 'POST' && path === '/v1/pages') { created = JSON.parse(init.body).properties; return Response.json({ object: 'page', id }); }
    return Response.json({ object: 'page', id, url: 'https://www.notion.so/p', parent: { type: 'data_source_id', data_source_id: RECRUITING_SOURCE_ID },
      properties: { Candidate: { type: 'title', title: [{ plain_text: 'Priya Shah' }] }, Stage: sel('Outreach') } });
  } });
  const args = { fullName: 'Priya Shah', email: null, linkedin: 'https://www.linkedin.com/in/priya-shah-1a2b', stage: 'Outreach', round: null, outcome: 'Not Yet Decided', pipeline: 'India', indiaStage: 'Outreach', source: 'LinkedIn outbound', nextAction: 'Answered.' };
  assert.equal((await client.createCandidate(args)).verified, true);
  assert.equal(created.Email, undefined);
  assert.deepEqual([created.Stage.select.name, created['India Stage'].select.name, created.Source.select.name], ['Outreach', 'Outreach', 'LinkedIn outbound']);
  await assert.rejects(client.createCandidate({ ...args, stage: 'Intro Call', round: 'R1 — Intro', indiaStage: null }), /invalid_new_candidate/, 'no email only at Outreach');
  existing = true;
  await assert.rejects(client.createCandidate(args), /candidate_exists/);
});

test('setTrialTerms: fills only empty trial dates and rate, reads back, and returns what differs instead of changing it', async () => {
  const id = '33333333-4444-4555-8666-777777777777';
  const props = { Candidate: { type: 'title', title: [{ plain_text: 'Kendall Porter' }] }, Email: { type: 'email', email: 'kendall@example.invalid' }, Stage: sel('Trial'), Outcome: sel('Proceeding'),
    'Daily Trial Rate': { type: 'number', number: 100 } };
  const patches = [];
  const client = createNotionClient({ env: { NOTION_TOKEN: 'ntn_synthetic' }, fetchImpl: async (url, init) => {
    if (init.method === 'PATCH') {
      const p = JSON.parse(init.body).properties; patches.push(p);
      for (const [k, v] of Object.entries(p)) props[k] = v.date ? { type: 'date', date: v.date } : { type: 'number', number: v.number };
    }
    return Response.json({ object: 'page', id, url: 'https://www.notion.so/a', parent: { type: 'data_source_id', data_source_id: RECRUITING_SOURCE_ID }, properties: props });
  } });
  const out = await client.setTrialTerms({ pageId: id, expectedEmail: 'kendall@example.invalid', start: '2026-10-24', end: '2026-10-25', days: 2, rate: 150 });
  assert.deepEqual(out.set, ['dates']);
  assert.deepEqual(out.conflicts, [{ field: 'daily rate', have: 'US$100', found: 'US$150' }]);
  assert.deepEqual(Object.keys(patches[0]).sort(), ['Trial Days', 'Trial End', 'Trial Start']);
  const again = await client.setTrialTerms({ pageId: id, start: '2026-10-31', end: '2026-11-01' });
  assert.deepEqual([again.set, again.conflicts[0].field], [[], 'trial dates']);
  assert.equal(patches.length, 1, 'nothing overwritten');
  await assert.rejects(client.setTrialTerms({ pageId: id, start: '2026-10-25', end: '2026-10-24' }), /invalid_trial_dates/);
  // Start on the record and no end: the written end fills it when the start agrees.
  delete props['Trial End']; delete props['Trial Days'];
  const half = await client.setTrialTerms({ pageId: id, start: '2026-10-24', end: '2026-10-25', days: 2 });
  assert.deepEqual([half.set, Object.keys(patches.at(-1)).sort()], [['dates'], ['Trial Days', 'Trial End']]);
});
