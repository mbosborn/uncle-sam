import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runOnboarding, syncAccessChecks, handleOnboardingReply, windowOpensAt, candidateAddress, saysDone, jamieText, aaText } from '../service/lib/onboarding.mjs';

const ENV = Object.freeze({ UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled', SLACK_BOT_TOKEN: 'xoxb-fixture-only', UNCLE_SAM_EMAIL_OWNER: 'jamie' });
const ROUTES = Object.freeze({ jamie_group: { channelId: 'C0JAMIE001', type: 'mpim' }, aa_group: { channelId: 'C0AAGRP001', type: 'mpim' }, project: { channelId: 'D0MASON001', type: 'im' } });
const PAGE = '3f26ba36-8537-812b-9f29-c3980210a54b';
const at = iso => Date.parse(iso);
function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const person = (fields = {}) => ({ pageId: PAGE, fullName: 'Rylan King ⭐', email: 'rylanking@example.test', url: 'https://www.notion.so/x',
  fields: { Stage: 'Trial', Paperwork: 'Signed', 'Trial Start': '2026-10-19', 'Trial End': '2026-10-21', 'Next action': 'Trial Oct 19–21.', 'Candidate brief': '', ...fields } });
function world(candidate, { members = [], notes = [], failPost = false } = {}) {
  const w = { posts: [], notes: [], members: [...members], n: 0 };
  w.notion = { readControl: async () => ({ mode: 'Live' }), listTrialCandidates: async () => [candidate], getCandidate: async () => candidate,
    listCandidateNotes: async () => notes, appendCandidateNote: async n => { w.notes.push(n); return { verified: true }; }, upsertOperationsRecord: async () => ({ verified: true }) };
  w.fetch = async (url, init) => {
    if (url === 'https://slack.com/api/users.list') return Response.json({ ok: true, members: w.members, response_metadata: { next_cursor: '' } });
    assert.equal(url, 'https://slack.com/api/chat.postMessage');
    if (failPost) return Response.json({ ok: false, error: 'channel_not_found' });
    const body = JSON.parse(init.body);
    const ts = `17921${String(++w.n).padStart(5, '0')}.000100`;
    w.posts.push({ ...body, ts });
    return Response.json({ ok: true, ts });
  };
  w.project = [];
  w.run = (now, extra = {}) => runOnboarding({ env: { ...ENV, ...(extra.env ?? {}) }, db: w.db, notion: w.notion, routeMap: ROUTES, fetchImpl: w.fetch, clock: () => now,
    claude: extra.claude ?? null, poster: async t => w.project.push(t) });
  w.db = d1();
  return w;
}
const evidence = input => ({ async complete() { return { content: [{ type: 'tool_use', name: 'evidence', input }] }; } });

test('Onboarding: the window opens at noon Pacific two days before the trial', () => {
  assert.equal(new Date(windowOpensAt('2026-10-19')).toISOString(), '2026-10-17T19:00:00.000Z');
  assert.equal(new Date(windowOpensAt('2026-11-04')).toISOString(), '2026-11-02T20:00:00.000Z', 'after the clocks change');
});

test('Onboarding: signed a week early, Jamie is asked only 48 hours before the start (Project, 2026-10-18), once; AA waits for her', async () => {
  const w = world(person());
  await w.run(at('2026-10-12T18:00:00Z'));
  await w.run(at('2026-10-17T06:55:00Z'));
  assert.equal(w.posts.length, 0, 'nothing before 48 hours ahead of midnight PT Oct 19');
  await w.run(at('2026-10-17T07:01:00Z'));
  assert.equal(w.posts.length, 1);
  assert.equal(w.posts[0].channel, 'C0JAMIE001');
  assert.equal(w.posts[0].text, jamieText({ name: 'Rylan King', email: 'rylanking@example.test', start: '2026-10-19', now: at('2026-10-17T07:01:00Z') }));
  assert.match(w.posts[0].text, /^🪖 Jamie: Rylan King reports for a work trial on Mon Oct 19\. Paperwork is signed\. Set up their Company email \(invite rylanking@example\.test\) and add them to Slack\./);
  assert.doesNotMatch(w.posts[0].text, /\$|Okta|!/, 'only what Jamie needs, no pay, no exclamation');
  await w.run(at('2026-10-17T07:10:00Z'));
  assert.equal(w.posts.length, 1, 'never a second request; AA waits for Jamie');
  assert.match(w.notes[0].text, /asked Jamie/);
});

test('Onboarding: not signed, the accounts come 12 hours before the start anyway (Project, 2026-10-18)', async () => {
  const w = world(person({ Paperwork: 'Sent' }));
  await w.run(at('2026-10-18T18:55:00Z'));
  assert.equal(w.posts.length, 0, 'more than 12 hours before midnight PT Oct 19');
  await w.run(at('2026-10-18T19:01:00Z'));
  assert.equal(w.posts.length, 1);
  assert.match(w.posts[0].text, /^🪖 Jamie: Rylan King reports for a work trial tomorrow \(Mon Oct 19\)\. Their paperwork isn't signed yet\. Set up their Company email/);
});

test('Onboarding: paperwork not signed (more than 12 hours out), no start date, or a trial that began before today: nothing', async () => {
  for (const c of [person({ Paperwork: 'Sent' }), person({ 'Trial Start': null }), person({ 'Trial Start': '2026-10-15' })]) {
    const w = world(c);
    await w.run(at('2026-10-16T18:00:00Z'));
    assert.equal(w.posts.length, 0);
  }
});

test('Onboarding: signed inside the window (the day before), Jamie is asked at once and told it is tomorrow', async () => {
  const w = world(person());
  await w.run(at('2026-10-18T20:00:00Z'));
  assert.equal(w.posts.length, 1);
  assert.match(w.posts[0].text, /reports for a work trial tomorrow \(Mon Oct 19\)/);
});

test('Onboarding: Jamie\'s "done" with the address in the thread sends AA the Okta request with it, once', async () => {
  const c = person(), w = world(c);
  await w.run(at('2026-10-17T19:01:00Z'));
  const reply = { source: 'slack', type: 'message', channelId: 'C0JAMIE001', threadTs: w.posts[0].ts, messageTs: '1792200000.000200', authorId: 'U0CB213D6D6',
    text: 'done, his email is <mailto:rylan@company.example|rylan@company.example> and slack invite sent' };
  const handled = await handleOnboardingReply({ event: reply, env: ENV, db: w.db, notion: w.notion, fetchImpl: w.fetch, clock: () => at('2026-10-17T20:00:00Z') });
  assert.equal(handled.kind, 'onboarding_jamie_done');
  assert.equal(w.posts.at(-1).thread_ts, w.posts[0].ts);
  assert.match(w.posts.at(-1).text, /^Roger that 🫡 Passing rylan@company\.example to AA for Okta\.$/);
  assert.match(w.notes.at(-1).text, /Jamie on the work-trial email\/Slack request: “done, his email is rylan@company\.example/);
  await w.run(at('2026-10-17T20:05:00Z'));
  const aa = w.posts.at(-1);
  assert.equal(aa.channel, 'C0AAGRP001');
  assert.equal(aa.text, '🔐 AA: Rylan King reports for a work trial on Mon Oct 19. Their Company email is rylan@company.example. Set up Okta. Reply here when it\'s done.');
  const count = w.posts.length;
  await w.run(at('2026-10-17T20:10:00Z'));
  assert.equal(w.posts.length, count, 'AA is asked once');
  const aaReply = { ...reply, channelId: 'C0AAGRP001', threadTs: aa.ts, messageTs: '1792200100.000200', authorId: 'U0BF89D1279', text: 'okta done' };
  assert.equal((await handleOnboardingReply({ event: aaReply, env: ENV, db: w.db, notion: w.notion, fetchImpl: w.fetch, clock: () => at('2026-10-17T21:00:00Z') })).kind, 'onboarding_okta_done');
  assert.match(w.posts.at(-1).text, /^Roger that 🫡 Okta done for Rylan King\.$/);
});

test('Onboarding: "will do later" or a question is noted but is not done; a thread that is not a request is left to the usual lanes', async () => {
  const w = world(person());
  await w.run(at('2026-10-17T19:01:00Z'));
  for (const text of ['will do later today', 'is it rylan or robin?', 'not yet']) {
    const out = await handleOnboardingReply({ event: { channelId: 'C0JAMIE001', threadTs: w.posts[0].ts, messageTs: `1792200${text.length}.000200`, authorId: 'U0CB213D6D6', text }, env: ENV, db: w.db, notion: w.notion, fetchImpl: w.fetch, clock: () => at('2026-10-17T20:00:00Z') });
    assert.equal(out.kind, 'no_action');
  }
  assert.equal(w.posts.length, 1, 'no reply, no AA');
  assert.equal(await handleOnboardingReply({ event: { channelId: 'C0JAMIE001', threadTs: '1700000000.000100', messageTs: '1700000001.000100', authorId: 'U0CB213D6D6', text: 'done' }, env: ENV, db: w.db, notion: w.notion, fetchImpl: w.fetch }), null);
});

test('Onboarding: the candidate joining Company Slack counts as Jamie done; AA gets their Slack member', async () => {
  const w = world(person(), { members: [{ id: 'U0OLD0001', real_name: 'Robin Cooper' }] });
  await w.run(at('2026-10-17T19:01:00Z'));
  w.members.push({ id: 'U0RISHY01', real_name: 'Rylan King', profile: { display_name: 'rylan' } });
  await w.run(at('2026-10-17T22:00:00Z'));
  assert.equal(w.posts.at(-1).channel, 'C0AAGRP001');
  assert.match(w.posts.at(-1).text, /Their Company email is set up and they're in Slack as <@U0RISHY01>\. Set up Okta\./);
});

test('Onboarding: a record that already says the email and Slack are set up skips Jamie and goes straight to AA; Okta done skips AA', async () => {
  const c = person({ 'Candidate brief': 'Oct 15: Company email/Slack set up per Jamie OOO.' });
  const w = world(c);
  await w.run(at('2026-10-17T19:01:00Z'), { claude: evidence({ email_ready: true, email_quote: 'Company email/Slack set up per Jamie', okta_ready: false }) });
  assert.equal(w.posts.length, 1);
  assert.equal(w.posts[0].channel, 'C0AAGRP001');
  const w2 = world(person({ 'Candidate brief': 'Company email/Slack set up per Jamie. AA: Okta is set up.' }));
  await w2.run(at('2026-10-17T19:01:00Z'), { claude: evidence({ email_ready: true, email_quote: 'Company email/Slack set up per Jamie', okta_ready: true, okta_quote: 'AA: Okta is set up' }) });
  assert.equal(w2.posts.length, 0);
  const w3 = world(person({ 'Candidate brief': 'Jamie to set up Company email.' }));
  await w3.run(at('2026-10-17T19:01:00Z'), { claude: evidence({ email_ready: true, email_quote: 'Company email and Slack are created', okta_ready: false }) });
  assert.equal(w3.posts[0].channel, 'C0JAMIE001', 'an invented quote counts for nothing');
});

test('Onboarding: with UNCLE_SAM_OKTA_WITH_JAMIE=on both go at once, and the address follows in AA\'s thread', async () => {
  const w = world(person());
  const env = { UNCLE_SAM_OKTA_WITH_JAMIE: 'on' };
  await w.run(at('2026-10-17T19:01:00Z'), { env });
  assert.deepEqual(w.posts.map(p => p.channel), ['C0JAMIE001', 'C0AAGRP001']);
  assert.match(w.posts[1].text, /Jamie is setting up their Company email; I'll post the address here once I have it\. Set up Okta\./);
  await handleOnboardingReply({ event: { channelId: 'C0JAMIE001', threadTs: w.posts[0].ts, messageTs: '1792200000.000200', authorId: 'U0CB213D6D6', text: 'rylan@company.example is live' }, env: ENV, db: w.db, notion: w.notion, fetchImpl: w.fetch, clock: () => at('2026-10-17T20:00:00Z') });
  await w.run(at('2026-10-17T20:05:00Z'), { env });
  const last = w.posts.at(-1);
  assert.equal(last.thread_ts, w.posts[1].ts);
  assert.equal(last.text, "📡 Rylan King's Company address is rylan@company.example. Use it for Okta.");
  await w.run(at('2026-10-17T20:10:00Z'), { env });
  assert.equal(w.posts.at(-1), last, 'once');
});

test('Onboarding: a failed post is never retried; Project is told once', async () => {
  const w = world(person(), { failPost: true });
  await w.run(at('2026-10-17T19:01:00Z'));
  await w.run(at('2026-10-17T19:10:00Z'));
  assert.equal(w.project.length, 1);
  assert.match(w.project[0], /could not post Jamie's account request for Rylan King/);
});

test('Onboarding: Off, Test, the switch, or missing group DMs do nothing', async () => {
  const w = world(person());
  w.notion.readControl = async () => ({ mode: 'Test' });
  assert.equal((await w.run(at('2026-10-17T19:01:00Z'))).state, 'not_live');
  w.notion.readControl = async () => ({ mode: 'Live' });
  assert.equal((await w.run(at('2026-10-17T19:01:00Z'), { env: { UNCLE_SAM_ONBOARDING: 'off' } })).state, 'off');
  const none = await runOnboarding({ env: ENV, db: w.db, notion: w.notion, routeMap: {}, fetchImpl: w.fetch, clock: () => at('2026-10-17T19:01:00Z') });
  assert.equal(none.state, 'no_routes');
  assert.equal(w.posts.length, 0);
});

test('Onboarding: helpers — the candidate\'s own Company address only, and what counts as done', () => {
  assert.equal(candidateAddress('jamie@company.example set up rylan.k@company.example', 'Rylan King ⭐'), 'rylan.k@company.example');
  assert.equal(candidateAddress('cc project@company.example', 'Rylan King'), null);
  assert.equal(candidateAddress('arlen@company.example', 'Rylan King'), null, 'someone else\'s address');
  for (const t of ['done', 'his email is setup', 'created + slack invite sent', 'all set']) assert.ok(saysDone(t), t);
  for (const t of ['will do', 'not done yet', 'can you resend?', "haven't set it up"]) assert.ok(!saysDone(t), t);
  assert.match(aaText({ name: 'A B', start: '2026-10-17', now: at('2026-10-17T16:00:00Z') }), /today \(Sat Oct 17\)/);
});

test('Onboarding: the tier list access boxes are ticked from what is set up, once each, never AWS', async () => {
  const { noticeStore } = await import('../service/lib/stuck-rejections.mjs');
  const kv = noticeStore(d1()), now = at('2026-10-20T18:00:00Z');
  const c = person({ 'Gmail access': false, 'Slack access': false, 'Okta access': false, 'Insightful access': false, 'AWS access': false });
  await kv.put(`onboarding:${PAGE}`, { address: 'rylan@company.example', jamieDone: { via: 'record' }, okta: { reason: 'created' }, insightful: { reason: 'unassigned' } }, now);
  const calls = [];
  const notion = { setAccessChecks: async a => { calls.push(a.checks); return { verified: true }; } };
  const fetchImpl = async () => Response.json({ ok: true, members: [{ id: 'U1', profile: { email: 'Rylan@company.example' } }], response_metadata: { next_cursor: '' } });
  assert.equal(await syncAccessChecks({ env: ENV, kv, notion, fetchImpl, now, candidates: [c] }), 3);
  assert.deepEqual(calls, [['Gmail access', 'Okta access', 'Slack access']]);
  assert.equal(await syncAccessChecks({ env: ENV, kv, notion, fetchImpl, now: now + 3600_000, candidates: [c] }), 0);
  await kv.put(`onboarding:${PAGE}`, { address: 'rylan@company.example', insightful: { reason: 'created' } }, now);
  assert.equal(await syncAccessChecks({ env: ENV, kv, notion, fetchImpl, now: now + 7200_000, candidates: [c] }), 1);
  assert.deepEqual(calls.at(-1), ['Insightful access']);
  assert.ok(calls.flat().every(n => n !== 'AWS access'));
});
