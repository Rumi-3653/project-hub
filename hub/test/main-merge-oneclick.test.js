'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),{execFileSync}=require('node:child_process');
const tmp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-main-oneclick-')),root=path.join(tmp,'root');
Object.assign(process.env,{HUB_ROOT:root,HUB_FREETALK_HOME:path.join(tmp,'home'),HUB_DRY_RUN:'1',HUB_TRASH:path.join(tmp,'Trash'),HUB_PORT:String(54000+Math.floor(Math.random()*1000))});
const {Store}=require('../lib/store'),git=require('../lib/git'),locale=require('./ui-locale-fixture'),runtime=require('../server'),store=new Store(root);let base,serial=0;
const g=(d,...a)=>execFileSync('git',['-C',d,...a],{encoding:'utf8',stdio:'pipe'}).trim();
const calls=[];async function api(route,body){calls.push({route,body});const r=await fetch(base+route,{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json',Connection:'close'},body:JSON.stringify(body)}),d=await r.json();if(!r.ok)throw Object.assign(Error(d.error),d,{status:r.status});return d;}
const post=async(route,b)=>{try{return {status:200,...await api(route,b)};}catch(e){return e;}};
test.before(async()=>{await new Promise(r=>runtime.server.listen(Number(process.env.HUB_PORT),'127.0.0.1',r));base='http://127.0.0.1:'+runtime.server.address().port;});
test.after(async()=>{runtime.server.closeAllConnections();await new Promise(r=>runtime.server.close(r));fs.rmSync(tmp,{recursive:true,force:true});});
function fixture(){const p=store.createProject({name:'Preflight-'+(++serial)}).project,body=path.join(tmp,'body'+serial);fs.mkdirSync(body);const pf=path.join(p.dir,'PROJECT.md');fs.writeFileSync(pf,fs.readFileSync(pf,'utf8').replace('folders:\n','folders:\n  本体: '+JSON.stringify(body)+'\n'));fs.writeFileSync(path.join(body,'base.txt'),'base');g(body,'init','-q');g(body,'config','user.name','Fixture');g(body,'config','user.email','fixture@localhost');g(body,'add','.');g(body,'commit','-qm','base');const t=store.createTask(p.id,{title:'parent',steps:['remaining']}),w=git.prepare({base:body,workRoot:path.join(root,'Work',p.id),taskId:t.id});store.updateTask(p.id,t.id,{workdir:w.dir});fs.writeFileSync(path.join(w.dir,'saved.txt'),'saved');git.save(w.dir,'saved');return {p,t,body,w,b:{project:p.id,task:t.id}};}
const source=fs.readFileSync(path.join(__dirname,'../public/task-history.js'),'utf8');
const app=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
const actSource=app.slice(app.indexOf('async function act(el)'),app.indexOf("document.addEventListener('click',",app.indexOf('async function act(el)')));
function browser(b,request=api,storage=new Map()){
 const timers=[],button={dataset:{act:'merge',p:b.project,t:b.task},disabled:true,hidden:true,insertAdjacentHTML:(where,html)=>{region.html=String(html);}},region={html:'',get innerHTML(){return this.html;},set innerHTML(value){this.html=String(value);},remove(){this.html='';}},elements=new Map();
 const el=k=>{if(!elements.has(k))elements.set(k,{hidden:false,innerHTML:''});return elements.get(k);};
 const ctx=vm.createContext({$:el,UI:locale('ja'),esc:x=>String(x??''),view:{kind:'work',...b},api:request,document:{querySelector:s=>s==='[data-act="merge"]'?button:s==='[data-main-preview]'?region:null,addEventListener(){},body:{insertAdjacentHTML(){}},querySelectorAll:()=>[]},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},load:async()=>{},render(){},toast(){},setTimeout:f=>timers.push(f),clearTimeout(){},setInterval(){},confirm:()=>{throw Error('second confirmation forbidden');},observeRestart(){}});
 vm.runInContext(source,ctx);vm.runInContext(actSource,ctx);
 return {ctx,button,storage,region,run:s=>vm.runInContext(s,ctx),prepare:()=>ctx.prepareOneclickMain(b.project,b.task,button),click:()=>ctx.act(button),poll:async()=>{const f=timers.shift();if(f)await f();}};
}
const {MainMergeDelivery:D}=require('../lib/main-merge-delivery'),{MainMergeFlow:F}=require('../lib/main-merge-flow');
const ledger=new D(root,git,path.join(root,'_hub/log.jsonl'));
const scope=f=>({...f.b,sourceDir:f.w.dir,targetDir:f.body,source:git.inspect(f.w.dir),target:git.inspect(f.body)});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const settled=async(f,id)=>{for(let i=0;i<30;i++){const s=await api('/api/task/merge/status',{...f.b,flow:true,requestId:id});if(s.stage==='complete')return s;await sleep(100);}throw Error('flow did not settle');};
test('actual outer action: one click, no dialog, one retained merge and completed display',async()=>{
 const f=fixture(),a=browser(f.b);await a.prepare();assert.equal(a.button.disabled,false);assert.match(a.region.html,/作業・会話・コピー・下書き/);assert.match(a.region.html,/対象：/);const n=calls.length;
 await Promise.all([a.click(),a.click()]);assert.equal(calls.slice(n).filter(x=>x.route==='/api/task/merge').length,1);
 const id=a.run('oneclickPlans.values().next().value.flow.requestId');await settled(f,id);await a.poll();assert.match(a.region.html,/取り込みが完了/);
 assert.equal(store.readTask(store.taskFile(f.b.project,f.b.task)).workdir,f.w.dir);assert.equal(fs.readFileSync(path.join(f.body,'saved.txt'),'utf8'),'saved');
});
for(const mode of ['response-loss','navigate','reload','another-tab'])test('one approved identity survives '+mode+' with no second merge',async()=>{
 const f=fixture();let sends=0;const storage=new Map(),request=async(r,b)=>{if(r==='/api/task/merge'){sends++;const out=await api(r,b);if(mode==='response-loss')throw Error('lost response');return out;}return api(r,b);};
 const a=browser(f.b,request,storage),other=browser(f.b,request,storage);await a.prepare();if(mode==='another-tab')await other.prepare();await a.click();
 if(mode==='another-tab')await other.click();if(mode==='navigate')a.ctx.view.task='different';
 const marker=JSON.parse(storage.get('hub-main-delivery-'+JSON.stringify([f.b.project,f.b.task])));await settled(f,marker.requestId);
 const reloaded=browser(f.b,request,storage);await reloaded.prepare();await reloaded.click();assert.equal(sends,1);assert.match(reloaded.region.html,/取り込みが完了/);
 if(mode==='navigate'){const old=a.region.html;await a.poll();assert.equal(a.region.html,old);}
});
test('noChanges response loss has durable receipt before response and reconciles without Git',async()=>{
 const f=fixture();g(f.body,'merge','--no-ff','--no-edit',g(f.w.dir,'rev-parse','HEAD'));const before=g(f.body,'rev-parse','HEAD'),p=await api('/api/task/merge/preview',f.b),out=await api('/api/task/merge',{...f.b,token:p.token,oneclick:true});
 assert.equal(out.noChanges,true);assert.equal(ledger.read(p.token).state,'applied');assert.equal((await api('/api/task/merge/status',{...f.b,requestId:p.token})).state,'applied');await settled(f,p.token);assert.equal(g(f.body,'rev-parse','HEAD'),before);
});
for(const corrupt of [null,{},'state','id','scope','snapshot'])test('structurally damaged journal blocks and cannot be overwritten: '+JSON.stringify(corrupt),async()=>{
 const f=fixture(),id=require('node:crypto').randomUUID(),r=ledger.start(id,scope(f));let broken=corrupt;
 if(corrupt==='state')broken={...r,state:'future-unknown'};if(corrupt==='id')broken={...r,id:require('node:crypto').randomUUID()};if(corrupt==='scope')broken={...r,targetDir:'relative'};if(corrupt==='snapshot')broken={...r,target:{...r.target,head:'bad'}};
 const bytes=JSON.stringify(broken);fs.writeFileSync(ledger.file(id),bytes);
 try{assert.equal(ledger.unresolved(scope(f)),true);assert.throws(()=>ledger.start(id,scope(f)));assert.equal((await post('/api/task/merge/preview',f.b)).delivery.state,'unknown');assert.equal(fs.readFileSync(ledger.file(id),'utf8'),bytes);}finally{fs.unlinkSync(ledger.file(id));}
});
test('valid other-task pending record is scoped; missing receipt stays unknown',async()=>{
 const f=fixture(),other=fixture(),id=require('node:crypto').randomUUID();ledger.start(id,scope(other));assert.equal(ledger.unresolved(scope(f)),false);assert.ok((await api('/api/task/merge/preview',f.b)).token);assert.equal((await api('/api/task/merge/status',{...f.b,requestId:id})).state,'unknown');
});
for(const side of ['source','target'])test('changed '+side+' after displayed approval stops before delivery',async()=>{
 const f=fixture(),p=await api('/api/task/merge/preview',f.b),d=side==='source'?f.w.dir:f.body;g(d,'commit','--allow-empty','-qm','changed after display');const out=await post('/api/task/merge',{...f.b,token:p.token,oneclick:true});assert.equal(out.delivery.state,'not-sent');assert.equal(ledger.read(p.token),null);assert.equal(fs.existsSync(path.join(f.body,'saved.txt')),false);
});
test('late preview and changed storage marker cannot replace another task or send',async()=>{
 const f=fixture();let resolve;const a=browser(f.b,(r,b)=>r==='/api/task/merge/preview'?new Promise(ok=>resolve=ok):api(r,b));const p=a.prepare();while(!resolve)await sleep(1);const beforeNavigation=a.region.html;a.ctx.view.task='other';resolve({token:'late',sourceHead:'1'.repeat(40),targetHead:'2'.repeat(40)});await p;assert.equal(a.region.html,beforeNavigation);assert.doesNotMatch(a.region.html,/late/);
 const b=browser(f.b);await b.prepare();b.storage.set('hub-main-delivery-'+JSON.stringify([f.b.project,f.b.task]),JSON.stringify({requestId:require('node:crypto').randomUUID()}));const n=calls.length;await b.click();assert.equal(calls.slice(n).filter(x=>x.route==='/api/task/merge').length,0);
});
function flowFixture(){
 const f=fixture();fs.mkdirSync(path.join(f.w.dir,'hub'));fs.writeFileSync(path.join(f.w.dir,'hub/package.json'),'{"version":"9.0.0"}');git.save(f.w.dir,'version');const s=scope(f),id=require('node:crypto').randomUUID();const unitLedger=new D(path.join(tmp,'unit-'+serial),git,path.join(root,'_hub/log.jsonl'));unitLedger.start(id,{...s,flow:{keep:true,restart:true,version:'9.0.0',instance:'old',stage:'approved'}});
 g(f.body,'merge','--no-ff','--no-edit',s.source.head);const commit=g(f.body,'rev-parse','HEAD'),rt={instance:'old',version:'8.0.0',bootHead:s.target.head,targetDir:f.body},restart={calls:0,reserved:null,committed:false,error:'',status(){return {reserved:this.reserved,committed:this.committed,error:this.error,waiting:this.reserved?[{message:'other write'}]:[]};},request(){this.calls++;this.reserved={at:'now'};return this.status();},cancel(){this.reserved=null;}};
 let keeps=0;const flow=new F({ledger:unitLedger,git,runtime:()=>rt,restart:()=>restart,keep:()=>keeps++});return {f,s,id,commit,rt,restart,flow,ledger:unitLedger,keeps:()=>keeps};
}
test('crash after exact Git commit recovers receipt, reserves once, then verifies exact new boot',()=>{
 const x=flowFixture();x.flow.tick();assert.equal(x.ledger.read(x.id).commit,x.commit);assert.equal(x.restart.calls,1);assert.equal(x.flow.status(x.s,x.id).stage,'waiting');x.flow.tick();assert.equal(x.restart.calls,1);x.rt.instance='new';x.rt.bootHead=x.commit;x.rt.version='9.0.0';x.flow.tick();assert.equal(x.flow.status(x.s,x.id).stage,'complete');assert.equal(x.restart.calls,1);
});
for(const kind of ['wrong-head-same-version','wrong-version','target-change','dirty','restart-error'])test('switch verification stops without another merge or restart: '+kind,()=>{
 const x=flowFixture();x.flow.tick();if(kind==='wrong-head-same-version'){x.rt.instance='new';x.rt.version='9.0.0';x.restart.reserved=null;}if(kind==='wrong-version'){x.rt.instance='new';x.rt.bootHead=x.commit;x.restart.reserved=null;}if(kind==='target-change')g(x.f.body,'commit','--allow-empty','-qm','later');if(kind==='dirty')fs.writeFileSync(path.join(x.f.body,'dirty.txt'),'keep');if(kind==='restart-error')x.restart.error='handoff failed';x.flow.tick();assert.equal(x.ledger.read(x.id).flow.stage,'blocked');assert.equal(x.restart.calls,1);assert.equal(x.restart.reserved,null);
});
test('journal before Git crash stays unknown; restart guard rejects post-reservation HEAD change',()=>{
 const f=fixture(),id=require('node:crypto').randomUUID(),s=scope(f);ledger.start(id,{...s,flow:{keep:true,restart:true,version:'9.0.0',instance:'old',stage:'approved'}});let restarts=0;const flow=new F({ledger,git,runtime:()=>({instance:'old',targetDir:f.body}),restart:()=>({request(){restarts++;}}),keep:()=>{}});assert.equal(flow.status(s,id).stage,'unknown');assert.equal(restarts,0);
 const x=flowFixture();x.flow.tick();g(x.f.body,'commit','--allow-empty','-qm','changed immediately before restart');assert.throws(()=>x.flow.verifyRestart());
});
test('legacy uncertain is explicitly bound to shown latest abort and resolved in one outer click',async()=>{
 const f=fixture();fs.writeFileSync(path.join(f.body,'base.txt'),'main');git.save(f.body,'conflict main');fs.writeFileSync(path.join(f.w.dir,'base.txt'),'copy');git.save(f.w.dir,'conflict copy');const p=await api('/api/task/merge/preview',f.b);await post('/api/task/merge',{...f.b,token:p.token});
 fs.appendFileSync(path.join(root,'_hub/log.jsonl'),JSON.stringify({at:new Date().toISOString(),action:'merge',...f.b,ok:false,conflict:true})+'\n');try{g(f.w.dir,'merge','--no-edit',g(f.body,'rev-parse','HEAD'));}catch{}g(f.w.dir,'checkout','--theirs','base.txt');g(f.w.dir,'add','base.txt');g(f.w.dir,'commit','-qm','resolved copy');
 const storage=new Map([['hub-main-delivery-'+JSON.stringify([f.b.project,f.b.task]),'uncertain'],['unrelated','keep']]),a=browser(f.b,api,storage);await a.prepare();assert.match(a.region.html,/前回の衝突中止/);assert.equal(a.button.disabled,false);const n=calls.length;await a.click();const id=a.run('oneclickPlans.values().next().value.flow.requestId');await settled(f,id);await a.poll();assert.equal(calls.slice(n).filter(x=>x.route==='/api/task/merge').length,1);assert.equal(storage.get('unrelated'),'keep');
});
test('two independent no-op previews resolve to one delivery identity',async()=>{
 const f=fixture();g(f.body,'merge','--no-ff','--no-edit',g(f.w.dir,'rev-parse','HEAD'));const a=await api('/api/task/merge/preview',f.b),b=await api('/api/task/merge/preview',f.b);await api('/api/task/merge',{...f.b,token:a.token,oneclick:true});const second=await api('/api/task/merge',{...f.b,token:b.token,oneclick:true});assert.equal(second.requestId,b.token);assert.equal(ledger.read(b.token).alias,a.token);assert.equal(ledger.resolve(b.token).id,a.token);await settled(f,b.token);
});
test('no-op intent write failure stops before a success response',async()=>{
 const f=fixture();g(f.body,'merge','--no-ff','--no-edit',g(f.w.dir,'rev-parse','HEAD'));const p=await api('/api/task/merge/preview',f.b),original=D.prototype.start;D.prototype.start=()=>{throw Error('disk failure');};try{const out=await post('/api/task/merge',{...f.b,token:p.token,oneclick:true});assert.equal(out.delivery.state,'not-sent');assert.equal(ledger.read(p.token),null);}finally{D.prototype.start=original;}
});
test('true unknown and unavailable browser storage never send a second request',async()=>{
 const f=fixture(),storage=new Map([['hub-main-delivery-'+JSON.stringify([f.b.project,f.b.task]),JSON.stringify({requestId:require('node:crypto').randomUUID()})]]),a=browser(f.b,api,storage);await a.prepare();let n=calls.length;await a.click();assert.equal(calls.slice(n).filter(x=>x.route==='/api/task/merge').length,0);assert.equal(a.button.disabled,true);
 const b=browser(f.b);await b.prepare();b.ctx.localStorage.setItem=()=>{throw Error('storage unavailable');};n=calls.length;await b.click();assert.equal(calls.slice(n).filter(x=>x.route==='/api/task/merge').length,0);assert.match(b.region.html,/storage unavailable/);
});
test('existing restart controller waits for other writes, verifies once and executes once',()=>{
 const x=flowFixture(),{RestartControl}=require('../lib/restart-control');let busy=true,executions=0,verified=0;const control=new RestartControl({blockers:()=>busy?[{kind:'write'}]:[],verify:()=>{verified++;x.flow.verifyRestart();},execute:()=>executions++});x.flow.restart=()=>control;x.flow.tick();assert.ok(control.status().reserved);assert.equal(executions,0);x.flow.tick();busy=false;control.tick();control.tick();x.flow.tick();assert.equal(executions,1);assert.equal(verified,1);
});
test('failed restart verification cancels reservation and is not repeated',()=>{
 const x=flowFixture(),{RestartControl}=require('../lib/restart-control');let verified=0;const control=new RestartControl({blockers:()=>[],verify:()=>{verified++;throw Error('queue invalid');},execute:()=>assert.fail('must not restart')});x.flow.restart=()=>control;x.flow.tick();x.flow.tick();control.tick();assert.equal(verified,1);assert.equal(control.status().reserved,null);assert.equal(x.ledger.read(x.id).flow.stage,'blocked');
});
test('existing draft preservation survives restart reload; failed draft save postpones reload',()=>{
 const fragment=app.slice(app.indexOf('let restartWatch ='),app.indexOf('function adoptState('));let reloads=0;const storage=new Map(),maps=['queueDrafts','askDrafts','chatAttachments','quickDrafts','specialOverrides','freetalkSummaryDrafts','freetalkPromotionDrafts'];
 const ctx=vm.createContext({state:{hubInstance:'old',version:'8'},sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},location:{reload:()=>reloads++},rolesDirty:()=>false,toast(){},UI:locale('ja'),save(){},chatDraft:{conversation:'unsent'},rolesDraft:null,rolesDraftRevision:null,checkCreditsDraft:null,preferCreditsDraft:null,quickOverrides:new Set(['draft']),chatFileSequence:7,...Object.fromEntries(maps.map(n=>[n,new Map([[n,{text:'keep'}]])]))});vm.runInContext(fragment,ctx);ctx.observeRestart({hubInstance:'new',version:'9'});assert.equal(reloads,1);ctx.chatDraft={};for(const n of maps)ctx[n].clear();ctx.restoreRestartDrafts();assert.equal(ctx.chatDraft.conversation,'unsent');for(const n of maps)assert.equal(ctx[n].get(n).text,'keep');
 vm.runInContext('restartReloaded=false',ctx);ctx.sessionStorage.setItem=()=>{throw Error('disk');};assert.equal(ctx.reloadAfterRestart(),false);assert.equal(reloads,1);
});
test('a completed retained task can approve a new saved range with one new click',async()=>{
 const f=fixture(),a=browser(f.b);await a.prepare();await a.click();let id=a.run('oneclickPlans.values().next().value.flow.requestId');await settled(f,id);await a.poll();
 fs.writeFileSync(path.join(f.w.dir,'next.txt'),'next change');git.save(f.w.dir,'next saved range');const next=browser(f.b);await next.prepare();assert.equal(next.button.disabled,false);assert.doesNotMatch(next.region.html,/Cannot read/);const n=calls.length;await next.click();id=next.run('oneclickPlans.values().next().value.flow.requestId');await settled(f,id);await next.poll();assert.equal(calls.slice(n).filter(x=>x.route==='/api/task/merge').length,1);assert.equal(fs.readFileSync(path.join(f.body,'next.txt'),'utf8'),'next change');
});
test('app loadPreview binds the outer action to a formal displayed token',async()=>{
 const f=fixture(),a=browser(f.b);a.ctx.state={taskIntegrations:[],hubInstance:'fixture'};a.ctx.integrationMainEvidence=new Map();a.ctx.refreshKidsDoneBar=()=>{};vm.runInContext(app.slice(app.indexOf('let mainPreviewRequest ='),app.indexOf('// live=true：')),a.ctx);await a.ctx.loadPreview(f.b.project,f.b.task);assert.equal(a.button.disabled,false);assert.match(a.region.html,/対象：/);const plan=a.run('oneclickPlans.values().next().value.main');assert.equal(plan.sourceHead,g(f.w.dir,'rev-parse','HEAD'));await a.click();const id=a.run('oneclickPlans.values().next().value.flow.requestId');await settled(f,id);
});
for(const kind of ['applied-without-commit','invalid-complete-flow'])test('inconsistent completed record remains damaged: '+kind,()=>{
 const f=fixture(),id=require('node:crypto').randomUUID(),r=ledger.start(id,scope(f));const damaged=kind==='applied-without-commit'?{...r,state:'applied'}:{...r,flow:{keep:true,restart:true,version:'9.0.0',instance:'old',stage:'complete'}};fs.writeFileSync(ledger.file(id),JSON.stringify(damaged));try{assert.throws(()=>ledger.read(id));assert.equal(ledger.unresolved(scope(f)),true);}finally{fs.unlinkSync(ledger.file(id));}
});
test('historical completion cannot report applied after the main history was reset',()=>{
 const x=flowFixture();x.flow.tick();x.rt.instance='new';x.rt.bootHead=x.commit;x.rt.version='9.0.0';x.flow.tick();assert.equal(x.flow.status(x.s,x.id).stage,'complete');g(x.f.body,'reset','--hard',x.s.target.head);assert.equal(x.flow.status(x.s,x.id).stage,'unknown');
});
for(const booted of [true,false])test('N1 older included source approves actual target version and completes: booted='+booted,()=>{
 const f=fixture();fs.mkdirSync(path.join(f.w.dir,'hub'));fs.writeFileSync(path.join(f.w.dir,'hub/package.json'),'{"version":"8.0.0"}');git.save(f.w.dir,'old source');g(f.body,'merge','--no-ff','--no-edit',g(f.w.dir,'rev-parse','HEAD'));
 fs.writeFileSync(path.join(f.body,'hub/package.json'),'{"version":"9.0.0"}');git.save(f.body,'new main');const s=scope(f),rt={instance:'old',version:booted?'9.0.0':'8.0.0',bootHead:booted?s.target.head:s.source.head,targetDir:f.body};
 const journal=new D(path.join(tmp,'N1-'+serial),git,path.join(root,'_hub/log.jsonl'));let switches=0;const restart={status:()=>({reserved:true}),request:()=>{switches++;return {reserved:true};}};
 const flow=new F({ledger:journal,git,runtime:()=>rt,restart:()=>restart,keep:()=>{}}),plan=flow.approval(s);
 assert.equal(plan.alreadyIncluded,true);assert.equal(plan.switchVersion,'9.0.0');assert.equal(plan.switchHead,s.target.head);assert.equal(plan.switchNeeded,!booted);
 const preview=git.preview({dir:f.w.dir,workRoot:path.dirname(f.w.dir),target:f.body});assert.equal(Boolean(preview.noChanges),false);
 const a=browser(f.b);a.run('oneclickPlans.set(oneclickKey('+JSON.stringify(f.b.project)+','+JSON.stringify(f.b.task)+'),{})');a.ctx.drawOneclickMain(f.b.project,f.b.task,{main:{...plan,token:'shown',target:f.body,sourceHead:s.source.head,targetHead:s.target.head,files:preview.files}});
 assert.match(a.region.html,/Hub v9\.0\.0/);assert.doesNotMatch(a.region.html,/Hub v8\.0\.0/);assert.match(a.region.html,/反映済み/);assert.match(a.region.html,booted?/切替不要/:/への切替と起動確認/);
 const id=require('node:crypto').randomUUID();journal.start(id,{...s,flow:{keep:true,restart:plan.switchHub,version:plan.switchVersion,instance:'old',stage:'approved'}});
 const result=git.merge({dir:f.w.dir,workRoot:path.dirname(f.w.dir),target:f.body,title:'N1 already',cleanup:false,targetGuard:d=>git.inspect(d)});assert.equal(result.ok,true);assert.equal(result.already,true);assert.equal(result.commit,s.target.head);
 journal.finish(id,{state:'applied',commit:result.commit});flow.tick();assert.equal(switches,booted?0:1);
 if(!booted){assert.equal(flow.status(s,id).stage,'waiting');rt.instance='new';rt.bootHead=s.target.head;rt.version='9.0.0';flow.tick();}
 assert.equal(flow.status(s,id).stage,'complete');assert.equal(flow.blockers(f.body).length,0);assert.equal(g(f.body,'rev-parse','HEAD'),s.target.head);assert.equal(switches,booted?0:1);
});
test('N1 not-included source still approves source version and requires switching',()=>{
 // A separate divergent source, not a target's ancestor.
 const f=fixture();fs.mkdirSync(path.join(f.w.dir,'hub'));fs.writeFileSync(path.join(f.w.dir,'hub/package.json'),'{"version":"10.0.0"}');git.save(f.w.dir,'next source');
 const flow=new F({git,runtime:()=>({targetDir:f.body,bootHead:g(f.body,'rev-parse','HEAD'),version:'9.0.0'})}),p=flow.approval(scope(f));assert.equal(p.alreadyIncluded,false);assert.equal(p.switchVersion,'10.0.0');assert.equal(p.switchNeeded,true);assert.equal(p.switchHead,g(f.w.dir,'rev-parse','HEAD'));
});
test('N2 deduplicated response lost then reopened follows durable B without merge or restart resend',async()=>{
 const f=fixture();g(f.body,'merge','--no-ff','--no-edit',g(f.w.dir,'rev-parse','HEAD'));const first=browser(f.b),secondStorage=new Map();let sends=0,secondId;
 const request=async(r,b)=>{if(r==='/api/task/merge'){sends++;secondId=b.token;const out=await api(r,b);assert.equal(ledger.read(secondId).alias,out.flow?ledger.resolve(secondId).id:null);assert.equal(out.requestId,secondId);throw Error('dedup success response lost');}return api(r,b);};
 const second=browser(f.b,request,secondStorage);await first.prepare();await second.prepare();await first.click();const firstId=first.run('oneclickPlans.values().next().value.flow.requestId');await settled(f,firstId);const before=g(f.body,'rev-parse','HEAD');await second.click();
 assert.equal(ledger.read(secondId).alias,firstId);assert.equal(ledger.flows(scope(f)).length,1);assert.equal((await api('/api/task/merge/status',{...f.b,requestId:secondId})).state,'applied');
 const reloaded=browser(f.b,request,secondStorage);await reloaded.prepare();await reloaded.click();assert.match(reloaded.region.html,/取り込みが完了/);assert.equal(sends,1);assert.equal(secondStorage.has('hub-main-delivery-'+JSON.stringify([f.b.project,f.b.task])),false);assert.equal(g(f.body,'rev-parse','HEAD'),before);
});
test('N2 alias follows pending canonical flow across service reconstruction and switches once',()=>{
 const x=flowFixture(),b=require('node:crypto').randomUUID();x.ledger.link(b,x.s,x.id);assert.equal(x.ledger.read(b).flow,undefined);assert.equal(x.flow.records().length,1);x.flow.tick();assert.equal(x.flow.status(x.s,b).requestId,b);assert.equal(x.flow.status(x.s,b).stage,'waiting');assert.equal(x.restart.calls,1);
 const rebuilt=new F({ledger:new D(path.dirname(path.dirname(x.ledger.dir)),git,path.join(root,'_hub/log.jsonl')),git,runtime:()=>x.rt,restart:()=>x.restart,keep:()=>{}});rebuilt.tick();assert.equal(x.restart.calls,1);x.rt.instance='new';x.rt.bootHead=x.commit;x.rt.version='9.0.0';rebuilt.tick();assert.equal(rebuilt.status(x.s,b).stage,'complete');assert.equal(x.restart.calls,1);
 assert.equal(rebuilt.status({...x.s,task:'other'},b).stage,'unknown');assert.equal(x.ledger.status({...x.s,task:'other',id:b}).state,'unknown');
});
for(const broken of ['missing','other-task','snapshot','chain','cycle','array'])test('N2 damaged alias refuses without overwriting evidence: '+broken,()=>{
 const x=flowFixture(),b=require('node:crypto').randomUUID();x.ledger.link(b,x.s,x.id);const a=x.ledger.file(x.id),file=x.ledger.file(b),original=fs.readFileSync(a,'utf8');let r=x.ledger.read(b);
 if(broken==='missing')fs.unlinkSync(a);if(broken==='other-task')r.task='other';if(broken==='snapshot')r.source={...r.source,head:'f'.repeat(40)};
 if(broken==='chain'||broken==='cycle'){const c=require('node:crypto').randomUUID();fs.writeFileSync(x.ledger.file(c),JSON.stringify({...r,id:c,alias:broken==='cycle'?b:x.id}));r.alias=c;}
 if(broken==='array')r.alias=[x.id];fs.writeFileSync(file,JSON.stringify(r));const bytes=fs.readFileSync(file,'utf8');assert.throws(()=>x.ledger.read(b));assert.equal(x.ledger.status({...x.s,id:b}).state,'unknown');assert.equal(x.flow.status(x.s,b).stage,'unknown');assert.equal(x.ledger.unresolved(x.s),true);assert.throws(()=>x.ledger.start(b,x.s));assert.equal(fs.readFileSync(file,'utf8'),bytes);if(broken==='missing')fs.writeFileSync(a,original);
});
test('N2 alias link failure never acknowledges success or creates a second flow',async()=>{
 const f=fixture();g(f.body,'merge','--no-ff','--no-edit',g(f.w.dir,'rev-parse','HEAD'));const a=await api('/api/task/merge/preview',f.b),b=await api('/api/task/merge/preview',f.b);await api('/api/task/merge',{...f.b,token:a.token,oneclick:true});await settled(f,a.token);const original=D.prototype.link,before=g(f.body,'rev-parse','HEAD');D.prototype.link=()=>{throw Error('disk failure');};
 try{const out=await post('/api/task/merge',{...f.b,token:b.token,oneclick:true});assert.equal(out.status,409);assert.equal(out.delivery.state,'unknown');assert.equal(ledger.read(b.token),null);assert.equal(ledger.flows(scope(f)).length,1);assert.equal(g(f.body,'rev-parse','HEAD'),before);}finally{D.prototype.link=original;}
});
test('N1 formal HTTP preview binds target version before already-success and exact boot completion',async()=>{
 const f=fixture();fs.mkdirSync(path.join(f.w.dir,'hub'));fs.writeFileSync(path.join(f.w.dir,'hub/package.json'),'{"version":"8.0.0"}');git.save(f.w.dir,'old included');g(f.body,'merge','--no-ff','--no-edit',g(f.w.dir,'rev-parse','HEAD'));fs.writeFileSync(path.join(f.body,'hub/package.json'),'{"version":"9.0.0"}');git.save(f.body,'new target');const before=g(f.body,'rev-parse','HEAD'),original=F.prototype.approval;let service,originalRuntime;
 // Only this isolated server's Hub runtime identity is a fixture; preview, token, Git, journal and UI are real.
 F.prototype.approval=function(s){service=this;originalRuntime=this.runtime;const rt=originalRuntime();this.runtime=()=>({...rt,targetDir:f.body,bootHead:before,version:'9.0.0'});return original.call(this,s);};
 try{const a=browser(f.b);await a.prepare();const p=a.run('oneclickPlans.values().next().value.main');assert.equal(p.noChanges,false);assert.equal(p.alreadyIncluded,true);assert.equal(p.switchVersion,'9.0.0');assert.equal(p.switchNeeded,false);assert.match(a.region.html,/切替不要/);assert.match(a.region.html,/Hub v9\.0\.0/);const n=calls.length;await a.click();const id=a.run('oneclickPlans.values().next().value.flow.requestId');await settled(f,id);await a.poll();assert.match(a.region.html,/起動確認が完了/);assert.equal(ledger.read(id).commit,before);assert.equal(ledger.read(id).flow.sentInstance,undefined);assert.equal(g(f.body,'rev-parse','HEAD'),before);assert.equal(calls.slice(n).filter(x=>x.route==='/api/task/merge').length,1);assert.equal(calls.slice(n).filter(x=>x.route==='/api/restart').length,0);}finally{F.prototype.approval=original;if(service)service.runtime=originalRuntime;}
});
test('N2 alias refuses mismatched approval and cannot overwrite existing identities',()=>{
 const x=flowFixture(),id=require('node:crypto').randomUUID();assert.throws(()=>x.ledger.link(id,{...x.s,task:'other'},x.id));assert.equal(x.ledger.read(id),null);assert.throws(()=>x.ledger.link(id,{...x.s,target:{...x.s.target,content:'0'.repeat(64)}},x.id));assert.equal(x.ledger.read(id),null);x.ledger.link(id,x.s,x.id);const bytes=fs.readFileSync(x.ledger.file(id),'utf8');assert.throws(()=>x.ledger.link(id,x.s,x.id));assert.throws(()=>x.ledger.link(require('node:crypto').randomUUID(),x.s,id));assert.equal(fs.readFileSync(x.ledger.file(id),'utf8'),bytes);
});
