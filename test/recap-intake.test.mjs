import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runRecapIntake, readRecap, emailFromCalendar, RECAP_DIGEST } from '../service/lib/recap-intake.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const ROBIN = 'U0A4F08721B', INTERVIEWER = 'U030A09DBFF';
const POST_TS = '1792177719.329949';
const POSTED = Math.round(Number(POST_TS) * 1000);
const RECAP = `*Interview recap — Dylan Hayes (Mercor) · Synth pipeline engineer (Bangalore)*
Fri Oct 16, 11:14 am PT · Interviewers: Robin · Stage: intro
*How it went:* Strong (aligned on vision + comp; wants time to decide)
• Built Mercor's first synth pipeline in 2 days (50-task Meta delivery)
*Next steps:*
• Dylan: get back by next Thu/Fri (Oct 22–23), after his sister's wedding Oct 20
• Robin: WhatsApp group with Dylan + Alexis; follow up next week`;
const DYLAN = { name: 'Dylan Hayes', linkedin: '', company: 'Mercor', place: 'Bangalore', place_quote: 'Synth pipeline engineer (Bangalore)', round: 'intro', went: 'strong',
  next: 'candidate_deciding', next_quote: 'Dylan: get back by next Thu/Fri (Oct 22–23), after his sister\'s wedding Oct 20', follow_up: '2026-10-23',
  next_steps: 'Dylan gets back by Oct 22–23; Robin follows up next week.', summary: 'Intro with Robin went strong; aligned on vision and comp; he wants time to decide.' };
const claudeSaying = candidates => ({ complete: async () => ({ content: [{ type: 'tool_use', name: 'report_recap', input: { candidates } }] }) });
const CALENDAR = { listEvents: async () => [{ summary: 'Dylan / Company', status: 'confirmed', attendees: [{ email: 'robin@company.example' }, { email: 'hayes.akshat92@example.test' }, { email: 'alexis@company.example' }] }] };

function fakeNotion(records = new Map()) {
  const n = { records, created: [], recaps: [], notes: [], pipelines: [] };
  n.readControl = async () => ({ mode: 'Live' });
  n.findCandidatesByLinkedIn = async slug => [...records.values()].filter(r => r.profile?.linkedin?.includes(slug));
  n.findCandidatesByName = async name => [...records.values()].filter(r => r.fullName.includes(name));
  n.getCandidate = async id => structuredClone(records.get(id));
  n.createCandidate = async a => { n.created.push(a); const id = `new${n.created.length}`; records.set(id, { pageId: id, fullName: a.fullName, email: a.email, url: `https://notion.so/${id}`, profile: { linkedin: a.linkedin }, fields: { Stage: a.stage, Round: a.round, Outcome: a.outcome, Pipeline: a.pipeline, 'India Stage': a.indiaStage } }); return { pageId: id, url: `https://notion.so/${id}` }; };
  n.setPipeline = async a => { n.pipelines.push(a); records.get(a.pageId).fields.Pipeline = a.pipeline; };
  n.recordRecap = async a => { n.recaps.push(a); const changed = []; const f = records.get(a.pageId).fields;
    if (a.toInterview && ['Intro Call', 'Outreach'].includes(f.Stage)) { f.Stage = 'Interview'; changed.push('Stage'); }
    else if (a.toIntro && f.Stage === 'Outreach') { f.Stage = 'Interview'; changed.push('Stage'); }
    if (a.outcome && f.Outcome !== a.outcome) { f.Outcome = a.outcome; changed.push('Outcome'); }
    if (a.followUp) changed.push('Follow-up Date'); return { verified: true, changed }; };
  n.appendCandidateNote = async x => { n.notes.push(x); };
  return n;
}
function world({ notion = fakeNotion(), candidates = [DYLAN], messages = [{ ts: POST_TS, user: ROBIN, text: RECAP }] } = {}) {
  const w = { db: d1(), notion, said: [], acknowledgements: [] };
  w.reactions = [];
  w.run = (now, extra = {}) => runRecapIntake({ react: async (ch, ts, name) => { w.reactions.push([ch, ts, name]); }, env: { UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled' }, db: w.db, notion, claude: claudeSaying(candidates),
    slackRead: { readHistory: async ({ oldest }) => messages.filter(m => Number(m.ts) >= Number(oldest)) }, calendar: CALENDAR, calendarIds: ['robin@company.example'],
    poster: async t => { w.said.push(t); }, channelPoster: async t => { w.acknowledgements.push(t); return (now / 1000).toFixed(6); }, clock: () => now, ...extra });
  return w;
}

test('Recaps: the rules are plain in the prompt', () => {
  assert.match(RECAP_DIGEST, /candidate_deciding: the candidate wants time or will get back to us/);
  assert.match(RECAP_DIGEST, /copied exactly from the post/);
});

test('a short series of recaps gets one Roger that after quiet time, including across ticks', async () => {
  const messages=[{ts:POST_TS,user:ROBIN,text:RECAP}];
  const w=world({messages});const sent=[];const extra={channelPoster:async text=>{sent.push(text);return '1792178000.000001';}};
  await w.run(POSTED-60000,extra);await w.run(POSTED+30000,extra);assert.equal(sent.length,0);
  messages.push({ts:String(Number(POST_TS)+60),user:ROBIN,text:RECAP});
  await w.run(POSTED+80000,extra);assert.equal(sent.length,0);
  await w.run(POSTED+200000,extra);assert.equal(sent.length,0);
  await w.run(POSTED+400000,extra);assert.deepEqual(sent,['Roger that 🫡']);
  await w.run(POSTED+500000,extra);assert.equal(sent.length,1);
});

test('failed record verification gets a blocker acknowledgement and no success reaction',async()=>{
  const w=world();w.notion.appendCandidateNote=async()=>{throw Error('outage');};const sent=[];
  const extra={channelPoster:async text=>{sent.push(text);return '1792178000.000001';}};
  await w.run(POSTED-60000,extra);await w.run(POSTED+300000,extra);
  assert.equal(w.reactions.length,0);assert.match(sent[0],/^Roger that 🫡 Dylan Hayes could not be verified/);
});

test('an uncertain acknowledgement is not resent and does not block later recap batches',async()=>{
  const messages=[0,1].map(n=>({ts:(Number(POST_TS)+n).toFixed(6),user:ROBIN,text:RECAP}));const w=world({messages});let calls=0;
  const extra={channelPoster:async()=>{calls++;throw Error('response_lost');}};
  await w.run(POSTED-60000,extra);await w.run(POSTED+400000,extra);await w.run(POSTED+500000,extra);assert.equal(calls,1);
  messages.push(...[600,601].map(n=>({ts:(Number(POST_TS)+n).toFixed(6),user:ROBIN,text:RECAP})));
  await w.run(POSTED+1000000,extra);assert.equal(calls,2);
});

test('explicit single-candidate decisions use the verified decision handler before a historical closed-record guard',async()=>{
  const records=new Map([['c1',{pageId:'c1',fullName:'Dylan Hayes',email:'dylan@example.com',url:'https://notion.so/c1',fields:{Outcome:'Not Selected'}}]]);
  const text='Interview recap — Dylan Hayes\nDecision: Moving to take-home';
  const w=world({notion:fakeNotion(records),messages:[{ts:POST_TS,user:ROBIN,text}],candidates:[{...DYLAN,next:'take_home',next_quote:'Decision: Moving to take-home'}]});
  const calls=[];const extra={decision:async input=>{calls.push(input);return {kind:'takehome_invite_queued'};}};
  await w.run(POSTED-60000,extra);await w.run(POSTED+300000,extra);
  assert.equal(calls.length,1);assert.equal(calls[0].authorId,ROBIN);assert.equal(calls[0].messageTs,POST_TS);assert.equal(w.said.length,0);
});

test('Recaps: switched on from now; older posts are history', async () => {
  const w = world();
  assert.equal((await w.run(POSTED + 60_000)).state, 'baselined');
  await w.run(POSTED + 360_000);
  assert.equal(w.notion.created.length, 0);
});

test("Recaps: Robin's recap of a new person -> added at Interview, India, On Hold, follow-up date, note; nothing sent", async () => {
  const w = world();
  await w.run(POSTED - 60_000);
  const r = await w.run(POSTED + 300_000);
  assert.equal(r.added, 1);
  assert.deepEqual(w.notion.created[0], { fullName: 'Dylan Hayes', email: 'hayes.akshat92@example.test', linkedin: null, pipeline: 'India', stage: 'Interview', round: 'R2 — Technical',
    outcome: 'Not Yet Decided', indiaStage: 'First Round', nextAction: "Added by Uncle Sam from Robin's recap; see the note." });
  assert.equal(w.notion.recaps[0].outcome, 'On Hold');
  assert.equal(w.notion.recaps[0].followUp, '2026-10-23');
  assert.match(w.notion.recaps[0].nextAction, /^HOLD: send nothing \(no take-home, invite or rejection\)\. Dylan gets back by Oct 22–23/);
  assert.match(w.notion.notes[0].text, /^2026-10-16 · Robin's recap \(intro\), strong: Intro with Robin went strong/);
  assert.equal(w.notion.notes[0].sourceUrl, 'https://example-workspace.slack.com/archives/C01D1A69CE3/p1792177719329949');
  assert.match(w.said[0], /^📋 From Robin's recap \(<https:\/\/example-workspace\.slack\.com\/archives\/C01D1A69CE3\/p1792177719329949\|post>\):\n• <https:\/\/notion\.so\/new1\|Dylan Hayes>: added · Interview · India · On Hold · follow up 2026-10-23 · note added\.$/);
  await w.run(POSTED + 600_000);
  assert.equal(w.notion.created.length, 1, 'each post once');
});

test('Recaps: a known candidate is updated; a next step not quoted word for word changes nothing but the note', async () => {
  const records = new Map([['c1', { pageId: 'c1', fullName: 'Cameron Wells', email: 's@x.com', url: 'https://notion.so/c1', profile: { linkedin: 'https://www.linkedin.com/in/sample-cameron-wells' }, fields: { Stage: 'Intro Call', Outcome: 'Not Yet Decided', Pipeline: 'India' } }]]);
  const text = 'Spoke with - <https://www.linkedin.com/in/sample-cameron-wells|Cameron Wells>\nVerdict : Send him Take Home\nStated experience working on RL.';
  const w = world({ notion: fakeNotion(records), messages: [{ ts: POST_TS, user: INTERVIEWER, text }], candidates: [{ name: 'Cameron Wells', linkedin: 'https://www.linkedin.com/in/sample-cameron-wells',
    round: 'intro', went: 'strong', next: 'take_home', next_quote: 'Verdict : Send him Take Home', next_steps: 'Send him the take-home.', summary: 'Worked on RL; interested in RSI for policy learning.' }] });
  await w.run(POSTED - 60_000);
  await w.run(POSTED + 300_000);
  assert.deepEqual(w.notion.recaps[0], { pageId: 'c1', expectedEmail: 's@x.com', toInterview: false, toIntro: true, outcome: 'Proceeding', nextAction: 'Interviewer: Send him the take-home.', followUp: null });
  assert.equal(w.notion.created.length, 0);
  const v = world({ notion: fakeNotion(new Map([['c1', structuredClone(records.get('c1'))]])), messages: [{ ts: POST_TS, user: INTERVIEWER, text }], candidates: [{ name: 'Cameron Wells', round: 'intro', went: 'strong', next: 'take_home', next_quote: 'send the take-home now', summary: 'x' }] });
  await v.run(POSTED - 60_000);
  await v.run(POSTED + 300_000);
  assert.equal(v.notion.recaps[0].outcome, null);
  assert.match(v.said[0], /Next step unclear; I changed no stage or outcome\./);
});

test('Recaps: chatter and other people are ignored; no invite email means no record', async () => {
  const w = world({ messages: [{ ts: POST_TS, user: ROBIN, text: 'sure' }, { ts: '1792177800.000001', user: 'UOTHER', text: 'Interview recap — X Y' }] });
  await w.run(POSTED - 60_000);
  assert.equal((await w.run(POSTED + 300_000)).read, 0);
  assert.equal(await emailFromCalendar({ calendar: CALENDAR, calendarIds: ['x'], name: 'River Collins', postedAt: POSTED }), null);
  assert.equal(await emailFromCalendar({ calendar: CALENDAR, calendarIds: ['x'], name: 'Dylan Hayes', postedAt: POSTED }), 'hayes.akshat92@example.test');
});

test('Recaps: quotes are checked against the post', async () => {
  const found = await readRecap({ claude: claudeSaying([{ ...DYLAN, place_quote: 'based in Pune' }]), text: RECAP, postedAt: POSTED });
  assert.equal(found[0].pipeline, null, 'a place not in the post is not used');
  assert.equal(found[0].next, 'candidate_deciding');
});

test('Recaps: a recorded recap gets a ✅; a held Robin booking is settled by it; an Outreach record moves to Interview', async () => {
  const w = world();
  await w.db.prepare('INSERT INTO uncle_sam_notices (name, value, updated_at) VALUES (?, ?, ?)').bind('booking-new:ak1', JSON.stringify({ heldAt: POSTED - 3600_000, name: 'Dylan Hayes', email: 'held@x.com', kind: 'outreach', pipeline: null }), 0).run();
  await w.run(POSTED - 60_000);
  await w.run(POSTED + 300_000);
  assert.deepEqual(w.reactions, [['C01D1A69CE3', POST_TS, 'white_check_mark']]);
  assert.equal(w.notion.created[0].email, 'held@x.com', 'the booking email is used');
  const held = JSON.parse((await w.db.prepare('SELECT value FROM uncle_sam_notices WHERE name = ?').bind('booking-new:ak1').first()).value);
  assert.equal(held.pageId, 'new1');
  assert.ok(held.done && held.viaRecap);
  const records = new Map([['o1', { pageId: 'o1', fullName: 'River Collins', email: 'mt@x.com', url: 'https://notion.so/o1', profile: {}, fields: { Stage: 'Outreach', Outcome: 'Not Yet Decided' } }]]);
  const text = 'Interview recap — River Collins\nHow it went: mixed. Next: unclear.';
  const v = world({ notion: fakeNotion(records), messages: [{ ts: POST_TS, user: ROBIN, text }], candidates: [{ name: 'River Collins', round: 'intro', went: 'mixed', next: 'unclear', next_quote: '', summary: 'Mixed intro.' }] });
  await v.run(POSTED - 60_000);
  await v.run(POSTED + 300_000);
  assert.equal(records.get('o1').fields.Stage, 'Interview');
  assert.match(v.said[0], /Interview \(out of Outreach\)/);
  assert.equal(v.reactions.length, 0, 'an unclear next step is recorded but does not get a success checkmark');
});

test("Recaps: Interviewer's quoted take-home verdict queues the invite quietly; Jamie's, an unquoted one or a hold never do", async () => {
  const record = () => new Map([['c1', { pageId: 'c1', fullName: 'Cameron Wells', email: 's@x.com', url: 'https://notion.so/c1', profile: { linkedin: 'https://www.linkedin.com/in/sample-cameron-wells' }, fields: { Stage: 'Case Study', Outcome: 'Proceeding', Pipeline: 'Research (COLM)' } }]]);
  const text = 'Spoke with - <https://www.linkedin.com/in/sample-cameron-wells|Cameron Wells>\nVerdict : Send him Take Home\nStated experience working on RL.';
  const said = { name: 'Cameron Wells', linkedin: 'https://www.linkedin.com/in/sample-cameron-wells', round: 'intro', went: 'strong', next: 'take_home', next_quote: 'Verdict : Send him Take Home', summary: 'RL.' };
  const calls = [];
  const takeHome = async input => { calls.push(input); return { kind: 'takehome_invite_queued' }; };
  const w = world({ notion: fakeNotion(record()), messages: [{ ts: POST_TS, user: INTERVIEWER, text }], candidates: [said] });
  await w.run(POSTED - 60_000, { takeHome }); await w.run(POSTED + 300_000, { takeHome });
  assert.deepEqual(calls, [{ candidatePageId: 'c1', by: 'Interviewer', quote: 'Verdict : Send him Take Home', at: POSTED }]);
  assert.equal(w.said.length, 0, 'the channel acknowledgement is enough; no routine DM');
  assert.deepEqual(w.reactions, [['C01D1A69CE3', POST_TS, 'white_check_mark']]);
  // Jamie may not call a take-home; a next step not quoted word for word is unclear and sends nothing.
  for (const [user, cand] of [['U0CB213D6D6', said], [INTERVIEWER, { ...said, next_quote: 'send it now please' }]]) {
    const v = world({ notion: fakeNotion(record()), messages: [{ ts: POST_TS, user, text }], candidates: [cand] });
    const before = calls.length;
    await v.run(POSTED - 60_000, { takeHome }); await v.run(POSTED + 300_000, { takeHome });
    assert.equal(calls.length, before);
  }
});

test("Recaps: a quoted work-trial verdict from Robin or Interviewer, any round, puts the packet one tap away for Project; Jamie's never does", async () => {
  const record = () => new Map([['c1', { pageId: 'c1', fullName: 'Cameron Wells', email: 's@x.com', url: 'https://notion.so/c1', profile: { linkedin: 'https://www.linkedin.com/in/sample-cameron-wells' }, fields: { Stage: 'Interview', Outcome: 'Proceeding', Pipeline: 'Research (COLM)' } }]]);
  const text = 'Spoke with - <https://www.linkedin.com/in/sample-cameron-wells|Cameron Wells>\nVerdict : Work trial next week\nStrong on evals.';
  const said = round => ({ name: 'Cameron Wells', linkedin: 'https://www.linkedin.com/in/sample-cameron-wells', round, went: 'strong', next: 'work_trial', next_quote: 'Verdict : Work trial next week', summary: 'Evals.' });
  const calls = [];
  const packetOffer = async input => { calls.push(input); return { kind: 'packet_offer_sent' }; };
  for (const [user, round, asked] of [[ROBIN, 'interview', true], [INTERVIEWER, 'deep_dive', true], [INTERVIEWER, 'interview', true], ['U0CB213D6D6', 'interview', false]]) {
    const w = world({ notion: fakeNotion(record()), messages: [{ ts: POST_TS, user, text }], candidates: [said(round)] });
    const before = calls.length;
    await w.run(POSTED - 60_000, { packetOffer }); await w.run(POSTED + 300_000, { packetOffer });
    assert.equal(calls.length, before + (asked ? 1 : 0), `${user} ${round}`);
    if (asked) assert.equal(w.said.length, 0, 'the offer is the only message');
  }
});


test('a standalone checkmark retries after a temporary failure without a text acknowledgement',async()=>{
  const w=world(),sent=[];let calls=0;
  const extra={channelPoster:async text=>{sent.push(text);return String((POSTED+300000)/1000);},react:async()=>{if(++calls===1)throw Error('outage');}};
  await w.run(POSTED-60000,extra);await w.run(POSTED+300000,extra);
  assert.equal(sent.length,0);await w.run(POSTED+400000,extra);
  assert.equal(calls,2);assert.equal(sent.length,0);
  await w.run(POSTED+500000,extra);assert.equal(calls,2);
});

test('a newly arriving author message defers the salute until the batch is quiet',async()=>{
  const messages=[{ts:POST_TS,user:ROBIN,text:RECAP}],w=world({messages}),sent=[];let reads=0;
  const extra={channelPoster:async t=>{sent.push(t);return String((POSTED+700000)/1000);},slackRead:{readHistory:async({oldest})=>{
    if(++reads===2)messages.push({ts:String((POSTED+290000)/1000),user:ROBIN,text:'One more coming'});
    return messages.filter(m=>Number(m.ts)>=Number(oldest));
  }}};
  await w.run(POSTED-60000,extra);await w.run(POSTED+300000,extra);assert.equal(sent.length,0);
  await w.run(POSTED+400000,extra);assert.equal(sent.length,0);
  await w.run(POSTED+700000,extra);assert.equal(sent.length,0);assert.equal(w.reactions.length,1);
});

test('a late continuation is handled silently without another immediate acknowledgement',async()=>{
  const messages=[0,1].map(n=>({ts:(Number(POST_TS)+n).toFixed(6),user:ROBIN,text:RECAP})),w=world({messages}),sent=[];
  const extra={channelPoster:async t=>{sent.push(t);return ((POSTED+400000)/1000).toFixed(6);}};
  await w.run(POSTED-60000,extra);await w.run(POSTED+400000,extra);assert.equal(sent.length,1);
  messages.push({ts:((POSTED+460000)/1000).toFixed(6),user:ROBIN,text:RECAP});
  await w.run(POSTED+800000,extra);assert.equal(sent.length,1);assert.equal(w.reactions.length,0);
});

test('three successful recaps get one group acknowledgement and no individual reactions',async()=>{
  const messages=[0,60,120].map(seconds=>({ts:((POSTED+seconds*1000)/1000).toFixed(6),user:ROBIN,text:RECAP}));
  const w=world({messages}),sent=[];
  const extra={channelPoster:async t=>{sent.push(t);return ((POSTED+500000)/1000).toFixed(6);}};
  await w.run(POSTED-60000,extra);await w.run(POSTED+500000,extra);
  assert.equal(w.reactions.length,0);assert.deepEqual(sent,['Roger that 🫡']);
});

test('an unreadable final history check defers acknowledgement without losing processed work',async()=>{
  const w=world(),sent=[];let calls=0;
  const extra={channelPoster:async t=>{sent.push(t);return '1792178000.000001';},slackRead:{readHistory:async options=>{
    if(options.requireComplete&&++calls===1)throw Error('history_incomplete');
    return [{ts:POST_TS,user:ROBIN,text:RECAP}];
  }}};
  await w.run(POSTED-60000,extra);await w.run(POSTED+500000,extra);
  assert.equal(w.reactions.length,0);assert.equal(sent.length,0);
  await w.run(POSTED+600000,extra);assert.equal(sent.length,0);assert.equal(w.reactions.length,1);
});
