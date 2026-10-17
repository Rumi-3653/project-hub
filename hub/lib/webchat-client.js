'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
// Capture the Hub-owned guard at module boot, alongside this client.
const GUARD_IMPORT='data:text/javascript;base64,'+fs.readFileSync(path.join(__dirname,'webchat-guard.mjs')).toString('base64');
const object = row => row !== null && typeof row === 'object' && !Array.isArray(row);
const has = (row, key) => Object.hasOwn(row, key);
function rpcMessage(row) {
  if (!object(row) || row.jsonrpc !== '2.0') return false;
  // MCP notifications are permitted; this client offers no server-request tools.
  if (has(row, 'method')) return typeof row.method === 'string' && row.method.length > 0 && !has(row, 'id') &&
    !has(row, 'result') && !has(row, 'error') && (!has(row, 'params') || object(row.params));
  if (!has(row, 'id') || !(typeof row.id === 'string' || typeof row.id === 'number' && Number.isFinite(row.id)) ||
    has(row, 'params') || has(row, 'result') === has(row, 'error')) return false;
  return !has(row, 'error') || object(row.error) && Number.isInteger(row.error.code) && typeof row.error.message === 'string';
}

// Publish only fixed categories. Upstream messages can contain URLs, profile
// paths or credentials; never attach their text/stack to a Hub error.
function remoteError(code, message) {
  if (code === 'browser_error' && typeof message === 'string') {
    if (/Executable doesn't exist/.test(message)) return 'webchat_remote_browser_not_installed';
    if (/ProcessSingleton|SingletonLock/.test(message)) return 'webchat_remote_browser_profile_busy';
    if (/page\.goto:.*net::ERR_/.test(message)) return 'webchat_remote_navigation_failed';
    if (/page\.goto: Timeout \d+ms exceeded/.test(message)) return 'webchat_remote_navigation_timeout';
    if (/頁面尚未載入可用的輸入框或登入按鈕/.test(message)) return 'webchat_remote_page_not_ready';
    if (/找不到 .* 的模型選單按鈕/.test(message)) return 'webchat_remote_model_menu_unavailable';
  }
  return 'webchat_remote_' + (/^[a-z_]{1,80}$/.test(code) ? code : 'error');
}

// Direct stdio MCP only. No CLI plugins, HTTP bridge, shell, or inherited API keys.
class WebchatClient {
  constructor({ location, root, timeoutMs = 630000, spawnProcess = spawn }) {
    const entry = path.join(location, 'dist', 'WebChatMCP.js');
    if (!path.isAbsolute(location) || !fs.existsSync(entry) || !fs.statSync(entry).isFile()) throw Error('webchat_not_installed');
    this.timeoutMs = timeoutMs; this.pending = new Map(); this.seq = 0; this.buffer = ''; this.decoder = new StringDecoder('utf8'); this.closed = false;
    const env = { PATH: path.dirname(process.execPath) + ':/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME,
      USER: process.env.USER, LANG: process.env.LANG || 'en_US.UTF-8', TMPDIR: process.env.TMPDIR || '/private/tmp',
      WEBCHATMCP_PORT: '0', WEBCHATMCP_CDP: '0', WEBCHATMCP_HEADLESS: '1',
      WEBCHATMCP_CHANNEL: 'chrome',
      WEBCHATMCP_PROFILE_DIR: path.join(root, '_hub', 'webchat', 'profile'),
      WEBCHATMCP_PLUGINS_DIR: path.join(root, '_hub', 'webchat', 'plugins'),
      WEBCHATMCP_CODEX_BRIDGE: '0', WEBCHATMCP_CLAUDE_BRIDGE: '0', WEBCHATMCP_GROK_BRIDGE: '0', WEBCHATMCP_HERMES_BRIDGE: '0' };
    // Support `PLAYWRIGHT_BROWSERS_PATH=0 playwright install chromium` inside
    // the external installation, without inheriting a caller's browser path.
    const localBrowsers = path.join(location, 'node_modules', 'playwright-core', '.local-browsers');
    if (fs.existsSync(localBrowsers) && fs.statSync(localBrowsers).isDirectory()) env.PLAYWRIGHT_BROWSERS_PATH = localBrowsers;
    this.process = spawnProcess(process.execPath, ['--import', GUARD_IMPORT, entry], { cwd: location, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    // Never publish browser diagnostics/cookies in a Hub conversation.
    this.process.stderr.on('data', () => {});
    this.process.stdin.on('error', () => this.close('webchat_disconnected'));
    this.process.stdout.on('data', b => this.take(b));
    this.process.on('error', () => this.close('webchat_start_failed'));
    this.process.on('exit', () => this.close('webchat_disconnected'));
  }
  take(buf) {
    if (this.closed) return;
    this.buffer += this.decoder.write(buf);
    if (Buffer.byteLength(this.buffer) > 2 * 1024 * 1024) return this.close('webchat_reply_too_large');
    let at;
    while ((at = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, at); this.buffer = this.buffer.slice(at + 1);
      if (!line.trim()) continue;
      let row; try { row = JSON.parse(line); } catch { return this.close('webchat_invalid_mcp'); }
      if (!rpcMessage(row)) return this.close('webchat_invalid_mcp');
      const p = this.pending.get(row.id); if (!p) continue;
      this.pending.delete(row.id); clearTimeout(p.timer);
      if (row.error) p.reject(Error('webchat_mcp_error')); else p.resolve(row.result);
    }
  }
  notify(method, params) {
    if (!this.closed) try { this.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); }
    catch { this.close('webchat_disconnected'); }
  }
  request(method, params, timeoutMs = this.timeoutMs) {
    if (this.closed) return Promise.reject(Error('webchat_disconnected'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.notify('notifications/cancelled', { requestId: id, reason: 'timeout' }); this.close('webchat_timeout'); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }
      catch { this.close('webchat_disconnected'); }
    });
  }
  async initialize() {
    const r = await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'Project Hub', version: '1' } }, 30000);
    if (!r?.protocolVersion) throw Error('webchat_invalid_mcp');
    this.notify('notifications/initialized', {});
    const list = await this.request('tools/list', {}, 30000);
    if (!['webchat_ask', 'webchat_models', 'webchat_status', 'webchat_login'].every(n => list?.tools?.some(t => t.name === n))) throw Error('webchat_tools_missing');
    this.tools = new Set(list.tools.map(t => t.name));
  }
  async call(name, args, timeoutMs) {
    if (name === 'webchat_logout' && !this.tools?.has(name)) throw Error('webchat_logout_unavailable');
    const r = await this.request('tools/call', { name, arguments: { provider: 'chatgpt', ...args } }, timeoutMs);
    if (!r || !Array.isArray(r.content) || r.content.some(c => !object(c) || c.type !== 'text' || typeof c.text !== 'string')) throw Error('webchat_invalid_reply');
    const text = r.content.map(c => c.text).join('\n');
    if (typeof text !== 'string' || !text.trim()) throw Error('webchat_empty_reply');
    if (r.isError) { let code, message; try { ({ error: code, message } = JSON.parse(text)); } catch {} throw Error(remoteError(code, message)); }
    return text;
  }
  async json(name, args, timeoutMs) { const text = await this.call(name, args, timeoutMs); try { return JSON.parse(text); } catch { throw Error('webchat_invalid_reply'); } }
  close(reason = 'webchat_stopped') {
    if (this.closed) return; this.closed = true;
    // A broken peer must not keep pending calls alive or throw from a stream event.
    for (const id of this.pending.keys()) try { this.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason } }) + '\n'); } catch {}
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Error(reason)); } this.pending.clear();
    try { process.kill(-this.process.pid, 'SIGKILL'); } catch { try { this.process.kill('SIGKILL'); } catch {} }
  }
}
module.exports = { WebchatClient };
