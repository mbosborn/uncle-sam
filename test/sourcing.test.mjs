import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { profilesInText, registerPostedBatch, handleSourcingReply, runDailySourcing, handleSourcingDm, handleSourcingCommand, simpleVerdicts, numbersIn, nameFromSlug, isSourcingThread, looksLikeSourcingReply } from '../service/lib/sourcing.mjs';
import { noticeStore } from '../service/lib/stuck-rejections.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const PROJECT = 'U0F9EF97D89', ROBIN = 'U0A4F08721B', CH = 'C01D1A69CE3', DM = 'D0C95KBR09J';
const at = s => Date.parse(s);
const NOW = at('2026-10-19T16:00:00Z'); // 9 AM PT
const POST = { ts: '1792428000.000100', user: PROJECT, text: 'Profiles for this week:\n1. <https://www.linkedin.com/in/priya-shah-1a2b|Priya Shah> ML at Zepto\n2. Arjun Rao - https://in.linkedin.com/in/arjunrao\n• <https://www.linkedin.com/in/sam-lee-99>' };
// A fake model: answers whichever tool it is offered.
const claude = (answers = {}) => ({ calls: [], async complete({ tools }) { this.calls.push(tools[0].name); const input = typeof answers[tools[0].name] === 'function' ? answers[tools[0].name]() : answers[tools[0].name]; return { content: input ? [{ type: 'tool_use', name: tools[0].name, input }] : [] }; } });

test('LinkedIn profiles in a Slack post: labelled links, bare links, regional hosts; names from the label, the line, or the slug', () => {
  const found = profilesInText(POST.text);
  assert.deepEqual(found.map(p => [p.slug, p.name]), [['priya-shah-1a2b', 'Priya Shah'], ['arjunrao', 'Arjun Rao'], ['sam-lee-99', 'Sam Lee']]);
  assert.equal(found[0].linkedin, 'https://www.linkedin.com/in/priya-shah-1a2b');
  assert.equal(nameFromSlug('kumar-v-12ab34'), 'Kumar');
  assert.deepEqual(numbersIn('send 1-3, 7 and 12', 10), [1, 2, 3, 7]);
  assert.deepEqual(simpleVerdicts('reach out to 2 and 3. pass on 1', 3), [{ n: 2, verdict: 'reach_out', reason: '' }, { n: 3, verdict: 'reach_out', reason: '' }, { n: 1, verdict: 'pass', reason: '' }]);
  assert.equal(looksLikeSourcingReply('reach out to the first two'), true);
  assert.equal(looksLikeSourcingReply('what time is standup'), false);
});

test('A list someone posts is a batch once (no post); Robin\'s picks on it are kept and teach the taste quietly: no reply, no outreach (Project, 2026-10-18)', async () => {
  const db = d1(), kv = noticeStore(db);
  assert.equal(await registerPostedBatch({ db, message: { ...POST, user: 'U0SOMEONE1' }, channelId: CH, clock: () => NOW }), null, 'only the team');
  assert.equal(await registerPostedBatch({ db, message: { ...POST, user: 'U0CB213D6D6' }, channelId: CH, clock: () => NOW }), null, "Jamie's lists are left alone");
  assert.equal(await registerPostedBatch({ db, message: { ...POST, user: ROBIN }, channelId: CH, clock: () => NOW }), null, "and Robin's");
  const batch = await registerPostedBatch({ db, message: POST, channelId: CH, clock: () => NOW });
  assert.equal(batch.people.length, 3, "Project's list");
  assert.equal(await registerPostedBatch({ db, message: POST, channelId: CH, clock: () => NOW }), null, 'once');
  assert.equal(await isSourcingThread(db, { channelId: CH, threadTs: POST.ts }), true);
  // A list registered before this rule from someone else: left alone.
  await kv.put('sourcing:batch:post-old', { id: 'post-old', source: 'posted', by: 'Robin', people: [{ slug: 'x', name: 'X' }] }, NOW);
  await kv.put(`sourcing:thread:${CH}:1792428000.000999`, { batchId: 'post-old' }, NOW);
  assert.equal((await handleSourcingReply({ event: { channelId: CH, threadTs: '1792428000.000999', messageTs: '1792428100.000111', authorId: ROBIN, text: 'reach out to 1' }, db, clock: () => NOW,
    poster: () => async () => { throw new Error('silent'); }, enqueue: async () => { throw new Error('none'); } })).reason, 'sourcing_not_masons_list');
  const queued = [], said = [];
  const reply = (text, ts = '1792428100.000200', author = ROBIN) => handleSourcingReply({ event: { channelId: CH, threadTs: POST.ts, messageTs: ts, authorId: author, text }, db, clock: () => NOW,
    poster: () => async t => said.push(t), enqueue: async (p, ctx) => { queued.push([p.slug, ctx.requestedBy, ctx.threadTs]); return { status: 'queued', note: 'LinkedIn' }; } });
  const out = await reply('reach out to 1 and 3, pass on 2');
  assert.deepEqual([out.kind, out.reason, out.learned], ['no_action', 'sourcing_learned', 3]);
  assert.deepEqual([queued, said], [[], []], 'nothing done on someone else\'s list');
  assert.equal((await reply('reach out to 1 and 3, pass on 2')).reason, 'sourcing_seen', 'the same message once');
  assert.equal((await reply('reach out to 2', '1792428100.000250', PROJECT)).reason, 'sourcing_not_a_picker', 'only Robin and Alexis teach');
  assert.equal(await reply('reach out to 2', '1792428100.000300', 'U0SOMEONE1'), null, 'only the team');
  assert.equal((await kv.get('sourcing:verdict:arjunrao')).verdict, 'pass');
  assert.equal((await kv.get('sourcing:log')).items.length, 3);
});

test('Robin\'s picks on the bot\'s own ten (posting on) are queued once each and answered in the thread', async () => {
  const db = d1(), kv = noticeStore(db);
  await kv.put('sourcing:batch:day-2026-10-19', { id: 'day-2026-10-19', source: 'wrangle', people: [{ slug: 'priya-shah-1a2b', name: 'Priya Shah' }, { slug: 'arjunrao', name: 'Arjun Rao' }, { slug: 'sam-lee-99', name: 'Sam Lee' }] }, NOW);
  await kv.put(`sourcing:thread:${CH}:${POST.ts}`, { batchId: 'day-2026-10-19' }, NOW);
  const queued = [], said = [];
  const out = await handleSourcingReply({ event: { channelId: CH, threadTs: POST.ts, messageTs: '1792428100.000200', authorId: ROBIN, text: 'reach out to 1 and 3, pass on 2' }, db, clock: () => NOW,
    poster: () => async t => said.push(t), enqueue: async (p, ctx) => { queued.push([p.slug, ctx.requestedBy, ctx.threadTs]); return { status: 'queued', note: 'LinkedIn' }; } });
  assert.deepEqual([out.reached, out.passed], [2, 1]);
  assert.deepEqual(queued, [['priya-shah-1a2b', 'Robin', POST.ts], ['sam-lee-99', 'Robin', POST.ts]]);
  assert.equal(said[0], 'Roger that 🫡 Reaching out to 1. Priya Shah, 3. Sam Lee (LinkedIn). Noted why 2 isn\'t a fit.');
});

test('The model reads names and reasons; Robin\'s taste is rewritten and sent back to the Juicebox Agent for its own batches', async () => {
  const db = d1(), kv = noticeStore(db);
  await kv.put('sourcing:batch:jb-2026-10-19', { id: 'jb-2026-10-19', source: 'juicebox', people: [{ slug: 'a-one', name: 'Ann One', title: 'ML Eng', company: 'Zepto' }, { slug: 'b-two', name: 'Bo Two', title: 'Intern', company: 'X' }] }, NOW);
  await kv.put(`sourcing:thread:${CH}:1792428000.000900`, { batchId: 'jb-2026-10-19' }, NOW);
  const model = claude({ verdicts: { verdicts: [{ n: 1, verdict: 'reach_out', reason: 'startup ML' }, { n: 2, verdict: 'pass', reason: 'too junior' }], general: 'more infra people' },
    taste: { bullets: ['Likes startup ML engineers', 'Passes on interns'] } });
  const sent = [];
  await handleSourcingReply({ event: { channelId: CH, threadTs: '1792428000.000900', messageTs: '1792428000.001000', authorId: ROBIN, text: 'Ann yes, Bo too junior. more infra people pls' }, db, claude: model, clock: () => NOW,
    poster: () => async () => {}, enqueue: async () => ({ status: 'queued' }), feedback: async text => sent.push(text) });
  assert.deepEqual((await kv.get('sourcing:taste')).bullets, ['Likes startup ML engineers', 'Passes on interns']);
  assert.equal((await kv.get('sourcing:taste')).likes, 1);
  assert.match(sent[0], /GOOD FIT: Ann One \(ML Eng at Zepto\) - startup ML\nNOT A FIT: Bo Two \(Intern at X\) - too junior\nGeneral: more infra people\nWhat the reviewer wants overall: Likes startup ML engineers; Passes on interns/);
});

test('A reply under a list the tick hasn\'t seen yet: the thread is read, the list registered, the picks applied; under anything else, nothing', async () => {
  const db = d1(), queued = [];
  const readThread = async () => [{ ts: POST.ts, user: PROJECT, text: POST.text }];
  const out = await handleSourcingReply({ event: { channelId: CH, threadTs: POST.ts, messageTs: '1792428200.000100', authorId: ROBIN, text: 'reach out to 2' }, db, clock: () => NOW, readThread,
    poster: () => async () => {}, enqueue: async p => { queued.push(p.slug); return { status: 'queued' }; } });
  assert.deepEqual([out.reason, out.learned, queued], ['sourcing_learned', 1, []]);
  assert.equal((await noticeStore(db).get('sourcing:verdict:arjunrao')).verdict, 'reach_out');
  const none = await handleSourcingReply({ event: { channelId: CH, threadTs: '1792428000.000555', messageTs: '1792428200.000200', authorId: ROBIN, text: 'reach out to 2' }, db, clock: () => NOW,
    readThread: async () => [{ ts: '1792428000.000555', user: ROBIN, text: 'standup moved' }], poster: () => async () => {}, enqueue: async () => ({ status: 'queued' }) });
  assert.equal(none, null);
});

const leads = n => Array.from({ length: n }, (_, i) => ({ slug: `lead-${i + 1}`, linkedin: `https://www.linkedin.com/in/lead-${i + 1}`, name: `Lead ${i + 1}`, title: 'Engineer', company: `Co${i + 1}` }));

test('The daily ten: from 8:30 AM PT, once a day; seen, judged and tracker people dropped; Project\'s "send 1-3" posts three for Robin, once', async () => {
  const db = d1(), kv = noticeStore(db), dms = [], channel = [];
  await kv.put('sourcing:config', { agentId: 'agt_1', brief: 'ML engineers' }, NOW);
  await kv.put('sourcing:seen:lead-1', { at: NOW }, NOW);
  await kv.put('sourcing:verdict:lead-2', { verdict: 'pass' }, NOW);
  const notes = [];
  const run = (now, extra = {}) => runDailySourcing({ db, claude: claude({ pick: { picks: leads(15).slice(3).map(p => ({ slug: p.slug, why: 'fixture fit' })) } }), notion: { readControl: async () => ({ mode: 'Live' }) }, clock: () => now, poster: async t => { dms.push(t); return '1792429000.000100'; }, threadPoster: async (t, ts) => { notes.push([t, ts]); },
    juicebox: async () => ({}), leadsOf: async () => leads(15), inTracker: async slug => slug === 'lead-3', ...extra });
  assert.equal((await run(at('2026-10-19T15:00:00Z'))).state, 'too_early', '8 AM PT');
  const out = await run(NOW);
  assert.deepEqual([out.state, out.leads, out.picked], ['ran', 15, 10]);
  // Copy-ready, in Project's own list style; no numbers, no Uncle Sam notes in it.
  assert.match(dms[0], /^New candidates:\n\n• <https:\/\/www\.linkedin\.com\/in\/lead-4\|Lead 4> — Engineer, Co4\.\n/);
  assert.doesNotMatch(dms[0], /🪖|Robin/);
  // Uncle Sam's notes go in the thread under the list.
  assert.match(notes[0][0], /^🪖 Today's 10 for Robin \(from Juicebox, ranked on what he and Alexis have picked\)\..* Why each:\n1\. Lead 4: /s);
  assert.match(notes[0][0], /Copy the list above into #int-recruitment yourself\. I don't post it or message anyone; what Robin and Alexis say about it there teaches me\.$/);
  assert.equal(notes[0][1], '1792429000.000100');
  assert.equal((await run(NOW + 3600_000)).state, 'done_today');
  const send = text => handleSourcingDm({ env: send.env ?? {}, event: { authorId: PROJECT, channelId: DM, threadTs: '1792429000.000100', messageTs: `1792429${Math.floor(Math.random() * 999)}.0001`, text }, db, clock: () => NOW,
    poster: () => async () => {}, channelPoster: async t => { channel.push(t); return '1792429500.000100'; } });
  assert.equal(await send('thanks'), null);
  // Posting is off for now (Project, 2026-10-18): "send" posts nothing.
  assert.equal((await send('send 1-3')).reason, 'posting_off');
  assert.equal(channel.length, 0);
  send.env = { UNCLE_SAM_SOURCING_POST: 'on' };
  assert.equal((await send('send 1-3')).reason, null);
  assert.match(channel[0], /^New candidates:\n\n• <https:\/\/www\.linkedin\.com\/in\//);
  assert.equal(channel[0].split('\n').length, 5); // header, blank line, 3 people
  assert.equal(await isSourcingThread(db, { channelId: CH, threadTs: '1792429500.000100' }), true);
  assert.equal((await send('send')).reason, 'already');
});

test('Juicebox lapsed: the connect link once a day, nothing else; no source set: nothing at all', async () => {
  const db = d1(), kv = noticeStore(db), dms = [];
  const run = now => runDailySourcing({ db, notion: { readControl: async () => ({ mode: 'Live' }) }, clock: () => now, poster: async t => dms.push(t),
    juicebox: async () => { throw Object.assign(new Error('x'), { code: 'mcp_disconnected' }); }, leadsOf: async () => [], connectText: async () => ({ status: 'link', text: '🔗 <https://x|Connect Juicebox>' }) });
  assert.equal((await run(NOW)).state, 'no_source');
  await kv.put('sourcing:config', { agentId: 'agt_1' }, NOW);
  assert.equal((await run(NOW)).state, 'not_connected');
  await run(NOW + 3600_000);
  assert.equal(dms.length, 1);
  assert.match(dms[0], /^📋 Juicebox needs signing in again before I can pull its profiles\.\n🔗/);
});

test('Project\'s commands: brief makes the Agent; agent/project ids; count; pause; what Robin likes', async () => {
  const db = d1(), kv = noticeStore(db), said = [];
  const cmd = (text, extra = {}) => handleSourcingCommand({ event: { authorId: PROJECT, channelId: DM, messageTs: '1.1', text }, db, clock: () => NOW, poster: () => async t => said.push(t), ...extra });
  assert.equal(await cmd('hello'), null);
  assert.equal((await cmd('sourcing brief: ML engineers in India, 3-6 years, ex-startup', { createAgent: async brief => ({ agentId: brief.length > 10 ? 'agt_9' : null }) })).reason, 'agent_made');
  assert.equal((await kv.get('sourcing:config')).agentId, 'agt_9');
  assert.equal((await cmd('juicebox project: https://app.juicebox.ai/projects/prj_42?tab=1')).reason, 'source_set');
  assert.equal((await kv.get('sourcing:config')).projectId, 'prj_42');
  await cmd('sourcing 12 a day');
  assert.equal((await kv.get('sourcing:config')).count, 12);
  await cmd('sourcing pause');
  assert.equal((await kv.get('sourcing:config')).paused, true);
  await cmd('what does robin like?');
  assert.equal(said.at(-1), '📋 Nothing yet. It fills in as Robin picks and passes on profiles.');
  assert.equal((await cmd('connect juicebox', { connectText: async () => ({ text: '🔗 link' }) })).reason, 'connect');
  assert.equal(said.at(-1), '🔗 link');
});

test('A list posted for another hire is labeled by the model and left alone; one for the active role teaches it (Project, 2026-10-18)', async () => {
  const db = d1(), kv = noticeStore(db);
  await kv.put('sourcing:roles', { active: 'rl-coding-environments', roles: { 'rl-coding-environments': { name: 'RL coding environments', brief: 'RL envs for coding agents, India' },
    'full-stack-engineer': { name: 'Full-stack engineer', brief: 'Eval platform full-stack', taste: { bullets: ['Old FS note'] } } } }, NOW);
  await kv.put('sourcing:config', { role: 'rl-coding-environments' }, NOW);
  await kv.put('sourcing:taste', { bullets: ['RL taste stays'] }, NOW);
  const model = claude({ role: { role: 'Full-stack engineer' }, verdicts: { verdicts: [{ n: 1, verdict: 'reach_out', reason: 'strong React' }] }, taste: { bullets: ['Likes RL env builders'] } });
  const batch = await registerPostedBatch({ db, message: POST, channelId: CH, clock: () => NOW, claude: model });
  assert.deepEqual([batch.role, batch.roleBy], ['full-stack-engineer', 'model']);
  const out = await handleSourcingReply({ event: { channelId: CH, threadTs: POST.ts, messageTs: '1792428100.000900', authorId: ROBIN, text: 'reach out to 1' }, db, claude: model, clock: () => NOW,
    poster: () => async () => {}, enqueue: async () => ({ status: 'queued' }) });
  assert.equal(out.reason, 'sourcing_other_role');
  assert.deepEqual((await kv.get('sourcing:taste')).bullets, ['RL taste stays'], 'the active role is untouched');
  assert.deepEqual((await kv.get('sourcing:roles')).roles['full-stack-engineer'].taste.bullets, ['Old FS note'], 'nor the other hire');
  assert.equal(await kv.get('sourcing:log'), null);
  // Project's list for the RL role: Alexis's picks teach the RL taste.
  const rl = { ...POST, ts: '1792428000.000400' };
  assert.equal((await registerPostedBatch({ db, message: rl, channelId: CH, clock: () => NOW, claude: claude({ role: { role: 'RL coding environments' } }) })).role, 'rl-coding-environments');
  const learned = await handleSourcingReply({ event: { channelId: CH, threadTs: rl.ts, messageTs: '1792428100.000950', authorId: 'U0476A5BC82', text: 'love 1' }, db, claude: model, clock: () => NOW,
    poster: () => async () => { throw new Error('no reply'); }, enqueue: async () => { throw new Error('no outreach'); } });
  assert.equal(learned.reason, 'sourcing_learned');
  assert.deepEqual((await kv.get('sourcing:taste')).bullets, ['Likes RL env builders']);
  assert.equal((await kv.get('sourcing:log')).items[0].role, 'rl-coding-environments');
  // A new kind of hire gets its own label; no model answer falls back to the active role.
  const other = { ...POST, ts: '1792428000.000200' }, none = { ...POST, ts: '1792428000.000300' };
  assert.equal((await registerPostedBatch({ db, message: other, channelId: CH, clock: () => NOW, claude: claude({ role: { role: 'sales annotators' } }) })).role, 'sales-annotators');
  const fallback = await registerPostedBatch({ db, message: none, channelId: CH, clock: () => NOW, claude: claude({}) });
  assert.deepEqual([fallback.role, fallback.roleBy], ['rl-coding-environments', 'active']);
});

test('Taste: a one-bullet answer from many verdicts is asked again; bullets given as one string are split', async () => {
  const { updateTaste, tasteBullets } = await import('../service/lib/sourcing.mjs');
  assert.deepEqual(tasteBullets('- Likes RL envs\n- Passes on directors'), ['Likes RL envs', 'Passes on directors']);
  assert.deepEqual(tasteBullets('["a","b"]'), ['a', 'b']);
  let n = 0;
  const model = claude({ taste: () => (++n === 1 ? { bullets: ['Only one'] } : { bullets: ['One', 'Two', 'Three', 'Four'] }) });
  const verdicts = Array.from({ length: 10 }, (_, i) => ({ name: `P${i}`, verdict: 'reach_out', by: 'Robin' }));
  assert.deepEqual((await updateTaste({ claude: model, taste: { bullets: [] }, verdicts })).bullets, ['One', 'Two', 'Three', 'Four']);
  assert.equal(n, 2);
  n = 0;
  await updateTaste({ claude: model, taste: { bullets: [] }, verdicts: verdicts.slice(0, 2) });
  assert.equal(n, 1, 'few verdicts: one ask');
});

test('findPick: Robin\'s picks in the last 90 days, by LinkedIn or one exact full name; India from their location', async () => {
  const { findPick } = await import('../service/lib/sourcing.mjs');
  const db = d1(), kv = noticeStore(db);
  await kv.put('sourcing:verdict:priya-shah-1a2b', { slug: 'priya-shah-1a2b', name: 'Priya Shah', verdict: 'reach_out', by: 'Robin', location: 'Pune, India', at: NOW - 86400_000 }, NOW);
  await kv.put('sourcing:log', { items: [{ slug: 'sam-lee-99', name: 'Sam Lee', verdict: 'reach_out', by: 'Alexis', at: NOW - 86400_000 }, { slug: 'arjunrao', name: 'Arjun Rao', verdict: 'pass', at: NOW }] }, NOW);
  assert.deepEqual(await findPick({ db, linkedin: 'https://in.linkedin.com/in/priya-shah-1a2b', now: NOW }), { slug: 'priya-shah-1a2b', name: 'Priya Shah', location: 'Pune, India', india: true, at: NOW - 86400_000, by: 'Robin' });
  assert.equal((await findPick({ db, name: 'sam lee', now: NOW })).slug, 'sam-lee-99');
  assert.equal(await findPick({ db, name: 'Arjun Rao', now: NOW }), null, 'a pass is not a pick');
  assert.equal(await findPick({ db, name: 'Sam', now: NOW }), null, 'a first name alone never');
  assert.equal(await findPick({ db, name: 'Sam Lee', now: NOW + 100 * 86400_000 }), null, 'older than 90 days');
});

test('a temporary ranking outage releases only the pre-send day claim and retries without marking candidates seen', async () => {
  const db=d1(), kv=noticeStore(db), messages=[];
  const args={db,notion:{readControl:async()=>({mode:'Live'})},clock:()=>NOW,poolLeads:async()=>leads(2),poster:async t=>{messages.push(t);return '1792429000.009900';}};
  const failed=await runDailySourcing({...args,claude:{complete:async()=>{throw Error('temporary')}}});
  assert.equal(failed.error,'sourcing_rank_unavailable');assert.equal(await kv.get('sourcing:day:2026-10-19'),null);
  assert.equal(await kv.get('sourcing:seen:lead-1'),null);assert.deepEqual(messages,[]);
  const retried=await runDailySourcing({...args,claude:claude({pick:{picks:[{slug:'lead-1',why:'supported fixture'}]}})});
  assert.equal(retried.picked,1);assert.equal(messages.length,1);
  assert.equal(await kv.get('sourcing:seen:lead-2'),null,'unselected profiles are not marked seen');
});
