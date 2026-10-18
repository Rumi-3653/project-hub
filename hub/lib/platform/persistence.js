'use strict';
// Strict namespace/file durability boundary. Never turn an unsupported flush or
// an I/O error into a successful save. This module is pinned with the supervisor.
// Windows must supply native primitives in its adapter: Node's read-only
// directory handles do not satisfy FlushFileBuffers' GENERIC_WRITE requirement.
const fs = require('node:fs');
function create(name, defaultIO = fs) {
  function supported() {
    if (name !== 'darwin' && name !== 'linux') throw Object.assign(
      Error('保存の確定方法を確認できません'), { code: 'persistence_unsupported', platform: name });
  }
  // Keep the same handle across both flushes of a link/unlink recovery. The
  // operation must not run if opening/flushing its parent fails.
  function withDirectorySync(dir, operation, io = defaultIO) {
    supported();
    const fd = io.openSync(dir, 'r');
    try { io.fsyncSync(fd); const result = operation(); io.fsyncSync(fd); return result; }
    finally { io.closeSync(fd); }
  }
  function syncDirectory(dir, io = defaultIO) {
    supported();
    const fd = io.openSync(dir, 'r');
    try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
  }
  function syncFile(file, io = defaultIO) {
    supported();
    const fd = io.openSync(file, 'r');
    try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
  }
  return Object.freeze({ syncDirectory, syncFile, withDirectorySync });
}
module.exports = { create };
