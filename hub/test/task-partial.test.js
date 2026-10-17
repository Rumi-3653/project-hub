'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{execFileSync}=require('node:child_process');
const {Store}=require('../lib/store'),{Removal}=require('../lib/remove'),{TaskTransfer}=require('../lib/task-transfer'),{TaskIntegrate}=require('../lib/task-integrate'),graph=require('../public/project-order'),git=require('../lib/git'),chat=require('../lib/chat');
const sh=(dir,...args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function fixture(t,opts={}){
 const project=opts.project||'Fixture';
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-integrate-'));const oldTrash=process.env.HUB_TRASH;process.env.HUB_TRASH=path.join(root,'Trash');t.after(()=>{if(oldTrash===undefined)delete process.env.HUB_TRASH;else process.env.HUB_TRASH=oldTrash;});t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const dir=path.join(root,'Product',project),body=path.join(root,'Body');
 const write=(f,s)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,s);return f;};
 write(path.join(dir,'PROJECT.md'),'---\nname: '+project+'\n---\n');write(path.join(body,'base.txt'),'base\n');
 sh(body,'init','-q');sh(body,'config','user.email','fixture@localhost');sh(body,'config','user.name',project);sh(body,'add','.');sh(body,'commit','-qm','base');
 const store=new Store(root),parent=store.createTask(project,{title:'祖先'});
 const removal=new Removal({store,trash:path.join(root,'Trash'),...opts});
 const transfer=new TaskTransfer({store,removal,baseOf:()=>body,...opts});
 const make=()=>new TaskIntegrate({store,transfer,removal,baseOf:()=>body});let integrate=make();
 const child=(title,parentId=parent.id,code=true)=>{
   const c=store.createTask(project,{title,parent:parentId,steps:['完成']});store.setStep(project,c.id,0,true);
   if(code){const w=git.prepare({base:body,workRoot:removal.workRoot({id:project}),taskId:c.id});store.updateTask(project,c.id,{workdir:w.dir});write(path.join(w.dir,title+'.txt'),title+'\n');git.save(w.dir,'child');}
   write(path.join(dir,'作業',c.id,'report.txt'),title+' report');return store.readTask(store.taskFile(project,c.id));
 };
 const preview=only=>integrate.preview(project,parent.id,only);
 const review=i=>({scope:'確認済みHEADと成果一式',planned:'同じ作業を継続',undecided:'なし',residual:'なし',evidence:'隔離試験',sourceHead:i.source?.head||null,confirmed:true});
 const apply=(d,items=d.items)=>integrate.apply({project:project,task:parent.id,token:d.token,confirm:true,selected:items.map(i=>({project:i.project,task:i.task,files:i.selected,optional:[],...(!i.partial?{disposition:'cleanup',review:review(i)}:{})}))});
 return {root,dir,body,write,store,parent,removal,transfer,child,preview,apply,review,get integrate(){return integrate;},restart(){integrate=make();},sh};
}
const unfinished=(f,c)=>{f.store.setStep('Fixture',c.id,0,false);f.store.updateTask('Fixture',c.id,{state:'返事待ち',question:'実試験待ち'});return f.store.readTask(f.store.taskFile('Fixture',c.id));};
const offer=(f,c)=>{const d=f.transfer.offerPreview('Fixture',c.id);assert.deepEqual(d.blockers,[]);return f.transfer.offer({project:'Fixture',task:c.id,token:d.token,confirm:true,selected:d.selected});};
test('途中受領は子の状態・手順・質問・会話・copyを保持し、同じ版は再受領しない',t=>{
 const f=fixture(t),c=unfinished(f,f.child('途中'));chat.append(f.dir,c.id,{role:'assistant',text:'history'});
 const file=f.store.taskFile('Fixture',c.id),before=fs.readFileSync(file,'utf8'),head=sh(c.workdir,'rev-parse','HEAD');
 assert.equal(f.preview().items[0].disposition,'continue');assert.equal(offer(f,c).partial,true);
 const d=f.preview();assert.equal(d.items[0].partial,true);assert.deepEqual(d.items[0].blockers,[]);assert.equal(f.apply(d).complete,true);
 assert.equal(fs.readFileSync(file,'utf8'),before);assert.ok(fs.existsSync(c.workdir));assert.equal(sh(c.workdir,'rev-parse','HEAD'),head);
 assert.equal(chat.read(f.dir,c.id)[0].text,'history');assert.equal(chat.read(f.dir,c.id).filter(x=>x.partialReceipt).length,1);
 assert.equal(f.transfer.read('Fixture',c.id).received.length,1);assert.equal(f.transfer.read('Fixture',c.id).complete,undefined);assert.equal(f.integrate.read('Fixture',f.parent.id).kind,'partial');
 assert.equal(f.preview().items.length,0);assert.equal(f.preview().retainedItems[0].partial,false);assert.match(f.transfer.offerPreview('Fixture',c.id).blockers.join(),/受領済み/);
 assert.equal(fs.existsSync(path.join(f.root,'Trash')),false);assert.equal(f.transfer.pending().length,0);assert.equal(f.transfer.offers()[0].received.pendingCommits,0);
});
test('続きのcommitと新成果だけを再受領、最終統合だけで片付けて同じ成果を二重に写さない',t=>{
 const f=fixture(t),c=unfinished(f,f.child('途中'));offer(f,c);f.apply(f.preview());const first=f.transfer.read('Fixture',c.id).received[0];
 f.write(path.join(c.workdir,'next.txt'),'next');git.save(c.workdir,'next');f.write(path.join(f.dir,'作業',c.id,'next.txt'),'next report');
 assert.equal(f.transfer.offers()[0].received.pendingCommits,1);offer(f,c);const d=f.preview();assert.equal(d.items[0].files.length,1);assert.deepEqual(d.items[0].preview.paths,['next.txt']);f.apply(d);
 const r=f.transfer.read('Fixture',c.id);assert.equal(r.received.length,2);assert.equal(r.received[0].id,first.id);assert.ok(fs.existsSync(path.join(f.body,'next.txt')));
 f.store.setStep('Fixture',c.id,0,true);f.store.updateTask('Fixture',c.id,{question:'',state:'実行中'});
 const final=f.preview();assert.equal(final.items[0].partial,false);assert.equal(f.integrate.apply({project:'Fixture',task:f.parent.id,token:final.token,confirm:true,selected:[{project:'Fixture',task:c.id,disposition:'cleanup',review:f.review(final.items[0])}]}).complete,true);
 assert.equal(f.store.taskFile('Fixture',c.id),null);assert.equal(fs.existsSync(c.workdir),false);assert.equal(f.transfer.read('Fixture',c.id).files.length,0);
 const count=fs.readdirSync(path.join(f.dir,'成果物/受取'));assert.equal(count.length,2);
});
test('途中受領のファイルだけの続きも可、親copyへ統合して本体は保持',t=>{
 const f=fixture(t),w=git.prepare({base:f.body,workRoot:f.removal.workRoot({id:'Fixture'}),taskId:f.parent.id});f.store.updateTask('Fixture',f.parent.id,{workdir:w.dir});
 const head=sh(f.body,'rev-parse','HEAD'),c=unfinished(f,f.child('文書',f.parent.id,false));offer(f,c);f.apply(f.preview());
 f.write(path.join(f.dir,'作業',c.id,'report.txt'),'revised');offer(f,c);f.apply(f.preview());assert.equal(f.transfer.read('Fixture',c.id).received.length,2);assert.equal(sh(f.body,'rev-parse','HEAD'),head);
});
test('途中受領は確認後のHEAD/成果/親dirty/待ち指示/AI/整理の変更を拒否',t=>{
 let busy=false,locked=false;const f=fixture(t,{busy:()=>busy,locked:()=>locked}),c=unfinished(f,f.child('途中'));offer(f,c);
 let d=f.preview();f.write(path.join(c.workdir,'new.txt'),'new');git.save(c.workdir,'new');assert.throws(()=>f.apply(d),/変わ|未保存の変更を保存/);
 offer(f,c);d=f.preview();f.write(path.join(f.dir,'作業',c.id,'report.txt'),'changed');assert.throws(()=>f.apply(d),/変わ|未保存の変更を保存/);
 offer(f,c);d=f.preview();busy=true;assert.throws(()=>f.apply(d),/AI/);busy=false;locked=true;assert.throws(()=>f.apply(d),/整理/);locked=false;
 const q=path.join(f.dir,'.ai/chat',f.parent.id+'.queue.json');f.write(q,'[{}]');assert.throws(()=>f.apply(d),/順番待ち/);fs.unlinkSync(q);
 const cq=path.join(f.dir,'.ai/chat',c.id+'.queue.json');f.write(cq,'[{}]');assert.throws(()=>f.apply(d),/順番待ち/);fs.unlinkSync(cq);
 f.write(path.join(c.workdir,'dirty.txt'),'dirty');assert.match(f.transfer.offerPreview('Fixture',c.id).blockers.join(),/保存/);fs.unlinkSync(path.join(c.workdir,'dirty.txt'));
 f.write(path.join(f.body,'dirty.txt'),'dirty');assert.throws(()=>f.apply(d),/変わ|未保存の変更を保存/);fs.unlinkSync(path.join(f.body,'dirty.txt'));
 assert.equal(fs.existsSync(path.join(f.root,'Trash')),false);assert.ok(f.store.taskFile('Fixture',c.id));
});
test('コードだけの同じ保存は古い引渡し確認からも再受領しない',t=>{
 const f=fixture(t),c=unfinished(f,f.child('code'));fs.unlinkSync(path.join(f.dir,'作業',c.id,'report.txt'));
 const stale=f.transfer.offerPreview('Fixture',c.id);offer(f,c);f.apply(f.preview());
 assert.throws(()=>f.transfer.offer({project:'Fixture',task:c.id,token:stale.token,confirm:true,selected:[]}),/受領済み/);
 assert.equal(f.transfer.read('Fixture',c.id).received.length,1);
});
test('受領記録だけ保存後に中断しても、統合記録を補い子と成果を重ねて処理しない',t=>{
 const f=fixture(t),c=unfinished(f,f.child('resume'));offer(f,c);
 const save=f.integrate.save.bind(f.integrate);
 f.integrate.save=r=>{if(r.items.some(i=>i.state==='受領済み'))throw Error('integration save interruption');return save(r);};
 assert.throws(()=>f.apply(f.preview()),/integration save interruption/);f.restart();
 const receivedHead=sh(c.workdir,'rev-parse','HEAD');f.write(path.join(c.workdir,'later.txt'),'later');git.save(c.workdir,'after receipt');
 assert.equal(f.apply(f.preview()).complete,true);assert.equal(f.transfer.read('Fixture',c.id).received.length,1);
 assert.equal(f.transfer.read('Fixture',c.id).received[0].head,receivedHead);assert.equal(fs.existsSync(path.join(f.body,'later.txt')),false);assert.equal(f.transfer.offers()[0].received.pendingCommits,1);
 assert.equal(chat.read(f.dir,c.id).filter(x=>x.partialReceipt).length,1);assert.ok(fs.existsSync(c.workdir));
});
test('途中で受け取った保存先が変わったら、最終統合でも元の成果と子を保持する',t=>{
 const f=fixture(t),c=unfinished(f,f.child('protect'));offer(f,c);f.apply(f.preview());
 const r=f.transfer.read('Fixture',c.id);f.write(r.received[0].files[0].to,'changed receipt');
 f.store.setStep('Fixture',c.id,0,true);f.store.updateTask('Fixture',c.id,{question:'',state:'実行中'});
 assert.throws(()=>f.apply(f.preview()),/以前受け取った成果/);assert.ok(f.store.taskFile('Fixture',c.id));assert.ok(fs.existsSync(c.workdir));
 assert.ok(fs.existsSync(path.join(f.dir,'作業',c.id,'report.txt')));
});
test('途中受領の通知失敗から再起動して保存段階を再開、二重通知・二重コピーなし',t=>{
 let fail=true;const f=fixture(t,{notify:()=>{if(fail)throw Error('receipt interruption');}}),c=unfinished(f,f.child('途中'));
 // offer通知は成功させ、受領通知で中断。
 fail=false;offer(f,c);fail=true;assert.throws(()=>f.apply(f.preview()),/receipt interruption/);const before=sh(f.body,'rev-parse','HEAD');
 assert.ok(f.transfer.read('Fixture',c.id).partialReceipt);assert.ok(fs.existsSync(c.workdir));f.restart();fail=false;const d=f.preview();assert.equal(d.resume,true);assert.equal(f.apply(d).complete,true);
 assert.equal(sh(f.body,'rev-parse','HEAD'),before);assert.equal(f.transfer.read('Fixture',c.id).received.length,1);assert.equal(chat.read(f.dir,c.id).filter(x=>x.partialReceipt).length,1);assert.equal(fs.readdirSync(path.join(f.dir,'成果物/受取')).length,1);
});
test('親が先に進んだ衝突も子を閉じず、既存の解消→続きで途中受領する',t=>{
 const f=fixture(t),c=unfinished(f,f.child('途中'));offer(f,c);f.apply(f.preview());
 f.write(path.join(c.workdir,'base.txt'),'child');git.save(c.workdir,'child update');f.write(path.join(f.body,'base.txt'),'parent');git.save(f.body,'parent update');offer(f,c);
 const out=f.apply(f.preview());assert.equal(out.conflict,true);assert.ok(f.store.taskFile('Fixture',c.id));assert.ok(fs.existsSync(c.workdir));
 assert.throws(()=>sh(f.body,'merge','--no-ff','--no-edit',git.inspect(c.workdir).branch));f.write(path.join(f.body,'base.txt'),'resolved');sh(f.body,'add','.');sh(f.body,'commit','-qm','resolve');f.store.updateTask('Fixture',f.parent.id,{state:'実行中',question:''});
 f.restart();assert.equal(f.apply(f.preview()).complete,true);assert.equal(f.transfer.read('Fixture',c.id).received.length,2);assert.ok(f.store.taskFile('Fixture',c.id));
});
for(const stage of ['before-merge','before-copy','after-copy'])test(`中断復旧 ${stage}：旧HEADの受領を完了し子の新commitを次回へ保持`,t=>{
 let fail=false;const f=fixture(t,{notify:()=>{if(fail&&stage==='after-copy')throw Error('interrupted after copy');}}),c=unfinished(f,f.child('recover'));
 offer(f,c);const oldHead=sh(c.workdir,'rev-parse','HEAD'),original=f.store.taskFile('Fixture',c.id),taskBefore=fs.readFileSync(original,'utf8');
 const merge=f.integrate.gitw.merge,save=f.transfer.save.bind(f.transfer);
 if(stage==='before-merge')f.integrate.gitw={...git,merge:()=>{throw Error('interrupted before merge');}};
 if(stage==='before-copy')f.transfer.save=r=>{save(r);if(r.partialReceipt)throw Error('interrupted before copy');};
 fail=true;assert.throws(()=>f.apply(f.preview()),/interrupted/);fail=false;f.transfer.save=save;f.restart();
 const receipt=f.transfer.read('Fixture',c.id).partialReceipt;
 f.write(path.join(c.workdir,'later.txt'),'new child work');git.save(c.workdir,'continued work');
 if(stage==='after-copy')f.write(path.join(f.dir,'作業',c.id,'report.txt'),'new report after old copy');
 const newHead=sh(c.workdir,'rev-parse','HEAD');const d=f.preview();assert.deepEqual(d.blockers,[]);assert.ok(d.recover);assert.equal(d.items[0].source.head,oldHead);
 assert.throws(()=>f.apply(d),/承認/);
 assert.equal(f.integrate.apply({project:'Fixture',task:f.parent.id,token:d.token,confirm:true,recover:true}).complete,true);
 const r=f.transfer.read('Fixture',c.id);assert.equal(r.received.length,1);assert.equal(r.received[0].head,oldHead);assert.equal(r.integrating,undefined);
 if(receipt)assert.equal(r.received[0].id,receipt.id);
 assert.equal(git.isAncestor(f.body,oldHead),true);assert.equal(git.isAncestor(f.body,newHead),false);assert.equal(fs.existsSync(path.join(f.body,'later.txt')),false);
 assert.equal(fs.readFileSync(original,'utf8'),taskBefore);assert.equal(sh(c.workdir,'rev-parse','HEAD'),newHead);assert.ok(fs.existsSync(c.workdir));assert.equal(fs.existsSync(path.join(f.root,'Trash')),false);
 assert.equal(chat.read(f.dir,c.id).filter(x=>x.partialReceipt).length,1);assert.equal(fs.readFileSync(r.received[0].files[0].to,'utf8'),'recover report');
 offer(f,c);const next=f.preview();assert.equal(next.items[0].source.head,newHead);assert.deepEqual(next.items[0].preview.paths,['later.txt']);f.apply(next);
 assert.equal(f.transfer.read('Fixture',c.id).received.length,2);assert.equal(git.isAncestor(f.body,newHead),true);assert.match(f.transfer.offerPreview('Fixture',c.id).blockers.join(),/受領済み/);
});
test('旧HEAD復旧でも予約・原本未保存・受取改変・履歴/コピー変更・dirty・AIと古い確認を拒否',t=>{
 let fail=false,busy=false;const f=fixture(t,{notify:()=>{if(fail)throw Error('notify stopped');},busy:()=>busy}),c=unfinished(f,f.child('protect-recovery'));
 offer(f,c);fail=true;assert.throws(()=>f.apply(f.preview()),/notify stopped/);fail=false;f.restart();
 f.write(path.join(c.workdir,'next.txt'),'next');git.save(c.workdir,'next');
 const hand=f.transfer.read('Fixture',c.id),receipt=hand.partialReceipt,original=fs.readFileSync(receipt.files[0].to,'utf8');
 f.write(receipt.files[0].to,'tampered');assert.match(f.preview().blockers.join(),/変更/);f.write(receipt.files[0].to,original);
 f.transfer.save({...hand,integrating:'other'});assert.match(f.preview().blockers.join(),/予約|祖先/);f.transfer.save(hand);
 const childHead=sh(c.workdir,'rev-parse','HEAD');sh(c.workdir,'reset','--hard',sh(c.workdir,'rev-list','--max-parents=0','HEAD'));assert.match(f.preview().blockers.join(),/履歴/);sh(c.workdir,'reset','--hard',childHead);
 f.store.updateTask('Fixture',c.id,{workdir:f.body});assert.match(f.preview().blockers.join(),/履歴|場所/);f.store.updateTask('Fixture',c.id,{workdir:c.workdir});
 f.write(path.join(c.workdir,'dirty.txt'),'dirty');assert.match(f.preview().blockers.join(),/保存/);fs.unlinkSync(path.join(c.workdir,'dirty.txt'));
 busy=true;assert.throws(()=>f.preview(),/AI/);busy=false;
 const d=f.preview();assert.deepEqual(d.blockers,[]);f.write(path.join(c.workdir,'third.txt'),'third');git.save(c.workdir,'third');
 assert.throws(()=>f.integrate.apply({project:'Fixture',task:f.parent.id,token:d.token,confirm:true,recover:true}),/変わ/);
 const newPreview=f.preview();assert.equal(f.integrate.apply({project:'Fixture',task:f.parent.id,token:newPreview.token,confirm:true,recover:true}).complete,true);
 assert.equal(f.transfer.read('Fixture',c.id).received.length,1);
});
test('コピー前の中断では旧成果の指紋を保持し、新HEADだけを理由に原本改変を許さない',t=>{
 const f=fixture(t),c=unfinished(f,f.child('before-save'));offer(f,c);
 const save=f.transfer.save.bind(f.transfer);f.transfer.save=r=>{save(r);if(r.partialReceipt)throw Error('before-copy');};
 assert.throws(()=>f.apply(f.preview()),/before-copy/);f.transfer.save=save;f.restart();
 f.write(path.join(c.workdir,'new.txt'),'new');git.save(c.workdir,'new');f.write(path.join(f.dir,'作業',c.id,'report.txt'),'changed original');
 assert.match(f.preview().blockers.join(),/成果ファイルが変わ/);assert.equal(f.transfer.read('Fixture',c.id).received.length,0);assert.ok(fs.existsSync(c.workdir));
});
test('子更新を承認後の旧HEAD衝突は再承認ループにならず、解消依頼も旧HEADだけを指定',t=>{
 const f=fixture(t),c=unfinished(f,f.child('recover-conflict'));
 f.write(path.join(c.workdir,'base.txt'),'child');git.save(c.workdir,'old child');offer(f,c);const oldHead=sh(c.workdir,'rev-parse','HEAD');
 const merge=git.merge;f.integrate.gitw={...git,merge:()=>{throw Error('before merge');}};assert.throws(()=>f.apply(f.preview()),/before merge/);f.restart();
 f.write(path.join(c.workdir,'later.txt'),'later');git.save(c.workdir,'later child');const newHead=sh(c.workdir,'rev-parse','HEAD');f.write(path.join(f.body,'base.txt'),'parent');git.save(f.body,'parent');
 let d=f.preview();assert.deepEqual(d.blockers,[]);assert.ok(d.recover);
 const out=f.integrate.apply({project:'Fixture',task:f.parent.id,token:d.token,confirm:true,recover:true});assert.equal(out.conflict,true);
 f.store.updateTask('Fixture',f.parent.id,{state:'実行中',question:''});d=f.preview();assert.deepEqual(d.blockers,[]);assert.equal(d.recover,null);
 const request=f.integrate.conflictRequest({project:'Fixture',task:f.parent.id,childProject:'Fixture',childTask:c.id,token:d.token});assert.ok(request.text.includes(oldHead));assert.equal(request.text.includes(newHead),false);assert.equal(request.text.includes(git.inspect(c.workdir).branch),false);
 assert.throws(()=>sh(f.body,'merge','--no-ff','--no-edit',oldHead));f.write(path.join(f.body,'base.txt'),'resolved');sh(f.body,'add','.');sh(f.body,'commit','-qm','resolve old snapshot');f.restart();
 assert.equal(f.apply(f.preview()).complete,true);assert.equal(f.transfer.read('Fixture',c.id).received[0].head,oldHead);assert.equal(git.isAncestor(f.body,newHead),false);offer(f,c);f.apply(f.preview());assert.equal(git.isAncestor(f.body,newHead),true);
});

// All receipt modes share one ordered history and saved-artifact verification.
const receiveMode=(f,mode)=>{
 const d=f.preview(),i=d.items[0];assert.deepEqual(d.blockers||[],[]);assert.deepEqual(i.blockers,[]);
 return f.integrate.apply({project:'Fixture',task:f.parent.id,token:d.token,confirm:true,selected:[{project:i.project,task:i.task,disposition:mode,review:f.review(i)}]});
};
test('途中受領→継続受領→片付けは同じ履歴と祖先照合で増分だけ受け取る',t=>{
 const f=fixture(t),c=unfinished(f,f.child('interop'));offer(f,c);f.apply(f.preview());const first=f.transfer.read('Fixture',c.id).received[0];
 f.write(path.join(c.workdir,'next.txt'),'next');git.save(c.workdir,'next');f.write(path.join(f.dir,'作業',c.id,'next.txt'),'new report');
 receiveMode(f,'continue');const r=f.transfer.read('Fixture',c.id);
 assert.deepEqual(r.received.map(x=>x.disposition),['partial','continue']);assert.equal(r.previous,first.id);assert.equal(r.received[1].previous,first.id);assert.equal(r.received[1].head,sh(c.workdir,'rev-parse','HEAD'));assert.equal(r.files.length,1);
 assert.ok(f.store.taskFile('Fixture',c.id));assert.ok(fs.existsSync(c.workdir));assert.equal(f.store.readTask(f.store.taskFile('Fixture',c.id)).steps[0].done,false);
 f.store.setStep('Fixture',c.id,0,true);f.store.updateTask('Fixture',c.id,{question:'',state:'実行中'});receiveMode(f,'cleanup');
 const final=f.transfer.read('Fixture',c.id);assert.equal(final.files.length,0);assert.deepEqual(final.received.map(x=>x.disposition),['partial','continue','cleanup']);assert.equal(final.received.at(-1).previous,r.id);assert.equal(final.received.at(-1).sourceHead,r.sourceHead);assert.equal(f.store.taskFile('Fixture',c.id),null);assert.equal(fs.readdirSync(path.join(f.dir,'成果物/受取')).length,2);
});
test('継続受領→途中受領→継続受領は旧schema2と一式manifestを保持する',t=>{
 const f=fixture(t),c=unfinished(f,f.child('reverse'));f.write(path.join(f.dir,'作業',c.id,'nested/a.txt'),'a');f.write(path.join(f.dir,'作業',c.id,'nested/b.txt'),'b');
 receiveMode(f,'continue');const first=f.transfer.read('Fixture',c.id),manifest=first.received[0].bundles;assert.ok(manifest.length);
 // Compatibility with v4.95.0: retained receipt had no received[] array.
 const legacy={...first};delete legacy.received;f.transfer.save(legacy);
 f.write(path.join(c.workdir,'later.txt'),'later');git.save(c.workdir,'later');offer(f,c);f.apply(f.preview());
 const second=f.transfer.read('Fixture',c.id);assert.deepEqual(second.received.map(x=>x.disposition),['continue','partial']);assert.equal(second.received[0].id,first.id);assert.equal(second.received[1].previous,first.id);
 f.write(path.join(c.workdir,'third.txt'),'third');git.save(c.workdir,'third');receiveMode(f,'continue');const third=f.transfer.read('Fixture',c.id);assert.equal(third.files.length,0);assert.deepEqual(third.received.map(x=>x.disposition),['continue','partial','continue']);
 const bundle=third.received[0].bundles[0];f.write(path.join(bundle.destination,'unexpected.txt'),'extra');
 f.write(path.join(c.workdir,'fourth.txt'),'fourth');git.save(c.workdir,'fourth');assert.throws(()=>receiveMode(f,'continue'),/以前受け取った成果/);assert.ok(f.store.taskFile('Fixture',c.id));assert.ok(fs.existsSync(c.workdir));
});
test('継続受領後も子・統合先の前回HEADを失った履歴は受領しない',t=>{
 const f=fixture(t),c=unfinished(f,f.child('ancestry'));receiveMode(f,'continue');const head=sh(c.workdir,'rev-parse','HEAD'),base=sh(c.workdir,'rev-list','--max-parents=0','HEAD');
 sh(c.workdir,'reset','--hard',base);assert.match(f.preview().items[0].blockers.join(),/前回の受領HEAD/);sh(c.workdir,'reset','--hard',head);
 sh(f.body,'reset','--hard',base);assert.match(f.preview().items[0].blockers.join(),/前回の受領HEAD/);assert.ok(f.store.taskFile('Fixture',c.id));
});
test('旧schema1の固定途中受領は明示再確認して元の範囲だけ復旧する',t=>{
 const f=fixture(t),c=unfinished(f,f.child('legacy-fixed'));offer(f,c);const head=sh(c.workdir,'rev-parse','HEAD');f.integrate.gitw={...git,merge:()=>{throw Error('stop legacy');}};assert.throws(()=>f.apply(f.preview()),/stop legacy/);
 const batch=f.integrate.read('Fixture',f.parent.id);delete batch.schemaVersion;f.integrate.save(batch);f.restart();
 const d=f.preview();assert.equal(d.legacy,true);assert.throws(()=>f.apply(d),/旧確認/);
 assert.equal(f.integrate.apply({project:'Fixture',task:f.parent.id,token:d.token,confirm:true,legacyConfirmed:true}).complete,true);assert.equal(f.transfer.read('Fixture',c.id).received[0].head,head);assert.ok(fs.existsSync(c.workdir));
});

test('渡し済みの途中成果を同じ確認から全体受領・片付けへ拡大しない',t=>{
 const f=fixture(t),c=unfinished(f,f.child('fixed-mode'));offer(f,c);const d=f.preview(),i=d.items[0];
 for(const mode of ['continue','cleanup'])assert.throws(()=>f.integrate.apply({project:'Fixture',task:f.parent.id,token:d.token,confirm:true,selected:[{project:'Fixture',task:c.id,disposition:mode,review:f.review(i)}]}),/固定範囲/);
 assert.equal(f.apply(d).complete,true);assert.ok(fs.existsSync(c.workdir));assert.equal(f.preview().items.length,0);assert.equal(f.preview().retainedItems[0].disposition,'continue');
});
