'use strict';
// Classic-script declarations only. Shared state and startup stay in app.js.
// See README.md for the loading and state contract.

function refreshRequestStatus(box) {
  const gptDone = new Set([...box.querySelectorAll('[data-gpt-report]')].map(e => e.dataset.gptReport));
  box.querySelectorAll('[data-gpt-request]').forEach(e => {
    e.querySelector('[data-gpt-status]').textContent = UI.text(gptDone.has(e.dataset.gptRequest) ? 'ChatGPT（Chat）への依頼（処理済み）' : 'ChatGPT（Chat）への依頼（未処理）');
  });

}

function openChat(p, t, savedScroll) {
  const box = $('#msgs');
  box.dataset.askHistoryPending = '1';
  const ta = $('#chat-in');
  const draftKey = chatAttachmentKey(p.id, t.id);
  ta.addEventListener('input', () => { setChatDraft(draftKey, ta.value); });
  const filesInput = $('#chat-files');
  $('#chat-attach').addEventListener('click', () => {
    filesInput.accept = p.id === 'freetalk' ? FREETALK_ACCEPT : isPhone() ? 'image/*' : '';
    filesInput.value = '';
    filesInput.click();
  });
  filesInput.addEventListener('change', () => {
    const files = [...filesInput.files];
    filesInput.value = '';
    if (view.kind !== 'work' || view.project !== p.id || view.task !== t.id || workMode() !== 'chat' || $('#chat-files') !== filesInput) return;
    return sendFiles(files, '');
  });
  $('#chat-images').addEventListener('click', e => {
    const button = e.target.closest('[data-chat-remove]');
    if (button) removeChatImage(p.id, t.id, button.dataset.chatRemove);
    else openAttachment(e.target.closest('[data-image-open]'));
  });
  const openAttachment = trigger => {
    if (!trigger) return;
    const image = chatImages(p.id, t.id).find(x => x.id === trigger.dataset.imageOpen);
    if (!image || chatSending.has(draftKey)) return;
    const cursor = [ta.selectionStart, ta.selectionEnd, ta.scrollTop];
    void showFileViewer(image.path, 'image', trigger, { url: image.url, restore: () => { if ($('#chat-in') === ta && view.project === p.id && view.task === t.id) { ta.focus({ preventScroll: true }); ta.setSelectionRange(cursor[0], cursor[1]); ta.scrollTop = cursor[2]; } }, remove: () => {
      if (view.project === p.id && view.task === t.id && !chatSending.has(draftKey) && chatImages(p.id, t.id).includes(image)) removeChatImage(p.id, t.id, image.id);
    } });
  };
  $('#chat-images').addEventListener('keydown', e => {
    const trigger = e.target.closest('[data-image-open]');
    if (trigger && ['Enter', ' '].includes(e.key)) { e.preventDefault(); openAttachment(trigger); }
  });
  let composing = false;
  ta.addEventListener('compositionstart', () => { composing = true; });
  ta.addEventListener('compositionend', () => { composing = false; });
  ta.addEventListener('keydown', e => {
    if (composing || e.isComposing || e.keyCode === 229) return;
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
      const direction = e.key === 'ArrowUp' ? -1 : 1;
      if (!window.HubChatHistory.atBoundary(ta, direction)) return;
      const value = instructionHistory.move(draftKey, direction, ta.value, ta.selectionStart, ta.selectionEnd);
      if (value) {
        e.preventDefault(); ta.value = value.text; setChatDraft(draftKey, value.text);
        ta.setSelectionRange?.(value.start, value.end); window.HubMobile?.draft();
      }
    } else if (isSendKey(e)) { e.preventDefault(); $('#composer').requestSubmit(); }
  });
  const keep = (manual = true) => { const [ai, model] = $('#chat-ai').value.split('|'); if (manual) specialOverrides.set(p.id + '/' + t.id, { ai, model, effort: $('#chat-effort').value }); try { localStorage.setItem('hub-chat-' + p.id + '/' + t.id, JSON.stringify({ ai, model, effort: $('#chat-effort').value })); } catch (e) { /* 無視 */ } };
  $('#chat-ai').addEventListener('change', () => { drawChatAccount(p, t); const ai = $('#chat-ai').value.split('|')[0], agy = ai === 'agy'; const e = $('#chat-effort'), previous = e.value; e.hidden = effortHidden(ai); e.disabled = agy || ['chatgpt', 'dot'].includes(ai); e.innerHTML = effortsFor(ai).map(v => UI.template`<option ${v === (agy ? '高' : effortsFor(ai).includes(previous) ? previous : '高') ? 'selected' : ''}${UI.valueAttribute(v)}>${esc(UI.label(v))}</option>`).join(''); keep(); syncChatWebchatAvailability(); }); $('#chat-effort').addEventListener('change', () => keep());
  const updateDiscussion = bindDiscussion(p, t);
  $('#chat-stop').addEventListener('click', () => api('/api/chat/stop', { project: p.id, task: t.id }).then(r=>{state.stopControl=r;toast(r.ok?'停止処理を終えました。新しい指示を送ると、この会話だけ再開します。待ち指示は保留中です':'停止を確認できないAIがあります。設定の［復旧］を確認してください');}).catch(e => toast(e.message)));
  // mode: ''（普通）／'interrupt'（① 中断して送る）／'queue'（② 追加：終わったら続けて）
  const sendChat = async (mode, answer) => {
    if (discussionUI()?.active()) { toast(UI.text('話し合いが進行中です。停止または完了後に送ってください')); return false; }
    if (chatSending.has(draftKey)) return false;
    if (['chatgpt|chat','chatgpt|app'].includes($('#chat-ai').value)) { toast(UI.text('廃止された経路です。ChatGPT（Chat／Pro）を選び直してください')); return false; }
    if (chatImageUploads.get(draftKey)) { toast(UI.text('添付ファイルの追加が終わってから送ってください')); return false; }
    const original = answer === undefined ? ta.value : answer, sent = answer === undefined ? [...chatImages(p.id, t.id)] : [];
    const text = chatSendText(original, sent);
    if (!text) { toast(UI.text('依頼を書いてください')); return false; }
    if ($('#chat-ai').selectedOptions?.[0]?.disabled) { toast(UI.text('利用できないモデルです。新しい候補を選んでください')); return false; }
    if (!mode && $('#chat-ai').value !== 'chatgpt|auto' && !warnChildren(p)) return false;
    if (accountSelectionSaving) { toast(UI.text('アカウントの選択を保存中です')); return false; }
    if (taskFastSaving || accelerationSaving) { toast(UI.text('加速の選択を保存中です')); return false; }
    const [ai, model] = $('#chat-ai').value.split('|');
    if (ai === 'chatgpt' && model === 'auto' && sent.length) { toast(UI.text('Chat／Proへの依頼は本文を保存してください。画像は場所を本文に書いてください')); return false; }
    if (ai === 'dot') { toast(UI.text('Dot連携は廃止しました。送信先を選び直してください')); return false; }
    keep(false);
    if (answer === undefined) chatDraft[draftKey] = original;
    // 通信の完了を待たずに入力欄を空にする。送信中の新しい下書きは別に保持する。
    if (answer === undefined) { setChatDraft(draftKey, ''); ta.value = ''; }
    const draftRevision = chatDraftRevisions.get(draftKey) || 0;
    let accepted = false;
    const question = taskOf(proj(p.id), t.id)?.question || '';
    const askKey = [...box.querySelectorAll('.ask')].filter(a => !a.classList.contains('done')).at(-1)?.dataset.askKey;
    const attempt = question && askKey ? { question, askKey } : null;
    if (attempt) askAttempts.set(draftKey, attempt);
    chatSending.add(draftKey); updateWorkAnswerControls();
    try {
      const sc=state.stopControl,st=sc?.tasks?.find(x=>x.project===p.id&&x.task===t.id);
      const r = await api('/api/chat/send', { manualStopTicket:sc?{epoch:sc.epoch,task:st?.epoch||0}:undefined, project: p.id, task: t.id, ai, account: (taskOf(proj(p.id), t.id) || t).accounts?.[ai] || 'default', model: modelRequest(ai,model), effort: $('#chat-effort').value, text, projectImages: p.kind !== 'freetalk' && sent.length ? sent.filter(x => x.kind !== 'file').map(x => x.id) : undefined, attachmentDraft: answer === undefined && sent.length ? { text: original, attachments: sent } : undefined, images: p.id === 'freetalk' ? sent.map(x => x.id) : ai === 'chatgpt' ? sent.filter(x => x.kind !== 'file').map(x => x.id) : undefined, generation: p.id === 'freetalk' ? attachmentGeneration(t.id) : undefined, mode, answerQuestion: question }).catch(err => {
        // 停止確認は未完でも、この要求の本文が順番待ちへ保存済みなら戻さない。
        // 受付証拠のない拒否・通信断は従来どおり原稿を保護する。
        if (err.status === 409 && err.queued === true && typeof err.id === 'string' && err.id.trim()) return { queued: true, id: err.id, waitReason: err.message };
        throw err;
      });
      accepted = true;
      clearSentChatImages(p.id, t.id, sent);
      specialOverrides.delete(p.id + '/' + t.id);
      if (state.specialMode?.enabled) syncSpecialPick(p, t);
      if (answer === undefined) instructionHistory.record(draftKey, original);
      if (askAttempts.get(draftKey) === attempt) askAttempts.delete(draftKey);
      await acceptedWorkAnswer(p, t, question, r, askKey);
      if (answer === undefined && chatDraft[draftKey] === '' && (chatDraftRevisions.get(draftKey) || 0) === draftRevision) {
        instructionHistory.reset(draftKey);
      }
      if (view.kind === 'work' && view.project === p.id && view.task === t.id && $('#chat-in') === ta) {
        scroll(true);
        if (answer === undefined) window.HubMobile?.sent();
      }
      if (r.webchat) { await load(); toast(UI.text('Chat／Proへ送ります。返事はこの会話に届きます')); return true; }
      if (r.queued) { toast(r.waitReason ? UI.text('指示は受け付けました。') + r.waitReason : UI.template`順番待ちにしました。今の作業が終わったら始めます（待っている指示 ${r.queue} 件）`); return true; }
      if (view.kind !== 'work' || view.project !== p.id || view.task !== t.id || $('#chat-in') !== ta) return true;
      if (mode === 'redo') { chatBusy = null; toast(UI.text('前の指示を取り消して、新しい指示でやり直しています')); }
      if (mode === 'amend') { chatBusy = null; toast(UI.text('追加の説明を合わせて、作業を続けています')); }
      if (!chatBusy) setBusy({ ai, model: r.model || model, started: Date.now(), text: '' }); // 知らせを待たずに「作業中」を出す
      if (r.note) toast(r.note);
      return true;
    } catch (err) {
      if (!accepted && answer === undefined) {
        const next = chatDraft[draftKey] || '';
        const restored = original && next ? original + '\n\n' + next : original || next;
        setChatDraft(draftKey, restored);
        const current = view.kind === 'work' && view.project === p.id && view.task === t.id && workMode() === 'chat' ? $('#chat-in') : null;
        if (current) current.value = restored;
      }
      toast(err.message); return false;
    }
    finally { chatSending.delete(draftKey); updateWorkAnswerControls(); }
  };
  $('#composer').addEventListener('submit', e => { e.preventDefault(); sendChat(chatBusy ? 'queue' : ''); });
  $('#chat-redo').addEventListener('click', () => sendChat('redo'));
  $('#chat-amend').addEventListener('click', () => sendChat('amend'));
  $('#chat-q').addEventListener('click', () => sendChat('queue'));
  sendWorkAnswer = { project: p.id, task: t.id, send: answer => sendChat(chatBusy ? 'queue' : '', answer) };
  updateWorkAnswerControls();
  bindAskAnswers(box, answer => sendChat(chatBusy ? 'queue' : '', answer));
  // 待ち指示の編集は本文の下書きと分けて保持する。
  let lastQueue = [], queueSending = false, queueEditRequest = null, retreatNotice = '', retreatError = false, retreatSaved = false;
  const retreatKey = 'hub-queue-retreat:' + draftKey;
  let retreatPending; try { retreatPending = JSON.parse(localStorage.getItem(retreatKey) || 'null'); } catch {}
  // The input node identifies this view generation, even after returning to the
  // same project/task. Only the request that still owns the stored receipt may
  // change it; a disposed view's absent/complete response must be ignored.
  const currentQueueView = () => view.kind === 'work' && view.project === p.id && view.task === t.id && $('#chat-in') === ta;
  const sameRetreat = (a, b) => a && b && ['project','task','id','opId','expected'].every(k => a[k] === b[k]);
  const ownsRetreat = attempt => {
    if (!currentQueueView() || !sameRetreat(attempt, retreatPending)) return false;
    try { return sameRetreat(attempt, JSON.parse(localStorage.getItem(retreatKey) || 'null')); } catch { return false; }
  };
  const retreatable = x => p.kind !== 'freetalk' && !['automation','readOnly','selectionOnly','limitSwitch','resultsOrganize','isolatedReview','integrationReviewRequest','integrationAssignment','resultsRecoveryHash','discussionTurn','reviewKind','limitPolicy'].some(k=>x[k]) && !/^(?:limit-|idea-|discussion-|role-review-|integration-)/.test(x.id) && !/\[(?:integration-auto|idea-run):/.test(x.text) && (!x.origin || x.origin==='delegate');
  const queueHash = async item => {
    const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>[k,canonical(v[k])])) : v;
    const clean = Object.fromEntries(Object.entries(item).filter(([k])=>!['error','stopHeld','limitWaiting'].includes(k)));
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(canonical(clean),null,2)+'\n')))].map(x=>x.toString(16).padStart(2,'0')).join('');
  };
  const retreatDone = (r, attempt) => {
    if (!ownsRetreat(attempt) || (r.opId && r.opId !== attempt.opId)) return false;
    // Only an authoritative absent receipt releases an unprepared local attempt,
    // including after a rejected upload's response/receipt was lost and reloaded.
    if(r.state==='absent'){localStorage.removeItem(retreatKey);retreatPending=null;return false;}
    if(!r.complete)return false;
    localStorage.removeItem(retreatKey);retreatPending=null;retreatSaved=true;retreatError=false;retreatNotice=r.removed?'退避した記録は削除済みです。':'台帳へ退避しました。制作は始まりません。';return true;
  };
  const editableQueue = x => x.origin !== 'hub-internal' && !x.automation && !x.selectionOnly && !x.readOnly && !x.limitSwitch && !x.resultsOrganize && !x.integrationAssignment && !x.isolatedReview && !x.integrationReviewRequest;
  const queueChoices = draft => chatModelChoices(p, t, { ai: draft.ai, model: draft.model }).replace(/<option value="chatgpt[\s\S]*?<\/option>/g, '');
  const changedDraft = draft => JSON.stringify([draft.text, draft.ai, draft.model, draft.attachments.map(x => x.id)]);
  const drawQueue = q => {
    const el = $('#chat-queue'); if (!el) return;
    const before = position(), focused = document.activeElement;
    const selection = focused?.dataset?.queueText ? [focused.selectionStart, focused.selectionEnd] : null;
    lastQueue = q || [];
    const draft = queueDrafts.get(draftKey), item = draft && lastQueue.find(x => x.id === draft.id);
    if (p.kind === 'freetalk') syncFreetalkHistory(p,t,lastQueue.length ? UI.text('順番待ちがあります。終了または取り消し後に整理してください') : '');
    el.hidden = !lastQueue.length && !draft && !retreatPending && !retreatNotice;
    const disabled = queueSending || retreatPending ? 'disabled' : '';
    const queueHeld=state.stopControl?.all||state.stopControl?.tasks?.some(x=>x.project===p.id&&x.task===t.id);
    const markup = (!chatBusy && lastQueue.length ? UI.template`<div class="small qh">${queueHeld?'停止前の待ち指示は保留中です。新しい指示は入力欄から送れます。待ち指示の再開は設定の［復旧］で許可してください。':lastQueue.some(x=>x.stopHeld)?'停止前の待ち指示は自動では始まりません。［▶ 始める］で送れます':'待っている指示があります（止まっています）。［▶ 始める］で送れます'}</div>` : '')
      + lastQueue.map((x, i) => UI.template`<div class="qi"><span class="qn">次 ${i + 1}</span><span class="qt" title="${esc(x.text)}">${esc(x.text.split('\n')[0])}</span><span class="small">${esc(AI_LABEL[x.ai])}・${esc(x.model || '')}</span><span class="qactions">${retreatable(x) ? UI.template`<button type="button" class="qgo qretreat" data-qretreat="${esc(x.id)}" title="本文と画像を記録だけで保存して、この待ち指示を外します" ${queueSending || draft || retreatPending ? 'disabled' : ''}>台帳へ退避</button>` : ''}${editableQueue(x) ? UI.template`<button type="button" class="qgo" data-qedit="${esc(x.id)}" ${disabled}>編集</button>${chatBusy ? UI.template`<button type="button" class="qgo" data-qamend="${esc(x.id)}" title="今の指示と合わせて送ります" ${disabled}>すぐ追加</button>` : ''}` : ''}${!chatBusy && i === 0 ? UI.template`<button type="button" class="qgo" data-run="${esc(x.id)}" ${disabled}>▶ 始める</button>` : ''}<button type="button" class="qx" data-unq="${esc(x.id)}" aria-label="取り消す" ${disabled}>✕</button></span></div>`).join('')
      + (queueSending || retreatPending || retreatNotice ? UI.template`<div class="qretreat-status ${retreatError?'error':''}" role="status" aria-live="polite">${esc(queueSending?'台帳へ退避中… 元の指示を保全しています。':retreatNotice || '前回の退避結果を確認できます。')}${retreatPending?UI.template`<button type="button" class="qgo qretreat" data-qretreat-retry="1" ${queueSending?'disabled':''}>退避を確認</button>`:''}${retreatSaved?UI.html('<button type="button" class="qgo qretreat" data-qretreat-open="1">台帳を開く</button>'):''}</div>`:'')
      + (draft ? UI.template`<div class="qeditor"><label>AI・モデル<select data-queue-model="${esc(draft.id)}" ${disabled}>${queueChoices(draft)}</select></label><p class="small">この待ち指示だけに適用します。</p><label>待ち指示を編集<textarea data-queue-text="${esc(draft.id)}" rows="3">${esc(draft.text)}</textarea></label><div class="quick-images" data-queue-images>${attachmentImagesHtml(draft.attachments)}</div>${!item ? UI.html('<div class="small">その指示はもう待っていません。編集内容は残っています。</div>') : ''}<div class="qactions"><button type="button" class="qgo" data-qsave="${esc(draft.id)}" ${queueSending || !item ? 'disabled' : ''}>保存</button><button type="button" class="qgo" data-qclose="${esc(draft.id)}" ${disabled}>戻る</button></div></div>` : '');
    if (el.queueMarkup !== markup) {
      el.queueMarkup = markup; el.innerHTML = markup;
      if (focused?.dataset?.queueModel && draft) el.querySelector('[data-queue-model]')?.focus({ preventScroll: true });
      if (selection && draft) {
        const input = el.querySelector('[data-queue-text]'); input?.focus();
        input?.setSelectionRange(selection[0], selection[1]);
      }
    }
    scroll(false,before);
  };
  $('#chat-queue').addEventListener('input', e => {
    const draft = queueDrafts.get(draftKey);
    if (draft && e.target.dataset?.queueText === draft.id) draft.text = e.target.value;
  });
  $('#chat-queue').addEventListener('change', e => {
    const draft = queueDrafts.get(draftKey);
    if (draft && !queueSending && e.target.dataset?.queueModel === draft.id) [draft.ai, draft.model] = e.target.value.split('|');
  });
  const openQueueImage = trigger => {
    const draft = queueDrafts.get(draftKey), image = draft?.attachments.find(x => x.id === trigger?.dataset.imageOpen);
    if (!image || queueSending) return;
    const input = $('#chat-queue').querySelector('[data-queue-text]'), cursor = [input?.selectionStart, input?.selectionEnd, input?.scrollTop];
    void showFileViewer(image.path, 'image', trigger, { url: image.url, restore: () => {
      if (view.project === p.id && view.task === t.id && queueDrafts.get(draftKey) === draft) {
        const el = $('#chat-queue').querySelector('[data-queue-text]'); el?.focus({ preventScroll: true }); el?.setSelectionRange(cursor[0], cursor[1]); if (el) el.scrollTop = cursor[2];
      }
    }, remove: () => {
      if (view.project === p.id && view.task === t.id && queueDrafts.get(draftKey) === draft && !queueSending && lastQueue.some(x => x.id === draft.id)) {
        draft.attachments = draft.attachments.filter(x => x !== image); drawQueue(lastQueue);
      }
    } });
  };
  $('#chat-queue').addEventListener('keydown', e => { if (['Enter', ' '].includes(e.key) && e.target.dataset?.imageOpen) { e.preventDefault(); openQueueImage(e.target); } });
  $('#chat-queue').addEventListener('click', async e => {
    const trigger = e.target.closest('[data-image-open]');
    if (trigger?.dataset?.imageOpen) { openQueueImage(trigger); return; }
    const button = e.target.closest('button'), d = button?.dataset || {};
    if (queueSending || !button) return;
    // Any newer queue action supersedes an attachment lookup, even if that
    // action finishes before the older GET returns.
    queueEditRequest = null;
    if(d.qretreatOpen){window.HubIdeas.open(p.id,t.id);return;}
    if(d.qretreat || d.qretreatRetry){
      if(queueDrafts.has(draftKey)){toast(UI.text('編集中の指示を保存するか、［戻る］で閉じてから退避してください'));return;}
      queueSending=true;retreatError=false;retreatNotice='';drawQueue(lastQueue);
      let attempt;
      try{
        if(!retreatPending){const item=lastQueue.find(x=>x.id===d.qretreat);if(!item)throw Error('その指示はもう待っていません');
          const pending={project:p.id,task:t.id,id:item.id,opId:crypto.randomUUID(),expected:await queueHash(item)};
          if(!currentQueueView())return;
          // Another view/tab may have created a receipt while hashing.
          if(localStorage.getItem(retreatKey))return;
          localStorage.setItem(retreatKey,JSON.stringify(pending));retreatPending=pending;
        }
        attempt={...retreatPending};
        if(!ownsRetreat(attempt))return;
        const r=await api('/api/chat/queue/retreat',attempt,{'X-Hub-UI':'queue'});
        if(!ownsRetreat(attempt))return;
        if(retreatDone(r,attempt))lastQueue=lastQueue.filter(x=>x.id!==attempt.id);
        else throw Error('退避結果を確認中です。元の指示は実行しません。');
      }catch(err){
        if(!currentQueueView() || (attempt && !ownsRetreat(attempt)))return;
        retreatError=true;retreatNotice=err.message+'。待ち指示と保存結果を確認してから続けられます。';
        if(attempt)try{const r=await api('/api/chat/queue/retreat?'+new URLSearchParams(attempt),null,{'X-Hub':'1'});retreatDone(r,attempt);}catch{}
      }finally{queueSending=false;if(view.kind==='work'&&view.project===p.id&&view.task===t.id&&$('#chat-in')===ta)drawQueue(lastQueue);}
      return;
    }
    if (d.chatRemove) { const draft = queueDrafts.get(draftKey); if (draft) { draft.attachments = draft.attachments.filter(x => x.id !== d.chatRemove); drawQueue(lastQueue); } return; }
    if (d.qclose) { queueDrafts.delete(draftKey); drawQueue(lastQueue); return; }
    if (d.qedit) {
      const item = lastQueue.find(x => x.id === d.qedit); if (!item) return;
      const draft = queueDrafts.get(draftKey);
      if (draft && draft.id !== item.id) { toast(UI.text('編集中の指示を保存するか、［戻る］で閉じてください')); return; }
      if (!draft) {
        let source = item.attachmentDraft || { text: item.text, attachments: [] }, expectedItem = JSON.stringify(item);
        if (!item.attachmentDraft && /参照画像（絶対パス）：/.test(item.text)) {
          const request = queueEditRequest = {};
          const ownsEdit = () => currentQueueView() && queueEditRequest === request && !queueSending && !retreatPending && !localStorage.getItem(retreatKey) && !queueDrafts.has(draftKey) && JSON.stringify(lastQueue.find(x => x.id === item.id)) === expectedItem;
          try {
            const r = await api('/api/chat/queue/draft?' + new URLSearchParams({ project: p.id, task: t.id, id: item.id }));
            if (!ownsEdit()) return;
            if (r.expectedItem !== expectedItem) throw Error(UI.text('待ち指示が変更されています。編集を開き直してください'));
            source = r.draft;
          } catch (err) { if (ownsEdit()) toast(err.message); return; }
          finally { if (queueEditRequest === request) queueEditRequest = null; }
        }
        const next = { id: item.id, original: item.text, expectedItem, text: source.text, attachments: [...source.attachments], ai: item.ai, model: item.model };
        next.baseline = changedDraft(next); queueDrafts.set(draftKey, next);
      }
      drawQueue(lastQueue); $('#chat-queue').querySelector('[data-queue-text]')?.focus(); return;
    }
    const id = d.qsave || d.qamend || d.unq || d.run;
    if (!id) return;
    const item = lastQueue.find(x => x.id === id), draft = queueDrafts.get(draftKey);
    if (!item) { toast(UI.text('その指示はもう待っていません')); return; }
    if ((d.qamend || d.run) && draft?.id === id && changedDraft(draft) !== draft.baseline) { toast(UI.text('編集内容を保存してから送ってください')); return; }
    if (d.qsave && $('#chat-queue').querySelector('[data-queue-model]')?.selectedOptions?.[0]?.disabled) { toast(UI.text('利用できないモデルです。新しい候補を選んでください')); return; }
    if (d.qsave && !draft?.text.trim() && !draft?.attachments.length) { toast(UI.text('依頼を書いてください')); return; }
    const sent = draft?.text, sentDraft = draft && changedDraft(draft);
    queueSending = true; drawQueue(lastQueue);
    try {
      const body = { project: p.id, task: t.id, id };
      const r = d.qsave ? await api('/api/chat/queue/edit', { ...body, text: sent, expectedText: draft.original, expectedItem: draft.expectedItem, ai: draft.ai, model: modelRequest(draft.ai, draft.model), attachmentIds: draft.attachments.map(x => x.id) })
        : d.unq ? await api('/api/chat/unqueue', body)
        : await api('/api/chat/send', { project: p.id, task: t.id, fromQueue: id, expectedText: item.text, expectedItem: JSON.stringify(item), mode: d.qamend ? 'amend' : '' });
      if (draft?.id === id && queueDrafts.get(draftKey) === draft) {
        if (d.qsave && changedDraft(draft) !== sentDraft) { const saved = r.queue.find(x => x.id === id); draft.original = saved.text; draft.expectedItem = JSON.stringify(saved); draft.baseline = sentDraft; }
        else queueDrafts.delete(draftKey);
      }
      if (d.qsave) lastQueue = lastQueue.map(x => x.id === id ? r.queue.find(y => y.id === id) || x : x);
      else lastQueue = lastQueue.filter(x => x.id !== id);
      toast(UI.text(d.qsave ? '待ち指示を保存しました' : d.unq ? '取り消しました' : d.qamend ? '追加指示として送りました' : '指示を送りました'));
    } catch (err) { toast(err.message); }
    finally {
      queueSending = false;
      if (view.kind === 'work' && view.project === p.id && view.task === t.id && $('#chat-in') === ta) drawQueue(lastQueue);
    }
  });
  if(retreatPending){const attempt={...retreatPending};setTimeout(async()=>{
    // Serialize the reload lookup with retry: an older absent response must not
    // discard the opId of a new POST that has already prepared/saved the retreat.
    if(queueSending || !ownsRetreat(attempt))return;
    queueSending=true;drawQueue(lastQueue);
    try{const r=await api('/api/chat/queue/retreat?'+new URLSearchParams(attempt),null,{'X-Hub':'1'});retreatDone(r,attempt);}catch(err){if(ownsRetreat(attempt)){retreatNotice=err.message;retreatError=true;}}
    finally{queueSending=false;if(view.kind==='work'&&view.project===p.id&&view.task===t.id&&$('#chat-in')===ta)drawQueue(lastQueue);}
  },0);}
  const scroller = window.HubChatScroll?.create(box,$('#chat-latest'),savedScroll);
  chatScroller = scroller;
  box.dataset.scrollKey = JSON.stringify([p.id,t.id]);
  const position = () => scroller ? scroller.capture() : {top:box.scrollTop,follow:box.scrollHeight-box.scrollTop-box.clientHeight<80};
  const scroll = (force, before = position()) => { if (scroller) scroller.restore(before,force); else if(force || before.follow) box.scrollTop=box.scrollHeight; };
  // 作業中の表示：動く印・かかった時間・今していること。終わったら消して、知らせる
  const setBusy = b => {
    if (p.kind === 'freetalk') syncFreetalkHistory(p,t,b ? UI.text('AIが作業中です。返事が終わってから整理してください') : '');
    const before = position();
    const was = chatBusy;
    chatBusy = b;
    $('#chat-busyrow').hidden = !b; $('#chat-send').hidden = Boolean(b);
  const discussing = Boolean(discussionUI()?.active());
    $('#chat-redo').hidden = !b || b.webchat || discussing; $('#chat-amend').hidden = !b || b.webchat || discussing; $('#chat-q').hidden = !b || b.webchat || discussing;
    if (Boolean(was) !== Boolean(b)) drawQueue(lastQueue); // ［▶ 始める］の出し入れ
    let tmp = $('#msg-partial');
    if (!b) {
      clearInterval(busyTimer); busyTimer = null;
      if (tmp) tmp.remove();
      $('#chat-state').innerHTML = '';
      scroll(false,before); window.HubMobile?.badges();
      return;
    }
    if (!b.started) b.started = (was && was.started) || Date.now();
    if (!tmp) {
      box.insertAdjacentHTML('beforeend', UI.template`<div class="m ai working" id="msg-partial"><div class="mh"><span class="chip k-${esc(b.ai)}"><span class="ic">${AI_ICON[b.ai] || '?'}</span>${esc(AI_LABEL[b.ai] || b.ai)}${b.model ? UI.template`<small>・${esc(b.model)}</small>` : ''}</span>
        <span class="wk"><i class="spin"></i>作業中<span class="dots"><i>.</i><i>.</i><i>.</i></span> <span class="wk-time"></span></span></div>
        <div class="wk-last"></div><div class="mb" hidden></div></div>`);
      tmp = $('#msg-partial');
    }
    const mb = tmp.querySelector('.mb');
    mb.hidden = !b.text; mb.innerHTML = richText(b.text || '', true);
    if (b.last && showDetail()) tmp.querySelector('.wk-last').textContent = '▸ ' + b.last;
    if (!was || was.ai !== b.ai || was.model !== b.model) {
      $('#chat-state').innerHTML = UI.template`<span class="wk"><i class="spin"></i>${esc(AI_LABEL[b.ai])}${b.model ? '・' + esc(b.model) : ''} が作業中… <span id="chat-elapsed"></span></span>`;
    }
    const tick = () => {
      if (!chatBusy) return;
      const elapsed = dur(Date.now() - chatBusy.started);
      const w = $('#msg-partial')?.querySelector('.wk-time'); if (w) w.textContent = elapsed;
      const label = $('#chat-elapsed'); if (label) label.textContent = elapsed;
    };
    if (!busyTimer) { tick(); busyTimer = setInterval(tick, 1000); }
    else if (was && was.started !== b.started) tick();
    scroll(false,before); window.HubMobile?.badges();
  };
  chatES = new EventSource(`/api/chat/stream?project=${encodeURIComponent(p.id)}&task=${encodeURIComponent(t.id)}`);
  const stream = chatES; let webchatPoll = 0;
  chatES.onmessage = m => {
    if (chatES !== stream) return;
    const ev = JSON.parse(m.data);
    const before = position();
    if (ev.type === 'discussion') { updateDiscussion(ev); return; }
    if (ev.type === 'queue') { drawQueue(ev.queue); return; }
    if (ev.type === 'rows') { globalThis.HubChatGenerations ||= new Map();if(ev.generation){const key=p.id+'\0'+t.id,old=globalThis.HubChatGenerations.get(key);if(p.id==='freetalk' && old && old!==ev.generation)clearSentChatImages(p.id,t.id,[...chatImages(p.id,t.id)]);globalThis.HubChatGenerations.set(key,ev.generation);} setBusy(null); drawQueue(ev.queue); box.innerHTML = ev.rows.length ? ev.rows.map(msgHtml).join('') : EMPTY_CHAT; delete box.dataset.askHistoryPending; refreshRequestStatus(box); refreshAsks(box); setBusy(ev.busy); if(scroller) scroller.rows(before); else scroll(true); }
    else if (ev.type === 'row') {
      const e = box.querySelector('.chat-empty'); if (e) e.remove();
      const tmp = $('#msg-partial');
      if (tmp) tmp.insertAdjacentHTML('beforebegin', msgHtml(ev.row)); else box.insertAdjacentHTML('beforeend', msgHtml(ev.row));
      refreshRequestStatus(box); refreshAsks(box);
      if (ev.row.role === 'assistant' && ev.row.asks && ev.row.asks.length) toast(UI.text('AI から質問があります。選んで答えてください'));
      if (ev.row.role === 'event' && chatBusy) setBusy({ ...chatBusy, last: ev.row.text });
      if (ev.row.role === 'assistant' && !(ev.row.asks && ev.row.asks.length)) toast(ev.row.error ? UI.template`${AI_LABEL[ev.row.ai]} が止まりました。赤い字をご覧ください` : UI.template`${AI_LABEL[ev.row.ai]} の返事が届きました（${dur(ev.row.ms || 0)}）`);
      scroll(ev.row.role === 'user' && chatSending.has(draftKey),before);
      window.HubMobile?.badges();
    } else if (ev.type === 'webchat') {
      const poll=++webchatPoll, current=()=>chatES===stream && poll===webchatPoll;
      webchatUI()?.event(p,t,{current,setBusy,busy:()=>chatBusy,refreshTree});
    } else if (ev.type === 'history-auto') { globalThis.HubTaskHistory?.receiveAuto(p.id, t.id, ev);
    } else if (ev.type === 'reset') { if(p.id!=='freetalk'&&globalThis.HubTaskHistory?.resetAuto(p.id,t.id))return; if(p.id==='freetalk')clearSentChatImages(p.id,t.id,[...chatImages(p.id,t.id)]); if(ev.generation)(globalThis.HubChatGenerations ||=new Map()).set(p.id+'\0'+t.id,ev.generation); renderedMainKey=''; load(); } else if (ev.type === 'busy') { webchatPoll++; setBusy({ ...(chatBusy || {}), ai: ev.ai, model: ev.model, started: ev.started, text: '', webchat:Boolean(ev.webchat) }); refreshTree(); }
    else if (ev.type === 'partial') setBusy({ ...(chatBusy || { ai: ev.ai }), text: ev.text });
    else if (ev.type === 'idle') { webchatPoll++; setBusy(null); refreshTree(); }
  };
}
