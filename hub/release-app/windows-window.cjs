'use strict';
// Stable release window: never compile, replace, or delete the shipped executable.
const fs=require('node:fs'),path=require('node:path'),c=require('node:crypto'),cp=require('node:child_process');
const {configuration}=require('../lib/platform/win32-window');
const {noLinks}=require('../lib/license/storage');
const names=Object.freeze(['ProjectHub.exe','Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll','WebView2Loader.dll']);
const hash=b=>c.createHash('sha256').update(b).digest('hex');
const fail=()=>{throw Object.assign(Error('release_windows_window_unavailable'),{code:'release_windows_window_unavailable'});};
const signatureCheck=String.raw`$ErrorActionPreference='Stop'
[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$r=[Console]::In.ReadToEnd() | ConvertFrom-Json
$s=Get-AuthenticodeSignature -LiteralPath $r.file -ErrorAction Stop
if($s.Status -ne 'Valid' -or $null -eq $s.SignerCertificate -or $s.SignerCertificate.Thumbprint.ToUpperInvariant() -cne $r.thumbprint) { throw 'publisher_signature_unconfirmed' }
@{valid=$true;thumbprint=$s.SignerCertificate.Thumbprint.ToUpperInvariant()} | ConvertTo-Json -Compress`;
function inventory(base){
 noLinks(base);const manifestFile=path.join(base,'release-manifest.json');noLinks(manifestFile);
 const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
 if(manifest.kind!=='public-release'||manifest.platform!=='win32'||manifest.arch!=='x64'||!Array.isArray(manifest.files))fail();
 const directory=path.join(base,'window');noLinks(directory);
 if(!fs.lstatSync(directory).isDirectory()||JSON.stringify(fs.readdirSync(directory).sort())!==JSON.stringify([...names].sort()))fail();
 return names.map(name=>{const rel='window/'+name,file=path.join(base,rel),rows=manifest.files.filter(r=>r.path===rel);noLinks(file);const stat=fs.lstatSync(file);
 if(rows.length!==1||!stat.isFile()||stat.nlink!==1||!/^[a-f0-9]{64}$/.test(rows[0].sha256)||hash(fs.readFileSync(file))!==rows[0].sha256)fail();return {file,sha256:rows[0].sha256};});
}
function create({base,publisherThumbprint='',execFileSync=cp.execFileSync,spawn=cp.spawn,systemRoot=process.env.SystemRoot||'C:\\Windows'}={}){
 let poisoned,child,closed=false;
 function prepare(){try{
  if(poisoned||closed)fail();
  if(execFileSync===cp.execFileSync&&(process.platform!=='win32'||process.arch!=='x64'))fail();
  if(typeof base!=='string'||!path.isAbsolute(base)||publisherThumbprint!==''&&!/^[A-F0-9]{40}$/.test(publisherThumbprint))fail();
  const rows=inventory(base),file=rows[0].file;
  if(publisherThumbprint){const ps=path.win32.join(systemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
   const result=JSON.parse(String(execFileSync(ps,['-NoLogo','-NoProfile','-NonInteractive','-Command',signatureCheck],{input:JSON.stringify({file,thumbprint:publisherThumbprint}),encoding:'utf8',timeout:30000,maxBuffer:65536,windowsHide:true,shell:false})).replace(/^\uFEFF/,''));
   if(result.valid!==true||result.thumbprint!==publisherThumbprint)fail();
   const after=inventory(base);if(JSON.stringify(rows)!==JSON.stringify(after))fail();
  }
  return file;
 }catch{poisoned=true;fail();}}
 return {prepare,close(){if(child&&child.exitCode===null&&child.signalCode===null)fail();closed=true;},launch(config){if(child||closed)fail();const file=prepare();child=spawn(file,[],{shell:false,windowsHide:false,stdio:['pipe','inherit','inherit']});child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(config));return child;}};
}
module.exports={configuration,create,inventory,names};
