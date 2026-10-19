'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createRoutes } = require('../lib/routes');
const create = require('../lib/routes/language');
const url = pathname => new URL(pathname, 'http://localhost');
function fixture(options = {}) {
  const events = [], ctx = {
    ROOT: 'existing-root', VERSION: '4.124.2', send: (res, status, body) => ({ status, body }),
    localeConfig: () => ({ language: 'ja' }), fromRemote: () => false, allowed: () => true,
    readBody: async () => { events.push('read'); return { language: 'ja', dir: 'pack', id: 'pack' }; },
    langpacks: {
      packSettings: (...args) => { events.push(['settings', ...args]); return { language: 'ja' }; },
      importPack: (...args) => events.push(['import', ...args]),
      removePack: (...args) => events.push(['remove', ...args]),
      selectLanguage: (...args) => events.push(['select', ...args]),
    }, ...options,
  };
  return { routes: createRoutes([{ name: 'language', create, ctx }]), ctx, events };
}
test('route registration freezes only the dependency table and slots; shared objects retain identity', () => {
  const { routes, ctx } = fixture();
  assert.ok(Object.isFrozen(routes) && Object.isFrozen(routes.language) && Object.isFrozen(routes.language.packs) && Object.isFrozen(ctx));
  assert.equal(Object.isFrozen(ctx.langpacks), false);
  assert.throws(() => createRoutes([{ name: 'same', create, ctx }, { name: 'same', create, ctx }]), /invalid route group/);
  assert.throws(() => createRoutes([{ name: 'bad', create: () => ({ read: {} }), ctx: {} }]), /invalid route slot/);
});
test('language slots preserve method and exact path matching', async () => {
  const { routes } = fixture(), { locale, packs } = routes.language;
  assert.equal(locale.matches({ method: 'GET' }, url('/api/locale')), true);
  assert.equal(locale.matches({ method: 'POST' }, url('/api/locale')), false);
  assert.equal(packs.matches({ method: 'DELETE' }, url('/api/langpacks/remove')), true);
  assert.equal(packs.matches({}, url('/api/langpacks/unknown')), false);
  assert.deepEqual(await locale.handle({}, {}), { status: 200, body: { language: 'ja' } });
});
test('language remote and X-Hub checks run before body reads or settings', async () => {
  for (const options of [{ fromRemote: () => true }, { allowed: () => false }]) {
    const { routes, events } = fixture(options);
    assert.deepEqual(await routes.language.packs.handle({ method: 'POST' }, {}, url('/api/language')), { status: 403, body: { error: 'forbidden' } });
    assert.deepEqual(events, []);
  }
});
test('language list and unsupported methods never consume the body', async () => {
  const { routes, events } = fixture(), route = routes.language.packs;
  assert.equal((await route.handle({ method: 'GET' }, {}, url('/api/langpacks'))).status, 200);
  assert.deepEqual(events, [['settings', 'existing-root', '4.124.2']]);
  events.length = 0;
  for (const [method, pathname] of [['POST', '/api/langpacks'], ['GET', '/api/language'], ['DELETE', '/api/langpacks/remove']]) assert.deepEqual(await route.handle({ method }, {}, url(pathname)), { status: 405, body: { error: 'method' } });
  assert.deepEqual(events, []);
});
test('language mutations use the existing root then return current settings', async () => {
  for (const [pathname, action, value] of [['/api/language', 'select', 'ja'], ['/api/langpacks/import', 'import', 'pack'], ['/api/langpacks/remove', 'remove', 'pack']]) {
    const { routes, events } = fixture();
    assert.equal((await routes.language.packs.handle({ method: 'POST' }, {}, url(pathname))).status, 200);
    assert.deepEqual(events, ['read', [action, 'existing-root', value], ['settings', 'existing-root', '4.124.2']]);
  }
});
test('language invalid bodies and storage errors remain 400 with the original message', async () => {
  for (const body of [null, [], 'ja']) {
    const { routes, events } = fixture({ readBody: async () => body });
    assert.deepEqual(await routes.language.packs.handle({ method: 'POST' }, {}, url('/api/language')), { status: 400, body: { error: '形式が違います' } });
    assert.deepEqual(events, []);
  }
  const { routes } = fixture({ readBody: async () => { throw Error('read failed'); } });
  assert.deepEqual(await routes.language.packs.handle({ method: 'POST' }, {}, url('/api/language')), { status: 400, body: { error: 'read failed' } });
});
