'use strict';
process.env.HUB_LANG = 'ja';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const chat = require('../lib/chat');
const { ModelLimits } = require('../lib/model-limits');
const { limitRoute, limitIdentity } = require('../lib/limit-route');
require('../lib/launch').setDiscoveredModels({ codex: { models: [
  { id: 'gpt-6-astra', label: 'GPT-6-Astra' }, { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }
] } });

const wait = async predicate => {
  const end = Date.now() + 4000;
  while (!predicate() && Date.now() < end) await new Promise(r => setTimeout(r, 15));
  assert.ok(predicate(), 'CLI終了後に交代するはず');
};
function fixture({ model = 'claude-fable-5-1', mode = 'retry', auto = true, blocked = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-limit-live-'));
  const formal = "You've hit your session limit · resets 7:10am (Asia/Tokyo)";
  fs.writeFileSync(path.join(dir, 'source.cjs'), `
    const fs=require('node:fs'),mode=${JSON.stringify(mode)},formal=${JSON.stringify(formal)};
    const out=o=>console.log(JSON.stringify(o));
    process.on('SIGTERM',()=>{if(mode!=='ignore-term')process.exit(mode==='exit-zero'?0:143);});
    process.stdin.resume();process.stdin.on('end',()=>{
      fs.writeFileSync('source.pid',String(process.pid));fs.appendFileSync('side-effect','once\\n');
      out({type:'system',session_id:'fixture-source'});
      const row={type:'assistant',message:{model:mode==='quote'?'claude-fable-5-1':'<synthetic>',content:[{type:'text',text:mode==='network'?'network failed':formal}]}};
      if(mode!=='quote'){row.error='rate_limit';row.isApiErrorMessage=true;}
      out(row);setInterval(()=>{fs.appendFileSync('retries','again\\n');out(row);},100);
    });
  `);
  fs.writeFileSync(path.join(dir, 'backup.cjs'), `#!${process.execPath}
    const fs=require('node:fs');let input='';process.stdin.on('data',d=>input+=d);
    process.stdin.on('end',()=>{
      let alive=true;try{process.kill(Number(fs.readFileSync('source.pid')),0);}catch(e){if(e.code==='ESRCH')alive=false;else throw e;}
      const info={alive,args:process.argv.slice(2),input};
      const previous=fs.existsSync('backup-runs')?fs.readFileSync('backup-runs','utf8'):'';
      const pending='backup-runs.'+process.pid+'.tmp';
      fs.writeFileSync(pending,previous+JSON.stringify(info)+'\\n');fs.renameSync(pending,'backup-runs');
      console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'continued'}}));console.log(JSON.stringify({type:'turn.completed'}));
    });
  `, { mode: 0o755 });
  const data = { switch: { auto }, roles: [
    { name: 'チェック', main: { ai: 'claude-code', model: 'Fable 5.1' }, backup: { ai: 'codex', model: 'GPT-6-Astra', effort: '高' } },
    { name: '文章', main: { ai: 'claude-code', model: 'Opus 5.5' }, backup: { ai: 'codex', model: 'GPT-6.1-Sol', effort: '中' } }
  ] };
  const limits = new ModelLimits(path.join(dir, 'limits.json'));
  const recorded = [];
  const held = o => limits.forRequest(o) || (blocked && o.ai === 'codex' ? { hold: true } : null);
  const runner = new chat.ChatRunner({ dirOf: () => dir, limitIdentity: o => limitIdentity(data, o),
    limitBackup: o => { const target = limitRoute(data, o); return target && { ...target, perm: './backup.cjs' }; },
    onLimit: o => { recorded.push(o); limits.record(o); }, limitPreflight: held, limitTarget: held });
  const o = { project: 'p', task: 't', pdir: dir, dir, ai: 'claude', model,
    role: model === 'claude-fable-5-1' ? 'チェック' : '文章', text: '残りを続ける', request: 'one', perm: process.execPath + ' source.cjs' };
  const rows = () => chat.read(dir, 't');
  const backups = () => fs.existsSync(path.join(dir, 'backup-runs')) ? fs.readFileSync(path.join(dir, 'backup-runs'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  const clean = async () => { const run = runner.busy('p', 't'); if (run) { runner.stop('p', 't'); run.child.kill('SIGKILL'); await run.finishedP; } };
  return { dir, runner, o, rows, backups, recorded, limits, clean, formal };
}
for (const [model, expected] of [['claude-fable-5-1', 'gpt-6-astra'], ['claude-opus-5-5', 'gpt-6.1-sol']]) {
  test(`${model}の正式上限は自然終了を待たず終了させ、${expected}を一度だけ起動`, async () => {
    const f = fixture({ model });
    try {
      f.runner.send(f.o); const source = f.runner.busy('p', 't');
      await wait(() => f.backups().length === 1 && !f.runner.busy('p', 't'));
      const backup = f.backups()[0]; assert.equal(backup.alive, false);
      assert.equal(backup.args[backup.args.indexOf('--model') + 1], expected);
      assert.ok(backup.args.includes('model_reasoning_effort=' + (expected === 'gpt-6-astra' ? 'high' : 'medium')));
      assert.equal(fs.readFileSync(path.join(f.dir, 'side-effect'), 'utf8'), 'once\n');
      assert.equal(fs.existsSync(path.join(f.dir, 'retries')), false);
      assert.equal(f.recorded.length, 1); assert.ok(f.limits.forRequest(f.o));
      assert.match(f.rows().find(r => r.role === 'assistant').error, /^You've hit your session limit/);
      assert.match(backup.input, /済んだ部分.*繰り返さず/);
      source.child.emit('close', 1); f.runner.send(f.o);
      assert.equal(f.backups().length, 1); assert.equal(f.runner.busy('p', 't'), null);
    } finally { await f.clean(); }
  });
}
for (const mode of ['ignore-term', 'exit-zero']) {
  test(`${mode}のCLIも終了確認後に交代し正式上限を成功扱いしない`, async () => {
    const f = fixture({ mode });
    try {
      f.runner.send(f.o); await wait(() => f.backups().length === 1 && !f.runner.busy('p', 't'));
      assert.equal(f.backups()[0].alive, false); assert.equal(f.recorded.length, 1);
      assert.equal(f.rows().find(r => r.role === 'assistant').error, f.formal);
    } finally { await f.clean(); }
  });
}
for (const options of [{ mode: 'quote' }, { mode: 'network' }, { auto: false }]) {
  test(`${JSON.stringify(options)}では稼働CLIを上限交代のため停止しない`, async () => {
    const f = fixture(options);
    try {
      f.runner.send(f.o); await wait(() => fs.existsSync(path.join(f.dir, 'retries')));
      assert.ok(f.runner.busy('p', 't')); assert.equal(f.backups().length, 0);
      assert.equal(f.recorded.length, 0);
    } finally { await f.clean(); }
  });
}
test('正式上限出力の境界で人が停止した場合は交代も後続も始めない', async () => {
  const f = fixture();
  f.runner.watch('p', 't', ev => { if (ev.type === 'partial') f.runner.stop('p', 't'); });
  try {
    f.runner.send(f.o); f.runner.enqueue('p', 't', { ai: 'codex', model: 'GPT-6.1-Sol', text: 'later' });
    await wait(() => !f.runner.busy('p', 't'));
    assert.equal(f.backups().length, 0); assert.equal(f.recorded.length, 0);
    assert.deepEqual(f.runner.queue('p', 't'), []);
    assert.equal(f.rows().find(r => r.role === 'assistant').error, '止めました');
  } finally { await f.clean(); }
});
test('交代先も上限なら元CLIの再試行を止め、引き継ぎと後続を保存して待機', async () => {
  const f = fixture({ blocked: true });
  try {
    f.runner.send(f.o); f.runner.enqueue('p', 't', { ai: 'codex', model: 'GPT-6.1-Sol', text: 'later' });
    await wait(() => !f.runner.busy('p', 't') && Boolean(f.runner.queue('p', 't')[0]?.error));
    assert.equal(f.backups().length, 0); assert.equal(f.recorded.length, 1);
    assert.equal(f.runner.queue('p', 't').length, 2);
    assert.equal(f.runner.queue('p', 't')[0].requiredModel, 'gpt-6-astra');
    assert.equal(f.runner.queue('p', 't')[1].text, 'later');
  } finally { await f.clean(); }
});
