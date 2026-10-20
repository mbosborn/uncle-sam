/**
 * Glue for the sourcing loop and outreach (sourcing.mjs, outreach.mjs, juicebox.mjs, unipile.mjs): builds their
 * dependencies from the bot's config, so the tick (vercel-handlers.mjs) and the Slack lanes (runtime.mjs) wire them the same way.
 */
import { noticeStore } from './stuck-rejections.mjs';
import { juiceboxEnabled, juiceboxSession, fetchLeads, detailsOf, createAgent, sendFeedback, juiceboxConnectText } from './juicebox.mjs';
import { unipileConfigured, createUnipileClient, linkedinReady, probeUnipile } from './unipile.mjs';
import { enqueueOutreach, outreachState, runOutreach } from './outreach.mjs';
import { runDailySourcing, runPostedBatches, SOURCING_CHANNEL } from './sourcing.mjs';
import { runClayProspecting, readPool, addToPool } from './clay-sourcing.mjs';
import { wrangleEnabled, wrangleSession, runWrangleSearch, resolvePeople, enrichEmail, savePicks, wrangleConnectText, wrangleSearchDone } from './wrangle.mjs';
import { laDate, laWall } from './takehome-nudge.mjs';
import { runTasteBackfill, historyState, startHistory } from './taste-history.mjs';
import { wisprConfigured, accessTokenOf, mcpSession, transcriptOf } from './wispr.mjs';
import { slackUserConfigured, masonConversationReader } from './slack-dm-watch.mjs';

/** Wrangle helpers that quietly do nothing until it's connected. */
export function wrangleDeps({ env, db, claude = null, fetchImpl = globalThis.fetch, clock = Date.now }) {
  if (!wrangleEnabled(env) || !db?.prepare) return { connected: async () => false, resolve: null, findEmail: null, save: null, saveShown: null };
  const connected = async () => !!(await noticeStore(db).get('wrangle:tokens'));
  const session = () => wrangleSession({ env, db, fetchImpl, clock });
  return {
    connected,
    resolve: async urls => ((await connected()) ? resolvePeople({ session: await session(), urls, claude }) : new Map()),
    findEmail: async person => ((await connected()) ? enrichEmail({ session: await session(), person, claude }) : null),
    save: async people => ((await connected()) ? savePicks({ db, session: await session(), people, claude, clock }) : { saved: 0 }),
    saveShown: async people => ((await connected()) ? savePicks({ db, session: await session(), people, claude, clock, collection: 'shown' }) : { saved: 0 }),
  };
}

export function sourcingDeps({ env, db, notion, claude = null, fetchImpl = globalThis.fetch, clock = Date.now }) {
  const on = juiceboxEnabled(env);
  const session = () => juiceboxSession({ env, db, fetchImpl, clock });
  return {
    juicebox: on ? session : null,
    leadsOf: (s, config) => fetchLeads({ session: s, source: config, claude, limit: 50 }),
    details: (s, person) => detailsOf({ session: s, person, claude }),
    inTracker: async slug => ((await notion?.findCandidatesByLinkedIn?.(slug)) ?? []).length > 0,
    connectText: on ? (force = false) => juiceboxConnectText({ env, db, fetchImpl, clock, force }) : null,
    createAgent: on ? async brief => createAgent({ session: await session(), brief, claude }) : null,
    feedback: on ? async text => {
      const config = (await noticeStore(db).get('sourcing:config')) ?? {};
      if (!config.agentId) return { sent: false };
      return sendFeedback({ session: await session(), agentId: config.agentId, feedback: text, claude });
    } : null,
  };
}

/** The outreach queue for a sourcing verdict, knowing which channels are live. */
export function enqueuer({ env, db, notion, gmail = null, claude = null, fetchImpl = globalThis.fetch, clock = Date.now }) {
  const wr = wrangleDeps({ env, db, claude, fetchImpl, clock });
  return async (person, ctx) => {
    const account = await linkedinReady({ env, db }).catch(() => null);
    const config = await outreachState(db).catch(() => ({}));
    const out = await enqueueOutreach({ env, db, notion, person, ctx, clock, channels: { linkedin: !!account, email: !!config.email && !!gmail } });
    if (out.status === 'queued') out.note = account ? (config.email && gmail ? 'LinkedIn and email' : 'LinkedIn') : 'email';
    // Saved in Wrangle too (best effort, never in the way).
    if (['queued', 'waiting'].includes(out.status) && wr.save) await wr.save([person]).catch(() => null);
    return out;
  };
}

/**
 * The tick's share: lists posted in #int-recruitment, the daily ten, the LinkedIn connection check, outreach.
 * masonPost(text, threadTs) -> ts; channelPost(channelId, threadTs, text) -> ts.
 */
export async function runSourcingTick({ env, db, notion, claude = null, gmail = null, clay = null, slackRead = null, masonPost, channelPost, fetchImpl = globalThis.fetch, clock = Date.now, log = () => {} }) {
  const out = {};
  if (env.UNCLE_SAM_AUTOMATIC_ACTIVITY !== 'enabled' || !db?.prepare) return { state: 'off' };
  const wr = wrangleDeps({ env, db, claude, fetchImpl, clock });
  const wrangleOn = await wr.connected().catch(() => false);
  try { out.posted = await runPostedBatches({ env, db, slackRead, channelId: env.UNCLE_SAM_SCHEDULE_CHANNEL || SOURCING_CHANNEL, clock, resolve: wrangleOn ? wr.resolve : null, claude }); } catch (error) { out.posted = { error: error?.code ?? 'failed' }; }
  // The history pass (taste-history.mjs): once on its own when sourcing starts, again on "learn from history".
  try {
    const kv = noticeStore(db), now = clock();
    const config = (await kv.get('sourcing:config')) ?? {};
    if (!(await historyState(db)) && (wrangleOn || config.brief || config.agentId) && await kv.claim('history:auto', { at: now }, now)) await startHistory({ db, clock });
    const st = await historyState(db);
    if (st && st.phase !== 'done') {
      out.history = await runTasteBackfill({ env, db, claude, slackRead, clock, log, channelId: env.UNCLE_SAM_SCHEDULE_CHANNEL || SOURCING_CHANNEL,
        budgetMs: Number(env.HISTORY_BUDGET_MS) || 120_000,
        poster: text => masonPost(text, null),
        // Project's DMs and group DMs with Robin or Alexis (his read-only grant), where many of the lists and picks are.
        dms: slackUserConfigured(env) ? () => masonConversationReader({ env, db, fetchImpl, clock }) : null,
        wrangle: wrangleOn ? () => wrangleSession({ env, db, fetchImpl, clock }) : null,
        resolve: wrangleOn ? ({ session, urls }) => resolvePeople({ session, urls, claude }) : null,
        wispr: wisprConfigured(env) ? async () => ({ session: await mcpSession({ fetchImpl, accessToken: (await accessTokenOf({ env, db, fetchImpl, now: clock() })).token }), transcriptOf }) : null });
    }
  } catch (error) { out.history = { error: error?.code ?? 'failed' }; }
  // Wrangle's morning search (wrangle.mjs): into the pool before the daily ten at 8:30.
  // Connected once and lapsed (a refused refresh): the sign-in link again, at most once a day.
  if (!wrangleOn && wrangleEnabled(env)) {
    try {
      const kv = noticeStore(db), now = clock();
      if (await kv.get('wrangle:as') && await kv.get('wrangle:everConnected') && await kv.claim(`wrangle:linkTold:${laDate(now)}`, { at: now }, now)) {
        const t = await wrangleConnectText({ env, db, fetchImpl, clock });
        if (t.status !== 'connected') await masonPost(`📋 Wrangle needs signing in again.\n${t.text}`, null);
      }
    } catch { /* tomorrow */ }
  }
  if (wrangleOn) { await noticeStore(db).put('wrangle:everConnected', { at: clock() }, clock()).catch(() => {}); try { out.wrangle = await runWrangleSearch({ env, db, notion, claude, fetchImpl, clock, log, addToPool, laDate, laWall, poster: text => masonPost(text, null) }); } catch (error) { out.wrangle = { error: error?.code ?? 'failed' }; } }
  // Clay's share of the pool (clay-sourcing.mjs): Project's target companies, a few a day.
  if (clay) { try { out.clay = await runClayProspecting({ env, db, clay, clock, log }); } catch (error) { out.clay = { error: error?.code ?? 'failed' }; } }
  try {
    const deps = sourcingDeps({ env, db, notion, claude, fetchImpl, clock });
    if (deps.juicebox || clay || wrangleOn) out.daily = await runDailySourcing({ env, db, notion, claude, poster: text => masonPost(text, null), threadPoster: (text, ts) => masonPost(text, ts), ...deps, poolLeads: () => readPool(db), saveShown: wrangleOn ? wr.saveShown : null, ready: wrangleOn ? () => wrangleSearchDone(db, laDate(clock())) : null, clock, log });
  } catch (error) { out.daily = { error: error?.code ?? 'failed' }; }
  let li = null, account = null;
  if (unipileConfigured(env)) {
    try { const probe = await probeUnipile({ env, db, fetchImpl, clock, poster: text => masonPost(text, null) }); account = probe.state === 'ok' ? probe.account : null; } catch { account = null; }
    if (account) li = createUnipileClient({ env, fetchImpl });
  }
  try { out.outreach = await runOutreach({ env, db, notion, claude, li, account, gmail, clay, findEmail: wrangleOn ? wr.findEmail : null, masonPost, channelPost, clock, log }); } catch (error) { out.outreach = { error: error?.code ?? 'failed' }; }
  return out;
}
