'use strict';
process.env.HUB_LANG = 'ja';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const chat = require('../lib/chat');
const launch = require('../lib/launch');
const { capacityRoute: policyRoute, limitRoute, limitIdentity } = require('../lib/limit-route');
const { StopControl } = require('../lib/stop-control');
const CAPACITY = 'Selected model is at capacity. Please try a different model.';
const currentModels = [
  { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }, { id: 'gpt-6-astra', label: 'GPT-6-Astra' }
];
launch.setDiscoveredModels({ codex: { models: currentModels } });
const capacityRoute = (data, o, options = {}) => policyRoute(data, o, { models: currentModels, available: () => true, ...options });
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
test('混雑は同系列のAstraだけに交代し、上限時の設定と既定を変えない', () => {
  for (const [ai, model] of [['claude-code', 'Opus 5.5'], ['codex', 'GPT-6-Astra']]) {
    const data = config(ai, model), before = JSON.stringify(data);
    const target = capacityRoute(data, source);
    assert.equal(target.requiredModel, 'gpt-6-astra'); assert.equal(target.effort, '高');
    assert.equal(JSON.stringify(data), before);
  }
  const data = config(); data.roles[0] = { ...data.roles[0], name: '調査', main: data.roles[0].backup, backup: data.roles[0].main };
  assert.equal(capacityRoute(data, { ...source, role: '調査', limitSlot: 'backup' }).requiredModel, 'gpt-6-astra');
  assert.equal(limitRoute(data, { ...source, role: '調査', limitSlot: 'backup' }).requiredModel, 'claude-opus-5-5');
  assert.equal(capacityRoute({ ...config(), switch: { auto: false } }, source), null);
  for (const [ai, model] of [['claude', 'Opus 5.5'], ['codex', '6luna'], ['agy', 'Gemini']]) assert.equal(capacityRoute(config(), { ...source, ai, model }), null);
  assert.equal(policyRoute(config(), source), null); // No catalog or positive quota proof.
  assert.equal(capacityRoute(config(), source, { available: () => false }), null);
  assert.equal(capacityRoute(config(), source, { available: () => 'true' }), null);
});
test('確認済み候補だけから新しいSol/Astraへ追従し、廃止済み・別系列・推測IDを使わない', () => {
  const models = [...currentModels,
    { id: 'gpt-6.2-sol', label: 'GPT-6.2-Sol' }, { id: 'gpt-6.10-sol', label: 'GPT-6.10-Sol' },
    { id: 'gpt-6.1-astra', label: 'GPT-6.1-Astra', efforts: ['中', '高', '極高'] },
    { id: 'gpt-9-luna', label: 'GPT-9-Luna' }];
  launch.setDiscoveredModels({ codex: { models, known: [...models, { id: 'gpt-9-astra', label: 'GPT-9-Astra' }] } });
  const proofs = [], available = (ids, account) => { proofs.push({ ids, account }); return true; };
  try {
    const target = capacityRoute(config(), { ...source, model: 'GPT-6.2-Sol', account: 'work' }, { models, available });
    assert.equal(target.requiredModel, 'gpt-6.1-astra');
    assert.deepEqual(proofs, [{ ids: ['gpt-6.2-sol', 'gpt-6.1-astra'], account: 'work' }]);
    const o = { ...source, model: 'GPT-6.1-Astra', limitSwitch: { reason: 'capacity', sourceAI: 'codex', sourceModel: 'GPT-6.2-Sol' } };
    const returned = capacityRoute(config(), o, { models });
    assert.equal(returned.requiredModel, 'gpt-6.10-sol');
    assert.equal(capacityRoute(config(), { ...o, model: 'GPT-6.10-Sol', limitSwitch: { ...o.limitSwitch, sourceModel: o.model } }, { models }), null);
    assert.equal(capacityRoute(config(), source, { models: models.filter(m => !m.id.endsWith('-astra')) }), null);
    assert.equal(capacityRoute(config(), source, { models: [{ id: 'gpt-6.2-astra', label: 'Unverified' }] }), null);
    assert.equal(capacityRoute(config(), { ...source, effort: '低' }, { models }), null); // No silent effort change or old-model fallback.
    launch.setOverrides({ codex: { 'GPT-6.1-Astra': '' } });
    assert.equal(capacityRoute(config(), source, { models: models.filter(m => m.id !== 'gpt-6-astra') }), null);
  } finally { launch.setOverrides({}); launch.setDiscoveredModels({ codex: { models: currentModels } }); }
});
test('Astra混雑は役割のmainを変えずSolへ。Sol欄が無ければ送信時の思考量を保持', () => {
  const data = { switch: { auto: true }, roles: [{ name: '司令塔',
    main: { ai: 'claude-code', model: 'Fable 5.1', effort: '高' },
    backup: { ai: 'codex', model: 'GPT-6-Astra', effort: '高' } }] };
  const o = { ...source, model: 'GPT-6-Astra', role: '司令塔', limitSlot: 'backup', effort: '極高' };
  const before = JSON.stringify(data), target = capacityRoute(data, o);
  assert.equal(target.requiredModel, 'gpt-6.1-sol'); assert.equal(target.requireModel, true);
  assert.equal(target.role, '司令塔'); assert.equal(target.effort, '極高');
  assert.equal(target.limitSlot, undefined); assert.equal(JSON.stringify(data), before);
  const saved = capacityRoute(config('codex', 'GPT-6-Astra'), { ...o, role: 'コーディング' });
  assert.equal(saved.limitSlot, 'main'); assert.equal(saved.effort, '極高');
  assert.equal(capacityRoute({ ...data, switch: { auto: false } }, o), null);
  launch.setOverrides({ codex: { 'GPT-6.1-Sol': '' } });
  try { assert.equal(capacityRoute(data, o), null); } finally { launch.setOverrides({}); }
});
test('Sol→Astraの正式混雑だけ一度Solへ戻し、そのSolからは再交代しない', () => {
  const data = config('codex', 'GPT-6-Astra'); data.roles[0].main.effort = '中';
  const o = { ...source, model: 'GPT-6-Astra', effort: '極高',
    limitSwitch: { reason: 'capacity', sourceAI: 'codex', sourceModel: 'GPT-6.1-Sol' } };
  const target = capacityRoute(data, o);
  assert.equal(target.requiredModel, 'gpt-6.1-sol'); assert.equal(target.effort, '中');
  assert.equal(capacityRoute(data, { ...o, model: 'GPT-6.1-Sol', limitSwitch: { reason: 'capacity', sourceAI: 'codex', sourceModel: 'GPT-6-Astra' } }), null);
  for (const limitSwitch of [{ reason: 'capacity', sourceAI: 'claude', sourceModel: 'Opus 5.5' },
    { reason: 'quota', sourceAI: 'codex', sourceModel: 'GPT-6.1-Sol' },
    { sourceAI: 'codex', sourceModel: 'GPT-6.1-Sol' }]) assert.equal(capacityRoute(data, { ...o, limitSwitch }), null);
});
for (const restricted of ['limitSwitch', 'automation', 'readOnly', 'freshContext', 'discussionTurn', 'discussion', 'isolatedReview', 'selectionOnly', 'integrationReviewRequest', 'integrationAssignment', 'limitPolicy', 'resultsOrganize', 'resultsRecoveryHash']) {
  test(`${restricted}の専用担当・分離条件を自動で変更しない`, () => {
    for (const model of ['GPT-6.1-Sol', 'GPT-6-Astra']) assert.equal(capacityRoute(config(), { ...source, model, [restricted]: true }), null);
  });
}
async function until(fn) {
  const end = Date.now() + 10000;
  while (!fn() && Date.now() < end) await new Promise(r => setTimeout(r, 15));
  assert.ok(fn(), 'mock CLI did not settle');
}
function fixture({ astra = false, sourceAstra = false, currentModel, models = currentModels, mode = 'capacity', supervised = false, auto = true, held = false, available = true, targetFails = false, returnFails = false, barrier = false, returnHeld = false } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-capacity-')));
  const data = sourceAstra ? { roles: [{ name: '司令塔', main: { ai: 'claude-code', model: 'Fable 5.1' },
    backup: { ai: 'codex', model: 'GPT-6-Astra', effort: '高' } }], switch: {} } : astra ? config('codex', 'GPT-6-Astra') : config(); data.switch.auto = auto;
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
 let alive=true;try{process.kill(Number(fs.readFileSync(fs.existsSync('backup.pid')?'backup.pid':'source.pid')),0);}catch(e){if(e.code==='ESRCH')alive=false;else throw e;}
 fs.writeFileSync('backup.pid',String(process.pid));
 fs.appendFileSync('backups',JSON.stringify({input,args:process.argv.slice(2),alive,exiting:fs.existsSync('source-exiting')})+'\\n');
 const out=o=>console.log(JSON.stringify(o));
 const returned=process.argv[process.argv.indexOf('--model')+1]==='gpt-6.1-sol';
 const failure=returned?${JSON.stringify(returnFails)}:${JSON.stringify(targetFails)};
 if(failure){
  const error=failure==='quota'?"You've hit your usage limit.":failure==='network'?'network failed':${JSON.stringify(CAPACITY)};
  out({type:'turn.failed',error:{message:error}});
  process.exitCode=1;return;
 }
 out({type:'item.completed',item:{type:'agent_message',text:'continued'}});out({type:'turn.completed'});
});
`, { mode: 0o755 });
  const stopControl = new StopControl({ dir: path.join(dir, 'stop') });
  const limits = [], calls = [];
  const runner = new chat.ChatRunner({ dirOf: () => dir, stopControl,
    spoolRoot: supervised ? path.join(dir, 'spool') : undefined,
    limitIdentity: o => limitIdentity(data, o),
    capacityBackup: o => { calls.push(o); const target = capacityRoute(data, o, { models, available: () => available }); return target && { ...target, perm: './backup.cjs' }; },
    limitBackup: () => { throw Error('A capacity successor must never start another fallback'); },
    onLimit: o => limits.push(o), limitPreflight: o => (held || returnHeld && o.request === 'capacity-capacity-original') && o.limitSwitch ? { hold: true } : null,
    limitTarget: o => held && o.limitSwitch ? { hold: true } : null,
    startBarrier: o => { if (barrier && o.limitSwitch) throw Error('保存・終了を確認できません'); }
  });
  const o = { ...source, ...(sourceAstra ? { model: 'GPT-6-Astra', role: '司令塔', effort: '極高' } : {}), project: 'p', task: 't', dir, pdir: dir, request: 'original', perm: './source.cjs' };
  if (currentModel) o.model = currentModel;
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
test('Sol/Astraの版更新後も確認済みの新IDが実CLI引数になり、元の設定を変えない', async () => {
  const models = [{ id: 'gpt-6.2-sol', label: 'GPT-6.2-Sol' }, { id: 'gpt-6.1-astra', label: 'GPT-6.1-Astra' }];
  launch.setDiscoveredModels({ codex: { models } });
  try {
    for (const sourceAstra of [false, true]) {
      const f = fixture({ sourceAstra, currentModel: models[sourceAstra ? 1 : 0].label, models });
      const before = JSON.stringify(f.data);
      try {
        const r = f.runner.send(f.o); assert.equal(await r.started, true);
        await until(() => f.backups().length === 1 && f.idle());
        const b = f.backups()[0];
        assert.equal(b.args[b.args.indexOf('--model') + 1], models[sourceAstra ? 0 : 1].id);
        assert.equal(b.alive, false); assert.equal(b.exiting, true);
        assert.equal(JSON.stringify(f.data), before);
      } finally { await f.clean(); }
    }
  } finally { launch.setDiscoveredModels({ codex: { models: currentModels } }); }
});
for (const supervised of [false, true]) for (const astra of [false, true]) {
  test(`終了・保存後にAstraへ一度だけ引継ぎ、上限交代先${astra ? 'Astra' : 'Opus5.5'}の設定を保持（supervised=${supervised}）`, async () => {
    const f = fixture({ astra, supervised });
    try {
      const r = f.runner.send(f.o); assert.equal(await r.started, true);
      const old = f.runner.busy('p', 't');
      await until(() => f.backups().length === 1 && f.idle());
      const b = f.backups()[0]; assert.equal(b.alive, false); assert.equal(b.exiting, true);
      assert.equal(b.args[b.args.indexOf('--model') + 1], 'gpt-6-astra');
      assert.match(b.input, /モデル混雑/); assert.match(b.input, /済んだ部分と委任は繰り返さず/);
      assert.match(b.input, /道具：1件/); assert.doesNotMatch(b.input, /前の番は何もしていない/);
      assert.equal(fs.readFileSync(path.join(f.dir, 'source-effects'), 'utf8'), 'once\n');
      assert.equal(f.limits.length, 0); assert.equal(f.stopControl.held(f.o), false);
      assert.equal(f.rows().filter(r => r.role === 'event' && r.limitSwitch?.reason === 'capacity').length, 1);
      assert.deepEqual(f.runner.queue('p', 't'), []);
      old.child.emit('close', 1); const again = f.runner.send(f.o); assert.equal(again.ai, 'codex');
      assert.equal(f.backups().length, 1); assert.equal(f.runner.busy('p', 't'), null);
      if (supervised) assert.ok(require('../lib/cli-spool').read(old.child.dir, 'finished-confirmed.json'));
    } finally { await f.clean(); }
  });
}
for (const supervised of [false, true]) for (const sourceAstra of [false, true]) {
  test(`${sourceAstra ? 'Astra→Sol' : 'Sol→Astra→Sol'}で保存済み操作を引き継ぎ、成功後の再送を重複実行しない（supervised=${supervised}）`, async () => {
    const f = fixture({ astra: true, sourceAstra, targetFails: true, supervised });
    const before = JSON.stringify(f.data), expected = sourceAstra ? 1 : 2;
    try {
      f.runner.send(f.o);
      await until(() => f.backups().length === expected && f.idle());
      const backups = f.backups(), last = backups.at(-1);
      assert.deepEqual(backups.map(b => b.args[b.args.indexOf('--model') + 1]), sourceAstra ? ['gpt-6.1-sol'] : ['gpt-6-astra', 'gpt-6.1-sol']);
      assert.ok(backups.every(b => b.alive === false && b.exiting === true));
      assert.match(last.input, /道具：1件/); assert.match(last.input, /済んだ部分と委任は繰り返さず/);
      if (sourceAstra) assert.ok(last.args.includes('model_reasoning_effort=xhigh'));
      assert.equal(fs.readFileSync(path.join(f.dir, 'source-effects'), 'utf8'), 'once\n');
      assert.equal(f.limits.length, 0); assert.equal(JSON.stringify(f.data), before);
      assert.equal(f.rows().filter(r => r.role === 'event' && r.limitSwitch?.reason === 'capacity').length, expected);
      assert.equal(f.rows().findLast(r => r.role === 'assistant').error, '');
      const again = f.runner.send(f.o);
      assert.equal(again.model, 'GPT-6.1-Sol'); assert.equal(f.runner.busy('p', 't'), null);
      assert.equal(f.backups().length, expected); assert.equal(f.calls.length, expected);
      assert.deepEqual(f.runner.queue('p', 't'), []);
    } finally { await f.clean(); }
  });
}
for (const sourceAstra of [false, true]) for (const mode of ['quote', 'stderr', 'network', 'recovered', 'signal']) {
  test(`${sourceAstra ? 'Astra' : 'Sol'}の${mode}では自動交代や上限保持を行わない`, async () => {
    const f = fixture({ mode, sourceAstra });
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
test('終了後の非同期残量確認中に停止したら、遅れて成功しても引継ぎを作らない', async () => {
  const f = fixture({ supervised: true }), route = f.runner.capacityBackup;
  let release, checking = false;
  f.runner.capacityBackup = async o => { checking = true; await new Promise(r => { release = r; }); return route(o); };
  try {
    f.runner.send(f.o); f.runner.enqueue('p', 't', { id: 'later', ai: 'codex', model: 'GPT-6.1-Sol', text: 'later' });
    await until(() => checking); f.runner.stop('p', 't'); release();
    await until(f.idle);
    assert.equal(f.backups().length, 0); assert.equal(f.stopControl.held(f.o), true);
    assert.ok(f.runner.queue('p', 't').some(q => q.id === 'later'));
    assert.equal(f.rows().some(r => r.role === 'event' && r.limitSwitch?.reason === 'capacity'), false);
  } finally { release?.(); await f.clean(); }
});
for (const options of [{ auto: false }, { available: false }, { sourceAstra: true, available: false }, { held: true }, { barrier: true }, { astra: true, targetFails: true, returnFails: true },
  { targetFails: 'quota' }, { astra: true, targetFails: 'quota' }, { targetFails: 'network' },
  { sourceAstra: true, auto: false }, { sourceAstra: true, held: true }, { sourceAstra: true, barrier: true },
  { sourceAstra: true, returnFails: true }, { sourceAstra: true, returnFails: 'quota' }, { sourceAstra: true, returnFails: 'network' },
  { astra: true, targetFails: true, returnHeld: true }]) {
  test(`${JSON.stringify(options)}では往復・連鎖せず後続を保持`, async () => {
    const f = fixture(options);
    try {
      f.runner.send(f.o); f.runner.enqueue('p', 't', { id: 'later', ai: 'codex', model: 'GPT-6.1-Sol', text: 'later' });
      const returned = options.astra && options.targetFails === true && !options.returnHeld;
      const expected = returned ? 2 : options.targetFails || options.returnFails ? 1 : 0;
      await until(() => f.idle() && (f.backups().length === expected) && f.rows().some(r => r.role === 'event' &&
        (/待機します|始められませんでした/.test(r.text) || r.limitSwitch?.reason === 'capacity')));
      assert.equal(f.backups().length, expected);
      assert.ok(f.runner.queue('p', 't').some(q => q.id === 'later'));
      assert.equal(f.limits.length, options.targetFails === 'quota' || options.returnFails === 'quota' ? 1 : 0);
      assert.equal(f.calls.length, options.astra && options.targetFails === true ? 2 : 1);
      assert.equal(fs.readFileSync(path.join(f.dir, 'source-effects'), 'utf8'), 'once\n');
      assert.equal(f.rows().some(r => /A capacity successor must never/.test(r.text || '')), false);
      if (options.sourceAstra && options.returnFails === true || returned && options.returnFails === true) {
        assert.ok(f.rows().some(r => r.role === 'event' && /使い切ったため.*待機します/.test(r.text)));
        assert.equal(f.rows().some(r => /引き継ぎを保存できませんでした/.test(r.text || '')), false);
      }
    } finally { await f.clean(); }
  });
}
test('画面送信のようにrequestが無くても、Sol復帰へ両方の番の済操作と委任を渡す', async () => {
  const f = fixture({ astra: true, targetFails: true, supervised: true });
  delete f.o.request;
  f.runner.delegates = () => f.rows().filter(r => r.role === 'user').slice(0, 2).map((r, i) =>
    ({ id: `delegate-${i}`, action: 'delegate', sourceTurn: r.turn, ai: 'claude', model: 'Opus 5.5', title: `保存済み委任${i}` }));
  try {
    f.runner.send(f.o);
    await until(() => f.idle() && f.backups().length === 2 && f.rows().findLast(r => r.role === 'assistant')?.error === '');
    const card = f.backups()[1].input;
    assert.match(card, /道具：1件/); assert.match(card, /source-effects/);
    assert.match(card, /送った委任：2件/);
    assert.match(card, /保存済み委任0/); assert.match(card, /保存済み委任1/);
    assert.equal(fs.readFileSync(path.join(f.dir, 'source-effects'), 'utf8'), 'once\n');
  } finally { await f.clean(); }
});
test('引継ぎキュー保存失敗は後続を始めず原エラーと作業を残す', async () => {
  const f = fixture(); const save = f.runner.setQueue.bind(f.runner);
  f.runner.setQueue = (p, t, q, ...args) => { if (q.some(x => x.limitSwitch?.reason === 'capacity')) throw Error('fixture queue write denied'); return save(p, t, q, ...args); };
  try {
    f.runner.send(f.o); f.runner.enqueue('p', 't', { id: 'later', ai: 'codex', model: 'GPT-6.1-Sol', text: 'later' });
    await until(f.idle); assert.equal(f.backups().length, 0); assert.equal(f.runner.queue('p', 't')[0].id, 'later');
    assert.ok(f.rows().some(r => /引き継ぎを保存できませんでした/.test(r.text))); assert.equal(f.rows().find(r => r.role === 'assistant').error, CAPACITY);
  } finally { await f.clean(); }
});
test('AstraからSolへ戻す保存に失敗したら、元の作業と後続を保持する', async () => {
  const f = fixture({ astra: true, targetFails: true, supervised: true });
  const save = f.runner.setQueue.bind(f.runner);
  f.runner.setQueue = (p, t, q, ...args) => {
    if (q.some(x => x.limitSwitch?.request === 'capacity-original')) throw Error('fixture return queue write denied');
    return save(p, t, q, ...args);
  };
  try {
    f.runner.send(f.o); f.runner.enqueue('p', 't', { id: 'later', ai: 'codex', model: 'GPT-6.1-Sol', text: 'later' });
    await until(() => f.idle() && f.rows().some(r => /fixture return queue write denied/.test(r.text)));
    assert.equal(f.backups().length, 1); assert.equal(f.runner.queue('p', 't')[0].id, 'later');
    assert.equal(f.rows().filter(r => r.role === 'assistant').length, 2);
    assert.equal(fs.readFileSync(path.join(f.dir, 'source-effects'), 'utf8'), 'once\n');
  } finally { await f.clean(); }
});
test('Astra停止時に人が停止したら、Solへ戻さず後続も保留する', async () => {
  const f = fixture({ astra: true, targetFails: true, supervised: true });
  f.runner.watch('p', 't', ev => {
    if (ev.type === 'row' && ev.row.role === 'assistant' && ev.row.model === 'GPT-6-Astra') f.stopControl.pause(f.o);
  });
  try {
    f.runner.send(f.o); f.runner.enqueue('p', 't', { id: 'later', ai: 'codex', model: 'GPT-6.1-Sol', text: 'later' });
    await until(() => f.idle() && f.rows().filter(r => r.role === 'assistant').length === 2);
    assert.equal(f.backups().length, 1); assert.equal(f.stopControl.held(f.o), true);
    assert.ok(f.runner.queue('p', 't').some(q => q.id === 'later'));
  } finally { await f.clean(); }
});
