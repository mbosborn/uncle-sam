import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ACCOUNT_HOLD_MS } from '../service/lib/accounts.mjs';
import { runOnboarding } from '../service/lib/onboarding.mjs';
import { handleCancelCommand, allWaiting, queuePacket } from '../service/lib/email-queue.mjs';
import { noticeStore } from '../service/lib/stuck-rejections.mjs';

const TEMPLATE = 'Subject: Your Company AI accounts\n\nHi \\[First name\\],\n\nStarts [Start day]. Email: [Company email]\nPassword: [Temporary password]\nSlack: [Slack join link]';
const PROJECT = 'U0F9EF97D89';
function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
function world({ fields = {}, directory = null } = {}) {
  const w = { posts: [], project: [], created: [], emails: [], notes: [], db: d1(), n: 0 };
  w.kv = noticeStore(w.db);
  w.candidate = { pageId: '3f26ba36-8537-812b-9f29-c3980210a54b', fullName: 'Rylan King', email: 'rylanking@example.test', url: 'https://www.notion.so/x',
    fields: { Stage: 'Trial', Outcome: 'Proceeding', Paperwork: 'Signed', 'Trial Start': '2026-10-19', 'Next action': '', 'Candidate brief': '', ...fields } };
  w.notion = { readControl: async () => ({ mode: 'Live' }), listTrialCandidates: async () => [w.candidate], getCandidate: async () => w.candidate,
    listCandidateNotes: async () => [], appendCandidateNote: async n => { w.notes.push(n); return { verified: true }; }, upsertOperationsRecord: async () => ({ verified: true }),
    getEmailTemplate: async () => TEMPLATE };
  w.fetch = async (url, init) => {
    if (url === 'https://slack.com/api/users.list') return Response.json({ ok: true, members: [] });
    const body = JSON.parse(init.body); const ts = `17922000${++w.n}.000100`; w.posts.push({ ...body, ts }); return Response.json({ ok: true, ts });
  };
  w.accounts = { missing: async () => [], joinUrl: 'https://join.example/x',
    admin: { exists: async () => false, create: async args => { w.created.push(args); return { primaryEmail: args.address }; } },
    gmail: { send: async m => { w.emails.push(m); return { url: 'https://mail.google.com/x' }; } } };
  w.run = now => runOnboarding({ env: { UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled', SLACK_BOT_TOKEN: 'xoxb-fixture-only', UNCLE_SAM_EMAIL_OWNER: 'jamie' }, db: w.db, notion: w.notion, fetchImpl: w.fetch, clock: () => now,
    routeMap: { jamie_group: { channelId: 'C0JAMIE001', type: 'mpim' }, aa_group: { channelId: 'C0AAGRP001', type: 'mpim' }, project: { channelId: 'D0MASON001', type: 'im' } },
    poster: async t => w.project.push(t), accounts: w.accounts, ...(directory ? { directory } : {}) });
  return w;
}
const T0 = Date.parse('2026-10-17T19:01:00Z');
const UNSIGNED_T = Date.parse('2026-10-18T19:30:00Z'); // 12 hours before a Pacific Monday start
const headsUp = w => w.posts.filter(p => /Company email, Slack/.test(p.text));

test('Accounts email holds (#3): On Hold or a pay concern at proposal -> nothing, Project told once; held by create time -> no account, proposed afresh once cleared', async () => {
  const w = world({ fields: { Outcome: 'On Hold' } });
  await w.run(T0); await w.run(T0 + ACCOUNT_HOLD_MS + 1000);
  assert.equal(headsUp(w).length + w.created.length + w.emails.length, 0);
  assert.deepEqual(w.project, ["📋 I didn't send Rylan's Company accounts email: they are On Hold. It goes once that is cleared."]);
  const w2 = world();
  await w2.run(T0);
  assert.equal(headsUp(w2).length, 1);
  await w2.kv.put(`trialterms:hold:${w2.candidate.pageId}`, { at: T0 }, T0);
  await w2.run(T0 + ACCOUNT_HOLD_MS + 1000);
  assert.equal(w2.created.length + w2.emails.length, 0);
  assert.match(w2.project.at(-1), /Company accounts email: they pushed back on the pay/);
  await w2.kv.del(`trialterms:hold:${w2.candidate.pageId}`);
  await w2.run(T0 + 2 * ACCOUNT_HOLD_MS);
  assert.equal(headsUp(w2).length, 2, 'a fresh heads-up');
  assert.equal(w2.created.length, 0);
  await w2.run(T0 + 3 * ACCOUNT_HOLD_MS + 1000);
  assert.equal(w2.created.length, 1);
  assert.equal(w2.emails.length, 1);
});

test('Accounts after the documents (#4): not signed and the documents not out (or still in their queue) -> no accounts, Project told once', async () => {
  const w = world({ fields: { Paperwork: 'Not Sent', 'Trial End': '2026-10-21' } });
  await w.run(UNSIGNED_T); await w.run(UNSIGNED_T + 600_000);
  assert.equal(headsUp(w).length + w.created.length, 0);
  assert.deepEqual(w.project, ["📋 I'm not setting up Rylan King's Company accounts yet: their work trial documents haven't gone out. They go once the documents are sent."]);
  const w2 = world({ fields: { Paperwork: 'Sent', 'Trial End': '2026-10-21' } });
  await queuePacket({ db: w2.db, who: { pageId: w2.candidate.pageId, fullName: 'Rylan King', email: 'r@x.com' }, rate: 100, clock: () => UNSIGNED_T });
  await w2.run(UNSIGNED_T);
  assert.equal(headsUp(w2).length, 0, 'documents still waiting in the queue');
  const w3 = world({ fields: { Paperwork: 'Sent', 'Trial End': '2026-10-21' } });
  await w3.run(UNSIGNED_T);
  assert.equal(headsUp(w3).length, 1, 'documents out: go ahead');
  w3.candidate.fields.Paperwork = 'Not Sent'; // voided before the account is made
  await w3.run(UNSIGNED_T + ACCOUNT_HOLD_MS + 1000);
  assert.equal(w3.created.length, 0);
});

test('"cancel Rylan" stops a waiting accounts email (#2); too late once it is being made', async () => {
  const w = world();
  await w.run(T0);
  const waiting = await allWaiting({ db: w.db });
  assert.deepEqual(waiting.map(x => [x.name, x.items.map(i => i.kind)]), [['Rylan King', ['Company accounts email']]]);
  const replies = [];
  const ev = { authorId: PROJECT, text: 'cancel Rylan', channelId: 'D0MASON001', messageTs: '1.1' };
  const out = await handleCancelCommand({ event: ev, db: w.db, findCandidate: async () => ({ pageId: w.candidate.pageId }), poster: () => async t => replies.push(t), masonId: PROJECT, clock: () => T0 + 60_000 });
  assert.equal(out.kind, 'email_cancel');
  assert.equal(replies[0], "🛑 Cancelled. Rylan's Company accounts email won't go out.");
  const before = w.posts.length;
  await w.run(T0 + ACCOUNT_HOLD_MS + 1000); await w.run(T0 + 2 * ACCOUNT_HOLD_MS);
  assert.equal(w.created.length + w.emails.length, 0);
  assert.equal(w.posts.length, before, 'no one is asked to make it by hand');
  assert.equal(w.project.length, 0);
  assert.equal((await allWaiting({ db: w.db })).length, 0);
});

test('A Company account already made by hand (#6): none is made, no accounts email, Project told once; their address is used', async () => {
  const w = world({ directory: async () => ['rylan@company.example'] });
  await w.run(T0); await w.run(T0 + ACCOUNT_HOLD_MS + 1000); await w.run(T0 + 2 * ACCOUNT_HOLD_MS);
  assert.equal(headsUp(w).length + w.created.length + w.emails.length, 0);
  assert.equal(w.project.filter(t => /already has a Company account/.test(t)).length, 1);
  assert.equal(w.project[0], "🪖 Rylan King already has a Company account (rylan@company.example), so I won't make one or send the accounts email.");
  const state = await w.kv.get(`onboarding:${w.candidate.pageId}`);
  assert.equal(state.address, 'rylan@company.example');
  // The directory unreadable (null): as before.
  const w2 = world({ directory: async () => null });
  await w2.run(T0);
  assert.equal(headsUp(w2).length, 1);
});
