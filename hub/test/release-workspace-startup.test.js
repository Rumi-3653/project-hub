'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),Module=require('node:module'),c=require('node:crypto');
const compiler=require('../release-app/compile.cjs'),repo=path.resolve(__dirname,'../..');
const {LicenseStore}=require('../lib/license/storage'),{PAID,fingerprint,signEnvelope}=require('../lib/license/codec');
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'release-workspace-startup-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const root=path.join(dir,'protected'),data=path.join(dir,'Documents/AI-Workspace');fs.mkdirSync(root);fs.mkdirSync(path.join(data,'Product/合成'),{recursive:true});
  fs.writeFileSync(path.join(data,'Product/合成/PROJECT.md'),'---\nname: 合成\n---\n');
  const issuer=c.generateKeyPairSync('ed25519'),device=c.generateKeyPairSync('ed25519'),now=1800000000;
  const config={licenseEnforcement:true,trustedKeys:{fixture:{publicKey:issuer.publicKey,purposes:['proof','time']}},build:{channel:'release',buildId:'project-hub-4.125.2-mac-arm64',product:'project-hub-4.123',bugfixOf:[]},trialDays:30};
  let secretReads=0,nativeCalls=0,normalCreated=0;
  const dev={id:'fixture-account',dev:fingerprint(device.publicKey)},raw=JSON.stringify({privateKeyPkcs8B64:device.privateKey.export({format:'der',type:'pkcs8'}).toString('base64')});
  const secret={get:id=>{secretReads++;return id===dev.id?raw:null;},put:()=>assert.fail('secret write')};
  const adapter={name:'darwin',secretStore:()=>{nativeCalls++;return secret;},persistence:{syncDirectory(p){const fd=fs.openSync(p,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}}};
  const proof={v:1,ent:'fixture-ent',kind:'purchase',features:PAID,dev:dev.dev,scope:{channel:'release',product:config.build.product,bugfixOf:[]},iat:now,nbf:now,entStartsAt:now,seq:1,exp:null};
  const state={lastSeenAt:now,uptimeSinceAnchor:0,maxSeq:1,anchor:{serverTime:now,seq:1},proofs:[signEnvelope(proof,issuer.privateKey,'fixture')]};
  const options={platform:'darwin',adapter,secret,machineHint:()=>'',elapsed:()=>0,wall:()=>now};
  const cache={};
  function load(name) {
    if(cache[name])return cache[name];
    const file=path.join(repo,'hub/release-app',name+'.cjs'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));const orig=m.require.bind(m);
    m.require=id=>{
      if(id==='./protocol.cjs')return {configFor:()=>config};
      if(id==='./legacy-license.cjs')return {adopt:args=>require('../release-app/legacy-license.cjs').adopt({...args,...options})};
      if(id==='./core.cjs')return {sha:b=>c.createHash('sha256').update(b).digest('hex')};
      if(id==='./workspace.cjs'||id==='./license-hold.cjs')return load(id.slice(2,-4));
      if(id==='./license.cjs')return {lifecycle:require('../purchase-test-app/license.cjs').lifecycle,createLicense:p=>{normalCreated++;return load('license').createLicense(p,options);}};
      return orig(id);
    };
    let source=['runtime','workspace','license'].includes(name)?compiler[name](fs.readFileSync(path.join(repo,'hub/purchase-test-app',name+'.cjs'),'utf8')):fs.readFileSync(file,'utf8');
    if(name==='runtime')source+='\nmodule.exports.fixture=x=>configured=x;';
    m._compile(source,file);return cache[name]=m.exports;
  }
  const runtime=load('runtime'),{Workspace}=load('workspace'),make=()=>new Workspace({root,home:dir,guard:()=>{}});
  function open(){const w=make();w.open();runtime.fixture({root,home:dir,workspace:w});return w;}
  function reserve(){const w=open();w.apply(w.preview({workspace:data}).token);w.close();}
  function licence(){return runtime.createLicense(data);}
  function save(where,which='both'){const s=new LicenseStore(where,adapter);if(which!=='state')s.write('device',dev);if(which!=='device')s.write('state',state);}
  return {dir,root,data,config,proof,state,issuer,save,reserve,open,licence,make,runtime,counts:()=>({secretReads,nativeCalls,normalCreated})};
}
function image(root) {const out={};function walk(dir){if(!fs.existsSync(dir))return;for(const n of fs.readdirSync(dir)){const p=path.join(dir,n),s=fs.lstatSync(p);if(s.isDirectory())walk(p);else out[path.relative(root,p)]={bytes:fs.readFileSync(p).toString('base64'),mode:s.mode&0o777};}}walk(root);return out;}
test('incomplete old owner-era state no longer aborts selected startup; held licence cannot write/register or grant',async t=>{
  const f=fixture(t);f.save(f.data,'state');f.state.proofs=[];new LicenseStore(f.data,{name:'darwin',persistence:{syncDirectory(){}}}).write('state',f.state);
  const before=image(f.data);f.reserve();let w=f.open();assert.equal(w.data.workspace,f.data);assert.equal(w.read().attempted,true);const l=f.licence(),status=l.client.status();
  assert.equal(status.trial.state,'held');assert.equal(status.purchased,false);assert.equal(status.activationAvailable,false);assert.equal(status.purchaseUrl,'');assert.match(w.notice,/以前の利用権を確認できません/);assert.equal(status.diagnostic.code,'LEGACY_LICENSE_UNAVAILABLE');
  l.client.require(['chat_basic']);for(const p of [...PAID,'unknown'])assert.throws(()=>l.client.require([p]),{code:'license_held'});
  await l.client.prepare();l.client.start();assert.throws(()=>l.client.ensureIdentity());await assert.rejects(l.client.refreshTime());await assert.rejects(l.client.activate('not-a-real-code'));await assert.rejects(l.client.introCheckout());
  let read=0;await assert.rejects(l.activateRequest(()=>{read++;return 'not-a-real-code';}));await assert.rejects(l.introRequest(()=>{read++;}));assert.equal(read,2);assert.equal(l.busy(),false);
  f.runtime.workspaceReady();assert.equal(w.read().active.workspace,f.data);w.close();w=f.open();assert.equal(w.data.workspace,f.data);assert.equal(w.notice,'');f.licence();assert.match(w.notice,/以前の利用権/);w.close();
  assert.deepEqual(image(f.data),before);assert.deepEqual(f.counts(),{secretReads:0,nativeCalls:0,normalCreated:0});assert.equal(fs.existsSync(path.join(f.root,'_hub/license')),false);assert.equal(fs.existsSync(path.join(f.root,'registration-claimed.json')),false);
});
test('target partial identity and unfinished adoption journal stay unchanged while general selection commits',t=>{
 for(const fault of ['target-device','journal','unexpected-source-file']) {
  const f=fixture(t);f.save(f.data);
  if(fault==='target-device')f.save(f.root,'device');
  if(fault==='journal'){fs.mkdirSync(path.join(f.root,'_hub'),{recursive:true});fs.writeFileSync(path.join(f.root,'_hub/license-adoption.json'),'{"v":1}\n');}
  if(fault==='unexpected-source-file')fs.writeFileSync(path.join(f.data,'_hub/license/.DS_Store'),'retain');
  const source=image(f.data),target=image(f.root);f.reserve();const w=f.open();assert.equal(f.licence().client.status().trial.state,'held');f.runtime.workspaceReady();assert.equal(w.read().active.workspace,f.data);w.close();assert.deepEqual(image(f.data),source);
  for(const [p,v] of Object.entries(target))assert.deepEqual(image(f.root)[p],v);assert.equal(f.counts().normalCreated,0);
 }
});
test('trial signatures/scopes remain rejected without promotion or target creation',t=>{
 for(const fault of ['key','scope']) {
  const f=fixture(t);if(fault==='scope')f.proof.scope.product='project-hub-purchase-test';
  f.state.proofs=[signEnvelope(f.proof,fault==='key'?c.generateKeyPairSync('ed25519').privateKey:f.issuer.privateKey,'fixture')];f.save(f.data);const before=image(f.data);f.reserve();const w=f.open();assert.equal(f.licence().client.status().purchased,false);f.runtime.workspaceReady();w.close();assert.deepEqual(image(f.data),before);assert.equal(fs.existsSync(path.join(f.root,'_hub/license')),false);
 }
});
test('verified production purchase still adopts normally before selected workspace is ready',t=>{
 const f=fixture(t);f.save(f.data);const before=image(f.data);f.reserve();const w=f.open();const l=f.licence();assert.equal(l.client.status().purchased,true);assert.equal(w.notice,'');f.runtime.workspaceReady();assert.equal(w.read().pending,null);assert.equal(w.read().active.workspace,f.data);w.close();assert.deepEqual(image(f.data),before);assert.equal(f.counts().normalCreated,1);
});
test('no legacy licence still uses normal client and no selection still defers preparation',async t=>{
 const f=fixture(t);let w=f.open();const l=f.runtime.createLicense(f.root);await l.client.prepare();assert.equal(l.client.status().activationAvailable,false);assert.deepEqual(f.counts(),{secretReads:0,nativeCalls:0,normalCreated:1});w.close();
 f.reserve();w=f.open();assert.equal(f.licence().client.status().trial.state,'pending');f.runtime.workspaceReady();w.close();assert.equal(f.counts().normalCreated,2);
});
test('unrelated startup failure still falls back safely instead of committing attempted selection',t=>{
 const f=fixture(t);f.reserve();let w=f.open();assert.equal(w.read().attempted,true);w.close();w=f.open();assert.equal(w.data.workspace,f.root);assert.match(w.notice,/起動が完了しませんでした/);assert.equal(w.read().pending,null);w.close();
});
