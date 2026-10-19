'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path');
const P=require('./cache-guard-probe.cjs');
const guard=require('../../lib/platform/cache-guard');
const {create,diagnostic}=require('../../lib/platform/win32-native');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
test('isolated: exact DACL, exclusive creation, digest, handles block rename and DELETE access then release',t=>{
 const root=P.root();fs.mkdirSync(path.join(root,'a'));fs.mkdirSync(path.join(root,'a/b'));
 const g=P.start(root,{testSegments:['a','b']});t.after(()=>{try{g.close();}catch{}});
 assert.equal(P.hash(g.file),g.digest);g.verify();
 const dirs=[root,path.join(root,'a'),path.join(root,'a/b'),path.dirname(path.dirname(g.file)),path.dirname(g.file)];
 for(const dir of dirs){
  assert.throws(()=>P.rename(dir));assert.equal(P.access(dir,'delete'),false);
  // READ|WRITE sharing intentionally permits caller-authorized child creation.
  const f=P.inside(path.join(dir,'write-control'));fs.writeFileSync(f,'control');fs.unlinkSync(f);
 }
 assert.throws(()=>P.rename(g.file));assert.equal(P.access(g.file,'delete'),false);assert.equal(P.access(g.file,'write'),false);
 assert.throws(()=>fs.writeFileSync(g.file,'changed'));assert.throws(()=>fs.unlinkSync(g.file));
 g.releaseTest();
 for(const dir of dirs){P.rename(dir);assert.equal(P.access(dir,'delete'),true);}
 P.rename(g.file);assert.equal(P.access(g.file,'delete'),true);assert.equal(P.access(g.file,'write'),true);
 fs.writeFileSync(g.file,'changed');fs.unlinkSync(g.file);
 for(const dir of [...dirs].reverse())fs.rmdirSync(P.inside(dir));
});
test('same-name FILE_CREATE fails and original guard remains usable',t=>{
 const root=P.root(),g=P.start(root,{testName:'fixed-test-run'});t.after(()=>g.close());
 assert.throws(()=>P.start(root,{testName:'fixed-test-run'}),{reasonCode:'GUARD_NAME_EXISTS'});
 g.verify();
});
test('junction in the held relative chain is refused before cache creation',()=>{
 const root=P.root(),target=path.join(root,'target'),link=path.join(root,'link');fs.mkdirSync(target);
 fs.symlinkSync(target,link,'junction');
 assert.throws(()=>P.start(root,{testSegments:['link']}),{reasonCode:'GUARD_REPARSE_REFUSED'});
 assert.equal(fs.existsSync(path.join(target,'ProjectHub-native-cache')),false);
});
test('handle cleanup removes only owned run including extra regular compile output',()=>{
 const root=P.root(),g=P.start(root),dir=path.dirname(g.file),base=path.dirname(dir);
 const sentinel=path.join(base,'unrelated');fs.writeFileSync(sentinel,'keep');
 fs.writeFileSync(path.join(dir,'extra.tmp'),'compile temp');
 g.close();assert.equal(fs.existsSync(dir),false);assert.equal(fs.readFileSync(sentinel,'utf8'),'keep');
});
test('two resident guards share base without sharing run or breaking other lifetime',()=>{
 const root=P.root(),a=P.start(root),b=P.start(root);
 assert.notEqual(a.file,b.file);a.verify();b.verify();a.close();
 assert.ok(fs.existsSync(b.file));b.verify();b.close();
});
test('hardlink count change is detected and closes with failure',()=>{
 const root=P.root(),g=P.start(root);
 fs.linkSync(g.file,path.join(root,'extra-link'));
 assert.throws(()=>g.verify(),{reasonCode:'GUARD_LINK_COUNT'});
 assert.throws(()=>g.close());
});
test('real guard termination poisons all bridge APIs with no further native launch',async()=>{
 const root=P.root();let actual,calls=0;
 const n=create({localAppData:root,guardFactory:opts=>actual=P.start(root,{onDeath:opts.onDeath}),
  execFileSync(file,args,opts){calls++;const r=JSON.parse(opts.input);return JSON.stringify({ok:true,id:r.id,value:true});}});
 n.call('clock');actual.terminate();await delay(300);
 for(const call of [()=>n.call('clock'),()=>n.asyncCall('clock',{},()=>{}),()=>n.watch(()=>{})])assert.throws(call,{reasonCode:'GUARD_EXITED'});
 assert.equal(calls,1);assert.throws(()=>n.close());
});
test('production root chain is checked without fixture anchoring; sandbox refusal is not a pass',t=>{
 let g;
 try {g=guard.create({source:P.source,root:process.env.LOCALAPPDATA,powershell:P.powershell});g.verify();g.close();}
 catch(e){
  const d=diagnostic(e);t.diagnostic(JSON.stringify(d));
  if(d.stage==='guard-ancestors'&&d.errorCode==='GUARD_ACCESS_DENIED') t.skip('environment constraint: full production ancestor chain not validated');
  else throw e;
 }
});


test('two product bridges: unchanged helper clock sync/async and watch share guarded base',async()=>{
 const root=P.root(),guards=[];
 const factory=opts=>{const g=guard.createClient({...opts,root,script:guard.makeScript(true)});guards.push(g);return g;};
 const a=create({localAppData:root,guardFactory:factory}),b=create({localAppData:root,guardFactory:factory});
 try {
  assert.equal(typeof a.call('clock'),'number');assert.equal(typeof b.call('clock'),'number');
  assert.notEqual(guards[0].file,guards[1].file);
  assert.equal(typeof await new Promise((resolve,reject)=>a.asyncCall('clock',{},(e,v)=>e?reject(e):resolve(v))),'number');
  let errors=0;const stop=b.watch(()=>{},()=>errors++);assert.equal(await stop.ready,true);stop();
  await a.close();assert.equal(typeof b.call('clock'),'number');await b.close();
  assert.equal(errors,0);for(const g of guards)assert.equal(fs.existsSync(path.dirname(g.file)),false);
 } finally {try{a.close();}catch{}try{b.close();}catch{}}
});
