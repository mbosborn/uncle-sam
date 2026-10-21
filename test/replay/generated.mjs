import assert from 'node:assert/strict';
import fc from 'fast-check';
import { createWorld, PERSON, TEAM_DOMAIN } from './world.mjs';

const MIN = 60000, personal = 'synthetic@example.invalid', work = `synthetic@${TEAM_DOMAIN}`;
const shift = n => `2026-10-${String(24 + n).padStart(2, '0')}`;
export const eventArbitrary = fc.oneof(
  fc.record({ type: fc.constant('advance'), minutes: fc.constantFrom(1, 29, 30, 35, 60) }),
  fc.record({ type: fc.constant('dates'), offset: fc.integer({ min: 0, max: 3 }) }),
  fc.record({ type: fc.constant('fault'), target: fc.constantFrom('gmail.search', 'notion.candidate', 'calendar.read'), enabled: fc.boolean() }),
  fc.record({ type: fc.constant('race'), lane: fc.constantFrom('invites', 'documents', 'schedule', 'confirm'), cancel: fc.boolean() }),
  fc.constantFrom('tick', 'duplicate', 'cancel', 'hold', 'withdraw', 'restart', 'recover', 'identity').map(type => ({ type })),
);
export const planArbitrary = maxLength => fc.record({
  funnel: fc.constantFrom('interview', 'deep-dive', 'recap', 'overlap'),
  phase: fc.constantFrom('invitation', 'packet', 'calendar'),
  events: fc.array(eventArbitrary, { minLength: 1, maxLength }),
});

// The oracle tracks intended identity, dates, cancellations and effect counts.
// It does not consult queue receipts to decide whether a send was legitimate.
export async function executePlan(root, plan, scheduler, { injectDuplicate = false } = {}) {
  let w; const trace = [], violations = [];
  const model = { held: false, identityChanged: false, dates: plan.phase === 'invitation' ? null : [shift(0), shift(1)],
    cancelled: new Set(), counts: new Map(), readyAt: 0 };
  const reject = (condition, message) => { if (!condition) violations.push(message); };
  const count = key => { const n = (model.counts.get(key) ?? 0) + 1; model.counts.set(key, n); reject(n === 1, `duplicate ${key}`); };
  const kindOf = mail => /first.*check-in/i.test(mail.subject) ? 'first_checkin' : /confirm your available dates/i.test(mail.body) ? 'trial_invite' : 'packet';
  try {
    w = await createWorld(root, { dates: !!model.dates }); model.readyAt = w.now + 30 * MIN;
    w.observeEffect = (kind, data) => {
      const delivery = kind === 'email' ? kindOf(data) : kind;
      if (kind !== 'calendar' || !data.eventId) reject(!model.held, `${delivery} after hold or withdrawal`);
      if (kind === 'email' || kind === 'packet') {
        reject(!model.cancelled.has(delivery), `${delivery} after accepted cancellation`);
        reject(!model.identityChanged, `${delivery} redirected after identity change`);
        reject((kind === 'email' ? data.to : data.email) === personal, `wrong ${delivery} recipient`);
        reject(w.now >= model.readyAt, `premature ${delivery}`);
        count(kind === 'packet' ? 'envelope' : `email:${delivery}`);
        if (kind === 'packet') reject(JSON.stringify([data.addendum?.terms.start, data.addendum?.terms.end]) === JSON.stringify(model.dates), 'packet used stale dates');
        if (kind === 'email' && delivery === 'trial_invite') reject(!model.dates, 'availability invitation after dates agreed');
        if (kind === 'email' && delivery === 'first_checkin') {
          const first = w.events().filter(e => !e.allDay && e.status !== 'cancelled').sort((a, b) => a.start.localeCompare(b.start))[0];
          const day = first && new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(Date.parse(first.start));
          reject(day === model.dates?.[0], 'first meeting promise used stale dates');
        }
      }
      if (kind === 'calendar' && !data.eventId) {
        const body = data.body, day = body.start.date ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(Date.parse(body.start.dateTime));
        reject(day === model.dates?.[0], 'calendar created on stale dates');
        if (body.start.date) reject(!(body.attendees ?? []).some(x => [personal, work].includes(x.email)), 'candidate invited to internal banner');
        else {
          reject(!model.identityChanged, 'new candidate calendar invitation after identity change');
          reject(body.attendees.some(x => x.email === work) && !body.attendees.some(x => x.email === personal), 'check-in used wrong candidate account');
          count(`calendar:${body.summary}:${body.start.dateTime}`);
        }
      }
    };
    const initial = async () => {
      if (plan.funnel !== 'recap') await w.feedback({ author: w.m.agent.PEOPLE[plan.funnel === 'deep-dive' ? 'interviewer' : 'robin'], dates: !!model.dates, id: 'generated-approval' });
      if (['recap', 'overlap'].includes(plan.funnel)) await w.recap();
    };
    await initial();
    if (plan.phase === 'calendar') {
      w.set({ Stage: 'Trial', Paperwork: 'Signed' }); await w.accounts();
      await w.schedule(); await w.confirm();
    }
    w.advance(35 * MIN);
    const cancel = async () => {
      const kinds = await w.m.queue.cancelWaiting({ db: w.db, pageId: PERSON, clock: w.clock });
      for (const kind of kinds) model.cancelled.add({ 'work trial documents': 'packet', 'work trial invitation': 'trial_invite', 'first check-in confirmation': 'first_checkin' }[kind] ?? kind);
      trace.push({ type: 'cancel-result', kinds });
    };
    const tick = async () => { await w.invites(); await w.documents(); if (plan.phase === 'calendar') { await w.schedule(); await w.confirm(); } };
    for (const event of plan.events) {
      trace.push(event);
      try {
      switch (event.type) {
        case 'advance': w.advance(event.minutes * MIN); break;
        case 'dates':
          model.dates = [shift(event.offset), shift(event.offset + 1)];
          w.set({ 'Trial Start': model.dates[0], 'Trial End': model.dates[1] }); break;
        case 'duplicate':
          if (plan.funnel !== 'recap') await w.runner.runEvent({ eventId: 'generated-approval', attemptId: 'duplicate-delivery' });
          if (['recap', 'overlap'].includes(plan.funnel)) await w.recap();
          break;
        case 'cancel': await cancel(); break;
        case 'hold': model.held = true; w.set({ Outcome: 'On Hold' }); break;
        case 'withdraw': model.held = true; w.set({ Outcome: 'Withdrawn or Unavailable' }); break;
        case 'identity': model.identityChanged = true; w.set({ Email: 'other-person@example.invalid' }); break;
        case 'restart': await w.restart(); break;
        case 'fault': event.enabled ? w.fail(event.target) : w.recover(event.target); break;
        case 'recover': w.faults.clear(); break;
        case 'tick': await tick(); break;
        case 'race': {
          const peers = [w.peer(), w.peer()], before = w.before;
          // Control when reads/writes reach synthetic providers. Schedule promises
          // BEFORE starting the operation, not after its side effects have happened.
          w.before = async name => { await scheduler.schedule(Promise.resolve(), name); await before(name); };
          try {
            const calls = peers.map((p, i) => scheduler.schedule(Promise.resolve(), `worker-${i}`).then(() => p[event.lane]()));
            if (event.cancel) calls.push(scheduler.schedule(Promise.resolve(), 'cancel-worker').then(cancel));
            const results = await scheduler.waitFor(Promise.allSettled(calls));
            for (const r of results) {
              if (r.status === 'rejected') throw r.reason;
              if (r.value?.error && !w.faults.size) throw Error(`competing worker error: ${r.value.error}`);
            }
          } finally { w.before = before; peers.forEach(p => p.close()); }
          break;
        }
        default: throw Error('Unknown generated event');
      }
      } catch (error) {
        if (error.code !== 'fixture_unavailable' || !w.faults.size) throw error;
        trace.push({ type: 'expected-outage', code: error.code });
      }
      if (injectDuplicate && w.emails.length) { const mail = w.emails[0]; w.observeEffect('email', mail); }
      assert.deepEqual(violations, [], 'workflow safety invariant failed');
    }
    // Every exploration ends with recovery and duplicate workers after the delay.
    // A fault cannot make the whole test pass just because nothing ran again.
    w.faults.clear(); w.advance(60 * MIN); await tick(); await w.restart(); await tick();
    assert.deepEqual(violations, [], 'recovery safety invariant failed');
    return { trace, effects: { emails: w.emails.length, packets: w.envelopes.length, calendarWrites: w.calendarWrites.length }, restarts: w.restarts };
  } catch (error) { error.exploration = { trace, violations }; throw error; }
  finally { await w?.close(); }
}

export async function explore(root, { runs = 100, maxEvents = 20, seed, path, injectDuplicate = false } = {}) {
  let failure = null, effects = { emails: 0, packets: 0, calendarWrites: 0 }, executions = 0;
  const property = fc.asyncProperty(planArbitrary(maxEvents), fc.scheduler(), async (plan, scheduler) => {
    executions++;
    try { const result = await executePlan(root, plan, scheduler, { injectDuplicate }); for (const k of Object.keys(effects)) effects[k] += result.effects[k]; }
    catch (error) {
      failure = { plan: structuredClone(plan), ordering: scheduler.report().filter(x => x.status !== 'pending').map(x => x.taskId),
        trace: error.exploration?.trace ?? [], violations: error.exploration?.violations ?? [], error: error.message };
      throw error;
    }
  });
  const result = await fc.check(property, { numRuns: runs, ...(seed !== undefined ? { seed } : {}), ...(path ? { path } : {}),
    endOnFailure: false, interruptAfterTimeLimit: 180_000, markInterruptAsFailure: true });
  // Capture the accepted counterexample, not an intermediate failed shrink.
  if (result.counterexample) {
    const [initial, originalScheduler] = result.counterexample;
    const reproduce = async plan => {
      const scheduler = originalScheduler[fc.cloneMethod](); executions++;
      try { await executePlan(root, plan, scheduler, { injectDuplicate }); return null; }
      catch (error) { return { plan: structuredClone(plan), ordering: scheduler.report().filter(x => x.status !== 'pending').map(x => x.taskId),
        trace: error.exploration?.trace ?? [], violations: error.exploration?.violations ?? [], error: error.message }; }
    };
    failure = await reproduce(initial);
    if (!failure) failure = { plan: initial, ordering: [], trace: [], violations: [], error: 'Failure did not reproduce; retain the seed and investigate uncontrolled scheduling' };
    else {
      // fast-check shrinks values and ordering. Finish with deletion reduction so
      // irrelevant event suffixes do not survive as expensive regressions.
      const signature = f => f.violations[0] ?? f.error;
      let index = 0, attempts = 0;
      while (index < failure.plan.events.length && attempts++ < 200) {
        const trial = { ...failure.plan, events: failure.plan.events.filter((_, i) => i !== index) };
        const reduced = await reproduce(trial);
        if (reduced && signature(reduced) === signature(failure)) { failure = reduced; index = 0; }
        else index++;
      }
      failure.reduction = { deletionAttempts: attempts, singleDeletionMinimal: index >= failure.plan.events.length };
    }
  }
  return { passed: !result.failed && !result.interrupted, seed: result.seed, path: result.counterexamplePath, runs: result.numRuns,
    shrinks: result.numShrinks, executions, interrupted: result.interrupted, effects, failure: result.failed ? failure : null };
}

export function validatePlan(plan) {
  assert.ok(['interview', 'deep-dive', 'recap', 'overlap'].includes(plan?.funnel));
  assert.ok(['invitation', 'packet', 'calendar'].includes(plan?.phase));
  assert.ok(Array.isArray(plan.events) && plan.events.length <= 100);
  for (const e of plan.events) {
    assert.ok(['advance', 'dates', 'fault', 'race', 'tick', 'duplicate', 'cancel', 'hold', 'withdraw', 'restart', 'recover', 'identity'].includes(e.type));
    if (e.type === 'advance') assert.ok(Number.isInteger(e.minutes) && e.minutes >= 0 && e.minutes <= 1440);
    if (e.type === 'dates') assert.ok(Number.isInteger(e.offset) && e.offset >= 0 && e.offset <= 3);
    if (e.type === 'fault') assert.ok(['gmail.search', 'notion.candidate', 'calendar.read'].includes(e.target) && typeof e.enabled === 'boolean');
    if (e.type === 'race') assert.ok(['invites', 'documents', 'schedule', 'confirm'].includes(e.lane) && typeof e.cancel === 'boolean');
  }
  return plan;
}
