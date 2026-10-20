import test from 'node:test';
import assert from 'node:assert/strict';
import { createBookingAnswerer, eventMatches, whenText, mightAskBooking, bookingReply } from '../service/lib/booking-lookup.mjs';

const NOW = Date.parse('2026-10-16T17:26:00Z'); // Fri 10:26 AM PT
const CASEY = { id: 'jmho', iCalUID: 'jmho@example.test', calendarId: 'robin@company.example', summary: '30 Min call Robin (Casey Reed)', status: 'confirmed',
  start: '2026-10-19T13:50:00-07:00', end: '2026-10-19T14:20:00-07:00', allDay: false, created: '2026-10-16T17:15:41Z',
  attendees: [{ email: 'robin@company.example' }, { email: 'caseyjreed@example.test' }],
  description: 'Booked by\nCasey Reed\ncaseyjreed@example.test\nLinkedIn\nlinkedin.com/in/sample-84422f0bf3b2' };
const EMAILS = { 'robin@company.example': 'U0A4F08721B', 'project@company.example': 'U0F9EF97D89' };

test('Booking: matching a person to a calendar event, and the time in PT', () => {
  assert.ok(eventMatches(CASEY, 'Casey Reed'));
  assert.ok(eventMatches({ ...CASEY, summary: 'Intro', description: '' }, 'Casey Reed'), 'the guest address is enough');
  assert.ok(!eventMatches(CASEY, 'Casey Smith'));
  assert.equal(whenText(CASEY.start, CASEY.end), 'Mon Oct 19, 1:50–2:20 PM PT');
  assert.equal(whenText('2026-10-19T18:30:00Z', '2026-10-19T19:30:00Z'), 'Mon Oct 19, 11:30 AM–12:30 PM PT');
  assert.ok(mightAskBooking('when is this scheduled for'));
  assert.ok(mightAskBooking('<@U0C4899BFC9> answer the questions above'));
  assert.ok(!mightAskBooking('put Reagan on hold'));
  assert.ok(!mightAskBooking('the call with Yu went well, strong hire'), 'interview feedback is not a question');
  assert.ok(mightAskBooking("what's on Robin's calendar tomorrow"));
  assert.equal(bookingReply({ names: ['Casey Reed'], found: [{ name: 'Casey Reed', event: CASEY }], interviewerEmails: EMAILS, now: NOW }),
    '🗓️ Casey Reed is booked for a call with Robin: *Mon Oct 19, 1:50–2:20 PM PT* (booked today at 10:15 AM)');
  assert.match(bookingReply({ names: ['Jane Roe'], found: [], interviewerEmails: EMAILS, now: NOW }), /I don't see a booking for Jane Roe/);
});

function world({ messages, imageType = 'image/png', author = 'U0F9EF97D89', model = { kind: 'booking', names: ['Casey Reed'] }, events = [CASEY] } = {}) {
  const w = { calls: [], prompts: [], listed: [] };
  w.fetch = async (url, init = {}) => {
    if (url.startsWith('https://slack.com/api/')) {
      const method = url.slice('https://slack.com/api/'.length);
      w.calls.push({ method, args: Object.fromEntries(new URLSearchParams(init.body)) });
      return Response.json({ ok: true, messages });
    }
    if (url.startsWith('https://files.slack.com/')) { w.calls.push({ method: 'file', url, auth: init.headers?.authorization }); return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': imageType } }); }
    throw new Error(`unexpected ${url}`);
  };
  w.claude = { complete: async req => { w.prompts.push(req); return { content: [{ type: 'tool_use', name: 'calendar_question', input: model }] }; } };
  w.calendar = { listEvents: async args => { w.listed.push(args); return events; } };
  w.answer = createBookingAnswerer({ env: { SLACK_BOT_TOKEN: 'xoxb-fixture-only', SLACK_BOT_USER_ID: 'U0C4899BFC9' }, claude: w.claude, calendar: w.calendar,
    calendarIds: ['robin@company.example'], interviewerEmails: EMAILS, fetchImpl: w.fetch, clock: () => NOW });
  w.event = { channelId: 'D0C95KBR09J', messageTs: '1792171560.000100', threadTs: null, authorId: author, text: messages.at(-1)?.text ?? '' };
  return w;
}
const shot = { id: 'F1', mimetype: 'image/png', size: 200000, url_private: 'https://files.slack.com/files-pri/T1-F1/img_1882.png' };

test('Booking: Project\'s DM, a screenshot and "when is this scheduled for" — the name is read from the screenshot and the time found', async () => {
  const w = world({ messages: [{ ts: '1792171560.000100', user: 'U0F9EF97D89', text: 'when is this scheduled for <@U0C4899BFC9>', files: [shot] }] });
  const out = await w.answer(w.event);
  assert.equal(out.text, '🗓️ Casey Reed is booked for a call with Robin: *Mon Oct 19, 1:50–2:20 PM PT* (booked today at 10:15 AM)');
  assert.equal(w.calls[0].method, 'conversations.history');
  const file = w.calls.find(c => c.method === 'file');
  assert.equal(file.auth, 'Bearer xoxb-fixture-only');
  const content = w.prompts[0].messages[0].content;
  assert.equal(content[0].type, 'image', 'the screenshot goes to the model');
  assert.match(content.at(-1).text, /LATEST — Project: when is this scheduled for @Uncle Sam \[screenshot attached\]$/);
  assert.equal(w.listed[0].q, 'casey reed');
});

test('Booking: a tag in a thread reads the thread root (Alexis\'s screenshot); "answer the questions above" reads earlier messages', async () => {
  const thread = [{ ts: '1792171097.417249', user: 'U0476A5BC82', text: '<@U0F9EF97D89> when is this scheduled for', files: [shot] },
    { ts: '1792171600.000100', thread_ts: '1792171097.417249', user: 'U0F9EF97D89', text: '<@U0C4899BFC9> when is he scheduled for?' }];
  const w = world({ messages: thread });
  w.event = { ...w.event, channelId: 'C01D1A69CE3', messageTs: '1792171600.000100', threadTs: '1792171097.417249' };
  const out = await w.answer(w.event);
  assert.match(out.text, /Casey Reed is booked/);
  assert.equal(w.calls[0].method, 'conversations.replies');
  assert.equal(w.calls[0].args.ts, '1792171097.417249');
  assert.match(w.prompts[0].messages[0].content.at(-1).text, /\n\nAlexis: @Project when is this scheduled for \[screenshot attached\]\nLATEST — Project: @Uncle Sam when is he scheduled for\?$/);
  const bot = { ts: '1792171620.000100', bot_id: 'B1', text: 'Got it. Nothing for me to change' };
  const w2 = world({ messages: [{ ts: '1792171560.000100', user: 'U0F9EF97D89', text: 'when is this scheduled for', files: [shot] }, bot,
    { ts: '1792171650.000100', user: 'U0F9EF97D89', text: '<@U0C4899BFC9> answer the questions above' }] });
  w2.event.messageTs = '1792171650.000100';
  assert.match((await w2.answer(w2.event)).text, /Casey Reed is booked/);
  assert.doesNotMatch(w2.prompts[0].messages[0].content.at(-1).text, /Nothing for me/, 'Uncle Sam\'s own posts are left out');
});

test('Booking: a screenshot that cannot be opened and no name — says so and lists the day\'s new bookings', async () => {
  const w = world({ messages: [{ ts: '1792171560.000100', user: 'U0F9EF97D89', text: 'when is this scheduled for', files: [shot] }], imageType: 'text/html', model: { kind: 'booking', names: [] } });
  const out = await w.answer(w.event);
  assert.equal(w.prompts[0].messages[0].content.length, 1, 'no image went to the model');
  assert.equal(out.text, "🗓️ I can't open screenshots yet, so I couldn't tell who you mean. Bookings made in the last day:\n• Casey Reed is booked for a call with Robin: *Mon Oct 19, 1:50–2:20 PM PT* (booked today at 10:15 AM)");
});

test('Booking: not a booking question, or not a teammate — nothing (the usual lanes answer)', async () => {
  const w = world({ messages: [{ ts: '1792171560.000100', user: 'U0F9EF97D89', text: 'when do we reject Reagan?' }], model: { kind: 'none' } });
  assert.equal(await w.answer(w.event), null);
  assert.equal(w.listed.length, 0);
  const outsider = world({ messages: [{ ts: '1792171560.000100', user: 'U0XXXXXXX', text: 'when is Casey scheduled' }], author: 'U0XXXXXXX' }); // in a DM, not #int-recruitment
  assert.equal(await outsider.answer(outsider.event), null);
  assert.equal(outsider.calls.length + outsider.prompts.length, 0);
  const teammate = world({ messages: [{ ts: '1792171560.000100', user: 'U0F9EF97D89', text: 'when is Robin scheduled' }], model: { kind: 'booking', names: ['Robin'] } });
  assert.match((await teammate.answer(teammate.event)).text, /couldn't tell who you mean/, 'a teammate is never the person looked up');
});

import { checkReading, scheduleReply, calendarOf, ptStart, dayLabel } from '../service/lib/booking-lookup.mjs';

test('Calendar: dates are checked and a range is at most 14 days; "me" is the asker; calendars are found by address', () => {
  assert.equal(ptStart('2026-10-16'), Date.parse('2026-10-16T07:00:00Z'));
  assert.equal(ptStart('2026-11-02'), Date.parse('2026-11-02T08:00:00Z'), 'after daylight saving ends');
  assert.equal(dayLabel('2026-10-22'), 'Thu Oct 22');
  const r = checkReading({ kind: 'schedule', people: ['me', 'Robin'], from: '2026-10-20', to: '2026-12-30' }, { today: '2026-10-16', asker: 'Alexis' });
  assert.deepEqual([r.people, r.from, r.to, r.truncated], [['Alexis', 'Robin'], '2026-10-20', '2026-11-02', true]);
  assert.deepEqual(checkReading({ kind: 'schedule' }, { today: '2026-10-16', asker: 'Robin' }), { kind: 'schedule', names: [], people: [], bookingsOnly: false, from: '2026-10-16', to: '2026-10-16', truncated: false });
  assert.equal(checkReading({ kind: 'nonsense' }, { today: '2026-10-16', asker: null }), null);
  assert.equal(calendarOf('Interviewer', ['robin@company.example', 'quinn@company.example'], {}), 'quinn@company.example');
  assert.equal(calendarOf('Robin', ['r@company.example'], { 'r@company.example': 'U0A4F08721B' }), 'r@company.example');
  assert.equal(calendarOf('Jamie', ['robin@company.example'], {}), null);
});

const ev = (id, start, end, summary, attendees = [], extra = {}) => ({ id, iCalUID: `${id}@g`, calendarId: 'robin@company.example', summary, status: 'confirmed', start, end, allDay: false, attendees, description: '', ...extra });
const DAY = [
  ev('a', '2026-10-22T16:00:00Z', '2026-10-22T16:30:00Z', 'Standup', [{ email: 'robin@company.example', self: true, responseStatus: 'accepted' }]),
  ev('b', '2026-10-22T20:50:00Z', '2026-10-22T21:20:00Z', '30 Min call Robin (Casey Reed)', [{ email: 'robin@company.example', self: true }, { email: 'caseyjreed@example.test' }], { description: 'Booked by\nCasey Reed' }),
  ev('c', '2026-10-22T22:00:00Z', '2026-10-22T23:00:00Z', 'Declined sync', [{ email: 'robin@company.example', self: true, responseStatus: 'declined' }]),
  ev('d', '2026-10-23T17:00:00Z', '2026-10-23T17:30:00Z', 'Interview (Yu Zhao)', [{ email: 'robin@company.example', self: true }, { email: 'yu@example.com' }]),
];

test('Calendar: "what\'s on Robin\'s calendar Thursday" in #int-recruitment, from anyone there; "who\'s booked this week" across the team', async () => {
  const w = world({ messages: [{ ts: '1792171600.000100', user: 'U0SOMEONE1', text: "<@U0C4899BFC9> what's on Robin's calendar Thursday?" }], author: 'U0SOMEONE1',
    model: { kind: 'schedule', people: ['Robin'], from: '2026-10-22', to: '2026-10-22' }, events: DAY });
  w.event = { ...w.event, channelId: 'C01D1A69CE3', threadTs: null };
  const out = await w.answer(w.event);
  assert.equal(out.text, "🗓️ *Robin's calendar · Thu Oct 22*\n• 9:00–9:30 AM — Standup\n• 1:50–2:20 PM — 30 Min call Robin (Casey Reed)");
  assert.equal(w.listed[0].calendarId, 'robin@company.example');
  assert.equal(w.listed[0].timeMin, Date.parse('2026-10-22T07:00:00Z'));
  assert.match(w.prompts[0].messages[0].content[0].text, /^Asked by: a colleague\. Dates \(Pacific\): Friday 2026-10-16 \(today\), Saturday 2026-10-17/);
  const team = world({ messages: [{ ts: '1792171600.000100', user: 'U0F9EF97D89', text: "who's booked this week?" }],
    model: { kind: 'schedule', people: [], bookings_only: true, from: '2026-10-19', to: '2026-10-25' }, events: DAY });
  assert.equal((await team.answer(team.event)).text,
    '🗓️ *Booked · Mon Oct 19 – Sun Oct 25*\n*Thu Oct 22*\n• 1:50–2:20 PM — Casey Reed, with Robin\n*Fri Oct 23*\n• 10:00–10:30 AM — Yu Zhao, with Robin');
});

test('Calendar: "what do I have tomorrow" in Robin\'s own DM; a calendar Uncle Sam cannot see is said plainly', async () => {
  const w = world({ messages: [{ ts: '1792171600.000100', user: 'U0A4F08721B', text: 'what do I have tomorrow?' }], author: 'U0A4F08721B',
    model: { kind: 'schedule', people: ['me'], from: '2026-10-17', to: '2026-10-17' }, events: [] });
  assert.equal((await w.answer(w.event)).text, "🗓️ *Robin's calendar · Sat Oct 17*\nNothing on the calendar.");
  const j = world({ messages: [{ ts: '1792171600.000100', user: 'U0CB213D6D6', text: "what's on my calendar today?" }], author: 'U0CB213D6D6',
    model: { kind: 'schedule', people: ['me'] } });
  assert.equal((await j.answer(j.event)).text, "🗓️ I can't see Jamie's calendar. I can read Robin.");
  assert.equal(j.listed.length, 0);
});

test('Calendar: an outsider\'s DM gets nothing; a long list is cut with a note', () => {
  const many = Array.from({ length: 45 }, (_, i) => ev(`e${i}`, `2026-10-22T${String(10 + Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}:00Z`, null, `Thing ${i}`));
  const text = scheduleReply({ who: 'Robin', from: '2026-10-22', to: '2026-10-22', days: [{ date: '2026-10-22', events: many }], bookingsOnly: false });
  assert.equal(text.split('\n').filter(l => l.startsWith('• ')).length, 40);
  assert.match(text, /_Showing the first 40; ask for a shorter range for the rest\._$/);
});
