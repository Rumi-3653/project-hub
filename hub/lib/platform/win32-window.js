'use strict';
// Windows-only build/launch boundary; fixed local C#, stdin JSON, private ACL.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto'), cp = require('node:child_process');
const compile = String.raw`
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
try {
  if($PSVersionTable.PSVersion.Major -ne 5) { throw 'Windows PowerShell 5.1 required' }
  $r=[Console]::In.ReadToEnd() | ConvertFrom-Json
  if([IO.Path]::GetDirectoryName($r.file) -cne $r.directory) { throw 'cache_path_mismatch' }
  for($p=$r.directory;$p;$p=[IO.Path]::GetDirectoryName($p)) {
    if(([IO.File]::GetAttributes($p) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'cache_reparse_point' }
  }
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl=[Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false)
  $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $r.directory -AclObject $acl -ErrorAction Stop
  $actual=Get-Acl -LiteralPath $r.directory -ErrorAction Stop
  if(-not $actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'cache_acl_unconfirmed' }
  $parameters=[CodeDom.Compiler.CompilerParameters]::new()
  $parameters.GenerateExecutable=$true; $parameters.GenerateInMemory=$false
  if((Get-FileHash -LiteralPath $r.icon -Algorithm SHA256).Hash.ToLowerInvariant() -cne $r.iconSha256) { throw 'icon_source_changed' }
  $parameters.OutputAssembly=$r.file; $parameters.CompilerOptions='/platform:x64 /target:winexe /win32icon:"'+$r.icon+'"'
  foreach($assembly in @('System.dll','System.Core.dll','System.Web.Extensions.dll','System.Windows.Forms.dll','System.Drawing.dll')) { [void]$parameters.ReferencedAssemblies.Add($assembly) }
  foreach($dependency in $r.dependencies) {
    $target=[IO.Path]::Combine($r.directory,[IO.Path]::GetFileName($dependency.file))
    if((Get-FileHash -LiteralPath $dependency.file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $dependency.sha256) { throw 'sdk_source_changed' }
    [IO.File]::Copy($dependency.file,$target,$false)
    if((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -cne $dependency.sha256) { throw 'sdk_copy_changed' }
    if([IO.Path]::GetFileName($target) -ne 'WebView2Loader.dll') { [void]$parameters.ReferencedAssemblies.Add($target) }
  }
  $parameters.TempFiles=[CodeDom.Compiler.TempFileCollection]::new($r.directory,$false)
  $provider=[Microsoft.CSharp.CSharpCodeProvider]::new()
  try {
    $result=$provider.CompileAssemblyFromSource($parameters,[string[]]@($r.source))
    if($result.Errors.HasErrors) { throw (($result.Errors | ForEach-Object { $_.ToString() }) -join '; ') }
    if($result.PathToAssembly -cne $r.file -or -not [IO.File]::Exists($r.file)) { throw 'compiled_file_missing' }
  } finally { $provider.Dispose() }
  @{ok=$true;file=$r.file} | ConvertTo-Json -Compress
} catch {
  @{ok=$false;error=$_.Exception.Message} | ConvertTo-Json -Compress
  exit 1
}
`;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const vendor = path.resolve(__dirname, '../../app/windows/vendor/webview2/1.0.4258.31');
function dependencies() {
  const manifest = JSON.parse(fs.readFileSync(path.join(vendor, 'manifest.json'), 'utf8'));
  const names = ['Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll'];
  return names.map(name => {
    const entry = manifest.files.find(row => row.file === name), file = path.join(vendor, name);
    if (!entry || fs.lstatSync(file).isSymbolicLink() || hash(fs.readFileSync(file)) !== entry.sha256) throw Error('Microsoftの部品の内容が変わりました');
    return { file, sha256: entry.sha256 };
  });
}
function configuration({ root, runtime, node, port, localAppData, bootstrap = runtime, updateConfirm = '' }) {
  const p = path.win32;
  if (![root, runtime, node, localAppData].every(v => typeof v === 'string' && /^[a-z]:\\/i.test(v) && !/[\0\r\n"]/.test(v)) ||
      !Number.isSafeInteger(port) || port < 1024 || port > 65535) throw Error('Windows専用窓の起動設定を確認できません');
  if (!/^[a-z]:\\/i.test(bootstrap || '') || /[\0\r\n\"]/.test(bootstrap) || updateConfirm && !/^[0-9a-f-]{36}$/.test(updateConfirm)) throw Error('Windows更新の起動設定を確認できません');
  const rootHash = hash(p.resolve(root).toLowerCase());
  return { root: p.resolve(root), runtime: p.resolve(runtime), node: p.resolve(node), port, rootHash,
    bootstrap: p.resolve(bootstrap), updateConfirm, nonce: crypto.randomBytes(32).toString('hex'), profile: p.join(localAppData, 'ProjectHub', 'WebView2', rootHash) };
}
function create(options = {}) {
  const run = options.execFileSync || cp.execFileSync, spawn = options.spawn || cp.spawn;
  let directory, executable, digests, poisoned, child, closed;
  function close() {
    if (child && child.exitCode === null && child.signalCode === null) throw Error('専用窓がまだ動いています');
    if (directory) { fs.rmSync(directory, { recursive: true }); directory = undefined; }
    closed = true;
  }
  function prepare() {
    if (closed) throw Error('専用窓の準備は終了しています');
    if (poisoned) throw poisoned;
    try {
      if (!options.execFileSync && (process.platform !== 'win32' || process.arch !== 'x64')) throw Error('Windows x64 が必要です');
      if (!executable) {
        const deps = dependencies();
        const icon = path.resolve(__dirname, '../../app/windows/ProjectHub.ico');
        require('../license/storage').noLinks(icon);
        const iconSha256 = hash(fs.readFileSync(icon));
        directory = fs.mkdtempSync(path.join(fs.realpathSync(options.tempRoot || os.tmpdir()), 'hub-window-'));
        executable = path.join(directory, 'ProjectHub.exe');
        const ps = path.win32.join(options.systemRoot || process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const source = fs.readFileSync(path.resolve(__dirname, '../../app/windows/HubWindow.cs'), 'utf8');
        const output = run(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', compile], {
          input: JSON.stringify({ directory, file: executable, source, icon, iconSha256, dependencies: deps }), encoding: 'utf8',
          timeout: 60000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, shell: false,
        });
        const result = JSON.parse(String(output).replace(/^\uFEFF/, '').trim());
        if (hash(fs.readFileSync(icon)) !== iconSha256) throw Error('icon_source_changed');
        if (result.ok !== true || result.file !== executable) throw Error(result.error || 'window_compile_unconfirmed');
        digests = [executable, ...deps.map(d => path.join(directory, path.basename(d.file)))].map(file => ({ file, hash: hash(fs.readFileSync(file)) }));
        for (const dep of deps) if (hash(fs.readFileSync(path.join(directory, path.basename(dep.file)))) !== dep.sha256) throw Error('sdk_copy_changed');
      }
      if (fs.lstatSync(directory).isSymbolicLink() || !fs.lstatSync(directory).isDirectory()) throw Error('window_cache_changed');
      for (const d of digests) if (fs.lstatSync(d.file).isSymbolicLink() || !fs.lstatSync(d.file).isFile() || hash(fs.readFileSync(d.file)) !== d.hash) throw Error('window_cache_changed');
      return executable;
    } catch (e) { poisoned = Object.assign(Error('専用窓を準備できません：' + e.message), { code: 'windows_window_failed' }); throw poisoned; }
  }
  return { prepare, close, launch(config) {
    if (child) throw Error('専用窓の起動は一回だけです');
    const file = prepare();
    child = spawn(file, [], { shell: false, windowsHide: false, stdio: ['pipe', 'inherit', 'inherit'] });
    child.stdin.on('error', error => console.error('専用窓へ設定を渡せません：' + error.message));
    child.stdin.end(JSON.stringify(config));
    child.once('exit', () => { try { close(); } catch (e) { console.error(e.message); } });
    return child;
  } };
}
module.exports = { create, configuration, dependencies };
