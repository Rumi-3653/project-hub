'use strict';

module.exports = function usageRoutes(ctx) {
  const { send, usage, usageSelection, usageWithLimit, accounts, PORT, lt } = ctx;
  return {
    read: {
      matches: (req, url) => req.method === 'GET' && url.pathname === '/api/usage',
      async handle(req, res, url) {
        const origin = req.headers.origin;
        if (req.headers['x-hub'] !== '1' || origin && ![`http://127.0.0.1:${PORT}`,`http://localhost:${PORT}`].includes(origin)) return send(res,403,{ error:'forbidden' });
        return send(res, 200, usageWithLimit(await usage.status(false, usageSelection(url))));
      },
    },
    write: {
      matches: (req, url) => req.method === 'POST' && ['/api/usage/refresh', '/api/usage/reset'].includes(url.pathname),
      async handle(req, res, url, b) {
        if (req.method === 'POST' && url.pathname === '/api/usage/refresh') return send(res, 200, usageWithLimit(await usage.status(true, usageSelection(url, b))));
        if (req.method === 'POST' && url.pathname === '/api/usage/reset') {
          if (!b || b.ai !== 'codex' || typeof b.account !== 'string' || b.confirmed !== true || typeof b.token !== 'string' || b.retry !== undefined && typeof b.retry !== 'boolean') return send(res, 400, { error:lt('チケット使用の指定が正しくありません') });
          try {
            accounts.get('codex', b.account);
            const result = await usage.useReset(b.account, b.token, { confirmed:true, retry:b.retry, selection:usageSelection(url, b) });
            return send(res, 200, { ...result, usage:usageWithLimit(result.usage) });
          } catch (e) { return send(res, e.status || 409, { error:e.publicMessage || lt('チケットを使用できませんでした。利用状況を再確認してください') }); }
        }
      },
    },
  };
};
