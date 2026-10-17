'use strict';
// Uses Hub's account checks, model discovery and ChatRunner. No separate AI
// process/transport is created here; topics use the existing freetalk creator.
const launch = require('./launch');
const history = require('./role-history');
const { RoleReview } = require('./role-review');
const { lt } = require('./locale');
const isRequest = id => /^(?:limit-)*role-review-/.test(String(id || ''));
// A paid-credit preference elsewhere in Hub never authorizes paid role review.
const heldLimit = (o, limits) => isRequest(o.request || o.id) || o.origin === 'role-review'
  ? limits.active(o.account || 'default', launch.flagFor(o.ai, o.model)) : limits.forRequest(o);
const basePrompt = '役割分担の手動見直しです。設定はHubが結果から保存します。読み取り専用で検討し、ファイル・作業状態・認証を変更せず、この会話に回答してください。';

async function availability(p, targets, d) {
  const participants = [], candidates = [], reasons = [];
  for (const ai of launch.AIS) {
    if (!d.tools.find(ai)) { reasons.push(`${ai}: 未導入`); continue; }
    const account = d.accountFor(p.project, p.task, ai);
    try {
      await d.accounts.readOnly(ai, account, async () => {
        const auth = await d.accounts.status(ai, account, { models: true });
        if (auth.status !== 'logged-in') throw Error(lt('契約ログインを確認できません'));
        const found = auth.modelObservation ? d.tools.saveCatalog(ai, auth.modelObservation) : await d.tools.refresh(ai, {
          env: d.accounts.env(ai, account), cacheDir: d.accounts.location(ai, account), fileAuth: ai === 'codex' && account !== 'default'
        });
        if (!found.ok || found.dry || found.unchanged) throw Error(lt('モデル一覧を新しく確認できません'));
        d.applyCatalog();
        if (['claude', 'codex'].includes(ai)) await d.usage.status(false, { [ai]: account });
        for (const model of found.models) {
          const saved = p.roles.flatMap(r => [r.main, r.backup]).filter(s => (s.ai === 'claude-code' ? 'claude' : s.ai) === ai && launch.flagFor(ai, s.model) === model.id);
          const efforts = model.efforts?.length ? model.efforts : [...new Set(saved.map(s => s.effort).filter(Boolean))];
          // Permanent candidates include held models: a temporary limit must
          // never rewrite the default assignment. Participants exclude them.
          candidates.push({ ai, id: model.id, label: model.label, efforts });
          if (targets.some(t => t.ai === ai && t.model === model.id) && !d.limits.active(account, model.id)) {
            participants.push({ ai, model: model.id, account, effort: saved[0]?.effort || efforts[0] || '' });
          }
        }
        reasons.push(`${ai}: 契約ログイン・モデル一覧を確認`);
        if (targets.some(t => t.ai === ai) && !participants.some(t => t.ai === ai)) reasons.push(`${ai}: 指定モデルが利用上限中、または一覧にありません`);
      });
    } catch (e) { reasons.push(`${ai}: ${e.message}`); }
  }
  participants.sort((a, b) => targets.findIndex(t => t.ai === a.ai) - targets.findIndex(t => t.ai === b.ai));
  return { participants, candidates, reason: reasons.join('\n') };
}

function createReview(d) {
  const target = (project, task) => {
    const p = d.store.readProject(project), t = p?.tasks.find(t => t.id === task);
    if (project !== 'freetalk' || p?.kind !== 'freetalk' || !t || d.migrated(task)) throw Error(lt('見直し用の自由対話の話題が見つかりません'));
    return { p, t };
  };
  const owned = (q, p) => q.id === p.request || q.id === `limit-${p.request}`;
  const review = new RoleReview({ file: d.file, target, createTopic: d.createTopic,
    ready: p => !d.blocked(p) && !d.chats.busy(p.project, p.task) && !d.chats.queue(p.project, p.task).length && !d.tools.isOperating(),
    availability: (p, targets) => availability(p, targets, d),
    removeQueued: p => { if (!p.task) return; for (const q of d.chats.queue(p.project, p.task)) if (owned(q, p)) d.chats.unqueue(p.project, p.task, q.id, true); },
    handoffPending: p => Boolean(d.chats.queue(p.project, p.task).some(q => q.limitSwitch && owned(q, p))),
    pendingError: p => {
      const q = d.chats.queue(p.project, p.task).find(q => owned(q, p));
      if (q?.error && !q.limitWaiting) return q.error;
      if (!q && !d.chats.busy(p.project, p.task)) return lt('見直しが中断されました。設定と最終見直し日時は維持しています');
      return '';
    },
    dispatch: async p => {
      const { p: project, t } = target(p.project, p.task);
      const turn = { project: p.project, task: p.task, pdir: project.dir, dir: d.workDir(project, t),
        ai: p.ai, model: launch.modelLabel(p.ai, p.model), account: p.account, effort: p.effort,
        request: p.request, origin: 'role-review', text: p.text, shown: p.text,
        readOnly: true, isolatedReview: true, requireModel: true, requiredModel: p.model,
        basePrompt, policy: basePrompt, onEnd: () => d.ended(p.project, p.task) };
      d.chats.enqueue(p.project, p.task, { ...turn, id: p.request });
      try {
        const r = await d.chats.sendQueued(turn);
        if (!(await r.started)) throw Error(lt('見直しのAIを起動できませんでした'));
        d.chats.unqueue(p.project, p.task, p.request);
      } catch (e) { d.chats.unqueue(p.project, p.task, p.request); throw e; }
    },
    notice: message => {
      const last = history.load(d.file).journal.lastReview;
      d.notice(message, last);
    }
  });
  review.verify = o => {
    if (!isRequest(o.request)) return;
    const p = history.load(d.file).journal.review;
    if (!p || p.project !== o.project || p.task !== o.task || ![p.request, `limit-${p.request}`].includes(o.request) || o.readOnly !== true || o.isolatedReview !== true) throw Error(lt('この役割見直しは終了または中断されています'));
    const slot = p.plan[p.stage];
    if (!o.limitSwitch && (o.ai !== slot.ai || launch.flagFor(o.ai, o.model) !== slot.model || (o.account || 'default') !== slot.account)) throw Error(lt('役割見直しの指定担当が変わりました'));
  };
  return review;
}
module.exports = { createReview, availability, isRequest, heldLimit, basePrompt };
