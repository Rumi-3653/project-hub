'use strict';

module.exports = function languageRoutes(ctx) {
  const { send, localeConfig, fromRemote, allowed, langpacks, ROOT, VERSION, readBody } = ctx;
  return {
    locale: {
      matches: (req, url) => req.method === 'GET' && url.pathname === '/api/locale',
      handle: (req, res) => send(res, 200, localeConfig()),
    },
    packs: {
      matches: (req, url) => ['/api/langpacks', '/api/langpacks/import', '/api/langpacks/remove', '/api/language'].includes(url.pathname),
      async handle(req, res, url) {
        if (fromRemote() || !allowed(req)) return send(res, 403, { error: 'forbidden' });
        if (req.method === 'GET' && url.pathname === '/api/langpacks') return send(res, 200, langpacks.packSettings(ROOT, VERSION));
        if (req.method !== 'POST' || url.pathname === '/api/langpacks') return send(res, 405, { error: 'method' });
        try {
          const body = await readBody(req);
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('形式が違います');
          if (url.pathname === '/api/langpacks/import') langpacks.importPack(ROOT, body.dir);
          else if (url.pathname === '/api/langpacks/remove') langpacks.removePack(ROOT, body.id);
          else langpacks.selectLanguage(ROOT, body.language);
          return send(res, 200, langpacks.packSettings(ROOT, VERSION));
        } catch (error) { return send(res, 400, { error: error.message }); }
      },
    },
  };
};
