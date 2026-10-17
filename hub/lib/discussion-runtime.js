'use strict';
const launch = require('./launch');
const { Discussion, isRequest, stageName } = require('./discussion');
const basePrompt = '読み取り専用の話し合いです。前のセッションを再開せず、今回渡した話題と意見だけから回答してください。ファイル・作業記録・認証の変更、CLI起動、委任、追加課金・API従量課金は禁止です。';
function createDiscussion(d) {
  const target = (project, task) => {
    const p = d.store.readProject(project), t = p?.tasks.find(t => t.id === task);
    if (!p || !t || t.state === '完了' || d.migrated(p, t)) throw Error('話し合いを始められる作業が見つかりません');
    return { p, t };
  };
  const held = s => d.limits.active(s.account || 'default', s.model, true) ? '契約の利用上限中' : '';
  const discussion = new Discussion({ file: d.file, target, held, notice:d.notice,
    authorize: async slot => d.accounts.readOnly(slot.ai, slot.account, async () => {
      const auth = await d.accounts.status(slot.ai, slot.account);
      if (auth.status !== 'logged-in') throw Error('契約ログインを確認できません');
    }),
    limitModels: () => Object.fromEntries(['claude','codex'].map(ai=>[ai,(d.tools.catalog()[ai]?.models || []).map(m=>m.id)])),
    refreshUsage: async slot => {
      if(!['claude','codex'].includes(slot.ai))return;
      const snapshot=await d.usage.status(false,{[slot.ai]:slot.account});
      // Discussion never spends prepaid credit or follows normal-work fallbacks.
      d.limits.observe(snapshot,discussion.limitModels(),true);
    },
    candidates: (project, task) => launch.AIS.flatMap(ai => {
      const account = d.accountFor(project, task, ai), catalog = d.tools.catalog()[ai];
      return (catalog?.models || []).map(m => {
        const s = { ai, model: m.id, account }, limit = held(s);
        // A CLI without a verified read-only transport is visible but cannot
        // be selected. Never silently run its normal auto-approve transport.
        const unavailable = !d.tools.find(ai) ? '未導入' : !['claude','codex'].includes(ai) ? '読み取り専用・正式上限の判定を未確認' : d.modelError(ai, m.label) || limit;
        return { ai, id: m.id, model: m.label, account, effort: m.efforts?.includes('高') ? '高' : m.efforts?.[0] || (ai === 'agy' ? '' : '高'), held: limit, unavailable };
      });
    }),
    ready: p => !d.blocked(p) && !d.chats.busy(p.project, p.task) && !d.chats.queue(p.project, p.task).length && !d.tools.isOperating(),
    cancelRun: p => { for (const q of d.chats.queue(p.project, p.task)) if (isRequest(q.id)) d.chats.unqueue(p.project, p.task, q.id, true); d.chats.stop(p.project, p.task); },
    changed: p => d.chats.emit(p.project, p.task, { type: 'discussion', ...discussion.view(p.project, p.task) }),
    dispatch: async (p, slot, text) => {
      const { p: project, t } = target(p.project, p.task);
      await discussion.authorize(slot);
      await discussion.refreshUsage(slot);
      if (held(slot)) { discussion.exclude(p, slot, held(slot)); return; }
      const turn = { project: p.project, task: p.task, pdir: project.dir, dir: d.workDir(project, t), ai: slot.ai,
        model: slot.label, account: slot.account, effort: slot.effort, request: slot.request, origin: 'discussion',
        discussionTurn: true, discussion: { id: p.id, kind: slot.kind, round: slot.round, name: `${launch.AI_LABEL[slot.ai]}・${slot.label}`, stage: stageName(slot), summary: slot.kind === 'summary' },
        text, shown: `【話し合い・${stageName(slot)}】${p.text}`, readOnly: true, requireModel: true, requiredModel: slot.model,
        basePrompt, policy: basePrompt, onEnd: () => d.ended(p.project, p.task) };
      const r = await d.chats.send(turn);
      if (!(await r.started)) throw Error('話し合いのAIを起動できませんでした');
    }
  });
  return discussion;
}
module.exports = { createDiscussion, isRequest, basePrompt };
