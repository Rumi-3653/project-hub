'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { lt } = require('./locale');
const { expandHome } = require('./store');
const git = require('./git');
const { inside } = require('./workspace-sandbox');
const { noLinks } = require('./remove');

const fail = (message, status = 409) => { const e = Error(message); e.status = status; throw e; };
// The Hub owns creation and commits. MCP only works inside the child copy.
class GptChildren {
  constructor(deps) { Object.assign(this, deps); this.running = new Set(); this.owners = new Map(); }
  idle(p, t, owner) {
    if (this.running.has(p.id + '/' + t.id) && (!owner || this.owners.get(p.id + '/' + t.id) !== owner)) fail(lt('GPT子のコマンドが実行中です。終了してから送ってください'));
    this.assertIdle?.(p, t, owner);
  }
  async run(p, t, action, reservation) {
    this.idle(p, t, reservation);
    const key = p.id + '/' + t.id;
    const owner = Symbol(key); this.running.add(key); this.owners.set(key, owner);
    try { return await action(owner); } finally { this.running.delete(key); this.owners.delete(key); }
  }
  workspace(p, t) {
    const root = expandHome(t.workdir), parent = p.tasks.find(x => x.id === t.parent);
    const copy = path.join(this.workRoot(p), t.id), base = this.baseOf(p), top = git.repoTop(base);
    const expected = top && path.join(copy, path.relative(top, base));
    const forbidden = [p.dir, this.baseOf(p), parent && expandHome(parent.workdir)].filter(Boolean).map(x => path.resolve(x));
    if (!t.gptChild || t.workspaceMode !== 'isolated' || !path.isAbsolute(root || '') ||
      !fs.existsSync(root) || !fs.statSync(root).isDirectory() || fs.realpathSync(root) !== path.resolve(root) ||
      !inside(root, path.resolve(this.workRoot(p))) || root === path.resolve(this.workRoot(p)) ||
      root !== expected || forbidden.some(x => inside(root, x)) || git.repoTop(root) !== copy) fail(lt('GPT子の専用作業用コピーが必要です'), 403);
    git.recoveryTarget(root, this.baseOf(p), { clean: false });
    return root;
  }
  request() {
    fail(lt('GPT子の新規依頼は廃止しました。ChatGPT（Chat／Pro）で同じ会話に送ってください'));
  }
  save(p, t, owner) {
    const root = this.workspace(p, t);
    this.idle(p, t, owner);
    git.save(root, lt`GPT子の報告：${t.title}`);
    return git.inspect(root).head;
  }
  reportArtifact(p, t, request, text, commit) {
    if (!/^[a-f0-9-]{36}$/.test(request)) fail(lt('このGPT子にその依頼はありません'), 404);
    const relative = `作業/${t.id}/GPT-${request}.md`, file = path.join(p.dir, relative);
    const contents = `# ChatGPT（Chat）\n\n${p.id} / ${t.id}\nrequest: ${request}\n\n${lt`- GPT子の作業用コピーのcommit：${commit}`}\n\n${text}\n`;
    noLinks(file); fs.mkdirSync(path.dirname(file), { recursive: true }); noLinks(file);
    // Reports are Hub-owned artifacts. Reuse an identical report after an interrupted save.
    if (fs.existsSync(file)) {
      if (fs.statSync(file).nlink !== 1 || fs.readFileSync(file, 'utf8') !== contents) fail(lt('GPT子の成果ファイルが変わっています。元の報告を確認してください'));
    } else fs.writeFileSync(file, contents, { flag: 'wx' });
    return `- ファイル：project:${relative}`;
  }
  notify(p, t, request, commit) {
    if (!t.parent || this.chat.read(p.dir, t.parent).some(r => r.from === 'gptchat-report' && r.request === request)) return;
    this.emitRow(p.id, t.parent, this.chat.append(p.dir, t.parent, { role: 'user', from: 'gptchat-report', childTask: t.id,
      request, commit, text: lt`GPT子「${t.title}」に報告があります。子の成果を確認してから［統合…］で取り込んでください。` }));
    this.ended(p.id, t.parent);
  }
}
module.exports = { GptChildren };
