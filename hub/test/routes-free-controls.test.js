'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const send = (res, status, body) => ({ status, body }), lt = s => s;
const url = p => new URL(p, 'http://localhost:4545'), req = { method: 'POST' };

test('credit exception validates before account lookup and records only after the awaited status and save', async () => {
  const events = [], snapshot = { marker: 'snapshot' };
  const route = require('../lib/routes/limits')({ send, lt,
    accounts: { get: (...v) => events.push(['account', ...v]) }, usageSelection: () => ({ codex: 'other' }),
    usage: { status: async (_, selection) => { events.push(['status', selection]); await Promise.resolve(); return snapshot; }, snapshot: selection => { events.push(['snapshot', selection]); return snapshot; } },
    limitEvidence: { startCreditException: (...v) => events.push(['start', ...v]), endCreditException: (...v) => events.push(['end', ...v]) },
    record: (...v) => events.push(['record', ...v]), usageWithLimit: s => s,
  }).write;
  const body = { ai: 'codex', account: 'default', confirmed: true };
  assert.equal((await route.handle(req, {}, url('/api/limits/credit-exception'), { ...body, account: 'other' })).status, 409);
  assert.deepEqual(events, []);
  assert.deepEqual(await route.handle(req, {}, url('/api/limits/credit-exception'), body), { status: 200, body: snapshot });
  assert.deepEqual(events, [['account','codex','default'], ['status',{codex:'default'}], ['start',body,snapshot], ['record','credit-exception',{ai:'codex'},{ended:false}]]);
  events.length = 0;
  await route.handle(req, {}, url('/api/limits/credit-exception/end'), body);
  assert.deepEqual(events.map(e => e[0]), ['account', 'snapshot', 'end', 'record']);
  assert.equal(route.matches({ method: 'GET' }, url('/api/limits/credit-exception')), false);
});

test('Fable clear never fetches usage and preserves failure and audit boundaries', async () => {
  const events = [], ctx = { send, lt, usageSelection: () => ({ claude: 'work' }),
    limitEvidence: { clear: account => events.push(['clear', account]) },
    usage: { snapshot: () => { events.push(['snapshot']); return {}; }, status: () => assert.fail('no refresh') },
    record: () => events.push(['record']), usageWithLimit: s => s };
  assert.equal((await require('../lib/routes/limits')(ctx).write.handle(req, {}, url('/api/limits/fable/clear'), {})).status, 200);
  assert.deepEqual(events, [['clear','work'], ['record'], ['snapshot']]);
  events.length = 0; ctx.limitEvidence.clear = () => { throw Error('save failed'); };
  assert.deepEqual(await require('../lib/routes/limits')(ctx).write.handle(req, {}, url('/api/limits/fable/clear'), {}), {status:500,body:{error:'解除を保存できませんでした'}});
  assert.deepEqual(events, []);
});

test('AI updates reject malformed batch before work and never apply or audit a failed update', async () => {
  let starts = 0, applies = 0, records = 0;
  const route = require('../lib/routes/ai-update')({ send, lt, applyModelCatalog: () => applies++, record: () => records++,
    aiUpdates: { updateAll: () => starts++, single: async () => { starts++; throw Object.assign(Error('private'), {status:409,reason:'busy',stage:'check'}); } } }).write;
  assert.equal((await route.handle(req, {}, url('/api/ai-tools/update-all'), { extra: true })).status, 400); assert.equal(starts, 0);
  assert.deepEqual(await route.handle(req, {}, url('/api/ai-tools/update'), {ai:'codex'}), {status:409,body:{error:'busy',stage:'check',reason:'busy'}});
  assert.equal(starts, 1); assert.equal(applies, 0); assert.equal(records, 0);
});

test('model setting rejection preserves response and skips audit; save failure remains synchronous', () => {
  let recorded = 0;
  const ctx = {send, lt, rolesData: () => ({models:{}}), modelError: () => '', record: () => recorded++,
    modelView: {setInitial: () => ({error:'conflict',status:409})},
    saveCliModels: () => {throw Error('save failed');}};
  const routes = require('../lib/routes/model-settings')(ctx);
  assert.deepEqual(routes.write.handle(req, {}, url('/api/models/initial'), {}), {status:409,body:{error:'conflict'}});
  assert.equal(recorded, 0);
  assert.throws(() => routes.cli.handle(req, {}, url('/api/cli-models'), {}), /save failed/); assert.equal(recorded, 0);
});

test('global acceleration saves before audit and response, and does not capture task settings', () => {
  const events = [], body = {codexAllowed:false}, saved = {codexAllowed:false};
  const ctx = {send, acceleration:{save:b => {events.push(['save',b]);return saved;}}, record:(...v) => events.push(['record',...v])};
  const route = require('../lib/routes/acceleration')(ctx).write;
  assert.deepEqual(route.handle(req, {}, url('/api/acceleration'), body), {status:200,body:saved});
  assert.deepEqual(events, [['save',body], ['record','acceleration',{},saved]]);
  assert.equal(route.matches(req, url('/api/acceleration/task')), false);
  ctx.acceleration.save = () => {throw Error('save failed');}; events.length = 0;
  assert.throws(() => require('../lib/routes/acceleration')(ctx).write.handle(req, {}, url('/api/acceleration'), body), /save failed/);
  assert.deepEqual(events, []);
});
