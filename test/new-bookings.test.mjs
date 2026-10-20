import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runNewBookings, handleBookingReply, bookerOf, pipelineFromBooking, hostOf, HOLD_MS } from '../service/lib/new-bookings.mjs';
import { plainDescription } from '../service/lib/google-calendar.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const CASEY = { id: 'jmho', iCalUID: 'jmho@example.test', calendarId: 'robin@company.example', summary: '30 Min call Robin (Casey Reed)', status: 'confirmed',
  start: '2026-10-19T13:50:00-07:00', end: '2026-10-19T14:20:00-07:00', allDay: false, created: '2026-10-16T17:15:41Z',
  attendees: [{ email: 'robin@company.example', self: true }, { email: 'caseyjreed@example.test' }],
  description: plainDescription('<b>Booked by</b>\nCasey Reed\ncaseyjreed@example.test\n<br><b>LinkedIn</b>\nlinkedin.com/in/sample-84422f0bf3b2') };
const PROJECT = 'U0F9EF97D89';

test('New bookings: who booked, their pipeline only when the booking shows it, and the host', () => {
  assert.deepEqual(bookerOf(CASEY), { name: 'Casey Reed', email: 'caseyjreed@example.test', linkedin: 'https://www.linkedin.com/in/sample-84422f0bf3b2' });
  assert.deepEqual(bookerOf({ ...CASEY, summary: '30 Min call Robin (charlie grant)', description: 'Booked by\nharshit grant\ncharlieg64@example.test' }).name, 'Charlie Grant');
  assert.equal(bookerOf({ ...CASEY, summary: '30 minutes with JP (Robin Cooper)', attendees: [{ email: 'robin@company.example' }], description: 'Booked by\nRobin Cooper\nrobin@company.example' }), null, 'a teammate booking is not a candidate');
  assert.equal(bookerOf({ ...CASEY, summary: 'Client sync', description: 'Agenda' }), null, 'not from a booking page');
  assert.equal(pipelineFromBooking(CASEY, bookerOf(CASEY)), null, 'never guessed from a name');
  assert.equal(pipelineFromBooking(CASEY, { email: 'sample@university.example.in' }), 'India');
  assert.equal(pipelineFromBooking({ description: 'Phone +91 98450 12345' }, { email: 'a@example.test' }), 'India');
  assert.equal(hostOf(CASEY), 'Robin');
});

function world({ known = [] } = {}) {
  const w = { db: d1(), posts: [], created: [], notes: [], pipelines: [], n: 0 };
  w.scorecards = [];
  w.notion = { readControl: async () => ({ mode: 'Live' }), createLateScorecard: async a => { w.scorecards.push(a); return { verified: true, pageId: 's1', url: 'https://www.notion.so/s1' }; },
    findCandidatesByEmail: async e => known.filter(c => c.email === e), findCandidatesByLinkedIn: async () => [], findCandidatesByName: async () => [],
    createCandidate: async a => { w.created.push(a); return { verified: true, pageId: 'new1', url: 'https://www.notion.so/new1' }; },
    appendCandidateNote: async n => { w.notes.push(n); }, setPipeline: async a => { w.pipelines.push(a); return { verified: true }; } };
  w.calendar = { listEvents: async () => [CASEY] };
  w.poster = (threadTs = null) => async text => { const ts = `17922${String(++w.n).padStart(5, '0')}.000100`; w.posts.push({ threadTs, text, ts }); return ts; };
  w.run = now => runNewBookings({ env: { UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled' }, db: w.db, notion: w.notion, calendar: w.calendar,
    calendarIds: ['robin@company.example', 'project@company.example'], poster: w.poster, clock: () => now });
  w.reply = (text, now) => handleBookingReply({ event: { channelId: 'D0MASON001', threadTs: w.posts[0].ts, messageTs: '1792300000.000100', authorId: PROJECT, text },
    db: w.db, notion: w.notion, poster: w.poster, clock: () => now });
  return w;
}
const T = Date.parse('2026-10-16T17:40:00Z');

test('New bookings: Casey Reed booked Robin and is on no record — Project told at once, added 30 minutes later, once', async () => {
  const w = world();
  const first = await w.run(T);
  assert.equal(first.held, 1, 'booked an hour before the switch-on: still counts');
  assert.equal(w.posts.length, 1, 'one notice, though two calendars were read');
  assert.equal(w.posts[0].text, '📋 New booking: <https://www.linkedin.com/in/sample-84422f0bf3b2|Casey Reed> booked a call with Robin for Mon Oct 19, 1:50 PM PT and isn\'t on the tracker. I add them in 30 minutes as Interview · R2 — Technical. US/EU or India? Reply here with one. Reply "skip" if they\'re not a candidate.');
  await w.run(T + 20 * 60_000);
  assert.equal(w.created.length, 0);
  assert.equal((await w.reply('us/eu', T + 25 * 60_000)).reason, 'pipeline_noted');
  await w.run(T + HOLD_MS + 20 * 60_000);
  assert.equal(w.created.length, 1);
  assert.deepEqual(w.created[0], { fullName: 'Casey Reed', email: 'caseyjreed@example.test', linkedin: 'https://www.linkedin.com/in/sample-84422f0bf3b2', pipeline: 'US/EU',
    stage: 'Interview', round: 'R2 — Technical', outcome: 'Not Yet Decided', indiaStage: null, nextAction: 'First interview (30 minutes) with Robin Mon Oct 19, 1:50 PM PT (booked through the booking page). Added by Uncle Sam.',
    owners: ['Project'], actionStatus: 'Meeting Booked' }, 'US/EU: the Category comes from the profile (Clay), none when unclear');
  assert.equal(w.posts.at(-1).text, '🫡 Added: <https://www.notion.so/new1|Casey Reed> · Interview · R2 — Technical · US/EU.');
  assert.equal(w.posts.at(-1).threadTs, w.posts[0].ts);
  await w.run(T + 3 * HOLD_MS);
  assert.equal(w.created.length, 1, 'once');
  assert.equal((await w.reply('india', T + 4 * HOLD_MS)).reason, 'pipeline_set', 'a later word from Project replaces it');
  assert.deepEqual(w.pipelines[0], { pageId: 'new1', expectedEmail: 'caseyjreed@example.test', pipeline: 'India', replace: true, indiaStage: 'First Round' });
});

test('New bookings: "skip" keeps them off; someone on the tracker is left alone; a closed record booking again is pointed out', async () => {
  const w = world();
  await w.run(T);
  assert.equal((await w.reply('skip, that is a client', T + 60_000)).reason, 'skipped');
  await w.run(T + HOLD_MS + 20 * 60_000);
  assert.equal(w.created.length, 0);
  const k = world({ known: [{ pageId: 'c9', email: 'caseyjreed@example.test', fields: { Stage: 'Intro Call', Outcome: 'Not Yet Decided' }, url: 'https://www.notion.so/c9' }] });
  await k.run(T);
  assert.equal(k.posts.length, 0);
  const c = world({ known: [{ pageId: 'c9', email: 'caseyjreed@example.test', fields: { Stage: 'Closed', Outcome: 'Not Selected' }, url: 'https://www.notion.so/c9' }] });
  await c.run(T); await c.run(T + 20 * 60_000);
  assert.equal(c.posts.length, 1);
  assert.match(c.posts[0].text, /but their record is closed \(Not Selected\): <https:\/\/www\.notion\.so\/c9\|record>\. I changed nothing\.$/);
});

test('New bookings: Interviewer\'s two links — his interview page is an Interview, the deep dive means a take-home passed off the tracker', async () => {
  const SANTOSH_PAGE = { ...CASEY, id: 'k1', iCalUID: 'k1@g', calendarId: 'quinn@company.example', summary: '30 min with J Quinn (Dakota Hughes)',
    attendees: [{ email: 'quinn@company.example', self: true }, { email: 'dakotah0411@example.test' }], description: 'Booked by\nDakota Hughes\ndakotah0411@example.test' };
  const w = world();
  w.calendar.listEvents = async () => [SANTOSH_PAGE];
  await w.run(T);
  assert.equal(w.posts[0].text, '📋 New booking: Dakota Hughes booked Interviewer\'s interview ("30 min with J Quinn") for Mon Oct 19, 1:50 PM PT and isn\'t on the tracker. I add them in 30 minutes to the India pipeline, First Round (Interview · R2 — Technical). Reply "US/EU" if it\'s a US/EU interview round, or "skip" if they\'re not a candidate.');
  await w.run(T + HOLD_MS + 20 * 60_000);
  assert.deepEqual([w.created[0].stage, w.created[0].round, w.created[0].outcome, w.created[0].pipeline, w.created[0].indiaStage], ['Interview', 'R2 — Technical', 'Not Yet Decided', 'India', 'First Round'], 'Interviewer does no intro calls: India First Round');
  assert.match(w.posts.at(-1).text, /· Interview · R2 — Technical · India \(First Round\)\.$/);
  const us = world();
  us.calendar.listEvents = async () => [SANTOSH_PAGE];
  await us.run(T);
  await us.reply('US/EU', T + 60_000);
  await us.run(T + HOLD_MS + 20 * 60_000);
  assert.deepEqual([us.created[0].stage, us.created[0].pipeline, us.created[0].indiaStage], ['Interview', 'US/EU', null], 'a US/EU interview round');
  const DEEP = { ...CASEY, id: 'd1', iCalUID: 'd1@g', calendarId: 'quinn@company.example', summary: 'Technical Deep Dive (1 of 2 spots filled)',
    attendees: [{ email: 'quinn@company.example', self: true }, { email: 'harsh@example.com' }], description: 'Event Attendance: 1 of 2 spots filled\nConfirmed Invitees: Charlie Grant' };
  const d = world();
  d.calendar.listEvents = async () => [DEEP];
  await d.run(T);
  assert.match(d.posts[0].text, /booked Interviewer's deep dive \("Technical Deep Dive"\).*as Case Study · Proceeding \(deep dive booked\)/);
  await d.run(T + HOLD_MS + 20 * 60_000);
  assert.deepEqual([d.created[0].stage, d.created[0].outcome], ['Case Study', 'Proceeding']);
  assert.match(d.created[0].nextAction, /^Technical deep dive with Interviewer/);
  assert.equal(d.scorecards.length, 1, 'their take-home scorecard is made, so they show on the Take-homes tab');
  assert.equal(d.scorecards[0].candidatePageId, 'new1');
  const k = world({ known: [{ pageId: 'c7', fullName: 'Charlie Grant', email: 'harsh@example.com', fields: { Stage: 'Case Study', Outcome: 'Proceeding' }, url: 'https://www.notion.so/c7' }] });
  k.calendar.listEvents = async () => [DEEP];
  await k.run(T); await k.run(T + 20 * 60_000);
  assert.equal(k.posts.length, 0, 'on the tracker: nothing to say');
  assert.deepEqual(k.scorecards.map(s => s.candidatePageId), ['c7'], 'but a missing scorecard is made, once');
  const noLi = world();
  noLi.calendar.listEvents = async () => [{ ...CASEY, description: 'Booked by\nCasey Reed\ncaseyjreed@example.test' }];
  await noLi.run(T);
  // Robin also takes calls that aren't interviews (Project, Oct 17): no LinkedIn and no #int-recruitment mention -> only on "add".
  assert.match(noLi.posts[0].text, /No LinkedIn on the booking and #int-recruitment doesn't name them, so it may not be an interview\. I add them only if you reply "add"/);
  await noLi.run(T + HOLD_MS + 20 * 60_000);
  assert.equal(noLi.created.length, 0, 'not added without Project');
  assert.match(noLi.posts.at(-1).text, /^🫡 Not added: Casey Reed booked "30 Min call Robin" with Robin with no LinkedIn/);
  const fr = world();
  fr.calendar.listEvents = async () => [{ ...CASEY, description: 'Booked by\nCasey Reed\ncaseyjreed@example.test' }];
  await fr.run(T);
  assert.equal((await fr.reply('first round, us', T + 60_000)).reason, 'first_round');
  await fr.run(T + HOLD_MS + 20 * 60_000);
  assert.deepEqual([fr.created[0].stage, fr.created[0].pipeline], ['Interview', 'US/EU']);
});

test('New bookings: any other page is added only when #int-recruitment names them, or on Project\'s "add"', async () => {
  const OTHER = { ...CASEY, id: 'o1', iCalUID: 'o1@g', calendarId: 'project@company.example', summary: 'Partnership chat (Dana Cole)', attendees: [{ email: 'project@company.example' }, { email: 'dana@client.example' }],
    description: 'Booked by\nDana Cole\ndana@client.example' };
  const w = world();
  w.calendar.listEvents = async () => [OTHER];
  await w.run(T);
  assert.match(w.posts[0].text, /isn't an interview booking page and #int-recruitment doesn't name them, so I add them only if you reply "add"/);
  await w.run(T + HOLD_MS + 20 * 60_000);
  assert.equal(w.created.length, 0);
  assert.match(w.posts.at(-1).text, /^🫡 Not added: Dana Cole booked "Partnership chat" with Project/);
  await w.run(T + HOLD_MS + 40 * 60_000);
  assert.equal(w.posts.length, 2, 'said once');
  assert.equal((await w.reply('add, india', T + HOLD_MS + 45 * 60_000)).reason, 'add_confirmed');
  await w.run(T + HOLD_MS + 60 * 60_000);
  assert.equal(w.created.length, 1);
  assert.equal(w.created[0].pipeline, 'India');

  const m = world();
  m.calendar.listEvents = async () => [OTHER];
  const run = now => runNewBookings({ env: { UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled' }, db: m.db, notion: m.notion, calendar: m.calendar, calendarIds: ['robin@company.example'],
    poster: m.poster, clock: () => now, recruitingMessages: async () => [{ user: 'U0A4F08721B', text: 'Dana Cole is a strong backend profile, booking her with me' }] });
  await run(T);
  assert.match(m.posts[0].text, /I add them in 30 minutes as Interview · R2 — Technical\. .*\n#int-recruitment: "Dana Cole is a strong backend profile, booking her with me"$/s);
  await run(T + HOLD_MS + 20 * 60_000);
  assert.equal(m.created.length, 1, 'named in #int-recruitment: an interview for sure');
});

test('New bookings: pipelines said in a plain DM message — "Casey US/EU, the other two India"; a LinkedIn question is answered plainly', async () => {
  const DAKOTA = { ...CASEY, id: 'k1', iCalUID: 'k1@g', summary: '30 min with J Quinn (Dakota Hughes)', attendees: [{ email: 'quinn@company.example' }, { email: 'dakotah0411@example.test' }], description: 'Booked by\nDakota Hughes\ndakotah0411@example.test' };
  const SAGE = { ...CASEY, id: 'v1', iCalUID: 'v1@g', summary: '30 min with J Quinn (Sage Russell)', attendees: [{ email: 'quinn@company.example' }, { email: 'sagerussell@example.test' }], description: 'Booked by\nSage Russell\nsagerussell@example.test' };
  const w = world();
  w.calendar.listEvents = async () => [CASEY, DAKOTA, SAGE];
  await w.run(T);
  const say = (text, now) => handleBookingReply({ event: { channelId: 'D0MASON001', threadTs: null, messageTs: '1792300000.000100', authorId: PROJECT, text }, db: w.db, notion: w.notion, poster: w.poster, clock: () => now });
  assert.equal((await say('shouldnt you be able to tell based on his linkedin?', T + 60_000)).reason, 'linkedin_question');
  assert.match(w.posts.at(-1).text, /^🫡 I can't open LinkedIn profiles/);
  assert.equal(await say('ok thanks', T + 90_000), null, 'anything else goes on to the usual lanes');
  assert.equal((await say('Casey is US/EU, the other two India', T + 2 * 60_000)).reason, 'pipelines');
  assert.equal(w.posts.at(-1).text, '🫡 Casey Reed: US/EU (when I add them). Dakota Hughes: India (when I add them). Sage Russell: India (when I add them).');
  await w.run(T + HOLD_MS + 20 * 60_000);
  assert.deepEqual(w.created.map(c => [c.fullName, c.pipeline]), [['Casey Reed', 'US/EU'], ['Dakota Hughes', 'India'], ['Sage Russell', 'India']]);
});

test('Robin\'s picks (Project, 2026-10-18): the first round is always a 30-minute interview with Robin and/or Interviewer, never an intro call', async () => {
  const { noticeStore } = await import('../service/lib/stuck-rejections.mjs');
  const pickLog = { items: [{ slug: 'sample-84422f0bf3b2', name: 'Casey Reed', verdict: 'reach_out', by: 'Robin', location: 'Bengaluru, Karnataka, India', at: T - 86400_000 }] };
  // A pick at Outreach (they answered Robin's message) books Robin's page: Interview / R2, India First Round, quietly, with a note.
  const atOutreach = { pageId: 'p1', fullName: 'Casey Reed', email: 'caseyjreed@example.test', url: 'https://www.notion.so/p1', profile: { linkedin: 'https://www.linkedin.com/in/sample-84422f0bf3b2' },
    fields: { Stage: 'Outreach', Outcome: 'Not Yet Decided', Pipeline: 'India', 'India Stage': 'Outreach' } };
  const w = world({ known: [atOutreach] }), moved = [];
  await noticeStore(w.db).put('sourcing:log', pickLog, T);
  w.notion.recordRecap = async a => { moved.push(a); return { verified: true }; };
  await w.run(T);
  assert.deepEqual(moved.map(m => [m.pageId, m.toInterview, m.toIntro]), [['p1', true, undefined]]);
  assert.match(moved[0].nextAction, /^First interview \(30 minutes\) with Robin/);
  assert.match(w.notes[0].text, /moved from Outreach to the first round/);
  assert.equal(w.posts.length, 0, 'quiet');
  // Someone at Outreach who isn't a pick is left alone.
  const w1 = world({ known: [atOutreach] }), moved1 = [];
  w1.notion.recordRecap = async a => { moved1.push(a); return { verified: true }; };
  await w1.run(T);
  assert.equal(moved1.length, 0);
  // A pick not on the tracker books Robin's page with no LinkedIn on the form and no mention: their first interview, India from their LinkedIn.
  const w2 = world();
  await noticeStore(w2.db).put('sourcing:log', pickLog, T);
  w2.calendar = { listEvents: async () => [{ ...CASEY, description: plainDescription('<b>Booked by</b>\nCasey Reed\ncaseyjreed@example.test') }] };
  await w2.run(T);
  assert.match(w2.posts[0].text, /Robin picked them from a profile list, so it's their first interview: I add them in 30 minutes as Interview · R2 — Technical \(first round\), India pipeline First Round\./);
  await w2.run(T + HOLD_MS + 20 * 60_000);
  assert.deepEqual([w2.created[0].stage, w2.created[0].round, w2.created[0].pipeline, w2.created[0].indiaStage], ['Interview', 'R2 — Technical', 'India', 'First Round']);
  assert.match(w2.created[0].nextAction, /^First interview \(30 minutes\) with Robin/);
});
