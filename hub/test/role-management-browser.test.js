'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
let chromium;try{({chromium}=require('playwright-core'));}catch{try{({chromium}=require(path.join(os.homedir(),'.local/lib/node_modules/openclaw/node_modules/playwright-core')));}catch{}}
const chrome=process.env.HUB_TEST_CHROME||[path.join(os.homedir(),'.local/bin/chrome-headless-arm64'),'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p=>fs.existsSync(p));
if(!chromium||!chrome)test('role settings real browser (requires Chrome/Playwright)',{skip:true},()=>{});
else{
  const tmp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'hub-role-browser-'))),root=path.join(tmp,'root');
  fs.mkdirSync(path.join(root,'_hub'),{recursive:true});
  const file=path.join(root,'_hub/roles.yaml');fs.copyFileSync(path.join(__dirname,'../../docs/project-hub/templates/_hub/roles.yaml'),file);
  fs.writeFileSync(path.join(root,'_hub/onboarding.json'),JSON.stringify({version:1,status:'done',step:'first',ais:['codex']}));
  fs.writeFileSync(path.join(root,'_hub/ai-tools-models.json'),JSON.stringify({claude:{models:[{id:'claude-opus-5-5',label:'Opus 5.5'},{id:'claude-fable-5-1',label:'Fable 5.1'}]},codex:{models:[{id:'gpt-6.1-sol',label:'GPT-6.1-Sol'},{id:'gpt-6-astra',label:'GPT-6-Astra'}]}}));
  Object.assign(process.env,{HUB_ROOT:root,HUB_AI_HOME:path.join(tmp,'home'),HUB_FREETALK_HOME:path.join(tmp,'freetalk'),HUB_DRY_RUN:'1',HUB_PORT:'0',HUB_AUTO_UPDATE:'0',HUB_AUTO_TRANSLATE:'0'});
  const history=require('../lib/role-history'),roles=require('../lib/roles'),chat=require('../lib/chat');
  const baseline=history.load(file,undefined,'2026-10-10T00:00:00Z');
  const changed=structuredClone(baseline.roles),writer=changed.findIndex(r=>r.name==='文章');changed[writer].main.effort='高';
  assert.equal(roles.write(file,changed,undefined,true,undefined,{at:'2026-10-11T00:00:00Z'}).ok,true);
  const older=history.load(file).journal.history.at(-1);
  assert.equal(roles.write(file,baseline.roles,undefined,true,undefined,{at:'2026-10-11T12:00:00Z'}).ok,true);
  let rt,base,browser,page,topic,savedDefault,starts=0;const errors=[],posts=[];
  const originalSend=chat.ChatRunner.prototype.send;
  chat.ChatRunner.prototype.send=function(){starts++;throw Error('Browser fixture must not start an AI CLI');};
  const post=async(route,body={})=>await(await fetch(base+route,{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json'},body:JSON.stringify(body)})).json();
  test.before(async()=>{
    const probe=require('node:net').createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));process.env.HUB_PORT=String(port);
    rt=require('../server');await new Promise(r=>rt.server.listen(port,'127.0.0.1',r));base='http://127.0.0.1:'+port;
    await post('/api/freetalk/ensure');topic=(await post('/api/freetalk/topic')).id;
    rt.roleReview.availability=async()=>({participants:[],candidates:[],reason:'fixture: 契約内で利用できるAIなし'});
    browser=await chromium.launch({executablePath:chrome,headless:true});page=await browser.newPage({viewport:{width:1280,height:1000},timezoneId:'Asia/Tokyo'});
    page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&r.url().includes('/api/roles/'))posts.push(r.url().split('/api/')[1]);});
    await page.addInitScript(task=>{localStorage.setItem('hub-view',JSON.stringify({kind:'settings',project:'freetalk',task}));localStorage.setItem('hub.settingsTab','ai');},topic);
    await page.goto(base);
    try{await page.waitForSelector('[data-role-setting="review"]',{timeout:5000});}
    catch(e){await page.screenshot({path:path.join(os.tmpdir(),'hub-role-browser-error.png')});throw Error(e.message+'\n'+JSON.stringify({errors,body:await page.locator('body').innerText(),topic}));}
  });
  test.after(async()=>{await browser?.close();rt?.server.closeAllConnections();if(rt)await new Promise(r=>rt.server.close(r));chat.ChatRunner.prototype.send=originalSend;fs.rmSync(tmp,{recursive:true,force:true});});
  test('local date and time restore, fixed defaults, no-change record count and narrow layout',async()=>{
    assert.equal(await page.locator('#role-review-topic').count(),0);
    assert.equal(await page.locator('[data-role-setting="default"]').count(),0);
    await page.locator('[data-role-setting="save-default"]').click();await page.waitForSelector('[data-role-setting="default"]');
    savedDefault=history.load(file).journal.defaults;assert.deepEqual(savedDefault.roles,baseline.roles);
    assert.equal(history.load(file).journal.history.length,3);
    await page.locator('[data-role-setting="history"]').click();await page.locator('#role-history-date').fill('2026-10-12');
    assert.match(await page.locator('.role-history').innerText(),/2026\/10\/11/);
    await page.locator('#role-history-date').fill('2026-10-09');assert.match(await page.locator('.role-history').innerText(),/記録はありません/);
    await page.locator('#role-history-date').fill('2026-10-11');assert.equal(await page.locator('#role-history-id option').count(),3);
    await page.locator('#role-history-id').selectOption(older.id);await page.locator('[data-role-setting="restore"]').click();
    await page.waitForFunction(i=>document.querySelector(`select[data-r="${i}"][data-k="main"][data-f="effort"]`)?.value==='高',writer);
    assert.equal(history.load(file).journal.history.length,4);
    await page.locator('[data-role-setting="default"]').click();await page.waitForFunction(i=>document.querySelector(`select[data-r="${i}"][data-k="main"][data-f="effort"]`)?.value==='中',writer);
    assert.equal(history.load(file).journal.history.length,5);assert.deepEqual(history.load(file).journal.defaults,savedDefault);
    await page.locator('[data-role-setting="default"]').click();await page.waitForFunction(()=>!roleSettingsBusy);assert.equal(history.load(file).journal.history.length,5);
    await page.locator('[data-role-setting="history"]').click();await page.waitForFunction(()=>!roleSettingsBusy);await page.locator('#role-settings-controls').evaluate(el=>{el.style.scrollMarginTop='100px';el.scrollIntoView();});
    await page.screenshot({path:path.join(os.tmpdir(),'hub-role-settings-desktop.png')});
    await page.setViewportSize({width:390,height:900});await page.evaluate(()=>closeDrawer());await page.waitForFunction(()=>document.querySelector('#list').getBoundingClientRect().right<=0);await page.locator('#role-settings-controls').evaluate(el=>{el.style.scrollMarginTop='100px';el.scrollIntoView();});
    assert.equal(await page.locator('[data-role-setting="review"]').isVisible(),true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:path.join(os.tmpdir(),'hub-role-settings-mobile.png')});
    await page.setViewportSize({width:1280,height:1000});await page.locator('[data-role-setting="close"]').click();
  });
  test('one click starts once, duplicate click and draft edit are protected, unavailable AI leaves last date unset',async()=>{
    const effort=page.locator(`select[data-r="${writer}"][data-k="main"][data-f="effort"]`);
    await effort.selectOption('高');assert.equal(await page.locator('[data-role-setting="review"]').isDisabled(),true);
    await effort.selectOption('中');assert.equal(await page.locator('[data-role-setting="review"]').isDisabled(),false);
    await page.locator('[data-role-setting="review"]').evaluate(b=>{b.click();b.click();});
    try{await page.waitForFunction(()=>document.querySelector('#role-settings-controls')?.textContent.includes('利用できません'),null,{timeout:5000});}
    catch(e){throw Error(e.message+'\n'+JSON.stringify({management:history.summary(history.load(file)),errors,posts,shown:await page.locator('#role-settings-controls').innerText()}));}
    assert.equal(posts.filter(x=>x==='roles/review').length,1);assert.equal(history.load(file).journal.lastReviewedAt,'');assert.equal(history.load(file).journal.history.length,5);
    const created=history.load(file).journal.lastReview.task;assert.notEqual(created,topic);
    await page.locator('[data-role-setting="topic"]').click();await page.waitForSelector('.freetalk-work');
    assert.equal(await page.evaluate(()=>view.task),created);
    await page.evaluate(()=>{view.kind='settings';render();});
    assert.equal(starts,0);assert.deepEqual(errors,[]);
  });
  test('successful review refreshes the role table and date without page reload',async()=>{
    const next=structuredClone(history.load(file).roles);next[writer].main.effort='高';
    rt.roleReview.availability=async()=>({participants:[{ai:'codex',model:'gpt-6.1-sol',account:'default',effort:'高'}],candidates:[{ai:'claude',id:'claude-opus-5-5',label:'Opus 5.5',efforts:['中','高']}],reason:'browser fixture'});
    // Real ChatRunner/model dispatch is covered in role-management-http.test.js.
    rt.roleReview.dispatch=async p=>rt.roleReview.settled(p,{ai:p.ai,model:p.model,text:'[[役割見直し結果]]'+JSON.stringify({roles:next,reason:'fixture success',evidence:[{role:'文章',reason:'fixture evidence',sources:['fixture']}]})+'[[/役割見直し結果]]'});
    await page.locator('[data-role-setting="review"]').click();
    await page.waitForFunction(i=>document.querySelector(`select[data-r="${i}"][data-k="main"][data-f="effort"]`)?.value==='高',writer,{timeout:5000});
    assert.doesNotMatch(await page.locator('#role-settings-controls').innerText(),/最終見直し日時：未実施/);
    assert.equal(history.load(file).journal.history.length,6);assert.ok(history.load(file).journal.lastReviewedAt);assert.deepEqual(history.load(file).journal.defaults,savedDefault);
    assert.equal(starts,0);assert.deepEqual(errors,[]);
  });
  test('save current default captures edited values, keeps the draft and offers both buttons after reload',async()=>{
    const before=history.load(file),effort=page.locator(`select[data-r="${writer}"][data-k="main"][data-f="effort"]`);
    await effort.selectOption('中');assert.equal(await page.locator('[data-role-setting="save-default"]').isDisabled(),false);
    await page.locator('[data-role-setting="save-default"]').click();await page.waitForFunction(()=>!roleSettingsBusy);
    const saved=history.load(file);assert.equal(saved.journal.defaults.roles[writer].main.effort,'中');assert.equal(saved.roles[writer].main.effort,'高');
    assert.deepEqual(saved.journal.history,before.journal.history);assert.equal(saved.journal.lastReviewedAt,before.journal.lastReviewedAt);
    assert.equal(await effort.inputValue(),'中');assert.equal(await page.evaluate(()=>rolesDirty()),true);
    await page.reload();await page.waitForSelector('[data-role-setting="default"]');
    assert.equal(await page.locator('[data-role-setting="save-default"]').isVisible(),true);
    await page.locator('[data-role-setting="default"]').click();await page.waitForFunction(i=>document.querySelector(`select[data-r="${i}"][data-k="main"][data-f="effort"]`)?.value==='中',writer);
    assert.equal(history.load(file).roles[writer].main.effort,'中');assert.equal(starts,0);assert.deepEqual(errors,[]);
  });

  test('保存済み削除モデルは初回役割表示と一覧更新・通常会話で選択不可、入力と保存値を保持する',async()=>{
    fs.writeFileSync(file,fs.readFileSync(file,'utf8').replaceAll('Opus 5.5','Removed Claude').replaceAll('GPT-6.1-Sol','Removed Codex'));
    await page.reload();await page.waitForSelector(`select[data-r="${writer}"][data-k="main"][data-f="model"]`);
    const unavailable=async(selector,value)=>{
      assert.equal(await page.locator(selector).inputValue(),value);
      const option=page.locator(selector+' option:checked');assert.equal(await option.isDisabled(),true);assert.match(await option.innerText(),/利用不可/);
    };
    const main=`select[data-r="${writer}"][data-k="main"][data-f="model"]`,backup=`select[data-r="${writer}"][data-k="backup"][data-f="model"]`;
    await unavailable(main,'Removed Claude');await unavailable(backup,'Removed Codex');
    await page.evaluate(()=>{refreshRoleModelChoices();syncRoleModelOrder();});
    await unavailable(main,'Removed Claude');await unavailable(backup,'Removed Codex');
    for(const [ai,model,key] of [['claude','Removed Claude','claude-code'],['codex','Removed Codex','codex']]) {
      await page.evaluate(({topic,ai,model})=>{localStorage.setItem('hub-chat-freetalk/'+topic,JSON.stringify({ai,model,effort:'高'}));view={kind:'work',project:'freetalk',task:topic};render();},{topic,ai,model});
      await unavailable('#chat-ai',ai+'|'+model);
      await page.locator('#chat-in').fill('保持する下書き');
      await page.evaluate(({key,model})=>{const next=structuredClone(state);next.roles.models[key].push(model);adoptState(next);},{key,model});
      assert.equal(await page.locator('#chat-ai option:checked').isDisabled(),false);
      await page.evaluate(({key,model})=>{const next=structuredClone(state);next.roles.models[key]=next.roles.models[key].filter(m=>m!==model);adoptState(next);},{key,model});
      await unavailable('#chat-ai',ai+'|'+model);assert.equal(await page.locator('#chat-in').inputValue(),'保持する下書き');
    }
    assert.equal(starts,0);assert.deepEqual(errors,[]);
  });
}
