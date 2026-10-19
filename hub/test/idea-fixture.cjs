'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),U=require('../lib/idea-utils');
function fixture(t,{profiles,clock,bind=true}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'idea-flow-'))),dir=path.join(root,'Product/P'),main=path.join(root,'System/P'),work=path.join(root,'Work/P/lane');for(const x of [dir,main,path.dirname(work)])fs.mkdirSync(x,{recursive:true});
  U.git(main,['init','-q']);U.git(main,['config','user.name','Fixture']);U.git(main,['config','user.email','fixture@localhost']);fs.writeFileSync(path.join(main,'base.txt'),'base\n');U.git(main,['add','.']);U.git(main,['commit','-qm','base']);U.git(main,['worktree','add','-qb','idea-lane',work]);
  const project={id:'P',dir,tasks:[{id:'lane',title:'本作業',kind:'main',workspaceMode:'isolated',workdir:work,state:'進行中',question:'',session:'parent-session'}]},store={root,readProject:id=>id==='P'?project:null,listProjects:()=>[project]};
  const {Ideas}=require('../lib/ideas'),{ExecutionGate}=require('../lib/execution-gate');
  const ideas=new Ideas({store,clock}),gate=new ExecutionGate();gate.finishRestore();
  const add=(text='原文',intent='build',source)=>ideas.add('P',{opId:U.uuid(),text,intent},{human:true,source});
  if(bind)ideas.initialize('P',U.uuid());
  const commit=(file='feature.txt',text='feature')=>{fs.writeFileSync(path.join(work,file),text);U.git(work,['add','--',file]);U.git(work,['commit','-qm','fixture '+file]);return U.snapshot(work).head;};
  t.after(()=>ideas.close());return {root,dir,main,work,project,store,ideas,gate,add,commit};
}
module.exports={fixture,U};
