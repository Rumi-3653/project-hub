'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync, spawn } = require('node:child_process');
const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');
const { Store } = require('../lib/store');
const chat = require('../lib/chat');
const { Chatgpt } = require('../lib/chatgpt');
const { GptChildren } = require('../lib/gpt-children');
const { Webchat } = require('../lib/webchat');
const { WebchatClient } = require('../lib/webchat-client');
const fixtures = [];
function fixture(fake = {}, opts = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-webchat-'));
  const body = path.join(root, 'Body'), pdir = path.join(root, 'Product/P'), location = path.join(root, 'External');
  fs.mkdirSync(body); fs.mkdirSync(path.join(pdir, '.ai/tasks'), { recursive: true }); fs.mkdirSync(path.join(location, 'dist'), { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', body, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@localhost');
  fs.writeFileSync(path.join(body, 'main.txt'), 'original'); git('add', '.'); git('commit', '-qm', 'base');
  fs.writeFileSync(path.join(pdir, 'PROJECT.md'), `---\nname: P\nfolders:\n  本体: ${body}\n---\n`);
  for (const id of ['t', 'u']) fs.writeFileSync(path.join(pdir, '.ai/tasks', id + '.md'), `---\nid: ${id}\ntitle: Parent ${id}\nstate: 未着手\nowner: codex\nworkspaceMode: isolated\n---\n\n## 手順\n- [ ] pending\n`);
  fs.copyFileSync(path.join(__dirname, 'fixtures/webchat-mcp.cjs'), path.join(location, 'dist/WebChatMCP.js'));
  fs.copyFileSync(path.join(__dirname, 'fixtures/webchat-session.cjs'), path.join(location, 'dist/session.js'));
  const setFake = o => fs.writeFileSync(path.join(location, 'fake.json'), JSON.stringify(o)); setFake(fake);
  const store = new Store(root), events = [];
  const gpt = new Chatgpt({ file: path.join(root, '_hub/chatgpt.json'), store, chat, baseOf: () => body, record: () => {}, emitRow: (...a) => events.push(a), ended: () => {} });
  gpt.gptChildren = new GptChildren({ store, chat, baseOf: () => body, workRoot: () => path.join(root, 'Work/P'), record: () => {}, emitRow: gpt.emitRow, ended: gpt.ended });
  const wc = new Webchat({ root, gpt, store, chat, ...opts });
  wc.save({ enabled: true, location, model: 'Pro', thinking: 'Extended' });
  gpt.save({ work: true });
  const submit = (id = 't', text = '本文の依頼') => wc.submit(store.readProject('P'), store.readTask(store.taskFile('P', id)), text);
  const calls = () => { try { return fs.readFileSync(path.join(location, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); } catch { return []; } };
  const f = { root, body, pdir, location, store, gpt, wc, submit, calls, setFake, events }; fixtures.push(f); return f;
}
test.afterEach(() => { for (const f of fixtures.splice(0)) { f.wc.shutdown(); fs.rmSync(f.root, { recursive: true, force: true }); } });
const tool = (name, args) => ({ name, arguments: args });
const waiting = async predicate => { const deadline = Date.now() + 6000; while (!predicate()) { if (Date.now() > deadline) throw Error('fixture_wait_timeout'); await new Promise(r => setTimeout(r, 10)); } };

test('combined login saves fields and activates only a confirmed login without model discovery', async t => {
  for (const fake of [{}, { loggedIn: false }, { statusUnknown: true }, { challenge: true }]) await t.test(JSON.stringify(fake), async () => {
    const f = fixture(fake); f.wc.save({ enabled: false });
    const result = await f.wc.controlCall(true, false, false, { location: f.location, model: 'Existing', thinking: 'Existing thought' });
    assert.equal(result.enabled, result.check.loggedIn === true);
    assert.equal(result.model, 'Existing'); assert.equal(result.thinking, 'Existing thought');
    assert.equal(f.calls().filter(c => c.name === 'webchat_login').length, 1);
    assert.equal(f.calls().some(c => c.name === 'webchat_models' || c.name === 'webchat_ask'), false);
    const restarted = new Webchat({ root: f.root, gpt: f.gpt, store: f.store, chat });
    assert.equal(restarted.settings().enabled, result.enabled); assert.equal(restarted.settings().model, 'Existing'); restarted.shutdown();
  });
});
test('logout uses the scoped external operation and confirms false, never its optimistic loggedOut field', async t => {
  for (const fake of [{}, { logoutUnknown: true }, { logoutStillLoggedIn: true }]) await t.test(JSON.stringify(fake), async () => {
    const f = fixture(fake); const result = await f.wc.controlCall(false, false, true);
    assert.equal(result.enabled, false); assert.equal(result.model, 'Pro'); assert.equal(result.thinking, 'Extended');
    assert.equal(result.check.loggedIn, fake.logoutUnknown ? 'unknown' : Boolean(fake.logoutStillLoggedIn));
    assert.equal(result.check.statusError, fake.logoutUnknown || fake.logoutStillLoggedIn ? 'webchat_logout_unconfirmed' : undefined);
    assert.equal(f.calls().filter(c => c.name === 'webchat_logout').length, 1);
    assert.equal(f.calls().find(c => c.name === 'webchat_logout').arguments.provider, 'chatgpt');
    assert.equal(f.calls().some(c => ['webchat_models', 'webchat_ask', 'webchat_login'].includes(c.name)), false);
    assert.throws(() => f.submit(), /webchat_disabled/);
  });
});
test('unsupported or failed logout disables availability, records uncertainty and never retries', async t => {
  for (const fake of [{ noLogout: true }, { logoutError: { error: 'challenge_required' } }]) await t.test(JSON.stringify(fake), async () => {
    const f = fixture(fake);
    await assert.rejects(() => f.wc.controlCall(false, false, true), /webchat_(?:logout_unavailable|remote_challenge_required)/);
    assert.equal(f.wc.view().enabled, false); assert.equal(f.wc.view().check.loggedIn, 'unknown');
    assert.equal(f.wc.view().busy, false); assert.equal(f.calls().filter(c => c.name === 'webchat_logout').length, fake.noLogout ? 0 : 1);
  });
});
test('combined authentication validates saving first and retains the control lock until persisted activation', async () => {
  let finish; const calls = [];
  const f = fixture({}, { makeClient: () => ({ initialize: async () => {}, close() {}, json: async name => {
    calls.push(name); if (name === 'webchat_login') await new Promise(r => { finish = r; });
    return { loggedIn: true, temporaryChat: true };
  } }) });
  await assert.rejects(() => f.wc.controlCall(true, false, false, { location: 'relative' }), /webchat_location_absolute/);
  assert.equal(calls.length, 0);
  const login = f.wc.controlCall(true); await waiting(() => finish);
  assert.throws(() => f.wc.save({ model: 'Concurrent' }), /webchat_busy/);
  await assert.rejects(() => f.wc.controlCall(false, false, true), /webchat_busy/);
  finish(); const result = await login;
  assert.equal(result.enabled, true); assert.equal(result.model, 'Pro'); assert.equal(result.busy, false);
});

test('default disabled/settings GET starts nothing; unavailable model/thinking or logout blocks before ask', async t => {
  for (const fake of [{ model: 'Other' }, { thinking: 'Other' }, { loggedIn: false }]) await t.test(JSON.stringify(fake), async () => {
    const f = fixture(fake); f.submit(); await f.wc.tail;
    assert.equal(f.wc.jobs[0].state, 'blocked'); assert.equal(f.calls().some(c => c.name === 'webchat_ask'), false);
  });
  const f = fixture(); f.wc.save({ enabled: false }); assert.throws(() => f.submit(), /webchat_disabled/); assert.equal(f.calls().length, 0);
  assert.equal(new Webchat({ root: path.join(f.root, 'empty'), gpt: f.gpt, store: f.store, chat }).settings().enabled, false);
});
test('current settings work without any model menu and omit model/thinking from every ask', async () => {
  const f = fixture({ restoredPage: true, modelsError: { error: 'browser_error', message: '找不到 ChatGPT 的模型選單按鈕。' },
    answers: [{ answer: '現在の設定で完了' }] });
  f.wc.save({ model: '', thinking: '' });
  const check = (await f.wc.controlCall()).check;
  assert.equal(check.loggedIn, true); assert.equal(check.modelsChecked, false);
  assert.equal(f.calls().filter(c => c.sessionOpen).length, 1); // A restored home page is loaded as a temporary chat.
  f.submit(); await f.wc.tail;
  assert.equal(f.wc.jobs[0].state, 'done');
  assert.equal(f.calls().some(c => c.name === 'webchat_models'), false);
  const asks = f.calls().filter(c => c.name === 'webchat_ask');
  assert.equal(asks.length, 1);
  for (const ask of asks) {
    assert.equal(Object.hasOwn(ask.arguments, 'model'), false);
    assert.equal(Object.hasOwn(ask.arguments, 'thinking'), false);
  }
  assert.equal(f.wc.settings().model, '');
});
test('current settings never report success or replay when login/temporary state becomes unknown after sending', async t => {
  for (const fake of [{ afterStatusUnknown: true }, { afterTemporaryUnknown: true }]) await t.test(JSON.stringify(fake), async () => {
    const f = fixture(fake); f.wc.save({ model: '', thinking: '' });
    const r = f.submit(); await f.wc.tail;
    assert.equal(f.wc.jobs[0].state, 'unknown'); assert.equal(f.wc.jobs[0].error, 'webchat_selection_unconfirmed');
    assert.equal(f.calls().filter(c => c.name === 'webchat_ask').length, 1);
    assert.equal(f.calls().some(c => c.name === 'webchat_models'), false);
    assert.equal(chat.read(f.pdir, r.task).some(row => row.role === 'assistant' && !row.error && row.request === r.request), false);
  });
});
test('the reopened asking page must confirm login and temporary chat before transport sends', async t => {
  for (const [fake, code] of [
    [{ askLoggedIn: false }, 'webchat_remote_login_unconfirmed'],
    [{ askLoggedIn: 'unknown' }, 'webchat_remote_login_unconfirmed'],
    [{ askTemporary: false }, 'webchat_remote_temporary_chat_unconfirmed'],
    [{ askTemporary: 'unknown' }, 'webchat_remote_temporary_chat_unconfirmed']
  ]) await t.test(JSON.stringify(fake), async () => {
    const f = fixture(fake); f.wc.save({ model: '', thinking: '' });
    f.submit(); await f.wc.tail;
    assert.equal(f.wc.jobs[0].state, 'unknown'); // The Hub does not assume the RPC was unsent.
    assert.equal(f.wc.jobs[0].error, code);
    assert.equal(f.wc.view().check.loggedIn, 'unknown');
    assert.equal(f.wc.view().check.statusError, code);
    assert.equal(f.calls().filter(c => c.name === 'webchat_ask').length, 1);
    assert.equal(f.calls().some(c => c.transportSent || c.name === 'webchat_models'), false);
  });
});
test('explicit selection survives saving/status, requires its menu and never falls back', async () => {
  const f = fixture({ modelsError: { error: 'browser_error', message: '找不到 ChatGPT 的模型選單按鈕。' } });
  f.wc.save({ enabled: true });
  await f.wc.controlCall();
  assert.equal(f.wc.settings().model, 'Pro'); assert.equal(f.wc.settings().thinking, 'Extended');
  assert.equal(f.calls().some(c => c.name === 'webchat_models'), false);
  f.submit(); await f.wc.tail;
  assert.equal(f.wc.jobs[0].state, 'blocked'); assert.equal(f.wc.jobs[0].sent, false);
  assert.equal(f.wc.jobs[0].error, 'webchat_remote_model_menu_unavailable');
  assert.equal(f.wc.view().check.loggedIn, true);
  assert.equal(f.calls().some(c => c.name === 'webchat_ask'), false);
});
test('current settings block before ask for unknown login, unknown temporary chat and challenge', async t => {
  for (const [fake, code] of [
    [{ statusUnknown: true }, 'webchat_login_unconfirmed'],
    [{ loggedIn: false }, 'webchat_login_required'],
    [{ temporaryChat: false }, 'webchat_temporary_chat_unconfirmed'],
    [{ temporaryUnknown: true }, 'webchat_temporary_chat_unconfirmed'],
    [{ challenge: true }, 'webchat_remote_challenge_required']
  ]) await t.test(code, async () => {
    const f = fixture(fake); f.wc.save({ model: '', thinking: '' });
    f.submit(); await f.wc.tail;
    assert.equal(f.wc.jobs[0].state, 'blocked'); assert.equal(f.wc.jobs[0].sent, false);
    assert.equal(f.wc.jobs[0].error, code);
    assert.equal(f.calls().some(c => ['webchat_models', 'webchat_ask'].includes(c.name)), false);
  });
});
test('timeout, peer exit, unconfirmed selection/incomplete response/challenge never resend', async t => {
  for (const fake of [ { answers: [{ delay: 5000 }] }, { answers: [{ exit: true }] }, { wrongCurrent: true }, { wrongThinking: true },
    { answers: [{ answer: '（注意：等待逾時，以下為目前擷取到的回覆內容）\n\npartial' }] },
    { answers: [{ answer: 'answer\n\n[WebChatMCP.js] 以訪客（未登入）身分送出' }] },
    { answers: [{ error: 'challenge_required' }] }, { answers: [{ error: 'rate_limit' }] } ]) await t.test(JSON.stringify(fake), async () => {
    const f = fixture(fake, { timeoutMs: 1500 }); f.submit(); await f.wc.tail;
    assert.equal(f.wc.jobs[0].state, 'unknown'); assert.equal(f.calls().filter(c => c.name === 'webchat_ask').length, 1);
  });
});
test('stop cancels MCP; restart marks saved sending unknown/queued stopped and never starts', async () => {
  const f = fixture({ answers: [{ delay: 2000 }] }); f.submit();
  await waiting(() => f.calls().some(c => c.sendingRecorded));
  f.submit('u');
  const recovered = new Webchat({ root: f.root, gpt: f.gpt, store: f.store, chat });
  assert.equal(recovered.jobs[0].state, 'unknown'); assert.equal(recovered.jobs[1].state, 'stopped'); await recovered.tail;
  assert.equal(f.wc.stop('P', 'u'), true);
  assert.equal(f.wc.stop('P', 't'), true); await f.wc.tail;
  assert.equal(f.wc.jobs[0].state, 'unknown'); assert.equal(f.calls().filter(c => c.name === 'webchat_ask').length, 1);
  assert.throws(() => f.wc.retry('P', 't', f.wc.jobs[0].request, false), /webchat_retry_confirm/);
});
test('stdio child never inherits a caller API-key environment variable', async () => {
  const f = fixture(), saved = process.env.OPENAI_API_KEY;
  try { process.env.OPENAI_API_KEY = 'local-fixture-marker'; await f.wc.controlCall(); }
  finally { if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved; }
  assert.equal(f.calls().find(c => c.env).apiKey, false);
});
test('different tasks serialize globally; stopped queued task never sends; explicit retry gets new request', async () => {
  const f = fixture({ answers: [{ delay: 120, answer: '返答' }] });
  const first = f.submit('t'); f.submit('u'); assert.equal(f.wc.jobs.length, 2);
  f.wc.stop('P', 'u'); await f.wc.tail;
  assert.equal(f.calls().filter(c => c.name === 'webchat_ask').length, 1);
  const old = f.wc.jobs[1]; const retry = f.wc.retry('P', 'u', old.request, true);
  assert.notEqual(retry.request, old.request); await f.wc.tail;
  assert.equal(f.wc.jobs[2].state, 'done'); assert.equal(f.wc.jobs[0].request, first.request);
  const next = f.submit('t'); f.submit('u'); await f.wc.tail;
  const ids = f.calls().filter(c => c.sendingRecorded).map(c => c.request);
  assert.equal(ids[2], next.request); assert.equal(ids[3], f.wc.jobs[4].request);
});
test('saving model choices keeps checked options at the same location, invalidates them on relocation and never starts the peer', async () => {
  const f = fixture();
  await f.wc.controlCall(false, true);
  const check = f.wc.view().check, calls = f.calls().length;
  assert.ok(check.models.length > 0);
  assert.deepEqual(f.wc.save({ enabled: false, model: 'Pro', thinking: '' }).check, check);
  assert.deepEqual(f.wc.save({ location: f.location, enabled: true }).check, check);
  assert.equal(f.calls().length, calls);
  assert.equal(f.wc.save({ location: path.join(f.root, 'not-installed') }).check, null);
  assert.equal(f.calls().length, calls);
  await assert.rejects(() => f.wc.controlCall(), /webchat_not_installed/);
  assert.equal(f.wc.view().busy, false);
});
test('status/login are explicit stdio operations only, idle setting updates and corrupted journal fail closed', async () => {
  const f = fixture(); assert.equal(f.wc.view().check, null); assert.equal(f.calls().length, 0);
  await f.wc.controlCall(); assert.equal(f.wc.view().check.loggedIn, true);
  await f.wc.controlCall(true); assert.equal(f.calls().filter(c => c.name === 'webchat_login').length, 1);
  assert.equal(f.calls().some(c => c.name === 'webchat_ask'), false);
  fs.writeFileSync(f.wc.journal, '{broken'); const restored = new Webchat({ root: f.root, gpt: f.gpt, store: f.store, chat });
  assert.equal(restored.view().journalError, true); assert.throws(() => restored.submit(f.store.readProject('P'), f.store.readTask(f.store.taskFile('P', 't')), 'x'), /webchat_journal_unavailable/);
  assert.throws(() => new WebchatClient({ root: f.root, location: path.join(f.root, 'missing') }), /webchat_not_installed/);
});
test('upstream verification fallback is stopped by the owned process guard before asking', async () => {
  const f = fixture({ challenge: true }); f.submit(); await f.wc.tail;
  assert.equal(f.wc.jobs[0].state, 'blocked');
  assert.equal(f.wc.jobs[0].error, 'webchat_remote_challenge_required');
  assert.equal(f.calls().some(c => c.name === 'webchat_ask'), false);
});
test('incompatible external session cannot bypass the guard or start asking', async () => {
  const f = fixture(); fs.writeFileSync(path.join(f.location, 'dist/session.js'), 'exports.WebChatSession = class {};');
  f.submit(); await f.wc.tail; assert.equal(f.wc.jobs[0].state, 'blocked'); assert.equal(f.calls().length, 0);
});
function mockPeer() { const p = new EventEmitter(); p.stdin = new PassThrough(); p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.killed=false; p.kill=()=>{p.killed=true;}; return p; }
test('remote browser failures expose fixed categories only, without raw paths, URLs or secrets', async () => {
  const marker = 'private-marker https://example.invalid/?token=secret /private/profile';
  const cases = [
    ['browser_error', "Executable doesn't exist at " + marker, 'browser_not_installed'],
    ['browser_error', 'ProcessSingleton: SingletonLock ' + marker, 'browser_profile_busy'],
    ['browser_error', 'page.goto: net::ERR_CONNECTION_RESET at ' + marker, 'navigation_failed'],
    ['browser_error', 'page.goto: Timeout 30000ms exceeded. ' + marker, 'navigation_timeout'],
    ['browser_error', 'ChatGPT 頁面尚未載入可用的輸入框或登入按鈕。' + marker, 'page_not_ready'],
    ['browser_error', '找不到 ChatGPT 的模型選單按鈕（model switcher）。' + marker, 'model_menu_unavailable'],
    ['browser_error', marker, 'browser_error'],
    ['challenge_required', 'page.goto: Timeout 30000ms exceeded. ' + marker, 'challenge_required'],
    ['invalid-' + marker, marker, 'error'],
    ['browser_error', { message: marker }, 'browser_error'],
  ];
  for (const [error, message, category] of cases) {
    const c = Object.create(WebchatClient.prototype);
    let count = 0;
    c.request = async () => { count++; return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error, message }) }] }; };
    await assert.rejects(c.call('webchat_models', {}, 1000), e => {
      assert.equal(e.message, 'webchat_remote_' + category);
      assert.doesNotMatch(e.stack, /private-marker|token=secret|\/private\/profile/);
      return true;
    });
    assert.equal(count, 1, 'diagnostics must not retry a call');
  }
});
test('missing guest model menu reports logged-out only when confirmed and never asks', async () => {
  const modelsError = { error: 'browser_error', message: '找不到 ChatGPT 的模型選單按鈕（model switcher）。' };
  const f = fixture({ loggedIn: false, modelsError });
  const view = await f.wc.controlCall();
  assert.deepEqual(view.check, { loggedIn: false, temporaryChat: true, models: [], thinking: [], modelsChecked: false });
  assert.throws(() => f.submit(), /webchat_login_required/);
  assert.equal(f.wc.jobs.length, 0, 'known logged-out state rejects before accepting input');
  assert.equal(f.calls().some(c => c.name === 'webchat_ask'), false);
});
test('login checks are independent of optional model discovery, with unknown and challenge stored accurately', async () => {
  for (const state of [{ loggedIn: true }, { statusUnknown: true }]) {
    const f = fixture({ ...state, modelsError: { error: 'browser_error', message: '找不到 ChatGPT 的模型選單按鈕。' } });
    const view = await f.wc.controlCall(false, true);
    assert.equal(view.check.loggedIn, state.statusUnknown ? 'unknown' : true);
    assert.equal(view.check.modelsError, state.statusUnknown ? undefined : 'webchat_remote_model_menu_unavailable');
    assert.equal(view.check.modelsChecked, !state.statusUnknown);
  }
  const f = fixture({ challenge: true });
  const view = await f.wc.controlCall(false, true);
  assert.equal(view.check.loggedIn, 'unknown');
  assert.equal(view.check.statusError, 'webchat_remote_challenge_required');
  assert.equal(f.calls().some(c => c.name === 'webchat_models'), false);
  assert.equal(f.calls().some(c => c.name === 'webchat_ask'), false);
});
test('a challenge reached during optional model discovery replaces the earlier logged-in state with unknown', async () => {
  const f = fixture({ modelsError: { error: 'challenge_required', message: 'fixture' } });
  const view = await f.wc.controlCall(false, true);
  assert.equal(view.check.loggedIn, 'unknown'); assert.equal(view.check.temporaryChat, 'unknown');
  assert.equal(view.check.modelsError, 'webchat_remote_challenge_required');
  assert.equal(view.check.statusError, 'webchat_remote_challenge_required');
  assert.equal(f.calls().some(c => c.name === 'webchat_ask'), false);
});
test('external local browser installation is selected without inheriting caller paths or API keys', () => {
  const f = fixture(), localBrowsers = path.join(f.location, 'node_modules', 'playwright-core', '.local-browsers');
  const saved = { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  const environments = [];
  const capture = () => {
    const peer = mockPeer();
    const client = new WebchatClient({ root: f.root, location: f.location, spawnProcess: (exe, args, options) => {
      assert.equal(args[0], '--import'); assert.match(args[1], /^data:text\/javascript;base64,/);
      environments.push(options.env); return peer;
    } });
    client.close();
  };
  try {
    process.env.PLAYWRIGHT_BROWSERS_PATH = '/untrusted-caller-browser';
    process.env.OPENAI_API_KEY = 'local-fixture-marker';
    capture();
    fs.mkdirSync(path.dirname(localBrowsers), { recursive: true });
    fs.writeFileSync(localBrowsers, 'not a directory'); capture();
    fs.unlinkSync(localBrowsers); fs.mkdirSync(localBrowsers); capture();
    assert.equal(environments[0].PLAYWRIGHT_BROWSERS_PATH, undefined);
    assert.equal(environments[1].PLAYWRIGHT_BROWSERS_PATH, undefined);
    assert.equal(environments[2].PLAYWRIGHT_BROWSERS_PATH, localBrowsers);
    for (const env of environments) {
      assert.equal(env.OPENAI_API_KEY, undefined);
      assert.equal(env.WEBCHATMCP_CDP, '0'); assert.equal(env.WEBCHATMCP_PORT, '0');
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
test('invalid JSON-RPC structures close the owned peer and reject every pending call without event exceptions', async t => {
  const response = { jsonrpc: '2.0', id: 1, result: null };
  const invalid = [null, [], true, 7, 'text', {}, { ...response, jsonrpc: '1.0' }, { jsonrpc: '2.0', result: null },
    { ...response, id: null }, { ...response, id: {} }, { ...response, error: { code: -1, message: 'x' } },
    { jsonrpc: '2.0', id: 1 }, ...[null, [], 'error', {}, { code: -1 }, { message: 'x' }, { code: 1.5, message: 'x' }, { code: -1, message: null }].map(error => ({ jsonrpc: '2.0', id: 1, error })),
    { ...response, params: {} }, { jsonrpc: '2.0', method: null }, { jsonrpc: '2.0', method: '' },
    { jsonrpc: '2.0', method: 'notice', params: [] }, { jsonrpc: '2.0', method: 'notice', id: 1 }, { ...response, method: 'notice' }];
  for (const [index, row] of invalid.entries()) await t.test(`structure ${index}`, async () => {
    const f = fixture();
    const p = mockPeer(), c = new WebchatClient({ root: f.root, location: f.location, spawnProcess: () => p });
    const a = assert.rejects(c.request('one', {}, 1000), /webchat_invalid_mcp/);
    const b = assert.rejects(c.request('two', {}, 1000), /webchat_invalid_mcp/);
    assert.doesNotThrow(() => p.stdout.emit('data', Buffer.from(JSON.stringify(row) + '\n')));
    await Promise.all([a, b]); assert.equal(c.closed, true); assert.equal(c.pending.size, 0); assert.equal(p.killed, true);
    assert.doesNotThrow(() => p.stdout.emit('data', Buffer.from('null\n')));
  });
});
test('valid MCP notifications, unknown response IDs, null results and structured errors retain request routing', async () => {
  const f = fixture(), p = mockPeer(), c = new WebchatClient({ root: f.root, location: f.location, spawnProcess: () => p });
  try {
    const a = c.request('one', {}, 1000), b = assert.rejects(c.request('two', {}, 1000), /webchat_mcp_error/);
    const rows = [{ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'fixture' } },
      { jsonrpc: '2.0', id: 99, result: 'unknown' }, { jsonrpc: '2.0', id: 1, result: null },
      { jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'unsupported', data: null } }];
    for (const row of rows) for (const byte of Buffer.from(JSON.stringify(row) + '\n')) p.stdout.emit('data', Buffer.from([byte]));
    assert.equal(await a, null); await b; assert.equal(c.closed, false); assert.equal(c.pending.size, 0);
  } finally { c.close(); }
});
test('broken stdin during invalid MCP shutdown cannot throw or leave requests pending', async () => {
  const f = fixture(), p = mockPeer(), c = new WebchatClient({ root: f.root, location: f.location, spawnProcess: () => p });
  const rejected = assert.rejects(c.request('one', {}, 1000), /webchat_invalid_mcp/);
  p.stdin.write = () => { throw Error('closed fixture stream'); }; p.kill = () => { throw Error('already closed'); };
  assert.doesNotThrow(() => p.stdout.emit('data', Buffer.from('null\n'))); await rejected;
  assert.equal(c.pending.size, 0); assert.equal(c.closed, true);
});

test('same conversation succeeds for dirty, non-Git, Git-direct and freetalk without child/copy/Git mutations', async t => {
  for (const mode of ['dirty', 'nonGit', 'direct', 'freetalk']) await t.test(mode, async () => {
    const f = fixture({ answers: [{ answer: 'この会話への返事' }] });
    if (mode === 'nonGit') fs.rmSync(path.join(f.body, '.git'), { recursive: true });
    if (mode === 'dirty') fs.writeFileSync(path.join(f.body, 'main.txt'), 'unfinished');
    if (mode === 'direct') { execFileSync('git', ['-C', f.body, 'config', 'hub.mode', 'direct']); f.store.updateTask('P', 't', { workspaceMode: 'direct' }); }
    const before = fs.readFileSync(f.store.taskFile('P', 't'));
    f.gpt.gptChildren.request = () => assert.fail('must never create a child');
    f.gpt.call = () => assert.fail('must never invoke a work/report tool');
    f.gpt.settings = () => ({work:true});
    const p = f.store.readProject('P'); if (mode === 'freetalk') p.kind = 'freetalk';
    const r = f.wc.submit(p, f.store.readTask(f.store.taskFile('P', 't')), '今の依頼'); await f.wc.tail;
    assert.equal(r.task, 't'); assert.equal(r.child, undefined); assert.equal(f.wc.jobs[0].state, 'done');
    assert.deepEqual(f.store.readProject('P').tasks.map(t=>t.id).sort(), ['t', 'u']);
    assert.equal(fs.existsSync(path.join(f.root,'Work')), false);
    assert.deepEqual(fs.readFileSync(f.store.taskFile('P','t')), before);
    const rows = chat.read(f.pdir, 't').filter(row=>row.request===r.request);
    assert.deepEqual(rows.map(row=>[row.role,row.text]), [['user','今の依頼'],['assistant','この会話への返事']]);
    assert.equal(f.events.some(([project,task,row])=>project==='P'&&task==='t'&&row.role==='assistant'),true);
    if(mode==='dirty') assert.equal(fs.readFileSync(path.join(f.body,'main.txt'),'utf8'),'unfinished');
    if(mode==='nonGit') assert.equal(fs.existsSync(path.join(f.body,'.git')),false);
    if(mode==='direct') assert.equal(execFileSync('git',['-C',f.body,'config','hub.mode'],{encoding:'utf8'}).trim(),'direct');
  });
});
test('context contains only this task conversation; tool envelopes remain text even with work permission', async () => {
  const f=fixture({answers:[{tool_calls:[tool('run_command',{command:'touch NEVER'}),tool('write_file',{path:'main.txt',text:'bad'})]}]});
  chat.append(f.pdir,'t',{role:'user',text:'same history'}); chat.append(f.pdir,'t',{role:'assistant',ai:'codex',text:'same response'});
  chat.append(f.pdir,'u',{role:'user',text:'FOREIGN-TOPIC'}); chat.append(f.pdir,'t',{role:'event',text:'PRIVATE-TOOL-OUTPUT'});
  const before=fs.readFileSync(f.store.taskFile('P','t')); f.gpt.call=()=>assert.fail('no tools');
  f.submit(); await f.wc.tail;
  const ask=f.calls().find(c=>c.name==='webchat_ask');
  assert.match(ask.arguments.prompt,/same history/); assert.match(ask.arguments.prompt,/same response/);
  assert.doesNotMatch(ask.arguments.prompt,/FOREIGN-TOPIC|PRIVATE-TOOL-OUTPUT|parent branch|original/);
  assert.match(ask.arguments.prompt,/NO tools/);
  assert.equal(f.calls().filter(c=>c.name==='webchat_ask').length,1);
  assert.match(chat.read(f.pdir,'t').at(-1).text,/tool_calls/);
  assert.equal(fs.readFileSync(path.join(f.body,'main.txt'),'utf8'),'original');
  assert.deepEqual(fs.readFileSync(f.store.taskFile('P','t')),before);
  assert.equal(fs.existsSync(path.join(f.body,'NEVER')),false);
});
test('acceptance and final reply failures stop without resend, preserve request and uncertainty', async () => {
  const f=fixture(); const append=f.wc.chat.append;
  f.wc.chat={...chat,append(){throw Error('disk unavailable');}};
  assert.throws(()=>f.submit(), /webchat_history_failed/); await f.wc.tail;
  assert.equal(f.calls().length,0); assert.equal(f.wc.jobs[0].sent,false);
  f.wc.chat={...chat,append(pdir,task,row){if(row.role==='assistant')throw Error('disk unavailable');return append(pdir,task,row);}};
  const r=f.submit(); await f.wc.tail;
  assert.equal(f.wc.jobs.at(-1).state,'unknown'); assert.equal(f.wc.jobs.at(-1).reply,'完了しました');
  assert.equal(f.calls().filter(c=>c.name==='webchat_ask').length,1);
  assert.equal(chat.read(f.pdir,'t').some(row=>row.request===r.request&&row.role==='user'),true);
});
test('same task reservation is immediate; queued ownership checks are repeated before transport', async () => {
  let blocked=false;
  const f=fixture({}, {assertIdle:()=>{if(blocked){const e=Error('webchat_task_busy');e.status=409;throw e;}}});
  const r=f.submit(); assert.throws(()=>f.submit(),/webchat_busy/); blocked=true; await f.wc.tail;
  assert.equal(f.wc.jobs[0].state,'blocked'); assert.equal(f.calls().length,0);
  assert.equal(chat.read(f.pdir,'t').find(row=>row.request===r.request&&row.role==='assistant').delivery,'not-sent');
});
test('legacy active jobs are stopped on restart and never replayed through the new route', async () => {
  const f=fixture(); const old={project:'P',task:'old-child',parent:'t',request:'old',text:'old text',state:'sending',sent:true};
  fs.writeFileSync(f.wc.journal,JSON.stringify([old]));
  const restored=new Webchat({root:f.root,gpt:f.gpt,store:f.store,chat});
  assert.equal(restored.jobs[0].state,'unknown'); assert.equal(restored.jobs[0].parent,'t');
  assert.throws(()=>restored.retry('P','t','old',true),/webchat_legacy_request/);
  await restored.tail; assert.equal(f.calls().length,0); restored.shutdown();
});

test('booted Webchat client uses its captured Hub guard after the on-disk guard changes',()=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-guard-generation-'));
 let client;
 try{
  fs.mkdirSync(path.join(root,'dist'));fs.writeFileSync(path.join(root,'dist/WebChatMCP.js'),'');
  fs.copyFileSync(require.resolve('../lib/webchat-client'),path.join(root,'client.cjs'));
  const guard=path.join(root,'webchat-guard.mjs');fs.writeFileSync(guard,'console.log("captured guard")');
  const Client=require(path.join(root,'client.cjs')).WebchatClient;
  fs.writeFileSync(guard,'throw Error("mixed generation")');
  let observed;
  const proc=new EventEmitter();proc.stdin=new PassThrough();proc.stdout=new PassThrough();proc.stderr=new PassThrough();proc.kill=()=>{};
  client=new Client({location:root,root,spawnProcess:(command,args)=>{observed=execFileSync(command,args,{encoding:'utf8'});return proc;}});
  assert.equal(observed.trim(),'captured guard');
 }finally{client?.close();fs.rmSync(root,{recursive:true,force:true});}
});
