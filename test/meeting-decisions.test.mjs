import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { findDecisions, applyMeetingDecisions, decisionsMessage, DECISIONS_DIGEST } from '../service/lib/meeting-decisions.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const CASEY = { pageId: 'c1', fullName: 'Casey Reed', email: 'casey@example.com', fields: { Stage: 'Intro Call', Outcome: 'Not Yet Decided', Pipeline: null } };
const DAKOTA = { pageId: 'c2', fullName: 'Dakota Hughes', email: 'k@example.com', fields: { Stage: 'Interview', Outcome: 'Not Yet Decided', Pipeline: null } };
const REAGAN = { pageId: 'c3', fullName: 'Reagan Turner', email: 's@example.com', fields: { Stage: 'Case Study', Outcome: 'Proceeding', Pipeline: 'India' } };
const TRANSCRIPT = `Robin: Casey was great, let's send Casey the take-home. He's based in Toronto by the way.
Project: Dakota, let's put him on hold until Interviewer is back. He's in Hyderabad.
Alexis: Reagan is in Pune now.
Project: Maybe we move Reagan forward, not sure yet.`;
const MEETING = { id: 'm1', title: 'Recruiting sync', start: '2026-10-16T17:00:00Z', end: '2026-10-16T17:30:00Z', share_link: 'https://notes.wisprflow.ai/shared/x' };
const claudeSaying = input => ({ complete: async req => { claudeSaying.last = req; return { content: [{ type: 'tool_use', name: 'report_meeting_decisions', input }] }; } });

test('Meeting decisions: the rules are plain in the prompt', () => {
  assert.match(DECISIONS_DIGEST, /NOT advance: maybe, leaning yes, probably/);
  assert.match(DECISIONS_DIGEST, /A work trial counts only when Robin decides it/);
  assert.match(DECISIONS_DIGEST, /NOT based: where they studied, grew up or come from, their name, a guess/);
});

test('Meeting decisions: only word-for-word quotes about one listed candidate count; two different things about one person count for neither', async () => {
  const found = await findDecisions({ meeting: MEETING, transcript: TRANSCRIPT, candidates: [CASEY, DAKOTA, REAGAN], claude: claudeSaying({
    advance: [{ candidate_id: 'c1', heard_as: 'Casey', quote: "let's send Casey the take-home", decided_by: 'Robin', next_step: 'take-home' },
      { candidate_id: 'c3', heard_as: 'Reagan', quote: 'Reagan is cleared for the work trial', decided_by: 'Project', next_step: 'work trial' }],
    hold: [{ candidate_id: 'c2', heard_as: 'Dakota', quote: "Dakota, let's put him on hold until Interviewer is back.", decided_by: 'Project' }],
    based: [{ candidate_id: 'c1', heard_as: 'Casey', quote: "He's based in Toronto by the way.", pipeline: 'US/EU', place: 'Toronto' },
      { candidate_id: 'c2', heard_as: 'Dakota', quote: "He's in Hyderabad.", pipeline: 'India', place: 'Hyderabad' },
      { candidate_id: 'c2', heard_as: 'Dakota', quote: "He's based in Toronto by the way.", pipeline: 'US/EU', place: 'Toronto' }],
    unclear: [{ heard_as: 'Reagan', quote: 'Maybe we move Reagan forward, not sure yet.', reason: 'not final' }] }) });
  assert.deepEqual(found.advance.map(e => e.candidate.fullName), ['Casey Reed']);
  assert.deepEqual(found.hold.map(e => e.candidate.fullName), ['Dakota Hughes']);
  assert.deepEqual(found.based.map(e => [e.candidate.fullName, e.pipeline]), [['Casey Reed', 'US/EU']]);
  assert.deepEqual(found.unclear.map(u => u.reason), ['could not be found word for word in the transcript', 'the meeting said two different things', 'the meeting said two different things', 'not final']);
});

test('Meeting decisions: applied quietly with notes; decision checks stop; a record that says otherwise is left for Project', async () => {
  const db = d1(), now = Date.parse('2026-10-16T18:00:00Z');
  await db.prepare('INSERT INTO uncle_sam_notices (name, value, updated_at) VALUES (?, ?, ?)').bind('decision:iv1', JSON.stringify({ candidateId: 'c1', asks: [] }), now).run();
  const records = new Map([[CASEY.pageId, structuredClone(CASEY)], [DAKOTA.pageId, structuredClone(DAKOTA)], [REAGAN.pageId, structuredClone(REAGAN)]]);
  const outcomes = [], pipelines = [], notes = [];
  const notion = { getCandidate: async id => structuredClone(records.get(id)), setOutcome: async a => { outcomes.push([a.pageId, a.outcome]); },
    setPipeline: async a => { pipelines.push(a); }, appendCandidateNote: async n => { notes.push(n); } };
  const found = { advance: [{ candidate: CASEY, quote: "let's send Casey the take-home", decidedBy: 'Robin', nextStep: 'take-home' }],
    hold: [{ candidate: DAKOTA, quote: "Dakota, let's put him on hold until Interviewer is back.", decidedBy: 'Project' }],
    based: [{ candidate: CASEY, quote: "He's based in Toronto by the way.", pipeline: 'US/EU' }, { candidate: REAGAN, quote: 'Reagan is in Pune now.', pipeline: 'US/EU' },
      { candidate: DAKOTA, quote: "He's in Hyderabad.", pipeline: 'India' }], unclear: [] };
  const { applied, forMason } = await applyMeetingDecisions({ db, notion, meeting: MEETING, found, clock: () => now });
  assert.deepEqual(outcomes, [['c1', 'Proceeding'], ['c2', 'On Hold']]);
  assert.deepEqual(pipelines.map(p => [p.pageId, p.pipeline, p.indiaStage ?? null]), [['c1', 'US/EU', null], ['c2', 'India', 'First Round']]);
  assert.match(notes[0].text, /^2026-10-16 · Advance \(take-home\) \(recruiting meeting “Recruiting sync”, Robin, via Uncle Sam\): “let's send Casey the take-home”\.$/);
  assert.equal(notes[0].sourceUrl, MEETING.share_link);
  assert.deepEqual(applied.map(a => a.kind), ['advance', 'hold', 'based', 'based']);
  assert.equal(forMason.length, 1);
  assert.match(forMason[0], /Reagan Turner: “Reagan is in Pune now\.” \(sounds US\/EU, but the record says India; I left it\)/);
  assert.match(decisionsMessage(MEETING, forMason), /^📋 From \*Recruiting sync\*, these need your call \(I changed nothing for them\):\n• Reagan Turner/);
  assert.equal(decisionsMessage(MEETING, []), null, 'nothing to say: no message');
  const s = JSON.parse((await db.prepare('SELECT value FROM uncle_sam_notices WHERE name = ?').bind('decision:iv1').first()).value);
  assert.equal(s.stopped, 'meeting_advance');
});
