'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),create=require('../lib/routes/task-settings');
function fixture(){
 const calls=[],task={id:'t',state:'未着手',workspaceMode:'isolated',kind:'main'},project={id:'p',tasks:[task]},value={remote:false,project,task,busy:false,sessions:[],updated:{id:'t'}};
 const mark=(name,fn)=>(...args)=>{calls.push([name,...args]);return fn(...args);};
 const routes=create({send:(res,status,body)=>({status,body}),lt:s=>s,fromRemote:()=>value.remote,record:mark('audit',()=>{}),chats:{busy:mark('busy',()=>value.busy)},sessions:{list:mark('sessions',()=>value.sessions)},setUnread:mark('unread',()=>{}),store:{readProject:mark('project',()=>value.project),taskFile:mark('file',()=> 'task.md'),readTask:mark('task',()=>value.task),listProjects:mark('all',()=>[project]),updateTask:mark('update',()=>value.updated)}});
 assert.deepEqual(calls,[]);return {calls,task,value,routes,run:(slot,b)=>routes[slot].handle({method:'POST'}, {},new URL('/api/task'+(slot==='read'?'/read':''),'http://localhost'),{project:'p',task:'t',...b})};
}
test('task settings has exact independent update and read slots',()=>{
 const f=fixture();for(const [slot,url]of [['update','/api/task'],['read','/api/task/read']]){assert.equal(f.routes[slot].matches({},new URL(url,'http://localhost')),true);assert.equal(f.routes[slot].matches({},new URL(url+'/extra','http://localhost')),false);}
});
test('ordinary metadata changes retain string filtering and the original update response',()=>{
 const f=fixture();assert.deepEqual(f.run('update',{owner:'codex',role:'code',model:7,memo:'memo',question:'?',state:'返事待ち'}),{status:200,body:{id:'t'}});const patch=f.calls.find(x=>x[0]==='update')[3];assert.equal(patch.owner,'codex');assert.equal(patch.model,undefined);assert.equal(patch.memo,'memo');assert.equal(patch.question,'?');assert.deepEqual(f.calls.map(x=>x[0]),['update']);
 f.value.updated=null;assert.equal(f.run('update',{}).status,400);
});
test('remote audit happens before rejecting a direct completion change, without saving',()=>{
 const f=fixture();f.value.remote=true;assert.equal(f.run('update',{state:'完了',memo:''}).status,409);assert.deepEqual(f.calls.map(x=>x[0]),['audit']);assert.equal(f.calls[0][1],'task');assert.deepEqual(f.calls[0][3],{state:'完了',question:false,memo:true});
});
test('workspace changes require valid context and reject started, busy or running work before saving',()=>{
 const f=fixture();assert.equal(f.run('update',{workspaceMode:'bad'}).status,409);assert.equal(f.calls.some(x=>x[0]==='update'),false);
 for(const mode of ['started','busy','session']){f.calls.length=0;f.task.workspaceStarted=mode==='started';f.value.busy=mode==='busy';f.value.sessions=mode==='session'?[{project:'p',task:'t',running:true}]:[];assert.equal(f.run('update',{workspaceMode:'direct'}).status,409);assert.equal(f.calls.some(x=>x[0]==='update'),false,mode);}
 f.task.workspaceStarted=false;f.value.busy=false;f.value.sessions=[];f.calls.length=0;assert.equal(f.run('update',{workspaceMode:'direct'}).status,200);assert.equal(f.calls.at(-1)[0],'update');assert.equal(f.calls.at(-1)[3].workspaceMode,'direct');
});
test('missing or invalid task context returns 409 and never changes metadata',()=>{
 const f=fixture();f.value.project=null;assert.equal(f.run('update',{kind:'main'}).status,409);assert.equal(f.calls.some(x=>x[0]==='update'),false);
});
test('read marker accepts only string identities and changes no other task data',()=>{
 const f=fixture();assert.equal(f.run('read',{task:4}).status,400);assert.deepEqual(f.calls,[]);assert.deepEqual(f.run('read',{}),{status:200,body:{ok:true}});assert.deepEqual(f.calls,[['unread','p','t',false]]);
});
