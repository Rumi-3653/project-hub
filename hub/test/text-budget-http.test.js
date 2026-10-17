'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'text-body-http-')),home=path.join(root,'home');fs.mkdirSync(home);
Object.assign(process.env,{HUB_ROOT:root,HOME:home,HUB_FREETALK_HOME:home,HUB_DRY_RUN:'1',HUB_PORT:String(47000+Math.floor(Math.random()*1000))});
const {Store}=require('../lib/store'),{count,sections}=require('../lib/text-budget'),store=new Store(root),p=store.createProject({name:'Fixture'}).project,t=store.createTask(p.id,{title:'本作業',steps:['未済']}),file=store.taskFile(p.id,t.id),other=store.createTask(p.id,{title:'他作業'}),otherFile=store.taskFile(p.id,other.id);
const result='- body:.@123abcd（原文）\n';fs.appendFileSync(file,'\n## 最新の再開要約\n承認：整理だけ\n'+('承認未済'.repeat(700))+'\n## 古い詳細\nSEARCH_OLD\n## メモ\n'+('- old😀\n'.repeat(6000))+'## 成果\n'+result);const otherBytes=fs.readFileSync(otherFile),initial=fs.readFileSync(file);
const {server,textBudget,taskPrompt}=require('../server');let base;const b={project:p.id,task:t.id};
const post=(route,body={})=>fetch(base+route,{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json'},body:JSON.stringify({...b,...body})});
const preview=async()=>await(await fetch(base+'/api/task/body/preview?'+new URLSearchParams(b),{headers:{'X-Hub':'1'}})).json();
test.before(async()=>{await new Promise(r=>server.listen(Number(process.env.HUB_PORT),'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;});
test.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});});
test('正式HTTP 初回プレビュー認証・読み取りとAI取得・注入上限',async()=>{
 assert.equal((await fetch(base+'/api/task/body/preview?'+new URLSearchParams(b))).status,403);const pv=await preview();assert.ok(pv.token);assert.ok(pv.moves.length);assert.deepEqual(fs.readFileSync(file),initial);assert.equal(pv.enabled,false);
 const r=await post('/api/mcp/call',{name:'hub_get_task',arguments:b}),out=await r.json();assert.equal(r.status,200,JSON.stringify(out));assert.ok(count(out.text)<=24000);assert.match(out.text,/hub_search_archive/);assert.deepEqual(fs.readFileSync(file),initial);
 for(const where of ['chat','terminal']){const prompt=taskPrompt(store.readProject(p.id),store.readTask(file),file,p.dir,where);assert.ok(!prompt.includes('承認未済'.repeat(700)));assert.match(prompt,/書き直し/);}
 assert.equal((await post('/api/chatgpt/prompt',{text:'😀'.repeat(25000)})).status,410);assert.deepEqual(fs.readFileSync(file),initial);
 const tools=await(await fetch(base+'/api/mcp/tools',{headers:{'X-Hub':'1'}})).json();assert.ok(tools.tools.some(x=>x.name==='hub_search_archive'));
});
test('正式HTTP 他POST保存待ちを保護し、confirm/token/競合拒否と一度の整理',async()=>{
 const pv=await preview();assert.equal((await post('/api/task/body/apply',pv)).status,409);
 let finish;const done=new Promise(r=>finish=r),slow=http.request(base+'/api/chat/note',{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json','Content-Length':2}},res=>{res.resume();res.on('end',finish);});slow.write('{');
 let busy;for(let i=0;i<100;i++){busy=await preview();if(busy.reason)break;await new Promise(r=>setTimeout(r,10));}assert.ok(busy.reason);assert.equal((await post('/api/task/body/apply',{...pv,confirm:true})).status,409);assert.deepEqual(fs.readFileSync(file),initial);slow.end('}');await done;
 const fresh=await preview(),response=await post('/api/task/body/apply',{...fresh,confirm:true}),out=await response.json();assert.equal(response.status,200,JSON.stringify(out));assert.equal((await post('/api/task/body/apply',{...fresh,confirm:true})).status,409);
 assert.deepEqual(fs.readFileSync(otherFile),otherBytes);assert.equal(sections(fs.readFileSync(file,'utf8')).find(x=>x.name==='成果').body,result);assert.equal((await preview()).enabled,true);
 const q=await(await post('/api/mcp/call',{name:'hub_search_archive',arguments:{...b,query:'SEARCH_OLD'}})).json();assert.match(q.text,/sections-/);assert.ok(count(q.text)<=8000);
 const sum=await post('/api/task/body/summary',{summary:'承認済みの範囲：実データ整理だけ\n未済：本体反映'});assert.equal(sum.status,200,JSON.stringify(await sum.clone().json()));assert.ok(textBudget.search(p.id,t.id,'承認未済').includes('summary-'));
 let doneQueued;const endQueued=new Promise(r=>doneQueued=r),slowQueued=http.request(base+'/api/chat/note',{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json','Content-Length':2}},res=>{res.resume();res.on('end',doneQueued);});slowQueued.write('{');let queuedBusy;for(let i=0;i<100;i++){queuedBusy=await preview();if(queuedBusy.reason)break;await new Promise(r=>setTimeout(r,10));}assert.ok(queuedBusy.reason);const prior=fs.readFileSync(file),queued=await(await post('/api/task/body/summary',{summary:'未済：HTTP終了待ち'})).json();assert.equal(queued.queued,true);assert.deepEqual(fs.readFileSync(file),prior);slowQueued.end('}');await endQueued;textBudget.maintain(p.id,t.id);assert.equal(sections(fs.readFileSync(file,'utf8')).find(x=>x.name.startsWith('最新の再開要約')).body.trim(),'未済：HTTP終了待ち');

});

test('正式HTTP state/previewは保存済み競合を毎回表示し、busy新候補も反映前は解除しない',async()=>{
 const notices=async()=>(await(await fetch(base+'/api/state')).json()).bodyNotices.filter(x=>x.scope===p.id+' / '+t.id);
 let busy=true;const savedBusy=textBudget.busy;textBudget.busy=()=>busy;
 try{
  const original=fs.readFileSync(file,'utf8');const queued=await(await post('/api/task/body/summary',{summary:'未済：HTTP-CONFLICT'})).json();assert.equal(queued.queued,true);
  fs.writeFileSync(file,original.replace('未済：HTTP終了待ち','未済：HTTP-EXTERNAL'));const external=fs.readFileSync(file);busy=false;textBudget.maintain(p.id,t.id);
  for(let i=0;i<3;i++){assert.match((await notices()).map(x=>x.message).join(' '),/原文が変わっています/);assert.match((await preview()).warnings.join(' '),/原文が変わっています/);textBudget.maintain(p.id,t.id);assert.deepEqual(fs.readFileSync(file),external);}
  busy=true;assert.equal((await(await post('/api/task/body/summary',{summary:'承認：HTTP-CONFIRMED'})).json()).queued,true);assert.match((await notices()).map(x=>x.message).join(' '),/原文が変わっています/);assert.deepEqual(fs.readFileSync(file),external);
  busy=false;textBudget.maintain(p.id,t.id);assert.ok(!(await notices()).some(x=>/原文が変わっています/.test(x.message)));assert.ok(!(await preview()).warnings.some(x=>/原文が変わっています/.test(x)));assert.equal(sections(fs.readFileSync(file,'utf8')).find(x=>x.name==='最新の再開要約').body.trim(),'承認：HTTP-CONFIRMED');
 }finally{textBudget.busy=savedBusy;}
});
