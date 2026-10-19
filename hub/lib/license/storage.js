'use strict';
const fs = require('node:fs'), path = require('node:path'), c = require('node:crypto');
const platforms = require('../platform');
const { MacSecretStore } = platforms;
function noLinks(file) {
  let p = path.parse(path.resolve(file)).root;
  for (const part of path.resolve(file).slice(p.length).split(path.sep).filter(Boolean)) {
    p = path.join(p, part);
    try { if (fs.lstatSync(p).isSymbolicLink()) throw Error('license_storage_link'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}
class LicenseStore {
  constructor(root, platform = platforms) { this.home = path.join(root, '_hub', 'license'); this.platform = platform; }
  read(name) {
    if (this.platform.name === 'win32') return require('./windows-storage').access(this.home, this.platform, name);
    const file = path.join(this.home, name + '.json'); noLinks(file);
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw Error('license_storage_read'); }
  }
  write(name, value) {
    if (this.platform.name === 'win32') return require('./windows-storage').access(this.home, this.platform, name, value);
    const file = path.join(this.home, name + '.json'); noLinks(file);
    fs.mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const temp = file + '.' + c.randomUUID() + '.tmp';
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, file);
      this.platform.persistence.syncDirectory(this.home);
    } catch { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch {} throw Error('license_storage_write'); }
  }
}
module.exports = { LicenseStore, MacSecretStore, noLinks };
