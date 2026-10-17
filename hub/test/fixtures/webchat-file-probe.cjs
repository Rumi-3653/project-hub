'use strict';
// Isolate blocking regressions so a failed check cannot freeze the test runner.
const fs = require('node:fs'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Webchat } = require('../../lib/webchat');
const { root, name, kind, race } = JSON.parse(process.argv[2]);
const f = path.join(root, 'target'), original = path.join(root, 'original');
let peerFd;
fs.writeFileSync(original, 'untouched');
const replace = () => {
  fs.rmSync(f, { force: true });
  if (kind === 'fifo') {
    execFileSync('/usr/bin/mkfifo', [f]);
    // Let the racing write open succeed, exercising descriptor validation too.
    if (race && name === 'write_file') peerFd = fs.openSync(f, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  }
  else if (kind === 'symlink') fs.symlinkSync(original, f);
  else if (kind === 'hardlink') fs.linkSync(original, f);
  else if (kind === 'directory') fs.mkdirSync(f);
};
if (race) {
  fs.writeFileSync(f, 'before replacement');
  const open = fs.openSync;
  fs.openSync = function(file, ...args) {
    if (file === f) { fs.openSync = open; replace(); }
    return open.call(fs, file, ...args);
  };
} else replace();
const gpt = { project: () => ({ id: 'P' }), task: () => ({ t: { id: 'child' } }), settings: () => ({ work: true }), gptChildren: { workspace: () => root } };
const wc = new Webchat({ root, gpt });
wc.tool({ id: 'P' }, { id: 'child' }, { name, arguments: { path: 'target', text: 'must not write' } }, {}).then(
  () => { if (peerFd !== undefined) fs.closeSync(peerFd); console.error('unexpected acceptance'); process.exitCode = 2; },
  e => setTimeout(() => {
    if (peerFd !== undefined) fs.closeSync(peerFd);
    console.log(JSON.stringify({ rejected: true, error: e.message, responsive: true, original: fs.readFileSync(original, 'utf8') }));
  }, 5)
);
