'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Discussion, progress } = require('../lib/discussion');
function fixture(t, count = 2, exchanges = 1) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-discussion-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [], holds = new Set(); let ready = false;
  const candidates = Array.from({ length: 4 }, (_, i) => ({ ai: i % 2 ? 'codex' : 'claude', id: 'model-' + i, model: 'Model ' + i, account: 'default', effort: '高' }));
  const d = new Discussion({ file: path.join(dir, 'discussions.json'), target() {}, ready: () => ready, held: s => holds.has(s.model) ? '正式な利用上限' : '', candidates: () => candidates.map(s => ({ ...s, held: holds.has(s.id) ? '正式な利用上限' : '', unavailable: holds.has(s.id) ? '正式な利用上限' : '' })), dispatch: async (p, s, text) => calls.push({ p, s, text }), cancelRun() {} });
  ready = true;
  const body = { project: 'P', task: 'T', text: '話題', participants: candidates.slice(0, count).map(c => ({ ai: c.ai, model: c.id })), exchanges, summarizer: { ai: candidates[0].ai, model: candidates[0].id } };
  const start = () => d.start(body);
  const settle = async (text = '回答', error = '', discussionLimit = false) => { const p = d.get('P', 'T'), s = p.slots.find(s => s.status === 'running'); assert.ok(s); await d.settled({ project: 'P', task: 'T', request: s.request }, { text, error, discussionLimit }); };
  return { d, calls, body, start, settle, holds, ready: v => { ready = v; } };
}
test('2〜4参加者・1〜2回の正しい予定、独立意見・前回の意見交換だけを渡して100%にする', async t => {
  for (const n of [2, 3, 4]) for (const rounds of [1, 2]) {
    const f = fixture(t, n, rounds); f.start(); await f.d.tick();
    assert.equal(progress(f.d.get('P', 'T')).total, n * (1 + rounds) + 1);
    assert.equal(progress(f.d.get('P', 'T')).completed, 0);
    assert.throws(f.start, /動いて/);
    for (let i = 0; i < n * (1 + rounds) + 1; i++) {
      const call = f.calls.at(-1);
      const summary = i === n * (1 + rounds), round = Math.floor(i / n);
      const expected = i < n ? [] : Array.from({length:n}, (_, j) => (summary ? rounds : round - 1) * n + j).filter(j => summary || j % n !== i % n);
      assert.deepEqual((call.text.match(/ANSWER-\d+/g) || []).map(s => Number(s.slice(7))), expected);
      assert.match(call.text, summary ? /要点中心で、目安1200字以内/ : /要点中心で、目安800字以内/);
      await f.settle('ANSWER-' + i); assert.equal(progress(f.d.get('P','T')).completed, i + 1);
      if (i < n * (1 + rounds)) assert.ok(progress(f.d.get('P','T')).percent < 100);
      await f.d.tick();
    }
    assert.equal(f.d.get('P','T').status, 'done'); assert.equal(progress(f.d.get('P','T')).percent, 100);
    assert.equal(new Set(f.calls.map(c => c.s.request)).size, f.calls.length);
    assert.deepEqual(f.d.read().previous.participants, f.body.participants);
  }
});
test('不参加者の残った意見と未完了の直前の意見を保持し、手動まとめには各自の最新完了分だけ渡す', async t => {
  const f = fixture(t, 3, 2); f.start();
  for (const text of ['P0初回', 'P1初回', 'P2初回', 'P0交換1']) { await f.settle(text); await f.d.tick(); }
  await f.settle('', '利用上限', true); await f.d.tick();
  await f.settle('P2交換1'); await f.d.tick();
  const exchange = f.calls.at(-1).text;
  assert.match(exchange, /P1初回/); assert.match(exchange, /P2交換1/);
  assert.doesNotMatch(exchange, /P0初回|P0交換1|P2初回/);
  const long = 'あ'.repeat(1600) + 'P0交換2全文末尾';
  await f.settle(long); await f.d.tick(); await f.settle('P2未完了', '通信失敗');
  const p = f.d.get('P', 'T');
  f.d.manual({project:'P',task:'T',id:p.id,summarizer:{ai:'claude',model:'model-0'}}); await f.d.tick();
  const summary = f.calls.at(-1).text;
  assert.ok(summary.includes(long)); assert.match(summary, /P1初回/); assert.match(summary, /P2交換1/);
  assert.doesNotMatch(summary, /P0初回|P0交換1|P2初回|P2未完了/);
  assert.equal((summary.match(/）の意見：/g) || []).length, 3);
  const fullSummary = 'い'.repeat(1800);
  await f.settle(fullSummary); assert.equal(f.d.get('P','T').slots.at(-1).text, fullSummary);
});
test('1人になった時のまとめにも不参加者を含む各自の最新完了分だけを渡す', async t => {
  const f = fixture(t, 2, 2); f.start();
  for (const text of ['P0初回', 'P1初回', 'P0交換1']) { await f.settle(text); await f.d.tick(); }
  await f.settle('', '利用上限', true); await f.d.tick();
  assert.equal(f.calls.at(-1).s.kind, 'summary');
  assert.match(f.calls.at(-1).text, /P0交換1/); assert.match(f.calls.at(-1).text, /P1初回/);
  assert.doesNotMatch(f.calls.at(-1).text, /P0初回/);
});
test('上限参加者の不参加、1人になったら意見交換を飛ばし残った本人でまとめる', async t => {
  const f = fixture(t, 2, 2); f.start(); await f.settle('最初の意見'); await f.d.tick();
  await f.settle('', '正式な利用上限', true);
  let p = f.d.get('P','T'); assert.equal(p.status,'waiting'); assert.equal(p.single,true);
  assert.equal(p.participants[1].status,'excluded'); assert.equal(progress(p).completed,1); assert.equal(progress(p).total,2);
  assert.equal(p.slots.filter(s=>s.kind==='exchange'&&s.status==='skipped').length,2); assert.match(p.reasons[0],/7回 → 2回/);
  await f.d.tick(); assert.equal(f.calls.at(-1).s.kind,'summary'); assert.equal(f.calls.at(-1).s.model,'model-0'); await f.settle('一人のまとめ'); assert.equal(progress(f.d.get('P','T')).percent,100);
});
test('3人から2人で続行、まとめ役の上限では保存した意見を残す', async t => {
  const f=fixture(t,3);f.start();await f.settle('意見');await f.d.tick();await f.settle('', '上限',true);
  assert.equal(progress(f.d.get('P','T')).total,5);assert.equal(f.d.get('P','T').single,undefined);await f.d.tick();await f.settle('3人目');await f.d.tick();await f.settle('', '上限',true);
  assert.equal(f.d.get('P','T').single,true);await f.d.tick();await f.settle('', '上限',true);const p=f.d.get('P','T');assert.equal(p.status,'stopped');assert.ok(progress(p).percent<100);assert.ok(p.slots.some(s=>s.text==='意見'));
});
test('参加者0人で停止、遅れて届いた上限でも人の停止を取り消さない、破損記録を上書きしない',async t=>{
 const f=fixture(t);f.start();await f.settle('','上限',true);await f.d.tick();await f.settle('','上限',true);const p=f.d.get('P','T');assert.equal(p.status,'stopped');assert.equal(p.participants.filter(s=>s.status!=='excluded').length,0);assert.equal(progress(p).completed,0);assert.equal(progress(p).total,0);await f.d.tick();assert.equal(f.calls.length,2);
 const g=fixture(t);g.start();const old=g.d.get('P','T'),slot=old.slots[0];g.d.stop('P','T');g.d.exclude(old,slot,'遅れた上限');assert.equal(g.d.get('P','T').status,'stopped');assert.equal(progress(g.d.get('P','T')).total,5);
 fs.writeFileSync(g.d.file,'BROKEN');assert.equal(g.d.active('P','T'),false);assert.match(g.d.view('P','T').error,/保存記録/);assert.throws(g.start,/上書き/);assert.equal(fs.readFileSync(g.d.file,'utf8'),'BROKEN');
});
test('まとめ役の上限で自動交代せず停止、手動で利用可能な担当を選んだ時だけまとめる', async t => {
  const f=fixture(t);f.start();for(let i=0;i<4;i++){await f.settle('意見'+i);await f.d.tick();}
  await f.settle('', 'まとめの上限',true);f.holds.add('model-0');const p=f.d.get('P','T');assert.equal(p.status,'stopped');assert.equal(progress(p).completed,4);assert.equal(progress(p).percent,80);
  await f.d.tick();assert.equal(f.calls.length,5);
  assert.throws(()=>f.d.manual({project:'P',task:'T',id:p.id,summarizer:{ai:'claude',model:'model-0'}}),/最新/);
  f.d.manual({project:'P',task:'T',id:p.id,summarizer:{ai:'codex',model:'model-1'}});assert.throws(()=>f.d.manual({project:'P',task:'T',id:p.id,summarizer:{ai:'codex',model:'model-1'}}),/停止/);
  await f.d.tick();assert.match(f.calls.at(-1).text,/意見3/);await f.settle('手動まとめ');assert.equal(progress(f.d.get('P','T')).percent,100);
});
test('停止・通常失敗・再起動は割合を凍結し再送しない、保存失敗は完了にしない', async t => {
  for(const action of ['stop','fail','recover']) { const f=fixture(t);f.start();await f.settle('保存した意見');await f.d.tick();
    if(action==='stop')f.d.stop('P','T');else if(action==='recover')f.d.recover();else await f.settle('途中の回答','通信エラー');
    const p=f.d.get('P','T'),g=progress(p);assert.equal(g.completed,1);assert.equal(g.total,5);assert.equal(g.percent,20);await f.d.tick();assert.equal(f.calls.length,2);await f.d.settled({project:'P',task:'T',request:p.slots[1].request},{text:'遅れた成功'});assert.equal(progress(f.d.get('P','T')).completed,1);
  }
  const f=fixture(t);f.start();await f.settle('意見');await f.d.tick();f.d.save=()=>{throw Error('保存失敗');};await assert.rejects(f.settle('保存できない'),/保存失敗/);assert.equal(progress(f.d.get('P','T')).completed,1);
});
test('未知・削除モデル・重複・異なるAIへの改変を拒否、既存上限の参加者は送信しない', async t => {
  const f=fixture(t);assert.throws(()=>f.d.start({...f.body,participants:[f.body.participants[0],f.body.participants[0]]}),/重ね/);
  assert.throws(()=>f.d.start({...f.body,summarizer:{ai:'codex',model:'消えたモデル'}}),/最新/);
  f.start();const p=f.d.get('P','T'),s=p.slots[0],o={project:'P',task:'T',request:s.request,ai:s.ai,account:s.account,requiredModel:s.model,discussion:{id:p.id},readOnly:true,discussionTurn:true};f.d.verify(o);assert.throws(()=>f.d.verify({...o,readOnly:false}));assert.throws(()=>f.d.verify({...o,ai:'agy'}));f.d.stop('P','T');assert.throws(()=>f.d.verify(o));
});

test('契約CLI候補は最新の確認一覧から作り、消えたモデルを補完せず通常役割を変更しない',()=>{
 const {createDiscussion}=require('../lib/discussion-runtime'),catalog={codex:{models:[{id:'current-model',label:'Current Model'}]},agy:{models:[{id:'gemini-current',label:'Current Gemini'}]}};
 const d=createDiscussion({file:'/unused',tools:{catalog:()=>catalog,find:()=>true},accountFor:()=> 'default',limits:{active:()=>null},modelError:()=>'',chats:{},store:{}});
 assert.deepEqual(d.candidates('P','T').map(c=>c.id),['current-model','gemini-current']);assert.equal(d.candidates('P','T')[1].unavailable,'読み取り専用・正式上限の判定を未確認');
 catalog.codex.models=[{id:'next-model',label:'Next Model'}];assert.deepEqual(d.candidates('P','T').map(c=>c.id),['next-model','gemini-current']);assert.throws(()=>d.select({project:'P',task:'T'},{ai:'codex',model:'current-model'}),/最新/);assert.equal(d.select({project:'P',task:'T'},{ai:'codex',model:'next-model'}).model,'next-model');
});

test('停止直後の手動まとめは古い回の遅延失敗・上限・成功で変更されず、古い回を再送しない', async t => {
  for (const outcome of ['verify', 'auth', 'limit']) {
    const f = fixture(t); f.d.kick = () => {};
    f.start(); await f.d.tick(); await f.settle('保存した意見');
    let release;
    const gate = new Promise(r => { release = r; });
    const dispatch = f.d.dispatch;
    f.d.dispatch = async (p,s,text) => {
      await gate;
      if (outcome === 'auth') throw Error('遅れたログイン失敗');
      if (outcome === 'limit') { f.holds.add(s.model); throw Error('遅れた上限'); }
      f.d.verify({project:p.project,task:p.task,request:s.request,ai:s.ai,account:s.account,requiredModel:s.model,discussion:{id:p.id},readOnly:true,discussionTurn:true});
      return dispatch(p,s,text);
    };
    const pending = f.d.tick(), old = f.d.get('P','T'), slot = old.slots[1];
    assert.equal(slot.status,'running');
    f.d.stop('P','T');
    f.d.manual({project:'P',task:'T',id:old.id,summarizer:{ai:'claude',model:'model-0'}});
    const before = f.d.get('P','T'); assert.equal(before.status,'waiting');
    release(); await pending;
    const after = f.d.get('P','T');
    assert.deepEqual(after,before,outcome);
    assert.equal(after.status,'waiting',outcome); assert.equal(after.message,before.message);
    assert.equal(after.slots[1].status,'skipped'); assert.equal(after.slots.at(-1).status,'waiting');
    await f.d.settled({project:'P',task:'T',request:slot.request},{text:'遅れた成功'});
    assert.equal(progress(f.d.get('P','T')).completed,1);
    f.d.dispatch = dispatch; await f.d.tick(); await f.settle('手動まとめ成功');
    assert.equal(f.d.get('P','T').status,'done'); assert.equal(progress(f.d.get('P','T')).percent,100);
    assert.equal(f.calls.length,2); assert.equal(f.calls.at(-1).s.manual,true);
  }
});

test('保存された削除モデルは役割値だけに保持し、最新候補へ補完せず新規選択を拒否する', t => {
  const roles = require('../lib/roles'); t.after(() => roles.setModelCatalog({}));
  const raw = {models:{codex:['Removed Codex'],'claude-code':['Removed Claude']},roles:{調査:{main:['claude-code','Removed Claude','高'],backup:['codex','Removed Codex','高']}}};
  roles.setModelCatalog({claude:{models:[{id:'claude-opus-5-5',label:'Opus 5.5'}]},codex:{models:[{id:'gpt-6.1-sol',label:'GPT-6.1-Sol'}]}});
  const data = roles.normalize(raw);
  assert.deepEqual(data.models.codex,['GPT-6.1-Sol']); assert.deepEqual(data.models['claude-code'],['Opus 5.5']);
  assert.equal(data.roles[0].main.model,'Removed Claude'); assert.equal(data.roles[0].backup.model,'Removed Codex');
  assert.deepEqual(roles.validate(data.models,data.roles,{previous:data.roles}),[]);
  const changed = structuredClone(data.roles); changed[0].backup.effort='中';
  assert.match(roles.validate(data.models,changed,{previous:data.roles}).join('\n'),/選べません/);
  roles.setModelCatalog({claude:{source:'confirmed',models:[]},codex:{source:'confirmed',models:[]}});
  assert.deepEqual(roles.normalize(raw).models.codex,[]); assert.deepEqual(roles.normalize(raw).models['claude-code'],[]);
});
