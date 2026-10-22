'use strict';
// Already saved results are a review range even when no child copy is merged.
// Read-only snapshots bind declarations, commits, deliverables and test originals.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process'),{createHash}=require('node:crypto');
const {noLinks,inside}=require('./remove');
const git=require('./git');
const hash=x=>createHash('sha256').update(typeof x==='string'||Buffer.isBuffer(x)?x:JSON.stringify(x)).digest('hex');
const max=64*1024*1024;
function collect(h,r,i,{scoped=false}={}){
  const p=h.store.readProject(i.project),taskFile=h.store.taskFile(i.project,i.task);
  if(!p||!taskFile||i.source||!i.results?.some(x=>x.kind==='本体保存済み'))throw Error('Saved result review range missing');
  noLinks(p.dir);noLinks(taskFile);
  const originals=[],manifest=[],commits=[];let bytes=0;
  const add=(file,text=false)=>{
    noLinks(file);const st=fs.statSync(file);if(!st.isFile()||st.nlink!==1)throw Error('Saved result review requires regular files');
    const data=fs.readFileSync(file);bytes+=data.length;if(bytes>max)throw Error('Saved result review too large');
    const after=fs.statSync(file);if(st.ino!==after.ino||st.size!==after.size||st.mtimeMs!==after.mtimeMs||st.ctimeMs!==after.ctimeMs)throw Error('Saved result review changed');
    const item={path:file,size:data.length,mode:st.mode&0o777,sha256:hash(data)};manifest.push(item);if(manifest.length>2048)throw Error('Saved result review has too many files');
    if(text){
      if(data.includes(0))throw Error('Saved result review text is binary');
      const lines=data.toString('utf8').split('\n'),ranges=lines.length>256?[[1,128],[lines.length-127,lines.length]]:[[1,lines.length]];
      originals.push({...item,lineCount:lines.length,ranges:ranges.map(([start,end])=>({start,end,text:lines.slice(start-1,end).join('\n')}))});
    }
  };
  const walk=(file,text=false)=>{
    noLinks(file);const st=fs.statSync(file);
    if(st.isDirectory()){for(const name of fs.readdirSync(file).sort()){if(name==='.git')continue;walk(path.join(file,name),text);}}
    else add(file,text);
    if(manifest.length>2048)throw Error('Saved result review has too many files');
  };
  add(taskFile,true);
  const roots=[p.dir,...i.results.filter(x=>x.kind==='本体保存済み').map(x=>x.dir)].map(x=>path.resolve(x));
  for(const f of i.files||[]){if(!roots.some(root=>inside(root,path.resolve(f.path))))throw Error('Saved result review path outside declared repository');walk(f.path);}
  for(const row of i.results.filter(x=>x.kind==='本体保存済み')){
    noLinks(row.dir);if(!/^[a-f0-9]{40,64}$/.test(row.commit||'')||!git.isAncestor(row.dir,row.commit))throw Error('Saved result commit missing');
    const read=args=>execFileSync('git',['-C',row.dir,'--no-pager',...args],{encoding:'utf8',maxBuffer:max,stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'}});
    const patch=read(['show','--format=fuller','--stat','--patch','--no-ext-diff','--no-textconv',row.commit,'--']);
    bytes+=Buffer.byteLength(patch);if(bytes>max)throw Error('Saved result review too large');
    commits.push({declaration:row,patch});
  }
  // Only this task's evidence names are eligible, including its test/install
  // subdirectories. No chat, unrelated project or arbitrary path is collected.
  const work=path.join(p.dir,'.ai','work'),testFiles=[];
  if(fs.existsSync(work)){noLinks(work);
    const scan=file=>{noLinks(file);const st=fs.statSync(file);if(st.isDirectory()){for(const n of fs.readdirSync(file).sort())scan(path.join(file,n));}else if(/\.(log|tap|json|md|txt)$/.test(file)){testFiles.push(file);add(file,true);}};
    for(const name of fs.readdirSync(work).sort())if(name.startsWith(i.task+'-'))scan(path.join(work,name));
  }
  if(!testFiles.length)throw Error('Saved result related test originals missing');
  const value={version:scoped?2:1,project:i.project,task:i.task,taskFile,results:i.results,commits,manifest,originals,testFiles};
  if(scoped)value.scope=scope(h,r,i,p,manifest);
  return {...value,sha256:hash(value)};
}
// Scope is evidence for the reviewer, not an automatically granted exemption.
// Keep v1 readable so an already accepted request can be supplemented without
// editing its old material. New requests always use v2 and full scope originals.
function scope(h,r,i,p,manifest){
  const files=new Map(),absent=[];let bytes=0;
  const add=(file,kind,required=false)=>{
    noLinks(file);
    if(!fs.existsSync(file)){if(required)throw Error('Saved result scope original missing: '+kind);absent.push({path:file,kind});return;}
    if(files.has(file))return;
    const st=fs.statSync(file),data=fs.readFileSync(file),after=fs.statSync(file);bytes+=data.length;
    if(!st.isFile()||st.nlink!==1||data.includes(0)||bytes>max||st.ino!==after.ino||st.size!==after.size||st.mtimeMs!==after.mtimeMs||st.ctimeMs!==after.ctimeMs)throw Error('Saved result scope original changed');
    const lines=data.toString('utf8').split('\n');
    files.set(file,{path:file,kind,sha256:hash(data),mode:st.mode&0o777,lineCount:lines.length,ranges:[{start:1,end:lines.length,text:lines.join('\n')}],languageReferences:lines.flatMap((text,n)=>/日本語|繁[體体]|日繁|zh[-_]TW|Traditional Chinese|bilingual/i.test(text)?[{line:n+1,text}]:[])});
    return data.toString('utf8');
  };
  add(path.join(p.dir,'PROJECT.md'),'project',true);
  add(path.join(p.dir,'.ai/rules.md'),'project-rules');
  const tasks=[i.task,...(r.project===i.project&&r.task!==i.task?[r.task]:[])],seen=new Set();
  for(let n=0;n<tasks.length;n++){
    const id=tasks[n];if(seen.has(id))continue;
    if(!/^\d{8}-[\w-]+$/.test(id)||seen.size>=32)throw Error('Saved result scope task relation missing');seen.add(id);
    const file=h.store.taskFile(i.project,id);if(!file)throw Error('Saved result scope task original missing');
    const text=add(file,'task',true),parent=text?.match(/^parent:[ \t]*([^\r\n]*)/m)?.[1]?.trim();
    if(parent&&parent!==id&&!seen.has(parent))tasks.push(parent);
    if(parent===id)throw Error('Saved result scope task relation changed');
    add(path.join(p.dir,'.ai/chat',id+'.rules.md'),'task-rules');
  }
  const histories=[];
  for(const row of i.results.filter(x=>x.kind==='本体保存済み')){
    const names=execFileSync('git',['-C',row.dir,'ls-tree','-r','--name-only',row.commit],{encoding:'utf8',maxBuffer:max,stdio:['ignore','pipe','pipe']}).trim().split('\n');
    // Include actual project documentation, including existing bilingual
    // versions, even when it is absent from the declared product manifest.
    for(const name of names.filter(n=>/(?:^|\/)(?:README(?:[.\w-]*)|CHANGELOG)\.md$/i.test(n)))add(path.join(row.dir,name),'saved-documentation',true);
    histories.push({dir:row.dir,commit:row.commit,text:execFileSync('git',['-C',row.dir,'--no-pager','log','-20','--format=%H %P %s',row.commit,'--'],{encoding:'utf8',maxBuffer:max,stdio:['ignore','pipe','pipe']})});
  }
  return {version:1,policy:'Determine applicable languages and history from original requirements and actual artifacts; no automatic exemption. Missing applicable requirements or history cannot pass.',originals:[...files.values()],absent,histories,languageArtifacts:manifest.filter(f=>/(?:zh[-_]TW|繁[體体]|\.lproj\/|\.strings(?:dict)?$)/i.test(f.path)).map(f=>({path:f.path,sha256:f.sha256}))};
}
function verify(e,h,r,i){if(e?.version===3)return require('./integration-review-supplement').verify(e,h,r,i);if(![1,2].includes(e?.version)||JSON.stringify(e)!==JSON.stringify(collect(h,r,i,{scoped:e.version===2})))throw Error('Saved result review evidence changed');}
function verifyRecovery(e,row){noLinks(e.oldEvidence.file);if(hash(fs.readFileSync(e.oldEvidence.file))!==e.oldEvidence.sha256||hash(row)!==e.completionHash)throw Error('Original insufficient review evidence changed');}
const originals=files=>files.map(f=>'\n## original '+f.path+' (SHA256 '+f.sha256+'; total lines '+f.lineCount+')\n'+f.ranges.map(x=>'### lines '+x.start+'-'+x.end+'\n'+x.text).join('\n')).join('');
function render(e){return '\n## saved-results\n'+JSON.stringify({project:e.project,task:e.task,sha256:e.sha256,results:e.results,manifest:e.manifest,...(e.version===3?{receiptScope:e.receiptScope,priorReview:e.priorReview}:{})},null,2)+(e.version===3?'\n## prior-refusal (evidence only; resolve all findings)\n'+e.priorReview.text:'')+'\n'+e.commits.map(c=>'\n## saved-commit '+c.declaration.commit+'\n'+c.patch+(c.history?'\n## retained-history\n'+c.history:'')).join('')+originals(e.originals)+(e.scope?'\n## review-scope\n'+JSON.stringify({...e.scope,originals:e.scope.originals.map(({ranges,...f})=>f)},null,2)+'\n## scope-originals\n'+originals(e.scope.originals):'');}
// The legacy request had no source and four empty sections. A closed, isolated
// materials-only refusal can be supplemented once; a fail/unknown cannot.
function recovery(h,r,i,a,k,row){
  if(a.savedResults)return scopeRecovery(h,r,i,a,k,row);
  if(a.evidenceRecovery||a.savedResults||i.source||a.sourceHead||a.targetHead!==a.reviewHead||!a.isolatedReview||a.delivery?.state!=='accepted'||row.error||row.asks?.length||row.integrationAuto?.closed!==true||row.integrationAuto.key!==k||row.integrationAuto.phase!=='review')return null;
  const proof=row.integrationAuto.isolation;
  if(proof?.version!==1||proof.resumed!==false||!proof.session||proof.request!==a.delivery.request)return null;
  const text=String(row.text||'');
  if(!/^判定：要修正（確認資料不足）[。.]?$/m.test(text)||!text.includes('指定Git範囲も同一HEAD間で差分ゼロ')||/\[integration-review:[^\]]+\]|判定：(?:不合格|要修正[（(](?!確認資料不足))/u.test(text))return null;
  const file=path.join(h.store.readProject(r.project).dir,'.ai','chat',r.task+'.integration-review-'+k+'.txt');noLinks(file);
  const original=fs.readFileSync(file,'utf8'),expected=JSON.stringify({version:1,key:k,targetHead:a.targetHead,reviewHead:a.reviewHead,sourceHead:null},null,2)+'\n\n## integration\n\n## child\n\n## resolution\n\n## history\n';
  if(original!==expected)return null;
  const savedResults=collect(h,r,i);
  return {savedResults,oldEvidence:{file,sha256:hash(original)},completionHash:hash(row)};
}
function scopeRecovery(h,r,i,a,k,row){
  // Only the old, scoped-insufficient supplemental request may transition.
  // A v2 request, a real failure or an unknown dispatch never becomes a retry.
  if(a.scopeRecovery||a.savedResults?.version!==1||!a.evidenceRecovery||i.source||a.sourceHead||a.targetHead!==a.reviewHead||!a.isolatedReview||a.delivery?.state!=='accepted'||row?.error||row?.asks?.length||row?.integrationAuto?.closed!==true||row.integrationAuto.key!==k||row.integrationAuto.phase!=='review')return null;
  const proof=row.integrationAuto.isolation,text=String(row.text||'');
  if(proof?.version!==1||proof.resumed!==false||!proof.session||proof.request!==a.delivery.request)return null;
  // Match the complete materials-only response, not keywords inside a real
  // failure. Extra findings must not silently gain permission to re-review.
  const insufficient=/^(?:判定：)?要修正（確認資料不足）(?:です)?[。.]?\n\n(?:成果の整合は確認できました。|保存commit \d+件、manifest \d+ファイル、試験原物\d+件の整合は確認できました。同時稼働・削除・失敗復旧のローカル試験も成功しています。)\n(?:\n)?ただし、依頼の「日繁履歴」は照合できません。保存差分のhistory欄は空で、繁體中文の履歴と保存範囲を確認できる証跡がありません。該当原物の提示、または対象外とする範囲の明記が必要です。$/;
  // The historical closed message also contains these three progress notes.
  // Permit that exact prefix; arbitrary additional findings remain a refusal.
  const notes="保存差分と試験原物を読み、機能・日繁履歴・保存範囲を照合して判定します。編集や試験の再実行は行いません。\n\n保存差分原物のSHA-256は指定値と一致しました。integration・child・resolution・history欄は空ですが、保存成果・3件のcommit・試験原物は含まれているため、その一式を確認しています。\n\nmanifestの68ファイルと、保存commit 3件の差分は原物に一致しています。試験ログは同時稼働・削除・失敗復旧のローカル検査成功を示しています。後続の受信箱改修も存在するため、今回の1.4.0成果の保存範囲と、日繁履歴の確認根拠を分けて照合します。\n\n";
  const verdict=text.trim().startsWith(notes)?text.trim().slice(notes.length):text.trim();
  if(!insufficient.test(verdict))return null;
  if(!String(a.request?.text||'').includes('やる：双方の機能・日繁履歴と保存済み範囲、関連試験の意味と成功を照合する。'))return null;
  verify(a.savedResults,h,r,i);
  const file=path.join(h.store.readProject(r.project).dir,'.ai/chat',r.task+'.integration-review-'+k+'.txt');noLinks(file);
  const original=fs.readFileSync(file,'utf8'),expected=JSON.stringify({version:1,key:k,targetHead:a.targetHead,reviewHead:a.reviewHead,sourceHead:null},null,2)+'\n\n## integration\n\n## child\n\n## resolution\n\n## history\n'+render(a.savedResults);
  if(original!==expected)return null;
  const savedResults=collect(h,r,i,{scoped:true});
  return {savedResults,scopeRecovery:true,oldEvidence:{file,sha256:hash(original)},completionHash:hash(row),savedResultsHash:a.savedResults.sha256,deliveryHash:hash(a.delivery),requestHash:hash(a.request),previousSession:proof.session};
}
function verifyScopeRecovery(e,a,row){
  verifyRecovery(e,row);
  // The complete old request authorized this supplement. Its target, identity
  // and content must stay fixed through queues, limit switches and receipt.
  if(a?.savedResults?.version!==1||a.savedResults.sha256!==e.savedResultsHash||hash(a.delivery)!==e.deliveryHash||!e.requestHash||!a.request||hash(a.request)!==e.requestHash||row.integrationAuto?.isolation?.session!==e.previousSession)throw Error('Original insufficient scope request changed');
}
module.exports={collect,verify,verifyRecovery,verifyScopeRecovery,render,recovery,scope};
