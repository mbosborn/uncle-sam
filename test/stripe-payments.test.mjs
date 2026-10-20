import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runStripePayments, handleStripeReply, createStripeReader, owedOf, stripeConfigured, fullSecretKey } from '../service/lib/stripe-payments.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const T = Date.parse('2026-10-16T20:00:00Z');
// Generate deliberately unusable values for key-shape validation with fake providers.
const stripeFixtureKey = kind => [kind, 'live', 'fixture'.repeat(5)].join('_');
const ENV = { STRIPE_API_KEY: stripeFixtureKey('rk'), UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled' };
const acct = (id, email, extra = {}) => ({ id, emails: [email], payoutsEnabled: true, transfers: true, detailsSubmitted: true, due: 0, disabled: null, ...extra });
const cand = (id, name, email, fields, payment = {}) => ({ pageId: id, fullName: name, email, url: `https://notion.so/${id}`, createdTime: '2026-10-01T00:00:00Z', fields, payment });

function world(records, accounts, transfers = {}) {
  const w = { db: d1(), said: [], writes: [], notes: [] };
  w.notion = { readControl: async () => ({ mode: 'Live' }), listOpenPayments: async () => records.map(r => structuredClone(r)),
    setPaymentFields: async a => { w.writes.push(a); const r = records.find(x => x.pageId === a.pageId); if (a.status) r.fields['Payment Status'] = a.status; if (a.paid !== undefined) r.payment.paid = a.paid; if (a.owed !== undefined) r.payment.owed = a.owed; },
    appendCandidateNote: async n => { w.notes.push(n); } };
  w.stripe = { accounts: async () => accounts, account: async id => accounts.find(a => a.id === id) ?? null, transfersTo: async id => transfers[id] ?? [] };
  let ts = 100;
  w.run = (now, extra = {}) => runStripePayments({ env: ENV, db: w.db, notion: w.notion, stripe: w.stripe, poster: thread => async text => { w.said.push({ thread, text }); return `${ts++}.000001`; }, clock: () => now, force: true, ...extra });
  return w;
}

test('Stripe: only a restricted key is used; a full secret key is refused and Project told once a day', async () => {
  assert.equal(stripeConfigured(ENV), true);
  assert.equal(stripeConfigured({ STRIPE_API_KEY: stripeFixtureKey('sk') }), false);
  assert.equal(fullSecretKey({ STRIPE_API_KEY: stripeFixtureKey('sk') }), true);
  const w = world([], []);
  const r = await runStripePayments({ env: { ...ENV, STRIPE_API_KEY: stripeFixtureKey('sk') }, db: w.db, notion: w.notion, poster: () => async t => { w.said.push(t); }, clock: () => T });
  assert.equal(r.state, 'refused_full_key');
  await runStripePayments({ env: { ...ENV, STRIPE_API_KEY: stripeFixtureKey('sk') }, db: w.db, notion: w.notion, poster: () => async t => { w.said.push(t); }, clock: () => T + 60_000 });
  assert.equal(w.said.length, 1);
});

test('Stripe reader: GET only, Bearer key, pages followed; personal details are not kept', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, method: init.method }); return Response.json(url.includes('/accounts') ? { data: [{ id: 'acct_1', email: 'A@x.com', individual: { email: 'a@x.com', dob: { year: 1990 }, address: { city: 'X' } }, payouts_enabled: true, capabilities: { transfers: 'active' }, requirements: { currently_due: [] } }], has_more: false }
    : { data: [{ id: 'tr_1', amount: 60000, amount_reversed: 0, currency: 'usd', created: 1792000000, metadata: {} }, { id: 'tr_2', amount: 75000, currency: 'usd', created: 1792000000, metadata: { payout_id: 'x' }, transfer_group: 'payout_x' }], has_more: false }); };
  const reader = createStripeReader({ env: ENV, fetchImpl });
  const accounts = await reader.accounts();
  assert.deepEqual(accounts[0], { id: 'acct_1', emails: ['a@x.com', 'a@x.com'], payoutsEnabled: true, transfers: true, detailsSubmitted: false, due: 0, disabled: null });
  const t = await reader.transfersTo('acct_1');
  assert.deepEqual(t.map(x => x.contractorPayout), [false, true]);
  assert.ok(calls.every(c => c.method === 'GET'));
  assert.match(calls[0].url, /^https:\/\/api\.stripe\.com\/v1\/accounts\?limit=100$/);
});

test('Stripe: a payment that landed is recorded (Paid, amount, date, owed 0) with one line to Project; never twice', async () => {
  const records = [cand('p1', 'Avery James Carter ⭐', 'jp@x.com', { 'Payment Status': 'Awaiting Stripe Setup', 'Trial Start': '2026-10-05', 'Trial End': '2026-10-07', Paperwork: 'Signed' }, { owed: 600, dailyRate: 200, days: 3 })];
  const w = world(records, [acct('acct_jp', 'jp@x.com')], { acct_jp: [{ id: 'tr_9', amount: 60000, reversed: 0, currency: 'usd', created: Date.parse('2026-10-16T18:00:00Z'), contractorPayout: false }] });
  const r = await w.run(T);
  assert.equal(r.paid, 1);
  assert.deepEqual(w.writes, [{ pageId: 'p1', expectedEmail: 'jp@x.com', paid: 600, date: '2026-10-16', status: 'Paid', owed: 0 }]);
  assert.equal(w.said[0].text, '💵 Paid: <https://notion.so/p1|Avery James Carter> · $600 on 2026-10-16 (Stripe). Record updated.');
  await w.run(T + 3600_000);
  assert.equal(w.writes.length, 1);
});

test('Stripe: a part payment lowers what is owed and keeps the status; the rest later completes it without a false "more than owed"', async () => {
  const records = [cand('p2', 'Ana Lima', 'an@x.com', { 'Payment Status': 'Ready to Pay', 'Trial End': '2026-10-10', Paperwork: 'Signed' }, { owed: 600 })];
  const transfers = { acct_a: [{ amount: 30000, reversed: 0, currency: 'usd', created: Date.parse('2026-10-14T18:00:00Z'), contractorPayout: false }] };
  const w = world(records, [acct('acct_a', 'an@x.com')], transfers);
  await w.run(T);
  assert.deepEqual(w.writes[0], { pageId: 'p2', expectedEmail: 'an@x.com', paid: 300, date: '2026-10-14', owed: 300 });
  assert.match(w.said[0].text, /\$300 still owed\.$/);
  transfers.acct_a.push({ amount: 30000, reversed: 0, currency: 'usd', created: Date.parse('2026-10-16T18:00:00Z'), contractorPayout: false });
  await w.run(T + 3600_000);
  assert.deepEqual(w.writes[1], { pageId: 'p2', expectedEmail: 'an@x.com', paid: 600, date: '2026-10-16', status: 'Paid', owed: 0 });
  assert.equal(w.said[1].text, '💵 Paid: <https://notion.so/p2|Ana Lima> · $600 on 2026-10-16 (Stripe). Record updated.');
});

test('Stripe: trial over and account ready -> Ready to Pay with the amount worked out, a link, one reminder after two days', async () => {
  const records = [cand('p3', 'Arlen Archer', 'ak@x.com', { 'Payment Status': 'Actively in Trial', 'Trial Start': '2026-10-13', Paperwork: 'Signed' }, { dailyRate: 100, days: 2 })];
  const w = world(records, [acct('acct_ak', 'ak@x.com')]);
  await w.run(T);
  assert.deepEqual(w.writes[0], { pageId: 'p3', expectedEmail: 'ak@x.com', status: 'Ready to Pay', owed: 200 });
  assert.equal(w.said[0].text, '💵 Ready to pay: <https://notion.so/p3|Arlen Archer> · $200 (2 days × $100/day) · Stripe account ready: <https://dashboard.stripe.com/connect/accounts/acct_ak|open in Stripe>. Paying stays your click; I record it when it lands.');
  await w.run(T + 86400_000);
  assert.equal(w.said.length, 1);
  await w.run(T + 2.1 * 86400_000);
  assert.match(w.said[1].text, /^💵 Still unpaid: /);
  await w.run(T + 5 * 86400_000);
  assert.equal(w.said.length, 2, 'one reminder only');
});

test('Stripe: still in trial -> nothing; no account -> Awaiting Stripe Setup and a question Project can answer in its thread', async () => {
  const records = [cand('p4', 'Rylan King', 'rk@x.com', { 'Payment Status': 'Actively in Trial', 'Trial Start': '2026-10-19', 'Trial End': '2026-10-21' }, { planned: 300 }),
    cand('p5', 'Marjan Stoimchev', 'ms@x.com', { 'Payment Status': 'Awaiting Stripe Setup', Outcome: 'Not Selected' }, { owed: 600, days: 3 })];
  const w = world(records, [acct('acct_other', 'marjan.s@example.test')], { acct_other: [] });
  await w.run(T);
  assert.equal(w.writes.length, 0, 'Rylan still in trial; Marjan already Awaiting');
  assert.equal(w.said.length, 1);
  assert.match(w.said[0].text, /^📋 <https:\/\/notion\.so\/p5\|Marjan Stoimchev> is owed \$600, but there's no Stripe account under ms@x\.com\. .*reply in this thread with it\.$/);
  const ts = '100.000001';
  const reply = [];
  const r = await handleStripeReply({ event: { threadTs: ts, messageTs: '200.1', authorId: 'UM', text: 'she used <mailto:marjan.s@example.test|marjan.s@example.test>' }, db: w.db, masonId: 'UM', poster: () => async t => { reply.push(t); } , clock: () => T + 60_000 });
  assert.equal(r.reason, 'email');
  assert.equal(reply[0], '🫡 I\'ll look for their Stripe account under marjan.s@example.test within 5 minutes.');
  await w.run(T + 120_000);
  assert.deepEqual(w.writes.at(-1), { pageId: 'p5', expectedEmail: 'ms@x.com', status: 'Ready to Pay' });
  assert.equal(await handleStripeReply({ event: { threadTs: ts, messageTs: '201.1', authorId: 'USOMEONE', text: 'x@y.com' }, db: w.db, masonId: 'UM', poster: () => async () => {} }), null, 'only Project');
});

test('Stripe: To Confirm is left to people; unsigned paperwork, an unfinished account, two accounts on one email and no amount are told, not guessed', async () => {
  const records = [cand('c1', 'Ahmad Zamir', 'az@x.com', { 'Payment Status': 'To Confirm' }, { owed: 1000 }),
    cand('c2', 'Paper Pending', 'pp@x.com', { 'Payment Status': 'Awaiting Stripe Setup', Paperwork: 'Sent' }, { owed: 300 }),
    cand('c3', 'Half Done', 'hd@x.com', { 'Payment Status': 'Awaiting Stripe Setup' }, { owed: 300 }),
    cand('c4', 'Two Accts', 'two@x.com', { 'Payment Status': 'Awaiting Stripe Setup' }, { owed: 300 }),
    cand('c5', 'No Amount', 'na@x.com', { 'Payment Status': 'Awaiting Stripe Setup' }, {})];
  const w = world(records, [acct('acct_az', 'az@x.com'), acct('acct_pp', 'pp@x.com'), acct('acct_hd', 'hd@x.com', { payoutsEnabled: false, due: 2 }),
    acct('acct_t1', 'two@x.com'), acct('acct_t2', 'two@x.com')]);
  await w.run(T);
  assert.deepEqual(w.writes, [], 'nothing changed for any of them');
  const all = w.said.map(s => s.text).join('\n');
  assert.match(all, /Two Accts>: 2 Stripe accounts use two@x\.com/);
  assert.match(all, /Paper Pending> is owed \$300 and their Stripe account is ready, but the paperwork is Sent, not signed\./);
  assert.match(all, /Half Done> is owed \$300; their Stripe account isn't ready for payouts yet \(2 items still due in Stripe\)/);
  assert.match(all, /No Amount>: trial is over but the record has no amount/);
  assert.doesNotMatch(all, /Ahmad/);
});

test('Stripe: contractor payouts, reversals and transfers from before the trial are not trial pay', async () => {
  const records = [cand('x1', 'Old Expert', 'oe@x.com', { 'Payment Status': 'Awaiting Stripe Setup', 'Trial Start': '2026-10-10', 'Trial End': '2026-10-12' }, { owed: 300 })];
  const w = world(records, [acct('acct_oe', 'oe@x.com')], { acct_oe: [
    { amount: 150000, reversed: 0, currency: 'usd', created: Date.parse('2026-10-14T00:00:00Z'), contractorPayout: true },
    { amount: 30000, reversed: 30000, currency: 'usd', created: Date.parse('2026-10-14T00:00:00Z'), contractorPayout: false },
    { amount: 30000, reversed: 0, currency: 'usd', created: Date.parse('2026-09-01T00:00:00Z'), contractorPayout: false }] });
  await w.run(T);
  assert.deepEqual(w.writes, [{ pageId: 'x1', expectedEmail: 'oe@x.com', status: 'Ready to Pay' }]);
  assert.equal(owedOf({ planned: 500 }).how, 'planned trial payment');
});
