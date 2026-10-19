'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const send = (res, status, body) => ({ status, body }), lt = s => s;
const url = p => new URL(p, 'http://localhost:4545');

test('onboarding rejects extra check fields before inspection and propagates save errors', async () => {
  let checks = 0;
  const route = require('../lib/routes/onboarding')({ send, lt, onboarding: { check: () => { checks++; }, save: () => { throw Error('save failed'); } } }).write;
  for (const body of [null, [], { ais: ['codex'], secret: 'hidden' }]) {
    assert.equal((await route.handle({}, {}, url('/api/onboarding/check'), body)).status, 400);
  }
  assert.equal(checks, 0);
  await assert.rejects(route.handle({}, {}, url('/api/onboarding'), {}), /save failed/);
  assert.equal(route.matches({}, url('/api/onboarding/check/extra')), false);
});

test('usage read rejects missing mark and foreign origins without reading or selecting accounts', async () => {
  let reads = 0, selections = 0;
  const route = require('../lib/routes/usage')({ send, lt, PORT: 4545, usage: { status: async () => { reads++; return {}; } }, usageSelection: () => { selections++; return {}; }, usageWithLimit: s => s }).read;
  for (const headers of [{}, { 'x-hub': '1', origin: 'https://evil.invalid' }, { 'x-hub': '1', origin: 'http://localhost:4546' }]) {
    assert.deepEqual(await route.handle({ headers }, {}, url('/api/usage')), { status: 403, body: { error: 'forbidden' } });
  }
  assert.equal(reads, 0); assert.equal(selections, 0);
  for (const origin of [undefined, 'http://localhost:4545', 'http://127.0.0.1:4545']) assert.equal((await route.handle({ headers: { 'x-hub': '1', origin } }, {}, url('/api/usage'))).status, 200);
  assert.equal(reads, 3); assert.equal(selections, 3);
});

test('usage refresh propagates read failure and reset keeps its public error boundary', async () => {
  const calls = [], failure = Object.assign(Error('private detail'), { status: 503, publicMessage: 'public failure' });
  const routes = require('../lib/routes/usage')({ send, lt, accounts: { get: (...args) => calls.push(args) }, usageSelection: () => ({ codex: 'work' }), usageWithLimit: s => s, usage: { status: async () => { throw failure; }, useReset: async (...args) => { calls.push(args); throw failure; } } });
  const req = { method: 'POST' }, body = { ai: 'codex', account: 'work', confirmed: true, token: 'ticket', retry: false };
  await assert.rejects(routes.write.handle(req, {}, url('/api/usage/refresh'), {}), e => e === failure);
  assert.deepEqual(await routes.write.handle(req, {}, url('/api/usage/reset'), body), { status: 503, body: { error: 'public failure' } });
  assert.deepEqual(calls, [['codex', 'work'], ['work', 'ticket', { confirmed: true, retry: false, selection: { codex: 'work' } }]]);
  assert.equal((await routes.write.handle(req, {}, url('/api/usage/reset'), { ...body, confirmed: false })).status, 400);
  assert.equal(calls.length, 2);
  assert.equal(routes.write.matches({ method: 'GET' }, url('/api/usage/reset')), false);
});

test('remote read uses the existing URL or awaits the host lookup and preserves lookup failure', async () => {
  let lookup = 0, state = { url: 'https://known.invalid', enabled: true };
  const ctx = { send, remote: { status: () => state }, tailscaleUrl: async () => { lookup++; return 'https://found.invalid'; } };
  let route = require('../lib/routes/remote')(ctx).read;
  assert.deepEqual(await route.handle({}, {}, url('/api/remote')), { status: 200, body: state }); assert.equal(lookup, 0);
  state = { url: '', enabled: true };
  assert.deepEqual(await route.handle({}, {}, url('/api/remote')), { status: 200, body: { ...state, url: 'https://found.invalid' } }); assert.equal(lookup, 1);
  ctx.tailscaleUrl = async () => { throw Error('lookup failed'); }; route = require('../lib/routes/remote')(ctx).read;
  await assert.rejects(route.handle({}, {}, url('/api/remote')), /lookup failed/);
});

test('remote failed update is not recorded; successful update records no passcode value', () => {
  const events = [], remote = { update: b => { events.push(['update', b]); return { error: 'invalid' }; }, enabled: () => true, status: () => ({ enabled: true }) };
  const route = require('../lib/routes/remote')({ send, remote, record: (...args) => events.push(args) }).write;
  const body = { enabled: true, passcode: 'secret-passcode', ignored: 'extra' };
  assert.deepEqual(route.handle({}, {}, url('/api/remote'), body), { status: 400, body: { error: 'invalid' } }); assert.equal(events.length, 1);
  events.length = 0; remote.update = b => { events.push(['update', b]); return { ok: true }; };
  assert.equal(route.handle({}, {}, url('/api/remote'), body).status, 200);
  assert.deepEqual(events, [['update', { enabled: true, passcode: 'secret-passcode' }], ['remote', {}, { enabled: true, passcode: true }]]);
});

test('remote logout completes before audit and never replies successfully after audit failure', () => {
  const events = [], route = require('../lib/routes/remote')({ send, remote: { logoutAll: () => { events.push('logout'); return 3; }, status: () => { events.push('status'); return {}; } }, record: (...args) => { events.push(args); throw Error('audit failed'); } }).logout;
  assert.throws(() => route.handle({}, {}, url('/api/remote/logout-all'), {}), /audit failed/);
  assert.deepEqual(events, ['logout', ['remotelogoutall', {}, { sessions: 3 }]]);
});
