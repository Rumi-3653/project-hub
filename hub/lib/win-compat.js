'use strict';
// Windows raises EPERM when fsync is given a handle without write access: a directory
// (NTFS keeps create/rename metadata itself) or a file reopened read-only after it was
// written through another handle. Those calls are skipped there; fsync on a written
// handle is unchanged. No effect on macOS or Linux. Load before the durability helpers.
const fs = require('node:fs');
if (process.platform === 'win32' && !fs.fsyncSync.hubWindows) {
  const fsyncSync = fs.fsyncSync;
  const patched = fd => { try { return fsyncSync(fd); } catch (e) { if (e?.code === 'EPERM') return undefined; throw e; } };
  patched.hubWindows = true;
  fs.fsyncSync = patched;
}
