'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { Ideas } = require('../lib/ideas'), U = require('../lib/idea-utils');
const { IdeaSource, decorate } = require('../lib/idea-source');
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-storage-')), dir = path.join(root, 'Product/P'); fs.mkdirSync(dir, { recursive: true });
  const project = { id: 'P', dir, tasks: [{ id: 'main' }] }, store = { root, readProject: id => id === 'P' ? project : null };
  const ideas = new Ideas({ store, ...options }); t.after(() => ideas.close()); return { root, dir, project, store, ideas };
}
const add = (ideas, text = '会話に検索を付けたい', more = {}) => ideas.add('P', { opId: U.uuid(), text, intent: 'record', ...more }, { human: true });
test('C1/C2/C3: busyと独立した受付、同時追加、opIdの同一性', async t => {
  const { ideas } = fixture(t); const opId = U.uuid(), body = { opId, text: '原文', intent: 'record' };
  const results = await Promise.all([Promise.resolve().then(() => ideas.add('P', body, { human: true })), Promise.resolve().then(() => add(ideas, '別の原文'))]);
  assert.equal(ideas.read('P').rev, 2); assert.equal(Object.keys(ideas.read('P').items).length, 2);
  assert.equal(ideas.add('P', body, { human: true }).id, results[0].id); assert.equal(ideas.read('P').rev, 2);
  assert.throws(() => ideas.add('P', { ...body, text: '違う内容' }, { human: true }), e => e.status === 409);
  add(ideas, '原文'); assert.equal(Object.keys(ideas.read('P').items).length, 3);
});
test('C8: record権限をbuildへ昇格しない、停止世代を別保存', t => {
  const { ideas } = fixture(t); assert.throws(() => add(ideas, '実装', { intent: 'invalid' }), e => e.status === 400);
  assert.throws(() => ideas.add('P', { opId: U.uuid(), text: '実装', intent: 'build' }), e => e.status === 403);
  const r = add(ideas, '実装', { intent: 'build' }); let d = ideas.read('P'); assert.equal(d.settings.auto.enabled, false); assert.equal(d.settings.manualPaused, false); assert.equal(d.items[r.id].grant.by, 'human-ui');
});
for (const boundary of ['staging', 'intent', 'rename', 'directory-sync', 'cleanup']) test('C4/F7: 保存停止注入 ' + boundary, t => {
  let armed = false; const { ideas, store } = fixture(t, { fault(stage, { file }) { if (armed && stage === boundary && file.endsWith('/ideas.json')) { armed = false; throw Error('injected-' + stage); } } });
  const first = add(ideas, '既に受付済み'); armed = true; const body = { opId: U.uuid(), text: '停止境界の原文', intent: 'record' }; let result;
  try { result = ideas.add('P', body, { human: true }); } catch (e) { assert.match(e.message, /injected/); }
  ideas.close(); const restored = new Ideas({ store }); t.after(() => restored.close());
  const receipt = restored.receipt('P', body.opId); assert.equal(restored.read('P').items[first.id].text, '既に受付済み');
  if (boundary === 'staging') assert.equal(receipt.state, 'absent'); else assert.equal(receipt.saved, true);
  if (result) assert.equal(receipt.receipt.opId, result.receipt.opId);
});
test('C4: 壊れた正本を空にしない。未照合の一時ファイルを採用しない', t => {
  const { ideas } = fixture(t); add(ideas); const s = ideas.resolve('P'); fs.writeFileSync(s.file, '{broken');
  assert.throws(() => ideas.read('P'), /照合中/); assert.equal(ideas.receipt('P', U.uuid()).state, 'unknown'); assert.throws(() => add(ideas), /JSON|Unexpected|照合/); assert.equal(fs.readFileSync(s.file, 'utf8'), '{broken');
});
test('C5: 2つのHubが同じwriterを期限だけで奪わない', t => {
  const { ideas, store } = fixture(t); add(ideas); const second = new Ideas({ store }); t.after(() => second.close());
  assert.throws(() => add(second), /別のHub/); ideas.close(); assert.equal(add(second).saved, true);
});
test('C26/F7: Git同居時は制御記録も正本もGit外、worktreeに複製しない', t => {
  const { ideas, dir, root } = fixture(t); U.git(dir, ['init', '-q']);U.git(dir,['config','user.name','Fixture']);U.git(dir,['config','user.email','fixture@localhost']);fs.writeFileSync(path.join(dir,'product.txt'),'product');U.git(dir,['add','.']);U.git(dir,['commit','-qm','base']);const a=add(ideas),uid=ideas.read('P').projectUid,s = ideas.resolve('P');
  assert.equal(s.colocated, true); assert.equal(require('../lib/resource-scope').commonGit(s.dir), ''); assert.equal(require('../lib/resource-scope').commonGit(s.controlDir), '');
  assert.equal(fs.existsSync(path.join(dir, '.ai/ideas.json')), false); assert.equal(fs.existsSync(path.join(dir, 'アイデア帳.md')), false);
  assert.equal(U.snapshot(dir).dirty,'');fs.writeFileSync(path.join(dir,'product.txt'),'temporary');fs.writeFileSync(path.join(dir,'untracked.txt'),'temporary');U.git(dir,['reset','--hard','HEAD']);U.git(dir,['clean','-fd']);const copy=path.join(root,'new-worktree');U.git(dir,['worktree','add','-qb','copy',copy]);
  assert.equal(ideas.read('P').projectUid,uid);assert.equal(ideas.read('P').items[a.id].text,'会話に検索を付けたい');assert.equal(ideas.receipt('P',a.receipt.opId).saved,true);assert.equal(fs.existsSync(s.file),true);assert.equal(fs.existsSync(path.join(copy,'.ai/ideas.json')),false);assert.equal(U.snapshot(dir).dirty,'');
});
test('C27: md手編集、明示移行、二重import、説明文と履歴を保全', t => {
  const { ideas, dir } = fixture(t); const text = '# アイデア帳\n\n説明です\n## 運用\n- 自動で進める決まり\n## アイデア\n- [ ] 原文を残したい\n- [x] 古い対応\n謎の行\n'; const md = path.join(dir, 'アイデア帳.md'); fs.writeFileSync(md, text);
  assert.equal(ideas.view('P').items.length, 0); assert.equal(fs.existsSync(ideas.registryFile), false);
  const r = ideas.initialize('P', U.uuid(), { importLegacy: true }); assert.equal(r.imported, 2); assert.equal(fs.readFileSync(md, 'utf8'), text);
  assert.equal(ideas.initialize('P', U.uuid(), { importLegacy: true }).imported, 0); assert.equal(ideas.view('P').items.length, 2);
  assert.ok(ideas.view('P').items.every(i => i.intent === 'record' && !i.implementation));
  const imported = Object.values(ideas.read('P').imports)[0]; assert.equal(fs.readFileSync(imported.backup, 'utf8'), text); assert.equal(imported.unknown[0].text, '謎の行');
});
test('C27: md書き出し失敗でもJSONの受付は成功、人の後編集を上書きしない', t => {
  let failed = true; const { ideas } = fixture(t, { fault(stage) { if (stage === 'markdown' && failed) throw Error('disk'); } });
  const a = add(ideas); assert.equal(a.saved, true); assert.equal(ideas.receipt('P', a.receipt.opId).saved, true); failed = false; add(ideas);
  const s = ideas.resolve('P'); fs.writeFileSync(s.md, '手で書いた原文'); add(ideas); assert.equal(fs.readFileSync(s.md, 'utf8'), '手で書いた原文');
});
test('C6: 会話世代・同文出現・近傍の保全、起点削除時は未照合原文', t => {
  const { store, project } = fixture(t); let generation = 1, rows = [{ role: 'user', text: '背景' }, { role: 'assistant', text: '同文' }, { role: 'assistant', text: '同文' }];
  const source = new IdeaSource({ store, generation: () => generation, readRows: () => rows }); const decorated = decorate(rows, generation); assert.notEqual(decorated[1].ideaSource.rowRef, decorated[2].ideaSource.rowRef);
  const ref = { task: 'main', ...decorated[2].ideaSource }, capture = source.capture('P', ref, '同文'); assert.equal(capture.source.capture, 'verified'); assert.ok(capture.source.snapshots.some(r => r.text === '背景'));
  generation++; rows = [{ role: 'user', text: '別世代' }]; assert.equal(source.capture('P', ref, '同文').source.capture, 'unverified'); project.tasks = []; assert.equal(source.capture('P', ref, '同文').text, '同文'); assert.throws(() => source.capture('P', ref), /保存元/);
});
test('C15/C29: 循環依存拒否・原文改訂と古い回答、保存だけでは実装許可なし', t => {
  const { ideas } = fixture(t); const a = add(ideas), b = add(ideas); let d = ideas.read('P');
  const deps = [{ ideaId: b.id, contentRev: 1, requires: 'implemented' }]; ideas.update('P', { opId: U.uuid(), id: a.id, baseContentRev: 1, baseControlRev: 1, change: { dependencies: deps } });
  assert.throws(() => ideas.dependencies(ideas.read('P'), b.id, [{ ideaId: a.id, contentRev: 2, requires: 'implemented' }], 'human'), /循環/);
  let i = ideas.read('P').items[a.id]; ideas.update('P', { opId: U.uuid(), id: a.id, baseContentRev: i.contentRev, baseControlRev: i.controlRev, change: { text: '手で保存だけの編集' } }); i = ideas.read('P').items[a.id]; assert.equal(i.grant, null); assert.equal(i.intent, 'record'); assert.equal(i.revisionHistory.length, 2);
});

test('category: 旧項目互換・5種類・件数とページ・内容許可と固定対象を維持', t => {
  const { ideas } = fixture(t); const a = add(ideas, '分類する制作', { intent: 'build' });
  ideas.internal('P', U.uuid(), { fixture: 'legacy-and-release' }, d => { delete d.items[a.id].category; d.releases.ready = { state: 'ready', rev: 1 }; });
  assert.equal(ideas.view('P').items[0].category, 'note');
  const before = ideas.read('P').items[a.id], opId = U.uuid(), body = { opId, id: a.id, baseContentRev: before.contentRev, baseControlRev: before.controlRev, change: { category: 'bug' } };
  ideas.update('P', body); ideas.update('P', body);
  const d = ideas.read('P'), after = d.items[a.id];
  for (const key of ['text', 'contentRev', 'planRev', 'grant', 'priority', 'intent', 'status', 'implementation']) assert.deepEqual(after[key], before[key], key);
  assert.equal(after.controlRev, before.controlRev + 1); assert.equal(d.releases.ready.state, 'ready');
  assert.equal(ideas.receipt('P', opId).saved, true);
  for (const category of ['improve', 'feature', 'research', 'note', 'uncategorized']) add(ideas, category, { category });
  let view = ideas.view('P', 0, 100, 'bug'); assert.equal(view.total, 1); assert.equal(view.items[0].id, a.id); assert.equal(view.counts.all, 6); assert.equal(Object.values(view.counts.categories).reduce((a,b)=>a+b), 6);
  for (let n = 0; n < 101; n++) add(ideas, '多数の記録 ' + n, { category: 'feature' });
  view = ideas.view('P', 100, 100, 'feature'); assert.equal(view.total, 102); assert.equal(view.items.length, 2); assert.equal(view.counts.categories.feature, 102);
  assert.throws(() => add(ideas, 'invalid', { category: 'invalid' }), e => e.status === 400);
  assert.throws(() => ideas.view('P', 0, 100, 'invalid'), e => e.status === 400);
  assert.throws(() => ideas.update('P', { ...body, opId: U.uuid(), baseControlRev: after.controlRev, change: { category: null } }), e => e.status === 400);
});

test('build:false: 未着手のみ許可、open targetsと実装済みを拒否、receiptと版競合', t => {
  const { ideas } = fixture(t);
  for (const status of ['queued', 'blocked', 'running', 'planning', 'waiting', 'implemented', 'withdrawn', 'note']) {
    const a = add(ideas, status, { intent: 'build' }); ideas.internal('P', U.uuid(), { fixture: status }, d => { d.items[a.id].status = status; });
    const body = { opId: U.uuid(), id: a.id, baseContentRev: 1, baseControlRev: 1, change: { build: false } };
    if (['queued', 'blocked'].includes(status)) { ideas.update('P', body); ideas.update('P', body); const i = ideas.read('P').items[a.id]; assert.equal(i.grant, null); assert.equal(i.intent, 'record'); assert.equal(i.status, 'note'); assert.equal(i.contentRev, 1); assert.throws(() => ideas.update('P', { ...body, opId: U.uuid() }), e => e.status === 409); }
    else assert.throws(() => ideas.update('P', body), e => e.status === 409 && /実行終了後に削除/.test(e.message));
  }
  for (const variant of ['open', 'implementation', 'closed', 'not-sent', 'cancelled']) {
    const a = add(ideas, variant, { intent: 'build' }); ideas.internal('P', U.uuid(), { fixture: variant }, d => { if (variant === 'implementation') d.items[a.id].implementation = { head: 'abc' }; else d.runs[U.uuid()] = { targets: [{ itemId: a.id }], closed: variant === 'closed', delivery: variant }; });
    const body = { opId: U.uuid(), id: a.id, baseContentRev: 1, baseControlRev: 1, change: { build: false } };
    if (['open', 'implementation'].includes(variant)) { assert.equal(ideas.view('P').items.find(i=>i.id===a.id).canUnbuild, false); assert.throws(() => ideas.update('P', body), e => e.status === 409); }
    else assert.equal(ideas.update('P', body).saved, true);
  }
});
