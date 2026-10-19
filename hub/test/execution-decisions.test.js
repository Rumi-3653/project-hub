'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {License}=require('../lib/license'),{loadExtensions}=require('../lib/extensions');
function absent(t,marker=false){const hub=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-decisions-'));t.after(()=>fs.rmSync(hub,{recursive:true,force:true}));if(marker)fs.writeFileSync(path.join(hub,'paid-bundle.json'),JSON.stringify({version:1,features:['queue_auto','limit_switch','parallel']}));return loadExtensions({hub});}
function license(extensions,owner=true){return new License({owner,extensions,platform:'darwin',root:'/unused',store:{read:()=>null,write:()=>{throw Error('unexpected write');}},secret:{},fetcher:()=>{throw Error('unexpected network');}});}
const request={project:'P',task:'T',ai:'codex'};
const operations=[
 [{...request,mode:'queued'},[],'queue_auto'],
 [{...request,mode:'amend',request:'saved'},[],'queue_auto'],
 [{...request,limitSwitch:{}},[],'limit_switch'],
 [request,[{project:'P',task:'other',ai:'codex',running:true}],'parallel'],
 ...['queue_auto','limit_switch','parallel'].map(f=>[{...request,licenseFeatures:[f]},[],f]),
];
test('missing execution parts refuse automatic queue, handoff and parallel even with valid entitlement; manual/free turns remain',t=>{
 for(const marker of [false,true]){const e=absent(t,marker),a=license(e);
 for(const [options,active,feature] of operations)for(const stage of ['accept','start'])assert.throws(()=>a.guard(options,{active,stage}),error=>error.code==='license_held'&&error.status===403&&error.features.includes(feature)&&Boolean(error.licenseHeld)===(stage==='start'));
 for(const options of [request,{...request,mode:'amend'}, {...request,mode:'manual',request:'saved'}])assert.doesNotThrow(()=>a.guard(options));
 for(const active of [[{...request,running:true}],[{project:'P',task:'other',running:false}],[{project:'P',task:'other',exited:true}]])assert.doesNotThrow(()=>a.guard(request,{active}));
 assert.equal(e.create('limit_switch',{}).enabled(),false);assert.equal(e.create('limit_switch',{}).backup(request),null);
 }
});
test('included execution decisions preserve entitlement-denied results, feature order and start-only licenseHeld',t=>{
 const included=loadExtensions(),missing=absent(t),available=included.state().included;
 const held=license(included,false),noPart=license(missing,true),allowed=license(included,true);
 for(const [options,active,feature] of operations)for(const stage of ['accept','start']){
  const denial=a=>{try{a.guard(options,{active,stage});assert.fail('expected refusal');}catch(e){return {code:e.code,status:e.status,features:e.features,licenseHeld:Boolean(e.licenseHeld)};}};
  assert.deepEqual(denial(noPart),denial(held));
  if(available.includes(feature))assert.doesNotThrow(()=>allowed.guard(options,{active,stage}));
 }
 const combined={...request,origin:'delegate',ai:'chatgpt',mode:'queued',limitSwitch:true,licenseFeatures:['parallel','queue_auto']};
 assert.throws(()=>held.guard(combined,{active:[{task:'other',running:true}]}),e=>JSON.stringify(e.features)===JSON.stringify(['parallel','queue_auto','webchat','delegate','limit_switch']));
});
