import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleTakeHomeCommand, handleOktaCommand, looksLikeTakeHomeSend, looksLikeOktaAsk } from '../service/lib/project-commands.mjs';
import { candidateFinder, looksLikeAddendumSend, sendAddendumOnly, prepareDocusignLink, completeDocusignConnection, sendWorkTrialPacket, paperworkOut } from '../service/lib/docusign-send.mjs';
import { runStageGaps, takeHomeGapText } from '../service/lib/stage-gaps.mjs';

const PROJECT = 'U0F9EF97D89';
const NOW = Date.parse('2026-10-17T02:45:00Z'); // Fri 7:45 PM PT
const ENV = { WISPR_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'), DOCUSIGN_INTEGRATION_KEY: 'c807de29-de8c-43ec-8dbe-8b991f9f16a3', DOCUSIGN_SECRET_KEY: '11111111-2222-3333-4444-555555555555',
  UNCLE_SAM_PACKET_ADDENDUM: 'on', SLACK_BOT_TOKEN: 'xoxb-1-2-3' };
function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_wispr (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  sqlite.exec('CREATE TABLE uncle_sam_requests (request_key TEXT PRIMARY KEY, candidate_id TEXT, action TEXT, state TEXT, created_at INTEGER, recipient_ids_json TEXT, payload_json TEXT)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare, sqlite };
}
const person = (pageId, fullName, from, email, fields = {}) => ({ pageId, fullName, email, url: `https://app.notion.com/p/${pageId}`, fields: { Outcome: 'Proceeding', Stage: 'Case Study', ...fields }, profile: { from }, payment: {} });
const PEOPLE = [person('p-abh', 'Logan Wells', null, 'logan0709wells@example.test'), person('p-prox', 'Reagan Turner', 'Proximal', 'turnerreagan1234@example.test', { Outcome: 'On Hold' }),
  person('p-merc', 'Reagan Turner (Mercor)', 'Mercor', 'reaganturner5678@example.test'), person('p-arlen', 'Arlen Archer', 'Zepto', 'arlenexample@example.test', { Stage: 'Trial' }),
  person('p-aarlen', 'Aarlen Archer', null, 'aarlen.archer.002@example.test', { Stage: 'Outreach' })];
const notion = (people = PEOPLE) => ({ findCandidatesByName: async n => people.filter(c => c.fullName.toLowerCase().includes(n.toLowerCase())), listActiveCandidates: async () => people,
  getCandidate: async id => people.find(c => c.pageId === id), appendCandidateNote: async () => null });
const ev = (text, extra = {}) => ({ authorId: PROJECT, channelId: 'D0C95KBR09J', messageTs: '1792205000.000100', threadTs: null, text, ...extra });

test('what reads as a take-home, an Okta ask or the 4th document', () => {
  for (const t of ['this guy needs to be sent the take home', 'send Logan Wells the take-home', 'send reagan turner from mercor the take home']) assert.ok(looksLikeTakeHomeSend(t), t);
  for (const t of ['remind Logan about the take-home', 'did he submit the take home?']) assert.ok(!looksLikeTakeHomeSend(t), t);
  assert.ok(looksLikeOktaAsk('message rory a to set up his okta'));
  for (const t of ['add him the 4th document with the $100 per day', 'send Arlen Archer the addendum at $100/day']) assert.ok(looksLikeAddendumSend(t), t);
  assert.ok(!looksLikeAddendumSend('send the work trial docs to Morgan'));
});

test('"send Reagan Turner from Mercor the take home": the Mercor one, by Project, no hold; Logan by name; namesakes asked; a "send" under the question works', async () => {
  const db = d1(), said = [], started = [];
  const run = (text, extra) => handleTakeHomeCommand({ event: ev(text, extra), db, findCandidate: candidateFinder({ notion: notion(), history: async () => [] }), poster: () => async t => said.push(t),
    masonId: PROJECT, clock: () => NOW, startTakeHome: async (who, t) => { started.push([who.pageId, t]); return { kind: 'takehome_invite_queued' }; } });
  assert.equal((await run('send reagan turner from mercor the take home')).reason, 'takehome_invite_queued');
  assert.equal(started[0][0], 'p-merc');
  assert.equal(said.length, 0, 'the Cancel notice is the answer');
  await run('send Logan Wells the take-home');
  assert.equal(started[1][0], 'p-abh');
  const which = await run('send Reagan Turner the take-home', { messageTs: '1792205100.000100' });
  assert.equal(which.reason, 'ambiguous');
  assert.match(said[0], /Which one: Reagan Turner \(Proximal\) or Reagan Turner \(Mercor\) \(Mercor\)|Which one: Reagan Turner \(Proximal\) or Reagan Turner \(Mercor\)/);
  await run('the mercor one, reagan turner from mercor', { messageTs: '1792205200.000100', threadTs: '1792205100.000100' });
  assert.equal(started[2][0], 'p-merc');
  // Under Uncle Sam's own question with the person in it: "send" does it; "reject" is left to the usual lane.
  await noticeKv(db).put('takehome-ask:D0C95KBR09J:1792205300.000100', { at: NOW, who: { pageId: 'p-abh', fullName: 'Logan Wells', email: 'logan0709wells@example.test' } }, NOW);
  assert.equal(await run('reject', { messageTs: '1792205400.000100', threadTs: '1792205300.000100' }), null);
  await run('send', { messageTs: '1792205500.000100', threadTs: '1792205300.000100' });
  assert.equal(started[3][0], 'p-abh');
});
import { noticeStore as noticeKv } from '../service/lib/stuck-rejections.mjs';

test('"ask AA to set up Arlen Archer\'s Okta": posted once to AA alone with his Company email and Slack', async () => {
  const db = d1(), said = [], posts = [];
  // Slack confirms U0C9B161CRH is Arlen (his Company address); the "Sent using @Claude" footer's bot is never taken.
  const fetchImpl = async (url, init) => { posts.push({ url: String(url), body: String(init.body) }); return Response.json({ ok: true, ts: '1792205600.000100',
    members: [{ id: 'U0C9B161CRH', name: 'arlen', real_name: 'arlen', profile: { email: 'arlen@company.example', real_name: 'arlen' } }] }); };
  const run = text => handleOktaCommand({ event: ev(text), env: ENV, db, notion: notion(), findCandidate: candidateFinder({ notion: notion(), history: async () => [] }),
    poster: () => async t => said.push(t), masonId: PROJECT, routeMap: { aa_group: { channelId: 'C0C9F9CS53K' }, interviewer_aa: { channelId: 'D0AADM00001' } }, fetchImpl, clock: () => NOW });
  const out = await run('ask AA to set up Arlen Archer\'s Okta, arlen@company.example <@U0C9B161CRH>');
  assert.equal(out.reason, 'asked');
  const posted = posts.find(p => p.url.endsWith('chat.postMessage'));
  assert.match(decodeURIComponent(posted.body), /D0AADM00001/, 'AA alone, not the group DM with Project');
  assert.match(decodeURIComponent(posted.body), /AA: Arlen Archer starts a work trial soon\. Their Company email is arlen@company\.example and they're in Slack as <@U0C9B161CRH>\. Set up Okta/);
  assert.equal(said[0], 'Roger that 🫡');
  assert.equal((await run('ask AA to set up Arlen Archer\'s Okta')).reason, 'already_asked');
});

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
test("Jamie's documents and a Work Trial Agreement already out (Rylan, Oct 19): no addendum on top; nothing sent", async () => {
  const db = await connectedDb(), sent = [];
  const list = [{ id: 'be51377f-aac8-8720-801c-453f2797ea61', status: 'delivered', subject: 'Work Trial Docs -- Rylan King', sender: { name: 'Jamie', email: 'jamie@company.example' }, signers: [] },
    { id: '08652867-8486-86cb-8005-6ec2eaa8b1b2', status: 'completed', subject: 'Company - Work Trial Agreement - Rylan King', sender: { name: 'Jamie', email: 'jamie@company.example' }, signers: [] }];
  const sender = { envelopesFor: async () => list, sendPacket: async () => { throw new Error('never'); }, sendAddendum: async a => { sent.push(a); return { ok: true, envelopeId: 'x' }; } };
  const who = { pageId: 'p-r', fullName: 'Rylan King', email: 'rylanking@example.test', trialStart: '2026-10-19', trialEnd: '2026-10-21' };
  const out = await sendWorkTrialPacket({ env: ENV, db, sender, who, rate: 100, clock: () => NOW });
  assert.equal(out.reason, 'already_has_packet');
  assert.equal(sent.length, 0);
  assert.match(out.text, /already has a Work Trial Agreement \(signed\), which carries the pay\. I sent nothing\./);
  assert.deepEqual(Object.keys(paperworkOut(list)).map(k => paperworkOut(list)[k]?.id), ['be51377f-aac8-8720-801c-453f2797ea61', '08652867-8486-86cb-8005-6ec2eaa8b1b2']);
});
test("Jamie's three documents already out: the 4th, the addendum at $100/day, goes on its own; once", async () => {
  const db = await connectedDb(), sent = [];
  const jamie = { id: 'ae3c6f91-19f6-86ab-8077-9f733d1ca717', status: 'sent', subject: 'Work Trial Docs -- Arlen Archer', sender: { name: 'Jamie', email: 'jamie@company.example' }, signers: [] };
  const sender = { envelopesFor: async () => [jamie], sendPacket: async () => { throw new Error('never the packet'); }, sendAddendum: async a => { sent.push(a); return { ok: true, envelopeId: '12345678-1234-1234-1234-123456789012' }; } };
  const who = { pageId: 'p-arlen', fullName: 'Arlen Archer', email: 'arlenexample@example.test', trialStart: '2026-10-17', trialEnd: '2026-10-18' };
  const tracked = [];
  const out = await sendWorkTrialPacket({ env: ENV, db, sender, who, rate: 100, clock: () => NOW, afterAddendum: a => { tracked.push(a); return 'Tracker updated.'; } });
  assert.equal(out.reason, 'addendum_sent');
  assert.equal(sent.length, 1);
  assert.equal(tracked[0].rate, 100);
  assert.match(out.text, /Arlen Archer already has the work trial documents, sent by Jamie, and has not opened it yet\. Sent Arlen Archer the work trial compensation addendum at US\$100 per day in its own DocuSign envelope/);
  const again = await sendAddendumOnly({ env: ENV, db, sender, who, rate: 100, clock: () => NOW + 60_000, earlier: [jamie] });
  assert.equal(again.reason, 'already_sent');
  assert.equal(sent.length, 1);
});

test('things that fell through: Case Study with no take-home, and an unanswered feedback question, told once each', async () => {
  const db = d1(), said = [];
  db.sqlite.prepare('INSERT INTO uncle_sam_requests VALUES (?, ?, ?, ?, ?, ?, ?)').run('usam:v1:abh', 'p-abh', 'interview.feedback_request', 'Sent', Date.parse('2026-10-16T04:20:47Z'), '["U0A4F08721B"]',
    JSON.stringify({ roleRound: 'Interview · 30 Min call Robin (Logan Wells)' }));
  const n = { ...notion(), findTakeHomeScorecard: async id => (id === 'p-merc' ? { pageId: 'card' } : null), findOperationsForCandidate: async () => [] };
  let ts = 0;
  const poster = async t => { said.push(t); return `1792205${700 + ts++}.000100`; };
  const out = await runStageGaps({ db, notion: n, poster, channelId: 'D0C95KBR09J', clock: () => Date.parse('2026-10-16T20:00:00Z') + 86400_000 });
  assert.deepEqual([out.unanswered, out.takeHome], [1, 1]);
  assert.match(said[0], /Robin hasn't answered about <https:\/\/app\.notion\.com\/p\/p-abh\|Logan Wells> \(Interview · 30 Min call Robin \(Logan Wells\); asked Thu, Oct 15, 9:20 PM PT\)/);
  assert.equal(said[1], takeHomeGapText(PEOPLE[0]));
  assert.ok(!said.some(t => /Reagan/.test(t)), 'On Hold and the one with a scorecard are left alone');
  const later = await runStageGaps({ db, notion: n, poster, channelId: 'D0C95KBR09J', clock: () => Date.parse('2026-10-16T20:00:00Z') + 86400_000 + 3 * 3600_000 });
  assert.deepEqual([later.unanswered, later.takeHome], [0, 0]);
  assert.ok((await noticeKv(db).get('takehome-ask:D0C95KBR09J:1792205701.000100'))?.who?.pageId === 'p-abh');
});
