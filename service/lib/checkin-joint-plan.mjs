import { addDays } from './takehome-nudge.mjs';
import { allowedStarts, trialerSlot, isLate, SLOT_MS, GAP_MS } from './checkin-times.mjs';
import { PEOPLE, MUST, busyOf, CHECKIN_TITLE } from './checkins.mjs';

export const JOINT_CHECKIN_VERSION = '2026-10-20.1';
export const MAX_TRIALS = 8, MAX_ORDERS = 32, MAX_DAYS = 21;
const overlaps = (a, b) => a < b + SLOT_MS + GAP_MS && b < a + SLOT_MS + GAP_MS;
const compare = (a, b) => a.start.localeCompare(b.start) || a.candidate.pageId.localeCompare(b.candidate.pageId);

/** A bounded heuristic, not a claim of global optimality. Existing calendar spans never move. */
export function jointPlan({ trials, busy, now, maxOrders = MAX_ORDERS }) {
  const sorted = [...trials].sort(compare);
  const supported = sorted.filter(t => { const days = (Date.parse(`${t.end}T00:00:00Z`) - Date.parse(`${t.start}T00:00:00Z`)) / 86400_000 + 1; return days >= 1 && days <= MAX_DAYS; });
  const bounded = supported.slice(0, MAX_TRIALS);
  const choices = new Map();
  const jobs = bounded.map(t => {
    const slots = [];
    for (let day = t.start, n = 0; day <= t.end && n < MAX_DAYS; day = addDays(day, 1), n++) {
      for (const kind of ['morning', 'night']) {
        const slot = trialerSlot(kind, day, t.tz);
        if (slot.band[1] < now) continue;
        const constraints = (t.constraints ?? []).filter(c => c.kind === kind || c.kind === 'both');
        const key = JSON.stringify([t.tz, day, kind, constraints]);
        if (!choices.has(key)) choices.set(key, allowedStarts({ ...slot, busy, must: MUST, optional: [PEOPLE.taylor], constraints, now }));
        slots.push({ day, kind, choices: choices.get(key) });
      }
    }
    return { ...t, jobs: slots };
  });
  const indexes = jobs.map((_, i) => i), orders = [], orderKeys = new Set();
  const limit = Math.max(1, Math.min(MAX_ORDERS, Math.floor(maxOrders) || 1));
  const add = order => { const key = order.join(','); if (orders.length < limit && !orderKeys.has(key)) { orders.push(order); orderKeys.add(key); } };
  add(indexes);
  add([...indexes].sort((a, b) => Math.min(...jobs[a].jobs.map(s => s.choices.length), Infinity) - Math.min(...jobs[b].jobs.map(s => s.choices.length), Infinity) || a - b));
  add([...indexes].reverse());
  for (let i = 1; i < indexes.length; i++) add([...indexes.slice(i), ...indexes.slice(0, i)]);
  const permute = (prefix, rest) => {
    if (orders.length >= limit) return;
    if (!rest.length) { add(prefix); return; }
    for (const i of rest) permute([...prefix, i], rest.filter(x => x !== i));
  };
  permute([], indexes);
  let best = null;
  for (const order of orders) {
    const reserved = [], plans = new Map();
    let missing = 0, late = 0, preference = 0, incomplete = 0;
    for (const i of order) {
      const t = jobs[i], slots = [];
      for (const job of t.jobs) {
        const index = job.choices.findIndex(at => !reserved.some(other => overlaps(at, other)));
        const at = index < 0 ? null : job.choices[index];
        if (at === null) missing++;
        else { reserved.push(at); late += Number(isLate(at)); preference += index; }
        slots.push({ day: job.day, kind: job.kind, at, late: at !== null && isLate(at) });
      }
      incomplete += Number(slots.some(s => s.at === null));
      const { jobs: _, ...trial } = t;
      plans.set(i, { ...trial, slots });
    }
    const score = [missing, incomplete, late, preference];
    const better = !best || score.some((v, i) => v < best.score[i] && score.slice(0, i).every((x, j) => x === best.score[j]));
    if (better) best = { score, plans };
  }
  return { version: JOINT_CHECKIN_VERSION, orders: orders.length, score: best?.score ?? [0, 0, 0, 0],
    plans: indexes.map(i => best.plans.get(i)), deferred: sorted.filter(t => !bounded.includes(t)).map(t => t.candidate.pageId) };
}

/** Full, bounded reads. Organizer check-ins count even when marked free or guests have not synced yet. */
export async function readPlanningBusy({ calendar, trials, now, reservations = [], ignoreIds = [] }) {
  const starts = trials.map(t => Date.parse(`${t.start}T00:00:00Z`));
  const ends = trials.map(t => Date.parse(`${t.end}T00:00:00Z`));
  if (!starts.length) throw Error('no_planning_trials');
  const timeMin = Math.min(now, ...starts) - 2 * 86400_000, timeMax = Math.max(...ends) + 3 * 86400_000;
  const busy = {};
  const read = async calendarId => {
    const events = await calendar.listEvents({ calendarId, timeMin, timeMax, maxResults: 1000 });
    if (!Array.isArray(events) || events.length >= 1000) throw Error('calendar_snapshot_incomplete');
    return events;
  };
  for (const email of Object.values(PEOPLE)) {
    try { busy[email] = busyOf(await read(email), email, { ignoreIds }); }
    catch (error) { if (MUST.includes(email)) throw error; busy[email] = []; }
  }
  const mine = (await read('project@company.example')).filter(e => CHECKIN_TITLE.test(e.summary ?? ''));
  for (const email of Object.values(PEOPLE)) busy[email].push(...busyOf(mine, email, { ignoreIds }),
    ...reservations.filter(s => s.at !== null && s.at + SLOT_MS > now).map(s => ({ start: s.at, end: s.at + SLOT_MS, summary: 'Reserved check-in' })));
  return busy;
}

export function slotsStillFree({ plan, busy, now }) {
  return plan.slots.every(slot => slot.at !== null && slot.at > now && allowedStarts({
    ...trialerSlot(slot.kind, slot.day, plan.tz), busy, must: MUST, optional: [], now,
    constraints: (plan.constraints ?? []).filter(c => c.kind === slot.kind || c.kind === 'both')
  }).includes(slot.at));
}
