'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const chat = require('../lib/chat');
const other={id:'gemini-current',label:'Current Gemini'};
const AGY_MODEL = { id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)' };

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-agy-api-')));
const root = path.join(tmp, 'workspace');
const bin = path.join(tmp, 'bin');
const port = 47000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const taskDir = path.join(root, 'Product', 'サンプルアプリ');
let server, sessions;
const key = { project: 'サンプルアプリ', task: 'sample-app-01' };
const post = (url, body = {}) => fetch(base + url, { method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Hub': '1' }, body: JSON.stringify({ ...key, ...body }) });
const rows = () => chat.read(taskDir, key.task);
async function reply(n) {
  for (let i = 0; i < 100 && rows().filter(x => x.role === 'assistant').length < n; i++)
    await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(rows().filter(x => x.role === 'assistant').length, n);
  return rows().filter(x => x.role === 'assistant').at(-1);
}

test.before(async () => {
  execFileSync('bash', [path.join(__dirname, '../setup.sh')], {
    env: { ...process.env, HUB_ROOT: root, HOME: tmp, HUB_SKIP_NPM: '1' }, stdio: 'ignore' });
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'agy'), `#!${process.execPath}
const args=process.argv.slice(2), print=args.find(x=>x.startsWith('--print='));
if(args.includes('--version')){console.log('1.2.14');process.exit(0);}
if(args.includes('models')){process.stdout.write(require('fs').readFileSync(${JSON.stringify(path.join(tmp,'models.tsv'))},'utf8'));process.exit(0);}
if(!print){console.log('PTY_AGY_READY');process.stdin.on('data',d=>process.stdout.write(d));setInterval(()=>{},1000);}
else {
const out=x=>console.log(JSON.stringify(x));
out({event:'init',conversation_id:'agy-route-session',init:{model:args[args.indexOf('--model')+1]}});
if(print.endsWith('WAIT'))setInterval(()=>{},1000);
else {const text=JSON.stringify(args);out({event:'result',result:{status:'SUCCESS',response:text}});}
}
`, { mode: 0o755 });
  fs.writeFileSync(path.join(tmp,'models.tsv'),AGY_MODEL.id+'\t'+AGY_MODEL.label);
  fs.writeFileSync(path.join(root, '_hub/ai-tools-models.json'), JSON.stringify({
    agy: { models: [AGY_MODEL], known: [AGY_MODEL], refreshedAt: new Date().toISOString(), source: 'fixture' } }));
  process.env.PATH = bin + path.delimiter + process.env.PATH;
  process.env.HUB_ROOT = root;
  process.env.HUB_PORT = String(port);
  process.env.HUB_DRY_RUN = '1';
  process.env.HUB_AI_HOME = path.join(tmp, 'ai-home');
  ({ server, sessions } = require('../server'));
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
});
test.afterEach(async () => {
  // A scoped stop remains held by design. Each fixture case starts explicitly fresh.
  if (require('../server').stopControl.held(key))
    assert.equal((await post('/api/ai/resume', { confirm: true })).status, 200);
});
test.after(async () => {
  if (server?.listening) await post('/api/chat/stop');
  sessions?.stopAll();
  if (server) await new Promise(resolve => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('Agy manual routes pin High while keeping the existing role assignment', async () => {
  const state = await (await fetch(base + '/api/state')).json();
  assert.equal(state.agyAvailable, true);
  assert.deepEqual(state.roles.models.agy, [AGY_MODEL.label]);
  assert.equal(state.roles.roles.find(x => x.name === 'コーディング').main.ai, 'codex');
  const response = await post('/api/term/start', { ai: 'agy', model:AGY_MODEL.label });
  const started = await response.json(); assert.equal(response.status, 200, started.error);
  assert.equal(started.command, 'agy');
  assert.equal(started.model, AGY_MODEL.label);
  assert.equal(started.effort, '高');
  assert.ok(started.args.includes(AGY_MODEL.id));
  assert.ok(started.args.some(x => x.startsWith('--prompt-interactive=')));
  const external = await (await post('/api/continue', { ai: 'agy', model:AGY_MODEL.label })).json();
  assert.ok(external.command.includes("env '-u' 'GEMINI_API_KEY'"));
  assert.equal((await post('/api/term/switch', { ai: 'agy', field: 'model', value: 'other' })).status, 409);
  assert.equal((await post('/api/chat/send', { ai: 'agy', model: 'other', text: 'x' })).status, 409);
  assert.equal(rows().length, 0);
  assert.equal((await post('/api/term/handoff', { to: 'agy' })).status, 400);
  const handoff = await (await post('/api/term/handoff', { from: 'codex', to: 'agy', model:AGY_MODEL.label })).json();
  assert.equal(handoff.command, 'agy');
  assert.ok(handoff.args.includes(AGY_MODEL.id));
});

test('Agy chat routes use its conversation ID and stop the running child', async () => {
  const say = text => post('/api/chat/send', { ai: 'agy', model: AGY_MODEL.label, effort: 'Ultra', text });
  assert.equal((await say('first')).status, 200);
  let row = await reply(1);
  assert.equal(row.ai, 'agy');
  assert.equal(row.effort, '高');
  assert.ok(JSON.parse(row.text).includes(AGY_MODEL.id));
  assert.equal(chat.readMeta(taskDir, key.task).sessions.agy, 'agy-route-session');
  assert.equal((await say('second')).status, 200);
  row = await reply(2);
  assert.ok(JSON.parse(row.text).includes('--conversation'));
  assert.ok(JSON.parse(row.text).includes('agy-route-session'));
  assert.equal((await say('WAIT')).status, 200);
  assert.equal((await post('/api/ai-tools/models/refresh', { ai: 'agy' })).status, 409);
  const stopped = await (await post('/api/chat/stop')).json();
  assert.equal(stopped.ok, true);
  row = await reply(3);
  assert.equal(row.error, '止めました');
  const state = await (await fetch(base + '/api/state')).json();
  assert.ok(!state.sessions.some(x => x.ai === 'agy' && x.running));
});

test('Agy PTY can run beside both existing providers and hand off its own screen', async () => {
  if (!sessions.available()) return;
  const env = { PATH: bin + ':/usr/bin:/bin', GEMINI_API_KEY: 'fixture-secret' };
  const common = { project: key.project, task: key.task, dir: root, env };
  sessions.start({ ...common, ai: 'agy', command: 'agy', args: [] });
  for (const ai of ['claude', 'codex']) sessions.start({ ...common, ai, command: '/bin/cat', args: [] });
  try {
    assert.equal(sessions.list().filter(x => x.running).length, 3);
    for (let i = 0; i < 50 && !sessions.get(key.project, key.task, 'agy').buf.includes('PTY_AGY_READY'); i++)
      await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(sessions.get(key.project, key.task, 'agy').buf.includes('PTY_AGY_READY'));
    const streamAbort=new AbortController(),streamTimeout=setTimeout(()=>streamAbort.abort(),5000);
    try {
      const stream=await fetch(base+'/api/term/stream?'+new URLSearchParams({...key,ai:'agy'}),{signal:streamAbort.signal});
      assert.equal(stream.status,200);
      const {value}=await stream.body.getReader().read();
      assert.match(new TextDecoder().decode(value),/PTY_AGY_READY/);
    } finally {clearTimeout(streamTimeout);streamAbort.abort();}
    sessions.get(key.project, key.task, 'codex').lastOut = 0;
    const handoff = await post('/api/term/handoff', { from: 'agy', to: 'codex' });
    assert.equal(handoff.status, 200);
    const data = await handoff.json();
    assert.equal(data.kind, 'screen');
    assert.ok(fs.readFileSync(data.packet, 'utf8').includes('PTY_AGY_READY'));
    assert.equal((await post('/api/ai-tools/models/refresh', { ai: 'agy' })).status, 409);
    const result = await (await post('/api/term/stop', { ai: 'agy' })).json();
    assert.equal(result.ok, true);
    assert.ok(!sessions.list().some(x => x.ai === 'agy' && x.running));
  } finally { sessions.stopAll(); }
});

test('saved Gemini roles generate policy, delegation examples and both integration delegates', async () => {
  const roleFile = path.join(root, '_hub/roles.yaml'), original = fs.readFileSync(roleFile, 'utf8');
  const {TaskIntegrate} = require('../lib/task-integrate'), savedResults = TaskIntegrate.prototype.resultsRequest, savedConflict = TaskIntegrate.prototype.conflictRequest;
  try {
    const {roles:data} = await (await fetch(base+'/api/state')).json();
    for (const r of data.roles) if (['調査','コーディング','チェック','文章','デザイン'].includes(r.name)) r.main = {ai:'agy',model:AGY_MODEL.label,effort:'高'};
    const response = await post('/api/roles',{roles:data.roles}); assert.equal(response.status,200);
    const {Store}=require('../lib/store'), store=new Store(root), p=store.readProject(key.project), t=p.tasks.find(t=>t.id===key.task);
    const {taskPrompt}=require('../server'), prompt=taskPrompt(p,t,store.taskFile(p.id,t.id),taskDir);
    assert.match(prompt,/役割分担で Agy CLI が担当の役割/);
    assert.match(prompt,/"ai":"agy","model":"gemini-3.1-pro-high"/);
    const full=fs.readFileSync(path.join(taskDir,'.ai/chat',key.task+'.rules.md'),'utf8');
    assert.match(full,/チェックは ai: agy・model: gemini-3.1-pro-high/);
    assert.match(full,/同じ作業のagy・gemini-3.1-pro-highへ確認範囲/);
    assert.match(full,/要修正は同じ作業のagy・gemini-3.1-pro-highへ戻し/);
    // The integration request validation itself is covered by task-integrate tests.
    // Stub only its request builder to verify each HTTP route uses the saved primary role.
    for(const [route,method] of [['results','resultsRequest'],['resolve','conflictRequest']]) {
      TaskIntegrate.prototype[method]=()=>({...key,text:'Gemini integration fixture',title:'fixture'});
      const before=rows().filter(r=>r.role==='assistant').length;
      const res=await post('/api/task/integrate/'+route);const result=await res.json();assert.equal(res.status,200,result.error);
      assert.equal(result.model,AGY_MODEL.label);const replyRow=await reply(before+1);
      assert.equal(replyRow.ai,'agy');assert.equal(replyRow.effort,'高');assert.ok(JSON.parse(replyRow.text).includes(AGY_MODEL.id));
    }
  } finally {fs.writeFileSync(roleFile,original); TaskIntegrate.prototype.resultsRequest=savedResults;TaskIntegrate.prototype.conflictRequest=savedConflict;}
});


test('Agy missing default still exposes real models and requires a manual selection through every launch', async () => {
  const rolesFile=path.join(root,'_hub/roles.yaml'), original=fs.readFileSync(rolesFile,'utf8');
  require('../server').aiUpdates.accounts.dry=false;
  fs.writeFileSync(path.join(tmp,'models.tsv'),other.id+'\t'+other.label+'\n');
  const check=await fetch(base+'/api/accounts?status=1&ai=agy',{headers:{'X-Hub':'1'}});
  const auth=await check.json();assert.equal(auth.accounts.length,1);assert.equal(auth.accounts[0].status,'logged-in');
  const state=await (await fetch(base+'/api/state')).json();assert.equal(state.agyAvailable,true);assert.deepEqual(state.agyModels,[other]);
  const count=rows().length;
  for(const [route,body] of [['/api/term/start',{ai:'agy'}],['/api/continue',{ai:'agy'}],['/api/term/handoff',{from:'codex',to:'agy'}],['/api/chat/send',{ai:'agy',text:'blocked'}],['/api/chat/send',{ai:'agy',model:AGY_MODEL.id,text:'stale'}],['/api/chat/send',{ai:'agy',model:'evil;command',text:'invalid'}]]) {
    assert.equal((await post(route,body)).status,409);
  }
  assert.equal(rows().length,count);
  const started=await (await post('/api/term/start',{ai:'agy',model:other.id})).json();assert.equal(started.args[started.args.indexOf('--model')+1],other.id);
  const external=await (await post('/api/continue',{ai:'agy',model:other.id})).json();assert.ok(external.command.includes("'--model' '"+other.id+"'"));
  const handoff=await (await post('/api/term/handoff',{from:'codex',to:'agy',model:other.id})).json();assert.ok(handoff.args.includes(other.id));
  const before=rows().filter(r=>r.role==='assistant').length;
  const sent=await post('/api/chat/send',{ai:'agy',model:other.id,text:'manual choice'});assert.equal(sent.status,200,JSON.stringify(await sent.json()));
  const result=await reply(before+1);assert.equal(result.error,'');assert.ok(JSON.parse(result.text).includes(other.id));
  assert.equal(fs.readFileSync(rolesFile,'utf8'),original);
});

test('Agy chat and Terminal starts accept an open login Terminal but reject logout and account locks', async () => {
  const {aiUpdates,chats} = require('../server'), accounts = aiUpdates.accounts;
  fs.mkdirSync(accounts.termDir, {recursive:true});
  const marker = path.join(accounts.termDir, 'login-route-fixture.json');
  const baseRow = {ai:'agy',account:'default',kind:'auth',pid:process.pid};
  const request = {...key,account:'default'};
  try {
    for (const action of [undefined,'login']) {
      fs.writeFileSync(marker, JSON.stringify({...baseRow,...(action ? {authAction:action} : {})}));
      const beforeMarker = fs.readFileSync(marker,'utf8');
      assert.equal(chats.canStart('agy',other.label,request),'');
      for (const [route,body] of [
        ['/api/term/start',{ai:'agy',model:other.id}],
        ['/api/continue',{ai:'agy',model:other.id}],
        ['/api/term/handoff',{from:'codex',to:'agy',model:other.id}],
      ]) {
        const res = await post(route,body); const data = await res.json();
        assert.equal(res.status,200,data.error);
        assert.ok(route === '/api/continue' ? data.command.includes("'--model' '"+other.id+"'") : data.args.includes(other.id));
      }
      const before = rows().filter(r=>r.role==='assistant').length;
      const sent = await post('/api/chat/send',{ai:'agy',model:other.id,text:'fixture login terminal remains open'});
      assert.equal(sent.status,200,JSON.stringify(await sent.json()));
      const result = await reply(before+1); assert.equal(result.error,''); assert.ok(JSON.parse(result.text).includes(other.id));
      assert.equal(fs.readFileSync(marker,'utf8'),beforeMarker);
      assert.throws(()=>accounts.assertIdle('agy','default'));
    }
    for (const action of ['logout','unknown']) {
      fs.writeFileSync(marker,JSON.stringify({...baseRow,authAction:action}));
      assert.match(chats.canStart('agy',other.label,request),/処理中/);
      const before=rows().length;
      for (const [route,body] of [
        ['/api/chat/send',{ai:'agy',model:other.id,text:'blocked fixture'}],
        ['/api/term/start',{ai:'agy',model:other.id}],
        ['/api/continue',{ai:'agy',model:other.id}],
        ['/api/term/handoff',{from:'codex',to:'agy',model:other.id}],
      ]) assert.equal((await post(route,body)).status,409);
      assert.equal(rows().length,before);
    }
    fs.writeFileSync(marker,JSON.stringify({...baseRow,authAction:'login'}));
    accounts.locks.add('agy:default');
    assert.match(chats.canStart('agy',other.label,request),/処理中/);
    assert.equal((await post('/api/chat/send',{ai:'agy',model:other.id,text:'locked fixture'})).status,409);
  } finally { accounts.locks.delete('agy:default'); fs.unlinkSync(marker); }
});
