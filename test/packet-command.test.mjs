import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { prepareDocusignLink, completeDocusignConnection, handleDocusignSend, candidateFinder, nameGuesses, companyOf, soundsLike, soundex } from '../service/lib/docusign-send.mjs';
import { recordPacketOnTracker } from '../service/lib/work-trial-offer.mjs';

const ENV = { WISPR_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'), DOCUSIGN_INTEGRATION_KEY: 'c807de29-de8c-43ec-8dbe-8b991f9f16a3', DOCUSIGN_SECRET_KEY: '11111111-2222-3333-4444-555555555555' };
const NOW = Date.parse('2026-10-17T02:12:13Z');
const PROJECT = 'U0F9EF97D89';
// Project's words on 2026-10-16, dictated: "Reagan Turner" came out as "reighan, terner".
const SAID = '<@U0C4899BFC9> Set up reighan, terner from Proximal. Send him the necessary documents for the work trial. $100 per day.';
function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_wispr (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
async function connectedDb() {
  const db = d1();
  const link = await prepareDocusignLink({ env: ENV, db, clock: () => NOW });
  const state = new URL(link.url).searchParams.get('state');
  const fetchImpl = async url => String(url).endsWith('/oauth/userinfo')
    ? Response.json({ sub: 'u1', email: 'project@company.example', accounts: [{ account_id: 'dcd9d815-f64e-4870-a725-4e81cb766cc0', base_uri: 'https://na4.docusign.net' }] })
    : Response.json({ access_token: 'at', refresh_token: 'rt', expires_in: 28800 });
  await completeDocusignConnection({ env: ENV, db, fetchImpl, clock: () => NOW, code: 'c', state });
  return db;
}
const person = (pageId, fullName, from, email, extra = {}) => ({ pageId, fullName, email, fields: { Outcome: 'Proceeding', ...extra }, profile: { from }, payment: {} });
const PEOPLE = [person('p-prox', 'Reagan Turner', 'Proximal', 'turnerreagan1234@example.test'), person('p-merc', 'Reagan Turner', 'Mercor', 'reaganturner5678@example.test'),
  person('p-morgan', 'Morgan Ellis', 'Turing', 'morgan@example.com')];
const notion = (people = PEOPLE) => ({
  findCandidatesByName: async name => people.filter(c => c.fullName.toLowerCase().includes(name.toLowerCase())),
  listActiveCandidates: async () => people,
  getCandidate: async id => people.find(c => c.pageId === id),
});
function fakeSender() {
  const sent = [];
  return { sent, envelopesFor: async () => [], sendPacket: async p => { sent.push(p); return { ok: true, envelopeId: `0000000${sent.length}-1111-2222-3333-444444444444` }; } };
}
const run = (db, sender, text, extra = {}, said = []) => handleDocusignSend({ event: { authorId: PROJECT, channelId: 'D0C95KBR09J', messageTs: '1792203133.554749', threadTs: null, text, ...extra.event },
  env: ENV, db, sender, masonId: PROJECT, clock: () => NOW + (extra.later ?? 0), findCandidate: candidateFinder({ notion: notion(extra.people), history: async () => [] }),
  poster: () => async t => said.push(t), afterSend: extra.afterSend ?? null, threadRoot: extra.threadRoot ?? null });

test('names out of a dictated command; the company; names that sound alike', () => {
  assert.equal(companyOf(SAID), 'Proximal');
  assert.deepEqual(nameGuesses(SAID), ['reighan terner']);
  assert.deepEqual(nameGuesses('reagan turner from proximal'), ['reagan turner']);
  assert.ok(nameGuesses("resend Morgan's DocuSign").includes('morgan'));
  assert.equal(soundex('reighan'), soundex('Reagan'));
  assert.equal(soundex('terner'), soundex('Turner'));
  assert.ok(soundsLike('reighan terner', 'Reagan Turner'));
  assert.ok(!soundsLike('reighan terner', 'Morgan Ellis'));
});

test("Project's dictated command goes out: the name read by sound, the company picks Proximal over Mercor, at his rate; never twice", async () => {
  const db = await connectedDb(), sender = fakeSender(), said = [], after = [];
  const out = await run(db, sender, SAID, { afterSend: input => { after.push(input); return 'Tracker updated: Paperwork Sent, Stage Trial, US$100 per day, next action set.'; } }, said);
  assert.equal(out.reason, 'sent', said.join('\n'));
  assert.equal(sender.sent[0].email, 'turnerreagan1234@example.test');
  assert.equal(after[0].rate, 100, 'his rate reaches the tracker even without the addendum');
  assert.match(said[0], /^📨 I read “reighan terner” as Reagan Turner \(Proximal\)\. Sent Reagan Turner the work trial documents/);
  assert.match(said[0], /Pay per day: US\$100\..*Tracker updated: Paperwork Sent, Stage Trial/);
  const again = await run(db, sender, SAID, { later: 60_000 }, said);
  assert.equal(again.reason, 'already_sent');
  assert.equal(sender.sent.length, 1);
});

test('a name heard by sound with no company named: one "yes" in the thread first, then it goes at the rate he gave', async () => {
  const db = await connectedDb(), sender = fakeSender(), said = [];
  const people = [PEOPLE[0], PEOPLE[2]];
  const out = await run(db, sender, 'send reighan terner the work trial docs at $100/day', { people }, said);
  assert.equal(out.reason, 'confirm_name');
  assert.match(said[0], /Did you mean Reagan Turner \(Proximal\), turnerreagan1234@example\.test\? Reply yes here/);
  assert.equal(sender.sent.length, 0);
  const yes = await run(db, sender, 'yes', { people, event: { messageTs: '1792203140.000100', threadTs: '1792203133.554749' } }, said);
  assert.equal(yes.reason, 'sent');
  assert.equal(sender.sent[0].email, 'turnerreagan1234@example.test');
});

test('nobody found: he names them in the thread and it goes; namesakes split by "from"; a thank-you is left alone', async () => {
  const db = await connectedDb(), sender = fakeSender(), said = [];
  const out = await run(db, sender, 'send Zed the work trial docs at $120 per day', {}, said);
  assert.equal(out.reason, 'no_candidate');
  assert.match(said[0], /I couldn't find “zed”.*Reply here with their full name.*at US\$120 per day/);
  const reply = await run(db, sender, 'reagan turner from proximal', { event: { messageTs: '1792203145.315479', threadTs: '1792203133.554749' } }, said);
  assert.equal(reply.reason, 'sent', said.join('\n'));
  assert.equal(sender.sent[0].email, 'turnerreagan1234@example.test');
  assert.equal(await run(db, sender, 'thanks', { event: { messageTs: '1792203150.000100', threadTs: '1792203133.554749' } }, said), null);
  // Plain "Reagan Turner" with two of them open asks which, naming the companies.
  const db2 = await connectedDb(), said2 = [];
  const which = await run(db2, fakeSender(), 'send Reagan Turner the work trial docs', {}, said2);
  assert.equal(which.reason, 'ambiguous');
  assert.match(said2[0], /Which one: Reagan Turner \(Proximal\) or Reagan Turner \(Mercor\)\?/);
});

test('a reply under his own send command from before the question was kept still counts (the thread from Oct 16)', async () => {
  const db = await connectedDb(), sender = fakeSender(), said = [];
  const threadRoot = async () => ({ ts: '1792203133.554749', user: PROJECT, text: SAID });
  const out = await run(db, sender, 'reagan turner from proximal', { threadRoot, event: { messageTs: '1792203145.315479', threadTs: '1792203133.554749' }, later: 3600_000 }, said);
  assert.equal(out.reason, 'sent');
  assert.equal(sender.sent[0].email, 'turnerreagan1234@example.test');
  // Someone else's thread, or a day later: not a send.
  const other = async () => ({ ts: '1792203133.554749', user: 'U0A4F08721B', text: SAID });
  assert.equal(await run(await connectedDb(), fakeSender(), 'reagan turner from proximal', { threadRoot: other, event: { messageTs: '2.0', threadTs: '1792203133.554749' } }, []), null);
});

test('the tracker on the same tap: Paperwork Sent, Stage Trial, the rate, next action and a dated note; a failure says what to set by hand', async () => {
  const calls = [], notes = [];
  const fakeNotion = { recordPacketSent: async a => { calls.push(a); return { verified: true }; }, appendCandidateNote: async n => { notes.push(n); } };
  const who = { pageId: 'p-prox', fullName: 'Reagan Turner', email: 'turnerreagan1234@example.test', trialStart: null };
  const line = await recordPacketOnTracker({ notion: fakeNotion, who, rate: 100, addendum: false, envelopeId: 'env-1', now: NOW });
  assert.equal(line, 'Tracker updated.');
  assert.equal(calls[0].dailyRate, 100);
  assert.match(calls[0].nextAction, /^Reagan: sign the work trial documents in DocuSign \(packet sent Oct 16\)\. Project countersigns after\. Trial dates not on the record yet: get them from Reagan\./);
  assert.match(notes[0].text, /Work trial documents sent through DocuSign by Uncle Sam on Project's instruction: NDA, CIIAA, Terms of Service\. Envelope env-1\. Pay per day: US\$100\./);
  const failed = await recordPacketOnTracker({ notion: { recordPacketSent: async () => { const e = new Error('x'); e.code = 'candidate_identity_changed'; throw e; } }, who, rate: 100, envelopeId: 'e', now: NOW });
  assert.match(failed, /I couldn't update the tracker \(candidate_identity_changed\): set Paperwork to Sent and the rate to US\$100 by hand\./);
});
