'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{randomUUID}=require('node:crypto');
const tmp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-consultation-http-')),root=path.join(tmp,'root'),home=path.join(tmp,'home');
fs.mkdirSync(home);fs.mkdirSync(path.join(root,'_hub'),{recursive:true});fs.copyFileSync(path.join(__dirname,'../../docs/project-hub/templates/_hub/roles.yaml'),path.join(root,'_hub/roles.yaml'));
Object.assign(process.env,{HUB_ROOT:root,HOME:home,HUB_AI_HOME:home,HUB_FREETALK_HOME:home,HUB_DRY_RUN:'1',HUB_TRASH:path.join(tmp,'Trash'),HUB_PORT:String(59000+Math.floor(Math.random()*800)),PATH:'/usr/bin:/bin'});
const {IntegrateAuto}=require('../lib/integrate-auto'),tick=IntegrateAuto.prototype.tick;IntegrateAuto.prototype.tick=async()=>{};
const runtime=require('../server'),h=runtime.taskIntegrate,store=h.store,p=store.createProject({name:'Fixture'}).project,parent=store.createTask(p.id,{title:'親'}),child=store.createTask(p.id,{title:'Web相談',parent:parent.id}),body={project:p.id,task:parent.id,childProject:p.id,childTask:child.id};let base;
test.before(async()=>{await new Promise(r=>runtime.server.listen(Number(process.env.HUB_PORT),'127.0.0.1',r));base='http://127.0.0.1:'+runtime.server.address().port;});
test.after(async()=>{runtime.chats.running.clear();runtime.stopControl.cleanExit();runtime.server.closeAllConnections();await new Promise(r=>runtime.server.close(r));IntegrateAuto.prototype.tick=tick;fs.rmSync(tmp,{recursive:true,force:true});});
async function request(op,b=body,authorized=true,method='POST'){const r=await fetch(base+'/api/task/integrate/consultation-close/'+op,{method,headers:{...(authorized?{'X-Hub':'1'}:{}),'Content-Type':'application/json',Connection:'close'},...(method==='POST'?{body:JSON.stringify(b)}:{})});return {status:r.status,out:await r.json()};}
test('real server dispatcher reaches the explicit closure status endpoint',async()=>{const r=await request('status');assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.out.stage,'not-started');assert.equal(h.read(p.id,parent.id),null);});
test('closure endpoint keeps the server X-Hub mutation authorization',async()=>{assert.equal((await request('status',body,false)).status,403);});
test('GET cannot dispatch the closure endpoint',async()=>{assert.equal((await request('status',body,true,'GET')).status,405);});
test('invalid closure apply and finish reach the handler and refuse before any journal',async()=>{for(const op of ['apply','finish']){const r=await request(op,{...body,confirm:true});assert.equal(r.status,409,JSON.stringify(r));assert.match(r.out.error,/今回/);}assert.equal(require('../lib/integration-consultation-close').read(h,p.id,parent.id),null);});
test('real related-AI guard rejects a token before inspecting or moving anything',async()=>{
 const token=randomUUID(),key=p.id+'\0'+parent.id;h.tokens.set(token,{at:Date.now(),consultationClose:body});runtime.chats.running.set(key,{ai:'codex'});
 try{const r=await request('apply',{...body,token,confirm:true,authorization:'本人承認済み'});assert.equal(r.status,409,JSON.stringify(r));assert.match(r.out.error,/関係するAI/);assert.equal(require('../lib/integration-consultation-close').read(h,p.id,parent.id),null);assert.ok(fs.existsSync(store.taskFile(p.id,child.id)));}finally{runtime.chats.running.delete(key);h.tokens.delete(token);}
});
