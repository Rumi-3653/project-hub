'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {randomUUID,createHash}=require('node:crypto'),{Store}=require('../lib/store'),chat=require('../lib/chat'),git=require('../lib/git');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'hub-normal-history-http-'));
const root=path.join(tmp,'root'),home=path.join(tmp,'home'),bin=path.join(tmp,'bin');
fs.mkdirSync(bin,{recursive:true});fs.mkdirSync(home);fs.mkdirSync(path.join(root,'_hub'),{recursive:true});
fs.copyFileSync(path.join(__dirname,'../../docs/project-hub/templates/_hub/roles.yaml'),path.join(root,'_hub/roles.yaml'));
const fake=`#!${process.execPath}
if(process.argv.includes('--version')){console.log('fake only');process.exit(0)}
let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>setTimeout(()=>{
if(process.argv.includes('--verbose'))console.log(JSON.stringify({type:'result',result:JSON.stringify({input:input.replaceAll('[[質問]]','(template)').replaceAll('[[/質問]]','(end)'),args:process.argv.slice(2)}),session_id:'fresh-claude'}));
else {console.log(JSON.stringify({type:'thread.started',thread_id:'fresh-codex'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({input:input.replaceAll('[[質問]]','(template)').replaceAll('[[/質問]]','(end)'),args:process.argv.slice(2)})}}));console.log(JSON.stringify({type:'turn.completed'}));}
},180));`;
for(const ai of ['codex','claude'])fs.writeFileSync(path.join(bin,ai),fake,{mode:0o755});
Object.assign(process.env,{HUB_ROOT:root,HUB_FREETALK_HOME:home,HOME:home,HUB_DRY_RUN:'1',HUB_PORT:String(42000+Math.floor(Math.random()*1000)),PATH:bin+path.delimiter+process.env.PATH});
const store=new Store(root),project=store.createProject({name:'Fixture'}).project;
const task=store.createTask(project.id,{title:'本作業',steps:['残件']}),other=store.createTask(project.id,{title:'別作業'});
chat.append(project.dir,task.id,{role:'user',text:'旧全文を再注入しない '+('x'.repeat(240))+' UNIQUE_OLD_BODY'});
chat.append(project.dir,other.id,{role:'user',text:'他作業を保持'});
chat.writeMeta(project.dir,task.id,{sessions:{codex:'old'},sessionAccounts:{codex:'default'},models:{codex:'GPT-6.1-Sol'},accounts:{codex:'default'}});
const {server,taskPrompt}=require('../server');let base;
const body={project:project.id,task:task.id};
const post=(route,data={},headers={'X-Hub':'1'})=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({...body,...data})});
const status=async()=>await(await fetch(base+'/api/task/history/status?'+new URLSearchParams(body),{headers:{'X-Hub':'1'}})).json();
const idle=async()=>{for(let n=0;n<300;n++){const s=await status();if(!s.reason)return s;await new Promise(r=>setTimeout(r,20));}throw Error('fake did not finish');};

const finished=async input=>{for(let n=0;n<400;n++){const s=await(await fetch(base+'/api/task/continue/status?'+new URLSearchParams({project:project.id,task:input.task||task.id,requestId:input.requestId}),{headers:{'X-Hub':'1'}})).json();if(s.status==='done')return s.result;if(s.status==='failed')throw Error(JSON.stringify(s));await new Promise(r=>setTimeout(r,25));}throw Error('automatic selection timeout');};

const fields={decision:'作業を保持',reason:'続けるため',current:'確認済み',approved:'変更を作業コピーへ保存する範囲',residual:'未採用のPRは判断待ち',evidence:'履歴を参照\n次に独立確認'};
test.before(async()=>{await new Promise(r=>server.listen(Number(process.env.HUB_PORT),'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;});
test.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(tmp,{recursive:true,force:true});});
test('通常会話HTTP：認証・全write排他・原文履歴・重複・旧世代拒否',async()=>{
 assert.equal((await fetch(base+'/api/task/history/status?'+new URLSearchParams(body))).status,403);
 const before=await status(),otherBytes=fs.readFileSync(chat.files(project.dir,other.id).log);
 const input={...before,fields,confirm:true,requestId:randomUUID()};
 let finish;const done=new Promise(r=>finish=r);
 const slow=http.request(base+'/api/chat/note',{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json','Content-Length':2}},res=>{res.resume();res.on('end',finish);});slow.write('{');
 for(let n=0;n<100&&!/保存・送信/.test((await status()).reason);n++)await new Promise(r=>setTimeout(r,10));
 assert.equal((await post('/api/task/history/rotate',input)).status,409);slow.end('}');await done;
 const ready=await status(),rotate={...input,revision:ready.revision};assert.equal((await post('/api/task/history/rotate',rotate)).status,409);const r=await post('/api/task/continue',rotate);assert.equal(r.status,200,JSON.stringify(await r.clone().json()));assert.equal((await r.json()).pending,true);const out=await finished(rotate);
 assert.equal(out.generation,2);assert.equal((await post('/api/task/history/rotate',rotate)).status,200); // same request stays idempotent
 const retry={...rotate};delete retry.generation;assert.equal((await post('/api/task/history/rotate',retry)).status,200);
 const archived=await(await fetch(base+'/api/task/history/archive?'+new URLSearchParams({...body,archiveId:out.archiveId}),{headers:{'X-Hub':'1'}})).json();assert.match(archived.rows[0].text,/UNIQUE_OLD_BODY/);
 assert.deepEqual(fs.readFileSync(chat.files(project.dir,other.id).log),otherBytes);
 assert.equal((await post('/api/chat/note',{generation:1,text:'旧画面からの送信'})).status,409);
 assert.equal((await post('/api/chat/note',{text:'古いブラウザの世代なし送信'},{'X-Hub':'1',Origin:base})).status,409);
 assert.equal(chat.read(project.dir,task.id).length,1);
 const p=store.readProject(project.id),file=store.taskFile(project.id,task.id),t=store.readTask(file);
 for(const where of ['chat','terminal']){const prompt=taskPrompt(p,t,file,p.dir,where);assert.match(prompt,/最新の再開要約/);assert.doesNotMatch(prompt,/UNIQUE_OLD_BODY/);}
 const next=await post('/api/chat/send',{generation:2,ai:'codex',model:'GPT-6.1-Sol',effort:'高',text:'新世代で続行'});assert.equal(next.status,200,JSON.stringify(await next.clone().json()));assert.equal((await next.json()).resume,false);await idle();
 const response=JSON.parse(chat.read(project.dir,task.id).at(-1).text);assert.match(response.input,/残件/);assert.doesNotMatch(response.input,/UNIQUE_OLD_BODY/);assert.ok(!response.args.includes('resume'));
});
test('通常会話HTTP：要約は設定の文章担当、稼働中に切替せず返答を確認',async()=>{
 const before=chat.read(project.dir,task.id),r=await post('/api/task/history/summary');assert.equal(r.status,200,JSON.stringify(await r.clone().json()));
 const busy=await status();assert.ok(busy.reason);assert.equal((await post('/api/task/history/rotate',{...busy,fields,confirm:true,requestId:randomUUID()})).status,409);
 const ready=await idle();assert.ok(ready.draft);const response=JSON.parse(ready.draft);assert.ok(response.args.includes('claude-opus-5-5'));
 assert.equal(chat.read(project.dir,task.id)[0].text,before[0].text);
 assert.equal((await post('/api/task/history/rotate',{...ready,fields,summaryId:'wrong',confirm:true,requestId:randomUUID()})).status,409);
});
test('本体continue HTTP：確認後の本体変更を拒否し、copy/残件/子孫を保護',async()=>{
 const main=path.join(root,'System','GitFixture');fs.mkdirSync(main,{recursive:true});fs.writeFileSync(path.join(main,'base.txt'),'base');git.init(main);const p=store.createProject({name:'GitFixture',body:main}).project;
 const t=store.createTask(p.id,{title:'親',steps:['未済']}),w=git.prepare({base:main,workRoot:path.join(root,'Work',p.id),taskId:t.id});store.updateTask(p.id,t.id,{workdir:w.dir});fs.writeFileSync(path.join(w.dir,'new.txt'),'new');git.save(w.dir,'new');
 const b={project:p.id,task:t.id};const preview=await(await post('/api/task/merge/preview',b)).json();assert.equal(preview.cleanupBlocked,true);
 assert.equal((await post('/api/task/merge',{...b,disposition:'continue',confirm:true,sourceHead:preview.sourceHead,targetHead:'wrong'})).status,400);
 assert.equal((await post('/api/task/merge',{...b,disposition:'continue',confirm:true,sourceHead:'wrong',targetHead:preview.targetHead})).status,400);
 const r=await post('/api/task/merge',{...b,disposition:'continue',confirm:true,sourceHead:preview.sourceHead,targetHead:preview.targetHead});assert.equal(r.status,200,JSON.stringify(await r.clone().json()));assert.equal((await r.json()).retained,true);
 const kept=store.readTask(store.taskFile(p.id,t.id));assert.equal(kept.workdir,w.dir);assert.equal(kept.steps[0].done,false);assert.ok(fs.existsSync(w.dir));assert.equal(fs.readFileSync(path.join(main,'new.txt'),'utf8'),'new');
 assert.equal((await post('/api/task/merge',b)).status,400);
});

test('保持受領後は統合済みの予約で成果整理を妨げず、未完了の統合だけを止める',async()=>{
 const child=store.createTask(project.id,{title:'次の成果整理',parent:task.id,steps:['次の範囲の完了']});store.setStep(project.id,child.id,0,true);
 const file=path.join(root,'_hub/task-handoffs',createHash('sha256').update(project.id+'\0'+child.id).digest('hex')+'.json');fs.mkdirSync(path.dirname(file),{recursive:true});
 const receipt={schema:2,id:randomUUID(),project:project.id,task:child.id,title:child.title,integrating:'completed-retention',complete:true,retained:true,disposition:'continue',received:[],files:[]};
 const row=async()=>{const s=await(await fetch(base+'/api/state')).json();return s.projects.find(p=>p.id===project.id).tasks.find(t=>t.id===child.id);};
 fs.writeFileSync(file,JSON.stringify(receipt));const kept=await row();assert.ok(kept.resultsPending);assert.notEqual(kept.resultsPending.auto,'blocked');assert.doesNotMatch(kept.resultsPending.detail,/統合が進行中/);
 fs.writeFileSync(file,JSON.stringify({...receipt,complete:false}));const pending=await row();assert.equal(pending.resultsPending.auto,'blocked');assert.match(pending.resultsPending.detail,/統合が進行中/);fs.unlinkSync(file);
});

for(const status of ['pending','uncertain'])for(const sameID of [false,true])test('R3旧入口HTTP: '+status+'の'+(sameID?'同ID':'別ID')+'では両APIから切り替えない',async()=>{
 const t=store.createTask(project.id,{title:'未確認送信の保護'}),q=new URLSearchParams({project:project.id,task:t.id});chat.append(project.dir,t.id,{role:'user',text:'保護する原文'});
 const s=await(await fetch(base+'/api/task/history/status?'+q,{headers:{'X-Hub':'1'}})).json(),requestId=randomUUID();
 const recordFile=path.join(root,'_hub/task-history',createHash('sha256').update(project.id+'\0'+t.id).digest('hex')+'.json.continue');fs.mkdirSync(path.dirname(recordFile),{recursive:true});
 fs.writeFileSync(recordFile,JSON.stringify({requestId:sameID?requestId:randomUUID(),status,generation:s.generation,revision:s.revision}));
 const files=[store.taskFile(project.id,t.id),...Object.values(chat.files(project.dir,t.id)),recordFile];
 const snapshot=()=>files.map(file=>[file,fs.existsSync(file)?fs.readFileSync(file).toString('base64'):null]),before=snapshot();
 const input={task:t.id,...s,fields,confirm:true,requestId,fromContinue:true};
 const legacy=await post('/api/task/history/rotate',input);assert.equal(legacy.status,409);assert.match((await legacy.json()).error,/再送せず/);
 const current=await post('/api/task/continue',input),result=await current.json();assert.equal(current.status,sameID?200:409);if(sameID){assert.equal(result.duplicate,true);assert.equal(result.ok,false);assert.equal(result.rotate,status);}else assert.match(result.error,/再送せず/);
 assert.deepEqual(snapshot(),before);const after=await(await fetch(base+'/api/task/history/status?'+q,{headers:{'X-Hub':'1'}})).json();assert.equal(after.generation,s.generation);assert.equal(after.revision,s.revision);
 const recovery=await post('/api/task/continue/recover',{task:t.id,requestId:JSON.parse(fs.readFileSync(recordFile)).requestId,confirm:true});assert.equal(recovery.status,200);assert.equal((await recovery.json()).rotate,'failed');
 const next=await post('/api/task/continue',{task:t.id,...after,fields,confirm:true,requestId:randomUUID()});assert.equal(next.status,200);assert.equal((await next.json()).pending,true);assert.equal((await finished({task:t.id,requestId:(await(await fetch(base+'/api/task/continue/status?'+q,{headers:{'X-Hub':'1'}})).json()).requestId})).rotate,'ok');
});
test('R5旧入口HTTP: 完了後は両APIの新規切替を拒否し、同ID照合で完了承認を保持する',async()=>{
 const t=store.createTask(project.id,{title:'完了承認の保護'}),q=new URLSearchParams({project:project.id,task:t.id});store.appendSection(project.id,t.id,'成果','- なし：確認のみ');chat.append(project.dir,t.id,{role:'user',text:'最終原文'});
 const getStatus=async()=>await(await fetch(base+'/api/task/history/status?'+q,{headers:{'X-Hub':'1'}})).json();
 const input={task:t.id,...await getStatus(),fields,confirm:true,requestId:randomUUID()},r=await post('/api/task/continue',input);assert.equal(r.status,200);assert.equal((await r.json()).pending,true);const out=await finished(input);assert.equal(out.rotate,'ok');
 const approval=await post('/api/task/completion',{task:t.id,action:'approve',confirm:true,expectedHash:out.completionHash,generation:out.generation});assert.equal(approval.status,200);assert.equal((await approval.json()).state,'完了');
 const file=store.taskFile(project.id,t.id),before=fs.readFileSync(file),hash=store.readTask(file).completionHash,ready=await getStatus();
 for(const route of ['/api/task/history/rotate','/api/task/continue']){
  const fresh=await post(route,{task:t.id,...ready,fields,confirm:true,requestId:randomUUID()});assert.equal(fresh.status,409);assert.match((await fresh.json()).error,/再開してから要約/);
  const duplicate=await post(route,input);assert.equal(duplicate.status,200);const result=await duplicate.json();assert.equal(result.duplicate,true);assert.equal(result.generation,out.generation);
 }
 const state=await(await fetch(base+'/api/state')).json(),current=state.projects.find(p=>p.id===project.id).tasks.find(x=>x.id===t.id);
 assert.deepEqual(fs.readFileSync(file),before);assert.equal(current.state,'完了');assert.equal(current.completionHash,hash);assert.equal((await getStatus()).generation,out.generation);
});

test('本体開始token：確認checkbox無しで保持、HEAD変更と同じtokenの再送を拒否',async()=>{
 const main=path.join(root,'System','TokenFixture');fs.mkdirSync(main,{recursive:true});fs.writeFileSync(path.join(main,'base.txt'),'base');git.init(main);const p=store.createProject({name:'TokenFixture',body:main}).project;
 const t=store.createTask(p.id,{title:'親',steps:['残件を保持']}),w=git.prepare({base:main,workRoot:path.join(root,'Work',p.id),taskId:t.id});store.updateTask(p.id,t.id,{workdir:w.dir});fs.writeFileSync(path.join(w.dir,'new.txt'),'new');git.save(w.dir,'new');
 const b={project:p.id,task:t.id},preview=async()=>await(await post('/api/task/merge/preview',b)).json();
 let d=await preview();assert.ok(d.token);fs.writeFileSync(path.join(w.dir,'more.txt'),'more');git.save(w.dir,'changed');
 assert.equal((await post('/api/task/merge',{...b,token:d.token})).status,409);assert.equal(fs.existsSync(path.join(main,'new.txt')),false);
 d=await preview();fs.writeFileSync(path.join(main,'other.txt'),'other');git.save(main,'main changed');
 assert.equal((await post('/api/task/merge',{...b,token:d.token})).status,409);assert.equal(fs.existsSync(path.join(main,'new.txt')),false);
 d=await preview();const r=await post('/api/task/merge',{...b,token:d.token});assert.equal(r.status,200,JSON.stringify(await r.clone().json()));assert.equal((await r.json()).retained,true);
 assert.equal((await post('/api/task/merge',{...b,token:d.token})).status,409);assert.ok(fs.existsSync(w.dir));const kept=store.readTask(store.taskFile(p.id,t.id));assert.equal(kept.workdir,w.dir);assert.equal(kept.steps[0].done,false);
});
