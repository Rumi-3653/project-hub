'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process'),{createHash,randomUUID}=require('node:crypto');
const tmp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-review-supplement-http-')),root=path.join(tmp,'root'),home=path.join(tmp,'home'),bin=path.join(tmp,'bin'),trace=path.join(tmp,'reviews.jsonl');
for(const d of [home,bin,path.join(root,'_hub')])fs.mkdirSync(d,{recursive:true});fs.copyFileSync(path.join(__dirname,'../../docs/project-hub/templates/_hub/roles.yaml'),path.join(root,'_hub/roles.yaml'));
// This executable is a local fixture. It checks supplied material and emits a
// fresh session; it cannot contact an AI provider or certify a real product.
for(const ai of ['codex','claude'])fs.writeFileSync(path.join(bin,ai),'#!'+process.execPath+'\n'+`
const fs=require('node:fs'),{randomUUID}=require('node:crypto');let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>{
 const k=s.match(/\\[integration-auto:([a-f0-9]{64}):review\\]/)?.[1],file=s.match(/保存差分原物：(.+?)（SHA256 /)?.[1],e=file&&fs.readFileSync(file,'utf8'),session=randomUUID();
 fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({key:k,file,session,args:process.argv,hasResults:e?.includes('## saved-results'),hasTest:e?.includes('# pass 1'),hasCommit:e?.includes('saved behavior'),hasOriginal:e?.includes('## original'),receiptOnly:s.includes('旧不合格の指摘をすべて照合'),hasRefusal:e?.includes('旧資料では成果を照合できない'),hasPending:e?.includes('実装の独立確認・公開は未済')})+'\\n');
 const text=k&&e?.includes('## saved-results')&&e.includes('# pass 1')&&e.includes('saved behavior')?'[integration-review:'+k+':pass]':'判定：要修正（確認資料不足）。\\n指定Git範囲も同一HEAD間で差分ゼロ';
 if(${JSON.stringify(ai)}==='codex'){console.log(JSON.stringify({type:'thread.started',thread_id:session}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));console.log(JSON.stringify({type:'turn.completed'}));}
 else{console.log(JSON.stringify({type:'system',subtype:'init',session_id:session}));console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text}]}}));console.log(JSON.stringify({type:'result',is_error:false,result:'',session_id:session}));}
});`,{mode:0o755});
Object.assign(process.env,{HUB_ROOT:root,HOME:home,HUB_AI_HOME:home,HUB_FREETALK_HOME:home,HUB_DRY_RUN:'1',HUB_TRASH:path.join(tmp,'Trash'),HUB_PORT:'0',PATH:bin+':/usr/bin:/bin'});
// Optional original-code run uses exactly this final fixture/input.
if(process.env.HUB_REVIEW_BASELINE){const Module=require('node:module');for(const name of ['integrate-auto','integration-review']){const filename=require.resolve('../lib/'+name),m=new Module(filename,module);m.filename=filename;m.paths=module.paths;m._compile(fs.readFileSync(path.join(process.env.HUB_REVIEW_BASELINE,name+'.js'),'utf8'),filename);require.cache[filename]=m;}}
const {IntegrateAuto}=require('../lib/integrate-auto'),tick=IntegrateAuto.prototype.tick;IntegrateAuto.prototype.tick=async()=>{};
const chat=require('../lib/chat'),review=require('../lib/integration-review'),results=require('../lib/integration-review-results');let runtime=require('../server'),base,serial=0;
const g=(dir,...a)=>execFileSync('git',['-C',dir,...a],{encoding:'utf8',stdio:'pipe'}).trim();
const post=async(route,b)=>{const x=await fetch(base+route,{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json',Connection:'close'},body:JSON.stringify(b)});return {status:x.status,out:await x.json()};};
test.before(async()=>{await new Promise(r=>runtime.server.listen(0,'127.0.0.1',r));const port=runtime.server.address().port;await new Promise(r=>runtime.server.close(r));process.env.HUB_PORT=String(port);require.cache[require.resolve('../server')]?.exports.stopControl.cleanExit();delete require.cache[require.resolve('../server')];runtime=require('../server');await new Promise(r=>runtime.server.listen(port,'127.0.0.1',r));base='http://127.0.0.1:'+port;});
test.after(async()=>{runtime.server.closeAllConnections();await new Promise(r=>runtime.server.close(r));IntegrateAuto.prototype.tick=tick;fs.rmSync(tmp,{recursive:true,force:true});});
const hash=x=>createHash('sha256').update(x).digest('hex');
async function fixture(){
 const store=runtime.taskIntegrate.store,p=store.createProject({name:'Artifact-review-'+(++serial)}).project,parent=store.createTask(p.id,{title:'親',steps:['親の未済']}),child=store.createTask(p.id,{title:'デザイン',parent:parent.id,steps:['実装の独立確認・公開は未済'],workspaceMode:'direct'}),dir=path.join(tmp,'body-'+serial),product=path.join(dir,'product');
 fs.mkdirSync(product,{recursive:true});const pf=path.join(p.dir,'PROJECT.md');fs.writeFileSync(pf,fs.readFileSync(pf,'utf8').replace('folders:\n','folders:\n  本体: '+JSON.stringify(dir)+'\n'));
 for(const d of [dir,product]){g(d,'init','-q');g(d,'config','user.name','Fixture');g(d,'config','user.email','fixture@localhost');}
 fs.writeFileSync(path.join(dir,'.gitignore'),'product/\n');g(dir,'add','.');g(dir,'commit','-qm','outer body');
 fs.writeFileSync(path.join(product,'page.css'),'base behavior\n');g(product,'add','.');g(product,'commit','-qm','base');const baseHead=g(product,'rev-parse','HEAD');
 fs.writeFileSync(path.join(product,'page.css'),'saved behavior, not applied\n');g(product,'commit','-qam','retained design');const saved=g(product,'rev-parse','HEAD');g(product,'checkout','-q',baseHead);
 const artifacts=['design/page.html','design/screen.png','design/tests.log'];fs.mkdirSync(path.join(p.dir,'design'));fs.writeFileSync(path.join(p.dir,artifacts[0]),'<html>design</html>\n');fs.writeFileSync(path.join(p.dir,artifacts[1]),Buffer.from([137,80,78,71,0,1,2]));fs.writeFileSync(path.join(p.dir,artifacts[2]),'test saved behavior\n# pass 1\n# fail 0\n');
 store.appendSection(p.id,child.id,'成果',artifacts.map(f=>'- ファイル：project:'+f).join('\n'));store.appendSection(p.id,child.id,'残件申告','```json\n'+JSON.stringify({status:'あり',items:'実装の独立確認・公開は未済',undecided:'本体反映は本人承認後',evidence:'design/tests.log'})+'\n```');
 const common={project:p.id,task:parent.id},d=await post('/api/task/integrate/preview',{...common,simple:true});assert.equal(d.status,200,JSON.stringify(d.out));assert.equal((await post('/api/task/integrate',{...common,token:d.out.token,confirm:true,auto:true,thenMain:false,mode:'single',selected:[{project:p.id,task:child.id,keep:false}]})).status,200);
 const read=()=>runtime.taskIntegrate.read(p.id,parent.id);let r=read();r.auto.order={state:'done',fixturePreviouslyDone:true};runtime.taskIntegrate.save(r);assert.equal(await runtime.taskIntegrate.simple.prepare(runtime.integrateAuto,r),true);runtime.taskIntegrate.run(r);r=read();assert.equal(r.items[0].state,'検証待ち');
 const i=r.items[0],head=g(dir,'rev-parse','HEAD'),k=hash(r.id+'\0legacy-empty'),request=randomUUID(),old=review.prepare({dir,pdir:p.dir,task:parent.id,key:k,targetHead:head,reviewHead:head}),a={project:p.id,task:child.id,phase:'review',targetHead:head,reviewHead:head,isolatedReview:true,delivery:{state:'accepted',request},request:{project:p.id,task:parent.id,text:'old empty request'}};
 const row={role:'assistant',request,text:'# 判定：要修正（合格ではありません）\n旧資料では成果を照合できない。残す案内と選択の差異も要確認。',integrationAuto:{key:k,phase:'review',closed:true,isolation:{version:1,resumed:false,request,session:'old-session'}}};chat.append(p.dir,parent.id,row);r.auto.attempts[k]=a;r.items[0].state='検証中';r.auto.stopped={reason:'独立確認の合格を確認できません',at:new Date().toISOString()};runtime.taskIntegrate.save(r);
 const files=artifacts.map(f=>{const data=fs.readFileSync(path.join(p.dir,f)),st=fs.statSync(path.join(p.dir,f));return {path:f,bytes:data.length,mode:'0o'+(st.mode&0o777).toString(8),sha256:hash(data)};}),log=files[2],rel='.ai/work/'+parent.id+'-design/supplement.json',file=path.join(p.dir,rel);
 const s={version:1,old_review:{path:path.relative(p.dir,old.file),sha256:old.sha256},integration:{id:r.id,keep_at_start:false},child:{task:path.relative(p.dir,store.taskFile(p.id,child.id)),sha256:i.taskHash,count:files.length,total_bytes:files.reduce((n,f)=>n+f.bytes,0),files,retained_code:[{repository:'body:product',commit:saved,path:'page.css',bytes:Buffer.byteLength('saved behavior, not applied\n'),sha256:hash('saved behavior, not applied\n'),base_sha256:hash('base behavior\n')}]},repositories:{base:baseHead},resolution:{remaining:['実装の独立確認・公開は未済']},history:{design:saved},saved_test_originals:{log:{path:log.path,sha256:log.sha256,text:fs.readFileSync(path.join(p.dir,log.path),'utf8')}}};
 fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(s,null,2));const spec=()=>({attempt:k,file:rel,sha256:hash(fs.readFileSync(file))});
 return {p,parent,child,dir,product,store,common,read,k,row,old,file,s,spec,artifacts,head,baseHead,saved};
}
const preview=f=>post('/api/task/integrate/preview',{...f.common,simple:true,reviewSupplement:f.spec()});
const resume=(f,d,extra={})=>post('/api/task/integrate/resume',{...f.common,token:d.out.token,confirm:true,...extra});
function attempt(f){const r=f.read(),k=r.auto.attempts[f.k].supersededBy;return {r,k,a:r.auto.attempts[k]};}
test('成果ファイルのみ：明示補完→新規隔離確認→正式受領、旧資料とkeep=false/未済/未反映を保持',async()=>{
 const f=await fixture(),original=fs.readFileSync(f.old.file),stopped=fs.readFileSync(runtime.taskIntegrate.file(f.p.id,f.parent.id));
 const noSupplement=await post('/api/task/integrate/preview',{...f.common,simple:true});assert.equal(noSupplement.out.resumeAllowed,false);
 const d=await preview(f);assert.equal(d.out.resumeAllowed,true,JSON.stringify(d.out));assert.ok(d.out.token);assert.deepEqual(fs.readFileSync(runtime.taskIntegrate.file(f.p.id,f.parent.id)),stopped);
 assert.equal((await resume(f,d)).status,200);let {r,k,a}=attempt(f);assert.notEqual(k,f.k);assert.equal(a.savedResults.version,3);assert.equal(a.phase,'needs-review');assert.equal(r.items[0].keep,false);assert.equal(runtime.taskIntegrate.transfer.read(f.p.id,f.child.id)?.complete,undefined);
 assert.equal((await resume(f,d)).status,409);for(let n=0;n<120&&!f.read().complete&&!f.read().auto.stopped;n++){await tick.call(runtime.integrateAuto);await new Promise(r=>setTimeout(r,25));}
 r=f.read();assert.equal(r.auto.stopped,undefined,JSON.stringify(r.auto.stopped));assert.equal(r.complete,true);assert.equal(r.auto.attempts[k].phase,'verified');assert.equal(r.items[0].keep,false);assert.equal(r.auto.main.skipped,true);assert.equal(runtime.taskIntegrate.transfer.read(f.p.id,f.child.id).complete,true);assert.equal(Boolean(f.store.taskFile(f.p.id,f.child.id)),false);assert.match(fs.readFileSync(f.store.taskFile(f.p.id,f.parent.id),'utf8'),/実装の独立確認・公開は未済/);assert.deepEqual(fs.readFileSync(f.old.file),original);
 assert.equal(g(f.dir,'rev-parse','HEAD'),f.head);assert.equal(g(f.product,'rev-parse','HEAD'),f.baseHead);assert.equal(g(f.product,'merge-base','--is-ancestor',f.baseHead,f.saved),'');
 const rows=fs.readFileSync(trace,'utf8').trim().split('\n').map(JSON.parse).filter(x=>x.key===k);assert.equal(rows.length,1);assert.ok(rows[0].hasResults&&rows[0].hasTest&&rows[0].hasCommit&&rows[0].hasOriginal&&rows[0].hasRefusal&&rows[0].hasPending&&rows[0].receiptOnly);assert.notEqual(rows[0].session,'old-session');assert.ok(!rows[0].args.includes('--resume'));assert.equal((await preview(f)).out.resumeAllowed,undefined);
});
for(const mode of ['unknown','open','wrong-request','keep','old','artifact','test','commit','wrong-attempt','outside','duplicate','ordinary-pass'])test('補完は不足/変更/通常合格/不明受付を代用しない：'+mode,async()=>{
 const f=await fixture(),r=f.read();
 if(['open','wrong-request','ordinary-pass'].includes(mode)){const row=structuredClone(f.row);if(mode==='open')row.integrationAuto.closed=false;else if(mode==='wrong-request')row.integrationAuto.isolation.request='other';else row.text='pass_artifact_receipt_only\n[integration-review:'+f.k+':pass]';chat.append(f.p.dir,f.parent.id,row);}
 else if(mode==='unknown'){r.auto.attempts[f.k].delivery.state='unknown';runtime.taskIntegrate.save(r);}
 else if(mode==='old')fs.appendFileSync(f.old.file,'changed');
 else if(mode==='artifact')fs.appendFileSync(path.join(f.p.dir,f.artifacts[0]),'changed');
 else if(mode==='test')fs.appendFileSync(path.join(f.p.dir,f.artifacts[2]),'changed');
 else {if(mode==='keep')f.s.integration.keep_at_start=true;else if(mode==='commit')f.s.child.retained_code[0].sha256='0'.repeat(64);else if(mode==='duplicate')f.s.child.files[1]=f.s.child.files[0];fs.writeFileSync(f.file,JSON.stringify(f.s));}
 const spec=f.spec();if(mode==='wrong-attempt')spec.attempt='f'.repeat(64);if(mode==='outside')spec.file='.ai/work/'+f.parent.id+'-design/../../secret.json';
 const before=fs.readFileSync(runtime.taskIntegrate.file(f.p.id,f.parent.id)),d=await post('/api/task/integrate/preview',{...f.common,simple:true,reviewSupplement:spec});assert.equal(d.out.resumeAllowed,false,JSON.stringify(d.out));assert.equal(d.out.token,undefined);assert.equal((await resume(f,d)).status,409);assert.deepEqual(fs.readFileSync(runtime.taskIntegrate.file(f.p.id,f.parent.id)),before);assert.equal(runtime.taskIntegrate.transfer.read(f.p.id,f.child.id)?.complete,undefined);
});
for(const stage of ['preview','dispatch','completion','receipt'])test('補完後の資料変更は'+stage+'で拒否し正式受領しない',async()=>{
 const f=await fixture(),d=await preview(f);assert.equal(d.out.resumeAllowed,true,JSON.stringify(d.out));
 if(stage==='preview'){fs.appendFileSync(f.file,' ');assert.equal((await resume(f,d)).status,409);assert.equal(f.read().auto.attempts[f.k].phase,'review');return;}
 assert.equal((await resume(f,d)).status,200);const {r,k,a}=attempt(f);
 if(stage!=='dispatch'){a.phase=stage==='receipt'?'verified':'review';a.delivery={state:'accepted',request:'new-request'};runtime.taskIntegrate.save(r);}
 fs.appendFileSync(path.join(f.p.dir,f.artifacts[2]),'changed after preview');
 if(stage==='completion')runtime.integrateAuto.settled({...f.common,text:'[integration-auto:'+k+':review]'},{text:'[integration-review:'+k+':pass]',integrationAuto:{key:k,phase:'review',closed:true,isolation:{version:1,resumed:false,request:'new-request',session:'fresh-session'}}});else await tick.call(runtime.integrateAuto);
 assert.ok(f.read().auto.stopped);assert.equal(runtime.taskIntegrate.transfer.read(f.p.id,f.child.id)?.complete,undefined);if(stage==='dispatch')assert.equal(f.read().auto.attempts[k].delivery,undefined);
});
for(const mode of ['ordinary-pass','old-key','old-session','wrong-request','no-session','open','refusal','old-row-changed','old-request-changed'])test('新資料に結び付かない合格は拒否：'+mode,async()=>{
 const f=await fixture(),d=await preview(f);assert.equal((await resume(f,d)).status,200,JSON.stringify(d.out));const {r,k,a}=attempt(f);a.phase='review';a.delivery={state:'accepted',request:'new-request'};
 if(mode==='old-request-changed')r.auto.attempts[f.k].request.text+=' changed';runtime.taskIntegrate.save(r);
 if(mode==='old-row-changed'){const row=structuredClone(f.row);row.text+=' changed';chat.append(f.p.dir,f.parent.id,row);}
 const row={text:mode==='ordinary-pass'?'pass_artifact_receipt_only':mode==='refusal'?'要修正':'[integration-review:'+(mode==='old-key'?f.k:k)+':pass]',integrationAuto:{key:k,phase:'review',closed:mode!=='open',isolation:{version:1,resumed:false,request:mode==='wrong-request'?'other':'new-request',session:mode==='old-session'?'old-session':mode==='no-session'?undefined:'fresh-session'}}};
 runtime.integrateAuto.settled({...f.common,text:'[integration-auto:'+k+':review]'},row);assert.ok(f.read().auto.stopped);assert.equal(f.read().auto.attempts[k].phase,'review');assert.equal(runtime.taskIntegrate.transfer.read(f.p.id,f.child.id)?.complete,undefined);
});
