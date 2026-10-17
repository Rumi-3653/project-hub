'use strict';
// File identity, overlapping directories and linked worktrees share a write scope.
const fs = require('node:fs'), path = require('node:path');
function canonical(dir) {
  if (!dir) return '';
  let tail = [], current = path.resolve(dir);
  for (;;) {
    try { return path.join(fs.realpathSync(current), ...tail).normalize('NFC'); }
    catch { const up = path.dirname(current); if (up === current) return path.resolve(dir).normalize('NFC'); tail.unshift(path.basename(current)); current = up; }
  }
}
const overlaps = (a, b) => Boolean(a && b && (a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)));
function commonGit(dir) {
  let current = canonical(dir);
  while (current) {
    const entry = path.join(current, '.git');
    try {
      let git = entry;
      if (fs.statSync(entry).isFile()) {
        const match = fs.readFileSync(entry, 'utf8').match(/^gitdir:\s*(.+)\s*$/m);
        if (!match) return '';
        git = path.resolve(current, match[1].trim());
      }
      const common = path.join(git, 'commondir');
      if (fs.existsSync(common)) git = path.resolve(git, fs.readFileSync(common, 'utf8').trim());
      return canonical(git);
    } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') return canonical(entry); }
    const up = path.dirname(current); if (up === current) break; current = up;
  }
  return '';
}
function resources(p, baseOf, expand = x => x) {
  const dirs = [...new Set([p.dir, baseOf(p), ...(p.tasks || []).map(t => expand(t.workdir))].filter(Boolean).map(canonical))];
  return { dirs, git: [...new Set(dirs.map(commonGit).filter(Boolean))] };
}
function shared(a, b) {
  return a.dirs.some(x => b.dirs.some(y => overlaps(x, y))) || a.git.some(x => b.git.includes(x));
}
function relatedProjects(project, all, baseOf, expand, hubDir, { hubGlobal = true } = {}) {
  const p = all.find(p => p.id === project);
  if (!p) return null; // Unknown scope stays globally protected.
  const own = resources(p, baseOf, expand);
  if (hubGlobal && (own.dirs.some(d => overlaps(d, canonical(hubDir))) || own.git.includes(commonGit(hubDir)) && commonGit(hubDir))) return null;
  return new Set(all.filter(q => q.id === project || shared(own, resources(q, baseOf, expand))).map(q => q.id));
}
module.exports = { canonical, overlaps, commonGit, resources, shared, relatedProjects };
