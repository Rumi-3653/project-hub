'use strict';
// Read-only comparison of returned BUILD artifacts, never a Hub/data startup.
// Hash agreement is not publisher identity, OS trust, or an ACL attestation.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {verify,files}=require('./finalize-windows.cjs'),{names}=require('./windows-window.cjs');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const fail=()=>{throw Error('windows_return_not_verified');};
function verifyReturn({base,prepared,completed}={}){
 for(const root of [base,prepared,completed])if(typeof root!=='string'||!path.isAbsolute(root)||root!==path.resolve(root))fail();
 const original=verify(base),actual=files(completed),p=files(prepared),raw=actual.find(r=>r.path==='release-manifest.json');if(!raw)fail();
 const m=JSON.parse(fs.readFileSync(path.join(completed,'release-manifest.json'))),receipt=JSON.parse(fs.readFileSync(path.join(prepared,'preparation.json')));
 if(m.source!==original.manifest.source||m.releaseVersion!==original.manifest.releaseVersion||m.platform!=='win32'||m.kind!=='public-release'||m.publisherSigned!==false||m.notarized!==false||m.windowsNativePrepared!==true||m.distribution!=='publisher-free'||m.publisherThumbprint!==''||!Array.isArray(m.files))fail();
 if(JSON.stringify(Object.keys(m).sort())!==JSON.stringify([...new Set([...Object.keys(original.manifest),'publisherSigned','windowsNativePrepared','publisherThumbprint','distribution'])].sort()))fail();
 for(const key of Object.keys(original.manifest))if(!['files','publisherSigned','windowsNativePrepared','publisherThumbprint','distribution'].includes(key)&&JSON.stringify(m[key])!==JSON.stringify(original.manifest[key]))fail();
 const added=names.map(n=>'window/'+n),expected=[...original.manifest.files.filter(r=>!r.path.startsWith('window/')).map(r=>r.path),...added].sort();
 if(JSON.stringify(m.files.map(r=>r.path).sort())!==JSON.stringify(expected)||JSON.stringify(actual.map(r=>r.path).filter(n=>n!=='release-manifest.json').sort())!==JSON.stringify(expected)||JSON.stringify(p.map(r=>r.path).sort())!==JSON.stringify(['preparation.json',...added].sort()))fail();
 if(receipt.version!==1||receipt.kind!=='release-windows-preparation'||receipt.source!==m.source||receipt.baseManifestSha256!==original.actual.find(r=>r.path==='release-manifest.json').sha256||!Array.isArray(receipt.inputs)||!Array.isArray(receipt.files))fail();
 const inputs=['hub/app/windows/HubWindow.cs',...names.slice(1).map(n=>'hub/app/windows/vendor/webview2/1.0.4258.31/'+n),'hub/app/windows/ProjectHub.ico'];
 if(JSON.stringify(receipt.inputs.map(r=>r.path).sort())!==JSON.stringify([...inputs].sort())||JSON.stringify(receipt.files.map(r=>r.path).sort())!==JSON.stringify([...added].sort()))fail();
 for(const row of receipt.inputs){const r=original.manifest.files.find(r=>r.path===row.path);if(!r||row.bytes!==r.bytes||row.sha256!==r.sha256||!Number.isInteger(row.mode)||row.mode<0||row.mode>0o777||(row.mode&0o200)!==(r.mode&0o200))fail();}
 const extractionModes=[];
 for(const row of m.files){const real=actual.find(r=>r.path===row.path);if(!real||real.bytes!==row.bytes||real.sha256!==row.sha256||!Number.isInteger(row.mode)||row.mode<0||row.mode>0o777)fail();
  const old=original.manifest.files.find(r=>r.path===row.path);
  if(old){if(old.bytes!==row.bytes||old.sha256!==row.sha256||old.mode!==row.mode)fail();}
  else {const r=receipt.files.find(r=>r.path===row.path),preparedRow=p.find(r=>r.path===row.path);if(!r||!preparedRow||r.bytes!==row.bytes||r.sha256!==row.sha256||r.mode!==row.mode||preparedRow.sha256!==row.sha256||preparedRow.bytes!==row.bytes)fail();}
  if(real.mode!==row.mode)extractionModes.push({path:row.path,logical:row.mode,extracted:real.mode});
 }
 for(const name of names.slice(1)){const dep=original.manifest.files.find(r=>r.path==='hub/app/windows/vendor/webview2/1.0.4258.31/'+name),row=m.files.find(r=>r.path==='window/'+name);if(!dep||dep.sha256!==row.sha256)fail();}
 return {format:'project-hub-windows-return-verification-v1',source:m.source,version:m.releaseVersion,files:actual.length,baseManifestSha256:original.actual.find(r=>r.path==='release-manifest.json').sha256,completedManifestSha256:raw.sha256,receiptSha256:p.find(r=>r.path==='preparation.json').sha256,allBytesKindsAndNoExtras:true,logicalModesMatch:true,extractionModeDifferences:extractionModes,windowsAclVerified:false,publisherSigned:false,applicationLaunched:false,requiresWindowsRunResult:true};
}
if(require.main===module){const a=process.argv.slice(2);if(a.length!==6||a[0]!=='--base'||a[2]!=='--prepared'||a[4]!=='--completed')fail();console.log(JSON.stringify(verifyReturn({base:a[1],prepared:a[3],completed:a[5]}),null,2));}
module.exports={verifyReturn};
