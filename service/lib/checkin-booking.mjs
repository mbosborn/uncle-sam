import { createHash } from 'node:crypto';
import { noticeStore } from './stuck-rejections.mjs';
import { PEOPLE } from './checkins.mjs';
import { firstLockKey } from './first-checkin-lock.mjs';
import { JOINT_CHECKIN_VERSION } from './checkin-joint-plan.mjs';
import { SLOT_MS } from './checkin-times.mjs';

const stamp = at => new Date(at).toISOString().replace(/[-:]/g, '').replace('.000', '');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Slots from durable unfinished or completed bookings also reserve capacity before provider reads catch up. */
export async function bookingReservations(db, { excludePageId = null, now }) {
  const { results = [] } = await db.prepare("SELECT name, value FROM uncle_sam_notices WHERE name LIKE 'checkins:%'").bind().all();
  const slots = [];
  for (const row of results) {
    let r; try { r = JSON.parse(row.value); } catch { continue; }
    if (r?.closed || r?.pageId === excludePageId) continue;
    if (r?.creating && !r?.jointPlan) throw Error('unverified_checkin_creation');
    if (r?.jointPlan) slots.push(...(r.slots ?? []).filter(s => Number.isFinite(s.at) && s.at + SLOT_MS > now));
  }
  return slots;
}

/** Two series with explicit UTC occurrences, rather than repeating a first-day choice on unverified days. */
export async function bookPlannedCheckins({ db, calendar, plan, workEmail, trialStart, clock = Date.now, validate }) {
  const kv = noticeStore(db), now = clock(), who = plan.candidate, key = `checkins:${who.pageId}`;
  if (!plan.slots.length || plan.slots.some(s => !Number.isFinite(s.at)) || typeof validate !== 'function') return { reason: 'joint_plan_incomplete' };
  const planId = digest([who.pageId, trialStart, plan.end, plan.tz, workEmail, plan.slots]);
  const first = String(who.fullName).replace(/\s*\([^)]*\)\s*/g, ' ').trim().split(/\s+/)[0];
  let reg = { pageId: who.pageId, name: who.fullName, first, start: plan.start, end: plan.end, tz: plan.tz,
    jointPlan: JOINT_CHECKIN_VERSION, planId, slots: plan.slots, series: [], constraints: plan.constraints ?? [], at: now, creating: true };
  if (!(await kv.claim(key, reg, now))) return { reason: 'already_set_up' };
  const groups = ['morning', 'night'].map(kind => ({ kind, slots: plan.slots.filter(s => s.kind === kind).sort((a, b) => a.at - b.at) }))
    .filter(g => g.slots.length).sort((a, b) => a.slots[0].at - b.slots[0].at);
  let attempted = false;
  const save = async next => {
    if (!(await kv.compareAndSwap(key, reg, next, clock()))) throw Error('checkin_reservation_changed');
    reg = next;
  };
  try {
    for (const { kind, slots } of groups) {
      await validate({ plan, eventIds: reg.series.map(s => s.eventId) });
      if (JSON.stringify(await kv.get(key)) !== JSON.stringify(reg)) throw Error('checkin_reservation_changed');
      const at = slots[0].at, id = `usam${digest([planId, kind])}`;
      const guests = [...Object.values(PEOPLE), workEmail].filter(Boolean).map(email => ({ email }));
      await save({ ...reg, attempt: { id, kind, at: clock() } });
      attempted = true;
      const event = await calendar.writeEvent({ calendarId: 'primary', conferenceDataVersion: 1, sendUpdates: 'all', body: {
        id, summary: `${first} / Company: ${kind === 'morning' ? 'Morning' : 'Night'} Check-in`,
        description: `${kind === 'morning' ? 'Morning' : 'Nightly'} check-in (${plan.tz} time). Check the individual calendar occurrence for its time.`,
        transparency: 'transparent', start: { dateTime: new Date(at).toISOString(), timeZone: plan.tz },
        end: { dateTime: new Date(at + SLOT_MS).toISOString(), timeZone: plan.tz },
        recurrence: [`RDATE:${slots.map(s => stamp(s.at)).join(',')}`], attendees: guests,
        conferenceData: { createRequest: { requestId: id.slice(0, 60), conferenceSolutionKey: { type: 'hangoutsMeet' } } }
      } });
      if (event?.id !== id) throw Error('checkin_create_unverified');
      await save({ ...reg, attempt: null, series: [...reg.series, { kind, eventId: event.id, target: kind === 'morning' ? '09:30' : '21:00' }] });
      if (reg.series.length === 1) await kv.claim(firstLockKey(who.pageId), { pageId: who.pageId, name: who.fullName,
        seriesId: event.id, at, originalAt: at, end: at + SLOT_MS, kind, tz: plan.tz, start: trialStart, trialEnd: plan.end,
        establishedAt: now, source: 'joint_planned_invitation', planId, emailEligible: false }, now);
    }
    await validate({ plan, eventIds: reg.series.map(s => s.eventId) });
    const firstAt = Math.min(...plan.slots.map(s => s.at));
    await save({ ...reg, creating: false, firstAt });
    const lock = await kv.get(firstLockKey(who.pageId));
    if (lock?.planId === planId) await kv.compareAndSwap(firstLockKey(who.pageId), lock, { ...lock, emailEligible: true }, clock());
    return { reason: 'created', morning: groups.find(g => g.kind === 'morning')?.slots[0]?.at ?? null,
      night: groups.find(g => g.kind === 'night')?.slots[0]?.at ?? null, varying: groups.some(g => new Set(g.slots.map(s => new Intl.DateTimeFormat('en-GB', { timeZone: plan.tz, hour: '2-digit', minute: '2-digit' }).format(s.at))).size > 1) };
  } catch (error) {
    // Never replay a possibly accepted insert. Preserve all reserved slots and partial receipts for review.
    if (attempted) {
      const known = ['calendar_changed', 'candidate_changed', 'not_live', 'planning_lease_expired', 'checkin_reservation_changed', 'checkin_create_unverified'];
      await kv.compareAndSwap(key, reg, { ...reg, creating: true, needsReview: true, failure: known.includes(error?.message) ? error.message : 'booking_failed' }, clock());
    }
    else await db.prepare('DELETE FROM uncle_sam_notices WHERE name = ? AND value = ?').bind(key, JSON.stringify(reg)).run();
    return { reason: attempted ? 'checkin_creation_needs_review' : 'checkin_plan_changed' };
  }
}
