'use strict';
const fs = require('node:fs'), path = require('node:path');
const U = require('./idea-utils');
const talk = r => ['user', 'assistant'].includes(r.role) && typeof r.text === 'string' && r.text.length;
function decorate(rows, generation) {
  const seen = new Map();
  return rows.map(r => {
    if (!talk(r)) return r;
    const textHash = U.hash(r.text), anchor = r.role === 'user' ? r.turn || r.request : r.spoolId || r.request;
    const key = r.role + ':' + (anchor || textHash), n = seen.get(key) || 0; seen.set(key, n + 1);
    return { ...r, ideaSource: { generation, rowRef: U.hash({ generation, key, n, textHash }), textHash } };
  });
}
class IdeaSource {
  constructor({ store, generation = () => 1, blocked = () => false, readRows } = {}) { Object.assign(this, { store, generation, blocked, readRows }); }
  rows(p, task) {
    if (this.readRows) return this.readRows(p, task);
    const file = path.join(p.dir, '.ai/chat', task + '.jsonl'), text = U.strictRead(file);
    return text === null ? [] : text.split('\n').filter(Boolean).map(l => JSON.parse(l));
  }
  capture(project, ref, fallback) {
    U.check(ref && typeof ref.task === 'string' && /^[\w-]+$/.test(ref.task) && typeof ref.rowRef === 'string' && typeof ref.textHash === 'string', 'source', '保存元の会話を確認してください', 400);
    const base = { task: ref.task, generation: ref.generation, rowRef: ref.rowRef, hash: ref.textHash, capture: 'unverified', snapshots: [], boundary: '保存時点の会話だけを参照' };
    try {
      const p = this.store.readProject(project);
      U.check(p && !this.blocked(project, ref.task) && p.tasks.some(t => t.id === ref.task), 'source-task', '保存元の作業を照合できません');
      const before = this.generation(project, ref.task); U.check(before === ref.generation, 'source-generation', '会話の世代が変わっています');
      const rows = decorate(this.rows(p, ref.task), before).filter(talk), index = rows.findIndex(r => r.ideaSource.rowRef === ref.rowRef && r.ideaSource.textHash === ref.textHash);
      U.check(index >= 0 && before === this.generation(project, ref.task), 'source-row', '原文の照合ができません');
      const row = rows[index]; U.check(Buffer.byteLength(row.text) <= 8 * 1024 * 1024, 'text-size', '原文が保存できる容量を超えています', 413);
      if (typeof fallback === 'string') U.check(U.hash(fallback) === ref.textHash, 'source-text', 'クリックした原文が一致しません');
      const nearby = rows.slice(Math.max(0, index - 3), index + 4); let budget = 32 * 1024, omitted = false;
      const snapshots = nearby.flatMap(r => { if (r === row) return []; const size = Buffer.byteLength(r.text); if (size > budget) { omitted = true; return []; } budget -= size; return [{ ref: r.ideaSource.rowRef, role: r.role, text: r.text, hash: r.ideaSource.textHash }]; });
      return { text: row.text, source: { ...base, capture: 'verified', snapshots, omitted, at: new Date().toISOString() } };
    } catch (e) {
      if (e.status === 413) throw e;
      U.check(typeof fallback === 'string' && fallback.trim() && U.hash(fallback) === ref.textHash, 'source-unavailable', '保存元を照合できません。画面の原文も保存できていません', 409);
      U.check(Buffer.byteLength(fallback) <= 65536, 'text-size', '原文全体の保存を確認できません', 413);
      return { text: fallback, source: { ...base, reason: e.message } };
    }
  }
}
module.exports = { IdeaSource, decorate };
