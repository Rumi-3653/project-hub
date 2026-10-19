'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const create = require('../lib/routes/task-history-write');

function fixture() {
  const calls = [], res = new EventEmitter(), b = { project: 'p', task: 't', text: 'user text' };
  let revision = 'r1', role = { name: '文章', main: { ai: 'claude-code', model: 'fixture-model', effort: 'high' } }, start;
  const taskHistory = {
    prepareSummary: (...args) => { calls.push(['prepare', ...args]); return { text: 'Hub summary request', revision }; },
    hold: (...args) => { calls.push(['hold', ...args]); return () => calls.push(['release']); },
    idle: (...args) => calls.push(['idle', ...args]),
    revision: (...args) => { calls.push(['revision', ...args]); return revision; },
  };
  const routes = create({ taskHistory, rolesData: () => { calls.push(['roles']); return { roles: role ? [role] : [] }; },
    lt: text => text, autoTick: () => {}, autoView: () => {},
    delegateRequest: async (input, response, options) => { calls.push(['delegate', input, response]); start = options.beforeStart; return { queued: true }; },
    send: (response, status, body) => { calls.push(['send', status]); return { status, body }; } });
  assert.deepEqual(calls, [], 'registration must not acquire a hold or prepare a request');
  return { calls, routes, res, b, run: () => routes.summary.handle({}, res, new URL('http://localhost/api/task/history/summary'), b),
    start: () => start(), revise: () => { revision = 'r2'; }, removeRole: () => { role = null; } };
}

test('history summary holds the generation until delivery, using only the configured writer and prepared text', async () => {
  const f = fixture();
  assert.deepEqual(await f.run(), { queued: true });
  assert.deepEqual(f.calls.slice(0, 3), [['roles'], ['prepare', 'p', 't'], ['hold', 'p', 't']]);
  const [, input, response] = f.calls[3];
  assert.equal(response, f.res);
  assert.deepEqual(input, { ...f.b, text: 'Hub summary request', title: '会話整理の要約', ai: 'claude', model: 'fixture-model', effort: 'high', role: '文章' });
  assert.equal(f.res.listenerCount('finish'), 1); assert.equal(f.res.listenerCount('close'), 1);
  f.start();
  assert.deepEqual(f.calls.slice(4), [['release'], ['idle', 'p', 't'], ['revision', 'p', 't']]);
  f.res.emit('finish'); f.res.emit('close');
  assert.deepEqual(f.calls.slice(-2), [['release'], ['release']]);
});

test('history summary refuses a changed revision at start after releasing the hold and checking idle', async () => {
  const f = fixture(); await f.run(); f.revise();
  assert.throws(() => f.start(), /要約依頼の準備中に会話が変わりました/);
  assert.deepEqual(f.calls.slice(4), [['release'], ['idle', 'p', 't'], ['revision', 'p', 't']]);
});

test('missing writer configuration refuses summary before reading history or acquiring a hold', async () => {
  const f = fixture(); f.removeRole();
  assert.deepEqual(await f.run(), { status: 409, body: { error: '文章担当の設定を確認してください' } });
  assert.deepEqual(f.calls, [['roles'], ['send', 409]]);
});
