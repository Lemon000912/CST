export class SessionSync {
  constructor({ prepare, merge, save, load, onMerge, onDeleteAck, onError, getCurrent }) {
    Object.assign(this, { prepare, merge, save, load, onMerge, onDeleteAck, onError, getCurrent });
    this.current=[];this.deleted=[];this.confirmed=new Map();this.cache=new WeakMap();this.revision=null;this.running=null;this.stopped=false;
  }
  fingerprint(s){let v=this.cache.get(s);if(!v){v=JSON.stringify(this.prepare([s])[0],(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);this.cache.set(s,v);}return v;}
  setCurrent(sessions,deleted=[]){this.current=sessions;this.deleted=deleted;}
  accept(remote){
    if(Number(remote.revision)<Number(this.revision))return;
    this.revision=Number(remote.revision)||0;
    if(remote.notModified)return;
    for(const s of remote.sessions||[])this.confirmed.set(s.id,this.fingerprint(s));
    const deleted=new Set([...(remote.deletedSessionIds||[]),...this.deleted]);
    this.current=this.merge(this.getCurrent?.() || this.current,remote.sessions||[]).filter(s=>!deleted.has(s.id));
    this.onMerge(this.current);
  }
  dirty(){return this.current.filter(s=>this.confirmed.get(s.id)!==this.fingerprint(s));}
  flush(){
    if(this.running)return this.running;
    this.running=this.run().catch(e=>{if(!this.stopped)this.onError(e);}).finally(()=>{this.running=null;});
    return this.running;
  }
  // 回答流式输出期间内容持续变化：保存成功后仍有新内容属正常情况，稍后补存即可，不能当作冲突报错。
  schedule(){if(this.stopped||this.followUp)return;this.followUp=setTimeout(()=>{this.followUp=null;void this.flush();},1500);this.followUp?.unref?.();}
  async run(){
    if(this.revision===null||this.stopped)return;
    let saves=0,conflicts=0;
    while(!this.stopped){
      const sent=this.dirty();const deletions=[...this.deleted];
      if(!sent.length&&!deletions.length)return;
      if(saves>=4){this.schedule();return;}
      const payload=this.prepare(sent);
      const result=await this.save(payload,this.revision,deletions);
      if(this.stopped)return;
      if(result.ok){
        saves++;conflicts=0;
        for(const s of sent)this.confirmed.set(s.id,this.fingerprint(s));
        this.deleted=this.deleted.filter(id=>!deletions.includes(id));this.onDeleteAck(deletions);
        if(result.sessions)this.accept(result);else this.revision=result.revision;
        // 再次检查最新状态：请求飞行期间的新消息不能丢弃。
        continue;
      }
      if(result.conflict){
        // 只有连续的 409 才是真正的同步冲突。
        if(++conflicts>=4)throw Error('对话同步仍有冲突，正在重试');
        this.accept(result);continue;
      }
      throw Error(result.status===401?'登录已过期，对话尚未同步':'对话尚未同步到服务器，正在重试');
    }
  }
  async pull(){if(this.stopped)return;const remote=await this.load(this.revision);if(remote&&!this.stopped)this.accept(remote);}
}
