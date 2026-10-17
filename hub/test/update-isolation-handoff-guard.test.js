'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process'),{randomUUID}=require('node:crypto');
const {Store}=require('../lib/store'),chat=require('../lib/chat'),spool=require('../lib/cli-spool');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let n=0;n<180;n++){const r=await fn();if(r)return r;await pause(20);}throw Error('fixture timeout');}
function fixture(stage){
 const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-handoff-guard-')),root=path.join(dir,'root'),home=path.join(dir,'home');fs.mkdirSync(home);const store=new Store(root),p=store.createProject({name:'GuardFixture'}).project,t=store.createTask(p.id,{title:'turn',workspaceMode:'direct'}),run=randomUUID(),runs=path.join(root,'_hub/cli-runs'),rd=path.join(runs,run);fs.mkdirSync(rd,{recursive:true});
 const options={project:p.id,task:t.id,pdir:p.dir,dir:p.dir,ai:'claude',model:'claude-opus-5-5',text:'fixture',request:'completed',userRow:{at:new Date().toISOString(),turn:'fixture-turn'}};
 spool.atomic(rd,'request.json',{options,turn:{command:'never-launched',args:[],stdin:'fixture',modelFlag:'claude-opus-5-5'},meta:{sessions:{},models:{}},rows:[]});spool.atomic(rd,'started.json',{supervisorPid:process.pid,cliPid:process.pid});
 const output=[{type:'system',subtype:'init',session_id:'fixture-session'},{type:'assistant',message:{content:[{type:'text',text:'preserved answer'}]}},{type:'result',result:'preserved answer',session_id:'fixture-session'}];fs.writeFileSync(path.join(rd,'out.jsonl'),output.map((o,n)=>JSON.stringify({n:n+1,line:JSON.stringify(o)})).join('\n')+'\n');spool.atomic(rd,'exit.json',{code:0,signal:null});
 const queue=[{id:'next',ai:'claude',model:'claude-opus-5-5',text:'must remain queued'}];fs.mkdirSync(path.join(p.dir,'.ai/chat'),{recursive:true});fs.writeFileSync(chat.files(p.dir,t.id).queue,JSON.stringify(queue));
 const harness=path.join(dir,'boot.cjs'),serverFile=require.resolve('../server');
 fs.writeFileSync(harness,`const fs=require('node:fs');const stage=process.env.FAULT;const write=fs.writeFileSync,append=fs.appendFileSync,rename=fs.renameSync,sync=fs.fsyncSync;let receiptWritten=false;
 if(process.env.HUB_FIXTURE_BASELINE){const source=JSON.parse(fs.readFileSync(process.env.HUB_FIXTURE_BASELINE));const load=require.extensions['.js'];require.extensions['.js']=(m,file)=>source[file]?m._compile(source[file],file):load(m,file);}
 const meta=${JSON.stringify(chat.files(p.dir,t.id).meta)},log=${JSON.stringify(chat.files(p.dir,t.id).log)},finished=${JSON.stringify(path.join(rd,'finished.json'))};
 fs.writeFileSync=function(f,...args){if(['meta','diagnostic'].includes(stage)&&f===meta)throw Error('fixture meta write denied');return write.call(this,f,...args);};
 fs.appendFileSync=function(f,s,...args){if(f===log&&(stage==='diagnostic'||['final-row','failure-record'].includes(stage)&&JSON.parse(s).role==='assistant'))throw Error('fixture final row denied');return append.call(this,f,s,...args);};
 fs.renameSync=function(a,b){if(stage==='finished'&&b===finished||stage==='failure-record'&&String(b).endsWith('/failure.json'))throw Error('fixture finished/failure write denied');const r=rename.call(this,a,b);if(stage==='finished-fsync'&&b===finished)receiptWritten=true;return r;};
 fs.fsyncSync=function(fd){if(receiptWritten){receiptWritten=false;throw Error('fixture finished directory fsync denied');}return sync.call(this,fd);};
 if(process.env.BACKGROUND){require(${JSON.stringify(require.resolve('../lib/procwatch'))}).create=()=>({list:()=>JSON.parse(process.env.BACKGROUND),onChange:()=>{},stop:()=>{}});}
 const r=require(${JSON.stringify(serverFile)});let ends=0,settled=0,queueAttempts=0;r.chats.onAdoptEnd=()=>{ends++;if(stage==='on-end')throw Error('fixture onEnd failed');if(stage==='on-end-async')return Promise.reject(Error('fixture async onEnd failed'));if(stage==='on-end-crash')return new Promise(()=>{});};r.chats.onSettled=()=>{settled++;if(stage==='on-settled')throw Error('fixture onSettled failed');if(stage==='on-settled-async')return Promise.reject(Error('fixture async onSettled failed'));};r.chats.beforeQueued=()=>{queueAttempts++;};r.chats.canStart=()=> 'fixture forbids CLI launch';
 if(process.env.BACKGROUND){r.chats.supervisedPid=p=>p===41001;r.restartControl.execute=()=>{};}
 r.server.listen(Number(process.env.HUB_PORT),'127.0.0.1',()=>write(${JSON.stringify(path.join(dir,'port'))},String(r.server.address().port)));
 r.restoreReady.then(()=>write(${JSON.stringify(path.join(dir,'restored.json'))},JSON.stringify({barrier:r.executionGate.barrier})));
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
for(const reverse of [false,true])test('formal restart retains every unowned background PID: '+reverse,async t=>{
 const f=fixture('');t.after(()=>cleanup(f));spool.atomic(f.rd,'finished.json',{at:Date.now()});const rows=[{project:f.p.id,task:f.t.id,pid:41001},{project:f.p.id,task:f.t.id,pid:41002},{project:f.p.id,task:f.t.id,pid:null}];if(reverse)rows.reverse();const h=await boot(f,'',rows);
 const s=await h.get();assert.ok(s.restartWaiting.some(x=>x.pid===41002));assert.ok(s.restartWaiting.some(x=>x.kind==='background'&&x.pid===null));const r=await h.post('/api/restart');assert.equal(r.status,409);assert.equal(r.waiting.some(x=>x.pid===41002),true);
});
for(const stage of ['meta','final-row','on-end','on-settled','finished','on-end-async','on-settled-async','finished-fsync','failure-record','diagnostic'])test('formal HTTP and cold boot quarantine finalization failure: '+stage,async t=>{
 const f=fixture(stage);t.after(()=>cleanup(f));const h=await boot(f);await until(()=>spool.failure(f.rd));
 await until(()=>spool.read(f.dir,'restored.json'));assert.equal(spool.read(f.dir,'restored.json').barrier,false);
 const s=await h.get();assert.equal(s.restartBusy,true);assert.ok(s.chatHandoffErrors.some(x=>x.run===f.run));assert.equal((await h.post('/api/restart')).status,409);
 for(const extra of [{},{fromQueue:'next'},{mode:'queue'},{mode:'redo'}])assert.equal((await h.post('/api/chat/send',{project:f.p.id,task:f.t.id,ai:'claude',model:'claude-opus-5-5',text:'do not spawn',...extra})).status,409);
 assert.deepEqual(JSON.parse(fs.readFileSync(chat.files(f.p.dir,f.t.id).queue)),f.queue);if(stage==='finished-fsync')assert.ok(spool.read(f.rd,'finished.json'));else assert.equal(spool.read(f.rd,'finished.json'),null);
 const before=fs.existsSync(chat.files(f.p.dir,f.t.id).log)?fs.readFileSync(chat.files(f.p.dir,f.t.id).log,'utf8'):'';await stop(h.child);const next=await boot(f,'');await pause(100);const after=await next.get();assert.equal(after.restartBusy,true);assert.equal((await next.post('/api/restart')).status,409);
 assert.equal(fs.existsSync(chat.files(f.p.dir,f.t.id).log)?fs.readFileSync(chat.files(f.p.dir,f.t.id).log,'utf8'):'',before);assert.deepEqual(JSON.parse(fs.readFileSync(chat.files(f.p.dir,f.t.id).queue)),f.queue);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir,'observed.json'),'utf8')),{ends:0,settled:0,queueAttempts:0,running:0});
 const issue=after.chatHandoffErrors.find(x=>x.run===f.run);assert.equal((await next.post('/api/chat/send',{project:f.p.id,task:f.t.id,ai:'claude',model:'claude-opus-5-5',text:'still do not spawn'})).status,409);const recovered=await next.post('/api/chat/handoff/recover',{project:f.p.id,task:f.t.id,run:f.run,token:issue.token});
 if(['finished','finished-fsync'].includes(stage)){
  assert.equal(recovered.status,200,JSON.stringify(recovered));assert.equal(recovered.queueRetained,true);assert.equal((await next.get()).restartBusy,false);const receipt=fs.readFileSync(path.join(f.rd,'recovered.json'),'utf8');assert.equal((await next.post('/api/chat/handoff/recover',{project:f.p.id,task:f.t.id,run:f.run,token:issue.token})).status,200);assert.equal(fs.readFileSync(path.join(f.rd,'recovered.json'),'utf8'),receipt);
 }else{assert.equal(recovered.status,409);assert.equal(recovered.delivery,'not-sent');assert.equal((await next.get()).restartBusy,true);}
 assert.equal(fs.existsSync(path.join(f.rd,'started-once')),false);assert.deepEqual(JSON.parse(fs.readFileSync(chat.files(f.p.dir,f.t.id).queue)),f.queue);
});

test('an interrupted asynchronous close stays blocked after boot without any failure receipt',async t=>{
 const f=fixture('on-end-crash');t.after(()=>cleanup(f));const h=await boot(f);await until(()=>spool.read(f.rd,'finalizing.json')?.stage==='on-end');assert.equal(spool.read(f.rd,'failure.json'),null);assert.equal((await h.post('/api/restart')).status,409);const before=chat.read(f.p.dir,f.t.id);await stop(h.child);const next=await boot(f,'');await pause(100);const s=await next.get();assert.equal(s.restartBusy,true);assert.equal((await next.post('/api/chat/send',{project:f.p.id,task:f.t.id,ai:'claude',model:'claude-opus-5-5',text:'blocked'})).status,409);assert.deepEqual(chat.read(f.p.dir,f.t.id),before);assert.deepEqual(spool.read(f.rd,'request.json').options.request,'completed');assert.deepEqual(JSON.parse(fs.readFileSync(chat.files(f.p.dir,f.t.id).queue)),f.queue);
});
test('receipt recovery rejects stale tokens, target changes and changed final evidence; no hooks or queue replay',async t=>{
 const f=fixture('finished');t.after(()=>cleanup(f));const h=await boot(f);await until(()=>spool.failure(f.rd));await stop(h.child);const next=await boot(f,'');const s=await next.get(),issue=s.chatHandoffErrors.find(x=>x.run===f.run),body={project:f.p.id,task:f.t.id,run:f.run,token:issue.token};
 assert.equal((await next.post('/api/chat/handoff/recover',{...body,task:'other'})).status,409);assert.equal((await next.post('/api/chat/handoff/recover',{...body,token:'stale'})).status,409);
 fs.mkdirSync(path.join(f.rd,'owner.lock'));assert.equal((await next.post('/api/chat/handoff/recover',body)).status,409);fs.rmdirSync(path.join(f.rd,'owner.lock'));
 const original=fs.readFileSync(path.join(f.rd,'request.json')),req=spool.read(f.rd,'request.json');req.options.text='changed externally';spool.atomic(f.rd,'request.json',req);const refreshed=(await next.get()).chatHandoffErrors.find(x=>x.run===f.run);assert.equal((await next.post('/api/chat/handoff/recover',{...body,token:refreshed.token})).status,409);
 fs.writeFileSync(path.join(f.rd,'request.json'),original);const rows=chat.read(f.p.dir,f.t.id);rows.find(r=>r.role==='assistant').text='external final row';fs.writeFileSync(chat.files(f.p.dir,f.t.id).log,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');assert.equal((await next.post('/api/chat/handoff/recover',body)).status,409);
 assert.equal(spool.read(f.rd,'finished.json'),null);assert.equal((await next.get()).restartBusy,true);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir,'observed.json'))),{ends:0,settled:0,queueAttempts:0,running:0});
});
test('successful hooks finish durably before one queue admission attempt',async t=>{
 const f=fixture('');t.after(()=>cleanup(f));const h=await boot(f);await until(()=>spool.read(f.rd,'finished.json'));await until(()=>{const o=spool.read(f.dir,'observed.json');return o?.queueAttempts===1;});const s=await h.get();assert.equal(s.restartBusy,false);assert.equal(s.chatHandoffErrors.length,0);assert.equal(chat.read(f.p.dir,f.t.id).filter(r=>r.role==='assistant').length,1);const o=spool.read(f.dir,'observed.json');assert.equal(o.ends,1);assert.equal(o.settled,1);assert.deepEqual(JSON.parse(fs.readFileSync(chat.files(f.p.dir,f.t.id).queue)),[{...f.queue[0],error:'fixture forbids CLI launch',limitWaiting:false}]);assert.equal(fs.existsSync(path.join(f.rd,'started-once')),false);
});

test('failed close with an empty queue blocks app switching and quit after cold boot',async t=>{
 const f=fixture('on-settled');t.after(()=>cleanup(f));fs.writeFileSync(chat.files(f.p.dir,f.t.id).queue,'[]');const h=await boot(f);await until(()=>spool.failure(f.rd));await stop(h.child);const next=await boot(f,'');const s=await next.get();assert.equal(s.chatting.length,0);assert.equal(s.updateBlocked,true);assert.equal(s.restartBusy,true);assert.equal((await next.post('/api/app/rebuild')).status,409);assert.equal((await next.post('/api/quit')).status,409);
 // An unclean reboot holds all starts before checking whether fromQueue exists.
 const refused=await next.post('/api/chat/send',{project:f.p.id,task:f.t.id,fromQueue:'missing',text:'stay blocked'});assert.equal(refused.status,409);assert.match(refused.error,/停止・保留中/);assert.equal((await next.get()).restartBusy,true);
});
test('receipt repair rejects changed output or exit/cursor/control evidence even with a fresh token',async t=>{
 const f=fixture('finished');t.after(()=>cleanup(f));const h=await boot(f);await until(()=>spool.failure(f.rd));await stop(h.child);const next=await boot(f,'');
 for(const name of ['out.jsonl','exit.json','cursor.json','control.json']){
  const file=path.join(f.rd,name),original=fs.existsSync(file)?fs.readFileSync(file):null;fs.writeFileSync(file,name==='out.jsonl'?'external output\n':'{"changed":true}');const issue=(await next.get()).chatHandoffErrors.find(x=>x.run===f.run);assert.equal((await next.post('/api/chat/handoff/recover',{project:f.p.id,task:f.t.id,run:f.run,token:issue.token})).status,409,name);assert.equal(spool.read(f.rd,'finished.json'),null);if(original)fs.writeFileSync(file,original);else fs.unlinkSync(file);
 }
 assert.equal((await next.get()).restartBusy,true);assert.deepEqual(spool.read(f.dir,'observed.json'),{ends:0,settled:0,queueAttempts:0,running:0});
});
