'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process'),{randomUUID}=require('node:crypto');
const {Store}=require('../lib/store'),{Removal}=require('../lib/remove'),{TaskTransfer}=require('../lib/task-transfer'),{TaskIntegrate}=require('../lib/task-integrate'),{IntegrateAuto}=require('../lib/integrate-auto'),hold=require('../lib/task-future-hold'),git=require('../lib/git'),chat=require('../lib/chat');
function fixture(t){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-future-')),dir=path.join(root,'Product','Fixture'),body=path.join(root,'Body');
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const write=(f,s)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,s);return f;};
 write(path.join(dir,'PROJECT.md'),'---\nname: Fixture\n---\n');write(path.join(body,'base'),'base');
 const g=(...a)=>execFileSync('git',['-C',body,...a],{stdio:'pipe',encoding:'utf8'}).trim();
 g('init','-q');g('config','user.name','Fixture');g('config','user.email','fixture@localhost');g('add','.');g('commit','-qm','base');
 const store=new Store(root),parent=store.createTask('Fixture',{title:'親',steps:['未済']}),busy=new Set(),locked=new Set();
 const removal=new Removal({store,trash:path.join(root,'Trash'),busy:(p,t)=>busy.has(t),locked:p=>locked.has(p)}),transfer=new TaskTransfer({store,removal,baseOf:()=>body}),integrate=new TaskIntegrate({store,transfer,removal,baseOf:()=>body});
 const requests=[],auto=new IntegrateAuto({integrate,dispatch:async r=>requests.push(r),busy:()=>false});
 const child=(title='将来案',parentId=parent.id)=>{const c=store.createTask('Fixture',{title,parent:parentId,steps:['済']});store.setStep('Fixture',c.id,0,true);store.appendSection('Fixture',c.id,'成果','- なし：比較結果を保管');store.appendSection('Fixture',c.id,'残件申告','```json\n'+JSON.stringify({status:'なし',items:'なし',undecided:'なし',evidence:'隔離比較'})+'\n```');chat.append(dir,c.id,{role:'assistant',text:'元会話・原文'});return get(c.id);};
 const get=id=>store.readTask(store.taskFile('Fixture',id));
 const args=(id,held)=>{const c=get(id);return {project:'Fixture',task:id,held,before:Boolean(c.futureHold),revision:c.futureHoldRevision||null,expectedHash:c.completionHash,confirm:true};};
 const save=(id,held)=>hold.save(integrate,args(id,held));
 const preview=()=>auto.preview({project:'Fixture',task:parent.id,simple:true});
 return {root,dir,body,g,write,store,parent,busy,locked,removal,transfer,integrate,auto,requests,child,get,args,save,preview};
}
test('保留と解除は再起動後も持続し、原文・会話・コピー・受領・hashを一切書き換えない',t=>{
 const f=fixture(t),c=f.child(),w=git.prepare({base:f.body,workRoot:f.removal.workRoot({id:'Fixture'}),taskId:c.id});f.store.updateTask('Fixture',c.id,{workdir:w.dir});
 f.write(path.join(w.dir,'未保存比較.txt'),'未保存も保持');
 f.transfer.save({id:randomUUID(),project:'Fixture',task:c.id,complete:true,retained:true,received:[],files:[]});
 const taskFile=f.store.taskFile('Fixture',c.id),chatFile=path.join(f.dir,'.ai/chat',c.id+'.jsonl'),receipt=f.transfer.file('Fixture',c.id),original=[taskFile,chatFile,receipt,path.join(w.dir,'未保存比較.txt')].map(p=>[p,fs.readFileSync(p),fs.statSync(p).mode]);
 const hash=f.get(c.id).completionHash,old=f.args(c.id,true),head=git.inspect(w.dir);
 f.integrate.tokens.set('old',{});f.transfer.tokens.set('old',{});f.save(c.id,true);
 const restarted=new Store(f.root);assert.equal(restarted.readTask(taskFile).futureHold,true);assert.equal(f.get(c.id).completionHash,hash);assert.equal(f.integrate.tokens.size+f.transfer.tokens.size,0);
 f.save(c.id,false);assert.equal(f.get(c.id).futureHold,false);assert.throws(()=>hold.save(f.integrate,old),/状態が変わりました/);
 assert.deepEqual(git.inspect(w.dir),head);for(const [p,bytes,mode]of original){assert.deepEqual(fs.readFileSync(p),bytes);assert.equal(fs.statSync(p).mode,mode);}
 const r=JSON.parse(fs.readFileSync(hold.file(f.root,'Fixture',c.id)));assert.deepEqual(r.history.map(x=>x.held),[true,false]);assert.equal(fs.statSync(hold.file(f.root,'Fixture',c.id)).mode&0o777,0o600);assert.equal(f.requests.length,0);
});
test('新候補から保留した子と子孫だけを除外し、他の子を保ち、解除だけでは送信しない',t=>{
 const f=fixture(t),mid=f.child('将来案'),leaf=f.child('詳細',mid.id),other=f.child('活動中');const old=f.preview();assert.equal(old.items.length,3);
 f.save(mid.id,true);assert.deepEqual(f.preview().items.map(x=>x.task),[other.id]);
 assert.throws(()=>f.integrate.apply({project:'Fixture',task:f.parent.id,token:old.token,confirm:true,auto:true,mode:'single',selected:[{project:'Fixture',task:mid.id,keep:true}]}),/確認|期限|見つかりません/);
 assert.throws(()=>f.transfer.context('Fixture',leaf.id,{offer:true}),/将来検討/);
 assert.throws(()=>f.integrate.simple.saveKeep({project:'Fixture',task:f.parent.id,childProject:'Fixture',childTask:mid.id,keep:false}),/将来検討/);
 f.save(mid.id,false);assert.equal(f.preview().items.length,3);assert.equal(f.requests.length,0);assert.equal(f.integrate.read('Fixture',f.parent.id),null);
});
test('停止中の旧統合と予約を保持し、旧再開・直接実行・送信・自動tickの保留無視を拒否',async t=>{
 const f=fixture(t),c=f.child(),d=f.preview();f.integrate.apply({project:'Fixture',task:f.parent.id,token:d.token,confirm:true,auto:true,thenMain:false,mode:'single',selected:[{project:'Fixture',task:c.id,keep:true}]});
 const r=f.integrate.read('Fixture',f.parent.id);r.auto.stopped={reason:'元の停止理由',at:'2026-10-21T00:00:00Z'};f.integrate.save(r);
 const record=f.integrate.file('Fixture',f.parent.id),before=fs.readFileSync(record),pending=f.integrate.pending();f.save(c.id,true);
 assert.deepEqual(fs.readFileSync(record),before);assert.deepEqual(f.integrate.pending(),pending);
 const p=f.preview();assert.equal(p.items[0].futureHold,true);assert.equal(p.resumeAllowed,false);assert.match(p.resumeMessage,/将来検討/);
 assert.throws(()=>f.integrate.run(r),/将来検討/);assert.equal(f.auto.resumeStatus(r).allowed,false);
 await assert.rejects(f.auto.dispatchAttempt(r,{phase:'organize'},'key',{}),/将来検討/);await f.auto.tick();assert.equal(f.requests.length,0);assert.deepEqual(fs.readFileSync(record),before);
 f.save(c.id,false);await f.auto.tick();assert.equal(f.requests.length,0);assert.deepEqual(fs.readFileSync(record),before,'release never clears the old stopped reason');
});
test('関連AI・処理・順番待ち・未停止統合・受領中は変更前拒否し、他の子は妨げない',t=>{
 const f=fixture(t),mid=f.child('親候補'),leaf=f.child('子候補',mid.id),other=f.child('無関係');
 const reject=()=>{assert.throws(()=>f.save(mid.id,true));assert.equal(fs.existsSync(hold.file(f.root,'Fixture',mid.id)),false);};
 for(const id of [mid.id,leaf.id,f.parent.id]){f.busy.add(id);reject();f.busy.delete(id);}
 f.locked.add('Fixture');reject();f.locked.clear();
 const q=f.write(path.join(f.dir,'.ai/chat',leaf.id+'.queue.json'),'[{}]');reject();fs.writeFileSync(q,'[]');
 const active={id:randomUUID(),project:'Fixture',task:f.parent.id,items:[],auto:{attempts:{}}};f.integrate.save(active);reject();fs.unlinkSync(f.integrate.file('Fixture',f.parent.id));
 f.transfer.save({id:randomUUID(),project:'Fixture',task:leaf.id,receiving:{at:'now'}});reject();fs.unlinkSync(f.transfer.file('Fixture',leaf.id));
 f.busy.add(other.id);f.save(mid.id,true);assert.equal(f.get(mid.id).futureHold,true);assert.equal(f.requests.length,0);
});
test('保留した孫がいる祖先は片付け不可、保持統合は候補に残り元の権限と記録を保つ',t=>{
 const f=fixture(t),mid=f.child('中間'),leaf=f.child('将来の詳細',mid.id);f.save(leaf.id,true);
 const p=f.preview();assert.equal(p.items.length,1);assert.equal(p.items[0].task,mid.id);
 assert.throws(()=>f.transfer.context('Fixture',mid.id,{disposition:'cleanup'}),/将来検討/);
 const a=f.integrate.ancestor('Fixture',f.parent.id),q=a.all[0],c=q.tasks.find(x=>x.id===mid.id);
 assert.ok(f.integrate.details(a,q,c,undefined,'cleanup').blockers.some(x=>x.includes('将来検討')));
 assert.ok(!f.integrate.details(a,q,c,undefined,'continue').blockers.some(x=>x.includes('将来検討')));
});
test('読めない保留・リンク・親のない作業・CAS不一致は安全側で拒否し候補を黙って隠さない',t=>{
 const f=fixture(t),c=f.child(),meta=hold.file(f.root,'Fixture',c.id);assert.throws(()=>f.save(f.parent.id,true),/親のある/);
 const stale=f.args(c.id,true);stale.expectedHash='wrong';assert.throws(()=>hold.save(f.integrate,stale),/状態が変わりました/);
 const outside=f.write(path.join(f.root,'outside'),'{}');fs.mkdirSync(path.dirname(meta),{recursive:true});fs.symlinkSync(outside,meta);
 assert.ok(f.get(c.id).futureHoldError);assert.throws(()=>f.save(c.id,true),/記録を確認/);assert.equal(fs.readFileSync(outside,'utf8'),'{}');fs.unlinkSync(meta);fs.writeFileSync(meta,'{"held":true}');
 const d=f.preview();assert.equal(d.items.length,1);assert.equal(d.items[0].startable,false);assert.match(d.items[0].reason,/保留記録/);assert.throws(()=>f.transfer.context('Fixture',c.id,{offer:true}),/保留記録/);
});
test('保留APIの拒否は停止理由や受領記録へ失敗を書かず、既存の書込み待機を尊重する',t=>{
 const f=fixture(t),c=f.child(),events=[],route=require('../lib/routes/task-integration')({taskIntegrate:f.integrate,integrationBlockers:()=>[{message:'処理中'}],record:(...a)=>events.push(a),send:(r,status,body)=>({status,body}),integrationFailure:()=>assert.fail('must not rewrite stopped records')}).futureHold;
 assert.equal(route.matches({method:'GET'},{pathname:'/api/task/future-hold'}),false);
 const out=route.handle({},null,{},f.args(c.id,true));assert.equal(out.status,409);assert.match(out.body.error,/処理中/);assert.equal(fs.existsSync(hold.file(f.root,'Fixture',c.id)),false);assert.equal(events.length,0);
});
test('受領完了でも本体処理が動く記録は拒否し、停止済み本体不明記録は保留後も消さない',t=>{
 const f=fixture(t),c=f.child(),r={id:randomUUID(),project:'Fixture',task:f.parent.id,complete:true,items:[{project:'Fixture',task:c.id,state:'保持受領済み'}],auto:{thenMain:true,main:{state:'intent'}}};
 f.integrate.save(r);assert.throws(()=>f.save(c.id,true),/統合が動いて/);assert.equal(fs.existsSync(hold.file(f.root,'Fixture',c.id)),false);
 r.auto.stopped={reason:'本体の結果不明'};f.integrate.save(r);const before=fs.readFileSync(f.integrate.file('Fixture',f.parent.id));f.save(c.id,true);
 assert.deepEqual(fs.readFileSync(f.integrate.file('Fixture',f.parent.id)),before);assert.equal(f.integrate.pending()[0].mainPending.main.state,'intent');
});
test('保留APIは原文を書かず監査と状態だけ保存し、同一要求の古い再送は拒否する',t=>{
 const f=fixture(t),c=f.child(),events=[],route=require('../lib/routes/task-integration')({taskIntegrate:f.integrate,integrationBlockers:()=>[],record:(...a)=>events.push(a),send:(r,status,body)=>({status,body}),integrationFailure:()=>assert.fail('must not rewrite records')}).futureHold;
 const request=f.args(c.id,true),file=f.store.taskFile('Fixture',c.id),before=fs.readFileSync(file);const out=route.handle({},null,{},request);
 assert.equal(out.status,200);assert.equal(f.get(c.id).futureHold,true);assert.equal(events[0][0],'task-future-hold');assert.deepEqual(fs.readFileSync(file),before);
 assert.equal(route.handle({},null,{},request).status,409);assert.equal(events.length,1);assert.equal(f.requests.length,0);
});
test('直接の受領再開と保持完了も保留を先に照合し、一式の作成・通知・原文変更より前に拒否する',t=>{
 const f=fixture(t),c=f.child();f.save(c.id,true);
 f.transfer.prepareBundles=()=>assert.fail('must reject before preparing files');f.transfer.finishRetention=()=>assert.fail('must reject before rewriting task');
 for(const retention of [undefined,{}])assert.throws(()=>f.transfer.continue({project:'Fixture',task:c.id,files:[],retention}),/将来検討/);
 const mid=f.child('中間'),leaf=f.child('将来孫',mid.id);f.save(leaf.id,true);
 assert.throws(()=>f.transfer.continue({project:'Fixture',task:mid.id,files:[]}),/将来検討/);assert.equal(f.requests.length,0);
});
