import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { noticeStore } from '../service/lib/stuck-rejections.mjs';
import { checkFirstMeeting, runFirstCheckinConfirmations, reviseFirstCheckin, confirmationKey } from '../service/lib/first-checkin-confirmation.mjs';
import { firstLockKey, establishFirstLock } from '../service/lib/first-checkin-lock.mjs';
import { runCheckinGuard, createCheckins, handleCheckinReply, PEOPLE } from '../service/lib/checkins.mjs';
import { cancelWaiting, HOLD_MS } from '../service/lib/email-queue.mjs';

function database() {
  const sql = new DatabaseSync(':memory:');
  sql.exec('CREATE TABLE uncle_sam_notices(name TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL)');
  return { prepare: s => ({ bind: (...a) => ({ first: async () => sql.prepare(s).get(...a) ?? null,
    run: async () => sql.prepare(s).run(...a), all: async () => ({ results: sql.prepare(s).all(...a) }) }) }) };
}
async function setup({ first = '2026-10-24T04:00:00Z', now = '2026-10-23T06:30:00Z' } = {}) {
  let current = Date.parse(now);
  const db = database(), kv = noticeStore(db), at = Date.parse(first), clock = () => current;
  const start = first.slice(0, 10), end = start;
  const lock = { pageId: 'p', name: 'Example Candidate', seriesId: 'morning', kind: 'morning', at, originalAt: at,
    end: at + 900_000, tz: 'Asia/Kolkata', start, trialEnd: end, emailEligible: true };
  const event = { id: 'first-occurrence', recurringEventId: 'morning', originalStart: first,
    start: first, end: new Date(at + 900_000).toISOString(), status: 'confirmed', meetUrl: 'https://meet.google.com/abc-defg-hij',
    summary: 'Example / Company: Morning Check-in', attendees: [...Object.values(PEOPLE), 'example@company.example'].map(email => ({ email })) };
  const reg = { pageId: 'p', first: 'Example', name: 'Example Candidate', start, end, tz: lock.tz,
    series: [{ eventId: 'morning', kind: 'morning', target: '09:30' }] };
  const candidate = { pageId: 'p', email: 'example@example.com', fullName: 'Example Candidate',
    fields: { Pipeline: 'India', Stage: 'Work Trial', Outcome: 'Not Yet Decided', 'Trial Start': start, 'Trial End': end } };
  const writes = [], sends = [], notices = [], events = [event], team = {};
  const calendar = { listEvents: async ({ calendarId }) => calendarId === 'project@company.example' ? events : team[calendarId] ?? [],
    writeEvent: async w => { writes.push(w); return { id: w.eventId ?? `created-${writes.length}` }; } };
  const notion = { readControl: async () => ({ mode: 'Live' }), getCandidate: async () => candidate };
  const gmail = { connected: async () => true, searchSent: async () => [],
    send: async m => { sends.push(m); return { id: 'sent-1', url: 'https://mail.google.com/sent-1' }; } };
  await kv.put(firstLockKey('p'), lock, clock());
  await kv.put('checkins:p', reg, clock());
  await kv.put('onboarding:p', { address: 'example@company.example' }, clock());
  await kv.put(confirmationKey(lock), { state: 'queued', name: candidate.fullName, pageId: 'p', at: clock() }, clock());
  const params = { lock, reg, candidate, workEmail: 'example@company.example', calendar, now: clock() };
  const run = () => runFirstCheckinConfirmations({ env: { UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled' }, db, notion, calendar,
    gmail, clock, poster: async t => notices.push(t) });
  return { db, kv, lock, reg, event, events, candidate, calendar, notion, gmail, writes, sends, notices, team, params, run, clock,
    advance: ms => { current += ms; } };
}

test('Saturday first check-in: exact invite readback, both time zones, correct account, and one email only', async () => {
  const f = await setup();
  assert.equal((await f.run()).sent, 1);
  assert.equal(f.sends[0].to, f.candidate.email);
  assert.match(f.sends[0].body, /Saturday, October 24, 2026 at 9:30 AM/);
  assert.match(f.sends[0].body, /Friday, October 23, 2026 at 9:00 PM PDT/);
  assert.match(f.sends[0].body, /example@company.example/);
  assert.match(f.sends[0].body, /This first check-in time is fixed/);
  assert.equal((await f.run()).sent, 0);
  assert.equal(f.writes.length, 0);
});
test('weekend confirmation is allowed in waking hours, rather than deferred to Monday', async () => {
  const f = await setup({ first: '2026-10-25T04:00:00Z', now: '2026-10-24T06:30:00Z' });
  assert.equal((await f.run()).sent, 1);
});
test('Pacific daylight saving conversion follows the actual occurrence', async () => {
  const f = await setup({ first: '2026-11-02T04:00:00Z', now: '2026-11-01T06:30:00Z' });
  assert.equal((await f.run()).sent, 1);
  assert.match(f.sends[0].body, /8:00 PM PST/);
});
for (const [name, change, code] of [
  ['date change', f => { f.candidate.fields['Trial Start'] = '2026-10-25'; }, 'trial_dates_changed'],
  ['candidate hold', f => { f.candidate.fields.Outcome = 'On Hold'; }, 'candidate_not_active'],
  ['unverified work email', f => { f.params.workEmail = 'other@example.com'; }, 'work_email_unverified'],
  ['missing Meet link', f => { delete f.event.meetUrl; }, 'first_meet_link_missing'],
  ['missing candidate invite', f => { f.event.attendees.pop(); }, 'first_guests_not_ready'],
  ['declined interviewer', f => { f.event.attendees[0].responseStatus = 'declined'; }, 'first_guests_not_ready'],
  ['declined candidate', f => { f.event.attendees.at(-1).responseStatus = 'declined'; }, 'first_guests_not_ready'],
  ['moved calendar instance', f => { f.event.start = '2026-10-24T02:40:00Z'; }, 'first_invite_changed'],
  ['cancelled invite', f => { f.event.status = 'cancelled'; }, 'first_invite_missing_or_ambiguous'],
  ['less than twelve hours notice', f => { f.params.now = f.lock.at - 11 * 3600_000; }, 'first_notice_too_short'],
  ['required interviewer clash', f => { f.team[PEOPLE.robin] = [{ id: 'conflict', start: f.event.start, end: f.event.end }]; }, 'first_team_conflict'],
]) test(`first confirmation blocks ${name}`, async () => {
  const f = await setup(); change(f);
  await assert.rejects(checkFirstMeeting(f.params), e => e.code === code);
});
test('unreadable or truncated calendars never produce a first-time promise', async () => {
  for (const mode of ['throw', 'truncated']) {
    const f = await setup();
    f.calendar.listEvents = async () => { if (mode === 'throw') throw Error('offline'); return Array(1000).fill(f.event); };
    assert.equal((await f.run()).sent, 0);
    assert.equal(f.sends.length, 0);
  }
});
test('date or invitation changes during mailbox verification are caught before sending', async () => {
  const f = await setup();
  f.gmail.searchSent = async () => { f.event.start = '2026-10-24T02:40:00Z'; return []; };
  assert.equal((await f.run()).sent, 0);
  assert.equal(f.sends.length, 0);
});
test('existing human confirmation is held for reconciliation, never duplicated', async () => {
  const f = await setup();
  f.gmail.searchSent = async q => { assert.match(q, /after:2026\/09\/24/); return [{ id: 'manual' }]; };
  await f.run(); await f.run();
  assert.equal(f.sends.length, 0);
  assert.equal(f.notices.length, 1);
});
test('uncertain email stays locked and is never blindly retried; definite pre-send failure can retry', async () => {
  for (const uncertain of [true, false]) {
    const f = await setup(); let calls = 0;
    f.gmail.send = async () => { calls++; if (calls === 1) throw Object.assign(Error('failed'), { uncertain }); return { id: 'ok' }; };
    await f.run(); await f.run();
    assert.equal(calls, uncertain ? 1 : 2);
    assert.ok(await f.kv.get(firstLockKey('p')));
  }
});
test('Friday night setup cannot silently defer notice until after Saturday morning check-in', async () => {
  const f = await setup({ now: '2026-10-23T17:30:00Z' }); // 11 PM Friday India
  await f.run();
  assert.equal(f.sends.length, 0);
  assert.match(f.notices[0], /fewer than 12 hours/);
});
test('first invitation cannot be optimized or moved for a conflict, but a later occurrence can', async () => {
  const f = await setup();
  f.reg.end = '2026-10-25'; await f.kv.put('checkins:p', f.reg, f.clock());
  f.events.push({ ...f.event, id: 'later-occurrence', originalStart: '2026-10-25T04:00:00Z',
    start: '2026-10-25T04:00:00Z', end: '2026-10-25T04:15:00Z' });
  f.team[PEOPLE.robin] = f.events.map((e, i) => ({ id: `conflict-${i}`, start: e.start, end: e.end, summary: 'Important meeting' }));
  const out = await runCheckinGuard({ db: f.db, calendar: f.calendar, notion: f.notion, clock: f.clock, force: true,
    poster: async t => f.notices.push(t) });
  assert.ok(!f.writes.some(w => w.eventId === 'first-occurrence' && w.body.start));
  assert.ok(f.writes.some(w => w.eventId === 'later-occurrence' && w.body.start));
  assert.equal(out.firstHeld, 1);
  assert.match(f.notices[0], /time is locked/);
});
test('a late registration records the first actually-created event, never a skipped past target', async () => {
  const db = database(), kv = noticeStore(db), writes = [];
  const now = Date.parse('2026-10-24T07:00:00Z'); // Saturday lunchtime India, morning has ended
  await createCheckins({ db, calendar: { writeEvent: async w => { writes.push(w); return { id: `s${writes.length}` }; } },
    who: { pageId: 'late', fullName: 'Late Candidate', workEmail: 'late@company.example' },
    start: '2026-10-24', end: '2026-10-25', clock: () => now });
  const earliest = Math.min(...writes.map(w => Date.parse(w.body.start.dateTime)));
  assert.equal((await kv.get(firstLockKey('late'))).at, earliest);
  assert.equal((await kv.get('checkins:late')).firstAt, earliest);
  assert.ok(earliest > now);
});
test('legacy first occurrence is found historically and is not automatically re-emailed', async () => {
  const f = await setup();
  await f.kv.del(firstLockKey('p'));
  const lock = await establishFirstLock({ kv: f.kv, reg: f.reg, candidate: f.candidate, calendar: f.calendar, now: f.lock.at + 86400_000 });
  assert.equal(lock.at, f.lock.at);
  assert.equal(lock.emailEligible, false);
  await f.run();
  assert.equal(f.sends.length, 0);
});

function revisionArgs(f) {
  f.calendar.writeEvent = async w => {
    f.writes.push(w); f.event.start = w.body.start.dateTime; f.event.end = w.body.end.dateTime; return { id: w.eventId };
  };
  return { db: f.db, calendar: f.calendar, notion: f.notion, gmail: f.gmail, pageId: 'p',
    eventId: f.event.id, to: f.lock.at - 20 * 60_000, quote: 'make it 8:40 pm PT', clock: f.clock };
}
test('an explicitly requested change adapts the invitation and sends one clear replacement confirmation', async () => {
  const f = await setup(); await f.run();
  const args = revisionArgs(f);
  assert.equal((await reviseFirstCheckin(args)).changed, true);
  assert.equal(f.writes[0].sendUpdates, 'all');
  assert.equal((await f.run()).sent, 0);
  f.advance(HOLD_MS);
  assert.equal((await f.run()).sent, 1);
  assert.match(f.sends[1].subject, /^Updated:/);
  assert.match(f.sends[1].body, /changed from Saturday, October 24, 2026 at 9:30 AM/);
  assert.match(f.sends[1].body, /confirmed for Saturday, October 24, 2026 at 9:10 AM/);
  await f.run(); assert.equal(f.sends.length, 2);
});
test('a requested change is blocked before mutation if new time clashes or gives too little notice', async () => {
  for (const reason of ['conflict', 'notice']) {
    const f = await setup(), args = revisionArgs(f);
    if (reason === 'conflict') f.team[PEOPLE.robin] = [{ id: 'busy', start: new Date(args.to).toISOString(), end: f.event.end }];
    else args.clock = () => args.to - 2 * 3600_000;
    await assert.rejects(reviseFirstCheckin(args));
    assert.equal(f.writes.length, 0);
    assert.deepEqual(await f.kv.get(firstLockKey('p')), f.lock);
  }
});
test('uncertain original confirmation blocks a competing reschedule', async () => {
  const f = await setup(), args = revisionArgs(f);
  await f.kv.put(confirmationKey(f.lock), { state: 'uncertain' }, f.clock());
  await assert.rejects(reviseFirstCheckin(args), e => e.code === 'previous_confirmation_unresolved');
  assert.equal(f.writes.length, 0);
});
test('two simultaneous explicit revisions cannot both write the invite', async () => {
  const f = await setup(), args = revisionArgs(f);
  const results = await Promise.allSettled([reviseFirstCheckin(args), reviseFirstCheckin({ ...args, to: args.to - 600_000 })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.writes.length, 1);
});
test('unverified calendar update cannot produce a revised confirmation', async () => {
  const f = await setup(), args = revisionArgs(f);
  f.calendar.writeEvent = async () => { throw Error('timeout'); };
  await assert.rejects(reviseFirstCheckin(args));
  assert.equal((await f.run()).sent, 0);
  assert.equal(f.sends.length, 0);
});
test('authenticated Project reply can request a verified first-time revision; other authors cannot', async () => {
  const f = await setup(); revisionArgs(f);
  await f.kv.put('checkins:askts:123', { key: 'checkins:p', instId: f.event.id, start: f.lock.at, end: f.lock.end }, f.clock());
  const params = { db: f.db, calendar: f.calendar, notion: f.notion, gmail: f.gmail, masonId: 'project',
    poster: () => async t => f.notices.push(t), clock: f.clock,
    event: { authorId: 'other', threadTs: '123', messageTs: '124', text: 'make it 8:40 pm PT' } };
  assert.equal(await handleCheckinReply(params), null);
  assert.equal(f.writes.length, 0);
  params.event.authorId = 'project';
  assert.equal((await handleCheckinReply(params)).kind, 'checkin_moved');
  assert.match(f.notices[0], /queued/);
});
test('concurrent confirmation workers send only once', async () => {
  const f = await setup();
  await Promise.all([f.run(), f.run()]);
  assert.equal(f.sends.length, 1);
});
test('a timezone or work-account change during final verification blocks sending', async () => {
  for (const field of ['timezone', 'account']) {
    const f = await setup();
    f.gmail.searchSent = async () => {
      if (field === 'timezone') await f.kv.put('trialtz:p', { tz: 'America/New_York' }, f.clock());
      else await f.kv.put('onboarding:p', { address: 'changed@company.example' }, f.clock());
      return [];
    };
    await f.run(); assert.equal(f.sends.length, 0);
  }
});
test('first confirmation preserves the 30-minute delay and candidate-specific cancellation', async () => {
  const f = await setup();
  await f.kv.del(confirmationKey(f.lock));
  assert.equal((await f.run()).sent, 0);
  assert.equal((await f.run()).sent, 0);
  assert.deepEqual(await cancelWaiting({ db: f.db, pageId: 'p', clock: f.clock }), ['first check-in confirmation']);
  f.advance(HOLD_MS + 1);
  await f.run(); assert.equal(f.sends.length, 0);
});
test('an earlier registered occurrence blocks promising the wrong first meeting', async () => {
  const f = await setup();
  f.events.push({ ...f.event, id: 'earlier', start: new Date(f.lock.at - 3600_000).toISOString(), originalStart: '2026-10-24T03:00:00Z' });
  await assert.rejects(checkFirstMeeting(f.params), e => e.code === 'earlier_checkin_exists');
});
