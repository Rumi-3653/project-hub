'use strict';
// Read-only Claude tools cannot run git. Supply the saved ranges as immutable
// raw evidence, without the implementation conversation or its verdict.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process'),{createHash}=require('node:crypto');
const git=require('./git'),{noLinks,snapshot}=require('./remove');
const writes=require('./integration-writes');
function filesEvidence({dir,files}){
  noLinks(dir);const stat=fs.statSync(dir);
  return {version:1,dir:path.resolve(dir),identity:[stat.dev,stat.ino],files:[...new Set(files)].sort().map(file=>{noLinks(file);return {path:file,fingerprint:snapshot(file,{contentOnly:true})};})};
}
function verifyFiles(e,dir){
  if(e?.version!==1||e.dir!==path.resolve(dir)||JSON.stringify(e)!==JSON.stringify(filesEvidence({dir,files:e.files.map(f=>f.path)})))throw Error('Integration file review range changed');
}
function prepare({dir,pdir,task,key,targetHead,reviewHead,sourceHead,fileReview,savedResults,stoppedSibling,reportProjection}){
  if(!/^[a-f0-9]{64}$/.test(key)||!/^\d{8}-[\w-]+$/.test(task))throw Error('Invalid integration review identity');
  if(fileReview){
    if(targetHead||reviewHead||sourceHead||git.inspect(dir,{readOnly:true}))throw Error('Invalid integration file review range');
    verifyFiles(fileReview,dir);
    let bytes=0;const texts=fileReview.files.filter(f=>fs.statSync(f.path).isFile()).map(f=>{const data=fs.readFileSync(f.path);bytes+=data.length;if(bytes>64*1024*1024)throw Error('Integration file review too large');return '\n## file '+f.path+'\n'+(data.includes(0)?data.toString('base64'):data.toString('utf8'));}).join('');
    verifyFiles(fileReview,dir);
    return save(pdir,task,key,JSON.stringify({key,fileReview},null,2)+'\n## integration\nファイル成果の受領のみ。Git変更・本体反映なし。\n'+texts);
  }
  const refs=[targetHead,reviewHead,...(sourceHead?[sourceHead]:[])];
  if(!refs.every(h=>/^[a-f0-9]{40,64}$/.test(h||'')))throw Error('Invalid integration review range');
  noLinks(dir);const current=writes.inspect(git,dir);
  if(!current||current.status||current.head!==reviewHead||git.merging(dir)||![targetHead,reviewHead,...(!reportProjection&&sourceHead?[sourceHead]:[])].every(h=>git.isAncestor(dir,h)))throw Error('Integration review range changed');
  if(reportProjection){if(!stoppedSibling||reportProjection.sourceHead!==sourceHead||reportProjection.targetHead!==targetHead)throw Error('Integration report review range changed');require('./integration-report-projection').verify(dir,reportProjection,reviewHead);}
  const read=args=>execFileSync('git',['-C',dir,'--no-pager',...args],{encoding:'utf8',maxBuffer:64*1024*1024,stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'}});
  const diff=(from,to,paths=[])=>read(['--literal-pathspecs','diff','--binary','--no-ext-diff','--no-textconv',from,to,'--',...paths]);
  const evidence={version:1,key,targetHead,reviewHead,sourceHead:sourceHead||null,...(stoppedSibling?{stoppedSibling,scope:"今回の報告差分 integration/child の保管・受領のみ。resolution は履歴比較であり旧停止のコードを承認しない。静的検査スクリプトも実行しない。本体反映・Windows安全判定なし。"}:{}),
    integration:diff(targetHead,reviewHead),
    ...(reportProjection?{reportProjection,receiptScope:'列挙した報告だけを受領。sourceHeadは出典であり、子の引継ぎメモ・履歴全体の受領ではない。',child:diff(reportProjection.base,sourceHead,reportProjection.entries.map(e=>e.path)),resolution:'引継ぎメモは子に保持。元HEAD全体との比較は承認範囲外。'}:sourceHead?{child:diff(read(['merge-base',targetHead,sourceHead]).trim(),sourceHead),resolution:diff(sourceHead,reviewHead)}:{}),
    history:read(['log','--format=%H %P %s',targetHead+'..'+reviewHead,'--'])};
  const after=writes.inspect(git,dir);
  if(after?.head!==reviewHead||after?.status)throw Error('Integration review range changed');
  // Keep diffs as actual lines: read-only tools truncate very long JSON lines.
  const {integration,child,resolution,history,...identity}=evidence;
  if(savedResults){
    if(sourceHead||![1,2,3].includes(savedResults.version)||savedResults.version>=2&&!savedResults.scope?.originals?.length||savedResults.version===3&&(!savedResults.priorReview?.text||!savedResults.supplement||!savedResults.manifest?.length||savedResults.receiptScope?.implementationAccepted!==false||savedResults.receiptScope?.bodyApplied!==false)||!savedResults.commits?.length||!savedResults.testFiles?.length)throw Error('Saved result review range missing');
    const value={...savedResults};delete value.sha256;
    if(createHash('sha256').update(JSON.stringify(value)).digest('hex')!==savedResults.sha256)throw Error('Saved result review evidence changed');
  }
  const text=JSON.stringify(identity,null,2)+'\n\n## integration\n'+integration+'\n## child\n'+(child||'')+'\n## resolution\n'+(resolution||'')+'\n## history\n'+history+(savedResults?require('./integration-review-results').render(savedResults):'');
  return save(pdir,task,key,text);
}
function save(pdir,task,key,text){
  const file=path.join(pdir,'.ai','chat',task+'.integration-review-'+key+'.txt');
  noLinks(file);fs.mkdirSync(path.dirname(file),{recursive:true});
  writes.write(file,()=>{try{fs.writeFileSync(file,text,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST'||fs.readFileSync(file,'utf8')!==text)throw e;}});
  return {file,sha256:createHash('sha256').update(text).digest('hex')};
}
module.exports={prepare,filesEvidence,verifyFiles};
