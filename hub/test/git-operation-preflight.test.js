'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const git=require('../lib/git'),preflight=require('../lib/main-merge-check');
const tmp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-operation-preflight-'));
const g=(dir,...args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8',stdio:'pipe'}).trim();
let serial=0;
test.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
function fixture(){
 const main=path.join(tmp,'main-'+(++serial)),workRoot=path.join(tmp,'work-'+serial);fs.mkdirSync(main);
 g(main,'init','-q');g(main,'config','user.name','Fixture');g(main,'config','user.email','fixture@localhost');
 fs.writeFileSync(path.join(main,'base.txt'),'base');g(main,'add','.');g(main,'commit','-qm','base');
 const copy=git.prepare({base:main,workRoot,taskId:'copy'}).dir;
 return {main,copy,workRoot};
}
const markerNames=['MERGE_HEAD','REBASE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','rebase-merge','rebase-apply','sequencer'];
function mark(dir,name){
 const file=path.resolve(dir,g(dir,'rev-parse','--git-path',name));
 if(name.endsWith('_HEAD'))fs.writeFileSync(file,g(dir,'rev-parse','HEAD')+'\n');
 else{fs.mkdirSync(file);fs.writeFileSync(path.join(file,'fixture-proof'),'preserve operation');}
 return {file,proof:()=>fs.readFileSync(name.endsWith('_HEAD')?file:path.join(file,'fixture-proof'),'utf8')};
}
function snapshot(dir){return {head:g(dir,'rev-parse','HEAD'),status:g(dir,'status','--porcelain'),index:fs.readFileSync(g(dir,'rev-parse','--path-format=absolute','--git-path','index')).toString('hex')};}
for(const name of markerNames)test('unfinished Git operation is refused without saving or clearing: '+name,()=>{
 const f=fixture();
 for(const side of ['source','target']){
  const dir=side==='source'?f.copy:f.main,other=side==='source'?f.main:f.copy,m=mark(dir,name),proof=m.proof();
  assert.equal(git.merging(dir),true,'detect marker in its own worktree');
  assert.equal(git.merging(other),false,'operation state must not leak between worktrees');
  const denied=preflight.check(git,dir,side);assert.equal(denied.blocker?.kind,'merging');assert.equal(denied.blocker.side,side);assert.equal(denied.snapshot,undefined);
  // Refuse an already-included source too, before auto-save or no-op success.
  if(side==='target')fs.writeFileSync(path.join(f.copy,'unsaved.txt'),'leave unsaved');
  const before=[snapshot(f.main),snapshot(f.copy)];
  const out=git.merge({dir:f.copy,workRoot:f.workRoot,title:'must refuse',cleanup:false,...(side==='source'?{sourceHead:g(f.copy,'rev-parse','HEAD')}:{})});
  assert.equal(out.ok,false);assert.match(out.error,/途中/);assert.deepEqual([snapshot(f.main),snapshot(f.copy)],before);assert.equal(m.proof(),proof);
  fs.rmSync(m.file,{recursive:true});if(side==='target')fs.unlinkSync(path.join(f.copy,'unsaved.txt'));
 }
});
test('clean repository, unrelated Git heads and completed operations still allow one merge',()=>{
 const f=fixture();
 for(const dir of [f.main,f.copy]){
  for(const name of ['ORIG_HEAD','FETCH_HEAD'])fs.writeFileSync(path.resolve(dir,g(dir,'rev-parse','--git-path',name)),g(dir,'rev-parse','HEAD')+'\n');
  assert.equal(git.merging(dir),false);assert.ok(preflight.check(git,dir,dir===f.copy?'source':'target').snapshot);
 }
 assert.equal(git.merging(path.join(tmp,'absent')),false);
 fs.writeFileSync(path.join(f.copy,'saved.txt'),'saved');git.save(f.copy,'saved fixture');
 const out=git.merge({dir:f.copy,workRoot:f.workRoot,title:'completed operation',cleanup:false});
 assert.equal(out.ok,true);assert.equal(fs.readFileSync(path.join(f.main,'saved.txt'),'utf8'),'saved');assert.ok(fs.existsSync(f.copy));
});
test('operation starting after preflight is refused by the last guard before merge',()=>{
 const f=fixture();fs.writeFileSync(path.join(f.copy,'saved.txt'),'saved');git.save(f.copy,'saved fixture');
 const before=[snapshot(f.main),snapshot(f.copy)];let m;
 const out=git.merge({dir:f.copy,workRoot:f.workRoot,title:'late operation',cleanup:false,targetGuard:dir=>{const state=git.inspect(dir,{readOnly:true});m=mark(dir,'sequencer');return state;}});
 assert.equal(out.ok,false);assert.match(out.error,/途中/);assert.deepEqual([snapshot(f.main),snapshot(f.copy)],before);assert.equal(m.proof(),'preserve operation');assert.equal(fs.existsSync(path.join(f.main,'saved.txt')),false);
});
test('real rebase paused at edit with a clean index keeps its detached HEAD and operation',()=>{
 const f=fixture();
 for(const n of [1,2]){fs.writeFileSync(path.join(f.main,'change-'+n+'.txt'),String(n));g(f.main,'add','.');g(f.main,'commit','-qm','change '+n);}
 const editor=path.join(tmp,'rebase-editor.js');fs.writeFileSync(editor,"const fs=require('node:fs'),file=process.argv[2];fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace(/^pick /,'edit '));\n");
 const quote=x=>"'"+x.replaceAll("'","'\\''")+"'";
 execFileSync('git',['-C',f.main,'rebase','-i','HEAD~2'],{env:{...process.env,GIT_SEQUENCE_EDITOR:quote(process.execPath)+' '+quote(editor)},stdio:'pipe'});
 assert.equal(g(f.main,'status','--porcelain'),'');assert.equal(g(f.main,'rev-parse','--abbrev-ref','HEAD'),'HEAD');
 const before=[snapshot(f.main),snapshot(f.copy)],rebase=path.resolve(f.main,g(f.main,'rev-parse','--git-path','rebase-merge'));
 const record=fs.readFileSync(path.join(rebase,'git-rebase-todo'),'utf8');assert.equal(preflight.check(git,f.main,'target').blocker?.kind,'merging');
 assert.equal(git.merge({dir:f.copy,workRoot:f.workRoot,title:'paused real rebase',cleanup:false}).ok,false);
 assert.deepEqual([snapshot(f.main),snapshot(f.copy)],before);assert.equal(fs.readFileSync(path.join(rebase,'git-rebase-todo'),'utf8'),record);
});
