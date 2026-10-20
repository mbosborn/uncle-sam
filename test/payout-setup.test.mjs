import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runPayoutSetup, handlePayoutRequest, createStripeOnboarder, fillPayoutEmail, payoutConfigured } from '../service/lib/payout-setup.mjs';
import { parseTemplate } from '../service/lib/takehome-review.mjs';
import { noticeStore } from '../service/lib/stuck-rejections.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const NOW = Date.parse('2026-10-20T18:00:00Z');
const ENV = { UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled', STRIPE_API_KEY: 'rk_live_' + 'a'.repeat(30), STRIPE_ONBOARDING_KEY: 'rk_live_' + 'b'.repeat(30) };
const TEMPLATE = `Subject: Company AI - Work Trial Payment Setup

Hi {{first_name}},

Great having you on the work trial. So we can pay you out after your work trial, please set up your payout details through Stripe here:

{{payout_link}}

It only takes a few minutes. If you run into any issues, just let me know.`;
const OK_KEY = { probe: async () => 'ok' };
const person = (over = {}) => ({ pageId: '3f26ba36-8537-8000-8000-0000000000a1', fullName: 'Priya Shah ⭐', email: 'priya@example.com', fields: { 'First check-in done': true, Outcome: 'Proceeding', ...over } });

test('Payout setup (Project, 2026-10-20): after the first check-in, once, from Project\'s Gmail, with their own link; never for someone with a Stripe account or a pay concern', async () => {
  const db = d1(), sent = [], said = [];
  const list = [person(), person({ 'First check-in done': false }), { ...person(), pageId: 'p-has-stripe', email: 'has@example.com' }, { ...person(), pageId: 'p-held', email: 'held@example.com' }];
  await noticeStore(db).put('trialterms:hold:p-held', { at: NOW }, NOW);
  const notion = { readControl: async () => ({ mode: 'Live' }), listTierCandidates: async () => list, getEmailTemplate: async () => TEMPLATE, appendCandidateNote: async () => ({}) };
  const gmail = { send: async m => { sent.push(m); return { id: 'm1', url: 'https://mail/x' }; } };
  const reader = { accounts: async () => [{ id: 'acct_1', emails: ['has@example.com'] }] };
  const run = now => runPayoutSetup({ env: ENV, onboarder: OK_KEY, db, notion, gmail, parseTemplate, reader, poster: async t => said.push(t), clock: () => now, force: true });
  // First run: queued for 30 minutes, said once as done; nothing sent yet.
  assert.equal((await run(NOW)).sent, 0);
  assert.equal(sent.length, 0);
  assert.match(said[0], /Sending Priya the payout setup email/);
  const out = await run(NOW + 31 * 60_000);
  assert.equal(out.sent, 1, JSON.stringify(out));
  assert.equal(sent[0].to, 'priya@example.com');
  assert.equal(sent[0].subject, 'Company AI - Work Trial Payment Setup');
  assert.match(sent[0].body, /^Hi Priya,/);
  assert.match(sent[0].body, /So we can pay you out after your work trial/);
  assert.match(sent[0].body, /https:\/\/your-project\.example\.com\/api\/payout\?t=[0-9a-f]{48}/);
  assert.equal(said.filter(t => !/didn't send/.test(t)).length, 1, 'nothing more said when it goes');
  assert.deepEqual(said.filter(t => /didn't send/.test(t)), ["📋 I didn't send Priya's payout setup email: they pushed back on the pay and haven't had an answer. It goes once that is cleared."], 'the held one: Project told once');
  await run(NOW + 3 * 3600_000);
  assert.equal(sent.length, 1, 'never twice');
  assert.equal(payoutConfigured({ ...ENV, STRIPE_ONBOARDING_KEY: 'sk_live_' + 'c'.repeat(30) }), false, 'a full secret key is refused');
  assert.equal(fillPayoutEmail(parseTemplate(TEMPLATE.replace('{{payout_link}}', 'this link')), { firstName: 'Priya', link: 'https://x' }), null);
});

test('Payout link: country first, the account made once, then straight on to Stripe; the onboarder can only create accounts and links', async () => {
  const db = d1(), kv = noticeStore(db), t = 'a'.repeat(48);
  await kv.put(`payout:token:${t}`, { pageId: 'p1', email: 'priya@example.com', name: 'Priya Shah ⭐', at: NOW }, NOW);
  const made = [], links = [];
  const onboarder = { payableCountries: async () => ['US', 'IN', 'NL'], createAccount: async a => { made.push(a); return 'acct_new'; }, onboardingLink: async a => { links.push(a); return 'https://connect.stripe.com/setup/e/xyz'; } };
  const reader = { countrySpecs: async () => ['IN', 'NL', 'US'] };
  const call = (method, body = null, qs = `t=${t}`) => handlePayoutRequest({ env: ENV, db, reader, onboarder, clock: () => NOW,
    request: new Request(`https://your-project.example.com/api/payout?${qs}`, { method, ...(body ? { body, headers: { 'content-type': 'application/x-www-form-urlencoded' } } : {}) }) });
  const page = await call('GET');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<option value="IN">India<\/option>/);
  const go = await call('POST', `t=${t}&country=IN`);
  assert.equal(go.status, 303);
  assert.equal(go.headers.get('location'), 'https://connect.stripe.com/setup/e/xyz');
  assert.deepEqual(made[0], { country: 'IN', email: 'priya@example.com', firstName: 'Priya', lastName: 'Shah', pageId: 'p1' });
  assert.match(links[0].returnUrl, /&done=1$/);
  // Again later: the same account, a fresh link, no second account.
  assert.equal((await call('GET')).status, 303);
  assert.equal(made.length, 1);
  assert.equal((await call('GET', null, 't=' + 'b'.repeat(48))).status, 404);
  assert.match(await (await call('GET', null, `t=${t}&done=1`)).text(), /all set/);
  // By construction: no path but the two.
  const calls = [];
  const real = createStripeOnboarder({ env: ENV, fetchImpl: async (url, init) => { calls.push([url, init.method]); return Response.json({ id: 'acct_x', url: 'https://connect.stripe.com/x' }); } });
  await real.createAccount({ country: 'NL', email: 'a@b.c', pageId: 'p' });
  await real.onboardingLink({ account: 'acct_x', refreshUrl: 'https://r', returnUrl: 'https://d' });
  assert.deepEqual(calls.map(c => c[0]), ['https://api.stripe.com/v1/accounts', 'https://api.stripe.com/v1/account_links']);
});

test('Stripe reminder (Project, 2026-10-20): 24 hours after the setup email, once, as a reply in its thread, only if they still have no payout details', async () => {
  const db = d1(), sent = [];
  const REM = `Subject: Re: Company AI - Work Trial Payment Setup

Hi {{first_name}},

A quick reminder to set up your payout details through Stripe so we can pay you after your work trial:

{{payout_link}}

It only takes a few minutes.`;
  const c = person();
  const notion = { readControl: async () => ({ mode: 'Live' }), listTierCandidates: async () => [c], getCandidate: async () => c, getEmailTemplate: async id => (id === 'd41f8631-8bd5-456b-a7df-c24036d12eb1' ? REM : TEMPLATE), appendCandidateNote: async () => ({}) };
  const gmail = { send: async m => { sent.push(m); return { id: `m${sent.length}`, url: 'https://mail/x' }; } };
  let accounts = [];
  const reader = { accounts: async () => accounts };
  const run = now => runPayoutSetup({ env: ENV, onboarder: OK_KEY, db, notion, gmail, parseTemplate, reader, poster: async () => {}, clock: () => now, force: true });
  await run(NOW); await run(NOW + 31 * 60_000);
  assert.equal(sent.length, 1);
  await run(NOW + 20 * 3600_000);
  assert.equal(sent.length, 1, 'not before 24 hours');
  await run(NOW + 25 * 3600_000);
  assert.equal(sent.length, 1, 'the reminder waits its 30 minutes too');
  await run(NOW + 25 * 3600_000 + 31 * 60_000);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].replyTo, 'm1');
  assert.equal(sent[1].subject, 'Re: Company AI - Work Trial Payment Setup');
  assert.match(sent[1].body, /^Hi Priya,\n\nA quick reminder/);
  assert.equal(sent[1].body.match(/api\/payout\?t=([0-9a-f]+)/)[1], sent[0].body.match(/api\/payout\?t=([0-9a-f]+)/)[1], 'the same link');
  await run(NOW + 60 * 3600_000);
  assert.equal(sent.length, 2, 'once');
  // Someone who set it up gets no reminder.
  const db2 = d1(), sent2 = [];
  const run2 = now => runPayoutSetup({ env: ENV, onboarder: OK_KEY, db: db2, notion, gmail: { send: async m => { sent2.push(m); return { id: 'x1' }; } }, parseTemplate,
    reader: { accounts: async () => accounts }, poster: async () => {}, clock: () => now, force: true });
  accounts = [];
  await run2(NOW); await run2(NOW + 31 * 60_000);
  accounts = [{ id: 'acct_1', emails: ['priya@example.com'], detailsSubmitted: true }];
  await run2(NOW + 25 * 3600_000);
  assert.equal(sent2.length, 1);
});
