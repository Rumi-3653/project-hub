'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const create = require('../lib/routes/task-body-read');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-body-read-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [], values = { preview: { moves: [], enabled: false }, archives: [{ path: 'original.md' }] };
  const textBudget = Object.fromEntries(['preview', 'archives'].map(name => [name, (...args) => {
    calls.push([name, ...args]); if (values[name] instanceof Error) throw values[name]; return values[name];
  }]));
  const routes = create({ textBudget, path, lt: text => 'translated:' + text,
    store: { readProject: project => { calls.push(['readProject', project]); return { dir }; } },
    fs: { readFileSync: (file, encoding) => { calls.push(['read', file, encoding]); return fs.readFileSync(file, encoding); } },
    send: (res, status, body) => { calls.push(['send', status]); return { status, body }; } });
  assert.deepEqual(calls, [], 'registering routes must not read the ledger');
  const run = (slot, route, header = '1') => routes[slot].handle({ method: 'GET', headers: { 'x-hub': header } }, {}, new URL(route, 'http://localhost'));
  return { dir, calls, values, routes, run };
}

test('task body read accepts only the three exact GET paths', t => {
  const f = fixture(t), matches = (slot, method, route) => f.routes[slot].matches({ method }, new URL(route, 'http://localhost'));
  assert.equal(matches('preview', 'GET', '/api/task/body/preview'), true);
  for (const route of ['/api/task/body/archives', '/api/task/body/archive']) assert.equal(matches('archives', 'GET', route), true);
  for (const [slot, route] of [['preview', '/api/task/body/preview'], ['archives', '/api/task/body/archive']]) {
    assert.equal(matches(slot, 'POST', route), false);
    assert.equal(matches(slot, 'GET', route + '/'), false);
    assert.equal(matches(slot, 'GET', '/api/task/body/apply'), false);
  }
});

test('task body read validates the connection before any preview, list or file read', t => {
  const f = fixture(t);
  for (const [slot, route] of [['preview', '/api/task/body/preview'], ['archives', '/api/task/body/archives'], ['archives', '/api/task/body/archive']])
    for (const header of [null, '', 'true', 1]) {
      f.calls.length = 0;
      assert.deepEqual(f.run(slot, route, header), { status: 403, body: { error: 'forbidden' } });
      assert.deepEqual(f.calls, [['send', 403]]);
    }
});

test('body preview passes request text unchanged, retains missing arguments and returns errors as 409', t => {
  const f = fixture(t);
  assert.deepEqual(f.run('preview', '/api/task/body/preview?project=p&task=t&request=%E5%8E%9F%E6%96%87%0A%2B'), { status: 200, body: f.values.preview });
  assert.deepEqual(f.calls, [['preview', 'p', 't', '原文\n+'], ['send', 200]]);
  f.calls.length = 0; f.values.preview = Error('preview unavailable');
  assert.deepEqual(f.run('preview', '/api/task/body/preview'), { status: 409, body: { error: 'preview unavailable' } });
  assert.deepEqual(f.calls, [['preview', null, null, null], ['send', 409]]);
});

test('archive listing returns the current list without opening the project or reading text', t => {
  const f = fixture(t);
  for (const archives of [[], [{ path: 'original.md' }, { path: 'new.md' }]]) {
    f.calls.length = 0; f.values.archives = archives;
    assert.deepEqual(f.run('archives', '/api/task/body/archives?project=p&task=t'), { status: 200, body: { archives } });
    assert.deepEqual(f.calls, [['archives', 'p', 't'], ['send', 200]]);
  }
});

test('unlisted or differently spelled archive paths return 404 without accessing files', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.dir, 'private.md'), 'must not be read');
  for (const want of ['private.md', '../original.md', './original.md', '']) {
    f.calls.length = 0;
    assert.deepEqual(f.run('archives', '/api/task/body/archive?project=p&task=t&path=' + encodeURIComponent(want)),
      { status: 404, body: { error: 'translated:この場所は見つかりません' } });
    assert.deepEqual(f.calls, [['archives', 'p', 't'], ['send', 404]]);
  }
});

test('listed originals are read as UTF-8 after the list and project, without changing the original', t => {
  const f = fixture(t), file = path.join(f.dir, '原文.md'), original = Buffer.from('原文\nsecond line\n');
  f.values.archives = [{ path: '原文.md' }]; fs.writeFileSync(file, original);
  assert.deepEqual(f.run('archives', '/api/task/body/archive?project=p&task=t&path=' + encodeURIComponent('原文.md')),
    { status: 200, body: { path: '原文.md', text: original.toString() } });
  assert.deepEqual(f.calls, [['archives', 'p', 't'], ['readProject', 'p'], ['read', file, 'utf8'], ['send', 200]]);
  assert.deepEqual(fs.readFileSync(file), original);
});

test('a listed symbolic link is rejected before reading its target', t => {
  const f = fixture(t), target = path.join(f.dir, 'target.md'); fs.writeFileSync(target, 'must not be read');
  fs.symlinkSync(target, path.join(f.dir, 'original.md'));
  const result = f.run('archives', '/api/task/body/archive?project=p&task=t&path=original.md');
  assert.equal(result.status, 409); assert.ok(result.body.error);
  assert.deepEqual(f.calls, [['archives', 'p', 't'], ['readProject', 'p'], ['send', 409]]);
});

test('archive list and disk failures retain the 409 response and stop subsequent reads', t => {
  const f = fixture(t); f.values.archives = Error('list unavailable');
  assert.deepEqual(f.run('archives', '/api/task/body/archive'), { status: 409, body: { error: 'list unavailable' } });
  assert.deepEqual(f.calls, [['archives', null, null], ['send', 409]]);
  f.values.archives = [{ path: 'missing.md' }]; f.calls.length = 0;
  const result = f.run('archives', '/api/task/body/archive?project=p&task=t&path=missing.md');
  assert.equal(result.status, 409); assert.match(result.body.error, /ENOENT/);
  assert.equal(f.calls.at(-1)[1], 409);
});
