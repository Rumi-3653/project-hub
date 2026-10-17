'use strict';
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-webchat-http-'));
const body = path.join(root, 'Body'), pdir = path.join(root, 'Product/P'), location = path.join(root, 'External');
fs.mkdirSync(body); fs.mkdirSync(path.join(pdir, '.ai/tasks'), { recursive: true }); fs.mkdirSync(path.join(location, 'dist'), { recursive: true });
const git = (...args) => execFileSync('git', ['-C', body, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@localhost');
fs.writeFileSync(path.join(body, 'main.txt'), 'body'); git('add', '.'); git('commit', '-qm', 'base');
fs.writeFileSync(path.join(pdir, 'PROJECT.md'), `---\nname: P\nfolders:\n  本体: ${body}\n---\n`);
fs.writeFileSync(path.join(pdir, '.ai/tasks/t.md'), '---\nid: t\ntitle: Parent\nstate: 未着手\nowner: codex\nworkspaceMode: isolated\n---\n');
fs.writeFileSync(path.join(pdir, '.ai/tasks/queued.md'), '---\nid: queued\ntitle: Queued parent\nstate: 未着手\nowner: codex\nworkspaceMode: isolated\n---\n');
fs.mkdirSync(path.join(pdir, '.ai/chat'));
fs.writeFileSync(path.join(pdir, '.ai/chat/queued.queue.json'), JSON.stringify([{ id: 'fixture-queued', ai: 'codex', model: 'gpt-6.1-sol', text: 'saved queue' }]));
fs.copyFileSync(path.join(__dirname, 'fixtures/webchat-mcp.cjs'), path.join(location, 'dist/WebChatMCP.js'));
fs.copyFileSync(path.join(__dirname, 'fixtures/webchat-session.cjs'), path.join(location, 'dist/session.js'));
fs.writeFileSync(path.join(location, 'fake.json'), JSON.stringify({ answers: [{ delay: 2000, answer: 'HTTPの報告' }] }));
Object.assign(process.env, { HUB_ROOT: root, HUB_PORT: '0', HUB_DRY_RUN: '1', HUB_AI_HOME: path.join(root, 'home'), HUB_STORAGE_GUARD: '', HUB_AUTO_TRANSLATE: '0', HUB_AUTO_UPDATE: '0' });
let server, sessions, webchat, chats, procwatch, base, request, child;
const originalFetch = global.fetch;
test.before(async () => {
  const probe = require('node:http').createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); const port = probe.address().port; await new Promise(r => probe.close(r)); process.env.HUB_PORT = String(port);
  const watch=require('../lib/procwatch'),create=watch.create;
  watch.create=opts=>(procwatch=create(opts));
  try { ({ server, sessions, webchat, chats } = require('../server')); } finally { watch.create=create; }
  await new Promise(r => server.listen(port, '127.0.0.1', r)); base = 'http://127.0.0.1:' + port;
  global.fetch = (url, options) => { if (new URL(url).origin !== base) throw Error('unexpected network'); return originalFetch(url, options); };
});
test.after(async () => { await webchat.tail; webchat.shutdown(); global.fetch = originalFetch; sessions.stopAll(); await new Promise(r => server.close(r)); fs.rmSync(root, { recursive: true, force: true }); });
const post = (url, body, auth = true) => fetch(base + url, { method: 'POST', headers: { ...(auth ? { 'X-Hub': '1' } : {}), 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify(body) });
const submit = b => post('/api/chat/send', { project: 'P', task: 't', ai: 'chatgpt', model: 'auto', text: 'send through fake', ...b });
test('settings default off, save guarded, images and queued modes rejected without child creation', async () => {
  assert.equal((await (await fetch(base + '/api/webchat')).json()).enabled, false);
  assert.equal((await submit()).status, 409);
  assert.equal((await post('/api/webchat', { enabled: true }, false)).status, 403);
  assert.equal((await post('/api/webchat', { location: 'relative' })).status, 409);
  assert.equal((await post('/api/webchat', { enabled: true, location, model: 'Pro', thinking: 'Extended' })).status, 200);
  assert.equal((await submit({ images: ['x'] })).status, 400);
  assert.equal((await submit({ mode: 'queue' })).status, 400);
  assert.equal((await submit({ task: 'queued' })).status, 409);
  assert.equal(fs.readdirSync(path.join(pdir, '.ai/tasks')).length, 2);
});
test('actual HTTP auto submission/report holds lock, blocks settings/manual child/parent sends/history and leaves retired API closed', async () => {
  const response = await submit(); assert.equal(response.status, 200); const r = await response.json();
  assert.equal(r.webchat, true); request = r.request; child = r.task;
  assert.equal((await post('/api/webchat', { enabled: false })).status, 409);
  assert.equal((await submit()).status, 409);
  for (const model of ['chat','app']) assert.equal((await post('/api/chat/send', { project: 'P', task: child, ai: 'chatgpt', model, text: 'retired' })).status, 410);
  assert.equal((await post('/api/chat/send', { project: 'P', task: 't', ai: 'codex', model: 'GPT-6.1-Sol', text: 'concurrent' })).status, 409);
  assert.equal((await post('/api/task/history/summary', { project: 'P', task: child })).status, 409);
  assert.equal((await post('/api/task/completion', { project: 'P', task: child, action: 'approve', confirm: true })).status, 409);
  assert.equal((await submit({ model: 'astra' })).status, 409);
  await webchat.tail; assert.equal(webchat.jobs[0].state, 'done'); assert.equal(sessions.list().some(s => s.running), false);
  const rows = require('../lib/chat').read(pdir, child); assert.equal(rows.filter(r => r.request === request && r.role === 'assistant').length, 1);
  assert.equal((await (await fetch(base + '/api/state')).json()).webchat.jobs[0].state, 'done');
});
test('explicit login/status invoke only external fake MCP, settings keep shared work permission and no CLI configuration', async () => {
  assert.equal((await post('/api/webchat/status', {})).status, 200);
  assert.equal((await post('/api/webchat/login', {})).status, 200);
  assert.equal((await (await fetch(base + '/api/chatgpt')).json()).work, false);
  assert.equal((await post('/api/webchat/retry', { project: 'P', task: 't', request, confirm: true })).status, 409);
  assert.equal(fs.existsSync(path.join(root, 'home', '.codex/config.toml')), false);
});
test('HTTP login saves and enables in one action; confirmed logout uses the saved profile and retains model/thinking', async () => {
  assert.equal((await post('/api/webchat', { enabled: false })).status, 200);
  const login = await post('/api/webchat/login', { location, model: 'Pro', thinking: 'Extended' });
  assert.equal(login.status, 200); const ready = await login.json();
  assert.equal(ready.enabled, true); assert.equal(ready.check.loggedIn, true);
  assert.equal((await post('/api/webchat/logout', {})).status, 400);
  assert.equal((await post('/api/webchat/logout', { confirm: true }, false)).status, 403);
  const response = await post('/api/webchat/logout', { confirm: true, location: '/untrusted-unsaved-path' });
  assert.equal(response.status, 200); const out = await response.json();
  assert.equal(out.enabled, false); assert.equal(out.check.loggedIn, false);
  assert.equal(out.location, location); assert.equal(out.model, 'Pro'); assert.equal(out.thinking, 'Extended');
  assert.equal((await (await post('/api/webchat/login', {})).json()).enabled, true);
});
test('external null RPC leaves HTTP responsive, records uncertainty and permits stop without automatic resend', async () => {
  fs.writeFileSync(path.join(location, 'fake.json'), JSON.stringify({ answers: [{ malformedMcp: null }] }));
  const response = await submit(); assert.equal(response.status, 200); const r = await response.json();
  await webchat.tail;
  const state = await fetch(base + '/api/state'); assert.equal(state.status, 200);
  const job = (await state.json()).webchat.jobs.find(j => j.request === r.request);
  assert.equal(job.state, 'unknown'); assert.equal(job.error, 'webchat_invalid_mcp');
  assert.equal(webchat.busy().length, 0);
  assert.equal((await post('/api/webchat/stop', { project: 'P', task: 't' })).status, 200);
  const calls = fs.readFileSync(path.join(location, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(c => c.name === 'webchat_ask').length, 2); // First successful request plus this one.
  assert.equal(require('../lib/chat').read(pdir, r.task).some(row => row.role === 'assistant' && !row.error && row.request === r.request), false);
});
test('HTTP current-setting path saves an empty model and sends through the fake without listing or switching models', async () => {
  fs.writeFileSync(path.join(location, 'fake.json'), JSON.stringify({ modelsError: { error: 'browser_error', message: '找不到 ChatGPT 的模型選單按鈕。' } }));
  const saved = await post('/api/webchat', { enabled: true, location, model: '', thinking: '' });
  assert.equal(saved.status, 200); assert.equal((await saved.json()).model, '');
  const view = await (await post('/api/webchat/models', {})).json();
  assert.equal(view.check.loggedIn, true); assert.equal(view.check.modelsError, 'webchat_remote_model_menu_unavailable');
  const before = fs.readFileSync(path.join(location, 'calls.jsonl'), 'utf8').trim().split('\n').length;
  const status = await (await post('/api/webchat/status', {})).json();
  assert.equal(status.check.loggedIn, true); assert.equal(status.check.modelsChecked, false);
  const response = await submit(); assert.equal(response.status, 200); const r = await response.json();
  await webchat.tail;
  assert.equal(webchat.jobs.find(j => j.request === r.request).state, 'done');
  const calls = fs.readFileSync(path.join(location, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).slice(before);
  assert.equal(calls.some(c => c.name === 'webchat_models'), false);
  const ask = calls.find(c => c.name === 'webchat_ask');
  assert.equal(Object.hasOwn(ask.arguments, 'model'), false); assert.equal(Object.hasOwn(ask.arguments, 'thinking'), false);
});
test('HTTP allows two consecutive conversation sends after done without login or settings changes',async()=>{
  fs.writeFileSync(path.join(location,'fake.json'),JSON.stringify({answers:[{answer:'連続送信の返信'}]}));
  const before=webchat.settings(), files=fs.readdirSync(path.join(pdir,'.ai/tasks'));
  const offset=fs.readFileSync(path.join(location,'calls.jsonl'),'utf8').trim().split('\n').length;
  const requests=[];
  for(const text of ['1回目の依頼','2回目の依頼']) {
    const state=await (await fetch(base+'/api/state')).json();
    assert.equal(state.projects.find(p=>p.id==='P').tasks.find(t=>t.id==='t').webchatReason,'');
    const response=await submit({text});assert.equal(response.status,200);const r=await response.json();requests.push(r.request);
    assert.equal(r.task,'t');await webchat.tail;
    assert.equal(webchat.jobs.find(j=>j.request===r.request).state,'done');assert.equal(webchat.view().busy,false);
    const rows=require('../lib/chat').read(pdir,'t').filter(row=>row.request===r.request);
    assert.deepEqual(rows.map(row=>row.role),['user','assistant']);assert.equal(rows[0].text,text);assert.equal(rows[1].text,'連続送信の返信');
  }
  assert.notEqual(requests[0],requests[1]);assert.deepEqual(webchat.settings(),before);assert.deepEqual(fs.readdirSync(path.join(pdir,'.ai/tasks')),files);
  const calls=fs.readFileSync(path.join(location,'calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse).slice(offset);
  assert.equal(calls.filter(c=>c.name==='webchat_ask').length,2);assert.equal(calls.some(c=>['webchat_login','webchat_logout','webchat_models'].includes(c.name)),false);
});
test('HTTP send returns to the original conversation in dirty, non-Git, direct and freetalk locations without child preparation', async t => {
  const store = webchat.store, gitw = require('../lib/git');
  assert.equal((await post('/api/freetalk/ensure',{})).status,200);
  const prepare = gitw.prepare, recovery = gitw.recoveryTarget, childRequest = webchat.gpt.gptChildren.request;
  gitw.prepare = gitw.recoveryTarget = webchat.gpt.gptChildren.request = () => assert.fail('conversation must not prepare a child or inspect recovery Git');
  const events=[]; const emit=chats.emit; chats.emit=(p,t,e)=>{events.push({p,t,e});return emit.call(chats,p,t,e);};
  try {
    for (const kind of ['dirty','nonGit','direct','freetalk']) await t.test(kind,async()=>{
      const id = kind === 'freetalk' ? 'freetalk' : 'case-'+kind, dir=path.join(root,'Product',id);
      const target=kind==='nonGit'||kind==='freetalk'?path.join(root,'nongit-'+kind):body;
      fs.mkdirSync(target,{recursive:true}); fs.mkdirSync(path.join(dir,'.ai/tasks'),{recursive:true});
      if(kind!=='freetalk')fs.writeFileSync(path.join(dir,'PROJECT.md'),`---\nname: ${id}\nfolders:\n  本体: ${target}\n---\n`);
      if(kind==='dirty')fs.writeFileSync(path.join(body,'main.txt'),'unsaved body');
      if(kind==='direct')git('config','hub.mode','direct');
      const file=path.join(dir,'.ai/tasks/conversation.md');
      fs.writeFileSync(file,`---\nid: conversation\ntitle: ${kind} chat\nstate: 未着手\nowner: codex\nworkspaceMode: ${kind==='direct'||kind==='freetalk'?'direct':'isolated'}\nworkdir: ${target}\n---\n`);
      const before=fs.readFileSync(file,'utf8'), bodyBefore=fs.readFileSync(path.join(body,'main.txt'),'utf8');
      const own=require('../lib/chat'); own.append(dir,'conversation',{role:'user',text:'SAME-TOPIC'});
      own.append(pdir,'queued',{role:'user',text:'FOREIGN-TOPIC'});
      fs.writeFileSync(path.join(location,'fake.json'),JSON.stringify({answers:[{answer:'同じ会話への返事 '+kind}]}));
      const response=await submit({project:id,task:'conversation',text:'test '+kind});assert.equal(response.status,200);
      const r=await response.json();assert.equal(r.task,'conversation');assert.equal(r.child,undefined);
      await webchat.tail;assert.equal(webchat.jobs.find(j=>j.request===r.request).state,'done');
      const rows=own.read(dir,'conversation').filter(x=>x.request===r.request);
      assert.deepEqual(rows.map(x=>x.role),['user','assistant']);assert.equal(rows[1].text,'同じ会話への返事 '+kind);
      assert.ok(events.some(x=>x.p===id&&x.t==='conversation'&&x.e.type==='row'&&x.e.row.role==='assistant'));
      assert.deepEqual(fs.readdirSync(path.join(dir,'.ai/tasks')),['conversation.md']);assert.equal(fs.readFileSync(file,'utf8'),before);
      assert.equal(fs.readFileSync(path.join(body,'main.txt'),'utf8'),bodyBefore);assert.equal(fs.existsSync(path.join(root,'Work',id)),false);
      const calls=fs.readFileSync(path.join(location,'calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
      const prompt=calls.filter(c=>c.name==='webchat_ask').at(-1).arguments.prompt;
      assert.match(prompt,/SAME-TOPIC/);assert.doesNotMatch(prompt,/FOREIGN-TOPIC/);
      assert.equal(store.readProject(id).tasks.length,1);
    });
  } finally {gitw.prepare=prepare;gitw.recoveryTarget=recovery;webchat.gpt.gptChildren.request=childRequest;chats.emit=emit;git('config','--unset','hub.mode');fs.writeFileSync(path.join(body,'main.txt'),'body');}
});
test('known challenge is visible before send and rejects input without a new job or user row', async()=>{
  fs.writeFileSync(path.join(location,'fake.json'),JSON.stringify({challenge:true}));
  const check=await (await post('/api/webchat/status',{})).json();assert.equal(check.check.statusError,'webchat_remote_challenge_required');
  const state=await (await fetch(base+'/api/state')).json(),task=state.projects.find(p=>p.id==='P').tasks.find(t=>t.id==='t');
  assert.equal(task.webchatReason,'webchat_remote_challenge_required');
  const count=webchat.jobs.length,rows=require('../lib/chat').read(pdir,'t').length;
  const r=await submit();assert.equal(r.status,409);const error=await r.json();assert.equal(error.code,'webchat_remote_challenge_required');assert.match(error.error,/人間確認/);
  assert.equal(webchat.jobs.length,count);assert.equal(require('../lib/chat').read(pdir,'t').length,rows);
  fs.writeFileSync(path.join(location,'fake.json'),JSON.stringify({}));await post('/api/webchat/status',{});
});
test('active stream/stop share the same conversation; an uncertain stop never dispatches a saved delegation',async()=>{
  fs.writeFileSync(path.join(location,'fake.json'),JSON.stringify({answers:[{delay:2000,answer:'late'}]}));
  const r=await (await submit()).json();while(!webchat.jobs.find(j=>j.request===r.request).sent)await new Promise(r=>setTimeout(r,10));
  const ac=new AbortController();const stream=await fetch(base+'/api/chat/stream?project=P&task=t',{signal:ac.signal});
  const first=new TextDecoder().decode((await stream.body.getReader().read()).value);ac.abort();
  assert.match(first,/"webchat":true/);assert.match(first,/"busy"/);
  const old=chats.sendQueued;let dispatched=0;chats.sendQueued=async()=>{dispatched++;assert.fail('uncertain stop must not start delegation');};
  try{chats.enqueue('P','t',{id:'after-stop',ai:'codex',model:'gpt-6.1-sol',text:'keep queued'});
    assert.equal((await post('/api/chat/stop',{project:'P',task:'t'})).status,200);await webchat.tail;
    const job=webchat.jobs.find(j=>j.request===r.request);assert.equal(job.state,'unknown');assert.equal(job.error,'webchat_stopped');
    assert.equal(dispatched,0);assert.equal(chats.queue('P','t').length,1);
    assert.equal(require('../lib/chat').read(pdir,'t').filter(x=>x.request===r.request&&x.role==='assistant').length,1);
  }finally{chats.sendQueued=old;chats.unqueue('P','t','after-stop');}
});
test('successful conversation dispatches a waiting delegation only after closing transport with fresh work location',async()=>{
  // The preceding uncertain-stop case deliberately leaves a durable pause.
  // A separate successful-conversation case needs the person's explicit resume.
  assert.equal((await post('/api/ai/resume',{confirm:true})).status,200);
  fs.writeFileSync(path.join(location,'fake.json'),JSON.stringify({answers:[{delay:250,answer:'reply before delegate'}]}));
  const old=chats.sendQueued;const called=[];chats.sendQueued=async o=>{assert.equal(webchat.current,null);assert.equal(webchat.client,null);assert.equal(o.dir,undefined);called.push(o);return {started:Promise.resolve(true)};};
  try{const r=await (await submit()).json();chats.enqueue('P','t',{id:'after-done',ai:'claude',model:'claude-opus-5-5',text:'next'});await webchat.tail;
    assert.equal(webchat.jobs.find(j=>j.request===r.request).state,'done');assert.equal(called.length,1);assert.equal(called[0].task,'t');assert.equal(chats.queue('P','t').length,0);
  }finally{chats.sendQueued=old;chats.unqueue('P','t','after-done');}
});
test('conversation questions are recorded and accepted without child state or a false failed-send response',async()=>{
  fs.writeFileSync(path.join(location,'fake.json'),JSON.stringify({answers:[{answer:'[[質問]]\nどちら？\n1. A\n2. B\n[[/質問]]'}]}));
  const r=await (await submit()).json();await webchat.tail;
  const store=webchat.store;assert.equal(store.readTask(store.taskFile('P','t')).question,'どちら？');
  const reply=await (await submit({text:'A',answerQuestion:'どちら？'})).json();assert.equal(reply.answeredQuestion,'どちら？');await webchat.tail;
  assert.equal(webchat.jobs.find(j=>j.request===r.request).state,'done');
});
test('freetalk history and lifecycle cannot replace a conversation during a Chat turn', async()=>{
  const file=webchat.store.taskFile('freetalk','conversation');
  fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('id: conversation\n','id: conversation\nfreetalk: true\n'));
  fs.writeFileSync(path.join(location,'fake.json'),JSON.stringify({answers:[{delay:60000,answer:'late topic reply'}]}));
  const r=await (await submit({project:'freetalk',task:'conversation'})).json();
  while(!webchat.jobs.find(j=>j.request===r.request).sent)await new Promise(resolve=>setTimeout(resolve,10));
  try {
    for(const route of ['/api/freetalk/summary','/api/freetalk/rotate','/api/freetalk/delete']) {
      const response=await post(route,{project:'freetalk',task:'conversation',confirm:true});
      assert.equal(response.status,409);assert.match((await response.json()).error,/AIが作業中/);
    }
    const response=await fetch(base+'/api/freetalk/status?project=freetalk&task=conversation');
    assert.equal(response.status,200);const status=await response.json();
    assert.match(status.reason,/AIが作業中/);assert.equal(status.generation,1);
    assert.equal(fs.existsSync(file),true);
  } finally {webchat.stop('freetalk','conversation');await webchat.tail;}
});
test('restart-adopted AI in another topic does not block Chat through a shared-cwd guess; true owners remain exclusive',async()=>{
  const list=procwatch.list,ancestor=procwatch.hasAncestor;
  const key=chats.key('freetalk','foreign-owner'),ownKey=chats.key('freetalk','conversation');
  const supervised={pid:51001,supervisorPid:51002,safe:()=>true};
  chats.spoolRuns.add(supervised);chats.running.set(key,{ai:'codex',supervised:true,child:supervised});
  let pid=supervised.pid;
  procwatch.list=()=>[{pid,project:'freetalk',task:'conversation'}];
  procwatch.hasAncestor=(candidate,matches)=>candidate===51003&&matches(supervised.pid);
  fs.writeFileSync(path.join(location,'fake.json'),JSON.stringify({answers:[{answer:'another topic is independent'}]}));
  try {
    for(const candidate of [supervised.pid,51003]) {
      pid=candidate;const response=await submit({project:'freetalk',task:'conversation'});
      assert.equal(response.status,200);const r=await response.json();await webchat.tail;
      assert.equal(webchat.jobs.find(j=>j.request===r.request).state,'done');
    }
    pid=51999;
    let response=await submit({project:'freetalk',task:'conversation'});
    assert.equal(response.status,409);assert.equal((await response.json()).code,'webchat_task_busy');
    pid=supervised.pid;chats.running.set(ownKey,{ai:'codex'});
    response=await submit({project:'freetalk',task:'conversation'});
    assert.equal(response.status,409);assert.equal((await response.json()).code,'webchat_task_busy');
  }finally {procwatch.list=list;procwatch.hasAncestor=ancestor;chats.spoolRuns.delete(supervised);chats.running.delete(key);chats.running.delete(ownKey);}
});

test('new manual Chat submission after a safe normal stop runs only that turn and keeps older instructions held',async()=>{
  const control=require('../server').stopControl;
  assert.equal((await post('/api/ai/resume',{confirm:true})).status,200);
  fs.writeFileSync(path.join(location,'fake.json'),JSON.stringify({answers:[{answer:'manual resumed chat'}]}));
  chats.enqueue('P','t',{id:'held-before-stop',ai:'codex',model:'gpt-6.1-sol',text:'original held text'});
  assert.equal((await post('/api/chat/stop',{project:'P',task:'t'})).status,200);
  const r=await submit({manualStopTicket:control.ticket({project:'P',task:'t'})});assert.equal(r.status,200,JSON.stringify(await r.clone().json()));
  const j=await r.json();await webchat.tail;assert.equal(webchat.jobs.find(x=>x.request===j.request).state,'done');
  assert.equal(chats.queue('P','t').find(q=>q.id==='held-before-stop').stopHeld,true);assert.ok(control.held({project:'P',task:'t'}));
  chats.unqueue('P','t','held-before-stop');
});
