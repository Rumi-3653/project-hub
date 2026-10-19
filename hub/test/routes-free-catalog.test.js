'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const send = (res, status, body) => ({ status, body });
const url = p => new URL(p, 'http://localhost:4545');
const get = { method: 'GET' };

test('information reads current host values and preserves log limits and route methods', async () => {
  let latest = 'saved-one', live = ['first'];
  const route = require('../lib/routes/information')({ send, VERSION: 'boot', readVersion: () => latest, changelog: n => [n], sessions: { list: () => live }, readLog: n => n, procwatch: { list: () => ['background'] } });
  assert.deepEqual((await route.read.handle(get, {}, url('/api/version'))).body, { version: 'boot', latest });
  latest = 'saved-two'; live = ['second'];
  assert.equal((await route.read.handle(get, {}, url('/api/version'))).body.latest, latest);
  assert.deepEqual((await route.read.handle(get, {}, url('/api/sessions'))).body, live);
  assert.deepEqual((await route.read.handle(get, {}, url('/api/changelog'))).body, [12]);
  for (const [query, expected] of [['', 50], ['?n=0', 50], ['?n=999', 200], ['?n=-2', -2]]) assert.equal((await route.read.handle(get, {}, url('/api/log' + query))).body, expected);
  assert.deepEqual((await route.background.handle(get, {}, url('/api/background'))).body, { items: ['background'] });
  assert.equal(route.read.matches({ method: 'POST' }, url('/api/version')), false);
  assert.equal(route.read.matches(get, url('/api/version/extra')), false);
});

test('information failure propagates without manufacturing a successful response', async () => {
  let replies = 0;
  const route = require('../lib/routes/information')({ send: () => { replies++; }, sessions: { list: () => { throw Error('read failed'); } } });
  assert.throws(() => route.read.handle(get, {}, url('/api/sessions')), /read failed/);
  assert.equal(replies, 0);
});

test('model information captures status before catalog application and reads fresh skill options', () => {
  const calls = [], accounts = {};
  const routes = require('../lib/routes/model-info')({ send, aiUpdates: { status: () => { calls.push('status'); return { known: true }; } }, applyModelCatalog: () => calls.push('catalog'), accounts, listSkills: o => { calls.push(o); return ['skill']; } });
  assert.deepEqual(routes.tools.handle(get, {}, url('/api/ai-tools')).body, { known: true });
  assert.deepEqual(calls, ['status', 'catalog']);
  assert.deepEqual(routes.skills.handle(get, {}, url('/api/skills?fresh=1')).body, ['skill']);
  assert.deepEqual(calls[2], { accounts, fresh: true });
  routes.skills.handle(get, {}, url('/api/skills?fresh=true'));
  assert.equal(calls[3].fresh, false);
  assert.equal(routes.tools.matches({ method: 'POST' }, url('/api/ai-tools')), false);
});

test('model information uses current role catalog, flags and acceleration settings', () => {
  const acceleration = { enabled: true }, calls = [];
  const route = require('../lib/routes/model-info')({ send, rolesData: () => ({ models: { codex: ['model'] } }), launch: { AI_KEY: { codex: 'codex' }, flagFor: (ai, name) => ai + ':' + name, getOverrides: () => ({ codex: { model: 'flag' } }) }, cliModelHints: () => ['hint'], acceleration: { settings: () => { calls.push('settings'); return acceleration; } } }).models;
  const body = route.handle(get, {}, url('/api/cli-models')).body;
  assert.deepEqual(body.codex, [{ name: 'model', flag: 'codex:model', set: true }]);
  assert.deepEqual(body.hints, ['hint']); assert.equal(body.acceleration, acceleration);
  assert.equal(route.handle(get, {}, url('/api/acceleration')).body, acceleration);
  assert.equal(calls.length, 2);
  assert.equal(route.matches(get, url('/api/limits/clear')), false);
});

test('hierarchy removal backs up ideas before apply, then prunes and records only after success', async () => {
  const calls = [], target = { project: 'project' };
  const removal = { tokens: new Map([['token', { d: target }]]), apply: b => { calls.push(['apply', b]); return { record: 'receipt', moved: ['one'] }; } };
  const route = require('../lib/routes/hierarchy')({ send, removal, ideas: { resolve: id => id, backup: (...args) => calls.push(['backup', ...args]) }, crypto: { randomUUID: () => 'backup-id' }, pruneUnread: () => calls.push(['prune']), record: (...args) => calls.push(['record', ...args]) }).remove;
  const body = { token: 'token', confirm: true };
  assert.equal((await route.handle({}, {}, url('/api/hierarchy/remove/apply'), body)).status, 200);
  assert.deepEqual(calls, [['backup', 'project', { opId: 'backup-id' }], ['apply', body], ['prune'], ['record', 'remove', {}, { transaction: 'receipt', moved: 1 }]]);
  calls.length = 0; removal.apply = () => { calls.push(['failed']); throw Error('blocked'); };
  assert.deepEqual(await route.handle({}, {}, url('/api/hierarchy/remove/apply'), body), { status: 409, body: { error: 'blocked' } });
  assert.deepEqual(calls, [['backup', 'project', { opId: 'backup-id' }], ['failed']]);
  calls.length = 0; target.task = 'task'; removal.apply = () => ({ record: 'task-receipt', moved: [] });
  assert.equal((await route.handle({}, {}, url('/api/hierarchy/remove/apply'), body)).status, 200);
  assert.equal(calls.some(c => c[0] === 'backup'), false);
});

test('hierarchy unknown removal returns not found and restore retains confirmation and audit order', async () => {
  const calls = [], route = require('../lib/routes/hierarchy')({ send, removal: { restore: (...args) => { calls.push(args); return { restored: true }; } }, record: (...args) => calls.push(args) }).remove;
  assert.deepEqual(await route.handle({}, {}, url('/api/hierarchy/remove/unknown'), {}), { status: 404, body: { error: 'not found' } });
  assert.deepEqual(calls, []);
  assert.equal((await route.handle({}, {}, url('/api/hierarchy/remove/restore'), { record: 'receipt', confirm: false })).status, 200);
  assert.deepEqual(calls, [['receipt', false], ['removerestore', {}, { transaction: 'receipt' }]]);
});
