import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { looksLikeFindAsk, mightBeClayAsk, handleFindAsk, runPendingFinds, finalText, gatherContext, FUNCTIONS } from '../service/lib/person-finder.mjs';
import { extraText } from '../service/lib/slack-read.mjs';
import { noticeStore } from '../service/lib/stuck-rejections.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const AA = 'U0BF89D1279', PROJECT = 'U0F9EF97D89', TEAM = new Set([AA, PROJECT]);
const NOW = Date.parse('2026-10-17T20:00:00Z');
const noWait = async () => {};
const ENRICHED = { name: 'Joe Chen', url: 'https://www.linkedin.com/in/sample-f2aadaadb31d', latest_experience_title: 'Research Scientist', latest_experience_company: 'Tencent', location_name: 'Shenzhen, China' };
/** A model that plays a script: each turn returns the next content list; records what it was sent. */
function scripted(turns) {
  const seen = [];
  return { seen, complete: async req => { seen.push(req); const next = turns.shift(); return { content: typeof next === 'function' ? next(req) : next ?? [{ type: 'text', text: '📋 Done.' }] }; } };
}
const use = (name, input, id = `tu_${name}_${Math.random().toString(36).slice(2, 7)}`) => ({ type: 'tool_use', id, name, input });
function fakeClay(answer, { slow = false } = {}) {
  const runs = [];
  return { runs, async startWith(id, items) { runs.push({ id, inputs: items[0].inputs }); return `run${runs.length}`; },
    async results(runId) { if (slow) return null; const r = runs[Number(runId.slice(3)) - 1]; return new Map([['p0', { status: 'done', result: answer(r) }]]); } };
}
const event = (o = {}) => ({ type: 'qa_question', authorId: AA, channelId: 'C0AU534KQTT', threadTs: '1792300000.000100', messageTs: '1792300100.000100', text: '<@U0C4899BFC9> use your clay connector and find him', ...o });

test('when it is a Clay ask: tagged or in a DM broadly, untagged in a group only when Uncle Sam or Clay is named; commands never', () => {
  assert.equal(looksLikeFindAsk('can you look this guy up'), true);
  assert.equal(looksLikeFindAsk('who is Arlen Archer?'), false);
  assert.equal(mightBeClayAsk('who is sample-f2aadaadb31d@example.test?', 'tagged'), true);
  assert.equal(mightBeClayAsk("what's the headcount at Tencent", 'dm'), true);
  assert.equal(mightBeClayAsk('get me his mobile number', 'dm'), true);
  assert.equal(mightBeClayAsk('who is Arlen Archer?', 'tagged'), false, 'a candidate question goes to the usual answers');
  assert.equal(mightBeClayAsk('send Arlen the take-home email', 'dm'), false);
  assert.equal(mightBeClayAsk('can you find him on linkedin', 'group'), false, 'not addressed to Uncle Sam');
  assert.equal(mightBeClayAsk('uncle sam can you find him', 'group'), true);
});

test('in a thread: reads the messages, the screenshot and a forwarded email; chains Clay; answers once in the thread', async () => {
  const db = d1();
  const clay = fakeClay(r => (r.inputs.Email === 'sample-f2aadaadb31d@example.test' ? { 'Enrich person': ENRICHED } : null));
  const claude = scripted([
    [use('clay_run', { function: 'Enrich Person', inputs: { Email: 'sample-f2aadaadb31d@example.test' } })],
    [use('tracker_lookup', { email: 'sample-f2aadaadb31d@example.test', name: 'Joe Chen' })],
    [{ type: 'text', text: '🎖️ <https://www.linkedin.com/in/sample-f2aadaadb31d|Joe Chen>: Research Scientist at Tencent · Shenzhen, China. Not on our tracker!' }],
  ]);
  const posted = [];
  const out = await handleFindAsk({ env: {}, db, event: event(), claude, clay, team: TEAM, notion: { findCandidatesByEmail: async () => [], findCandidatesByName: async () => [] },
    readThread: async () => [{ ts: '1792300000.000100', user: AA, text: 'this guy emailed us', files: [{ id: 'F0CA37AFQUA' }], extra: 'Email "Collab" · from Joe <sample-f2aadaadb31d@example.test>' }],
    readImages: async () => ['sample-f2aadaadb31d@example.test'], nameOf: id => (id === AA ? 'AA' : 'someone'), post: async t => posted.push(t), wait: noWait, clock: () => NOW });
  assert.deepEqual(posted, ['🎖️ <https://www.linkedin.com/in/sample-f2aadaadb31d|Joe Chen>: Research Scientist at Tencent · Shenzhen, China. Not on our tracker.']);
  assert.match(claude.seen[0].messages[0].content, /\[AA, screenshot shows\] sample-f2aadaadb31d@example\.test/);
  assert.match(claude.seen[0].messages[0].content, /\[AA, attached\] Email "Collab"/);
  assert.deepEqual(clay.runs, [{ id: FUNCTIONS['Enrich Person'].id, inputs: { Email: 'sample-f2aadaadb31d@example.test' } }]);
  assert.equal((await noticeStore(db).get('clay:day:2026-10-17')).count, 1);
  const again = await handleFindAsk({ env: {}, db, event: event(), claude: scripted([]), clay, team: TEAM, post: async t => posted.push(t), wait: noWait, clock: () => NOW });
  assert.equal(again.duplicate, true);
  assert.equal(posted.length, 1, 'never twice');
});

test('made-up identifiers are refused, contact lookups stay out of channels, and a channel answer carries no new email or phone', async () => {
  const clay = fakeClay(() => ({ email: 'joe.chen@example.test', phone: '+86 138 0013 8000' }));
  const claude = scripted([
    [use('clay_run', { function: 'Enrich Person', inputs: { Email: 'joe.chen@example.test' } }), use('clay_run', { function: 'Mobile Phone Number', inputs: { 'Full Name': 'Joe Chen' } })],
    req => { const r = req.messages.at(-1).content; assert.match(r[0].content, /not in the conversation/); assert.match(r[1].content, /only in DMs/); return [{ type: 'text', text: '📋 Joe Chen, joe.chen@example.test, +86 138 0013 8000' }]; },
  ]);
  const out = await handleFindAsk({ env: {}, db: d1(), event: event({ text: '<@U0C4899BFC9> find Joe Chen at Tencent' }), claude, clay, team: TEAM, privateChat: false, wait: noWait, clock: () => NOW });
  assert.equal(clay.runs.length, 0);
  assert.equal(out.text, '📋 Joe Chen, [ask me in a DM], [ask me in a DM]');
  assert.equal(finalText('🎖️ Joe Chen · joe.chen@example.test · +86 138 0013 8000', { privateChat: true }), '🎖️ Joe Chen · joe.chen@example.test · +86 138 0013 8000', 'in a DM they stay');
});

test('a candidate question or a command is handed back untouched; outsiders and the off switch get nothing', async () => {
  const db = d1();
  const passed = await handleFindAsk({ env: {}, db, event: event({ text: '<@U0C4899BFC9> find him a slot on Thursday' }), claude: scripted([[use('pass', {})]]), clay: fakeClay(() => null), team: TEAM, wait: noWait, clock: () => NOW });
  assert.equal(passed, null);
  assert.equal(await handleFindAsk({ env: {}, db: d1(), event: event({ authorId: 'U0SOMEONE' }), claude: scripted([]), clay: fakeClay(() => null), team: TEAM }), null);
  assert.equal(await handleFindAsk({ env: { UNCLE_SAM_FIND: 'off' }, db: d1(), event: event(), claude: scripted([]), clay: fakeClay(() => null), team: TEAM }), null);
});

test('a DM reads the last hours of messages (what AA pasted before), and Gmail only where Project is', async () => {
  const claude = scripted([[{ type: 'text', text: '📋 Who do you mean: Joe Chen or Wei Zhang?' }]]);
  const dm = { type: 'message', authorId: AA, channelId: 'D0C8WKT8C4V', threadTs: null, messageTs: '1792300100.000100', text: 'can you look him up' };
  await handleFindAsk({ env: {}, db: d1(), event: dm, where: 'dm', privateChat: true, claude, clay: fakeClay(() => null), team: TEAM, gmail: { listInbox: async () => [] },
    readHistory: async () => [{ ts: String(NOW / 1000 - 600), user: AA, text: 'sample-f2aadaadb31d@example.test' }, { ts: String(NOW / 1000 - 9 * 3600), user: AA, text: 'old@x.com' }], nameOf: () => 'AA', clock: () => NOW, wait: noWait });
  const sent = claude.seen[0];
  assert.match(sent.messages[0].content, /sample-f2aadaadb31d@example\.test/);
  assert.doesNotMatch(sent.messages[0].content, /old@x\.com/, 'older than 6 hours');
  assert.ok(!sent.tools.some(t => t.name === 'gmail_search'), 'AA alone: no Gmail');
  const withMason = scripted([[{ type: 'text', text: '📋 ok' }]]);
  await handleFindAsk({ env: {}, db: d1(), event: { ...dm, channelId: 'C0C9F9CS53K', text: 'uncle sam find this guy' }, where: 'group', privateChat: true, gmailOk: true, claude: withMason, clay: fakeClay(() => null), team: TEAM,
    gmail: { listInbox: async () => [] }, clock: () => NOW, wait: noWait });
  assert.ok(withMason.seen[0].tools.some(t => t.name === 'gmail_search'));
});

test('a slow Clay run: "still working", then the tick posts the answer once', async () => {
  const db = d1();
  const clay = fakeClay(() => ({ 'Enrich person': ENRICHED }), { slow: true });
  const claude = scripted([[use('clay_run', { function: 'Enrich Person', inputs: { Email: 'sample-f2aadaadb31d@example.test' } }, 'tu_1')]]);
  const posted = [];
  const out = await handleFindAsk({ env: {}, db, event: event({ text: '<@U0C4899BFC9> who is sample-f2aadaadb31d@example.test' }), claude, clay, team: TEAM, post: async t => posted.push(t),
    wait: noWait, clock: () => NOW, deadline: Date.now() + 80 });
  assert.equal(out.pending, true, 'Clay had not finished by the deadline');
  assert.deepEqual(posted, ["🪖 Clay is still working on it. I'll post the answer here."]);
  const tickClaude = scripted([req => { assert.equal(req.messages.at(-1).content[0].tool_use_id, 'tu_1'); return [{ type: 'text', text: '🎖️ <https://www.linkedin.com/in/sample-f2aadaadb31d|Joe Chen>: Research Scientist at Tencent' }]; }]);
  const fast = { results: async () => new Map([['p0', { result: { 'Enrich person': ENRICHED } }]]), startWith: async () => 'x' };
  const said = [];
  const r = await runPendingFinds({ env: {}, db, claude: tickClaude, clay: fast, postTo: (c, ts) => async t => said.push([c, ts, t]), clock: () => NOW + 120_000 });
  assert.equal(r.answered, 1);
  assert.deepEqual(said, [['C0AU534KQTT', '1792300000.000100', '🎖️ <https://www.linkedin.com/in/sample-f2aadaadb31d|Joe Chen>: Research Scientist at Tencent']]);
  await runPendingFinds({ env: {}, db, claude: tickClaude, clay: fast, postTo: (c, ts) => async t => said.push([c, ts, t]), clock: () => NOW + 240_000 });
  assert.equal(said.length, 1, 'once');
});

test('forwarded emails and attachments become text the desk can read', () => {
  const t = extraText({ files: [{ filetype: 'email', subject: 'Intro', from: [{ name: 'Joe Chen', address: 'sample-f2aadaadb31d@example.test' }], to: [{ address: 'aa@company.example' }], plain_text: 'Hi AA, Joe Chen, Research Scientist, Tencent AI Lab' }],
    attachments: [{ author_name: 'Joe Chen', title: 'Joe Chen | LinkedIn', text: 'Research Scientist at Tencent' }] });
  assert.match(t, /Joe Chen \| LinkedIn/);
  assert.match(t, /Email "Intro" · from Joe Chen <sample-f2aadaadb31d@example\.test> · to <aa@company\.example> · Hi AA/);
});

test('gatherContext says when the thread or a screenshot could not be read', async () => {
  const ctx = await gatherContext({ event: event(), privateChat: false, readThread: async () => { throw new Error('missing_scope'); }, readImages: null });
  assert.equal(ctx.threadUnread, true);
  const ctx2 = await gatherContext({ event: event(), privateChat: false, readThread: async () => [{ ts: '1', user: AA, text: 'look', files: [{ id: 'F' }] }], readImages: async () => null });
  assert.equal(ctx2.imagesUnread, 1);
});
