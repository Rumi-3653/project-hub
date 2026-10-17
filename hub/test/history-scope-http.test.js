'use strict';
// Isolated ledger and injected runtime activity. No real CLI or AI is started.
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process'),{randomUUID}=require('node:crypto');
const tmp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-history-scope-')),root=path.join(tmp,'root');
fs.mkdirSync(path.join(root,'_hub'),{recursive:true});fs.copyFileSync(path.join(__dirname,'../../docs/project-hub/templates/_hub/roles.yaml'),path.join(root,'_hub/roles.yaml'));
Object.assign(process.env,{HUB_ROOT:root,HUB_AI_HOME:path.join(tmp,'home'),HUB_FREETALK_HOME:path.join(tmp,'freetalk'),HUB_DRY_RUN:'1',HUB_PORT:'0',HUB_AUTO_UPDATE:'0',HUB_AUTO_TRANSLATE:'0'});
const {Store}=require('../lib/store'),{TaskHistory}=require('../lib/task-history'),chat=require('../lib/chat'),scope=require('../lib/resource-scope');
const store=new Store(root),p=store.createProject({name:'Target'}).project,q=store.createProject({name:'Other'}).project;
const qt=store.createTask(q.id,{title:'Other task'});
const init=dir=>execFileSync('git',['-C',dir,'init','-q'],{stdio:'pipe'});for(const x of [p,q])init(x.dir);
const history=new TaskHistory({store});let rt,base,background=[],writingHold=false;
// Use fixture registrations instead of ps/lsof or a real external process.
const procwatch=require('../lib/procwatch'),create=procwatch.create;procwatch.create=()=>({list:()=>background,start(){},onChange(){}});
const autoFinish=TaskHistory.prototype.autoFinish;TaskHistory.prototype.autoFinish=function(...args){if(writingHold)return;return autoFinish.apply(this,args);};
const originalSend=chat.ChatRunner.prototype.send;let selectionStarts=0;chat.ChatRunner.prototype.send=function(){selectionStarts++;throw Error('History scope fixture never starts an AI CLI');};
const req=async(method,route,body)=>{const r=await fetch(base+route,{method,headers:{'X-Hub':'1','Content-Type':'application/json',Connection:'close'},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()};};
const post=(route,body)=>req('POST',route,body),view=b=>req('GET','/api/task/history/auto?'+new URLSearchParams(b));
async function until(check){for(let n=0;n<350;n++){const v=await check();if(v)return v;await new Promise(r=>setTimeout(r,20));}assert.fail('scope fixture timed out');}
function target(project=p){const t=store.createTask(project.id,{title:'Target task',steps:['done']});store.setStep(project.id,t.id,0,true);store.decideTask(project.id,t.id,'approve',store.readTask(store.taskFile(project.id,t.id)).completionHash);chat.append(project.dir,t.id,{role:'user',text:'ORIGINAL-'+t.id});return {project:project.id,task:t.id};}
async function done(b){let last;try{return await until(async()=>{const v=(await view(b)).body;if(v.auto?.stage==='failed')assert.fail(JSON.stringify(v.auto));last=v;return v.auto?.stage==='done'&&v;});}catch(e){e.message+=' '+JSON.stringify(last);throw e;}}
test.before(async()=>{
 const probe=require('node:net').createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));process.env.HUB_PORT=String(probe.address().port);await new Promise(r=>probe.close(r));
 rt=require('../server');await new Promise(r=>rt.server.listen(Number(process.env.HUB_PORT),'127.0.0.1',r));base='http://127.0.0.1:'+rt.server.address().port;
 const ft=await post('/api/freetalk/ensure');assert.equal(ft.status,200);init(path.join(root,'Product/freetalk'));init(path.join(tmp,'freetalk/Documents/freetalk'));
});
test.after(async()=>{rt.chats.running.clear();background=[];rt.server.closeAllConnections();await new Promise(r=>rt.server.close(r));procwatch.create=create;TaskHistory.prototype.autoFinish=autoFinish;chat.ChatRunner.prototype.send=originalSend;fs.rmSync(tmp,{recursive:true,force:true});assert.equal(selectionStarts,0,'完了済み・判断待ちの作業でAIを起動しない');});
test('unrelated chat/terminal/queue/freetalk/background remain active through save and rotation',async()=>{
 const b=target(),own=b.project+'\0'+b.task,other=q.id+'\0'+qt.id,sessionList=rt.sessions.list;
 const queue=[{id:'held-human',ai:'codex',text:'held',limitWaiting:true,paused:true}];rt.chats.setQueue(q.id,qt.id,queue,true);
 const queueFile=path.join(q.dir,'.ai/chat',qt.id+'.queue.json'),before=fs.readFileSync(queueFile);
 rt.chats.running.set(own,{ai:'claude'});const started=await post('/api/task/history/auto',{...b,requestId:randomUUID(),generation:1});assert.equal(started.status,200);await until(async()=>Boolean((await view(b)).body.auto?.reason));
 rt.chats.running.delete(own);rt.chats.running.set(other,{ai:'codex'});rt.chats.running.set('freetalk\0topic',{ai:'claude'});
 rt.sessions.list=()=>[{project:q.id,task:qt.id,running:true,ai:'claude'}];background=[{project:q.id,task:qt.id,ai:'codex',pid:999999}];
 try{const v=await done(b);assert.equal(v.generation,2);assert.equal(rt.chats.running.has(other),true);assert.equal(rt.chats.running.has('freetalk\0topic'),true);assert.deepEqual(fs.readFileSync(queueFile),before);assert.deepEqual(rt.chats.queue(q.id,qt.id),queue);assert.equal(history.archives(b.project,b.task).length,1);assert.ok(history.archive(b.project,b.task,history.archives(b.project,b.task)[0].id).rows.some(r=>r.text==='ORIGINAL-'+b.task));}
 finally{rt.chats.running.clear();rt.sessions.list=sessionList;background=[];rt.chats.setQueue(q.id,qt.id,[],true);}
});
test('same-project sibling permits conversation rotation but rejects body apply without changing originals',async()=>{
 const b=target(),sibling=store.createTask(p.id,{title:'Sibling'}),body=store.createTask(p.id,{title:'Body'}),file=store.taskFile(p.id,body.id);
 fs.appendFileSync(file,'\n## Old details\nBODY-ORIGINAL\n');const before=fs.readFileSync(file),pv=await req('GET','/api/task/body/preview?'+new URLSearchParams({project:p.id,task:body.id}));assert.ok(pv.body.token);
 const own=b.project+'\0'+b.task,key=p.id+'\0'+sibling.id;rt.chats.running.set(own,{ai:'claude'});await post('/api/task/history/auto',{...b,requestId:randomUUID()});await until(async()=>Boolean((await view(b)).body.auto?.reason));rt.chats.running.delete(own);rt.chats.running.set(key,{ai:'codex'});
 try{assert.ok(rt.textBudget.busy(p.id,body.id));const refused=await post('/api/task/body/apply',{project:p.id,task:body.id,token:pv.body.token,confirm:true});assert.equal(refused.status,409);assert.deepEqual(fs.readFileSync(file),before);assert.equal((await done(b)).generation,2);assert.equal(rt.chats.running.has(key),true);}
 finally{rt.chats.running.clear();}
});
test('unrelated body apply succeeds and preserves other ledger and queue',async()=>{
 const t=store.createTask(p.id,{title:'Body'}),b={project:p.id,task:t.id},file=store.taskFile(p.id,t.id);fs.appendFileSync(file,'\n## Old details\nBODY-ARCHIVE\n');const otherFile=store.taskFile(q.id,qt.id),before=fs.readFileSync(otherFile),key=q.id+'\0'+qt.id;
 rt.chats.running.set(key,{ai:'codex'});
 try{const pv=await req('GET','/api/task/body/preview?'+new URLSearchParams(b));assert.equal(pv.body.reason,'');assert.ok(pv.body.moves.length);const r=await post('/api/task/body/apply',{...b,token:pv.body.token,confirm:true});assert.equal(r.status,200,JSON.stringify(r.body));assert.doesNotMatch(fs.readFileSync(file,'utf8'),/BODY-ARCHIVE/);assert.match(rt.textBudget.search(p.id,t.id,'BODY-ARCHIVE'),/sections-/);assert.deepEqual(fs.readFileSync(otherFile),before);assert.equal(rt.chats.running.has(key),true);}
 finally{rt.chats.running.clear();}
});
test('shared Git worktrees protect body; Hub project uses local history scope while integration remains global',async()=>{
 const t=store.createTask(p.id,{title:'Body'}),key=q.id+'\0'+qt.id,baseDir=path.join(tmp,'body'),worktree=path.join(tmp,'worktree');fs.mkdirSync(baseDir);init(baseDir);
 const g=(...args)=>execFileSync('git',['-C',baseDir,...args],{stdio:'pipe'});g('config','user.name','Fixture');g('config','user.email','fixture@localhost');fs.writeFileSync(path.join(baseDir,'base'),'base');g('add','.');g('commit','-qm','base');g('worktree','add','--detach',worktree,'HEAD');
 store.updateTask(p.id,t.id,{workdir:baseDir});store.updateTask(q.id,qt.id,{workdir:worktree});rt.chats.running.set(key,{ai:'codex'});
 try{assert.ok(rt.textBudget.busy(p.id,t.id));}finally{rt.chats.running.clear();store.updateTask(p.id,t.id,{workdir:''});store.updateTask(q.id,qt.id,{workdir:''});}
 const hubProject=store.createProject({name:'Project Hub',body:path.resolve(__dirname,'..')}).project;init(hubProject.dir);
 const all=store.listProjects(),baseOf=x=>x.id===hubProject.id?path.resolve(__dirname,'..'):x.dir;
 assert.equal(scope.relatedProjects(hubProject.id,all,baseOf,x=>x,path.resolve(__dirname,'..')),null);assert.deepEqual([...scope.relatedProjects(hubProject.id,all,baseOf,x=>x,path.resolve(__dirname,'..'),{hubGlobal:false})],[hubProject.id]);
 const b=target(hubProject),own=b.project+'\0'+b.task;rt.chats.running.set(own,{ai:'claude'});await post('/api/task/history/auto',{...b,requestId:randomUUID()});await until(async()=>Boolean((await view(b)).body.auto?.reason));rt.chats.running.delete(own);rt.chats.running.set(key,{ai:'codex'});
 try{assert.equal((await done(b)).generation,2);assert.equal(rt.textBudget.busy(hubProject.id,b.task),'');}finally{rt.chats.running.clear();}
});
test('selected result saves while unrelated AI is active; duplicate same ID rotates once; cancellation persists',async()=>{
 const b=target(),own=b.project+'\0'+b.task,other=q.id+'\0'+qt.id;rt.chats.running.set(own,{ai:'claude'});const id=randomUUID();await post('/api/task/history/auto',{...b,requestId:id});await until(async()=>Boolean((await view(b)).body.auto?.reason));
 rt.chats.running.delete(own);writingHold=true;
 try{await until(async()=>{const v=(await view(b)).body;return v.auto.stage==='selecting';});rt.chats.running.set(other,{ai:'codex'});writingHold=false;const v=await done(b);assert.equal(v.generation,2);assert.equal((await post('/api/task/history/auto',{...b,requestId:id,generation:1})).body.auto.requestId,id);assert.equal(history.archives(b.project,b.task).length,1);}
 finally{writingHold=false;rt.chats.running.clear();}
 const c=target(),key=c.project+'\0'+c.task;rt.chats.running.set(key,{ai:'claude'});await post('/api/task/history/auto',{...c,requestId:randomUUID()});assert.equal((await post('/api/task/history/auto/cancel',c)).status,200);rt.chats.running.delete(key);rt.chats.running.set(other,{ai:'codex'});await new Promise(r=>setTimeout(r,1700));assert.equal((await view(c)).body.auto.stage,'cancelled');assert.equal(history.archives(c.project,c.task).length,0);rt.chats.running.clear();
});
function manualTarget(parent){
 const t=store.createTask(p.id,{title:'One-click target',parent,steps:['done']});store.setStep(p.id,t.id,0,true);chat.append(p.dir,t.id,{role:'user',text:'MANUAL-ORIGINAL-'+t.id});return {project:p.id,task:t.id};
}
async function manualStart(b){const s=(await req('GET','/api/task/history/status?'+new URLSearchParams(b))).body;return post('/api/task/continue',{...b,requestId:randomUUID(),generation:s.generation,revision:s.revision,automatic:true,confirm:true});}
test('1クリック：対象の会話・順番待ち・ターミナル・外部・WebChatだけが未実行で拒否される',async()=>{
 const list=rt.sessions.list,webBusy=rt.webchat.busy,message='この作業のAIが作業中です。作業が終わってから、もう一度［要約して続ける］を押してください';
 for(const kind of ['chat','queue','terminal','external','webchat','unknown-own']){
  const b=manualTarget(),key=b.project+'\0'+b.task,wd=path.join(tmp,'unique-'+b.task);fs.mkdirSync(wd);store.updateTask(b.project,b.task,{workdir:wd});
  if(kind==='chat')rt.chats.running.set(key,{ai:'codex'});
  if(kind==='queue')rt.chats.setQueue(b.project,b.task,[{id:'held',text:'original queue',paused:true}],true);
  if(kind==='terminal')rt.sessions.list=()=>[{...b,running:true}];
  if(kind==='external')background=[{...b,ai:'codex',pid:999999}];
  if(kind==='unknown-own')background=[{project:b.project,task:null,cwd:wd,ai:'codex',pid:999999}];
  if(kind==='webchat')rt.webchat.busy=()=>[{...b}];
  try{const before=chat.read(p.dir,b.task),r=await manualStart(b);assert.equal(r.status,409,kind);assert.equal(r.body.code,'target-ai');assert.equal(r.body.stage,'not-started');assert.equal(r.body.error,message);assert.equal(history.autoJob(b.project,b.task),null);assert.deepEqual(chat.read(p.dir,b.task),before);}
  finally{rt.chats.running.clear();rt.chats.setQueue(b.project,b.task,[],true);rt.sessions.list=list;rt.webchat.busy=webBusy;background=[];}
 }
});
test('1クリック：親・子・別作業・別project・共有workdirと他作業の本文復旧待ちは妨げない',async()=>{
 const parent=store.createTask(p.id,{title:'Parent'}),b=manualTarget(parent.id),child=store.createTask(p.id,{title:'Child',parent:b.task}),sibling=store.createTask(p.id,{title:'Sibling'}),wd=path.join(tmp,'shared-manual');fs.mkdirSync(wd);
 store.updateTask(p.id,b.task,{workdir:wd});store.updateTask(p.id,sibling.id,{workdir:wd});
 const queue=[{id:'unrelated',text:'KEEP-QUEUE',paused:true}];rt.chats.setQueue(q.id,qt.id,queue,true);const file=path.join(q.dir,'.ai/chat',qt.id+'.queue.json'),before=fs.readFileSync(file);
 const list=rt.sessions.list,webBusy=rt.webchat.busy,pending=rt.textBudget.pending;
 for(const [project,task] of [[p.id,parent.id],[p.id,child.id],[p.id,sibling.id],[q.id,qt.id]])rt.chats.running.set(project+'\0'+task,{ai:'codex'});
 rt.sessions.list=()=>[{project:p.id,task:sibling.id,running:true}];background=[{project:p.id,task:null,cwd:wd,pid:999999},{project:q.id,task:qt.id,pid:999998}];rt.webchat.busy=()=>[{project:p.id,task:child.id,parent:b.task}];rt.textBudget.pending=project=>project===p.id?[{j:{task:sibling.id}}]:[];
 try{const r=await manualStart(b);assert.equal(r.status,200,JSON.stringify(r.body));assert.equal((await done(b)).generation,2);assert.equal(history.archives(b.project,b.task).length,1);assert.deepEqual(fs.readFileSync(file),before);assert.equal(rt.chats.running.size,4);assert.equal(rt.chats.queue(q.id,qt.id)[0].text,'KEEP-QUEUE');assert.match(history.archive(b.project,b.task,history.archives(b.project,b.task)[0].id).rows[0].text,/MANUAL-ORIGINAL/);}
 finally{rt.chats.running.clear();rt.sessions.list=list;rt.webchat.busy=webBusy;rt.textBudget.pending=pending;background=[];rt.chats.setQueue(q.id,qt.id,[],true);}
});
test('1クリック受付後は同じ作業の送信・ターミナル起動を拒否し、別タブは1件へ接続',async()=>{
 const b=manualTarget(),s=(await req('GET','/api/task/history/status?'+new URLSearchParams(b))).body,input={...b,requestId:randomUUID(),generation:s.generation,revision:s.revision,automatic:true,confirm:true};writingHold=true;
 try{
  assert.equal((await post('/api/task/continue',input)).status,200);
  for(const route of ['/api/chat/send','/api/term/start']){const r=await post(route,{...b,ai:'codex',text:'UNSENT'});assert.equal(r.status,409);assert.match(r.body.error,/会話を整理中/);}
  const joined=await post('/api/task/continue',{...input,requestId:randomUUID()});assert.equal(joined.status,200);assert.equal(joined.body.requestId,input.requestId);assert.equal(joined.body.duplicate,true);
 }finally{writingHold=false;}
 await done(b);assert.equal(history.archives(b.project,b.task).length,1);assert.ok(!chat.read(p.dir,b.task).some(r=>r.text==='UNSENT'));
});
