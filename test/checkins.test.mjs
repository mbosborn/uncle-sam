import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runCheckinGuard, windowOn, busyOf, freeSlot, preferOn, readCheckinConstraints, PEOPLE } from '../service/lib/checkins.mjs';
import { noticeStore } from '../service/lib/stuck-rejections.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
async function completedFirst(kv, ...ids) {
  for (const pageId of ids) await kv.put(`checkin:first:${pageId}`, { pageId, eventId: 'completed-first', seriesId: 'completed', at: 1, originalAt: 1, end: 2, emailEligible: false }, 2);
}
const NOW = Date.parse('2026-10-17T03:00:00Z'); // Fri 8:00 PM PT
const iso = s => new Date(Date.parse(s)).toISOString();
const ev = (id, start, end, who, extra = {}) => ({ id, status: 'confirmed', start: iso(start), end: iso(end), allDay: false, transparent: false, summary: extra.summary ?? id,
  attendees: who.map(email => ({ email, responseStatus: extra.declined?.includes(email) ? 'declined' : 'accepted' })), recurringEventId: extra.series ?? null });
const ARLEN = { pageId: 'p-arlen', first: 'Arlen', name: 'Arlen Archer', end: '2026-10-19',
  series: [{ kind: 'morning', eventId: 'morn', window: { from: '21:30', to: '22:00' } }, { kind: 'night', eventId: 'night', window: { from: '09:30', to: '10:30' } }], constraints: [] };

test('windows, busy time and the first free slot (Robin and Interviewer must be free; declined and free-time events do not count)', () => {
  // A series registered with a later end (10:30) keeps the 9:45 cap (Project, Oct 17-18); freeSlot is tested on a wider window.
  const capped = windowOn(ARLEN.series[1], Date.parse('2026-10-17T17:15:00Z'));
  assert.deepEqual([new Date(capped[0]).toISOString(), new Date(capped[1]).toISOString()], ['2026-10-17T16:30:00.000Z', '2026-10-17T16:45:00.000Z']);
  const evening = windowOn(ARLEN.series[0], Date.parse('2026-10-18T04:45:00Z'));
  assert.equal(new Date(evening[1]).toISOString(), '2026-10-18T04:45:00.000Z', 'the Pacific-evening one never starts after 9:45 PM');
  const [from, to] = [Date.parse('2026-10-17T16:30:00Z'), Date.parse('2026-10-17T17:30:00Z')];
  const events = [ev('standup', '2026-10-17T16:45:00Z', '2026-10-17T17:15:00Z', [PEOPLE.robin, PEOPLE.interviewer]), ev('ops', '2026-10-17T16:00:00Z', '2026-10-17T16:45:00Z', [PEOPLE.robin], { declined: [PEOPLE.robin] }),
    { ...ev('val', '2026-10-17T14:00:00Z', '2026-10-17T22:00:00Z', [PEOPLE.robin]), transparent: true }];
  assert.deepEqual(busyOf(events, PEOPLE.robin).map(b => b.summary), ['standup']);
  // Each person's own calendar holds only their events.
  const own = email => events.filter(e => e.attendees.some(a => a.email === email));
  const busy = { [PEOPLE.robin]: busyOf(own(PEOPLE.robin), PEOPLE.robin), [PEOPLE.interviewer]: busyOf(own(PEOPLE.interviewer), PEOPLE.interviewer), [PEOPLE.taylor]: [] };
  // 9:30 would end right as the 9:45 standup starts: 5 minutes apart is required, so 10:20 (5 after it ends).
  assert.equal(new Date(freeSlot({ window: [from, to], busy })).toISOString(), '2026-10-17T17:20:00.000Z');
  // A constraint from Interviewer ("not before 10") narrows the window.
  const narrowed = windowOn(ARLEN.series[1], Date.parse('2026-10-17T17:15:00Z'), [{ kind: 'night', from: '10:00' }]);
  assert.equal(new Date(narrowed[0]).toISOString(), '2026-10-17T17:00:00.000Z');
});

test('the guard: after the BOD sync, by 9:30 PM PT, nearest the trialer\'s own morning and evening; no time at all: Project is asked once', async () => {
  const db = d1(), kv = noticeStore(db), said = [], writes = [];
  await kv.put('checkins:p-arlen', ARLEN, NOW);
  await completedFirst(kv, 'p-arlen'); // These fixtures exercise later recurring meetings.
  const project = [ev('night_20261017T171500Z', '2026-10-17T17:15:00Z', '2026-10-17T17:30:00Z', [], { series: 'night' }),
    ev('night_20261018T171500Z', '2026-10-18T17:15:00Z', '2026-10-18T17:30:00Z', [], { series: 'night' }),
    ev('morn_20261017T044500Z', '2026-10-17T04:45:00Z', '2026-10-17T05:00:00Z', [], { series: 'morn' })];
  const standup = day => ev(`standup-${day}`, `${day}T16:45:00Z`, `${day}T17:15:00Z`, [PEOPLE.robin, PEOPLE.interviewer], { summary: 'Product Standup' });
  const both = [standup('2026-10-17'), standup('2026-10-18')];
  const team = {
    [PEOPLE.robin]: both,
    [PEOPLE.interviewer]: [...both, ev('deep-dive', '2026-10-17T17:15:00Z', '2026-10-17T17:45:00Z', [PEOPLE.interviewer], { summary: 'Technical Deep dive' }),
      ev('offsite', '2026-10-18T03:00:00Z', '2026-10-19T06:00:00Z', [PEOPLE.interviewer], { summary: 'Offsite' })],
    [PEOPLE.taylor]: [] };
  const calendar = { listEvents: async ({ calendarId }) => (calendarId === 'project@company.example' ? project : team[calendarId] ?? []),
    writeEvent: async w => { writes.push(w); return { id: w.eventId }; } };
  const out = await runCheckinGuard({ db, calendar, poster: async t => said.push(t), clock: () => NOW });
  assert.deepEqual([out.moved, out.asked], [2, 1]);
  assert.deepEqual(writes.filter(w => w.body.start).map(w => [w.eventId, w.body.start.dateTime]), [
    ['morn_20261017T044500Z', '2026-10-17T04:00:00.000Z'], // 9:00 PM PT = 9:30 AM India (it started after 9:30 PM PT)
    ['night_20261017T171500Z', '2026-10-17T17:50:00.000Z']]); // 10:50 AM PT: after the standup and Interviewer's deep dive
  assert.ok(said.every(t => !/^📅 Moved/.test(t)), 'routine moves are quiet (Project, 2026-10-18)');
  assert.match(said.find(t => /Keep it/.test(t)), /Arlen's night check-in on Sun, Oct 18, 10:15 AM PT: Robin has “Product Standup”.*nothing better fits\. Keep it, or tell me a time\./);
  const again = await runCheckinGuard({ db, calendar, poster: async t => said.push(t), clock: () => NOW + 10 * 60_000 });
  assert.deepEqual([again.asked, writes.filter(w => w.body.start).length], [0, 2], 'asked once, moved once');
});

test('a time someone needs, said in a DM, narrows the window (quoted word for word)', async () => {
  const db = d1();
  await noticeStore(db).put('checkins:p-arlen', ARLEN, NOW);
  const claude = { complete: async () => ({ content: [{ type: 'tool_use', name: 'constraints', input: { items: [{ candidate_id: 'p-arlen', kind: 'night', earliest: '10:00', who: 'Interviewer', quote: "can't do Arlen's night check-in before 10" }] } }] }) };
  const found = await readCheckinConstraints({ db, claude, text: "Hey, I can't do Arlen's night check-in before 10 am PT", speaker: 'Interviewer', clock: () => NOW });
  assert.equal(found.length, 1);
  assert.deepEqual((await noticeStore(db).get('checkins:p-arlen')).constraints.map(c => [c.kind, c.from, c.who]), [['night', '10:00', 'Interviewer']]);
  assert.deepEqual(await readCheckinConstraints({ db, claude, text: 'see you tomorrow', clock: () => NOW }), [], 'not about check-ins: no model call');
});

import { handleCheckinReply } from '../service/lib/checkins.mjs';
test('"its fine robin isnt going": the check-in stays, that event stops counting for Robin, and the reply is one short line; a time moves it', async () => {
  const db = d1(), kv = noticeStore(db), said = [], writes = [];
  await kv.put('checkins:p-arlen', ARLEN, NOW);
  const ask = { key: 'checkins:p-arlen', instId: 'morn_20261017T044500Z', start: Date.parse('2026-10-17T04:45:00Z'), end: Date.parse('2026-10-17T05:00:00Z'), email: PEOPLE.robin, eventId: 'open-together', at: NOW };
  await kv.put('checkins:askts:1792206400.000100', ask, NOW);
  await kv.put('checkins:lastask', { ...ask, ts: '1792206400.000100' }, NOW);
  const calendar = { writeEvent: async w => { writes.push(w); return { id: w.eventId }; } };
  const run = (text, extra = {}) => handleCheckinReply({ event: { authorId: 'U0F9EF97D89', channelId: 'D0C95KBR09J', messageTs: '1792206460.000100', threadTs: null, text, ...extra },
    db, calendar, poster: () => async t => said.push(t), masonId: 'U0F9EF97D89', clock: () => NOW + 60_000 });
  assert.equal(await run('send Logan the take home'), null, 'not an answer');
  assert.equal((await run('its fine robin isnt going to the open together thing')).kind, 'checkin_kept');
  assert.deepEqual(said, ['Roger that 🫡']);
  assert.deepEqual((await kv.get('checkins:p-arlen')).ignore.map(i => [i.email, i.eventId]), [[PEOPLE.robin, 'open-together']]);
  assert.equal(await run('ok'), null, 'answered once');
  await kv.put('checkins:askts:1792206500.000100', { ...ask, instId: 'night_20261017T171500Z', start: Date.parse('2026-10-17T17:15:00Z'), end: Date.parse('2026-10-17T17:30:00Z') }, NOW);
  assert.equal((await run('make it 9:45', { threadTs: '1792206500.000100' })).kind, 'checkin_moved');
  assert.equal(writes[0].body.start.dateTime, '2026-10-17T16:45:00.000Z');
  assert.equal(said[1], 'Roger that 🫡');
});

test('night check-ins never start after 9:45 AM PT; the one closest to 9:30 wins (Project, Oct 17)', () => {
  const series = { kind: 'night', eventId: 'n' };
  const ms = Date.parse('2026-10-19T17:15:00Z');
  const w = windowOn(series, ms);
  assert.deepEqual(w.map(t => new Date(t).toISOString()), ['2026-10-19T16:15:00.000Z', '2026-10-19T16:45:00.000Z']);
  const standup = { start: Date.parse('2026-10-19T16:45:00Z'), end: Date.parse('2026-10-19T17:15:00Z'), summary: 'Product Standup' };
  const busy = { [PEOPLE.robin]: [standup], [PEOPLE.interviewer]: [standup], [PEOPLE.taylor]: [] };
  assert.equal(new Date(freeSlot({ window: w, busy, prefer: preferOn(series, ms, w) })).toISOString(), '2026-10-19T16:25:00.000Z', '9:25: 5 minutes before standup');
  assert.equal(new Date(freeSlot({ window: w, busy: { [PEOPLE.robin]: [], [PEOPLE.interviewer]: [] }, prefer: preferOn(series, ms, w) })).toISOString(), '2026-10-19T16:30:00.000Z', 'free: 9:30');
});

test('the guard moves a Pacific trialer\'s 9 PM check-in to before the EOD sync, once', async () => {
  const db = d1(), kv = noticeStore(db), said = [], writes = [];
  await kv.put('checkins:p-sam', { pageId: 'p-sam', first: 'Sam', name: 'Sam Lee', end: '2026-10-20', tz: 'America/Los_Angeles', series: [{ kind: 'night', eventId: 'eve', target: '21:00' }], constraints: [] }, NOW);
  await completedFirst(kv, 'p-sam');
  const eod = day => ev(`eod-${day}`, `${day}T03:00:00Z`, `${day}T03:30:00Z`, [PEOPLE.robin, PEOPLE.interviewer], { summary: 'EOD Eng Sync' });
  let project = [ev('eve_20261019T040000Z', '2026-10-19T04:00:00Z', '2026-10-19T04:15:00Z', [], { series: 'eve' })];
  const team = { [PEOPLE.robin]: [eod('2026-10-19')], [PEOPLE.interviewer]: [eod('2026-10-19')], [PEOPLE.taylor]: [] };
  const calendar = { listEvents: async ({ calendarId }) => (calendarId === 'project@company.example' ? project : team[calendarId] ?? []),
    writeEvent: async w => { writes.push(w); return { id: w.eventId }; } };
  const out = await runCheckinGuard({ db, calendar, poster: async t => said.push(t), clock: () => NOW });
  assert.equal(out.moved, 1);
  assert.equal(writes.filter(w => w.body.start)[0].body.start.dateTime, '2026-10-19T02:40:00.000Z'); // 7:40 PM PT, done 5 minutes before the 8 PM EOD sync
  assert.equal(said.length, 0, 'quiet');
  project = [{ ...ev('eve_20261019T040000Z', '2026-10-19T02:40:00Z', '2026-10-19T02:55:00Z', [], { series: 'eve' }), originalStart: iso('2026-10-19T04:00:00Z') }];
  await runCheckinGuard({ db, calendar, poster: async t => said.push(t), clock: () => NOW + 31 * 60_000 });
  assert.equal(writes.filter(w => w.body.start).length, 1, 'stays put');
});

test('check-ins never overlap (Project, Oct 19): the newer trial moves off the older one\'s time, a closed trial\'s check-ins are cancelled quietly', async () => {
  const db = d1(), kv = noticeStore(db), said = [], writes = [];
  const T0 = Date.parse('2026-10-19T16:50:00Z'); // Mon 9:50 AM PT
  await kv.put('checkins:p-rish', { pageId: 'p-rish', first: 'Rylan', name: 'Rylan King', end: '2026-10-21', tz: 'Asia/Kolkata', at: 1, series: [{ kind: 'morning', eventId: 'rm', target: '09:30' }], constraints: [] }, T0);
  await kv.put('checkins:p-adi', { pageId: 'p-adi', first: 'Rowan', name: 'Rowan Blake', end: '2026-10-22', tz: 'Asia/Kolkata', at: 2, series: [{ kind: 'morning', eventId: 'am', target: '09:30' }], constraints: [] }, T0);
  await kv.put('checkins:p-arlen', { pageId: 'p-arlen', first: 'Arlen', name: 'Arlen Archer', end: '2026-10-21', tz: 'Asia/Kolkata', at: 0, series: [{ kind: 'night', eventId: 'kn', target: '21:00' }], constraints: [] }, T0);
  await completedFirst(kv, 'p-rish', 'p-adi', 'p-arlen');
  const team3 = [PEOPLE.robin, PEOPLE.interviewer, PEOPLE.taylor];
  // Check-ins are free time on the calendars (transparent), which used to hide them from each other.
  const ck = (id, series, s, e, summary) => ({ ...ev(id, s, e, team3, { series, summary }), transparent: true });
  const all = [ck('rm_20261020T040000Z', 'rm', '2026-10-20T04:00:00Z', '2026-10-20T04:15:00Z', 'Rylan / Company: Morning Check-in'),
    ck('am_20261020T040000Z', 'am', '2026-10-20T04:00:00Z', '2026-10-20T04:15:00Z', 'Rowan / Company: Morning Check-in'),
    ck('kn_20261019T173500Z', 'kn', '2026-10-19T17:35:00Z', '2026-10-19T17:50:00Z', 'Arlen / Company: Night Check-in')];
  const copy = () => all.map(e => ({ ...e }));
  const cal = { project: copy(), [PEOPLE.robin]: copy(), [PEOPLE.interviewer]: copy(), [PEOPLE.taylor]: copy() };
  const calendar = { listEvents: async ({ calendarId }) => (calendarId === 'project@company.example' ? cal.project : cal[calendarId] ?? []),
    writeEvent: async w => { writes.push(w); return { id: w.eventId }; } };
  const notion = { getCandidate: async id => ({ pageId: id, fields: id === 'p-arlen' ? { Stage: 'Closed', Outcome: 'Withdrawn or Unavailable' } : { Stage: 'Work Trial', Outcome: 'Not Yet Decided' } }) };
  const out = await runCheckinGuard({ db, calendar, notion, poster: async t => said.push(t), clock: () => T0 });
  assert.deepEqual(writes.find(w => w.eventId === 'kn_20261019T173500Z'), { calendarId: 'primary', eventId: 'kn_20261019T173500Z', sendUpdates: 'none', body: { status: 'cancelled' } }, 'withdrawn: cancelled, no emails');
  assert.ok((await kv.get('checkins:p-arlen')).closed);
  const moves = writes.filter(w => w.body.start);
  assert.deepEqual(moves.map(w => w.eventId), ['am_20261020T040000Z'], 'Rylan (set up first) keeps 9:00 PM; Rowan moves');
  const s = Date.parse(moves[0].body.start.dateTime), e = Date.parse(moves[0].body.end.dateTime);
  assert.ok(e + 5 * 60_000 <= Date.parse('2026-10-20T04:00:00Z') || s >= Date.parse('2026-10-20T04:15:00Z') + 5 * 60_000, `5 minutes clear of Rylan's: ${moves[0].body.start.dateTime}`);
  assert.equal(out.cancelled, 1);
  // Free on Project's calendar, busy on each teammate's own copy (Project, Oct 19); Arlen's cancelled one is left alone.
  const busied = writes.filter(w => w.body.transparency === 'opaque');
  assert.deepEqual([...new Set(busied.map(w => w.calendarId))].sort(), [...team3].sort());
  assert.equal(busied.length, 6);
  assert.ok(busied.every(w => w.sendUpdates === 'none' && !/^kn_/.test(w.eventId)));
  assert.ok(!writes.some(w => w.calendarId === 'project@company.example' || (w.calendarId === 'primary' && w.body.transparency)), "Project's stays free");
  assert.equal(said.length, 0, 'quiet');
});

test('busyOf counts a check-in even though it is free time; other free-time events still do not count', () => {
  const events = [{ ...ev('c1', '2026-10-20T04:00:00Z', '2026-10-20T04:15:00Z', [PEOPLE.robin], { summary: 'Rylan / Company: Morning Check-in' }), transparent: true },
    { ...ev('ooo', '2026-10-20T05:00:00Z', '2026-10-20T06:00:00Z', [PEOPLE.robin], { summary: 'Val work trial banner' }), transparent: true }];
  assert.deepEqual(busyOf(events, PEOPLE.robin).map(b => b.id), ['c1']);
});

test('the trialer\'s Company email replaces their personal one on their own check-ins once it exists (series and single ones), once (Project, Oct 19)', async () => {
  const db = d1(), kv = noticeStore(db), writes = [];
  const T0 = Date.parse('2026-10-19T19:00:00Z');
  await kv.put('checkins:p-adi', { pageId: 'p-adi', first: 'Rowan', name: 'Rowan Blake', end: '2026-10-22', tz: 'Asia/Kolkata', at: 2, series: [{ kind: 'morning', eventId: 'am', target: '09:30' }], constraints: [] }, T0);
  await kv.put('onboarding:p-adi', { address: 'rowand@company.example' }, T0);
  const who = [PEOPLE.robin, PEOPLE.interviewer, PEOPLE.taylor, 'rowanb97@example.test'];
  const project = [{ ...ev('am_20261020T040000Z', '2026-10-20T03:40:00Z', '2026-10-20T03:55:00Z', who, { series: 'am', summary: 'Rowan / Company: Morning Check-in' }), transparent: true },
    { ...ev('am_20261021T040000Z', '2026-10-21T03:40:00Z', '2026-10-21T03:55:00Z', who, { series: 'am', summary: 'Rowan / Company: Morning Check-in' }), transparent: true },
    { ...ev('single1', '2026-10-22T04:00:00Z', '2026-10-22T04:15:00Z', who, { summary: 'Rowan / Company: Morning Check-in' }), transparent: true }];
  const calendar = { listEvents: async ({ calendarId }) => (calendarId === 'project@company.example' ? project : []), writeEvent: async w => { writes.push(w); return { id: w.eventId }; } };
  await runCheckinGuard({ db, calendar, poster: async () => {}, clock: () => T0 });
  const guests = writes.filter(w => w.body.attendees);
  assert.deepEqual(guests.map(w => w.eventId).sort(), ['am', 'single1']);
  // Work email only: the personal one comes off (Project, Oct 19).
  assert.ok(guests.every(w => w.body.attendees.some(a => a.email === 'rowand@company.example') && !w.body.attendees.some(a => a.email === 'rowanb97@example.test') && w.sendUpdates === 'all'));
  assert.ok(guests.every(w => w.body.attendees.length === 4));
  await runCheckinGuard({ db, calendar, poster: async () => {}, clock: () => T0 + 31 * 60_000 });
  assert.equal(writes.filter(w => w.body.attendees).length, 2, 'once');
});

test('a check-in that already has the Company email still loses the personal one (Project, Oct 19: only work email)', async () => {
  const db = d1(), kv = noticeStore(db), writes = [];
  const T0 = Date.parse('2026-10-19T19:00:00Z');
  await kv.put('checkins:p-adi', { pageId: 'p-adi', first: 'Rowan', name: 'Rowan Blake', end: '2026-10-22', tz: 'Asia/Kolkata', at: 2, series: [{ kind: 'morning', eventId: 'am', target: '09:30' }], constraints: [] }, T0);
  await kv.put('onboarding:p-adi', { address: 'rowand@company.example' }, T0);
  const who = [PEOPLE.robin, PEOPLE.interviewer, PEOPLE.taylor, 'rowanb97@example.test', 'rowand@company.example'];
  const project = [{ ...ev('am_20261020T040000Z', '2026-10-20T03:40:00Z', '2026-10-20T03:55:00Z', who, { series: 'am', summary: 'Rowan / Company: Morning Check-in' }), transparent: true, meetUrl: 'https://meet.google.com/x' }];
  const calendar = { listEvents: async ({ calendarId }) => (calendarId === 'project@company.example' ? project : []), writeEvent: async w => { writes.push(w); return { id: w.eventId }; } };
  await runCheckinGuard({ db, calendar, poster: async () => {}, clock: () => T0 });
  const g = writes.filter(w => w.body.attendees);
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].body.attendees.map(a => a.email).sort(), [PEOPLE.robin, PEOPLE.interviewer, PEOPLE.taylor, 'rowand@company.example'].sort());
});

test('changed trial dates preserve a future locked first check-in; later meetings can still be rebuilt after it', async () => {
  const db = d1(), kv = noticeStore(db), writes = [];
  const T0 = Date.parse('2026-10-20T19:00:00Z');
  await kv.put('checkins:p-s', { pageId: 'p-s', first: 'Skyler', name: 'Skyler Dawson', start: '2026-10-24', end: '2026-10-25', tz: 'Asia/Kolkata', at: 2, series: [{ kind: 'morning', eventId: 'am', target: '09:30' }], constraints: [] }, T0);
  const who = [PEOPLE.robin, PEOPLE.interviewer, PEOPLE.taylor, 'skyler@company.example'];
  const project = [{ ...ev('am_20261024T040000Z', '2026-10-24T04:00:00Z', '2026-10-24T04:15:00Z', who, { series: 'am', summary: 'Skyler / Company: Morning Check-in' }), transparent: true, meetUrl: 'https://meet.google.com/x' }];
  const calendar = { listEvents: async ({ calendarId }) => (calendarId === 'project@company.example' ? project : []), writeEvent: async w => { writes.push(w); return { id: w.eventId }; } };
  const record = { pageId: 'p-s', fields: { Stage: 'Trial', Outcome: 'Proceeding', 'Trial Start': '2026-10-31', 'Trial End': '2026-11-01' } };
  const notion = { getCandidate: async () => record };
  // Mismatch without the marker: left alone.
  await runCheckinGuard({ db, calendar, notion, poster: async () => {}, clock: () => T0, force: true });
  assert.equal(writes.filter(w => w.body.status === 'cancelled').length, 0);
  assert.ok(await kv.get('checkins:p-s'));
  await kv.put('checkins:redate:p-s', { start: '2026-10-31', end: '2026-11-01', from: '2026-10-24', at: T0 }, T0);
  const out = await runCheckinGuard({ db, calendar, notion, poster: async () => {}, clock: () => T0 + 60_000, force: true });
  assert.equal(out.firstHeld, 1);
  assert.equal(writes.filter(w => w.body.status === 'cancelled').length, 0);
  assert.ok(await kv.get('checkins:p-s'));
  await completedFirst(kv, 'p-s');
  const afterFirst = await runCheckinGuard({ db, calendar, notion, poster: async () => {}, clock: () => T0 + 120_000, force: true });
  assert.equal(afterFirst.redated, 1);
  const off = writes.filter(w => w.body.status === 'cancelled');
  assert.equal(off.length, 1);
  assert.equal(off[0].sendUpdates, 'all');
  assert.equal(await kv.get('checkins:p-s'), null, 'made again by work-trial.mjs for the new dates');
});

test('A teammate\'s own check-ins with the trialer: Uncle Sam\'s twins come off, theirs get the Company email instead of the personal one (Project, Oct 19: Rylan)', async () => {
  const db = d1(), kv = noticeStore(db), writes = [], said = [];
  const T0 = Date.parse('2026-10-19T21:30:00Z');
  await kv.put('checkins:p-rk', { pageId: 'p-rk', first: 'Rylan', name: 'Rylan King', end: '2026-10-21', tz: 'Asia/Kolkata', at: 1, series: [{ kind: 'night', eventId: 'ourNight', target: '21:00' }], constraints: [] }, T0);
  await completedFirst(kv, 'p-rk'); // Duplicate replacement remains allowed after the first check-in.
  await kv.put('onboarding:p-rk', { address: 'rylan@company.example' }, T0);
  const personal = 'rylanking@example.test';
  const ours = { ...ev('ourNight_20261020T183500Z', '2026-10-20T18:25:00Z', '2026-10-20T18:40:00Z', [PEOPLE.robin, PEOPLE.interviewer, PEOPLE.taylor, personal], { series: 'ourNight', summary: 'Rylan / Company: Night Check-in' }), transparent: true, meetUrl: 'https://meet.google.com/a', organizer: 'project@company.example' };
  const rishiNight = { ...ev('rNight', '2026-10-20T18:05:00Z', '2026-10-20T18:20:00Z', [PEOPLE.robin, PEOPLE.interviewer, PEOPLE.taylor, personal], { summary: 'Rylan / Company: Night Check-in (updated)' }), organizer: PEOPLE.robin, meetUrl: 'https://meet.google.com/b' };
  const rishiMorning = { ...ev('rMorn_20261021T040000Z', '2026-10-21T04:00:00Z', '2026-10-21T04:15:00Z', [PEOPLE.robin, personal], { series: 'rMorn', summary: 'Rylan / Company: Morning Check-in (updated)' }), organizer: PEOPLE.robin, meetUrl: 'https://meet.google.com/c' };
  const calendar = { listEvents: async ({ calendarId }) => (calendarId === 'project@company.example' ? [ours] : calendarId === PEOPLE.robin ? [rishiNight, rishiMorning] : []),
    writeEvent: async w => { writes.push(w); return { id: w.eventId }; } };
  const notion = { getCandidate: async () => ({ pageId: 'p-rk', email: personal, fields: { Stage: 'Trial', Outcome: 'Proceeding' } }) };
  const out = await runCheckinGuard({ db, calendar, notion, poster: async t => said.push(t), clock: () => T0, force: true });
  assert.equal(out.yielded, 1);
  assert.ok(writes.some(w => w.eventId === 'ourNight_20261020T183500Z' && w.body.status === 'cancelled' && w.sendUpdates === 'all'));
  assert.deepEqual(said, ['📅 Robin has his own check-ins with Rylan, so I took my duplicates off.']);
  const swaps = writes.filter(w => w.calendarId === PEOPLE.robin && w.body.attendees);
  assert.deepEqual(swaps.map(w => w.eventId).sort(), ['rMorn', 'rNight']);
  assert.ok(swaps.every(w => !w.body.attendees.some(a => a.email === personal) && w.body.attendees.some(a => a.email === 'rylan@company.example') && w.sendUpdates === 'all'));
  await runCheckinGuard({ db, calendar, notion, poster: async t => said.push(t), clock: () => T0 + 31 * 60_000, force: true });
  assert.equal(said.length, 1, 'once');
});
