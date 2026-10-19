'use strict';

module.exports = function phaseRoutes(ctx) {
  const { send, lt, store, sessions, chats, record } = ctx;
  return {
    continue: {
      matches: (req, url) => url.pathname === '/api/phase/continue',
      handle(req, res, url, b) {
        if (url.pathname === '/api/phase/continue') {
          const current = store.readProject(b.project);
          if (!current || current.completionHash !== b.expectedHash) return send(res, 409, { error: lt('確認中にフェーズが更新されました') });
          const p = store.continuePhase(b.project); return send(res, 200, p);
        }
      },
    },
    next: {
      matches: (req, url) => url.pathname === '/api/phase/next',
      handle(req, res, url, b) {
        if (url.pathname === '/api/phase/next') {
          if (b.confirm !== true) return send(res, 400, { error: lt('今のフェーズを完了に移すか確認してください') });
          const current = store.readProject(b.project);
          if (!current || b.expectedHash !== current.completionHash) return send(res, 409, { error: lt('確認中にフェーズが更新されました。内容を読み直してください') });
          if (sessions.list().some(x => x.project === b.project && x.running) || [...chats.running.keys()].some(k => k.startsWith(b.project + '\u0000'))) return send(res, 409, { error: lt('このプロジェクトでAIが作業中です。終わってから完了を確認してください') });
          const p = store.nextPhase(b.project);
          if (p) record('nextphase', b);
          return p ? send(res, 200, { ok: true, phases: p.phases }) : send(res, 400, { error: lt('プロジェクトが見つかりません') });
        }
      },
    },
  };
};
