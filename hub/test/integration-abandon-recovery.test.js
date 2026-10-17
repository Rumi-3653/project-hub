'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{randomUUID,createHash}=require('node:crypto');
const R=require('../lib/integration-abandon-recovery'),hash=x=>createHash('sha256').update(x).digest('hex');
function fixture(t){
 const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'abort-recovery-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.mkdirSync(path.join(dir,'history'));
 const r={id:randomUUID(),project:'p',task:'t',target:dir,items:[{state:'整理中'}],auto:{stopped:{reason:'human'},attempts:{key:{phase:'organize'}}}};
 const file=path.join(dir,'active.json'),history=path.join(dir,'history',r.id+'.json');fs.writeFileSync(file,JSON.stringify(r,null,2));
 const h={dir,file:()=>file,read:()=>JSON.parse(fs.readFileSync(file)),save:r=>fs.writeFileSync(file,JSON.stringify(r,null,2))};
 const a={at:new Date().toISOString(),by:'human',reason:'stopped-organize',original:r,evidence:{recordHash:hash(JSON.stringify(r)),sha256:'a'.repeat(64),attempts:{key:{kind:'cancelled-by-human'}}},attempts:{key:'cancelled-by-human'}};
 return {dir,r,file,history,h,archive:R.reconstruct(r,a)};
}
for(const mode of ['valid','current-change','history-change','bad-evidence','missing','symlink'])test('abort residue classification: '+mode,t=>{
 const f=fixture(t);fs.writeFileSync(f.history,JSON.stringify(f.archive,null,2));
 if(mode==='current-change'){f.r.extra=true;f.h.save(f.r);}
 if(mode==='history-change')fs.appendFileSync(f.history,' ');
 if(mode==='bad-evidence'){f.archive.abandoned.evidence.recordHash='bad';fs.writeFileSync(f.history,JSON.stringify(f.archive,null,2));}
 if(mode==='missing'){f.h.save(f.archive);fs.unlinkSync(f.history);}
 if(mode==='symlink'){const other=f.history+'.other';fs.renameSync(f.history,other);fs.symlinkSync(other,f.history);assert.throws(()=>R.residue(f.h,'p','t'));return;}
 const x=R.residue(f.h,'p','t');assert.equal(x.kind,mode==='valid'?'archived-not-saved':mode==='missing'?'missing-archive':'diverged');if(mode!=='valid')assert.equal(Boolean(x.action),false);
});
for(const mode of ['existing-same','existing-different','link-failure'])test('torn archive quarantine never overwrites preserved bytes: '+mode,t=>{
 const f=fixture(t);fs.writeFileSync(f.history,'{"torn":');const bytes=fs.readFileSync(f.history),x=R.residue(f.h,'p','t'),dst=x.file+'.torn-'+x.sha256,link=fs.linkSync;
 if(mode==='existing-same')fs.writeFileSync(dst,bytes);if(mode==='existing-different')fs.writeFileSync(dst,'do not overwrite');if(mode==='link-failure')fs.linkSync=()=>{throw Error('injected full disk');};
 try{if(mode==='existing-same'){const out=R.commit(f.h,x,f.r);assert.equal(out.recovered,'quarantine');assert.equal(fs.existsSync(f.history),false);assert.deepEqual(fs.readFileSync(dst),bytes);}else{assert.throws(()=>R.commit(f.h,x,f.r));assert.deepEqual(fs.readFileSync(f.history),bytes);if(mode==='existing-different')assert.equal(fs.readFileSync(dst,'utf8'),'do not overwrite');}}finally{fs.linkSync=link;}
});
test('failed finalization retains immutable archive and can be reclassified',t=>{
 const f=fixture(t);fs.writeFileSync(f.history,JSON.stringify(f.archive,null,2));const bytes=fs.readFileSync(f.history),x=R.residue(f.h,'p','t'),save=f.h.save;
 f.h.save=()=>{throw Error('injected active save failure');};assert.throws(()=>R.commit(f.h,x,f.r));assert.deepEqual(fs.readFileSync(f.history),bytes);assert.equal(R.residue(f.h,'p','t').kind,'archived-not-saved');
 f.h.save=save;R.commit(f.h,x,f.r);assert.equal(R.residue(f.h,'p','t').kind,'finalized');assert.deepEqual(fs.readFileSync(f.file),bytes);
});
