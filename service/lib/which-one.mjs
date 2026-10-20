/**
 * Project's answer to "Which one: A or B?" (Project, 2026-10-17: Uncle Sam asked "Which one: Aarlen Archer (Research) or Arlen
 * Archer (Zepto)? Reply with their full name and I'll resend", he replied "the one on the work trial", and nothing happened:
 * "uncle sam should be able to act on that").
 *
 * When a command in Project's DM names someone with namesakes, the options are kept (with company, stage and pipeline) under that
 * conversation. His next reply in the thread, or a short top-level reply within 15 minutes, picks one by any of: the full name,
 * the company ("Zepto", "from Zepto"), the stage ("the one on the work trial", "case study", "interview"), the pipeline
 * ("India", "research") or the order ("the first", "2"). One clear match: the original command runs again for that person.
 */
import { noticeStore } from './stuck-rejections.mjs';

const TTL_MS = 6 * 3600_000, TOP_LEVEL_MS = 15 * 60_000;
const norm = t => String(t ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9/\s-]/g, ' ').replace(/\s+/g, ' ').trim();
const STAGE_WORDS = [
  [/\b(work ?trial|trial|on trial|trialing)\b/, 'Trial'], [/\b(case ?study|take ?home)\b/, 'Case Study'], [/\b(technical|interview)\b/, 'Interview'],
  [/\b(intro|first call)\b/, 'Intro Call'], [/\b(offer|extended offer)\b/, 'Extended Offer'], [/\b(outreach)\b/, 'Outreach'],
];
const ORDINALS = [[/\b(first|1st|one|1)\b/, 0], [/\b(second|2nd|two|2)\b/, 1], [/\b(third|3rd|three|3)\b/, 2]];
const COMMAND = /\b(send|resend|re-send|okta|reject|withdraw|hold|take ?-?home to|docusign)\b/i;

/** The single option the reply points at, or null. */
export function pickOption(text, options) {
  const t = norm(text);
  if (!t || !options?.length) return null;
  const score = options.map((o, i) => {
    let s = 0;
    const parts = norm(String(o.fullName ?? '').replace(/\([^)]*\)/g, ' ')).split(' ').filter(p => p.length > 1);
    if (parts.length && parts.every(p => new RegExp(`\\b${p}\\b`).test(t))) s += 3;
    if (o.from && new RegExp(`\\b${norm(o.from).replace(/[/]/g, '\\/')}\\b`).test(t)) s += 3;
    for (const [re, stage] of STAGE_WORDS) if (re.test(t) && o.stage === stage) s += 2;
    if (o.pipeline && new RegExp(`\\b${norm(o.pipeline).replace(/[/]/g, '\\/')}\\b`).test(t)) s += 1;
    for (const [re, idx] of ORDINALS) if (re.test(t) && idx === i && t.split(' ').length <= 4) s += 2;
    return s;
  });
  const best = Math.max(...score);
  if (best <= 0) return null;
  const winners = options.filter((_, i) => score[i] === best);
  return winners.length === 1 ? winners[0] : null;
}

/** Keeps the options of a "Which one" question for the reply. */
export async function rememberWhichOne({ db, event, text, options, clock = Date.now }) {
  if (!db?.prepare || !event?.channelId || !options?.length) return;
  const kv = noticeStore(db), now = clock(), root = event.threadTs ?? event.messageTs;
  const value = { at: now, text: String(text ?? event.text ?? '').slice(0, 600), root, options: options.slice(0, 6) };
  await kv.put(`which-one:${event.channelId}:${root}`, value, now);
  await kv.put(`which-one:${event.channelId}:last`, value, now);
}

/** { text, who } when this message answers a kept question with one clear match; null otherwise. */
export async function resolveWhichOne({ db, event, clock = Date.now }) {
  if (!db?.prepare || !event?.channelId) return null;
  const kv = noticeStore(db), now = clock();
  const inThread = event.threadTs && event.threadTs !== event.messageTs;
  let held = inThread ? await kv.get(`which-one:${event.channelId}:${event.threadTs}`) : null;
  if (!held && !inThread) {
    const last = await kv.get(`which-one:${event.channelId}:last`);
    if (last && now - last.at < TOP_LEVEL_MS && String(event.text ?? '').length <= 120 && !COMMAND.test(event.text)) held = last;
  }
  if (!held || held.used || now - held.at > TTL_MS) return null;
  const who = pickOption(event.text, held.options);
  if (!who) return null;
  const used = { ...held, used: now, picked: who.pageId };
  await kv.put(`which-one:${event.channelId}:${held.root}`, used, now);
  await kv.put(`which-one:${event.channelId}:last`, used, now);
  return { text: held.text, who };
}

const FOLLOW = /\b(do it|go ahead|yes|yeah|yep|yup|that one|re-?send|send (?:it|them))\b/i;
const ROOT_COMMAND = /\b(re-?send|send|okta|take ?-?home|docu ?sign|remind|nudge)\b/i;

/**
 * A reply in a thread whose question was asked before the options were kept (or whose answer the keeper missed): Project's
 * "the one on the work trial", then "resend them to him" (2026-10-17, "really?"). The thread's first message is his command;
 * his replies in the thread pick the person (newest first); the command runs for them. `readThread(event)` gives the thread,
 * oldest first; `finder(text)` is the command's own finder. -> { text, who } or null.
 */
export async function recoverFromThread({ event, readThread, finder, masonId }) {
  if (!event?.threadTs || event.threadTs === event.messageTs || typeof readThread !== 'function' || typeof finder !== 'function') return null;
  const thread = await readThread(event);
  const root = (thread ?? []).find(m => m.ts === event.threadTs);
  if (!root || root.user !== masonId || root.botId || !ROOT_COMMAND.test(root.text ?? '')) return null;
  const replies = (thread ?? []).filter(m => m.user === masonId && !m.botId && m.ts !== root.ts && Number(m.ts) <= Number(event.messageTs));
  if (!replies.some(m => m.ts === event.messageTs)) replies.push({ ts: event.messageTs, text: event.text, user: masonId });
  const found = await finder(root.text, { ...event, text: root.text, threadTs: null, messageTs: root.ts });
  // One clear person: only an explicit "resend" under a resend runs it again (a resend is never repeated within the hour).
  if (found?.email && !found.ambiguous) return /\bre-?send\b/i.test(event.text ?? '') && /\bre-?send\b/i.test(root.text) ? { text: root.text, who: found } : null;
  if (!found?.ambiguous || !found.options?.length) return null;
  // This reply picks, or it says to go ahead and an earlier reply of his picked.
  const now = pickOption(event.text, found.options);
  if (now) return { text: root.text, who: now };
  if (!FOLLOW.test(event.text ?? '')) return null;
  for (const m of [...replies].reverse()) { const who = pickOption(m.text, found.options); if (who) return { text: root.text, who }; }
  return null;
}
