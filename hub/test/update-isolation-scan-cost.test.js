'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const spool=require(process.env.SPOOL_SCAN_BASELINE||'../lib/cli-spool');
function fixture(t,n=1,big=false){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-spool-scan-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const dirs=[];for(let i=0;i<n;i++){
  const dir=path.join(root,'r'+i);fs.mkdirSync(dir);dirs.push(dir);
  const row={role:'assistant',text:'preserved',spoolId:i+':final'};
  for(const [name,data] of Object.entries({'request.json':{turn:{stdin:big?'x'.repeat(100000):'fixture'}},'exit.json':{code:0},'cursor.json':{n:1},'stderr.json':{text:''},'started.json':{},'launch.json':{},'control.json':{},'owner.json':{serverId:'fixture',generation:1,pid:process.pid}}))fs.writeFileSync(path.join(dir,name),JSON.stringify(data));
  fs.writeFileSync(path.join(dir,'out.jsonl'),JSON.stringify({n:1,line:big?'y'.repeat(200000):'fixture'})+'\n');
  const child=new spool.SpoolChild(dir,{serverId:'fixture',generation:1});child.phase('finished',{finalRowHash:spool.digest(JSON.stringify(row)),completionHash:spool.completion(dir)});child.finish();
 }
 return {root,dirs};
}
function counted(fn){
 const read=fs.readFileSync,counts={large:0,all:0};
 try{fs.readFileSync=function(file,...args){counts.all++;if(['request.json','out.jsonl'].includes(path.basename(String(file))))counts.large++;return read.call(this,file,...args);};fn();return counts;}finally{fs.readFileSync=read;}
}
test('200 completed turns avoid repeated output hashing during four warmed state-like scans',t=>{
 const f=fixture(t,200,true);assert.deepEqual(spool.pending(f.root),[]);
 const counts=counted(()=>{for(let k=0;k<4;k++)assert.deepEqual(spool.pending(f.root),[]);});
 assert.equal(counts.large,0,'verified, unchanged request/output must not be reread');
 assert.equal(fs.readdirSync(f.root).length,200,'completion evidence is retained');
});
test('cold module validates evidence again before remembering completed turns',t=>{
 const f=fixture(t);assert.deepEqual(spool.pending(f.root),[]);
 const file=require.resolve(process.env.SPOOL_SCAN_BASELINE||'../lib/cli-spool');delete require.cache[file];const cold=require(file);
 assert.ok(counted(()=>assert.deepEqual(cold.pending(f.root),[])).large>0);
 assert.equal(counted(()=>assert.deepEqual(cold.pending(f.root),[])).large,0);
});
test('display scans stat one directory per proven run; actions still verify every receipt',t=>{
 const f=fixture(t,20);assert.deepEqual(spool.pending(f.root,{display:true}),[]);
 const original=fs.lstatSync;let receipts=0,dirs=0;
 try{fs.lstatSync=function(file,...args){if(path.dirname(String(file))===f.root)dirs++;else receipts++;return original.call(this,file,...args);};
  assert.deepEqual(spool.pending(f.root,{display:true}),[]);assert.equal(dirs,20);assert.equal(receipts,0);
  assert.deepEqual(spool.pending(f.root),[]);assert.ok(receipts>=20*14);
 }finally{fs.lstatSync=original;}
});
test('display cache expires for in-place edits, but actions and active/adopted runs reject immediately',t=>{
 for(const forced of [false,true]){
  const f=fixture(t),dir=f.dirs[0];assert.deepEqual(spool.pending(f.root,{display:true}),[]);
  fs.writeFileSync(path.join(dir,'out.jsonl'),'in-place change');
  if(forced){assert.deepEqual(spool.pending(f.root,{display:true,freshDirs:new Set([dir])}),[dir]);continue;}
  assert.deepEqual(spool.pending(f.root,{display:true}),[],'display only may be stale');
  assert.ok(spool.failure(dir),'strict action rejects before the next display refresh');
  assert.deepEqual(spool.pending(f.root,{display:true}),[dir],'strict invalidation clears displayed proof');
 }
 const f=fixture(t),dir=f.dirs[0],now=Date.now;
 assert.deepEqual(spool.pending(f.root,{display:true}),[]);fs.writeFileSync(path.join(dir,'out.jsonl'),'changed');
 try{Date.now=()=>now()+60001;assert.deepEqual(spool.pending(f.root,{display:true}),[dir]);}finally{Date.now=now;}
});
test('display detects atomic receipts and directory additions, removals and replacement',t=>{
 const f=fixture(t),dir=f.dirs[0];assert.deepEqual(spool.pending(f.root,{display:true}),[]);
 const temp=path.join(dir,'new');fs.writeFileSync(temp,'{"error":"new failure"}');fs.renameSync(temp,path.join(dir,'failure.json'));
 assert.deepEqual(spool.pending(f.root,{display:true}),[dir]);
 const added=path.join(f.root,'added');fs.mkdirSync(added);fs.writeFileSync(path.join(added,'request.json'),'{}');
 assert.deepEqual(spool.pending(f.root,{display:true}),[added,dir]);
 fs.rmSync(dir,{recursive:true});assert.deepEqual(spool.pending(f.root,{display:true}),[added]);
 fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'request.json'),'{}');assert.deepEqual(spool.pending(f.root,{display:true}),[added,dir]);
});
test('every bound receipt mutation and proof loss re-enters quarantine after a cache hit',t=>{
 for(const name of ['request.json','exit.json','cursor.json','out.jsonl','stderr.json','started.json','launch.json','control.json','cancel.json','finalizing.json','finished.json','finished-confirmed.json']){
  const f=fixture(t),dir=f.dirs[0],file=path.join(dir,name);assert.equal(spool.failure(dir),null);assert.equal(spool.failure(dir),null);
  fs.writeFileSync(file,'{"changed":true}');assert.ok(spool.failure(dir),name);assert.deepEqual(spool.pending(f.root),[dir],name);
 }
 for(const name of ['finished-confirmed.json','finished.json','finalizing.json']){
  const f=fixture(t),dir=f.dirs[0];assert.equal(spool.failure(dir),null);fs.unlinkSync(path.join(dir,name));assert.ok(spool.failure(dir),name);
 }
});
test('same-size edits with restored mtime and inode replacement invalidate validation',t=>{
 const f=fixture(t),dir=f.dirs[0],file=path.join(dir,'request.json');assert.equal(spool.failure(dir),null);const original=fs.readFileSync(file),s=fs.statSync(file);
 const text=original.toString().replace('fixture','altered');assert.equal(Buffer.byteLength(text),original.length);fs.writeFileSync(file,text);fs.utimesSync(file,s.atime,s.mtime);assert.ok(spool.failure(dir));
 fs.writeFileSync(file,original);assert.equal(spool.failure(dir),null);const swap=file+'.swap';fs.writeFileSync(swap,text);fs.utimesSync(swap,s.atime,s.mtime);fs.renameSync(swap,file);assert.ok(spool.failure(dir));
});
test('readability loss and stat errors never reuse a cached completion',t=>{
 for(const fault of ['access','stat']){
  const f=fixture(t),dir=f.dirs[0],file=path.join(dir,'out.jsonl');assert.equal(spool.failure(dir),null);const access=fs.accessSync,stat=fs.lstatSync,read=fs.readFileSync;
  const denied=()=>{const e=Error('fixture unreadable');e.code='EACCES';throw e;};
  try{
   fs.accessSync=function(p,...args){if(p===file&&fault==='access')denied();return access.call(this,p,...args);};
   fs.lstatSync=function(p,...args){if(p===file&&fault==='stat')denied();return stat.call(this,p,...args);};
   fs.readFileSync=function(p,...args){if(p===file)denied();return read.call(this,p,...args);};
   assert.ok(spool.failure(dir));assert.deepEqual(spool.pending(f.root),[dir]);
  }finally{fs.accessSync=access;fs.lstatSync=stat;fs.readFileSync=read;}
  assert.equal(spool.failure(dir),null);
 }
});
test('new failure receipt and changed official recovery evidence are rechecked',t=>{
 const f=fixture(t),dir=f.dirs[0];assert.equal(spool.failure(dir),null);fs.writeFileSync(path.join(dir,'failure.json'),'{"stage":"finished","error":"fixture failure"}');const issue=spool.failure(dir);assert.ok(issue);
 const row={role:'assistant',text:'preserved',spoolId:'0:final'};spool.recover(dir,'fixture',issue.token,row);assert.equal(spool.failure(dir),null);assert.equal(spool.failure(dir),null);
 fs.writeFileSync(path.join(dir,'recovered.json'),'{"version":1,"evidence":"changed"}');assert.ok(spool.failure(dir));
});
test('a file changed during validation is never remembered with a stale stat stamp',t=>{
 const f=fixture(t),dir=f.dirs[0],file=path.join(dir,'out.jsonl'),read=fs.readFileSync;let changed=false;
 try{fs.readFileSync=function(p,...args){const value=read.call(this,p,...args);if(p===file&&!changed){changed=true;fs.appendFileSync(file,'changed\n');}return value;};spool.failure(dir);}finally{fs.readFileSync=read;}
 assert.ok(spool.failure(dir));assert.deepEqual(spool.pending(f.root),[dir]);
});
test('removed directories and reused paths are not treated as their prior completed run',t=>{
 const f=fixture(t),dir=f.dirs[0];assert.deepEqual(spool.pending(f.root),[]);fs.rmSync(dir,{recursive:true});assert.deepEqual(spool.pending(f.root),[]);
 fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'request.json'),'{}');assert.deepEqual(spool.pending(f.root),[dir]);
});
test('formal HTTP rechecks a warmed completion after proof loss and retains the queued conversation',async t=>{
 const {spawn}=require('node:child_process'),{randomUUID}=require('node:crypto'),{Store}=require('../lib/store'),chat=require('../lib/chat');
 const f=fixture(t),store=new Store(f.root),p=store.createProject({name:'ScanFixture'}).project,task=store.createTask(p.id,{title:'fixture',workspaceMode:'direct'}),runs=path.join(f.root,'_hub/cli-runs'),id=randomUUID(),dir=path.join(runs,id);fs.mkdirSync(runs,{recursive:true});fs.renameSync(f.dirs[0],dir);
 const request=spool.read(dir,'request.json');request.options={project:p.id,task:task.id,pdir:p.dir,dir:p.dir,ai:'claude',model:'claude-opus-5-5'};spool.atomic(dir,'request.json',request);
 const row=chat.append(p.dir,task.id,{role:'assistant',text:'preserved final row',spoolId:id+':final'}),child=new spool.SpoolChild(dir,{serverId:'fixture',generation:1});child.phase('finished',{finalRowHash:spool.digest(JSON.stringify(row)),completionHash:spool.completion(dir)});child.finish();spool.atomic(dir,'owner.json',{...spool.read(dir,'owner.json'),released:true});
 const queue=[{id:'retained',ai:'claude',text:'never sent'}];fs.writeFileSync(chat.files(p.dir,task.id).queue,JSON.stringify(queue));
 const probe=require('node:http').createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 // Publish readiness atomically so another process cannot read an empty port.
 // HUB_PORT remains the assigned port for Hub's existing Host validation.
 const portFile=path.join(f.root,'port'),harness=path.join(f.root,'boot.cjs');fs.writeFileSync(harness,`const fs=require('node:fs'),r=require(${JSON.stringify(require.resolve('../server'))});r.chats.canStart=()=> 'fixture forbids CLI';r.server.listen(Number(process.env.HUB_PORT),'127.0.0.1',()=>{const file=${JSON.stringify(portFile)};fs.writeFileSync(file+'.tmp',String(r.server.address().port));fs.renameSync(file+'.tmp',file);});process.on('SIGTERM',()=>process.exit(0));`);
 const proc=spawn(process.execPath,[harness],{env:{...process.env,HUB_ROOT:f.root,HUB_PORT:String(port),HUB_DRY_RUN:'0',HUB_AI_HOME:path.join(f.root,'home'),HUB_FREETALK_HOME:path.join(f.root,'freetalk'),HUB_AUTO_UPDATE:'0',HUB_AUTO_TRANSLATE:'0',HUB_UPDATE_SOURCE:''},stdio:['ignore','pipe','pipe']});let logs='';proc.stdout.on('data',x=>logs+=x);proc.stderr.on('data',x=>logs+=x);
 t.after(async()=>{if(proc.exitCode===null&&proc.signalCode===null)await new Promise(resolve=>{proc.once('exit',resolve);proc.kill('SIGTERM');});});
 for(let n=0;!fs.existsSync(portFile);n++){if(n===200||proc.exitCode!==null||proc.signalCode!==null)throw Error('fixture boot failed: '+logs);await new Promise(r=>setTimeout(r,20));}
 const boundPort=Number(fs.readFileSync(portFile,'utf8'));assert.ok(boundPort>0&&boundPort<65536,'fixture readiness port');
 const base='http://127.0.0.1:'+boundPort,requestHTTP=async(...args)=>{try{return await fetch(...args);}catch(e){throw Error(`fixture HTTP failed: ${e.cause?.code||e.message}; ${logs}`,{cause:e});}},get=async()=>{const r=await requestHTTP(base+'/api/state',{headers:{Connection:'close'}});assert.equal(r.status,200);return r.json();},post=async(route,b={})=>{const r=await requestHTTP(base+route,{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json',Connection:'close'},body:JSON.stringify(b)});return {status:r.status,...await r.json()};};
 for(let n=0;n<4;n++)assert.equal((await get()).chatHandoffErrors.length,0);
 fs.unlinkSync(path.join(dir,'finished-confirmed.json'));const state=await get(),issue=state.chatHandoffErrors.find(x=>x.run===id);assert.ok(issue);assert.equal(state.restartBusy,true);
 for(const route of ['/api/restart','/api/quit','/api/app/rebuild'])assert.equal((await post(route)).status,409);
 assert.equal((await post('/api/chat/send',{project:p.id,task:task.id,ai:'claude',model:'claude-opus-5-5',text:'never launch'})).status,409);
 const recovered=await post('/api/chat/handoff/recover',{project:p.id,task:task.id,run:id,token:issue.token});assert.equal(recovered.status,200,JSON.stringify(recovered));assert.equal((await get()).chatHandoffErrors.length,0);
 assert.deepEqual(JSON.parse(fs.readFileSync(chat.files(p.dir,task.id).queue)),queue);assert.deepEqual(chat.read(p.dir,task.id),[row]);assert.equal(fs.existsSync(path.join(dir,'started-once')),false);
});
