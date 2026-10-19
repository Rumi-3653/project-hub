'use strict';
const platform=require('./platform'),U=require('./idea-utils');
const birth=pid=>platform.processBirth(pid);
const alive=(pid,stamp)=>{try{process.kill(pid,0);return !stamp||birth(pid)===stamp;}catch(e){return e.code!=='ESRCH';}};
function restore(project) {
    const d=this.ideas.read(project);for(const e of Object.values(d.evidence).filter(e=>e.type==='verification'&&!e.finished)){
      const lane=this.lane.resolve(project);if(e.owner&&alive(e.owner.pid,e.owner.birth)||!e.child||alive(e.child.pid,e.child.birth)){this.gate.block('verification:'+e.id,lane.workdirReal,'検証プロセスの終了を照合する必要があります');continue;}
      this.ideas.internal(project,U.uuid(),{kind:'verify-recovered',id:e.id},x=>{x.evidence[e.id]={...e,finished:true,success:false,interrupted:true,reason:'Hub停止後の子プロセス終了を確認。成功は推定しません'};});
      this.gate.unblock('verification:'+e.id);
    }
}
module.exports={restore};
