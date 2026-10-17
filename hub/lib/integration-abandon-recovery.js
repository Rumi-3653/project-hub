'use strict';
// Recovery changes only the durable abort receipts. It never dispatches work.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {noLinks,exists}=require('./remove');
const hash=x=>createHash('sha256').update(x).digest('hex');
function reconstruct(original,abandoned){
 const r=structuredClone(original);r.abandoned=structuredClone(abandoned);
 for(const a of Object.values(r.auto.attempts))a.phase='cancelled';
 for(const i of r.items)i.state='中止（未受領）';r.complete=true;return r;
}
function residue(h,project,task){
 const r=h.read(project,task);if(!r)return null;
 if(!/^[a-f0-9-]{36}$/.test(r.id||''))throw Error('統合履歴の番号を確認できません');
 const file=path.join(h.dir,'history',r.id+'.json');noLinks(file);
 if(!exists(file))return r.abandoned?{kind:'missing-archive',message:'中止履歴がありません。記録を確認するまで操作できません'}:null;
 if(!fs.statSync(file).isFile())throw Error('中止履歴を確認できません');
 const bytes=fs.readFileSync(file),sha256=hash(bytes),recordHash=hash(JSON.stringify(r));
 const base={file,sha256,recordHash};let archive,differences=[];
 try{archive=JSON.parse(bytes);}catch{
  return {...base,kind:'archive-torn',action:!r.complete&&!r.abandoned?'quarantine':null,message:'中止履歴の保存が途中で止まっています。元の履歴を別名で残し、最新の安全確認からやり直します'};
 }
 try{
  const a=archive.abandoned,o=a?.original;
  if(archive.id!==r.id||archive.project!==project||archive.task!==task||a?.by!=='human'||a.reason!=='stopped-organize'||!Number.isFinite(Date.parse(a.at))||!a.evidence||!o||o.complete||o.abandoned||o.id!==r.id||o.project!==project||o.task!==task||!o.auto?.stopped||!o.items?.length)throw Error();
  if(a.evidence.recordHash!==hash(JSON.stringify(o))||!/^[a-f0-9]{64}$/.test(a.evidence.sha256||'')||JSON.stringify(a.attempts)!==JSON.stringify(Object.fromEntries(Object.entries(a.evidence.attempts||{}).map(([k,p])=>[k,p.kind])))||JSON.stringify(reconstruct(o,a),null,2)!==bytes.toString('utf8'))throw Error();
  if(JSON.stringify(r,null,2)===bytes.toString('utf8'))return {...base,kind:'finalized',message:'中止の保存は完了しています。再送しません'};
  differences=[...new Set([...Object.keys(o),...Object.keys(r)])].filter(k=>JSON.stringify(o[k])!==JSON.stringify(r[k])).slice(0,30);
  base.savedAt=a.at;
  if(JSON.stringify(o)===JSON.stringify(r))return {...base,kind:'archived-not-saved',action:'finalize',archive,message:'中止履歴は保存済みです。最新の安全確認後、同じ内容で現在の記録の保存だけを完了します。依頼は再送しません'};
 }catch{/* Valid JSON with an unproven identity must never be quarantined. */}
 return {...base,kind:'diverged',differences,message:'現在の記録と中止履歴が一致しません。元の記録を残し、自動では回復しません'};
}
function publicInfo(x){if(!x)return null;const {archive,...info}=x;return info;}
function commit(h,x,r){
 if(x.action==='finalize'){
  h.save(x.archive);
  if(fs.readFileSync(h.file(r.project,r.task),'utf8')!==fs.readFileSync(x.file,'utf8'))throw Error('中止記録の保存を確認できません');
  return {abandoned:true,complete:true,recovered:'finalize'};
 }
 // link+unlink is a same-filesystem, no-clobber rename. A failure between the
 // operations preserves both names; a later preview can safely finish it.
 const destination=x.file+'.torn-'+x.sha256;noLinks(destination);
 if(exists(destination)){
  if(!fs.statSync(destination).isFile()||!fs.readFileSync(destination).equals(fs.readFileSync(x.file)))throw Error('退避先の記録が異なります');
 }else fs.linkSync(x.file,destination);
 if(hash(fs.readFileSync(destination))!==x.sha256||hash(fs.readFileSync(x.file))!==x.sha256)throw Error('中止履歴が変わりました');
 const fd=fs.openSync(destination,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 const parent=fs.openSync(path.dirname(x.file),'r');try{fs.fsyncSync(parent);fs.unlinkSync(x.file);fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
 return {recovered:'quarantine',preserved:destination,complete:false};
}
module.exports={reconstruct,residue,publicInfo,commit};
