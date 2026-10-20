import { zonedWall } from './checkin-times.mjs';

export const firstLockKey = pageId => `checkin:first:${pageId}`;
export const dayOnly = value => typeof value === 'string' ? value.slice(0, 10) : value?.start?.slice(0, 10);
export function isFirstCheckin(event, lock) {
  if (!lock) return false;
  if (lock.unknown) return true; // Cannot establish the first occurrence: never guess which one may move.
  if (event.id === lock.eventId) return true;
  const original = Date.parse(event.originalStart ?? event.original_start_time ?? event.start);
  const suffix = new Date(lock.originalAt ?? lock.at).toISOString().replace(/[-:]/g, '').replace('.000', '');
  return event.id === `${lock.seriesId}_${suffix}`
    || (event.recurringEventId === lock.seriesId && original === (lock.originalAt ?? lock.at));
}

/** Legacy registrations need a historical first occurrence, not simply the next future meeting. */
export async function establishFirstLock({ kv, reg, candidate, calendar, now }) {
  const key = firstLockKey(reg.pageId), old = await kv.get(key);
  if (old) return old;
  const start = dayOnly(candidate?.fields?.['Trial Start']) ?? reg.start;
  if (!start || !reg.tz) return { unknown: true };
  const ids = [...reg.series.map(s => s.eventId).filter(Boolean), ...(reg.extra ?? [])];
  const events = await calendar.listEvents({ calendarId: 'project@company.example',
    timeMin: zonedWall(start, reg.tz, 0) - 86400_000,
    timeMax: zonedWall(start, reg.tz, 0) + 3 * 86400_000, maxResults: 1000 });
  if (!Array.isArray(events) || events.length >= 1000) return { unknown: true };
  const first = events.filter(e => e.status !== 'cancelled' && !e.allDay
    && ids.some(id => e.id === id || e.recurringEventId === id || String(e.id).startsWith(`${id}_`)))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0];
  if (!first || !Number.isFinite(Date.parse(first.start))) return { unknown: true };
  const lock = { pageId: reg.pageId, eventId: first.id, seriesId: first.recurringEventId ?? first.id,
    at: Date.parse(first.start), end: Date.parse(first.end), originalAt: Date.parse(first.originalStart ?? first.start),
    tz: reg.tz, start, trialEnd: dayOnly(candidate?.fields?.['Trial End']) ?? reg.end,
    establishedAt: now, source: 'legacy_calendar_baseline', emailEligible: false };
  await kv.claim(key, lock, now);
  return await kv.get(key);
}
