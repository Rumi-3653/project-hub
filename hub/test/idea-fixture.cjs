'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),U=require('../lib/idea-utils');
function fixture(t,{profiles,clock,bind=true}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'idea-flow-'))),dir=path.join(root,'Product/P'),main=path.join(root,'System/P'),work=path.join(root,'Work/P/lane');for(const x of [dir,main,path.dirname(work)])fs.mkdirSync(x,{recursive:true});
  U.git(main,['init','-q']);U.git(main,['config','user.name','Fixture']);U.git(main,['config','user.email','fixture@localhost']);fs.writeFileSync(path.join(main,'base.txt'),'base\n');U.git(main,['add','.']);U.git(main,['commit','-qm','base']);U.git(main,['worktree','add','-qb','idea-lane',work]);
  const project={id:'P',dir,tasks:[{id:'lane',title:'本作業',kind:'main',workspaceMode:'isolated',workdir:work,state:'進行中',question:'',session:'parent-session'}]},store={root,readProject:id=>id==='P'?project:null,listProjects:()=>[project]};
  const {Ideas}=require('../lib/ideas'),{ExecutionGate}=require('../lib/execution-gate'),{IdeaLane}=require('../lib/idea-lane'),{IdeaDispatch}=require('../lib/idea-dispatch'),{IdeaVerification}=require('../lib/idea-verification'),{IdeaReview}=require('../lib/idea-review'),{IdeaRelease}=require('../lib/idea-release'),{IdeaRunner}=require('../lib/idea-runner');
  const ideas=new Ideas({store,clock}),gate=new ExecutionGate(),lane=new IdeaLane({ideas,store,baseOf:()=>main,gate}),verification=new IdeaVerification({ideas,lane,gate,profiles:profiles||[{id:'fixture',executable:process.execPath,argv:['-e','console.log("fixture verification")'],cwd:'.',env:{},timeout:2000,scope:['.'],outputDirs:[],lockfiles:[]}]}),review=new IdeaReview({ideas,lane,verification});lane.profiles=verification;
  const starts=[],queues=[],rows=[],busyMap=new Map(),chats={queue:()=>queues,busy:(p,t)=>busyMap.get(t)||null};let runner;
  const dispatch=new IdeaDispatch({ideas,lane,gate,chats,roles:()=>({roles:['調査','デザイン','コーディング','文章','チェック','最終確認'].map(name=>({name,main:{ai:name==='コーディング'?'codex':'claude-code',model:name==='コーディング'?'gpt-6.1-sol':name==='チェック'||name==='最終確認'?'claude-fable-5-1':'claude-opus-5-5'}}))}),mayStart:(p,r)=>runner.mayStart(p,r),delegate:async(b,res,opts)=>{starts.push({b,opts});busyMap.set(b.task,{automation:opts.automation});res.integrationDelivery.begin();res.writeHead(200);res.end(JSON.stringify({ok:true,queued:false}));}});
  // Local test adapter; no real model process is ever launched.
  dispatch.evidence=(p,r)=>{const row=rows.findLast(x=>x.automation.metadata.runId===r.id);if(row)return {state:'finished',row};if(queues.some(x=>x.automation?.runId===r.id))return {state:'accepted'};return {state:'absent'};};
  const release=new IdeaRelease({ideas,lane,gate,verification,review,clock,versionCheck:()=>({ok:true,version:'1.0.1',languages:['ja']})});
  runner=new IdeaRunner({ideas,lane,gate,dispatch,verification,review,release,busy:(p,t)=>busyMap.has(t),humanQueued:()=>queues.some(q=>!q.automation)});release.runner=runner;
  // Explicit ticks in tests expose each durable boundary without timer races.
  runner.wake=()=>{};gate.finishRestore();
  const add=(text='原文',intent='build',source)=>ideas.add('P',{opId:U.uuid(),text,intent},{human:true,source});
  if(bind){ideas.initialize('P',U.uuid());lane.set('P',{opId:U.uuid(),settingsRev:ideas.read('P').settings.rev,task:'lane',testProfile:'fixture'});}
  const auto=enabled=>ideas.auto('P',{opId:U.uuid(),settingsRev:ideas.read('P').settings.rev,enabled});
  const current=()=>Object.values(ideas.read('P').runs).findLast(r=>!r.closed);
  const finish=(run,result,extra={})=>{busyMap.delete(run.task);const d=ideas.read('P'),row={role:'assistant',request:run.requestId,text:JSON.stringify(result),automation:{metadata:dispatch.metadata(d,run),closed:true,limit:false,isolation:{fresh:true,readOnly:run.readOnly,resumed:false}},...extra};rows.push(row);runner.settled({project:'P',automation:dispatch.metadata(d,run)},row);return row;};
  const itemResult=(run,i,status='checkpoint',more={})=>({schema:1,runId:run.id,kind:run.purpose,items:[{itemId:i.id,contentRev:run.targets[0].contentRev,basePlanRev:run.targets[0].planRev,status,commits:[],acceptance:[],checkpoint:{nextPurpose:'build'},questions:[],diagnosis:null,...more}]});
  const commit=(file='feature.txt',text='feature')=>{fs.writeFileSync(path.join(work,file),text);U.git(work,['add','--',file]);U.git(work,['commit','-qm','fixture '+file]);return U.snapshot(work).head;};
  t.after(()=>{runner.close();ideas.close();});
  return {root,dir,main,work,project,store,ideas,gate,lane,verification,review,release,dispatch,runner,starts,queues,rows,busyMap,add,auto,current,finish,itemResult,commit};
}
module.exports={fixture,U};
