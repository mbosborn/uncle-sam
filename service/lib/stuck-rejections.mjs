/**
 * Stuck rejections. When the separate rejection sender sets a Not Selected candidate's "Rejection email status" to Needs
 * attention, the email waits until someone re-arms it.
 *
 *  - Project, 2026-10-15: he does not want to hear about these when Uncle Sam can fix them itself. So each tick, a stuck row
 *    that has an email on record, no send attempt and no hold is restarted automatically, once: the interview end the sender
 *    needs is kept when recorded, else taken from the latest logged interview, else the time Uncle Sam found it (never earlier
 *    than the real end, so the email can only go later, never earlier), and the earliest send is 24 hours after that end.
 *    A dated note on the record says why; the sender's instructions accept it as the reviewed re-arm. No message to Project.
 *  - Project is DMed once, with the reason, only when it needs him: no email on record, a send that may already have gone out,
 *    a hold someone set, or a row the sender stopped again after an automatic restart. His "go" as a reply in that thread
 *    is his reviewed re-arm (same rules, with the time of his "go" as the last-resort end).
 *
 * Nothing is sent to a candidate from here; Uncle Sam's rejection sender (rejection-sender.mjs) sends when it is due, after its
 * own duplicate check of Project's Sent mail. Only Project, only in his DM with the bot, only as a reply to the notice, can "go".
 */
import { masonPoster } from './wispr.mjs';
import { linkedinProfileUrl } from './name-links.mjs';

export const MASON_ID = 'U0F9EF97D89';
const SLACK_ORIGIN = 'https://example-workspace.slack.com';
const DAY = 24 * 3600_000;
const iso = ms => new Date(ms).toISOString();
const ceilMinute = ms => Math.ceil(ms / 60_000) * 60_000;
const permalink = (channelId, ts) => `${SLACK_ORIGIN}/archives/${channelId}/p${String(ts).replace('.', '').padEnd(String(ts).indexOf('.') + 6, '0')}`;
const httpsUrl = value => { try { return new URL(value).protocol === 'https:'; } catch { return false; } };
const when = ms => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(ms);

export class StuckError extends Error {
  constructor(code) { super(code); this.code = code; }
}

/** Rows in uncle_sam_notices: stuck:<page id> -> the notice, thread:<ts> -> the page id it is about, auto:<page id> -> restarted once. */
export function noticeStore(db) {
  if (!db?.prepare) throw new StuckError('database_missing');
  return Object.freeze({
    async get(name) {
      const row = await db.prepare('SELECT value FROM uncle_sam_notices WHERE name = ?').bind(name).first();
      if (!row) return null;
      try { return JSON.parse(row.value); } catch { return null; }
    },
    async put(name, value, now) {
      await db.prepare('INSERT INTO uncle_sam_notices (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
        .bind(name, JSON.stringify(value), now).run();
    },
    /** Replace only the exact version read by this worker; stale send/update/cancel workers lose. */
    async compareAndSwap(name, previous, value, now) {
      if (previous === null) return !!(await db.prepare('INSERT INTO uncle_sam_notices (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO NOTHING RETURNING name')
        .bind(name, JSON.stringify(value), now).first());
      return !!(await db.prepare('UPDATE uncle_sam_notices SET value = ?, updated_at = ? WHERE name = ? AND value = ? RETURNING name')
        .bind(JSON.stringify(value), now, name, JSON.stringify(previous)).first());
    },
    async del(name) { await db.prepare('DELETE FROM uncle_sam_notices WHERE name = ?').bind(name).run(); },
    /**
     * Atomic "first one wins" (never a read then a write: two runs at once would both see nothing and both send). True when
     * this call made the row; with `maxAgeMs`, also when the row it found is older than that (then it is taken over).
     */
    async claim(name, value, now, { maxAgeMs = null } = {}) {
      const row = maxAgeMs == null
        ? await db.prepare('INSERT INTO uncle_sam_notices (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO NOTHING RETURNING name').bind(name, JSON.stringify(value), now).first()
        : await db.prepare(`INSERT INTO uncle_sam_notices (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value,
            updated_at = excluded.updated_at WHERE uncle_sam_notices.updated_at <= ? RETURNING name`).bind(name, JSON.stringify(value), now, now - maxAgeMs).first();
      return !!row;
    },
    async names(prefix) {
      const { results } = await db.prepare('SELECT name FROM uncle_sam_notices WHERE name LIKE ?').bind(`${prefix}%`).all();
      return (results ?? []).map(r => r.name);
    },
  });
}

/** True when Uncle Sam may restart this row without Project: an email on record, no send attempt, no hold. */
export const restartable = ({ candidate, sender }) => !!candidate.email && !sender.attempt && !sender.hold;

/** Why the sender is waiting, in plain words, and what Project should do. */
export function stuckReason({ candidate, sender }, { restartedBefore = false } = {}) {
  if (!candidate.email) return { text: 'there is no email on their record', ask: 'Add their email in the tracker, then reply *go* in this thread.' };
  if (sender.attempt) return { text: 'a send was started and may already have gone out',
    ask: `Check your Sent mail for ${candidate.email} first, and reply *go* in this thread only if nothing went out.` };
  if (sender.hold) return { text: 'someone put it on hold (Rejection email hold is ticked)', ask: 'If it should go, untick the hold on their record, then reply *go* in this thread.' };
  if (restartedBefore) return { text: 'the rejection sender stopped it again after I restarted it (the reason is on their record)', ask: 'If it should still go, reply *go* in this thread.' };
  if (!sender.lastInterviewEnd) return { text: 'no interview end time was recorded', ask: 'Reply *go* in this thread and I\'ll schedule it for 24 hours after their last interview (or right away if that has passed).' };
  return { text: 'the rejection sender flagged it for review (the reason is on their record)', ask: 'If it should still go, reply *go* in this thread and I\'ll schedule it.' };
}

export function noticeText(row, options = {}) {
  const { candidate } = row;
  const reason = stuckReason(row, options);
  // Their name links to their LinkedIn when one is on file (Project, 2026-10-15).
  const linkedin = linkedinProfileUrl(candidate.profile?.linkedin);
  const name = linkedin ? `<${linkedin}|${String(candidate.fullName).replace(/[<>|]/g, ' ')}>` : candidate.fullName;
  return `📯 *${name}*'s rejection email is stuck: ${reason.text}. ${reason.ask} <${candidate.url}|Their record>`;
}

/**
 * Re-arm one stuck row. `fallback` is the last-resort interview end ({ ms, sourceUrl }): the moment someone acted, which is
 * never earlier than the real end. Returns { dueMs, interviewEnd, basis } after the sender's queue is written and read back.
 */
async function rearm({ notion, candidate, sender, clock, fallback }) {
  let interviewEnd = null, basis = 'recorded', endMs = Date.parse(sender.lastInterviewEnd ?? '');
  if (!Number.isFinite(endMs)) {
    const logged = (await notion.listCandidateInterviews({ candidatePageId: candidate.pageId }))
      .filter(row => row.status !== 'cancelled' && row.end && Date.parse(row.end) <= fallback.ms && httpsUrl(row.htmlLink))
      .sort((a, b) => Date.parse(b.end) - Date.parse(a.end))[0];
    interviewEnd = logged ? { at: logged.end, sourceUrl: logged.htmlLink } : { at: iso(fallback.ms), sourceUrl: fallback.sourceUrl };
    basis = logged ? 'logged' : 'fallback';
    endMs = Date.parse(interviewEnd.at);
  }
  const decisionAt = sender.decisionAt && Number.isFinite(Date.parse(sender.decisionAt)) ? sender.decisionAt : iso(fallback.ms);
  const decisionKey = sender.decisionKey ?? `${candidate.pageId}|${new Date(Date.parse(decisionAt)).toISOString()}`;
  const dueMs = ceilMinute(Math.max(clock(), Date.parse(decisionAt), endMs + DAY));
  await notion.rearmRejection({ pageId: candidate.pageId, expectedEmail: candidate.email, interviewEnd, decisionAt, decisionKey, scheduledFor: iso(dueMs) });
  return { dueMs, interviewEnd, basis };
}

const BASIS_WORDS = Object.freeze({ recorded: 'the interview end already on their record', logged: 'their latest logged interview' });

/** One tick: restart what Uncle Sam can; tell Project once about the rest; forget notices for rows no longer stuck. Never throws. */
export async function runStuckRejections({ env, db, notion, routeMap, fetchImpl = globalThis.fetch, clock = Date.now, log = () => {} }) {
  const summary = { stuck: 0, restarted: 0, notified: 0, cleared: 0, error: null };
  try {
    if (env.UNCLE_SAM_AUTOMATIC_ACTIVITY !== 'enabled' || !routeMap?.project?.channelId || !db?.prepare) return summary;
    if ((await notion.readControl())?.mode !== 'Live') return summary;
    const store = noticeStore(db);
    const rows = await notion.listStuckRejections();
    summary.stuck = rows.length;
    const live = new Set(rows.map(r => r.candidate.pageId));
    for (const name of await store.names('stuck:')) {
      if (live.has(name.slice(6))) continue;
      const notice = await store.get(name);
      await store.del(name);
      if (notice?.ts) await store.del(`thread:${notice.ts}`);
      summary.cleared++;
    }
    const post = masonPoster({ env, fetchImpl, channelId: routeMap.project.channelId });
    for (const row of rows) {
      const { pageId } = row.candidate;
      const key = `stuck:${pageId}`;
      if (await store.get(key)) continue;
      // A send that may have gone out is settled from Project's Sent mail first (rejection-sender.mjs confirmUnclearSends);
      // Project is asked only when that could not settle it.
      if (row.sender.attempt && !(await store.get(`rejection-confirm:gaveup:${pageId}`))) continue;
      // Uncle Sam is the only rejection sender since Oct 16, so a restartable row that keeps getting stopped was stopped by the
      // retired Notion agent (Charlie Grant, Oct 20: it re-stopped him an hour after the restart). Restart up to three times
      // a day without asking; only past that does Project hear (Project, 2026-10-20: make it go regardless).
      const auto = await store.get(`auto:${pageId}`);
      const recent = (auto?.times ?? (auto?.at ? [auto.at] : [])).filter(t => clock() - t < DAY);
      const restartedBefore = recent.length >= 3;
      if (restartable(row) && !restartedBefore) {
        try {
          const now = clock();
          const { dueMs, basis } = await rearm({ notion, candidate: row.candidate, sender: row.sender, clock, fallback: { ms: now, sourceUrl: row.candidate.url } });
          await store.put(`auto:${pageId}`, { at: now, due: dueMs, times: [...recent, now] }, now);
          summary.restarted++;
          try {
            await notion.appendCandidateNote({ pageId, sourceUrl: row.candidate.url,
              text: `${iso(now).slice(0, 10)} · Rejection email restarted automatically by Uncle Sam (Project's standing instruction, Oct 15: a stopped rejection with an email on record, no send attempt and no hold is restarted without him; this is the reviewed re-arm). Scheduled for ${when(dueMs)} PT, at least 24 hours after ${BASIS_WORDS[basis] ?? 'the time Uncle Sam found it stopped (no interview time was on record; the interview was over before the rejection, so this is never earlier than the real end)'}.` });
          } catch { /* the re-arm is made and read back; the note is history */ }
          continue;
        } catch (error) {
          log(`uncle_sam_stuck_rejections restart_failed page=${pageId} error=${typeof error?.code === 'string' ? error.code : 'unknown'}`);
          // falls through: Project is told instead
        }
      }
      const ts = await post(noticeText(row, { restartedBefore }));
      const now = clock();
      await store.put(key, { pageId, channelId: routeMap.project.channelId, ts, email: row.candidate.email, at: now }, now);
      await store.put(`thread:${ts}`, { pageId }, now);
      summary.notified++;
    }
    return summary;
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'stuck_check_failed';
    log(`uncle_sam_stuck_rejections error=${code}`);
    return { ...summary, error: code };
  }
}

/** The Slack connector Project's Claude sessions use signs each post "Sent using @Claude"; that footer is not part of what he said. */
export const withoutFooter = text => {
  const original = String(text ?? '');
  const stripped = original.replace(/\s*_?\*?Sent using\*?_?\s*<@[A-Z0-9]+(?:\|[^>]*)?>\s*$/i, '');
  return stripped === original ? original : stripped.trimEnd();
};

/** True for Project's "go" as a reply in his DM with the bot (the caller has already matched the "project" route). */
export function isStuckGo(event) {
  const text = withoutFooter(event?.text).replace(/<@[A-Z0-9]+(?:\|[^>]*)?>/g, ' ').trim();
  return event?.authorId === MASON_ID && !!event.threadTs && event.threadTs !== event.messageTs && /^go\b[\s.!]*$/i.test(text);
}

/**
 * Project's "go": re-arm the rejection the notice in this thread is about. Returns null when the thread is not a stuck-rejection
 * notice (the message then goes on to the usual lanes); otherwise an outcome after replying in the thread.
 */
export async function handleStuckGo({ event, env, db, notion, fetchImpl = globalThis.fetch, clock = Date.now, sideEffects = [] }) {
  const store = noticeStore(db);
  const pointer = await store.get(`thread:${event.threadTs}`);
  if (!pointer?.pageId) return null;
  const reply = masonPoster({ env, fetchImpl, channelId: event.channelId, threadTs: event.threadTs });
  const forget = async () => { await store.del(`stuck:${pointer.pageId}`); await store.del(`thread:${event.threadTs}`); };
  const { candidate, sender } = await notion.getRejectionState(pointer.pageId);
  if (candidate.fields.Outcome !== 'Not Selected' || sender.status !== 'Needs attention') {
    await forget();
    await reply(`📋 Nothing to restart: ${candidate.fullName}'s rejection email is ${sender.status ? `now "${sender.status}"` : 'no longer queued'}.`);
    return { kind: 'rejection_rearm_refused', reason: 'not_stuck' };
  }
  if (sender.hold) { await reply(`📋 ${candidate.fullName}'s rejection is on hold (Rejection email hold is ticked on their record). Untick it, then reply *go* again.`); return { kind: 'rejection_rearm_refused', reason: 'on_hold' }; }
  if (!candidate.email) { await reply(`📋 ${candidate.fullName} still has no email on their record. Add it, then reply *go* again.`); return { kind: 'rejection_rearm_refused', reason: 'no_email' }; }
  const goMs = Math.min(Math.floor(Number(event.messageTs) * 1000) || clock(), clock());
  sideEffects.push('rejection_rearm_attempted');
  const { dueMs, basis } = await rearm({ notion, candidate, sender, clock, fallback: { ms: goMs, sourceUrl: permalink(event.channelId, event.messageTs) } });
  sideEffects.push('rejection_rearmed');
  try {
    await notion.appendCandidateNote({ pageId: candidate.pageId, sourceUrl: permalink(event.channelId, event.messageTs),
      text: `${iso(clock()).slice(0, 10)} · Rejection email re-armed by Project (his "go" in Slack, via Uncle Sam): scheduled for ${when(dueMs)} PT${basis === 'recorded' ? '' : `; interview end taken from ${basis === 'logged' ? 'the latest logged interview' : 'the time of his "go"'}`}.` });
  } catch { /* the re-arm is made and read back; the note is history */ }
  await forget();
  await reply(`🫡 Restarted. ${candidate.fullName}'s rejection email goes out ${dueMs <= clock() + 300_000 ? 'within a few minutes' : `at ${when(dueMs)} PT`}.`).catch(() => {});
  return { kind: 'rejection_rearmed', reason: null };
}
