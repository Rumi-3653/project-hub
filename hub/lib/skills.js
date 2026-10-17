'use strict';
// 既定アカウントのスキル置き場だけを読む。CLIの起動や設定の変更はしない。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parseDoc, parseValue } = require('./frontmatter');
const MAX_BYTES = 16 * 1024, MAX_ITEMS = 200, MAX_ENTRIES = 2000, TTL = 30000;
const cache = new WeakMap();
const clean = (value, limit) => typeof value === 'string' ? Array.from(value.replace(/\s+/g, ' ').trim()).slice(0, limit).join('') : '';

function metadata(file, fallback) {
  let fd;
  try {
    // FIFOなどを開いて待ち続けない。通常ファイル以外は本文を読まない。
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    if (!fs.fstatSync(fd).isFile()) return { name: fallback, description: '' };
    const bytes = Buffer.alloc(MAX_BYTES);
    const text = bytes.subarray(0, fs.readSync(fd, bytes, 0, MAX_BYTES, 0)).toString('utf8').replace(/^\uFEFF/, '');
    const header = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!header) return { name: fallback, description: '' };
    const data = parseDoc(text).data;
    // 小さな台帳用YAML読み取りはブロック文字列に未対応なので、この2項目だけ補う。
    const value = key => {
      const lines = header[1].split(/\r?\n/), index = lines.findIndex(line => line.startsWith(key + ':'));
      if (index < 0) return '';
      const raw = lines[index].slice(key.length + 1).trim();
      if (/^[>|][+-]?\s*(?:#.*)?$/.test(raw)) {
        const block = [];
        for (let i = index + 1; i < lines.length && (!lines[i].trim() || /^\s/.test(lines[i])); i++) block.push(lines[i].trim());
        return block.join(' ');
      }
      return typeof data[key] === 'string' ? data[key] : parseValue(raw);
    };
    return { name: clean(value('name'), 120) || fallback, description: clean(value('description'), 200) };
  } catch { return { name: fallback, description: '' }; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function scan(dir, system) {
  const result = { dir, found: false, items: [] }, seen = new Set();
  let visited = 0;
  const read = (folder, source, required) => {
    let entries;
    try { entries = fs.opendirSync(folder); if (required) result.found = true; }
    catch (e) { if (required && e.code !== 'ENOENT' && e.code !== 'ENOTDIR') result.error = true; return; }
    try {
      let entry;
      while ((entry = entries.readSync())) {
        if (++visited > MAX_ENTRIES || result.items.length >= MAX_ITEMS) { result.limited = true; break; }
        if (/^[_.]/.test(entry.name) || !entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const folder = path.join(entries.path, entry.name), file = path.join(folder, 'SKILL.md');
        let real;
        try {
          if (!fs.statSync(folder).isDirectory()) continue;
          real = fs.realpathSync(file);
          if (seen.has(real) || !fs.statSync(real).isFile()) continue;
        } catch (e) {
          if (e.code !== 'EACCES' && e.code !== 'EPERM') continue;
          real = file; // 読めないスキルはフォルダ名だけ表示する。
        }
        seen.add(real);
        result.items.push({ ...metadata(file, clean(entry.name, 120)), source });
      }
    } finally { entries.closeSync(); }
  };
  read(dir, 'user', true);
  if (result.found && system && !result.limited) read(path.join(dir, '.system'), 'system', false);
  result.items.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

function listSkills({ accounts, home = accounts?.home || process.env.HUB_AI_HOME || os.homedir(), fresh = false } = {}) {
  const location = ai => accounts ? accounts.location(ai, 'default') : (ai === 'claude' ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME) || path.join(home, ai === 'claude' ? '.claude' : '.codex');
  const dirs = { claude: path.resolve(location('claude'), 'skills'), codex: path.resolve(location('codex'), 'skills') };
  const key = JSON.stringify([home, dirs]), saved = accounts && cache.get(accounts);
  if (!fresh && saved?.key === key && Date.now() - saved.at < TTL) return saved.result;
  const ais = { claude: scan(dirs.claude, false), codex: scan(dirs.codex, true),
    agy: { dir: '', found: false, items: [] }, grok: { dir: '', found: false, items: [] } };
  const base = path.resolve(home);
  for (const ai of ['claude', 'codex']) if (ais[ai].dir === base || ais[ai].dir.startsWith(base + path.sep)) ais[ai].dir = '~' + ais[ai].dir.slice(base.length);
  const result = { checkedAt: new Date().toISOString(), ais };
  if (accounts) cache.set(accounts, { key, at: Date.now(), result });
  return result;
}

module.exports = { listSkills };
