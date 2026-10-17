'use strict';
process.env.HUB_LANG = 'ja';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const chat = require('../lib/chat');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-capacity-http-')));
const root = path.join(tmp, 'root'), dir = path.join(root, 'Product', 'Fixture'), bin = path.join(tmp, 'bin');
const rolesFile = path.join(root, '_hub/roles.yaml'), launches = path.join(tmp, 'launches.jsonl');
const capacity = 'Selected model is at capacity. Please try a different model.';
let runtime, base;
const sha = f => fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : null;
function config(auto = true) {
  fs.writeFileSync(rolesFile, `models:\n  claude-code: [Opus 5.5]\n  codex: [GPT-6.1-Sol, GPT-6-Astra]\nroles:\n  コーディング: { main: [codex, GPT-6.1-Sol, 高], backup: [claude-code, Opus 5.5, 高] }\nswitch:\n  auto: ${auto}\n`);
}
async function until(fn) {
  const end = Date.now() + 12000;
  while (!fn() && Date.now() < end) await new Promise(r => setTimeout(r, 20));
  assert.ok(fn(), 'HTTP mock turn did not settle');
}
const rows = id => chat.read(dir, id);
const calls = () => fs.existsSync(launches) ? fs.readFileSync(launches, 'utf8').trim().split('\n').map(JSON.parse) : [];
test.before(async () => {
  fs.mkdirSync(path.join(root, '_hub'), { recursive: true }); fs.mkdirSync(path.join(dir, '.ai/tasks'), { recursive: true }); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(root, '_hub/ai-tools-models.json'), JSON.stringify({ codex: { models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }, { id: 'gpt-6-astra', label: 'GPT-6-Astra' }] } }));
  config(); fs.writeFileSync(path.join(dir, 'PROJECT.md'), '---\nname: Fixture\nstatus: 進行中\nphases: []\nfolders: {}\nrelated: []\n---\n');
  for (const ai of ['codex', 'claude']) fs.writeFileSync(path.join(bin, ai), `#!${process.execPath}
if(!process.argv.includes('--json')&&!process.argv.includes('--output-format')){console.log('mock cli');process.exit(0);}
const fs=require('node:fs'),out=o=>console.log(JSON.stringify(o));let input='';
process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
 fs.appendFileSync(${JSON.stringify(launches)},JSON.stringify({ai:${JSON.stringify(ai)},args:process.argv.slice(2),input})+'\\n');
 if(${JSON.stringify(ai)}==='codex'){
  out({type:'item.completed',item:{type:'agent_message',text:'途中の作業は保存済み'}});
  out({type:'error',message:${JSON.stringify(capacity)}});out({type:'turn.failed',error:{message:${JSON.stringify(capacity)}}});process.exitCode=1;
 }else{out({type:'assistant',message:{content:[{type:'text',text:'引き継いで完了'}]}});out({type:'result',is_error:false,result:''});}
});
`, { mode: 0o755 });
  // The request origin guard must know the actual listening port before server.js loads.
  const probe = require('node:net').createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port; await new Promise(r => probe.close(r));
  Object.assign(process.env, { PATH: bin + ':/usr/bin:/bin', HUB_ROOT: root, HUB_PORT: String(port), HUB_DRY_RUN: '1', HUB_AI_HOME: path.join(tmp, 'home'), HUB_TRASH: path.join(tmp, 'trash') });
  runtime = require('../server'); await new Promise(r => runtime.server.listen(port, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + runtime.server.address().port;
});
test.after(async () => {
  if (runtime) { runtime.sessions.stopAll(); runtime.stopControl.cleanExit(); await new Promise(r => runtime.server.close(r)); }
  fs.rmSync(tmp, { recursive: true, force: true });
});
async function send(id) {
  fs.writeFileSync(path.join(dir, '.ai/tasks', id + '.md'), `---\nid: ${id}\ntitle: Fixture\nrole: コーディング\nowner: codex\nmodel: GPT-6.1-Sol\nworkspaceMode: direct\nstate: 実行中\n---\n## 手順\n- [ ] 元の依頼の残り\n`);
  const r = await fetch(base + '/api/chat/send', { method: 'POST', headers: { 'X-Hub': '1', 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify({ project: 'Fixture', task: id, ai: 'codex', model: 'GPT-6.1-Sol', text: '残りだけ続ける' }) });
  const body = await r.json(); assert.equal(r.status, 200, JSON.stringify(body));
}
test('実HTTPの混雑停止から設定済みOpusへ一回引継ぎ、利用上限・設定・手順を変更しない', async () => {
  const rolesBefore = sha(rolesFile), limits = path.join(root, '_hub/limits.json'), limitsBefore = sha(limits);
  await send('one');
  await until(() => rows('one').filter(r => r.role === 'assistant').length === 2);
  const all = calls(); assert.deepEqual(all.map(x => x.ai), ['codex', 'claude']);
  assert.equal(all[1].args[all[1].args.indexOf('--model') + 1], 'claude-opus-5-5');
  assert.match(all[1].input, /モデル混雑/); assert.match(all[1].input, /繰り返さず/);
  assert.equal(rows('one').filter(r => r.role === 'assistant')[0].error, capacity);
  assert.equal(rows('one').filter(r => r.role === 'assistant')[1].error, '');
  assert.equal(sha(rolesFile), rolesBefore); assert.equal(sha(limits), limitsBefore);
  assert.match(fs.readFileSync(path.join(dir, '.ai/tasks/one.md'), 'utf8'), /- \[ \] 元の依頼の残り/);
  assert.equal(runtime.stopControl.held({ project: 'Fixture', task: 'one' }), false);
});
test('自動交代OFFはHTTPでも別AIへ送らず、正式な混雑停止を残す', async () => {
  config(false); await send('off');
  await until(() => rows('off').some(r => r.role === 'event' && /待機します/.test(r.text)));
  assert.deepEqual(calls().map(x => x.ai), ['codex', 'claude', 'codex']);
  assert.equal(rows('off').filter(r => r.role === 'assistant').length, 1);
});
