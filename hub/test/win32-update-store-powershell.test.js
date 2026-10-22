'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const filename = path.resolve(__dirname, '../lib/platform/win32-update-store.js');
function fixture(env, run, validate) {
  const originalRequire = createRequire(filename), calls = [], native = [];
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, process: { env },
    require(id) {
      if (id === './index') return { licenseDirectory(home) { native.push(home); validate?.(home); } };
      if (id === 'node:child_process') return { execFileSync(...args) { calls.push(args); return run?.(...args) ?? 'ok'; } };
      return originalRequire(id);
    },
  }, { filename });
  return { guard: module.exports.privateDirectory, calls, native };
}
test('ACL child ignores inherited PowerShell 7 module paths without changing parent environment or policy', () => {
  for (const systemRoot of ['C:\\Windows', 'D:\\Windows']) {
    const env = Object.freeze({ SystemRoot: systemRoot, PSModulePath: 'C:\\Codex\\PowerShell\\7\\Modules',
      PsModulePath: 'C:\\untrusted\\Modules', PATH: 'keep-path', TEMP: 'keep-temp', PSExecutionPolicyPreference: 'Restricted' });
    const before = { ...env }, f = fixture(env);
    f.guard('C:\\recipient\\_hub\\updates\\windows', false);
    assert.equal(f.calls.length, 1); assert.equal(f.native.length, 1);
    const [exe, args, options] = f.calls[0];
    assert.equal(exe, path.win32.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'));
    const keys = Object.keys(options.env).filter(key => key.toLowerCase() === 'psmodulepath');
    assert.deepEqual(keys, ['PSModulePath']);
    assert.equal(options.env.PSModulePath, path.win32.join(path.win32.dirname(exe), 'Modules'));
    assert.equal(options.env.PATH, env.PATH); assert.equal(options.env.TEMP, env.TEMP);
    assert.equal(options.env.PSExecutionPolicyPreference, 'Restricted');
    assert.deepEqual({ ...env }, before);
    assert.deepEqual(Array.from(args.slice(0, -1)), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
    assert.doesNotMatch(args.join(' '), /ExecutionPolicy|Bypass|Set-ExecutionPolicy|Unblock-File/);
    assert.equal(options.shell, false);
    assert.deepEqual(JSON.parse(options.input), { path: 'C:\\recipient\\_hub\\updates\\windows', create: false });
    assert.match(args.at(-1), /Get-Acl -LiteralPath/);
    assert.match(args.at(-1), /update_parent_owner/); assert.match(args.at(-1), /update_parent_acl/);
    assert.match(args.at(-1), /AreAccessRulesProtected/);
  }
});
test('ACL rejection or OS module failure stops after one invocation with no fallback', () => {
  const error = Object.assign(Error('OS module unavailable or ACL denied'), { code: 'ACCESS_DENIED' });
  const f = fixture({ SystemRoot: 'C:\\Windows' }, () => { throw error; });
  assert.throws(() => f.guard('C:\\recipient\\updates', true), e => e === error);
  assert.equal(f.calls.length, 1);
  const unexpected = fixture({ SystemRoot: 'C:\\Windows' }, () => 'not-ok');
  assert.throws(() => unexpected.guard('C:\\recipient\\updates', true), /update_acl/);
  assert.equal(unexpected.calls.length, 1);
});
test('native directory rejection still stops before PowerShell is invoked', () => {
  const error = Error('native path identity rejected');
  const f = fixture({}, undefined, () => { throw error; });
  assert.throws(() => f.guard('C:\\recipient\\updates', false), e => e === error);
  assert.equal(f.native.length, 1); assert.equal(f.calls.length, 0);
});
