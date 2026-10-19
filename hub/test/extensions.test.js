'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { loadExtensions } = require('../lib/extensions');
const { excluded } = require('../../scripts/export-public');
function fixture(t) {
  const hub = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-extensions-'));
  t.after(() => fs.rmSync(hub, { recursive: true, force: true }));
  const write = (name, text) => { const file = path.join(hub, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  return { hub, write };
}
test('public core without the private bundle has inert hooks, no UI, and a precise absent-feature response', async t => {
  const f = fixture(t), e = loadExtensions(f);
  assert.deepEqual(e.state(), { version: 1, included: [], missing: [], notice: '' });
  const review=e.create('role_review',{});
  assert.equal(e.definition('role_review').isRequest('role-review-forged'),false);
  await review.tick();review.recover();
  for(const action of ['review','review/cancel']) e.route('role_review',{method:'POST'},{},new URL('http://localhost/api/roles/'+action),{},(_r,status,body)=>{assert.equal(status,404);assert.equal(body.code,'feature_not_included');});
  const empty = e.create('discussion', {});
  assert.equal(empty.active('p', 't'), false); assert.equal(e.definition('discussion').isRequest('discussion-forged'), false);
  assert.deepEqual(empty.limitModels(), {}); assert.deepEqual(empty.read(), { sessions: {} });
  await empty.tick(); empty.recover(); assert.equal(empty.stop(), false); assert.equal(e.uiSource(), '');
  e.route('discussion', { method: 'POST' }, {}, new URL('http://localhost/api/discussion/start'), {}, (_r, status, body) => {
    assert.equal(status, 404); assert.equal(body.code, 'feature_not_included');
  });
});
test('official marker detects a missing bundle without claiming it is an ordinary free build', t => {
  const f = fixture(t); f.write('paid-bundle.json', JSON.stringify({ version: 1, features: ['discussion'] }));
  const e = loadExtensions(f);
  assert.match(e.state().notice, /有料部品が見つかりません/); assert.deepEqual(e.state().missing, ['discussion']);
  assert.equal(e.create('discussion', {}).active(), false);
});
test('nested missing imports, syntax errors and incompatible contracts are never swallowed as absence', t => {
  for (const source of ["require('./missing-dependency');", 'invalid syntax !', "module.exports=[{id:'discussion',feature:'discussion',version:2,create(){}}];"]) {
    const f = fixture(t); f.write('paid/index.js', source); assert.throws(() => loadExtensions(f));
  }
  const f = fixture(t); f.write('paid/other.js', 'module.exports={};'); assert.throws(() => loadExtensions(f));
});
test('extension hosts are frozen and private UI is pinned at startup through a restricted path', t => {
  const f = fixture(t);
  f.write('paid/index.js', "module.exports=[{id:'discussion',feature:'discussion',version:1,ui:{script:'/paid/discussion.js'},create(host){if(!Object.isFrozen(host))throw Error('mutable host');return {routes:[]};}}];");
  f.write('public/paid/discussion.js', '/* private UI fixture */');
  const e = loadExtensions(f); e.create('discussion', { safe: true });
  assert.equal(e.uiSource(), '/* private UI fixture */');
  assert.deepEqual(e.state().included, ['discussion']);
});
test('public export excludes the private bundle, its UI, marker and tests; the only production importer is the fixed loader', () => {
  for (const name of ['hub/paid/index.js', 'hub/paid/discussion/runtime.js', 'hub/paid/role-review/runtime.js', 'hub/public/paid/role-review.js', 'hub/paid/test/private.test.js', 'hub/public/paid/discussion.js', 'hub/paid-bundle.json']) assert.equal(excluded(name), true, name);
  const hub = path.join(__dirname, '..');
  function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []); }
  for (const file of [path.join(hub, 'server.js'), ...walk(path.join(hub, 'lib'))]) {
    const source = fs.readFileSync(file, 'utf8');
    if (/require\(['"][^'"]*\/paid(?:['"/])/.test(source)) assert.equal(file, path.join(hub, 'lib/extensions.js'));
  }
});
