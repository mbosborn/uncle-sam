import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { findAssignments, saveAssignments, assignmentsReader, previewMessage, runInterviewPreview, runInterviewSchedule, runScheduleEveningPreview, scheduleMessage, timeRange, postTime, refreshSchedules, looksLikeAssignment, isScheduleThread, TAKER_IDS } from '../service/lib/interview-plan.mjs';
import { isRecruitingMeeting } from '../service/lib/wispr.mjs';
import { PEOPLE } from '../service/lib/agent-runner.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a) }) });
  return { prepare };
}
const claudeSays = assignments => ({ calls: [], async complete(req) { this.calls.push(req); return { content: [{ type: 'tool_use', name: 'assign', input: { assignments } }] }; } });
const EVENTS = [
  { dedupe: 'e1', when: 'Fri, Oct 16, 10:30 AM PT', kind: 'Intro call', candidate: { fullName: 'Cameron Wells' }, onCalendar: ['robin', 'interviewer'], title: '30 Min call Robin (Cameron Wells)' },
  { dedupe: 'e2', when: 'Fri, Oct 16, 5:10 PM PT', kind: 'Intro call', candidate: { fullName: 'Emery Rowan Oj' }, onCalendar: ['robin', 'interviewer'], title: '30 Min call Robin (Emery Rowan Oj)' },
];
const SYNC = "Project Owner: So all of them tomorrow you're taking, and then except for the 5:10 Robin's taking.\nRobin: Actually I'll also be on the 5:10 with Emery.";

test('Assignments: only with a word-for-word quote, only the team, one per interview; kept per event for the runner', async () => {
  const claude = claudeSays([
    { event_index: 0, takers: ['Interviewer'], quote: "So all of them tomorrow you're taking" },
    { event_index: 1, takers: ['Robin', 'Interviewer'], quote: "I'll also be on the 5:10 with Emery" },
    { event_index: 1, takers: ['Robin'], quote: 'a second one for the same interview' },
    { event_index: 5, takers: ['Robin'], quote: "So all of them tomorrow you're taking" },
    { event_index: 0, takers: ['Alexis'], quote: 'words nobody said' }]);
  const found = await findAssignments({ claude, text: SYNC, events: EVENTS, context: 'the recruiting sync' });
  assert.deepEqual(found.map(a => [a.event.dedupe, a.ids]), [['e1', [PEOPLE.interviewer]], ['e2', [PEOPLE.robin, PEOPLE.interviewer]]]);
  assert.match(claude.calls[0].messages[0].content, /\[1\] Fri, Oct 16, 5:10 PM PT · Intro call · Emery Rowan Oj · on the invite: Robin, Interviewer/);
  const db = d1();
  await saveAssignments({ db, assignments: found, source: 'wispr:m1', clock: () => 1 });
  assert.deepEqual((await assignmentsReader(db)('e2')).ids, [PEOPLE.robin, PEOPLE.interviewer]);
  assert.equal(await assignmentsReader(db)('nope'), null);
  assert.deepEqual(Object.keys(TAKER_IDS), ['Robin', 'Alexis', 'Interviewer', 'AA']);
});

test('Preview message: who will be asked, a group DM for two, and the unclear ones said plainly', () => {
  const text = previewMessage([
    { when: 'Fri, Oct 16, 10:30 AM PT', kind: 'Intro call', candidate: { fullName: 'Cameron Wells', linkedin: 'https://www.linkedin.com/in/sample-3bb8668bb7a3' }, takers: ['interviewer'], title: 'x' },
    { when: 'Fri, Oct 16, 5:10 PM PT', kind: 'Intro call', candidate: { fullName: 'Emery Rowan Oj' }, takers: ['robin', 'interviewer'], stated: true, title: 'x' },
    { when: 'Fri, Oct 16, 6:30 PM PT', kind: 'Technical deep dive', candidate: null, ambiguous: ['Reagan Turner', 'Reagan Turner (Mercor)'], takers: ['interviewer'], title: 'Technical Deep Dive (1 of 2 spots filled)' },
  ], 'Fri, Oct 16');
  assert.match(text, /^📅 Interviews today \(Fri, Oct 16\)/);
  assert.match(text, /10:30 AM PT — <https:\/\/www.linkedin.com\/in\/sample-3bb8668bb7a3\|Cameron Wells> · Intro call · I'll ask Interviewer/);
  assert.match(text, /5:10 PM PT — Emery Rowan Oj · Intro call · I'll ask Robin and Interviewer together in a group DM \(as said\)/);
  assert.match(text, /⚠️ more than one record named Reagan Turner \/ Reagan Turner \(Mercor\)/);
  assert.equal(previewMessage([], 'Fri'), null);
});

test('Preview: once a morning from 7am Pacific, only when something needs Project, nothing at night', async () => {
  const db = d1(), posted = [];
  const runner = { async previewInterviews() { return [{ start: '2026-10-16T17:30:00Z', kind: 'Intro call', candidate: { fullName: 'Cameron Wells' }, takers: ['interviewer'], title: 'x' },
    { start: '2026-10-17T01:30:00Z', kind: 'Technical deep dive', candidate: null, ambiguous: ['Reagan Turner', 'Reagan Turner (Mercor)'], takers: ['interviewer'], title: 'Technical Deep Dive' }]; } };
  const env = { UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled' };
  const at = iso => () => Date.parse(iso);
  assert.equal((await runInterviewPreview({ env, db, runner, poster: async t => posted.push(t), clock: at('2026-10-16T12:00:00Z') })).state, 'not_due'); // 5am PT
  assert.equal((await runInterviewPreview({ env, db, runner, poster: async t => posted.push(t), clock: at('2026-10-16T14:05:00Z') })).state, 'sent'); // 7:05am PT
  assert.equal((await runInterviewPreview({ env, db, runner, poster: async t => posted.push(t), clock: at('2026-10-16T15:05:00Z') })).state, 'sent_today');
  assert.equal(posted.length, 1);
  assert.match(posted[0], /10:30 AM PT — Cameron Wells · Intro call · I'll ask Interviewer/);
});

test('Wispr: a recruiting sync saved under another name is still read when its summary is plainly about hiring', () => {
  assert.equal(isRecruitingMeeting({ title: 'Work Trial Contract Planning', content_excerpt: "Hiring pipeline review: triaged candidates through take-home and work-trial stages, and assigned tomorrow's interviews to Interviewer." }), true);
  assert.equal(isRecruitingMeeting({ title: 'EOD Sync', content_excerpt: 'EOD sync covering a new contract and Egypt-based salesperson sourcing, survey expert pay.' }), false);
  assert.equal(isRecruitingMeeting({ title: 'Client call', content_excerpt: 'Discussed the hiring market.' }), false, 'one word is not enough');
});

test("Schedule: Jamie's format, each interview only under whoever takes it (Interviewer when he is on it), both when two take it", () => {
  assert.equal(timeRange('2026-10-16T17:30:00Z', '2026-10-16T18:00:00Z'), '10:30–11:00 AM');
  assert.equal(timeRange('2026-10-16T18:50:00Z', '2026-10-16T19:20:00Z'), '11:50 AM–12:20 PM');
  const items = [
    { start: '2026-10-16T17:30:00Z', end: '2026-10-16T18:00:00Z', candidate: { fullName: 'Cameron Wells', linkedin: 'https://www.linkedin.com/in/sample-3bb8668bb7a3' }, meetUrl: 'https://meet.google.com/ark-bzgt-mnx', onCalendar: ['robin', 'interviewer'], takers: ['interviewer'], title: 'x' },
    { start: '2026-10-16T18:00:00Z', end: '2026-10-16T18:30:00Z', candidate: null, guestName: null, guestLinkedin: 'https://www.linkedin.com/in/sample-zoe', meetUrl: null, onCalendar: ['interviewer'], takers: ['interviewer'], title: 'Yu <> Company' },
    { start: '2026-10-17T00:10:00Z', end: '2026-10-17T00:40:00Z', candidate: { fullName: 'Emery Rowan Oj' }, meetUrl: 'https://meet.google.com/fwc', onCalendar: ['robin', 'interviewer'], takers: ['robin', 'interviewer'], title: 'x' },
    { start: '2026-10-16T20:30:00Z', end: '2026-10-16T21:00:00Z', candidate: { fullName: 'Only Robin' }, meetUrl: null, onCalendar: ['robin'], takers: ['interviewer'], title: 'x' },
  ];
  const text = scheduleMessage(items, 'Fri 10/16');
  assert.equal(text, [
    "🇺🇸 *Interviews — Fri 10/16 PT* · today's orders", '',
    `<@${PEOPLE.interviewer}>`,
    '• *10:30–11:00 AM* — <https://www.linkedin.com/in/sample-3bb8668bb7a3|Cameron Wells> — <https://meet.google.com/ark-bzgt-mnx|Meet>',
    '• *11:00–11:30 AM* — <https://www.linkedin.com/in/sample-zoe|Yu Company>',
    '• *1:30–2:00 PM* — Only Robin',
    `<@${PEOPLE.robin}> <@${PEOPLE.interviewer}>`,
    '• *5:10–5:40 PM* — Emery Rowan Oj — <https://meet.google.com/fwc|Meet>',
    "🫵 I want each of you: I'll come for your call 5 minutes after each one ends.",
  ].join('\n'));
  assert.equal(scheduleMessage([], 'Fri 10/16'), '🇺🇸 *Interviews — Fri 10/16 PT*\n\nNo interviews today. At ease. 🫡');
});

test('Schedule: 9:30 Pacific once a day in the channel; a weekend with nothing posts nothing; a failed post tells Project', async () => {
  const env = { UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled' };
  const one = [{ start: '2026-10-16T17:30:00Z', end: '2026-10-16T18:00:00Z', candidate: { fullName: 'Cameron Wells' }, onCalendar: ['interviewer'], takers: ['interviewer'], title: 'x' }];
  const runner = items => ({ asked: [], async previewInterviews(a) { this.asked.push(a); return items; } });
  const at = iso => () => Date.parse(iso);
  let db = d1(), posted = [], r = runner(one);
  assert.equal((await runInterviewSchedule({ env, db, runner: r, channelPoster: async t => posted.push(t), clock: at('2026-10-16T16:45:00Z') })).state, 'not_due'); // 9:45 PT
  assert.equal((await runInterviewSchedule({ env, db, runner: r, channelPoster: async t => posted.push(t), clock: at('2026-10-16T16:51:00Z') })).state, 'sent'); // 9:51 PT
  assert.equal((await runInterviewSchedule({ env, db, runner: r, channelPoster: async t => posted.push(t), clock: at('2026-10-16T16:56:00Z') })).state, 'sent_today');
  assert.equal(posted.length, 1);
  assert.match(posted[0], /^🇺🇸 \*Interviews — Fri 10\/16 PT\*/);
  assert.equal(r.asked[0].from, Date.parse('2026-10-16T07:00:00Z'), 'from Pacific midnight');
  db = d1(); posted = [];
  assert.equal((await runInterviewSchedule({ env, db, runner: runner([]), channelPoster: async t => posted.push(t), clock: at('2026-10-17T16:51:00Z') })).state, 'none_weekend');
  assert.equal(posted.length, 0);
  db = d1(); const told = [];
  const failing = async () => { const e = new Error('x'); e.code = 'slack_not_in_channel'; throw e; };
  assert.equal((await runInterviewSchedule({ env, db, runner: runner(one), channelPoster: failing, masonPoster: async t => told.push(t), clock: at('2026-10-16T16:51:00Z') })).error, 'slack_not_in_channel');
  assert.match(told[0], /couldn't post today's interview schedule/);
});

test("Evening: from 9:30pm Pacific, tomorrow's post to Project once, with what is unclear", async () => {
  const env = { UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled' }, db = d1(), told = [];
  const items = [{ start: '2026-10-16T17:30:00Z', end: '2026-10-16T18:00:00Z', candidate: { fullName: 'Cameron Wells' }, onCalendar: ['robin', 'interviewer'], takers: ['interviewer'], title: 'x' },
    { start: '2026-10-17T01:30:00Z', end: '2026-10-17T02:00:00Z', candidate: null, ambiguous: ['Reagan Turner', 'Reagan Turner (Mercor)'], guestName: 'Reagan Turner', onCalendar: ['interviewer'], takers: ['interviewer'], kind: 'Technical deep dive', title: 'Technical Deep Dive' }];
  const runner = { asked: [], async previewInterviews(a) { this.asked.push(a); return items; } };
  const at = iso => () => Date.parse(iso);
  assert.equal((await runScheduleEveningPreview({ env, db, runner, poster: async t => told.push(t), clock: at('2026-10-16T04:00:00Z') })).state, 'not_due'); // 9pm PT Oct 15
  assert.equal((await runScheduleEveningPreview({ env, db, runner, poster: async t => told.push(t), clock: at('2026-10-16T05:55:00Z') })).state, 'sent'); // 10:55pm PT
  assert.equal((await runScheduleEveningPreview({ env, db, runner, poster: async t => told.push(t), clock: at('2026-10-16T06:30:00Z') })).state, 'sent_today');
  assert.equal(told.length, 1);
  assert.equal(runner.asked[0].from, Date.parse('2026-10-16T07:00:00Z'), "tomorrow from Pacific midnight");
  assert.match(told[0], /^📋 Here's what I'll post in #int-recruitment at 9:50 AM tomorrow:\n\n🇺🇸 \*Interviews — Fri 10\/16 PT\*/);
  assert.match(told[0], /⚠️ more than one record named Reagan Turner/);
});

test('Post time: 9:50, or 15 minutes before an earlier first interview, recalculated as the calendar changes', async () => {
  const midnight = Date.parse('2026-10-16T07:00:00Z');
  assert.equal(postTime([{ start: '2026-10-16T17:30:00Z' }], midnight), Date.parse('2026-10-16T16:50:00Z'), '10:30 interview: 9:50');
  assert.equal(postTime([{ start: '2026-10-16T16:00:00Z' }, { start: '2026-10-16T17:30:00Z' }], midnight), Date.parse('2026-10-16T15:45:00Z'), '9:00 interview: 8:45');
  assert.equal(postTime([], midnight), Date.parse('2026-10-16T16:50:00Z'));
  // An 8:30 interview added in the morning moves the post up on the next run.
  const env = { UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled' }, db = d1(), posted = [];
  let items = [{ start: '2026-10-16T17:30:00Z', end: '2026-10-16T18:00:00Z', candidate: { fullName: 'A' }, onCalendar: ['interviewer'], takers: ['interviewer'], title: 'x' }];
  const runner = { async previewInterviews() { return items; } };
  const run = iso => runInterviewSchedule({ env, db, runner, channelPoster: async t => posted.push(t), clock: () => Date.parse(iso) });
  assert.equal((await run('2026-10-16T15:20:00Z')).state, 'not_due'); // 8:20 PT, first interview 10:30
  items = [{ start: '2026-10-16T15:30:00Z', end: '2026-10-16T16:00:00Z', candidate: { fullName: 'B' }, onCalendar: ['robin'], takers: ['robin'], title: 'x' }, ...items];
  assert.equal((await run('2026-10-16T15:16:00Z')).state, 'sent'); // 8:16 PT, an 8:30 interview appeared
  assert.equal(posted.length, 1);
});

test('Updates: the posted schedule is edited in place as soon as who-takes-what changes, and only then', async () => {
  const env = { UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled', SLACK_BOT_TOKEN: 'xoxb-fixture' }, db = d1();
  let items = [{ start: '2026-10-17T00:10:00Z', end: '2026-10-17T00:40:00Z', candidate: { fullName: 'Emery Rowan Oj' }, onCalendar: ['robin', 'interviewer'], takers: ['interviewer'], title: 'x' }];
  const runner = { async previewInterviews() { return items; } };
  const posted = [];
  const clock = () => Date.parse('2026-10-16T16:51:00Z');
  await runInterviewSchedule({ env, db, runner, channelId: 'C01D1A69CE3', channelPoster: async t => { posted.push(t); return '1792133460.000100'; }, clock });
  assert.equal(posted.length, 1);
  const updates = [];
  const fetchImpl = async (url, init) => { updates.push({ url, body: Object.fromEntries(new URLSearchParams(init.body)) }); return new Response(JSON.stringify({ ok: true, ts: '1792133460.000100' })); };
  assert.equal((await refreshSchedules({ env, db, runner, fetchImpl, clock })).edited, 0, 'nothing changed: no edit');
  items = [{ ...items[0], takers: ['robin', 'interviewer'] }]; // "Robin is also on the 5:10"
  assert.equal((await refreshSchedules({ env, db, runner, fetchImpl, clock })).edited, 1);
  assert.equal(updates[0].url, 'https://slack.com/api/chat.update');
  assert.equal(updates[0].body.channel, 'C01D1A69CE3');
  assert.equal(updates[0].body.ts, '1792133460.000100');
  assert.match(updates[0].body.text, new RegExp(`<@${PEOPLE.robin}> <@${PEOPLE.interviewer}>\\n• \\*5:10–5:40 PM\\* — Emery Rowan Oj[\\s\\S]*I want each of you`));
  assert.equal((await refreshSchedules({ env, db, runner, fetchImpl, clock })).edited, 0, 'edited once');
});

test('Updates: what reads like someone taking an interview', () => {
  for (const t of ['Robin is also on the 5:10', 'Interviewer is taking the 1:30', "I'll take the 11:00", 'both of us will do Cameron']) assert.equal(looksLikeAssignment(t), true, t);
  for (const t of ['thanks!', 'what time is it', 'Emery looked strong']) assert.equal(looksLikeAssignment(t), false, t);
});

test("Updates: plain replies count only under today's (or yesterday's) schedule post", async () => {
  const env = { UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled' }, db = d1();
  const runner = { async previewInterviews() { return [{ start: '2026-10-16T17:30:00Z', end: '2026-10-16T18:00:00Z', candidate: { fullName: 'A' }, onCalendar: ['interviewer'], takers: ['interviewer'], title: 'x' }]; } };
  const clock = () => Date.parse('2026-10-16T16:51:00Z');
  await runInterviewSchedule({ env, db, runner, channelId: 'C01D1A69CE3', channelPoster: async () => '1792133460.000100', clock });
  assert.equal(await isScheduleThread(db, { channelId: 'C01D1A69CE3', threadTs: '1792133460.000100' }, clock), true);
  assert.equal(await isScheduleThread(db, { channelId: 'C01D1A69CE3', threadTs: '1792133460.000999' }, clock), false);
  assert.equal(await isScheduleThread(db, { channelId: 'COTHER1', threadTs: '1792133460.000100' }, clock), false);
  assert.equal(await isScheduleThread(db, { channelId: 'C01D1A69CE3', threadTs: '1792133460.000100' }, () => Date.parse('2026-10-18T16:00:00Z')), false, 'two days later');
});

test('Schedule: one person listed reads "you", not "each of you"', () => {
  const text = scheduleMessage([{ start: '2026-10-16T17:30:00Z', end: '2026-10-16T18:00:00Z', candidate: { fullName: 'Cameron Wells' }, onCalendar: ['robin', 'interviewer'], takers: ['interviewer'], title: 'x' }], 'Fri 10/16');
  assert.match(text, /\n🫵 I want you: I'll come for your call 5 minutes after each one ends\.$/);
  assert.doesNotMatch(text, /each of you/);
});
