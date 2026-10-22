'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {Store}=require('../lib/store'),{Removal}=require('../lib/remove'),{TaskTransfer}=require('../lib/task-transfer'),{TaskIntegrate}=require('../lib/task-integrate'),{IntegrateAuto}=require('../lib/integrate-auto'),git=require('../lib/git'),chat=require('../lib/chat');
const g=(dir,...a)=>execFileSync('git',['-C',dir,...a],{encoding:'utf8',stdio:'pipe'}).trim();
function fixture(t){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-simple-')),oldTrash=process.env.HUB_TRASH;process.env.HUB_TRASH=path.join(root,'Trash');
 t.after(()=>{if(oldTrash===undefined)delete process.env.HUB_TRASH;else process.env.HUB_TRASH=oldTrash;fs.rmSync(root,{recursive:true,force:true});});
 const dir=path.join(root,'Product','Fixture'),body=path.join(root,'Body'),write=(f,s)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,s);return f;};
 write(path.join(dir,'PROJECT.md'),'---\nname: Fixture\n---\n');write(path.join(body,'.gitignore'),'node_modules/\n');write(path.join(body,'base'),'base');g(body,'init','-q');g(body,'config','user.name','Fixture');g(body,'config','user.email','fixture@localhost');g(body,'add','.');g(body,'commit','-qm','base');
 const store=new Store(root),parent=store.createTask('Fixture',{title:'親',steps:['親の未済']}),removal=new Removal({store,trash:path.join(root,'Trash')}),transfer=new TaskTransfer({store,removal,baseOf:()=>body}),integrate=new TaskIntegrate({store,transfer,removal,baseOf:()=>body});
 const pw=git.prepare({base:body,workRoot:removal.workRoot({id:'Fixture'}),taskId:parent.id});store.updateTask('Fixture',parent.id,{workdir:pw.dir});
 const mainHead=git.inspect(body).head,requests=[];let busy=false,mains=0;
 const auto=new IntegrateAuto({integrate,busy:()=>busy,dispatch:async r=>requests.push(r),mergeMain:async()=>{mains++;return {ok:true,retained:true};}});auto.pendingRequest=()=>true;
 const declaration=(id,rem={status:'なし',items:'なし',undecided:'なし',evidence:'隔離確認'})=>store.appendSection('Fixture',id,'残件申告','```json\n'+JSON.stringify(rem)+'\n```');
 const child=(title='子',opts={})=>{const c=store.createTask('Fixture',{title,parent:opts.parent||parent.id,steps:['完成','実機未確認']});store.setStep('Fixture',c.id,0,true);if(!opts.remaining)store.setStep('Fixture',c.id,1,true);
  const w=git.prepare({base:body,workRoot:removal.workRoot({id:'Fixture'}),taskId:c.id});store.updateTask('Fixture',c.id,{workdir:w.dir});write(path.join(w.dir,title+'.txt'),title);write(path.join(w.dir,'.hidden'),'hidden');git.save(w.dir,'child');write(path.join(w.dir,'node_modules','fixture'),'dependency');
  write(path.join(dir,'作業',c.id,'report.txt'),'report '+title);store.appendSection('Fixture',c.id,'成果','- なし：保存コードと報告');if(!opts.unknown)declaration(c.id,opts.remaining?{status:'あり',items:'実機未確認\n動作確認',undecided:'選択未決',evidence:'隔離資料'}:undefined);
  chat.append(dir,c.id,{role:'assistant',text:'元会話'});return store.readTask(store.taskFile('Fixture',c.id));};
 const preview=()=>auto.preview({project:'Fixture',task:parent.id,simple:true});
 const start=(keep=false,mode='single',selected)=>{const d=preview();return integrate.apply({project:'Fixture',task:parent.id,token:d.token,confirm:true,auto:true,thenMain:false,mode,selected:selected||d.items.map(i=>({project:i.project,task:i.task,keep}))});};
 const r=()=>integrate.read('Fixture',parent.id);
 const settle=(req,text)=>auto.settled(req,{text,ai:'fixture',model:'fixture',...(req.isolatedReview?{integrationAuto:{closed:true,isolation:{version:1,resumed:false,request:req.requestKey}}}:{})});
 const finish=async(expectedMainHead=mainHead)=>{let seen=0;for(let n=0;n<15&&!r()?.auto.stopped&&r()?.auto.main?.state!=='done';n++){await auto.tick();for(;seen<requests.length;seen++){const q=requests[seen],m=q.text.match(/\[integration-auto:([a-f0-9]{64}):(\w+)\]/);if(r().auto.attempts[m[1]]?.phase==='verified')continue;if(m[2]==='review')settle(q,`[integration-review:${m[1]}:pass]`);else if(m[2]==='order'){const items=r().items.slice().sort((a,b)=>b.depth-a.depth);settle(q,`[integration-order:${m[1]}:${JSON.stringify(items.map(i=>i.project+'/'+i.task))}]`);}else throw Error('Unexpected phase '+m[2]);}}
  assert.equal(r().auto.stopped,undefined,JSON.stringify(r().auto.stopped));assert.equal(r().auto.main.state,'done');assert.equal(git.inspect(body).head,expectedMainHead);assert.equal(mains,0);};
 return {root,dir,body,copy:pw.dir,store,parent,removal,transfer,integrate,auto,requests,write,child,declaration,preview,start,r,settle,finish,setBusy:x=>busy=x};
}
test('受領後の完了承認：管理情報だけの変更は未受領に戻らず、別子だけを候補にする',async t=>{
 const f=fixture(t),c=f.child('完了対象');f.start(true);await f.finish();
 const before=f.preview(),receipt=fs.readFileSync(f.transfer.file('Fixture',c.id),'utf8');
 assert.equal(before.items.find(i=>i.task===c.id).alreadyReceived,true);
 const child=f.store.readTask(f.store.taskFile('Fixture',c.id));
 const approved=f.store.decideTask('Fixture',c.id,'approve',child.completionHash);
 assert.equal(approved.state,'完了');assert.notEqual(approved.completionHash,child.completionHash);
 const other=f.child('次の子'),current=f.preview();
 assert.deepEqual(current.items.map(i=>i.task),[other.id]);
 const offer=f.transfer.offers().find(x=>x.task===c.id&&x.targetTask===f.parent.id);
 assert.equal(offer.pending,false);assert.equal(offer.received.head,git.inspect(c.workdir).head);
 assert.equal(fs.readFileSync(f.transfer.file('Fixture',c.id),'utf8'),receipt,'表示のために旧受領を書き換えない');
 assert.ok(fs.existsSync(c.workdir));assert.ok(fs.existsSync(path.join(f.dir,'.ai/chat',c.id+'.jsonl')));
 assert.deepEqual(f.preview().items.map(i=>i.task),[other.id],'再読込でも戻らない');
 assert.throws(()=>f.auto.apply({project:'Fixture',task:f.parent.id,token:before.token,auto:true,confirm:true,thenMain:false,mode:'single',selected:[{project:'Fixture',task:c.id,keep:false}]}));
});
test('完了だけでは受領済みにしない／正式再開した受領済みの子は候補へ戻す',async t=>{
 const f=fixture(t),c=f.child('再開対象');f.start(true);await f.finish();
 let child=f.store.readTask(f.store.taskFile('Fixture',c.id));child=f.store.decideTask('Fixture',c.id,'approve',child.completionHash);
 assert.equal(f.preview().items.length,0);
 f.store.decideTask('Fixture',c.id,'continue',child.completionHash);
 assert.equal(f.preview().items.find(i=>i.task===c.id).alreadyReceived,false);
 const n=f.child('未受領完了');f.store.decideTask('Fixture',n.id,'approve',n.completionHash);
 assert.equal(f.preview().items.find(i=>i.task===n.id).alreadyReceived,false);
});
test('受領後に保持選択を変えてから完了承認しても再掲しない',async t=>{
 const f=fixture(t),c=f.child('保持選択後完了');f.start(true);await f.finish();
 for(const keep of [false,true])f.integrate.simple.saveKeep({project:'Fixture',task:f.parent.id,childProject:'Fixture',childTask:c.id,keep});
 const child=f.store.readTask(f.store.taskFile('Fixture',c.id));f.store.decideTask('Fixture',c.id,'approve',child.completionHash);
 assert.equal(f.preview().items.length,0);assert.equal(f.transfer.offers()[0].pending,false);
});
for(const change of ['body','result','source','file','mode','receipt-text','receipt-hash','receipt-id'])test('完了承認で実変更・破損を隠さない：'+change,async t=>{
 const f=fixture(t),c=f.child('変更対象');f.start(true);await f.finish();
 const file=f.store.taskFile('Fixture',c.id);let child=f.store.readTask(file);f.store.decideTask('Fixture',c.id,'approve',child.completionHash);
 if(change==='body')f.store.appendSection('Fixture',c.id,'やったこと','追加の作業');
 if(change==='result')f.store.appendSection('Fixture',c.id,'成果','- なし：追加成果の説明');
 if(change==='source'){f.write(path.join(c.workdir,'new-code'),'new');git.save(c.workdir,'new code');}
 if(change==='file')f.write(path.join(f.dir,'作業',c.id,'report.txt'),'changed');
 if(change==='mode')fs.chmodSync(path.join(f.dir,'作業',c.id,'report.txt'),0o600);
 if(change.startsWith('receipt-')){const r=f.transfer.read('Fixture',c.id);if(change==='receipt-text')r.retention.text+='\nchanged';if(change==='receipt-hash')r.retention.after='wrong';if(change==='receipt-id')r.id='another';f.transfer.save(r);}
 // Even approving an edited document must not acknowledge its new content.
 child=f.store.readTask(file);if(child.state!=='完了')f.store.decideTask('Fixture',c.id,'approve',child.completionHash);
 assert.equal(f.preview().items.find(i=>i.task===c.id)?.alreadyReceived,false);
 assert.equal(f.transfer.offers().find(x=>x.task===c.id&&x.targetTask===f.parent.id).pending,true);
});
for(const change of ['parent-note','child-updated','target-mtime'])test('安全範囲が同じ確認は記録・表示時刻・mtimeだけでは失効しない：'+change,t=>{
 const f=fixture(t),c=f.child(),d=f.preview();
 if(change==='parent-note')f.store.appendSection('Fixture',f.parent.id,'メモ','表示確認の記録だけ');
 if(change==='child-updated'){const file=f.store.taskFile('Fixture',c.id);fs.writeFileSync(file,require('../lib/frontmatter').setScalar(fs.readFileSync(file,'utf8'),'updated','2099-01-01'));}
 if(change==='target-mtime'){const file=path.join(f.copy,'base'),s=fs.statSync(file);fs.utimesSync(file,s.atime,new Date(s.mtimeMs+3000));}
 const out=f.auto.apply({project:'Fixture',task:f.parent.id,token:d.token,auto:true,confirm:true,thenMain:false,mode:'single',selected:[{project:'Fixture',task:c.id,keep:true}]});
 assert.equal(out.partial,true);assert.equal(f.r().items[0].taskHash,f.store.readTask(f.store.taskFile('Fixture',c.id)).completionHash,'receipt captures latest original, not the old full-text hash');
});
test('旧同HEADの合格なしは隔離確認へ一度だけ移行し、旧結果/本体不明を保全して正式保持受領',async t=>{
 const f=fixture(t),c=f.child('旧会話確認');f.start(true);await f.auto.tick();const q=f.requests[0],k=q.review.key;
 const r=f.r();delete r.auto.attempts[k].isolatedReview;r.auto.attempts[k].delivery.state='accepted';
 const pending={id:'old',main:{state:'intent',sourceHead:'unchanged'},stopped:{reason:'旧本体不明'}};r.auto.pendingMain=pending;r.auto.stopped={reason:'独立確認の合格を確認できません'};f.integrate.save(r);
 const legacy={text:'技術照合は済み。同一文脈なので合格タグなし',integrationAuto:{key:k,phase:'review',closed:true}};
 f.auto.pendingRequest=()=>false;f.auto.savedCompletion=(r,key)=>key===k?legacy:null;
 const d=f.preview();assert.equal(d.resumeAllowed,true);const before=f.r();assert.deepEqual(f.r(),before);assert.equal(f.requests.length,1);
 const resumed=f.auto.resume({project:'Fixture',task:f.parent.id,token:d.token,confirm:true});assert.equal(resumed.resumed,true);
 const migrated=f.r(),next=migrated.auto.attempts[k].supersededBy;assert.ok(next);assert.notEqual(next,k);assert.equal(migrated.auto.attempts[next].contextRecovery,true);assert.deepEqual(migrated.auto.pendingMain,pending);assert.equal(legacy.text.includes(':pass]'),false);
 assert.throws(()=>f.auto.resume({project:'Fixture',task:f.parent.id,token:d.token,confirm:true}));
 await f.auto.tick();assert.equal(f.requests.length,2);const fresh=f.requests[1];assert.equal(fresh.isolatedReview,true);assert.equal(fresh.review.key,next);assert.equal(f.transfer.read('Fixture',c.id)?.complete,undefined);
 // A restart with an outstanding request observes it, without another dispatch.
 f.auto.pendingRequest=(r,key)=>key===next;await f.auto.tick();assert.equal(f.requests.length,2);
 f.settle(fresh,`[integration-review:${next}:pass]`);await f.auto.tick();assert.equal(f.r().complete,true);assert.equal(f.transfer.read('Fixture',c.id).retained,true);assert.deepEqual(f.r().auto.pendingMain,pending);assert.ok(fs.existsSync(c.workdir));assert.equal(f.requests.length,2);
});
for(const kind of ['unknown','open','isolated-fail','forged-pass'])test('旧確認の復旧ガード：'+kind,async t=>{
 const f=fixture(t);f.child('確認拒否');f.start(true);await f.auto.tick();const q=f.requests[0],k=q.review.key,r=f.r();
 if(kind!=='isolated-fail'&&kind!=='forged-pass')delete r.auto.attempts[k].isolatedReview;
 r.auto.attempts[k].delivery.state=kind==='unknown'?'unknown':'accepted';r.auto.stopped={reason:'停止'};f.integrate.save(r);f.auto.pendingRequest=()=>false;
 f.auto.savedCompletion=()=>({text:kind==='forged-pass'?`[integration-review:${k}:pass]`:'合格なし',integrationAuto:{key:k,phase:'review',closed:kind!=='open',isolation:{version:1,resumed:true,request:q.requestKey}}});
 const before=f.r(),d=f.preview();assert.equal(d.resumeAllowed,false);assert.equal(d.token,undefined);assert.deepEqual(f.r(),before);assert.equal(f.requests.length,1);
});
test('保存なしは残さない、radio保存・再読込、保持/途中受領の人の選択は残す',t=>{
 const f=fixture(t),a=f.child('A'),b=f.child('B'),c=f.child('C');assert.ok(f.preview().items.every(i=>!i.keep));
 f.integrate.simple.saveKeep({project:'Fixture',task:f.parent.id,childProject:'Fixture',childTask:a.id,keep:true});assert.equal(f.preview().items.find(i=>i.task===a.id).keep,true);
 f.transfer.save({project:'Fixture',task:b.id,partial:true});f.transfer.save({project:'Fixture',task:c.id,retained:true});assert.ok(f.preview().items.every(i=>i.keep));
 f.integrate.simple.saveKeep({project:'Fixture',task:f.parent.id,childProject:'Fixture',childTask:c.id,keep:false});assert.equal(f.preview().items.find(i=>i.task===c.id).keep,false);
 assert.throws(()=>f.integrate.simple.saveKeep({project:'Fixture',task:f.parent.id,childProject:'Fixture',childTask:f.parent.id,keep:false}));
});
for(const keep of [false,true])test('1回開始・独立確認の後だけ正式受領、copy/会話/隠し物/依存物の保全：'+keep,async t=>{
 const f=fixture(t),c=f.child(),original=fs.readFileSync(f.store.taskFile('Fixture',c.id),'utf8');f.start(keep);await f.auto.tick();assert.equal(f.requests.length,1);assert.equal(f.r().items[0].state,'検証中');assert.ok(f.store.taskFile('Fixture',c.id));assert.equal(f.transfer.read('Fixture',c.id).receiving,undefined);
 await f.finish();const r=f.r(),receipt=f.transfer.read('Fixture',c.id);assert.equal(receipt.retained===true,keep);assert.equal(fs.existsSync(c.workdir),keep);
 if(keep){assert.ok(f.store.taskFile('Fixture',c.id));assert.equal(chat.read(f.dir,c.id)[0].text,'元会話');}else{assert.equal(f.store.taskFile('Fixture',c.id),null);assert.equal(fs.readFileSync(path.join(r.items[0].copyTrashed,'.hidden'),'utf8'),'hidden');assert.equal(fs.readFileSync(path.join(r.items[0].copyTrashed,'node_modules','fixture'),'utf8'),'dependency');const cleanup=f.removal.recover(JSON.parse(fs.readFileSync(path.join(f.removal.records,receipt.cleanup+'.json'),'utf8')));assert.ok(cleanup.entries.some(e=>e.from.endsWith(c.id+'.md')&&fs.readFileSync(e.to,'utf8').includes('## 手順')));assert.ok(cleanup.entries.some(e=>e.from.endsWith(c.id+'.jsonl')&&fs.readFileSync(e.to,'utf8').includes('元会話')));assert.ok(original.includes('実機未確認'));}
 assert.equal(chat.read(f.dir,f.parent.id).filter(x=>x.handoff).length,1);
});
test('残件と未済手順は原文/権限付きJSONと親uncheckedへ移管、重複0',async t=>{
 const f=fixture(t),c=f.child('残件子',{remaining:true});fs.chmodSync(f.store.taskFile('Fixture',c.id),0o640);f.start(false);await f.finish();const i=f.r().items[0],m=f.r().auto.migrations['Fixture\0'+c.id],b=JSON.parse(fs.readFileSync(m.file,'utf8')),parent=fs.readFileSync(f.store.taskFile('Fixture',f.parent.id),'utf8');assert.equal(m.state,'done');assert.equal(b.mode,0o640);assert.equal(fs.statSync(m.file).mode&0o777,0o640);assert.match(b.text,/- \[ \] 実機未確認/);assert.equal(m.steps.length,3);assert.equal((parent.match(/から移管：実機未確認/g)||[]).length,1);assert.ok(m.steps.every(s=>parent.includes(s)&&s.startsWith('- [ ]')));assert.ok(f.store.readTask(f.store.taskFile('Fixture',f.parent.id)).steps.every(s=>!s.done));assert.equal(f.transfer.read('Fixture',c.id).review.evidence,m.relative);assert.ok(i.copyTrashed);
});
for(const mode of ['complete-intent','missing-line','missing-json','changed-mode'])test('移管intentの照合再開・無再追記：'+mode,async t=>{
 const f=fixture(t),c=f.child('残件子',{remaining:true});f.start(false);await f.auto.tick();const r=f.r(),i=r.items[0];f.integrate.simple.migration(r,i);const m=r.auto.migrations['Fixture\0'+c.id],file=f.store.taskFile('Fixture',f.parent.id);m.state='intent';f.integrate.save(r);let parent=fs.readFileSync(file,'utf8');
 if(mode==='missing-line'){parent=parent.replace(m.steps[0]+'\n','');fs.writeFileSync(file,parent);}if(mode==='missing-json')fs.unlinkSync(m.file);if(mode==='changed-mode')fs.chmodSync(m.file,0o600);const before=fs.readFileSync(file,'utf8');
 if(mode==='complete-intent'){f.integrate.simple.migration(r,i);assert.equal(m.state,'done');assert.equal(fs.readFileSync(file,'utf8'),before);}else{assert.throws(()=>f.integrate.simple.migration(r,i),/再送/);assert.equal(fs.readFileSync(file,'utf8'),before);}
});
for(const complete of [true,false])test('不明残件は子の整理を一度だけ依頼、完了根拠を照合：'+complete,async t=>{
 const f=fixture(t),c=f.child('不明',{unknown:true});f.start(true);await f.auto.tick();const q=f.requests[0];assert.equal(q.task,c.id);assert.equal(q.organize,true);await f.auto.tick();assert.equal(f.requests.length,1);if(complete)f.declaration(c.id);f.settle(q,'整理完了');if(complete)await f.finish();else{assert.ok(f.r().auto.stopped);await f.auto.tick();assert.equal(f.requests.length,1);}
});
for(const mode of ['batch','selected'])for(const wrong of ['missing','duplicate','extra','reversed','marker'])test(mode+'順の過不足・子孫逆順・marker違いは停止して再依頼0：'+wrong,async t=>{
 const f=fixture(t),mid=f.child('中間'),leaf=f.child('孫',{parent:mid.id});f.start(false,mode);await f.auto.tick();const q=f.requests[0],k=q.text.match(/integration-auto:([a-f0-9]{64}):order/)[1],keys=['Fixture/'+leaf.id,'Fixture/'+mid.id];if(wrong==='missing')keys.pop();if(wrong==='duplicate')keys[1]=keys[0];if(wrong==='extra')keys.push('Fixture/no');if(wrong==='reversed')keys.reverse();
 f.settle(q,`[integration-order:${wrong==='marker'?'f'.repeat(64):k}:${JSON.stringify(keys)}]`);assert.ok(f.r().auto.stopped);await f.auto.tick();assert.equal(f.requests.length,1);assert.ok(f.store.taskFile('Fixture',mid.id)&&f.store.taskFile('Fixture',leaf.id));
});
test('未完了の中間親も残件を移し、AI保存順の孫→親で一括完走',async t=>{
 const f=fixture(t),mid=f.child('中間',{remaining:true}),leaf=f.child('孫',{parent:mid.id,remaining:true});f.start(false,'batch');await f.finish();assert.equal(f.r().items[0].task,leaf.id);assert.equal(f.requests.filter(q=>q.role==='司令塔').length,1);assert.ok(f.r().items.every(i=>i.state==='片付け済み'));assert.equal(Object.keys(f.r().auto.migrations).length,2);
});
test('祖先を残さない/孫を残すは開始前拒否、値を勝手に変えない',t=>{
 const f=fixture(t),mid=f.child('中間'),leaf=f.child('孫',{parent:mid.id}),d=f.preview();assert.throws(()=>f.integrate.apply({project:'Fixture',task:f.parent.id,token:d.token,auto:true,confirm:true,mode:'batch',selected:d.items.map(i=>({project:i.project,task:i.task,keep:i.task===leaf.id}))}),/下に残す子/);assert.equal(f.r(),null);assert.equal(f.store.readTask(f.store.taskFile('Fixture',mid.id)).integrateKeep,undefined);
});
test('1件の一括に順序AI不要、保持済みはnoop/片付け時の新受領ファイル0/merge0/本体再依頼0',async t=>{
 const f=fixture(t),c=f.child();f.start(true,'batch');await f.finish();assert.equal(f.requests.filter(q=>q.role==='司令塔').length,0);const old=f.transfer.read('Fixture',c.id),head=git.inspect(f.copy).head,files=old.files.map(x=>[x.to,fs.readFileSync(x.to,'utf8')]);assert.equal(f.preview().items[0].noop,true);f.integrate.simple.saveKeep({project:'Fixture',task:f.parent.id,childProject:'Fixture',childTask:c.id,keep:false});f.requests.length=0;const d=f.preview();f.integrate.apply({project:'Fixture',task:f.parent.id,token:d.token,confirm:true,auto:true,thenMain:true,mode:'single',selected:[{project:'Fixture',task:c.id,keep:false}]});assert.equal(f.r().auto.thenMain,false);await f.finish();const receipt=f.transfer.read('Fixture',c.id);assert.equal(receipt.files.length,0);assert.equal(f.requests.length,0);assert.equal(git.inspect(f.copy).head,head);assert.ok(receipt.received.some(x=>x.id===old.id));for(const [file,text]of files)assert.equal(fs.readFileSync(file,'utf8'),text);
});
for(const change of ['keep','file','head','question'])test('開始後の保持・成果・HEAD・質問変更で停止、原物を保持：'+change,async t=>{
 const f=fixture(t),c=f.child();f.start(false);if(change==='keep')f.store.updateTask('Fixture',c.id,{integrateKeep:true});if(change==='question')f.store.updateTask('Fixture',c.id,{question:'人判断'});if(change==='file')f.write(path.join(f.dir,'作業',c.id,'report.txt'),'changed');if(change==='head'){f.write(path.join(c.workdir,'changed'),'new');git.save(c.workdir,'new');}await f.auto.tick();assert.ok(f.r().auto.stopped);assert.equal(f.requests.length,0);assert.ok(fs.existsSync(c.workdir));
});
test('対象AIの稼働は個別・選別・一括を待機させ、終了後の再確認で開始できる',async t=>{
 const f=fixture(t),c=f.child(),busy=f.removal.busy;f.removal.busy=(p,t)=>t===c.id;f.auto.waitStatus=b=>b.selected?.length===0?[]:[{kind:'chat',project:'Fixture',task:c.id,message:'子が稼働中'}];const d=f.preview();assert.ok(d.token);assert.ok(d.items[0].waiting.length);
 for(const mode of ['single','selected','batch'])assert.throws(()=>f.auto.apply({project:'Fixture',task:f.parent.id,token:d.token,auto:true,confirm:true,mode,selected:[{project:'Fixture',task:c.id,keep:d.items[0].keep}]}),/子が稼働中/);assert.equal(f.r(),null);
 f.removal.busy=busy;f.auto.waitStatus=()=>[];f.start(true);await f.finish();f.auto.waitStatus=()=>[{kind:'chat',project:'Fixture',task:f.parent.id,message:'親が稼働中'}];assert.equal(f.preview().token,undefined);
});
test('前回受領後の対象AIも待機し、終了後に新候補だけ開始・旧受領と本体は再処理0',async t=>{
 const f=fixture(t),old=f.child('前回');f.start(true);await f.finish();const previous=f.r(),receipt=JSON.stringify(f.transfer.read('Fixture',old.id)),count=f.requests.length,c=f.child('次回'),busy=f.removal.busy;
 f.removal.busy=(p,t)=>t===c.id;f.auto.waitStatus=b=>b.selected?.length===0?[]:[{kind:'chat',project:'Fixture',task:c.id,message:'子が稼働中'}];const d=f.preview();assert.ok(d.token);assert.ok(d.items.find(i=>i.task===c.id).waiting.length);assert.throws(()=>f.auto.apply({project:'Fixture',task:f.parent.id,token:d.token,auto:true,confirm:true,mode:'single',selected:[{project:'Fixture',task:c.id,keep:true}]}),/子が稼働中/);assert.equal(f.r().id,previous.id);
 f.removal.busy=busy;f.auto.waitStatus=()=>[];f.start(true,'single',[{project:'Fixture',task:c.id,keep:true}]);await f.finish();assert.equal(f.requests.length,count+1);assert.equal(JSON.stringify(f.transfer.read('Fixture',old.id)),receipt);assert.equal(f.transfer.read('Fixture',c.id).retained,true);
});
test('前回完了後も親・無関係AI・進行中処理は予約tokenなし、発行済みtokenも無効',async t=>{
 const f=fixture(t);f.child('前回');f.start(true);await f.finish();const c=f.child('次回'),record=JSON.stringify(f.r());
 for(const kind of ['chat','terminal','background','queue','cli']){f.auto.waitStatus=b=>b.selected?.length===0?[]:[{kind,project:'Fixture',task:c.id,message:'子が稼働中'}];const d=f.preview();assert.ok(d.token);assert.ok(d.items.find(i=>i.task===c.id).waiting.length);}
 for(const blocker of [{kind:'chat',project:'Fixture',task:f.parent.id,message:'親が稼働中'},{kind:'queue',project:'別プロジェクト',task:'別作業',message:'別のAIが順番待ち'},{kind:'integration',project:'Fixture',task:c.id,message:'統合処理中'}]){
  f.auto.waitStatus=()=>[];const token=f.preview().token;f.auto.waitStatus=()=>[{kind:'chat',project:'Fixture',task:c.id,message:'子が稼働中'},blocker];assert.equal(f.preview().token,undefined);assert.equal(f.integrate.tokens.has(token),false);
 }
 f.auto.waitStatus=()=>[{kind:'chat',project:'Fixture',task:c.id,message:'子が稼働中'}];f.auto.active=true;assert.equal(f.preview().token,undefined);f.auto.active=false;f.integrate.active=true;assert.equal(f.preview().token,undefined);f.integrate.active=false;assert.equal(JSON.stringify(f.r()),record);
});
test('未完了の子受領は新規予約せず同じ記録を保持、開始再送0',async t=>{
 const f=fixture(t);f.child('前回');f.start(true);const c=f.child('次回'),record=JSON.stringify(f.r()),count=f.requests.length;f.auto.waitStatus=()=>[{kind:'chat',project:'Fixture',task:c.id,message:'子が稼働中'}];const d=f.preview();assert.equal(d.token,undefined);assert.equal(d.resume,true);assert.equal(f.r().id,d.id);assert.throws(()=>f.start(true,'single',[{project:'Fixture',task:c.id,keep:true}]));assert.equal(f.requests.length,count);assert.equal(JSON.stringify(f.r()),record);
});
for(const mode of ['single','selected'])for(const state of ['pending','not-sent','intent'])for(const keep of [false,true])test('子受領完了と本体待ちを分離、新候補だけ受領し旧本体/子の再送0：'+mode+'/'+state+'/'+keep,async t=>{
 const f=fixture(t),old=f.child('前回');f.start(keep);await f.finish();const previous=f.r();previous.auto.thenMain=true;previous.auto.main={state,sourceHead:git.inspect(f.copy).head};previous.auto.stopped={reason:state==='not-sent'?'本体取り込みの前提を確認できません':'旧本体停止',at:'original'};f.integrate.save(previous);
 const record=JSON.stringify(f.r()),receipt=JSON.stringify(f.transfer.read('Fixture',old.id)),count=f.requests.length;
 const only=f.preview();assert.equal(only.resume,undefined);assert.equal(only.auto,undefined);assert.equal(only.mainPending.id,previous.id);assert.equal(only.mainPending.main.state,state);assert.equal(only.items.length,keep?1:0);if(keep)assert.equal(only.items[0].noop,true);
 const pending=f.integrate.pending()[0];assert.equal(pending.stage,'main');assert.deepEqual(pending.items,[]);assert.equal(pending.mainPending.id,previous.id);await f.auto.tick();assert.equal(JSON.stringify(f.r()),record);assert.equal(f.requests.length,count);
 if(state==='intent')assert.throws(()=>f.auto.resume({project:'Fixture',task:f.parent.id,token:only.token}),/再送/);
 const c=f.child('次回');f.auto.waitStatus=b=>b.selected?.length===0?[]:[{kind:'chat',project:'Fixture',task:c.id,message:'子が稼働中'}];const d=f.preview();assert.ok(d.token);assert.deepEqual(d.waiting,[]);assert.ok(d.items.find(i=>i.task===c.id).startable);assert.equal(d.items.find(i=>i.task===c.id).waiting.length,1);assert.equal(d.resume,undefined);f.auto.waitStatus=()=>[];
 if(mode==='selected')f.integrate.simple.saveKeep({project:'Fixture',task:f.parent.id,childProject:'Fixture',childTask:c.id,keep:true});
 f.start(true,mode,[{project:'Fixture',task:c.id,keep:true}]);assert.equal(f.r().auto.thenMain,false);assert.deepEqual(f.r().items.map(i=>i.task),[c.id]);assert.equal(f.r().auto.pendingMain.id,previous.id);
 const archived=JSON.parse(fs.readFileSync(path.join(f.integrate.dir,'history',previous.id+'.json'),'utf8'));assert.equal(JSON.stringify(archived),record);await f.finish();
 assert.equal(f.requests.length,count+1);assert.equal(JSON.stringify(f.transfer.read('Fixture',old.id)),receipt);assert.equal(f.r().auto.pendingMain.main.state,state);assert.equal(f.integrate.pending()[0].stage,'main');assert.deepEqual(f.integrate.pending()[0].items,[]);
 const next=f.preview();assert.equal(next.resume,undefined);assert.equal(next.mainPending.id,previous.id);assert.ok(next.items.every(i=>i.noop));const before=JSON.stringify(f.r());await f.auto.tick();await f.auto.tick();assert.equal(JSON.stringify(f.r()),before);assert.equal(f.requests.length,count+1);
});
test('新候補のtokenは本体待ち記録の変更で無効、旧intentや選択を上書きしない',async t=>{
 const f=fixture(t);f.child('前回');f.start(false);await f.finish();const old=f.r();old.auto.thenMain=true;old.auto.main={state:'intent'};old.auto.stopped={reason:'不明',at:'old'};f.integrate.save(old);const c=f.child('次回'),d=f.preview();const changed=f.r();changed.auto.stopped.at='changed';f.integrate.save(changed);const before=JSON.stringify(f.r());assert.throws(()=>f.integrate.apply({project:'Fixture',task:f.parent.id,token:d.token,auto:true,confirm:true,mode:'single',selected:[{project:'Fixture',task:c.id,keep:true}]}),/別の統合/);assert.equal(JSON.stringify(f.r()),before);assert.equal(f.store.readTask(f.store.taskFile('Fixture',c.id)).integrateKeep,undefined);
});
test('整理の拒否・通信不明はintent保存後に停止し、再委任0',async t=>{
 const f=fixture(t);f.child('不明',{unknown:true});let calls=0;f.auto.dispatch=async()=>{calls++;throw Error('通信不明');};f.start(false);await f.auto.tick();assert.equal(calls,1);assert.ok(f.r().auto.stopped);await f.auto.tick();assert.equal(calls,1);assert.ok(Object.values(f.r().auto.attempts).some(x=>x.phase==='organize'));
});
test('途中成果を残す：保存範囲だけ受領し子/会話/残手順は継続',async t=>{
 const f=fixture(t),c=f.child('途中',{remaining:true}),d=f.transfer.offerPreview('Fixture',c.id);assert.deepEqual(d.blockers,[]);f.transfer.offer({project:'Fixture',task:c.id,token:d.token,confirm:true,selected:d.selected});assert.equal(f.preview().items[0].keep,true);f.start(true);await f.finish();assert.equal(f.r().items[0].state,'受領済み');assert.ok(f.store.taskFile('Fixture',c.id));assert.ok(fs.existsSync(c.workdir));assert.equal(f.store.readTask(f.store.taskFile('Fixture',c.id)).steps[1].done,false);
});
for(const keep of [false,true])test('正式受領完了直後の記録中断は保存済み受領から復旧、再受領/再委任0：'+keep,async t=>{
 const f=fixture(t),c=f.child('中断',{remaining:!keep}),original=f.transfer.receiveIntegrated.bind(f.transfer);let once=true;
 f.transfer.receiveIntegrated=o=>{const out=original(o);if(once){once=false;throw Error('受領後の記録中断');}return out;};
 f.start(keep);await f.auto.tick();f.settle(f.requests[0],`[integration-review:${f.requests[0].text.match(/integration-auto:([a-f0-9]{64})/)[1]}:pass]`);await f.auto.tick();assert.ok(f.r().auto.stopped);const receipt=f.transfer.read('Fixture',c.id);assert.ok(receipt.complete);
 const d=f.preview();assert.equal(f.auto.resume({project:'Fixture',task:f.parent.id,token:d.token}).resumed,true);const count=f.requests.length;await f.finish();assert.equal(f.requests.length,count);assert.equal(f.transfer.read('Fixture',c.id).id,receipt.id);assert.equal(chat.read(f.dir,f.parent.id).filter(x=>x.handoff).length,1);
});
test('保持選択の受領hash証明は複数radio変更だけに有効、本文の変更では再確認が必要',async t=>{
 const f=fixture(t),c=f.child();f.start(true);await f.finish();for(const keep of [false,true,false])f.integrate.simple.saveKeep({project:'Fixture',task:f.parent.id,childProject:'Fixture',childTask:c.id,keep});assert.ok(f.preview().items[0].alreadyReceived);
 f.store.appendSection('Fixture',c.id,'メモ','未確認の本文変更');assert.equal(f.preview().items[0].alreadyReceived,false);
});

for(const legacy of [true,false])test('送信前拒否の正式再開→再起動→1回送信、旧記録と多重クリック防止：'+legacy,async t=>{
 const f=fixture(t),c=f.child('不明',{unknown:true});let count=0;
 f.auto.pendingRequest=()=>false;f.auto.probeRequest=()=>{};f.auto.deliveryEvidence=()=>({complete:true,sent:false,auditStart:'2000',auditEnd:'9999',sources:[]});
 f.auto.dispatch=async()=>{count++;throw Object.assign(Error('role は指定した AI が主担当の役割を選んでください'),{delivery:{state:'not-sent'}});};
 f.start(true);await f.auto.tick();assert.equal(count,1);let r=f.r(),k=Object.keys(r.auto.attempts)[0],a=r.auto.attempts[k];
 if(legacy){delete a.delivery;delete a.request;f.integrate.save(r);}
 const d=f.preview();assert.equal(d.resumeAllowed,true);assert.ok(d.token);assert.equal(f.auto.resume({project:'Fixture',task:f.parent.id,token:d.token}).resumed,true);assert.throws(()=>f.auto.resume({project:'Fixture',task:f.parent.id,token:d.token}));
 const restarted=new IntegrateAuto({integrate:f.integrate,dispatch:async q=>{count++;f.requests.push(q);return {ok:true,delivery:{state:'accepted'}};}});restarted.pendingRequest=()=>false;restarted.deliveryEvidence=f.auto.deliveryEvidence;restarted.probeRequest=f.auto.probeRequest;
 await restarted.tick();restarted.pendingRequest=()=>true;await restarted.tick();assert.equal(count,2);r=f.r();assert.equal(r.auto.stopped,undefined);a=r.auto.attempts[k];assert.equal(a.phase,'organize');assert.equal(a.delivery.state,'accepted');assert.equal(a.deliveryHistory.length,1);assert.equal(a.deliveryHistory[0].legacy,legacy);assert.equal(r.auto.stopHistory.length,1);assert.equal(a.retryReady,undefined);assert.equal(f.requests[0].role,'コーディング');assert.equal(f.requests[0].task,c.id);
 // Completion received while stopped stays in the conversation, then is consumed once.
 restarted.stop('Fixture',f.parent.id,'人が停止しました');f.declaration(c.id);restarted.savedCompletion=()=>({text:'整理完了'});assert.equal(restarted.preview({project:'Fixture',task:f.parent.id,simple:true}).resumeAllowed,true);
 const token=restarted.preview({project:'Fixture',task:f.parent.id,simple:true}).token;restarted.resume({project:'Fixture',task:f.parent.id,token});await restarted.tick();assert.equal(count,2);assert.equal(f.r().auto.attempts[k].phase,'verified');assert.equal(f.r().auto.stopped,undefined);
});
for(const changed of ['task','keep','file','head'])test('未送信でも停止後の子変更は復旧を拒否し、attempt削除/送信0：'+changed,async t=>{
 const f=fixture(t),c=f.child('不明',{unknown:true});f.auto.pendingRequest=()=>false;f.auto.probeRequest=()=>{};f.auto.deliveryEvidence=()=>({complete:true,sent:false});f.auto.dispatch=async()=>{throw Object.assign(Error('開始前拒否'),{delivery:{state:'not-sent'}});};f.start(true);await f.auto.tick();
 if(changed==='task')f.store.appendSection('Fixture',c.id,'メモ','後から変更');if(changed==='keep')f.store.updateTask('Fixture',c.id,{integrateKeep:false});if(changed==='file')f.write(path.join(f.dir,'作業',c.id,'report.txt'),'changed');if(changed==='head'){f.write(path.join(c.workdir,'changed'),'changed');git.save(c.workdir,'changed');}
 const before=JSON.stringify(f.r()),d=f.preview();assert.equal(d.resumeAllowed,false);assert.equal(d.token,undefined);assert.throws(()=>f.auto.resume({project:'Fixture',task:f.parent.id,token:'invalid'}));assert.equal(JSON.stringify(f.r()),before);assert.equal(f.requests.length,0);
});

for(const race of ['source-change','target-change','completion','queued'])test('再開受付と送信の間に変わった前提・遅着結果を再照合して再送0：'+race,async t=>{
 const f=fixture(t),c=f.child('不明',{unknown:true});let count=0;f.auto.pendingRequest=()=>false;f.auto.probeRequest=()=>{};f.auto.deliveryEvidence=()=>({complete:true,sent:false});f.auto.dispatch=async()=>{count++;throw Object.assign(Error('開始前拒否'),{delivery:{state:'not-sent'}});};f.start(true);await f.auto.tick();const d=f.preview();f.auto.resume({project:'Fixture',task:f.parent.id,token:d.token});
 if(race==='source-change')f.store.appendSection('Fixture',c.id,'メモ','再開後の変更');if(race==='target-change'){f.write(path.join(f.copy,'later-fix'),'changed');git.save(f.copy,'later');}if(race==='queued')f.auto.pendingRequest=()=>true;if(race==='completion'){f.declaration(c.id);f.auto.savedCompletion=()=>({text:'遅着した正式終了'});}
 await f.auto.tick();if(race!=='completion')await f.auto.tick();else {await f.integrate.simple.prepare(f.auto,f.r());}assert.equal(count,1);const r=f.r();if(['source-change','target-change'].includes(race))assert.ok(r.auto.stopped);if(race==='queued'){assert.equal(r.auto.stopped,undefined);assert.equal(Object.values(r.auto.attempts)[0].retryReady,undefined);}if(race==='completion'){assert.equal(r.auto.stopped,undefined);assert.equal(Object.values(r.auto.attempts)[0].phase,'verified');}
});
test('修正保存→正式保持本体反映後、未統合の旧停止だけ新基点を確認して受領まで完走',async t=>{
 const f=fixture(t),c=f.child('不明',{unknown:true});let count=0;f.auto.pendingRequest=()=>false;f.auto.probeRequest=()=>{};f.auto.deliveryEvidence=()=>({complete:true,sent:false,auditStart:'2000',auditEnd:'9999'});f.auto.dispatch=async()=>{count++;throw Object.assign(Error('role は指定した AI が主担当の役割を選んでください'),{delivery:{state:'not-sent'}});};f.start(true);await f.auto.tick();let r=f.r(),k=Object.keys(r.auto.attempts)[0],oldHead=r.auto.targetHead;delete r.auto.attempts[k].delivery;delete r.auto.attempts[k].request;f.integrate.save(r);
 f.write(path.join(f.copy,'resume-fix'),'fix');git.save(f.copy,'fix');const fixedHead=git.inspect(f.copy).head,before=JSON.stringify(f.r()),out=git.merge({dir:f.copy,workRoot:f.removal.workRoot({id:'Fixture'}),title:'fix',cleanup:false});assert.equal(out.ok,true);assert.ok(fs.existsSync(f.copy));assert.equal(JSON.stringify(f.r()),before);const appliedHead=git.inspect(f.body).head,d=f.preview();assert.equal(d.resumeAllowed,true);assert.equal(d.targetSnapshot.head,fixedHead);f.auto.resume({project:'Fixture',task:f.parent.id,token:d.token});assert.equal(f.r().auto.targetHead,fixedHead);assert.equal(f.r().auto.resumed.at(-1).previousTargetHead,oldHead);
 f.auto.dispatch=async q=>{count++;f.requests.push(q);return {delivery:{state:'accepted'}};};await f.auto.tick();assert.equal(count,2);f.declaration(c.id);f.settle(f.requests[0],'整理完了');f.auto.pendingRequest=()=>true;await f.finish(appliedHead);assert.equal(count,3);assert.equal(f.transfer.read('Fixture',c.id).retained,true);assert.equal(f.r().auto.thenMain,false);assert.equal(f.r().auto.attempts[k].deliveryHistory.length,1);
});
for(const stage of ['prepared','migration','integrated'])test('統合・移管開始後の基点変更は再開ボタンを出さず旧HEADを保持：'+stage,async t=>{
 const f=fixture(t);f.child('不明',{unknown:true});f.auto.pendingRequest=()=>false;f.auto.probeRequest=()=>{};f.auto.deliveryEvidence=()=>({complete:true,sent:false});f.auto.dispatch=async()=>{throw Object.assign(Error('開始前拒否'),{delivery:{state:'not-sent'}});};f.start(true);await f.auto.tick();const r=f.r();if(stage==='prepared')r.auto.prepared=true;if(stage==='migration')r.auto.migrations.x={state:'intent'};if(stage==='integrated')r.items[0].integrated={commit:r.auto.targetHead};f.integrate.save(r);f.write(path.join(f.copy,'fix'),'fix');git.save(f.copy,'fix');const before=JSON.stringify(f.r()),d=f.preview();assert.equal(d.resumeAllowed,false);assert.equal(d.token,undefined);assert.equal(JSON.stringify(f.r()),before);
});
test('再開プレビュー後に親の保存HEADが進んだら、再確認前に基点変更も送信もしない',async t=>{
 const f=fixture(t);f.child('不明',{unknown:true});f.auto.pendingRequest=()=>false;f.auto.probeRequest=()=>{};f.auto.deliveryEvidence=()=>({complete:true,sent:false});f.auto.dispatch=async()=>{throw Object.assign(Error('開始前拒否'),{delivery:{state:'not-sent'}});};f.start(true);await f.auto.tick();const d=f.preview(),before=JSON.stringify(f.r());f.write(path.join(f.copy,'fix'),'fix');git.save(f.copy,'fix');assert.throws(()=>f.auto.resume({project:'Fixture',task:f.parent.id,token:d.token}),/統合先が変わりました/);assert.equal(JSON.stringify(f.r()),before);
});

test('旧方式の完了子も別枠にし、completeだけで未受領の子を隠さない',async t=>{
 const f=fixture(t);f.child('前回');f.start(false);await f.finish();const r=f.r();delete r.auto.mode;r.auto.thenMain=true;r.auto.main={state:'intent'};r.auto.stopped={reason:'旧方式の不明',at:'old'};f.integrate.save(r);const before=JSON.stringify(f.r());assert.equal(f.preview().resume,undefined);assert.equal(f.preview().items.length,0);assert.equal(f.preview().mainPending.id,r.id);assert.equal(JSON.stringify(f.r()),before);
 r.items[0].state='受領中';f.integrate.save(r);assert.equal(f.integrate.pending()[0].stage,'children');assert.equal(f.preview().resume,true);
});
test('simple tokenから旧方式へ切替えて本体待ちガードを迂回する要求は無変更拒否',async t=>{
 const f=fixture(t);f.child();const d=f.preview();assert.throws(()=>f.integrate.apply({project:'Fixture',task:f.parent.id,token:d.token,confirm:true,auto:true,selected:d.items.map(i=>({project:i.project,task:i.task,disposition:'continue'}))}),/もう一度/);assert.equal(f.r(),null);
});

// Compare the real unselected task, conversation, artifacts and entire copy.
function untouched(f,c){
 const entries=[];
 const read=file=>{if(!fs.existsSync(file)){entries.push([file,null]);return;}const stat=fs.lstatSync(file);entries.push([file,stat.mode&0o777,stat.isDirectory()?null:fs.readFileSync(file).toString('base64')]);if(stat.isDirectory())for(const name of fs.readdirSync(file).sort())read(path.join(file,name));};
 for(const file of [f.store.taskFile('Fixture',c.id),path.join(f.dir,'.ai/chat',c.id+'.jsonl'),path.join(f.dir,'作業',c.id),c.workdir])read(file);
 return {entries,receipt:f.transfer.read('Fixture',c.id)};
}
const selectedRequest=(f,d,selected,extra={})=>f.integrate.apply({project:'Fixture',task:f.parent.id,token:d.token,auto:true,thenMain:false,confirm:true,mode:'selected',selected,...extra});
test('選別1件はその子だけを保持受領し、未選択の作業・会話・コピー・保持選択は全件不変',async t=>{
 const f=fixture(t),a=f.child('選択'),b=f.child('未選択',{remaining:true});
 f.integrate.simple.saveKeep({project:'Fixture',task:f.parent.id,childProject:'Fixture',childTask:a.id,keep:true});
 const before=untouched(f,b),d=f.preview();selectedRequest(f,d,[{project:'Fixture',task:a.id,keep:true}]);
 assert.equal(f.r().auto.mode,'selected');assert.deepEqual(f.r().items.map(i=>i.task),[a.id]);await f.finish();
 assert.equal(f.requests.filter(q=>q.role==='司令塔').length,0);assert.equal(f.transfer.read('Fixture',a.id).retained,true);assert.deepEqual(untouched(f,b),before);
});
test('選別複数は選択した件だけを順序判断・片付けし、未選択と保存済み保持値を変えない',async t=>{
 const f=fixture(t),a=f.child('A'),b=f.child('B'),c=f.child('未選択');
 f.integrate.simple.saveKeep({project:'Fixture',task:f.parent.id,childProject:'Fixture',childTask:c.id,keep:true});
 const before=untouched(f,c),d=f.preview();selectedRequest(f,d,[{project:'Fixture',task:b.id,keep:false},{project:'Fixture',task:a.id,keep:false}]);
 assert.deepEqual(f.r().items.map(i=>i.task),[b.id,a.id]);assert.ok(f.r().items.every(i=>i.choiceAtStart===undefined));
 await f.auto.tick();assert.equal(f.requests.length,1);const inputs=JSON.parse(f.requests[0].text.split('読む：')[1].split('\n')[0]);assert.deepEqual(inputs.map(i=>i.key),['Fixture/'+b.id,'Fixture/'+a.id]);
 const k=f.requests[0].text.match(/integration-auto:([a-f0-9]{64})/)[1];f.settle(f.requests[0],`[integration-order:${k}:${JSON.stringify(inputs.map(i=>i.key))}]`);await f.finish();
 assert.deepEqual(f.r().items.map(i=>i.task),[b.id,a.id]);assert.ok(f.r().items.every(i=>i.state==='片付け済み'));assert.deepEqual(untouched(f,c),before);
});
for(const kind of ['empty','missing','null','unknown','duplicate','keep','review','review-false','cleanupAudit','mode','confirm','auto','expired','blocked'])test('選別APIの不正入力はtokenを消費せず記録・保持値を変更しない：'+kind,t=>{
 const f=fixture(t),c=f.child();if(kind==='blocked')f.store.updateTask('Fixture',c.id,{question:'人判断'});
 const d=f.preview(),before=untouched(f,c),s={project:'Fixture',task:c.id,keep:false};let selected=[s],extra={};
 if(kind==='empty')selected=[];if(kind==='missing')selected=undefined;if(kind==='null')selected=[null];if(kind==='unknown')s.task='unknown';if(kind==='duplicate')selected=[s,{...s}];if(kind==='keep')s.keep=true;if(kind==='review')s.review={};if(kind==='review-false')s.review=false;if(kind==='cleanupAudit')s.cleanupAudit={};if(kind==='mode')extra.mode='invalid';if(kind==='confirm')extra.confirm=false;if(kind==='auto')extra.auto=false;if(kind==='expired')f.integrate.tokens.get(d.token).at-=600001;
 assert.throws(()=>selectedRequest(f,d,selected,extra));assert.equal(f.integrate.tokens.has(d.token),true);assert.equal(f.r(),null);assert.deepEqual(untouched(f,c),before);
});
test('保持受領済みnoopを保持値改変で選別対象に戻せない',async t=>{
 const f=fixture(t),c=f.child();f.start(true);await f.finish();const d=f.preview(),record=JSON.stringify(f.r()),before=untouched(f,c);assert.equal(d.items[0].noop,true);
 for(const keep of [true,false])assert.throws(()=>selectedRequest(f,d,[{project:'Fixture',task:c.id,keep}]));
 assert.equal(f.integrate.tokens.has(d.token),true);assert.equal(JSON.stringify(f.r()),record);assert.deepEqual(untouched(f,c),before);
});
for(const kind of ['missing-child','kept-child','both-cleanup','child-only'])test('選別の親子包含・子孫先・未選択親不変：'+kind,async t=>{
 const f=fixture(t),mid=f.child('中間'),leaf=f.child('孫',{parent:mid.id}),other=f.child('別の子');
 if(kind==='kept-child')f.integrate.simple.saveKeep({project:'Fixture',task:f.parent.id,childProject:'Fixture',childTask:leaf.id,keep:true});
 const d=f.preview(),before=untouched(f,kind==='child-only'?mid:other),s=c=>({project:'Fixture',task:c.id,keep:kind==='kept-child'&&c.id===leaf.id});
 const selected=kind==='missing-child'?[s(mid)]:kind==='child-only'?[s(leaf)]:[s(mid),s(leaf)];
 if(['missing-child','kept-child'].includes(kind)){assert.throws(()=>selectedRequest(f,d,selected),kind==='missing-child'?/も選ぶか/:/下に残す子/);assert.equal(f.r(),null);assert.equal(f.integrate.tokens.has(d.token),true);return;}
 selectedRequest(f,d,selected);assert.deepEqual(f.r().items.map(i=>i.task),kind==='child-only'?[leaf.id]:[leaf.id,mid.id]);await f.finish();assert.deepEqual(untouched(f,kind==='child-only'?mid:other),before);
});
test('選別停止→再開・再起動でもmodeと開始時scopeだけを保持し、新しい子を加えない',async t=>{
 const f=fixture(t),c=f.child(),unselected=f.child('未選択'),d=f.preview();selectedRequest(f,d,[{project:'Fixture',task:c.id,keep:false}]);
 await f.auto.tick();const scope=JSON.stringify(f.r().auto.scope),before=untouched(f,unselected);f.auto.stop('Fixture',f.parent.id,'隔離停止');const later=f.child('開始後の子'),laterBefore=untouched(f,later);
 const fresh=f.preview();assert.equal(fresh.auto.mode,'selected');assert.equal(f.auto.resume({project:'Fixture',task:f.parent.id,token:fresh.token}).resumed,true);
 const restarted=new IntegrateAuto({integrate:f.integrate,dispatch:async q=>f.requests.push(q)});restarted.pendingRequest=()=>true;await restarted.tick();
 assert.equal(f.r().auto.mode,'selected');assert.equal(JSON.stringify(f.r().auto.scope),scope);assert.deepEqual(f.r().items.map(i=>i.task),[c.id]);assert.deepEqual(untouched(f,unselected),before);assert.deepEqual(untouched(f,later),laterBefore);
});

function selectionUi(locale='ja'){
 const vm=require('node:vm'),elements=new Map(),events={},calls=[],timers=new Map();let timer=0;
 const el=s=>{if(!elements.has(s))elements.set(s,{hidden:false,disabled:false,innerHTML:'',textContent:'',dataset:{},insertAdjacentHTML(position,html){this.textContent+=html;}});return elements.get(s);};
 let preview={simple:true,token:'fixture',target:'copy',ancestorHash:'parent-hash',targetSnapshot:{head:'parent-head'},waiting:[],items:['A','B'].map((title,n)=>({project:'p',task:'c'+n,title,keep:false,startable:true,noop:false,taskHash:'child-hash-'+n,source:{head:'child-head-'+n},descendants:[]}))};
 const inputs=attribute=>preview.items.map((_,n)=>{const e=el(attribute+':'+n);e.dataset.index=String(n);return e;});
 const ctx=vm.createContext({HubIntegrationSelection:require('../public/integration-selection'),HubI18n:require('./ui-locale-fixture')(locale),console,$:el,esc:s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),transferError:e=>e.message,load:async()=>{},render(){},toast(){},setTimeout(fn,ms){timers.set(++timer,{fn,ms});return timer;},clearTimeout(id){timers.delete(id);},document:{hidden:false,body:{insertAdjacentHTML(){}},querySelectorAll:s=>s.endsWith('[data-integrate-select]')?inputs('select'):s.endsWith('[data-integrate-keep]')?inputs('keep'):s.endsWith('[data-integrate-action="single"]')?inputs('single'):[],addEventListener:(name,fn)=>events[name]=fn}});
 const run=s=>vm.runInContext(s,ctx);ctx.backend=async(route,body)=>{calls.push({route,body});if(route.endsWith('/preview'))return JSON.parse(JSON.stringify(preview));if(route.endsWith('/keep')){const i=preview.items.find(i=>i.task===body.childTask);i.keep=body.keep;i.taskHash+='saved';return {ok:true,keep:body.keep};}if(route.split('?')[0].endsWith('/wait'))return {waiting:[]};if(ctx.gate)await ctx.gate;if(ctx.failure)throw ctx.failure;return ctx.out===undefined?{partial:true}:ctx.out;};
 run(fs.readFileSync(path.join(__dirname,'../public/task-integrate.js'),'utf8'));run('api=backend');
 const click=(action,index=0)=>events.click({target:{closest:s=>s==='[data-integrate-action]'?{disabled:false,dataset:{integrateAction:action,index:String(index)}}:null}});
 const choose=(index,value=true)=>events.change({target:{dataset:{index:String(index)},checked:value,matches:s=>s==='[data-integrate-select]'}});
 return {ctx,run,el,events,calls,timers,click,choose,show:(project='p',task='parent')=>run(`showTaskIntegration(${JSON.stringify(project)},${JSON.stringify(task)})`),posts:()=>calls.filter(c=>c.route==='/api/task/integrate'),get preview(){return preview;},set preview(v){preview=v;}};
}
for(const locale of ['ja','zh-TW'])test('日繁の選択欄・0/1/複数件と選別送信は保存APIを呼ばず、既存2方式も維持：'+locale,async()=>{
 const f=selectionUi(locale);await f.show();const button=f.el('#integrate-sheet [data-integrate-action="selected"]');assert.equal(button.disabled,true);assert.equal(button.textContent,locale==='ja'?'選別統合（0件）':'選擇性整合（0 項）');await f.click('selected');assert.equal(f.posts().length,0);
 const html=f.el('#integrate-sheet').innerHTML;assert.match(html,locale==='ja'?/選ぶ/:/選取/);assert.match(html,/data-integrate-select/);assert.match(html,/data-integrate-action="single"/);assert.match(html,/data-integrate-action="batch"/);if(locale==='zh-TW')assert.doesNotMatch(html,/[\u3041-\u3096\u30a1-\u30fa]/);
 f.choose(1);assert.equal(button.disabled,false);assert.match(button.textContent,/1/);f.choose(0);assert.match(button.textContent,/2/);f.choose(0,false);assert.equal(f.calls.length,1);await f.click('selected');assert.equal(f.posts().length,1);assert.equal(f.posts()[0].body.mode,'selected');assert.deepEqual(JSON.parse(JSON.stringify(f.posts()[0].body.selected)),[{project:'p',task:'c1',keep:false}]);
 await f.show();assert.equal(f.run('integratePreview.items.some(i=>i.selected)'),false);
 const one=selectionUi(locale);one.preview.items[0].descendants=[{project:'p',task:'c1',title:'B'}];await one.show();await one.click('single');assert.equal(one.posts()[0].body.selected.length,2);
 const batch=selectionUi(locale);await batch.show();batch.choose(1);await batch.click('batch');assert.equal(batch.posts()[0].body.selected.length,2);
});
for(const locale of ['ja','zh-TW'])test('選別の未選択・保持子孫は日繁で送信前拒否し、親を残せば未選択を追加しない：'+locale,async()=>{
 const f=selectionUi(locale);f.preview.items[0].descendants=[{project:'p',task:'c1',title:'B<&'}];await f.show();f.choose(0);await f.click('selected');assert.equal(f.posts().length,0);assert.match(f.el('#integrate-status').textContent,locale==='ja'?/も選ぶか/:/一併選取/);
 f.preview.items[1].keep=true;await f.show();f.choose(1);await f.click('selected');assert.equal(f.posts().length,0);assert.match(f.el('#integrate-status').textContent,locale==='ja'?/下に残す子/:/有要保留的子作業/);
 f.preview.items[0].keep=true;await f.show();f.choose(1,false);await f.click('selected');assert.equal(f.posts().length,1);assert.equal(f.posts()[0].body.selected.length,1);
});
test('保持保存・再確認・待機解消で同じ選択を引継ぎ、無効/noop/消失を通知、閉鎖・別親で解除',async()=>{
 const f=selectionUi();await f.show();f.choose(0);f.choose(1);f.ctx.control={dataset:{index:'0'},value:'true',matches:s=>s==='[data-integrate-keep]'};await f.run('saveIntegrationKeep(control)');assert.equal(f.run('integratePreview.items.every(i=>i.selected)'),true);assert.equal(f.run('integratePreview.items[0].keep'),true);
 f.preview.waiting=[{message:'fixture busy'}];await f.show();assert.equal(f.el('select:0').disabled,true);f.preview.waiting=[];await f.run('integrationCheckWait()');assert.equal(f.run('integratePreview.items.every(i=>i.selected)'),true);assert.equal(f.el('select:0').disabled,false);
 f.preview.items[1].startable=false;await f.show();assert.equal(f.run('integratePreview.items[1].selected'),false);assert.match(f.el('#integrate-sheet').innerHTML,/選べなくなった作業を外しました：B/);
 f.preview.items[0].noop=true;await f.show();assert.equal(f.run('integratePreview.items.some(i=>i.selected)'),false);assert.match(f.el('#integrate-sheet').innerHTML,/外しました：A/);
 f.preview.items[0].noop=false;await f.show();f.choose(0);f.preview.items=[];await f.show();assert.match(f.el('#integrate-sheet').innerHTML,/外しました：A/);
 const c=selectionUi();await c.show();c.choose(0);await c.click('close');await c.show();assert.equal(c.run('integratePreview.items.some(i=>i.selected)'),false);c.choose(0);await c.show('q','other');assert.equal(c.run('integratePreview.items.some(i=>i.selected)'),false);c.choose(0);c.events.keydown({key:'Escape'});await c.show('q','other');assert.equal(c.run('integratePreview.items.some(i=>i.selected)'),false);
});
for(const locale of ['ja','zh-TW'])test('選択除外の通知は待機・要再確認の状況欄にも残る：'+locale,async()=>{
 const f=selectionUi(locale);await f.show();f.choose(1);f.preview.items[1].startable=false;f.preview.waiting=[{message:'fixture busy'}];await f.show();
 const status=f.el('#integrate-status');assert.match(status.textContent,locale==='ja'?/選べなくなった作業を外しました：B/:/已取消選取無法整合的作業：B/);assert.match(status.textContent,/fixture busy/);
 f.run('integrationRequireRefresh("fixture refresh")');assert.match(status.textContent,locale==='ja'?/外しました：B/:/作業：B/);assert.match(status.textContent,/fixture refresh/);assert.equal(f.run('integratePreview.items[1].selected'),false);
});
for(const failure of ['network','invalid-response','409'])test('選別の通信不明は全方式を再送せず、409は選択を保持して再確認：'+failure,async()=>{
 const f=selectionUi();await f.show();f.choose(0);if(failure==='invalid-response')f.ctx.out={};else f.ctx.failure=Object.assign(Error('fixture failure'),failure==='409'?{status:409}:{});
 await f.click('selected');assert.equal(f.posts().length,1);assert.equal(f.run('integratePreview.items[0].selected'),true);f.ctx.failure=null;delete f.ctx.out;
 for(const mode of ['selected','batch','single'])await f.click(mode);assert.equal(f.posts().length,1);await f.click('refresh');assert.equal(f.run('integratePreview.items[0].selected'),true);
 if(failure==='409'){assert.equal(f.el('#integrate-sheet [data-integrate-action="selected"]').disabled,false);await f.click('selected');assert.equal(f.posts().length,2);}else{for(const mode of ['selected','batch','single'])await f.click(mode);assert.equal(f.posts().length,1);await f.click('close');await f.show();for(const mode of ['selected','batch','single'])await f.click(mode);assert.equal(f.posts().length,1);}
});
test('選別の送信中・開始済み・要再確認では選択変更と二重開始を拒否',async()=>{
 const f=selectionUi();await f.show();f.choose(0);let release;f.ctx.gate=new Promise(r=>release=r);const pending=f.click('selected');await f.click('single');f.choose(1);assert.equal(f.posts().length,1);assert.equal(f.run('integratePreview.items[1].selected'),false);release();await pending;
 for(const flags of [{auto:{mode:'selected'}},{requiresRefresh:true},{waiting:[{message:'busy'}]}]){const b=selectionUi();Object.assign(b.preview,flags);await b.show();b.choose(0);for(const mode of ['selected','batch','single'])await b.click(mode);assert.equal(b.posts().length,0);assert.equal(b.run('Boolean(integratePreview.items[0].selected)'),false);assert.equal(b.el('select:0').disabled,true);}
});

for(const locale of ['ja','zh-TW'])test('選別統合の反映済み旧記録は閉じた履歴、証拠不一致は警告、開始/再送0：'+locale,async()=>{
 const f=selectionUi(locale),pending={id:'old',main:{state:'intent',sourceHead:'a'.repeat(40)},stopped:{reason:'本体取り込みの前提を確認できません'}};f.preview.items=[];f.preview.mainPending=pending;
 f.preview.mainDisplay={key:JSON.stringify(pending),reflected:true};await f.show();let html=f.el('#integrate-sheet').innerHTML;
 assert.match(html,/<details[^>]*data-integration-history/);assert.doesNotMatch(html,/data-integration-main|<details[^>]*open/);assert.match(html,locale==='ja'?/現在の本体に反映済み/:/已反映至目前本體/);
 if(locale==='ja'){assert.doesNotMatch(html,/別の未保存変更/);f.preview.mainDisplay={key:JSON.stringify(pending),reflected:true,mainUncommitted:2};await f.show();const dirtyHtml=f.el('#integrate-sheet').innerHTML;assert.match(dirtyHtml,/現在の本体に反映済み/);assert.match(dirtyHtml,/本体には別の未保存変更があります。この取り込み結果とは別です（2）/);assert.doesNotMatch(dirtyHtml,/反映が未確認/);f.preview.mainDisplay={key:JSON.stringify(pending),reflected:true};await f.show();html=f.el('#integrate-sheet').innerHTML;}
 assert.equal(f.el('#integrate-sheet [data-integrate-action="selected"]').disabled,true);assert.equal(f.el('#integrate-sheet [data-integrate-action="batch"]').disabled,true);await f.click('selected');assert.equal(f.posts().length,0);
 for(const evidence of [{key:'different',reflected:true},{key:JSON.stringify(pending),reflected:false},undefined]){f.preview.mainDisplay=evidence;await f.show();html=f.el('#integrate-sheet').innerHTML;assert.match(html,/data-integration-main/);assert.doesNotMatch(html,/data-integration-history/);}
 assert.equal(pending.main.state,'intent');assert.equal(f.posts().length,0);
});
for(const locale of ['ja','zh-TW'])test('選別統合も旧本体結果不明と分離し、完了のみは選択0、新候補だけ送信：'+locale,async()=>{
 const f=selectionUi(locale);f.preview.mainPending={id:'old',main:{state:'intent'},stopped:{reason:'本体取り込みの前提を確認できません'}};const items=f.preview.items;f.preview.items=[];await f.show();
 let html=f.el('#integrate-sheet').innerHTML;assert.match(html,/data-integration-main/);assert.match(html,locale==='ja'?/新しい成果はありません/:/沒有新增成果/);assert.equal(f.el('#integrate-sheet [data-integrate-action="selected"]').disabled,true);assert.equal(f.posts().length,0);
 f.preview.items=items;await f.show();html=f.el('#integrate-sheet').innerHTML;assert.match(html,/data-integrate-select/);assert.match(html,locale==='ja'?/今回は本作業への受領まで/:/此次只接收至主作業/);assert.match(html,locale==='ja'?/本体取り込みの結果が不明/:/無法確認合併至主程式的結果/);
 f.choose(1);await f.click('selected');assert.equal(f.posts().length,1);assert.equal(f.posts()[0].body.thenMain,false);assert.deepEqual(JSON.parse(JSON.stringify(f.posts()[0].body.selected)),[{project:'p',task:'c1',keep:false}]);assert.equal(f.preview.mainPending.main.state,'intent');
});
for(const gitFree of [false,true])for(const keep of [true,false])test('直接本体でもファイル成果を隔離確認して保持・片付け、本体再適用なし：'+gitFree+'/'+keep,async t=>{
 const f=fixture(t),c=f.child('直接成果');f.store.updateTask('Fixture',f.parent.id,{workdir:'',workspaceMode:'direct'});f.store.updateTask('Fixture',c.id,{workdir:''});
 if(gitFree)fs.rmSync(path.join(f.body,'.git'),{recursive:true});
 const d=f.preview();assert.equal(d.target,f.body);f.start(keep);await f.auto.tick();const q=f.requests[0];assert.ok(q.isolatedReview);assert.equal(f.transfer.read('Fixture',c.id)?.complete,undefined);
 if(gitFree){assert.ok(q.review.fileReview);const evidence=require('../lib/integration-review').prepare({dir:f.body,pdir:f.dir,task:f.parent.id,...q.review});assert.match(fs.readFileSync(evidence.file,'utf8'),/ファイル成果の受領のみ/);}
 const k=q.review.key;f.settle(q,`[integration-review:${k}:pass]`);await f.auto.tick();const receipt=f.transfer.read('Fixture',c.id);assert.equal(f.r().auto.stopped,undefined,JSON.stringify(f.r().auto.stopped));assert.equal(receipt.complete,true);assert.equal(Boolean(receipt.retained),keep);assert.equal(f.r().auto.thenMain,false);assert.equal(f.r().auto.main.state,'done');assert.ok(receipt.files.every(x=>fs.existsSync(x.to)));
 if(keep){assert.ok(f.store.taskFile('Fixture',c.id));const next=f.preview();assert.equal(next.items[0].noop,true);f.start(false);await f.auto.tick();assert.equal(f.transfer.read('Fixture',c.id).complete,true);assert.equal(f.store.taskFile('Fixture',c.id),null);assert.equal(f.requests.length,1,'received cleanup must not re-review or apply');}
});
test('Gitなしファイル確認も合格だけでは不十分、確認後の成果変更は受領しない',async t=>{
 const f=fixture(t),c=f.child('変更');f.store.updateTask('Fixture',f.parent.id,{workdir:''});f.store.updateTask('Fixture',c.id,{workdir:''});fs.rmSync(path.join(f.body,'.git'),{recursive:true});f.start(true);await f.auto.tick();const q=f.requests[0];fs.appendFileSync(path.join(f.dir,'作業',c.id,'report.txt'),'NEW');f.settle(q,`[integration-review:${q.review.key}:pass]`);assert.match(f.r().auto.stopped.reason,/changed|成果/);assert.equal(f.transfer.read('Fixture',c.id)?.complete,undefined);
});
for(const change of ['parent-workdir','parent-relation','child-result','child-relation','cleanup-file'])test('実際の保存先・親子・成果・片付け範囲変更は旧確認を必ず拒否：'+change,t=>{
 const f=fixture(t),c=f.child(),d=f.preview();
 if(change==='parent-workdir')f.store.updateTask('Fixture',f.parent.id,{workdir:f.body});
 if(change==='parent-relation')f.store.updateTask('Fixture',f.parent.id,{parent:'20990101-x'});
 if(change==='child-result')f.store.appendSection('Fixture',c.id,'成果','- ファイル：作業/'+c.id+'/new.txt');
 if(change==='child-relation')f.store.updateTask('Fixture',c.id,{parent:'20990101-x'});
 if(change==='cleanup-file')f.write(path.join(f.dir,'作業',c.id,'new.txt'),'unreceived');
 assert.throws(()=>f.auto.apply({project:'Fixture',task:f.parent.id,token:d.token,auto:true,confirm:true,thenMain:false,mode:'single',selected:[{project:'Fixture',task:c.id,keep:false}]}));assert.equal(f.r(),null);assert.ok(f.store.taskFile('Fixture',c.id));
});
test('変更なしの定期確認は新tokenを採用し、実変更は全入口を止め、再確認で選択とtokenを更新',async()=>{
 const f=selectionUi();f.preview.confirmationHash='same';await f.show();f.choose(0);const first=f.run('integratePreview.token');f.preview.token='fresh';await f.run('integrationCheckLatest()');assert.equal(f.run('integratePreview.token'),'fresh');assert.equal(f.run('integratePreview.items[0].selected'),true);assert.equal(f.el('single:0').disabled,false);assert.equal(f.el('#integrate-sheet [data-integrate-action="batch"]').disabled,false);
 f.preview.confirmationHash='changed';f.preview.token='changed';await f.run('integrationCheckLatest()');assert.equal(f.run('integratePreview.requiresRefresh'),true);assert.equal(f.el('single:0').disabled,true);assert.equal(f.el('#integrate-sheet [data-integrate-action="selected"]').disabled,true);assert.equal(f.el('#integrate-sheet [data-integrate-action="batch"]').disabled,true);
 await f.click('refresh');assert.equal(f.run('integratePreview.requiresRefresh'),undefined);assert.equal(f.run('integratePreview.token'),'changed');assert.equal(f.el('#integrate-sheet [data-integrate-action="selected"]').disabled,false);assert.notEqual(first,'changed');
});
test('遅い定期応答は手動再確認後を巻き戻さず、閉鎖後の遅いpreviewも再表示しない',async()=>{
 const f=selectionUi();f.preview.confirmationHash='first';await f.show();const backend=f.ctx.backend;let resolve;f.ctx.backend=(route,b)=>route.endsWith('/preview')?new Promise(r=>resolve=r):backend(route,b);f.run('api=backend');const checking=f.run('integrationCheckLatest()');await Promise.resolve();f.ctx.backend=backend;f.run('api=backend');f.preview.confirmationHash='new';f.preview.token='new';await f.click('refresh');resolve({...f.preview,confirmationHash:'old',token:'old'});await checking;assert.equal(f.run('integratePreview.token'),'new');assert.equal(f.run('integratePreview.requiresRefresh'),undefined);
 f.ctx.backend=(route,b)=>route.endsWith('/preview')?new Promise(r=>resolve=r):backend(route,b);f.run('api=backend');const opening=f.show();await Promise.resolve();await f.click('close');resolve({...f.preview,token:'late'});await opening;assert.equal(f.el('#integrate-sheet').hidden,true);assert.equal(f.run('integratePreview.token'),'new');assert.equal(f.run('integrateBusy'),false);
});

for(const keep of [true,false])test('整理ループ：古い引渡し残件不明から現在の申告を確認し正式受領まで一度で完走/'+keep,async t=>{
 const f=fixture(t),c=f.child('旧引渡し',{unknown:true});const d=f.transfer.offerPreview('Fixture',c.id);f.transfer.offer({project:'Fixture',task:c.id,expectTitle:c.title,token:d.token,confirm:true,selected:d.files.map(x=>x.id)});assert.equal(f.transfer.read('Fixture',c.id).remaining.status,'不明');
 f.start(keep);await f.auto.tick();const q=f.requests[0];assert.equal(q.organize,true);f.declaration(c.id);f.settle(q,'現在の残件を申告済み');assert.equal(f.r().auto.stopped,undefined);assert.equal(f.r().items[0].remaining.status,'なし');await f.finish();assert.equal(f.requests.filter(q=>q.organize).length,1);assert.equal(f.transfer.read('Fixture',c.id).complete,true);
});
test('整理ループ：終了済みでも残件申告なしなら再開の受付前に拒否し、旧停止・子・依頼数を保持',async t=>{
 const f=fixture(t),c=f.child('未整理',{unknown:true});f.start(true);await f.auto.tick();const q=f.requests[0],k=q.text.match(/integration-auto:([a-f0-9]{64}):organize/)[1];f.settle(q,'整理したという返事だけ');f.auto.pendingRequest=()=>false;f.auto.savedCompletion=()=>({text:'整理したという返事だけ'});const before=JSON.stringify(f.r()),d=f.preview();assert.equal(d.resumeAllowed,false);assert.equal(d.token,undefined);assert.throws(()=>f.auto.resume({project:'Fixture',task:f.parent.id,token:d.token,confirm:true}),/残件申告/);assert.equal(JSON.stringify(f.r()),before);assert.equal(f.requests.length,1);assert.ok(f.store.taskFile('Fixture',c.id));assert.equal(f.r().auto.attempts[k].phase,'organize');
});
test('整理ループ：開始許可は保存された対象・request・関係・保持選択だけに限定',async t=>{
 const f=fixture(t),c=f.child('起動境界',{unknown:true});f.start(true);await f.auto.tick();const q=f.requests[0],k=q.text.match(/integration-auto:([a-f0-9]{64}):organize/)[1],r=f.r();r.auto.attempts[k].delivery.state='intent';f.integrate.save(r);const read=f.integrate.read,pending=f.integrate.pending;f.integrate.pending=()=>[{project:'none',task:'none'},...pending.call(f.integrate)];f.integrate.read=(p,t)=>p==='none'?{auto:{}}:read.call(f.integrate,p,t);assert.doesNotThrow(()=>f.integrate.simple.organizeStart(q));f.integrate.read=read;f.integrate.pending=pending;for(const b of [{...q,task:f.parent.id},{...q,requestKey:'other'},{...q,text:'no marker'}])assert.throws(()=>f.integrate.simple.organizeStart(b));f.store.updateTask('Fixture',c.id,{question:'人の判断'});assert.throws(()=>f.integrate.simple.organizeStart(q));assert.equal(f.requests.length,1);
});

async function completedGrandchild(t){
 const f=fixture(t),mid=f.child('中間'),leaf=f.child('受領済み孫',{parent:mid.id});
 const keep=(c,value)=>f.integrate.simple.saveKeep({project:'Fixture',task:f.parent.id,childProject:'Fixture',childTask:c.id,keep:value});
 keep(leaf,true);f.start(true,'selected',[{project:'Fixture',task:leaf.id,keep:true}]);await f.finish();
 const child=f.store.readTask(f.store.taskFile('Fixture',leaf.id));f.store.decideTask('Fixture',leaf.id,'approve',child.completionHash);
 return {...f,mid,leaf,keep};
}
test('完了孫R1：普段は非候補、祖先の片付け時だけ保持選択を変えず確認行を出す',async t=>{
 const f=await completedGrandchild(t),other=f.child('別子'),before=untouched(f,f.leaf);
 f.keep(f.mid,true);assert.deepEqual(f.preview().items.map(i=>i.task).sort(),[f.mid.id,other.id].sort());
 f.keep(f.mid,false);const d=f.preview(),leaf=d.items.find(i=>i.task===f.leaf.id);
 assert.equal(leaf?.cleanupOnly,true);assert.equal(leaf.keep,true);assert.equal(leaf.noop,true);
 assert.equal(require('../public/integration-selection').select(d.items,'single',[{project:'Fixture',task:f.mid.id}]).items.length,2);
 assert.ok(require('../public/integration-selection').select(d.items,'single',[{project:'Fixture',task:f.mid.id}]).reason);
 assert.throws(()=>f.auto.apply({project:'Fixture',task:f.parent.id,token:d.token,auto:true,confirm:true,thenMain:false,mode:'single',selected:[{project:'Fixture',task:f.mid.id,keep:false}]}));
 assert.deepEqual(untouched(f,f.leaf),before);assert.equal(f.r().complete,true);
 f.keep(f.mid,true);assert.ok(!f.preview().items.some(i=>i.task===f.leaf.id));
 assert.ok(f.preview().items.some(i=>i.task===other.id));
});
for(const mode of ['single','selected','batch'])test('完了孫R1：明示選択後の子孫scopeと正式片付け・受領出典保持：'+mode,async t=>{
 const f=await completedGrandchild(t),oldReceipt=f.transfer.lastReceipt(f.transfer.read('Fixture',f.leaf.id)),select=require('../public/integration-selection').select;
 f.keep(f.leaf,false);const before=f.preview(),d=f.preview();
 assert.equal(d.items.find(i=>i.task===f.leaf.id).alreadyReceived,true);assert.equal(d.items.find(i=>i.task===f.leaf.id).cleanupOnly,true);
 const selected=d.items.map(i=>({project:i.project,task:i.task,keep:i.keep}));
 const plan=select(d.items,mode,mode==='single'?[{project:'Fixture',task:f.mid.id}]:selected);
 assert.equal(plan.reason,'');assert.deepEqual(plan.items.map(i=>i.task),[f.leaf.id,f.mid.id]);
 f.auto.apply({project:'Fixture',task:f.parent.id,token:d.token,auto:true,confirm:true,thenMain:false,mode,selected});
 const scope=JSON.stringify(f.r().auto.scope.map(({review,...i})=>i));assert.deepEqual(f.r().items.map(i=>i.task),[f.leaf.id,f.mid.id]);assert.ok(f.r().auto.scope.every(i=>i.keep===false));
 assert.throws(()=>f.auto.apply({project:'Fixture',task:f.parent.id,token:before.token,auto:true,confirm:true,thenMain:false,mode,selected}));
 await f.finish();assert.equal(JSON.stringify(f.r().auto.scope.map(({review,...i})=>i)),scope);assert.ok(f.r().auto.scope.every(i=>i.review.confirmed));
 const receipt=f.transfer.read('Fixture',f.leaf.id);assert.ok(receipt.received.some(r=>r.id===oldReceipt.id&&r.hash===oldReceipt.hash));
 assert.equal(receipt.complete,true);assert.equal(receipt.retained,undefined);
 for(const c of [f.leaf,f.mid]){const i=f.r().items.find(i=>i.task===c.id);assert.equal(i.state,'片付け済み');assert.ok(fs.existsSync(i.copyTrashed));assert.equal(f.store.taskFile('Fixture',c.id),null);}
});
test('完了孫R1：確認行だけの開始・保持孫・省略した未受領子孫を拒否する',async t=>{
 const f=await completedGrandchild(t),select=require('../public/integration-selection').select;
 f.keep(f.leaf,false);let d=f.preview(),leaf=d.items.find(i=>i.task===f.leaf.id),mid=d.items.find(i=>i.task===f.mid.id);
 for(const mode of ['single','selected']){
  assert.match(select(d.items,mode,[leaf]).reason,/上の作業/);
  assert.throws(()=>f.auto.apply({project:'Fixture',task:f.parent.id,token:d.token,auto:true,confirm:true,thenMain:false,mode,selected:[{project:'Fixture',task:leaf.task,keep:false}]}),/上の作業/);
 }
 assert.throws(()=>selectedRequest(f,d,[{project:'Fixture',task:mid.task,keep:false}]),/も選ぶか/);
 f.keep(f.leaf,true);d=f.preview();assert.throws(()=>selectedRequest(f,d,d.items.map(i=>({project:i.project,task:i.task,keep:i.keep}))));
 const fresh=f.child('未受領孫',{parent:f.mid.id});d=f.preview();assert.equal(d.items.find(i=>i.task===fresh.id).cleanupOnly,undefined);
 assert.throws(()=>selectedRequest(f,d,[{project:'Fixture',task:f.mid.id,keep:false}]),/も選ぶか/);
 assert.equal(f.r().items.length,1);assert.equal(f.r().complete,true);assert.ok(fs.existsSync(f.leaf.workdir));assert.ok(fs.existsSync(fresh.workdir));
});
for(const change of ['keep','ancestor','receipt','source'])test('完了孫R1：確認後CASで無変更拒否：'+change,async t=>{
 const f=await completedGrandchild(t);f.keep(f.leaf,false);const d=f.preview(),selected=d.items.map(i=>({project:i.project,task:i.task,keep:i.keep}));
 if(change==='keep')f.keep(f.leaf,true);
 if(change==='ancestor')f.keep(f.mid,true);
 if(change==='receipt'){const r=f.transfer.read('Fixture',f.leaf.id);r.received.at(-1).hash='changed';f.transfer.save(r);}
 if(change==='source'){f.write(path.join(f.leaf.workdir,'later'),'new');git.save(f.leaf.workdir,'later');}
 const before=[untouched(f,f.leaf),untouched(f,f.mid)],record=JSON.stringify(f.r());
 assert.throws(()=>f.auto.apply({project:'Fixture',task:f.parent.id,token:d.token,auto:true,confirm:true,thenMain:false,mode:'single',selected}));
 assert.equal(JSON.stringify(f.r()),record);assert.deepEqual([untouched(f,f.leaf),untouched(f,f.mid)],before);
});
test('完了孫R1：再開・再読込は固定scopeを保持し、別子と後追加を巻き込まない',async t=>{
 const f=await completedGrandchild(t),other=f.child('別の子'),before=untouched(f,other);f.keep(f.leaf,false);const d=f.preview();
 const selected=d.items.filter(i=>i.task!==other.id).map(i=>({project:i.project,task:i.task,keep:i.keep}));selectedRequest(f,d,selected);
 const scope=JSON.stringify(f.r().auto.scope);f.auto.stop('Fixture',f.parent.id,'合成停止');const later=f.child('後からの子'),laterBefore=untouched(f,later),fresh=f.preview();
 assert.equal(f.auto.resume({project:'Fixture',task:f.parent.id,token:fresh.token,confirm:true}).resumed,true);
 const restarted=new IntegrateAuto({integrate:f.integrate,dispatch:async q=>f.requests.push(q)});restarted.pendingRequest=()=>true;await restarted.tick();
 assert.equal(JSON.stringify(f.r().auto.scope),scope);assert.deepEqual(f.r().items.map(i=>i.task),[f.leaf.id,f.mid.id]);
 assert.deepEqual(untouched(f,other),before);assert.deepEqual(untouched(f,later),laterBefore);
});
test('完了孫R1：正式再開・未知の追加成果を片付け確認として隠さない',async t=>{
 const f=await completedGrandchild(t);f.keep(f.mid,true);let child=f.store.readTask(f.store.taskFile('Fixture',f.leaf.id));
 f.store.decideTask('Fixture',f.leaf.id,'continue',child.completionHash);let d=f.preview();assert.equal(d.items.find(i=>i.task===child.id).cleanupOnly,undefined);
 f.keep(f.mid,false);child=f.store.readTask(f.store.taskFile('Fixture',child.id));f.store.decideTask('Fixture',child.id,'approve',child.completionHash);
 f.write(path.join(f.dir,'作業',child.id,'new.txt'),'unreceived');d=f.preview();assert.equal(d.items.find(i=>i.task===child.id).alreadyReceived,false);assert.equal(d.items.find(i=>i.task===child.id).cleanupOnly,undefined);
 // A missing descendant still blocks the same removal plan. No guard is dropped.
 const mid=d.items.find(i=>i.task===f.mid.id),selection=require('../public/integration-selection');assert.ok(selection.select([mid],'single',[mid]).reason);
});
for(const locale of ['ja'])test('完了孫R1 UI：確認行と保持値・単独送信拒否・明示選択後scope：'+locale,async()=>{
 const f=selectionUi(locale);f.preview.items[0].descendants=[{project:'p',task:'c1',title:'B'}];Object.assign(f.preview.items[1],{cleanupOnly:true,alreadyReceived:true,keep:true,noop:true});
 await f.show();const html=f.el('#integrate-sheet').innerHTML;
 assert.match(html,locale==='ja'?/完了・受領済みです/:/此作業已完成並接收成果/);
 assert.match(html,/name="integration-keep-1"[^>]*[\s\S]*value="true" checked/);
 assert.equal((html.match(/data-integrate-action="single"/g)||[]).length,1);
 await f.click('single',0);assert.equal(f.posts().length,0);assert.equal(f.run('integratePreview.items[1].keep'),true);
 const input={matches:s=>s==='[data-integrate-keep]',dataset:{index:'1'},value:'false'};
 // Synthetic backend emulates a fresh verified preview after the explicit save.
 f.preview.items[1].noop=false;f.ctx.keepInput=input;await f.run('saveIntegrationKeep(keepInput)');
 assert.equal(f.calls.filter(c=>c.route.endsWith('/keep')).length,1);assert.equal(f.run('integratePreview.items[1].keep'),false);
 await f.click('single',1);assert.equal(f.posts().length,0);assert.match(f.el('#integrate-status').textContent,locale==='ja'?/上の作業/:/上層作業/);
 await f.click('single',0);assert.equal(f.posts().length,1);assert.deepEqual(JSON.parse(JSON.stringify(f.posts()[0].body.selected)),[{project:'p',task:'c0',keep:false},{project:'p',task:'c1',keep:false}]);
});

test('完了孫R1：完了後の保持選択を往復しても全文連鎖と正式完了承認を維持',async t=>{
 const f=await completedGrandchild(t);const initial=f.transfer.lastReceipt(f.transfer.read('Fixture',f.leaf.id));
 for(const keep of [false,true,false]){
  f.keep(f.leaf,keep);const r=f.transfer.read('Fixture',f.leaf.id),last=r.keepChanges.at(-1),item=f.preview().items.find(i=>i.task===f.leaf.id);
  assert.equal(require('../lib/completion').hash(last.beforeText),last.before);assert.equal(require('../lib/completion').hash(last.text),last.after);
  assert.equal(item.alreadyReceived,true);assert.equal(item.cleanupOnly,true);assert.equal(item.keep,keep);
  assert.equal(f.transfer.offers().find(i=>i.task===f.leaf.id&&i.targetTask===f.mid.id).pending,true,'未受領の中間へはpendingのまま。祖先への受領を流用しない');
  assert.ok(require('../public/project-order').approved(f.store.readTask(f.store.taskFile('Fixture',f.leaf.id))));assert.equal(r.received.at(-1).hash,initial.hash);
 }
});
for(const change of ['before-text','after-text','missing-before','before-hash','after-hash'])test('完了孫R1：完了後保持の全文根拠を欠損・改変しても受領済みとしない：'+change,async t=>{
 const f=await completedGrandchild(t);f.keep(f.leaf,false);const r=f.transfer.read('Fixture',f.leaf.id),link=r.keepChanges.at(-1),hash=require('../lib/completion').hash;
 if(change==='before-text'){link.beforeText+='\n変更';link.before=hash(link.beforeText);}
 if(change==='after-text'){link.text+='\n変更';link.after=hash(link.text);const file=f.store.taskFile('Fixture',f.leaf.id);fs.writeFileSync(file,link.text);f.store.completion.approveTask('Fixture/'+f.leaf.id,link.text);}
 if(change==='missing-before')delete link.beforeText;
 if(change==='before-hash')link.before='changed';
 if(change==='after-hash')link.after='changed';
 f.transfer.save(r);const item=f.preview().items.find(i=>i.task===f.leaf.id);assert.equal(item.alreadyReceived,false);assert.equal(item.cleanupOnly,undefined);assert.equal(f.transfer.offers().find(i=>i.task===f.leaf.id&&i.targetTask===f.mid.id).pending,true);
});
test('完了孫R1：保留された受領済み孫は省略して祖先を片付けられない',async t=>{
 const f=await completedGrandchild(t);f.keep(f.leaf,false);const old=f.preview(),hold=require('../lib/task-future-hold'),child=f.store.readTask(f.store.taskFile('Fixture',f.leaf.id));
 hold.save(f.integrate,{project:'Fixture',task:child.id,held:true,before:false,revision:null,expectedHash:child.completionHash,confirm:true});
 const before=untouched(f,f.leaf),record=JSON.stringify(f.r()),d=f.preview();assert.equal(d.items.some(i=>i.task===child.id),false);
 const mid=d.items.find(i=>i.task===f.mid.id);assert.ok(require('../public/integration-selection').select(d.items,'single',[mid]).reason);
 for(const token of [old.token,d.token])assert.throws(()=>f.auto.apply({project:'Fixture',task:f.parent.id,token,auto:true,confirm:true,thenMain:false,mode:'single',selected:[{project:'Fixture',task:f.mid.id,keep:false}]}));
 assert.deepEqual(untouched(f,f.leaf),before);assert.equal(JSON.stringify(f.r()),record);
});
