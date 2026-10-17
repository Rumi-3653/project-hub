'use strict';
// Read-only preflight. Never return Git stderr, file contents or local secret names.
const {lt}=require('./locale');
const path=require('node:path'),{execFileSync}=require('node:child_process'),writes=require('./integration-writes');
function safePaths(dir,ignore=[]){
 const rows=execFileSync('git',['-C',dir,'status','--porcelain','--no-renames','--untracked-files=all','-z'],{env:{...process.env,GIT_OPTIONAL_LOCKS:'0'},stdio:['ignore','pipe','pipe'],maxBuffer:16*1024*1024}).toString().split('\0').filter(Boolean);
 const paths=[],hidden=[];
 for(const row of rows){const f=row.slice(3);if(ignore.includes(f))continue;
  if(!f||path.isAbsolute(f)||f.split('/').includes('..')||/[\u0000-\u001f\u007f]/.test(f)||/(^|\/)(\.env(?:\..*)?|\.npmrc|\.dev\.vars(?:\..*)?|settings\.local\.json)$|secret|credential|password|token|auth|private.?key/i.test(f)){hidden.push(f);continue;}
  if(paths.length<100)paths.push(f);
 }
 return {paths,hiddenPaths:hidden.length,morePaths:Math.max(0,rows.length-ignore.length-hidden.length-paths.length)};
}
function check(gitw,dir,side){
 const label=side==='source'?'作業用コピー':'本体';
 const blocker=(kind,details={})=>({side,kind,reason:lt(kind==='dirty'?`${label}に未保存の変更があります`:kind==='merging'?`${label}のマージが途中です`:`${label}の保存状態を読み取れません`),next:lt(kind==='dirty'?`${label}の変更内容を確認し、必要な変更をGitに保存してから、最新の記録を確認してください`:kind==='merging'?`${label}のマージを完了または安全に中止してから、最新の記録を確認してください`:`${label}の場所・Git・読取権限を確認してから、最新の記録を確認してください`),paths:[],...details});
 try{
  if(!dir)return {blocker:blocker('unreadable')};
  if(gitw.merging(dir))return {blocker:blocker('merging')};
  const targetProblem=side==='target'&&gitw.mergeTargetProblem?.(dir);
  if(targetProblem)return {blocker:blocker(targetProblem,{reason:targetProblem==='bisect'?'本体でGitの原因調査が途中です':'本体のブランチが選ばれていません',next:'本体の保存先とGitの状態を確認してから、最新の記録を確認してください'})};
  const ignored=side==='target'?writes.ignored(dir):[],snapshot=gitw.inspect(dir,{readOnly:true,...(ignored.length?{ignore:ignored}:{})});
  if(!snapshot)return {blocker:blocker('unreadable')};
  if(snapshot.status)return {blocker:blocker('dirty',safePaths(dir,ignored))};
  return {snapshot};
 }catch{return {blocker:blocker('unreadable')};}
}
function refusal(blocker){return {error:blocker.reason,blocker,stage:'preview',delivery:{state:'not-sent'}};}
module.exports={check,refusal};
