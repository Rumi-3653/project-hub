'use strict';
// Preserve old records and supervise already-sent deliveries; never schedule or
// reinterpret them as ordinary/free conversation when the implementation is absent.
const U=require('./idea-utils'),{IdeaLocation}=require('./idea-location'),{IdeaRunEvidence}=require('./idea-run-evidence');
const unavailable=()=>{throw U.fail('feature_not_included','この版には含まれていません',404);};
function create({ideas,store,baseOf,executionGate:gate,chats,ROOT,record}) {
  const lane=new IdeaLocation({ideas,store,baseOf,gate});
  const dispatch=new IdeaRunEvidence({ideas,lane,gate,chats,spoolRoot:require('node:path').join(ROOT,'_hub','cli-runs')});
  dispatch.verify=function(o,{adoption=false}={}){if(!adoption)unavailable();return IdeaRunEvidence.prototype.verify.call(this,o,{adoption:true});};
  dispatch.refresh=dispatch.policy=unavailable;
  ideas.eraseBusy=()=>gate.barrier;
  ideas.eraseRunState=(project,r)=>dispatch.evidence(project,r);
  const runner={wake(){},start(){},close(){},settled:async()=>{},mayStart:unavailable,
    restore(){
      gate.beginRestore();
      for(const p of store.listProjects()){
        if(p.id==='freetalk'||p.kind==='freetalk')continue;
        try {
          const saved=ideas.resolve(p.id);if(!saved)continue;
          const d=ideas.read(p.id,{recover:true});
          if(d.settings.auto.enabled||!d.settings.manualPaused)ideas.internal(p.id,U.uuid(),{kind:'automation-unavailable'},x=>{
            x.settings.auto.enabled=false;x.settings.manualPaused=true;x.settings.auto.generation++;x.settings.stopGeneration++;x.settings.rev++;
            x.observed={state:'blocked',reason:'この版にはアイデアの自動実行は含まれていません。実行記録は保持しています'};
          });
          if(d.settings.lane){gate.register(p.id,d.settings.lane.workdirReal);lane.resolve(p.id);require('./idea-verification-recovery').restore.call({ideas,lane,gate},p.id);}
        }catch(e){if(p.tasks)for(const t of p.tasks)if(t.workdir)gate.block('idea-recovery:'+p.id,t.workdir,e.message);record('idea-error',{project:p.id},{error:e.message});}
      }
      for(const p of store.listProjects())for(const t of p.tasks){
        const queue=chats.queue(p.id,t.id),removed=queue.filter(q=>q.automation?.kind==='idea');
        if(removed.length){chats.setQueue(p.id,t.id,queue.filter(q=>q.automation?.kind!=='idea'),true);record('idea-unavailable',{project:p.id,task:t.id},{removed:removed.map(q=>q.id)});}
      }
    },
    restored(){gate.finishRestore();}
  };
  return {lane:null,dispatch,runner,release:null,verification:null,review:null};
}
module.exports={create};
