'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events'), { createRequire } = require('node:module');

// Execute the actual module with simulated OS APIs; never launch an AI or taskkill.
function load(name, { platform = 'win32', env = {}, mocks = {}, extra = '', globals = {} } = {}) {
  const file = path.resolve(__dirname, '../lib', name), native = createRequire(file);
  const module = { exports: {} }, proc = Object.assign(new EventEmitter(), { platform, env, argv: [], pid: 71, execPath: 'C:\\node\\node.exe' });
  const requireMock = id => Object.hasOwn(mocks, id) ? mocks[id] : id === './locale' ? { lt: x => x } : native(id);
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + '\n' + extra,
    { module, exports: module.exports, require: requireMock, process: proc, __filename: file, __dirname: path.dirname(file), Buffer, console, setInterval, clearInterval, ...globals }, { filename: file });
  return module.exports;
}

test('Mac CLI lookup preserves the original command/args and does not probe Hub PATH', () => {
  const api = load('launch.js', { platform: 'darwin', env: { PATH: '/host' }, mocks: { fs: { accessSync() { throw Error('must not probe'); } } } });
  const args = ['--prompt', 'quotes " and $ remain literal'];
  const result = api.resolveCli('codex', args, { PATH: '/request' });
  assert.equal(result.file, 'codex'); assert.equal(result.args, args);
});

test('Windows resolves the request PATH and expands npm shims without a shell', () => {
  const files = new Map([
    ['C:\\request\\codex.cmd', '"%dp0%\\node_modules\\codex.js" %*'],
    ['C:\\request\\node_modules\\codex.js', ''], ['C:\\host\\codex.exe', '']
  ]);
  const api = load('launch.js', { env: { PATH: 'C:\\host' }, mocks: { path: path.win32, fs: {
    constants: fs.constants, accessSync(f) { if (!files.has(f)) throw Error('missing'); },
    existsSync: f => files.has(f), statSync: () => ({ isFile: () => true }), readFileSync: f => files.get(f)
  } } });
  const args = ['literal & | % " prompt'];
  const result = api.resolveCli('codex', args, { PATH: 'C:\\request' });
  assert.equal(result.file, 'C:\\node\\node.exe');
  assert.deepEqual(Array.from(result.args), ['C:\\request\\node_modules\\codex.js', ...args]);
});

test('Account status launches pass the account environment to CLI resolution', async () => {
  const env = { PATH: '/account/bin', ACCOUNT_MARKER: 'fixture' }, args = ['--version'];
  const calls = [];
  const api = load('accounts.js', { extra: 'module.exports.testRun = run;', mocks: {
    './launch': { resolveCli(file, a, e) { assert.equal(e, env); assert.equal(a, args); return { file: '/account/cli', args: a }; } },
    'node:child_process': { execFile(file, a, options, done) { calls.push({ file, a, options }); done(null, 'fixture', ''); } }
  } });
  assert.equal((await api.testRun('codex', args, env)).stdout, 'fixture');
  assert.equal(calls[0].file, '/account/cli'); assert.equal(calls[0].options.env, env);
});

test('Windows terminal operations use the guarded platform adapter without writing scripts or launching a fallback', async () => {
  const calls = [];
  const guarded = require('../lib/platform/win32').create({ native: {
    call() { assert.fail('unsupported terminal must not invoke native auth'); },
    asyncCall() { assert.fail('unsupported terminal must not launch a process'); }
  } });
  const api = load('launch.js', { mocks: { './platform': guarded,
    fs: { writeFileSync() { calls.push('write'); } },
    child_process: { spawn() { calls.push('spawn'); } }
  } });
  await assert.rejects(api.openTerminal('echo "$literal"', false), e => e.code === 'platform_unsupported');
  assert.deepEqual(calls, []);
});

function spoolFixture({ captureFails = false } = {}) {
  const cli = Object.assign(new EventEmitter(), { pid: 92, exitCode: null, signalCode: null });
  cli.stdin = Object.assign(new EventEmitter(), { end() {} }); cli.stdout = new EventEmitter(); cli.stderr = new EventEmitter();
  let tick, cancel; const signals = [], spawned = [], synced = [];
  const fakeFs = { ...fs, openSync: () => 42, closeSync() {}, renameSync() {}, writeFileSync() {},
    writeSync() {}, fsyncSync: fd => synced.push(fd), readFileSync(file) {
      if (file.endsWith('request.json')) return JSON.stringify({ options: { dir: '/fixture' }, turn: { command: 'fixture-cli', args: [] } });
      if (file.endsWith('cancel.json')) { if (cancel) return JSON.stringify(cancel); throw Object.assign(Error('missing'), { code: 'ENOENT' }); }
      return fs.readFileSync(file);
    }
  };
  const owned = { assertLaunchOwnership() {}, capture(pid) { assert.equal(pid, 92); if (captureFails) throw Error('identity unavailable'); return { pid }; },
    OwnedProcesses: class { collect() {} signal(value) { signals.push(value); throw Error('identity changed or process exited'); } } };
  const api = load('cli-spool.js', { extra: 'module.exports.testWorker = worker;', mocks: {
    'node:fs': fakeFs,
    './platform': { supervisorFiles: [], persistence: { syncDirectory: dir => { assert.equal(dir, '/fixture'); } } },
    [path.resolve(__dirname, '../lib/owned-processes.cjs')]: owned,
    'node:child_process': { spawn(file) { spawned.push(file); assert.equal(file, 'fixture-cli'); return cli; } }
  }, globals: { setInterval: fn => { tick = fn; return 1; }, clearInterval() {} } });
  api.testWorker('/fixture'); cli.emit('spawn');
  return { cli, signals, spawned, stop(n) { cancel = { n, signal: 'SIGTERM' }; tick(); } };
}

test('Windows spool cancellation never falls back to taskkill when ownership capture fails', () => {
  const f = spoolFixture({ captureFails: true }); f.stop(1); f.stop(2);
  assert.equal(f.signals.length, 0); assert.deepEqual(f.spawned, ['fixture-cli']);
});
test('Windows spool uses ownership validation and propagates no unchecked kill after identity loss or exit', () => {
  for (const state of ['running', 'exitCode', 'signalCode', 'close']) {
    const f = spoolFixture();
    if (state === 'exitCode') f.cli.exitCode = 0;
    if (state === 'signalCode') f.cli.signalCode = 'SIGTERM';
    if (state === 'close') f.cli.emit('close', 0, null);
    f.stop(1);
    assert.deepEqual(f.signals, ['SIGTERM']); assert.deepEqual(f.spawned, ['fixture-cli']);
  }
});

test('Windows durable writes retain file sync and strict platform directory sync; both failures propagate', () => {
  const handles = [], error = Object.assign(Error('file sync failed'), { code: 'EPERM' });
  let fail = false, failDirectory = false, renamed = 0, synced = 0, directories = 0;
  const fakeFs = { ...fs, mkdirSync() {}, openSync(file, flags) { handles.push(flags); return 42; }, closeSync() {}, writeFileSync() {},
    fsyncSync() { synced++; if (fail) throw error; }, renameSync() { renamed++; } };
  const persistence = { syncDirectory(dir) { assert.equal(dir, '/fixture'); directories++; if (failDirectory) throw Error('native directory sync failed'); } };
  const originalSync = fakeFs.fsyncSync;
  const api = load('cli-spool.js', { mocks: { 'node:fs': fakeFs, './platform': { supervisorFiles: [], persistence } } });
  assert.equal(fakeFs.fsyncSync, originalSync);
  api.atomic('/fixture', 'saved.json', { ok: true });
  assert.deepEqual(handles, ['wx']); assert.equal(synced, 1); assert.equal(renamed, 1); assert.equal(directories, 1);
  fail = true; assert.throws(() => api.atomic('/fixture', 'saved.json', {}), e => e === error);
  assert.equal(renamed, 1); assert.equal(directories, 1);
  fail = false; failDirectory = true;
  assert.throws(() => api.atomic('/fixture', 'saved.json', {}), /native directory sync failed/);
  const safe = load('safe-file.js', { mocks: { './platform': { persistence } } });
  assert.throws(() => safe.syncDirectory('/fixture/file'), /native directory sync failed/);
});
