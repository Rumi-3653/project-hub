'use strict';
// Local unsigned preparation ONLY. Never reads a signing key or signs a file.
// Finalize with explicit --unsigned, or sign and finalize with --thumbprint.
// Receipt hashes bind compilation inputs/outputs, not the publisher's identity.
const fs=require('node:fs'),path=require('node:path'),c=require('node:crypto'),cp=require('node:child_process');
const {noLinks}=require('../lib/license/storage');
const hash=b=>c.createHash('sha256').update(b).digest('hex');
const stages=['input_validation','powershell','version','json','input_hash','output_directory','compiler_setup','dependency_copy','compile','result','output_verification','receipt'];
// Never forward arbitrary subprocess text, file paths, source lines or environment.
function diagnostic(stage,error){
 const d={stage};
 if(stage==='powershell')try{const line=String(error.stderr||'').split(/\r?\n/).find(s=>s.startsWith('HUB_PREPARE_DIAGNOSTIC:'));const r=JSON.parse(line.slice(23));if(stages.includes(r.stage))d.stage=r.stage;if(['CommandNotFoundException','RuntimeException','IOException','UnauthorizedAccessException','ArgumentException'].includes(r.type))d.type=r.type;if(['Windows_PowerShell_5_1_required','input_changed','copy_changed','reparse_point','compile_failed'].includes(r.reason))d.reason=r.reason;if(Number.isInteger(r.line)&&r.line>0&&r.line<10000)d.line=r.line;if(/^CS[0-9]{4}$/.test(r.compilerCode))d.compilerCode=r.compilerCode;}catch{}
 return d;
}
const compile=String.raw`$ErrorActionPreference='Stop'
[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$stage='version';$compilerCode=''
try {
if($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) { throw 'Windows_PowerShell_5_1_required' }
$stage='json'
$r=[Console]::In.ReadToEnd() | ConvertFrom-Json
$stage='input_hash'
foreach($entry in $r.inputs){if((Get-FileHash -LiteralPath $entry.file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry.sha256){throw 'input_changed'}}
$stage='output_directory'
[void][IO.Directory]::CreateDirectory($r.directory)
for($p=$r.directory;$p;$p=[IO.Path]::GetDirectoryName($p)){if(([IO.File]::GetAttributes($p) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'reparse_point'}}
$stage='compiler_setup'
$parameters=[CodeDom.Compiler.CompilerParameters]::new()
$parameters.GenerateExecutable=$true;$parameters.GenerateInMemory=$false
$parameters.OutputAssembly=$r.file;$parameters.CompilerOptions='/platform:x64 /target:winexe /win32icon:"'+$r.icon+'"'
foreach($assembly in @('System.dll','System.Core.dll','System.Web.Extensions.dll','System.Windows.Forms.dll','System.Drawing.dll')){[void]$parameters.ReferencedAssemblies.Add($assembly)}
$stage='dependency_copy'
foreach($entry in $r.dependencies){$target=[IO.Path]::Combine($r.directory,[IO.Path]::GetFileName($entry.file));[IO.File]::Copy($entry.file,$target,$false);if((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry.sha256){throw 'copy_changed'};if([IO.Path]::GetFileName($target) -ne 'WebView2Loader.dll'){[void]$parameters.ReferencedAssemblies.Add($target)}}
$stage='compiler_setup'
$parameters.TempFiles=[CodeDom.Compiler.TempFileCollection]::new($r.directory,$false)
$provider=[Microsoft.CSharp.CSharpCodeProvider]::new()
$stage='compile'
try{$result=$provider.CompileAssemblyFromSource($parameters,[string[]]@([IO.File]::ReadAllText($r.source)));if($result.Errors.HasErrors -or -not [IO.File]::Exists($r.file)){foreach($issue in $result.Errors){if(-not $issue.IsWarning){$compilerCode=$issue.ErrorNumber;break}};throw 'compile_failed'}}finally{$provider.Dispose()}
$stage='result'
@{ok=$true;file=$r.file} | ConvertTo-Json -Compress
}catch{
# Error messages/positions may contain user paths or source; emit only safe fields.
$d=@{stage=$stage;type=$_.Exception.GetType().Name;line=$_.InvocationInfo.ScriptLineNumber;compilerCode=$compilerCode}
if($_.Exception.Message -cin @('Windows_PowerShell_5_1_required','input_changed','copy_changed','reparse_point','compile_failed')){$d.reason=$_.Exception.Message}
[Console]::Error.WriteLine('HUB_PREPARE_DIAGNOSTIC:'+($d | ConvertTo-Json -Compress));exit 1}`;
function prepare({base,output,execFileSync=cp.execFileSync,platform=process.platform,systemRoot=process.env.SystemRoot||'C:\\Windows',env=process.env}={}){
 let stage='input_validation';
 try{
 if(platform!=='win32'||![base,output].every(p=>typeof p==='string'&&path.isAbsolute(p)&&p===path.resolve(p))||output.toLowerCase()===base.toLowerCase()||output.toLowerCase().startsWith(base.toLowerCase()+path.sep)||base.toLowerCase().startsWith(output.toLowerCase()+path.sep)||fs.existsSync(output))throw Error();
 noLinks(base);noLinks(output);const inspector=require('./finalize-windows.cjs'),original=inspector.verify(base),manifest=original.manifest;
 const source=path.join(base,'hub/app/windows/HubWindow.cs'),vendor='hub/app/windows/vendor/webview2/1.0.4258.31/';
 const relatives=['hub/app/windows/HubWindow.cs',...require('./windows-window.cjs').names.slice(1).map(n=>vendor+n),'hub/app/windows/ProjectHub.ico'];
 const inputs=relatives.map(rel=>{const rows=manifest.files.filter(r=>r.path===rel),file=path.join(base,rel);noLinks(file);const stat=fs.lstatSync(file);if(rows.length!==1||!stat.isFile()||stat.nlink!==1||hash(fs.readFileSync(file))!==rows[0].sha256)throw Error();return {file,sha256:rows[0].sha256};});
 fs.mkdirSync(output,{recursive:false,mode:0o700});const directory=path.join(output,'window'),file=path.join(directory,'ProjectHub.exe');
 const ps=path.win32.join(systemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
 // Restrict only this Windows PowerShell 5.1 child, preserving parent/policy.
 const childEnv=Object.fromEntries(Object.entries(env).filter(([key])=>key.toLowerCase()!=='psmodulepath'));
 childEnv.PSModulePath=path.win32.join(path.win32.dirname(ps),'Modules');
 stage='powershell';
 const result=JSON.parse(String(execFileSync(ps,['-NoLogo','-NoProfile','-NonInteractive','-Command',compile],{input:JSON.stringify({source,icon:inputs.at(-1).file,directory,file,inputs,dependencies:inputs.slice(1,-1)}),encoding:'utf8',timeout:60000,maxBuffer:65536,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe'],env:childEnv})).replace(/^\uFEFF/,''));
 stage='output_verification';
 if(result.ok!==true||result.file!==file)throw Error();
 for(const entry of inputs)if(hash(fs.readFileSync(entry.file))!==entry.sha256)throw Error();
 const files=require('./windows-window.cjs').names.map(name=>{const p=path.join(directory,name);noLinks(p);const s=fs.lstatSync(p);if(!s.isFile()||s.nlink!==1)throw Error();return {path:'window/'+name,bytes:s.size,sha256:hash(fs.readFileSync(p)),mode:s.mode&0o777};});
 for(let i=1;i<files.length;i++)if(files[i].sha256!==inputs[i].sha256)throw Error();
 const actual=inspector.files(output);if(JSON.stringify(actual.map(r=>r.path).sort())!==JSON.stringify(files.map(r=>r.path).sort())||JSON.stringify(inspector.files(base))!==JSON.stringify(original.actual))throw Error();
 const receipt={version:1,kind:'release-windows-preparation',source:manifest.source,baseManifestSha256:original.actual.find(r=>r.path==='release-manifest.json').sha256,inputs:relatives.map(p=>original.actual.find(r=>r.path===p)),files};
 stage='receipt';
 fs.writeFileSync(path.join(output,'preparation.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
 return {publisherSigned:false,requiresManifestRebuildAfterSigning:true,requiresFinalization:true,receiptSha256:hash(fs.readFileSync(path.join(output,'preparation.json'))),files};
 }catch(error){throw Object.assign(Error('release_windows_preparation_failed'),{code:'release_windows_preparation_failed',diagnostic:diagnostic(stage,error)});}
}
if(require.main===module){const args=process.argv.slice(2);if(args.length!==4||args[0]!=='--base'||args[2]!=='--output')throw Error('usage: --base ABS --output ABS');console.log(JSON.stringify(prepare({base:args[1],output:args[3]})));}
module.exports={prepare};
