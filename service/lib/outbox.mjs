/**
 * Uncle Sam's outbox (Project, 2026-10-15: "if Uncle Sam messages me it should literally be Uncle Sam messaging me").
 * Project's scheduled Claude tasks (the daily to-do list, the internal hiring tracker, the clerk's failure notes) can only post
 * as Project. They post into the private channel #uncle-sam-outbox (UNCLE_SAM_OUTBOX_CHANNEL), where only Project and the bot
 * are members; each tick, Uncle Sam re-posts every new top-level message Project wrote there into Project's DM with the bot, as
 * itself, once. Nobody else's message is relayed, and nothing goes anywhere but Project's DM.
 */
import { masonPoster } from './wispr.mjs';
import { noticeStore, MASON_ID, withoutFooter } from './stuck-rejections.mjs';

export const outboxChannelOf = env => (/^[CG][A-Z0-9]+$/.test(String(env.UNCLE_SAM_OUTBOX_CHANNEL ?? '').trim()) ? String(env.UNCLE_SAM_OUTBOX_CHANNEL).trim() : null);
/** The Slack connector Project's tasks use signs each post "Sent using @Claude"; that footer is dropped when Uncle Sam re-posts. */
export { withoutFooter };
const tsOf = ms => `${Math.floor(ms / 1000)}.000000`;
const later = (a, b) => Number(a) > Number(b);

/** One tick. Never throws; returns { relayed, error }. The first run starts from an hour ago, never further back. */
export async function relayOutbox({ env, db, slackRead, routeMap, fetchImpl = globalThis.fetch, clock = Date.now, log = () => {} }) {
  const summary = { relayed: 0, error: null };
  try {
    const channelId = outboxChannelOf(env);
    if (!channelId || env.UNCLE_SAM_AUTOMATIC_ACTIVITY !== 'enabled' || !slackRead || !routeMap?.project?.channelId || !db?.prepare) return summary;
    const store = noticeStore(db);
    const cursor = (await store.get('outbox:cursor'))?.ts ?? tsOf(clock() - 3600_000);
    const messages = await slackRead.readHistory({ channelId, oldest: cursor, limit: 50, pages: 2, maxText: 39000 });
    const post = masonPoster({ env, fetchImpl, channelId: routeMap.project.channelId });
    let last = cursor;
    for (const m of messages) {
      if (!later(m.ts, cursor)) continue;
      const mine = m.user === MASON_ID && !m.botId && !m.subtype && !m.threadTs && String(m.text ?? '').trim();
      if (mine && !(await store.get(`outbox:${m.ts}`))) {
        await post(withoutFooter(m.text));
        await store.put(`outbox:${m.ts}`, { at: clock() }, clock());
        summary.relayed++;
      }
      last = later(m.ts, last) ? m.ts : last;
      await store.put('outbox:cursor', { ts: last }, clock());
    }
    if (last === cursor && !(await store.get('outbox:cursor'))) await store.put('outbox:cursor', { ts: cursor }, clock());
    return summary;
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'outbox_failed';
    log(`uncle_sam_outbox error=${code}`);
    return { ...summary, error: code };
  }
}
