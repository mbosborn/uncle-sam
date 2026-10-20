/**
 * Replies to Uncle Sam in a channel thread (Project, 2026-10-16): someone who tags Uncle Sam gets an answer; after that, a
 * reply in the same thread that answers Uncle Sam (nobody else has spoken since its last message, and it tags no one else)
 * is read as said to Uncle Sam, with the thread so far as context. A message aimed at a person ("@Project can you…") or
 * chatter after someone else has spoken is left alone. Kept for a day.
 */
import { noticeStore } from './stuck-rejections.mjs';

export const THREAD_MEMORY_MS = 24 * 3600_000;
const key = (channelId, threadTs) => `thread-bot:${channelId}:${threadTs}`;
const tsNum = ts => Number(ts) || 0;

/** Uncle Sam posted `botTs` in this channel thread. */
export async function rememberBotReply(db, { channelId, threadTs, botTs, now = Date.now() } = {}) {
  if (!db?.prepare || !/^[CG][A-Z0-9]+$/.test(channelId ?? '') || !threadTs || !botTs) return;
  await noticeStore(db).put(key(channelId, threadTs), { botTs, lastHumanTs: null, at: now }, now);
}

/** True when this untagged thread reply answers Uncle Sam's last message there. */
export async function isReplyToBot(db, event, { botUserId, now = Date.now() } = {}) {
  if (!db?.prepare || !event?.threadTs || event.threadTs === event.messageTs) return false;
  const saved = await noticeStore(db).get(key(event.channelId, event.threadTs));
  if (!saved?.botTs || now - (saved.at ?? 0) > THREAD_MEMORY_MS) return false;
  if (saved.lastHumanTs && tsNum(saved.lastHumanTs) > tsNum(saved.botTs)) return false; // someone else spoke since
  if (tsNum(event.messageTs) <= tsNum(saved.botTs)) return false;
  const tagged = [...String(event.text ?? '').matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map(m => m[1]).filter(id => id !== botUserId);
  return tagged.length === 0;
}

/** A person spoke in a thread Uncle Sam is in: later replies are answers to Uncle Sam only if it speaks again. */
export async function noteHumanReply(db, event, now = Date.now()) {
  if (!db?.prepare || !event?.threadTs) return;
  const store = noticeStore(db);
  const saved = await store.get(key(event.channelId, event.threadTs));
  if (!saved?.botTs) return;
  if (!saved.lastHumanTs || tsNum(event.messageTs) > tsNum(saved.lastHumanTs)) await store.put(key(event.channelId, event.threadTs), { ...saved, lastHumanTs: event.messageTs }, saved.at ?? now);
}

const NAMES = Object.freeze({ U0F9EF97D89: 'Project', U0CB213D6D6: 'Jamie', U0BF89D1279: 'AA', U0A4F08721B: 'Robin', U0476A5BC82: 'Alexis', U030A09DBFF: 'Interviewer' });
/** The thread so far as plain lines ("Robin: …", "Uncle Sam: …"), oldest first, without the message being answered. */
export function threadTranscript(messages, { botUserId, exceptTs = null, max = 12, maxText = 400 } = {}) {
  const lines = (messages ?? []).filter(m => m && m.ts !== exceptTs && !m.subtype)
    .map(m => {
      const who = m.botId || (botUserId && m.user === botUserId) ? 'Uncle Sam' : (NAMES[m.user] ?? 'A teammate');
      const text = String(m.text ?? '').replace(/<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id, label) => `@${id === botUserId ? 'Uncle Sam' : (NAMES[id] ?? label ?? 'someone')}`)
        .replace(/\s+/g, ' ').trim().slice(0, maxText);
      return text ? `${who}: ${text}` : null;
    }).filter(Boolean);
  return lines.slice(-max).join('\n');
}
