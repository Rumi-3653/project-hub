'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {fixture}=require('./helpers/stopped-sibling-fixture'),git=require('../lib/git'),chat=require('../lib/chat'),projection=require('../lib/integration-report-projection'),review=require('../lib/integration-review'),{IntegrateAuto}=require('../lib/integrate-auto');
const g=(d,...args)=>execFileSync('git',['--literal-pathspecs','-C',d,...args],{encoding:'utf8',stdio:'pipe'}).trim();
async function mixed(t){
 const f=await fixture(t),c=f.report,head=git.inspect(c.workdir).head,sourceBranch=git.inspect(c.workdir).branch;
 // The real shape is four report additions, a task note addition and INDEX
 // modification. Seed INDEX into the common ancestor without touching a user.
 // Rebase only this synthetic child to a fixture base carrying the old INDEX.
 g(c.workdir,'checkout','-q','--detach',g(c.workdir,'rev-parse',head+'^'));
 f.write(path.join(c.workdir,'.ai/memory/INDEX.md'),'prior note\n');git.save(c.workdir,'fixture memory base');
 const base=git.inspect(c.workdir).head;g(c.workdir,'cherry-pick',head);g(c.workdir,'branch','-f',sourceBranch, 'HEAD');g(c.workdir,'checkout','-q',sourceBranch);
 f.write(path.join(c.workdir,'.ai/memory/INDEX.md'),'prior note\nchild note\n');
 const note='.ai/memory/2026-10-21-'+c.id+'.md';f.write(path.join(c.workdir,note),'child-only re-entry secret-free fixture');
 for(const name of ['evidence-context.json','inspect.py','static-inspection.json'])f.write(path.join(c.workdir,'成果物',c.id,name),name==='inspect.py'?'raise Exception("must never execute")\n':'{"fixture":true}\n');
 git.save(c.workdir,'four reports plus two memory paths');
 const file=f.store.taskFile('Fixture',c.id);fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace(/body:\.@[a-f0-9]+/,'body:.@'+git.inspect(c.workdir).head));
 const source=git.inspect(c.workdir),memory=[note,'.ai/memory/INDEX.md'].map(p=>({path:p,bytes:fs.readFileSync(path.join(c.workdir,p))}));
 // Put the synthetic memory ancestor into the target so INDEX is modified in
 // merge-base..source, just like the actual child; preserve the old stop pins.
 g(f.copy,'merge','--no-edit',base);
 return {...f,c,note,source,memory};
}
async function complete(f){
 const q=f.requests.at(-1),k=q.review.key,row={request:q.requestKey,text:`[integration-review:${k}:pass]`,integrationAuto:{key:k,phase:'review',closed:true,isolation:{version:1,resumed:false,request:q.requestKey}}};f.closed.set(k,row);f.auto.settled(q,row);await f.auto.tick();return f.lane();
}
test('six-path source saves only four reports, scopes review and receipts once while keeping source and notes',async t=>{
 const f=await mixed(t),d=f.preview(),i=d.items.find(i=>i.task===f.c.id);assert.equal(i.startable,true,i.reason);assert.equal(i.reportProjection.entries.length,4);assert.equal(i.reportProjection.excluded.length,2);assert.match(i.reportScope,/報告4件/);
 const parentIndex=fs.readFileSync(path.join(f.copy,'.ai/memory/INDEX.md'));f.start();await f.auto.tick();let r=f.lane();assert.equal(r.items[0].state,'検証中',JSON.stringify(r.auto.stopped));
 const q=f.requests.at(-1);assert.deepEqual(git.changedBetween(f.copy,q.review.targetHead,q.review.reviewHead).sort(),i.reportProjection.entries.map(e=>e.path).sort());assert.equal(git.isAncestor(f.copy,f.source.head),false);assert.deepEqual(fs.readFileSync(path.join(f.copy,'.ai/memory/INDEX.md')),parentIndex);assert.equal(fs.existsSync(path.join(f.copy,f.note)),false);
 const e=review.prepare({dir:f.copy,pdir:f.dir,task:f.parent.id,...q.review}),text=fs.readFileSync(e.file,'utf8');assert.match(text,/列挙した報告だけ/);assert.ok(!text.includes('child-only re-entry'));assert.match(r.items[0].review.scope,/元HEADは出典/);
 r=await complete(f);assert.equal(r.complete,true,JSON.stringify(r.auto.stopped));assert.equal(r.auto.main.skipped,true);const receipt=f.transfer.read('Fixture',f.c.id);assert.equal(receipt.retained,true);assert.equal(receipt.sourceHead,f.source.head);assert.deepEqual(receipt.integrated.reportProjection,q.review.reportProjection);
 assert.deepEqual(git.inspect(f.c.workdir),f.source);for(const m of f.memory)assert.deepEqual(fs.readFileSync(path.join(f.c.workdir,m.path)),m.bytes);assert.match(chat.read(f.dir,f.parent.id).at(-1).text,/元履歴全体は受領していません/);
 const a=f.h.ancestor('Fixture',f.parent.id),current=f.h.details(a,a.p,f.store.readTask(f.store.taskFile('Fixture',f.c.id)));assert.equal(current.alreadyReceived,true,JSON.stringify(current.receiptState));
 const count=f.requests.length,cold=new IntegrateAuto({integrate:f.h,dispatch:async()=>{throw Error('no resend');}});cold.pendingRequest=f.auto.pendingRequest;cold.savedCompletion=f.auto.savedCompletion;await cold.tick();await f.auto.tick();assert.equal(f.requests.length,count);assert.throws(f.preview,/受領済み/);f.unchanged();
});
for(const kind of ['product','other-metadata','other-note','third-note','executable','symlink','hardlink','deleted-note','changed-report'])test('mixed source refuses unsafe boundary before saving: '+kind,async t=>{
 const f=await mixed(t),c=f.c,report=path.join(c.workdir,'成果物',c.id,'report.md');
 if(kind==='product')f.write(path.join(c.workdir,'code.js'),'product');
 if(kind==='other-metadata')f.write(path.join(c.workdir,'.ai/config.json'),'{}');
 if(kind==='other-note')f.write(path.join(c.workdir,'.ai/memory/2026-10-21-other.md'),'other');
 if(kind==='third-note')f.write(path.join(c.workdir,'.ai/memory/2026-10-20-'+c.id+'.md'),'extra');
 if(kind==='executable')fs.chmodSync(report,0o755);
 if(kind==='symlink'){fs.unlinkSync(report);fs.symlinkSync('../../base',report);}
 if(kind==='hardlink'){const other=path.join(f.root,'hardlink');fs.linkSync(report,other);}
 if(kind==='deleted-note')fs.unlinkSync(path.join(c.workdir,'.ai/memory/INDEX.md'));
 if(kind==='changed-report'){f.write(path.join(f.copy,'成果物',c.id,'report.md'),'existing target');git.save(f.copy,'conflicting target report');}
 if(!['hardlink','changed-report'].includes(kind)){git.save(c.workdir,'unsafe fixture change');const p=f.store.taskFile('Fixture',c.id);fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace(/body:\.@[a-f0-9]+/,'body:.@'+git.inspect(c.workdir).head));}
 const before=git.inspect(f.copy),d=f.preview(),i=d.items.find(i=>i.task===c.id);assert.equal(i.startable,false);assert.throws(f.start);assert.equal(f.lane(),null);assert.deepEqual(git.inspect(f.copy),before);f.unchanged();
});
test('target CAS after preview and source CAS after intent stop without report write',async t=>{
 const f=await mixed(t),d=f.preview();f.write(path.join(f.copy,'new.txt'),'concurrent');git.save(f.copy,'concurrent target');assert.throws(()=>f.h.apply({project:'Fixture',task:f.parent.id,token:d.token,auto:true,confirm:true,thenMain:false,mode:'single',selected:[{project:'Fixture',task:f.c.id,keep:true}]}));assert.equal(f.lane(),null);
 f.start();f.write(path.join(f.c.workdir,'changed'),'unsaved');await f.auto.tick();assert.ok(f.lane().auto.stopped);assert.ok(!f.lane().items[0].integrated);f.unchanged();
});
test('durable intent prevents automatic retry after worktree success but result-save failure',async t=>{
 const f=await mixed(t);f.start();const save=f.h.save.bind(f.h);let injected=false;f.h.save=r=>{if(r.stoppedSibling&&r.items[0].integrated?.reportProjection&&!injected){injected=true;throw Error('synthetic post-merge save failure');}return save(r);};await f.auto.tick();f.h.save=save;
 const r=f.lane();assert.ok(r.auto.stopped);assert.ok(r.items[0].reportIntent);const before=git.inspect(f.copy);assert.equal(before.head,r.items[0].reportIntent.commit);assert.equal(f.requests.length,1);await f.auto.tick();assert.deepEqual(git.inspect(f.copy),before);assert.equal(f.requests.length,1);f.unchanged();
});
test('changed projection or substituted review proof is rejected',async t=>{
 const f=await mixed(t);f.start();await f.auto.tick();const q=f.requests.at(-1),bad=structuredClone(q.review);bad.reportProjection.entries.pop();assert.throws(()=>review.prepare({dir:f.copy,pdir:f.dir,task:f.parent.id,...bad}),/範囲/);
 const r=f.lane(),k=q.review.key;r.auto.attempts[k].request.review.reportProjection=bad.reportProjection;assert.throws(()=>require('../lib/integration-sibling').review(f.h,r,r.auto.attempts[k]),/確認範囲/);f.unchanged();
});

for(const kind of ['ignored-file','ignored-parent-link'])test('existing ignored target is preserved before report intent: '+kind,async t=>{
 const f=await mixed(t),dest=path.join(f.copy,'成果物',f.c.id),outside=path.join(f.root,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'keep'),'keep');
 const exclude=g(f.copy,'rev-parse','--git-path','info/exclude');fs.appendFileSync(path.resolve(f.copy,exclude),'\n成果物/\n');
 if(kind==='ignored-file')f.write(path.join(dest,'report.md'),'unreceived original');else{fs.mkdirSync(path.dirname(dest),{recursive:true});fs.symlinkSync(outside,dest);}
 const before=git.inspect(f.copy);f.start();await f.auto.tick();const r=f.lane();assert.ok(r.auto.stopped);assert.ok(!r.items[0].reportIntent);assert.deepEqual(git.inspect(f.copy),before);assert.equal(fs.readFileSync(path.join(outside,'keep'),'utf8'),'keep');if(kind==='ignored-file')assert.equal(fs.readFileSync(path.join(dest,'report.md'),'utf8'),'unreceived original');else assert.equal(fs.readlinkSync(dest),outside);f.unchanged();
});
