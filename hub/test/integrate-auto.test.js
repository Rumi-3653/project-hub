'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {IntegrateAuto}=require('../lib/integrate-auto'),contract=require('../lib/task-continuation');
function setup(){
 let r={project:'p',task:'t',target:'copy',complete:false,items:[{project:'p',task:'child',title:'子',source:{head:'source'},taskHash:'hash',files:[],results:[],review:{confirmed:true},disposition:'continue',state:'衝突',conflictPaths:['file']}],auto:{attempts:{},targetHead:'before',mainHead:'main',thenMain:true}};
 r.auto.scope=structuredClone(r.items.map(({project,task,source,taskHash,files,results,review,disposition})=>({project,task,source,taskHash,files,results,review,disposition})));
 let head='before',busy=false,runs=0,mains=0,issues=[],notes=[];
 const integrate={read:()=>structuredClone(r),save:x=>{r=structuredClone(x);},pending:()=>r.auto.main?.state==='done'?[]:[{project:'p',task:'t'}],store:{readProject:()=>({id:"p",dir:"copy"})},ancestor:()=>({t:{},target:"copy",p:{id:"p",dir:"copy"}}),resumePreview:()=>({blockers:[],recover:null}),gitw:{inspect:()=>({head,status:''}),merging:()=>false,isAncestor:(d,h)=>h===head||head==='resolved'&&['source','before'].includes(h)},run:x=>{runs++;x.items[0].state='保持受領済み';x.complete=true;integrate.save(x);}};
 const auto=new IntegrateAuto({integrate,busy:()=>busy,dispatch:async x=>issues.push(x),mergeMain:async(r,{begin})=>{begin();mains++;return {ok:true,retained:true,main:'body'};},notify:x=>notes.push(x)});
 auto.pendingRequest=()=>true;
 return {auto,integrate,get r(){return r;},get runs(){return runs;},get mains(){return mains;},issues,notes,setHead:x=>{head=x;},setBusy:x=>{busy=x;}};
}
test('保存済み衝突は再mergeせず一度だけ委任、独立合格後に受領と保持本体取込',async()=>{
 const f=setup();await f.auto.tick();assert.equal(f.runs,0);assert.equal(f.issues.length,1);const k=Object.keys(f.r.auto.attempts)[0];
 await Promise.all([f.auto.tick(),f.auto.tick()]);assert.equal(f.issues.length,1);
 f.setHead('resolved');f.auto.settled({project:'p',task:'t',text:`[integration-auto:${k}:code]`},{text:'保存済み'});
 await f.auto.tick();assert.equal(f.issues.length,2);assert.equal(f.runs,0);
 f.auto.settled({project:'p',task:'t',text:`[integration-auto:${k}:review]`},{text:`[integration-review:${k}:pass]`,integrationAuto:{closed:true,isolation:{version:1,resumed:false,request:f.r.auto.attempts[k].delivery.request}}});
 await Promise.all([f.auto.tick(),f.auto.tick()]);assert.equal(f.runs,1);assert.equal(f.mains,1);assert.equal(f.r.auto.main.state,'done');await f.auto.tick();assert.equal(f.mains,1);
});
test('上限の保存順番待ちは交代担当の終了まで保持、全AI稼働中は進めない',async()=>{
 const f=setup();f.setBusy(true);await f.auto.tick();assert.equal(f.issues.length,0);f.setBusy(false);await f.auto.tick();const k=Object.keys(f.r.auto.attempts)[0];
 f.auto.settled({project:'p',task:'t',text:`[integration-auto:${k}:code]`},{error:'正式上限',request:'original',integrationAuto:{limit:true}});assert.equal(f.r.auto.stopped,undefined);assert.equal(f.r.auto.attempts[k].phase,'code');
});
test('同じmarkerの依頼が残っていても任意のerrorを無視しない',async()=>{
 const f=setup();await f.auto.tick();const k=Object.keys(f.r.auto.attempts)[0];
 f.auto.settled({project:'p',task:'t',text:`[integration-auto:${k}:code]`},{error:'起動失敗',request:'original'});
 assert.equal(f.r.auto.stopped.reason,'起動失敗');await f.auto.tick();assert.equal(f.issues.length,1);
});
test('再起動後は保存済みの自然終了記録から継続し、委任を重ねない',async()=>{
 const f=setup();await f.auto.tick();const k=Object.keys(f.r.auto.attempts)[0];f.auto.pendingRequest=()=>false;f.setHead('resolved');
 f.auto.savedCompletion=()=>({text:'保存済み'});await f.auto.tick();assert.equal(f.r.auto.attempts[k].phase,'needs-review');await f.auto.tick();assert.equal(f.issues.length,2);
});
for(const mode of ['人停止','不明委任','解消未完','レビュー不合格','範囲改変','HEAD改変','本体結果不明'])test('原因未修正の再試行をせず保存して停止：'+mode,async()=>{
 const f=setup();
 if(mode==='範囲改変'){const r=f.r;r.items[0].files=['追加'];f.integrate.save(r);}
 if(mode==='HEAD改変')f.setHead('other');
 if(mode==='本体結果不明'){const r=f.r;r.items[0].state='保持受領済み';r.complete=true;f.integrate.save(r);f.auto.mergeMain=async(r,{begin})=>{begin();throw Error('通信不明');};}
 await f.auto.tick();const k=Object.keys(f.r.auto.attempts)[0];
 if(mode==='人停止')f.auto.stop('p','t');
 if(mode==='不明委任'){f.auto.pendingRequest=()=>false;await f.auto.tick();}
 if(mode==='解消未完')f.auto.settled({project:'p',task:'t',text:`[integration-auto:${k}:code]`},{text:'完了という主張'});
 if(mode==='レビュー不合格'){f.setHead('resolved');f.auto.settled({project:'p',task:'t',text:`[integration-auto:${k}:code]`},{text:'保存'});await f.auto.tick();f.auto.settled({project:'p',task:'t',text:`[integration-auto:${k}:review]`},{text:'要修正'});}
 assert.ok(f.r.auto.stopped);const count=f.issues.length,runs=f.runs;await f.auto.tick();await f.auto.tick();assert.equal(f.issues.length,count);assert.equal(f.runs,runs);
});
test('残件申告は成果と同じ文書に保存、不明は保持し偽のなしを拒否',()=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'remaining-'));try{const file=path.join(root,'task.md');fs.writeFileSync(file,'## 成果\n');assert.equal(contract.declaration(file).status,'不明');
 const r={status:'あり',items:'Windows保留',undecided:'PR#2未採用',evidence:'確認記録'};fs.writeFileSync(file,'## 残件申告\n```json\n'+JSON.stringify(r)+'\n```\n\n## メモ\n原文');assert.deepEqual(contract.declaration(file),r);assert.equal(contract.declaredReview(r,'HEAD').residual,r.items);
 assert.throws(()=>contract.remaining({...r,status:'なし'}));fs.appendFileSync(file,'\n## 残件申告\n```json\n{}\n```');assert.throws(()=>contract.declaration(file));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

for(const sent of [false,true])test('本体の事前拒否と送信後不明を記録境界で区別、再起動/再読込の再送0：'+sent,async()=>{
 const f=setup(),r=f.r;r.complete=true;r.items[0].state='保持受領済み';f.integrate.save(r);let calls=0;
 f.auto.mergeMain=async(r,{begin})=>{calls++;assert.equal(f.integrate.read().auto.main,undefined);if(sent){begin();assert.equal(f.integrate.read().auto.main.state,'intent');}throw Error(sent?'通信不明':'本体取り込みの前提を確認できません');};
 await f.auto.tick();assert.equal(calls,1);assert.equal(f.r.auto.main.state,sent?'intent':'not-sent');assert.ok(f.r.auto.stopped);assert.equal(f.r.auto.main.reason,sent?undefined:'本体取り込みの前提を確認できません');const stopped=f.r;delete stopped.auto.stopped;f.integrate.save(stopped);
 const restarted=new IntegrateAuto({integrate:f.integrate,mergeMain:async()=>assert.fail('再送禁止')});await restarted.tick();assert.ok(f.r.auto.stopped);const before=JSON.stringify(f.r);await restarted.tick();assert.equal(JSON.stringify(f.r),before);assert.equal(calls,1);
 if(sent)assert.equal(restarted.resumeStatus(f.r).allowed,false);else assert.doesNotMatch(restarted.resumeStatus(f.r).message,/本体取り込みの結果が不明/);
});
test('本体の開始境界は正式操作より先に保存し、成功後のみdone、二重begin拒否',async()=>{
 const f=setup(),r=f.r;r.complete=true;r.items[0].state='保持受領済み';f.integrate.save(r);let calls=0;
 f.auto.mergeMain=async(r,{begin})=>{begin();calls++;assert.equal(f.integrate.read().auto.main.state,'intent');assert.throws(begin,/再送/);return {ok:true,retained:true,main:'body'};};await f.auto.tick();assert.equal(f.r.auto.main.state,'done');await f.auto.tick();assert.equal(calls,1);
});

test('自動統合のtickは対象ごとに待ち、先頭の別プロジェクトがbusyでも次の統合と本体段階を進める',async()=>{
 const records=new Map(['blocked','ready'].map(project=>[project,{project,task:'t',target:project,items:[],complete:false,auto:{scope:[],attempts:{},targetHead:'head',thenMain:true}}]));
 const ran=[],merged=[],contexts=[];
 const integrate={pending:()=>[...records.values()],read:p=>records.get(p),save:r=>records.set(r.project,r),store:{readProject:p=>({id:p,dir:p})},ancestor:p=>{contexts.push(p);return {t:{},target:p,p:{id:p,dir:p}};},resumePreview:()=>({blockers:[]}),gitw:{inspect:()=>({head:'head',status:''}),merging:()=>false},run:r=>{ran.push(r.project);r.complete=true;}};
 const auto=new IntegrateAuto({integrate,busy:r=>r?.project==='blocked',mergeMain:async(r,{begin})=>{begin();merged.push(r.project);return {ok:true,retained:true,main:'body'};}});
 await auto.tick();assert.deepEqual(contexts,['ready']);assert.deepEqual(ran,['ready']);assert.deepEqual(merged,['ready']);assert.equal(records.get('blocked').complete,false);
});

for(const state of ['not-sent','aborted'])for(const returned of [false,true])test('formal main '+state+' after begin stays definite and never resends: returned='+returned,async()=>{
 const f=setup(),r=f.r;r.complete=true;r.items[0].state='保持受領済み';f.integrate.save(r);let calls=0;
 f.auto.mergeMain=async(r,{begin})=>{calls++;begin();const out={ok:false,error:'definite refusal',delivery:{state}};if(returned)return out;throw Object.assign(Error(out.error),{delivery:out.delivery});};
 await f.auto.tick();assert.equal(f.r.auto.main.state,state);assert.equal(f.r.auto.main.delivery.state,state);assert.ok(f.r.auto.stopped);assert.equal(calls,1);
 const saved=f.r;delete saved.auto.stopped;f.integrate.save(saved);await f.auto.tick();assert.equal(calls,1);assert.equal(f.r.auto.main.state,state);assert.ok(f.r.auto.stopped);
});
