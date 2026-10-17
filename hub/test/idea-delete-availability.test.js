'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture,U}=require('./idea-fixture.cjs');
const {IdeaDispatch}=require('../lib/idea-dispatch');
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8DA8B+MgBgAHfAD/dPQfSYAAAAASUVORK5CYII=','base64');
async function setup(t,images=false) {
  const f=fixture(t,{bind:false});
  t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));
  const imageIds=images?[1,2].map(n=>f.ideas.uploadImage('P',{opId:U.uuid(),name:'fixture-'+n+'.png'},PNG).image.id):[];
  const add=(text,n,source)=>f.ideas.add('P',{opId:U.uuid(),text,intent:'record',...(images?{images:[imageIds[n]]}:{})},{human:true,source});
  const victim=add('DELETE-SCOPE-CANARY',0),other=add('keep this original',1,{task:'lane'});
  const r=await f.runner.startRun('P',{purpose:'organize',items:[f.ideas.read('P').items[other.id]]});
  f.busyMap.clear();
  f.ideas.internal('P',U.uuid(),{},d=>{d.runs[r.id].delivery='unknown';d.items[victim.id].status='withdrawn';});f.auto(false);
  const op={opId:U.uuid(),id:victim.id,baseContentRev:1,baseControlRev:1,confirm:true};
  return {...f,victim,other,r,op,status:()=>f.ideas.eraseAvailability('P',victim.id)};
}
function blocked(f,pattern) {
  const before=fs.readFileSync(f.ideas.resolve('P').file),s=f.status();assert.equal(s.allowed,false);if(pattern)assert.match(s.message,pattern);
  assert.throws(()=>f.ideas.erase('P',f.op),e=>{assert.equal(e.code,s.code);assert.equal(e.message,s.message);return true;});
  assert.deepEqual(fs.readFileSync(f.ideas.resolve('P').file),before);
}
test('stopped unrelated unknown organization remains unknown while erasure, receipt retry and late completion preserve its own item',async t=>{
  const f=await setup(t),before=f.ideas.read('P'),file=path.join(f.ideas.resolve('P').controlDir,'runs',f.r.id+'.json'),prompt=fs.readFileSync(file);
  f.ideas.backup('P',{opId:U.uuid()});assert.equal(f.status().allowed,true);
  assert.equal(f.ideas.erase('P',f.op).deleted,true);let d=f.ideas.read('P');
  assert.equal(d.items[f.victim.id],undefined);assert.deepEqual(d.items[f.other.id],before.items[f.other.id]);assert.deepEqual(d.runs[f.r.id],before.runs[f.r.id]);assert.deepEqual(fs.readFileSync(file),prompt);
  f.runner.flights.set('P',Promise.resolve());assert.equal(f.ideas.erase('P',f.op).deleted,true);f.runner.flights.clear();
  assert.throws(()=>f.runner.mayStart('P',f.r),{code:'idea-paused'});
  const result={schema:1,kind:'organize',runId:f.r.id,items:[{itemId:f.other.id,contentRev:1,basePlanRev:1,summary:'late own summary',background:{kind:'unknown',refs:[],text:'unknown'},suggestions:[]}]};
  f.finish(f.r,result);await f.runner.tick('P');d=f.ideas.read('P');assert.equal(d.runs[f.r.id].closed,true);assert.equal(d.items[f.other.id].organized.summary,'late own summary');assert.equal(d.items[f.victim.id],undefined);
  assert.throws(()=>f.runner.organized('P',f.r,{...result,items:[{...result.items[0],itemId:f.victim.id}]}),{code:'organize-result'});
  function scan(dir){for(const n of fs.readdirSync(dir)){const file=path.join(dir,n),st=fs.lstatSync(file);if(st.isDirectory())scan(file);else {let b=fs.readFileSync(file);for(let depth=0;depth<6;depth++){assert.equal(b.includes(Buffer.from('DELETE-SCOPE-CANARY')),false,file);try{const j=JSON.parse(b);if(!j.base64)break;b=Buffer.from(j.base64,'base64');}catch{break;}}}}}scan(f.ideas.control);
});
test('an unknown run bound to the item stays blocked with the same GET and execution reason and an existing-task route',async t=>{
  const f=await setup(t);f.ideas.internal('P',U.uuid(),{},d=>{d.runs[f.r.id].targets.push({itemId:f.victim.id,contentRev:1,planRev:1});});blocked(f,/この項目に関わる.*作業「本作業」/);
});
test('only old-generation paused read-only unknown organization can be excluded; ambiguous and current permissions fail closed',async t=>{
  const f=await setup(t),original=f.ideas.read('P');
  const changes=[d=>d.runs[f.r.id].stopGeneration=d.settings.stopGeneration,d=>d.runs[f.r.id].stopGeneration=undefined,d=>d.settings.manualPaused=false,d=>d.settings.auto.enabled=true,d=>d.runs[f.r.id].readOnly=false,d=>d.runs[f.r.id].purpose='build',d=>d.runs[f.r.id].targets=[],d=>d.runs[f.r.id].needsReconcile=true,d=>d.runs[f.r.id].pendingResult={row:{}},d=>d.runs[f.r.id].delivery='accepted'];
  for(const change of changes){f.ideas.internal('P',U.uuid(),{},d=>{d.runs[f.r.id]=U.clone(original.runs[f.r.id]);d.settings=U.clone(original.settings);change(d);});blocked(f);}
});
test('record-delete: ledger save, restore, verification, queued run evidence, spool and unreadable evidence block even without a lane; rev-independent recovery is readable',async t=>{
  const f=await setup(t),rev=f.ideas.read('P').rev;
  for(const [start,stop] of [
    [()=>f.runner.flights.set('P',Promise.resolve()),()=>f.runner.flights.clear()],
    [()=>f.verification.active.set('P',{}),()=>f.verification.active.clear()],
    [()=>f.gate.beginRestore(),()=>f.gate.finishRestore()]
  ]){start();blocked(f);stop();assert.equal(f.status().allowed,true);assert.equal(f.ideas.read('P').rev,rev);}
  const old=f.dispatch.evidence;for(const evidence of [{state:'accepted'},{state:'running'},{state:'finished',row:{}},{state:'unknown',spools:[{id:'pending'}]},{state:'unknown',error:'unreadable'}]){f.dispatch.evidence=()=>evidence;blocked(f);}
  f.dispatch.evidence=old;assert.equal(f.status().allowed,true);
});
test('real evidence adapter preserves unknown user acceptance but rejects queued requests and spool retention across absent queue entries',async t=>{
  const f=await setup(t);f.dispatch.evidence=IdeaDispatch.prototype.evidence;
  const log=require('../lib/chat').files(f.dir,f.r.task).log;fs.mkdirSync(path.dirname(log),{recursive:true});fs.writeFileSync(log,JSON.stringify({role:'user',automation:{runId:f.r.id}})+'\n');
  assert.equal(f.dispatch.evidence('P',f.r).state,'unknown');assert.equal(f.status().allowed,true);
  f.queues.push({automation:{runId:f.r.id}});blocked(f,/安全に切り離せません/);f.queues.length=0;
  f.dispatch.spoolRoot=path.join(f.root,'spool');const dir=path.join(f.dispatch.spoolRoot,U.uuid());fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'request.json'),JSON.stringify({options:{automation:{runId:f.r.id}}}));blocked(f);
  fs.writeFileSync(path.join(dir,'request.json'),'{');blocked(f);
});
test('shared review closure, historical run bindings, dependencies and unfinished verification or releases remain protected',async t=>{
  const f=await setup(t),review=U.uuid();
  f.ideas.internal('P',U.uuid(),{},d=>{d.reviews[review]={id:review,itemContentRevs:[{itemId:f.victim.id},{itemId:f.other.id}]};d.runs[f.r.id].reviewId=review;});blocked(f,/この項目に関わる/);
  f.ideas.internal('P',U.uuid(),{},d=>{d.runs[f.r.id].reviewId=null;d.items[f.other.id].dependencies=[{ideaId:f.victim.id}];});blocked(f,/前提/);
  f.ideas.internal('P',U.uuid(),{},d=>{d.items[f.other.id].dependencies=[];d.evidence.x={type:'verification',finished:false};});blocked(f,/検証/);
  f.ideas.internal('P',U.uuid(),{},d=>{delete d.evidence.x;d.releases.x={state:'unknown'};});blocked(f,/本体への反映/);
});
test('historical target binding prevents an apparent unrelated run from being erased while its result is unknown',async t=>{
  const f=await setup(t);f.ideas.internal('P',U.uuid(),{},d=>{d.runs[f.r.id].targets.push({itemId:f.victim.id,contentRev:1,planRev:1});});f.ideas.backup('P',{opId:U.uuid()});f.ideas.internal('P',U.uuid(),{},d=>{d.runs[f.r.id].targets=d.runs[f.r.id].targets.filter(t=>t.itemId!==f.victim.id);});blocked(f,/この項目に関わる/);
});
test('restart restores the same scoped decision, and execution rechecks evidence after an allowed preview',async t=>{
  const f=await setup(t),{Ideas}=require('../lib/ideas'),{IdeaRunner}=require('../lib/idea-runner');f.runner.close();f.ideas.close();const ideas=new Ideas({store:f.store});f.dispatch.ideas=ideas;
  const runner=new IdeaRunner({...f,ideas,busy:(p,t)=>f.busyMap.has(t)});runner.wake=()=>{};t.after(()=>{runner.close();ideas.close();});f.gate.beginRestore();runner.restore();assert.equal(ideas.eraseAvailability('P',f.victim.id).allowed,false);runner.restored();assert.equal(ideas.eraseAvailability('P',f.victim.id).allowed,true);
  f.queues.push({automation:{runId:f.r.id}});assert.throws(()=>ideas.erase('P',f.op),{code:'erase-busy'});f.queues.length=0;assert.equal(ideas.erase('P',f.op).deleted,true);assert.equal(ideas.read('P').runs[f.r.id].closed,false);
});

test('an unrelated unknown run keeps its shared image bytes, prompt and item permissions when the other image reference is erased',async t=>{
 const f=await setup(t,true),before=f.ideas.read('P'),other=before.items[f.other.id],image=other.images[0],promptFile=path.join(f.ideas.resolve('P').controlDir,'runs',f.r.id+'.json'),prompt=fs.readFileSync(promptFile);
 assert.equal(f.status().allowed,true);assert.equal(f.ideas.erase('P',f.op).deleted,true);assert.deepEqual(f.ideas.image('P',image.id).bytes,PNG);assert.deepEqual(f.ideas.read('P').items[f.other.id],other);assert.deepEqual(fs.readFileSync(promptFile),prompt);assert.equal(f.ideas.read('P').runs[f.r.id].closed,false);
});

test('read-only availability also checks retained output boundaries and the new regression test is registered',async t=>{
 const f=await setup(t);fs.appendFileSync(f.ideas.resolve('P').md,'\nhand edited material');blocked(f,/手で変更されたアイデア帳/);
 assert.ok(new(require('../lib/idea-verification').IdeaVerification)({}).get('project-hub').argv.includes('test/idea-delete-availability.test.js'));
});

test('persisted spool IDs, a lost task or a missing runtime evidence adapter never qualify as independent stopped work',async t=>{
 const f=await setup(t),original=f.ideas.read('P').runs[f.r.id];
 for(const change of [r=>r.spoolIds=[U.uuid()],r=>r.task='lost-task',r=>r.failure={kind:'unknown'}]){f.ideas.internal('P',U.uuid(),{},d=>{d.runs[f.r.id]=U.clone(original);change(d.runs[f.r.id]);});blocked(f);}
 f.ideas.internal('P',U.uuid(),{},d=>{d.runs[f.r.id]=U.clone(original);});delete f.ideas.eraseRunState;blocked(f);
});

test('record-delete: normal AI and code lease in the same task do not own an untouched note or an old unrelated unknown run',async t=>{
 const f=await setup(t);f.dispatch.evidence=IdeaDispatch.prototype.evidence;f.ideas.internal('P',U.uuid(),{},d=>{d.items[f.victim.id].status='note';});
 f.busyMap.set('lane',{options:{text:'unrelated conversation'}});f.gate.register('P',f.dir);const lease=f.gate.acquire({dir:f.dir,owner:'chat:P:lane'});
 const before=f.ideas.read('P');assert.equal(f.status().allowed,true);assert.equal(f.ideas.erase('P',f.op).deleted,true);
 const d=f.ideas.read('P');assert.deepEqual(d.runs,before.runs);assert.deepEqual(d.items[f.other.id],before.items[f.other.id]);assert.ok(f.busyMap.has('lane'));assert.equal(f.gate.leases.get('chat:P:lane').id,lease.id);
});

async function recorded(t){
 const f=fixture(t);t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));
 const victim=f.add('RECORD-DELETE-CANARY','record'),other=f.add('keep original','record');
 const op={opId:U.uuid(),id:victim.id,baseContentRev:1,baseControlRev:1,confirm:true};
 f.dispatch.evidence=IdeaDispatch.prototype.evidence;
 return {...f,victim,other,op,status:()=>f.ideas.eraseAvailability('P',victim.id)};
}
function runRecord(f,{target=f.other.id,purpose='organize',delivery='running'}={}){
 const id=U.uuid();f.ideas.internal('P',U.uuid(),{},d=>{d.runs[id]={id,task:'lane',purpose,delivery,closed:false,readOnly:['organize','plan'].includes(purpose),targets:[{itemId:target,contentRev:1,planRev:1}],stopGeneration:d.settings.stopGeneration,requestId:U.uuid(),spoolIds:[]};});return f.ideas.read('P').runs[id];
}
test('record-delete: untouched note deletes during normal conversation with a same-dir code lease; stale add cannot resurrect it',async t=>{
 const f=await recorded(t);f.busyMap.set('lane',{options:{text:'ordinary human chat'}});const l=f.gate.acquire({dir:f.work,owner:'chat:P:lane'}),before=f.ideas.read('P');
 assert.equal(before.items[f.victim.id].status,'note');assert.equal(f.status().allowed,true);assert.equal(f.ideas.erase('P',f.op).deleted,true);
 assert.deepEqual(f.ideas.read('P').items[f.other.id],before.items[f.other.id]);assert.equal(f.gate.leases.get('chat:P:lane').id,l.id);assert.ok(f.busyMap.has('lane'));
 assert.equal(f.ideas.receipt('P',f.victim.receipt.opId).removed,true);assert.equal(f.ideas.erase('P',f.op).deleted,true);
 const replay=f.ideas.add('P',{opId:f.victim.receipt.opId,text:'RECORD-DELETE-CANARY',intent:'record'},{human:true});assert.equal(replay.removed,true);assert.equal(f.ideas.read('P').items[f.victim.id],undefined);
});
for(const purpose of ['organize','plan','build','fix'])test('record-delete: unrelated live '+purpose+' keeps its targets, permission, prompt and spool',async t=>{
 const f=await recorded(t),r=runRecord(f,{purpose});f.busyMap.set('lane',{options:{automation:{runId:r.id}}});
 const file=path.join(f.ideas.resolve('P').controlDir,'runs',r.id+'.json'),bytes=U.bytes({schema:1,runId:r.id,targets:r.targets,items:[f.ideas.read('P').items[f.other.id]]});fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);
 const spool=path.join(f.root,'spool',U.uuid());fs.mkdirSync(spool,{recursive:true});const request=U.bytes({options:{automation:{runId:r.id}}});fs.writeFileSync(path.join(spool,'request.json'),request);f.dispatch.spoolRoot=path.dirname(spool);
 const before=f.ideas.read('P');assert.equal(f.status().allowed,true);assert.equal(f.ideas.erase('P',f.op).deleted,true);
 const after=f.ideas.read('P');assert.deepEqual(after.runs,before.runs);assert.deepEqual(after.items[f.other.id],before.items[f.other.id]);assert.equal(fs.readFileSync(file,'utf8'),bytes);assert.equal(fs.readFileSync(path.join(spool,'request.json'),'utf8'),request);
});
test('record-delete: an unrelated accepted run can remain queued while its own later result saves without reviving the deleted note',async t=>{
 const f=await recorded(t),r=runRecord(f,{delivery:'accepted'});f.queues.push({automation:{runId:r.id}});
 assert.equal(f.status().allowed,true);f.ideas.erase('P',f.op);assert.equal(f.queues.length,1);
 const result={schema:1,kind:'organize',runId:r.id,items:[{itemId:f.other.id,contentRev:1,basePlanRev:1,summary:'own late output',background:{kind:'unknown',refs:[],text:'unknown'},suggestions:[]}]};
 f.queues.length=0;f.finish(r,result);await f.runner.tick('P');assert.equal(f.ideas.read('P').items[f.other.id].organized.summary,'own late output');assert.equal(f.ideas.read('P').items[f.victim.id],undefined);
});
for(const state of ['running','accepted','unknown'])test('record-delete: target '+state+' stays blocked with matching preview and execution',async t=>{
 const f=await recorded(t),r=runRecord(f,{target:f.victim.id,delivery:state});if(state==='running')f.busyMap.set('lane',{automation:{runId:r.id}});if(state==='accepted')f.queues.push({automation:{runId:r.id}});blocked(f,/この項目に関わる/);
});
test('record-delete: ambiguous unrelated execution, unowned adapter and retained spool do not establish safe scope',async t=>{
 const f=await recorded(t),r=runRecord(f,{delivery:'unknown'});blocked(f,/安全に切り離せません/);
 f.ideas.internal('P',U.uuid(),{},d=>{d.runs[r.id].delivery='running';});blocked(f);
 f.dispatch.spoolRoot=path.join(f.root,'spool');fs.mkdirSync(path.join(f.dispatch.spoolRoot,'unknown'),{recursive:true});fs.writeFileSync(path.join(f.dispatch.spoolRoot,'unknown','request.json'),'{');blocked(f);
 fs.rmSync(f.dispatch.spoolRoot,{recursive:true});f.busyMap.set('lane',{automation:{runId:r.id}});assert.equal(f.status().allowed,true);delete f.ideas.eraseRunState;blocked(f);
});
test('record-delete: shared review and historical targets protect an apparently separate running request',async t=>{
 const f=await recorded(t),r=runRecord(f),review=U.uuid();f.busyMap.set('lane',{automation:{runId:r.id}});
 f.ideas.internal('P',U.uuid(),{},d=>{d.reviews[review]={id:review,itemContentRevs:[{itemId:f.victim.id},{itemId:f.other.id}]};d.runs[r.id].reviewId=review;});blocked(f,/この項目に関わる/);
 f.ideas.internal('P',U.uuid(),{},d=>{delete d.runs[r.id].reviewId;delete d.reviews[review];d.runs[r.id].targets.push({itemId:f.victim.id});});f.ideas.backup('P',{opId:U.uuid()});
 f.ideas.internal('P',U.uuid(),{},d=>{d.runs[r.id].targets=d.runs[r.id].targets.filter(x=>x.itemId!==f.victim.id);});blocked(f,/この項目に関わる/);
});
test('record-delete: preview is rechecked after target launch and ledger edits; writer ownership is independent',async t=>{
 const f=await recorded(t);f.busyMap.set('lane',{options:{text:'ordinary chat'}});assert.equal(f.status().allowed,true);
 const r=runRecord(f,{target:f.victim.id});f.busyMap.set('lane',{automation:{runId:r.id}});blocked(f);
 f.ideas.internal('P',U.uuid(),{},d=>{d.runs[r.id].closed=true;d.runs[r.id].delivery='closed';});f.busyMap.clear();
 const c=f.add('concurrent addition','record');f.ideas.update('P',{opId:U.uuid(),id:f.other.id,baseContentRev:1,baseControlRev:1,change:{text:'concurrent other edit'}});assert.equal(f.ideas.erase('P',f.op).deleted,true);
 assert.ok(f.ideas.read('P').items[c.id]);assert.equal(f.ideas.read('P').items[f.other.id].text,'concurrent other edit');
 const {Ideas}=require('../lib/ideas'),contender=new Ideas({store:f.store});t.after(()=>contender.close());const i=f.ideas.read('P').items[c.id];assert.throws(()=>contender.erase('P',{opId:U.uuid(),id:c.id,baseContentRev:i.contentRev,baseControlRev:i.controlRev,confirm:true}),{code:'writer'});
});
test('record-delete: erasure interrupted during a normal chat recovers after restart; old receipt and later unrelated save preserve both changes',async t=>{
 const f=await recorded(t);f.busyMap.set('lane',{options:{text:'ordinary chat'}});let fired=false;f.ideas.fault=stage=>{if(stage==='erase-file'&&!fired){fired=true;throw Error('injected interruption');}};
 assert.throws(()=>f.ideas.erase('P',f.op),e=>e.saved==='unknown');assert.equal(fired,true);f.runner.close();f.ideas.close();
 const {Ideas}=require('../lib/ideas'),{IdeaRunner}=require('../lib/idea-runner'),ideas=new Ideas({store:f.store});f.dispatch.ideas=ideas;const runner=new IdeaRunner({...f,ideas,busy:()=>true});runner.wake=()=>{};t.after(()=>{runner.close();ideas.close();});
 runner.restore();runner.restored();assert.equal(ideas.receipt('P',f.op.opId).deleted,true);assert.equal(ideas.erase('P',f.op).deleted,true);
 ideas.update('P',{opId:U.uuid(),id:f.other.id,baseContentRev:1,baseControlRev:1,change:{text:'after restart'}});assert.equal(ideas.read('P').items[f.other.id].text,'after restart');assert.equal(ideas.read('P').items[f.victim.id],undefined);
});

test('record-delete: shared image bytes used by a different live run survive and target revision conflicts are rechecked',async t=>{
 const f=await setup(t,true);f.dispatch.evidence=IdeaDispatch.prototype.evidence;f.ideas.internal('P',U.uuid(),{},d=>{d.runs[f.r.id].delivery='running';});f.busyMap.set('lane',{automation:{runId:f.r.id}});
 const before=f.ideas.read('P'),image=before.items[f.other.id].images[0];assert.equal(f.status().allowed,true);
 f.ideas.update('P',{opId:U.uuid(),id:f.victim.id,baseContentRev:1,baseControlRev:1,change:{text:'edited target'}});assert.throws(()=>f.ideas.erase('P',f.op),{code:'item-revision'});
 const current=f.ideas.read('P').items[f.victim.id];f.ideas.erase('P',{...f.op,baseContentRev:current.contentRev,baseControlRev:current.controlRev});
 assert.deepEqual(f.ideas.image('P',image.id).bytes,PNG);assert.deepEqual(f.ideas.read('P').items[f.other.id],before.items[f.other.id]);assert.deepEqual(f.ideas.read('P').runs,before.runs);
});

async function stoppedTarget(t,preservedMarkdown) {
 const f=fixture(t,{bind:false});t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));
 if(preservedMarkdown)fs.writeFileSync(path.join(f.dir,'アイデア帳.md'),preservedMarkdown);
 const victim=f.add('STOPPED-TARGET-CANARY','record',{capture:'verified',task:'lane'}),other=f.add('keep independent note','record',preservedMarkdown?{capture:'verified',task:'lane'}:undefined);
 const r=await f.runner.startRun('P',{purpose:'organize',items:[f.ideas.read('P').items[victim.id]]});f.busyMap.clear();
 f.ideas.internal('P',U.uuid(),{},d=>{d.runs[r.id].delivery='unknown';d.runs[r.id].queueId='old-queue';d.items[victim.id].status='withdrawn';});f.auto(false);
 f.dispatch.evidence=IdeaDispatch.prototype.evidence;
 const op={opId:U.uuid(),id:victim.id,baseContentRev:1,baseControlRev:1,confirm:true};
 return {...f,victim,other,r:f.ideas.read('P').runs[r.id],op,status:()=>f.ideas.eraseAvailability('P',victim.id)};
}
test('withdrawn stopped organization retires as cancelled, never successful; receipt retry, restart and late result cannot revive it',async t=>{
 const f=await stoppedTarget(t),before=f.ideas.read('P'),meta=f.dispatch.metadata(before,f.r);
 const log=require('../lib/chat').files(f.dir,f.r.task).log;fs.mkdirSync(path.dirname(log),{recursive:true});const source=JSON.stringify({role:'user',request:f.r.requestId,text:'original conversation',automation:meta})+'\n';fs.writeFileSync(log,source);
 assert.equal(f.status().allowed,true);assert.deepEqual(f.ideas.read('P'),before); // preview has no cancellation side effect
 f.ideas.backup('P',{opId:U.uuid()});let once=false;f.ideas.fault=stage=>{if(stage==='erase-file'&&!once){once=true;throw Error('cancel erasure interruption');}};
 assert.throws(()=>f.ideas.erase('P',f.op),e=>e.saved==='unknown');f.runner.close();f.ideas.close();
 const {Ideas}=require('../lib/ideas'),ideas=new Ideas({store:f.store});t.after(()=>ideas.close());f.runner.ideas=ideas;f.dispatch.ideas=ideas;
 assert.equal(ideas.receipt('P',f.op.opId).deleted,true);assert.equal(ideas.erase('P',f.op).deleted,true);
 const d=ideas.read('P');assert.equal(d.runs[f.r.id],undefined);assert.deepEqual(d.items[f.other.id],before.items[f.other.id]);
 assert.deepEqual(d.erased[f.victim.id].cancelledRuns[f.r.id],{delivery:'cancelled',reason:'withdrawn-stopped-organization',stopGeneration:f.r.stopGeneration,cancelGeneration:before.settings.stopGeneration});
 assert.equal(d.erased[f.victim.id].cancelledRuns[f.r.id].result,undefined);assert.equal(d.erased[f.victim.id].cancelledRuns[f.r.id].closed,undefined);
 const saved=fs.readFileSync(ideas.resolve('P').file);f.runner.settled({project:'P',automation:meta},{role:'assistant',text:'late output',automation:{metadata:meta,closed:true}});assert.deepEqual(fs.readFileSync(ideas.resolve('P').file),saved);
 assert.throws(()=>f.dispatch.verify({project:'P',automation:meta,contextMode:'idea',freshContext:true,preserveTaskState:true}),{code:'idea-run'});
 assert.throws(()=>f.runner.mayStart('P',f.r),{code:'idea-paused'});assert.equal(fs.readFileSync(log,'utf8'),source);assert.equal(ideas.add('P',{opId:f.victim.receipt.opId,text:'STOPPED-TARGET-CANARY',intent:'record'},{human:true}).removed,true);
});
test('stopped target retirement requires the generation fence, withdrawal, read-only scope and no ambiguous retained result',async t=>{
 const f=await stoppedTarget(t),original=f.ideas.read('P');
 for(const change of [d=>d.settings.manualPaused=false,d=>d.settings.auto.enabled=true,d=>d.runs[f.r.id].stopGeneration=d.settings.stopGeneration,d=>delete d.runs[f.r.id].stopGeneration,d=>d.runs[f.r.id].readOnly=false,d=>d.runs[f.r.id].purpose='build',d=>d.items[f.victim.id].status='note',d=>d.items[f.victim.id].grant={},d=>d.runs[f.r.id].targets.push({itemId:f.other.id}),d=>d.runs[f.r.id].pendingResult={},d=>d.runs[f.r.id].spoolIds=['retained'],d=>d.runs[f.r.id].segments=[{request:'limit-segment'}],d=>d.runs[f.r.id].needsReconcile=true,d=>d.runs[f.r.id].reviewId=U.uuid(),d=>d.runs[f.r.id].task='lost-task']) {
   f.ideas.internal('P',U.uuid(),{},d=>{d.runs[f.r.id]=U.clone(original.runs[f.r.id]);d.settings=U.clone(original.settings);d.items[f.victim.id]=U.clone(original.items[f.victim.id]);change(d);});blocked(f,/この項目に関わる/);
 }
});
test('retirement rechecks queue, busy, spool and late result by request/queue identity even without automation metadata',async t=>{
 const f=await stoppedTarget(t);assert.equal(f.status().allowed,true);
 f.queues.push({id:f.r.queueId});blocked(f);f.queues.length=0;
 f.busyMap.set('lane',{options:{request:f.r.requestId}});blocked(f);f.busyMap.clear();
 const log=require('../lib/chat').files(f.dir,f.r.task).log;fs.mkdirSync(path.dirname(log),{recursive:true});
 fs.writeFileSync(log,JSON.stringify({role:'assistant',request:f.r.requestId,text:'unmarked result'})+'\n');blocked(f);fs.unlinkSync(log);
 f.dispatch.spoolRoot=path.join(f.root,'spool');const dir=path.join(f.dispatch.spoolRoot,U.uuid());fs.mkdirSync(dir,{recursive:true});const request=path.join(dir,'request.json');fs.writeFileSync(request,JSON.stringify({options:{request:f.r.requestId}}));blocked(f);
 fs.writeFileSync(request,'{');blocked(f);fs.rmSync(f.dispatch.spoolRoot,{recursive:true});
 assert.equal(f.status().allowed,true);delete f.ideas.eraseRunState;blocked(f);
});
test('official delete API removes only the two approved fixture items with both blockers, same-op receipts and reload verification',async t=>{
 const old=Buffer.from('# 保全した旧帳\n\n- independent handwritten material\n'),f=await stoppedTarget(t,old),keep=f.add('untouched third item','record');
 f.ideas.internal('P',U.uuid(),{},d=>{d.items[f.other.id].status='withdrawn';});const retained=f.ideas.read('P').items[keep.id];
 const {IdeaAPI}=require('../lib/idea-api'),api=new IdeaAPI({ideas:f.ideas});
 const call=async(method,route,body)=>{let result;await api.handle({method,headers:{'x-hub':'1','x-hub-ui':'ideas',host:'localhost:4545',origin:'http://localhost:4545'}},{},new URL('http://localhost:4545'+route),body,(_,status,body)=>{result={status,body};});return result;};
 const operations=[];
 for(const id of [f.victim.id,f.other.id]) {
   const preview=await call('GET','/api/ideas?project=P&deleteId='+id);assert.equal(preview.body.deleteAvailability.allowed,true);
   const item=f.ideas.read('P').items[id],op={project:'P',opId:U.uuid(),id,baseContentRev:item.contentRev,baseControlRev:item.controlRev,confirm:true};operations.push(op);
   const out=await call('POST','/api/ideas/delete',op);assert.equal(out.status,200);assert.equal(out.body.deleted,true);
   assert.equal((await call('POST','/api/ideas/delete',op)).body.deleted,true);assert.equal((await call('GET','/api/ideas/item?project=P&id='+id)).status,404);
   assert.deepEqual(fs.readFileSync(path.join(f.dir,'アイデア帳.md')),old);assert.deepEqual(f.ideas.read('P').items[keep.id],retained);
 }
 f.runner.close();f.ideas.close();const {Ideas}=require('../lib/ideas'),reopened=new Ideas({store:f.store});t.after(()=>reopened.close());api.ideas=reopened;
 for(const op of operations){assert.equal((await call('GET','/api/ideas/receipt?project=P&opId='+op.opId)).body.deleted,true);assert.equal((await call('GET','/api/ideas/item?project=P&id='+op.id)).status,404);}
 assert.equal(reopened.view('P').total,1);assert.deepEqual(fs.readFileSync(path.join(f.dir,'アイデア帳.md')),old);
});
