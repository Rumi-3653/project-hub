'use strict';
// Isolated native guard tests; never calls the product helper or credentials.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), cp = require('node:child_process');
const guard = require('../../lib/platform/cache-guard');
const rootBase = path.resolve(__dirname, '../../../..');
const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const source = 'using System; public class Probe { public static int Main() { Console.WriteLine("probe"); return 0; } }';
function root() { return fs.mkdtempSync(path.join(rootBase, 'guard-v4-')); }
function start(root, extras = {}) { return guard.createClient({ source, root, powershell, script: guard.makeScript(true), ...extras }); }
function inside(file) {
 const relative=path.relative(rootBase,path.resolve(file));
 if(!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('outside-test-tree');
 return file;
}
function rename(file) { const moved=inside(file+'-moved'); inside(file); fs.renameSync(file,moved); fs.renameSync(moved,file); }
function access(file, kind) {
 const script = guard.interop + String.raw`
$r=[Console]::In.ReadToEnd() | ConvertFrom-Json
$access=if($r.kind -eq 'delete') { 65536 } else { 1073741824 }
$h=$native::CreateFileW($r.file,$access,7,[IntPtr]::Zero,3,0x02200000,[IntPtr]::Zero)
$ok=$h -ne [IntPtr](-1)
if($ok) { [void]$native::CloseHandle($h) }
[Console]::WriteLine(($ok | ConvertTo-Json -Compress))
`;
 const r=cp.spawnSync(powershell,['-NoLogo','-NoProfile','-NonInteractive','-Command',script],
 {input:JSON.stringify({file:inside(file),kind}),encoding:'utf8',windowsHide:true,timeout:15000});
 if(r.error || r.status!==0) throw Error('access-probe-failed');
 return JSON.parse(r.stdout.trim());
}
function hash(file) {return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
module.exports={root,start,inside,rename,access,hash,powershell,source,rootBase};
if(require.main===module) {
 const r=root();
 try { const g=start(r); g.verify(); const same=hash(g.file)===g.digest; g.close(); console.log(JSON.stringify({ready:true,digest:same,cleanup:!fs.existsSync(path.dirname(g.file))})); }
 catch(e) {console.log(JSON.stringify(require('../../lib/platform/win32-native').diagnostic(e)));process.exitCode=1;}
}
