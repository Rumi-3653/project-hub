'use strict';
const {lt}=require('./locale');
const fs = require('node:fs'), path = require('node:path');
const {createHash} = require('node:crypto');
const {noLinks,exists} = require('./remove');
const digest = x => createHash('sha256').update(x).digest('hex');
function childrenComplete(r) {
  return Boolean(r?.complete&&Array.isArray(r.items)&&r.items.every(i=>['片付け済み','受領済み','保持受領済み'].includes(i.state)));
}
function closed(r){return childrenComplete(r)||Boolean(r?.complete&&r.abandoned?.reason==='stopped-organize');}
function pendingMain(r) {
  if(r?.auto?.pendingMain)return r.auto.pendingMain;
  if(childrenComplete(r)&&r.auto?.thenMain&&r.auto.main?.state!=='done')return {id:r.id,main:r.auto.main||{state:'pending'},stopped:r.auto.stopped||null};
  return null;
}
function assertNoArchive(dir,r){
 if(!r||r.complete)return;
 if(typeof r.id!=='string'||!r.id||/[\/\\]/.test(r.id))throw Error('統合履歴の番号を確認できません');
 const f=path.join(dir,'history',r.id+'.json');noLinks(f);
 if(exists(f))throw Error('中止の保存結果が未確認です。再開せず、保存された履歴を確認してください');
}
function archive(dir,r) {
  if(!r?.complete)return;
  if(!/^[a-f0-9-]{36}$/.test(r.id))throw Error(lt('受領履歴の番号が不正です'));
  const f=path.join(dir,'history',r.id+'.json'),bytes=JSON.stringify(r,null,2);
  noLinks(f);fs.mkdirSync(path.dirname(f),{recursive:true});
  if(exists(f)){if(fs.readFileSync(f,'utf8')!==bytes)throw Error(lt('受領履歴が変わっています'));return;}
  fs.writeFileSync(f,bytes,{flag:'wx'});
  if(fs.readFileSync(f,'utf8')!==bytes)throw Error(lt('受領履歴を保存できませんでした'));
}
const fields=['scope','planned','undecided','residual','evidence'];
function review(input,sourceHead) {
  if(!input||input.confirmed!==true||input.sourceHead!==(sourceHead||null))throw Error(lt('取り込む範囲・残件・確認済みHEADを確認してください'));
  const out={confirmed:true,sourceHead:sourceHead||null};
  for(const k of fields){if(typeof input[k]!=='string'||!input[k].trim()||input[k].length>10000)throw Error(lt('取り込む範囲・残件・判断待ち・確認資料を記入してください'));out[k]=input[k].trim();}
  return out;
}
function suggestions(t,head){return {sourceHead:head||null,scope:lt('現在の保存済みHEAD全体と整理された成果一式'),planned:t.next||lt('未確認'),undecided:t.question||lt('未確認'),residual:[...(t.steps||[]).filter(s=>!s.done).map(s=>s.text||s.title||JSON.stringify(s)),t.question].filter(Boolean).join('\n')||lt('未確認'),evidence:lt('未確認'),confirmed:false};}
function signature(i){return digest(JSON.stringify({head:i.source?.head||null,files:i.files.map(f=>({id:f.id,digest:digest(fs.readFileSync(f.path)),mode:f.mode})),results:i.results,review:i.review,disposition:i.disposition}));}
// A declaration belongs to the same task document as the verified results.
// Old tasks never imply that there are no remaining decisions.
function remaining(input) {
  if(input===undefined)return {status:'不明',items:lt('未確認'),undecided:lt('未確認'),evidence:lt('未確認')};
  if(!input||!['なし','あり','不明'].includes(input.status))throw Error(lt('残件申告の形式を確認してください'));
  const out={status:input.status};
  for(const k of ['items','undecided','evidence']) {
    if(typeof input[k]!=='string'||!input[k].trim()||input[k].length>10000)throw Error(lt('残件申告の形式を確認してください'));
    out[k]=input[k].trim();
  }
  if(out.status==='なし'&&![out.items,out.undecided].every(x=>['なし',lt('なし')].includes(x)))throw Error(lt('残件・判断待ちがあるため作業を続けてください'));
  return out;
}
function declaration(file) {
  noLinks(file);const text=fs.readFileSync(file,'utf8');
  const sections=[...text.matchAll(/^## (?:残件申告|剩餘工作申報)\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)];
  if(!sections.length)return remaining();
  if(sections.length!==1)throw Error(lt('残件申告の形式を確認してください'));
  const block=sections[0][1].match(/^```json\s*\n([\s\S]*?)\n```/m);
  if(!block)throw Error(lt('残件申告の形式を確認してください'));
  return remaining(JSON.parse(block[1]));
}
function declaredReview(r,head) {
  return review({sourceHead:head||null,confirmed:true,scope:lt('現在の保存済みHEAD全体と整理された成果一式'),planned:r.items,undecided:r.undecided,residual:r.items,evidence:r.evidence},head);
}
module.exports={assertNoArchive,archive,review,suggestions,signature,remaining,declaration,declaredReview,childrenComplete,closed,pendingMain};
