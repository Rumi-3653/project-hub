'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process'),{randomUUID}=require('node:crypto');
const {Store}=require('../lib/store'),chat=require('../lib/chat'),{TaskHistory}=require('../lib/task-history'),{TextBudget,sections}=require('../lib/text-budget'),{continueTask,recoverContinue}=require('../lib/task-continue');
function fixture(t){const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-tidy-merge-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const store=new Store(root),p=store.createProject({name:'Fixture'}).project,task=store.createTask(p.id,{title:'Task',steps:['人の実機確認']}),file=store.taskFile(p.id,task.id);store.appendSection(p.id,task.id,'メモ','- 記録😀\n'.repeat(7000));store.appendSection(p.id,task.id,'成果','- なし：今回の保全対象');store.appendSection(p.id,task.id,'残件申告','- 実機は未確認');chat.append(p.dir,task.id,{role:'user',text:'作業コピーの統合を承認します。本体反映は保留'});chat.append(p.dir,task.id,{role:'assistant',text:'本体反映も承認されました'});const history=new TaskHistory({store}),budget=new TextBudget({store});return {root,store,p,task,file,history,budget,input(){const s=history.status(p.id,task.id);return {project:p.id,task:task.id,confirm:true,generation:s.generation,revision:s.revision,requestId:randomUUID()};}};}
function selecting(h,p,t){const plan=h.autoCollect(p,t);h.setAuto(p,t,{...plan,stage:'selecting'});}
for(const phase of ['body','archive','switching'])test('実プロセス中断 '+phase+' →再起動は済段を繰り返さず同IDの切替を完了する',t=>{
 const f=fixture(t),input={...f.input(),body:{token:f.budget.preview(f.p.id,f.task.id).token,confirm:true}};
 const script=`const {Store}=require('./lib/store'),{TaskHistory}=require('./lib/task-history'),{TextBudget}=require('./lib/text-budget'),{continueTask}=require('./lib/task-continue');const store=new Store(${JSON.stringify(f.root)}),history=new TaskHistory({store,checkpoint:p=>{if(p===${JSON.stringify(phase)})process.exit(77);}}),budget=new TextBudget({store});const b=${JSON.stringify(input)};b.body.token=budget.preview(b.project,b.task).token;continueTask({history,budget},b);const plan=history.autoCollect(b.project,b.task);history.setAuto(b.project,b.task,{...plan,stage:'selecting'});history.autoFinish(b.project,b.task);`;
 const died=spawnSync(process.execPath,['-e',script],{cwd:path.join(__dirname,'..'),env:process.env,encoding:'utf8'});assert.equal(died.status,77,died.stderr);
 const archiveCount=f.budget.archives(f.p.id,f.task.id).length,bodyBytes=fs.readFileSync(f.file),r=f.history.continueRecord(f.p.id,f.task.id),archiveId=r.archiveId;
 const restarted=new TaskHistory({store:f.store});assert.equal(restarted.failure,'');
 if(phase==='body'){assert.equal(recoverContinue({history:restarted,budget:f.budget},input).pending,true);selecting(restarted,f.p.id,f.task.id);restarted.autoFinish(f.p.id,f.task.id);}
 const status=restarted.continueStatus(f.p.id,f.task.id,input.requestId);assert.equal(status.status,'done');assert.equal(status.result.generation,2);assert.equal(status.result.body,'ok');assert.equal(restarted.archives(f.p.id,f.task.id).length,1);assert.equal(f.budget.archives(f.p.id,f.task.id).length,archiveCount);
 if(archiveId)assert.equal(status.result.archiveId,archiveId);
 assert.equal(continueTask({history:restarted,budget:f.budget},input).duplicate,true);assert.equal(restarted.state(f.p.id,f.task.id).generation,2);
 const beforeSections=sections(bodyBytes.toString()),after=sections(fs.readFileSync(f.file,'utf8'));for(const name of ['成果','残件申告','メモ'])assert.equal(after.find(s=>s.name===name)?.body,beforeSections.find(s=>s.name===name)?.body,name);
 assert.equal(restarted.archive(f.p.id,f.task.id,status.result.archiveId).rows.length,2);
});
test('保管後に別の更新が入った場合、起動復旧は上書きせず止まり原文を保持する',t=>{
 const f=fixture(t),input=f.input();continueTask(f,input);selecting(f.history,f.p.id,f.task.id);f.history.checkpoint=phase=>{if(phase==='archive')throw Error('interrupted');};assert.throws(()=>f.history.autoFinish(f.p.id,f.task.id),/interrupted/);
 const r=f.history.continueRecord(f.p.id,f.task.id);fs.appendFileSync(f.file,'\n外部更新\n');const changed=fs.readFileSync(f.file);const restarted=new TaskHistory({store:f.store});assert.match(restarted.failure,/復旧照合/);assert.deepEqual(fs.readFileSync(f.file),changed);assert.equal(restarted.state(f.p.id,f.task.id).generation,1);assert.ok(fs.existsSync(restarted.journalFile(f.p.id,f.task.id)));assert.equal(restarted.continueRecord(f.p.id,f.task.id).archiveId,r.archiveId);
});
test('12万字自動予約と手動押下は一つの受付になり、自動では本文を整理しない',t=>{
 const f=fixture(t),before=sections(fs.readFileSync(f.file,'utf8')).find(x=>x.name==='メモ').body;
 const job=f.history.autoReserveLong(f.p.id,f.task.id,{chars:120001});assert.equal(job.stage,'reserved');
 assert.throws(()=>continueTask(f,{...f.input(),body:{token:f.budget.preview(f.p.id,f.task.id).token,confirm:true}}),/再送せず|整理中/);assert.equal(f.history.autoStart(f.p.id,f.task.id,{requestId:randomUUID(),generation:1}).id,job.id);
 selecting(f.history,f.p.id,f.task.id);f.history.autoFinish(f.p.id,f.task.id);assert.equal(f.history.archives(f.p.id,f.task.id).length,1);assert.equal(f.budget.archives(f.p.id,f.task.id).length,0);assert.equal(sections(fs.readFileSync(f.file,'utf8')).find(x=>x.name==='メモ').body,before);assert.equal(f.history.continueStatus(f.p.id,f.task.id).result.body,'skipped');
});
test('同IDの受付照合中も本文整理・選別予約を二重実行しない',t=>{
 const f=fixture(t),input={...f.input(),body:{token:f.budget.preview(f.p.id,f.task.id).token,confirm:true}};
 const first=continueTask(f,input),count=f.budget.archives(f.p.id,f.task.id).length,job=f.history.autoJob(f.p.id,f.task.id);assert.equal(first.pending,true);selecting(f.history,f.p.id,f.task.id);const again=continueTask(f,input);assert.equal(again.duplicate,true);assert.equal(again.pending,true);assert.equal(f.history.autoJob(f.p.id,f.task.id).id,job.id);assert.equal(f.budget.archives(f.p.id,f.task.id).length,count);
 f.history.autoFinish(f.p.id,f.task.id);assert.equal(f.history.state(f.p.id,f.task.id).generation,2);
});
