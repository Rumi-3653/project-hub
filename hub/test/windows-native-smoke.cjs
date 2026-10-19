'use strict';
// Opt-in on the real Windows PC: node test/windows-native-smoke.cjs
// Uses only temporary test data and one harmless Node child, no AI/network/UAC.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process');
const { performance } = require('node:perf_hooks');
const report = { timingsMs: {}, platform: process.platform, architecture: process.arch, windowsRelease: os.release(), node: process.versions.node, checks: {}, windowsCertification: false };
let directory;
async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('この確認はWindows x64 PCで実行してください');
  const p = require('../lib/platform'), P = require('../lib/owned-processes');
  let began = performance.now();
  P.assertLaunchOwnership(p); report.checks.strongSelfIdentityObserved = true;
  report.timingsMs.firstOwnershipIncludingCompile = Math.round(performance.now() - began);
  began = performance.now(); P.assertLaunchOwnership(p);
  report.timingsMs.repeatedOwnership = Math.round(performance.now() - began);
  const parent = fs.realpathSync(os.tmpdir());
  began = performance.now();
  p.persistence.syncDirectory(parent); report.checks.existingVolumeFlushObserved = true;
  report.timingsMs.volumeFlush = Math.round(performance.now() - began);
  directory = fs.mkdtempSync(path.join(parent, 'hub-windows-native-'));
  p.persistence.syncDirectory(parent);
  const source = path.join(directory, 'before.txt'), saved = path.join(directory, 'saved.txt');
  const bytes = 'Windows native trial 日本語 ' + Date.now();
  const fd = fs.openSync(source, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  p.persistence.syncFile(source); report.checks.writableFileFlushObserved = true;
  fs.renameSync(source, saved); p.persistence.syncDirectory(directory);
  const cold = cp.execFileSync(process.execPath, ['-e', 'process.stdout.write(require("node:fs").readFileSync(process.argv[1]))', saved], { encoding: 'utf8', timeout: 10000 });
  if (cold !== bytes) throw Error('別プロセスで読み直した内容が一致しません');
  report.checks.renameColdReadMatched = true;
  p.persistence.withDirectorySync(directory, () => fs.unlinkSync(saved));
  report.checks.beforeAfterRemovalFlushObserved = true;
  const child = cp.spawn(process.execPath, ['-e', 'setTimeout(()=>process.exit(0),60000)'], { stdio: 'ignore', shell: false });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  report.checks.harmlessChildIdentityCaptured = Boolean(P.capture(child.pid));
  p.killTree(child, 'SIGKILL', { fallback: false });
  await exited; report.checks.limitedChildStopObserved = true;
  report.completed = true;
}
main().catch(error => { report.completed = false; report.error = error.message; process.exitCode = 1; }).finally(() => {
  if (directory) {
    try { fs.rmSync(directory, { recursive: true }); require('../lib/platform').persistence.syncDirectory(path.dirname(directory)); report.temporaryCleanupConfirmed = true; }
    catch (error) { report.temporaryCleanupConfirmed = false; report.cleanupError = error.message; process.exitCode = 1; }
  }
  console.log(JSON.stringify(report, null, 2));
});
