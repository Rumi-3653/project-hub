'use strict';

module.exports = function createLimitEngine(ctx) {
  const { getTerminalLimits, accountFor, getAccounts, getAiTools, getAppUpdate, assertWorkspaceIdle, getBuildHandoffCard, getCaptureTerminalLimit, getChat, getChats, codexFastFor, crypto, getDiscussion, discussionRuntime, expandHome, extensions, fs, getGitSnapshot, integrationPolicyRequest, launch, license, getLimitEvidence, lt, modelError, getModelView, path, permCmd, record, getRestartControl, roleReviewRuntime, rolesData, getSessions, setUnread, getStopControl, getStore, taskPrompt, getTranscript, getUsage, verifyIntegrationAssignmentSend } = ctx;

  const limitSwitchPolicy=extensions.create('limit_switch',{license:Object.freeze({require:features=>license.require(features)}),rolesData,modelView:Object.freeze({special:()=>(getModelView()).special()}),discussionRuntime,integrationPolicyRequest,store:Object.freeze({readProject:project=>(getStore()).readProject(project)}),accountFor,permCmd,capacityOptions});

  function limitModels() {
    const out = { claude: [...require('../model-limits').MODELS.claude], codex: [...require('../model-limits').MODELS.codex] };
    for (const r of rolesData().roles) for (const slot of [r.main, r.backup]) {
      const ai = slot.ai === 'claude-code' ? 'claude' : slot.ai, flag = launch.flagFor(ai, slot.model);
      if (out[ai] && flag && !out[ai].includes(flag)) out[ai].push(flag);
    }
    return out;
  }

  function roleReviewLimit(request) {
    return roleReviewRuntime.heldLimit ? roleReviewRuntime.heldLimit(request, (getLimitEvidence())) : (getLimitEvidence()).forRequest(request);
  }

  async function refreshLimitEvidence(request) {
    verifyIntegrationAssignmentSend(request);
    if (discussionRuntime.isRequest(request.request)) { (getDiscussion()).verify(request); return; }
    if (!['claude', 'codex'].includes(request.ai)) return;
    if (rolesData().checkCredits[request.ai]) await (getUsage()).checkCredits(request.ai, request.account || 'default');
    if (integrationPolicyRequest(request)) {
      if (!(getLimitEvidence()).active(request.account || 'default',launch.flagFor(request.ai,request.model))) await (getUsage()).status(false,{[request.ai]:request.account || 'default'});
      return;
    }
    if (!limitRoutingEnabled()) return;
    const target = roleReviewLimit(request) ? limitBackup(request) : request;
    if (!target || !['claude', 'codex'].includes(target.ai)) return;
    // 元担当が保持中でも、確認ONの交代先は起動前に既存クレジットを判定する。
    if (target !== request && rolesData().checkCredits[target.ai]) await (getUsage()).checkCredits(target.ai, target.account || 'default');
    if (roleReviewLimit({ ...request, ...target })) return;
    // 状態だけ読む（prompt/turnは送らない）。TTL/アカウント隔離はUsageの共通経路。
    await (getUsage()).status(false, { [target.ai]: target.account || 'default' });
  }

  function limitRoutingEnabled() { return limitSwitchPolicy.enabled(); }

function capacityOptions() {
  return { models: (getAiTools()).catalog().codex?.models || [], available: (models, account) =>
    (getUsage()).subscriptionAvailable(models, account) && !models.some(model => (getLimitEvidence()).active(account, model, true)) };
}
async function capacityBackup(o) {
  const account = o.account || 'default';
  if (accountFor(o.project, o.task, 'codex') !== account ||
      !limitSwitchPolicy.backup(o, 'capacity', { ...capacityOptions(), available: () => true })) return null;
  // Fixed contract-status request only, after the failed CLI has exited. A long
  // turn's old cache must not be mistaken for remaining subscription quota.
  await (getUsage()).status(true, { codex: account }, { only: { ai: 'codex', account } });
  return limitBackup(o, 'capacity');
}
function assertCapacityHandoff(o) {
  const link = o.limitSwitch;
  if (link?.reason !== 'capacity') return;
  const account = o.account || 'default';
  const source = { ...o, ai: link.sourceAI, model: link.sourceModel, effort: link.sourceEffort, limitSwitch: null };
  const options = capacityOptions(), target = limitSwitchPolicy.backup(source, 'capacity', options);
  const current = launch.flagFor(o.ai, o.model), row = options.models.find(m => m.id === current);
  if (o.ai !== 'codex' || account !== (link.sourceAccount || 'default') ||
      accountFor(o.project, o.task, 'codex') !== account || target?.requiredModel !== current ||
      o.requiredModel !== current || Array.isArray(row?.efforts) && !row.efforts.includes(o.effort)) {
    throw Error('モデル混雑の自動再開条件（契約枠の残量・同じアカウント・最新のSol／Astra候補）を確認できないため、待機します');
  }
}

  function limitBackup(o, reason) { return limitSwitchPolicy.backup(o, reason); }

  function terminalLimitNotice(o, text) {
    const p = (getStore()).readProject(o.project); if (!p) return;
    const row = (getChat()).append(p.dir, o.task, { role: 'event', ai: o.ai, text });
    (getChats()).emit(o.project, o.task, { type: 'row', row }); setUnread(o.project, o.task, true);
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
    return (getSessions()).list().some(r => r.running && r.project === p.id && r.task === t.id && r.ai !== exceptAI) || (getChats()).busy(p.id, t.id);
  }

  async function terminalLimitHandoff(o, src) {
    const stopTicket=(getStopControl()).ticket(o);if((getStopControl()).held(o))return;
    const p = (getStore()).readProject(o.project), t = p?.tasks.find(t => t.id === o.task);
    if (!p || !t || t.state === '完了') throw Error(lt('作業が見つからないか完了したため、交代先を開始していません'));
    if (!src.exited || src.stopped) return;
    let backup = limitBackup(o); if (!backup) return;
    const file = (getStore()).taskFile(p.id, t.id), board = path.join(p.dir, '.ai', 'board.md');
    const from = `${launch.AI_LABEL[o.ai]}・${launch.modelLabel(o.ai, o.model)}`;
    const original = src.original || src.prompt || '';
    const packetFile = path.join(p.dir, '.ai', 'handoff', `${t.id}-limit-${src.started}.md`);
    const convo = (getTranscript()).collect({ ai: o.ai, dir: src.dir, since: src.started, buf: src.buf, accountDir: (getAccounts()).location(o.ai, src.account), source: src.limitWatch?.file });
    const pending = { pending: true, task: t.id, packet: packetFile, dir: src.dir, original, sourceAI: o.ai, sourceModel: o.model, role: o.role, from };
    const savePacket = () => {
      pending.to = `${launch.AI_LABEL[backup.ai]}・${backup.model}`;
      const card = (getBuildHandoffCard())({ original, user: { head: src.head, status: src.status }, rows: [], dir: src.dir, pdir: p.dir, task: t.id, from, to: pending.to });
      fs.mkdirSync(path.dirname(packetFile), { recursive: true });
      fs.writeFileSync(packetFile, card + '\n\n' + (getTranscript()).packet({ fromLabel: from, toLabel: pending.to, taskFile: file, board, convo, extra: lt('済んだ手順・変更・送信済み委任を繰り返さず、残りを続ける。操作記録も確認する。') }));
      saveTerminalPending(p, t, pending); // 起動失敗/両方上限でも資料と続きを残す。
    };
    savePacket();
    await refreshLimitEvidence({...o,...backup});
    if (src.stopped || (getStopControl()).held(o) || (getStopControl()).changed(o,stopTicket)) return;
    const latest = limitBackup(o); if (!latest) return;
    if (JSON.stringify(latest) !== JSON.stringify(backup)) { backup = latest; savePacket(); await refreshLimitEvidence({...o,...backup}); }
    if (JSON.stringify(limitBackup(o)) !== JSON.stringify(backup)) throw Error(lt('交代先の設定が変更されたため、資料を保存して待機します'));
    if (src.stopped || (getStopControl()).held(o) || (getStopControl()).changed(o,stopTicket)) return;
    if ((getAppUpdate()).applying()) throw Error((getAppUpdate()).busyMessage());
    if ((getAiTools()).isOperating(backup.ai)) throw Error(lt('AI の更新・モデル再取得が進行中です'));
    const current = (getStore()).readProject(p.id)?.tasks.find(t => t.id === o.task);
    if (!current || current.state === '完了') throw Error(lt('作業が見つからないか完了したため、交代先を開始していません'));
    if ((getLimitEvidence()).forRequest(backup)) throw Error(lt('引き継ぎ先も上限中のため待機します。資料を保存しました。解除後にターミナルで再開してください'));
    if (terminalBusy(p, t)) throw Error(lt('同じ作業で別のAIが動いているため、資料を保存して待機します'));
    assertWorkspaceIdle(p, t, false);
    if (!fs.existsSync(src.dir) || expandHome(current.workdir) && !(getTranscript()).same(expandHome(current.workdir), src.dir)) throw Error(lt('作業場所が変わったため、交代先を開始していません'));
    const invalid = modelError(backup.ai, backup.model); if (invalid) throw Error(invalid);
    (getAccounts()).available(backup.ai, backup.account, { forWork: true });
    const limitMarker = crypto.randomUUID();
    const prompt = lt`利用上限による交代です。引き継ぎ資料 ${packetFile} を読み、実物を確かめて残りを続けてください。` + '\n' + taskPrompt(p, t, file, src.dir, 'terminal', backup) + `\n[Hub terminal: ${limitMarker}]`;
    const argv = launch.buildArgv({ ...backup, prompt, cmd: permCmd(backup.ai), fast: codexFastFor(p.id, t.id) });
    const next = (getSessions()).start({ project: p.id, task: t.id, dir: src.dir, ...backup, ...(getGitSnapshot())(src.dir), prompt, limitMarker, command: argv.command, args: argv.args });
    next.original = original;
    saveTerminalPending(p, t, { ...pending, pending: false });
    terminalLimitNotice(o, lt`${from} の終了を確認し、同じターミナル作業を ${pending.to} で続けます`);
  }

  function installTerminal() {
  (getSessions()).prepare = o => ['claude', 'codex'].includes(o.ai) ? (getCaptureTerminalLimit())(o.ai, (getAccounts()).location(o.ai, o.account), o.limitMarker) : null;
  const terminalLimits = new (getTerminalLimits())({ sessions: (getSessions()), limits: (getLimitEvidence()), enabled: () => limitRoutingEnabled(),
    backup: limitBackup, handoff: terminalLimitHandoff, refresh: refreshLimitEvidence, notify: terminalLimitNotice });
  (getSessions()).onExit = (project, task, ai, s) => {
    if (!s?.stopped && !(s?.watchers.size > 0)) setUnread(project, task, true);
    void terminalLimits.check(project, task, ai, s, true).catch(e => terminalLimitNotice({ project, task, ai }, e.message));
  };
  const terminalLimitTimer = setInterval(() => { if((getRestartControl())?.committed)return; void terminalLimits.tick().catch(e => record('terminal-limit-error', {}, { error: e.message })); }, 2000);
  terminalLimitTimer.unref();
  return { terminalLimits, terminalLimitTimer };
  }

  return { capacityBackup, assertCapacityHandoff, limitModels, roleReviewLimit, refreshLimitEvidence, limitRoutingEnabled, limitBackup, terminalLimitNotice, terminalPendingFile, terminalPending, saveTerminalPending, terminalBusy, terminalLimitHandoff, installTerminal };
};
