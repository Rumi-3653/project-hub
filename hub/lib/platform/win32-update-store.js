'use strict';
// Update metadata uses SQLite FULL commits, not Windows rename as a durability
// substitute. No keys/license data are opened. Native NTFS identity is rechecked.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const { noLinks } = require('../app-update-packaged');
const aclScript = String.raw`
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$r=[Console]::In.ReadToEnd() | ConvertFrom-Json
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
# A private child can still be replaced through a writable ancestor. Refuse
# shared/untrusted parents rather than changing their permissions.
$replace=[Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
$trusted=@($sid.Value,'S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464') # user, SYSTEM, Administrators, TrustedInstaller
for($p=[IO.Directory]::GetParent($r.path);$null -ne $p;$p=$p.Parent) {
  $a=Get-Acl -LiteralPath $p.FullName -ErrorAction Stop
  if($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted) { throw 'update_parent_owner' }
  foreach($rule in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    # CreateFiles/CreateDirectories on an ancestor do not permit replacing an
    # existing protected child. InheritOnly rules do not apply to this ancestor.
    if(($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and $rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $replace) -ne 0 -and $rule.IdentityReference.Value -notin $trusted) { throw 'update_parent_acl' }
  }
}
if($r.create) {
  $acl=[Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false)
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
  Set-Acl -LiteralPath $r.path -AclObject $acl -ErrorAction Stop
}
$actual=Get-Acl -LiteralPath $r.path -ErrorAction Stop
if(-not $actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'update_acl' }
$rules=@($actual.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
if($rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne 'Allow' -or ($rules[0].FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl) { throw 'update_acl' }
[Console]::Write('ok')`;
function privateDirectory(home, create) {
  const native = require('./index'); native.licenseDirectory(home);
  const exe = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  // Node may inherit PowerShell 7's module paths from its launcher. This child
  // uses Windows PowerShell 5.1 and only needs its OS modules for JSON and ACLs.
  // Windows environment names are case-insensitive: remove every spelling.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
  env.PSModulePath = path.win32.join(path.win32.dirname(exe), 'Modules');
  const result = cp.execFileSync(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', aclScript], {
    input: JSON.stringify({ path: home, create }), encoding: 'utf8', windowsHide: true, shell: false, timeout: 10000, maxBuffer: 65536, env,
  });
  if (result.trim() !== 'ok') throw Error('update_acl');
}
class UpdateStore {
  constructor(root, { guard = privateDirectory } = {}) { this.home = path.join(root, '_hub', 'updates', 'windows'); this.guard = guard; }
  access(change) {
    noLinks(this.home); const exists = fs.existsSync(this.home);
    if (!exists) fs.mkdirSync(this.home, { recursive: true, mode: 0o700 });
    this.guard(this.home, !exists);
    const native = process.platform === 'win32' ? require('./index') : null;
    const identity = native?.licenseDirectory(this.home);
    const file = path.join(this.home, 'update.sqlite');
    for (const name of ['update.sqlite', 'update.sqlite-wal', 'update.sqlite-shm', 'update.sqlite-journal']) {
      const p = path.join(this.home, name); noLinks(p);
      if (fs.existsSync(p)) { const s = fs.lstatSync(p); if (!s.isFile() || s.nlink !== 1) throw Error('update_store_path'); }
    }
    const existed = fs.existsSync(file);
    const { DatabaseSync } = require('node:sqlite'), db = new DatabaseSync(file); let result;
    try {
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000;');
      if (existed && (db.prepare('PRAGMA application_id').get().application_id !== 1213551189 || db.prepare('PRAGMA user_version').get().user_version !== 1)) throw Error('update_store_format');
      if (db.prepare('PRAGMA journal_mode=WAL').get().journal_mode !== 'wal') throw Error('update_store_wal');
      db.exec('PRAGMA synchronous=FULL;'); if (db.prepare('PRAGMA synchronous').get().synchronous !== 2) throw Error('update_store_sync');
      db.exec('BEGIN IMMEDIATE;');
      if (!existed) db.exec('PRAGMA application_id=1213551189; PRAGMA user_version=1; CREATE TABLE update_state(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value TEXT NOT NULL) STRICT;');
      const row = db.prepare('SELECT revision,value FROM update_state WHERE id=1').get();
      if (row && Buffer.byteLength(row.value) > 256 * 1024) throw Error('update_store_size');
      const value = row ? JSON.parse(row.value) : {};
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('update_store_format');
      const next = change?.(value, row?.revision || 0);
      if (next !== undefined) {
        const text = JSON.stringify(next); if (Buffer.byteLength(text) > 256 * 1024) throw Error('update_store_size');
        native?.licenseDirectory(this.home, identity);
        db.prepare('INSERT INTO update_state VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,value=excluded.value').run((row?.revision || 0) + 1, text);
      }
      db.exec('COMMIT;'); result = { value: next ?? value, revision: (row?.revision || 0) + (next === undefined ? 0 : 1) };
    } finally { db.close(); }
    return result;
  }
  read() { return this.access(); }
  write(value, revision) {
    return this.access((old, actual) => { if (actual !== revision) throw Error('update_store_changed'); return value; });
  }
}
module.exports = { UpdateStore, privateDirectory };
