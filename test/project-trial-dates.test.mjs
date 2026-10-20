import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleMasonTrialDates, datesAsk, masonConfirmedDates } from '../service/lib/project-trial-dates.mjs';
import { noticeStore } from '../service/lib/stuck-rejections.mjs';
import { createCheckins } from '../service/lib/checkins.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const PROJECT = 'U0F9EF97D89', NOW = Date.parse('2026-10-19T06:19:00Z'); // Oct 18, 11:19 PM PT
const ROWAN = { pageId: 'p-ad', fullName: 'Rowan Blake', email: 'rowanb97@example.test', fields: { Stage: 'Trial', 'Candidate brief': 'proposed Oct 19–21' }, payment: {} };
const claudeSays = input => ({ complete: async () => ({ content: [{ type: 'tool_use', name: 'dates', input }] }) });

test('"the trial is the 19th through the 21st ... get him set up now" (Oct 18): the dates go on the record, outrank "proposed", the setup wakes; no rate: one line', async () => {
  const db = d1(), said = [], set = [];
  let woke = 0;
  const notion = { findCandidatesByName: async () => [ROWAN], setTrialTerms: async x => { set.push(x); return { verified: true, set: ['dates'], conflicts: [] }; }, appendCandidateNote: async () => null };
  const event = { authorId: PROJECT, channelId: 'D1', messageTs: '5.1', text: 'well the trial is the 19th through the 21st but i kinda bombed it so get him set up now with everything' };
  assert.equal(datesAsk(event.text), true);
  const out = await handleMasonTrialDates({ event, db, notion, claude: claudeSays({ name: 'Rowan Blake', start: '2026-10-19', end: '2026-10-21', confirmed: true }),
    masonId: PROJECT, poster: () => async t => said.push(t), clock: () => NOW, wake: () => { woke++; } });
  assert.equal(out.reason, 'set');
  assert.deepEqual([set[0].start, set[0].end, set[0].days, set[0].replaceDates], ['2026-10-19', '2026-10-21', 3, true]);
  assert.equal(woke, 1);
  assert.equal(said[0], 'Roger that 🫡 Need his daily rate before his enlistment papers ship out.');
  assert.equal(await masonConfirmedDates({ kv: noticeStore(db), pageId: 'p-ad', start: '2026-10-19', end: '2026-10-21' }), true);
  // A question is not a confirmation.
  const q = await handleMasonTrialDates({ event: { ...event, messageTs: '5.2', text: 'are the trial dates for rowan the 19-21st?' }, db, notion,
    claude: claudeSays({ name: 'Rowan Blake', start: '2026-10-19', end: '2026-10-21', confirmed: false }), masonId: PROJECT, poster: () => async t => said.push(t), clock: () => NOW });
  assert.equal(q, null);
});

test('check-ins for a trial already under way start at the first time still ahead', async () => {
  const db = d1(), events = [];
  const calendar = { writeEvent: async w => { events.push(w); return { id: `e${events.length}` }; } };
  // India trial Oct 19–21 set at 11:19 PM PT Oct 18: Oct 19's 9:30 AM IST morning check-in (Oct 18, 9 PM PT) has passed.
  await createCheckins({ db, calendar, who: { pageId: 'p-ad', fullName: 'Rowan Blake', email: 'a@x.co' }, start: '2026-10-19', end: '2026-10-21', clock: () => NOW, tz: 'Asia/Kolkata', morning: '09:30', night: '22:45' });
  const [m, n] = events;
  assert.equal(m.body.recurrence[0], 'RRULE:FREQ=DAILY;COUNT=2');
  assert.ok(Date.parse(m.body.start.dateTime) > NOW);
  assert.equal(n.body.recurrence[0], 'RRULE:FREQ=DAILY;COUNT=3', 'Oct 19 night IST (Oct 19 morning PT) is still ahead');
});
