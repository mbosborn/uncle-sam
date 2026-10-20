import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { findMoves, movesMessage, approvedOf, proposeMoves, handleMovesReply, runTrackerMove, commandText } from '../service/lib/meeting-moves.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const PROJECT = 'U0F9EF97D89', DM = 'D0C95KBR09J', NOW = Date.parse('2026-10-18T18:00:00Z');
const KASON = { pageId: 'p-kason', fullName: 'Kason', email: 'kason@x.co', fields: { Stage: 'Case Study', Outcome: 'Proceeding' } };
const ABHI = { pageId: 'p-abhi', fullName: 'Logan Wells', email: 'abhi@x.co', fields: { Stage: 'Interview', Outcome: 'Not Yet Decided', From: 'Acme' } };
const DYLAN = { pageId: 'p-dylan', fullName: 'Dylan Hayes', email: 'ak@x.co', fields: { Stage: 'Interview', Outcome: 'On Hold' } };
const TRANSCRIPT = `Project: Uncle Sam, put Kason on hold for now. Robin: Logan did well, send him the take-home. Robin: Dylan, let's take him off hold, he's in Bangalore. Robin: maybe we look at Ryan later.`;
const claudeReports = input => ({ complete: async () => ({ content: [{ type: 'tool_use', name: 'report_moves', input }] }) });

test('the meeting\'s moves: quoted word for word, one candidate each; a made-up quote or an unknown name is "not sure"', async () => {
  const claude = claudeReports({ moves: [
    { candidate_id: 'p-kason', move: 'hold', quote: 'Uncle Sam, put Kason on hold for now.', said_by: 'Project' },
    { candidate_id: 'p-abhi', move: 'take_home', quote: 'Logan did well, send him the take-home.', said_by: 'Robin' },
    { candidate_id: 'p-dylan', move: 'unhold', quote: "Dylan, let's take him off hold", said_by: 'Robin' },
    { candidate_id: 'p-dylan', move: 'pipeline', detail: 'India', quote: "he's in Bangalore", said_by: 'Robin' },
    { candidate_id: 'p-abhi', move: 'withdraw', quote: 'Logan has withdrawn from the process.' },
    { candidate_id: 'p-ryan', move: 'hold', quote: 'maybe we look at Ryan later' }], unclear: [] });
  const found = await findMoves({ claude, meeting: { title: 'Recruiting sync' }, transcript: TRANSCRIPT, candidates: [KASON, ABHI, DYLAN] });
  assert.deepEqual(found.moves.map(m => `${m.move}:${m.candidate.pageId}`), ['hold:p-kason', 'take_home:p-abhi', 'unhold:p-dylan', 'pipeline:p-dylan']);
  assert.equal(found.unclear.length, 2);
  assert.equal(movesMessage({ title: 'Recruiting sync' }, found.moves, []),
    '📋 From *Recruiting sync*: approve these?\n1. Put Kason on hold\n2. Send Logan Wells the take-home\n3. Take Dylan Hayes off hold\n4. Set Dylan Hayes to the India pipeline\nReply yes for all, "yes but not 2", "only 1 and 3", or no.');
});

test('his answer: yes / anything affirmative = all; "yes but not 2"; "only 1 and 3"; "1, 3"; no = none; a question is not an answer', () => {
  assert.deepEqual(approvedOf('yes', 4), [0, 1, 2, 3]);
  assert.deepEqual(approvedOf('do it 👍', 4), [0, 1, 2, 3]);
  assert.deepEqual(approvedOf('yes but not 2', 4), [0, 2, 3]);
  assert.deepEqual(approvedOf('all except 2 and 4', 4), [0, 2]);
  assert.deepEqual(approvedOf('skip 3', 4), [0, 1, 3]);
  assert.deepEqual(approvedOf('only 1 and 3', 4), [0, 2]);
  assert.deepEqual(approvedOf('1, 3', 4), [0, 2]);
  assert.deepEqual(approvedOf('no', 4), []);
  assert.equal(approvedOf('who is 2?', 4), null);
  assert.equal(approvedOf('hmm', 4), null);
});

test('"yes but not 2": tracker moves done with a note, the others run as his commands, once; a second answer changes nothing', async () => {
  const db = d1(), posted = [], outcomes = [], pipelines = [], commands = [];
  const records = { 'p-kason': { ...KASON }, 'p-abhi': { ...ABHI }, 'p-dylan': { ...DYLAN } };
  const notion = { getCandidate: async id => records[id], setOutcome: async ({ pageId, outcome }) => outcomes.push([pageId, outcome]),
    setPipeline: async ({ pageId, pipeline }) => pipelines.push([pageId, pipeline]), appendCandidateNote: async () => null };
  const found = { moves: [
    { candidate: KASON, move: 'hold', detail: '', quote: 'put Kason on hold', saidBy: 'Project' },
    { candidate: ABHI, move: 'take_home', detail: '', quote: 'send him the take-home', saidBy: 'Robin' },
    { candidate: DYLAN, move: 'pipeline', detail: 'India', quote: "he's in Bangalore", saidBy: 'Robin' }], unclear: [] };
  const ts = await proposeMoves({ db, meeting: { title: 'Recruiting sync' }, found, poster: async t => { posted.push(t); return '1792400000.000100'; }, masonChannel: DM, clock: () => NOW });
  const reply = text => handleMovesReply({ event: { authorId: PROJECT, channelId: DM, threadTs: ts, messageTs: '1792400100.000100', text }, db, masonId: PROJECT, clock: () => NOW,
    poster: () => async t => posted.push(t),
    run: async (m, ctx) => (await runTrackerMove({ db, notion, move: m, title: ctx.title, source: ctx.source, index: ctx.index, clock: () => NOW })) ?? (commands.push(commandText(m)), null) });
  assert.equal(await reply('who is 3?'), null);
  const out = await reply('yes but not 2');
  assert.equal(out.done, 2);
  assert.deepEqual(outcomes, [['p-kason', 'On Hold']]);
  assert.deepEqual(pipelines, [['p-dylan', 'India']]);
  assert.deepEqual(commands, []);
  assert.equal(posted.at(-2), 'Roger that 🫡 Doing 1, 3.');
  assert.equal(posted.at(-1), '✓ 1. Put Kason on hold\n✓ 3. Set Dylan Hayes to the India pipeline');
  assert.equal((await reply('yes')).reason, 'already_answered');
  assert.equal(outcomes.length, 1, 'never twice');
  assert.equal(commandText({ move: 'take_home', fullName: 'Logan Wells', from: 'Acme' }), 'send Logan Wells from Acme the take-home');
  assert.equal(commandText({ move: 'send_docs', fullName: 'Kason', detail: '$120/day' }), 'send Kason the work trial docs at $120/day');
  assert.equal(await handleMovesReply({ event: { authorId: PROJECT, channelId: DM, threadTs: ts, messageTs: '1.2', text: 'yes', synthetic: true }, db, masonId: PROJECT, run: async () => null, poster: () => async () => {} }), null, 'its own commands are never read as answers');
});

test('Project, 2026-10-20 (Peyton Morris): "move forward (technical deep dive)" on a submitted take-home marks it passed so the deep-dive invite goes; answered in the main DM by pasting the moves', async () => {
  const db = d1(), posted = [], stage = [], reviews = [];
  const PEYTON = { pageId: 'p-peyton', fullName: 'Peyton Morris', email: 'k@x.co', fields: { Stage: 'Case Study', Outcome: 'Proceeding' } };
  const KANI = { pageId: 'p-kani', fullName: 'Jamie Powell', email: 'ks@x.co', fields: { Stage: 'Case Study', Outcome: 'Proceeding' } };
  const records = { 'p-peyton': PEYTON, 'p-kani': KANI, 'p-dylan': { ...DYLAN } };
  const cards = { 'p-peyton': { pageId: 'card-peyton', status: 'Complete', score: 82, takeHomeReview: 'Awaiting review', deepDive: null, santoshReview: null },
    'p-kani': { pageId: 'card-kani', status: 'Started', score: null, takeHomeReview: null, deepDive: null, santoshReview: null } };
  const notion = { getCandidate: async id => records[id], setOutcome: async () => null, appendCandidateNote: async () => null,
    findTakeHomeScorecard: async id => cards[id] ?? null, setStageFields: async a => stage.push([a.scorecardPageId, a.fields['Take-home review']]),
    recordTakeHomeReview: async a => reviews.push([a.scorecardPageId, a.recommendation]) };
  const found = { moves: [
    { candidate: KANI, move: 'advance', detail: 'technical deep dive', quote: 'move Jamie to the deep dive', saidBy: 'Interviewer' },
    { candidate: PEYTON, move: 'advance', detail: 'technical deep dive', quote: 'Peyton, send the deep dive', saidBy: 'Interviewer' },
    { candidate: DYLAN, move: 'hold', detail: '', quote: 'hold Dylan', saidBy: 'Robin' }], unclear: [] };
  await proposeMoves({ db, meeting: { title: 'Recruiting', share_link: 'https://notes.wisprflow.ai/shared/x' }, found, poster: async t => { posted.push(t); return '1792400000.000100'; }, masonChannel: DM, clock: () => NOW });
  const run = async (m, ctx) => runTrackerMove({ db, notion, move: m, title: ctx.title, source: ctx.source, index: ctx.index, clock: () => NOW });
  // A plain top-level "yes" with no list wording isn't taken as an answer.
  assert.equal(await handleMovesReply({ event: { authorId: PROJECT, channelId: DM, messageTs: '1792400200.000100', text: 'yes' }, db, masonId: PROJECT, clock: () => NOW, poster: () => async t => posted.push(t), run }), null);
  const out = await handleMovesReply({ event: { authorId: PROJECT, channelId: DM, messageTs: '1792400300.000100',
    text: '1. Move Jamie Powell forward (technical deep dive)\n2. Move Peyton Morris forward (technical deep dive)\n\nyes do this' }, db, masonId: PROJECT, clock: () => NOW, poster: () => async t => posted.push(t), run });
  assert.equal(out.done, 2, 'only the two he pasted, not the hold');
  assert.deepEqual(stage, [['card-peyton', 'Passed take-home']]);
  assert.deepEqual(reviews, [['card-peyton', 'Advance recommended']]);
  assert.match(posted.at(-1), /✓ 1\. Move Jamie Powell forward \(technical deep dive\): their take-home isn't submitted yet \(started\)/);
  assert.match(posted.at(-1), /✓ 2\. Move Peyton Morris forward \(technical deep dive\): take-home marked passed \(portal 82\/100\)\. Interviewer's deep-dive invite goes from your Gmail after the usual 30-minute Cancel\./);
});

test('Project, 2026-10-20: moves already done live are left out of the list ("Already done, so not asked"), not asked again', async () => {
  const { dropDone } = await import('../service/lib/meeting-moves.mjs');
  const records = { 'p-kason': { ...KASON, fields: { ...KASON.fields, Outcome: 'On Hold' } }, 'p-abhi': { ...ABHI }, 'p-dylan': { ...DYLAN, fields: { ...DYLAN.fields, Pipeline: 'India' } },
    'p-kar': { pageId: 'p-kar', fullName: 'Peyton Morris', fields: { Outcome: 'Proceeding' } } };
  const notion = { getCandidate: async id => records[id], findTakeHomeScorecard: async id => (id === 'p-abhi' ? { status: 'Not started' } : id === 'p-kar' ? { status: 'Complete', takeHomeReview: 'Passed take-home', deepDive: 'Invite sent' } : null) };
  const found = { moves: [
    { candidate: KASON, move: 'hold', quote: 'q', saidBy: 'Project' },
    { candidate: ABHI, move: 'take_home', quote: 'q', saidBy: 'Robin' },
    { candidate: DYLAN, move: 'pipeline', detail: 'India', quote: 'q', saidBy: 'Robin' },
    { candidate: records['p-kar'], move: 'advance', detail: 'technical deep dive', quote: 'q', saidBy: 'Interviewer' },
    { candidate: DYLAN, move: 'unhold', quote: 'q', saidBy: 'Robin' }], unclear: [] };
  const { moves, done } = await dropDone({ found, notion });
  assert.deepEqual(moves.map(m => m.move), ['unhold'], 'only the one still to do');
  assert.deepEqual(done.map(d => d.why), ['already On Hold', 'take-home already sent', 'already India', 'deep dive already invite sent']);
  assert.match(movesMessage({ title: 'Recruiting' }, moves, [], done), /Already done, so not asked: Put Kason on hold \(already On Hold\); Send Logan Wells the take-home \(take-home already sent\)/);
});
