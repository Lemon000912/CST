import test from 'node:test';import assert from 'node:assert/strict';
import {SessionSync} from '../src/sessionSyncRuntime.js';
import {mergeChatSessionLists} from '../../shared/chatSessionMerge.js';
const session=(id,time=1,answer='draft',final=false)=>({id,title:id,updatedAt:time,messages:[{id:id+':a',role:'assistant',content:'',meta:{synthesis:answer,synthesisNote:final?'synth:completed':'synth:streaming',...(final?{finalizedAt:time}: {})}}]});
function fixture(save){let current=[];const errors=[];let calls=0;const worker=new SessionSync({prepare:s=>s,merge:mergeChatSessionLists,getCurrent:()=>current,save:async(...args)=>{calls++;return save(...args);},load:async()=>null,onMerge:s=>{current=s;},onDeleteAck:()=>{},onError:e=>errors.push(e)});worker.accept({revision:0,sessions:[]});return {worker,errors,get calls(){return calls;},set(s){current=s;worker.setCurrent(s);},get current(){return current;}};}
test('成功保存不产生再次保存；只上传发生变化的会话',async()=>{
 const f=fixture(async(s,r)=>({ok:true,revision:r+1,sessions:s}));const a=session('a'),b=session('b');f.set([a,b]);await f.worker.flush();await f.worker.flush();assert.equal(f.calls,1);
 let payload;f.worker.save=async(s,r)=>{payload=s;return{ok:true,revision:r+1,sessions:s};};f.set([session('a',2,'next'),b]);await f.worker.flush();assert.deepEqual(payload.map(s=>s.id),['a']);assert.equal(f.errors.length,0);
});
test('请求期间到达的终稿排队补存，只有一个保存请求在飞行',async()=>{
 let release;const gate=new Promise(r=>release=r);const payloads=[];const f=fixture(async(s,r)=>{payloads.push(s);if(payloads.length===1)await gate;return{ok:true,revision:r+1,sessions:s};});
 f.set([session('a')]);const running=f.worker.flush();f.set([session('a',3,'finished',true)]);assert.equal(f.worker.flush(),running);release();await running;assert.equal(payloads.length,2);assert.equal(payloads[1][0].messages[0].meta.synthesis,'finished');assert.equal(f.errors.length,0);
});
test('409合并不同页面的消息，终稿优先于更晚的旧草稿',async()=>{
 let n=0;const final=session('a',2,'final',true);const f=fixture(async(s,r)=>++n===1?{conflict:true,revision:3,sessions:[final,session('other',1)]}:{ok:true,revision:r+1,sessions:s});
 f.set([session('a',10,'old draft')]);await f.worker.flush();assert.equal(f.current.find(s=>s.id==='a').messages[0].meta.synthesis,'final');assert.ok(f.current.some(s=>s.id==='other'));assert.equal(f.errors.length,0);
});
test('网络失败保留待保存内容，恢复后重试；删除标记阻止旧页面复活会话',async()=>{
 let fail=true;const f=fixture(async(s,r)=>{if(fail)throw Error('offline');return{ok:true,revision:r+1,sessions:s};});f.set([session('a')]);await f.worker.flush();assert.equal(f.errors.length,1);fail=false;await f.worker.flush();assert.equal(f.calls,2);
 f.worker.accept({revision:3,sessions:[],deletedSessionIds:['a']});assert.deepEqual(f.current,[]);await f.worker.flush();assert.equal(f.calls,2);
});
test('同一会话的不同页面新增消息都保留',()=>{
 const a={id:'s',updatedAt:2,messages:[{id:'u',role:'user',content:'q'},{id:'a',role:'assistant',content:'first'}]};
 const b={id:'s',updatedAt:3,messages:[{id:'u',role:'user',content:'q'},{id:'b',role:'assistant',content:'second'}]};
 assert.deepEqual(mergeChatSessionLists([a],[b])[0].messages.map(m=>m.id),['u','a','b']);
});
