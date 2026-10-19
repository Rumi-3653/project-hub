'use strict';
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-gpt-server-'));
const body = path.join(root, 'Body'), pdir = path.join(root, 'Product/P');
fs.mkdirSync(body); fs.mkdirSync(path.join(pdir, '.ai/tasks'), { recursive: true });
const git = (...args) => execFileSync('git', ['-C', body, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'fixture@localhost');
fs.writeFileSync(path.join(body, 'main.txt'), 'main'); git('add', '.'); git('commit', '-qm', 'base');
fs.writeFileSync(path.join(pdir, 'PROJECT.md'), `---\nname: P\nfolders:\n  本体: ${body}\n---\n`);
fs.writeFileSync(path.join(pdir, '.ai/tasks/t.md'), '---\nid: t\ntitle: Parent\nstate: 未着手\nowner: codex\nworkspaceMode: isolated\n---\n');
Object.assign(process.env, { HUB_ROOT: root, HUB_PORT: '0', HUB_DRY_RUN: '1', HUB_AI_HOME: path.join(root, 'home'), HUB_STORAGE_GUARD: '', HUB_AUTO_TRANSLATE: '0', HUB_AUTO_UPDATE: '0' });
let server, sessions, chats, base, network = 0, child, request;
const originalFetch = global.fetch;
test.before(async () => {
  const probe = require('node:http').createServer();
  await new Promise(r => probe.listen(0, '127.0.0.1', r)); const port = probe.address().port;
  await new Promise(r => probe.close(r)); process.env.HUB_PORT = String(port);
  ({ server, sessions, chats } = require('../server'));
  await new Promise(r => server.listen(port, '127.0.0.1', r)); base = 'http://127.0.0.1:' + port;
  global.fetch = (url, options) => { if (new URL(url).origin !== base) { network++; throw Error('unexpected network'); } return originalFetch(url, options); };
});
test.after(async () => { global.fetch = originalFetch; sessions.stopAll(); await new Promise(r => server.close(r)); fs.rmSync(root, { recursive: true, force: true }); });
const post = (url, body, auth = true) => fetch(base + url, { method: 'POST', headers: { ...(auth ? { 'X-Hub': '1' } : {}), 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify(body) });
const send = extra => post('/api/chat/send', { project: 'P', task: 't', ai: 'chatgpt', model: 'chat', text: 'request text', ...extra });
const call = (name, args) => post('/api/mcp/call', { name, arguments: { project: 'P', ...args } });
test('旧手動とアプリ選択は起動前410で拒否し、作業・依頼・履歴を変えない',async()=>{
  const before=fs.readFileSync(path.join(pdir,'.ai/tasks/t.md'),'utf8');
  for(const extra of ['chat','app'].flatMap(model=>[{model},{model,images:['x']},{model,mode:'queue'}])) assert.equal((await send(extra)).status,410);
  assert.equal(fs.readFileSync(path.join(pdir,'.ai/tasks/t.md'),'utf8'),before);
  assert.equal(fs.readdirSync(path.join(pdir,'.ai/tasks')).length,1);
  assert.equal(sessions.list().filter(s=>s.running).length,0);assert.equal(network,0);
});
test('外部MCPのGPT inboxとGPT子への変更を閉じ、記録を保持する',async()=>{
  const {Store}=require('../lib/store'),chat=require('../lib/chat');const store=new Store(root);
  const {GptChildren}=require('../lib/gpt-children');const service=new GptChildren({store,chat,baseOf:()=>body,workRoot:()=>path.join(root,'Work/P'),emitRow(){},record(){}});
  const c=store.createTask('P',{title:'Historical child',owner:'chatgpt',parent:'t',workspaceMode:'isolated'});
  const dir=require('../lib/git').prepare({base:body,workRoot:path.join(root,'Work/P'),taskId:c.id,isolatedOnly:true}).dir;
  store.updateTask('P',c.id,{gptChild:true,workdir:dir});child=c.id;request=require('node:crypto').randomUUID();
  chat.append(pdir,child,{role:'user',to:'gptchat',request,text:'saved old request'});
  const before=fs.readFileSync(store.taskFile('P',child),'utf8');
  assert.equal((await post('/api/chatgpt',{work:true})).status,200);
  const tools=await(await fetch(base+'/api/mcp/tools',{headers:{'X-Hub':'1',Connection:'close'}})).json();
  assert.equal(tools.tools.some(t=>t.name==='hub_gpt_inbox'),false);
  assert.equal((await call('hub_gpt_inbox',{task:child})).status,404);
  for(const name of ['hub_write_file','hub_run_command','hub_report','hub_ask_owner','hub_mark_step','hub_propose_task'])
    for(const requestId of [undefined,request]) assert.equal((await call(name,{task:child,request:requestId,path:'bad.txt',text:'bad',command:'touch bad.txt',question:'bad',index:0,done:true,title:'bad'})).status,403);
  assert.equal(fs.existsSync(path.join(store.readTask(store.taskFile('P',child)).workdir,'bad.txt')),false);
  assert.equal(fs.readFileSync(store.taskFile('P',child),'utf8'),before);assert.equal(chat.read(pdir,child).length,1);
});
test('廃止Dot送信と認可なし送信は保存前に拒否する',async()=>{
  assert.equal((await post('/api/chat/send',{project:'P',task:'t',ai:'chatgpt',model:'chat',text:'x'},false)).status,403);
  const chat=require('../lib/chat'),before=JSON.stringify(chat.read(pdir,'t'));
  assert.equal((await send({ai:'dot',model:'inbox',text:'Dot request'})).status,410);
  assert.equal(JSON.stringify(chat.read(pdir,'t')),before);assert.equal(network,0);
});
test('保存済み手動・アプリqueueは確認・起動前に拒否し、履歴・質問・待ち行を保持する',async()=>{
  const chat=require('../lib/chat'),rows=['chat','app'].map(model=>({id:'old-'+model,ai:'chatgpt',model,text:'old '+model}));
  // Seed through the live runner: startup recovery has already loaded its queue.
  chats.setQueue('P','t',rows,true);
  chat.append(pdir,'t',{role:'assistant',ai:'chatgpt',model:'app',text:'old reply'});
  const files=[path.join(pdir,'.ai/tasks/t.md'),chat.files(pdir,'t').log,chat.files(pdir,'t').queue];
  const before=files.map(file=>fs.readFileSync(file));let checks=0;
  const runner=new chat.ChatRunner({dirOf:()=>pdir,beforeQueued(){checks++;throw Error('must not run');},canStart(){checks++;throw Error('must not run');}});
  for(const row of rows){
    const o={...row,request:row.id,project:'P',task:'t',pdir,dir:body};
    assert.throws(()=>runner.send(o),/廃止.*選び直し/);
    await assert.rejects(runner.sendQueued(o),/廃止.*選び直し/);
    assert.equal((await send({model:row.model,fromQueue:row.id,text:row.text})).status,410);
  }
  assert.equal(checks,0);assert.equal(runner.running.size,0);assert.deepEqual(runner.queue('P','t'),rows);
  files.forEach((file,i)=>assert.deepEqual(fs.readFileSync(file),before[i]));assert.equal(network,0);
});
