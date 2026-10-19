'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFileSync}=require('node:child_process'),{excluded}=require('../../scripts/export-public');
test('core without private code: free conversation survives a cold restart; official missing-bundle notice preserves it',t=>{
 const temp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-public-core-'));
 t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const source=path.resolve(__dirname,'..'),copy=path.join(temp,'source/hub'),root=path.join(temp,'workspace'),bin=path.join(temp,'bin');
 fs.cpSync(source,copy,{recursive:true,filter:file=>!excluded('hub/'+path.relative(source,file).split(path.sep).join('/')+(fs.statSync(file).isDirectory()?'/':''))});
 execFileSync('/bin/bash',[path.join(source,'setup.sh')],{env:{...process.env,HOME:temp,HUB_ROOT:root,HUB_SKIP_NPM:'1',HUB_SKIP_APP:'1'},stdio:'ignore'});
 const savedJobs=path.join(root,'_hub/webchat-jobs.json');
 const staleJobs=JSON.stringify([{project:'サンプルアプリ',task:'sample-app-01',request:'old-private-job',state:'sending',sent:true}]);fs.writeFileSync(savedJobs,staleJobs);
 const pdir=path.join(root,'Product','サンプルアプリ');
 const project=path.join(pdir,'PROJECT.md');fs.writeFileSync(project,fs.readFileSync(project,'utf8').replace(/^(  [^\n:]+:\s*)~\/[^\n]*$/gm,(_line,label)=>label+pdir));
 const task=path.join(pdir,'.ai/tasks/sample-app-01.md');fs.writeFileSync(task,fs.readFileSync(task,'utf8').replace(/^workdir:.*$/m,'workdir:'));
 fs.writeFileSync(path.join(root,'_hub/ai-tools-models.json'),JSON.stringify({v:1,codex:{models:[{id:'gpt-6.1-sol',label:'GPT-6.1-Sol'}]}}));
 fs.mkdirSync(bin);fs.writeFileSync(path.join(bin,'codex'),'#!'+process.execPath+`\nprocess.stdin.resume();process.stdin.on('end',()=>{setTimeout(()=>{console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-free'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'FREE-CORE-REPLY'}}));console.log(JSON.stringify({type:'turn.completed'}));},200);});\n`,{mode:0o755});
 const probe=path.join(temp,'probe.cjs');fs.writeFileSync(probe,`
 const assert=require('node:assert/strict'),path=require('node:path');
 const hub=process.env.TEST_HUB;
 // Suppress background activation/network/Keychain creation only. The real
 // license guards and free-chat entitlement are kept, with no trial or proof.
 require(path.join(hub,'lib/license')).License.prototype.prepare=async()=>{};
 const {server,chats,stopControl}=require(path.join(hub,'server'));
 const chat=require(path.join(hub,'lib/chat'));
 (async()=>{await new Promise(r=>server.listen(Number(process.env.HUB_PORT),'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 const state=await(await fetch(base+'/api/state')).json(); assert.ok(state.extensions,JSON.stringify(state));
 assert.deepEqual(state.extensions.included,[]);
 if(process.env.TEST_SEND==='1')for(const [options,feature] of [[{mode:'queued'},'queue_auto'],[{limitSwitch:{}},'limit_switch'],[{licenseFeatures:['parallel']},'parallel']])assert.throws(()=>chats.licenseGuard({project:'サンプルアプリ',task:'sample-app-01',ai:'codex',...options},'start'),e=>e.code==='license_held'&&e.features.includes(feature)&&e.licenseHeld===true);

 assert.equal(Boolean(state.extensions.notice),process.env.TEST_MISSING==='1');
 assert.equal(await(await fetch(base+'/extensions-ui.js')).text(),'');
 assert.equal(await(await fetch(base+'/extensions-ui.css')).text(),'');
 const no=await fetch(base+'/api/discussion/start',{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json'},body:'{}'});
 assert.equal(no.status,404);assert.equal((await no.json()).code,'feature_not_included');
 const deniedDelegate=await fetch(base+'/api/delegate',{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json'},body:'{}'});assert.equal(deniedDelegate.status,404);assert.equal((await deniedDelegate.json()).code,'feature_not_included');
 for(const route of ['/api/chat/send','/api/term/start','/api/delegate']){
  const r=await fetch(base+route,{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json'},body:JSON.stringify({origin:'hub-internal',project:'サンプルアプリ',task:'sample-app-01',ai:'codex',text:'must not send'})});assert.equal(r.status,403);assert.equal((await r.json()).delivery,'not-sent');
 }
 const fs=require('node:fs'),rolesFile=path.join(process.env.HUB_ROOT,'_hub/roles.yaml');
 const before=fs.readFileSync(rolesFile,'utf8');
 for(const action of ['review','review/cancel']){
   const no=await fetch(base+'/api/roles/'+action,{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json'},body:'{}'});
   assert.equal(no.status,404);assert.equal((await no.json()).code,'feature_not_included');
 }
 assert.equal(fs.readFileSync(rolesFile,'utf8'),before);
 const journal=path.join(process.env.HUB_ROOT,'_hub/webchat-jobs.json'),oldJournal=fs.readFileSync(journal,'utf8');
 assert.equal(state.webchat.busy,false);assert.deepEqual(state.webchat.jobs,[]);
 for(const [method,tail] of [['GET',''],...['','/status','/models','/login','/logout','/retry','/stop'].map(t=>['POST',t])]){
 const r=await fetch(base+'/api/webchat'+tail,{method,headers:{'X-Hub':'1','Content-Type':'application/json'},...(method==='POST'?{body:'{}'}:{})});assert.equal(r.status,404);assert.equal((await r.json()).code,'feature_not_included');}
 const unavailable=await fetch(base+'/api/chat/send',{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json'},body:JSON.stringify({project:'サンプルアプリ',task:'sample-app-01',ai:'chatgpt',model:'auto',text:'must not send'})});
 const unavailableBody=await unavailable.json();if(process.env.TEST_SEND==='1'){assert.equal(unavailable.status,404,JSON.stringify(unavailableBody));assert.equal(unavailableBody.delivery,'not-sent');}else{assert.equal(unavailable.status,409,JSON.stringify(unavailableBody));assert.match(unavailableBody.error,/停止・保留中/);}
 const tools=await(await fetch(base+'/api/mcp/tools',{headers:{'X-Hub':'1'}})).json();assert.ok(JSON.stringify(tools).includes('hub_list_projects'));
 assert.equal((await fetch(base+'/api/chatgpt')).status,200);
 const getRoles=async()=> (await(await fetch(base+'/api/state')).json()).roles;
 const postRoles=async(route,body)=>{const res=await fetch(base+route,{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json'},body:JSON.stringify(body)});const data=await res.json();assert.equal(res.status,200,JSON.stringify(data));return data;};
 const initial=await getRoles();
 const saved=await postRoles('/api/roles/default',{roles:initial.roles,expectedRevision:initial.management.revision});
 assert.ok(saved.management.defaultSavedAt);
 const changed=structuredClone(saved.roles);changed[0].main.effort=changed[0].main.effort==='高'?'中':'高';
 const edited=await postRoles('/api/roles',{roles:changed,expectedRevision:saved.management.revision});
 assert.equal(edited.roles[0].main.effort,changed[0].main.effort);
 const history=await(await fetch(base+'/api/roles/history')).json();assert.ok(history.history.length>=2);
 const restored=await postRoles('/api/roles/restore',{defaults:true,expectedRevision:edited.management.revision});
 assert.deepEqual(restored.roles,initial.roles);
 const pdir=path.join(process.env.HUB_ROOT,'Product','サンプルアプリ');
 const ideaPost=async(route,body)=>{const r=await fetch(base+route,{method:'POST',headers:{'X-Hub':'1','X-Hub-UI':'ideas',Origin:base,'Content-Type':'application/json'},body:JSON.stringify({project:'サンプルアプリ',opId:crypto.randomUUID(),...body})});return {status:r.status,body:await r.json()};};
 for(const route of ['/api/ideas/auto','/api/ideas/lane','/api/ideas/release/prepare','/api/ideas/runtime-confirm']){const r=await ideaPost(route,{enabled:true});assert.equal(r.status,404);assert.equal(r.body.code,'feature_not_included');}
 if(process.env.TEST_SEND==='1'){const r=await ideaPost('/api/ideas/add',{text:'FREE-IDEA-COLD-RESTART',intent:'record'});assert.equal(r.status,201,JSON.stringify(r));}
 const list=await(await fetch(base+'/api/ideas?'+new URLSearchParams({project:'サンプルアプリ'}),{headers:{'X-Hub':'1'}})).json();assert.equal(list.automationAvailable,false);assert.ok(list.items.some(i=>i.text==='FREE-IDEA-COLD-RESTART'));assert.deepEqual(list.candidates,[]);

 if(process.env.TEST_SEND==='1'){
 const send=await fetch(base+'/api/chat/send',{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json'},body:JSON.stringify({project:'サンプルアプリ',task:'sample-app-01',ai:'codex',model:'GPT-6.1-Sol',effort:'高',text:'無料の確認'})});
 assert.equal(send.status,200,await send.text());
 chats.setQueue('サンプルアプリ','sample-app-01',[{id:'held-auto-after-removal',ai:'codex',model:'GPT-6.1-Sol',text:'MUST-NOT-AUTO-RUN',at:new Date().toISOString()}]);
 for(let i=0;i<300&&chats.busy('サンプルアプリ','sample-app-01');i++)await new Promise(r=>setTimeout(r,20));
 assert.equal(chats.busy('サンプルアプリ','sample-app-01'),null);
 }
 const held=chats.queue('サンプルアプリ','sample-app-01');assert.equal(held.length,1);assert.equal(held[0].id,'held-auto-after-removal');
 const rows=chat.read(pdir,'sample-app-01');assert.equal(rows.some(r=>r.role==='user'&&r.text==='MUST-NOT-AUTO-RUN'),false);assert.ok(rows.some(r=>r.role==='assistant'&&r.text.includes('FREE-CORE-REPLY')),JSON.stringify(rows));
 assert.equal(fs.readFileSync(journal,'utf8'),oldJournal);
 chats.stopAll();server.closeAllConnections();await new Promise(r=>server.close(r));console.log('free-core-ok');
 })().catch(e=>{console.error(e);process.exitCode=1;server.closeAllConnections();server.close();chats.stopAll();});
 `);
 const env={...process.env,HOME:temp,PATH:bin+':/usr/bin:/bin',HUB_ROOT:root,HUB_AI_HOME:temp,HUB_FREETALK_HOME:path.join(temp,'home'),HUB_DRY_RUN:'1',HUB_LANG:'ja',TEST_HUB:copy,HUB_PORT:String(50000+Math.floor(Math.random()*5000))};
 for(const [send,missing] of [['1','0'],['0','0'],['0','1']]){
  if(missing==='1')fs.writeFileSync(path.join(copy,'paid-bundle.json'),JSON.stringify({version:1,features:['discussion','role_review','webchat']}));
  const out=execFileSync(process.execPath,[probe],{env:{...env,TEST_SEND:send,TEST_MISSING:missing},encoding:'utf8',timeout:30000});assert.match(out,/free-core-ok/);
 }
});
