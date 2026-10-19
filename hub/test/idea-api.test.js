'use strict';
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const U = require('../lib/idea-utils');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'idea-api-'))), dir = path.join(root, 'Product/P');
fs.mkdirSync(path.join(dir, '.ai/tasks'), { recursive: true }); fs.mkdirSync(path.join(root, '_hub'), { recursive: true });
fs.writeFileSync(path.join(dir, 'PROJECT.md'), '---\nname: P\nstatus: 進行中\nphases: []\nfolders: {}\n---\n');
fs.writeFileSync(path.join(dir, '.ai/tasks/main.md'), '---\nid: main\ntitle: 本作業\nkind: main\nstate: 進行中\n---\n## 手順\n- [ ] 元の手順\n');
fs.writeFileSync(path.join(root, '_hub/onboarding.json'), JSON.stringify({ version: 1, status: 'done', step: 'first', ais: ['codex'] }));
process.env.HUB_ROOT = root; process.env.HUB_DRY_RUN = '1'; process.env.HUB_PORT = String(47000 + process.pid % 1000);
const runtime = require('../server'), { server, ideas, chats } = runtime; let base;
test.before(async () => { await new Promise(r => server.listen(Number(process.env.HUB_PORT), '127.0.0.1', r)); base = 'http://127.0.0.1:' + process.env.HUB_PORT; });
test.after(() => new Promise(r => server.close(r)));
async function post(route, body, human = true) { const response = await fetch(base + route, { method: 'POST', headers: { 'X-Hub': '1', 'Content-Type': 'application/json', ...(human ? { Origin: base, 'X-Hub-UI': 'ideas' } : {}) }, body: JSON.stringify({ project: 'P', ...body }) }); return { status: response.status, body: await response.json() }; }
test('C1: 親AIがbusyでも原文を先保存、GETは台帳を作らない', async () => {
  assert.equal((await fetch(base + '/api/ideas?project=P', { headers: { 'X-Hub': '1' } })).status, 200); assert.equal(fs.existsSync(ideas.registryFile), false);
  chats.running.set(chats.key('P', 'main'), { ai: 'codex', texts: [] });
  try { const r = await post('/api/ideas/add', { opId: U.uuid(), text: '忙しい間のアイデア', intent: 'record' }); assert.equal(r.status, 201); assert.equal(r.body.saved, true); }
  finally { chats.running.delete(chats.key('P', 'main')); }
});
test('C3/C8: 人UIとAI記録を分け、receipt再送と更新競合を照合', async () => {
  const b = { opId: U.uuid(), text: '人の作る依頼', intent: 'build' }; assert.equal((await post('/api/ideas/add', b, false)).status, 403);
  const a = await post('/api/ideas/add', b); assert.equal(a.status, 201); assert.equal((await post('/api/ideas/add', b)).body.id, a.body.id); assert.equal((await post('/api/ideas/add', { ...b, text: '別内容' })).status, 409);
  const r = await (await fetch(base + '/api/ideas/receipt?' + new URLSearchParams({ project: 'P', opId: b.opId }), { headers: { 'X-Hub': '1' } })).json(); assert.equal(r.saved, true);
  assert.equal((await post('/api/ideas/update', { opId: U.uuid(), id: a.body.id, baseControlRev: 0, baseContentRev: 1, change: { withdraw: true } })).status, 409);
});
test('C6: メッセージ原文をserver捕捉、会話切替後の再送でも同receipt', async () => {
  const chat = require('../lib/chat'), { decorate } = require('../lib/idea-source'); chat.append(dir, 'main', { role: 'user', turn: 'turn-1', text: '保存する会話原文' });
  const row = decorate(chat.read(dir, 'main'), 1).at(-1), b = { opId: U.uuid(), intent: 'record', sourceRef: { task: 'main', ...row.ideaSource }, sourceText: row.text };
  const r = await post('/api/ideas/add', b); assert.equal(r.status, 201); assert.equal(ideas.read('P').items[r.body.id].source.capture, 'verified');
  fs.writeFileSync(chat.files(dir, 'main').log, ''); assert.equal((await post('/api/ideas/add', b)).body.id, r.body.id);
});
test('C7/C30: freetalkを対象にしない、機能を戻した時は開始しない', async () => {
  assert.equal((await post('/api/ideas/add', { project: 'freetalk', opId: U.uuid(), text: 'x' })).status, 404);

});
let chromium; try { ({ chromium } = require('playwright-core')); } catch { try { ({ chromium } = require(path.join(os.homedir(), '.local/lib/node_modules/openclaw/node_modules/playwright-core'))); } catch {} }
const chrome = process.env.HUB_TEST_CHROME || [path.join(os.homedir(), '.local/bin/chrome-headless-arm64'), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p => fs.existsSync(p));
test('C28: 実ブラウザ・日本語IME/改行/ショートカット/スマホ/保存不明と押下数', { skip: !chromium || !chrome }, async () => {
  const browser = await chromium.launch({ executablePath: chrome, headless: true }), page = await browser.newPage({ viewport: { width: 1280, height: 900 } }), errors = [];
  page.on('pageerror', e => errors.push(e.message)); page.setDefaultTimeout(8000);
  try {
    await page.addInitScript(() => { if (!localStorage.getItem('hub-view')) localStorage.setItem('hub-view', JSON.stringify({ kind: 'project', project: 'P' })); });
    await page.goto(base); const entry = page.locator('[data-idea-open="P"]').first(); await entry.click(); await page.waitForSelector('#idea-text');
    const input = page.locator('#idea-text'); await input.fill('日本語のアイデア'); const before = Object.keys(ideas.read('P').items).length;
    await input.dispatchEvent('keydown', { key: 'Enter', metaKey: true, isComposing: true, keyCode: 229 }); await input.press('Enter'); assert.equal(Object.keys(ideas.read('P').items).length, before);
    await input.fill('二回の押下で保存'); await page.locator('[data-idea-add]').click(); await page.waitForFunction(() => document.querySelector('#idea-text').value === ''); assert.equal(Object.keys(ideas.read('P').items).length, before + 1);
    await input.fill('キーボード保存'); await input.press('Meta+Enter'); await page.waitForFunction(() => document.querySelector('#idea-text').value === '');
    // Abort after Hub has committed: retry must look up the receipt, not create a new item.
    let once = true; await page.route('**/api/ideas/add', async route => { if (once) { once = false; await route.fetch(); await route.abort(); } else await route.continue(); });
    await input.fill('応答だけが切れた原文'); const count = Object.keys(ideas.read('P').items).length; await page.locator('[data-idea-add]').click(); await page.waitForFunction(() => document.querySelector('[data-idea-status]').textContent.includes('結果不明')); assert.equal(await input.inputValue(), '応答だけが切れた原文');
    await page.locator('[data-idea-add]').click(); await page.waitForFunction(() => document.querySelector('#idea-text').value === ''); assert.equal(Object.keys(ideas.read('P').items).length, count + 1);
    await page.unroute('**/api/ideas/add'); await page.setViewportSize({ width: 390, height: 844 }); assert.ok(await page.locator('.ideas-dialog').evaluate(el => el.scrollWidth <= el.clientWidth)); assert.ok((await page.locator('[data-idea-add]').boundingBox()).height >= 44);
    await page.locator('[data-idea-close]').click(); await page.evaluate(() => localStorage.setItem('hub-view', JSON.stringify({ kind: 'work', project: 'P', task: 'main' }))); await page.reload();
    const chat = require('../lib/chat'); chat.append(dir, 'main', { role: 'assistant', ai: 'codex', text: '1回で残す文章', request: 'one-click' }); await page.reload(); await page.waitForSelector('[data-idea-message]');
    const count2 = Object.keys(ideas.read('P').items).length; await page.locator('[data-idea-message]').last().click(); await page.waitForFunction(() => [...document.querySelectorAll('[data-idea-message]')].some(e => e.textContent === '台帳を見る')); assert.equal(Object.keys(ideas.read('P').items).length, count2 + 1);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
const IMAGE_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8DA8B+MgBgAHfAD/dPQfSYAAAAASUVORK5CYII=', 'base64');
async function postImage(bytes=IMAGE_PNG, opts={}) {
 const response=await fetch(base+'/api/ideas/image?'+new URLSearchParams({project:'P',opId:U.uuid(),name:'スクショ.png',...opts.query}),{method:'POST',headers:{'X-Hub':'1',Origin:base,'X-Hub-UI':'ideas',...opts.headers},body:bytes});return {status:response.status,body:await response.json()};
}
test('images API: 独立upload・人UI限定・画像のみ・所属検査・原本配信・応答断receipt',async()=>{
 const taskFile=path.join(dir,'.ai/tasks/main.md'),before=fs.readFileSync(taskFile,'utf8'),opId=U.uuid();
 assert.equal((await postImage(IMAGE_PNG,{headers:{'X-Hub-UI':''}})).status,403);
 assert.equal((await postImage(Buffer.alloc(20*1024*1024+1))).status,413);
 const upload=await postImage(IMAGE_PNG,{query:{opId}});assert.equal(upload.status,201);assert.equal(upload.body.saved,true);assert.equal(fs.readFileSync(taskFile,'utf8'),before);
 assert.equal((await postImage(IMAGE_PNG,{query:{opId}})).body.image.id,upload.body.image.id);
 const receipt=await(await fetch(base+'/api/ideas/receipt?'+new URLSearchParams({project:'P',opId}),{headers:{'X-Hub':'1'}})).json();assert.equal(receipt.image.id,opId);
 const r=await post('/api/ideas/add',{opId:U.uuid(),text:'',images:[opId],intent:'record'});assert.equal(r.status,201);assert.equal(ideas.read('P').items[r.body.id].grant,null);
 const uri=base+'/api/ideas/image?'+new URLSearchParams({project:'P',id:opId});assert.equal((await fetch(uri)).status,403);const image=await fetch(uri,{headers:{'X-Hub':'1'}});assert.equal(image.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await image.arrayBuffer()),IMAGE_PNG);
 const unknown=await fetch(base+'/api/ideas/image?'+new URLSearchParams({project:'P',id:U.uuid()}),{headers:{'X-Hub':'1'}});assert.equal(unknown.status,404);
 assert.equal((await post('/api/ideas/add',{opId:U.uuid(),text:'',images:[U.uuid()]})).status,400);
});
test('images UI: dark/light・PC/mobile・選択/drop/取り外し/下書き再読込/保存失敗/画像のみ/通常会話混入なし', {skip:!chromium||!chrome}, async()=>{
 const browser=await chromium.launch({executablePath:chrome,headless:true}),artifacts=path.resolve(__dirname,'../../.ai/work/idea-redesign/images-regression');fs.mkdirSync(artifacts,{recursive:true});const report=[];
 try { for(const theme of ['dark','light'])for(const width of [1280,390]) {
  const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage(),errors=[],mutations=[];page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')mutations.push(new URL(r.url()).pathname);});
  const open=async()=>{await page.evaluate(()=>window.HubIdeas.open('P','main'));await page.waitForSelector('#idea-text');await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);};
  await page.addInitScript(()=>localStorage.setItem('hub-view',JSON.stringify({kind:'work',project:'P',task:'main'})));await page.goto(base);await open();
  const pick=page.locator('[data-idea-pick]');await pick.focus();const chooserP=page.waitForEvent('filechooser');await pick.press('Enter');const chooser=await chooserP;await chooser.setFiles([{name:'選択画像.png',mimeType:'image/png',buffer:IMAGE_PNG},{name:'取り外す.png',mimeType:'image/png',buffer:IMAGE_PNG}]);await page.waitForFunction(()=>document.querySelectorAll('[data-image-remove]').length===2);
  await page.locator('[data-image-remove]').last().click();await page.waitForFunction(()=>document.querySelectorAll('[data-image-remove]').length===1);
  const drop=async()=>page.evaluate(base64=>{const dt=new DataTransfer();dt.items.add(new File([Uint8Array.from(atob(base64),c=>c.charCodeAt(0))],'ドロップ.png',{type:'image/png'}));const el=document.querySelector('.ideas-dialog header');el.dispatchEvent(new DragEvent('dragover',{dataTransfer:dt,bubbles:true,cancelable:true}));el.dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true}));},IMAGE_PNG.toString('base64'));
  await drop();await page.waitForFunction(()=>document.querySelectorAll('[data-image-remove]').length===2);await page.waitForFunction(()=>[...document.querySelectorAll('[data-idea-images] img')].every(i=>i.naturalWidth>0));
  const title=`画像画面 ${theme} ${width}`;if(width===1280)await page.fill('#idea-text',title);await page.screenshot({path:path.join(artifacts,theme+'-'+width+'-draft.png')});
  await page.reload();await open();await page.waitForFunction(()=>document.querySelectorAll('[data-image-remove]').length===2&&[...document.querySelectorAll('[data-idea-images] img')].every(i=>i.naturalWidth>0));assert.equal(await page.inputValue('#idea-text'),width===1280?title:'');
  const previousIds=new Set(Object.keys(ideas.read('P').items)),count=previousIds.size;
  if(theme==='dark'&&width===1280){let once=true;await page.route('**/api/ideas/image?*',async route=>{if(route.request().method()==='POST'&&once){once=false;await route.fetch();await route.abort();}else await route.continue();});await page.click('[data-idea-add]');await page.waitForFunction(()=>document.querySelector('[data-idea-status]').textContent.includes('結果不明'));assert.equal(await page.inputValue('#idea-text'),title);assert.equal(await page.locator('[data-image-remove]').count(),2);await page.reload();await open();}
  if(theme==='light'&&width===390){await page.route('**/api/ideas/add',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({saved:false,message:'fixture 保存不可'})}));await page.click('[data-idea-add]');await page.waitForFunction(()=>document.querySelector('[data-idea-status]').textContent.includes('fixture 保存不可'));assert.equal(await page.locator('[data-image-remove]').count(),2);await page.screenshot({path:path.join(artifacts,theme+'-'+width+'-failure.png')});await page.unroute('**/api/ideas/add');}
  await page.locator('#idea-text').press('Control+Enter');await page.waitForFunction(()=>document.querySelectorAll('[data-image-remove]').length===0);assert.equal(Object.keys(ideas.read('P').items).length,count+1);const item=Object.values(ideas.read('P').items).find(i=>!previousIds.has(i.id));assert.equal(item.images.length,2);assert.equal(item.intent,'record');assert.equal(item.grant,null);
  await page.reload();await open();const saved=page.locator(`.idea-item[data-item="${item.id}"]`);await saved.locator('summary').first().click();await page.waitForFunction(id=>[...document.querySelectorAll(`.idea-item[data-item="${id}"] img`)].every(i=>i.naturalWidth>0),item.id);
  if(theme==='dark'&&width===1280){const popupP=page.waitForEvent('popup');await saved.locator('[data-image-view]').first().click();const popup=await popupP;await popup.waitForLoadState();assert.ok(popup.url().startsWith('blob:'));await popup.close();}
  assert.ok(await page.locator('.ideas-dialog').evaluate(e=>e.scrollWidth<=e.clientWidth));assert.deepEqual(errors,[]);assert.equal(mutations.some(p=>['/api/task/upload','/api/start/image','/api/task','/api/chat/send','/api/term/start'].includes(p)),false);
  await page.screenshot({path:path.join(artifacts,theme+'-'+width+'-saved.png')});report.push({theme,width,images:item.images.length,errors,mutations});await context.close();
 }fs.writeFileSync(path.join(artifacts,'report.json'),JSON.stringify(report,null,2)); }finally{await browser.close();}
});
