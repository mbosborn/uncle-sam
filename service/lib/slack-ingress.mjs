import { handleSlackRequest } from './protocol.mjs';
import { createNotionWake } from './notion-wake.mjs';
import { isScheduleThread } from './interview-plan.mjs';
import { isReplyToBot, noteHumanReply } from './thread-memory.mjs';
import { isSourcingThread, looksLikeSourcingReply, SOURCING_CHANNEL, TEAM as SOURCING_TEAM } from './sourcing.mjs';

// Source admission never enables workflows. Live Slack events can never acquire
// fixture status from their text or payload, even while a local test is running.
/** How long a "which one did you mean" question stays open for a bare reply in its thread. */
export const FOLLOW_UP_WINDOW_MS = 24 * 3600_000;

export function createSlackIngress({ env = {}, store, signatureConfig, schedule,
  wakeFactory = createNotionWake, clock = Date.now } = {}) {
  return request => handleSlackRequest(request, signatureConfig, {
    acceptEvent: async input => {
      let event = input;
      // A plain thread reply is kept only as the answer to an open "which one" question in that thread; anything else in a
      // thread is acknowledged and dropped, never stored.
      if (event.type === 'qa_followup') {
        const open = await store.findOpenQuestion({ channelId: event.channelId, threadTs: event.threadTs, since: clock() - FOLLOW_UP_WINDOW_MS });
        // A plain reply under the day's interview schedule ("that's wrong, I'm taking Emery") is kept too: it may update it.
        const scheduleThread = !open && env.DB ? await isScheduleThread(env.DB, event, clock).catch(() => false) : false;
        // A reply to Uncle Sam's own answer in this thread, tagging no one else and with nobody else in between (thread-memory.mjs).
        const toBot = !open && !scheduleThread && env.DB ? await isReplyToBot(env.DB, event, { botUserId: env.SLACK_BOT_USER_ID, now: clock() }).catch(() => false) : false;
        // Picks under a list of profiles (sourcing.mjs): a known list, or a team member's reply that reads like picks in
        // #int-recruitment (the list may be newer than the tick that registers lists; the handler checks the thread).
        const sourcing = !open && !toBot && env.DB && env.UNCLE_SAM_SOURCING !== 'off' ? (await isSourcingThread(env.DB, event).catch(() => false) ? 'known'
          : (event.channelId === (env.UNCLE_SAM_SCHEDULE_CHANNEL || SOURCING_CHANNEL) && SOURCING_TEAM.includes(event.authorId) && looksLikeSourcingReply(event.text) ? 'maybe' : null)) : null;
        if (env.DB) await noteHumanReply(env.DB, event, clock()).catch(() => {});
        if (!open && !scheduleThread && !toBot && !sourcing) return true;
        event = { ...event, type: 'qa_question', followUp: !toBot, ...(toBot ? { threadReply: true } : {}), ...(scheduleThread ? { scheduleThread: true } : {}),
          ...(sourcing === 'known' ? { sourcingThread: true } : sourcing === 'maybe' ? { sourcingMaybe: true } : {}) };
      }
      await store.recordEvent({ ...event, isFixture: false });
      if (env.UNCLE_SAM_AUTOMATIC_ACTIVITY !== 'enabled' || !env.NOTION_TOKEN) return true;
      const control = await store.getControl();
      if (control.mode !== 'Live' || !control.baselineComplete || control.activatedAt == null) return true;
      const stored = await store.getEvent(event.eventId);
      if (!stored || stored.isFixture || stored.occurredAt < control.activatedAt) return true;
      if (typeof schedule !== 'function') throw new Error('wake_scheduler_unavailable');
      schedule(wakeFactory({ env, store })({ eventId: event.eventId, attemptId: crypto.randomUUID() })
        .catch(() => undefined));
      return true;
    },
  });
}
