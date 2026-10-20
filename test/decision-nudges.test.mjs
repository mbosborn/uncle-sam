import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runDecisionNudges, handleDecisionReply, businessDaysBetween, inWindow, intentOf } from '../service/lib/decision-nudges.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const ROBIN = 'U0A4F08721B', INTERVIEWER = 'U030A09DBFF', PROJECT = 'U0F9EF97D89';
const at = s => Date.parse(s); // UTC; Pacific is UTC-7 in October

test('Decisions: business days, the sending window, and what a reply says', () => {
  assert.equal(businessDaysBetween(at('2026-10-16T22:00:00Z'), at('2026-10-19T17:00:00Z')), 1, 'Fri afternoon to Mon: one');
  assert.equal(businessDaysBetween(at('2026-10-16T22:00:00Z'), at('2026-10-20T17:00:00Z')), 2);
  assert.equal(businessDaysBetween(at('2026-10-16T22:00:00Z'), at('2026-10-18T17:00:00Z')), 0, 'the weekend does not count');
  assert.ok(inWindow(at('2026-10-20T17:30:00Z')), 'Tue 10:30 AM PT');
  assert.ok(!inWindow(at('2026-10-20T16:30:00Z')), 'Tue 9:30 AM PT');
  assert.ok(!inWindow(at('2026-10-17T17:30:00Z')), 'Saturday');
  assert.equal(intentOf('reject'), 'reject');
  assert.equal(intentOf('Casey advance'), 'advance');
  assert.equal(intentOf('put him on hold for now'), 'hold');
  assert.equal(intentOf('already done'), 'done');
  assert.equal(intentOf('ask me later'), 'later');
  assert.equal(intentOf("not mine, ask Robin"), 'not_mine');
  assert.equal(intentOf('reject or advance, not sure'), null, 'conflicting calls go to Project');
  assert.equal(intentOf('he was solid'), null);
});

function world({ takers = [ROBIN], requests = [] } = {}) {
  const w = { db: d1(), posts: [], project: [], closed: [], outcomes: [], notes: [], n: 0 };
  w.candidate = { pageId: 'c1', fullName: 'Casey Reed', email: 'caseyjreed@example.test', url: 'https://www.notion.so/c1', profile: { linkedin: 'linkedin.com/in/sample-84422f0bf3b2' },
    fields: { Stage: 'Intro Call', Round: 'R1 — Intro', Outcome: 'Not Yet Decided' } };
  w.rows = [{ id: 'iv1', summary: 'Interview · Casey Reed · 30 Min call Robin', end: '2026-10-16T18:00:00Z', status: 'confirmed', candidatePageId: 'c1', interviewerIds: takers }];
  w.notion = { readControl: async () => ({ mode: 'Live' }), listInterviewRows: async () => w.rows, getCandidate: async () => structuredClone(w.candidate),
    findTakeHomeScorecard: async () => null, appendCandidateNote: async n => { w.notes.push(n); return { verified: true }; },
    closeCandidate: async a => { w.closed.push(a); return { verified: true }; }, setOutcome: async a => { w.outcomes.push(a); return { verified: true }; } };
  w.store = { listRequestsForCandidate: async () => requests };
  w.poster = (channelId, threadTs = null) => async text => { const ts = `17922${String(++w.n).padStart(5, '0')}.000100`; w.posts.push({ channelId, threadTs, text, ts }); return ts; };
  w.run = now => runDecisionNudges({ env: { UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled' }, db: w.db, notion: w.notion, store: w.store,
    routeMap: { interviewer_rishi: { channelId: 'D0RISHI001' }, interviewer_santosh: { channelId: 'D0SANTO001' } },
    groupRoutes: { routes: { group_rishi_santosh: { channelId: 'G0GROUP001' } }, ensure: async () => 'group_rishi_santosh' },
    poster: w.poster, masonPoster: async t => { w.project.push(t); }, clock: () => now });
  w.reply = (text, author = ROBIN, now = at('2026-10-20T18:00:00Z')) => handleDecisionReply({ event: { channelId: w.posts[0].channelId, threadTs: w.posts[0].ts,
    messageTs: '1792300000.000100', authorId: author, text }, db: w.db, notion: w.notion, poster: w.poster, masonPoster: async t => { w.project.push(t); }, clock: () => now });
  return w;
}

test('Decisions: an intro call Friday, nothing moves; Robin asked Tuesday, again Thursday, then one line to Project and silence', async () => {
  const w = world();
  assert.equal((await w.run(at('2026-10-16T15:00:00Z'))).state, 'baselined');
  assert.equal((await w.run(at('2026-10-16T19:00:00Z'))).tracked, 1, 'first sight after the interview: noted');
  await w.run(at('2026-10-19T17:30:00Z'));
  assert.equal(w.posts.length, 0, 'Monday: one business day');
  await w.run(at('2026-10-20T16:30:00Z'));
  assert.equal(w.posts.length, 0, 'Tuesday 9:30 AM: before the window');
  await w.run(at('2026-10-20T17:05:00Z'));
  assert.equal(w.posts.length, 1);
  assert.equal(w.posts[0].channelId, 'D0RISHI001');
  assert.equal(w.posts[0].text, '📋 This one is waiting on a decision. Nothing has moved since the intro call:\n• <https://www.linkedin.com/in/sample-84422f0bf3b2|Casey Reed> · Intro call Fri Oct 16\nReply here with "advance", "reject" or "hold". Or "done" if it\'s handled, "later" to hear from me in two business days, "not mine" to pass it to Project.');
  await w.run(at('2026-10-20T18:30:00Z'));
  await w.run(at('2026-10-21T17:30:00Z'));
  assert.equal(w.posts.length, 1, 'once a day at most, two business days apart');
  await w.run(at('2026-10-22T17:30:00Z'));
  assert.equal(w.posts.length, 2);
  assert.match(w.posts[1].text, /Intro call Fri Oct 16 \(second ask\)/);
  await w.run(at('2026-10-26T17:30:00Z'));
  assert.equal(w.posts.length, 2);
  assert.equal(w.project.length, 1);
  assert.match(w.project[0], /^📋 Still no decision on this one, and I've stopped asking:\n• <https:\/\/www\.linkedin\.com\/in\/sample-84422f0bf3b2\|Casey Reed> · Intro call Fri Oct 16 \(Robin, asked 2x\)$/);
  await w.run(at('2026-10-28T17:30:00Z'));
  assert.equal(w.posts.length + w.project.length, 3, 'never again');
});

test('Decisions: anything that moves stops it for good — the record, a request after the interview, a closed record', async () => {
  const w = world();
  await w.run(at('2026-10-16T15:00:00Z')); await w.run(at('2026-10-16T19:00:00Z'));
  w.candidate.fields.Stage = 'Case Study';
  await w.run(at('2026-10-20T17:30:00Z'));
  w.candidate.fields.Stage = 'Intro Call';
  await w.run(at('2026-10-22T17:30:00Z'));
  assert.equal(w.posts.length + w.project.length, 0);
  const r = world({ requests: [{ action: 'email.takehome_pending', state: 'Complete', createdAt: at('2026-10-17T18:00:00Z') }, { action: 'interview.feedback_request', state: 'Complete', createdAt: at('2026-10-16T18:05:00Z') }] });
  await r.run(at('2026-10-16T15:00:00Z')); await r.run(at('2026-10-16T19:00:00Z')); await r.run(at('2026-10-20T17:30:00Z'));
  assert.equal(r.posts.length, 0, 'a take-home invite after the interview is a decision');
  const f = world({ requests: [{ action: 'interview.feedback_request', state: 'Sent', createdAt: at('2026-10-16T18:05:00Z') }] });
  await f.run(at('2026-10-16T15:00:00Z')); await f.run(at('2026-10-16T19:00:00Z')); await f.run(at('2026-10-20T17:30:00Z'));
  assert.equal(f.posts.length, 0, 'feedback still open: its own reminder has the floor');
  await f.run(at('2026-10-22T17:30:00Z'));
  assert.equal(f.posts.length, 1, 'four business days on, the decision is asked anyway');
  const g = world({ takers: [ROBIN, INTERVIEWER] });
  await g.run(at('2026-10-16T15:00:00Z')); await g.run(at('2026-10-16T19:00:00Z')); await g.run(at('2026-10-20T17:30:00Z'));
  assert.equal(g.posts[0].channelId, 'G0GROUP001', 'taken together: their group DM');
  assert.match(g.posts[0].text, /since the intro call you took together/);
});

test('Decisions: replies — reject closes the record with the interview as the last step; later pauses; Interviewer cannot hold', async () => {
  const w = world();
  await w.run(at('2026-10-16T15:00:00Z')); await w.run(at('2026-10-16T19:00:00Z')); await w.run(at('2026-10-20T17:30:00Z'));
  const out = await w.reply('reject');
  assert.equal(out.reason, 'reject');
  assert.equal(w.closed[0].outcome, 'Not Selected');
  assert.equal(w.closed[0].interviewEnd.at, '2026-10-16T18:00:00.000Z');
  assert.match(w.posts.at(-1).text, /^🫡 Casey Reed is Not Selected\. The rejection email goes out within the hour, unless Rejection email hold is set\.$/);
  assert.equal(w.posts.at(-1).threadTs, w.posts[0].ts);
  assert.match(w.project.at(-1), /Robin rejected Casey Reed in my decision check/);
  await w.run(at('2026-10-22T17:30:00Z'));
  assert.equal(w.posts.filter(p => !p.threadTs).length, 1, 'answered: never asked again');

  const l = world();
  await l.run(at('2026-10-16T15:00:00Z')); await l.run(at('2026-10-16T19:00:00Z')); await l.run(at('2026-10-20T17:30:00Z'));
  assert.equal((await l.reply('ask me later')).reason, 'later');
  assert.match(l.posts.at(-1).text, /^🫡 I'll ask again Thu Oct 22\.$/);
  await l.run(at('2026-10-21T17:30:00Z'));
  assert.equal(l.posts.filter(p => !p.threadTs).length, 1);

  const s = world({ takers: [INTERVIEWER] });
  await s.run(at('2026-10-16T15:00:00Z')); await s.run(at('2026-10-16T19:00:00Z')); await s.run(at('2026-10-20T17:30:00Z'));
  assert.equal((await s.reply('put him on hold', INTERVIEWER)).reason, 'hold_relayed');
  assert.equal(s.outcomes.length, 0);
  assert.match(s.project.at(-1), /Only Robin, Alexis or you can, so I changed nothing/);
  assert.equal(await s.reply('reject', PROJECT === INTERVIEWER ? ROBIN : 'U0NOBODY01'), null, 'someone else in the thread is not an answer');
});
