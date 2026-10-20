import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { prepareMeetLink, completeMeetConnection, isMeetState, createMeetReader, meetSummary, meetingCodeOf, runMeetConnect, meetPeopleOf, MEET_SCOPE } from '../service/lib/meet.mjs';
import { evaluateInterviewFeedback } from '../service/lib/workflow-policy.mjs';

const KEY = Buffer.alloc(32, 7).toString('base64');
const ENV = { WISPR_TOKEN_KEY: KEY, GMAIL_OAUTH_CLIENT_ID: '123456789-abcdef.apps.googleusercontent.com', GMAIL_OAUTH_CLIENT_SECRET: 'fixture-secret-0123', UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled' };
const NOW = Date.parse('2026-10-16T18:00:00Z');
function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_wispr (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const idToken = claims => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
const tokenReply = (claims, scope = `openid email ${MEET_SCOPE}`) => async () => Response.json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope, id_token: idToken(claims) });

async function connect(db, email = 'quinn@company.example', sub = '111') {
  const link = await prepareMeetLink({ env: ENV, db, email, clock: () => NOW });
  const state = new URL(link.url).searchParams.get('state');
  await completeMeetConnection({ env: ENV, db, clock: () => NOW, code: 'c', state, fetchImpl: tokenReply({ email, email_verified: true, aud: ENV.GMAIL_OAUTH_CLIENT_ID, sub }) });
}

test('Meet link: read-only Meet scope, for that person only, one use; the callback knows it from the Gmail one', async () => {
  const db = d1();
  const link = await prepareMeetLink({ env: ENV, db, email: 'quinn@company.example', clock: () => NOW });
  const url = new URL(link.url);
  assert.equal(link.status, 'link');
  assert.equal(url.searchParams.get('scope'), `openid email ${MEET_SCOPE}`);
  assert.equal(url.searchParams.get('login_hint'), 'quinn@company.example');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://your-project.example.com/api/google/callback');
  const state = url.searchParams.get('state');
  assert.equal(await isMeetState({ db, state }), true);
  assert.equal(await isMeetState({ db, state: 'gmail-state' }), false);
  assert.equal((await prepareMeetLink({ env: ENV, db, email: 'quinn@company.example', clock: () => NOW + 1000 })).status, 'pending', 'the same link, not a new one');
  await assert.rejects(completeMeetConnection({ env: ENV, db, clock: () => NOW, code: 'c', state,
    fetchImpl: tokenReply({ email: 'robin@company.example', email_verified: true, aud: ENV.GMAIL_OAUTH_CLIENT_ID, sub: '2' }) }), /meet_wrong_account/);
  await assert.rejects(completeMeetConnection({ env: ENV, db, clock: () => NOW, code: 'c', state, fetchImpl: tokenReply({}) }), /meet_link_invalid/, 'one use');
  await connect(db);
  assert.equal((await prepareMeetLink({ env: ENV, db, email: 'quinn@company.example', clock: () => NOW })).status, 'connected');
  await assert.rejects(prepareMeetLink({ env: ENV, db, email: 'someone@example.test', clock: () => NOW }), /meet_email_invalid/);
});

test('Meet record: the call in the slot, who joined (own grant, directory, exact shown name) and when they left', async () => {
  const db = d1(); await connect(db);
  const calls = [];
  const fetchImpl = async url => {
    calls.push(String(url));
    if (String(url).includes('listDirectoryPeople')) return Response.json({ people: [{ resourceName: 'people/222', emailAddresses: [{ value: 'robin@company.example' }] }] });
    if (String(url).includes('/participants')) return Response.json({ participants: [
      { signedinUser: { user: 'users/111', displayName: 'J Quinn Foster' }, earliestStartTime: '2026-10-16T17:30:00Z', latestEndTime: '2026-10-16T17:52:00Z' },
      { signedinUser: { user: 'users/222', displayName: 'Robin K' }, earliestStartTime: '2026-10-16T17:31:00Z' },
      { anonymousUser: { displayName: 'Jane Guest' }, earliestStartTime: '2026-10-16T17:30:30Z', latestEndTime: '2026-10-16T17:53:00Z' }] });
    return Response.json({ conferenceRecords: [{ name: 'conferenceRecords/abc', startTime: '2026-10-16T17:30:00Z' }] });
  };
  const reader = createMeetReader({ env: ENV, db, fetchImpl, clock: () => NOW, directoryToken: async () => 'project-token' });
  const event = { start: '2026-10-16T17:30:00Z', end: '2026-10-16T18:00:00Z', organizer: 'quinn@company.example', attendees: [{ email: 'robin@company.example' }],
    meetUrl: 'https://meet.google.com/abc-defg-hij?authuser=0' };
  assert.equal(await reader.canRead(event), true);
  assert.equal(await reader.canRead({ ...event, organizer: 'alexis@company.example', attendees: [] }), false, 'nobody on it has a grant');
  const read = await reader.read(event);
  assert.equal(read.found, true);
  assert.deepEqual(read.people.map(p => [p.email, p.left]), [['quinn@company.example', Date.parse('2026-10-16T17:52:00Z')], ['robin@company.example', null], [null, Date.parse('2026-10-16T17:53:00Z')]]);
  assert.match(decodeURIComponent(calls.find(c => c.includes('conferenceRecords?'))), /space\.meeting_code = "abc-defg-hij" AND start_time >= "2026-10-16T17:00:00\.000Z"/);
  const ids = { 'quinn@company.example': 'S', 'robin@company.example': 'R' };
  const strip = ({ interviewerMs: _ms, ...rest }) => rest;
  assert.deepEqual(strip(meetSummary(read, ids)), { joined: ['S', 'R'], live: true, endedAt: null, guestJoined: true, noInterviewer: false, callEnded: false });
  read.people[1].left = Date.parse('2026-10-16T17:55:00Z');
  assert.deepEqual(strip(meetSummary(read, ids)), { joined: ['S', 'R'], live: false, endedAt: Date.parse('2026-10-16T17:55:00Z'), guestJoined: true, noInterviewer: false, callEnded: false });
  assert.equal(meetSummary({ found: true, ended: NOW, people: [{ email: 'quinn@company.example', left: NOW - 1000 }] }, ids).guestJoined, false);
  assert.equal(meetSummary({ found: false }), null);
  assert.equal(meetingCodeOf('https://meet.google.com/xyz-abcd-efg'), 'xyz-abcd-efg');
  assert.equal(meetingCodeOf('https://zoom.us/j/1'), null);
});

test('Meet record: Google saying no means no record, never an error that stops the follow-up', async () => {
  const db = d1(); await connect(db);
  const reader = createMeetReader({ env: ENV, db, fetchImpl: async () => new Response('{}', { status: 403 }), clock: () => NOW });
  assert.deepEqual(await reader.read({ start: '2026-10-16T17:30:00Z', end: '2026-10-16T18:00:00Z', organizer: 'quinn@company.example', meetUrl: 'https://meet.google.com/abc-defg-hij' }),
    { found: false, reason: 'no_record' });
});

test('Meet links go to Project once each; one line when someone connects', async () => {
  const db = d1(); const said = [];
  const people = meetPeopleOf({}, { 'quinn@company.example': 'U030A09DBFF' }, { interviewer: 'U030A09DBFF' });
  assert.deepEqual(people, [{ key: 'interviewer', name: 'Interviewer', email: 'quinn@company.example' }]);
  await runMeetConnect({ env: ENV, db, poster: async t => said.push(t), people, clock: () => NOW });
  await runMeetConnect({ env: ENV, db, poster: async t => said.push(t), people, clock: () => NOW + 60_000 });
  assert.equal(said.length, 1);
  assert.match(said[0], /^🔗 Google Meet link for Interviewer: have Interviewer open it signed in as quinn@company\.example and tap Allow\. Read-only/);
  assert.ok(!said[0].includes('!'));
  await connect(db);
  await runMeetConnect({ env: ENV, db, poster: async t => said.push(t), people, clock: () => NOW + 120_000 });
  await runMeetConnect({ env: ENV, db, poster: async t => said.push(t), people, clock: () => NOW + 180_000 });
  assert.equal(said.length, 2);
  assert.match(said[1], /^🫡 Interviewer's Google Meet is connected\./);
  assert.deepEqual(meetPeopleOf({ UNCLE_SAM_MEET_PEOPLE: 'interviewer, robin, nobody' }).map(p => p.key), ['interviewer', 'robin']);
});

test('policy: a Meet end moves the question to 30 seconds after the last interviewer left, and its receipt still checks out', () => {
  const candidate = { pageId: '11111111-2222-3333-4444-555555555555', fullName: 'Jane Guest', email: 'jane@example.com', emailVerified: true };
  const scope = { occurrenceId: 'cal:x', candidatePageId: candidate.pageId, candidateEmail: candidate.email, verified: true, current: true, sourceUrl: 'https://example.com/source' };
  const schedule = { ...scope, sourceUrl: 'https://example.com/source', interviewerId: 'U030A09DBFF', status: 'confirmed', scheduledEnd: '2026-10-16T18:00:00Z', meetEndedAt: '2026-10-16T17:50:00Z' };
  const base = { candidate, occurrenceId: 'cal:x', schedule, latestStateVerified: true, feedbackChecked: true,
    route: { verified: true, kind: 'im', conversationId: 'DTEST123', recipientIds: ['U030A09DBFF'] } };
  assert.equal(evaluateInterviewFeedback({ ...base, now: '2026-10-16T17:50:29Z' }).reason, 'feedback_prompt_not_due');
  const due = evaluateInterviewFeedback({ ...base, now: '2026-10-16T17:50:30Z' });
  assert.equal(due.action, 'prompt_interviewer', JSON.stringify(due));
  const receipt = { ...scope, state: 'sent', requestKey: due.promptKey, scheduleKey: due.scheduleKey, sentAt: '2026-10-16T17:51:30Z' };
  const later = { ...base, schedule: { ...schedule, meetEndedAt: undefined }, now: '2026-10-17T18:00:00Z' };
  assert.equal(evaluateInterviewFeedback({ ...later, promptReceipt: receipt }).reason, 'feedback_prompt_receipt_timing_invalid', 'without the Meet end it looks too early');
  assert.notEqual(evaluateInterviewFeedback({ ...later, promptReceipt: { ...receipt, meetEndedAt: '2026-10-16T17:50:00Z' } }).reason, 'feedback_prompt_receipt_timing_invalid');
  assert.equal(evaluateInterviewFeedback({ ...base, schedule: { ...schedule, meetEndedAt: '2026-10-15T10:00:00Z' }, now: '2026-10-16T17:51:00Z' }).reason, 'feedback_prompt_not_due', 'a Meet end far from the slot is not this interview');
});

test('Meet summary edge cases: a pop-in is not a taker, nobody from Company, a rejoined call counts once', async () => {
  const ids = { 'quinn@company.example': 'S', 'robin@company.example': 'R' };
  const min = 60_000;
  // Robin popped in for two minutes of a 30-minute call: Interviewer took it alone, and the time is when Interviewer left.
  const popIn = { found: true, ended: NOW, people: [
    { email: 'quinn@company.example', present: 30 * min, left: NOW - 1000 }, { email: 'robin@company.example', present: 2 * min, left: NOW - 20 * min },
    { email: null, present: 30 * min, left: NOW }] };
  assert.deepEqual(meetSummary(popIn, ids).joined, ['S']);
  assert.equal(meetSummary(popIn, ids).endedAt, NOW - 1000);
  // Only the candidate turned up and left.
  const alone = { found: true, ended: NOW, people: [{ email: null, present: 10 * min, left: NOW }] };
  assert.equal(meetSummary(alone, ids).noInterviewer, true);
  assert.equal(meetSummary(alone, ids).endedAt, null);
  // A short call (6 minutes): half of it counts.
  const short = { found: true, ended: NOW, people: [{ email: 'quinn@company.example', present: 6 * min, left: NOW }, { email: 'robin@company.example', present: 3 * min, left: NOW - min }, { email: null, present: 6 * min, left: NOW }] };
  assert.deepEqual(meetSummary(short, ids).joined, ['S', 'R']);

  // Two calls in the slot (everyone dropped and rejoined): one person each, times added up, still on in the second call.
  const db = d1(); await connect(db);
  const fetchImpl = async url => {
    const u = String(url);
    if (u.includes('conferenceRecords/one/participants')) return Response.json({ participants: [
      { signedinUser: { user: 'users/111', displayName: 'J Quinn Foster' }, earliestStartTime: '2026-10-16T17:30:00Z', latestEndTime: '2026-10-16T17:40:00Z' }] });
    if (u.includes('conferenceRecords/two/participants')) return Response.json({ participants: [
      { signedinUser: { user: 'users/111', displayName: 'J Quinn Foster' }, earliestStartTime: '2026-10-16T17:42:00Z' }] });
    if (u.includes('listDirectoryPeople')) return Response.json({});
    return Response.json({ conferenceRecords: [{ name: 'conferenceRecords/two', startTime: '2026-10-16T17:42:00Z' },
      { name: 'conferenceRecords/one', startTime: '2026-10-16T17:30:00Z', endTime: '2026-10-16T17:40:00Z' }] });
  };
  const reader = createMeetReader({ env: ENV, db, fetchImpl, clock: () => NOW });
  const read = await reader.read({ start: '2026-10-16T17:30:00Z', end: '2026-10-16T18:00:00Z', organizer: 'quinn@company.example', meetUrl: 'https://meet.google.com/abc-defg-hij' });
  assert.equal(read.calls, 2); assert.equal(read.people.length, 1);
  assert.equal(read.people[0].left, null); assert.equal(read.people[0].present, 28 * min);
  assert.equal(meetSummary(read, ids).live, true);
});
