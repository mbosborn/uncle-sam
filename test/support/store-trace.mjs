// Shared by the libSQL differential test: one long, realistic sequence of store operations whose outcomes are compared across database engines.
export const START = Date.parse('2026-10-14T00:00:00Z');

const input = (requestKey = 'request-1', overrides = {}) => ({ requestKey, candidateId: 'candidate-1', occurrenceId: 'round-1',
  action: 'onboarding.jamie', recipientIds: ['UJAMIE', 'UMASON'], payload: { fullName: 'Synthetic Candidate', instruction: 'fixture only' },
  triggerAt: START, dueAt: START, ...overrides });
const slack = (eventId, overrides = {}) => ({ eventId, appId: 'APPTEST', teamId: 'TTEST', channelId: 'GTEST', channelType: 'mpim', authorId: 'UTEST',
  messageTs: `${START / 1000}.123456`, threadTs: `${START / 1000}.123456`, text: 'Synthetic event text', ...overrides });
const claim = (requestKey, c, claimToken = 'attempt-1') => ({ requestKey, claimToken, expectedControlVersion: c.version, expectedPauseGeneration: c.pauseGeneration });

/**
 * Runs the sequence and returns [label, outcome] pairs. The three steps that probe FOREIGN KEY enforcement
 * are skipped when probeForeignKeys is false, so the same sequence can run on a database whose foreign keys
 * are off (the Turso default is not documented) and prove the store's own logic never relies on them.
 */
export async function trace(store, { probeForeignKeys = true } = {}) {
  const out = [];
  const step = async (label, fn) => {
    try { out.push([label, await fn()]); }
    catch (error) {
      const message = String(error?.message ?? error);
      out.push([label, { threw: /FOREIGN KEY/i.test(message) ? 'FOREIGN KEY' : /UNIQUE|constraint/i.test(message) ? 'CONSTRAINT' : message.slice(0, 80) }]);
    }
  };
  await step('control: initial', () => store.getControl());
  await step('control: Live needs a baseline', () => store.updateControl({ expectedVersion: 0, mode: 'Live' }));
  await step('control: Test', () => store.updateControl({ expectedVersion: 0, mode: 'Test' }));
  await step('control: stale version', () => store.updateControl({ expectedVersion: 0, mode: 'Off' }));
  let c = await store.getControl();
  await step('control: Live', () => store.updateControl({ expectedVersion: c.version, mode: 'Live', baselineComplete: true, activatedAt: START }));
  c = await store.getControl();
  await step('control: activation is immutable', () => store.updateControl({ expectedVersion: c.version, activatedAt: START + 1 }));

  await step('event: record', () => store.recordEvent(slack('event-1')));
  await step('event: duplicate', () => store.recordEvent(slack('event-1')));
  await step('event: second', () => store.recordEvent(slack('event-2', { messageTs: `${START / 1000 + 5}.000001` })));
  await step('event: get', () => store.getEvent('event-1'));
  await step('event: unprocessed', () => store.listUnprocessedEvents({ limit: 10 }));
  await step('event: wake pending', () => store.listWakePendingEvents({ limit: 10 }));
  await step('event: claim', () => store.claimEventWake({ eventId: 'event-1', attemptId: 'a1' }));
  await step('event: claim again', () => store.claimEventWake({ eventId: 'event-1', attemptId: 'a2' }));
  await step('event: authorize', () => store.authorizeEventWake({ eventId: 'event-1', attemptId: 'a1' }));
  await step('event: processed', () => store.markEventProcessed({ eventId: 'event-1', receipt: { outcome: 'x' } }));
  await step('event: finish', () => store.finishEventWake({ eventId: 'event-1', attemptId: 'a1' }));
  await step('event: after', () => store.getEvent('event-1'));
  await step('event: claim then release', async () => [
    await store.claimEventWake({ eventId: 'event-2', attemptId: 'b1' }),
    await store.releaseEventWake({ eventId: 'event-2', attemptId: 'b1', reason: 'retry', preCreateFailure: true }),
    await store.getEvent('event-2')]);
  await step('event: complete as ignored', () => store.completeEvent({ eventId: 'event-2', status: 'Ignored', receipt: { reason: 'x' } }));

  await step('request: ensure + link', () => store.ensureRequest(input('r1', { sourceEventId: 'event-1' })));
  await step('request: ensure again', () => store.ensureRequest(input('r1', { sourceEventId: 'event-1' })));
  await step('request: scope collision', () => store.ensureRequest(input('r1', { action: 'payment.project' })));
  if (probeForeignKeys) await step('request: link to a missing event', () => store.ensureRequest(input('r-orphan', { sourceEventId: 'no-such-event' })));
  await step('request: links', () => store.listRequestEvents('r1'));
  await step('request: pending', () => store.listPending({ limit: 10 }));
  c = await store.getControl();
  await step('request: claim', () => store.claimRequest(claim('r1', c)));
  await step('request: claim twice', () => store.claimRequest(claim('r1', c, 'attempt-2')));
  await step('request: authorize', () => store.authorizeDispatch({ requestKey: 'r1', claimToken: 'attempt-1' }));
  await step('request: unverified receipt refused', () => store.completeRequest({ requestKey: 'r1', claimToken: 'attempt-1', receipt: {} }));
  await step('request: complete', () => store.completeRequest({ requestKey: 'r1', claimToken: 'attempt-1', receipt: { verified: true, resultId: 'msg-1' } }));
  await step('request: reply', () => store.recordRequestReply({ requestKey: 'r1', reply: { kind: 'feedback', authorId: 'UTEST', text: 'ok' } }));
  await step('request: get', () => store.getRequest('r1'));
  await step('request: for candidate', () => store.listRequestsForCandidate({ candidateId: 'candidate-1', limit: 10 }));

  await step('request: thread owners', async () => [await store.ensureRequest(input('first')), await store.ensureRequest(input('racing'))]);
  const scope = { candidateId: 'candidate-1', routeKey: 'jamie_group', channelId: 'GJAMIE' };
  await step('thread: reserve first', () => store.reserveCandidateThread({ ...scope, requestKey: 'first' }));
  await step('thread: reserve racing', () => store.reserveCandidateThread({ ...scope, requestKey: 'racing' }));
  c = await store.getControl();
  await step('thread: claim owner', () => store.claimRequest(claim('first', c)));
  await step('thread: save', () => store.saveCandidateThread({ ...scope, requestKey: 'first', ownerRequestKey: 'first', previousThreadTs: null, threadTs: '1791948000.000001', verified: true }));
  await step('thread: find', () => store.findCandidateThread({ channelId: 'GJAMIE', threadTs: '1791948000.000001' }));
  await step('thread: other route', () => store.reserveCandidateThread({ ...scope, requestKey: 'racing', routeKey: 'aa_group', channelId: 'GAA' }));
  await step('thread: stale save', () => store.saveCandidateThread({ ...scope, requestKey: 'first', ownerRequestKey: 'first', previousThreadTs: '1791948000.000009', threadTs: '1791948000.000002', verified: true }));

  const hold = { holdKey: 'hold-1', candidateId: 'candidate-1', action: 'onboarding.jamie', reason: 'Candidate asked to wait', sourceEventId: 'event-1' };
  await step('hold: set', () => store.setActionHold(hold));
  await step('hold: repeat is a no-op', () => store.setActionHold(hold));
  const before = await store.getControl();
  if (probeForeignKeys) {
    await step('hold: missing source event', () => store.setActionHold({ ...hold, holdKey: 'hold-bad', sourceEventId: 'no-such-event' }));
    await step('hold: failed batch left control untouched', async () => (await store.getControl()).version === before.version);
  }
  await step('hold: stale release', () => store.releaseActionHold({ holdKey: 'hold-1', expectedVersion: 0, sourceEventId: 'event-1' }));
  await step('hold: release', () => store.releaseActionHold({ holdKey: 'hold-1', expectedVersion: 1, sourceEventId: 'event-1' }));
  await step('request: cancel pending', async () => [await store.ensureRequest(input('later')), await store.cancelRequest({ requestKey: 'later', reason: 'test' }), (await store.getRequest('later')).state]);
  await step('status', () => store.getStatus());
  return out;
}
