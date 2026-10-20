import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleOffboardNow, recordFor, OFFBOARD_ASK } from '../service/lib/offboard-now.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const PROJECT = 'U0F9EF97D89', NOW = Date.parse('2026-10-18T21:07:00Z');
const AARLEN = { pageId: '11111111-1111-1111-1111-111111111111', fullName: 'Aarlen Verma', email: 'aarlen@example.test', fields: { Outcome: null, Stage: 'Work Trial' }, profile: { from: 'IIT Delhi' } };
const KING = { pageId: '22222222-2222-2222-2222-222222222222', fullName: 'Rylan King', fields: { Stage: 'Work Trial' }, profile: {} };
const event = { authorId: PROJECT, channelId: 'D1', messageTs: '1.1', text: '<@U0C4899BFC9> mark him withdrew and delete get rid of all of his stuff' };
// The screenshot (Robin: "aarlen left / tapped out / so u can remove him / his email slack gmail") as gatherContext gives it.
const gather = async () => ({ lines: ['[Project] <@U0C4899BFC9> mark him withdrew and delete get rid of all of his stuff', '[Project, screenshot shows] Robin 10:41 AM @Project Owner, aarlen left tapped out so u can remove him | Robin 11:27 AM his email slack gmail'], imagesUnread: 0 });
const claudeFor = name => ({ complete: async req => { if (name) assert.match(req.messages[0].content, /screenshot shows/); return { content: [{ type: 'tool_use', name: 'who', input: { name, withdraw: true, offboard: true } }] }; } });

test('"mark him withdrew and get rid of all his stuff" with Robin\'s screenshot: Aarlen is withdrawn and his Google account suspended; Slack is a link', async () => {
  const db = d1(), said = [], closed = [], suspended = [], notes = [];
  const notion = { findCandidatesByName: async n => (/aarlen/i.test(n) ? [AARLEN] : /king/i.test(n) ? [KING] : []), closeCandidate: async x => closed.push(x), appendCandidateNote: async x => notes.push(x) };
  const admin = { suspend: async a => suspended.push(a), get: async a => ({ primaryEmail: a, name: 'Aarlen Verma', suspended: false, isAdmin: false }), findByName: async () => [] };
  // accountOf finds the address Uncle Sam recorded for him.
  const { noticeStore } = await import('../service/lib/stuck-rejections.mjs');
  await noticeStore(db).put(`onboarding:${AARLEN.pageId}`, { address: 'aarlen@company.example' }, NOW);
  const out = await handleOffboardNow({ event, db, notion, claude: claudeFor('aarlen'), admin, gather, masonId: PROJECT, poster: () => async t => said.push(t), clock: () => NOW });
  assert.equal(out.reason, 'done');
  assert.equal(closed[0].outcome, 'Withdrawn or Unavailable');
  assert.deepEqual(suspended, ['aarlen@company.example']);
  assert.match(said[0], /^Roger that 🫡/);
  assert.match(said[0], /Yours: deactivate them in Slack/);
  assert.doesNotMatch(said[0], /King/);
  // Never twice.
  said.length = 0;
  await handleOffboardNow({ event, db, notion, claude: claudeFor('aarlen'), admin, gather, masonId: PROJECT, poster: () => async t => said.push(t), clock: () => NOW });
  assert.deepEqual(suspended, ['aarlen@company.example']);
});

test('No name anywhere: asks who, never guesses; not Project or not an offboard ask: not this lane', async () => {
  const said = [];
  const notion = { findCandidatesByName: async () => [KING] };
  const out = await handleOffboardNow({ event, db: d1(), notion, claude: claudeFor(''), gather: async () => ({ lines: ['[Project] mark him withdrew'] }), masonId: PROJECT, poster: () => async t => said.push(t), clock: () => NOW });
  assert.equal(out.reason, 'no_name');
  assert.match(said[0], /^📋 Who\?/);
  assert.equal(await handleOffboardNow({ event: { ...event, authorId: 'U0OTHER' }, db: d1(), notion, claude: claudeFor('x'), masonId: PROJECT, poster: () => async () => {} }), null);
  assert.equal(OFFBOARD_ASK.test('what time is the sync'), false);
});

test('Namesakes: the which-one question; an open record wins over a closed one', async () => {
  const a = { ...AARLEN }, b = { ...AARLEN, pageId: '33333333-3333-3333-3333-333333333333', fullName: 'Aarlen Morris', profile: { from: 'Zepto', linkedin: 'https://www.linkedin.com/in/ag' } };
  assert.match((await recordFor({ notion: { findCandidatesByName: async () => [a, b] }, name: 'aarlen' })).ask, /^Do you mean Aarlen Verma from IIT Delhi or <https:\/\/www\.linkedin\.com\/in\/ag\|Aarlen Morris> from Zepto\?$/);
  const closedB = { ...b, fields: { Outcome: 'Not Selected', Stage: 'Closed' } };
  assert.equal((await recordFor({ notion: { findCandidatesByName: async () => [a, closedB] }, name: 'aarlen' })).candidate.fullName, 'Aarlen Verma');
});

test('"aarlen" (Oct 18): the work trialer Arlen with a Company account, never the researcher Aarlen; nobody with an account: asks, changes nothing', async () => {
  const { offboardTargetFor } = await import('../service/lib/offboard-now.mjs');
  const { noticeStore } = await import('../service/lib/stuck-rejections.mjs');
  const researcher = { pageId: 'r1', fullName: 'Aarlen Archer', fields: { Stage: 'Outreach' }, profile: {} };
  const trialer = { pageId: 't1', fullName: 'Arlen Archer', fields: { Stage: 'Trial', 'Trial Start': '2026-10-17' }, profile: { from: 'Zepto' } };
  const notion = { findCandidatesByName: async q => [researcher, trialer].filter(c => c.fullName.toLowerCase().includes(String(q).toLowerCase())) };
  const db = d1();
  assert.equal((await offboardTargetFor({ notion, kv: noticeStore(db), name: 'aarlen' })).candidate?.pageId, 't1');
  assert.equal((await offboardTargetFor({ notion, kv: noticeStore(db), name: 'Aarlen Archer' })).candidate?.pageId, 't1');
  const onlyResearcher = { findCandidatesByName: async q => [researcher].filter(c => c.fullName.toLowerCase().includes(String(q).toLowerCase())) };
  assert.match((await offboardTargetFor({ notion: onlyResearcher, kv: noticeStore(db), name: 'aarlen' })).ask, /^I don't see anyone named aarlen with a Company account or a work trial; the tracker has Aarlen Archer/);
});
