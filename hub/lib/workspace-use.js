'use strict';
// Cooperative single-writer lease, shared by the normal server and the trial.
// Publish before scanning: concurrent contenders either see the earlier lease
// or both refuse. Never remove another process's file, even after a crash.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { noLinks } = require('./license/storage');
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { if (e.code === 'ESRCH') return false; return true; }
}
function acquire(roots, options = {}) {
  const live = options.alive || alive, pid = options.pid || process.pid, held = [];
  const release = () => {
    for (const [file, bytes] of held.splice(0)) {
      try { noLinks(file); if (fs.readFileSync(file, 'utf8') === bytes) fs.unlinkSync(file); } catch { /* Keep uncertain evidence. */ }
    }
  };
  try {
    for (const root of [...new Set(roots.map(p => path.resolve(p)))].sort()) {
      noLinks(root); fs.mkdirSync(root, { recursive: true });
      const dir = path.join(root, '.project-hub-use'); noLinks(dir);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, pid + '-' + crypto.randomUUID() + '.json');
      const bytes = JSON.stringify({ version: 1, pid, token: crypto.randomUUID() });
      const fd = fs.openSync(file, 'wx', 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      held.push([file, bytes]);
      for (const name of fs.readdirSync(dir)) {
        if (!/^\d+-[a-f0-9-]+\.json$/.test(name)) throw Error('workspace_use_unknown');
        const other = path.join(dir, name); if (other === file) continue;
        noLinks(other);
        let row;
        try {
          const s = fs.lstatSync(other); if (!s.isFile() || s.nlink !== 1 || s.size > 1024) throw Error('invalid');
          row = JSON.parse(fs.readFileSync(other));
          if (row.version !== 1 || !Number.isSafeInteger(row.pid) || row.pid < 1 || !/^[a-f0-9-]{36}$/.test(row.token)) throw Error('invalid');
        } catch (e) { if (e.code === 'ENOENT') continue; throw Error('workspace_use_unknown'); }
        if (live(row.pid)) throw Error('workspace_in_use');
      }
    }
    return { release };
  } catch (e) { release(); throw e; }
}
module.exports = { acquire };
