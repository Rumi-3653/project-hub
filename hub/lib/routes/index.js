'use strict';

// Registration describes dependencies and named dispatch slots, not execution
// order. server.js keeps each slot at its original position among common guards.
function createRoutes(registrations) {
  const groups = Object.create(null);
  for (const { name, create, ctx } of registrations) {
    if (!/^[a-z][a-z0-9-]*$/.test(name) || Object.hasOwn(groups, name) || typeof create !== 'function') throw Error('invalid route group');
    const slots = create(Object.freeze(ctx));
    for (const route of Object.values(slots)) {
      if (typeof route.matches !== 'function' || typeof route.handle !== 'function') throw Error('invalid route slot');
      Object.freeze(route);
    }
    groups[name] = Object.freeze(slots);
  }
  return Object.freeze(groups);
}

module.exports = { createRoutes };
