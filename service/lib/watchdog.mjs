/**
 * Watchdog (Project, 2026-10-16: "if Uncle Sam's access to Google or Slack expires, or Notion keeps failing, it tells you right
 * away instead of quietly stopping"). Each tick:
 *  - Google: Project's grant is tried (a token refresh). Revoked or expired: Project is told at once in Slack (the connect link
 *    follows from gmail.mjs). Other errors: told after 30 minutes of failing.
 *  - Slack: the bot token is checked with auth.test every 10 minutes. Revoked, uninstalled or deactivated: Project is emailed at
 *    once from his own Gmail (Slack is the thing that is down). Other errors: after 30 minutes.
 *  - Notion and the run itself: three failed ticks in a row (about 15 minutes) and Project is told, with the reason.
 *  - A gap: no tick for 20 minutes or more (the scheduler stopped, or every run crashed): Project is told when runs resume, with
 *    how long, so he knows feedback prompts or messages may have come late.
 * One message when a problem starts, one when it clears. Nothing else; never throws.
 */
import { slackWire } from './slack-wire.mjs';
import { noticeStore } from './stuck-rejections.mjs';

export const SLACK_EVERY_MS = 10 * 60_000;
export const GOOGLE_EVERY_MS = 10 * 60_000;
export const SLOW_ALERT_MS = 30 * 60_000;
export const FAILED_TICKS = 3;
export const GAP_MS = 20 * 60_000;
const SLACK_DEAD = /^(invalid_auth|not_authed|token_revoked|token_expired|account_inactive|app_uninstalled|team_disabled|missing_scope)$/;
const GOOGLE_DEAD = /^(gmail_disconnected|gmail_not_connected)$/;
const pt = ms => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(ms);
const minutes = ms => { const m = Math.round(ms / 60_000); return m >= 120 ? `${Math.round(m / 60)} hours` : `${m} minutes`; };

export const TEXT = Object.freeze({
  googleLost: code => `🚨 I've lost access to your Google account (${code}). Until you reconnect I can't send rejection emails or invites, search your Sent mail, or read the team's calendars, so there are no feedback prompts and no schedule post. Use the Reconnect Google link I send you.`,
  googleFailing: code => `🚨 Google has been refusing me for 30 minutes (${code}). Rejection emails, invites and calendar reads are waiting. I'll keep trying and tell you when it's back.`,
  googleBack: '🫡 Google access is back. Everything that waited goes out on the next runs.',
  slackLostSubject: 'Uncle Sam: Slack access lost',
  slackLost: code => `Uncle Sam can't use Slack (${code}). Until it's fixed, no DMs, feedback prompts, schedule posts or replies reach anyone.\n\nFix: api.slack.com/apps/A09DDB3817C -> OAuth & Permissions -> Reinstall to Company AI. If the bot token changed, it has to go into Vercel (SLACK_BOT_TOKEN) too.\n\nUncle Sam`,
  slackFailingSubject: 'Uncle Sam: Slack failing',
  slackFailing: code => `Slack has been failing for Uncle Sam for 30 minutes (${code}). It keeps trying and will say when it's back.\n\nUncle Sam`,
  slackBack: '🫡 Slack is working for me again. Messages that waited go out on the next runs.',
  notionFailing: (n, code) => `🚨 My last ${n} runs failed (${code}), so nothing is moving: no prompts, no records, no emails. Most often this is Notion down or my access to it. I'll keep trying and tell you when it's back.`,
  notionBack: '🫡 My runs are working again.',
  gap: (from, to, ms) => `📋 I wasn't running from ${pt(from)} to ${pt(to)} PT (${minutes(ms)}). I'm caught up now; feedback prompts and messages from that window may have come late.`,
});

export async function runWatchdog({ env, db, tickResult, fetchImpl = globalThis.fetch, googleToken = null, googleConfigured = false, wasGoogleConnected = null,
  tellSlack = null, tellEmail = null, clock = Date.now, log = () => {} }) {
  const summary = { alerts: [], error: null };
  try {
    if (!db?.prepare || env?.UNCLE_SAM_WATCHDOG === 'off' || env?.UNCLE_SAM_AUTOMATIC_ACTIVITY !== 'enabled') return summary;
    // Mode Off or Test in Notion: Uncle Sam does nothing, the watchdog included. A failed run (mode unknown) is still watched.
    const mode = tickResult?.summary?.control?.mode ?? null;
    if (mode && mode !== 'Live') return summary;
    const live = mode === 'Live';
    const kv = noticeStore(db), now = clock();
    const say = async (check, text, via = 'slack', subject = null) => {
      summary.alerts.push(check);
      try {
        if (via === 'email' && tellEmail) await tellEmail(subject ?? 'Uncle Sam', text);
        else if (tellSlack) await tellSlack(text);
      } catch (error) {
        log(`uncle_sam_watchdog tell_failed check=${check} error=${error?.code ?? 'failed'}`);
        // Slack itself may be what's down: the same words by email instead.
        if (via !== 'email' && tellEmail) await tellEmail('Uncle Sam', text.replace(/<([^|>]+)\|([^>]+)>/g, '$2 ($1)')).catch(() => {});
      }
    };
    /** One problem's lifecycle: alert once when it starts (now, or after `after` ms), one line when it clears. */
    const track = async (check, failing, { code = '', after = 0, alert, back }) => {
      const key = `watchdog:${check}`;
      const state = await kv.get(key);
      if (!failing) {
        if (state?.alertedAt && back) await back();
        if (state) await kv.del(key);
        return;
      }
      const since = state?.since ?? now;
      if (!state) await kv.put(key, { since, code }, now);
      if (!state?.alertedAt && now - since >= after) { await kv.put(key, { since, code, alertedAt: now }, now); await alert(code); }
    };

    // A gap since the last tick.
    const last = await kv.get('watchdog:last-tick');
    await kv.put('watchdog:last-tick', { at: now }, now);
    if (last?.at && now - last.at >= GAP_MS) await say('gap', TEXT.gap(last.at, now, now - last.at));

    // Failed runs in a row.
    const failedTick = tickResult?.status === 'failed';
    const streak = failedTick ? ((await kv.get('watchdog:failed-ticks'))?.count ?? 0) + 1 : 0;
    if (failedTick) await kv.put('watchdog:failed-ticks', { count: streak, at: now }, now); else await kv.del('watchdog:failed-ticks');
    await track('runs', streak >= FAILED_TICKS, { code: String(tickResult?.reason ?? 'tick_failed').slice(0, 60),
      alert: code => say('runs', TEXT.notionFailing(streak, code)), back: () => say('runs_back', TEXT.notionBack) });

    // Slack: the bot token.
    const slackDue = now - ((await kv.get('watchdog:slack-checked'))?.at ?? 0) >= SLACK_EVERY_MS;
    if (live && slackDue && /^xoxb-/.test(env.SLACK_BOT_TOKEN ?? '')) {
      await kv.put('watchdog:slack-checked', { at: now }, now);
      let code = null;
      try {
        const response = await fetchImpl('https://slack.com/api/auth.test', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000), ...slackWire('auth.test', env.SLACK_BOT_TOKEN, {}) });
        const body = await response.json().catch(() => null);
        if (body?.ok !== true) code = String(body?.error ?? `http_${response.status}`).replace(/[^\w]/g, '').slice(0, 40);
      } catch { code = 'network'; }
      const dead = !!code && SLACK_DEAD.test(code);
      await track('slack', !!code, { code: code ?? '', after: dead ? 0 : SLOW_ALERT_MS,
        alert: c => (dead ? say('slack', TEXT.slackLost(c), 'email', TEXT.slackLostSubject) : say('slack', TEXT.slackFailing(c), 'email', TEXT.slackFailingSubject)),
        back: () => say('slack_back', TEXT.slackBack) });
    }

    // Google: Project's grant.
    if (live && googleConfigured && typeof googleToken === 'function') {
      const googleDue = now - ((await kv.get('watchdog:google-checked'))?.at ?? 0) >= GOOGLE_EVERY_MS;
      if (googleDue) {
        await kv.put('watchdog:google-checked', { at: now }, now);
        let code = null;
        try { await googleToken(); await kv.put('watchdog:google-ever', { at: now }, now); }
        catch (error) { code = typeof error?.code === 'string' ? error.code : 'google_failed'; }
        // Never connected yet is set-up, not an outage (gmail.mjs sends the connect link); only a lost grant is.
        const ever = wasGoogleConnected ?? !!(await kv.get('watchdog:google-ever'));
        const failing = !!code && !(code === 'gmail_not_connected' && !ever);
        const dead = !!code && GOOGLE_DEAD.test(code);
        await track('google', failing, { code: code ?? '', after: dead ? 0 : SLOW_ALERT_MS,
          alert: c => say('google', dead ? TEXT.googleLost(c) : TEXT.googleFailing(c)), back: () => say('google_back', TEXT.googleBack) });
      }
    }
    return summary;
  } catch (error) { return { ...summary, error: typeof error?.code === 'string' ? error.code : 'watchdog_failed' }; }
}
