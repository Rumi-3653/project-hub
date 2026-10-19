'use strict';
// Real browser regression with an isolated server and an executable AI stub only.
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process');
let chromium;try{({chromium}=require('playwright-core'));}catch{try{({chromium}=require(path.join(os.homedir(),'.local/lib/node_modules/openclaw/node_modules/playwright-core')));}catch{}}
const chrome=process.env.HUB_TEST_CHROME || [path.join(os.homedir(),'.local/bin/chrome-headless-arm64'),'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p=>fs.existsSync(p));
if(!chromium || !chrome)test('freetalk実ブラウザ回帰（Playwright/Chromeがある環境で実行）',{skip:true},()=>{});
else {
 const {Store}=require('../lib/store'),chat=require('../lib/chat');
 let tmp,root,home,bin,store,port,base,child,browser,page,topic,logs='';
 const pause=ms=>new Promise(r=>setTimeout(r,ms));
 const post=async(route,body={})=>{const r=await fetch(base+route,{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json'},body:JSON.stringify(body)});const data=await r.json();assert.equal(r.status,200,JSON.stringify(data));return data;};
 const status=async()=>await(await fetch(base+'/api/freetalk/status?project=freetalk&task='+topic.id)).json();
 async function start(){
  child=spawn(process.execPath,[path.join(__dirname,'../server.js')],{env:{...process.env,HUB_ROOT:root,HUB_FREETALK_HOME:home,HOME:home,HUB_DRY_RUN:'1',HUB_SKIP_NPM:'1',HUB_LANG:'ja',HUB_PORT:String(port),PATH:bin+path.delimiter+process.env.PATH},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
  for(let i=0;i<200;i++){if(child.exitCode!==null)throw Error(logs);try{if((await fetch(base+'/api/version')).ok)return;}catch{}await pause(30);}throw Error('isolated server did not start: '+logs);
 }
 async function stop(){if(!child || child.exitCode!==null)return;const done=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await done;}
 async function ready(){await page.waitForSelector('[data-promotion-field="name"]',{timeout:15000});await page.waitForSelector('[data-act="freetalkcreate"]:enabled');}
 // Exercise the retained manual API/action for its existing compatibility regressions.
 // The new one-click tests below click the unmodified production button.
 async function promote(){await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/freetalk/summary') && r.status()===200),page.locator('[data-act="freetalkautopromote"]:enabled').evaluate(el=>act({dataset:{...el.dataset,act:'freetalkpromote'},disabled:false}))]);}
 test.before(async()=>{
  tmp=fs.mkdtempSync(path.join(os.tmpdir(),'hub-ft-promotion-browser-'));root=path.join(tmp,'root');home=path.join(tmp,'home');bin=path.join(tmp,'bin');fs.mkdirSync(bin);fs.mkdirSync(home);fs.mkdirSync(path.join(root,'_hub'),{recursive:true});
  fs.copyFileSync(path.join(__dirname,'../../docs/project-hub/templates/_hub/roles.yaml'),path.join(root,'_hub/roles.yaml'));
  fs.writeFileSync(path.join(root,'_hub/onboarding.json'),JSON.stringify({version:1,status:'done',step:'first',ais:['codex']}));
  fs.writeFileSync(path.join(bin,'codex'),`#!${process.execPath}\nif(process.argv.includes('--version')){console.log('codex fake');process.exit(0)}\nlet input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{const out=o=>console.log(JSON.stringify(o));out({type:'thread.started',thread_id:'fake-'+process.pid});setTimeout(()=>{out({type:'item.completed',item:{type:'agent_message',text:'仮データの引き継ぎ要約。次に計画を確認します。'}});out({type:'turn.completed'});},850);});`,{mode:0o755});
  const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));port=probe.address().port;await new Promise(r=>probe.close(r));base='http://127.0.0.1:'+port;store=new Store(root);await start();
  browser=await chromium.launch({executablePath:chrome,headless:true});
 });
 test.beforeEach(async()=>{
  page=await browser.newPage({viewport:{width:1300,height:950}});await post('/api/freetalk/ensure');topic=await post('/api/freetalk/topic');
  const p=store.readProject('freetalk');chat.append(p.dir,topic.id,{role:'user',text:'仮の相談原文'});chat.append(p.dir,topic.id,{role:'assistant',ai:'codex',model:'GPT-6.1-Sol',text:'仮の最初の回答'});
  await page.addInitScript(()=>localStorage.setItem('hub-open',JSON.stringify(['g:freetalk'])));
  await page.goto(base);await page.locator('.freetalk-frame .freetalk-topic[data-t="'+topic.id+'"]').click();await page.waitForSelector('[data-act="freetalkautopromote"]:enabled');
 });
 test.afterEach(async()=>{await page?.close();});
 test.after(async()=>{await browser?.close();await stop();if(tmp)fs.rmSync(tmp,{recursive:true,force:true});});
 test('実ブラウザ：symlink/300MBがあっても非同期要約→確認→選択資料と添付・原文を保全して移行先へ',async()=>{
  const ft=path.join(home,'Documents/freetalk'),bad=path.join(ft,'other/node_modules/.bin');fs.mkdirSync(bad,{recursive:true});fs.symlinkSync('/outside',path.join(bad,'tool'));
  const big=path.join(ft,'300MB.bin');fs.closeSync(fs.openSync(big,'w'));fs.truncateSync(big,300*1024*1024);fs.writeFileSync(path.join(ft,'safe.txt'),'共通資料');
  const uploaded=await fetch(base+'/api/task/upload?'+new URLSearchParams({project:'freetalk',task:topic.id,name:'添付.txt',generation:'1'}),{method:'POST',headers:{'X-Hub':'1'},body:'添付原文'});assert.equal(uploaded.status,200);const attachment=await uploaded.json();
  await promote();await page.locator('#chat-in').focus();await ready();
  assert.match(await page.locator('.freetalk-promotion').innerText(),/other.*リンク/s);assert.match(await page.locator('.freetalk-promotion').innerText(),/300MB.bin.*大きすぎ/s);
  assert.equal(await page.locator('[data-promotion-file="other"]').isDisabled(),true);assert.equal(await page.locator('[data-promotion-file="300MB.bin"]').isChecked(),false);
  assert.equal(await page.locator('[data-promotion-file="safe.txt"]').isChecked(),false);
  await page.locator('[data-promotion-file="safe.txt"]').check();
  if(process.env.HUB_TEST_SCREENSHOT)await page.screenshot({path:process.env.HUB_TEST_SCREENSHOT,fullPage:true});
  const original=fs.readFileSync(chat.files(store.readProject('freetalk').dir,topic.id).log);await page.locator('[data-promotion-field="name"]').fill('確認した旅行');
  // Two clicks in the same event turn exercise the UI guard in addition to API replay.
  await page.locator('[data-act="freetalkcreate"]').evaluate(el=>{el.click();el.click();});
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('hub-view')).project==='確認した旅行');
  const migrated=(await status()).migrated,dest=store.readProject(migrated.project).dir;assert.deepEqual(fs.readFileSync(path.join(dest,'資料/自由対話原文.jsonl')),original);
  assert.equal(fs.readFileSync(path.join(dest,'資料/相談ファイル/safe.txt'),'utf8'),'共通資料');assert.equal(fs.readFileSync(path.join(dest,'資料/相談ファイル',path.relative(ft,attachment.path)),'utf8'),'添付原文');
  assert.ok(fs.lstatSync(path.join(bad,'tool')).isSymbolicLink());assert.equal(fs.statSync(big).size,300*1024*1024);assert.equal(store.listProjects().filter(p=>p.name==='確認した旅行').length,1);
 });
 test('実ブラウザ：要約中に再読込してもサーバーintentから確認画面を復元',async()=>{
  await promote();assert.equal((await status()).promotionRequested,true);await page.reload();await ready();assert.equal(await page.locator('[data-act="freetalkcontinue"]').count(),0);
 });
 test('実ブラウザ：別話題へ往復しても確認へ進み、Hubプロセス再起動・自動再読込後も意図と編集を復元',async()=>{
  await promote();const other=await post('/api/freetalk/topic');await page.reload();await page.locator('.freetalk-frame .freetalk-topic[data-t="'+other.id+'"]').click();await pause(1100);
  await page.locator('.freetalk-frame .freetalk-topic[data-t="'+topic.id+'"]').click();await ready();await page.locator('[data-promotion-field="name"]').fill('再起動後の編集');
  await stop();await start();await page.evaluate(()=>reloadAfterRestart());await page.waitForSelector('[data-promotion-field="name"]');
  assert.equal(await page.locator('[data-promotion-field="name"]').inputValue(),'再起動後の編集');assert.equal((await status()).promotionRequested,true);await page.waitForSelector('[data-act="freetalkcreate"]:enabled');
 });
 test('実ブラウザ：追加会話はstaleを表示、要約し直してから作成できる',async()=>{
  await promote();await ready();await post('/api/chat/send',{project:'freetalk',task:topic.id,ai:'codex',model:'GPT-6.1-Sol',text:'要約後の追加相談'});
  await page.waitForSelector('[data-act="freetalkresummary"]:enabled');assert.match(await page.locator('.freetalk-promotion [role="alert"]').first().innerText(),/会話が追加/);assert.equal((await status()).stale,true);
  await page.locator('[data-act="freetalkresummary"]').click();await ready();assert.equal((await status()).stale,false);
 });
 test('実ブラウザ：preview失敗は理由と再確認、同名の作成失敗も編集を保持して再開',async()=>{
  let reject=true;await page.route('**/api/freetalk/project-preview',route=>reject?route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'試験のpreview失敗'})}):route.continue());
  await promote();await page.waitForSelector('[data-act="freetalkretry"]:enabled');assert.match(await page.locator('.freetalk-promotion').innerText(),/試験のpreview失敗/);
  reject=false;await page.locator('[data-act="freetalkretry"]').click();await ready();store.createProject({name:'同じ名前'});await page.locator('[data-promotion-field="name"]').fill('同じ名前');await page.locator('[data-act="freetalkcreate"]').click();
  await page.waitForSelector('[data-act="freetalkretry"]');assert.match(await page.locator('.freetalk-promotion').innerText(),/同じ名前/);assert.equal(await page.locator('[data-promotion-field="name"]').inputValue(),'同じ名前');
  await page.locator('[data-act="freetalkretry"]').click();await ready();await page.locator('[data-promotion-field="name"]').fill('失敗から再開');await page.locator('[data-act="freetalkcreate"]').click();
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('hub-view')).project==='失敗から再開');
 });
 test('実ブラウザ：ファイル更新のrevision競合を再確認して、取消でintent解除',async()=>{
  const selected=path.join(home,'Documents/freetalk','selected.txt');fs.writeFileSync(selected,'最初');
  await promote();await ready();await page.locator('[data-promotion-file="selected.txt"]').check();fs.writeFileSync(selected,'更新');await page.locator('[data-act="freetalkcreate"]').click();
  await page.waitForSelector('[data-act="freetalkretry"]');assert.match(await page.locator('.freetalk-promotion').innerText(),/更新されました/);
  await page.locator('[data-act="freetalkretry"]').click();await ready();assert.equal(await page.locator('[data-promotion-file="selected.txt"]').isChecked(),true);
  await page.locator('[data-act="freetalkcancel"]').click();await page.waitForSelector('[data-act="freetalkcontinue"]');assert.equal((await status()).promotionRequested,false);
 });
 test('実ブラウザ：整理して続けるは確認欄なし、人の編集要約で新会話へ、添付は保持',async()=>{
  const p=store.readProject('freetalk'),ft=path.join(home,'Documents/freetalk');fs.mkdirSync(path.join(ft,'topics',topic.id),{recursive:true});const file=path.join(ft,'topics',topic.id,'keep.txt');fs.writeFileSync(file,'残す添付');
  page.on('dialog',dialog=>dialog.accept());await page.locator('[data-act="freetalksummary"]').click();await page.waitForSelector('[data-act="freetalkcontinue"]:enabled');assert.equal(await page.locator('.freetalk-promotion').count(),0);assert.equal((await status()).promotionRequested,false);
  await page.locator('.freetalk-summary-input').fill('人の編集した継続要約');await page.locator('[data-act="freetalkcontinue"]').click();await page.waitForFunction(()=>!document.querySelector('[data-act="freetalkcontinue"]'));
  assert.equal((await status()).generation,2);assert.match(chat.read(p.dir,topic.id)[0].text,/人の編集した継続要約/);assert.equal(fs.readFileSync(file,'utf8'),'残す添付');
 });
 test('実ブラウザ：要約開始409の理由を保持、回答追加後の再確認で開始し直し取消で解除',async()=>{
  const p=store.readProject('freetalk');fs.writeFileSync(chat.files(p.dir,topic.id).log,'');
  const response=page.waitForResponse(r=>r.url().endsWith('/api/freetalk/summary') && r.status()===409);
  await page.locator('[data-act="freetalkautopromote"]:enabled').evaluate(el=>act({dataset:{...el.dataset,act:'freetalkpromote'},disabled:false}));const reply=await(await response).json();
  await page.waitForSelector('.freetalk-promotion [role="alert"]');await page.evaluate(id=>syncFreetalkHistory(proj('freetalk'),taskOf(proj('freetalk'),id)),topic.id);
  assert.match(reply.error,/返事が成功してから/);assert.ok((await page.locator('.freetalk-promotion').innerText()).includes(reply.error));assert.equal((await status()).promotionRequested,false);
  chat.append(p.dir,topic.id,{role:'assistant',ai:'codex',model:'GPT-6.1-Sol',text:'再開用の仮回答'});
  await page.locator('[data-act="freetalkretry"]').click();await ready();assert.equal((await status()).promotionRequested,true);
  await page.locator('[data-act="freetalkcancel"]').click();await page.waitForSelector('[data-act="freetalkcontinue"]');assert.equal(await page.locator('.freetalk-promotion').count(),0);assert.equal((await status()).promotionRequested,false);
 });
 test('実ブラウザ：intent保存前の拒否理由を保持し再確認でintent保存・確認画面へ',async()=>{
  await page.locator('[data-act="freetalksummary"]').click();await page.waitForSelector('[data-act="freetalkcontinue"]:enabled');let reject=true;
  await page.route('**/api/freetalk/promotion-intent',route=>reject?route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'試験のintent開始拒否'})}):route.continue());
  await page.locator('[data-act="freetalkautopromote"]:enabled').evaluate(el=>act({dataset:{...el.dataset,act:'freetalkpromote'},disabled:false}));await page.waitForSelector('.freetalk-promotion [role="alert"]');
  await page.evaluate(id=>syncFreetalkHistory(proj('freetalk'),taskOf(proj('freetalk'),id)),topic.id);assert.match(await page.locator('.freetalk-promotion').innerText(),/試験のintent開始拒否/);assert.equal((await status()).promotionRequested,false);
  reject=false;await page.locator('[data-act="freetalkretry"]').click();await ready();assert.equal((await status()).promotionRequested,true);assert.doesNotMatch(await page.locator('.freetalk-promotion').innerText(),/開始拒否/);
 });
 test('実ブラウザ：status503中は入力・直接操作でも作成せず、回復後に編集を保持して再開',async()=>{
  await promote();await ready();let reject=true,creates=0;page.on('request',r=>{if(r.url().endsWith('/api/freetalk/promote'))creates++;});
  await page.route('**/api/freetalk/status?*',route=>reject?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'試験のstatus取得失敗'})}):route.continue());
  await page.evaluate(id=>syncFreetalkHistory(proj('freetalk'),taskOf(proj('freetalk'),id)),topic.id);assert.match(await page.locator('.freetalk-history').innerText(),/試験のstatus取得失敗/);
  await page.locator('[data-promotion-field="name"]').fill('status回復後の名前');await page.locator('[data-promotion-field="summary"]').fill('status回復後の要約');
  assert.equal(await page.locator('[data-act="freetalkcreate"]').isDisabled(),true);
  await page.evaluate(id=>act({dataset:{act:'freetalkcreate',t:id},disabled:false}),topic.id);assert.equal(creates,0);assert.equal((await status()).migrated,null);
  reject=false;await page.locator('.freetalk-history > [data-act="freetalkretry"]').click();await ready();
  assert.equal(await page.locator('[data-promotion-field="name"]').inputValue(),'status回復後の名前');assert.equal(await page.locator('[data-promotion-field="summary"]').inputValue(),'status回復後の要約');assert.doesNotMatch(await page.locator('.freetalk-history').innerText(),/status取得失敗/);
 });
 for(const organized of [false,true]) {
  test('実ブラウザ：状態確認だけの連続503→200回復で要約・intentを送らない（要約'+(organized?'あり':'なし')+'）',async()=>{
   if(organized){await page.locator('[data-act="freetalksummary"]').click();await page.waitForSelector('[data-act="freetalkcontinue"]:enabled');}
   let reject=true;const starts=[];page.on('request',r=>{if(r.method()==='POST' && /\/api\/freetalk\/(summary|promotion-intent)$/.test(r.url()))starts.push(r.url());});
   await page.route('**/api/freetalk/status?*',route=>reject?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'状態確認503'})}):route.continue());
   await page.evaluate(id=>syncFreetalkHistory(proj('freetalk'),taskOf(proj('freetalk'),id)),topic.id);
   for(let i=0;i<2;i++) {
    await Promise.all([page.waitForResponse(r=>r.url().includes('/api/freetalk/status?') && r.status()===503),page.locator('.freetalk-history > [data-act="freetalkretry"]').click()]);
    await page.waitForSelector('.freetalk-history > [data-act="freetalkretry"]:enabled');
    assert.equal(await page.locator('.freetalk-promotion').count(),0);assert.match(await page.locator('.freetalk-history').innerText(),/状態確認503/);
   }
   reject=false;
   await page.locator('.freetalk-history > [data-act="freetalkretry"]').click();
   await page.waitForFunction(()=>!document.querySelector('.freetalk-history > [data-act="freetalkretry"]'));
   assert.deepEqual(starts,[]);assert.equal((await status()).promotionRequested,false);assert.equal(await page.locator('.freetalk-promotion').count(),0);
   assert.equal(await page.locator('[data-act="freetalkcontinue"]').count(),organized?1:0);
  });
  test('実ブラウザ：明示開始の最初のstatus503を保持、回復後に開始・取消（要約'+(organized?'あり':'なし')+'）',async()=>{
   if(organized){await page.locator('[data-act="freetalksummary"]').click();await page.waitForSelector('[data-act="freetalkcontinue"]:enabled');}
   const starts=[];page.on('request',r=>{if(r.method()==='POST' && /\/api\/freetalk\/(summary|promotion-intent)$/.test(r.url()))starts.push(r.url().split('/').at(-1));});
   await page.route('**/api/freetalk/status?*',async route=>await page.evaluate(()=>window.freetalkTestRejectStatus)?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'明示開始前503'})}):route.continue());
   // Arm failure with the click so a background poll cannot disable the button first.
   await page.locator('[data-act="freetalkautopromote"]:enabled').evaluate(el=>{window.freetalkTestRejectStatus=true;return act({dataset:{...el.dataset,act:'freetalkpromote'},disabled:false});});await page.waitForSelector('.freetalk-promotion [role="alert"]');
   await page.locator('.freetalk-promotion [data-act="freetalkretry"]').click();await page.waitForSelector('.freetalk-promotion [data-act="freetalkretry"]:enabled');
   assert.match(await page.locator('.freetalk-promotion').innerText(),/明示開始前503/);assert.deepEqual(starts,[]);assert.equal((await status()).promotionRequested,false);
   await page.evaluate(()=>window.freetalkTestRejectStatus=false);await page.locator('.freetalk-promotion [data-act="freetalkretry"]').click();await ready();
   assert.deepEqual(starts,[organized?'promotion-intent':'summary']);assert.equal((await status()).promotionRequested,true);assert.doesNotMatch(await page.locator('.freetalk-promotion').innerText(),/明示開始前503/);
   await page.locator('[data-act="freetalkcancel"]').click();await page.waitForSelector('[data-act="freetalkcontinue"]',{state:'attached'});assert.equal((await status()).promotionRequested,false);assert.equal(await page.locator('.freetalk-promotion').count(),0);
  });
 }
 for(const stage of ['summary','promotion-intent']) for(const outcome of ['reject','resolve']) {
  test('実ブラウザ：'+stage+'再試行→取消→旧'+outcome+'で確認・開始意図は復活しない',async()=>{
   if(stage==='promotion-intent'){await page.locator('[data-act="freetalksummary"]').click();await page.waitForSelector('[data-act="freetalkcontinue"]:enabled');}
   let calls=0,finish;let held;const waiting=new Promise(resolve=>held=resolve);
   await page.route('**/api/freetalk/'+stage,async route=>{
    if(route.request().postDataJSON().requested===false)return route.continue();
    calls++;if(calls===1)return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'最初の開始拒否'})});
    // Apply a successful request before holding its response: cancellation must win
    // over the old response, not over an unprocessed server mutation.
    const response=outcome==='resolve'?await route.fetch():null;
    await new Promise(resolve=>{finish=resolve;held();});
    return response?route.fulfill({response}):route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'取消後の旧開始拒否'})});
   });
   await page.locator('[data-act="freetalkautopromote"]:enabled').evaluate(el=>act({dataset:{...el.dataset,act:'freetalkpromote'},disabled:false}));await page.waitForSelector('.freetalk-promotion [role="alert"]');
   const retry=page.locator('.freetalk-promotion [data-act="freetalkretry"]').evaluate(el=>act(el));await waiting;
   if(outcome==='resolve'){for(let i=0;(await status()).reason && i<200;i++)await pause(30);assert.equal((await status()).reason,'');}
   const original=fs.readFileSync(chat.files(store.readProject('freetalk').dir,topic.id).log);
   await page.locator('[data-act="freetalkcancel"]:enabled').click();await page.waitForSelector('.freetalk-promotion',{state:'detached'});assert.equal((await status()).promotionRequested,false);
   finish();await retry;
   let rejectStatus=true;const starts=[];page.on('request',r=>{if(r.method()==='POST' && /\/api\/freetalk\/(summary|promotion-intent)$/.test(r.url()))starts.push(r.url());});
   await page.route('**/api/freetalk/status?*',route=>rejectStatus?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'取消後の状態503'})}):route.continue());
   await page.evaluate(id=>syncFreetalkHistory(proj('freetalk'),taskOf(proj('freetalk'),id)),topic.id);
   await page.locator('.freetalk-history > [data-act="freetalkretry"]').evaluate(el=>act(el));rejectStatus=false;
   await page.locator('.freetalk-history > [data-act="freetalkretry"]').evaluate(el=>act(el));
   assert.deepEqual(starts,[]);assert.equal(calls,2);assert.equal(await page.locator('.freetalk-promotion').count(),0);
   assert.equal(await page.evaluate(id=>freetalkPromotionErrors.has(id)||freetalkPromotionDrafts.has(id),topic.id),false);
   assert.equal((await status()).promotionRequested,false);assert.equal((await status()).migrated,null);assert.deepEqual(fs.readFileSync(chat.files(store.readProject('freetalk').dir,topic.id).log),original);
  });
 }
 for(const outcome of ['reject','resolve']) test('実ブラウザ：同期previewの旧'+outcome+'は取消後の欄を復活させない',async()=>{
  await page.locator('[data-act="freetalksummary"]').click();await page.waitForSelector('[data-act="freetalkcontinue"]:enabled');
  let finish,held;const waiting=new Promise(resolve=>held=resolve);
  await page.route('**/api/freetalk/project-preview',async route=>{
   const response=outcome==='resolve'?await route.fetch():null;
   await new Promise(resolve=>{finish=resolve;held();});
   return response?route.fulfill({response}):route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'旧preview拒否'})});
  });
  await post('/api/freetalk/promotion-intent',{project:'freetalk',task:topic.id,requested:true});
  // Hold the background sync itself rather than only the button's start path.
  const syncing=page.evaluate(id=>syncFreetalkHistory(proj('freetalk'),taskOf(proj('freetalk'),id)),topic.id);await waiting;
  await page.evaluate(id=>act({dataset:{act:'freetalkcancel',t:id},disabled:false}),topic.id);
  finish();await syncing;
  assert.equal((await status()).promotionRequested,false);assert.equal(await page.locator('.freetalk-promotion').count(),0);
  assert.equal(await page.evaluate(id=>freetalkPromotionDrafts.has(id)||freetalkPromotionErrors.has(id),topic.id),false);
 });
 test('実ブラウザ：古い開始拒否は新しい開始と人の編集を上書きしない',async()=>{
  await page.locator('[data-act="freetalksummary"]').click();await page.waitForSelector('[data-act="freetalkcontinue"]:enabled');
  let calls=0,finish,held;const waiting=new Promise(resolve=>held=resolve);
  await page.route('**/api/freetalk/promotion-intent',async route=>{
   calls++;if(calls===1)return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'最初の拒否'})});
   if(calls!==2)return route.continue();await new Promise(resolve=>{finish=resolve;held();});
   return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'古い拒否'})});
  });
  await page.locator('[data-act="freetalkautopromote"]:enabled').evaluate(el=>act({dataset:{...el.dataset,act:'freetalkpromote'},disabled:false}));await page.waitForSelector('.freetalk-promotion [role="alert"]');
  const old=page.locator('.freetalk-promotion [data-act="freetalkretry"]').evaluate(el=>act(el));await waiting;
  await page.locator('[data-act="freetalkautopromote"]:enabled').evaluate(el=>act({dataset:{...el.dataset,act:'freetalkpromote'},disabled:false}));await ready();await page.locator('[data-promotion-field="name"]').fill('新しい開始の編集');
  finish();await old;
  assert.equal(await page.locator('[data-promotion-field="name"]').inputValue(),'新しい開始の編集');assert.equal((await status()).promotionRequested,true);
  assert.doesNotMatch(await page.locator('.freetalk-promotion').innerText(),/古い拒否/);assert.equal(calls,3);
 });
 test('実ブラウザ：取消の遅い成功は新しい開始の確認と編集を消さない',async()=>{
  await promote();await ready();let finish,held;const waiting=new Promise(resolve=>held=resolve);
  await page.route('**/api/freetalk/promotion-intent',async route=>{
   if(route.request().postDataJSON().requested!==false)return route.continue();
   const response=await route.fetch();await new Promise(resolve=>{finish=resolve;held();});return route.fulfill({response});
  });
  const cancel=page.locator('[data-act="freetalkcancel"]').evaluate(el=>act(el));await waiting;
  await page.locator('[data-act="freetalkautopromote"]:enabled').evaluate(el=>act({dataset:{...el.dataset,act:'freetalkpromote'},disabled:false}));await ready();await page.locator('[data-promotion-field="name"]').fill('取消後の新しい開始');
  finish();await cancel;assert.equal((await status()).promotionRequested,true);assert.equal(await page.locator('[data-promotion-field="name"]').inputValue(),'取消後の新しい開始');
 });
 test('実ブラウザ：取消保存の拒否理由を表示、編集を保持して再確認・取消へ復旧',async()=>{
  await promote();await ready();await page.locator('[data-promotion-field="name"]').fill('取消失敗でも残す編集');let reject=true;
  chat.append(store.readProject('freetalk').dir,topic.id,{role:'user',text:'要約後の仮の追加相談'});
  await page.route('**/api/freetalk/promotion-intent',route=>reject && route.request().postDataJSON().requested===false?route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'取消保存拒否'})}):route.continue());
  await page.locator('[data-act="freetalkcancel"]').click();await page.waitForSelector('.freetalk-promotion [role="alert"]');
  assert.match(await page.locator('.freetalk-promotion').innerText(),/取消保存拒否/);assert.equal((await status()).promotionRequested,true);assert.equal(await page.locator('[data-promotion-field="name"]').inputValue(),'取消失敗でも残す編集');
  await page.locator('.freetalk-promotion [data-act="freetalkretry"]').evaluate(el=>act(el));assert.match(await page.locator('.freetalk-promotion').innerText(),/取消保存拒否/);assert.equal(await page.locator('[data-promotion-field="name"]').inputValue(),'取消失敗でも残す編集');
  reject=false;await page.locator('.freetalk-promotion [data-act="freetalkretry"]').click();await page.waitForSelector('.freetalk-promotion',{state:'detached'});assert.equal((await status()).promotionRequested,false);assert.equal((await status()).migrated,null);
 });
 test('実ブラウザ：開始前の取消保存拒否を再確認しても開始しない',async()=>{
  let reject=true;const starts=[];
  await page.route('**/api/freetalk/summary',route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'開始拒否'})}));
  await page.locator('[data-act="freetalkautopromote"]:enabled').evaluate(el=>act({dataset:{...el.dataset,act:'freetalkpromote'},disabled:false}));await page.waitForSelector('.freetalk-promotion [role="alert"]');
  page.on('request',r=>{if(r.method()==='POST' && /\/api\/freetalk\/(summary|promotion-intent)$/.test(r.url()))starts.push([r.url().split('/').at(-1),r.postDataJSON()]);});
  await page.route('**/api/freetalk/promotion-intent',route=>reject?route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'開始前の取消保存拒否'})}):route.continue());
  await page.locator('[data-act="freetalkcancel"]').evaluate(el=>act(el));await page.locator('.freetalk-promotion [data-act="freetalkretry"]').evaluate(el=>act(el));
  assert.match(await page.locator('.freetalk-promotion').innerText(),/開始前の取消保存拒否/);reject=false;
  await page.locator('.freetalk-promotion [data-act="freetalkretry"]').evaluate(el=>act(el));
  assert.equal(starts.length,3);assert.ok(starts.every(([stage,body])=>stage==='promotion-intent' && body.requested===false));assert.equal((await status()).promotionRequested,false);assert.equal(await page.locator('.freetalk-promotion').count(),0);
 });

 for(const stage of ['summary','promotion-intent']) for(const outcome of ['reject','resolve']) test('実ブラウザ：通常整理へ切替後の旧'+stage+outcome+'はプロジェクト化を戻さない',async()=>{
  if(stage==='promotion-intent'){await page.locator('[data-act="freetalksummary"]').click();await page.waitForSelector('[data-act="freetalkcontinue"]:enabled');}
  let calls=0,finish,held;const waiting=new Promise(resolve=>held=resolve);
  await page.route('**/api/freetalk/'+stage,async route=>{
   const body=route.request().postDataJSON();if(stage==='summary' && body.intent!=='promote')return route.continue();
   calls++;if(calls===1)return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'最初の開始拒否'})});
   const response=outcome==='resolve'?await route.fetch():null;
   await new Promise(resolve=>{finish=resolve;held();});
   return response?route.fulfill({response}):route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'通常整理後の旧開始拒否'})});
  });
  await page.locator('[data-act="freetalkautopromote"]:enabled').evaluate(el=>act({dataset:{...el.dataset,act:'freetalkpromote'},disabled:false}));await page.waitForSelector('.freetalk-promotion [role="alert"]');
  const old=page.locator('.freetalk-promotion [data-act="freetalkretry"]').evaluate(el=>act(el));await waiting;
  for(let i=0;(await status()).reason && i<200;i++)await pause(30);assert.equal((await status()).reason,'');
  await page.evaluate(id=>syncFreetalkHistory(proj('freetalk'),taskOf(proj('freetalk'),id)),topic.id);
  const before=(await status()).summaryId;
  await page.locator('[data-act="freetalksummary"]:enabled').click();
  for(let i=0;i<200;i++){const h=await status();if(h.summaryId!==before && h.draft && !h.reason && !h.promotionRequested)break;await pause(30);}
  await page.evaluate(id=>syncFreetalkHistory(proj('freetalk'),taskOf(proj('freetalk'),id)),topic.id);await page.waitForSelector('[data-act="freetalkcontinue"]:enabled');
  const original=fs.readFileSync(chat.files(store.readProject('freetalk').dir,topic.id).log);
  finish();await old;
  assert.equal(calls,2);assert.equal((await status()).promotionRequested,false);assert.equal(await page.locator('.freetalk-promotion').count(),0);
  assert.equal(await page.evaluate(id=>freetalkPromotionErrors.has(id)||freetalkPromotionDrafts.has(id),topic.id),false);assert.deepEqual(fs.readFileSync(chat.files(store.readProject('freetalk').dir,topic.id).log),original);assert.equal((await status()).migrated,null);
 });
 for(const outcome of ['reject','resolve']) test('実ブラウザ：通常整理の古い'+outcome+'は新しいプロジェクト化と編集を消さない',async()=>{
  let finish,held;const waiting=new Promise(resolve=>held=resolve);
  await page.route('**/api/freetalk/summary',async route=>{
   if(route.request().postDataJSON().intent==='promote')return route.continue();
   // A successful normal summary is applied before only its response is held.
   const response=outcome==='resolve'?await route.fetch():null;
   await new Promise(resolve=>{finish=resolve;held();});
   return response?route.fulfill({response}):route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'古い通常整理の拒否'})});
  });
  const old=page.locator('[data-act="freetalksummary"]').evaluate(el=>act(el));await waiting;
  for(let i=0;(await status()).reason && i<200;i++)await pause(30);assert.equal((await status()).reason,'');
  await page.evaluate(id=>syncFreetalkHistory(proj('freetalk'),taskOf(proj('freetalk'),id)),topic.id);
  await page.locator('[data-act="freetalkautopromote"]:enabled').evaluate(el=>act({dataset:{...el.dataset,act:'freetalkpromote'},disabled:false}));await ready();
  await page.locator('[data-promotion-field="name"]').fill('新しい開始の編集');await page.locator('[data-promotion-field="summary"]').fill('人の新しい引き継ぎ要約');
  finish();await old;
  assert.equal((await status()).promotionRequested,true);assert.equal(await page.locator('[data-promotion-field="name"]').inputValue(),'新しい開始の編集');assert.equal(await page.locator('[data-promotion-field="summary"]').inputValue(),'人の新しい引き継ぎ要約');assert.doesNotMatch(await page.locator('#toast').textContent(),/古い通常整理の拒否|要約を頼みました/);
 });
 test('実ブラウザ：現在の通常整理409は可視理由と再操作を保つ',async()=>{
  let reject=true;await page.route('**/api/freetalk/summary',route=>reject?route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'通常整理の開始拒否'})}):route.continue());
  await page.locator('[data-act="freetalksummary"]:enabled').click();await page.waitForFunction(()=>document.querySelector('#toast')?.textContent==='通常整理の開始拒否');
  assert.equal(await page.locator('.freetalk-promotion').count(),0);reject=false;
  await page.locator('[data-act="freetalksummary"]:enabled').click();await page.waitForSelector('[data-act="freetalkcontinue"]:enabled');assert.equal((await status()).promotionRequested,false);
 });
 for(const outcome of ['reject','resolve']) test('実ブラウザ：背景previewの旧'+outcome+'を通常整理後に反映しない',async()=>{
  await page.locator('[data-act="freetalksummary"]').click();await page.waitForSelector('[data-act="freetalkcontinue"]:enabled');
  let finish,held;const waiting=new Promise(resolve=>held=resolve);
  await page.route('**/api/freetalk/project-preview',async route=>{const response=outcome==='resolve'?await route.fetch():null;await new Promise(resolve=>{finish=resolve;held();});return response?route.fulfill({response}):route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'通常整理前の旧preview拒否'})});});
  await post('/api/freetalk/promotion-intent',{project:'freetalk',task:topic.id,requested:true});
  const old=page.evaluate(id=>syncFreetalkHistory(proj('freetalk'),taskOf(proj('freetalk'),id)),topic.id);await waiting;
  const before=(await status()).summaryId;await page.locator('[data-act="freetalksummary"]:enabled').click();
  for(let i=0;i<200;i++){const h=await status();if(h.summaryId!==before && h.draft && !h.reason && !h.promotionRequested)break;await pause(30);}
  await page.evaluate(id=>syncFreetalkHistory(proj('freetalk'),taskOf(proj('freetalk'),id)),topic.id);await page.waitForSelector('[data-act="freetalkcontinue"]:enabled');finish();await old;
  assert.equal((await status()).promotionRequested,false);assert.equal(await page.locator('.freetalk-promotion').count(),0);assert.equal(await page.evaluate(id=>freetalkPromotionErrors.has(id)||freetalkPromotionDrafts.has(id),topic.id),false);
 });
 for(const action of ['freetalkclear','freetalkcontinue','freetalkdelete','freetalkclean']) test('実ブラウザ：'+action+'成功後の遅い開始拒否を反映しない',async()=>{
  page.on('dialog',dialog=>dialog.accept());
  if(action==='freetalkcontinue'){await page.locator('[data-act="freetalksummary"]').click();await page.waitForSelector('[data-act="freetalkcontinue"]:enabled');}
  const stage=action==='freetalkcontinue'?'promotion-intent':'summary';let calls=0,finish,held;const waiting=new Promise(resolve=>held=resolve);
  await page.route('**/api/freetalk/'+stage,async route=>{calls++;if(calls===1)return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'最初の開始拒否'})});await new Promise(resolve=>{finish=resolve;held();});return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'解除後の旧開始拒否'})});});
  await page.locator('[data-act="freetalkautopromote"]:enabled').evaluate(el=>act({dataset:{...el.dataset,act:'freetalkpromote'},disabled:false}));await page.waitForSelector('.freetalk-promotion [role="alert"]');
  const old=page.locator('.freetalk-promotion [data-act="freetalkretry"]').evaluate(el=>act(el));await waiting;
  if(action==='freetalkcontinue')await page.locator('.freetalk-summary-input').fill('人が確認した続行要約');
  const route=action==='freetalkclear'||action==='freetalkcontinue'?'rotate':action==='freetalkdelete'?'delete':'clean';
  await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/freetalk/'+route) && r.status()===200),page.locator('[data-act="'+action+'"]'+(action==='freetalkdelete'?'[data-t="'+topic.id+'"]':'')+':enabled').first().click()]);
  await page.waitForSelector('.freetalk-promotion',{state:'detached'});finish();await old;
  assert.equal(calls,2);assert.equal(await page.evaluate(id=>freetalkPromotionErrors.has(id)||freetalkPromotionDrafts.has(id),topic.id),false);assert.equal(await page.locator('.freetalk-promotion').count(),0);
  if(action==='freetalkclear'||action==='freetalkcontinue'){assert.equal((await status()).promotionRequested,false);assert.equal((await status()).generation,2);}
 });
 test('実ブラウザ：遅い掃除成功は新しい話題の確認と編集を消さない',async()=>{
  page.on('dialog',dialog=>dialog.accept());let finish,held;const waiting=new Promise(resolve=>held=resolve);
  await page.route('**/api/freetalk/clean',async route=>{const response=await route.fetch();await new Promise(resolve=>{finish=resolve;held();});return route.fulfill({response});});
  const old=page.locator('[data-act="freetalkclean"]:enabled').evaluate(el=>act(el));await waiting;
  topic=await post('/api/freetalk/topic');const p=store.readProject('freetalk');chat.append(p.dir,topic.id,{role:'user',text:'掃除後の新しい相談'});chat.append(p.dir,topic.id,{role:'assistant',ai:'codex',model:'GPT-6.1-Sol',text:'新しい回答'});
  await page.evaluate(()=>load());await page.locator('.freetalk-frame .freetalk-topic[data-t="'+topic.id+'"]').click();await promote();await ready();await page.locator('[data-promotion-field="name"]').fill('掃除後の新しい編集');
  finish();await old;
  assert.equal((await status()).promotionRequested,true);assert.equal(await page.locator('[data-promotion-field="name"]').inputValue(),'掃除後の新しい編集');assert.equal(await page.evaluate(()=>view.task),topic.id);
 });
 test('実ブラウザ：手動reloadで名前・編集要約・選択を復元し、新しい共通資料は自動選択しない',async()=>{
  const ft=path.join(home,'Documents/freetalk');fs.writeFileSync(path.join(ft,'manual.txt'),'手動で選ぶ');
  await promote();await ready();assert.equal(await page.locator('[data-promotion-file="manual.txt"]').isChecked(),false);
  await page.locator('[data-promotion-field="name"]').fill('手動reloadの名前');await page.locator('[data-promotion-field="summary"]').fill('人の編集要約');await page.locator('[data-promotion-file="manual.txt"]').check();
  await page.reload();await ready();assert.equal(await page.locator('[data-promotion-field="name"]').inputValue(),'手動reloadの名前');assert.equal(await page.locator('[data-promotion-field="summary"]').inputValue(),'人の編集要約');assert.equal(await page.locator('[data-promotion-file="manual.txt"]').isChecked(),true);
  fs.writeFileSync(path.join(ft,'new-shared.txt'),'新しい別資料');
  await page.evaluate(id=>act({dataset:{act:'freetalkretry',t:id},disabled:false}),topic.id);await ready();assert.equal(await page.locator('[data-promotion-file="new-shared.txt"]').isChecked(),false);assert.equal(await page.locator('[data-promotion-field="summary"]').inputValue(),'人の編集要約');
 });
 test('実ブラウザ：再要約で名前と選択を保ち、以前の編集内容も確認できる',async()=>{
  await promote();await ready();await page.locator('[data-promotion-field="name"]').fill('再要約後も残す名前');await page.locator('[data-promotion-field="summary"]').fill('捨てない人の編集');
  await page.locator('[data-promotion-field="name"]').evaluate(el=>{el.focus();el.setSelectionRange(2,4);});
  chat.append(store.readProject('freetalk').dir,topic.id,{role:'user',text:'追加の仮相談'});
  await page.evaluate(id=>syncFreetalkHistory(proj('freetalk'),taskOf(proj('freetalk'),id)),topic.id);
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.promotionField),'name');assert.equal(await page.locator('[data-promotion-field="name"]').evaluate(el=>el.selectionStart),2);
  await page.locator('[data-act="freetalkresummary"]').click();await ready();
  assert.equal(await page.locator('[data-promotion-field="name"]').inputValue(),'再要約後も残す名前');assert.equal(await page.locator('[data-promotion-field="summary"]').inputValue(),'仮データの引き継ぎ要約。次に計画を確認します。');
  assert.match(await page.locator('.freetalk-promotion').textContent(),/捨てない人の編集/);
 });
 test('実ブラウザ：作成成功の応答消失後もstatusの移行先を確認し、再作成しない',async()=>{
  await promote();await ready();await page.locator('[data-promotion-field="name"]').fill('応答消失のプロジェクト');let calls=0;
  await page.route('**/api/freetalk/promote',async route=>{calls++;await route.fetch();await route.abort('failed');});
  await page.locator('[data-act="freetalkcreate"]').click();await page.waitForSelector('[data-go="work"][data-p="応答消失のプロジェクト"]');
  await page.reload();await page.waitForSelector('[data-go="work"][data-p="応答消失のプロジェクト"]');assert.equal(calls,1);assert.equal((await status()).migrated.project,'応答消失のプロジェクト');
 });

 async function migrated(){for(let i=0;i<200;i++){const h=await status();if(h.automaticCompleted)return h.migrated;assert.equal(h.automaticError,'',JSON.stringify(h));await pause(50);}throw Error('automatic promotion did not complete: '+JSON.stringify(await status()));}
 test('実ブラウザ：ワンクリックでスマホから確認なしに作成・移行、二重クリックも1件',async()=>{
  await page.setViewportSize({width:390,height:844});
  const ft=path.join(home,'Documents/freetalk'),attachment=path.join(ft,'topics',topic.id,'one-click.txt');fs.mkdirSync(path.dirname(attachment),{recursive:true});fs.writeFileSync(attachment,'ワンクリック添付');
  fs.writeFileSync(path.join(ft,'unrelated-one-click.txt'),'元に残す');
  let starts=0,dialogs=0;page.on('request',r=>{if(r.url().endsWith('/api/freetalk/project-start'))starts++;});page.on('dialog',d=>{dialogs++;d.dismiss();});
  await page.locator('#mobile-info').click();
  await page.locator('[data-act="freetalkautopromote"]:enabled').click({clickCount:2});
  const r=await migrated();await page.waitForFunction(project=>JSON.parse(localStorage.getItem('hub-view')).project===project,r.project);
  assert.equal(starts,1);assert.equal(dialogs,0);assert.equal(await page.locator('[data-act="freetalkcreate"]').count(),0);
  const dest=store.readProject(r.project).dir;assert.equal(fs.readFileSync(path.join(dest,'資料/相談ファイル',path.relative(ft,attachment)),'utf8'),'ワンクリック添付');assert.equal(fs.readFileSync(path.join(ft,'unrelated-one-click.txt'),'utf8'),'元に残す');
  const saved=fs.readFileSync(path.join(dest,'資料/自由対話原文.jsonl'),'utf8').trim().split('\n').map(s=>JSON.parse(s));assert.equal(saved.filter(row=>row.role==='user' && /\[freetalk-summary:/.test(row.text)).length,1);
  assert.equal(store.taskFile('freetalk',topic.id),null);assert.equal(fs.existsSync(path.join(ft,'topics',topic.id)),false);assert.equal(fs.existsSync(chat.files(store.readProject('freetalk').dir,topic.id).log),false);
  const repeated=await post('/api/freetalk/project-start',{project:'freetalk',task:topic.id});assert.equal(repeated.project,r.project);assert.equal(repeated.repeated,true);
  if(process.env.HUB_TEST_AUTOMATIC_SCREENSHOT)await page.screenshot({path:process.env.HUB_TEST_AUTOMATIC_SCREENSHOT,fullPage:true});
 });
 test('実ブラウザ：ワンクリック後に画面を閉じてもサーバーで作成完了',async()=>{
  await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/freetalk/project-start') && r.status()===200),page.locator('[data-act="freetalkautopromote"]:enabled').click()]);
  const source=await page.evaluate(()=>localStorage.getItem('hub-view'));await page.close();const r=await migrated();page=await browser.newPage({viewport:{width:390,height:844}});await page.addInitScript(view=>localStorage.setItem('hub-view',view),source);await page.goto(base);
  await page.waitForFunction(project=>JSON.parse(localStorage.getItem('hub-view')).project===project,r.project);
 });
 test('実ブラウザ：ワンクリック後の通常reloadで確認を挟まず完了',async()=>{
  await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/freetalk/project-start') && r.status()===200),page.locator('[data-act="freetalkautopromote"]:enabled').click()]);await page.reload();
  const r=await migrated();await page.waitForFunction(project=>JSON.parse(localStorage.getItem('hub-view')).project===project,r.project);assert.equal(await page.locator('[data-promotion-field="name"]').count(),0);
 });
 test('実ブラウザ：ワンクリックの開始後は追記と添付を拒否し、要約との競合を防ぐ',async()=>{
  await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/freetalk/project-start') && r.status()===200),page.locator('[data-act="freetalkautopromote"]:enabled').click()]);
  const r=await fetch(base+'/api/chat/send',{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json'},body:JSON.stringify({project:'freetalk',task:topic.id,ai:'codex',model:'GPT-6.1-Sol',text:'移行中の競合入力'})});assert.equal(r.status,409);assert.match((await r.json()).error,/移行中|移行済み/);
  const upload=await fetch(base+'/api/task/upload?'+new URLSearchParams({project:'freetalk',task:topic.id,name:'競合.txt',generation:'1'}),{method:'POST',headers:{'X-Hub':'1'},body:'競合の資料'});assert.equal(upload.status,409);
  const done=await migrated(),dest=store.readProject(done.project).dir;assert.doesNotMatch(fs.readFileSync(path.join(dest,'資料/自由対話原文.jsonl'),'utf8'),/移行中の競合入力/);assert.equal(fs.existsSync(path.join(home,'Documents/freetalk','topics',topic.id)),false);
 });
 test('実ブラウザ：ワンクリック開始の応答消失でも自動作成は完了、二重送信しない',async()=>{
  let calls=0;await page.route('**/api/freetalk/project-start',async route=>{calls++;await route.fetch();await route.abort();});
  await page.locator('[data-act="freetalkautopromote"]:enabled').click();const r=await migrated();await page.waitForFunction(project=>JSON.parse(localStorage.getItem('hub-view')).project===project,r.project);assert.equal(calls,1);
 });
 test('実ブラウザ：ワンクリック開始失敗はスマホに理由と再開ボタン、明示再開だけ送信',async()=>{
  let reject=true,calls=0;await page.route('**/api/freetalk/project-start',route=>{calls++;return reject?route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'試験の自動開始拒否'})}):route.continue();});
  await page.locator('[data-act="freetalkautopromote"]:enabled').click();await page.waitForSelector('.freetalk-promotion [role="alert"]');assert.match(await page.locator('.freetalk-promotion').innerText(),/試験の自動開始拒否/);await pause(1200);assert.equal(calls,1);
  reject=false;await page.locator('.freetalk-promotion [data-act="freetalkautopromote"]').click();await migrated();assert.equal(calls,2);
 });
 test('実ブラウザ：ワンクリックはPCとスマホで同一、同時に押しても1件、両画面から元話題を削除',async()=>{
  const phone=await browser.newPage({viewport:{width:390,height:844}});
  try {
   const source=await page.evaluate(()=>localStorage.getItem('hub-view'));await phone.addInitScript(view=>localStorage.setItem('hub-view',view),source);await phone.goto(base);await phone.locator('#mobile-info').click();
   // Hold both real clicks at the request boundary. Otherwise the first
   // completed migration can remove the other screen's button before Playwright
   // finishes its actionability check, without exercising the second request.
   let arrived=0,release;
   const bothRequests=new Promise(resolve=>{release=resolve;});
   const synchronize=async route=>{if(++arrived===2)release();await bothRequests;await route.continue();};
   await page.route('**/api/freetalk/project-start',synchronize);await phone.route('**/api/freetalk/project-start',synchronize);
   await Promise.all([page.locator('[data-act="freetalkautopromote"]:enabled').click(),phone.locator('[data-act="freetalkautopromote"]:enabled').click()]);
   assert.equal(arrived,2);
   const r=await migrated();await Promise.all([page.waitForFunction(project=>JSON.parse(localStorage.getItem('hub-view')).project===project,r.project),phone.waitForFunction(project=>JSON.parse(localStorage.getItem('hub-view')).project===project,r.project)]);
   await Promise.all([page.locator('.freetalk-topic[data-t="'+topic.id+'"]').waitFor({state:'detached'}),phone.locator('.freetalk-topic[data-t="'+topic.id+'"]').waitFor({state:'detached'})]);
   assert.equal(await page.locator('.freetalk-topic[data-t="'+topic.id+'"]').count(),0);assert.equal(await phone.locator('.freetalk-topic[data-t="'+topic.id+'"]').count(),0);
   const dest=store.readProject(r.project).dir,rows=fs.readFileSync(path.join(dest,'資料/自由対話原文.jsonl'),'utf8').trim().split('\n').map(s=>JSON.parse(s));assert.equal(rows.filter(row=>row.role==='user' && /\[freetalk-summary:/.test(row.text)).length,1);
   if(process.env.HUB_TEST_AUTOMATIC_SCREENSHOT)await page.screenshot({path:process.env.HUB_TEST_AUTOMATIC_SCREENSHOT.replace('mobile','desktop'),fullPage:true});
  }finally{await phone.close();}
 });
 test('実ブラウザ：ワンクリックの削除失敗は理由と再開、作成済みを重複せず削除だけ完了',async()=>{
  const file=path.join(store.readProject('freetalk').dir,'.ai/memory',topic.id+'.md');fs.mkdirSync(path.dirname(file),{recursive:true});fs.symlinkSync('/outside',file);
  await page.locator('[data-act="freetalkautopromote"]:enabled').click();await page.waitForFunction(()=>document.querySelector('.freetalk-promotion [role="alert"]')?.textContent.includes('削除を完了できません'));
  const failed=await status();assert.equal(failed.automaticCompleted,false);assert.ok(failed.migrated);assert.ok(store.taskFile('freetalk',topic.id));const stateFile=path.join(store.readProject('freetalk').dir,'.ai/freetalk',topic.id+'.json');const before=fs.readFileSync(stateFile);
  await pause(1200);assert.deepEqual(fs.readFileSync(stateFile),before);fs.unlinkSync(file);await page.locator('.freetalk-promotion [data-act="freetalkautopromote"]').click();
  const r=await migrated();assert.equal(r.operationId,failed.migrated.operationId);assert.equal(r.project,failed.migrated.project);assert.equal(store.taskFile('freetalk',topic.id),null);
  await page.waitForFunction(project=>JSON.parse(localStorage.getItem('hub-view')).project===project,r.project);
 });

}
