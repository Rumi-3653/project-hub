'use strict';
const { lt, locale, config:localeConfig, configScript, activePack } = require('./lib/locale');
const langpacks = require('./lib/langpack');
const { loadPack } = langpacks;
// Project Hub 第2版：台帳の一覧、画面の中の作業画面、役割・モデル・思考の設定
// 使い方: node server.js  →  http://127.0.0.1:4545
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { StaticFiles, sendEncoded } = require('./lib/static-files');
const { Store, expandHome } = require('./lib/store');
// Resolve the saved language before dependencies create translated constants.
const ROOT = expandHome(process.env.HUB_ROOT || path.join(os.homedir(), 'Documents', 'AI-Workspace'));
const move = new (require('./lib/move').Move)({ root: ROOT, version: require('./package.json').version });
if (require.main === module && move.needsStartup()) {
  module.exports = { move, server: require('./lib/move-boot').serve(move, { port: Number(process.env.HUB_PORT || 4545), version: require('./package.json').version, entry: __filename }) };
  return;
}
require('./lib/store').loadMovePathMap(ROOT);
const license = new (require('./lib/license').License)({ root: ROOT });
langpacks.setRoot(ROOT);
const launch = require('./lib/launch');
const roles = require('./lib/roles');
const roleHistory = require('./lib/role-history');
const roleReviewRuntime = require('./lib/role-review-runtime');
let roleReview;
const discussionRuntime = require('./lib/discussion-runtime');
let discussion;
const specialMode = require('./public/special-mode');
const { Sessions } = require('./lib/sessions');
const gitw = require('./lib/git');
const transcript = require('./lib/transcript');
const chat = require('./lib/chat');
const start = require('./lib/start');
const { AiTools } = require('./lib/ai-tools');
const { listSkills } = require('./lib/skills');
const { Onboarding } = require('./lib/onboarding');
const { Usage } = require('./lib/usage');
const { ModelLimits } = require('./lib/model-limits');
const { limitRoute, limitIdentity, capacityRoute } = require('./lib/limit-route');
const { TerminalLimits, capture: captureTerminalLimit } = require('./lib/terminal-limits');
const { buildHandoffCard, snapshot: gitSnapshot } = require('./lib/handoff-card');
const remoteLib = require('./lib/remote');
const { guidance } = require('./lib/guidance');
const instructions = require('./lib/instructions');
const { AsyncLocalStorage } = require('async_hooks');
let webchat;
const webchatActive = (project, task) => Boolean(webchat?.busy().some(j => j.project === project && (!task || [j.task, j.parent].includes(task))));

const PORT = Number(process.env.HUB_PORT || 4545);
let conversationHistory;
const historyBusy=(project,task)=>Boolean(conversationHistory?.activeAutos().some(a=>a.project===project&&(!task||a.task===task)&&conversationHistory.organizing(a.project,a.task)));
const DRY = process.env.HUB_DRY_RUN === '1'; // テスト用：実際には起動しない
const stopControl = new (require('./lib/stop-control').StopControl)({dir:path.join(ROOT,'_hub','stop-control')});
const accounts = new (require('./lib/accounts').Accounts)({ file: path.join(ROOT, '_hub', 'accounts.json'), dry: DRY, busy: accountBusy });
launch.setAccounts(accounts);
function limitModels() {
  const out = { claude: [...require('./lib/model-limits').MODELS.claude], codex: [...require('./lib/model-limits').MODELS.codex] };
  for (const r of rolesData().roles) for (const slot of [r.main, r.backup]) {
    const ai = slot.ai === 'claude-code' ? 'claude' : slot.ai, flag = launch.flagFor(ai, slot.model);
    if (out[ai] && flag && !out[ai].includes(flag)) out[ai].push(flag);
  }
  return out;
}
const limitEvidence = new ModelLimits(path.join(ROOT, '_hub', 'limits.json'), { models: limitModels,
  creditPolicy: rolesData, creditState: (ai, account) => usage.creditState(ai, account) });
const usage = new Usage({ dry: DRY, accounts, resetFile:path.join(ROOT, '_hub', 'reset-ticket-attempts.json'),
  onReset:account => limitEvidence.clearAccount('codex', account),
  beforeRead: (ai, account) => accounts.available(ai, account), observe: snapshot => {
  try { limitEvidence.observe(snapshot); } catch { /* 保存失敗では直前の保持状態を維持 */ }
} });
async function refreshLimitEvidence(request) {
  verifyIntegrationAssignmentSend(request);
  if (discussionRuntime.isRequest(request.request)) { discussion.verify(request); return; }
  if (!['claude', 'codex'].includes(request.ai)) return;
  if (rolesData().checkCredits[request.ai]) await usage.checkCredits(request.ai, request.account || 'default');
  if (integrationPolicyRequest(request)) {
    if (!limitEvidence.active(request.account || 'default',launch.flagFor(request.ai,request.model))) await usage.status(false,{[request.ai]:request.account || 'default'});
    return;
  }
  if (!limitRoutingEnabled()) return;
  const target = roleReviewRuntime.heldLimit(request, limitEvidence) ? limitBackup(request) : request;
  if (!target || !['claude', 'codex'].includes(target.ai)) return;
  // 元担当が保持中でも、確認ONの交代先は起動前に既存クレジットを判定する。
  if (target !== request && rolesData().checkCredits[target.ai]) await usage.checkCredits(target.ai, target.account || 'default');
  if (roleReviewRuntime.heldLimit({ ...request, ...target }, limitEvidence)) return;
  // 状態だけ読む（prompt/turnは送らない）。TTL/アカウント隔離はUsageの共通経路。
  await usage.status(false, { [target.ai]: target.account || 'default' });
}
const PUBLIC = path.join(__dirname, 'public');
const bootModules=require('./lib/runtime-generation').preload(__filename,{optional:[path.join(__dirname,'lib/license/owner-edition')]});
const staticFiles=new StaticFiles({root:PUBLIC,live:process.env.HUB_STATIC_LIVE==='1'});
const ROLES_FILE = path.join(ROOT, '_hub', 'roles.yaml');
const store = new Store(ROOT);
const { Ideas } = require('./lib/ideas');
const { IdeaAPI, isSaveRoute: ideaSaveRoute } = require('./lib/idea-api');
const { IdeaSource, decorate: ideaRows } = require('./lib/idea-source');
const ideas = new Ideas({store,root:ROOT,baseOf});
const ideaSource = new IdeaSource({store,generation:(p,t)=>taskHistory.state(p,t).generation,blocked:()=>Boolean(taskHistory.failure)});
const ideaAPI = new IdeaAPI({ideas,source:ideaSource});
const executionGate = new (require('./lib/execution-gate').ExecutionGate)();
let ideaRunner, ideaDispatch, ideaLane, ideaRelease, queueRetreat;
const freetalkLib = require('./lib/freetalk');
// DRY_RUN は明示した一時 HOME または隔離 ROOT の中だけを使う。
const freetalk = new freetalkLib.Freetalk(store, DRY ? process.env.HUB_FREETALK_HOME || path.join(ROOT, '_hub/freetalk-home') : os.homedir());
const acceleration = new (require('./lib/acceleration').Acceleration)(path.join(ROOT, '_hub', 'acceleration.json'));
const projectOrder = new (require('./lib/project-order').ProjectOrder)(store);
// 外から使う（iPhone）の設定と、今の要求が外からかどうか（記録に「外から」と印を付けるため）
const remote = new remoteLib.Remote({ file: path.join(ROOT, '_hub', 'remote.json') });
const reqCtx = new AsyncLocalStorage();
const fromRemote = () => Boolean(reqCtx.getStore()?.remote);
const sessions = new Sessions({stopControl});
let restartControl = null, emergencyRestart = null;
let activeRequests = 0;
const queueActions = new Set();
const queueEdit = require('./lib/queue-edit');
const queueEditable = item => !item.automation && !item.readOnly && !item.selectionOnly && !item.limitSwitch && !item.resultsOrganize && !item.integrationAssignment && !item.isolatedReview && !item.integrationReviewRequest;
const chats = new chat.ChatRunner({stopControl,queueGuard:o=>queueRetreat?.guard(o),prepareContext:o=>{
  if(o.project==='freetalk'||o.readOnly||o.automation)return o;
  const token=o.ideaRecord?.token||crypto.randomUUID();
  const instruction=`\n別の改善を思いついた時は原文だけ台帳へ残せます。作る許可は付与しません。POST /api/ideas/add (Hubと同じ接続先), headers X-Hub:1 / X-Idea-Record:${token} / Content-Type:application/json, body {project:${JSON.stringify(o.project)},opId:UUID,text:原文,intent:record}。送信識別は再送時も同じにし、結果不明ならreceiptを照合する。`;
  return {...o,ideaRecord:{token},basePrompt:(o.basePrompt||'')+instruction};
}, spoolRoot:path.join(ROOT,'_hub','cli-runs'),onAdoptEnd:(o,row)=>{if(!o.automation&&!o.discussionTurn&&!o.isolatedReview&&!o.selectionOnly&&row.asks?.length)store.updateTask(o.project,o.task,{state:'返事待ち',question:row.asks.map(a=>a.question).join(' / ').slice(0,300)});chatEnded(o.project,o.task);}, dirOf: id => { const p = store.readProject(id); return p ? p.dir : ''; },
  delegates: (p, t) => [...readLog(5000), ...readLog(5000, LOG_FILE.replace(/\.jsonl$/, '.old.jsonl'))].filter(r => r.project === p && r.task === t),
  permFor: permCmd,
  limitBackup: limitBackup,
  capacityBackup: o => limitBackup(o, 'capacity'),
  limitIdentity: o => limitIdentity(rolesData(), o),
  accountFor, fastFor: codexFastFor,
  onSettled: async (o,row) => { if(o.automation){await ideaRunner.settled(o,row);return;} if(discussionRuntime.isRequest(o.request)) { await discussion?.settled(o,row); return; } if(roleReviewRuntime.isRequest(o.request)) { await roleReview?.settled(o,row); return; } integrateAuto.settled(o,row);setImmediate(()=>{
    try{if(stopControl.held({project:o.project,task:o.task}))return;stopControl.assert(o,o.stopTicket);chats.assertHandoffReady(o.project,o.task);}catch{return;}
    if(o.selectionOnly){void autoTick(o.project,o.task);return;}
    void integrateAuto.tick();if(!o.isolatedReview)void resultsGate.trigger(o.project,o.task,{row,organized:Boolean(o.resultsOrganize)}).catch(e=>record('results-organize-error',{project:o.project,task:o.task},{error:e.message}));
  }); },
  limitHold: o => Boolean(discussionRuntime.isRequest(o.request) || integrationPolicyRequest(o)),
  limitPreflight: o => discussionRuntime.isRequest(o.request) ? limitEvidence.active(o.account || 'default',launch.flagFor(o.ai,o.model),true) : integrationPolicyRequest(o) ? limitEvidence.active(o.account || 'default',launch.flagFor(o.ai,o.model)) : limitRoutingEnabled() || roleReviewRuntime.isRequest(o.request) ? roleReviewRuntime.heldLimit(o, limitEvidence) : null,
  limitTarget: o => roleReviewRuntime.heldLimit(o, limitEvidence),
  beforeQueued: async o => { void license.prepare(); return refreshLimitEvidence(o); },
  startBarrier:o=>{stopControl.assert(o,o.stopTicket);executionGate.assert({dir:o.dir||store.readProject(o.project)?.dir,owner:'chat:'+o.project+':'+o.task});if(o.automation&&o.automation.kind!=='idea')throw Error('不明な自動実行は開始しません');},
  beforeSend:o=>o.automation?ideaDispatch.verify(o):verifyIntegrationReviewSend(o),
  beforeAdopt:o=>{if(o.automation)ideaDispatch.verify(o,{adoption:true});},
  startGate:(o,{adoption})=>{if(o.automation)ideaDispatch.verify(o,{adoption});executionGate.acquire({dir:o.dir,owner:'chat:'+o.project+':'+o.task,kind:o.readOnly?'frozen-review':'write',adoption});},
  endGate:o=>executionGate.release('chat:'+o.project+':'+o.task),
  onHandoffError:(o,e,run)=>executionGate.block('chat-handoff:'+run,o.dir,'会話の終了保存の復旧が必要です：'+e.message),
  onHandoffRecovered:(o,run)=>executionGate.unblock('chat-handoff:'+run),
  afterCompleted:o=>{if(ideaRunner)for(const p of store.listProjects())if(p.id!=='freetalk'&&ideas.readRegistry().projects[p.id])ideaRunner.wake(p.id);},
  onStop:(project,task)=>{if(project==='freetalk'||store.readProject(project)?.kind==='freetalk')return;const d=ideas.read(project);if(d.projectUid!=='uninitialized'&&(d.settings.lane?.task===task||Object.values(d.runs).some(r=>!r.closed&&r.task===task)))ideas.auto(project,{opId:require('./lib/idea-utils').uuid(),settingsRev:d.settings.rev,enabled:false});},
  onLimit: o => {
    try { limitEvidence.record(o,o.discussionTurn?discussion.limitModels():undefined,discussionRuntime.isRequest(o.request)); }
    catch (e) { record('limit-save-error', o); throw e; }
    void usage.status(true, { [o.ai]: o.account || 'default' }).catch(() => {});
  },
  onFableSuccess: started => limitEvidence.success(started),
  refreshQueued: o => {
    const p = store.readProject(o.project), t = p?.tasks.find(t => t.id === o.task);
    if (!p || !t) throw Error(lt('作業が見つかりません'));
    if(o.automation)return ideaDispatch.refresh(o);
    if(discussionRuntime.isRequest(o.request)){discussion.verify(o);return {dir:isolatedReviewDir(p,t),basePrompt:discussionRuntime.basePrompt,policy:discussionRuntime.basePrompt};}
    if(roleReviewRuntime.isRequest(o.request)){roleReview.verify(o);return {dir:isolatedReviewDir(p,t),basePrompt:roleReviewRuntime.basePrompt,policy:roleReviewRuntime.basePrompt};}
    verifyIntegrationReviewSend(o); // Reject lost review classification before workspace preparation too.
    if(o.selectionOnly)return {dir:p.dir,basePrompt:selectionPrompt(p),policy:selectionPrompt(p)};
    if(o.isolatedReview)return {dir:isolatedReviewDir(p,t),basePrompt:integrationReviewPrompt(p,t)};
    if(o.readOnly)return {dir:p.dir,basePrompt:lt('読み取り専用の共有確認です。ファイルを編集せず、判定のJSONだけを返してください。')};
    const dir = o.dir && fs.existsSync(o.dir) ? o.dir : workDir(p, t).dir;
    if (!dir || !fs.existsSync(dir)) throw Error(lt('作業場所を用意できませんでした'));
    return { dir, policy: modelPolicy(p, t), basePrompt: taskPrompt(p, t, store.taskFile(p.id, t.id), dir) + lt(' ここは会話画面。人からの依頼に答え、区切りで作業ファイルを更新すること。') };
  },
  canStart: (ai, model, o) => {
    try{executionGate.assert({dir:o?.dir||store.readProject(o?.project)?.dir,owner:'chat:'+o?.project+':'+o?.task});if(o?.automation)ideaDispatch.verify(o);}catch(e){return e.message;}
    if (o && !discussionRuntime.isRequest(o.request) && discussion?.active(o.project,o.task)) return '話し合いが進行中です。停止または完了後に送ってください';
    if (appUpdate.applying()) return appUpdate.busyMessage();
    if (restartControl?.committed) return lt('再起動を開始しています');
    if (aiTools.isOperating(ai)) return lt('AI の更新・モデル再取得が進行中です');
    const invalid=modelError(ai,model); if(invalid)return invalid;
    if (o && modelView.special().enabled && limitEvidence.forRequest({ ...o, ai, model })) return lt('特殊モードのAIが上限中です。解除後に再開してください');
    if(o) { const p=store.readProject(o.project), t=p?.tasks.find(t=>t.id===o.task);
      if(!p || !t)return lt('作業が見つかりません');
      if(p.kind==='freetalk' && freetalkHistory.state(t.id).migrated)return lt('移行済みの話題は読み取り専用です');
      if(o.resultsRecoveryHash && t.completionHash!==o.resultsRecoveryHash)return lt('成果整理の開始前に子作業が変わりました');
      if(o.requireModel && t.state === '完了' && !o.resultsRecoveryHash)return DELEGATE_COMPLETED_ERROR;
      if(o.requireModel) {const blocked=delegateTerminalError(p.id,t.id);if(blocked)return blocked;}
      try { accounts.available(ai, o.account || 'default', { forWork: true }); } catch (e) { return e.message; }
      try {assertWorkspaceIdle(p,t,false);} catch(e) {return e.message;}
    }
    return '';
  } });
queueRetreat = new (require('./lib/queue-retreat').QueueRetreat)({ideas,chats,actions:queueActions,related:(p,t,q)=>{
  const a=taskIntegrate.read(p,t)?.auto;
  return Object.values(a?.attempts||{}).some(x=>[x.delivery?.request,x.delivery?.queueId].some(id=>id&&[q.id,q.request].includes(id)));
}});
const { Maintenance } = require('./lib/maintenance');
const emptyLib = require('./lib/empty');
const maintenance = new Maintenance({store,baseOf,busy:id=>{
  const p=store.readProject(id);if(!p)return false;
  if (executionGate.busy(baseOf(p))||discussion?.active(id)||webchatActive(id)||problemResolution.starting.has(id)||historyBusy(id)) return true;
  const all=store.listProjects(), familyIds=require('./lib/work-context').family(p,all).map(q=>q.id);
  const base=fs.realpathSync(baseOf(p));
  if (github.locked(base)) return true;
  const active=[...sessions.list().filter(x=>x.running),...[...chats.running.keys()].map(k=>({project:k.split('\u0000')[0]}))];
  return procwatch.list().some(x=>x.project && (familyIds.includes(x.project)||all.some(q=>q.id===x.project&&fs.realpathSync(baseOf(q))===base))) || active.some(a=>{const q=all.find(x=>x.id===a.project);return q && (familyIds.includes(q.id) || fs.realpathSync(baseOf(q))===base);});
}});
const {Removal}=require('./lib/remove');
const removal=new Removal({store,reviewBusy:id=>removalReview.active(id),locked:id=>{const p=store.readProject(id);return p?maintenance.locked(id):false;},busy:(project,task)=>
  (()=>{const p=store.readProject(project);return p&&executionGate.busy(baseOf(p));})() || discussion?.active(project,task) || webchatActive(project,task) || historyBusy(project,task) || sessions.list().some(x=>x.running&&x.project===project&&(!task||x.task===task)) ||
  [...chats.running.keys()].some(k=>k.split('\u0000')[0]===project&&(!task||k.split('\u0000')[1]===task)) ||
  procwatch.list().some(x=>x.project===project&&(!task||!x.task||x.task===task))});
const removalReview=new (require('./lib/removal-review').RemovalReview)({store,removal,
 pick:()=>{const s=specialMode.pick(modelView.special(),rolesData(),'チェック');return s?{owner:launch.AI_KEY[s.ai],model:s.model,effort:s.effort}:null;},
 busy:(p,t)=>webchatActive(p,t)||Boolean(chats.busy(p,t)),queued:(p,t)=>chats.queue(p,t).length>0,
 rows:(p,t)=>{const dir=store.readProject(p)?.dir;return dir?chat.read(dir,t):[];},
 start:async o=>{
  const p=store.readProject(o.project),t=p.tasks.find(t=>t.id===o.task),ai=t.owner==='codex'?'codex':'claude',account=requestAccount(p,t.id,ai);
  const model=t.model || 'claude-fable-5-1',invalid=modelError(ai,model);if(invalid)throw Error(invalid);
  const turn={...o,ai,model,account,effort:t.effort || '高',role:'チェック',requireModel:true,requiredModel:launch.flagFor(ai,model),
   basePrompt:lt('読み取り専用の共有確認です。ファイルを編集せず、判定のJSONだけを返してください。'),policy:lt('読み取り専用。JSONだけを返してください。')};
  chats.enqueue(p.id,t.id,{...turn,id:o.request});
  try{const r=await chats.sendQueued(turn);chats.unqueue(p.id,t.id,o.request);return r;}
  catch(e){chats.unqueue(p.id,t.id,o.request);throw e;}
 }});
const aiTools = new AiTools({ root: ROOT, dry: DRY, busy: ai => sessions.list().filter(x => x.running && (!ai || x.ai === ai)).length + [...chats.running.values()].filter(x => !ai || x.ai === ai).length + procwatch.list().filter(x => x.project && (!ai || !x.ai || x.ai === ai)).length + Number(accounts.terminalBusy(ai)) });
aiTools.canOperate = () => restartControl?.committed ? lt('再起動を開始しています') : taskIntegrate.active || integrateAuto.active ? lt('統合の処理が進行中です') : appUpdate.applying() || appShell.rebuilding ? lt('Hubの更新が進行中です') : '';
sessions.startGate=o=>executionGate.acquire({dir:o.dir,owner:'terminal:'+o.project+':'+o.task+':'+o.ai});
sessions.endGate=o=>{executionGate.release('terminal:'+o.project+':'+o.task+':'+o.ai);ideaRunner?.wake(o.project);};
sessions.canStart = (ai,o) => {try{executionGate.assert({dir:o.dir,owner:'terminal:'+o.project+':'+o.task+':'+ai});}catch(e){return e.message;}return  restartControl?.committed ? lt('再起動を開始しています') : aiTools.isOperating(ai) ? lt('AI の更新・モデル再取得が進行中です') : '';};
const aiUpdates = new (require('./lib/ai-updates').AiUpdates)({ tools: aiTools, accounts, root: ROOT, onCatalog: applyModelCatalog });
const onboarding = new Onboarding({ root: ROOT, home: aiTools.home, tools: aiTools,
  projects: () => store.listProjects(), terminal: () => sessions.available(), dry: DRY });
function applyModelCatalog() {
  const catalog = aiTools.catalog();
  launch.setDiscoveredModels(catalog);
  roles.setModelCatalog(catalog);
}
applyModelCatalog();

// 版：起動した時の番号と、ファイル上の番号（更新を取り込むと変わる）
const PKG = path.join(__dirname, 'package.json');
// 版の番号：package.json が変わっていなければ読み直さない（一覧のたびに読んでいた）
let pkgSeen = null;
const readVersion = () => {
  try {
    const st = fs.statSync(PKG), key = `${st.mtimeMs}:${st.size}`;
    if (!pkgSeen || pkgSeen.key !== key) pkgSeen = { key, version: JSON.parse(fs.readFileSync(PKG, 'utf8')).version || '' };
    return pkgSeen.version;
  } catch (e) { return ''; }
};
const VERSION = readVersion();
const BOOT_HEAD=gitw.savedHead(__dirname)||null;
const HUB_INSTANCE = crypto.randomUUID();
function changelog(n) {
  let text = '';
  const pack = activePack(['docs']);
  try { text = fs.readFileSync(pack ? path.join(pack.directory, 'docs', 'CHANGELOG.md') : path.join(__dirname, 'CHANGELOG.md'), 'utf8'); } catch (e) { return []; }
  const out = [];
  for (const part of text.split(/^## /m).slice(1)) {
    const [head, ...rest] = part.split('\n');
    const m = head.match(/^([\d.]+)\s*（?([^）]*)）?/);
    out.push({ version: m ? m[1] : head.trim(), date: m ? m[2] : '', items: rest.filter(l => /^\s*-\s/.test(l)).map(l => l.replace(/^\s*-\s*/, '').trim()) });
    if (out.length >= n) break;
  }
  return out;
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/manifest+json', '.png': 'image/png' };

function stepSummary(steps) {
  return {total:steps.length,done:steps.filter(s=>s.done).length,next:steps.find(s=>!s.done)||null,
    marks:steps.map(s=>s.done?'1':'0').join(''),version:crypto.createHash('sha256').update(JSON.stringify(steps)).digest('hex')};
}
function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

// このパソコンの画面からの操作だけ受け付ける
function allowed(req) {
  const hosts = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
  if (!hosts.includes(req.headers.host)) return false;
  if (req.method === 'GET') return true;
  const origin = req.headers.origin;
  if (origin && !hosts.map(h => `http://${h}`).includes(origin)) return false;
  return req.headers['x-hub'] === '1';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 200000) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
  });
}

// 操作の記録（_hub/log.jsonl に1行ずつ）。1MB を超えたら log.old.jsonl に回す
const LOG_FILE = path.join(ROOT, '_hub', 'log.jsonl');
function record(action, b, extra) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE.replace(/\.jsonl$/, '.old.jsonl'));
    const row = { at: new Date().toISOString(), action, project: b.project, task: b.task, ai: b.ai || b.to, ...(extra || {}), ...(fromRemote() ? { remote: true } : {}) };
    fs.appendFileSync(LOG_FILE, JSON.stringify(row) + '\n');
  } catch (e) { /* 記録できなくても操作は続ける */ }
}
function integrationFailure(b,e,phase){
  // Log only typed fields, including on invalid requests. Logging must never
  // replace the original rejection, even if projection or recording fails.
  try {
    const text=(value,fallback='')=>typeof value==='string'&&value?value:fallback;
    const targets=Array.isArray(b?.selected)?b.selected.filter(x=>x&&typeof x.project==='string'&&typeof x.task==='string').map(x=>({project:x.project,task:x.task})):[];
    const paths=Array.isArray(e?.paths)?e.paths.filter(x=>typeof x==='string'):[];
    record('integrate-failed',{project:text(b?.project),task:text(b?.task)},{phase:text(phase,'unknown'),stage:text(e?.stage,'refresh'),code:text(e?.code,'INTEGRATION_REJECTED'),reason:text(e?.message,'統合を開始できません').slice(0,1000),targets,paths});
  } catch (err) { /* 記録の失敗で元の拒否応答を変更しない */ }
}
function readLog(n, file = LOG_FILE) {
  try { return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-n).reverse().map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); }
  catch (e) { return []; }
}

// 受け取ったファイルの置き場：AI-Workspace/Inbox/hub/<日付>/<時刻>-<名前>（場所に空白が入らないように）
const MAX_UPLOAD = 50 * 1024 * 1024;
function readRaw(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > max) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function saveUpload(name, data) {
  const d = new Date(), z = x => String(x).padStart(2, '0');
  const day = `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}`;
  const time = `${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
  const safe = path.basename(String(name || 'file')).replace(/[\x00-\x1f\x7f/\\:*?"<>|\s]+/g, '_').replace(/^\.+/, '').slice(-80) || 'file';
  const dir = path.join(ROOT, 'Inbox', 'hub', day);
  fs.mkdirSync(dir, { recursive: true });
  let f = path.join(dir, `${time}-${safe}`), i = 1;
  while (fs.existsSync(f)) f = path.join(dir, `${time}-${i++}-${safe}`);
  fs.writeFileSync(f, data);
  return f;
}

// CLI に渡すモデル名（設定画面で直せる）。空の文字＝モデルを指定しない（CLI の既定）
const CLI_MODELS = path.join(ROOT, '_hub', 'cli-models.json');
function loadCliModels() {
  let o = {};
  try { o = JSON.parse(fs.readFileSync(CLI_MODELS, 'utf8')); } catch (e) { o = {}; }
  // 4.5.1 までに「断られたので渡さない」と自動で覚えた空の名前は、推測した名前へのものなので消す（1回だけ）
  if (o && !o.v && Object.keys(o).length) {
    for (const ai of launch.AIS) for (const [k, v] of Object.entries(o[ai] || {})) if (v === '') delete o[ai][k];
    o.v = 2;
    try { fs.writeFileSync(CLI_MODELS, JSON.stringify(o, null, 2)); } catch (e) { /* 書けなくても続ける */ }
  }
  launch.setOverrides(o);
}
function saveCliModels(o) { fs.mkdirSync(path.dirname(CLI_MODELS), { recursive: true }); fs.writeFileSync(CLI_MODELS, JSON.stringify({ ...o, v: 2 }, null, 2)); loadCliModels(); }
loadCliModels();
// 候補：CLI 自身の設定から、実際に使えそうなモデル名を集める
function cliModelHints() {
  const home = process.env.HUB_AI_HOME || os.homedir();
  const catalog = aiTools.catalog();
  const out = { claude: new Set(catalog.claude.models.map(x => x.id)), codex: new Set(catalog.codex.models.map(x => x.id)), agy: new Set(catalog.agy.models.map(x => x.id)), grok: new Set(catalog.grok.models.map(x => x.id)) };
  try { const m = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8').match(/^\s*model\s*=\s*"([^"]+)"/m); if (m) out.codex.add(m[1]); } catch (e) { /* 無い */ }
  try { const j = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')); if (j.model) out.claude.add(j.model); } catch (e) { /* 無い */ }
  return { claude: [...out.claude], codex: [...out.codex], agy: [...out.agy], grok: [...out.grok] };
}

function rolesData() { return roles.read(ROLES_FILE).data; }
function limitRoutingEnabled() {
  try { license.require(['limit_switch']); } catch (e) { if (e.code === 'license_held') return false; throw e; }
  return rolesData().switch.auto === true || modelView.special().enabled;
}
function executionRoles() {
  const raw = rolesData(), mode = modelView.special();
  return mode.enabled ? { ...raw, specialMode: mode, roles: raw.roles.map(r => ({ ...r,
    main: { ...specialMode.pick(mode, raw, r.name), ai: launch.AI_KEY[mode.ai] } })) } : raw;
}

function delegateTerminalError(project, task) {
  const terminals = sessions.list().filter(s => s.project === project && s.task === task && s.running);
  if (!terminals.length) return '';
  const names = [...new Set(terminals.map(s => launch.AI_LABEL[s.ai] || s.ai))].join('・');
  return lt`この作業のターミナルで AI（${names}）が動いているため、委任できません。人に「この作業の作業画面で［ターミナル］に切り替え、${names}の欄の［停止］を押してから、会話でもう一度頼んでください」と案内してください。会話画面の［停止］は押させない（待っている指示も取り消されます）。裏で別の CLI を起動したり、この依頼を繰り返し送ったりしないでください。`;
}

function limitBackup(o, reason) {
  try { license.require(['limit_switch']); } catch (e) { if (e.code === 'license_held') return null; throw e; }
  if(discussionRuntime.isRequest(o.request)||integrationPolicyRequest(o))return null;
  const p = o.project && store.readProject(o.project), t = p?.tasks.find(t => t.id === o.task);
  const role = o.role || t?.role || '';
  if (!['claude', 'codex'].includes(o.ai)) return null;
  const backup = (reason === 'capacity' ? capacityRoute : limitRoute)(rolesData(), { ...o, role });
  if (modelView.special().enabled && backup?.ai !== o.ai) return null;
  return backup && { ...backup, account: accountFor(o.project, o.task, backup.ai), perm: permCmd(backup.ai) };
}
// ChatGPT アプリ・Codex の設定ファイル（~/.codex/config.toml）に、Hub の MCP が登録されているか
const CODEX_CONFIG = () => path.join(process.env.HUB_AI_HOME || os.homedir(), '.codex', 'config.toml');
const MCP_BLOCK = () => lt`\n# Project Hub の道具（作業を読む・結果を書き戻す）。Hub を起動しておくこと\n[mcp_servers.project-hub]\ncommand = "node"\nargs = ["${path.join(__dirname, 'mcp.js')}"]\n`;
function codexMcpStatus() {
  let text = '';
  try { text = fs.readFileSync(CODEX_CONFIG(), 'utf8'); } catch (e) { return { registered: false, configFile: CODEX_CONFIG(), configExists: false }; }
  return { registered: /^\s*\[mcp_servers\.project-hub\]/m.test(text), configFile: CODEX_CONFIG(), configExists: true };
}
function codexMcpRegister() {
  const file = CODEX_CONFIG();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') return { error: lt`設定ファイルを読めません：${file}` }; }
  if (/^\s*\[mcp_servers\.project-hub\]/m.test(text)) return { file, added: false };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (text) fs.copyFileSync(file, `${file}.bak-${new Date().toISOString().slice(0, 10)}`); // 念のため前の内容を残す
    fs.writeFileSync(file, text.replace(/\s*$/, '') + (text ? '\n' : '') + MCP_BLOCK());
  } catch (e) { return { error: lt`設定ファイルに書けません：${e.message}` }; }
  return { file, added: true };
}
// 表示・非表示と順番を同じ設定へ、互いを保って保存する。
const modelView = new (require('./lib/model-view').ModelView)(path.join(ROOT, '_hub', 'model-view.json'));
const hiddenModels = () => modelView.hidden();
const problemResolution = new (require('./lib/problem-resolution').ProblemResolution)({
  store, maintenance, pick: () => specialMode.pick(modelView.special(), rolesData(), '司令塔') || modelView.initial(),
  validate: pick => { if (aiTools.isOperating(pick.ai)) throw Error(lt('AI の更新・モデル再取得が進行中です')); const error = modelError(pick.ai, pick.model); if (error) throw Error(error); },
  active: (project, task) => removal.busy(project, task) || chats.busy(project, task),
  start: body => quickStart(body, true)
});

// 未読：見ていない間に AI の作業が終わった作業（_hub/unread.json に「プロジェクト\0作業」で残す）
const UNREAD_FILE = path.join(ROOT, '_hub', 'unread.json');
const unread = new Set((() => { try { return [].concat(JSON.parse(fs.readFileSync(UNREAD_FILE, 'utf8')).items || []).map(String); } catch (e) { return []; } })());
function saveUnread() {
  try { // 書きかけを読まないよう、別の名前に書いてから置き換える
    fs.mkdirSync(path.dirname(UNREAD_FILE), { recursive: true });
    const tmp = `${UNREAD_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ items: [...unread] }, null, 2));
    fs.renameSync(tmp, UNREAD_FILE);
  } catch (e) { /* 書けなくても続ける */ }
}
function setUnread(project, task, on) {
  const k = `${project}\u0000${task}`;
  if (!project || !task || on === unread.has(k)) return;
  if (on) unread.add(k); else unread.delete(k);
  saveUnread();
}
function pruneUnread() {
  if (require('./lib/unread').removeMissing(unread, store.product)) saveUnread();
}
// 会話の1回分が終わった時：誰も会話画面を見ていなければ未読にする
const chatEnded = (project, task) => { if (!(chats.watchers.get(chats.key(project, task))?.size > 0)) setUnread(project, task, true); };
// 作業画面（端末）が終わった時：見ている画面が無く、人が止めたのでなければ未読にする
function terminalLimitNotice(o, text) {
  const p = store.readProject(o.project); if (!p) return;
  const row = chat.append(p.dir, o.task, { role: 'event', ai: o.ai, text });
  chats.emit(o.project, o.task, { type: 'row', row }); setUnread(o.project, o.task, true);
  record('terminal-limit', o, { text });
}
function terminalPendingFile(p, t) { return path.join(p.dir, '.ai', 'handoff', `${t.id}-limit.json`); }
function terminalPending(p, t) {
  try { const data = JSON.parse(fs.readFileSync(terminalPendingFile(p, t), 'utf8')); return data.pending && data.task === t.id ? data : null; } catch { return null; }
}
function saveTerminalPending(p, t, data) {
  const file = terminalPendingFile(p, t); fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n'); fs.renameSync(tmp, file);
}
function terminalBusy(p, t, exceptAI) {
  return sessions.list().some(r => r.running && r.project === p.id && r.task === t.id && r.ai !== exceptAI) || chats.busy(p.id, t.id);
}
async function terminalLimitHandoff(o, src) {
  const stopTicket=stopControl.ticket(o);if(stopControl.held(o))return;
  const p = store.readProject(o.project), t = p?.tasks.find(t => t.id === o.task);
  if (!p || !t || t.state === '完了') throw Error(lt('作業が見つからないか完了したため、交代先を開始していません'));
  if (!src.exited || src.stopped) return;
  let backup = limitBackup(o); if (!backup) return;
  const file = store.taskFile(p.id, t.id), board = path.join(p.dir, '.ai', 'board.md');
  const from = `${launch.AI_LABEL[o.ai]}・${launch.modelLabel(o.ai, o.model)}`;
  const original = src.original || src.prompt || '';
  const packetFile = path.join(p.dir, '.ai', 'handoff', `${t.id}-limit-${src.started}.md`);
  const convo = transcript.collect({ ai: o.ai, dir: src.dir, since: src.started, buf: src.buf, accountDir: accounts.location(o.ai, src.account), source: src.limitWatch?.file });
  const pending = { pending: true, task: t.id, packet: packetFile, dir: src.dir, original, sourceAI: o.ai, sourceModel: o.model, role: o.role, from };
  const savePacket = () => {
    pending.to = `${launch.AI_LABEL[backup.ai]}・${backup.model}`;
    const card = buildHandoffCard({ original, user: { head: src.head, status: src.status }, rows: [], dir: src.dir, pdir: p.dir, task: t.id, from, to: pending.to });
    fs.mkdirSync(path.dirname(packetFile), { recursive: true });
    fs.writeFileSync(packetFile, card + '\n\n' + transcript.packet({ fromLabel: from, toLabel: pending.to, taskFile: file, board, convo, extra: lt('済んだ手順・変更・送信済み委任を繰り返さず、残りを続ける。操作記録も確認する。') }));
    saveTerminalPending(p, t, pending); // 起動失敗/両方上限でも資料と続きを残す。
  };
  savePacket();
  await refreshLimitEvidence({...o,...backup});
  if (src.stopped || stopControl.held(o) || stopControl.changed(o,stopTicket)) return;
  const latest = limitBackup(o); if (!latest) return;
  if (JSON.stringify(latest) !== JSON.stringify(backup)) { backup = latest; savePacket(); await refreshLimitEvidence({...o,...backup}); }
  if (JSON.stringify(limitBackup(o)) !== JSON.stringify(backup)) throw Error(lt('交代先の設定が変更されたため、資料を保存して待機します'));
  if (src.stopped || stopControl.held(o) || stopControl.changed(o,stopTicket)) return;
  if (appUpdate.applying()) throw Error(appUpdate.busyMessage());
  if (aiTools.isOperating(backup.ai)) throw Error(lt('AI の更新・モデル再取得が進行中です'));
  const current = store.readProject(p.id)?.tasks.find(t => t.id === o.task);
  if (!current || current.state === '完了') throw Error(lt('作業が見つからないか完了したため、交代先を開始していません'));
  if (limitEvidence.forRequest(backup)) throw Error(lt('引き継ぎ先も上限中のため待機します。資料を保存しました。解除後にターミナルで再開してください'));
  if (terminalBusy(p, t)) throw Error(lt('同じ作業で別のAIが動いているため、資料を保存して待機します'));
  assertWorkspaceIdle(p, t, false);
  if (!fs.existsSync(src.dir) || expandHome(current.workdir) && !transcript.same(expandHome(current.workdir), src.dir)) throw Error(lt('作業場所が変わったため、交代先を開始していません'));
  const invalid = modelError(backup.ai, backup.model); if (invalid) throw Error(invalid);
  accounts.available(backup.ai, backup.account, { forWork: true });
  const limitMarker = crypto.randomUUID();
  const prompt = lt`利用上限による交代です。引き継ぎ資料 ${packetFile} を読み、実物を確かめて残りを続けてください。` + '\n' + taskPrompt(p, t, file, src.dir, 'terminal', backup) + `\n[Hub terminal: ${limitMarker}]`;
  const argv = launch.buildArgv({ ...backup, prompt, cmd: permCmd(backup.ai), fast: codexFastFor(p.id, t.id) });
  const next = sessions.start({ project: p.id, task: t.id, dir: src.dir, ...backup, ...gitSnapshot(src.dir), prompt, limitMarker, command: argv.command, args: argv.args });
  next.original = original;
  saveTerminalPending(p, t, { ...pending, pending: false });
  terminalLimitNotice(o, lt`${from} の終了を確認し、同じターミナル作業を ${pending.to} で続けます`);
}
sessions.prepare = o => ['claude', 'codex'].includes(o.ai) ? captureTerminalLimit(o.ai, accounts.location(o.ai, o.account), o.limitMarker) : null;
const terminalLimits = new TerminalLimits({ sessions, limits: limitEvidence, enabled: () => limitRoutingEnabled(),
  backup: limitBackup, handoff: terminalLimitHandoff, refresh: refreshLimitEvidence, notify: terminalLimitNotice });
sessions.onExit = (project, task, ai, s) => {
  if (!s?.stopped && !(s?.watchers.size > 0)) setUnread(project, task, true);
  void terminalLimits.check(project, task, ai, s, true).catch(e => terminalLimitNotice({ project, task, ai }, e.message));
};
const terminalLimitTimer = setInterval(() => { if(restartControl?.committed)return; void terminalLimits.tick().catch(e => record('terminal-limit-error', {}, { error: e.message })); }, 2000);
terminalLimitTimer.unref();

// ChatGPT との連携：mcp.js から /api/mcp/* で呼ばれる道具。報告は会話画面にも流し、未読にする
// 子プロジェクトの結果を親へ渡す（親の受け取る作業に書き、会話に流し、未読にする）。失敗しても元の操作は続ける
const handoff = require('./lib/handoff');
function reportChild(child, kind, text) {
  try { return handoff.reportToParent(store, child, { kind, text }, { record, unread: chatEnded, emitRow: (project, task, row) => chats.emit(project, task, { type: 'row', row }) }); }
  catch (e) { console.log(lt`[親への報告] ${e.message}`); return false; }
}
// 背景AIの終了は、対応する未完了作業だけを未読にする。
// cwdの一致は古い完了作業を指す場合がある。不明な作業を先頭の作業で補わない。
const procwatch = require('./lib/procwatch').create({ projects: () => store.listProjects(), baseOf });
procwatch.onChange((list, { removed }) => {
  for (const x of removed) {
    if (!x.project) continue;
    let task = null;
    try { task = store.listProjects().find(p => p.id === x.project)?.tasks.find(t => t.id === x.task && t.state !== '完了')?.id; } catch (e) { /* 読めない時は通知先を推測しない。 */ }
    if (task) setUnread(x.project, task, true);
    record('bgended', { project: x.project, task: x.task || null, ai: x.ai }, { pid: x.pid, notified: Boolean(task) });
  }
});
const gpt = new (require('./lib/chatgpt').Chatgpt)({ file: path.join(ROOT, '_hub', 'chatgpt.json'), store, chat, baseOf, record,
  emitRow: (project, task, row) => chats.emit(project, task, { type: 'row', row }), ended: (project, task) => chatEnded(project, task) });

gpt.gptChildren = new (require('./lib/gpt-children').GptChildren)({ store, chat, baseOf, workRoot: p => path.join(ROOT, 'Work', p.id), record,
  emitRow: gpt.emitRow, ended: gpt.ended, assertIdle: (p, t, owner) => {
    if (chats.queue(p.id, t.id).length) { const e = Error(lt('AI・整理・確認が動いています')); e.status = 409; throw e; }
    assertWorkspaceIdle(p, t, false, false, owner, true);
  } });
webchat = new (require('./lib/webchat').Webchat)({ root: ROOT, gpt, store, chat, assertIdle: assertConversationIdle, onSettled: dispatchAfterWebchat,
  onReply: (p,t,row) => {
    if (p.kind !== 'freetalk' && row.asks?.length) {
      try { store.updateTask(p.id,t.id,{state:'返事待ち',question:row.asks.map(a=>a.question).filter(Boolean).join(' / ').slice(0,300)}); }
      catch(e) { record('webchat-metadata-error',{project:p.id,task:t.id},{error:e.message}); }
    }
  }, changed: () => {
  for (const j of webchat?.jobs || []) for (const task of new Set([j.task, j.parent].filter(Boolean))) chats.emit(j.project, task, { type: 'webchat' });
} });
// Conversations need a stable history and exclusive turn, not a clean Git tree.
function licenseGuard(options, stage = 'start') {
  if(options.project&&options.task){const ctx=reqCtx.getStore(),snapshot=ctx?.stopSnapshot,manual=ctx?.manualResume;
    if(manual&&options.project===manual.project&&options.task===manual.task)stopControl.checkManual(options,manual.ticket);
    else stopControl.assert(options,options.stopTicket || (snapshot?{epoch:snapshot.epoch,task:snapshot.tasks[JSON.stringify([options.project,options.task])]?.epoch||0}:undefined));}
  const active = [...sessions.list(), ...[...chats.running].map(([key, run]) => {
    const [project, task] = key.split('\0'); return { project, task, ai: run.ai, running: true };
  }), ...(webchat?.busy() || []).map(j => ({ project: j.project, task: j.task, ai: 'chatgpt', running: true })),
    ...procwatch.list().filter(p => !chats.supervisedPid(p.pid)).map(p => ({ ...p, running: true }))];
  return license.guard(options, { active, stage });
}
chats.licenseGuard = licenseGuard;
sessions.licenseGuard = licenseGuard;
webchat.licenseGuard = licenseGuard;
webchat.stopControl = stopControl;
webchat.licensePrepare = () => { void license.prepare(); };
function assertConversationIdle(p, t, owner, handoffErrors) {
  const fail = code => { const e = Error(code); e.status = 409; throw e; };
  if (restartControl?.committed || appUpdate.applying()) fail('webchat_restarting');
  chats.assertHandoffReady(p.id, t.id, handoffErrors);
  if (historyBusy(p.id, t.id) || removal.locked(p.id) || removalReview.active(p.id) ||
      chats.busy(p.id, t.id) || !owner && chats.queue(p.id, t.id).some(q=>!q.stopHeld) ||
      sessions.list().some(s => s.running && s.project === p.id && s.task === t.id) ||
      procwatch.list().some(s => s.project === p.id && (!s.task || s.task === t.id) &&
        !chats.supervisedPid(s.pid) && !procwatch.hasAncestor(s.pid,pid=>chats.supervisedPid(pid,{activeOnly:true})))) fail('webchat_task_busy');
  if (p.kind === 'freetalk') {
    const state = freetalkHistory.state(t.id);
    if (state.migrated || state.summary?.intent === 'promote' && state.summary.automatic && !state.summary.automatic.error) fail('webchat_topic_readonly');
  }
}
async function dispatchAfterWebchat(j) {
  if(stopControl.held({project:j.project,task:j.task}))return;
  const next = chats.queue(j.project, j.task)[0];
  if (!next || next.stopHeld || next.error || next.limitWaiting || restartControl?.committed || webchatActive(j.project,j.task)) return;
  const p = store.readProject(j.project); if (!p) return;
  try {
    const r = await chats.sendQueued({ ...next, project:p.id, task:j.task, pdir:p.dir, dir:undefined,
      request:next.id, mode:'queued', onEnd:row=>{
        if(!next.isolatedReview && row.asks?.length) store.updateTask(p.id,j.task,{state:'返事待ち',question:row.asks.map(a=>a.question).join(' / ').slice(0,300)});
        chatEnded(p.id,j.task);
      } });
    if (!(await r.started)) throw Error(lt('AIを起動できませんでした'));
    chats.unqueue(p.id,j.task,next.id);
  } catch(e) {
    if (chats.queue(p.id,j.task).some(q=>q.id===next.id)) chats.setQueue(p.id,j.task,chats.queue(p.id,j.task).map(q=>q.id===next.id?{...q,error:e.message}:q));
  }
}
const github = require('./lib/github').createGithub({ settingsFile: path.join(ROOT, '_hub', 'github.json'), dry: DRY,
  idle: p => {
    assertWorkspaceIdle(p, { workspaceMode: 'isolated' }, false, true);
    const canonical = d => { try { return fs.realpathSync(d); } catch { return path.resolve(d); } };
    const base = canonical(baseOf(p));
    const githubFolder = p.githubFolder ? canonical(p.githubFolder) : base;
    const all = store.listProjects();
    const active = [...sessions.list().filter(s => s.running), ...[...chats.running.keys()].map(k => { const [project, task] = k.split('\u0000'); return { project, task }; }), ...procwatch.list()];
    if (active.some(a => {
      const q = all.find(x => x.id === a.project); if (!q) return false;
      const qbase = canonical(baseOf(q)); if (qbase !== base && qbase !== githubFolder) return false;
      const t = q.tasks.find(x => x.id === a.task);
      return !t || t.workspaceMode === 'direct' || !t.workdir || [qbase, githubFolder].includes(canonical(expandHome(t.workdir)));
    })) { const e = Error(lt('同じ本体でAIが作業中です。終わってから作ってください')); e.status = 409; throw e; }
  }
});
const githubProject = p => ({ ...p, base: baseOf(p) });
// Only mapped project AI can affect this Hub; unrelated app helpers stay alive independently.
// queue() reloads saved requests too, including the permanent freetalk project.
const appShell = new (require('./lib/app-shell').AppShell)({ hub: __dirname, dry: DRY });
const updateBlockers = () => {
  const all=store.listProjects(),out=[];
  const add=(kind,project,task,message)=>{
    const p=all.find(p=>p.id===project),t=p?.tasks.find(t=>t.id===task);
    const label=p ? p.name+(t ? '／'+t.title : '') : project||'';
    out.push({kind,project:project||'',task:task||'',message:label ? label+'：'+message : message});
  };
  for(const j of webchat?.busy() || []) add('webchat',j.project,j.task,lt('Chat／Proの自動送信が進行中です'));
  if(webchat?.control)add('webchat-control','','',lt('Chat／Proの操作が進行中です'));
  if(appShell.rebuilding)add('rebuild','','',lt('アプリの作り直しが進行中です'));
  if(aiTools.isOperating())add('cli','','',lt('AI CLIの操作が進行中です'));
  for(const x of sessions.list())if(x.running)add('terminal',x.project,x.task,lt('ターミナルのAIが稼働しています'));
  for(const k of chats.running.keys()){const [project,task]=k.split('\0');add('chat',project,task,lt('会話のAIが稼働しています'));}
  for(const x of procwatch.list())if(x.project){add('background',x.project,x.task,lt('関連するAIプロセスが残っています'));out[out.length-1].pid=x.pid;}
  for(const [k,q] of chats.queues)if(q.length){const [project,task]=k.split('\0');add('queue',project,task,lt('順番待ちがあります'));}
  for(const p of all){
    if(historyBusy(p.id))add('history',p.id,'',lt('会話を整理中です'));
    if(problemResolution.starting.has(p.id))add('resolution',p.id,'',lt('問題の整理が進行中です'));
    if(maintenance.locked(p.id))add('maintenance',p.id,'',lt('整理・確認が進行中です'));
    if(github.locked(baseOf(p)))add('github',p.id,'',lt('GitHubの操作が進行中です'));
    for(const t of p.tasks)if(chats.queue(p.id,t.id).length)add('queue',p.id,t.id,lt('順番待ちがあります'));
  }
  return out.filter((x,n)=>{
    if(x.kind==='background'&&(!Number.isSafeInteger(x.pid)||x.pid<=0))return true;
    return out.findIndex(y=>y.kind===x.kind&&y.project===x.project&&y.task===x.task&&(x.kind!=='background'||y.pid===x.pid))===n;
  });
};
const updateRuntimeBusy = () => restartControl?.committed || executionGate.barrier || executionGate.leases.size>0 || discussion?.active() || Boolean(webchat?.busy().length || webchat?.control) || appShell.rebuilding || aiTools.isOperating() || sessions.list().some(x => x.running) || chats.running.size > 0 || procwatch.list().some(x => x.project) ||
  store.listProjects().some(p => maintenance.locked(p.id) || github.locked(baseOf(p)));
const updateBusy = (handoffErrors) => restartControl?.committed || (handoffErrors ?? chats.handoffErrors()).length>0 || taskIntegrate.active || integrateAuto.active || updateRuntimeBusy() || [...chats.queues.values()].some(q => q.length > 0) || store.listProjects().some(p => p.tasks.some(t => chats.queue(p.id, t.id).length > 0));
const updateSource = process.env.HUB_UPDATE_SOURCE || '';
// Translation is opt-in and requires an optional pack in the update source.
const translationReady = fs.existsSync(path.join(updateSource, 'hub/lib/locale.js')) && Boolean(loadPack({ dir: path.join(updateSource, 'langpacks/zh-TW'), warn: false }));
const automation = process.env.HUB_AUTO_TRANSLATE === '1' && process.env.HUB_TRANSLATION_FORK && translationReady
  ? require('./lib/app-update-workflow').createAutomation({ root: ROOT, env: process.env }) : {};
const appUpdate = new (require('./lib/app-update').AppUpdate)({ root: ROOT, source: updateSource,
  appPath: process.env.HUB_UPDATE_APP || '', version: VERSION, hubPath: __dirname, license, env: process.env, dry: DRY, busy: updateBusy, ownerEdition: license.owner, ...automation });
move.edition = license.owner ? 'owner' : 'public';
move.busy = () => updateBusy() || appUpdate.running || appUpdate.applying() || activeRequests > 0 || taskHistory.activeWrites.size > 0 || freetalkHistory.activeWrites?.size > 0 || restartBlockers().length > 0;
move.barrier = on => { executionGate.barrier = on; };

let updateRestoreReady = false;
function permCmd(ai) {
  const p = rolesData().permissions || {};
  if (ai === 'agy' || ai === 'grok') return launch.DEFAULT_CMD[ai];
  const v = p[launch.AI_KEY[ai]];
  return typeof v === 'string' && /^(claude|codex)\b/.test(v) ? v : launch.DEFAULT_CMD[ai];
}

// 作業の役割 → いつもの担当（AI・モデル・思考）。作業ファイルに指定があればそちら
function pickSpec(task, ai) {
  const data = rolesData();
  const r = data.roles.find(x => x.name === task.role);
  const slot = r ? (r.main.ai === (launch.AI_KEY[ai]) ? r.main : r.backup.ai === (launch.AI_KEY[ai]) ? r.backup : null) : null;
  // 作業に指定があれば、候補から消えていても別のモデルへ置き換えない。
  const mode = modelView.special();
  const modeSpec = specialMode.pick({ ...mode, ai }, data, task.role);
  const taskModel = task.model && (!mode.enabled || !modelError(ai, task.model)) ? task.model : '';
  const model = launch.modelLabel(ai, taskModel || (slot && slot.model) || modeSpec?.model || '');
  const effort = roles.EFFORTS.includes(task.effort) ? task.effort : (slot && slot.effort) || '';
  return { model, effort: ai === 'agy' ? '高' : effort };
}

function modelError(ai, model) {
  if (ai === 'chatgpt') return chat.CHATGPT_RETIRED;
  model = launch.modelLabel(ai, model);
  if (ai === 'agy') {
    const route = launch.agyAccountError();
    if (route) return route;
    const catalog = aiTools.catalog().agy;
    if (catalog.state === 'failed') return lt('モデル一覧の取得に失敗しています。再取得してから選んでください');
    if (!model) return lt('Agy の利用可能なモデルを一覧から選んでください');
    const id = launch.flagFor(ai, model);
    if (!catalog.models.some(row => row.id === id)) return lt`モデル「${model}」は現在の候補から外れています。新しいモデルを選んでください`;
  }
  if (!model) return '';
  if (aiTools.staleModel(ai, model)) return lt`モデル「${model}」は現在の候補から外れています。新しいモデルを選んでください`;
  if (Object.prototype.hasOwnProperty.call(launch.getOverrides()[ai] || {}, model)) return '';
  return launch.flagFor(ai, model) ? '' : lt`モデル「${model}」の CLI 名が分かりません。設定で直してください`;
}

// 作業する場所：作業ファイルの workdir → なければ用意する（Git なら作業用コピー、無ければ保存を始めて本体）
const workRoot = p => path.join(ROOT, 'Work', p.id);
function baseOf(p) {
  const body = p.folders.find(f => f.label === '本体');
  const d = body && expandHome(body.path);
  return d && fs.existsSync(d) ? d : p.dir;
}
function assertWorkspaceIdle(p, t, permitChat, githubOperation = false, gptOwner, gptOperation = false) {
  executionGate.assert({dir:expandHome(t.workdir)||baseOf(p),owner:permitChat?'chat:'+p.id+':'+t.id:undefined});
  if (restartControl?.committed) { const e=Error(lt('再起動を開始しています'));e.status=409;throw e; }
  const own = gptOwner && (gpt.gptChildren.owners.get(p.id + '/' + t.id) === gptOwner || webchat?.current?.lease === gptOwner && webchat.current.project === p.id && webchat.current.task === t.id);
  if ((!own && webchatActive(p.id, t.id)) || gptOperation && conversationHistory?.organizing(p.id, t.id)) { const e = Error(lt('AI・整理・確認が動いています')); e.status = 409; throw e; }
  if (appUpdate.applying()) { const error = Error(appUpdate.busyMessage()); error.status = 409; throw error; }
  if (maintenance.locked(p.id)) {const e=Error(lt('同じ本体で検証中です。終わってからAIを始めてください'));e.status=409;throw e;}
  const canonical = dir => { try { return fs.realpathSync(dir); } catch(e) { return path.resolve(dir); } };
  const base = canonical(baseOf(p));
  const chosenDir = (p,t) => {
    const wd=expandHome(t.workdir);if(wd&&fs.existsSync(wd))return wd;
    const r=taskIntegrate.read(p.id,t.id);return r&&!r.complete?r.target:wd;
  };
  const onBase = (p,t) => {
    if(t.workspaceMode==='direct')return true;
    const r=t.id&&taskIntegrate.read(p.id,t.id),dir=chosenDir(p,t);
    return Boolean(r&&!r.complete&&dir&&canonical(dir)===canonical(baseOf(p)));
  };
  const targetDirect = onBase(p,t);
  if (!githubOperation) github.assertStart(githubProject(p), { ...t, workdir: chosenDir(p,t) });
  const active = [...sessions.list().filter(s=>s.running), ...[...chats.running.keys()].map(k=>{const [project,task]=k.split('\u0000');return {project,task,chat:true};})];
  if (!active.length) return;
  const all = store.listProjects();
  for (const a of active) {
    if (p.kind==='freetalk' && t.id && a.project===p.id && a.task!==t.id) continue;
    if (permitChat && a.chat && a.project===p.id && a.task===t.id) continue;
    const q=all.find(x=>x.id===a.project), at=q?.tasks.find(x=>x.id===a.task); if(!q || !at)continue;
    if(gptOperation && (a.project===p.id && a.task===t.id || chosenDir(q,at) && chosenDir(p,t) && canonical(chosenDir(q,at))===canonical(chosenDir(p,t))) || canonical(baseOf(q))===base && (targetDirect || onBase(q,at))) {
      const e=Error(lt('同じ本体でAIが作業中です。本体での同時作業はできません'));e.status=409;throw e;
    }
  }
}
function workDir(p, t) {
  if (p.kind === 'freetalk') { freetalk.verify(); return { dir: freetalk.dir }; }
  const wd = expandHome(t.workdir);
  if (wd && fs.existsSync(wd)) return { dir: wd };
  const pending = taskIntegrate.startTarget(p,t);
  if (pending) return pending;
  const base = baseOf(p);
  if (DRY) return { dir: base };
  try {
    const r = gitw.prepare({ base, workRoot: workRoot(p), taskId: t.id, direct: t.workspaceMode === 'direct' || base === p.dir });
    if (r.worktree) store.updateTask(p.id, t.id, { workdir: r.dir });
    return r;
  } catch (e) {
    return { dir: base, note: lt`作業用コピーを作れなかったため、本体で作業します（${String(e.message || e).split('\n')[0]}）` };
  }
}
function startDir(p,t,permitChat=false) {
  if(discussion?.active(p.id,t.id))throw Error('話し合いが進行中です。停止または完了後に始めてください');
  assertWorkspaceIdle(p,t,permitChat);
  const result=workDir(p,t);
  if(!t.workspaceStarted)store.updateTask(p.id,t.id,{workspaceStarted:new Date().toISOString()});
  return result;
}
const inWork = (p, t) => { const wd = expandHome(t.workdir); const rel = wd && path.relative(workRoot(p), wd); return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel); };
// 作業ファイルに作業用コピーの場所が書いてあるのに、その場所が無い（取り込んでゴミ箱へ移した後に、AI が古い内容で書き戻した時など）
const copyMissing = (p, t) => inWork(p, t) && !fs.existsSync(expandHome(t.workdir));
// この作業を本体に取り込んだ記録（いちばん新しいもの）
const lastMerge = (project, task) => require('./lib/integration-log').lastMerge(LOG_FILE, project, task);

const taskTransfer = new (require('./lib/task-transfer').TaskTransfer)({store,removal,baseOf,
  integration:(p,t)=>gitw.integrationReceipt(baseOf(p),lastMerge(p.id,t.id),t),
  notify:(project,task,id)=>{const p=store.readProject(project);const row=p&&chat.read(p.dir,task).find(x=>x.handoff===id||x.offer===id||x.partialReceipt===id);if(row)chats.emit(project,task,{type:'row',row});chatEnded(project,task);}
});
const taskIntegrate = new (require('./lib/task-integrate').TaskIntegrate)({store,transfer:taskTransfer,removal,baseOf});
const projectNotes = new (require('./lib/project-notes').ProjectNotes)({store,busy:project=>updateBusy()||maintenance.locked(project)});
const mainMergeTokens=new Map();
const mainMergeDelivery=new (require('./lib/main-merge-delivery').MainMergeDelivery)(ROOT,gitw,LOG_FILE);
let mainMergeFlow;
async function internalResult(call){
  let status,body;const response={writeHead:code=>{status=code;},end:text=>{body=JSON.parse(text);}};
  await call(response);if(status!==200||!body?.ok)throw Object.assign(Error(body?.error||lt('正式操作の結果を確認できません')),{delivery:body?.delivery});return body;
}
const integrationBlockers = (b,{op}={}) => {
  if(!['receipt','main-merge'].includes(op))throw Error('統合操作の種類を確認できません');
  if(!b?.project)return [...(appUpdate.applying()?[{kind:'update',message:lt('Hubの更新が進行中です')}]:[]),...(restartControl?.committed?[{kind:'restart',message:lt('再起動を開始しています')}]:[])];
  const record=op==='receipt'&&taskIntegrate.read(b.project,b.task),all=store.listProjects();
  let selected=b.selected||record&&!require('./lib/task-continuation').closed(record)&&record.items;
  if(!selected&&op==='receipt'){const a=taskIntegrate.ancestor(b.project,b.task,{allowBusy:true});selected=all.flatMap(p=>p.tasks.filter(t=>taskIntegrate.simple.related(a,p,t)).map(t=>({project:p.id,task:t.id})));}
  const p=all.find(p=>p.id===b.project),t=p?.tasks.find(t=>t.id===b.task),target=op==='main-merge'&&t&&gitw.mainOf(expandHome(t.workdir));
  const paths=target?gitw.changedBetween(target,gitw.inspect(target,{readOnly:true}).head,gitw.inspect(expandHome(t.workdir),{readOnly:true}).head):[];
  const gatedDirs=[target||t&&(expandHome(t.workdir)||baseOf(p)),...(Array.isArray(selected)?selected:[]).map(c=>{const q=all.find(p=>p.id===c.project),x=q?.tasks.find(t=>t.id===c.task);return q&&(expandHome(x?.workdir)||baseOf(q));})].filter(Boolean);
  const executionWaiting=gatedDirs.some(dir=>executionGate.busy(dir));
  return require('./lib/integration-safety').blockers({op,target,paths,b:{...b,selected},all,baseOf,expand:expandHome,activities:updateBlockers(),global:[
    ...(executionWaiting?[{kind:'execution',message:lt('同じ開発場所の実行・検証・復旧が終わるまで待っています')}]:[]),
    ...(target?mainMergeFlow?.blockers(target)||[]:[]),
    ...(appUpdate.applying()?[{kind:'update',message:lt('Hubの更新が進行中です')}]:[]),
    ...(restartControl?.committed?[{kind:'restart',message:lt('再起動を開始しています')}]:[])]});
};
const integrateAuto=new (require('./lib/integrate-auto').IntegrateAuto)({integrate:taskIntegrate,busy:b=>Boolean(stopControl.held(b)||integrationBlockers(b,{op:'receipt'}).length>0),waitStatus:b=>integrationBlockers(b,{op:'receipt'}),
  dispatch:async request=>{
    let started=false,status,body;
    const res={integrationDelivery:{begin:()=>{started=true;}},writeHead:code=>{status=code;},end:text=>{body=JSON.parse(text);}};
    try{
      const assigned=integrationAssignment(request);
      await delegateRequest(assigned,res,{allowCompleted:Boolean(request.organize),resultsOrganize:Boolean(request.organize),resultsRecovery:Boolean(request.organize),...(request.organize?{beforeStart:()=>taskIntegrate.simple.organizeStart(request)}:{}),preserveTaskState:Boolean(request.organize||request.isolatedReview),isolatedReview:request.isolatedReview===true&&request.role==='チェック',review:request.review,requestKey:request.requestKey,integrationAssignment:assigned.integrationAssignment});
      const delivery={state:status===200&&body?.ok?'accepted':started?'unknown':'not-sent',request:request.requestKey,...(body?.queued&&body.id?{queueId:body.id}:{}),status,at:new Date().toISOString()};
      if(status!==200||!body?.ok)throw Object.assign(Error(body?.error||lt('正式操作の結果を確認できません')),{delivery});
      return {...body,delivery};
    }catch(e){if(!e.delivery)e.delivery={state:started?'unknown':'not-sent',request:request.requestKey,at:new Date().toISOString()};throw e;}
  },
  mergeMain:(r,{begin})=>internalResult(async res=>{
    const p=store.readProject(r.project),t=p?.tasks.find(t=>t.id===r.task);
    if(t&&r.target===baseOf(p))return send(res,200,{ok:true,retained:true,main:r.target});
    if(!t||!inWork(p,t)||expandHome(t.workdir)!==r.target)throw Error(lt('本体取り込みの対象が変わりました'));
    const source=gitw.inspect(r.target),target=gitw.mainOf(r.target),main=target&&require('./lib/integration-writes').inspect(gitw,target);
    if(integrationBlockers(r,{op:'main-merge'}).length||!source||source.status||!main||main.status||main.head!==r.auto.mainHead||gitw.merging(target))throw Error(lt('本体取り込みの前提を確認できません'));
    const req=require('node:stream').Readable.from([Buffer.from(JSON.stringify({project:r.project,task:r.task,disposition:'continue',confirm:true,sourceHead:source.head,targetHead:main.head}))]);
    req.method='POST';req.headers={'x-hub':'1'};res.integrationMain={begin};await api(req,res,new URL('http://localhost/api/task/merge'));
  }),
  notify:r=>{if(r.auto.stopped)integrationFailure({...r,selected:r.items},Object.assign(Error(r.auto.stopped.reason),r.auto.stopped),'tick');const p=store.readProject(r.project);if(!p)return;const text=r.auto.stopped?lt`自動統合を停止しました：${r.auto.stopped.reason}`:r.auto.main?.state==='done'?lt(r.auto.main.skipped?'子作業の受領が完了しました。本体への反映は別に確認してください':'本体に取り込み済み・新しい版を待っています'):lt('統合を自動で続けています');
    const row=chat.append(p.dir,r.task,{role:'event',text});chats.emit(r.project,r.task,{type:'row',row});pruneUnread();}
});
taskIntegrate.validateAssignment=(ai,model)=>{const invalid=modelError(ai,model);if(invalid)throw Error(invalid);};
function integrationPolicyRequest(o){
  const q=o.project&&o.task?chats.queue(o.project,o.task).find(q=>q.id===o.request):undefined;
  return require('./lib/integration-assignment').find(taskIntegrate,o,q);
}
function verifyIntegrationAssignmentSend(o){
  const q=o.project&&o.task?chats.queue(o.project,o.task).find(q=>q.id===o.request):undefined;
  return require('./lib/integration-assignment').verify(taskIntegrate,o,q,taskIntegrate.validateAssignment);
}
function integrationAssignment(request){
  const fixed=require('./lib/integration-assignment').assign(taskIntegrate,request);
  if(fixed){taskIntegrate.validateAssignment(fixed.ai,fixed.model);return fixed;}
  const b=require('./lib/integration-delivery').assignment(request,executionRoles()),role=rolesData().roles.find(r=>r.name===b.role);
  if(!modelView.special().enabled&&role?.main.ai!==launch.AI_KEY[b.ai])throw Error(lt('role は指定した AI が主担当の役割を選んでください'));
  const invalid=modelError(b.ai,b.model);if(invalid)throw Error(invalid);
  if(!launch.flagFor(b.ai,b.model))throw Error(lt('委任には CLI に渡すモデル名が必要です。指定なしでは起動しません'));
  return b;
}
integrateAuto.probeRequest=request=>{
  const assigned=integrationAssignment(request),p=store.readProject(request.project),t=p?.tasks.find(t=>t.id===request.task);
  if(!t||t.state==='完了'&&!request.organize)throw Error(DELEGATE_COMPLETED_ERROR);
  if(assigned.integrationAssignment&&limitEvidence.active(requestAccount(p,t.id,assigned.ai),launch.flagFor(assigned.ai,assigned.model)))throw Error('指定した統合担当が上限中です。担当を替えず解除まで待機します');
  if(typeof request.text!=='string'||!request.text.trim()||request.text.trim().length>8000)throw Error(lt('text は1〜8000文字'));
  if(assigned.ai==='grok'&&assigned.effort==='Ultra')throw Error(lt('Grok の思考は 中・高・極高・MAX です'));
  const error=delegateTerminalError(request.project,request.task);if(error)throw Error(error);
  assertWorkspaceIdle(p,t,false);
  if(aiTools.isOperating()||chats.busy(request.project,request.task)||chats.queue(request.project,request.task).length)throw Error(lt('別の依頼が作業中・順番待ちのため成果整理を開始していません'));
  return assigned;
};
integrateAuto.deliveryEvidence=(r,k,a)=>{const c=a.phase==='organize'?a:r,p=store.readProject(c.project);return p?require('./lib/integration-delivery').evidence({pdir:p.dir,task:c.task,logFile:LOG_FILE,k,phase:a.phase,attempt:a,queueFiles:store.listProjects().flatMap(p=>p.tasks.map(t=>path.join(p.dir,'.ai/chat',t.id+'.queue.json')))}):{complete:false,sent:true};};
const integrationAbandon=new (require('./lib/integration-abandon').IntegrationAbandon)({integrate:taskIntegrate,auto:integrateAuto,chats,logFile:LOG_FILE});
integrateAuto.abandon=integrationAbandon;
const integrationConversation=(r,k,phase)=>phase==='organize'?r.auto.attempts[k]:r;
integrateAuto.pendingRequest=(r,k,phase,sourceRequest)=>{const c=integrationConversation(r,k,phase);return chats.pendingIntegration(c.project,c.task,k,phase,sourceRequest);};
integrateAuto.savedCompletion=(r,k,phase)=>{const c=integrationConversation(r,k,phase),p=store.readProject(c.project);return p&&chat.read(p.dir,c.task).findLast(row=>row.role==='assistant'&&row.integrationAuto?.key===k&&row.integrationAuto.phase===phase&&row.integrationAuto.closed===true);};
integrateAuto.questionResolution=(r,k,a,row)=>{const p=store.readProject(r.project),q=require('./lib/integration-question');return p&&q.resolution(q.read(p.dir,r.task),{k,a,row});};
const integrateTimer=setInterval(()=>{void integrateAuto.tick();},60000);integrateTimer.unref();
const resultsGate = new (require('./lib/results-gate').ResultsGate)({store,transfer:taskTransfer,
  blocked:(p,t)=> t.question || ['返事待ち','上限で停止'].includes(t.state) ? lt('質問・返事待ちを先に済ませてください')
    : chats.busy(p.id,t.id) ? lt('AIが作業中です') : chats.queue(p.id,t.id).length ? lt('順番待ちがあります')
    : delegateTerminalError(p.id,t.id) || (removal.busy(p.id,t.id) || removal.locked(p.id) ? lt('AI・整理・確認が動いています') : '')
    || (()=>{const hand=taskTransfer.read(p.id,t.id),batch=taskIntegrate.read(p.id,t.id);
      return hand?.integrating&&!hand.complete || batch&&!batch.complete ? lt('統合が進行中です') : '';})(),
  launch:async(p,t,issue)=>{
    const role=executionRoles().roles.find(r=>r.name==='調査');
    if(!role?.main.model || !['codex','claude-code','agy','grok'].includes(role.main.ai))throw Error(lt('設定の調査担当を確かめてください'));
    const res={writeHead(status){this.status=status;},end(body){this.body=JSON.parse(body);}};
    await delegateRequest({...taskTransfer.organizeRequest(p,t,issue.reason),role:role.name,ai:role.main.ai==='claude-code'?'claude':role.main.ai,model:role.main.model,effort:role.main.effort},res,
      {allowCompleted:true,resultsOrganize:true,resultsRecovery:true,beforeStart:()=>{
        const current=store.readTask(store.taskFile(p.id,t.id));
        if(current.completionHash!==t.completionHash)throw Error(lt('成果整理の開始前に作業が変わりました'));
      }});
    if(res.status!==200 || res.body?.queued)throw Error(res.body?.error || lt('別の依頼が始まったため成果整理を開始していません'));
  }
});


// iPhone で開くアドレス（Tailscale の Mac の名前）。tailscale が無い・止まっている時は空。1分は覚えておく
let tsCache = { at: 0, url: '' };
function tailscaleUrl() {
  if (Date.now() - tsCache.at < 60000) return Promise.resolve(tsCache.url);
  const { execFile } = require('child_process');
  const bins = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale'];
  const tryAt = i => new Promise(done => {
    if (i >= bins.length) return done('');
    execFile(bins[i], ['status', '--json'], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (err) return tryAt(i + 1).then(done);
      try { const dns = String(JSON.parse(out).Self.DNSName || '').replace(/\.$/, ''); done(dns ? 'https://' + dns : ''); } catch (e) { done(''); }
    });
  });
  return tryAt(0).then(u => { tsCache = { at: Date.now(), url: u }; return u; });
}
// 別の AI に作業を渡す時の決まり（AI が裏で codex/claude を起動すると Hub に見えず、画面では終わったことになるため）
const CHAT_DELEGATE_NOTE = lt('この委任APIは会話画面からだけ使えます。委任が「この作業のターミナルで AI が動いています」と断られた時だけ、人に次のように頼む：「この作業の作業画面で［ターミナル］に切り替え、動いている AI の欄の［停止］を押してから、もう一度この会話で頼んでください」。断られていない時は、ターミナルの停止や終了を人に頼まない。裏で別のCLIを起動したり、この依頼を繰り返し送ったりしないでください。');
const TERMINAL_LIMIT_NOTE = lt('ターミナルでもHubが確定上限または新鮮な100%を確認して共通フラグを保持し、元AIの終了を確認してから同じ作業を交代先へ引き継ぐ。自分で別のCLIを起動しない。人の停止では自動交代しない。');
const TERMINAL_HANDOFF_NOTE = lt('あなたはターミナルで動いている。ここからは別の AI に委任できない。渡したい時は、渡す内容と指定モデルを作業ファイルに書いて返事を終える。人には「この作業の作業画面で［会話］に切り替えて、記録した依頼を送ってください」とだけ案内する。ターミナルを止める操作は頼まない（会話から送った依頼が断られた時に、会話側の AI が案内する）。');
const DELEGATE_COMPLETED_ERROR = lt('この作業は完了済みのため委任できません。続ける場合は、人がこの作業の作業画面の上部の［再開する］を押してから依頼してください。新しい作業は作っていません');
function delegateRule(p, t) {
  const d = executionRoles();
  const coding = roles.delegateSlot(d, 'コーディング');
  let examples = ['チェック', '文章', '調査', 'デザイン'].map(name => { const s = roles.delegateSlot(d, name); return s ? lt`${name}は ai: ${s.ai}・model: ${s.model}` : lt`${name}は人が担当`; }).join('、');
  if (roles.delegateSlot(d, 'チェック')?.model === 'claude-fable-5-1' && ['文章', '調査', 'デザイン'].every(name => roles.delegateSlot(d, name)?.ai === 'claude' && roles.delegateSlot(d, name)?.model === 'claude-opus-5-5')) examples = lt('チェックは ai: claude・model: claude-fable-5-1、文章・調査・デザインは claude-opus-5-5');
  const ids = p && t ? `"project":"${p.id}","task":"${t.id}"` : lt('"project":"<プロジェクトID>","task":"<作業ID>"');
  return lt`【別の AI に作業を渡す時】自分で codex / claude / agy / grok を裏で起動しない。${CHAT_DELEGATE_NOTE} 会話画面で渡す時は Hub を使う：curl -s -X POST http://127.0.0.1:${PORT}/api/delegate -H 'X-Hub: 1' -H 'Content-Type: application/json' -d '{${ids},"ai":"${coding?.ai || 'codex'}","model":"${coding?.model || 'gpt-6.1-sol'}","title":"短い名前","text":"頼む内容（必要な背景も）"}'。ai は codex / claude / agy / grok。model は依頼文の中だけでなく、この欄で必ず指定する（${examples}）。Hub は同じ作業の会話で担当 AI を切り替え、今の AI が動いている間は順番待ちにする。子作業は作らない。画面に順番待ち・作業中と出て、結果もこの会話に残る。相手に「実際のモデルを確かめて違えば止まれ」と書かない。モデルは model 欄で Hub が起動設定として保証する（実際のモデルの証明ではない）。モデル名を返させる時は「起動設定のモデル名」と頼む。上記の自動交代が有効な時は、Hub が保存した役割分担に従って引き継ぐので、自分で別のモデルへ委任し直さない。渡したらこの番を終えること。\n【プロジェクトや作業を増やさない】新しいプロジェクト・子プロジェクト・作業ファイル（.ai/tasks）を自分で作らない。分ける必要がある時は、人に提案して決めてもらう。やっていない手順に [x] を付けない。`;
}
// 人が決めた役割とモデル（roles.yaml）。AI が他のファイル（エージェントの設定など）の古い指定に従わないよう、毎回伝える
function modelPolicy(p, t, where = 'chat', projects) {
  // startDir が保存したコピーの場所・手順なども、同じ台帳の最新値で渡す。
  const current = store.readProject(p.id);
  if (current) { p = current; t = current.tasks.find(x => x.id === t.id) || t; }
  const d = rolesData();
  const label = s => (launch.AI_LABEL[s.ai === 'claude-code' ? 'claude' : s.ai] || s.ai);
  const slot = s => { if (!s || s.ai === '人' || !s.model) return ''; const ai=s.ai === 'claude-code' ? 'claude' : s.ai, f=launch.flagFor(ai,s.model), available=aiTools.catalog()[ai]?.models.some(m=>m.id===f); return lt`${label(s)}・${s.model}${f ? `（${f}）` : ''}${available ? '' : '（利用不可：最新の一覧にありません）'}`; };
  const mode = modelView.special();
  const specialPolicy = mode.enabled ? lt`【特殊モード（通常の役割分担より優先）】人が今回の依頼でAI・モデルを直接指定した場合と手動選択した依頼だけ、その指定を優先する。指定がなければ ${launch.AI_LABEL[mode.ai]} を使用し続ける（選択可能なモデル：${(d.models[launch.AI_KEY[mode.ai]] || []).join(' / ')}）。同じAI内のモデル・思考は作業に合わせてAIが選んでよい。別のAIへの切替は人の直接指定がある依頼だけに限る。その依頼が終われば、続きは特殊モードのAIへ戻る。以前の作業ファイルや引用・役割分担のモデル指定は今回の直接指定と見なさない。モデルは設定の選択可能な一覧から選ぶ。新しいCLIは裏で起動せず、モデル変更も同じ作業の委任APIを使う。選んだAIが上限なら待機し、別のAIへ自動交代しない。従量課金・認証変更はしない。` : '';
  const limitPolicy = mode.enabled ? lt('【利用上限の時】特殊モード中は別のAIへ自動交代せず、解除まで待機する。済んだ操作・委任は繰り返さない。') : d.switch.auto === true ? lt('【利用上限の時】Hubが契約CLIの正式上限または新鮮な100%を確認すると共通フラグを保持し、会話とターミナルで同じ作業を交代する。交代時の設定画面「役割分担」に保存した担当・モデル・思考に従う（mainの上限ではbackupへ、backupの上限ではmainへ）。画像生成も保存した交代先へ引き継ぐ。元AIの終了後に引き継ぐ。保持中は解除日時または手動解除まで交代先で開始。両側上限なら往復せず待機。AIは確認不要。本文や引用の「上限」で自分の担当を変えない・止まらない。既定のmainは変えない。済んだ部分と委任を繰り返さず残りを続ける。追加課金・API従量課金は使わない。') : lt('【利用上限の時】自動交代はオフ。自分で別のモデルへ切り替えない。');
  const list = d.roles.map(r => slot(r.main) ? `${roles.label ? roles.label(r.name) : require("./lib/locale").label(r.name)}＝${slot(r.main)}` : '').filter(Boolean).join('、');
  const modelRule = mode.enabled ? specialPolicy : lt`【モデルの決まり（人が決めた。他のファイルや前の指示より優先）】${list}。役割分担で Agy CLI が担当の役割と、人が手動選択した依頼に限り、Hub が確認した最新の候補（${aiTools.catalog().agy.models.map(m=>m.label+'（'+m.id+'）').join('、') || '利用可能なモデルなし'}）を使ってよい。既定の役割は変更しない。claude-opus-4-6 などの古いモデルは使わない。エージェント（紬・律など）に頼む時も、この決まりのモデルを指定すること。`;
  const credits = instructions.creditRule(d);
  const paidModelRule = credits ? modelRule.replace(lt('従量課金・認証変更はしない。'), lt('購入・自動チャージ・APIキー課金・認証変更は禁止。')) : modelRule;
  const paidPolicy = credits ? limitPolicy.replace(lt('追加課金・API従量課金は使わない。'), lt('購入・自動チャージ・APIキー課金は禁止。')) : limitPolicy;
  return `${paidModelRule}\n${paidPolicy}${credits ? '\n' + credits : ''}\n${instructions.WORKFLOW_RULE}\n${delegateRule(p, t)}\n\n${p.kind === 'freetalk' ? '自由対話の会話画面。新しい話題は人が［新しい話題］から作る。手順・完了・統合・取り込みの操作はありません。' : guidance(p, resultsGate.decorate(p,t,projects || store.listProjects()), { where, projects: projects || (t.kind === 'derived' && t.derivedFrom?.includes('/') && !t.derivedFrom.startsWith(p.id + '/') ? store.listProjects() : [p]), copy: inWork(p, t) && !copyMissing(p, t), copyMissing: copyMissing(p, t) })}`;
}

function taskPrompt(p, t, file, dir, where = 'chat', startup) {
  if (p.kind === 'freetalk') return [modelPolicy(p, t, where), freetalk.prompt(p, t)].join('\n\n');
  const issuesRule = lt`【問題点を短くまとめる決まり】PROJECT.md の issues を足す・変える時は、同じプロジェクトの .ai/issues-summary.json も更新する（他プロジェクトには書かない）。保存形式は {"items":[{"hash":"原文のsha256先頭16文字","title":"30字までの問題名","state":"未解決/確認待ち/判断待ち/解決済み/履歴のいずれか","next":"50字までの次の対応（無ければ空）","who":"人/AI/空のいずれか"}]}。原文は文字列ならそのまま、オブジェクトなら text。hash は Node の require('node:crypto').createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16) で計算する（text は原文そのもの。空白・改行を変えない）。問題名と次の対応に作業ID・commit・テスト件数を入れない。新しい状態の項目を足したら、同じ件の古い項目は「履歴」にする。確かめていない事は「確認待ち」にし、不具合・解決と断定しない。原文は消さない。`;
  const rel = dir && path.relative(workRoot(p), dir);
  const copy = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? lt`今いるフォルダ（${dir}）はこの作業専用の作業用コピー。ここだけで作業し、本体には触らないこと（取り込みは人が作業画面の［本体に取り込む］で行う）。`
    : dir ? lt`今いるフォルダ（${dir}）は本体。この作業は作業用コピーを使わず、ここで作業してよい（Hub が本体で作業すると決めた。作業ルールに「作業用コピーの中だけ」とあっても、この作業では本体に保存してよい。作業用コピーを作るよう人に頼まない）。` : '';
  const refs = p.folders.filter(f => /^参考/.test(f.label)).map(f => expandHome(f.path));
  let projects;
  const rels = p.related.map(r => {
    const byId = store.readProject(r);
    if (byId) return byId.dir;
    projects ||= store.listProjects();
    return projects.find(x => x.name === r)?.dir;
  }).filter(Boolean);
  const { family, sourceOf } = require('./lib/work-context');
  const all = projects ||= store.listProjects(), same = family(p, all);
  const source = sourceOf(p,t.derivedFrom,all);
  const sameRefs = same.filter(q=>q.id!==p.id).map(q=>q.dir);
  const context = lt`この作業は${t.kind === 'derived' ? lt('派生作業') : lt('本作業')}。${source ? '派生元の作業ファイル: ' + store.taskFile(source.project.id,source.task.id) + '。' : ''}${sameRefs.length ? '同じ大きなプロジェクト内の参照（読むだけ）: '+sameRefs.join(' / ')+'。' : ''}`;
  const look = refs.length || rels.length ? lt`参考にしてよい場所（読むだけ。書き換えない）: ${[...refs, ...rels].join(' / ')}。` : '';
  if (where !== 'terminal') {
    const resumeView=require('./lib/text-budget').summaryView(fs.readFileSync(file,'utf8')),resumeSummary=resumeView.text;
    const pastIndex=taskHistory.indexFile(p.id,t.id),past=pastIndex?lt`過去の会話の目次：台帳/${path.relative(p.dir,pastIndex).split(path.sep).join('/')}（全文を読まず、必要な話題だけ開く。根拠は保管先の原文の行番号で確認）\n`:'';
    const read = past+(resumeView.warning?resumeView.warning+'\n':'')+(resumeSummary?lt`最新の再開要約：\n${resumeSummary}\n読む：作業ファイルの最新の再開要約・手順・成果。昔の詳細と保管会話は必要箇所だけ。\n`:'')+lt`作業「${String(t.title).replace(/[\r\n]+/g, ' ')}」（作業ID ${t.id}）の続きを。読む：台帳/.ai/rules.md・台帳/PROJECT.md・台帳/.ai/tasks/${t.id}.md${resumeSummary?'の最新の再開要約・手順・成果（過去全文を読み直さない）':''}。区切りで更新、実施した手順だけ[x]（無ければ3〜5個）。workdir・state・questionは書き換えない（Hub管理）。`;
    return instructions.packet({ pdir: p.dir, project: p.id, task: t.id, roleData: executionRoles(), policy: modelPolicy(p, t, where, all), issues: issuesRule, port: PORT, contextRule: launch.CONTEXT_RULE, askRule: chat.ASK_RULE,
      common: [dir ? `cwd=${dir === p.dir ? '台帳' : '台帳/' + path.relative(p.dir, dir).split(path.sep).join('/')}。${rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? lt('専用の作業用コピー。ここだけで作業。本体には触らない（取り込みは人の［本体に取り込む］）。') : lt('本体。コピーは使わず、ここで作業してよい（Hub指定）。')}` : '', look, context, read,require('./lib/chat-continuation').prompt(p.dir,t.id,PORT)].filter(Boolean).join('\n') });
  }
  const resumeView=require('./lib/text-budget').summaryView(fs.readFileSync(file,'utf8'));
  return [resumeView.text&&lt`最新の再開要約：\n${resumeView.text}`,resumeView.warning,modelPolicy(p, t, where, all), where === 'terminal' ? TERMINAL_HANDOFF_NOTE + '\n' + (modelView.special().enabled ? lt('特殊モード中は別のAIへ自動交代せず、解除まで待機する。') : TERMINAL_LIMIT_NOTE) : '', where === 'terminal' && startup ? launch.startupInfo(startup.ai, startup.model, undefined, codexFastFor(p.id, t.id)) : '', launch.CONTEXT_RULE, copy, look, context, issuesRule,require('./lib/chat-continuation').prompt(p.dir,t.id,PORT), lt`作業「${String(t.title).replace(/[\r\n]+/g, ' ')}」（作業ID ${t.id}）の続きをしてください。${require('./lib/task-history').latest(fs.readFileSync(file,'utf8'))?'作業ファイルは先頭の最新の再開要約・手順・成果から再開し、旧全文や保管会話は必要箇所だけ参照する。':''}まず次の3つを読むこと: ${path.join(p.dir, '.ai', 'rules.md')} / ${path.join(p.dir, 'PROJECT.md')} / ${file}。区切りごとに作業ファイルを更新し、「## 手順」の終わった所を [x] にすること（手順が無ければ3〜5個書く）。作業ファイルの先頭の workdir・state・question の行は Hub が管理する：書き換えない（特に、取り込み済みの後に古い内容で書き戻さない）。`].filter(Boolean).join('\n\n');
}

// 会話整理では作業用の更新・委任指示を付けず、読む台帳とJSON選別の依頼だけを渡す。
function selectionPrompt(p){return `台帳=${p.dir}。`;}

function codexFastFor(project, task) {
  const p = store.readProject(project);
  return Boolean(p && acceleration.settings().codexAllowed && chat.readMeta(p.dir, task).codexFast === true);
}
function accountFor(project, task, ai) {
  const p = store.readProject(project);
  const id = p ? chat.readMeta(p.dir, task).accounts?.[ai] || 'default' : 'default';
  accounts.get(ai, id); return id;
}
function requestAccount(p, task, ai, supplied) {
  const id = supplied ?? accountFor(p.id, task, ai); accounts.available(ai, id, { forWork: true }); return id;
}
function accountBusy(ai, id) {
  if (usage?.inflight?.has(usage.key(ai, id)) || usage?.resetBusy?.has(usage.key(ai, id))) return true;
  if (id === 'default' && aiTools.isOperating()) return true;
  if (sessions.list().some(s => s.running && s.ai === ai && (s.account || 'default') === id)) return true;
  if ([...chats.running.values()].some(r => r.ai === ai && (r.account || 'default') === id)) return true;
  for (const p of store.listProjects()) for (const t of p.tasks) {
    if (chats.queue(p.id, t.id).some(q => (q?.ai === ai && (q.account || 'default') === id) || (ai === 'claude' && q?.limitSwitch && (q.limitSwitch.sourceAccount || 'default') === id))) return true;
  }
  // 外部Terminal等のAIはアカウントを特定できないので、該当AIの認証変更を保留する。
  return procwatch.list().some(r => r.ai === ai || r.ai === launch.AI_KEY[ai]);
}
function usageSelection(url, b = {}) {
  const project = b.project || url.searchParams.get('project'), task = b.task || url.searchParams.get('task');
  if (!task) return {};
  const p = store.readProject(project); if (!p || !store.taskFile(project, task)) throw Error(lt('作業が見つかりません'));
  return Object.fromEntries(['claude', 'codex'].map(ai => {
    const id = b[ai + 'Account'] ?? url.searchParams.get(ai + 'Account') ?? accountFor(project, task, ai);
    accounts.get(ai, id); return [ai, id];
  }));
}
function usageWithLimit(snapshot) {
  // 表示も開始前の共通判定から作る。旧fable-limit.jsonは読まず変更もしない。
  const account = snapshot.selection?.claude || snapshot.providers?.claude?.account || 'default';
  const state = limitRoutingEnabled() && limitEvidence.active(account);
  return { ...snapshot, creditException:limitEvidence.creditException(), limits: limitRoutingEnabled() ? limitEvidence.list(snapshot.selection || {}) : [], fableLimit: state ? { model: 'claude-fable-5-1', account, at: state.at, until: state.validUntil, untilSource: state.untilSource, hold: true } : null };
}

const { FreetalkHistory } = require('./lib/freetalk-history');
const freetalkHistory = new FreetalkHistory(freetalk, task => {
  if (webchatActive('freetalk',task) || chats.busy('freetalk',task) || sessions.list().some(x=>x.running && x.project==='freetalk' && x.task===task)) return lt('AIが作業中です。返事が終わってから整理してください');
  if (chats.queue('freetalk',task).length) return lt('順番待ちがあります。終了または取り消し後に整理してください');
  // Restarted Hub supervisors and their descendants belong to the guarded
  // topic above; shared-cwd guesses must not block every other topic.
  if (procwatch.list().some(x=>x.project==='freetalk' && !chats.supervisedPid(x.pid) && !procwatch.hasAncestor(x.pid,pid=>chats.supervisedPid(pid,{activeOnly:true})))) return lt('freetalkでAIが作業中です。終了後に整理してください');
  return '';
});
const freetalkAttachments = new (require('./lib/freetalk-attachments').FreetalkAttachments)(freetalk);
const taskHistory = new (require('./lib/task-history').TaskHistory)({store,
  busy:(project,task,{history=true}={})=>{
    if(discussion?.active(project,task))return {code:'target-ai',message:'話し合いが進行中です。停止または完了後に整理してください'};
    const all=store.listProjects(),own=all.find(p=>p.id===project)?.tasks.find(t=>t.id===task),wd=own?.workdir&&path.resolve(expandHome(own.workdir));
    const shared=wd&&all.some(p=>p.tasks.some(t=>!(p.id===project&&t.id===task)&&t.workdir&&path.resolve(expandHome(t.workdir))===wd));
    const external=procwatch.list().some(x=>x.project===project&&(x.task===task||!x.task&&wd&&!shared&&x.cwd&&path.resolve(x.cwd)===wd));
    if(webchat?.busy().some(j=>j.project===project&&j.task===task)||chats.busy(project,task)||chats.queue(project,task).length||sessions.list().some(x=>x.running&&x.project===project&&x.task===task)||external)return {code:'target-ai',message:lt('この作業のAIが作業中です。作業が終わってから、もう一度［要約して続ける］を押してください')};
    const blocker=historyBlockers(project)[0];if(blocker)return {code:blocker.kind,message:blocker.message};
    if(history&&textBudget.pending(project).some(x=>x.j.task===task))return lt('本文整理の復旧が必要です');
    if(!history&&shared)return lt('他の作業も同じ作業場所を使っています');
    const integration=history?taskIntegrate.historyBlocker(project,task):taskIntegrate.pending().some(r=>r.project===project&&r.task===task)&&lt('統合・引渡しの続きが残っています');
    if(integration)return integration;
    if(taskTransfer.pending().some(r=>(r.project===project&&r.task===task)||(r.targetProject===project&&r.targetTask===task)))return lt('引渡しの続きが残っています。成果の引渡し・受領を完了してから、もう一度［要約して続ける］を押してください');
    const h=taskTransfer.read(project,task);if(h&&!h.complete&&h.receiving)return lt('受領の続きが残っています');
    return '';
  },reset:(project,task,generation)=>{chats.base.delete(chats.key(project,task));chats.queues.delete(chats.key(project,task));for(const ai of launch.AIS){const key=sessions.key(project,task,ai);if(sessions.get(project,task,ai)?.exited)sessions.map.delete(key);}chats.emit(project,task,{type:'reset',generation});}
});
conversationHistory=taskHistory;
const historyProjects = project => require('./lib/resource-scope').relatedProjects(project, store.listProjects(), baseOf, expandHome, __dirname, {hubGlobal:false});
function historyBlockers(project,{body=false}={}){
  const all=store.listProjects(),ids=historyProjects(project);
  return [...updateBlockers().filter(x=>{
    if(x.kind==='cli')return false;
    if(!x.project||ids===null||!all.some(p=>p.id===x.project))return true;
    return ids.has(x.project)&&(body||['maintenance','github','resolution'].includes(x.kind));
  }),...(appUpdate.applying()?[{kind:'update',message:lt('Hubの更新が進行中です')}]:[]),
    ...(restartControl?.committed?[{kind:'restart',message:lt('再起動を開始しています')}]:[])];
}
const textBudget=new (require('./lib/text-budget').TextBudget)({store,busy:(project,task)=>{
  const ids=historyProjects(project),related=r=>!r?.project||ids===null||ids.has(r.project)||r.items?.some(i=>ids.has(i.project));
  const pending=taskIntegrate.pending();
  if(historyBlockers(project,{body:true}).length||taskIntegrate.active&&related(taskIntegrate.active)||integrateAuto.active&&(!pending.length||pending.some(related))||taskHistory.activeWrites.size||freetalkHistory.activeWrites?.size)return lt('AI・整理・確認が動いています');
  if(taskHistory.organizing(project,task))return lt('会話を整理中です');
  // Shared PROJECT and INDEX are protected against all task integrations/receipts.
  if(pending.some(related)||taskTransfer.pending().some(r=>related(r)||related({project:r.targetProject})))return lt('統合・引渡しの続きが残っています');
  const reason=taskHistory.busy(project,task,{history:false});return reason?.message||reason;
}});
gpt.textBudget=textBudget;
// ［要約して新しい会話へ］の自動整理。段階は台帳外の記録に残し、再起動後もここから続ける。
const LONG_CHAT=120000,autoRunning=new Set();
function autoView(project,task,job){
  const state=taskHistory.state(project,task),auto=job||state.auto||null,p=store.readProject(project);let chars=0,compacted=false;
  if(p&&p.kind!=='freetalk'){for(const r of chat.read(p.dir,task))if((r.role==='user'||r.role==='assistant')&&r.text)chars+=Array.from(r.text).length;compacted=Boolean(chat.readMeta(p.dir,task).compacted);}
  const running=auto?.stage==='selecting'&&chats.busy(project,task),queued=auto?.stage==='selecting'&&!running&&chats.queue(project,task).find(q=>q.selectionOnly&&taskHistory.selectionQueueState(project,task,q));
  return {generation:state.generation,auto:auto&&{...auto,...(queued?{ai:queued.ai,model:queued.model,waiting:queued.limitWaiting?'limit':'start'}:{}),...(running?{ai:running.ai,model:running.model}:{}),reply:undefined},long:chars>LONG_CHAT||compacted,chars,compacted};
}
async function autoTick(project,task){
  if(stopControl.held({project,task}))return;
  if(historyBlockers(project).length)return;
  const key=project+'\0'+task;if(autoRunning.has(key))return;autoRunning.add(key);
  try{await autoStep(project,task);}catch(e){/* 理由は整理の記録に残す */}
  finally{autoRunning.delete(key);try{chats.emit(project,task,{type:'history-auto',...autoView(project,task)});}catch(e){/* 次の確認で表示 */}}
}
async function autoStep(project,task){
  if(stopControl.held({project,task}))return;
  const a=taskHistory.autoJob(project,task);if(!a||['done','failed','cancelled'].includes(a.stage))return;
  const p=store.readProject(project),file=p&&store.taskFile(project,task);if(!file)return taskHistory.setAuto(project,task,{stage:'failed',error:lt('通常の作業が見つかりません')});
  if(a.stage==='reserved'||a.stage==='collecting'){
    let reason='';try{if(chats.busy(project,task)||chats.queue(project,task).length)throw Error(lt('AIの返事が終わったら自動で整理します'));taskHistory.idle(project,task);reason=delegateTerminalError(project,task)||'';}catch(e){reason=e.message;}
    if(reason){if(a.reason!==reason||a.stage!=='reserved')taskHistory.setAuto(project,task,{stage:'reserved',reason});return;}
    const t=store.readTask(file),role=rolesData().roles.find(r=>r.name==='文章');
    if(role?.main.model&&t.state!=='完了'&&!t.completionPending){
      const target={project,task,role:role.name,ai:role.main.ai==='claude-code'?'claude':role.main.ai,model:role.main.model};target.account=accountFor(project,task,target.ai);
      const held=limitRoutingEnabled()&&limitEvidence.forRequest(target),backup=held&&limitBackup(target);
      if(held&&(!backup||limitEvidence.forRequest(backup))){taskHistory.setAuto(project,task,{stage:'reserved',reason:lt('両方の担当が上限中です。解除後に再開してください')});return;}
      if(aiTools.isOperating(target.ai)||backup&&aiTools.isOperating(backup.ai)){taskHistory.setAuto(project,task,{stage:'reserved',reason:lt('AI の更新・モデル再取得が進行中です')});return;}
    }
    let plan;try{plan=taskHistory.autoCollect(project,task);}catch(e){return taskHistory.setAutoSafe(project,task,{stage:'failed',error:e.message});}
    const {prompt,...inputPlan}=plan;
    // 完了済みの作業はAIを起動せず（状態を変えない）、代替要約で会話だけ切り替える。
    if(t.state==='完了'||t.completionPending||!role?.main.model){taskHistory.setAuto(project,task,{stage:'selecting',...inputPlan,reason:'',delegated:false});return taskHistory.autoFinish(project,task,{});}
    taskHistory.setAuto(project,task,{stage:'selecting',...inputPlan,reason:'',delegated:true,selectionRequest:a.id,ai:role.main.ai==='claude-code'?'claude':role.main.ai,model:role.main.model});
    const captured={writeHead(code){this.statusCode=code;},end(body){this.body=body;}};
    await delegateRequest({project,task,text:prompt,title:lt('会話の自動整理'),role:role.name,ai:role.main.ai==='claude-code'?'claude':role.main.ai,model:role.main.model,effort:role.main.effort},captured,{preserveTaskState:true,selectionOnly:true,requestKey:a.id,beforeStart:()=>{
      if(taskHistory.autoJob(project,task)?.id!==a.id||taskHistory.autoJob(project,task)?.stage!=='selecting')throw Error(lt('整理の予約を取り消しました'));
      taskHistory.idle(project,task);
    }});
    if(captured.statusCode!==200){
      if(taskHistory.autoJob(project,task)?.stage==='cancelled')return;
      const error=String(JSON.parse(captured.body||'{}').error||'');
      if(/上限中|待機/.test(error)||error===lt('AI の更新・モデル再取得が進行中です')){taskHistory.setAuto(project,task,{stage:'reserved',delegated:false,reason:error});return;}
      taskHistory.setAuto(project,task,{delegated:false,error});return taskHistory.autoFinish(project,task,{});
    }
    return;
  }
  if(a.stage==='selecting'){
    if(chats.busy(project,task)||delegateTerminalError(project,task))return;
    const queue=chats.queue(project,task);
    if(queue.length){
      const item=queue[0];
      if(queue.length!==1)return;
      const state=taskHistory.selectionQueueState(project,task,item);
      if(!state)return; // Never consume or retry another task's queued instruction.
      if(state.started){
        // A saved user turn is an attempted launch. After a crash, consume its
        // saved result (or use fallback) instead of sending that request again.
        if(state.error)return taskHistory.setAuto(project,task,{stage:'failed',error:state.error});
        chats.unqueue(project,task,item.id,true);
        taskHistory.setAuto(project,task,{selectionResume:null});
      }else{
        const resume=a.selectionResume?.request===item.id&&['starting','waiting'].includes(a.selectionResume.state);
        if(!item.limitWaiting&&!resume&&item.error)return taskHistory.setAuto(project,task,{stage:'failed',error:item.error});
        if(!limitRoutingEnabled()||limitEvidence.forRequest(item))return;
        if(aiTools.isOperating(item.ai))return;
        // Persist intent before altering the queue. Both writes may be interrupted;
        // the accepted request's user row decides whether it can still be launched.
        taskHistory.setAuto(project,task,{selectionResume:{request:item.id,state:'starting'}});
        try{
          const t=store.readTask(file),dir=item.selectionOnly?p.dir:startDir(p,t).dir;
          chats.setQueue(project,task,[{...item,limitWaiting:false}],true);
          const r=await chats.sendQueued({...item,project,task,pdir:p.dir,dir,request:item.id,perm:permCmd(item.ai),
            basePrompt:item.selectionOnly?selectionPrompt(p):taskPrompt(p,t,file,dir),policy:item.selectionOnly?selectionPrompt(p):modelPolicy(p,t),onEnd:()=>chatEnded(project,task)});
          if(!(await r.started))throw Error(lt('AIを起動できませんでした。CLIの導入状態を確認してください'));
          chats.unqueue(project,task,item.id,true);
          taskHistory.setAuto(project,task,{selectionResume:null});
        }catch(e){
          // Startup rechecks after asynchronous limit retrieval can meet a CLI
          // operation that began after the first guard. Keep the accepted item.
          if(e.message===lt('AI の更新・モデル再取得が進行中です')){
            taskHistory.setAuto(project,task,{selectionResume:{request:item.id,state:'waiting'}});
            chats.setQueue(project,task,chats.queue(project,task).map(q=>q.id===item.id?item:q),true);return;
          }
          const sw=item.limitSwitch,limitWaiting=Boolean(limitEvidence.forRequest(item)&&limitEvidence.forRequest({ai:sw.sourceAI,model:sw.sourceModel,account:sw.sourceAccount}));
          // Persist the terminal failure first: a crash between these writes must
          // not turn an ordinary launch failure into an automatic retry.
          taskHistory.setAuto(project,task,limitWaiting?{selectionResume:{request:item.id,state:'waiting'}}:
            {stage:'failed',error:e.message,selectionResume:{request:item.id,state:'failed'}});
          chats.setQueue(project,task,chats.queue(project,task).map(q=>q.id===item.id?{...q,error:e.message,limitWaiting}:q),true);
        }
        return;
      }
    }
    // 返事が無い（停止・再起動）時も委任し直さず、代替要約で続ける。
    const reply=taskHistory.selectionReply(project,task);
    return taskHistory.autoFinish(project,task,reply?{reply:reply.text,source:'ai',model:reply.model||a.model||'',replyReceivedAt:reply.at}:{});
  }
  if(a.stage==='writing')return taskHistory.autoFinish(project,task,{});
}
const autoTimer=setInterval(()=>{try{const autos=taskHistory.activeAutos();if(!autos.length||restartControl?.committed||appUpdate.applying()||appShell.rebuilding)return;for(const a of autos)if(!historyBlockers(a.project).length)autoTick(a.project,a.task);}catch(e){/* 次の周期で再確認 */}},1500);autoTimer.unref();
// Context rotation uses the same job as the button; no separate clearing path.
const rotateTimer=setInterval(()=>{
  try{if(restartControl?.committed||appUpdate.applying())return;for(const p of store.listProjects()){
    if(p.kind==='freetalk')continue;
    for(const t of p.tasks){if(t.state==='完了'||t.completionPending)continue;const view=autoView(p.id,t.id);
      if(view.long){const a=taskHistory.autoReserveLong(p.id,t.id,{chars:view.chars,compacted:view.compacted});if(a&&!['cancelled','failed'].includes(a.stage))autoTick(p.id,t.id);}
    }
  }}catch(e){/* Individual jobs keep their own durable progress. */}
},15000);rotateTimer.unref();
const bodyNotices=new Map();
function bodyNoticeState(){
  const notices=new Map(bodyNotices);
  try{for(const p of store.listProjects()){if(p.kind==='freetalk')continue;for(const task of textBudget.state(p.id).tasks){const warnings=textBudget.summaryWarnings(p.id,task);if(warnings.length){const key=p.id+' / '+task;notices.set(key,[notices.get(key),...warnings].filter(Boolean).join(' '));}}}}catch(e){notices.set('本文整理',e.message);}
  return [...notices].map(([scope,message])=>({scope,message}));
}
const bodyTimer=setInterval(()=>{
  textBudget.maintainEnabled(() => updateBusy() || appUpdate.applying(), (scope, warnings) => {
    if(warnings.length)bodyNotices.set(scope,warnings.join(' '));else bodyNotices.delete(scope);
  });
},15000);bodyTimer.unref();
const { FreetalkLifecycle } = require('./lib/freetalk-lifecycle');
const freetalkLifecycle = new FreetalkLifecycle(freetalkHistory, () => {
  if ([...chats.running.keys()].some(k=>k.startsWith('freetalk\u0000')) || sessions.list().some(x=>x.running && x.project==='freetalk') || procwatch.list().some(x=>x.project==='freetalk')) return lt('AIが作業中です。終了後に掃除します');
  if([...chats.queues.entries()].some(([k,q])=>k.startsWith('freetalk\u0000') && q.length))return lt('順番待ちがあります。終了後に掃除します');
  for (const t of store.readProject('freetalk')?.tasks || []) {
    if(chats.busy('freetalk',t.id))return lt('AIが作業中です。終了後に掃除します');
    if(chats.queue('freetalk',t.id).length)return lt('順番待ちがあります。終了後に掃除します');
  }
  return '';
}, () => new Date(), path.join(__dirname,'../docs/project-hub/templates/project'));
const freetalkAutomaticStarting=new Set();
async function startAutomaticFreetalk(task) {
  const saved=freetalkHistory.state(task);
  if(saved.migrated) {
    if(!saved.migrated.cleanupPending)return {ok:true,...saved.migrated,repeated:true};
    // Retry deletion only: neither re-summarize nor create a second project.
    freetalkHistory.save(task,{...saved,migrated:{...saved.migrated,cleanupError:undefined}});
    return {ok:true,automatic:true,pending:true};
  }
  if(saved.summary?.intent==='promote' && saved.summary.automatic) {
    if(saved.summary.automatic.uncertain)throw Error(saved.summary.automatic.error);
    if(!saved.summary.automatic.error)return {ok:true,automatic:true,pending:true};
  }
  // Reuse a successful current summary; retries do not repeat completed AI work.
  if(saved.summary) {
    const h=freetalkHistory.status(task);
    if(h.draft && !h.stale) {
      freetalkHistory.idle(task);
      freetalkHistory.save(task,{...saved,summary:{...saved.summary,intent:'promote',automatic:{phase:'create'}}});
      return {ok:true,automatic:true,pending:true};
    }
  }
  const request=freetalkHistory.prepareSummary(task,{intent:'promote',automatic:true});
  const summaryId=freetalkHistory.state(task).summary.id;
  freetalkAutomaticStarting.add(task);
  let code=500,body={error:lt('要約の開始結果を確認できませんでした')};
  const response={writeHead:c=>{code=c;},end:value=>{body=JSON.parse(String(value));}};
  try {
    await delegateRequest({...request,project:'freetalk',task,title:lt('話題の整理用の要約')},response,{requestKey:summaryId,beforeStart:()=>freetalkHistory.idle(task)});
    const state=freetalkHistory.state(task);
    if(state.summary?.id===summaryId && state.summary.intent==='promote') {
      freetalkHistory.save(task,{...state,summary:{...state.summary,automatic:{phase:'summary',...(code!==200 || !body.ok?{error:body.error || lt('要約を開始できませんでした')}:{})}}});
    }
    if(code!==200 || !body.ok)throw Error(body.error || lt('要約を開始できませんでした'));
    return {...body,automatic:true,pending:true};
  }catch(e){freetalkLifecycle.automaticError(task,e.message);throw e;}
  finally{freetalkAutomaticStarting.delete(task);}
}
function finishAutomaticFreetalk() {
  if(restartControl?.committed || appUpdate.applying())return;
  let tasks;try{tasks=freetalkLifecycle.automaticTasks();}catch(e){freetalkLifecycle.error=e.message;return;}
  for(const task of tasks) {
    try {
      const state=freetalkHistory.state(task);
      if(freetalkAutomaticStarting.has(task) || (state.migrated?!state.migrated.cleanupPending || state.migrated.cleanupError:state.summary?.intent!=='promote' || !state.summary.automatic || state.summary.automatic.error))continue;
      const result=freetalkLifecycle.completeAutomatic(task);
      if(result?.ok){chats.base.delete(chats.key('freetalk',task));chats.queues.delete(chats.key('freetalk',task));chats.emit('freetalk',task,{type:'reset'});setUnread('freetalk',task,false);setUnread(result.project,result.task,true);}
    }catch(e){try{freetalkLifecycle.automaticError(task,e.message);}catch{/* leave saved intent available for inspection */}}
  }
}
const freetalkAutomaticTimer=setInterval(finishAutomaticFreetalk,1000);freetalkAutomaticTimer.unref();
function cleanFreetalkMemory() {
  for(const key of [...chats.base.keys()])if(key.startsWith('freetalk\u0000'))chats.base.delete(key);
  for(const key of [...chats.queues.keys()])if(key.startsWith('freetalk\u0000'))chats.queues.delete(key);
  for(const key of [...unread])if(key.startsWith('freetalk\u0000'))setUnread('freetalk',key.split('\u0000')[1],false);
}
function freetalkStatus() {
  const result=freetalk.status(); if(!result.ready)return result;
  try{return {...result,cleanup:freetalkLifecycle.status()};}catch(e){return {...result,cleanup:{reason:e.message}};}
}
const freetalkSweep=setInterval(()=>{
  if(restartControl?.committed)return;
  try {
    if(freetalkLifecycle.automaticTasks().some(task=>{const s=freetalkHistory.state(task);return s.migrated?.cleanupPending || (!s.migrated && s.summary?.intent==='promote' && s.summary.automatic);} ))return;
    const result=freetalkLifecycle.tick();if(result?.ok)cleanFreetalkMemory();
  }catch(e){freetalkLifecycle.error=e.message;}
},60000);
freetalkSweep.unref();
const restartBlockers = (handoffErrors) => {
  const out=updateBlockers().filter(x=>x.kind!=='queue'&&!(x.kind==='chat'&&chats.handoffSafe(x.project,x.task))&&!(x.kind==='background'&&chats.supervisedPid(x.pid)));
  const add=(kind,message)=>out.push({kind,message:lt(message)});
  for(const e of handoffErrors ?? chats.handoffErrors())out.push({kind:'chat-handoff',project:e.project,task:e.task,stage:e.stage,run:e.run,message:lt('会話の終了保存が未解決です。自動では再処理しません')});
  if(webchat?.control)add('webchat-control','Chat／Proの操作が進行中です');
  if(taskIntegrate.active || integrateAuto.active)add('integration','統合の処理が進行中です');
  if([...executionGate.leases.values()].some(l=>l.kind==='verification'))add('verification','開発場所の検証と子プロセスの終了確認が進行中です');
  if(terminalLimits.busy || sessions.list().some(x=>{const s=sessions.get(x.project,x.task,x.ai);return s?.limitTransition&&!s.limitTransitionDone;}))add('limit-transition','上限による交代の準備中です');
  if(activeRequests || taskHistory.activeWrites.size || freetalkHistory.activeWrites?.size)add('write','保存・送信が進行中です');
  if(appUpdate.running || ['installing','publishing'].includes(appUpdate.data.phase))add('update','Hubの更新が進行中です');
  if(problemResolution.starting.size)add('resolution','問題の整理が進行中です');
  return out;
};
restartControl = new (require('./lib/restart-control').RestartControl)({
  blockers:restartBlockers,
  verify:()=>{mainMergeFlow?.verifyRestart();for(const p of store.listProjects())for(const t of p.tasks)chats.queue(p.id,t.id);chats.verifyQueues();},
  execute:()=>{
    record('restart', {}, {from:VERSION,to:readVersion()});
    if(DRY)return;
    setTimeout(()=>{
      try{emergencyRestart?.verifyCommitted();mainMergeFlow?.verifyRestart();chats.detachForRestart();stopControl.cleanExit();}catch(e){restartControl.committed=false;restartControl.error=e.message;emergencyRestart?.fail(e.message);record('restart-handoff-error',{}, {error:e.message});return;}
      server.close();
      const nextHub=appUpdate.restartNeeded ? appUpdate.nextHub() : __dirname;
      const child=require('node:child_process').spawn(process.execPath,[path.join(nextHub,'server.js')],{cwd:nextHub,env:{...process.env,HUB_UPDATE_SOURCE:appUpdate.source,HUB_UPDATE_CONFIRM:appUpdate.data.pendingConfirm?.token || '',HUB_RESTART_WAIT:'1'},detached:true,stdio:['ignore','inherit','inherit']});
      child.unref();process.exit(0);
    },200);
  }
});
mainMergeFlow=new (require('./lib/main-merge-flow').MainMergeFlow)({ledger:mainMergeDelivery,git:gitw,restart:()=>restartControl,
  runtime:()=>({instance:HUB_INSTANCE,version:VERSION,bootHead:BOOT_HEAD,targetDir:path.resolve(__dirname,'..'),updatePending:appUpdate.restartNeeded}),
  keep:r=>{const p=store.readProject(r.project),t=p?.tasks.find(t=>t.id===r.task);if(!t||expandHome(t.workdir)!==r.sourceDir)throw Error('保持する作業が変わりました。取り込みは送り直しません。');if(!t.continuation)store.updateTask(p.id,t.id,{continuation:true,memo:lt`本体に取り込み、同じ作業とコピーを保持しました（${r.targetDir}）`});}
});
const mainMergeFlowTimer=setInterval(()=>mainMergeFlow.tick(),500);mainMergeFlowTimer.unref();
const restartTimer=setInterval(()=>{emergencyRestart?.tick();restartControl.tick();},500);restartTimer.unref();
// 会話の引継ぎと、親の統合画面からの衝突解消依頼は同じ起動・排他・モデル指定を使う。
function integrationReviewPrompt(p,t){
  return modelPolicy(p,t).split('\n\n')[0]+'\n'+`統合差分の独立確認です。実装担当の会話とCLIセッションは引き継いでいません。依頼にある保存差分・試験原物から判定してください。親作業の再開要約・会話本文・成果の判定文を確認の代わりに使わないでください。読むだけ。ファイル・作業記録の編集、試験の再実行、委任、受領、本体取り込み、起動は行わず、判定だけをこの会話へ返してください。台帳：${p.dir}。`;
}
function isolatedReviewDir(p,t){
  const dir=expandHome(t.workdir)||baseOf(p);
  if(!dir||!fs.existsSync(dir))throw Error(lt('作業場所を用意できませんでした'));
  return dir;
}
function verifyIntegrationReviewSend(o) {
  verifyIntegrationAssignmentSend(o);
  if(discussionRuntime.isRequest(o.request)){discussion.verify(o);return;}
  if(roleReviewRuntime.isRequest(o.request)){roleReview.verify(o);return;}
  const queued=o.mode==='queued'||o.mode==='amend',q=queued?chats.queue(o.project,o.task).find(q=>q.id===o.request):null;
  const original=x=>x?.limitSwitch?.original||x?.shown||x?.text;
  const markers=[...String(o.limitSwitch?.original||o.text||'').matchAll(/\[integration-auto:([a-f0-9]{64}):(code|review|organize|order)\]/g)];
  const r=taskIntegrate.read(o.project,o.task);
  // Classification comes from the durable delivery and actual queue, never
  // from an isolation flag. Keep the queue id at acceptance so a replacement
  // that removes every request/marker still cannot become an ordinary chat.
  const refs=[o.request,o.integrationReviewRequest,o.limitSwitch?.sourceRequest,q?.id,q?.request,q?.integrationReviewRequest,q?.limitSwitch?.sourceRequest].filter(Boolean);
  const owns=a=>refs.some(id=>id===a.delivery?.request||id===a.delivery?.queueId||id==='limit-'+a.delivery?.request||a.delivery?.queueId&&id==='limit-'+a.delivery.queueId);
  const bound=Object.entries(r?.auto?.attempts||{}).filter(([,a])=>(a.phase==='review'||a.request?.review)&&owns(a));
  const queueReview=/\[integration-auto:[a-f0-9]{64}:review\]/.test(String(original(q)||''));
  if(!markers.some(m=>m[2]==='review')&&!o.integrationReviewRequest&&!q?.integrationReviewRequest&&!queueReview&&!bound.length)return;
  const a=markers.length===1&&markers[0][2]==='review'&&r?.auto?.attempts[markers[0][1]];
  if(!a||bound.some(([k])=>k!==markers[0][1])||r.auto.stopped||a.phase!=='review'||!o.integrationReviewRequest||a.delivery?.request!==o.integrationReviewRequest||!['intent','accepted'].includes(a.delivery.state))throw Error('Saved result review request changed');
  if(o.isolatedReview!==true||o.readOnly!==true)throw Error('Saved result review isolation changed');
  if(queued){
    if(q?.isolatedReview!==true||q.readOnly!==true||q.integrationReviewRequest!==o.integrationReviewRequest||original(q)!==original(o))throw Error('Saved result review queue changed');
    if(a.delivery.queueId&&q.id!==a.delivery.queueId&&q.id!=='limit-'+a.delivery.queueId&&q.id!=='limit-'+a.delivery.request)throw Error('Saved result review queue changed');
  }
  if(!a.savedResults)return;
  // Callbacks cannot survive a saved queue or a limit successor. Bind the
  // request to its durable attempt, then read the current material again.
  if(a.request?.review?.key!==markers[0][1]||JSON.stringify(a.request.review.savedResults)!==JSON.stringify(a.savedResults))throw Error('Saved result review request changed');
  // ChatRunner has already checked exclusive startup ownership. Its own
  // persisted queue is expected here; all scope/content checks still apply.
  taskIntegrate.simple.validate(r,{allowBusy:true});
  const head=require('./lib/integration-safety').target(taskIntegrate,{target:r.target,p:store.readProject(r.project)});
  if(!head||head.status||head.head!==a.reviewHead||gitw.merging(r.target))throw Error('Integration review range changed');
  integrateAuto.verifySavedReview(r,a);
}
async function delegateRequest(b,res,{beforeStart,allowCompleted=false,resultsRecovery,resultsOrganize=false,preserveTaskState=false,isolatedReview=false,selectionOnly=false,review,requestKey,integrationAssignment,automation}={}) {
    try { void license.prepare(); licenseGuard({ ...b, origin: 'delegate' }, 'accept'); }
    catch (e) { return send(res, e.status || 403, { error: e.message, code: e.code, delivery: 'not-sent' }); }
    if(b.automation&&!automation)return send(res,403,{error:'台帳の実行は保存されたHubの依頼だけを受け付けます'});
    if(b.integrationAssignment&&!integrationAssignment)return send(res,409,{error:'統合の担当指定は正式な統合開始からだけ受け付けます'});
    const p = store.readProject(b.project);
    const file = p && store.taskFile(b.project, b.task);
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    let ai = b.ai === 'claude-code' ? 'claude' : b.ai;
    if (!p || !file || !launch.AIS.includes(ai)) return send(res, 400, { error: lt('project・task・ai（codex / claude / agy / grok）を確かめてください') });
    if(discussion.active(p.id,b.task))return send(res,409,{error:'話し合いが進行中です。停止または完了後に渡してください'});
    if (!text || text.length > 8000) return send(res, 400, { error: lt('text は1〜8000文字') });
    if (aiTools.isOperating(ai)) return send(res, 409, { error: lt('AI の更新・モデル再取得が進行中です') });
    const t = store.readTask(file);
    const sizeNote = text.length > 1500 ? lt(' Hub が付ける内容を除き、差分だけにすると短くなります') : '';
    const title = String(b.title || text.split('\n')[0]).trim().slice(0, 60) || lt('渡した作業');
    if (t.state === '完了' && !allowCompleted) return send(res, 409, { error: DELEGATE_COMPLETED_ERROR });
    // 委任先の役割は元の担当と異なることがある。親の role/model や CLI の既定へは戻さない。
    const automatic = !b.model && specialMode.pick(modelView.special(), rolesData(), b.role || t.role);
    if (automatic) ai = automatic.ai;
    const role = b.role && rolesData().roles.find(r => r.name === b.role);
    if (!integrationAssignment && b.role && (!role || (!modelView.special().enabled && !automatic && role.main.ai !== launch.AI_KEY[ai]))) return send(res, 400, { error: lt('role は指定した AI が主担当の役割を選んでください') });
    const model = launch.modelLabel(ai, typeof b.model === 'string' && b.model.trim() ? b.model.trim() : automatic?.model || role?.main.model || '');
    if (!model) return send(res, 400, { error: lt('model 又は role を明示してください。例：チェックは ai: claude・model: claude-fable-5-1、書込は ai: codex・model: gpt-6.1-sol。作業は増やしていません') });
    const invalid = modelError(ai, model);
    if (invalid) return send(res, 409, { error: invalid });
    if (!launch.flagFor(ai, model)) return send(res, 409, { error: lt('委任には CLI に渡すモデル名が必要です。指定なしでは起動しません') });
    const terminalError = delegateTerminalError(p.id, t.id);
    if (terminalError) return send(res, 409, { error: terminalError });
    const sourceTurn = chats.busy(p.id, t.id)?.userRow?.turn || null;
    const busy = Boolean(chats.busy(p.id, t.id) || webchatActive(p.id, t.id));
    let dir;
    try { if(automation){dir=ideaDispatch.location(p.id,ideas.read(p.id).runs[automation.runId]).dir;assertWorkspaceIdle(p,t,busy);}else if(isolatedReview){assertWorkspaceIdle(p,t,busy);dir=isolatedReviewDir(p,t);}else if(!beforeStart && !webchatActive(p.id,t.id))({ dir } = startDir(p, t, busy)); } catch (e) { return send(res, 409, { error: String(e.message || e) }); }
    if (ai === 'grok' && b.effort === 'Ultra') return send(res, 400, { error: lt('Grok の思考は 中・高・極高・MAX です') });
    const effort = integrationAssignment ? b.effort : ai === 'agy' ? '高' : roles.EFFORTS.includes(b.effort) ? b.effort : automatic?.effort || role?.main.effort || '';
    const verifyReviewResults=()=>{
      if(!review?.savedResults)return;
      const r=taskIntegrate.read(p.id,t.id),a=r?.auto?.attempts[review.key],i=r?.items.find(i=>i.project===review.savedResults.project&&i.task===review.savedResults.task);
      if(!a||a.phase!=='review'||a.delivery?.request!==requestKey||JSON.stringify(a.savedResults)!==JSON.stringify(review.savedResults))throw Error('Saved result review request changed');
      taskIntegrate.simple.validate(r);require('./lib/integration-review-results').verify(review.savedResults,taskIntegrate,r,i);
      if(a.evidenceRecovery)require('./lib/integration-review-results').verifyRecovery(a.evidenceRecovery,integrateAuto.savedCompletion(r,a.previousAttempt,'review'));
    };
    let evidence;
    if(isolatedReview){try{verifyReviewResults();evidence=require('./lib/integration-review').prepare({dir,pdir:p.dir,task:t.id,...review});}catch(e){return send(res,409,{error:e.message});}}
    const shown = automation?text:lt`【渡した依頼：${title}】\n${text}`+(evidence?`\n保存差分原物：${evidence.file}（SHA256 ${evidence.sha256}）。Readでintegration・child・resolution・history${review?.savedResults?'・saved-results・saved-commit・original（原文行範囲と全体SHA。省略範囲は元ファイルを読む）':''}を照合し、試験原物も読む。`:'');
    const account = requestAccount(p, t.id, ai, b.account);
    const request = { stopTicket:stopControl.ticket({project:p.id,task:t.id}), ...(automation?{automation,contextMode:'idea',freshContext:true,preserveTaskState:true,reviewKind:automation.purpose==='review'?'idea':undefined,readOnly:automation.readOnly,readDirs:[p.dir,dir],request:requestKey}:{}), ...(integrationAssignment?{integrationAssignment,limitPolicy:'hold'}:{}), ...(requestKey?{request:requestKey}:{}), ...(isolatedReview?{isolatedReview:true,integrationReviewRequest:requestKey,readOnly:true,readDirs:[p.dir]}:{}), ...(selectionOnly?{selectionOnly:true}:{}), origin: 'delegate', resultsOrganize, ai, account, model, effort, sourceTurn, role: b.role || '', requireModel: true, requiredModel: launch.flagFor(ai, model), shown, text: automation?text:shown + lt('\n\n新しい作業・子作業を作らず、この既存作業で依頼を行い、結果をこの会話へ返してください。'), perm: permCmd(ai) };
    const enqueue = () => {
      if(resultsOrganize)return send(res,409,{error:lt('別の依頼が作業中・順番待ちのため成果整理を開始していません')});
      res.integrationDelivery?.begin();
      const item = chats.enqueue(p.id, t.id, request);
      record('delegate', { project: p.id, task: t.id, ai }, { title, model, effort, queued: true, id: item.id, sourceTurn, ...(requestKey?{request:requestKey}:{}) });
      return send(res, 200, { ok: true, project: p.id, task: t.id, title, model, effort, queued: true, id: item.id, queue: chats.queue(p.id, t.id).length, note: (chats.busy(p.id, t.id) || webchatActive(p.id,t.id) ? lt('今の AI が終わったら、同じ作業で指定の AI が始まります。開始時に上限を確かめた時は保存した交代先で始めます。この番を終えてください') : lt('同じ作業の順番待ちに追加しました。画面の［始める］で再開できます')) + sizeNote });
    };
    if (busy || webchatActive(p.id,t.id) || chats.queue(p.id, t.id).length) return enqueue();
    const basePrompt = automation?ideaDispatch.policy(ideas.read(p.id).runs[automation.runId]):selectionOnly?selectionPrompt(p):isolatedReview?integrationReviewPrompt(p,t):beforeStart?null:taskPrompt(p, t, file, dir) + lt(' 同じ作業で担当 AI から渡された依頼です。結果と残った課題をこの会話へ返してください。');
    const onEnd = row => {
      if (!preserveTaskState && row.asks && row.asks.length) store.updateTask(p.id, t.id, { state: '返事待ち', question: row.asks.map(a => a.question).filter(Boolean).join(' / ').slice(0, 300) || lt('選んでください') });
      chatEnded(p.id, t.id);
      record('delegateend', { project: p.id, task: t.id, ai: row.ai }, { title, model: row.model, error: Boolean(row.error) });
    };
    try {
      const stopVersion = chats.stops.get(chats.key(p.id, t.id)) || 0;
      await refreshLimitEvidence({ ...request, project: p.id, task: t.id });
      verifyIntegrationAssignmentSend({...request,project:p.id,task:t.id});
      if(integrationAssignment&&limitEvidence.active(account,launch.flagFor(ai,model)))throw Error('指定した統合担当が上限中です。担当を替えず解除まで待機します');
      if(beforeStart){beforeStart();if(selectionOnly){assertWorkspaceIdle(p,t,false);dir=p.dir;}else ({dir}=startDir(p,t));if(resultsRecovery)request.resultsRecoveryHash=store.readTask(file).completionHash;}
      if ((chats.stops.get(chats.key(p.id, t.id)) || 0) !== stopVersion) throw Error(lt('利用上限の確認中に停止されたため、委任を開始していません'));
      const terminalError = delegateTerminalError(p.id, t.id);
      if (terminalError) throw Error(terminalError);
      // 状態要求を待つ間に他の依頼が始まった場合も同じ待ち順へ入れる。
      if (chats.busy(p.id, t.id) || webchatActive(p.id,t.id) || chats.queue(p.id, t.id).length) return enqueue();
      const prompt=basePrompt??taskPrompt(p,t,file,dir)+lt(' 同じ作業で担当 AI から渡された依頼です。結果と残った課題をこの会話へ返してください。');
      const r = chats.send({ ...request, project: p.id, task: t.id, pdir: p.dir, dir, basePrompt:prompt, policy: automation?basePrompt:selectionOnly?selectionPrompt(p):modelPolicy(p, t), beforeSend:()=>{verifyReviewResults();res.integrationDelivery?.begin();}, onEnd });
      if (!(await r.started)) throw Error(lt('AIを起動できませんでした。CLIの導入状態を確認してください。作業の状態と質問は変更していません'));
      if(!preserveTaskState)store.updateTask(p.id, t.id, { state: '実行中', question: '' });
      record('delegate', { project: p.id, task: t.id, ai: r.ai }, { title, ...(requestKey?{request:requestKey}:{}), model: r.model, effort: r.effort, queued: false, preflight: Boolean(r.limitSwitch?.preflight), sourceTurn, receivedTurn: r.userRow.turn });
      return send(res, 200, { ok: true, project: p.id, task: t.id, title, ai: r.ai, model: r.model, effort: r.effort, queued: false, resume: r.resume, note: lt`${r.limitSwitch?.preflight ? lt`${r.limitSwitch.from} 上限保持中のため ${r.model} で開始しました。` : ''}同じ作業で ${launch.AI_LABEL[r.ai]}・${r.model} が作業中です。結果もこの会話へ届きます` + sizeNote });
    } catch (e) { return send(res, 409, { error: String(e.message || e) }); }
}

// 場所リンクの候補順は、Mac操作とブラウザ表示で共通にする。
const placeRoots = () => [os.homedir(), ROOT].map(d => path.resolve(d));
const insidePlaceRoots = (target, roots) => roots.some(h => target === h || target.startsWith(h + path.sep));
// Mac の許可が無くて中を読めない時の知らせ（Finder が違う場所で開くのを防ぐ）
const denied = x => { try { fs.readdirSync(fs.statSync(x).isDirectory() ? x : path.dirname(x)); return ''; } catch (e) { return ['EPERM', 'EACCES'].includes(e.code) ? lt('Mac の許可が無くて開けません。設定画面の「Mac のファイルの許可」で［確認をもう一度出す］を押し、「許可」を選んでください') : ''; } };
function resolvePlace(b) {
  const raw = String(b.path || '').trim();
  if (!raw) throw Object.assign(Error(lt('場所がありません')), { status: 400 });
  const p = store.readProject(b.project);
  const f = p && b.task ? store.taskFile(b.project, b.task) : null;
  const t = f ? store.readTask(f) : null;
  const bases = [t && expandHome(t.workdir), p && baseOf(p), p && p.dir, ROOT, store.product].filter(Boolean);
  const list = raw.startsWith('~') || path.isAbsolute(raw) ? [expandHome(raw)] : bases.map(d => path.join(d, raw));
  const home = placeRoots();
  const target = list.map(x => path.resolve(x)).find(x => insidePlaceRoots(x, home) && fs.existsSync(x));
  if (!target) throw Object.assign(Error(lt`見つかりません：${raw}`), { status: 404 });
  const error = denied(target);
  if (error) throw Object.assign(Error(error), { status: 403 });
  return { target, home };
}
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.tsv', '.json', '.log', '.yaml', '.yml']);
const DOC_EXTENSIONS = new Set(['.docx', '.doc', '.rtf', '.odt']);
function viewInfo(target) {
  try {
    const real = fs.realpathSync(target);
    // macOSの /var → /private/var 等も同じルートとして比較する。
    const roots = placeRoots().map(d => { try { return fs.realpathSync(d); } catch { return d; } });
    if (!insidePlaceRoots(real, roots)) return { status: 404 };
    const ext = path.extname(target).toLowerCase(), stat = fs.statSync(real);
    const kind = IMAGE_TYPES[ext] ? 'image' : ext === '.pdf' ? 'pdf' : TEXT_EXTENSIONS.has(ext) ? 'text' : DOC_EXTENSIONS.has(ext) ? 'doc' : '';
    const limit = ({ image: 30, pdf: 50, text: 2, doc: 20 })[kind] * 1024 * 1024;
    const type = IMAGE_TYPES[ext] || ({ pdf: 'application/pdf', text: 'text/plain; charset=utf-8', doc: 'text/html; charset=utf-8' })[kind];
    if (!kind || !stat.isFile() || stat.size > limit) return { status: 415 };
    return { status: 200, path: real, kind, type, limit, ext, stat };
  } catch { return { status: 404 }; }
}
function documentHtml(fd, info, size) {
  // textutilに場所を再び開かせず、確認済みfdから上限内の内容だけを渡す。
  const input = Buffer.alloc(size);
  let read = 0;
  while (read < size) {
    const n = fs.readSync(fd, input, read, size - read, read);
    if (!n) throw Error('document changed');
    read += n;
  }
  return new Promise((resolve, reject) => {
    const child = require('child_process').execFile('/usr/bin/textutil',
      ['-convert', 'html', '-noload', '-nostore', '-stdout', '-encoding', 'UTF-8', '-format', info.ext.slice(1), '-stdin'],
      { timeout: 15000, maxBuffer: 5 * 1024 * 1024 }, (error, html) => {
        // textutilは壊れた入力でも終了0で空出力になる場合がある。
        if (error) reject(error);
        else if (!/<html(?:\s|>)/i.test(html)) reject(Error('invalid document output'));
        else resolve(html);
      });
    child.stdin.on('error', () => {}); // 終了/時間切れ時のEPIPEは上のcallbackで扱う。
    child.stdin.end(input);
  });
}

const stateOffers = new (require('./lib/state-offers').StateOffers)({transfer:taskTransfer,removal,baseOf});

async function api(req, res, url) {
  const mutation = req.method === 'POST' && !['/api/restart','/api/restart/cancel','/api/quit'].includes(url.pathname);
  // GETの利用枠取得も、非同期取得後に上限記録を保存するまで再起動を待たせる。
  const accountRead = req.method === 'GET' && (url.pathname === '/api/usage' || url.pathname === '/api/accounts' && url.searchParams.get('status') === '1');
  if ((req.method === 'POST' && !['/api/restart','/api/ai/stop','/api/ai/resume','/api/chat/stop','/api/term/stop'].includes(url.pathname) || accountRead) && restartControl?.committed) { req.resume(); return send(res,url.pathname.startsWith('/api/ideas')?503:409,{error:lt('再起動を開始しています'),...(url.pathname.startsWith('/api/ideas')?{code:'restarting',saved:false,retry:'receipt'}:{})}); }
  const active = mutation || accountRead;
  if (active) activeRequests++;
  try { return await reqCtx.run({...reqCtx.getStore(),stopSnapshot:structuredClone(stopControl.data)},()=>apiRequest(req,res,url)); } finally { if (active) activeRequests--; }
}
async function apiRequest(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/chat/queue/draft') {
    const p = store.readProject(url.searchParams.get('project')), task = url.searchParams.get('task');
    const item = p && store.taskFile(p.id, task) && chats.queue(p.id, task).find(x => x.id === url.searchParams.get('id'));
    if (!item) return send(res, 404, { error: 'その指示はもう待っていません' });
    if (!queueEditable(item)) return send(res, 409, { error: 'この待ち指示は編集できません' });
    return send(res, 200, { draft: queueEdit.draft(p, task, item, freetalkAttachments), expectedItem: JSON.stringify(item) });
  }
  if(req.method==='GET'&&url.pathname==='/api/ai/stop/status')return send(res,200,{...stopControl.view(),targets:emergencyStop.targets()});
  if(req.method==='POST'&&['/api/ai/stop','/api/ai/resume','/api/chat/stop','/api/term/stop'].includes(url.pathname)){
    let b;try{b=await readBody(req);if(!b||typeof b!=='object'||Array.isArray(b))throw Error('形式が違います');}catch(e){return send(res,400,{error:e.message});}
    try{
      if(url.pathname==='/api/ai/resume'){if(b.confirm!==true)throw Error('再開の確認が必要です');if(restartControl.committed)throw Error('再起動を開始しています');return send(res,200,stopControl.resume());}
      const all=url.pathname==='/api/ai/stop';
      if(all&&b.confirm!==true)throw Error('停止対象の確認が必要です');
      if(!all&&(typeof b.project!=='string'||!b.project||typeof b.task!=='string'||!b.task))throw Error('停止する作業を選んでください');
      if(!all){const protectedError=freetalkLib.guard('/api/chat/stop',{project:b.project,task:b.task});if(protectedError)throw Error(protectedError);}
      if(all){if(typeof b.opId!=='string'||!/^[a-f0-9-]{36}$/i.test(b.opId))throw Error('停止の受付番号を確認できません');return send(res,200,await emergencyRestart.request(b.opId));}
      return send(res,200,await emergencyStop.stop({project:b.project,task:b.task}));
    }catch(e){return send(res,409,{error:e.message,...stopControl.view()});}
  }

  if (fromRemote() && ['/api/langpacks', '/api/langpacks/import', '/api/langpacks/remove', '/api/language'].includes(url.pathname)) return send(res, 403, { error: 'forbidden' });
  if(req.method==='GET'&&url.pathname==='/api/task/continue/status'){
    if(req.headers['x-hub']!=='1')return send(res,403,{error:'forbidden'});
    try{return send(res,200,taskHistory.continueStatus(url.searchParams.get('project'),url.searchParams.get('task'),url.searchParams.get('requestId')));}catch(e){return send(res,409,{error:e.message});}
  }
  if(req.method==='GET'&&url.pathname.startsWith('/api/task/history/')){
    if(req.headers['x-hub']!=='1')return send(res,403,{error:'forbidden'});
    const project=url.searchParams.get('project'),task=url.searchParams.get('task');
    try{if(url.pathname.endsWith('/status'))return send(res,200,{...taskHistory.status(project,task),...(url.searchParams.get('selection')==='0'?{}:{selection:taskHistory.selectionPreview(project,task)})});
      if(url.pathname.endsWith('/auto'))return send(res,200,autoView(project,task));
      if(url.pathname.endsWith('/archives'))return send(res,200,{archives:taskHistory.archives(project,task)});
      if(url.pathname.endsWith('/archive'))return send(res,200,taskHistory.archive(project,task,url.searchParams.get('archiveId'),url.searchParams.get('offset')));
    }catch(e){return send(res,409,{error:e.message});}
    return send(res,404,{error:'not found'});
  }

  // Preview, start and resume report the same blockers without mutating while waiting.
  const integrationWaitingRoute=['/api/task/integrate/preview','/api/task/integrate/resume','/api/task/integrate','/api/task/absorb'].includes(url.pathname);
  if (req.method === 'POST' && appShell.rebuilding && !integrationWaitingRoute && !['/api/restart','/api/restart/cancel'].includes(url.pathname)) return send(res, 409, { error: lt('アプリを作り直しています') });
  if(req.method==='GET' && url.pathname==='/api/locale')return send(res,200,localeConfig());
  if (req.method === 'GET' && url.pathname === '/api/app-update') return send(res, 200, appUpdate.status());
  if (req.method === 'POST' && ['/api/app-update', '/api/app-update/check'].includes(url.pathname)) {
    if (fromRemote()) return send(res, 403, { error: 'forbidden' });
    let body; try { body = await readBody(req); } catch { return send(res, 400, { error: lt('形式が違います') }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: lt('形式が違います') });
    if (url.pathname.endsWith('/check') || body.action === 'check') { void appUpdate.check().catch(() => {}); return send(res, 200, appUpdate.status()); }
    if (body.action === 'apply') {
      if (appUpdate.status().mode !== 'packaged' || !appUpdate.data.prepared || appUpdate.running) return send(res, 409, { error: '適用できる更新はありません' });
      void appUpdate.apply().catch(() => {}); return send(res, 200, appUpdate.status());
    }
    if (typeof body.enabled !== 'boolean') return send(res, 400, { error: lt('形式が違います') });
    try { return send(res, 200, await appUpdate.settings(body.enabled)); } catch (error) { return send(res, 400, { error: error.message }); }
  }
  if (req.method === 'POST' && appUpdate.applying() && !integrationWaitingRoute && !(['/api/restart','/api/restart/cancel'].includes(url.pathname)) && !(['/api/quit'].includes(url.pathname) && appUpdate.status().phase === 'installed')) return send(res, 409, { error: appUpdate.busyMessage() });
  if (['/api/langpacks', '/api/langpacks/import', '/api/langpacks/remove', '/api/language'].includes(url.pathname)) {
    if (fromRemote() || !allowed(req)) return send(res, 403, { error: 'forbidden' });
    if (req.method === 'GET' && url.pathname === '/api/langpacks') return send(res, 200, langpacks.packSettings(ROOT, VERSION));
    if (req.method !== 'POST' || url.pathname === '/api/langpacks') return send(res, 405, { error: 'method' });
    try {
      const body = await readBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('形式が違います');
      if (url.pathname === '/api/langpacks/import') langpacks.importPack(ROOT, body.dir);
      else if (url.pathname === '/api/langpacks/remove') langpacks.removePack(ROOT, body.id);
      else langpacks.selectLanguage(ROOT, body.language);
      return send(res, 200, langpacks.packSettings(ROOT, VERSION));
    } catch (error) { return send(res, 400, { error: error.message }); }
  }
  // SSE・添付などJSON共通guardより前の経路も、別表記で別セッションを作らない。
  if (freetalkLib.hasTarget(Object.fromEntries(url.searchParams), true)) { req.resume(); return send(res, 409, { error: lt('freetalk は正規の名前「freetalk」で指定してください') }); }
  // 本体が台帳のフォルダ（書類フォルダの中）を読めるか。Mac の許可が本体に効いているかをアプリが確かめる
  if (req.method === 'GET' && url.pathname === '/api/access') {
    try { fs.readdirSync(ROOT); return send(res, 200, { ok: true, root: ROOT }); }
    catch (e) { return send(res, 200, { ok: false, root: ROOT, code: e.code || '' }); }
  }
  // 一覧
  // 生きているかだけ答える（ファイルを読まないので、台帳が大きくても・iCloud が遅くてもすぐ返る）
  if(req.method==='GET' && url.pathname==='/api/chat/queue/retreat') {
    try { if(req.headers['x-hub']!=='1')return send(res,403,{error:'接続を確認してください'});return send(res,200,queueRetreat.receipt(Object.fromEntries(url.searchParams))); }
    catch(e){return send(res,e.status||503,{error:e.message,code:e.code});}
  }
  if(req.method==='GET' && (url.pathname==='/api/ideas' || url.pathname.startsWith('/api/ideas/'))) return ideaAPI.handle(req,res,url,null,send);
  if (req.method === 'GET' && url.pathname === '/api/ping') return send(res, 200, { ok: true, version: VERSION, pid: process.pid, runtimePath: __dirname, instance: HUB_INSTANCE, restored: updateRestoreReady, updateConfirm: process.env.HUB_UPDATE_CONFIRM || '' });
  if (req.method === 'GET' && url.pathname === '/api/roles/history') {
    const current = roleHistory.load(ROLES_FILE);
    return send(res,200,{...roleHistory.summary(current),history:current.journal.history,defaults:current.journal.defaults});
  }
  if (req.method === 'GET' && url.pathname === '/api/task/integrate/wait') return send(res,200,{waiting:integrateAuto.waiting(Object.fromEntries(url.searchParams))});
  if (req.method === 'GET' && url.pathname === '/api/discussion') { const project=url.searchParams.get('project'), task=url.searchParams.get('task'); return send(res,200,discussion.view(project,task)); }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    const t0 = Date.now();
    res.on('finish', () => { const ms = Date.now() - t0; if (ms > 2000) console.log(lt`[遅い] 一覧を作るのに ${ms}ms かかりました（台帳のファイルの読み込みが遅い可能性）`); });
    const savedHead = gitw.savedHeadAsync(__dirname);
    pruneUnread(); // Keep notification writes outside the display read scope.
    const state = require('./lib/state-read').run(() => {
    const discussionSessions = discussion?.read().sessions || {};
    const roleData = rolesData(), modelSettings = modelView.read(), initialPick = modelView.initial(modelSettings);
    // 画面で使う物だけ送る：作業の「やったこと」「注意」「メモ」の本文は送らず、「次にやること」は1行目だけ（1MB → 数百KB）
    const slim = t => { const { done, note, memo, next, steps, ...rest } = t; return { ...rest, stepSummary: stepSummary(steps), next: String(next || '').split('\n')[0] }; };
    // Share only within this synchronous read. Action paths omit these arguments
    // and still validate current receipts before sending, starting or restarting.
    const handoffErrors = chats.handoffErrors({display:true}), restartWaiting = restartBlockers(handoffErrors);
    return {
      stopControl:stopControl.view(), root: ROOT, hubInstance: HUB_INSTANCE, roles: roleData, version: VERSION, latest: readVersion(), runtime:{version:VERSION,bootHead:BOOT_HEAD}, saved:{version:readVersion(),mainHead:null}, license: license.status(), appUpdate: appUpdate.status(), appShell: appShell.status(req.headers['user-agent']), freetalk: freetalkStatus(),
      onboarding: onboarding.state(),
      aiCliUpdate: { available: Object.values(aiUpdates.status().tools).some(t => t.eligible && t.installed && t.updateCheck?.ok && t.updateCheck.available === true && t.updateCheck.applicable === true), busyCount: aiTools.busy() },
      updateBlocked: Boolean(updateBusy(handoffErrors)), restart: restartControl.status(restartWaiting), restartBusy:restartWaiting.length>0, restartWaiting, chatHandoffErrors:handoffErrors,
      bodyNotices:bodyNoticeState(),
      github: github.summary(), accounts: accounts.list(),
      completionWarning: store.completion.warning, projectOrder: projectOrder.read(), projectPins: projectOrder.readPins(),
      taskHandoffs: taskTransfer.pending(),
      taskOffers: stateOffers.view(store.listProjects()), taskIntegrations: taskIntegrate.pending(),
      cliFlags: Object.fromEntries(launch.AIS.map(ai => [ai, Object.fromEntries((roleData.models[launch.AI_KEY[ai]] || []).map(m => [m, launch.flagFor(ai, m)]))])),
      // github：origin の場所と今のブランチ（120秒覚えておく）。作業は作業用コピーがある物だけ（ブランチが別のため）
      projects: (all => { const kids = handoff.childCounts(all); return all.map(p => {
        const base = baseOf(p);
        const {notes,...summary}=p;
        const githubRemote = github.projectRemote(githubProject(p));
        return { ...summary, children: kids[p.id], startSpec: start.lastSpec(p), copies: gitw.countCopies(workRoot(p)), githubHasOrigin: githubRemote.hasOrigin, github: githubRemote.value, githubTargetError: githubRemote.error || '', tasks: p.tasks.map(t => {
          const missing = copyMissing(p, t);
          const meta = chat.readMeta(p.dir, t.id);
          const queue = chats.queue(p.id, t.id);
          const githubFolder = t.workdir && !missing ? path.join(expandHome(t.workdir), githubRemote.target || '.') : '';
          const taskGithub = githubFolder && (githubRemote.target === '.' || fs.existsSync(path.join(githubFolder, '.git'))) ? gitw.remoteSummary(githubFolder).value : null;
          return { ...slim(resultsGate.decorate(p,t,all,{issue:stateOffers.issue(p,t)})), discussion: (()=>{const d=discussionSessions[JSON.stringify([p.id,t.id])];return d?{id:d.id,status:d.status}:null;})(), chatQueueCount: queue.length, chatQueueHeld: queue.some(q => Boolean(q?.stopHeld)), chatQueueBlocked: queue.some(q => !q || typeof q !== 'object' || Array.isArray(q) || Boolean(q.stopHeld || q.error || q.limitWaiting)), ...(p.kind === 'freetalk' ? { freetalkHistory: (()=>{try{return freetalkHistory.status(t.id);}catch(e){return {reason:e.message};}})() } : {}), accounts: meta.accounts || {}, codexFast: meta.codexFast === true, copy: inWork(p, t) && !missing, copyMissing: missing, webchatReason: (()=>{try{webchat.availability(p,t,undefined,handoffErrors);return '';}catch(e){return /^webchat_[a-z_]+$/.test(e.message)?e.message:'webchat_task_busy';}})(), ...(t.workdir && !missing ? { github: taskGithub } : {}) };
        }) };
      }); })(store.listProjects()),
      sessions: sessions.list(), terminal: sessions.available(),
      chatting: [...chats.running.entries()].map(([k, r]) => { const [project, task] = k.split('\u0000'); return { project, task, ai: r.ai, model: r.model }; }),
      specialMode: modelView.special(modelSettings),
      initialPick, initialPickError: modelError(initialPick.ai, initialPick.model),
      efforts: roles.EFFORTS, hiddenModels: modelView.hidden(modelSettings), modelOrder: modelView.saved(modelSettings), phoneLabels: modelView.phone(modelSettings),
      unread: [...unread].map(k => { const [project, task] = k.split('\u0000'); return { project, task }; }),
      background: procwatch.list().filter(x => x.project),
      acceleration: acceleration.settings(), remote: { enabled: remote.enabled() }, chatgpt: gpt.settings(), webchat: webchat.view(), hubDir: __dirname,
      grokAvailable: Boolean(aiTools.find('grok') && aiTools.catalog().grok.models.length),
      agyAvailable: Boolean(aiTools.find('agy') && aiTools.catalog().agy.models.length && !['failed','auth-required'].includes(aiTools.catalog().agy.state) && !launch.agyAccountError()),
      agyModels: aiTools.catalog().agy.models, agyModelsState: aiTools.catalog().agy.state || 'unconfirmed',
      agyModelError: aiTools.catalog().agy.error || '',
    };
    });
    state.saved.mainHead = await savedHead || null;
    // 変わっていなければ中身を送らない（304）。画面は15秒ごとに聞いてくるので、何も変わらない時はほぼ空の返事で済む
    // 止まっている秒数（quiet）は毎秒変わるので印には入れない（画面は別に /api/sessions で取る）
    const body = JSON.stringify(state);
    const tagBody = state.sessions.length ? JSON.stringify({ ...state, sessions: state.sessions.map(({ quiet, ...x }) => x) }) : body;
    // Identity/gzip (and quiet-only updates) share a semantic, weak validator.
    const tag = `W/"${crypto.createHash('sha1').update(tagBody).digest('hex').slice(0, 20)}"`;
    if (req.headers['if-none-match'] === tag) { res.writeHead(304, { ETag: tag, 'Cache-Control': 'no-store', Vary: 'Accept-Encoding' }); return res.end(); }
    // Only a complete, successful local state response proves the new backend
    // is healthy. Error/304 responses and a closed stream leave recovery pending.
    if (!fromRemote() && appUpdate.healthy) res.once('finish', () => {
      if (res.statusCode !== 200 || !res.writableFinished || req.aborted) return;
      void appUpdate.healthy({ version: VERSION, hubPath: __dirname, token: process.env.HUB_UPDATE_CONFIRM, restored: updateRestoreReady, instance: HUB_INSTANCE }).catch(e => record('app-update-confirm-error', {}, { error: e.message }));
    });
    return sendEncoded(req, res, body, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ETag: tag });
  }
  // Full steps are fetched only for the open task. Reading never marks it read.
  if (req.method === 'GET' && url.pathname === '/api/task/steps') {
    const p=store.readProject(url.searchParams.get('project')),t=p?.tasks.find(t=>t.id===url.searchParams.get('task'));
    return t ? send(res,200,{steps:t.steps,version:stepSummary(t.steps).version}) : send(res,404,{error:lt('作業が見つかりません')});
  }
  // 裏で動いている AI の全部（どのプロジェクトにも当たらない物も含む）
  if (req.method === 'GET' && url.pathname === '/api/background') return send(res, 200, { items: procwatch.list() });
  if (req.method === 'GET' && url.pathname === '/api/ai-tools') {
    const status = aiUpdates.status();
    applyModelCatalog();
    return send(res, 200, status);
  }
  if (req.method === 'GET' && url.pathname === '/api/skills') return send(res, 200, listSkills({ accounts, fresh: url.searchParams.get('fresh') === '1' }));
  if (req.method === 'GET' && url.pathname === '/api/accounts') {
    if (url.searchParams.get('status') === '1' && req.headers['x-hub'] !== '1') return send(res, 403, { error: 'forbidden' });
    const filterAi = url.searchParams.get('ai');
    if (filterAi && !launch.AIS.includes(filterAi)) return send(res, 400, { error: 'invalid ai' });
    const rows = accounts.list().filter(row => !filterAi || row.ai === filterAi);
    const checked = url.searchParams.get('status') === '1' ? await Promise.all(rows.map(async r => {
      const status = await accounts.status(r.ai, r.id); usage.loginChecked(r.ai, r.id, status.status);
      if (r.ai === 'agy') {
        try {
          if (status.modelObservation) aiTools.saveCatalog('agy', status.modelObservation);
          else if (status.modelsState === 'failed') aiTools.modelFailure('agy', status.message);
          applyModelCatalog();
        } catch { return { ...r, ...status, message: lt('モデル一覧を保存できませんでした。再取得してください') }; }
      }
      return { ...r, ...status };
    })) : rows;
    return send(res, 200, { accounts: checked, ...(url.searchParams.get('status') === '1' ? {
      agyCatalog: { ...aiTools.catalog().agy, available: Boolean(aiTools.find('agy') && aiTools.catalog().agy.models.length && !['failed','auth-required'].includes(aiTools.catalog().agy.state) && !launch.agyAccountError()) },
    } : {}) });
  }
  if (req.method === 'GET' && url.pathname === '/api/usage') {
    const origin = req.headers.origin;
    if (req.headers['x-hub'] !== '1' || origin && ![`http://127.0.0.1:${PORT}`,`http://localhost:${PORT}`].includes(origin)) return send(res,403,{ error:'forbidden' });
    return send(res, 200, usageWithLimit(await usage.status(false, usageSelection(url))));
  }


  // 会話画面：今までの会話と、書いている途中の返事を流す
  if (req.method === 'GET' && url.pathname === '/api/chat/stream') {
    const project = url.searchParams.get('project'), task = url.searchParams.get('task');
    const p = store.readProject(project);
    if (!p || !store.taskFile(project, task)) return send(res, 404, { error: lt('作業が見つかりません') });
    setUnread(project, task, false); // 開いたので読んだことにする
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const emit = ev => {
      if(p.kind!=='freetalk') {
        const generation=taskHistory.state(project,task).generation;
        if(ev.type==='rows')ev={...ev,rows:ideaRows(ev.rows,generation)};
        else if(ev.type==='row' && ['user','assistant'].includes(ev.row.role)) {
          const rows=ideaRows(chat.read(p.dir,task),generation),found=rows.findLast(r=>r.role===ev.row.role&&r.text===ev.row.text&&r.at===ev.row.at);
          ev={...ev,row:found||ev.row};
        }
      }
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    };
    const run = chats.busy(project, task);
    const wc = webchat.busy().find(j=>j.project===project&&j.task===task);
    emit({ type: 'rows', generation:p.kind==='freetalk'?freetalkHistory.state(task).generation:taskHistory.state(project,task).generation, rows: chat.read(p.dir, task), busy: run ? { ai: run.ai, model: run.model, text: run.texts.join(['agy', 'grok'].includes(run.ai) ? '' : '\n\n'), started: run.started, last: run.last } : wc ? {ai:'chatgpt',model:wc.model,started:Date.parse(wc.at),text:'',webchat:true} : null, queue: chats.queue(project, task) });
    const off = chats.watch(project, task, emit);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { off(); clearInterval(ping); });
    return undefined;
  }
  if (req.method === 'GET' && url.pathname === '/api/cli-models') {
    const m = rolesData().models;
    const rows = ai => (m[launch.AI_KEY[ai]] || []).map(name => ({ name, flag: launch.flagFor(ai, name), set: Object.prototype.hasOwnProperty.call(launch.getOverrides()[ai] || {}, name) }));
    return send(res, 200, { claude: rows('claude'), codex: rows('codex'), agy: rows('agy'), grok: rows('grok'), hints: cliModelHints(), acceleration: acceleration.settings() });
  }
  if (req.method === 'GET' && url.pathname === '/api/acceleration') return send(res, 200, acceleration.settings());
  if (/^\/api\/chatgpt\/plan(?:\/|$)/.test(url.pathname)) {
    if (req.headers['x-hub'] !== '1') return send(res, 403, { error: 'forbidden' });
    return send(res, 410, { error: chat.CHATGPT_RETIRED });
  }
  // ChatGPT の道具（mcp.js から）。X-Hub の印がある物だけ
  if (url.pathname.startsWith('/api/mcp/')) {
    if (req.headers['x-hub'] !== '1') return send(res, 403, { error: 'forbidden' });
    if (['/api/mcp/http','/api/mcp/rpc'].includes(url.pathname)) return send(res,410,{error:'Dot event adapter retired'});
    if (req.method === 'GET' && url.pathname === '/api/mcp/tools') return send(res, 200, { tools: gpt.tools(), work: gpt.settings().work });
    if (req.method === 'POST' && url.pathname === '/api/mcp/call') {
      const b = await readBody(req);
      try { if(b.arguments?.project==='freetalk' && b.arguments.task && !['hub_get_task','hub_get_chat','hub_read_file','hub_list_tasks'].includes(b.name) && freetalkHistory.state(b.arguments.task).migrated)return send(res,409,{error:lt('移行済みの話題は読み取り専用です')}); const r = await gpt.call(String(b.name || ''), b.arguments && typeof b.arguments === 'object' ? b.arguments : {}); return send(res, 200, { text: typeof r === 'string' ? r : JSON.stringify(r, null, 2) }); }
      catch (e) { return send(res, e.status || 500, { error: String(e.message || e), unknown: e.status === 404 && e.unknown === true }); }
    }
    return send(res, 404, { error: 'not found' });
  }
  if (req.method === 'GET' && url.pathname === '/api/github') return send(res, 200, { ...await github.status({ fresh: url.searchParams.get('fresh') === '1' }), settings: github.settings() });
  if (req.method === 'GET' && url.pathname === '/api/webchat') return send(res, 200, webchat.view());
  if (req.method === 'GET' && url.pathname === '/api/chatgpt') return send(res, 200, { ...gpt.settings(), ...codexMcpStatus() });
  // 外から使う（iPhone）の設定
  if (req.method === 'GET' && url.pathname === '/api/remote') { const st = remote.status(); return (st.url ? Promise.resolve(st.url) : tailscaleUrl()).then(u => send(res, 200, { ...st, url: u })); }
  if (req.method === 'GET' && url.pathname === '/api/version') return send(res, 200, { version: VERSION, latest: readVersion() });
  if (req.method === 'GET' && url.pathname === '/api/changelog') return send(res, 200, changelog(12));
  if (req.method === 'GET' && url.pathname === '/api/sessions') return send(res, 200, sessions.list());
  if (req.method === 'GET' && url.pathname === '/api/log') return send(res, 200, readLog(Math.min(200, Number(url.searchParams.get('n')) || 50)));
  // 取り込む前の見通し（変更の量・ぶつかりそうか）
  if (req.method === 'GET' && url.pathname === '/api/task/preview') {
    const p = store.readProject(url.searchParams.get('project'));
    const file = p && store.taskFile(p.id, url.searchParams.get('task'));
    if (!file) return send(res, 400, { error: lt('作業が見つかりません') });
    const t = store.readTask(file);
    if (!inWork(p, t)) return send(res, 200, null);
    let r = null;
    try { r = gitw.preview({ dir: expandHome(t.workdir), workRoot: workRoot(p), targetGuard:d=>require('./lib/integration-writes').inspect(gitw,d) }); } catch (e) { r = null; }
    if(r)r.mainDisplay=taskIntegrate.mainDisplay(p.id,t.id);
    return send(res, 200, r);
  }
  if(req.method==='GET'&&url.pathname==='/api/task/body/preview'){
    if(req.headers['x-hub']!=='1')return send(res,403,{error:'forbidden'});
    try{return send(res,200,textBudget.preview(url.searchParams.get('project'),url.searchParams.get('task'),url.searchParams.get('request')));}catch(e){return send(res,409,{error:e.message});}
  }
  // 保管した本文の原文は読むだけ。保管先の一覧にある場所だけを返す。
  if(req.method==='GET'&&(url.pathname==='/api/task/body/archives'||url.pathname==='/api/task/body/archive')){
    if(req.headers['x-hub']!=='1')return send(res,403,{error:'forbidden'});
    try{const project=url.searchParams.get('project'),task=url.searchParams.get('task'),archives=textBudget.archives(project,task);
      if(url.pathname.endsWith('/archives'))return send(res,200,{archives});
      const want=url.searchParams.get('path'),hit=archives.find(a=>a.path===want);if(!hit)return send(res,404,{error:lt('この場所は見つかりません')});
      const file=path.join(store.readProject(project).dir,hit.path);require('./lib/remove').noLinks(file);return send(res,200,{path:hit.path,text:fs.readFileSync(file,'utf8')});
    }catch(e){return send(res,409,{error:e.message});}
  }
  if(req.method==='GET'&&url.pathname==='/api/project/notes'){
    try{const value=projectNotes.read(url.searchParams.get('project')),tag='"'+value.hash+'"';if(req.headers['if-none-match']===tag){res.writeHead(304,{ETag:tag,'Cache-Control':'no-store'});return res.end();}res.setHeader('ETag',tag);return send(res,200,value);}catch(e){return send(res,404,{error:e.message});}
  }

  // 作業画面の出力を流す（Server-Sent Events）
  if (req.method === 'GET' && url.pathname === '/api/term/stream') {
    const project = url.searchParams.get('project'), task = url.searchParams.get('task'), ai = url.searchParams.get('ai');
    const s = sessions.get(project, task, ai);
    if (!s) return send(res, 404, { error: lt('作業画面がありません') });
    setUnread(project, task, false); // 開いたので読んだことにする
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const emit = ev => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    emit({ type: 'data', data: s.buf, replay: true });
    if (s.exited) emit({ type: 'exit', code: s.code });
    const off = sessions.watch(project, task, ai, emit);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { off(); clearInterval(ping); });
    return undefined;
  }

  // GitHub の場所（その場で読み直す）。作業に作業用コピーがあればそのブランチ
  if (req.method === 'GET' && url.pathname === '/api/project/github') {
    const p = store.readProject(url.searchParams.get('project'));
    const task = url.searchParams.get('task');
    const file = p && task ? store.taskFile(p.id, task) : null;
    const wd = file ? expandHome(store.readTask(file).workdir) : '';
    // コピーのブランチはコピーから、本体の接続先は選択済み製品Gitから読む。
    let info = null;
    if (p) {
      const main = github.projectRemote(githubProject(p), { fresh: true }).value;
      if (wd && fs.existsSync(wd) && (!main?.target || main.target === '.')) info = gitw.remoteInfo(wd, { fresh: true });
      else if (wd && main?.target) {
        const candidate = path.join(wd, main.target);
        info = fs.existsSync(path.join(candidate, '.git')) ? gitw.remoteInfo(candidate, { fresh: true }) : null;
      } else info = main;
    }
    return info ? send(res, 200, info) : send(res, 404, { error: lt('GitHub の場所が見つかりません') });
  }

  // 子プロジェクトの一覧（親で作業を続ける前に、終わっていない子を知らせるため）
  if (req.method === 'GET' && url.pathname === '/api/project/children') {
    const r = handoff.childrenSummary(store, url.searchParams.get('project'));
    return r ? send(res, 200, r) : send(res, 404, { error: lt('プロジェクトが見つかりません') });
  }
  if (req.method === 'GET' && url.pathname === '/api/start/image') {
    const p = store.readProject(url.searchParams.get('project'));
    try {
      if (!p) throw Error(lt('プロジェクトがありません'));
      const f = start.imageFile(p, url.searchParams.get('id'), true);
      return send(res, 200, fs.readFileSync(f), /\.jpe?g$/i.test(f) ? 'image/jpeg' : 'image/png');
    } catch { return send(res, 404, { error: lt('画像が見つかりません') }); }
  }

  if (req.method === 'GET' && url.pathname === '/api/file/view') {
    const b = Object.fromEntries(url.searchParams);
    const { target } = resolvePlace(b), info = viewInfo(target);
    const unavailable = { error: lt('このファイルを表示できません。Macで開いてください。') };
    if (info.status !== 200) return send(res, info.status, unavailable);
    // 実体確認後は同じファイルを配信する。最終要素のリンクへの置換も断る。
    let fd, stat;
    try {
      fd = fs.openSync(info.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > info.limit || stat.dev !== info.stat.dev || stat.ino !== info.stat.ino) {
        fs.closeSync(fd);
        return send(res, 415, unavailable);
      }
    } catch (e) {
      if (fd !== undefined) fs.closeSync(fd);
      return send(res, ['EPERM', 'EACCES'].includes(e.code) ? 403 : 404, unavailable);
    }
    const headers = { 'Content-Type': info.type, 'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline' };
    if (info.kind === 'doc') {
      let html;
      try { html = await documentHtml(fd, info, stat.size); }
      catch (e) { return send(res, e.killed || e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 500 : 415, unavailable); }
      finally { fs.closeSync(fd); }
      headers['Content-Security-Policy'] = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:";
      headers['Content-Length'] = Buffer.byteLength(html);
      if (fromRemote()) record('fileview', b, { path: target, kind: info.kind });
      res.writeHead(200, headers);
      return res.end(html);
    }
    // iOSのPDF表示が要求する単一byte rangeも同じfdから返す。
    let begin = 0, end = stat.size - 1, status = 200;
    if (info.kind === 'pdf') {
      headers['Accept-Ranges'] = 'bytes';
      if (req.headers.range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (match && (match[1] || match[2])) {
          begin = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]));
          end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
        } else begin = -1;
        if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || begin > end || begin >= stat.size) {
          fs.closeSync(fd); res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}` }); return res.end();
        }
        status = 206; headers['Content-Range'] = `bytes ${begin}-${end}/${stat.size}`;
      }
    }
    if (fromRemote()) record('fileview', b, { path: target, kind: info.kind });
    res.writeHead(status, { ...headers, 'Content-Length': Math.max(0, end - begin + 1) });
    if (!stat.size) { fs.closeSync(fd); return res.end(); }
    const stream = fs.createReadStream(info.path, { fd, autoClose: true, start: begin, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    return stream.pipe(res);
  }

  if (req.method === 'GET' && url.pathname === '/api/freetalk/status') {
    try {
      if (url.searchParams.get('project') !== 'freetalk') throw Error(lt('freetalk の話題を指定してください'));
      return send(res,200,freetalkHistory.status(url.searchParams.get('task')));
    } catch(e) { return send(res,409,{error:e.message}); }
  }
  if (req.method === 'GET' && url.pathname === '/api/freetalk/attachment') {
    try {
      if(url.searchParams.get('project')!=='freetalk')throw Error('project');
      const preview=freetalkAttachments.preview(url.searchParams.get('task'),url.searchParams.get('id'));
      return send(res,200,preview.data,preview.type);
    } catch { return send(res,404,{error:lt('画像が見つかりません')}); }
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'method' });

  if (url.pathname === '/api/ideas/image') {
    try {
      const { humanRequest } = require('./lib/idea-api'), images = require('./lib/idea-images');
      if (req.headers['x-hub'] !== '1' || !humanRequest(req)) { req.resume(); return send(res,403,{error:'この操作はアイデア台帳の画面から行ってください',saved:false}); }
      const project = url.searchParams.get('project'); ideas.project(project);
      const body = { opId: url.searchParams.get('opId'), name: url.searchParams.get('name') }; require('./lib/idea-utils').opId(body.opId);
      // Drain an oversized body and return a typed rejection without destroying the response socket.
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size <= images.MAX) chunks.push(chunk); }
      if (size > images.MAX) return send(res,413,{error:'画像は1枚20MBまでです',saved:false});
      return send(res,201,ideas.uploadImage(project,body,Buffer.concat(chunks)));
    } catch (e) { req.resume(); return send(res,e.status||503,{error:e.message,message:e.message,code:e.code||'storage',saved:e.saved??false,retry:e.saved==='unknown'?'receipt':'after-change'}); }
  }

  // ファイル・スクショを受け取る（本文はファイルそのもの）。Inbox に置き、作業ファイルに記録し、動いている AI の入力欄に場所を入れる
  if (url.pathname === '/api/task/upload') {
    const q = k => url.searchParams.get(k) || '';
    const p = store.readProject(q('project'));
    const file = p && store.taskFile(p.id, q('task'));
    if(file&&p.kind!=='freetalk'){const generation=taskHistory.state(p.id,q('task')).generation;if((q('generation')||req.headers.origin&&generation>1)&&Number(q('generation'))!==generation){req.resume();return send(res,409,{error:lt('会話が切り替わりました。新しい会話を開いてください')});}}
    if (!file) { req.resume(); return send(res, 400, { error: lt('作業が見つかりません') }); }
    if (p.kind === 'freetalk') {
      let release;
      try {
        const generation=Number(q('generation'));
        release=freetalk.holdUpload(q('task'),generation);
        let data;
        try { data=await readRaw(req,MAX_UPLOAD); } catch { return send(res,413,{error:lt('ファイルが大きすぎます（50MB まで）')}); }
        const attachment=await freetalkAttachments.upload(q('task'),q('name'),data,generation);
        store.updateTask(p.id,q('task'),{memo:lt`ファイルを渡した: ${attachment.referencePaths.join(' , ')}`});
        record('upload',{project:p.id,task:q('task')},{file:attachment.path,bytes:data.length});
        return send(res,200,{ok:true,...attachment,typed:false});
      } catch(e) { req.resume();return send(res,409,{error:e.message}); }
      finally { release?.(); }
    }
    let data;
    try { data = await readRaw(req, MAX_UPLOAD); } catch (e) { return send(res, 413, { error: lt('ファイルが大きすぎます（50MB まで）') }); }
    let saved;
    try { saved = saveUpload(q('name'), data); }
    catch (e) { return send(res, 409, { error: e.message }); }
    store.updateTask(p.id, q('task'), { memo: lt`ファイルを渡した: ${saved}` });
    const ai = launch.AIS.includes(q('ai')) ? q('ai') : '';
    const typed = ai ? sessions.write(p.id, q('task'), ai, (/\s/.test(saved) ? `"${saved}"` : saved) + ' ') : false;
    record('upload', { project: p.id, task: q('task'), ai }, { file: saved, bytes: data.length });
    return send(res, 200, { ok: true, path: saved, typed });
  }

  if (url.pathname === '/api/start/image') {
    const p = store.readProject(url.searchParams.get('project'));
    if (!p) { req.resume(); return send(res, 400, { error: lt('プロジェクトがありません') }); }
    if(p.kind==='freetalk'){req.resume();return send(res,409,{error:lt('freetalkの添付は話題を指定して追加してください')});}
    try { return send(res, 200, start.saveImage(p, url.searchParams.get('name') || 'image.png', await readRaw(req, start.MAX))); }
    catch (e) { return send(res, 400, { error: e.message }); }
  }

  const b = await readBody(req);
  req.historyWrite?.target(b?.project,b?.task);
  if(b?.project&&b.task&&b.project!=='freetalk'&&taskHistory.organizing(b.project,b.task)&&/^\/api\/(chat(?:gpt)?\/|term\/|delegate$|task$|task\/(?:history\/(summary|rotate)$|(?:merge|integrate|absorb|handoff|receive|update|delete|decide|step|completion|copyclear|handup|results)(?:\/|$)))/.test(url.pathname))return send(res,409,{error:lt('会話を整理中です。終わると新しい会話で送れます（入力は残っています）')});
  if(url.pathname==='/api/task/history/auto'){
    // 同じrequestIdの再送・他タブ・切替後の確認は、新しい仕事を作らず同じ仕事を返す。
    try{const job=taskHistory.autoStart(b.project,b.task,b);setImmediate(()=>autoTick(b.project,b.task));return send(res,200,autoView(b.project,b.task,job));}catch(e){return send(res,409,{error:e.message});}
  }
  if(url.pathname==='/api/task/history/auto/cancel'){
    try{taskHistory.autoCancel(b.project,b.task);return send(res,200,autoView(b.project,b.task));}catch(e){return send(res,409,{error:e.message});}
  }
  if(url.pathname.startsWith('/api/ideas/')) return ideaAPI.handle(req,res,url,b,send);
  if(b?.project&&b.task&&!['/api/task/history/rotate','/api/task/continue','/api/task/continue/recover','/api/restart','/api/restart/cancel'].includes(url.pathname)&&b.project!=='freetalk'){
    const generation=taskHistory.state(b.project,b.task).generation;
    const browserConversation=req.headers.origin&&generation>1&&/^\/api\/(chat(?:gpt)?\/|term\/|delegate$|task\/history\/summary$)/.test(url.pathname);
    if((b.generation!==undefined||browserConversation)&&b.generation!==generation)return send(res,409,{error:lt('会話が切り替わりました。新しい会話を開いてください')});
  }
  if(url.pathname==='/api/task/history/rotate'){
    try{return send(res,200,taskHistory.rotate(b.project,b.task,b));}catch(e){return send(res,409,{error:e.message});}
  }
  if(url.pathname==='/api/task/continue/recover'){
    try{const out=require('./lib/task-continue').recoverContinue({history:taskHistory,budget:textBudget},b);if(out.pending)setImmediate(()=>autoTick(b.project,b.task));return send(res,200,out);}catch(e){return send(res,409,{error:e.message});}
  }
  if(url.pathname==='/api/task/continue'){
    try{const out=require('./lib/task-continue').continueTask({history:taskHistory,budget:textBudget},b);record('task-continue',b,{body:out.body,rotate:out.rotate,generation:out.generation});if(out.pending)setImmediate(()=>autoTick(b.project,b.task));return send(res,200,out);}catch(e){
      let stage;try{const r=taskHistory.continueRecord(b.project,b.task);if(!r||r.requestId!==b.requestId)stage='not-started';}catch{}
      return send(res,409,{error:e.message,code:e.code,...(stage?{stage}:{})});
    }
  }
  if(url.pathname==='/api/task/history/summary'){
    try{
      const role=rolesData().roles.find(r=>r.name==='文章');if(!role?.main.model)throw Error(lt('文章担当の設定を確認してください'));
      const request=taskHistory.prepareSummary(b.project,b.task);
      const release=taskHistory.hold(b.project,b.task);res.once('finish',release);res.once('close',release);
      return await delegateRequest({...b,text:request.text,title:lt('会話整理の要約'),ai:role.main.ai==='claude-code'?'claude':role.main.ai,model:role.main.model,effort:role.main.effort,role:role.name},res,{beforeStart:()=>{release();taskHistory.idle(b.project,b.task);if(request.revision!==taskHistory.revision(b.project,b.task))throw Error(lt('要約依頼の準備中に会話が変わりました'));}});
    }catch(e){return send(res,409,{error:e.message});}
  }
  if (url.pathname === '/api/app/rebuild') {
    if (fromRemote()) return send(res, 403, { error: 'forbidden' });
    if (appUpdate.running || appUpdate.applying() || updateBusy()) return send(res, 409, { error: appUpdate.idleMessage() });
    try { return send(res, 200, await appShell.rebuild()); }
    catch (error) { return send(res, error.status || 500, { error: error.message }); }
  }
  if (url.pathname === '/api/freetalk/ensure') return send(res, 200, freetalk.ensure());
  if (url.pathname === '/api/freetalk/topic') {
    try { return send(res, 200, freetalk.createTopic(specialMode.pick(modelView.special(), rolesData(), '司令塔') || modelView.initial())); }
    catch (e) { return send(res, 409, { error: e.message }); }
  }
  if (['/api/chatgpt/prompt','/api/chatgpt/result'].includes(url.pathname)) return send(res, 410, { error: lt('アプリへのコピー経路は廃止しました。ChatGPT（Chat／Pro）を選び直してください') });
  if(b?.project==='freetalk' && b.task && !['/api/task/read','/api/chat/stop','/api/chat/unqueue','/api/freetalk/project-start','/api/freetalk/promote','/api/freetalk/delete'].includes(url.pathname)) {
    try {
      const state=freetalkHistory.state(b.task);
      if(state.migrated)return send(res,409,{error:lt('この話題はプロジェクトへ移行済みで、読み取り専用です')});
      if(state.summary?.intent==='promote' && state.summary.automatic && !state.summary.automatic.error)return send(res,409,{error:lt('プロジェクトへの移行中です。完了までお待ちください')});
    }
    catch(e) { return send(res,409,{error:e.message}); }
  }
  const freetalkBlock = freetalkLib.guard(url.pathname, b);
  if (freetalkBlock) return send(res, 409, { error: freetalkBlock });
  if(['/api/freetalk/project-preview','/api/freetalk/promote','/api/freetalk/clean','/api/freetalk/delete'].includes(url.pathname)) {
    try {
      if(b.project!=='freetalk')throw Error(lt('freetalkを指定してください'));
      if(url.pathname==='/api/freetalk/project-preview')return send(res,200,freetalkLifecycle.preview(b.task));
      if(url.pathname==='/api/freetalk/promote') {
        const r=freetalkLifecycle.promote(b.task,b); chats.emit('freetalk',b.task,{type:'reset'});return send(res,200,r);
      }
      if(url.pathname==='/api/freetalk/delete') {
        const r=freetalkLifecycle.remove(b.task,{confirm:b.confirm});
        chats.base.delete(chats.key('freetalk',b.task));chats.queues.delete(chats.key('freetalk',b.task));
        chats.emit('freetalk',b.task,{type:'reset'});setUnread('freetalk',b.task,false);return send(res,200,r);
      }
      const r=freetalkLifecycle.clean({confirm:b.confirm});cleanFreetalkMemory();return send(res,200,r);
    }catch(e){return send(res,409,{error:e.message});}
  }
  if(url.pathname==='/api/freetalk/project-start') {
    try {
      if(b.project!=='freetalk')throw Error(lt('freetalk の話題を指定してください'));
      return send(res,200,await startAutomaticFreetalk(b.task));
    }catch(e){return send(res,e.status || 409,{error:e.message});}
  }
  if (['/api/freetalk/summary','/api/freetalk/rotate','/api/freetalk/promotion-intent'].includes(url.pathname)) {
    try {
      if (b.project !== 'freetalk') throw Error(lt('freetalk の話題を指定してください'));
      if(url.pathname==='/api/freetalk/promotion-intent')return send(res,200,freetalkHistory.promotionIntent(b.task,b.requested));
      if (url.pathname === '/api/freetalk/rotate') {
        const result = freetalkHistory.rotate(b.task,b);
        chats.base.delete(chats.key('freetalk',b.task)); chats.queues.delete(chats.key('freetalk',b.task));
        chats.emit('freetalk',b.task,{type:'reset'}); setUnread('freetalk',b.task,false);
        return send(res,200,result);
      }
      const request = freetalkHistory.prepareSummary(b.task,{intent:b.intent});

      return await delegateRequest({...request, project:'freetalk',task:b.task,title:lt('話題の整理用の要約')},res,{requestKey:freetalkHistory.state(b.task).summary.id,beforeStart:()=>freetalkHistory.idle(b.task)});
    } catch(e) { return send(res,e.status || 409,{error:e.message}); }
  }

  if (url.pathname === '/api/onboarding') return send(res, 200, { onboarding: onboarding.save(b) });
  if (url.pathname === '/api/onboarding/check') {
    if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some(k => k !== 'ais')) return send(res, 400, { error: lt('確認の指定が正しくありません') });
    return send(res, 200, await onboarding.check(b.ais));
  }
  if (req.method === 'POST' && url.pathname === '/api/limits/clear') {
    const models = limitModels();
    for(const [ai,ids] of Object.entries(discussion.limitModels()))models[ai]=[...new Set([...(models[ai]||[]),...ids])];
    if (!models[b.ai]?.includes(b.model)) return send(res, 400, { error: lt('上限の指定が正しくありません') });
    try { const selection = usageSelection(url, b); const account = b.account || selection[b.ai] || 'default'; accounts.get(b.ai, account); limitEvidence.clear(account, b.model,models); }
    catch { return send(res, 500, { error: lt('解除を保存できませんでした') }); }
    record('limit-clear', { ai: b.ai });
    return send(res, 200, usageWithLimit(usage.snapshot(usageSelection(url, b))));
  }
  if(req.method==='POST'&&['/api/limits/credit-exception','/api/limits/credit-exception/end'].includes(url.pathname)){
    try{
      if(b.ai!=='codex'||b.account!=='default')throw Error(lt('Codexの既定アカウントだけを指定してください'));
      accounts.get('codex','default');
      const selection=usageSelection(url,b);
      const snapshot=url.pathname.endsWith('/end')?usage.snapshot({...selection,codex:'default'}):await usage.status(false,{...selection,codex:'default'});
      if(url.pathname.endsWith('/end'))limitEvidence.endCreditException(b,snapshot);else limitEvidence.startCreditException(b,snapshot);
      record('credit-exception',{ai:'codex'},{ended:url.pathname.endsWith('/end')});
      return send(res,200,usageWithLimit(snapshot));
    }catch(e){return send(res,409,{error:e.message});}
  }
  if (req.method === 'POST' && url.pathname === '/api/limits/fable/clear') {
    try { const selection = usageSelection(url, b); limitEvidence.clear(selection.claude || 'default'); }
    catch { return send(res, 500, { error: lt('解除を保存できませんでした') }); }
    record('limit-clear', {});
    // 解除に利用枠の取得を待たせない。遅れて届く応答もフラグを作らない。
    return send(res, 200, usageWithLimit(usage.snapshot(usageSelection(url, b))));
  }
  if (req.method === 'POST' && url.pathname === '/api/usage/refresh') return send(res, 200, usageWithLimit(await usage.status(true, usageSelection(url, b))));
  if (req.method === 'POST' && url.pathname === '/api/usage/reset') {
    if (!b || b.ai !== 'codex' || typeof b.account !== 'string' || b.confirmed !== true || typeof b.token !== 'string' || b.retry !== undefined && typeof b.retry !== 'boolean') return send(res, 400, { error:lt('チケット使用の指定が正しくありません') });
    try {
      accounts.get('codex', b.account);
      const result = await usage.useReset(b.account, b.token, { confirmed:true, retry:b.retry, selection:usageSelection(url, b) });
      return send(res, 200, { ...result, usage:usageWithLimit(result.usage) });
    } catch (e) { return send(res, e.status || 409, { error:e.publicMessage || lt('チケットを使用できませんでした。利用状況を再確認してください') }); }
  }

  if (url.pathname === '/api/acceleration/task') {
    const p = store.readProject(b.project), file = p && store.taskFile(p.id, b.task);
    if (!file || !fs.existsSync(file)) return send(res, 404, { error: lt('作業が見つかりません') });
    if (typeof b.on !== 'boolean') return send(res, 400, { error: lt('加速はオン・オフで指定してください') });
    if (b.on && !acceleration.settings().codexAllowed) return send(res, 409, { error: lt('設定で加速を使えるようにしてください') });
    const meta = chat.readMeta(p.dir, b.task); meta.codexFast = b.on;
    chat.writeMeta(p.dir, b.task, meta);
    record('task-acceleration', { project: p.id, task: b.task }, { codexFast: b.on });
    return send(res, 200, { codexFast: b.on });
  }
  if (url.pathname === '/api/acceleration') {
    const saved = acceleration.save(b);
    record('acceleration', {}, saved);
    return send(res, 200, saved);
  }
  if (url.pathname === '/api/github') return send(res, 200, await github.save(b));
  if (url.pathname === '/api/github/owners') return send(res, 200, { owners: await github.owners(b.account) });
  if (url.pathname === '/api/github/repositories') return send(res, 200, await github.repositories(b));
  if (url.pathname === '/api/github/connect-preview' || url.pathname === '/api/github/connect') {
    const p = store.readProject(b.project);
    if (!p) return send(res, 404, { error: lt('プロジェクトが見つかりません') });
    if (url.pathname.endsWith('/connect-preview')) return send(res, 200, await github.connectPreview(githubProject(p), b));
    const r = await github.connect(githubProject(p), b);
    record('githubconnect', { project: p.id }, { ok: r.ok, connected: r.connected, private: true, pushed: false, partial: Boolean(r.partial) });
    return send(res, 200, r);
  }
  if (url.pathname === '/api/github/preview' || url.pathname === '/api/github/create') {
    const p = store.readProject(b.project);
    if (!p) return send(res, 404, { error: lt('プロジェクトが見つかりません') });
    if (url.pathname.endsWith('/preview')) return send(res, 200, await github.preview(githubProject(p)));
    if (b.confirm !== true) return send(res, 400, { error: lt('確認画面で［作る］を押してください') });
    const r = await github.create(githubProject(p), b);
    record('githubcreate', { project: p.id }, { ok: r.ok, pushed: r.pushed, private: true, partial: Boolean(r.partial) });
    return send(res, 200, r);
  }
  if (url.pathname === '/api/remote') {
    const r = remote.update({ enabled: b.enabled, passcode: b.passcode });
    if (r.error) return send(res, 400, { error: r.error });
    record('remote', {}, { enabled: remote.enabled(), passcode: b.passcode !== undefined });
    return send(res, 200, remote.status());
  }
  if (url.pathname === '/api/license/activate') {
    try { return send(res, 200, await license.activate(b.code)); }
    catch (e) { return send(res, e.status || 400, { error: e.message, code: e.code || 'license_activation' }); }
  }
  // 自動ChatとMCPで共有する実作業の許可
  if (url.pathname === '/api/accounts' || url.pathname.startsWith('/api/accounts/')) {
    try {
      let result = { ok: true };
      const ai = b.ai, id = b.id || 'default';
      if (['/api/accounts/login','/api/accounts/logout','/api/accounts/delete'].includes(url.pathname) && aiTools.isOperating(ai)) return send(res,409,{error:lt('AI の更新・モデル再取得が進行中です')});
      if (url.pathname === '/api/accounts') { result.account = accounts.add(ai, b.name); usage.invalidate(ai, result.account.id); }
      else if (url.pathname === '/api/accounts/terminal') {
        if (!['login', 'logout'].includes(b.action)) return send(res, 400, { error: 'invalid action' });
        const pid = accounts.authTerminalPid(ai, id);
        if (!pid) return send(res, 409, { error: lt('認証用Terminalが見つかりません。［状態を確認］を押してください') });
        result = await launch.focusAuthTerminal(pid, DRY);
        result.warning = ai === 'agy' ? (b.action === 'logout' ? lt('開いている認証用Terminalで /logout と入力し、終わったら［状態を確認］を押してください。') : lt('開いている認証用Terminalで /login と入力し、終わったら［状態を確認］を押してください。')) : lt('開いている認証用Terminalで操作を続け、終わったら［状態を確認］を押してください。');
      }
      else if (url.pathname === '/api/accounts/rename') accounts.rename(ai, id, b.name);
      else if (url.pathname === '/api/accounts/select') {
        const p = store.readProject(b.project);
        if (!p || !store.taskFile(p.id, b.task)) throw Error(lt('作業が見つかりません'));
        accounts.available(ai, id);
        const live = sessions.get(p.id, b.task, ai);
        if (live && !live.exited && (live.account || 'default') !== id) return send(res, 409, { error: lt('このAIのターミナルが作業中です。終了してから切り替えてください') });
        const meta = chat.readMeta(p.dir, b.task); meta.accounts = { ...meta.accounts, [ai]: id }; chat.writeMeta(p.dir, b.task, meta);
        result.accounts = meta.accounts;
      } else if (url.pathname === '/api/accounts/login' || ai === 'agy' && url.pathname === '/api/accounts/logout') {
        if (url.pathname.endsWith('/logout') && (b.confirm !== true || b.confirmDefault !== true)) return send(res, 400, { error: lt('既定のログアウトをもう一度確認してください') });
        accounts.assertIdle(ai, id);
        const c = accounts.command(ai, id, 'login');
        const command = (ai === 'agy' ? launch.agyAccountShell() : launch.accountShell(ai, id)) + [c.command, ...c.args].map(launch.sq).join(' ');
        const terminal = accounts.terminalCommand(ai, id, command, launch.sq, 'auth', url.pathname.endsWith('/logout') ? 'logout' : 'login');
        try { result = await launch.openTerminal(terminal.command, DRY); } catch (e) { terminal.cancel(); throw e; }
        usage.invalidate(ai, id);
        if (DRY) result = { dry: true, command };
        if (ai === 'agy') result.warning = url.pathname.endsWith('/logout') ? lt('Macで開いたTerminalで /logout と入力し、終わったら［状態を確認］を押してください。') : lt('Macで開いたTerminalで /login と入力し、終わったら［状態を確認］を押してください。');
      } else if (url.pathname === '/api/accounts/logout' || url.pathname === '/api/accounts/delete') {
        if (b.confirm !== true) return send(res, 400, { error: lt('確認してから操作してください') });
        if (url.pathname.endsWith('/logout')) result = await accounts.logout(ai, id, b.confirmDefault);
        else { result = accounts.remove(ai, id); if (ai === 'claude') { try { limitEvidence.clear(id); } catch { result.warning = lt('削除は完了しましたが、上限記録の片付けを保存できませんでした'); } } }
        usage.invalidate(ai, id);
      } else return send(res, 404, { error: lt('操作が見つかりません') });
      record('account' + url.pathname.split('/').pop(), { ai }, { account: id });
      return send(res, 200, result);
    } catch (e) { return send(res, e.status || 400, { error: e.message }); }
  }
  if (url.pathname.startsWith('/api/dot/')) return send(res,410,{error:'Dot連携は廃止しました'});
  if (url.pathname.startsWith('/api/webchat')) {
    if (fromRemote()) return send(res, 403, { error: 'forbidden' });
    try {
      if (url.pathname === '/api/webchat') return send(res, 200, webchat.save(b));
      if (url.pathname === '/api/webchat/status') return send(res, 200, await webchat.controlCall());
      if (url.pathname === '/api/webchat/models') return send(res, 200, await webchat.controlCall(false, true));
      if (url.pathname === '/api/webchat/login') return send(res, 200, await webchat.controlCall(true, false, false, b));
      if (url.pathname === '/api/webchat/logout') {
        if (b.confirm !== true) return send(res, 400, { error: 'webchat_logout_confirm' });
        return send(res, 200, await webchat.controlCall(false, false, true));
      }
      if (url.pathname === '/api/webchat/retry') return send(res, 200, webchat.retry(b.project, b.task, b.request, b.confirm));
      if (url.pathname === '/api/webchat/stop') return send(res, 200, { ok: webchat.stop(b.project, b.task) });
      return send(res, 404, { error: 'not_found' });
    } catch(e) { return send(res, e.status || 409, { error: e.message }); }
  }
  // 通常MCPの互換登録：~/.codex/config.toml に [mcp_servers.project-hub] を書き足す
  if (url.pathname === '/api/chatgpt/register') {
    const r = codexMcpRegister();
    if (r.error) return send(res, 400, { error: r.error });
    record('chatgptregister', {}, { file: r.file, added: r.added });
    return send(res, 200, { ...gpt.settings(), ...codexMcpStatus(), ...r });
  }
  if (url.pathname === '/api/chatgpt') {
    if (typeof b.work !== 'boolean') return send(res, 400, { error: lt('形式が違います') });
    const s = gpt.save({ work: b.work }); record('chatgptwork', {}, { work: s.work });
    return send(res, 200, s);
  }
  if (url.pathname === '/api/remote/logout-all') {
    const n = remote.logoutAll();
    record('remotelogoutall', {}, { sessions: n });
    return send(res, 200, remote.status());
  }
  if (url.pathname === '/api/start/image-path') {
    const p = store.readProject(b.project);
    try { if (!p) throw Error(lt('プロジェクトがありません')); return send(res, 200, start.imageFromPath(p, b.path)); }
    catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (url.pathname === '/api/start') {
    const r = await quickStart(b);
    return send(res, r.status, r.body);
  }

  if (url.pathname === '/api/ai-tools/update-all') {
    if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).length) return send(res, 400, { error: lt('一括更新の指定が正しくありません') });
    try { const result = await aiUpdates.updateAll(); record('aiupdate-all', {}, { results: result.results }); return send(res, 200, result); }
    catch (e) { return send(res, e.status || 502, { error: e.reason || lt('CLI の操作に失敗しました。状態を確認してください。'), stage: e.stage }); }
  }
  if (url.pathname === '/api/ai-tools/check') {
    try { return send(res, 200, await aiUpdates.single(b.ai, 'check')); }
    catch (e) { return send(res, e.status || 502, { error: e.reason || lt('更新情報の確認に失敗しました'), stage: e.stage }); }
  }
  if (url.pathname === '/api/ai-tools/update' || url.pathname === '/api/ai-tools/models/refresh') {
    try {
      const result = await aiUpdates.single(b.ai, url.pathname.endsWith('/update') ? 'update' : 'models');
      applyModelCatalog();
      record(url.pathname.endsWith('/update') ? 'aiupdate' : 'aimodels', { ai: b.ai }, { added: result.models?.added ?? result.added ?? 0 });
      return send(res, 200, result);
    } catch (e) {
      return send(res, e.status || 502, { error: e.reason || e.message || lt('CLI の操作に失敗しました'), stage: e.stage || 'operation', reason: e.reason || e.message || '' });
    }
  }
  if (aiTools.isOperating(b.ai) && ['/api/term/start', '/api/term/handoff', '/api/continue', '/api/chat/send'].includes(url.pathname)) {
    return send(res, 409, { error: lt('AI の更新・モデル再取得が進行中です。終わってから始めてください') });
  }

  // 作業画面を開く（画面の中）
  if (url.pathname === '/api/term/start') {
    try { void license.prepare(); licenseGuard(b, 'accept'); }
    catch (e) { return send(res, e.status || 403, { error: e.message, code: e.code }); }
    const p = store.readProject(b.project);
    const file = store.taskFile(b.project, b.task);
    if (!p || !file || !launch.AIS.includes(b.ai)) return send(res, 400, { error: lt('作業が見つかりません') });
    const t = store.readTask(file);
    let ai = b.ai, spec = pickSpec(t, ai), account = requestAccount(p, t.id, ai, b.account);
    if (ai === 'agy' && typeof b.model === 'string') spec.model = launch.modelLabel(ai, b.model);
    let o = { project: p.id, task: t.id, ai, ...spec, role: t.role, account };
    o = { ...o, ...limitIdentity(rolesData(), o) };
    await refreshLimitEvidence(o);
    const held = limitEvidence.forRequest(o), backup = held && limitBackup(o);
    if (held && modelView.special().enabled) return send(res, 409, { error: lt('特殊モードのAIが上限中です。解除後に再開してください') });
    let switchNote = '';
    if (backup) {
      await refreshLimitEvidence({...o,...backup});
      if (limitEvidence.forRequest(backup)) return send(res, 409, { error: lt('両方の担当が上限中です。解除後に再開してください') });
      switchNote = lt`上限保持中のため ${launch.AI_LABEL[backup.ai]}・${backup.model} で開始`;
      o = { ...o, ...backup }; ai = o.ai; spec = o; account = o.account;
    }
    if (aiTools.isOperating(ai) || restartControl?.committed) return send(res,409,{error:lt('AI の更新・モデル再取得が進行中です')});
    const invalidModel = modelError(ai, spec.model);
    if (invalidModel) return send(res, 409, { error: invalidModel });
    if (sessions.list().some(r => r.project === p.id && r.task === t.id && sessions.get(r.project, r.task, r.ai)?.limitTransition && !sessions.get(r.project, r.task, r.ai)?.limitTransitionDone)) return send(res, 409, { error: lt('上限による交代の準備中です') });
    const cur = sessions.get(p.id, t.id, ai);
    if (backup && terminalBusy(p, t, ai)) return send(res, 409, { error: lt('元AIまたは別のAIが作業中です。終了を待ってください') });
    const pending = terminalPending(p, t);
    const { dir, note } = cur && !cur.exited ? { dir: cur.dir } : startDir(p, t);
    if (pending && !transcript.same(pending.dir, dir)) return send(res, 409, { error: lt('引き継ぎ資料の作業場所が変わっています') });
    const limitMarker = crypto.randomUUID();
    const prompt = (pending ? lt`上限で中断した続きです。引き継ぎ資料 ${pending.packet} を読み、済んだ部分を繰り返さず残りを続けてください。\n` : '') + taskPrompt(p, t, file, dir, 'terminal', { ai, model: spec.model }) + `\n[Hub terminal: ${limitMarker}]`;
    const argv = launch.buildArgv({ ai, prompt, cmd: permCmd(ai), model: spec.model, effort: spec.effort, account, fast: codexFastFor(p.id, t.id) });
    if (DRY) return send(res, 200, { ok: true, dry: true, ai, dir, model: spec.model, effort: spec.effort, account, ...argv, accountEnv: account === 'default' ? {} : { [ai === 'grok' ? 'GROK_HOME' : ai === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']: accounts.get(ai, account).dir } });
    try {
      const started = !(cur && !cur.exited);
      const session = sessions.start({ project: p.id, task: t.id, ai, ...gitSnapshot(dir), dir, account, model: spec.model, effort: spec.effort, role: t.role, limitSlot: o.limitSlot, prompt, limitMarker, command: argv.command, args: argv.args, cols: b.cols, rows: b.rows });
      if (pending && started) { session.original = pending.original; saveTerminalPending(p, t, { ...pending, pending: false }); }
      record('start', { ...b, ai }, { model: spec.model, effort: spec.effort, dir });
      return send(res, 200, { ok: true, ai, dir, note: [switchNote, note].filter(Boolean).join('。'), model: session.model, effort: session.effort, running: !session.exited });
    } catch (e) {
      return send(res, e.status || 500, { error: String(e.message || e) });
    }
  }

  // 交代する：前の AI の会話を「引き継ぎ資料」にまとめ、相手の AI に読ませて続けさせる
  // 相手が動いていなければ、役割どおりのモデル・思考で始める。相手が作業中なら断る（勝手に割り込まない）
  if (url.pathname === '/api/term/handoff') {
    const p = store.readProject(b.project);
    const file = store.taskFile(b.project, b.task);
    if (!p || !file || !launch.AIS.includes(b.to)) return send(res, 400, { error: lt('作業が見つかりません') });
    const t = store.readTask(file);
    const from = b.from || (b.to === 'claude' ? 'codex' : b.to === 'codex' ? 'claude' : '');
    if (!launch.AIS.includes(from) || from === b.to) return send(res, 400, { error: lt('交代元を指定してください') });
    const LABEL = launch.AI_LABEL;
    let spec = pickSpec(t, b.to), account = requestAccount(p, t.id, b.to, b.account);
    if (b.to === 'agy' && typeof b.model === 'string') spec.model = launch.modelLabel(b.to, b.model);
    let target = { project: p.id, task: t.id, ai: b.to, ...spec, role: t.role, account };
    target = { ...target, ...limitIdentity(rolesData(), target) };
    await refreshLimitEvidence(target);
    const alternate = limitEvidence.forRequest(target) && limitBackup(target);
    if (limitEvidence.forRequest(target) && modelView.special().enabled) return send(res, 409, { error: lt('特殊モードのAIが上限中です。解除後に再開してください') });
    if (alternate) {
      await refreshLimitEvidence(alternate);
      if (limitEvidence.forRequest(alternate)) return send(res, 409, { error: lt('両方の担当が上限中です。解除後に再開してください') });
      // 元AIに戻すことで稼働中の同じ作業へ割り込まない。
      if (alternate.ai === from) return send(res, 409, { error: lt('交代先が上限中です。元AIからの交代は行いません') });
      b.to = alternate.ai; target = { ...target, ...alternate }; spec = target; account = target.account;
    }
    const tgt = sessions.get(b.project, b.task, b.to);
    const tgtLive = tgt && !tgt.exited;
    if (tgtLive && (tgt.account || 'default') !== account) return send(res, 409, { error: lt('交代先は別のアカウントで作業中です') });
    if (!tgtLive) {
      const invalidModel = modelError(b.to, spec.model);
      if (invalidModel) return send(res, 409, { error: invalidModel });
    }
    if (tgtLive && Date.now() - tgt.lastOut < 20000) return send(res, 409, { error: lt`${LABEL[b.to]} が作業中です。止まってから（入力待ちになってから）交代してください` });
    const src = sessions.get(b.project, b.task, from);
    const { dir } = tgtLive ? { dir: tgt.dir } : startDir(p, t);
    const convo = transcript.collect({ ai: from, dir: (src && src.dir) || dir, since: src ? src.started : Date.now() - 3 * 86400000, buf: src && src.buf, accountDir: accounts.location(from, src?.account || accountFor(p.id, t.id, from)) });
    const board = path.join(p.dir, '.ai', 'board.md');
    const note = b.note ? String(b.note).replace(/[\r\n]+/g, ' ').slice(0, 300) : '';
    const hdir = path.join(p.dir, '.ai', 'handoff');
    fs.mkdirSync(hdir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const packetFile = path.join(hdir, `${t.id}-${stamp}-${from}.md`);
    fs.writeFileSync(packetFile, transcript.packet({ fromLabel: LABEL[from], toLabel: LABEL[b.to], taskFile: file, board, convo, extra: note }));
    const msg = lt`${LABEL[from]} から交代です。引き継ぎ資料 ${packetFile} を読み、${file} と ${board} も確かめてから、あなたの役割で続けてください。`;
    let started = false;
    if (tgtLive) {
      sessions.type(b.project, b.task, b.to, msg);
    } else {
      const limitMarker = crypto.randomUUID(), prompt = msg + ' ' + taskPrompt(p, t, file, dir, 'terminal', { ai: b.to, model: spec.model }) + `\n[Hub terminal: ${limitMarker}]`;
      const argv = launch.buildArgv({ ai: b.to, prompt, cmd: permCmd(b.to), model: spec.model, effort: spec.effort, account, fast: codexFastFor(p.id, t.id) });
      if (DRY) return send(res, 200, { ok: true, dry: true, ai: b.to, packet: packetFile, kind: convo.kind, ...argv });
      try { sessions.start({ project: b.project, task: b.task, ai: b.to, dir, account, model: spec.model, effort: spec.effort, role: t.role, limitSlot: target.limitSlot, prompt, limitMarker, ...gitSnapshot(dir), command: argv.command, args: argv.args, cols: b.cols, rows: b.rows }); started = true; }
      catch (e) { return send(res, 500, { error: String(e.message || e), packet: packetFile }); }
    }
    store.updateTask(p.id, t.id, { owner: launch.AI_KEY[b.to], memo: lt`${LABEL[from]} から ${LABEL[b.to]} へ交代（引き継ぎ資料: ${packetFile}）` });
    record('handoff', b, { packet: packetFile, kind: convo.kind, started });
    return send(res, 200, { ok: true, ai: b.to, packet: packetFile, kind: convo.kind, started, ...(tgtLive ? {} : { model: spec.model, effort: spec.effort }) });
  }
  // 動いている AI のモデル・思考を変える：作業ファイルに残し、その AI に /model・/effort を打つ
  if (url.pathname === '/api/term/switch') {
    if (b.ai === 'agy' && (b.field === 'effort' || sessions.get(b.project, b.task, b.ai) && !sessions.get(b.project, b.task, b.ai).exited)) return send(res, 409, { error: lt('Agy のモデル変更は次の起動から使います。動いているAgyの終了後に選んでください') });
    if (!launch.AIS.includes(b.ai) || !['model', 'effort'].includes(b.field)) return send(res, 400, { error: lt('指定が正しくありません') });
    if (b.ai === 'grok' && b.field === 'effort' && b.value && !launch.EFFORT_FLAG.grok[b.value]) return send(res, 400, { error: lt('Grok の思考は 中・高・極高・MAX です') });
    if (b.field === 'model') {
      const invalidModel = modelError(b.ai, String(b.value || ''));
      if (invalidModel) return send(res, 409, { error: invalidModel });
    }
    const t = store.updateTask(b.project, b.task, { [b.field]: typeof b.value === 'string' ? b.value : '' });
    if (!t) return send(res, 400, { error: lt('作業が見つかりません') });
    const spec = pickSpec(t, b.ai);
    const cmd = launch.switchCommand(b.ai, b.field, spec[b.field]);
    const sent = Boolean(cmd) && sessions.type(b.project, b.task, b.ai, cmd);
    const session = sessions.get(b.project, b.task, b.ai); if (sent && session) { session[b.field] = spec[b.field]; if (b.field === 'model') session.limitSlot = limitIdentity(rolesData(), { ai: b.ai, model: session.model, role: session.role })?.limitSlot; }
    record('switch', b, { [b.field]: spec[b.field], sent });
    return send(res, 200, { ok: true, sent, command: cmd, ...spec });
  }
  if (url.pathname === '/api/term/input') {
    return send(res, sessions.write(b.project, b.task, b.ai, String(b.data || '')) ? 200 : 404, { ok: true });
  }
  if (url.pathname === '/api/term/resize') {
    return send(res, sessions.resize(b.project, b.task, b.ai, b.cols, b.rows) ? 200 : 404, { ok: true });
  }


  // 別の窓で開く（作業画面の部品が無い時の代わり）
  if (url.pathname === '/api/continue') {
    licenseGuard(b,'start');
    const p = store.readProject(b.project);
    const file = store.taskFile(b.project, b.task);
    if (!p || !file || !launch.AIS.includes(b.ai)) return send(res, 400, { error: lt('作業が見つかりません') });
    const t = store.readTask(file);
    const spec = pickSpec(t, b.ai);
    if (b.ai === 'agy' && typeof b.model === 'string') spec.model = launch.modelLabel(b.ai, b.model);
    const account = requestAccount(p, t.id, b.ai, b.account);
    const invalidModel = modelError(b.ai, spec.model);
    if (invalidModel) return send(res, 409, { error: invalidModel });
    const { dir } = startDir(p, t);
    const command = launch.buildCommand({ ai: b.ai, dir, prompt: taskPrompt(p, t, file, dir, 'terminal', { ai: b.ai, model: spec.model }), cmd: permCmd(b.ai), ...spec, account, fast: codexFastFor(p.id, t.id) });
    const terminal = accounts.terminalCommand(b.ai, account, command, launch.sq);
    let r; try { r = await launch.openTerminal(terminal.command, DRY); } catch (e) { terminal.cancel(); throw e; }
    return send(res, 200, { ok: true, dir, ...(DRY ? { command, r } : {}) });
  }

  // フォルダを Finder で開く（台帳に書かれた場所だけ）
  if (url.pathname === '/api/open') {
    const p = store.readProject(b.project);
    if (!p) return send(res, 400, { error: lt('プロジェクトが見つかりません') });
    let target = null;
    if (b.kind === 'project') target = p.dir;
    else if (b.kind === 'folder') target = (p.folders.find(f => f.label === b.label) || {}).path;
    else if (b.kind === 'workdir') { const f = store.taskFile(b.project, b.task); target = f && store.readTask(f).workdir; }
    target = expandHome(target || '');
    if (!target || !fs.existsSync(target)) return send(res, 404, { error: lt('その場所が見つかりません'), path: target });
    if (denied(target)) return send(res, 403, { error: denied(target), path: target });
    const r = await launch.openFolder(target, DRY);
    return send(res, 200, { ok: true, path: target, ...(DRY ? { r } : {}) });
  }

  // 文の中のファイル・フォルダを Finder で開く（作業の場所からの相対でもよい。ホームの中だけ）
  if (url.pathname === '/api/reveal') {
    const { target, home } = resolvePlace(b);
    const isDir = fs.statSync(target).isDirectory();
    // info＝開かず種類と場所を返す／list＝フォルダの中身／open＝元ファイルを既定アプリで開く／finder＝Finderで表示
    const how = ['info', 'list', 'open'].includes(b.how) ? b.how : 'finder';
    if (how === 'info') {
      const info = viewInfo(target), view = info.status === 200;
      return send(res, 200, { ok: true, path: target, dir: isDir, how, view, viewKind: view ? info.kind : '', remote: fromRemote() });
    }
    if (how === 'list' && isDir) {
      let entries = [];
      try {
        entries = fs.readdirSync(target, { withFileTypes: true }).filter(d => !d.name.startsWith('.')).slice(0, 500)
          .map(d => { const full = path.join(target, d.name); let st = null; try { st = fs.statSync(full); } catch (e) { /* 読めない物 */ } return { name: d.name, path: full, dir: st ? st.isDirectory() : d.isDirectory(), size: st ? st.size : 0, mtime: st ? st.mtimeMs : 0 }; })
          .sort((x, y) => (x.dir === y.dir ? x.name.localeCompare(y.name, 'ja') : x.dir ? -1 : 1));
      } catch (e) { return send(res, 403, { error: denied(target) || String(e.message) }); }
      const up = path.dirname(target);
      return send(res, 200, { ok: true, path: target, dir: true, entries, parent: home.some(h => up === h || up.startsWith(h + path.sep)) ? up : '' });
    }
    record('reveal', { project: b.project, task: b.task }, { path: target, dir: isDir, how, app: Boolean(b.app) });
    const act = how === 'list' ? 'open' : how; // ファイルに list が来たら開く
    // アプリの中では、アプリ自身が開く（許可がアプリに付いているため）。ブラウザの時は本体が open で開く
    if (b.app) return send(res, 200, { ok: true, path: target, dir: isDir, byApp: true, how: act });
    const r = act === 'open' || isDir ? await launch.openFolder(target, DRY) : await launch.revealFile(target, DRY);
    return send(res, 200, { ok: true, path: target, dir: isDir, how: act, ...(DRY ? { r } : {}) });
  }
  // URL を既定のブラウザで開く（http・https だけ）
  if (url.pathname === '/api/open-url') {
    const u = String(b.url || '');
    if (!/^https?:\/\/[^\s]+$/.test(u)) return send(res, 400, { error: lt('開けない URL です') });
    const r = await launch.openUrl(u, DRY);
    return send(res, 200, { ok: true, ...(DRY ? { r } : {}) });
  }

  // 作業の状態・質問・メモ・モデル・思考
  // 作業用コピーの古い記録を片付ける（場所が無い時だけ。取り込み済みの後に AI が書き戻した時など）
  if (url.pathname === '/api/task/copyclear') {
    const p = store.readProject(b.project), file = p && store.taskFile(b.project, b.task), t = file && store.readTask(file);
    if (!t) return send(res, 400, { error: lt('作業が見つかりません') });
    if (!copyMissing(p, t)) return send(res, 409, { error: lt('作業用コピーはまだあります（片付けるのは、場所が無い時だけ）') });
    const m = lastMerge(p.id, t.id);
    const done = store.updateTask(p.id, t.id, { workdir: '', memo: m ? lt('本体に取り込み済み。作業用コピーの古い記録を片付けた') : lt('作業用コピーの古い記録を片付けた') });
    record('copyclear', b, { merged: Boolean(m) });
    return send(res, 200, { ok: true, merged: Boolean(m), task: done });
  }
  if (url.pathname === '/api/task') {
    if (fromRemote()) record('task', b, { state: b.state, question: b.question !== undefined, memo: b.memo !== undefined });
    if (b.state === '完了') return send(res, 409, { error: lt('［完了に移す］で内容を確認してから完了にしてください') });
    const str = k => (typeof b[k] === 'string' ? b[k] : undefined);
    let context = {};
    if (['kind','derivedFrom','parent','workspaceMode'].some(k => b[k] !== undefined)) {
      try {
        const p=store.readProject(b.project), file=store.taskFile(b.project,b.task), t=file && store.readTask(file);
        if (!p || !t) throw Error(lt('作業がありません'));
        context=require('./lib/work-context').validateTask(p,t,b,store.listProjects());
        if (b.workspaceMode !== undefined && b.workspaceMode !== t.workspaceMode && (t.workspaceStarted || t.state !== '未着手' || t.workdir || chats.busy(p.id,t.id) || sessions.list().some(s=>s.project===p.id && s.task===t.id && s.running))) throw Error(lt('場所は作業開始前に選んでください。既存コピーは自動で移しません'));
      } catch(e) { return send(res,409,{error:e.message}); }
    }
    const t = store.updateTask(b.project, b.task, {
      state: str('state'), question: str('question'), owner: str('owner'), role: str('role'),
      ...context, model: str('model'), effort: str('effort'), parent: str('parent'), phase: str('phase'), via: str('via'), memo: b.memo,
    });
    return t ? send(res, 200, t) : send(res, 400, { error: lt('作業が見つかりません') });
  }
  if (url.pathname === '/api/task/completion') {
    if (b.confirm !== true) return send(res, 400, { error: lt('完了に移すか確認してください') });
    if (b.action === 'approve' && (discussion.active(b.project,b.task) || webchatActive(b.project,b.task) || chats.running.has(`${b.project}\u0000${b.task}`) || launch.AIS.some(a => { const s = sessions.get(b.project, b.task, a); return s && !s.exited; }))) return send(res, 409, { error: lt('AIが作業中です。終わってから完了を確認してください') });
    if(b.action==='approve') {
      const {all,p,t}=resultsGate.current(b.project,b.task);
      if(t && t.completionHash!==b.expectedHash)return send(res,409,{error:lt('確認中に作業が更新されました')});
      if(t) { const issue=resultsGate.approvalIssue(p,t,all); if(!issue.ok)return send(res,409,{error:lt('成果の記録が整っていません：')+issue.reason}); }
    }
    const t = store.decideTask(b.project, b.task, b.action, b.expectedHash);
    if (t?.error) return send(res, t.status, { error: t.error });
    if (t) record(b.action === 'approve' ? 'taskdone' : 'taskreopen', b);
    if (t && b.action === 'approve') { const p = store.readProject(b.project); if (p) reportChild(p, lt('作業の完了'), [t.title, handoff.lastEntry(t.done)].filter(Boolean).join('\n')); }
    return t ? send(res, 200, t) : send(res, 400, { error: lt('作業が見つかりません') });
  }
  // 手順に印を付ける・外す
  if (url.pathname === '/api/task/step') {
    const t = typeof b.add === 'string' ? store.addStep(b.project, b.task, b.add) : store.setStep(b.project, b.task, Number(b.index), Boolean(b.done));
    if(t) {
      try { await resultsGate.trigger(b.project,b.task); } catch(e) {record('results-organize-error',b,{error:e.message});}
      const {all,p,t:current}=resultsGate.current(b.project,b.task);
      return send(res,200,resultsGate.decorate(p,current,all));
    }
    return send(res,400,{error:lt('その手順が見つかりません')});
  }
  if (url.pathname === '/api/phase/continue') {
    const current = store.readProject(b.project);
    if (!current || current.completionHash !== b.expectedHash) return send(res, 409, { error: lt('確認中にフェーズが更新されました') });
    const p = store.continuePhase(b.project); return send(res, 200, p);
  }
  // プロジェクトを完了にする・戻す（人がはっきり押した時だけ）
  if (url.pathname === '/api/project/status') {
    if (b.status === '完了' && b.confirm !== true) return send(res, 400, { error: lt('完了に移すか確認してください') });
    const current = store.readProject(b.project);
    if ((b.status === '完了' || b.expectedHash) && current?.completionHash !== b.expectedHash) return send(res, 409, { error: lt('確認中にプロジェクトが更新されました') });
    if (!['完了', '進行中'].includes(b.status)) return send(res, 400, { error: lt('形式が違います') });
    if (b.status === '完了') {
    if (sessions.list().some(x => x.project === b.project && x.running) || [...chats.running.keys()].some(k => k.startsWith(b.project + '\u0000'))) return send(res, 409, { error: lt('このプロジェクトでAIが作業中です。終わってから完了を確認してください') });
    }
    const p = store.setProjectStatus(b.project, b.status);
    if (p) record(b.status === '完了' ? 'projectdone' : 'projectreopen', { project: b.project });
    if (p && b.status === '完了' && p.status === '完了') reportChild(p, '完了', handoff.completionText(p));
    return p ? send(res, 200, { ok: true, status: p.status }) : send(res, 400, { error: lt('プロジェクトが見つかりません') });
  }
  // 親に結果を渡す（人がはっきり押した時）。文が無ければ一番新しい作業の「やったこと」の最後
  if (url.pathname === '/api/project/handoff') {
    const p = store.readProject(b.project);
    if (!p) return send(res, 400, { error: lt('プロジェクトが見つかりません') });
    const t = handoff.newestTask(p);
    const text = (typeof b.text === 'string' && b.text.trim()) || (t ? handoff.lastEntry(t.done) : '');
    if (!text) return send(res, 400, { error: lt('渡す内容がありません。文を書くか、作業の「やったこと」を書いてください') });
    if (text.length > 4000) return send(res, 400, { error: lt('渡す文は4000文字までです') });
    const r = reportChild(p, lt('報告'), text);
    if (!r) return send(res, 400, { error: lt('親プロジェクトが見つかりません') });
    return send(res, 200, { ok: true, parent: r.parent, task: r.task, duplicate: r.duplicate });
  }
  // 次のフェーズへ進む（今のフェーズを完了に）
  if (url.pathname === '/api/phase/next') {
    if (b.confirm !== true) return send(res, 400, { error: lt('今のフェーズを完了に移すか確認してください') });
    const current = store.readProject(b.project);
    if (!current || b.expectedHash !== current.completionHash) return send(res, 409, { error: lt('確認中にフェーズが更新されました。内容を読み直してください') });
    if (sessions.list().some(x => x.project === b.project && x.running) || [...chats.running.keys()].some(k => k.startsWith(b.project + '\u0000'))) return send(res, 409, { error: lt('このプロジェクトでAIが作業中です。終わってから完了を確認してください') });
    const p = store.nextPhase(b.project);
    if (p) record('nextphase', b);
    return p ? send(res, 200, { ok: true, phases: p.phases }) : send(res, 400, { error: lt('プロジェクトが見つかりません') });
  }
  // コピーと再開先は保持したまま、取り込み対象から外す・戻す
  if (url.pathname === '/api/task/merge-exclusion') {
    if (typeof b.excluded !== 'boolean') return send(res, 400, { error: lt('除外するかどうかを指定してください') });
    const p = store.readProject(b.project);
    const file = p && store.taskFile(p.id, b.task);
    if (!file) return send(res, 400, { error: lt('作業が見つかりません') });
    const t = store.readTask(file);
    if (!inWork(p, t)) return send(res, 400, { error: lt('この作業には作業用コピーがありません') });
    if (t.mergeExcluded === b.excluded) return send(res, 200, { ok: true, task: t });
    const updated = store.updateTask(p.id, t.id, {
      mergeExcluded: b.excluded,
      memo: b.excluded ? lt('取り込み対象から外しました（作業用コピーと再開先は保持）') : lt('取り込み対象に戻しました'),
    });
    record(b.excluded ? 'mergeexclude' : 'mergeinclude', b);
    return send(res, 200, { ok: true, task: updated });
  }
  // 作業用コピーを本体に取り込んで片付ける
  if (url.pathname === '/api/task/merge/status') {
    try {
      const p=store.readProject(b.project),t=p?.tasks.find(t=>t.id===b.task);
      if(!t||!inWork(p,t)||copyMissing(p,t))return send(res,200,{state:'unknown'});
      const sourceDir=expandHome(t.workdir),targetDir=gitw.mainOf(sourceDir),scope={project:b.project,task:b.task,sourceDir,targetDir};
      if(b.flow===true)return send(res,200,mainMergeFlow.status(scope,b.requestId));
      return send(res,200,b.requestId!==undefined?mainMergeDelivery.status({...scope,id:b.requestId}):b.legacy===true?mainMergeDelivery.legacy({...scope,abortAt:b.abortAt,confirm:b.confirm,sourceHead:b.sourceHead,targetHead:b.targetHead}):{state:'unknown'});
    }catch{return send(res,200,{state:'unknown'});}
  }
  if (url.pathname === '/api/task/merge/preview') {
    const check=require('./lib/main-merge-check');
    try {
      const p=store.readProject(b.project),file=p&&store.taskFile(b.project,b.task);
      if(!p||!file)return send(res,409,{error:lt('作業が見つかりません'),delivery:{state:'not-sent'}});
      const t=store.readTask(file);
      if(!inWork(p,t)||copyMissing(p,t))return send(res,409,{error:lt('作業用コピーが見つかりません'),delivery:{state:'not-sent'}});
      const sourceDir=expandHome(t.workdir),mergeTarget=gitw.mainOf(sourceDir);
      if(mainMergeDelivery.unresolved({project:b.project,task:b.task,sourceDir,targetDir:mergeTarget}))return send(res,409,{error:lt('取り込みの結果が未確認です。再送せず、送信番号の結果を照合してください'),delivery:{state:'unknown'}});
      const sc=check.check(gitw,sourceDir,'source'),tc=check.check(gitw,mergeTarget,'target');
      if(sc.blocker||tc.blocker)return send(res,409,check.refusal(sc.blocker||tc.blocker));
      const source=sc.snapshot,main=tc.snapshot;
      const preview=gitw.preview({targetGuard:dir=>require('./lib/integration-writes').inspect(gitw,dir),dir:sourceDir,workRoot:workRoot(p),target:mergeTarget});
      if(!preview)return send(res,409,check.refusal({side:'target',kind:'unreadable',paths:[],reason:lt('取り込む範囲を読み取れません'),next:lt('本体と作業用コピーのGit履歴を確認してから、最新の記録を確認してください')}));
      const token=crypto.randomUUID();
      for(const [id,v]of mainMergeTokens)if(Date.now()-v.at>600000)mainMergeTokens.delete(id);
      const switchPlan=mainMergeFlow.approval({sourceDir,targetDir:mergeTarget,source,target:main});
      mainMergeTokens.set(token,{at:Date.now(),project:b.project,task:b.task,source,target:main,targetDir:mergeTarget,...switchPlan});
      const waiting=integrationBlockers(b,{op:'main-merge'});
      return send(res,200,{waiting,token,sourceHead:source.head,targetHead:main.head,target:mergeTarget,files:preview.files,noChanges:preview.noChanges,...switchPlan,residual:t.steps.filter(s=>!s.done).map(s=>s.text).concat(t.question||[]).join('\n'),cleanupBlocked:Boolean(t.continuation||t.question||t.steps.some(s=>!s.done)||store.listProjects().some(q=>q.tasks.some(x=>require('./public/project-order').ancestorsOf(q,x,store.listProjects()).some(a=>a.project.id===p.id&&a.task.id===t.id))))});
    } catch {return send(res,409,check.refusal({side:'target',kind:'unreadable',paths:[],reason:lt('本体と作業用コピーの保存状態を読み取れません'),next:lt('Gitと読取権限を確認してから、最新の記録を確認してください')}));}
  }
  if (url.pathname === '/api/task/merge') {
    let deliveryScope;
    if(b.oneclick===true&&b.token===undefined)return send(res,409,{error:lt('表示した取り込み範囲を確認できません'),delivery:{state:'not-sent'}});
    if(b.token!==undefined){
      try{if(mainMergeDelivery.read(b.token))return send(res,409,{error:lt('この取り込みは送信済みです。結果を照合してください'),delivery:{state:'unknown'}});}catch{return send(res,409,{error:lt('取り込みの送信記録を読み取れません'),delivery:{state:'unknown'}});}
      const v=mainMergeTokens.get(b.token);mainMergeTokens.delete(b.token);
      const p=store.readProject(b.project),t=p?.tasks.find(t=>t.id===b.task);
      const changed=()=>send(res,409,{error:lt('本体または保存済みHEADが変わりました。最新の記録を確認してください'),delivery:{state:'not-sent'}});
      if(!v||Date.now()-v.at>600000||v.project!==b.project||v.task!==b.task||!t||gitw.mainOf(expandHome(t.workdir))!==v.targetDir)return changed();
      const check=require('./lib/main-merge-check'),sc=check.check(gitw,expandHome(t.workdir),'source'),tc=check.check(gitw,v.targetDir,'target');
      if(sc.blocker||tc.blocker)return send(res,409,check.refusal(sc.blocker||tc.blocker));
      if(JSON.stringify(sc.snapshot)!==JSON.stringify(v.source)||JSON.stringify(tc.snapshot)!==JSON.stringify(v.target))return changed();
      b.disposition='continue';b.confirm=true;b.sourceHead=v.source.head;b.targetHead=v.target.head;
      deliveryScope={project:b.project,task:b.task,sourceDir:expandHome(t.workdir),targetDir:v.targetDir,source:v.source,target:v.target};
      if(b.oneclick===true){
        const prior=mainMergeDelivery.flows(deliveryScope).find(r=>JSON.stringify(r.source)===JSON.stringify(v.source)&&JSON.stringify(r.target)===JSON.stringify(v.target));
        if(prior){
          try{mainMergeDelivery.link(b.token,deliveryScope,prior.id);}catch{return send(res,409,{error:lt('取り込みの送信番号を保存できません。結果を照合してください'),delivery:{state:'unknown'}});}
          return send(res,200,{ok:true,main:v.targetDir,retained:true,requestId:b.token,flow:mainMergeFlow.status(deliveryScope,b.token)});
        }
        deliveryScope.flow={keep:true,restart:v.switchHub,version:v.switchVersion,instance:HUB_INSTANCE,stage:'approved'};
      }
    }
    const p = store.readProject(b.project);
    const file = store.taskFile(b.project, b.task);
    if (!p || !file) return send(res, 400, { error: lt('作業が見つかりません') });
    const t = store.readTask(file);
    if(require('./public/project-order').integrators(p,t,store.listProjects()).length) return send(res,409,{error:lt('親作業の［統合…］で取り込みます。子作業では［成果を渡す］を行ってください')});
    if (!inWork(p, t)) return send(res, 400, { error: lt('この作業には作業用コピーがありません') });
    if (copyMissing(p, t)) {
      if(res.integrationMain)return send(res,409,{error:lt('本体取り込みの対象が変わりました')});
      const m = lastMerge(p.id, t.id);
      const when = m ? new Date(m.at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      const note = m ? lt`この作業は ${when} に本体へ取り込み済みです（作業用コピーはゴミ箱へ移してあります）。` : lt('作業用コピーの場所が見つかりません（消えたか、別の場所に移っています）。');
      store.updateTask(p.id, t.id, { workdir: '', memo: lt`${note} 作業ファイルの古い記録を片付けました` });
      record('mergeskip', b, { merged: Boolean(m) });
      return send(res, 409, { error: lt`${note} 変更は本体に入っています。作業ファイルの古い記録を片付けたので、続きは本体でそのまま始められます` });
    }
    if (t.mergeExcluded) return send(res, 409, { error: lt('取り込み対象から外されています。先に［取り込み対象に戻す］を選んでください') });
    const waiting=integrationBlockers(b,{op:'main-merge'});
    if(waiting.length)return send(res,409,{error:waiting.map(x=>x.message).join('、'),waiting,delivery:{state:'not-sent'}});
    const mergeTarget = gitw.mainOf(expandHome(t.workdir));
    if(mainMergeDelivery.unresolved({project:b.project,task:b.task,sourceDir:expandHome(t.workdir),targetDir:mergeTarget}))return send(res,409,{error:lt('取り込みの結果が未確認です。再送せず、送信番号の結果を照合してください'),delivery:{state:'unknown'}});
    let r;
    try {
      const disposition=b.disposition===undefined?'cleanup':b.disposition;
      if(!['continue','cleanup'].includes(disposition))throw Error(lt('取り込み後の扱いを確認してください'));
      if(disposition==='cleanup'&&(t.continuation||t.question||t.steps.some(s=>!s.done)||store.listProjects().some(q=>q.tasks.some(x=>require('./public/project-order').ancestorsOf(q,x,store.listProjects()).some(a=>a.project.id===p.id&&a.task.id===t.id)))))throw Error(lt('残件または継続中の作業です。取り込んで続けてください'));
      if(b.disposition!==undefined){
        const check=require('./lib/main-merge-check'),sc=check.check(gitw,expandHome(t.workdir),'source'),tc=check.check(gitw,mergeTarget,'target');
        if(sc.blocker||tc.blocker)return send(res,409,check.refusal(sc.blocker||tc.blocker));
      }
      if(b.disposition!==undefined&&(b.confirm!==true||b.targetHead!==(gitw.inspect(mergeTarget)?.head||null)))throw Error(lt('本体が変わりました。取り込む範囲を確認し直してください'));
      if(b.disposition!==undefined){const source=gitw.inspect(expandHome(t.workdir));if(!source||source.status||gitw.merging(expandHome(t.workdir))||b.sourceHead!==source.head||b.confirm!==true)throw Error(lt('保存済みHEADと取り込む範囲を確認してください'));}
      const preview=gitw.preview({targetGuard:dir=>require('./lib/integration-writes').inspect(gitw,dir),dir:expandHome(t.workdir),workRoot:workRoot(p),target:mergeTarget});
      const lock=preview?.noChanges?[]:gitw.mergeLocks(mergeTarget);if(lock.length)return send(res,409,{error:'Gitの保存処理が進行中です：'+lock.join('、'),delivery:{state:'not-sent'},paths:lock});
      if(deliveryScope)try{mainMergeDelivery.start(b.token,deliveryScope);}catch{return send(res,409,{error:lt('取り込みの送信記録を保存できません'),delivery:{state:'not-sent'}});}
      if(!preview?.noChanges)res.integrationMain?.begin();
      r = preview?.noChanges?{ok:true,noChanges:true,main:mergeTarget,commit:gitw.savedHead(mergeTarget),files:[]}:gitw.merge({ targetGuard:dir=>require('./lib/integration-safety').assertTarget(taskIntegrate,{target:dir,p}),dir: expandHome(t.workdir), workRoot: workRoot(p), title: `${t.id} ${t.title}`, cleanup:disposition==='cleanup' });
    }
    catch (e) { r = { ok: false, error: String(e.message || e).split('\n')[0] }; }
    if(deliveryScope)try{mainMergeDelivery.finish(b.token,{state:r.ok?'applied':['aborted','not-sent'].includes(r.delivery?.state)?r.delivery.state:'unknown',...(r.ok?{commit:r.commit}:{})});}catch{r.delivery={state:'unknown'};}
    // A no-op receipt preserves the task and operation log exactly.
    if(r.ok&&r.noChanges)return send(res,200,{ok:true,noChanges:true,main:r.main,retained:true,task:t,...(deliveryScope?.flow?{requestId:b.token,flow:mainMergeFlow.status(deliveryScope,b.token)}:{})});
    record('merge', b, { ok: Boolean(r.ok), conflict: Boolean(r.conflict), ...(b.token?{requestId:b.token,sourceHead:b.sourceHead,targetHead:b.targetHead}:{}), ...(r.delivery?{delivery:r.delivery}:{}), ...(r.ok ? {main:r.main,commit:r.commit,files:r.files} : {}) });
    if (r.conflict) {
      store.updateTask(p.id, t.id, { state: '返事待ち', question: lt('本体に取り込む時にぶつかりました。AI を始めて「本体の最新を取り込み、ぶつかった所を直して」と頼んでから、もう一度［本体に取り込む］を押してください') });
      return send(res, 409, { error: r.error, conflict: true,...(r.delivery?{delivery:r.delivery}:{}) });
    }
    if (!r.ok) return send(res, r.delivery ? 409 : 400, { error: r.error,...(r.delivery?{delivery:r.delivery}:{}) });
    if(b.disposition==='continue'||r.noChanges){
      const kept=store.updateTask(p.id,t.id,{continuation:true,memo:lt`本体に取り込み、同じ作業とコピーを保持しました（${r.main}）`});
      return send(res,200,{ok:true,main:r.main,retained:true,task:kept,...(r.noChanges?{noChanges:true}:{}),...(deliveryScope?.flow?{requestId:b.token,flow:mainMergeFlow.status(deliveryScope,b.token)}:{})});
    }
    for (const a of launch.AIS) sessions.stop(b.project, b.task, a);
    const done = store.updateTask(p.id, t.id, { workdir: '', state: '完了', question: '', memo: lt`本体に取り込み、作業用コピーをゴミ箱へ移しました（${r.main}）` });
    try { store.appendSection(p.id, t.id, 'やったこと', lt`- ${new Date().toISOString().slice(0, 16).replace('T', ' ')} 本体に取り込み済み（${r.main}）。作業用コピーはゴミ箱へ。workdir は空のままにすること`); } catch (e) { /* 無くてもよい */ }
    return send(res, 200, { ok: true, main: r.main, trashed: r.trashed, task: done });
  }
  // 成果ファイルを選び、保存と受領通知の後に子作業・派生を片付ける。
  if (url.pathname === '/api/task/handup/preview') {
    try { return send(res, 200, taskTransfer.offerPreview(b.project, b.task, b.paths || [], b.expectTitle)); }
    catch (e) { return send(res, 409, {error:e.message}); }
  }
  if (url.pathname === '/api/task/handup' || url.pathname === '/api/task/absorb' && taskTransfer.read(b.project,b.task)?.destination && !taskTransfer.read(b.project,b.task)?.integrating) {
    try {
      const r = url.pathname === '/api/task/handup' ? taskTransfer.offer(b) : taskTransfer.apply(b); if(!r.handedUp)setUnread(b.project,b.task,false);
      record('absorb', {project:r.parentProject,task:r.parent}, {child:b.task,childProject:b.project,files:r.files,receipt:r.record});
      return send(res,200,r);
    } catch(e) { return send(res,409,{error:e.message}); }
  }
  if(url.pathname === '/api/task/integrate/records/save'){
    try {const waiting=integrationBlockers(b,{op:'receipt'});if(waiting.length)throw Object.assign(Error(lt('保存先の処理が終了してからHub記録を保存してください')),{delivery:{state:'not-sent'}});const r=require('./lib/integration-record-save').save(taskIntegrate,b);record('integration-record-save',{project:b.project,task:b.task},{commit:r.commit,paths:r.paths});return send(res,200,r);} catch(e){integrationFailure(b,e,'records-save');return send(res,409,{error:e.message,delivery:e.delivery});}
  }
  if(url.pathname === '/api/task/integrate/abandon'){
    try{const out=b.preview===true?integrationAbandon.preview(b):integrationAbandon.apply(b);if(out.abandoned||out.recovered)record(out.recovered?'integrate-abandon-'+out.recovered:'integrate-abandon',b,{id:out.id,received:0,cleaned:0});return send(res,200,out);}catch(e){return send(res,e.delivery?500:409,{error:e.message,waiting:e.waiting,delivery:e.delivery||{state:'not-sent'}});}
  }
  if(url.pathname === '/api/task/integrate/keep'){
    try{return send(res,200,taskIntegrate.simple.saveKeep(b));}catch(e){integrationFailure(b,e,'keep');return send(res,409,{error:e.message});}
  }
  if(url.pathname === '/api/task/integrate/preview') {
    try{return send(res,200,integrateAuto.preview(b));}catch(e){integrationFailure(b,e,'preview');return send(res,409,{error:e.message});}
  }
  if(['/api/task/body/apply','/api/task/body/recover','/api/task/body/summary'].includes(url.pathname)){
    try{const out=url.pathname.endsWith('/recover')?textBudget.recover(b):url.pathname.endsWith('/summary')?textBudget.replaceSummary(b):textBudget.apply(b);record('text-body',b,{id:out.id});return send(res,200,out);}catch(e){return send(res,409,{error:e.message});}
  }
  if(url.pathname==='/api/project/notes/archive/preview'||url.pathname==='/api/project/notes/archive'){
    try{const out=url.pathname.endsWith('/preview')?projectNotes.preview(b.project,b.keepLines):projectNotes.apply(b);if(out.ok)record('project-notes-archive',b,{archive:out.archive});return send(res,200,out);}catch(e){return send(res,409,{error:e.message});}
  }
  if(url.pathname === '/api/task/integrate/resume') {
    try{const r=integrateAuto.resume(b);setImmediate(()=>{void integrateAuto.tick();});record('integrate-resume',b,{id:r.id,thenMain:false});return send(res,200,r);}catch(e){integrationFailure(b,e,url.pathname.endsWith('/resume')?'resume':'start');return send(res,409,{error:e.message,code:e.code,stage:e.stage||'refresh',waiting:e.waiting});}
  }
  if(['/api/task/integrate','/api/task/absorb'].includes(url.pathname)) {
    try { const r=integrateAuto.apply(b);if(b.auto) setImmediate(()=>{void integrateAuto.tick();}); record('integrate',b,{ok:r.ok,complete:r.complete,conflict:r.conflict});pruneUnread();return send(res,r.partial?200:r.conflict?409:200,r); }
    catch(e){integrationFailure(b,e,url.pathname.endsWith('/resume')?'resume':'start');return send(res,409,{error:e.message,code:e.code,stage:e.stage||'refresh',waiting:e.waiting});}
  }
  if (url.pathname === '/api/task/results/organize') {
    try { await resultsGate.trigger(b.project,b.task,{manual:true,expectedHash:b.expectedHash}); return send(res,200,{ok:true}); }
    catch(e) {return send(res,409,{error:e.message});}
  }
  if (url.pathname === '/api/task/integrate/results') {
    try {
      const request=taskIntegrate.resultsRequest(b),role=executionRoles().roles.find(r=>r.name==='調査');
      if(!role?.main.model || !['codex','claude-code','agy','grok'].includes(role.main.ai))throw Error(lt('設定の調査担当を確かめてください'));
      // この画面の明示操作だけ、完了した子へ成果整理を依頼できる。起動失敗時は完了状態を保持。
      return await delegateRequest({...request,role:role.name,ai:role.main.ai==='claude-code'?'claude':role.main.ai,model:role.main.model,effort:role.main.effort},res,{allowCompleted:true,resultsOrganize:true,resultsRecovery:b,beforeStart:()=>taskIntegrate.resultsRequest(b)});
    }catch(e){integrationFailure(b,e,'results');return send(res,409,{error:e.message});}
  }
  if (url.pathname === '/api/task/integrate/resolve') {
    try {
      const request=taskIntegrate.conflictRequest(b);
      const role=executionRoles().roles.find(r=>r.name==='コーディング');
      if(!role?.main.model || !['codex','claude-code','agy','grok'].includes(role.main.ai))throw Error(lt('設定のコーディング担当を確かめてください'));
      return await delegateRequest({...request,role:role.name,ai:role.main.ai==='claude-code'?'claude':role.main.ai,model:role.main.model,effort:role.main.effort},res,{beforeStart:()=>taskIntegrate.conflictRequest(b)});
    }catch(e){integrationFailure(b,e,'resolve');return send(res,409,{error:e.message});}
  }
  if (url.pathname === '/api/delegate') return delegateRequest(b,res);
  // 会話に「人の依頼」を残すだけ。ここではAIを動かさない。
  if (url.pathname === '/api/chat/note') {
    const p = store.readProject(b.project), file = p && store.taskFile(b.project, b.task);
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    if (!file || !text || text.length > 8000) return send(res, 400, { error: lt('作業と依頼を確かめてください') });
    if (p.kind === 'freetalk') freetalk.nameTopic(b.task, text);
    const row = chat.append(p.dir, b.task, { role: 'user', text, to: String(b.to || '').slice(0, 20) });
    chats.emit(p.id, b.task, { type: 'row', row });
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/chat/send') {
    const snapshot=reqCtx.getStore().stopSnapshot;
    let stopTicket={epoch:snapshot.epoch,task:snapshot.tasks[JSON.stringify([b.project,b.task])]?.epoch||0},manualResume=false;
    try{stopControl.assert(b,stopTicket);}catch(e){
      try{
        if(b.fromQueue||b.mode||b.automation||!b.manualStopTicket||b.manualStopTicket.epoch!==stopTicket.epoch||b.manualStopTicket.task!==stopTicket.task)throw e;
        stopControl.checkManual(b,stopTicket);manualResume=true;reqCtx.getStore().manualResume={project:b.project,task:b.task,ticket:stopTicket};
      }catch(refused){return send(res,409,{error:refused.message});}
    }
    const resumeManual=()=>{
      if(!manualResume)return;
      if(chats.busy(b.project,b.task)||sessions.list().some(s=>s.running&&s.project===b.project&&s.task===b.task)||webchatActive(b.project,b.task))throw Error('前のAIの終了・保存を確認してから送ってください');
      chats.assertHandoffReady(b.project,b.task);holdStoppedQueue(b.project,b.task);
      stopTicket=stopControl.resumeTask(b,stopTicket);manualResume=false;
      reqCtx.getStore().manualResume=null;
    };
    if(discussion.active(b.project,b.task))return send(res,409,{error:'話し合いが進行中です。停止または完了後に送ってください'});
    try { void license.prepare(); licenseGuard({ ...b, ...(b.fromQueue ? { mode: 'queued' } : {}) }, 'accept'); }
    catch (e) { return send(res, e.status || 403, { error: e.message, code: e.code, delivery: 'not-sent' }); }
    // 待っている指示を今すぐ始める（再起動の後など、作業中でない時）
    const fromQueue = b.fromQueue ? chats.queue(b.project, b.task).find(x => x.id === String(b.fromQueue)) : null;
    try{if(fromQueue)chats.assertQueueStart({project:b.project,task:b.task,request:fromQueue.id});}catch(e){return send(res,409,{error:e.message});}
    if (b.fromQueue && !fromQueue) return send(res, 404, { error: lt('その指示はもう待っていません') });
    const queueKey = chats.key(b.project, b.task);
    if (fromQueue && queueActions.has(queueKey)) return send(res, 409, { error: lt('待ち指示を送信中です。終わってから操作してください') });
    if (fromQueue && typeof b.expectedText === 'string' && b.expectedText !== fromQueue.text) return send(res, 409, { error: lt('待ち指示が変更されています。内容を確認してから操作してください') });
    if (fromQueue && b.expectedItem !== undefined && b.expectedItem !== JSON.stringify(fromQueue)) return send(res, 409, { error: lt('待ち指示が変更されています。内容を確認してから操作してください') });
    const amendQueue = Boolean(fromQueue && b.mode === 'amend');
    if (amendQueue && (!queueEditable(fromQueue) || !chats.busy(b.project, b.task) || chats.busy(b.project, b.task).pending)) return send(res, 409, { error: lt('今すぐ追加指示にできません。AIの作業中にもう一度操作してください') });
    if (fromQueue) queueActions.add(queueKey);
    try {
    if (fromQueue) Object.assign(b, { account: fromQueue.account || 'default', ai: fromQueue.ai, model: fromQueue.model, effort: fromQueue.effort, text: fromQueue.text, mode: amendQueue ? 'amend' : '' });
    if(fromQueue?.automation){
      try{if(b.mode)throw Error('台帳の依頼は台帳から変更してください');const r0=ideas.read(b.project).runs[fromQueue.automation.runId];const loc=ideaDispatch.location(b.project,r0);
        const o={...fromQueue,project:b.project,task:b.task,pdir:loc.pdir,dir:loc.dir,request:fromQueue.id,basePrompt:ideaDispatch.policy(r0),policy:ideaDispatch.policy(r0)};ideaDispatch.verify(o);
        const r=await chats.sendQueued(o);if(!(await r.started))throw Error('AIを起動できませんでした');chats.unqueue(b.project,b.task,fromQueue.id);return send(res,200,{ok:true,ai:r.ai,model:r.model,answeredQuestion:null});
      }catch(e){return send(res,409,{error:e.message});}
    }
    if(b.automation)return send(res,403,{error:'台帳の実行情報は一般の送信では受け付けません'});
    if (b.ai === 'dot') return send(res,410,{error:'Dot連携は廃止しました',delivery:'not-sent'});
    if (b.ai === 'chatgpt' && ['chat','app'].includes(b.model)) return send(res, 410, { error: lt('手動・アプリの経路は廃止しました。ChatGPT（Chat／Pro）を選び直してください') });
    if (b.ai === 'chatgpt' && !['auto'].includes(b.model)) return send(res, 409, { error: chat.CHATGPT_RETIRED });
    const p = store.readProject(b.project);
    const file = store.taskFile(b.project, b.task);
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    const sharing=p&&removalReview.read(p.id);
    if(sharing?.task===b.task){
      if(!fromQueue?.readOnly||sharing.status!=='running'||![sharing.id,'limit-'+sharing.id].includes(fromQueue.id))return send(res,409,{error:lt('共有確認は削除画面から操作してください')});
      try{
        const r=await chats.sendQueued({...fromQueue,project:p.id,task:b.task,pdir:p.dir,dir:p.dir,request:fromQueue.id,readOnly:true,
          basePrompt:lt('読み取り専用の共有確認です。ファイルを編集せず、判定のJSONだけを返してください。'),policy:lt('読み取り専用。JSONだけを返してください。')});
        if(!(await r.started))throw Error(lt('AIを起動できませんでした'));chats.unqueue(p.id,b.task,fromQueue.id);return send(res,200,{ok:true,ai:r.ai,model:r.model});
      }catch(e){return send(res,409,{error:e.message});}
    }

    if (!p || !file || ![...launch.AIS, 'chatgpt'].includes(b.ai)) return send(res, 400, { error: lt('作業が見つかりません') });
    if (!text) return send(res, 400, { error: lt('依頼を書いてください') });
    if (b.ai === 'chatgpt' && b.model === 'auto') {
      if (b.fromQueue || b.mode || b.images?.length) return send(res, 400, { error: lt('自動Chatへの依頼は本文だけを送ってください。画像は添付できません') });
      try {
        const t = store.readTask(file), answerQuestion = typeof b.answerQuestion === 'string' ? b.answerQuestion : t.question;
        webchat.availability(p,t);resumeManual();
        const r = webchat.submit(p, t, text,stopTicket);
        let answeredQuestion = null;
        // Acceptance has already been durably recorded. A metadata failure
        // must not report a rejected send and invite a duplicate request.
        if (p.kind !== 'freetalk') try {
          const current = store.readTask(file);
          if (current.question === answerQuestion) {
            if (current.question || current.state === '返事待ち') store.updateTask(p.id,t.id,{question:'',state:'実行中'});
            answeredQuestion = answerQuestion;
          }
        } catch(e) { record('webchat-metadata-error',{project:p.id,task:t.id},{error:e.message}); }
        return send(res, 200, { ...r, answeredQuestion });
      } catch(e) { return send(res, e.status || 409, { error: require('./lib/webchat').message(e.message), code: e.message, delivery: 'not-sent' }); }
    }
    let t = store.readTask(file);
    const automatic = !fromQueue && !b.model && specialMode.pick(modelView.special(), rolesData(), t.role);
    if (automatic) { b.ai = automatic.ai; b.model = automatic.model; b.effort = b.effort || automatic.effort; b.account = undefined; }
    const delegated = Boolean(fromQueue?.requireModel);
    if (delegated && t.state === '完了') return send(res, 409, { error: DELEGATE_COMPLETED_ERROR });
    try{chats.assertHandoffReady(p.id,b.task);}catch(e){return send(res,409,{error:e.message,delivery:'not-sent'});}
    const busy = chats.busy(p.id, b.task);
    // redo: 取り消してやり直す ／ amend: 追加説明（一緒にやる）／ queue: 終わったら次に（interrupt は前の呼び名）
    const want = b.mode === 'interrupt' ? 'redo' : b.mode;
    if(busy?.automation&&['redo','amend'].includes(want))return send(res,409,{error:'台帳の実行中は台帳の項目から変更してください'});
    const mode = busy ? (['redo', 'amend', 'queue'].includes(want) ? want : '') : '';
    if (busy && !mode) return send(res, 409, { error: lt('まだ作業中です。［取り消してやり直す］［追加説明（一緒にやる）］［終わったら次に］から選んでください') });
    const spec = pickSpec(t, b.ai);
    const account = requestAccount(p, t.id, b.ai, b.account);
    const model = launch.modelLabel(b.ai, b.model || spec.model);
    const invalidModel = modelError(b.ai, model);
    if (invalidModel) return send(res, 409, { error: invalidModel });
    if(fromQueue){try{verifyIntegrationReviewSend({...fromQueue,project:p.id,task:t.id,request:fromQueue.id,mode:'queued'});}catch(e){return send(res,409,{error:e.message});}}
    const { dir, note } = fromQueue?.isolatedReview ? (assertWorkspaceIdle(p,t,Boolean(mode)),{dir:isolatedReviewDir(p,t)}) : startDir(p, t, Boolean(mode));
    if (b.ai === 'grok' && b.effort === 'Ultra') return send(res, 400, { error: lt('Grok の思考は 中・高・極高・MAX です') });
    const effort = fromQueue?.integrationAssignment ? fromQueue.effort : b.ai === 'agy' ? '高' : roles.EFFORTS.includes(b.effort) ? b.effort : spec.effort;
    let topicImages=[];
    if(p.kind==='freetalk' && !fromQueue && b.images?.length) {
      try { freetalk.checkGeneration(t.id,b.generation);topicImages=freetalkAttachments.images(t.id,b.images); }
      catch(e){return send(res,409,{error:e.message});}
    }
    let attachmentDraft;
    try { attachmentDraft = fromQueue?.attachmentDraft || queueEdit.accept(p, t.id, b.attachmentDraft, text, freetalkAttachments); }
    catch (e) { return send(res, 400, { error: e.message }); }
    const basePrompt = fromQueue?.isolatedReview?integrationReviewPrompt(p,t):taskPrompt(p, t, file, dir) + lt(' ここは会話画面。人からの依頼に答え、区切りで作業ファイルを更新すること。');
    resumeManual();
    // 受付時の質問だけを消す。起動待ち中に来た新しい質問には触れない。
    const answerQuestion = typeof b.answerQuestion === 'string' ? b.answerQuestion : t.question;
    const acceptAnswer = () => {
      const current = store.readTask(file);
      if (current.question !== answerQuestion) return null;
      if (current.question || current.state === '返事待ち') store.updateTask(p.id, t.id, { question: '', state: '実行中' });
      return answerQuestion;
    };
    let projectImages;
    if(p.kind!=='freetalk'&&b.projectImages!==undefined){
      if(!Array.isArray(b.projectImages)||b.projectImages.length>10)return send(res,400,{error:'添付画像の情報を確認してください'});
      try{projectImages=b.projectImages.map(id=>{const f=start.imageFile(p,id);if(!fs.existsSync(f))throw Error('添付画像が見つかりません');return id;});}catch(e){return send(res,400,{error:e.message});}
    }
    // 追加：今の作業が終わったら続けて行う
    if (mode === 'queue') {
      const it = chats.enqueue(p.id, t.id, { ai: b.ai, account, model, effort, role: t.role, text, attachmentDraft, ...(projectImages?{projectImages}:{}), images: p.kind==='freetalk' ? topicImages : [], perm: permCmd(b.ai) });
      if (p.kind === 'freetalk') freetalk.nameTopic(t.id, text);
      record('chatqueue', { project: p.id, task: t.id, ai: b.ai }, { model });
      return send(res, 200, { ok: true, queued: true, id: it.id, queue: chats.queue(p.id, t.id).length, answeredQuestion: acceptAnswer() });
    }
    // 取り消し・追加説明：今の作業を区切って（終わるのを待って）から、元の指示と合わせて伝え直す
    let stopWaiting,switchAdvance;
    if (!busy?.pending && (mode === 'redo' || mode === 'amend')) {
      const switching=Object.values(require('./lib/chat-continuation').read(p.dir,t.id).advances).find(a=>a.source.turn===busy.userRow?.turn&&a.mode!=='fifo');
      if(switching&&switching.id!==fromQueue?.id)return send(res,409,{error:'前の切替を確認中です。新しい文章はまだ受け付けていません'});
      const waiting=stopWaiting=fromQueue || chats.enqueue(p.id,t.id,{ai:b.ai,account,model,effort,role:t.role,text,attachmentDraft,...(projectImages?{projectImages}:{}),images:topicImages,perm:permCmd(b.ai)});
      try{switchAdvance=chats.prepareSwitch(p.id,t.id,waiting.id,mode,stopTicket);}catch(e){return send(res,409,{error:e.message,queued:true,id:waiting.id});}
      try{await chats.stop(p.id,t.id,{interrupting:true});}catch(e){try{require('./lib/chat-continuation').update(p.dir,t.id,d=>{d.advances[switchAdvance.source.turn].reason=e.message;});}catch{/* The original intent remains; no new start is attempted here. */}return send(res,409,{error:e.message,queued:true,id:waiting.id});}
      try{stopControl.assert({project:p.id,task:t.id},stopTicket);}catch(e){return send(res,409,{error:e.message,queued:true,id:waiting.id});}

      record(mode === 'redo' ? 'chatredo' : 'chatamend', { project: p.id, task: t.id, ai: b.ai });

    }
    try {
      // 答えを送ったら、AI からの質問は済んだことにする
      // 質問は spawn の成功後にだけ解除する。
      // AI が質問して終わったら「あなたの番」にする（左の丸が黄色になる）
      const onEnd = row => { if (!fromQueue?.isolatedReview && row.asks && row.asks.length) store.updateTask(p.id, t.id, { state: '返事待ち', question: row.asks.map(a => a.question).filter(Boolean).join(' / ').slice(0, 300) || lt('選んでください') }); chatEnded(p.id, t.id); };
      let replacement;
      if (busy?.pending && (mode === 'redo' || mode === 'amend')) {
        replacement = chats.replacePending(p.id, t.id, text, mode, p.kind === 'freetalk' ? topicImages : undefined);
        await replacement.finished;
        stopControl.assert({project:p.id,task:t.id},stopTicket);
      }
      if (!replacement && !fromQueue) {
        const stopVersion = chats.stops.get(chats.key(p.id, t.id)) || 0;
        await refreshLimitEvidence({ project: p.id, task: t.id, role: t.role, ai: b.ai, account, model });
        if(p.kind==='freetalk' && b.images?.length)freetalk.checkGeneration(t.id,b.generation);
        if ((chats.stops.get(chats.key(p.id, t.id)) || 0) !== stopVersion) throw Error(lt('利用枠の確認中に停止されました。AIは開始していません'));
      }
      const options={ stopTicket, project: p.id, task: t.id, pdir: p.dir, dir, ai: b.ai, account, model, effort, origin: fromQueue?.origin, integrationAssignment:fromQueue?.integrationAssignment, limitPolicy:fromQueue?.limitPolicy, isolatedReview:fromQueue?.isolatedReview, integrationReviewRequest:fromQueue?.integrationReviewRequest, readOnly:fromQueue?.readOnly, readDirs:fromQueue?.readDirs, images: p.kind==='freetalk' && b.ai==='codex' ? fromQueue?.images || topicImages : [], role: fromQueue ? fromQueue.role || '' : t.role, limitSlot: fromQueue?.limitSlot, limitSwitch: fromQueue?.limitSwitch, request: fromQueue?.id||stopWaiting?.id, requireModel: Boolean(fromQueue?.requireModel), requiredModel: fromQueue?.requiredModel, text, shown: amendQueue ? text : fromQueue?.shown || text, mode: mode || (fromQueue ? 'queued' : undefined), basePrompt, policy: modelPolicy(p, t), perm: permCmd(b.ai), onEnd };
      const r = switchAdvance ? await chats.launchAdvance({...switchAdvance,liveRun:busy},options) : replacement
        ? await chats.sendQueued(replacement.options)
        : await (fromQueue ? chats.sendQueued.bind(chats) : chats.send.bind(chats))(options);
      if(!r)throw Error('待ち指示は取り消されました。中断した依頼の記録を確認してください');
      if (!(await r.started)) throw Error(lt('AIを起動できませんでした。CLIの導入状態を確認してください。作業の状態と質問は変更していません'));
      if (p.kind === 'freetalk') freetalk.nameTopic(t.id, text);
      const answeredQuestion = delegated || fromQueue?.isolatedReview ? null : acceptAnswer();
      if (delegated && !fromQueue?.isolatedReview) {
        store.updateTask(p.id, t.id, { state: '実行中', question: '' });
      }
      if (stopWaiting&&!fromQueue)chats.unqueue(p.id,t.id,stopWaiting.id);
      if (fromQueue) chats.unqueue(p.id, t.id, fromQueue.id);
      if (replacement) {
        chats.unqueue(p.id, t.id, replacement.options.request);
        record(mode === 'redo' ? 'chatredo' : 'chatamend', { project: p.id, task: t.id, ai: r.ai });
      }
      record('chat', { project: p.id, task: t.id, ai: r.ai }, { model: r.model, effort: r.effort, resume: r.resume });
      return send(res, 200, { ok: true, model: r.model, effort: r.effort, note: r.limitSwitch?.preflight ? lt`${r.limitSwitch.from} 上限保持中のため ${r.model} で開始しました。` : note, resume: r.resume, answeredQuestion });
    } catch (e) { return send(res, 409, { error: String(e.message || e),...(stopWaiting?{queued:true,id:stopWaiting.id}:{}) }); }
    } finally { if (fromQueue) queueActions.delete(queueKey); }
  }
  if (url.pathname === '/api/chat/handoff/recover') {
    try{return send(res,200,chats.recoverHandoff(b));}
    catch(e){return send(res,409,{error:e.message,delivery:'not-sent'});}
  }
  if (url.pathname === '/api/chat/queue/retreat') {
    const human=require('./lib/idea-api').humanRequest({...req,headers:{...req.headers,'x-hub-ui':req.headers['x-hub-ui']==='queue'?'ideas':''}});
    if(!human)return send(res,403,{error:'この操作は待ち指示の［台帳へ退避］から行ってください'});
    try {return send(res,200,queueRetreat.transfer(b));}
    catch(e){return send(res,e.status||503,{error:e.message,code:e.code,opId:b.opId});}
  }
  if (url.pathname === '/api/chat/unfinished/resolve') {
    const p=store.readProject(b.project);
    if(!p||!store.taskFile(b.project,b.task))return send(res,400,{error:'作業が見つかりません'});
    try{return send(res,200,{ok:true,entry:require('./lib/chat-continuation').resolve(p.dir,b.task,b)});}
    catch(e){return send(res,409,{error:e.message});}
  }
  if (url.pathname === '/api/chat/queue/edit') {
    const p = store.readProject(b.project), file = store.taskFile(b.project, b.task);
    if (!p || !file) return send(res, 400, { error: lt('作業が見つかりません') });
    const q = chats.queue(p.id, b.task), item = q.find(x => x.id === String(b.id || ''));
    if (!item) return send(res, 404, { error: lt('その指示はもう待っていません') });
    if (!queueEditable(item)) return send(res, 409, { error: lt('この待ち指示は編集できません') });
    if (queueActions.has(chats.key(p.id, b.task)) || chats.busy(p.id, b.task)?.request === item.id) return send(res, 409, { error: lt('待ち指示を送信中です。終わってから操作してください') });
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    if (!text && !(Array.isArray(b.attachmentIds) && b.attachmentIds.length)) return send(res, 400, { error: lt('依頼を書いてください') });
    if (b.expectedText !== item.text) return send(res, 409, { error: lt('待ち指示が変更されています。内容を確認してから操作してください') });
    try {
      if (b.expectedItem !== undefined ? b.expectedItem !== JSON.stringify(item) : item.editRevision || item.attachmentDraft) throw Error('待ち指示が変更されています。編集を開き直してください');
      let selection = {};
      if (b.ai !== undefined || b.model !== undefined) {
        if (!['claude', 'codex', 'agy', 'grok'].includes(b.ai) || typeof b.model !== 'string' || !b.model) throw Error('AI・モデルを選んでください');
        const model = launch.modelLabel(b.ai, b.model), invalid = modelError(b.ai, model);
        if (invalid) throw Error(invalid);
        const t = store.readTask(file), account = requestAccount(p, b.task, b.ai, b.ai === item.ai ? item.account || 'default' : undefined);
        const preferred = roles.EFFORTS.includes(item.effort) ? item.effort : pickSpec(t, b.ai).effort;
        const effort = b.ai === 'agy' || b.ai === 'grok' && preferred === 'Ultra' ? '高' : preferred;
        if (item.requireModel && !launch.flagFor(b.ai, model)) throw Error('指定モデルの起動名を確認できません');
        selection = { ai: b.ai, model, account, effort, perm: permCmd(b.ai), requiredModel: item.requireModel ? launch.flagFor(b.ai, model) : undefined, limitSlot: item.role ? limitIdentity(rolesData(), { ai: b.ai, model, role: item.role })?.limitSlot : undefined };
      }
      let editedText = text, attachmentDraft, images = item.images, projectImages = item.projectImages;
      if (b.attachmentIds !== undefined) {
        const source = queueEdit.draft(p, b.task, item, freetalkAttachments);
        if (!Array.isArray(b.attachmentIds) || new Set(b.attachmentIds).size !== b.attachmentIds.length || b.attachmentIds.some(id => !source.attachments.some(x => x.id === id))) throw Error('添付情報が変更されています');
        const attachments = source.attachments.filter(x => b.attachmentIds.includes(x.id));
        // 参照の削除だけなので、既に無い画像も残存添付の保存を妨げない。
        attachmentDraft = { text: b.text, attachments };
        editedText = queueEdit.format(b.text, attachments);
        if (p.kind === 'freetalk') images = attachments.map(x => x.imagePath).filter(Boolean);
        else projectImages = attachments.filter(x => x.kind !== 'file').map(x => x.id);
      }
      const edited = { ...item, ...selection, text: editedText, ...(item.shown !== undefined ? { shown: editedText } : {}),
        ...(b.attachmentIds !== undefined ? { attachmentDraft, images, ...(p.kind !== 'freetalk' ? { projectImages } : {}) } : { attachmentDraft: undefined }),
        ...(b.ai !== undefined || b.attachmentIds !== undefined ? { editRevision: require('node:crypto').randomUUID() } : {}), error: undefined };
      const queue = chats.setQueue(p.id, b.task, q.map(x => x.id === item.id ? edited : x), true);
      record('chatqueueedit', { project: p.id, task: b.task, ai: item.ai });
      return send(res, 200, { ok: true, queue });
    } catch (e) { return send(res, 409, { error: String(e.message || e) }); }
  }
  // 未読の印を消す（画面が作業を開いた時）
  if (url.pathname === '/api/task/read') {
    if (typeof b.project !== 'string' || typeof b.task !== 'string') return send(res, 400, { error: lt('作業が見つかりません') });
    setUnread(b.project, b.task, false);
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/chat/unqueue') {
    if (queueActions.has(chats.key(b.project, b.task))) return send(res, 409, { error: lt('待ち指示を送信中です。終わってから操作してください') });
    try{queueRetreat.guard({project:b.project,task:b.task,id:b.id,action:'change'});}catch(e){return send(res,409,{error:e.message});}
    const pending = fs.existsSync(ROLES_FILE) ? roleHistory.load(ROLES_FILE).journal.review : null;
    if (pending?.project === b.project && pending.task === b.task && [pending.request, `limit-${pending.request}`].includes(b.id) && b.id) roleReview.cancel();
    if (fromRemote()) record('chatunqueue', b);
    return send(res, 200, { ok: true, queue: chats.unqueue(b.project, b.task, String(b.id || '')) });
  }
  if (url.pathname === '/api/discussion/start' || url.pathname === '/api/discussion/summary') {
    try { license.require(['discussion']); return send(res,200,url.pathname.endsWith('/start')?discussion.start(b):discussion.manual(b)); }
    catch(e) { return send(res,e.status || 409,{error:e.message}); }
  }


  // 新しい版にする：本体を起動し直す（動いている AI があれば断る。止まってしまうため）
  // 本体を止める（アプリが、許可のある自分から起動し直すため）。AI が動いている間は断る
  if (url.pathname === '/api/quit') {
    if (updateBusy()) return send(res, 409, { error: appUpdate.idleMessage() });
    if (aiTools.isOperating()) return send(res, 409, { error: lt('AI の更新・モデル再取得が進行中です') });
    const busy = sessions.list().filter(x => x.running).length + chats.running.size;
    if (busy) return send(res, 409, { error: lt`動いている AI が ${busy} つあります` });
    record('quit', {}, { reason: String(b.reason || '') });
    send(res, 200, { ok: true });
    if (!DRY) setTimeout(shutdown, 200);
    return undefined;
  }
  if (url.pathname === '/api/restart' || url.pathname === '/api/restart/cancel') {
    try {
      if(emergencyRestart?.pending())throw Object.assign(Error('緊急停止後の再起動を確認しています。［復旧］で状態を確認してください'),{status:409});
      if (url.pathname.endsWith('/cancel')) return send(res,200,{ok:true,restart:restartControl.cancel()});
      if (b.reserve !== undefined && typeof b.reserve !== 'boolean') return send(res,400,{error:lt('形式が違います')});
      const result=restartControl.request(b.reserve === true);
      return send(res,200,{ok:true,from:VERSION,to:readVersion(),restart:result});
    } catch(e) { return send(res,e.status||409,{error:e.message,waiting:e.waiting}); }
  }

  // CLI に渡すモデル名を保存する
  if (url.pathname === '/api/cli-models') {
    const clean = x => (x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).filter(([k, v]) => typeof k === 'string' && typeof v === 'string' && k.length < 40 && /^[\w.:\-/\[\]]*$/.test(v.trim())).map(([k, v]) => [k, v.trim()])) : {});
    saveCliModels({ claude: clean(b.claude), codex: clean(b.codex) });
    record('climodels', {});
    return send(res, 200, { ok: true, overrides: launch.getOverrides() });
  }

  // Mac のフォルダ選択の窓を出して、選んだ場所を返す
  if (url.pathname === '/api/pick-folder') {
    if (DRY) return send(res, 200, { path: '' });
    const { execFile } = require('child_process');
    execFile('osascript', ['-e', `POSIX path of (choose folder with prompt "${String(b.prompt || lt('フォルダを選んでください')).replace(/["\\]/g, '')}")`], (err, out) => {
      if (err) return send(res, 200, { path: '' }); // 取り消した時
      return send(res, 200, { path: String(out).trim().replace(/\/$/, '') });
    });
    return undefined;
  }
  // アプリの窓に落としたファイル（場所が分かる物）を渡す：作業ファイルに記録し、AI の入力欄に場所を入れる
  if (url.pathname === '/api/task/attach') {
    const p = store.readProject(b.project);
    const file = p && store.taskFile(p.id, b.task);
    if(p?.kind==='freetalk') {
      let release;const attachments=[];
      try {
        if(!Array.isArray(b.paths)||!b.paths.length||b.paths.length>20)throw Error(lt('添付ファイルの指定が正しくありません'));
        release=freetalk.holdUpload(b.task,b.generation);
        for(const raw of b.paths)attachments.push(await freetalkAttachments.fromPath(b.task,raw,b.generation));
        const paths=attachments.flatMap(a=>a.referencePaths);
        store.updateTask(p.id,b.task,{memo:lt`ファイルを渡した: ${paths.join(' , ')}`});
        record('upload',{project:p.id,task:b.task},{file:paths.join(' , ')});
        return send(res,200,{ok:true,attachments,paths,typed:false});
      }catch(e){for(const attachment of attachments)freetalkAttachments.discard(b.task,attachment);return send(res,409,{error:e.message});}
      finally{release?.();}
    }
    const paths = (Array.isArray(b.paths) ? b.paths : []).map(x => String(x)).filter(x => path.isAbsolute(x) && fs.existsSync(x)).slice(0, 20);
    if (!file) return send(res, 400, { error: lt('作業が見つかりません') });
    if (!paths.length) return send(res, 400, { error: lt('ファイルが見つかりません') });
    store.updateTask(p.id, b.task, { memo: lt`ファイルを渡した: ${paths.join(' , ')}` });
    const ai = launch.AIS.includes(b.ai) ? b.ai : '';
    const typed = ai ? sessions.write(p.id, b.task, ai, paths.map(x => (/\s/.test(x) ? `"${x}"` : x)).join(' ') + ' ') : false;
    record('upload', { project: p.id, task: b.task, ai }, { file: paths.join(' , ') });
    return send(res, 200, { ok: true, paths, typed });
  }

  // 参考フォルダ・ファイルを足す（作った後のプロジェクトにも）
  if (url.pathname === '/api/project/refs') {
    const paths = (Array.isArray(b.paths) ? b.paths : []).map(x => expandHome(String(x))).filter(x => path.isAbsolute(x) && fs.existsSync(x)).slice(0, 30);
    if (!paths.length) return send(res, 400, { error: lt('フォルダが見つかりません') });
    const r = store.addRefs(b.project, paths);
    if (!r) return send(res, 400, { error: lt('プロジェクトが見つかりません') });
    record('refs', { project: b.project }, { paths: paths.join(' , ') });
    return send(res, 200, { ok: true, added: r.added, folders: r.project.folders });
  }

  // 新しいプロジェクトを始める
  // 中身の無い作業・子プロジェクトを探す／ゴミ箱へまとめて移す
  if (url.pathname === '/api/empty/scan' || url.pathname === '/api/empty/trash') {
    const busy = (project, task) => webchatActive(project, task) || sessions.list().some(x => x.running && x.project === project && x.task === task) || Boolean(chats.busy(project, task));
    if (url.pathname === '/api/empty/scan') return send(res, 200, { ok: true, items: emptyLib.scan(store, busy) });
    const r = emptyLib.trash(store, busy, Array.isArray(b.items) ? b.items : []);
    record('emptytrash', {}, { moved: r.moved });
    return send(res, 200, { ok: true, ...r });
  }
  if (url.pathname === '/api/task/tidy/preview' || url.pathname === '/api/task/tidy/apply') {
    try {
      if (url.pathname.endsWith('/preview')) return send(res, 200, removal.tidyPreview(b.project, b.task));
      const result = removal.tidyApply(b); record('tasktidy', b, { transaction: result.record, moved: result.moved.length }); return send(res, 200, result);
    } catch (e) { return send(res, 409, { error: e.message }); }
  }
  if (url.pathname.startsWith('/api/hierarchy/remove/')) {
    try {
      let result;
      if(url.pathname.endsWith('/preview')) {const review=b.task?null:removalReview.status(b.project);result={...removal.preview(b.project,b.task),review};}
      else if(url.pathname.endsWith('/review/start')) result=await removalReview.begin(b.token);
      else if(url.pathname.endsWith('/review/status')) {const review=removalReview.status(b.project);result={review,...(review?.status!=='running'?{preview:{...removal.preview(b.project),review}}:{})};}
      else if(url.pathname.endsWith('/apply')) {const removalTarget=removal.tokens.get(b.token)?.d;if(removalTarget&&!removalTarget.task&&ideas.resolve(removalTarget.project))ideas.backup(removalTarget.project,{opId:crypto.randomUUID()});result=removal.apply(b);pruneUnread();record('remove',{}, {transaction:result.record,moved:result.moved.length});}
      else if(url.pathname.endsWith('/restore')) {result=removal.restore(b.record,b.confirm);record('removerestore',{}, {transaction:b.record});}
      else if(url.pathname.endsWith('/history')) result={history:removal.history()};
      else return send(res,404,{error:'not found'});
      return send(res,200,result);
    }catch(e){return send(res,409,{error:e.message});}
  }
  if (url.pathname.startsWith('/api/maintenance/')) {
    try {
      let result;
      if (url.pathname === '/api/maintenance/preview') result=maintenance.preview(b.project);
      else if (url.pathname === '/api/maintenance/apply') {result=maintenance.apply(b.project,b.token,b.selected,b.confirm);record('cleanup', {project:b.project}, {transaction:result.id,moved:result.moved});}
      else if (url.pathname === '/api/maintenance/restore') {result=maintenance.restore(b.project,b.transaction,b.confirm);record('restore',{project:b.project},{transaction:b.transaction});}
      else if (url.pathname === '/api/maintenance/solve') {result=await problemResolution.solve(b.project);record('problemsolve',{project:b.project,task:result.task},{reused:result.reused,clear:result.clear});}
      else if (url.pathname === '/api/maintenance/verify') {const owner='maintenance:'+b.project;let lease;try{result=await maintenance.verify(b.project,b.script,b.expectedHash,b.confirm,()=>{lease=executionGate.acquire({dir:baseOf(store.readProject(b.project)),owner,kind:'verification'});});}finally{if(lease)executionGate.release(owner,lease.id);}record('verify',{project:b.project},{ok:result.ok,script:b.script});}
      else return send(res,404,{error:lt('操作が見つかりません')});
      return send(res,200,result);
    } catch(e) {return send(res,409,{error:e.message,...(e.task?{task:e.task}:{})});}
  }
  if (url.pathname === '/api/hierarchy/pin') {
    try {
      const result = projectOrder.pin(b);
      record('projectpin', { project: b.project }, { pinned: b.pinned });
      return send(res, 200, result);
    } catch (e) { return send(res, 409, { error: e.message }); }
  }
  if (url.pathname === '/api/hierarchy/order') {
    try {
      const result = projectOrder.save(b);
      record('projectorder', {}, { parent: b.parent, order: b.order });
      return send(res, 200, result);
    } catch (e) { return send(res, 409, { error: e.message }); }
  }
  if (url.pathname === '/api/hierarchy/rename') {
    try {
      const { Hierarchy } = require('./lib/hierarchy');
      const value = new Hierarchy(store, id => sessions.list().some(s=>s.project===id && s.running) || [...chats.running.keys()].some(k=>k.startsWith(id+'\u0000'))).rename(b.project, b.task, b.name, b.expectedHash);
      record('rename', { project: b.project, task: b.task }); return send(res, 200, value);
    } catch(e) { return send(res, 409, { error: e.message }); }
  }
  if (url.pathname === '/api/project/new') {
    const body = expandHome(b.body || '');
    if (body && !fs.existsSync(body)) return send(res, 400, { error: lt`本体のフォルダが見つかりません: ${body}` });
    if (body && !fs.statSync(body).isDirectory()) return send(res, 400, { error: lt`フォルダではありません（ファイルです）: ${body}` });
    const refs = (Array.isArray(b.refs) ? b.refs : []).map(x => expandHome(String(x))).filter(x => path.isAbsolute(x) && fs.existsSync(x));
    const pack = activePack(['templates']);
    const r = store.createProject({ ...b, body, refs }, pack ? path.join(pack.directory, 'templates', 'project') : path.join(__dirname, '..', 'docs', 'project-hub', 'templates', 'project'));
    if (r.error) return send(res, 400, { error: r.error });
    record('newproject', { project: r.project.id });
    return send(res, 200, r.project);
  }
  if (url.pathname === '/api/task/new') {
    const t = store.createTask(b.project, b);
    if (t) record('newtask', { project: b.project, task: t.id }, { title: t.title });
    return t ? send(res, 200, t) : send(res, 400, { error: lt('作業名・親作業・派生元を確認してください') });
  }

  // 選ぶ欄にモデルを出す・出さない
  if (url.pathname === '/api/models/hidden') {
    if (!['claude-code', 'codex', 'agy', 'grok'].includes(b.ai) || typeof b.model !== 'string' || !b.model) return send(res, 400, { error: lt('形式が違います') });
    return send(res, 200, { ok: true, ...modelView.setHidden(b.ai, b.model, Boolean(b.hidden)) });
  }
  if (url.pathname === '/api/special-mode') {
    const r = modelView.setSpecial(b);
    if (r.error) return send(res, r.status, { error: r.error });
    record('specialmode', {}, r.specialMode);
    return send(res, 200, { ok: true, ...r });
  }
  if (url.pathname === '/api/models/initial') {
    const r = modelView.setInitial(b, rolesData().models, modelError);
    if (r.error) return send(res, r.status, { error: r.error });
    record('initialai', {}, r.initialPick);
    return send(res, 200, { ok: true, ...r });
  }
  if (url.pathname === '/api/models/phone') {
    const r = modelView.setPhone(b, rolesData().models);
    return r.error ? send(res, r.status, { error: r.error }) : send(res, 200, { ok: true, ...r });
  }
  if (url.pathname === '/api/models/order') {
    const r = modelView.setOrder(b.order, b.before, rolesData().models);
    return r.error ? send(res, r.status, { error: r.error }) : send(res, 200, { ok: true, ...r });
  }
  // 最新のモデルに整理：役割の古いモデル名を、同じ系統の一番新しいモデルに。roles.yaml の一覧も今のものに
  if (url.pathname === '/api/models/tidy') {
    const r = roles.tidy(ROLES_FILE, { expectedRevision: b.expectedRevision });
    if (!r.ok) return send(res, r.delivery ? 409 : 400, { error: r.error,...(r.delivery?{delivery:r.delivery}:{}) });
    record('modeltidy', {}, { changes: r.changes.length });
    return send(res, 200, { ok: true, changes: r.changes, roles: rolesData() });
  }
  // 役割分担の保存
  if (url.pathname === '/api/roles') {
    if (!Array.isArray(b.roles)) return send(res, 400, { error: lt('形式が違います') });
    const r = roles.write(ROLES_FILE, b.roles, b.checkCredits, false, b.preferCredits, { expectedRevision: b.expectedRevision });
    return r.ok ? send(res, 200, r.data) : send(res, r.status || 400, { error: r.errors.join(' / ') });
  }
  if (url.pathname === '/api/roles/review') {
    try { license.require(['role_review']); } catch(e) { return send(res,e.status || 403,{error:e.message}); }
    return send(res, 200, roleReview.start(b));
  }
  if (url.pathname === '/api/roles/review/cancel') {
    const pending = roleHistory.load(ROLES_FILE).journal.review;
    const out = roleReview.cancel();
    if (pending) {
      const run = chats.busy(pending.project,pending.task), request = run?.userRow?.request || run?.request;
      if ([pending.request, `limit-${pending.request}`].includes(request) && request) chats.stop(pending.project,pending.task);
    }
    return send(res, 200, out);
  }
  if (url.pathname === '/api/roles/default') {
    const r = roles.saveDefault(ROLES_FILE, b.roles, b.expectedRevision);
    return r.ok ? send(res, 200, r.data) : send(res, r.status || 400, { error: r.errors.join(' / ') });
  }
  if (url.pathname === '/api/roles/restore') {
    const current = roleHistory.load(ROLES_FILE);
    if (!b.expectedRevision || b.expectedRevision !== current.revision) return send(res,409,{error:lt('役割設定が変わりました。読み直してください')});
    const row = b.defaults === true ? current.journal.defaults : roleHistory.select(current.journal,b);
    if (!row) return send(res,409,{error:lt('デフォルトはまだ保存されていません')});
    const r = roles.write(ROLES_FILE, row.roles, undefined, true, undefined, {
      expectedRevision:b.expectedRevision, restore:true, kind:b.defaults === true ? 'default' : 'restore',
      reason:b.defaults === true ? lt('固定したデフォルトに戻した') : lt('履歴の設定に戻した') + `（${row.at}）`
    });
    return r.ok ? send(res,200,r.data) : send(res,r.status || 400,{error:r.errors.join(' / ')});
  }

  return send(res, 404, { error: 'not found' });
}


function serveStatic(req, res, pathname) {
  if(pathname==='/locale-config.js')return send(res,200,configScript(),TYPES['.js']);
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'forbidden', 'text/plain');
  return staticFiles.send(req, res, file, TYPES[path.extname(file)] || 'application/octet-stream', send);
}

// 外から（tailscale serve 越し）の要求：オフなら断る。オンなら合言葉で入った札が要る
async function remoteGate(req, res, url) {
  const isApi = url.pathname.startsWith('/api/');
  if (!remote.enabled()) return isApi ? send(res, 403, { error: lt('外からの利用はオフです') }) : send(res, 403, remoteLib.offPage(), 'text/html; charset=utf-8');
  remote.noteHost(req.headers['x-forwarded-host'] || req.headers.host);
  // 書き換える操作は、この画面から送った物だけ（ほかのサイトから送らせない）
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin, hosts = [req.headers.host, req.headers['x-forwarded-host']].filter(Boolean).map(h => `https://${h}`);
    if (req.headers['x-hub'] !== '1' || (origin && !hosts.includes(origin))) return send(res, 403, { error: 'forbidden' });
  }
  if (req.method === 'GET' && url.pathname === '/login') return send(res, 200, remoteLib.loginPage(), 'text/html; charset=utf-8');
  if (req.method === 'POST' && url.pathname === '/api/login') {
    let b; try { b = await readBody(req); } catch (e) { return send(res, 400, { error: lt('形式が違います') }); }
    const who = remoteLib.whoOf(req), r = remote.login(b.passcode, who, req.headers['user-agent']);
    record('remotelogin', {}, { ok: Boolean(r.ok), who });
    if (!r.ok) return send(res, r.status, { error: r.error });
    res.setHeader('Set-Cookie', remoteLib.sessionCookie(r.token));
    return send(res, 200, { ok: true });
  }
  const token = remoteLib.cookieOf(req);
  if (!remote.check(token)) {
    if (isApi) return send(res, 401, { error: lt('ログインしてください'), login: true });
    res.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' }); return res.end();
  }
  if (req.method === 'POST' && url.pathname === '/api/logout') {
    remote.logout(token); record('remotelogout', {});
    res.setHeader('Set-Cookie', remoteLib.clearCookie());
    return send(res, 200, { ok: true });
  }
  if (isApi) return api(req, res, url);
  if (req.method !== 'GET') return send(res, 405, { error: 'method' });
  return serveStatic(req, res, url.pathname);
}

async function quickStart(b, maintenanceRequest = false) {
  const reply = (status, body) => ({ status, body });
  const p = store.readProject(b.project), text = String(b.text || '').trim();
  const automatic = !b.model && specialMode.pick(modelView.special(), rolesData(), p?.phases.find(x => x.state !== '完了')?.role || '司令塔');
  if (automatic && ['claude', 'claude-code', 'codex'].includes(b.ai)) b = { ...b, ...automatic };
  const ai = b.ai === 'claude-code' ? 'claude' : b.ai;
  const agents = new Set([...rolesData().agents, ...store.listProjects().flatMap(x => x.tasks.map(t => t.owner).filter(o => o && !/claude|codex|agy|grok|^chatgpt$|^dot$|^(人|あなた)$/i.test(o)).map(o => o.replace(/^discord:\s*/i, '')))]);
  const agent = typeof ai === 'string' && ai.startsWith('discord:') && agents.has(ai.slice(8));
  if (!p || (!text && !(b.images || []).length) || (!launch.AIS.includes(ai) && !agent)) return reply(400, { error: lt('依頼と担当を確認してください') });
  if ((!maintenanceRequest && text.length > 4000) || !Array.isArray(b.images) || b.images.length > 10) return reply(400, { error: lt('依頼は4000文字、画像は10枚までです') });
  if (!agent && aiTools.isOperating(ai)) return reply(409, { error: lt('AI の更新・モデル再取得が進行中です') });
  const ph = p.phases.find(x => x.state !== '完了');
  const spec = agent ? { model: '', effort: '' } : pickSpec({ role: ph?.role, model: b.model, effort: b.effort }, ai);
  const invalid = !agent && modelError(ai, spec.model);
  if (invalid) return reply(409, { error: invalid });
  const receiptFile = path.join(p.dir, '.ai', 'start-request.json');
  let receipt; try { receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8')); } catch { /* 初回 */ }
  if (b.request && receipt?.request === b.request && receipt.result) return reply(200, receipt.result);
  const writeReceipt = value => { if (b.request) { fs.mkdirSync(path.dirname(receiptFile), { recursive: true }); require('./lib/integration-writes').write(receiptFile,()=>fs.writeFileSync(receiptFile, JSON.stringify({ request: b.request, ...value }))); } };
  let t;
  try {
    for (const id of b.images) if (!fs.existsSync(start.imageFile(p, id))) throw Error(lt('添付画像が見つかりません'));
    // 途中で失敗しても同じ作業を再開し、重複作成を防ぐ。
    if (b.request && receipt?.request === b.request) b.task = receipt.task;
    t = b.task && store.taskFile(p.id, b.task) ? store.readTask(store.taskFile(p.id, b.task)) : null;
    if (t && chats.busy(p.id, t.id)) throw Error(lt('この作業はすでに始まっています'));
    t ||= store.createTask(p.id, { title: (text.split('\n')[0] || lt('画像を確認する')).slice(0, 40), owner: agent ? ai : launch.AI_KEY[ai], role: ph?.role || '', phase: ph?.name || '' });
    writeReceipt({ task: t.id });
    const { dir, note } = startDir(p, t);
    const images = start.copyImages(p, b.images, dir, t.id);
    store.updateTask(p.id, t.id, { owner: agent ? ai : launch.AI_KEY[ai], ...spec });
    const prompt = start.imagePrompt(ai, text || lt('添付画像を確認してください。'), images);
    const file = store.taskFile(p.id, t.id);
    if (agent) {
      const notice = lt('Discordへの自動送信は未対応です。依頼文と画像の場所を保存しました。Discordで担当へ渡してください。');
      store.updateTask(p.id, t.id, { state: '返事待ち', question: notice, memo: prompt });
      chat.append(p.dir, t.id, { role: 'user', to: ai, text: prompt });
    } else {
      const basePrompt = taskPrompt(p, t, file, dir);
      const turn = { request: b.request, role: t.role, project: p.id, task: t.id, pdir: p.dir, dir, ai, account: requestAccount(p, t.id, ai), ...spec, text: prompt, images, basePrompt, policy: modelPolicy(p, t), perm: permCmd(ai), onEnd: row => {
        if (row.asks?.length) store.updateTask(p.id, t.id, { state: '返事待ち', question: row.asks.map(a => a.question).join(' / ').slice(0, 300) });
        chatEnded(p.id, t.id);
      } };
      if (!DRY && !(await chats.send(turn).started)) throw Error(lt('AIを起動できませんでした。CLIの導入状態を確認してください'));
      store.updateTask(p.id, t.id, { state: '実行中', question: '', memo: images.length ? '参照画像: ' + images.join(' / ') : '' });
      if (DRY) t.turn = chat.buildTurn({ ...turn, fast: false, rows: [], meta: {} });
    }
    start.saveSpec(p, { ai, ...spec });
    record('quickstart', { project: p.id, task: t.id, ai }, { ...spec, images });
    const result = { ok: true, task: t.id, agent, note, images, ...(DRY ? { dry: true, turn: t.turn } : {}) };
    writeReceipt({ task: t.id, result });
    return reply(200, result);
  } catch (e) { return reply(409, { error: e.message, task: t?.id }); }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname.startsWith('/api/move/')) {
      if (remoteLib.isRemote(req) || !allowed(req) || req.headers['x-hub'] !== '1') return send(res, 403, { error: 'forbidden' });
      if (req.method === 'GET' && url.pathname === '/api/move/status') return send(res, 200, move.status());
      if (req.method === 'POST' && url.pathname === '/api/move/export') {
        const body = await readBody(req);
        if (move.running || move.busy()) return send(res, 409, { error: 'AI・順番待ち・保存・更新が終わってから引っ越してください' });
        const pending = move.export(body); pending.catch(() => {}); return send(res, 202, move.status());
      }
      if (req.method === 'POST' && url.pathname === '/api/move/reveal') {
        await readBody(req);
        const target = move.status().path;
        if (!target || path.dirname(target) !== move.inbox || !fs.existsSync(target)) return send(res, 409, { error: '作成済みの引っ越しデータがありません' });
        if (process.platform === 'darwin' && !DRY) require('node:child_process').execFile('/usr/bin/open', ['-R', target], () => {});
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/move/trash') return send(res, 200, await move.trash(await readBody(req)));
      return send(res, 409, { error: '読み込みは引っ越しデータを置いてアプリを開き直してください' });
    }
    if (move.running && url.pathname !== '/api/ping') return send(res, 409, { error: '引っ越しデータを作成しています。終了までお待ちください' });
    if(req.method!=='GET'&&!ideaSaveRoute(url.pathname)&&!url.pathname.startsWith('/api/task/history/')&&!['/api/ai/stop','/api/ai/resume','/api/chat/stop','/api/term/stop','/api/task/read','/api/task/body/apply','/api/task/body/recover','/api/task/body/summary','/api/task/continue','/api/task/continue/recover','/api/restart','/api/restart/cancel'].includes(url.pathname)){
    let release;try{release=taskHistory.hold();req.historyWrite=release;}catch(e){return send(res,409,{error:e.message});}
    res.once('finish',release);res.once('close',release);
  }
    if (remoteLib.isRemote(req)) return await reqCtx.run({ remote: true }, () => remoteGate(req, res, url));
    if (!allowed(req)) return send(res, 403, { error: 'forbidden' });
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET') return send(res, 405, { error: 'method' });
    return await serveStatic(req, res, url.pathname);
  } catch (e) {
    return send(res, e.status || 500, { error: String(e.message || e) });
  }
});

function holdStoppedQueue(project,task){chats.holdQueue(project,task);}
const emergencyStop=new (require('./lib/emergency-stop').EmergencyStop)({control:stopControl,chats,sessions,webchat,onPause:scope=>{
  const scopes=scope?[scope]:[...new Map([...chats.running.values()].map(r=>r.options).filter(Boolean).map(o=>[JSON.stringify([o.project,o.task]),o])).values()];
  for(const o of scopes)record('chatstop',o);
},unmanaged:()=>{
  const terminalPids=new Set([...sessions.map.values()].map(s=>s.identity?.pid).filter(Boolean));
  return procwatch.list().filter(p=>p.project&&!chats.supervisedPid(p.pid)&&!terminalPids.has(p.pid)&&!procwatch.hasAncestor(p.pid,pid=>chats.supervisedPid(pid)||terminalPids.has(pid)));
},ancillary:(scope,errors)=>{
  const attempt=fn=>{try{fn();}catch(e){errors.push(e.message);}};
  const scopes=scope?[scope]:[...new Map([...emergencyStop.targets(),...store.listProjects().flatMap(p=>(p.tasks||[]).map(t=>({project:p.id,task:t.id})))].map(o=>[JSON.stringify([o.project,o.task]),o])).values()];
  for(const o of scopes){attempt(()=>holdStoppedQueue(o.project,o.task));attempt(()=>chats.onStop?.(o.project,o.task));attempt(()=>discussion.stop(o.project,o.task));attempt(()=>integrateAuto.stop(o.project,o.task));}
  attempt(()=>{const p=fs.existsSync(ROLES_FILE)?roleHistory.load(ROLES_FILE).journal.review:null;if(p&&(!scope||p.project===scope.project&&p.task===scope.task))roleReview.cancel();});
}});

emergencyRestart=new (require('./lib/emergency-restart').EmergencyRestart)({control:stopControl,stop:()=>emergencyStop.stop(),restart:restartControl,boot:HUB_INSTANCE,
  target:()=>{
    const head=gitw.savedHead(__dirname);
    if(!head||head!==BOOT_HEAD||readVersion()!==VERSION||appUpdate.restartNeeded)throw Error('稼働中と保存済みのHubが異なります。別版へは自動で切り替えません');
    return {head,version:VERSION,dir:__dirname};
  },conflicts:()=>mainMergeFlow.blockers(path.resolve(__dirname,'..'))});
function safeShutdown(){
  if(stopControl.error||stopControl.active||stopControl.data.errors?.length||stopControl.results.some(r=>!['exited','not-started'].includes(r.state)||r.save!=='saved')||chats.running.size||sessions.list().some(s=>s.running)||webchat.busy().length||webchat.control||chats.handoffErrors().length||activeRequests||taskHistory.activeWrites.size||freetalkHistory.activeWrites?.size||taskIntegrate.active||integrateAuto.active||executionGate.leases.size||appUpdate.running||['installing','publishing'].includes(appUpdate.data.phase)||aiTools.isOperating())return false;
  const unknown=emergencyStop.targets();if(!unknown.length)return true;
  const P=require('./lib/owned-processes'),rows=P.snapshot(),terminalPids=new Set([...sessions.map.values()].map(s=>s.identity?.pid));
  return unknown.every(o=>o.kind==='unmanaged'&&P.independentExternal(procwatch.list().find(p=>p.pid===o.pid)||{},rows,pid=>chats.supervisedPid(pid)||terminalPids.has(pid)));
}
function shutdown() { try{if(safeShutdown())stopControl.cleanExit();}catch{/* Uncertain ownership/save keeps the boot barrier armed. */}webchat.shutdown(); aiUpdates.stop(); appUpdate.stop(); procwatch.stop(); sessions.stopAll(); chats.stopAll(); server.close(); process.exit(0); }

roleReview = roleReviewRuntime.createReview({ file:ROLES_FILE, store, chats, tools:aiTools, accounts, usage, limits:limitEvidence, accountFor,
  createTopic:()=>freetalk.createTopic(specialMode.pick(modelView.special(), rolesData(), '司令塔') || modelView.initial(), {title:lt('役割分担の見直し')}),
  applyCatalog:applyModelCatalog, migrated:task=>freetalkHistory.state(task).migrated,
  workDir:isolatedReviewDir, ended:chatEnded,
  blocked:p=>Boolean(stopControl.held(p)||restartControl?.committed || appUpdate.applying() || delegateTerminalError(p.project,p.task) || webchatActive(p.project,p.task)),
  notice:(message,last)=>record('role-review',{}, {message,status:last?.status}) });
if(fs.existsSync(ROLES_FILE)) roleReview.recover();
const roleReviewTimer=setInterval(()=>{if(fs.existsSync(ROLES_FILE))void roleReview.tick().catch(e=>record('role-review-error',{}, {error:e.message}));},1500);roleReviewTimer.unref();
discussion = discussionRuntime.createDiscussion({ file:path.join(ROOT,'_hub','discussions.json'), store, chats, tools:aiTools, accounts, usage, limits:limitEvidence, accountFor, modelError,
  notice:message=>record('discussion-error',{}, {error:message}),
  migrated:(p,t)=>p.kind==='freetalk'&&freetalkHistory.state(t.id).migrated, workDir:isolatedReviewDir, ended:chatEnded,
  blocked:p=>Boolean(stopControl.held(p)||restartControl?.committed||appUpdate.applying()||delegateTerminalError(p.project,p.task)||webchatActive(p.project,p.task)) });
ideaLane=new (require('./lib/idea-lane').IdeaLane)({ideas,store,baseOf,gate:executionGate});
const ideaVerification=new (require('./lib/idea-verification').IdeaVerification)({ideas,lane:ideaLane,gate:executionGate});ideaLane.profiles=ideaVerification;
const ideaReview=new (require('./lib/idea-review').IdeaReview)({ideas,lane:ideaLane,verification:ideaVerification});
ideaDispatch=new (require('./lib/idea-dispatch').IdeaDispatch)({ideas,lane:ideaLane,gate:executionGate,chats,spoolRoot:path.join(ROOT,'_hub','cli-runs'),roles:rolesData,delegate:(b,res,opts)=>{if(DRY){res.writeHead(409);res.end(JSON.stringify({error:'隔離試験では実AIを開始しません'}));return;}return delegateRequest(b,res,opts);},mayStart:(p,r)=>ideaRunner.mayStart(p,r)});
ideaRelease=new (require('./lib/idea-release').IdeaRelease)({ideas,lane:ideaLane,gate:executionGate,verification:ideaVerification,review:ideaReview,git:gitw,versionCheck:dir=>require('./lib/version-check').checkVersion(f=>fs.readFileSync(path.join(dir,f),'utf8'))});
ideaRunner=new (require('./lib/idea-runner').IdeaRunner)({ideas,lane:ideaLane,gate:executionGate,dispatch:ideaDispatch,verification:ideaVerification,review:ideaReview,release:ideaRelease,stopped:p=>Boolean(stopControl.held({project:p})||stopControl.view().tasks.some(t=>t.project===p)),busy:(p,t)=>Boolean(chats.busy(p,t)||webchatActive(p,t)||sessions.list().some(s=>s.running&&s.project===p&&s.task===t)),humanQueued:p=>{const q=store.readProject(p);return q.tasks.some(t=>chats.queue(p,t.id).some(x=>x.automation?.kind!=='idea'));},record:(project,e)=>record('idea-error',{project},{error:e.message})});ideaRelease.runner=ideaRunner;
Object.assign(ideaAPI,{runner:ideaRunner,lane:ideaLane,release:ideaRelease,available:()=>true,wake:p=>{if(!DRY)ideaRunner.wake(p);},authorizeRecord:(req,b)=>ideaDispatch.authorizeRecord(req,b)||[...chats.running.values()].some(x=>x.options?.project===b.project&&x.options?.ideaRecord?.token===req.headers['x-idea-record'])});
ideaRunner.restore();
for(const e of queueRetreat.restore())record('queue-retreat-recovery',e,{error:e.error});
chats.adopt();
const finishedAdoptions=[...chats.running.values()].filter(r=>r.child?.dir&&require('./lib/cli-spool').strictRead(r.child.dir,'exit.json')).map(r=>r.settledP);
const restoreReady=Promise.all(finishedAdoptions).then(()=>{ideaRunner.restored();chats.resumeDeferred();for(const p of store.listProjects())for(const t of p.tasks)try{chats.recoverContinuations(p,t);}catch(e){record('chat-continuation-error',{project:p.id,task:t.id},{error:e.message});}if(!DRY)ideaRunner.start();updateRestoreReady=true;});
restoreReady.catch(e=>record('idea-restore-error',{}, {error:e.message}));
discussion.recover();
const discussionTimer=setInterval(()=>{void discussion.tick().catch(e=>record('discussion-error',{}, {error:e.message}));},1000);discussionTimer.unref();
if (require.main === module) {
  // 新しい版に切り替える時は、前の本体が待ち受けを空けるまで少し待つ
  let tries = 0;
  server.on('error', e => {
    if (e.code === 'EADDRINUSE' && process.env.HUB_RESTART_WAIT && tries++ < 50) return setTimeout(() => server.listen(PORT, '127.0.0.1'), 200);
    console.error(e.code === 'EADDRINUSE' ? lt`ポート ${PORT} は使われています（もう起動しているかもしれません）` : e);
    process.exit(1);
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Project Hub ${VERSION}`);
    console.log(lt`Project Hub: http://127.0.0.1:${PORT}  （台帳の場所: ${ROOT}）`);
    console.log(sessions.available() ? lt('作業画面: 使えます') : lt('作業画面: 部品（node-pty）が未設定。setup.sh を実行してください'));
    console.log(lt('止める時は、この窓で Control + C'));
    if (!DRY) { license.start(); procwatch.start(); appUpdate.start(); aiUpdates.start(); }
  });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

server.on('close', () => { ideaRunner?.close();ideas.close(); license.stop(); clearInterval(discussionTimer); clearInterval(roleReviewTimer);clearInterval(freetalkAutomaticTimer);stateOffers.close(); clearInterval(integrateTimer);clearInterval(terminalLimitTimer);clearInterval(restartTimer); aiUpdates.stop(); });
module.exports = { queueRetreat, store, stopControl, emergencyStop, emergencyRestart, safeShutdown, ideas, ideaAPI, executionGate, ideaRunner, ideaDispatch, ideaLane, ideaRelease, ideaVerification, ideaReview, restoreReady, discussion, roleReview, textBudget, server, PORT, sessions, taskPrompt, aiUpdates, webchat, chats, restartControl, taskIntegrate, integrateAuto, integrationAbandon, bootModules, restartBlockers };
