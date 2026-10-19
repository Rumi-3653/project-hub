'use strict';
// Windows licensing only. SQLite's Windows VFS flushes the WAL on EVERY FULL
// commit. There is no rename + privileged whole-volume flush on this path.
// Mac JSON storage and the general Hub persistence contract are unchanged.
const fs = require('node:fs'), path = require('node:path');
const { noLinks } = require('./storage');
const APP = 0x50484c31;
function fail(stage, reasonCode) { return Object.assign(Error('license_storage_unavailable'), { stage, reasonCode }); }
function files(home) {
  for (const name of ['license.sqlite', 'license.sqlite-wal', 'license.sqlite-shm', 'license.sqlite-journal']) {
    const file = path.join(home, name); noLinks(file);
    try { const s = fs.lstatSync(file); if (!s.isFile() || s.nlink !== 1) throw fail('storage-open', 'STORAGE_PATH_UNSAFE'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function access(home, platform, name, value) {
  const writing = arguments.length === 4;
  if (!['device', 'state'].includes(name)) throw fail('storage-open', 'STORAGE_DOCUMENT_INVALID');
  let db, stage = 'storage-open', result, failure;
  try {
    noLinks(home);
    // Never turn a previous JSON identity into a new identity. No automatic
    // migration, overwriting or deletion of existing Windows licensing data.
    if (['device.json', 'state.json'].some(n => fs.existsSync(path.join(home, n)))) throw fail(stage, 'STORAGE_LEGACY_PRESENT');
    if (!fs.existsSync(home)) {
      if (!writing) return null;
      fs.mkdirSync(home, { recursive: true, mode: 0o700 }); // inherits existing ACL
    }
    const binding = platform.licenseDirectory(home);
    if (typeof binding !== 'string' || !binding) throw fail(stage, 'STORAGE_PATH_UNSAFE');
    files(home);
    const file = path.join(home, 'license.sqlite'), exists = fs.existsSync(file);
    if (!exists && !writing) {
      if (fs.readdirSync(home).length) throw fail(stage, 'STORAGE_UNRECOGNIZED');
      return null;
    }
    if (!exists && fs.readdirSync(home).length) throw fail(stage, 'STORAGE_UNRECOGNIZED');
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(file, { enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false });
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000;');
    if (exists && (db.prepare('PRAGMA application_id').get().application_id !== APP ||
        db.prepare('PRAGMA user_version').get().user_version !== 1)) throw fail(stage, 'STORAGE_FORMAT_INVALID');
    const mode = db.prepare('PRAGMA journal_mode=WAL').get().journal_mode;
    db.exec('PRAGMA synchronous=FULL;');
    if (mode !== 'wal' || db.prepare('PRAGMA synchronous').get().synchronous !== 2) throw fail(stage, 'STORAGE_DURABILITY_UNAVAILABLE');
    if (!exists) {
      stage = 'storage-commit';
      db.exec(`BEGIN IMMEDIATE; PRAGMA application_id=${APP}; PRAGMA user_version=1;
        CREATE TABLE documents(name TEXT PRIMARY KEY CHECK(name IN ('device','state')), value TEXT NOT NULL) STRICT; COMMIT;`);
    }
    if (writing) {
      stage = 'storage-commit';
      const json = JSON.stringify(value);
      if (typeof json !== 'string') throw fail(stage, 'STORAGE_DOCUMENT_INVALID');
      db.exec('BEGIN IMMEDIATE;');
      db.prepare('INSERT INTO documents(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value').run(name, json);
      db.exec('COMMIT;'); // Any I/O/sync failure propagates. No retry or fallback.
      stage = 'storage-readback';
      if (db.prepare('SELECT value FROM documents WHERE name=?').get(name)?.value !== json) throw fail(stage, 'STORAGE_READBACK_FAILED');
    } else {
      stage = 'storage-read';
      const row = db.prepare('SELECT value FROM documents WHERE name=?').get(name);
      result = row ? JSON.parse(row.value) : null;
    }
    files(home);
    if (platform.licenseDirectory(home, binding) !== binding) throw fail(stage, 'STORAGE_PATH_CHANGED');
  } catch (error) {
    // Native errors already carry bounded codes. Never attach an exception
    // message, SQL text, file name or device identifier to the public error.
    const codes = { 5: 'STORAGE_BUSY', 6: 'STORAGE_BUSY', 8: 'STORAGE_READONLY', 10: 'STORAGE_IO', 11: 'STORAGE_CORRUPT', 13: 'STORAGE_FULL', 14: 'STORAGE_OPEN_FAILED', 26: 'STORAGE_CORRUPT' };
    failure = error.stage && error.reasonCode ? error : fail(stage, codes[Number(error.errcode) & 255] || 'STORAGE_FAILED');
  } finally {
    if (db) try { db.close(); } catch { failure ||= fail('storage-close', 'STORAGE_CLOSE_FAILED'); }
  }
  if (failure) throw failure;
  return result;
}
module.exports = { access };
