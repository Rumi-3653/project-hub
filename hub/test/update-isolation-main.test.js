'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{execFileSync,spawn}=require('node:child_process');
const tmp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-isolation-main-')),root=path.join(tmp,'root');
Object.assign(process.env,{HUB_ROOT:root,HUB_FREETALK_HOME:path.join(tmp,'home'),HUB_DRY_RUN:'1',HUB_TRASH:path.join(tmp,'Trash'),HUB_PORT:String(59000+Math.floor(Math.random()*1000))});
const {Store}=require('../lib/store'),git=require('../lib/git'),chat=require('../lib/chat'),safety=require('../lib/integration-safety');
const store=new Store(root),runtime=require('../server');let base,serial=0;
const g=(d,...a)=>execFileSync('git',['-C',d,...a],{encoding:'utf8',stdio:'pipe'}).trim();
const post=async(route,b)=>{const r=await fetch(base+route,{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json',Connection:'close'},body:JSON.stringify(b)});return {status:r.status,...await r.json()};};
test.before(async()=>{await new Promise(r=>runtime.server.listen(Number(process.env.HUB_PORT),'127.0.0.1',r));base='http://127.0.0.1:'+runtime.server.address().port;});
test.after(async()=>{runtime.chats.running.clear();runtime.server.closeAllConnections();await new Promise(r=>runtime.server.close(r));fs.rmSync(tmp,{recursive:true,force:true});});
function fixture(colocated){
 const p=store.createProject({name:'Isolation-'+(++serial)}).project,body=colocated?p.dir:path.join(tmp,'body'+serial);fs.mkdirSync(body,{recursive:true});
 if(!colocated){const f=path.join(p.dir,'PROJECT.md');fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace('folders:\n','folders:\n  本体: '+JSON.stringify(body)+'\n'));}
 const par=store.createTask(p.id,{title:'parent'}),c=store.createTask(p.id,{title:'child',parent:par.id});chat.append(p.dir,c.id,{text:'child baseline'});
 fs.writeFileSync(path.join(body,'base.txt'),'base');g(body,'init','-q');g(body,'config','user.name','Fixture');g(body,'config','user.email','fixture@localhost');g(body,'add','.');g(body,'commit','-qm','base');
 const workRoot=path.join(root,'Work',p.id),pw=git.prepare({base:body,workRoot,taskId:par.id}),cw=git.prepare({base:body,workRoot,taskId:c.id});
 store.updateTask(p.id,par.id,{workdir:pw.dir});store.updateTask(p.id,c.id,{workdir:cw.dir});fs.writeFileSync(path.join(pw.dir,'parent.txt'),'parent');git.save(pw.dir,'parent');
 return {p,par,c,body,pw,cw,workRoot,b:{project:p.id,task:par.id}};
}
for(const colocated of [true,false])test('formal main merge completes with a linked child editing/committing: '+colocated,async()=>{
 const f=fixture(colocated),key=runtime.chats.key(f.p.id,f.c.id);runtime.chats.running.set(key,{ai:'fixture',model:'fixture'});
 const worker=spawn(process.execPath,['-e',`const fs=require('fs'),cp=require('child_process');for(let n=0;n<4;n++){fs.writeFileSync('child.txt',String(n));cp.execFileSync('git',['add','child.txt']);cp.execFileSync('git',['commit','-qm','child '+n]);}fs.writeFileSync('unsaved.txt','keep');`],{cwd:f.cw.dir,stdio:'pipe'});
 const done=new Promise((r,j)=>{worker.once('exit',code=>code===0?r():j(Error('fixture failed')));});
 const d=await post('/api/task/merge/preview',f.b);assert.equal(d.status,200,JSON.stringify(d));assert.deepEqual(d.waiting,[]);
 const a=await post('/api/task/merge',{...f.b,token:d.token});assert.equal(a.status,200,JSON.stringify(a));assert.equal(a.retained,true);await done;
 assert.equal(fs.readFileSync(path.join(f.body,'parent.txt'),'utf8'),'parent');assert.equal(fs.existsSync(path.join(f.body,'child.txt')),false);
 assert.equal(g(f.cw.dir,'log','--format=%s','-4').split('\n').length,4);assert.equal(g(f.cw.dir,'status','--porcelain'),'?? unsaved.txt');assert.equal(g(f.cw.dir,'diff','--cached'),'');
 assert.equal(chat.read(f.p.dir,f.c.id).length,1);assert.equal((await post('/api/task/merge',{...f.b,token:d.token})).status,409);
 assert.equal(g(f.body,'log','--merges','--format=%H').split('\n').length,1);runtime.chats.running.delete(key);
});
test('source, direct body, aliases and changed child records conflict, unrelated common Git does not',()=>{
 const f=fixture(true),all=store.listProjects(),opts={op:'main-merge',b:f.b,all,baseOf:p=>p.id===f.p.id?f.body:p.dir,target:f.body,paths:[],activities:[{kind:'chat',project:f.p.id,task:f.c.id,message:'child'}]};
 assert.deepEqual(safety.blockers(opts),[]);
 assert.ok(safety.blockers({...opts,paths:[path.relative(f.body,path.join(f.p.dir,'.ai/chat',f.c.id+'.jsonl'))]}).length);
 assert.ok(safety.blockers({...opts,activities:[{...opts.activities[0],task:f.par.id}]}).length);
 store.updateTask(f.p.id,f.c.id,{workdir:f.body});assert.ok(safety.blockers({...opts,all:store.listProjects()})[0].conflictsWith);
 const alias=path.join(tmp,'alias');fs.symlinkSync(f.body,alias);store.updateTask(f.p.id,f.c.id,{workdir:alias});assert.ok(safety.blockers({...opts,all:store.listProjects()}).length);
 const other=store.createProject({name:'Alias-project'}).project,c=store.createTask(other.id,{title:'same',workdir:alias});store.updateTask(other.id,c.id,{workdir:alias});assert.ok(safety.blockers({...opts,all:store.listProjects(),activities:[{kind:'chat',project:other.id,task:c.id,message:'other'}]}).length);
});
test('formal HTTP refuses source and shared-body writers with a specific conflict and no merge',async()=>{
 const f=fixture(false),alias=path.join(tmp,'formal-alias');fs.symlinkSync(f.body,alias);
 const q=store.createProject({name:'Shared-writer'}).project,x=store.createTask(q.id,{title:'other',workdir:alias});store.updateTask(q.id,x.id,{workdir:alias});
 for(const active of [{project:f.p.id,task:f.par.id},{project:f.p.id,task:f.c.id},{project:q.id,task:x.id}]){
  store.updateTask(f.p.id,f.c.id,{workdir:f.body});const key=runtime.chats.key(active.project,active.task);runtime.chats.running.set(key,{ai:'fixture',model:'fixture'});
  try{const before=git.inspect(f.body),preview=await post('/api/task/merge/preview',f.b);assert.equal(preview.status,200);assert.ok(preview.waiting.length);assert.ok(preview.waiting[0].conflictsWith);const r=await post('/api/task/merge',{...f.b,token:preview.token});assert.equal(r.status,409,JSON.stringify(r));assert.equal(r.delivery.state,'not-sent');assert.match(r.error,/本体取り込みと競合/);assert.deepEqual(git.inspect(f.body),before);}finally{runtime.chats.running.delete(key);}
 }
});
for(const name of ['index.lock','packed-refs.lock'])test('Git lock is not-sent, unchanged, corrected retry succeeds: '+name,async()=>{
 const f=fixture(false),before=git.inspect(f.body),d=await post('/api/task/merge/preview',f.b),lock=path.join(g(f.body,'rev-parse','--absolute-git-dir'),name);fs.writeFileSync(lock,'fixture');
 const r=await post('/api/task/merge',{...f.b,token:d.token});assert.equal(r.status,409,JSON.stringify(r));assert.equal(r.delivery.state,'not-sent');assert.deepEqual(git.inspect(f.body),before);fs.unlinkSync(lock);
 const next=await post('/api/task/merge/preview',f.b);assert.equal((await post('/api/task/merge',{...f.b,token:next.token})).status,200);
});
test('common Git mutex rejects reentry across worktrees and releases on failure',()=>{
 const f=fixture(false);assert.throws(()=>git.withCommonGit(f.body,()=>git.withCommonGit(f.cw.dir,()=>{})),/共有Git/);assert.equal(git.withCommonGit(f.body,()=>42),42);
});
test('merge postcondition detects changed local settings instead of ignoring all secret paths',()=>{
 const f=fixture(false);fs.writeFileSync(path.join(f.body,'.env.local'),'before');
 const hook=path.join(g(f.body,'rev-parse','--absolute-git-dir'),'hooks/pre-merge-commit');fs.writeFileSync(hook,'#!/bin/sh\nprintf changed > .env.local\n',{mode:0o700});
 const r=git.merge({dir:f.pw.dir,workRoot:f.workRoot,title:'verify local settings',cleanup:false});
 assert.equal(r.ok,false);assert.equal(r.delivery.state,'unknown');assert.match(r.error,/取り込み後/);assert.equal(fs.readFileSync(path.join(f.body,'.env.local'),'utf8'),'changed');assert.ok(fs.existsSync(f.pw.dir));
});

test('Hub common Git mutex covers asynchronous work and rejects unrelated synchronous saving',async()=>{
 const f=fixture(false);let release;const gate=new Promise(r=>release=r),hold=git.withCommonGit(f.body,async()=>{await gate;return 7;});
 try{assert.throws(()=>git.withCommonGit(f.cw.dir,()=>{}),/共有Git/);fs.writeFileSync(path.join(f.cw.dir,'save.txt'),'keep');assert.throws(()=>git.save(f.cw.dir,'wait'),/共有Git/);}finally{release();}assert.equal(await hold,7);assert.equal(git.save(f.cw.dir,'now'),true);
});
test('restart waits for PTY, webchat and pending chat; handoff never exempts them',()=>{
 const old=runtime.sessions.list;runtime.sessions.list=()=>[{project:'fixture',task:'terminal',running:true}];try{assert.ok(runtime.restartBlockers().some(x=>x.kind==='terminal'));}finally{runtime.sessions.list=old;}
 const ctrl=runtime.webchat.control;runtime.webchat.control={};try{assert.ok(runtime.restartBlockers().some(x=>x.kind==='webchat-control'));}finally{runtime.webchat.control=ctrl;}
 const f=fixture(false),key=runtime.chats.key(f.p.id,f.c.id);runtime.chats.running.set(key,{pending:true});try{assert.ok(runtime.restartBlockers().some(x=>x.kind==='chat'));}finally{runtime.chats.running.delete(key);}
});
