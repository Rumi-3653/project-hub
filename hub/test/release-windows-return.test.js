'use strict';
// Synthetic files only. The injected compiler writes text, never executes a
// process; preparation, unsigned finalization and return verification are real.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {prepare}=require('../release-app/prepare-windows.cjs'),{finalize}=require('../release-app/finalize-windows.cjs'),{verifyReturn}=require('../release-app/verify-windows-return.cjs'),{names}=require('../release-app/windows-window.cjs');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function snapshot(root){const result={};function walk(dir,prefix=''){for(const n of fs.readdirSync(dir)){const p=path.join(dir,n),s=fs.lstatSync(p);if(s.isDirectory())walk(p,prefix+n+'/');else result[prefix+n]={bytes:fs.readFileSync(p).toString('base64'),mode:s.mode&0o777};}}walk(root);return result;}
function fixture(t){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'windows-return-synthetic-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const base=path.join(root,'base'),prepared=path.join(root,'prepared'),completed=path.join(root,'completed');fs.mkdirSync(base);
 const manifest={version:1,kind:'public-release',platform:'win32',arch:'x64',port:4545,shellProtocol:1,source:'a'.repeat(40),releaseVersion:'4.125.2',publisherSigned:false,notarized:false,windowsNativePrepared:false,distribution:'publisher-free',liveAcceptance:false,files:[]};
 function put(relative,bytes,mode=0o644){const p=path.join(base,relative);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,bytes);fs.chmodSync(p,mode);manifest.files.push({path:relative,bytes:Buffer.byteLength(bytes),sha256:sha(bytes),mode});}
 for(const n of ['server.js','release-app/core.cjs','release-app/protocol.cjs','release-app/runtime.cjs','release-app/license.cjs','paid-bundle.json'])put('hub/'+n,'synthetic '+n);
 put('hub/release-app/launch.cjs',"window.create({base,publisherThumbprint:''});");put('hub/app/windows/HubWindow.cs','synthetic compiler input',0o640);put('hub/app/windows/ProjectHub.ico','synthetic icon');
 for(const name of names.slice(1))put('hub/app/windows/vendor/webview2/1.0.4258.31/'+name,'synthetic SDK '+name);
 for(let i=0;i<101;i++)put('hub/synthetic-'+i+'.js','synthetic');
 fs.writeFileSync(path.join(base,'release-manifest.json'),JSON.stringify(manifest));const original=snapshot(base);let compileCalls=0;
 prepare({base,output:prepared,platform:'win32',execFileSync(_file,_args,options){compileCalls++;assert.equal(options.shell,false);const r=JSON.parse(options.input);fs.mkdirSync(r.directory);fs.writeFileSync(r.file,'synthetic executable bytes');fs.chmodSync(r.file,0o750);for(const dep of r.dependencies)fs.copyFileSync(dep.file,path.join(r.directory,path.basename(dep.file)));return JSON.stringify({ok:true,file:r.file});}});
 finalize({base,prepared,output:completed,unsigned:true,platform:'win32',arch:'x64',execFileSync(){assert.fail('unsigned path must never request signature verification');}});
 assert.equal(compileCalls,1);assert.deepEqual(snapshot(base),original);
 const receiptPath=path.join(prepared,'preparation.json'),manifestPath=path.join(completed,'release-manifest.json');
 return {base,prepared,completed,original,receiptPath,manifestPath};
}
function changeJson(file,mutate){const v=JSON.parse(fs.readFileSync(file));mutate(v);fs.writeFileSync(file,JSON.stringify(v));}
test('real preparation and unsigned finalization produce a read-only verifiable synthetic return',t=>{
 const f=fixture(t),before=[f.base,f.prepared,f.completed].map(snapshot),r=verifyReturn(f);
 assert.equal(r.allBytesKindsAndNoExtras,true);assert.equal(r.logicalModesMatch,true);assert.deepEqual(r.extractionModeDifferences,[]);assert.equal(r.windowsAclVerified,false);assert.equal(r.publisherSigned,false);assert.equal(r.applicationLaunched,false);assert.equal(r.requiresWindowsRunResult,true);assert.equal(r.baseManifestSha256,sha(fs.readFileSync(path.join(f.base,'release-manifest.json'))));assert.equal(r.receiptSha256,sha(fs.readFileSync(f.receiptPath)));
 assert.deepEqual([f.base,f.prepared,f.completed].map(snapshot),before);assert.deepEqual(snapshot(f.base),f.original);
});
for(const fault of ['completed-byte','prepared-byte','completed-extra','prepared-extra','base-byte','receipt-source','receipt-base','receipt-input-sha','receipt-icon-sha','receipt-output-sha','receipt-input-mode','receipt-output-mode','receipt-missing-input','receipt-extra-output','manifest-source','manifest-original-byte','manifest-extra-key'])test('return refuses '+fault+' and leaves all supplied evidence intact',t=>{
 const f=fixture(t);
 if(fault==='completed-byte')fs.appendFileSync(path.join(f.completed,'window/ProjectHub.exe'),'changed');
 if(fault==='prepared-byte')fs.appendFileSync(path.join(f.prepared,'window/ProjectHub.exe'),'changed');
 if(fault==='completed-extra')fs.writeFileSync(path.join(f.completed,'extra'),'unexpected');
 if(fault==='prepared-extra')fs.writeFileSync(path.join(f.prepared,'extra'),'unexpected');
 if(fault==='base-byte')fs.appendFileSync(path.join(f.base,'hub/server.js'),'changed');
 if(fault==='receipt-source')changeJson(f.receiptPath,r=>r.source='b'.repeat(40));
 if(fault==='receipt-base')changeJson(f.receiptPath,r=>r.baseManifestSha256='0'.repeat(64));
 if(fault==='receipt-input-sha')changeJson(f.receiptPath,r=>r.inputs[0].sha256='0'.repeat(64));
 if(fault==='receipt-icon-sha')changeJson(f.receiptPath,r=>r.inputs.find(row=>row.path==='hub/app/windows/ProjectHub.ico').sha256='0'.repeat(64));
 if(fault==='receipt-output-sha')changeJson(f.receiptPath,r=>r.files[0].sha256='0'.repeat(64));
 if(fault==='receipt-input-mode')changeJson(f.receiptPath,r=>r.inputs[0].mode=-1);
 if(fault==='receipt-output-mode')changeJson(f.receiptPath,r=>r.files[0].mode=0o1000);
 if(fault==='receipt-missing-input')changeJson(f.receiptPath,r=>r.inputs.pop());
 if(fault==='receipt-extra-output')changeJson(f.receiptPath,r=>r.files.push({...r.files[0],path:'window/extra.dll'}));
 if(fault==='manifest-source')changeJson(f.manifestPath,m=>m.source='b'.repeat(40));
 if(fault==='manifest-original-byte'){
  const file=path.join(f.completed,'hub/server.js');fs.appendFileSync(file,'rehashed modification');changeJson(f.manifestPath,m=>{const r=m.files.find(r=>r.path==='hub/server.js');r.bytes=fs.statSync(file).size;r.sha256=sha(fs.readFileSync(file));});
 }
 if(fault==='manifest-extra-key')changeJson(f.manifestPath,m=>m.unreviewedSetting=true);
 const before=[f.base,f.prepared,f.completed].map(snapshot);assert.throws(()=>verifyReturn(f));assert.deepEqual([f.base,f.prepared,f.completed].map(snapshot),before);
});
test('extraction permission differences are reported without changing logical modes or files',t=>{
 const f=fixture(t),relative='window/ProjectHub.exe';fs.chmodSync(path.join(f.completed,relative),0o644);const before=[f.base,f.prepared,f.completed].map(snapshot),r=verifyReturn(f);
 assert.equal(r.logicalModesMatch,true);assert.deepEqual(r.extractionModeDifferences,[{path:relative,logical:0o750,extracted:0o644}]);assert.equal(r.windowsAclVerified,false);assert.deepEqual([f.base,f.prepared,f.completed].map(snapshot),before);
});

for(const stage of ['base','prepared','completed'])test('R1 return rejects an extra empty directory in '+stage+' and preserves supplied trees',t=>{
 const f=fixture(t),extra=path.join(f[stage],stage==='base'?'hub':'window','unlisted','empty');fs.mkdirSync(extra,{recursive:true});
 const before=[f.base,f.prepared,f.completed].map(snapshot);
 assert.throws(()=>verifyReturn(f));assert.equal(fs.statSync(extra).isDirectory(),true);
 assert.deepEqual([f.base,f.prepared,f.completed].map(snapshot),before);
});
