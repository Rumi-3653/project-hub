'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const pub=name=>name==='app.js'?require('./fixtures/app-source.cjs').readApp():fs.readFileSync(path.join(__dirname,'../public',name),'utf8');
test('会話上部の1クリック入口の隣に進行・停止理由を表示し同じ行に過去の会話をまとめる',()=>{
  const app=pub('app.js'),toolbar=app.match(/<div class="task-history-toolbar">[\s\S]*?<\/div>/)[0];
  assert.equal((toolbar.match(/<button/g)||[]).length,2);assert.match(toolbar,/data-task-history="continue"[^>]*>要約して続ける</);
  for(const old of ['本文を整理する（プレビュー）','要約して新しい会話へ','data-body-preview'])assert.ok(!app.includes(old),old);
  assert.ok(!pub('index.html').includes('text-budget.js'));
  assert.match(toolbar,/id="history-progress"[^>]*role="status"/);
  assert.equal((app.match(/id="history-progress"/g)||[]).length,1);
  assert.ok(app.indexOf('id="history-progress"')<app.indexOf('id="msgs"'));
  assert.match(toolbar,/data-task-history="archives"[^>]*>過去の会話</);
  assert.doesNotMatch(app,/class="history-footer"/);
  const sheet=pub('task-history.js');
  assert.match(sheet,/open.dataset.taskHistory==='archives'\?showArchives:continueDirect/);
  for(const part of ['/api/task/continue','id="continue-body-confirm"','data-task-history="archives"','data-history-action="bodyarchives"','data-history-action="bodyrecover"'])assert.ok(sheet.includes(part),part);
});
test('［完了に移す］は短い確認だけで、片付けは完了済み作業の別入口から確認する',()=>{
  assert.match(pub('app.js'),/if \(a === 'taskcomplete'\) return showCompletion\(/);
  const sheet=pub('task-history.js');
  assert.match(sheet,/open.dataset.taskHistory==='archives'\?showArchives:continueDirect/);assert.doesNotMatch(sheet,/finish-tidy|finish-continue/);assert.match(sheet,/if\(d.tidy\)await showTidy\(/);assert.match(sheet,/id="tidy-confirm"/);assert.match(sheet,/data-remove-restore/);
  assert.match(pub('app.js'),/a === 'tasktidy'\) return await showTidy\(p, t\)/);
});
