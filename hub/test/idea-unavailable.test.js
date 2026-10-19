'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,U}=require('./idea-fixture.cjs'),{IdeaLocation}=require('../lib/idea-location'),{create}=require('../lib/idea-unavailable');
function unavailable(f){let queue=[{id:'ordinary'},{id:'auto',automation:{kind:'idea',runId:'old'}},{id:'internal',origin:'hub-internal'}],records=[];
 const chats={queue:()=>queue,setQueue:(_p,_t,q,durable)=>{assert.equal(durable,true);queue=q;},busy:()=>null};
 const a=create({...f,executionGate:f.gate,baseOf:()=>f.main,chats,ROOT:f.root,record:(...v)=>records.push(v)});
 return {...a,queue:()=>queue,records};}
test('missing automation pauses saved intent, retains evidence and removes only automation queue; free edits survive restart',t=>{
 const f=fixture(t),loc=new IdeaLocation({...f,baseOf:()=>f.main}),item=f.add('無料の原文','record');
 f.ideas.internal('P',U.uuid(),{seed:true},d=>{d.settings.auto.enabled=true;d.settings.lane={...loc.inspect('P','lane'),bindingRev:1};d.runs.old={id:'old',purpose:'build',closed:false,delivery:'unknown',targets:[],requestId:'sent',prompt:'private old prompt'};});
 const before=f.ideas.read('P'),a=unavailable(f);a.runner.restore();a.runner.restored();
 const after=f.ideas.read('P');assert.equal(after.settings.auto.enabled,false);assert.equal(after.settings.manualPaused,true);assert.deepEqual(after.runs,before.runs);assert.equal(after.settings.stopGeneration,before.settings.stopGeneration+1);
 assert.deepEqual(a.queue().map(x=>x.id),['ordinary','internal']);assert.equal(a.records[0][0],'idea-unavailable');assert.equal(f.gate.barrier,false);
 assert.throws(()=>a.dispatch.verify({}),e=>e.code==='feature_not_included');assert.throws(()=>a.runner.mayStart(),e=>e.code==='feature_not_included');
 a.runner.wake('P');a.runner.start();assert.deepEqual(f.ideas.read('P').runs,before.runs);
 f.ideas.update('P',{opId:U.uuid(),id:item.id,baseContentRev:1,baseControlRev:1,change:{text:'無料で編集できる'}});
 const revision=f.ideas.read('P').rev;a.runner.restore();a.runner.restored();assert.equal(f.ideas.read('P').rev,revision);assert.equal(f.ideas.view('P').items[0].text,'無料で編集できる');
});
for(const uncertain of [true,false])test('missing automation verification recovery never infers success: '+uncertain,t=>{
 const f=fixture(t),loc=new IdeaLocation({...f,baseOf:()=>f.main});
 f.ideas.internal('P',U.uuid(),{seed:true},d=>{d.settings.lane={...loc.inspect('P','lane'),bindingRev:1};d.evidence.v={id:'v',type:'verification',finished:false,owner:{pid:2147483646,birth:'old'},...(uncertain?{}:{child:{pid:2147483645,birth:'old'}})};});
 const a=unavailable(f);a.runner.restore();a.runner.restored();const e=f.ideas.read('P').evidence.v;
 assert.notEqual(e.success,true);assert.equal(e.finished,!uncertain);if(uncertain)assert.throws(()=>f.gate.assert({dir:f.work}),/終了を照合/);else assert.equal(e.interrupted,true);
});
test('missing automation cannot adopt changed identity or prompt',t=>{
 const f=fixture(t),a=unavailable(f);assert.throws(()=>a.dispatch.verify({automation:{kind:'idea'},contextMode:'idea',freshContext:true,preserveTaskState:true,project:'P'},{adoption:true}),e=>e.code==='idea-run');
});
test('missing automation only adopts the exact already-sent request; new start and altered request fail',t=>{
 const f=fixture(t),a=unavailable(f);
 f.ideas.internal('P',U.uuid(),{seed:true},d=>{d.runs.sent={id:'sent',task:'lane',purpose:'organize',closed:false,targets:[],requestId:'request-sent',prompt:'already sent',readOnly:true,deliveryBinding:{dir:f.dir,identity:U.identity(f.dir)}};});
 const d=f.ideas.read('P'),r=d.runs.sent,o={project:'P',task:'lane',dir:f.dir,readOnly:true,text:r.prompt,request:r.requestId,automation:a.dispatch.metadata(d,r),contextMode:'idea',freshContext:true,preserveTaskState:true};
 assert.equal(a.dispatch.verify(o,{adoption:true}).r.id,r.id);
 assert.throws(()=>a.dispatch.verify(o),e=>e.code==='feature_not_included');
 assert.throws(()=>a.dispatch.verify({...o,text:'changed'},{adoption:true}),e=>e.code==='idea-request');
 assert.throws(()=>a.dispatch.verify({...o,dir:f.work},{adoption:true}),e=>e.code==='idea-location');
 assert.deepEqual(f.ideas.read('P').runs,d.runs);
});
