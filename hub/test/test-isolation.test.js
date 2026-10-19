'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const cp = require('node:child_process');
test('test entry refuses missing or incomplete isolation before any tests start', () => {
  const source = fs.readFileSync(path.join(__dirname, 'execute.cjs'), 'utf8');
  let started = 0;
  const requireEntry = name => name === 'node:child_process' ? { spawnSync: () => { started++; } } : name === './offline.cjs' ? { assertInstalled: () => { throw Error('test_isolation_incomplete'); } } : require(name);
  for (const state of [{}, { [Symbol.for('hub.test.offline')]: {} }]) {
    assert.throws(() => vm.runInNewContext(source, { require: requireEntry, process: state, __dirname, Symbol }), /test_isolation_(not_preloaded|incomplete)/);
  }
  assert.equal(started, 0);
});
test('test preload blocks external fetch, TCP and UDP before connecting', () => {
  assert.equal(require('./offline.cjs').assertInstalled(), true);
  assert.throws(() => fetch('https://issuer.invalid/trial'), /test_offline_external_fetch/);
  const socket = new (require('node:net').Socket)();
  assert.throws(() => socket.connect(443, 'issuer.invalid'), /test_offline_external_socket/); socket.destroy();
  const udp = require('node:dgram').createSocket('udp4');
  assert.throws(() => udp.send('no', 9, '192.0.2.1'), /test_offline_udp/); udp.close();
});
test('child environment cannot accidentally drop the preload', () => {
  const result = cp.spawnSync(process.execPath, ['-e', 'require(process.argv[1]).assertInstalled();console.log("isolated-child")', path.join(__dirname, 'offline.cjs')], { env: { PATH: process.env.PATH, NODE_OPTIONS: '' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /isolated-child/);
});
test('wrapped child commands preserve Node promisify output and error contracts', async () => {
  const { promisify } = require('node:util');
  for (const name of ['execFile', 'exec']) {
    const invoke = name === 'execFile' ? code => promisify(cp[name])(process.execPath, ['-e', code])
      : code => promisify(cp[name])(JSON.stringify(process.execPath) + ' -e ' + "'" + code + "'");
    const promise = invoke('process.stdout.write("out");process.stderr.write("err")');
    assert.ok(promise.child.pid);
    assert.deepEqual(await promise, { stdout: 'out', stderr: 'err' });
    await assert.rejects(invoke('process.stdout.write("out");process.stderr.write("err");process.exit(3)'), error => error.code === 3 && error.stdout === 'out' && error.stderr === 'err');
  }
});
test('test entry rejects an overwritten guard before loading a requested test', () => {
  const result = cp.spawnSync(process.execPath, ['-e', 'global.fetch=()=>{};require(process.argv[1])', path.join(__dirname, 'execute.cjs'), 'test/never-started.test.js'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /test_isolation_incomplete/);
  assert.doesNotMatch(result.stderr, /never-started.*(not found|ENOENT)/);
});
test('default license prepare and device identity cannot touch native secrets', async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-offline-license-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { License } = require('../lib/license'), { MacSecretStore } = require('../lib/platform');
  const client = new License({ root, owner: false });
  const before = client.status(); await client.prepare(); assert.deepEqual(client.status(), before);
  assert.throws(() => client.ensureIdentity(), /test_offline_native_identity/);
  assert.throws(() => new MacSecretStore().put('not-created', 'not-a-key'), /test_offline_native_secret/);
  assert.equal(fs.existsSync(path.join(root, '_hub/license/device.json')), false);
  // A caller-supplied in-memory native runner remains a harmless unit fixture.
  let called = false;
  new MacSecretStore({ run: () => { called = true; return '{}'; } }).put('fixture', 'fixture');
  assert.equal(called, true);
});
test('OS isolation also denies native Keychain paths in a disposable fixture', t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-offline-os-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'Library'));
  assert.throws(() => fs.mkdirSync(path.join(root, 'Library/Keychains')), /EPERM|EACCES/);
});

test('read-only process broker retains real ownership and rejects other commands', async () => {
  const child = cp.spawn(process.execPath, ['-e', 'setTimeout(()=>{},5000)']);
  try {
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    const identity = require('../lib/owned-processes').capture(child.pid);
    assert.equal(identity.pid, child.pid); assert.equal(identity.uid, process.getuid());
    const denied = cp.spawnSync(process.execPath, [path.join(__dirname, 'process-list.cjs'), '-e', 'not-a-process-format'], { encoding: 'utf8' });
    assert.equal(denied.status, 1); assert.match(denied.stderr, /test_process_arguments_rejected/);
  } finally { child.kill('SIGTERM'); }
});

// Inspect only the langpack command; the dedicated translated suite is not run.
test('langpack script uses the same launcher and refuses absent OS isolation before starting', () => {
  const command = require('../package.json').scripts['test:langpack'];
  assert.equal(command, 'node test/run.cjs ../langpacks/zh-TW/test/*.test.js');
  const source = fs.readFileSync(path.join(__dirname, 'run.cjs'), 'utf8');
  let started = 0;
  const fakeRequire = name => name === 'node:fs' ? { existsSync: () => false }
    : name === 'node:child_process' ? { spawn: () => started++ } : require(name);
  assert.throws(() => vm.runInNewContext(source, {
    require: fakeRequire, process: { platform: 'darwin' }, __dirname,
  }), /test_isolation_unavailable/);
  assert.equal(started, 0);
});
