'use strict';

module.exports = function informationRoutes(ctx) {
  const { send, procwatch, VERSION, readVersion, changelog, sessions, readLog } = ctx;
  return {
    background: {
      matches: (req, url) => req.method === 'GET' && url.pathname === '/api/background',
      handle(req, res, url) {
        if (req.method === 'GET' && url.pathname === '/api/background') return send(res, 200, { items: procwatch.list() });
      },
    },
    read: {
      matches: (req, url) => req.method === 'GET' && ['/api/version', '/api/changelog', '/api/sessions', '/api/log'].includes(url.pathname),
      handle(req, res, url) {
        if (req.method === 'GET' && url.pathname === '/api/version') return send(res, 200, { version: VERSION, latest: readVersion() });
        if (req.method === 'GET' && url.pathname === '/api/changelog') return send(res, 200, changelog(12));
        if (req.method === 'GET' && url.pathname === '/api/sessions') return send(res, 200, sessions.list());
        if (req.method === 'GET' && url.pathname === '/api/log') return send(res, 200, readLog(Math.min(200, Number(url.searchParams.get('n')) || 50)));
      },
    },
  };
};
