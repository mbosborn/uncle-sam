import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runPipelineCheck } from '../service/lib/pipeline-check.mjs';

const NOW = Date.parse('2026-10-16T18:00:00Z');
const ENV = { UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled' };
function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const person = (id, brief, fields = {}) => ({ pageId: `3f26ba36-8537-8000-8000-0000000000${id}`, fullName: `Person ${id}`, email: `p${id}@example.invalid`, url: 'https://www.notion.so/x',
  profile: { linkedin: `https://www.linkedin.com/in/p${id}` }, fields: { Stage: 'Interview', 'Candidate brief': brief, ...fields } });
const claudeSays = byName => ({ async complete({ messages }) {
  const name = /Candidate: (Person \w+)/.exec(messages[0].content)[1];
  return { content: [{ type: 'tool_use', name: 'pipeline', input: byName[name] }] };
} });

test('Pipeline check: an open candidate with no Pipeline gets US/EU or India from a quote in the record, never COLM; unknown ones go to Project once', async () => {
  const people = [person('a1', 'Based in Bangalore, works at Deccan AI.'), person('a2', 'Lives in Seattle; ex-Amazon.'), person('a3', 'Great RL work.'),
    person('a4', 'Bangalore', { Pipeline: 'US/EU' }), person('a5', 'Research lab in Paris.')];
  const set = [], posted = [];
  const notion = { readControl: async () => ({ mode: 'Live' }), listActiveCandidates: async () => people, listCandidateNotes: async () => [],
    setPipeline: async ({ pageId, pipeline }) => { set.push([pageId.slice(-2), pipeline]); return { verified: true }; }, appendCandidateNote: async () => ({ verified: true }) };
  const claude = claudeSays({ 'Person a1': { pipeline: 'India', quote: 'Based in Bangalore' }, 'Person a2': { pipeline: 'US/EU', quote: 'Lives in Seattle' },
    'Person a3': { pipeline: 'unknown' }, 'Person a5': { pipeline: 'Research (COLM)', quote: 'Research lab' } });
  const db = d1();
  const out = await runPipelineCheck({ env: ENV, db, notion, claude, poster: async t => posted.push(t), clock: () => NOW, force: true });
  assert.deepEqual(set, [['a1', 'India'], ['a2', 'US/EU']]);
  assert.equal(out.asked, 2, 'a3 unknown and a5 (COLM is never chosen)');
  assert.match(posted[0], /No Pipeline/); assert.match(posted[0], /Person a3/); assert.match(posted[0], /Person a5/);
  await runPipelineCheck({ env: ENV, db, notion, claude, poster: async t => posted.push(t), clock: () => NOW + 7200_000, force: true });
  assert.equal(posted.length, 1, 'asked once');
});
