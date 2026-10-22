'use strict';
// A per-integration authorization. A queue flag alone never grants it.
const {createHash}=require('node:crypto'),launch=require('./launch');
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail=()=>{throw Error('統合の担当指定が変更・欠落しています。送信・受領はしません');};
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const phaseSlot=p=>p==='order'?'code':p;
function normalize(assignments,check=()=>{}){
  if(assignments===undefined)return null;
  if(!assignments||Array.isArray(assignments)||Object.keys(assignments).sort().join()!=='code,organize,review')fail();
  const slots={};
  for(const name of ['organize','code','review']){
    const s=assignments[name];
    if(!s||Object.keys(s).some(k=>!['ai','model','effort'].includes(k))||!launch.AIS.includes(s.ai)||typeof s.model!=='string'||!s.model.trim())fail();
    const model=launch.flagFor(s.ai,s.model),effort=s.effort??'';
    if(!model||effort!==''&&!require('./roles').EFFORTS.includes(effort)||s.ai==='grok'&&effort==='Ultra'||s.ai==='agy'&&effort!=='高')fail();
    check(s.ai,model);slots[name]={ai:s.ai,model,effort};
  }
  if(['organize','code'].some(k=>slots[k].ai===slots.review.ai&&slots[k].model===slots.review.model))throw Error('独立確認には整理・解消と異なる担当モデルを指定してください');
  return {version:1,limitPolicy:'hold',slots};
}
function policy(r){
  const p=r?.auto?.assignmentPolicy,h=r?.auto?.assignmentPolicyHash;
  if(!p&&!h&&!r?.assignmentPolicyHash&&!Object.values(r?.auto?.attempts||{}).some(a=>a.assigned||a.request?.integrationAssignment))return null;
  if(!p||h!==hash(p)||r.assignmentPolicyHash!==h||!equal(p,normalize(p.slots)))fail();
  return p;
}
function validate(r){
  const p=policy(r);if(!p)return null;
  for(const [key,a]of Object.entries(r.auto.attempts||{})){
    if(!a.assigned){if(a.delivery||a.request)fail();continue;}
    const s=p.slots[phaseSlot(a.assigned.phase)];
    if(!s||!equal(a.assigned,{...s,phase:a.assigned.phase,policyHash:hash(p)})||!equal(a.request?.integrationAssignment,reference(r,key,a.assigned.phase))||a.request.ai!==s.ai||a.request.model!==s.model||a.request.effort!==s.effort||a.request.limitPolicy!=='hold')fail();
  }
  return p;
}
function reference(r,key,phase){return {project:r.project,task:r.task,id:r.id,key,phase,policyHash:r.assignmentPolicyHash};}
function bind(r,a,key,request){
  const p=validate(r);if(!p)return request;
  const slot=p.slots[phaseSlot(a.phase)];if(!slot)fail();
  a.assigned={...slot,phase:a.phase,policyHash:hash(p)};
  return {...request,...slot,integrationAssignment:reference(r,key,a.phase),limitPolicy:'hold'};
}
function records(h,o,q){
  const refs=[o.integrationAssignment,q?.integrationAssignment].filter(Boolean);
  const rows=[...h.records(o.project,o.task),...h.pending().map(r=>h.read(r.project,r.task,r.id)),...refs.map(r=>h.read(r.project,r.task,r.id))].filter(Boolean);
  return [...new Map(rows.map(r=>[r.id,r])).values()];
}
function find(h,o,q){
  const ids=[o.request,q?.id,q?.request,o.integrationReviewRequest,q?.integrationReviewRequest,o.limitSwitch?.sourceRequest].filter(Boolean);
  const markers=[...String(o.text||'').matchAll(/\[integration-auto:([a-f0-9]{64}):(code|review|organize|order)\]/g)].map(m=>m[1]);
  const matches=records(h,o,q).flatMap(r=>Object.entries(r.auto?.attempts||{}).filter(([k,a])=>ids.some(id=>[a.delivery?.request,a.delivery?.queueId,'limit-'+a.delivery?.request].includes(id))||markers.includes(k)||o.integrationAssignment?.id===r.id&&o.integrationAssignment.key===k||q?.integrationAssignment?.id===r.id&&q.integrationAssignment.key===k).map(([key,a])=>({r,key,a}))).filter(x=>policy(x.r));
  if(matches.length>1)fail();
  if(!matches.length&&(o.integrationAssignment||q?.integrationAssignment||o.limitPolicy==='hold'||q?.limitPolicy==='hold'))fail();
  return matches[0]||null;
}
function assign(h,request){
  const ref=request.integrationAssignment;if(!ref)return null;
  const r=h.read(ref.project,ref.task,ref.id),p=validate(r),a=r?.auto?.attempts?.[ref.key];
  require('./integration-sibling').assert(h,r);
  if(!p||!a||r.id!==ref.id||!equal(ref,a.request?.integrationAssignment)||!equal({...request,requestKey:request.requestKey??a.delivery?.request},{...a.request,requestKey:a.delivery?.request}))fail();
  return {...request,...p.slots[phaseSlot(ref.phase)],requireModel:true,requiredModel:a.assigned.model};
}
function verify(h,o,q,check=()=>{}){
  const found=find(h,o,q);if(!found)return null;
  require('./integration-sibling').assert(h,found.r);
  const {r,key,a}=found,p=validate(r),ref=reference(r,key,a.assigned.phase),s=p.slots[phaseSlot(ref.phase)];
  if(r.abandoned||r.complete||r.auto.stopped||a.phase!==ref.phase||!['intent','accepted'].includes(a.delivery?.state)||o.project!==a.request.project||o.task!==a.request.task)fail();
  for(const x of [o,...(q?[q]:[])]){
    if(!equal(x.integrationAssignment,ref)||x.limitPolicy!=='hold'||x.ai!==s.ai||launch.flagFor(x.ai,x.model)!==s.model||x.effort!==s.effort||x.requireModel!==true||x.requiredModel!==s.model||x.limitSwitch)fail();
    if(ref.phase==='review'&&(x.readOnly!==true||x.isolatedReview!==true||x.integrationReviewRequest!==a.delivery.request))fail();
  }
  const marks=[...String(o.text||'').matchAll(/\[integration-auto:([a-f0-9]{64}):(code|review|organize|order)\]/g)];
  if(marks.length!==1||marks[0][1]!==key||marks[0][2]!==ref.phase||q&&(q.shown||q.text)!==(o.shown||o.text))fail();
  check(s.ai,s.model);return found;
}
function completion(r,a,row){
  if(!validate(r))return;
  const s=a?.assigned;
  if(!s||![a.delivery?.request,a.delivery?.queueId].filter(Boolean).includes(row.request)||row.ai!==s.ai||launch.flagFor(row.ai,row.model)!==s.model||row.integrationAuto?.closed!==true)fail();
}
module.exports={normalize,hash,policy,validate,bind,find,assign,verify,completion};
