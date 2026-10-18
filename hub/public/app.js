'use strict';
var UI = globalThis.HubI18n || {text: x=>x, html:x=>x, label:x=>x, message:x=>x, valueAttribute:()=>'', dateLocale:'ja-JP', template:(strings,...values)=>strings.reduce((s,x,i)=>s+x+(i<values.length?values[i]:''),'')};
// Project Hub 第3版の画面
// 左：プロジェクトと作業の木 ／ 右：概要画面 または 作業画面（Claude Code と Codex を並べられる）
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeChatUrl = value => {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) return '';
  try { const url = new URL(value.trim()); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; }
  catch { return ''; }
};
const STATES = ['未着手', '実行中', '返事待ち', '停止', '上限で停止', '完了'];
const RESULTS_WAIT = t => t.resultsPending && t.resultsPending.auto !== 'running';
const NEEDS = t => RESULTS_WAIT(t) || t.completionPending || t.state === '返事待ち' || t.state === '上限で停止' || (t.question && t.state !== '完了');
// 返事が必要（あなたの番の数に入れる）。完了に移すだけのものは入れない
// Only recorded requests need a reply. Terminal silence also occurs during work.
const REPLY = (p, t) => RESULTS_WAIT(t) || t.chatQueueBlocked || t.state === '返事待ち' || t.state === '上限で停止' || (t.question && t.state !== '完了');
const WORKING = (p, t) => Boolean(live(p.id, t.id) || (t.chatQueueCount > 0 && !t.chatQueueBlocked) || t.resultsPending?.auto === 'running' || bgOf(p.id, t.id).length || (state.webchat?.jobs || []).some(j => j.project === p.id && j.task === t.id && ['queued', 'checking', 'sending', 'tools', 'reporting'].includes(j.state)));
// 通知は必ず1区分。返事を優先し、稼働・順番待ちの間は完了報告へ入れない。
const notificationKind = (p, t) => REPLY(p, t) ? 'reply' : WORKING(p, t) ? 'work' : t.completionPending ? 'done' : '';
const CONFIRM = (p, t) => notificationKind(p, t) === 'done';
const CLI = o => /claude|codex|agy|grok/i.test(o || '') || !o;
const aiOf = o => (/grok/i.test(o || '') ? 'grok' : /agy/i.test(o || '') ? 'agy' : /codex/i.test(o || '') ? 'codex' : 'claude');
const AIS = ['claude', 'codex', 'agy', 'grok'];
const AI_ICON = { claude: 'C', codex: 'X', agy: 'G', grok: 'K', chatgpt: 'G', 'chatgpt-chat': 'G', dot: 'D' };
const AI_KEY = { claude: 'claude-code', codex: 'codex', agy: 'agy', grok: 'grok' };
const effortsFor = ai => ai === 'agy' ? ['高'] : (state.efforts || []).filter(e => ai !== 'grok' || e !== 'Ultra');
const effortHidden = ai => ['agy', 'chatgpt'].includes(ai);
const aiUnavailable = ai => ai === 'agy' ? !state.agyAvailable : ai === 'grok' ? !state.grokAvailable : false;
const AI_LABEL = { claude: 'Claude Code', codex: 'Codex', agy: 'Agy CLI', grok: 'Grok', chatgpt: 'ChatGPT', 'chatgpt-chat': UI.text('ChatGPT（Chat）'), dot: 'Dot' };
// 未保存の新規開始とツリーからの子作業に使う初期AI。役割の担当設定とは別。
const INITIAL_PICK = { ai: 'codex', model: 'GPT-6.1-Sol', effort: '高' };
const initialPick = () => state?.initialPick || INITIAL_PICK;
const defaultWorkPick = role => state.specialMode?.enabled ? window.HubSpecialMode.pick(state.specialMode, state.roles, role) : initialPick();
const specialOverrides = new Map(); // ON/OFFにかかわらず現在の手動指定を受付まで保持。過去の保存選択とは分ける。
// 担当の種類：画面の中の AI（丸）・Discord のエージェント（角）・あなた（黄）・ChatGPT（会話画面から自動送信し、GPT子で作業する）
function ownerOf(o) {
  const v = String(o || '').trim();
  if (/^dot$/i.test(v)) return { kind: 'dot', name: 'Dot', ic: 'D' };
  if (/^chatgpt$/i.test(v)) return { kind: 'chatgpt', name: 'ChatGPT', ic: 'G' };
  if (!v || /claude|codex|agy|grok/i.test(v)) return { kind: aiOf(v), name: AI_LABEL[aiOf(v)], ic: AI_ICON[aiOf(v)] };
  if (/^(人|あなた)$/.test(v)) return { kind: 'you', name: UI.text('あなた'), ic: '人' };
  const name = v.replace(/^discord:\s*/i, '');
  return { kind: 'agent', name, ic: name.slice(0, 1), sub: 'Discord' };
}
function chip(p, t) {
  const o = ownerOf(t.owner), running = AIS.includes(o.kind) ? live(p.id, t.id, o.kind) : false;
  const sub = o.kind === 'agent' ? o.sub : (['you', 'chatgpt', 'dot'].includes(o.kind) ? '' : specText(t, o.kind));
  return UI.template`<span class="chip k-${o.kind}"><span class="ic">${esc(o.ic)}</span>${esc(o.name)}${sub ? UI.template`<small>・${esc(sub)}</small>` : ''}${running ? UI.html('<span class="blink" title="作業中"></span>') : ''}</span>`;
}
// 進み具合：手順があれば手順の数、なければ状態から
function progressOf(t) {
  if (stepCount(t)) return { done: t.stepSummary?.done ?? t.steps.filter(x => x.done).length, all: stepCount(t) };
  return { done: t.state === '完了' ? 1 : 0, all: 1 };
}
const stepCount = t => t.stepSummary?.total ?? t.steps?.length ?? 0;
function progressBar(t) {
  const { done, all } = progressOf(t), fin = t.state === '完了';
  const marks = t.stepSummary?.marks ?? (t.steps || []).map(s=>s.done?'1':'0').join('');
  const segs = stepCount(t) ? Array.from(marks,x => UI.template`<i class="${x === '1' ? 'on' : ''}"></i>`).join('') : UI.template`<i class="${fin ? 'on' : ''}"></i>`;
  return UI.template`<div class="prog ${fin ? 'fin' : ''}"><div class="segs">${segs}</div><span>${stepCount(t) ? `${done} / ${all}` : ''}${fin ? UI.text('　完了 ✓') : ''}</span></div>`;
}
// フェーズ：今のフェーズ＝最初の未完了。作業は phase で分ける（無ければ今のフェーズに入れる）
function phaseInfo(p) {
  const names = p.phases.map(ph => ph.name);
  const cur = p.phases.findIndex(ph => ph.state !== '完了');
  const curName = cur >= 0 ? names[cur] : '';
  const inPhase = (t, i) => (names.includes(t.phase) ? t.phase === names[i] : i === cur);
  const list = p.phases.map((ph, i) => {
    const ts = p.tasks.filter(t => inPhase(t, i));
    const got = ts.reduce((a, t) => a + progressOf(t).done, 0), all = ts.reduce((a, t) => a + progressOf(t).all, 0);
    const tasksDone = ts.length > 0 && ts.every(t => t.state === '完了');
    return { name: ph.name, role: ph.role, completionPending: ph.completionPending, state: ph.state || '未着手', tasks: ts, ratio: ph.state === '完了' ? 1 : all ? got / all : 0, tasksDone };
  });
  return { list, cur, curName, done: list.filter(x => x.state === '完了').length, inPhase };
}
function ring(done, all) {
  const c = 37.7, off = all ? c * (1 - done / all) : c;
  return UI.template`<svg class="ring" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="var(--idle-bg)" stroke-width="3"/><circle cx="8" cy="8" r="6" fill="none" stroke="${done === all && all ? 'var(--ok)' : 'var(--accent)'}" stroke-width="3" stroke-dasharray="${c}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 8 8)"/></svg>`;
}

let state = { projects: [], root: '', roles: { models: {}, roles: [] }, sessions: [], terminal: false, efforts: [] };
let view = { kind: 'project', project: null, task: null }; // project | work | turn | settings
let open = new Set(); // 左の木で開いているプロジェクト
const projectNotesOpen = new Set(); // 説明・メモは初期状態で閉じ、ページ内だけ開閉を覚える
let panes = {}; // ai → { xterm, fit, es, ro }
let rolesDraft = null;
let rolesDraftRevision = null;
let checkCreditsDraft = null;
let preferCreditsDraft = null;
const creditCheckSettings = () => ({ claude: state.roles.checkCredits?.claude === true, codex: state.roles.checkCredits?.codex === true });
const roleAssignmentsDirty = () => Boolean(rolesDraft && JSON.stringify(rolesDraft) !== JSON.stringify(state.roles.roles));
const creditsDirty = () => Boolean(checkCreditsDraft && JSON.stringify(checkCreditsDraft) !== JSON.stringify(creditCheckSettings()) || preferCreditsDraft !== null && preferCreditsDraft !== (state.roles.preferCredits === true));
function rolesDirty() {
  return Boolean(rolesDraft && JSON.stringify(rolesDraft) !== JSON.stringify(state.roles.roles) ||
    checkCreditsDraft && JSON.stringify(checkCreditsDraft) !== JSON.stringify(creditCheckSettings()) ||
    preferCreditsDraft !== null && preferCreditsDraft !== (state.roles.preferCredits === true));
}
function clearRolesDraft() { rolesDraft = null; rolesDraftRevision = null; checkCreditsDraft = null; preferCreditsDraft = null; }
let stateLoadEpoch = 0;
let renderedTreeKey = '', renderedMainKey = '';
try { const v = JSON.parse(localStorage.getItem('hub-view') || 'null'); if (v) view = v; open = new Set(JSON.parse(localStorage.getItem('hub-open') || '[]')); } catch (e) { /* 使えない時はそのまま */ }

let stateTag = ''; // 一覧の印（本体が「変わっていない」を答えるために送り返す）
const stateResponseTags = new WeakMap(); // 採用前の印は応答ごとに保持し、破棄・並行取得で混ぜない。
async function api(path, body, headers) {
  if(body?.project&&body.task&&globalThis.HubChatGenerations?.has(body.project+'\0'+body.task)&&body.generation===undefined)body={...body,generation:globalThis.HubChatGenerations.get(body.project+'\0'+body.task)};
  const opt = body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub': '1' }, body: JSON.stringify(body) } : {};
  if (headers) opt.headers = { ...opt.headers, ...headers };
  const r = await fetch(path, opt);
  if (r.status === 304) return null; // 変わっていない（一覧の取得）
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || UI.text('失敗しました')); e.status = r.status; e.reason = j.reason; e.stage = j.stage; e.code = j.code; e.waiting = j.waiting; e.task = j.task; e.blocker = j.blocker; e.delivery = j.delivery; e.queued = j.queued; e.id = j.id; throw e; }
  if (path === '/api/state') stateResponseTags.set(j, (r.headers && r.headers.get && r.headers.get('etag')) || '');
  return j;
}
function toast(t) { const e = $('#toast'); e.textContent = t; e.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => { e.hidden = true; }, 3000); }
function save() { try { localStorage.setItem('hub-view', JSON.stringify(view)); localStorage.setItem('hub-open', JSON.stringify([...open])); } catch (e) { /* 無視 */ } }

const proj = id => state.projects.find(p => p.id === id);
const taskOf = (p, id) => p && p.tasks.find(t => t.id === id);
const sessOf = (p, t, ai) => state.sessions.find(s => s.project === p && s.task === t && s.ai === ai && s.running);
function statusText(s) {
  if (!s) return '';
  return UI.html('<span class="pst busy"><i></i>作業中</span>');
}
const live = (p, t, ai) => state.sessions.find(s => s.project === p && s.task === t && (!ai || s.ai === ai) && s.running)
  || (!ai && (state.chatting || []).find(c => c.project === p && c.task === t));

function specOf(t, ai) {
  const r = state.roles.roles.find(x => x.name === t.role);
  const key = AI_KEY[ai];
  const slot = r ? (r.main.ai === key ? r.main : r.backup.ai === key ? r.backup : null) : null;
  const model = t.model || (slot && slot.model) || '';
  return { model: ai === 'agy' ? agyModelLabel(model) : model, effort: ai === 'agy' ? '高' : state.efforts.includes(t.effort) ? t.effort : (slot && slot.effort) || '' };
}
function agyModelLabel(model) { return (state.agyModels || []).find(row => row.id === model || row.label === model)?.label || model; }
function modelRequest(ai, model) { return ai === 'agy' ? (state.agyModels || []).find(row => row.label === model || row.id === model)?.id || model : model; }
function modelOptionLabel(ai, model) { return ai === 'agy' ? agyModelLabel(model) : model; }
function adoptAgyCatalog(result) {
  const catalog = result.agyCatalog; if (!catalog) return;
  state.agyModels = catalog.models; state.agyModelsState = catalog.state; state.agyModelError = catalog.error; state.agyAvailable = catalog.available;
  state.roles.models.agy = catalog.models.map(row => row.label);
  state.cliFlags ||= {}; state.cliFlags.agy = { ...state.cliFlags.agy, ...Object.fromEntries(catalog.models.map(row => [row.label,row.id])) };
}
const specText = (t, ai) => { const s = specOf(t, ai); return [s.model, UI.label(s.effort)].filter(Boolean).join(UI.text('・')); };

// 一覧の取得。本体は前回と同じなら中身を送らない（304）ので、その時は今の state を使う
async function fetchState() {
  const next = await api('/api/state', null, stateTag ? { 'If-None-Match': stateTag } : undefined);
  return next || (state ? null : await api('/api/state'));
}
let restartWatch = null, restartReloaded = false;
const RESTART_DRAFT_KEY = 'hub-restart-drafts';
function restartDraftMaps() {
  return { queueDrafts, askDrafts, chatAttachments, quickDrafts, specialOverrides, freetalkSummaryDrafts, freetalkPromotionDrafts };
}
function restoreRestartDrafts() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(RESTART_DRAFT_KEY) || 'null');
    if (!saved) return;
    chatDraft = saved.chatDraft || {};
    rolesDraft = saved.rolesDraft ?? null; rolesDraftRevision = saved.rolesDraftRevision ?? null; checkCreditsDraft = saved.checkCreditsDraft ?? null; preferCreditsDraft = saved.preferCreditsDraft ?? null;
    for (const [name, map] of Object.entries(restartDraftMaps())) for (const [key, value] of saved.maps?.[name] || []) map.set(key, name==='freetalkPromotionDrafts'?{...value,creating:false}:value);
    for (const key of saved.quickOverrides || []) quickOverrides.add(key);
    chatFileSequence = saved.chatFileSequence || 0;
    sessionStorage.removeItem(RESTART_DRAFT_KEY);
  } catch (_) { /* 保存が使えなくても起動は続ける */ }
}
function reloadAfterRestart() {
  if (restartReloaded) return true;
  const maps = Object.fromEntries(Object.entries(restartDraftMaps()).map(([name, map]) => [name, [...map]]));
  const hasDraft = Object.values(chatDraft).some(Boolean) || rolesDirty() || Object.values(maps).some(rows => rows.length);
  if (hasDraft) {
    try { sessionStorage.setItem(RESTART_DRAFT_KEY, JSON.stringify({ chatDraft, rolesDraft, rolesDraftRevision, checkCreditsDraft, preferCreditsDraft, maps, quickOverrides: [...quickOverrides], chatFileSequence })); }
    catch (_) { toast(UI.text('入力の保存ができないため、画面の再読込を待っています。')); return false; }
  }
  save(); restartReloaded = true; location.reload(); return true;
}
function observeRestart(next) {
  // 200msの再起動を15秒の一覧取得が見逃しても、旧画面のJSを残さない。
  if(state.hubInstance&&next.hubInstance&&state.hubInstance!==next.hubInstance){restartWatch ||= {instance:state.hubInstance,version:state.version};reloadAfterRestart();return;}
  if (!restartWatch && (state.restart?.reserved || state.restart?.committed)) restartWatch = { instance: state.hubInstance, version: state.version };
  if (!restartWatch && (next.restart?.reserved || next.restart?.committed)) restartWatch = { instance: next.hubInstance, version: next.version };
  if (!restartWatch) return;
  // 予約→確定の短い間を一覧取得が飛ばしても、新しい起動を検知する。取消では再読込しない。
  const changed = next.hubInstance && restartWatch.instance ? next.hubInstance !== restartWatch.instance : next.version !== restartWatch.version;
  if (changed) { reloadAfterRestart(); return; }
  if (!next.restart?.reserved && !next.restart?.committed) restartWatch = null;
}
function adoptState(next) {
  const previousSpecial = JSON.stringify(state.specialMode);
  const previousModels = JSON.stringify([state.roles?.models,state.modelOrder,state.hiddenModels,state.agyModels]);
  observeRestart(next);
  if (!rolesDirty() && state.roles.management?.revision !== next.roles.management?.revision) clearRolesDraft();
  state = next;
  if (previousSpecial !== JSON.stringify(state.specialMode)) syncSpecialModeChange();
  if (previousModels !== JSON.stringify([state.roles?.models,state.modelOrder,state.hiddenModels,state.agyModels])) syncChatModelChoices();
  drawShellAlerts();
  syncChatHandoff();
  stateTag = stateResponseTags.get(next) || ''; // 一覧を採用した時だけ、その一覧の印も進める。
}
async function load({ preserveMain = false } = {}) {
  const epoch = ++stateLoadEpoch;
  const next = await fetchState();
  if (epoch !== stateLoadEpoch || webchatSettingsPending || webchatSettingsSaving || accountSelectionSaving || taskFastSaving || accelerationSaving) return;
  if (next) adoptState(next);
  syncAccountPickers();
  syncChatWebchatAvailability();
  if (!proj(view.project)) view.project = state.projects[0] ? state.projects[0].id : null;
  if (view.kind === 'work' && !taskOf(proj(view.project), view.task)) {
    const source={...view};
    if(source.project==='freetalk' && source.task)try {
      const h=await api('/api/freetalk/status?project=freetalk&task='+encodeURIComponent(source.task));
      if(epoch!==stateLoadEpoch || view.project!==source.project || view.task!==source.task)return;
      if(h.automaticCompleted && proj(h.migrated.project)){view={kind:'work',project:h.migrated.project,task:h.migrated.task};save();}
    }catch{/* A normally deleted topic has no migration receipt. */}
    if(view.project===source.project && view.task===source.task)view.kind='project';
  }
  showInTree();
  if (preserveMain && view.kind === 'work') { syncWorkQuestion(); syncTaskSteps(); updateTurnCounts(); renderTree(); window.HubMobile?.badges(); }
  else render();
}
// 今見ている物が左の木で見えるように、上の階層だけ開く（開き直すのは見る物が変わった時だけ。閉じた物は閉じたまま）
let shownKey = '';
function showInTree() {
  const key = [view.kind, view.project, view.task].join('/');
  if (key === shownKey) return;
  shownKey = key;
  let p = proj(view.project);
  if (!p) return;
  if (view.task) { const all = treeTasks(p); for (let t = all.find(x => x.id === view.task), n = 0; t && t.parent && n < 20; n++) { open.add(`t:${p.id}/${t.parent}`); t = all.find(x => x.id === t.parent); } }
  for (let n = 0; p && n < 20; n++) { open.add(p.id); p = p.parent ? state.projects.find(x => x.id === p.parent || x.name === p.parent) : null; }
  save();
}

// ---- 左の木 ----
function childrenProjects(parent) {
  return state.projects.filter(p => (p.parent || '') === parent || (parent && proj(parent) && p.parent === proj(parent).name));
}
// 子プロジェクト：親（parent）か派生元（derivedFrom）がこのプロジェクト
function childrenOf(p) { return state.projects.filter(q => q.id !== p.id && (q.parent === p.id || q.parent === p.name || q.derivedFrom === p.id)); }
const unfinishedChildren = p => childrenOf(p).filter(q => q.status !== '完了');
function displayParent(item, all) {
  return ProjectOrder.displayParent(item, all);
}
const isProjectPinned = id => (state.projectPins || []).includes(id);
const canReorderProjects = () => true;
const canDragProjects = () => !isPhone();
const projectSiblings = parent => ProjectOrder.siblings(state.projects, parent, state.projectOrder || {}, state.projectPins || []);
// 派生元も載せる既存の子一覧は保ち、各階層内だけを左の一覧と同じ順にする。
function orderedChildren(p) {
  const children = childrenOf(p), result = children.slice(), groups = new Map();
  children.forEach((q, i) => { const parent = displayParent(q, state.projects); if (!groups.has(parent)) groups.set(parent, []); groups.get(parent).push(i); });
  for (const [parent, slots] of groups) {
    const ordered = projectSiblings(parent).filter(q => children.some(c => c.id === q.id));
    slots.forEach((slot, i) => { result[slot] = ordered[i]; });
  }
  return result;
}
function treeMenuButton(p, t) {
  return UI.template`<button class="tree-menu" data-tree-menu="1" data-p="${esc(p.id)}" ${t ? `data-t="${esc(t.id)}"` : ''} type="button" aria-label="${esc(t ? t.title : p.name)}の操作" title="名前の変更・分岐・子を作成">⋯</button>`;
}
// 未読：AI の作業が終わったのに、まだその作業を開いていない（本体の unread に入っている）
const isUnread = (pid, tid) => (state.unread || []).some(u => u.project === pid && u.task === tid);
function markRead(pid, tid) {
  if (!isUnread(pid, tid)) return;
  state.unread = state.unread.filter(u => !(u.project === pid && u.task === tid));
  api('/api/task/read', { project: pid, task: tid }).catch(() => {});
}
// 数字だけでは用件が分からないため、プロジェクト・作業で同じ名前を使う。
function notificationBadges(p, tasks, count = false) {
  const unread = tasks.filter(t => isUnread(p.id, t.id)).length;
  const kinds = tasks.map(t => notificationKind(p, t));
  const reply = kinds.filter(k => k === 'reply').length;
  const work = kinds.filter(k => k === 'work').length;
  const done = kinds.filter(k => k === 'done').length;
  const badge = (n, kind, label, tip) => n ? UI.template`<span class="notice ${kind}" title="${tip}">${label}${count ? ' ' + n : ''}</span>` : '';
  const html = badge(unread, 'notice-unread', UI.text('未読'), UI.text('まだ開いていないAIの結果です。作業の会話を開くと消えます'))
    + badge(reply, 'notice-reply', UI.text('返事待ち'), UI.text('質問への返事・停止の対処・AIへの入力が必要です'))
    + badge(work, 'notice-work', UI.text('作業中'), UI.text('AIや成果整理が動いている、または指示が順番待ちです'))
    + badge(done, 'notice-confirm', UI.text('完了'), UI.text('完了に移すか、まだ続けるかを選んでください'));
  return html ? UI.template`<span class="notifications">${html}</span>` : '';
}
// GitHub の場所（作業用コピーがあればその枝、無ければ本体）
function githubCreateButton(p) {
  const reason = state.github?.ready ? '' : state.github?.error || UI.text('GitHubのログインを設定画面で確認してください');
  return UI.template`${p.github || p.githubHasOrigin ? '' : UI.template`<button class="btn plain" data-github-create="${esc(p.id)}" type="button" ${reason ? 'disabled' : ''} title="${esc(reason || UI.text('非公開リポジトリを作る'))}">GitHubに作る（非公開）</button>`}<button class="btn plain" data-github-connect="${esc(p.id)}" data-github-target="${esc(p.github?.target || '.')}" type="button" ${reason ? 'disabled' : ''}>既存のGitHubに接続</button>${reason || p.githubTargetError ? UI.template`<span class="small">${esc(reason || p.githubTargetError)}</span>` : ''}`;
}
function githubUrl(p, t) {
  const g = (t && t.github) || p.github;
  if (!g || !g.url) return '';
  return g.branch && !['main', 'master', 'HEAD'].includes(g.branch) ? `${g.url}/tree/${encodeURIComponent(g.branch)}` : g.url;
}
const TASK_TRANSFER_MIN_VERSION = [4, 61, 0];
function transferNeedsUpdate() {
  if (!/^\d+\.\d+\.\d+$/.test(state.version || '')) return false;
  const parts = state.version.split('.').map(Number);
  for (let i = 0; i < TASK_TRANSFER_MIN_VERSION.length; i++) if (parts[i] !== TASK_TRANSFER_MIN_VERSION[i]) return parts[i] < TASK_TRANSFER_MIN_VERSION[i];
  return false;
}
function transferUpdateMessage() {
  const next = state.latest ? `［${updateLabel(state.version, state.latest)}］` : UI.text('新版へ切り替えるボタン');
  const reason = transferNeedsUpdate() ? UI.template`受け取りは新しい版の機能です。今動いている Hub はまだ v${state.version} です。` : UI.template`この稼働版では受け取りの窓口を確認できませんでした（稼働版 v${state.version || UI.text('不明')}）。`;
  return UI.template`${reason}AI と順番待ちが終わってから、プロジェクト「${proj(view.project)?.name || view.project}」の画面上部に${next}が表示されていれば押してください。`;
}
function transferButton(project, task, title, label = UI.text('成果を受け取る'), action = 'absorb', classes = 'btn sm') {
  const update = transferNeedsUpdate();
  const hint = action === 'handup' ? UI.template`「${title}」の成果を親へ知らせます。途中の成果は親の［統合…］で受け取り、子を閉じずに続けられます` : UI.template`子作業「${title}」の成果と統合内容を確認します`;
  return UI.template`<button class="${classes}" data-act="${action}" data-p="${esc(project)}" data-t="${esc(task)}" data-expect-title="${esc(title)}" type="button" ${update ? 'disabled' : ''} title="${esc(update ? transferUpdateMessage() : hint)}">${label}</button>`;
}
// Fresh preview evidence is scoped to the exact old record and expires. It is
// presentation only; the persisted intent and replay protection stay untouched.
const integrationMainEvidence=new Map();
function integrationOfferPending(offer){return offer?.pending===true&&(!offer.received||offer.receiptChecked===true);}
function integrationMainNotice(p,t,pending){
  if(!pending)return '';
  const evidence=integrationMainEvidence.get(p.id+'\0'+t.id);
  const reflected=evidence?.key===JSON.stringify(pending)&&evidence.instance===state.hubInstance&&Date.now()-evidence.at<30000&&evidence.reflected===true;
  const history=UI.template`${pending.stopped?UI.template`<p>${UI.text('過去の停止理由')}：${esc(UI.text(pending.stopped.reason||'状態未確認'))}</p>`:''}<p>${UI.text('以前の記録を保持しています。この記録から再送はしません')}</p>${reflected&&evidence.mainUncommitted?UI.template`<p>${UI.text('本体には別の未保存変更があります。この取り込み結果とは別です')}（${String(evidence.mainUncommitted)}）</p>`:''}`;
  if(reflected)return UI.template`<details class="note" data-integration-history><summary>過去の本体取り込み記録（現在の本体に反映済み）</summary>${history}</details>`;
  return UI.template`<div class="wq" data-integration-main><span>${UI.text('本体への反映が未確認です')}${pending.stopped?UI.template`<br>${UI.text('過去の停止理由')}：${esc(UI.text(pending.stopped.reason||'状態未確認'))}`:''}${pending.main?.state==='intent'?UI.template`<br>${UI.text('本体取り込みの結果が不明です。再送はしません')}`:''}</span></div>`;
}
// An unchanged retained child is available in history, but never a request to
// integrate again. Only new offers, handoffs, or unfinished receipt work use it.
function kidsDoneBar(p, t) {
  const pending = (state.taskHandoffs || []).filter(r=>r.targetProject===p.id&&r.targetTask===t.id);
  const all=state.projects || [p];
  const kids=all.flatMap(q=>q.tasks.filter(x=>ProjectOrder.canIntegrate({project:p,task:t},q,x,all)&&!x.freetalk).map(x=>({project:q,task:x})));
  const retained=kids.filter(({project:q,task:x})=>(state.taskOffers||[]).some(r=>r.project===q.id&&r.task===x.id&&r.targetProject===p.id&&r.targetTask===t.id&&r.pending===false));
  const receivedKeys=new Set(retained.map(({project:q,task:x})=>q.id+'\0'+x.id));
  const fresh=kids.filter(({project:q,task:x})=>{
    const offer=(state.taskOffers||[]).find(r=>r.project===q.id&&r.task===x.id&&r.targetProject===p.id&&r.targetTask===t.id);
    return offer?integrationOfferPending(offer)&&(offer.handedUp||ProjectOrder.finished(x)):!Array.isArray(state.taskOffers)&&!receivedKeys.has(q.id+'\0'+x.id)&&ProjectOrder.finished(x);
  });
  const active=(state.taskIntegrations || []).find(r=>r.project===p.id&&r.task===t.id);
  const mainPending=active?.mainPending,childrenActive=active&&active.stage!=='main';
  const mainNotice=integrationMainNotice(p,t,mainPending);
  if (!fresh.length && !pending.length && !childrenActive) return mainNotice;
  const button=UI.template`<button class="btn sm" data-act="integrate" data-p="${esc(p.id)}" data-t="${esc(t.id)}" type="button" ${transferNeedsUpdate()?'disabled':''}>統合…</button>`;
  return UI.template`<div class="wq kids-done"><b>子作業の成果：</b>${button}${pending.map(r=>UI.template`<span class="kid">${esc(r.title)}${transferButton(r.project,r.task,r.title,UI.text('引渡しの残りを続ける'))}</span>`).join('')}${transferNeedsUpdate()?UI.template`<p class="transfer-hint">${esc(transferUpdateMessage())}</p>`:''}</div>`+mainNotice;
}
function refreshKidsDoneBar() {
  if(view.kind!=='work')return;
  const box=$('[data-kids-done]'),p=proj(view.project),t=taskOf(p,view.task);
  if(box&&t){const html=kidsDoneBar(p,t);if((box.kidsHtml??box.innerHTML)!==html){const old=document.querySelector('[data-work-history]');if(old){old.querySelectorAll('details[data-work-fold]').forEach(rememberWorkFold);old.innerHTML='';}box.innerHTML=html;box.kidsHtml=html;}syncWorkAttention();}
}
function partialReceiptBar(p,t){
  const r=(state.taskOffers||[]).find(x=>x.project===p.id&&x.task===t.id)?.received;
  return r?UI.template`<div class="wq">途中受領済み：${esc(r.head?.slice(0,7)||'—')}・${esc(r.at)} ／ ${UI.text('まだ渡していない保存')} ${r.pendingCommits===null?UI.text('不明'):r.pendingCommits} 件</div>`:'';
}
// 作業用コピーが残っている作業の一覧（押すとその作業へ。作業画面の［本体に取り込む］で取り込み、コピーはゴミ箱へ）
function copiesHtml(p) {
  const list = p.tasks.filter(t => t.copy), other = p.copies - list.length;
  return UI.template`<details class="copies small"><summary title="Work フォルダに残っている作業用コピー">作業用コピー ${p.copies} 件</summary><div>${list.map(t => UI.template`<button class="lnk" data-go="work" data-p="${esc(p.id)}" data-t="${esc(t.id)}" type="button">${esc(t.title)}</button>`).join(' ')}${other > 0 ? UI.template`<span>ほか、作業の記録が無いコピー ${other} 件</span>` : ''}<span>作業の［本体に取り込む］で、取り込み後も続けるか片付けるかを確認できます</span></div></details>`;
}
// 所属する子だけを字下げし、派生は元と同じ段に並べる。
function treeTasks(p) { return ProjectOrder.taskItems(p); }
function taskTarget(p,t) { return ProjectOrder.taskTarget(p,taskOf(proj(p.id),t.id)||t,state.projects); }
function branchText(p,t) {
  const src = taskTarget(p,t); return t.kind === 'derived' ? UI.template`⑂ 分岐：${src ? src.task.title : t.derivedFrom || UI.text('元が不明')}から` : '';
}
function taskTree(p, parentId) {
  const all = treeTasks(proj(p.id)||p).filter(x=>p.tasks.some(t=>t.id===x.id)), kids = ProjectOrder.nearSources(all.filter(t => displayParent(t, all) === (parentId || '')).map(t=>({...t, derivedFrom:t.kind==='derived' ? (taskTarget(p,t)?.task.id || t.derivedFrom) : ''})));
  if (!kids.length) return '';
  return kids.map(t => {
    const isLive = live(p.id, t.id) || bgOf(p.id, t.id).length > 0;
    const sub = taskTree(p, t.id);
    const tk = `t:${p.id}/${t.id}`;
    const hot = all.some(x => x.parent === t.id && (notificationKind(p, x) || isUnread(p.id, x.id))); // 作業中・返事待ち・新がある子は見せる
    const tOpen = open.has(tk) || hot;
    return UI.template`<div class="tree-line"><button class="node t ${view.kind === 'work' && view.project === p.id && view.task === t.id ? 'sel' : ''}" data-go="work" data-p="${esc(p.id)}" data-t="${esc(t.id)}" type="button" title="${esc(t.title)}">
        <span class="caret" ${sub ? `data-toggle="${esc(tk)}"` : ''}>${sub ? (tOpen ? '▼' : '▶') : ''}</span><span class="sdot ${taskLight(p, t, isLive).cls}" title="${taskLight(p, t, isLive).tip}"></span>
        ${t.parent && t.kind !== 'derived' ? UI.html('<span class="fork" title="子作業（小作業）">↳</span>') : ''}<span class="nm">${esc(t.title)}${branchText(p,t) ? UI.template`<small class="branch-label">${esc(branchText(p,t))}</small>` : ''}</span>${notificationBadges(p, [t])}</button>${treeMenuButton(p, t)}</div>
      ${sub && tOpen ? UI.template`<div class="kids">${sub}</div>` : ''}`;
  }).join('');
}
// プロジェクトの丸：灰＝まだ始めていない／赤＝AI が作業中／薄緑＝処理が終わった／紫＝人が完了にした
// 裏で動いている AI：Hub を通さずに起動された codex / claude / agy（本体の見張りが見つけたもの）
const bgOf = (pid, tid) => (state.background || []).filter(x => x.project === pid && (!tid || x.task === tid));
const bgText = list => list.map(x => `${AI_LABEL[x.ai] || x.ai}（${dur(Date.now() - Date.parse(x.since))}）`).join(UI.text('・'));
function projectLight(p) {
  if (p.status === '完了') return { cls: 'pl-fin', tip: '完了' };
  const working = state.sessions.some(s => s.project === p.id && s.running) || (state.chatting || []).some(c => c.project === p.id) || bgOf(p.id).length;
  if (working) return { cls: 'pl-work', tip: UI.text('AI が作業中') };
  if (p.tasks.some(t => t.state && t.state !== '未着手')) return { cls: 'pl-rest', tip: UI.text('処理が終わりました（完了にするまで続けられます）') };
  return { cls: 'pl-new', tip: UI.text('まだ始めていません') };
}
// 作業（子）の丸：黄＝返事待ち／赤＝作業中／青＝完了報告。承認済みの状態色は別に保つ。
function taskLight(p, t, isLive) {
  const kind = notificationKind(p, t);
  if (kind === 'reply' && t.chatQueueHeld) return { cls: 'wait', tip: WORKING(p,t) ? UI.text('AIや成果整理は作業中です。停止前の指示は保留中です') : UI.text('停止前の指示は保留中です。自動では始まりません') };
  if (kind === 'reply') return { cls: 'wait', tip: UI.text('返事待ち：質問への返事や停止の対処が必要です') };
  if (kind === 'work' || isLive) return { cls: 'pl-work', tip: UI.text('AIや成果整理が動いている、または指示が順番待ちです') };
  if (kind === 'done') return { cls: 'confirm', tip: UI.text('完了：完了に移すか、まだ続けるかを選んでください') };
  if (t.state === '停止') return { cls: 'wait', tip: UI.text('停止中です') };
  if (t.state === '完了') return { cls: 'pl-fin', tip: '完了' };
  if (!t.state || t.state === '未着手') return { cls: 'pl-new', tip: UI.text('まだ始めていません') };
  return { cls: 'pl-rest', tip: UI.text('処理が終わりました') };
}
function projectNode(p, depth) {
  const isOpen = open.has(p.id);
  const subs = projectSiblings(p.id);
  const forks = state.projects.filter(q=>ProjectOrder.source(q,state.projects)?.id===p.id).length;
  const visible = new Set(p.tasks.filter(t => t.state !== '完了' || isUnread(p.id,t.id)).map(t=>t.id));
  const full = treeTasks(p);
  for(const t of full.filter(x=>visible.has(x.id))) {
    let parent=t.parent;const seen=new Set([t.id]);
    while(parent&&!seen.has(parent)){seen.add(parent);const x=full.find(x=>x.id===parent);if(!x)break;visible.add(x.id);parent=x.parent;}
  }
  const tasks = p.tasks.filter(t=>visible.has(t.id));
  return UI.template`<div class="tree-line${depth === 0 ? ' project-root' : ''}"><button class="node p ${view.kind === 'project' && view.project === p.id ? 'sel' : ''}" data-go="project" data-p="${esc(p.id)}" type="button" ${canDragProjects() ? 'draggable="true"' : ''}>
      ${canDragProjects() ? UI.html('<span class="project-grip" aria-hidden="true" title="ドラッグで並べ替え（同じ階層の中だけ）">⋮⋮</span>') : ''}
      <span class="caret" data-toggle="${esc(p.id)}">${tasks.length || subs.length ? (isOpen ? '▼' : '▶') : ''}</span>
      <span class="sdot ${projectLight(p).cls}" title="${projectLight(p).tip}"></span>
      ${isProjectPinned(p.id) ? UI.html('<span class="project-pin" title="上部に固定中" aria-label="上部に固定中">📌</span>') : ''}${p.parent && !p.derivedFrom ? UI.html('<span class="fork" title="子プロジェクト">↳</span>') : ''}<span class="nm">${esc(p.name)}${p.derivedFrom ? UI.template`<small class="branch-label">⑂ 分岐：${esc(ProjectOrder.source(p,state.projects)?.name || p.derivedFrom)}から</small>` : ''}</span>
      ${forks ? UI.template`<span class="fork" title="分岐の数">分岐${forks}</span>` : ''}
      ${p.phases.length ? UI.template`<span class="phn" title="終わったフェーズ ${phaseInfo(p).done} / ${p.phases.length}">${ring(phaseInfo(p).done, p.phases.length)}</span>` : ''}${notificationBadges(p, p.tasks, true)}</button>${treeMenuButton(p)}</div>
    ${isOpen ? UI.template`<div class="kids">${taskTree({ ...p, tasks }, '')}${subs.map(s => projectNode(s, depth + 1)).join('')}</div>` : ''}`;
}
const waitingKey = s => [s.project, s.task, s.ai, s.running];
function treeKey() {
  return JSON.stringify([state.freetalk, state.projects, state.projectOrder, state.projectPins, state.unread, state.sessions.map(waitingKey), state.chatting, state.background, state.webchat?.jobs, view.kind, view.project, view.task, [...open]]);
}
function mainKey() {
  const p = proj(view.project);
  const common = [view.kind, view.project, view.task, state.root, state.freetalk, state.terminal, state.roles, state.efforts, state.cliFlags, state.agyModels, state.agyModelsState, state.agyAvailable, state.completionWarning, state.modelOrder, state.hiddenModels, state.specialMode];
  if (view.kind === 'work') {
    const sessions = workMode() === 'term' ? state.sessions.filter(s => s.project === view.project && s.task === view.task).map(s => [s.ai, s.running]) : [];
    return JSON.stringify([...common, p && p.name, p && p.phases, taskOf(p, view.task), sessions]);
  }
  if (view.kind === 'project') return JSON.stringify([...common, p, state.github, state.projectOrder, state.projectPins, state.projects.map(x => [x.id, x.name]), state.sessions.filter(s => s.project === view.project).map(waitingKey), state.chatting, state.background, state.webchat?.jobs]);
  if (view.kind === 'turn') return JSON.stringify([...common, state.projects, state.sessions.map(waitingKey), state.chatting, state.background, state.webchat?.jobs]);
  return JSON.stringify([...common, state.projects]);
}
const freetalkSummaryDrafts = new Map();
const freetalkPromotionDrafts = new Map(), freetalkPromotionErrors = new Map();
const freetalkPromotionOperations = new Map();
const FREETALK_DRAFT_KEY='hub-freetalk-promotion-drafts';
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
document.addEventListener('visibilitychange',()=>{if(document.hidden)persistFreetalkPromotionDrafts();});
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
document.addEventListener('input',e=>{
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
let freetalkStatusSeq=0;
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
document.addEventListener('input',e=>{if(e.target.classList.contains('freetalk-summary-input') && e.target.dataset.key) freetalkSummaryDrafts.set(e.target.dataset.key,e.target.value);});
function freetalkTopics(p) {
  return p.tasks.map(t => UI.template`<div class="freetalk-row ${notificationKind(p, t) === 'reply' ? 'waiting' : WORKING(p, t) ? 'running' : ''} ${view.kind === 'work' && view.project === p.id && view.task === t.id ? 'sel' : ''}"><button class="freetalk-topic" data-go="work" data-p="${esc(p.id)}" data-t="${esc(t.id)}" type="button" title="${esc(t.title)}">${esc(t.title)}${(state.unread || []).some(x => x.project === p.id && x.task === t.id) ? ' ●' : ''}</button><button class="freetalk-del" data-act="freetalkdelete" data-t="${esc(t.id)}" type="button" aria-label="この話題を削除" title="この話題を削除">×</button></div>`).join('');
}
// 左の2グループは表示だけを切り替える。detailsの外側タップ閉鎖とは独立する。
function sidebarGroup(name, label, content) {
  const expanded = open.has('g:' + name), id = 'sidebar-' + name;
  return UI.template`<section class="sidebar-group"><button class="sidebar-group-toggle" id="${id}-toggle" data-toggle="g:${name}" data-sidebar-group="${name}" type="button" aria-expanded="${expanded}" aria-controls="${id}-content"><span aria-hidden="true">${expanded ? '▼' : '▶'}</span> ${label}</button><div class="sidebar-group-body" id="${id}-content" ${expanded ? '' : 'hidden'}>${content}</div></section>`;
}
// 掃除や会話量は話題画面と一覧画面で扱う。
function freetalkFrame() {
  const p = state.projects.find(x => x.kind === 'freetalk');
  return sidebarGroup('freetalk', 'freetalk', UI.template`<div class="freetalk-frame" aria-label="freetalk 自由対話"><button class="lnk" type="button" data-go="project" data-p="freetalk" ${p ? '' : 'disabled'}>全体を見る</button><button class="newp freetalk-new" type="button" data-act="freetalknew" ${state.freetalk?.ready ? '' : 'disabled'}>＋ 新しい話題</button>${state.freetalk?.reason ? UI.template`<p class="note" role="status">${esc(state.freetalk.reason)}</p>` : ''}${p ? freetalkTopics(p) : ''}</div>`);
}
function renderTree() {
  const roots = projectSiblings('');
  $('#list').innerHTML = UI.template`${freetalkFrame()}${sidebarGroup('projects', UI.text('プロジェクト'), UI.template`<button class="newp ${view.kind === 'newproject' ? 'sel' : ''}" data-go="newproject" type="button">＋ 新しいプロジェクト</button><div class="tree">${roots.map(p => projectNode(p, 0)).join('')}</div>`)}`;
  renderedTreeKey = treeKey();
  syncFreetalkAttachmentControls();
}

// ---- 全体 ----
function updateTurnCounts() {
  const items = state.projects.flatMap(p => p.tasks.map(t => ({ p, t })));
  const kinds = items.map(({ p, t }) => notificationKind(p, t));
  const replies = kinds.filter(k => k === 'reply').length;
  const working = kinds.filter(k => k === 'work').length;
  const confirmations = kinds.filter(k => k === 'done').length;
  $('#turn-n').textContent = UI.text('返事待ち ') + replies;
  $('#turn-work-n').textContent = UI.text('作業中 ') + working;
  $('#turn-done-n').textContent = UI.text('完了 ') + confirmations;
  $('#turn').setAttribute('aria-label', UI.template`あなたの番：返事待ち ${replies}件、作業中 ${working}件、完了 ${confirmations}件`);
}
function render() {
  if(typeof invalidateMainNavigation==='function')invalidateMainNavigation();
  drawShellAlerts();
  if (view.kind !== 'settings') { clearTimeout(aiToolsWatchTimer); aiToolsWatchTimer = null; }
  const waiting = state.projects.flatMap(p => p.tasks.filter(t => notificationKind(p, t)).map(t => ({ p, t })));
  updateTurnCounts();
  showVersion(state.version, state.latest);
  $('#turn').setAttribute('aria-pressed', view.kind === 'turn');
  $('#gear').setAttribute('aria-pressed', view.kind === 'settings');
  renderTree();
  if (view.kind !== 'work') closePanes();
  if (view.kind === 'settings') renderSettings();
  else if (view.kind === 'newproject') renderNewProject();
  else if (!state.projects.length) renderEmpty();
  else if (view.kind === 'turn') renderTurn(waiting);
  else if (view.kind === 'work') renderWork();
  else renderOverview(proj(view.project));
  renderedMainKey = mainKey();
  window.HubMobile?.badges();
  window.HubOnboarding?.sync();
  if (typeof usageContextChanged === 'function') usageContextChanged();
}

// 分岐・子の名前：元の名前のまま、後ろに空いている番号（「台湾市場 2」「台湾市場 3」…）
function nextName(base, existing) {
  const stem = String(base || '').replace(/\s+\d+$/, '').trim();
  const used = new Set(existing.map(x => String(x || '').trim()));
  for (let n = 2; n < 1000; n++) if (!used.has(`${stem} ${n}`)) return `${stem} ${n}`;
  return `${stem} 2`;
}
function renderEmpty() {
  $('#main').innerHTML = UI.template`<div class="view"><div class="empty"><h2>台帳が見つかりません</h2>
    <p><code>${esc(state.root)}/Product/</code> に台帳（PROJECT.md）がありません。</p>
    <p>ターミナルで <code>bash setup.sh</code> を実行すると、今の作業の台帳が作られます。</p>
    <p>AIの準備は、順番に案内します。</p><button class="btn" type="button" data-onboarding-open>はじめの設定</button></div></div>`;
}

let turnTab = 'reply'; // reply＝返事待ち ／ work＝作業中 ／ done＝完了報告
function renderTurn(list) {
  const reply = list.filter(({ p, t }) => notificationKind(p, t) === 'reply');
  const work = list.filter(({ p, t }) => notificationKind(p, t) === 'work');
  const done = list.filter(({ p, t }) => notificationKind(p, t) === 'done');
  const cur = turnTab === 'done' ? done : turnTab === 'work' ? work : reply;
  $('#main').innerHTML = UI.template`<div class="view"><div class="ph"><h2>あなたの番</h2>
      <div class="seg turn-tabs" role="tablist"><button class="${turnTab === 'reply' ? 'on' : ''}" data-turn-tab="reply" type="button" role="tab" aria-selected="${turnTab === 'reply'}">返事待ち（${reply.length}）</button><button class="${turnTab === 'work' ? 'on' : ''}" data-turn-tab="work" type="button" role="tab" aria-selected="${turnTab === 'work'}">作業中（${work.length}）</button><button class="${turnTab === 'done' ? 'on' : ''}" data-turn-tab="done" type="button" role="tab" aria-selected="${turnTab === 'done'}">完了（${done.length}）</button></div>
      <span class="small">${turnTab === 'done' ? UI.text('AI が終わったと言っている作業。中身を見て、完了に移すか続けるかを決めます') : turnTab === 'work' ? UI.text('AIや成果整理が動いている、または指示が順番待ちの作業') : UI.text('返事待ち・上限で止まっている作業と、AI が入力や選択を待っている作業')}</span><span class="sp"></span>
      ${turnTab === 'reply' && reply.length > 1 ? UI.template`<button class="btn plain sm" id="turn-answer-all" type="button" title="AI には送らず、すべての返事待ちの表示を消します。AI は続きを始めません。">すべて送らずに消す（${reply.length}）</button>` : ''}</div>
    ${turnTab === 'reply' && cur.length ? UI.html('<p class="small">［送らずに消す］は質問と返事待ちの表示だけを消します。AI には送らず、続きを始めません。</p>') : ''}
    ${cur.length ? UI.template`<div class="card">${cur.map(({ p, t }) => taskRow(p, t, true, turnTab)).join('')}</div>` : UI.template`<p class="note">${turnTab === 'done' ? UI.text('完了に移すものはありません。') : turnTab === 'work' ? UI.text('作業中のものはありません。') : UI.text('返事が必要なものはありません。')}</p>`}</div>`;
}
// 子プロジェクトに分ける：1行に1つ「名前｜やること」。名前が無ければ元の名前＋番号。それぞれ作って、最初の作業をすぐ AI に頼む
function splitProject(p) {
  if (!p) return;
  let el = $('#fsheet');
  if (!el) { document.body.insertAdjacentHTML('beforeend', '<div class="fsheet" id="fsheet" role="dialog" aria-modal="true"></div>'); el = $('#fsheet'); }
  el.hidden = false;
  el.innerHTML = UI.template`<div class="fs-box"><div class="fs-head"><b>「${esc(p.name)}」を子プロジェクトに分ける</b><span class="small">1行に1つ。「名前｜やること」の形。名前を省くと「${esc(p.name)} 2」「${esc(p.name)} 3」…になります。作ったあと、それぞれの最初の作業をすぐ AI に頼みます（同時に進みます）</span></div>
    <div class="fs-list" style="padding:12px"><textarea id="split-lines" rows="6" style="width:100%" placeholder="例：\n受付画面｜入退室の受付画面を作る\n決済｜決済の仕組みを調べて設計する\n通知｜保護者への通知を作る"></textarea></div>
    <div class="acts fs-acts"><span class="small" id="split-note"></span><span class="sp"></span><button type="button" class="btn plain" data-fs-close>やめる</button><button type="button" class="btn" id="split-go">分けて始める</button></div></div>`;
  $('#split-lines').focus();
  $('#split-go').onclick = async () => {
    const lines = $('#split-lines').value.split('\n').map(x => x.trim()).filter(Boolean);
    if (!lines.length) { toast(UI.text('1行以上書いてください')); return; }
    if (lines.length > 8) { toast(UI.text('一度に分けるのは8つまでにしてください')); return; }
    if (!confirm(UI.template`${lines.length} つの子プロジェクトを作り、それぞれの最初の作業を AI に頼みます。よいですか？`)) return;
    $('#split-go').disabled = true;
    const names = state.projects.map(x => x.name);
    let made = 0;
    for (const line of lines) {
      const m = line.match(/^(.*?)\s*[|｜:：]\s*(.+)$/);
      const text = m ? m[2].trim() : line;
      const name = m && m[1].trim() ? m[1].trim() : nextName(p.name, names);
      names.push(name);
      $('#split-note').textContent = UI.template`${name} を作っています…`;
      try {
        const child = await api('/api/project/new', { name, parent: p.id, description: text.slice(0, 200), phases: (p.phases || []).map(x => x.name).join('\n') });
        await api('/api/start', { project: child.id, text, ...defaultWorkPick('司令塔'), images: [] });
        open.add(child.id); made++;
      } catch (err) { toast(`${name}：${err.message}`); }
    }
    $('#fsheet').hidden = true;
    toast(UI.template`${made} つの子プロジェクトを作って、作業を始めました`);
    open.add(p.id); save(); await load();
  };
}
// 作業画面の質問に答える：答えを、この作業の AI に指示として送る（送ると質問は済んだことになる）
document.addEventListener('submit', e => {
  if (e.target.id !== 'ask-form') return;
  e.preventDefault();
  const answer = e.target.elements.namedItem('answer').value.trim();
  if (!answer) { toast(UI.text('答えを書いてください')); return; }
  if (chatSending.has(chatAttachmentKey(e.target.dataset.p, e.target.dataset.t))) return;
  const ta = $('#chat-in');
  if (!ta) { toast(UI.text('会話画面で送ってください（上の「会話」を選ぶ）')); return; }
  const text = UI.template`（質問「${(e.target.closest('.ask-box').querySelector('.ask-head span') || {}).textContent || ''}」への答え）${answer}`;
  if (sendWorkAnswer?.project === e.target.dataset.p && sendWorkAnswer.task === e.target.dataset.t) sendWorkAnswer.send(text);
});
// 子が途中のまま親で作業を始めようとした時の知らせ
function warnChildren(p) {
  const u = p ? unfinishedChildren(p) : [];
  return !u.length || confirm(UI.template`子プロジェクトの作業が ${u.length} 件終わっていません（${u.map(x => x.name).join('、')}）。\n親で作業を進めますか？`);
}
// AI へ送らず、返事待ちの表示だけをまとめて消す
document.addEventListener('click', async e => {
  if (!e.target.closest || !e.target.closest('#turn-answer-all')) return;
  const list = state.projects.flatMap(p => p.tasks.filter(t => REPLY(p, t)).map(t => ({ p, t })));
  if (list.some(({p,t}) => chatSending.has(chatAttachmentKey(p.id,t.id)))) { toast(UI.text('回答を送っています。受付結果が出てから操作してください')); return; }
  if (!list.length || !confirm(UI.template`${list.length} 件すべての質問を AI に送らずに消しますか？ AI は続きを始めません。`)) return;
  let ok = 0;
  for (const { p, t } of list) { try { await api('/api/task', { project: p.id, task: t.id, question: '', state: '実行中', memo: UI.text('人が質問を AI に送らずに消した') }); ok++; } catch (err) { toast(err.message); } }
  toast(UI.template`${ok} 件の質問を消しました（AI には送っていません）`); await load();
});
document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('[data-turn-tab]');
  if (b) { turnTab = b.dataset.turnTab; render(); }
});

// ---- 新しいプロジェクト ----
let newRefs = [];
let newProjectPreset = null;
function drawRefs() {
  const box = $('#np-reflist'); if (!box) return;
  box.innerHTML = newRefs.length ? newRefs.map((r, i) => UI.template`<span class="ref" title="${esc(r)}">${esc(r.split('/').filter(Boolean).pop() || r)}<button type="button" data-rmref="${i}" aria-label="外す">×</button></span>`).join('') : UI.html('<span class="small">ここに落とす、または［選ぶ］</span>');
}
function addNewRefs(paths) {
  for (const x of paths) if (x && !newRefs.includes(x)) newRefs.push(x);
  drawRefs();
  const d = $('#np-refs') && $('#np-refs').closest('details'); if (d) d.open = true;
}
function renderNewProject() {
  const opts = state.projects.filter(p => p.kind !== 'freetalk').map(p => UI.template`<option value="${esc(p.id)}" ${newProjectPreset?.parent === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  $('#main').innerHTML = UI.template`<div class="view"><div class="ph"><h2>${newProjectPreset?.derivedFrom ? UI.text('同じ階層に分岐') : newProjectPreset?.parent ? UI.text('子プロジェクトを作る') : UI.text('新しいプロジェクト')}</h2></div>
    <div class="card"><form class="newform" id="projform">
      <input type="hidden" name="derivedFrom" value="${esc(newProjectPreset?.derivedFrom || '')}"><label>プロジェクト名<input name="name" id="np-name" required maxlength="60" placeholder="例：HD 占いアプリ" value="${esc(newProjectPreset?.name || '')}"></label>
      ${newProjectPreset ? UI.template`<label>最初の作業（やりたいこと。書くと、作ったあとすぐ AI に頼みます。名前だけのプロジェクトにしないため）<textarea name="firstTask" rows="2" maxlength="4000" placeholder="例：台湾向けの投稿を3本作る"></textarea></label>` : ''}
      <label>説明（何を作るか・誰のためか。1〜2行）<textarea name="description" id="np-desc" rows="2" maxlength="400"></textarea></label>
      <label>フェーズ（1行に1つ。順番どおり）<textarea name="phases" id="np-phases" rows="4" maxlength="400">計画\n作る\nチェック\n仕上げ</textarea></label>
      <details class="more"><summary>くわしく（なくてもよい）</summary><div class="newform" style="margin-top:10px">
        <label>本体のフォルダ（もうコードや資料がある時）
          <div class="dropfield" id="np-drop"><input name="body" id="np-body" maxlength="300" placeholder="ここにフォルダを落とす、または［選ぶ］"><button class="btn plain sm" id="np-pick" type="button">選ぶ…</button></div></label>
        <label>親プロジェクト（小分けにする時）<select name="parent" id="np-parent"><option value="">（なし）</option>${opts}</select></label>
        <label>参考にするフォルダ・ファイル（Hub の外。AI は読むだけで書き換えない。何個でも）
          <div class="dropfield refs" id="np-refs"><div class="reflist" id="np-reflist"><span class="small">ここに落とす、または［選ぶ］</span></div><button class="btn plain sm" id="np-refpick" type="button">選ぶ…</button></div></label>
        ${state.projects.length ? UI.template`<fieldset class="rels"><legend>関連プロジェクト（Hub の他のプロジェクト。AI がその資料を読んでよい）</legend>${state.projects.filter(p => p.kind !== 'freetalk').map(p => UI.template`<label class="chk"><input type="checkbox" name="related" value="${esc(p.id)}"> ${esc(p.name)}</label>`).join('')}</fieldset>` : ''}
      </div></details>
      <p class="small">台帳（PROJECT.md）・AI 用の指示（CLAUDE.md・AGENTS.md）・作業用のフォルダ（資料・作業・成果物・.ai）を <span class="path">${esc(state.root)}/Product/</span> に作ります。</p>
      <div><button class="btn" type="submit">プロジェクトを作る</button></div>
    </form></div></div>`;
  drawRefs();
  if (newRefs.length) $('#np-refs').closest('details').open = true;
}

// ---- 概要画面（プロジェクトの説明と作業の一覧） ----
function projectFamily(p) {
  const root = q => { let seen = new Set(); while (q && !seen.has(q.id)) { seen.add(q.id); const next = proj(displayParent(q,state.projects)); if (!next) return q.id; q=next; } return p.id; };
  const id=root(p); return state.projects.filter(q=>root(q)===id);
}
function sourceTask(p, ref) {
  if (!ref) return null; const i=ref.indexOf('/'); const q=i<0?p:proj(ref.slice(0,i)), t=taskOf(q,i<0?ref:ref.slice(i+1)); return q&&t?{p:q,t}:null;
}
// compact：一覧の行では1行に詰める（派生は件数だけ）。作業画面では全部の名前と状態を出す
function taskContext(p,t,compact) {
  const src = sourceTask(p,t.derivedFrom);
  if (compact) {
    const derived = projectFamily(p).flatMap(q=>q.tasks.filter(x=>x.kind==='derived' && (x.derivedFrom===`${p.id}/${t.id}` || q.id===p.id && x.derivedFrom===t.id)).map(x=>({p:q,t:x})));
    const busy = derived.filter(x => live(x.p.id, x.t.id)).length, fin = derived.filter(x => x.t.state === '完了').length;
    const parts = [UI.template`<span class="pill">${t.kind==='derived'?UI.text('派生'):UI.text('本作業')}</span>`];
    if (src) parts.push(UI.template`派生元：<button class="lnk" data-go="work" data-p="${esc(src.p.id)}" data-t="${esc(src.t.id)}" type="button">${esc(src.t.title)}</button>`);
    if (derived.length) parts.push(UI.template`渡した作業 ${derived.length}件（作業中 ${busy}・終わった ${fin}）`);
    parts.push(t.copy ? UI.text('作業用コピー') : t.workspaceMode==='direct' || t.workspaceStarted ? UI.text('本体で作業') : UI.text('場所は開始時に決定'));
    return UI.template`<div class="task-context small">${parts.join(UI.html('<i class="sep">・</i>'))}</div>`;
  }
  const derived = projectFamily(p).flatMap(q=>q.tasks.filter(x=>x.kind==='derived' && (x.derivedFrom===`${p.id}/${t.id}` || q.id===p.id && x.derivedFrom===t.id)).map(x=>({p:q,t:x})));
  const stat = x => (live(x.p.id, x.t.id) ? UI.template`<span class="pst busy"><i></i>${esc(ownerOf(x.t.owner).name)} が作業中</span>` : x.t.state === '完了' ? UI.html('<span class="small">終わった</span>') : UI.template`<span class="small">${esc(UI.label(x.t.state))}</span>`);
  const link = x => UI.template`<button class="lnk" data-go="work" data-p="${esc(x.p.id)}" data-t="${esc(x.t.id)}" type="button">${esc(x.p.name)} / ${esc(x.t.title)}</button>`;
  return UI.template`<div class="task-context small"><span class="pill">${t.kind==='derived'?UI.text('派生'):UI.text('本作業')}</span>${src ? UI.text(' 派生元：')+link(src) : ''}${derived.length ? UI.text('　渡した・派生した作業：')+derived.map(x => `${link(x)} ${stat(x)}`).join(' / ') : ''}　${t.copy?UI.text('作業用コピーで作業'):t.workspaceMode==='direct' || t.workspaceStarted?UI.text('本体で作業（合体不要）'):UI.text('作業場所：開始時に決定（Gitのない場所は本体）')}</div>`;
}
function sourceOptions(p,t) {
  return projectFamily(p).flatMap(q=>q.tasks.filter(x=>!t || x.id!==t.id || q.id!==p.id).map(x=>UI.template`<option value="${esc(q.id+'/'+x.id)}" ${t && (t.derivedFrom===q.id+'/'+x.id || q.id===p.id && t.derivedFrom===x.id) ? 'selected' : ''}>${esc(q.name)} / ${esc(x.title)}</option>`)).join('');
}
// tab：あなたの番のタブ（reply＝［送らずに消す］／work＝開く／done＝完了の操作）
function taskRow(p, t, showProject, tab) {
  const cur = t.stepSummary ? t.stepSummary.next : t.steps?.find(x => !x.done);
  const sub = t.question ? UI.template`<span class="q2">あなたへの質問：${linkify(t.question)}</span>`
    : UI.template`<span>${showProject ? esc(p.name) + '・' : ''}${t.state === '完了' ? UI.text('完了') : cur ? UI.text('次：') + esc(cur.text) : t.next ? UI.text('次：') + esc(t.next.split('\n')[0]) : esc(UI.label(t.state))}</span>`;
  const kind = notificationKind(p, t);
  const status = t.question ? UI.text('返事待ち')
    : t.state === '返事待ち' || t.state === '上限で停止' ? UI.label(t.state)
    : kind === 'reply' ? t.resultsPending ? UI.text('成果整理') : t.chatQueueHeld ? WORKING(p,t) ? UI.text('作業中・指示保留') : UI.text('停止保留') : UI.text('返事待ち')
    : kind === 'work' ? UI.text('作業中') : kind === 'done' ? UI.text('完了') : '';
  const badge = status ? UI.template`<span class="pill task-status ${kind === 'work' ? 'busy' : kind === 'done' ? 'confirm' : 'needs'}">${status}</span>` : '';
  const k = `data-p="${esc(p.id)}" data-t="${esc(t.id)}"`;
  const pending = CONFIRM(p, t) && tab !== 'reply';
  const action = tab === 'work' || kind === 'work' ? '' : t.resultsPending || t.chatQueueHeld ? completionButtons(p,t) : tab === 'reply' ? UI.template`<button class="btn sm" data-act="answered" ${k} type="button" title="AI には送りません。この質問と返事待ちの表示だけを消します。AI は続きを始めません。">送らずに消す</button>`
    : pending ? pendingBar(p, t) : completionButtons(p, t);
  return UI.template`<div class="trow ${t.parent ? 'child' : ''} ${t.state === '完了' ? 'fin' : ''}">
    <div class="tt"><div class="task-title"><b>${esc(t.title)}</b>${badge}</div>${sub}</div>
    <div class="tact">${action}<button class="btn plain sm" data-go="work" ${k} type="button">作業画面へ</button></div>
  </div>`;
}
// 一覧の完了確認は操作欄のボタンだけ。作業画面の確認帯はcompletionButtonsに残す。
function pendingBar(p, t) {
  const k = `data-p="${esc(p.id)}" data-t="${esc(t.id)}"`;
  return UI.template`<button class="btn sm" data-act="taskcomplete" ${k} type="button">完了に移す</button><button class="btn plain sm" data-act="taskcontinue" ${k} type="button">まだ続ける</button>`;
}
function completionButtons(p, t) {
  const k = `data-p="${esc(p.id)}" data-t="${esc(t.id)}"`;
  if (t.chatQueueHeld) return UI.html('<div class="wq">停止前の未処理の指示が保留中です。作業画面の待ち指示を確認してください。</div>');
  if (t.question && t.state !== '完了') return ''; // 質問がある間は、まず答える（完了の操作は出さない）
  if (t.resultsPending) return UI.template`<div class="wq"><span>${t.resultsPending.auto === 'running' ? UI.text('手順は済みです。AIが成果の記録を整えています') : UI.text('成果の記録が整っていません：') + esc(t.resultsPending.reason)}</span>${t.resultsPending.detail && t.resultsPending.auto !== 'running' ? UI.template`<div class="small">${esc(t.resultsPending.detail)}</div>` : ''}${t.resultsPending.auto === 'running' ? '' : UI.template`<button class="btn sm" data-act="resultsorganize" ${k} type="button">成果の整理を頼む</button>`}</div>`;
  if (t.completionPending) return UI.template`<div class="wq"><span>AI が手順をすべて済にしました。完了に移しますか？</span><button class="btn sm" data-act="taskcomplete" ${k} type="button">完了に移す</button><button class="btn plain sm" data-act="taskcontinue" ${k} type="button">まだ続ける</button>
    ${t.done ? UI.template`<div class="small done-note"><b>やったこと：</b>${linkify(t.done.length > 400 ? t.done.slice(0, 400) + '…' : t.done)}</div>` : ''}</div>`;
  return UI.template`<button class="btn plain sm" data-act="${t.state === '完了' ? 'taskcontinue' : 'taskcomplete'}" ${k} type="button">${t.state === '完了' ? UI.text('再開する') : UI.text('完了に移す')}</button>${t.state === '完了' ? UI.template`<button class="btn plain sm" data-act="tasktidy" ${k} type="button">片付け…</button>` : ''}`;
}

function phaseRoad(p, info) {
  if (!info.list.length) return '';
  const road = info.list.map((ph, i) => {
    const done = ph.state === '完了';
    return UI.template`<div class="step ${done ? 'done' : ''} ${i === info.cur && !done ? 'now' : ''}">
      ${done ? '<span class="stamp">COMPLETE</span>' : ''}
      <span class="no">フェーズ ${i + 1}</span><span class="nm">${esc(ph.name)}</span>
      <div class="pbar"><i style="width:${Math.round((done ? 1 : ph.ratio) * 100)}%"></i></div>
      <span class="st">${esc(ph.state === '完了' ? UI.text('完了') : ph.completionPending ? UI.text('完了報告あり・確認待ち') : i === info.cur ? UI.text('進行中') : UI.text('未着手'))}・作業 ${ph.tasks.filter(t => t.state === '完了').length} / ${ph.tasks.length}</span></div>`;
  }).join('');
  const c = info.list[info.cur];
  const continued = p.phaseContinueKey && p.phaseContinueKey === p.phaseOfferKey;
  const banner = c && (c.tasksDone && !continued || p.phases[info.cur]?.completionPending) ? UI.template`<div class="banner"><b>確認</b><span>「${esc(c.name)}」を完了に移しますか？</span><span class="sp"></span>
      <button class="btn" data-act="nextphase" data-p="${esc(p.id)}" type="button">${info.list[info.cur + 1] ? UI.template`次のフェーズ「${esc(info.list[info.cur + 1].name)}」へ進む` : UI.text('プロジェクトを完了にする')}</button><button class="btn plain" data-act="phasecontinue" data-p="${esc(p.id)}" type="button">まだ続ける</button></div>` : '';
  return UI.template`<div class="road">${road}</div>${banner}`;
}

// プロジェクトごとの下書き。画像本体はMac内、ここには参照番号だけを残す。
const quickDrafts = new Map(), quickUploading = new Set(), quickStarting = new Set();
const quickOverrides = new Set(); // 手動指定は、その依頼が受け付けられるまで保持する。
function syncSpecialModeChange() {
  for (const [id, draft] of quickDrafts) {
    if (quickOverrides.has(id) || quickStarting.has(id) || draft.task || draft.request) continue;
    Object.assign(draft, defaultWorkPick('司令塔')); keepQuick(id);
  }
  const p = proj(view.project), t = taskOf(p, view.task);
  if (p && view.kind === 'project' && !quickStarting.has(p.id)) drawQuick(p);
  if (p && t) syncSpecialPick(p, t);
  drawSpecialMode();
}
const isQuickImage = f => /\.(png|jpe?g|webp|gif|heic)$/i.test(typeof f === 'string' ? f : f.name || '') || /^image\/(png|jpeg|webp|gif|heic)$/i.test(f.type || '');
function quickDraft(p) {
  if (!quickDrafts.has(p.id)) {
    let old; try { old = JSON.parse(localStorage.getItem('hub-start-' + p.id) || 'null'); } catch (e) { /* 初回 */ }
    const spec = p.startSpec || defaultWorkPick('司令塔');
    quickDrafts.set(p.id, { text: '', images: [], ...spec, ...old, ...(state.specialMode?.enabled ? defaultWorkPick('司令塔') : {}) });
  }
  return quickDrafts.get(p.id);
}
function keepQuick(pid) {
  try { localStorage.setItem('hub-start-' + pid, JSON.stringify(quickDrafts.get(pid))); }
  catch (e) { toast(UI.text('下書きを保存できません。保存領域を確認してください')); }
}
function quickOwners() {
  const agents = new Set(state.roles.agents || []);
  state.projects.forEach(p => p.tasks.forEach(t => { if (ownerOf(t.owner).kind === 'agent') agents.add(ownerOf(t.owner).name); }));
  return [...AIS.map(ai => ({ ai, name: AI_LABEL[ai] })), ...[...agents].map(a => ({ ai: 'discord:' + a, name: a + '（Discord）' }))];
}
function quickControls(p) {
  const d = quickDraft(p), busy = quickStarting.has(p.id), cli = AIS.includes(d.ai), models = shownModels(AI_KEY[d.ai], d.model);
  const missing = d.model && !models.includes(d.model);
  return UI.template`<button class="btn plain" id="quick-attach" ${busy ? 'disabled' : ''} type="button" aria-label="画像を選ぶ" title="画像を選ぶ">📎</button>
    <input type="file" id="quick-files" accept=".png,.jpg,.jpeg,.webp,.gif,.heic" multiple hidden>
    <select id="quick-ai" ${busy ? 'disabled' : ''} aria-label="始めるAI">${quickOwners().map(x => UI.template`<option value="${esc(x.ai)}" ${x.ai === d.ai ? 'selected' : ''} ${aiUnavailable(x.ai) ? 'disabled' : ''}>${esc(x.name)}</option>`).join('')}</select>
    ${cli ? UI.template`<select id="quick-model" aria-label="モデル" ${busy ? 'disabled' : ''}><option value="" ${d.model ? '' : 'selected'}>${d.ai === 'agy' ? UI.text('モデルを選んでください') : UI.text('モデル：役割どおり')}</option>${missing ? UI.template`<option selected disabled value="${esc(d.model)}">${esc(d.model)}（利用不可）</option>` : ''}${models.map(m => UI.template`<option value="${esc(m)}" ${m === d.model ? 'selected' : ''}>${esc(modelOptionLabel(d.ai,m))}</option>`).join('')}</select>
    <select id="quick-effort" aria-label="思考" ${effortHidden(d.ai) ? 'hidden' : ''} ${d.ai === 'agy' || busy ? 'disabled' : ''}><option value="">思考：役割どおり</option>${effortsFor(d.ai).map(e => UI.template`<option ${e === d.effort ? 'selected' : ''}${UI.valueAttribute(e)}>${esc(UI.label(e))}</option>`).join('')}</select>` : UI.html('<span class="small">Discordへの自動送信は未対応。依頼と画像の場所を保存します。</span>')}
    <span class="sp"></span><button class="btn" type="submit" ${quickUploading.has(p.id) || quickStarting.has(p.id) ? 'disabled' : ''}>${quickUploading.has(p.id) ? UI.text('画像を保存中…') : quickStarting.has(p.id) ? UI.text('始めています…') : UI.text('始める')}</button>`;
}
function drawQuick(p) {
  if (view.kind !== 'project' || view.project !== p.id) return;
  const thumbs = $('#quick-images'), controls = $('#quick-controls'), d = quickDraft(p);
  if (thumbs) thumbs.innerHTML = d.images.map((x, i) => UI.template`<span class="quick-image"><img src="${esc(x.url)}" alt="${esc(x.name)}"><button type="button" data-quick-remove="${i}" aria-label="${esc(x.name)}を取り消す">×</button><small title="${esc(x.name)}">${esc(x.name)}</small></span>`).join('');
  if (controls) controls.innerHTML = quickControls(p);
}
async function addQuickImages(p, files, native = false) {
  if (!p || quickUploading.has(p.id) || quickStarting.has(p.id)) { toast(UI.text('保存が終わってから画像を追加してください')); return; }
  const d = quickDraft(p);
  const images = files.filter(isQuickImage);
  if (d.images.length + images.length > 10) { toast(UI.text('画像は1回10枚までです。不要な画像を取り消してください')); return; }
  quickUploading.add(p.id); drawQuick(p);
  try {
    for (const f of images) {
      let r;
      if (native) r = await api('/api/start/image-path', { project: p.id, path: f });
      else {
        const name = f.name || UI.template`貼り付け画像-${Date.now()}.png`;
        const response = await fetch('/api/start/image?' + new URLSearchParams({ project: p.id, name }), { method: 'POST', headers: { 'X-Hub': '1' }, body: f });
        r = await response.json(); if (!response.ok) throw Error(r.error || UI.text('画像を保存できません'));
      }
      d.images.push(r); keepQuick(p.id); drawQuick(p);
    }
    if (images.length) toast(UI.template`画像を${images.length}枚追加しました`);
    return true;
  } catch (e) { toast(e.message); return false; }
  finally { quickUploading.delete(p.id); drawQuick(p); }
}
document.addEventListener('input', e => {
  const f = e.target.closest && e.target.closest('#quickform');
  if (f && e.target.name === 'text') { quickDraft(proj(f.dataset.p)).text = e.target.value; keepQuick(f.dataset.p); }
});
document.addEventListener('click', e => {
  const p = view.kind === 'project' && proj(view.project); if (!p) return;
  if (e.target.id === 'quick-attach') $('#quick-files').click();
  if (e.target.dataset && e.target.dataset.quickRemove !== undefined && !quickStarting.has(p.id)) { quickDraft(p).images.splice(+e.target.dataset.quickRemove, 1); keepQuick(p.id); drawQuick(p); }
});

// Polling carries only metadata; full notes are fetched when this detail is opened.
const projectNotesCache=new Map(),projectNotesLoading=new Map();
function projectNotesText(p){const hit=projectNotesCache.get(p.id),notes=hit&&hit.hash===p.notesHash?hit.notes:p.notesSummary||p.notes||'';return p.notesHash?[p.description,notes].filter(Boolean).join('\n\n'):(p.description||notes);}
async function loadProjectNotes(id){
  const p=proj(id);if(!p||projectNotesLoading.get(id)===p.notesHash)return;
  const hash=p.notesHash;projectNotesLoading.set(id,hash);
  try{
    let hit=projectNotesCache.get(id);
    if(!hit||hit.hash!==hash){hit=await api('/api/project/notes?project='+encodeURIComponent(id));if(proj(id)?.notesHash!==hash||hit.hash!==hash)return;projectNotesCache.set(id,hit);if(projectNotesCache.size>50)projectNotesCache.delete(projectNotesCache.keys().next().value);}
    const detail=document.querySelector('.project-notes');if(detail?.dataset.p===id){const text=detail.querySelector('.desc');if(text)text.textContent=projectNotesText(proj(id));}
  }catch(e){const detail=document.querySelector('.project-notes');if(detail?.dataset.p===id){const text=detail.querySelector('.desc');if(text)text.textContent=projectNotesText(p)+'\n'+UI.text('メモ全文を取得できません。開き直して確認してください');}}
  finally{if(projectNotesLoading.get(id)===hash)projectNotesLoading.delete(id);}
}
const refsOf = p => p.folders.filter(f => /^参考/.test(f.label));
function renderOverview(p) {
  if(projectNotesOpen.has(p?.id))void loadProjectNotes(p.id);
  if (!p) return renderEmpty();
  if (p.kind === 'freetalk') { $('#main').innerHTML = UI.template`<div class="view freetalk-overview"><div class="ph"><h2>freetalk</h2><span class="small">話題${p.tasks.length}件</span><button class="btn" data-act="freetalknew" type="button" ${state.freetalk?.ready ? '' : 'disabled'}>新しい話題</button></div><p class="note">気軽に相談して、話題ごとに会話を続けられます。</p>${freetalkCleanupHtml()}${freetalkTopics(p)}</div>`; return; }
  const info = phaseInfo(p);
  const here = t => !info.list.length || info.cur < 0 || info.inPhase(t, info.cur);
  const active = p.tasks.filter(t => t.state !== '完了' && here(t));
  const others = p.tasks.filter(t => t.state !== '完了' && !here(t));
  const done = p.tasks.filter(t => t.state === '完了');
  const phaseOpts = p.phases.map((ph, i) => UI.template`<option ${i === info.cur ? 'selected' : ''}>${esc(ph.name)}</option>`).join('');
  const agentOpts = (state.roles.agents || []).map(a => UI.template`<option value="discord:${esc(a)}">${esc(a)}（Discord）</option>`).join('');
  const roleOpts = state.roles.roles.map(r => UI.template`<option value="${esc(r.name)}">${esc(UI.label(r.name))}</option>`).join('');
  const taskOpts = p.tasks.map(t => UI.template`<option value="${esc(t.id)}">${esc(t.title)}</option>`).join('');
  const description = projectNotesText(p);
  $('#main').innerHTML = UI.template`<div class="view">
    <div class="ph"><h2>${esc(p.name)}</h2>${p.id!=='freetalk'?UI.template`<button class="btn plain" type="button" data-idea-open="${esc(p.id)}">アイデア台帳</button>`:''}<span class="pill s-${esc(p.status)}">${esc(UI.label(p.status))}</span>
      <span class="small">最終更新 ${esc(p.updated || '—')}</span>
      ${p.copies ? copiesHtml(p) : ''}<span class="sp"></span>
      <button class="btn plain" data-act="split" data-p="${esc(p.id)}" type="button" title="やることを子プロジェクトに分けて、それぞれ同時に始めます">子プロジェクトに分ける</button>
      ${(p.parent || p.derivedFrom) ? UI.template`<button class="btn plain" data-act="handoff-parent" data-p="${esc(p.id)}" type="button" title="このプロジェクトの結果を、親の作業に書き込みます（親の AI が次に読みます）">親に結果を渡す</button>` : ''}
      <button class="btn plain" data-act="pstatus" data-p="${esc(p.id)}" data-s="${p.status === '完了' ? '進行中' : '完了'}" type="button">${p.status === '完了' ? UI.text('完了を取り消す') : UI.text('プロジェクトを完了にする')}</button>
      <button class="btn plain" data-maintenance="1" data-p="${esc(p.id)}" type="button">整理と確認</button>${githubUrl(p) ? UI.template`<button class="btn plain" data-url="${esc(githubUrl(p))}" type="button" title="GitHub で開く（${esc(githubUrl(p))}）">GitHub</button>` : ''}<span id="github-create-status">${githubCreateButton(p)}</span>${p.github?.target && p.github.target !== '.' ? UI.template`<span class="small">接続フォルダ：${esc(p.github.target)}</span>` : ''}<button class="btn plain" data-act="files" type="button">ファイルを見る</button></div>
    ${description ? UI.template`<details class="more project-notes" data-p="${esc(p.id)}" ${projectNotesOpen.has(p.id) ? 'open' : ''}><summary>説明・メモ</summary><p class="desc">${esc(description)}</p></details>` : ''}
    ${state.completionWarning ? UI.template`<p class="wq">${esc(state.completionWarning)}</p>` : ''}
    ${p.completionPending ? UI.template`<p class="wq">プロジェクトの完了報告があります。上の［完了にする］で確認するか、［まだ続ける］を選んでください。</p><button class="btn plain" data-act="pstatus" data-p="${esc(p.id)}" data-s="進行中" type="button">まだ続ける</button>` : ''}
    ${p.derivedFrom ? UI.template`<p class="small">派生元：${proj(p.derivedFrom) ? UI.template`<button class="lnk" data-go="project" data-p="${esc(p.derivedFrom)}" type="button">${esc(proj(p.derivedFrom).name)}</button>` : esc(p.derivedFrom)}</p>` : ''}
    ${phaseRoad(p, info)}
    <div class="card"><h3 class="sec">${info.curName ? UI.template`今のフェーズの作業（${esc(info.curName)}）` : UI.text('作業')}</h3>
      <form class="quick" id="quickform" data-p="${esc(p.id)}">
        <textarea name="text" rows="2" maxlength="4000" placeholder="やりたいことを書くだけで始められます（例：入退室の画面を作って）">${esc(quickDraft(p).text)}</textarea>
        <div class="quick-images" id="quick-images"></div>
        <div class="quick-controls" id="quick-controls">${quickControls(p)}</div>
        <p class="small">画像はここに落とす・⌘V・📎で追加（最大10枚）。入力内容はプロジェクトごとに保存します。</p>
      </form>
      ${active.length ? active.map(t => taskRow(p, t)).join('') : UI.html('<p class="note">進行中の作業はありません。</p>')}
      ${others.length ? UI.template`<details class="more"><summary>他のフェーズの作業（${others.length}）</summary>${others.map(t => taskRow(p, t)).join('')}</details>` : ''}
      ${done.length ? UI.template`<details class="more"><summary>完了した作業（${done.length}）</summary>${done.map(t => taskRow(p, t)).join('')}</details>` : ''}
      <details class="more"><summary>＋ 細かく決めて作業を足す</summary>
        <form class="newform" id="newform" style="margin-top:10px">
          <label>作業名<input name="title" required maxlength="80" placeholder="例：メモ一覧の文言を直す"></label>
          <label>作業の種類<select name="kind"><option value="main">本作業</option><option value="derived">派生</option></select></label>
          <label>派生元<select name="derivedFrom"><option value="">（派生の場合は選ぶ）</option>${sourceOptions(p)}</select></label>
          <label>作業する場所<select name="workspaceMode"><option value="isolated">作業用コピー（コードは後で本体へ取り込む）</option><option value="direct">本体で作業（合体不要・同時作業不可）</option></select></label>
          <label>ツリーの親作業<select name="parent"><option value="">（なし）</option>${taskOpts}</select></label>
          <label>役割<select name="role"><option value="">（なし）</option>${roleOpts}</select></label>
          ${phaseOpts ? UI.template`<label>フェーズ<select name="phase">${phaseOpts}</select></label>` : ''}
          <label>担当<select name="owner"><option value="claude-code">Claude Code</option><option value="codex">Codex</option><option value="agy">Agy CLI</option><option value="grok">Grok</option><option value="chatgpt">ChatGPT</option>${agentOpts}<option value="人">あなた</option></select></label>
          <label>どこで頼んだか（Discord の時。例：#サンプル作業）<input name="via" maxlength="80"></label>
          <label>手順（1行に1つ。3〜5個）<textarea name="steps" rows="4" maxlength="600" placeholder="題材を決める&#10;下書き&#10;チェック&#10;投稿"></textarea></label>
          <div><button class="btn" type="submit">作業を足す</button></div>
        </form></details>
    </div>
    ${projectFamily(p).length>1 ? UI.template`<details class="more"><summary>同じ大きなプロジェクトの作業</summary>${projectFamily(p).filter(q=>q.id!==p.id).map(q=>UI.template`<h3><button class="lnk" data-go="project" data-p="${esc(q.id)}" type="button">${esc(q.name)}</button></h3>${q.tasks.map(t=>taskRow(q,t,true)).join('')}`).join('')}</details>` : ''}
    ${bgOf(p.id).length ? UI.template`<div class="wq bg-note"><b>裏で作業中：</b><span>${esc(bgText(bgOf(p.id)))}</span><span class="small">Hub を通さずに起動された AI（作業：${esc(bgOf(p.id).map(x => x.task ? (taskOf(p, x.task) || {}).title || x.task : UI.text('不明')).join(UI.text('・')))}）</span></div>` : ''}
    ${childrenOf(p).length ? UI.template`<div class="card"><h3 class="sec">子プロジェクト（${childrenOf(p).length}）${unfinishedChildren(p).length ? UI.template`<span class="small">・終わっていない ${unfinishedChildren(p).length} 件</span>` : UI.html('<span class="small">・すべて終わりました</span>')}</h3>
      ${orderedChildren(p).map(q => { const open = q.tasks.filter(t => t.state !== '完了'); const ask = q.tasks.find(t => t.question); return UI.template`<div class="trow"><div class="tt"><div class="task-title"><span class="sdot ${projectLight(q).cls}"></span><b><button class="lnk" data-go="project" data-p="${esc(q.id)}" type="button">${esc(q.name)}</button></b></div><span>${q.status === '完了' ? '完了' : UI.template`${esc(UI.label(q.status))}・作業 ${q.tasks.length - open.length} / ${q.tasks.length}`}${ask ? UI.template`・<span class="q2">質問あり：${esc(ask.question.slice(0, 60))}</span>` : ''}</span></div><div class="tact"><button class="btn plain sm" data-go="project" data-p="${esc(q.id)}" type="button">開く</button></div></div>`; }).join('')}
      <p class="small">子が終わると、結果は親のいちばん新しい作業に書き込まれ、「新」が付きます。子が途中のまま親で作業を始めようとすると、知らせます。</p></div>` : ''}
    <div class="grid2">
      <div class="card issues-card"><h3 class="sec">問題点</h3>${issuesHtml(p.issues)}</div>
      <div class="card"><h3 class="sec">関連プロジェクト・参考（AI が読むだけ）</h3>${p.related.length || refsOf(p).length ? UI.template`<ul>${p.related.map(r => { const q = state.projects.find(x => x.name === r || x.id === r); return UI.template`<li>${q ? UI.template`<button class="lnk" data-go="project" data-p="${esc(q.id)}" type="button">${esc(q.name)}</button>` : esc(r)}</li>`; }).join('')}${refsOf(p).map(f => UI.template`<li><span class="ref" title="${esc(f.path)}">${esc(f.path.split('/').filter(Boolean).pop() || f.path)}</span></li>`).join('')}</ul>` : UI.html('<p class="note">なし</p>')}
        <p class="small">参考にしたいフォルダは、この画面に落とすと足せます。</p></div>
      ${p.chats.length ? UI.template`<div class="card"><h3 class="sec">ブラウザのチャット</h3><ul>${p.chats.map(c => { const url = safeChatUrl(c.url); return UI.template`<li>${url ? UI.template`<a href="${esc(url)}" target="_blank" rel="noopener">${esc(c.title || c.url)}</a>` : esc(c.title || c.url || c)}</li>`; }).join('')}</ul></div>` : ''}
    </div></div>`;
  drawQuick(p);
}

// 保存された要約と未整理の原文を区別する。ここでは意味や状態を推測しない。
function issuesHtml(issues = []) {
  if (!issues.length) return UI.html('<p class="note">なし</p>');
  const current = [], pending = [], history = [];
  for (const issue of issues) {
    if (!issue.summary) pending.push(issue);
    else if (['解決済み', '履歴'].includes(issue.summary.state)) history.push(issue);
    else current.push(issue);
  }
  const row = issue => {
    const text = typeof issue === 'string' ? issue : issue.text;
    const s = issue.summary;
    const heading = String(text).match(/^\s*(【[^】\r\n]+】)/)?.[1] || UI.text('見出しなし');
    return UI.template`<li class="issue-row"><div class="issue-heading">${issue.level ? UI.template`<span class="pill">${esc(issue.level)}</span>` : ''}${s ? UI.template`<span class="pill">${esc(UI.label(s.state))}</span>` : ''}<b class="issue-title${s ? '' : ' issue-unprepared'}">${esc(s ? s.title : heading)}</b></div>
      ${s ? (s.next ? UI.template`<p class="issue-next">次：${s.who === '人' ? UI.text('あなた：') : s.who === 'AI' ? 'AI：' : ''}${esc(s.next)}</p>` : '') : UI.html('<p class="small">まだ短くまとめていません</p>')}
      <details class="issue-detail"><summary>詳しく</summary><p class="issue-original">${esc(text)}</p></details></li>`;
  };
  const list = items => UI.template`<ul class="issue-list">${items.map(row).join('')}</ul>`;
  return UI.template`<section class="issue-group"><h4>今の問題</h4>${current.length ? list(current) : UI.html('<p class="note">今の問題はありません</p>')}</section>
    ${pending.length ? UI.template`<section class="issue-group"><h4>まだまとめていない（${pending.length}件）</h4>${list(pending)}<p class="small">要約がないか、原文との照合に合いません。このプロジェクトの作業の会話で「問題点を短くまとめて」と頼むと、AI が読んでまとめます。</p></section>` : ''}
    ${history.length ? UI.template`<details class="issue-history issue-group"><summary>解決済み・履歴（${history.length}件）</summary>${list(history)}</details>` : ''}`;
}

// 「ファイルを見る」：場所が1つならすぐ開く。複数なら選ぶ
async function openFiles(btn) {
  const p = proj(view.project); if (!p) return;
  const t = view.kind === 'work' ? taskOf(p, view.task) : null;
  const list = [];
  if (t && t.workdir) list.push({ label: UI.text('作業の場所'), path: t.workdir, kind: 'workdir' });
  p.folders.forEach(f => list.push({ label: f.label, path: f.path, kind: 'folder' }));
  list.push({ label: UI.text('台帳（PROJECT.md・指示ファイル）'), path: p.dir, kind: 'project' });
  const go = async it => {
    try { await api('/api/open', { project: p.id, kind: it.kind, label: it.label, task: t && t.id }); toast(UI.template`${it.label}を開きました`); }
    catch (e) { toast(`${it.label}：${e.message}`); }
  };
  if (list.length === 1) return go(list[0]);
  const m = $('#menu');
  m.innerHTML = list.map((it, i) => UI.template`<button type="button" data-i="${i}">${esc(UI.label(it.label))}<span>${esc(it.path)}</span></button>`).join('');
  m.hidden = false;
  const r = btn.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8)) + 'px';
  m.style.top = (r.bottom + 6) + 'px';
  m.onclick = e => { const b = e.target.closest('[data-i]'); if (!b) return; m.hidden = true; go(list[+b.dataset.i]); };
}

// ---- 作業画面 ----
let sendWorkAnswer = null;
function workQuestionHtml(p, t) {
  const k = `data-p="${esc(p.id)}" data-t="${esc(t.id)}"`;
  return t.question ? UI.template`<div class="wq ask-box"><div class="ask-head"><b>あなたへの質問：</b><span>${richText(t.question)}</span></div>
      <form class="ask-form" id="ask-form" ${k}><input type="text" name="answer" maxlength="2000" placeholder="答えや指示を書く（例：A で進めて）" aria-label="答え"><button class="btn sm" type="submit" title="この答えを、この作業の AI に指示として送ります。作業の続きがこの会話に残ります">この作業で AI に送る</button><button class="btn plain sm" data-act="answered" ${k} type="button" title="AI には送りません。この質問と返事待ちの表示だけを消します。AI は続きを始めません。">送らずに消す</button></form>
      <span class="small">答えを送ると、この作業の AI が続きをします。［送らずに消す］は AI には送りません。AI は続きを始めません。</span></div>` : '';
}
// 会話や入力欄を作り直さず、質問の変更だけを反映する。
function syncWorkQuestion() {
  const slot = $('#work-question'), p = proj(view.project), t = taskOf(p, view.task);
  if (view.kind !== 'work' || !slot || !t) return;
  const box = $('#msgs'), top = box?.scrollTop;
  if (slot.dataset.question !== (t.question || '')) {
    slot.dataset.question = t.question || ''; slot.innerHTML = workQuestionHtml(p,t);
  }
  const badge = $('.whead .pill');
  if (badge) { badge.className = `pill s-${t.state}`; badge.textContent = t.continuation?UI.text('継続中'):UI.label(t.state); }
  const select = $('.wfoot [data-act="state"]'); if (select) select.value = t.state;
  if (box) box.scrollTop = top;
  syncWorkAttention();
  updateWorkAnswerControls();
}
function updateWorkAnswerControls() {
  if (view.kind !== 'work') return;
  const pending = chatSending.has(chatAttachmentKey(view.project, view.task));
  const send = $('#chat-send');
  if (send) { send.disabled = pending; send.textContent = UI.text(pending ? '送っています…' : '送る'); }
  $('#ask-form')?.querySelectorAll('button, input').forEach(el => { el.disabled = pending; });
  if ($('#msgs')) refreshAsks($('#msgs'));
  document.querySelectorAll('.ask').forEach(updateAskControls);
}
async function acceptedWorkAnswer(p, t, question, result, askKey) {
  // API の受付結果と、今の質問の両方を照合する。別の質問は消さない。
  if (!question) return;
  ++stateLoadEpoch; // 送信前の定期取得と、早い busy 通知の取り直しを無効にする。
  const current = taskOf(proj(p.id), t.id);
  const matched = result.answeredQuestion === question && current && (current.question === question || !current.question);
  if (matched) { current.question = ''; current.state = '実行中'; }
  if (view.kind !== 'work' || view.project !== p.id || view.task !== t.id) return;
  if (matched && askKey) document.querySelectorAll('.ask').forEach(a => {
    if (a.dataset.askKey !== askKey) return;
    a.classList.add('answered', 'done'); askDrafts.delete(askKey);
    a.querySelector('.ask-status').textContent = result.queued ? UI.text('回答を受け付けました。AI の開始待ちです。') : UI.text('回答を送信しました。');
  });
  syncWorkQuestion(); updateTurnCounts(); renderTree(); window.HubMobile?.badges();
  if (matched && result.queued && !current?.question) {
    const slot = $('#work-question');
    if (slot) slot.innerHTML = UI.html('<div class="wq" role="status">回答を受け付けました。今の作業が終わったら、この回答で AI が続けます。</div>');
  }
  try { await load({ preserveMain: true }); } catch (err) { toast(UI.text('回答は受け付けました。表示の再取得に失敗しました：') + err.message); }
}

// UI-only state, scoped to a task. No task data or delivery record is changed.
const workFolds = new Map();
function workFoldAttr(p,t,name,fallback=false) {
  const folds=workFolds.get(JSON.stringify([p.id,t.id]));
  return (folds?.has(name)?folds.get(name):fallback)?'open':'';
}
function rememberWorkFold(el) {
  const work=el.closest?.('.work');
  if(!work||!el.dataset.workFold||el.isConnected===false)return;
  const key=JSON.stringify([work.dataset.p,work.dataset.t]);
  if(!workFolds.has(key))workFolds.set(key,new Map());
  workFolds.get(key).set(el.dataset.workFold,el.open);
}
function rememberDisclosure(el) {
  if(el.isConnected===false)return;
  rememberWorkFold(el);
  if(el.id==='webchat-details')webchatDetailsOpen=el.open;
  if(el.id==='verd')verOpen=el.open;
  if(el.classList?.contains('steps'))stepsOpen=el.open;
  if(el.classList?.contains('project-notes')) {
    if(el.open)projectNotesOpen.add(el.dataset.p);else projectNotesOpen.delete(el.dataset.p);
  }
  if(el.dataset?.aiFold) {
    if(el.open)aiSettingsOpen.add(el.dataset.aiFold);else aiSettingsOpen.delete(el.dataset.aiFold);
  }
}
function dismissDisclosures(target) {
  if(!target)return;
  // Capture visibility before closing any ancestor or the clicked summary opens it.
  const visible=[...document.querySelectorAll('details[open]')].filter(el=>{
    if(!el.getClientRects().length||getComputedStyle(el).visibility!=='visible')return false;
    for(let parent=el.parentElement;parent;parent=parent.parentElement) {
      if(parent.tagName==='DETAILS'&&!parent.open&&!parent.querySelector(':scope > summary')?.contains(el))return false;
    }
    return true;
  });
  for(const el of visible) {
    if(el.contains(target))continue;
    // Save UI state before the outside action can synchronously redraw the page.
    el.open=false;rememberDisclosure(el);
  }
}
let disclosurePress=null;
document.addEventListener('pointerdown',e=>{disclosurePress={id:e.pointerId,x:e.clientX,y:e.clientY,moved:false};},true);
document.addEventListener('pointermove',e=>{
  if(disclosurePress&&disclosurePress.id===e.pointerId&&Math.hypot(e.clientX-disclosurePress.x,e.clientY-disclosurePress.y)>6)disclosurePress.moved=true;
},true);
document.addEventListener('pointercancel',()=>{if(disclosurePress)disclosurePress.cancelled=true;},true);
document.addEventListener('click',e=>{
  const press=disclosurePress;disclosurePress=null;
  if(e.detail&&press&&(press.moved||press.cancelled||Math.hypot(e.clientX-press.x,e.clientY-press.y)>6))return;
  dismissDisclosures(e.target);
},true);
function captureWorkUi() {
  const work=document.querySelector('.work-compact');if(!work?.dataset.p)return null;
  work.querySelectorAll('details[data-work-fold]').forEach(rememberWorkFold);
  const active=document.activeElement,field=active?.id==='chat-in'?'#chat-in':active?.matches?.('#ask-form input[name="answer"]')?'#ask-form input[name="answer"]':active?.matches?.('.addstep input[name="step"]')?'.addstep input[name="step"]':null;
  return {key:JSON.stringify([work.dataset.p,work.dataset.t]),field,start:active?.selectionStart,end:active?.selectionEnd,
    question:$('#work-question')?.dataset.question,answer:$('#ask-form input[name="answer"]')?.value,step:$('.addstep input[name="step"]')?.value};
}
function restoreWorkUi(saved,p,t) {
  if(!saved||saved.key!==JSON.stringify([p.id,t.id]))return;
  const answer=$('#ask-form input[name="answer"]'),step=$('.addstep input[name="step"]');
  if(answer&&saved.question===(t.question||'')&&saved.answer!==undefined)answer.value=saved.answer;
  if(step&&saved.step!==undefined)step.value=saved.step;
  const field=saved.field&&$(saved.field);
  if(field){field.focus({preventScroll:true});if(saved.start!==null&&saved.start!==undefined)field.setSelectionRange?.(saved.start,saved.end);}
}
function syncWorkAttention() {
  const row=document.querySelector('.work-compact .work-attention');if(!row)return;
  const panel=row.querySelector('.work-alerts-panel'),more=row.querySelector('.work-alerts');if(!panel||!more)return;
  const all=[...row.querySelectorAll('[data-attention-item]')].sort((a,b)=>Number(a.dataset.attentionItem)-Number(b.dataset.attentionItem));
  const visible=all.filter(item=>{
    const body=item.querySelector('[data-attention-body]'),history=body?.querySelector('[data-integration-history]');
    if(history){const slot=document.querySelector('[data-work-history]');if(slot){history.dataset.workFold='integration-history';const p=proj(view.project),t=taskOf(p,view.task);if(t)history.open=Boolean(workFoldAttr(p,t,'integration-history',history.open));slot.replaceChildren(history);}}
    const has=Boolean(body?.textContent.trim()||body?.querySelector('button,input'));
    item.hidden=!has;const label=item.querySelector('summary');if(label){label.dataset.label ||= label.textContent;label.textContent=label.dataset.label+(has?'：'+body.textContent.trim().replace(/\s+/g,' ').slice(0,70):'');}return has;
  });
  for(const item of all){const parent=item===visible[0]?row:panel;if(item.parentElement!==parent)parent.insertBefore(item,parent===row?more:null);if(parent===panel&&visible.includes(item)){const work=row.closest('.work-compact');item.open=Boolean(workFoldAttr({id:work.dataset.p},{id:work.dataset.t},item.dataset.workFold,true));}}
  more.hidden=visible.length<2;more.querySelector('summary').textContent=UI.template`ほか${Math.max(0,visible.length-1)}件`;
  row.hidden=!visible.length;
}
function syncChatHandoff(){
  for(const host of document.querySelectorAll('[data-handoff-status]'))host.innerHTML=chatHandoffHtml(host.dataset.p,host.dataset.t);
}
function chatHandoffHtml(project,task) {
  const rows=(state.chatHandoffErrors||[]).filter(e=>!project||!e.project||e.project===project&&(!e.task||e.task===task));
  if(!rows.length)return '';
  return UI.template`<section class="wq chat-handoff" role="alert"><strong>会話の終了保存が未解決です</strong><p>自動では再処理しません。終了済みの返答と待ち指示は保持されています。</p>${rows.map(e=>UI.template`<div><p>${esc(e.error||'保存記録を確認できません')}（${esc(e.stage||'段階未確認')}）</p>${e.recovery==='confirm-finished'&&e.token&&e.project&&e.task?UI.template`<button type="button" class="btn plain" data-handoff-recover="${esc(e.run)}" data-p="${esc(e.project)}" data-t="${esc(e.task)}" data-token="${esc(e.token)}">終了保存を確認して復旧</button><span class="small">返答の再送や待ち指示の開始は行いません。</span>`:UI.html('<p>処理途中の記録の確認が必要です。復旧できることが確認されるまで保留します。</p>')}</div>`).join('')}</section>`;
}
document.addEventListener('click',async e=>{
  const b=e.target.closest?.('[data-handoff-recover]');if(!b||b.disabled)return;
  const {handoffRecover:run,p:project,t:task,token}=b.dataset;
  const issue=(state.chatHandoffErrors||[]).find(x=>x.run===run&&x.project===project&&x.task===task&&x.token===token&&x.recovery==='confirm-finished');
  if(!issue){toast('保存記録が変わっています。画面を更新して確認してください');return;}
  b.disabled=true;
  try{await api('/api/chat/handoff/recover',{project,task,run,token});await load();render();toast('終了保存を確認しました。待ち指示は保持しています。');}
  catch(e){toast(e.message);}finally{b.disabled=false;}
});
// Keep one open task's details, keyed by the semantic steps version. Never
// replace the conversation/composer just because step details finish loading.
let openTaskSteps = null;
const stepLoads = new Map();
function fullSteps(p,t) {
  if(Array.isArray(t.steps))return t.steps;
  if(!stepCount(t))return [];
  return openTaskSteps?.project===p.id&&openTaskSteps.task===t.id&&openTaskSteps.version===t.stepSummary?.version ? openTaskSteps.steps : null;
}
function stepLabels(p,t,steps) {
  return steps.map((x,i)=>UI.template`<label><input type="checkbox" data-act="step" data-i="${i}" data-p="${esc(p.id)}" data-t="${esc(t.id)}" ${x.done?'checked':''}> ${esc(x.text)}</label>`).join('');
}
function syncTaskSteps() {
  if(view.kind!=='work')return;
  const p=proj(view.project),t=taskOf(p,view.task);if(!t||p.kind==='freetalk')return;
  const box=$('[data-step-list]');if(!box||box.dataset.p!==p.id||box.dataset.t!==t.id)return;
  const steps=fullSteps(p,t);
  if(steps){if(box.dataset.version!==t.stepSummary?.version){box.innerHTML=stepLabels(p,t,steps);box.dataset.version=t.stepSummary?.version;}return;}
  box.textContent=UI.text('読み込み中…');
  const key=JSON.stringify([p.id,t.id,t.stepSummary?.version]);if(stepLoads.has(key))return;
  const active=()=>view.kind==='work'&&view.project===p.id&&view.task===t.id&&taskOf(proj(p.id),t.id)?.stepSummary?.version===t.stepSummary?.version;
  const request=api('/api/task/steps?project='+encodeURIComponent(p.id)+'&task='+encodeURIComponent(t.id));
  stepLoads.set(key,request);
  request.then(result=>{
    if(!active())return;
    if(result.version!==t.stepSummary?.version)return load({preserveMain:true});
    openTaskSteps={project:p.id,task:t.id,version:result.version,steps:result.steps};syncTaskSteps();
  }).catch(()=>{if(active()){const slot=$('[data-step-list]');if(slot)slot.innerHTML=UI.html('<button class="btn plain sm" type="button" data-steps-retry>手順を再読込</button>');}}).finally(()=>stepLoads.delete(key));
}
function renderWork() {
  const savedUi = captureWorkUi();
  const scrollKey = JSON.stringify([view.project,view.task]);
  const savedScroll = window.HubChatScroll?.capture($('#msgs'),scrollKey);
  const p = proj(view.project), t = taskOf(p, view.task);
  if (!p || !t) { view.kind = 'project'; return render(); }
  if (p.kind === 'freetalk') {
    $('#main').innerHTML = UI.template`<div class="work freetalk-work" data-p="${esc(p.id)}" data-t="${esc(t.id)}" data-readonly="${t.freetalkHistory?.migrated ? 'true' : 'false'}"><div class="whead"><button class="back" data-go="project" data-p="${esc(p.id)}" type="button">← freetalk</button><h2>${esc(t.title)}</h2><button class="btn plain sm" type="button" data-act="freetalknew">新しい話題</button></div>${freetalkHistoryHtml(p,t)}<div data-handoff-status data-p="${esc(p.id)}" data-t="${esc(t.id)}">${chatHandoffHtml(p.id,t.id)}</div><div id="work-question" data-question="${esc(t.question || '')}">${workQuestionHtml(p,t)}</div>${chatHtml(p,t)}</div>`;
    closePanes(); window.HubMobile?.mount(scrollKey); openChat(p,t,savedScroll); syncFreetalkMigrationControls(t.freetalkHistory); if(t.freetalkHistory?.migrated){$('#composer').querySelectorAll('button,input,textarea,select').forEach(e=>e.disabled=true);} return;
  }
  const running = AIS.filter(a => live(p.id, t.id, a));
  const main = aiOf(t.owner);
  const shown = running.length ? running : [];
  const k = `data-p="${esc(p.id)}" data-t="${esc(t.id)}"`;
  const mode = workMode();
  const modeSeg = UI.template`<div class="seg" role="group" aria-label="画面の切り替え">
      <button class="${mode === 'chat' ? 'on' : ''}" data-act="mode" data-m="chat" type="button" title="1本の会話で、答える AI を選んで話す">会話</button>
      <button class="${mode === 'term' ? 'on' : ''}" data-act="mode" data-m="term" type="button" title="AI の画面をそのまま動かす">ターミナル${running.length ? `（${running.length}）` : ''}</button></div>`;
  const startBtns = mode === 'chat' ? '' : AIS.filter(a => !running.includes(a)).map(a =>
    UI.template`<button class="btn ${a}${a === main || running.length ? '' : ' sub'}" data-act="start" data-ai="${a}" ${k} type="button" ${aiUnavailable(a) ? UI.text('disabled title="設定画面で AI の導入状態とモデル一覧を確認してください"') : ''}>${running.length ? '＋ ' : ''}${AI_LABEL[a]}${running.length ? UI.text('も並べる') : UI.text('で始める')}</button>`).join('');
  $('#main').innerHTML = UI.template`<div class="work work-compact" data-p="${esc(p.id)}" data-t="${esc(t.id)}">
    <div data-handoff-status data-p="${esc(p.id)}" data-t="${esc(t.id)}">${chatHandoffHtml(p.id,t.id)}</div>
    <div class="whead">
      <div class="work-topline">
        <button class="back" data-go="project" data-p="${esc(p.id)}" type="button">← ${esc(p.name)}</button>
        <h2 title="${esc(t.title)}">${esc(t.title)}</h2><span class="pill s-${esc(t.state)}">${esc(t.continuation?UI.text('継続中'):UI.label(t.state))}</span>
        ${t.role ? UI.template`<span class="small wrole">${esc(UI.label(t.role))}</span>` : ''}
        ${modeSeg}<span class="sp"></span>${startBtns}
        ${t.copy && !t.mergeExcluded && !ProjectOrder.integrators(p,t,state.projects).length ? UI.template`<button class="btn plain" data-act="merge" ${k} type="button" hidden disabled title="表示した範囲を本体に取り込みます">本体に取り込む</button>` : ''}
        <details class="work-more" data-work-fold="more" ${workFoldAttr(p,t,'more')}><summary>その他 ▾</summary><div class="work-more-panel">
          <button class="btn plain" data-go="project" data-p="${esc(p.id)}" type="button">← プロジェクトへ</button>
          <button class="btn plain" type="button" data-idea-open="${esc(p.id)}" data-idea-task="${esc(t.id)}">アイデア台帳</button>
          ${githubUrl(p,t)?UI.template`<button class="btn plain" data-url="${esc(githubUrl(p,t))}" type="button">GitHub</button>`:''}
          <button class="btn plain wfiles" data-act="files" type="button">ファイルを見る</button>
          ${taskTarget(p,t)&&!live(p.id,t.id)?transferButton(p.id,t.id,t.title,ProjectOrder.finished(t)&&!t.question?UI.text('成果を渡す'):UI.text('成果を渡す（途中）'),'handup','btn plain wfiles'):''}
          ${t.copyMissing?UI.template`<span class="small">作業用コピーが見つかりません</span><button class="btn plain" data-act="copyclear" ${k} type="button">記録を片付ける</button>`:''}
          ${t.copy?(t.mergeExcluded?UI.template`<span class="small">取り込み対象外（コピー保管中）</span><button class="btn plain" data-act="mergeinclude" ${k} type="button">取り込み対象に戻す</button>`:!ProjectOrder.integrators(p,t,state.projects).length?UI.template`<button class="btn plain" data-act="mergeexclude" ${k} type="button" hidden>取り込み対象から外す</button>`:''):''}
          ${!t.completionPending&&!t.resultsPending?completionButtons(p,t):''}
          <details data-work-fold="info" ${workFoldAttr(p,t,'info')}><summary>作業の情報</summary><p>${esc(p.name)} ／ ${esc(t.state)}${t.role?UI.template` ／ ${esc(UI.label(t.role))}`:''}</p>${taskContext(p,t,isPhone())}</details>
          <div data-work-history></div>
          ${mode==='term'?UI.template`<div class="crow account-term">${['claude','codex','grok'].map(ai=>taskAccountSelect(p,t,ai)).join('')}<span data-term-fast-box data-p="${esc(p.id)}" data-t="${esc(t.id)}">${taskFastSelect(p,t,'codex')}</span><span>Agy CLI</span>${specSelect(p,t,'agy',Boolean(sessOf(p.id,t.id,'agy')))}</div>`:''}
        </div></details>
      </div>
      ${t.chatQueueHeld ? UI.template`<div class="wq" role="status">${WORKING(p,t) ? UI.text('AIや成果整理は作業中です。') : ''}停止前の指示は保留中です。自動では始まりません。未処理の指示は会話画面の待ち指示で確認できます。</div>` : ''}
      ${t.copy&&!t.mergeExcluded&&!ProjectOrder.integrators(p,t,state.projects).length?UI.html('<section data-main-preview class="main-merge-inline" role="status" hidden></section>'):''}
      <div class="work-attention" hidden>
        <details class="work-alert" data-attention-item="0" data-work-fold="question" ${workFoldAttr(p,t,'question')}><summary>あなたへの質問・回答</summary><div data-attention-body id="work-question" data-question="${esc(t.question||'')}">${workQuestionHtml(p,t)}</div></details>
        <details class="work-alert" data-attention-item="1" data-work-fold="completion" ${workFoldAttr(p,t,'completion')}><summary>完了・成果の確認</summary><div data-attention-body class="wdone">${t.completionPending||t.resultsPending?completionButtons(p,t):''}</div></details>
        <details class="work-alert" data-attention-item="2" data-work-fold="children" ${workFoldAttr(p,t,'children')}><summary>子作業の成果・取り込みの確認</summary><div data-attention-body data-kids-done>${kidsDoneBar(p,t)}</div></details>
        <details class="work-alert" data-attention-item="3" data-work-fold="background" ${workFoldAttr(p,t,'background')}><summary>裏で作業中</summary><div data-attention-body>${bgOf(p.id,t.id).length||(!t.parent&&bgOf(p.id).filter(x=>!x.task).length)?UI.template`<div class="wq bg-note">${esc(bgText(bgOf(p.id,t.id).length?bgOf(p.id,t.id):bgOf(p.id).filter(x=>!x.task)))}</div>`:''}</div></details>
        <details class="work-alert" data-attention-item="4" data-work-fold="transfer" ${workFoldAttr(p,t,'transfer')}><summary>引渡し・受領のお知らせ</summary><div data-attention-body>${taskTarget(p,t)&&transferNeedsUpdate()?UI.template`<div class="wq">${esc(transferUpdateMessage())}</div>`:''}${partialReceiptBar(p,t)}</div></details>
        <details class="work-alerts" data-work-fold="alerts" ${workFoldAttr(p,t,'alerts')} hidden><summary>ほか0件</summary><div class="work-alerts-panel"></div></details>
      </div>
    </div>
    ${mode === 'chat' ? chatHtml(p, t) : UI.template`<div class="panes ${shown.length >= 2 ? 'two' : ''}" id="panes">
      ${shown.length ? shown.map(a => UI.template`<section class="pane" data-ai="${a}">
          <div class="phead"><span class="who w-${AI_KEY[a]}">${AI_LABEL[a]}</span><span class="pstat" data-ai="${a}">${statusText(sessOf(p.id, t.id, a))}</span>${specSelect(p, t, a, true)}<span class="sp"></span>
            ${AIS.filter(other => other !== a).map(other => UI.template`<button class="btn plain sm" data-act="handoff" data-from="${a}" data-to="${other}" ${k} type="button" ${aiUnavailable(other) ? 'disabled' : ''} title="${['agy','grok'].includes(a) ? UI.text('画面に残っている分だけを') : UI.text('今までの会話を')}引き継ぎ資料にまとめて渡します">${AI_LABEL[other]}に交代 →</button>`).join('')}
            <button class="btn plain sm" data-act="stop" data-ai="${a}" ${k} type="button">停止</button></div>
          <div class="pbody" id="pane-${a}"></div></section>`).join('')
        : UI.template`<div class="pane"><div class="pempty">${ownerOf(t.owner).kind === 'chatgpt'
            ? UI.template`この作業は ChatGPT の担当です。［会話］で ChatGPT（Chat／Pro）を選んで送ってください。返答と成果は専用のGPT子へ保存します。<br>ここで Claude Code・Codex・Agy CLI に手伝わせることもできます。`
            : ownerOf(t.owner).kind === 'agent'
            ? UI.template`この作業は ${esc(ownerOf(t.owner).name)}（Discord）に頼んでいます${t.via ? `（${esc(t.via)}）` : ''}。<br>報告を受けたら、下の「手順」に印を付けてください。全部付いたら、完了に移すか確認してください。<br>ここで Claude Code・Codex・Agy CLI に手伝わせることもできます。`
            : ownerOf(t.owner).kind === 'you' ? UI.template`この作業は、あなたの担当です。<br>終わったら、下の「手順」に印を付けるか、状態を「完了」にしてください。`
            : state.terminal
            ? UI.template`まだ AI は動いていません。<br>上の「${AI_LABEL[main]}で始める」を押すと、ここで作業が始まります。<br>ファイルやスクショは、この画面に落とす（または ⌘V で貼る）と AI に渡せます。<br>${esc(t.next ? UI.text('次にやること：') + t.next.split('\n')[0] : '')}`
            : UI.html('作業画面の部品が未設定です。［設定］をご覧ください。<br>それまでは、始めると別の窓で開きます。')}</div></div>`}
    </div>`}
    <div class="wfoot"><details class="work-management" data-work-fold="management" ${workFoldAttr(p,t,'management')}><summary>作業の管理（状態：${esc(UI.label(t.state))}・手順 ${progressOf(t).done}/${stepCount(t)}）</summary><div class="work-management-body">
      <select data-act="state" ${k} aria-label="状態">${!STATES.includes(t.state) ? UI.template`<option selected disabled>${esc(UI.label(t.state))}</option>` : ''}${STATES.map(s => UI.template`<option ${s === t.state ? 'selected' : ''}${UI.valueAttribute(s)}>${UI.label(s)}</option>`).join('')}</select>
      ${mode === 'term' && CLI(t.owner) && !shown.length ? specSelect(p, t, main) : ''}
      ${p.phases.length ? UI.template`<select data-act="phase" ${k} aria-label="フェーズ" title="この作業のフェーズ"><option value="">フェーズ：今のフェーズ</option>${p.phases.map(ph => UI.template`<option ${t.phase === ph.name ? 'selected' : ''}>${esc(ph.name)}</option>`).join('')}</select>` : ''}
      <details class="more steps" data-work-fold="steps" ${workFoldAttr(p,t,'steps')}><summary>手順 ${stepCount(t) ? `${progressOf(t).done} / ${stepCount(t)}` : UI.text('（なし）')}</summary><div class="step-tools"><button class="btn plain sm" data-steps-close type="button">手順を閉じる</button></div><div class="stepbox"><div data-step-list data-p="${esc(p.id)}" data-t="${esc(t.id)}">${fullSteps(p,t) ? stepLabels(p,t,fullSteps(p,t)) : UI.text('読み込み中…')}</div>
        <form class="addstep" data-p="${esc(p.id)}" data-t="${esc(t.id)}"><input name="step" maxlength="120" placeholder="手順を足す（例：下書き）" aria-label="手順を足す"><button class="btn plain sm" type="submit">足す</button></form></div></details>
      <label class="small">種類<select data-act="kind" ${k}><option value="main" ${t.kind!=='derived'?'selected':''}>本作業</option><option value="derived" ${t.kind==='derived'?'selected':''}>派生</option></select></label>
      <label class="small">派生元<select data-act="derivedFrom" ${k}><option value="">（なし）</option>${sourceOptions(p,t)}</select></label>
      <label class="small">場所<select data-act="workspaceMode" ${k} ${t.workspaceStarted || t.state!=='未着手' || t.workdir || live(p.id,t.id) ? 'disabled' : ''}><option value="isolated" ${t.workspaceMode!=='direct'?'selected':''}>作業用コピー</option><option value="direct" ${t.workspaceMode==='direct'?'selected':''}>本体（合体不要）</option></select></label>
      ${t.skills.length ? UI.template`<details class="more"><summary>使ったスキル（${t.skills.length}）</summary><ul class="skills">${t.skills.map(s => UI.template`<li>${esc(s)}</li>`).join('')}</ul></details>` : ''}
    </div></details></div></div>`;
  closePanes();
  const kidsDone=$('[data-kids-done]');if(kidsDone)kidsDone.kidsHtml=kidsDoneBar(p,t);
  syncWorkAttention();
  window.HubMobile?.mount(scrollKey);
  if (mode === 'chat') openChat(p, t, savedScroll); else shown.forEach(a => attach(p.id, t.id, a));
  restoreWorkUi(savedUi,p,t);
  syncTaskSteps();
  if (t.copy && !t.mergeExcluded) loadPreview(p.id, t.id);
}

// ---- 会話画面（Goose のような形）：1本の会話で、送るたびに答える AI とモデルを選ぶ ----
let chatES = null, chatDraft = {}, chatBusy = null, chatScroller = null;
const chatDraftRevisions = new Map();
function setChatDraft(key, text) {
  chatDraft[key] = text; chatDraftRevisions.set(key, (chatDraftRevisions.get(key) || 0) + 1);
}
let historyStorage;
try { historyStorage = localStorage; } catch (_) { /* 保存不可でも履歴は使える */ }
const instructionHistory = window.HubChatHistory.create(historyStorage);
const chatAttachments = new Map();
let chatFileSequence = 0;
const chatImageUploads = new Map();
const FREETALK_ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,.heic,.txt,.md,.csv,.tsv,.json,.jsonl,.yaml,.yml,.xml,.html,.css,.js,.ts,.py,.log,.rtf,.pdf,.pptx,.key';
const chatSending = new Set();
const chatAttachmentKey = (project, task) => JSON.stringify([project, task]);
function chatImages(project, task) {
  const key = chatAttachmentKey(project, task);
  if (!chatAttachments.has(key)) chatAttachments.set(key, []);
  return chatAttachments.get(key);
}
function attachmentImagesHtml(images) {
  return images.map(x => UI.template`<span class="quick-image">${x.kind === 'file' ? UI.html('<span class="quick-file" aria-hidden="true">📄</span>') : UI.template`<img src="${esc(x.url)}" alt="${esc(x.name)}" role="button" tabindex="0" data-image-open="${esc(x.id)}" aria-label="${esc(x.name)}を原寸で開く">`}<button type="button" data-chat-remove="${esc(x.id)}" aria-label="${esc(x.name)}を取り消す">×</button><small title="${esc(x.message || x.name)}">${esc(x.name)}${x.status && x.status !== 'ok' ? ' · ' + esc(UI.text(x.status === 'partial' ? '一部のみ' : '本文を参照できません')) : ''}</small>${x.message ? `<small>${esc(x.message)}</small>` : ''}</span>`).join('');
}
function chatImagesHtml(project, task) { return attachmentImagesHtml(chatImages(project, task)); }
function drawChatImages(project, task) {
  if (view.kind !== 'work' || view.project !== project || view.task !== task || workMode() !== 'chat') return;
  const box = $('#chat-images');
  if (box) { box.innerHTML = chatImagesHtml(project, task); box.hidden = !chatImages(project, task).length; }
  const status = $('#chat-image-state');
  if (status) status.hidden = !chatImageUploads.get(chatAttachmentKey(project, task));
  syncFreetalkAttachmentControls();
  window.HubMobile?.draft();
}
async function addChatImage(project, task, file, native = false) {
  if (project === 'freetalk') return addFreetalkAttachment(task,file,native);
  const key = chatAttachmentKey(project, task);
  chatImageUploads.set(key, (chatImageUploads.get(key) || 0) + 1);
  drawChatImages(project, task);
  try {
    let image;
    if (native) image = await api('/api/start/image-path', { project, path: file });
    else {
      const name = file.name || `screenshot-${Date.now()}.png`;
      const r = await fetch('/api/start/image?' + new URLSearchParams({ project, name }), { method: 'POST', headers: { 'X-Hub': '1' }, body: file });
      image = await r.json();
      if (!r.ok) throw Error(image.error || UI.text('画像を追加できませんでした'));
    }
    chatImages(project, task).push(image);
  } finally {
    chatImageUploads.set(key, chatImageUploads.get(key) - 1);
    drawChatImages(project, task);
  }
}
function attachmentGeneration(task) {
  return Math.max(globalThis.HubChatGenerations?.get('freetalk\0'+task) || 0,taskOf(proj('freetalk'),task)?.freetalkHistory?.generation || 0) || undefined;
}
function syncFreetalkAttachmentControls() {
  for(const el of document.querySelectorAll('[data-act^="freetalk"]')) {
    const action=el.dataset.act;
    if(!['freetalkclear','freetalkcontinue','freetalksummary','freetalkdelete','freetalkclean','freetalkautopromote','freetalkpromote','freetalkcreate','freetalkretry','freetalkresummary'].includes(action))continue;
    const task=el.dataset.t || view.task;
    const busy=action==='freetalkclean' ? [...chatImageUploads.entries()].some(([key,n])=>n && JSON.parse(key)[0]==='freetalk') : chatImageUploads.get(chatAttachmentKey('freetalk',task));
    if(busy && !el.dataset.attachmentBusy){el.dataset.attachmentBusy='1';el.dataset.attachmentDisabled=String(el.disabled);el.disabled=true;}
    else if(!busy && el.dataset.attachmentBusy){el.disabled=el.dataset.attachmentDisabled==='true';delete el.dataset.attachmentBusy;delete el.dataset.attachmentDisabled;}
  }
}
async function addFreetalkAttachment(task,file,native=false) {
  const project='freetalk',generation=attachmentGeneration(task),key=chatAttachmentKey(project,task);
  if(!generation)throw Error(UI.text('話題の状態を確認してください'));
  chatImageUploads.set(key,(chatImageUploads.get(key)||0)+1);drawChatImages(project,task);syncFreetalkAttachmentControls();
  try {
    let attachment;
    if(native){const r=await api('/api/task/attach',{project,task,paths:[file],generation});attachment=r.attachments[0];}
    else {
      const q=new URLSearchParams({project,task,name:file.name || `screenshot-${Date.now()}.png`,generation});
      const r=await fetch('/api/task/upload?'+q,{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/octet-stream'},body:file});
      attachment=await r.json();if(!r.ok)throw Error(attachment.error || UI.text('渡せませんでした'));
    }
    if(generation!==attachment.generation || generation!==attachmentGeneration(task) || !taskOf(proj(project),task) || taskOf(proj(project),task).freetalkHistory?.migrated)return;
    chatImages(project,task).push(attachment);
  } finally {
    chatImageUploads.set(key,chatImageUploads.get(key)-1);drawChatImages(project,task);syncFreetalkAttachmentControls();
    if(view.kind==='work' && view.project===project && view.task===task){const p=proj(project),t=taskOf(p,task);if(t)await syncFreetalkHistory(p,t);}
  }
}
function removeChatImage(project, task, id) {
  const images = chatImages(project, task), i = images.findIndex(x => x.id === id);
  if (i >= 0) images.splice(i, 1);
  drawChatImages(project, task);
}
function chatSendText(text, images) {
  const files = images.some(x => x.kind === 'file');
  return images.length ? (text.trim() || UI.text(files ? '添付ファイルを確認してください。' : '添付画像を確認してください。')) + UI.text(files ? '\n\n参照ファイル・画像（絶対パス）：\n' : '\n\n参照画像（絶対パス）：\n') + images.map(x => (x.referencePaths || [x.path]).join('\n') + (x.message ? '\n' + x.message : '')).join('\n') : text.trim();
}
function clearSentChatImages(project, task, sent) {
  const ids = new Set(sent.map(x => x.id));
  chatAttachments.set(chatAttachmentKey(project, task), chatImages(project, task).filter(x => !ids.has(x.id)));
  drawChatImages(project, task);
}
const isPhone = () => typeof matchMedia === 'function' && matchMedia('(max-width:720px)').matches;
// 表示用の文字だけを短縮する。選択値やCLIに渡すモデル名には使わない。
function shortModelLabel(ai, model) {
  if (ai === 'dot') return 'Dot';
  if (ai === 'chatgpt') return UI.text(model === 'auto' ? 'Chat／Pro' : '廃止された経路');
  if (ai === 'codex') return String(model).replace(/^GPT-/, '');
  if (ai === 'agy') return modelOptionLabel(ai, model);
  return String(model);
}
function phoneModelLabel(ai, model, full, suffix = '') {
  const phone = state.phoneLabels, key = `${AI_KEY[ai] || ai}|${model}`;
  return phone?.labels === 'full' ? full : (phone?.names?.[key] || shortModelLabel(ai, model)) + suffix;
}
function chatModelOption(ai, model, full, attrs = '', suffix = '') {
  if (ai === 'agy') full = full.replace(model, modelOptionLabel(ai,model));
  const short = phoneModelLabel(ai, model, full, suffix);
  return UI.template`<option value="${ai}|${esc(model)}" data-full="${esc(full)}" data-short="${esc(short)}" data-phone-suffix="${esc(suffix)}" ${attrs}>${esc(isPhone() ? short : full)}</option>`;
}
function syncChatPhoneLabels() {
  for (const option of ($('#chat-ai')?.options || [])) {
    if (option.dataset.full === undefined) continue;
    const [ai, model] = option.value.split('|');
    option.dataset.short = phoneModelLabel(ai, model, option.dataset.full, option.dataset.phoneSuffix || '');
    option.textContent = isPhone() ? option.dataset.short : option.dataset.full;
  }
}
function workMode() { if (proj(view.project)?.kind === 'freetalk') return 'chat'; try { return localStorage.getItem('hub-mode') === 'term' ? 'term' : 'chat'; } catch (e) { return 'chat'; } }
function setMode(m) { try { localStorage.setItem('hub-mode', m); } catch (e) { /* 無視 */ } render(); }
const EMPTY_CHAT = UI.html('<p class="chat-empty">ここで AI と話します。<br>下で答える AI とモデルを選び、依頼を書いて送ってください（⌘ + Enter でも送れます）。<br>途中で AI を変えると、それまでの会話を自動で引き継ぎます。ファイルやスクショは、［＋］で選ぶか、ここに落とす／⌘V で貼れます。</p>');
// 選ぶ欄に出すモデル（設定で隠したものは出さない。ただし今選んでいるものは残す）
function orderedModels() { return ModelOrder.ordered(state.roles.models, state.modelOrder); }
function shownModels(key, ...keep) {
  const hidden = (state.hiddenModels || {})[key] || [];
  return orderedModels().filter(id => id.startsWith(key + '|')).map(id => id.slice(key.length + 1)).filter(m => (!hidden.includes(m) || keep.includes(m)) && (key !== 'agy' || !state.agyModels || state.agyModels.some(row => row.label === m)));
}
function roleModelOptions(ai, selected) {
  const models = shownModels(ai, selected);
  const saved = selected && !models.includes(selected) ? UI.template`<option selected disabled value="${esc(selected)}">${esc(modelOptionLabel(ai,selected))}（利用不可）</option>` : ai === 'agy' && !selected ? UI.html('<option selected disabled value="">モデルを選んでください</option>') : '';
  return saved + models.map(m => UI.template`<option ${ai === 'agy' ? UI.template`value="${esc(m)}" ` : ''}${m === selected ? 'selected' : ''}>${esc(modelOptionLabel(ai,m))}</option>`).join('');
}
function chatSelection(p, t) {
  const pick = { ...chatPick(p, t) };
  if (!['chatgpt', 'dot'].includes(pick.ai) && pick.model && !(state.roles.models[AI_KEY[pick.ai]] || []).includes(pick.model)) { // 作業ファイルに本当の名前で書かれていた時
    const hit = Object.entries((state.cliFlags || {})[pick.ai] || {}).find(([, id]) => id === pick.model);
    if (hit) pick.model = hit[0];
  }
  return pick;
}
let discussionUIInstance;
function discussionUI() {
  if (!window.HubPaidDiscussion || state.extensions && !state.extensions.included.includes('discussion')) return null;
  return discussionUIInstance ||= window.HubPaidDiscussion.create(Object.freeze({
    UI, $, esc, AI_LABEL, api:(...args)=>api(...args), toast, chatImages, chatAttachmentKey, chatDraftRevisions, setChatDraft,
    get state() { return state; }, get chatDraft() { return chatDraft; },
  }));
}
function bindDiscussion(p,t) { return discussionUI()?.bind(p,t) || (()=>{}); }
function chatModelChoices(p, t, selected) {
  const pick = selected || chatSelection(p, t);
  // 名前が未設定のモデルは、CLI の既定のモデルで動く（設定画面で名前を入れられる）
  const flag = (a, m) => ((state.cliFlags || {})[a] || {})[m];
  const available = pick.ai === 'chatgpt' ? (pick.model === 'auto' && webchatReady(t)) : shownModels(AI_KEY[pick.ai],pick.model).includes(pick.model);
  const unavailable = UI.text(pick.ai === 'chatgpt' && ['chat','app'].includes(pick.model) ? '（廃止された経路です。選び直してください）' : '（利用不可。選び直してください）');
  const old = pick.ai === 'agy' && !pick.model ? chatModelOption('agy', '', UI.text('Agy のモデルを選んでください'), 'selected disabled') : pick.model && !available && !(pick.ai === 'chatgpt' && pick.model === 'auto') ? chatModelOption(pick.ai, pick.model, UI.template`${AI_LABEL[pick.ai]}・${pick.model}${unavailable}`, 'selected disabled', unavailable) : '';
  const autoOpt = chatModelOption('chatgpt', 'auto', UI.text('ChatGPT（Chat／Pro）'), (pick.ai === 'chatgpt' && pick.model === 'auto' ? 'selected ' : '') + (webchatReady(t) ? '' : 'disabled'));
  const gptOpt = autoOpt;
  return old + orderedModels().filter(id => { const [key, m] = id.split('|'); const a = key === 'claude-code' ? 'claude' : key; return shownModels(key, pick.ai === a ? pick.model : '').includes(m); }).map(id => {
    const [key, m] = id.split('|'), a = key === 'claude-code' ? 'claude' : key;
    const suffix = flag(a, m) === '' ? UI.text('（既定）') : '';
    return chatModelOption(a, m, UI.template`${AI_LABEL[a]}・${m}${suffix}`, `${aiUnavailable(a) ? 'disabled' : ''} ${pick.ai === a && pick.model === m ? 'selected' : ''}`, suffix);
  }).join('') + gptOpt;
}
function syncChatModelChoices() {
  if (view.kind !== 'work') return;
  const p = proj(view.project), t = taskOf(p, view.task), select = $('#chat-ai');
  if (p && t && select) { select.innerHTML = chatModelChoices(p,t); const pick = chatSelection(p,t); select.value = pick.ai + '|' + pick.model; }
}
function chatHtml(p, t) {
  const pick = chatSelection(p, t), opts = chatModelChoices(p,t);
  const bodyNotice=(state.bodyNotices||[]).filter(x=>x.scope===p.id+' / '+t.id||x.scope==='本文整理').map(x=>UI.template`<p class="small danger" role="status">${esc(x.message)}</p>`).join('');
  return UI.template`<div class="chat" data-p="${esc(p.id)}" data-t="${esc(t.id)}">${!t.freetalk?UI.template`<div class="task-history-toolbar"><button class="btn plain sm" type="button" data-task-history="continue" data-p="${esc(p.id)}" data-t="${esc(t.id)}">要約して続ける</button><span class="history-progress small" id="history-progress" role="status" data-p="${esc(p.id)}" data-t="${esc(t.id)}" hidden></span><button class="btn plain sm" type="button" data-task-history="archives" data-p="${esc(p.id)}" data-t="${esc(t.id)}">過去の会話</button></div>`:''}
    ${bodyNotice}${state.extensions?.notice ? UI.template`<p class="small danger" role="status">${esc(state.extensions.notice)}</p>` : ''}<div id="webchat-notice">${webchatNoticeHtml(t,pick.ai==='chatgpt' && pick.model==='auto')}</div><div id="webchat-progress">${webchatProgress(p,t)}</div>${discussionUI()?.progressHtml() || ''}<div class="msgs" id="msgs">${EMPTY_CHAT}</div>
    <button class="chat-latest btn plain sm" id="chat-latest" type="button" hidden>↓ 最新へ</button>
    <form class="composer" id="composer">
      <div class="queue" id="chat-queue" hidden></div>
      <div class="quick-images" id="chat-images" aria-label="添付ファイル・画像" ${chatImages(p.id, t.id).length ? '' : 'hidden'}>${chatImagesHtml(p.id, t.id)}</div>
      <span class="small" id="chat-image-state" role="status" ${chatImageUploads.get(chatAttachmentKey(p.id, t.id)) ? '' : 'hidden'}>添付ファイルを追加中…</span>
      <textarea id="chat-in" rows="3" maxlength="100000" placeholder="依頼を書く（例：このスクショの崩れを直して）" aria-label="依頼" aria-describedby="chat-history-help" title="↑ 前の指示（3件まで）・↓ 入力中の文章へ戻る">${esc(chatDraft[chatAttachmentKey(p.id, t.id)] || '')}</textarea>
      <span class="sr-only" id="chat-history-help">↑ 前の指示（3件まで）・↓ 入力中の文章へ戻る</span>
      <div class="crow composer-controls">
        <button class="btn plain" id="chat-attach" type="button" aria-label="ファイルを追加" title="ファイルを追加">＋</button>
        <input type="file" id="chat-files" ${p.id === 'freetalk' ? 'accept="' + FREETALK_ACCEPT + '"' : ''} multiple hidden>
        <select id="chat-ai" aria-label="答える AI とモデル">${opts}</select>
        <select id="chat-effort" aria-label="思考" ${effortHidden(pick.ai) ? 'hidden' : ''} ${['agy','chatgpt','dot'].includes(pick.ai) ? 'disabled' : ''}>${effortsFor(pick.ai).map(e => UI.template`<option ${(pick.ai === 'agy' ? '高' : pick.effort) === e ? 'selected' : ''}${UI.valueAttribute(e)}>${esc(UI.label(e))}</option>`).join('')}</select>
        <span class="small" id="chat-state"></span><span class="sp"></span>
        <div class="composer-settings">
        <span id="chat-account-box">${['claude','codex','grok'].includes(pick.ai) ? taskAccountSelect(p,t,pick.ai,true) : ''}</span>
        <span id="chat-fast-box">${taskFastSelect(p,t,pick.ai)}</span>
        ${discussionUI()?.buttonHtml() || ''}</div><button class="btn" id="chat-send" type="submit">送る</button>
      </div>
      ${discussionUI()?.settingsHtml() || ''}<div class="crow busyrow" id="chat-busyrow" hidden>
        <button class="btn plain" id="chat-stop" type="button" title="今の作業を止めます（待っている指示も取り消します）">停止</button>
        <button class="btn warn" id="chat-redo" type="button" hidden title="今の指示が間違いだった時。今の指示を取り消し、この指示でやり直します">やり直し</button>
        <button class="btn" id="chat-amend" type="button" hidden title="今の指示に足りない所がある時。今の指示は続け、この指示も合わせて行います">追加指示</button>
        <button class="btn plain" id="chat-q" type="button" hidden title="別の作業を順番待ちにします。今の作業が終わったら自動で始めます（⌘ + Enter）">次の作業</button>
      </div>
    </form>
    </div>`;
}
// 最初に選んでおく AI：前回選んだもの → 作業の担当と役割の設定
function chatPick(p, t) {
  if (state.specialMode?.enabled) return specialOverrides.get(p.id + '/' + t.id) || defaultWorkPick(t.role);
  try { const v = JSON.parse(localStorage.getItem('hub-chat-' + p.id + '/' + t.id) || 'null'); if (v && v.ai) return v; } catch (e) { /* 無視 */ }
  if (t.gptChild) return { ai: 'chatgpt', model: 'auto', effort: '' };
  if (ownerOf(t.owner).kind === 'dot') return { ai: 'dot', model: 'inbox', effort: '' };
  if (ownerOf(t.owner).kind === 'chatgpt') return { ai: 'chatgpt', model: 'auto', effort: '' };
  const ai = aiOf(t.owner), sp = specOf(t, ai);
  return { ai, model: sp.model || (ai === 'agy' ? '' : (state.roles.models[AI_KEY[ai]] || [])[0]), effort: sp.effort || '高' };
}
function syncSpecialPick(p, t) {
  if (view.kind !== 'work' || view.project !== p.id || view.task !== t.id) return;
  const select = $('#chat-ai'), effort = $('#chat-effort');
  if (!select || !effort) return;
  const pick = chatSelection(p, t);
  select.innerHTML = chatModelChoices(p,t);
  select.value = pick.ai + '|' + pick.model;
  effort.hidden = effortHidden(pick.ai); effort.disabled = ['agy', 'chatgpt', 'dot'].includes(pick.ai); effort.innerHTML = effortsFor(pick.ai).map(e => UI.template`<option ${e === pick.effort ? 'selected' : ''}${UI.valueAttribute(e)}>${esc(UI.label(e))}</option>`).join(''); effort.value = pick.effort;
  drawChatAccount(p, t);
}
// 文の中の URL とファイルの場所を押せるようにする（URL＝ブラウザで開く・コピー、場所＝開き方を選ぶ）
const LINK_RE = /\[([^\]\n]+)\]\((<[^>\n]+>|[^)\s]+(?:\([^)\s]*\)[^)\s]*)*)\)|(https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'*+,;=%()]+)|`([^`\n]+)`|((?:~\/|\/(?:Users|Volumes|private|tmp|opt|home)\/)[^\s<>"'`()（）「」『』【】\[\]、。，]+)|((?<![\p{L}\p{N}_\/.:@-])(?:[\p{L}\p{N}_.@-]+\/)+[\p{L}\p{N}_@-]+\.[A-Za-z0-9]{1,6})(?![\p{L}\p{N}_\/])/gu;
const urlLink = (u, label) => UI.template`<a href="#" class="lk" data-url="${esc(u)}" title="ブラウザで開く">${esc(label || u)}</a><button type="button" class="cp" data-copy="${esc(u)}" title="コピー" aria-label="コピー">⧉</button>`;
const pathLink = (x, label) => UI.template`<a href="#" class="lk lp" data-path="${esc(x)}" title="ファイル・フォルダの開き方を選ぶ">${esc(label || x)}</a>`;
// Local image links use Hub's authenticated viewer on both Mac and phones.
const imagePathLink = (p, label) => UI.template`<a href="#" class="chat-image" data-path="${esc(p)}" title="${UI.text('画像を見る')}"><img src="${esc(fileViewUrl(p))}" alt="${esc(label || p.split('/').pop())}" loading="lazy"><span>${esc(label || p.split('/').pop())}</span></a>`;
// URL の終わりの句読点や、対になっていない ) ] は URL に含めない
function trimUrl(u) {
  let x = u.replace(/[.,;:!?'*]+$/, '');
  for (;;) {
    const n = x.length;
    if (x.endsWith(')') && (x.match(/\(/g) || []).length < (x.match(/\)/g) || []).length) x = x.slice(0, -1);
    if (x.endsWith(']') && (x.match(/\[/g) || []).length < (x.match(/\]/g) || []).length) x = x.slice(0, -1);
    x = x.replace(/[.,;:!?'*]+$/, '');
    if (x.length === n) return x;
  }
}
const isPath = x => /^(~\/|\/)/.test(x) || (/\//.test(x) && !/\s{2,}/.test(x) && !/^[\/.]$/.test(x));
function linkify(text) {
  const s = String(text == null ? '' : text);
  let out = '', last = 0, m;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(s))) {
    // Markdown画像も場所リンクとして扱い、記法の ! を表示に残さない。
    const image = m[1] !== undefined && m.index > last && s[m.index - 1] === '!';
    out += esc(s.slice(last, image ? m.index - 1 : m.index));
    last = LINK_RE.lastIndex;
    if (m[1] !== undefined) { // [名前](URL または場所)
      const t = m[2].replace(/^<|>$/g, '').replace(/^file:\/\//, '');
      let dec = t; try { dec = decodeURI(t); } catch (e) { /* そのまま */ }
      const local = dec.replace(/#L?\d+(-L?\d+)?$/, '');
      out += /^https?:\/\//.test(t) ? urlLink(t, m[1]) : isPath(dec) ? image && /\.(png|jpe?g|gif|webp)$/i.test(local) ? imagePathLink(local, m[1]) : pathLink(local, m[1]) : esc(m[0]);
    } else if (m[3]) { const u = trimUrl(m[3]); out += urlLink(u) + esc(m[3].slice(u.length)); LINK_RE.lastIndex = last = m.index + m[3].length; }
    else if (m[4] !== undefined) {
      const c = m[4].trim();
      out += /^https?:\/\//.test(c) ? '`' + urlLink(c) + '`' : isPath(c) ? '`' + pathLink(c) + '`' : esc(m[0]);
    }
    else { const raw = m[5] || m[6], x = raw.replace(/[.,;:!?]+$/, ''); out += pathLink(x) + esc(raw.slice(x.length)); }
  }
  return out + esc(s.slice(last));
}
// 囲みの中はリンクにせず、そのままコピーできる形にする。
var UI = globalThis.HubI18n || {text: x=>x, html:x=>x, label:x=>x, message:x=>x, valueAttribute:()=>'', dateLocale:'ja-JP', template:(strings,...values)=>strings.reduce((s,x,i)=>s+x+(i<values.length?values[i]:''),'')};

function richText(text, streaming = false) {
  const lines=String(text??'').match(/[^\n]*\n|[^\n]+$/g)||[];
  let out='', plain='', code='', quote='', quoting=false, fence=0, lang='';
  for(const line of lines) {
    const raw=line.replace(/\r?\n$/, ''), start=raw.match(/^ {0,3}(`{3,})([^`]*)$/);
    if(!fence && /^ {0,3}>/.test(raw)) {
      if(!quoting) {out+=tables(plain);plain='';quoting=true;}
      quote+=line.replace(/^ {0,3}> ?/, '');
      continue;
    }
    flushQuote();
    if(!fence && start) {out+=tables(plain);plain='';fence=start[1].length;lang=start[2].trim().split(/\s+/)[0]||UI.text('テキスト');code='';}
    else if(fence && new RegExp('^ {0,3}`{'+fence+',}\\s*$').test(raw)) {
      out+=block(code, false);fence=0;
    } else if(fence) code+=line; else plain+=line;
  }
  flushQuote();
  if(fence)out+=block(code,true);else out+=tables(plain);
  return out;
  function flushQuote() {
    if(!quoting)return;
    out+=UI.template`<div class="codeblock quote-block"><div class="cb-head"><span>${UI.text('引用')}${streaming?UI.text(' ・書きかけ'):''}</span>${streaming?'':UI.html('<button type="button" class="cb-copy quote-copy" aria-label="引用の本文をコピー">⧉ 引用をコピー</button>')}</div><pre><code>${esc(quote).replace(/\r/g,'&#13;')}</code></pre></div>`;
    quote='';quoting=false;
  }
  function block(value,partial) {return UI.template`<div class="codeblock"><div class="cb-head"><span>${esc(lang)}${partial?UI.text(' ・書きかけ'):''}</span>${partial?'': UI.html('<button type="button" class="cb-copy" aria-label="この囲みをコピー">⧉ コピー</button>')}</div><pre><code>${esc(value).replace(/\r/g,'&#13;')}</code></pre></div>`;}
  // エスケープした | はセルの文字。両端の省略可能な | だけを取り除く。
  function cells(line) {
    const row=[''];let pipes=0,slashes=0;
    for(const ch of line.replace(/\r?\n$/, '')) {
      if(ch==='|') {
        if(slashes%2)row[row.length-1]=row[row.length-1].slice(0,-1)+'|';
        else {row.push('');pipes++;}
      } else row[row.length-1]+=ch;
      slashes=ch==='\\'?slashes+1:0;
    }
    if(!pipes)return null;
    if(!row[0].trim())row.shift();
    if(row.length && !row[row.length-1].trim())row.pop();
    return row.map(x=>x.trim());
  }
  function inline(value) {
    // リンク全体を先に拾い、名前や行先の記号を装飾として分断しない。
    const tokens=/!?\[[^\]\n]+\]\((?:<[^>\n]+>|[^)\s]+(?:\([^)\s]*\)[^)\s]*)*)\)|`([^`\n]+)`|\*\*([^\n]+?)\*\*/g;
    let html='',last=0,m;
    while((m=tokens.exec(value))) {
      html+=linkify(value.slice(last,m.index));
      html+=m[1]!==undefined?UI.template`<code class="rt-inline">${linkify(m[1])}</code>`:m[2]!==undefined?UI.template`<strong>${inline(m[2])}</strong>`:linkify(m[0]);
      last=tokens.lastIndex;
    }
    return html+linkify(value.slice(last));
  }
  function tables(value) {
    const rows=value.match(/[^\n]*\n|[^\n]+$/g)||[];
    let html='',pending='';
    for(let i=0;i<rows.length;i++) {
      const head=cells(rows[i]),sep=i+1<rows.length?cells(rows[i+1]):null;
      if(!head?.length || !sep || head.length!==sep.length || !sep.every(x=>/^:?-{2,}:?$/.test(x))) {pending+=rows[i];continue;}
      html+=linkify(pending);pending='';
      const align=sep.map(x=>x.startsWith(':')&&x.endsWith(':')?'center':x.endsWith(':')?'right':'left');
      const tr=(row,tag)=>'<tr>'+head.map((_,n)=>`<${tag}${tag==='th'?' scope="col"':''} class="rt-${align[n]}">${inline(row[n]??'')}</${tag}>`).join('')+'</tr>';
      html+=UI.html('<div class="rt-table-wrap" tabindex="0" role="region" aria-label="表（横にスクロールできます）"><table class="rt-table"><thead>')+tr(head,'th')+'</thead><tbody>';
      i++;
      while(i+1<rows.length) {
        const row=cells(rows[i+1]);
        // 多すぎる列は捨てずに、元の文字として残す。
        if(!row?.length || row.length>head.length)break;
        html+=tr(row,'td');i++;
      }
      html+='</tbody></table></div>';
    }
    return html+linkify(pending);
  }
}
document.addEventListener('click', async e=>{
  const b=e.target.closest?.('.cb-copy');if(!b || b.disabled)return;
  const label=UI.text(b.classList?.contains('quote-copy')?'⧉ 引用をコピー':'⧉ コピー');
  b.disabled=true;
  const ok=await copyText(b.closest('.codeblock').querySelector('code').textContent,true);
  b.textContent=ok?UI.text('✓ コピーしました'):UI.text('コピーできませんでした。選んで ⌘C');
  setTimeout(()=>{b.textContent=label;b.disabled=false;},2000);
});
// コピーできたかを返す（できなかった時に「コピーしました」と言わない）
async function copyText(v, quiet) {
  let ok = false;
  try { await navigator.clipboard.writeText(v); ok = true; }
  catch (e) { const ta = document.createElement('textarea'); ta.value = v; document.body.appendChild(ta); ta.select(); try { ok = document.execCommand('copy'); } catch (e2) { ok = false; } ta.remove(); }
  if (!quiet) toast(ok ? UI.text('コピーしました') : UI.text('コピーできませんでした。文を選んで ⌘C でコピーしてください'));
  return ok;
}
document.addEventListener('click', async e => {
  const el = e.target.closest && e.target.closest('[data-url],[data-path],[data-copy]');
  if (!el) return;
  e.preventDefault();
  if (el.dataset.copy) {
    const ok = await copyText(el.dataset.copy);

  }
  else if (el.dataset.url) api('/api/open-url', { url: el.dataset.url }).catch(err => toast(err.message));
  else showPath(el.dataset.path);
});
// 場所を押した時は開き方を選ぶ。元ファイルを開く・Finderで表示・フォルダの中身を見る。
const IN_APP = /ProjectHubApp/.test(navigator.userAgent);
const fsize = n => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
let fileViewer = null;
const fileViewUrl = p => '/api/file/view?project=' + encodeURIComponent(view.project || '') + '&task=' + encodeURIComponent(view.task || '') + '&path=' + encodeURIComponent(p);
function finishFileViewer() {
  if (!fileViewer) return;
  const old = fileViewer; fileViewer = null;
  clearTimeout(old.focusTimer);
  old.viewportCleanup?.();
  old.abort.abort(); old.el.remove();
  for (const [el, inert] of old.inert) el.inert = inert;
  Object.assign(document.body.style, old.style);
  window.scrollTo(old.x, old.y);
  const target = old.selection?.[0]?.isConnected ? old.selection[0] : old.trigger;
  if (target?.isConnected) target.focus({ preventScroll: true });
  if (old.selection?.[0]?.isConnected) { const [input, start, end, top] = old.selection; input.setSelectionRange(start, end); input.scrollTop = top; }
  old.restore?.();
}
function closeFileViewer() {
  if (!fileViewer) return;
  const old = fileViewer, restore = old.history && history.state?.fviewer === old.id;
  // iframeの遷移や遅いpopstateに左右されず、その場で会話に戻す。
  finishFileViewer();
  if (restore) {
    // 閉じた履歴は次に開く時に再利用し、開閉だけで履歴を増やさない。
    try { history.replaceState({ ...old.historyState, fviewerClosed: { state: old.historyState } }, ''); } catch { /* 履歴が使えなくても画面は解除済み */ }
  }
}
function prepareFileViewerFrame(frame, current) {
  frame.tabIndex = -1;
  let loaded = false;
  frame.addEventListener('load', () => {
    if (!loaded) { loaded = true; return; }
    if (fileViewer !== current || !current.history || history.state?.fviewer !== current.id) return;
    // 文書内の遷移後は親にも印を置き、戻る操作で閲覧画面を閉じられるようにする。
    const id = current.id + '-frame';
    try { history.pushState({ ...history.state, fviewer: id }, ''); current.id = id; } catch { /* 閉じるは履歴に依存しない */ }
  });
}
function prepareFileViewerControls(el, current) {
  for (const button of el.querySelectorAll('[data-fv-close]')) button.addEventListener('click', closeFileViewer);
  const viewport = window.visualViewport;
  if (!viewport) return;
  const controls = el.querySelector('.fv-mobile-controls');
  // ピンチ拡大・移動中も、閉じる操作だけを実際に見える画面の下端へ置く。
  // 画像そのものの拡大は保ち、ボタンは指で押せる大きさを保つ。
  const place = () => {
    const scale = viewport.scale || 1;
    Object.assign(controls.style, { top: '0', bottom: 'auto', right: 'auto', width: viewport.width * scale + 'px',
      transform: `translate(${viewport.offsetLeft}px, ${viewport.offsetTop + viewport.height}px) scale(${1 / scale}) translateY(-100%)` });
  };
  viewport.addEventListener('resize', place);
  viewport.addEventListener('scroll', place);
  current.viewportCleanup = () => {
    viewport.removeEventListener('resize', place);
    viewport.removeEventListener('scroll', place);
  };
  place();
}
async function showFileViewer(p, kind, trigger, attachment) {
  if (fileViewer) return;
  const el = document.createElement('div'), name = p.split('/').pop();
  el.id = 'fviewer'; el.className = 'fviewer' + (attachment ? ' fv-attachment' : ''); el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-labelledby', 'fv-name');
  el.innerHTML = UI.template`<div class="fv-bar"><b id="fv-name">${esc(name)}</b><button type="button" class="btn fv-close" data-fv-close>閉じる</button></div><div class="fv-body" aria-busy="true"><p class="note">読み込み中…</p></div><div class="fv-mobile-controls"><button type="button" class="btn fv-close" data-fv-close>閉じる</button></div>`;
  if (attachment) {
    el.querySelector('.fv-bar [data-fv-close]').remove();
    const controls = el.querySelector('.fv-mobile-controls');
    controls.innerHTML = UI.html('<button type="button" class="btn fv-close" data-fv-close>閉じる</button><button type="button" class="btn fv-close" data-fv-delete>削除</button>');
    controls.querySelector('[data-fv-delete]').addEventListener('click', () => { closeFileViewer(); attachment.remove(); });
  }
  const style = {}, keys = ['position', 'top', 'left', 'width', 'overflow'];
  for (const key of keys) style[key] = document.body.style[key];
  const active = document.activeElement, selection = active && typeof active.selectionStart === 'number' ? [active, active.selectionStart, active.selectionEnd, active.scrollTop] : null;
  const current = fileViewer = { el, trigger, selection, restore: attachment?.restore, style, x: window.scrollX, y: window.scrollY, id: Date.now() + '-' + Math.random(), abort: new AbortController(), inert: [] };
  document.body.appendChild(el);
  for (const child of document.body.children) if (child !== el) { current.inert.push([child, child.inert]); child.inert = true; }
  Object.assign(document.body.style, { position: 'fixed', top: -current.y + 'px', left: -current.x + 'px', width: '100%', overflow: 'hidden' });
  const slot = history.state?.fviewerClosed;
  current.historyState = slot ? slot.state : history.state;
  try {
    const state = { ...current.historyState, fviewer: current.id };
    if (slot) history.replaceState(state, ''); else history.pushState(state, '');
    current.history = true;
  } catch { /* 履歴が使えなくても閉じるボタンを使える */ }
  prepareFileViewerControls(el, current);
  el.querySelector('[data-fv-close]').focus({ preventScroll: true });
  const body = el.querySelector('.fv-body'), url = attachment?.url || fileViewUrl(p);
  const fail = () => { if (fileViewer === current) { body.innerHTML = UI.template`<p class="note fv-error" role="alert">このファイルを表示できません。Macで開いてください。</p>`; body.setAttribute('aria-busy', 'false'); } };
  try {
    if (kind === 'text' || kind === 'doc') {
      const response = await fetch(url + (kind === 'doc' ? '&as=html' : ''), { signal: current.abort.signal });
      if (!response.ok) throw Error('view failed');
      const text = await response.text();
      if (fileViewer !== current) return;
      if (kind === 'doc') {
        const frame = document.createElement('iframe'); frame.className = 'fv-frame'; frame.title = name;
        prepareFileViewerFrame(frame, current);
        frame.setAttribute('sandbox', '');
        // 一度だけ変換し、エラーは親で表示。srcdocにも外部読込禁止を適用する。
        frame.srcdoc = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; base-uri \'none\'; form-action \'none\'">' + text;
        body.replaceChildren(frame);
      } else body.innerHTML = /\.md$/i.test(p) ? `<div class="fv-text mb">${richText(text)}</div>` : `<pre class="fv-text">${esc(text)}</pre>`;
    } else if (kind === 'image') {
      const img = document.createElement('img'); img.className = 'fv-image'; img.alt = name;
      img.onerror = fail; img.onload = () => body.setAttribute('aria-busy', 'false');
      img.src = url; body.replaceChildren(img);
    } else {
      // Range確認でHTTPエラーを親に表示し、本文は端末のPDF表示に任せる。
      const response = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal: current.abort.signal });
      if (!response.ok) throw Error('view failed');
      await response.body?.cancel();
      if (fileViewer !== current) return;
      const frame = document.createElement('iframe'); frame.className = 'fv-frame'; frame.title = name;
      prepareFileViewerFrame(frame, current);
      frame.onerror = fail; frame.src = url; body.replaceChildren(frame);
    }
    body.setAttribute('aria-busy', 'false');
  } catch (e) { if (e.name !== 'AbortError') fail(); }
}
window.addEventListener?.('popstate', () => {
  if (fileViewer && history.state?.fviewer !== fileViewer.id) finishFileViewer();
  if (!fileViewer && history.state?.fviewer) { const { fviewer, ...state } = history.state; history.replaceState(state, ''); }
});
// sandbox文書や端末のPDF表示からキーイベントは親へ届かない。
// 本文へのクリック・タッチは通し、キーボードの操作先は閉じるボタンへ戻す。
window.addEventListener?.('blur', () => {
  const current = fileViewer;
  if (!current || document.activeElement?.className !== 'fv-frame') return;
  const refocus = () => {
    if (fileViewer === current) {
      window.focus();
      const button = current.el.querySelector('[data-fv-close]');
      button.blur(); button.focus({ preventScroll: true });
    }
  };
  refocus();
  clearTimeout(current.focusTimer);
  current.focusTimer = setTimeout(() => { refocus(); current.focusTimer = null; }, 0);
});
const fileViewerEscape = e => {
  if (fileViewer && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closeFileViewer(); }
};
document.addEventListener('keydown', fileViewerEscape);
document.addEventListener('keyup', fileViewerEscape);
async function openPath(p, how) {
  try {
    const r = await api('/api/reveal', { project: view.project, task: view.task, path: p, app: IN_APP, how });
    if (r.byApp) location.href = `hubapp://reveal?dir=${r.dir ? 1 : 0}&open=${r.how === 'open' ? 1 : 0}&path=${encodeURIComponent(r.path)}`;
    toast(`${r.how === 'open' ? UI.text('開きました') : UI.text('Finder で開きました')}：${r.path.split('/').pop()}`);
  } catch (err) { toast(err.message); }
}
async function showPath(p, how = 'info') {
  let r;
  try { r = await api('/api/reveal', { project: view.project, task: view.task, path: p, app: IN_APP, how }); }
  catch (err) { toast(err.message); return; }
  let el = $('#fsheet');
  if (!el) { document.body.insertAdjacentHTML('beforeend', '<div class="fsheet" id="fsheet" role="dialog" aria-modal="true"></div>'); el = $('#fsheet'); }
  el.hidden = false;
  const head = UI.template`<div class="fs-head"><b>${r.dir ? '📁' : '📄'} ${esc(r.path.split('/').pop())}</b><span class="small fs-path">${esc(r.path)}</span></div>`;
  if (!r.entries) {
    const imageUrl = fileViewUrl(r.path), kind = r.viewKind || (r.view ? 'image' : '');
    const viewNote = kind === 'image' ? UI.text('この画面で画像を見られます。') : UI.text('この画面でファイルを見られます。');
    const note = r.remote ? !r.view && !r.dir ? UI.text('この形式はスマホでは開けません。Macで開いてください。') : UI.text('Macの画面で開く操作は、このMacの前でだけ使えます。') : r.view ? UI.text('Macで開く時は［元のファイルを開く］。') : r.dir ? UI.text('フォルダの開き方を選んでください。') : UI.text('コピーを作らず、元のファイルを既定のアプリで開けます。');
    const mac = r.remote ? '' : r.dir ? UI.template`<button type="button" class="btn" data-fs-finder="${esc(r.path)}">Finderで開く</button>` : UI.template`<button type="button" class="btn${r.view ? ' plain' : ''}" data-fs-open="${esc(r.path)}">元のファイルを開く</button><button type="button" class="btn plain" data-fs-finder="${esc(r.path)}">Finderで表示</button>`;
    el.innerHTML = UI.template`<div class="fs-box">${head}<div class="fs-list">${kind === 'image' ? `<img class="fs-img" src="${esc(imageUrl)}" alt="${esc(r.path.split('/').pop())}" loading="lazy">` : ''}<p class="note">${r.view ? viewNote + ' ' : ''}${note}</p>${kind === 'doc' ? UI.html('<p class="note">文書の画像や複雑な表は表示が崩れる場合があります。</p>') : ''}</div>
      <div class="acts fs-acts">${r.view ? `<button type="button" class="btn" data-fs-view="${esc(r.path)}" data-view-kind="${esc(kind)}">${kind === 'image' ? UI.text('画像を見る') : UI.text('開く')}</button>` : ''}${mac}${r.dir ? UI.template`<button type="button" class="btn plain" data-fs-list="${esc(r.path)}">中身を見る</button>` : ''}
      <button type="button" class="btn plain" data-fs-copy="${esc(r.path)}">場所をコピー</button><span class="sp"></span><button type="button" class="btn plain" data-fs-close>閉じる</button></div></div>`;
    return;
  }
  el.innerHTML = UI.template`<div class="fs-box">${head}
    <div class="fs-list">${r.parent ? UI.template`<button type="button" class="fs-row" data-fs-list="${esc(r.parent)}">↩︎ 上のフォルダへ</button>` : ''}
    ${r.entries.length ? r.entries.map(x => UI.template`<button type="button" class="fs-row" ${x.dir ? `data-fs-dir="${esc(x.path)}"` : `data-fs-file="${esc(x.path)}"`}><span>${x.dir ? '📁' : '📄'} ${esc(x.name)}</span><span class="small">${x.dir ? '' : fsize(x.size)}</span></button>`).join('') : UI.html('<p class="note">空のフォルダです</p>')}</div>
    <div class="acts fs-acts">${r.remote ? '' : UI.template`<button type="button" class="btn plain" data-fs-finder="${esc(r.path)}">Finder で開く</button>`}<button type="button" class="btn plain" data-fs-copy="${esc(r.path)}">場所をコピー</button><span class="sp"></span><button type="button" class="btn" data-fs-close>閉じる</button></div></div>`;
}
document.addEventListener('click', async e => {
  const t = e.target.closest && e.target.closest('[data-fs-dir],[data-fs-file],[data-fs-open],[data-fs-list],[data-fs-finder],[data-fs-copy],[data-fs-close],[data-fs-view],.fsheet');
  if (!t) return;
  const d = t.dataset;
  if (d.fsView) await showFileViewer(d.fsView, d.viewKind, t);
  else if (d.fsDir || d.fsFile) await showPath(d.fsDir || d.fsFile);
  else if (d.fsList) await showPath(d.fsList, 'list');
  else if (d.fsOpen || d.fsFinder) await openPath(d.fsOpen || d.fsFinder, d.fsOpen ? 'open' : 'finder');
  else if (d.fsCopy) copyText(d.fsCopy);
  else if (d.fsClose !== undefined || t.classList.contains('fsheet') && e.target === t) $('#fsheet').hidden = true;
});
// コマンドなどの細かい作業を会話に出すか（設定画面で変える。最初は出さない）
const showDetail = () => { try { return localStorage.getItem('hub-detail') === '1'; } catch (e) { return false; } };
// Enter だけで送るか（設定。最初は ⌘ + Enter）。Shift + Enter はいつも改行
const enterSends = () => { try { return localStorage.getItem('hub-enter') === '1'; } catch (e) { return false; } };
const isSendKey = e => e.key === 'Enter' && !e.isComposing && ((e.metaKey || e.ctrlKey) || (enterSends() && !e.shiftKey && !e.altKey));
const isToolRow = r => r.tool || !/やり直/.test(r.text || ''); // 前の記録には印が無いため、やり直しの知らせ以外は細かい作業とみなす
// 保存済みの旧要約は原文を変更せず、続きと判断待ちの区画を表示の先頭へ。
function continuationSummary(text) {
  if(typeof text!=='string')return text;
  const next=['次にすること','次にする作業','下一步','接下來要做的工作'];
  const pending=['残件・判断待ち','人の判断待ち','剩餘工作與待決定事項','待使用者決定'];
  const headings=[...next,...pending,'承認（人の発言のみ）','核准（僅限使用者發言）','決定事項','已決定事項','理由','参照先','參照位置','參考位置','參考來源'];
  const lines=text.split('\n'),sections=[];let current=null,prefix=[];
  for(const l of lines){const label=l.trim().replace(/[：:]$/, '');if(headings.includes(label)&&/[：:]$/.test(l.trim())){current={label,lines:[l]};sections.push(current);}else (current?current.lines:prefix).push(l);}
  if(!sections.some(s=>next.includes(s.label)||pending.includes(s.label)))return text;
  for(const s of sections)if(next.includes(s.label))s.lines[0]=UI.text('次にする作業')+'：';
  const rank=s=>next.includes(s.label)?0:pending.includes(s.label)?1:2;
  return [...prefix,...sections.sort((a,b)=>rank(a)-rank(b)).flatMap(s=>s.lines)].join('\n');
}
function msgHtml(r) {
  const html=baseMsgHtml(r),button=window.HubIdeas?.messageButton(r,{project:view.project,task:view.task})||'';
  return button?html.replace(/<\/div>$/,`<div class="idea-message-action">${button}</div></div>`):html;
}
function baseMsgHtml(r) {
  const time = r.at ? new Date(r.at).toLocaleTimeString(UI.dateLocale, { hour: '2-digit', minute: '2-digit' }) : '';
  if (r.from === 'gptchat' || r.from === 'gptchat-report') {
    const child = taskOf(proj(view.project), r.childTask);
    return UI.template`<div class="m ai"><div class="mh"><b>ChatGPT（Chat／Pro）</b><span class="small">${time}</span></div><div class="mb">${richText(r.text)}</div>${child ? gptChildLink(view.project, child.id) : UI.html('')}</div>`;
  }
  if (r.role === 'user' && r.to === 'gptchat' && r.request) return UI.template`<div class="m me" data-gpt-request="${esc(r.request)}"><div class="mh"><b data-gpt-status>ChatGPT（Chat）への依頼（未処理）</b><span class="small">${time}</span></div><div class="mb">${richText(r.text)}</div>${gptChildLink(view.project, view.task)}</div>`;
  if (r.summaryAuto) return UI.template`<div class="m handoff"><details><summary>前の会話を整理しました（人の確認なし）・中身を見る</summary><div class="mb">${richText(continuationSummary(r.text))}</div></details></div>`;
  if (r.role === 'event' && r.continuation) return UI.template`<div class="ev" role="status">${esc(r.text)}</div>`;
  if (r.role === 'event') return isToolRow(r) && !showDetail() ? '' : UI.template`<div class="ev">▸ ${esc(r.text)}</div>`;
  if (r.role === 'user' && (r.from === 'delegate' || r.from === 'child' || r.from === 'subtask')) {
    // 過去の結果通知でも、実際の成果を確認する共通引渡しへ進む。
    const childProject = proj(r.childProject || view.project);
    const candidate = r.child && r.from !== 'child' && taskOf(childProject, r.child);
    const receiver = { project: proj(view.project), task: taskOf(proj(view.project),view.task) };
    const recordedTitle = typeof r.childTitle === 'string' ? r.childTitle : /^（子作業「(.+)」の結果）(?:\r?\n|$)/.exec(r.text || '')?.[1];
    const mismatch = candidate && recordedTitle !== undefined && recordedTitle !== candidate.title;
    const block = candidate && !mismatch && !r.handoff && !r.partialReceipt ? ProjectOrder.integrateBlock(receiver,childProject,candidate,state.projects,'continue') : null;
    const offer = candidate && (state.taskOffers||[]).find(x=>x.project===childProject.id&&x.task===candidate.id&&x.targetProject===view.project&&x.targetTask===view.task);
    const received = offer?.pending===false;
    const unchecked = offer?.received&&offer.pending!==false&&offer.receiptChecked!==true;
    const kid = !mismatch && !received && !unchecked && !r.handoff && !r.partialReceipt && !block ? candidate : null;
    const absorb = kid ? transferButton(childProject.id,kid.id,recordedTitle ?? kid.title,r.offer?UI.text('統合…'):UI.text('成果を受け取る')) : '';
    const note = r.handoff ? (r.disposition==='continue'?UI.text('この成果は受領済みです。作業と残件を保持して続けられます。新しい成果が届いたときだけ［統合…］が表示されます。'):r.integrating ? UI.text('この成果はもう受け取っています。統合や片付けが残っている場合は上部の［統合…］から進めてください。') : UI.text('この成果はもう受け取っています。片付けが残っている場合は上部の［引渡しの残りを続ける］から進めてください。'))
      : received ? UI.text('この成果は受領済みです。作業と残件を保持して続けられます。新しい成果が届いたときだけ［統合…］が表示されます。')
      : unchecked ? UI.text('受領状況が未確認です')
      : mismatch ? UI.text('この結果の子作業は今はありません（同じ番号の別の作業があります）。')
      : r.child && r.from !== 'child' && !candidate ? UI.text('この子作業は今はありません。受け取った成果は本作業の会話と［ファイルを見る］で確認できます。')
      : block || (kid && transferNeedsUpdate() ? transferUpdateMessage() : '');
    return UI.template`<div class="m ai"><div class="mh"><span class="chip"><span class="ic">↩</span>${r.from === 'delegate' ? UI.text('渡した作業の結果') : r.from === 'subtask' ? UI.text('子作業の結果') : UI.text('子プロジェクトの結果')}${r.ai ? UI.template`<small>・${esc(AI_LABEL[r.ai] || r.ai)}</small>` : ''}</span><span class="small">${time}</span>${absorb}</div>${note ? UI.template`<p class="transfer-hint">${esc(note)}</p>` : ''}<div class="mb">${richText(r.text)}</div></div>`;
  }
  if (r.role === 'user' && r.to === 'dot' && r.request) return UI.template`<div class="m me" data-dot-request="${esc(r.request)}"><div class="mh"><b data-dot-status>Dotへの依頼（廃止・参照のみ）</b><span class="small">${time}</span></div><div class="mb">${richText(r.text)}</div><p class="small">依頼ID：${esc(r.request)}</p></div>`;
  if (r.role === 'user') return UI.template`<div class="m me"><div class="mh">${r.mode === 'redo' || r.mode === 'interrupt' ? UI.html('<span class="tagm int">やり直し</span>') : r.mode === 'amend' ? UI.html('<span class="tagm am">追加指示</span>') : r.mode === 'queued' ? UI.html('<span class="tagm">順番待ちの指示</span>') : ''}<span class="small">${time}・${esc(AI_LABEL[r.to] || '')}${r.model ? '・' + esc(r.model) : ''}${r.to === 'codex' && r.fast === true ? UI.text('・加速ON（Fast）') : ''} へ</span></div><div class="mb">${richText(r.text)}</div></div>`;
  return UI.template`<div class="m ai ${r.discussion ? 'discussion-message' : ''} ${r.discussion?.summary && !r.error ? 'discussion-summary' : ''}" ${r.ai === 'chatgpt-chat' && r.request ? `data-gpt-report="${esc(r.request)}"` : ''} ${r.ai === 'dot' && r.request ? `data-dot-report="${esc(r.request)}"` : ''}><div class="mh">${r.discussion ? UI.template`<b>${esc(r.discussion.summary ? '話し合いのまとめ' : r.discussion.stage)}</b>` : ''}<span class="chip k-${esc(r.ai)}"><span class="ic">${AI_ICON[r.ai] || '?'}</span>${esc(AI_LABEL[r.ai] || r.ai)}${r.model ? UI.template`<small>・${esc(r.model)}${r.effort ? '・' + esc(r.effort) : ''}</small>` : ''}</span><span class="small">${time}</span>${r.error ? UI.html('<span class="done bad">⚠ 止まりました</span>') : UI.template`<span class="done">✓ 完了${r.ms ? '（' + dur(r.ms) + '）' : ''}</span>`}${r.text ? UI.template`<button type="button" class="cp cp-msg" data-copy="${esc(r.text)}" title="この返事をコピー">⧉ コピー</button>` : ''}</div>
    ${r.text ? UI.template`<div class="mb">${richText(r.text)}</div>` : ''}${(r.generatedImages || []).map(x => imagePathLink(x.path, x.name)).join('')}${r.asks && r.asks.length ? askHtml(r.asks) : ''}${r.error ? UI.template`<div class="merr">${esc(r.error)}</div>` : ''}</div>`;
}
// 質問ごとに選択と自由入力を保持し、最後にまとめて送る。
const askDrafts = new Map();
const askPending = new Set();
// 起動前の user/error 行でも、受付に失敗した質問は再送できるようにする。
// 作業・原文・回答欄を限定し、新質問や受付済みの欄には引き継がない。
const askAttempts = new Map();
const cleanOpt = o => o.replace(/[（(]おすすめ[）)]/g, '').trim();
function askHtml(asks) {
  const key = JSON.stringify([view.project, view.task, asks]);
  const saved = askDrafts.get(key) || [];
  return UI.template`<div class="ask${askPending.has(key) ? ' pending' : ''}" data-ask-key="${esc(key)}">${asks.map((a, i) => {
    const d = saved[i] || { selected: [], free: '' };
    return UI.template`<div class="ask-q" data-i="${i}" data-multi="${a.multi ? 1 : 0}" data-q="${esc(a.question)}">
      <div class="ask-t">❓ ${richText(a.question || UI.text('選んでください'))}</div>
      <div class="ask-opts">${a.options.map(o => UI.template`<button type="button" class="ask-o${d.selected.includes(o) ? ' on' : ''}" data-ask="${esc(o)}" aria-pressed="${d.selected.includes(o)}">${esc(o)}</button>`).join('')}</div>
      <label class="ask-free-label">ほかの回答・補足<textarea class="ask-free" rows="2" placeholder="選択肢にない回答を書けます。選んだ回答への補足もできます。">${esc(d.free)}</textarea></label></div>`;
  }).join('')}
    <div class="ask-foot"><span class="small">質問ごとに選ぶか入力して、まとめて［選んで送る］を押してください。</span><button type="button" class="btn sm ask-send">選んで送る</button></div><div class="ask-status small" role="status"></div></div>`;
}
function askValues(ask) {
  return [...ask.querySelectorAll('.ask-q')].map(q => ({ question: q.dataset.q,
    selected: [...q.querySelectorAll('.ask-o.on')].map(b => b.dataset.ask), free: q.querySelector('.ask-free').value }));
}
function askAnswer(values) {
  return values.map(v => {
    const selected = v.selected.map(cleanOpt).join('、'), free = v.free.trim();
    const answer = selected && free ? UI.template`${selected}\n自由入力：${free}` : selected || free;
    return values.length > 1 ? `${v.question}：${answer}` : answer;
  }).join('\n\n');
}
function updateAskControls(ask) {
  if(ask.closest?.('.freetalk-work')?.dataset.readonly==='true'){ask.querySelectorAll('button, textarea').forEach(e=>e.disabled=true);return;}
  const disabled = ask.classList.contains('done') || askPending.has(ask.dataset.askKey) || (typeof chatSending !== 'undefined' && chatSending.has(JSON.stringify(JSON.parse(ask.dataset.askKey).slice(0,2))));
  ask.querySelectorAll('button, textarea').forEach(el => { el.disabled = disabled; });
  ask.querySelector('.ask-send').textContent = askPending.has(ask.dataset.askKey) ? UI.text('送っています…') : UI.text('選んで送る');
}
function bindAskAnswers(box, send) {
  box.addEventListener('input', e => {
    const ask = e.target.closest('.ask');
    if (!ask || !e.target.matches('.ask-free') || ask.classList.contains('done') || askPending.has(ask.dataset.askKey)) return;
    askDrafts.set(ask.dataset.askKey, askValues(ask)); ask.querySelector('.ask-status').textContent = '';
  });
  box.addEventListener('click', async e => {
    const ask = e.target.closest('.ask');
    if (!ask || ask.classList.contains('done') || askPending.has(ask.dataset.askKey)) return;
    const opt = e.target.closest('.ask-o');
    if (opt) {
      const q = opt.closest('.ask-q'), wasOn = opt.classList.contains('on');
      if (q.dataset.multi !== '1') q.querySelectorAll('.ask-o').forEach(b => b.classList.remove('on'));
      opt.classList.toggle('on', !wasOn);
      q.querySelectorAll('.ask-o').forEach(b => b.setAttribute('aria-pressed', String(b.classList.contains('on'))));
      askDrafts.set(ask.dataset.askKey, askValues(ask)); ask.querySelector('.ask-status').textContent = ''; return;
    }
    if (!e.target.closest('.ask-send')) return;
    const values = askValues(ask), missing = values.findIndex(v => !v.selected.length && !v.free.trim());
    askDrafts.set(ask.dataset.askKey, values);
    if (missing !== -1) {
      ask.querySelector('.ask-status').textContent = UI.template`質問${missing + 1}の選択肢を選ぶか、ほかの回答を入力してください。`;
      ask.querySelectorAll('.ask-free')[missing].focus(); return;
    }
    const key = ask.dataset.askKey;
    const currentAsks = () => [...new Set([ask, ...document.querySelectorAll('.ask')])].filter(a => a.dataset.askKey === key);
    askPending.add(key); updateAskControls(ask);
    ask.querySelector('.ask-status').textContent = '';
    try {
      if (await send(askAnswer(values))) {
        askDrafts.delete(key); currentAsks().forEach(a => { a.classList.add('answered', 'done'); a.querySelector('.ask-status').textContent = UI.text('回答をまとめて送信しました。'); });
      } else { currentAsks().forEach(a => { a.querySelector('.ask-status').textContent = UI.text('送信されていません。回答はそのまま残っています。'); }); }
    } catch (err) { currentAsks().forEach(a => { a.querySelector('.ask-status').textContent = UI.template`送信できませんでした。回答は残っています。${err.message}`; }); }
    finally { askPending.delete(key); currentAsks().forEach(updateAskControls); }
  });
}
// 答えられるのは最後の返事の質問だけ。過去の回答欄は読み取り専用。
function refreshAsks(box) {
  const all = [...box.querySelectorAll('.m')];
  const last = all.filter(m => !m.id).pop();
  const asks = [...box.querySelectorAll('.ask')];
  const workKey = JSON.stringify([view.project, view.task]), attempt = askAttempts.get(workKey);
  const current = attempt && taskOf(proj(view.project), view.task);
  const target = attempt && asks.filter(a => a.dataset.askKey === attempt.askKey).at(-1);
  const newer = target && asks.slice(asks.indexOf(target) + 1).some(a => a.dataset.askKey !== attempt.askKey);
  const retry = attempt && current?.question === attempt.question && target && !newer && !target.classList.contains('answered');
  // 初期履歴が届く前の空DOMは、対象の質問が消えたという情報ではない。
  if (attempt && (current?.question !== attempt.question || newer || target?.classList.contains('answered') || (!target && box.dataset?.askHistoryPending !== '1'))) askAttempts.delete(workKey);
  asks.forEach(a => {
    a.classList.toggle('done', a.classList.contains('answered') || (!(retry && a === target) && (!last || !last.contains(a))));
    updateAskControls(a);
  });
}
// かかった時間：「45秒」「1分20秒」
function dur(ms) { const t = Math.max(0, Math.round(ms / 1000)); return t < 60 ? UI.template`${t}秒` : UI.template`${Math.floor(t / 60)}分${t % 60 ? (t % 60) + '秒' : ''}`; }
let busyTimer = null;
const queueDrafts = new Map();
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
  const editableQueue = x => !x.automation && !x.selectionOnly && !x.readOnly && !x.limitSwitch && !x.resultsOrganize && !x.integrationAssignment && !x.isolatedReview && !x.integrationReviewRequest;
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
      api('/api/webchat').then(async r => {
        if(!current())return;
        state.webchat=r;
        const slot=$('#webchat-progress'); if(slot)slot.innerHTML=webchatProgress(p,t);
        const jobs=(r.jobs||[]).filter(j=>j.project===p.id && j.task===t.id);
        const job=jobs.find(j=>['queued','checking','sending','reporting'].includes(j.state));
        if(job)setBusy({ai:'chatgpt',model:job.model,started:Date.parse(job.at),text:'',webchat:true});
        else if(chatBusy?.webchat)setBusy(null);
        if(['done','blocked','unknown','stopped'].includes(jobs.at(-1)?.state)) await refreshTree(current);
        if(current())syncChatWebchatAvailability();
      }).catch(()=>{});
    } else if (ev.type === 'history-auto') { globalThis.HubTaskHistory?.receiveAuto(p.id, t.id, ev);
    } else if (ev.type === 'reset') { if(p.id!=='freetalk'&&globalThis.HubTaskHistory?.resetAuto(p.id,t.id))return; if(p.id==='freetalk')clearSentChatImages(p.id,t.id,[...chatImages(p.id,t.id)]); if(ev.generation)(globalThis.HubChatGenerations ||=new Map()).set(p.id+'\0'+t.id,ev.generation); renderedMainKey=''; load(); } else if (ev.type === 'busy') { webchatPoll++; setBusy({ ...(chatBusy || {}), ai: ev.ai, model: ev.model, started: ev.started, text: '', webchat:Boolean(ev.webchat) }); refreshTree(); }
    else if (ev.type === 'partial') setBusy({ ...(chatBusy || { ai: ev.ai }), text: ev.text });
    else if (ev.type === 'idle') { webchatPoll++; setBusy(null); refreshTree(); }
  };
}

// 取り込み案内は task-history が所有する。ここでは既存の反映証拠だけを更新する。
let mainPreviewRequest = 0;
async function loadPreview(pid, tid) {
  const el = document.querySelector('[data-act="merge"]');
  if (!el) return;
  const request = ++mainPreviewRequest;
  try {
    const r = await api(`/api/task/preview?project=${encodeURIComponent(pid)}&task=${encodeURIComponent(tid)}`);
    if (request !== mainPreviewRequest || el !== document.querySelector('[data-act="merge"]') || view.kind !== 'work' || view.task !== tid || view.project !== pid) return;
    const pending=(state.taskIntegrations||[]).find(x=>x.project===pid&&x.task===tid)?.mainPending;
    const key=pid+'\0'+tid;
    if(pending&&r?.mainDisplay?.key===JSON.stringify(pending))integrationMainEvidence.set(key,{...r.mainDisplay,at:Date.now(),instance:state.hubInstance});
    else integrationMainEvidence.delete(key);
    refreshKidsDoneBar();
    if(!r)return;
    const exclude = document.querySelector('[data-act="mergeexclude"]');
    if (exclude) exclude.hidden = r.files === 0 && !r.conflict;
    if(typeof prepareOneclickMain==='function')await prepareOneclickMain(pid,tid,el);
  } catch (e) {
    if(request===mainPreviewRequest&&el===document.querySelector('[data-act="merge"]')&&view.kind==='work'&&view.project===pid&&view.task===tid){integrationMainEvidence.delete(pid+'\0'+tid);refreshKidsDoneBar();}
    if(request===mainPreviewRequest&&view.kind==='work'&&view.project===pid&&view.task===tid&&el===document.querySelector('[data-act="merge"]')&&typeof prepareOneclickMain==='function')await prepareOneclickMain(pid,tid,el);
  }
}

// live=true：動いている AI の見出しに置く。変えるとその AI に切り替えを伝える
function specSelect(p, t, ai, live) {
  if (ai === 'agy') {
    const s = specOf(t,ai), models = shownModels('agy',s.model), selected = live ? agyModelLabel(sessOf(p.id,t.id,ai)?.model || s.model) : s.model;
    return UI.template`<span class="spec"><select data-act="model" data-ai="agy" data-p="${esc(p.id)}" data-t="${esc(t.id)}" aria-label="モデル" ${live ? 'disabled' : ''}><option value="" ${selected ? '' : 'selected'}>モデルを選んでください</option>${selected && !models.includes(selected) ? UI.template`<option selected disabled value="${esc(selected)}">${esc(selected)}（利用不可）</option>` : ''}${models.map(m => UI.template`<option value="${esc(m)}" ${m === selected ? 'selected' : ''}>${esc(modelOptionLabel(ai,m))}</option>`).join('')}</select><select aria-label="思考" hidden disabled><option>高</option></select></span>`;
  }
  const key = AI_KEY[ai], models = state.roles.models[key] || [], s = specOf(t, ai);
  const missing = t.model && !models.includes(t.model);
  const k = `data-p="${esc(p.id)}" data-t="${esc(t.id)}"${live ? ` data-ai="${ai}"` : ''}`;
  return UI.template`<span class="spec" title="${live ? UI.template`変えると ${AI_LABEL[ai]} に切り替えを伝えます` : UI.template`次に始める時の ${AI_LABEL[ai]} のモデルと思考（空なら役割の設定）`}">
    <select data-act="model" ${k} aria-label="モデル"><option value="" ${t.model ? '' : 'selected'}>モデル：役割どおり（${esc(s.model || '—')}）</option>${missing ? UI.template`<option selected disabled value="${esc(t.model)}">${esc(t.model)}（現在の指定・利用不可）</option>` : ''}${shownModels(key, t.model).map(m => UI.template`<option ${t.model === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select>
    <select data-act="effort" ${k} aria-label="思考"><option value="" ${t.effort ? '' : 'selected'}>思考：役割どおり（${esc(s.effort || '—')}）</option>${effortsFor(ai).map(e => UI.template`<option ${t.effort === e ? 'selected' : ''}${UI.valueAttribute(e)}>${esc(UI.label(e))}</option>`).join('')}</select></span>`;
}

// 端末の部品（xterm.js・290KB）は、ターミナル画面を初めて開く時だけ読み込む（会話画面しか使わない時は読まない）
let xtermLoading = null;
function loadXterm() {
  if (window.Terminal && window.FitAddon) return Promise.resolve();
  if (!xtermLoading) {
    const one = src => new Promise((ok, ng) => { const sc = document.createElement('script'); sc.src = src; sc.onload = ok; sc.onerror = () => ng(new Error(UI.template`${src} を読み込めませんでした`)); document.head.appendChild(sc); });
    xtermLoading = one('vendor/xterm.js').then(() => one('vendor/addon-fit.js')).catch(e => { xtermLoading = null; throw e; });
  }
  return xtermLoading;
}
async function attach(project, task, ai) {
  try { await loadXterm(); } catch (e) { toast(e.message); return; }
  const el = document.getElementById('pane-' + ai);
  if (!el || panes[ai]) return; // 読み込みを待つ間に画面が変わった・もう付いている
  const xterm = new window.Terminal({ fontSize: 13, fontFamily: 'Menlo, Consolas, monospace', cursorBlink: true, scrollback: 5000, theme: window.HubTheme?.terminalTheme() || { background: '#10131a' } });
  const fit = new window.FitAddon.FitAddon();
  xterm.loadAddon(fit);
  xterm.open(el);
  const pane = { xterm, fit, es: null, ro: null };
  panes[ai] = pane;
  const doFit = () => { try { fit.fit(); api('/api/term/resize', { project, task, ai, cols: xterm.cols, rows: xterm.rows }).catch(() => {}); } catch (e) { /* 表示前 */ } };
  pane.ro = new ResizeObserver(doFit); pane.ro.observe(el);
  setTimeout(doFit, 0);
  xterm.onData(d => api('/api/term/input', { project, task, ai, data: d }).catch(() => {}));
  const es = new EventSource(`/api/term/stream?project=${encodeURIComponent(project)}&task=${encodeURIComponent(task)}&ai=${ai}`);
  es.onmessage = e => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'data') xterm.write(ev.data);
    if (ev.type === 'exit') { xterm.write("\r\n" + UI.template`\x1b[90m— 終了しました（code ${ev.code}）—\x1b[0m` + "\r\n"); es.close(); setTimeout(() => load().catch(() => {}), 500); }
  };
  pane.es = es;
}
document.addEventListener('hub-theme-change', () => {
  for (const pane of Object.values(panes)) pane.xterm.options.theme = window.HubTheme.terminalTheme();
});
function closePanes() {
  chatScroller?.dispose(); chatScroller = null;
  if (chatES) { chatES.close(); chatES = null; }
  discussionUIInstance?.close();
  clearInterval(busyTimer); busyTimer = null; chatBusy = null;
  for (const ai of Object.keys(panes)) {
    const p = panes[ai];
    if (p.es) p.es.close();
    if (p.ro) p.ro.disconnect();
    try { p.xterm.dispose(); } catch (e) { /* 無視 */ }
  }
  panes = {};
}

async function startAI(p, t, ai) {
  if (accountSelectionSaving) { toast(UI.text('アカウントの選択を保存中です')); return; }
  if (taskFastSaving || accelerationSaving) { toast(UI.text('加速の選択を保存中です')); return; }
  const account = taskOf(proj(p), t)?.accounts?.[ai] || 'default';
  const model = ai === 'agy' ? modelRequest(ai,specOf(taskOf(proj(p),t),ai).model) : undefined;
  if (!state.terminal) {
    const r = await api('/api/continue', { project: p, task: t, ai, account, model });
    toast(UI.template`別の窓で起動しました（${r.dir}）`);
    return;
  }
  const r = await api('/api/term/start', { project: p, task: t, ai, account, model, cols: 100, rows: 30 });
  toast(UI.template`${AI_LABEL[r.ai || ai]} を起動しました${r.model ? `（${r.model}${r.effort ? '・' + r.effort : ''}）` : ''}${r.note ? '。' + r.note : ''}`);
  await load();
}

// DOMを書き換える直前の位置を保つ。通信待ちの間に人がスクロールした位置も尊重する。
function preserveSettingsScroll(update) {
  const before = view.kind === 'settings' ? $('#main .settings')?.parentElement : null;
  const position = before ? { top: before.scrollTop, left: before.scrollLeft } : null;
  const result = update();
  const after = view.kind === 'settings' ? $('#main .settings')?.parentElement : null;
  if (position && after) { after.scrollTop = position.top; after.scrollLeft = position.left; }
  return result;
}
// 設定内の局所更新と全体再描画のどちらでも、開閉・編集中の値・フォーカスを保つ。
const aiSettingsOpen = new Set(), aiSettingsInputs = new Map();
let aiSettingsDrawing = false;
function aiSettingsInputKey(input) {
  const row = input.closest('[data-account-row]');
  return input.matches('[data-account-name]') ? `account:${row.dataset.ai}:${row.dataset.id}` : input.id;
}
function preserveAiSettings(update) {
  if (aiSettingsDrawing) return update();
  const before = $('#ai-use-settings'), focused = before?.contains(document.activeElement) ? document.activeElement : null;
  if (before) {
    aiSettingsOpen.clear();
    before.querySelectorAll('details[data-ai-fold][open]').forEach(el => aiSettingsOpen.add(el.dataset.aiFold));
    before.querySelectorAll('#account-new-ai,#account-new-name,[data-account-name]').forEach(el => aiSettingsInputs.set(aiSettingsInputKey(el), el.value));
  }
  const focus = focused ? { id: focused.id, key: focused.matches('[data-account-name]') ? aiSettingsInputKey(focused) : '', start: focused.selectionStart, end: focused.selectionEnd } : null;
  return preserveSettingsScroll(() => {
    aiSettingsDrawing = true;
    try { return update(); }
    finally {
      aiSettingsDrawing = false;
      const after = $('#ai-use-settings');
      after?.querySelectorAll('details[data-ai-fold]').forEach(el => { el.open = aiSettingsOpen.has(el.dataset.aiFold); });
      after?.querySelectorAll('#account-new-ai,#account-new-name,[data-account-name]').forEach(el => { const value = aiSettingsInputs.get(aiSettingsInputKey(el)); if (value !== undefined) el.value = value; });
      const target = focus && (focus.id ? document.getElementById(focus.id) : [...(after?.querySelectorAll('[data-account-name]') || [])].find(el => aiSettingsInputKey(el) === focus.key));
      if (target && !target.disabled) { target.focus({ preventScroll: true }); if (focus.start !== null && typeof target.setSelectionRange === 'function') target.setSelectionRange(focus.start, focus.end); }
    }
  });
}
// ---- 設定（役割・モデル・思考） ----
let skillsResult = null, skillsError = '', skillsLoadingBox = null;
function skillsHtml() {
  if (skillsError) return UI.template`<p class="small" role="status">確認できませんでした：${esc(skillsError)}</p>`;
  if (!skillsResult) return UI.html('<p class="small" role="status">確認中…</p>');
  return ['claude', 'codex', 'agy', 'grok'].map(ai => {
    const row = skillsResult.ais[ai], items = row.items;
    const message = row.error ? UI.text('スキルの置き場所を読み取れませんでした。') : !row.found ? UI.text('検出できる置き場所がありません（使えないとは限りません）。') : !items.length ? UI.text('この置き場所にはスキルが見つかりませんでした。') : '';
    return UI.template`<details class="more" data-skills-ai="${ai}"><summary>${esc(AI_LABEL[ai])}（${items.length}）</summary>
      ${message ? UI.template`<p class="small">${esc(message)}</p>` : ''}
      ${items.length ? UI.template`<div class="tbl"><table><thead><tr><th scope="col">名前</th><th scope="col">用途</th></tr></thead><tbody>${items.map(item => UI.template`<tr><td>${esc(item.name)}${item.source === 'system' ? UI.html(' <span class="small">付属</span>') : ''}</td><td>${esc(item.description || UI.text('（説明なし）'))}</td></tr>`).join('')}</tbody></table></div>` : ''}
      ${row.limited ? UI.html('<p class="small">表示上限に達したため、一部のスキルは表示していません。</p>') : ''}</details>`;
  }).join('');
}
function drawSkills() {
  return preserveSettingsScroll(() => {
    const box = $('#skills-box'); if (!box || view.kind !== 'settings') return;
    const opened = new Set([...box.querySelectorAll('[data-skills-ai]')].filter(node => node.open).map(node => node.dataset.skillsAi));
    box.innerHTML = skillsHtml();
    box.querySelectorAll('[data-skills-ai]').forEach(node => { node.open = opened.has(node.dataset.skillsAi); });
    const button = $('#skills-check'); if (button) button.disabled = skillsLoadingBox === box;
  });
}
async function loadSkills(fresh = false) {
  const box = $('#skills-box'); if (view.kind !== 'settings' || !box || skillsLoadingBox === box) return;
  skillsLoadingBox = box; skillsError = ''; drawSkills();
  try {
    const result = await api('/api/skills' + (fresh ? '?fresh=1' : ''));
    if (view.kind !== 'settings' || $('#skills-box') !== box) return;
    skillsResult = result;
  } catch (error) { if (view.kind === 'settings' && $('#skills-box') === box) skillsError = error.message; }
  finally {
    if (skillsLoadingBox === box) skillsLoadingBox = null;
    if (view.kind === 'settings' && $('#skills-box') === box) drawSkills();
  }
}
let aiTools = null, aiToolsOperation = null, aiToolsError = '', aiToolsLoadingBox = null, aiToolsWatchTimer = null;
let aiToolsBusyCount = 0, aiBatchPending = false, aiBatchMessage = '';
const aiCheckPending = { claude: false, codex: false, agy: false, grok: false };
const aiToolPending = { claude: false, codex: false, agy: false, grok: false };
const aiToolMessage = { claude: '', codex: '', agy: '', grok: '' };
const aiToolMethod = method => ({ standalone: UI.text('単独インストール'), 'homebrew-cask': 'Homebrew', native: UI.text('公式インストール'), missing: UI.text('未導入'), unknown: UI.text('確認できません') }[method] || method || UI.text('不明'));
const aiToolErrorText = e => [e.message, e.reason && e.reason !== e.message ? e.reason : '', e.stage ? UI.template`段階：${e.stage}` : ''].filter(Boolean).join('。');
function drawAiTools() {
  return preserveSettingsScroll(() => {
    const box = $('#ai-tools'); if (!box) return;
    if (!aiTools) { box.textContent = aiToolsError || UI.text('確認中…'); return; }
    const opened = box.querySelector?.('details')?.open || false;
    const running = Math.max(aiToolsBusyCount, (state.chatting || []).length + state.sessions.filter(s => s.running).length);
    const targets = AIS.filter(ai => aiTools[ai]?.eligible && aiTools[ai]?.installed);
    const excluded = AIS.filter(ai => !targets.includes(ai));
    const busy = aiBatchPending || Boolean(aiToolsOperation) || AIS.some(ai => aiToolPending[ai]);
    const reason = aiToolsError || (busy ? UI.text('確認・更新中です…') : running ? UI.text('稼働中のCLIは飛ばし、ほかのCLIを更新できます。') : !targets.length ? UI.text('ログイン済みのCLIがありません。') : '');
    const modelText = status => ({ changed: UI.text('変更あり'), same: UI.text('変更なし'), first: UI.text('初回確認'), unknown: UI.text('未確認') }[status] || UI.text('未確認'));
    const excludedText = status => ({ 'not-installed': UI.text('未導入'), 'logged-out': UI.text('未ログイン'), api: UI.text('APIのログインは対象外です'), unknown: UI.text('ログイン状態を確認できませんでした') }[status] || UI.text('ログイン状態を確認できませんでした'));
    box.innerHTML = UI.template`<div class="ai-update-toolbar"><span class="small">ログイン済みを毎日確認します。</span><button class="btn" type="button" data-ai-update-all ${busy || aiToolsError ? 'disabled' : ''}>一括更新</button>${hubUpdateButton()}${restartControls()}</div>
      ${reason ? UI.template`<p class="ai-tool-result" role="status">${esc(reason)}</p>` : ''}
      ${excluded.filter(ai => aiTools[ai]?.notice).map(ai => UI.template`<p class="ai-tool-result" role="status">${esc(AI_LABEL[ai])}：${esc(aiTools[ai].notice)}</p>`).join('')}
      <div class="ai-update-columns small"><span>CLI</span><span>バージョン</span><span>確認日</span><span>モデル一覧</span></div>
      ${targets.map(ai => {
        const tool = aiTools[ai], check = tool.updateCheck;
        const notice = tool.notice || (check?.ok && check.available === true && check.applicable === false ? UI.text('この導入方法では、Hubから更新できません。導入時の方法で更新してください。') : '');
        const date = check?.ok ? check.checkedAt : check?.failedAt;
        const formatted = date && !Number.isNaN(Date.parse(date)) ? new Date(date).toLocaleString(UI.dateLocale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : UI.text('未確認');
        return UI.template`<div class="ai-update-entry" data-ai="${ai}"><div class="ai-update-row"><b>${esc(AI_LABEL[ai])}</b><span class="ai-update-version">${esc(tool.version || UI.text('未確認'))}${check?.ok && check.available === true ? UI.template` <span class="ai-update-change">→ ${esc(check.latestVersion)}</span>` : ''}</span><span class="ai-update-date small" title="${esc(date ? new Date(date).toLocaleString() : '')}"><span class="ai-update-date-label">確認 </span>${esc(formatted)}${check?.ok === false ? UI.text('（失敗）') : ''}</span><span class="ai-update-model small ${tool.modelsStatus === 'changed' ? 'ai-update-change' : ''}">${esc(modelText(tool.modelsStatus))}</span></div><div class="ai-tool-actions"><button type="button" class="btn plain" data-ai-check="${ai}" ${busy || aiCheckPending[ai] || tool.checking ? 'disabled' : ''}>更新を確認</button><button type="button" class="btn" data-ai-update="${ai}" ${busy || tool.busyCount || !check?.ok || !check.available || !check.applicable ? 'disabled' : ''}>更新</button>${tool.busyCount ? UI.template`<span class="small">このCLIが稼働中です</span>` : ''}</div>${notice ? UI.template`<p class="ai-tool-result" role="status">${esc(notice)}</p>` : ''}</div>`;
      }).join('')}
      <details class="more ai-update-details" ${opened ? 'open' : ''}><summary>${UI.template`詳細（対象外 ${excluded.length} 件）`}</summary>
      ${excluded.map(ai => UI.template`<p class="small">${esc(AI_LABEL[ai])}：${esc(excludedText(aiTools[ai]?.installed === false ? 'not-installed' : aiTools[ai]?.status))}${aiTools[ai]?.notice ? ` · ${esc(aiTools[ai].notice)}` : ''}${aiTools[ai]?.installed ? UI.template` <button type="button" class="btn plain" data-ai-check="${ai}" ${busy || aiCheckPending[ai] ? 'disabled' : ''}>更新を確認</button>` : ''}</p>`).join('')}
      ${targets.map(ai => {
        const tool = aiTools[ai], diff = tool.modelDiff;
        return UI.template`<p class="small">${esc(AI_LABEL[ai])} · ${esc(aiToolMethod(tool.method))} · ${esc(tool.source || UI.text('未確認'))}</p><p class="small">${esc((tool.models || []).map(m => m.label || m.id).join(' / '))}</p>${diff ? UI.template`<p class="small">${UI.template`追加：${esc(diff.added.join(' / ') || '—')} · 削除：${esc(diff.removed.join(' / ') || '—')} · 名称変更：${esc(diff.renamed.join(' / ') || '—')}`}</p>` : ''}${tool.modelCheckedAt ? UI.template`<p class="small">${UI.template`モデル確認：${esc(new Date(tool.modelCheckedAt).toLocaleString())}`}</p>` : ''}`;
      }).join('')}</details>
      <p class="ai-tool-result">毎日は確認のみ。一括更新時にも最新情報を確認します。</p>
      ${AIS.filter(ai => aiToolMessage[ai]).map(ai => UI.template`<p class="ai-tool-result" role="status">${esc(AI_LABEL[ai])}：${esc(aiToolMessage[ai])}</p>`).join('')}
      ${aiBatchMessage ? UI.template`<p class="ai-tool-result" role="status">${esc(aiBatchMessage)}</p>` : ''}`;
  });
}
function scheduleAiToolsWatch() {
  clearTimeout(aiToolsWatchTimer); aiToolsWatchTimer = null;
  if (view.kind !== 'settings' || document.hidden) return;
  aiToolsWatchTimer = setTimeout(() => {
    aiToolsWatchTimer = null;
    if (view.kind === 'settings' && !document.hidden) loadAiTools();
  }, aiToolsOperation ? 3000 : aiToolsBusyCount ? 10000 : 60000);
}
async function loadAiTools() {
  const box = $('#ai-tools'); if (!box || aiToolsLoadingBox === box) return;
  aiToolsLoadingBox = box;
  const wasOperating = Boolean(aiToolsOperation);
  try {
    const r = await api('/api/ai-tools');
    if ($('#ai-tools') !== box) return;
    aiTools = r.tools || {}; aiToolsOperation = r.operation || null; aiToolsBusyCount = r.busyCount || 0; aiToolsError = r.error || '';
    state.aiCliUpdate = { available: AIS.some(ai => r.tools?.[ai]?.eligible && r.tools[ai].installed && r.tools[ai].updateCheck?.ok && r.tools[ai].updateCheck.available === true && r.tools[ai].updateCheck.applicable === true), busyCount: aiToolsBusyCount };
    showVersion(state.version, state.latest);
    if (wasOperating && !aiToolsOperation && !AIS.some(a => aiToolPending[a])) {
      try { await refreshAiToolCatalog(); }
      catch (e) { aiToolsError = UI.template`モデル一覧を画面へ反映できませんでした：${aiToolErrorText(e)}`; }
    }
  } catch (e) { if ($('#ai-tools') === box) { aiTools = null; aiToolsError = aiToolErrorText(e); } }
  finally { if (aiToolsLoadingBox === box) aiToolsLoadingBox = null; if ($('#ai-tools') === box) { drawAiTools(); scheduleAiToolsWatch(); } }
}
function refreshRoleModelChoices() {
  return preserveSettingsScroll(() => {
    if (view.kind !== 'settings') return;
    document.querySelectorAll('select[data-r][data-f="model"]').forEach(el => {
      const slot = rolesDraft?.[+el.dataset.r]?.[el.dataset.k]; if (!slot) return;
      el.innerHTML = roleModelOptions(slot.ai,slot.model);
      el.value = slot.model;
    });
    const note = $('#model-catalog');
    if (note) note.textContent = UI.template`選べるモデル：Claude Code は ${(state.roles.models['claude-code'] || []).join(' / ')}、Codex は ${(state.roles.models.codex || []).join(' / ')}、Grok は ${(state.roles.models.grok || []).join(' / ')}（思考は中・高・極高・MAX）、Gemini（Agy CLI）は取得したモデル一覧から選択・思考「高」。思考は ${state.efforts.join(' → ')}。`;
  });
}
async function refreshAiToolCatalog() {
  const epoch = ++stateLoadEpoch;
  const next = await api('/api/state');
  if (epoch !== stateLoadEpoch || webchatSettingsPending || webchatSettingsSaving || accountSelectionSaving || taskFastSaving || accelerationSaving) return;
  adoptState(next);
  refreshRoleModelChoices();
  if (view.kind === 'settings') await loadCliModels(true);
}
function aiToolResultText(action, r) {
  const modelReport = result => {
    if (!result) return UI.text('モデル一覧の状態を確認できませんでした。');
    if (result.ok === false) return UI.template`モデル一覧の再取得に失敗しました：${result.error || UI.text('理由を確認できません')}。`;
    const unchanged = Boolean(result.unchanged);
    const added = !unchanged && typeof result.added === 'number' ? UI.template`（追加 ${result.added} 件）` : '';
    return `${unchanged ? UI.text('モデル一覧は前回の内容を使用しています') : UI.template`モデル一覧を再取得しました${added}`}。`
      + (result.source ? UI.template`取得元：${result.source}。` : '')
      + (result.warning ? UI.template`注意：${result.warning}。` : '');
  };
  if (action === 'models') return modelReport(r);
  if (r.state) return UI.template`更新結果：${({updated:UI.text('更新済み'),checked:UI.text('確認済み'),failed:UI.text('失敗'),unsupported:UI.text('未対応'),unverified:UI.text('版未確認'),busy:UI.text('稼働中')})[r.state] || r.state}。`;
  const before = r.beforeVersion || '', after = r.afterVersion || '';
  const base = r.verified === false ? UI.template`更新操作は終わりましたが、版を確認できませんでした${r.verifyError ? `：${r.verifyError}` : ''}。` : r.changed
    ? before && after ? UI.template`更新しました：${before} → ${after}。` : UI.template`更新しましたが、版を確認できませんでした。`
    : before || after ? UI.template`版は変わりませんでした（${after || before}）。` : UI.text('版の変化を確認できませんでした。');
  return base + modelReport(r.models);
}
async function runAiTool(ai, action) {
  if (action === 'check') {
    if (!AIS.includes(ai) || aiCheckPending[ai] || aiTools?.[ai]?.checking || aiTools?.[ai]?.installed === false) return;
    aiCheckPending[ai] = true; aiToolMessage[ai] = UI.text('更新情報を確認しています…'); drawAiTools();
    try { const r = await api('/api/ai-tools/check', { ai }); if (aiTools) aiTools[ai].updateCheck = r; aiToolMessage[ai] = r.available ? UI.text('更新があります。適用する時は別のボタンを押してください。') : UI.text('更新の確認が終わりました。'); }
    catch (e) { aiToolMessage[ai] = aiToolErrorText(e); }
    finally { aiCheckPending[ai] = false; await loadAiTools(); drawAiTools(); }
    return;
  }
  if (!AIS.includes(ai) || !['update', 'models'].includes(action) || AIS.some(a => aiToolPending[a]) || aiToolsOperation || aiTools?.[ai]?.updating || aiTools?.[ai]?.installed === false || (action === 'models' && aiTools?.[ai]?.modelRefreshAvailable === false)) return;
  if (action === 'update' && (!aiTools?.[ai]?.updateCheck?.available || aiTools?.[ai]?.busyCount)) return; // 確認は［更新を確認］で済んでいるので、そのまま適用する
  aiToolPending[ai] = true; aiToolsOperation = { ai, kind: action }; aiToolMessage[ai] = action === 'update' ? UI.text('更新を適用しています…') : UI.text('モデル一覧を確認しています…'); drawAiTools();
  try {
    const path = action === 'update' ? '/api/ai-tools/update' : '/api/ai-tools/models/refresh';
    const result = await api(path, { ai });
    aiToolMessage[ai] = aiToolResultText(action, result);
    try { await refreshAiToolCatalog(); }
    catch (e) { aiToolMessage[ai] += UI.template`画面のモデル一覧を更新できませんでした：${aiToolErrorText(e)}。`; }
  } catch (e) { aiToolMessage[ai] = UI.template`失敗しました：${aiToolErrorText(e)}`; }
  finally { aiToolPending[ai] = false; aiToolsOperation = null; await loadAiTools(); drawAiTools(); }
}
async function runAiUpdateAll() {
  if (aiBatchPending || aiToolsOperation || aiToolsError) return;
  aiBatchPending = true; aiToolsOperation = { kind: 'update-all' }; aiBatchMessage = ''; drawAiTools();
  try {
    const result = await api('/api/ai-tools/update-all', {});
    const counts = key => (result.results || []).filter(r => r.state === key).length;
    aiBatchMessage = UI.template`一括更新が終わりました。更新 ${counts('updated')} 件、失敗 ${counts('failed')} 件、版未確認 ${counts('unverified')} 件、未対応 ${counts('unsupported')} 件、稼働中 ${counts('busy')} 件。`;
    await refreshAiToolCatalog();
  } catch (e) { aiBatchMessage = aiToolErrorText(e); }
  finally { aiBatchPending = false; aiToolsOperation = null; await loadAiTools(); drawAiTools(); }
}
document.addEventListener('click', e => {
  if (e.target.closest?.('[data-ai-update-all]')) { void runAiUpdateAll(); return; }
  const ai = e.target.dataset.aiCheck || e.target.dataset.aiUpdate || e.target.dataset.aiModelRefresh;
  if (ai) runAiTool(ai, e.target.dataset.aiCheck ? 'check' : e.target.dataset.aiUpdate ? 'update' : 'models');
});
// モデル一覧の並べ替え。役割や会話の選択値には触れない。
let modelViewSaving = false, modelOrderDrag = '', modelOrderNotice = '';
function modelOrderHtml() {
  const ids = orderedModels();
  return UI.template`<div class="model-order-rows">${ids.map((id, i) => {
    const [ai, model] = id.split('|'), label = UI.template`${AI_LABEL[ai === 'claude-code' ? 'claude' : ai]}・${model}`;
    return UI.template`<div class="model-order-row" data-mo-row="${esc(id)}">
      <span class="model-grip" draggable="${!modelViewSaving}" data-mo-grip="${esc(id)}" aria-hidden="true" title="ドラッグして順番を変える">⋮⋮</span>
      <label class="chk"><input type="checkbox" data-mv-ai="${ai}" data-mv="${esc(model)}" ${((state.hiddenModels || {})[ai] || []).includes(model) ? '' : 'checked'} ${modelViewSaving ? 'disabled' : ''}> <span>${esc(label)}</span></label>
      <button class="btn plain sm" type="button" data-mo-up="${esc(id)}" aria-label="${esc(label)} を上へ" ${modelViewSaving || i === 0 ? 'disabled' : ''}>↑</button>
      <button class="btn plain sm" type="button" data-mo-down="${esc(id)}" aria-label="${esc(label)} を下へ" ${modelViewSaving || i === ids.length - 1 ? 'disabled' : ''}>↓</button>
    </div>`;
  }).join('') || UI.html('<span class="small">まだありません</span>')}</div>
  <div class="acts"><button class="btn plain sm" id="model-order-reset" type="button" ${modelViewSaving || !ModelOrder.clean(state.modelOrder).length ? 'disabled' : ''}>元の順に戻す</button></div>
  <p class="small" id="model-order-status" role="status">${esc(modelViewSaving ? UI.text('保存中…') : modelOrderNotice)}</p>`;
}
function drawModelOrder(focus) {
  return preserveSettingsScroll(() => {
    const box = $('#model-order-list');
    if (view.kind !== 'settings' || !box) return;
    box.innerHTML = modelOrderHtml();
    if (focus) {
      const id = typeof focus === 'string' ? focus : focus.id;
      const controls = [...box.querySelectorAll('[data-mo-up],[data-mo-down],[data-mv]')].filter(x => !x.disabled && (x.dataset.moUp === id || x.dataset.moDown === id || `${x.dataset.mvAi}|${x.dataset.mv}` === id));
      const button = controls.find(x => focus.checkbox ? x.dataset.mv !== undefined : focus.direction === 'down' ? x.dataset.moDown === id : x.dataset.moUp === id)
        || controls.find(x => x.dataset.moUp || x.dataset.moDown) || controls[0];
      button?.focus({ preventScroll: true });
    }
  });
}
function syncRoleModelOrder() {
  return preserveSettingsScroll(() => {
    if (view.kind !== 'settings') return;
    document.querySelectorAll('select[data-f="model"]').forEach(select => {
      const spec = rolesDraft?.[select.dataset.r]?.[select.dataset.k];
      if (!spec) return;
      const value = spec.model;
      select.innerHTML = roleModelOptions(spec.ai,value);
      select.value = value;
    });
  });
}
async function saveModelOrder(visible, focus, reset = false) {
  if (modelViewSaving) return;
  const before = orderedModels(), previous = state.modelOrder;
  const next = reset ? [] : ModelOrder.retainMissing(previous, visible);
  ++stateLoadEpoch; modelViewSaving = true; modelOrderNotice = ''; state.modelOrder = next; drawModelOrder();
  try {
    const r = await api('/api/models/order', { order: next, before });
    state.modelOrder = r.modelOrder; state.hiddenModels = r.hiddenModels;
    modelOrderNotice = UI.text('並び順を保存しました'); toast(modelOrderNotice);
    syncRoleModelOrder(); drawInitialPick();
  } catch (e) {
    state.modelOrder = previous;
    modelOrderNotice = UI.template`並び順を保存できませんでした：${e.message}`; toast(modelOrderNotice);
    // 他の画面が先に保存した順を読み直す。役割の入力欄は作り直さない。
    if (e.status === 409) { try { const fresh = await fetchState(); if (fresh) { state.modelOrder = fresh.modelOrder; state.hiddenModels = fresh.hiddenModels; syncRoleModelOrder(); } } catch (_) {} }
  } finally { ++stateLoadEpoch; modelViewSaving = false; drawModelOrder(focus); }
}
async function toggleModelVisibility(el) {
  if (modelViewSaving) { el.checked = !el.checked; return; }
  const { mvAi: ai, mv: model } = el.dataset, checked = el.checked;
  ++stateLoadEpoch; modelViewSaving = true; modelOrderNotice = ''; drawModelOrder();
  try {
    const r = await api('/api/models/hidden', { ai, model, hidden: !checked });
    state.hiddenModels = r.hiddenModels; state.modelOrder = r.modelOrder;
    syncRoleModelOrder(); drawInitialPick();
    toast(checked ? UI.template`${model} を出します` : UI.template`${model} を隠しました`);
  } catch (e) { modelOrderNotice = UI.template`表示の設定を保存できませんでした：${e.message}`; toast(modelOrderNotice); }
  finally { ++stateLoadEpoch; modelViewSaving = false; drawModelOrder({ id: `${ai}|${model}`, checkbox: true }); }
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-mo-up],[data-mo-down],#model-order-reset');
  if (!b || b.disabled || modelViewSaving) return;
  if (b.id === 'model-order-reset') {
    if (confirm(UI.text('モデルの並びを元の順（AI ごと・取り直した順）に戻しますか？ 出す・隠すの設定はそのままです。'))) saveModelOrder([], '', true);
    return;
  }
  const id = b.dataset.moUp || b.dataset.moDown, ids = orderedModels(), i = ids.indexOf(id), j = i + (b.dataset.moUp ? -1 : 1);
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i],ids[j]] = [ids[j],ids[i]]; saveModelOrder(ids, { id, direction: b.dataset.moUp ? 'up' : 'down' });
});
document.addEventListener('dragstart', e => {
  const grip = e.target.closest('[data-mo-grip]');
  if (!grip) return;
  if (modelViewSaving || window.matchMedia?.('(max-width:720px)').matches) { e.preventDefault(); return; }
  modelOrderDrag = grip.dataset.moGrip; e.dataTransfer.setData('text/plain', modelOrderDrag); e.dataTransfer.effectAllowed = 'move';
});
function clearModelDrop() { document.querySelectorAll('.model-order-row').forEach(x => x.classList.remove('model-drop-before','model-drop-after')); }
document.addEventListener('dragover', e => {
  const row = e.target.closest('[data-mo-row]');
  if (!modelOrderDrag || modelViewSaving || !row) return;
  e.preventDefault(); e.stopImmediatePropagation(); e.dataTransfer.dropEffect = 'move';
  clearModelDrop(); row.classList.add(e.clientY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2 ? 'model-drop-before' : 'model-drop-after');
}, true);
document.addEventListener('drop', e => {
  const row = e.target.closest('[data-mo-row]'), id = modelOrderDrag; modelOrderDrag = ''; clearModelDrop();
  if (!id || modelViewSaving || !row) return;
  e.preventDefault(); e.stopImmediatePropagation(); const before = orderedModels(), ids = before.filter(x => x !== id);
  const i = ids.indexOf(row.dataset.moRow); if (i < 0) return;
  const after = e.clientY >= row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
  ids.splice(i + (after ? 1 : 0), 0, id);
  if (JSON.stringify(ids) !== JSON.stringify(before)) saveModelOrder(ids, id);
}, true);
document.addEventListener('dragend', () => { modelOrderDrag = ''; clearModelDrop(); });
let specialModeSaving = false;
function specialModeHtml() {
  const mode = state.specialMode || { enabled: false, ai: 'codex' }, disabled = specialModeSaving ? 'disabled' : '';
  return UI.template`<label class="chk"><input id="special-mode-on" type="checkbox" ${mode.enabled ? 'checked' : ''} ${disabled}> 使う</label>
    <select id="special-mode-ai" aria-label="特殊モードのAI" ${disabled}>${['claude', 'codex'].map(ai => UI.template`<option value="${ai}" ${mode.ai === ai ? 'selected' : ''}>${AI_LABEL[ai]}</option>`).join('')}</select>
    <span class="small" role="status">${specialModeSaving ? UI.text('保存中…') : UI.text('すぐ保存・次の依頼から')}</span>`;
}
function drawSpecialMode() { preserveSettingsScroll(() => { const box = $('#special-mode'); if (box && view.kind === 'settings') box.innerHTML = specialModeHtml(); }); }
async function saveSpecialMode(next) {
  if (specialModeSaving) return;
  const previous = state.specialMode;
  ++stateLoadEpoch; specialModeSaving = true; state.specialMode = next; drawSpecialMode();
  try { const r = await api('/api/special-mode', next); state.specialMode = r.specialMode; syncSpecialModeChange(); }
  catch (e) { state.specialMode = previous; toast(e.message); }
  finally { ++stateLoadEpoch; specialModeSaving = false; drawSpecialMode(); }
}
document.addEventListener('change', e => {
  if (!['special-mode-on', 'special-mode-ai'].includes(e.target.id)) return;
  saveSpecialMode({ enabled: $('#special-mode-on').checked, ai: $('#special-mode-ai').value });
});
let initialPickSaving = false;
function initialPickHtml() {
  const pick = initialPick(), key = AI_KEY[pick.ai];
  const missing = !(state.roles.models[key] || []).includes(pick.model), unavailable = missing || state.initialPickError;
  const disabled = initialPickSaving ? 'disabled' : '';
  return UI.template`<div class="cfg">
    <select data-initial="ai" aria-label="新規開始のAI" ${disabled}>${['claude', 'codex'].map(ai => UI.template`<option value="${ai}" ${pick.ai === ai ? 'selected' : ''}>${AI_LABEL[ai]}</option>`).join('')}</select>
    <select data-initial="model" aria-label="新規開始のモデル" ${disabled}>${missing ? UI.template`<option selected disabled value="${esc(pick.model)}">${esc(pick.model)}（利用不可）</option>` : ''}${shownModels(key, pick.model).map(m => UI.template`<option ${m === pick.model ? 'selected' : ''}>${esc(m)}${m === pick.model && state.initialPickError ? UI.text('（利用不可）') : ''}</option>`).join('')}</select>
    <select data-initial="effort" aria-label="新規開始の思考" ${disabled}>${state.efforts.map(e => UI.template`<option ${e === pick.effort ? 'selected' : ''}${UI.valueAttribute(e)}>${esc(UI.label(e))}</option>`).join('')}</select>
    </div><div class="acts"><button type="button" class="btn plain" data-initial-reset ${disabled}>初期値に戻す</button></div>
    <p class="small" role="status">${initialPickSaving ? UI.text('保存中…') : unavailable ? UI.template`選んだモデルは利用不可です。モデルを選び直してください。${esc(state.initialPickError || '')}` : UI.text('変更するとすぐ保存します。')}</p>`;
}
function drawInitialPick() {
  return preserveSettingsScroll(() => {
    if (view.kind === 'settings') $('#initial-pick').innerHTML = initialPickHtml();
  });
}
async function saveInitialPick(next) {
  if (initialPickSaving) return;
  const previous = state.initialPick, previousError = state.initialPickError, previousPick = initialPick();
  ++stateLoadEpoch; initialPickSaving = true; state.initialPick = next; state.initialPickError = ''; drawInitialPick();
  try {
    const r = await api('/api/models/initial', next);
    state.initialPick = r.initialPick;
    // 保存した下書き・前回選択・入力中の内容を残し、未入力の初期値だけ更新する。
    for (const [id, draft] of quickDrafts) {
      let saved = true;
      try { saved = Boolean(localStorage.getItem('hub-start-' + id)); } catch (_) { /* 読めなければ保持 */ }
      if (!saved && !proj(id)?.startSpec && !draft.text && !draft.images.length &&
          ['ai', 'model', 'effort'].every(key => draft[key] === previousPick[key])) quickDrafts.delete(id);
    }
    toast(UI.text('新しく始めるときのAIを保存しました'));
  } catch (e) { state.initialPick = previous; state.initialPickError = previousError; toast(UI.template`初期AIを保存できませんでした：${e.message}`); }
  finally { ++stateLoadEpoch; initialPickSaving = false; drawInitialPick(); }
}
document.addEventListener('click', e => {
  const button = e.target.closest('[data-initial-reset]');
  if (button && !button.disabled) void saveInitialPick({ ...INITIAL_PICK });
});
let phoneLabelsSaving = false, phoneLabelsNotice = '', renderedPhoneKey = '';
const phoneLabelDrafts = new Map(), phoneLabelQueue = [], phoneLabelErrors = new Map();
let phoneLabelActive = null;
function phoneLabelStatus() {
  const failures = [...phoneLabelErrors.values()].join(' ／ ');
  return failures ? `${phoneLabelsSaving ? UI.text('保存中… ') : ''}${failures}` : phoneLabelsSaving ? UI.text('保存中…') : phoneLabelsNotice;
}
function phoneLabelMode() {
  return [...phoneLabelQueue].reverse().find(spec => spec.labels)?.labels || phoneLabelActive?.labels || state.phoneLabels?.labels || 'short';
}
const phoneSettingsKey = () => JSON.stringify([state.phoneLabels, orderedModels()]);
function phoneLabelsHtml() {
  const phone = state.phoneLabels || { labels: 'short', names: {} }, full = phoneLabelMode() === 'full';
  return UI.template`<div class="phone-label-mode" role="group" aria-label="AI一覧の名前">
    <label><input type="radio" name="phone-label-mode" data-phone-mode="short" ${full ? '' : 'checked'}> 短い名前</label>
    <label><input type="radio" name="phone-label-mode" data-phone-mode="full" ${full ? 'checked' : ''}> AI名・モデル名（PCと同じ）</label>
  </div><p class="small">名前を入力するとスマホの一覧に使います。空欄で元の短い名前に戻ります（24字以内・改行なし）。</p>
  <div class="phone-label-rows">${[...orderedModels(), 'chatgpt|auto'].map(key => {
    const [k, model] = key.split('|'), ai = k === 'claude-code' ? 'claude' : k;
    const label = ai === 'chatgpt' ? 'ChatGPT' : UI.template`${AI_LABEL[ai]}・${model}`;
    return UI.template`<label class="phone-label-row"><span>${esc(label)}</span><input type="text" data-phone-name="${esc(key)}" maxlength="24" aria-label="${esc(label)} のスマホ表示名" placeholder="${esc(shortModelLabel(ai, model))}" value="${esc(phoneLabelDrafts.has(key) ? phoneLabelDrafts.get(key) : phone.names?.[key] || '')}" ${full ? 'disabled' : ''}></label>`;
  }).join('')}</div><p class="small" role="status" id="phone-label-status">${esc(phoneLabelStatus())}</p>`;
}
function drawPhoneLabels() {
  return preserveSettingsScroll(() => {
    const box = $('#phone-labels');
    if (view.kind !== 'settings' || !box) return;
    const inputs = [...box.querySelectorAll('[data-phone-name]')], keys = [...orderedModels(), 'chatgpt|auto'];
    if (JSON.stringify(inputs.map(el => el.dataset.phoneName)) !== JSON.stringify(keys)) {
      // 候補が変わった時だけ組み直す。入力・保存中は次のpollまで待つ。
      if (inputs.length && (phoneLabelsSaving || box.contains(document.activeElement))) return;
      box.innerHTML = phoneLabelsHtml();
    } else {
      const full = phoneLabelMode() === 'full';
      for (const el of box.querySelectorAll('[data-phone-mode]')) el.checked = el.dataset.phoneMode === (full ? 'full' : 'short');
      for (const el of inputs) {
        el.disabled = full;
        if (el !== document.activeElement && !phoneLabelDrafts.has(el.dataset.phoneName)) el.value = state.phoneLabels?.names?.[el.dataset.phoneName] || '';
      }
      const status = box.querySelector('#phone-label-status');
      if (status) status.textContent = phoneLabelStatus();
    }
    renderedPhoneKey = phoneSettingsKey();
  });
}
async function savePhoneLabels(spec) {
  if (spec.key) phoneLabelDrafts.set(spec.key, spec.name);
  phoneLabelQueue.push(spec);
  if (phoneLabelsSaving) { drawPhoneLabels(); return; }
  ++stateLoadEpoch; phoneLabelsSaving = true; phoneLabelsNotice = '';
  try {
    while (phoneLabelQueue.length) {
      phoneLabelActive = phoneLabelQueue.shift(); drawPhoneLabels();
      try {
        const r = await api('/api/models/phone', phoneLabelActive);
        state.phoneLabels = r.phoneLabels; syncChatPhoneLabels();
        if (phoneLabelActive.key && phoneLabelDrafts.get(phoneLabelActive.key) === phoneLabelActive.name) phoneLabelDrafts.delete(phoneLabelActive.key);
        phoneLabelErrors.delete(phoneLabelActive.key || 'mode');
        phoneLabelsNotice = UI.text('スマホの表示を保存しました');
        toast(phoneLabelErrors.size ? [...phoneLabelErrors.values()].join(' ／ ') : phoneLabelsNotice);
      } catch (e) {
        const [key, model] = (phoneLabelActive.key || '').split('|');
        const item = key ? UI.template`${shortModelLabel(key === 'claude-code' ? 'claude' : key, model)} の名前` : UI.text('AI一覧の名前の表示方法');
        phoneLabelErrors.set(phoneLabelActive.key || 'mode', UI.template`${item}は未保存です。保存できませんでした：${e.message}`);
        toast([...phoneLabelErrors.values()].join(' ／ '));
      }
      finally { phoneLabelActive = null; }
    }
  } finally { ++stateLoadEpoch; phoneLabelsSaving = false; drawPhoneLabels(); }
}
document.addEventListener('input', e => {
  if (e.target.dataset.phoneName) phoneLabelDrafts.set(e.target.dataset.phoneName, e.target.value);
});
document.addEventListener('change', e => {
  const el = e.target;
  if (el.disabled) return;
  if (el.dataset.phoneMode) void savePhoneLabels({ labels: el.dataset.phoneMode });
  if (el.dataset.phoneName) void savePhoneLabels({ key: el.dataset.phoneName, name: el.value });
});
// AIアカウント：選択は台帳で共有し、送信時にも明示して待ち順へ固定する。
let accountSelectionSaving = 0, accountOperation = false;
const accountSelectionsPending = new Set();
let accountStatusRows = null;
let accountCheckedAt = '', accountCheckPromise = null, accountAutoChecked = false, accountCheckError = '';
function roleAiAvailability(ai) {
  if (ai === '人') return '';
  const rows = (accountStatusRows || state.accounts || []).filter(r => r.ai === (ai === 'claude-code' ? 'claude' : ai));
  if ((ai === 'agy' || ai === 'grok') && aiUnavailable(ai)) return rows.some(r => r.status === 'api') ? UI.text('API認証（対象外）') : rows.some(r => r.status === 'not-installed') ? UI.text('未導入') : UI.text('利用を確認できません');
  if (rows.some(r => r.status === 'logged-in')) return '';
  if (rows.some(r => r.status === 'api')) return UI.text('API認証（対象外）');
  if (rows.some(r => r.status === 'not-installed')) return UI.text('未導入');
  return rows.length && rows.every(r => r.status === 'logged-out') ? UI.text('未ログイン') : UI.text('確認できません');
}
function roleAiOptions(selected) {
  return ['claude-code', 'codex', 'agy', 'grok', '人'].map(ai => {
    const reason = roleAiAvailability(ai), label = ai === 'claude-code' ? 'Claude Code' : ai === 'agy' ? 'Gemini（Agy CLI）' : ai === '人' ? UI.text('あなた') : AI_LABEL[ai];
    return UI.template`<option value="${ai}" ${selected === ai ? 'selected' : ''} ${reason ? 'disabled' : ''}>${label}${reason ? '（' + reason + '）' : ''}</option>`;
  }).join('');
}
function syncRoleAccountChoices() {
  if (view.kind !== 'settings') return;
  document.querySelectorAll('select[data-r][data-f="ai"]').forEach(el => {
    const slot = rolesDraft?.[+el.dataset.r]?.[el.dataset.k]; if (!slot) return;
    el.innerHTML = roleAiOptions(slot.ai); el.value = slot.ai;
  });
  const note = $('#role-account-status');
  if (note) note.textContent = accountCheckPromise ? UI.text('ログイン状態を確認中…') : accountCheckError || UI.template`ログイン済みの AI だけ選べます${accountCheckedAt ? UI.template`（${accountCheckedAt} に確認）` : ''}`;
  const button = $('#role-account-check'); if (button) button.disabled = Boolean(accountCheckPromise);
}
async function checkRoleAccounts() {
  if (accountCheckPromise) return accountCheckPromise;
  accountAutoChecked = true; accountCheckError = '';
  accountCheckPromise = (async () => {
    try {
      const result = await api('/api/accounts?status=1', undefined, { 'X-Hub': '1' });
      accountStatusRows = result.accounts; state.accounts = result.accounts;
      adoptAgyCatalog(result); refreshRoleModelChoices();
      accountCheckedAt = new Date().toLocaleTimeString(UI.dateLocale, { hour: '2-digit', minute: '2-digit' });
    } catch (e) { accountCheckError = UI.text('ログイン状態を確認できませんでした：') + e.message; throw e; }
    finally { accountCheckPromise = null; syncRoleAccountChoices(); drawAccountSettings(); }
  })();
  syncRoleAccountChoices(); return accountCheckPromise;
}
function autoCheckRoleAccounts() {
  if (settingsTab === 'ai' && !accountAutoChecked && !accountStatusRows) checkRoleAccounts().catch(() => {});
}
function accountOptions(ai, selected) {
  const rows = (state.accounts || []).filter(r => r.ai === ai);
  const missing = selected !== 'default' && !rows.some(r => r.id === selected);
  return (missing ? UI.template`<option value="${esc(selected)}" selected disabled>削除済み（選び直してください）</option>` : '') + rows.map(r => UI.template`<option value="${esc(r.id)}" ${r.id === selected ? 'selected' : ''}>${esc(UI.label(r.name))}</option>`).join('');
}
function taskAccountSelect(p, t, ai, chat = false) {
  const rows = (state.accounts || []).filter(r => r.ai === ai), selected = t.accounts?.[ai] || 'default';
  const hidden = rows.length < 2 && selected === 'default';
  return UI.template`<label class="account-pick small" ${hidden ? 'hidden' : ''}>${chat ? UI.text('アカウント') : UI.template`${esc(AI_LABEL[ai])}のアカウント`} <select ${chat ? 'id="chat-account"' : ''} data-task-account data-p="${esc(p.id)}" data-t="${esc(t.id)}" data-ai="${esc(ai)}" aria-label="${UI.template`${esc(AI_LABEL[ai] || '')}のアカウント`}">${accountOptions(ai, selected)}</select></label>`;
}
const taskFastPending = new Set();
let taskFastSaving = 0;
function taskFastSelect(p, t, ai) {
  if (ai !== 'codex' || !state.acceleration?.codexAllowed) return '';
  const on = t.codexFast === true, pending = taskFastPending.has(JSON.stringify([p.id, t.id]));
  return UI.template`<label class="fast-pick small ${on ? 'danger' : ''}"><input type="checkbox" data-task-fast data-p="${esc(p.id)}" data-t="${esc(t.id)}" ${on ? 'checked' : ''} ${pending ? 'disabled' : ''}> <span>${on ? UI.text('加速ON（Fast）') : UI.text('加速（Fast）')}</span></label>`;
}
function syncTaskFastPickers() {
  if (!state) return;
  document.querySelectorAll('[data-task-fast]').forEach(el => {
    const t = taskOf(proj(el.dataset.p), el.dataset.t); if (!t) return;
    const pending = taskFastPending.has(JSON.stringify([el.dataset.p, el.dataset.t]));
    el.disabled = pending; if (!pending) el.checked = t.codexFast === true;
    const label = el.closest('.fast-pick');
    label.hidden = !state.acceleration?.codexAllowed;
    label.classList.toggle('danger', el.checked);
    label.querySelector('span').textContent = el.checked ? UI.text('加速ON（Fast）') : UI.text('加速（Fast）');
  });
  // 別端末で利用許可が変わった時も、入力欄を作り直さず選択欄だけ同期する。
  const box = $('#chat-fast-box');
  if (box && !box.querySelector('[data-task-fast]') && view.kind === 'work') {
    const p = proj(view.project), t = p && taskOf(p, view.task);
    if (t) box.innerHTML = taskFastSelect(p, t, $('#chat-ai')?.value.split('|')[0]);
  }
  document.querySelectorAll('[data-term-fast-box]').forEach(box => {
    const p = proj(box.dataset.p), t = p && taskOf(p, box.dataset.t);
    if (t && !box.querySelector('[data-task-fast]')) box.innerHTML = taskFastSelect(p, t, 'codex');
  });
}
async function saveTaskFast(el) {
  const { p: project, t: task } = el.dataset, key = JSON.stringify([project, task]);
  const previous = taskOf(proj(project), task)?.codexFast === true, on = el.checked;
  if (taskFastPending.has(key) || el.disabled) { el.checked = previous; return; }
  taskFastPending.add(key); taskFastSaving++; ++stateLoadEpoch;
  el.disabled = true; syncTaskFastPickers();
  try {
    const saved = await api('/api/acceleration/task', { project, task, on });
    const current = taskOf(proj(project), task); if (current) current.codexFast = saved.codexFast === true;
    toast(UI.template`この作業のCodexを加速${saved.codexFast ? 'ON' : 'OFF'}にしました（次の会話・起動から）`);
  } catch (err) { el.checked = previous; toast(err.message); }
  finally { ++stateLoadEpoch; taskFastPending.delete(key); taskFastSaving--; el.disabled = false; syncTaskFastPickers(); }
}
function drawChatAccount(p, t) {
  const box = $('#chat-account-box'); if (!box) return;
  t = taskOf(proj(p.id), t.id) || t;
  const ai = $('#chat-ai').value.split('|')[0];
  box.innerHTML = ['codex', 'claude', 'grok'].includes(ai) ? taskAccountSelect(p, t, ai, true) : '';
  const fastBox = $('#chat-fast-box'); if (fastBox) fastBox.innerHTML = taskFastSelect(p, t, ai);
}
function syncAccountPickers() {
  if (!state || accountSelectionSaving || taskFastSaving || accelerationSaving) return;
  const speed = $('#codex-fast');
  if (speed && state.acceleration && speed.dataset.saved !== String(state.acceleration.codexAllowed === true)) renderAcceleration(state.acceleration);
  syncTaskFastPickers();
  document.querySelectorAll('[data-task-account]').forEach(el => {
    const t = taskOf(proj(el.dataset.p), el.dataset.t), ai = el.dataset.ai;
    if (!t) return;
    const selected = t.accounts?.[ai] || 'default', rows = (state.accounts || []).filter(r => r.ai === ai);
    const key = JSON.stringify([selected, rows.map(r => [r.id, r.name])]);
    if (el.dataset.accountsKey !== key) { el.innerHTML = accountOptions(ai, selected); el.dataset.accountsKey = key; }
    el.value = selected;
    const label = el.closest?.('.account-pick'); if (label) label.hidden = rows.length < 2 && selected === 'default';
  });
  if (typeof usageContextChanged === 'function') usageContextChanged();
}
async function saveTaskAccount(el) {
  if (el.disabled) return;
  const { p: project, t: task, ai } = el.dataset, id = el.value;
  const t = taskOf(proj(project), task), previous = t?.accounts?.[ai] || 'default';
  const key = JSON.stringify([project, task, ai]);
  if (accountSelectionsPending.has(key)) { el.value = previous; toast(UI.text('アカウントの選択を保存中です')); return; }
  accountSelectionsPending.add(key);
  el.disabled = true; accountSelectionSaving++;
  stateLoadEpoch++;
  try {
    const r = await api('/api/accounts/select', { project, task, ai, id });
    // 他AIの保存応答は古い選択を含み得るので、保存したAIだけ反映する。
    const current = taskOf(proj(project), task);
    if (current) current.accounts = { ...current.accounts, [ai]: r.accounts[ai] };
    toast(UI.text('アカウントを選びました。作業中・順番待ちの指示は元のアカウントで続きます'));
    if (typeof usageContextChanged === 'function') usageContextChanged();
  } catch (e) { el.value = previous; toast(e.message); }
  finally {
    ++stateLoadEpoch; // 保存中に始まった取得も、完了後に選択を戻せない。
    accountSelectionsPending.delete(key); accountSelectionSaving--; el.disabled = false;
    syncAccountPickers();
  }
}
let shellRebuilding = false, shellRestartNeeded = false;
function shellWarningHtml() {
  if (!IN_APP) return '';
  if (shellRestartNeeded) return UI.template`<p role="status">アプリを終了して開き直してください</p>`;
  if (!state.appShell?.stale) return '';
  return UI.template`<p role="status">${state.appShell.appVersion ? UI.template`アプリ（Project Hub.app）が古い版 v${esc(state.appShell.appVersion)} です。ファイルの受け渡しなどの機能が動かない可能性があります` : UI.text('アプリ（Project Hub.app）の版を確認できません。ファイルの受け渡しなどの機能が動かない可能性があります')} <button class="btn plain sm" type="button" data-shell-rebuild ${shellRebuilding || state.appShell.rebuilding ? 'disabled' : ''}>${shellRebuilding || state.appShell.rebuilding ? UI.text('アプリを作り直しています') : UI.text('アプリを作り直す')}</button></p>`;
}
function drawShellAlerts() {
  const html = shellWarningHtml();
  for (const selector of ['#app-shell-alert', '#chatgpt-shell-alert']) {
    const box = $(selector); if (box) { box.hidden = !html; box.innerHTML = html; }
  }
}
document.addEventListener('click', async e => {
  const button = e.target.closest('[data-shell-rebuild]'); if (!button || button.disabled || shellRebuilding) return;
  shellRebuilding = true; drawShellAlerts();
  try {
    await api('/api/app/rebuild', {}); shellRestartNeeded = true;
    toast(UI.text('アプリを終了して開き直してください'));
  } catch (error) { toast(error.message); }
  finally { shellRebuilding = false; drawShellAlerts(); }
});
function webchatReady(t) { const s=state.webchat; return Boolean(s?.enabled && s.location && !s.journalError && !t?.webchatReason); }
function webchatNoticeHtml(t, selected) {
  if (!selected || webchatReady(t)) return '';
  const reason=t.webchatReason, setup=!reason || ['webchat_disabled','webchat_setup_required'].includes(reason);
  const settings=setup || ['webchat_login_required','webchat_login_unconfirmed','webchat_remote_login_unconfirmed'].includes(reason);
  return UI.template`<p class="small" role="status">${esc(setup?UI.text('ChatGPT（Chat／Pro）は未設定です。設定で外部WebChatMCPの場所と［自動Chatを使う］を確認してください。'):webchatError(reason))}${settings?UI.html(' <button type="button" class="btn plain sm" data-go="settings">設定</button>'):''}</p>`;
}
function syncChatWebchatAvailability() {
  if (view.kind !== 'work') return;
  const t=taskOf(proj(view.project),view.task), select=$('#chat-ai');
  if (!t || !select) return;
  const option=[...(select.options || [])].find(o=>o.value==='chatgpt|auto');
  if (option) option.disabled=!webchatReady(t);
  const notice=$('#webchat-notice');
  if (notice) {
    const html=webchatNoticeHtml(t,select.value==='chatgpt|auto');
    if (notice.innerHTML!==html) notice.innerHTML=html;
  }
}
function webchatError(code) {
  if (code === 'webchat_location_required') return UI.text('WebChatMCPの場所が空欄です。別途導入したフォルダの絶対パスを入力してください。薄い表示は入力例です');
  if (code === 'webchat_location_absolute') return UI.text('WebChatMCPの場所は「/」から始まるフォルダの絶対パスで入力してください');
  if (code === 'webchat_not_installed') return UI.text('指定フォルダにWebChatMCPの実行ファイルがありません。導入・ビルドを確認してください。保存だけでは導入されません');
  if (code === 'webchat_remote_browser_not_installed') return UI.text('外部ソフト用のChromiumが見つかりません。ブラウザの導入先を確認してください');
  if (code === 'webchat_remote_browser_profile_busy') return UI.text('自動Chat用のブラウザが別の処理で使用中です。終了を待ってください');
  if (['webchat_remote_navigation_failed', 'webchat_remote_navigation_timeout', 'webchat_remote_page_not_ready'].includes(code)) return UI.text('ChatGPTの画面を読み込めません。接続とブラウザ画面を確認してください。送信は繰り返さないでください');
  if (code === 'webchat_remote_model_menu_unavailable') return UI.text('モデル一覧を取得できません。モデルを指定する場合はChatGPTの画面を確認してください');
  if (code === 'webchat_remote_challenge_required') return UI.text('人間確認の画面で停止しています。ログイン状態は確認できません。ブラウザで本人による確認が必要です');
  if (['webchat_start_failed', 'webchat_disconnected', 'webchat_tools_missing', 'webchat_invalid_mcp'].includes(code)) return UI.text('外部WebChatMCPへ接続できません。導入したソフト・依存ソフト・対応版を確認してください');
  if (code === 'webchat_logout_unconfirmed') return UI.text('ログアウトを確認できません。ChatGPTの画面を確認してください');
  if (code === 'webchat_logout_unavailable') return UI.text('このWebChatMCPはログアウトに対応していません');
  if (code === 'webchat_login_required') return UI.text('ログインを確認できません。設定でログインしてください');
  if (['webchat_login_unconfirmed', 'webchat_remote_login_unconfirmed'].includes(code)) return UI.text('ログイン状態を判定できないため送信前に停止しました。設定で状態を確認してください');
  if (['webchat_temporary_chat_unconfirmed', 'webchat_remote_temporary_chat_unconfirmed'].includes(code)) return UI.text('一時チャットを確認できないため送信前に停止しました。ChatGPTの画面を確認してください');
  if (code === 'webchat_model_unavailable') return UI.text('指定モデル・思考を確認できません。別のモデルには切り替えません');
  if (code === 'webchat_selection_unconfirmed') return UI.text('送信後の状態を確認できません。自動再送はしません');
  if (code === 'webchat_disabled' || code === 'webchat_setup_required') return UI.text('設定で外部WebChatMCPの場所と［自動Chatを使う］を確認してください');
  if (code === 'webchat_task_completed') return UI.text('完了した作業は再開してから送ってください');
  if (code === 'webchat_task_busy') return UI.text('この会話でAI・整理・確認が動いています。終了を待ってください');
  if (code === 'webchat_legacy_request') return UI.text('以前の子作業への依頼は再送できません。通常の会話から新しい依頼を送ってください');
  if (code === 'webchat_history_failed') return UI.text('会話を保存できないため送信していません');
  if (code === 'webchat_topic_readonly') return UI.text('移行済みの話題は読み取り専用です');
  if (code === 'webchat_restarting') return UI.text('再起動中です。終了を待ってください');
  if (code === 'webchat_work_disabled') return UI.text('実作業が許可されていないため停止しました');
  if (code === 'webchat_busy') return UI.text('自動Chatが動いています。終了してから操作してください');
  if (code === 'webchat_invalid_envelope' || code === 'webchat_invalid_tool') return UI.text('道具の要求を確認できないため停止しました');
  return UI.text('Chat／Proが停止しました。送信記録を確認してください。自動再送はしません');
}
function webchatProgress(p,t) {
  const jobs=(state.webchat?.jobs||[]).filter(j=>j.project===p.id && [j.task,j.parent].includes(t.id)).slice(-1).filter(j=>j.state!=='done');
  const names={queued:UI.text('自動送信の順番待ち'),checking:UI.text('ログイン・モデルを確認中'),sending:UI.text('Chat／Proへ送信中'),tools:UI.text('GPT子で作業中'),reporting:UI.text('この会話に返信を保存中'),done:UI.text('返信済み'),unknown:UI.text('送信済みか不明・自動再送なし'),blocked:UI.text('送信前に停止'),stopped:UI.text('停止・自動再送なし')};
  return jobs.map(j=>UI.template`<div class="small account-row" role="status"><b>${esc(names[j.state] || names.unknown)}</b>${j.model?'・'+esc(j.model):''}${j.thinking?'・'+esc(j.thinking):''}${j.error?UI.template`<p>${esc(webchatError(j.error))}</p>`:''}
    ${['queued','checking','sending','tools','reporting'].includes(j.state) && j.kind!=='conversation'?UI.template`<button type="button" class="btn plain sm" data-webchat="stop" data-p="${esc(p.id)}" data-t="${esc(t.id)}" data-request="${esc(j.request)}">停止</button>`:!['queued','checking','sending','reporting','done'].includes(j.state) && j.kind==='conversation'?UI.template`<button type="button" class="btn plain sm" data-webchat="retry" data-p="${esc(p.id)}" data-t="${esc(t.id)}" data-request="${esc(j.request)}">もう一度送る</button>`:''}</div>`).join('');
}
let webchatSettingsPending = false;
let webchatSettingsNotice = '';
let webchatSettingsDraft = null;
let webchatSettingsRevision = 0;
let webchatSettingsSaving = 0;
let webchatSaveTail = Promise.resolve();
let webchatDetailsOpen = false;
let webchatModelsLocation = '';
function webchatLoginText(check) {
  return !check ? UI.text('未確認') : check.loggedIn === true ? UI.text('ログイン済み') : check.loggedIn === false ? UI.text('未ログイン') : UI.text('ログイン状態を判定できません');
}
function webchatSettingsMessage(r) {
  return webchatSettingsNotice || (r?.check?.statusError ? webchatError(r.check.statusError) : r?.journalError ? UI.text('送信記録を読めないため自動Chatを停止しています') : '');
}
function syncWebchatSettingsControls() {
  const box = $('#webchat-box'); if (!box) return;
  const disabled = webchatSettingsPending || Boolean(state.webchat?.busy);
  box.querySelectorAll('input,select,[data-webchat]').forEach(c => { c.disabled = disabled; });
  const auth = box.querySelector('[data-webchat]');
  if (auth) {
    const action = state.webchat?.check?.loggedIn === true ? 'logout' : 'login';
    auth.dataset.webchat = action; auth.textContent = action === 'logout' ? UI.text('ログアウト') : UI.text('ログイン');
    auth.disabled = disabled || webchatSettingsSaving > 0;
  }
  const status = box.querySelector('#webchat-login-status');
  if (status) status.textContent = webchatSettingsPending ? UI.text('確認中…') : state.webchat?.busy ? UI.text('実行中') : webchatLoginText(state.webchat?.check);
  const notice = box.querySelector('#webchat-settings-notice');
  if (notice) { notice.textContent = webchatSettingsMessage(state.webchat); notice.hidden = !notice.textContent; }
}
function webchatSettingsHtml(r) {
  const values = webchatSettingsDraft || r;
  const option=(a,current)=>[...new Set([current,...(a||[]).map(x=>x.label)].filter(Boolean))].map(v=>UI.template`<option value="${esc(v)}" ${v===current?'selected':''}>${esc(v)}</option>`).join('');
  const disabled = r.busy || webchatSettingsPending ? 'disabled' : '';
  const action = r.check?.loggedIn === true ? 'logout' : 'login';
  const message = webchatSettingsMessage(r);
  return UI.template`<div class="ai-account-line"><b>ChatGPT <span class="small">（Chat／Pro）</span></b><span id="webchat-login-status" class="ai-account-status small" role="status">${webchatSettingsPending?UI.text('確認中…'):r.busy?UI.text('実行中'):webchatLoginText(r.check)}</span><span class="ai-account-note"></span><div class="acts"><button type="button" class="btn plain sm" data-webchat="${action}" ${disabled || (webchatSettingsSaving ? 'disabled' : '')}>${action==='logout'?UI.text('ログアウト'):UI.text('ログイン')}</button></div>
    <details class="more ai-account-detail" id="webchat-details" data-ai-fold="webchat" ${webchatDetailsOpen?'open':''}><summary>設定</summary><div class="ai-detail-body">
      <label class="chk"><input type="checkbox" id="webchat-enabled" ${values.enabled?'checked':''} ${disabled}> 自動Chatを使う</label>
      <label>WebChatMCPの場所（絶対パス）<input id="webchat-location" value="${esc(values.location)}" placeholder="/path/to/WebChatMCP.js" ${disabled}></label>
      <label>モデル<select id="webchat-model" ${disabled}><option value="" ${!values.model?'selected':''}>ChatGPT側の現在の設定を使う</option>${option(r.check?.models,values.model)}</select></label>
      <label>思考<select id="webchat-thinking" ${disabled}><option value="" ${!values.thinking?'selected':''}>指定しない（ChatGPT側の設定）</option>${option(r.check?.thinking,values.thinking)}</select></label>
    </div></details></div><p id="webchat-settings-notice" class="small ai-account-message" role="status" ${message?'':'hidden'}>${esc(message)}</p>`;
}
function readWebchatSettings() {
  return { enabled: $('#webchat-enabled').checked, location: $('#webchat-location').value.trim(), model: $('#webchat-model').value, thinking: $('#webchat-thinking').value };
}
function validateWebchatSettings(body, requireLocation = false) {
  if ((requireLocation || body.enabled) && !body.location) throw Error('webchat_location_required');
  if (body.location && !body.location.startsWith('/')) throw Error('webchat_location_absolute');
}
function drawWebchatSettings() {
  const box = $('#webchat-box'); if (!box) return;
  preserveAiSettings(() => {
    box.innerHTML = webchatSettingsHtml(state.webchat || { enabled: false, location: '', model: '', thinking: '' });
    syncWebchatSettingsControls();
  });
}
async function saveWebchatSettings() {
  if (webchatSettingsPending || state.webchat?.busy) return;
  const body = readWebchatSettings(), revision = ++webchatSettingsRevision;
  webchatSettingsDraft = body; webchatSettingsSaving++; ++stateLoadEpoch;
  webchatSettingsNotice = UI.text('設定を保存中…'); syncWebchatSettingsControls();
  const save = webchatSaveTail.catch(() => {}).then(async () => {
    try {
      validateWebchatSettings(body);
      state.webchat = await api('/api/webchat', body);
      if (revision === webchatSettingsRevision) { webchatSettingsDraft = null; webchatSettingsNotice = ''; }
    } catch (e) {
      if (revision === webchatSettingsRevision) webchatSettingsNotice = UI.template`設定を保存できませんでした：${webchatError(e.message)}`;
      // Retain the draft; another edit or an explicit login can correct it.
    } finally { --webchatSettingsSaving; ++stateLoadEpoch; syncWebchatSettingsControls(); }
  });
  webchatSaveTail = save; await save;
}
async function loadWebchat() {
  const box = $('#webchat-box'); if (!box || webchatSettingsPending || webchatSettingsSaving) return;
  const epoch = stateLoadEpoch;
  try {
    const r = await api('/api/webchat');
    if ($('#webchat-box') !== box || epoch !== stateLoadEpoch || webchatSettingsPending || webchatSettingsSaving) return;
    state.webchat = r; drawWebchatSettings();
    // On first display, confirm existing authentication without changing it.
    if (r.location && !r.check && !r.busy && !webchatSettingsDraft) await operateWebchatSettings('status');
  } catch(e) { if ($('#webchat-box') === box && epoch === stateLoadEpoch) { webchatSettingsNotice = webchatError(e.message); syncWebchatSettingsControls(); } }
}
async function operateWebchatSettings(action) {
  if (webchatSettingsPending || state.webchat?.busy) { syncWebchatSettingsControls(); return; }
  if (action === 'logout' && !confirm(UI.text('このアカウントからログアウトしますか？'))) return;
  const body = readWebchatSettings();
  const revision = webchatSettingsRevision;
  if (action === 'login') webchatSettingsDraft = body;
  webchatSettingsPending = true; ++stateLoadEpoch;
  webchatSettingsNotice = action === 'login' ? UI.text('開いたブラウザでログインしてください') : action === 'logout' ? UI.text('ログアウト中…') : action === 'models' ? UI.text('モデル一覧を取得中…') : UI.text('確認中…');
  syncWebchatSettingsControls();
  let redraw = false;
  try {
    await webchatSaveTail;
    validateWebchatSettings(action === 'logout' ? state.webchat : body, true);
    // Login saves edited fields and enables Chat only after verified login.
    // Logout always targets the saved profile, never an unsaved path.
    state.webchat = await api('/api/webchat/' + action, action === 'login' ? body : action === 'logout' ? { confirm: true } : {});
    if (action === 'login' && revision === webchatSettingsRevision) webchatSettingsDraft = null;
    webchatSettingsNotice = action === 'models' && state.webchat.check?.modelsError ? webchatError(state.webchat.check.modelsError) : '';
    redraw = true;
  } catch(e) {
    webchatSettingsNotice = webchatError(e.message);
    // Read the saved result after an auth error; never repeat authentication.
    try { state.webchat = await api('/api/webchat'); } catch {}
    syncWebchatSettingsControls(); toast(webchatSettingsNotice);
  } finally { webchatSettingsPending = false; ++stateLoadEpoch; if (redraw) drawWebchatSettings(); else syncWebchatSettingsControls(); }
}
document.addEventListener('input', e => {
  if (!['webchat-enabled', 'webchat-location', 'webchat-model', 'webchat-thinking'].includes(e.target.id) || webchatSettingsPending) return;
  webchatSettingsDraft = readWebchatSettings(); ++webchatSettingsRevision;
  if (!webchatSettingsNotice || webchatSettingsNotice === UI.text('設定を保存中…')) webchatSettingsNotice = UI.text('未保存');
  syncWebchatSettingsControls();
});
document.addEventListener('change', async e => {
  if (!['webchat-enabled', 'webchat-location', 'webchat-model', 'webchat-thinking'].includes(e.target.id)) return;
  if (e.target.id === 'webchat-location') webchatModelsLocation = '';
  await saveWebchatSettings();
});
document.addEventListener('toggle', e => {
  rememberDisclosure(e.target);
}, true);
document.addEventListener('focusin', async e => {
  if (!['webchat-model', 'webchat-thinking'].includes(e.target.id)) return;
  const r = state.webchat;
  if (!r?.location || r.check?.loggedIn !== true || r.check?.modelsChecked || webchatSettingsDraft || webchatSettingsPending || webchatModelsLocation === r.location) return;
  webchatModelsLocation = r.location; await operateWebchatSettings('models');
});
document.addEventListener('click',async e=>{
  const button=e.target.closest?.('[data-webchat]');if(!button||button.disabled)return;
  const action=button.dataset.webchat;
  if (['login','logout'].includes(action)) { await operateWebchatSettings(action); return; }
  button.disabled=true;
  try {
    if(action==='stop')await api('/api/webchat/stop',{project:button.dataset.p,task:button.dataset.t});
    else if(action==='retry'){
      if(!confirm(UI.text('前の送信と子コピーの変更を確認しましたか？ 新しい依頼としてもう一度送ります。')))return;
      await api('/api/webchat/retry',{project:button.dataset.p,task:button.dataset.t,request:button.dataset.request,confirm:true});
    }
    await load();
  }catch(err){toast(webchatError(err.message));}
  finally{button.disabled=false;}
});

let chatgptLoadEpoch = 0;
let chatgptWorkPending = null;
let agyModelsRefreshing = false;
function agyModelsHtml() {
  const models = state.agyModels || [], status = state.agyModelsState || 'unconfirmed';
  const message = status === 'failed' ? UI.text('モデル一覧の取得に失敗しました。前回の候補を表示しています。再取得するまで実行できません') : status === 'auth-required' ? UI.text('モデル一覧の取得にはログインが必要です') : !models.length ? UI.text('利用可能なモデルがありません。モデル一覧を再取得してください') : UI.text('会話またはTerminalのモデル欄で選んでください。別のモデルへ自動では切り替えません');
  return UI.template`<div class="agy-models"><b>利用可能なモデル</b><p class="small" role="status">${esc(message)}</p>${models.length ? UI.template`<ul>${models.map(row => UI.template`<li>${esc(row.label)} <code>${esc(row.id)}</code></li>`).join('')}</ul>` : ''}<button class="btn plain sm" type="button" data-agy-model-refresh ${agyModelsRefreshing ? 'disabled' : ''}>${agyModelsRefreshing ? UI.text('確認中…') : UI.text('モデル一覧を再取得')}</button></div>`;
}
document.addEventListener('click',async event => {
  const button = event.target.closest?.('[data-agy-model-refresh]');
  if (!button || button.disabled || agyModelsRefreshing) return;
  agyModelsRefreshing = true; drawAccountSettings();
  try {
    const checked = await api('/api/accounts?status=1&ai=agy', undefined, { 'X-Hub': '1' });
    adoptAgyCatalog(checked);
    accountStatusRows = [...(accountStatusRows || state.accounts || []).filter(row => row.ai !== 'agy'), ...checked.accounts];
    await refreshAiToolCatalog();
    const row = checked.accounts[0]; if (row?.message) toast(UI.message(row.message));
  } catch(error) { toast(error.message); }
  finally { agyModelsRefreshing = false; drawAccountSettings(); }
});
function accountSettingsHtml() {
  const grokInstallReason = r => r.ai === 'grok' && r.status === 'not-installed' && r.message === 'Grok Build が未導入です';
  const rows = accountStatusRows || state.accounts || [];
  const label = r => r.status === 'logged-in' ? UI.text('ログイン済み') : r.status === 'logged-out' ? UI.text('未ログイン') : r.status === 'api' ? UI.text('API認証（対象外）') : r.status === 'not-installed' ? UI.text('未導入') : UI.text('未確認');
  const agyFailed = ['failed', 'auth-required'].includes(state.agyModelsState) || !(state.agyModels || []).length;
  const agyReason = state.agyModelsState === 'failed' ? 'モデル一覧の取得に失敗しました。再取得するまで実行できません。' : state.agyModelsState === 'auth-required' ? 'モデル一覧の取得にはログインが必要です。' : '利用可能なモデルがありません。モデル一覧を再取得してください。';
  return UI.template`<section class="ai-use-section"><div class="ai-section-heading"><h3>アカウント</h3><button type="button" class="btn plain sm" data-account-action="status" ${accountOperation ? 'disabled' : ''}>状態を確認</button></div>
    <p id="account-message" class="small" role="status"></p>
    ${rows.map(r => UI.template`<div class="account-row" data-account-row data-auth-terminal="${r.authTerminal ? '1' : '0'}" data-ai="${esc(r.ai)}" data-id="${esc(r.id)}"><div class="ai-account-line"><b>${esc(r.ai === 'agy' ? 'Gemini（Agy）' : AI_LABEL[r.ai])}${r.id !== 'default' ? '・' + esc(UI.label(r.name)) : ''}</b><span class="ai-account-status small">${label(r)}</span><div class="ai-account-note small">${r.email ? UI.template`<span title="${esc(r.email)}">${esc(r.email)}</span>` : ''}${r.authTerminal ? UI.text(' 認証用Terminalを開いています') : r.busy ? UI.text(' 作業中／順番待ち') : ''}${grokInstallReason(r) ? UI.template`<span>${esc(UI.message(r.message))}</span>` : ''}
      ${r.ai === 'agy' ? UI.template`<details class="more" data-ai-fold="agy-${esc(r.id)}"><summary>モデル ${esc((state.agyModels || []).length)}件</summary>${agyModelsHtml()}</details>` : ''}
      ${r.id !== 'default' ? UI.template`<details class="more" data-ai-fold="edit-${esc(r.ai)}-${esc(r.id)}"><summary>編集</summary><div class="acts ai-detail-body"><input data-account-name maxlength="60" value="${esc(r.name)}" aria-label="${esc(UI.label(r.name))}の新しい名前"><button class="btn plain sm" type="button" data-account-action="rename" ${accountOperation ? 'disabled' : ''}>名前変更</button><button class="btn plain sm" type="button" data-account-action="delete" ${r.busy || accountOperation ? UI.text('disabled title="終了してから操作してください"') : ''}>削除（ゴミ箱へ）</button></div></details>` : ''}</div>
      <div class="acts">${r.ai === 'grok' && r.status === 'not-installed' ? UI.template`<details class="more" data-ai-fold="grok-install"><summary>導入方法</summary><p class="small ai-detail-body">MacのTerminalで <code>curl -fsSL https://x.ai/cli/install.sh | bash</code> を実行してください。Hubは実行しません。</p></details>` : UI.template`<button class="btn plain sm" type="button" data-account-action="${r.status === 'logged-in' || r.status === 'api' ? 'logout' : 'login'}" ${accountOperation || r.busy && !r.authTerminal ? UI.text('disabled title="終了してから操作してください"') : ''}>${r.status === 'logged-in' || r.status === 'api' ? UI.text('ログアウト') : UI.text('ログイン')}</button>`}</div></div>
      ${r.message && !grokInstallReason(r) ? UI.template`<p class="small ai-account-message" role="status">${esc(UI.message(r.message))}</p>` : ''}${r.ai === 'agy' && agyFailed ? UI.template`<p class="small ai-account-message" role="status">${esc(UI.text(agyReason))}</p>` : ''}</div>`).join('')}
    <div class="account-row ai-chatgpt-row"><div id="webchat-box" aria-live="polite"></div>
      <details class="more ai-mcp-detail" data-ai-fold="mcp"><summary>MCP <span id="chatgpt-mcp-status" class="small" role="status">確認中…</span></summary><div class="ai-detail-body"><div id="chatgpt-box" aria-live="polite">確認中…</div>${chatgptConnectionHelpHtml()}</div></details>
      <div id="chatgpt-shell-alert">${shellWarningHtml()}</div></div>
    <details class="more ai-account-manage" data-ai-fold="account-manage"><summary>アカウントを追加・管理</summary><div class="acts ai-detail-body"><select id="account-new-ai" aria-label="追加するAI"><option value="claude">Claude Code</option><option value="codex">Codex</option><option value="grok">Grok</option><option value="agy" disabled>Gemini（Agy CLI）・既定のみ</option></select><input id="account-new-name" maxlength="60" placeholder="名前（例：仕事用）" aria-label="アカウント名"><button type="button" class="btn" data-account-action="add" ${accountOperation ? 'disabled' : ''}>追加</button></div><p class="small">作業ごとに使うアカウントを選べます。今のログインは「既定」です。追加アカウントは別の場所に保存します。別作業で別アカウントを選ぶと同時に使えます。ログインはMacのTerminalで本人が操作します。会話や認証情報はコピーしません。MCPなどの接続設定は追加先で設定してください。Gemini（Agy CLI）はログイン情報をMacのキーチェーンに1件だけ保存するため、既定のみです。ログアウトは開いたTerminalで /logout と入力してください。</p></details></section>`;
}
function drawAccountSettings() {
  const box = $('#ai-accounts'); if (!box || view.kind !== 'settings') return;
  preserveAiSettings(() => {
    box.innerHTML = accountSettingsHtml();
    box.querySelectorAll('[data-account-action]').forEach(b => b.addEventListener('click', () => operateAccount(b)));
    loadChatgpt();
    drawWebchatSettings();
    if (state.webchat?.location && !state.webchat.check && !state.webchat.busy) loadWebchat();
  });
}
async function operateAccount(button) {
  if (accountOperation || button.disabled) return;
  const action = button.dataset.accountAction, row = button.closest('[data-account-row]');
  const ai = row?.dataset.ai || $('#account-new-ai').value, id = row?.dataset.id || 'default';
  const existingTerminal = row?.dataset.authTerminal === '1' && ['login', 'logout'].includes(action);
  let body = { ai, id, ...(existingTerminal ? {action} : {}) };
  if (action === 'add') body.name = $('#account-new-name').value;
  if (action === 'rename') body.name = row.querySelector('[data-account-name]').value;
  if (!existingTerminal && (action === 'logout' || action === 'delete')) {
    if (!confirm(action === 'logout' ? UI.text('このアカウントからログアウトしますか？') : UI.text('アカウントの保存場所をゴミ箱へ移しますか？ 会話と認証情報もその場所に含まれます。'))) return;
    body.confirm = true;
    if (id === 'default' && action === 'logout') {
      if (!confirm(UI.text('既定のログアウトは、Hub以外の同じCLIにも影響します。ログアウトしますか？'))) return;
      body.confirmDefault = true;
    }
  }
  accountOperation = true; button.disabled = true;
  let notice = UI.text('処理中…');
  drawAccountSettings(); $('#account-message').textContent = notice;
  try {
    const result = action === 'status' ? await checkRoleAccounts() : await api(existingTerminal ? '/api/accounts/terminal' : action === 'add' ? '/api/accounts' : '/api/accounts/' + action, body);
    if (action !== 'status' && !existingTerminal) { accountStatusRows = null; accountCheckedAt = ''; accountAutoChecked = false; const r = await api('/api/accounts'); state.accounts = r.accounts; }
    notice = result?.warning || (action === 'login' ? UI.text('Macで開いたTerminalでログインし、終わったら［状態を確認］を押してください。') : UI.text('完了しました'));
    if (typeof usageContextChanged === 'function') usageContextChanged();
  } catch (e) { notice = e.message; }
  finally {
    accountOperation = false; button.disabled = false;
    drawAccountSettings(); syncRoleAccountChoices();
    if (view.kind === 'settings' && $('#account-message')) $('#account-message').textContent = notice;
    toast(notice);
  }
}

const SETTINGS_TABS = { basic: UI.text('基本'), ai: 'AI', connect: UI.text('つなぐ'), recovery: UI.text('復旧'), manage: UI.text('管理') };
function stopResultText(r){
  const states={exited:'終了を確認',alive:'停止できていません', 'ownership-unknown':'所有を確認できず停止未確認','not-started':'開始前に保留','external-unconfirmed':'外部サービスの終了は未確認',failed:'停止に失敗'};
  return `${r.project?`${r.project}／${r.task||'作業未確認'}・`:''}${r.label||'AI'}：${states[r.state]||'未確認'}／${r.save==='saved'?'結果を保存済み':'結果の保存は未確認'}${r.errors?.length?'\n'+r.errors.join('\n'):''}`;
}
function drawEmergencyStatus(s){const box=$('#emergency-status');if(!box)return;
  box.textContent=[s.stopping?'停止処理中です。':s.paused?'AIの開始を保留しています。':'AIの開始は許可されています。',s.persistence==='unconfirmed'?`停止状態の保存は未確認です：${s.error}`:'',s.restart?.reason||'',...(s.tasks||[]).map(t=>`${t.project}／${t.task}：${t.autoHeld&&!t.held?'待ち指示と自動開始は保留中。新しい送信は可能':'保留中'}`),...(s.results||[]).map(stopResultText),...(s.errors||[])].filter(Boolean).join('\n');
  const stop=$('[data-ai-emergency]');if(stop)stop.disabled=Boolean(s.stopping||['stopping','waiting','committed'].includes(s.restart?.phase));
  const resume=$('[data-ai-resume]');if(resume)resume.disabled=Boolean(!s.paused||s.stopping||['stopping','waiting','committed'].includes(s.restart?.phase)||(s.results||[]).some(r=>['alive','ownership-unknown','failed'].includes(r.state)));
}
async function refreshEmergencyStatus(){if(!$('#emergency-status'))return;try{drawEmergencyStatus(await api('/api/ai/stop/status'));}catch(e){$('#emergency-status').textContent=`停止状態を確認できません：${e.message}`;}}
document.addEventListener('click',async e=>{
  const button=e.target.closest?.('[data-ai-emergency],[data-ai-resume],[data-ai-stop-refresh]');if(!button)return;
  if(button.hasAttribute('data-ai-stop-refresh'))return refreshEmergencyStatus();
  button.disabled=true;
  try{
    if(button.hasAttribute('data-ai-resume')){
      if(!confirm(UI.text('AIの開始を再び許可します。保留中の自動処理も再開できます。会話の待ち指示は内容を確認してから［始める］を押してください。')))return;
      drawEmergencyStatus(await api('/api/ai/resume',{confirm:true}));
    }else{
      const s=await api('/api/ai/stop/status');
      const targets=(s.targets||[]).map(t=>`${t.project}／${t.task||'作業未確認'}：${AI_LABEL[t.ai]||t.ai}${t.kind==='unmanaged'?'（Hub所有未確認・停止対象外）':''}`).join('\n')||'現在、稼働中として確認できるAIはありません。';
      if(!confirm(UI.template`Hubが起動したすべてのAIを停止し、待ち指示と自動開始を保留します。通常停止に応じない場合は強制終了します。会話と保存済み成果は残りますが、保存前の出力は失われる場合があります。\n\n${targets}\n\n停止・保存を確認した後、Hubを一度再起動します。再起動後もAIと待ち指示は保留し、人が再開するまで始めません。確認できない場合は再起動せず理由を表示します。\n\n停止してHubを再起動しますか？`))return;
      $('#emergency-status').textContent='停止処理中です。終了と保存を確認しています…';
      const opId=crypto.randomUUID();try{sessionStorage.setItem('hub-emergency-stop-id',opId);}catch{/* Storage failure must never prevent a stop. */}
      drawEmergencyStatus(await api('/api/ai/stop',{confirm:true,opId}));
    }
  }catch(error){$('#emergency-status').textContent=`停止・再開の結果を確認できません：${error.message}。［状態を確認］で照合してください。`;}finally{button.disabled=false;void refreshEmergencyStatus();}
});
setInterval(()=>{if(view.kind==='settings'&&settingsTab==='recovery')void refreshEmergencyStatus();},3000);
let settingsTab = localStorage.getItem('hub.settingsTab') || 'basic';
function selectSettingsTab(tab) {
  settingsTab = Object.hasOwn(SETTINGS_TABS, tab) ? tab : 'basic';
  localStorage.setItem('hub.settingsTab', settingsTab);
  const dirty = rolesDirty();
  document.querySelectorAll('[data-settings-tab]').forEach(button => {
    const selected = button.dataset.settingsTab === settingsTab;
    button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
    const label = SETTINGS_TABS[button.dataset.settingsTab];
    button.textContent = label + (button.dataset.settingsTab === 'ai' && dirty ? ' •' : '');
    button.setAttribute('aria-label', label + (button.dataset.settingsTab === 'ai' && dirty ? UI.text(' 未保存あり') : ''));
  });
  document.querySelectorAll('.settings > [data-tab]').forEach(card => { card.hidden = card.dataset.tab !== settingsTab; });
  autoCheckRoleAccounts();
}
document.addEventListener('click', e => {
  const button = e.target.closest?.('[data-settings-tab]');
  if (button) selectSettingsTab(button.dataset.settingsTab);
});
document.addEventListener('keydown', e => {
  const button = e.target.closest?.('[data-settings-tab]');
  if (!button || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  const tabs = Object.keys(SETTINGS_TABS), index = tabs.indexOf(button.dataset.settingsTab);
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  e.preventDefault(); selectSettingsTab(tabs[next]); document.querySelector(`[data-settings-tab="${tabs[next]}"]`)?.focus();
});
function licensePurchaseHtml() {
  if (state.license?.supported === false || state.license?.edition !== 'public' || state.license.purchased || !state.license?.purchaseUrl) return '';
  try {
    const url = new URL(state.license.purchaseUrl);
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    return UI.template`<div class="license-purchase" data-license-purchase-guide>
      <p>買い切りで、購入した版の全機能を期限なしで使えます。</p>
      ${state.license.introAvailable
        ? UI.html('<button type="button" class="btn" data-license-intro>体験中の特別価格で購入（1,100円・税込）</button>')
        : UI.template`<button type="button" class="btn" data-license-purchase data-url="${url.href}">購入する（4,900円・税込）</button>`}
      <p class="small">支払い画面はブラウザで開きます。支払い後に表示される利用コードをコピーし、この画面の［お持ちの利用コード］に貼り付けて［登録する］を押してください。すでに支払い済みの場合は、再購入せずコードを登録してください。</p>
    </div>`;
  } catch { return ''; }
}
document.addEventListener('click', async e => {
  const button = e.target.closest?.('[data-license-intro]');
  if (!button) return;
  e.preventDefault();
  if (button.disabled) return;
  button.disabled = true;
  try { await api('/api/license/intro-checkout', {}); }
  catch { toast(UI.text('体験価格の購入画面を開けません。支払い状況を確認してください')); }
  finally { button.disabled = false; }
});
document.addEventListener('submit', async e => {
  if (e.target.id !== 'license-form') return;
  e.preventDefault();
  const form = e.target, input = form.querySelector('#license-code'), notice = form.querySelector('#license-notice');
  if (form.querySelector('button').disabled) return;
  const code = input.value; input.value = '';
  const button = form.querySelector('button'); button.disabled = true;
  notice.textContent = '利用コードを確認しています…';
  try { const result = await api('/api/license/activate', { code }); state.license = result.status || state.license; renderSettings(); toast(UI.text('利用コードを登録しました')); }
  catch (error) { notice.textContent = error.message; }
  finally { button.disabled = false; }
});
function rolesSaveStatus() {
  return roleAssignmentsDirty() && creditsDirty() ? UI.text('役割分担とクレジットに変更があります（まだ保存していません）') : rolesDirty() ? UI.text('変更があります（まだ保存していません）') : UI.text('保存済み');
}
function creditSettingsHtml() {
  return UI.template`<section class="ai-use-section ai-credit-settings"><div class="ai-option-line"><h3>クレジット</h3><span class="small">確認する：</span>
    <label class="chk"><input type="checkbox" data-check-credits="claude" ${checkCreditsDraft.claude ? 'checked' : ''}> Claude</label>
    <label class="chk"><input type="checkbox" data-check-credits="codex" ${checkCreditsDraft.codex ? 'checked' : ''}> Codex</label>${creditsDirty() ? UI.html('<span class="dirty" role="status">未保存</span>') : ''}</div>
    <label class="chk"><input type="checkbox" data-prefer-credits ${preferCreditsDraft ? 'checked' : ''}> 上限後も既存クレジットで続ける（確認ONのAIだけ）</label>
    <div class="ai-option-line"><span class="small">購入・自動チャージはしません。</span><details class="more" data-ai-fold="credits-help"><summary>詳しく</summary><div class="ai-detail-body">
      <p class="small">初期設定は両方OFFです。ONのAIだけ送信前にクレジット情報を確認します。OFFでも通常の利用枠の確認と利用状況の表示は続けます。</p>
      <p class="small">確認だけでは有料の継続利用を許可しません。Claudeの月間追加利用枠は、実際の残高とは異なります。</p>
      <p class="small">継続の許可は初期設定OFFです。ONにすると、確認ONのAIだけ、利用枠の上限後も利用可能と確認できた既存クレジットで元の担当を継続します。OFFにするまで許可が続きます。</p>
      <p class="small">自動チャージがない、またはOFFであることを確認してから保存してください。購入・自動チャージ・APIキー課金は行いません。残高が不明・古い・取得失敗なら設定された交代先へ切り替えます。正式な実行拒否は維持します。Claudeの実残高を取得できない場合も交代します。</p>
    </div></details></div></section>`;
}
function renderSettings() {
  return preserveAiSettings(() => {
    if (!rolesDraft) { rolesDraft = JSON.parse(JSON.stringify(state.roles.roles)); rolesDraftRevision = state.roles.management?.revision; }
    if (!checkCreditsDraft) checkCreditsDraft = creditCheckSettings();
    if (preferCreditsDraft === null) preferCreditsDraft = state.roles.preferCredits === true;
    const models = state.roles.models;
    const opt = (list, v) => list.map(x => UI.template`<option ${x === v ? 'selected' : ''}>${esc(x)}</option>`).join('');
    const cell = (i, k, s) => UI.template`<div class="cfg">
        <select data-r="${i}" data-k="${k}" data-f="ai" aria-label="AI">${roleAiOptions(s.ai)}</select>
        ${s.ai === '人' ? '' : UI.template`<select data-r="${i}" data-k="${k}" data-f="model" aria-label="モデル">${roleModelOptions(s.ai,s.model)}</select>
        <select data-r="${i}" data-k="${k}" data-f="effort" aria-label="思考" ${effortHidden(s.ai) ? 'hidden' : ''} ${s.ai === 'agy' ? 'disabled' : ''}>${opt(effortsFor(s.ai), s.effort)}</select>`}</div>`;
    const dirty = rolesDirty(), purchase = licensePurchaseHtml();
    $('#main').innerHTML = UI.template`<div class="view settings-view"><div class="settings">
      <div class="settings-tabs" role="tablist" aria-label="設定">${Object.entries(SETTINGS_TABS).map(([key, label]) => UI.template`<button type="button" role="tab" data-settings-tab="${key}">${label}</button>`).join('')}</div>
      <section class="pref-section" data-tab="recovery"><h2 class="pref-caption">AIの緊急停止</h2><div class="pref-list recovery-card">
        <div data-handoff-status>${chatHandoffHtml()}</div>
        <div class="pref-row pref-stack"><div class="pref-text"><p>停止が効かない時は、Hubが起動したAIをすべて停止します。待ち指示と自動開始も保留します。会話と保存済み成果は残ります。停止・保存を確認できたらHubを一度再起動し、AIは保留したまま画面へ戻ります。</p></div>
          <button type="button" class="btn emergency-stop" data-ai-emergency><span aria-hidden="true">■</span> すべてのAIを緊急停止</button></div>
        <div class="pref-row pref-stack"><p id="emergency-status" role="status" aria-live="polite">停止状態を確認中…</p>
          <div class="buttons"><button class="btn plain" type="button" data-ai-stop-refresh>状態を確認</button><button class="btn" type="button" data-ai-resume disabled>AIの開始を再び許可</button></div>
          <p class="small">強制終了まで数秒かかる場合があります。所有を確認できないAIへは信号を送りません。外部サービスの生成終了は別に確認が必要です。Hub自体が応答しない場合、このボタンも動きません。</p></div>
      </div></section>
      <section class="pref-section" data-tab="basic"><h2 class="pref-caption">表示</h2><div class="pref-list">
        <div class="pref-row"><div class="pref-text"><h3>配色</h3><p>初期設定はダークです。選んだ配色はこのブラウザに保存されます。</p></div>
          <div class="pref-control"><div class="theme-choices pref-seg" role="group" aria-label="配色">
            <button type="button" class="theme-choice" data-theme-choice="dark" aria-pressed="${(window.HubTheme?.current() || 'dark') === 'dark'}">ダーク</button>
            <button type="button" class="theme-choice" data-theme-choice="light" aria-pressed="${window.HubTheme?.current() === 'light'}">ライト</button>
          </div></div></div>
        <div class="pref-row"><div class="pref-text"><h3>言語</h3><p>Hub を再起動すると切り替わります。Mac アプリのメニューは、アプリを開き直した時に切り替わります。</p></div>
          <div id="language-box" class="pref-contents" aria-live="polite">${languageSettings ? languageSettingsHtml(languageSettings) : UI.text('確認中…')}</div></div>
      </div></section>
      <section class="pref-section" data-tab="basic"><h2 class="pref-caption">会話</h2><div class="pref-list">
        <label class="pref-row"><span class="pref-text"><span class="pref-name">コマンドなど、AI の細かい作業も会話に出す</span><span class="pref-desc">作業中の印と返事、大事な知らせはいつも出ます。</span></span>
          <input type="checkbox" class="pref-switch" id="set-detail" ${showDetail() ? 'checked' : ''}></label>
        <label class="pref-row"><span class="pref-text"><span class="pref-name">Enter だけで送る</span><span class="pref-desc">改行は Shift + Enter。オフにすると ⌘ + Enter で送ります。</span></span>
          <input type="checkbox" class="pref-switch" id="set-enter" ${enterSends() ? 'checked' : ''}></label>
        <div class="pref-row pref-stack"><div class="pref-text"><h3>新しく始めるときのAI</h3><p>新しい作業の初期値です。既存の作業は変わりません。</p></div>
          <div id="initial-pick">${initialPickHtml()}</div></div>
      </div></section>
      <section class="pref-section" data-tab="basic"><h2 class="pref-caption">利用コード</h2><div class="pref-list">
        ${state.license?.edition === 'owner' || state.license?.supported === false ? '' : UI.html('<form id="license-form" class="pref-row">')}${state.license?.edition === 'owner' || state.license?.supported === false ? UI.html('<div class="pref-row">') : ''}
          <div class="pref-text"><span class="pref-name" role="status">${esc(state.license?.edition === 'owner' ? '製作者版：鍵不要・全機能・期限なし' : state.license?.reason || '利用権を確認中です')}</span>
          ${state.license?.edition !== 'owner' && state.license?.trial?.expiry ? UI.template`<p data-trial-dates>無料体験：${new Date(state.license.trial.startsAt * 1000).toLocaleString('ja-JP')} 〜 ${new Date(state.license.trial.expiry * 1000).toLocaleString('ja-JP')}（残り ${state.license.trial.remainingDays} 日）</p>` : ''}</div>
        ${state.license?.edition === 'owner' || state.license?.supported === false ? UI.html('</div>') : UI.html('<div class="pref-control"><label class="pref-sr" for="license-code">お持ちの利用コード</label><input id="license-code" type="password" autocomplete="off" maxlength="256" required placeholder="お持ちの利用コード"><button class="btn" type="submit">登録する</button></div><p id="license-notice" role="status"></p></form>')}
        ${purchase ? `<div class="pref-row pref-stack">${purchase}</div>` : ''}
      </div></section>
      <section class="pref-section" data-tab="basic"><h2 class="pref-caption">はじめに・引っ越し</h2><div class="pref-list">
        <div class="pref-row"><div class="pref-text"><h3>はじめの設定</h3><p>AIの導入・ログイン・確認を順に案内します。</p></div>
          <div class="pref-control"><button class="btn plain" type="button" data-onboarding-open>開く</button></div></div>
        <div class="pref-row"><div class="pref-text"><h3>会話とターミナルの使い分け</h3><p>普段は［会話］、AIの画面を直接操作したいときは［ターミナル］。</p>
          <details class="pref-more"><summary>どちらを使う？</summary>
            <h4>会話が向いているとき</h4>
            <ul><li>相談する、質問する、作業をお願いする</li><li>前に決めたことを踏まえて続けたい</li><li>別のAIへ引き継ぎたい</li></ul>
            <p>やり取りがHubに残り、別のAIにも背景を渡しやすい窓口です。自由対話（freetalk）もこちらです。添付や確認結果などは、引き継いだAIが必要に応じて改めて確認します。</p>
            <h4>ターミナルが向いているとき</h4>
            <ul><li>AIの画面を見ながら直接操作したい</li><li>同じAIと細かい指示を何度もやり取りしたい</li></ul>
            <p>起動しているAIに直接指示する窓口です。その場で続けるのに向いていますが、やり取りはHubの会話履歴には入りません。</p>
            <p><strong>画面を切り替えても、もう片方のAIは止まりません。</strong>会話とターミナルは別々に動きます。同じ作業への指示は、どちらか一方にまとめると混乱を防げます。</p>
          </details></div></div>
        <div class="pref-row"><div class="pref-text"><h3>引っ越し</h3><p>別のMacへ移す時に使います。同じMacなら、データを残してアプリを入れ直すだけで使えます。</p>
          <label class="chk pref-check"><input type="checkbox" id="move-backups"> 過去のバックアップも含める</label>
          <details class="pref-more"><summary>詳しく</summary>
            <p>別のMacへは、作ったフォルダを「書類」の「ProjectHub-Move」に置き、対応するアプリを起動してください。会話・添付・プロジェクトを読み込みます。</p>
            <p>AIのログイン情報と利用コードは移しません。新しいMacで登録してください。作業中・順番待ち・未保存の変更がある場合は作成できません。</p>
          </details></div>
          <div class="pref-control"><button type="button" class="btn plain" id="move-export">引っ越し用データを作る</button></div>
          <div id="move-status" aria-live="polite"></div></div>
      </div></section>
      <section class="pref-section" data-tab="ai"><h2 class="pref-caption">役割分担</h2><div class="pref-list">
        <div class="pref-row pref-stack"><div id="role-settings-controls">${roleSettingsHtml()}</div></div>
        <div class="pref-row pref-stack"><div class="role-head"><p class="pref-desc">役割ごとの担当と、上限の時の担当です。</p><div class="acts"><span id="role-account-status" class="small" role="status"></span><button id="role-account-check" class="btn plain sm" type="button">もう一度確認</button></div></div>
        <div class="tbl role-table"><table><tr><th>役割</th><th>いつもの担当</th><th>上限の時</th><th>内容</th></tr>
        ${rolesDraft.map((r, i) => UI.template`<tr><td class="now">${esc(UI.label(r.name))}</td><td class="role-main" data-label="いつもの担当">${cell(i, 'main', r.main)}</td><td class="role-backup" data-label="上限の時">${cell(i, 'backup', r.backup)}</td><td class="job" title="${esc(UI.label(r.job))}">${esc(UI.label(r.job))}</td></tr>`).join('')}</table></div></div>
        <div class="pref-row pref-stack"><div class="acts ai-save-actions"><button class="btn" id="roles-save" type="button" ${dirty ? '' : 'disabled'}>役割分担・クレジットを保存</button>
          <button class="btn plain" id="roles-reset" type="button" ${dirty ? '' : 'disabled'}>元に戻す</button>
          <span class="${dirty ? 'dirty' : 'saved'}" role="status">${rolesSaveStatus()}</span></div>
        <details class="more"><summary>詳しく</summary><p class="small">保存した設定は次の起動・上限時の交代に反映します。交代先も上限ならいつもの担当へ、両方が上限なら待機します。</p><p class="small"><span id="model-catalog">選べるモデル：Claude Code は ${esc((models['claude-code'] || []).join(' / '))}、Codex は ${esc((models.codex || []).join(' / '))}、Grok は ${esc((models.grok || []).join(' / '))}（思考は中・高・極高・MAX）、Gemini（Agy CLI）は取得したモデル一覧から選択・思考「高」。思考は ${esc(state.efforts.join(' → '))}。</span>保存先 <span class="path">${esc(state.root)}/_hub/roles.yaml</span></p></details></div>
      </div></section>
      <section class="pref-section ai-use-settings" data-tab="ai" id="ai-use-settings"><h2 class="pref-caption">AIの利用設定</h2><div class="pref-list">
        <div class="pref-row pref-stack"><div id="ai-accounts"></div></div>
        <div class="pref-row pref-stack"><section class="ai-use-section"><div class="ai-option-line"><h3>特殊モード</h3><div id="special-mode" class="ai-option-line">${specialModeHtml()}</div><details class="more" data-ai-fold="special-help"><summary>詳しく</summary><div class="ai-detail-body"><p class="small">リセット前やリセットチケットを使うとき、選んだAIに作業を集中します。</p><p class="small">今回の依頼にAI・モデルの直接指定がなければ、選んだAIを使い続けます。同じAI内のモデルはAIに任せます。人が指定・選択した依頼の後は特殊モードへ戻ります。通常の役割分担は保存したままです。</p><p class="small">次の依頼から反映します。作業中のAIや受付済みの待ち指示は変わりません。上限時は別のAIへ自動交代せず待機します。</p></div></details></div></section></div>
        <div class="pref-row pref-stack">${creditSettingsHtml()}</div>
      </div></section>
      <section class="pref-section" data-tab="ai"><h2 class="pref-caption">選ぶ欄に出すモデル</h2><div class="pref-list">
        <div class="pref-row pref-stack"><p class="pref-desc">選ぶ欄に出すモデルと順番です。</p>
        <div id="model-order-list">${modelOrderHtml()}</div>
        <details class="more"><summary>並べ方・整理</summary>      <p>上から順に、会話などのモデルを選ぶ欄に並びます。［↑］［↓］で順番を変えられます。パソコンでは左の印をドラッグしても動かせます。役割の担当と今の選択は変わりません。</p>
        <div class="acts" style="margin-top:10px"><button class="btn plain" id="models-tidy" type="button">最新のモデルに整理する</button>
          <span class="small">役割で使っている古いモデル名（6sol など）を、同じ系統の一番新しいモデルに置き換え、roles.yaml の一覧も今のものにします。</span></div>
        <div id="tidy-result" class="small"></div></details></div>
        <div class="pref-row pref-stack"><details class="more"><summary>上級：CLIに渡すモデル名</summary>
        <p>画面のモデルの呼び名を、Claude Code・Codex が受け付ける名前に直します。<b>空にすると、モデルを指定せず CLI の既定のモデルを使います。</b>モデル名が拒否された場合は理由を表示し、設定を勝手に変えません。</p>
        <div id="climodels" class="small">読み込み中…</div></details></div>
      </div></section>
      <section class="pref-section" data-tab="ai"><h2 class="pref-caption">AI の更新</h2><div class="pref-list">
        <div class="pref-row pref-stack"><div id="ai-tools" aria-live="polite">確認中…</div></div>
      </div></section>
      <section class="pref-section" data-tab="ai"><h2 class="pref-caption">スキル</h2><div class="pref-list">
        <div class="pref-row"><div class="pref-text"><p>このパソコンで各AIの既定の置き場所に見つかったスキルです。有効・無効は判定しません。</p></div><div class="pref-control"><button class="btn plain sm" id="skills-check" type="button">もう一度確認</button></div></div>
        <div class="pref-row pref-stack"><div id="skills-box" aria-live="polite">${skillsHtml()}</div>
        <details class="more"><summary>詳しく</summary><p class="small">CLI内蔵・プラグイン・同期分・作業フォルダ内・追加アカウントのスキルは含みません。Codexの付属スキルは「付属」と表示します。</p>
        <p class="small">作業で実際に使ったスキルは、各作業画面の「使ったスキル」に記録されます。</p></details></div>
      </div></section>
      <section class="pref-section" data-tab="ai"><h2 class="pref-caption">Codex の加速（Fast）</h2><div class="pref-list">
        <div class="pref-row pref-stack"><div class="pref-text"><p>ONにしても自動では加速しません。作業画面のCodex欄で作業ごとに選びます。</p><p class="danger"><strong>速度約1.5倍・利用枠の消耗2.5倍</strong></p></div>
        <div id="acceleration" aria-live="polite">確認中…</div>
        <details class="more"><summary>詳しく</summary><p class="small">速度は一部モデルの目安で、モデルや状況で変わります。Claude Codeは対象外です。次の会話・ターミナル起動から反映します。OFFにすると全作業で加速しません。作業ごとの選択は残り、再びONにすると戻ります。</p></details></div>
      </div></section>
      <section class="pref-section" data-tab="connect"><h2 class="pref-caption">iPhone から使う</h2><div class="pref-list">
        <div class="pref-row pref-stack"><div class="pref-text"><h3>外から使う（iPhone）</h3><p>iPhoneからMacと同じ操作ができます。</p></div>
        <div id="remote-box" aria-live="polite">確認中…</div>
        <details class="more"><summary>使い始める手順</summary><ol class="small">
          <li>Mac と iPhone に Tailscale を入れ、同じアカウントでログインします。</li>
          <li><div>Mac のターミナルで <code>tailscale serve --bg 4545</code><button type="button" class="cp" data-copy="tailscale serve --bg 4545" title="コピー" aria-label="コピー">⧉ コピー</button> を1回だけ実行します。</div></li>
          <li>ここで合言葉（8文字以上）を保存し、「外から使う」をオンにします。</li>
          <li><div>iPhone の Safari で、上の「iPhone で開くアドレス」を開き、合言葉を入れます。<br>アドレスが出ていない時は、Mac のターミナルで <code>tailscale serve status</code><button type="button" class="cp" data-copy="tailscale serve status" title="コピー" aria-label="コピー">⧉ コピー</button> を実行します。1行目の <code>https://〜.ts.net</code> が開くアドレスです。</div></li>
          <li>共有メニューの「ホーム画面に追加」で、アプリのように開けます。</li></ol></details></div>
        <div class="pref-row pref-stack"><div class="pref-text"><h3>スマホの表示</h3><p>スマホの会話で出すAIの名前です。</p></div>
        <div id="phone-labels">${phoneLabelsHtml()}</div></div>
      </div></section>
      <section class="pref-section" data-tab="connect"><h2 class="pref-caption">GitHub</h2><div class="pref-list">
        <div class="pref-row pref-stack"><div id="github-box" aria-live="polite">確認中…</div></div>
      </div></section>
      <section class="pref-section" data-tab="connect"><h2 class="pref-caption">Mac</h2><div class="pref-list">
        <div class="pref-row pref-stack"><div class="pref-text"><h3>Mac のファイルの許可</h3><p>Hubが書類などのフォルダを読めるか確かめます。</p></div>
        <details class="more"><summary>詳しく</summary><p class="small">書類・デスクトップ・ダウンロードのフォルダを、Project Hub が読めるか確かめます。「システム設定 → プライバシーとセキュリティ → ファイルとフォルダ」に Project Hub が無い時は、［確認をもう一度出す］を押し、Mac の確認で「許可」を選んでください。</p></details>
        ${/ProjectHubApp/.test(navigator.userAgent) ? UI.template`<div class="acts"><a class="btn plain" href="hubapp://access">許可を確かめる</a><a class="btn" href="hubapp://access?reset=1">確認をもう一度出す</a></div>
        <details class="more"><summary>許可が出ない時</summary><p class="small">それでも出ない時は、確かめた後の画面の［フルディスクアクセスを開く］から、Project Hub をリストに入れてオンにしてください（アプリのメニューからも同じことができます）。</p></details>`
          : UI.html('<p class="small">アプリ（Project Hub.app）で開いた時に使えます。アプリが古い時は、ターミナルで <code>bash hub/app/build-app.sh</code> を実行して作り直してください。</p>')}</div>
      </div></section>
      <section class="pref-section" data-tab="manage"><h2 class="pref-caption">更新とバージョン</h2><div class="pref-list">
        <div class="pref-row pref-stack"><div class="pref-text"><h3>Project Hub の自動更新</h3></div><div id="app-update-box" aria-live="polite">確認中…</div></div>
        <div class="pref-row"><div class="pref-text"><h3>バージョン</h3><p>稼働：<b>v${esc(state.version || '')}</b> ／ 本体保存済み：<b>v${esc(state.saved?.version || state.latest || '')}</b>${state.latest && state.latest !== state.version ? UI.template`（新しい版 v${esc(state.latest)} を取り込み済み。上の［Update］で切り替わります）` : ''}</p></div><div class="pref-control">${hubUpdateButton()}</div>
        <details class="more" id="verd" ${verOpen ? 'open' : ''}><summary>変更の記録</summary><div id="verbox" class="small">読み込み中…</div></details></div>
      </div></section>
      <section class="pref-section" data-tab="manage"><h2 class="pref-caption">作業</h2><div class="pref-list">
        <div class="pref-row"><div class="pref-text"><h3>作業画面</h3><p><span class="badge ${state.terminal ? '' : 'off'}"><i></i>${state.terminal ? UI.text('画面の中で Claude Code / Codex / Agy CLI を動かせます') : UI.text('部品（node-pty）が未設定です。ターミナルで setup.sh を実行してください。それまでは別の窓で開きます')}</span></p></div>
        <details class="more"><summary>詳しく</summary><p class="small">権限：Claude Code は <code>${esc(state.roles.permissions['claude-code'] || '')}</code>、Codex は <code>${esc(state.roles.permissions.codex || '')}</code></p></details></div>
        <div class="pref-row"><div class="pref-text"><h3>空の作業を片付ける</h3><p>会話が空の作業を探して、まとめてゴミ箱へ移します。</p></div><div class="pref-control"><button class="btn plain" data-act="emptyscan" type="button">探す</button></div>
        <details class="more"><summary>詳しく</summary><p class="small">最初から選ばれるのは、派生・子プロジェクトで「やったこと」も空の作業だけです。</p></details>
        <div id="empty-box">${emptyHtml()}</div></div>
      </div></section>
      <section class="pref-section" data-tab="manage"><h2 class="pref-caption">記録</h2><div class="pref-list">
        <div class="pref-row pref-stack"><details class="more" id="logd"><summary>最近の操作（記録）</summary><div id="logbox" class="small">読み込み中…</div></details></div>
      </div></section>
    </div></div>`;
    selectSettingsTab(settingsTab);void refreshEmergencyStatus();
    renderedPhoneKey = phoneSettingsKey();
    drawAccountSettings(); syncRoleAccountChoices();
    $('#role-account-check')?.addEventListener('click', () => checkRoleAccounts().catch(() => {}));
    drawAiTools(); loadAiTools(); loadSkills(); $('#skills-check').addEventListener('click', () => loadSkills(true)); if (typeof loadAppUpdate === 'function') loadAppUpdate();
    loadCliModels(); loadRemote(); if (typeof loadGithub === 'function') loadGithub();
    loadLanguageSettings();
    loadMoveSettings();
  });
}
let moveSettingsTimer;
function moveSettingsHtml(s) {
  const messages = { none: '', exporting: '引っ越し用データを作成中…', exported: '引っ越し用データを作りました', importing: '引っ越しデータを読み込み中…', failed: '引っ越しを止めました', imported: '引っ越しデータを読み込みました', conflict: '読み込み先に既にデータがあります。アプリを開き直して読み込み方法を選んでください' };
  return UI.template`<p role="status">${esc(s.error || s.notice || messages[s.mode] || '')}${s.mode === 'exporting' ? esc(' ' + (s.progress || 0) + ' 件') : ''}</p>
    ${s.path ? `<p class="small">${esc(s.path)}</p><button class="btn plain" type="button" id="move-reveal">Finderで表示</button>` : ''}
    ${s.mode === 'imported' && s.bundle ? '<button class="btn plain" type="button" id="move-trash">読み込み済みの引っ越しデータをゴミ箱へ</button>' : ''}
    ${s.totals ? `<p class="small">${esc(s.totals.files)} ファイル・${esc(Math.ceil(s.totals.bytes / 1024 / 1024))} MB</p>` : ''}
    ${(s.notIncluded || []).length ? `<details><summary>含めなかったもの</summary><ul>${s.notIncluded.map(e => `<li>${esc(e.path)}：${esc(e.reason)}</li>`).join('')}</ul></details>` : ''}
    ${(s.attention || []).length ? `<p>確認が必要なリポジトリがあります。設定を確認してから作業を再開してください。</p><ul>${s.attention.map(e => `<li>${esc(e.path)}：${esc(e.reason)}</li>`).join('')}</ul>` : ''}`;
}
async function loadMoveSettings() {
  clearTimeout(moveSettingsTimer);
  const box = $('#move-status'), button = $('#move-export'); if (!box || !button) return;
  try {
    const s = await api('/api/move/status', null, { 'X-Hub': '1' });
    if ($('#move-status') !== box) return;
    box.innerHTML = moveSettingsHtml(s); button.disabled = s.mode === 'exporting';
    button.onclick = async () => {
      button.disabled = true;
      try { await api('/api/move/export', { includeBackups: $('#move-backups')?.checked === true }); await loadMoveSettings(); }
      catch (e) { box.textContent = e.message; button.disabled = false; }
    };
    $('#move-reveal')?.addEventListener('click', () => api('/api/move/reveal', {}).catch(e => toast(e.message)));
    $('#move-trash')?.addEventListener('click', async () => {
      if (!confirm(UI.text('読み込みが済んだ引っ越し用フォルダをゴミ箱へ移します。今使っているデータは残ります。進めますか？'))) return;
      try { await api('/api/move/trash', { bundle: s.bundle, confirm: true }); await loadMoveSettings(); } catch (e) { toast(e.message); }
    });
    if (s.mode === 'exporting') moveSettingsTimer = setTimeout(loadMoveSettings, 1000);
  } catch (e) { box.textContent = e.message; }
}
let languageSettings = null, languageNotice = '', languageBusy = false, languageDraft = null, languageLoadEpoch = 0;
function languageSettingsHtml(settings) {
  const choices = settings.packs.filter(pack => pack.usable).filter((pack, index, rows) => rows.findIndex(row => row.id === pack.id) === index);
  const chosen = languageDraft ?? settings.saved;
  const selected = chosen === 'ja' || choices.some(pack => pack.id === chosen) ? chosen : 'ja';
  return UI.template`<div class="pref-control"><select id="language-choice" aria-label="表示言語" ${languageBusy ? 'disabled' : ''}>
    <option value="ja" ${selected === 'ja' ? 'selected' : ''}>日本語（標準）</option>
    ${choices.map(pack => `<option value="${esc(pack.id)}" ${selected === pack.id ? 'selected' : ''}>${esc(pack.name)}</option>`).join('')}</select>
    <button type="button" class="btn plain" data-language="save" ${languageBusy ? 'disabled' : ''}>保存する</button></div>
    ${settings.fallback ? UI.html('<p class="note">選んだ言語パックが読めないため、日本語で表示しています。</p>') : ''}
    <details class="pref-more"><summary>言語パック</summary>
    <ul class="pref-packs">${settings.packs.map(pack => UI.template`<li><span class="pref-pack-name"><b>${esc(pack.name)}</b> <span class="small">${esc(pack.id)}・${pack.source === 'installed' ? UI.text('追加済み') : pack.source === 'external' ? UI.text('起動時に指定') : UI.text('本体同梱')}</span></span>
      ${pack.source === 'installed' ? UI.template`<button class="btn plain sm" type="button" data-language="remove" data-pack-id="${esc(pack.id)}" ${languageBusy ? 'disabled' : ''}>削除</button>` : ''}
      ${pack.reason ? `<p class="small">${esc(UI.text(pack.reason))}</p>` : ''}
      ${pack.verifiedWith && pack.verifiedWith !== settings.version ? UI.template`<p class="small">v${esc(pack.verifiedWith)} で確認されたパックです。今の版と違うため、一部が日本語で表示されることがあります。</p>` : ''}</li>`).join('')}</ul>
    <div class="pref-packs-add"><button type="button" class="btn plain sm" data-language="import" ${languageBusy ? 'disabled' : ''}>言語パックを追加…</button><span class="small">展開した言語パックのフォルダを選んで追加できます。</span></div>
    </details>
    <p id="language-notice" role="status" class="small">${esc(languageNotice)}</p>
    ${settings.restartNeeded ? UI.template`<div class="pref-actions"><button type="button" class="btn" data-language="restart" ${languageBusy ? 'disabled' : ''}>今すぐ再起動</button></div>` : ''}`;
}
function drawLanguageSettings() {
  const box = $('#language-box');
  if (box && languageSettings) {
    const open = box.querySelector('details')?.open === true;
    box.innerHTML = languageSettingsHtml(languageSettings);
    const details = box.querySelector('details');
    if (details) details.open = open;
  }
}
async function loadLanguageSettings() {
  const box = $('#language-box'); if (!box || languageBusy) return;
  const epoch = ++languageLoadEpoch;
  try {
    const result = await api('/api/langpacks');
    if ($('#language-box') !== box || languageBusy || epoch !== languageLoadEpoch) return;
    languageSettings = result; drawLanguageSettings();
  } catch (error) { if ($('#language-box') === box && epoch === languageLoadEpoch) box.textContent = error.status === 403 ? UI.text('言語の設定はこのパソコンから操作してください。') : error.message; }
}
document.addEventListener('change', event => { if (event.target.id === 'language-choice') languageDraft = event.target.value; });
async function applyLanguageRestart() {
  await api('/api/restart', {});
  languageNotice = UI.text('再起動しています…'); drawLanguageSettings();
  for (let i = 0; i < 60; i++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    try {
      const result = await api('/api/langpacks');
      if (!result.restartNeeded) { location.reload(); return; }
    } catch { /* 本体の再起動を待つ */ }
  }
  throw Error(UI.text('切り替わりませんでした。アプリを開き直してください'));
}
document.addEventListener('click', async event => {
  const button = event.target.closest?.('[data-language]');
  if (!button || languageBusy) return;
  const action = button.dataset.language, language = $('#language-choice')?.value, id = button.dataset.packId;
  if (action === 'remove' && !confirm(UI.text('この言語パックを削除しますか？ 使用中なら日本語に戻ります。'))) return;
  languageBusy = true; languageNotice = ''; ++languageLoadEpoch; drawLanguageSettings();
  try {
    if (action === 'import') {
      const picked = await api('/api/pick-folder', { prompt: UI.text('展開した言語パックのフォルダを選んでください') });
      if (!picked.path) return;
      languageSettings = await api('/api/langpacks/import', { dir: picked.path });
      languageNotice = UI.text('言語パックを追加しました。表示言語を選んで保存してください。');
    } else if (action === 'remove') {
      languageSettings = await api('/api/langpacks/remove', { id });
      if (languageDraft === id) languageDraft = null;
      languageNotice = UI.text('言語パックを削除しました。');
    } else if (action === 'save') {
      languageSettings = await api('/api/language', { language });
      languageDraft = null;
      languageNotice = UI.text('保存しました。Hub を再起動すると切り替わります。Mac アプリのメニューは、アプリを開き直した時に切り替わります。');
    } else if (action === 'restart') await applyLanguageRestart();
  } catch (error) { languageNotice = error.message; }
  finally { languageBusy = false; drawLanguageSettings(); }
});
// ChatGPT：実作業（ファイルの書き換え・コマンド）を許すか
// 説明のコピー用。Hubから起動・認証・外部通信は実行しない。
const CHATGPT_TUNNEL_START = String.raw`/bin/zsh -f -c 'if ! read -rs "PROJECT_HUB_TUNNEL_API_KEY?中継用の鍵を貼り付けて Enter: "; then printf "\n"; exit 1; fi; printf "\n"; [[ -n "$PROJECT_HUB_TUNNEL_API_KEY" ]] || exit 1; export PROJECT_HUB_TUNNEL_API_KEY; "$HOME/.local/bin/tunnel-client" doctor --profile hub --explain && "$HOME/.local/bin/tunnel-client" run --profile hub'`;
const CHATGPT_TUNNEL_CHECK = String.raw`/bin/zsh -f -c '
hub_pid=$(pgrep -f "(^|/)tunnel-client run --profile hub([[:space:]]|$)" 2>/dev/null | head -n 1)
if [[ -z "$hub_pid" ]]; then
  printf "中継は停止中です。\n"
  exit 1
fi
hub_port=$(lsof -nP -a -p "$hub_pid" -iTCP -sTCP:LISTEN -Fn 2>/dev/null | sed -n "s/^n127[.]0[.]0[.]1://p" | head -n 1)
if [[ -z "$hub_port" ]]; then
  printf "中継は動作中ですが、確認用の入口が見つかりません。\n"
  exit 1
fi
hub_ready=$(curl --noproxy "*" --max-time 3 --silent --output /dev/null --write-out "%{http_code}" "http://127.0.0.1:$hub_port/readyz")
if [[ "$hub_ready" == "200" ]]; then
  printf "中継は準備完了（ready）です。ChatGPTからの確認も行ってください。\n"
else
  printf "中継は動作中ですが、まだ準備完了を確認できません（HTTP %s）。\n" "$hub_ready"
fi
printf "詳しい状態：http://127.0.0.1:%s/ui\n" "$hub_port"
'`;
function chatgptConnectionHelpHtml() {
  const command = (label, text) => UI.template`<div class="codeblock"><div class="cb-head"><span>${esc(UI.text(label))}</span><button type="button" class="cb-copy">⧉ コピー</button></div><pre><code>${esc(text)}</code></pre></div>`;
  return UI.template`<details class="more chatgpt-connection-help" id="chatgpt-connection-help" data-ai-fold="mcp-help">
    <summary>つなぎ方・動作確認</summary>
    <p class="small">この許可はHubのMCPに接続したAIに適用されます。Hub内のChatGPT（Chat／Pro）は、この会話に文字で返答します。普段のChatGPTアプリからのMac・Hub操作は、下の中継の案内を確認してください。</p>
    <p class="small">普段のChatGPTアプリ → OpenAIの中継 → このMacの中継プログラム → Hub、という経路でつながります。Mac・Hub・中継プログラムが動いている間だけ使えます。</p>
    <p class="small"><b>「登録済み」や「実作業もできる」がオンでも、中継が今動いているとは限りません。</b>CodexのMac内の接続で成功しても、普段のChatGPT画面から使えるかは別に確かめます。</p>
    <h3>いま動いているか確かめる</h3>
    <ol class="small">
      <li>下の確認用コマンドをコピーし、Macのターミナルに貼り付けて実行します。鍵の入力は不要で、このMac内の状態だけを読み取ります。</li>
      <li>「中継は準備完了（ready）」なら中継の準備はできています。「停止中」なら下の起動方法へ進みます。動作中でも準備完了にならない場合は、起動したターミナルのエラーを確かめてください。</li>
      <li>普段のChatGPTで新しいチャットを開き、「Project Hub」を使う接続に選び、下の確認文を送ります。実際の道具の呼び出しが成功して一覧が返るところまで確かめてください。</li>
    </ol>
    ${command('Macの中継を確認（起動や設定変更はしません）', CHATGPT_TUNNEL_CHECK)}
    ${command('普段のChatGPTへ送る確認文', UI.text('Project Hubの道具を使って、プロジェクト一覧を取得してください。実際の呼び出しが成功したか、エラーが出たかも教えてください。'))}
    <p class="small">readyは中継の準備状況です。ChatGPTからの成功は、その画面での実際の呼び出しで判断します。書き込みも使う場合は、公開された道具に「hub_write_file」「hub_run_command」があることと、上の実作業許可がオンであることを確かめます。読み取り成功だけでは書き込み成功までは確認できません。</p>
    <h3>中継が止まっている時の起動方法</h3>
    <ol class="small">
      <li>Hubを起動したままにします。中継がすでに動作中なら、重ねて起動しないでください。</li>
      <li>中継用の鍵を用意します。鍵が必要な場合は、<a href="#" data-url="https://platform.openai.com/settings/organization/tunnels">OpenAIの中継設定</a>で既存のProject Hub用の接続を確認し、<a href="#" data-url="https://platform.openai.com/settings/organization/api-keys">鍵の設定</a>で本人が用意します。権限を選べる場合は「Tunnels」の「Read」「Use」に限定します。</li>
      <li>下の起動用コマンドをターミナルに貼り付けます。「中継用の鍵を貼り付けて Enter:」と出てから鍵を入力します。入力文字は表示されず、コマンド履歴や設定ファイルにも保存しません。</li>
      <li>診断が成功すると中継が動き続けます。このターミナルの窓は開いたままにしてください。終了・Macの再起動で中継が止まったら、次に使う時に起動し直します。</li>
      <li>上の稼働確認を行います。ChatGPTの道具一覧が古い場合は、ChatGPT側の既存の「Project Hub」の接続で、更新・再接続の項目を確認してから新しいチャットで試します。</li>
    </ol>
    ${command('停止中の中継を起動（鍵は表示後に本人が入力）', CHATGPT_TUNNEL_START)}
    <p class="small">鍵をこの会話・Hubの入力欄・起動コマンドの中に貼らないでください。料金条件は確認できていません。支払い登録・購入・入金を求められたら進めず、追加課金・API従量課金は使いません。失敗した時はエラーの文章を控え、原因を直してから確認します。</p>
    <p class="small"><a href="#" data-url="https://developers.openai.com/api/docs/guides/secure-mcp-tunnels">OpenAI公式の中継ガイド</a></p>
  </details>`;
}
const SEND_TEXT_RULE = UI.text('人が他のAI・アプリ・会話へ送る文は、本文だけを独立した ```text 枠に入れ、送り先と「枠内を全部コピーして送る」は枠外に書く。引用記号・説明を枠に入れず、送り先・送信ごとに枠を分ける。');
function gptChildLink(project, task) {
  return UI.template`<p><button type="button" class="btn plain sm" data-go="work" data-p="${esc(project)}" data-t="${esc(task)}">GPT子を開く</button></p>`;
}
async function loadChatgpt() {
  const box = $('#chatgpt-box'); if (!box) return;
  const epoch = ++chatgptLoadEpoch;
  try {
    const r = await api('/api/chatgpt');
    if ($('#chatgpt-box') !== box || epoch !== chatgptLoadEpoch) return;
    const work = chatgptWorkPending === null ? r.work : chatgptWorkPending;
    preserveSettingsScroll(() => {
      box.innerHTML = UI.template`<label class="chk"><input type="checkbox" id="chatgpt-work" ${work ? 'checked' : ''} ${chatgptWorkPending === null ? '' : 'disabled'}> 実作業も許可（ファイル変更・コマンド）</label>`;
      $('#chatgpt-mcp-status').textContent = work ? UI.text('実作業可') : UI.text('読み取りのみ');
    });
  } catch (e) { if ($('#chatgpt-box') === box && epoch === chatgptLoadEpoch) { box.textContent = UI.text('読み込めませんでした'); $('#chatgpt-mcp-status').textContent = UI.text('取得失敗'); } }
}
document.addEventListener('change', async e => {
  if (e.target.id !== 'chatgpt-work' || chatgptWorkPending !== null) return;
  const work = e.target.checked;
  chatgptWorkPending = work; ++chatgptLoadEpoch; e.target.disabled = true;
  try { await api('/api/chatgpt', { work }); toast(work ? UI.text('MCPにファイル変更・コマンド実行を許しました') : UI.text('MCPのファイル変更・コマンド実行を無効にしました')); }
  catch (err) { toast(err.message); }
  finally { chatgptWorkPending = null; loadChatgpt(); }
});
// 外から使う（iPhone）：設定を読み込んで出す・変える
async function loadRemote() {
  const box = $('#remote-box'); if (!box) return;
  try {
    const r = await api('/api/remote');
    if ($('#remote-box') !== box) return;
    box.innerHTML = UI.template`<label class="chk"><input type="checkbox" id="remote-on" ${r.enabled ? 'checked' : ''} ${r.hasPasscode ? '' : 'disabled'}> 外から使う${r.hasPasscode ? '' : UI.text('（先に合言葉を保存してください）')}</label>
      <div class="acts" style="margin-top:8px"><input type="password" id="remote-pass" autocomplete="new-password" minlength="8" maxlength="200" placeholder="${r.hasPasscode ? UI.text('新しい合言葉（8文字以上）') : UI.text('合言葉（8文字以上）')}">
        <button class="btn plain" id="remote-pass-save" type="button">合言葉を保存</button></div>
      <p class="small">${r.hasPasscode ? UI.text('合言葉は保存済みです。変えると、入っている端末はすべて出ます。') : UI.text('まだ合言葉がありません。')}</p>
      <p>iPhone で開くアドレス：${r.url ? UI.template`<b>${esc(r.url)}</b><button type="button" class="cp" data-copy="${esc(r.url)}" title="コピー" aria-label="コピー">⧉ コピー</button>` : UI.html('<span class="small">見つかりません（Tailscale が動いていないか、Mac に入っていません。下の「使い始める手順」を見てください）</span>')}</p>
      <div class="acts"><span>ログイン中の端末：${r.sessions.length} 台</span>
        <button class="btn plain" id="remote-logout-all" type="button" ${r.sessions.length ? '' : 'disabled'}>すべての端末から出る</button></div>
`;
  } catch (e) { if ($('#remote-box') === box) box.textContent = UI.text('読み込めませんでした'); toast(e.message); }
}
document.addEventListener('click', async e => {
  const id = e.target.id;
  if (id !== 'remote-pass-save' && id !== 'remote-logout-all') return;
  try {
    if (id === 'remote-pass-save') {
      const v = $('#remote-pass').value;
      if ([...v].length < 8) return toast(UI.text('合言葉は8文字以上にしてください'));
      await api('/api/remote', { passcode: v }); toast(UI.text('合言葉を保存しました'));
    } else { await api('/api/remote/logout-all', {}); toast(UI.text('すべての端末から出ました')); }
  } catch (err) { toast(err.message); }
  loadRemote();
});
document.addEventListener('change', async e => {
  if (e.target.id !== 'remote-on') return;
  try { await api('/api/remote', { enabled: e.target.checked }); toast(e.target.checked ? UI.text('外から使えるようにしました') : UI.text('外からの利用をオフにしました')); }
  catch (err) { toast(err.message); }
  loadRemote();
});
// CLI に渡すモデル名：読み込んで表にする・保存する
let cliModelsLoadSeq = 0;
let accelerationRevision = 0, accelerationSaving = false;
function renderAcceleration(settings) {
  return preserveSettingsScroll(() => {
    const box = $('#acceleration'); if (!box || accelerationSaving) return;
    const on = settings?.codexAllowed === true;
    box.innerHTML = UI.template`<label><input type="checkbox" id="codex-fast" data-saved="${on}" ${on ? 'checked' : ''}> 作業ごとに選べるようにする（<span id="codex-fast-state">${on ? 'ON' : 'OFF'}</span>）</label>`;
  });
}
async function saveCodexFast(input) {
  if (accelerationSaving || $('#codex-fast') !== input) return;
  const before = input.dataset.saved === 'true', wanted = input.checked;
  accelerationSaving = true; accelerationRevision++; ++stateLoadEpoch;
  input.disabled = true;
  try {
    const saved = await api('/api/acceleration', { codexAllowed: wanted });
    state.acceleration = saved;
    input.checked = saved.codexAllowed === true;
    input.dataset.saved = String(input.checked);
    toast(input.checked ? UI.text('作業ごとに加速を選べるようにしました') : UI.text('全作業の加速を無効にしました'));
  } catch (err) { input.checked = before; toast(UI.text('加速設定を保存できませんでした：') + err.message); }
  finally {
    accelerationSaving = false; accelerationRevision++; ++stateLoadEpoch;
    input.disabled = false;
    if ($('#codex-fast') === input) $('#codex-fast-state').textContent = input.checked ? 'ON' : 'OFF';
    else if (view.kind === 'settings') loadCliModels(true);
    syncTaskFastPickers(); // 保存中に移動した作業画面も、確定した利用許可へ同期する。
  }
}
document.addEventListener('change', e => {
  if (e.target.hasAttribute?.('data-task-fast')) void saveTaskFast(e.target);
  if (e.target.id === 'codex-fast') void saveCodexFast(e.target);
});
async function loadCliModels(keepDraft = false) {
  const box = $('#climodels'); if (!box) return;
  const seq = ++cliModelsLoadSeq;
  const speedRevision = accelerationRevision;
  try {
    const r = await api('/api/cli-models');
    if ($('#climodels') !== box || seq !== cliModelsLoadSeq) return;
    if (speedRevision === accelerationRevision) renderAcceleration(r.acceleration);
    const draft = new Map();
    if (keepDraft) document.querySelectorAll('input.cm').forEach(el => draft.set(`${el.dataset.ai}/${el.dataset.name}`, el.value));
    const table = ai => UI.template`<div class="tbl"><table><tr><th>${AI_LABEL[ai]}</th><th>CLI に渡す名前</th></tr>${(r[ai] || []).map(x => UI.template`<tr><td class="now">${esc(x.name)}</td><td><input class="cm" data-ai="${ai}" data-name="${esc(x.name)}" value="${esc(x.flag)}" list="hint-${ai}" placeholder="（空＝${AI_LABEL[ai]} の既定のモデル）" maxlength="60"></td></tr>`).join('')}</table></div>
      <datalist id="hint-${ai}">${(r.hints[ai] || []).map(h => UI.template`<option value="${esc(h)}">`).join('')}</datalist>`;
    preserveSettingsScroll(() => { box.innerHTML = UI.template`${table('claude')}${table('codex')}<p>Grok：モデル一覧のIDをそのまま使います。</p><p>Agy CLI：${esc((state.agyModels || []).map(m => m.label + '（' + m.id + '）').join(' / ') || UI.text('利用可能なモデルなし'))}（Hubが確認した最新の一覧）</p>
      ${(r.hints.codex || []).length ? UI.template`<p class="small">Codex の設定で見つかった名前：${r.hints.codex.map(esc).join('、')}</p>` : ''}
      <div class="acts" style="margin-top:10px"><button class="btn" id="cm-save" type="button">保存する</button></div>`; });
    if (keepDraft) document.querySelectorAll('input.cm').forEach(el => { const key = `${el.dataset.ai}/${el.dataset.name}`; if (draft.has(key)) el.value = draft.get(key); });
  } catch (e) {
    if ($('#climodels') !== box || seq !== cliModelsLoadSeq) return;
    preserveSettingsScroll(() => { box.textContent = UI.text('読み込めませんでした'); });
    const speedBox = $('#acceleration');
    if (speedBox && speedRevision === accelerationRevision && !accelerationSaving) speedBox.textContent = UI.text('読み込めませんでした。設定を開き直してください');
  }
}
document.addEventListener('click', async e => {
  if (e.target.id !== 'cm-save') return;
  const o = { claude: {}, codex: {} };
  document.querySelectorAll('input.cm').forEach(i => { o[i.dataset.ai][i.dataset.name] = i.value.trim(); });
  try { await api('/api/cli-models', o); toast(UI.text('モデル名を保存しました（次に送る時から使います）')); loadCliModels(); } catch (err) { toast(err.message); }
});
// 全画面の保持状態からHub/CLIの更新表示をまとめる。表示のためにCLIを実行しない。
function updateLabel(version, latest) {
  const hub = latest && version && latest !== version;
  const cli = state.aiCliUpdate?.available === true;
  if(state.restart?.reserved)return UI.text('再起動を予約中');
  return hub ? `Update v${latest}${cli ? ' / AI CLI' : ''}` : cli ? 'Update AI CLI' : '';
}
function showVersion(version, latest) {
  $('#master-badge').hidden = state.license?.edition !== 'owner';
  $('#ver').textContent = version ? UI.text('稼働')+' v' + version : '';
  $('#ver').title=UI.text('本体保存済み')+' v'+(latest||version||'')+' / '+(state.restart?.waiting||[]).map(x=>x.message).join(' / ');
  if ($('#upd').disabled) return;
  const label = updateLabel(version, latest);
  $('#upd').hidden = !label;
  if (label) $('#upd').textContent = label;
}
function restartControls() {
  const r=state.restart || {};
  if(r.committed)return UI.template`<span class="small">再起動を開始しています</span>`;
  if(r.reserved)return UI.template`<span class="small">再起動を予約中</span><button type="button" class="btn plain" data-restart-cancel>再起動予約を取消</button><span class="small">${esc(r.error || (r.waiting || []).map(x=>x.message).join(' / '))}</span>`;
  return UI.template`<button type="button" class="btn plain" data-restart-reserve>${state.restartBusy ? UI.text('終了後に再起動を予約') : UI.text('Hubを再起動')}</button>`;
}
document.addEventListener('click',async e=>{
  if(!e.target.closest?.('[data-restart-reserve],[data-restart-cancel]'))return;
  try {
    const cancel=Boolean(e.target.closest('[data-restart-cancel]'));
    const r=await api(cancel?'/api/restart/cancel':'/api/restart',{reserve:true});
    stateLoadEpoch++;state.restart=r.restart;observeRestart(state);drawAiTools();
    toast(UI.text(cancel?'再起動予約を取り消しました。':r.restart.reserved?'再起動を予約しました。処理の終了を待ちます。':'再起動を開始しています'));
    if(r.restart.committed){for(let i=0;i<60;i++){await new Promise(resolve=>setTimeout(resolve,500));try{observeRestart(await api('/api/state'));if(restartReloaded)return;}catch{}}}
  }catch(e){toast(e.message);}
});
function hubUpdateButton() {
  return state.latest && state.version && state.latest !== state.version
    ? UI.template`<button class="btn plain" type="button" data-hub-update>Hub を v${esc(state.latest)} に切り替える</button>` : '';
}
function updateBlocked() {
  return state.updateBlocked || state.aiCliUpdate?.busyCount || (state.chatting || []).length || (state.sessions || []).some(s => s.running);
}
async function switchHubUpdate() {
  if ($('#upd').disabled) return;
  if (state.latest && state.version && state.latest !== state.version) await restartHub();
}
async function openUpdate() {
  if ($('#upd').disabled) return;
  if(state.restart?.reserved){view={...view,kind:'settings'};settingsTab='ai';render();return;}
  if (state.aiCliUpdate?.available) {
    const both = state.latest && state.version && state.latest !== state.version;
    view = { ...view, kind: 'settings' }; settingsTab = 'ai'; render();
    toast(UI.text(both ? 'CLIは［一括更新］、Hubだけなら［Hub を v版 に切り替える］を押してください。' : 'AI CLIは設定の［一括更新］から更新できます。'));
    return;
  }
  await switchHubUpdate();
}
let verOpen = false;
async function loadChangelog() {
  const box = $('#verbox'); if (!box) return;
  try {
    const rows = await api('/api/changelog');
    box.innerHTML = UI.template`<ul class="log">${rows.map(r => UI.template`<li><b>v${esc(r.version)}</b> <span class="small">${esc(r.date)}</span><ul>${r.items.map(x => UI.template`<li>${esc(x)}</li>`).join('')}</ul></li>`).join('')}</ul>`;
  } catch (e) { box.textContent = UI.text('読み込めませんでした'); }
}
// 新しい版にする：本体を起動し直し、戻ってきたら画面を読み直す
async function restartHub() {
  const b = $('#upd'); b.disabled = true; b.textContent = UI.text('切り替えています…');
  try { const r=await api('/api/restart', {reserve:true}); stateLoadEpoch++;state.restart=r.restart;observeRestart(state); if(r.restart?.reserved){toast(UI.text('再起動を予約しました。処理が終わると一度だけ再起動します。'));b.disabled=false;render();return;} }
  catch (e) { toast(e.message); b.disabled = false; render(); return; }
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    try { observeRestart(await api('/api/state')); if (restartReloaded) return; } catch (e) { /* まだ */ }
  }
  toast(UI.text('切り替わりませんでした。アプリを開き直してください'));
}
const ACTION = { gptchat: UI.text('GPT子への依頼を保存した'), dot: UI.text('Dotへの依頼を保存した'), githubcreate: UI.text('GitHubの非公開リポジトリ作成を実行した'), githubconnect: UI.text('既存GitHubへの接続を実行した'), emptytrash: UI.text('空の作業を片付けた'), chatredo: UI.text('取り消してやり直した'), chatamend: UI.text('追加説明を送った'), chatqueue: UI.text('順番待ちにした'), chatqueueedit: UI.text('待ち指示を編集した'), climodels: UI.text('モデル名を直した'), refs: UI.text('参考を足した'), restart: UI.text('新しい版にした'), chat: UI.text('会話で頼んだ'), newproject: UI.text('プロジェクトを作った'), start: UI.text('始めた'), stop: UI.text('止めた'), handoff: UI.text('交代した'), upload: UI.text('ファイルを渡した'), switch: UI.text('モデル・思考を変えた'), merge: UI.text('本体に取り込んだ'), mergeexclude: UI.text('取り込み対象から外した'), mergeinclude: UI.text('取り込み対象に戻した'), nextphase: UI.text('次のフェーズへ'), projectdone: UI.text('プロジェクトを完了にした'), projectreopen: UI.text('プロジェクトの完了を取り消した'), newtask: UI.text('作業を足した'), chatgpt: UI.text('ChatGPT が道具を使った'), chatgptwork: UI.text('ChatGPT の実作業の設定を変えた') };
async function loadLog() {
  const box = $('#logbox'); if (!box) return;
  try {
    const rows = await api('/api/log?n=30');
    box.innerHTML = rows.length ? UI.template`<ul class="log">${rows.map(r => UI.template`<li><span class="small">${esc(new Date(r.at).toLocaleString(UI.dateLocale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}</span> ${esc(r.project || '')}${r.task ? '・' + esc(r.task) : ''}：${esc(ACTION[r.action] || r.action)}${r.ai ? `（${esc(AI_LABEL[r.ai] || r.ai)}）` : ''}${r.action === 'merge' && r.conflict ? UI.text('・ぶつかったので中止') : ''}</li>`).join('')}</ul>` : UI.html('<p class="note">まだありません。</p>');
  } catch (e) { box.textContent = UI.text('読み込めませんでした'); }
}
async function saveRoles() {
  try { state.roles = await api('/api/roles', { roles: rolesDraft, checkCredits: checkCreditsDraft, preferCredits: preferCreditsDraft, expectedRevision: rolesDraftRevision || 'reload-required' }); clearRolesDraft(); toast(UI.text('役割分担とクレジット設定を保存しました')); render(); }
  catch (e) { toast(e.message); }
}

// 空の作業を片付ける：探した結果（画面を描き直しても残す）
let emptyFound = null;
function emptyHtml() {
  if (!emptyFound) return '';
  if (!emptyFound.length) return UI.html('<p class="small">片付ける物はありません。</p>');
  const row = (x, key, label, sub) => UI.template`<label class="chk"><input type="checkbox" data-key="${esc(key)}" ${x.pick ? 'checked' : ''}> ${label}${sub ? UI.template`<span class="small">　${sub}</span>` : ''}</label>`;
  return emptyFound.map(x => x.whole
    ? row(x, x.project + '/', UI.template`<b>子プロジェクトごと</b>：${esc(x.projectName)}`, UI.template`作業 ${x.tasks.length} 件・すべて会話が空`)
    : row(x, x.project + '/' + x.task, `${esc(x.projectName)} / ${esc(x.title)}`, `${esc(x.state)}${x.done ? UI.text('・やったこと：') + esc(x.done.replace(/\s+/g, ' ').slice(0, 80)) : ''}`)).join('')
    + UI.html('<div class="acts"><button class="btn plain sm" data-act="emptyall" data-on="1" type="button">すべて選ぶ</button><button class="btn plain sm" data-act="emptyall" data-on="0" type="button">すべて外す</button><button class="btn" data-act="emptytrash" type="button">選んだ物をゴミ箱へ</button></div>');
}
// ---- 操作 ----
async function act(el) {
  const a = el.dataset.act, p = el.dataset.p || view.project, t = el.dataset.t;
  try {
    if (a.startsWith('freetalk') && (a === 'freetalkclean' ? [...chatImageUploads.entries()].some(([key,n])=>n && JSON.parse(key)[0]==='freetalk') : chatImageUploads.get(chatAttachmentKey('freetalk',t || view.task)))) { toast(UI.text('添付ファイルを追加中です。終了後に操作してください')); return; }
    if (a === 'freetalkclean') {
      if(el.disabled)return;
      if(!confirm(UI.text('freetalkの全話題・会話・添付・相談ファイル・メモリをゴミ箱へ移します。AI設定とプロジェクト化した内容は残ります。掃除しますか？')))return;
      el.disabled=true;const active=beginFreetalkCleanupOperation();
      try{await api('/api/freetalk/clean',{project:'freetalk',confirm:true});if(!active())return;freetalkPromotionDrafts.clear();freetalkPromotionErrors.clear();view={kind:'project',project:'freetalk',task:null};save();await load();toast(UI.text('掃除しました。次の期限は1か月後です'));}
      catch(e){if(active())throw e;}finally{el.disabled=false;}
    }
    else if(a==='freetalkautopromote') {
      if(el.disabled)return;el.disabled=true;
      const active=beginFreetalkPromotionOperation(t,true);
      try {
        const r=await api('/api/freetalk/project-start',{project:p,task:t});
        if(!active())return;
        freetalkPromotionDrafts.delete(t);freetalkPromotionErrors.delete(t);
        if(r.project){view={kind:'work',project:r.project,task:r.task};save();await load();}
      }catch(e){if(active())freetalkPromotionErrors.set(t,{message:e.message,automatic:true});}
      finally{el.disabled=false;if(active()){freetalkPromotionOperations.get(t).pending=false;await syncFreetalkHistory(proj(p),taskOf(proj(p),t));}}
    }
    else if(['freetalkpromote','freetalkresummary','freetalkretry'].includes(a) && !(a==='freetalkretry' && freetalkPromotionErrors.get(t)?.cancel)) {
      if(el.disabled)return;el.disabled=true;
      const active=beginFreetalkPromotionOperation(t,true);
      const create=document.querySelector('.freetalk-promotion [data-act="freetalkcreate"]');if(create)create.disabled=true;
      // A failed status-only retry must not become a promotion request.
      let retryPromotion=a!=='freetalkretry' || freetalkPromotionErrors.has(t);
      try {
        let h=await api('/api/freetalk/status?project=freetalk&task='+encodeURIComponent(t));
        if(!active())return;
        retryPromotion ||= h.promotionRequested || freetalkPromotionDrafts.has(t);
        if(h.reason)throw Error(h.reason);
        if(!retryPromotion)return;
        freetalkPromotionErrors.delete(t);
        if(a!=='freetalkresummary' && h.draft && !h.stale) {
          if(!h.promotionRequested)h=await api('/api/freetalk/promotion-intent',{project:p,task:t,requested:true});
          if(!active())return;
          taskOf(proj(p),t).freetalkHistory=h;
          await prepareFreetalkPromotion(t,active);
        } else {
          await api('/api/freetalk/summary',{project:p,task:t,intent:'promote'});
        }
      }catch(e){if(active() && retryPromotion)freetalkPromotionErrors.set(t,e.message);}
      finally{el.disabled=false;if(active()){freetalkPromotionOperations.get(t).pending=false;await syncFreetalkHistory(proj(p),taskOf(proj(p),t));}}
    }
    else if(a==='freetalkcancel' || (a==='freetalkretry' && freetalkPromotionErrors.get(t)?.cancel)) {
      if(el.disabled || freetalkPromotionDrafts.get(t)?.creating)return;
      el.disabled=true;
      const active=beginFreetalkPromotionOperation(t,true);
      const create=document.querySelector('.freetalk-promotion [data-act="freetalkcreate"]');if(create)create.disabled=true;
      try{await api('/api/freetalk/promotion-intent',{project:p,task:t,requested:false});if(!active())return;freetalkPromotionDrafts.delete(t);freetalkPromotionErrors.delete(t);}
      catch(e){if(active())freetalkPromotionErrors.set(t,{message:e.message,cancel:true});}
      finally{el.disabled=false;if(active()){freetalkPromotionOperations.get(t).pending=false;await syncFreetalkHistory(proj(p),taskOf(proj(p),t));}}
    }
    else if(a==='freetalkcreate') {
      const d=freetalkPromotionDrafts.get(t);if(el.disabled || freetalkPromotionBlocked(taskOf(proj(p),t)))return;el.disabled=true;d.creating=true;
      try {
        const r=await api('/api/freetalk/promote',{...d,available:undefined,project:p,task:t,confirm:true});
        freetalkPromotionDrafts.delete(t);freetalkPromotionErrors.delete(t);view={kind:'work',project:r.project,task:r.task};closeDrawer();save();await load();toast(UI.text('独立したプロジェクトを作りました'));
      }catch(e){d.error=e.message;d.creating=false;await syncFreetalkHistory(proj(p),taskOf(proj(p),t));}
      finally{el.disabled=false;d.creating=false;}
    }
    else if (a === 'freetalkdelete') {
      if(el.disabled)return;
      const topic=taskOf(proj('freetalk'),el.dataset.t);if(!topic)return;
      if(!confirm(UI.template`話題「${topic.title}」と、その会話記録・添付ファイル・メモリをすべてゴミ箱へ移します。プロジェクトへ引き継いだ内容は残ります。削除しますか？`))return;
      el.disabled=true;const active=beginFreetalkPromotionOperation(topic.id);
      try{await api('/api/freetalk/delete',{project:'freetalk',task:topic.id,confirm:true});if(!active())return;freetalkPromotionDrafts.delete(topic.id);freetalkPromotionErrors.delete(topic.id);chatAttachments.delete(chatAttachmentKey('freetalk',topic.id));
        if(view.project==='freetalk' && view.task===topic.id){closePanes();view={kind:'project',project:'freetalk',task:null};save();}
        renderedMainKey='';await load();toast(UI.text('話題を削除しました'));}
      catch(e){if(active())throw e;}finally{el.disabled=false;}
    }
    else if (a === 'freetalknew') {
      el.disabled = true;
      try { const topic = await api('/api/freetalk/topic', {}); view = { kind: 'work', project: 'freetalk', task: topic.id }; closeDrawer(); save(); await load(); await api('/api/task/read', { project: 'freetalk', task: topic.id }); }
      finally { el.disabled = false; }
    }
    else if (['freetalksummary','freetalkclear','freetalkcontinue'].includes(a)) {
      if(el.disabled)return;
      const topic=taskOf(proj(p),t), h=topic?.freetalkHistory;
      if (!h || h.reason) { toast(h?.reason || UI.text('話題の状態を確認してください')); return; }
      if (a === 'freetalksummary') {
        el.disabled=true;const active=beginFreetalkPromotionOperation(t);
        try { await api('/api/freetalk/summary',{project:p,task:t});if(!active())return;freetalkPromotionDrafts.delete(t);freetalkPromotionErrors.delete(t); toast(UI.text('この話題のAIに要約を頼みました。返事の後に確認・編集できます')); }
        catch(e){if(active())toast(e.message);}finally{try{if(active())await load({preserveMain:true});}catch(e){if(active())toast(e.message);}finally{el.disabled=false;}}
      }
      else {
        if (a === 'freetalkclear' && !confirm(UI.text('この話題の会話・全AIの再開情報・引き継ぎ控え・メモリ・添付ファイル（コピー）をゴミ箱へ移して、空の会話にしますか？元のファイルは残ります。'))) return;
        const body={project:p,task:t,confirm:true,revision:h.revision};
        if (a === 'freetalkcontinue' && !confirm(UI.text('確認した要約で新しい会話を始めます。添付ファイルは残ります。続けますか？'))) return;
        if (a === 'freetalkcontinue') { body.summaryId=h.summaryId; body.summary=document.querySelector('.freetalk-summary-input')?.value || ''; }
        el.disabled=true;const active=beginFreetalkPromotionOperation(t);
        try {
          await api('/api/freetalk/rotate',body);if(!active())return;freetalkPromotionDrafts.delete(t);freetalkPromotionErrors.delete(t);
          const key=chatAttachmentKey(p,t); delete chatDraft[key]; instructionHistory.reset(key);
          clearSentChatImages(p,t,[...chatImages(p,t)]); freetalkSummaryDrafts.delete(p+'/'+t+'/'+h.summaryId);
          closePanes(); renderedMainKey=''; await load(); toast(a==='freetalkclear' ? UI.text('空の会話にしました') : UI.text('確認した要約で続けられます'));
        } catch(e){if(active())throw e;}finally { el.disabled=false; }
      }
    }
    else if (a === 'start') await startAI(p, t, el.dataset.ai);
    else if (a === 'stop') { const r=await api('/api/term/stop', { project: p, task: t, ai: el.dataset.ai }); toast(r.ok?'停止処理を終えました。終了と保存の結果は設定の［復旧］で確認できます':'停止を確認できないAIがあります。設定の［復旧］を確認してください'); await load(); }
    else if (a === 'handoff') {
      if (taskFastSaving || accelerationSaving) { toast(UI.text('加速の選択を保存中です')); return; }
      el.disabled = true;
      try {
        const r = await api('/api/term/handoff', { project: p, task: t, from: el.dataset.from, to: el.dataset.to, cols: 100, rows: 30 });
        toast(UI.template`${r.started ? UI.template`${AI_LABEL[r.ai || el.dataset.to]} を始め、` : UI.template`${AI_LABEL[r.ai || el.dataset.to]} に`}引き継ぎ資料を渡しました${r.kind === 'screen' ? UI.text('（会話の記録が読めず、画面の文字で代わりにしました）') : ''}`);
      } finally { await load(); }
    }
    else if (a === 'files') await openFiles(el);
    else if (a === 'mode') setMode(el.dataset.m);
    else if (a === 'split') splitProject(proj(p));
    else if (a === 'handoff-parent') {
      const r = await api('/api/project/handoff', { project: p });
      toast(UI.template`親「${r.parent || ''}」の作業に結果を書き込みました`); await load();
    }
    else if (a === 'pstatus') {
      const done = el.dataset.s === '完了';
      if (done && !confirm(UI.text('このプロジェクトを完了にしますか？（あとで［完了を取り消す］で戻せます）'))) return;
      await api('/api/project/status', { project: p, status: el.dataset.s, confirm: true, expectedHash: proj(p).completionHash }); toast(done ? UI.text('プロジェクトを完了にしました') : UI.text('完了を取り消しました')); await load();
    }
    else if (a === 'nextphase') {
      const info = phaseInfo(proj(p));
      if (!confirm(info.cur === info.list.length - 1 ? UI.text('最後のフェーズとプロジェクトを完了に移しますか？') : UI.text('今のフェーズを完了に移して、次へ進みますか？'))) return;
      await api('/api/phase/next', { project: p, confirm: true, expectedHash: proj(p).completionHash }); toast(UI.text('フェーズを完了にしました')); await load();
    }
    else if (a === 'phasecontinue') { await api('/api/phase/continue', { project: p, expectedHash: proj(p).completionHash }); toast(UI.text('このフェーズを続けます')); await load(); }
    else if (a === 'resultsorganize') {
      el.disabled = true;
      try { await api('/api/task/results/organize', {project:p, task:t, expectedHash:taskOf(proj(p),t).completionHash}); toast(UI.text('成果の整理を頼みました')); await load(); }
      finally {el.disabled = false;}
    }
    else if (a === 'tasktidy') return await showTidy(p, t);
    else if (a === 'taskcomplete' || a === 'taskcontinue') {
      if (a === 'taskcomplete') return showCompletion(p, t, taskOf(proj(p), t).completionHash);
      await api('/api/task/completion', { project: p, task: t, action: a === 'taskcomplete' ? 'approve' : 'continue', confirm: true, expectedHash: taskOf(proj(p), t).completionHash }); toast(a === 'taskcomplete' ? UI.text('完了に移しました') : UI.text('この作業を続けます')); await load();
    }
    else if (a === 'mergeexclude' || a === 'mergeinclude') {
      const excluded = a === 'mergeexclude';
      if (excluded && !confirm(UI.text('本体に取り込まず、取り込み対象から外しますか？作業用コピーとファイルは残り、同じ場所で作業を続けられます。あとで［取り込み対象に戻す］で戻せます。'))) return;
      el.disabled = true;
      try {
        await api('/api/task/merge-exclusion', { project: p, task: t, excluded });
        toast(excluded ? UI.text('取り込み対象から外しました。作業用コピーは残しています') : UI.text('取り込み対象に戻しました'));
      } finally { await load(); }
    }
    else if (a === 'emptyscan') { emptyFound = (await api('/api/empty/scan', {})).items; $('#empty-box').innerHTML = emptyHtml(); }
    else if (a === 'emptyall') document.querySelectorAll('#empty-box input[type=checkbox]').forEach(i => { i.checked = el.dataset.on === '1'; });
    else if (a === 'emptytrash') {
      const keys = [...document.querySelectorAll('#empty-box input:checked')].map(i => i.dataset.key);
      if (!keys.length) { toast(UI.text('選ばれていません')); return; }
      if (!confirm(UI.template`${keys.length} 件をゴミ箱へ移しますか？（ゴミ箱から戻せます）`)) return;
      const items = keys.map(k => { const i = k.indexOf('/'); return { project: k.slice(0, i), task: k.slice(i + 1) || undefined }; });
      const r = await api('/api/empty/trash', { items });
      emptyFound = null; toast(UI.template`${r.moved} 件をゴミ箱へ移しました`); await load();
    }
    else if (a === 'handup') await showTaskTransfer(p,t,[],el.dataset.expectTitle);
    else if (a === 'integrate') await showTaskIntegration(p,t);
    else if (a === 'absorb') {
      const legacy=(state.taskHandoffs || []).some(r=>r.project===p&&r.task===t);
      if(legacy)await showTaskTransfer(p,t,[],el.dataset.expectTitle);
      else await showTaskIntegration(view.project,view.task,[{project:p,task:t,expectTitle:el.dataset.expectTitle}]);
    }
    else if (a === 'copyclear') { const r = await api('/api/task/copyclear', { project: p, task: t }); toast(r.merged ? UI.text('本体に取り込み済みでした。記録を片付けたので、続きは本体で始められます') : UI.text('記録を片付けました。続きは本体で始められます')); await load(); }
    else if (a === 'merge') {
      el.disabled = true;
      await runOneclickMain(p,t);
    }
    else if (a === 'answered') { if (chatSending.has(chatAttachmentKey(p,t))) return; if (!confirm(UI.text('この質問を AI に送らずに消しますか？ AI は続きを始めません。答えを伝えたい時は［この作業で AI に送る］か［選んで送る］を使ってください。'))) return; await api('/api/task', { project: p, task: t, question: '', state: '実行中', memo: UI.text('人が質問を AI に送らずに消した') }); toast(UI.text('質問を消しました（AI には送っていません）')); await load(); }
  } catch (e) { toast(e.message); } finally {if(a.startsWith('freetalk'))persistFreetalkPromotionDrafts();}
}

document.addEventListener('click', e => {
  const button = e.target.closest('[data-theme-choice]');
  if (!button) return;
  const saved = window.HubTheme.set(button.dataset.themeChoice);
  toast(saved ? UI.text('配色を保存しました') : UI.text('配色を変更しましたが、保存できませんでした。次回は以前の配色に戻ります。'));
});

document.addEventListener('click', e => {
  if (!e.target.closest('#menu') && !e.target.closest('[data-tree-menu]') && !e.target.closest('[data-act="files"]')) $('#menu').hidden = true;
  const tg = e.target.closest('[data-toggle]');
  if (tg) { const id = tg.dataset.toggle; open.has(id) ? open.delete(id) : open.add(id); save(); renderTree(); if(tg.dataset.sidebarGroup)$('#sidebar-'+tg.dataset.sidebarGroup+'-toggle')?.focus({preventScroll:true}); e.stopPropagation(); return; }
  const go = e.target.closest('[data-go]');
  if (go) {
    if (go.dataset.go === 'newproject') newProjectPreset = null;
    view = { kind: go.dataset.go, project: go.dataset.p || view.project, task: go.dataset.t || null };
    if (go.closest('#list')) closeDrawer(); // スマホの引き出しから選んだ時（描き直す前に判断する）
    if (view.kind === 'work' && view.task) markRead(view.project, view.task);
    showInTree(); save(); render(); return;
  }
  if (e.target.id === 'set-enter') { try { localStorage.setItem('hub-enter', e.target.checked ? '1' : '0'); } catch (err) { /* 無視 */ } toast(e.target.checked ? UI.text('Enter だけで送ります') : UI.text('⌘ + Enter で送ります')); return; }
  if (e.target.id === 'set-detail') { try { localStorage.setItem('hub-detail', e.target.checked ? '1' : '0'); } catch (err) { /* 無視 */ } toast(e.target.checked ? UI.text('細かい作業を出します') : UI.text('細かい作業を隠します')); return; }
  if (e.target.id === 'models-tidy') {
    if (rolesDirty() && !confirm(UI.text('役割分担とクレジット設定の保存していない変更は消えます。整理しますか？'))) return;
    api('/api/models/tidy', {expectedRevision:state.roles.management?.revision}).then(async r => {
      clearRolesDraft(); await load();
      const box = $('#tidy-result');
      const msg = r.changes.length ? UI.template`整理しました（${r.changes.length} か所）：` + r.changes.map(c => UI.template`${c.role}の${c.slot} ${c.from} → ${c.to}`).join('、') : UI.text('整理しました。役割はもう最新のモデルを使っています');
      if (box) box.textContent = msg; toast(r.changes.length ? UI.template`${r.changes.length} か所を最新のモデルにしました` : UI.text('役割はもう最新です'));
    }).catch(err => toast(err.message));
    return;
  }
  if (e.target.dataset && e.target.dataset.mv !== undefined) { toggleModelVisibility(e.target); return; }
  if (e.target.id === 'roles-save' || e.target.closest?.('[data-roles-save]')) { saveRoles(); return; }
  if (e.target.id === 'roles-reset' || e.target.closest?.('[data-roles-reset]')) { clearRolesDraft(); render(); return; }
  const b = e.target.closest('[data-act]');
  if (b && b.tagName !== 'SELECT') act(b);
});
let stepsOpen = false;
document.addEventListener('toggle', e => {
  if (e.target.classList && e.target.classList.contains('project-notes') && e.target.isConnected !== false) {
    const id = e.target.dataset.p;
    if (e.target.open) {projectNotesOpen.add(id);void loadProjectNotes(id);} else projectNotesOpen.delete(id);
  }
  if (e.target.classList && e.target.classList.contains('steps')) stepsOpen = e.target.open;
  if (e.target.id === 'logd' && e.target.open) loadLog();
  if (e.target.id === 'verd') { verOpen = e.target.open; if (verOpen) loadChangelog(); }
}, true);
document.addEventListener('change', async e => {
  if (e.target.hasAttribute?.('data-task-account')) { await saveTaskAccount(e.target); return; }
  const f = e.target.closest && e.target.closest('#quickform');
  if (f) {
    const p = proj(f.dataset.p), d = quickDraft(p);
    if (e.target.id === 'quick-files') { await addQuickImages(p, [...e.target.files]); return; }
    if (['quick-ai', 'quick-model', 'quick-effort'].includes(e.target.id)) quickOverrides.add(p.id);
    if (e.target.id === 'quick-ai') { d.ai = e.target.value; d.model = ''; d.effort = d.ai === 'agy' ? '高' : ''; }
    if (e.target.id === 'quick-model') d.model = e.target.value;
    if (e.target.id === 'quick-effort') d.effort = e.target.value;
    keepQuick(p.id); drawQuick(p); return;
  }

  const s = e.target;
  if (s.dataset.initial) {
    if (initialPickSaving) { drawInitialPick(); return; }
    const next = { ...initialPick(), [s.dataset.initial]: s.value };
    if (s.dataset.initial === 'ai') {
      next.model = shownModels(AI_KEY[next.ai])[0] || '';
      if (!state.efforts.includes(next.effort)) next.effort = '高';
    }
    await saveInitialPick(next); return;
  }
  if (['claude', 'codex'].includes(s.dataset.checkCredits) && checkCreditsDraft) {
    checkCreditsDraft[s.dataset.checkCredits] = s.checked;
    render(); return;
  }
  if (s.dataset.preferCredits !== undefined && preferCreditsDraft !== null) {
    preferCreditsDraft = s.checked; render(); return;
  }
  if (s.dataset.r !== undefined && rolesDraft) {
    const r = rolesDraft[+s.dataset.r][s.dataset.k];
    r[s.dataset.f] = s.value;
    if (s.dataset.f === 'ai') {
      const list = shownModels(s.value);
      r.model = s.value === '人' ? '' : (list.includes(r.model) ? r.model : s.value === 'agy' ? '' : list[0] || '');
      r.effort = s.value === '人' ? '' : s.value === 'agy' ? '高' : (r.effort || '高');
      if (s.value === 'grok' && r.effort === 'Ultra') r.effort = '高';
      if (s.value === 'agy' && !list.includes(r.model)) r.model = '';
    }
    render(); return;
  }
  const a = s.dataset.act;
  if (a === 'step') {
    try { const r = await api('/api/task/step', { project: s.dataset.p, task: s.dataset.t, index: +s.dataset.i, done: s.checked }); toast(r.resultsPending ? UI.text('成果の記録を確認しています') : r.completionPending ? UI.text('手順が終わりました。完了に移すか確認してください') : UI.text('手順を更新しました')); await load(); }
    catch (err) { toast(err.message); }
    return;
  }
  if (a === 'phase') {
    try { await api('/api/task', { project: s.dataset.p, task: s.dataset.t, phase: s.value }); toast(UI.text('フェーズを変えました')); await load(); }
    catch (err) { toast(err.message); }
    return;
  }
  if (['kind','derivedFrom','workspaceMode'].includes(a)) {
    const t=taskOf(proj(s.dataset.p),s.dataset.t), body={project:s.dataset.p,task:s.dataset.t,[a]:s.value};
    if(a==='kind' && s.value==='derived') body.derivedFrom=$('[data-act="derivedFrom"]').value;
    if(a==='derivedFrom' && s.value) body.kind='derived';
    if(a==='workspaceMode' && s.value==='direct' && !confirm(UI.text('本体で作業しますか？同じ場所での同時作業はできません。'))) {s.value=t.workspaceMode || 'isolated';return;}
    try {await api('/api/task',body);await load();} catch(err) {s.value=t[a] || '';toast(err.message);} return;
  }
  if (!['state', 'model', 'effort'].includes(a)) return;
  if (s.dataset.ai && a !== 'state') {
    try {
      const r = await api('/api/term/switch', { project: s.dataset.p, task: s.dataset.t, ai: s.dataset.ai, field: a, value: a === 'model' ? modelRequest(s.dataset.ai,s.value) : s.value });
      toast(r.sent ? UI.template`${AI_LABEL[s.dataset.ai]} に「${r.command}」を送りました` : UI.text('保存しました（次に始める時から使います）'));
      await load();
    } catch (err) { toast(err.message); }
    return;
  }
  if (a === 'state' && s.value === '完了') {
    const t = taskOf(proj(s.dataset.p), s.dataset.t);
    if (!confirm(UI.text('この作業を完了に移しますか？'))) { s.value = t.state; return; }
    try { await api('/api/task/completion', { project: s.dataset.p, task: s.dataset.t, action: 'approve', confirm: true, expectedHash: t.completionHash }); await load(); } catch (err) { s.value = t.state; toast(err.message); } return;
  }
  try { await api('/api/task', { project: s.dataset.p, task: s.dataset.t, [a]: s.value }); toast(a === 'state' ? UI.template`「${s.value}」にしました` : UI.text('変えました')); await load(); }
  catch (err) { toast(err.message); }
});
document.addEventListener('submit', async e => {
  if (e.target.classList.contains('addstep')) {
    e.preventDefault();
    const f = e.target, v = f.step.value.trim();
    if (!v) return;
    try { await api('/api/task/step', { project: f.dataset.p, task: f.dataset.t, add: v }); if(f.step.value.trim()===v)f.step.value='';stepsOpen = true; const key=JSON.stringify([f.dataset.p,f.dataset.t]);if(!workFolds.has(key))workFolds.set(key,new Map());workFolds.get(key).set('steps',true);workFolds.get(key).set('management',true);if(f.isConnected!==false){const work=f.closest('.work-compact');for(const name of ['steps','management']){const fold=work?.querySelector('[data-work-fold="'+name+'"]');if(fold)fold.open=true;}}toast(UI.text('手順を足しました')); await load(); }
    catch (err) { toast(err.message); }
    return;
  }
  if (e.target.id === 'projform') {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const first = String(f.get('firstTask') || '').trim();
      const p = await api('/api/project/new', { ...Object.fromEntries(f.entries()), related: f.getAll('related'), refs: newRefs });
      newRefs = []; newProjectPreset = null;
      if (first) {
        // 作ったプロジェクトで、最初の作業を初期選択で始める（役割は今のフェーズから）
        try {
          const r = await api('/api/start', { project: p.id, text: first, ...defaultWorkPick('司令塔'), images: [] });
          try { localStorage.setItem('hub-mode', 'chat'); } catch (err) { /* 無視 */ }
          toast(UI.template`「${p.name}」を作り、最初の作業を AI に頼みました`);
          view = { kind: 'work', project: p.id, task: r.task }; open.add(p.id); save(); await load(); return;
        } catch (err) { toast(UI.template`「${p.name}」は作りましたが、最初の作業を始められませんでした：${err.message}`); }
      } else toast(UI.template`「${p.name}」を作りました。作業を足して始めましょう`);
      view = { kind: 'project', project: p.id, task: null }; open.add(p.id); save(); await load();
    } catch (err) { toast(err.message); }
    return;
  }
  // すぐ始める：書いた文から作業を作り、会話画面で AI に送る（役割・担当は今のフェーズから）
  if (e.target.id === 'quickform') {
    e.preventDefault();
    const f = e.target, p = proj(f.dataset.p);
    if (!p || quickStarting.has(p.id) || quickUploading.has(p.id)) return;
    if (!warnChildren(p)) return;
    const d = quickDraft(p); d.text = f.elements.namedItem('text').value; keepQuick(p.id);
    if (!d.text.trim() && !d.images.length) { toast(UI.text('依頼を書くか画像を追加してください')); return; }
    d.request ||= `${Date.now()}-${Math.random().toString(36).slice(2)}`; keepQuick(p.id);
    quickStarting.add(p.id); f.elements.namedItem('text').disabled = true; drawQuick(p);
    try {
      const r = await api('/api/start', { project: p.id, text: d.text, ai: d.ai, model: modelRequest(d.ai,d.model), effort: d.effort, images: d.images.map(x => x.id), task: d.task, request: d.request });
      d.text = ''; d.images = []; delete d.task; delete d.request; quickOverrides.delete(p.id); if (state.specialMode?.enabled) Object.assign(d, defaultWorkPick('司令塔')); keepQuick(p.id);
      try { localStorage.setItem('hub-mode', 'chat'); } catch (err) { /* 無視 */ }
      toast(r.agent ? UI.text('担当・依頼・画像の場所を保存しました。Discordで渡してください') : UI.text('作業を作って、AI に頼みました'));
      view = { kind: 'work', project: p.id, task: r.task }; save(); await load();
    } catch (err) { if (err.task) { d.task = err.task; keepQuick(p.id); } toast(err.message); }
    finally { quickStarting.delete(p.id); f.elements.namedItem('text').disabled = false; drawQuick(p); }
    return;
  }
  if (e.target.id !== 'newform') return;
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const t = await api('/api/task/new', { project: view.project, title: f.get('title'), owner: f.get('owner'), role: f.get('role'), kind:f.get('kind'),derivedFrom:f.get('derivedFrom'),workspaceMode:f.get('workspaceMode'),parent: f.get('parent'), phase: f.get('phase') || '', via: f.get('via') || '', steps: f.get('steps') || '' });
    toast(UI.text('作業を足しました')); view = { kind: 'work', project: view.project, task: t.id }; save(); await load();
  } catch (err) { toast(err.message); }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { $('#menu').hidden = true; if ($('#fsheet')) $('#fsheet').hidden = true; }
  if (isSendKey(e) && e.target.closest && e.target.closest('#quickform')) { e.preventDefault(); $('#quickform').requestSubmit(); }
});
$('#turn').addEventListener('click', () => { view = { ...view, kind: view.kind === 'turn' ? 'project' : 'turn' }; render(); });
$('#ver').addEventListener('click', () => { view = { ...view, kind: 'settings' }; clearRolesDraft(); verOpen = true; settingsTab = 'manage'; render(); loadChangelog(); });
$('#upd').addEventListener('click', openUpdate);
document.addEventListener('click', async e => {
  if (e.target.closest('[data-hub-update]')) await switchHubUpdate();
});
// 本体のフォルダ：Mac のフォルダ選択の窓で選ぶ
document.addEventListener('click', async e => {
  if (e.target.dataset && e.target.dataset.rmref !== undefined) { newRefs.splice(+e.target.dataset.rmref, 1); drawRefs(); return; }
  if (e.target.id === 'np-refpick') {
    try { const r = await api('/api/pick-folder', { prompt: UI.text('参考にするフォルダを選んでください') }); if (r.path) addNewRefs([r.path]); }
    catch (err) { toast(err.message); }
    return;
  }
  if (e.target.id !== 'np-pick') return;
  try { const r = await api('/api/pick-folder', { prompt: UI.text('本体のフォルダを選んでください') }); if (r.path) setBodyFolder(r.path); }
  catch (err) { toast(err.message); }
});
function setBodyFolder(p) {
  const i = $('#np-body'); if (!i) return;
  i.value = p;
  const d = i.closest('details'); if (d) d.open = true;
  const n = $('#np-name');
  if (n && !n.value.trim()) n.value = p.split('/').filter(Boolean).pop() || ''; // 名前が空ならフォルダ名を使う
  toast(UI.text('本体のフォルダを入れました'));
}
// アプリの窓に落とした時（本当の場所が分かる）：Mac アプリから呼ばれる
window.hubNativeDrop = async paths => {
  if (!Array.isArray(paths) || !paths.length) return;
  if (view.kind === 'newproject') {
    // 参考の欄に落とした時は参考に。本体の欄（や本体が空の時）は1つ目を本体に、残りは参考に
    if (lastDropZone === 'refs') { addNewRefs(paths); toast(UI.template`参考に ${paths.length} 件足しました`); return; }
    const body = $('#np-body');
    if (lastDropZone === 'body' || (body && !body.value.trim())) { setBodyFolder(paths[0]); if (paths.length > 1) addNewRefs(paths.slice(1)); return; }
    addNewRefs(paths); toast(UI.template`参考に ${paths.length} 件足しました`); return;
  }
  if (view.kind === 'project' && view.project) {
    const images = paths.filter(isQuickImage), other = paths.filter(x => !isQuickImage(x));
    if (images.length) await addQuickImages(proj(view.project), images, true);
    if (!other.length) return;
    paths = other;
    try { const r = await api('/api/project/refs', { project: view.project, paths }); toast(r.added ? UI.template`参考に ${r.added} 件足しました（AI は読むだけ）` : UI.text('もう入っています')); await load(); }
    catch (err) { toast(err.message); }
    return;
  }
  if (view.kind !== 'work') { toast(UI.text('ファイルは作業画面に落としてください')); return; }
  const ta = $('#chat-in');
  if (ta) {
    const project = view.project, task = view.task;
    const topicGeneration=project==='freetalk'?attachmentGeneration(task):undefined;
    const other = [];
    for (const file of paths) {
      if(project==='freetalk' && attachmentGeneration(task)!==topicGeneration)break;
      if (project === 'freetalk' || isQuickImage(file)) {
        try { await addChatImage(project, task, file, true); }
        catch (e) { toast(`${file.split('/').pop()}：${e.message}`); }
      } else other.push(file);
    }
    if (other.length) {
      try {
        const r = await api('/api/task/attach', { project, task, paths: other });
        appendChatPaths(project, task, r.paths);
      } catch (e) { toast(e.message); }
    }
    return;
  }
  const ai = lastDropAi;
  try {
    const r = await api('/api/task/attach', { project: view.project, task: view.task, ai, paths });
    toast(r.typed ? UI.template`${AI_LABEL[ai]} の入力欄にファイルの場所を入れました。続けて指示を書いて Enter を押してください` : UI.text('作業ファイルに記録しました。AI を始めると読めます'));
    if (r.typed && panes[ai]) panes[ai].xterm.focus();
  } catch (err) { toast(err.message); }
};
window.hubNativePaste = paths => {
  if (view.kind === 'project') return addQuickImages(proj(view.project), paths, true);
  if (view.kind === 'work') return window.hubNativeDrop(paths);
  toast(UI.text('画像は依頼の入力欄か作業画面で貼り付けてください'));
};
// スマホ：☰ で左の一覧を出し入れ。一覧で何かを選んだらしまう
$('#menu-toggle').addEventListener('click', () => { const on = document.body.classList.toggle('show-list'); $('#menu-toggle').setAttribute('aria-expanded', String(on)); });
function closeDrawer() { document.body.classList.remove('show-list'); $('#menu-toggle').setAttribute('aria-expanded', 'false'); }
// 一覧の外を押したら、引き出しをしまう（一覧の中の選択は、下の [data-go] の処理でしまう）
document.addEventListener('click', e => { if(e.target.closest?.('[data-steps-retry]')){syncTaskSteps();return;} const b=e.target.closest?.('[data-steps-close]'); if(b){const d=b.closest('.steps');if(d)d.open=false;stepsOpen=false;return;} if (document.body.classList.contains('show-list') && e.target.closest && !e.target.closest('#list') && !e.target.closest('#menu-toggle')) closeDrawer(); }, true);
$('#gear').addEventListener('click', () => { view = { ...view, kind: view.kind === 'settings' ? 'project' : 'settings' }; clearRolesDraft(); render(); });

// 左の木だけすぐ読み直す（AI が始めた・終わった時。丸の色を変えるため）
async function refreshTree(isCurrent = () => true) {
  const epoch = stateLoadEpoch;
  try { const next = await fetchState(); if (!isCurrent() || epoch !== stateLoadEpoch || webchatSettingsPending || webchatSettingsSaving || accountSelectionSaving || taskFastSaving || accelerationSaving || initialPickSaving || specialModeSaving || phoneLabelsSaving || !next) return; adoptState(next); syncWebchatSettingsControls(); syncChatPhoneLabels(); syncAccountPickers(); syncChatWebchatAvailability(); refreshKidsDoneBar(); if (treeKey() !== renderedTreeKey) renderTree(); }
  catch (e) { /* 次に */ }
}
const editing = () => document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
let statePolling = false;
async function pollState() {
  if (document.hidden || statePolling) return;
  statePolling = true;
  const epoch = stateLoadEpoch;
  try {
    const next = await fetchState();
    if (epoch !== stateLoadEpoch || webchatSettingsPending || webchatSettingsSaving || accountSelectionSaving || taskFastSaving || accelerationSaving || initialPickSaving || specialModeSaving || phoneLabelsSaving) return; // 保存後などの明示 load() を古い定期取得で上書きしない
    const previousModels = JSON.stringify([state.modelOrder, state.hiddenModels, state.roles?.models]);
    const previousInitial = JSON.stringify([state.initialPick, state.initialPickError]);
    if (next) adoptState(next);
    refreshKidsDoneBar(); syncWorkQuestion(); syncTaskSteps();
    syncWebchatSettingsControls();
    // 通知のrefreshTreeが先にstateを更新した時や304でも、実際のoptionを同期する。
    // 表示名はmainKeyに含めず、会話の入力欄・選択欄は作り直さない。
    syncChatPhoneLabels();
    syncAccountPickers();
    syncChatWebchatAvailability();
    if (typeof syncRoleSettings === 'function') syncRoleSettings();
    if(view.kind==='settings'&&state.stopControl)drawEmergencyStatus(state.stopControl);
    if (view.kind === 'settings' && !phoneLabelsSaving && renderedPhoneKey !== phoneSettingsKey() && !$('#phone-labels')?.contains?.(document.activeElement)) drawPhoneLabels();
    if (view.kind === 'settings' && !modelViewSaving && previousModels !== JSON.stringify([state.modelOrder, state.hiddenModels, state.roles?.models])) { drawModelOrder(); syncRoleModelOrder(); }
    if (view.kind === 'settings' && !initialPickSaving && (previousInitial !== JSON.stringify([state.initialPick, state.initialPickError]) || previousModels !== JSON.stringify([state.modelOrder, state.hiddenModels, state.roles?.models]))) drawInitialPick();
    if (!next && state.sessions.length) { state.sessions = await api('/api/sessions'); if (epoch !== stateLoadEpoch) return; } // 止まっている秒数だけ取り直す
    if (document.hidden) return;
    if (typeof syncMaintenanceControls === 'function') syncMaintenanceControls();
    showVersion(state.version, state.latest);
    updateTurnCounts();
    window.HubMobile?.badges();
    const keepMain = view.kind === 'settings' || view.kind === 'newproject' || editing() || document.querySelector('details[open]:not(.project-notes)');
    if (!keepMain && mainKey() !== renderedMainKey) render();
    else {
      if (treeKey() !== renderedTreeKey) renderTree();
      // 入力中は画面を作り直さず、このボタンと理由だけ最新にする。
      if (keepMain && view.kind === 'project') {
        const box = $('#github-create-status'), p = proj(view.project);
        if (box && p) box.innerHTML = githubCreateButton(p);
      }
      if (!keepMain) updateStatus();
      if (view.kind === 'work') {
        const p = proj(view.project), t = taskOf(p, view.task);
        if (t?.copy && !t.mergeExcluded) loadPreview(p.id, t.id);
      }
    }
  } catch (e) { /* 次に */ }
  finally { statePolling = false; }
}
setInterval(pollState, 15000);
// Only an explicitly requested review gets faster progress updates.
setInterval(()=>{if(view.kind==='settings' && state.roles?.management?.review && !roleSettingsBusy)void pollState();},1500);

// ---- ファイル・スクショを渡す（落とす／⌘V で貼る） ----
// 落とした AI の画面に渡す。画面の外なら、動いている AI が1つの時はそれに、無ければ保存して作業ファイルに記録するだけ
function dropTarget(el) {
  if (el && el.closest && el.closest('.chat')) return '';
  const pane = el && el.closest && el.closest('.pane[data-ai]');
  if (pane) return pane.dataset.ai;
  const run = AIS.filter(a => document.getElementById('pane-' + a));
  return run.length === 1 ? run[0] : '';
}
async function sendFiles(files, ai) {
  if (view.kind !== 'work' || !files.length) return;
  const project = view.project, task = view.task;
  const topicGeneration=project==='freetalk'?attachmentGeneration(task):undefined;
  const ta = $('#chat-in');
  if (ta) ai = ''; // 会話画面では、場所を依頼の欄に入れる
  const got = [];
  for (const f of files) {
    if(project==='freetalk' && attachmentGeneration(task)!==topicGeneration)break;
    if (ta && (project === 'freetalk' || isQuickImage(f))) {
      try { await addChatImage(project, task, f); }
      catch (e) { toast(`${f.name || UI.text('画像')}：${e.message}`); }
      continue;
    }
    const name = f.name && f.name !== 'image.png' ? f.name : `screenshot-${Date.now()}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`;
    const q = new URLSearchParams({ project, task, ai, name });
    const generation=globalThis.HubChatGenerations?.get(project+'\0'+task);if(generation)q.set('generation',generation);
    try {
      const r = await fetch('/api/task/upload?' + q, { method: 'POST', headers: { 'X-Hub': '1', 'Content-Type': 'application/octet-stream' }, body: f });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || UI.text('渡せませんでした'));
      got.push(j);
    } catch (e) { toast(`${f.name || UI.text('ファイル')}：${e.message}`); }
  }
  if (ta) {
    if (got.length) appendChatPaths(project, task, got.map(x => x.path));
    return;
  }
  if (!got.length) return;
  const typed = got.some(x => x.typed);
  toast(typed ? UI.template`${AI_LABEL[ai]} の入力欄にファイルの場所を入れました。続けて指示を書いて Enter を押してください` : UI.template`ファイルを保存し、作業ファイルに記録しました（${got.length}件）。AI を始めると読めます`);
  if (typed && panes[ai]) panes[ai].xterm.focus();
}
function appendChatPaths(project, task, paths) {
  for (const path of paths) chatImages(project, task).push({ id: 'file:' + (++chatFileSequence) + ':' + path, kind: 'file', path, name: path.split(/[\\/]/).pop() });
  drawChatImages(project, task);
  toast(UI.text('ファイルを添付しました。続けて指示を書いて送ってください'));
}
let dropTimer = null, lastDropAi = '', lastDropZone = '';
function showDrop(ai) {
  document.querySelectorAll('.pane, .chat').forEach(p => p.classList.toggle('dropping', p.dataset.ai ? p.dataset.ai === ai : !ai));
  clearTimeout(dropTimer);
  dropTimer = setTimeout(() => document.querySelectorAll('.dropping').forEach(p => p.classList.remove('dropping')), 250);
}
// 窓にファイルを落としても、ファイルが開いて Hub が消えないようにする
document.addEventListener('dragover', e => {
  if (document.querySelector('.ideas-dialog[open]')) { e.preventDefault(); return; }
  e.preventDefault();
  if (view.kind === 'project' && e.target.closest && e.target.closest('#quickform')) {
    e.stopPropagation(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; return;
  }
  if (view.kind === 'work' && e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.dataTransfer.dropEffect = 'copy'; lastDropAi = dropTarget(e.target); showDrop(lastDropAi); }
  else if (view.kind === 'newproject' && e.dataTransfer) {
    e.dataTransfer.dropEffect = 'copy';
    const inRefs = e.target.closest && e.target.closest('#np-refs');
    lastDropZone = inRefs ? 'refs' : (e.target.closest && e.target.closest('#np-drop')) ? 'body' : '';
    const z = inRefs ? $('#np-refs') : $('#np-drop');
    if (z) { document.querySelectorAll('.dropfield.dropping').forEach(x => x !== z && x.classList.remove('dropping')); z.classList.add('dropping'); clearTimeout(dropTimer); dropTimer = setTimeout(() => z.classList.remove('dropping'), 250); }
  } else if (view.kind === 'project' && e.dataTransfer) { e.dataTransfer.dropEffect = 'copy'; const v = document.querySelector('.view'); if (v) { v.classList.add('dropping'); clearTimeout(dropTimer); dropTimer = setTimeout(() => v.classList.remove('dropping'), 250); } }
  else if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
});
document.addEventListener('drop', e => {
  if (document.querySelector('.ideas-dialog[open]')) { e.preventDefault(); return; }
  e.preventDefault();
  if (view.kind === 'project' && e.dataTransfer) {
    const images = [...e.dataTransfer.files].filter(isQuickImage);
    if (images.length) { e.stopPropagation(); addQuickImages(proj(view.project), images); return; }
  }
  // ブラウザで開いている時は、落としたフォルダの場所が分からない
  if (view.kind === 'newproject' || view.kind === 'project') { toast(UI.text('ブラウザでは場所が分かりません。［選ぶ…］を押すか、アプリの窓で落としてください')); return; }
  if (view.kind !== 'work' || !e.dataTransfer) return;
  sendFiles([...e.dataTransfer.files], dropTarget(e.target));
});
document.addEventListener('paste', e => {
  if (document.querySelector('.ideas-dialog[open]')) return;
  const files = e.clipboardData ? [...e.clipboardData.files] : [];
  if (view.kind === 'project' && e.target.closest && e.target.closest('#quickform') && files.some(isQuickImage)) {
    e.preventDefault(); e.stopPropagation(); addQuickImages(proj(view.project), files); return;
  }
  if (view.kind !== 'work' || !files.length) return;
  e.preventDefault(); e.stopPropagation();
  sendFiles(files, dropTarget(document.activeElement));
}, true);

// 作業画面では稼働状況を数秒ごとに更新する（無出力だけで入力待ちにはしない）。
function updateStatus() {
  if (view.kind !== 'work') return;
  document.querySelectorAll('.pstat').forEach(el => { el.innerHTML = statusText(sessOf(view.project, view.task, el.dataset.ai)); });
}
let sessionsPolling = false;
async function pollSessions() {
  if (document.hidden || sessionsPolling || view.kind !== 'work' || !document.querySelector('.pstat')) return;
  sessionsPolling = true;
  const epoch = stateLoadEpoch;
  try { const sessions = await api('/api/sessions'); if (epoch !== stateLoadEpoch) return; state.sessions = sessions; if (!document.hidden) updateStatus(); } catch (e) { /* 次に */ }
  finally { sessionsPolling = false; }
}
setInterval(pollSessions, 4000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearTimeout(aiToolsWatchTimer); aiToolsWatchTimer = null; }
  else { pollState(); pollSessions(); if (view.kind === 'settings') loadAiTools(); }
});

restoreRestartDrafts();
restoreFreetalkPromotionDrafts();
api('/api/freetalk/ensure', {}).catch(() => {}).then(() => load()).catch(e => { $('#main').innerHTML = UI.template`<div class="view"><p class="note">読み込めませんでした：${esc(e.message)}</p></div>`; });
