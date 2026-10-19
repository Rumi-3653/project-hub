'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const send = (res, status, body) => ({ status, body }), lt = s => s;
const url = p => new URL(p, 'http://localhost:4545');

test('state reads late services on each request and restoration only after the response finishes', async () => {
  let discussion, restart, restored = false, release, state, confirmation;
  const none = () => ({}), list = () => [], events = [];
  const ctx = { __dirname: '/example/hub', gitw: { savedHeadAsync: () => new Promise(r => { release = r; }) },
    pruneUnread: () => events.push('prune'), getDiscussion: () => discussion,
    rolesData: () => ({ models: {} }), modelView: { read: none, initial: () => ({ ai: 'codex', model: 'example' }), special: none, hidden: none, saved: none, phone: none },
    chats: { handoffErrors: list, running: new Map() }, restartBlockers: list,
    extensions: { state: none }, stopControl: { view: none }, readVersion: () => 'test', license: { status: none },
    appUpdate: { status: none, healthy: async value => { confirmation = value; } }, appShell: { status: none }, freetalkStatus: none,
    onboarding: { state: none }, aiUpdates: { status: () => ({ tools: {} }) },
    aiTools: { busy: () => 0, find: () => false, catalog: () => ({ agy: {} }) }, updateBusy: () => false,
    getRestartControl: () => restart, bodyNoticeState: none, github: { summary: none }, accounts: { list },
    store: { completion: {}, listProjects: list }, projectOrder: { read: list, readPins: list },
    taskTransfer: { pending: list }, stateOffers: { view: list }, taskIntegrate: { pending: list }, launch: { AIS: [] },
    handoff: { childCounts: none }, sessions: { list, available: () => false }, modelError: () => '', roles: { EFFORTS: [] },
    unread: new Set(), procwatch: { list }, acceleration: { settings: none }, remote: { enabled: () => false },
    gpt: { settings: none }, getWebchat: () => ({ view: none }), crypto: require('node:crypto'), fromRemote: () => false,
    getUpdateRestoreReady: () => restored, record: () => assert.fail('no confirmation error'),
    sendEncoded: (req, res, body) => { state = JSON.parse(body); return state; }, lt,
  };
  const route = require('../lib/routes/state')(ctx).read;
  // The services are deliberately absent when the registry is constructed.
  discussion = { read: () => { events.push('discussion-one'); return { sessions: {} }; } };
  restart = { status: () => ({ marker: 'one' }) };
  const req = { method: 'GET', headers: {} }, res = new EventEmitter();
  const pending = route.handle(req, res, url('/api/state'));
  assert.deepEqual(events, ['prune', 'discussion-one']);
  assert.equal(confirmation, undefined);
  release('exact-head'); await pending;
  assert.equal(state.restart.marker, 'one'); assert.equal(state.saved.mainHead, 'exact-head');
  restored = true; res.statusCode = 200; res.writableFinished = true; res.emit('finish');
  assert.equal(confirmation.restored, true); assert.equal(confirmation.hubPath, ctx.__dirname);
  discussion = { read: () => { events.push('discussion-two'); return { sessions: {} }; } };
  restart = { status: () => ({ marker: 'two' }) };
  const second = route.handle(req, new EventEmitter(), url('/api/state')); release(null); await second;
  assert.equal(state.restart.marker, 'two'); assert.equal(state.saved.mainHead, null);
  assert.deepEqual(events, ['prune', 'discussion-one', 'prune', 'discussion-two']);
});

test('normal limit clear uses the current discussion models before validation and preserves failure boundaries', () => {
  let discussion; const events = [];
  const ctx = { send, lt, limitModels: () => ({ codex: ['ordinary'] }), getDiscussion: () => discussion,
    usageSelection: () => ({ codex: 'work' }), accounts: { get: (...args) => events.push(['account', ...args]) },
    limitEvidence: { clear: (...args) => events.push(['clear', ...args]) }, record: () => events.push(['record']),
    usage: { snapshot: () => ({ done: true }) }, usageWithLimit: value => value };
  const route = require('../lib/routes/limits')(ctx).clear, req = { method: 'POST' };
  discussion = { limitModels: () => ({ codex: ['first'] }) };
  assert.equal(route.handle(req, {}, url('/api/limits/clear'), { ai: 'codex', model: 'first' }).status, 200);
  assert.deepEqual(events[1], ['clear', 'work', 'first', { codex: ['ordinary', 'first'] }]);
  events.length = 0; discussion = { limitModels: () => ({ codex: ['second'] }) };
  assert.equal(route.handle(req, {}, url('/api/limits/clear'), { ai: 'codex', model: 'first' }).status, 400);
  assert.deepEqual(events, []);
  ctx.accounts.get = () => { throw Error('bad account'); };
  const failed = require('../lib/routes/limits')(ctx).clear.handle(req, {}, url('/api/limits/clear'), { ai: 'codex', model: 'second' });
  assert.equal(failed.status, 500); assert.deepEqual(events, []);
});

test('start forwards to the current implementation and keeps raw upload rejection ahead of reading', async () => {
  let current, calls = 0, resumed = 0;
  const ctx = { send, lt, quickStart: (...args) => current(...args), store: { readProject: () => null },
    readRaw: () => { calls++; assert.fail('must not read a rejected upload'); } };
  const routes = require('../lib/routes/start')(ctx), req = { method: 'POST', resume: () => resumed++ };
  current = async b => ({ status: 201, body: { title: b.title } });
  assert.deepEqual(await routes.write.handle(req, {}, url('/api/start'), { title: 'one' }), { status: 201, body: { title: 'one' } });
  current = async () => { throw Error('current failure'); };
  await assert.rejects(routes.write.handle(req, {}, url('/api/start'), {}), /current failure/);
  assert.equal((await routes.upload.handle(req, {}, url('/api/start/image'))).status, 400);
  ctx.store.readProject = () => ({ kind: 'freetalk' });
  assert.equal((await routes.upload.handle(req, {}, url('/api/start/image'))).status, 409);
  assert.equal(resumed, 2); assert.equal(calls, 0);
});

test('project completion checks confirmation, revision and active work before save, audit and report', () => {
  const events = []; let busy = true;
  const ctx = { send, lt, store: { readProject: () => ({ completionHash: 'fresh' }), setProjectStatus: () => { events.push('save'); return { status: '完了' }; } },
    sessions: { list: () => { events.push('sessions'); return [{ project: 'p', running: busy }]; } },
    chats: { running: new Map() }, record: () => events.push('audit'), reportChild: () => events.push('report'), handoff: { completionText: () => 'done' } };
  const route = require('../lib/routes/project')(ctx).status, req = { method: 'POST' };
  const body = { project: 'p', status: '完了', expectedHash: 'fresh', confirm: true };
  assert.equal(route.handle(req, {}, url('/api/project/status'), { ...body, confirm: false }).status, 400);
  assert.equal(route.handle(req, {}, url('/api/project/status'), { ...body, expectedHash: 'stale' }).status, 409);
  assert.deepEqual(events, []);
  assert.equal(route.handle(req, {}, url('/api/project/status'), body).status, 409);
  assert.deepEqual(events, ['sessions']); events.length = 0; busy = false;
  assert.equal(route.handle(req, {}, url('/api/project/status'), body).status, 200);
  assert.deepEqual(events, ['sessions', 'save', 'audit', 'report']);
});
