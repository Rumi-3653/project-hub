'use strict';

module.exports = function taskprogressRoutes(ctx) {
  const { send, lt, getDiscussion, webchatActive, chats, launch, sessions, resultsGate, store, record, reportChild, handoff } = ctx;
  return {
    completion: {
      matches: (req, url) => url.pathname === '/api/task/completion',
      handle(req, res, url, b) {
        if (url.pathname === '/api/task/completion') {
          if (b.confirm !== true) return send(res, 400, { error: lt('完了に移すか確認してください') });
          if (b.action === 'approve' && (getDiscussion().active(b.project,b.task) || webchatActive(b.project,b.task) || chats.running.has(`${b.project}\u0000${b.task}`) || launch.AIS.some(a => { const s = sessions.get(b.project, b.task, a); return s && !s.exited; }))) return send(res, 409, { error: lt('AIが作業中です。終わってから完了を確認してください') });
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
      },
    },
    step: {
      matches: (req, url) => url.pathname === '/api/task/step',
      async handle(req, res, url, b) {
        if (url.pathname === '/api/task/step') {
          const t = typeof b.add === 'string' ? store.addStep(b.project, b.task, b.add) : store.setStep(b.project, b.task, Number(b.index), Boolean(b.done));
          if(t) {
            try { await resultsGate.trigger(b.project,b.task); } catch(e) {record('results-organize-error',b,{error:e.message});}
            const {all,p,t:current}=resultsGate.current(b.project,b.task);
            return send(res,200,resultsGate.decorate(p,current,all));
          }
          return send(res,400,{error:lt('その手順が見つかりません')});
        }
      },
    },
  };
};
