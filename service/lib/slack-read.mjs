/**
 * Read-only Slack access for the runner (thread and history reads, user lookups).
 * Posting stays exclusively inside slack-dispatch.mjs. Error codes never carry bodies.
 */
import { slackWire } from './slack-wire.mjs';
const tsPattern = /^\d{1,13}\.\d{1,6}$/;
const channelPattern = /^[CDG][A-Z0-9]+$/;
export class SlackReadError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const normalize = (m, maxText = 4000) => ({ ts: m.ts, threadTs: m.thread_ts ?? null, user: m.user ?? null, botId: m.bot_id ?? null,
  replyCount: Number(m.reply_count) || 0,
  // Emoji reactions (sourcing history reads a teammate's thumbs-up on a profile as a pick).
  ...(Array.isArray(m.reactions) && m.reactions.length ? { reactions: m.reactions.slice(0, 12).map(r => ({ name: String(r?.name ?? ''), users: Array.isArray(r?.users) ? r.users.slice(0, 20) : [] })) } : {}),
  appId: m.app_id ?? m.bot_profile?.app_id ?? null, subtype: m.subtype ?? null, edited: !!m.edited,
  text: typeof m.text === 'string' ? m.text.slice(0, maxText) : '',
  // Shared files (screenshots) as Slack describes them; opened only by person-finder.mjs through a token with files:read.
  ...(Array.isArray(m.files) && m.files.length ? { files: m.files.slice(0, 6).map(f => ({ id: f?.id ?? null, name: f?.name ?? null, mimetype: f?.mimetype ?? null, size: f?.size ?? null,
    url_private: f?.url_private ?? null, url_private_download: f?.url_private_download ?? null })) } : {}),
  // Text that rides along: forwarded emails (Slack email files), shared messages and link attachments (person-finder.mjs).
  ...(() => { const extra = extraText(m); return extra ? { extra } : {}; })() });

/** The readable text of a message's attachments and email files, bounded; '' when there is none. */
export function extraText(m) {
  const parts = [];
  for (const a of Array.isArray(m?.attachments) ? m.attachments.slice(0, 4) : []) {
    parts.push([a?.author_name, a?.pretext, a?.title, a?.text ?? a?.fallback, ...(Array.isArray(a?.fields) ? a.fields.map(f => `${f?.title ?? ''}: ${f?.value ?? ''}`) : [])]
      .filter(x => typeof x === 'string' && x.trim()).join(' · '));
  }
  for (const f of Array.isArray(m?.files) ? m.files.slice(0, 4) : []) {
    const people = k => (Array.isArray(f?.[k]) ? f[k].map(p => [p?.name, p?.address ? `<${p.address}>` : ''].filter(Boolean).join(' ')).join(', ') : '');
    if (f?.filetype === 'email' || f?.mode === 'email') {
      parts.push([`Email "${f.subject ?? f.title ?? ''}"`, people('from') && `from ${people('from')}`, people('to') && `to ${people('to')}`, people('cc') && `cc ${people('cc')}`,
        typeof f.plain_text === 'string' ? f.plain_text.slice(0, 2500) : f.preview_plain_text ?? f.preview ?? ''].filter(Boolean).join(' · '));
    } else if (typeof f?.preview === 'string' && /^text\//.test(String(f?.mimetype ?? ''))) parts.push(`${f.title ?? f.name ?? 'file'}: ${f.preview.slice(0, 1500)}`);
  }
  return parts.filter(Boolean).join('\n').slice(0, 4000);
}

export function createSlackReader({ env = {}, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl required');
  async function api(method, parameters = {}) {
    if (!/^xoxb-[A-Za-z0-9-]+$/.test(env.SLACK_BOT_TOKEN ?? '')) throw new SlackReadError('slack_credentials_not_configured');
    let response;
    try {
      response = await fetchImpl(`https://slack.com/api/${method}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs), ...slackWire(method, env.SLACK_BOT_TOKEN, parameters),
      });
    } catch { throw new SlackReadError('slack_transport_failed'); }
    if (!response.ok) throw new SlackReadError('slack_http_failed');
    let body; try { body = await response.json(); } catch { throw new SlackReadError('slack_response_invalid'); }
    if (body?.ok !== true) throw new SlackReadError('slack_api_failed');
    return body;
  }
  return Object.freeze({
    /** Root message plus replies, oldest first, bounded. */
    async readThread({ channelId, threadTs, limit = 50, requireComplete = false } = {}) {
      if (!channelPattern.test(channelId ?? '') || !tsPattern.test(threadTs ?? '')) throw new SlackReadError('invalid_thread_reference');
      const body = await api('conversations.replies', { channel: channelId, ts: threadTs, limit: Math.min(Math.max(limit, 1), 100), inclusive: true });
      if (!Array.isArray(body.messages)) throw new SlackReadError('slack_message_unverified');
      if (requireComplete && (body.has_more || body.response_metadata?.next_cursor)) throw new SlackReadError('slack_thread_incomplete');
      return body.messages.map(m => normalize(m));
    },
    /**
     * Recent top-level messages in a conversation (newest last), bounded. `pages` > 1 follows Slack's opaque cursor
     * (response_metadata.next_cursor) for up to that many pages, so a busy window is not silently cut at one page.
     */
    async readHistory({ channelId, oldest, latest, limit = 30, pages = 1, maxText = 4000, requireComplete = false } = {}) {
      if (!channelPattern.test(channelId ?? '')) throw new SlackReadError('invalid_channel');
      const params = { channel: channelId, limit: Math.min(Math.max(limit, 1), 100), inclusive: true };
      if (oldest != null) { if (!tsPattern.test(String(oldest))) throw new SlackReadError('invalid_bounds'); params.oldest = String(oldest); }
      if (latest != null) { if (!tsPattern.test(String(latest))) throw new SlackReadError('invalid_bounds'); params.latest = String(latest); }
      const messages = [];
      let cursor = '';
      for (let page = 0; page < Math.min(Math.max(pages, 1), 10); page++) {
        const body = await api('conversations.history', { ...params, ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(body.messages)) throw new SlackReadError('slack_message_unverified');
        messages.push(...body.messages);
        cursor = body.has_more === true && typeof body.response_metadata?.next_cursor === 'string' ? body.response_metadata.next_cursor : '';
        if (!cursor) break;
      }
      if (cursor && requireComplete) throw new SlackReadError('slack_history_incomplete');
      return messages.map(m => normalize(m, Math.min(Math.max(Number(maxText) || 4000, 1), 40000))).reverse();
    },
    async conversationInfo(channelId) {
      if (!channelPattern.test(channelId ?? '')) throw new SlackReadError('invalid_channel');
      const { channel } = await api('conversations.info', { channel: channelId });
      if (channel?.id !== channelId) throw new SlackReadError('slack_route_mismatch');
      return { id: channel.id, isIm: channel.is_im === true, isMpim: channel.is_mpim === true, isArchived: channel.is_archived === true };
    },
    /**
     * The membership facts that decide whether someone may ask the bot a question (never a profile). Fail closed: a flag Slack
     * leaves out reads as the unsafe answer, and a reply about a different user is an error.
     */
    async userInfo(userId) {
      if (!/^[UW][A-Z0-9]+$/.test(userId ?? '')) throw new SlackReadError('invalid_user');
      const { user } = await api('users.info', { user: userId });
      if (user?.id !== userId) throw new SlackReadError('slack_user_mismatch');
      return { id: user.id, teamId: typeof user.team_id === 'string' ? user.team_id : null,
        isBot: user.is_bot !== false, isAppUser: user.is_app_user === true, deleted: user.deleted !== false,
        isRestricted: user.is_restricted !== false, isUltraRestricted: user.is_ultra_restricted !== false,
        isStranger: user.is_stranger === true };
    },
    /**
     * Whether a user is a member of a conversation the bot belongs to (conversations.members, every page read, bounded).
     * Errors propagate: the caller treats "could not check" as "no".
     */
    async isMember(channelId, userId) {
      if (!channelPattern.test(channelId ?? '') || !/^[UW][A-Z0-9]+$/.test(userId ?? '')) throw new SlackReadError('invalid_member_check');
      let cursor;
      for (let page = 0; page < 20; page++) {
        const body = await api('conversations.members', { channel: channelId, limit: 200, ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(body.members)) throw new SlackReadError('slack_members_unverified');
        if (body.members.includes(userId)) return true;
        cursor = typeof body.response_metadata?.next_cursor === 'string' ? body.response_metadata.next_cursor : '';
        if (!cursor) return false;
      }
      throw new SlackReadError('slack_members_too_many');
    },
    permalink(channelId, ts) {
      if (!channelPattern.test(channelId ?? '') || !tsPattern.test(ts ?? '')) return null;
      return `https://example-workspace.slack.com/archives/${channelId}/p${ts.replace('.', '').padEnd(ts.indexOf('.') + 6, '0')}`;
    },
  });
}
