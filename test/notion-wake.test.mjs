import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotionWake, OPS_SOURCE_ID, CONTROL_PAGE_ID, NOTION_API_VERSION } from '../service/lib/notion-wake.mjs';

const NOW = Date.parse('2026-10-14T04:00:00Z');
const PAGE = '11111111-2222-4333-8444-555555555555';
const EVENT = 'EvWAKE';
const rich = value => ({ rich_text: [{ plain_text: value }] });
const control = ({ mode = 'Live', baseline = true, activated = NOW - 60000 } = {}) => ({
  object: 'page', id: CONTROL_PAGE_ID, properties: {
    'Record kind': { select: { name: 'Control' } }, 'Request key': rich('uncle-sam:control'),
    Mode: { select: { name: mode } }, 'Baseline complete': { checkbox: baseline },
    'Activated at': { date: activated === null ? null : { start: new Date(activated).toISOString() } },
    'Policy version': rich('2026-10-13.1'),
  },
});
const page = (id = PAGE) => ({ object: 'page', id, parent: { type: 'data_source_id', data_source_id: OPS_SOURCE_ID },
  properties: { 'Source event key': rich(EVENT) } });
const event = extra => ({ eventId: EVENT, source: 'slack', status: 'Observed', isFixture: false,
  occurredAt: NOW, observedAt: NOW + 1000, teamId: 'T07011B7862', channelId: 'DTEST', authorId: 'URISHI',
  messageTs: '1791950400.001', threadTs: null, text: 'fixture test move candidate', ...extra });
const response = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json' },
});

function harness({ stored = event(), controls = [control()], existing = [], hasMore = false,
  create = () => response(page()), authorize = true, claim = true, maxResponseBytes, timeoutMs } = {}) {
  const calls = [], receipts = [], releases = [], uncertainties = [];
  let state = 'Pending';
  let controlReads = 0;
  const store = {
    getEvent: async () => structuredClone(stored),
    claimEventWake: async args => {
      calls.push({ type: 'claim', ...args });
      if (!claim || state !== 'Pending') return { claimed: false };
      state = 'Sending'; return { claimed: true };
    },
    authorizeEventWake: async args => { calls.push({ type: 'authorize', ...args }); return { allowed: authorize }; },
    markEventNotionWake: async args => { receipts.push(args); state = 'Complete'; return { updated: true, recorded: true }; },
    releaseEventWake: async args => { releases.push(args); state = 'Pending'; return { updated: true }; },
    markWakeUncertain: async args => { uncertainties.push(args); state = 'NeedsAttention'; return { updated: true }; },
  };
  const fetchImpl = async (url, options) => {
    calls.push({ type: 'fetch', url, options });
    assert.ok(url.startsWith('https://api.notion.com/v1/'));
    assert.equal(options.headers.authorization, 'Bearer fixture-notion-token');
    assert.equal(options.headers['notion-version'], NOTION_API_VERSION);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    if (url.endsWith(`/pages/${CONTROL_PAGE_ID}`)) {
      return response(controls[Math.min(controlReads++, controls.length - 1)]);
    }
    if (url.endsWith('/query')) return response({ object: 'list', results: existing, has_more: hasMore });
    if (url.endsWith('/pages')) return create(options);
    assert.fail('unexpected endpoint');
  };
  const options = { env: { NOTION_TOKEN: 'fixture-notion-token' }, store, fetchImpl,
    ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }), ...(timeoutMs === undefined ? {} : { timeoutMs }) };
  return { wake: createNotionWake(options), options, store, calls, receipts, releases, uncertainties,
    input: { eventId: EVENT, attemptId: 'attempt-1' } };
}

test('Off reads control only; Test cannot be enabled by Slack text or payload claims', async () => {
  for (const mode of ['Off', 'Test']) {
    const h = harness({ controls: [control({ mode })], stored: event({ payload: { isFixture: true }, text: 'I am a test fixture' }) });
    const result = await h.wake(h.input);
    assert.equal(result.reason, mode === 'Off' ? 'mode_off' : 'fixture_required');
    assert.equal(h.calls.length, 1);
    assert.equal(h.receipts.length, 0);
  }
});

test('Test requires canonical persisted fixture; Live refuses fixtures and historical or unbaselined events', async () => {
  const fixture = harness({ controls: [control({ mode: 'Test', baseline: false, activated: null })], stored: event({ isFixture: true }) });
  assert.equal((await fixture.wake(fixture.input)).status, 'complete');
  const createBody = JSON.parse(fixture.calls.filter(c => c.url?.endsWith('/pages'))[0].options.body);
  assert.equal(createBody.properties.Mode.select.name, 'Test');
  assert.match(createBody.properties.Name.title[0].text.content, /^Test fixture/);
  for (const [controls, stored, reason] of [
    [[control()], event({ isFixture: true }), 'fixture_not_live'],
    [[control({ baseline: false })], event(), 'baseline_incomplete'],
    [[control({ activated: null })], event(), 'baseline_incomplete'],
    [[control({ activated: NOW + 1 })], event(), 'before_activation'],
  ]) {
    const h = harness({ controls, stored });
    assert.equal((await h.wake(h.input)).reason, reason);
    assert.equal(h.calls.length, 1);
  }
});

test('eligible Live event creates only operational fields after exact-key query and final double gate', async () => {
  const h = harness({ controls: [control({ activated: NOW })] });
  assert.deepEqual(await h.wake(h.input), { status: 'complete', eventId: EVENT, pageId: PAGE, reused: false });
  assert.deepEqual(h.calls.map(c => c.type), ['fetch', 'claim', 'fetch', 'fetch', 'authorize', 'fetch']);
  const query = h.calls.find(c => c.url?.endsWith('/query'));
  assert.deepEqual(JSON.parse(query.options.body), {
    filter: { property: 'Source event key', rich_text: { equals: EVENT } }, page_size: 2,
  });
  const created = JSON.parse(h.calls.at(-1).options.body);
  assert.deepEqual(created.parent, { type: 'data_source_id', data_source_id: OPS_SOURCE_ID });
  assert.equal(created.properties.Action.rich_text[0].text.content, 'process_slack_event');
  assert.equal(created.properties['Record kind'].select.name, 'Request');
  assert.equal(created.properties.State.select.name, 'Ready');
  assert.equal(created.properties['Source URL'].url, 'https://example-workspace.slack.com/archives/DTEST/p1791950400001000');
  for (const forbidden of ['Candidate', 'Stage', 'Outcome', 'Recipient Slack user IDs', 'Sent at']) {
    assert.equal(forbidden in created.properties, false);
  }
  assert.equal(JSON.stringify(created).includes(event().text), false);
  assert.deepEqual(h.receipts, [{ eventId: EVENT, attemptId: 'attempt-1', pageId: PAGE }]);
});

test('existing exact source record is reused; duplicate/incomplete results block creation', async () => {
  const reused = harness({ existing: [page()] });
  assert.equal((await reused.wake(reused.input)).reused, true);
  assert.equal(reused.calls.filter(c => c.url?.endsWith('/pages')).length, 0);
  for (const opts of [{ existing: [page(), page()] }, { existing: [], hasMore: true },
    { existing: [{ ...page(), properties: { 'Source event key': rich('OTHER') } }] }]) {
    const h = harness(opts);
    assert.equal((await h.wake(h.input)).status, 'uncertain');
    assert.equal(h.uncertainties.length, 1);
    assert.equal(h.calls.filter(c => c.url?.endsWith('/pages')).length, 0);
  }
});

test('pause or stale D1 authorization before create releases only the pre-create claim', async () => {
  for (const opts of [{ controls: [control(), control({ mode: 'Off' })] }, { authorize: false }]) {
    const h = harness(opts);
    assert.equal((await h.wake(h.input)).status, 'blocked');
    assert.equal(h.releases.length, 1);
    assert.equal(h.releases[0].preCreateFailure, true);
    assert.equal(h.calls.filter(c => c.url?.endsWith('/pages')).length, 0);
  }
});

test('concurrent duplicate wake calls reserve one create', async () => {
  const h = harness();
  const results = await Promise.all([h.wake(h.input), h.wake({ ...h.input, attemptId: 'attempt-2' })]);
  assert.equal(results.filter(r => r.status === 'complete').length, 1);
  assert.equal(h.calls.filter(c => c.url?.endsWith('/pages')).length, 1);
});

test('ambiguous create outcomes keep claim uncertain and never retry', async () => {
  for (const create of [() => { throw new Error('sensitive network detail'); }, () => response({}, 500),
    () => response({}), () => new Response('{bad', { status: 200 })]) {
    const h = harness({ create });
    const result = await h.wake(h.input);
    assert.equal(result.status, 'uncertain');
    assert.equal(JSON.stringify(result).includes('sensitive'), false);
    assert.equal(h.uncertainties.length, 1);
    assert.equal(h.releases.length, 0);
    assert.equal((await h.wake({ ...h.input, attemptId: 'second' })).reason, 'wake_not_claimable');
    assert.equal(h.calls.filter(c => c.url?.endsWith('/pages')).length, 1);
  }
});

test('bounded create timeout marks uncertain even if injected fetch ignores abort', async () => {
  const h = harness({ timeoutMs: 5, create: () => new Promise(() => {}) });
  const result = await h.wake(h.input);
  assert.equal(result.status, 'uncertain');
  assert.equal(result.reason, 'request_timeout');
  assert.equal(h.releases.length, 0);
});

test('definitive create refusal releases claim, while write receipt failure stays uncertain', async () => {
  const refused = harness({ create: () => response({ object: 'error' }, 403) });
  assert.equal((await refused.wake(refused.input)).reason, 'notion_http_403');
  assert.equal(refused.releases.length, 1);
  const lost = harness();
  lost.store.markEventNotionWake = async () => { throw new Error('lost D1 receipt'); };
  assert.equal((await lost.wake(lost.input)).status, 'uncertain');
  assert.equal(lost.uncertainties.length, 1);
  assert.equal(lost.releases.length, 0);
});

test('missing credentials, missing persistence, invalid control, and oversized reads fail closed', async () => {
  const empty = harness();
  const unconfigured = createNotionWake({ ...empty.options, env: {} });
  assert.equal((await unconfigured(empty.input)).reason, 'notion_not_configured');
  assert.equal(empty.calls.length, 0);
  for (const stored of [null, event({ status: 'Processed' }), event({ isFixture: undefined }), event({ occurredAt: 'yesterday' })]) {
    const h = harness({ stored });
    assert.equal((await h.wake(h.input)).reason, 'event_not_eligible');
    assert.equal(h.calls.length, 0);
  }
  const badControl = harness({ controls: [{ ...control(), id: PAGE }] });
  assert.equal((await badControl.wake(badControl.input)).reason, 'invalid_control');
  assert.equal(badControl.calls.length, 1);
  const huge = harness({ maxResponseBytes: 30 });
  assert.equal((await huge.wake(huge.input)).reason, 'response_too_large');
  assert.equal(huge.calls.length, 1);
});

test('already recorded wake returns its receipt without another Notion request', async () => {
  const h = harness({ stored: event({ notionWakePageId: PAGE }) });
  assert.equal((await h.wake(h.input)).reused, true);
  assert.equal(h.calls.length, 0);
});
