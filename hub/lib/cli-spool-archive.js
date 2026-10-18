'use strict';
const persistence = require('./platform').persistence;
// Explicit, reviewed maintenance only. Never called by state polling or startup.
// Completed ordinary turns have their final rows pinned in the active chat log.
// Automation, unresolved runs and evidence needed by their recovery stay put.
const fs=require('node:fs'),path=require('node:path'),{randomUUID,createHash}=require('node:crypto');
const spool=require('./cli-spool'),{noLinks,exists}=require('./remove');
const hash=x=>createHash('sha256').update(x).digest('hex'),json=x=>JSON.stringify(x);
function alive(pid){if(!Number.isSafeInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}}
function snapshot(dir){
 noLinks(dir);const stat=fs.statSync(dir);if(!stat.isDirectory())throw Error('実行記録がフォルダではありません');
 const files=fs.readdirSync(dir).sort().map(name=>{const file=path.join(dir,name);noLinks(file);const s=fs.statSync(file);if(!s.isFile()||s.nlink!==1)throw Error('リンクや未確認の項目は退避しません');return {name,mode:s.mode&0o7777,uid:s.uid,gid:s.gid,bytes:s.size,sha256:hash(fs.readFileSync(file))};});
 return {mode:stat.mode&0o7777,uid:stat.uid,gid:stat.gid,files,sha256:hash(json(files)),bytes:files.reduce((n,f)=>n+f.bytes,0)};
}
function eligible(dir,{now,minAgeMs,protectedProjects=[]}){
 noLinks(dir);
 const f=spool.strictRead(dir,'finished.json'),p=spool.strictRead(dir,'finalizing.json'),q=spool.strictRead(dir,'request.json'),o=q?.options;
 if(!f||!Number.isFinite(f.at)||f.at>now-minAgeMs||p?.stage!=='finished'||!o||protectedProjects.includes(o.project)||spool.failure(dir))throw Error('終了確認・保持期間・保護対象');
 if(['automation','resultsOrganize','readOnly','selectionOnly','limitSwitch','isolatedReview','integrationReviewRequest','integrationAssignment','discussionTurn','discussion','resultsRecoveryHash','limitPolicy'].some(k=>o[k])||/\[(?:integration-|idea-run:)/.test(o.text||''))throw Error('専用実行の証拠は保持');
 for(const name of ['owner.lock','failure.json'])if(exists(path.join(dir,name)))throw Error('未解決・処理中の記録は保持');
 const owner=spool.strictRead(dir,'owner.json'),launch=spool.strictRead(dir,'launch.json'),started=spool.strictRead(dir,'started.json');
 if(!owner||typeof owner.serverId!=='string'||owner.generation!==p.generation||f.generation!==p.generation)throw Error('所有権と終了の世代が一致しません');
 if([owner?.pid,launch?.supervisorPid,started?.supervisorPid,started?.cliPid].some(alive))throw Error('稼働中または番号の再使用を除外');
 if(p.requestHash!==hash(fs.readFileSync(path.join(dir,'request.json')))||p.completionHash!==spool.completion(dir))throw Error('実行証拠が変わっています');
 if(typeof o.pdir!=='string'||typeof o.task!=='string'||/[\/\\]/.test(o.task)||!o.userRow?.turn)throw Error('会話との対応が不明');
 const file=path.join(o.pdir,'.ai/chat',o.task+'.jsonl'),queue=path.join(o.pdir,'.ai/chat',o.task+'.queue.json');noLinks(file);noLinks(queue);
 const rows=fs.readFileSync(file,'utf8').split('\n').filter(x=>x.trim()).map(JSON.parse);
 const users=rows.filter(r=>r.role==='user'&&r.turn===o.userRow.turn),ends=rows.filter(r=>r.role==='assistant'&&hash(json(r))===p.finalRowHash);
 if(users.length!==1||ends.length!==1||users[0].integrationAuto||ends[0].integrationAuto||users[0].automation||ends[0].automation)throw Error('現役の会話原文と最終保存を照合できません');
 if(ends[0].spoolId!==path.basename(dir)+':final')throw Error('最終保存の所属が違います');
 const refs=[o.request,o.userRow.turn,users[0].request,ends[0].request].filter(Boolean),pending=exists(queue)?JSON.parse(fs.readFileSync(queue,'utf8')):[];
 if(!Array.isArray(pending)||pending.some(r=>refs.some(ref=>json(r).includes(ref))))throw Error('待ち列に関わる記録は保持');
 return {project:o.project,task:o.task,turn:o.userRow.turn,finalRowHash:p.finalRowHash,finishedAt:f.at};
}
function plan(root,{now=Date.now(),minAgeMs=3*86400000,protectedProjects=[]}={}){
 noLinks(root);root=fs.realpathSync(root);if(!Number.isFinite(minAgeMs)||minAgeMs<86400000)throw Error('保持期間は1日以上必要です');
 const options={now,minAgeMs,protectedProjects},items=[],skipped=[];
 for(const name of fs.readdirSync(root).sort()){
  if(!/^[a-f0-9-]{36}$/.test(name)){skipped.push({name,reason:'実行番号以外'});continue;}
  try{const dir=path.join(root,name),proof=eligible(dir,options),tree=snapshot(dir);items.push({name,...proof,...tree});}catch(e){skipped.push({name,reason:e.message});}
 }
 return {version:1,id:randomUUID(),root,archiveRoot:root+'-archive',...options,items,skipped,bytes:items.reduce((n,i)=>n+i.bytes,0)};
}
function apply(p,resultFile){
 if(p.version!==1||!Number.isFinite(p.now)||!Number.isFinite(p.minAgeMs)||p.minAgeMs<86400000||!Array.isArray(p.items)||!Array.isArray(p.protectedProjects)||!path.isAbsolute(p.root)||p.archiveRoot!==p.root+'-archive'||!Array.isArray(p.skipped)||!/^[a-f0-9-]{36}$/.test(p.id)||p.items.some(i=>!/^[a-f0-9-]{36}$/.test(i.name))||new Set(p.items.map(i=>i.name)).size!==p.items.length)throw Error('退避計画が不正です');
 noLinks(p.root);noLinks(p.archiveRoot);noLinks(resultFile);if(exists(resultFile))throw Error('結果が既にあります。再実行せず照合してください');
 // Recheck all inputs before creating the one-use operation directory.
 for(const i of p.items){const dir=path.join(p.root,i.name);eligible(dir,p);if(json(snapshot(dir))!==json({mode:i.mode,uid:i.uid,gid:i.gid,files:i.files,sha256:i.sha256,bytes:i.bytes}))throw Error('固定した実行記録が変わっています');}
 fs.mkdirSync(p.archiveRoot,{recursive:true,mode:0o700});const batch=path.join(p.archiveRoot,p.id);fs.mkdirSync(batch,{mode:0o700});
 fs.writeFileSync(path.join(batch,'plan.json'),JSON.stringify(p,null,2),{flag:'wx',mode:0o600});
 const out={id:p.id,complete:false,moved:[],active:null,failed:null};
 const save=()=>{const tmp=resultFile+'.'+randomUUID();fs.writeFileSync(tmp,JSON.stringify(out,null,2),{flag:'wx',mode:0o600});fs.renameSync(tmp,resultFile);};
 try{
  for(const i of p.items){
   out.active=i.name;save();const src=path.join(p.root,i.name),dst=path.join(batch,i.name);eligible(src,p);if(json(snapshot(src))!==json({mode:i.mode,uid:i.uid,gid:i.gid,files:i.files,sha256:i.sha256,bytes:i.bytes}))throw Error('退避直前に記録が変わりました');
   if(exists(dst)||fs.statSync(src).dev!==fs.statSync(batch).dev)throw Error('同じディスク内の新しい場所にだけ退避できます');
   fs.renameSync(src,dst);
   if(json(snapshot(dst))!==json({mode:i.mode,uid:i.uid,gid:i.gid,files:i.files,sha256:i.sha256,bytes:i.bytes})||exists(src))throw Error('退避後の内容を確認できません');
   for(const parent of [p.root,batch])persistence.syncDirectory(parent);
   out.moved.push({name:i.name,path:dst,sha256:i.sha256,bytes:i.bytes});out.active=null;save();
  }
  out.complete=true;save();return out;
 }catch(e){out.failed=e.message;save();throw e;}
}
module.exports={snapshot,eligible,plan,apply};
if(require.main===module){
 const [mode,input,output]=process.argv.slice(2);
 if(mode==='--plan')fs.writeFileSync(output,JSON.stringify(plan(input,{protectedProjects:['子育て支援センター入退室開発プロジェクト']}),null,2),{flag:'wx',mode:0o600});
 else if(mode==='--apply')apply(JSON.parse(fs.readFileSync(input,'utf8')),output);
 else throw Error('--plan root output または --apply plan result');
}
