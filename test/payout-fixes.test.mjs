import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runPayoutSetup, createStripeOnboarder, onboardingKeyWorks, stripeStatusOf, alreadyPaid } from '../service/lib/payout-setup.mjs';
import { allWaiting, handleCancelCommand, HOLD_MS } from '../service/lib/email-queue.mjs';
import { parseTemplate } from '../service/lib/takehome-review.mjs';
import { noticeStore } from '../service/lib/stuck-rejections.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const NOW = Date.parse('2026-10-20T18:00:00Z');
const MIN = 60_000, HOUR = 3600_000;
const ENV = { UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled', STRIPE_API_KEY: 'rk_live_' + 'a'.repeat(30), STRIPE_ONBOARDING_KEY: 'rk_live_' + 'b'.repeat(30) };
const SETUP = 'Subject: Company AI - Work Trial Payment Setup\n\nHi {{first_name}},\n\nSet up here: {{payout_link}}\n\nThanks';
const REMIND = 'Subject: Re: Company AI - Work Trial Payment Setup\n\nHi {{first_name}},\n\nA reminder: {{payout_link}}\n\nThanks';
const PID = '3f26ba36-8537-8000-8000-0000000000a1';
const PROJECT = 'U0F9EF97D89';

function world({ fields = {}, accounts = [], probe = async () => 'ok', mode = 'Live', sendError = null } = {}) {
  const w = { db: d1(), sent: [], said: [], probes: 0, accounts, mode, sendError };
  w.kv = noticeStore(w.db);
  w.c = { pageId: PID, fullName: 'Priya Shah', email: 'priya@example.com', fields: { 'First check-in done': true, Stage: 'Trial', Outcome: 'Proceeding', 'Payment Status': 'Actively in Trial', ...fields } };
  w.notion = { readControl: async () => ({ mode: w.mode }), listTierCandidates: async () => [w.c], getCandidate: async () => { if (w.notionDown) throw Object.assign(new Error('x'), { code: 'notion_http_502' }); return w.c; },
    getEmailTemplate: async id => (id === 'd41f8631-8bd5-456b-a7df-c24036d12eb1' ? REMIND : SETUP), appendCandidateNote: async () => ({}) };
  w.gmail = { send: async m => { if (w.sendError) throw w.sendError; w.sent.push(m); return { id: `m${w.sent.length}`, url: 'https://mail/x' }; } };
  w.reader = { accounts: async () => w.accounts, account: async id => w.accounts.find(a => a.id === id) ?? null };
  w.onboarder = { probe: async () => { w.probes++; return probe(); } };
  w.run = now => runPayoutSetup({ env: ENV, db: w.db, notion: w.notion, gmail: w.gmail, parseTemplate, reader: w.reader, onboarder: w.onboarder, poster: async t => w.said.push(t), clock: () => now, force: true });
  return w;
}
const toSent = async w => { await w.run(NOW); await w.run(NOW + 31 * MIN); assert.equal(w.sent.length, 1, 'setup email sent'); };

test('Holds (#3): On Hold or Stage Closed gets no payout setup email; Project hears once; a hold that clears lets it go after a fresh 30 minutes', async () => {
  const w = world({ fields: { Outcome: 'On Hold' } });
  await w.run(NOW); await w.run(NOW + 31 * MIN); await w.run(NOW + 2 * HOUR);
  assert.equal(w.sent.length, 0);
  assert.deepEqual(w.said, ["📋 I didn't send Priya's payout setup email: they are On Hold. It goes once that is cleared."]);
  w.c.fields.Outcome = 'Proceeding';
  await w.run(NOW + 3 * HOUR);
  assert.match(w.said.at(-1), /^💳 Sending Priya the payout setup email/);
  await w.run(NOW + 3 * HOUR + 31 * MIN);
  assert.equal(w.sent.length, 1);
  // Held between queueing and sending: dropped, not sent.
  const w2 = world();
  await w2.run(NOW);
  w2.c.fields.Stage = 'Closed';
  await w2.run(NOW + 31 * MIN);
  assert.equal(w2.sent.length, 0);
  assert.match(w2.said.at(-1), /payout setup email: they are closed on the tracker\.$/);
  assert.equal((await allWaiting({ db: w2.db })).length, 0, 'not shown as waiting');
});

test('Paid (#7) and Stripe by account id (#5): no setup email for the paid, or for an account Project named or their link made', async () => {
  const paid = world({ fields: { 'Payment Status': 'Paid' } });
  await paid.run(NOW); await paid.run(NOW + 31 * MIN);
  assert.equal(paid.sent.length + paid.said.length, 0);
  assert.equal(alreadyPaid({ fields: { 'Payment Status': 'Ready to Pay' } }), false);
  const mapped = world({ accounts: [{ id: 'acct_9', emails: ['other@x.com'], detailsSubmitted: false }] });
  await mapped.kv.put(`stripe:map:${PID}`, { acct: 'acct_9', at: NOW }, NOW);
  await mapped.run(NOW); await mapped.run(NOW + 31 * MIN);
  assert.equal(mapped.sent.length, 0);
  assert.equal((await mapped.kv.get(`payout:email:${PID}`)).skipped, 'stripe_account_exists');
  const byEmail = world();
  await byEmail.kv.put(`stripe:map:${PID}`, { email: 'Other@x.com', at: NOW }, NOW);
  byEmail.accounts = [{ id: 'acct_8', emails: ['other@x.com'] }];
  await byEmail.run(NOW);
  assert.equal(byEmail.said.length, 0, 'the email Project named counts too');
  const st = await stripeStatusOf({ kv: byEmail.kv, pageId: PID, emails: [], accounts: [], reader: { account: async () => { throw new Error('down'); } } });
  assert.equal(st.unknown, false, 'no id to look up');
});

test('Reminder (#1): waits 30 minutes, shows as waiting, "cancel Priya" stops it; never once Stripe is set up by account id', async () => {
  const w = world();
  await toSent(w);
  await w.run(NOW + 25 * HOUR);
  assert.equal(w.sent.length, 1, 'queued, not sent');
  const waiting = await allWaiting({ db: w.db });
  assert.deepEqual(waiting.map(x => x.items.map(i => i.kind)), [['payout reminder email']]);
  const replies = [];
  const out = await handleCancelCommand({ event: { authorId: PROJECT, text: 'cancel Priya', channelId: 'D1', messageTs: '1.1' }, db: w.db,
    findCandidate: async () => ({ pageId: PID }), poster: () => async t => replies.push(t), masonId: PROJECT, clock: () => NOW + 25 * HOUR + MIN });
  assert.equal(out.kind, 'email_cancel');
  assert.equal(replies[0], "🛑 Cancelled. Priya's payout reminder email won't go out.");
  await w.run(NOW + 26 * HOUR); await w.run(NOW + 50 * HOUR);
  assert.equal(w.sent.length, 1, 'cancelled: never sent');
  // Their link made an account, finished under another email: no reminder.
  const w2 = world();
  await toSent(w2);
  await w2.kv.put(`payout:acct:${PID}`, { account: 'acct_new', country: 'IN', at: NOW }, NOW);
  w2.accounts = [{ id: 'acct_new', emails: ['priya.work@example.test'], detailsSubmitted: true, payoutsEnabled: false }];
  await w2.run(NOW + 25 * HOUR); await w2.run(NOW + 26 * HOUR);
  assert.equal(w2.sent.length, 1);
  // Set up during the 30 minutes: checked again when it goes.
  const w3 = world();
  await toSent(w3);
  await w3.run(NOW + 25 * HOUR);
  w3.accounts = [{ id: 'acct_1', emails: ['priya@example.com'], payoutsEnabled: true }];
  await w3.run(NOW + 26 * HOUR);
  assert.equal(w3.sent.length, 1);
});

test('Reminder holds (#3) and paid (#7): On Hold, a pay concern or Paid by then: no reminder; Notion down is not a drop', async () => {
  for (const [change, expectSaid] of [[w => { w.c.fields.Outcome = 'On Hold'; }, /payout reminder email: they are On Hold/], [w => w.kv.put(`trialterms:hold:${PID}`, { at: NOW }, NOW), /payout reminder email: they pushed back on the pay/], [w => { w.c.fields['Payment Status'] = 'Paid'; }, null]]) {
    const w = world();
    await toSent(w);
    await w.run(NOW + 25 * HOUR);
    await change(w);
    await w.run(NOW + 26 * HOUR); await w.run(NOW + 27 * HOUR);
    assert.equal(w.sent.length, 1);
    if (expectSaid) { assert.match(w.said.at(-1), expectSaid); assert.equal(w.said.filter(t => expectSaid.test(t)).length, 1, 'once'); }
  }
  const w = world();
  await toSent(w);
  w.notionDown = true;
  await w.run(NOW + 25 * HOUR);
  w.notionDown = false;
  await w.run(NOW + 26 * HOUR); await w.run(NOW + 27 * HOUR);
  assert.equal(w.sent.length, 2, 'the reminder still goes once Notion answers');
  assert.equal(w.sent[1].replyTo, 'm1');
});

test('Failures: a failed setup email stops showing as waiting; a failed reminder is told to Project once, never retried', async () => {
  const w = world({ sendError: Object.assign(new Error('x'), { code: 'gmail_http_400' }) });
  await w.run(NOW); await w.run(NOW + 31 * MIN); await w.run(NOW + 5 * HOUR);
  assert.equal((await allWaiting({ db: w.db })).length, 0);
  assert.equal(w.said.filter(t => /couldn't send Priya the payout setup email/.test(t)).length, 1);
  const r = world();
  await toSent(r);
  r.sendError = Object.assign(new Error('x'), { code: 'gmail_network', uncertain: true });
  await r.run(NOW + 25 * HOUR); await r.run(NOW + 26 * HOUR); await r.run(NOW + 30 * HOUR);
  assert.deepEqual(r.said.filter(t => /reminder/.test(t)), ["🚨 Priya's payout reminder may or may not have gone out (gmail_network). Check your Sent mail; I won't send it again."]);
  assert.equal((await allWaiting({ db: r.db })).length, 0);
});

test('Live only, and the onboarding key is tried first: refused -> no emails and Project hears once; tried at most daily', async () => {
  const off = world({ mode: 'Test' });
  await off.run(NOW); await off.run(NOW + 31 * MIN);
  assert.equal(off.sent.length + off.said.length + off.probes, 0);
  const bad = world({ probe: async () => 'refused' });
  await bad.run(NOW); await bad.run(NOW + 31 * MIN); await bad.run(NOW + 25 * HOUR);
  assert.equal(bad.sent.length, 0);
  assert.deepEqual(bad.said, ['🚨 Stripe refused the payout-setup key (STRIPE_ONBOARDING_KEY): it needs Connect account write access. No payout setup emails go until it works.']);
  assert.equal(bad.probes, 2, 'once a day');
  const good = world();
  await good.run(NOW); await good.run(NOW + 31 * MIN); await good.run(NOW + 2 * HOUR);
  assert.equal(good.probes, 1);
  let n = 0;
  const kv = noticeStore(d1());
  const flaky = { probe: async () => { n++; return 'unknown'; } };
  assert.equal(await onboardingKeyWorks({ env: ENV, kv, onboarder: flaky, now: NOW }), 'unknown');
  assert.equal(await onboardingKeyWorks({ env: ENV, kv, onboarder: flaky, now: NOW + 30 * MIN }), 'unknown');
  await onboardingKeyWorks({ env: ENV, kv, onboarder: flaky, now: NOW + 61 * MIN });
  assert.equal(n, 2, 'an unclear answer is tried again after an hour');
  assert.equal(await onboardingKeyWorks({ env: { ...ENV, STRIPE_ONBOARDING_KEY: 'rk_live_' + 'c'.repeat(30) }, kv, onboarder: { probe: async () => 'ok' }, now: NOW + 62 * MIN }), 'ok', 'a new key is tried at once');
});

test('Onboarder: the probe reads Stripe\'s answer, and account creation carries an idempotency key', async () => {
  const answer = (status, error) => async () => Response.json({ error }, { status });
  const probeWith = f => createStripeOnboarder({ env: ENV, fetchImpl: f }).probe();
  assert.equal(await probeWith(answer(400, { type: 'invalid_request_error', code: 'resource_missing', message: 'No such account' })), 'ok');
  assert.equal(await probeWith(answer(404, { type: 'invalid_request_error' })), 'ok');
  assert.equal(await probeWith(answer(403, { type: 'invalid_request_error', message: 'does not have the required permissions' })), 'refused');
  assert.equal(await probeWith(answer(401, { type: 'invalid_request_error' })), 'refused');
  // Live Stripe, 2026-10-20: a made-up account answers 403 with this message; that is a working key, not a refused one.
  assert.equal(await probeWith(answer(403, { type: 'invalid_request_error', message: "The provided key 'rk_live_***' does not have access to account 'acct_0000000000000000' (or that account does not exist). Application access may have been revoked." })), 'ok');
  assert.equal(await probeWith(answer(403, { type: 'invalid_request_error', message: 'something else' })), 'unknown');
  assert.equal(await probeWith(answer(500, { type: 'api_error' })), 'unknown');
  assert.equal(await probeWith(async () => { throw new Error('net'); }), 'unknown');
  const calls = [];
  const o = createStripeOnboarder({ env: ENV, fetchImpl: async (url, init) => { calls.push({ url, init }); return calls.length === 1 ? Response.json({ error: { type: 'invalid_request_error' } }, { status: 400 }) : Response.json({ id: 'acct_r' }); } });
  assert.equal(await o.createAccount({ country: 'IN', email: 'a@b.c', pageId: PID }), 'acct_r');
  assert.deepEqual(calls.map(c => c.init.headers['idempotency-key']), [`payout-acct-${PID}`, `payout-acct-${PID}-recipient`]);
  assert.ok(calls.every(c => c.url === 'https://api.stripe.com/v1/accounts'));
});

test('India pipeline: no payout setup email or reminder while Stripe can\'t pay there; Project told once', async () => {
  const w = world({ fields: { Pipeline: 'India' } });
  await w.run(NOW); await w.run(NOW + 31 * MIN); await w.run(NOW + 25 * HOUR);
  assert.equal(w.sent.length, 0);
  assert.deepEqual(w.said, ["💳 I didn't send Priya the payout setup email: Stripe can't make Indian payout accounts yet (Global Payouts is still pending). Pay them another way, or tell me when Stripe India works."]);
  assert.equal((await allWaiting({ db: w.db })).length, 0);
  // Moved to India after the setup email went: no reminder either.
  const r = world();
  await toSent(r);
  r.c.fields.Pipeline = 'India';
  await r.run(NOW + 25 * HOUR); await r.run(NOW + 26 * HOUR);
  assert.equal(r.sent.length, 1);
  assert.equal(r.said.filter(t => /Stripe can't make Indian/.test(t)).length, 1);
  const us = world({ fields: { Pipeline: 'US/EU' } });
  await toSent(us);
});

import { handlePayoutRequest } from '../service/lib/payout-setup.mjs';
test('Payout page: only countries Stripe can pay out to are listed; India picked -> nothing made, a kind page, Project told once', async () => {
  const db = d1(), kv = noticeStore(db), t = 'c'.repeat(48), said = [], made = [];
  await kv.put(`payout:token:${t}`, { pageId: PID, email: 'priya@example.com', name: 'Priya Shah', at: NOW }, NOW);
  let payableCalls = 0;
  const onboarder = { payableCountries: async () => { payableCalls++; return ['US', 'GB', 'NL']; }, createAccount: async a => { made.push(a); return 'acct_x'; }, onboardingLink: async () => 'https://connect.stripe.com/x' };
  const reader = { countrySpecs: async () => ['GB', 'IN', 'NL', 'US'] };
  const call = (method, body = null, now = NOW) => handlePayoutRequest({ env: ENV, db, reader, onboarder, poster: async x => said.push(x), clock: () => now,
    request: new Request(`https://your-project.example.com/api/payout?t=${t}`, { method, ...(body ? { body, headers: { 'content-type': 'application/x-www-form-urlencoded' } } : {}) }) });
  const html = await (await call('GET')).text();
  assert.ok(html.includes('value="GB"') && html.includes('value="US"') && !html.includes('value="IN"'), 'India not listed');
  for (let i = 0; i < 2; i++) {
    const page = await call('POST', `t=${t}&country=IN`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Thanks! Stripe can't pay out to India yet, so Project will reach out with another way to get you paid\./);
  }
  assert.equal(made.length, 0);
  assert.deepEqual(said, ["💳 Priya picked India on the payout page; Stripe can't pay there, so set up their payment another way."]);
  assert.equal(payableCalls, 1, 'kept a day');
  await call('GET', null, NOW + 25 * HOUR);
  assert.equal(payableCalls, 2);
  assert.equal((await call('POST', `t=${t}&country=GB`, NOW + 25 * HOUR)).status, 303);
  assert.equal(made[0].country, 'GB');
  // Can't read where Stripe pays: every country listed, nothing made on submit.
  const db2 = d1();
  await noticeStore(db2).put(`payout:token:${t}`, { pageId: PID, email: 'priya@example.com', name: 'Priya Shah', at: NOW }, NOW);
  const made2 = [];
  const blind = { payableCountries: async () => { throw Object.assign(new Error('x'), { code: 'stripe_http_403' }); }, createAccount: async a => { made2.push(a); return 'acct_y'; }, onboardingLink: async () => 'https://x' };
  const call2 = (method, body) => handlePayoutRequest({ env: ENV, db: db2, reader, onboarder: blind, clock: () => NOW,
    request: new Request(`https://your-project.example.com/api/payout?t=${t}`, { method, ...(body ? { body, headers: { 'content-type': 'application/x-www-form-urlencoded' } } : {}) }) });
  assert.match(await (await call2('GET')).text(), /value="IN"/);
  assert.equal((await call2('POST', `t=${t}&country=GB`)).status, 502);
  assert.equal(made2.length, 0);
  // The onboarder's read: GET /country_specs/US, the platform's own country added.
  const calls = [];
  const real = createStripeOnboarder({ env: ENV, fetchImpl: async (url, init) => { calls.push([url, init.method]); return Response.json({ id: 'US', supported_transfer_countries: ['GB', 'NL', 'bad'] }); } });
  assert.deepEqual(await real.payableCountries(), ['US', 'GB', 'NL']);
  assert.deepEqual(calls, [['https://api.stripe.com/v1/country_specs/US', 'GET']]);
});
