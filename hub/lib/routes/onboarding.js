'use strict';

module.exports = function onboardingRoutes(ctx) {
  const { send, onboarding, lt } = ctx;
  return {
    write: {
      matches: (req, url) => ['/api/onboarding', '/api/onboarding/check'].includes(url.pathname),
      async handle(req, res, url, b) {
        if (url.pathname === '/api/onboarding') return send(res, 200, { onboarding: onboarding.save(b) });
        if (url.pathname === '/api/onboarding/check') {
          if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some(k => k !== 'ais')) return send(res, 400, { error: lt('確認の指定が正しくありません') });
          return send(res, 200, await onboarding.check(b.ais));
        }
      },
    },
  };
};
