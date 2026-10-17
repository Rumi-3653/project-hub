'use strict';
const {createHash}=require('node:crypto');
const fs=require('node:fs'),path=require('node:path');
const digest=row=>createHash('sha256').update(JSON.stringify(row)).digest('hex');
const head=h=>/^[a-f0-9]{40,64}$/.test(h||'');
const label=s=>typeof s==='string'?s.trim().replace(/\s*[（(](?:おすすめ|推薦)[）)]$/u,''):null;
const direct=r=>r?.role==='user'&&Boolean(r.turn)&&!r.request&&!r.origin&&!r.limitSwitch;
// Only an exact choice from the immediately preceding code question counts.
// Free-form answers and delegated instructions need explicit human resolution.
function selectedQuestion(rows,answer){
  if(!direct(answer))return null;
  const question=rows.findLast(r=>['user','assistant'].includes(r.role));
  if(question?.role!=='assistant'||question.error||question.integrationAuto?.phase!=='code'||question.integrationAuto.closed!==true||question.asks?.length!==1||question.asks[0].multi)return null;
  const options=question.asks[0].options;
  if(!Array.isArray(options)||options.some(s=>typeof s!=='string'))return null;
  const matches=options.map((s,n)=>label(s)===label(answer.text)?n:-1).filter(n=>n>=0);
  return matches.length===1?{question,choice:matches[0]}:null;
}
// Answering a choice is not permission to continue. Recognize only an explicit
// correction-and-save action; unknown labels stay stopped. Neither position nor
// the recommendation suffix grants permission. Keep this grammar conservative
// for old, untyped question logs (including the approved file-specific choice).
function correctionPermission(selection){
  const text=label(selection.question.asks[0].options[selection.choice]);
  return /^(?:`[^`\r\n]+`\s*の\s*)?(?:補正|修正)(?:して保存(?:する)?|を許可(?:し[、,]\s*コミットまで進める|して保存する))$/u.test(text)
    ?{version:1,action:'save-correction'}:null;
}
function resolution(rows,{k,a,row}){
  if(a.phase!=='code'||a.delivery?.state!=='accepted'||!a.delivery.request||row.request!==a.delivery.request||row.integrationAuto?.key!==k||row.integrationAuto.phase!=='code'||row.integrationAuto.closed!==true||row.error)return null;
  const index=rows.findLastIndex(r=>digest(r)===digest(row));
  if(index<0)return null;
  const talk=rows.slice(index+1).filter(r=>['user','assistant'].includes(r.role)),answer=talk[0],selection=selectedQuestion(rows.slice(0,index+1),answer),completion=talk[1];
  if(!selection||!head(answer.head)||completion?.role!=='assistant'||completion.error!==''||completion.asks?.length||!completion.text||completion.integrationAuto||completion.request)return null;
  const permission=correctionPermission(selection);
  if(!permission)return null;
  const saved=completion.answerCompletion;
  // Old logs have no completion snapshot. The next direct user turn's clean
  // Git snapshot is the legacy boundary, never text claiming a commit exists.
  const boundary=saved?completion:talk[2];
  if(saved?(saved.turn!==answer.turn||saved.closed!==true):!direct(boundary))return null;
  const snapshot=saved||boundary;
  if(!head(snapshot.head)||snapshot.status!==''||snapshot.head===answer.head)return null;
  return {version:2,permission,request:row.request,questionSHA:digest(row),answerSHA:digest(answer),completionSHA:digest(completion),boundarySHA:digest(boundary),answerTurn:answer.turn,answerHead:answer.head,savedHead:snapshot.head,choice:selection.choice,legacy:!saved};
}
function read(pdir,task){
  try{return fs.readFileSync(path.join(pdir,'.ai/chat',task+'.jsonl'),'utf8').split('\n').filter(s=>s.trim()).map(s=>JSON.parse(s));}catch{return [];}
}
module.exports={selectedQuestion,resolution,read};
