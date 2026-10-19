'use strict';
process.env.HUB_LANG = 'ja';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const platforms = require('../lib/platform');
const win32 = require('../lib/platform/win32');
const WINDOWS_ONLY = process.platform === 'win32' ? false : 'Windows only: starts real programs';

// Files keyed case-insensitively, as on NTFS. Fixture shims copy npm's formats.
function fakeFs(files) {
  const map = new Map(Object.entries(files).map(([k, v]) => [k.toLowerCase(), v]));
  const missing = () => Object.assign(Error('missing'), { code: 'ENOENT' });
  return {
    statSync: f => { if (!map.has(f.toLowerCase())) throw missing(); return { isFile: () => true }; },
    readFileSync: f => { if (!map.has(f.toLowerCase())) throw missing(); return map.get(f.toLowerCase()); },
  };
}
const NODE_SHIM = js => `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${js}" %*\r\n`;
const EXE_SHIM = exe => `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\${exe}"   %*\r\n`;
const NPM_CMD = '@ECHO OFF\r\nSETLOCAL\r\nSET "NODE_EXE=%~dp0\\node.exe"\r\nSET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"\r\nSET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"\r\nFOR /F "delims=" %%F IN (\'CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"\') DO (\r\n  SET "NPM_PREFIX_NPM_CLI_JS=%%F\\node_modules\\npm\\bin\\npm-cli.js"\r\n)\r\n"%NODE_EXE%" "%NPM_CLI_JS%" %*\r\n';
const NPM = 'C:\\Users\\u\\AppData\\Roaming\\npm', NODE = 'C:\\Program Files\\nodejs', EXEC = 'C:\\Program Files\\nodejs\\node.exe';
const files = {
  [`${NPM}\\codex`]: '#!/bin/sh\n', [`${NPM}\\codex.cmd`]: NODE_SHIM('node_modules\\@openai\\codex\\bin\\codex.js'),
  [`${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`]: '',
  [`${NPM}\\claude.cmd`]: EXE_SHIM('node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'),
  [`${NPM}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`]: '',
  [`${NPM}\\unknown.cmd`]: '@ECHO off\r\ncall some-tool %*\r\n', [`${NPM}\\gone.cmd`]: NODE_SHIM('node_modules\\gone\\cli.js'),
  [`${NODE}\\npm.cmd`]: NPM_CMD, [`${NODE}\\node_modules\\npm\\bin\\npm-prefix.js`]: '', [`${NODE}\\node_modules\\npm\\bin\\npm-cli.js`]: '',
  'C:\\Tools\\git.exe': '', 'C:\\Tools\\tool.com': '', 'C:\\Tools\\tool.exe': '',
};
const PATH = `${NPM};;${NODE};C:\\Tools`;
const adapter = (extra = {}) => win32.create({ fs: fakeFs(files), env: { PATH }, execPath: EXEC, ...extra });

test('Windows lookup searches PATH with Windows extensions only, never the current directory', () => {
  const p = adapter();
  assert.equal(p.findExecutable('codex', PATH), `${NPM}\\codex.cmd`); // not npm's extensionless sh shim
  assert.equal(p.findExecutable('git', PATH), 'C:\\Tools\\git.exe');
  assert.equal(p.findExecutable('tool', PATH), 'C:\\Tools\\tool.com'); // .com before .exe, as CreateProcess
  assert.equal(p.findExecutable('git.exe', PATH), 'C:\\Tools\\git.exe');
  assert.equal(p.findExecutable(`${NPM}\\claude`, ''), `${NPM}\\claude.cmd`);
  assert.equal(p.findExecutable(`${NPM}\\codex`, ''), `${NPM}\\codex.cmd`);
  assert.equal(p.findExecutable('git', ''), null); assert.equal(p.findExecutable('missing', PATH), null);
  assert.equal(p.findExecutable('', PATH), null); assert.equal(p.findExecutable(undefined, PATH), null);
});

test('Windows CLI resolution starts the program a npm shim names, never cmd.exe', () => {
  const p = adapter(), args = ['--print', 'a & b | c', '%PATH%', '"quoted"', '^'];
  assert.deepEqual(p.resolveCommand('codex', args), { file: EXEC, args: [`${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`, ...args] });
  assert.deepEqual(p.resolveCommand('claude', args), { file: `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`, args });
  assert.deepEqual(p.resolveCommand(`${NPM}\\claude.cmd`, []), { file: `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`, args: [] });
  // npm.cmd runs npm-prefix.js first; the CLI is the last program it starts.
  assert.deepEqual(p.resolveCommand('npm', ['run', 'x']), { file: EXEC, args: [`${NODE}\\node_modules\\npm\\bin\\npm-cli.js`, 'run', 'x'] });
  assert.deepEqual(p.resolveCommand('git', ['status']), { file: 'C:\\Tools\\git.exe', args: ['status'] });
  // The environment's PATH is the default; an explicit PATH wins.
  assert.deepEqual(p.resolveCommand('git', [], NPM), { file: 'git', args: [] });
});

test('Windows CLI resolution leaves unknown and broken shims to fail at launch', () => {
  const p = adapter();
  // Node refuses to start a .cmd without a shell (EINVAL); no shell is added here.
  assert.deepEqual(p.resolveCommand('unknown', ['x']), { file: `${NPM}\\unknown.cmd`, args: ['x'] });
  assert.deepEqual(p.resolveCommand('gone', ['x']), { file: `${NPM}\\gone.cmd`, args: ['x'] });
  assert.deepEqual(p.resolveCommand('missing', ['x']), { file: 'missing', args: ['x'] });
  for (const name of ['codex', 'claude', 'npm', 'unknown', 'gone', 'missing']) assert.doesNotMatch(p.resolveCommand(name, []).file, /cmd\.exe$/i);
});

test('Windows saving fails closed: no flush is reported as done and the operation never runs', () => {
  const p = adapter(), touched = [];
  const io = new Proxy({}, { get: (_, key) => (...args) => { touched.push(key); return key === 'openSync' ? 3 : undefined; } });
  const unsupported = { code: 'persistence_unsupported', platform: 'win32' };
  let ran = false;
  assert.throws(() => p.persistence.withDirectorySync('C:\\data', () => { ran = true; }, io), unsupported);
  assert.throws(() => p.persistence.syncDirectory('C:\\data', io), unsupported);
  assert.throws(() => p.persistence.syncFile('C:\\data\\file.json', io), unsupported);
  assert.equal(ran, false); assert.deepEqual(touched, []);
  // Same result with the real file system and the adapter Hub selects on Windows.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'win32-persistence-'));
  try {
    assert.throws(() => win32.persistence.withDirectorySync(dir, () => { ran = true; }), unsupported);
    assert.throws(() => win32.persistence.syncDirectory(dir), unsupported);
    assert.equal(ran, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Windows process ownership stays unavailable, so launches and stop proofs fail closed', async () => {
  const p = adapter({ execFileSync: () => assert.fail('no process query'), execFile: () => assert.fail('no process query') });
  assert.throws(() => p.processSnapshot(), /このOSではプロセスの所有確認に対応していません/);
  assert.throws(() => p.processOwner({ uid: 501 }), { code: 'platform_unsupported' });
  assert.throws(() => p.currentProcessOwner(), { code: 'platform_unsupported' });
  assert.equal(p.processBirth(process.pid), '');
  await assert.rejects(p.listProcesses(), { code: 'platform_unsupported' });
  await assert.rejects(p.processCwd([process.pid]), { code: 'platform_unsupported' });
  const P = require('../lib/owned-processes');
  assert.throws(() => P.assertLaunchOwnership(p), /このOSではプロセスの所有確認に対応していません/);
  assert.throws(() => P.capture(process.pid, [{ pid: process.pid, uid: 501, since: 'x', command: 'node' }], p), { code: 'platform_unsupported' });
});

test('Windows killTree signals only the held child handle, never a PID', () => {
  const p = adapter({ kill: () => assert.fail('PID signal') }), sent = [];
  const child = { pid: 4242, kill: signal => { sent.push(signal); return true; } };
  assert.throws(() => p.killTree(child, 'SIGKILL', { fallback: false }), { code: 'platform_unsupported' });
  assert.deepEqual(sent, []);
  assert.equal(p.killTree(child, 'SIGTERM'), true); assert.equal(p.killTree(child), true);
  assert.deepEqual(sent, ['SIGTERM', 'SIGKILL']);
});

test('Windows adapter is selected only for win32 and pins its supervisor files', () => {
  const p = platforms.forPlatform('win32');
  assert.equal(p, win32); assert.equal(p.name, 'win32');
  assert.deepEqual(p.supervisorFiles, ['win32.js', 'darwin.js', 'persistence.js']); assert.equal(Object.isFrozen(p.supervisorFiles), true);
  assert.equal(platforms.forPlatform('linux').name, 'linux');
  // macOS and Linux launch exactly what callers name.
  const args = ['--print'];
  for (const name of ['darwin', 'linux']) assert.deepEqual(platforms.createDarwin({ name }).resolveCommand('claude', args), { file: 'claude', args });
  assert.equal(p.trashDir('C:\\Users\\u'), 'C:\\Users\\u\\.Trash');
  assert.equal(adapter().trashRootFor('C:\\work\\a', 'D:\\bin'), 'D:\\bin');
  assert.deepEqual(p.shellCandidates(), []);
});

test('Windows real machine: resolved npm shims run without a shell and keep arguments intact', { skip: WINDOWS_ONLY }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'win32-shim-'));
  try {
    fs.mkdirSync(path.join(dir, 'node_modules', 'echo-args'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'echo-args', 'cli.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
    fs.writeFileSync(path.join(dir, 'echo-args.cmd'), NODE_SHIM('node_modules\\echo-args\\cli.js'));
    const args = ['a & b | c', '%PATH%', '"quoted"', '^', 'two words', ''];
    const cli = win32.resolveCommand('echo-args', args, dir);
    assert.equal(cli.file, process.execPath);
    assert.deepEqual(JSON.parse(execFileSync(cli.file, cli.args, { encoding: 'utf8' })), args);
    // Unresolved .cmd files are refused by Node instead of running through cmd.exe.
    fs.writeFileSync(path.join(dir, 'opaque.cmd'), '@echo off\r\necho should-not-run\r\n');
    assert.throws(() => execFileSync(...Object.values(win32.resolveCommand('opaque', [], dir))), { code: 'EINVAL' });
    const npm = win32.resolveCommand('npm', ['--version']);
    assert.match(execFileSync(npm.file, npm.args, { encoding: 'utf8' }), /^\d+\.\d+\.\d+/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
