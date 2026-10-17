'use strict';
let roleSettingsBusy = false, roleSettingsNotice = '', roleHistoryOpen = false, roleHistoryData = null;
let roleHistoryDate = '', roleHistoryId = '';
let renderedRoleManagementKey = '';
const roleDateLabel = value => value ? new Date(value).toLocaleString(UI.dateLocale) : UI.text('未実施');
function roleDayBefore(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  const [y,m,d] = value.split('-').map(Number), start = new Date(y,m-1,d);
  if (start.getFullYear() !== y || start.getMonth() !== m-1 || start.getDate() !== d) return '';
  return new Date(y,m-1,d+1).toISOString(); // local next midnight, including DST
}
function roleHistorySelection(rows, date, id) {
  if (id) return rows.find(r=>r.id===id);
  const before = roleDayBefore(date);
  return before ? rows.findLast(r=>Date.parse(r.at)<Date.parse(before)) : rows.at(-1);
}
function roleSettingsHtml() {
  const m=state.roles.management;
  if (!m) return '';
  renderedRoleManagementKey=JSON.stringify(m);
  const topic=m.review?.task ? m.review : m.lastReview;
  const disabled=roleSettingsBusy||Boolean(m.review)||rolesDirty();
  const slot = s => s ? [s.ai==='claude-code'?'Claude Code':s.ai, s.model, s.effort].filter(Boolean).join('・') : '—';
  const r=roleHistoryOpen&&roleHistoryData ? roleHistorySelection(roleHistoryData.history,roleHistoryDate,roleHistoryId) : null;
  const sameDay=roleHistoryData?.history.filter(x=>{
    if (!roleHistoryDate) return true;
    const end=roleDayBefore(roleHistoryDate), [y,m,d]=roleHistoryDate.split('-').map(Number);
    return end && Date.parse(x.at)>=new Date(y,m-1,d).getTime() && Date.parse(x.at)<Date.parse(end);
  }) || [];
  return UI.template`<div class="role-settings-controls">
    <div class="acts"><button type="button" class="btn" data-role-setting="review" ${disabled?'disabled':''}>手動見直し</button>
      <button type="button" class="btn plain" data-role-setting="history" ${roleSettingsBusy?'disabled':''}>変更履歴</button>
      ${m.defaultSavedAt?UI.template`<button type="button" class="btn plain" data-role-setting="default" ${disabled?'disabled':''}>デフォルトに戻す</button>`:''}
      <button type="button" class="btn plain" data-role-setting="save-default" ${roleSettingsBusy||m.review?'disabled':''}>現状をデフォルトにする</button>
      ${m.review?UI.html('<button type="button" class="btn plain" data-role-setting="cancel">見直しを中断</button>'):''}</div>
    <p class="small">最終見直し日時：${esc(roleDateLabel(m.lastReviewedAt))}</p>
    <p class="small">手動見直しではfreetalkに新しい話題を作り、Opus 5.5とGPT-6.1-Solが相談します。使える方が一つならそのAIが判断し、変更は次の起動から反映します。</p>
    ${topic?.task?UI.template`<button type="button" class="btn plain sm" data-role-setting="topic" data-task="${esc(topic.task)}">見直しの話題を開く</button>`:''}
    <p class="small">デフォルト：${esc(m.defaultSavedAt?roleDateLabel(m.defaultSavedAt):UI.text('未設定'))}。［現状をデフォルトにする］で表示中の役割を保存します。</p>
    ${rolesDirty()?UI.html('<p class="small">編集中の設定を保存するか、［元に戻す］で編集を取り消してから見直し・復元できます。</p>'):''}
    <p class="small" role="status">${esc(roleSettingsNotice || m.review?.message || m.lastReview?.message || '')}</p>
    ${roleHistoryOpen?UI.template`<div class="role-history"><h3>変更履歴</h3><p class="small">日時はこの端末の時刻です。日付を選ぶと、その日の最後の設定を表示します。変更がない日は直前の記録を使います。</p>
      <div class="acts"><label>日付 <input id="role-history-date" type="date" value="${esc(roleHistoryDate)}"></label>
      <label>時刻 <select id="role-history-id"><option value="">その日の最後</option>${sameDay.map(x=>UI.template`<option value="${esc(x.id)}" ${x.id===roleHistoryId?'selected':''}>${esc(roleDateLabel(x.at))}</option>`).join('')}</select></label></div>
      ${!roleHistoryData?UI.html('<p>履歴を読み込んでいます…</p>'):r?UI.template`<p class="small">この設定が有効になった日時：${esc(roleDateLabel(r.at))}<br>${esc(r.reason)}<br>判断に参加：${esc(r.participants?.map(p=>p.ai+' / '+p.model).join('、') || '人')}</p>
        <div class="tbl"><table><tr><th>役割</th><th>いつもの担当</th><th>上限の時</th></tr>${r.roles.map(x=>UI.template`<tr><td>${esc(x.name)}</td><td>${esc(slot(x.main))}</td><td>${esc(slot(x.backup))}</td></tr>`).join('')}</table></div>
        ${r.changes?.length?UI.template`<details class="more"><summary>変更前と変更後</summary>${r.changes.map(c=>UI.template`<p class="small"><b>${esc(c.role)}</b><br>いつもの担当：${esc(slot(c.before?.main))} → ${esc(slot(c.after?.main))}<br>上限の時：${esc(slot(c.before?.backup))} → ${esc(slot(c.after?.backup))}</p>`).join('')}</details>`:''}
        <button type="button" class="btn" data-role-setting="restore" ${disabled?'disabled':''}>この設定に戻す</button>`:UI.html('<p>その日時の記録はありません。記録開始以降を選んでください。</p>')}
      <p class="small">記録開始：${esc(roleDateLabel(m.startedAt))} ／ 固定デフォルトの保存：${esc(roleDateLabel(m.defaultSavedAt))}</p>
      <button type="button" class="btn plain" data-role-setting="close">履歴を閉じる</button></div>`:''}
    </div>`;
}
function drawRoleSettings() {
  const box=document.getElementById('role-settings-controls');
  if(box)box.innerHTML=roleSettingsHtml();
}
function syncRoleSettings() {
  if (view.kind!=='settings' || roleSettingsBusy || !state.roles.management) return;
  // A completed review may change the table too. Defer a full redraw while a
  // person is typing elsewhere in settings; status alone can still update.
  if (!rolesDraft && !editing()) { render(); return; }
  if (renderedRoleManagementKey!==JSON.stringify(state.roles.management)) {
    roleSettingsNotice='';drawRoleSettings();
  }
}
document.addEventListener('change',e=>{
  if(e.target.id==='role-history-date'){roleHistoryDate=e.target.value;roleHistoryId='';drawRoleSettings();}
  if(e.target.id==='role-history-id'){roleHistoryId=e.target.value;drawRoleSettings();}
});
document.addEventListener('click',async e=>{
  const action=e.target.closest?.('[data-role-setting]')?.dataset.roleSetting;
  if(!action||roleSettingsBusy)return;
  if(action==='close'){roleHistoryOpen=false;drawRoleSettings();return;}
  if(['review','default','restore'].includes(action)&&rolesDirty())return;
  const revision=rolesDraftRevision || state.roles.management?.revision;
  roleSettingsBusy=true;roleSettingsNotice='';drawRoleSettings();
  try {
    if(action==='topic'){
      const task=e.target.closest('[data-task]').dataset.task;
      await load();view={kind:'work',project:'freetalk',task};markRead(view.project,view.task);showInTree();save();
    }else if(action==='save-default'){
      state.roles=await api('/api/roles/default',{roles:rolesDraft || state.roles.roles,expectedRevision:revision});
      if(rolesDraft)rolesDraftRevision=state.roles.management.revision;
      roleHistoryData=null;roleHistoryOpen=false;
      toast(UI.text('表示中の役割をデフォルトとして保存しました'));
    }else if(action==='history'){
      roleHistoryData=await api('/api/roles/history');roleHistoryOpen=true;
    }else if(action==='review'){
      const r=await api('/api/roles/review',{expectedRevision:revision});
      state.roles.management=r.management;roleHistoryData=null;roleHistoryOpen=false;
    }else if(action==='cancel'){
      state.roles=await api('/api/roles/review/cancel',{});clearRolesDraft();
    }else{
      const row=action==='restore'&&roleHistorySelection(roleHistoryData.history,roleHistoryDate,roleHistoryId);
      state.roles=await api('/api/roles/restore',{defaults:action==='default',id:row?.id,expectedRevision:revision});
      clearRolesDraft();roleHistoryData=null;roleHistoryOpen=false;
      toast(UI.text('設定を復元しました。次の起動から反映します。'));
    }
  }catch(error){roleSettingsNotice=error.message;}
  finally{roleSettingsBusy=false;render();}
});
