'use strict';
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { createHash } = require('node:crypto'), { execFileSync } = require('node:child_process');
const { StateOffers } = require('../lib/state-offers'), { TaskTransfer } = require('../lib/task-transfer');
const { TaskIntegrate } = require('../lib/task-integrate'), { Removal } = require('../lib/remove');
const git = require('../lib/git');
const fixtureRoot = path.resolve(__dirname, '../../.ai/work/performance-fix-worker-tests');
const sh = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function manifest(root) {
  const out = {};
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else {
        const s = fs.lstatSync(f);
        out[path.relative(root, f)] = { sha256: createHash('sha256').update(fs.readFileSync(f)).digest('hex'), mode: s.mode, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs };
      }
    }
  }
  walk(root); return out;
}
function fixture(mode) {
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(fixtureRoot, mode + '-')), id = 'Fixture';
  const main = path.join(root, 'System/body'), dir = path.join(root, 'Product', id), workRoot = path.join(root, 'Work', id), wd = path.join(workRoot, 'child');
  fs.mkdirSync(main, { recursive: true }); fs.mkdirSync(path.join(dir, '.ai/tasks'), { recursive: true }); fs.mkdirSync(workRoot, { recursive: true });
  sh(main, 'init', '-q');
  for (const [key, value] of Object.entries({ 'user.name': 'Fixture', 'user.email': 'fixture@localhost', 'core.hooksPath': '/dev/null', 'core.fsmonitor': 'false', 'core.untrackedCache': 'false' })) sh(main, 'config', key, value);
  for (const f of ['a.txt', 'b.txt']) fs.writeFileSync(path.join(main, f), 'base\n');
  sh(main, 'add', '.'); sh(main, 'commit', '-qm', 'base');
  const initial = sh(main, 'rev-parse', 'HEAD');
  sh(main, 'worktree', 'add', '-q', '-b', 'child', wd);
  fs.writeFileSync(path.join(wd, 'a.txt'), 'child\n'); sh(wd, 'add', '.'); sh(wd, 'commit', '-qm', 'child');
  const childHead = sh(wd, 'rev-parse', 'HEAD');
  if (mode === 'received') sh(main, 'merge', '--ff-only', '-q', childHead);
  else { fs.writeFileSync(path.join(main, mode === 'conflict' ? 'a.txt' : 'b.txt'), 'parent\n'); sh(main, 'add', '.'); sh(main, 'commit', '-qm', 'parent'); }
  const tasks = [{ id: 'parent', title: 'parent', completionHash: 'parent', workdir: '', steps: [] }, { id: 'child', title: 'child', parent: 'parent', completionHash: 'child', workdir: wd, steps: [{ text: 'done', done: true }], completionPending: true }];
  const p = { id, name: id, dir, folders: [{ label: '\u672c\u4f53', path: main }], related: [], tasks };
  fs.writeFileSync(path.join(dir, 'PROJECT.md'), 'fixture\n');
  const declared = '- \u672c\u4f53\u4fdd\u5b58\u6e08\u307f\uff1a.@' + childHead + '\uff08\u5c02\u7528\u30b3\u30d4\u30fcGit\u4fdd\u5b58\uff09';
  fs.writeFileSync(path.join(dir, '.ai/tasks/parent.md'), '## \u6210\u679c\n- \u306a\u3057\uff1a\u78ba\u8a8d\u306e\u307f\n');
  fs.writeFileSync(path.join(dir, '.ai/tasks/child.md'), '## \u6210\u679c\n' + declared + '\n');
  const store = { root, product: path.join(root, 'Product'), listProjects: () => [p], readProject: () => p, taskFile: (_, t) => path.join(dir, '.ai/tasks', t + '.md'), readTask: f => tasks.find(t => path.basename(f) === t.id + '.md') };
  const removal = new Removal({ store }), transfer = new TaskTransfer({ store, removal, baseOf: () => main });
  const results = transfer.results(p, tasks[1]);
  transfer.save({ id: 'received', project: id, task: 'child', complete: true, retained: true, received: [{ id: 'received', head: mode === 'received' ? childHead : initial, target: { project: id, task: 'parent', dir: main }, files: [], manifest: [], results, taskHash: 'child' }] });
  // Both status calls must inspect changed stat data without refreshing either index.
  for (const d of [main, wd]) for (const name of ['a.txt', 'b.txt']) {
    const f = path.join(d, name), s = fs.statSync(f); fs.utimesSync(f, s.atimeMs / 1000, s.mtimeMs / 1000 + 2);
  }
  return { root, main, wd, workRoot, initial, p, tasks, store, removal, transfer };
}
for (const mode of ['divergent', 'conflict', 'received']) test('background Git verification leaves index, objects, refs and ledger unchanged: ' + mode, async () => {
  const f = fixture(mode), view = new StateOffers({ transfer: f.transfer, removal: f.removal, baseOf: () => f.main });
  const oldLocks = process.env.GIT_OPTIONAL_LOCKS;
  process.env.GIT_OPTIONAL_LOCKS = '1'; // Worker must override this without changing the parent.
  const before = manifest(f.root);
  let report;
  try {
    const raw = view.view([f.p]); assert.equal(raw.find(r => r.task === 'child').pending, true);
    assert.equal(raw.find(r => r.task === 'child').receiptChecked, false, 'unchecked history is not a fresh offer');
    const deadline = Date.now() + 15000;
    while (view.pending && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
    assert.equal(view.pending, null, 'worker settled'); assert.equal(view.failed, null, 'worker succeeded');
    const after = manifest(f.root);
    report = { mode, fixture: f.root, before, after, added: Object.keys(after).filter(k => !(k in before)), removed: Object.keys(before).filter(k => !(k in after)), changed: Object.keys(before).filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k])) };
    assert.deepEqual({ added: report.added, removed: report.removed, changed: report.changed }, { added: [], removed: [], changed: [] }, 'no content, permission or stat changes anywhere in fixture');
    assert.equal(process.env.GIT_OPTIONAL_LOCKS, '1', 'main thread environment preserved');
    const row = view.cache.rows.find(r => r.task === 'child');
    assert.equal(row.pending, mode !== 'received'); assert.equal(row.received.pendingCommits, mode === 'received' ? 0 : 1);
    assert.equal(view.view([f.p]).find(r => r.task === 'child').receiptChecked, true);
    f.tasks[0].completionHash += '-changed';
    assert.equal(view.view([f.p]).find(r => r.task === 'child').receiptChecked, false, 'changed target invalidates the display evidence');
    assert.equal(view.issue(f.p, f.tasks[1]).ok, true, 'saved-copy declaration verified in worker');
    // A formal operation still performs a fresh conflict preview with the default Git implementation.
    if (mode === 'conflict') {
      const integrate = new TaskIntegrate({ store: f.store, transfer: f.transfer, removal: f.removal, baseOf: () => f.main });
      const item = integrate.details({ all: [f.p], p: f.p, t: f.tasks[0], target: f.main }, f.p, f.tasks[1]);
      assert.equal(item.receiptState.received, false);
      assert.equal(item.preview.conflict, true); assert.ok(item.preview.conflictPaths.includes('a.txt'));
      report.formalConflictPreview = { conflict: item.preview.conflict, paths: item.preview.conflictPaths };
    }
    report.ok = true;
  } finally {
    await view.close();
    if (oldLocks === undefined) delete process.env.GIT_OPTIONAL_LOCKS; else process.env.GIT_OPTIONAL_LOCKS = oldLocks;
    if (report) fs.writeFileSync(path.join(f.root, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
    // Keep these isolated fixtures as review evidence; no production repository is used.
  }
});
