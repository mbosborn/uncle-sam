import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { companyOf, titleMatches, placeMatches, runClayProspecting, handleClaySourcingCommand, readPool } from '../service/lib/clay-sourcing.mjs';
import { runDailySourcing } from '../service/lib/sourcing.mjs';
import { noticeStore } from '../service/lib/stuck-rejections.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const PROJECT = 'U0F9EF97D89';
const at = s => Date.parse(s);
const MORNING = at('2026-10-19T14:00:00Z'); // 7 AM PT

test('Companies, titles and places as Project types them', () => {
  assert.deepEqual(companyOf('https://www.Zepto.com/careers'), { key: 'zepto.com', label: 'zepto.com', input: { 'Company Domain': 'zepto.com' } });
  assert.deepEqual(companyOf('linkedin.com/company/razorpay/'), { key: 'li:razorpay', label: 'razorpay', input: { 'Company Social Profile URL': 'https://www.linkedin.com/company/razorpay' } });
  assert.equal(companyOf('Zepto'), null);
  assert.equal(titleMatches('Senior ML Engineer II', ['ML engineer']), true);
  assert.equal(titleMatches('Engineering Manager', ['ML engineer', 'data scientist']), false);
  assert.equal(titleMatches('anything', []), true);
  assert.equal(placeMatches('Bengaluru, Karnataka, India', ['India']), true);
  assert.equal(placeMatches('Berlin', ['India']), false);
});

test('Project\'s commands set the lists; the morning runs a few companies in Clay, rotating, and the matches land in the pool the daily ten draws from', async () => {
  const db = d1(), said = [];
  const cmd = text => handleClaySourcingCommand({ event: { authorId: PROJECT, channelId: 'D1', messageTs: '1.1', text }, db, clock: () => MORNING, poster: () => async t => said.push(t) });
  assert.equal(await cmd('hello'), null);
  await cmd('sourcing companies: zepto.com, https://swiggy.com, linkedin.com/company/razorpay, Acme');
  assert.match(said[0], /^Roger that 🫡 3 companies; I look through 3 a day in Clay\. Tell me which titles: .*Not companies: Acme\.$/);
  await cmd('sourcing titles: ML engineer, data scientist');
  await cmd('sourcing places: India');
  await cmd('sourcing companies');
  assert.equal(said.at(-1), '📋 Sourcing companies: zepto.com, swiggy.com, razorpay.');
  const started = [];
  let done = false;
  const clay = {
    startWith: async (routine, items) => { started.push(items[0].inputs); return `run${started.length}`; },
    results: async runId => (done ? new Map([['c0', { result: { people: [
      { name: 'Priya Shah', linkedin_url: 'https://www.linkedin.com/in/priya-shah', title: 'Senior ML Engineer', location: 'Bengaluru, India' },
      { name: 'Max Mueller', linkedin_url: 'https://www.linkedin.com/in/maxm', title: 'ML Engineer', location: 'Berlin' },
      { name: 'Ana Ops', linkedin_url: 'https://www.linkedin.com/in/ana-ops', title: 'Operations Lead', location: 'India' }] } }]]) : null) };
  const env = { SOURCING_CLAY_COMPANIES_PER_DAY: '2' };
  assert.equal((await runClayProspecting({ env, db, clay, clock: () => at('2026-10-19T13:00:00Z') })).started, 0, '6 AM PT: not yet');
  const first = await runClayProspecting({ env, db, clay, clock: () => MORNING });
  assert.equal(first.started, 2);
  assert.deepEqual(started, [{ 'Company Domain': 'zepto.com' }, { 'Company Domain': 'swiggy.com' }]);
  assert.equal((await runClayProspecting({ env, db, clay, clock: () => MORNING + 300_000 })).started, 0, 'once a day');
  done = true;
  const collected = await runClayProspecting({ env, db, clay, clock: () => MORNING + 600_000 });
  assert.equal(collected.collected, 2);
  assert.deepEqual((await readPool(db)).map(p => [p.slug, p.from]), [['priya-shah', 'clay']], 'title and place filtered, de-duplicated');
  await runClayProspecting({ env, db, clay, clock: () => MORNING + 86400_000 });
  assert.deepEqual(started.slice(2), [{ 'Company Social Profile URL': 'https://www.linkedin.com/company/razorpay' }, { 'Company Domain': 'zepto.com' }], 'the next day picks up where it left off');
  // The daily ten works from the pool alone (no Juicebox yet).
  const dms = [];
  const daily = await runDailySourcing({ db, claude: { complete: async () => ({ content: [{ type: 'tool_use', name: 'pick', input: { picks: (await readPool(db)).map(p => ({ slug: p.slug, why: 'fixture fit' })) } }] }) }, notion: { readControl: async () => ({ mode: 'Live' }) }, clock: () => at('2026-10-19T16:00:00Z'), poster: async t => { dms.push(t); return '1792.1'; }, poolLeads: () => readPool(db) });
  assert.equal(daily.picked, 1);
  assert.match(dms[0], /^New candidates:\n\n• <https:\/\/www\.linkedin\.com\/in\/priya-shah\|Priya Shah> — Senior ML Engineer/);
  void noticeStore;
});
