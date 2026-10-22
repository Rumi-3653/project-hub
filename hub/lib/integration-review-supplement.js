'use strict';
// Explicit, content-bound repair of an empty file-only review. A supplement is
// material for a NEW isolated review, never a verdict or a receipt authorization.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto'),{execFileSync}=require('node:child_process');
const {inside,noLinks}=require('./remove');
const hash=x=>createHash('sha256').update(typeof x==='string'||Buffer.isBuffer(x)?x:JSON.stringify(x)).digest('hex');
const max=64*1024*1024;
function relative(root,name){
  if(typeof name!=='string'||!name||path.isAbsolute(name)||name.split(/[\\/]/).some(n=>!n||n==='.'||n==='..')||name.includes('\0'))throw Error('Invalid review supplement path');
  const file=path.resolve(root,name);if(!inside(path.resolve(root),file))throw Error('Review supplement path outside project');noLinks(file);return file;
}
function descriptor(value,r){
  if(!r?.auto?.mode||!value||Object.keys(value).sort().join(',')!=='attempt,file,sha256'||!/^[a-f0-9]{64}$/.test(value.attempt||'')||!/^[a-f0-9]{64}$/.test(value.sha256||'')||!value.file?.startsWith('.ai/work/'+r.task+'-'))throw Error('Invalid review supplement identity');
  return {attempt:value.attempt,file:value.file,sha256:value.sha256};
}
function latest(h,r,k,row){
  const p=h.store.readProject(r.project);noLinks(path.join(p.dir,'.ai/chat',r.task+'.jsonl'));
  const last=require('./chat').read(p.dir,r.task).findLast(x=>x.role==='assistant'&&x.integrationAuto?.key===k&&x.integrationAuto.phase==='review');
  if(!last||last.integrationAuto.closed!==true||hash(last)!==hash(row))throw Error('Latest artifact review is not the original closed completion');
}
function collect(h,r,i,input,priorReview){
  const spec=descriptor(input,r),p=h.store.readProject(i.project);
  if(!p||r.project!==i.project||i.source||!i.files?.length||i.results?.some(x=>x.kind!=='ファイル'))throw Error('Review supplement requires file-only results');
  let bytes=0;const manifest=[],originals=[],byPath=new Map();
  const add=(file,text=false)=>{
    if(byPath.has(file))return byPath.get(file);
    noLinks(file);const st=fs.statSync(file);if(!st.isFile()||st.nlink!==1)throw Error('Review supplement requires regular originals');
    const data=fs.readFileSync(file),after=fs.statSync(file);bytes+=data.length;
    if(bytes>max||manifest.length>=2048||st.ino!==after.ino||st.size!==after.size||st.mtimeMs!==after.mtimeMs||st.ctimeMs!==after.ctimeMs)throw Error('Review supplement original changed or too large');
    const item={path:file,size:data.length,mode:st.mode&0o777,sha256:hash(data)};manifest.push(item);byPath.set(file,{item,data});
    if(text){if(data.includes(0))throw Error('Review supplement text is binary');const lines=data.toString('utf8').split('\n');originals.push({...item,lineCount:lines.length,ranges:[{start:1,end:lines.length,text:lines.join('\n')}]});}
    return {item,data};
  };
  const file=relative(p.dir,spec.file),raw=add(file,true);
  if(raw.item.sha256!==spec.sha256)throw Error('Review supplement fingerprint changed');
  const s=JSON.parse(raw.data.toString('utf8')),taskFile=h.store.taskFile(i.project,i.task);
  if(s.version!==1||s.integration?.id!==r.id||typeof i.keep!=='boolean'||s.integration.keep_at_start!==i.keep||s.child?.task!==path.relative(p.dir,taskFile)||s.child.sha256!==i.taskHash||s.child.sha256!==add(taskFile,true).item.sha256)throw Error('Review supplement task or original choice changed');
  const declared=new Set();
  const walk=f=>{noLinks(f);const st=fs.statSync(f);if(st.isDirectory()){for(const n of fs.readdirSync(f).sort())walk(path.join(f,n));}else {if(!inside(p.dir,f)||declared.has(f))throw Error('Review supplement duplicate or outside artifact');declared.add(f);}};
  for(const f of i.files)walk(f.path);
  if(!Array.isArray(s.child.files)||!s.child.files.length||s.child.count!==s.child.files.length||declared.size!==s.child.files.length)throw Error('Review supplement artifact range changed');
  let total=0;const seen=new Set();
  for(const f of s.child.files){
    const artifact=relative(p.dir,f.path);if(!declared.has(artifact)||seen.has(artifact))throw Error('Review supplement artifact range changed');seen.add(artifact);
    const {item}=add(artifact,/\.(?:html?|css|js|php|log|tap|json|md|txt)$/i.test(artifact));total+=item.size;
    if(f.bytes!==item.size||f.sha256!==item.sha256||f.mode!=='0o'+item.mode.toString(8))throw Error('Review supplement artifact fingerprint changed');
  }
  if(total!==s.child.total_bytes)throw Error('Review supplement artifact total changed');
  const testFiles=[];
  for(const f of Object.values(s.saved_test_originals||{})){
    const original=relative(p.dir,f.path),v=byPath.get(original);
    if(!declared.has(original)||!v||f.sha256!==v.item.sha256||f.text!==v.data.toString('utf8'))throw Error('Review supplement test original changed');testFiles.push(original);
  }
  if(!testFiles.length||!testFiles.some(f=>/\.(?:log|tap)$/.test(f)))throw Error('Review supplement test originals missing');
  // Retained commits may deliberately NOT be ancestors of the applied body.
  // Read their real objects, history and current HEAD; never merge or certify them.
  const commits=[],repos=new Map();
  for(const c of s.child.retained_code||[]){
    if(typeof c.repository!=='string'||!c.repository.startsWith('body:')||!/^[a-f0-9]{40,64}$/.test(c.commit||'')||!/^[a-f0-9]{40,64}$/.test(s.repositories?.base||''))throw Error('Review supplement retained history missing');
    const dir=relative(r.target,c.repository.slice(5));relative(dir,c.path);
    const read=args=>execFileSync('git',['-C',dir,'--no-pager',...args],{maxBuffer:max,stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'}});
    if(read(['rev-parse','--show-toplevel']).toString().trim()!==dir)throw Error('Review supplement repository changed');
    const code=read(['show',c.commit+':'+c.path]),base=read(['show',s.repositories.base+':'+c.path]);
    if(code.length!==c.bytes||hash(code)!==c.sha256||hash(base)!==c.base_sha256)throw Error('Review supplement retained code changed');
    const key=dir+'\0'+c.commit;
    if(!repos.has(key)){
      const patch=read(['show','--format=fuller','--stat','--patch','--no-ext-diff','--no-textconv',c.commit,'--']).toString('utf8'),history=read(['log','-20','--format=%H %P %s',c.commit,'--']).toString('utf8');
      bytes+=Buffer.byteLength(patch)+Buffer.byteLength(history);if(bytes>max)throw Error('Review supplement history too large');
      const value={declaration:{dir,commit:c.commit,scope:'retained history only; implementation acceptance and deployment pending'},head:read(['rev-parse','HEAD']).toString().trim(),patch,history};repos.set(key,value);commits.push(value);
    }
  }
  if(!commits.length||!s.resolution?.remaining?.length||!s.history)throw Error('Review supplement history or remaining work missing');
  const value={version:3,project:i.project,task:i.task,taskFile,results:i.results,commits,manifest,originals,testFiles,supplement:spec,priorReview,
    receiptScope:{keep:i.keep,disposition:i.disposition,remainingSteps:i.remainingSteps,remaining:i.remaining,implementationAccepted:false,bodyApplied:false,resolution:s.resolution},
    scope:require('./integration-review-results').scope(h,r,i,p,manifest)};
  return {...value,sha256:hash(value)};
}
function recovery(h,r,i,a,k,row,input){
  const spec=descriptor(input,r),proof=row?.integrationAuto?.isolation;
  if(spec.attempt!==k||a.phase!=='review'||a.savedResults||a.evidenceRecovery||a.artifactRecovery||i.source||a.sourceHead||a.targetHead!==a.reviewHead||!a.isolatedReview||!a.request||a.delivery?.state!=='accepted'||row?.integrationAuto?.limit===true||row?.error||row?.asks?.length||row?.integrationAuto?.closed!==true||row.integrationAuto.key!==k||row.integrationAuto.phase!=='review'||proof?.version!==1||proof.resumed!==false||!proof.session||proof.request!==a.delivery.request||!row.text||/\[integration-review:[^\]]+\]/.test(row.text))throw Error('Empty artifact review is not eligible for supplementation');
  latest(h,r,k,row);
  const p=h.store.readProject(r.project),file=path.join(p.dir,'.ai/chat',r.task+'.integration-review-'+k+'.txt');noLinks(file);
  const original=fs.readFileSync(file,'utf8'),expected=JSON.stringify({version:1,key:k,targetHead:a.targetHead,reviewHead:a.reviewHead,sourceHead:null},null,2)+'\n\n## integration\n\n## child\n\n## resolution\n\n## history\n';
  if(original!==expected)throw Error('Original empty artifact review changed');
  const savedResults=collect(h,r,i,spec,{attempt:k,text:row.text,request:a.request,oldEvidence:{file,sha256:hash(original)}}),s=JSON.parse(savedResults.originals[0].ranges[0].text);
  if(s.old_review?.path!==path.relative(p.dir,file)||s.old_review.sha256!==hash(original))throw Error('Review supplement original review mismatch');
  return {artifactRecovery:true,savedResults,oldEvidence:{file,sha256:hash(original)},completionHash:hash(row),deliveryHash:hash(a.delivery),requestHash:hash(a.request),previousSession:proof.session,refusal:row.text};
}
function verify(e,h,r,i){if(e?.version!==3||JSON.stringify(e)!==JSON.stringify(collect(h,r,i,e.supplement,e.priorReview)))throw Error('Review supplement evidence changed');}
function verifyRecovery(e,a,row,h,r){
  latest(h,r,e.attempt,row);
  require('./integration-review-results').verifyRecovery(e,row);
  if(a?.phase!=='superseded'||hash(a.delivery)!==e.deliveryHash||hash(a.request)!==e.requestHash||row?.integrationAuto?.isolation?.session!==e.previousSession||row.text!==e.refusal)throw Error('Original empty artifact review request changed');
}
module.exports={descriptor,collect,recovery,verify,verifyRecovery};
