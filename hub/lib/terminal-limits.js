'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('./chat');
const { recentJsonl, same } = require('./transcript');
const MAX_BYTES = 2 * 1024 * 1024;
// PTYの見た目や引用は証拠にしない。実セッションの増分JSONLだけを確認する。
function capture(ai, accountDir, marker) {
  const dir = path.join(accountDir, ai === 'claude' ? 'projects' : 'sessions');
  return { marker, dir, sizes: Object.fromEntries(recentJsonl(dir, 0, ai === 'claude' ? 1 : 4).map(f => [f, fs.statSync(f).size])), file: null };
}
function readError(s) {
  const watch = s.limitWatch;
  if (!watch) return null;
  const candidates = [];
  for (const file of watch.file ? [watch.file] : recentJsonl(watch.dir, s.started, s.ai === 'claude' ? 1 : 4)) {
    let rows;
    try {
      const size = fs.statSync(file).size, offset = watch.sizes[file] || 0;
      if (size <= offset) continue;
      const fd = fs.openSync(file, 'r');
      let head, tail, start;
      try {
        head = Buffer.alloc(Math.min(size, MAX_BYTES)); fs.readSync(fd, head, 0, head.length, 0);
        start = Math.max(offset, size - MAX_BYTES);
        tail = Buffer.alloc(size - start); fs.readSync(fd, tail, 0, tail.length, start);
      } finally { fs.closeSync(fd); }
      const decode = bytes => bytes.toString('utf8').split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
      rows = decode(head);
      const cwd = s.ai === 'codex' ? rows.find(r => r.type === 'session_meta')?.payload?.cwd : rows.find(r => r.cwd)?.cwd;
      if (!cwd || !same(cwd, s.dir) || watch.marker && !head.toString('utf8').includes(watch.marker)) continue;
      const end = tail.lastIndexOf(10) + 1;
      if (!end) continue;
      const fresh = decode(tail.subarray(start > offset ? tail.indexOf(10) + 1 : 0, end));
      candidates.push({ file, size: start + end, fresh });
    } catch { /* 一時的な未完成/不在は証拠なし */ }
  }
  if (candidates.length !== 1) return null; // 同じ場所の複数CLIを取り違えない。
  const { file, size, fresh } = candidates[0]; watch.file = file; watch.sizes[file] = size;
  for (const row of fresh) {
    const at = Date.parse(row.timestamp || row.at);
    if (!Number.isFinite(at) || at < s.started) continue;
    const error = parse(s.ai, row).find(ev => ev.kind === 'limit');
    if (error) return error.error;
  }
  return null;
}
class TerminalLimits {
  constructor({ sessions, limits, enabled, backup, handoff, refresh, notify = () => {}, now = Date.now, error = readError }) {
    Object.assign(this, { sessions, limits, enabled, backup, handoff, refresh, notify, now, error });
    this.busy = false;
  }
  async check(project, task, ai, s, exited = false) {
    if (!this.enabled() || s.stopped || s.limitTransition || !s.model) return;
    const o = { project, task, ai, model: s.model, effort: s.effort, role: s.role, limitSlot: s.limitSlot, account: s.account, started: s.started };
    const formal = this.error(s), held = this.limits.forRequest(o);
    // 出力静止だけで作業中の道具を止めない。100%は開始前とエラー終了で使い、稼働中は正式エラーを待つ。
    const blocked = held && Date.parse(held.at) >= s.started && exited && s.code !== 0;
    if (!formal && !blocked) return;
    s.limitTransition = true;
    try {
      if (formal) this.limits.record({ ...o, limitError: formal });
      if (!this.backup(o)) return;
      if (!s.exited) {
        s.proc.kill();
        await Promise.race([s.finishedP, new Promise(resolve => { const timer = setTimeout(resolve, 5000); timer.unref?.(); })]);
      }
      if (s.stopped) return;
      if (!s.exited) throw Error('元AIの終了を確認できないため、交代先を開始していません');
      await this.handoff(o, s);
    } catch (e) { this.notify(o, e.message); } finally { s.limitTransitionDone = true; }
  }
  async tick() {
    if (this.busy || !this.enabled()) return;
    this.busy = true;
    try {
      for (const row of this.sessions.list().filter(r => r.running && ['claude', 'codex'].includes(r.ai))) {
        const s = this.sessions.get(row.project, row.task, row.ai);
        if (!s || s.stopped) continue;
        try { await this.refresh?.({ project: row.project, task: row.task, role: s.role, limitSlot: s.limitSlot, ai: row.ai, account: s.account, model: s.model }); } catch (e) { this.notify({ project: row.project, task: row.task, ai: row.ai }, e.message); }
        await this.check(row.project, row.task, row.ai, s);
      }
    } finally { this.busy = false; }
  }
}
module.exports = { TerminalLimits, capture, readError };
