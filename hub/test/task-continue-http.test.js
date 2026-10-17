'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{randomUUID}=require('node:crypto');
const {Store}=require('../lib/store'),chat=require('../lib/chat');
// このHTTP試験は保存・切替を検証する。選別CLIは呼ばず既存の安全な要約へ進める。
const originalSend=chat.ChatRunner.prototype.send;chat.ChatRunner.prototype.send=function(){throw Error('Continuation HTTP fixture never starts an AI CLI');};
const tmp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-task-continue-http-'));
const root=path.join(tmp,'root'),home=path.join(tmp,'home');
fs.mkdirSync(home);fs.mkdirSync(path.join(root,'_hub'),{recursive:true});
fs.copyFileSync(path.join(__dirname,'../../docs/project-hub/templates/_hub/roles.yaml'),path.join(root,'_hub/roles.yaml'));
Object.assign(process.env,{HUB_ROOT:root,HUB_FREETALK_HOME:home,HOME:home,HUB_DRY_RUN:'1',HUB_TRASH:path.join(tmp,'Trash'),HUB_PORT:String(43000+Math.floor(Math.random()*1000))});
const store=new Store(root),project=store.createProject({name:'Fixture'}).project,task=store.createTask(project.id,{title:'本作業',steps:['残件']});
store.appendSection(project.id,task.id,'メモ','- x\n'.repeat(7000));chat.append(project.dir,task.id,{role:'user',text:'旧原文'});
const {server}=require('../server');let base;
const q=new URLSearchParams({project:project.id,task:task.id}),get=async route=>{const r=await fetch(base+route,{headers:{'X-Hub':'1'}});return {status:r.status,json:await r.json()};};
const post=async(route,data)=>{const r=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json','X-Hub':'1'},body:JSON.stringify({project:project.id,task:task.id,...data})});return {status:r.status,json:await r.json()};};
const fields={decision:'集約する',reason:'迷わないため',current:'実装中',approved:'作業コピーのみ',residual:'独立チェック',evidence:'作業ファイル'};

async function finished(input){for(let i=0;i<400;i++){const s=(await get('/api/task/continue/status?'+q+'&requestId='+input.requestId)).json;if(s.status==='done')return s.result;if(s.status==='failed')throw Error(JSON.stringify(s));await new Promise(r=>setTimeout(r,25));}throw Error('automatic selection timeout');}

test.before(async()=>{await new Promise(r=>server.listen(Number(process.env.HUB_PORT),'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;});
test.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));chat.ChatRunner.prototype.send=originalSend;fs.rmSync(tmp,{recursive:true,force:true});});
test('要約して続けるは本文整理と切替を一度に行い、再送は旧世代でも重ねない',async()=>{
  const s=(await get('/api/task/history/status?'+q)).json,b=(await get('/api/task/body/preview?'+q)).json;assert.ok(b.moves.length>0);assert.equal(b.enabled,false);
  const input={fields,confirm:true,generation:s.generation,revision:s.revision,requestId:randomUUID(),body:{token:b.token,confirm:true}};
  const accepted=await post('/api/task/continue',input);assert.equal(accepted.status,200);assert.equal(accepted.json.pending,true);const out={json:await finished(input)};assert.deepEqual([out.json.ok,out.json.body,out.json.rotate,out.json.generation],[true,'ok','ok',2]);
  const again=await post('/api/task/continue',input);assert.equal(again.status,200);assert.equal(again.json.duplicate,true);
  const list=(await get('/api/task/body/archives?'+q)).json.archives;assert.ok(list.length>0);
  const read=await get('/api/task/body/archive?'+new URLSearchParams({project:project.id,task:task.id,path:list[0].path}));assert.equal(read.status,200);assert.match(read.json.text,/- x/);
  assert.equal((await get('/api/task/body/archive?'+new URLSearchParams({project:project.id,task:task.id,path:'PROJECT.md'}))).status,404);
  assert.equal((await fetch(base+'/api/task/body/archives?'+q)).status,403);
});
test('未完了の作業は終了の片付けの確認を出さない',async()=>{const r=await post('/api/task/tidy/preview',{});assert.equal(r.status,200);assert.equal(r.json.token,'');assert.match(r.json.blockers.join(),/完了した作業だけ/);assert.equal((await post('/api/task/tidy/apply',{token:randomUUID(),ids:['x'],confirm:true})).status,409);});
test('R3/R5: 対象別の送信照合と未実行拒否を返し、新世代で完了承認できる',async()=>{
 const status=(await get('/api/task/history/status?'+q)).json;
 const invalid=await post('/api/task/continue',{fields:{},confirm:false,generation:status.generation,revision:status.revision,requestId:randomUUID()});assert.equal(invalid.status,409);assert.equal(invalid.json.stage,'not-started');
 const input={fields,confirm:true,generation:status.generation,revision:status.revision,requestId:randomUUID()},accepted=await post('/api/task/continue',input);assert.equal(accepted.status,200);const out={json:await finished(input)};assert.equal(out.json.rotate,'ok');
 const check=await get('/api/task/continue/status?'+q+'&requestId='+input.requestId);assert.equal(check.status,200);assert.equal(check.json.status,'done');assert.equal(check.json.result.generation,out.json.generation);
 assert.equal((await fetch(base+'/api/task/continue/status?'+q)).status,403);
 const wrong=await post('/api/task/continue/recover',{requestId:randomUUID(),confirm:true,generation:status.generation});assert.equal(wrong.status,409);assert.match(wrong.json.error,/送信記録/);
 const recovery=await post('/api/task/continue/recover',{requestId:input.requestId,confirm:true,generation:status.generation});assert.equal(recovery.status,200);assert.equal(recovery.json.generation,out.json.generation);
 store.appendSection(project.id,task.id,'成果','- なし：確認のみ');const current=store.readProject(project.id).tasks.find(x=>x.id===task.id);
 assert.equal((await post('/api/task/completion',{action:'approve',confirm:true,expectedHash:current.completionHash,generation:out.json.generation})).json.state,'完了');
});
