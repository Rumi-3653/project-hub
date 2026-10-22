'use strict';
// Only Windows replaces rename. Other hosts receive the original fs object,
// including fixture overrides. Never patch Node's shared fs singleton.
const fs = require('node:fs');
const renameSync = (from, to) => require('./index').persistence.renameSync(from, to);
module.exports = process.platform === 'win32' ? Object.create(fs, {
  renameSync: { value: renameSync },
  promises: { value: Object.assign(Object.create(fs.promises), {
    async rename(from, to) { return renameSync(from, to); },
  }) },
}) : fs;
