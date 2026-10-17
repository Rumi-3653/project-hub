'use strict';
// Reuse the isolated HTTP/Git fixture and mock executables, not its test cases.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const file=require.resolve('./integration-assignment-http.test'),source=fs.readFileSync(file,'utf8'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));
m._compile(source.slice(0,source.indexOf("test('担当固定 正式HTTP Astra"))+ '\nmodule.exports={h,rt,assignments,launches,begin,finish,tick};',file);
const {h,rt,assignments,launches,begin,finish,tick}=m.exports,git=require('../lib/git');
function fixture(){
 const f=h.fixture('実行中'),store=rt().taskIntegrate.store,body=path.join(h.tmp,'question-body-'+f.p.id),work=path.join(h.root,'Work',f.p.id);
 fs.mkdirSync(body);h.g(body,'init','-q');h.g(body,'config','user.name','Fixture');h.g(body,'config','user.email','fixture@localhost');fs.writeFileSync(path.join(body,'base'),'base');h.g(body,'add','base');h.g(body,'commit','-qm','base');
 const pf=path.join(f.p.dir,'PROJECT.md');fs.writeFileSync(pf,fs.readFileSync(pf,'utf8').replace('folders:\n','folders:\n  本体: '+JSON.stringify(body)+'\n'));
 const pw=git.prepare({base:body,workRoot:work,taskId:f.parent.id}),cw=git.prepare({base:body,workRoot:work,taskId:f.c.id});
 for(const [t,w]of [[f.parent,pw],[f.c,cw]])store.updateTask(f.p.id,t.id,{workdir:w.dir,workspaceMode:'isolated'});
 fs.writeFileSync(path.join(cw.dir,'report.md'),'saved additional report');h.g(cw.dir,'add','report.md');h.g(cw.dir,'commit','-qm','report');
 store.updateTask(f.p.id,f.c.id,{state:'返事待ち',question:'画面の選択を確認したい'});
 store.appendSection(f.p.id,f.c.id,'残件申告','```json\n'+JSON.stringify({status:'あり',items:'画面確認',undecided:'本人の選択',evidence:'保存報告書 report.md'})+'\n```');
 return {...f,store,body,pw,cw,child:{project:f.p.id,task:f.c.id},tf:store.taskFile(f.p.id,f.c.id)};
}
async function offer(f){const d=await h.post('/api/task/handup/preview',f.child);assert.equal(d.status,200,JSON.stringify(d));assert.equal(d.out.partial,true);assert.equal((await h.post('/api/task/handup',{...f.child,token:d.out.token,confirm:true,selected:d.out.files.map(x=>x.id)})).status,200);return d;}
const preview=f=>h.post('/api/task/integrate/preview',{...f.common,simple:true,assignments});
const start=(f,d,keep=true)=>h.post('/api/task/integrate',{...f.common,token:d.out.token,confirm:true,auto:true,thenMain:false,mode:'single',assignments,selected:[{...f.child,keep}]});
const receipt=f=>rt().taskIntegrate.transfer.read(f.p.id,f.c.id)?.received?.length||0;
const snapshot=f=>({task:fs.readFileSync(f.tf,'utf8'),chat:fs.readFileSync(h.chat.files(f.p.dir,f.c.id).log,'utf8'),head:h.g(f.cw.dir,'rev-parse','HEAD'),main:h.g(f.body,'rev-parse','HEAD')});
test('質問partial 正式HTTP 固定offer→cold Opus隔離→保持受領・子の質問/状態/会話/HEAD不変',async()=>{
 const f=fixture(),before=snapshot(f),n=launches().length;await offer(f);const d=await preview(f);assert.equal(d.out.items[0].startable,true,JSON.stringify(d));assert.equal((await start(f,d)).status,200);assert.equal((await start(f,d)).status,409);await h.cold();await finish(f);
 assert.deepEqual(snapshot(f),before);assert.equal(receipt(f),1);assert.ok(git.isAncestor(f.pw.dir,before.head));
 const rows=launches().slice(n);assert.equal(rows.length,1);assert.ok(rows[0].args.includes('claude-opus-5-5'));assert.ok(!rows[0].args.includes('--resume'));
 const attempts=Object.values(f.r().auto.attempts);assert.equal(attempts.filter(a=>a.organizeSkipped==='partial-question').length,1);assert.ok(attempts.some(a=>a.isolatedReview&&a.phase==='verified'));
 assert.equal((await preview(f)).out.resume,undefined);assert.equal((await h.post('/api/task/handup/preview',f.child)).out.blockers.length>0,true);
});
for(const mode of ['no-offer','cleanup','head','report','remaining','question','answered','busy','queue','expired','unknown-remaining','missing-results'])test('質問partial 開始前拒否/副作用0 '+mode,async()=>{
 const f=fixture(),n=launches().length;
 if(mode==='unknown-remaining')fs.writeFileSync(f.tf,fs.readFileSync(f.tf,'utf8').replace('## 残件申告','## メモの残件'));
 if(mode==='missing-results')fs.writeFileSync(f.tf,fs.readFileSync(f.tf,'utf8').replace('- なし：隔離試験',''));
 if(mode!=='no-offer')await offer(f);const d=await preview(f),beforeHead=h.g(f.pw.dir,'rev-parse','HEAD');
 if(mode==='head'){fs.writeFileSync(path.join(f.cw.dir,'next'),'next');h.g(f.cw.dir,'add','next');h.g(f.cw.dir,'commit','-qm','next');}
 if(mode==='report')fs.writeFileSync(path.join(f.cw.dir,'report.md'),'changed');
 if(mode==='remaining')f.store.appendSection(f.p.id,f.c.id,'残件申告','changed');
 if(mode==='question'||mode==='answered')f.store.updateTask(f.p.id,f.c.id,{question:mode==='answered'?'':'別の質問'});
 const removal=rt().taskIntegrate.removal,busy=removal.busy;
 if(mode==='busy')removal.busy=(p,t)=>p===f.p.id&&t===f.c.id||busy(p,t);
 if(mode==='queue')rt().chats.enqueue(f.p.id,f.c.id,{ai:'codex',model:'GPT-6-Astra',text:'waiting'});
 if(mode==='expired')rt().taskIntegrate.tokens.get(d.out.token).at-=600001;
 const saved=snapshot(f);try{const out=await start(f,d,mode!=='cleanup');assert.equal(out.status,409,JSON.stringify(out));assert.equal(f.r(),null);assert.deepEqual(snapshot(f),saved);assert.equal(h.g(f.pw.dir,'rev-parse','HEAD'),beforeHead);assert.equal(receipt(f),0);assert.equal(launches().length,n);}finally{removal.busy=busy;if(mode==='queue')rt().chats.setQueue(f.p.id,f.c.id,[],true);}
});
for(const mode of ['question','answered','head','remaining','queue'])test('質問partial 開始後/正式確認前の変更拒否 '+mode,async()=>{
 const f=fixture(),n=launches().length;await offer(f);assert.equal((await start(f,await preview(f))).status,200);
 if(mode==='question'||mode==='answered')f.store.updateTask(f.p.id,f.c.id,{question:mode==='answered'?'':'変更'});
 if(mode==='head'){fs.writeFileSync(path.join(f.cw.dir,'next'),'next');h.g(f.cw.dir,'add','next');h.g(f.cw.dir,'commit','-qm','next');}
 if(mode==='remaining')f.store.appendSection(f.p.id,f.c.id,'残件申告','changed');
 if(mode==='queue')rt().chats.enqueue(f.p.id,f.c.id,{ai:'codex',model:'GPT-6-Astra',text:'waiting'});
 const before=snapshot(f);try{await tick(f);assert.equal(receipt(f),0);assert.equal(launches().length,n);assert.deepEqual(snapshot(f),before);if(mode!=='queue')assert.ok(f.r().auto.stopped);}finally{if(mode==='queue')rt().chats.setQueue(f.p.id,f.c.id,[],true);}
});

for(const mode of ['question','answered','head'])test('質問partial 正式確認合格後/受領直前の変更拒否 '+mode,async()=>{
 const f=fixture();await offer(f);assert.equal((await start(f,await preview(f))).status,200);
 await tick(f);await h.wait(()=>!rt().chats.busy(f.p.id,f.parent.id));
 assert.ok(Object.values(f.r().auto.attempts).some(a=>a.phase==='verified'&&a.isolatedReview));assert.equal(receipt(f),0);
 if(mode==='head'){fs.writeFileSync(path.join(f.cw.dir,'next'),'next');h.g(f.cw.dir,'add','next');h.g(f.cw.dir,'commit','-qm','next');}
 else f.store.updateTask(f.p.id,f.c.id,{question:mode==='answered'?'':'確認後に変わった質問'});
 const before=snapshot(f),n=launches().length;await tick(f);assert.ok(f.r().auto.stopped);assert.equal(receipt(f),0);assert.equal(launches().length,n);assert.deepEqual(snapshot(f),before);
});
test('質問partial offer確認後の質問変更拒否・正常offer token一回',async()=>{
 const f=fixture(),d=await h.post('/api/task/handup/preview',f.child);f.store.updateTask(f.p.id,f.c.id,{question:'確認後変更'});
 const b={...f.child,token:d.out.token,confirm:true,selected:[]};assert.equal((await h.post('/api/task/handup',b)).status,409);assert.equal(rt().taskIntegrate.transfer.read(f.p.id,f.c.id),null);
 const q=await offer(f),saved=JSON.stringify(rt().taskIntegrate.transfer.read(f.p.id,f.c.id)),again=await h.post('/api/task/handup',{...b,token:q.out.token});
 assert.equal(again.status,200);assert.equal(again.out.ok,true);assert.equal(JSON.stringify(rt().taskIntegrate.transfer.read(f.p.id,f.c.id)),saved,'a repeated submit of the used token writes nothing');
});
