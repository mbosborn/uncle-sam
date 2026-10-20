import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { addressCandidates, temporaryPassword, fillAccountEmail, googleName, ACCOUNT_HOLD_MS } from '../service/lib/accounts.mjs';
import { askedScopes, ADMIN_USER_SCOPE } from '../service/lib/gmail.mjs';
import { runOnboarding, handleOnboardingReply } from '../service/lib/onboarding.mjs';

const TEMPLATE = 'Subject: Your Company AI accounts\n\nHi \\[First name\\],\n\nStarts [Start day]. Email: [Company email]\nPassword: [Temporary password]\nSlack: [Slack join link]';
function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}

test('Accounts: addresses, names, passwords and the email', () => {
  assert.deepEqual(addressCandidates('Rylan King ⭐'), ['rylan@company.example', 'rylan.king@company.example', 'rylank@company.example']);
  assert.deepEqual(addressCandidates('José Núñez (Mercor)'), ['jose@company.example', 'jose.nunez@company.example', 'josen@company.example']);
  assert.deepEqual(addressCandidates('Prince'), []);
  assert.deepEqual(googleName('Avery James Carter ⭐'), { givenName: 'Avery', familyName: 'James Carter' });
  const pw = temporaryPassword();
  assert.equal(pw.length, 16); assert.match(pw, /[A-Z]/); assert.match(pw, /[a-z]/); assert.match(pw, /[0-9]/); assert.doesNotMatch(pw, /[0O1lI]/);
  const email = fillAccountEmail(TEMPLATE, { firstName: 'Rylan', startDay: 'Mon Oct 19', address: 'rylan@company.example', password: 'Pw-123', joinUrl: 'https://join.example/x' });
  assert.equal(email.subject, 'Your Company AI accounts');
  assert.match(email.body, /^Hi Rylan,\n\nStarts Mon Oct 19\. Email: rylan@company\.example\nPassword: Pw-123\nSlack: https:\/\/join\.example\/x$/);
  assert.equal(fillAccountEmail(TEMPLATE.replace('Subject: ', 'Subject: DRAFT · '), { firstName: 'R', startDay: 'x', address: 'a', password: 'p', joinUrl: 'https://j' }), null, 'a draft is never sent');
  assert.equal(fillAccountEmail(`${TEMPLATE}\n[Manager name]`, { firstName: 'R', startDay: 'x', address: 'a', password: 'p', joinUrl: 'https://j' }), null, 'an unknown placeholder stops it');
  assert.ok(!askedScopes({}).includes(ADMIN_USER_SCOPE), 'the admin box is not asked for while off');
  assert.ok(askedScopes({ UNCLE_SAM_ACCOUNT_CREATION: 'on' }).includes(ADMIN_USER_SCOPE));
});

function world({ taken = [], createError = null } = {}) {
  const w = { posts: [], project: [], created: [], emails: [], notes: [], db: d1(), n: 0 };
  w.candidate = { pageId: '3f26ba36-8537-812b-9f29-c3980210a54b', fullName: 'Rylan King', email: 'rylanking@example.test', url: 'https://www.notion.so/x',
    fields: { Stage: 'Trial', Paperwork: 'Signed', 'Trial Start': '2026-10-19', 'Next action': '', 'Candidate brief': '' } };
  w.notion = { readControl: async () => ({ mode: 'Live' }), listTrialCandidates: async () => [w.candidate], getCandidate: async () => w.candidate,
    listCandidateNotes: async () => [], appendCandidateNote: async n => { w.notes.push(n); return { verified: true }; }, upsertOperationsRecord: async () => ({ verified: true }),
    getEmailTemplate: async () => TEMPLATE };
  w.fetch = async (url, init) => {
    if (url === 'https://slack.com/api/users.list') return Response.json({ ok: true, members: [] });
    const body = JSON.parse(init.body); const ts = `17922000${++w.n}.000100`; w.posts.push({ ...body, ts }); return Response.json({ ok: true, ts });
  };
  w.accounts = { missing: async () => [], joinUrl: 'https://join.example/x',
    admin: { exists: async a => taken.includes(a), create: async args => { if (createError) throw createError; w.created.push(args); return { primaryEmail: args.address }; } },
    gmail: { send: async m => { w.emails.push(m); return { url: 'https://mail.google.com/x' }; } } };
  w.run = now => runOnboarding({ env: { UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled', SLACK_BOT_TOKEN: 'xoxb-fixture-only', UNCLE_SAM_EMAIL_OWNER: 'jamie' }, db: w.db, notion: w.notion, fetchImpl: w.fetch, clock: () => now,
    routeMap: { jamie_group: { channelId: 'C0JAMIE001', type: 'mpim' }, aa_group: { channelId: 'C0AAGRP001', type: 'mpim' }, project: { channelId: 'D0MASON001', type: 'im' } },
    poster: async t => w.project.push(t), accounts: w.accounts });
  return w;
}
const T0 = Date.parse('2026-10-17T19:01:00Z');

test('Accounts on: a heads-up to Project, 30 minutes, then the account, the email and AA\'s Okta request; Jamie is not asked', async () => {
  const w = world({ taken: ['rylan@company.example'] });
  await w.run(T0);
  assert.equal(w.posts.length, 1);
  assert.equal(w.posts[0].channel, 'D0MASON001');
  assert.equal(w.posts[0].text, "🪖 Setting up Rylan King's Company email, Slack and Okta in 30 minutes.");
  await w.run(T0 + ACCOUNT_HOLD_MS - 60_000);
  assert.equal(w.created.length, 0);
  await w.run(T0 + ACCOUNT_HOLD_MS + 1000);
  assert.equal(w.created.length, 1);
  assert.equal(w.created[0].address, 'rylan.king@company.example');
  assert.equal(w.emails[0].to, 'rylanking@example.test');
  assert.ok(w.emails[0].body.includes(w.created[0].password), 'the email carries the one-time password');
  assert.ok(!JSON.stringify(w.notes).includes(w.created[0].password) && !w.project.join(' ').includes(w.created[0].password), 'never noted or posted');
  const aa = w.posts.find(p => p.channel === 'C0AAGRP001');
  assert.match(aa.text, /Their Company email is rylan\.king@company\.example\. Set up Okta\./);
  assert.ok(!w.posts.some(p => p.channel === 'C0JAMIE001'), 'Jamie is not asked');
  await w.run(T0 + 2 * ACCOUNT_HOLD_MS);
  assert.equal(w.created.length, 1, 'once');
});

test('Accounts on: Project\'s "stop" holds it and Jamie is asked; an unclear create stops everything', async () => {
  const w = world();
  await w.run(T0);
  const out = await handleOnboardingReply({ event: { channelId: 'D0MASON001', threadTs: w.posts[0].ts, messageTs: '1792200100.000100', authorId: 'U0F9EF97D89', text: 'stop' },
    env: { SLACK_BOT_TOKEN: 'xoxb-fixture-only' }, db: w.db, notion: w.notion, fetchImpl: w.fetch, clock: () => T0 + 60_000 });
  assert.equal(out.kind, 'account_held');
  await w.run(T0 + ACCOUNT_HOLD_MS + 1000);
  assert.equal(w.created.length, 0);
  assert.equal(w.posts.at(-1).channel, 'C0JAMIE001');
  const err = Object.assign(new Error('x'), { code: 'admin_create_network', uncertain: true });
  const w2 = world({ createError: err });
  await w2.run(T0); await w2.run(T0 + ACCOUNT_HOLD_MS + 1000); await w2.run(T0 + 2 * ACCOUNT_HOLD_MS);
  assert.match(w2.project.at(-1), /gave an unclear answer \(admin_create_network\)/);
  assert.ok(!w2.posts.some(p => p.channel === 'C0JAMIE001' || p.channel === 'C0AAGRP001'), 'no Jamie, no AA');
});

test('Accounts on but not set up: Project is told once what is missing and Jamie is asked as before', async () => {
  const w = world();
  w.accounts.missing = async () => ['the Slack join link'];
  await w.run(T0);
  assert.match(w.project[0], /^📯 Account creation is switched on, but I still need the Slack join link/);
  assert.equal(w.posts[0].channel, 'C0JAMIE001');
});

import { fillAccountEmail as fillAccount } from '../service/lib/accounts.mjs';
test('Slack: the join link goes in the accounts email; without a link that paragraph is left out', () => {
  const accounts = "Subject: Your Company AI accounts\n\nHi \\[First name\\],\n\nEmail: \\[Company email\\]\nTemporary password: \\[Temporary password\\]\n\nOnce you're signed in, join our Slack here: \\[Slack join link\\]\n\nAA will send Okta separately.";
  const withLink = fillAccount(accounts, { firstName: 'Arlen', startDay: 'Sat Oct 17', address: 'arlen@company.example', password: 'p', joinUrl: 'https://example-workspace.slack.com/signup' });
  assert.match(withLink.body, /join our Slack here: https:\/\/example-workspace\.slack\.com\/signup/);
  const without = fillAccount(accounts, { firstName: 'Arlen', startDay: 'Sat Oct 17', address: 'arlen@company.example', password: 'p', joinUrl: null });
  assert.ok(!/Slack/.test(without.body) && /AA will send Okta/.test(without.body));
});

test('Not signed but the dates agreed: Uncle Sam still makes the account, and the heads-up is the one paper warning; dates not agreed: asked, as before (Project, Oct 19)', async () => {
  const w = world();
  Object.assign(w.candidate.fields, { Paperwork: 'Sent', 'Trial End': '2026-10-21' });
  // 12 hours before a Pacific Monday start.
  await w.run(Date.parse('2026-10-18T19:30:00Z'));
  assert.equal(w.posts[0].text, "🪖 Rylan King starts in about 12 hours. Setting up their Company email, Slack and Okta now. Heads up: they still haven't signed.");
  await w.run(Date.parse('2026-10-18T19:30:00Z') + ACCOUNT_HOLD_MS + 1000);
  assert.equal(w.created.length, 1);
  const w2 = world();
  Object.assign(w2.candidate.fields, { Paperwork: 'Sent', 'Trial End': '2026-10-21', 'Candidate brief': "Pre Work Trial Mon Oct 19. Awaiting Rylan's confirmation of the dates." });
  await w2.run(Date.parse('2026-10-18T19:30:00Z'));
  assert.equal(w2.created.length, 0);
  assert.ok(!w2.posts.some(p => /Setting up .* Company email/.test(p.text)));
  assert.ok(w2.posts.some(p => /Company email/.test(p.text)), JSON.stringify(w2.posts.map(p => p.text)));
});
