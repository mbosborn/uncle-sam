import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { matchingAccounts, createDirectoryFinder } from '../service/lib/directory.mjs';
import { runOnboarding } from '../service/lib/onboarding.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const person = (name, email) => ({ names: [{ displayName: name }], emailAddresses: [{ value: email }] });

test('Directory: only Company addresses of people whose name carries every part of the hire\'s name', () => {
  const people = [person('Rylan King', 'rylan@company.example'), person('Robin Cooper', 'robin@company.example'),
    person('Rylan King', 'rylanking@example.test'), person('Arlen Archer', 'arlen@company.example')];
  assert.deepEqual(matchingAccounts(people, 'Rylan King ⭐'), ['rylan@company.example']);
  assert.deepEqual(matchingAccounts(people, 'Rylan'), [], 'a single name is never enough');
});

test('Directory: without the directory grant the finder answers null and calls nothing', async () => {
  let called = 0;
  const find = createDirectoryFinder({ env: {}, db: d1(), fetchImpl: async () => { called++; return Response.json({}); } });
  assert.equal(await find('Rylan King'), null);
  assert.equal(called, 0);
});

test('Onboarding: the hire\'s new account in Company\'s directory counts as Jamie done; AA gets the address', async () => {
  const candidate = { pageId: '3f26ba36-8537-812b-9f29-c3980210a54b', fullName: 'Rylan King', email: 'rylanking@example.test', url: 'https://www.notion.so/x',
    fields: { Stage: 'Trial', Paperwork: 'Signed', 'Trial Start': '2026-10-19', 'Next action': '', 'Candidate brief': '' } };
  const posts = [];
  const notion = { readControl: async () => ({ mode: 'Live' }), listTrialCandidates: async () => [candidate], getCandidate: async () => candidate,
    listCandidateNotes: async () => [], appendCandidateNote: async () => ({ verified: true }), upsertOperationsRecord: async () => ({ verified: true }) };
  const fetchImpl = async (url, init) => {
    if (url === 'https://slack.com/api/users.list') return Response.json({ ok: true, members: [] });
    const body = JSON.parse(init.body); posts.push(body); return Response.json({ ok: true, ts: `17922000${posts.length}.000100` });
  };
  let accounts = [];
  const db = d1();
  const run = now => runOnboarding({ env: { UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled', SLACK_BOT_TOKEN: 'xoxb-fixture-only' }, db, notion,
    routeMap: { jamie_group: { channelId: 'C0JAMIE001', type: 'mpim' }, aa_group: { channelId: 'C0AAGRP001', type: 'mpim' } }, fetchImpl, clock: () => now,
    directory: async () => accounts });
  await run(Date.parse('2026-10-17T19:01:00Z'));
  assert.deepEqual(posts.map(p => p.channel), ['C0JAMIE001']);
  await run(Date.parse('2026-10-17T19:06:00Z'));
  assert.equal(posts.length, 1, 'no account yet: AA waits');
  accounts = ['rylan@company.example'];
  await run(Date.parse('2026-10-17T19:11:00Z'));
  assert.equal(posts.at(-1).channel, 'C0AAGRP001');
  assert.match(posts.at(-1).text, /Their Company email is rylan@company\.example\. Set up Okta\./);
});
