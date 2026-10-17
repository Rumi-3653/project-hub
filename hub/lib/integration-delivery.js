'use strict';
// Delivery facts are separate from the work phase. A missing response is never
// proof of non-delivery; only a refusal before queue/send can authorize recovery.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {noLinks,exists}=require('./remove'),{lt}=require('./locale');
const hash=x=>createHash('sha256').update(x).digest('hex');
function assignment(request,data){
  const slot=data.roles.find(r=>r.name===request.role)?.main;
  if(!slot?.model||!['claude-code','codex','agy','grok'].includes(slot.ai))throw Error(lt('設定の担当を確かめてください'));
  return {...request,ai:slot.ai==='claude-code'?'claude':slot.ai,model:slot.model,effort:slot.effort||''};
}
function evidence({pdir,task,logFile,k,phase,attempt,queueFiles=[]}){
  const sources=[];let sent=false,audit=[];
  const read=(f,optional=false)=>{
    noLinks(f);if(!exists(f)){if(!optional)throw Error('missing evidence');sources.push({file:f,missing:true});return null;}
    const b=fs.readFileSync(f);sources.push({file:f,sha256:hash(b)});return b.toString('utf8');
  };
  const marker=`[integration-auto:${k}:${phase}]`,matches=x=>JSON.stringify(x).includes(marker)||Boolean(attempt.delivery?.request&&x.request===attempt.delivery.request);
  const rows=s=>s===null?[]:s.split('\n').filter(x=>x.trim()).map(x=>JSON.parse(x));
  try{
    const chat=rows(read(path.join(pdir,'.ai/chat',task+'.jsonl')));
    sent=chat.some(matches);
    const q=read(path.join(pdir,'.ai/chat',task+'.queue.json'),true),queue=q===null?[]:JSON.parse(q);if(!Array.isArray(queue))throw Error('bad queue');sent ||=queue.some(matches);
    for(const f of new Set(queueFiles)){if(f===path.join(pdir,'.ai/chat',task+'.queue.json'))continue;const s=read(f,true),q=s===null?[]:JSON.parse(s);if(!Array.isArray(q))throw Error('bad queue');sent ||=q.some(matches);}
    // Legacy recovery needs the complete active conversation. If it has been
    // archived, absence in the active log cannot prove that no request was sent.
    const history=path.join(pdir,'.ai/chat/history',task);noLinks(history);
    if(exists(history)&&fs.readdirSync(history).length)throw Error('archived evidence');
    audit=rows(read(logFile));audit.push(...rows(read(logFile.replace(/\.jsonl$/,'.old.jsonl'),true)));
    sent ||=audit.some(x=>matches(x)||(x.action==='delegate'&&x.task===task&&x.at>=attempt.at&&x.title===lt('統合する成果の整理')));
    return {complete:true,sent,sources,auditStart:audit.map(x=>x.at).filter(Boolean).sort()[0],auditEnd:audit.map(x=>x.at).filter(Boolean).sort().at(-1),sha256:hash(JSON.stringify(sources))};
  }catch{return {complete:false,sent:true,sources};}
}
function legacyRefusal(r,k,a,proof){
  if(a.delivery||a.phase!=='organize'||k!==hash(r.id+'\0'+a.project+'\0'+a.task+'\0organize')||!proof?.complete||proof.sent)return false;
  const reasons=['role は指定した AI が主担当の役割を選んでください','role 請選擇以指定 AI 為主要負責者的角色',lt('role は指定した AI が主担当の役割を選んでください')];
  const first=[...(r.auto.stopHistory||[]),r.auto.stopped].find(s=>s&&reasons.includes(s.reason)&&Date.parse(s.at)>=Date.parse(a.at)&&Date.parse(s.at)-Date.parse(a.at)<=1000);
  return Boolean(first&&proof.auditStart<=a.at&&proof.auditEnd>=first.at);
}
function completedRefusal(r,k,a,proof){
  // Older Hub marked this exact pre-append refusal as unknown. A complete
  // absence proof and the matching immediate refusal are both required.
  const reason=lt('この作業は完了済みのため委任できません。続ける場合は、人がこの作業の作業画面の上部の［再開する］を押してから依頼してください。新しい作業は作っていません');
  const d=a.delivery,s=r.auto.stopped||r.auto.stopHistory?.at(-1);
  if(a.phase!=='organize'||k!==hash(r.id+'\0'+a.project+'\0'+a.task+'\0organize')||d?.state!=='unknown'||d.status!==409||!d.request||d.reason!==reason||s?.reason!==reason||!proof?.complete||proof.sent)return false;
  if((a.deliveryHistory||[]).some(x=>x.delivery&&x.delivery.state!=='not-sent'&&!(x.completedRefusal&&JSON.stringify(x.delivery)===JSON.stringify(d)&&x.proof?.complete&&!x.proof.sent)))return false;
  return Boolean(Date.parse(d.at)>=Date.parse(a.at)&&Date.parse(s.at)>=Date.parse(d.at)&&Date.parse(s.at)-Date.parse(a.at)<=1000&&proof.auditStart<=a.at&&proof.auditEnd>=s.at);
}
module.exports={assignment,evidence,legacyRefusal,completedRefusal};
