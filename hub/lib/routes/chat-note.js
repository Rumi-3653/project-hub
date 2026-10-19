'use strict';

module.exports = function chatnoteRoutes(ctx) {
  const { send, lt, store, freetalk, chat, chats } = ctx;
  return {
    write: {
      matches: (req, url) => url.pathname === '/api/chat/note',
      handle(req, res, url, b) {
        if (url.pathname === '/api/chat/note') {
          const p = store.readProject(b.project), file = p && store.taskFile(b.project, b.task);
          const text = typeof b.text === 'string' ? b.text.trim() : '';
          if (!file || !text || text.length > 8000) return send(res, 400, { error: lt('作業と依頼を確かめてください') });
          if (p.kind === 'freetalk') freetalk.nameTopic(b.task, text);
          const row = chat.append(p.dir, b.task, { role: 'user', text, to: String(b.to || '').slice(0, 20) });
          chats.emit(p.id, b.task, { type: 'row', row });
          return send(res, 200, { ok: true });
        }
      },
    },
  };
};
