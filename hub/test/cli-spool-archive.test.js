'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{randomUUID}=require('node:crypto');
const S=require('../lib/cli-spool'),A=require('../lib/cli-spool-archive');
function fixture(t){
 const tmp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'spool-archive-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const root=path.join(tmp,'cli-runs'),id=randomUUID(),dir=path.join(root,id),pdir=path.join(tmp,'project');fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.mkdirSync(path.join(pdir,'.ai/chat'),{recursive:true});
 const user={role:'user',turn:randomUUID(),request:'request-'+id},row={role:'assistant',request:user.request,text:'final saved',spoolId:id+':final'};
 const o={project:'project',task:'task',pdir,userRow:user,request:user.request,text:'ordinary'};
 fs.writeFileSync(path.join(pdir,'.ai/chat/task.jsonl'),[user,row].map(JSON.stringify).join('\n')+'\n');
 S.atomic(dir,'request.json',{options:o});S.atomic(dir,'owner.json',{pid:2147483647,serverId:'fixture',generation:1});S.atomic(dir,'exit.json',{code:0});fs.writeFileSync(path.join(dir,'out.jsonl'),'');
 const child=new S.SpoolChild(dir,{serverId:'fixture',generation:1});child.phase('finished',{finalRowHash:S.digest(JSON.stringify(row)),completionHash:S.completion(dir)});child.finish();
 const now=Date.now()+4*86400000,result=path.join(tmp,'result.json');return {tmp,root,dir,id,o,row,user,now,result,pdir};
}
test('archive moves exact bytes/modes once and keeps the pinned final chat row',t=>{
 const f=fixture(t),p=A.plan(f.root,{now:f.now});assert.equal(p.items.length,1);const before=A.snapshot(f.dir),chat=fs.readFileSync(path.join(f.pdir,'.ai/chat/task.jsonl'));
 const r=A.apply(p,f.result);assert.equal(r.complete,true);assert.equal(r.moved.length,1);assert.equal(fs.existsSync(f.dir),false);assert.deepEqual(A.snapshot(r.moved[0].path),before);assert.deepEqual(fs.readFileSync(path.join(f.pdir,'.ai/chat/task.jsonl')),chat);
 assert.throws(()=>A.apply(p,f.result),/結果が既に/);assert.deepEqual(S.pending(f.root),[]);
});
for(const mode of ['young','protected','live-owner','changed-output','torn-final','queued','automation','wrong-final','hardlink','symlink'])test('archive holds unsafe evidence: '+mode,t=>{
 const f=fixture(t);let now=f.now,protectedProjects=[];
 if(mode==='young')now=Date.now();
 if(mode==='protected')protectedProjects=['project'];
 if(mode==='live-owner')S.atomic(f.dir,'owner.json',{pid:process.pid,serverId:'live',generation:1});
 if(mode==='changed-output')fs.appendFileSync(path.join(f.dir,'out.jsonl'),'changed');
 if(mode==='torn-final')fs.writeFileSync(path.join(f.dir,'finished.json'),'{');
 if(mode==='queued')fs.writeFileSync(path.join(f.pdir,'.ai/chat/task.queue.json'),JSON.stringify([{id:f.user.request}]));
 if(mode==='automation'){const q=S.read(f.dir,'request.json');q.options.automation={id:'unknown'};S.atomic(f.dir,'request.json',q);}
 if(mode==='wrong-final')fs.appendFileSync(path.join(f.pdir,'.ai/chat/task.jsonl'),JSON.stringify(f.row)+'\n');
 if(mode==='hardlink')fs.linkSync(path.join(f.dir,'out.jsonl'),path.join(f.dir,'linked'));
 if(mode==='symlink')fs.symlinkSync(path.join(f.dir,'out.jsonl'),path.join(f.dir,'linked'));
 const p=A.plan(f.root,{now,protectedProjects});assert.equal(p.items.length,0);assert.equal(p.skipped.length,1);assert.equal(fs.existsSync(f.dir),true);
});
test('archive plan does not override new evidence, an existing batch, or existing destination',t=>{
 const f=fixture(t),p=A.plan(f.root,{now:f.now});fs.writeFileSync(path.join(f.dir,'new-proof'),'new');assert.throws(()=>A.apply(p,f.result),/変わっています/);assert.equal(fs.existsSync(f.dir),true);
 const fresh=A.plan(f.root,{now:f.now});fs.mkdirSync(path.join(fresh.archiveRoot,fresh.id),{recursive:true});assert.throws(()=>A.apply(fresh,f.result),/EEXIST/);assert.equal(fs.existsSync(f.dir),true);
});
test('archive move failure leaves a receipt and forbids blind replay',t=>{
 const f=fixture(t),p=A.plan(f.root,{now:f.now}),rename=fs.renameSync;fs.renameSync=(a,b)=>{if(a===f.dir)throw Error('injected move failure');return rename(a,b);};
 try{assert.throws(()=>A.apply(p,f.result),/injected/);}finally{fs.renameSync=rename;}
 assert.equal(JSON.parse(fs.readFileSync(f.result)).complete,false);assert.equal(fs.existsSync(f.dir),true);assert.throws(()=>A.apply(p,f.result),/結果が既に/);
});
test('uncertain move preserves both the archived data and its active-operation marker',t=>{
 const f=fixture(t),p=A.plan(f.root,{now:f.now}),rename=fs.renameSync;let destination;
 fs.renameSync=(a,b)=>{const out=rename(a,b);if(a===f.dir){destination=b;fs.writeFileSync(path.join(b,'unexpected'),'preserved new evidence');}return out;};
 try{assert.throws(()=>A.apply(p,f.result),/退避後/);}finally{fs.renameSync=rename;}
 const out=JSON.parse(fs.readFileSync(f.result));assert.equal(out.complete,false);assert.equal(out.active,f.id);assert.equal(out.moved.length,0);assert.equal(fs.readFileSync(path.join(destination,'unexpected'),'utf8'),'preserved new evidence');assert.throws(()=>A.apply(p,f.result),/結果が既に/);
});
