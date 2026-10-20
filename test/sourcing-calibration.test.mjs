import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readSourcingCalibration, calibrationKey, calibrationText, verifiedFitEvidence } from '../service/lib/sourcing-calibration.mjs';
import { rankLeads } from '../service/lib/sourcing.mjs';
import { setRole, saveRoleLearning } from '../service/lib/sourcing-roles.mjs';
import { planSearches } from '../service/lib/wrangle.mjs';
import { peopleIn } from '../service/lib/juicebox.mjs';
const cal=JSON.parse(fs.readFileSync(new URL('../docs/sourcing-calibration-2026-10-20.json',import.meta.url)));
const make=(slug,company='Example')=>({slug,name:slug,company,title:'ML Engineer',location:'Hyderabad, India',headline:'Built synthetic data pipelines and model evaluation infrastructure',workEvidence:['Designed RL environments and verifiers for coding agents.']});
const lead=make('good-one');
const quote=lead.workEvidence[0];
const model=picks=>({complete:async()=>({content:[{type:'tool_use',name:'pick',input:{picks}}]})});
const pick=(slug='good-one',evidence=quote)=>({slug,evidence,why:'Owns environment and verifier work',line:'RL environments and verifiers'});
test('six explicit examples persist through learned taste rewrite and role switching without influencing another role',async()=>{
 const values=new Map();const kv={get:async k=>values.get(k)??null,put:async(k,v)=>values.set(k,structuredClone(v))};
 await setRole(kv,{name:'RL coding environments',brief:'India engineering'},1);
 await kv.put(calibrationKey(cal.role),cal);
 await saveRoleLearning(kv,cal.role,{taste:{bullets:['generic infra']},steers:[]},2);
 await setRole(kv,{name:'Sales',brief:'Sales'},3);
 assert.equal(await readSourcingCalibration(kv,'sales'),null);
 await setRole(kv,{name:'RL coding environments'},4);
 assert.deepEqual(await readSourcingCalibration(kv,cal.role),cal);assert.equal(cal.examples.length,6);
 assert.match(calibrationText(cal),/Dylan Hayes/);assert.match(calibrationText(cal),/not a completed work trial/);
 assert.equal(values.has('sourcing:log'),false);assert.equal(values.has('sourcing:verdict:sample-ca1df630ee6d'),false);
});
test('ranking keeps supported picks only: no quota padding, company inference, foreign/missing location, or fabricated quote',async()=>{
 const leads=[lead,make('generic'),{...make('overseas'),location:'San Francisco, United States'}, {...make('unknown'),location:''}];
 leads[1].headline='Backend engineer building RAG applications';leads[1].workEvidence=[];
 const picks=[pick(),pick('generic'),pick('overseas'),pick('unknown'),pick('missing')];
 assert.deepEqual((await rankLeads({claude:model(picks),leads,calibration:cal,count:10})).map(x=>x.slug),['good-one']);
 assert.deepEqual(await rankLeads({claude:model([]),leads,calibration:cal}),[]);
 assert.equal(verifiedFitEvidence({...lead,headline:'No synthetic data experience',workEvidence:[]},{evidence:'No synthetic data experience'},cal),false);
});
test('model outages and malformed results never emit unranked candidates',async()=>{
 for(const claude of [null,{complete:async()=>{throw Error('down')}}, {complete:async()=>({content:[]})}]) await assert.rejects(rankLeads({claude,leads:[lead],calibration:cal}),/sourcing_rank_unavailable/);
});
test('examples are not new targets; model cannot pick unseen roster entries; company mix still applies',async()=>{
 const leads=[make('sample-spencer'),...Array.from({length:65},(_,i)=>make(`candidate-${i}`,i<3?'Same company':`Co${i}`))];
 const picks=leads.map(x=>pick(x.slug));const result=await rankLeads({claude:model(picks),leads,calibration:cal,count:25});
 assert.ok(result.every(x=>x.slug!=='sample-spencer'&&Number(x.slug.split('-')[1])<60));
 assert.equal(result.filter(x=>x.company==='Same company').length,2);
});
test('search planning and ranking see explicit calibration and actual job evidence',async()=>{
 const calls=[];const claude={complete:async req=>{calls.push(req);return {content:[{type:'tool_use',name:req.tools[0].name,input:req.tools[0].name==='pick'?{picks:[pick()]}:{searches:[{angle:'core',query:'India RL environment builders'}]}}]};}};
 await planSearches({claude,brief:'India RL',taste:{bullets:[]},calibration:cal});
 await rankLeads({claude,leads:[lead],calibration:cal});
 assert.equal(calls.length,2);for(const r of calls) assert.match(r.messages[0].content,/Spencer Miller[\s\S]*Avery James Carter[\s\S]*Dylan Hayes/);
 assert.match(calls[1].messages[0].content,/Designed RL environments and verifiers/);
});
test('Wrangle/Juicebox retain work descriptions, bounded, instead of title-only ranking',()=>{
 const out=peopleIn({name:'Example Engineer',linkedin_url:'https://www.linkedin.com/in/example-one',summary:'Built synthetic data pipelines',experience:[{title:'Engineer',description:'Designed model evaluation infrastructure'},{description:'x'.repeat(2000)}]})[0];
 assert.deepEqual(out.workEvidence.slice(0,2),['Built synthetic data pipelines','Designed model evaluation infrastructure']);assert.equal(out.workEvidence[2].length,1500);
});
