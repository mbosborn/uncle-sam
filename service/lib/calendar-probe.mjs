/**
 * Before Uncle Sam switches to reading Google Calendar through Project's grant (UNCLE_SAM_CALENDAR_SOURCE = "project"), this
 * checks, at most hourly, what that grant can actually see on each calendar in GOOGLE_CALENDAR_IDS: whether the calendar is
 * readable, how many events ended in the last 36 hours, and whether their guest lists are visible (a calendar shared as
 * free/busy only shows neither). It writes nothing anywhere but its own summary row and a log line. Never throws.
 */
import { noticeStore } from './stuck-rejections.mjs';
import { calendarGranted, googleTokenProvider } from './gmail.mjs';
import { createCalendarReader } from './google-calendar.mjs';
import { clerkInterviewKey } from './agent-runner.mjs';

export const PROBE_EVERY_MS = 3600_000;

/**
 * With `notion` and `interviewerEmails` it also compares, for the last 36 hours, the interviews Uncle Sam would find on the
 * calendars (an interviewer and exactly one Pipeline candidate as guests) with the clerk's interview log, by the shared key.
 */
export async function runCalendarProbe({ env, db, notion = null, interviewerEmails = {}, fetchImpl = globalThis.fetch, clock = Date.now, log = () => {}, force = false }) {
  try {
    if (!db?.prepare || !(await calendarGranted({ db }))) return { state: 'not_granted' };
    const store = noticeStore(db), now = clock();
    const last = await store.get('calendar:probe');
    if (!force && last && now - last.at < PROBE_EVERY_MS && (!notion || last.comparison)) return { state: 'recent', ...last };
    const ids = String(env.GOOGLE_CALENDAR_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
    const reader = createCalendarReader({ tokenProvider: googleTokenProvider({ env, db, fetchImpl, clock }), fetchImpl, clock });
    const calendars = [], found = new Map(), byEmail = new Map();
    const interviewers = new Set(Object.keys(interviewerEmails).map(e => e.toLowerCase()));
    for (const calendarId of ids.slice(0, 10)) {
      try {
        const events = (await reader.listEvents({ calendarId, timeMin: now - 36 * 3600_000, timeMax: now, maxResults: 250 }))
          .filter(e => !e.allDay && e.end && Date.parse(e.end) <= now);
        if (notion) for (const e of events) {
          if (e.status === 'cancelled' || !e.attendees.some(a => interviewers.has(a.email))) continue;
          for (const email of e.attendees.map(a => a.email).filter(x => !x.endsWith('@company.example'))) {
            if (!byEmail.has(email)) { try { byEmail.set(email, await notion.findCandidatesByEmail(email)); } catch { byEmail.set(email, []); } }
            const matches = byEmail.get(email);
            if (matches.length === 1) { const key = clerkInterviewKey(matches[0].pageId, Date.parse(e.end)); found.set(key, matches[0].fullName); break; }
          }
        }
        calendars.push({ calendarId, ok: true, ended: events.length, withGuests: events.filter(e => e.attendees.length > 1).length,
          titled: events.filter(e => e.summary && !/^busy$/i.test(e.summary)).length });
      } catch (error) { calendars.push({ calendarId, ok: false, error: typeof error?.code === 'string' ? error.code : 'failed' }); }
    }
    let comparison = null;
    if (notion) {
      try {
        const logged = new Map((await notion.listInterviewRows({ since: now - 36 * 3600_000 }))
          .filter(r => r.status !== 'cancelled' && r.end && Date.parse(r.end) <= now && /^[0-9a-f-]{36}:/.test(r.id)).map(r => [r.id, r.summary]));
        comparison = { both: [...found.keys()].filter(k => logged.has(k)).length,
          onlyCalendar: [...found].filter(([k]) => !logged.has(k)).map(([k, name]) => `${name} @ ${k.split(':').slice(1).join(':')}`),
          onlyLog: [...logged].filter(([k]) => !found.has(k)).map(([k, name]) => `${name} @ ${k.split(':').slice(1).join(':')}`) };
      } catch (error) { comparison = { error: typeof error?.code === 'string' ? error.code : 'compare_failed' }; }
    }
    const summary = { at: now, calendars, ...(comparison ? { comparison } : {}) };
    await store.put('calendar:probe', summary, now);
    log(`uncle_sam_calendar_probe ${JSON.stringify(summary)}`);
    return { state: 'probed', ...summary };
  } catch (error) { return { state: 'error', error: typeof error?.code === 'string' ? error.code : 'probe_failed' }; }
}
