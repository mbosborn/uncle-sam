import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runTasteBackfill, startHistory, handleHistoryCommand, historyState } from '../service/lib/taste-history.mjs';
import { reviewSegments, reviewed, readReview, looseSteers, roleOfLabel } from '../service/lib/profile-reviews.mjs';
import { setRole, rolesOf, handleRoleCommand, forRole } from '../service/lib/sourcing-roles.mjs';
import { rankLeads } from '../service/lib/sourcing.mjs';
import { noticeStore } from '../service/lib/stuck-rejections.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const PROJECT = 'U0F9EF97D89', ROBIN = 'U0A4F08721B', ALEXIS = 'U0476A5BC82', AA = 'U0BF89D1279';
const NOW = Date.parse('2026-10-18T18:00:00Z');
const ts = daysAgo => ((NOW - daysAgo * 86400_000) / 1000).toFixed(6);

// Like Slack's conversations.history: newest first up to `limit`, except that with only `oldest` set it returns the
// window's oldest messages. Returned newest last, as slack-read.mjs does.
const slackLike = history => async ({ oldest, latest, limit = 100 }) => {
  let list = [...history].filter(m => (oldest == null || Number(m.ts) >= Number(oldest)) && (latest == null || Number(m.ts) < Number(latest)))
    .sort((a, b) => Number(b.ts) - Number(a.ts));
  list = oldest != null && latest == null ? list.slice(-limit) : list.slice(0, limit);
  return list.reverse();
};

test('Wrangle lists in the history pass: their people are seen and their companies counted, so the ranking spreads out', async () => {
  const db = d1(), kv = noticeStore(db);
  const session = { tools: [{ name: 'list_collections', inputSchema: {} }, { name: 'get_collection', inputSchema: { type: 'object', required: ['collectionId'], properties: { collectionId: { type: 'string' } } } }],
    client: { call: async (name, args) => (name === 'list_collections' ? { collections: [{ collectionId: 'c1', name: 'ML India' }] }
      : { people: [{ name: 'Dee Four', linkedinUrl: 'https://www.linkedin.com/in/dee-four', currentCompany: 'Zepto' }, { name: 'Eve Five', linkedinUrl: 'https://www.linkedin.com/in/eve-five', currentCompany: 'Zepto' }], asked: args }) } };
  await startHistory({ db, clock: () => NOW });
  await runTasteBackfill({ db, slackRead: null, wrangle: async () => session, clock: () => NOW });
  assert.ok(await kv.get('sourcing:seen:dee-four'));
  assert.equal((await kv.get('sourcing:coverage')).companies.Zepto, 2);
  // At most 2 from one company in a day's picks.
  const leads = ['a', 'b', 'c', 'd'].map(x => ({ slug: x, name: x, company: 'Zepto' })).concat([{ slug: 'e', name: 'e', company: 'Swiggy' }]);
  assert.deepEqual((await rankLeads({ claude: { complete: async () => ({ content: [{ type: 'tool_use', name: 'pick', input: { picks: leads.map(p => ({ slug: p.slug, why: 'fixture fit' })) } }] }) }, leads, taste: {}, count: 4 })).map(p => p.slug), ['a', 'b', 'e']);
});

test('Share-link reviewer feedback in a Wrangle list becomes picks and passes', async () => {
  const { feedbackOf } = await import('../service/lib/taste-history.mjs');
  const got = { members: [
    { personId: 'p1', name: 'Ann One', linkedinUrl: 'https://www.linkedin.com/in/ann-one', title: 'RL Engineer', currentCompany: 'Lab X', feedback: { likes: 2, dislikes: 0, entries: [{ text: 'great RL depth', at: '2026-09-01' }] } },
    { personId: 'p2', name: 'Bo Two', linkedinUrl: 'https://www.linkedin.com/in/bo-two', title: 'SWE', feedback: { likes: 0, dislikes: 1 } },
    { personId: 'p3', name: 'Cy Three', linkedinUrl: 'https://www.linkedin.com/in/cy-three', feedback: { likes: 0, dislikes: 0 } }], cursor: 'p3' };
  assert.deepEqual(feedbackOf(got).map(f => [f.slug, f.verdict, f.reason]), [['ann-one', 'reach_out', 'great RL depth'], ['bo-two', 'pass', '0 likes, 1 dislike']]);
});

test('Coverage counts each person once, and a fresh history pass starts it over', async () => {
  const { bumpCoverage } = await import('../service/lib/sourcing.mjs');
  const db = d1(), kv = noticeStore(db);
  const people = [{ slug: 'a', company: 'Meta' }, { slug: 'b', company: 'Meta' }];
  await bumpCoverage(kv, people, NOW);
  await bumpCoverage(kv, people, NOW + 1);
  assert.equal((await kv.get('sourcing:coverage')).companies.Meta, 2);
  await startHistory({ db, clock: () => NOW + 2 });
  await bumpCoverage(kv, people, NOW + 3);
  assert.equal((await kv.get('sourcing:coverage')).companies.Meta, 2);
});

// Project's Oct 12 list in #int-recruitment and Robin's answers below it (not in a thread).
const OCT12 = [
  { ts: ts(6), user: PROJECT, text: 'New candidates:\n• <https://www.linkedin.com/in/sample-9f93562bc36e/|Yash Pandya> — Microsoft Research; Echoverse environments, agentic RL.\n• <https://www.linkedin.com/in/sample-fca3bfba7b0c/|Archana Yadav> — Microsoft Research; computer-use environments.\n• <https://www.linkedin.com/in/sample-e071cb3f2463/|Peyton Morris> — MSR fellow; 200+ synthetic RL environments.', replyCount: 0 },
  { ts: ts(5.99), user: ROBIN, text: 'lets interview peyton morris' },
  { ts: ts(5.98), user: ROBIN, text: 'lets interview yash' },
  { ts: ts(5.97), user: PROJECT, text: 'we need to reach out to them' },
  { ts: ts(5.96), user: ROBIN, text: 'Abacus.AI is elite indian startup, we should look there' },
  { ts: ts(5.5), user: ROBIN, text: 'Interview recap — Aviral Archer. How it went: Strong. Verdict: push to work trial' },
];
// A model that answers the way the prompt asks, for these fixtures.
const reviewer = { complete: async req => {
  const c = req.messages[0].content;
  if (req.tools?.some(t => t.name === 'expand')) return { content: [{ type: 'tool_use', name: 'expand', input: { signals: ['Built RL environments at Microsoft Research'], adjacent: [{ company: 'Sarvam AI', why: 'Indian AI lab like Abacus.AI' }] } }] };
  if (!req.tools?.some(t => t.name === 'review')) return { content: [{ type: 'tool_use', name: 'taste', input: { bullets: ['Picks MSR RL-environment builders'] } }] };
  const judgements = [], steers = [];
  if (/Yash Pandya/.test(c)) judgements.push({ n: 1, outcome: 'picked', by: 'Robin', reason: 'lets interview yash' }, { n: 2, outcome: 'not_picked', by: 'Robin' }, { n: 3, outcome: 'picked', by: 'Robin', reason: 'lets interview peyton morris' });
  if (/Abacus/.test(c)) steers.push({ text: 'Abacus.AI is an elite Indian startup; look there', by: 'Robin' });
  if (/Hayden Suresh/.test(c)) judgements.push({ n: 1, outcome: 'picked', by: 'Alexis', reason: 'can u connect w him' });
  const role = /fullstack|React/i.test(c) ? 'full-stack engineer' : 'RL coding environments';
  return { content: [{ type: 'tool_use', name: 'review', input: { role, judgements: /React/.test(c) ? [{ n: 1, outcome: 'picked', by: 'Robin', reason: 'reach out' }] : judgements, steers } }] };
} };

test('A list and what came after it: one segment, the next list from someone else starts another; interview recaps are not lists', () => {
  const msgs = [...OCT12].sort((a, b) => Number(a.ts) - Number(b.ts));
  const segs = reviewSegments(msgs);
  assert.equal(segs.length, 1);
  assert.deepEqual(segs[0].people.map(p => p.slug), ['sample-9f93562bc36e', 'sample-fca3bfba7b0c', 'sample-e071cb3f2463']);
  assert.ok(segs[0].after.some(m => m.text === 'lets interview yash'));
  assert.ok(reviewed(segs[0]));
  assert.equal(reviewed({ post: { user: PROJECT }, after: [{ user: AA, text: 'nice' }] }), false, 'only Robin or Alexis count');
  const two = reviewSegments([{ ts: '1.0', user: PROJECT, text: 'https://www.linkedin.com/in/a-a https://www.linkedin.com/in/b-b' }, { ts: '2.0', user: AA, text: 'https://www.linkedin.com/in/c-c https://www.linkedin.com/in/d-d' }, { ts: '3.0', user: ROBIN, text: 'reach out to d' }]);
  assert.equal(two[0].after.length, 0);
  assert.equal(two[1].after[0].text, 'reach out to d');
});

test('readReview: picks, not-picked (with who was picked instead) and steers; junk dropped', async () => {
  const claude = { complete: async () => ({ content: [{ type: 'tool_use', name: 'review', input: { judgements: [
    { n: 1, outcome: 'picked', by: 'Robin', reason: 'lets interview' }, { n: 2, outcome: 'not_picked', by: 'Robin' }, { n: 2, outcome: 'picked', by: 'Robin' }, { n: 9, outcome: 'picked', by: 'Robin' }, { n: 1, outcome: 'picked', by: 'Project' }],
    steers: [{ text: 'Netflix layoffs: their engineers are exceptional', by: 'Robin' }] } }] }) };
  const people = [{ slug: 'a-a', name: 'Ann A', line: 'MSR' }, { slug: 'b-b', name: 'Bo B', line: 'Adobe' }];
  const { items, steers } = await readReview({ claude, post: { ts: ts(1), user: PROJECT, text: 'x' }, people });
  assert.deepEqual(items.map(i => [i.slug, i.verdict, i.outcome]), [['a-a', 'reach_out', 'picked'], ['b-b', 'pass', 'not_picked']]);
  assert.match(items[1].reason, /not picked from a list of 2 \(picked: Ann A\)/);
  assert.equal(steers[0].by, 'Robin');
  assert.deepEqual(looseSteers([{ ts: '1.0', user: ROBIN, text: 'Abacus.AI is elite, we should look there' }, { ts: '2.0', user: PROJECT, text: 'we should look there too' }], []).map(m => m.user), [ROBIN]);
});

test('History: lists in #int-recruitment and in Project\'s DM with Alexis become picks and not-picks with LinkedIn detail; interviews are left out; one DM', async () => {
  const db = d1(), kv = noticeStore(db), said = [];
  const channel = [{ ts: ts(20), user: PROJECT, text: 'old https://www.linkedin.com/in/too-old https://www.linkedin.com/in/too-old-2' }, ...OCT12];
  const dm = [
    { ts: ts(3), user: PROJECT, text: 'a few for you\n• <https://www.linkedin.com/in/sample-d875a647e4c0/|Hayden Suresh> — Sarvam; post-training\n• <https://www.linkedin.com/in/other-one/|Other One> — TCS' },
    { ts: ts(2.99), user: ALEXIS, text: 'hayden - can u connect w him from rishis' }];
  const dms = () => ({ conversations: async () => [{ id: 'D_RITHIKA', kind: 'DM' }], readHistory: slackLike(dm), readThread: async () => [] });
  const resolve = async ({ urls }) => new Map(urls.map(u => u.split('/in/')[1]).map(slug => [slug, { slug, title: 'Research Engineer', company: 'Microsoft Research', location: 'Bengaluru', past: ['Intern at Google'], education: ['IIT Delhi'] }]));
  await startHistory({ db, clock: () => NOW });
  const out = await runTasteBackfill({ db, claude: reviewer, slackRead: { readHistory: slackLike(channel), readThread: async () => [] }, dms, wrangle: async () => ({ tools: [], client: { call: async () => ({}) } }), resolve, clock: () => NOW, poster: async t => said.push(t) });
  assert.equal(out.phase, 'done');
  assert.equal((await kv.get('sourcing:verdict:sample-e071cb3f2463')).outcome, 'picked');
  assert.equal((await kv.get('sourcing:verdict:sample-fca3bfba7b0c')).outcome, 'not_picked');
  assert.equal((await kv.get('sourcing:verdict:sample-d875a647e4c0')).by, 'Alexis');
  assert.ok(await kv.get('sourcing:seen:other-one'));
  assert.equal(await kv.get('sourcing:seen:too-old'), null, 'older than 2 weeks');
  const log = (await kv.get('sourcing:log')).items;
  assert.ok(log.every(v => v.kind === 'review'), 'no interview recaps, no meeting notes');
  assert.match(log.find(v => v.slug === 'sample-9f93562bc36e').profile, /Research Engineer at Microsoft Research · Bengaluru · before: Intern at Google · IIT Delhi/);
  assert.equal((await kv.get('sourcing:steers')).items[0].text, 'Abacus.AI is an elite Indian startup; look there');
  assert.deepEqual((await kv.get('sourcing:taste')).bullets, ['Picks MSR RL-environment builders']);
  // The planner sees the adjacent companies.
  const { planSearches } = await import('../service/lib/wrangle.mjs');
  let planned = '';
  await planSearches({ claude: { complete: async r => { planned = r.messages[0].content; return { content: [] }; } }, brief: 'b', taste: await kv.get('sourcing:taste'), n: 2 });
  assert.match(planned, /Adjacent companies to try[^\n]*\n- Sarvam AI: Indian AI lab like Abacus\.AI/);
  assert.match(said[0], /^📚 Started fresh from the last 2 weeks of profile lists you and AA sent Robin and Alexis \(#int-recruitment and your DMs with them\): 2 lists they reacted to\. 3 picked and 1 passed or not picked; LinkedIn detail read for 4 people\./);
  assert.match(said[0], /Where they've said to look:\n• Abacus\.AI is an elite Indian startup; look there \(Robin\)/);
  assert.match(said[0], /What stands out about the people they picked:\n• Built RL environments at Microsoft Research/);
  assert.match(said[0], /Adjacent places I'll search next: Sarvam AI\./);
  assert.equal((await kv.get('sourcing:taste')).adjacent[0].company, 'Sarvam AI');
});

test('A list near a page\'s end still gets its answers from the newer page', async () => {
  const db = d1(), kv = noticeStore(db);
  // 120 chatter messages after the list push its answer onto the newer page.
  const history = [OCT12[0], { ...OCT12[1], ts: ts(5.999) }, ...Array.from({ length: 120 }, (_, i) => ({ ts: ts(5.9 - i * 0.001), user: PROJECT, text: `chat ${i}` }))];
  await startHistory({ db, clock: () => NOW });
  await runTasteBackfill({ db, claude: reviewer, slackRead: { readHistory: slackLike(history), readThread: async () => [] }, clock: () => NOW });
  assert.equal((await kv.get('sourcing:verdict:sample-e071cb3f2463'))?.outcome, 'picked');
});

test('History pages back from now through a busy channel (250 posts), not the window\'s oldest page', async () => {
  const db = d1(), kv = noticeStore(db);
  const history = Array.from({ length: 250 }, (_, i) => ({ ts: ts(1 + i * 0.5), user: PROJECT, text: `https://www.linkedin.com/in/p-${i}` }));
  await startHistory({ db, clock: () => NOW });
  const out = await runTasteBackfill({ env: { HISTORY_DAYS: '180' }, db, slackRead: { readHistory: slackLike(history), readThread: async () => [] }, clock: () => NOW });
  assert.equal(out.read, 250);
  assert.ok(await kv.get('sourcing:seen:p-0'), 'the newest');
  assert.ok(await kv.get('sourcing:seen:p-249'), 'the oldest');
});

test('A restart in the middle of a run is not overwritten by that run', async () => {
  const db = d1(), kv = noticeStore(db);
  await startHistory({ db, clock: () => NOW });
  const slackRead = { readHistory: async () => { await startHistory({ db, clock: () => NOW + 5 }); return [{ ts: ts(1), user: PROJECT, text: 'hi' }]; }, readThread: async () => [] };
  const out = await runTasteBackfill({ db, slackRead, clock: () => NOW + 10 });
  assert.equal(out.error, 'history_restarted');
  const st = await kv.get('history:state');
  assert.equal(st.startedAt, NOW + 5);
  assert.equal(st.phase, 'slack');
  assert.equal(st.slack, undefined);
});

test('"learn from history" starts it over', async () => {
  const db = d1(), said = [];
  const out = await handleHistoryCommand({ event: { authorId: PROJECT, channelId: 'D1', messageTs: '1.1', text: 'learn from history' }, db, clock: () => NOW, poster: () => async t => said.push(t) });
  assert.equal(out.reason, 'started');
  assert.equal((await historyState(db)).phase, 'slack');
  assert.match(said[0], /^Roger that 🫡 I'm reading the profile lists you sent Robin and Alexis/);
});

test('Wispr meetings stay out of the history pass unless HISTORY_WISPR=on', async () => {
  const db = d1();
  let asked = 0;
  await startHistory({ db, clock: () => NOW });
  await runTasteBackfill({ db, claude: reviewer, wispr: async () => { asked++; return { session: { call: async () => ({}) }, transcriptOf: async () => '' }; }, clock: () => NOW });
  assert.equal(asked, 0);
});

test('Roles: a full-stack list is kept apart from the RL taste; each role gets its own taste and steers; switching swaps the working copies', async () => {
  const db = d1(), kv = noticeStore(db), said = [];
  await setRole(kv, { name: 'RL coding environments', brief: 'Engineers who build RL environments for coding agents, mainly India' }, NOW);
  const channel = [...OCT12,
    { ts: ts(4), user: AA, text: 'fullstack folks\n• <https://www.linkedin.com/in/react-dev/|React Dev> — React, Node\n• <https://www.linkedin.com/in/vue-dev/|Vue Dev> — Vue' },
    { ts: ts(3.99), user: ROBIN, text: 'reach out to react dev' }];
  const tasteCalls = [];
  const claude = { complete: async req => { if (req.tools?.some(t => t.name === 'expand')) return reviewer.complete(req); if (!req.tools?.some(t => t.name === 'review')) { tasteCalls.push(req.messages[0].content); return { content: [{ type: 'tool_use', name: 'taste', input: { bullets: [/React Dev/.test(req.messages[0].content) ? 'Full-stack: React' : 'RL: MSR env builders'] } }] }; } return reviewer.complete(req); } };
  await startHistory({ db, clock: () => NOW });
  await runTasteBackfill({ db, claude, slackRead: { readHistory: slackLike(channel), readThread: async () => [] }, clock: () => NOW, poster: async t => said.push(t) });
  assert.equal((await kv.get('sourcing:verdict:react-dev')).role, 'full-stack-engineer');
  assert.equal((await kv.get('sourcing:verdict:sample-e071cb3f2463')).role, 'rl-coding-environments');
  assert.ok(tasteCalls.every(c => !/React Dev/.test(c)), 'the full-stack pick never reaches the RL taste');
  assert.deepEqual((await kv.get('sourcing:taste')).bullets, ['RL: MSR env builders']);
  assert.match(said[0], /For RL coding environments: 2 picked and 1 passed or not picked/);
  assert.match(said[0], /Kept apart, for other hires: full stack engineer \(1\)\./);
  // A full-stack role later: switching swaps the working copies, and the RL role keeps its own.
  await setRole(kv, { name: 'Full-stack engineer', brief: 'Full-stack engineers for the product' }, NOW + 1);
  assert.deepEqual((await kv.get('sourcing:taste')).bullets ?? [], []);
  assert.equal((await kv.get('sourcing:config')).brief, 'Full-stack engineers for the product');
  await setRole(kv, { name: 'RL coding environments' }, NOW + 2);
  assert.deepEqual((await kv.get('sourcing:taste')).bullets, ['RL: MSR env builders']);
  assert.equal((await kv.get('sourcing:config')).brief, 'Engineers who build RL environments for coding agents, mainly India');
  assert.deepEqual(forRole([{ role: 'rl-coding-environments' }, { role: 'full-stack-engineer' }, {}], 'rl-coding-environments').length, 2);
  assert.equal(roleOfLabel('rl coding environments', [{ key: 'rl-coding-environments', name: 'RL coding environments' }]), 'rl-coding-environments');
});

test('"sourcing role: <name> - <brief>", "sourcing role: <name>" and "sourcing roles"', async () => {
  const db = d1(), kv = noticeStore(db), said = [];
  const ev = text => ({ authorId: PROJECT, channelId: 'D1', messageTs: '1.1', text });
  const poster = () => async t => said.push(t);
  assert.equal((await handleRoleCommand({ event: ev('sourcing role: RL coding environments - engineers building RL environments for coding agents, mainly India'), db, masonId: PROJECT, poster, clock: () => NOW })).reason, 'created');
  assert.match(said.at(-1), /New role "RL coding environments" is now the one the daily profiles are for\. Brief: engineers building/);
  assert.equal((await handleRoleCommand({ event: ev('sourcing role: Full-stack engineer — full-stack engineers for the product'), db, masonId: PROJECT, poster, clock: () => NOW })).reason, 'created');
  assert.equal((await handleRoleCommand({ event: ev('sourcing role: RL coding environments'), db, masonId: PROJECT, poster, clock: () => NOW })).reason, 'switched');
  await handleRoleCommand({ event: ev('sourcing roles'), db, masonId: PROJECT, poster, clock: () => NOW });
  assert.match(said.at(-1), /▶ RL coding environments: 0 judgements\n• Full-stack engineer: 0 judgements/);
  assert.equal((await rolesOf(kv)).active, 'rl-coding-environments');
  assert.equal(await handleRoleCommand({ event: { ...ev('sourcing roles'), authorId: ROBIN }, db, masonId: PROJECT, poster, clock: () => NOW }), null);
});

test('Fresh start: only the last 2 weeks count, earlier verdicts are dropped from the taste, who was already shown stays remembered', async () => {
  const db = d1(), kv = noticeStore(db);
  await kv.put('sourcing:log', { items: [{ slug: 'old-pick', verdict: 'reach_out', at: NOW - 40 * 86400_000 }] }, NOW);
  await kv.put('sourcing:seen:old-pick', { at: NOW - 40 * 86400_000 }, NOW);
  const channel = [{ ts: ts(15), user: PROJECT, text: 'https://www.linkedin.com/in/fifteen-days https://www.linkedin.com/in/fifteen-b' }, ...OCT12];
  await startHistory({ db, clock: () => NOW });
  await runTasteBackfill({ db, claude: reviewer, slackRead: { readHistory: slackLike(channel), readThread: async () => [] }, clock: () => NOW });
  assert.equal(await kv.get('sourcing:seen:fifteen-days'), null);
  assert.ok(await kv.get('sourcing:seen:old-pick'));
  assert.ok((await kv.get('sourcing:log')).items.every(v => v.slug !== 'old-pick'));
});
