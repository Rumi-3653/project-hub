'use strict';
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const crypto = require('node:crypto'), Module = require('node:module');
const { Worker } = require('node:worker_threads');
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-state-handoff-'));
const pdir = path.join(root, 'Product/P'), spoolRoot = path.join(root, '_hub/cli-runs');
const tasks = Array.from({ length: 43 }, (_, i) => 't' + i);
fs.mkdirSync(path.join(pdir, '.ai/tasks'), { recursive: true }); fs.mkdirSync(spoolRoot, { recursive: true });
fs.writeFileSync(path.join(pdir, 'PROJECT.md'), '---\nname: P\n---\n');
for (const id of tasks) fs.writeFileSync(path.join(pdir, '.ai/tasks', id + '.md'), `---\nid: ${id}\ntitle: ${id}\nstate: 未着手\n---\n`);
const runDirs = [];
for (let i = 0; i < 600; i++) {
  const dir = path.join(spoolRoot, crypto.randomUUID()); fs.mkdirSync(dir); runDirs.push(dir);
  // Real completed receipts, including the full proof used by current writers.
  const values = { 'request.json': { options: { project: 'P', task: tasks[i % tasks.length], pdir } },
    'exit.json': { code: 0 }, 'cursor.json': { n: 1 }, 'stderr.json': [], 'started.json': { cliPid: 0 },
    'launch.json': { supervisorPid: 0 }, 'control.json': {}, 'cancel.json': {},
    'finalizing.json': { stage: 'finished' }, 'finished.json': { proofRequired: 1 } };
  for (const [name, value] of Object.entries(values)) fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
  fs.writeFileSync(path.join(dir, 'out.jsonl'), '');
  const names = ['request.json','exit.json','cursor.json','out.jsonl','stderr.json','started.json','launch.json','control.json','cancel.json','finalizing.json','finished.json'];
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  fs.writeFileSync(path.join(dir, 'finished-confirmed.json'), JSON.stringify({ version: 1,
    evidence: hash(JSON.stringify(names.map(n => [n, hash(fs.readFileSync(path.join(dir, n)))]))) }));
}
fs.writeFileSync(path.join(root, '_hub/webchat.json'), JSON.stringify({ enabled: true, location: path.join(root, 'fake-unused') }));
Object.assign(process.env, { HUB_ROOT: root, HUB_DRY_RUN: '1', HUB_AI_HOME: path.join(root, 'home'),
  HUB_FREETALK_HOME: path.join(root, 'freetalk-home'), HUB_STORAGE_GUARD: '', HUB_AUTO_UPDATE: '0', HUB_AUTO_TRANSLATE: '0', HUB_UPDATE_SOURCE: '', GIT_OPTIONAL_LOCKS: '0' });
// Test-only issuer and device secrets stay in memory, including in exported trees.
// Keep the real License prepare/status/require/guard and signed proof/time validation.
const licenseModule = require('../lib/license'), OriginalLicense = licenseModule.License;
const codec = require('../lib/license/codec');
const hasWebchat = require('../lib/extensions').loadExtensions().state().included.includes('webchat');
let fixtureLicense;
class HandoffLicense extends OriginalLicense {
  constructor(options) {
    const issuer = crypto.generateKeyPairSync('ed25519'), secrets = new Map(), documents = new Map(), challenges = new Map();
    const now = 1800000000, scope = { channel: 'release', product: 'handoff-fixture', bugfixOf: [] };
    let sequence = 0;
    const sign = value => codec.signEnvelope(value, issuer.privateKey, 'fixture');
    super({ ...options, owner: false, platform: 'darwin',
      config: { licenseEnforcement: true, endpoint: 'http://127.0.0.1', trialDays: 30,
        build: { ...scope, buildId: 'handoff-fixture-mac' }, trustedKeys: { fixture: { publicKey: issuer.publicKey, purposes: ['proof', 'time'] } } },
      store: { read: name => documents.get(name), write: (name, value) => documents.set(name, structuredClone(value)) },
      secret: { get: name => secrets.get(name), put: (name, value) => secrets.set(name, value), elapsed: () => 0 },
      elapsed: () => 0, wall: () => now, machineHint: () => 'A'.repeat(43),
      fetcher: async (url, options) => {
        assert.equal(new URL(url).origin, 'http://127.0.0.1');
        const route = new URL(url).pathname, body = JSON.parse(options.body);
        if (route === '/challenge') {
          const nonce = crypto.randomBytes(32).toString('base64url'); challenges.set(nonce, body);
          return Response.json({ nonce });
        }
        const challenge = challenges.get(body.nonce); assert.ok(challenge); challenges.delete(body.nonce);
        const { sig, ...claim } = body;
        const key = crypto.createPublicKey({ key: Buffer.from(challenge.publicKeySpkiB64, 'base64'), type: 'spki', format: 'der' });
        assert.equal(codec.fingerprint(key), body.dev);
        assert.equal(crypto.verify(null, Buffer.from(JSON.stringify(claim)), key, Buffer.from(sig, 'base64url')), true);
        if (route === '/trial') return Response.json({ proof: sign({ v: 1, ent: 'handoff-trial', kind: 'trial', dev: body.dev,
          features: [...codec.PAID], scope, iat: now, nbf: now, exp: now + 30 * codec.DAY,
          entStartsAt: now, entEndsAt: now + 30 * codec.DAY, seq: ++sequence }) });
        assert.equal(route, '/time');
        return Response.json({ time: sign({ v: 1, typ: 'time', dev: body.dev, nonce: body.timeNonce, serverTime: now, seq: ++sequence }) });
      } });
    fixtureLicense = this;
  }
}
let hub, updater, port, calls = 0, scans = 0, metrics = [];
const pendingModule = require('../lib/cli-spool'), pending = pendingModule.pending;
const failureFile = path.join(runDirs[0], 'failure.json');
const setFailure = () => fs.writeFileSync(failureFile, JSON.stringify({ error: 'fixture unresolved save' }));
const clearFailure = () => { if (fs.existsSync(failureFile)) fs.unlinkSync(failureFile); };
const get = (route, headers = {}) => new Promise((resolve, reject) => {
  const t = performance.now();
  http.get({ host: '127.0.0.1', port, path: route, headers: { 'X-Hub': '1', Connection: 'close', ...headers } }, res => {
    const chunks = []; res.on('data', x => chunks.push(x)); res.on('error', reject);
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString(), ms: performance.now() - t }));
  }).on('error', reject);
});
const state = async headers => {
  const r = await get('/api/state', headers);
  assert.equal(r.status, 200, r.body); return JSON.parse(r.body);
};
const reason = (s, task) => s.projects.find(p => p.id === 'P').tasks.find(t => t.id === task).webchatReason;
test.before(async () => {
  const probe = http.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
  port = probe.address().port; await new Promise(r => probe.close(r)); process.env.HUB_PORT = String(port);
  const updateModule = require('../lib/app-update'), OriginalUpdate = updateModule.AppUpdate;
  updateModule.AppUpdate = class extends OriginalUpdate { constructor(opts) { super(opts); updater = this; } };
  const file = require.resolve('../server');
  licenseModule.License = HandoffLicense;
  try {
    if (process.env.HUB_PERF_BASELINE_FILE) {
      // Measurement only: compile the unchanged old state branch beside the new
      // one in the SAME module/instance, so all JSON fields can match exactly.
      const source = fs.readFileSync(file, 'utf8'), old = fs.readFileSync(process.env.HUB_PERF_BASELINE_FILE, 'utf8');
      const begin = "  if (req.method === 'GET' && url.pathname === '/api/state') {", end = '  // 裏で動いている AI の全部';
      const a = source.indexOf(begin), b = source.indexOf(end, a), x = old.indexOf(begin), y = old.indexOf(end, x);
      assert.ok(a > 0 && b > a && x > 0 && y > x);
      const baseline = old.slice(x, y).replace(begin, "  if (req.method === 'GET' && url.pathname === '/api/state' && req.headers['x-fixture-before'] === '1') {");
      const m = new Module(file, module); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file)); require.cache[file] = m;
      m._compile(source.slice(0, a) + baseline + source.slice(a), file); hub = m.exports;
    } else hub = require(file);
  } finally { updateModule.AppUpdate = OriginalUpdate; licenseModule.License = OriginalLicense; }
  await fixtureLicense.prepare();
  assert.equal(fixtureLicense.owner, false); assert.equal(fixtureLicense.status().trial.state, 'active');
  assert.doesNotThrow(() => fixtureLicense.require(['webchat']));
  await hub.restoreReady;
  const handoffErrors = hub.chats.handoffErrors;
  hub.chats.handoffErrors = function (...args) { calls++; return handoffErrors.apply(this, args); };
  pendingModule.pending = function (...args) { scans++; return pending.apply(this, args); };
  const emit = hub.server.emit;
  hub.server.emit = function (event, req) {
    if (event !== 'request' || !req.url.startsWith('/api/state')) return emit.apply(this, arguments);
    const before = { calls, scans };
    try { return emit.apply(this, arguments); }
    finally { metrics.push({ mode: req.headers['x-fixture-before'] === '1' ? 'before' : 'after', calls: calls - before.calls, scans: scans - before.scans }); }
  };
  await new Promise(r => hub.server.listen(port, '127.0.0.1', r));
});
test.after(async () => {
  if (hub) { hub.restartControl.reserved = null; hub.webchat.shutdown(); hub.sessions.stopAll(); updater.stop(); await new Promise(r => hub.server.close(r)); }
  pendingModule.pending = pending; fs.rmSync(root, { recursive: true, force: true });
});
test('600 completed runs: each state build validates once, including unchanged/304 responses', async () => {
  await state(); // Complete startup views before checking stable validators.
  const first = await get('/api/state'); assert.equal(first.status, 200);
  assert.deepEqual(metrics.at(-1), { mode: 'after', calls: 1, scans: 1 });
  const same = await get('/api/state', { 'If-None-Match': first.headers.etag });
  assert.equal(same.status, 304); assert.equal(same.body, '');
  assert.deepEqual(metrics.at(-1), { mode: 'after', calls: 1, scans: 1 });
  assert.equal(reason(JSON.parse(first.body), 't0'), hasWebchat ? '' : 'feature_not_included');
});
test('unresolved save keeps per-task availability, update/restart blocks and reserved restart display', async () => {
  setFailure(); hub.restartControl.reserved = { at: 'fixture-reserved' };
  try {
    const s = await state(); assert.deepEqual(metrics.at(-1), { mode: 'after', calls: 1, scans: 1 });
    assert.equal(s.chatHandoffErrors.length, 1); assert.equal(s.chatHandoffErrors[0].error, 'fixture unresolved save');
    assert.equal(reason(s, 't0'), hasWebchat ? 'webchat_task_busy' : 'feature_not_included'); assert.equal(reason(s, 't1'), hasWebchat ? '' : 'feature_not_included');
    assert.throws(() => hub.chats.assertHandoffReady('P', 't0'), /終了保存/);
    assert.doesNotThrow(() => hub.chats.assertHandoffReady('P', 't1'));
    assert.equal(s.updateBlocked, true); assert.equal(s.restartBusy, true);
    assert.ok(s.restartWaiting.some(x => x.kind === 'chat-handoff' && x.task === 't0'));
    assert.deepEqual(s.restart.waiting, s.restartWaiting);
  } finally { hub.restartControl.reserved = null; clearFailure(); }
});
test('fresh action checks reject a failure created AFTER a clean state; no send/start/restart occurs', async () => {
  await state(); setFailure();
  const p = { id: 'P', dir: pdir }, t = { id: 't0', state: '未着手' }, o = { project: 'P', task: 't0', ai: 'codex' };
  const fresh = fn => { const n = calls; const result = fn(); assert.ok(calls > n); return result; };
  try {
    if (hasWebchat) fresh(() => assert.throws(() => hub.webchat.submit(p, t, 'never sent'), /終了保存/));
    else { assert.equal(typeof hub.webchat.submit, 'undefined'); assert.throws(() => hub.webchat.availability(p, t), error => error.message === 'feature_not_included' && error.status === 404); }
    fresh(() => assert.throws(() => hub.chats.send(o), /終了保存/));
    let n = calls; await assert.rejects(hub.chats.sendQueued(o), /終了保存/); assert.ok(calls > n);
    fresh(() => assert.throws(() => hub.chats.detachForRestart(), /終了保存/));
    fresh(() => assert.throws(() => hub.restartControl.request(), /AIの作業/));
    fresh(() => assert.ok(hub.restartBlockers().some(x => x.kind === 'chat-handoff')));
    fresh(() => assert.equal(updater.busy(), true));
    assert.equal(hub.restartControl.committed, false); assert.equal(hub.restartControl.executions, 0);
    assert.equal(hub.webchat.jobs?.length || 0, 0); assert.equal(hub.chats.running.size, 0);
    assert.equal(fs.readdirSync(spoolRoot).length, 600);
  } finally { clearFailure(); }
  // A displayed failure must not survive a receipt change into the next action.
  const n = calls;
  if (hasWebchat) hub.webchat.availability(p, t);
  else hub.chats.assertHandoffReady('P', 't0');
  assert.ok(calls > n);
  assert.equal(updater.busy(), false); assert.equal(hub.restartBlockers().some(x => x.kind === 'chat-handoff'), false);
});
test('unknown handoff owner still blocks every task without extra scans', async () => {
  hub.chats.adoptErrors.push({ run: 'unknown-fixture', stage: 'spool', error: 'unknown owner' });
  try { const s = await state(); assert.deepEqual(metrics.at(-1), { mode: 'after', calls: 1, scans: 1 });
    assert.ok(s.projects.find(p => p.id === 'P').tasks.every(t => t.webchatReason === (hasWebchat ? 'webchat_task_busy' : 'feature_not_included')));
    for (const task of tasks) assert.throws(() => hub.chats.assertHandoffReady('P', task), /終了保存/);
    assert.ok(s.restartWaiting.some(x => x.kind === 'chat-handoff'));
    assert.equal(s.updateBlocked, true); assert.equal(s.restartBusy, true);
  } finally { hub.chats.adoptErrors = []; }
});
test('state summarizes steps; separate detail read preserves unread and updates its version/ETag',async()=>{
 const file=path.join(pdir,'.ai/tasks/t0.md'),before=fs.readFileSync(file,'utf8');
 try{
  fs.writeFileSync(file,before+'\n## 手順\n- [x] first\n- [ ] next\n- [x] last\n');
  const first=await get('/api/state'),s=JSON.parse(first.body),task=s.projects.find(p=>p.id==='P').tasks.find(t=>t.id==='t0');
  assert.equal(task.steps,undefined);assert.equal(task.stepSummary.total,3);assert.equal(task.stepSummary.done,2);assert.equal(task.stepSummary.next.text,'next');assert.equal(task.stepSummary.marks,'101');
  const detail=await get('/api/task/steps?project=P&task=t0'),d=JSON.parse(detail.body);
  assert.equal(detail.status,200);assert.equal(d.version,task.stepSummary.version);assert.deepEqual(d.steps,[{text:'first',done:true},{text:'next',done:false},{text:'last',done:true}]);
  const again=await get('/api/state',{'If-None-Match':first.headers.etag});assert.equal(again.status,304);
  assert.equal(fs.readFileSync(file,'utf8'),before+'\n## 手順\n- [x] first\n- [ ] next\n- [x] last\n');
  assert.deepEqual((await state()).unread,s.unread);
  fs.writeFileSync(file,before+'\n## 手順\n- [x] first\n- [x] next\n- [x] last\n');
  const changed=await get('/api/state',{'If-None-Match':first.headers.etag});assert.equal(changed.status,200);
  const nextTask=JSON.parse(changed.body).projects.find(p=>p.id==='P').tasks.find(t=>t.id==='t0');
  assert.notEqual(nextTask.stepSummary.version,d.version);assert.equal(nextTask.stepSummary.done,3);assert.equal(nextTask.stepSummary.next,null);
  assert.equal((await get('/api/task/steps?project=P&task=missing')).status,404);
  assert.equal((await get('/api/task/steps?project=..%2F..&task=t0')).status,404);
 }finally{fs.writeFileSync(file,before);}
});
test('isolated before/after latency and exact same-instance state JSON', { skip: !process.env.HUB_PERF_BASELINE_FILE }, async () => {
  // Send the concurrent ping from a separate event loop. A timer in this test's
  // event loop would itself wait behind the server's synchronous state build.
  const pair = mode => new Promise((resolve, reject) => {
    const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads');
      const http = require('node:http'), port = workerData.port;
      const get = ${get.toString()};
      (async () => { const state = get('/api/state', workerData.mode === 'before' ? { 'X-Fixture-Before': '1' } : {});
        await new Promise(r => setTimeout(r, 10)); const ping = get('/api/ping');
        parentPort.postMessage(await Promise.all([state, ping])); })().catch(e => { throw e; });`,
      { eval: true, workerData: { port, mode } });
    worker.once('message', resolve); worker.once('error', reject);
    worker.once('exit', code => { if (code) reject(Error('measurement worker exited: ' + code)); });
  });
  const rows = [];
  for (const unresolved of [false, true]) {
    if (unresolved) { setFailure(); hub.restartControl.reserved = { at: 'fixture-reserved' }; }
    try {
      for (let i = 0; i < 3; i++) {
        let before;
        for (const mode of ['before', 'after']) {
          const [s, p] = await pair(mode); assert.equal(s.status, 200); assert.equal(p.status, 200);
          const value = JSON.parse(s.body);
          if (mode === 'before') before = value; else assert.deepEqual(value, before);
          rows.push({ mode, unresolved, iteration: i, stateMs: s.ms, pingMs: p.ms, ...metrics.at(-1),
            bodySHA256: crypto.createHash('sha256').update(s.body).digest('hex') });
        }
      }
    } finally { hub.restartControl.reserved = null; clearFailure(); }
  }
  if (process.env.HUB_PERF_RESULT) fs.writeFileSync(process.env.HUB_PERF_RESULT, JSON.stringify({ runs: 600, tasks: 43, rows, exactJSON: true }, null, 2) + '\n');
});
