import test from 'node:test';import assert from 'node:assert/strict';
import { extractFastSearchTerms, buildCandidateQuery, rankFastCandidates, searchPapersFast, searchDoiFast } from '../databaseSearchFast.js';
function fakePool(select) {
 const calls=[];let released=0;
 const client={query:async(sql,values)=>{calls.push({sql,values});if(/^SELECT \*/.test(sql))return {rows:await select(sql,values)};return {rows:[]};},release:()=>released++};
 return {pool:{connect:async()=>client},calls,get released(){return released;}};
}
test('material symbols survive stopword filtering and short symbols use word boundaries',()=>{
 const terms=extractFastSearchTerms('research on Al Fe In TiO2 synthesis coating');
 assert.deepEqual(terms,['Al','Fe','In','TiO2','coating']);
 const plan=buildCandidateQuery(terms);
 assert.ok(plan.values.includes('\\mAl\\M'));
 assert.ok(!plan.values.includes('%Al%'));
});
test('candidate query binds input and bounds broad predicates before ranking',()=>{
 const plan=buildCandidateQuery(['aluminum','coating','battery','ceramic'],{strict:false,limit:900});
 assert.equal((plan.text.match(/ILIKE/g)||[]).length,8);
 assert.ok(!plan.text.includes('aluminum'));
 assert.equal(plan.values.at(-1),600);
 assert.ok(!/ORDER BY/i.test(plan.text));
});
test('ranking prefers material matches and does not match Al inside unrelated words',()=>{
 const out=rankFastCandidates([{paper_id:'unrelated',material_name:'saline',year:2026},{paper_id:'metal',material_name:'Al alloy',year:2020}],['Al'],2);
 assert.equal(out[0].paper_id,'metal');
});
test('ordinary keywords do not scan the DOI table',async()=>{
 let connected=false;
 assert.deepEqual(await searchDoiFast({connect(){connected=true;}},'aluminum coating',100),[]);
 assert.equal(connected,false);
});
test('exact DOI lookups are parameterized and case variants are retained',async()=>{
 const f=fakePool(async()=>[{id:1,doi:'10.1234/ABC'}]);
 const result=await searchDoiFast(f.pool,'https://doi.org/10.1234/ABC',5);
 assert.equal(result.length,1);assert.equal(f.released,1);
 const select=f.calls.find(c=>/^SELECT \*/.test(c.sql));
 assert.ok(select.sql.includes('doi = ANY'));
 assert.deepEqual(select.values[0],['10.1234/ABC','10.1234/abc']);
 assert.equal(f.calls.at(-1).sql,'ROLLBACK');
});
test('timed out strict query is rolled back before broad fallback',async()=>{
 let attempt=0;
 const f=fakePool(async()=>{if(++attempt===1){const e=new Error('timeout');e.code='57014';throw e;}return[{paper_id:'match',material_name:'aluminum coating',year:2025}];});
 const result=await searchPapersFast(f.pool,'aluminum coating',10);
 assert.equal(result.length,1);assert.equal(attempt,2);assert.equal(f.released,1);
 assert.equal(f.calls.filter(c=>c.sql==='BEGIN READ ONLY').length,2);
 assert.equal(f.calls.filter(c=>c.sql==='ROLLBACK').length,2);
});
test('a sufficient strict result avoids an expensive broader query',async()=>{
 const f=fakePool(async()=>Array.from({length:12},(_,i)=>({paper_id:String(i),material_name:'aluminum coating'})));
 const result=await searchPapersFast(f.pool,'aluminum coating',100);
 assert.equal(result.length,12);
 assert.equal(f.calls.filter(c=>/^SELECT \*/.test(c.sql)).length,1);
 assert.ok(f.calls.some(c=>c.sql.includes("set_config('statement_timeout'")));
});
test('late connection after the deadline is released without running SQL',async()=>{
 const before=process.env.DB_SEARCH_BUDGET_MS;process.env.DB_SEARCH_BUDGET_MS='1000';
 let release;const released=new Promise(r=>release=r);let queried=false;
 try{
 const result=await searchPapersFast({connect:()=>new Promise(r=>setTimeout(()=>r({query(){queried=true;},release}),1100))},'aluminum',10);
 assert.deepEqual(result,[]);await released;assert.equal(queried,false);
 }finally{if(before==null)delete process.env.DB_SEARCH_BUDGET_MS;else process.env.DB_SEARCH_BUDGET_MS=before;}
});
