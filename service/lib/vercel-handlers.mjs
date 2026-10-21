/**
 * Vercel entry points for Uncle Sam: the five HTTP handlers behind api/*.js, built from the same
 * composition root (createRuntime) the previous Worker used. Nothing here decides policy; it only
 * adapts Vercel's runtime (process.env, waitUntil, Turso, Vercel Cron) to the unchanged modules.
 *
 *   slackEvents     POST /api/slack/events     signed Slack Events API deliveries
 *   notionWebhook   POST /api/notion/webhook   Notion webhook (verification handshake + signed events)
 *   portalWebhook   POST /api/portal/webhook   take-home portal uploads (x-uncle-sam-secret)
 *   health          GET  /api/health           configuration booleans only, never values
 *   tick            GET  /api/cron/tick        Vercel Cron (Authorization: Bearer $CRON_SECRET)
 *   followups       GET  /api/cron/followups   Vercel Cron, every minute: interview follow-ups 3 minutes after the call
 *   docusignCallback GET /api/docusign/callback DocuSign sign-in redirect for Uncle Sam's resends (one-use state, Project only)
 *   wisprCallback   GET  /api/wispr/callback   Wispr Flow sign-in redirect (one-use state from Project's connect link)
 *   payoutSetup     GET/POST /api/payout   a trialer's payout setup link: country, then Stripe's onboarding (payout-setup.mjs)
 *   googleCallback  GET  /api/google/callback  Google sign-in redirect for Uncle Sam's Gmail sending (one-use state, Project only)
 *   slackUserCallback GET /api/slack/user-callback  Slack sign-in redirect for reading Project's team DMs (one-use state, Project only)
 *   docusignConnect POST /api/docusign/connect  DocuSign Connect envelope events (HMAC-signed), for the tracker's Paperwork field
 */
import { createRuntime, describeConfiguration, llmSettingsOf, routesFromMap, runScheduled } from './runtime.mjs';
import { createClaudeClient } from './anthropic.mjs';
import { createSlackIngress } from './slack-ingress.mjs';
import { createInteractionHandler } from './slack-interactions.mjs';
import { createSlackUi } from './slack-ui.mjs';
import { handleNotionWebhook, handlePortalWebhook } from './webhooks.mjs';
import { constantTimeSecretEqual } from './protocol.mjs';
import { questionsEnabled } from './qa.mjs';
import { createLibsqlD1 } from './libsql-d1.mjs';
import { createTursoClient } from './turso.mjs';
import { APP_ID, TEAM_ID } from './identity.mjs';
import { completeConnection, masonPoster, runWispr, wisprConfigured } from './wispr.mjs';
import { completeGmailConnection, gmailConfigured, runGmailConnect, createGmailSender, gmailConnected, gmailFullyConnected, calendarGranted, calendarWriteGranted, googleTokenProvider, adminUserGranted } from './gmail.mjs';
import { runOffboarding } from './offboarding.mjs';
import { runPendingFinds } from './person-finder.mjs';
import { runWatchdog } from './watchdog.mjs';
import { jobOf, recordFailures, runMorningHealth, connectionsOf, googleAdminWorks } from './health.mjs';
import { runStageGaps } from './stage-gaps.mjs';
import { runDocumentsSync } from './docusign-documents.mjs';
import { runCheckinGuard, readCheckinConstraints, looksLikeCheckinTalk } from './checkins.mjs';
import { runFirstCheckinConfirmations, FIRST_CHECKIN_VERSION } from './first-checkin-confirmation.mjs';
import { THREAD_IDENTITY_VERSION } from './thread-identity.mjs';
import { runCheckinForecast } from './checkin-plan.mjs';
import { JOINT_CHECKIN_VERSION } from './checkin-joint-plan.mjs';
import { oktaConfigured, createOktaClient, probeOkta } from './okta.mjs';
import { insightfulConfigured, createInsightfulClient, probeInsightful } from './insightful.mjs';
import { runSourcingTick } from './sourcing-wire.mjs';
import { runTrialTerms } from './trial-terms.mjs';
import { noticeStore } from './stuck-rejections.mjs';
import { juiceboxAuth, juiceboxEnabled, juiceboxSession, toolCheckText } from './juicebox.mjs';
import { wrangleAuth, wrangleEnabled, wrangleSession, wrangleToolCheck, wrangleCredits } from './wrangle.mjs';
import { unipileConfigured, webhookAuthentic, linkedinReady, createUnipileClient } from './unipile.mjs';
import { runTrialLocations } from './trial-location.mjs';
import { handleUnipileEvent } from './outreach.mjs';
import { findDecisions, applyMeetingDecisions, decisionsMessage } from './meeting-decisions.mjs';
import { findMoves, proposeMoves, dropDone } from './meeting-moves.mjs';
import { runWorkTrials, ensureCheckins, clearClosedBanners, markFirstCheckins } from './work-trial.mjs';
import { runOnboarding, slackMembersAll } from './onboarding.mjs';
import { createDirectoryFinder, probeDirectory, createAddressOwners } from './directory.mjs';
import { runManualRejects } from './manual-reject.mjs';
import { runDecisionNudges } from './decision-nudges.mjs';
import { runNewBookings } from './new-bookings.mjs';
import { accountCreationWanted, accountCreationMissing, createWorkspaceAdmin } from './accounts.mjs';
import { runPipelineCheck } from './pipeline-check.mjs';
import { runClayPipelines, clayConfigured, createClayClient } from './clay-pipelines.mjs';
import { runRecapIntake, RECAP_ACK_VERSION } from './recap-intake.mjs';
import { applyRecapDecision } from './recap-decisions.mjs';
import { slackWire } from './slack-wire.mjs';
import { runStripePayments } from './stripe-payments.mjs';
import { runRejectionSender, rejectionSenderEnabled, confirmUnclearSends } from './rejection-sender.mjs';
import { runCalendarProbe } from './calendar-probe.mjs';
import { latestInterviewEnd } from './google-calendar.mjs';
import { runReplyWatch } from './reply-watch.mjs';
import { runGmailNotes, updateSantoshLink, wisprNotes } from './record-notes.mjs';
import { readAssignments, refreshSchedules, runInterviewSchedule, runEmailReschedules, SCHEDULE_CHANNEL, slackUpdate } from './interview-plan.mjs';
import { repairAaMessages } from './project-commands.mjs';
import { runTrialInvites } from './trial-invite.mjs';
import { runPayoutSetup, handlePayoutRequest } from './payout-setup.mjs';
import { runEmailQueue } from './email-queue.mjs';
import { parseTemplate } from './takehome-review.mjs';
import { runStuckRejections } from './stuck-rejections.mjs';
import { takeTickLease, releaseTickLease, FOLLOWUPS_LEASE, FOLLOWUPS_LEASE_TTL_MS } from './tick-lease.mjs';
import { runStaleSweep } from './stale-work.mjs';
import { PEOPLE } from './agent-runner.mjs';
import { completeDocusignConnection, docusignSendConfigured, docusignConnected, runDocusignConnect, runDocusignFetch, createDocusignSender, standardRate, factsOf } from './docusign-send.mjs';
import { runPreStartPaperwork } from './pre-start-paperwork.mjs';
import { runPaperworkFollowUps } from './paperwork-followup.mjs';
import { completeMeetConnection, isMeetState, meetConfigured, runMeetConnect, meetPeopleOf, probeMeet } from './meet.mjs';
import { relayOutbox } from './outbox.mjs';
import { applyConnectEvent, connectSignatureOk, docusignConfigured, reconcilePaperwork } from './docusign.mjs';
import { completeSlackUserConnection, runSlackDmWatch, slackUserConfigured, slackUserConnected } from './slack-dm-watch.mjs';

/** Time budgets sit well inside Vercel's 300 s default function limit (see vercel.json maxDuration). */
export const EVENT_BUDGET_MS = 180_000;
export const TICK_BUDGET_MS = 200_000;

const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value),
  { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const methodNotAllowed = allow => json({ error: 'method_not_allowed' }, 405, { allow });
const secretOk = value => typeof value === 'string' && value.length >= 16 && !/\s/.test(value);

/** The Turso database from env (see turso.mjs), wrapped in the D1-shaped surface the store expects. */
export async function openDatabase(env) {
  const client = await createTursoClient(env);
  return client ? createLibsqlD1(client) : null;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createVercelApp({ env = process.env, schedule, fetchImpl = globalThis.fetch, clock = Date.now,
  open = openDatabase, log = console.log, eventBudgetMs = EVENT_BUDGET_MS, tickBudgetMs = TICK_BUDGET_MS } = {}) {
  // Failures the jobs log during a run, kept by job for the morning health check (health.mjs).
  const healthLines = [];
  const writeLog = log;
  // Every job line is kept (failures and fine runs alike), so the check knows which failing jobs have since recovered.
  log = line => { try { if (jobOf(line)) { healthLines.push(String(line)); if (healthLines.length > 400) healthLines.splice(0, 200); } } catch { /* never */ } return writeLog(line); };
  let configured;
  const configure = () => (configured ??= (async () => {
    const DB = await open(env);
    return { ...env, ...(DB ? { DB } : {}) };
  })().catch(error => { configured = undefined; throw error; }));

  // Work scheduled after the response goes to Vercel's waitUntil; app.idle() lets tests wait for it.
  const background = new Set();
  const scheduleWork = promise => {
    const done = () => background.delete(promise);
    background.add(promise);
    promise.then(done, done);
    if (typeof schedule === 'function') schedule(promise);
  };
  const budgeted = input => ({ ...input, deadline: clock() + eventBudgetMs });

  const guarded = async (request, allow, handler) => {
    if (!allow.includes(request.method)) return methodNotAllowed(allow.join(', '));
    let config;
    try { config = await configure(); } catch { return json({ error: 'service_not_ready' }, 503); }
    if (!config.DB) return json({ error: 'service_not_configured' }, 503);
    try { return await handler(config); } catch { return json({ error: 'service_not_ready' }, 503); }
  };

  return Object.freeze({
    slackEvents: request => guarded(request, ['POST'], async config => {
      const runtime = createRuntime(config, { fetchImpl, clock });
      // The group DMs Uncle Sam opened for interviews taken together are workflow conversations too: typed answers there count.
      const allowedConversations = routesFromMap(runtime.routeMap);
      try {
        const opened = await runtime.groupRoutes?.load?.();
        allowedConversations.mpim = [...new Set([...allowedConversations.mpim, ...Object.values(opened ?? {}).map(r => r.channelId)])];
      } catch { /* the route map alone */ }
      return createSlackIngress({ env: config, store: runtime.store, schedule: scheduleWork, clock,
        wakeFactory: () => input => runtime.runner.runEvent(budgeted(input)),
        signatureConfig: { signingSecret: config.SLACK_SIGNING_SECRET, allowedAppIds: [APP_ID], allowedTeamIds: [TEAM_ID],
          botUserId: config.SLACK_BOT_USER_ID, allowedConversations, now: clock,
          questions: questionsEnabled(config) } })(request);
    }),

    /** Button clicks and form submissions (Slack Interactivity). Opens forms inline; records reports in the background. */
    slackInteractions: request => guarded(request, ['POST'], config => {
      const runtime = createRuntime(config, { fetchImpl, clock });
      return createInteractionHandler({ store: runtime.store, ui: createSlackUi({ env: config, fetchImpl }), schedule: scheduleWork, clock, log, fastOpen: true,
        run: input => runtime.runner.runEvent(budgeted(input)),
        verify: { signingSecret: config.SLACK_SIGNING_SECRET, allowedAppIds: [APP_ID], allowedTeamIds: [TEAM_ID], now: clock } })(request);
    }),

    notionWebhook: request => guarded(request, ['POST'], config => {
      const runtime = createRuntime(config, { fetchImpl, clock });
      return handleNotionWebhook(request, { secret: config.NOTION_WEBHOOK_SECRET, store: runtime.store, schedule: scheduleWork,
        run: input => runtime.runner.runEvent(budgeted(input)), log });
    }),

    portalWebhook: request => guarded(request, ['POST'], config => {
      const runtime = createRuntime(config, { fetchImpl, clock });
      return handlePortalWebhook(request, { secret: config.PORTAL_WEBHOOK_SECRET, store: runtime.store, schedule: scheduleWork,
        run: input => runtime.runner.runEvent(budgeted(input)) });
    }),

    /** DocuSign Connect (docusign.mjs): checked against the account's HMAC key, answered at once, applied in the background. */
    docusignConnect: request => guarded(request, ['POST'], async config => {
      if (!docusignConfigured(config)) return json({ error: 'not_configured' }, 503);
      const length = Number(request.headers.get('content-length') ?? 0);
      if (length > 1_000_000) return json({ error: 'too_large' }, 413);
      const body = await request.text();
      if (body.length > 1_000_000) return json({ error: 'too_large' }, 413);
      if (!(await connectSignatureOk({ body, headers: request.headers, key: config.DOCUSIGN_CONNECT_HMAC_KEY }))) return json({ error: 'unauthorized' }, 401);
      let event;
      try { event = JSON.parse(body); } catch { return json({ error: 'invalid_json' }, 400); }
      const runtime = createRuntime(config, { fetchImpl, clock });
      const channelId = runtime.routeMap?.project?.channelId;
      const work = (async () => {
        if ((await runtime.notion.readControl())?.mode !== 'Live') return log('uncle_sam_docusign skipped=not_live');
        const result = await applyConnectEvent({ event, db: config.DB, notion: runtime.notion, clock,
          poster: channelId ? masonPoster({ env: config, fetchImpl, channelId }) : null });
        log(`uncle_sam_docusign ${JSON.stringify(result).slice(0, 600)}`);
      })().catch(error => log(`uncle_sam_docusign error=${typeof error?.code === 'string' ? error.code : 'failed'}`));
      scheduleWork(work);
      return json({ ok: true });
    }),

    async health(request) {
      if (!['GET', 'HEAD'].includes(request.method)) return methodNotAllowed('GET, HEAD');
      let config = { ...env };
      try { config = await configure(); } catch { /* reported as databaseReachable:false below */ }
      const databaseReachable = config.DB
        ? await withTimeout(config.DB.prepare('SELECT 1 AS ok').first('ok'), 3000).then(value => value === 1, () => false)
        : false;
      const enabled = env.UNCLE_SAM_AUTOMATIC_ACTIVITY === 'enabled';
      // Whether Project's Gmail grant is in place (none / send / full, with the Sent-mail search); never the grant itself.
      let gmailGrant = 'none';
      if (databaseReachable && gmailConfigured(config)) {
        try { gmailGrant = (await gmailFullyConnected({ db: config.DB })) ? ((await calendarGranted({ db: config.DB })) ? ((await calendarWriteGranted({ db: config.DB })) ? 'full+calendar-write' : 'full+calendar') : 'full') : (await gmailConnected({ db: config.DB })) ? 'send' : 'none'; } catch { gmailGrant = 'unknown'; }
      }
      // Company's directory (read-only) for work-trial accounts: ok / waiting for the grant or the People API (directory.mjs).
      let directory = null;
      if (databaseReachable && gmailConfigured(config)) {
        try { const row = await config.DB.prepare('SELECT value FROM uncle_sam_notices WHERE name = ?').bind('directory:probe').first(); const p = row ? JSON.parse(row.value) : null; directory = p ? (p.ok ? 'ok' : p.reason ?? 'failed') : 'unchecked'; } catch { directory = 'unknown'; }
      }
      // The latest calendar probe as counts only (calendars readable / with guest lists visible), never names or events.
      let calendarProbe = null;
      if (databaseReachable) {
        try {
          const row = await config.DB.prepare('SELECT value FROM uncle_sam_notices WHERE name = ?').bind('calendar:probe').first();
          const probe = row ? JSON.parse(row.value) : null;
          if (probe?.calendars) calendarProbe = { calendars: probe.calendars.length, readable: probe.calendars.filter(c => c.ok).length,
            withGuestLists: probe.calendars.filter(c => c.ok && (c.withGuests > 0 || c.ended === 0)).length, at: new Date(probe.at).toISOString() };
        } catch { calendarProbe = null; }
      }
      // Unauthenticated: booleans only, never values.
      return json({ service: 'Uncle Sam', host: 'vercel', phase: enabled ? 'phase2-live' : 'setup', automaticActionsEnabled: enabled,
        documentChecker: { enabled: true, version: '2026-10-20.1', failureMode: 'block_send_and_resend' },
        jointCheckinVersion: JOINT_CHECKIN_VERSION, workTrialSafetyVersion: '2026-10-20.1', reliabilityVersion: '2026-10-20.2', candidateDiscoveryVersion: '2026-10-20.1', sourcingCalibrationVersion: '2026-10-20.1', firstCheckinVersion: FIRST_CHECKIN_VERSION, threadIdentityVersion: THREAD_IDENTITY_VERSION, recapAckVersion: RECAP_ACK_VERSION,
        // Account creation (accounts.mjs): 'ready' or what is still missing, in plain words.
        configuration: { ...describeConfiguration(config), cron: secretOk(env.CRON_SECRET), databaseReachable, ...(gmailConfigured(config) ? { gmailGrant, ...(directory ? { directory } : {}) } : {}),
          ...(gmailConfigured(config) && accountCreationWanted(config) ? { accountCreation: await accountCreationMissing({ env: config, db: config.DB, notion: createRuntime(config, { fetchImpl, clock }).notion }).then(m => (m.length ? m : 'ready')).catch(() => 'unknown'), slackJoinLink: /^https:\/\//.test(config.UNCLE_SAM_SLACK_JOIN_URL ?? '') ? (() => { try { const u = new URL(config.UNCLE_SAM_SLACK_JOIN_URL); return `${u.host}${u.pathname.slice(0, 40)}`; } catch { return 'invalid'; } })() : false } : {}),
          ...(slackUserConfigured(config) && config.DB ? { slackDms: (await slackUserConnected({ db: config.DB }).catch(() => null)) ? 'connected' : 'not connected' } : {}), ...(calendarProbe ? { calendarProbe } : {}) } });
    },

    async tick(request) {
      if (!['GET', 'POST'].includes(request.method)) return methodNotAllowed('GET, POST');
      if (!secretOk(env.CRON_SECRET)) return json({ error: 'cron_not_configured' }, 503);
      const supplied = /^Bearer ([^\s]+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
      if (!supplied || !(await constantTimeSecretEqual(supplied, env.CRON_SECRET))) {
        return json({ error: 'unauthorized' }, 401, { 'www-authenticate': 'Bearer' });
      }
      let config;
      try { config = await configure(); } catch { return json({ error: 'service_not_ready' }, 503); }
      if (!config.DB) return json({ error: 'service_not_configured' }, 503);
      const started = clock();
      // One tick at a time (Project, 2026-10-16: build fixes so the same DM never goes out twice): a lease in the database, taken
      // atomically; a tick that finds another one running steps aside. The lease outlasts the longest tick, so a tick that died
      // without letting go blocks the next ones for at most 6 minutes.
      const lease = await takeTickLease(config.DB, { now: started }).catch(() => null);
      if (!lease) { log('uncle_sam_tick status=skipped reason=tick_in_progress'); return json({ ok: true, status: 'skipped', reason: 'tick_in_progress' }); }
      try {
      const result = await runScheduled(config, { scheduledTime: started }, { log, fetchImpl, clock, deadline: started + tickBudgetMs });
      const summary = result.summary ?? {};
      // Watchdog (watchdog.mjs): lost Google or Slack access, failing runs and gaps are told to Project at once, never silently.
      try {
        const masonDmId = (() => { try { return createRuntime(config, { fetchImpl, clock }).routeMap?.project?.channelId ?? null; } catch { return null; } })();
        const mail = gmailConfigured(config) ? createGmailSender({ env: config, db: config.DB, fetchImpl, clock }) : null;
        const watch = await runWatchdog({ env: config, db: config.DB, tickResult: result, fetchImpl, clock, log,
          googleConfigured: gmailConfigured(config), googleToken: gmailConfigured(config) ? googleTokenProvider({ env: config, db: config.DB, fetchImpl, clock }) : null,
          tellSlack: masonDmId ? masonPoster({ env: config, fetchImpl, channelId: masonDmId }) : null,
          tellEmail: mail ? (subject, body) => mail.send({ to: 'project@company.example', subject, body }) : null });
        if (watch.alerts.length || watch.error) log(`uncle_sam_watchdog ${JSON.stringify(watch)}`);
      } catch { /* the watchdog never fails the tick */ }
      // Work a dead function left half-done (stale-work.mjs): run once more when nothing could have been sent, else told once.
      try {
        const masonDmId = (() => { try { return createRuntime(config, { fetchImpl, clock }).routeMap?.project?.channelId ?? null; } catch { return null; } })();
        const swept = await runStaleSweep({ db: config.DB, clock, log, poster: masonDmId ? masonPoster({ env: config, fetchImpl, channelId: masonDmId }) : null });
        if (swept.retried || swept.closed || swept.uncertain || swept.told || swept.error) log(`uncle_sam_stale ${JSON.stringify(swept)}`);
      } catch { /* never fails the tick */ }
      // DocuSign access for resends (docusign-send.mjs): the connect link to Project, once per link.
      if (docusignSendConfigured(config)) {
        try {
          const runtime = createRuntime(config, { fetchImpl, clock });
          const channelId = runtime.routeMap?.project?.channelId;
          const ds = channelId ? await runDocusignConnect({ env: config, db: config.DB, clock, poster: masonPoster({ env: config, fetchImpl, channelId }) }) : null;
          if (ds?.state === 'linked') log('uncle_sam_docusign link_sent');
          const fetched = await runDocusignFetch({ env: config, db: config.DB, clock, sender: ds?.state === 'connected' ? createDocusignSender({ env: config, db: config.DB, fetchImpl, clock }) : null });
          if (fetched) log(`uncle_sam_docusign fetch ${JSON.stringify(fetched)}`);
        } catch { /* never fails the tick */ }
      }
      // Google Meet links for the interviewers on UNCLE_SAM_MEET_PEOPLE (meet.mjs), to Project; one line when each connects.
      if (meetConfigured(config)) {
        try {
          const runtime = createRuntime(config, { fetchImpl, clock });
          const channelId = runtime.routeMap?.project?.channelId;
          const meetLinks = channelId ? await runMeetConnect({ env: config, db: config.DB, clock, poster: masonPoster({ env: config, fetchImpl, channelId }),
            people: meetPeopleOf(config, runtime.interviewerEmails, PEOPLE) }) : null;
          if (meetLinks && (meetLinks.linked.length || meetLinks.error)) log(`uncle_sam_meet ${JSON.stringify(meetLinks)}`);
          // A daily read of the last day's calls, so it is plain that Google answers and who it recognises.
          if (meetLinks?.connected.length && runtime.meet && runtime.calendar) {
            const probe = await probeMeet({ reader: runtime.meet, calendar: runtime.calendar, calendarIds: runtime.calendarIds, db: config.DB, clock });
            if (probe) log(`uncle_sam_meet_probe ${JSON.stringify(probe).slice(0, 1500)}`);
          }
        } catch { /* never fails the tick */ }
      }
      // Project's Wispr Flow meeting notes (wispr.mjs): its own step after the runner, never failing the tick.
      let wispr = { state: 'off' };
      if (wisprConfigured(config)) {
        try {
          const runtime = createRuntime(config, { fetchImpl, clock });
          const llm = llmSettingsOf(config);
          // A whole meeting transcript is a long read, so this one model call gets two minutes.
          const claude = llm ? createClaudeClient({ ...llm, fetchImpl, timeoutMs: 120_000 }) : null;
          wispr = await runWispr({ env: config, db: config.DB, notion: runtime.notion, claude, routeMap: runtime.routeMap,
            fetchImpl, clock, deadline: started + 280_000, log,
            onMeeting: async ({ meeting, transcript, candidates, rejectionNotes = [] }) => {
              let merged = false;
              if (started + 280_000 - clock() < 70_000) { log(`uncle_sam_wispr notes_skipped=no_time meeting=${meeting.id}`); return 0; }
              // Who takes which coming interview, as said in the meeting ("Interviewer takes all of tomorrow's").
              try {
                const assigned = await readAssignments({ db: config.DB, claude, runner: runtime.runner, text: transcript, source: `wispr:${meeting.id}`, context: `the recruiting meeting "${String(meeting.title ?? '').slice(0, 80)}"`, clock });
                log(`uncle_sam_wispr assignments meeting=${meeting.id.slice(0, 8)} count=${assigned.length} ${assigned.map(a => `${a.event.dedupe.slice(0, 10)}=${a.ids.length}`).join(',')}`);
              } catch (error) { log(`uncle_sam_wispr assignments_failed error=${typeof error?.code === 'string' ? error.code : 'failed'}${error?.reason ? ` reason=${String(error.reason).slice(0, 120)}` : ''}`); }
              // The meeting's moves as one list for Project to approve (meeting-moves.mjs, Project 2026-10-18): nothing changes until he says yes.
              if (config.UNCLE_SAM_MEETING_MOVES !== 'off') {
                try {
                  const roster = candidates ?? await runtime.notion.listActiveCandidates({ includeProceeding: true });
                  const raw = await findMoves({ claude, meeting, transcript, candidates: roster });
                  // Anything already done (Project often does it live) is left out; the meeting's rejection notes join the same message.
                  const { moves, done } = await dropDone({ found: raw, notion: runtime.notion });
                  const found = { moves, done, unclear: [...rejectionNotes.map(u => ({ heard_as: u.heard_as, quote: u.quote, reason: `rejection not recorded: ${u.reason}` })), ...raw.unclear] };
                  const masonChannel = runtime.routeMap?.project?.channelId ?? null;
                  const ts = masonChannel ? await proposeMoves({ db: config.DB, meeting, found, poster: masonPoster({ env: config, fetchImpl, channelId: masonChannel }), masonChannel, clock }) : null;
                  merged = !!ts || (!found.moves.length && !found.unclear.length);
                  log(`uncle_sam_wispr moves meeting=${meeting.id.slice(0, 8)} moves=${found.moves.length} done=${done.length} unclear=${found.unclear.length} posted=${!!ts}`);
                } catch (error) { log(`uncle_sam_wispr moves_failed error=${typeof error?.code === 'string' ? error.code : 'failed'}`); }
              } else try {
                // The old path (UNCLE_SAM_MEETING_MOVES=off): advance, hold and where people are based, applied quietly (meeting-decisions.mjs).
                const roster = candidates ?? await runtime.notion.listActiveCandidates({ includeProceeding: true });
                const found = await findDecisions({ claude, meeting, transcript, candidates: roster });
                const { applied, forMason } = await applyMeetingDecisions({ db: config.DB, notion: runtime.notion, meeting, found, clock });
                log(`uncle_sam_wispr decisions meeting=${meeting.id.slice(0, 8)} applied=${applied.map(a => a.kind).join(',') || '-'} for_mason=${forMason.length}`);
                const message = decisionsMessage(meeting, forMason);
                if (message && runtime.routeMap?.project?.channelId) await masonPoster({ env: config, fetchImpl, channelId: runtime.routeMap.project.channelId })(message).catch(() => {});
              } catch (error) { log(`uncle_sam_wispr decisions_failed error=${typeof error?.code === 'string' ? error.code : 'failed'}`); }
              const noted = await wisprNotes({ claude, notion: runtime.notion, meeting, transcript, candidates: candidates ?? await runtime.notion.listActiveCandidates({ includeProceeding: true }), clock });
              log(`uncle_sam_wispr notes meeting=${meeting.id.slice(0, 8)} count=${noted} transcript=${String(transcript ?? '').length}`);
              return { noted, merged };
            } });
          if (wispr.found || wispr.meetings || wispr.notes || wispr.error) log(`uncle_sam_wispr ${JSON.stringify(wispr).slice(0, 400)}`);
        } catch { wispr = { state: 'error' }; }
      }
      // Rejections the separate sender has paused for Project: tell him once each (stuck-rejections.mjs). Never fails the tick.
      try {
        const runtime = createRuntime(config, { fetchImpl, clock });
        await runStuckRejections({ env: config, db: config.DB, notion: runtime.notion, routeMap: runtime.routeMap, fetchImpl, clock, log });
        // Messages Project's scheduled tasks left in #uncle-sam-outbox, re-posted into his DM by Uncle Sam itself (outbox.mjs).
        await relayOutbox({ env: config, db: config.DB, slackRead: runtime.slackRead, routeMap: runtime.routeMap, fetchImpl, clock, log });
        // Uncle Sam's own Gmail sending: until Project grants it, a connect link in his DM (gmail.mjs).
        const channelId = runtime.routeMap?.project?.channelId;
        if (gmailConfigured(config) && channelId) {
          const gmail = await runGmailConnect({ env: config, db: config.DB, notion: runtime.notion, routeMap: runtime.routeMap,
            poster: masonPoster({ env: config, fetchImpl, channelId }), clock });
          if (gmail.state === 'error') log(`uncle_sam_gmail_setup error=${gmail.error}`);
        }
        // What Project's Google grant can see on the interview calendars, hourly, until the calendar source is switched (calendar-probe.mjs).
        if (gmailConfigured(config) && config.UNCLE_SAM_CALENDAR_SOURCE !== 'project') await runCalendarProbe({ env: config, db: config.DB, notion: runtime.notion, interviewerEmails: runtime.interviewerEmails, fetchImpl, clock, log });
        // Candidate replies in Project's inbox: a DM with a suggested next step and a note on the record (reply-watch.mjs).
        if (gmailConfigured(config) && runtime.routeMap?.project?.channelId) {
          const llm = llmSettingsOf(config);
          const replies = await runReplyWatch({ env: config, db: config.DB, notion: runtime.notion, gmail: createGmailSender({ env: config, db: config.DB, fetchImpl, clock }),
            claude: llm ? createClaudeClient({ ...llm, fetchImpl, timeoutMs: 30_000 }) : null,
            post: masonPoster({ env: config, fetchImpl, channelId: runtime.routeMap.project.channelId }), clock, log });
          if (replies.notified || replies.error) log(`uncle_sam_replies ${JSON.stringify(replies)}`);
          // Recruiting facts from emails with candidates become notes, and Interviewer's new deep-dive link goes on the board (record-notes.mjs).
          const mail = await runGmailNotes({ env: config, db: config.DB, notion: runtime.notion, gmail: createGmailSender({ env: config, db: config.DB, fetchImpl, clock }),
            claude: llm ? createClaudeClient({ ...llm, fetchImpl, timeoutMs: 60_000 }) : null,
            poster: masonPoster({ env: config, fetchImpl, channelId: runtime.routeMap.project.channelId }), clock, log });
          if (mail.notes || mail.santoshLink || mail.error) log(`uncle_sam_gmail_notes ${JSON.stringify(mail)}`);
        }
        // Project's Slack DMs and group DMs with the team: recruiting facts become notes (slack-dm-watch.mjs, Project 2026-10-15).
        if (slackUserConfigured(config) && runtime.routeMap?.project?.channelId) {
          const llm = llmSettingsOf(config);
          const dms = await runSlackDmWatch({ env: config, db: config.DB, notion: runtime.notion, claude: llm ? createClaudeClient({ ...llm, fetchImpl, timeoutMs: 60_000 }) : null,
            poster: masonPoster({ env: config, fetchImpl, channelId: runtime.routeMap.project.channelId }), fetchImpl, clock, deadline: started + 270_000,
            onSantosh: ({ text, sourceUrl }) => updateSantoshLink({ notion: runtime.notion, db: config.DB, text, source: 'Slack', sourceUrl, clock,
              poster: masonPoster({ env: config, fetchImpl, channelId: runtime.routeMap.project.channelId }) }),
            // "Robin will also be on the 5:10" in the team's DMs: who takes which coming interview (interview-plan.mjs).
            onBatch: async batch => {
              // A time someone needs for a work-trial check-in ("Interviewer can't do the night one before 10"): kept, and the coming ones moved (checkins.mjs).
              const claudeC = llm ? createClaudeClient({ ...llm, fetchImpl, timeoutMs: 30_000 }) : null;
              for (const m of batch.filter(x => ['Robin', 'Interviewer', 'Taylor', 'Project', 'Alexis'].includes(x.speaker) && looksLikeCheckinTalk(x.text)).slice(0, 4)) {
                const found = await readCheckinConstraints({ db: config.DB, claude: claudeC, text: m.text, speaker: m.speaker, clock }).catch(() => []);
                const tell = masonPoster({ env: config, fetchImpl, channelId: runtime.routeMap.project.channelId });
                if (found.length) {
                  await tell(`📅 ${m.speaker} said: “${String(found[0].quote).slice(0, 160)}”. I'll keep ${found.map(c => `${c.first}'s ${c.kind === 'both' ? '' : `${c.kind} `}check-ins${c.from ? ` from ${c.from}` : ''}${c.to ? ` until ${c.to}` : ''} PT`).join('; ')}.`).catch(() => {});
                  for (const pageId of new Set(found.map(c => c.pageId))) await runCheckinGuard({ env: config, db: config.DB, calendar: runtime.calendar, notion: runtime.notion, poster: tell, clock, force: true, onlyPageId: pageId });
                }
              }
              return readAssignments({ db: config.DB, claude: llm ? createClaudeClient({ ...llm, fetchImpl, timeoutMs: 60_000 }) : null, runner: runtime.runner,
                text: batch.map(m => `${m.day} · ${m.speaker}: ${m.text}`).join('\n'), source: 'slack-dm', context: "the team's Slack DMs", clock });
            },
            // Robin or Interviewer calling a work trial in a DM with Project: the Send offer, as from a recap (Project, 2026-10-16).
            onWorkTrialCall: input => runtime.runner.packetOfferFromRecap(input) });
          if (dms.notes || dms.error || dms.asks || dms.trialCalls || dms.state === 'link_sent') log(`uncle_sam_slack_dms ${JSON.stringify(dms)}`);
        }
        // The day's interviews to Project each morning, as Uncle Sam understands them (interview-plan.mjs, Project 2026-10-16).
        if (runtime.routeMap?.project?.channelId) {
          // The morning and night-before previews to Project are off (Project, 2026-10-19: "you can stop sending them to me and just feel
          // free to trust yourself in the recruitment").
          // 9:30 Pacific: the day's interview schedule in #int-recruitment, replacing Jamie's post (Project, 2026-10-16).
          const schedule = await runInterviewSchedule({ env: config, db: config.DB, runner: runtime.runner,
            channelPoster: masonPoster({ env: config, fetchImpl, channelId: config.UNCLE_SAM_SCHEDULE_CHANNEL || SCHEDULE_CHANNEL }), channelId: config.UNCLE_SAM_SCHEDULE_CHANNEL || SCHEDULE_CHANNEL,
            masonPoster: masonPoster({ env: config, fetchImpl, channelId: runtime.routeMap.project.channelId }), clock, log });
          if (schedule.state === 'sent' || schedule.state === 'error') log(`uncle_sam_interview_schedule ${JSON.stringify(schedule)}`);
          // A move or in-person change settled by email with the candidate (Project, 2026-10-19), before the post is refreshed.
          try {
            const llmR = llmSettingsOf(config);
            const moved = await runEmailReschedules({ db: config.DB, runner: runtime.runner, gmail: gmailConfigured(config) ? createGmailSender({ env: config, db: config.DB, fetchImpl, clock }) : null,
              claude: llmR ? createClaudeClient({ ...llmR, fetchImpl, timeoutMs: 30_000 }) : null, clock, log });
            if (moved.kept || moved.error) log(`uncle_sam_reschedule_mail ${JSON.stringify(moved)}`);
          } catch { /* never fails the tick */ }
          // Anything that changed since (a sync or DM assignment, a moved interview): the posted schedule and preview edited in place.
          const refreshed = await refreshSchedules({ env: config, db: config.DB, runner: runtime.runner, fetchImpl, clock, log });
          if (refreshed.edited || refreshed.error) log(`uncle_sam_schedule_refresh ${JSON.stringify(refreshed)}`);
        }
        // Work-trial setup and the calendar banner, every 30 minutes (work-trial.mjs, Project 2026-10-15).
        if (runtime.routeMap?.project?.channelId) {
          const llm = llmSettingsOf(config);
          // First the dates and pay agreed in writing (trial-terms.mjs, Project 2026-10-18), so the setup below sees them.
          try {
            const terms = await runTrialTerms({ env: config, db: config.DB, notion: runtime.notion,
              gmail: gmailConfigured(config) ? createGmailSender({ env: config, db: config.DB, fetchImpl, clock }) : null,
              claude: llm ? createClaudeClient({ ...llm, fetchImpl, timeoutMs: 30_000 }) : null,
              sendPacket: runtime.packets ? ({ candidate, rate }) => runtime.packets.send({ who: factsOf(candidate), rate }) : null,
              poster: masonPoster({ env: config, fetchImpl, channelId: runtime.routeMap.project.channelId }), clock, log });
            if (terms.set || terms.conflicts || terms.error) log(`uncle_sam_trial_terms ${JSON.stringify(terms)}`);
          } catch { /* never fails the tick */ }
          // Where each trialer is, from their emails and LinkedIn, before anyone asks Project (trial-location.mjs, Project 2026-10-18).
          try {
            const li = await linkedinReady({ env: config, db: config.DB }).catch(() => null);
            const located = await runTrialLocations({ env: config, db: config.DB, notion: runtime.notion,
              gmail: gmailConfigured(config) ? createGmailSender({ env: config, db: config.DB, fetchImpl, clock }) : null,
              claude: llm ? createClaudeClient({ ...llm, fetchImpl, timeoutMs: 30_000 }) : null,
              linkedin: li?.accountId ? createUnipileClient({ env: config, fetchImpl }) : null, linkedinAccountId: li?.accountId ?? null, clock, log });
            if (located.found || located.conflicts || located.error) log(`uncle_sam_trial_location ${JSON.stringify(located)}`);
          } catch { /* never fails the tick */ }
          const canWriteCalendar = gmailConfigured(config) ? await calendarWriteGranted({ db: config.DB }).catch(() => false) : false;
          const trials = await runWorkTrials({ env: config, db: config.DB, notion: runtime.notion, calendar: runtime.calendar,
            canWrite: canWriteCalendar,
            claude: llm ? createClaudeClient({ ...llm, fetchImpl, timeoutMs: 30_000 }) : null,
            poster: masonPoster({ env: config, fetchImpl, channelId: runtime.routeMap.project.channelId }), clock });
          if (trials.moved || trials.banners || trials.error) log(`uncle_sam_work_trials ${JSON.stringify(trials).slice(0, 600)}`);
          // Unsigned documents the day before a trial starts (pre-start-paperwork.mjs, Project 2026-10-17).
          try {
            const prestart = await runPreStartPaperwork({ env: config, db: config.DB, notion: runtime.notion,
              sender: docusignSendConfigured(config) && await docusignConnected({ db: config.DB }).catch(() => false) ? createDocusignSender({ env: config, db: config.DB, fetchImpl, clock }) : null,
              rateOf: c => standardRate({ db: config.DB, who: factsOf(c) }),
              poster: masonPoster({ env: config, fetchImpl, channelId: runtime.routeMap.project.channelId }), masonChannel: runtime.routeMap.project.channelId, clock, log });
            if (prestart.told || prestart.error) log(`uncle_sam_prestart ${JSON.stringify(prestart).slice(0, 400)}`);
          } catch { /* never fails the tick */ }
          // Company email + Slack from Jamie, then Okta from AA, two days before a signed work trial (onboarding.mjs, Project 2026-10-16).
          // Okta by API (okta.mjs): the connection checked once per key, Project told; then hires are set up in Okta directly, not via AA.
          if (oktaConfigured(config)) await probeOkta({ env: config, db: config.DB, fetchImpl, clock, poster: masonPoster({ env: config, fetchImpl, channelId: runtime.routeMap.project.channelId }) }).catch(() => null);
          if (insightfulConfigured(config)) await probeInsightful({ env: config, db: config.DB, fetchImpl, clock, poster: masonPoster({ env: config, fetchImpl, channelId: runtime.routeMap.project.channelId }) }).catch(() => null);
          // Work-trial invitations waiting for a good hour in the candidate's time zone (trial-invite.mjs, Project 2026-10-18).
          try {
            const invites = await runTrialInvites({ db: config.DB, notion: runtime.notion, parseTemplate,
              gmail: gmailConfigured(config) ? createGmailSender({ env: config, db: config.DB, fetchImpl, clock }) : null,
              poster: masonPoster({ env: config, fetchImpl, channelId: runtime.routeMap.project.channelId }), clock, log });
            if (invites.sent || invites.error) log(`uncle_sam_trial_invites ${JSON.stringify(invites)}`);
          } catch { /* never fails the tick */ }
          // Work-trial documents waiting their 30 minutes (email-queue.mjs, Project 2026-10-20).
          try {
            const queued = await runEmailQueue({ db: config.DB, notion: runtime.notion, packets: runtime.packets,
              poster: masonPoster({ env: config, fetchImpl, channelId: runtime.routeMap.project.channelId }), clock, log });
            if (queued.sent || queued.dropped || queued.error) log(`uncle_sam_email_queue ${JSON.stringify(queued)}`);
          } catch { /* never fails the tick */ }
          // The payout setup email after their first check-in (payout-setup.mjs, Project 2026-10-20).
          try {
            const payout = await runPayoutSetup({ env: config, db: config.DB, notion: runtime.notion, parseTemplate,
              gmail: gmailConfigured(config) ? createGmailSender({ env: config, db: config.DB, fetchImpl, clock }) : null,
              poster: masonPoster({ env: config, fetchImpl, channelId: runtime.routeMap.project.channelId }), clock, log });
            if (payout.sent || payout.error) log(`uncle_sam_payout ${JSON.stringify(payout)}`);
          } catch { /* never fails the tick */ }
          // A request already posted to AA that needs correcting (project-commands.mjs repairAaMessages): edited, else deleted and reposted.
          try {
            await repairAaMessages({ env: config, db: config.DB, clock,
              update: ({ channel, ts, text }) => slackUpdate({ env: config, fetchImpl, channel, ts, text }),
              remove: async ({ channel, ts }) => { const { headers, body } = slackWire('chat.delete', config.SLACK_BOT_TOKEN, { channel, ts }); await fetchImpl('https://slack.com/api/chat.delete', { method: 'POST', headers, body, redirect: 'error' }); },
              post: ({ channel, text }) => masonPoster({ env: config, fetchImpl, channelId: channel })(text),
              tell: masonPoster({ env: config, fetchImpl, channelId: runtime.routeMap.project.channelId }) });
          } catch { /* never fails the tick */ }
          const onboarding = await runOnboarding({ env: config, db: config.DB, notion: runtime.notion, routeMap: runtime.routeMap, fetchImpl, clock, log,
            okta: oktaConfigured(config) ? createOktaClient({ env: config, fetchImpl }) : null,
            insightful: insightfulConfigured(config) ? createInsightfulClient({ env: config, fetchImpl }) : null,
            // The check-ins the moment the email exists (work-trial.mjs ensureCheckins, Project 2026-10-18).
            onEmailReady: candidate => ensureCheckins({ db: config.DB, calendar: runtime.calendar, canWrite: canWriteCalendar, candidate, notion: runtime.notion, clock, emailReady: true,
              poster: masonPoster({ env: config, fetchImpl, channelId: runtime.routeMap.project.channelId }) }),
            claude: llm ? createClaudeClient({ ...llm, fetchImpl, timeoutMs: 30_000 }) : null,
            poster: masonPoster({ env: config, fetchImpl, channelId: runtime.routeMap.project.channelId }),
            // Company's Google directory (read-only): the hire's new account, seen as soon as Jamie creates it (directory.mjs).
            directory: gmailConfigured(config) ? createDirectoryFinder({ env: config, db: config.DB, fetchImpl, clock, log,
              poster: masonPoster({ env: config, fetchImpl, channelId: runtime.routeMap.project.channelId }) }) : null,
            // Uncle Sam creating the Company account itself, once switched on and set up (accounts.mjs); off by default.
            accounts: gmailConfigured(config) && accountCreationWanted(config) ? { missing: () => accountCreationMissing({ env: config, db: config.DB, notion: runtime.notion }),
              admin: createWorkspaceAdmin({ env: config, db: config.DB, fetchImpl, clock }), gmail: createGmailSender({ env: config, db: config.DB, fetchImpl, clock }),
              joinUrl: config.UNCLE_SAM_SLACK_JOIN_URL } : null,
            // Strict: no new Company address that anyone has or had (company-address.mjs, Project 2026-10-16).
            addressChecks: {
              ...(gmailConfigured(config) ? { directoryOwners: createAddressOwners({ env: config, db: config.DB, fetchImpl, clock }) } : {}),
              slackMembers: () => slackMembersAll({ env: config, fetchImpl }),
              ...(gmailConfigured(config) ? { mail: async address => (await createGmailSender({ env: config, db: config.DB, fetchImpl, clock }).searchSent(`to:${address}`)).length } : {}) } });
          if (gmailConfigured(config)) {
            const probe = await probeDirectory({ env: config, db: config.DB, fetchImpl, clock, log, poster: masonPoster({ env: config, fetchImpl, channelId: runtime.routeMap.project.channelId }) });
            if (probe.state === 'ok' || probe.state === 'failed' || probe.state === 'error') log(`uncle_sam_directory_probe ${JSON.stringify(probe)}`);
          }
          // A take-home or deep dive set to Reject by hand on the Take-homes tab: 30 minutes, then Not Selected (manual-reject.mjs).
          const manual = await runManualRejects({ env: config, db: config.DB, notion: runtime.notion, store: runtime.store, clock, log,
            poster: masonPoster({ env: config, fetchImpl, channelId: runtime.routeMap.project.channelId }) });
          if (manual.held || manual.closed || manual.stood_down || manual.error || manual.state === 'baselined') log(`uncle_sam_manual_rejects ${JSON.stringify(manual)}`);
          if (onboarding.jamie || onboarding.aa || onboarding.error) log(`uncle_sam_onboarding ${JSON.stringify(onboarding).slice(0, 600)}`);
          // Overdue decisions: two business days after an interview with nothing moved, the interviewer is asked (decision-nudges.mjs).
          const masonDm = runtime.routeMap.project.channelId;
          const decisions = await runDecisionNudges({ env: config, db: config.DB, notion: runtime.notion, store: runtime.store, calendar: runtime.calendar,
            calendarIds: runtime.calendarIds, routeMap: runtime.routeMap, groupRoutes: runtime.groupRoutes, clock, log,
            poster: (channelId, threadTs = null) => masonPoster({ env: config, fetchImpl, channelId, threadTs }),
            masonPoster: masonPoster({ env: config, fetchImpl, channelId: masonDm }) });
          if (decisions.tracked || decisions.asked || decisions.escalated || decisions.stopped || decisions.error || decisions.state === 'baselined') log(`uncle_sam_decisions ${JSON.stringify(decisions)}`);
          // Someone booked a call and isn't on the tracker: Project told, then added after 30 minutes (new-bookings.mjs).
          const bookings = await runNewBookings({ env: config, db: config.DB, notion: runtime.notion, calendar: runtime.calendar, calendarIds: runtime.calendarIds, clayOn: clayConfigured(config), clock, log,
            recruitingMessages: runtime.slackRead ? since => runtime.slackRead.readHistory({ channelId: config.UNCLE_SAM_SCHEDULE_CHANNEL || SCHEDULE_CHANNEL, oldest: (since / 1000).toFixed(6), limit: 100, pages: 3 }) : null,
            poster: (threadTs = null) => masonPoster({ env: config, fetchImpl, channelId: masonDm, threadTs }) });
          if (bookings.held || bookings.added || bookings.scorecards || bookings.error) log(`uncle_sam_new_bookings ${JSON.stringify(bookings)}`);
          // DocuSign updates that did not reach the record the first time (docusign.mjs): brought forward every 10 minutes.
          if (docusignConfigured(config)) {
            const catchUp = await reconcilePaperwork({ db: config.DB, notion: runtime.notion, clock, log, poster: masonPoster({ env: config, fetchImpl, channelId: masonDm }) });
            if (catchUp.fixed || catchUp.failed || catchUp.error) log(`uncle_sam_docusign_catchup ${JSON.stringify(catchUp)}`);
          }
          // Paperwork follow-through (paperwork-followup.mjs): one reminder timed to the trial start, Project told before the start
          // and on the day, countersignature nudges, declines / voids / bounces. Every 10 minutes, Live only.
          if (docusignSendConfigured(config) && await docusignConnected({ db: config.DB })) {
            const follow = await runPaperworkFollowUps({ env: config, db: config.DB, notion: runtime.notion, clock, log,
              sender: createDocusignSender({ env: config, db: config.DB, fetchImpl, clock }), poster: masonPoster({ env: config, fetchImpl, channelId: masonDm }) });
            if (follow.reminded || follow.told || follow.done || follow.error) log(`uncle_sam_paperwork ${JSON.stringify(follow)}`);
          }
          // Which documents each person has signed, from DocuSign, hourly: "Documents" and a corrected "Paperwork" (docusign-documents.mjs).
          if (docusignSendConfigured(config) && await docusignConnected({ db: config.DB })) {
            const docs = await runDocumentsSync({ env: config, db: config.DB, notion: runtime.notion, clock, log,
              sender: createDocusignSender({ env: config, db: config.DB, fetchImpl, clock }), poster: masonPoster({ env: config, fetchImpl, channelId: masonDm }) });
            if (docs.fixed.length || docs.unbacked.length || docs.error) log(`uncle_sam_documents ${JSON.stringify(docs)}`);
          }
          // Interview recaps posted in #int-recruitment: the candidate found or added, the note, and what the poster said happens next (recap-intake.mjs).
          if (runtime.slackRead && llm) {
            const recaps = await runRecapIntake({ env: config, db: config.DB, notion: runtime.notion, claude: createClaudeClient({ ...llm, fetchImpl, timeoutMs: 30_000 }),
              slackRead: runtime.slackRead, calendar: runtime.calendar, calendarIds: runtime.calendarIds, clock, log,
              channelId: config.UNCLE_SAM_SCHEDULE_CHANNEL || SCHEDULE_CHANNEL, poster: masonPoster({ env: config, fetchImpl, channelId: masonDm }),
              channelPoster: masonPoster({ env: config, fetchImpl, channelId: config.UNCLE_SAM_SCHEDULE_CHANNEL || SCHEDULE_CHANNEL }),
              takeHome: input => runtime.runner.takeHomeFromRecap(input),
              decision: input => applyRecapDecision({ ...input, env: config, notion: runtime.notion, slackRead: runtime.slackRead, gmail: runtime.gmail,
                findInterviewEnd: email => latestInterviewEnd({ reader: runtime.calendar, calendarIds: runtime.calendarIds, email, now: clock() }),
                takeHome: request => runtime.runner.takeHomeFromRecap(request), clock }),
              packetOffer: input => runtime.runner.packetOfferFromRecap(input),
              // ✅ on a recap that is on the tracker (needs the bot scope reactions:write; without it, logged and skipped).
              react: async (channel, timestamp, name) => {
                const { headers, body } = slackWire('reactions.add', config.SLACK_BOT_TOKEN, { channel, timestamp, name });
                const data = await (await fetchImpl('https://slack.com/api/reactions.add', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000), headers, body })).json().catch(() => null);
                if (!data?.ok && data?.error !== 'already_reacted') throw Object.assign(new Error('react_failed'), { code: `slack_${String(data?.error ?? 'error').replace(/[^a-z_]/g, '')}` });
              } });
            if (recaps.read || recaps.added || recaps.error) log(`uncle_sam_recaps ${JSON.stringify(recaps)}`);
          }
          // Where new people are based, from Clay (clay-pipelines.mjs): their Pipeline within minutes, before the hourly check asks Project.
          const llmC = llmSettingsOf(config);
          const clayRun = await runClayPipelines({ env: config, db: config.DB, notion: runtime.notion, fetchImpl, clock, log,
            claude: llmC ? createClaudeClient({ ...llmC, fetchImpl, timeoutMs: 30_000 }) : null,
            poster: (threadTs = null) => masonPoster({ env: config, fetchImpl, channelId: masonDm, threadTs }) });
          if (clayRun.started || clayRun.set || clayRun.corrected || clayRun.error) log(`uncle_sam_clay ${JSON.stringify(clayRun)}`);
          // Work-trial pay read from Stripe, every 30 minutes (stripe-payments.mjs). Read-only: paying stays Project's click.
          const pay = await runStripePayments({ env: config, db: config.DB, notion: runtime.notion, fetchImpl, clock, log,
            poster: (threadTs = null) => masonPoster({ env: config, fetchImpl, channelId: masonDm, threadTs }) });
          if (pay.paid || pay.ready || pay.told || pay.error) log(`uncle_sam_stripe ${JSON.stringify(pay)}`);
          const pipelines = await runPipelineCheck({ env: config, db: config.DB, notion: runtime.notion, claude: llm ? createClaudeClient({ ...llm, fetchImpl, timeoutMs: 30_000 }) : null,
            poster: masonPoster({ env: config, fetchImpl, channelId: runtime.routeMap.project.channelId }), clock });
          if (pipelines.set || pipelines.asked || pipelines.error) log(`uncle_sam_pipelines ${JSON.stringify(pipelines)}`);
        }
        // Rejection emails, sent by Uncle Sam itself once switched over (rejection-sender.mjs).
        if (rejectionSenderEnabled(config)) {
          // Reading Google Calendar directly (source "project"): interview ends come from the calendar too.
          const findInterviewEnd = config.UNCLE_SAM_CALENDAR_SOURCE === 'project' && runtime.calendar && runtime.calendarIds.length
            ? email => latestInterviewEnd({ reader: runtime.calendar, calendarIds: runtime.calendarIds, email, now: clock() }) : null;
          // First, sends left unclear are settled from Project's Sent mail (sent -> recorded; confirmed not sent -> queued again).
          const unclear = await confirmUnclearSends({ env: config, db: config.DB, notion: runtime.notion, gmail: createGmailSender({ env: config, db: config.DB, fetchImpl, clock }), clock, log });
          if (unclear.confirmedSent || unclear.requeued || unclear.cancelled || unclear.gaveUp || unclear.error) log(`uncle_sam_rejection_confirm ${JSON.stringify(unclear)}`);
          const rejections = await runRejectionSender({ env: config, db: config.DB, notion: runtime.notion, findInterviewEnd,
            gmail: createGmailSender({ env: config, db: config.DB, fetchImpl, clock }), clock, runId: `tick-${started}`, log });
          if (rejections.sent || rejections.error || rejections.needsAttention) log(`uncle_sam_rejections ${JSON.stringify(rejections)}`);
        }
      } catch { /* reported by the next tick */ }
      // Offboarding (offboarding.mjs): 24 hours after a work trial ends, the Company Google account is suspended; Project heads-up first.
      try {
        const runtime = createRuntime(config, { fetchImpl, clock });
        const masonDm = runtime.routeMap?.project?.channelId ?? null;
        if (masonDm && gmailConfigured(config) && await adminUserGranted({ db: config.DB }).catch(() => false)) {
          const off = await runOffboarding({ env: config, db: config.DB, notion: runtime.notion, admin: createWorkspaceAdmin({ env: config, db: config.DB, fetchImpl, clock }),
            poster: masonPoster({ env: config, fetchImpl, channelId: masonDm }), masonChannel: masonDm, clock, log,
            okta: oktaConfigured(config) ? createOktaClient({ env: config, fetchImpl }) : null,
            insightful: insightfulConfigured(config) ? createInsightfulClient({ env: config, fetchImpl }) : null });
          if (off.told || off.suspended || off.error) log(`uncle_sam_offboarding ${JSON.stringify(off).slice(0, 500)}`);
        }
      } catch { /* never fails the tick */ }
      // Sourcing and outreach run on their own cron (/api/cron/sourcing, sourcingTick below): Wrangle searches can take minutes.
      // Clay desk answers whose run was still going when they were asked (person-finder.mjs): posted where they were asked, once.
      try {
        if (clayConfigured(config) && config.UNCLE_SAM_FIND !== 'off') {
          const runtime = createRuntime(config, { fetchImpl, clock });
          if (runtime.claude) await runPendingFinds({ env: config, db: config.DB, claude: runtime.claude, clay: createClayClient({ env: config, fetchImpl }), notion: runtime.notion, gmail: runtime.gmail,
            postTo: (channelId, threadTs) => masonPoster({ env: config, fetchImpl, channelId, threadTs }), clock, log });
        }
      } catch { /* never fails the tick */ }
      // Work-trial check-ins (checkins.mjs): a clash on Robin's or Interviewer's calendar moves that day's check-in within its window.
      try {
        const runtime = createRuntime(config, { fetchImpl, clock });
        const masonDm = runtime.routeMap?.project?.channelId ?? null;
        if (masonDm && runtime.calendar?.writeEvent && gmailConfigured(config) && await calendarWriteGranted({ db: config.DB }).catch(() => false)) {
          const guard = await runCheckinGuard({ env: config, db: config.DB, calendar: runtime.calendar, notion: runtime.notion, clock, log, poster: masonPoster({ env: config, fetchImpl, channelId: masonDm }) });
          const first = await runFirstCheckinConfirmations({ env: config, db: config.DB, calendar: runtime.calendar,
            notion: runtime.notion, gmail: runtime.gmail, clock, poster: masonPoster({ env: config, fetchImpl, channelId: masonDm }) });
          if (first.sent || first.held || first.errors) log(`uncle_sam_first_confirmation ${JSON.stringify(first)}`);
          // Looking ahead: the coming trials' check-ins placed on paper once a day; Project hears early what won't fit (checkin-plan.mjs).
          try {
            const ahead = await runCheckinForecast({ env: config, db: config.DB, notion: runtime.notion, calendar: runtime.calendar, clock, log, poster: masonPoster({ env: config, fetchImpl, channelId: masonDm }) });
            if (ahead.told || ahead.error) log(`uncle_sam_checkin_forecast ${JSON.stringify(ahead)}`);
          } catch { /* never fails the tick */ }
          if (guard.moved || guard.asked || guard.error) log(`uncle_sam_checkins ${JSON.stringify(guard)}`);
          // Closed trials lose their banner too (work-trial.mjs).
          try {
            const banners = await clearClosedBanners({ db: config.DB, notion: runtime.notion, calendar: runtime.calendar, clock, log });
            if (banners.removed || banners.error) log(`uncle_sam_banners ${JSON.stringify(banners)}`);
          } catch { /* never fails the tick */ }
          // The tier list: on it once day 1 is under way and the first check-in has ended (work-trial.mjs).
          try {
            const tier = await markFirstCheckins({ db: config.DB, notion: runtime.notion, calendar: runtime.calendar, clock, log });
            if (tier.marked || tier.error) log(`uncle_sam_tier_list ${JSON.stringify(tier)}`);
          } catch { /* never fails the tick */ }
        }
      } catch { /* never fails the tick */ }
      // Things that fell through (stage-gaps.mjs, Project 2026-10-16): Case Study with no take-home sent, feedback questions unanswered.
      try {
        const runtime = createRuntime(config, { fetchImpl, clock });
        const masonDm = runtime.routeMap?.project?.channelId ?? null;
        if (masonDm && (summary.control?.mode ?? 'Live') === 'Live') {
          const gaps = await runStageGaps({ env: config, db: config.DB, notion: runtime.notion, channelId: masonDm, clock, log,
            gmail: gmailConfigured(config) ? createGmailSender({ env: config, db: config.DB, fetchImpl, clock }) : null,
            poster: masonPoster({ env: config, fetchImpl, channelId: masonDm }) });
          if (gaps.takeHome || gaps.unanswered || gaps.error) log(`uncle_sam_stage_gaps ${JSON.stringify(gaps)}`);
        }
      } catch { /* never fails the tick */ }
      // The morning health check (health.mjs, Project 2026-10-16): this run's failures kept by job; once a day after 7:00 PT,
      // Project hears only when something is wrong.
      try {
        await recordFailures(config.DB, healthLines.splice(0), clock());
        const masonDm = (() => { try { return createRuntime(config, { fetchImpl, clock }).routeMap?.project?.channelId ?? null; } catch { return null; } })();
        const health = await runMorningHealth({ env: config, db: config.DB, mode: summary.control?.mode ?? null, clock,
          connections: () => connectionsOf({ db: config.DB, configured: { slackDms: slackUserConfigured(config), docusign: docusignSendConfigured(config), meet: meetConfigured(config), wispr: wisprConfigured(config), okta: oktaConfigured(config), juicebox: juiceboxEnabled(config), wrangle: wrangleEnabled(config), linkedin: unipileConfigured(config) },
            google: gmailConfigured(config) ? gmailConnected({ db: config.DB }).catch(() => undefined) : undefined,
            googleAdmin: gmailConfigured(config) ? googleAdminWorks({ granted: () => adminUserGranted({ db: config.DB }), admin: () => createWorkspaceAdmin({ env: config, db: config.DB, fetchImpl, clock }) }) : undefined }),
          poster: masonDm ? masonPoster({ env: config, fetchImpl, channelId: masonDm }) : null });
        if (['told', 'tell_failed'].includes(health.state)) log(`uncle_sam_health ${JSON.stringify(health)}`);
      } catch { /* never fails the tick */ }
      return json({ ok: result.status !== 'failed', status: result.status, reason: result.reason ?? null, mode: summary.control?.mode ?? null,
        events: summary.events?.length ?? 0, prompts: summary.prompts?.length ?? 0, dispatched: summary.dispatched?.length ?? 0,
        swept: summary.swept ?? 0, errors: (summary.errors ?? []).length,
        ...(wisprConfigured(config) ? { wispr: { state: wispr.state ?? 'off', meetings: wispr.meetings ?? 0, recorded: wispr.recorded ?? 0, unclear: wispr.unclear ?? 0, error: wispr.error ?? null } } : {}) },
      result.status === 'failed' ? 500 : 200);
      } finally { await releaseTickLease(config.DB, lease).catch(() => {}); }
    },

    /**
     * Every minute (vercel.json): interview follow-ups only, for calls that ended in the last 15 minutes, so the question reaches
     * the interviewer 3 minutes after the calendar says the call ended (Project, 2026-10-16) instead of waiting for the 5-minute
     * tick. Its own lease keeps it to one at a time; the tick does the same check over 36 hours as the backstop, and both use
     * the same request key and one atomic send claim, so nobody is asked twice.
     */
    async followups(request) {
      if (!['GET', 'POST'].includes(request.method)) return methodNotAllowed('GET, POST');
      if (!secretOk(env.CRON_SECRET)) return json({ error: 'cron_not_configured' }, 503);
      const supplied = /^Bearer ([^\s]+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
      if (!supplied || !(await constantTimeSecretEqual(supplied, env.CRON_SECRET))) {
        return json({ error: 'unauthorized' }, 401, { 'www-authenticate': 'Bearer' });
      }
      if (env.UNCLE_SAM_FAST_FOLLOWUPS === 'off') return json({ ok: true, status: 'off' });
      let config;
      try { config = await configure(); } catch { return json({ error: 'service_not_ready' }, 503); }
      if (!config.DB) return json({ error: 'service_not_configured' }, 503);
      const started = clock();
      // Keeps the button endpoint warm (audit, 2026-10-16: the first tap after a quiet spell could miss Slack's 3 seconds): a GET
      // loads its code and is turned away at once. Never waited on for long, never fails the run.
      if (env.UNCLE_SAM_KEEP_WARM !== 'off') {
        const base = String(env.UNCLE_SAM_PUBLIC_URL || 'https://your-project.example.com').replace(/\/+$/, '');
        await fetchImpl(`${base}/api/slack/interactions`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(2500) }).then(r => r.body?.cancel?.()).catch(() => {});
      }
      const lease = await takeTickLease(config.DB, { now: started, name: FOLLOWUPS_LEASE, ttlMs: FOLLOWUPS_LEASE_TTL_MS }).catch(() => null);
      if (!lease) return json({ ok: true, status: 'skipped', reason: 'in_progress' });
      try {
        const result = await createRuntime(config, { fetchImpl, clock }).runner.runFollowUps({ now: started });
        const acted = (result.prompts ?? []).filter(p => p?.action || p?.error);
        // A quiet heartbeat (the health check and Claude read it): the last run's time and outcome, no names.
        await config.DB.prepare('INSERT INTO uncle_sam_notices (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
          .bind('followups:last', JSON.stringify({ at: started, status: result.status, reason: result.reason ?? null, looked: (result.prompts ?? []).length, acted: acted.length }), started).run().catch(() => {});
        if (acted.length || result.status !== 'ok') log(`uncle_sam_followups status=${result.status} reason=${result.reason ?? '-'} ${acted.map(p => `${String(p.eventId ?? p.calendarId ?? '?').slice(0, 10)}:${String(p.action ?? p.error).replace(/[^\w:.-]/g, '').slice(0, 40)}${p.dispatch ? `:${p.dispatch}` : ''}`).join(',')}`);
        await recordFailures(config.DB, healthLines.splice(0), clock()).catch(() => 0);
        return json({ ok: true, status: result.status, prompts: acted.length });
      } catch (error) {
        log(`uncle_sam_followups status=failed reason=${String(error?.code ?? error?.message ?? 'failed').replace(/[^\w:.-]/g, '').slice(0, 60)}`);
        return json({ ok: false, status: 'failed' }, 500);
      } finally { await releaseTickLease(config.DB, lease, FOLLOWUPS_LEASE).catch(() => {}); }
    },

    /**
     * Wispr Flow's redirect after Project signs in from his connect link. The one-use state ties it to that link; the tokens
     * are kept only for his own account. The page says only whether it worked, never why in detail.
     */
    async wisprCallback(request) {
      if (request.method !== 'GET') return methodNotAllowed('GET');
      const page = (title, text, status = 200) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
        + `<title>${title}</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.4rem">${title}</h1><p>${text}</p></body>`,
      { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
      const url = new URL(request.url);
      const code = url.searchParams.get('code'), state = url.searchParams.get('state');
      if (!code || !state) return page('Not connected', 'Wispr Flow did not finish the sign-in. Uncle Sam will DM you a fresh link.', 400);
      let config;
      try { config = await configure(); } catch { return page('Not connected', 'Uncle Sam is not ready right now. Try the link again in a minute.', 503); }
      if (!config.DB || !wisprConfigured(config)) return page('Not connected', 'Uncle Sam is not set up for Wispr Flow yet.', 503);
      let result;
      try { result = await completeConnection({ env: config, db: config.DB, fetchImpl, clock, code, state }); }
      catch (error) {
        log(`uncle_sam_wispr_callback error=${typeof error?.code === 'string' ? error.code : 'failed'}`);
        const text = error?.code === 'wispr_wrong_account'
          ? 'That Wispr Flow account is not Project\'s, so nothing was connected. Sign in with project@company.example from the next link Uncle Sam DMs you.'
          : 'This link has expired or was already used. Uncle Sam will DM you a fresh one within the hour.';
        return page('Not connected', text, 400);
      }
      try {
        const runtime = createRuntime(config, { fetchImpl, clock });
        const channelId = runtime.routeMap?.project?.channelId;
        if (channelId) await masonPoster({ env: config, fetchImpl, channelId })('🫡 Wispr Flow is connected. From now on I read your recruiting meeting notes and record the rejections you agree on.');
      } catch { /* the connection is made; the DM is a courtesy */ }
      return page('Wispr Flow connected', `Uncle Sam can now read your recruiting meeting notes (${result.account}). You can close this tab.`);
    },

    /** Slack's redirect after Project allows Uncle Sam to read his team DMs (slack-dm-watch.mjs). Says only whether it worked. */
    async slackUserCallback(request) {
      if (request.method !== 'GET') return methodNotAllowed('GET');
      const page = (title, text, status = 200) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
        + `<title>${title}</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.4rem">${title}</h1><p>${text}</p></body>`,
      { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
      const url = new URL(request.url);
      const code = url.searchParams.get('code'), state = url.searchParams.get('state');
      if (!code || !state) return page('Not connected', 'Slack did not finish the sign-in, so nothing was connected. Uncle Sam will DM you a fresh link.', 400);
      let config;
      try { config = await configure(); } catch { return page('Not connected', 'Uncle Sam is not ready right now. Try the link again in a minute.', 503); }
      if (!config.DB || !slackUserConfigured(config)) return page('Not connected', 'Uncle Sam is not set up for this yet.', 503);
      try { await completeSlackUserConnection({ env: config, db: config.DB, fetchImpl, clock, code, state }); }
      catch (error) {
        const reason = typeof error?.code === 'string' ? error.code : 'failed';
        log(`uncle_sam_slack_user_callback error=${reason}`);
        const text = reason === 'slack_user_wrong_account' ? 'That is not Project\'s Slack account in the Company workspace, so nothing was connected.'
          : reason === 'slack_user_scope_missing' ? 'Slack did not grant all four read permissions, so nothing was connected. Use the next link Uncle Sam DMs you.'
            : 'This link has expired or was already used. Uncle Sam will DM you a fresh one within the hour.';
        return page('Not connected', text, 400);
      }
      try {
        const runtime = createRuntime(config, { fetchImpl, clock });
        const channelId = runtime.routeMap?.project?.channelId;
        if (channelId) await masonPoster({ env: config, fetchImpl, channelId })('🫡 Slack read access is on. From now on I pick up recruiting facts from your DMs and group DMs with the team and note them on the candidates\' records. I never post there.');
      } catch { /* the connection is made; the DM is a courtesy */ }
      return page('Slack connected', 'Uncle Sam can now read your DMs with the recruiting team, for recruiting notes only. You can close this tab.');
    },

    /** The trialer's payout setup link (payout-setup.mjs): pick a country, then on to Stripe's own form. */
    async payoutSetup(request) {
      if (!['GET', 'POST'].includes(request.method)) return methodNotAllowed('GET, POST');
      let config;
      try { config = await configure(); } catch { return new Response('Try again in a minute.', { status: 503 }); }
      // Project hears when someone picks a country Stripe can't pay out to.
      let poster = null;
      try { const channelId = createRuntime(config, { fetchImpl, clock }).routeMap?.project?.channelId; if (channelId) poster = masonPoster({ env: config, fetchImpl, channelId }); } catch { poster = null; }
      return handlePayoutRequest({ env: config, db: config.DB, request, poster, clock, log });
    },

    /** Google's redirect after Project grants Uncle Sam Gmail sending from his connect link (gmail.mjs). Says only whether it worked. */
    async googleCallback(request) {
      if (request.method !== 'GET') return methodNotAllowed('GET');
      const page = (title, text, status = 200) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
        + `<title>${title}</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.4rem">${title}</h1><p>${text}</p></body>`,
      { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
      const url = new URL(request.url);
      const code = url.searchParams.get('code'), state = url.searchParams.get('state');
      if (!code || !state) return page('Not connected', 'Google did not finish the sign-in, so nothing was connected. Uncle Sam will DM you a fresh link.', 400);
      let config;
      try { config = await configure(); } catch { return page('Not connected', 'Uncle Sam is not ready right now. Try the link again in a minute.', 503); }
      if (!config.DB || !gmailConfigured(config)) return page('Not connected', 'Uncle Sam is not set up for Gmail yet.', 503);
      // A Google Meet link (meet.mjs) comes back here too; its one-use state says so.
      if (await isMeetState({ db: config.DB, state }).catch(() => false)) {
        let done;
        try { done = await completeMeetConnection({ env: config, db: config.DB, fetchImpl, clock, code, state }); }
        catch (error) {
          const reason = typeof error?.code === 'string' ? error.code : 'failed';
          log(`uncle_sam_meet_callback error=${reason}`);
          const text = reason === 'meet_wrong_account' ? 'That Google account is not the one this link was made for, so nothing was connected. Sign in as the right Company account and use the link again.'
            : reason === 'meet_scope_missing' ? 'The Google Meet box needs to be ticked, so nothing was connected. Ask Project for a fresh link.'
              : 'This link has expired or was already used. Ask Project for a fresh one.';
          return page('Not connected', text, 400);
        }
        log(`uncle_sam_meet_callback connected=${done.email.split('@')[0]}`);
        return page('Google Meet connected', 'Uncle Sam can now see when your interview calls end and who joined them (read-only, nothing that was said). You can close this tab.');
      }
      try { await completeGmailConnection({ env: config, db: config.DB, fetchImpl, clock, code, state }); }
      catch (error) {
        const reason = typeof error?.code === 'string' ? error.code : 'failed';
        log(`uncle_sam_gmail_callback error=${reason}`);
        const text = reason === 'gmail_wrong_account' ? 'That Google account is not project@company.example, so nothing was connected. Use the next link Uncle Sam DMs you.'
          : reason === 'gmail_scope_missing' ? 'The send-email and settings boxes need to be ticked, so nothing was connected. Use the next link Uncle Sam DMs you.'
            : 'This link has expired or was already used. Uncle Sam will DM you a fresh one within the hour.';
        return page('Not connected', text, 400);
      }
      try {
        const runtime = createRuntime(config, { fetchImpl, clock });
        const channelId = runtime.routeMap?.project?.channelId;
        if (channelId) await masonPoster({ env: config, fetchImpl, channelId })('🫡 Gmail is connected. From now on I send take-home invites, deep-dive invites and (once rejections are switched over) rejections from your Gmail myself, on time.');
      } catch { /* the connection is made; the DM is a courtesy */ }
      return page('Gmail connected', 'Uncle Sam will now send recruiting emails from your Gmail itself. You can close this tab.');
    },

    /** DocuSign's redirect after Project allows Uncle Sam to resend envelopes (docusign-send.mjs). One use, Project only. */
    async docusignCallback(request) {
      if (request.method !== 'GET') return methodNotAllowed('GET');
      const page = (title, text, status = 200) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
        + `<title>${title}</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.4rem">${title}</h1><p>${text}</p></body>`,
      { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
      const url = new URL(request.url);
      const code = url.searchParams.get('code'), state = url.searchParams.get('state');
      if (!code || !state) return page('Not connected', 'DocuSign did not finish the sign-in, so nothing was connected.', 400);
      let config;
      try { config = await configure(); } catch { return page('Not connected', 'Uncle Sam is not ready right now. Try the link again in a minute.', 503); }
      if (!config.DB || !docusignSendConfigured(config)) return page('Not connected', 'Uncle Sam is not set up for DocuSign yet.', 503);
      try { await completeDocusignConnection({ env: config, db: config.DB, fetchImpl, clock, code, state }); }
      catch (error) {
        const reason = typeof error?.code === 'string' ? error.code : 'failed';
        log(`uncle_sam_docusign_callback error=${reason}`);
        return page('Not connected', reason === 'docusign_wrong_account' ? 'That DocuSign login is not project@company.example, so nothing was connected.'
          : reason === 'docusign_account_missing' ? 'That login does not have the Company AI DocuSign account, so nothing was connected.'
            : 'This link has expired or was already used. Uncle Sam will DM you a fresh one.', 400);
      }
      log('uncle_sam_docusign_callback connected');
      try {
        const runtime = createRuntime(config, { fetchImpl, clock });
        const channelId = runtime.routeMap?.project?.channelId;
        if (channelId) await masonPoster({ env: config, fetchImpl, channelId })('🫡 DocuSign is connected. Say "resend Morgan\'s DocuSign" (or any candidate) here and I resend whatever is waiting on them.');
      } catch { /* connected either way */ }
      return page('DocuSign connected', 'Uncle Sam can now resend DocuSign envelopes when you ask. You can close this tab.');
    },

    /** Juicebox's redirect after Project signs in from his connect link (juicebox.mjs). Says only whether it worked. */
    async juiceboxCallback(request) {
      if (request.method !== 'GET') return methodNotAllowed('GET');
      const page = (title, text, status = 200) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
        + `<title>${title}</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.4rem">${title}</h1><p>${text}</p></body>`,
      { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
      const url = new URL(request.url);
      const code = url.searchParams.get('code'), state = url.searchParams.get('state');
      if (!code || !state) return page('Not connected', 'Juicebox did not finish the sign-in. Say "connect juicebox" to Uncle Sam for a fresh link.', 400);
      let config;
      try { config = await configure(); } catch { return page('Not connected', 'Uncle Sam is not ready right now. Try the link again in a minute.', 503); }
      if (!config.DB || !juiceboxEnabled(config)) return page('Not connected', 'Uncle Sam is not set up for Juicebox.', 503);
      try { await juiceboxAuth({ env: config, db: config.DB, fetchImpl, clock }).complete({ code, state }); }
      catch (error) {
        log(`uncle_sam_juicebox_callback error=${typeof error?.code === 'string' ? error.code : 'failed'}`);
        return page('Not connected', 'This link has expired or was already used. Say "connect juicebox" to Uncle Sam for a fresh one.', 400);
      }
      try {
        const runtime = createRuntime(config, { fetchImpl, clock });
        const channelId = runtime.routeMap?.project?.channelId;
        let check = '';
        try { check = ` ${toolCheckText((await juiceboxSession({ env: config, db: config.DB, fetchImpl, clock })).tools)}`; } catch (error) { check = ` (I couldn't list its tools yet: ${error?.code ?? 'failed'}.)`; }
        if (channelId) await masonPoster({ env: config, fetchImpl, channelId })(`🫡 Juicebox is connected.${check} Tell me where the profiles come from: "juicebox agent: <id or link>", or give me a brief ("sourcing brief: who we want") and I\'ll make the Agent. The first ten come the next morning from 8:30 AM PT.`);
      } catch { /* connected either way */ }
      return page('Juicebox connected', 'Uncle Sam can now pull your Juicebox profiles and tune your Agent on Robin\'s picks. You can close this tab.');
    },

    /**
     * Vercel Cron every 5 minutes (/api/cron/sourcing): the daily profiles, Wrangle's searches, the history pass, posted lists
     * and outreach (sourcing-wire.mjs), apart from the main tick so a long search never holds it up. One at a time (a lease).
     */
    async sourcingTick(request) {
      if (!['GET', 'POST'].includes(request.method)) return methodNotAllowed('GET, POST');
      if (!secretOk(env.CRON_SECRET)) return json({ error: 'cron_not_configured' }, 503);
      const supplied = /^Bearer ([^\s]+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
      if (!supplied || !(await constantTimeSecretEqual(supplied, env.CRON_SECRET))) return json({ error: 'unauthorized' }, 401, { 'www-authenticate': 'Bearer' });
      let config;
      try { config = await configure(); } catch { return json({ error: 'service_not_ready' }, 503); }
      if (!config.DB) return json({ error: 'service_not_configured' }, 503);
      const started = clock();
      const kv = noticeStore(config.DB);
      if (!(await kv.claim('sourcing:lease', { at: started }, started, { maxAgeMs: 6 * 60_000 }))) return json({ ok: true, status: 'skipped', reason: 'in_progress' });
      try {
      // The daily ten for Robin, lists posted in #int-recruitment, and reaching out to his picks (sourcing.mjs, outreach.mjs).
        try {
          const runtime = createRuntime(config, { fetchImpl, clock });
          const masonDm = runtime.routeMap?.project?.channelId ?? null;
          if (masonDm) {
            const s = await runSourcingTick({ env: config, db: config.DB, notion: runtime.notion, claude: runtime.claude, gmail: runtime.gmail, slackRead: runtime.slackRead,
              clay: clayConfigured(config) ? createClayClient({ env: config, fetchImpl }) : null, fetchImpl, clock, log,
              masonPost: (text, threadTs) => masonPoster({ env: config, fetchImpl, channelId: masonDm, threadTs: threadTs ?? null })(text),
              channelPost: (channelId, threadTs, text) => masonPoster({ env: config, fetchImpl, channelId, threadTs })(text) });
            log(`uncle_sam_sourcing ${JSON.stringify(s).slice(0, 900)}`);
          }
        } catch { /* never fails the tick */ }
        // A heartbeat and this run's errors for the morning health check (health.mjs).
        await kv.put('sourcing:last', { at: started }, clock()).catch(() => {});
        await recordFailures(config.DB, healthLines.splice(0), clock()).catch(() => 0);
        return json({ ok: true, status: 'ok' });
      } finally { await kv.del('sourcing:lease').catch(() => {}); }
    },

    /** Wrangle's redirect after Project signs in from his connect link (wrangle.mjs). Says only whether it worked. */
    async wrangleCallback(request) {
      if (request.method !== 'GET') return methodNotAllowed('GET');
      const page = (title, text, status = 200) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
        + `<title>${title}</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.4rem">${title}</h1><p>${text}</p></body>`,
      { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
      const url = new URL(request.url);
      const code = url.searchParams.get('code'), state = url.searchParams.get('state');
      if (!code || !state) return page('Not connected', 'Wrangle did not finish the sign-in. Say "connect wrangle" to Uncle Sam for a fresh link.', 400);
      let config;
      try { config = await configure(); } catch { return page('Not connected', 'Uncle Sam is not ready right now. Try the link again in a minute.', 503); }
      if (!config.DB || !wrangleEnabled(config)) return page('Not connected', 'Uncle Sam is not set up for Wrangle.', 503);
      try { await wrangleAuth({ env: config, db: config.DB, fetchImpl, clock }).complete({ code, state }); }
      catch (error) {
        log(`uncle_sam_wrangle_callback error=${typeof error?.code === 'string' ? error.code : 'failed'}`);
        return page('Not connected', 'This link has expired or was already used. Say "connect wrangle" to Uncle Sam for a fresh one.', 400);
      }
      try {
        const runtime = createRuntime(config, { fetchImpl, clock });
        const channelId = runtime.routeMap?.project?.channelId;
        let check = '';
        try { const session = await wrangleSession({ env: config, db: config.DB, fetchImpl, clock }); const credits = await wrangleCredits({ session, claude: runtime.claude }); check = ` ${wrangleToolCheck(session.tools)}${credits ? ` ${credits}.` : ''}`; }
        catch (error) { check = ` (I couldn't list its tools yet: ${error?.code ?? 'failed'}.)`; }
        if (channelId) await masonPoster({ env: config, fetchImpl, channelId })(`🫡 Wrangle is connected.${check} First I read what's already been said (#int-recruitment, your Wrangle lists, recruiting meetings) for Robin's taste. Then each morning I run ${Number(config.WRANGLE_SEARCHES_PER_DAY) || 2} planned searches (${config.WRANGLE_SEARCH_MODE || 'normal'} mode, about ${Number(config.WRANGLE_DAILY_PROFILES) || 25} profiles each, each from a different angle) and your ten for Robin come at 8:30 AM PT. Posted LinkedIn lists get real names, picks get saved in Wrangle, and emails come from Wrangle first.`);
      } catch { /* connected either way */ }
      return page('Wrangle connected', 'Uncle Sam can now search Wrangle for Robin\'s daily profiles. You can close this tab.');
    },

    /** Unipile webhooks (unipile.mjs): a LinkedIn reply or an accepted invitation, checked by the secret header, handled after the 200. */
    unipileWebhook: request => guarded(request, ['POST'], async config => {
      if (!unipileConfigured(config)) return json({ error: 'not_configured' }, 503);
      if (Number(request.headers.get('content-length') ?? 0) > 500_000) return json({ error: 'too_large' }, 413);
      if (!(await webhookAuthentic(config, request.headers))) return json({ error: 'unauthorized' }, 401);
      const text = await request.text();
      if (text.length > 500_000) return json({ error: 'too_large' }, 413);
      let body;
      try { body = JSON.parse(text); } catch { return json({ error: 'invalid_json' }, 400); }
      const runtime = createRuntime(config, { fetchImpl, clock });
      const masonDm = runtime.routeMap?.project?.channelId ?? null;
      const work = (async () => {
        if (config.UNCLE_SAM_AUTOMATIC_ACTIVITY !== 'enabled' || !masonDm || (await runtime.notion.readControl())?.mode !== 'Live') return log('uncle_sam_unipile skipped=not_live');
        const result = await handleUnipileEvent({ env: config, db: config.DB, body, claude: runtime.claude, notion: runtime.notion, gmail: runtime.gmail, fetchImpl, clock,
          masonPost: (t, threadTs) => masonPoster({ env: config, fetchImpl, channelId: masonDm, threadTs: threadTs ?? null })(t) });
        if (result?.reason && !['not_outreach', 'own_message', 'ignored'].includes(result.reason)) log(`uncle_sam_unipile ${JSON.stringify(result).slice(0, 300)}`);
      })().catch(error => log(`uncle_sam_unipile error=${typeof error?.code === 'string' ? error.code : 'failed'}`));
      scheduleWork(work);
      return json({ ok: true });
    }),

    /** Resolves once every piece of scheduled background work has settled (tests and the local dev server). */
    async idle() { while (background.size) await Promise.allSettled([...background]); },
  });
}
