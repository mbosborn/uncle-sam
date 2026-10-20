import { test } from 'node:test';
import assert from 'node:assert/strict';
import { persistedFixture } from './support/d1.mjs';
import { runStuckRejections, handleStuckGo, isStuckGo, noticeText, noticeStore, restartable, MASON_ID } from '../service/lib/stuck-rejections.mjs';

const NOW = Date.parse('2026-10-16T18:00:00Z');
const ENV = Object.freeze({ UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled', SLACK_BOT_TOKEN: 'xoxb-fixture-only' });
const ROUTES = Object.freeze({ project: { channelId: 'D0MASON001', type: 'im' } });
const FINLEY = '3f36ba36-8537-811e-8329-d48e55fd0dc2', ZED = '66666666-6666-4666-8666-666666666666';
const NIA = '77777777-7777-4777-8777-777777777777', HAL = '88888888-8888-4888-8888-888888888888';

function slack() {
  const s = { posts: [], n: 0 };
  s.fetch = async (url, init) => {
    assert.equal(url, 'https://slack.com/api/chat.postMessage');
    const body = JSON.parse(init.body);
    const ts = `17921${String(++s.n).padStart(5, '0')}.000100`;
    s.posts.push({ ...body, ts });
    return Response.json({ ok: true, ts });
  };
  return s;
}
const row = (pageId, fullName, sender = {}, fields = {}) => ({
  candidate: { pageId, fullName, email: `${fullName.split(' ')[0].toLowerCase()}@example.com`, inRecruitingSource: true, archived: false,
    url: `https://www.notion.so/${pageId.replaceAll('-', '')}`, fields: { Outcome: 'Not Selected', Stage: 'Closed', ...fields } },
  sender: { status: 'Needs attention', hold: false, attempt: null, decisionAt: null, decisionKey: null, queuedTo: null, scheduledFor: null, lastInterviewEnd: null, ...sender } });
function fakeNotion({ mode = 'Live', rows = [], interviews = {} } = {}) {
  const n = { rows: new Map(rows.map(r => [r.candidate.pageId, r])), rearmed: [], notes: [] };
  Object.assign(n, {
    async readControl() { return { mode }; },
    async listStuckRejections() { return [...n.rows.values()].filter(r => r.sender.status === 'Needs attention' && r.candidate.fields.Outcome === 'Not Selected'); },
    async getRejectionState(id) { return structuredClone(n.rows.get(id)); },
    async listCandidateInterviews({ candidatePageId }) { return interviews[candidatePageId] ?? []; },
    async rearmRejection(args) { n.rearmed.push(args); const r = n.rows.get(args.pageId); r.sender = { ...r.sender, status: 'Scheduled', scheduledFor: args.scheduledFor }; return { verified: true }; },
    async appendCandidateNote(args) { n.notes.push(args); },
  });
  return n;
}
const goEvent = (threadTs, { text = 'go', authorId = MASON_ID, messageTs = String(NOW / 1000 - 60) + '.000200' } = {}) =>
  ({ source: 'slack', type: 'message', channelId: 'D0MASON001', authorId, text, threadTs, messageTs });
/** A row Uncle Sam already restarted once, so the next stop goes to Project (lets the "go" tests get a notice). */
// Restarted three times in the last day: the limit (Project, 2026-10-20), so the next stop goes to Project.
const restartedOnce = async (db, ...ids) => { for (const id of ids) await noticeStore(db).put(`auto:${id}`, { at: NOW - 3600_000, times: [NOW - 3 * 3600_000, NOW - 2 * 3600_000, NOW - 3600_000] }, NOW - 3600_000); };

test('Project, Oct 15: a stuck rejection Uncle Sam can fix is restarted quietly, once; he hears only about the ones that need him', async () => {
  const { db } = persistedFixture();
  const s = slack();
  const end = '2026-10-16T09:30:00.000Z';
  const notion = fakeNotion({ rows: [
    row(FINLEY, 'Finley Crawford', { decisionAt: '2026-10-16T10:12:29.202Z' }),
    row(ZED, 'Zed Park', { attempt: 'run-1 2026-10-16T10:00Z', lastInterviewEnd: '2026-10-14T19:00:00Z' }),
    { ...row(NIA, 'Nia Stone'), candidate: { ...row(NIA, 'Nia Stone').candidate, email: null } },
    row(HAL, 'Hal Jordan', { hold: true, lastInterviewEnd: '2026-10-14T19:00:00Z' }),
  ], interviews: { [FINLEY]: [{ status: 'confirmed', end, htmlLink: 'https://www.google.com/calendar/event?eid=oct' }] } });
  const run = () => runStuckRejections({ env: ENV, db, notion, routeMap: ROUTES, fetchImpl: s.fetch, clock: () => NOW });
  assert.deepEqual(await run(), { stuck: 4, restarted: 1, notified: 2, cleared: 0, error: null });
  assert.deepEqual(notion.rearmed, [{ pageId: FINLEY, expectedEmail: 'finley@example.com', interviewEnd: { at: end, sourceUrl: 'https://www.google.com/calendar/event?eid=oct' },
    decisionAt: '2026-10-16T10:12:29.202Z', decisionKey: `${FINLEY}|2026-10-16T10:12:29.202Z`, scheduledFor: '2026-10-17T09:30:00.000Z' }]);
  assert.match(notion.notes[0].text, /restarted automatically by Uncle Sam \(Project's standing instruction, Oct 15.*at least 24 hours after their latest logged interview\.$/);
  assert.equal(s.posts.some(p => /Finley/.test(p.text)), false, 'no message about the one fixed quietly');
  assert.equal(s.posts.length, 2);
  assert.equal(s.posts.some(p => /Zed/.test(p.text)), false, 'a send that may have gone out is settled from Sent mail first (rejection-confirm.test.mjs), Project not asked yet');
  assert.match(s.posts.find(p => /Nia/.test(p.text)).text, /there is no email on their record/);
  assert.match(s.posts.find(p => /Hal/.test(p.text)).text, /someone put it on hold/);
  assert.deepEqual(await run(), { stuck: 3, restarted: 0, notified: 0, cleared: 0, error: null }, 'told once');
  // Stopped again (the retired Notion agent, Project 2026-10-20): restarted again quietly, up to three times a day.
  for (let i = 2; i <= 3; i++) {
    notion.rows.get(FINLEY).sender.status = 'Needs attention';
    assert.deepEqual(await run(), { stuck: 4, restarted: 1, notified: 0, cleared: 0, error: null }, `restart ${i}`);
    notion.rows.get(FINLEY).sender.status = 'Scheduled';
  }
  notion.rows.get(FINLEY).sender.status = 'Needs attention';
  assert.deepEqual(await run(), { stuck: 4, restarted: 0, notified: 1, cleared: 0, error: null }, 'a fourth stop in a day: now Project hears');
  assert.match(s.posts.at(-1).text, /^📯 \*Finley Crawford\*'s rejection email is stuck: the rejection sender stopped it again after I restarted it/);
  assert.equal(notion.rearmed.length, 3, 'three restarts at most without Project');
  notion.rows.get(HAL).sender.status = 'Sent';
  assert.equal((await run()).cleared, 1);
});

test('with no interview on record, a quiet restart uses the time it was found, so the email is never earlier than 24 hours after the real end', async () => {
  const { db } = persistedFixture();
  const s = slack();
  const notion = fakeNotion({ rows: [row(FINLEY, 'Finley Crawford')] });
  const summary = await runStuckRejections({ env: ENV, db, notion, routeMap: ROUTES, fetchImpl: s.fetch, clock: () => NOW });
  assert.equal(summary.restarted, 1);
  const [args] = notion.rearmed;
  assert.equal(args.interviewEnd.at, new Date(NOW).toISOString());
  assert.equal(args.interviewEnd.sourceUrl, `https://www.notion.so/${FINLEY.replaceAll('-', '')}`);
  assert.equal(args.scheduledFor, new Date(NOW + 24 * 3600_000).toISOString());
  assert.match(notion.notes[0].text, /the time Uncle Sam found it stopped/);
  assert.equal(s.posts.length, 0);
  assert.equal(restartable(row(FINLEY, 'O P', { attempt: 'x' })), false);
});

test('a failed quiet restart falls back to telling Project', async () => {
  const { db } = persistedFixture();
  const s = slack();
  const notion = fakeNotion({ rows: [row(FINLEY, 'Finley Crawford')] });
  notion.rearmRejection = async () => { const e = new Error('readback'); e.code = 'rejection_readback_mismatch'; throw e; };
  const logs = [];
  const summary = await runStuckRejections({ env: ENV, db, notion, routeMap: ROUTES, fetchImpl: s.fetch, clock: () => NOW, log: l => logs.push(l) });
  assert.deepEqual(summary, { stuck: 1, restarted: 0, notified: 1, cleared: 0, error: null });
  assert.match(logs[0], /restart_failed .*rejection_readback_mismatch/);
  assert.match(s.posts[0].text, /no interview end time was recorded/);
});

test('nothing is checked unless automatic activity is on and the control row is Live', async () => {
  const { db } = persistedFixture();
  const s = slack();
  const notion = fakeNotion({ mode: 'Test', rows: [row(FINLEY, 'Finley Crawford')] });
  const off = await runStuckRejections({ env: ENV, db, notion, routeMap: ROUTES, fetchImpl: s.fetch, clock: () => NOW });
  assert.equal(off.notified + off.restarted, 0);
  const paused = await runStuckRejections({ env: { ...ENV, UNCLE_SAM_AUTOMATIC_ACTIVITY: 'off' }, db, notion: fakeNotion({ rows: [row(FINLEY, 'O P')] }), routeMap: ROUTES, fetchImpl: s.fetch, clock: () => NOW });
  assert.equal(paused.notified + paused.restarted, 0);
  assert.equal(notion.rearmed.length, 0);
  assert.equal(s.posts.length, 0);
});

test('Project\'s "go" in the notice thread re-arms: latest logged interview as the end, original decision kept, scheduled 24 hours after the interview', async () => {
  const { db } = persistedFixture();
  const s = slack();
  const end = '2026-10-16T09:30:00.000Z';
  const notion = fakeNotion({ rows: [row(FINLEY, 'Finley Crawford', { decisionAt: '2026-10-16T10:12:29.202Z' })],
    interviews: { [FINLEY]: [{ status: 'confirmed', end, htmlLink: 'https://www.google.com/calendar/event?eid=oct' },
      { status: 'cancelled', end: '2026-10-16T12:00:00.000Z', htmlLink: 'https://www.google.com/calendar/event?eid=x' }] } });
  await restartedOnce(db, FINLEY);
  await runStuckRejections({ env: ENV, db, notion, routeMap: ROUTES, fetchImpl: s.fetch, clock: () => NOW });
  const thread = s.posts[0].ts;
  const outcome = await handleStuckGo({ event: goEvent(thread), env: ENV, db, notion, fetchImpl: s.fetch, clock: () => NOW });
  assert.deepEqual(outcome, { kind: 'rejection_rearmed', reason: null });
  assert.deepEqual(notion.rearmed, [{ pageId: FINLEY, expectedEmail: 'finley@example.com', interviewEnd: { at: end, sourceUrl: 'https://www.google.com/calendar/event?eid=oct' },
    decisionAt: '2026-10-16T10:12:29.202Z', decisionKey: `${FINLEY}|2026-10-16T10:12:29.202Z`, scheduledFor: '2026-10-17T09:30:00.000Z' }]);
  assert.equal(s.posts.at(-1).thread_ts, thread);
  assert.match(s.posts.at(-1).text, /^🫡 Restarted\. Finley Crawford's rejection email goes out at Sat, Oct 17, 2:30 AM PT\.$/);
  assert.match(notion.notes[0].text, /re-armed by Project.*latest logged interview/);
  assert.equal(await handleStuckGo({ event: goEvent(thread), env: ENV, db, notion, fetchImpl: s.fetch, clock: () => NOW }), null, 'the notice is used up');
});

test('with no interview on record, the time of the "go" stands in, so the email is never earlier than 24 hours after the real end', async () => {
  const { db } = persistedFixture();
  const s = slack();
  const notion = fakeNotion({ rows: [row(FINLEY, 'Finley Crawford')] });
  await restartedOnce(db, FINLEY);
  await runStuckRejections({ env: ENV, db, notion, routeMap: ROUTES, fetchImpl: s.fetch, clock: () => NOW });
  const event = goEvent(s.posts[0].ts);
  await handleStuckGo({ event, env: ENV, db, notion, fetchImpl: s.fetch, clock: () => NOW });
  const [args] = notion.rearmed;
  assert.equal(args.interviewEnd.at, new Date(Math.floor(Number(event.messageTs) * 1000)).toISOString());
  assert.match(args.interviewEnd.sourceUrl, /^https:\/\/example-workspace\.slack\.com\/archives\/D0MASON001\/p\d+$/);
  assert.equal(args.decisionAt, args.interviewEnd.at);
  assert.equal(Date.parse(args.scheduledFor), Math.ceil((Date.parse(args.interviewEnd.at) + 24 * 3600_000) / 60_000) * 60_000);
});

test('a "go" is refused for a row on hold, no longer stuck, or without an email; other threads and other people are not this lane', async () => {
  const { db } = persistedFixture();
  const s = slack();
  const notion = fakeNotion({ rows: [row(FINLEY, 'Finley Crawford'), row(ZED, 'Zed Park')] });
  await restartedOnce(db, FINLEY, ZED);
  await runStuckRejections({ env: ENV, db, notion, routeMap: ROUTES, fetchImpl: s.fetch, clock: () => NOW });
  const [octavioTs, zedTs] = s.posts.map(p => p.ts);
  notion.rows.get(FINLEY).sender.hold = true;
  assert.equal((await handleStuckGo({ event: goEvent(octavioTs), env: ENV, db, notion, fetchImpl: s.fetch, clock: () => NOW })).reason, 'on_hold');
  assert.match(s.posts.at(-1).text, /on hold/);
  notion.rows.get(ZED).sender.status = 'Sent';
  assert.equal((await handleStuckGo({ event: goEvent(zedTs), env: ENV, db, notion, fetchImpl: s.fetch, clock: () => NOW })).reason, 'not_stuck');
  assert.match(s.posts.at(-1).text, /Nothing to restart: Zed Park's rejection email is now "Sent"/);
  notion.rows.get(FINLEY).sender.hold = false; notion.rows.get(FINLEY).candidate.email = null;
  assert.equal((await handleStuckGo({ event: goEvent(octavioTs), env: ENV, db, notion, fetchImpl: s.fetch, clock: () => NOW })).reason, 'no_email');
  assert.equal(notion.rearmed.length, 0);
  assert.equal(await handleStuckGo({ event: goEvent('1792000000.000001'), env: ENV, db, notion, fetchImpl: s.fetch, clock: () => NOW }), null);
  assert.equal(isStuckGo(goEvent(octavioTs)), true);
  assert.equal(isStuckGo(goEvent(octavioTs, { text: 'Go.' })), true);
  assert.equal(isStuckGo(goEvent(octavioTs, { text: 'go\n*Sent using* <@U0A88TFE3RT|Claude>' })), true, 'a go sent from Project\'s Claude session carries the connector footer');
  assert.equal(isStuckGo(goEvent(octavioTs, { authorId: 'U0A4F08721B' })), false, 'only Project');
  assert.equal(isStuckGo(goEvent(octavioTs, { text: 'go ahead and wait' })), false, 'only a bare go');
  assert.equal(isStuckGo({ ...goEvent(octavioTs), threadTs: null }), false, 'only as a reply to the notice');
  assert.match(noticeText(row(ZED, 'Zed Park', {}, {})), /<https:\/\/www\.notion\.so\/6{8}6{4}46{3}86{3}6{12}\|Their record>$/);
});
