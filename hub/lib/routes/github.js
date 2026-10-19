'use strict';

module.exports = function githubRoutes(ctx) {
  const { send, github, store, githubProject, record, lt } = ctx;
  return {
    read: {
      matches: (req, url) => req.method === 'GET' && url.pathname === '/api/github',
      async handle(req, res, url) {
        return send(res, 200, { ...await github.status({ fresh: url.searchParams.get('fresh') === '1' }), settings: github.settings() });
      },
    },
    write: {
      matches: (req, url) => ['/api/github', '/api/github/owners', '/api/github/repositories', '/api/github/connect-preview', '/api/github/connect', '/api/github/preview', '/api/github/create'].includes(url.pathname),
      async handle(req, res, url, b) {
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
      },
    },
  };
};
