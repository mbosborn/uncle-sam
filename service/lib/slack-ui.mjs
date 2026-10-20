/**
 * The bot's interactive surfaces: open or update a modal (views.open, views.update) and replace a prompt's buttons with a
 * record once it is answered (chat.update). Nothing here posts a new message. Errors come back as codes, never bodies.
 * Every method goes as a form (nested values as JSON text), which Slack accepts for all of them (see slack-wire.mjs).
 */
import { slackWire } from './slack-wire.mjs';

export function createSlackUi({ env = {}, fetchImpl = globalThis.fetch, timeoutMs = 2500 } = {}) {
  async function api(method, parameters) {
    if (!/^xoxb-[A-Za-z0-9-]+$/.test(env.SLACK_BOT_TOKEN ?? '')) return { ok: false, code: 'slack_credentials_not_configured' };
    let response;
    try {
      response = await fetchImpl(`https://slack.com/api/${method}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        ...slackWire(method, env.SLACK_BOT_TOKEN, parameters) });
    } catch { return { ok: false, code: 'slack_transport_failed' }; }
    if (!response.ok) return { ok: false, code: `slack_http_${response.status}` };
    let body; try { body = await response.json(); } catch { return { ok: false, code: 'slack_response_invalid' }; }
    if (body?.ok !== true) return { ok: false, code: typeof body?.error === 'string' && /^[a-z0-9_]{1,60}$/.test(body.error) ? body.error : 'slack_api_failed' };
    return { ok: true, body };
  }
  return Object.freeze({
    viewsOpen: ({ triggerId, view }) => api('views.open', { trigger_id: triggerId, view }),
    viewsUpdate: ({ viewId, hash, view }) => api('views.update', { view_id: viewId, ...(hash ? { hash } : {}), view }),
    // blocks is an array: sent as JSON text (a form joins plain arrays with commas, which is right only for lists of IDs).
    chatUpdate: ({ channelId, ts, text, blocks }) => api('chat.update', { channel: channelId, ts, text, blocks: JSON.stringify(blocks ?? []) }),
  });
}
