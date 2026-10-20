/**
 * Looking ahead at check-ins (Project, 2026-10-18: "your job is to organize them and plan around other work trialers and think
 * ahead as more work trialers come on for check ins").
 *
 * Once a day, every trial starting in the next 14 days that has no check-ins yet is placed on paper, earliest start first, on top
 * of Robin's, Interviewer's and Taylor's real calendars (the check-ins already there included) and of each other: each trialer's
 * morning and night check-in, every day, by the same rules as the real ones (checkin-times.mjs). When a day has no time at all,
 * or only the 9:45 PM exception, Project hears once, early, with who and which day, so it can be solved before the trial starts
 * (move a start, share a check-in, free a slot). A trialer whose time zone isn't known is named too. Nothing is created here.
 * UNCLE_SAM_CHECKINS=off stops it.
 */
import { masonConfirmedDates } from './project-trial-dates.mjs';
import { noticeStore } from './stuck-rejections.mjs';
import { addDays } from './takehome-nudge.mjs';
import { nearestAllowed, trialerSlot, trialTimeZone, zonedDate, isLate, SLOT_MS } from './checkin-times.mjs';
import { PEOPLE, MUST, busyOf, ptTime } from './checkins.mjs';
import { locationAskNote } from './trial-location.mjs';

const EVERY_MS = 20 * 3600_000, AHEAD_DAYS = 14;
const dayOnly = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const md = date => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(Date.parse(`${date}T12:00:00Z`));
const nameOf = full => String(full ?? '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/[⭐★]/gu, '').replace(/\s+/g, ' ').trim();
const TENTATIVE = /\b(?:tentative|tbd|tbc|proposed|pending confirmation|to be confirmed)\b/i;

/** Places the coming trials' check-ins on paper. -> [{ candidate, tz, start, end, slots: [{ day, kind, at|null, late }] }] */
export function planAhead({ trials, busy, now }) {
  const sim = Object.fromEntries(Object.entries(busy).map(([k, v]) => [k, [...(v ?? [])]]));
  const out = [];
  for (const t of [...trials].sort((a, b) => a.start.localeCompare(b.start))) {
    const slots = [];
    for (let day = t.start; day <= t.end && slots.length < 42; day = addDays(day, 1)) {
      for (const kind of ['morning', 'night']) {
        const slot = trialerSlot(kind, day, t.tz);
        if (slot.band[1] < now) continue;
        const at = nearestAllowed({ target: slot.target, band: slot.band, comfort: slot.comfort, busy: sim, must: MUST, optional: [PEOPLE.taylor], now });
        slots.push({ day, kind, at, late: at !== null && isLate(at) });
        if (at !== null) for (const email of Object.values(PEOPLE)) sim[email] = [...(sim[email] ?? []), { id: `plan:${t.candidate.pageId}:${day}:${kind}`, start: at, end: at + SLOT_MS, summary: `${nameOf(t.candidate.fullName)}'s ${kind} check-in (planned)` }];
      }
    }
    out.push({ ...t, slots });
  }
  return out;
}

export async function runCheckinForecast({ env = {}, db, notion, calendar, poster, clock = Date.now, force = false, log = () => {} }) {
  const summary = { state: 'off', trials: 0, told: 0, error: null };
  try {
    if (env.UNCLE_SAM_CHECKINS === 'off' || !db?.prepare || typeof notion?.listTrialCandidates !== 'function' || typeof calendar?.listEvents !== 'function' || typeof poster !== 'function') return summary;
    const kv = noticeStore(db), now = clock();
    if (!force && now - ((await kv.get('checkins:forecast:last'))?.at ?? 0) < EVERY_MS) return { ...summary, state: 'not_due' };
    if ((await notion.readControl())?.mode !== 'Live') return { ...summary, state: 'not_live' };
    await kv.put('checkins:forecast:last', { at: now }, now);
    summary.state = 'ran';
    const horizon = new Date(now + AHEAD_DAYS * 86400_000).toISOString().slice(0, 10), today = new Date(now).toISOString().slice(0, 10);
    const trials = [], unknown = [];
    for (const c of await notion.listTrialCandidates()) {
      const f = c.fields ?? {}, start = dayOnly(f['Trial Start']), end = dayOnly(f['Trial End']);
      if (!start || !end || end < start || start > horizon || end < today) continue;
      if (TENTATIVE.test(`${f['Next action'] ?? ''} ${f['Candidate brief'] ?? ''}`) && !(await masonConfirmedDates({ kv, pageId: c.pageId, start, end }))) continue;
      if (await kv.get(`checkins:${c.pageId}`)) continue; // already on the calendars, so already in the busy time
      let notes = [];
      try { notes = (await notion.listCandidateNotes?.({ candidatePageId: c.pageId, since: now - 120 * 86400_000, max: 40 })) ?? []; } catch { notes = []; }
      const { tz } = await trialTimeZone({ candidate: c, kv, notes });
      if (!tz) { unknown.push(c); continue; }
      const theirToday = zonedDate(now, tz);
      trials.push({ candidate: c, tz, start: start > theirToday ? start : theirToday, end });
    }
    summary.trials = trials.length;
    if (!trials.length && !unknown.length) return summary;
    const busy = {};
    for (const email of Object.values(PEOPLE)) {
      try { busy[email] = busyOf(await calendar.listEvents({ calendarId: email, timeMin: now, timeMax: now + (AHEAD_DAYS + 3) * 86400_000, maxResults: 1000 }), email); } catch { busy[email] = null; }
    }
    if (!busy[PEOPLE.robin] || !busy[PEOPLE.interviewer]) return { ...summary, error: 'team_calendar_unreadable' };
    const lines = [];
    for (const p of planAhead({ trials, busy, now })) {
      const none = p.slots.filter(s => s.at === null), late = p.slots.filter(s => s.late);
      if (!none.length && !late.length) continue;
      const key = `checkins:forecast:${p.candidate.pageId}:${none.map(s => `${s.day}${s.kind[0]}`).join(',')}|${late.map(s => `${s.day}${s.kind[0]}`).join(',')}`;
      if (!(await kv.claim(key, { at: now }, now))) continue;
      const bits = [];
      if (none.length) bits.push(`no time fits ${none.map(s => `the ${s.kind} check-in on ${md(s.day)}`).join(', ')}`);
      if (late.length) bits.push(`${late.map(s => `${md(s.day)} ${s.kind}`).join(', ')} only fit${late.length === 1 ? 's' : ''} at ${late.map(s => ptTime(s.at)).filter((v, i, a) => a.indexOf(v) === i).join('/')} PT (past 9:30)`);
      lines.push(`• ${nameOf(p.candidate.fullName)} (${md(p.start)} – ${md(p.end)}): ${bits.join('; ')}.`);
    }
    // Where they are: the same one question the check-in set-up asks (answered in its thread, checkins.mjs handleCheckinTzReply).
    for (const c of unknown) {
      // Their emails and LinkedIn first (trial-location.mjs, Project 2026-10-18); only then Project.
      const extra = await locationAskNote({ kv, pageId: c.pageId, env });
      if (extra === null) continue;
      if (!(await kv.claim(`checkins:ask-tz:${c.pageId}`, { at: now }, now))) continue;
      const ts = await poster(`📅 Where is ${nameOf(c.fullName)} based for the work trial?${extra || " Their emails and LinkedIn don't say."} Reply here with a city or time zone (e.g. "Berlin", "ET") and I'll plan their check-ins.`).catch(() => null);
      if (ts) await kv.put(`checkins:tzask:${ts}`, { pageId: c.pageId, at: now }, now);
      summary.told++;
    }
    if (!lines.length) return summary;
    await poster(`📅 Check-ins that won't fit:\n${lines.join('\n')}\nMove a start or tell me a time.`).catch(() => {});
    summary.told = lines.length;
    return summary;
  } catch (error) {
    summary.error = typeof error?.code === 'string' ? error.code : 'forecast_failed';
    log(`uncle_sam_checkin_forecast ${JSON.stringify(summary)}`);
    return summary;
  }
}
