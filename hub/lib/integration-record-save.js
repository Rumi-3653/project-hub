'use strict';
const persistence = require('./platform').persistence;
// Explicit human authorization, narrowly scoped to related ledger records.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{execFileSync}=require('node:child_process'),{createHash}=require('node:crypto');
const writes=require('./integration-writes'),{noLinks}=require('./remove'),{lt}=require('./locale'),graph=require('../public/project-order');
const hash=x=>createHash('sha256').update(x).digest('hex');
const g=(dir,args,env={})=>execFileSync('git',['-C',dir,'-c','core.fsmonitor=false',...args],{env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',...env},stdio:['ignore','pipe','pipe'],maxBuffer:256*1024*1024});
const commitOptions=['-c','core.hooksPath=/dev/null','-c','commit.gpgSign=false','-c','user.name=Project Hub','-c','user.email=hub@localhost'];
const literal=paths=>paths.map(p=>':(top,literal)'+p);
const indexFile=top=>path.resolve(top,g(top,['rev-parse','--git-path','index']).toString().trim());
// Preview uses a disposable index: no real staging, ref update or commit.
function ready(top,paths,untracked){let dir;try{
 dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-record-index-'));const file=path.join(dir,'index');fs.copyFileSync(indexFile(top),file);const env={GIT_INDEX_FILE:file};
 if(untracked.length)g(top,['add','--intent-to-add','--',...literal(untracked)],env);
 g(top,[...commitOptions,'commit','--only','--dry-run','--',...literal(paths)],env);return true;
 }catch{return false;}finally{if(dir)fs.rmSync(dir,{recursive:true,force:true});}}
// Only our successfully validated preparation may be undone, with a Git lock
// and exact HEAD/index comparison. No reset, stash or unrelated entry editing.
function undoPreparation(top,head,prepared,original){const file=indexFile(top),lock=file+'.lock';let fd,owned=false;try{
 fd=fs.openSync(lock,'wx',0o600);owned=true;if(g(top,['rev-parse','HEAD']).toString().trim()!==head||hash(fs.readFileSync(file))!==prepared.sha)return false;
 fs.writeFileSync(fd,original.bytes);fs.fchmodSync(fd,original.mode);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(lock,file);owned=false;persistence.syncDirectory(path.dirname(file));return g(top,['rev-parse','HEAD']).toString().trim()===head&&hash(fs.readFileSync(file))===hash(original.bytes);
 }catch{return false;}finally{if(fd!==undefined){try{fs.closeSync(fd);}catch{}}if(owned){try{fs.unlinkSync(lock);}catch{}}}}
function outputState(dir,id){const f=path.join(dir,'作業',id);return fs.existsSync(f)?require('./remove').snapshot(f):null;}
function scope(h,a){return a.all.flatMap(p=>p.tasks.filter(t=>p.id===a.p.id&&t.id===a.t.id||graph.ancestorsOf(p,t,a.all).some(x=>x.project.id===a.p.id&&x.task.id===a.t.id)).map(t=>({dir:p.dir,id:t.id,project:p,task:t})));}
function kind(file,related){for(const x of related){const rel=path.relative(x.dir,file).split(path.sep).join('/');if(rel==='PROJECT.md'||rel===`.ai/tasks/${x.id}.md`||['json','jsonl','rules.md','queue.json'].some(ext=>rel===`.ai/chat/${x.id}.${ext}`)||rel.startsWith(`.ai/handoff/${x.id}-`)||/^\.ai\/memory\/[^/]+\.(?:md|json|jsonl)$/.test(rel))return true;}return false;}
function visible(rel){return rel&&!path.isAbsolute(rel)&&!rel.split('/').includes('..')&&!/[\x00-\x1f\x7f]/.test(rel)&&!/(^|\/)(\.env(?:\..*)?|\.npmrc|settings\.local\.json)$|secret|credential|password|token|auth|private.?key/i.test(rel);}
function stopped(top){const git=require('./git');return git.merging(top)||git.mergeLocks(top).length;}
function index(top){const rows=g(top,['ls-files','--stage','-z']).toString(),f=indexFile(top);noLinks(f);return {rows,sha:hash(fs.readFileSync(f))};}
// Save-target selection may change when a commit cleans the ledger. Its
// uncertain receipt remains authoritative for both related Git repositories.
function unresolved(h,a,targetTop){
 const tops=new Set(targetTop?[targetTop]:[]);
 for(const dir of targetTop?[a.p.dir]:[a.target,a.p.dir]){try{tops.add(g(dir,['rev-parse','--show-toplevel']).toString().trim());}catch{
  // A genuinely unversioned directory has no Git receipt. A damaged or
  // unreadable repository must not hide a receipt whose key we cannot resolve.
  for(let current=path.resolve(dir);;current=path.dirname(current)){if(fs.existsSync(path.join(current,'.git')))return true;if(path.dirname(current)===current)break;}
 }}
 return [...tops].some(top=>{try{const r=JSON.parse(fs.readFileSync(path.join(h.store.root,'_hub/record-saves',hash(top)+'.json'),'utf8'));return !r||!['done','not-sent'].includes(r.phase);}catch(e){return e.code!=='ENOENT';}});
}
function scan(h,a,chosen){
 const related=scope(h,a),targetTop=g(a.target,['rev-parse','--show-toplevel']).toString().trim();let top=chosen||targetTop;if(!chosen&&!g(top,['status','--porcelain']).length){try{const ledger=g(a.p.dir,['rev-parse','--show-toplevel']).toString().trim();if(g(ledger,['status','--porcelain']).length)top=ledger;}catch{}}
 const rows=g(top,['status','--porcelain','--no-renames','--untracked-files=all','-z']).toString().split('\0').filter(Boolean),ignored=writes.ignored(top),records=[],products=[];let hidden=0,invalid=false;
 if(g(top,['diff','--cached','--ita-visible-in-index','--name-only']).length)invalid=true;
 for(const row of rows){const rel=row.slice(3),file=path.join(top,rel),owned=kind(file,related);if(row[0]!==' '&&row.slice(0,2)!=='??')invalid=true;
  try{noLinks(file);if(writes.state(file)==='unsupported'||writes.state(file)===null)throw Error('unsupported');}catch{invalid=true;if(visible(rel))products.push(rel);else hidden++;continue;}
  if(!visible(rel)){hidden++;invalid=true;continue;}
  if(!owned){products.push(rel);continue;}if(ignored.includes(rel))continue;
  let headPrefix=null,jsonLines=null;if(rel.endsWith('.jsonl')){const now=fs.readFileSync(file);let before;try{before=g(top,['show','HEAD:'+rel]);}catch{before=Buffer.alloc(0);}headPrefix=now.subarray(0,before.length).equals(before);try{jsonLines=now.toString().split('\n').filter(Boolean).every(line=>{const x=JSON.parse(line);return x&&typeof x==='object'&&!Array.isArray(x);});}catch{jsonLines=false;}}
  records.push({path:rel,headPrefix,jsonLines,interrupted:writes.pending(file)});
 }
 const receipt=path.join(h.store.root,'_hub/record-saves',hash(top)+'.json'),uncertain=unresolved(h,a,targetTop);
 const paths=records.map(x=>x.path),untracked=rows.filter(row=>row.startsWith('?? ')&&paths.includes(row.slice(3))).map(row=>row.slice(3));
 const safe=records.length>0&&!products.length&&!hidden&&!invalid&&!stopped(top)&&!uncertain,canSave=safe&&ready(top,paths,untracked),allowed=Boolean(canSave);
 const info={allowed,unresolved:uncertain,records,products,hiddenPaths:hidden,reason:lt(uncertain?'Hub記録の保存結果が不明です。再送せず保存記録を確認してください':safe&&!canSave?'Hub記録の保存は開始していません。最新の記録を確認してください':!allowed?'製品の変更・ステージ・途中処理・対象を確認して保存してください':'対象のHub記録を確認してから保存してください'),warning:records.some(r=>r.headPrefix===false||r.jsonLines===false)?lt('会話原文に外部変更の可能性があります。内容を確認してください'):''};
 // No R1 action is offered without records. Normal integration safety still runs.
 if(!records.length&&!chosen)return {top,receipt,snapshot:null,public:info};
 const snapshot={target:targetTop,otherTarget:top===targetTop?null:h.gitw.inspect(a.target,{readOnly:true}),head:g(top,['rev-parse','HEAD']).toString().trim(),index:index(top),status:rows,files:rows.map(row=>[row.slice(3),writes.state(path.join(top,row.slice(3)))]),parent:require('./integration-safety').confirmationParent(a),items:related.map(x=>[x.dir,x.id,hash(fs.readFileSync(path.join(x.dir,'.ai/tasks',x.id+'.md'))),outputState(x.dir,x.id),x.id===a.t.id&&x.project.id===a.p.id?null:require('./integration-safety').item(h,h.details(a,x.project,x.task))]),record:hash(JSON.stringify(h.read(a.p.id,a.t.id)))};
 return {top,receipt,snapshot,public:info};
}
function preview(h,a){try{const s=scan(h,a);return {...s.public,fingerprint:hash(JSON.stringify(s.snapshot))};}catch{const uncertain=unresolved(h,a);return {allowed:false,unresolved:uncertain,records:[],products:[],reason:lt(uncertain?'Hub記録の保存結果が不明です。再送せず保存記録を確認してください':'Hub記録の保存状態を読み取れません')};}}
function save(h,b){const x=h.tokens.get(b.token),d=x?.value;if(!d?.simple||d.auto||d.resume||d.project!==b.project||d.task!==b.task||b.confirm!==true||Date.now()-x.at>600000||!d.recordSave?.allowed)throw Error(lt('最新のHub記録を確認してください'));
 h.tokens.delete(b.token);const a=h.ancestor(b.project,b.task),selected=scan(h,a);
 return require('./git').withCommonGit(selected.top,()=>{
  const before=scan(h,a);if(!before.public.allowed||hash(JSON.stringify(before.snapshot))!==d.recordSave.fingerprint)throw Object.assign(Error(lt('確認中にHub記録・成果・保存先が変わりました')),{delivery:{state:before.public.unresolved?'unknown':'not-sent'}});
  const paths=before.public.records.map(x=>x.path),packet={phase:'intent',parent:before.snapshot.head,paths,project:b.project,task:b.task,request:hash(b.token)};
  const untracked=before.snapshot.status.filter(row=>row.startsWith('?? ')&&paths.includes(row.slice(3))).map(row=>row.slice(3)),original={bytes:fs.readFileSync(indexFile(before.top)),mode:fs.statSync(indexFile(before.top)).mode&0o777};writes.atomic(before.receipt,packet);let sent=false,prepared;
  try{
   const again=scan(h,a,before.top); // Our own intent is expected; all original state must still match.
   if(hash(JSON.stringify(again.snapshot))!==d.recordSave.fingerprint||stopped(before.top))throw Error('changed');
   if(untracked.length){
    g(before.top,['add','--intent-to-add','--',...literal(untracked)]);const current=index(before.top),empty=g(before.top,['hash-object','--stdin']).toString().trim(),rows=current.rows.split('\0').filter(Boolean);
    const added=rows.filter(row=>untracked.includes(row.slice(row.indexOf('\t')+1)));if(added.length!==untracked.length||added.some(row=>!new RegExp('^100(?:644|755) '+empty+' 0\\t').test(row))||rows.filter(row=>!untracked.includes(row.slice(row.indexOf('\t')+1))).join('\0')+'\0'!==before.snapshot.index.rows)throw Error('registration');
    prepared=current;
    const check=scan(h,a,before.top);check.snapshot.status=check.snapshot.status.map(row=>untracked.includes(row.slice(3))&&row.startsWith(' A ')?'?? '+row.slice(3):row);check.snapshot.index=before.snapshot.index;
    if(hash(JSON.stringify(check.snapshot))!==d.recordSave.fingerprint||index(before.top).sha!==prepared.sha||stopped(before.top))throw Error('changed after registration');
   }
   sent=true;g(before.top,[...commitOptions,'commit','--only','-m',`Hub records: ${paths.length} (${b.task})`,'--',...literal(paths)]);
   const head=g(before.top,['rev-parse','HEAD']).toString().trim(),parent=g(before.top,['rev-parse','HEAD^']).toString().trim();if(head===before.snapshot.head||parent!==before.snapshot.head)throw Error('head');
   const changed=g(before.top,['diff-tree','--no-commit-id','--name-only','-r','-z',parent,head]).toString().split('\0').filter(Boolean);if(changed.length!==paths.length||changed.some(p=>!paths.includes(p)))throw Error('paths');
   if(g(before.top,['diff','--cached','--name-only']).length||stopped(before.top))throw Error('index');
   const after=scan(h,a,before.top),expected=before.snapshot.files.filter(([p])=>!paths.includes(p));if(JSON.stringify(after.snapshot.files)!==JSON.stringify(expected)||after.snapshot.parent!==before.snapshot.parent||JSON.stringify(after.snapshot.items)!==JSON.stringify(before.snapshot.items)||after.snapshot.record!==before.snapshot.record||JSON.stringify(after.snapshot.otherTarget)!==JSON.stringify(before.snapshot.otherTarget))throw Error('post');
   for(const p of paths){const file=path.join(before.top,p),original=before.snapshot.files.find(([n])=>n===p)[1];if(writes.state(file)!==original)throw Error('content');const tree=g(before.top,['ls-tree','HEAD','--',p]).toString(),mode=(Number(original.split(':')[1])&0o111)?'100755':'100644';if(!tree.startsWith(mode+' blob ')||hash(g(before.top,['show','HEAD:'+p]))!==original.split(':')[0])throw Error('blob');}
   for(const p of paths)writes.committed(path.join(before.top,p));
   writes.atomic(before.receipt,{...packet,phase:'done',head});return {ok:true,saved:true,commit:head,paths};
  }catch{if(!sent){const unchanged=g(before.top,['rev-parse','HEAD']).toString().trim()===before.snapshot.head&&index(before.top).sha===before.snapshot.index.sha;if(!unchanged&&!(prepared&&undoPreparation(before.top,before.snapshot.head,prepared,original)))sent=true;}try{writes.atomic(before.receipt,{...packet,phase:sent?'unknown':'not-sent'});}catch{}throw Object.assign(Error(lt(sent?'Hub記録の保存結果が不明です。再送せず保存記録を確認してください':'Hub記録の保存は開始していません。最新の記録を確認してください')),{delivery:{state:sent?'unknown':'not-sent'}});}
 });
}
module.exports={preview,save,unresolved};
