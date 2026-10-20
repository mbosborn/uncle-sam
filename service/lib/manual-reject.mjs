/**
 * A take-home or deep dive marked Reject by hand on the Take-homes tab is a rejection (Project, 2026-10-16: "I moved it to
 * reject... the reject email should be queued... the same 30-minute delay should be on").
 *
 *  - Each tick: scorecards whose Take-home review or Deep dive is Reject. Rows Uncle Sam set itself while a rejection
 *    confirmation is pending (Interviewer's "Do not advance") are left to that confirmation step.
 *  - New one: Project is told at once in his DM; nothing is changed for 30 minutes. Setting the field back in Notion within
 *    those 30 minutes stands it down.
 *  - After 30 minutes, still Reject and the candidate still open: recorded Not Selected (Stage Closed) with the take-home's
 *    submission as the last completed step, so Uncle Sam's rejection sender sends the usual email (24 hours after the
 *    submission at the earliest, Sent mail checked first, Rejection email hold respected).
 *  - Rows already Reject when this first runs are never acted on. Live only; never retried; never throws.
 */
import { noticeStore } from './stuck-rejections.mjs';

export const HOLD_MS = 30 * 60_000;
const PREFIX = 'manual-reject:';
const day = ms => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', year: 'numeric' }).format(ms);
const when = ms => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(ms);
const plainName = full => String(full ?? '').replace(/\([^)]*\)/g, ' ').replace(/[^\p{L}\p{M}\s'.-]/gu, ' ').replace(/\s+/g, ' ').trim();
const fieldOf = card => (card.takeHomeReview === 'Reject' ? 'take-home' : 'deep dive');

export async function runManualRejects({ env, db, notion, store = null, poster = null, clock = Date.now, log = () => {} }) {
  const summary = { state: 'off', seen: 0, held: 0, closed: 0, stood_down: 0, error: null };
  try {
    if (env?.UNCLE_SAM_AUTOMATIC_ACTIVITY !== 'enabled' || env?.UNCLE_SAM_MANUAL_REJECTS === 'off' || !db || typeof notion?.listStageRejects !== 'function') return summary;
    if ((await notion.readControl())?.mode !== 'Live') return { ...summary, state: 'not_live' };
    summary.state = 'ran';
    const kv = noticeStore(db), now = clock();
    const cards = (await notion.listStageRejects()).filter(c => c.candidateIds?.length === 1);
    summary.seen = cards.length;
    // First run: what is already Reject is history.
    if (!(await kv.get(`${PREFIX}baseline`))) {
      for (const card of cards) await kv.put(`${PREFIX}${card.pageId}`, { baseline: true, at: now }, now);
      await kv.put(`${PREFIX}baseline`, { at: now, count: cards.length }, now);
      return { ...summary, state: 'baselined' };
    }
    const tell = async text => { if (poster) await poster(text).catch(() => {}); };
    const current = new Set(cards.map(c => c.pageId));
    // Set back within the 30 minutes: stand down.
    for (const name of await kv.names(PREFIX)) {
      if (name === `${PREFIX}baseline`) continue;
      const cardId = name.slice(PREFIX.length);
      const state = await kv.get(name);
      if (state?.heldAt && !state.done && !state.stoodDown && !current.has(cardId)) {
        await kv.put(name, { ...state, stoodDown: now }, now);
        summary.stood_down++;
        await tell(`🫡 Stood down: ${state.name}'s ${state.field} is no longer Reject, so no rejection.`);
      }
    }
    for (const card of cards) {
      const key = `${PREFIX}${card.pageId}`;
      let state = await kv.get(key);
      if (state?.baseline || state?.done || state?.skipped) continue;
      if (state?.stoodDown) state = null; // set to Reject again: a new 30 minutes
      const candidate = await notion.getCandidate(card.candidateIds[0]).catch(() => null);
      if (!candidate || candidate.archived) { await kv.put(key, { skipped: 'no_candidate', at: now }, now); continue; }
      const name = plainName(candidate.fullName) || 'This candidate';
      const closed = ['Not Selected', 'Withdrawn or Unavailable', 'Hired'].includes(candidate.fields?.Outcome) || ['Closed', 'Hired'].includes(candidate.fields?.Stage);
      if (closed) { await kv.put(key, { skipped: 'already_closed', at: now }, now); continue; }
      if (!state) {
        // Uncle Sam's own Reject (Interviewer's "Do not advance") waits for the person who confirms rejections.
        if (store?.listRequestsForCandidate) {
          const requests = await store.listRequestsForCandidate({ candidateId: candidate.pageId, limit: 30 }).catch(() => []);
          const madeAt = r => (typeof r.createdAt === 'number' ? r.createdAt : Date.parse(r.createdAt ?? ''));
          if (requests.some(r => r.action === 'rejection.confirmation_request' && !(now - madeAt(r) > 14 * 86400_000))) {
            await kv.put(key, { skipped: 'confirmation_pending', at: now }, now); continue;
          }
        }
        await kv.put(key, { heldAt: now, name, field: fieldOf(card) }, now);
        summary.held++;
        await tell(`📋 ${name}'s ${fieldOf(card)} is marked Reject on the Take-homes tab. In 30 minutes I record them Not Selected and the rejection email follows from your account. Set it back before ${when(now + HOLD_MS)} PT to stop it.`);
        continue;
      }
      if (!state.heldAt || now - state.heldAt < HOLD_MS) continue;
      // 30 minutes passed, still Reject, still open: record the rejection once.
      await kv.put(key, { ...state, done: now }, now); // before the write: an unclear result is never retried
      const submitted = Date.parse(card.submittedAt ?? '');
      const at = Number.isFinite(submitted) && submitted <= now ? submitted : state.heldAt;
      const sourceUrl = card.url && /^https:/.test(card.url) ? card.url : 'https://www.notion.so';
      try {
        await notion.closeCandidate({ pageId: candidate.pageId, expectedEmail: candidate.email, outcome: 'Not Selected',
          nextAction: `None. Not selected (${state.field} marked Reject on the Take-homes tab, ${day(state.heldAt)}). Uncle Sam sends the rejection email.`,
          interviewEnd: { at: new Date(at).toISOString(), sourceUrl } });
        summary.closed++;
        await notion.appendCandidateNote({ pageId: candidate.pageId, sourceUrl,
          text: `${day(now)} · Not Selected (via Uncle Sam): ${state.field} marked Reject on the Take-homes tab and left for 30 minutes. Last completed step recorded as the ${Number.isFinite(submitted) ? 'take-home submission' : 'Reject itself'} at ${when(at)} PT.` }).catch(() => null);
        const due = Math.max(now, at + 24 * 3600_000);
        await tell(`🫡 ${name} is marked Not Selected. The rejection email goes out ${due <= now + 600_000 ? 'within a few minutes' : `after ${when(due)} PT`}, unless Rejection email hold is set on their record.`);
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : 'close_failed';
        await kv.put(key, { ...state, done: now, error: code }, now);
        log(`uncle_sam_manual_reject close_failed card=${card.pageId.slice(0, 8)} error=${code}`);
        await tell(`🚨 Project, I need YOU on this one: I could not record ${name} as Not Selected (${code}). Do it by hand; I won't try again.`);
      }
    }
    return summary;
  } catch (error) { return { ...summary, error: typeof error?.code === 'string' ? error.code : 'manual_rejects_failed' }; }
}
