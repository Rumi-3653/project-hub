'use strict';
// Windows primitives: CLI lookup/launch and the plain trash folder. Everything
// else keeps the shared factory's fail-closed result. Saving reports
// persistence_unsupported (no native flush yet) and process ownership is
// unavailable, so stop proofs and queued continuation stay conservative.
// Detached supervisors copy this file with darwin.js and persistence.js.
const path = require('node:path').win32;
const darwin = require('./darwin');
const EXTS = ['.com', '.exe', '.bat', '.cmd'];

function create(options = {}) {
const name = 'win32';
const base = darwin.create({ ...options, name });
const fs = options.fs || require('node:fs');
const os = options.os || require('node:os');
const env = options.env || process.env;
const execPath = options.execPath || process.execPath;
function unsupported() { return Object.assign(Error('platform_unsupported'), { code: 'platform_unsupported', platform: name }); }
const isFile = f => { try { return fs.statSync(f).isFile(); } catch { return false; } };
// No current-directory search. Extensionless files (npm's sh shims) are not programs here.
function findExecutable(cmd, envPath) {
  if (typeof cmd !== 'string' || !cmd) return null;
  const exts = path.extname(cmd) ? [''] : EXTS;
  const dirs = /[\\/]/.test(cmd) ? [''] : String(envPath || '').split(';').filter(Boolean);
  for (const d of dirs) for (const e of exts) { const f = d ? path.join(d, cmd + e) : cmd + e; if (isFile(f)) return f; }
  return null;
}
// npm installs CLIs as .cmd shims. Node does not start .cmd/.bat without a
// shell, and cmd.exe would re-parse prompts. Start the program the shim names
// instead; an unrecognised shim is returned as is, so Node refuses the launch.
function resolveCommand(file, args = [], envPath = env.PATH) {
  const found = findExecutable(file, envPath);
  if (!found) return { file, args };
  const target = /\.(cmd|bat)$/i.test(found) ? shimTarget(found) : '';
  if (!target) return { file: found, args };
  return /\.exe$/i.test(target) ? { file: target, args } : { file: execPath, args: [target, ...args] };
}
// Last existing program in the shim: npm.cmd runs a helper (npm-prefix.js) before npm-cli.js.
function shimTarget(file) {
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch { return ''; }
  return [...text.matchAll(/%~?dp0%?\\([^"%\r\n]+?\.(?:exe|[cm]?js))"/gi)].map(m => path.join(path.dirname(file), m[1]))
    .filter(f => path.basename(f).toLowerCase() !== 'node.exe' && isFile(f)).pop() || '';
}
// No process groups. Tree signalling is unsupported; the fallback signals only
// the direct child through the handle Node holds, never by PID. Its
// descendants are not covered.
function killTree(child, signal = 'SIGKILL', { fallback = true } = {}) {
  if (!fallback) throw unsupported();
  return child.kill(signal);
}
const trashDir = (home = os.homedir()) => path.join(home, '.Trash');
// Plain folder, as on Linux. Moves across volumes fail and callers report them.
const trashRootFor = (source, configured) => path.resolve(configured || env.HUB_TRASH || trashDir());
return { ...base, findExecutable, resolveCommand, killTree, shellCandidates: () => [], trashDir, trashRootFor,
  supervisorFiles: Object.freeze(['win32.js', 'darwin.js', 'persistence.js']) };
}
module.exports = { ...create(), create };
