'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {Store}=require('../lib/store'),{Removal}=require('../lib/remove'),{TaskTransfer}=require('../lib/task-transfer'),{TaskIntegrate}=require('../lib/task-integrate'),{IntegrateAuto}=require('../lib/integrate-auto'),git=require('../lib/git'),sibling=require('../lib/integration-sibling'),chat=require('../lib/chat');
const g=(d,...args)=>execFileSync('git',['-C',d,...args],{encoding:'utf8',stdio:'pipe'}).trim();
const {fixture}=require('./helpers/stopped-sibling-fixture');
test('explicit report lane preserves stopped primary, reviews only new delta, receipts once and keeps child',async t=>{
 const f=await fixture(t),normal=f.auto.preview({project:'Fixture',task:f.parent.id,simple:true});assert.equal(normal.items.length,1);assert.equal(normal.items[0].task,f.oldChild.id);assert.equal(normal.siblingOption.allowed,true);
 const d=f.preview();assert.ok(!d.items.some(i=>i.task===f.oldChild.id));assert.equal(d.items.find(i=>i.task===f.report.id).startable,true);assert.ok(d.items.every(i=>i.keep));f.start();await f.auto.tick();let r=f.lane();assert.equal(r.items[0].state,'検証中',JSON.stringify(r.auto.stopped));assert.equal(f.requests.length,2);assert.equal(f.transfer.read('Fixture',f.report.id).complete,undefined);
 const q=f.requests[1],k=q.review.key;assert.equal(q.review.integrationId,r.id);assert.deepEqual(q.review.stoppedSibling,r.stoppedSibling);assert.match(q.text,/旧取り込みコードの合格/);assert.deepEqual(git.changedBetween(f.copy,q.review.targetHead,q.review.reviewHead),['成果物/'+f.report.id+'/report.md']);sibling.review(f.h,r,r.auto.attempts[k]);
 const row={request:q.requestKey,text:`[integration-review:${k}:pass]`,integrationAuto:{key:k,phase:'review',closed:true,isolation:{version:1,resumed:false,request:q.requestKey}}};f.closed.set(k,row);f.auto.settled(q,row);await f.auto.tick();r=f.lane();assert.equal(r.complete,true,JSON.stringify(r.auto.stopped));assert.equal(r.auto.main.skipped,true);assert.equal(f.transfer.read('Fixture',f.report.id).retained,true);assert.ok(fs.existsSync(f.report.workdir));assert.equal(chat.read(f.dir,f.report.id)[0].text,'元の会話');f.unchanged();
 await f.auto.tick();assert.equal(f.requests.length,2);assert.equal(f.auto.preview({project:'Fixture',task:f.parent.id,simple:true}).siblingOption.allowed,false);assert.throws(f.preview,/受領済み/);f.unchanged();
});
for(const kind of ['pending','missing','open','wrong-request','unknown-main','old-receipt','queue','busy','pin'])test('old uncertain or changed boundary refuses before sibling creation: '+kind,async t=>{
 const f=await fixture(t);if(kind==='pending')f.auto.pendingRequest=()=>true;if(kind==='missing')f.closed.clear();if(kind==='open')f.closed.get(f.oldKey).integrationAuto.closed=false;if(kind==='wrong-request')f.closed.get(f.oldKey).request='other';
 if(kind==='unknown-main'||kind==='old-receipt'){const r=f.h.read('Fixture',f.parent.id);if(kind==='unknown-main')r.auto.main={state:'intent'};else r.items[0].receipt='unknown';f.h.save(r);}
 if(kind==='queue')f.write(path.join(f.dir,'.ai/chat',f.oldChild.id+'.queue.json'),'[{}]');if(kind==='busy')f.removal.busy=(p,t)=>t===f.oldChild.id;
 if(kind==='pin'){const d=f.preview(),r=f.h.read('Fixture',f.parent.id);r.auto.stopped.reason+=' changed';f.h.save(r);assert.throws(()=>f.h.apply({project:'Fixture',task:f.parent.id,token:d.token,auto:true,confirm:true,thenMain:false,mode:'single',selected:[{project:'Fixture',task:f.report.id,keep:true}]}));}else assert.throws(f.preview);
 assert.equal(f.lane(),null);
});
for(const kind of ['product','executable','symlink','dirty','unknown-remaining','external','wrong-source'])test('non report scope is never enabled: '+kind,async t=>{
 const f=await fixture(t),c=f.report;
 if(kind==='product'){f.write(path.join(c.workdir,'code.js'),'not report');git.save(c.workdir,'code');}
 if(kind==='executable'){fs.chmodSync(path.join(c.workdir,'成果物',c.id,'report.md'),0o755);git.save(c.workdir,'mode');}
 if(kind==='symlink'){fs.unlinkSync(path.join(c.workdir,'成果物',c.id,'report.md'));fs.symlinkSync('../../base',path.join(c.workdir,'成果物',c.id,'report.md'));git.save(c.workdir,'link');}
 if(kind==='dirty')f.write(path.join(c.workdir,'dirty'),'unsaved');
 if(kind==='unknown-remaining'){const p=f.store.taskFile('Fixture',c.id);fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace('"status":"あり"','"status":"不明"'));}
 if(kind==='external')f.write(path.join(f.dir,'作業',c.id,'extra.txt'),'external');
 if(kind==='wrong-source'){const p=f.store.taskFile('Fixture',c.id);fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace(/body:\.@[a-f0-9]+/,'body:.@'+'f'.repeat(40)));}
 const d=f.preview();assert.equal(d.items.find(i=>i.task===c.id).startable,false);assert.throws(f.start);assert.equal(f.lane(),null);f.unchanged();
});
for(const kind of ['cleanup','batch','main'])test('explicit single keep-only, no main: '+kind,async t=>{const f=await fixture(t);assert.throws(()=>f.start(kind==='cleanup'?{selected:[{project:'Fixture',task:f.report.id,keep:false}]}:kind==='batch'?{mode:'batch'}:{thenMain:true}));assert.equal(f.lane(),null);f.unchanged();});
test('stale save CAS, old token/run/direct receipt/abandon cannot overwrite original',async t=>{
 const f=await fixture(t),d=f.auto.preview({project:'Fixture',task:f.parent.id,simple:true});f.start();const stale=f.lane(),fresh=f.lane();fresh.error='saved';f.h.save(fresh);assert.throws(()=>f.h.save(stale),/更新/);assert.throws(()=>f.h.run(f.old),/以前の統合/);assert.throws(()=>f.h.simple.resume({project:'Fixture',task:f.parent.id,token:d.token}),/以前の統合/);assert.throws(()=>f.transfer.context('Fixture',f.oldChild.id,{disposition:'continue'}),/受領|統合/);
 assert.throws(()=>require('../lib/integration-abandon-recovery').commit(f.h,{action:'quarantine'},f.old),/以前の統合/);assert.throws(()=>f.h.save(f.old),/以前の統合/);f.unchanged();
});
test('saved source change after intent stops new dispatch without touching primary',async t=>{const f=await fixture(t);f.start();f.write(path.join(f.report.workdir,'changed'),'dirty');await f.auto.tick();assert.ok(f.lane().auto.stopped);assert.equal(f.requests.length,1);f.unchanged();});
test('old completion is ignored, restart observes outstanding new request without resend',async t=>{const f=await fixture(t);f.start();await f.auto.tick();const r=f.lane(),q=f.requests[1],k=q.review.key;f.auto.settled(f.requests[0],{text:`[integration-review:${f.oldKey}:pass]`});await f.auto.tick();assert.equal(f.requests.length,2);assert.equal(f.lane().auto.attempts[k].phase,'review');assert.equal(f.lane().id,r.id);f.unchanged();});
test('unknown write leaves original and partial evidence; no retry',async t=>{const f=await fixture(t),io=require('../lib/platform/file-io'),rename=io.renameSync;io.renameSync=(a,b)=>{if(b===sibling.file(f.h,'Fixture',f.parent.id))throw Error('synthetic rename failure');return rename(a,b);};try{assert.throws(f.start,/synthetic rename/);}finally{io.renameSync=rename;}assert.ok(fs.readdirSync(path.dirname(sibling.file(f.h,'Fixture',f.parent.id))).some(n=>n.endsWith('.lock')));assert.throws(f.preview,/保存が途中/);f.unchanged();});
test('shared primary lock prevents a sibling reservation from crossing an old save',async t=>{
 const f=await fixture(t),io=require('../lib/platform/file-io'),write=io.writeFileSync;let checked=false;
 io.writeFileSync=(file,...a)=>{const out=write(file,...a);if(file===sibling.file(f.h,'Fixture',f.parent.id)+'.lock'&&!checked){checked=true;assert.throws(f.start,/保存が途中/);}return out;};try{f.h.save(f.old);}finally{io.writeFileSync=write;}assert.equal(checked,true);assert.equal(f.lane(),null);f.unchanged();
});
test('old queue appearing after reservation stops the lane without a partial write or old mutation',async t=>{
 const f=await fixture(t);f.start();const queue=path.join(f.dir,'.ai/chat',f.oldChild.id+'.queue.json');f.write(queue,'[{}]');await f.auto.tick();assert.match(f.lane().auto.stopped.reason,/順番待ち/);assert.equal(f.requests.length,1);assert.equal(fs.existsSync(sibling.file(f.h,'Fixture',f.parent.id)+'.lock'),false);f.unchanged();
});
