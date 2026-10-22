'use strict';
// Host-side JS boundaries only; C#/WebView2/Windows API execution is not claimed.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const cp = require('node:child_process'), { EventEmitter } = require('node:events');
const W = require('../lib/platform/win32-window');
const valid = { root: 'C:\\data', runtime: 'C:\\ProjectHub\\hub', node: 'C:\\node\\node.exe', port: 4545, localAppData: 'C:\\Users\\test\\AppData\\Local' };
test('window configuration rejects remote/ambiguous paths and ports, keeps independent generations and canonical root mutex names', () => {
  const a = W.configuration(valid), b = W.configuration({ ...valid, root: 'c:\\DATA\\' });
  assert.equal(a.rootHash, b.rootHash); assert.notEqual(a.nonce, b.nonce);
  assert.match(a.nonce, /^[a-f0-9]{64}$/); assert.ok(a.profile.endsWith(a.rootHash));
  for (const change of [{root:'\\\\server\\share'}, {node:'node.exe'}, {runtime:'C:\\bad"name'}, {localAppData:undefined}, {port:0}, {port:70000}, {port:4.2}]) assert.throws(() => W.configuration({...valid,...change}));
});
test('three official DLLs are SHA-pinned and license is present; no runtime installer is shipped', () => {
  const dependencies = W.dependencies();
  assert.equal(dependencies.length, 3);
  assert.deepEqual(dependencies.map(d => path.basename(d.file)), ['Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll','WebView2Loader.dll']);
  for (const dep of dependencies) { assert.match(dep.sha256,/^[a-f0-9]{64}$/); assert.ok(fs.readFileSync(dep.file).subarray(0,2).equals(Buffer.from('MZ'))); }
  assert.match(fs.readFileSync(path.join(path.dirname(dependencies[0].file),'LICENSE.txt'),'utf8'), /Microsoft Corporation/);
});
function fixture(t, fail) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-window-test-'));
  const calls = []; let compilation;
  const bridge = W.create({ tempRoot: root, execFileSync(file, args, opts) {
    calls.push({file,args,opts}); compilation=JSON.parse(opts.input);
    if(fail) throw Error('compile failed');
    fs.writeFileSync(compilation.file,'mock executable');
    for(const d of compilation.dependencies)fs.copyFileSync(d.file,path.join(compilation.directory,path.basename(d.file)));
    return JSON.stringify({ok:true,file:compilation.file});
  }, spawn(file,args,opts) {
    calls.push({file,args,opts});const child=new EventEmitter();child.exitCode=null;child.signalCode=null;child.stdin=new EventEmitter();
    child.stdin.end=input=>{child.input=input;};return child;
  }});
  t.after(()=>{try{bridge.close();}finally{fs.rmSync(root,{recursive:true,force:true});}});
  return {bridge,calls,get compilation(){return compilation;}};
}
test('compiler is local fixed source, private SID ACL, x64 and copied DLL references; one launch passes JSON without shell interpolation',t=>{
  const f=fixture(t);const exe=f.bridge.prepare();assert.equal(f.bridge.prepare(),exe);assert.equal(f.calls.length,1);
  const call=f.calls[0];assert.match(call.file,/powershell\.exe$/);assert.equal(call.opts.shell,false);
  assert.equal(call.args.includes('-ExecutionPolicy'),false);assert.match(call.args.at(-1),/SetAccessRuleProtection\(\$true,\$false\)/);
  assert.match(call.args.at(-1),/\/target:winexe/);assert.match(call.args.at(-1),/sdk_copy_changed/);
  assert.match(f.compilation.source,/class HubWindow/);
  assert.equal(f.compilation.icon,path.resolve(__dirname,'../app/windows/ProjectHub.ico'));
  assert.equal(f.compilation.iconSha256,require('node:crypto').createHash('sha256').update(fs.readFileSync(f.compilation.icon)).digest('hex'));
  assert.ok(call.args.at(-1).includes(`/win32icon:"'+$r.icon+'"`));
  assert.match(f.compilation.source,/Icon=System.Drawing.Icon.ExtractAssociatedIcon\(Application.ExecutablePath\)/);
  const config=W.configuration({...valid,root:'C:\\a & 日本語\\$()'});const child=f.bridge.launch(config);
  assert.deepEqual(JSON.parse(child.input),config);assert.equal(f.calls[1].opts.shell,false);assert.deepEqual(f.calls[1].args,[]);
  assert.throws(()=>f.bridge.launch(config),/一回/);assert.throws(()=>f.bridge.close(),/動いて/);
  child.exitCode=0;child.emit('exit',0);assert.equal(fs.existsSync(exe),false);
});
test('compiler failure is poisoned, never replayed',t=>{
  const f=fixture(t,true);assert.throws(()=>f.bridge.prepare(),/compile failed/);assert.throws(()=>f.bridge.prepare(),/compile failed/);assert.equal(f.calls.length,1);
});
test('tampered executable or copied DLL stops launch rather than recompiling',t=>{
  const f=fixture(t);const exe=f.bridge.prepare();fs.appendFileSync(path.join(path.dirname(exe),'WebView2Loader.dll'),'tamper');
  assert.throws(()=>f.bridge.launch(W.configuration(valid)),/cache_changed/);assert.equal(f.calls.length,1);
});
test('Mac file-io is the exact original fs object and never starts a Windows bridge',()=>{
  assert.equal(require('../lib/platform/file-io'),fs);
});
test('Windows file-io is a private wrapper; rename data and errors cross the selected native boundary without patching fs',()=>{
  const script=String.raw`
    (async()=>{
    const fs=require('node:fs'),original=fs.renameSync;
    Object.defineProperty(process,'platform',{value:'win32'});
    const p=require('./lib/platform');const calls=[];let failed=false;
    const real=require('./lib/platform/win32').create({native:{call(a,d){calls.push([a,d]);if(failed)throw Error('denied');return true;}}});
    p.persistence=real.persistence;
    const io=require('./lib/platform/file-io');io.renameSync('C:\\a & b','C:\\dest');
    await io.promises.rename('C:\\async','C:\\dest');failed=true;
    let denied=false;try{io.renameSync('C:\\a','C:\\b')}catch(e){denied=e.message==='denied'}
    let asyncDenied=false;try{await io.promises.rename('C:\\a','C:\\b')}catch(e){asyncDenied=e.message==='denied'}
    if(io===fs||io.promises===fs.promises||fs.renameSync!==original||!denied||!asyncDenied||calls[0][0]!=='rename'||calls[0][1].from!=='C:\\a & b'||calls[1][1].from!=='C:\\async')throw Error('boundary mismatch');
    })().catch(e=>{console.error(e);process.exitCode=1;});
  `;
  const r=cp.spawnSync(process.execPath,['-e',script],{cwd:path.join(__dirname,'..'),encoding:'utf8',env:process.env});
  assert.equal(r.status,0,r.stderr);
});
test('public inspection admits only the three exact Microsoft binaries with original license and copyright notice',()=>{
  const {inspect}=require('../../scripts/export-public'),root=path.resolve(__dirname,'../..');
  const prefix='hub/app/windows/vendor/webview2/1.0.4258.31/';
  const files=[...W.dependencies().map(d=>prefix+path.basename(d.file)),prefix+'LICENSE.txt','THIRD_PARTY_NOTICES.md'];
  const entries=files.map(name=>({name,content:fs.readFileSync(path.join(root,name))}));
  assert.doesNotThrow(()=>inspect(entries));
  assert.throws(()=>inspect(entries.filter(e=>!e.name.endsWith('LICENSE.txt'))),/license missing/);
  assert.throws(()=>inspect(entries.filter(e=>e.name!=='THIRD_PARTY_NOTICES.md')),/copyright notice missing/);
  assert.throws(()=>inspect(entries.map((e,i)=>i===0?{...e,content:Buffer.concat([e.content,Buffer.from('changed')])}:e)),/binary changed/);
  assert.throws(()=>inspect([...entries,{name:prefix+'Other.dll',content:Buffer.from([0xff,0,0xfe])}]),/binary file needs review/);
});
// Static shell contracts supplement the injected JS compiler tests above. These
// checks do not execute C#, HTTP, WebView2 or the Windows shutdown path.
const shellSource = () => fs.readFileSync(path.join(__dirname,'../app/windows/HubWindow.cs'),'utf8');
test('native HTTP budget exceeds the external-workspace process-check bound and stays finite',()=>{
  const source=shellSource(), workspace=fs.readFileSync(path.join(__dirname,'../purchase-test-app/workspace.cjs'),'utf8');
  const budget=Number(source.match(/const int RequestTimeoutMilliseconds=(\d+);/)[1]);
  const guardBudget=Number(workspace.match(/execFileSync\('powershell.exe',[\s\S]*?timeout:(\d+)/)[1]);
  assert.ok(budget>guardBudget,'a legitimate process check must fit inside the native request budget');
  assert.ok(budget<=30000,'network failures must still return to the user within a bounded wait');
  assert.match(source,/r\.Timeout=RequestTimeoutMilliseconds; r\.ReadWriteTimeout=RequestTimeoutMilliseconds/);
});
test('manual close drains polling, preserves ownership before a single quit and logs no response data',()=>{
  const source=shellSource();
  const close=source.slice(source.indexOf('FormClosing+='),source.indexOf('watch.Interval='));
  assert.match(close,/closing=true;[\s\S]*?watch.Stop\(\);[\s\S]*?await pollTask;[\s\S]*?await Quit\(\);/);
  const poll=source.slice(source.indexOf('async Task Poll()'),source.indexOf('void QuitDiagnostic('));
  assert.match(poll,/await Identity\(false\)\|\|closing/);
  assert.match(poll,/await Request\("\/api\/app-update",null\);[\s\S]*?if\(closing\) return/);
  assert.match(poll,/if\(allowed!="true"\|\|closing\) return/);
  const quit=source.slice(source.indexOf('async Task Quit('),source.indexOf('[STAThread]'));
  assert.match(quit,/if\(!quitAccepted\)[\s\S]*?if\(!await Identity\(false,"identity"\)\) throw[\s\S]*?Request\("\/api\/quit",new \{ reason=reason, instance=instance, windowLaunch=Value\("nonce"\) \},"quit-request"\)/);
  assert.equal((quit.match(/Request\("\/api\/quit"/g)||[]).length,1);
  assert.match(quit,/server\.ExitCode!=0/);assert.match(quit,/GetActiveTcpListeners\(\)/);
  assert.match(quit,/if\(!listening\)[\s\S]*?confirmed=true; Close\(\)/);
  assert.doesNotMatch(source,/\.Kill\(|Environment\.Exit\(/);
  const diagnostic=source.slice(source.indexOf('void QuitDiagnostic('),source.indexOf('string QuitStageLabel('));
  assert.match(diagnostic,/elapsed\.ElapsedMilliseconds/);
  assert.doesNotMatch(diagnostic,/Value\(|instance|json\.|\.Message|route|response|\.body/);
});

test('Windows icon contains seven 32-bit sizes and public export accepts only the reviewed artwork',()=>{
 const name='hub/app/windows/ProjectHub.ico',content=fs.readFileSync(path.resolve(__dirname,'../../',name));
 assert.equal(content.readUInt16LE(0),0);assert.equal(content.readUInt16LE(2),1);assert.equal(content.readUInt16LE(4),7);
 const sizes=[];let end=6+7*16;
 for(let i=0;i<7;i++){
  const p=6+i*16,w=content[p]||256,h=content[p+1]||256,length=content.readUInt32LE(p+8),offset=content.readUInt32LE(p+12);
  assert.equal(w,h);assert.equal(content.readUInt16LE(p+4),1);assert.equal(content.readUInt16LE(p+6),32);assert.equal(offset,end);
  assert.equal(content.readUInt32LE(offset),40);assert.equal(content.readInt32LE(offset+4),w);assert.equal(content.readInt32LE(offset+8),h*2);assert.equal(content.readUInt16LE(offset+14),32);
  assert.ok(length>=40+w*h*4);end=offset+length;assert.ok(end<=content.length);sizes.push(w);
 }
 assert.equal(end,content.length);assert.deepEqual(sizes,[16,24,32,48,64,128,256]);
 const {inspect}=require('../../scripts/export-public');assert.doesNotThrow(()=>inspect([{name,content}]));
 const changed=Buffer.from(content);changed[changed.length-1]^=1;
 assert.throws(()=>inspect([{name,content:changed}]),/reviewed product icon changed/);
 assert.throws(()=>inspect([{name:'hub/app/windows/Other.ico',content}]),/binary file needs review/);
});
