'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Store}=require('../lib/store'),{Removal}=require('../lib/remove');
function fixture(t,opts={}){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-tidy-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const write=(f,s)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,s);return f;};
 write(path.join(root,'Product/Child/PROJECT.md'),'---\nname: Child\nfolders: {}\nrelated: []\n---\n');
 const store=new Store(root),task=store.createTask('Child',{title:'Task'}).id,dir=path.join(root,'Product/Child');
 const chat=write(path.join(dir,'.ai/chat',task+'.jsonl'),'{"role":"user","text":"会話原文"}\n');
 const temp=write(path.join(dir,'.ai/work',task,'scratch.txt'),'一時物');
 const handoff=write(path.join(dir,'.ai/handoff',task+'-20261010-120000-codex.md'),'引継ぎ');
 const own=write(path.join(dir,'attachments',task,'a.png'),'専用');
 store.appendSection('Child',task,'成果','- なし：確認のみ');
 const r=new Removal({store,trash:path.join(root,'Trash'),...opts});
 const done=()=>assert.equal(store.decideTask('Child',task,'approve',store.readProject('Child').tasks.find(x=>x.id===task).completionHash).state,'完了');
 return {root,dir,store,task,chat,temp,handoff,own,r,done,file:store.taskFile('Child',task)};
}
test('未完了の作業は片付けず、移す物の確認も出さない',t=>{const f=fixture(t);const d=f.r.tidyPreview('Child',f.task);assert.match(d.blockers.join(),/完了した作業だけ/);assert.equal(d.token,'');});
test('完了した作業の一時物と引継ぎ記録だけを移し、作業・会話・専用フォルダは残して元に戻せる',t=>{const f=fixture(t);f.done();const d=f.r.tidyPreview('Child',f.task);assert.deepEqual(d.blockers,[]);assert.deepEqual(d.move.map(x=>x.path).sort(),[f.temp,f.handoff].map(x=>x.replace(/\/scratch\.txt$/,'')).sort());assert.ok(d.keep.some(x=>x.path===path.dirname(f.own)&&/専用フォルダは残します/.test(x.why)));
 const out=f.r.tidyApply({token:d.token,ids:d.move.map(x=>x.id),confirm:true});assert.equal(out.ok,true);assert.equal(out.moved.length,2);assert.ok(!fs.existsSync(path.dirname(f.temp)));assert.ok(!fs.existsSync(f.handoff));for(const x of [f.file,f.chat,f.own])assert.ok(fs.existsSync(x));
 assert.equal(f.r.history()[0].tidy,true);const back=f.r.restore(out.record,true);assert.equal(back.restored,2);assert.equal(fs.readFileSync(f.temp,'utf8'),'一時物');assert.equal(fs.readFileSync(f.handoff,'utf8'),'引継ぎ');});
test('成果や会話から参照される一時物は理由付きで残す',t=>{const f=fixture(t);f.done();fs.writeFileSync(f.file,fs.readFileSync(f.file,'utf8').replace('- なし：確認のみ','- ファイル：'+path.dirname(f.temp)+'/scratch.txt（成果）'));f.done();const d=f.r.tidyPreview('Child',f.task);assert.ok(!d.move.some(x=>x.path===path.dirname(f.temp)));assert.ok(d.keep.some(x=>x.path===path.dirname(f.temp)&&/参照/.test(x.why)));assert.ok(d.move.some(x=>x.path===f.handoff));});
test('作業中・順番待ちでは片付けない',t=>{const f=fixture(t,{busy:()=>true});f.done();assert.match(f.r.tidyPreview('Child',f.task).blockers.join(),/AIが作業中/);const g=fixture(t);g.done();fs.writeFileSync(path.join(g.dir,'.ai/chat',g.task+'.queue.json'),'[{"text":"待ち"}]');assert.match(g.r.tidyPreview('Child',g.task).blockers.join(),/順番待ち/);});
test('片付けと作業削除の確認は取り違えられず、確認後の変化・選び直しも拒む',t=>{const f=fixture(t);f.done();const d=f.r.tidyPreview('Child',f.task);assert.throws(()=>f.r.apply({token:d.token,confirm:true}),/削除内容/);assert.throws(()=>f.r.tidyApply({token:d.token,ids:['作業/x'],confirm:true}),/選び直して/);assert.throws(()=>f.r.tidyApply({token:d.token,ids:d.move.map(x=>x.id)}),/片付け内容/);const full=f.r.preview('Child',f.task);assert.throws(()=>f.r.tidyApply({token:full.token,ids:d.move.map(x=>x.id),confirm:true}),/片付け内容/);fs.writeFileSync(f.temp,'変わった');assert.throws(()=>f.r.tidyApply({token:d.token,ids:d.move.map(x=>x.id),confirm:true}),/変わりました/);assert.ok(fs.existsSync(f.temp));});

test('R1: 成果未記録は完了済みでもpreviewとapplyを拒否する',t=>{
 const f=fixture(t);f.done();const d=f.r.tidyPreview('Child',f.task);assert.ok(d.token);
 fs.writeFileSync(f.file,fs.readFileSync(f.file,'utf8').replace('## 成果\n- なし：確認のみ','## メモ\n確認のみ'));f.done();
 assert.match(f.r.tidyPreview('Child',f.task).blockers.join(),/成果の記録がありません/);
 assert.throws(()=>f.r.tidyApply({token:d.token,ids:d.move.map(x=>x.id),confirm:true}),/成果の記録がありません/);assert.ok(fs.existsSync(f.temp));
});
test('R1: 子の未受領・保持受領・最終統合待ちは通常の片付けでは移さない',t=>{
 const f=fixture(t),parent=f.store.createTask('Child',{title:'Parent'}).id;
 f.store.updateTask('Child',f.task,{parent});f.done();
 const record=path.join(f.root,'_hub/task-handoffs',require('node:crypto').createHash('sha256').update('Child\0'+f.task).digest('hex')+'.json');fs.mkdirSync(path.dirname(record),{recursive:true});
 for(const r of [null,{project:'Child',task:f.task,complete:false,handedUp:true},{project:'Child',task:f.task,complete:true,retained:true}]){
  if(r)fs.writeFileSync(record,JSON.stringify(r));const d=f.r.tidyPreview('Child',f.task);assert.equal(d.token,'');assert.match(d.blockers.join(),/親の最終統合/);assert.ok(fs.existsSync(f.temp));
 }
});
test('R1: 未受領・未統合記録と未統合コピーは片付け全体を止める',t=>{
 for(const name of ['task-handoffs','task-integrations']){
  const f=fixture(t);f.done();const record=path.join(f.root,'_hub',name,'a'.repeat(64)+'.json');fs.mkdirSync(path.dirname(record),{recursive:true});fs.writeFileSync(record,JSON.stringify({project:'Child',task:f.task,complete:false}));
  assert.match(f.r.tidyPreview('Child',f.task).blockers.join(),/未受領・未統合/);
 }
 const f=fixture(t);f.done();fs.mkdirSync(path.join(f.root,'Work/Child',f.task),{recursive:true});f.r.copyInfo=()=>{throw Error('未保存または未統合の変更');};assert.match(f.r.tidyPreview('Child',f.task).blockers.join(),/未統合の変更/);
});
test('R1: 受領記録の破損を空記録扱いせず、安全側で保持する',t=>{
 const f=fixture(t);f.done();const dir=path.join(f.root,'_hub/task-handoffs');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'a'.repeat(64)+'.json'),'{broken');const d=f.r.tidyPreview('Child',f.task);assert.equal(d.token,'');assert.ok(d.blockers.length);assert.ok(fs.existsSync(f.temp));
});
test('R2: 保管本文・引継ぎ・過去会話原文から参照される物をpreviewとapplyで保護する',t=>{
 for(const source of ['.ai/memory/task-archive/T/completed-202610.md','.ai/handoff/other.md','.ai/chat/history/T/old/0.original']){
  const f=fixture(t);f.done();const d=f.r.tidyPreview('Child',f.task),file=path.join(f.dir,source);fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,source.endsWith('.original')?JSON.stringify({text:'.ai/work/'+f.task+'/scratch.txt'})+'\n':'.ai/work/'+f.task+'/scratch.txt');
  const after=f.r.tidyPreview('Child',f.task);assert.ok(!after.move.some(x=>x.path===path.dirname(f.temp)));assert.ok(after.keep.some(x=>x.path===path.dirname(f.temp)&&/参照/.test(x.why)));
  assert.throws(()=>f.r.tidyApply({token:d.token,ids:d.move.map(x=>x.id),confirm:true}),/変わりました/);assert.ok(fs.existsSync(f.temp));
 }
});
test('R2: 読めない保管本文を無視せず候補を残す',t=>{
 const f=fixture(t);f.done();const dir=path.join(f.dir,'.ai/memory');fs.mkdirSync(dir,{recursive:true});fs.symlinkSync('/missing-original',path.join(dir,'broken.md'));
 const d=f.r.tidyPreview('Child',f.task);assert.ok(!d.move.length);assert.ok(d.keep.some(x=>/リンク/.test(x.why)));assert.ok(fs.existsSync(f.temp));
});
