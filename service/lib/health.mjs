/**
 * The morning health check (Project, 2026-10-16, on an engineer friend's advice: "a daily health check ... to make sure all of
 * this stuff is working and message me if anything isn't in the morning").
 *
 * Once a day, on the first run after 7:00 Pacific, Uncle Sam checks itself and DMs Project only when something is wrong:
 *  - its runs: the 5-minute run and the 1-minute feedback run are still going; the Notion control row is Live;
 *  - its connections: Slack read access to Project's DMs (with files:read), Google (Gmail and calendars), DocuSign, Interviewer's
 *    Meet, Wispr; any problem the watchdog is still tracking;
 *  - each job ran recently (pipeline check, decision reminders, new bookings, work trials, DocuSign follow-ups, Stripe);
 *  - errors any job logged in the last 24 hours (collected from the run logs, by job), and Slack messages or taps that were
 *    picked up but never finished.
 * Only what Uncle Sam can't fix himself is reported (Project, 2026-10-18: "if everything is fine i dont need a message but
 * only message me if its something you cant auto fix"): a job whose errors stopped (it ran fine after its last failure, or
 * failed once more than 6 hours ago) fixed itself; a Slack message the sweep already closed and told him about is not
 * repeated; a send the Sent-mail check settles is never reported here.
 * All fine: no message (only a record that it ran). "health check" in Project's DM runs it at once and always answers.
 * Nothing here sends anything else, changes anything, or throws. UNCLE_SAM_HEALTH=off stops the morning message.
 */
import { noticeStore } from './stuck-rejections.mjs';
import { wisprStore } from './wispr.mjs';
import { docusignConnected } from './docusign-send.mjs';
import { meetConnected } from './meet.mjs';

export const HEALTH_HOUR = 7;
const DAY = 86400_000;
/** kv "…:last" heartbeats each job writes, with how old is too old. Jobs that never wrote one (not set up) are skipped. */
export const HEARTBEATS = Object.freeze([
  ['followups:last', 'The 1-minute feedback run', 15 * 60_000],
  ['watchdog:last-tick', 'The 5-minute run', 20 * 60_000],
  ['pipeline:last', 'The pipeline check', 3 * 3600_000],
  ['decision:last', 'Decision reminders', 3 * 3600_000],
  ['booking-new:last', 'New-booking checks', 3 * 3600_000],
  ['worktrial:last', 'Work-trial setup', 3 * 3600_000],
  ['docusign:followup:last', 'DocuSign follow-ups', 3 * 3600_000],
  ['docusign:catchup:last', 'DocuSign paperwork sync', 3 * 3600_000],
  ['stripe:last', 'Stripe payment checks', 6 * 3600_000],
  ['sourcing:last', 'The sourcing run (daily profiles, lists, outreach)', 30 * 60_000],
]);
const RECOVERED_AFTER = 6 * 3600_000;
/** Plain names for the jobs in the run logs (uncle_sam_<job>). */
const JOBS = Object.freeze({ tick: 'The 5-minute run', followups: 'The 1-minute feedback run', slack_dms: 'Reading your Slack DMs', gmail_notes: 'Gmail notes',
  replies: 'Candidate replies', wispr: 'Wispr meeting notes', recaps: 'Recaps in #int-recruitment', work_trials: 'Work-trial setup', onboarding: 'Account requests',
  decisions: 'Decision reminders', new_bookings: 'New bookings', docusign_catchup: 'DocuSign paperwork sync', paperwork: 'DocuSign follow-ups', clay: 'Clay lookups',
  stripe: 'Stripe payments', pipelines: 'The pipeline check', rejections: 'Rejection emails', rejection_confirm: 'Rejection email checks', meet: 'Meet attendance',
  interview_schedule: 'The schedule post', interview_preview: 'The morning interview list', schedule_preview: 'The evening preview', schedule_refresh: 'Schedule post edits',
  manual_rejects: 'Rejections by hand', directory: 'The Company directory', docusign: 'DocuSign', gmail_setup: 'Google access', watchdog: 'The watchdog', stale: 'Unfinished-work sweep',
  wispr_callback: 'Wispr connect', directory_probe: 'The Company directory', screenshot: 'LinkedIn screenshots',
  sourcing: 'The sourcing run', history: 'Learning from history', wrangle: 'Wrangle searches', wrangle_callback: 'Wrangle connect', offboarding: 'Offboarding', offboard_now: 'Offboarding on request', outreach: 'Outreach' });
const IGNORED_CODES = /^(not_due|no_time|baselined|skipped|tick_in_progress|in_progress)$/;

/** The job and error code in a log line that reports a failure, or null. */
export function failureOf(line) {
  const text = String(line ?? '');
  const job = /^uncle_sam_([a-z_]+)/.exec(text)?.[1];
  if (!job) return null;
  const code = /"error":"([^"]{1,80})"/.exec(text)?.[1] ?? /\berror=([\w:.-]{1,80})/.exec(text)?.[1]
    ?? (/status=failed/.test(text) ? (/reason=([\w:.-]{1,80})/.exec(text)?.[1] ?? 'failed') : null)
    ?? (/"state":"error"/.test(text) ? 'error' : null);
  if (!code || IGNORED_CODES.test(code)) return null;
  return { job, code };
}

/** The job a log line is from (uncle_sam_<job>), or null. */
export const jobOf = line => /^uncle_sam_([a-z_]+)/.exec(String(line ?? ''))?.[1] ?? null;

/**
 * Folds one run's log lines into kv: failures into health:job:<job> = { code, first, last, count } (24-hour window), and a
 * job that logged without failing into health:ok:<job> = { at } (once per job per run), so a job that recovered is known.
 */
export async function recordFailures(db, lines = [], now = Date.now()) {
  if (!db?.prepare || !lines.length) return 0;
  const kv = noticeStore(db);
  let n = 0;
  const fine = new Set();
  for (const line of lines) {
    const f = failureOf(line);
    if (!f) { const job = jobOf(line); if (job) fine.add(job); continue; }
    fine.delete(f.job);
    const key = `health:job:${f.job}`, was = await kv.get(key);
    const fresh = !was || now - was.last > DAY;
    await kv.put(key, { code: f.code, first: fresh ? now : was.first, last: now, count: fresh ? 1 : (was.count ?? 0) + 1, codes: [...new Set([...(fresh ? [] : was.codes ?? []), f.code])].slice(0, 5) }, now);
    n++;
  }
  for (const job of fine) await kv.put(`health:ok:${job}`, { at: now }, now).catch(() => {});
  return n;
}

const pt = ms => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(ms);
const ago = ms => { const m = Math.round(ms / 60_000); return m < 120 ? `${m} minutes` : `${Math.round(m / 60)} hours`; };
const laDate = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
const laHour = ms => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hourCycle: 'h23' }).format(ms));

/**
 * Every check, as { ok, problems: [line] }. `checks` carries what the caller knows how to test: { mode, slackDms, google,
 * docusign, meet, wispr } (each true, false, or undefined for "not set up"), and the db for the rest.
 */
export async function healthReport({ db, now = Date.now(), mode = null, connections = {} }) {
  const problems = [], kv = noticeStore(db);
  if (mode && mode !== 'Live') problems.push(`My Mode on the Notion control row is ${mode}, so I'm not acting on anything.`);
  const names = { slackDms: 'Read access to your Slack DMs', slackFiles: 'Reading screenshots in your DMs (files:read)', google: 'Your Google access (Gmail and calendars)',
    docusign: 'DocuSign access', meet: "Interviewer's Google Meet access", wispr: 'Wispr Flow access', okta: 'Okta access', juicebox: 'Juicebox (the daily profiles)', wrangle: 'Wrangle (the daily profiles)', linkedin: 'LinkedIn through Unipile' };
  for (const [key, label] of Object.entries(names)) if (connections[key] === false) problems.push(key === 'linkedin' ? 'No LinkedIn account is connected in Unipile yet: Accounts → Connect an account → LinkedIn in the Unipile dashboard.' : `${label} isn't connected. I'll send the link to reconnect; tap it when you see it.`);
  // Google answers but refuses admin lookups: Project's account lacks the role, which only a Workspace admin can give.
  if (connections.googleAdmin === false) problems.push("Google refuses my admin lookups (403), so I can't create or delete Company accounts. Your Google account needs the User Management Admin role (or Super Admin) in the admin console; until then accounts are by hand.");
  // Problems the watchdog is still tracking (it already told Project when they began).
  for (const check of ['google', 'slack', 'runs', 'notion']) {
    const state = await kv.get(`watchdog:${check}`);
    if (state?.since) problems.push(`${check === 'google' ? 'Google' : check === 'slack' ? 'Slack' : 'My runs'} has been failing since ${pt(state.since)} PT (${state.code || 'unknown'}).`);
  }
  for (const [key, label, maxAge] of HEARTBEATS) {
    const at = (await kv.get(key))?.at;
    if (Number.isFinite(at) && now - at > maxAge) problems.push(`${label} hasn't run for ${ago(now - at)} (last ${pt(at)} PT).`);
  }
  // Errors jobs logged in the last 24 hours.
  try {
    const { results = [] } = await db.prepare("SELECT name, value FROM uncle_sam_notices WHERE name LIKE 'health:job:%'").bind().all();
    for (const row of results) {
      let v; try { v = JSON.parse(row.value); } catch { continue; }
      if (!v?.last || now - v.last > DAY) continue;
      const job = String(row.name).slice('health:job:'.length);
      // Fixed itself: it ran fine after its last failure, or one failure long ago.
      const ok = (await kv.get(`health:ok:${job}`))?.at;
      if ((Number.isFinite(ok) && ok > v.last) || ((v.count ?? 1) === 1 && now - v.last > RECOVERED_AFTER)) continue;
      problems.push(`${JOBS[job] ?? job.replace(/_/g, ' ')} failed ${v.count === 1 ? 'once' : `${v.count} times`} in the last day, last at ${pt(v.last)} PT (${(v.codes ?? [v.code]).join(', ')}).`);
    }
  } catch { /* the other checks stand */ }
  // Slack messages and taps picked up but never finished (older than 30 minutes, in the last day).
  try {
    // Only ones still open: the sweep (stale-work.mjs) re-runs what it safely can and already told him about the rest.
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM uncle_sam_events WHERE status = 'Observed' AND observed_at >= ? AND observed_at <= ?`)
      .bind(now - DAY, now - 30 * 60_000).first();
    const n = Number(row?.n ?? 0);
    if (n > 0) problems.push(`${n} Slack message${n === 1 ? '' : 's'} or tap${n === 1 ? '' : 's'} from the last day never finished; I may not have answered ${n === 1 ? 'it' : 'them'}.`);
  } catch { /* the other checks stand */ }
  return { ok: problems.length === 0, problems };
}

export const reportText = ({ ok, problems }, { asked = false, now = Date.now() } = {}) => ok
  ? (asked ? `🩺 All checks pass (${pt(now)} PT): runs on time, connections up, no job errors in the last day.` : '')
  : `🩺 ${asked ? 'Health check' : 'Morning check'}: ${problems.length === 1 ? 'one thing I can\'t fix myself' : `${problems.length} things I can't fix myself`}.\n${problems.slice(0, 12).map(p => `🎖️ ${p}`).join('\n')}`;

/** Once a day after 7:00 Pacific: the report, to Project only when something is wrong. */
export async function runMorningHealth({ env = {}, db, poster, mode = null, connections = {}, clock = Date.now }) {
  const now = clock();
  if (env.UNCLE_SAM_HEALTH === 'off' || !db?.prepare || laHour(now) < HEALTH_HOUR) return { state: 'not_due' };
  if (!(await noticeStore(db).claim(`health:morning:${laDate(now)}`, { at: now }, now))) return { state: 'done_today' };
  let conn = {};
  try { conn = typeof connections === 'function' ? await connections() : connections; } catch { conn = {}; }
  const report = await healthReport({ db, now, mode, connections: conn });
  await noticeStore(db).put(`health:morning:${laDate(now)}`, { at: now, ok: report.ok, problems: report.problems.length }, now);
  if (report.ok || typeof poster !== 'function') return { state: report.ok ? 'ok' : 'problems', problems: report.problems.length };
  try { await poster(reportText(report, { now })); } catch { return { state: 'tell_failed', problems: report.problems.length }; }
  return { state: 'told', problems: report.problems.length };
}

/** What each connection looks like right now: true, false, or undefined when it isn't set up here. */
/**
 * Whether Google lets Uncle Sam look up a user as an admin (for offboarding): true, false on a 401/403, undefined when the
 * admin grant isn't there or Google didn't answer clearly. Read-only.
 */
export async function googleAdminWorks({ granted, admin, email = 'project@company.example' }) {
  try { if (!(await granted())) return undefined; } catch { return undefined; }
  try { const a = await admin(); if (!a?.get) return undefined; await a.get(email); return true; }
  catch (error) { return /_http_40[13]$/.test(String(error?.code ?? '')) ? false : undefined; }
}

export async function connectionsOf({ db, configured = {}, google = undefined, googleAdmin = undefined }) {
  const out = {};
  const get = async fn => { try { return await fn(); } catch { return undefined; } };
  if (configured.slackDms) {
    const record = await get(() => wisprStore(db).get('slack-user:tokens'));
    if (record !== undefined) { out.slackDms = !!record; if (record) out.slackFiles = (record.scopes ?? []).includes('files:read'); }
  }
  if (configured.docusign) out.docusign = await get(() => docusignConnected({ db }));
  if (configured.meet) out.meet = await get(() => meetConnected({ db, email: 'quinn@company.example' }));
  if (configured.wispr) out.wispr = await get(async () => !!(await wisprStore(db).get('tokens')));
  // Juicebox: only once it's in use (a source is set) does a lapsed sign-in count as a problem.
  if (configured.juicebox) out.juicebox = await get(async () => { const s = noticeStore(db); const c = await s.get('sourcing:config'); if (!c?.agentId && !c?.projectId) return undefined; return !!(await s.get('juicebox:tokens')); });
  if (configured.wrangle) out.wrangle = await get(async () => { const s = noticeStore(db); if (!(await s.get('wrangle:as'))) return undefined; return !!(await s.get('wrangle:tokens')); });
  if (configured.linkedin) out.linkedin = await get(async () => { const p = await noticeStore(db).get('linkedin:probe'); return p ? !!p.ok : undefined; });
  if (configured.okta) out.okta = await get(async () => { const p = await noticeStore(db).get('okta:probe'); return p ? !!p.ok : undefined; });
  if (google !== undefined) out.google = await Promise.resolve(google).catch(() => undefined);
  if (googleAdmin !== undefined) out.googleAdmin = await Promise.resolve(googleAdmin).catch(() => undefined);
  return out;
}

export const looksLikeHealthAsk = text => /^\s*(?:<@[A-Z0-9]+(?:\|[^>]*)?>\s*)?(?:run (?:a |the )?)?(?:health ?check|status check|self[- ]check|are you (?:ok|okay|working|healthy))\s*[?.!]*\s*$/i.test(String(text ?? '').replace(/\s*\*?Sent using\*?[\s\S]*$/i, ''));
