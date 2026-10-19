'use strict';

module.exports = function model_infoRoutes(ctx) {
  const { send, aiUpdates, applyModelCatalog, listSkills, accounts, rolesData, launch, cliModelHints, acceleration } = ctx;
  return {
    tools: {
      matches: (req, url) => req.method === 'GET' && url.pathname === '/api/ai-tools',
      handle(req, res, url) {
        if (req.method === 'GET' && url.pathname === '/api/ai-tools') {
          const status = aiUpdates.status();
          applyModelCatalog();
          return send(res, 200, status);
        }
      },
    },
    skills: {
      matches: (req, url) => req.method === 'GET' && url.pathname === '/api/skills',
      handle(req, res, url) {
        if (req.method === 'GET' && url.pathname === '/api/skills') return send(res, 200, listSkills({ accounts, fresh: url.searchParams.get('fresh') === '1' }));
      },
    },
    models: {
      matches: (req, url) => req.method === 'GET' && ['/api/cli-models', '/api/acceleration'].includes(url.pathname),
      handle(req, res, url) {
        if (req.method === 'GET' && url.pathname === '/api/cli-models') {
          const m = rolesData().models;
          const rows = ai => (m[launch.AI_KEY[ai]] || []).map(name => ({ name, flag: launch.flagFor(ai, name), set: Object.prototype.hasOwnProperty.call(launch.getOverrides()[ai] || {}, name) }));
          return send(res, 200, { claude: rows('claude'), codex: rows('codex'), agy: rows('agy'), grok: rows('grok'), hints: cliModelHints(), acceleration: acceleration.settings() });
        }
        if (req.method === 'GET' && url.pathname === '/api/acceleration') return send(res, 200, acceleration.settings());
      },
    },
  };
};
