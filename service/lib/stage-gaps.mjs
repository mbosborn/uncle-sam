/**
 * Things that fell through (Project, 2026-10-16, on Logan Wells: "how was this guy missing the take home? thats another blatant
 * miss and trackers should be added for that"). Logan sat at Case Study on the tracker for two days with no take-home sent,
 * and Robin's feedback question about his intro was never answered.
 *
 * Every two hours, 8 AM to 8 PM Pacific, Uncle Sam looks for:
 *  1. Take-home gaps: someone open (not closed, not On Hold) at Stage Case Study, whose take-home never went out: no scorecard on
 *     Interviewer's site, no take-home invite from Uncle Sam, and none in Project's Sent mail in the last 30 days (when it can search
 *     it). Project gets one line: "Reply send here and I'll send it", and that reply sends it (project-commands.mjs).
 *  2. Unanswered calls: an interviewer's feedback question that has gone unanswered for a business day while the candidate is
 *     still open. Project gets one line naming who and when; "take-home" in reply sends the take-home, anything else (reject,
 *     hold, next round) is read the usual way.
 * Each person (and each feedback question) is raised once. At most 5 lines a run. UNCLE_SAM_STAGE_GAPS=off stops it.
 */
import { noticeStore } from './stuck-rejections.mjs';
import { displayName } from './qa.mjs';

export const EVERY_MS = 2 * 3600_000;
export const MAX_PER_RUN = 5;
const CLOSED = ['Not Selected', 'Withdrawn or Unavailable', 'Hired'];
const NAMES = { U0A4F08721B: 'Robin', U030A09DBFF: 'Interviewer', U0476A5BC82: 'Alexis', U0BF89D1279: 'AA', U0F9EF97D89: 'Project' };
const pt = (ms, opts) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', ...opts }).format(ms);
const hourOf = ms => Number(pt(ms, { hour: 'numeric', hourCycle: 'h23' }));
const businessHoursBetween = (from, to) => { let n = 0; for (let t = from; t < to; t += 3600_000) { const d = pt(t, { weekday: 'short' }); if (d !== 'Sat' && d !== 'Sun') n++; } return n; };
const link = c => `<${c.url}|${displayName(c.fullName)}>`;

export const takeHomeGapText = c => `📋 ${link(c)} is at Case Study on the tracker, but no take-home ever went out: none from me, none in your Sent mail, nothing on Interviewer's site. Reply “send” here and I'll send it with Interviewer cc'd, or ignore this if it isn't needed.`;
export const unansweredText = ({ c, who, askedAt, roleRound }) => `📋 ${who} hasn't answered about ${link(c)} (${String(roleRound ?? 'interview').slice(0, 80)}; asked ${pt(askedAt, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} PT). Reply here with the call: “take-home” sends it; “reject”, “hold” or “next round” I record as usual.`;

export async function runStageGaps({ env = {}, db, notion, gmail = null, poster, channelId, clock = Date.now, log = () => {} }) {
  const summary = { state: 'off', takeHome: 0, unanswered: 0, error: null };
  try {
    if (env.UNCLE_SAM_STAGE_GAPS === 'off' || !db?.prepare || typeof poster !== 'function' || !channelId || typeof notion?.listActiveCandidates !== 'function') return summary;
    const kv = noticeStore(db), now = clock(), h = hourOf(now);
    if (h < 8 || h >= 20) return { ...summary, state: 'quiet_hours' };
    const last = (await kv.get('stage-gaps:last'))?.at ?? 0;
    if (now - last < EVERY_MS) return { ...summary, state: 'not_due' };
    await kv.put('stage-gaps:last', { at: now }, now);
    summary.state = 'ran';
    let told = 0;
    const tell = async (claimKey, text, ask) => {
      if (told >= MAX_PER_RUN || !(await kv.claim(claimKey, { at: now }, now))) return false;
      const ts = await poster(text);
      if (ts) await kv.put(`takehome-ask:${channelId}:${ts}`, { at: now, ...ask }, now);
      told++;
      return true;
    };
    const everyone = (await notion.listActiveCandidates({ includeProceeding: true }))
      .filter(c => !c.archived && !CLOSED.includes(c.fields?.Outcome) && c.fields?.Outcome !== 'On Hold');
    // 2. Unanswered feedback questions (a business day or more).
    const { results = [] } = await db.prepare(`SELECT request_key, candidate_id, created_at, recipient_ids_json, payload_json FROM uncle_sam_requests
      WHERE action = 'interview.feedback_request' AND state = 'Sent' AND created_at >= ? AND created_at <= ?`).bind(now - 10 * 86400_000, now - 24 * 3600_000).all();
    for (const row of results) {
      if (businessHoursBetween(Number(row.created_at), now) < 24) continue;
      const c = everyone.find(x => x.pageId === String(row.candidate_id).toLowerCase());
      if (!c) continue;
      let payload = {}, ids = [];
      try { payload = JSON.parse(row.payload_json); ids = JSON.parse(row.recipient_ids_json); } catch { /* names below */ }
      const who = ids.map(id => NAMES[id] ?? 'The interviewer').join(' and ') || 'The interviewer';
      const facts = { pageId: c.pageId, fullName: c.fullName, email: c.email ?? null };
      if (await tell(`gap:feedback:${row.request_key}`, unansweredText({ c, who, askedAt: Number(row.created_at), roleRound: payload.roleRound }), { who: facts })) summary.unanswered++;
    }
    // 1. Take-home gaps.
    for (const c of everyone.filter(x => x.fields?.Stage === 'Case Study')) {
      if (told >= MAX_PER_RUN) break;
      if ((await kv.get(`gap:takehome:${c.pageId}`))) continue;
      let card = null, invites = [];
      try { card = await notion.findTakeHomeScorecard(c.pageId); invites = await notion.findOperationsForCandidate({ candidatePageId: c.pageId, action: 'email.takehome_invite' }); }
      catch { continue; }
      if (card || invites.length) continue;
      if (c.email && gmail?.searchSent) {
        let sent = [];
        try { sent = await gmail.searchSent(`to:${c.email} ("Take-Home Assessment" OR "Research Take-Home" OR "Next Steps") newer_than:30d`); } catch { sent = []; }
        if (sent.length) { await kv.put(`gap:takehome:${c.pageId}`, { at: now, sentByHand: true }, now); continue; }
      }
      const facts = { pageId: c.pageId, fullName: c.fullName, email: c.email ?? null };
      if (await tell(`gap:takehome:${c.pageId}`, takeHomeGapText(c), { who: facts })) summary.takeHome++;
    }
    return summary;
  } catch (error) {
    summary.error = typeof error?.code === 'string' ? error.code : 'stage_gaps_failed';
    log(`uncle_sam_stage_gaps ${JSON.stringify(summary)}`);
    return summary;
  }
}
