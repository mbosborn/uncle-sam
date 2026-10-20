import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { pickOption, rememberWhichOne, resolveWhichOne, recoverFromThread } from '../service/lib/which-one.mjs';
import { candidateFinder } from '../service/lib/docusign-send.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const NOW = Date.parse('2026-10-18T00:34:00Z');
const ARLENS = [
  { pageId: 'p-aarlen', fullName: 'Aarlen Archer', email: 'aarlen@example.invalid', fields: { Stage: 'Interview', Pipeline: 'Research', From: 'Research', Outcome: 'Proceeding' }, profile: { from: 'Research' } },
  { pageId: 'p-arlen', fullName: 'Arlen Archer', email: 'arlenexample@example.test', fields: { Stage: 'Trial', Pipeline: 'India', From: 'Zepto', Outcome: 'Proceeding' }, profile: { from: 'Zepto' } },
];

test('"the one on the work trial", "Zepto", "the second", a full name: each picks one; nothing that fits picks none', async () => {
  const notion = { findCandidatesByName: async n => ARLENS.filter(c => /a+rlen/i.test(n) || c.fullName.toLowerCase().includes(n.toLowerCase())) };
  const found = await candidateFinder({ notion, history: async () => [] })("can you resend arlen's documents?", {});
  assert.deepEqual(found.ambiguous, ['Aarlen Archer (Research)', 'Arlen Archer (Zepto)']);
  const options = found.options;
  assert.equal(pickOption('the one on the work trial', options).pageId, 'p-arlen');
  assert.equal(pickOption('zepto', options).pageId, 'p-arlen');
  assert.equal(pickOption('the research one', options).pageId, 'p-aarlen');
  assert.equal(pickOption('the second', options).pageId, 'p-arlen');
  assert.equal(pickOption('Aarlen Archer', options).pageId, 'p-aarlen');
  assert.equal(pickOption('thanks', options), null);
});

test('the reply in the thread runs the original command for the one picked; once; a new command is not taken as an answer', async () => {
  const db = d1();
  const ask = { channelId: 'D0C95KBR09J', messageTs: '1792283616.000100', threadTs: null, text: "can you resend arlen's documents?" };
  const options = ARLENS.map(c => ({ pageId: c.pageId, fullName: c.fullName, email: c.email, from: c.fields.From, stage: c.fields.Stage, pipeline: c.fields.Pipeline }));
  await rememberWhichOne({ db, event: ask, text: ask.text, options, clock: () => NOW });
  const reply = { channelId: 'D0C95KBR09J', messageTs: '1792283680.000100', threadTs: '1792283616.000100', text: 'the one on the work trial' };
  const out = await resolveWhichOne({ db, event: reply, clock: () => NOW + 60_000 });
  assert.equal(out.text, "can you resend arlen's documents?");
  assert.equal(out.who.pageId, 'p-arlen');
  assert.equal(await resolveWhichOne({ db, event: reply, clock: () => NOW + 120_000 }), null, 'used once');
  await rememberWhichOne({ db, event: ask, text: ask.text, options, clock: () => NOW });
  assert.equal(await resolveWhichOne({ db, event: { channelId: 'D0C95KBR09J', messageTs: '1792283700.000100', threadTs: null, text: 'send Logan Wells the take-home' }, clock: () => NOW + 60_000 }), null);
  assert.equal((await resolveWhichOne({ db, event: { channelId: 'D0C95KBR09J', messageTs: '1792283710.000100', threadTs: null, text: 'zepto' }, clock: () => NOW + 60_000 })).who.pageId, 'p-arlen', 'short top-level reply right after');
});

test('a thread whose question came before the options were kept: "the one on the work trial", then "resend them to him" resends Arlen', async () => {
  const PROJECT = 'U0F9EF97D89', BOT = 'B0BOT';
  const notion = { findCandidatesByName: async n => ARLENS.filter(c => /a+rlen/i.test(n) || c.fullName.toLowerCase().includes(n.toLowerCase())) };
  const finder = candidateFinder({ notion, history: async () => [] });
  const thread = [{ ts: '1792283616.000100', user: PROJECT, text: "can you resend arlen's documents?" },
    { ts: '1792283620.000100', botId: BOT, text: '📋 Which one: Aarlen Archer or Arlen Archer (Zepto)? Reply with their full name and I\'ll resend.' },
    { ts: '1792283680.000100', user: PROJECT, text: 'the one on the work trial' },
    { ts: '1792283690.000100', botId: BOT, text: 'Roger that: the work-trial candidate is Arlen Archer (India, Zepto), not Aarlen Archer (Research).' },
    { ts: '1792285900.000100', user: PROJECT, text: 'resend them to him' }];
  const ev = text => ({ channelId: 'D0C95KBR09J', threadTs: '1792283616.000100', messageTs: '1792285900.000100', authorId: PROJECT, text });
  const out = await recoverFromThread({ event: ev('resend them to him'), masonId: PROJECT, finder, readThread: async () => thread });
  assert.equal(out.text, "can you resend arlen's documents?");
  assert.equal(out.who.pageId, 'p-arlen');
  assert.equal(await recoverFromThread({ event: ev('thanks'), masonId: PROJECT, finder, readThread: async () => thread }), null, 'not a go-ahead');
  assert.equal((await recoverFromThread({ event: ev('zepto'), masonId: PROJECT, finder, readThread: async () => thread })).who.pageId, 'p-arlen');
});
