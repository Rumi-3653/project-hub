'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function fixture() {
 const elements=new Map(),events={},calls=[];
 const el=s=>{if(!elements.has(s))elements.set(s,{innerHTML:'',hidden:false,textContent:'',value:'',dataset:{},addEventListener(){},setAttribute(){},querySelectorAll:()=>[],insertAdjacentHTML(){}});return elements.get(s);};
 const document={querySelector:el,querySelectorAll:()=>[],body:{insertAdjacentHTML(){},classList:{contains:()=>false}},addEventListener:(n,f)=>(events[n]||=[]).push(f)};
 const ctx=vm.createContext({document,window:{},navigator:{userAgent:''},localStorage:{getItem:()=>null,setItem(){}},fetch:()=>new Promise(()=>{}),setInterval(){},setTimeout(){},clearInterval(){},clearTimeout(){},requestAnimationFrame(){},console,URLSearchParams,ModelOrder:require('../public/model-order'),ProjectOrder:require('../public/project-order')});
 const run=s=>vm.runInContext(s,ctx);
 ctx.window.HubChatHistory = require('../public/chat-history');
 require('./fixtures/app-source.cjs').loadApp(ctx);
 run(fs.readFileSync(path.join(__dirname,'../public/task-transfer.js'),'utf8'));
 ctx.stubApi=async(route,body)=>{calls.push({route,body});if(ctx.failure){const e=Error(ctx.failure);e.status=ctx.status;throw e;}if(route.endsWith('/preview'))return{token:'fixture',title:'小作業',target:'本作業',files:[{id:'report',bytes:1}],blockers:[],guidance:''};return{parentProject:'p',parent:'parent'};};
 run(`api=stubApi;save=()=>{};load=async()=>{};render=()=>{};toast=()=>{};state={version:'4.63.2',latest:'4.63.3',projects:[{id:'p',name:'見本',tasks:[{id:'parent',title:'本作業',steps:[]},{id:'kid',title:'小作業',parent:'parent',state:'完了',steps:[]}]}],sessions:[],chatting:[]};view={kind:'work',project:'p',task:'parent'};`);
 return{ctx,run,el,calls,events,click:async action=>{for(const f of events.click||[])await f({target:{dataset:{},closest:s=>s==='[data-transfer-action]'?{dataset:{transferAction:action},disabled:false}:null}});}};
}
test('古い稼働版では帯とカードの受領を無効にし正式な版切替案内を表示する',async()=>{
 const f=fixture();f.run(`state.version='4.59.0'`);
 for(const html of [f.run('kidsDoneBar(proj("p"),taskOf(proj("p"),"parent"))'),f.run(`msgHtml({role:'user',from:'subtask',child:'kid',childTitle:'小作業',text:'結果'})`)]){assert.match(html,/disabled/);assert.match(html,/Update v4\.63\.3/);assert.match(html,/AI と順番待ちが終わってから/);}
 await f.run('showTaskTransfer("p","kid")');assert.equal(f.calls.length,0);assert.match(f.el('#transfer-sheet').innerHTML,/Update/);
 // 数字で比較し、窓口追加版から有効。
 f.run(`state.version='4.61.0'`);assert.doesNotMatch(f.run('kidsDoneBar(proj("p"),taskOf(proj("p"),"parent"))'),/disabled/);
});
test('古い結果名と現在の子が違えば別の子を指さない。旧本文・新childTitle・別プロジェクトを照合',()=>{
 const f=fixture();
 for(const row of [`{childTitle:'昔の子',text:'結果'}`,`{text:'（子作業「昔の子」の結果）\\n本文'}`]){
  const html=f.run(`msgHtml({role:'user',from:'subtask',child:'kid',...${row}})`);assert.doesNotMatch(html,/data-act="absorb"/);assert.match(html,/同じ番号の別の作業/);
 }
 const html=f.run(`msgHtml({role:'user',from:'subtask',child:'kid',text:'（子作業「小作業」の結果）\\n本文'})`);assert.match(html,/data-expect-title="小作業"/);
 f.run(`state.projects.push({id:'q',name:'別',tasks:[{id:'kid',title:'別の子',state:'完了',kind:'derived',derivedFrom:'p/parent'}]})`);
 assert.match(f.run(`msgHtml({role:'user',from:'subtask',child:'kid',childProject:'q',childTitle:'別の子',text:'結果'})`),/data-p="q"/);
 assert.match(f.run(`msgHtml({role:'user',from:'subtask',child:'kid',childTitle:'小作業',handoff:'receipt',text:'受領'})`),/もう受け取って/);
});
test('古い通知の統合ボタンを現在の祖先・承認・子の完了状態で判定し理由を表示する',()=>{
 const f=fixture(),row=`{role:'user',from:'subtask',child:'kid',childTitle:'小作業',offer:'old-offer',text:'統合できます'}`;
 const html=()=>f.run(`msgHtml(${row})`),bar=()=>f.run('kidsDoneBar(proj("p"),taskOf(proj("p"),"parent"))');
 for(const parent of [{state:'実行中',steps:[{done:true}]},{state:'完了確認待ち',completionPending:true},{state:'実行中',completionPending:false,steps:[{done:true}]}]){
  f.run(`Object.assign(proj('p').tasks[0],${JSON.stringify(parent)})`);
  assert.match(html(),/data-act="absorb"[^>]*>統合…/);assert.match(bar(),/data-act="integrate"/);
 }
 f.run(`Object.assign(proj('p').tasks[0],{state:'完了',completionPending:false})`);
 assert.doesNotMatch(html(),/data-act="absorb"/);assert.match(html(),/transfer-hint.*親は完了済み/);assert.doesNotMatch(bar(),/data-act="integrate"/);
 f.run(`proj('p').tasks[0].state='実行中';proj('p').tasks[1].state='実行中'`);
 assert.match(html(),/data-act="absorb"/);
 f.run(`proj('p').tasks[1].state='完了';proj('p').tasks[1].question='返事待ち'`);
 assert.match(html(),/data-act="absorb"/);
 f.run(`proj('p').tasks[1].question='';proj('p').tasks.push({id:'mid',title:'途中<&',parent:'parent',state:'実行中',steps:[{done:true}]});proj('p').tasks[1].parent='mid'`);
 assert.doesNotMatch(html(),/data-act="absorb"/);assert.match(html(),/未完の中間親「途中&lt;&amp;」/);
 f.run(`proj('p').tasks[2].state='完了'`);assert.match(html(),/data-act="absorb"/);
 f.run(`proj('p').tasks[1].parent='other'`);assert.doesNotMatch(html(),/data-act="absorb"/);assert.match(html(),/祖先ではありません/);
 f.run(`proj('p').tasks[1].parent='parent'`);
 assert.doesNotMatch(f.run(`msgHtml({...${row},handoff:'received',integrating:'done'})`),/data-act="absorb"/);
 assert.match(f.run(`msgHtml({...${row},handoff:'received',integrating:'done'})`),/もう受け取って/);
});
test('受領済みと照合中の通知では統合を促さず、新成果だけ入口を表示する',()=>{
 const f=fixture(),row="{role:'user',from:'subtask',child:'kid',childTitle:'小作業',offer:'old',text:'履歴本文'}";
 f.run("state.taskOffers=[{project:'p',task:'kid',targetProject:'p',targetTask:'parent',pending:false,received:{id:'receipt'},receiptChecked:true}]");
 let bar=f.run('kidsDoneBar(proj("p"),taskOf(proj("p"),"parent"))');assert.doesNotMatch(bar,/kids-done|data-act="integrate"/);
 let card=f.run(`msgHtml(${row})`);assert.doesNotMatch(card,/data-act="absorb"/);assert.match(card,/受領済み/);assert.match(card,/履歴本文/);
 f.run('state.taskOffers[0].pending=true;state.taskOffers[0].receiptChecked=false');assert.doesNotMatch(f.run('kidsDoneBar(proj("p"),taskOf(proj("p"),"parent"))'),/data-act="integrate"/);card=f.run(`msgHtml(${row})`);assert.doesNotMatch(card,/data-act="absorb"/);assert.match(card,/受領状況が未確認/);assert.match(card,/履歴本文/);
 f.run('state.taskOffers[0].receiptChecked=true');bar=f.run('kidsDoneBar(proj("p"),taskOf(proj("p"),"parent"))');assert.match(bar,/kids-done/);assert.match(f.run(`msgHtml(${row})`),/data-act="absorb"/);
 f.run("state.taskOffers[0].pending=false;state.taskOffers[0].targetTask='other'");assert.doesNotMatch(f.run('kidsDoneBar(proj("p"),taskOf(proj("p"),"parent"))'),/data-act="integrate"/);
});
test('previewと適用の404 not foundは版切替案内へ、業務エラーと通信失敗はその理由を保持',async()=>{
 const f=fixture();f.ctx.failure='not found';f.ctx.status=404;await f.run('showTaskTransfer("p","kid",[],"小作業")');assert.match(f.el('#transfer-sheet').innerHTML,/Update/);assert.match(f.el('#transfer-sheet').innerHTML,/窓口を確認できません/);assert.doesNotMatch(f.el('#transfer-sheet').innerHTML,/not found|まだ v/);
 f.ctx.failure='片付け済み';f.ctx.status=409;await f.run('showTaskTransfer("p","kid")');assert.match(f.el('#transfer-sheet').innerHTML,/片付け済み/);assert.doesNotMatch(f.el('#transfer-sheet').innerHTML,/Update/);
 f.ctx.failure='network failure';f.ctx.status=undefined;await f.run('showTaskTransfer("p","kid")');assert.match(f.el('#transfer-sheet').innerHTML,/network failure/);
 f.ctx.failure=null;await f.run('showTaskTransfer("p","kid",[],"小作業")');assert.equal(f.calls.at(-1).body.expectTitle,'小作業');
 await f.click('refresh');assert.equal(f.calls.at(-1).body.expectTitle,'小作業');
 f.ctx.failure='not found';f.ctx.status=404;await f.click('apply');assert.match(f.el('#transfer-status').textContent,/Update/);assert.equal(f.calls.at(-1).body.expectTitle,'小作業');
});

test('ファイル選択を出さず内容説明と閉じた詳細、成果記録不足のAI回復を出す',()=>{
 const f=fixture();f.ctx.data={title:'子',target:'親',files:[{id:'report',bytes:1,description:'確認結果'}],blockers:[],guidance:''};f.run('drawTaskTransfer(data)');
 let html=f.el('#transfer-sheet').innerHTML;assert.match(html,/本作業に入るもの.*確認結果/);assert.doesNotMatch(html,/data-transfer-file|transfer-paths|<details open>/);
 f.run(fs.readFileSync(path.join(__dirname,'../public/task-integrate.js'),'utf8'));
 f.ctx.item={title:'子',files:[],move:[],optional:[],keep:[],blockers:['成果の記録がありません'],needsResults:true};f.run("integratePreview={target:'copy',items:[item]};drawTaskIntegration()");
 html=f.el('#integrate-sheet').innerHTML;assert.match(html,/この子のAIに成果の整理を頼む/);assert.match(html,/取り込んで片付ける/);assert.doesNotMatch(html,/data-integrate-file|data-integrate-optional|<details open>|ファイルを指定/);
 f.ctx.item={title:'子',checked:true,copy:'child-copy',files:[{id:'report',description:'調査結果',bytes:1}],results:[{kind:'本体保存済み',value:'repo@abcdef0',description:'人数追加'}],move:[],optional:[],keep:[],blockers:[]};f.run("integratePreview={target:'copy',items:[item]};drawTaskIntegration()");
 html=f.el('#integrate-sheet').innerHTML;for(const text of ['本作業に入るもの','作業用コピーの変更','調査結果','Gitに保存済み','人数追加','取り込んで片付ける'])assert.ok(html.includes(text));assert.doesNotMatch(html,/data-integrate-file|data-integrate-optional/);
 f.ctx.item.retainedFolders=['original-folder'];f.run('drawTaskIntegration()');html=f.el('#integrate-sheet').innerHTML;
 assert.match(html,/未受領の内容がある専用フォルダは、そのまま残します/);assert.doesNotMatch(html,/data-integrate-file|data-integrate-optional/);
});

 test('復旧画面は保存先・現在地・保持・受領前・更新を表示し、blockerなら承認できない',()=>{
 const f=fixture();f.run(fs.readFileSync(path.join(__dirname,'../public/task-integrate.js'),'utf8'));
 f.run(`integratePreview={resume:true,target:'new<&',recover:{savedTarget:'old<&',currentTarget:'new<&',reasons:['変更<&']},items:[{title:'済んだ子',state:'片付け済み',retained:true},{title:'残る子',state:'衝突',codeAlready:true,recordChanged:true,sourceChanged:true}],blockers:[]};drawTaskIntegration()`);
 let html=f.el('#integrate-sheet').innerHTML;assert.match(html,/保存された統合先：old&lt;&amp;/);assert.match(html,/現在の統合先：new&lt;&amp;/);assert.match(html,/片付け済み/);assert.match(html,/コード取り込み済み（確認）/);assert.match(html,/受領・片付けはこれから/);assert.match(html,/記録の更新あり/);assert.match(html,/統合を始める/);
 f.run(`integratePreview.blockers=['予約<&'];drawTaskIntegration()`);html=f.el('#integrate-sheet').innerHTML;assert.match(html,/予約&lt;&amp;/);assert.match(html,/data-integrate-action="apply"[^>]*disabled/);
 f.run(`integratePreview.blockers=[];integratePreview.recover.currentTarget=integratePreview.recover.savedTarget;drawTaskIntegration()`);assert.match(f.el('#integrate-sheet').innerHTML,/統合を始める/);
 });

test('衝突を表示しても再解消ボタンを出さず、開始後はサーバーに任せる',async()=>{
 const f=fixture();f.run(fs.readFileSync(path.join(__dirname,'../public/task-integrate.js'),'utf8'));
 f.run(`integratePreview={project:'p',task:'parent',token:'t',resume:true,target:'copy',items:[{title:'コード',project:'p',task:'kid',state:'衝突',conflictPaths:['code<&.js']},{title:'済み',state:'衝突',codeAlready:true}],blockers:[]};drawTaskIntegration()`);
 const html=f.el('#integrate-sheet').innerHTML;assert.match(html,/code&lt;&amp;\.js/);assert.match(html,/取り込み済み（受領待ち）/);assert.doesNotMatch(html,/data-integrate-action="resolve"|AIでぶつかりを解消/);assert.match(html,/統合を始める/);
 f.ctx.stubApi=async(route,body)=>{f.calls.push({route,body});return {partial:true};};f.run('api=stubApi');
 for(const listener of f.events.click||[])await listener({target:{dataset:{},closest:s=>s==='[data-integrate-action]'?{dataset:{integrateAction:'apply'},disabled:false}:null}});
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].route,'/api/task/integrate');assert.equal(f.calls[0].body.auto,true);assert.equal(f.calls[0].body.thenMain,true);assert.equal(f.el('#integrate-sheet').hidden,true);
});

test('途中成果の確認では固定partialを選び、通常の保持受領と混ぜない',async()=>{
 const f=fixture();f.run(fs.readFileSync(path.join(__dirname,'../public/task-integrate.js'),'utf8'));
 f.ctx.stubApi=async()=>({target:'fixture',items:[{project:'p',task:'kid',title:'途中',partial:true,files:[],move:[],optional:[],keep:[],blockers:[]}]});f.run('api=stubApi');await f.run('showTaskIntegration("p","parent")');
 const html=f.el('#integrate-sheet').innerHTML;assert.doesNotMatch(html,/data-integrate-mode/);assert.doesNotMatch(html,/<option value="continue" selected/);assert.equal(f.run('integratePreview.items[0].disposition'),'partial');assert.match(html,/渡し済みの途中成果は固定範囲で受領/);
});

function integrationForm(){
 const f=fixture();f.ctx.stubApi=async(route,body)=>{f.calls.push({route,body});if(f.ctx.failure)throw Error(f.ctx.failure);return {complete:true};};f.run('api=stubApi');f.run(fs.readFileSync(path.join(__dirname,'../public/task-integrate.js'),'utf8'));
 const fields=['scope','planned','undecided','residual','evidence'];
 const inputs=Object.fromEntries(fields.map(k=>[k,{dataset:{integrateReview:k},value:'人の編集 '+k,disabled:false,focus(){f.focus=k;},scrollIntoView(){}}]));
 const check={checked:true,disabled:false},confirm={checked:false,disabled:false,focus(){f.focus='confirm';},scrollIntoView(){}},mode={value:'continue',disabled:false};
 const section={dataset:{integrateItem:'0'},querySelector:s=>s==='[data-integrate-check]'?check:s==='[data-integrate-confirm]'?confirm:mode,querySelectorAll:()=>Object.values(inputs)};
 const apply=f.el('#integrate-sheet [data-integrate-action="apply"]');apply.dataset={integrateAction:'apply'};
 const close={dataset:{integrateAction:'close'},disabled:false};
 for(const [k,input]of Object.entries(inputs))f.ctx.document.querySelector('#integrate-sheet [data-integrate-item="0"] [data-integrate-review="'+k+'"]')&&Object.assign(f.el('#integrate-sheet [data-integrate-item="0"] [data-integrate-review="'+k+'"]'),input);
 Object.assign(f.el('#integrate-sheet [data-integrate-item="0"] [data-integrate-confirm]'),confirm);
 f.ctx.document.querySelectorAll=s=>s==='[data-integrate-item]'?[section]:s.includes('textarea')?[apply,close,check,confirm,mode,...Object.values(inputs)]:[];
 f.run(`integratePreview={project:'p',task:'parent',token:'old-token',target:'target',items:[{project:'p',task:'kid',title:'対象の子',source:{head:'old-head'},checked:true,disposition:'continue',review:{sourceHead:'old-head'},files:[],move:[],optional:[],keep:[],blockers:[],descendants:[]}],blockers:[]};drawTaskIntegration();`);
 const click=async button=>{for(const handler of f.events.click||[])await handler({target:{dataset:{},closest:s=>s==='[data-integrate-action]'?button:null}});};
 const refresh=()=>click({dataset:{integrateAction:'refresh'},disabled:false});
 return Object.assign(f,{inputs,check,confirm,mode,apply,close,click,refresh});
}
test('開始クリックを承認として五欄入力・確認チェックなしで一度だけ送る',async()=>{
 const f=integrationForm();await f.click(f.apply);assert.equal(f.calls.length,1);assert.equal(f.calls[0].route,'/api/task/integrate');assert.equal(f.calls[0].body.auto,true);assert.equal(f.calls[0].body.thenMain,true);assert.equal(f.calls[0].body.selected[0].review,undefined);assert.equal(f.el('#integrate-sheet').hidden,true);assert.doesNotMatch(f.el('#integrate-sheet').innerHTML,/data-integrate-confirm|data-integrate-review/);
});
test('統合の通信不明は編集と閉じるを戻し、記録再取得まで再送しない',async()=>{
 const f=integrationForm();f.confirm.checked=true;f.ctx.failure='connection lost';await f.click(f.apply);
 assert.equal(f.calls.length,1);assert.equal(f.apply.disabled,true);assert.equal(f.close.disabled,false);assert.equal(f.inputs.planned.disabled,false);assert.match(f.el('#integrate-status').textContent,/再送せず/);
 await f.click(f.apply);assert.equal(f.calls.length,1);
 f.ctx.failure=null;f.ctx.stubApi=async(route,body)=>{f.calls.push({route,body});return {token:'fresh',target:'target',items:[{project:'p',task:'kid',title:'対象の子',source:{head:'new-head'},review:{sourceHead:'new-head',confirmed:false,planned:'変更された予定'},files:[],move:[],optional:[],keep:[],blockers:[]}]};};f.run('api=stubApi');
 await f.refresh();assert.equal(f.calls.length,2);assert.equal(f.calls[1].route,'/api/task/integrate/preview');assert.equal(f.run('integratePreview.items[0].review.sourceHead'),'new-head');assert.equal(f.run('integratePreview.items[0].review.confirmed'),false);assert.equal(f.run('integratePreview.items[0].review.planned'),'人の編集 planned');assert.equal(f.run('integratePreview.token'),'fresh');assert.equal(f.apply.disabled,false);
});
test('統合の送信中は入力・閉じる・二重押しを止め、409後は再確認だけ許す',async()=>{
 const f=integrationForm();f.confirm.checked=true;let release;f.ctx.stubApi=async(route,body)=>{f.calls.push({route,body});await new Promise(r=>release=r);const e=Error('期限切れ');e.status=409;throw e;};f.run('api=stubApi');
 const pending=f.click(f.apply);await new Promise(r=>setImmediate(r));assert.equal(f.apply.disabled,true);assert.equal(f.close.disabled,true);assert.equal(f.inputs.scope.disabled,true);await f.click(f.apply);assert.equal(f.calls.length,1);
 release();await pending;assert.equal(f.close.disabled,false);assert.equal(f.inputs.scope.disabled,false);assert.equal(f.apply.disabled,true);assert.match(f.el('#integrate-status').textContent,/期限切れ・途中/);
});
test('最新記録の取得失敗でも旧下書きと再確認の道を残す',async()=>{
 const f=integrationForm();f.confirm.checked=true;f.ctx.failure='failed';await f.click(f.apply);await f.refresh();assert.equal(f.run('integratePreview.items[0].review.planned'),'人の編集 planned');assert.equal(f.run('integratePreview.requiresRefresh'),true);assert.equal(f.apply.disabled,true);assert.equal(f.close.disabled,false);
});

test('統合の成功形式でない応答は受領完了にせず、記録確認まで再送しない',async()=>{
 for(const out of [{},null,{complete:false}, {partial:false}]){
  const f=integrationForm();f.confirm.checked=true;f.ctx.stubApi=async(route,body)=>{f.calls.push({route,body});return out;};f.run('api=stubApi');await f.click(f.apply);
  assert.equal(f.calls.length,1);assert.equal(f.apply.disabled,true);assert.equal(f.close.disabled,false);assert.notEqual(f.el('#integrate-sheet').hidden,true);assert.match(f.el('#integrate-status').textContent,/再送せず/);await f.click(f.apply);assert.equal(f.calls.length,1);
 }
});
