'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{execFileSync}=require('node:child_process'),{randomUUID,createHash}=require('node:crypto');
const {Store}=require('../lib/store'),{Removal}=require('../lib/remove'),{TaskTransfer}=require('../lib/task-transfer'),{TaskIntegrate}=require('../lib/task-integrate'),{IntegrateAuto}=require('../lib/integrate-auto'),git=require('../lib/git'),chat=require('../lib/chat'),sibling=require('../lib/integration-sibling'),close=require('../lib/integration-consultation-close'),hold=require('../lib/task-future-hold');
const hash=x=>createHash('sha256').update(x).digest('hex'),g=(d,...a)=>execFileSync('git',['-C',d,...a],{encoding:'utf8',stdio:'pipe'}).trim();
async function fixture(t,{productDelta=false}={}){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-consultation-')),oldTrash=process.env.HUB_TRASH;process.env.HUB_TRASH=path.join(root,'Trash');
 t.after(()=>{if(oldTrash===undefined)delete process.env.HUB_TRASH;else process.env.HUB_TRASH=oldTrash;fs.rmSync(root,{recursive:true,force:true});});
 const dir=path.join(root,'Product','Fixture'),body=path.join(root,'Body'),write=(f,s)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,s);};
 write(path.join(dir,'PROJECT.md'),'---\nname: Fixture\nfolders:\n  本体: '+body+'\n---\n');write(path.join(body,'.gitignore'),'.ai/work/\n');write(path.join(body,'base'),'base');g(body,'init','-q');g(body,'config','user.name','Fixture');g(body,'config','user.email','fixture@localhost');g(body,'add','.');g(body,'commit','-qm','base');
 const store=new Store(root),parent=store.createTask('Fixture',{title:'親',steps:['未済']}),removal=new Removal({store,trash:path.join(root,'Trash')}),transfer=new TaskTransfer({store,removal,baseOf:()=>body}),h=new TaskIntegrate({store,transfer,removal,baseOf:()=>body});
 const copy=git.prepare({base:body,workRoot:removal.workRoot({id:'Fixture'}),taskId:parent.id}).dir;store.updateTask('Fixture',parent.id,{workdir:copy});
 const web=store.createTask('Fixture',{title:'Web相談',parent:parent.id,steps:[]}),wc=git.prepare({base:body,workRoot:removal.workRoot({id:'Fixture'}),taskId:web.id}).dir;store.updateTask('Fixture',web.id,{workdir:wc});if(productDelta){write(path.join(wc,'product.js'),'product change');g(wc,'add','.');}g(wc,'commit','--allow-empty','-qm','consultation only');const sourceHead=git.inspect(wc).head,previousTargetHead=git.inspect(copy).head;g(copy,'merge','--no-ff','-qm','empty consultation',sourceHead);const merge=git.inspect(copy).head;g(body,'merge','--ff-only',sourceHead);
 store.appendSection('Fixture',web.id,'成果','- なし：相談だけ。比較と原文はこの作業ファイル');store.appendSection('Fixture',web.id,'残件申告','```json\n'+JSON.stringify({status:'なし',items:'なし',undecided:'なし',evidence:'相談完了'})+'\n```');chat.append(dir,web.id,{role:'user',text:'比較の原文'});chat.append(dir,web.id,{role:'assistant',text:'WebとPCの比較結果'});
 const requests=[],closed=new Map();let mains=0;const auto=new IntegrateAuto({integrate:h,dispatch:async q=>{requests.push(q);return {delivery:{state:'accepted'}};},mergeMain:async()=>{mains++;throw Error('must not merge main');}});auto.pendingRequest=(r,k)=>!closed.has(k);auto.savedCompletion=(r,k)=>closed.get(k);h.consultationWait=()=>[];
 const k=hash('old review'),request=randomUUID(),id=randomUUID();const old={id,schemaVersion:2,project:'Fixture',task:parent.id,target:copy,complete:false,items:[{project:'Fixture',task:web.id,title:web.title,copy:wc,sourceHead,keep:true,disposition:'continue',files:[],selected:[],results:[{kind:'なし',value:'相談だけ'}],preview:{paths:[]},integrated:{dir:copy,previousTargetHead,commit:merge,files:[]},state:'検証中'}],auto:{mode:'single',prepared:true,thenMain:true,order:{state:'none'},migrations:{},targetHead:merge,stopped:{reason:'旧確認は合格していない'},attempts:{[k]:{phase:'review',request:{text:`[integration-auto:${k}:review]`},delivery:{state:'accepted',request}}}}};
 closed.set(k,{request,text:'合格なし',integrationAuto:{key:k,phase:'review',closed:true}});h.save(old);transfer.save({id:randomUUID(),project:'Fixture',task:web.id,integrating:id});
 const report=store.createTask('Fixture',{title:'Windows報告',parent:parent.id,steps:['実機残り']}),rc=git.prepare({base:body,workRoot:removal.workRoot({id:'Fixture'}),taskId:report.id}).dir;store.updateTask('Fixture',report.id,{workdir:rc});write(path.join(rc,'成果物',report.id,'report.md'),'Windows警告は安全未判定');git.save(rc,'report');store.appendSection('Fixture',report.id,'成果','- 本体保存済み：body:.@'+git.inspect(rc).head);store.appendSection('Fixture',report.id,'残件申告','```json\n'+JSON.stringify({status:'あり',items:'安全未判定',undecided:'なし',evidence:'報告保存'})+'\n```');
 const d=auto.preview({project:'Fixture',task:parent.id,simple:true,sibling:true});h.apply({project:'Fixture',task:parent.id,token:d.token,confirm:true,auto:true,thenMain:false,mode:'single',selected:[{project:'Fixture',task:report.id,keep:true}]});await auto.tick();let side=sibling.read(h,'Fixture',parent.id);assert.equal(side.items[0].state,'検証中',JSON.stringify(side.auto.stopped));
 const q=requests.at(-1),key=q.review.key,row={request:q.requestKey,text:`[integration-review:${key}:pass]`,integrationAuto:{key,phase:'review',closed:true,isolation:{version:1,resumed:false,request:q.requestKey}}};closed.set(key,row);auto.settled(q,row);await auto.tick();side=sibling.read(h,'Fixture',parent.id);assert.equal(side.complete,true,JSON.stringify(side.auto.stopped));
 const hf=hold.file(root,'Fixture',web.id);write(hf,JSON.stringify({version:1,project:'Fixture',task:web.id,held:true,revision:randomUUID(),history:[{before:false,held:true}]}));fs.chmodSync(hf,0o600);
 const b={project:'Fixture',task:parent.id,childProject:'Fixture',childTask:web.id},original=fs.readFileSync(h.file('Fixture',parent.id)),sideBytes=fs.readFileSync(sibling.file(h,'Fixture',parent.id)),winOffer=fs.readFileSync(transfer.file('Fixture',report.id));
 const plan=()=>close.preview(h,b),approval=p=>{const f=path.join(copy,'.ai/work/review.json');write(f,JSON.stringify({verdict:'pass',scope:p.scope,codeInputs:p.codeInputs}));return {...b,token:p.token,confirm:true,authorization:'本人が相談の統合と片付けを承認',reviewFile:f,reviewSHA:hash(fs.readFileSync(f))};};
 return {root,dir,body,store,parent,web,wc,report,rc,copy,h,auto,closed,requests,transfer,removal,old,b,original,sideBytes,winOffer,hf,write,plan,approval,mains:()=>mains};
}
test('empty consultation formally closes without a pass or main merge; preserved originals and reversible trash',async t=>{
 const f=await fixture(t),p=f.plan(),a=f.approval(p),before=close.inventory(f.wc);assert.match(f.h.historyBlocker('Fixture',f.parent.id),/統合/);
 const out=close.apply(f.h,a);assert.equal(out.complete,true);assert.equal(out.mainApplied,false);assert.equal(f.mains(),0);assert.equal(f.h.historyBlocker('Fixture',f.parent.id),'');assert.equal(f.h.pending().length,0);assert.equal(fs.existsSync(f.wc),false);assert.equal(fs.existsSync(f.store.taskFile('Fixture',f.web.id)),false);assert.ok(fs.existsSync(f.rc));
 const r=close.read(f.h,'Fixture',f.parent.id);assert.equal(r.stage,'complete');const oldFile=r.originals.find(x=>x.kind==='primary').file;assert.deepEqual(fs.readFileSync(oldFile),f.original);assert.equal(JSON.parse(fs.readFileSync(oldFile)).complete,false);assert.equal(JSON.parse(fs.readFileSync(oldFile)).items[0].receipt,undefined);assert.deepEqual(fs.readFileSync(r.originals.find(x=>x.kind==='sibling').file),f.sideBytes);assert.deepEqual(fs.readFileSync(f.transfer.file('Fixture',f.report.id)),f.winOffer);
 const preserved=r.manifest.find(x=>x.from===f.wc);assert.deepEqual(close.inventory(preserved.to),before);assert.equal(hold.read(f.root,'Fixture',f.web.id).futureHold,false);assert.equal(f.transfer.read('Fixture',f.web.id).consultationClosure,r.id);assert.equal(f.transfer.read('Fixture',f.web.id).mainApplied,false);
 const record=JSON.parse(fs.readFileSync(path.join(f.removal.records,r.removal.record+'.json')));assert.ok(record.entries.every(e=>e.moved&&!fs.existsSync(e.from)&&fs.existsSync(e.to)));assert.throws(()=>close.apply(f.h,a));assert.throws(()=>f.h.save(f.old),/相談終了/);assert.throws(()=>f.transfer.continue(JSON.parse(fs.readFileSync(r.originals.find(x=>x.kind==='offer').file))),/相談終了/);await f.auto.tick();assert.equal(f.requests.length,1);
 const oldRequest=Object.values(f.old.auto.attempts)[0].delivery.request;assert.ok(sibling.requestRecords(f.h,{project:'Fixture',task:f.parent.id,request:oldRequest}).some(r=>r.id===f.old.id));assert.throws(()=>sibling.assert(f.h,f.h.read('Fixture',f.parent.id,f.old.id)),/相談終了/);
 const next=f.store.createTask('Fixture',{title:'次の子',parent:f.parent.id});f.transfer.save({id:randomUUID(),project:'Fixture',task:next.id});assert.equal(f.transfer.read('Fixture',next.id).task,next.id);
});
for(const kind of ['busy','target','source','offer','hold','sibling','review-scope','review-code','review-sha'])test('CAS or approval change refuses before a closure journal or move: '+kind,async t=>{
 const f=await fixture(t),p=f.plan(),a=f.approval(p);
 if(kind==='busy')f.h.consultationWait=()=>[{kind:'execution',message:'実行中'}];
 if(kind==='target')g(f.copy,'commit','--allow-empty','-qm','parent changed');
 if(kind==='source')g(f.wc,'commit','--allow-empty','-qm','source changed');
 if(kind==='offer'){const r=f.transfer.read('Fixture',f.web.id);r.note='changed';f.transfer.save(r);}
 if(kind==='hold'){const r=JSON.parse(fs.readFileSync(f.hf));r.held=false;f.write(f.hf,JSON.stringify(r));}
 if(kind==='sibling')fs.appendFileSync(sibling.file(f.h,'Fixture',f.parent.id),'\n');
 if(kind.startsWith('review-')){const r=JSON.parse(fs.readFileSync(a.reviewFile));if(kind==='review-scope')r.scope.primarySHA='0'.repeat(64);if(kind==='review-code')r.codeInputs={};f.write(a.reviewFile,JSON.stringify(r));if(kind!=='review-sha')a.reviewSHA=hash(fs.readFileSync(a.reviewFile));else a.reviewSHA='0'.repeat(64);}
 assert.throws(()=>close.apply(f.h,a));assert.equal(close.read(f.h,'Fixture',f.parent.id),null);assert.ok(fs.existsSync(f.wc));assert.ok(fs.existsSync(f.store.taskFile('Fixture',f.web.id)));assert.deepEqual(fs.readFileSync(f.h.file('Fixture',f.parent.id)),f.original);assert.equal(f.mains(),0);
});
test('unknown main intent, unfinished declarations and preserved links cannot use consultation closure',async t=>{
 const f=await fixture(t),r=JSON.parse(f.original);
 r.auto.main={state:'intent'};f.write(f.h.file('Fixture',f.parent.id),JSON.stringify(r));assert.throws(f.plan);f.write(f.h.file('Fixture',f.parent.id),f.original);
 const task=f.store.taskFile('Fixture',f.web.id),taskBytes=fs.readFileSync(task);fs.appendFileSync(task,'\n## 残件申告\n```json\n{"status":"あり","items":"未完了","undecided":"なし","evidence":"追加"}\n```\n');assert.throws(f.plan);f.write(task,taskBytes);
 const own=path.join(f.dir,'.ai/work',f.web.id);f.write(path.join(own,'original.txt'),'原本');fs.symlinkSync('original.txt',path.join(own,'alias'));assert.throws(f.plan);fs.unlinkSync(path.join(own,'alias'));fs.linkSync(path.join(own,'original.txt'),path.join(own,'hard'));assert.throws(f.plan);
});
test('a real product delta in the old merge is rejected even when all original pins and declarations agree',async t=>{
 const f=await fixture(t,{productDelta:true});assert.deepEqual(git.changedBetween(f.copy,f.old.items[0].integrated.previousTargetHead,f.old.items[0].integrated.commit),['product.js']);assert.throws(f.plan,/空差分/);assert.deepEqual(fs.readFileSync(f.h.file('Fixture',f.parent.id)),f.original);assert.ok(fs.existsSync(f.wc));
});
test('a partial trash retains all originals and blocks retries, stale saves, late completion and automatic dispatch',async t=>{
 const f=await fixture(t),p=f.plan(),a=f.approval(p),move=f.removal.moveEntry;let calls=0;
 f.removal.moveEntry=function(...v){if(++calls===2)throw Error('synthetic second move failure');return move.apply(this,v);};
 assert.throws(()=>close.apply(f.h,a),/途中/);const r=close.read(f.h,'Fixture',f.parent.id);assert.equal(r.stage,'trash-intent');assert.equal(r.removal.ok,false);assert.ok(r.manifest.length);assert.ok(fs.existsSync(sibling.file(f.h,'Fixture',f.parent.id)+'.lock'));assert.match(f.h.historyBlocker('Fixture',f.parent.id),/統合/);
 assert.throws(()=>close.apply(f.h,a));assert.throws(()=>close.finish(f.h,{...a,id:r.id}));assert.throws(()=>f.h.save(f.old),/相談終了/);assert.throws(()=>f.transfer.finishRetention({project:'Fixture',task:f.web.id}),/相談終了/);const q=Object.values(f.old.auto.attempts)[0].request;f.auto.settled({...f.b,text:q.text},{text:'遅延した合格'});await f.auto.tick();assert.equal(f.requests.length,1);assert.deepEqual(fs.readFileSync(f.h.file('Fixture',f.parent.id)),f.original);assert.deepEqual(fs.readFileSync(sibling.file(f.h,'Fixture',f.parent.id)),f.sideBytes);assert.equal(f.mains(),0);
 f.removal.moveEntry=move;const restored=f.removal.restore(r.removal.record,true);assert.equal(restored.ok,true);assert.ok(fs.existsSync(f.wc));assert.ok(fs.existsSync(f.store.taskFile('Fixture',f.web.id)));assert.equal(close.status(f.h,f.b).complete,false);
});
test('after all moves, interrupted retirement can explicitly finish once without another move or review rewrite',async t=>{
 const f=await fixture(t),p=f.plan(),a=f.approval(p),io=require('../lib/platform/file-io'),rename=io.renameSync;let fail=true;
 io.renameSync=(from,to)=>{if(fail&&from===sibling.file(f.h,'Fixture',f.parent.id)){fail=false;throw Error('synthetic retirement failure');}return rename(from,to);};
 try{assert.throws(()=>close.apply(f.h,a),/retirement failure/);}finally{io.renameSync=rename;}
 const r=close.read(f.h,'Fixture',f.parent.id);assert.equal(r.stage,'trashed');assert.equal(r.removal.ok,true);assert.match(f.h.historyBlocker('Fixture',f.parent.id),/統合/);assert.equal(fs.existsSync(f.wc),false);
 f.removal.transfer=()=>{throw Error('must never move twice');};const finish={...a,id:r.id};const lock=path.join(f.h.dir,'consultation-closures',path.basename(f.h.file('Fixture',f.parent.id)))+'.finish.lock';f.write(lock,r.id);assert.throws(()=>close.finish(f.h,finish),/EEXIST/);fs.unlinkSync(lock);
 assert.equal(close.finish(f.h,finish).complete,true);assert.equal(close.finish(f.h,finish).complete,true);assert.equal(f.h.historyBlocker('Fixture',f.parent.id),'');assert.deepEqual(fs.readFileSync(r.originals.find(x=>x.kind==='sibling').file),f.sideBytes);assert.equal(f.mains(),0);
});
test('failed preservation makes no moves and never overwrites partial output',async t=>{
 const f=await fixture(t),p=f.plan(),a=f.approval(p),io=require('../lib/platform/file-io'),cp=io.copyFileSync;
 io.copyFileSync=()=>{throw Error('synthetic preservation failure');};try{assert.throws(()=>close.apply(f.h,a),/preservation failure/);}finally{io.copyFileSync=cp;}
 const r=close.read(f.h,'Fixture',f.parent.id);assert.equal(r.stage,'intent');assert.ok(fs.existsSync(f.wc));assert.throws(()=>close.apply(f.h,a));assert.throws(()=>close.finish(f.h,{...a,id:r.id}));assert.deepEqual(fs.readFileSync(f.h.file('Fixture',f.parent.id)),f.original);assert.deepEqual(fs.readFileSync(sibling.file(f.h,'Fixture',f.parent.id)),f.sideBytes);
});
test('HTTP closure operations are explicit POSTs and use the scoped handler',async t=>{
 const f=await fixture(t);let status,body;const routes=require('../lib/routes/task-integration')({taskIntegrate:f.h,send:(res,s,b)=>{status=s;body=b;}}),r=routes.consultationClose,url=new URL('http://127.0.0.1/api/task/integrate/consultation-close/status');assert.equal(r.matches({method:'GET'},url),false);assert.equal(r.matches({method:'POST'},url),true);r.handle({},null,url,f.b);assert.equal(status,200);assert.equal(body.stage,'not-started');r.handle({},null,new URL('http://127.0.0.1/api/task/integrate/consultation-close/apply'),{...f.b,confirm:true});assert.equal(status,409);assert.equal(close.read(f.h,'Fixture',f.parent.id),null);
});

// Only these R1 cases are selected for the follow-up; the original scenarios
// remain as saved evidence and are not repeated by this change's targeted run.
function otherPublisher(f, row) {
 const script=`const {TaskTransfer}=require(process.argv[1]);const t=new TaskTransfer({store:{root:process.argv[2]},removal:null});try{t.save(JSON.parse(process.argv[3]));console.log(JSON.stringify({saved:true}));}catch(e){console.log(JSON.stringify({saved:false,code:e.code,message:e.message}));}`;
 return JSON.parse(execFileSync(process.execPath,['-e',script,require.resolve('../lib/task-transfer'),f.root,JSON.stringify(row)],{encoding:'utf8',stdio:'pipe'}));
}
test('R1 delayed legacy rename excludes closure; changed offer pins fail closed',async t=>{
 const f=await fixture(t),p=f.plan(),a=f.approval(p),io=require('../lib/platform/file-io'),rename=io.renameSync,offer=f.transfer.file('Fixture',f.web.id),old=f.transfer.read('Fixture',f.web.id);let blocked=false;
 io.renameSync=(from,to)=>{if(from===offer+'.tmp'&&to===offer){assert.throws(()=>close.apply(f.h,a),{code:'EEXIST'});blocked=true;assert.equal(close.read(f.h,'Fixture',f.parent.id),null);assert.ok(fs.existsSync(f.wc));}return rename(from,to);};
 try{f.transfer.save({...old,note:'newer saved offer'});}finally{io.renameSync=rename;}
 assert.equal(blocked,true);assert.equal(f.transfer.read('Fixture',f.web.id).note,'newer saved offer');assert.deepEqual(fs.readFileSync(f.h.file('Fixture',f.parent.id)),f.original);assert.deepEqual(fs.readFileSync(f.transfer.file('Fixture',f.report.id)),f.winOffer);
 assert.equal(fs.existsSync(sibling.file(f.h,'Fixture',f.parent.id)+'.lock'),false);assert.throws(()=>close.apply(f.h,a),/停止記録または別の子の受領範囲が変わり/);
 assert.throws(f.plan,/停止記録または別の子の受領範囲が変わり/);assert.equal(close.read(f.h,'Fixture',f.parent.id),null);assert.ok(fs.existsSync(f.wc));assert.deepEqual(fs.readFileSync(sibling.file(f.h,'Fixture',f.parent.id)),f.sideBytes);assert.equal(f.mains(),0);
});
test('R1 closure excludes a second process before intent and through receipt publication; other children stay writable',async t=>{
 const f=await fixture(t),p=f.plan(),a=f.approval(p),old=f.transfer.read('Fixture',f.web.id),offer=f.transfer.file('Fixture',f.web.id),lock=f.transfer.withSaveLock.bind(f.transfer),io=require('../lib/platform/file-io'),rename=io.renameSync;let beforeIntent=false,atReceipt=false;
 f.transfer.withSaveLock=(project,task,operation)=>lock(project,task,()=>{assert.equal(close.read(f.h,'Fixture',f.parent.id),null);assert.equal(otherPublisher(f,old).code,'EEXIST');assert.deepEqual(otherPublisher(f,{id:randomUUID(),project:'Fixture',task:'unrelated-new-child'}),{saved:true});beforeIntent=true;return operation();});
 io.renameSync=(from,to)=>{if(to===offer){assert.equal(otherPublisher(f,old).code,'EEXIST');atReceipt=true;}return rename(from,to);};
 let out;try{out=close.apply(f.h,a);}finally{io.renameSync=rename;f.transfer.withSaveLock=lock;}
 assert.equal(beforeIntent,true);assert.equal(atReceipt,true);const receipt=f.transfer.read('Fixture',f.web.id);assert.equal(receipt.consultationClosure,out.id);assert.equal(receipt.complete,true);assert.equal(fs.existsSync(offer+'.save.lock'),false);
 assert.match(otherPublisher(f,old).message,/相談終了/);assert.match(otherPublisher(f,receipt).message,/相談終了/);assert.equal(f.transfer.read('Fixture','unrelated-new-child').task,'unrelated-new-child');assert.deepEqual(fs.readFileSync(f.transfer.file('Fixture',f.report.id)),f.winOffer);
});
test('R1 ordinary publishers serialize across processes without blocking another child',async t=>{
 const f=await fixture(t),offer=f.transfer.file('Fixture',f.web.id),old=f.transfer.read('Fixture',f.web.id),io=require('../lib/platform/file-io'),rename=io.renameSync;let checked=false;
 io.renameSync=(from,to)=>{if(from===offer+'.tmp'&&to===offer){assert.equal(otherPublisher(f,{...old,note:'racing publisher'}).code,'EEXIST');assert.deepEqual(otherPublisher(f,{id:randomUUID(),project:'Fixture',task:'independent'}),{saved:true});checked=true;}return rename(from,to);};
 try{f.transfer.save({...old,note:'first publisher'});}finally{io.renameSync=rename;}
 assert.equal(checked,true);assert.equal(f.transfer.read('Fixture',f.web.id).note,'first publisher');assert.equal(fs.existsSync(offer+'.save.lock'),false);assert.equal(close.read(f.h,'Fixture',f.parent.id),null);assert.deepEqual(fs.readFileSync(f.h.file('Fixture',f.parent.id)),f.original);
});
test('R1 interrupted receipt publication keeps the journal and can finish once with the same offer exclusion',async t=>{
 const f=await fixture(t),p=f.plan(),a=f.approval(p),old=f.transfer.read('Fixture',f.web.id),offer=f.transfer.file('Fixture',f.web.id),io=require('../lib/platform/file-io'),rename=io.renameSync;let stop=true,checked=false;
 io.renameSync=(from,to)=>{if(to===offer&&stop){stop=false;throw Error('R1 receipt publication interrupted');}return rename(from,to);};
 try{assert.throws(()=>close.apply(f.h,a),/publication interrupted/);}finally{io.renameSync=rename;}
 const r=close.read(f.h,'Fixture',f.parent.id);assert.equal(r.stage,'retired');assert.equal(r.removal.ok,true);assert.equal(fs.existsSync(offer+'.save.lock'),false);assert.match(otherPublisher(f,old).message,/相談終了/);
 f.removal.transfer=()=>{throw Error('must not move twice');};
 io.renameSync=(from,to)=>{if(to===offer){assert.equal(otherPublisher(f,old).code,'EEXIST');checked=true;}return rename(from,to);};
 try{assert.equal(close.finish(f.h,{...a,id:r.id}).complete,true);}finally{io.renameSync=rename;}
 const bytes=fs.readFileSync(offer);assert.equal(checked,true);assert.equal(close.finish(f.h,{...a,id:r.id}).complete,true);assert.deepEqual(fs.readFileSync(offer),bytes);assert.equal(fs.existsSync(offer+'.save.lock'),false);assert.deepEqual(fs.readFileSync(r.originals.find(x=>x.kind==='sibling').file),f.sideBytes);assert.deepEqual(fs.readFileSync(f.transfer.file('Fixture',f.report.id)),f.winOffer);assert.equal(f.mains(),0);
});
test('R1 interrupted or linked offer reservation is never stolen and makes no closure journal or move',async t=>{
 const f=await fixture(t),a=f.approval(f.plan()),offer=f.transfer.file('Fixture',f.web.id),lock=offer+'.save.lock',before=fs.readFileSync(offer),old=f.transfer.read('Fixture',f.web.id),sentinel=path.join(f.root,'sentinel');f.write(sentinel,'do not change');
 for(const kind of ['interrupted','symlink','hardlink']){
  if(kind==='interrupted')f.write(lock,'an interrupted writer');else if(kind==='symlink')fs.symlinkSync(sentinel,lock);else fs.linkSync(sentinel,lock);
  assert.throws(()=>f.transfer.save(old));assert.throws(()=>close.apply(f.h,a));assert.equal(close.read(f.h,'Fixture',f.parent.id),null);assert.deepEqual(fs.readFileSync(offer),before);assert.ok(fs.existsSync(f.wc));assert.equal(fs.readFileSync(sentinel,'utf8'),'do not change');fs.unlinkSync(lock);
 }
 assert.equal(close.apply(f.h,a).complete,true);
});
test('R1 failed ordinary publication releases only its reservation and preserves its partial file',async t=>{
 const f=await fixture(t),offer=f.transfer.file('Fixture',f.web.id),old=f.transfer.read('Fixture',f.web.id),before=fs.readFileSync(offer),io=require('../lib/platform/file-io'),rename=io.renameSync;
 io.renameSync=(from,to)=>{if(from===offer+'.tmp'&&to===offer)throw Error('R1 legacy publication interrupted');return rename(from,to);};
 try{assert.throws(()=>f.transfer.save({...old,note:'partial'}),/publication interrupted/);}finally{io.renameSync=rename;}
 assert.deepEqual(fs.readFileSync(offer),before);assert.equal(JSON.parse(fs.readFileSync(offer+'.tmp')).note,'partial');assert.equal(fs.existsSync(offer+'.save.lock'),false);assert.equal(close.read(f.h,'Fixture',f.parent.id),null);
 const partial=fs.readFileSync(offer+'.tmp');assert.equal(close.apply(f.h,f.approval(f.plan())).complete,true);assert.deepEqual(fs.readFileSync(offer+'.tmp'),partial);assert.match(otherPublisher(f,old).message,/相談終了/);assert.equal(f.transfer.read('Fixture',f.web.id).complete,true);
});

// Supplemental boundary: a valid hold may already have been released by the UI.
test('released hold closes with its history intact and without replaying either integration',async t=>{
 const f=await fixture(t),prior=JSON.parse(fs.readFileSync(f.hf));
 prior.held=false;prior.revision=randomUUID();prior.history.push({before:true,held:false,revision:prior.revision});f.write(f.hf,JSON.stringify(prior));
 const bytes=fs.readFileSync(f.hf),p=f.plan(),a=f.approval(p),before=close.inventory(f.wc),out=close.apply(f.h,a);
 assert.equal(out.complete,true);assert.equal(out.mainApplied,false);assert.equal(f.mains(),0);
 const r=close.read(f.h,'Fixture',f.parent.id),ended=JSON.parse(fs.readFileSync(f.hf));
 assert.deepEqual(fs.readFileSync(r.originals.find(x=>x.kind==='hold').file),bytes);
 assert.deepEqual(ended.history.slice(0,-1),prior.history);assert.equal(ended.history.at(-1).before,false);assert.equal(ended.history.at(-1).held,false);assert.equal(ended.history.at(-1).consultationClosure,r.id);
 assert.deepEqual(fs.readFileSync(r.originals.find(x=>x.kind==='primary').file),f.original);assert.deepEqual(fs.readFileSync(r.originals.find(x=>x.kind==='sibling').file),f.sideBytes);assert.deepEqual(fs.readFileSync(f.transfer.file('Fixture',f.report.id)),f.winOffer);
 assert.deepEqual(close.inventory(r.manifest.find(x=>x.from===f.wc).to),before);assert.equal(fs.existsSync(f.wc),false);assert.ok(fs.existsSync(f.rc));assert.equal(f.h.historyBlocker('Fixture',f.parent.id),'');
 await f.auto.tick();assert.equal(f.requests.length,1);assert.throws(()=>f.h.save(f.old),/相談終了/);assert.throws(()=>close.apply(f.h,a));
});
test('released hold rejects a changed release revision or re-hold before any journal or move',async t=>{
 const f=await fixture(t),prior=JSON.parse(fs.readFileSync(f.hf));prior.held=false;prior.revision=randomUUID();f.write(f.hf,JSON.stringify(prior));
 const p=f.plan(),a=f.approval(p);
 for(const held of [false,true]){f.write(f.hf,JSON.stringify({...prior,held,revision:randomUUID()}));assert.throws(()=>close.apply(f.h,a));assert.equal(close.read(f.h,'Fixture',f.parent.id),null);assert.ok(fs.existsSync(f.wc));assert.deepEqual(fs.readFileSync(f.h.file('Fixture',f.parent.id)),f.original);}
});
test('released hold does not treat missing or malformed records as an ordinary release',async t=>{
 const f=await fixture(t),bytes=fs.readFileSync(f.hf),prior=JSON.parse(bytes);
 for(const value of [null,'{bad',JSON.stringify({...prior,held:'false'}),JSON.stringify({...prior,revision:'unknown'})]){
  if(value===null)fs.unlinkSync(f.hf);else f.write(f.hf,value);
  assert.throws(f.plan,/保留状態/);assert.equal(close.read(f.h,'Fixture',f.parent.id),null);assert.ok(fs.existsSync(f.wc));assert.deepEqual(fs.readFileSync(f.transfer.file('Fixture',f.report.id)),f.winOffer);
 }
 f.write(f.hf,bytes);
});
