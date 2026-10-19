'use strict';

module.exports = function rolesettingsRoutes(ctx) {
  const { send, lt, roleHistory, ROLES_FILE, roles } = ctx;
  return {
    history: {
      matches: (req, url) => req.method === 'GET' && url.pathname === '/api/roles/history',
      handle(req, res, url, b) {
        const current = roleHistory.load(ROLES_FILE);
        return send(res,200,{...roleHistory.summary(current),history:current.journal.history,defaults:current.journal.defaults});
      },
    },
    write: {
      matches: (req, url) => url.pathname === '/api/roles',
      handle(req, res, url, b) {
        if (!Array.isArray(b.roles)) return send(res, 400, { error: lt('形式が違います') });
        const r = roles.write(ROLES_FILE, b.roles, b.checkCredits, false, b.preferCredits, { expectedRevision: b.expectedRevision });
        return r.ok ? send(res, 200, r.data) : send(res, r.status || 400, { error: r.errors.join(' / ') });
      },
    },
    defaults: {
      matches: (req, url) => url.pathname === '/api/roles/default',
      handle(req, res, url, b) {
        const r = roles.saveDefault(ROLES_FILE, b.roles, b.expectedRevision);
        return r.ok ? send(res, 200, r.data) : send(res, r.status || 400, { error: r.errors.join(' / ') });
      },
    },
    restore: {
      matches: (req, url) => url.pathname === '/api/roles/restore',
      handle(req, res, url, b) {
        const current = roleHistory.load(ROLES_FILE);
        if (!b.expectedRevision || b.expectedRevision !== current.revision) return send(res,409,{error:lt('役割設定が変わりました。読み直してください')});
        const row = b.defaults === true ? current.journal.defaults : roleHistory.select(current.journal,b);
        if (!row) return send(res,409,{error:lt('デフォルトはまだ保存されていません')});
        const r = roles.write(ROLES_FILE, row.roles, undefined, true, undefined, {
          expectedRevision:b.expectedRevision, restore:true, kind:b.defaults === true ? 'default' : 'restore',
          reason:b.defaults === true ? lt('固定したデフォルトに戻した') : lt('履歴の設定に戻した') + `（${row.at}）`
        });
        return r.ok ? send(res,200,r.data) : send(res,r.status || 400,{error:r.errors.join(' / ')});
      },
    },
  };
};
