'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const tmp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'hub-role-http-'))),root=path.join(tmp,'root'),home=path.join(tmp,'home'),bin=path.join(tmp,'bin');
fs.mkdirSync(path.join(root,'_hub'),{recursive:true});fs.mkdirSync(bin);
const file=path.join(root,'_hub/roles.yaml'),control=path.join(tmp,'response.json'),invocations=path.join(tmp,'calls.jsonl');
fs.copyFileSync(path.join(__dirname,'../../docs/project-hub/templates/_hub/roles.yaml'),file);
for(const ai of ['claude','codex'])fs.writeFileSync(path.join(bin,ai),`#!${process.execPath}
const fs=require('node:fs'),ai=${JSON.stringify(ai)};let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
const c=JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8'));fs.appendFileSync(${JSON.stringify(invocations)},JSON.stringify({ai,args:process.argv.slice(2),input})+'\\n');
const text=c.bad?'invalid result':'[[役割見直し結果]]\\n'+JSON.stringify(c)+'\\n[[/役割見直し結果]]',out=o=>console.log(JSON.stringify(o));
if(ai==='claude'){out({type:'system',subtype:'init',session_id:'role-fixture'});out({type:'assistant',message:{content:[{type:'text',text}]}});out({type:'result',is_error:false,result:'',session_id:'role-fixture'});}
else{out({type:'thread.started',thread_id:'role-fixture'});out({type:'item.completed',item:{type:'agent_message',text}});out({type:'turn.completed'});}
});`,{mode:0o755});
process.env.PATH=bin+':/usr/bin:/bin';process.env.HUB_ROOT=root;process.env.HUB_FREETALK_HOME=home;process.env.HUB_AI_HOME=path.join(tmp,'ai');process.env.HUB_DRY_RUN='1';
const port=42000+Math.floor(Math.random()*1000);process.env.HUB_PORT=String(port);
const {server,chats,roleReview}=require('../server');const chat=require('../lib/chat');
const base=`http://127.0.0.1:${port}`,pdir=path.join(root,'Product/freetalk');let task;
const post=(route,body={},header=true)=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',...(header?{'X-Hub':'1'}:{})},body:JSON.stringify(body)});
const state=async()=>await(await fetch(base+'/api/state')).json();
const journal=async()=>await(await fetch(base+'/api/roles/history')).json();
const participants=[{ai:'claude',model:'claude-opus-5-5',account:'default',effort:'高'},{ai:'codex',model:'gpt-6.1-sol',account:'default',effort:'高'}];
const probe=async()=>({participants,candidates:[{ai:'claude',id:'claude-opus-5-5',label:'Opus 5.5',efforts:['中','高']}],reason:'fixture'});
async function finished(){for(let i=0;i<150;i++){await new Promise(r=>setTimeout(r,30));await roleReview.tick();if(!(await journal()).review)return;}assert.fail('review did not settle');}
const start=async()=>{const res=await post('/api/roles/review',{expectedRevision:(await journal()).revision});if(res.ok){const data=await res.json();task=(data.management.review || data.management.lastReview).task;}return res;};
test.before(async()=>{
  await new Promise(r=>server.listen(port,'127.0.0.1',r));await post('/api/freetalk/ensure');task=(await(await post('/api/freetalk/topic')).json()).id;
  roleReview.availability=probe;
});
test.after(async()=>{await chats.stopAll();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(tmp,{recursive:true,force:true});});
test('one click creates a new topic and both exact models consult there without changing existing topics',async()=>{
  const settings=(await state()).roles.roles,taskFile=path.join(pdir,'.ai/tasks',task+'.md'),original=fs.readFileSync(taskFile,'utf8'),names=fs.readdirSync(path.dirname(taskFile));
  fs.writeFileSync(control,JSON.stringify({roles:settings,reason:'変更なし',evidence:[]}));
  const existing=task;assert.equal((await start()).status,200);assert.notEqual(task,existing);await finished();
  const j=await journal();assert.ok(j.lastReviewedAt);assert.equal(j.history.length,1);assert.equal(j.lastReview.status,'success');
  const runs=fs.readFileSync(invocations,'utf8').trim().split('\n').map(JSON.parse);assert.deepEqual(runs.map(r=>r.ai),['claude','codex','claude']);
  assert.deepEqual(runs.map(r=>r.args[r.args.indexOf('--model')+1]),['claude-opus-5-5','gpt-6.1-sol','claude-opus-5-5']);
  assert.ok(runs.every(r=>!r.args.includes('resume')&&!r.args.includes('--resume')));
  assert.equal(chat.read(pdir,task).filter(r=>r.role==='assistant').length,3);
  assert.equal(fs.readdirSync(path.dirname(taskFile)).length,names.length+1);assert.equal(j.lastReview.task,task);assert.match(fs.readFileSync(path.join(path.dirname(taskFile),task+'.md'),'utf8'),/title: 役割分担の見直し/);assert.equal(fs.readFileSync(taskFile,'utf8'),original);
});
test('successful one-model decision saves atomically; default and history restore preserve limit flags',async()=>{
  const initial=await journal();assert.equal(initial.defaults,null);assert.equal((await post('/api/roles/restore',{defaults:true,expectedRevision:initial.revision})).status,409);
  const settings=(await state()).roles.roles;assert.equal((await post('/api/roles/default',{roles:settings,expectedRevision:initial.revision})).status,200);
  const before=await journal(),next=structuredClone(settings);next.find(r=>r.name==='文章').main.effort='高';
  roleReview.availability=async()=>({...await probe(),participants:[participants[1]]});
  fs.writeFileSync(control,JSON.stringify({roles:next,reason:'変更',evidence:[{role:'文章',reason:'確認済みの効果',sources:['fixture']}] }));
  assert.equal((await start()).status,200);await finished();let j=await journal();assert.equal(j.history.length,2);assert.equal(j.lastReview.participants.length,1);assert.deepEqual(j.defaults,before.defaults);
  const changed=j.history.at(-1);const limitFile=path.join(root,'_hub/limits.json');fs.writeFileSync(limitFile,'{"v":1,"entries":{}}\n');
  let res=await post('/api/roles/restore',{defaults:true,expectedRevision:j.revision});assert.equal(res.status,200);assert.deepEqual((await res.json()).roles,settings);
  j=await journal();assert.equal(j.history.length,3);assert.deepEqual(j.defaults,before.defaults);assert.equal(fs.readFileSync(limitFile,'utf8'),'{"v":1,"entries":{}}\n');
  res=await post('/api/roles/restore',{id:changed.id,expectedRevision:j.revision});assert.equal(res.status,200);assert.deepEqual((await res.json()).roles,next);
  assert.equal((await journal()).history.length,4);
});
test('invalid, unavailable and cancelled reviews preserve settings, time and history; duplicate/edit/stale restore rejected',async()=>{
  const before=await journal();fs.writeFileSync(control,JSON.stringify({bad:true}));assert.equal((await start()).status,200);await finished();
  roleReview.availability=async()=>({participants:[],candidates:[],reason:'unavailable'});assert.equal((await start()).status,200);await finished();
  const ready=roleReview.ready;roleReview.ready=()=>false;
  try{const count=fs.readdirSync(path.join(pdir,'.ai/tasks')).length,revision=(await journal()).revision;
    const requests=await Promise.all([post('/api/roles/review',{expectedRevision:revision}),post('/api/roles/review',{expectedRevision:revision})]);
    assert.deepEqual(requests.map(r=>r.status).sort(),[200,409]);task=(await journal()).review.task;assert.equal(fs.readdirSync(path.join(pdir,'.ai/tasks')).length,count+1);
    const s=(await state()).roles;assert.equal((await post('/api/roles',{roles:s.roles,expectedRevision:s.management.revision})).status,409);
    assert.equal((await post('/api/roles/review/cancel')).status,200);
    assert.equal((await start()).status,200);
    assert.equal((await post('/api/chat/stop',{project:'freetalk',task})).status,200);
    assert.equal((await journal()).review,null);
  }finally{roleReview.ready=ready;roleReview.availability=probe;}
  const after=await journal();assert.equal(after.lastReviewedAt,before.lastReviewedAt);assert.deepEqual(after.history,before.history);
  assert.equal((await post('/api/roles/restore',{defaults:true,expectedRevision:'stale'})).status,409);
  assert.equal((await post('/api/roles/restore',{before:'1990-01-01T00:00:00Z',expectedRevision:after.revision})).status,409);
  assert.equal((await post('/api/roles/review',{},false)).status,403);
});

test('default save preserves current roles, review timestamp and history; stale/invalid/default-while-review requests reject',async()=>{
  const before=await journal(),settings=(await state()).roles.roles,draft=structuredClone(settings);draft.find(r=>r.name==='文章').main.effort='中';
  let res=await post('/api/roles/default',{roles:draft,expectedRevision:before.revision});assert.equal(res.status,200);
  let saved=await journal();assert.deepEqual((await state()).roles.roles,settings);assert.deepEqual(saved.defaults.roles,draft);
  assert.deepEqual(saved.history,before.history);assert.equal(saved.lastReviewedAt,before.lastReviewedAt);
  assert.equal((await post('/api/roles/default',{roles:settings,expectedRevision:before.revision})).status,409);
  assert.equal((await post('/api/roles/default',{roles:[],expectedRevision:saved.revision})).status,400);
  assert.equal((await post('/api/roles/default',{roles:settings,expectedRevision:saved.revision},false)).status,403);
  const ready=roleReview.ready;roleReview.ready=()=>false;
  try{await start();assert.equal((await post('/api/roles/default',{roles:settings,expectedRevision:saved.revision})).status,409);await post('/api/roles/review/cancel');}finally{roleReview.ready=ready;}
  saved=await journal();assert.deepEqual(saved.defaults.roles,draft);
  res=await post('/api/roles/restore',{defaults:true,expectedRevision:saved.revision});assert.equal(res.status,200);assert.deepEqual((await res.json()).roles,draft);
});
