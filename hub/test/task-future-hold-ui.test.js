'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {app,snapshot}=require('./fixtures/app-ui-harness.cjs');
function fixture(){
 const a=app();a.context.data=snapshot();
 vm.runInContext(`state=data;state.version='4.125.2';const p=state.projects[0],parent=p.tasks[0];p.tasks.push({...parent,id:'web',title:'web可能性',parent:'t',futureHold:true,completionHash:'original',futureHoldRevision:'rev',steps:[{done:true}]});state.taskOffers=[{project:'p',task:'web',targetProject:'p',targetTask:'t',pending:true,handedUp:true}];state.taskHandoffs=[{project:'p',task:'web',title:'web可能性',targetProject:'p',targetTask:'t'}];state.taskIntegrations=[{project:'p',task:'t',stage:'children',items:[{project:'p',task:'web'}]}];`,a.context);
 return {...a,eval:s=>vm.runInContext(s,a.context)};
}
test('保留した子の注意だけを隠し、作業一覧には将来検討と原文名を残す',()=>{
 const a=fixture();assert.equal(a.eval('kidsDoneBar(p,parent)'), '');
 const row=a.eval('taskRow(p,p.tasks[1])');assert.match(row,/web可能性/);assert.match(row,/将来検討/);assert.match(row,/data-t="web"/);
 a.eval(`p.tasks.push({...parent,id:'active',title:'活動中の子',parent:'t',steps:[{done:true}]});state.taskHandoffs.push({project:'p',task:'active',title:'活動中の子',targetProject:'p',targetTask:'t'});`);
 const html=a.eval('kidsDoneBar(p,parent)');assert.match(html,/子作業の成果/);assert.match(html,/活動中の子/);assert.doesNotMatch(html,/web可能性/);
});
test('本体反映の不明・他の旧記録・壊れた保留は隠さず、子孫にも保留を表示する',()=>{
 const a=fixture();a.eval(`state.taskIntegrations[0].mainPending={main:{state:'intent'},stopped:{reason:'元の停止'}};`);
 let html=a.eval('kidsDoneBar(p,parent)');assert.match(html,/本体への反映が未確認/);assert.match(html,/結果が不明/);assert.match(html,/元の停止/);assert.doesNotMatch(html,/子作業の成果/);
 a.eval(`p.tasks.push({...parent,id:'detail',parent:'web'});`);assert.equal(a.eval('taskFutureHeld(p,p.tasks[2])'),true);
 a.eval(`state.taskIntegrations[0].items.push({project:'p',task:'missing'});`);assert.match(a.eval('kidsDoneBar(p,parent)'),/子作業の成果/);
 a.eval(`p.tasks[1].futureHoldError='保留記録が不明';`);assert.match(a.eval('kidsDoneBar(p,parent)'),/web可能性/);
});
test('子の画面と一覧メニューで保留解除でき、解除APIだけを呼び自動開始しない',async()=>{
 const a=fixture();a.eval(`view={kind:'work',project:'p',task:'web'};renderWork();`);const html=a.element('#main').innerHTML;
 assert.match(html,/保留中/);assert.match(html,/作業・会話・比較結果・作業用コピーは残っています/);assert.match(html,/data-act="futurehold"/);assert.match(html,/保留を解除/);assert.doesNotMatch(html,/data-act="handup"/);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/hierarchy.js'),'utf8'),a.context);
 a.element('#menu').style={};a.element('#menu').offsetWidth=200;a.element('#menu').offsetHeight=100;a.element('#menu').querySelector=()=>({focus(){}});
 a.eval(`innerWidth=1000;innerHeight=800;showTreeMenu('p','web',0,0);`);assert.match(a.element('#menu').innerHTML,/data-tree-action="futurehold"/);
 const calls=[];a.context.futureAPI=async(url,body)=>{calls.push({url,body});return {ok:true,held:false};};
 a.eval(`api=futureAPI;load=async()=>{};`);await a.eval(`saveFutureHold('p','web')`);
 assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/task/future-hold');assert.equal(calls[0].body.held,false);assert.equal(calls[0].body.before,true);assert.equal(calls[0].body.expectedHash,'original');assert.equal(calls[0].body.revision,'rev');
});
test('定期取得後の古いボタンも表示時の操作方向・版を送信し、逆の操作へすり替えない',async()=>{
 const a=fixture(),calls=[];a.context.futureAPI=async(url,body)=>{calls.push({url,body});throw Error('状態が変わりました');};
 a.eval(`api=futureAPI;p.tasks[1].futureHold=false;p.tasks[1].futureHoldRevision='new';load=async()=>{};`);
 await assert.rejects(a.eval(`saveFutureHold('p','web',{dataset:{futureBefore:'true',futureRevision:'rev',futureHash:'original'}})`),/状態が変わりました/);
 assert.equal(calls.length,1);assert.equal(calls[0].body.held,false);assert.equal(calls[0].body.before,true);assert.equal(calls[0].body.revision,'rev');
});
test('旧統合の保留行は情報だけで選択・統合ボタンを出さず、停止理由と本体不明を残す',()=>{
 const a=fixture();vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/task-integrate.js'),'utf8'),a.context);
 a.eval(`integratePreview={project:'p',task:'t',resume:true,simple:true,resumeAllowed:false,resumeMessage:'将来検討の保留中',blockers:['将来検討の保留中'],items:[{task:'web',project:'p',title:'web可能性',futureHold:true}],auto:{stopped:{reason:'元の停止'},pendingMain:{main:{state:'intent'}}}};drawSimpleIntegration();`);
 const html=a.element('#integrate-sheet').innerHTML;assert.match(html,/将来検討として保留中/);assert.match(html,/以前の停止記録は残しています/);assert.match(html,/元の停止/);assert.match(html,/本体取り込みの結果が不明/);assert.doesNotMatch(html,/data-integrate-select|data-integrate-keep|data-integrate-action="single"/);
});
