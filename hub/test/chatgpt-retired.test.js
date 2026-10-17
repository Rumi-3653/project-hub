"use strict";
process.env.HUB_LANG = 'ja';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const chat=require('../lib/chat'), launch=require('../lib/launch');
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-retired-'));
const pdir=path.join(root,'Product/P'),body=path.join(root,'Body');
fs.mkdirSync(path.join(pdir,'.ai/tasks'),{recursive:true});fs.mkdirSync(body);
fs.writeFileSync(path.join(pdir,'PROJECT.md'),`---\nname: P\nfolders:\n  本体: ${body}\n---\n`);
const taskFile=path.join(pdir,'.ai/tasks/t.md');
fs.writeFileSync(taskFile,'---\nid: t\ntitle: Test\nstate: 未着手\nowner: codex\nworkspaceMode: isolated\n---\n');
const authDir=path.join(root,'home/chatgpt-plan');fs.mkdirSync(authDir,{recursive:true});
const credential=path.join(authDir,'auth.json');fs.writeFileSync(credential,'{"fixture":"retained"}',{mode:0o600});
chat.append(pdir,'t',{role:'assistant',ai:'chatgpt',model:'gpt-6-astra',text:'legacy reply'});
chat.writeMeta(pdir,'t',{sessions:{chatgpt:'legacy'},models:{chatgpt:'gpt-6-astra'}});
const queue=[{id:'old-request',ai:'chatgpt',model:'gpt-6-astra',text:'legacy queued'}];
fs.writeFileSync(chat.files(pdir,'t').queue,JSON.stringify(queue));
const before=new Map([taskFile,credential,...Object.values(chat.files(pdir,'t')).filter(fs.existsSync)].map(f=>[f,fs.readFileSync(f)]));
const fetchOriginal=global.fetch;let server,sessions,base,external=0;
Object.assign(process.env,{HUB_ROOT:root,HUB_PORT:'0',HUB_DRY_RUN:'1',HUB_AI_HOME:path.join(root,'home'),HUB_AUTO_TRANSLATE:'0',HUB_AUTO_UPDATE:'0',HUB_STORAGE_GUARD:''});
test.before(async()=>{
 const probe=require('node:http').createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));process.env.HUB_PORT=String(port);
 ({server,sessions}=require('../server'));await new Promise(r=>server.listen(port,'127.0.0.1',r));base='http://127.0.0.1:'+port;
 global.fetch=(url,options)=>{if(new URL(url).origin!==base){external++;throw Error('external requests forbidden');}return fetchOriginal(url,options);};
});
test.after(async()=>{global.fetch=fetchOriginal;sessions.stopAll();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});});
const request=(route,body,auth=true)=>fetch(base+route,{method:body===undefined?'GET':'POST',headers:{...(auth?{'X-Hub':'1'}:{}),'Content-Type':'application/json',Connection:'close'},...(body===undefined?{}:{body:JSON.stringify(body)})});
test('旧状態・認可・確認・ログアウトAPIは廃止を返し、認証情報や履歴を変更しない',async()=>{
 for(const route of ['/api/chatgpt/plan','/api/chatgpt/plan/login','/api/chatgpt/plan/check','/api/chatgpt/plan/logout']){
  for(const body of [undefined,{}]){const res=await request(route,body);assert.equal(res.status,410);assert.match((await res.json()).error,/廃止/);}
 }
 assert.equal((await request('/api/chatgpt/plan/login',{},false)).status,403);
 const state=await (await request('/api/state')).json();assert.equal('chatgptPlan' in state,false);
 for(const [file,content]of before)assert.deepEqual(fs.readFileSync(file),content,file);
 assert.equal(fs.statSync(credential).mode&0o777,0o600);assert.equal(external,0);
});
test('古い契約枠の送信・キュー再開はAI起動やコピー作成より前に拒否する',async()=>{
 for(const extra of [{},{mode:'queue'},{fromQueue:'old-request'}]){
  const res=await request('/api/chat/send',{project:'P',task:'t',ai:'chatgpt',model:'gpt-6-astra',text:'legacy queued',...extra});assert.equal(res.status,409);assert.match((await res.json()).error,/廃止/);
 }
 for(const [file,content]of before)assert.deepEqual(fs.readFileSync(file),content,file);
 assert.equal(fs.existsSync(path.join(root,'Work/P/t')),false);assert.equal(sessions.list().length,0);assert.equal(external,0);
});
test('ChatRunnerの直接・待ち指示経路も廃止を返し、旧キューと履歴を保持する',async()=>{
 const runner=new chat.ChatRunner({dirOf:()=>pdir,beforeQueued:()=>{throw Error('preflight must not run');}});
 const options={project:'P',task:'t',pdir,dir:body,ai:'chatgpt',model:'gpt-6-astra',text:'legacy queued',request:'old-request'};
 assert.throws(()=>runner.send(options),/廃止/);await assert.rejects(runner.sendQueued(options),/廃止/);
 assert.equal(runner.running.size,0);assert.deepEqual(runner.queue('P','t'),queue);assert.equal(runner.sendPlan,undefined);
 assert.equal(chat.read(pdir,'t')[0].text,'legacy reply');assert.equal(launch.flagFor('codex','Astra'),'gpt-6-astra');
 for(const file of ['chatgpt-plan.js','chatgpt-plan-worker.js','chatgpt-plan-tools.js'])assert.equal(fs.existsSync(path.join(__dirname,'../lib',file)),false);
 assert.ok(fs.existsSync(path.join(__dirname,'../lib/workspace-sandbox.js')));
});
