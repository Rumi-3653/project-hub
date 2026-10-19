'use strict';

module.exports = function taskcopyRoutes(ctx) {
  const { send, lt, store, copyMissing, lastMerge, record, inWork } = ctx;
  return {
    clear: {
      matches: (req, url) => url.pathname === '/api/task/copyclear',
      handle(req, res, url, b) {
        if (url.pathname === '/api/task/copyclear') {
          const p = store.readProject(b.project), file = p && store.taskFile(b.project, b.task), t = file && store.readTask(file);
          if (!t) return send(res, 400, { error: lt('作業が見つかりません') });
          if (!copyMissing(p, t)) return send(res, 409, { error: lt('作業用コピーはまだあります（片付けるのは、場所が無い時だけ）') });
          const m = lastMerge(p.id, t.id);
          const done = store.updateTask(p.id, t.id, { workdir: '', memo: m ? lt('本体に取り込み済み。作業用コピーの古い記録を片付けた') : lt('作業用コピーの古い記録を片付けた') });
          record('copyclear', b, { merged: Boolean(m) });
          return send(res, 200, { ok: true, merged: Boolean(m), task: done });
        }
      },
    },
    exclusion: {
      matches: (req, url) => url.pathname === '/api/task/merge-exclusion',
      handle(req, res, url, b) {
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
      },
    },
  };
};
