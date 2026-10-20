import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runWorkTrials, bannerName, markFirstCheckins } from '../service/lib/work-trial.mjs';

const NOW = Date.parse('2026-10-16T18:00:00Z'); // Fri Oct 16, 11am PT
const ENV = { UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled' };
function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const person = (fields = {}) => ({ pageId: '3f26ba36-8537-8000-8000-0000000000a1', fullName: 'Arlen Archer ⭐', email: 'arlen@example.invalid', url: 'https://www.notion.so/x',
  fields: { Stage: 'Trial', Paperwork: 'Signed', 'India Stage': 'Pre Work Trial', 'Action Status': 'Waiting on Candidate', 'Payment Status': 'Have Not Started Yet',
    'Trial Start': '2026-10-17', 'Trial End': '2026-10-18', 'Next action': 'Start Sat.', 'Candidate brief': '', ...fields } });
const NOTE = 'Jamie: Arlen’s Company email and Slack account are created.';
const claudeSays = input => ({ async complete() { return { content: [{ type: 'tool_use', name: 'accounts', input }] }; } });
function world(candidate, { banners = [] } = {}) {
  const writes = [], events = [], posted = [], notes = [];
  const notion = { readControl: async () => ({ mode: 'Live' }), listTrialCandidates: async () => [candidate],
    listCandidateNotes: async () => [{ at: '2026-10-16T01:00:00Z', source: 'slack-dm', text: NOTE }],
    setTrialFields: async ({ fields }) => { writes.push(fields); Object.assign(candidate.fields, fields); return { verified: true }; },
    appendCandidateNote: async n => { notes.push(n); return { verified: true }; }, upsertOperationsRecord: async () => ({ verified: true }) };
  const template = { id: 'tmpl1', allDay: true, status: 'confirmed', summary: 'Elliot Woods Work Trial (Remote)', updated: '2026-10-15T01:43:17Z', start: '2026-10-11T00:00:00Z', end: '2026-10-19T00:00:00Z',
    attendees: ['taylor', 'robin', 'quinn', 'project', 'parker', 'alexis'].map(n => ({ email: `${n}@company.example` })).concat([{ email: 'elliotw1221@example.test' }]) };
  const calendar = { listEvents: async ({ q }) => (q === 'Work Trial' ? [template, ...banners] : banners),
    writeEvent: async w => { events.push(w); return { id: 'newbanner', htmlLink: 'https://calendar.google.com/x' }; } };
  return { notion, calendar, writes, events, posted, notes, poster: async t => posted.push(t) };
}

test('Work trials: signed paperwork and confirmed accounts move a pre-trial candidate to Ready to Start and put the banner on Project\'s calendar, once', async () => {
  const c = person({ 'Gmail access': true, 'Slack access': true, 'Okta access': true }), w = world(c), db = d1();
  const run = () => runWorkTrials({ env: ENV, db, notion: w.notion, calendar: w.calendar, canWrite: true, claude: claudeSays({ ready: true, quote: 'Company email and Slack account are created' }), poster: w.poster, clock: () => NOW, force: true });
  const out = await run();
  assert.equal(out.error, null, JSON.stringify(out));
  assert.deepEqual(w.writes, [{ 'India Stage': 'Active Work Trial', 'Action Status': 'Ready to Start' }], 'Ready to Start with the checks in place; no payment change before the start');
  // The banner (no Meet link) and, India pipeline, the two daily check-in series with Meet links (Project, 2026-10-16).
  assert.equal(w.events.length, 3);
  assert.equal(w.events[0].conferenceDataVersion, 1);
  assert.ok(!w.events[0].body.conferenceData, 'no Meet on the banner');
  assert.deepEqual(w.events.slice(1).map(e => e.body.summary), ['Arlen / Company: Morning Check-in', 'Arlen / Company: Night Check-in']);
  assert.ok(w.events.slice(1).every(e => e.body.conferenceData?.createRequest && e.body.transparency === 'transparent'));
  assert.match(w.posted[1], /^📅 Arlen Archer's check-ins are on the calendar, Oct 17 – Oct 18: mornings 9:00 PM PT/);
  const body = w.events[0].body;
  assert.equal(body.summary, 'Arlen Archer Work Trial (Remote)');
  assert.deepEqual([body.start.date, body.end.date, body.transparency], ['2026-10-17', '2026-10-19', 'transparent']);
  assert.deepEqual(body.attendees.map(a => a.email).sort(), ['rory@company.example', 'manager@company.example', 'quinn@company.example', 'jamie@company.example', 'robin@company.example', 'alexis@company.example', 'taylor@company.example'].sort(), 'the recruiting team (and Taylor) only, never the trialer');
  assert.match(w.posted[0], /^📅 Put Arlen Archer's work trial on your calendar \(Oct 17 – Oct 18, remote\) and invited the recruiting team\./);
  await run();
  assert.equal(w.events.length, 3, 'never a second banner or second check-ins');
});

test('Work trials: confirmed dates give the banner but never Ready to Start without the checks; an unearned orange is taken back (Project, 2026-10-20)', async () => {
  for (const [c, claude] of [[person({ Paperwork: 'Sent' }), claudeSays({ ready: true, quote: 'Company email and Slack account are created' })],
    [person(), claudeSays({ ready: false })], [person(), claudeSays({ ready: true, quote: 'Okta is all set up' })],
    [person({ 'Gmail access': true, 'Slack access': true }), claudeSays({ ready: true, quote: 'Okta is all set up' })]]) {
    const w = world(c);
    await runWorkTrials({ env: ENV, db: d1(), notion: w.notion, calendar: w.calendar, canWrite: true, claude, clock: () => NOW, force: true });
    assert.ok(!w.writes.some(x => x['Action Status'] === 'Ready to Start'), JSON.stringify(w.writes));
    assert.deepEqual(w.events.map(e => e.body.summary), ['Arlen Archer Work Trial (Remote)']);
  }
  // Skyler: orange with nothing signed goes back to Waiting on Candidate.
  const s = person({ Paperwork: null, 'Action Status': 'Ready to Start' }), ws = world(s);
  await runWorkTrials({ env: ENV, db: d1(), notion: ws.notion, calendar: ws.calendar, canWrite: true, claude: claudeSays({ ready: false }), clock: () => NOW, force: true });
  assert.deepEqual(ws.writes[0], { 'Action Status': 'Waiting on Candidate' });
  const c = person({ 'Next action': 'Trial dates tentative, confirm with Robin' }), w = world(c);
  await runWorkTrials({ env: ENV, db: d1(), notion: w.notion, calendar: w.calendar, canWrite: true, claude: claudeSays({ ready: true, quote: 'Company email and Slack account are created' }), clock: () => NOW, force: true });
  assert.ok(!w.writes.some(x => x['Action Status'] === 'Ready to Start')); assert.equal(w.events.length, 0);
  assert.equal(bannerName('Reagan Turner (Mercor)'), 'Reagan Turner');
});

test('Work trials: on the start day it is On Trial and Actively in Trial; an existing banner with other dates is moved, not duplicated; Needs Project is kept', async () => {
  const c = person({ 'Trial Start': '2026-10-16', 'Trial End': '2026-10-18', 'Action Status': 'Needs Project' });
  const w = world(c, { banners: [{ id: 'old1', allDay: true, status: 'confirmed', summary: 'Arlen Archer Work Trial (Remote)', start: '2026-10-17T00:00:00Z', end: '2026-10-19T00:00:00Z', attendees: [] }] });
  await runWorkTrials({ env: ENV, db: d1(), notion: w.notion, calendar: w.calendar, canWrite: true, claude: claudeSays({ ready: true, quote: 'Company email and Slack account are created' }), poster: w.poster, clock: () => NOW, force: true });
  assert.deepEqual(w.writes[0], { 'India Stage': 'Active Work Trial', 'Payment Status': 'Actively in Trial' });
  assert.equal(w.events[0].eventId, 'old1');
  assert.equal(w.events.filter(e => e.eventId).length, 1, 'moved, not duplicated');
  assert.deepEqual(w.events[0].body, { start: { date: '2026-10-16' }, end: { date: '2026-10-19' } });
});

test('Work trials: a trial that started without signed paperwork shows as on trial, with its banner (Project hears at noon instead, pre-start-paperwork)', async () => {
  const c = person({ Paperwork: 'Sent', 'Trial Start': '2026-10-16', 'Trial End': '2026-10-18' });
  const w = world(c), db = d1();
  const run = () => runWorkTrials({ env: ENV, db, notion: w.notion, calendar: w.calendar, canWrite: true, claude: claudeSays({ ready: true, quote: 'x' }), poster: w.poster, clock: () => NOW, force: true });
  await run();
  assert.deepEqual(w.writes[0], { 'India Stage': 'Active Work Trial', 'Payment Status': 'Actively in Trial', 'Action Status': 'On Trial' });
  assert.deepEqual(w.events.map(e => e.body.summary), ['Arlen Archer Work Trial (Remote)'], 'the banner; no check-ins without the email');
  await run();
  assert.ok(w.posted.every(t => !/^🚨/.test(t)), 'no trial-start alert');
});

test('Work trials: the tier list takes a trialer only once day 1 is under way and their first check-in has ended (Project, 2026-10-20)', async () => {
  const now = Date.parse('2026-10-20T18:00:00Z');
  const mk = (id, name, email, start, end) => ({ pageId: `3f26ba36-8537-8000-8000-00000000000${id}`, fullName: name, email, fields: { 'Trial Start': start, 'Trial End': end, 'First check-in done': false } });
  const list = [mk(1, 'Rowan Blake', 'a@x.invalid', '2026-10-20', '2026-10-22'), mk(2, 'Rylan King ⭐', 'r@x.invalid', '2026-10-20', '2026-10-22'),
    mk(3, 'Avery James Carter ⭐', 'j@x.invalid', '2026-10-05', '2026-10-07'), mk(4, 'Skyler Dawson', 's@x.invalid', '2026-10-24', '2026-10-25')];
  const events = [{ id: 'e1', status: 'confirmed', summary: 'Rowan / Company: Morning Check-in', start: '2026-10-20T03:30:00Z', end: '2026-10-20T04:00:00Z', attendees: [] },
    { id: 'e2', status: 'confirmed', summary: 'Rylan / Company: Night Check-in', start: '2026-10-20T18:30:00Z', end: '2026-10-20T19:00:00Z', attendees: [] }];
  const marked = [];
  const notion = { listTierCandidates: async () => list, setFirstCheckinDone: async a => { marked.push(a.pageId.slice(-1)); return { verified: true }; }, appendCandidateNote: async () => ({}) };
  const out = await markFirstCheckins({ db: d1(), notion, calendar: { listEvents: async () => events }, clock: () => now, force: true });
  assert.equal(out.marked, 1, JSON.stringify(out));
  assert.deepEqual(marked, ['1'], 'only Rowan has a linked ended check-in; elapsed trial dates alone do not count');
});
