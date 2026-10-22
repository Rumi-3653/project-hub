'use strict';
// Classic-script declarations only. Shared state and startup stay in app.js.
// See README.md for the loading and state contract.

function persistFreetalkPromotionDrafts() {
  try {sessionStorage.setItem(FREETALK_DRAFT_KEY,JSON.stringify({drafts:[...freetalkPromotionDrafts],errors:[...freetalkPromotionErrors]}));}catch{/* 保存不可でも現在の編集は保持 */}
}

function restoreFreetalkPromotionDrafts() {
  try {
    const saved=JSON.parse(sessionStorage.getItem(FREETALK_DRAFT_KEY)||'null');
    for(const [id,d] of saved?.drafts || [])if(!freetalkPromotionDrafts.has(id))freetalkPromotionDrafts.set(id,{...d,creating:false});
    for(const [id,e] of saved?.errors || [])freetalkPromotionErrors.set(id,e);
  }catch{/* 壊れた退避データで起動を止めない */}
}

function beginFreetalkPromotionOperation(t,pending=false) {
  const operation={pending};freetalkPromotionOperations.set(t,operation);
  return ()=>freetalkPromotionOperations.get(t)===operation;
}

function beginFreetalkCleanupOperation() {
  const topics=new Set([...freetalkPromotionOperations.keys(),...(proj('freetalk')?.tasks || []).map(t=>t.id)]);
  const active=[...topics].map(t=>beginFreetalkPromotionOperation(t)), count=freetalkPromotionOperations.size;
  return ()=>freetalkPromotionOperations.size===count && active.every(current=>current());
}

function freetalkCleanupHtml() {
  const c=state.freetalk?.cleanup;if(!c)return '';
  const due=c.due?new Date(c.due):null;
  return UI.template`<div class="freetalk-cleanup small ${c.notice?'freetalk-warning':''}">${due?UI.template`次の自動掃除 ${due.getMonth()+1}/${due.getDate()}（${c.overdue?UI.text('期限超過'):UI.template`あと${c.days}日`}）`:''}${c.delayed?UI.text('：AIが終わったら掃除します'):''}${c.notice&&!c.overdue?UI.text(' 保存したい話題は先にプロジェクト化してください。'):''}<button class="btn plain sm" data-act="freetalkclean" type="button" ${c.reason?'disabled':''}>掃除する</button>${c.reason||c.error?UI.template`<span role="status">${esc(c.reason||c.error)}</span>`:''}</div>`;
}

function freetalkPromotionSize(d) {
  return d.available.filter(f=>!f.reason && d.files.includes(f.path)).reduce((n,f)=>n+f.size,0)>256*1024*1024
    ? UI.text('選んだファイルの合計が256MBを超えています。選び直してください') : '';
}

function freetalkPromotionBlocked(t) {
  const h=t?.freetalkHistory || {}, d=freetalkPromotionDrafts.get(t?.id);
  return Boolean(!d || freetalkPromotionOperations.get(t?.id)?.pending || h.reason || h.statusError || h.stale || h.staleReason || h.summaryError || freetalkPromotionErrors.has(t?.id) || d.error || d.conflict || d.creating || freetalkPromotionSize(d));
}

function freetalkPromotionHtml(t) {
  const h=t.freetalkHistory || {}, d=freetalkPromotionDrafts.get(t.id), error=freetalkPromotionErrors.get(t.id);
  if(h.promotionAutomatic || error?.automatic)return UI.template`<section class="freetalk-promotion" data-topic="${esc(t.id)}"><h3>プロジェクトを立ち上げる</h3>${h.automaticError || error?.automatic?UI.template`<p role="alert">${esc(h.automaticError || error.message)}</p><button class="btn" data-act="freetalkautopromote" data-t="${esc(t.id)}" type="button" ${h.reason?'disabled':''}>もう一度開始</button>`:UI.template`<p role="status">${UI.text('要約からプロジェクト作成・移行まで自動で進めています。画面を閉じても続行します。')}</p>`}</section>`;
  if(!h.promotionRequested && !d && !error)return '';
  const message=error?.message || h.staleReason || h.summaryError || error || d?.error || (d?.conflict?UI.text('会話やファイルが更新されました。もう一度確認してください'):'');
  const refresh=!error?.cancel && (h.stale || h.summaryError);
  return UI.template`<section class="freetalk-promotion" data-topic="${esc(t.id)}"><h3>プロジェクトを立ち上げる</h3>${message?UI.template`<p role="alert">${esc(message)}</p><button class="btn plain" data-act="${refresh?'freetalkresummary':'freetalkretry'}" data-t="${esc(t.id)}" type="button" ${h.reason?'disabled':''}>${refresh?UI.text('要約し直す'):UI.text('もう一度確認')}</button>`:''}${d?UI.template`${d.previousSummary?UI.template`<details><summary>再要約前の編集内容</summary><p class="note">${esc(d.previousSummary)}</p></details>`:''}<label>プロジェクト名<input data-promotion-field="name" maxlength="60" value="${esc(d.name)}"></label><label>引き継ぐ要約<textarea class="freetalk-summary-input" data-promotion-field="summary" rows="8" maxlength="50000">${esc(d.summary)}</textarea></label><fieldset><legend>移すファイル（共通ファイルは選択してください）</legend>${d.available.length?d.available.map(f=>UI.template`<label class="chk"><input type="checkbox" data-promotion-file="${esc(f.path)}" ${f.reason?'disabled':d.files.includes(f.path)?'checked':''}>${esc(f.path)}${f.reason?UI.template` — 移せません：${esc(f.reason)}`:''}</label>`).join(''):UI.html('<p class="small">移すファイルはありません</p>')}</fieldset><p data-promotion-size role="alert" ${freetalkPromotionSize(d)?'':'hidden'}>${esc(freetalkPromotionSize(d))}</p><p class="small">会話原文と選んだファイルを資料に保存し、新しい会話は確認した要約から始めます。元の話題は読み取り専用になります。</p><button class="btn" data-act="freetalkcreate" data-t="${esc(t.id)}" type="button" ${freetalkPromotionBlocked(t)?'disabled':''}>作成</button>`:!message?UI.html('<p class="note">プロジェクトへ引き継ぐ要約を待っています。返事の後に確認・編集できます。</p>'):''}<button class="btn plain" data-act="freetalkcancel" data-t="${esc(t.id)}" type="button" ${d?.creating?'disabled':''}>取消</button></section>`;
}

async function prepareFreetalkPromotion(t,active=()=>true) {
  const operation=freetalkPromotionOperations.get(t);
  const old=freetalkPromotionDrafts.get(t), d=await api('/api/freetalk/project-preview',{project:'freetalk',task:t});
  if(!active() || freetalkPromotionOperations.get(t)!==operation)return;
  const available=d.files, selectable=available.filter(f=>!f.reason).map(f=>f.path);
  const files=old?selectable.filter(f=>old.files.includes(f)):available.filter(f=>!f.reason && (f.scope==='topic' || f.path.startsWith('topics/'+t+'/'))).map(f=>f.path);
  freetalkPromotionDrafts.set(t,{...d,available,files,...(old?{name:old.name,previousSummary:old.summaryId===d.summaryId?old.previousSummary:old.summary,...(old.summaryId===d.summaryId?{summary:old.summary}:{})}:{})});
  freetalkPromotionErrors.delete(t);persistFreetalkPromotionDrafts();
}

function replaceFreetalkHistory(el,p,t) {
  const focused=document.activeElement, field=el?.contains?.(focused)?focused?.dataset?.promotionField:null;
  const start=focused?.selectionStart,end=focused?.selectionEnd;
  el.outerHTML=freetalkHistoryHtml(p,t);
  if(field){const input=document.querySelector('[data-promotion-field="'+field+'"]');input?.focus();if(start!==null && start!==undefined)input?.setSelectionRange?.(start,end);}
}

function syncFreetalkMigrationControls(h) {
  const work=document.querySelector('.freetalk-work');if(!work)return;
  const locked=Boolean(h?.migrated || (h?.promotionAutomatic && !h.automaticError));
  work.dataset.readonly=String(locked);
  for(const selector of ['#composer','#work-question']){const el=work.querySelector(selector);if(el)el.hidden=locked;}
}

function freetalkHistoryHtml(p,t) {
  const h=t.freetalkHistory || {}, reason=h.reason || '';
  if(h.migrated && !h.promotionAutomatic)return UI.template`<section class="freetalk-history"><p class="note">→プロジェクト『${esc(h.migrated.project)}』へ移行済み（読み取り専用） <button class="btn" data-go="work" data-p="${esc(h.migrated.project)}" data-t="${esc(h.migrated.task)}" type="button">移行先を開く</button></p>${freetalkCleanupHtml()}</section>`;
  const disabled=reason || h.statusError || (h.promotionAutomatic && !h.automaticError) ? 'disabled' : '';
  const key=p.id+'/'+t.id+'/'+h.summaryId;
  const summary=freetalkSummaryDrafts.has(key) ? freetalkSummaryDrafts.get(key) : h.draft;
  return UI.template`<section class="freetalk-history" aria-label="会話量と整理"><span class="small">約${Math.round((h.tokens || 0)/1000)}k／300k（目安）</span>
    <div class="${h.warning ? 'freetalk-warning' : 'acts'}">${h.warning ? UI.html('<b>この話題は長くなりました</b>') : ''}<button class="btn plain sm" data-act="freetalkautopromote" data-t="${esc(t.id)}" type="button" ${disabled || (h.promotionAutomatic && !h.automaticError)?'disabled':''}>プロジェクトを立ち上げる</button><button class="btn plain sm" data-act="freetalksummary" data-t="${esc(t.id)}" type="button" ${disabled}>整理して続ける</button><button class="btn plain sm" data-act="freetalkclear" data-t="${esc(t.id)}" type="button" ${disabled}>クリアする</button>${reason ? UI.template`<span role="status">${esc(reason)}</span>` : ''}</div>
    ${freetalkCleanupHtml()}${h.statusError?UI.template`<p role="alert">${esc(h.statusError)}</p><button class="btn plain" data-act="freetalkretry" data-t="${esc(t.id)}" type="button">もう一度確認</button>`:''}${freetalkPromotionHtml(t)}${h.draft && !h.stale && !h.promotionRequested && !freetalkPromotionDrafts.has(t.id) ? UI.template`<details class="freetalk-summary" data-work-fold="freetalk-summary-${esc(h.summaryId||'')}" ${workFoldAttr(p,t,'freetalk-summary-'+(h.summaryId||''),true)}><summary>引き継ぐ要約を確認・編集</summary><textarea class="freetalk-summary-input" data-key="${esc(key)}" rows="8" maxlength="50000">${esc(summary)}</textarea><p class="small">確認した要約だけで新しい会話を始めます。旧会話・再開情報・話題メモリはゴミ箱へ移します。</p><button class="btn" data-act="freetalkcontinue" data-t="${esc(t.id)}" type="button" ${disabled}>この要約で続ける</button></details>` : ''}</section>`;
}

async function syncFreetalkHistory(p,t,reason='') {
  if(!p || !t)return;
  const seq=++freetalkStatusSeq;
  const operation=freetalkPromotionOperations.get(t.id);
  const active=()=>seq===freetalkStatusSeq && view.project===p.id && view.task===t.id && freetalkPromotionOperations.get(t.id)===operation;
  try {
    const h=await api('/api/freetalk/status?project=freetalk&task='+encodeURIComponent(t.id));
    if(!active())return;
    if(!h.promotionRequested || (freetalkPromotionDrafts.get(t.id)?.generation && freetalkPromotionDrafts.get(t.id).generation!==h.generation))freetalkPromotionDrafts.delete(t.id);
    if(h.migrated && h.automaticCompleted){
      view={kind:'work',project:h.migrated.project,task:h.migrated.task};save();await load();return;
    }
    if(!h.promotionAutomatic && h.promotionRequested && h.draft && !h.stale && !h.reason && (!freetalkPromotionDrafts.has(t.id) || freetalkPromotionDrafts.get(t.id).summaryId!==h.summaryId) && !freetalkPromotionErrors.has(t.id)) {
      try {await prepareFreetalkPromotion(t.id,active);if(!active())return;h.revision=(await api('/api/freetalk/status?project=freetalk&task='+encodeURIComponent(t.id))).revision;}
      catch(e){if(!active())return;freetalkPromotionErrors.set(t.id,e.message);}
    }
    if(!active())return;
    const d=freetalkPromotionDrafts.get(t.id);if(d)d.conflict=d.revision!==h.revision;
    const current=taskOf(proj(p.id),t.id);if(current)current.freetalkHistory=h;
    syncFreetalkMigrationControls(h);
    const el=document.querySelector('.freetalk-history');
    const editing=el?.contains?.(document.activeElement) && ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName);
    if(el && (!editing || !d || h.stale || h.summaryError || d.conflict || freetalkPromotionErrors.has(t.id)))replaceFreetalkHistory(el,p,{...t,freetalkHistory:h});
    else if(el)el.querySelectorAll('button').forEach(b=>{if(b.dataset.act!=='freetalkcancel')b.disabled=b.dataset.act==='freetalkcreate'?freetalkPromotionBlocked({...t,freetalkHistory:h}):Boolean(h.reason || d?.creating);});
    persistFreetalkPromotionDrafts();syncFreetalkAttachmentControls();
  } catch(e) {
    if(!active())return;
    const h={...(taskOf(proj(p.id),t.id)?.freetalkHistory || {}),reason:'',statusError:e.message};
    const current=taskOf(proj(p.id),t.id);if(current)current.freetalkHistory=h;
    const el=document.querySelector('.freetalk-history');if(el)replaceFreetalkHistory(el,p,{...t,freetalkHistory:h});
  }
}

// Create the original callback at its original registration point in app.js.
function appFreetalkCallback450() {
  return (()=>{if(document.hidden)persistFreetalkPromotionDrafts();});
}

// Create the original callback at its original registration point in app.js.
function appFreetalkCallback490() {
  return (e=>{
  const block=e.target.closest('.freetalk-promotion');if(!block)return;
  const d=freetalkPromotionDrafts.get(block.dataset.topic);if(!d)return;
  if(e.target.dataset.promotionField)d[e.target.dataset.promotionField]=e.target.value;
  if(e.target.dataset.promotionFile){const f=e.target.dataset.promotionFile;d.files=e.target.checked?[...new Set([...d.files,f])]:d.files.filter(v=>v!==f);}
  persistFreetalkPromotionDrafts();
  const size=freetalkPromotionSize(d), alert=block.querySelector('[data-promotion-size]');
  if(alert){alert.textContent=size;alert.hidden=!size;}
  const create=block.querySelector('[data-act="freetalkcreate"]');
  if(create)create.disabled=freetalkPromotionBlocked(taskOf(proj('freetalk'),block.dataset.topic));
});
}

// Create the original callback at its original registration point in app.js.
function appFreetalkCallback557() {
  return (e=>{if(e.target.classList.contains('freetalk-summary-input') && e.target.dataset.key) freetalkSummaryDrafts.set(e.target.dataset.key,e.target.value);});
}
