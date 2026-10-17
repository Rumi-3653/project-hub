'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),{randomUUID}=require('node:crypto');
const {Store}=require('../lib/store'),chat=require('../lib/chat'),{TaskHistory}=require('../lib/task-history'),{TextBudget}=require('../lib/text-budget'),{Removal}=require('../lib/remove'),{continueTask:startContinue,recoverContinue}=require('../lib/task-continue'),locale=require('./ui-locale-fixture');

// 選別CLIは呼ばず、受付後の自動処理をfixtureの会話で完了させる。
function finishSelection(history,project,task){
 const a=history.autoJob(project,task);if(!a||!['reserved','selecting','writing'].includes(a.stage))return history.continueStatus(project,task).result;
 if(a.stage==='reserved'){const plan=history.autoCollect(project,task);history.setAuto(project,task,{...plan,stage:'selecting'});}
 try{return history.autoFinish(project,task);}catch(e){return history.continueRecord(project,task).result;}
}
function continueTask(deps,b){const out=startContinue(deps,b);return out.pending?finishSelection(deps.history,b.project,b.task):out;}

const source=fs.readFileSync(path.join(__dirname,'../public/task-history.js'),'utf8');
function fixture(t){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-continue-ui-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const store=new Store(root),p=store.createProject({name:'Fixture'}).project,task=store.createTask(p.id,{title:'Task',steps:['確認']});store.appendSection(p.id,task.id,'成果','- なし：確認のみ');chat.append(p.dir,task.id,{role:'user',text:'旧原文'});
 const history=new TaskHistory({store}),budget=new TextBudget({store}),removal=new Removal({store,trash:path.join(root,'Trash')}),deps={history,budget},storage=new Map(),calls=[];
 let loss='',resetError=false;history.reset=()=>{if(resetError)throw Error('reset failed');};
 const api=async(route,body)=>{
  calls.push({route,body});const u=new URL(route,'http://fixture'),q=u.searchParams,project=body?.project||q.get('project'),id=body?.task||q.get('task');
  switch(u.pathname){
   case '/api/task/history/status':return {...history.status(project,id),selection:history.selectionPreview(project,id)};
   case '/api/task/history/auto':return {generation:history.state(project,id).generation,auto:history.autoJob(project,id)};
   case '/api/task/body/preview':return budget.preview(project,id);
   case '/api/task/body/recover':return budget.recover(body);
   case '/api/task/history/archives':return {archives:history.archives(project,id)};
   case '/api/task/body/archives':return {archives:budget.archives(project,id)};
   case '/api/task/continue/status':return history.continueStatus(project,id,q.get('requestId'));
   case '/api/task/continue':{if(loss==='before')throw Error('network lost');const result=continueTask(deps,body);if(loss==='after')throw Error('response lost');return result;}
   case '/api/task/continue/recover':return recoverContinue(deps,body);
   case '/api/task/completion':{const result=store.decideTask(project,id,body.action,body.expectedHash);if(result.error)throw Error(result.error);return result;}
   case '/api/task/tidy/preview':return removal.tidyPreview(project,id);
   case '/api/task/tidy/apply':return removal.tidyApply(body);
   default:throw Error('unexpected route '+route);
  }
 };
 const browser=(language='ja')=>{
  const elements=new Map(),handlers=new Map();
  const el=key=>{if(!elements.has(key))elements.set(key,{innerHTML:'',value:'',checked:false,disabled:false,hidden:false,textContent:''});return elements.get(key);};
  const sheet=el('#task-history-sheet');sheet.hidden=true;el('#history-progress').dataset={p:p.id,t:task.id};let html='';Object.defineProperty(sheet,'innerHTML',{get:()=>html,set:value=>{
   html=value;for(const k of [...elements.keys()])if(k.startsWith('[data-history-field')||['#finish-continue','#finish-tidy','#history-confirm','#continue-body','#continue-body-confirm','#tidy-confirm'].includes(k))elements.delete(k);
   for(const m of value.matchAll(/<textarea data-history-field="([^"]+)">([\s\S]*?)<\/textarea>/g))el('[data-history-field="'+m[1]+'"]').value=m[2];
   for(const m of value.matchAll(/<input[^>]*id="([^"]+)"([^>]*)>/g))el('#'+m[1]).checked=/\bchecked\b/.test(m[2]);
  }});
  const context=vm.createContext({$:key=>['#finish-continue','#finish-tidy','#continue-body','#continue-body-confirm'].includes(key)?elements.get(key):el(key),esc:x=>String(x??''),UI:locale(language),crypto:{randomUUID},URLSearchParams,api,
   localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
   setInterval(){},setTimeout(){},clearTimeout(){},CSS:{escape:String},document:{querySelector:()=>null,body:{insertAdjacentHTML(){}},addEventListener:(k,f)=>handlers.set(k,f),querySelectorAll:()=>[...html.matchAll(/data-tidy-id="([^"]+)"/g)].map(m=>({checked:true,dataset:{tidyId:m[1]}}))},
   toast(){},load:async()=>{},render(){},confirm:()=>true,renderedMainKey:'old'});
  vm.runInContext(source,context);
  const click=async action=>{const button={dataset:{historyAction:action},disabled:false};await handlers.get('click')({target:{closest:selector=>selector==='[data-history-action]'?button:null}});return button;};
  const open=async()=>{const button={dataset:{taskHistory:'continue',p:p.id,t:task.id}};await handlers.get('click')({target:{closest:selector=>selector==='[data-task-history]'?button:null}});};
  return {context,el,elements,click,open,run:code=>vm.runInContext(code,context),html:()=>html};
 };
 return {root,store,p,task,history,budget,removal,storage,calls,browser,set loss(v){loss=v;},set resetError(v){resetError=v;}};
}
const writes=f=>f.calls.filter(x=>x.route==='/api/task/continue');
test('中止済みの古い保存IDがあっても新しいクリック1回で開始する',async t=>{
 const f=fixture(t),a=f.browser(),requestId=randomUUID();
 f.history.autoStart(f.p.id,f.task.id,{requestId,generation:1,trigger:'continue'});
 f.history.autoCancel(f.p.id,f.task.id);
 a.context.continueRequest(f.p.id,f.task.id,{requestId,generation:1,status:'pending'});
 await a.open();
 assert.equal(writes(f).length,1);assert.notEqual(writes(f)[0].body.requestId,requestId);
 assert.equal(f.history.state(f.p.id,f.task.id).generation,2);assert.equal(f.storage.size,0);
});
test('古い保存IDの中止が確定していても現在AI稼働中なら送信せず理由を残す',async t=>{
 const f=fixture(t),a=f.browser(),requestId=randomUUID();
 f.history.autoStart(f.p.id,f.task.id,{requestId,generation:1,trigger:'continue'});
 f.history.autoCancel(f.p.id,f.task.id);
 a.context.continueRequest(f.p.id,f.task.id,{requestId,generation:1,status:'pending'});
 f.history.busy=()=>({message:'AIの作業が終わるまで待ってください',code:'target-ai'});
 await a.open();
 assert.equal(writes(f).length,0);assert.equal(f.storage.size,0);
 assert.equal(a.el('#history-progress').textContent,'AIの作業が終わるまで待ってください');
});
test('今回受け付けた処理の失敗は自動で再送しない',async t=>{
 const f=fixture(t),a=f.browser(),api=a.context.api;
 a.context.api=async(route,body)=>{
  if(route==='/api/task/continue'){
   f.calls.push({route,body});
   const result={ok:false,body:'skipped',rotate:'failed',error:'選別に失敗しました'};
   f.history.saveContinue(f.p.id,f.task.id,{requestId:body.requestId,generation:1,status:'failed',phase:'selection',result});
   return result;
  }
  return api(route,body);
 };
 await a.open();await a.context.refreshAuto(f.p.id,f.task.id);
 assert.equal(writes(f).length,1);assert.equal(f.history.state(f.p.id,f.task.id).generation,1);
 assert.equal(a.el('#history-progress').textContent,'選別に失敗しました');
});
test('1クリック：確認画面なしで内部確認・本文保管・会話切替し、連打は1件',async t=>{
 const f=fixture(t),a=f.browser();f.store.appendSection(f.p.id,f.task.id,'メモ','- OLD-BODY\n'.repeat(4000));
 const api=a.context.api;let release;a.context.api=async(route,body)=>{if(route==='/api/task/continue')await new Promise(r=>release=r);return api(route,body);};
 const first=a.open();while(!release)await new Promise(r=>setImmediate(r));await a.open();release();await first;
 assert.equal(writes(f).length,1);assert.equal(writes(f)[0].body.automatic,true);assert.equal(writes(f)[0].body.body.confirm,true);
 assert.equal(a.el('#task-history-sheet').hidden,true);assert.equal(a.html(),'');assert.equal(f.history.state(f.p.id,f.task.id).generation,2);
 assert.ok(f.budget.archives(f.p.id,f.task.id).length);assert.equal(f.history.archive(f.p.id,f.task.id,f.history.archives(f.p.id,f.task.id)[0].id).rows[0].text,'旧原文');assert.equal(f.storage.size,0);
});
test('通信の返事を待つ前に整理中を表示し、三つの読取りを並行する。古い状態でもボタンを戻さない',async t=>{
 const f=fixture(t),a=f.browser(),button={disabled:false,textContent:'要約して続ける'},reads=[],api=a.context.api;
 a.context.document.querySelector=()=>button;
 let release;const held=new Promise(r=>release=r);
 a.context.api=async(route,body)=>{if(!body){reads.push(route);await held;}return api(route,body);};
 const first=a.open();assert.equal(button.disabled,true);assert.equal(button.textContent,'整理中…');
 assert.match(a.el('#history-progress').innerHTML,/会話の準備中/);
 assert.equal(reads.length,3);assert.ok(reads.some(route=>route.includes('selection=0')));
 a.context.drawAuto(f.p.id,f.task.id,{generation:1,auto:null});assert.equal(button.disabled,true);
 await a.open();assert.equal(reads.length,3,'連打しても読取りを重ねない');
 release();await first;assert.equal(button.disabled,false);assert.equal(button.textContent,'要約して続ける');
 assert.equal(writes(f).length,1);assert.equal(f.history.state(f.p.id,f.task.id).generation,2);
});
test('対象AI稼働時はPOSTも予約もせず、下部案内を更新で消さない',async t=>{
 const f=fixture(t),a=f.browser(),message='この作業のAIが作業中です。作業が終わってから、もう一度［要約して続ける］を押してください';
 f.history.busy=()=>({message,code:'target-ai'});await a.open();await a.context.refreshAuto(f.p.id,f.task.id);
 assert.equal(writes(f).length,0);assert.equal(f.history.autoJob(f.p.id,f.task.id),null);assert.equal(a.el('#history-progress').textContent,message);assert.equal(a.el('#history-progress').hidden,false);assert.equal(a.html(),'');
});
test('安全に本文整理できない時は会話のみ進め、共有本文を変更しない',async t=>{
 const f=fixture(t),a=f.browser();f.store.appendSection(f.p.id,f.task.id,'メモ','- KEEP-BODY\n'.repeat(4000));f.budget.busy=()=> '共有ファイルが使用中';
 await a.open();assert.equal(writes(f).length,1);assert.equal(writes(f)[0].body.body,undefined);assert.equal(f.history.state(f.p.id,f.task.id).generation,2);assert.equal(f.budget.archives(f.p.id,f.task.id).length,0);assert.match(fs.readFileSync(f.store.taskFile(f.p.id,f.task.id),'utf8'),/KEEP-BODY/);
});
test('応答消失はID照合だけで完了し、未着はIDを保持して再送しない',async t=>{
 for(const loss of ['after','before']){
  const f=fixture(t),a=f.browser();f.loss=loss;await a.open();assert.equal(writes(f).length,1);assert.equal(a.html(),'');
  const b=f.browser();await b.context.refreshAuto(f.p.id,f.task.id);assert.equal(writes(f).length,1);assert.equal(f.history.archives(f.p.id,f.task.id).length,loss==='after'?1:0);
  if(loss==='before'){assert.ok(f.storage.size);assert.match(b.el('#history-progress').textContent,/未確認/);}else assert.equal(f.storage.size,0);
 }
});
test('切替後の後処理中断は内部で復旧し、切替もPOSTも重ねない',async t=>{
 const f=fixture(t),a=f.browser();let once=true;f.history.reset=()=>{if(once){once=false;throw Error('one-shot reset interruption');}};
 await a.open();assert.equal(writes(f).length,1);assert.equal(f.history.state(f.p.id,f.task.id).generation,2);assert.equal(f.history.continueStatus(f.p.id,f.task.id).status,'done');assert.equal(a.html(),'');assert.equal(f.storage.size,0);
});
test('本文書込み中断を内部照合で復旧して同じ処理を続行する',async t=>{
 const f=fixture(t),a=f.browser();f.store.appendSection(f.p.id,f.task.id,'メモ','- BODY-RECOVERY\n'.repeat(4000));let once=true;f.budget.checkpoint=phase=>{if(phase==='write'&&once){once=false;throw Error('one-shot body interruption');}};
 await a.open();finishSelection(f.history,f.p.id,f.task.id);await a.context.refreshAuto(f.p.id,f.task.id);
 assert.equal(writes(f).length,1);assert.equal(f.calls.filter(x=>x.route==='/api/task/body/recover').length,1);assert.equal(f.history.continueStatus(f.p.id,f.task.id).status,'done');assert.equal(f.history.archives(f.p.id,f.task.id).length,1);assert.equal(a.html(),'');
});
test('保管直後の中断は整理中表示のままでも再読込時に内部復旧し、再送しない',async t=>{
 const f=fixture(t),a=f.browser(),requestId=randomUUID();let once=true;
 f.history.checkpoint=phase=>{if(phase==='archive'&&once){once=false;throw Error('one-shot archive interruption');}};
 const input={project:f.p.id,task:f.task.id,requestId,generation:1,revision:f.history.revision(f.p.id,f.task.id),confirm:true,automatic:true};
 startContinue({history:f.history,budget:f.budget},input);finishSelection(f.history,f.p.id,f.task.id);
 assert.equal(f.history.autoJob(f.p.id,f.task.id).stage,'writing');assert.equal(f.history.continueStatus(f.p.id,f.task.id).status,'uncertain');
 a.context.continueRequest(f.p.id,f.task.id,{requestId,status:'uncertain'});await a.context.refreshAuto(f.p.id,f.task.id);
 assert.equal(f.history.continueStatus(f.p.id,f.task.id).status,'done');assert.equal(f.history.archives(f.p.id,f.task.id).length,1);assert.equal(writes(f).length,0);assert.equal(f.calls.filter(x=>x.route==='/api/task/continue/recover').length,1);assert.equal(a.html(),'');assert.equal(f.storage.size,0);
});
test('内部復旧と定期照合が重なっても、本文の復旧は一回だけ実行する',async t=>{
 const f=fixture(t),a=f.browser();f.store.appendSection(f.p.id,f.task.id,'メモ','- BODY-RECOVERY\n'.repeat(4000));let once=true;
 f.budget.checkpoint=phase=>{if(phase==='write'&&once){once=false;throw Error('one-shot body interruption');}};
 const api=a.context.api;let release;a.context.api=async(route,body)=>{if(route==='/api/task/body/recover')await new Promise(r=>release=r);return api(route,body);};
 const first=a.open();while(!release)await new Promise(r=>setImmediate(r));await a.context.refreshAuto(f.p.id,f.task.id);release();await first;finishSelection(f.history,f.p.id,f.task.id);await a.context.refreshAuto(f.p.id,f.task.id);
 assert.equal(f.calls.filter(x=>x.route==='/api/task/body/recover').length,1);assert.equal(writes(f).length,1);assert.equal(f.history.continueStatus(f.p.id,f.task.id).status,'done');assert.equal(a.html(),'');assert.equal(f.storage.size,0);
});
test('POST直前の拒否は保存IDを解除し、原因を下部に残す',async t=>{
 const f=fixture(t),a=f.browser(),api=a.context.api;a.context.api=async(route,body)=>{if(route==='/api/task/continue')throw Object.assign(Error('保守作業中'),{stage:'not-started'});return api(route,body);};
 await a.open();assert.equal(f.storage.size,0);assert.equal(f.history.state(f.p.id,f.task.id).generation,1);assert.equal(a.el('#history-progress').textContent,'保守作業中');assert.equal(a.html(),'');
});
for(const language of ['ja','zh-TW']){
 test('旧finish R3 '+language+': 応答喪失後に閉じる・対象往復・再読込しても照合前に再送しない',async t=>{
  const f=fixture(t),a=f.browser(language);await a.context.showContinue(f.p.id,f.task.id,'',null,{tidy:false});a.el('#history-confirm').checked=true;f.loss='after';await a.click('continue');assert.equal(writes(f).length,1);assert.equal(f.history.state(f.p.id,f.task.id).generation,2);
  const requestId=writes(f)[0].body.requestId;assert.ok(f.storage.size);await a.click('close');
  const other=f.store.createTask(f.p.id,{title:'Other'});await a.context.showContinue(f.p.id,other.id,'',null,{tidy:false});assert.equal(a.run('historyDialog.unresolved'),false);
  const b=f.browser(language);await b.context.showContinue(f.p.id,f.task.id,'',null,{tidy:false});assert.equal(b.run('historyDialog.prepared'),true);assert.ok(f.calls.some(x=>x.route.includes('/continue/status?')&&x.route.includes(requestId)));await b.click('continue');assert.equal(writes(f).length,1);assert.equal(f.history.archives(f.p.id,f.task.id).length,1);
 });
 test('旧finish R3 '+language+': 未着を推測で解除せず、未確認IDを再読込後も保持し要約入力を表示しない',async t=>{
  const f=fixture(t),a=f.browser(language);await a.context.showContinue(f.p.id,f.task.id,'',null,{tidy:false});a.el('#history-confirm').checked=true;f.loss='before';await a.click('continue');const id=writes(f)[0].body.requestId;
  const b=f.browser(language);await b.context.showContinue(f.p.id,f.task.id,'',null,{tidy:false});assert.equal(b.run('historyDialog.unresolved'),true);assert.equal(b.run('historyDialog.requestId'),id);assert.doesNotMatch(b.html(),/<textarea|data-history-field/);await b.click('continue');assert.equal(writes(f).length,1);assert.equal(f.history.state(f.p.id,f.task.id).generation,1);
 });
 test('旧finish R4 '+language+': commit済みの後処理失敗は復旧表示となり切替を二度実行しない',async t=>{
  const f=fixture(t),a=f.browser(language);await a.context.showContinue(f.p.id,f.task.id,'',null,{tidy:false});a.el('#history-confirm').checked=true;f.resetError=true;await a.click('continue');
  assert.equal(a.run('historyDialog.unresolved'),true);assert.match(a.html(),/data-history-action="continuerecover"/);assert.doesNotMatch(a.html(),/会話の切り替えは未実行|對話尚未切換/);
  f.resetError=false;await a.click('continuerecover');assert.equal(a.run('historyDialog.prepared'),true);assert.equal(f.history.state(f.p.id,f.task.id).generation,2);assert.equal(writes(f).length,1);
 });
 test('完了 '+language+': 短い確認から1回だけ承認し、会話・成果・一時物を保持する',async t=>{
  const f=fixture(t),a=f.browser(language),hash=f.store.readTask(f.store.taskFile(f.p.id,f.task.id)).completionHash;
  const temp=path.join(f.p.dir,'.ai/work',f.task.id,'scratch');fs.mkdirSync(path.dirname(temp),{recursive:true});fs.writeFileSync(temp,'一時物');
  await a.context.showCompletion(f.p.id,f.task.id,hash);
  assert.doesNotMatch(a.html(),/<input|<fieldset/);assert.equal((a.html().match(/data-history-action="complete"/g)||[]).length,1);
  assert.match(a.html(),language==='ja'?/成果・会話・作業用コピーはそのまま残ります/:/成果、對話與工作副本會保留/);
  assert.equal(f.calls.length,0);
  await a.click('close');assert.equal(a.el('#task-history-sheet').hidden,true);assert.equal(f.calls.length,0);await a.context.showCompletion(f.p.id,f.task.id,hash);
  const api=a.context.api;let release,count=0;a.context.api=async(route,body)=>{count++;await new Promise(r=>release=r);return api(route,body);};
  const first=a.click('complete');assert.equal(a.run('historySaving'),true);const second=await a.click('complete');assert.equal(count,1);release();const button=await first;assert.equal(button.disabled,false);assert.equal(second.disabled,false);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].route,'/api/task/completion');assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0].body)),{project:f.p.id,task:f.task.id,action:'approve',confirm:true,expectedHash:hash});
  assert.equal(a.el('#task-history-sheet').hidden,true);const done=f.store.readTask(f.store.taskFile(f.p.id,f.task.id));assert.equal(done.state,'完了');assert.match(fs.readFileSync(f.store.taskFile(f.p.id,f.task.id),'utf8'),/- なし：確認のみ/);
  assert.equal(f.history.state(f.p.id,f.task.id).generation,1);assert.equal(f.history.archives(f.p.id,f.task.id).length,0);assert.equal(fs.readFileSync(temp,'utf8'),'一時物');assert.equal(f.storage.size,0);
 });
 test('完了 '+language+': 稼働・古いhash・成果未整備の拒否理由を残し、最新hashで再確認できる',async t=>{
  for(const reason of ['AIが稼働中','作業が変わりました','成果の記録が整っていません']){
   const f=fixture(t),a=f.browser(language),old=f.store.readTask(f.store.taskFile(f.p.id,f.task.id)).completionHash,api=a.context.api;
   await a.context.showCompletion(f.p.id,f.task.id,old);a.context.api=async route=>{assert.equal(route,'/api/task/completion');throw Object.assign(Error(reason),{status:409});};
   const b=await a.click('complete');assert.equal(b.disabled,false);assert.equal(a.run('historySaving'),false);assert.equal(a.el('#task-history-sheet').hidden,false);assert.equal(a.el('#history-status').textContent,a.context.UI.message(reason));assert.equal(f.store.readTask(f.store.taskFile(f.p.id,f.task.id)).state,'未着手');
   f.store.appendSection(f.p.id,f.task.id,'やったこと','最新記録');const hash=f.store.readTask(f.store.taskFile(f.p.id,f.task.id)).completionHash;assert.notEqual(hash,old);
   a.context.api=api;await a.context.showCompletion(f.p.id,f.task.id,hash);await a.click('complete');assert.equal(f.calls.length,1);assert.equal(f.calls[0].body.expectedHash,hash);assert.equal(a.el('#task-history-sheet').hidden,true);
  }
 });
 test('完了 '+language+': freetalkの短い文言と承認だけの経路を保持する',async t=>{
  const f=fixture(t),a=f.browser(language),calls=[];a.context.api=async(route,body)=>{calls.push({route,body});return {ok:true};};
  await a.context.showCompletion('freetalk','topic','hash');assert.doesNotMatch(a.html(),/<input|<fieldset/);assert.match(a.html(),language==='ja'?/この作業を完了に移します。あとで再開できます。/:/將此作業標記為完成。之後可以重新開始。/);
  await a.click('complete');assert.equal(calls.length,1);assert.equal(calls[0].route,'/api/task/completion');assert.equal(calls[0].body.expectedHash,'hash');
 });
 test('R5 '+language+': 旧finishの応答喪失を照合し、新hashで完了承認後だけ片付けを開く',async t=>{
  const f=fixture(t),a=f.browser(language),old=f.store.readTask(f.store.taskFile(f.p.id,f.task.id)).completionHash;
  const temp=path.join(f.p.dir,'.ai/work',f.task.id,'scratch');fs.mkdirSync(path.dirname(temp),{recursive:true});fs.writeFileSync(temp,'一時物');
  // 旧版で始めたfinishを再現。新しい完了画面からは作らない。
  await a.context.showContinue(f.p.id,f.task.id,'',null,{tidy:true});f.loss='after';await a.click('continue');assert.ok(!f.calls.some(x=>x.route==='/api/task/completion'));assert.ok(!f.calls.some(x=>x.route==='/api/task/tidy/preview'));
  const b=f.browser(language);await b.context.showContinue(f.p.id,f.task.id);assert.equal(b.run('historyDialog.prepared'),true);assert.notEqual(b.run('historyDialog.expectedHash'),old);assert.doesNotMatch(b.html(),/<input|<fieldset/);assert.equal(b.run('historyDialog.tidy'),true);assert.equal(b.context.HubChatGenerations.get(f.p.id+'\0'+f.task.id),2);assert.match(b.html(),language==='ja'?/最終要約と会話の原文を保管しました。/:/已保存最終摘要與對話原文。/);
  await b.click('complete');assert.equal(fs.existsSync(temp),true);assert.match(b.html(),/id="tidy-confirm"/);assert.ok(!f.calls.some(x=>x.route==='/api/task/tidy/apply'));assert.equal(f.store.readTask(f.store.taskFile(f.p.id,f.task.id)).state,'完了');
  const order=f.calls.map(x=>x.route);assert.ok(order.indexOf('/api/task/continue')<order.indexOf('/api/task/completion'));assert.ok(order.indexOf('/api/task/completion')<order.indexOf('/api/task/tidy/preview'));assert.equal(writes(f).length,1);
 });
 test('R5 '+language+': 旧finishの未確認処理は復旧後にpreparedへ進み、保管も承認も再送しない',async t=>{
  const f=fixture(t),a=f.browser(language);await a.context.showContinue(f.p.id,f.task.id,'',null,{tidy:false});f.resetError=true;await a.click('continue');
  const b=f.browser(language);await b.context.showContinue(f.p.id,f.task.id);assert.equal(b.run('historyDialog.unresolved'),true);assert.match(b.html(),/data-history-action="continuerecover"/);assert.equal(writes(f).length,1);
  f.resetError=false;await b.click('continuerecover');assert.equal(b.run('historyDialog.prepared'),true);assert.equal(b.run('historyDialog.tidy'),false);assert.doesNotMatch(b.html(),/<input|<fieldset/);assert.equal(writes(f).length,1);
  await b.click('complete');assert.equal(f.calls.filter(x=>x.route==='/api/task/completion').length,1);assert.ok(!f.calls.some(x=>x.route==='/api/task/tidy/preview'));assert.equal(f.history.state(f.p.id,f.task.id).generation,2);
 });
}

test('旧入口showContinueも通常作業は確認画面を開かず1クリックで完結する',async t=>{
 const f=fixture(t),a=f.browser();await a.context.showContinue(f.p.id,f.task.id);
 assert.equal(a.el('#task-history-sheet').hidden,true);assert.equal(a.html(),'');assert.equal(writes(f).length,1);assert.equal(f.history.state(f.p.id,f.task.id).generation,2);
});
test('旧入口で選別中の保存IDを未確認と誤表示せず同じ処理へ接続する',async t=>{
 const f=fixture(t),a=f.browser(),requestId=randomUUID();
 startContinue({history:f.history,budget:f.budget},{project:f.p.id,task:f.task.id,requestId,generation:1,revision:f.history.revision(f.p.id,f.task.id),confirm:true});
 a.context.continueRequest(f.p.id,f.task.id,{requestId,status:'uncertain'});
 await a.context.showContinue(f.p.id,f.task.id);assert.equal(a.html(),'');assert.equal(writes(f).length,0);
 finishSelection(f.history,f.p.id,f.task.id);await a.context.refreshAuto(f.p.id,f.task.id);
 assert.equal(f.storage.size,0);assert.equal(f.history.archives(f.p.id,f.task.id).length,1);
});

test('別タブの古いIDは受付済みの対象ジョブを照合し、再送せず接続する',async t=>{
 const f=fixture(t),a=f.browser(),requestId=randomUUID();
 startContinue({history:f.history,budget:f.budget},{project:f.p.id,task:f.task.id,requestId,generation:1,revision:f.history.revision(f.p.id,f.task.id),confirm:true});
 a.context.continueRequest(f.p.id,f.task.id,{requestId:randomUUID(),generation:1,status:'uncertain'});
 await a.open();assert.equal(writes(f).length,0);assert.equal(a.html(),'');
 finishSelection(f.history,f.p.id,f.task.id);await a.context.refreshAuto(f.p.id,f.task.id);assert.equal(f.storage.size,0);assert.equal(f.history.archives(f.p.id,f.task.id).length,1);
});
test('保管中断はlocalStorageの無い別画面でも同じ原文を照合し内部復旧する',async t=>{
 const f=fixture(t),a=f.browser(),requestId=randomUUID();let once=true;f.history.checkpoint=phase=>{if(phase==='archive'&&once){once=false;throw Error('interrupted archive');}};
 startContinue({history:f.history,budget:f.budget},{project:f.p.id,task:f.task.id,requestId,generation:1,revision:f.history.revision(f.p.id,f.task.id),confirm:true});finishSelection(f.history,f.p.id,f.task.id);
 await a.context.refreshAuto(f.p.id,f.task.id);assert.equal(f.history.continueStatus(f.p.id,f.task.id).status,'done');assert.equal(writes(f).length,0);assert.equal(f.history.archives(f.p.id,f.task.id).length,1);assert.equal(a.html(),'');
});
