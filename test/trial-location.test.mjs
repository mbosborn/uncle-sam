import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runTrialLocations, offsetAgrees, decide, locationAskNote } from '../service/lib/trial-location.mjs';
import { noticeStore } from '../service/lib/stuck-rejections.mjs';
import { trialTimeZone } from '../service/lib/checkin-times.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const NOW = Date.parse('2026-10-19T06:00:00Z');
const KENDALL = { pageId: 'p-kendall', fullName: 'Kendall Porter', email: 'kendall.porter@example.test', fields: { Stage: 'Trial', 'Trial Start': '2026-10-24', 'Trial End': '2026-10-25' }, profile: { linkedin: 'https://www.linkedin.com/in/sample-f31dc95fa1cf/' } };
const MAIL = [{ id: 'm1', from: 'kendall.porter@example.test', receivedAt: '2026-10-18T08:00:00Z', text: "Yes, next weekend works for me. I'm only 4 hours ahead of PDT, so regular work hours still work." }];
const gmail = { listInbox: async () => MAIL };
const claudeSays = input => ({ complete: async () => ({ content: [{ type: 'tool_use', name: 'where', input }] }) });
const notion = { listTrialCandidates: async () => [KENDALL], listCandidateNotes: async () => [], appendCandidateNote: async () => null };

test('Kendall (Oct 18): "4 hours ahead of PDT" in his email settles it; no question to Project; LinkedIn agreeing is a double-check', async () => {
  const db = d1();
  // No model needed: his own words (the quoted history below them ignored).
  const out = await runTrialLocations({ db, notion, gmail, claude: null, clock: () => NOW, force: true });
  assert.equal(out.found, 1);
  const { tz, from } = await trialTimeZone({ candidate: KENDALL, kv: noticeStore(db) });
  assert.equal(tz, 'America/Sao_Paulo', 'a usual zone at UTC-3 right now');
  assert.equal(from, 'their time');
  assert.match((await noticeStore(db).get('trialtz:p-kendall')).quote, /4 hours ahead of PDT/);
  // With LinkedIn too (a connected account): both agree.
  const db2 = d1();
  const linkedin = { profile: async () => ({ location: 'São Paulo, Brazil' }) };
  await runTrialLocations({ db: db2, notion, gmail, claude: claudeSays({ tz: 'America/Sao_Paulo', quote: "I'm only 4 hours ahead of PDT" }), linkedin, linkedinAccountId: 'acc1', clock: () => NOW, force: true });
  const both = await noticeStore(db2).get('trialtz:p-kendall');
  assert.deepEqual([both.tz, both.from], ['America/Sao_Paulo', 'São Paulo, Brazil'], 'LinkedIn names the place; the offsets agree');
});

test('A quote that is not in his email, or an offset that does not match the zone, is not used; nothing found: Project may be asked; a clash is named', async () => {
  assert.equal(offsetAgrees("I'm only 4 hours ahead of PDT", 'America/Sao_Paulo', NOW), true);
  assert.equal(offsetAgrees("I'm only 4 hours ahead of PDT", 'Europe/Berlin', NOW), false);
  const db = d1();
  const plain = { listInbox: async () => [{ id: 'm2', from: 'kendall.porter@example.test', receivedAt: '2026-10-18T08:00:00Z', text: 'Yes, next weekend works.\n\nOn Sun, Oct 18 Project wrote:\n> We are based in San Francisco' }] };
  await runTrialLocations({ db, notion, gmail: plain, claude: claudeSays({ tz: 'Europe/Berlin', quote: "I'm based in Berlin" }), clock: () => NOW, force: true });
  assert.equal(await noticeStore(db).get('trialtz:p-kendall'), null, 'invented quote');
  assert.equal(await locationAskNote({ kv: noticeStore(db), pageId: 'p-kendall' }), '', 'looked: Project may be asked');
  assert.equal(await locationAskNote({ kv: noticeStore(d1()), pageId: 'p-kendall' }), null, 'not looked yet: no question');
  const clash = decide({ tz: 'America/Sao_Paulo', from: 'their time', quote: 'x' }, { tz: 'Europe/Lisbon', from: 'LinkedIn: Lisbon', place: 'Lisbon' }, NOW);
  assert.equal(clash.tz, null);
  assert.match(clash.conflict, /their email says "x", but LinkedIn: Lisbon/);
});
