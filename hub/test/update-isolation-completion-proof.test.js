'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process'),{randomUUID}=require('node:crypto');
const {Store}=require('../lib/store'),chat=require('../lib/chat'),spool=require('../lib/cli-spool');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let n=0;n<180;n++){const r=await fn();if(r)return r;await pause(20);}throw Error('fixture timeout');}
function fixture(stage){
 const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-completion-proof-')),root=path.join(dir,'root'),home=path.join(dir,'home');fs.mkdirSync(home);const store=new Store(root),p=store.createProject({name:'GuardFixture'}).project,t=store.createTask(p.id,{title:'turn',workspaceMode:'direct'}),run=randomUUID(),runs=path.join(root,'_hub/cli-runs'),rd=path.join(runs,run);fs.mkdirSync(rd,{recursive:true});
 const options={project:p.id,task:t.id,pdir:p.dir,dir:p.dir,ai:'claude',model:'claude-opus-5-5',text:'fixture',request:'completed',userRow:{at:new Date().toISOString(),turn:'fixture-turn'}};
 spool.atomic(rd,'request.json',{options,turn:{command:'never-launched',args:[],stdin:'fixture',modelFlag:'claude-opus-5-5'},meta:{sessions:{},models:{}},rows:[]});spool.atomic(rd,'started.json',{supervisorPid:process.pid,cliPid:process.pid});
 const output=[{type:'system',subtype:'init',session_id:'fixture-session'},{type:'assistant',message:{content:[{type:'text',text:'preserved answer'}]}},{type:'result',result:'preserved answer',session_id:'fixture-session'}];fs.writeFileSync(path.join(rd,'out.jsonl'),output.map((o,n)=>JSON.stringify({n:n+1,line:JSON.stringify(o)})).join('\n')+'\n');spool.atomic(rd,'exit.json',{code:0,signal:null});
 const queue=[{id:'next',ai:'claude',model:'claude-opus-5-5',text:'must remain queued'}];fs.mkdirSync(path.join(p.dir,'.ai/chat'),{recursive:true});fs.writeFileSync(chat.files(p.dir,t.id).queue,JSON.stringify(queue));
 const harness=path.join(dir,'boot.cjs'),serverFile=require.resolve('../server');
 fs.writeFileSync(harness,`const fs=require('node:fs');const stage=process.env.FAULT;const write=fs.writeFileSync,append=fs.appendFileSync,rename=fs.renameSync,sync=fs.fsyncSync,open=fs.openSync;const fds=new Map();let receiptWritten=false;
 if(process.env.HUB_FIXTURE_BASELINE){const source=JSON.parse(fs.readFileSync(process.env.HUB_FIXTURE_BASELINE));const load=require.extensions['.js'];require.extensions['.js']=(m,file)=>source[file]?m._compile(source[file],file):load(m,file);}
 const meta=${JSON.stringify(chat.files(p.dir,t.id).meta)},log=${JSON.stringify(chat.files(p.dir,t.id).log)},finished=${JSON.stringify(path.join(rd,'finished.json'))};
 fs.openSync=function(f,...args){if(stage==='compound'&&String(f).includes('/failure.json.')||stage==='proof-open'&&String(f).includes('/finished-confirmed.json.')||stage==='recovery-proof-open'&&String(f).includes('/recovered.json.'))throw Error('fixture proof/failure open denied');const n=open.call(this,f,...args);fds.set(n,String(f));return n;};
 fs.writeFileSync=function(f,...args){if(['meta','diagnostic'].includes(stage)&&f===meta)throw Error('fixture meta write denied');return write.call(this,f,...args);};
 fs.appendFileSync=function(f,s,...args){if(f===log&&(stage==='compound'&&JSON.parse(s).role==='event'||stage==='diagnostic'||['final-row','failure-record'].includes(stage)&&JSON.parse(s).role==='assistant'))throw Error('fixture final row denied');return append.call(this,f,s,...args);};
 fs.renameSync=function(a,b){if(stage==='proof-rename'&&String(b).endsWith('/finished-confirmed.json')||stage==='recovery-proof-rename'&&String(b).endsWith('/recovered.json')||stage==='finished'&&b===finished||stage==='failure-record'&&String(b).endsWith('/failure.json'))throw Error('fixture finished/failure write denied');const r=rename.call(this,a,b);if(['compound','recovery-finished-fsync'].includes(stage)&&b===finished)receiptWritten=true;return r;};
 fs.fsyncSync=function(fd){if(stage==='proof-fsync'&&String(fds.get(fd)).includes('/finished-confirmed.json.')||stage==='recovery-proof-fsync'&&String(fds.get(fd)).includes('/recovered.json.'))throw Error('fixture proof file fsync denied');if(receiptWritten){receiptWritten=false;throw Error('fixture finished directory fsync denied');}return sync.call(this,fd);};
 if(process.env.BACKGROUND){require(${JSON.stringify(require.resolve('../lib/procwatch'))}).create=()=>({list:()=>JSON.parse(process.env.BACKGROUND),onChange:()=>{},stop:()=>{}});}
 const r=require(${JSON.stringify(serverFile)});let ends=0,settled=0,queueAttempts=0;r.chats.onAdoptEnd=()=>{ends++;if(stage==='on-end')throw Error('fixture onEnd failed');if(stage==='on-end-async')return Promise.reject(Error('fixture async onEnd failed'));if(stage==='on-end-crash')return new Promise(()=>{});};r.chats.onSettled=()=>{settled++;if(stage==='on-settled')throw Error('fixture onSettled failed');if(stage==='on-settled-async')return Promise.reject(Error('fixture async onSettled failed'));};r.chats.beforeQueued=()=>{queueAttempts++;};r.chats.canStart=()=> 'fixture forbids CLI launch';
 if(process.env.BACKGROUND){r.chats.supervisedPid=p=>p===41001;r.restartControl.execute=()=>{};}
 r.server.listen(Number(process.env.HUB_PORT),'127.0.0.1',()=>write(${JSON.stringify(path.join(dir,'port'))},String(r.server.address().port)));
 const observed=${JSON.stringify(path.join(dir,'observed.json'))};const timer=setInterval(()=>{write(observed+'.tmp',JSON.stringify({ends,settled,queueAttempts,running:r.chats.running.size}));rename(observed+'.tmp',observed);},10);timer.unref();
 process.on('SIGTERM',()=>process.exit(0));`);
 return {dir,root,home,p,t,run,runs,rd,stage,queue,harness,processes:[]};
}
async function boot(f,fault=f.stage,background){
 try{fs.unlinkSync(path.join(f.dir,'port'));}catch{}
 const probe=require('node:http').createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const chosen=probe.address().port;await new Promise(r=>probe.close(r));
 const child=spawn(process.execPath,[f.harness],{env:{...process.env,HUB_ROOT:f.root,HUB_PORT:String(chosen),HUB_DRY_RUN:'0',HUB_AI_HOME:f.home,HUB_FREETALK_HOME:path.join(f.dir,'ft'),HUB_AUTO_UPDATE:'0',HUB_AUTO_TRANSLATE:'0',HUB_UPDATE_SOURCE:'',FAULT:fault||'',BACKGROUND:background?JSON.stringify(background):''},stdio:['ignore','pipe','pipe']});f.processes.push(child);let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
 const port=await until(()=>{if(child.exitCode!==null||child.signalCode!==null)throw Error(logs);return fs.existsSync(path.join(f.dir,'port'))&&Number(fs.readFileSync(path.join(f.dir,'port'),'utf8'));});const base='http://127.0.0.1:'+port;
 const get=async()=>{const r=await fetch(base+'/api/state',{headers:{Connection:'close'}}),s=await r.json();assert.equal(r.status,200,JSON.stringify(s));return s;};
 const post=async(route,b={})=>{const r=await fetch(base+route,{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json',Connection:'close'},body:JSON.stringify(b)});return {status:r.status,...await r.json()};};
 return {child,get,post,logs:()=>logs};
}
async function stop(child){if(child.exitCode!==null||child.signalCode!==null)return;await new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGTERM');});}
async function cleanup(f){for(const p of f.processes)await stop(p);fs.rmSync(f.dir,{recursive:true,force:true});}
async function blocked(f,h){
 const s=await h.get(),issue=s.chatHandoffErrors.find(x=>x.run===f.run);assert.ok(issue,'unfinished durable receipt must remain visible');assert.equal(s.restartBusy,true);assert.equal(s.updateBlocked,true);
 for(const route of ['/api/restart','/api/quit','/api/app/rebuild'])assert.equal((await h.post(route)).status,409,route);
 for(const extra of [{},{fromQueue:'next'},{mode:'queue'},{mode:'redo'}])assert.equal((await h.post('/api/chat/send',{project:f.p.id,task:f.t.id,ai:'claude',model:'claude-opus-5-5',text:'never launch',...extra})).status,409);
 assert.deepEqual(JSON.parse(fs.readFileSync(chat.files(f.p.dir,f.t.id).queue)),f.queue);assert.equal(fs.existsSync(path.join(f.rd,'started-once')),false);
 return issue;
}
for(const fault of ['compound','proof-open','proof-fsync','proof-rename'])test('completion proof keeps final-save failure blocked through formal HTTP and cold boot: '+fault,async t=>{
 const f=fixture(fault);t.after(()=>cleanup(f));const h=await boot(f);
 await until(()=>spool.read(f.rd,'finished.json'));await until(()=>spool.read(f.dir,'observed.json')?.settled===1);await pause(60);
 if(fault==='compound')assert.equal(spool.read(f.rd,'failure.json'),null);
 assert.equal(spool.read(f.rd,'finished-confirmed.json'),null);
 await blocked(f,h);const saved=chat.read(f.p.dir,f.t.id);assert.equal(saved.filter(x=>x.role==='assistant').length,1);
 await stop(h.child);const next=await boot(f,'');await pause(60);const issue=await blocked(f,next);
 assert.deepEqual(chat.read(f.p.dir,f.t.id),saved);assert.deepEqual(spool.read(f.dir,'observed.json'),{ends:0,settled:0,queueAttempts:0,running:0});
 assert.throws(()=>spool.adopt(f.rd,'another-server'),/保存失敗/);
 const body={project:f.p.id,task:f.t.id,run:f.run,token:issue.token};
 const r=await next.post('/api/chat/handoff/recover',body);assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.queueRetained,true);
 const proof=fs.readFileSync(path.join(f.rd,'recovered.json'));assert.equal((await next.post('/api/chat/handoff/recover',body)).status,200);assert.deepEqual(fs.readFileSync(path.join(f.rd,'recovered.json')),proof);
 await stop(next.child);const third=await boot(f,'');await pause(60);const state=await third.get();assert.equal(state.chatHandoffErrors.length,0);assert.equal(state.restartBusy,false);
 assert.deepEqual(chat.read(f.p.dir,f.t.id),saved);assert.deepEqual(spool.read(f.dir,'observed.json'),{ends:0,settled:0,queueAttempts:0,running:0});assert.deepEqual(JSON.parse(fs.readFileSync(chat.files(f.p.dir,f.t.id).queue)),f.queue);
});
for(const fault of ['recovery-finished-fsync','recovery-proof-open','recovery-proof-fsync','recovery-proof-rename'])test('partial official receipt recovery never forgets quarantine or resends effects: '+fault,async t=>{
 const f=fixture('compound');t.after(()=>cleanup(f));const h=await boot(f);await until(()=>spool.read(f.dir,'observed.json')?.settled===1);await pause(60);
 await blocked(f,h);const saved=chat.read(f.p.dir,f.t.id);await stop(h.child);const next=await boot(f,fault);const issue=await blocked(f,next);
 const r=await next.post('/api/chat/handoff/recover',{project:f.p.id,task:f.t.id,run:f.run,token:issue.token});assert.equal(r.status,409,JSON.stringify(r));assert.equal(r.delivery,'not-sent');assert.ok(spool.read(f.rd,'finished.json'));assert.equal(spool.read(f.rd,'recovered.json'),null);
 await blocked(f,next);assert.equal(fs.existsSync(path.join(f.rd,'owner.lock')),false);await stop(next.child);const third=await boot(f,'');const current=await blocked(f,third);
 assert.deepEqual(chat.read(f.p.dir,f.t.id),saved);assert.deepEqual(spool.read(f.dir,'observed.json'),{ends:0,settled:0,queueAttempts:0,running:0});
 assert.equal((await third.post('/api/chat/handoff/recover',{project:f.p.id,task:f.t.id,run:f.run,token:issue.token})).status,409,'failed recovery changed receipt evidence');
 assert.equal((await third.post('/api/chat/handoff/recover',{project:f.p.id,task:f.t.id,run:f.run,token:current.token})).status,200);
 assert.deepEqual(JSON.parse(fs.readFileSync(chat.files(f.p.dir,f.t.id).queue)),f.queue);assert.deepEqual(chat.read(f.p.dir,f.t.id),saved);
});
test('normal completion publishes bound proof after durable receipt and altered proof returns to quarantine',async t=>{
 const f=fixture('');t.after(()=>cleanup(f));const h=await boot(f);await until(()=>spool.read(f.rd,'finished-confirmed.json'));await until(()=>spool.read(f.dir,'observed.json')?.queueAttempts===1);
 assert.equal(spool.failure(f.rd),null);assert.equal(spool.pending(f.runs).length,0);assert.equal((await h.get()).restartBusy,false);
 await stop(h.child);const saved=chat.read(f.p.dir,f.t.id),queue=JSON.parse(fs.readFileSync(chat.files(f.p.dir,f.t.id).queue));const next=await boot(f,'');await pause(60);assert.equal((await next.get()).chatHandoffErrors.length,0);assert.deepEqual(chat.read(f.p.dir,f.t.id),saved);assert.deepEqual(JSON.parse(fs.readFileSync(chat.files(f.p.dir,f.t.id).queue)),queue);await stop(next.child);
 const file=path.join(f.rd,'finished-confirmed.json'),original=fs.readFileSync(file);fs.writeFileSync(file,'{"version":1,"evidence":"changed"}');assert.ok(spool.failure(f.rd));assert.equal(spool.pending(f.runs).length,1);fs.writeFileSync(file,original);assert.equal(spool.failure(f.rd),null);
 const receipt=path.join(f.rd,'finished.json'),bytes=fs.readFileSync(receipt);spool.atomic(f.rd,'finished.json',{...spool.read(f.rd,'finished.json'),id:'different receipt'});assert.ok(spool.failure(f.rd));fs.writeFileSync(receipt,bytes);assert.equal(spool.failure(f.rd),null);
});
test('unreadable completion evidence remains unresolved instead of matching an error digest',async t=>{
 const f=fixture('');t.after(()=>cleanup(f));const child=new spool.SpoolChild(f.rd,spool.claim(f.rd,'fixture'));child.phase('finished');child.finish();assert.equal(spool.failure(f.rd),null);
 const read=fs.readFileSync,access=fs.accessSync;
 for(const name of ['request.json','finalizing.json','out.jsonl','finished-confirmed.json']){
  // Cold validation must reject a content read failure. A warmed stat cache
  // checks readability without rehashing, so inject permission loss there too.
  const moduleFile=require.resolve('../lib/cli-spool'),cached=require.cache[moduleFile];delete require.cache[moduleFile];const cold=require(moduleFile);require.cache[moduleFile]=cached;
  try{
  fs.readFileSync=function(file,...args){if(file===path.join(f.rd,name)){const e=Error('fixture unreadable evidence');e.code='EACCES';throw e;}return read.call(this,file,...args);};
  assert.ok(cold.failure(f.rd),name+' cold');assert.equal(cold.pending(f.runs).length,1,name+' cold');
  fs.accessSync=function(file,...args){if(file===path.join(f.rd,name)){const e=Error('fixture unreadable evidence');e.code='EACCES';throw e;}return access.call(this,file,...args);};
  assert.ok(spool.failure(f.rd),name);assert.equal(spool.pending(f.runs).length,1,name);
  }finally{fs.readFileSync=read;fs.accessSync=access;}
  assert.equal(spool.failure(f.rd),null);
 }
 assert.equal(spool.failure(f.rd),null);assert.equal(fs.existsSync(path.join(f.rd,'started-once')),false);
});
test('completion acknowledgement publication follows successful receipt directory fsync',async t=>{
 const f=fixture('');t.after(()=>cleanup(f));const child=new spool.SpoolChild(f.rd,spool.claim(f.rd,'fixture'));child.phase('finished');
 const rename=fs.renameSync,sync=fs.fsyncSync,events=[];let receipt=false;
 try{
  fs.renameSync=function(a,b){const r=rename.call(this,a,b);if(b===path.join(f.rd,'finished.json')){receipt=true;events.push('receipt-rename');}if(b===path.join(f.rd,'finished-confirmed.json'))events.push('proof-publish');return r;};
  fs.fsyncSync=function(fd){const r=sync.call(this,fd);if(receipt)events.push(fs.fstatSync(fd).isDirectory()?'receipt-directory-synced':'proof-file-synced');return r;};
  child.finish();
 }finally{fs.renameSync=rename;fs.fsyncSync=sync;}
 assert.deepEqual(events,['receipt-rename','receipt-directory-synced','proof-file-synced','proof-publish']);assert.equal(spool.failure(f.rd),null);
 // Losing the last unsynced directory entry in a power loss is conservative.
 fs.unlinkSync(path.join(f.rd,'finished-confirmed.json'));assert.ok(spool.failure(f.rd));assert.equal(spool.pending(f.runs).length,1);
});
