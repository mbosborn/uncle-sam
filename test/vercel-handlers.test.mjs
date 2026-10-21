import test from 'node:test';
import assert from 'node:assert/strict';
import { createVercelApp, EVENT_BUDGET_MS, TICK_BUDGET_MS, openDatabase } from '../service/lib/vercel-handlers.mjs';
import { applyMigrations } from '../service/lib/migrate.mjs';
import { createStore } from '../service/lib/store.mjs';
import { AT, ACTIVATED, SECRETS, ROUTES, APP_ID, TEAM_ID, baseEnv, controlPage, proposesNoAction, network, harness, withHarness, goLive,
  signedSlack, slackMessage, post, get, bearer, notionSignature, json } from './support/vercel-world.mjs';
import { migrationFiles } from './support/libsql.mjs';
import { createClient } from '@libsql/client';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const everySecret = [...Object.values(SECRETS), ROUTES];

// ---------------------------------------------------------------------------------------------------------------
// Guards: methods, missing database, recovery
// ---------------------------------------------------------------------------------------------------------------
test('every handler checks the HTTP method before it touches configuration', async () => {
  let opened = 0;
  await withHarness({ open: f => async () => { opened++; return f.db; } }, async ({ app }) => {
    for (const name of ['slackEvents', 'notionWebhook', 'portalWebhook']) {
      for (const method of ['GET', 'PUT', 'DELETE']) {
        const response = await app[name](new Request('https://uncle-sam.example/x', { method }));
        assert.equal(response.status, 405, `${name} ${method}`);
        assert.equal(response.headers.get('allow'), 'POST');
        assert.deepEqual(await json(response), { error: 'method_not_allowed' });
      }
    }
    const health = await app.health(post('/api/health', {}));
    assert.equal(health.status, 405);
    assert.equal(health.headers.get('allow'), 'GET, HEAD');
    const tick = await app.tick(new Request('https://uncle-sam.example/api/cron/tick', { method: 'PUT', headers: bearer() }));
    assert.equal(tick.status, 405);
    assert.equal(tick.headers.get('allow'), 'GET, POST');
    assert.equal(opened, 0, 'a wrong method never opens the database');
  });
});

test('without a database every endpoint refuses (503) instead of accepting events it cannot keep', async () => {
  await withHarness({ open: () => async () => null }, async ({ app, net, scheduled }) => {
    const notionBody = JSON.stringify({ id: 'evt-1', type: 'page.created', entity: { id: '11111111-1111-4111-8111-111111111111', type: 'page' } });
    const refused = [
      await app.slackEvents(signedSlack(slackMessage())),
      await app.notionWebhook(post('/api/notion/webhook', notionBody, { 'x-notion-signature': notionSignature(SECRETS.NOTION_WEBHOOK_SECRET, notionBody) })),
      await app.portalWebhook(post('/api/portal/webhook', { event: 'submission.uploaded', deliveryId: 'd1' }, { 'x-uncle-sam-secret': SECRETS.PORTAL_WEBHOOK_SECRET })),
      await app.tick(get('/api/cron/tick', bearer())),
    ];
    for (const response of refused) {
      assert.equal(response.status, 503);
      assert.deepEqual(await json(response), { error: 'service_not_configured' });
    }
    assert.equal(net.calls.length, 0);
    assert.equal(scheduled.length, 0);
  });
});

test('a database that cannot be opened gives 503 service_not_ready and is retried on the next request, then reused', async () => {
  let attempts = 0;
  await withHarness({ open: f => async () => { if (attempts++ === 0) throw new Error('turso unreachable'); return f.db; } }, async ({ app, store }) => {
    const first = await app.slackEvents(signedSlack(slackMessage()));
    assert.equal(first.status, 503);
    assert.deepEqual(await json(first), { error: 'service_not_ready' });
    const second = await app.slackEvents(signedSlack(slackMessage()));
    assert.equal(second.status, 200);
    assert.ok(await store.getEvent('EvVercelOne'), 'the retried delivery was stored');
    await app.slackEvents(signedSlack(slackMessage({}, 'EvVercelTwo')));
    assert.equal(attempts, 2, 'the connection is opened once per instance after it succeeds');
  });
});

test('if the database fails while storing a Slack event, Slack gets a 5xx so it redelivers, and nothing is scheduled', async () => {
  const broken = () => async () => ({ prepare() { throw new Error('write failed'); }, batch() { throw new Error('write failed'); } });
  await withHarness({ open: broken, env: { UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled' } }, async ({ app, scheduled, net }) => {
    const response = await app.slackEvents(signedSlack(slackMessage()));
    assert.equal(response.status, 503);
    assert.deepEqual(await json(response), { error: 'event_store_unavailable' });
    assert.equal(scheduled.length, 0);
    assert.equal(net.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------------------------------------------
test('health reports booleans and counts only, with a real database probe, and never a secret value', async () => {
  await withHarness({}, async ({ app, net }) => {
    const response = await app.health(get('/api/health'));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const text = await response.text();
    for (const value of everySecret) assert.equal(text.includes(value), false, 'no secret value appears in the body');
    assert.deepEqual(JSON.parse(text), { service: 'Uncle Sam', host: 'vercel', phase: 'setup', automaticActionsEnabled: false,
      documentChecker: { enabled: true, version: '2026-10-20.1', failureMode: 'block_send_and_resend' }, jointCheckinVersion: '2026-10-20.1', workTrialSafetyVersion: '2026-10-20.1', reliabilityVersion: '2026-10-20.2', candidateDiscoveryVersion: '2026-10-20.1', sourcingCalibrationVersion: '2026-10-20.1', firstCheckinVersion: '2026-10-20.2', threadIdentityVersion: '2026-10-20.1', recapAckVersion: '2026-10-20.5', configuration: {
      database: true, automaticActivity: 'off', slackSigning: true, slackBot: true, slackBotIdentity: true, notion: true, notionWebhook: true,
      portalWebhook: true, anthropic: true, openrouter: false, llm: 'anthropic', model: 'fixture-model-1', questions: 'off', questionAskers: 'n/a',
      wispr: false, gmail: false, rejectionSender: 'notion-agent', calendarSource: 'google', calendar: false, calendarIds: 0, calendarFloor: 'unset', interviewerEmails: 0, routes: 2,
      routeMapValid: true, cron: true, databaseReachable: true } });
    assert.equal((await app.health(new Request('https://uncle-sam.example/api/health', { method: 'HEAD' }))).status, 200);
    assert.equal(net.calls.length, 0, 'health never calls an outside service');
  });
});

test('health reflects the kill switch and a missing or too-short cron secret', async () => {
  await withHarness({ env: { UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled' } }, async ({ app }) => {
    const body = await json(await app.health(get('/api/health')));
    assert.equal(body.phase, 'phase2-live');
    assert.equal(body.automaticActionsEnabled, true);
    assert.equal(body.configuration.automaticActivity, 'enabled');
  });
  for (const CRON_SECRET of [undefined, 'short-secret']) {
    await withHarness({ env: { CRON_SECRET } }, async ({ app }) => {
      assert.equal((await json(await app.health(get('/api/health')))).configuration.cron, false);
    });
  }
});

test('health stays a 200 with databaseReachable:false when the database is missing, failing or hanging', async () => {
  const cases = {
    missing: () => async () => null,
    failing: () => async () => { throw new Error('turso unreachable'); },
    hanging: () => async () => ({ prepare: () => ({ first: () => new Promise(() => {}) }) }),
  };
  for (const [name, open] of Object.entries(cases)) {
    await withHarness({ open }, async ({ app }) => {
      const started = Date.now();
      const response = await app.health(get('/api/health'));
      assert.equal(response.status, 200, name);
      const body = await json(response);
      assert.equal(body.configuration.databaseReachable, false, name);
      assert.equal(body.configuration.database, name === 'hanging', `${name}: database flag reports configuration, not reachability`);
      assert.ok(Date.now() - started < 5000, `${name}: the probe is bounded`);
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Slack Events API
// ---------------------------------------------------------------------------------------------------------------
test('Slack: the signed URL-verification handshake is answered; unsigned, tampered, stale or foreign requests are refused and store nothing', async () => {
  await withHarness({}, async ({ app, store, net, scheduled }) => {
    const handshake = await app.slackEvents(signedSlack({ type: 'url_verification', challenge: 'challenge-123' }));
    assert.equal(handshake.status, 200);
    assert.deepEqual(await json(handshake), { challenge: 'challenge-123' });

    const body = JSON.stringify(slackMessage());
    const tampered = signedSlack(body);
    const forged = new Request(tampered.url, { method: 'POST', body: body.replace('Fixture message', 'Hire everyone'), headers: tampered.headers });
    const refusals = [
      [await app.slackEvents(post('/api/slack/events', body)), 401, 'invalid_signature'],
      [await app.slackEvents(forged), 401, 'invalid_signature'],
      [await app.slackEvents(signedSlack(body, { secret: 'a-different-signing-secret' })), 401, 'invalid_signature'],
      [await app.slackEvents(signedSlack(body, { at: AT - 10 * 60_000 })), 401, 'stale_request'],
      [await app.slackEvents(signedSlack(slackMessage({}, 'EvForeignApp', { api_app_id: 'A0OTHERAPP1' }))), 403, 'app_not_allowed'],
      [await app.slackEvents(signedSlack(slackMessage({}, 'EvForeignTeam', { team_id: 'T0OTHERTEAM' }))), 403, 'workspace_not_allowed'],
      [await app.slackEvents(new Request('https://uncle-sam.example/api/slack/events', { method: 'POST', body, headers: { 'content-type': 'text/plain' } })), 415, 'unsupported_media_type'],
    ];
    for (const [response, status, error] of refusals) {
      assert.equal(response.status, status, error);
      assert.deepEqual(await json(response), { error });
    }
    assert.deepEqual(await store.listUnprocessedEvents({ limit: 10 }), []);
    assert.equal(scheduled.length, 0);
    assert.equal(net.calls.length, 0);
  });
});

test('Slack: with automatic activity off a routed message is kept as evidence only (no work scheduled, no outside call); duplicates collapse', async () => {
  await withHarness({}, async ({ app, store, net, scheduled }) => {
    for (let i = 0; i < 3; i++) assert.equal((await app.slackEvents(signedSlack(slackMessage()))).status, 200);
    const event = await store.getEvent('EvVercelOne');
    assert.equal(event.channelId, 'GJAMIE0001');
    assert.equal(event.authorId, 'U0A4F08721B');
    assert.equal(event.isFixture, false, 'a live Slack event can never be a fixture');
    assert.equal(event.status, 'Observed');
    assert.equal((await store.listUnprocessedEvents({ limit: 10 })).length, 1);
    const dm = await app.slackEvents(signedSlack(slackMessage({ channel: 'DRISHI0001', channel_type: 'im' }, undefined), {}));
    assert.equal(dm.status, 200);
    assert.equal((await store.listUnprocessedEvents({ limit: 10 })).length, 1, 'the same event id in another conversation is still a duplicate');
    assert.equal((await app.slackEvents(signedSlack(slackMessage({ channel: 'DRISHI0001', channel_type: 'im' }, 'EvVercelDm')))).status, 200);
    assert.equal((await store.listUnprocessedEvents({ limit: 10 })).length, 2);
    assert.equal(scheduled.length, 0);
    assert.equal(net.calls.length, 0);
    assert.equal((await store.getControl()).mode, 'Off');
  });
});

test('Slack: the bot\'s own messages, bots, unknown conversations, edits outside the route map and system subtypes are ignored', async () => {
  await withHarness({}, async ({ app, store }) => {
    const ignored = [
      slackMessage({ user: 'UBOTFIXTURE' }, 'EvSelf'),
      slackMessage({ bot_id: 'B0SOMEBOT' }, 'EvBot'),
      slackMessage({ channel: 'GSTRANGER1', channel_type: 'mpim' }, 'EvUnknownConversation'),
      slackMessage({ channel: 'GJAMIE0001', channel_type: 'im' }, 'EvWrongType'),
      slackMessage({ subtype: 'channel_join' }, 'EvSubtype'),
      slackMessage({ hidden: true }, 'EvHidden'),
      slackMessage({ type: 'reaction_added' }, 'EvOtherType'),
    ];
    for (const body of ignored) assert.equal((await app.slackEvents(signedSlack(body))).status, 200);
    assert.deepEqual(await store.listUnprocessedEvents({ limit: 10 }), []);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Notion webhook
// ---------------------------------------------------------------------------------------------------------------
const PAGE = '11111111-1111-4111-8111-111111111111';
const notionEvent = (id = 'evt-0001', overrides = {}) => ({ id, timestamp: new Date(AT).toISOString(), type: 'page.properties_updated',
  entity: { id: PAGE, type: 'page' }, data: { updated_properties: ['Stage'] }, authors: [{ id: '22222222-2222-4222-8222-222222222222', type: 'person' }],
  workspace_id: 'ws-fixture', ...overrides });
const signedNotion = (event, secret = SECRETS.NOTION_WEBHOOK_SECRET) => {
  const raw = typeof event === 'string' ? event : JSON.stringify(event);
  return post('/api/notion/webhook', raw, { 'x-notion-signature': notionSignature(secret, raw) });
};

test('Notion: the subscription handshake hands the verification token to the operator through the log, not the response, and stores nothing', async () => {
  await withHarness({ env: { NOTION_WEBHOOK_SECRET: undefined } }, async ({ app, logs, store, scheduled }) => {
    const response = await app.notionWebhook(post('/api/notion/webhook', { verification_token: 'secret_fixtureToken123' }));
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.deepEqual(JSON.parse(text), { ok: true, verification: 'logged' });
    assert.equal(text.includes('secret_fixtureToken123'), false);
    assert.deepEqual(logs, ['notion_webhook_verification_token=secret_fixtureToken123']);
    assert.deepEqual(await store.listUnprocessedEvents({ limit: 10 }), []);
    assert.equal(scheduled.length, 0);
  });
});

test('Notion: a signed event is stored once and scheduled once, and does nothing while automatic activity is off', async () => {
  await withHarness({}, async ({ app, store, net, scheduled }) => {
    const first = await app.notionWebhook(signedNotion(notionEvent()));
    assert.deepEqual(await json(first), { ok: true, eventId: 'notion:evt-0001', duplicate: false });
    assert.equal(scheduled.length, 1, 'the work is handed to waitUntil before the response returns');
    const again = await app.notionWebhook(signedNotion(notionEvent()));
    assert.deepEqual(await json(again), { ok: true, eventId: 'notion:evt-0001', duplicate: true });
    assert.equal(scheduled.length, 1, 'a redelivery schedules nothing');
    await app.idle();
    const event = await store.getEvent('notion:evt-0001');
    assert.equal(event.source, 'notion');
    assert.equal(event.status, 'Observed');
    assert.equal(event.isFixture, false);
    assert.equal(net.calls.length, 0);
  });
});

test('Notion: unsigned, wrongly signed, malformed and oversized deliveries are refused; an unset secret fails closed', async () => {
  await withHarness({}, async ({ app, store }) => {
    const good = JSON.stringify(notionEvent());
    const wrongSecret = signedNotion(good, 'another-secret-of-sufficient-length');
    const refusals = [
      [await app.notionWebhook(post('/api/notion/webhook', good)), 401, 'signature_missing'],
      [await app.notionWebhook(post('/api/notion/webhook', good, { 'x-notion-signature': 'sha256=zz' })), 401, 'signature_missing'],
      [await app.notionWebhook(wrongSecret), 401, 'signature_invalid'],
      [await app.notionWebhook(post('/api/notion/webhook', '{not json')), 400, 'invalid_json'],
      [await app.notionWebhook(post('/api/notion/webhook', '[]')), 400, 'invalid_json'],
      [await app.notionWebhook(signedNotion({ id: 'evt-2', type: 'page.created' })), 400, 'invalid_event'],
      [await app.notionWebhook(signedNotion({ ...notionEvent('bad id with spaces') })), 400, 'invalid_event'],
      [await app.notionWebhook(post('/api/notion/webhook', JSON.stringify({ pad: 'x'.repeat(300 * 1024) }))), 413, 'payload_too_large'],
    ];
    for (const [response, status, error] of refusals) { assert.equal(response.status, status, error); assert.deepEqual(await json(response), { error }); }
    assert.deepEqual(await store.listUnprocessedEvents({ limit: 10 }), []);
  });
  for (const NOTION_WEBHOOK_SECRET of [undefined, 'short']) {
    await withHarness({ env: { NOTION_WEBHOOK_SECRET } }, async ({ app }) => {
      const response = await app.notionWebhook(signedNotion(notionEvent(), 'short'));
      assert.equal(response.status, 503);
      assert.deepEqual(await json(response), { error: 'webhook_not_configured' });
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Portal webhook
// ---------------------------------------------------------------------------------------------------------------
const portalBody = (overrides = {}) => ({ event: 'submission.uploaded', deliveryId: 'dlv-0001', candidateEmail: 'fixture.candidate@example.test',
  submissionId: 'sub-0001', submissionUrl: 'https://portal.example.test/submissions/sub-0001', uploadedAt: new Date(AT).toISOString(), ...overrides });
const portalPost = (body, secret = SECRETS.PORTAL_WEBHOOK_SECRET) => post('/api/portal/webhook', body, secret === null ? {} : { 'x-uncle-sam-secret': secret });

test('Portal: an authenticated upload is stored once under its delivery id and scheduled once', async () => {
  await withHarness({}, async ({ app, store, scheduled, net }) => {
    assert.deepEqual(await json(await app.portalWebhook(portalPost(portalBody()))), { ok: true, eventId: 'portal:submission.uploaded:dlv-0001', duplicate: false });
    assert.deepEqual(await json(await app.portalWebhook(portalPost(portalBody()))), { ok: true, eventId: 'portal:submission.uploaded:dlv-0001', duplicate: true });
    assert.equal(scheduled.length, 1);
    await app.idle();
    const event = await store.getEvent('portal:submission.uploaded:dlv-0001');
    assert.equal(event.source, 'portal');
    assert.equal(event.payload.candidateEmail, 'fixture.candidate@example.test');
    assert.equal(event.payload.submissionUrl, 'https://portal.example.test/submissions/sub-0001');
    assert.equal(event.status, 'Observed', 'automatic activity is off, so nothing was done with it');
    assert.equal(net.calls.length, 0);
    // The submission id stands in for a missing delivery id.
    const fallback = await json(await app.portalWebhook(portalPost(portalBody({ deliveryId: undefined, submissionId: 'sub-9' }))));
    assert.equal(fallback.eventId, 'portal:submission.uploaded:sub-9');
  });
});

test('Portal: wrong or missing secret, unset secret, bad event names and missing ids are refused', async () => {
  await withHarness({}, async ({ app, store }) => {
    const refusals = [
      [await app.portalWebhook(portalPost(portalBody(), null)), 401, 'unauthorized'],
      [await app.portalWebhook(portalPost(portalBody(), 'the-wrong-portal-secret-value')), 401, 'unauthorized'],
      [await app.portalWebhook(portalPost(portalBody({ event: 'Bad Event!' }))), 400, 'invalid_event'],
      [await app.portalWebhook(portalPost(portalBody({ deliveryId: undefined, submissionId: undefined }))), 400, 'delivery_id_required'],
      [await app.portalWebhook(portalPost('{nope')), 400, 'invalid_json'],
    ];
    for (const [response, status, error] of refusals) { assert.equal(response.status, status, error); assert.deepEqual(await json(response), { error }); }
    assert.deepEqual(await store.listUnprocessedEvents({ limit: 10 }), []);
  });
  await withHarness({ env: { PORTAL_WEBHOOK_SECRET: undefined } }, async ({ app }) => {
    const response = await app.portalWebhook(portalPost(portalBody(), 'anything-long-enough-to-pass'));
    assert.equal(response.status, 503);
    assert.deepEqual(await json(response), { error: 'webhook_not_configured' });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Cron tick
// ---------------------------------------------------------------------------------------------------------------
const tickRequest = (headers = bearer(), method = 'GET') => new Request('https://uncle-sam.example/api/cron/tick', { method, headers });

test('Tick: fails closed without a configured cron secret, and demands the exact bearer secret before opening anything', async () => {
  for (const CRON_SECRET of [undefined, '', 'too-short']) {
    await withHarness({ env: { CRON_SECRET } }, async ({ app }) => {
      const response = await app.tick(tickRequest(bearer('too-short')));
      assert.equal(response.status, 503, String(CRON_SECRET));
      assert.deepEqual(await json(response), { error: 'cron_not_configured' });
    });
  }
  let opened = 0;
  await withHarness({ open: f => async () => { opened++; return f.db; } }, async ({ app, net }) => {
    for (const headers of [{}, bearer('wrong-secret-wrong-secret-wrong'), { authorization: `Basic ${SECRETS.CRON_SECRET}` }, { authorization: SECRETS.CRON_SECRET }, bearer(`${SECRETS.CRON_SECRET}x`), { authorization: 'Bearer ' }]) {
      const response = await app.tick(tickRequest(headers));
      assert.equal(response.status, 401, JSON.stringify(headers));
      assert.equal(response.headers.get('www-authenticate'), 'Bearer');
      assert.deepEqual(await json(response), { error: 'unauthorized' });
    }
    assert.equal(opened, 0);
    assert.equal(net.calls.length, 0);
    for (const method of ['GET', 'POST']) assert.equal((await app.tick(tickRequest(bearer(), method))).status, 200, method);
  });
});

test('Tick: with automatic activity off it does nothing at all, and says so', async () => {
  await withHarness({}, async ({ app, net, logs, store }) => {
    const response = await app.tick(tickRequest());
    assert.equal(response.status, 200);
    assert.deepEqual(await json(response), { ok: true, status: 'blocked', reason: 'automatic_activity_off', mode: null, events: 0, prompts: 0, dispatched: 0, swept: 0, errors: 0 });
    assert.equal(net.calls.length, 0);
    assert.equal((await store.getControl()).version, 0);
    assert.match(logs.at(-1), /^uncle_sam_tick status=blocked reason=automatic_activity_off /);
  });
});

test('Tick: when Notion says Off it mirrors Off into the database, leaves stored events alone and touches nothing else', async () => {
  await withHarness({ env: { UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled' }, control: { mode: 'Off' } }, async ({ app, net, store }) => {
    await store.recordEvent({ eventId: 'EvWhileOff', appId: APP_ID, teamId: TEAM_ID, channelId: 'GJAMIE0001', channelType: 'mpim', authorId: 'U0A4F08721B',
      messageTs: `${AT / 1000}.000100`, threadTs: null, text: 'Said while Uncle Sam was off' });
    const body = await json(await app.tick(tickRequest()));
    assert.deepEqual(body, { ok: true, status: 'ok', reason: null, mode: 'Off', events: 0, prompts: 0, dispatched: 0, swept: 0, errors: 0 });
    assert.deepEqual(net.calls.map(call => `${call.method} ${call.url}`), ['GET https://api.notion.com/v1/pages/c71e1782-2660-4a92-93fb-5977b1e4a8c9']);
    assert.equal((await store.getControl()).mode, 'Off');
    const event = await store.getEvent('EvWhileOff');
    assert.equal(event.status, 'Observed');
    assert.equal(event.wakeState, 'Pending');
  });
});

test('Tick: if Notion cannot be read it refuses to act and leaves the database control untouched', async () => {
  await withHarness({ env: { UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled' }, control: null }, async ({ app, net, store, logs }) => {
    const body = await json(await app.tick(tickRequest()));
    assert.equal(body.status, 'blocked');
    assert.equal(body.reason, 'control_unverified');
    assert.equal(body.events, 0);
    assert.equal(net.writes().length, 0);
    assert.equal((await store.getControl()).mode, 'Off');
    assert.match(logs.at(-1), /status=blocked reason=control_unverified/);
  });
});

const slackInput = (eventId, text = 'Fixture message from Jamie group') => ({ eventId, appId: APP_ID, teamId: TEAM_ID, channelId: 'GJAMIE0001', channelType: 'mpim',
  authorId: 'U0A4F08721B', messageTs: `${AT / 1000}.000100`, threadTs: null, text });
const live = { mode: 'Live', baseline: true, activatedAt: ACTIVATED };

test('Tick: in Live it reviews a waiting Slack event with Claude, records the receipt, writes only a heartbeat to Notion and never posts to Slack', async () => {
  await withHarness({ env: { UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled' }, control: live, claude: proposesNoAction('Nothing for Uncle Sam to do here') }, async ({ app, net, store, logs }) => {
    await store.recordEvent(slackInput('EvWaiting'));
    const body = await json(await app.tick(tickRequest()));
    assert.deepEqual(body, { ok: true, status: 'ok', reason: null, mode: 'Live', events: 1, prompts: 0, dispatched: 0, swept: 0, errors: 0 });
    const event = await store.getEvent('EvWaiting');
    assert.equal(event.status, 'Processed');
    assert.equal(event.receipt.outcome.kind, 'no_action');
    assert.equal(event.receipt.outcome.proposal.reason, 'Nothing for Uncle Sam to do here');
    assert.deepEqual(event.receipt.sideEffects, []);
    assert.equal(event.receipt.model.turns, 1);
    const claude = net.to('api.anthropic.com');
    assert.equal(claude.length, 1);
    assert.equal(claude[0].headers['x-api-key'], SECRETS.ANTHROPIC_API_KEY);
    const request = JSON.parse(claude[0].body);
    assert.equal(request.model, 'fixture-model-1');
    assert.match(request.messages[0].content, /Fixture message from Jamie group/);
    assert.equal(net.to('slack.com').filter(call => call.method !== 'GET' && !/conversations\.(history|replies)|auth\.test/.test(call.url)).length, 0, 'nothing was posted to Slack');
    // The only Notion write is the heartbeat, and it touches only the "Source cursors" text of the control row.
    const writes = net.writes();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].method, 'PATCH');
    assert.deepEqual(Object.keys(JSON.parse(writes[0].body).properties), ['Source cursors']);
    assert.match(JSON.parse(writes[0].body).properties['Source cursors'].rich_text[0].text.content, /^Phase 2 tick .* mode Live · events 1 /);
    assert.match(logs.at(-1), /status=ok reason=- mode=Live events=1 /);
    assert.equal((await store.getControl()).mode, 'Live');
  });
});

test('Tick: with only an OpenRouter key the same review goes to OpenRouter, pinned to Anthropic with an automatic tool choice, and never to api.anthropic.com', async () => {
  const KEY = 'sk-or-v1-vercel-fixture-key-0123456789abcdef';
  const env = { UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled', ANTHROPIC_API_KEY: undefined, ANTHROPIC_MODEL: undefined, OPENROUTER_API_KEY: KEY, OPENROUTER_MODEL: 'anthropic/claude-sonnet-5.5' };
  await withHarness({ env, control: live, claude: proposesNoAction('Nothing for Uncle Sam to do here') }, async ({ app, net, store }) => {
    const health = await app.health(get('/api/health'));
    const healthText = await health.text();
    assert.equal(healthText.includes(KEY), false, 'the key is not in the health report');
    assert.deepEqual([JSON.parse(healthText).configuration.llm, JSON.parse(healthText).configuration.openrouter, JSON.parse(healthText).configuration.anthropic, JSON.parse(healthText).configuration.model],
      ['openrouter', true, false, 'anthropic/claude-sonnet-5.5']);
    await store.recordEvent(slackInput('EvViaOpenRouter'));
    const body = await json(await app.tick(tickRequest()));
    assert.deepEqual([body.ok, body.status, body.events, body.errors], [true, 'ok', 1, 0]);
    const event = await store.getEvent('EvViaOpenRouter');
    assert.equal(event.status, 'Processed'); assert.equal(event.receipt.outcome.kind, 'no_action'); assert.equal(event.receipt.model.turns, 1);
    assert.equal(net.to('api.anthropic.com').length, 0, 'the Anthropic endpoint is not called when only an OpenRouter key is configured');
    const calls = net.to('openrouter.ai');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/messages');
    assert.equal(calls[0].headers.authorization, `Bearer ${KEY}`);
    assert.equal('x-api-key' in calls[0].headers, false);
    const request = JSON.parse(calls[0].body);
    assert.equal(request.model, 'anthropic/claude-sonnet-5.5');
    assert.deepEqual(request.provider, { only: ['anthropic'], allow_fallbacks: false });
    assert.deepEqual(request.tool_choice, { type: 'auto' });
    assert.ok(request.max_tokens >= 8192);
    assert.match(request.messages[0].content, /Fixture message from Jamie group/);
    assert.equal(net.writes().length, 1, 'the only outside write is still the Notion heartbeat');
  });
});

test('Tick: the time budget stops it from starting events it cannot finish, and the same event is picked up by the next tick', async () => {
  const env = baseEnv({ UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled' });
  await withHarness({ env: { UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled' }, control: live, claude: proposesNoAction('Nothing to do'), tickBudgetMs: 30_000 }, async h => {
    await h.store.recordEvent(slackInput('EvStarved'));
    const starved = await json(await h.app.tick(tickRequest()));
    assert.equal(starved.status, 'ok');
    assert.equal(starved.events, 0, 'under 60 s left, so no model-length work is started');
    assert.equal(h.net.to('api.anthropic.com').length, 0);
    const untouched = await h.store.getEvent('EvStarved');
    assert.equal(untouched.status, 'Observed');
    assert.equal(untouched.wakeState, 'Pending');
    const healthy = createVercelApp({ env, fetchImpl: h.net.fetchImpl, clock: () => AT, log: () => {}, open: async () => h.f.db });
    const next = await json(await healthy.tick(tickRequest()));
    assert.equal(next.events, 1);
    assert.equal((await h.store.getEvent('EvStarved')).status, 'Processed');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Real-time paths: event in, work scheduled after the response, bounded by the event budget
// ---------------------------------------------------------------------------------------------------------------
test('Live: a signed Slack message is answered immediately and processed in the background with Claude, with no outside write', async () => {
  await withHarness({ env: { UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled' }, control: live, claude: proposesNoAction('Chatter, nothing to do') }, async ({ app, f, net, store, scheduled }) => {
    await goLive(f);
    const response = await app.slackEvents(signedSlack(slackMessage({ text: 'Real-time fixture message' })));
    assert.equal(response.status, 200);
    assert.equal(scheduled.length, 1, 'waitUntil was given exactly one job before the response returned');
    assert.equal((await store.getEvent('EvVercelOne')).status, 'Observed', 'the response did not wait for the model');
    await Promise.all(scheduled);
    const event = await store.getEvent('EvVercelOne');
    assert.equal(event.status, 'Processed');
    assert.equal(event.receipt.outcome.kind, 'no_action');
    assert.equal(net.to('api.anthropic.com').length, 1);
    assert.match(JSON.parse(net.to('api.anthropic.com')[0].body).messages[0].content, /Real-time fixture message/);
    assert.equal(net.writes().length, 0);
    await app.idle();
  });
});

test('Live: the event budget makes a slow model turn give up cleanly, releasing the event for the next tick instead of being killed mid-claim', async () => {
  await withHarness({ env: { UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled' }, control: live, claude: proposesNoAction('Nothing to do'), eventBudgetMs: -1 }, async h => {
    await goLive(h.f);
    assert.equal((await h.app.slackEvents(signedSlack(slackMessage()))).status, 200);
    await h.app.idle();
    const released = await h.store.getEvent('EvVercelOne');
    assert.equal(released.status, 'Observed');
    assert.equal(released.wakeState, 'Pending');
    assert.equal(released.wakeError, 'time_budget_exhausted');
    assert.equal(h.net.to('api.anthropic.com').length, 0, 'no model call was started after the budget ran out');
    assert.equal(h.net.writes().length, 0);
    const retry = createVercelApp({ env: baseEnv({ UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled' }), fetchImpl: h.net.fetchImpl, clock: () => AT, log: () => {}, open: async () => h.f.db });
    assert.equal((await json(await retry.tick(tickRequest()))).events, 1);
    assert.equal((await h.store.getEvent('EvVercelOne')).status, 'Processed');
  });
});

test('Live: a Notion edit of the control row itself is recognised without calling Claude and is processed in the background', async () => {
  await withHarness({ env: { UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled' }, control: live, claude: () => assert.fail('no model call') }, async ({ app, f, net, store, scheduled }) => {
    await goLive(f);
    const controlEvent = notionEvent('evt-control', { entity: { id: 'c71e1782-2660-4a92-93fb-5977b1e4a8c9', type: 'page' } });
    assert.equal((await app.notionWebhook(signedNotion(controlEvent))).status, 200);
    await Promise.all(scheduled);
    const event = await store.getEvent('notion:evt-control');
    assert.equal(event.status, 'Processed');
    assert.equal(event.receipt.outcome.reason, 'control_change_synced');
    assert.equal(net.to('api.anthropic.com').length, 0);
    assert.equal(net.writes().length, 0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Budgets and constants
// ---------------------------------------------------------------------------------------------------------------
test('time budgets leave headroom under the function limit configured in vercel.json', async () => {
  const { readFileSync } = await import('node:fs');
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const limitMs = config.functions['api/**/*.js'].maxDuration * 1000;
  assert.ok(TICK_BUDGET_MS + 60_000 <= limitMs, 'the tick keeps a minute for the in-flight event it started');
  assert.ok(EVENT_BUDGET_MS + 60_000 <= limitMs, 'an event leaves a minute for its own side effects and receipt');
});
