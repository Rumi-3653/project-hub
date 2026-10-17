'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{randomUUID}=require('node:crypto');
const {Store}=require('../lib/store'),chat=require('../lib/chat'),{TaskHistory,latest}=require('../lib/task-history'),{TextBudget,sections}=require('../lib/text-budget'),{continueTask:startContinue}=require('../lib/task-continue');

// 選別CLIは呼ばず、受付後の自動処理をfixtureの会話で完了させる。
function finishSelection(history,project,task){
 const a=history.autoJob(project,task);if(!a||!['reserved','selecting','writing'].includes(a.stage))return history.continueStatus(project,task).result;
 if(a.stage==='reserved'){const plan=history.autoCollect(project,task);history.setAuto(project,task,{...plan,stage:'selecting'});}
 try{return history.autoFinish(project,task);}catch(e){return history.continueRecord(project,task).result;}
}
function continueTask(deps,b){const out=startContinue(deps,b);return out.pending?finishSelection(deps.history,b.project,b.task):out;}

function fixture(t,{long=true}={}){const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-task-continue-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const store=new Store(root),p=store.createProject({name:'Fixture'}).project,task=store.createTask(p.id,{title:'長い作業',steps:['残件']}),file=store.taskFile(p.id,task.id);store.appendSection(p.id,task.id,'成果','- 成果は保持');if(long)store.appendSection(p.id,task.id,'メモ','- x\n'.repeat(7000));chat.append(p.dir,task.id,{role:'user',text:'旧原文'});const history=new TaskHistory({store}),budget=new TextBudget({store}),deps={history,budget};const fields={decision:'集約する',reason:'迷わないため',current:'実装中',approved:'作業コピーのみ',residual:'独立チェック',evidence:'作業ファイル'};
  const input=(extra={})=>{const s=history.status(p.id,task.id);return {project:p.id,task:task.id,fields,confirm:true,generation:s.generation,revision:s.revision,requestId:randomUUID(),...extra};};
  const body=()=>({token:budget.preview(p.id,task.id).token,confirm:true});
  return {root,store,p,task,file,history,budget,deps,input,body};}
test('本文整理と会話切替を一度に行い、成果・手順・原文を保持する',t=>{const f=fixture(t);const out=continueTask(f.deps,f.input({body:f.body()}));assert.deepEqual([out.ok,out.body,out.rotate,out.generation],[true,'ok','ok',2]);const text=fs.readFileSync(f.file,'utf8');assert.match(sections(text).find(x=>x.name==='成果').body,/成果は保持/);assert.match(text,/- \[ \] 残件/);assert.match(latest(text),/旧原文/);assert.ok(f.budget.archives(f.p.id,f.task.id).length>0);assert.equal(f.history.archive(f.p.id,f.task.id,out.archiveId).rows[0].text,'旧原文');assert.ok(f.budget.state(f.p.id).tasks.includes(f.task.id));});
test('本文を整理しない選択では本文を変えずに会話だけ切り替える',t=>{const f=fixture(t),before=sections(fs.readFileSync(f.file,'utf8')).find(x=>x.name==='メモ').body;const out=continueTask(f.deps,f.input());assert.deepEqual([out.ok,out.body,out.rotate],[true,'skipped','ok']);assert.equal(sections(fs.readFileSync(f.file,'utf8')).find(x=>x.name==='メモ').body,before);assert.equal(f.budget.archives(f.p.id,f.task.id).length,0);assert.ok(!f.budget.state(f.p.id).tasks.includes(f.task.id));});
test('整理する本文が無い時は移す物が無く、確認済みなら自動整理の登録だけで切り替える',t=>{const f=fixture(t,{long:false});assert.equal(f.budget.preview(f.p.id,f.task.id).moves.length,0);const out=continueTask(f.deps,f.input({body:f.body()}));assert.deepEqual([out.ok,out.rotate],[true,'ok']);assert.equal(f.budget.archives(f.p.id,f.task.id).length,0);assert.match(sections(fs.readFileSync(f.file,'utf8')).find(x=>x.name==='成果').body,/成果は保持/);});
test('初回の本文整理の確認が無ければ何も変えない',t=>{const f=fixture(t),before=fs.readFileSync(f.file);assert.throws(()=>continueTask(f.deps,f.input({body:{token:f.body().token,confirm:false}})),/移す量と保管先/);assert.deepEqual(fs.readFileSync(f.file),before);assert.equal(f.history.state(f.p.id,f.task.id).generation,1);assert.ok(!f.budget.state(f.p.id).tasks.includes(f.task.id));});
test('整理の確認・版が合わなければ本文整理もしない',t=>{const f=fixture(t),before=fs.readFileSync(f.file);assert.throws(()=>continueTask(f.deps,{...f.input({body:f.body()}),confirm:false}));const stale=f.input({body:f.body()});chat.append(f.p.dir,f.task.id,{role:'user',text:'後から来た発言'});assert.throws(()=>continueTask(f.deps,stale),/会話が変わりました/);assert.deepEqual(fs.readFileSync(f.file),before);assert.equal(f.history.state(f.p.id,f.task.id).generation,1);});
test('本文整理に失敗したら会話を切り替えない',t=>{const f=fixture(t),before=fs.readFileSync(f.file);const out=continueTask(f.deps,f.input({body:{token:randomUUID(),confirm:true}}));assert.deepEqual([out.ok,out.body,out.rotate],[false,'failed','skipped']);assert.match(out.error,/本文の整理内容/);assert.deepEqual(fs.readFileSync(f.file),before);assert.equal(f.history.state(f.p.id,f.task.id).generation,1);});
test('本文整理後に中断しても、復旧は本文を再整理せず同IDの選別へ進む',t=>{
 const f=fixture(t),input=f.input({body:f.body()});f.history.checkpoint=phase=>{if(phase==='body')throw Error('after body');};
 assert.throws(()=>startContinue(f.deps,input),/after body/);const count=f.budget.archives(f.p.id,f.task.id).length;
 const restarted=new TaskHistory({store:f.store});const out=require('../lib/task-continue').recoverContinue({history:restarted,budget:f.budget},input);assert.equal(out.pending,true);
 assert.equal(finishSelection(restarted,f.p.id,f.task.id).generation,2);assert.equal(f.budget.archives(f.p.id,f.task.id).length,count);assert.equal(restarted.archives(f.p.id,f.task.id).length,1);
});
test('同じ依頼の再送は重ねて切り替えず、本文も再整理しない',t=>{const f=fixture(t),input=f.input({body:f.body()});const out=continueTask(f.deps,input),after=fs.readFileSync(f.file);const again=continueTask(f.deps,input);assert.equal(again.duplicate,true);assert.equal(again.generation,out.generation);assert.equal(again.body,'ok');assert.deepEqual(fs.readFileSync(f.file),after);assert.equal(f.history.state(f.p.id,f.task.id).generation,2);});
test('1クリックの別ID・別タブは受付済み処理へ接続し、完了直後も二重に切り替えない',t=>{
 const f=fixture(t,{long:false}),first={...f.input(),automatic:true},out=startContinue(f.deps,first);
 const second={...first,requestId:randomUUID()},join=startContinue(f.deps,second);assert.equal(join.requestId,first.requestId);assert.equal(join.pending,true);assert.equal(join.duplicate,true);assert.equal(f.history.autoJob(f.p.id,f.task.id).requestId,first.requestId);
 finishSelection(f.history,f.p.id,f.task.id);const done=startContinue(f.deps,second);assert.equal(done.ok,true);assert.equal(done.requestId,first.requestId);assert.equal(f.history.archives(f.p.id,f.task.id).length,1);
});
test('1クリックで本文の共有保護にぶつかった時は原文を保持して会話のみ進める',t=>{
 const f=fixture(t),body=f.body(),original=fs.readFileSync(f.file,'utf8');f.budget.busy=()=> '共有ロック';
 const out=continueTask(f.deps,{...f.input({body}),automatic:true});assert.equal(out.rotate,'ok');assert.equal(out.body,'skipped');assert.equal(f.budget.archives(f.p.id,f.task.id).length,0);assert.ok(fs.readFileSync(f.file,'utf8').includes(original.slice(original.indexOf('## メモ'))));
});
test('会話の保存待ちは対象作業に限定し、共有本文の保護用Setは保持する',t=>{
 const f=fixture(t,{long:false}),release=f.history.hold('other','task');assert.equal(f.history.status(f.p.id,f.task.id).reason,'');assert.equal(f.history.activeWrites.size,1);release();
 const own=f.history.hold(f.p.id,f.task.id);assert.match(f.history.status(f.p.id,f.task.id).reason,/保存・送信/);own();
});

test('R3: 未確認送信を別IDで再送できず、サーバー再起動後も対象別に保持する',t=>{
 const f=fixture(t,{long:false}),input=f.input();f.history.saveContinue(f.p.id,f.task.id,{requestId:input.requestId,generation:1,status:'pending'});
 const restarted=new TaskHistory({store:f.store});assert.equal(restarted.continueStatus(f.p.id,f.task.id,input.requestId).status,'pending');
 assert.throws(()=>continueTask({history:restarted,budget:f.budget},f.input()),/再送せず/);assert.equal(restarted.state(f.p.id,f.task.id).generation,1);
 const another=f.store.createTask(f.p.id,{title:'別の対象'}),s=restarted.status(f.p.id,another.id);assert.equal(continueTask({history:restarted,budget:f.budget},{...input,task:another.id,generation:s.generation,revision:s.revision,requestId:randomUUID()}).generation,2);
});
test('R3: 応答喪失後に送信IDを照合でき、再起動後も同じ世代を二度切り替えない',t=>{
 const f=fixture(t),input=f.input({body:f.body()}),out=continueTask(f.deps,input);
 const restarted=new TaskHistory({store:f.store});assert.equal(restarted.continueStatus(f.p.id,f.task.id,input.requestId).status,'done');
 const again=continueTask({history:restarted,budget:f.budget},input);assert.equal(again.duplicate,true);assert.equal(again.generation,out.generation);assert.equal(restarted.archives(f.p.id,f.task.id).length,1);
 assert.equal(restarted.continueStatus(f.p.id,f.task.id,randomUUID()).status,'unknown');
});
test('R4: commit後のreset失敗は未実行扱いせず、原文・世代を照合して復旧する',t=>{
 const f=fixture(t,{long:false}),input=f.input();f.history.reset=()=>{throw Error('reset failed');};const out=continueTask(f.deps,input);
 assert.equal(out.rotate,'committed');assert.equal(out.recovery,true);assert.equal(f.history.state(f.p.id,f.task.id).generation,2);assert.ok(fs.existsSync(f.history.journalFile(f.p.id,f.task.id)));
 assert.equal(f.history.continueStatus(f.p.id,f.task.id,input.requestId).status,'uncertain');assert.throws(()=>continueTask(f.deps,f.input()),/再送せず/);
 let resets=0;f.history.reset=()=>resets++;const fixed=require('../lib/task-continue').recoverContinue(f.deps,{...input,confirm:true});assert.equal(fixed.generation,2);assert.equal(resets,1);assert.equal(f.history.failure,'');assert.equal(f.history.archives(f.p.id,f.task.id).length,1);
 assert.equal(f.history.continueStatus(f.p.id,f.task.id,input.requestId).status,'done');
});
test('R4: commit後のmanifest保存・journal削除の失敗でも保存済み結果を照合する',t=>{
 for(const phase of ['manifest','unlink']){
  const f=fixture(t,{long:false}),input=f.input(),rename=fs.renameSync,unlink=fs.unlinkSync;let injected=false;
  fs.renameSync=(a,b)=>{if(phase==='manifest'&&b.endsWith('/manifest.json')&&!injected){injected=true;throw Error('manifest failed');}return rename(a,b);};
  fs.unlinkSync=file=>{if(phase==='unlink'&&file===f.history.journalFile(f.p.id,f.task.id)&&!injected){injected=true;throw Error('journal cleanup failed');}return unlink(file);};
  let out;try{out=continueTask(f.deps,input);}finally{fs.renameSync=rename;fs.unlinkSync=unlink;}
  assert.equal(out.rotate,'committed');assert.equal(f.history.state(f.p.id,f.task.id).generation,2);
  const restarted=new TaskHistory({store:f.store});assert.equal(restarted.failure,'');assert.equal(restarted.continueStatus(f.p.id,f.task.id,input.requestId).status,'done');assert.equal(restarted.archives(f.p.id,f.task.id).length,1);
 }
});
test('R4: commit前に保存とrollbackの両方が失敗した時は不明状態を維持する',t=>{
 const f=fixture(t,{long:false});chat.writeMeta(f.p.dir,f.task.id,{sessions:{codex:'old'}});const input=f.input(),rename=fs.renameSync,meta=chat.files(f.p.dir,f.task.id).meta;
 fs.renameSync=(a,b)=>{if(b===meta)throw Error('write and rollback failed');return rename(a,b);};let out;try{out=continueTask(f.deps,input);}finally{fs.renameSync=rename;}
 assert.equal(out.rotate,'uncertain');assert.throws(()=>continueTask(f.deps,f.input()),/再送せず/);
});
test('R4: 切替済みで送信結果の保存だけが失敗しても未実行とは返さない',t=>{
 const f=fixture(t,{long:false}),input=f.input(),save=f.history.saveContinue.bind(f.history);let failed=false;
 f.history.saveContinue=(p,t,r)=>{if(r.status==='done'&&!failed){failed=true;throw Error('result save failed');}return save(p,t,r);};
 const out=continueTask(f.deps,input);assert.equal(out.rotate,'committed');assert.equal(f.history.state(f.p.id,f.task.id).generation,2);assert.equal(f.history.continueStatus(f.p.id,f.task.id,input.requestId).status,'done');
});
test('R5: 最終要約と原文を先に保管し、最新hashの完了承認後に片付けても完了を維持する',t=>{
 const f=fixture(t,{long:false});fs.writeFileSync(f.file,fs.readFileSync(f.file,'utf8').replace('- 成果は保持','- なし：確認のみ'));const old=f.store.readTask(f.file).completionHash;
 const temp=path.join(f.p.dir,'.ai/work',f.task.id,'scratch');fs.mkdirSync(path.dirname(temp),{recursive:true});fs.writeFileSync(temp,'一時物');
 const out=continueTask(f.deps,f.input());assert.equal(out.rotate,'ok');assert.notEqual(old,out.completionHash);assert.equal(f.history.archive(f.p.id,f.task.id,out.archiveId).rows[0].text,'旧原文');
 assert.equal(f.store.decideTask(f.p.id,f.task.id,'approve',old).status,409);assert.equal(f.store.decideTask(f.p.id,f.task.id,'approve',out.completionHash).state,'完了');
 const removal=new (require('../lib/remove').Removal)({store:f.store,trash:path.join(f.root,'Trash')}),preview=removal.tidyPreview(f.p.id,f.task.id);assert.ok(preview.token);removal.tidyApply({token:preview.token,ids:preview.move.map(x=>x.id),confirm:true});assert.equal(f.store.readTask(f.file).state,'完了');
 assert.throws(()=>continueTask(f.deps,f.input()),/再開してから要約/);assert.equal(f.history.state(f.p.id,f.task.id).generation,2);
});

test('R4: 未commit journalの起動復旧は保存済み選別から同じ切替を完了する',t=>{
 const f=fixture(t,{long:false});chat.writeMeta(f.p.dir,f.task.id,{sessions:{codex:'old'}});const input=f.input(),rename=fs.renameSync,meta=chat.files(f.p.dir,f.task.id).meta;
 fs.renameSync=(a,b)=>{if(b===meta)throw Error('interrupted rollback');return rename(a,b);};try{assert.equal(continueTask(f.deps,input).rotate,'uncertain');}finally{fs.renameSync=rename;}
 const restarted=new TaskHistory({store:f.store});assert.equal(restarted.failure,'');const status=restarted.continueStatus(f.p.id,f.task.id,input.requestId);assert.equal(status.status,'done');assert.equal(status.result.rotate,'ok');assert.equal(restarted.state(f.p.id,f.task.id).generation,2);
 assert.equal(startContinue({history:restarted,budget:f.budget},input).generation,2);assert.equal(restarted.archives(f.p.id,f.task.id).length,1);
});
test('R4: 本文整理の中断を復旧してから切替だけを再試行できる',t=>{
 const f=fixture(t),input=f.input({body:f.body()});f.budget.checkpoint=(phase)=>{if(phase==='write')throw Error('body interrupted');};const out=continueTask(f.deps,input);assert.equal(out.pending,true);assert.equal(f.history.continueStatus(f.p.id,f.task.id,input.requestId).status,'uncertain');assert.throws(()=>continueTask(f.deps,f.input()),/再送せず/);
 f.budget.checkpoint=()=>{};f.budget.recover({project:f.p.id,task:f.task.id,confirm:true});const result=require('../lib/task-continue').recoverContinue(f.deps,{...input,confirm:true});assert.equal(result.rotate,'pending');assert.equal(result.body,'ok');const archived=f.budget.archives(f.p.id,f.task.id).length;
 assert.equal(finishSelection(f.history,f.p.id,f.task.id).generation,2);assert.equal(f.budget.archives(f.p.id,f.task.id).length,archived);
});
