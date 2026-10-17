'use strict';
process.env.HUB_LANG = 'ja';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const chat = require('../lib/chat');
const launch = require('../lib/launch');
const { capacityRoute, limitIdentity } = require('../lib/limit-route');
const { StopControl } = require('../lib/stop-control');
const CAPACITY = 'Selected model is at capacity. Please try a different model.';
launch.setDiscoveredModels({ codex: { models: [
  { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }, { id: 'gpt-6-astra', label: 'GPT-6-Astra' }
] } });
const source = { ai: 'codex', model: 'GPT-6.1-Sol', role: 'コーディング', text: '残りを続ける' };
function config(ai = 'claude-code', model = 'Opus 5.5') {
  return { switch: { auto: true }, roles: [{ name: 'コーディング',
    main: { ai: 'codex', model: 'GPT-6.1-Sol' }, backup: { ai, model, effort: '高' } }] };
}
const hasCapacity = (ai, o) => chat.parse(ai, o).some(e => e.kind === 'capacity');
test('Codexの正式な構造と完全なcapacity文だけを認識し、quotaにはしない', () => {
  for (const o of [{ type: 'error', message: CAPACITY }, { type: 'turn.failed', error: { message: CAPACITY } }]) {
    assert.equal(hasCapacity('codex', o), true);
    assert.equal(chat.parse('codex', o).some(e => e.kind === 'limit'), false);
  }
  for (const o of [
    { type: 'item.completed', item: { type: 'agent_message', text: CAPACITY } },
    { type: 'item.completed', item: { type: 'error', message: CAPACITY } },
    { type: 'result', is_error: true, result: CAPACITY },
    { type: 'error', message: 'Quoted: ' + CAPACITY },
    { type: 'error', message: 'Too many requests' },
    { type: 'turn.failed', error: { message: 'network error' } },
    { type: 'error', message: "You've hit your usage limit." }
  ]) assert.equal(hasCapacity('codex', o), false);
  assert.equal(hasCapacity('claude', { type: 'error', message: CAPACITY }), false);
});
test('設定したOpus5.5かAstraだけに交代し、既定や設定を変えない', () => {
  for (const [ai, model, flag] of [['claude-code', 'Opus 5.5', 'claude-opus-5-5'], ['codex', 'GPT-6-Astra', 'gpt-6-astra']]) {
    const data = config(ai, model), before = JSON.stringify(data);
    const target = capacityRoute(data, source);
    assert.equal(target.requiredModel, flag); assert.equal(target.effort, '高');
    assert.equal(JSON.stringify(data), before);
  }
  const data = config(); data.roles[0] = { ...data.roles[0], name: '調査', main: data.roles[0].backup, backup: data.roles[0].main };
  assert.equal(capacityRoute(data, { ...source, role: '調査', limitSlot: 'backup' }).requiredModel, 'claude-opus-5-5');
  assert.equal(capacityRoute({ ...config(), switch: { auto: false } }, source), null);
  for (const [ai, model] of [['claude-code', 'Fable 5.1'], ['codex', 'GPT-6.1-Sol'], ['agy', 'Gemini']]) assert.equal(capacityRoute(config(ai, model), source), null);
  assert.equal(capacityRoute(config(), { ...source, role: '司令塔' }), null);
});
for (const restricted of ['limitSwitch', 'automation', 'readOnly', 'freshContext', 'discussionTurn', 'discussion', 'isolatedReview', 'selectionOnly', 'integrationReviewRequest', 'integrationAssignment', 'limitPolicy', 'resultsOrganize', 'resultsRecoveryHash']) {
  test(`${restricted}の専用担当・分離条件を自動で変更しない`, () => assert.equal(capacityRoute(config(), { ...source, [restricted]: true }), null));
}
async function until(fn) {
  const end = Date.now() + 10000;
  while (!fn() && Date.now() < end) await new Promise(r => setTimeout(r, 15));
  assert.ok(fn(), 'mock CLI did not settle');
}
function fixture({ astra = false, mode = 'capacity', supervised = false, auto = true, held = false, targetFails = false, barrier = false } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-capacity-')));
  const data = astra ? config('codex', 'GPT-6-Astra') : config(); data.switch.auto = auto;
  fs.writeFileSync(path.join(dir, 'source.cjs'), `#!${process.execPath}
const fs=require('node:fs'),out=o=>console.log(JSON.stringify(o)),cap=${JSON.stringify(CAPACITY)},mode=${JSON.stringify(mode)};
process.stdin.resume();process.stdin.on('end',()=>{
 fs.writeFileSync('source.pid',String(process.pid));fs.appendFileSync('source-effects','once\\n');
 out({type:'thread.started',thread_id:'source-session'});
 out({type:'item.completed',item:{type:'agent_message',text:'途中の変更を保存しました'}});
 out({type:'item.completed',item:{type:'file_change',changes:[{path:'source-effects'}]}});
 if(mode==='quote') {out({type:'item.completed',item:{type:'agent_message',text:cap}});out({type:'turn.completed'});return;}
 if(mode==='stderr'){process.stderr.write(cap);process.exitCode=1;return;}
 if(mode==='network'){out({type:'turn.failed',error:{message:'network failed'}});process.exitCode=1;return;}
 out({type:'error',message:cap});
 if(mode==='recovered'){out({type:'turn.completed'});return;}
 out({type:'turn.failed',error:{message:cap}});
 if(mode==='signal'){process.kill(process.pid,'SIGTERM');return;}
 if(mode==='hold'){setInterval(()=>{},1000);return;}
 setTimeout(()=>{fs.writeFileSync('source-exiting','1');process.exitCode=1;},50);
});
`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'backup.cjs'), `#!${process.execPath}
const fs=require('node:fs');let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
 let alive=true;try{process.kill(Number(fs.readFileSync('source.pid')),0);}catch(e){if(e.code==='ESRCH')alive=false;else throw e;}
 fs.appendFileSync('backups',JSON.stringify({input,args:process.argv.slice(2),alive,exiting:fs.existsSync('source-exiting')})+'\\n');
 const out=o=>console.log(JSON.stringify(o));
 if(${JSON.stringify(targetFails)}){
  const error=${JSON.stringify(targetFails === 'quota' ? "You've hit your usage limit." : targetFails === 'network' ? 'network failed' : CAPACITY)};
  if(${JSON.stringify(astra)})out({type:'turn.failed',error:{message:error}});
  else out({type:'result',is_error:true,result:error});
  process.exitCode=1;return;
 }
 if(${JSON.stringify(astra)}){out({type:'item.completed',item:{type:'agent_message',text:'continued'}});out({type:'turn.completed'});}
 else{out({type:'assistant',message:{content:[{type:'text',text:'continued'}]}});out({type:'result',is_error:false,result:''});}
});
`, { mode: 0o755 });
  const stopControl = new StopControl({ dir: path.join(dir, 'stop') });
  const limits = [], calls = [];
  const runner = new chat.ChatRunner({ dirOf: () => dir, stopControl,
    spoolRoot: supervised ? path.join(dir, 'spool') : undefined,
    limitIdentity: o => limitIdentity(data, o),
    capacityBackup: o => { calls.push(o); const target = capacityRoute(data, o); return target && { ...target, perm: './backup.cjs' }; },
    limitBackup: () => { throw Error('A capacity successor must never start another fallback'); },
    onLimit: o => limits.push(o), limitPreflight: o => held && o.limitSwitch ? { hold: true } : null,
    limitTarget: o => held && o.limitSwitch ? { hold: true } : null,
    startBarrier: o => { if (barrier && o.limitSwitch) throw Error('保存・終了を確認できません'); }
  });
  const o = { ...source, project: 'p', task: 't', dir, pdir: dir, request: 'original', perm: './source.cjs' };
  const rows = () => chat.read(dir, 't');
  const backups = () => fs.existsSync(path.join(dir, 'backups')) ? fs.readFileSync(path.join(dir, 'backups'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  const idle = () => !runner.busy('p', 't') && rows().some(x => x.role === 'assistant');
  async function clean() {
    const run = runner.busy('p', 't'); if (run) { runner.stop('p', 't'); await until(() => !runner.busy('p', 't')); }
    for (const c of runner.spoolRuns) c.pause();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { dir, data, runner, o, rows, backups, limits, calls, stopControl, idle, clean };
}
for (const supervised of [false, true]) for (const astra of [false, true]) {
  test(`終了・保存後に${astra ? 'Astra' : 'Opus5.5'}へ一度だけ引継ぎ（supervised=${supervised}）`, async () => {
    const f = fixture({ astra, supervised });
    try {
      const r = f.runner.send(f.o); assert.equal(await r.started, true);
      const old = f.runner.busy('p', 't');
      await until(() => f.backups().length === 1 && f.idle());
      const b = f.backups()[0]; assert.equal(b.alive, false); assert.equal(b.exiting, true);
      assert.equal(b.args[b.args.indexOf('--model') + 1], astra ? 'gpt-6-astra' : 'claude-opus-5-5');
      assert.match(b.input, /モデル混雑/); assert.match(b.input, /済んだ部分と委任は繰り返さず/);
      assert.match(b.input, /道具：1件/); assert.doesNotMatch(b.input, /前の番は何もしていない/);
      assert.equal(fs.readFileSync(path.join(f.dir, 'source-effects'), 'utf8'), 'once\n');
      assert.equal(f.limits.length, 0); assert.equal(f.stopControl.held(f.o), false);
      assert.equal(f.rows().filter(r => r.role === 'event' && r.limitSwitch?.reason === 'capacity').length, 1);
      assert.deepEqual(f.runner.queue('p', 't'), []);
      old.child.emit('close', 1); const again = f.runner.send(f.o); assert.equal(again.ai, astra ? 'codex' : 'claude');
      assert.equal(f.backups().length, 1); assert.equal(f.runner.busy('p', 't'), null);
      if (supervised) assert.ok(require('../lib/cli-spool').read(old.child.dir, 'finished-confirmed.json'));
    } finally { await f.clean(); }
  });
}
for (const mode of ['quote', 'stderr', 'network', 'recovered', 'signal']) {
  test(`${mode}では自動交代や上限保持を行わない`, async () => {
    const f = fixture({ mode });
    try { f.runner.send(f.o); await until(f.idle); assert.equal(f.backups().length, 0); assert.equal(f.calls.length, 0); assert.equal(f.limits.length, 0); }
    finally { await f.clean(); }
  });
}
test('まだ生きているCLIを混雑で強制終了・並行起動しない', async () => {
  const f = fixture({ mode: 'hold', supervised: true });
  try {
    f.runner.send(f.o); await until(() => f.runner.busy('p', 't')?.capacity);
    assert.equal(f.backups().length, 0); assert.equal(f.calls.length, 0);
    await f.runner.stop('p', 't'); await until(f.idle); assert.equal(f.backups().length, 0);
  } finally { await f.clean(); }
});
test('正式失敗の保存時に人が停止したら交代も後続も始めず保留を維持', async () => {
  const f = fixture();
  f.runner.watch('p', 't', ev => { if (ev.type === 'row' && ev.row.role === 'assistant') f.stopControl.pause(f.o); });
  try {
    f.runner.send(f.o); f.runner.enqueue('p', 't', { id: 'later', ai: 'codex', model: 'GPT-6.1-Sol', text: 'later' });
    await until(f.idle); assert.equal(f.backups().length, 0); assert.equal(f.stopControl.held(f.o), true);
    assert.ok(f.runner.queue('p', 't').some(q => q.id === 'later'));
  } finally { await f.clean(); }
});
for (const options of [{ auto: false }, { held: true }, { barrier: true }, { astra: true, targetFails: true },
  { targetFails: 'quota' }, { astra: true, targetFails: 'quota' }, { targetFails: 'network' }]) {
  test(`${JSON.stringify(options)}では往復・連鎖せず後続を保持`, async () => {
    const f = fixture(options);
    try {
      f.runner.send(f.o); f.runner.enqueue('p', 't', { id: 'later', ai: 'codex', model: 'GPT-6.1-Sol', text: 'later' });
      await until(f.idle); assert.equal(f.backups().length, options.targetFails ? 1 : 0);
      assert.ok(f.runner.queue('p', 't').some(q => q.id === 'later'));
      assert.equal(f.limits.length, options.targetFails === 'quota' ? 1 : 0);
      assert.equal(f.calls.length, 1);
      assert.equal(fs.readFileSync(path.join(f.dir, 'source-effects'), 'utf8'), 'once\n');
      assert.equal(f.rows().some(r => /A capacity successor must never/.test(r.text || '')), false);
    } finally { await f.clean(); }
  });
}
test('引継ぎキュー保存失敗は後続を始めず原エラーと作業を残す', async () => {
  const f = fixture(); const save = f.runner.setQueue.bind(f.runner);
  f.runner.setQueue = (p, t, q, ...args) => { if (q.some(x => x.limitSwitch?.reason === 'capacity')) throw Error('fixture queue write denied'); return save(p, t, q, ...args); };
  try {
    f.runner.send(f.o); f.runner.enqueue('p', 't', { id: 'later', ai: 'codex', model: 'GPT-6.1-Sol', text: 'later' });
    await until(f.idle); assert.equal(f.backups().length, 0); assert.equal(f.runner.queue('p', 't')[0].id, 'later');
    assert.ok(f.rows().some(r => /引き継ぎを保存できませんでした/.test(r.text))); assert.equal(f.rows().find(r => r.role === 'assistant').error, CAPACITY);
  } finally { await f.clean(); }
});
