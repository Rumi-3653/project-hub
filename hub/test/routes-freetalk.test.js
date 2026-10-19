'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const create = require('../lib/routes/freetalk');
const send = (res, status, body, type) => ({ status, body, ...(type ? { type } : {}) });
const url = p => new URL(p, 'http://localhost');
const req = { method: 'POST' }, lt = s => s;

test('freetalk read routes retain target validation and attachment error responses', () => {
  let reads = 0;
  const routes = create({ send, lt, freetalkHistory: { status: task => { reads++; return { task }; } },
    freetalkAttachments: { preview: (task, id) => { reads++; if (id === 'missing') throw Error('missing'); return { data: 'image', type: 'image/png' }; } } });
  const get = { method: 'GET' };
  assert.equal(routes.status.matches(get, url('/api/freetalk/status')), true);
  assert.equal(routes.status.matches(req, url('/api/freetalk/status')), false);
  assert.equal(routes.status.handle(get, {}, url('/api/freetalk/status?project=FreeTalk')).status, 409);
  assert.equal(routes.attachment.handle(get, {}, url('/api/freetalk/attachment?project=other')).status, 404);
  assert.equal(reads, 0);
  assert.deepEqual(routes.status.handle(get, {}, url('/api/freetalk/status?project=freetalk&task=t')), { status: 200, body: { task: 't' } });
  assert.deepEqual(routes.attachment.handle(get, {}, url('/api/freetalk/attachment?project=freetalk&task=t&id=i')), { status: 200, body: 'image', type: 'image/png' });
  assert.deepEqual(routes.attachment.handle(get, {}, url('/api/freetalk/attachment?project=freetalk&id=missing')), { status: 404, body: { error: '画像が見つかりません' } });
});

test('freetalk topic selects the current special model before the initial fallback', () => {
  let pick = { model: 'special' }, failure;
  const events = [];
  const routes = create({ send, lt, rolesData: () => ({}), specialMode: { pick: () => pick },
    modelView: { special: () => ({}), initial: () => { events.push('initial'); return { model: 'initial' }; } },
    freetalk: { ensure: () => ({ ready: true }), createTopic: model => { if (failure) throw failure; return model; } } });
  assert.equal(routes.ensure.handle(req, {}, url('/api/freetalk/ensure')).body.ready, true);
  assert.equal(routes.topic.handle(req, {}, url('/api/freetalk/topic')).body.model, 'special');
  assert.deepEqual(events, []);
  pick = null;
  assert.equal(routes.topic.handle(req, {}, url('/api/freetalk/topic')).body.model, 'initial');
  failure = Error('creation rejected');
  assert.deepEqual(routes.topic.handle(req, {}, url('/api/freetalk/topic')), { status: 409, body: { error: 'creation rejected' } });
});

function lifecycle() {
  const events = [], other = 'freetalk/other'; let failure;
  const base = new Map([['freetalk/t', 'target'], [other, 'keep']]), queues = new Map(base);
  const routes = create({ send, lt,
    freetalkLifecycle: { remove: () => { events.push('save'); if (failure) throw failure; return { removed: true }; },
      promote: () => { events.push('promote'); return { promoted: true }; }, clean: () => { events.push('clean'); return { cleaned: true }; } },
    freetalkHistory: { rotate: () => { events.push('rotate'); if (failure) throw failure; return { generation: 2 }; } },
    chats: { base, queues, key: (p, t) => p + '/' + t, emit: () => events.push('reset') },
    setUnread: (p, t, on) => events.push(['unread', p, t, on]), cleanFreetalkMemory: () => events.push('memory') });
  return { routes, base, queues, events, fail: () => { failure = Error('busy'); } };
}

test('freetalk delete and rotate clean only their target after a successful save', async () => {
  for (const operation of ['delete', 'rotate']) {
    const fixture = lifecycle(), { routes, events, base, queues } = fixture;
    const route = operation === 'delete' ? routes.lifecycle : routes.history;
    const result = await route.handle(req, {}, url('/api/freetalk/' + operation), { project: 'freetalk', task: 't', confirm: true });
    assert.equal(result.status, 200);
    assert.deepEqual(events, [operation === 'delete' ? 'save' : 'rotate', 'reset', ['unread', 'freetalk', 't', false]]);
    assert.equal(base.has('freetalk/t'), false); assert.equal(queues.has('freetalk/t'), false);
    assert.equal(base.get('freetalk/other'), 'keep'); assert.equal(queues.get('freetalk/other'), 'keep');
  }
});

test('freetalk failed save or invalid project leaves conversation memory and queues intact', async () => {
  for (const operation of ['delete', 'rotate']) {
    const fixture = lifecycle(), { routes, events, base, queues } = fixture;
    const route = operation === 'delete' ? routes.lifecycle : routes.history;
    assert.equal((await route.handle(req, {}, url('/api/freetalk/' + operation), { project: 'other', task: 't' })).status, 409);
    assert.deepEqual(events, []);
    fixture.fail();
    assert.equal((await route.handle(req, {}, url('/api/freetalk/' + operation), { project: 'freetalk', task: 't' })).status, 409);
    assert.deepEqual(events, [operation === 'delete' ? 'save' : 'rotate']);
    assert.equal(base.get('freetalk/t'), 'target'); assert.equal(queues.get('freetalk/t'), 'target');
  }
});

test('freetalk promotion and global cleanup retain their post-save notification order', () => {
  const { routes, events } = lifecycle();
  assert.equal(routes.lifecycle.handle(req, {}, url('/api/freetalk/promote'), { project: 'freetalk', task: 't' }).status, 200);
  assert.deepEqual(events, ['promote', 'reset']); events.length = 0;
  assert.equal(routes.lifecycle.handle(req, {}, url('/api/freetalk/clean'), { project: 'freetalk', confirm: true }).status, 200);
  assert.deepEqual(events, ['clean', 'memory']);
});

test('freetalk summary forwards the original internal request key and idle callback', async () => {
  const events = [], request = { ai: 'codex', model: 'fixture', text: 'summary', task: 't' };
  const routes = create({ send, lt,
    freetalkHistory: { prepareSummary: () => { events.push('prepare'); return request; },
      state: () => { events.push('state'); return { summary: { id: 'request-key' } }; }, idle: t => events.push(['idle', t]) },
    delegateRequest: async (body, res, options) => {
      assert.deepEqual(body, { ...request, project: 'freetalk', task: 't', title: '話題の整理用の要約' });
      assert.equal(options.requestKey, 'request-key'); assert.deepEqual(events, ['prepare', 'state']);
      options.beforeStart(); return { accepted: true };
    } });
  assert.deepEqual(await routes.history.handle(req, {}, url('/api/freetalk/summary'), { project: 'freetalk', task: 't' }), { accepted: true });
  assert.deepEqual(events, ['prepare', 'state', ['idle', 't']]);
});

test('freetalk automatic start awaits the existing helper and retains its error status', async () => {
  let current = async task => ({ task });
  const routes = create({ send, lt, startAutomaticFreetalk: task => current(task) });
  assert.deepEqual(await routes.projectStart.handle(req, {}, url('/api/freetalk/project-start'), { project: 'freetalk', task: 't' }), { status: 200, body: { task: 't' } });
  current = async () => { throw Object.assign(Error('blocked'), { status: 423 }); };
  assert.deepEqual(await routes.projectStart.handle(req, {}, url('/api/freetalk/project-start'), { project: 'freetalk', task: 't' }), { status: 423, body: { error: 'blocked' } });
});
