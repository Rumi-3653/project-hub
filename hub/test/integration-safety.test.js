'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const safety=require('../lib/integration-safety'),selection=require('../public/integration-selection'),{ChatRunner}=require('../lib/chat');
function scope(t){const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-safety-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const all=['A','B'].map(id=>({id,name:id,dir:path.join(root,'Ledger',id),tasks:[{id:'parent',title:'親',workdir:path.join(root,'Body',id)},{id:'child',title:'子',workdir:path.join(root,'Child',id)}]}));for(const p of all)for(const d of [p.dir,...p.tasks.map(t=>t.workdir)])fs.mkdirSync(d,{recursive:true});const opts={b:{project:'A',task:'parent',selected:[{project:'A',task:'child'}]},all,baseOf:p=>path.join(root,'Body',p.id)};return {root,all,opts};}
for(const kind of ['chat','terminal','queue','background','history'])test('統合の稼働範囲：無関係は通し、対象・同じ保存先は待つ：'+kind,t=>{
 const f=scope(t),activity={kind,project:'B',task:'parent',message:kind+' B／親'};assert.deepEqual(safety.blockers({...f.opts,activities:[activity]}),[]);
 const own={...activity,project:'A',task:'child'};assert.equal(safety.blockers({...f.opts,activities:[own]}).length,1);
 f.all[1].tasks[0].workdir=f.all[0].tasks[1].workdir;const out=safety.blockers({...f.opts,activities:[activity]});assert.equal(out.length,1);assert.match(out[0].message,/B\/親|B／親/);assert.match(out[0].message,/A／親.*競合/);
});
test('別名プロジェクトでもlinked worktreeの共通Gitを保護、無関係な未所属常駐は含めない',t=>{
 const f=scope(t),common=path.join(f.root,'common'),a=f.all[0].tasks[0].workdir,b=f.all[1].tasks[0].workdir;fs.mkdirSync(common);for(const [n,dir]of [[1,a],[2,b]]){const own=path.join(common,'worktrees',String(n));fs.mkdirSync(own,{recursive:true});fs.writeFileSync(path.join(own,'commondir'),'../..');fs.writeFileSync(path.join(dir,'.git'),'gitdir: '+own);}
 const out=safety.blockers({...f.opts,activities:[{kind:'chat',project:'B',task:'parent',message:'writer'},{kind:'background',pid:123,message:'unowned'}]});assert.equal(out.length,1);assert.equal(out[0].project,'B');
});
for(const mode of ['single','selected','batch'])for(const keep of [true,false])test('共通対象選択：個別・選別・一括と子孫・保持：'+mode+'/'+keep,()=>{
 const items=[{project:'p',task:'a',title:'A',depth:1,keep,startable:true,descendants:[{project:'p',task:'b',title:'B'}]},{project:'p',task:'b',title:'B',depth:2,keep,startable:true,descendants:[]}];const asked=mode==='selected'?items:items.slice(0,1),out=selection.select(items,mode,asked);assert.equal(out.reason,'');assert.deepEqual(out.items.map(i=>i.task),mode==='single'&&keep?['a']:['b','a']);
 const invalid=items.map(i=>({...i,keep:i.task==='b',startable:i.task!=='b'}));assert.ok(selection.select(invalid,mode,asked).reason);assert.equal(selection.select(items,'selected',[items[0],items[0]]).items.length,0);
});
for(const ending of ['normal','crash','cancel','spawn-error'])test('実ChatRunnerの正常・異常・取消・起動失敗後に稼働が残らない：'+ending,async t=>{
 const f=scope(t),pdir=f.all[0].dir;let row;const runner=new ChatRunner({onSettled:(o,r)=>row=r}),options={project:'A',task:'child',pdir,dir:pdir,ai:'codex',model:'fixture',text:'LOCAL NODE FIXTURE ONLY',userRow:{turn:'fixture',startedAt:new Date().toISOString(),role:'user',text:'fixture'}};
 const script=ending==='normal'?"process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'fixture'}}));});":ending==='crash'?"process.exit(7)":"process.stdin.resume();setInterval(()=>{},1000)";
 const run=runner.run(options,{command:ending==='spawn-error'?path.join(f.root,'missing'):process.execPath,args:['-e',script],stdin:''},{},[]);
 const activity=()=>runner.busy('A','child')?[{kind:'chat',project:'A',task:'child',message:'local process'}]:[];assert.equal(safety.blockers({...f.opts,activities:activity()}).length,1);await run.startedP;if(ending==='cancel')await runner.stop('A','child');await run.finishedP;await new Promise(setImmediate);assert.equal(runner.busy('A','child'),null);assert.equal(safety.blockers({...f.opts,activities:activity()}).length,0);assert.ok(row);if(ending!=='normal')assert.ok(row.error);
});
test('取消中の利用枠確認も稼働登録と保存キューを残さない',async t=>{
 const f=scope(t),runner=new ChatRunner({dirOf:()=>f.all[0].dir,beforeQueued:()=>new Promise(()=>{})}),q=runner.enqueue('A','child',{ai:'codex',model:'fixture',text:'LOCAL PRESTART ONLY'});const sending=runner.sendQueued({project:'A',task:'child',pdir:f.all[0].dir,request:q.id,ai:'codex',text:'fixture'});await Promise.resolve();await runner.stop('A','child');await assert.rejects(sending,/停止/);assert.equal(runner.busy('A','child'),null);assert.deepEqual(runner.queue('A','child'),[]);
});

test('共通判定は選択した範囲だけの待機を評価し、一括では全対象を保護',()=>{
 const items=[{project:'p',task:'a',title:'A',startable:true,keep:true,depth:1,descendants:[],waiting:[{message:'Aの保存処理'}]},{project:'p',task:'b',title:'B',startable:true,keep:true,depth:1,descendants:[],waiting:[]}];
 assert.equal(selection.select(items,'single',[items[1]]).reason,'');assert.equal(selection.select(items,'selected',[items[1]]).reason,'');assert.match(selection.select(items,'single',[items[0]]).reason,/Aの保存処理/);assert.match(selection.select(items,'batch',[]).reason,/Aの保存処理/);items[0].waiting=[];assert.equal(selection.select(items,'batch',[]).reason,'');
});
