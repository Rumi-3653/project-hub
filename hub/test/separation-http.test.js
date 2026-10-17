'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const tmp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-separation-')),root=path.join(tmp,'root');
fs.mkdirSync(path.join(root,'_hub'),{recursive:true});
fs.copyFileSync(path.join(__dirname,'../../docs/project-hub/templates/_hub/roles.yaml'),path.join(root,'_hub/roles.yaml'));
Object.assign(process.env,{HUB_ROOT:root,HUB_AI_HOME:path.join(tmp,'home'),HUB_FREETALK_HOME:path.join(tmp,'ft'),HUB_DRY_RUN:'1',HUB_PORT:'0',HUB_AUTO_UPDATE:'0',HUB_AUTO_TRANSLATE:'0',HUB_STORAGE_GUARD:''});
const {Store}=require('../lib/store'),{Removal}=require('../lib/remove'),git=require('../lib/git');
const store=new Store(root),p=store.createProject({name:'LINE制作'}).project,parent=store.createTask(p.id,{title:'親'}),child=store.createTask(p.id,{title:'子',parent:parent.id,steps:['完成']});
store.setStep(p.id,child.id,0,true);store.appendSection(p.id,child.id,'成果','- なし：保存コードのみ');
const other=store.createProject({name:'別プロジェクト'}).project,otherTask=store.createTask(other.id,{title:'本作業'});
const body=path.join(root,'Body'),g=(dir,...args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8',stdio:'pipe'}).trim();
for(const ledger of [p.dir,other.dir])g(ledger,'init','-q');
fs.mkdirSync(body);g(body,'init','-q');g(body,'config','user.name','Fixture');g(body,'config','user.email','fixture@localhost');fs.writeFileSync(path.join(body,'base'),'base');g(body,'add','.');g(body,'commit','-qm','base');
const removal=new Removal({store}),pw=git.prepare({base:body,workRoot:removal.workRoot(p),taskId:parent.id}),cw=git.prepare({base:body,workRoot:removal.workRoot(p),taskId:child.id});
store.updateTask(p.id,parent.id,{workdir:pw.dir});store.updateTask(p.id,child.id,{workdir:cw.dir});
fs.writeFileSync(path.join(cw.dir,'child'),'child');git.save(cw.dir,'child');
let runtime,base;
const post=(route,b={})=>fetch(base+route,{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json',Connection:'close'},body:JSON.stringify(b)});
const get=route=>fetch(base+route,{headers:{Connection:'close'}});
const target={project:p.id,task:parent.id};
const preview=async()=>{const r=await post('/api/task/integrate/preview',target);assert.equal(r.status,200);return r.json();};
const waiting=async()=> (await (await get('/api/task/integrate/wait?project='+encodeURIComponent(p.id)+'&task='+parent.id)).json()).waiting;
const activeKey=other.id+'\0'+otherTask.id;
test.before(async()=>{
 const probe=require('node:http').createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));process.env.HUB_PORT=String(port);
 runtime=require('../server');await new Promise(r=>runtime.server.listen(port,'127.0.0.1',r));base='http://127.0.0.1:'+port;
 // These are local injected functions; no real AI, updater or authentication command.
 const tools=runtime.aiUpdates.tools;tools.dry=false;tools.find=ai=>ai==='codex'?'/fixture/codex':'';tools.methods.codex='standalone';
 let version='1.0.0';tools.latest=async()=>({version:'1.1.0',source:'fixture'});
 tools.run=async(file,args)=>args[0]==='--version'?version:args[0]==='update'?(version='1.1.0',''):JSON.stringify({models:[{slug:'gpt-6.1-sol',display_name:'GPT-6.1-Sol',visibility:'list'}]});
 runtime.aiUpdates.accounts.status=async()=>({status:'logged-in'});
 const ft=await (await post('/api/freetalk/ensure')).json();assert.equal(ft.ready,true);g(path.join(root,'Product/freetalk'),'init','-q');g(path.join(tmp,'ft/Documents/freetalk'),'init','-q');
});
test.after(async()=>{runtime.chats.running.clear();runtime.server.closeAllConnections();await new Promise(r=>runtime.server.close(r));fs.rmSync(tmp,{recursive:true,force:true});});
test('無関係な会話・ターミナル・保存キュー・freetalkはpreviewとwaitを止めない',async()=>{
 const list=runtime.sessions.list;
 for(const kind of ['chat','terminal','queue','freetalk']){
  if(kind==='chat')runtime.chats.running.set(activeKey,{ai:'claude'});
  if(kind==='terminal')runtime.sessions.list=()=>[{project:other.id,task:otherTask.id,ai:'claude',running:true}];
  if(kind==='queue')runtime.chats.setQueue(other.id,otherTask.id,[{id:'held',ai:'claude',text:'held',limitWaiting:true}],true);
  if(kind==='freetalk')runtime.chats.running.set('freetalk\0fixture',{ai:'claude'});
  try{const d=await preview();assert.ok(d.token,kind);assert.deepEqual(d.waiting,[]);assert.deepEqual(await waiting(),[]);}
  finally{runtime.chats.running.clear();runtime.sessions.list=list;runtime.chats.setQueue(other.id,otherTask.id,[],true);}
 }
});
test('同一プロジェクト・別プロジェクトの共有Gitは開始直前も止め、tokenを取り直す',async()=>{
 for(const mode of ['same-project','shared-worktree']){
  const ready=await preview();
  const key=mode==='same-project'?p.id+'\0'+child.id:activeKey;
  if(mode==='shared-worktree')store.updateTask(other.id,otherTask.id,{workdir:cw.dir});
  runtime.chats.running.set(key,{ai:'claude'});
  try{
   const d=await preview();assert.equal(d.token,undefined);assert.deepEqual(d.waiting,await waiting());assert.ok(d.waiting.some(x=>x.kind==='chat'));
   for(const route of ['/api/task/integrate','/api/task/absorb','/api/task/integrate/resume']){
    const res=await post(route,{...target,token:ready.token,confirm:true,selected:[]});assert.equal(res.status,409);assert.equal((await res.json()).code,'INTEGRATION_BUSY');
   }
  }finally{runtime.chats.running.clear();store.updateTask(other.id,otherTask.id,{workdir:''});}
  assert.ok((await preview()).token);
 }
});
test('別CLI稼働中に個別更新でき、同CLIは拒否、一括は稼働中の種類を飛ばす',async()=>{
 runtime.chats.running.set(activeKey,{ai:'claude'});
 try{assert.equal((await post('/api/ai-tools/update',{ai:'codex'})).status,200);}
 finally{runtime.chats.running.clear();}
 runtime.chats.running.set(activeKey,{ai:'codex'});
 try{
  assert.equal((await post('/api/ai-tools/check',{ai:'codex'})).status,200);
  assert.equal((await post('/api/ai-tools/update',{ai:'codex'})).status,409);
  const res=await post('/api/ai-tools/update-all');assert.equal(res.status,200);assert.equal((await res.json()).results.find(x=>x.ai==='codex').state,'busy');
 }finally{runtime.chats.running.clear();}
});
test('生存登録のある外部Terminalは全アカウントで同CLI個別・一括更新を止め、別CLIを許す',async()=>{
 const accounts=runtime.aiUpdates.accounts,tools=runtime.aiUpdates.tools,run=tools.run,latest=tools.latest;
 fs.mkdirSync(accounts.termDir,{recursive:true});const marker=path.join(accounts.termDir,'external.json');let updates=0;
 tools.run=async(file,args,...rest)=>{if(args[0]==='update')updates++;return run(file,args,...rest);};
 try{
  for(const account of ['default','other-account'])for(const kind of ['work','auth']){
   fs.writeFileSync(marker,JSON.stringify({ai:'codex',account,kind,pid:process.pid}));
   assert.equal(tools.busy('codex')>0,true);assert.equal(tools.busy('claude'),0);
   assert.equal((await post('/api/ai-tools/update',{ai:'codex'})).status,409);
   if(kind==='work')assert.equal((await post('/api/ai-tools/check',{ai:'codex'})).status,200);
   const res=await post('/api/ai-tools/update-all');assert.equal(res.status,200);assert.equal((await res.json()).results.find(x=>x.ai==='codex').state,'busy');
  }
  assert.equal(updates,0);
  fs.writeFileSync(marker,JSON.stringify({ai:'claude',account:'other-account',kind:'work',pid:process.pid}));
  assert.equal(tools.busy('codex'),0);assert.ok(tools.busy('claude')>0);
  tools.updateChecks={};tools.latest=async()=>({version:'1.2.0',source:'fixture'});
  assert.equal((await post('/api/ai-tools/update',{ai:'codex'})).status,200);assert.equal(updates,1);
 }finally{tools.run=run;tools.latest=latest;fs.unlinkSync(marker);}
});
test('CLI対象のロック中も別CLIは開始でき、統合と再起動は待つ',async()=>{
 const tools=runtime.aiUpdates.tools,latest=tools.latest;let release;
 tools.latest=async()=>{await new Promise(r=>release=r);return {version:'1.2.0',source:'fixture'};};
 const pending=post('/api/ai-tools/update',{ai:'codex'});
 try{
  for(let n=0;n<200&&!release;n++)await new Promise(r=>setTimeout(r,5));assert.ok(release);
  assert.equal(tools.isOperating('codex'),true);assert.equal(tools.isOperating('claude'),false);
  assert.equal((await post('/api/term/start',{project:other.id,task:otherTask.id,ai:'codex'})).status,409);
  assert.equal((await post('/api/continue',{project:other.id,task:otherTask.id,ai:'codex'})).status,409);
  const extra=runtime.aiUpdates.accounts.add('codex','試験専用');
  assert.equal((await post('/api/accounts/login',{ai:'codex',id:extra.id})).status,409);
  assert.equal((await post('/api/term/start',{project:other.id,task:otherTask.id,ai:'claude'})).status,200);
  assert.ok((await preview()).waiting.some(x=>x.kind==='cli'));
  const r=await post('/api/restart',{reserve:true});assert.equal(r.status,200);assert.ok((await r.json()).restart.reserved);
  assert.equal(runtime.restartControl.committed,false);
  assert.equal((await post('/api/restart/cancel')).status,200);
 }finally{release();tools.latest=latest;await pending;}
});
test('予約は既存処理を妨げず、重複せず取消でき、統合処理中には切り替わらない',async()=>{
 runtime.chats.running.set(activeKey,{ai:'claude'});
 const a=await (await post('/api/restart',{reserve:true})).json(),b=await (await post('/api/restart',{reserve:true})).json();assert.deepEqual(a.restart.reserved,b.restart.reserved);
 assert.ok((await preview()).token);assert.equal((await post('/api/task/step',{project:other.id,task:otherTask.id,add:'既存処理'})).status,200);
 runtime.chats.running.clear();runtime.integrateAuto.active=true;
 runtime.restartControl.tick();assert.equal(runtime.restartControl.committed,false);
 assert.equal((await post('/api/ai-tools/update',{ai:'codex'})).status,409);
 assert.equal((await post('/api/restart/cancel')).status,200);runtime.integrateAuto.active=false;runtime.restartControl.tick();assert.equal(runtime.restartControl.executions,0);
});
test('AI終了後も上限交代の資料保存が終わるまで予約を確定しない',async()=>{
 const key=runtime.sessions.key(other.id,otherTask.id,'claude'),src={exited:true,limitTransition:true,limitTransitionDone:false};runtime.sessions.map.set(key,src);
 try{
  const r=await (await post('/api/restart',{reserve:true})).json();assert.ok(r.restart.reserved);assert.ok(r.restart.waiting.some(x=>x.kind==='limit-transition'));
  runtime.restartControl.tick();assert.equal(runtime.restartControl.committed,false);
  assert.equal((await post('/api/restart/cancel')).status,200);src.limitTransitionDone=true;
 }finally{runtime.sessions.map.delete(key);}
});
test('受付済みの書込が完了するまで予約を確定せず、取消もできる',async()=>{
 const http=require('node:http');let resolve;
 const done=new Promise(r=>resolve=r),body=JSON.stringify({project:other.id,task:otherTask.id,add:'受付済み'});
 const req=http.request(base+'/api/task/step',{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
 req.write(body.slice(0,10));
 await new Promise(r=>setTimeout(r,30));
 try{
  const r=await (await post('/api/restart',{reserve:true})).json();assert.ok(r.restart.reserved);assert.ok(r.restart.waiting.some(x=>x.kind==='write'));assert.equal(runtime.restartControl.committed,false);
  assert.equal((await post('/api/restart/cancel')).status,200);
 }finally{req.end(body.slice(10));assert.equal(await done,200);}
 runtime.restartControl.tick();assert.equal(runtime.restartControl.executions,0);
});
test('未保存・破損キューは再起動を止め、保存済みの順序・上限・手動停止は保つ',async()=>{
 const q=[{id:'first',text:'held',ai:'claude',limitWaiting:true,error:'上限',limitSlot:'main'},{id:'second',text:'manual',ai:'codex',error:'手動停止',paused:true}];
 runtime.chats.setQueue(other.id,otherTask.id,q,true);
 const file=path.join(other.dir,'.ai/chat',otherTask.id+'.queue.json'),original=fs.readFileSync(file);
 runtime.chats.queues.set(activeKey,[...q,{id:'unsaved'}]);assert.equal((await post('/api/restart')).status,409);assert.equal(runtime.restartControl.committed,false);
 runtime.chats.queues.set(activeKey,q);fs.writeFileSync(file,'{broken');assert.equal((await post('/api/restart')).status,409);assert.equal(runtime.restartControl.committed,false);
 fs.writeFileSync(file,original);runtime.chats.verifyQueues();assert.deepEqual(fs.readFileSync(file),original);
});
test('無関係なAIの稼働中に正式統合を実行し、実Gitと成果受領を保存する',async()=>{
 const before=git.inspect(pw.dir).head,main=git.inspect(body).head;
 runtime.chats.running.set(activeKey,{ai:'claude'});
 try{
  const d=await preview();assert.ok(d.token);
  const r=await post('/api/task/integrate',{...target,token:d.token,confirm:true,selected:[{project:p.id,task:child.id,disposition:'continue',review:{...d.items[0].review,confirmed:true,evidence:'隔離試験で保存HEADと範囲を確認',residual:'残件を保持',undecided:'なし'}}]});const out=await r.json();assert.equal(r.status,200,JSON.stringify(out));assert.equal(out.ok,true);
  assert.notEqual(git.inspect(pw.dir).head,before);assert.equal(fs.readFileSync(path.join(pw.dir,'child'),'utf8'),'child');assert.equal(git.inspect(body).head,main);assert.ok(fs.existsSync(cw.dir));
 }finally{runtime.chats.running.clear();}
});
test('保存キューだけなら一度再起動確定し、新規開始・更新・書込を拒否する',async()=>{
 const file=path.join(other.dir,'.ai/chat',otherTask.id+'.queue.json'),before=fs.readFileSync(file);
 const a=await post('/api/restart');assert.equal(a.status,200,JSON.stringify(await a.json()));assert.equal(runtime.restartControl.executions,1);assert.equal(runtime.restartControl.committed,true);
 assert.equal((await post('/api/restart')).status,200);assert.equal(runtime.restartControl.executions,1);
 for(const [route,b]of [['/api/term/start',{project:other.id,task:otherTask.id,ai:'claude'}],['/api/ai-tools/update',{ai:'codex'}],['/api/task/step',{...target,add:'new'}],['/api/chat/unqueue',{project:other.id,task:otherTask.id,id:'first'}]])assert.equal((await post(route,b)).status,409);
 assert.deepEqual(fs.readFileSync(file),before);
});
