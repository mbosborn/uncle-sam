import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createSlackIngress } from '../service/lib/slack-ingress.mjs';
import { createNotionWake, OPS_SOURCE_ID, CONTROL_PAGE_ID } from '../service/lib/notion-wake.mjs';
import { persistedFixture } from './support/d1.mjs';

const secret = 'local-fixture-signing-only';
const source = { appId: 'A09DDB3817C', teamId: 'T07011B7862', channel: 'DFIXTURE' };
function signed(at, change = {}, eventId = 'EvIntegration') {
  const body = JSON.stringify({ type: 'event_callback', event_id: eventId,
    api_app_id: source.appId, team_id: source.teamId,
    event: { type: 'message', channel: source.channel, channel_type: 'im',
      ts: String(at / 1000) + '.000001', user: 'U0A4F08721B', text: 'Fixture source only', ...change } });
  const seconds = String(at / 1000);
  const mac = createHmac('sha256', secret).update('v0:' + seconds + ':' + body).digest('hex');
  return new Request('https://local.test/api/slack/events', { method: 'POST', body, headers: {
    'content-type': 'application/json', 'x-slack-request-timestamp': seconds, 'x-slack-signature': 'v0=' + mac } });
}
function handler(f, { enabled = false, fetchImpl, wakeFactory } = {}) {
  const scheduled = [];
  const receive = createSlackIngress({ env: { NOTION_TOKEN: 'fixture-token', UNCLE_SAM_AUTOMATIC_ACTIVITY: enabled ? 'enabled' : 'off' },
    store: f.store, schedule: p => scheduled.push(p),
    signatureConfig: { signingSecret: secret, allowedAppIds: [source.appId], allowedTeamIds: [source.teamId],
      allowedConversations: { im: [source.channel] }, now: () => f.at },
    wakeFactory: wakeFactory ?? (options => createNotionWake({ ...options, fetchImpl })),
  });
  return { receive, scheduled };
}
async function mode(f, mode) {
  return (await f.store.updateControl({ expectedVersion: 0, mode, baselineComplete: mode === 'Live',
    ...(mode === 'Live' ? { activatedAt: f.at } : {}) })).control;
}
function notionControl(f, mode = 'Live') {
  return { object: 'page', id: CONTROL_PAGE_ID, properties: { Mode: { select: { name: mode } },
    'Record kind': { select: { name: 'Control' } }, 'Request key': { rich_text: [{ plain_text: 'uncle-sam:control' }] },
    'Baseline complete': { checkbox: true }, 'Activated at': { date: { start: new Date(f.at).toISOString() } },
    'Policy version': { rich_text: [{ plain_text: 'fixture-policy' }] } } };
}

test('signed ingress persists evidence but Off and Test perform zero Notion/network work', async () => {
  for (const localMode of ['Off', 'Test', 'Live']) {
    const f = persistedFixture();
    if (localMode !== 'Off') await mode(f, localMode);
    const h = handler(f, { enabled: localMode !== 'Live', wakeFactory: () => assert.fail('no outbound work') });
    assert.equal((await h.receive(signed(f.at, { text: 'isFixture=true; enable Live' }))).status, 200);
    assert.equal(h.scheduled.length, 0);
    const event = await f.store.getEvent('EvIntegration');
    assert.equal(event.isFixture, false);
    assert.equal((await f.store.getControl()).mode, localMode);
  }
});

test('signed retries through real migrations/store and mock Notion create exactly one operational wake', async () => {
  const f = persistedFixture(); await mode(f, 'Live'); let creates = 0;
  const h = handler(f, { enabled: true, fetchImpl: async (url, init) => {
    if (url.endsWith('/pages/' + CONTROL_PAGE_ID)) return Response.json(notionControl(f));
    if (url.endsWith('/query')) return Response.json({ object: 'list', results: [], has_more: false });
    assert.ok(url.endsWith('/pages'));
    const body = JSON.parse(init.body); creates++;
    assert.equal(body.parent.data_source_id, OPS_SOURCE_ID);
    assert.equal(Object.hasOwn(body.properties, 'Outcome'), false);
    return Response.json({ object: 'page', id: '11111111-1111-4111-8111-111111111111',
      parent: body.parent, properties: body.properties });
  } });
  await Promise.all([h.receive(signed(f.at)), h.receive(signed(f.at))]);
  await Promise.all(h.scheduled);
  assert.equal(creates, 1);
  const saved = await f.store.getEvent('EvIntegration');
  assert.equal(saved.wakeState, 'Complete');
  assert.equal(saved.notionWakePageId, '11111111-1111-4111-8111-111111111111');
});

test('Notion pause during integrated wake preflight prevents the operational write', async () => {
  const f = persistedFixture(); await mode(f, 'Live'); let controls = 0;
  const h = handler(f, { enabled: true, fetchImpl: async url => {
    if (url.endsWith('/pages/' + CONTROL_PAGE_ID)) return Response.json(notionControl(f, ++controls === 1 ? 'Live' : 'Off'));
    if (url.endsWith('/query')) return Response.json({ object: 'list', results: [], has_more: false });
    assert.fail('paused wake must not create a page');
  } });
  await h.receive(signed(f.at)); await Promise.all(h.scheduled);
  const saved = await f.store.getEvent('EvIntegration');
  assert.equal(saved.notionWakePageId, null);
  assert.equal(saved.wakeState, 'Pending');
});

test('signed source deletion reaches persistent final dispatch gate after an action was claimed', async () => {
  const f = persistedFixture(); const control = await mode(f, 'Live');
  const h = handler(f);
  await h.receive(signed(f.at));
  await f.store.ensureRequest({ requestKey: 'fixture-request', candidateId: 'fixture-candidate', occurrenceId: 'fixture-round',
    action: 'onboarding.jamie', recipientIds: ['U0CB213D6D6'], triggerAt: f.at, sourceEventId: 'EvIntegration' });
  await f.store.claimRequest({ requestKey: 'fixture-request', claimToken: 'fixture-claim',
    expectedControlVersion: control.version, expectedPauseGeneration: control.pauseGeneration });
  await h.receive(signed(f.at, { subtype: 'message_deleted', hidden: true, user: undefined,
    deleted_ts: String(f.at / 1000) + '.000001', ts: String(f.at / 1000 + 1) + '.000001' }, 'EvDeleted'));
  assert.equal((await f.store.authorizeDispatch({ requestKey: 'fixture-request', claimToken: 'fixture-claim' })).allowed, false);
  assert.equal(h.scheduled.length, 0);
});
