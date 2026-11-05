let database;
function open(){
  if(typeof indexedDB==='undefined')return Promise.resolve(null);
  return database ||= new Promise((resolve,reject)=>{
    const r=indexedDB.open('cst-chat-history',1);
    r.onupgradeneeded=()=>{const s=r.result.createObjectStore('sessions',{keyPath:'key'});s.createIndex('owner','owner');};
    r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
  }).catch(e=>{database=null;throw e;});
}
const prior=new Map();
export async function loadLocalChatCache(owner){
  const db=await open();if(!db)return [];
  return new Promise((resolve,reject)=>{const r=db.transaction('sessions').objectStore('sessions').index('owner').getAll(owner);r.onsuccess=()=>resolve(r.result.map(x=>x.session));r.onerror=()=>reject(r.error);});
}
let tail=Promise.resolve();
export function saveLocalChatCache(owner,sessions){
  const task=tail.catch(()=>{}).then(async()=>{
    const db=await open();if(!db)return;
    const existing=prior.get(owner)||new Map((await loadLocalChatCache(owner)).map(s=>[s.id,null]));
    const next=new Map(sessions.map(s=>[s.id,s]));
    await new Promise((resolve,reject)=>{
      const tx=db.transaction('sessions','readwrite');const store=tx.objectStore('sessions');
      for(const s of sessions)if(existing.get(s.id)!==s)store.put({key:`${owner}:${s.id}`,owner,session:s});
      for(const id of existing.keys())if(!next.has(id))store.delete(`${owner}:${id}`);
      tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
    });
    prior.set(owner,next);
  });tail=task;return task;
}
