'use strict';
process.env.HUB_LANG = 'ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process'),git=require('../lib/git');
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'state-head-'));
const body=path.join(root,'body');fs.mkdirSync(body);
const sh=(...args)=>execFileSync('git',['-C',body,'-c','commit.gpgsign=false',...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
let hub,base;
test.before(async()=>{
 sh('init','-q','-b','main');sh('config','user.name','Fixture');sh('config','user.email','fixture@localhost');sh('config','core.hooksPath','/dev/null');
 fs.writeFileSync(path.join(body,'a'),'one');sh('add','.');sh('commit','-qm','one');
 Object.assign(process.env,{HUB_ROOT:path.join(root,'ledger'),HUB_DRY_RUN:'1',HUB_AI_HOME:path.join(root,'home'),HUB_FREETALK_HOME:path.join(root,'freetalk'),HUB_STORAGE_GUARD:'',HUB_AUTO_UPDATE:'0',HUB_AUTO_TRANSLATE:'0',HUB_UPDATE_SOURCE:''});
 const probe=require('node:http').createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));process.env.HUB_PORT=String(port);
 hub=require('../server');await hub.restoreReady;await new Promise(r=>hub.server.listen(port,'127.0.0.1',r));base='http://127.0.0.1:'+port;
});
test.after(async()=>{if(hub){hub.stopControl.cleanExit();hub.webchat.shutdown();hub.sessions.stopAll();await new Promise(r=>hub.server.close(r));}fs.rmSync(root,{recursive:true,force:true});});
test('async display HEAD is fresh after commit, branch switch, packed refs and detached HEAD',async()=>{
 const first=git.savedHead(body);assert.equal(await git.savedHeadAsync(body),first);
 fs.writeFileSync(path.join(body,'a'),'two');sh('add','.');sh('commit','-qm','two');const second=git.savedHead(body);assert.notEqual(second,first);assert.equal(await git.savedHeadAsync(body),second);
 sh('checkout','-q','-b','older',first);assert.equal(await git.savedHeadAsync(body),first);sh('pack-refs','--all');assert.equal(await git.savedHeadAsync(body),first);
 sh('checkout','-q','--detach',second);assert.equal(await git.savedHeadAsync(body),second);
 const wd=path.join(root,'copy');sh('worktree','add','-q','-b','work',wd,first);assert.equal(await git.savedHeadAsync(wd),git.savedHead(wd));
});
test('a missing repository has no remembered HEAD and no new files',async()=>{
 const missing=path.join(root,'missing');assert.equal(await git.savedHeadAsync(missing),null);assert.equal(fs.existsSync(missing),false);
});
test('state waits for its exact HEAD while ping remains responsive; no read scope crosses the wait',async()=>{
 const original=git.savedHeadAsync;let release,started;const pending=new Promise(r=>started=r);const expected='a'.repeat(40);let finished=false;
 git.savedHeadAsync=()=>new Promise(r=>{release=r;started();});
 try{
  const response=fetch(base+'/api/state',{headers:{'X-Hub':'1'}}).then(r=>{finished=true;return r;});await pending;
  const ping=await fetch(base+'/api/ping',{headers:{'X-Hub':'1'}});assert.equal(ping.status,200);assert.equal(finished,false);
  let reads=0;const owner={};require('../lib/state-read').memo(owner,'test',()=>++reads);require('../lib/state-read').memo(owner,'test',()=>++reads);assert.equal(reads,2);
  release(expected);const r=await response;assert.equal(r.status,200);assert.equal((await r.json()).saved.mainHead,expected);
 }finally{if(release)release(expected);git.savedHeadAsync=original;}
});
test('state makes a new exact Git read each time and does not substitute boot HEAD on failure',async()=>{
 const original=git.savedHeadAsync;let calls=0;git.savedHeadAsync=async()=>++calls===1?'b'.repeat(40):null;
 try{const state=async()=>{const r=await fetch(base+'/api/state',{headers:{'X-Hub':'1'}});assert.equal(r.status,200);return r.json();};assert.equal((await state()).saved.mainHead,'b'.repeat(40));assert.equal((await state()).saved.mainHead,null);assert.equal(calls,2);}finally{git.savedHeadAsync=original;}
});
