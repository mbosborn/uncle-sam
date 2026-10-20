import { createHmac } from 'node:crypto';
import { createVercelApp } from '../../service/lib/vercel-handlers.mjs';
import { CONTROL_PAGE_ID } from '../../service/lib/notion-wake.mjs';
import { APP_ID, TEAM_ID } from '../../service/lib/identity.mjs';
import { libsqlFixture } from './libsql.mjs';

/** A fixed, plausible "now" (15:20 UTC, so an idle Live tick writes no heartbeat) and a Live activation an hour earlier. */
export const AT = Date.parse('2026-10-14T15:20:00Z');
export const ACTIVATED = AT - 3600_000;
export { APP_ID, TEAM_ID, CONTROL_PAGE_ID };

export const SECRETS = Object.freeze({
  CRON_SECRET: 'cron-fixture-secret-0123456789abcdef0123456789',
  SLACK_SIGNING_SECRET: 'slack-signing-fixture-secret',
  NOTION_WEBHOOK_SECRET: 'notion-webhook-fixture-secret',
  PORTAL_WEBHOOK_SECRET: 'portal-webhook-fixture-secret',
  NOTION_TOKEN: 'notion-token-fixture-value',
  SLACK_BOT_TOKEN: 'xoxb-fixture-token-value',
  ANTHROPIC_API_KEY: 'anthropic-key-fixture-value',
});
export const ROUTES = JSON.stringify({
  jamie_group: { channelId: 'GJAMIE0001', type: 'mpim' },
  interviewer_rishi: { channelId: 'DRISHI0001', type: 'im' },
});
export const baseEnv = (extra = {}) => ({
  ...SECRETS, SLACK_BOT_USER_ID: 'UBOTFIXTURE', SLACK_BOT_ID: 'BBOTFIXTURE', UNCLE_SAM_AUTOMATIC_ACTIVITY: 'off',
  SLACK_ROUTE_MAP_JSON: ROUTES, ANTHROPIC_MODEL: 'fixture-model-1', ...extra,
});

export const controlPage = ({ mode = 'Off', baseline = false, activatedAt = null } = {}) => ({
  object: 'page', id: CONTROL_PAGE_ID, archived: false, in_trash: false,
  properties: {
    Mode: { type: 'select', select: { name: mode } },
    'Record kind': { type: 'select', select: { name: 'Control' } },
    'Request key': { type: 'rich_text', rich_text: [{ plain_text: 'uncle-sam:control' }] },
    'Baseline complete': { type: 'checkbox', checkbox: baseline },
    'Activated at': { type: 'date', date: activatedAt == null ? null : { start: new Date(activatedAt).toISOString() } },
    'Policy version': { type: 'rich_text', rich_text: [{ plain_text: 'fixture-policy' }] },
  },
});

/** Claude over HTTP: always proposes the given reason as a no_action (the only proposal with no side effects). */
export const proposesNoAction = reason => async () => Response.json({
  id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture-model-1', stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: 'toolu_fixture', name: 'propose', input: { kind: 'no_action', reason } }],
  usage: { input_tokens: 11, output_tokens: 3 },
});

// POSTs that only read (Slack's Web API and Notion's queries use POST for reads; Claude is a read for our purposes).
const READ_ONLY = [/^https:\/\/slack\.com\/api\/(conversations\.(history|replies|info|members)|auth\.test|bots\.info|users\.info)$/, /^https:\/\/api\.anthropic\.com\//, /^https:\/\/openrouter\.ai\/api\//,
  /^https:\/\/api\.notion\.com\/v1\/(search|[a-z_]+\/[0-9a-f-]+\/query)$/];
const isWrite = call => call.method !== 'GET' && !READ_ONLY.some(pattern => pattern.test(call.url));

/**
 * Stand-in for every outside service. Only the Notion control row (null makes it unavailable) and, optionally, Claude
 * answer; any other request gets a 500, which the runner treats as an unavailable dependency. Every request is recorded.
 */
export function network({ control = { mode: 'Off' }, claude } = {}) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
    if (url === `https://api.notion.com/v1/pages/${CONTROL_PAGE_ID}`) {
      return control ? Response.json(controlPage(control)) : Response.json({ object: 'error', code: 'fixture_unavailable' }, { status: 500 });
    }
    if ((url === 'https://api.anthropic.com/v1/messages' || url === 'https://openrouter.ai/api/v1/messages') && claude) return claude(JSON.parse(init.body), init);
    return Response.json({ object: 'error', code: 'fixture_unavailable' }, { status: 500 });
  };
  return { fetchImpl, calls, to: host => calls.filter(call => call.url.includes(host)), writes: () => calls.filter(isWrite) };
}

/**
 * The Vercel app wired to a real (temporary) libSQL database, the production store/runner, a fake network and
 * a recording stand-in for Vercel's waitUntil. `open` receives the fixture so tests can break the database.
 */
export async function harness({ env = {}, control, claude, open = f => async () => f.db, clock = () => AT, ...options } = {}) {
  const f = await libsqlFixture({ at: AT });
  const net = network({ control, claude });
  const logs = [], scheduled = [];
  const app = createVercelApp({ env: baseEnv(env), fetchImpl: net.fetchImpl, clock, log: line => logs.push(String(line)),
    schedule: promise => scheduled.push(promise), open: open(f), ...options });
  return { app, f, net, logs, scheduled, store: f.store, close: () => f.close() };
}
export async function withHarness(options, fn) {
  const h = await harness(options);
  try { await fn(h); } finally { h.close(); }
}

/** What the runner would have mirrored into the database once Notion says Live. */
export const goLive = f => f.store.updateControl({ expectedVersion: 0, mode: 'Live', baselineComplete: true, activatedAt: ACTIVATED });

export function slackHeaders(raw, { secret = SECRETS.SLACK_SIGNING_SECRET, at = AT, signature } = {}) {
  const seconds = String(Math.floor(at / 1000));
  const mac = createHmac('sha256', secret).update(`v0:${seconds}:${raw}`).digest('hex');
  return { 'content-type': 'application/json', 'x-slack-request-timestamp': seconds, 'x-slack-signature': signature ?? `v0=${mac}` };
}
export function signedSlack(body, { url = 'https://uncle-sam.example/api/slack/events', ...options } = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request(url, { method: 'POST', body: raw, headers: slackHeaders(raw, options) });
}
export const slackMessage = (overrides = {}, eventId = 'EvVercelOne', envelope = {}) => ({
  type: 'event_callback', event_id: eventId, api_app_id: APP_ID, team_id: TEAM_ID, ...envelope,
  event: { type: 'message', channel: 'GJAMIE0001', channel_type: 'mpim', ts: `${AT / 1000}.000100`, user: 'U0A4F08721B', text: 'Fixture message', ...overrides },
});
export const post = (path, body, headers = {}) => new Request(`https://uncle-sam.example${path}`, { method: 'POST',
  headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
export const get = (path, headers = {}) => new Request(`https://uncle-sam.example${path}`, { headers });
export const bearer = (secret = SECRETS.CRON_SECRET) => ({ authorization: `Bearer ${secret}` });
export const notionSignature = (secret, raw) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
export const json = async response => JSON.parse(await response.text());
