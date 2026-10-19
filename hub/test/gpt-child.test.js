'use strict';
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Store } = require('../lib/store'), chat = require('../lib/chat');
const { Chatgpt } = require('../lib/chatgpt'), { GptChildren } = require('../lib/gpt-children');
const { WorkspaceSandbox } = require('../lib/workspace-sandbox');
const git = require('../lib/git');
const { readResults } = require('../lib/task-results');
const { Removal } = require('../lib/remove'), { TaskTransfer } = require('../lib/task-transfer'), { TaskIntegrate } = require('../lib/task-integrate');
const cli = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function fixture(t, withParent = true) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-gpt-child-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const body = path.join(root, 'Body'), pdir = path.join(root, 'Product/P'), workRoot = path.join(root, 'Work/P');
  fs.mkdirSync(body); fs.mkdirSync(path.join(pdir, '.ai/tasks'), { recursive: true });
  cli(body, 'init', '-q', '-b', 'main'); cli(body, 'config', 'user.name', 'Test'); cli(body, 'config', 'user.email', 'fixture@localhost');
  fs.writeFileSync(path.join(body, 'original.txt'), 'main'); cli(body, 'add', '.'); cli(body, 'commit', '-qm', 'base');
  let parentDir = '';
  if (withParent) {
    parentDir = git.prepare({ base: body, workRoot, taskId: 'parent', direct: false }).dir;
    fs.writeFileSync(path.join(parentDir, 'parent.txt'), 'parent branch only'); git.save(parentDir, 'parent saved');
  }
  fs.writeFileSync(path.join(pdir, 'PROJECT.md'), `---\nname: P\nfolders:\n  本体: ${body}\n---\n`);
  fs.writeFileSync(path.join(pdir, '.ai/tasks/parent.md'), `---\nid: parent\ntitle: Parent\nowner: codex\nstate: 実行中\nworkspaceMode: isolated\nworkdir: ${parentDir}\nquestion: 親の質問\n---\n## 手順\n- [ ] 親の手順\n`);
  const store = new Store(root), rows = [], events = [];
  const deps = { store, chat, baseOf: () => body, workRoot: () => workRoot, file: path.join(root, '_hub/chatgpt.json'),
    emitRow: (...a) => rows.push(a), ended: (...a) => events.push(a), record() {} };
  const gpt = new Chatgpt(deps), service = gpt.gptChildren = new GptChildren(deps);
  gpt.save({ work: true });
  const project = () => store.readProject('P'), task = id => store.readTask(store.taskFile('P', id));
  // Seed historical records solely to exercise recovery/report compatibility.
  const request = (text = '依頼', id = 'parent') => {
    const parent=task('parent'); service.idle(project(),parent);
    let child=project().tasks.find(t=>t.gptChild);
    if(!child) { child=store.createTask('P',{title:'Historical GPT child',owner:'chatgpt',parent:'parent',workspaceMode:'isolated',steps:['確認','作業','報告']}); child=store.updateTask('P',child.id,{gptChild:true}); }
    service.idle(project(),child);
    const dir=git.prepare({base:body,workRoot,taskId:child.id,startRef:cli(parentDir||body,'rev-parse','HEAD'),isolatedOnly:true}).dir;
    child=store.updateTask('P',child.id,{workdir:dir,workspaceStarted:new Date().toISOString()});
    const request=require('node:crypto').randomUUID(); chat.append(pdir,child.id,{role:'user',to:'gptchat',request,text});
    return {child:child.id,request};
  };
  const external = (name, a, internal = {}) => gpt.call(name, { project: 'P', ...a }, internal);
  const call = (name, a) => a.task && task(a.task)?.gptChild ? service.run(project(), task(a.task), owner => external(name, a, {gptOwner: owner})) : external(name, a);
  const pending = id => chat.read(pdir,id).filter(r=>r.to==='gptchat'&&!chat.read(pdir,id).some(x=>x.ai==='chatgpt-chat'&&x.request===r.request));
  return { root, body, pdir, parentDir, store, gpt, service, project, task, request, call, external, pending, rows, events, log: id => chat.read(pdir, id) };
}
test('retired child creation gives its real reason and creates no empty task in any Git condition', t => {
  const f=fixture(t), before=fs.readdirSync(path.join(f.pdir,'.ai/tasks'));
  for(const configure of [()=>{},()=>fs.writeFileSync(path.join(f.parentDir,'dirty.txt'),'unfinished'),()=>f.store.updateTask('P','parent',{workdir:''})]){
    configure();assert.throws(()=>f.service.request(f.project(),f.task('parent'),'new'),/新規依頼は廃止.*同じ会話/);
    assert.deepEqual(fs.readdirSync(path.join(f.pdir,'.ai/tasks')),before);
    assert.equal(f.log('parent').length,0);
  }
});
test('外部GPTとDot inboxを撤去し、旧依頼の原文は保持する', async t => {
  const f = fixture(t), r = f.request();
  chat.append(f.pdir, 'parent', {role:'user',to:'dot',request:'dot',text:'Dot'});
  await assert.rejects(f.external('hub_gpt_inbox',{task:r.child}),e=>e.status===404);
  assert.equal(f.gpt.tools().some(t=>t.name==='hub_gpt_inbox'),false);
  assert.equal(f.pending(r.child)[0].request,r.request);
  await assert.rejects(f.external('hub_dot_inbox',{}),e=>e.status===404);
});
test('外部MCPはGPT子の全変更を拒否し、偽ownerでも権限を得られない',async t=>{
  const f=fixture(t),r=f.request(),before=fs.readFileSync(f.store.taskFile('P',r.child),'utf8');
  for(const name of ['hub_write_file','hub_run_command','hub_report','hub_ask_owner','hub_mark_step','hub_propose_task'])
    for(const request of [undefined,r.request]) await assert.rejects(f.external(name,{task:r.child,request,text:'bad',path:'bad.txt',command:'true',question:'bad',index:0,done:true,title:'bad'}),e=>e.status===403);
  await assert.rejects(f.external('hub_report',{task:r.child,request:r.request,text:'bad'},{gptOwner:Symbol('fake')}),e=>e.status===403);
  assert.equal(fs.readFileSync(f.store.taskFile('P',r.child),'utf8'),before);
  assert.equal(f.log(r.child).length,1);assert.equal(fs.existsSync(path.join(f.task(r.child).workdir,'bad.txt')),false);
});
test('GPT報告は子copyへcommitし、子の成果に記録、親は通知だけ、並行再送も重複しない', async t => {
  const f = fixture(t), r = f.request(), child = f.task(r.child), main = cli(f.body, 'rev-parse', 'HEAD'), parent = cli(f.parentDir, 'rev-parse', 'HEAD');
  await f.call('hub_write_file', { task: r.child, request: r.request, path: 'result.txt', text: '成果' });
  const args = { task: r.child, request: r.request, text: '結果の本文', done: false };
  const results = await f.service.run(f.project(),child,owner=>Promise.all([f.external('hub_report',args,{gptOwner:owner}),f.external('hub_report',args,{gptOwner:owner})]));
  assert.equal(results.filter(r => r.duplicate).length, 1); assert.equal(cli(child.workdir, 'status', '--porcelain'), '');
  assert.notEqual(results[0].commit, parent); assert.equal(cli(f.body, 'rev-parse', 'HEAD'), main); assert.equal(cli(f.parentDir, 'rev-parse', 'HEAD'), parent);
  assert.equal(f.log(r.child).filter(r => r.ai === 'chatgpt-chat').length, 1);
  assert.equal(f.log('parent').filter(r => r.from === 'gptchat-report').length, 1); assert.ok(!f.log('parent').some(r => r.text === '結果の本文'));
  const record = fs.readFileSync(f.store.taskFile('P', r.child), 'utf8');
  assert.match(record, /## 成果/); assert.ok(record.includes(results[0].commit)); assert.equal(record.split('gpt-report:' + r.request).length, 2);
  const declared = readResults(f.store.taskFile('P', r.child));
  assert.equal(declared.length, 1); assert.equal(declared[0].kind, 'ファイル');
  const artifact = path.join(f.pdir, declared[0].value.replace(/^project:/, ''));
  assert.match(fs.readFileSync(artifact, 'utf8'), /結果の本文/); assert.ok(fs.readFileSync(artifact, 'utf8').includes(results[0].commit));
  assert.deepEqual(f.pending(r.child), []); assert.notEqual(f.task(r.child).state, '完了');
  await assert.rejects(f.call('hub_write_file', { task: r.child, request: r.request, path: 'late.txt', text: 'bad' }), /報告済み/);
});
test('別作業へのrequest報告・request無し・done完了は禁止、未処理のまま維持', async t => {
  const f = fixture(t), r = f.request();
  for (const args of [{ task: 'parent', request: r.request }, { task: r.child, request: 'wrong' }, { task: r.child }, { task: r.child, request: r.request, done: true }]) {
    await assert.rejects(f.call('hub_report', { text: 'bad', ...args }));
  }
  assert.equal((f.pending(r.child)).length, 1); assert.equal(f.log(r.child).length, 1);
});
test('書込み・コマンドはtask/request必須、本体・親・台帳・秘密・linkへは書けない', async t => {
  const f = fixture(t), r = f.request(), child = f.task(r.child);
  const args = { task: r.child, request: r.request, text: 'bad' };
  const outside = path.join(f.body, 'original.txt');
  fs.symlinkSync(outside, path.join(child.workdir, 'linked')); fs.linkSync(outside, path.join(child.workdir, 'hardlinked'));
  fs.symlinkSync(path.join(f.root, 'absent'), path.join(child.workdir, 'dangling'));
  for (const dest of [outside, path.join(f.parentDir, 'parent.txt'), f.store.taskFile('P', r.child), '../escape', '.git', '.env', 'KEY.PEM', 'linked', 'hardlinked', 'dangling/evil']) {
    await assert.rejects(f.call('hub_write_file', { ...args, path: dest }));
  }
  for (const extra of [{ task: undefined }, { task: 'parent' }, { request: undefined }]) {
    await assert.rejects(f.call('hub_write_file', { ...args, path: 'bad.txt', ...extra }));
    await assert.rejects(f.call('hub_run_command', { task: r.child, request: r.request, command: 'true', ...extra }));
  }
  assert.equal(fs.readFileSync(outside, 'utf8'), 'main');
  for (const name of ['hub_mark_step', 'hub_ask_owner']) {
    await assert.rejects(f.call(name, { task: 'parent', request: r.request, index: 0, done: true, question: 'bad' }));
  }
  assert.equal(f.task('parent').question, '親の質問'); assert.equal(f.task('parent').steps[0].done, false);
  await f.call('hub_mark_step', { task: r.child, request: r.request, index: 0, done: true });
  assert.equal(f.task(r.child).steps[0].done, true);
});
test('コピーなし・direct・偽workdirを拒否し、子から親の領域へ逃げられない', async t => {
  const f = fixture(t), r = f.request();
  const child = f.task(r.child);
  const sibling = git.prepare({ base: f.body, workRoot: path.join(f.root, 'Work/P'), taskId: 'sibling', direct: false }).dir;
  for (const workdir of [f.body, f.parentDir, sibling, f.pdir, path.join(f.root, 'missing')]) {
    f.store.updateTask('P', r.child, { workdir });
    await assert.rejects(f.call('hub_write_file', { task: r.child, request: r.request, path: 'bad.txt', text: 'bad' }));
  }
  f.store.updateTask('P', r.child, { workdir: child.workdir });
  fs.symlinkSync(f.body, path.join(f.root, 'Work/P/alias'));
  f.store.updateTask('P', r.child, { workdir: path.join(f.root, 'Work/P/alias') });
  await assert.rejects(f.call('hub_report', { task: r.child, request: r.request, text: 'bad' }));
});

test('人の受領に使う既存統合で、GPT子の成果宣言・報告・commitを親コピーへ受領できる', async t => {
  const f = fixture(t), r = f.request(), child = f.task(r.child), main = cli(f.body, 'rev-parse', 'HEAD');
  await f.call('hub_write_file', { task: r.child, request: r.request, path: 'child.txt', text: 'child result' });
  for (let index = 0; index < child.steps.length; index++) await f.call('hub_mark_step', { task: r.child, request: r.request, index, done: true });
  await f.call('hub_report', { task: r.child, request: r.request, text: 'ready' });
  const removal = new Removal({ store: f.store, trash: path.join(f.root, 'Trash') });
  const transfer = new TaskTransfer({ store: f.store, removal, baseOf: () => f.body });
  const integrate = new TaskIntegrate({ store: f.store, removal, transfer, baseOf: () => f.body });
  assert.equal(transfer.resultIssue(f.project(), f.task(r.child)).ok, true);
  const preview = integrate.preview('P', 'parent');
  assert.equal(preview.items.length, 1); assert.deepEqual(preview.items[0].blockers, []);
  assert.equal(preview.items[0].files.length, 1); assert.equal(preview.items[0].results[0].kind, 'ファイル');
  const result = integrate.apply({ project: 'P', task: 'parent', token: preview.token, confirm: true,
    selected: preview.items.map(i => ({ project: i.project, task: i.task, files: i.selected, optional: [],
      review: { scope: '確認済みGPT子のHEAD全体と成果一式', planned: '同じGPT子作業を継続', undecided: 'なし', residual: 'なし', evidence: 'GPT子の報告と隔離試験', sourceHead: i.source?.head || null, confirmed: true } })) });
  assert.equal(result.complete, true); assert.equal(fs.readFileSync(path.join(f.parentDir, 'child.txt'), 'utf8'), 'child result');
  assert.equal(cli(f.body, 'rev-parse', 'HEAD'), main);
  assert.equal(transfer.read('P', r.child).complete, true);
  assert.equal(transfer.read('P', r.child).retained, true);
  assert.ok(f.task(r.child)); assert.ok(fs.existsSync(child.workdir));
  assert.equal(f.log('parent').filter(row => row.handoff).length, 1);
});

test('実作業の許可オフでも受け箱と報告は使えるが、書込み・コマンドは拒否する', async t => {
  const f = fixture(t), r = f.request(); f.gpt.save({ work: false });
  for (const name of ['hub_write_file', 'hub_run_command']) await assert.rejects(f.call(name, { task: r.child, request: r.request, path: 'bad', text: 'bad', command: 'true' }), /実作業/);
  assert.equal((f.pending(r.child)).length, 1);
  await f.call('hub_report', { task: r.child, request: r.request, text: 'read only result' });
});

test('既存MCPの通常作業はGPT子を作った後も従来の権限で動く', async t => {
  const f = fixture(t); f.request();
  await f.call('hub_write_file', { task: 'parent', path: path.join(f.body, 'legacy.txt'), text: 'legacy' });
  assert.equal(fs.readFileSync(path.join(f.body, 'legacy.txt'), 'utf8'), 'legacy');
  await f.call('hub_ask_owner', { task: 'parent', question: 'legacy question' });
  assert.equal(f.task('parent').question, 'legacy question');
  await f.external('hub_report', { task: 'parent', text: '通常MCP報告' });
  assert.equal(f.log('parent').at(-1).ai, 'chatgpt');
});

test('GPT子からの別作業作成を拒否し、子の質問だけを保存する', async t => {
  const f = fixture(t), r = f.request();
  await assert.rejects(f.call('hub_propose_task', { task: r.child, request: r.request, title: 'escape' }), /別の作業/);
  assert.equal(f.project().tasks.length, 2);
  await f.call('hub_ask_owner', { task: r.child, request: r.request, question: 'child question' });
  assert.equal(f.task(r.child).question, 'child question'); assert.equal(f.task('parent').question, '親の質問');
});
test('sandboxは子内だけを書ける。親・本体・台帳・.git・網はOSが拒否する', async t => {
  const f = fixture(t), r = f.request(), child = f.task(r.child);
  const run = command => f.call('hub_run_command', { task: r.child, request: r.request, command });
  const good = await run('printf hello > local.txt; cat local.txt');
  if (process.env.HUB_TEST_OS_ISOLATION === 'macos-v1' && good.code === 71 && /sandbox_(apply|init): Operation not permitted/.test(good.stderr)) {
    t.skip('macOSは試験の隔離内で二重のsandboxを許可しないため、この実OS試験は未確認'); return;
  }
  assert.equal(good.code, 0); assert.equal(good.stdout, 'hello');
  for (const dest of [path.join(f.body, 'original.txt'), path.join(f.parentDir, 'parent.txt'), f.store.taskFile('P', r.child), path.join(child.workdir, '.git'), path.join(child.workdir, '.env')]) {
    const before = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null;
    const bad = await run(`printf bad > '${dest}'`); assert.notEqual(bad.code, 0);
    assert.equal(fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null, before);
  }
  const denied = await run(`${JSON.stringify(process.execPath)} -e 'require("net").createConnection({host:"127.0.0.1",port:1}).on("error",e=>{console.log(e.code);process.exit(1)})'`);
  assert.notEqual(denied.code, 0); assert.match(denied.stdout, /EPERM/);
  assert.throws(() => new WorkspaceSandbox({ readFiles: [] }, { workspace: () => child.workdir, platform: 'linux' }).run('true'), /command_sandbox_unavailable/);
});
test('コマンド中の送信・報告・書込みは拒否し、失敗後はlockを解除する', async t => {
  const f = fixture(t), r = f.request(); let release;
  const work = f.service.run(f.project(), f.task(r.child), () => new Promise(resolve => release = resolve));
  assert.throws(() => f.request(), /実行中/);
  await assert.rejects(f.call('hub_report', { task: r.child, request: r.request, text: 'premature' }), /実行中/);
  await assert.rejects(f.call('hub_write_file', { task: r.child, request: r.request, path: 'bad', text: 'bad' }), /実行中/);
  release(); await work;
  await assert.rejects(f.service.run(f.project(), f.task(r.child), () => Promise.reject(Error('failure'))));
  await f.call('hub_report', { task: r.child, request: r.request, text: 'finished' });
});
test('報告保存失敗・親通知失敗から復旧しても成果・報告・通知を重複させない', async t => {
  const f = fixture(t), r = f.request(), append = f.gpt.chat.append;
  f.gpt.chat = { ...chat, append() { throw Error('child save failed'); } };
  await assert.rejects(f.call('hub_report', { task: r.child, request: r.request, text: 'recovery' }), /child save failed/);
  assert.equal((f.pending(r.child)).length, 1);
  f.gpt.chat = { ...chat, append };
  const emit = f.service.emitRow; f.service.emitRow = () => { throw Error('parent notify failed'); };
  await assert.rejects(f.call('hub_report', { task: r.child, request: r.request, text: 'recovery' }), /parent notify failed/);
  f.service.emitRow = emit;
  assert.equal((await f.call('hub_report', { task: r.child, request: r.request, text: 'recovery' })).duplicate, true);
  assert.equal(f.log(r.child).filter(r => r.ai === 'chatgpt-chat').length, 1); assert.equal(f.log('parent').filter(r => r.from === 'gptchat-report').length, 1);
  const text = fs.readFileSync(f.store.taskFile('P', r.child), 'utf8');
  assert.equal(text.split('gpt-commit:' + r.request).length, 2); assert.equal(text.split('gpt-report:' + r.request).length, 2);
  assert.equal(readResults(f.store.taskFile('P', r.child)).length, 1);
});
test('HubのGPT報告成果はリンク先に保存せず、既存内容の不一致も上書きしない', async t => {
  const f = fixture(t), r = f.request(), dir = path.join(f.pdir, '作業', r.child);
  fs.mkdirSync(path.dirname(dir), { recursive: true }); fs.symlinkSync(f.body, dir);
  await assert.rejects(f.call('hub_report', { task: r.child, request: r.request, text: 'ready' }), /リンク/);
  assert.equal(f.log(r.child).length, 1); assert.equal(fs.existsSync(path.join(f.body, `GPT-${r.request}.md`)), false);
  fs.unlinkSync(dir); fs.mkdirSync(dir);
  const file = path.join(dir, `GPT-${r.request}.md`); fs.writeFileSync(file, 'original');
  await assert.rejects(f.call('hub_report', { task: r.child, request: r.request, text: 'ready' }), /成果ファイル/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'original'); assert.equal(f.log(r.child).length, 1);
});
