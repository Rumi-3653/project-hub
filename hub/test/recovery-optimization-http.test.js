'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{execFileSync}=require('node:child_process');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'hub-recovery-http-')),root=path.join(tmp,'root'),home=path.join(tmp,'home');fs.mkdirSync(home);fs.mkdirSync(path.join(root,'_hub'),{recursive:true});fs.copyFileSync(path.join(__dirname,'../../docs/project-hub/templates/_hub/roles.yaml'),path.join(root,'_hub/roles.yaml'));
Object.assign(process.env,{HUB_ROOT:root,HOME:home,HUB_FREETALK_HOME:home,HUB_DRY_RUN:'1',HUB_PORT:String(54000+Math.floor(Math.random()*900))});
const {Store}=require('../lib/store'),git=require('../lib/git'),{TaskIntegrate}=require('../lib/task-integrate'),{TaskTransfer}=require('../lib/task-transfer'),{Removal}=require('../lib/remove'),{IntegrateAuto}=require('../lib/integrate-auto');
const store=new Store(root),p=store.createProject({name:'Fixture'}).project,parent=store.createTask(p.id,{title:'親'});
const body=path.join(root,'Body'),g=(dir,...args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8',stdio:'pipe'}).trim();fs.mkdirSync(body);g(body,'init','-q');g(body,'config','user.name','Fixture');g(body,'config','user.email','fixture@localhost');fs.writeFileSync(path.join(body,'base'),'base');g(body,'add','.');g(body,'commit','-qm','base');
fs.appendFileSync(path.join(p.dir,'PROJECT.md'),'- 測定用の長いメモ。原文は保管します。\n'.repeat(4000));
const w=git.prepare({base:body,workRoot:path.join(root,'Work',p.id),taskId:parent.id});store.updateTask(p.id,parent.id,{workdir:w.dir,continuation:true});
const {server}=require('../server');let base;
test.before(async()=>{await new Promise(r=>server.listen(Number(process.env.HUB_PORT),'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;});
test.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(tmp,{recursive:true,force:true});});
const get=route=>fetch(base+route,{headers:{'X-Hub':'1'}}),post=(route,b)=>fetch(base+route,{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json'},body:JSON.stringify({project:p.id,...b})});
test('一覧はメモ全文を送らずhash変更を検出、全文APIとETagを保つ',async()=>{
 const response=await get('/api/state'),etag=response.headers.get('etag'),s=await response.json(),row=s.projects.find(x=>x.id===p.id);assert.equal(row.notes,undefined);assert.ok(row.notesBytes>176000);assert.ok(row.notesSummary.length<=240);assert.equal((await fetch(base+'/api/state',{headers:{'X-Hub':'1','If-None-Match':etag}})).status,304);
 const full=await get('/api/project/notes?project='+p.id),tag=full.headers.get('etag'),n=await full.json();assert.equal(n.hash,row.notesHash);assert.equal(n.notes,store.readProject(p.id).notes);assert.equal((await fetch(base+'/api/project/notes?project='+p.id,{headers:{'X-Hub':'1','If-None-Match':tag}})).status,304);
 fs.appendFileSync(path.join(p.dir,'PROJECT.md'),'\n新しい末尾\n');const next=await (await get('/api/state')).json();assert.notEqual(next.projects.find(x=>x.id===p.id).notesHash,row.notesHash);assert.equal((await get('/api/project/notes?project=unknown')).status,404);
});
test('本体と同じコピーの正式mergeは二度押してもcommit・作業・会話・操作記録を作らない',async()=>{
 assert.equal((await (await get('/api/task/preview?project='+p.id+'&task='+parent.id)).json()).noChanges,true);
 // Match the reported case: the main merge commit is ahead of its retained source copy.
 fs.writeFileSync(path.join(w.dir,'received-feature'),'保存済みの成果');git.save(w.dir,'saved feature');
 assert.ok(git.merge({dir:w.dir,workRoot:path.join(root,'Work',p.id),title:'保持受領',cleanup:false}).ok);
 assert.notEqual(g(body,'rev-parse','HEAD'),g(w.dir,'rev-parse','HEAD'));assert.equal(git.isAncestor(w.dir,g(body,'rev-parse','HEAD')),false);
 const preview=await (await get('/api/task/preview?project='+p.id+'&task='+parent.id)).json();assert.equal(preview.files,0);assert.equal(preview.noChanges,true);
 const file=store.taskFile(p.id,parent.id),raw=fs.readFileSync(file),head=g(body,'rev-parse','HEAD');
 const log=async()=>await (await get('/api/log')).json(),before=JSON.stringify(await log());
 for(let i=0;i<2;i++){const d=await (await post('/api/task/merge/preview',{task:parent.id})).json(),out=await post('/api/task/merge',{task:parent.id,token:d.token});assert.equal(out.status,200);assert.equal((await out.json()).noChanges,true);}
 assert.equal(g(body,'rev-parse','HEAD'),head);assert.deepEqual(fs.readFileSync(file),raw);assert.equal(JSON.stringify(await log()),before);assert.ok(fs.existsSync(w.dir));
 fs.writeFileSync(path.join(w.dir,'unsaved'),'dirty');assert.equal((await (await get('/api/task/preview?project='+p.id+'&task='+parent.id)).json()).noChanges,false);assert.equal((await post('/api/task/merge/preview',{task:parent.id})).status,409);fs.unlinkSync(path.join(w.dir,'unsaved'));
});
test('正式resume APIは履歴を残してthenMain:false、再送を拒否し本体HEADを保持',async()=>{
 const removal=new Removal({store}),transfer=new TaskTransfer({store,removal,baseOf:()=>body}),integrate=new TaskIntegrate({store,transfer,removal,baseOf:()=>body});
 const child=store.createTask(p.id,{title:'子',parent:parent.id,steps:['完成']});store.setStep(p.id,child.id,0,true);store.appendSection(p.id,child.id,'成果','- なし：ファイル成果なし');const cw=git.prepare({base:body,workRoot:removal.workRoot(p),taskId:child.id});store.updateTask(p.id,child.id,{workdir:cw.dir});fs.writeFileSync(path.join(cw.dir,'child'),'成果');git.save(cw.dir,'child');
 const d=integrate.preview(p.id,parent.id);integrate.apply({project:p.id,task:parent.id,token:d.token,auto:true,thenMain:true,confirm:true,selected:d.items.map(i=>({project:i.project,task:i.task,disposition:'continue'}))});
 new IntegrateAuto({integrate}).stop(p.id,parent.id,'Fixture停止');const beforeHead=g(body,'rev-parse','HEAD'),old=integrate.read(p.id,parent.id);
 const preview=await post('/api/task/integrate/preview',{task:parent.id}),v=await preview.json();assert.equal(preview.status,200);const response=await post('/api/task/integrate/resume',{task:parent.id,token:v.token});assert.equal(response.status,200);assert.equal((await response.json()).thenMain,false);
 const r=integrate.read(p.id,parent.id);assert.equal(r.auto.thenMain,false);assert.deepEqual(r.auto.stopHistory,[old.auto.stopped]);assert.equal(r.auto.resumed.length,1);assert.equal(g(body,'rev-parse','HEAD'),beforeHead);assert.equal((await post('/api/task/integrate/resume',{task:parent.id,token:v.token})).status,409);
});
test('正式保管APIはpreview時に原文不変、確認後だけ原文を保管し重複を拒否',async()=>{
 const file=path.join(p.dir,'PROJECT.md'),latest='- 2026-10-09 最新の成果\n',oldest='- 2026-09-26 最古の成果\n';fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('# メモ\n','# メモ\n'+latest)+oldest);
 const before=fs.readFileSync(file),preview=await post('/api/project/notes/archive/preview',{keepLines:200}),d=await preview.json();assert.equal(preview.status,200);assert.ok(d.token,JSON.stringify(d));assert.equal(d.order,'newest-first');assert.deepEqual(fs.readFileSync(file),before);
 const out=await post('/api/project/notes/archive',{token:d.token,confirm:true});const r=await out.json();assert.equal(out.status,200,JSON.stringify(r));const archive=fs.readFileSync(path.join(p.dir,r.archive),'utf8'),current=fs.readFileSync(file,'utf8');assert.ok(archive.includes('測定用の長いメモ'));assert.ok(current.includes(latest));assert.equal(archive.includes(latest),false);assert.ok(archive.endsWith(oldest));assert.equal(current.includes(oldest),false);assert.ok(fs.readFileSync(file).length<before.length);assert.equal((await post('/api/project/notes/archive',{token:d.token,confirm:true})).status,409);
 const again=await (await post('/api/project/notes/archive/preview',{keepLines:200})).json();assert.equal(again.noChanges,true);assert.equal(fs.readFileSync(file,'utf8'),current);assert.equal(fs.readFileSync(path.join(p.dir,r.archive),'utf8'),archive);
});
