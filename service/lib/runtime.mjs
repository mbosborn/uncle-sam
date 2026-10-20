/**
 * Composition root for the deployed Worker: builds the store, Notion/Slack/Claude/Calendar adapters,
 * the bounded dispatcher and the runner from env. Routes and the cron handler use only this.
 */
import { withLease, INTERVIEW_FOLLOWUPS_LEASE } from './tick-lease.mjs';
import { sendTrialConfirmation, recordPacketOnTracker } from './work-trial-offer.mjs';
import { parseTemplate } from './takehome-review.mjs';
import { createGroupRoutes } from './group-routes.mjs';
import { PEOPLE, NAMES } from './agent-runner.mjs';
import { masonPoster } from './wispr.mjs';
import { assignmentsReader, readAssignments, refreshSchedules, looksLikeAssignment, SCHEDULE_CHANNEL } from './interview-plan.mjs';
import { createStore } from './store.mjs';
import { createNotionClient } from './notion-client.mjs';
import { createSlackReader } from './slack-read.mjs';
import { createClaudeClient } from './anthropic.mjs';
import { createSlackDispatcher } from './slack-dispatch.mjs';
import { createCalendarReader } from './google-calendar.mjs';
import { createMeetReader, meetConfigured } from './meet.mjs';
import { createSlackUi } from './slack-ui.mjs';
import { createSlackAnswerer } from './slack-answer.mjs';
import { createQuestionAnswerer, questionsEnabled, parseAskers } from './qa.mjs';
import { wisprConfigured } from './wispr.mjs';
import { createGmailSender, gmailConfigured, gmailConnected, googleTokenProvider, calendarWriteGranted, adminUserGranted } from './gmail.mjs';
import { createWorkspaceAdmin } from './accounts.mjs';
import { slackUserConfigured, masonFileDownloader } from './slack-dm-watch.mjs';
import { handleFindAsk, readImageLines, gatherContext } from './person-finder.mjs';
import { clayConfigured, createClayClient } from './clay-pipelines.mjs';
import { imageFilesOf } from './profile-screenshots.mjs';
import { handleTrialRateReply } from './trial-terms.mjs';
import { connectionsOf, healthReport, reportText, looksLikeHealthAsk, googleAdminWorks } from './health.mjs';
import { handleTakeHomeCommand, handleOktaCommand } from './project-commands.mjs';
import { queuePacket, handleCancelCommand } from './email-queue.mjs';
import { handlePasswordReset, RESET_ASK } from './password-reset.mjs';
import { handleCheckinReply, handleCheckinTzReply } from './checkins.mjs';
import { handleOffboardReply } from './offboarding.mjs';
import { handleOffboardNow } from './offboard-now.mjs';
import { handleRestoreAccount, accountAsk } from './restore-account.mjs';
import { handleMasonTrialDates, datesAsk } from './project-trial-dates.mjs';
import { rememberWhichOne, resolveWhichOne, recoverFromThread } from './which-one.mjs';
import { handleMovesReply, runTrackerMove, commandText, moveLabel } from './meeting-moves.mjs';
import { noticeStore } from './stuck-rejections.mjs';
import { handleStuckGo } from './stuck-rejections.mjs';
import { handleOnboardingReply } from './onboarding.mjs';
import { ensureCheckins } from './work-trial.mjs';
import { handleDecisionReply } from './decision-nudges.mjs';
import { handleBookingReply } from './new-bookings.mjs';
import { handleStripeReply } from './stripe-payments.mjs';
import { handleDocusignReply, handleDocusignSend, candidateFinder, createDocusignSender, docusignSendConfigured, docusignConnected, packetOnRecord, paperworkOut, sendWorkTrialPacket, factsOf, rateOf, queueWorkTrialPacket, withFreshDates } from './docusign-send.mjs';
import { handlePreStartReply } from './pre-start-paperwork.mjs';
import { oktaConfigured, createOktaClient, handleOktaGroups } from './okta.mjs';
import { insightfulConfigured, createInsightfulClient } from './insightful.mjs';
import { handleSourcingReply, handleSourcingDm, handleSourcingCommand } from './sourcing.mjs';
import { handleOutreachDm, handleOutreachCommand, handleMasonOutreach } from './outreach.mjs';
import { handleClaySourcingCommand } from './clay-sourcing.mjs';
import { profilesInText } from './sourcing.mjs';
import { sourcingDeps, enqueuer, wrangleDeps } from './sourcing-wire.mjs';
import { handleWrangleCommand, wrangleEnabled } from './wrangle.mjs';
import { handleHistoryCommand } from './taste-history.mjs';
import { handleRoleCommand } from './sourcing-roles.mjs';
import { juiceboxEnabled } from './juicebox.mjs';
import { unipileConfigured, linkedinReady } from './unipile.mjs';
import { createBookingAnswerer } from './booking-lookup.mjs';
import { createAgentRunner, createDispatcherDeps, ROUTE_RECIPIENTS } from './agent-runner.mjs';

const channelPattern = /^[CDG][A-Z0-9]+$/;

/** SLACK_ROUTE_MAP_JSON = {"interviewer_rishi":{"channelId":"D…","type":"im"},"jamie_group":{"channelId":"G…","type":"mpim"},…}. */
export function parseRouteMap(json) {
  if (json == null || json === '') return {};
  let parsed;
  try { parsed = typeof json === 'string' ? JSON.parse(json) : json; } catch { throw new Error('invalid_route_map'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_route_map');
  const map = {};
  for (const [key, route] of Object.entries(parsed)) {
    const recipients = ROUTE_RECIPIENTS[key];
    if (!recipients || !route || typeof route !== 'object' || !channelPattern.test(route.channelId ?? '')) throw new Error('invalid_route_map');
    const type = recipients.length >= 2 ? 'mpim' : 'im';
    if (route.type !== type) throw new Error('invalid_route_map');
    map[key] = { channelId: route.channelId, type };
  }
  return Object.freeze(map);
}

/** Ingress allowlist shape ({im, mpim, group, channel}) derived from the route map. */
export function routesFromMap(map) {
  const routes = { im: [], mpim: [], group: [], channel: [] };
  for (const route of Object.values(map ?? {})) routes[route.type].push(route.channelId);
  for (const type of Object.keys(routes)) routes[type] = [...new Set(routes[type])];
  return routes;
}

export function parseInterviewerEmails(json) {
  if (json == null || json === '') return {};
  let parsed;
  try { parsed = typeof json === 'string' ? JSON.parse(json) : json; } catch { throw new Error('invalid_interviewer_emails'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_interviewer_emails');
  const map = {};
  for (const [email, id] of Object.entries(parsed)) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^[UW][A-Z0-9]+$/.test(String(id))) throw new Error('invalid_interviewer_emails');
    map[email.toLowerCase()] = String(id);
  }
  return Object.freeze(map);
}

/**
 * UNCLE_SAM_CALENDAR_FLOOR = the moment this bot takes over calendar-driven interviewer prompts, e.g. 2026-10-15T14:20:00Z.
 * Interviews that ended earlier belong to whoever handled them before (the hourly Phase 1 task) and are never prompted here.
 * Returns epoch milliseconds, or null when blank. Requires a time zone so a bare date or local time cannot be misread.
 */
export function parseCalendarFloor(value) {
  if (value == null || String(value).trim() === '') return null;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(text)) throw new Error('invalid_calendar_floor');
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) throw new Error('invalid_calendar_floor');
  return ms;
}

/** Which model route the secrets select: Anthropic's own API when its key is set, otherwise OpenRouter when that key is set. */
export function llmRouteOf(env = {}) {
  const set = key => typeof env[key] === 'string' && env[key].length > 0;
  return set('ANTHROPIC_API_KEY') ? 'anthropic' : set('OPENROUTER_API_KEY') ? 'openrouter' : 'none';
}

/** The client settings the secrets select (null when no model key is set); the service and `setup:check` both build their client from this. */
export function llmSettingsOf(env = {}) {
  const route = llmRouteOf(env);
  if (route === 'none') return null;
  const model = route === 'openrouter' ? env.OPENROUTER_MODEL : env.ANTHROPIC_MODEL;
  return { route, apiKey: route === 'openrouter' ? env.OPENROUTER_API_KEY : env.ANTHROPIC_API_KEY, ...(model ? { model } : {}) };
}

export const INTERVIEW_LOG = 'notion-interview-log';
/** "notion" only when asked for by name; anything else means Google Calendar (which stays off without a service account). */
/** notion = the clerk's interview log; project = Google Calendar through Project's own grant (gmail.mjs); google = the service account. */
export const calendarSourceOf = (env = {}) => (env.UNCLE_SAM_CALENDAR_SOURCE === 'notion' ? 'notion' : env.UNCLE_SAM_CALENDAR_SOURCE === 'project' ? 'project' : 'google');

export function describeConfiguration(env = {}) {
  let routes = 0, routeMapValid = true;
  try { routes = Object.keys(parseRouteMap(env.SLACK_ROUTE_MAP_JSON)).length; } catch { routeMapValid = false; }
  return {
    database: !!env.DB, automaticActivity: env.UNCLE_SAM_AUTOMATIC_ACTIVITY === 'enabled' ? 'enabled' : 'off',
    slackSigning: !!env.SLACK_SIGNING_SECRET, slackBot: /^xoxb-[A-Za-z0-9-]+$/.test(env.SLACK_BOT_TOKEN ?? ''),
    slackBotIdentity: !!(env.SLACK_BOT_USER_ID && env.SLACK_BOT_ID), notion: !!env.NOTION_TOKEN, notionWebhook: !!env.NOTION_WEBHOOK_SECRET,
    portalWebhook: !!env.PORTAL_WEBHOOK_SECRET, anthropic: !!env.ANTHROPIC_API_KEY, openrouter: !!env.OPENROUTER_API_KEY, llm: llmRouteOf(env),
    model: (llmRouteOf(env) === 'openrouter' ? env.OPENROUTER_MODEL : env.ANTHROPIC_MODEL) || 'default',
    questions: questionsEnabled(env) ? 'enabled' : 'off',
    questionAskers: !questionsEnabled(env) ? 'n/a' : (() => { const askers = parseAskers(env.UNCLE_SAM_QA_ASKERS); return !askers.valid ? 'invalid' : askers.everyone ? 'everyone' : askers.ids.size; })(),
    wispr: wisprConfigured(env), gmail: gmailConfigured(env), rejectionSender: env.UNCLE_SAM_REJECTION_SENDER === 'uncle-sam' ? 'uncle-sam' : 'notion-agent', calendarSource: calendarSourceOf(env), calendar: !!env.GOOGLE_SERVICE_ACCOUNT_JSON, calendarIds: (env.GOOGLE_CALENDAR_IDS ?? '').split(',').filter(s => s.trim()).length,
    calendarFloor: safe(() => (parseCalendarFloor(env.UNCLE_SAM_CALENDAR_FLOOR) === null ? 'unset' : 'set'), 'invalid'),
    interviewerEmails: Object.keys(safe(() => parseInterviewerEmails(env.INTERVIEWER_EMAILS_JSON), {})).length, routes, routeMapValid,
  };
}
const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

export function createRuntime(env = {}, { fetchImpl = globalThis.fetch, clock = Date.now } = {}) {
  if (!env.DB) throw new Error('service_not_configured');
  const store = createStore(env.DB, { authorized: true, clock });
  const notion = createNotionClient({ env, fetchImpl, clock });
  const routeMap = parseRouteMap(env.SLACK_ROUTE_MAP_JSON);
  const slackRead = /^xoxb-[A-Za-z0-9-]+$/.test(env.SLACK_BOT_TOKEN ?? '') ? createSlackReader({ env, fetchImpl }) : null;
  const llm = llmSettingsOf(env);
  const claude = llm ? createClaudeClient({ ...llm, fetchImpl }) : null;
  // Group DMs for interviewers who took an interview together, opened as needed (group-routes.mjs).
  const groupRoutes = createGroupRoutes({ db: env.DB, env, fetchImpl, clock });
  const deps = createDispatcherDeps({ store, notion, slackRead, routeMap, groupRoutes, clock });
  const dispatcher = createSlackDispatcher({ env, store, routes: routeMap, ...deps, groupRoutes: groupRoutes.routes, fetchImpl, clock });
  // Where ended interviews come from (UNCLE_SAM_CALENDAR_SOURCE): "notion" = the interview log the clerk keeps in Uncle Sam
  // Operations; otherwise Google Calendar through a service account, when one is configured.
  const fromLog = calendarSourceOf(env) === 'notion';
  const calendar = fromLog ? { listEvents: ({ timeMin }) => notion.listInterviewRows({ since: timeMin }) }
    : calendarSourceOf(env) === 'project'
      ? (gmailConfigured(env) && env.DB ? safe(() => createCalendarReader({ tokenProvider: googleTokenProvider({ env, db: env.DB, fetchImpl, clock }), fetchImpl, clock }), null) : null)
    : env.GOOGLE_SERVICE_ACCOUNT_JSON
      ? safe(() => createCalendarReader({ serviceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON, subject: env.GOOGLE_IMPERSONATE_SUBJECT || null, fetchImpl, clock }), null)
      : null;
  const calendarIds = fromLog ? [INTERVIEW_LOG] : (env.GOOGLE_CALENDAR_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const interviewerEmails = parseInterviewerEmails(env.INTERVIEWER_EMAILS_JSON);
  // A malformed value must not take the whole tick down: it reads as "unset", which keeps only the calendar path off (and reported).
  const calendarFloor = safe(() => parseCalendarFloor(env.UNCLE_SAM_CALENDAR_FLOOR), null);
  // @-mention questions are a separate lane with its own switch (UNCLE_SAM_QA) and its own narrow way to post.
  const qa = questionsEnabled(env) ? createQuestionAnswerer({ env, store, notion, slackRead, answerer: createSlackAnswerer({ env, fetchImpl }), claude,
    readImages: files => readImages?.(files) ?? null, clock }) : null;
  const ui = /^xoxb-[A-Za-z0-9-]+$/.test(env.SLACK_BOT_TOKEN ?? '') ? createSlackUi({ env, fetchImpl }) : null;
  // Project's "go" under a stuck-rejection notice (stuck-rejections.mjs).
  const stuckGo = (event, sideEffects) => handleStuckGo({ event, env, db: env.DB, notion, fetchImpl, clock, sideEffects });
  // Jamie's and AA's replies under their work-trial account requests (onboarding.mjs).
  // Thread replies to Uncle Sam's own asks: Jamie's and AA's under their account requests (onboarding.mjs), an interviewer's
  // under a decision check (decision-nudges.mjs), Project's under a new-booking notice (new-bookings.mjs).
  const masonRoute = () => routeMap?.project?.channelId ?? null;
  const onboardingReply = env.DB ? async (event, sideEffects) => {
    const onboarding = await handleOnboardingReply({ event, env, db: env.DB, notion, fetchImpl, clock, sideEffects,
      // The check-ins the moment Jamie or Project says the email exists (work-trial.mjs ensureCheckins, Project 2026-10-18).
      onEmailReady: async candidate => ensureCheckins({ db: env.DB, calendar, candidate, notion, clock, emailReady: true,
        canWrite: typeof calendar?.writeEvent === 'function' && await calendarWriteGranted({ db: env.DB }).catch(() => false),
        poster: masonRoute() ? masonPoster({ env, fetchImpl, channelId: masonRoute() }) : null }) });
    if (onboarding) return onboarding;
    // Project's "send" under the daily profiles, and his word in a person's outreach thread (sourcing.mjs, outreach.mjs).
    if (event.channelId === masonRoute() && event.authorId === PEOPLE.project && event.threadTs && !event.synthetic) {
      const threadPost = threadTs => masonPoster({ env, fetchImpl, channelId: event.channelId, threadTs });
      const daily = await handleSourcingDm({ event, env, db: env.DB, masonId: PEOPLE.project, poster: threadPost, clock, sideEffects,
        channelId: env.UNCLE_SAM_SCHEDULE_CHANNEL || 'C01D1A69CE3',
        channelPoster: masonPoster({ env, fetchImpl, channelId: env.UNCLE_SAM_SCHEDULE_CHANNEL || 'C01D1A69CE3' }) }).catch(() => null);
      if (daily) return daily;
      const said = await handleOutreachDm({ event, env, db: env.DB, masonId: PEOPLE.project, poster: threadPost, fetchImpl, gmail, clock, sideEffects }).catch(() => null);
      if (said) return said;
    }
    // Project's yes / "yes but not 2" under a meeting's list of moves (meeting-moves.mjs, Project 2026-10-18). Tracker moves run
    // here; the rest run as the commands he would have typed, answered in the same thread.
    if (event.channelId === masonRoute() && !event.synthetic) {
      const moves = await handleMovesReply({ event, db: env.DB, masonId: PEOPLE.project, clock, sideEffects,
        poster: threadTs => masonPoster({ env, fetchImpl, channelId: event.channelId, threadTs }),
        run: async (m, ctx) => {
          const tracked = await runTrackerMove({ db: env.DB, notion, move: m, title: ctx.title, source: ctx.source, index: ctx.index, clock });
          if (tracked !== null) return tracked;
          const text = commandText(m);
          if (!text) return `✗ ${ctx.index}. ${moveLabel({ ...m, candidate: { fullName: m.fullName } })}: I don't know how to do that one`;
          const done = await onboardingReply({ ...event, text, synthetic: true, messageTs: `${event.messageTs}`, authorId: PEOPLE.project }, sideEffects);
          return done ? null : `✗ ${ctx.index}. ${moveLabel({ ...m, candidate: { fullName: m.fullName } })}: nothing ran it; say it to me directly`;
        } }).catch(() => null);
      if (moves) return moves;
    }
    const tellMason = masonRoute() ? text => masonPoster({ env, fetchImpl, channelId: masonRoute() })(text) : null;
    const decision = await handleDecisionReply({ event, env, db: env.DB, notion, clock, sideEffects, masonPoster: tellMason,
      poster: (channelId, threadTs) => masonPoster({ env, fetchImpl, channelId, threadTs }) });
    if (decision) return decision;
    const stripeReply = await handleStripeReply({ event, db: env.DB, clock, sideEffects, masonId: PEOPLE.project,
      poster: threadTs => masonPoster({ env, fetchImpl, channelId: event.channelId, threadTs }) });
    if (stripeReply) return stripeReply;
    // Project's answer to "Which one: A or B?" ("the one on the work trial", "Zepto"): his original command runs again for that
    // person (which-one.mjs). Every finder below remembers the options when it has to ask.
    let pinned = null;
    if (event.channelId === masonRoute() && event.authorId === PEOPLE.project) {
      const which = await resolveWhichOne({ db: env.DB, event, clock }).catch(() => null);
      if (which) { event = { ...event, text: which.text }; pinned = async () => which.who; sideEffects.push('which_one_resolved'); }
      // The question was asked before the options were kept: the thread itself says who ("the one on the work trial").
      if (!which && slackRead?.readThread) {
        const again = await recoverFromThread({ event, masonId: PEOPLE.project, finder: candidateFinder({ notion, history: async () => [] }),
          readThread: e => slackRead.readThread({ channelId: e.channelId, threadTs: e.threadTs, limit: 30 }) }).catch(() => null);
        if (again) { event = { ...event, text: again.text }; pinned = async () => again.who; sideEffects.push('which_one_recovered'); }
      }
    }
    const remember = finder => pinned ?? (async (text, ev) => {
      const found = await finder(text, ev);
      if (found?.ambiguous && found.options?.length) await rememberWhichOne({ db: env.DB, event: ev ?? event, text: ev?.text ?? text, options: found.options, clock }).catch(() => {});
      return found;
    });
    // "health check" in Project's DM (health.mjs): the morning check now, always answered.
    if (event.channelId === masonRoute() && event.authorId === PEOPLE.project && looksLikeHealthAsk(event.text)) {
      let mode = null;
      try { mode = (await notion.readControl()).mode ?? null; } catch { mode = null; }
      const connections = await connectionsOf({ db: env.DB, configured: { slackDms: slackUserConfigured(env), docusign: docusignSendConfigured(env), meet: meetConfigured(env), wispr: wisprConfigured(env), okta: oktaConfigured(env), juicebox: juiceboxEnabled(env), wrangle: wrangleEnabled(env), linkedin: unipileConfigured(env) },
        google: gmailConfigured(env) ? gmailConnected({ db: env.DB }).catch(() => undefined) : undefined,
        googleAdmin: gmailConfigured(env) ? googleAdminWorks({ granted: () => adminUserGranted({ db: env.DB }), admin: () => createWorkspaceAdmin({ env, db: env.DB, fetchImpl, clock }) }) : undefined });
      const report = await healthReport({ db: env.DB, now: clock(), mode, connections });
      try { await masonPoster({ env, fetchImpl, channelId: event.channelId, threadTs: event.threadTs ?? null })(reportText(report, { asked: true, now: clock() })); sideEffects.push('health_reply'); } catch { /* the outcome stands */ }
      return { kind: 'health_check', ok: report.ok, problems: report.problems.length };
    }
    // "send Logan the take-home" and "ask AA to set up Arlen's Okta" (project-commands.mjs, Project 2026-10-16).
    if (event.channelId === masonRoute() && event.authorId === PEOPLE.project) {
      const find = remember(candidateFinder({ notion, history: async () => [] }));
      const poster = threadTs => masonPoster({ env, fetchImpl, channelId: event.channelId, threadTs });
      // "its fine, Robin isn't going" / "make it 10 pm" under (or right after) a check-in clash (checkins.mjs).
      // "keep" under an offboarding heads-up holds the suspension (offboarding.mjs).
      const offboard = await handleOffboardReply({ event, db: env.DB, poster, masonId: PEOPLE.project, clock, sideEffects }).catch(() => null);
      if (offboard) return offboard;
      const gatherDm = e => gatherContext({ event: e, privateChat: true, readImages,
        readThread: slackRead ? x => slackRead.readThread({ channelId: x.channelId, threadTs: x.threadTs, limit: 30 }) : null,
        readHistory: slackRead ? x => slackRead.readHistory({ channelId: x.channelId, oldest: `${Math.floor((clock() - 30 * 60_000) / 1000)}.000000`, limit: 10, maxText: 3000 }) : null,
        nameOf: id => (id === PEOPLE.project ? 'Project' : 'someone'), clock });
      // "the trial is the 19th through the 21st": Project's word puts the dates on the record and wakes the setup (project-trial-dates.mjs).
      if (datesAsk(event.text)) {
        const dated = await handleMasonTrialDates({ event, db: env.DB, notion, claude, gather: gatherDm, masonId: PEOPLE.project, poster, clock, sideEffects,
          wake: async () => { const kv = noticeStore(env.DB); for (const k of ['worktrial:last', 'onboarding:last', 'trialtz:last', 'prestart:last']) await kv.put(k, { at: 0 }, clock()); } }).catch(() => null);
        if (dated) return dated;
      }
      // "restore Kendall's account" (deleted within ~20 days or suspended, back on) and "keep Elliot's account" (no delete) (restore-account.mjs).
      if (accountAsk(event.text)) {
        const restored = await handleRestoreAccount({ event, env, db: env.DB, notion, claude, masonId: PEOPLE.project, poster, clock, sideEffects,
          admin: adminForOffboard ? await adminForOffboard() : null, okta: oktaConfigured(env) ? createOktaClient({ env, fetchImpl }) : null, gather: gatherDm }).catch(() => null);
        if (restored) return restored;
      }
      // "mark him withdrew and get rid of all his stuff" (+ a screenshot): withdrawn and accounts suspended now (offboard-now.mjs).
      const offNow = await handleOffboardNow({ event, env, db: env.DB, notion, claude, masonId: PEOPLE.project, poster, clock, sideEffects,
        admin: adminForOffboard ? await adminForOffboard() : null, okta: oktaConfigured(env) ? createOktaClient({ env, fetchImpl }) : null,
        insightful: insightfulConfigured(env) ? createInsightfulClient({ env, fetchImpl }) : null,
        gather: e => gatherContext({ event: e, privateChat: true, readImages,
          readThread: slackRead ? x => slackRead.readThread({ channelId: x.channelId, threadTs: x.threadTs, limit: 30 }) : null,
          readHistory: slackRead ? x => slackRead.readHistory({ channelId: x.channelId, oldest: `${Math.floor((clock() - 30 * 60_000) / 1000)}.000000`, limit: 10, maxText: 3000 }) : null,
          nameOf: id => (id === PEOPLE.project ? 'Project' : 'someone'), clock }) }).catch(() => null);
      if (offNow) return offNow;
      // "Berlin" under "Where is X based for the work trial?": their time zone, then their check-ins (checkin-times.mjs).
      const tzReply = await handleCheckinTzReply({ event, db: env.DB, poster, masonId: PEOPLE.project, clock, sideEffects,
        onZone: async pageId => {
          const candidate = await notion.getCandidate(pageId).catch(() => null);
          if (candidate) await ensureCheckins({ db: env.DB, calendar, candidate, notion, clock, emailReady: true,
            canWrite: typeof calendar?.writeEvent === 'function' && await calendarWriteGranted({ db: env.DB }).catch(() => false),
            poster: masonRoute() ? masonPoster({ env, fetchImpl, channelId: masonRoute() }) : null });
        } }).catch(() => null);
      if (tzReply) return tzReply;
      // "cancel Priya": whatever is still waiting to go to her doesn't (email-queue.mjs).
      const cancel = await handleCancelCommand({ event, db: env.DB, findCandidate: find, poster, masonId: PEOPLE.project, clock, sideEffects }).catch(() => null);
      if (cancel) return cancel;
      // "$150" under "What's the daily rate for X?" (trial-terms.mjs).
      // His reply is his word: a send he cancelled earlier goes again (force); the offer it answers loses its buttons.
      const rateReply = await handleTrialRateReply({ event, db: env.DB, notion, poster, masonId: PEOPLE.project, clock, sideEffects,
        sendPacket: packets ? ({ candidate, rate, force }) => packets.send({ who: factsOf(candidate), rate, force }) : null,
        onAnswered: (offerKey, line) => runnerRef?.closePacketOffer?.(offerKey, line) }).catch(() => null);
      if (rateReply) return rateReply;
      const checkin = await handleCheckinReply({ event, db: env.DB, calendar, notion, gmail, poster, masonId: PEOPLE.project, clock, sideEffects }).catch(() => null);
      if (checkin) return checkin;
      // Okta by API once the key is in (okta.mjs): "okta groups: ..." picks the hire groups; the Okta ask then sets it up directly.
      const oktaClient = oktaConfigured(env) ? createOktaClient({ env, fetchImpl }) : null;
      // Sourcing and outreach settings (sourcing.mjs, outreach.mjs): "connect juicebox", "sourcing brief: ...", "outreach status".
      // "sourcing role: <name> - <brief>", "sourcing roles" (sourcing-roles.mjs): before the others, which also start with "sourcing".
      const roleCmd = env.UNCLE_SAM_SOURCING === 'off' ? null : await handleRoleCommand({ event, db: env.DB, masonId: PEOPLE.project, poster, clock, sideEffects }).catch(() => null);
      if (roleCmd) return roleCmd;
      const sDeps = sourcingDeps({ env, db: env.DB, notion, claude, fetchImpl, clock });
      const sourcingCmd = await handleSourcingCommand({ event, env, db: env.DB, masonId: PEOPLE.project, poster, clock, sideEffects,
        connectText: sDeps.connectText, createAgent: sDeps.createAgent }).catch(() => null);
      if (sourcingCmd) return sourcingCmd;
      const outreachCmd = await handleOutreachCommand({ event, env, db: env.DB, masonId: PEOPLE.project, poster, clock, sideEffects }).catch(() => null);
      if (outreachCmd) return outreachCmd;
      const historyCmd = await handleHistoryCommand({ event, env, db: env.DB, masonId: PEOPLE.project, poster, clock, sideEffects }).catch(() => null);
      if (historyCmd) return historyCmd;
      const wrangleCmd = await handleWrangleCommand({ event, env, db: env.DB, masonId: PEOPLE.project, poster, fetchImpl, clock, claude, sideEffects }).catch(() => null);
      if (wrangleCmd) return wrangleCmd;
      const clayCmd = await handleClaySourcingCommand({ event, env, db: env.DB, masonId: PEOPLE.project, poster, clock, sideEffects }).catch(() => null);
      if (clayCmd) return clayCmd;
      const masonReach = await handleMasonOutreach({ event, env, db: env.DB, notion, claude, masonId: PEOPLE.project, poster, clock, sideEffects, profilesOf: profilesInText,
        enqueue: enqueuer({ env, db: env.DB, notion, gmail, claude, fetchImpl, clock }), account: await linkedinReady({ env, db: env.DB }).catch(() => null) }).catch(() => null);
      if (masonReach) return masonReach;
      const oktaGroups = await handleOktaGroups({ event, env, db: env.DB, masonId: PEOPLE.project, okta: oktaClient, poster, clock, sideEffects }).catch(() => null);
      if (oktaGroups) return oktaGroups;
      // "reset Rowan's password": a new one-time Google password, the sign-in emailed in their thread (password-reset.mjs).
      if (RESET_ASK.test(String(event.text ?? ''))) {
        const pw = await handlePasswordReset({ event, db: env.DB, findCandidate: find, admin: adminForOffboard ? await adminForOffboard() : null, gmail,
          masonId: PEOPLE.project, poster, clock, sideEffects }).catch(() => null);
        if (pw) return pw;
      }
      const okta = await handleOktaCommand({ event, env, db: env.DB, notion, findCandidate: find, poster, masonId: PEOPLE.project, routeMap, fetchImpl, clock, sideEffects, okta: oktaClient });
      if (okta) return okta;
      const takeHome = await handleTakeHomeCommand({ event, db: env.DB, findCandidate: find, poster, masonId: PEOPLE.project, clock, sideEffects,
        startTakeHome: (who, text) => runnerRef.takeHomeFromRecap({ candidatePageId: who.pageId, by: 'Project', quote: String(text ?? '').slice(0, 300).padEnd(6, '.'), holdMs: 0 }) });
      if (takeHome) return takeHome;
    }
    // "resend" / "send" under the day-before unsigned-documents message (pre-start-paperwork.mjs, Project 2026-10-17).
    if (event.channelId === masonRoute() && event.authorId === PEOPLE.project && event.threadTs && event.threadTs !== event.messageTs) {
      const dsSender = docusignSendConfigured(env) ? createDocusignSender({ env, db: env.DB, fetchImpl, clock }) : null;
      const threadPoster = threadTs => masonPoster({ env, fetchImpl, channelId: event.channelId, threadTs });
      const whoOf = async ask => {
        try { const c = await notion.getCandidate(ask.pageId); if (c?.email) return factsOf(c); } catch { /* the ask's own facts */ }
        return { pageId: ask.pageId, fullName: ask.name, email: ask.email, dailyRate: null };
      };
      const preStart = await handlePreStartReply({ event, db: env.DB, masonId: PEOPLE.project, clock, sideEffects, poster: threadPoster,
        resend: async (ask, ev) => {
          const who = await whoOf(ask);
          return handleDocusignReply({ event: { ...ev, text: `resend ${ask.name}'s DocuSign` }, env, db: env.DB, masonId: PEOPLE.project, clock, sideEffects, sender: dsSender,
            findCandidate: async () => who, poster: threadPoster, sendFresh: packets ? w => packets.send({ who: w, rate: null, force: true }) : null });
        },
        send: async (ask, ev) => {
          if (!packets) { await threadPoster(ev.threadTs)("📋 I can't send DocuSigns yet: DocuSign access for me isn't connected.").catch(() => {}); return { kind: 'prestart_send', reason: 'not_connected' }; }
          const out = await packets.send({ who: await whoOf(ask), rate: rateOf(ev.text), force: true });
          await threadPoster(ev.threadTs)(out.text).catch(() => {});
          return { kind: 'prestart_send', reason: out.reason };
        } }).catch(() => null);
      if (preStart) return preStart;
    }
    // "Resend Morgan's DocuSign" (docusign-send.mjs): only Project, only in his DM with Uncle Sam.
    if (event.channelId === masonRoute()) {
      const docusign = await handleDocusignReply({ event, env, db: env.DB, masonId: PEOPLE.project, clock, sideEffects,
        sender: docusignSendConfigured(env) ? createDocusignSender({ env, db: env.DB, fetchImpl, clock }) : null,
        findCandidate: remember(candidateFinder({ notion, history: async e => {
          if (!slackRead) return [];
          const before = e.threadTs && e.threadTs !== e.messageTs ? null : e.messageTs;
          const list = e.threadTs && e.threadTs !== e.messageTs
            ? await slackRead.readThread?.({ channelId: e.channelId, threadTs: e.threadTs }) ?? []
            : await slackRead.readHistory({ channelId: e.channelId, latest: before, oldest: String((Number(e.messageTs) - 6 * 3600).toFixed(6)), limit: 15 });
          return list.filter(m => m.ts !== e.messageTs && (m.botId || m.user === env.SLACK_BOT_USER_ID)).reverse();
        } })),
        poster: threadTs => masonPoster({ env, fetchImpl, channelId: event.channelId, threadTs }),
        sendFresh: packets ? who => packets.send({ who, rate: null, force: true }) : null });
      if (docusign) return docusign;
      const packet = await handleDocusignSend({ event, env, db: env.DB, masonId: PEOPLE.project, clock, sideEffects, afterSend: input => (confirmTrial ? confirmTrial(input) : ''),
        afterAddendum: ({ who, rate, envelopeId }) => recordPacketOnTracker({ notion, who, rate, addendum: true, addendumOnly: true, envelopeId, now: clock() }),
        sender: docusignSendConfigured(env) ? createDocusignSender({ env, db: env.DB, fetchImpl, clock }) : null,
        findCandidate: remember(candidateFinder({ notion, history: async () => [] })),
        threadRoot: async e => {
          if (!slackRead?.readThread) return null;
          const list = await slackRead.readThread({ channelId: e.channelId, threadTs: e.threadTs }) ?? [];
          return list.find(m => m.ts === e.threadTs) ?? null;
        },
        poster: threadTs => masonPoster({ env, fetchImpl, channelId: event.channelId, threadTs }) });
      if (packet) return packet;
    }
    return handleBookingReply({ event, db: env.DB, notion, clock, sideEffects,
      poster: threadTs => masonPoster({ env, fetchImpl, channelId: event.channelId, threadTs }) });
  } : null;
  // Uncle Sam's own sending from Project's Gmail (gmail.mjs): null unless configured; then it still needs Project's one-time grant.
  const gmail = safe(() => createGmailSender({ env, db: env.DB, fetchImpl, clock }), null);
  // What a candidate wrote about when they'll do the take-home (reply-watch.mjs keeps it), for the reminder's timing.
  const takeHomePlanOf = env.DB ? pageId => noticeStore(env.DB).get(`takehome-plan:${pageId}`) : null;
  // Who takes which coming interview, as stated in a recruiting meeting, a team DM or by Project to Uncle Sam (interview-plan.mjs).
  const assignmentsOf = env.DB ? assignmentsReader(env.DB) : null;
  let runnerRef = null;
  const refresh = () => refreshSchedules({ env, db: env.DB, runner: runnerRef, fetchImpl, clock });
  const masonAssignments = env.DB && claude ? async text => {
    const assigned = await readAssignments({ db: env.DB, claude, runner: runnerRef, text, source: 'project-dm', context: 'Project, in his DM with Uncle Sam', clock });
    if (assigned.length) await refresh();
    return assigned;
  } : null;
  // A teammate saying who takes an interview, in Project's DM or tagging Uncle Sam in the schedule's channel: kept, the posted
  // schedule edited, and a short reply where they said it.
  const scheduleChannel = env.UNCLE_SAM_SCHEDULE_CHANNEL || SCHEDULE_CHANNEL;
  const scheduleUpdate = env.DB && claude ? async (event, sideEffects) => {
    const author = Object.entries(PEOPLE).find(([, id]) => id === event.authorId)?.[0];
    const text = String(event.text ?? '').replace(/<@[A-Z0-9]+(?:\|[^>]*)?>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!author || !looksLikeAssignment(text)) return null;
    if (event.type === 'qa_question' && event.channelId !== scheduleChannel) return null;
    const who = author === 'interviewer' ? 'Interviewer' : author === 'aa' ? 'AA' : author[0].toUpperCase() + author.slice(1);
    const assigned = await readAssignments({ db: env.DB, claude, runner: runnerRef, text: `${who}: ${text}`, source: `slack:${event.channelId}:${event.messageTs}`,
      context: `${who}, ${event.type === 'qa_question' ? 'in #int-recruitment' : 'in a DM with Uncle Sam'}`, clock });
    if (!assigned.length) {
      // Under the schedule post, someone plainly changing an interview without saying which one is asked which. Anywhere else
      // a tagged message that is not an assignment is a question or a request, and goes on to be answered (2026-10-16).
      if (event.type !== 'qa_question' || event.scheduleThread !== true) return null;
      try { await masonPoster({ env, fetchImpl, channelId: event.channelId, threadTs: event.threadTs ?? event.messageTs })('🫡 Which interview? Give me the time or the candidate and I\'ll fix the schedule.'); } catch { /* nothing changed */ }
      return { kind: 'interview_assignment', assigned: 0, asked: true };
    }
    const refreshed = await refresh();
    sideEffects.push('interview_assignment');
    const names = ids => ids.map(id => (Object.entries(PEOPLE).find(([, v]) => v === id)?.[0] ?? '')).map(n => n === 'interviewer' ? 'Interviewer' : n === 'aa' ? 'AA' : n.charAt(0).toUpperCase() + n.slice(1)).join(' and ');
    const lines = assigned.map(a => `${names(a.ids)} on ${a.event.when}${a.event.candidate ? ` (${a.event.candidate.fullName})` : ''}`).join('; ');
    // Project, 2026-10-16: the answer is just "Updated 🫡" (the edited schedule shows the rest).
    void lines;
    const reply = 'Updated 🫡';
    try { await masonPoster({ env, fetchImpl, channelId: event.channelId, threadTs: event.type === 'qa_question' ? (event.threadTs ?? event.messageTs) : (event.threadTs ?? null) })(reply); } catch { /* the update stands */ }
    return { kind: 'interview_assignment', assigned: assigned.length, edited: refreshed.edited };
  } : null;
  // Calendar questions in a teammate's DM or with a tag: a booking's time, a teammate's day, who is booked (booking-lookup.mjs).
  const findBooking = claude && calendar && !fromLog && calendarIds.length && env.UNCLE_SAM_BOOKING_LOOKUP !== 'off'
    ? createBookingAnswerer({ env, claude, calendar, calendarIds, interviewerEmails, fetchImpl, clock, log: line => console.log(line) }) : null;
  const bookingQuestion = findBooking ? async (event, sideEffects) => {
    const found = await findBooking(event);
    if (!found) return null;
    const threadTs = event.type === 'qa_question' ? (event.threadTs ?? event.messageTs) : (event.threadTs ?? null);
    try { await masonPoster({ env, fetchImpl, channelId: event.channelId, threadTs })(found.text); sideEffects.push('booking_answer'); } catch { return null; }
    return { kind: 'booking_answer', reason: found.kind === 'schedule' ? 'schedule' : found.found ? 'found' : found.names?.length ? 'not_found' : 'no_name' };
  } : null;
  // Uncle Sam's Clay desk (person-finder.mjs, Project 2026-10-17): "@Uncle Sam find him", or any find / research ask in a DM with
  // him, or naming him in a group DM. Reads the thread or the DM's recent messages, forwarded emails and screenshots, Project's
  // Gmail where Project is in the conversation, and every Clay function. Answers in place; nothing is written anywhere.
  const findTeam = new Set([...Object.values(PEOPLE), ...String(env.UNCLE_SAM_FIND_PEOPLE ?? '').split(',').map(x => x.trim()).filter(x => /^U[A-Z0-9]+$/.test(x))]);
  const masonConvos = new Set([routeMap?.project?.channelId, routeMap?.jamie_group?.channelId, routeMap?.aa_group?.channelId].filter(Boolean));
  // Screenshots: the bot's own token first (if it has files:read), then Project's read-only grant (conversations he is in).
  const tokenDownload = async (file, token) => {
    const url = String(file?.url_private_download ?? file?.url_private ?? '');
    if (!token || !/^https:\/\/files\.slack\.com\//.test(url)) return null;
    const response = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` }, redirect: 'follow', signal: AbortSignal.timeout(20_000) });
    const type = String(response.headers.get('content-type') ?? '').split(';')[0].trim();
    if (!response.ok || !type.startsWith('image/')) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    return bytes.length && bytes.length <= 4_500_000 ? { base64: bytes.toString('base64'), mediaType: file.mimetype ?? type } : null;
  };
  const masonDownload = slackUserConfigured(env) ? masonFileDownloader({ env, db: env.DB, fetchImpl, clock }) : null;
  const readImages = claude ? async files => {
    const images = imageFilesOf({ files }).slice(0, 2);
    if (!images.length) return [];
    const lines = [];
    let opened = 0;
    for (const f of images) {
      const img = await tokenDownload(f, env.SLACK_BOT_TOKEN).catch(() => null) ?? (masonDownload ? await masonDownload(f).catch(() => null) : null);
      if (!img) continue;
      opened++;
      lines.push(...await readImageLines({ claude, ...img }).catch(() => []));
    }
    return opened ? lines : null;
  } : null;
  // Google admin once Project granted it (gmail.mjs): for "remove him" (offboard-now.mjs, suspends) and "restore X's account" (restore-account.mjs).
  const adminForOffboard = env.DB && gmailConfigured(env) ? async () => (await adminUserGranted({ db: env.DB }).catch(() => false) ? createWorkspaceAdmin({ env, db: env.DB, fetchImpl, clock }) : null) : null;
  const personFind = claude && env.DB && clayConfigured(env) && env.UNCLE_SAM_FIND !== 'off' ? async (event, sideEffects, deadline) => {
    const dm = /^D/.test(event.channelId ?? '');
    let privateChat = dm || event.channelType === 'mpim' || event.channelType === 'im';
    if (!privateChat && event.type === 'qa_question' && slackRead?.conversationInfo) {
      try { const info = await slackRead.conversationInfo(event.channelId); privateChat = info.isIm || info.isMpim; } catch { privateChat = false; }
    }
    const where = event.type === 'qa_question' ? (dm ? 'dm' : 'tagged') : dm ? 'dm' : 'group';
    const name = id => (id && id === env.SLACK_BOT_USER_ID ? 'Uncle Sam' : NAMES[id] ? (NAMES[id] === 'aa' ? 'AA' : NAMES[id].charAt(0).toUpperCase() + NAMES[id].slice(1)) : 'a teammate');
    const replyThreadTs = event.type === 'qa_question' ? (event.threadTs ?? event.messageTs) : (event.threadTs ?? null);
    const found = await handleFindAsk({ env, db: env.DB, event, where, privateChat, gmailOk: !!gmail && (event.authorId === PEOPLE.project || masonConvos.has(event.channelId)),
      claude, clay: createClayClient({ env, fetchImpl }), notion, gmail, team: findTeam, nameOf: name, replyThreadTs,
      readThread: slackRead ? e => slackRead.readThread({ channelId: e.channelId, threadTs: e.threadTs, limit: 30 }) : null,
      readHistory: slackRead ? e => slackRead.readHistory({ channelId: e.channelId, oldest: `${Math.floor((clock() - 6 * 3600_000) / 1000)}.000000`, limit: 20, maxText: 3000 }) : null,
      readImages, clock, deadline: Number.isFinite(deadline) ? deadline - 20_000 : Date.now() + 150_000,
      post: text => masonPoster({ env, fetchImpl, channelId: event.channelId, threadTs: replyThreadTs })(text) });
    if (!found) return null;
    sideEffects.push('person_find');
    return { kind: 'person_find', reason: found.pending ? 'pending' : found.duplicate ? 'duplicate' : 'answered' };
  } : null;
  // Interviewers' Google Meet records, read-only, for whoever has connected theirs (meet.mjs). Interviewer shows as "J Quinn Foster".
  const meet = !fromLog && meetConfigured(env) && env.DB ? safe(() => createMeetReader({ env, db: env.DB, fetchImpl, clock,
    directoryToken: googleTokenProvider({ env, db: env.DB, fetchImpl, clock }), names: { 'quinn@company.example': ['J Quinn Foster', 'Quinn Foster'], 'robin@company.example': ['Robin Cooper'] } }), null) : null;
  // The confirmation email that goes with every packet Uncle Sam sends (work-trial-offer.mjs sendTrialConfirmation).
  // On the tap that sends the packet: the tracker updated at once (Project, 2026-10-16), then the confirmation email.
  const confirmTrial = env.DB ? async ({ who, rate, addendum, envelopeId }) => {
    const tracker = await recordPacketOnTracker({ notion, who, rate, addendum, envelopeId, now: clock() });
    const email = await sendTrialConfirmation({ gmail, notion, kv: noticeStore(env.DB), parseTemplate, who, rate, addendum, envelopeId, now: clock(), log: line => console.log(line) });
    return [tracker, email].filter(Boolean).join(' ');
  } : null;
  // The work-trial packet on Project's tap (work-trial-offer.mjs, docusign-send.mjs).
  const packets = env.DB && docusignSendConfigured(env) ? Object.freeze({
    ready: () => docusignConnected({ db: env.DB }),
    onRecord: email => packetOnRecord({ db: env.DB, email }),
    // What anyone already sent them in DocuSign (the packet, the pay terms): no offer for what's already out.
    outElsewhere: async email => paperworkOut(await createDocusignSender({ env, db: env.DB, fetchImpl, clock }).envelopesFor(email)),
    // Every send waits 30 minutes in the email queue (email-queue.mjs, Project 2026-10-20), unless it's already out.
    // `force` only on a person's explicit word (a push-through, Project's tap, his rate reply or command): it re-queues a send he
    // cancelled; without it a cancelled one stays cancelled ({ reason: 'cancelled' }, said nowhere: he cancelled it).
    send: ({ who, rate, force = false }) => queueWorkTrialPacket({ db: env.DB, who, rate, force, clock, queue: queuePacket,
      envelopesFor: email => createDocusignSender({ env, db: env.DB, fetchImpl, clock }).envelopesFor(email) }),
    // The record read again at send time: the dates as they are now, not as they were when it was queued 30 minutes earlier.
    sendNow: async ({ who, rate }) => sendWorkTrialPacket({ env, db: env.DB, sender: createDocusignSender({ env, db: env.DB, fetchImpl, clock }), who: await withFreshDates({ notion, who }), rate, clock, afterSend: confirmTrial,
      afterAddendum: ({ who: w, rate: r, envelopeId }) => recordPacketOnTracker({ notion, who: w, rate: r, addendum: true, addendumOnly: true, envelopeId, now: clock() }) }),
  }) : null;
  // Picks under a list of profiles in #int-recruitment (sourcing.mjs): verdicts kept, picks reached out to (outreach.mjs).
  const sourcingReply = env.DB ? async (event, sideEffects) => handleSourcingReply({ event, env, db: env.DB, claude, clock, sideEffects,
    poster: threadTs => masonPoster({ env, fetchImpl, channelId: event.channelId, threadTs }),
    enqueue: enqueuer({ env, db: env.DB, notion, gmail, claude, fetchImpl, clock }), feedback: sourcingDeps({ env, db: env.DB, notion, claude, fetchImpl, clock }).feedback,
    resolve: wrangleDeps({ env, db: env.DB, claude, fetchImpl, clock }).resolve,
    readThread: slackRead?.readThread ? args => slackRead.readThread(args) : null }) : null;
  const runner = createAgentRunner({ env, store, claude, notion, slackRead, dispatcher, routeMap, qa, ui, stuckGo, onboardingReply, sourcingReply, gmail, takeHomePlanOf, fetchImpl, calendar, calendarIds, calendarFloor, interviewerEmails, assignmentsOf, masonAssignments, scheduleUpdate, bookingQuestion, personFind, groupRoutes, meet, packets, clock,
    serialize: env.DB ? fn => withLease(env.DB, INTERVIEW_FOLLOWUPS_LEASE, fn, { now: clock() }) : null });
  runnerRef = runner;
  return Object.freeze({ store, notion, slackRead, claude, dispatcher, runner, qa, routeMap, groupRoutes, calendar, calendarIds, calendarFloor, interviewerEmails, meet, gmail, packets });
}

/**
 * Scheduled entry point (Cloudflare cron or the Vercel cron route). Never throws; one bounded log line
 * without secrets. `deadline` (epoch ms) makes the runner stop starting work before the platform's
 * function time limit, so a slow tick backs off instead of being killed mid-claim.
 */
export async function runScheduled(env, controller, { log = console.log, fetchImpl, clock, deadline } = {}) {
  const now = Number.isFinite(controller?.scheduledTime) ? controller.scheduledTime : Date.now();
  let result;
  try { result = await createRuntime(env, { fetchImpl, clock }).runner.runTick({ now, deadline }); }
  catch (error) { result = { status: 'failed', reason: typeof error?.code === 'string' ? error.code : (error?.message ?? 'tick_failed').slice(0, 120) }; }
  const s = result.summary ?? {};
  // Why each calendar interview was or wasn't prompted, compact (no names): "<event id prefix>:<reason or action>".
  const why = (s.prompts ?? []).slice(0, 30).map(p => `${String(p?.eventId ?? p?.calendarId ?? Object.keys(p ?? {})[0] ?? '?').slice(0, 10)}:${String(p?.reason ?? p?.action ?? p?.error ?? '?').replace(/[^\w:.-]/g, '').slice(0, 40)}`).join(',');
  if (why) log(`uncle_sam_prompts ${why}`);
  log(`uncle_sam_tick status=${result.status} reason=${result.reason ?? '-'} mode=${s.control?.mode ?? '-'} events=${s.events?.length ?? 0} prompts=${s.prompts?.length ?? 0} dispatched=${s.dispatched?.length ?? 0} swept=${s.swept ?? 0} errors=${(s.errors ?? []).length}${(s.errors ?? []).length ? ` (${(s.errors ?? []).slice(0, 5).map(e => String(e).replace(/[^\w:.-]/g, '').slice(0, 60)).join(',')})` : ''}`);
  return result;
}
