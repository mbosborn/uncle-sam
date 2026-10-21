import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ensureCheckins, clearClosedBanners } from '../service/lib/work-trial.mjs';
import { bestDailyTimes } from '../service/lib/checkins.mjs';
import { noticeStore } from '../service/lib/stuck-rejections.mjs';

const NOW = Date.parse('2026-10-18T06:00:00Z'); // Sat Oct 17, 11 PM PT
function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const RK = { pageId: '3f26ba36-8537-812b-9f29-c3980210a54b', fullName: 'Rylan King', email: 'rylanking@example.test',
  fields: { Stage: 'Trial', Paperwork: 'Sent', Pipeline: 'India', 'India Stage': 'Pre Work Trial', 'Trial Start': '2026-10-19', 'Trial End': '2026-10-21' } };
const banner = { id: 'b1', allDay: true, status: 'confirmed', summary: 'Rylan King Work Trial (Remote)', start: '2026-10-19T00:00:00Z', end: '2026-10-22T00:00:00Z', attendees: [] };
// Robin's and Interviewer's BOD sync ("Product Standup") 9:45–10:15 AM PT and EOD sync 8:00–8:30 PM PT, every day.
const daily = ['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21'].flatMap((d, i) => [
  { id: `s${i}`, status: 'confirmed', allDay: false, summary: 'Product Standup', start: `${d}T16:45:00Z`, end: `${d}T17:15:00Z`, attendees: [{ email: 'robin@company.example', responseStatus: 'accepted' }, { email: 'quinn@company.example', responseStatus: 'accepted' }] },
  { id: `e${i}`, status: 'confirmed', allDay: false, summary: 'EOD Eng Sync', start: `${d}T03:00:00Z`, end: `${d}T03:30:00Z`, attendees: [{ email: 'robin@company.example', responseStatus: 'accepted' }, { email: 'quinn@company.example', responseStatus: 'accepted' }] }]);
const standups = daily;
function world({ banners = [banner], robin = standups } = {}) {
  const events = [], posted = [];
  const calendar = {
    listEvents: async ({ calendarId }) => (calendarId === 'project@company.example' ? banners : ['robin@company.example', 'quinn@company.example'].includes(calendarId) ? robin : []),
    writeEvent: async w => { events.push(w); return { id: w.body.id ?? `ev${events.length}` }; },
  };
  return { calendar, events, posted, poster: async t => posted.push(t) };
}

test('the moment the Company email exists and the banner is up: check-ins at the best times, signed or not; once', async () => {
  const db = d1(), w = world();
  const run = () => ensureCheckins({ db, calendar: w.calendar, canWrite: true, candidate: RK, poster: w.poster, clock: () => NOW });
  assert.equal(await run(), 'email_not_created');
  await noticeStore(db).put(`onboarding:${RK.pageId}`, { address: 'rylan@company.example', jamieDone: { via: 'created', at: NOW } }, NOW);
  assert.equal(await run(), 'created');
  assert.deepEqual(w.events.map(e => e.body.summary), ['Rylan / Company: Morning Check-in', 'Rylan / Company: Night Check-in']);
  // India: mornings 9:30 AM there = 9:00 PM PT (after the EOD sync, before 9:30 PM); nights as near 9 PM there as the team
  // allows: after the 10:15 AM PT standup, 10:20 AM PT = 10:50 PM there.
  assert.equal(new Date(w.events[0].body.start.dateTime).toISOString(), '2026-10-19T04:00:00.000Z');
  assert.equal(new Date(w.events[1].body.start.dateTime).toISOString(), '2026-10-19T17:20:00.000Z');
  assert.equal(w.events[0].body.start.timeZone, 'Asia/Kolkata');
  // Their Company email, never the personal one (Project, Oct 19).
  for (const e of w.events) { assert.ok(e.body.attendees.some(a => a.email === 'rylan@company.example')); assert.ok(!e.body.attendees.some(a => a.email === RK.email)); }
  assert.equal(w.posted[0], "📅 Rylan King's check-ins are on the calendar, Oct 19 – Oct 21: mornings 9:00 PM PT, nights 10:20 AM PT, sent to rylan@company.example.");
  assert.equal(await run(), 'already_set_up');
  assert.equal(w.events.length, 2, 'never twice');
});

test('no banner yet or tentative dates: nothing; a trialer whose time zone is unknown: Project is asked once where they are; Berlin from the notes works', async () => {
  const db = d1();
  await noticeStore(db).put(`onboarding:${RK.pageId}`, { jamieDone: { via: 'reply', at: NOW } }, NOW);
  const w = world({ banners: [] });
  assert.equal(await ensureCheckins({ db, calendar: w.calendar, canWrite: true, candidate: RK, clock: () => NOW }), 'no_banner');
  assert.equal(await ensureCheckins({ db, calendar: w.calendar, canWrite: true, candidate: { ...RK, fields: { ...RK.fields, 'Next action': 'dates tentative' } }, clock: () => NOW }), 'dates_not_confirmed');
  const us = { ...RK, fields: { ...RK.fields, Pipeline: 'US/EU', 'India Stage': null } }, w2 = world();
  const ask = () => ensureCheckins({ db, calendar: w2.calendar, canWrite: true, candidate: us, poster: w2.poster, clock: () => NOW, notion: { listCandidateNotes: async () => [] } });
  assert.equal(await ask(), 'locating', 'not before their emails and LinkedIn were looked at (trial-location.mjs)');
  assert.equal(w2.posted.length, 0);
  await noticeStore(db).put(`trialtz:looked:${RK.pageId}`, { fp: 'x', at: NOW, conflict: null }, NOW);
  assert.equal(await ask(), 'asked_time_zone');
  assert.equal(w2.events.length, 0);
  assert.match(w2.posted[0], /^📅 Where is Rylan King based for the work trial\? Their emails and LinkedIn don't say\./);
  const w3 = world();
  assert.equal(await ensureCheckins({ db: d1(), calendar: w3.calendar, canWrite: true, candidate: us, poster: w3.poster, clock: () => NOW, emailReady: true,
    notion: { listCandidateNotes: async () => [{ text: '2026-10-12 · Pipeline set to US/EU (by Uncle Sam, from Clay: based in Berlin, Germany).' }] } }), 'created');
  assert.equal(w3.events[0].body.start.timeZone, 'Europe/Berlin');
  assert.match(w3.posted[0], /^📅 Rylan King's check-ins are on the calendar/);
});

test('best daily times: the preferred time when everyone is free; unreadable calendars fall back to it', async () => {
  const free = await bestDailyTimes({ calendar: world({ robin: [] }).calendar, start: '2026-10-19', end: '2026-10-21', now: NOW });
  // No BOD sync on the calendars: from 9 AM PT. India's 9:30 AM = 9:00 PM PT fits; 9 PM there = 8:30 AM PT is too early: 9:00 AM PT = 9:30 PM there.
  assert.deepEqual([free.morning, free.night, free.clashDays.night], ['09:30', '21:30', 0]);
  const blind = await bestDailyTimes({ calendar: { listEvents: async () => { throw new Error('403'); } }, start: '2026-10-19', end: '2026-10-21', now: NOW });
  assert.deepEqual([blind.morning, blind.night, blind.read], ['09:30', '21:00', false]);
});

import { handleCheckinTzReply } from '../service/lib/checkins.mjs';
import { zoneOfPlace } from '../service/lib/checkin-times.mjs';
test('where they are -> their time zone; Project\'s "Berlin" under the question is kept and their check-ins follow', async () => {
  assert.deepEqual(['Bangalore', 'Berlin, Germany', 'ET', 'San Francisco', 'Toronto', 'Lagos', 'somewhere'].map(zoneOfPlace),
    ['Asia/Kolkata', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'America/Toronto', 'Africa/Lagos', null]);
  const db = d1(), said = [], made = [];
  await noticeStore(db).put('checkins:tzask:1792400000.000100', { pageId: RK.pageId, at: NOW }, NOW);
  const out = await handleCheckinTzReply({ event: { authorId: 'U0F9EF97D89', channelId: 'D0C95KBR09J', threadTs: '1792400000.000100', messageTs: '1792400100.000100', text: 'Berlin' },
    db, masonId: 'U0F9EF97D89', poster: () => async t => said.push(t), onZone: async id => made.push(id), clock: () => NOW });
  assert.equal(out.kind, 'checkin_tz');
  assert.equal((await noticeStore(db).get(`trialtz:${RK.pageId}`)).tz, 'Europe/Berlin');
  assert.deepEqual(made, [RK.pageId]);
  assert.equal(said[0], 'Roger that 🫡: Europe/Berlin. Setting up their check-ins.');
});

test('A closed trial loses its banner, quietly, once; open, hired, ended or unlinked banners stay (Project, Oct 19: Arlen)', async () => {
  const db = d1(), writes = [], notes = [];
  const T = Date.parse('2026-10-19T21:00:00Z');
  const banner = (id, name, start, end, page) => ({ id, allDay: true, status: 'confirmed', summary: `${name} Work Trial (Remote)`, start: `${start}T00:00:00Z`, end: `${end}T00:00:00Z`,
    description: page ? `${name} — remote work trial. Recruiting record: https://app.notion.com/p/${page}` : 'no link' });
  const events = [banner('arlen', 'Arlen Archer', '2026-10-17', '2026-10-20', '3f26ba36853781f79a79cc4aa419c2c8'),
    banner('rk', 'Rylan King', '2026-10-19', '2026-10-22', '3f26ba368537812b9f29c3980210a54b'),
    banner('hired', 'Hired Person', '2026-10-19', '2026-10-22', 'Hired-Person-aaaaaaaabbbbccccddddeeeeeeeeeeee'),
    banner('old', 'Elliot Woods', '2026-10-11', '2026-10-19', 'ffffffffffffffffffffffffffffffff'),
    banner('nolink', 'Someone Else', '2026-10-19', '2026-10-22', null)];
  const records = { '3f26ba36-8537-81f7-9a79-cc4aa419c2c8': { fields: { Outcome: 'Withdrawn or Unavailable', Stage: 'Trial' } },
    '3f26ba36-8537-812b-9f29-c3980210a54b': { fields: { Outcome: 'Proceeding', Stage: 'Trial' } },
    'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee': { fields: { Outcome: 'Hired', Stage: 'Hired' } },
    'ffffffff-ffff-ffff-ffff-ffffffffffff': { fields: { Outcome: 'Not Selected' } } };
  const calendar = { listEvents: async () => events, writeEvent: async w => { writes.push(w); return { id: w.eventId }; } };
  const notion = { getCandidate: async id => records[id] ?? null, appendCandidateNote: async n => notes.push(n) };
  const out = await clearClosedBanners({ db, notion, calendar, clock: () => T, force: true });
  assert.equal(out.removed, 1);
  assert.deepEqual(writes, [{ calendarId: 'primary', eventId: 'arlen', sendUpdates: 'none', body: { status: 'cancelled' } }]);
  assert.match(notes[0].text, /banner removed \(Withdrawn or Unavailable/);
  await clearClosedBanners({ db, notion, calendar, clock: () => T + 3600_000, force: true });
  assert.equal(writes.length, 1, 'once');
});
