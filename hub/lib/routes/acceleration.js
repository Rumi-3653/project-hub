'use strict';

module.exports = function accelerationRoutes(ctx) {
  const { send, acceleration, record } = ctx;
  return {
    write: {
      matches: (req, url) => url.pathname === '/api/acceleration',
      handle(req, res, url, b) {
        if (url.pathname === '/api/acceleration') {
          const saved = acceleration.save(b);
          record('acceleration', {}, saved);
          return send(res, 200, saved);
        }
      },
    },
  };
};
