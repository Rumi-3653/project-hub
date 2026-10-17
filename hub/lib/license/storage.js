'use strict';
const fs = require('node:fs'), path = require('node:path'), c = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
function noLinks(file) {
  let p = path.parse(path.resolve(file)).root;
  for (const part of path.resolve(file).slice(p.length).split(path.sep).filter(Boolean)) {
    p = path.join(p, part);
    try { if (fs.lstatSync(p).isSymbolicLink()) throw Error('license_storage_link'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}
class LicenseStore {
  constructor(root) { this.home = path.join(root, '_hub', 'license'); }
  read(name) {
    const file = path.join(this.home, name + '.json'); noLinks(file);
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw Error('license_storage_read'); }
  }
  write(name, value) {
    const file = path.join(this.home, name + '.json'); noLinks(file);
    fs.mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const temp = file + '.' + c.randomUUID() + '.tmp';
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, file);
      const dir = fs.openSync(this.home, 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    } catch { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch {} throw Error('license_storage_write'); }
  }
}
// Private keys travel only through pipes. No command arguments or environment.
class MacSecretStore {
  constructor({ run = execFileSync, platform = process.platform } = {}) { this.run = run; this.platform = platform; }
  call(request) {
    if (this.platform !== 'darwin') throw Error('secret_store_unavailable');
    try {
      const binary = path.join(__dirname, 'mac-native');
      const compiled = fs.existsSync(binary);
      const out = this.run(compiled ? binary : '/usr/bin/swift', compiled ? [] : [path.join(__dirname, 'mac-native.swift')], {
        input: JSON.stringify(request), encoding: 'utf8', timeout: 30000, maxBuffer: 8192,
        stdio: ['pipe', 'pipe', 'pipe'] });
      return JSON.parse(out);
    } catch { throw Error('secret_store_unavailable'); }
  }
  get(account) { return this.call({ action: 'get', account }).value; }
  put(account, value) { this.call({ action: 'put', account, value }); }
  elapsed() { const n = this.call({ action: 'clock' }).seconds; if (!Number.isFinite(n)) throw Error('elapsed_clock_unavailable'); return n; }
  watchResume(onResume, onError) {
    if (this.platform !== 'darwin') return null;
    const binary = path.join(__dirname, 'mac-native'), compiled = fs.existsSync(binary);
    const child = spawn(compiled ? binary : '/usr/bin/swift', compiled ? [] : [path.join(__dirname, 'mac-native.swift')], { stdio: ['pipe','pipe','ignore'] });
    let rest = '', stopping = false;
    child.stdout.on('data', data => {
      rest += data.toString('utf8');
      const lines = rest.split('\n'); rest = lines.pop();
      for (const line of lines) { try { if (JSON.parse(line).event === 'resume') onResume(); } catch { onError?.(); } }
    });
    child.on('error', () => onError?.());
    child.on('exit', () => { if (!stopping) onError?.(); });
    child.stdin.on('error', () => onError?.());
    child.stdin.end(JSON.stringify({ action: 'watch' }));
    return () => { stopping = true; child.kill(); };
  }
}
module.exports = { LicenseStore, MacSecretStore, noLinks };
