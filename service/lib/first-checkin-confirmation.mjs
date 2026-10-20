import { noticeStore } from './stuck-rejections.mjs';
import { firstLockKey, isFirstCheckin, dayOnly } from './first-checkin-lock.mjs';
import { busyOf, MUST, PEOPLE } from './checkins.mjs';
import { teamBoundsOn, zonedDate, zonedHM, zonedWall, trialerSlot, trialTimeZone } from './checkin-times.mjs';
import { datesAgreed } from './work-trial.mjs';
import { addDays } from './takehome-nudge.mjs';
import { HOLD_MS, holdReason } from './email-queue.mjs';

export const FIRST_CHECKIN_VERSION = '2026-10-20.1';
export const MIN_FIRST_NOTICE_MS = 12 * 3600_000;
export const confirmationKey = lock => `checkin:confirmation:${lock.pageId}:${lock.at}${lock.revision ? `:${lock.revision.id}` : ''}`;
const stamp = (at, tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', year: 'numeric',
  month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(at);
const fail = code => { throw Object.assign(new Error(code), { code }); };
async function currentZone(candidate, kv, notion, now) {
  const notes = typeof notion?.listCandidateNotes === 'function'
    ? await notion.listCandidateNotes({ candidatePageId: candidate.pageId, since: now - 120 * 86400_000, max: 40 }) : [];
  return (await trialTimeZone({ candidate, kv, notes })).tz;
}
function noticeWindow(lock, now) {
  const hour = Number(zonedHM(now, lock.tz).slice(0, 2));
  if (hour >= 9 && hour < 21) return true;
  const morning = zonedWall(addDays(zonedDate(now, lock.tz), hour >= 21 ? 1 : 0), lock.tz, 9);
  if (lock.at - morning < MIN_FIRST_NOTICE_MS) fail('first_notice_too_short');
  return false;
}
const explanations = {
  first_notice_too_short: 'there are fewer than 12 hours to give them clear notice',
  first_team_conflict: 'a required interviewer has a calendar conflict',
  first_invite_changed: 'the live invitation differs from the locked time',
  trial_dates_changed: 'the agreed trial dates and locked meeting no longer match',
  trial_dates_unconfirmed: 'the trial dates are not confirmed',
  first_meet_link_missing: 'the invitation has no verified meeting link',
  first_guests_not_ready: 'the candidate or required team invitations are missing or declined',
  existing_first_email_needs_reconciliation: 'a first-check-in email was already sent and needs to be reconciled',
  first_outside_candidate_hours: 'the meeting falls outside the candidate’s check-in hours',
  first_outside_team_hours: 'the meeting falls outside the team’s scheduling rules',
};

/** A sent promise comes from this exact read-back occurrence, never a series target or model-generated time. */
export async function checkFirstMeeting({ lock, reg, candidate, workEmail, calendar, now }) {
  if (!lock || lock.unknown || !lock.tz || !Number.isFinite(lock.at) || lock.end <= lock.at) fail('first_time_unknown');
  if (!candidate?.email || candidate.archived || ['Closed', 'Hired'].includes(candidate.fields?.Stage)
    || ['On Hold', 'Not Selected', 'Withdrawn or Unavailable'].includes(candidate.fields?.Outcome)) fail('candidate_not_active');
  if (dayOnly(candidate.fields?.['Trial Start']) !== lock.start || dayOnly(candidate.fields?.['Trial End']) !== lock.trialEnd) fail('trial_dates_changed');
  if (!/^[^\s@]+@company\.example$/i.test(workEmail ?? '')) fail('work_email_unverified');
  if (lock.at - now < MIN_FIRST_NOTICE_MS) fail('first_notice_too_short');
  const kind = lock.kind ?? reg.series.find(s => s.eventId === lock.seriesId)?.kind;
  const localDay = kind === 'night' && Number(zonedHM(lock.at, lock.tz).slice(0, 2)) < 5
    ? addDays(zonedDate(lock.at, lock.tz), -1) : zonedDate(lock.at, lock.tz);
  if (localDay < lock.start || localDay > lock.trialEnd) fail('first_outside_trial_dates');
  const from = lock.at - 86400_000, to = lock.end + 86400_000;
  const read = async calendarId => {
    const rows = await calendar.listEvents({ calendarId, timeMin: from, timeMax: to, maxResults: 1000 });
    if (!Array.isArray(rows) || rows.length >= 1000) fail('calendar_incomplete');
    return rows;
  };
  const mine = await read('project@company.example');
  const matches = mine.filter(e => e.status !== 'cancelled' && isFirstCheckin(e, lock));
  if (matches.length !== 1) fail('first_invite_missing_or_ambiguous');
  const event = matches[0], at = Date.parse(event.start), end = Date.parse(event.end);
  if (at !== lock.at || end !== lock.end) fail('first_invite_changed');
  if (!/^https:\/\/meet\.google\.com\/[a-z-]+$/i.test(event.meetUrl ?? '')) fail('first_meet_link_missing');
  for (const email of [workEmail, ...Object.values(PEOPLE)]) {
    const guest = event.attendees?.find(a => a.email?.toLowerCase() === email.toLowerCase());
    if (!guest || ([workEmail, ...MUST].includes(email) && guest.responseStatus === 'declined')) fail('first_guests_not_ready');
  }
  const ids = [...reg.series.map(s => s.eventId).filter(Boolean), ...(reg.extra ?? [])];
  if (mine.some(e => e.id !== event.id && e.status !== 'cancelled' && !e.allDay
    && Date.parse(e.start) >= now && Date.parse(e.start) < at
    && ids.some(id => e.id === id || e.recurringEventId === id))) fail('earlier_checkin_exists');
  const busy = {};
  for (const email of MUST) {
    busy[email] = busyOf(await read(email), email, { ignoreIds: [event.id] });
    if (busy[email].some(b => b.start < end + 300_000 && b.end > at - 300_000)) fail('first_team_conflict');
  }
  const [earliest, latest] = teamBoundsOn(at, busy, MUST);
  if (at < earliest || at > latest) fail('first_outside_team_hours');
  if (!['morning', 'night'].includes(kind)) fail('first_kind_unknown');
  const slot = trialerSlot(kind, localDay, lock.tz);
  if (at < slot.band[0] || at > slot.band[1]) fail('first_outside_candidate_hours');
  return event;
}

/** Only newly created, verified registrations get this email; existing manually confirmed trials are never bulk re-emailed. */
export async function runFirstCheckinConfirmations({ env = {}, db, notion, calendar, gmail, poster = null, clock = Date.now }) {
  const out = { sent: 0, held: 0, errors: 0 };
  if (env.UNCLE_SAM_AUTOMATIC_ACTIVITY !== 'enabled' || env.UNCLE_SAM_CHECKINS === 'off' || !db?.prepare || !gmail) return out;
  if ((await notion.readControl()).mode !== 'Live') return out;
  const kv = noticeStore(db), now = clock();
  for (const key of await kv.names('checkin:first:')) {
    const lock = await kv.get(key);
    if (!lock?.emailEligible || !lock.pageId || lock.at <= now || lock.cancelled) continue;
    const receiptKey = confirmationKey(lock), prior = await kv.get(receiptKey);
    if (prior?.cancelled) continue;
    if (prior && ['sending', 'sent', 'uncertain', 'existing_email', 'changing'].includes(prior.state)) continue;
    let candidateName = lock.name ?? 'the candidate';
    try {
      const reg = await kv.get(`checkins:${lock.pageId}`), candidate = await notion.getCandidate(lock.pageId);
      candidateName = candidate?.fullName ?? candidateName;
      if (await holdReason({ kv, candidate })) fail('candidate_not_active');
      if (!prior) {
        await kv.compareAndSwap(receiptKey, null, { state: 'queued', name: candidateName, pageId: lock.pageId, at: now + HOLD_MS }, now);
        continue;
      }
      if (prior.state === 'queued' && prior.at > now) continue;
      if (!reg || reg.closed || !(await datesAgreed({ kv, candidate }))) fail('trial_dates_unconfirmed');
      if ((await currentZone(candidate, kv, notion, now)) !== lock.tz) fail('candidate_timezone_changed_or_unknown');
      if (await kv.get(`trialterms:hold:${lock.pageId}`)) fail('trial_terms_unresolved');
      const onboarding = await kv.get(`onboarding:${lock.pageId}`);
      const event = await checkFirstMeeting({ lock, reg, candidate, workEmail: onboarding?.address, calendar, now });
      if (!noticeWindow(lock, now)) continue; // Weekends are allowed; never an overnight first-time notification.
      if (!(await gmail.connected()) || typeof gmail.searchSent !== 'function') fail('gmail_verification_unavailable');
      const since = new Date(Date.parse(`${lock.start}T00:00:00Z`) - 30 * 86400_000).toISOString().slice(0, 10).replaceAll('-', '/');
      const existing = lock.revision ? [] : await gmail.searchSent(`{to:${candidate.email} to:${onboarding.address}} {"first check-in" "first check in"} after:${since}`);
      if (!Array.isArray(existing)) fail('gmail_verification_unavailable');
      if (existing.length) {
        await kv.put(receiptKey, { state: 'existing_email', at: now, messageId: existing[0].id }, now);
        fail('existing_first_email_needs_reconciliation');
      }
      // Re-read identity/dates and the exact occurrence after the slower mailbox/availability checks.
      const latest = await notion.getCandidate(lock.pageId);
      if (latest.email !== candidate.email || JSON.stringify(await kv.get(firstLockKey(lock.pageId))) !== JSON.stringify(lock)) fail('first_confirmation_changed');
      const verified = await checkFirstMeeting({ lock, reg, candidate: latest, workEmail: onboarding.address, calendar, now: clock() });
      if (await holdReason({ kv, candidate: latest }) || (await currentZone(latest, kv, notion, clock())) !== lock.tz
        || await kv.get(`trialterms:hold:${lock.pageId}`)
        || (await kv.get(`onboarding:${lock.pageId}`))?.address !== onboarding.address) fail('first_confirmation_changed');
      if ((await notion.readControl()).mode !== 'Live') fail('not_live');
      const attempt = { state: 'sending', name: candidateName, pageId: lock.pageId, at: now, eventId: event.id, start: lock.at, end: lock.end,
        timezone: lock.tz, to: candidate.email, workEmail: onboarding.address };
      if (!(await kv.compareAndSwap(receiptKey, prior, attempt, now))) continue;
      const first = candidate.fullName.trim().split(/\s+/)[0];
      try {
        const changed = lock.revision ? `Your first check-in has changed from ${stamp(lock.revision.previousAt, lock.tz)}. The updated time below replaces that earlier time.\n\n` : '';
        const sent = await gmail.send({ to: candidate.email, subject: `${lock.revision ? 'Updated: your' : 'Your'} first Company AI work-trial check-in`,
          body: `Hi ${first},\n\n${changed}Your first work-trial check-in is confirmed for ${stamp(lock.at, lock.tz)} (${lock.tz}).\n\nPacific time: ${stamp(lock.at, 'America/Los_Angeles')}.\n\nThe 15-minute invitation is on your ${onboarding.address} calendar. Join using that account: ${verified.meetUrl}\n\nThis first check-in time is fixed unless a change is explicitly arranged with you. Please reply if this time does not match your agreed availability.\n\nWe look forward to working with you.` });
        await kv.put(receiptKey, { ...attempt, state: 'sent', sentAt: clock(), messageId: sent.id, url: sent.url }, clock());
        out.sent++;
      } catch (error) {
        await kv.put(receiptKey, { ...attempt, state: error?.uncertain === false ? 'retryable' : 'uncertain',
          error: error?.code ?? 'send_unverified' }, clock());
        throw error;
      }
    } catch (error) {
      out.held++; out.errors++;
      const reason = error?.code ?? 'first_confirmation_unavailable';
      if (poster && await kv.claim(`checkin:first:notice:${lock.pageId}:${lock.at}:${reason}`, { at: now }, now))
        await poster(`📅 First check-in confirmation held for ${candidateName}: ${explanations[reason] ?? 'I could not verify every detail or confirm delivery'}. Its time remains locked. Please resolve this before promising a time to the candidate.`).catch(() => {});
    }
  }
  return out;
}

/** Called only from Project's authenticated, candidate-specific check-in reply. A requested change is a new promise. */
export async function reviseFirstCheckin({ db, calendar, notion, gmail, pageId, eventId, to, quote, clock = Date.now }) {
  const kv = noticeStore(db), now = clock(), key = firstLockKey(pageId), old = await kv.get(key);
  if (!old || old.unknown || old.end <= now) fail('first_time_unknown');
  if ((await notion?.readControl())?.mode !== 'Live' || !(await gmail?.connected())) fail('not_live_or_email_unavailable');
  const previous = await kv.get(confirmationKey(old));
  if (['sending', 'uncertain', 'changing'].includes(previous?.state) || (old.revision && previous?.state !== 'sent')) fail('previous_confirmation_unresolved');
  const candidate = await notion.getCandidate(pageId), reg = await kv.get(`checkins:${pageId}`);
  if (!reg || reg.closed || !(await datesAgreed({ kv, candidate })) || await kv.get(`trialterms:hold:${pageId}`)) fail('trial_dates_unconfirmed');
  if ((await currentZone(candidate, kv, notion, now)) !== old.tz) fail('candidate_timezone_changed_or_unknown');
  const workEmail = (await kv.get(`onboarding:${pageId}`))?.address;
  const rows = await calendar.listEvents({ calendarId: 'project@company.example', timeMin: old.at - 86400_000, timeMax: old.end + 86400_000, maxResults: 1000 });
  if (!Array.isArray(rows) || rows.length >= 1000) fail('calendar_incomplete');
  const actual = rows.find(e => e.id === eventId && e.status !== 'cancelled' && isFirstCheckin(e, old));
  if (!actual || Date.parse(actual.start) !== old.at || Date.parse(actual.end) !== old.end) fail('first_invite_changed');
  if (to === old.at) return { changed: false };
  const next = { ...old, eventId, at: to, end: to + old.end - old.at, start: dayOnly(candidate.fields['Trial Start']),
    trialEnd: dayOnly(candidate.fields['Trial End']), emailEligible: true,
    revision: { id: `${now}-${to}`, previousAt: old.at, by: 'Project', quote: String(quote).slice(0, 200), at: now } };
  // Validate the proposed occurrence against real calendars before changing anything.
  const prospective = { listEvents: async args => (await calendar.listEvents(args)).map(e => e.id === eventId
    ? { ...e, start: new Date(next.at).toISOString(), end: new Date(next.end).toISOString() } : e) };
  await checkFirstMeeting({ lock: next, reg, candidate, workEmail, calendar: prospective, now });
  noticeWindow(next, now + HOLD_MS);
  if (next.at - (now + HOLD_MS) < MIN_FIRST_NOTICE_MS) fail('first_notice_too_short');
  if ((await notion.readControl()).mode !== 'Live') fail('not_live');
  const changing = { state: 'changing', at: now, previous, revision: next.revision };
  if (!(await kv.compareAndSwap(confirmationKey(old), previous, changing, now))) fail('previous_confirmation_unresolved');
  if (!(await kv.compareAndSwap(key, old, next, now))) {
    await kv.compareAndSwap(confirmationKey(old), changing, previous, now);
    fail('first_confirmation_changed');
  }
  await kv.claim(confirmationKey(next), { state: 'queued', name: candidate.fullName, pageId, at: now + HOLD_MS }, now);
  // A write timeout leaves this proposed version protected. Readback/confirmation must resolve it; never blindly roll back.
  await calendar.writeEvent({ calendarId: 'primary', eventId, sendUpdates: 'all', body: {
    start: { dateTime: new Date(next.at).toISOString(), timeZone: next.tz },
    end: { dateTime: new Date(next.end).toISOString(), timeZone: next.tz } } });
  await checkFirstMeeting({ lock: next, reg, candidate, workEmail, calendar, now: clock() });
  await kv.put(`checkins:move:${eventId}:${to}`, { at: now, from: old.at, by: 'Project', quote: next.revision.quote }, now);
  return { changed: true };
}
