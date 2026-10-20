import test from 'node:test';
import assert from 'node:assert/strict';
import { isCandidateDiscoveryQuestion, discoveryTerms, discoveryAlternatives, matchesDiscovery, answerCandidateDiscovery } from '../service/lib/candidate-discovery.mjs';
import { candidateLinkParts } from '../service/lib/name-links.mjs';
import { entryOf } from '../service/lib/qa.mjs';
import { createNotionClient, RECRUITING_SOURCE_ID } from '../service/lib/notion-client.mjs';
import { candidatePage } from './support/qa-world.mjs';
const question = 'Who was the Pareto SPL we were interviewing but then Manager rescheduled his interview';
const c = {pageId:'00000001-1111-4222-8333-444444444444',fullName:'Reese Spencer',inRecruitingSource:true,fields:{Stage:'Closed',Outcome:'Withdrawn or Unavailable','Candidate brief':'Senior Strategic Projects Lead at Pareto.AI. Manager rescheduled his interview. No replacement confirmed. Private pay $200.'},profile:{linkedin:'https://www.linkedin.com/in/sample-519eca3fe14e/'}};
const answer = (candidates,extra={})=>answerCandidateDiscovery({question,entryOf,notion:{searchCandidateEvidence:async()=>({candidates,truncated:false}),getCandidate:async()=>c,...extra}});
test('recognizes identity and profile questions, but not explicit workflow changes or calendar lists',()=>{
 for(const t of [question,"show Reese Spencer's LinkedIn again",'Find that candidate from Pareto']) assert.equal(isCandidateDiscoveryQuestion(t),true,t);
 for(const t of ['reject Reese Spencer','reschedule Reese Spencer','who is scheduled tomorrow?','who is in round 2?','Who was at Pareto and then reject him']) assert.equal(isCandidateDiscoveryQuestion(t),false,t);
 assert.deepEqual(discoveryTerms(question),['pareto','spl','interview','manager','reschedul']);
 assert.deepEqual(discoveryTerms("show Reese Spencer's LinkedIn again"),['reese','spencer']);
});
test('all identifying clues, including full role abbreviations; no partial or negative evidence substitutes',async()=>{
 assert.equal(matchesDiscovery(c,discoveryTerms(question)),true);
 const unrelated={...c,fullName:'Sawyer Brooks',fields:{'Candidate brief':'Manager rescheduled his interview. No evidence of Pareto or SPL.'}};
 assert.equal(matchesDiscovery(unrelated,discoveryTerms(question)),false);
 const out=await answer([unrelated,c]); assert.equal(out.candidatePageId,c.pageId);
 assert.equal(out.parts[1].link.url,'https://www.linkedin.com/in/sample-519eca3fe14e');
 assert.doesNotMatch(out.text,/Private|200|Withdrawn|reopen|Sawyer/);
 assert.equal((await answer([unrelated])).reason,'discovery_no_verified_match');
});
test('multiple, truncated, changed and inaccessible results never guess or write',async()=>{
 assert.equal((await answer([c,{...c,pageId:'00000002-1111-4222-8333-444444444444',fullName:'Another Person'}])).reason,'discovery_ambiguous');
 assert.equal((await answer([c],{searchCandidateEvidence:async()=>({candidates:[c],truncated:true})})).reason,'discovery_incomplete');
 assert.equal((await answer([c],{getCandidate:async()=>({...c,archived:true})})).reason,'discovery_changed');
 await assert.rejects(answer([],{searchCandidateEvidence:async()=>{throw new Error('offline');}}),/offline/);
});
test('trusted links prefer LinkedIn, use canonical tracker fallback, respect whole names and ambiguous namesakes',()=>{
 assert.equal(candidateLinkParts('Reese Spencer',[c])[0].link.url,'https://www.linkedin.com/in/sample-519eca3fe14e');
 const fallback={...c,profile:{linkedin:'https://linkedin.com.evil.test/in/fake'}};
 assert.equal(candidateLinkParts('Reese Spencer',[fallback])[0].link.url,'https://www.notion.so/00000001111142228333444444444444');
 assert.equal(candidateLinkParts('Reese Proctorville',[c]),null);
 assert.equal(candidateLinkParts('Reese Spencer',[c,{...c,profile:{linkedin:'https://www.linkedin.com/in/different'}}]),null);
});
function restClient(pages){const calls=[];let i=0;const client=createNotionClient({env:{NOTION_TOKEN:'fixture'},fetchImpl:async(url,init)=>{const body=init.body?JSON.parse(init.body):null;calls.push({url,method:init.method,body});if(url.endsWith(RECRUITING_SOURCE_ID))return Response.json({object:'data_source',id:RECRUITING_SOURCE_ID,properties:{Candidate:{type:'title'},'Candidate brief':{type:'rich_text'},'Category Basis':{type:'rich_text'}}});return Response.json(pages[i++]);}});return {client,calls};}
test('Notion evidence search includes closed records, follows cursors, deduplicates and skips fixtures',async()=>{
 const closed=candidatePage({name:'Reese Spencer',stage:'Closed'});
 const {client,calls}=restClient([{object:'list',results:[closed],has_more:true,next_cursor:'page2'},{object:'list',results:[closed,candidatePage({n:2,name:'[FIXTURE] Ignore'})],has_more:false}]);
 const terms=discoveryTerms(question);const out=await client.searchCandidateEvidence({terms,alternatives:terms.map(discoveryAlternatives)});
 assert.equal(out.candidates.length,1);assert.equal(out.candidates[0].fields.Stage,'Closed');assert.equal(out.truncated,false);
 assert.equal(calls[2].body.start_cursor,'page2');assert.doesNotMatch(JSON.stringify(calls[1].body.filter),/Stage|Outcome/);
 assert.ok(calls.every(x=>x.method==='GET'||x.url.endsWith('/query')));
});
test('Notion incomplete paging is explicit; missing cursor is an error',async()=>{
 const terms=['pareto'],args={terms,alternatives:[['pareto']]};
 const {client}=restClient(Array.from({length:3},()=>({object:'list',results:[],has_more:true,next_cursor:'next'})));
 assert.equal((await client.searchCandidateEvidence(args)).truncated,true);
 const bad=restClient([{object:'list',results:[],has_more:true}]);await assert.rejects(bad.client.searchCandidateEvidence(args),/candidate_search_cursor_missing/);
});
