'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Store}=require('../lib/store'),git=require('../lib/git'),chat=require('../lib/chat');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'hub-retained-http-')),root=path.join(tmp,'root'),home=path.join(tmp,'home');
fs.mkdirSync(home);fs.mkdirSync(path.join(root,'_hub'),{recursive:true});
fs.copyFileSync(path.join(__dirname,'../../docs/project-hub/templates/_hub/roles.yaml'),path.join(root,'_hub/roles.yaml'));
Object.assign(process.env,{HUB_ROOT:root,HOME:home,HUB_FREETALK_HOME:home,HUB_DRY_RUN:'1',HUB_TRASH:path.join(tmp,'Trash'),HUB_PORT:String(43000+Math.floor(Math.random()*1000))});
const main=path.join(root,'System','Fixture');fs.mkdirSync(main,{recursive:true});fs.writeFileSync(path.join(main,'base.txt'),'base');git.init(main);
const store=new Store(root),p=store.createProject({name:'Fixture',body:main}).project,parent=store.createTask(p.id,{title:'親'});
const pw=git.prepare({base:main,workRoot:path.join(root,'Work',p.id),taskId:parent.id});store.updateTask(p.id,parent.id,{workdir:pw.dir});
const c=store.createTask(p.id,{title:'旧完了子',parent:parent.id,steps:['完成']});store.setStep(p.id,c.id,0,true);
const cw=git.prepare({base:main,workRoot:path.join(root,'Work',p.id),taskId:c.id});store.updateTask(p.id,c.id,{workdir:cw.dir});fs.writeFileSync(path.join(cw.dir,'code.txt'),'code');git.save(cw.dir,'child');
store.appendSection(p.id,c.id,'成果','- なし：保存済みコードが成果。独立確認済み。');
const {server}=require('../server');let base;
const post=async(route,data={})=>{const r=await fetch(base+route,{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json'},body:JSON.stringify({project:p.id,task:parent.id,...data})});const body=await r.json();assert.equal(r.status,200,JSON.stringify(body));return body;};
const preview=()=>post('/api/task/integrate/preview');
const state=async()=>await(await fetch(base+'/api/state',{headers:{'X-Hub':'1'}})).json();
test.before(async()=>{await new Promise(r=>server.listen(Number(process.env.HUB_PORT),'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;});
test.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(tmp,{recursive:true,force:true});});
test('正式HTTP/Git：受領→通知消失→追加成果→再表示→旧完了子整理、一度の操作で保護',async()=>{
 let d=await preview();assert.equal(d.items.length,1);
 const b={token:d.token,confirm:true,auto:true,thenMain:false,selected:[{project:p.id,task:c.id,disposition:'continue'}]};
 assert.equal((await post('/api/task/integrate',b)).complete,true);
 const offers=async(expected)=>{for(let n=0;n<100;n++){const rows=(await state()).taskOffers.filter(x=>x.task===c.id&&x.targetTask===parent.id);if(expected===undefined||rows[0]?.pending===expected)return rows;await new Promise(r=>setTimeout(r,20));}assert.fail('receipt projection did not settle');};
 d=await preview();assert.equal((await offers(false))[0].pending,false,JSON.stringify(d));assert.equal(d.items.length,0);assert.equal(d.retainedItems.length,1);
 const rows=chat.read(p.dir,parent.id),mainHead=git.inspect(main).head;
 assert.equal((await post('/api/task/integrate',{token:d.token,confirm:true,auto:true,selected:[]})).noChanges,true);assert.deepEqual(chat.read(p.dir,parent.id),rows);assert.equal(git.inspect(main).head,mainHead);
 fs.writeFileSync(path.join(cw.dir,'extra.txt'),'extra');git.save(cw.dir,'extra');assert.equal((await offers())[0].pending,true);
 d=await preview();assert.equal((await post('/api/task/integrate',{...b,token:d.token})).complete,true);assert.equal((await offers(false))[0].pending,false);
 assert.equal(fs.readFileSync(path.join(pw.dir,'extra.txt'),'utf8'),'extra');
 d=await preview();const cleanup={token:d.token,confirm:true,auto:true,thenMain:true,selected:[{project:p.id,task:c.id,disposition:'cleanup',cleanupAudit:{items:'なし',undecided:'なし',evidence:'独立確認と成果保存・本文を照合し残件がないことを確認'}}]};
 const out=await post('/api/task/integrate',cleanup);assert.equal(out.complete,true);const record=JSON.parse(fs.readFileSync(path.join(root,'_hub/task-integrations',require('node:crypto').createHash('sha256').update(p.id+'\0'+parent.id).digest('hex')+'.json')));assert.equal(record.auto.thenMain,false);
 assert.equal((await post('/api/task/integrate',cleanup)).duplicate,true);assert.equal(store.taskFile(p.id,c.id),null);assert.equal(fs.existsSync(cw.dir),false);
 assert.ok(store.taskFile(p.id,parent.id));assert.ok(fs.existsSync(pw.dir));assert.equal(git.inspect(main).head,mainHead);assert.equal((await offers()).length,0);
});

test('正式HTTP：型違い・要素・受領先・非JSONの破損を隔離し正常子と原物を保持',async()=>{
 const bad=store.createTask(p.id,{title:'破損子',parent:parent.id,steps:['完成']}),good=store.createTask(p.id,{title:'正常子',parent:parent.id,steps:['完成']});
 for(const child of [bad,good]){store.setStep(p.id,child.id,0,true);store.appendSection(p.id,child.id,'成果','- なし：保存成果を確認済み');}
 const d=await preview();assert.equal((await post('/api/task/integrate',{token:d.token,confirm:true,auto:true,thenMain:false,selected:[bad,good].map(x=>({project:p.id,task:x.id,disposition:'continue'}))})).complete,true);
 const fileOf=child=>path.join(root,'_hub/task-handoffs',require('node:crypto').createHash('sha256').update(p.id+'\0'+child.id).digest('hex')+'.json');
 const file=fileOf(bad),original=fs.readFileSync(file,'utf8'),normal=fs.readFileSync(fileOf(good),'utf8'),messages=chat.read(p.dir,parent.id),mainHead=git.inspect(main).head;
 const patches=[{received:{}},{received:'bad'},{received:null},{received:1},{received:false},{received:[null]},{received:[{}]},{received:[{target:null}]},{received:[{target:'bad'}]},{received:[{target:{project:1,task:parent.id}}]},{received:[{target:{project:p.id,task:''}}]},{received:[{target:{project:p.id,task:parent.id,dir:{}}}]}];
 for(const raw of [...patches.map(patch=>JSON.stringify({...JSON.parse(original),...patch})),'broken']){
  fs.writeFileSync(file,raw);
  let body;for(let n=0;n<100;n++){const res=await fetch(base+'/api/state',{headers:{'X-Hub':'1'}});body=await res.json();assert.equal(res.status,200,JSON.stringify(body));if(body.taskOffers.find(x=>x.task===good.id&&x.targetTask===parent.id)?.pending===false)break;await new Promise(r=>setTimeout(r,20));}assert.ok(Array.isArray(body.projects));
  const broken=body.taskOffers.find(x=>x.task===bad.id&&x.targetTask===parent.id),ok=body.taskOffers.find(x=>x.task===good.id&&x.targetTask===parent.id);
  assert.equal(broken.pending,true);assert.equal(broken.received,null);assert.ok(broken.reason);assert.equal(ok.pending,false);assert.ok(ok.received);
  const denied=await fetch(base+'/api/task/integrate/preview',{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json'},body:JSON.stringify({project:p.id,task:parent.id})});assert.equal(denied.status,409);assert.ok((await denied.json()).error);
  assert.equal(fs.readFileSync(file,'utf8'),raw);assert.equal(fs.readFileSync(fileOf(good),'utf8'),normal);assert.deepEqual(chat.read(p.dir,parent.id),messages);assert.equal(git.inspect(main).head,mainHead);assert.ok(store.taskFile(p.id,bad.id));
 }
 fs.writeFileSync(file,original);assert.equal((await preview()).items.length,0);let settled;for(let i=0;i<100;i++){settled=(await state()).taskOffers.find(x=>x.task===bad.id&&x.targetTask===parent.id);if(!settled.pending)break;await new Promise(r=>setTimeout(r,20));}assert.equal(settled.pending,false);
});
