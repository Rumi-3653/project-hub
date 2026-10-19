'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');
// Fixed in-memory P/Invoke declarations: no bootstrap executable or disk compilation.
const interop = String.raw`
$assembly=[AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('HubCacheGuard'),[Reflection.Emit.AssemblyBuilderAccess]::Run)
$module=$assembly.DefineDynamicModule('HubCacheGuard')
$type=$module.DefineType('HubCacheGuard',[Reflection.TypeAttributes]'Public,Abstract,Sealed')
function Declare-Native($name,$dll,$result,$parameters) {
  $method=$type.DefinePInvokeMethod($name,$dll,[Reflection.MethodAttributes]'Public,Static,PinvokeImpl',[Reflection.CallingConventions]::Standard,$result,[Type[]]$parameters,[Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Unicode)
  $method.SetImplementationFlags($method.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)
}
Declare-Native 'CreateFileW' 'kernel32.dll' ([IntPtr]) @([string],[uint32],[uint32],[IntPtr],[uint32],[uint32],[IntPtr])
Declare-Native 'NtCreateFile' 'ntdll.dll' ([int]) @([IntPtr].MakeByRefType(),[uint32],[IntPtr],[IntPtr],[IntPtr],[uint32],[uint32],[uint32],[uint32],[IntPtr],[uint32])
Declare-Native 'GetFileInformationByHandle' 'kernel32.dll' ([bool]) @([IntPtr],[IntPtr])
Declare-Native 'CloseHandle' 'kernel32.dll' ([bool]) @([IntPtr])
Declare-Native 'ConvertStringSecurityDescriptorToSecurityDescriptorW' 'advapi32.dll' ([bool]) @([string],[uint32],[IntPtr].MakeByRefType(),[IntPtr])
Declare-Native 'GetKernelObjectSecurity' 'advapi32.dll' ([bool]) @([IntPtr],[uint32],[byte[]],[uint32],[uint32].MakeByRefType())
Declare-Native 'LocalFree' 'kernel32.dll' ([IntPtr]) @([IntPtr])
Declare-Native 'SetFileInformationByHandle' 'kernel32.dll' ([bool]) @([IntPtr],[int],[IntPtr],[uint32])
Declare-Native 'NtQueryDirectoryFile' 'ntdll.dll' ([int]) @([IntPtr],[IntPtr],[IntPtr],[IntPtr],[IntPtr],[IntPtr],[uint32],[int],[byte],[IntPtr],[byte])
$native=$type.CreateType()
function Alloc-Zero($size) {
  $p=[Runtime.InteropServices.Marshal]::AllocHGlobal($size)
  [Runtime.InteropServices.Marshal]::Copy([byte[]]::new($size),0,$p,$size)
  return $p
}
function Check-Handle($handle,$directory) {
  $info=Alloc-Zero 52
  try {
    if(-not $native::GetFileInformationByHandle($handle,$info)) { throw 'GUARD_QUERY_FAILED' }
    $attributes=[Runtime.InteropServices.Marshal]::ReadInt32($info)
    if(($attributes -band 1024) -ne 0) { throw 'GUARD_REPARSE_REFUSED' }
    if((($attributes -band 16) -ne 0) -ne $directory) { throw 'GUARD_TYPE_REFUSED' }
    if(-not $directory -and [Runtime.InteropServices.Marshal]::ReadInt32($info,40) -ne 1) { throw 'GUARD_LINK_COUNT' }
    return ('{0}:{1}:{2}' -f [Runtime.InteropServices.Marshal]::ReadInt32($info,28),[Runtime.InteropServices.Marshal]::ReadInt32($info,44),[Runtime.InteropServices.Marshal]::ReadInt32($info,48))
  } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($info) }
}
function Open-Child($parent,$name,$disposition,$descriptor,$directory=$true,$private=$false,$remove=$false) {
  if($name -notmatch '^[^\\/:.][^\\/:]*$' -or $name -eq '..' -or $name.EndsWith('.') -or $name.EndsWith(' ')) { throw 'GUARD_COMPONENT_REFUSED' }
  $text=[Runtime.InteropServices.Marshal]::StringToHGlobalUni($name)
  $unicode=Alloc-Zero 16; $attributes=Alloc-Zero 48; $statusBlock=Alloc-Zero 16; $handle=[IntPtr]::Zero
  try {
    [Runtime.InteropServices.Marshal]::WriteInt16($unicode,0,[int16]($name.Length*2))
    [Runtime.InteropServices.Marshal]::WriteInt16($unicode,2,[int16]($name.Length*2+2))
    [Runtime.InteropServices.Marshal]::WriteIntPtr($unicode,8,$text)
    [Runtime.InteropServices.Marshal]::WriteInt32($attributes,0,48)
    [Runtime.InteropServices.Marshal]::WriteIntPtr($attributes,8,$parent)
    [Runtime.InteropServices.Marshal]::WriteIntPtr($attributes,16,$unicode)
    [Runtime.InteropServices.Marshal]::WriteInt32($attributes,24,64)
    [Runtime.InteropServices.Marshal]::WriteIntPtr($attributes,32,$descriptor)
    $access=0x1000a0; $share=3; $flags=0x200021; $attr=16
    if($private) { $access=0x1300a1 }
    if(-not $directory) { $access=0x120081; if($remove) { $access=0x130081 }; $share=1; $flags=0x200060; $attr=128 }
    # FILE_CREATE is exclusive; RootDirectory binds creation to the inspected parent.
    # Directory sharing READ|WRITE, never DELETE; executable sharing READ only.
    $status=$native::NtCreateFile([ref]$handle,$access,$attributes,$statusBlock,[IntPtr]::Zero,$attr,$share,$disposition,$flags,[IntPtr]::Zero,0)
    if($status -eq -1073741790) { throw 'GUARD_ACCESS_DENIED' }
    if($status -eq -1073741771) { throw 'GUARD_NAME_EXISTS' }
    if($status -eq -1073741757) { throw 'GUARD_SHARING_VIOLATION' }
    if($status -eq -1073741772) { throw 'GUARD_NOT_FOUND' }
    if($status -ne 0) { throw 'GUARD_OPEN_FAILED' }
    [void](Check-Handle $handle $directory)
    $result=$handle; $handle=[IntPtr]::Zero; return $result
  } finally {
    if($handle -ne [IntPtr]::Zero) { [void]$native::CloseHandle($handle) }
    foreach($p in @($text,$unicode,$attributes,$statusBlock)) { [Runtime.InteropServices.Marshal]::FreeHGlobal($p) }
  }
}
function Lock-Ancestors($path,$handles) {
  if([IntPtr]::Size -ne 8 -or $path -notmatch '^[A-Za-z]:\\' -or $path.Contains('/')) { throw 'GUARD_ROOT_REFUSED' }
  $root=[IO.Path]::GetPathRoot($path)
  $script:depth=0
  $handle=$native::CreateFileW($root,0x1000a0,3,[IntPtr]::Zero,3,0x02200000,[IntPtr]::Zero)
  if($handle -eq [IntPtr](-1)) { throw 'GUARD_ROOT_LOCK_FAILED' }
  [void]$handles.Add($handle); [void](Check-Handle $handle $true)
  foreach($part in $path.Substring($root.Length).TrimEnd('\').Split('\')) {
    if(-not $part) { continue }
    $script:depth++
    $handle=Open-Child $handle $part 1 ([IntPtr]::Zero)
    [void]$handles.Add($handle)
  }
  return $handle
}
function Read-HandleSecurity($handle) {
  $length=[uint32]0
  [void]$native::GetKernelObjectSecurity($handle,7,$null,0,[ref]$length)
  if($length -eq 0 -or $length -gt 65536) { throw 'GUARD_SECURITY_SIZE_FAILED' }
  $bytes=[byte[]]::new($length)
  if(-not $native::GetKernelObjectSecurity($handle,7,$bytes,$length,[ref]$length)) { throw 'GUARD_SECURITY_READ_FAILED' }
  return [Security.AccessControl.RawSecurityDescriptor]::new($bytes,0)
}
function New-PrivateChild($parent,$name) {
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $descriptor=[IntPtr]::Zero
  # Protected DACL is applied atomically, never to an existing directory.
  if(-not $native::ConvertStringSecurityDescriptorToSecurityDescriptorW(('O:'+ $sid +'D:P(A;OICI;FA;;;'+$sid+')(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'),1,[ref]$descriptor,[IntPtr]::Zero)) { throw 'GUARD_DESCRIPTOR_FAILED' }
  try { return Open-Child $parent $name 2 $descriptor $true $true }
  finally { [void]$native::LocalFree($descriptor) }
}
`;
const support = String.raw`
function Assert-Private($handle,$directory) {
  [void](Check-Handle $handle $directory)
  $acl=Read-HandleSecurity $handle
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  if($acl.Owner.Value -ne $sid -or -not $acl.DiscretionaryAcl) { throw 'GUARD_DACL_FAILED' }
  if($directory -and ($acl.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -eq 0) { throw 'GUARD_DACL_FAILED' }
  $seen=@{}
  foreach($ace in $acl.DiscretionaryAcl) {
    if($ace -isnot [Security.AccessControl.CommonAce] -or $ace.IsCallback -or $ace.AceQualifier -ne 'AccessAllowed' -or $ace.SecurityIdentifier.Value -notin @($sid,'S-1-5-18','S-1-5-32-544') -or $ace.AccessMask -ne 2032127) { throw 'GUARD_DACL_FAILED' }
    $flags=[int]$ace.AceFlags
    if(($directory -and $flags -ne 3) -or (-not $directory -and ($flags -band (-bnot 19)) -ne 0)) { throw 'GUARD_DACL_FAILED' }
    $key=$ace.SecurityIdentifier.Value
    if($seen.ContainsKey($key)) { throw 'GUARD_DACL_FAILED' }; $seen[$key]=$true
  }
  if($seen.Count -ne 3) { throw 'GUARD_DACL_FAILED' }
}
function Handle-Hash($handle) {
  $safe=[Microsoft.Win32.SafeHandles.SafeFileHandle]::new($handle,$false)
  $stream=[IO.FileStream]::new($safe,[IO.FileAccess]::Read)
  $hash=[Security.Cryptography.SHA256]::Create()
  try { $stream.Position=0; return ([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-','').ToLowerInvariant() }
  finally { $hash.Dispose(); $stream.Dispose(); $safe.Dispose() }
}
function Mark-Delete($handle) {
  $p=Alloc-Zero 4
  try { [Runtime.InteropServices.Marshal]::WriteInt32($p,1); if(-not $native::SetFileInformationByHandle($handle,4,$p,4)) { throw 'GUARD_CLEANUP_FAILED' } }
  finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($p) }
}
function Child-Names($handle) {
  $buffer=Alloc-Zero 65536; $io=Alloc-Zero 16; $restart=1; $names=[Collections.Generic.List[string]]::new()
  try {
    while($true) {
      $status=$native::NtQueryDirectoryFile($handle,[IntPtr]::Zero,[IntPtr]::Zero,[IntPtr]::Zero,$io,$buffer,65536,12,0,[IntPtr]::Zero,$restart)
      $restart=0
      if($status -eq -2147483642) { break }
      if($status -ne 0) { throw 'GUARD_CLEANUP_FAILED' }
      $offset=0
      do {
        $next=[Runtime.InteropServices.Marshal]::ReadInt32($buffer,$offset)
        $length=[Runtime.InteropServices.Marshal]::ReadInt32($buffer,$offset+8)
        if($length -lt 0 -or $length % 2 -ne 0 -or $offset+12+$length -gt 65536) { throw 'GUARD_CLEANUP_FAILED' }
        $name=[Runtime.InteropServices.Marshal]::PtrToStringUni([IntPtr]::Add($buffer,$offset+12),$length/2)
        if($name -notin @('.','..')) { [void]$names.Add($name) }
        if($next -lt 0 -or ($next -gt 0 -and $next -lt 12)) { throw 'GUARD_CLEANUP_FAILED' }
        $offset+=$next
      } while($next -ne 0 -and $offset -lt 65536)
    }
    return $names.ToArray()
  } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer); [Runtime.InteropServices.Marshal]::FreeHGlobal($io) }
}
`;
// Only fixtures generate the anchored script. Production always uses script below.
function makeScript(testAnchor = false) {
  return String.raw`
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$stage='guard-start'; $depth=0; $handles=[Collections.Generic.List[IntPtr]]::new()
$run=[IntPtr]::Zero; $exe=[IntPtr]::Zero; $finished=$false
function Reply($value) { [Console]::Out.WriteLine(($value | ConvertTo-Json -Depth 5 -Compress)); [Console]::Out.Flush() }
try {
  if($PSVersionTable.PSVersion.Major -ne 5) { throw 'GUARD_START_FAILED' }
` + interop + support + String.raw`
  $r=[Console]::In.ReadLine() | ConvertFrom-Json
  $stage='guard-ancestors'
` + (testAnchor ? String.raw`
  $parent=$native::CreateFileW($r.root,0x1000a0,3,[IntPtr]::Zero,3,0x02200000,[IntPtr]::Zero)
  if($parent -eq [IntPtr](-1)) { throw 'GUARD_OPEN_FAILED' }
  [void]$handles.Add($parent); [void](Check-Handle $parent $true)
  foreach($part in @($r.testSegments | Where-Object { $_ })) {
    $depth++; $parent=Open-Child $parent $part 1 ([IntPtr]::Zero)
    [void]$handles.Add($parent); $r.root=[IO.Path]::Combine($r.root,$part)
  }
` : String.raw`
  $parent=Lock-Ancestors $r.root $handles
`) + String.raw`
  $stage='guard-base'
  # FILE_OPEN_IF with no descriptor never resets existing base permissions.
  $base=Open-Child $parent 'ProjectHub-native-cache' 3 ([IntPtr]::Zero)
  [void]$handles.Add($base)
  $stage='guard-create'
  $name='hub-native-'+[Guid]::NewGuid().ToString('N')
` + (testAnchor ? "  if($r.testName) { $name=[string]$r.testName }\n" : '') + String.raw`
  $run=New-PrivateChild $base $name
  $directory=[IO.Path]::Combine($r.root,'ProjectHub-native-cache',$name)
  $file=[IO.Path]::Combine($directory,'helper.exe')
  $stage='guard-dacl'; Assert-Private $run $true
  $stage='native-compile'
  foreach($h in $handles) { [void](Check-Handle $h $true) }; Assert-Private $run $true
  $parameters=[CodeDom.Compiler.CompilerParameters]::new()
  $parameters.GenerateExecutable=$true; $parameters.GenerateInMemory=$false
  $parameters.OutputAssembly=$file; $parameters.CompilerOptions='/platform:x64'
  foreach($a in @('System.dll','System.Core.dll','System.Security.dll','System.Web.Extensions.dll','System.Windows.Forms.dll','System.Drawing.dll')) { [void]$parameters.ReferencedAssemblies.Add($a) }
  $parameters.TempFiles=[CodeDom.Compiler.TempFileCollection]::new($directory,$false)
  $provider=[Microsoft.CSharp.CSharpCodeProvider]::new()
  try {
    $compiled=$provider.CompileAssemblyFromSource($parameters,[string[]]@($r.source))
    if($compiled.Errors.HasErrors -or $compiled.PathToAssembly -cne $file) { throw 'COMPILATION_FAILED' }
  } finally { $provider.Dispose(); $parameters.TempFiles.Delete() }
  $stage='guard-executable'
  $exe=Open-Child $run 'helper.exe' 1 ([IntPtr]::Zero) $false $true
  Assert-Private $exe $false
  $exeIdentity=Check-Handle $exe $false
  $digest=Handle-Hash $exe
  Reply @{ok=$true;file=$file;digest=$digest}
  while($null -ne ($line=[Console]::In.ReadLine())) {
    $q=$line | ConvertFrom-Json
    if($q.op -eq 'close') { break }
` + (testAnchor ? "    if($q.op -eq 'release-test') { $finished=$true; Reply @{ok=$true}; break }\n" : '') + String.raw`
    if($q.op -ne 'verify') { throw 'GUARD_PROTOCOL_FAILED' }
    $stage='guard-verify'
    foreach($h in $handles) { [void](Check-Handle $h $true) }; Assert-Private $run $true; Assert-Private $exe $false
    if((Handle-Hash $exe) -cne $digest) { throw 'GUARD_DIGEST_FAILED' }
    Reply @{ok=$true;digest=$digest}
  }
  if(-not $finished) {
    $stage='guard-cleanup'
    foreach($child in @(Child-Names $run)) {
      if($child -eq 'helper.exe' -and $exe -ne [IntPtr]::Zero) { continue }
      $h=Open-Child $run $child 1 ([IntPtr]::Zero) $false $true $true
      try { Mark-Delete $h } finally { [void]$native::CloseHandle($h) }
    }
    if($exe -ne [IntPtr]::Zero) {
      # The CLR loader requires a read-only lock, without DELETE access.
      # Retain the private directory and all ancestors while reacquiring by handle-relative name.
      [void]$native::CloseHandle($exe); $exe=[IntPtr]::Zero
      $exe=Open-Child $run 'helper.exe' 1 ([IntPtr]::Zero) $false $true $true
      if((Check-Handle $exe $false) -cne $exeIdentity) { throw 'GUARD_IDENTITY_FAILED' }
      Mark-Delete $exe; [void]$native::CloseHandle($exe); $exe=[IntPtr]::Zero
    }
    Mark-Delete $run; [void]$native::CloseHandle($run); $run=[IntPtr]::Zero
    $finished=$true; Reply @{ok=$true}
  }
} catch {
  $known=@('GUARD_START_FAILED','GUARD_ROOT_REFUSED','GUARD_ROOT_LOCK_FAILED','GUARD_COMPONENT_REFUSED','GUARD_ACCESS_DENIED','GUARD_NAME_EXISTS','GUARD_SHARING_VIOLATION','GUARD_NOT_FOUND','GUARD_OPEN_FAILED','GUARD_QUERY_FAILED','GUARD_TYPE_REFUSED','GUARD_REPARSE_REFUSED','GUARD_LINK_COUNT','GUARD_DACL_FAILED','GUARD_DESCRIPTOR_FAILED','GUARD_SECURITY_READ_FAILED','GUARD_SECURITY_SIZE_FAILED','GUARD_DIGEST_FAILED','GUARD_IDENTITY_FAILED','GUARD_PROTOCOL_FAILED','GUARD_CLEANUP_FAILED','COMPILATION_FAILED')
  $code=if($_.Exception.Message -in $known) { $_.Exception.Message } elseif($stage -eq 'native-compile') { 'COMPILATION_FAILED' } else { 'GUARD_OPERATION_FAILED' }
  Reply @{ok=$false;stage=$stage;code=$code;ancestorDepth=$depth}
} finally {
  if($exe -ne [IntPtr]::Zero) { [void]$native::CloseHandle($exe) }
  if($run -ne [IntPtr]::Zero) { [void]$native::CloseHandle($run) }
  for($i=$handles.Count-1;$i -ge 0;$i--) { [void]$native::CloseHandle($handles[$i]) }
}
`;
}
const script = makeScript(false);
function failure(reasonCode, stage = 'guard-liveness', ancestorDepth) {
  return Object.assign(Error('Windows guard failed'), { stage, reasonCode, ...(Number.isInteger(ancestorDepth) ? { ancestorDepth } : {}) });
}
function createClient({ source, root, powershell, script: selectedScript = script, testSegments, testName, onDeath = () => {} }) {
  const shared = new SharedArrayBuffer(1024 * 1024), header = new Int32Array(shared, 0, 4), bytes = new Uint8Array(shared, 16);
  const worker = new Worker(path.join(__dirname, 'cache-guard-worker.js'), { workerData: { shared, powershell, script: selectedScript } });
  let dead = false, closing = false;
  worker.on('error', () => { dead = true; onDeath(failure('GUARD_EXITED')); });
  worker.on('message', m => { if (m === 'dead' && !closing) { dead = true; onDeath(failure('GUARD_EXITED')); } });
  worker.unref();
  function rpc(message, initial = false) {
    if (!initial && (dead || Atomics.load(header, 2) !== 1)) throw failure('GUARD_EXITED');
    Atomics.store(header, 0, 0); worker.postMessage(message);
    if (Atomics.wait(header, 0, 0, 40000) === 'timed-out') { dead = true; worker.postMessage({ op: 'terminate' }); throw failure('GUARD_TIMEOUT'); }
    const size = Atomics.load(header, 1);
    if (size < 2 || size > bytes.length) throw failure('GUARD_PROTOCOL_FAILED');
    let response;
    try { response = JSON.parse(Buffer.from(bytes.subarray(0, size)).toString('utf8')); } catch { throw failure('GUARD_PROTOCOL_FAILED'); }
    if (response?.ok !== true) { dead = true; throw failure(response?.code || 'GUARD_OPERATION_FAILED', response?.stage, response?.ancestorDepth); }
    return response;
  }
  let ready;
  try {
    ready = rpc({ op: 'init', source, root, ...(testSegments ? { testSegments } : {}), ...(testName ? { testName } : {}) }, true);
    if (typeof ready.file !== 'string' || !/^[a-f0-9]{64}$/.test(ready.digest)) throw failure('GUARD_PROTOCOL_FAILED');
  } catch (e) { worker.postMessage({ op: 'terminate' }); throw e; }
  function waitForExit() {
    worker.postMessage({ op: 'shutdown' });
    if (Atomics.load(header, 2) === 1 && Atomics.wait(header, 2, 1, 5000) === 'timed-out') {
      worker.postMessage({ op: 'terminate' }); throw failure('GUARD_TIMEOUT', 'guard-cleanup');
    }
  }
  return {
    file: ready.file, digest: ready.digest,
    verify() { const r = rpc({ op: 'verify' }); if (r.digest !== ready.digest) throw failure('GUARD_DIGEST_FAILED', 'guard-verify'); },
    close() { if (closing) return; closing = true; try { rpc({ op: 'close' }); } finally { waitForExit(); } },
    terminate() { worker.postMessage({ op: 'terminate' }); },
    releaseTest() { closing = true; const r = rpc({ op: 'release-test' }); waitForExit(); return r; },
  };
}
function create(options) { return createClient({ source: options.source, root: options.root, powershell: options.powershell, onDeath: options.onDeath }); }
module.exports = { create, createClient, script, makeScript, interop };
