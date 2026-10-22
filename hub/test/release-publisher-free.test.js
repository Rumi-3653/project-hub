'use strict';
// Synthetic release trees and injected build functions only. No compiler,
// application, shell command, signature service, or real user data is used.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {finish}=require('../release-app/finish-unsigned-windows.cjs'),{verify}=require('../release-app/finalize-windows.cjs'),{prepare:packageUpdate}=require('../release-app/package-update.cjs');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function fixture(t){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'publisher-free-synthetic-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const base=path.join(root,'base');fs.mkdirSync(base);
 const manifest={version:1,kind:'public-release',platform:'win32',arch:'x64',port:4545,shellProtocol:1,source:'a'.repeat(40),releaseVersion:'4.125.2',publisherSigned:false,windowsNativePrepared:false,files:[]};
 function put(relative,bytes){const p=path.join(base,relative);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,bytes,{mode:0o644});manifest.files.push({path:relative,bytes:Buffer.byteLength(bytes),sha256:sha(bytes),mode:0o644});}
 for(const n of ['server.js','release-app/core.cjs','release-app/protocol.cjs','release-app/license.cjs','paid-bundle.json'])put('hub/'+n,'synthetic');
 put('hub/release-app/launch.cjs',"window.create({base,publisherThumbprint:''});");
 put('hub/release-app/runtime.cjs',"exports.verifyPackage=base=>JSON.parse(require('node:fs').readFileSync(require('node:path').join(base,'release-manifest.json')));");
 for(let i=0;i<101;i++)put('hub/synthetic-'+i+'.js','synthetic');
 const save=()=>fs.writeFileSync(path.join(base,'release-manifest.json'),JSON.stringify(manifest));save();
 const calls=[];const args={base,platform:'win32',arch:'x64',prepareBuild(options){calls.push(['prepare',options]);fs.mkdirSync(options.output);fs.writeFileSync(path.join(options.output,'retained'),'synthetic compilation');return {synthetic:true};},finalizeBuild(options){calls.push(['finalize',options]);fs.cpSync(options.base,options.output,{recursive:true});const m={...manifest,publisherSigned:false,distribution:'publisher-free',windowsNativePrepared:true};fs.writeFileSync(path.join(options.output,'release-manifest.json'),JSON.stringify(m));return {synthetic:true};}};
 return {root,base,manifest,args,calls,save,prepared:base+'-native-prepared',output:base+'-publisher-free',report:base+'-completion.json'};
}
function snapshot(root){const result={};function walk(dir,prefix=''){for(const n of fs.readdirSync(dir)){const p=path.join(dir,n),s=fs.lstatSync(p);if(s.isDirectory())walk(p,prefix+n+'/');else result[prefix+n]={sha256:sha(fs.readFileSync(p)),mode:s.mode&0o777};}}walk(root);return result;}
test('publisher-free completion creates verified siblings and preserves its complete original input',t=>{
 const f=fixture(t),before=snapshot(f.base),result=finish(f.args);
 assert.deepEqual(snapshot(f.base),before);assert.equal(result.publisherSigned,false);assert.equal(result.applicationLaunched,false);assert.equal(result.liveAcceptanceEnabled,false);assert.equal(result.baseManifestSha256,before['release-manifest.json'].sha256);
 assert.deepEqual(f.calls.map(c=>c[0]),['prepare','finalize']);assert.deepEqual(f.calls[0][1],{base:f.base,output:f.prepared,platform:'win32'});assert.deepEqual(f.calls[1][1],{base:f.base,prepared:f.prepared,output:f.output,unsigned:true,platform:'win32',arch:'x64'});
 assert.equal(verify(f.output).manifest.windowsNativePrepared,true);assert.equal(JSON.parse(fs.readFileSync(f.report)).source,f.manifest.source);
 const retained=snapshot(f.root);assert.throws(()=>finish(f.args),/previous_output_retained_do_not_retry/);assert.deepEqual(snapshot(f.root),retained);assert.equal(f.calls.length,2);
});
for(const existing of ['prepared','output','report'])test('completion rejects existing '+existing+' before build calls',t=>{const f=fixture(t);if(existing==='report')fs.writeFileSync(f.report,'retained');else fs.mkdirSync(f[existing]);const before=snapshot(f.root);assert.throws(()=>finish(f.args),/previous_output_retained_do_not_retry/);assert.equal(f.calls.length,0);assert.deepEqual(snapshot(f.root),before);});
for(const [platform,arch] of [['darwin','x64'],['linux','x64'],['win32','arm64'],['win32','ia32']])test('completion rejects '+platform+'/'+arch+' without outputs',t=>{const f=fixture(t),before=snapshot(f.root);assert.throws(()=>finish({...f.args,platform,arch}),/windows_x64_required/);assert.equal(f.calls.length,0);assert.deepEqual(snapshot(f.root),before);});
test('preparation failure retains partial output and input without invoking finalization or retrying',t=>{
 const f=fixture(t),before=snapshot(f.base);let finalized=0;f.args.prepareBuild=({output})=>{fs.mkdirSync(output);fs.writeFileSync(path.join(output,'partial'),'compiler failure evidence');throw Error('synthetic_compile_failure');};f.args.finalizeBuild=()=>{finalized++;};
 assert.throws(()=>finish(f.args),/synthetic_compile_failure/);assert.deepEqual(snapshot(f.base),before);assert.equal(fs.readFileSync(path.join(f.prepared,'partial'),'utf8'),'compiler failure evidence');assert.equal(finalized,0);assert.equal(fs.existsSync(f.output),false);assert.equal(fs.existsSync(f.report),false);
 assert.throws(()=>finish(f.args),/previous_output_retained_do_not_retry/);assert.equal(finalized,0);
});
test('finalization failure retains input and both intermediate directories without a completion report',t=>{
 const f=fixture(t),before=snapshot(f.base);f.args.finalizeBuild=({output})=>{fs.mkdirSync(output);fs.writeFileSync(path.join(output,'partial'),'finalize evidence');throw Error('synthetic_finalize_failure');};
 assert.throws(()=>finish(f.args),/synthetic_finalize_failure/);assert.deepEqual(snapshot(f.base),before);assert.equal(fs.existsSync(path.join(f.prepared,'retained')),true);assert.equal(fs.readFileSync(path.join(f.output,'partial'),'utf8'),'finalize evidence');assert.equal(fs.existsSync(f.report),false);
});
test('unprepared Windows runtime cannot become an update archive',t=>{const f=fixture(t),destination=path.join(f.root,'update'),before=snapshot(f.base);assert.throws(()=>packageUpdate(f.base,destination,{seq:1,now:1800000000000}),/release_update_input/);assert.equal(fs.existsSync(destination),false);assert.deepEqual(snapshot(f.base),before);});
test('generated Windows creation command has an exact offline command allowlist and an inventoried allowed path',t=>{
 const build=fs.readFileSync(path.join(__dirname,'../release-app/build.cjs'),'utf8'),match=build.match(/put\('MAKE-WINDOWS-APP\.cmd',('(?:[^'\\]|\\.)*')\)/);assert.ok(match);
 // Decode only the JavaScript string literal, never execute the batch file.
 const command=JSON.parse('"'+match[1].slice(1,-1).replace(/"/g,'\\"')+'"');
 assert.deepEqual(command.split('\r\n').filter(Boolean),['@echo off','set NODE_OPTIONS=','set NODE_PATH=','cd /d "%~dp0"','node hub\\release-app\\finish-unsigned-windows.cjs --base "%CD%"','pause']);
 const f=fixture(t),p=path.join(f.base,'MAKE-WINDOWS-APP.cmd');fs.writeFileSync(p,command,{mode:0o644});f.manifest.files.push({path:'MAKE-WINDOWS-APP.cmd',bytes:Buffer.byteLength(command),sha256:sha(command),mode:0o644});f.save();assert.equal(verify(f.base).manifest.files.some(r=>r.path==='MAKE-WINDOWS-APP.cmd'),true);
});
