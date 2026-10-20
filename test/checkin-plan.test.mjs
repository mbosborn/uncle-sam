import test from 'node:test';
import assert from 'node:assert/strict';
import { planAhead } from '../service/lib/checkin-plan.mjs';
import { nearestAllowed, trialerSlot, isLate, zonedDate } from '../service/lib/checkin-times.mjs';
import { PEOPLE, MUST } from '../service/lib/checkins.mjs';

const at = iso => Date.parse(iso);
const pt = ms => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(ms);
// Robin's and Interviewer's BOD sync (Product Standup 9:45–10:15 PT) and EOD sync (8:00–8:30 PM PT) every day of the week.
function teamBusy(days, extra = []) {
  const busy = { [PEOPLE.robin]: [], [PEOPLE.interviewer]: [], [PEOPLE.taylor]: [] };
  for (const d of days) {
    for (const email of MUST) {
      busy[email].push({ start: at(`${d}T16:45:00Z`), end: at(`${d}T17:15:00Z`), summary: 'Product Standup' });
      busy[email].push({ start: at(`${d}T03:00:00Z`), end: at(`${d}T03:30:00Z`), summary: 'EOD Eng Sync' });
    }
  }
  for (const e of extra) for (const email of MUST) busy[email].push(e);
  return busy;
}
const DAYS = ['2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27'];
const india = (pageId, fullName, start, end) => ({ candidate: { pageId, fullName }, tz: 'Asia/Kolkata', start, end });

test('Planning ahead: two India trials on the same days never share a slot; mornings land the Pacific evening before, nights after the BOD sync', () => {
  const plan = planAhead({ trials: [india('p-b', 'Second Person', '2026-10-22', '2026-10-22'), india('p-a', 'First Person', '2026-10-22', '2026-10-22')], busy: teamBusy(DAYS), now: at('2026-10-19T00:00:00Z') });
  assert.equal(plan.length, 2);
  const [a, b] = plan;
  const am = s => s.slots.find(x => x.kind === 'morning'), pm = s => s.slots.find(x => x.kind === 'night');
  assert.equal(pt(am(a).at), 'Wed 9:00 PM', '9:30 AM Thursday in India is 9:00 PM Wednesday in SF');
  assert.notEqual(am(b).at, am(a).at);
  assert.ok(Math.abs(am(b).at - am(a).at) >= 15 * 60_000, 'no overlap');
  assert.ok(am(b).at <= at('2026-10-23T04:30:00Z'), 'still by 9:30 PM PT');
  assert.equal(pt(pm(a).at), 'Thu 10:20 AM', 'night: right after the BOD sync');
  assert.equal(pt(pm(b).at), 'Thu 10:40 AM', 'the next slot, with the 5-minute gap');
  for (const s of [...a.slots, ...b.slots]) assert.equal(s.late, false);
});

test('Planning ahead: a Saturday start is their Saturday; for India that is Friday night in SF', () => {
  const [p] = planAhead({ trials: [india('p-s', 'Sat Starter', '2026-10-24', '2026-10-24')], busy: teamBusy(DAYS), now: at('2026-10-19T00:00:00Z') });
  const morning = p.slots.find(s => s.kind === 'morning');
  assert.equal(morning.day, '2026-10-24');
  assert.equal(pt(morning.at), 'Fri 9:00 PM');
  assert.equal(zonedDate(morning.at, 'Asia/Kolkata'), '2026-10-24');
});

test('Extreme circumstances: nothing free by 9:30 PM PT -> 9:45 PM at the latest, flagged late; nothing by 9:45 -> null', () => {
  const day = '2026-10-21';
  const slot = trialerSlot('morning', '2026-10-22', 'Asia/Kolkata');
  // Busy from the end of the EOD sync until 9:45 PM PT, and the whole day otherwise.
  const blocked = teamBusy([day, '2026-10-22'], [{ start: at('2026-10-21T16:00:00Z'), end: at('2026-10-22T03:00:00Z'), summary: 'Offsite' }, { start: at('2026-10-22T03:30:00Z'), end: at('2026-10-22T04:40:00Z'), summary: 'Board prep' },
    { start: at('2026-10-22T05:05:00Z'), end: at('2026-10-22T16:00:00Z'), summary: 'Night' }, { start: at('2026-10-22T17:15:00Z'), end: at('2026-10-23T05:00:00Z'), summary: 'Busy day' }]);
  const t = nearestAllowed({ target: slot.target, band: slot.band, busy: blocked, must: MUST, now: at('2026-10-19T00:00:00Z') });
  assert.equal(pt(t), 'Wed 9:45 PM');
  assert.equal(isLate(t), true);
  const full = teamBusy([day], [{ start: at('2026-10-20T00:00:00Z'), end: at('2026-10-24T00:00:00Z'), summary: 'Away' }]);
  assert.equal(nearestAllowed({ target: slot.target, band: slot.band, busy: full, must: MUST, now: at('2026-10-19T00:00:00Z') }), null);
  const [p] = planAhead({ trials: [india('p-x', 'Blocked Person', '2026-10-22', '2026-10-22')], busy: full, now: at('2026-10-19T00:00:00Z') });
  assert.deepEqual(p.slots.map(s => s.at), [null, null]);
});

test('Planning ahead: a trial already under way starts from their today; past slots are skipped', () => {
  const [p] = planAhead({ trials: [india('p-n', 'Now Person', '2026-10-22', '2026-10-23')], busy: teamBusy(DAYS), now: at('2026-10-22T10:00:00Z') });
  assert.ok(p.slots.every(s => s.at === null || s.at > at('2026-10-22T10:00:00Z')));
  assert.equal(p.slots[0].day, '2026-10-22');
  assert.equal(p.slots[0].kind, 'night', 'their Thursday morning check-in already passed (3:30 PM in India now)');
});

test('Before the EOD sync when the trialer\'s hours allow: a Pacific trialer\'s night check-in before 8 PM; an Eastern one stays early evening; India stays after it', () => {
  const busy = teamBusy(DAYS), now = at('2026-10-19T00:00:00Z');
  const pick = (kind, tz) => { const s = trialerSlot(kind, '2026-10-22', tz); return nearestAllowed({ target: s.target, band: s.band, comfort: s.comfort, busy, must: MUST, now }); };
  assert.equal(pt(pick('night', 'America/Los_Angeles')), 'Thu 7:40 PM', 'ends 7:55, 5 minutes before the EOD sync');
  assert.equal(pt(pick('night', 'America/New_York')), 'Thu 6:00 PM', '9 PM their time is already before it');
  assert.equal(pt(pick('morning', 'America/New_York')), 'Thu 10:20 AM', 'after the BOD sync');
  assert.equal(pt(pick('morning', 'Asia/Kolkata')), 'Wed 9:00 PM', 'India: 8 AM their time would be too early, so after the EOD sync');
  // The EOD sync moved earlier that day: the check-in follows it.
  const moved = teamBusy(DAYS.filter(d => d !== '2026-10-23'), [{ start: at('2026-10-23T02:00:00Z'), end: at('2026-10-23T02:30:00Z'), summary: 'EOD Eng Sync' }]);
  const s = trialerSlot('night', '2026-10-22', 'America/Los_Angeles');
  assert.equal(pt(nearestAllowed({ target: s.target, band: s.band, comfort: s.comfort, busy: moved, must: MUST, now })), 'Thu 6:40 PM');
  // No room before it in their hours: the usual nearest-to-9-PM time.
  const full = teamBusy(DAYS, [{ start: at('2026-10-23T01:00:00Z'), end: at('2026-10-23T03:00:00Z'), summary: 'Board' }]);
  assert.equal(pt(nearestAllowed({ target: s.target, band: s.band, comfort: s.comfort, busy: full, must: MUST, now })), 'Thu 9:00 PM');
});
