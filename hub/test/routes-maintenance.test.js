'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const create = require('../lib/routes/maintenance');
const url = pathname => new URL(pathname, 'http://localhost');
function fixture(options = {}) {
  const events = [], result = { id: 'transaction', moved: 2, ok: true }, ctx = {
    send: (res, status, body) => ({ status, body }), lt: s => s,
    maintenance: {
      preview: project => { events.push(['preview', project]); return result; },
      apply: (...args) => { events.push(['apply', ...args]); return result; },
      restore: (...args) => { events.push(['restore', ...args]); return result; },
      verify: async (project, script, hash, confirm, before) => { events.push(['verify', project, script, hash, confirm]); before(); events.push('run'); return result; },
    },
    problemResolution: { solve: async project => { events.push(['solve', project]); return { task: 'task', reused: true, clear: false }; } },
    store: { readProject: project => ({ id: project, base: 'existing-base' }) }, baseOf: p => p.base,
    executionGate: { acquire: opts => { events.push(['acquire', opts]); return { id: 'lease' }; }, release: (...args) => events.push(['release', ...args]) },
    record: (...args) => events.push(['record', ...args]), ...options,
  };
  return { route: create(ctx).write, events, ctx, result };
}
const body = { project: 'P', token: 'token', selected: ['item'], confirm: true, transaction: 'old', script: 'check', expectedHash: 'hash' };
test('maintenance matches its entire old prefix, including unknown operations', () => {
  const { route } = fixture();
  assert.equal(route.matches({}, url('/api/maintenance/unknown')), true);
  assert.equal(route.matches({}, url('/api/maintenance')), false);
});
test('maintenance preview, apply and restore preserve confirmation arguments and audit payloads', async () => {
  for (const operation of ['preview', 'apply', 'restore']) {
    const { route, events, result } = fixture();
    assert.deepEqual(await route.handle({}, {}, url('/api/maintenance/' + operation), body), { status: 200, body: result });
    const expected = operation === 'preview' ? [['preview', 'P']] : operation === 'apply' ? [['apply', 'P', 'token', ['item'], true], ['record', 'cleanup', { project: 'P' }, { transaction: 'transaction', moved: 2 }]] : [['restore', 'P', 'old', true], ['record', 'restore', { project: 'P' }, { transaction: 'old' }]];
    assert.deepEqual(events, expected);
  }
});
test('maintenance solve and unknown operation keep their original responses', async () => {
  const { route, events } = fixture();
  assert.equal((await route.handle({}, {}, url('/api/maintenance/solve'), body)).status, 200);
  assert.deepEqual(events, [['solve', 'P'], ['record', 'problemsolve', { project: 'P', task: 'task' }, { reused: true, clear: false }]]);
  events.length = 0;
  assert.deepEqual(await route.handle({}, {}, url('/api/maintenance/unknown'), body), { status: 404, body: { error: '操作が見つかりません' } });
  assert.deepEqual(events, []);
});
test('maintenance verification acquires the existing lease before running and releases before recording', async () => {
  const { route, events } = fixture();
  assert.equal((await route.handle({}, {}, url('/api/maintenance/verify'), body)).status, 200);
  assert.deepEqual(events, [['verify', 'P', 'check', 'hash', true], ['acquire', { dir: 'existing-base', owner: 'maintenance:P', kind: 'verification' }], 'run', ['release', 'maintenance:P', 'lease'], ['record', 'verify', { project: 'P' }, { ok: true, script: 'check' }]]);
});
test('maintenance verification failure releases only an acquired lease and keeps task error details', async () => {
  for (const failAcquire of [false, true]) {
    const { route, ctx, events } = fixture();
    if (failAcquire) ctx.executionGate.acquire = () => { throw Error('busy'); };
    ctx.maintenance.verify = async (p, s, h, c, before) => { before(); const e = Error('failed'); e.task = 'existing-task'; throw e; };
    const response = await route.handle({}, {}, url('/api/maintenance/verify'), body);
    assert.deepEqual(response, failAcquire ? { status: 409, body: { error: 'busy' } } : { status: 409, body: { error: 'failed', task: 'existing-task' } });
    assert.equal(events.filter(e => e[0] === 'release').length, failAcquire ? 0 : 1);
    assert.equal(events.filter(e => e[0] === 'record').length, 0);
  }
});

test('maintenance awaits asynchronous preview and apply before sending or auditing', async () => {
 for(const operation of ['preview','apply']) {
  const {route,ctx,events,result}=fixture();let finish;
  ctx.maintenance[operation]=()=>new Promise(resolve=>finish=resolve);
  const pending=route.handle({}, {}, url('/api/maintenance/'+operation),body);
  assert.deepEqual(events,[]);finish(result);
  assert.deepEqual(await pending,{status:200,body:result});
  assert.equal(events.filter(x=>x[0]==='record').length,operation==='apply'?1:0);
 }
});
