import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import ts from 'typescript';
import {raceWithTimeout} from '../fetchWithTimeout.js';
import {observeSearchJob,runBoundedDatabaseWeb,runBoundedDatabaseEnrichment} from '../databaseSearchScheduling.js';
import {resolveProviderSlot} from '../llmProviders.js';
function findAll(tree,fn){const out=[];function walk(n){if(fn(n))out.push(n);ts.forEachChild(n,walk);}walk(tree);return out;}
test('all database external layers start before any source finishes',async()=>{
 const source=fs.readFileSync(new URL('../searchService.js',import.meta.url),'utf8');
 const tree=ts.createSourceFile('searchService.js',source,99,true,ts.ScriptKind.JS);
 const job=findAll(tree,n=>ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(tree)==='databaseParallelJobs'))[0];
 const web=findAll(tree,n=>ts.isIfStatement(n)&&n.expression.getText(tree)==='useMcpWeb !== false'&&n.getText(tree).includes('databaseParallelJobs.web'))[0];
 assert.ok(job&&web);
 const snippet=source.slice(job.getStart(tree),web.end);
 const started=[];let release;const gate=new Promise(r=>release=r);let webPatents;
 const task=(name,value=[])=>async()=>{started.push(name);await gate;return value;};
 const context={
 databaseSearchFastEnabled:()=>true,observeSearchJob,runBoundedDatabaseWeb,raceWithTimeout,
 traceAsync:(_t,_n,_d,fn)=>fn(),throwIfSearchAborted:()=>{},signal:undefined,performanceTrace:null,
 effectiveQuery:'aluminum coating',rawQuery:'aluminum coating',fullContextQuery:'aluminum coating',
 max:100,aq:'all:aluminum',arxivSort:'relevance',doiHit:null,includePatents:true,useMcpWeb:true,opts:{},
 sourcesUsed:[],buckets:[],console,
 fetchArxiv:task('arxiv'),fetchCrossrefWorks:task('crossref'),fetchOpenAlexWorks:task('openalex'),
 fetchSemanticScholarWorks:task('semantic'),fetchScopusWorks:task('scopus'),
 fetchEuropePmcWorks:task('europepmc'),fetchOpenAlexPatents:task('openalex_patents'),fetchPatentPapers:task('patents',{papers:[]}),
 runWebIntelSearch:async args=>{started.push('web');webPatents=args.includePatents;await gate;return{papers:[],patents:[],sourcesUsed:[]};}
 };
 const running=vm.runInNewContext('(async()=>{'+snippet+'})()',context);
 try{
 await new Promise(r=>setImmediate(r));
 assert.deepEqual([...started].sort(),['arxiv','crossref','europepmc','openalex','openalex_patents','patents','scopus','semantic','web']);
 assert.equal(webPatents,false,'patents are already queried by the supplemental source');
 }finally{release();await running;}
});
test('C can explicitly use OpenAI-compatible protocol while Gemini default remains supported',()=>{
 const names=['LLM_PROVIDER_C_API_KEY','LLM_PROVIDER_C_BASE_URL','LLM_PROVIDER_C_MODEL','LLM_PROVIDER_C_PROTOCOL'];
 const before=Object.fromEntries(names.map(n=>[n,process.env[n]]));
 try{
 Object.assign(process.env,{LLM_PROVIDER_C_API_KEY:'test-only',LLM_PROVIDER_C_BASE_URL:'https://api.deepseek.com',LLM_PROVIDER_C_MODEL:'test-c'});
 delete process.env.LLM_PROVIDER_C_PROTOCOL;
 assert.equal(resolveProviderSlot('C').protocol,'gemini_generate_content');
 process.env.LLM_PROVIDER_C_PROTOCOL='openai_chat_completions';
 assert.equal(resolveProviderSlot('C').protocol,'openai_chat_completions');
 }finally{for(const n of names){if(before[n]==null)delete process.env[n];else process.env[n]=before[n];}}
});
test('cancelling enrichment aborts its work and preserves caller cancellation',async()=>{
 const parent=new AbortController();let upstreamAborted=false;
 const promise=runBoundedDatabaseEnrichment(signal=>new Promise((_,reject)=>{signal.addEventListener('abort',()=>{upstreamAborted=true;reject(signal.reason);},{once:true});}),[],parent.signal);
 await new Promise(r=>setImmediate(r));
 parent.abort(new Error('user paused'));
 await assert.rejects(promise,/user paused/);
 assert.equal(upstreamAborted,true);
});
