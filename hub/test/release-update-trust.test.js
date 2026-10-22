'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),c=require('node:crypto');
const {verifyManifest}=require('../lib/app-update-packaged');
const fixed=require('../release-app/update-trust.cjs'),old=require('../lib/update-trust');
const {signFromKeychain,sha256,loadPlan}=require('../../scripts/sign-update');
function fixture(t,platform='darwin') {
 const pair=c.generateKeyPairSync('ed25519'),now=1800000000000;
 const keys={fixture:{spkiB64:pair.publicKey.export({format:'der',type:'spki'}).toString('base64'),purposes:['app-update']}};
 const trust={...fixed,keys},name=`Project-Hub-4.125.2-Runtime-${platform==='darwin'?'Apple-Silicon':'Windows-x64'}.zip`;
 const m={v:1,typ:'hub-app-update',product:'project-hub',edition:'public',lang:'ja',version:'4.125.2',seq:8,issuedAt:now/1000,expiresAt:now/1000+86400,kind:'bugfix',product_line:'project-hub-4.123',bugfixOf:['project-hub-4.123'],requires:{os:platform,arch:platform==='darwin'?'arm64':'x64',node:'>=22',...(platform==='darwin'?{minMacOS:'13.0'}:{minWindows:'10.0.22000'})},asset:{name,size:3,sha256:c.createHash('sha256').update('zip').digest('hex'),url:fixed.assetPrefix+'v4.125.2/'+name},app:{format:'release-runtime-v1',runtime:'hub',shellProtocol:1,bundleId:'local.projecthub',shortVersion:'4.125.2',entries:2,treeSha256:'a'.repeat(64)},notes:{ja:'fixture'}};
 const sign=value=>{const bytes=Buffer.from(JSON.stringify(value));return {kid:'fixture',payload:bytes.toString('base64url'),sig:c.sign(null,bytes,pair.privateKey).toString('base64url')};};
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-runtime-sign-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const p={runtimeProtocol:1,kid:'fixture',spkiB64:keys.fixture.spkiB64,payloadFile:path.join(root,'payload.json'),assetFile:path.join(root,name),outputFile:path.join(root,'out.json')};fs.writeFileSync(p.assetFile,'zip');p.assetSha256=sha256(p.assetFile);
 const save=()=>{fs.writeFileSync(p.payloadFile,JSON.stringify(m));p.payloadSha256=sha256(p.payloadFile);};save();
 return {m,trust,sign,now,p,save,pair};
}
for(const platform of ['darwin','win32'])test(platform+': release runtime fixed trust and signing plan validate before injected signer',t=>{
 const f=fixture(t,platform);assert.equal(verifyManifest(f.sign(f.m),f.trust,{now:f.now}).version,'4.125.2');
 assert.throws(()=>verifyManifest(f.sign(f.m),{...old,keys:f.trust.keys},{now:f.now}));
 let calls=0;signFromKeychain(f.p,{keys:f.trust,now:f.now,vault:{sign:(kid,spki,bytes)=>{calls++;return c.sign(null,bytes,f.pair.privateKey);}}});assert.equal(calls,1);
});
test('runtime manifest rejects protocol, scope, format, signature, expiry, sequence and destination drift',t=>{
 const f=fixture(t);
 for(const change of [{kind:'feature'},{channel:'purchase-test'},{product_line:'other'},{bugfixOf:[]},{seq:0},{expiresAt:f.now/1000},{asset:{...f.m.asset,name:'other.zip'}},{asset:{...f.m.asset,url:'https://evil.invalid/a.zip'}},{app:{...f.m.app,format:'windows-zip-v1'}},{app:{...f.m.app,shellProtocol:2}}])assert.throws(()=>verifyManifest(f.sign({...f.m,...change}),f.trust,{now:f.now}));
 assert.throws(()=>verifyManifest(f.sign(f.m),{...f.trust,runtimeProtocol:2},{now:f.now}));
 assert.throws(()=>verifyManifest(f.sign(f.m),{...f.trust,revokedKids:['fixture']},{now:f.now}));
 assert.throws(()=>verifyManifest(f.sign(f.m),f.trust,{now:f.now,maxSeq:8}));
 assert.throws(()=>verifyManifest({...f.sign(f.m),sig:Buffer.alloc(64).toString('base64url')},f.trust,{now:f.now}));
});
test('invalid runtime signing candidate never calls secret signer',t=>{
 for(const fault of ['protocol','tree','time','os','name','size','line','channel']) {
 const f=fixture(t);if(fault==='protocol')f.p.runtimeProtocol=2;if(fault==='tree')f.m.app.treeSha256='bad';if(fault==='time')f.m.expiresAt=f.now/1000;if(fault==='os')f.m.requires.os='linux';if(fault==='name')f.m.asset.name='wrong.zip';if(fault==='size')f.m.asset.size=0;if(fault==='line')f.m.product_line='other';if(fault==='channel')f.p.channel='purchase-test';f.save();
 let accesses=0;assert.throws(()=>signFromKeychain(f.p,{keys:f.trust,now:f.now,vault:{sign:()=>{accesses++;throw Error('secret acquisition');}}}));assert.equal(accesses,0);
 }
});
test('native payload validator accepts stable runtime and rejects changed scope without Keychain access',t=>{
 if(process.platform!=='darwin')return t.skip('Swift fixture requires macOS');
 const f=fixture(t),dir=path.dirname(f.p.payloadFile),native=path.join(dir,'native.swift'),main=path.join(dir,'main.swift'),binary=path.join(dir,'validate');
 fs.copyFileSync(path.join(__dirname,'../../scripts/release-keychain.swift'),native);
 fs.writeFileSync(main,'import Foundation\nlet data=FileHandle.standardInput.readDataToEndOfFile()\ndo { _ = try signingPayload(data.base64EncodedString(), now:1800000000); print("valid") } catch { exit(1) }\n');
 const {execFileSync}=require('node:child_process');
 execFileSync('/usr/bin/xcrun',['swiftc','-D','RELEASE_SIGNING_FIXTURE','-module-cache-path',path.join(dir,'modules'),native,main,'-o',binary],{stdio:['ignore','pipe','pipe'],timeout:120000});
 for(const platform of ['darwin','win32']){
 const g=fixture(t,platform);assert.match(execFileSync(binary,[],{input:JSON.stringify(g.m),encoding:'utf8'}),/valid/);
 for(const mutate of [m=>{m.product_line='other';},m=>{m.app.shellProtocol=2;},m=>{m.requires.os='linux';},m=>{m.expiresAt=1800000000;},m=>{m.app.treeSha256='bad';},m=>{m.asset.size=0;}]){const bad=structuredClone(g.m);mutate(bad);assert.throws(()=>execFileSync(binary,[],{input:JSON.stringify(bad),stdio:['pipe','pipe','pipe']}));}
 }
});

test('runtime sign plan selects asset paths and rejects unknown protocol before secrets',t=>{
 const f=fixture(t),file=path.join(path.dirname(f.p.payloadFile),'plan.json');
 const p={format:'project-hub-existing-key-sign-plan-v1',runtimeProtocol:1,payload:'payload.json',asset:path.basename(f.p.assetFile),output:'signed.json'};
 fs.writeFileSync(file,JSON.stringify(p));const loaded=loadPlan(file,sha256(file));assert.equal(loaded.assetFile,f.p.assetFile);assert.equal(loaded.dmgFile,undefined);
 p.runtimeProtocol=2;fs.writeFileSync(file,JSON.stringify(p));assert.throws(()=>loadPlan(file,sha256(file)));
});
