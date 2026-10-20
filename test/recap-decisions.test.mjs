import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRecapDecision, isExplicitRecapDecision } from '../service/lib/recap-decisions.mjs';
import { isNonSendingRejectionBaseline } from '../service/lib/rejection-sender.mjs';
const TS = '1792526543.573949', NOW = Number(TS) * 1000 + 300000;
function world(next = 'reject') {
  const quote = next === 'reject' ? 'Decision: Not moving forward' : 'Decision: Moving to take-home';
  const candidate = { pageId: 'c1', fullName: 'Example Candidate', email: 'candidate@example.com', emailVerified: true,
    inRecruitingSource: true, fields: { Outcome: 'Proceeding', Stage: 'Interview' }, profile: {}, lastEditedTime: '2026-10-20T18:00:00Z' };
  const sender = { status: null, hold: false }, writes = [], queues = [];
  const w = { candidate, sender, writes, queues, post: { ts: TS, user: 'U0A4F08721B', text: `Interview recap — Example Candidate\n${quote}\ncandidate@example.com` } };
  w.notion = { readControl: async () => ({ mode: 'Live' }), getRejectionState: async () => ({ candidate: structuredClone(candidate), sender: structuredClone(sender) }),
    findCandidatesByName: async () => [structuredClone(candidate)], findTakeHomeScorecard: async () => null, findOperationsForCandidate: async () => [],
    listCandidateInterviews: async () => [{ end: '2026-10-20T17:45:00Z', htmlLink: 'https://calendar.google.com/event?eid=verified' }],
    applyExplicitRecapDecision: async p => { writes.push(p); candidate.fields.Outcome = p.outcome; sender.hold = false; sender.status = null; if(p.interviewEnd) sender.lastInterviewEnd = p.interviewEnd.at; },
    writeRejection: async ({ fields }) => { writes.push(fields); Object.assign(sender, fields); return { candidate, sender }; } };
  w.args = { env: { UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled' }, notion: w.notion,
    slackRead: { readThread: async () => [w.post] }, gmail: { searchSent: async () => [] },
    takeHome: async p => { queues.push(p); return { kind: 'takehome_invite_queued' }; }, candidatePageId: 'c1', name: candidate.fullName,
    authorId: w.post.user, channelId: 'C01D1A69CE3', messageTs: TS, next, quote, clock: () => NOW };
  return w;
}
test('clear Robin rejection is queued 24 hours after the verified interview; repeat never queues twice', async () => {
  const w = world();
  const r = await applyRecapDecision(w.args);
  assert.equal(r.kind, 'recap_rejection_queued');
  assert.equal(r.scheduledFor, '2026-10-21T17:45:00.000Z');
  assert.equal(w.sender.queuedTo, 'candidate@example.com');
  assert.equal(w.candidate.fields.Outcome, 'Not Selected');
  assert.equal(w.queues.length, 0, 'no take-home or candidate email called');
  assert.equal((await applyRecapDecision(w.args)).reason, 'rejection_already_queued');
  assert.equal(w.writes.length, 2);
});
test('missing interview end uses recap time and never sends before that plus 24 hours', async () => {
  const w = world(); w.notion.listCandidateInterviews = async () => [];
  assert.equal((await applyRecapDecision(w.args)).scheduledFor, '2026-10-21T20:03:00.000Z');
});
test('a later recorded interview can only push the normal rejection window later', async () => {
  const w=world(); w.sender.lastInterviewEnd='2026-10-20T20:00:00Z'; w.sender.timingSource='https://calendar.google.com/event?eid=later';
  assert.equal((await applyRecapDecision(w.args)).scheduledFor,'2026-10-21T20:00:00.000Z');
});
test('newer take-home decision resumes an older held Not Selected candidate and uses the normal queue', async () => {
  const w = world('take_home'); w.candidate.fields.Outcome='Not Selected'; w.candidate.fields['Action Status']='On Hold'; w.sender.hold=true; w.sender.status='Cancelled';
  assert.equal((await applyRecapDecision(w.args)).kind,'takehome_invite_queued');
  assert.equal(w.candidate.fields.Outcome,'Proceeding'); assert.equal(w.queues.length,1);
  assert.equal(w.queues[0].by,'Robin'); assert.equal(w.queues[0].holdMs,undefined,'normal 30-minute queue window retained');
  assert.equal(Number.isSafeInteger(w.queues[0].at),true,'Slack microseconds are rounded to the integer milliseconds required by the durable event store');
});
for (const kind of ['sent','scorecard','queued']) test(`existing take-home ${kind} prevents duplicate delivery`, async () => {
  const w=world('take_home');
  if(kind==='sent') w.args.gmail.searchSent=async()=>[{url:'https://mail.google.com/mail/#sent/1'}];
  if(kind==='scorecard') w.notion.findTakeHomeScorecard=async()=>({pageId:'s1'});
  if(kind==='queued') w.notion.findOperationsForCandidate=async()=>[{state:'Held'}];
  assert.equal((await applyRecapDecision(w.args)).kind,'recap_step_already_exists'); assert.equal(w.queues.length,0);
});
for(const change of ['unauthorized','source_edit','newer_reply','newer_record','uncertain_send','hired','ambiguous','off']) test(`recap decision blocks ${change}`,async()=>{
  const w=world();
  if(change==='unauthorized')w.args.authorId='UOTHER';
  if(change==='source_edit')w.post.text='Interview recap — Example Candidate\nStill deciding';
  if(change==='newer_reply')w.args.slackRead.readThread=async()=>[w.post,{ts:'1792526600.000001',user:w.post.user,text:'Wait, hold off'}];
  if(change==='newer_record')w.candidate.profile.latestEvidence='https://example-workspace.slack.com/archives/C01D1A69CE3/p1792526600000001';
  if(change==='uncertain_send')w.sender.attempt='attempt-1';
  if(change==='hired')w.candidate.fields.Outcome='Hired';
  if(change==='ambiguous'){w.post.text=w.post.text.replace('candidate@example.com','');w.notion.findCandidatesByName=async()=>[w.candidate,{...w.candidate,pageId:'c2'}];}
  if(change==='off')w.args.env.UNCLE_SAM_AUTOMATIC_ACTIVITY='off';
  assert.equal((await applyRecapDecision(w.args)).kind,'recap_decision_blocked'); assert.equal(w.writes.length,0);assert.equal(w.queues.length,0);
});
for(const dependency of ['findTakeHomeScorecard','findOperationsForCandidate','searchSent'])test(`duplicate check outage ${dependency} cannot resume or send`,async()=>{
  const w=world('take_home');const target=dependency==='searchSent'?w.args.gmail:w.notion;target[dependency]=async()=>{throw Error('outage');};
  await assert.rejects(applyRecapDecision(w.args),/outage/);assert.equal(w.writes.length,0);assert.equal(w.queues.length,0);
});
test('tentative or negated decisions never become final rejection authority',()=>{
  for(const quote of ['Maybe reject','I recommend rejection','Do not reject him','Should we reject?','Hold off on rejection']) assert.equal(isExplicitRecapDecision('reject',quote),false,quote);
  assert.equal(isExplicitRecapDecision('reject','Decision: Not moving forward'),true);
});

test('the exact cancelled activation baseline is not an attempted email; real send evidence still blocks',async()=>{
  const w=world('take_home');
  Object.assign(w.sender,{status:'Cancelled',attempt:'Already Not Selected before the October 13, 2026 delayed-rejection activation. Excluded from automatic backfill; no send is asserted. Review separately if outreach is still needed.'});
  assert.equal(isNonSendingRejectionBaseline(w.sender),true);
  assert.equal((await applyRecapDecision(w.args)).kind,'takehome_invite_queued');
  for(const value of [{status:'Sending'},{queuedTo:'candidate@example.com'},{sentAt:'2026-10-13T12:00:00Z'},{attempt:'an actual attempt'}])assert.equal(isNonSendingRejectionBaseline({...w.sender,...value}),false);
});
