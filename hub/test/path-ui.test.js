'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
const code=source.slice(source.indexOf('// 場所を押した時は開き方を選ぶ。'),source.indexOf('// コマンドなどの細かい作業を会話に出すか'));
function fixture(inApp=false,info={},locale='ja') {
 const elements=new Map(),events=new Map(),windowEvents=new Map(),calls=[],notices=[];
 const node=()=>({innerHTML:'',hidden:true,inert:false,isConnected:true,dataset:{},style:{position:'',top:'',left:'',width:'',overflow:''},handlers:{},attributes:{},children:[],
  setAttribute(k,v){this.attributes[k]=v;},addEventListener(k,f){this.handlers[k]=f;},
  querySelector(s){return this.parts?.get(s)||((this.parts||=new Map()).set(s,node()).get(s));},
  querySelectorAll(s){return s==='[data-fv-close]'?[this.querySelector(s),this.querySelector('.fv-mobile-close')]:[];},
  replaceChildren(...kids){this.children=kids;},focus(options){this.focused=options;doc.activeElement=this;},blur(){doc.activeElement=doc.body;},
  remove(){this.isConnected=false;doc.body.children=doc.body.children.filter(x=>x!==this);}});
 const el=id=>{if(!elements.has(id))elements.set(id,node());return elements.get(id);};
 const doc={body:node(),createElement:node,addEventListener:(name,f)=>events.set(name,f)};
 doc.body.insertAdjacentHTML=()=>{};doc.body.appendChild=n=>doc.body.children.push(n);
 doc.body.children=[el('#conversation'),el('#fsheet'),el('#draft')];
 const win={scrollX:0,scrollY:240,focus(){},addEventListener:(k,f)=>windowEvents.set(k,f),scrollTo(x,y){this.scrollX=x;this.scrollY=y;}};
 const history={state:{original:true},pushState(s){this.previous=this.state;this.state=s;},back(){this.state=this.previous;windowEvents.get('popstate')();},replaceState(s){this.state=s;}};
 const ctx=vm.createContext({UI:require('./ui-locale-fixture')(locale),navigator:{userAgent:inApp?'ProjectHubApp':''},location:{href:''},view:{project:'p &',task:'t/'},$:el,
  window:win,document:doc,history,AbortController,setTimeout,clearTimeout,
  fetch:async()=>({ok:true,text:async()=>'<script>bad()</script>\n文字'}),
  esc:x=>String(x).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),
  toast:x=>notices.push(x),copyText:x=>notices.push(x),
  api:async(route,b)=>{calls.push({route,...b});return {ok:true,path:'/Users/test/資料 <元>/記事.md',dir:false,how:b.how,...info};}});
 vm.runInContext(code,ctx);
 const click=dataset=>events.get('click')({target:{closest:()=>({dataset,classList:{contains:()=>false}})}});
 return {ctx,el,calls,notices,click,events,windowEvents,history,doc,win};
}
test('ファイルを押しても開かず、元ファイル/Finderの選択と場所を表示する',async()=>{
 const f=fixture();await f.ctx.showPath('資料/記事.md');
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].how,'info');assert.equal(f.calls[0].path,'資料/記事.md');
 const html=f.el('#fsheet').innerHTML;
 assert.match(html,/元のファイルを開く/);assert.match(html,/Finderで表示/);assert.match(html,/コピーを作らず/);
 assert.match(html,/data-fs-open="\/Users\/test\/資料 &lt;元&gt;\/記事.md"/);
 assert.doesNotMatch(html,/ダウンロード/);assert.equal(f.ctx.location.href,'');assert.equal(f.notices.length,0);
});
test('選んだ時だけ元ファイルを開くかFinderで表示するAPIを送る',async()=>{
 const f=fixture();const original='/Users/test/資料 <元>/記事.md';
 await f.click({fsOpen:original});await f.click({fsFinder:original});
 assert.deepEqual(f.calls.map(x=>({path:x.path,how:x.how,app:x.app})),[{path:original,how:'open',app:false},{path:original,how:'finder',app:false}]);
});
test('Macアプリでも選択前は開かず、選択後に元の場所をアプリへ渡す',async()=>{
 const f=fixture(true),original='/Users/test/空 白/原文.png';
 f.ctx.api=async(route,b)=>{f.calls.push({route,...b});return {ok:true,path:original,dir:false,how:b.how,...(b.how==='info'?{}:{byApp:true})};};
 await f.ctx.showPath(original);assert.equal(f.ctx.location.href,'');
 await f.click({fsOpen:original});
 assert.equal(f.ctx.location.href,'hubapp://reveal?dir=0&open=1&path='+encodeURIComponent(original));
 await f.click({fsFinder:original});
 assert.equal(f.ctx.location.href,'hubapp://reveal?dir=0&open=0&path='+encodeURIComponent(original));
});
test('フォルダはFinder/中身を見るを選び、一覧のファイルも開き方を選ぶ',async()=>{
 const f=fixture(),folder='/Users/test/資料';
 f.ctx.api=async(route,b)=>{f.calls.push({route,...b});return {ok:true,path:b.path,dir:b.path===folder,how:b.how,...(b.how==='list'?{entries:[{name:'記事.md',path:folder+'/記事.md',dir:false,size:20}],parent:'/Users/test'}:{})};};
 await f.ctx.showPath(folder);
 assert.match(f.el('#fsheet').innerHTML,/Finderで開く/);assert.match(f.el('#fsheet').innerHTML,/中身を見る/);
 assert.doesNotMatch(f.el('#fsheet').innerHTML,/data-fs-open/);
 await f.click({fsList:folder});assert.equal(f.calls.at(-1).how,'list');
 assert.match(f.el('#fsheet').innerHTML,/data-fs-file/);assert.match(f.el('#fsheet').innerHTML,/data-fs-list="\/Users\/test"/);
 await f.click({fsFile:folder+'/記事.md'});assert.equal(f.calls.at(-1).how,'info');
 assert.match(f.el('#fsheet').innerHTML,/元のファイルを開く/);
 await f.click({fsDir:folder});assert.equal(f.calls.at(-1).how,'info');
});
test('読み取り失敗は理由を知らせ、開いたことにせず選択画面も出さない',async()=>{
 const f=fixture();f.ctx.api=async()=>{throw Error('見つかりません');};
 await f.ctx.showPath('/missing');assert.deepEqual(f.notices,['見つかりません']);
 assert.equal(f.el('#fsheet').hidden,true);assert.equal(f.ctx.location.href,'');
});
test('画像はシートにプレビューし、ページを移動しない閲覧ボタンを出す',async()=>{
 const original='/Users/test/空 白&<元>/画像.png',f=fixture(false,{path:original,view:true,remote:false});
 await f.ctx.showPath(original);const html=f.el('#fsheet').innerHTML;
 assert.match(html,/<img class="fs-img"[^>]*loading="lazy">/);
 assert.match(html,/alt="画像.png"/);assert.match(html,/<button type="button" class="btn"[^>]*data-fs-view=[^>]*>画像を見る<\/button>/);assert.doesNotMatch(html,/target="_blank"/);
 const url='/api/file/view?project='+encodeURIComponent('p &')+'&task='+encodeURIComponent('t/')+'&path='+encodeURIComponent(original);
 assert.ok(html.includes('src="'+url.replaceAll('&','&amp;')+'"'));
 assert.ok(html.indexOf('画像を見る')<html.indexOf('data-fs-open'));
 assert.match(html,/この画面で画像を見られます/);assert.match(html,/元のファイルを開く/);assert.match(html,/Finderで表示/);
 assert.equal(f.calls.length,1);assert.equal(f.ctx.location.href,'');
});
test('外からは画像・非画像・フォルダのMac操作を隠し、閲覧とコピーを残す',async()=>{
 for(const info of [{view:true},{view:false},{view:false,dir:true}]) {
  const f=fixture(false,{...info,remote:true});await f.ctx.showPath('資料/画像.png');const html=f.el('#fsheet').innerHTML;
  assert.doesNotMatch(html,/data-fs-open|data-fs-finder|元のファイルを開く|Finderで表示|Finderで開く/);
  if(info.view||info.dir)assert.match(html,/このMacの前でだけ/);else assert.match(html,/この形式はスマホでは開けません/);assert.match(html,/場所をコピー/);assert.match(html,/閉じる/);
  if(info.view) {assert.match(html,/fs-img/);assert.match(html,/画像を見る/);}
  else assert.doesNotMatch(html,/fs-img|画像を見る/);
  if(info.dir)assert.match(html,/中身を見る/);
 }
});
test('PDF・テキスト・Wordは開くボタンで閲覧し、画像プレビューを出さない',async()=>{
 for(const kind of ['pdf','text','doc'])for(const locale of ['ja']) {
  const f=fixture(false,{view:true,viewKind:kind,remote:true},locale);await f.ctx.showPath('資料/文書');
  const html=f.el('#fsheet').innerHTML;
  assert.match(html,new RegExp('data-view-kind="'+kind+'"'));
  assert.match(html,locale==='ja'?/>開く<\/button>/:/>開啟<\/button>/);
  assert.doesNotMatch(html,/target="_blank"|fs-img|data-fs-open|data-fs-finder/);
  if(kind==='doc')assert.match(html,locale==='ja'?/複雑な表/:/複雜表格/);
 }
});
test('対象外形式と容量超過の遠隔案内は日本語で閲覧ボタンを出さない',async()=>{
 for(const locale of ['ja']) {
  const f=fixture(false,{view:false,viewKind:'',remote:true},locale);await f.ctx.showPath('資料/対象外.xlsx');
  const html=f.el('#fsheet').innerHTML;
  assert.match(html,locale==='ja'?/この形式はスマホでは開けません/:/手機無法開啟此格式/);
  assert.doesNotMatch(html,/data-fs-view|data-fs-open|data-fs-finder/);
 }
});
test('遠隔フォルダの一覧でもMac操作を表示しない',async()=>{
 const f=fixture(false,{dir:true,entries:[],remote:true});await f.ctx.showPath('資料','list');
 assert.doesNotMatch(f.el('#fsheet').innerHTML,/data-fs-finder|data-fs-open/);
 assert.match(f.el('#fsheet').innerHTML,/場所をコピー|閉じる/);
});
test('閉じる・Esc・戻るは会話とシートを保持し、履歴・スクロール・フォーカスを復元する',async()=>{
 for(const method of ['button','escape','back']) {
  const f=fixture(false,{view:true,viewKind:'text'});await f.ctx.showPath('記事.txt');
  const sheet=f.el('#fsheet'),chat=f.el('#conversation'),draft=f.el('#draft');chat.scrollTop=140;draft.value='入力中';
  const html=sheet.innerHTML,trigger={isConnected:true,focus(options){this.options=options;}};
  await f.ctx.showFileViewer('/Users/test/記事.txt','text',trigger);
  const viewer=f.doc.body.children.at(-1),body=viewer.querySelector('.fv-body');
  assert.match(viewer.innerHTML,/data-fv-close>閉じる/);assert.match(body.innerHTML,/&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.equal(f.doc.body.style.position,'fixed');assert.equal(f.doc.body.style.top,'-240px');assert.equal(chat.inert,true);assert.ok(f.history.state.fviewer);
  if(method==='button')viewer.querySelector('[data-fv-close]').handlers.click();
  else if(method==='back')f.history.back();
  else {let prevented=false;f.events.get('keydown')({key:'Escape',preventDefault(){prevented=true;},stopImmediatePropagation(){}});assert.equal(prevented,true);}
  assert.equal(viewer.isConnected,false);assert.equal(sheet.hidden,false);assert.equal(sheet.innerHTML,html);assert.equal(chat.scrollTop,140);assert.equal(draft.value,'入力中');
  assert.equal(f.win.scrollY,240);assert.equal(f.doc.body.style.position,'');assert.equal(chat.inert,false);assert.equal(trigger.options.preventScroll,true);assert.equal(f.history.state.original,true);
 }
});
test('取得失敗や履歴APIが使えない時にも閲覧画面内の閉じるが使える',async()=>{
 const f=fixture();f.history.pushState=()=>{throw Error('history unavailable');};f.ctx.fetch=async()=>({ok:false});
 await f.ctx.showFileViewer('/Users/test/記事.txt','text',{isConnected:true,focus(){}});
 const viewer=f.doc.body.children.at(-1);assert.match(viewer.querySelector('.fv-body').innerHTML,/role="alert"/);
 viewer.querySelector('[data-fv-close]').handlers.click();assert.equal(viewer.isConnected,false);assert.equal(f.ctx.location.href,'');
});
test('スマホ下部の閉じるは日繁の画像表示から会話・下書き・スクロールへ即座に戻る',async()=>{
 for(const locale of ['ja','zh-TW']) {
  const f=fixture(false,{},locale),chat=f.el('#conversation'),draft=f.el('#draft');
  chat.scrollTop=140;draft.value='入力中';
  const trigger={isConnected:true,focus(options){this.options=options;}};
  await f.ctx.showFileViewer('/Users/test/画像.png','image',trigger);
  const viewer=f.doc.body.children.at(-1),img=viewer.querySelector('.fv-body').children[0];
  assert.equal((viewer.innerHTML.match(/data-fv-close/g)||[]).length,2);
  assert.match(viewer.innerHTML,locale==='ja'?/fv-mobile-controls.*>閉じる</:/fv-mobile-controls.*>關閉</);
  img.onload();assert.equal(viewer.querySelector('.fv-body').attributes['aria-busy'],'false');
  viewer.querySelector('.fv-mobile-close').handlers.click();
  assert.equal(viewer.isConnected,false);assert.equal(chat.inert,false);assert.equal(chat.scrollTop,140);
  assert.equal(draft.value,'入力中');assert.equal(f.win.scrollY,240);assert.equal(f.doc.body.style.position,'');
  assert.equal(trigger.options.preventScroll,true);assert.equal(f.history.state.fviewer,undefined);
 }
});
test('スマホの拡大・移動・回転で閉じる操作が可視範囲に追従し、終了後は購読を解除する',async()=>{
 const f=fixture(),listeners=new Map();
 const viewport=f.win.visualViewport={width:390,height:660,offsetLeft:0,offsetTop:0,scale:1,
  addEventListener(k,cb){assert.equal(listeners.has(k),false);listeners.set(k,cb);},
  removeEventListener(k,cb){assert.equal(listeners.get(k),cb);listeners.delete(k);}};
 for(const method of ['mobile','top','escape','back']) {
  Object.assign(viewport,{width:390,height:660,offsetLeft:0,offsetTop:0,scale:1});
  await f.ctx.showFileViewer('/Users/test/画像.png','image',{isConnected:true,focus(){}});
  const viewer=f.doc.body.children.at(-1),controls=viewer.querySelector('.fv-mobile-controls');
  assert.equal(controls.style.width,'390px');assert.equal(controls.style.transform,'translate(0px, 660px) scale(1) translateY(-100%)');
  Object.assign(viewport,{width:195,height:300,offsetLeft:100,offsetTop:180,scale:2});listeners.get('resize')();
  assert.equal(controls.style.width,'390px');assert.equal(controls.style.transform,'translate(100px, 480px) scale(0.5) translateY(-100%)');
  viewport.offsetTop=250;listeners.get('scroll')();
  assert.equal(controls.style.transform,'translate(100px, 550px) scale(0.5) translateY(-100%)');
  Object.assign(viewport,{width:660,height:280,offsetLeft:0,offsetTop:0,scale:1});listeners.get('resize')();
  assert.equal(controls.style.width,'660px');assert.equal(controls.style.transform,'translate(0px, 280px) scale(1) translateY(-100%)');
  if(method==='back')f.history.back();
  else if(method==='escape')f.events.get('keydown')({key:'Escape',preventDefault(){},stopImmediatePropagation(){}});
  else viewer.querySelector(method==='mobile'?'.fv-mobile-close':'[data-fv-close]').handlers.click();
  assert.equal(viewer.isConnected,false);assert.equal(listeners.size,0);
 }
});
test('スマホ下部の閉じるは履歴APIなし・画像読込失敗・読込中でも動作する',async()=>{
 for(const fail of [false,true]) {
  const f=fixture();f.history.pushState=()=>{throw Error('unavailable');};
  await f.ctx.showFileViewer('/Users/test/画像.png','image',{isConnected:true,focus(){}});
  const viewer=f.doc.body.children.at(-1),body=viewer.querySelector('.fv-body'),img=body.children[0];
  if(fail){img.onerror();assert.match(body.innerHTML,/role="alert"/);}
  viewer.querySelector('.fv-mobile-close').handlers.click();assert.equal(viewer.isConnected,false);
  img.onload();assert.equal(f.el('#conversation').inert,false);assert.equal(f.doc.body.style.position,'');
 }
 const f=fixture();let finish,signal;
 f.ctx.fetch=(url,options)=>{signal=options.signal;return new Promise(resolve=>{finish=resolve;});};
 const loading=f.ctx.showFileViewer('/Users/test/記事.txt','text',{isConnected:true,focus(){}}),viewer=f.doc.body.children.at(-1);
 viewer.querySelector('.fv-mobile-close').handlers.click();assert.equal(signal.aborted,true);
 finish({ok:true,text:async()=>'遅い応答'});await loading;
 assert.equal(viewer.isConnected,false);assert.doesNotMatch(viewer.querySelector('.fv-body').innerHTML,/遅い応答/);
});
test('閉じた後の遅い応答を捨て、読み込みを中断する',async()=>{
 const f=fixture();let finish,signal;
 f.ctx.fetch=(url,options)=>{signal=options.signal;return new Promise(resolve=>{finish=resolve;});};
 const loading=f.ctx.showFileViewer('/Users/test/記事.txt','text',{isConnected:true,focus(){}}),viewer=f.doc.body.children.at(-1);
 viewer.querySelector('[data-fv-close]').handlers.click();assert.equal(signal.aborted,true);
 finish({ok:true,text:async()=>'遅い応答'});await loading;
 assert.equal(viewer.isConnected,false);assert.doesNotMatch(viewer.querySelector('.fv-body').innerHTML,/遅い応答/);
});
test('Wordの表示はスクリプトを許さないiframeと読込禁止CSPを使う',async()=>{
 const f=fixture();f.ctx.fetch=async()=>({ok:true,text:async()=>'<html><body>本文</body></html>'});
 await f.ctx.showFileViewer('/Users/test/記事.docx','doc',{isConnected:true,focus(){}});
 const frame=f.doc.body.children.at(-1).querySelector('.fv-body').children[0];
 assert.equal(frame.attributes.sandbox,'');assert.match(frame.srcdoc,/Content-Security-Policy/);assert.match(frame.srcdoc,/default-src 'none'/);assert.match(frame.srcdoc,/本文/);
 f.ctx.closeFileViewer();
});
test('iframeの履歴だけが戻りpopstateが無くても閉じるは即座に会話を復元する',async()=>{
 for(const locale of ['ja'])for(const kind of ['doc','pdf']) {
  const f=fixture(false,{},locale);let back=0;
  const sheet=f.el('#fsheet'),chat=f.el('#conversation'),draft=f.el('#draft');
  sheet.hidden=false;sheet.innerHTML='選択画面';chat.scrollTop=140;draft.value='入力中';
  // iframe内の戻るでは親のpopstateが来ない。何度待っても解除不能だった経路。
  f.history.back=()=>{back++;};
  const trigger={isConnected:true,focus(options){this.options=options;}};
  await f.ctx.showFileViewer('/Users/test/文書',kind,trigger);
  const viewer=f.doc.body.children.at(-1);
  viewer.querySelector('[data-fv-close]').handlers.click();
  assert.equal(viewer.isConnected,false);assert.equal(chat.inert,false);assert.equal(f.doc.body.style.position,'');
  assert.equal(chat.scrollTop,140);assert.equal(draft.value,'入力中');assert.equal(sheet.innerHTML,'選択画面');assert.equal(sheet.hidden,false);
  assert.equal(trigger.options.preventScroll,true);assert.equal(f.win.scrollY,240);
  assert.equal(f.history.state.original,true);assert.equal(f.history.state.fviewer,undefined);assert.equal(back,0);
  f.ctx.closeFileViewer();assert.equal(back,0);
 }
});
test('履歴の戻るや置換が失敗しても画面解除とフォーカス復元を完了する',async()=>{
 for(const method of ['back','replaceState']) {
  const f=fixture();await f.ctx.showFileViewer('/Users/test/文書.docx','doc',{isConnected:true,focus(){}});
  const viewer=f.doc.body.children.at(-1);f.history[method]=()=>{throw Error('unavailable');};
  assert.doesNotThrow(()=>f.ctx.closeFileViewer());assert.equal(viewer.isConnected,false);
  assert.equal(f.el('#conversation').inert,false);assert.equal(f.doc.body.style.position,'');
 }
});
test('文書とPDF本文のフォーカスから親へ戻しEscの押下または解放で閉じる',async()=>{
 for(const locale of ['ja'])for(const kind of ['doc','pdf'])for(const event of ['keydown','keyup']) {
  const f=fixture(false,{},locale);await f.ctx.showFileViewer('/Users/test/文書',kind,{isConnected:true,focus(){}});
  const viewer=f.doc.body.children.at(-1),button=viewer.querySelector('[data-fv-close]'),frame=viewer.querySelector('.fv-body').children[0];
  assert.equal(frame.tabIndex,-1);f.doc.activeElement=frame;f.windowEvents.get('blur')();
  assert.equal(f.doc.activeElement,button);
  let prevented=false;f.events.get(event)({key:'Escape',preventDefault(){prevented=true;},stopImmediatePropagation(){}});
  assert.equal(prevented,true);assert.equal(viewer.isConnected,false);assert.equal(f.el('#conversation').inert,false);
  await new Promise(setImmediate);
  assert.equal(viewer.isConnected,false);
 }
});
test('iframe内の遷移後にも戻る操作で閉じ、閉じた後の読込では履歴を増やさない',async()=>{
 for(const kind of ['doc','pdf']) {
  const f=fixture();await f.ctx.showFileViewer('/Users/test/文書',kind,{isConnected:true,focus(){}});
  const viewer=f.doc.body.children.at(-1),frame=viewer.querySelector('.fv-body').children[0],first=f.history.state.fviewer;
  frame.handlers.load();assert.equal(f.history.state.fviewer,first);
  frame.handlers.load();assert.notEqual(f.history.state.fviewer,first);
  f.history.back();assert.equal(viewer.isConnected,false);assert.equal(f.history.state.fviewer,undefined);
  const state=f.history.state;frame.handlers.load();assert.equal(f.history.state,state);
  assert.equal(f.el('#conversation').inert,false);
 }
});
test('閉じた履歴を再利用し、即時の開き直しでも履歴と元の状態を保持する',async()=>{
 for(const initial of [null,{original:true}]) {
  const f=fixture();f.history.state=initial;
  let pushes=0;const push=f.history.pushState.bind(f.history);f.history.pushState=s=>{pushes++;push(s);};
  for(let i=0;i<20;i++) {
   await f.ctx.showFileViewer('/Users/test/文書.docx','doc',{isConnected:true,focus(){}});
   const viewer=f.doc.body.children.at(-1);assert.equal(viewer.isConnected,true);
   f.ctx.closeFileViewer();assert.equal(viewer.isConnected,false);assert.equal(f.history.state.fviewer,undefined);
   assert.equal(f.history.state.fviewerClosed.state,initial);
  }
  assert.equal(pushes,1);assert.equal(f.el('#conversation').inert,false);
 }
});
