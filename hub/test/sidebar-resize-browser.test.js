'use strict';
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
let chromium;
try { ({ chromium } = require('playwright-core')); }
catch { try { ({ chromium } = require(path.join(os.homedir(), '.local/lib/node_modules/openclaw/node_modules/playwright-core'))); } catch {} }
const chrome = process.env.HUB_TEST_CHROME || [path.join(os.homedir(), '.local/bin/chrome-headless-arm64'), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p => fs.existsSync(p));
if (!chromium || !chrome) test('一覧の幅調整の実ブラウザ確認（Chrome/Playwrightが必要）', { skip: true }, () => {});
else {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-sidebar-browser-'))), root = path.join(tmp, 'root');
  const pdir = path.join(root, 'Product', 'サンプルアプリ');
  fs.mkdirSync(path.join(root, '_hub'), { recursive: true });
  fs.cpSync(path.join(__dirname, '../seed/サンプルアプリ'), pdir, { recursive: true });
  fs.writeFileSync(path.join(pdir, 'PROJECT.md'), fs.readFileSync(path.join(pdir, 'PROJECT.md'), 'utf8').replace('~/Documents/SampleApp', path.join(tmp, 'SampleApp')));
  fs.copyFileSync(path.join(__dirname, '../../docs/project-hub/templates/_hub/roles.yaml'), path.join(root, '_hub/roles.yaml'));
  fs.writeFileSync(path.join(root, '_hub/onboarding.json'), JSON.stringify({ version: 1, status: 'done', step: 'first', ais: ['codex'] }));
  Object.assign(process.env, { HUB_ROOT: root, HUB_AI_HOME: path.join(tmp, 'home'), HUB_FREETALK_HOME: path.join(tmp, 'freetalk'), HUB_DRY_RUN: '1', HUB_PORT: '0', HUB_AUTO_UPDATE: '0', HUB_AUTO_TRANSLATE: '0' });
  const chat = require('../lib/chat'), originalSend = chat.ChatRunner.prototype.send;
  let starts = 0, rt, browser, page, base;
  const errors = [], posts = [];
  chat.ChatRunner.prototype.send = function () { starts++; throw Error('一覧の幅確認でAIを起動しない'); };
  const width = () => page.locator('#list').evaluate(el => Math.round(el.getBoundingClientRect().width));
  const saved = () => page.evaluate(() => localStorage.getItem('hub-sidebar-width'));
  const resize = async (width, height, expected) => {
    await page.setViewportSize({ width, height });
    // viewport の変更完了と resize イベントによるレイアウト反映は別のタイミング。
    await page.waitForFunction(value => {
      const divider = document.querySelector('#sidebar-resize');
      return value === null ? divider.hidden : !divider.hidden && Math.round(document.querySelector('#list').getBoundingClientRect().width) === value;
    }, expected);
  };
  const screenshot = async name => {
    if (!process.env.HUB_TEST_SCREENSHOT_DIR) return;
    fs.mkdirSync(process.env.HUB_TEST_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.HUB_TEST_SCREENSHOT_DIR, name + '.png') });
  };
  test.before(async () => {
    const probe = require('node:net').createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
    const port = probe.address().port; await new Promise(r => probe.close(r)); process.env.HUB_PORT = String(port);
    rt = require('../server'); await new Promise(r => rt.server.listen(port, '127.0.0.1', r)); base = 'http://127.0.0.1:' + port;
    browser = await chromium.launch({ executablePath: chrome, headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', req => { if (req.method() === 'POST') posts.push(new URL(req.url()).pathname); });
    await page.addInitScript(() => {
      localStorage.setItem('hub-view', JSON.stringify({ kind: 'work', project: 'サンプルアプリ', task: 'sample-app-01' }));
      localStorage.setItem('hub-mode', 'chat');
    });
    await page.goto(base); await page.waitForSelector('#chat-in');
  });
  test.after(async () => {
    await browser?.close(); rt?.sessions.stopAll(); rt?.server.closeAllConnections();
    if (rt) await new Promise(r => rt.server.close(r));
    chat.ChatRunner.prototype.send = originalSend;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  test('境界のドラッグ・キーボード操作・再読込で幅を保存し、未送信の文章と画面を保つ', async () => {
    const divider = page.locator('#sidebar-resize');
    assert.equal(await width(), 240); assert.equal(await divider.getAttribute('aria-label'), 'プロジェクト一覧の幅を調整');
    await page.locator('#chat-in').fill('まだ送っていない文章');
    await page.evaluate(() => { window.sidebarDraftNode = document.querySelector('#chat-in'); window.sidebarMainNode = document.querySelector('#main').firstElementChild; });
    const rect = await divider.boundingBox();
    await page.mouse.move(rect.x + rect.width / 2, rect.y + 80); await page.mouse.down();
    await page.mouse.move(rect.x + rect.width / 2 + 100, rect.y + 80); await page.mouse.up();
    assert.equal(await width(), 340); assert.equal(await saved(), '340');
    assert.equal(await page.locator('#chat-in').inputValue(), 'まだ送っていない文章');
    assert.equal(await page.evaluate(() => window.sidebarDraftNode === document.querySelector('#chat-in') && window.sidebarMainNode === document.querySelector('#main').firstElementChild), true);
    await divider.press('ArrowRight'); assert.equal(await width(), 350);
    await divider.press('Shift+ArrowLeft'); assert.equal(await width(), 300);
    await divider.press('Home'); assert.equal(await width(), 180);
    await divider.press('End'); assert.equal(await width(), 480);
    await screenshot('sidebar-desktop');
    await page.reload(); await page.waitForSelector('#chat-in'); assert.equal(await width(), 480); assert.equal(await saved(), '480');
  });
  test('ドラッグ中の取消は幅を保存せず、画面が狭くなっても元の希望幅を保持する', async () => {
    const rect = await page.locator('#sidebar-resize').boundingBox();
    await page.mouse.move(rect.x + 3, rect.y + 80); await page.mouse.down(); await page.mouse.move(rect.x - 80, rect.y + 80);
    assert.ok(await width() < 480); await page.keyboard.press('Escape'); await page.mouse.up();
    assert.equal(await width(), 480); assert.equal(await saved(), '480');
    assert.equal(await page.locator('body').evaluate(el => el.classList.contains('resizing-sidebar')), false);
    await resize(800, 1000, 434); assert.equal(await width(), 434); assert.equal(await saved(), '480');
    await resize(1280, 1000, 480); assert.equal(await width(), 480);
  });
  test('スマホでは境界を隠し、一覧の開閉と未送信の文章を保つ', async () => {
    await page.locator('#chat-in').fill('スマホでも残る文章');
    await resize(390, 900, null);
    assert.equal(await page.locator('#sidebar-resize').isVisible(), false);
    await page.waitForFunction(() => document.querySelector('#list').getBoundingClientRect().right <= 0);
    await page.locator('#menu-toggle').click();
    await page.waitForFunction(() => Math.abs(document.querySelector('#list').getBoundingClientRect().left) < 1);
    await screenshot('sidebar-mobile-open');
    await page.locator('#menu-toggle').click();
    await page.waitForFunction(() => document.querySelector('#list').getBoundingClientRect().right <= 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await page.locator('#chat-in').inputValue(), 'スマホでも残る文章');
    await screenshot('sidebar-mobile-closed');
    await resize(1280, 1000, 480); assert.equal(await width(), 480);
    assert.equal(starts, 0); assert.deepEqual(errors, []);
    assert.equal(posts.some(route => /chat\/send|term\/start|delegate|discussion\/start/.test(route)), false);
  });
}
