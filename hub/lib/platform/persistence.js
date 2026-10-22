'use strict';
// Strict namespace/file durability boundary. Never turn an unsupported flush or
// an I/O error into a successful save. This module is pinned with the supervisor.
// Windows has a separately approved, weaker namespace durability contract:
// parent identity validation, file flush and write-through rename (see win32.js).
// No whole-volume flush or elevation. The Mac/Linux contract below is unchanged.
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
