'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{execFileSync}=require('node:child_process');
const tmp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'hub-discussion-http-'))),root=path.join(tmp,'workspace'),bin=path.join(tmp,'bin'),calls=path.join(tmp,'calls.jsonl'),control=path.join(tmp,'control.json');
execFileSync('bash',[path.join(__dirname,'../setup.sh')],{env:{...process.env,HUB_ROOT:root,HOME:tmp,HUB_SKIP_NPM:'1'},stdio:'ignore'});fs.mkdirSync(bin);
for (const name of fs.readdirSync(path.join(root,'Product'))) {
 const dir=path.join(root,'Product',name),file=path.join(dir,'PROJECT.md');
 fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace(/^(  [^\n:]+:\s*)~\/[^\n]*$/gm,(_line,label)=>label+dir));
 for(const task of fs.readdirSync(path.join(dir,'.ai/tasks')).filter(n=>n.endsWith('.md'))) { const f=path.join(dir,'.ai/tasks',task);fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace(/^workdir:.*$/m,'workdir:')); }
}
for(const ai of ['claude','codex'])fs.writeFileSync(path.join(bin,ai),`#!${process.execPath}
const fs=require('node:fs'),ai=${JSON.stringify(ai)};let text='';process.stdin.on('data',d=>text+=d);process.stdin.on('end',()=>{const args=process.argv.slice(2),model=args[args.indexOf('--model')+1],c=JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8'));fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({ai,model,args,text})+'\\n');const out=o=>console.log(JSON.stringify(o));
if(c.delay)setTimeout(reply,c.delay);else reply();function reply(){const message=c.limit?'You have hit your usage limit':c.fail?'transport fixture error':'意見 '+model;
if(ai==='codex'){out({type:'thread.started',thread_id:'fresh'});if(c.limit||c.fail)out({type:'turn.failed',error:{message}});else{out({type:'item.completed',item:{type:'agent_message',text:message}});out({type:'turn.completed'});}}
else{out({type:'system',subtype:'init',session_id:'fresh'});if(c.limit)out({type:'result',is_error:true,result:"You've reached your session limit"});else if(c.fail)out({type:'result',is_error:true,result:message});else{out({type:'assistant',message:{content:[{type:'text',text:message}]}});out({type:'result',is_error:false,result:''});}}
if(c.hang)setInterval(()=>{},1000);
}});`,{mode:0o755});
const catalog={claude:{models:[{id:'claude-opus-5-5',label:'Opus 5.5'},{id:'claude-fable-5-1',label:'Fable 5.1'}]},codex:{models:[{id:'gpt-6.1-sol',label:'GPT-6.1-Sol'},{id:'gpt-6-astra',label:'GPT-6-Astra'}]},agy:{models:[{id:'gemini-current',label:'Current Gemini'}]}};
fs.writeFileSync(path.join(root,'_hub','ai-tools-models.json'),JSON.stringify({v:1,...catalog}));fs.writeFileSync(control,'{}');
process.env.PATH=bin+':/usr/bin:/bin';process.env.HUB_ROOT=root;process.env.HUB_AI_HOME=tmp;process.env.HUB_FREETALK_HOME=path.join(tmp,'home');process.env.HUB_DRY_RUN='1';process.env.HUB_PORT=String(46000+Math.floor(Math.random()*500));
const {server,discussion,chats}=require('../server'),chat=require('../lib/chat'),{progress}=require('../lib/discussion'),{basePrompt}=require('../lib/discussion-runtime');
const base='http://127.0.0.1:'+process.env.HUB_PORT,pdir=path.join(root,'Product','サンプルアプリ'),scope={project:'サンプルアプリ',task:'sample-app-01'},taskFile=path.join(pdir,'.ai/tasks/sample-app-01.md');let original,meta,taskCount;
const post=(url,body={},header=true)=>fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json',...(header?{'X-Hub':'1'}:{})},body:JSON.stringify({...scope,...body})});
const view=async()=>await(await fetch(base+'/api/discussion?project='+encodeURIComponent(scope.project)+'&task='+scope.task)).json();
const body={participants:[{ai:'claude',model:'claude-opus-5-5'},{ai:'codex',model:'gpt-6.1-sol'}],exchanges:1,summarizer:{ai:'claude',model:'claude-opus-5-5'},text:'この話題だけ検討'};
async function finish(target=scope){for(let i=0;i<200;i++){await new Promise(r=>setTimeout(r,30));await discussion.tick();if(!discussion.active(target.project,target.task)&&!chats.busy(target.project,target.task))return;}assert.fail('discussion did not finish');}
test.before(async()=>{await new Promise(r=>server.listen(Number(process.env.HUB_PORT),'127.0.0.1',r));discussion.authorize=async()=>{};discussion.refreshUsage=async()=>{};original=fs.readFileSync(taskFile,'utf8');taskCount=fs.readdirSync(path.join(pdir,'.ai/tasks')).filter(f=>f.endsWith('.md')).length;chat.writeMeta(pdir,scope.task,{sessions:{claude:'old',codex:'old'},models:{codex:'GPT-6.1-Sol'}});meta=fs.readFileSync(chat.files(pdir,scope.task).meta);chat.append(pdir,scope.task,{role:'assistant',ai:'codex',text:'OLD-PRIVATE-ANSWER'});});
test.afterEach(async()=>{if(require('../server').stopControl.held(scope))assert.equal((await post('/api/ai/resume',{confirm:true})).status,200);});
test.after(async()=>{chats.stopAll();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(tmp,{recursive:true,force:true});});
test('実HTTPと契約CLI代用で同じ作業内の5回を順番に実行、読取専用・新規session・独立意見・保存・名前・まとめを確認',async()=>{
 assert.equal((await post('/api/discussion/start',body,false)).status,403);
 assert.equal((await post('/api/discussion/start',body)).status,200);
 assert.notEqual(discussion.get(scope.project,scope.task).status,'failed',JSON.stringify(discussion.get(scope.project,scope.task)));
 assert.equal((await post('/api/discussion/start',body)).status,409);
 assert.equal((await post('/api/chat/send',{ai:'codex',text:'競合する送信',model:'GPT-6.1-Sol'})).status,409);
 await finish();const d=await view();assert.equal(d.session.status,'done');assert.deepEqual(d.session.progress,{total:5,completed:5,percent:100,current:null});
 const runs=fs.readFileSync(calls,'utf8').trim().split('\n').map(JSON.parse);assert.deepEqual(runs.map(r=>r.ai),['claude','codex','claude','codex','claude']);
 assert.ok(runs.every(r=>!r.args.includes('resume')&&!r.args.includes('--resume')&&!r.text.includes('OLD-PRIVATE-ANSWER')));assert.ok(runs.slice(0,2).every(r=>!r.text.includes('）の意見：')));assert.match(runs[2].text,/GPT-6.1-Sol.*各自の意見/);assert.doesNotMatch(runs[2].text,/Opus 5.5（各自の意見）/);assert.ok(runs.slice(0,4).every(r=>r.text.includes('目安800字以内')));assert.match(runs[4].text,/目安1200字以内/);assert.doesNotMatch(runs[4].text,/（各自の意見）の意見/);assert.equal((runs[4].text.match(/）の意見：/g)||[]).length,2);assert.ok(runs.filter(r=>r.ai==='codex').every(r=>r.args.includes('read-only')&&r.args.includes('features.shell_tool=false')&&r.args.includes('features.unified_exec=false')));assert.ok(runs.filter(r=>r.ai==='claude').every(r=>r.args.includes('--tools')&&r.args[r.args.indexOf('--tools')+1]===''&&r.args.includes('--safe-mode')&&r.args.includes('--no-session-persistence')));
 const rows=chat.read(pdir,scope.task).filter(r=>r.discussion);assert.equal(rows.filter(r=>r.role==='assistant').length,5);assert.equal(rows.filter(r=>r.role==='assistant'&&r.discussion.summary).length,1);assert.ok(rows.every(r=>r.discussion.name));assert.equal(fs.readFileSync(taskFile,'utf8'),original);assert.ok(fs.readFileSync(chat.files(pdir,scope.task).meta).equals(meta));assert.equal(fs.readdirSync(path.join(pdir,'.ai/tasks')).filter(f=>f.endsWith('.md')).length,taskCount);
});
test('話し合いの履歴をClaude/Codexの通常再開へ一度渡し、次の通常再開では重複させない',async()=>{
 for(const ai of ['claude','codex']) {
  const model=ai==='claude'?'Opus 5.5':'GPT-6.1-Sol';
  const send=async text=>{
   const r=await chats.send({...scope,pdir,dir:pdir,ai,model,text,basePrompt:'fixture',policy:'fixture'});
   assert.equal(r.resume,true);assert.equal(await r.started,true);
   for(let i=0;i<200&&chats.busy(scope.project,scope.task);i++)await new Promise(r=>setTimeout(r,10));
   assert.equal(chats.busy(scope.project,scope.task),null);
   return JSON.parse(fs.readFileSync(calls,'utf8').trim().split('\n').at(-1));
  };
  const first=await send('今のまとめを踏まえて進めて');
  assert.match(first.text,/話し合い・まとめ/);assert.match(first.text,/意見 claude-opus-5-5/);assert.match(first.text,/意見 gpt-6.1-sol/);
  const second=await send('通常会話を続けて');assert.doesNotMatch(second.text,/話し合い・まとめ|意見 claude-opus-5-5|意見 gpt-6.1-sol/);
 }
});
test('正式上限は別モデルへ替えず1人の意見に移り、共通役割設定を書き換えない',async()=>{
 const roles=fs.readFileSync(path.join(root,'_hub/roles.yaml'),'utf8');fs.writeFileSync(control,JSON.stringify({limit:true,hang:true}));
 const out=await post('/api/discussion/start',body);assert.equal(out.status,200);for(let i=0;i<150;i++){await new Promise(r=>setTimeout(r,20));const p=discussion.get(scope.project,scope.task);if(p.participants[0].status==='excluded')break;}
 assert.equal(discussion.get(scope.project,scope.task).participants[0].status,'excluded');fs.writeFileSync(control,'{}');await finish();const p=(await view()).session;assert.equal(p.single,true);assert.equal(p.status,'done');assert.equal(p.progress.total,2);assert.equal(p.progress.completed,2);assert.equal(p.slots.at(-1).ai,'codex');assert.equal(chats.queue(scope.project,scope.task).length,0);assert.equal(fs.readFileSync(path.join(root,'_hub/roles.yaml'),'utf8'),roles);
});
test('通常失敗の後は手動まとめが可能、二重クリックは実行数を増やさない',async()=>{
 // A session limit correctly holds both Claude models. Explicitly clear this
 // fixture evidence through the existing human endpoint before the next case.
 for(const model of ['claude-opus-5-5','claude-fable-5-1'])assert.equal((await post('/api/limits/clear',{ai:'claude',model})).status,200);
 const b={...body,participants:[{ai:'codex',model:'gpt-6.1-sol'},{ai:'claude',model:'claude-fable-5-1'}],summarizer:{ai:'claude',model:'claude-fable-5-1'}};
 fs.writeFileSync(control,JSON.stringify({delay:200}));assert.equal((await post('/api/discussion/start',b)).status,200);
 for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,15));if(progress(discussion.get(scope.project,scope.task)).completed)break;}
 fs.writeFileSync(control,JSON.stringify({fail:true}));await discussion.tick();await finish();const p=(await view()).session;assert.equal(p.status,'failed');assert.equal(p.progress.completed,1);
 fs.writeFileSync(control,'{}');const manual={id:p.id,summarizer:{ai:'codex',model:'gpt-6.1-sol'}};assert.equal((await post('/api/discussion/summary',manual)).status,200);assert.equal((await post('/api/discussion/summary',manual)).status,409);await finish();assert.equal((await view()).session.progress.percent,100);
});
test('待機・実行中を停止、cold recoveryで同じ回は再送しない',async()=>{
 fs.writeFileSync(control,JSON.stringify({delay:500}));const b={...body,participants:[{ai:'codex',model:'gpt-6.1-sol'},{ai:'claude',model:'claude-fable-5-1'}],summarizer:{ai:'codex',model:'gpt-6.1-sol'}};
 assert.equal((await post('/api/discussion/start',b)).status,200);const before=fs.readFileSync(calls,'utf8').trim().split('\n').length;assert.equal((await post('/api/chat/stop')).status,200);await finish();assert.equal((await view()).session.status,'stopped');await discussion.tick();assert.ok(fs.readFileSync(calls,'utf8').trim().split('\n').length<=before+1);
 assert.equal((await post('/api/ai/resume',{confirm:true})).status,200);
 assert.equal((await post('/api/discussion/start',b)).status,200);const {Discussion}=require('../lib/discussion');new Discussion({file:discussion.file,cancelRun:()=>chats.stop(scope.project,scope.task)}).recover();await finish();assert.equal((await view()).session.status,'stopped');assert.match((await view()).session.message,/再起動/);assert.ok((await view()).session.progress.percent<100);
});


test('ログイン確認の待機中も競合操作を拒否し、停止後の遅れた送信を実行しない',async()=>{
 fs.writeFileSync(control,'{}');let release,entered=false;
 discussion.authorize=async()=>{entered=true;await new Promise(r=>{release=r;});};
 const before=fs.readFileSync(calls,'utf8').trim().split('\n').length;
 try {
  assert.equal((await post('/api/discussion/start',body)).status,200);
  for(let i=0;i<50&&!entered;i++)await new Promise(r=>setTimeout(r,10));assert.equal(entered,true);assert.equal(Boolean(chats.busy(scope.project,scope.task)),false);
  assert.equal((await post('/api/chat/send',{ai:'codex',text:'競合',model:'GPT-6.1-Sol'})).status,409);
  assert.equal((await post('/api/delegate',{ai:'codex',model:'gpt-6.1-sol',text:'競合'})).status,409);
  assert.equal((await post('/api/task/completion',{action:'approve',confirm:true})).status,409);
  assert.equal((await post('/api/chat/stop')).status,200);release();await finish();
  assert.equal((await view()).session.status,'stopped');assert.equal(fs.readFileSync(calls,'utf8').trim().split('\n').length,before);
 }finally{discussion.stop(scope.project,scope.task);release?.();discussion.authorize=async()=>{};}
});
test('同じ最新一覧を設定・手動まとめに使い、未確認の実行方式を選べない',async()=>{
 const d=await view();assert.ok(d.candidates.some(c=>c.id==='gpt-6-astra'));assert.ok(!d.candidates.some(c=>c.id==='gemini-3.1-pro-high'));assert.ok(d.candidates.filter(c=>c.ai==='agy').every(c=>c.unavailable));
 assert.equal((await post('/api/discussion/start',{...body,participants:[body.participants[0],{ai:'agy',model:'gemini-current'}]})).status,409);
 assert.throws(()=>chat.buildTurn({ai:'agy',discussionTurn:true}),/読み取り専用/);
});

test('freetalkでも話し合いを完了・保存でき、作業管理の禁止と元の話題・設定・再開情報を保持する',async()=>{
 assert.equal((await(await post('/api/freetalk/ensure')).json()).ready,true);
 const topic=await(await post('/api/freetalk/topic')).json(),target={project:'freetalk',task:topic.id},dir=path.join(root,'Product/freetalk'),file=path.join(dir,'.ai/tasks',topic.id+'.md');
 const taskBefore=fs.readFileSync(file),projectBefore=fs.readFileSync(path.join(dir,'PROJECT.md')),rolesBefore=fs.readFileSync(path.join(root,'_hub/roles.yaml')),tasksBefore=fs.readdirSync(path.join(dir,'.ai/tasks')).sort();
 const settings=['AGENTS.md','CLAUDE.md','.ai/rules.md'].map(name=>({file:path.join(tmp,'home/Documents/freetalk',name),content:fs.readFileSync(path.join(tmp,'home/Documents/freetalk',name))}));
 chat.writeMeta(dir,topic.id,{sessions:{codex:'old-freetalk'},models:{codex:'GPT-6.1-Sol'}});const metaBefore=fs.readFileSync(chat.files(dir,topic.id).meta);
 chat.append(dir,topic.id,{role:'assistant',ai:'codex',text:'OTHER-FREETALK-PRIVATE-ANSWER'});
 const request={...target,...body,participants:[{ai:'codex',model:'gpt-6.1-sol'},{ai:'codex',model:'gpt-6-astra'}],summarizer:{ai:'codex',model:'gpt-6.1-sol'}};
 fs.writeFileSync(control,'{}');assert.equal((await post('/api/discussion/start',request,false)).status,403);
 for(const project of ['FreeTalk','FREETALK'])assert.equal((await post('/api/discussion/start',{...request,project})).status,409);
 assert.equal((await post('/api/discussion/start',request)).status,200);await finish(target);
 const result=await(await fetch(base+'/api/discussion?'+new URLSearchParams(target))).json();assert.equal(result.session.status,'done');assert.equal(result.session.progress.percent,100);assert.equal(result.session.progress.completed,5);
 const rows=chat.read(dir,topic.id).filter(r=>r.role==='assistant'&&r.discussion);assert.equal(rows.length,5);assert.equal(rows.filter(r=>r.discussion.summary).length,1);assert.ok(rows.every(r=>r.discussion.name));
 const runs=fs.readFileSync(calls,'utf8').trim().split('\n').map(JSON.parse).slice(-5);assert.ok(runs.every(r=>!r.text.includes('OTHER-FREETALK-PRIVATE-ANSWER')&&!r.args.includes('resume')));
 for(const route of ['/api/task/new','/api/task/completion','/api/task/integrate','/api/hierarchy/remove/apply']){const response=await post(route,{...target,confirm:true,state:'完了'});assert.equal(response.status,409);assert.match((await response.json()).error,/常設/);}
 assert.deepEqual(fs.readFileSync(file),taskBefore);assert.deepEqual(fs.readFileSync(path.join(dir,'PROJECT.md')),projectBefore);assert.deepEqual(fs.readFileSync(path.join(root,'_hub/roles.yaml')),rolesBefore);assert.deepEqual(fs.readdirSync(path.join(dir,'.ai/tasks')).sort(),tasksBefore);assert.deepEqual(fs.readFileSync(chat.files(dir,topic.id).meta),metaBefore);for(const setting of settings)assert.deepEqual(fs.readFileSync(setting.file),setting.content);
});
test('freetalkでまとめが失敗しても意見を残し、人が選んだAIで手動まとめを完了できる',async()=>{
 const topic=await(await post('/api/freetalk/topic')).json(),target={project:'freetalk',task:topic.id};
 const request={...body,...target,participants:[{ai:'codex',model:'gpt-6.1-sol'},{ai:'codex',model:'gpt-6-astra'}],summarizer:{ai:'claude',model:'claude-fable-5-1'}};
 const authorize=discussion.authorize;discussion.authorize=async slot=>{if(slot.ai==='claude')throw Error('まとめ役を起動できないテスト');};fs.writeFileSync(control,'{}');
 try{
  assert.equal((await post('/api/discussion/start',request)).status,200);await finish(target);
  const saved=discussion.get(target.project,target.task);assert.equal(saved.status,'failed');assert.equal(progress(saved).completed,4);assert.ok(progress(saved).percent<100);
  const manual={...target,id:saved.id,summarizer:{ai:'codex',model:'gpt-6-astra'}};
  assert.equal((await post('/api/discussion/summary',manual,false)).status,403);
  for(const project of ['FreeTalk','FREETALK'])assert.equal((await post('/api/discussion/summary',{...manual,project})).status,409);
  assert.equal((await post('/api/discussion/summary',manual)).status,200);await finish(target);
  const done=discussion.get(target.project,target.task);assert.equal(done.status,'done');assert.equal(progress(done).percent,100);assert.equal(done.slots.at(-1).manual,true);assert.equal(done.slots.at(-1).model,'gpt-6-astra');
 }finally{discussion.authorize=authorize;}
});

let chromium;try{({chromium}=require('playwright-core'));}catch{try{({chromium}=require(path.join(os.homedir(),'.local/lib/node_modules/openclaw/node_modules/playwright-core')));}catch{}}
const chrome=process.env.HUB_TEST_CHROME||[path.join(os.homedir(),'.local/bin/chrome-headless-arm64'),'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p=>fs.existsSync(p));
test('実ブラウザで設定・前回保存・進捗の自動終了・過去の意見の手動まとめ・狭い幅を確認',{skip:!chromium||!chrome},async()=>{
 const saved=discussion.read();saved.previous=null;discussion.save(saved);fs.writeFileSync(control,JSON.stringify({delay:150}));
 fs.writeFileSync(path.join(root,'_hub/onboarding.json'),JSON.stringify({version:1,status:'done',step:'first',ais:['codex']}));
 const browser=await chromium.launch({executablePath:chrome,headless:true}),page=await browser.newPage({viewport:{width:1280,height:1000}}),errors=[];page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));
 let reads=0;page.on('request',req=>{if(new URL(req.url()).pathname==='/api/discussion')reads++;});
 try{
  await page.addInitScript(s=>localStorage.setItem('hub-view',JSON.stringify({kind:'work',...s})),scope);await page.goto(base);await page.waitForSelector('#discussion-toggle',{timeout:7000});
  assert.ok((await page.locator('#discussion-toggle').boundingBox()).x<(await page.locator('#chat-send').boundingBox()).x);
  await page.locator('#chat-in').fill('ブラウザからの話題');await page.locator('#discussion-toggle').click();await page.waitForSelector('#discussion-start');
  assert.equal(await page.locator('[data-discussion-summarizer]').inputValue(),'claude|claude-fable-5-1');assert.match(await page.locator('[data-discussion-count]').innerText(),/5回/);
  const idleReads=reads;await page.waitForTimeout(1800);assert.equal(reads,idleReads,'idle settings must not poll');
  await page.locator('[data-discussion-person]').nth(0).selectOption('codex|gpt-6.1-sol');await page.locator('[data-discussion-person]').nth(1).selectOption('codex|gpt-6-astra');await page.locator('[data-discussion-rounds]').selectOption('2');await page.locator('[data-discussion-summarizer]').selectOption('codex|gpt-6.1-sol');assert.match(await page.locator('[data-discussion-count]').innerText(),/7回/);
  await page.screenshot({path:path.join(os.tmpdir(),'hub-discussion-desktop.png')});await page.setViewportSize({width:390,height:900});await page.locator('#mobile-compose').click();await page.waitForSelector('.mobile-compose-open #composer');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.waitForFunction(()=>!document.body.classList.contains('show-list')&&document.querySelector('#list').getBoundingClientRect().right<=1);await page.screenshot({path:path.join(os.tmpdir(),'hub-discussion-phone.png')});
  await page.locator('#discussion-start').click();await page.waitForFunction(()=>document.querySelector('#discussion-progress')?.textContent.match(/[0-6]\/7 完了/));assert.equal(await page.locator('#chat-send').isDisabled(),true);
  await finish();await page.waitForFunction(()=>document.querySelector('#discussion-progress')?.hidden);assert.ok(await page.locator('.m.discussion-summary').count());assert.equal(await page.locator('#chat-send').isDisabled(),false);await page.locator('.m.discussion-summary').last().scrollIntoViewIfNeeded();await page.screenshot({path:path.join(os.tmpdir(),'hub-discussion-summary.png')});
  const doneReads=reads;await page.waitForTimeout(1800);assert.equal(reads,doneReads,'completed discussion must not poll');
  await page.reload();await page.locator('#mobile-compose').click();await page.waitForSelector('#discussion-toggle');
  assert.equal(await page.locator('#discussion-progress').isVisible(),false);
  await page.locator('#discussion-toggle').click();await page.waitForSelector('#discussion-start');assert.equal(await page.locator('[data-discussion-person]').nth(1).inputValue(),'codex|gpt-6-astra');assert.equal(await page.locator('[data-discussion-rounds]').inputValue(),'2');assert.match(await page.locator('[data-discussion-count]').innerText(),/7回/);
  await page.locator('#discussion-history > summary').click();assert.match(await page.locator('[data-discussion-history]').innerText(),/7\/7 完了・100%/);
  await page.setViewportSize({width:1280,height:1000});await page.locator('#chat-in').fill('停止後の表示を確認する話題');fs.writeFileSync(control,JSON.stringify({delay:500}));
  await page.locator('#discussion-start').click();await page.waitForFunction(()=>document.querySelector('#discussion-progress')?.textContent.match(/[1-6]\/7 完了/));
  await page.locator('[data-discussion-stop]').click();await finish();await page.waitForFunction(()=>document.querySelector('#discussion-progress')?.hidden);
  assert.equal(await page.locator('#discussion-settings').isVisible(),false);assert.equal(await page.locator('#chat-send').isDisabled(),false);
  // Use the fixture runner directly; ordinary chat's login preflight is unrelated to this UI check.
  assert.equal((await post('/api/ai/resume',{confirm:true})).status,200);
  fs.writeFileSync(control,'{}');const ordinary=chats.send({...scope,pdir,dir:pdir,ai:'codex',model:'GPT-6.1-Sol',text:'普通の会話に戻る',basePrompt:'fixture',policy:'fixture'});assert.equal(await ordinary.started,true);await finish();await page.waitForFunction(()=>document.querySelector('#chat-busyrow')?.hidden);
  assert.equal(await page.locator('#discussion-progress').isVisible(),false);
  const stoppedReads=reads;await page.waitForTimeout(1800);assert.equal(reads,stoppedReads,'stopped discussions must stay idle during ordinary chat');
  await page.locator('#discussion-toggle').click();await page.locator('#discussion-history > summary').click();assert.match(await page.locator('[data-discussion-history]').innerText(),/停止/);
  await page.locator('[data-discussion-summary-model]').selectOption('codex|gpt-6-astra');await page.locator('[data-discussion-summary]').click();
  await finish();await page.waitForFunction(()=>document.querySelector('#discussion-progress')?.hidden);assert.equal((await view()).session.status,'done');assert.equal((await view()).session.slots.at(-1).model,'gpt-6-astra');assert.equal(await page.locator('#discussion-settings').isVisible(),false);assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
