'use strict';
// 一覧用の受領検査だけを別スレッドで行う。操作時の正式な検査は変更しない。
const fs = require('node:fs'), path = require('node:path');
const { Worker, isMainThread, parentPort } = require('node:worker_threads');
const { createHash } = require('node:crypto');
const { expandHome, Store } = require('./store');
const { TaskTransfer } = require('./task-transfer');
const { TaskIntegrate } = require('./task-integrate');
const { Removal } = require('./remove');
const git = require('./git');
const graph = require('../public/project-order');
const {lt} = require('./locale');
const stamp = f => { try { const s=fs.statSync(f); return [s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':'); } catch { return ''; } };
function gitStamp(dir) {
  if (!dir) return '';
  let own=path.join(dir,'.git');
  try {
    if(fs.statSync(own).isFile()) own=path.resolve(dir,fs.readFileSync(own,'utf8').replace(/^gitdir:\s*/,'').trim());
    let common=own; const c=path.join(own,'commondir');
    if(fs.existsSync(c))common=path.resolve(own,fs.readFileSync(c,'utf8').trim());
    const head=fs.readFileSync(path.join(own,'HEAD'),'utf8').trim();
    return [head,stamp(path.join(own,'index')),stamp(path.join(own,'MERGE_HEAD')),head.startsWith('ref: ')?stamp(path.join(common,head.slice(5))):'',stamp(path.join(common,'packed-refs'))].join('|');
  } catch { return ''; }
}
class StateOffers {
  constructor({transfer,removal,baseOf,ttl=60000}) { Object.assign(this,{transfer,removal,baseOf,ttl}); this.cache=null;this.pending=null;this.worker=null;this.sequence=0;this.issueCache=null;this.failed=null; }
  view(all) {
    const rows=this.transfer.offers({verify:false,all}).map(r=>({...r,receiptChecked:!r.received}));
    // 履歴の無い一覧には重い検査もスレッドも不要。
    const checkReceipts=rows.some(r=>r.received);
    const eligible=all.flatMap(p=>p.tasks.filter(t=>p.kind!=='freetalk'&&!t.freetalk&&t.completionPending&&graph.ancestorsOf(p,t,all).length).map(t=>[p.id,t.id]));
    if(!checkReceipts&&!eligible.length)return rows;
    const sources=new Set(rows.filter(r=>r.received).map(r=>r.project+'\0'+r.task));
    const activity=all.filter(p=>p.tasks.some(t=>sources.has(p.id+'\0'+t.id))).map(p=>({project:p.id,locked:this.removal.locked(p.id),review:this.removal.reviewBusy(p.id),tasks:p.tasks.filter(t=>sources.has(p.id+'\0'+t.id)&&this.removal.busy(p.id,t.id)).map(t=>t.id)}));
    const bases=Object.fromEntries(all.map(p=>[p.id,this.baseOf(p)]));
    // Shared task bases need one Git stamp per display build, never across views.
    const repositories=new Map(),repositoryStamp=dir=>{if(!repositories.has(dir))repositories.set(dir,gitStamp(dir));return repositories.get(dir);};
    const taskStamp=new Map(all.flatMap(p=>p.tasks.map(t=>[p.id+'\0'+t.id,[t.completionHash,t.parent,t.derivedFrom,repositoryStamp(expandHome(t.workdir)||bases[p.id]),p.folders]])));
    const rowKey=r=>[r.project,r.task,r.targetProject,r.targetTask].join('\0');
    const rowSignatures=Object.fromEntries(rows.map(r=>{const a=activity.find(p=>p.project===r.project);return [rowKey(r),JSON.stringify([taskStamp.get(r.project+'\0'+r.task),taskStamp.get(r.targetProject+'\0'+r.targetTask),stamp(this.transfer.file(r.project,r.task)),a?.locked,a?.review,a?.tasks.includes(r.task)])];}));
    const signature=createHash('sha256').update(JSON.stringify([rowSignatures,eligible.map(([p,t])=>[p,t,taskStamp.get(p+'\0'+t)])])).digest('hex');
    if(this.failed?.signature===signature)return rows;
    const checkOffers=checkReceipts&&(!this.cache||this.cache.signature!==signature||Date.now()-this.cache.at>=this.ttl);
    const checkIssues=eligible.length&&(!this.issueCache||this.issueCache.signature!==signature||Date.now()-this.issueCache.at>=1000);
    if((checkOffers||checkIssues)&&!this.pending)this.refresh({root:this.transfer.store.root,all,activity,bases,signature,rowSignatures,checkOffers,checkIssues:Boolean(checkIssues),eligible});
    if(!this.cache)return rows;
    const cached=new Map(this.cache.rows.map(r=>[rowKey(r),r]));
    return rows.map(r=>{const key=rowKey(r),hit=cached.get(key);return hit&&this.cache.rowSignatures[key]===rowSignatures[key]?{...r,pending:hit.pending,reason:hit.reason,received:hit.received,receiptChecked:true}:r;});
  }
  issue(p,t) {
    if(this.failed)return {ok:false,code:'verify',reason:this.failed.error};
    const hit=this.issueCache?.issues.find(x=>x.project===p.id&&x.task===t.id&&x.hash===t.completionHash);
    return hit?.issue||{ok:false,code:'checking',reason:lt('成果を確認中です')};
  }
  fail(error) {if(this.pending)this.failed={signature:this.pending.signature,error};this.pending=null;}
  refresh(data) {
    this.failed=null;
    if(!this.worker) {
      // status/保存履歴の検証にも効かせる。worker専用envなので正式操作は変えない。
      const worker=this.worker=new Worker(__filename,{env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}});
      worker.on('message',message=>{if(this.pending?.id!==message.id)return;if(message.error){this.fail(message.error);return;}const {signature,rowSignatures}=this.pending;this.pending=null;if(message.rows)this.cache={signature,rowSignatures,rows:message.rows,at:Date.now()};if(message.issues)this.issueCache={signature,issues:message.issues,at:Date.now()};});
      worker.on('error',error=>{if(this.worker===worker){this.fail(error.message);this.worker=null;}});
      worker.on('exit',()=>{if(this.worker===worker){this.fail(lt('成果を確認中です'));this.worker=null;}});
      worker.unref();
    }
    const id=++this.sequence;this.pending={id,signature:data.signature,rowSignatures:data.rowSignatures};this.worker.postMessage({id,...data});
  }
  close() { const worker=this.worker;this.worker=null;this.pending=null;return worker?.terminate(); }
}
if(!isMainThread) {
  let removal;
  parentPort.on('message',({id,root,all,activity,bases,checkOffers,checkIssues,eligible})=>{
    try {
      // Store/Completionの初期化は台帳を書き得るので、読取専用のスナップショットを渡す。
      const store=Object.assign(Object.create(Store.prototype),{root,product:path.join(root,'Product'),listProjects:()=>all,readProject:id=>all.find(p=>p.id===id),readTask:file=>all.flatMap(p=>p.tasks.map(t=>({p,t}))).find(({p,t})=>file===path.join(p.dir,'.ai/tasks',t.id+'.md'))?.t});
      const active=new Map(activity.map(p=>[p.project,p]));
      if(!removal)removal=new Removal({store});else removal.store=store;
      removal.busy=(p,t)=>active.get(p)?.tasks.includes(t)||false;removal.locked=p=>active.get(p)?.locked||false;removal.reviewBusy=p=>active.get(p)?.review||false;
      const baseOf=p=>bases[p.id];
      const transfer=new TaskTransfer({store,removal,baseOf,integration:(p,t)=>git.integrationReceipt(baseOf(p),require('./integration-log').lastMerge(path.join(root,'_hub/log.jsonl'),p.id,t.id),t)});
      // 受領済み判定はpreviewを使わない。merge-tree --write-treeは正式確認時だけ。
      new TaskIntegrate({store,transfer,removal,baseOf,gitw:{...git,preview:()=>null}});
      const rows=checkOffers?transfer.offers():undefined;
      const issues=checkIssues?eligible.map(([project,task])=>{const p=store.readProject(project),t=p.tasks.find(t=>t.id===task);let issue;try{issue=transfer.resultIssue(p,t);}catch(e){issue={ok:false,code:'verify',reason:e.message};}return {project,task,hash:t.completionHash,issue};}):undefined;
      parentPort.postMessage({id,rows,issues});
    }catch(error){parentPort.postMessage({id,error:error.message});}
  });
}
module.exports={StateOffers,gitStamp};
