import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { jointPlan, MAX_ORDERS, MAX_TRIALS } from '../service/lib/checkin-joint-plan.mjs';
import { ensureCheckins } from '../service/lib/work-trial.mjs';
import { runCheckinGuard, handleCheckinReply, PEOPLE } from '../service/lib/checkins.mjs';
import { noticeStore } from '../service/lib/stuck-rejections.mjs';
import { zonedHM, GAP_MS, SLOT_MS } from '../service/lib/checkin-times.mjs';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/joint-checkin-capacity.json', import.meta.url)));
const OWNER = 'project@company.example', DOMAIN = 'company.example';
const busyFor = spans => Object.fromEntries(Object.values(PEOPLE).map(email => [email, spans]));
const parseStamp = s => Date.parse(s.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'));
const occurrences = body => [...new Set([Date.parse(body.start.dateTime), ...(body.recurrence?.find(r => r.startsWith('RDATE:'))?.slice(6).split(',').map(parseStamp) ?? [])])].sort((a, b) => a - b);
function separated(times) { const sorted = [...times].sort((a, b) => a - b); for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i] - sorted[i - 1] >= SLOT_MS + GAP_MS, 'check-ins need a five-minute buffer'); }

test('bounded joint search recovers the missed synthetic check-in and is independent of input order', () => {
  const args = { trials: fixture.trials, busy: busyFor(fixture.busy), now: Date.parse(fixture.now) };
  assert.equal(jointPlan({ ...args, maxOrders: 1 }).score[0], 1, 'retain the failing sequential baseline');
  const result = jointPlan(args);
  assert.equal(result.score[0], 0);
  separated(result.plans.flatMap(p => p.slots.map(s => s.at)));
  assert.deepEqual(jointPlan({ ...args, trials: [...args.trials].reverse() }), result);
  assert.ok(result.orders <= MAX_ORDERS);
});

test('planner respects hard capacity, bounds and explicit time restrictions', () => {
  const trials = Array.from({ length: MAX_TRIALS + 1 }, (_, i) => ({ ...fixture.trials[0], candidate: { pageId: `bound-${i}`, fullName: 'Example' },
    constraints: [{ kind: 'both', from: '22:00', to: '23:00' }] }));
  const result = jointPlan({ trials, busy: busyFor([]), now: Date.parse(fixture.now), maxOrders: 1000 });
  assert.equal(result.deferred.length, 1);
  assert.ok(result.orders <= MAX_ORDERS);
  assert.ok(result.plans.every(p => p.slots.every(s => s.at === null)), 'the planner cannot relax the team cutoff to improve its score');
});

async function world({ trials = fixture.trials, spans = fixture.busy } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const db = { prepare: sql => ({ bind: (...args) => ({ first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => sqlite.prepare(sql).run(...args), all: async () => ({ results: sqlite.prepare(sql).all(...args) }) }) }) };
  const w = { db, kv: noticeStore(db), now: Date.parse(fixture.now), writes: [], events: [], posted: [], mode: 'Live', reads: 0, onRead: null, onWrite: null };
  w.people = trials.map((t, i) => ({ ...t.candidate, email: `person${i}@example.invalid`, fields: { Stage: 'Trial', Outcome: 'Proceeding',
    Pipeline: 'US/EU', 'Trial Start': t.start, 'Trial End': t.end, 'Action Status': 'Waiting on Candidate' } }));
  for (const [i, p] of w.people.entries()) {
    await w.kv.put(`trialtz:${p.pageId}`, { tz: trials[i].tz }, w.now);
    await w.kv.put(`onboarding:${p.pageId}`, { address: `person${i}@${DOMAIN}`, jamieDone: { at: w.now } }, w.now);
    w.events.push({ id: `banner${i}`, calendarId: OWNER, allDay: true, status: 'confirmed', summary: `${p.fullName} Work Trial (Remote)`,
      start: `${trials[i].start}T00:00:00Z`, end: `${trials[i].end}T23:59:59Z`, attendees: [] });
  }
  for (const [i, s] of spans.entries()) w.events.push({ id: `busy${i}`, start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString(),
    summary: s.summary, status: 'confirmed', allDay: false, attendees: Object.values(PEOPLE).map(email => ({ email, responseStatus: 'accepted' })) });
  w.notion = { readControl: async () => ({ mode: w.mode }), listTrialCandidates: async () => structuredClone(w.people),
    getCandidate: async id => structuredClone(w.people.find(p => p.pageId === id)), listCandidateNotes: async () => [], appendCandidateNote: async () => {} };
  w.calendar = {
    async listEvents({ calendarId, timeMin, timeMax, q }) {
      w.reads++; await w.onRead?.({ calendarId });
      return structuredClone(w.events.filter(e => (!q || e.summary.toLowerCase().includes(q.toLowerCase())) && Date.parse(e.end) > timeMin && Date.parse(e.start) < timeMax
        && (calendarId === OWNER || e.attendees.some(a => a.email === calendarId))));
    },
    async writeEvent(input) {
      w.writes.push(structuredClone(input));
      if (input.eventId) return { id: input.eventId };
      const body = input.body, id = body.id;
      assert.match(id, /^[0-9a-v]{5,1024}$/);
      for (const at of occurrences(body)) w.events.push({ id: `${id}_${new Date(at).toISOString().replace(/[-:]/g, '').replace('.000', '')}`,
        recurringEventId: id, originalStart: new Date(at).toISOString(), start: new Date(at).toISOString(), end: new Date(at + SLOT_MS).toISOString(),
        summary: body.summary, status: 'confirmed', allDay: false, transparent: false, organizer: OWNER, meetUrl: 'https://meet.google.com/abc-defg-hij', attendees: body.attendees });
      await w.onWrite?.(input);
      return { id };
    }
  };
  w.run = (person = w.people[0]) => ensureCheckins({ db, notion: w.notion, calendar: w.calendar, canWrite: true,
    candidate: structuredClone(person), clock: () => w.now, poster: async text => { w.posted.push(text); return `post${w.posted.length}`; } });
  w.close = () => sqlite.close();
  return w;
}

test('actual setup books every planned occurrence across three funnels without touching existing events', async t => {
  const w = await world(); t.after(w.close);
  w.people.forEach((p, i) => { p.fields.Pipeline = ['India', 'US/EU', 'Research'][i]; });
  const before = structuredClone(w.events);
  assert.equal(await w.run(), 'created');
  assert.equal(w.writes.length, 6, 'two series per trial');
  const times = w.writes.flatMap(x => occurrences(x.body)); separated(times);
  assert.equal(times.length, 6);
  assert.deepEqual(w.events.slice(0, before.length), before);
  assert.ok(w.writes.every(x => !x.eventId && x.sendUpdates === 'all'));
  for (const p of w.people) {
    const reg = await w.kv.get(`checkins:${p.pageId}`);
    assert.equal(reg.creating, false);
    assert.equal((await w.kv.get(`checkin:first:${p.pageId}`)).emailEligible, true);
    const writes = w.writes.filter(x => reg.series.some(s => s.eventId === x.body.id));
    assert.equal(writes.length, 2);
    assert.deepEqual(writes.flatMap(x => occurrences(x.body)).sort((a,b)=>a-b), reg.slots.map(s=>s.at).sort((a,b)=>a-b));
    for (const x of writes) { assert.ok(!x.body.attendees.some(a => a.email === p.email)); assert.equal(x.body.attendees.length, 4); }
  }
  assert.equal(await w.run(), 'already_set_up');
  assert.equal(w.writes.length, 6);
});

test('exact recurrence dates preserve local times across daylight saving and avoid later-day conflicts', async t => {
  const trial = { candidate: { pageId: 'dst-example', fullName: 'DST Example' }, tz: 'America/Los_Angeles', start: '2026-10-31', end: '2026-11-02' };
  const w = await world({ trials: [trial], spans: [] }); t.after(w.close);
  assert.equal(await w.run(), 'created');
  const morning = occurrences(w.writes.find(x => /Morning/.test(x.body.summary)).body);
  assert.deepEqual(morning.map(at=>zonedHM(at,trial.tz)), ['09:30','09:30','09:30']);
  assert.equal(morning[1]-morning[0],25*3600_000, 'UTC dates must account for the DST transition');
  assert.ok(w.writes.every(x => !x.body.recurrence.some(r => r.startsWith('RRULE:'))));
});

test('a later-day conflict changes that occurrence rather than repeating the first-day time', async t => {
  const trial = { candidate: { pageId: 'later-example', fullName: 'Later Example' }, tz: 'America/Los_Angeles', start: '2026-10-26', end: '2026-10-27' };
  const span = { start: Date.parse('2026-10-27T16:00:00Z'), end: Date.parse('2026-10-27T17:00:00Z'), summary: 'Existing appointment' };
  const w = await world({ trials: [trial], spans: [span] }); t.after(w.close);
  assert.equal(await w.run(), 'created');
  const morning = occurrences(w.writes.find(x => /Morning/.test(x.body.summary)).body);
  assert.deepEqual(morning.map(at=>zonedHM(at,trial.tz)), ['09:30','10:05']);
  assert.ok(w.writes.flatMap(x=>occurrences(x.body)).every(at=>at+SLOT_MS+GAP_MS<=span.start||at>=span.end+GAP_MS));
});

test('a second worker cannot plan or book while the shared lease is held', async t => {
  const w = await world({ trials: [fixture.trials[0]], spans: [] }); t.after(w.close);
  let enter, release;
  const entered = new Promise(r=>enter=r), blocked = new Promise(r=>release=r);
  w.onRead = async () => { if (w.reads === 1) { enter(); await blocked; } };
  const first = w.run(); await entered;
  assert.equal(await w.run(), 'joint_planning_busy');
  release(); assert.equal(await first, 'created'); assert.equal(w.writes.length, 2);
});

for (const change of ['recipient', 'dates', 'hold', 'calendar', 'pause', 'lease']) test(`recheck ${change} after planning, before any invitation`, async t => {
  const w = await world({ trials: [fixture.trials[0]], spans: [] }); t.after(w.close);
  let changed = false;
  w.onRead = async () => {
    if (changed || !(await w.kv.get(`checkins:${w.people[0].pageId}`))?.creating) return;
    changed = true;
    if (change === 'recipient') w.people[0].email = 'corrected@example.invalid';
    if (change === 'dates') w.people[0].fields['Trial End'] = '2026-10-27';
    if (change === 'hold') w.people[0].fields.Outcome = 'On Hold';
    if (change === 'pause') w.mode = 'Off';
    if (change === 'lease') await w.kv.put('checkins:planning-lease', {token:'another-worker',expiresAt:w.now+600000},w.now);
    if (change === 'calendar') w.events.push({ id:'new-conflict',summary:'New appointment',start:'2026-10-24T00:00:00Z',end:'2026-10-29T00:00:00Z',status:'confirmed',allDay:false,attendees:Object.values(PEOPLE).map(email=>({email})) });
  };
  assert.equal(await w.run(), 'checkin_plan_changed'); assert.equal(w.writes.length, 0); assert.equal(changed,true);
});

test('partial or uncertain provider success keeps reservations and prevents automatic repeats', async t => {
  const w = await world({ trials: [fixture.trials[0]], spans: [] }); t.after(w.close);
  w.onWrite = async () => { throw Object.assign(Error('synthetic provider response lost'), {uncertain:true}); };
  assert.equal(await w.run(), 'checkin_creation_needs_review'); assert.equal(w.writes.length, 1);
  const reg = await w.kv.get(`checkins:${w.people[0].pageId}`); assert.equal(reg.needsReview,true); assert.equal(reg.slots.length,2);
  assert.equal(reg.attempt.id,w.writes[0].body.id,'retain the exact requested provider ID after an uncertain response');
  w.onWrite = null;
  assert.equal(await w.run(), 'checkin_creation_needs_review'); assert.equal(w.writes.length,1);
  assert.equal(await w.kv.get(`checkin:first:${w.people[0].pageId}`),null);
});

test('cancellation between series prevents the second invite and first-time confirmation', async t => {
  const w = await world({ trials: [fixture.trials[0]], spans: [] }); t.after(w.close);
  w.onWrite = async () => { w.people[0].fields.Outcome='Withdrawn or Unavailable'; };
  assert.equal(await w.run(), 'checkin_creation_needs_review'); assert.equal(w.writes.length,1);
  assert.equal((await w.kv.get(`checkin:first:${w.people[0].pageId}`)).emailEligible,false);
});

test('saturated calendar reads and infeasible plans never produce invitations', async t => {
  const w = await world({ trials: [fixture.trials[0]], spans: [] }); t.after(w.close);
  const read = w.calendar.listEvents;
  w.calendar.listEvents = async args => args.calendarId===Object.values(PEOPLE)[0] ? Array(1000).fill({}) : read(args);
  assert.equal(await w.run(),'team_calendar_unreadable'); assert.equal(w.writes.length,0);
  w.calendar.listEvents=read;
  w.events.push({id:'full',summary:'Busy',start:'2026-10-24T00:00:00Z',end:'2026-10-29T00:00:00Z',allDay:false,status:'confirmed',attendees:Object.values(PEOPLE).map(email=>({email}))});
  assert.equal(await w.run(),'joint_plan_incomplete'); assert.equal(w.writes.length,0);
});

test('published joint schedules are not automatically reshuffled by the guard', async t => {
  const w = await world({ trials: [fixture.trials[0]], spans: [] }); t.after(w.close);
  assert.equal(await w.run(),'created');
  w.events.push({id:'later-clash',summary:'Changed meeting',start:'2026-10-26T00:00:00Z',end:'2026-10-28T00:00:00Z',allDay:false,status:'confirmed',attendees:Object.values(PEOPLE).map(email=>({email}))});
  w.writes.length=0;
  await runCheckinGuard({db:w.db,calendar:w.calendar,notion:w.notion,clock:()=>w.now,force:true,poster:async text=>{w.posted.push(text);return 'conflict';}});
  assert.ok(w.writes.every(x=>!x.body.start&&!x.body.end),'no automatic move of an existing invitation');
  assert.ok(w.posted.some(x=>/locked against automatic moves/.test(x)));
});

test('an explicit approved move updates its durable capacity reservation', async t => {
  const w = await world({ trials: [fixture.trials[0]], spans: [] }); t.after(w.close);
  assert.equal(await w.run(),'created');
  const key=`checkins:${w.people[0].pageId}`, reg=await w.kv.get(key), from=Math.max(...reg.slots.map(s=>s.at)), to=from+20*60000;
  const inst=w.events.find(e=>e.recurringEventId&&Date.parse(e.start)===from);
  await w.kv.put('checkins:askts:ask', {key,instId:inst.id,start:from,end:from+SLOT_MS,at:w.now,ts:'ask'},w.now);
  const time=new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',hour:'numeric',minute:'2-digit'}).format(to);
  const result=await handleCheckinReply({event:{authorId:'operator',threadTs:'ask',messageTs:'reply',text:`Make it ${time} PT`},masonId:'operator',
    db:w.db,calendar:w.calendar,notion:w.notion,clock:()=>w.now,poster:()=>async()=>{}});
  assert.equal(result.kind,'checkin_moved');
  const after=await w.kv.get(key); assert.ok(after.slots.some(s=>s.at===to)); assert.ok(after.slots.every(s=>s.at!==from));
});
