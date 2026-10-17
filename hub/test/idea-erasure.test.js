'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Ideas}=require('../lib/ideas'),U=require('../lib/idea-utils');
function fixture(t) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'idea-erasure-'))),dir=path.join(root,'P');fs.mkdirSync(dir);
  const store={root,readProject:id=>({dir:path.join(root,id)})};let ideas=new Ideas({store});
  t.after(()=>{ideas.close();fs.rmSync(root,{recursive:true,force:true});});
  return {root,dir,store,get ideas(){return ideas;},restart(){ideas.close();ideas=new Ideas({store});return ideas;},add(text,extra={}){const b={opId:U.uuid(),text,intent:'record',...extra};return {...ideas.add('P',b,{human:true}),body:b};}};
}
function request(f,id) {const i=f.ideas.read('P').items[id];return {opId:U.uuid(),id,baseContentRev:i.contentRev,baseControlRev:i.controlRev,confirm:true};}
function files(dir) {if(!fs.existsSync(dir))return [];return fs.readdirSync(dir).flatMap(n=>{const f=path.join(dir,n);return fs.statSync(f).isDirectory()?files(f):[f];});}
function decoded(bytes,visit,depth=0) {visit(bytes);if(depth>8)return;try{const d=JSON.parse(bytes);if(d?.base64)decoded(Buffer.from(d.base64,'base64'),visit,depth+1);}catch{}}
function absent(root,canary) {for(const file of files(root))decoded(fs.readFileSync(file),bytes=>assert.equal(bytes.includes(Buffer.from(canary)),false,file));}
test('append order survives states, legacy UUID sorting, categories, page boundaries and conflicts without grants changing',t=>{
 const f=fixture(t),a=f.add('first',{intent:'build'}),b=f.add('second'),c=f.add('third');const before=f.ideas.read('P').items[a.id];
 f.ideas.internal('P',U.uuid(),{},d=>{d.items[a.id].status='implemented';d.items[b.id].status='waiting';});assert.deepEqual(f.ideas.view('P').items.map(i=>i.id),[a.id,b.id,c.id]);
 const rev=f.ideas.read('P').orderRev,move={opId:U.uuid(),id:c.id,direction:'up',baseOrderRev:rev};f.ideas.reorder('P',move);f.ideas.reorder('P',move);assert.throws(()=>f.ideas.reorder('P',{...move,opId:U.uuid()}),{code:'order-revision'});
 assert.deepEqual(f.restart().view('P').items.map(i=>i.id),[a.id,c.id,b.id]);
 let i=f.ideas.read('P').items[a.id];f.ideas.update('P',{opId:U.uuid(),id:a.id,baseContentRev:i.contentRev,baseControlRev:i.controlRev,change:{category:'bug'}});i=f.ideas.read('P').items[a.id];for(const k of ['contentRev','planRev','grant','priority','implementation'])assert.deepEqual(i[k],before[k]);
 const s=f.ideas.resolve('P'),d=f.ideas.read('P');delete d.itemOrder;delete d.orderRev;for(const i of Object.values(d.items))i.createdAt='2026-01-01';fs.writeFileSync(s.file,U.bytes(d));assert.deepEqual(f.ideas.read('P').itemOrder,Object.keys(d.items).sort());
 f.ideas.internal('P',U.uuid(),{},d=>{for(let n=0;n<101;n++)f.ideas.newItem(d,'row'+n,'record',null,U.uuid());});const last=f.ideas.read('P').itemOrder.at(-1);let r=f.ideas.read('P').orderRev;const result=f.ideas.reorder('P',{opId:U.uuid(),id:last,direction:'up',baseOrderRev:r});assert.equal(result.index,102);assert.equal(f.ideas.view('P',100).items[2].id,last);
});
test('hard deletion scrubs histories, immutable transactions and nested base64 backup while preserving other items',t=>{
 const f=fixture(t),a=f.add('CANARY-body-old'),b=f.add('keep me');
 f.ideas.update('P',{opId:U.uuid(),id:a.id,baseContentRev:1,baseControlRev:1,change:{text:'CANARY-body-new'}});
 const keep=f.ideas.read('P').items[b.id];f.ideas.backup('P',{opId:U.uuid()});const op=request(f,a.id);const out=f.ideas.erase('P',op);assert.equal(out.deleted,true);assert.deepEqual(f.ideas.read('P').items[b.id],keep);assert.equal(f.ideas.receipt('P',a.body.opId).removed,true);assert.equal(f.ideas.add('P',a.body,{human:true}).removed,true);
 absent(f.root,'CANARY-body');assert.equal(f.restart().erase('P',op).deleted,true);absent(f.root,'CANARY-body');
});
for(const boundary of ['erase-staging','erase-intent','erase-file','erase-projection','erase-final'])test('fault and restart at '+boundary,t=>{
 const f=fixture(t),a=f.add('CANARY-'+boundary);f.add('other');f.ideas.backup('P',{opId:U.uuid()});const op=request(f,a.id);let fired=false;f.ideas.fault=stage=>{if(stage===boundary&&!fired){fired=true;throw Error('injected');}};
 assert.throws(()=>f.ideas.erase('P',op));assert.equal(fired,true);
 const i=f.restart();if(boundary==='erase-staging'){assert.ok(i.read('P').items[a.id]);i.erase('P',op);}else assert.equal(i.receipt('P',op.opId).deleted,true);
 absent(f.root,'CANARY-'+boundary);assert.equal(i.view('P').total,1);
});
test('preflight rejects running, unresolved, dependencies, links, unknown files and hand-edited markdown before erasing',t=>{
 const f=fixture(t),a=f.add('preserve'),b=f.add('dependent'),s=f.ideas.resolve('P');let op=request(f,a.id);
 f.ideas.internal('P',U.uuid(),{},d=>{d.items[b.id].dependencies=[{ideaId:a.id}];});assert.throws(()=>f.ideas.erase('P',op),{code:'erase-dependency'});
 f.ideas.internal('P',U.uuid(),{},d=>{d.items[b.id].dependencies=[];d.runs.x={closed:false,delivery:'unknown',targets:[]};});assert.throws(()=>f.ideas.erase('P',op),{code:'erase-busy'});
 f.ideas.internal('P',U.uuid(),{},d=>{delete d.runs.x;});const unknown=path.join(s.controlDir,'unowned.txt');fs.writeFileSync(unknown,'not owned');assert.throws(()=>f.ideas.erase('P',op),{code:'erase-format'});fs.unlinkSync(unknown);
 fs.symlinkSync(s.file,path.join(s.controlDir,'link'));assert.throws(()=>f.ideas.erase('P',op));fs.unlinkSync(path.join(s.controlDir,'link'));
 fs.appendFileSync(s.md,'hand edited');assert.throws(()=>f.ideas.erase('P',op),{code:'erase-markdown'});assert.ok(f.ideas.read('P').items[a.id]);assert.equal(fs.existsSync(path.join(s.controlDir,'erase-intent.json')),false);
});
test('legacy import and relocation originals are scrubbed; old approvals cannot restore deleted contents',t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.dir,'アイデア帳.md'),'# アイデア\n- CANARY-import\n- keep import\n');f.ideas.initialize('P',U.uuid(),{importLegacy:true});const a=f.ideas.view('P').items.find(i=>i.text==='CANARY-import'),saved=f.ideas.backup('P',{opId:U.uuid()});
 f.ideas.relocate('P',{opId:U.uuid(),confirm:true,...saved});const op=request(f,a.id);assert.equal(f.ideas.erase('P',op).deleted,true);absent(f.root,'CANARY-import');
 assert.throws(()=>f.ideas.relocate('P',{opId:U.uuid(),confirm:true,...saved}),{code:'registry-backup'});assert.equal(f.restart().view('P').total,1);
});
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8DA8B+MgBgAHfAD/dPQfSYAAAAASUVORK5CYII=','base64');
test('image-only: all original/preview/staging/receipt/backup copies gone; stale upload cannot recreate them',t=>{
 const f=fixture(t),upload={opId:U.uuid(),name:'CANARY-name.png'},im=f.ideas.uploadImage('P',upload,PNG).image,a=f.add('',{images:[im.id]}),s=f.ideas.resolve('P');
 const preview=f.ideas.image('P',im.id,true).bytes,stage=path.join(s.controlDir,'image-staging',im.id,U.uuid()+'.png');fs.writeFileSync(stage,preview);f.add('keep');f.ideas.backup('P',{opId:U.uuid()});
 assert.equal(f.ideas.erase('P',request(f,a.id)).deleted,true);assert.equal(f.ideas.uploadImage('P',upload,PNG).removed,true);assert.throws(()=>f.ideas.image('P',im.id),{code:'image-owner'});
 absent(f.root,'CANARY-name');for(const file of files(f.root))decoded(fs.readFileSync(file),b=>{assert.equal(b.includes(PNG),false,file);assert.equal(b.includes(preview),false,file);});
});
test('shared image stays available until last actual item reference; other projects remain unchanged',t=>{
 const f=fixture(t),u1=f.ideas.uploadImage('P',{opId:U.uuid(),name:'CANARY-unique-name.png'},PNG),u2=f.ideas.uploadImage('P',{opId:U.uuid(),name:'independent.png'},PNG),a=f.add('victim',{images:[u1.image.id]}),b=f.add('keep',{images:[u2.image.id]});
 fs.mkdirSync(path.join(f.root,'Q'));f.ideas.add('Q',{opId:U.uuid(),text:'other project'});const q=fs.readFileSync(f.ideas.resolve('Q').file);
 f.ideas.erase('P',request(f,a.id));assert.deepEqual(f.ideas.image('P',u2.image.id).bytes,PNG);absent(f.root,'CANARY-unique-name');assert.deepEqual(fs.readFileSync(f.ideas.resolve('Q').file),q);
 f.ideas.erase('P',request(f,b.id));for(const file of files(path.join(f.root,'_hub')))decoded(fs.readFileSync(file),bytes=>assert.equal(bytes.includes(PNG),false,file));
});
test('every cleanup boundary resumes forward; shared fixed material is invalidated and late results cannot restore an item',t=>{
 const f=fixture(t),a=f.add('CANARY-artifact',{intent:'build'}),b=f.add('keep',{intent:'build'}),s=f.ideas.resolve('P'),run=U.uuid(),review=U.uuid(),evidence=U.uuid();
 for(const [relative,bytes] of Object.entries({['runs/'+run+'.json']:U.bytes({schema:1,runId:run,targets:[{itemId:a.id}],items:[{id:a.id,text:'CANARY-artifact'}]}),['reviews/'+review+'/bundle.json']:U.bytes({schema:1,id:review,items:[{id:a.id,text:'CANARY-artifact'},{id:b.id,text:'keep'}]}),['reviews/'+review+'/diff.patch']:'CANARY-artifact',['reviews/'+review+'/history.txt']:'CANARY-artifact',['verification/'+evidence+'/stdout']:'CANARY-artifact',['verification/'+evidence+'/stderr']:''})) {const file=path.join(s.controlDir,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);}
 f.ideas.internal('P',U.uuid(),{},d=>{d.runs[run]={id:run,closed:true,targets:[{itemId:a.id}],result:{text:'CANARY-artifact'}};d.reviews[review]={id:review,itemContentRevs:[{itemId:a.id},{itemId:b.id}],findings:['CANARY-artifact']};d.evidence[evidence]={id:evidence,type:'verification',finished:true};d.items[a.id].status='implemented';d.items[a.id].implementation={verificationId:evidence};d.items[b.id].evidence=[{id:review,type:'review'}];d.releases.x={id:'x',state:'ready',rev:1,items:[{itemId:a.id}],manifest:{text:'CANARY-artifact'}};});
 f.ideas.backup('P',{opId:U.uuid()});const op=request(f,a.id);let writes=0,i=f.ideas;
 for(let n=0;n<200;n++) {
   i.fault=stage=>{if(stage==='erase-file'||stage==='erase-projection'){writes++;throw Error('boundary');}};
   const r=n===0?(()=>{try{return i.erase('P',op);}catch(e){assert.equal(e.saved,'unknown');return {saved:'unknown'};}})():i.receipt('P',op.opId);
   if(r.saved===true)break;
   assert.equal(r.saved,'unknown');i=f.restart();
   if(n===199)assert.fail('recovery did not finish');
 }
 assert.ok(writes>10);assert.equal(i.receipt('P',op.opId).deleted,true);absent(f.root,'CANARY-artifact');assert.deepEqual(i.read('P').items[b.id].evidence,[]);assert.equal(i.read('P').releases.x.state,'stale');
});
for(const point of ['ledger','control','index'])test('unfinished backup '+point+' cannot retain or restore erased content',t=>{
 const f=fixture(t),a=f.add('CANARY-partial-'+point),s=f.ideas.resolve('P'),run=U.uuid(),file=path.join(s.controlDir,'runs',run+'.json');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,U.bytes({schema:1,runId:run,targets:[{itemId:a.id}],items:[{id:a.id,text:'CANARY-partial-'+point}]}));
 let fired=false;f.ideas.fault=(stage,detail)=>{if(stage==='staging'&&detail.file.includes('/backups/')&&(point==='ledger'&&path.basename(detail.file)==='ledger'||point==='control'&&detail.file.includes('/control/runs/')||point==='index'&&path.basename(detail.file)==='backup.json')){fired=true;throw Error('backup interruption');}};
 assert.throws(()=>f.ideas.backup('P',{opId:U.uuid()}));assert.equal(fired,true);f.ideas.fault=()=>{};
 assert.equal(f.ideas.erase('P',request(f,a.id)).deleted,true);absent(f.root,'CANARY-partial-'+point);assert.equal(f.restart().view('P').total,0);
});
test('captured long source, snapshots, old withdrawn item and blob disappear without changing the source conversation',t=>{
 const f=fixture(t),source={capture:'verified',task:'main',snapshots:[{role:'user',text:'CANARY-context'}]},text='CANARY-long-source'.repeat(5000),a=f.ideas.add('P',{opId:U.uuid(),text},{human:true,source}),s=f.ideas.resolve('P');
 f.ideas.internal('P',U.uuid(),{},d=>{d.items[a.id].source={...d.items[a.id].source,...source};d.items[a.id].status='withdrawn';d.items[a.id].grant=null;});
 const conversation=path.join(f.root,'conversation.jsonl');fs.writeFileSync(conversation,'original source conversation');assert.ok(files(s.controlDir).some(f=>f.includes('/blobs/')));
 f.ideas.backup('P',{opId:U.uuid()});f.ideas.erase('P',request(f,a.id));absent(f.root,'CANARY-');assert.equal(fs.readFileSync(conversation,'utf8'),'original source conversation');
});
test('late runner completion is ignored only for erased runs; record-delete ledger flights and verification block while code leases remain independent',async t=>{
 const f=require('./idea-fixture.cjs').fixture(t),a=f.add('CANARY-late','record');await f.runner.tick('P');const r=f.current(),meta=f.dispatch.metadata(f.ideas.read('P'),r),row=f.finish(r,{schema:1,runId:r.id,kind:'organize',items:r.targets.map(t=>({itemId:t.itemId,contentRev:t.contentRev,basePlanRev:t.planRev,summary:'CANARY-late',background:{kind:'unknown',refs:[],text:'unknown'},suggestions:[]}))});await f.runner.tick('P');
 const op={opId:U.uuid(),id:a.id,baseContentRev:1,baseControlRev:1,confirm:true};
 f.runner.flights.set('P',Promise.resolve());assert.throws(()=>f.ideas.erase('P',op),{code:'erase-busy'});f.runner.flights.delete('P');
 f.verification.active.set('P',Promise.resolve());assert.throws(()=>f.ideas.erase('P',op),{code:'erase-busy'});f.verification.active.delete('P');
 const lease=f.gate.acquire({dir:f.work,owner:'deletion-fixture'});assert.equal(f.ideas.eraseAvailability('P',a.id).allowed,true);
 assert.equal(f.ideas.erase('P',op).deleted,true);assert.equal(f.gate.leases.get('deletion-fixture').id,lease.id);f.gate.release('deletion-fixture',lease.id);const before=fs.readFileSync(f.ideas.resolve('P').file);f.runner.settled({project:'P',automation:meta},row);assert.deepEqual(fs.readFileSync(f.ideas.resolve('P').file),before);assert.throws(()=>f.runner.settled({project:'P',automation:{...meta,runId:U.uuid()}},row),{code:'idea-result'});assert.throws(()=>f.runner.mayStart('P',r),{code:'idea-paused'});absent(f.root,'CANARY-late');
});
test('unbound legacy and failed verification logs are shared; a separately bound check remains intact',t=>{
 const f=fixture(t),a=f.add('CANARY-failed-check'),b=f.add('keep'),s=f.ideas.resolve('P'),shared=U.uuid(),independent=U.uuid();
 for(const [id,text] of [[shared,'CANARY-failed-check'],[independent,'independent output']]){const dir=path.join(s.controlDir,'verification',id);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'stdout'),text);fs.writeFileSync(path.join(dir,'stderr'),'');}
 f.ideas.internal('P',U.uuid(),{},d=>{d.evidence[shared]={id:shared,type:'verification',finished:true,success:false};d.evidence[independent]={id:independent,type:'verification',finished:true,success:true,itemIds:[b.id]};d.items[b.id].implementation={verificationId:shared};d.items[b.id].evidence=[{type:'verification',id:shared}];});
 f.ideas.erase('P',request(f,a.id));absent(f.root,'CANARY-failed-check');const d=f.ideas.read('P');assert.equal(d.items[b.id].implementation.verificationInvalidated,true);assert.equal(d.evidence[independent].success,true);assert.equal(fs.readFileSync(path.join(s.controlDir,'verification',independent,'stdout'),'utf8'),'independent output');
});

function preserved(t,text='# 古い手書き帳\n\n- unrelated original\n') {
 const f=fixture(t);fs.writeFileSync(path.join(f.dir,'アイデア帳.md'),text);
 const add=text=>f.ideas.add('P',{opId:U.uuid(),text,intent:'record'},{human:true,source:{capture:'verified',task:'main'}});
 const a=add('PRESERVED-DELETE-ONE\nbody'),b=add('PRESERVED-DELETE-TWO'),keep=add('kept new item');
 return {...f,a,b,keep,text,add};
}
test('initial preserved unrelated markdown survives two erasures, backups, relocation, restart and all later projections byte-for-byte',t=>{
 const f=preserved(t),s=f.ideas.resolve('P'),old=Buffer.from(f.text),keep=f.ideas.read('P').items[f.keep.id];
 assert.equal(f.ideas.read('P').projection.existingHash,U.hash(old));assert.equal(f.ideas.eraseAvailability('P',f.a.id).allowed,true);
 const backup=f.ideas.backup('P',{opId:U.uuid()});f.ideas.relocate('P',{opId:U.uuid(),confirm:true,...backup});
 f.ideas.erase('P',request(f,f.a.id));assert.deepEqual(fs.readFileSync(s.md),old);
 let ideas=f.restart();assert.equal(ideas.eraseAvailability('P',f.b.id).allowed,true);ideas.erase('P',request(f,f.b.id));
 assert.deepEqual(ideas.read('P').items[f.keep.id],keep);assert.equal(ideas.read('P').projection.hash,undefined);
 // Relocation and erasure carry preservation provenance, never generated ownership.
 assert.equal(ideas.read('P').projection.preservedOrigin.hash,U.hash(old));
 for(const file of files(f.root))if(path.basename(file)==='アイデア帳.md')assert.deepEqual(fs.readFileSync(file),old);
 ideas.add('P',{opId:U.uuid(),text:'later note',intent:'record'},{human:true});
 assert.deepEqual(fs.readFileSync(s.md),old);for(const file of files(f.root))if(path.basename(file)==='preserved-markdown.json')assert.deepEqual(Buffer.from(JSON.parse(fs.readFileSync(file)).base64,'base64'),old);
 absent(f.root,'PRESERVED-DELETE-');
});
test('preserved original is retained through an interrupted erasure and subsequent ordinary mutation at the same binding',t=>{
 const f=preserved(t),s=f.ideas.resolve('P'),op=request(f,f.a.id);let once=false;
 f.ideas.fault=stage=>{if(stage==='erase-file'&&!once){once=true;throw Error('interrupt');}};
 assert.throws(()=>f.ideas.erase('P',op),e=>e.saved==='unknown');const ideas=f.restart();assert.equal(ideas.receipt('P',op.opId).deleted,true);
 const i=ideas.read('P').items[f.keep.id];ideas.update('P',{opId:U.uuid(),id:i.id,baseContentRev:i.contentRev,baseControlRev:i.controlRev,change:{category:'bug'}});
 assert.deepEqual(fs.readFileSync(s.md),Buffer.from(f.text));assert.equal(ideas.view('P').projection.hash,undefined);assert.equal(ideas.erase('P',op).deleted,true);
});
test('later hand edits and target-bearing or unproven preserved markdown remain protected without an erasure journal',t=>{
 for(const mode of ['hand-edit','full','heading','id','unverified','lost-origin']) {
   const raw=mode==='full'?'PRESERVED-DELETE-ONE\nbody':mode==='heading'?'# PRESERVED-DELETE-ONE':undefined;
   const f=preserved(t,raw),s=f.ideas.resolve('P');
   if(mode==='hand-edit')fs.appendFileSync(s.md,'\nlater unrelated edit');
   if(mode==='id')fs.writeFileSync(s.md,f.text+f.a.id);
   if(mode==='unverified')f.ideas.internal('P',U.uuid(),{},d=>{d.items[f.a.id].source.capture='none';});
   if(mode==='lost-origin') { // retained current existingHash alone is insufficient
     const dir=path.join(f.ideas.control,'transactions',U.hash(s.file));fs.rmSync(dir,{recursive:true});
   }
   const bytes=fs.readFileSync(s.md),before=fs.readFileSync(s.file);assert.equal(f.ideas.eraseAvailability('P',f.a.id).allowed,false,mode);
   assert.throws(()=>f.ideas.erase('P',request(f,f.a.id)),{code:'erase-markdown'});assert.deepEqual(fs.readFileSync(s.md),bytes);assert.deepEqual(fs.readFileSync(s.file),before);assert.equal(fs.existsSync(path.join(s.controlDir,'erase-intent.json')),false);
 }
});
