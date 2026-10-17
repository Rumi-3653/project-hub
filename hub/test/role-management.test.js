'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path'), os=require('node:os'), vm=require('node:vm');
const history=require('../lib/role-history'), roles=require('../lib/roles');
const {RoleReview,validateDecision}=require('../lib/role-review');
const {availability}=require('../lib/role-review-runtime');
const launch=require('../lib/launch');
const seed='models:\n  claude-code: [Opus 5.5, Fable 5.1]\n  codex: [GPT-6.1-Sol]\nroles:\n  文章: { main: [claude-code, Opus 5.5, 中], backup: [codex, GPT-6.1-Sol, 高], job: 説明文 }\nswitch:\n  auto: true\npermissions:\n  publish: false\n';
test('role review never uses the paid-credit override, including formal handoff queue items',()=>{
  const {heldLimit}=require('../lib/role-review-runtime'),held={hold:true},limits={active:(account,model)=>{assert.equal(account,'selected');assert.equal(model,'gpt-6.1-sol');return held;},forRequest:()=>null};
  const o={ai:'codex',model:'GPT-6.1-Sol',account:'selected'};
  assert.equal(heldLimit({...o,request:'role-review-fixture'},limits),held);
  assert.equal(heldLimit({...o,id:'limit-role-review-fixture'},limits),held);
  assert.equal(heldLimit({...o,origin:'role-review'},limits),held);
  assert.equal(heldLimit(o,limits),null);
});
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-role-unit-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'roles.yaml');fs.writeFileSync(file,seed);return file;}
function edit(file,effort,at,extra={}){const current=history.load(file),next=structuredClone(current.roles);next[0].main.effort=effort;const out=roles.write(file,next,undefined,true,undefined,{at,expectedRevision:current.revision,...extra});assert.equal(out.ok,true,out.errors?.join(' / '));return history.load(file);}
const targets=[{ai:'claude',model:'claude-opus-5-5',account:'default',effort:'中'},{ai:'codex',model:'gpt-6.1-sol',account:'default',effort:'高'}];
const candidates=[{ai:'claude',id:'claude-opus-5-5',label:'Opus 5.5',efforts:['中','高']}];
async function rig(t,participants=targets){const file=fixture(t),calls=[];history.load(file);history.saveDefault(file,history.load(file).roles,history.load(file).revision);const r=new RoleReview({file,createTopic:()=>({id:'generated'}),target:()=>{},ready:()=>true,availability:async()=>({participants,candidates,reason:'fixture'}),dispatch:async p=>calls.push(p)});r.start({project:'freetalk',task:'existing',expectedRevision:history.load(file).revision});await new Promise(r=>setImmediate(r));return {file,r,calls};}
async function finish(r,p,decision,error=''){await r.settled({project:p.project,task:p.task,request:p.request},{ai:p.ai,model:p.model,text:typeof decision==='string'?decision:`[[役割見直し結果]]\n${JSON.stringify(decision)}\n[[/役割見直し結果]]`,error});}

test('baseline persists once, changes alone add history, defaults and unrelated policy stay fixed',t=>{
  const file=fixture(t),base=history.load(file,undefined,'2026-10-10T00:00:00Z'),text=fs.readFileSync(file,'utf8');
  assert.equal(base.journal.defaults,null);assert.equal(history.load(file).journal.history.length,1);assert.equal(fs.readFileSync(file,'utf8'),text);
  const changed=edit(file,'高','2026-10-11T00:00:00Z');assert.equal(changed.journal.history.length,2);
  assert.deepEqual(changed.journal.defaults,base.journal.defaults);
  const before=fs.readFileSync(file,'utf8');assert.equal(roles.write(file,changed.roles).ok,true);assert.equal(fs.readFileSync(file,'utf8'),before);
  assert.deepEqual(roles.read(file).data.switch,{auto:true});assert.deepEqual(roles.read(file).data.permissions,{publish:false});
});
test('date boundaries, multiple changes, empty days, and restore of restore retain exact snapshots',t=>{
  const file=fixture(t);const base=history.load(file,undefined,'2026-10-10T15:00:00Z');
  edit(file,'高','2026-10-11T01:00:00Z');const latest=edit(file,'MAX','2026-10-11T14:59:59Z');
  edit(file,'Ultra','2026-10-11T15:00:00Z');const j=history.load(file).journal;
  assert.throws(()=>history.select(j,{before:'2026-10-10T15:00:00Z'}),/記録されていません/);
  assert.equal(history.select(j,{before:'2026-10-11T15:00:00Z'}).roles[0].main.effort,'MAX');
  assert.equal(history.select(j,{before:'2026-10-14T15:00:00Z'}).roles[0].main.effort,'Ultra');
  assert.equal(history.select(j,{id:latest.journal.history.at(-1).id}).roles[0].main.effort,'MAX');
  const before=history.load(file);assert.equal(roles.write(file,base.roles,undefined,true,undefined,{restore:true,kind:'restore'}).ok,true);
  assert.equal(roles.write(file,before.roles,undefined,true,undefined,{restore:true,kind:'restore'}).ok,true);
  assert.equal(history.load(file).journal.history.length,6);assert.deepEqual(history.load(file).journal.defaults,base.journal.defaults);
});
test('compare-and-save rejects stale editors; rename failure leaves both settings and journal intact',t=>{
  const file=fixture(t),old=history.load(file);edit(file,'高');const text=fs.readFileSync(file,'utf8');
  const stale=roles.write(file,old.roles,undefined,true,undefined,{expectedRevision:old.revision});assert.equal(stale.status,409);assert.equal(fs.readFileSync(file,'utf8'),text);
  const rename=fs.renameSync;fs.renameSync=()=>{throw Error('disk failure');};
  try{const out=roles.write(file,old.roles,undefined,true);assert.equal(out.ok,false);assert.equal(fs.readFileSync(file,'utf8'),text);}finally{fs.renameSync=rename;}
  assert.equal(fs.readdirSync(path.dirname(file)).length,1);
});
test('direct file edit is recorded without overwriting fixed defaults and comments remain intact',t=>{
  const file=fixture(t),base=history.load(file);fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('Opus 5.5, 中','Opus 5.5, 高')+'# human final comment\n');
  const next=history.load(file);assert.equal(next.journal.history.length,2);assert.equal(next.journal.history.at(-1).kind,'edit');assert.deepEqual(next.journal.defaults,base.journal.defaults);
  const before=fs.readFileSync(file,'utf8');history.load(file);assert.equal(fs.readFileSync(file,'utf8'),before);assert.ok(before.endsWith('# human final comment\n'));
});
test('both models discuss once in order and unchanged success updates only review time',async t=>{
  const {r,calls,file}=await rig(t);const base=history.load(file);
  assert.throws(()=>r.start({project:'freetalk',task:'existing',expectedRevision:base.revision}),/受付済み/);
  assert.equal(roles.write(file,base.roles).status,409);
  await finish(r,calls[0],'proposal');await r.tick();assert.match(calls[1].text,/proposal/);
  await finish(r,calls[1],'second opinion');await r.tick();assert.match(calls[2].text,/second opinion/);
  assert.deepEqual(calls.map(x=>x.ai),['claude','codex','claude']);
  await finish(r,calls[2],{roles:base.roles,reason:'維持',evidence:[]});
  const done=history.load(file);assert.ok(done.journal.lastReviewedAt);assert.equal(done.journal.review,null);assert.equal(done.journal.history.length,1);assert.equal(done.journal.lastReview.participants.length,2);
  await r.tick();assert.equal(calls.length,3);
});
for(const single of targets)test('one available model completes and saves once: '+single.ai,async t=>{
  const {r,calls,file}=await rig(t,[single]),data=history.load(file).roles;data[0].main.effort='高';
  await finish(r,calls[0],{roles:data,reason:'根拠あり',evidence:[{role:'文章',reason:'高の効果を確認',sources:['fixture evidence']}]});
  const j=history.load(file).journal;assert.ok(j.lastReviewedAt);assert.equal(j.history.length,2);assert.equal(j.defaults.roles[0].main.effort,'中');assert.equal(calls.length,1);
});
test('neither available, invalid result, ordinary error, cancel, and restart never advance the last successful time',async t=>{
  for(const mode of ['none','bad','error','cancel','restart']){
    const {r,calls,file}=await rig(t,mode==='none'?[]:[targets[0]]),before=history.load(file).roles;
    if(mode==='bad')await finish(r,calls[0],'invalid JSON');
    if(mode==='error')await finish(r,calls[0],'','network failure');
    if(mode==='cancel')r.cancel();
    if(mode==='restart')r.recover();
    const j=history.load(file).journal;assert.equal(j.lastReviewedAt,'',mode);assert.equal(j.history.length,1,mode);assert.equal(j.review,null,mode);assert.deepEqual(history.load(file).roles,before);assert.equal(j.lastReview.status,'failed');
  }
});
test('external edits invalidate in-flight results and failed review preserves previous successful time',async t=>{
  const {r,calls,file}=await rig(t,[targets[0]]);await finish(r,calls[0],{roles:history.load(file).roles,reason:'維持',evidence:[]});const stamp=history.load(file).journal.lastReviewedAt;
  r.start({project:'freetalk',task:'existing',expectedRevision:history.load(file).revision});await new Promise(r=>setImmediate(r));
  const original=history.load(file).roles;fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('Opus 5.5, 中','Opus 5.5, 高'));
  await finish(r,calls.at(-1),{roles:original,reason:'維持',evidence:[]});assert.equal(history.load(file).roles[0].main.effort,'高');assert.equal(history.load(file).journal.lastReviewedAt,stamp);
});
test('decision validates evidence, supported effort, Agy scope and JSON key order',t=>{
  const current=history.load(fixture(t)).roles,next=structuredClone(current);next[0].main.effort='高';
  assert.throws(()=>validateDecision({roles:next},current,candidates),/根拠/);
  next[0].main.effort='Ultra';assert.throws(()=>validateDecision({roles:next},current,candidates),/組合せ/);
  next[0].main={ai:'agy',model:'Gemini',effort:'高'};assert.throws(()=>validateDecision({roles:next},current,[{ai:'agy',id:'gemini-3.1-pro-high',label:'Gemini',efforts:['高']}]),/Agy/);
  const reordered=current.map(r=>({backup:r.backup,job:r.job,name:r.name,main:{effort:r.main.effort,model:r.main.model,ai:r.main.ai}}));validateDecision({roles:reordered},current,candidates);
});
test('fresh subscription model discovery uses the selected account; API and held models do not participate',async t=>{
  const p={project:'freetalk',task:'existing',roles:history.load(fixture(t)).roles},seen=[];
  const d={accountFor:()=> 'selected',accounts:{readOnly:async(a,id,fn)=>{assert.equal(id,'selected');return fn();},status:async ai=>({status:ai==='claude'?'api':'logged-in'}),env:()=>({isolated:true}),location:()=>'/isolated'},
    tools:{find:ai=>['claude','codex'].includes(ai),refresh:async(ai,o)=>{seen.push(o);return {ok:true,models:[{id:'gpt-6.1-sol',label:'GPT-6.1-Sol',efforts:['中','高']}]};}},applyCatalog:()=>{},usage:{status:async()=>{}},limits:{active:()=>false}};
  let out=await availability(p,targets,d);assert.deepEqual(out.participants.map(p=>p.ai),['codex']);assert.equal(seen[0].fileAuth,true);assert.deepEqual(seen[0].env,{isolated:true});
  d.limits.active=()=>true;out=await availability(p,targets,d);assert.equal(out.participants.length,0);assert.equal(out.candidates.length,1);
  d.tools.refresh=async()=>({ok:true,unchanged:true});out=await availability(p,targets,d);assert.equal(out.participants.length,0);
});
test('browser day selection uses local midnight including DST and does not invent a pre-baseline record',()=>{
  const old=process.env.TZ;process.env.TZ='America/New_York';
  try{const c=vm.createContext({document:{addEventListener(){}},Date});vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/role-settings.js'),'utf8'),c);
    assert.equal(c.roleDayBefore('2026-03-08'),'2026-03-09T04:00:00.000Z');assert.equal(c.roleDayBefore('2026-11-01'),'2026-11-02T05:00:00.000Z');assert.equal(c.roleDayBefore('2026-02-30'),'');
    assert.equal(c.roleHistorySelection([{id:'one',at:'2026-03-09T04:00:00Z'}],'2026-03-08',''),undefined);
  }finally{if(old===undefined)delete process.env.TZ;else process.env.TZ=old;}
});

test('defaults are opt-in; displayed draft saves without applying roles or changing review time/history, and stale saves are rejected',t=>{
  const file=fixture(t),base=history.load(file),draft=structuredClone(base.roles);draft[0].main.effort='高';
  assert.equal(history.summary(base).defaultSavedAt,'');
  const out=roles.saveDefault(file,draft,base.revision);assert.equal(out.ok,true);
  const saved=history.load(file);assert.deepEqual(saved.roles,base.roles);assert.deepEqual(saved.journal.defaults.roles,draft);
  assert.deepEqual(saved.journal.history,base.journal.history);assert.equal(saved.journal.lastReviewedAt,'');
  assert.equal(roles.saveDefault(file,base.roles,base.revision).status,409);
  assert.equal(roles.saveDefault(file,[],saved.revision).status,400);
  edit(file,'MAX');assert.deepEqual(history.load(file).journal.defaults,saved.journal.defaults);
  const revision=history.load(file).revision;
  assert.equal(roles.saveDefault(file,base.roles,revision).ok,true);assert.deepEqual(history.load(file).journal.defaults.roles,base.roles);
  const before=fs.readFileSync(file,'utf8'),rename=fs.renameSync;fs.renameSync=()=>{throw Error('disk full');};
  try{assert.equal(roles.saveDefault(file,draft,history.load(file).revision).ok,false);assert.equal(fs.readFileSync(file,'utf8'),before);}finally{fs.renameSync=rename;}
});
test('v1 automatic defaults migrate to unset without losing the old snapshot or history',t=>{
  const file=fixture(t),base=history.load(file),old={at:'2026-10-10T00:00:00Z',roles:base.roles};
  history.updateReview(file,null,j=>{j.version=1;j.defaults=old;});
  const migrated=history.load(file);assert.equal(migrated.journal.version,2);assert.equal(migrated.journal.defaults,null);
  assert.deepEqual(migrated.journal.legacyDefaults,old);assert.deepEqual(migrated.journal.history,base.journal.history);
  roles.saveDefault(file,base.roles,migrated.revision);assert.ok(history.load(file).journal.defaults);
});
test('topic reservation precedes creation, duplicate requests create once, and creation/dispatch failures do not save settings',async t=>{
  const file=fixture(t),base=history.load(file);let created=0,ready=false;
  const r=new RoleReview({file,createTopic:()=>{created++;assert.equal(history.load(file).journal.review.status,'creating');return {id:'new-topic'};},target:()=>{},ready:()=>ready,
    availability:async()=>({participants:[targets[0]],candidates,reason:'fixture'}),dispatch:async()=>{throw Error('start failed');}});
  r.start({expectedRevision:base.revision});assert.equal(created,1);
  assert.throws(()=>r.start({expectedRevision:base.revision}),/受付済み/);assert.equal(created,1);
  assert.equal(roles.saveDefault(file,base.roles,base.revision).status,409);
  ready=true;await r.tick();let j=history.load(file).journal;assert.equal(j.lastReview.task,'new-topic');assert.equal(j.lastReviewedAt,'');assert.deepEqual(j.history,base.journal.history);
  r.createTopic=()=>{throw Error('topic write failed');};assert.throws(()=>r.start({expectedRevision:base.revision}),/topic write failed/);
  j=history.load(file).journal;assert.equal(j.review,null);assert.equal(j.lastReviewedAt,'');assert.deepEqual(j.history,base.journal.history);
  history.updateReview(file,null,j=>{j.review={id:'interrupted-create',project:'freetalk',task:'',status:'creating'};});r.recover();assert.equal(history.load(file).journal.review,null);assert.equal(created,1);
});

test('Agyの見直しは既存の割当役割だけで最新候補を許可し、消えたモデルや新規割当を拒否',()=>{
 const current=[{name:'文章',job:'説明文',main:{ai:'agy',model:'Removed Gemini',effort:'高'},backup:{ai:'codex',model:'GPT-6.1-Sol',effort:'高'}}],rows=[{ai:'agy',id:'gemini-current',label:'Current Gemini',efforts:['高']}];
 const decision={roles:structuredClone(current),reason:'確認した候補',evidence:[{role:'文章',reason:'実測の根拠',sources:['確認済み候補']} ]};decision.roles[0].main.model='Current Gemini';
 assert.doesNotThrow(()=>validateDecision(decision,current,rows));
 assert.throws(()=>validateDecision(decision,current,[]),/確認できたモデル/);
 const other=structuredClone(current);other[0].main={ai:'claude-code',model:'Opus 5.5',effort:'高'};
 assert.throws(()=>validateDecision(decision,other,rows),/人が割り当てた役割/);
 assert.doesNotThrow(()=>validateDecision({roles:current,reason:'維持',evidence:[]},current,rows));
});
