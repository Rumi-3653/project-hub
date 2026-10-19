'use strict';

module.exports = function taskmanagementRoutes(ctx) {
  const { send, lt, store, fs, acceleration, chat, record, webchatActive, sessions, chats, emptyLib, removal } = ctx;
  return {
    acceleration: {
      matches: (req, url) => url.pathname === '/api/acceleration/task',
      handle(req, res, url, b) {
        const p = store.readProject(b.project), file = p && store.taskFile(p.id, b.task);
        if (!file || !fs.existsSync(file)) return send(res, 404, { error: lt('作業が見つかりません') });
        if (typeof b.on !== 'boolean') return send(res, 400, { error: lt('加速はオン・オフで指定してください') });
        if (b.on && !acceleration.settings().codexAllowed) return send(res, 409, { error: lt('設定で加速を使えるようにしてください') });
        const meta = chat.readMeta(p.dir, b.task); meta.codexFast = b.on;
        chat.writeMeta(p.dir, b.task, meta);
        record('task-acceleration', { project: p.id, task: b.task }, { codexFast: b.on });
        return send(res, 200, { codexFast: b.on });
      },
    },
    empty: {
      matches: (req, url) => url.pathname === '/api/empty/scan' || url.pathname === '/api/empty/trash',
      handle(req, res, url, b) {
        const busy = (project, task) => webchatActive(project, task) || sessions.list().some(x => x.running && x.project === project && x.task === task) || Boolean(chats.busy(project, task));
        if (url.pathname === '/api/empty/scan') return send(res, 200, { ok: true, items: emptyLib.scan(store, busy) });
        const r = emptyLib.trash(store, busy, Array.isArray(b.items) ? b.items : []);
        record('emptytrash', {}, { moved: r.moved });
        return send(res, 200, { ok: true, ...r });
      },
    },
    tidy: {
      matches: (req, url) => url.pathname === '/api/task/tidy/preview' || url.pathname === '/api/task/tidy/apply',
      handle(req, res, url, b) {
        try {
          if (url.pathname.endsWith('/preview')) return send(res, 200, removal.tidyPreview(b.project, b.task));
          const result = removal.tidyApply(b); record('tasktidy', b, { transaction: result.record, moved: result.moved.length }); return send(res, 200, result);
        } catch (e) { return send(res, 409, { error: e.message }); }
      },
    },
    create: {
      matches: (req, url) => url.pathname === '/api/task/new',
      handle(req, res, url, b) {
        const t = store.createTask(b.project, b);
        if (t) record('newtask', { project: b.project, task: t.id }, { title: t.title });
        return t ? send(res, 200, t) : send(res, 400, { error: lt('作業名・親作業・派生元を確認してください') });
      },
    },
  };
};
