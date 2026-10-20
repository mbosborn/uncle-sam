/**
 * The one place, besides the bounded dispatcher, that posts to Slack: a short reply into the thread an @-mention came from.
 * It cannot post anywhere else (the destination is the conversation and thread of the question, validated here), cannot
 * broadcast to the channel or unfurl links, and never retries. Error codes never carry response bodies.
 *
 * A reply is one line of plain text. The only markup it can carry is a link on a person's name, and only a link trusted code
 * built: such a reply also comes as parts, each either plain text or {link: {url, label}}, where the url is a canonical LinkedIn
 * profile or a Notion page address, the label is plain text, and the parts read exactly as the reply's text (which is what the
 * receipt keeps). A reply with links is posted with Slack markup on, because links need it; every other reply with it off.
 *
 * The outcome is one of three, and the caller never retries any of them, because a reply that may have been posted must not
 * be posted twice:
 *   sent       Slack confirmed the post (and which message).
 *   refused    Slack answered that it did not post (a Slack error code such as not_in_channel is returned).
 *   uncertain  the request or its answer was lost: the message may or may not be visible.
 */
import { slackWire } from './slack-wire.mjs';

const channelPattern = /^[CDG][A-Z0-9]+$/;
const tsPattern = /^\d{1,13}\.\d{1,6}$/;
export const MAX_REPLY_CHARACTERS = 1500;
const MAX_PARTS = 40;
const TRUSTED_LINK = /^https:\/\/(?:www\.linkedin\.com\/in\/[A-Za-z0-9_%-]{3,100}|(?:www\.notion\.so|notion\.so|app\.notion\.com)\/[A-Za-z0-9._~%/-]{1,250})$/;

/** A link trusted code may put on a name: a LinkedIn profile in its canonical form, or a Notion page. Nothing else. */
export const isTrustedLink = url => typeof url === 'string' && TRUSTED_LINK.test(url);
// Plain text: no control characters, and no angle brackets, which Slack would read as mentions and links.
const isPlain = text => typeof text === 'string' && !/[\u0000-\u001f\u007f<>]/u.test(text);
const isLabel = label => isPlain(label) && label.trim() !== '' && label.length <= 120 && !label.includes('|');
const hasKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === keys;

/** The Slack text for a reply given as parts, or null unless every part is exactly what trusted code builds and they read as `text`. */
export function slackTextOf(parts, text) {
  if (!Array.isArray(parts) || !parts.length || parts.length > MAX_PARTS) return null;
  let slack = '', plain = '';
  for (const part of parts) {
    if (hasKeys(part, 'text') && isPlain(part.text)) { slack += part.text; plain += part.text; }
    else if (hasKeys(part, 'link') && hasKeys(part.link, 'label,url') && isTrustedLink(part.link.url) && isLabel(part.link.label)) {
      slack += `<${part.link.url}|${part.link.label}>`; plain += part.link.label;
    } else return null;
  }
  return plain === text ? slack : null;
}

export function createSlackAnswerer({ env = {}, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl required');
  return Object.freeze({
    async post({ channelId, threadTs, text, parts } = {}) {
      if (!/^xoxb-[A-Za-z0-9-]+$/.test(env.SLACK_BOT_TOKEN ?? '')) return { status: 'refused', code: 'slack_credentials_not_configured' };
      // A thread reply, or (only in a direct message, channel D…) a plain message in that DM.
      const plainDm = threadTs == null && /^D[A-Z0-9]+$/.test(channelId ?? '');
      if (!channelPattern.test(channelId ?? '') || (!plainDm && !tsPattern.test(threadTs ?? ''))) return { status: 'refused', code: 'invalid_thread_reference' };
      if (!isPlain(text) || !text.trim() || text.length > MAX_REPLY_CHARACTERS) return { status: 'refused', code: 'invalid_reply_text' };
      const slackText = parts === undefined ? text : slackTextOf(parts, text);
      if (slackText === null) return { status: 'refused', code: 'invalid_reply_text' };
      let response;
      try {
        response = await fetchImpl('https://slack.com/api/chat.postMessage', {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
          ...slackWire('chat.postMessage', env.SLACK_BOT_TOKEN, { channel: channelId, text: slackText, ...(plainDm ? {} : { thread_ts: threadTs, reply_broadcast: false }),
            mrkdwn: slackText !== text, parse: 'none', unfurl_links: false, unfurl_media: false }),
        });
      } catch { return { status: 'uncertain', code: 'slack_transport_failed' }; }
      if (!response.ok) return { status: response.status >= 500 ? 'uncertain' : 'refused', code: `slack_http_${response.status}` };
      let body;
      try { body = await response.json(); } catch { return { status: 'uncertain', code: 'slack_response_invalid' }; }
      if (body?.ok !== true) return { status: 'refused', code: typeof body?.error === 'string' && /^[a-z0-9_]{1,60}$/.test(body.error) ? body.error : 'slack_api_failed' };
      if (body.channel !== channelId || !tsPattern.test(body.ts ?? '')) return { status: 'uncertain', code: 'slack_post_result_unverified' };
      return { status: 'sent', ts: body.ts };
    },
  });
}
