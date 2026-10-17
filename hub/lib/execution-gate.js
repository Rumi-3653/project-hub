'use strict';
const scope = require('./resource-scope'), U = require('./idea-utils');
// The ledger writer is deliberately independent of these process/Git leases.
class ExecutionGate {
  constructor() { this.managed = new Map(); this.leases = new Map(); this.barrier = true; this.blocked = new Map(); }
  resources(dir) { const real = scope.canonical(dir); return { dirs: [real], git: [scope.commonGit(real)].filter(Boolean) }; }
  register(key, dir) { this.managed.set(key, this.resources(dir)); }
  unregister(key) { this.managed.delete(key); }
  applies(dir) { const r = this.resources(dir); return [...this.managed.values()].some(m => scope.shared(r, m)); }
  beginRestore() { this.barrier = true; }
  finishRestore() { this.barrier = false; }
  block(key, dir, reason) { this.blocked.set(key, { resources: this.resources(dir), reason }); }
  unblock(key) { this.blocked.delete(key); }
  assert({ dir, owner, adoption = false } = {}) {
    if (!adoption) U.check(!this.barrier, 'restore-barrier', '起動時の照合が終わるまで待っています');
    const r = this.resources(dir);
    for (const b of this.blocked.values()) if (scope.shared(r, b.resources)) throw U.fail('scope-recovery', b.reason);
    if (!this.applies(dir)) return;
    for (const l of this.leases.values()) if (l.owner !== owner && scope.shared(r, l.resources)) throw U.fail('execution-busy', '同じ開発場所の処理が終わるまで待っています');
  }
  acquire({ dir, owner, kind = 'write', adoption = false }) {
    U.check(owner, 'lease-owner', '実行の所有者を確認できません'); this.assert({ dir, owner, adoption });
    const old = this.leases.get(owner); if (old) { U.check(U.hash(old.resources) === U.hash(this.resources(dir)), 'lease-scope', '実行先が変わっています'); return old; }
    const lease = { owner, kind, resources: this.resources(dir), id: U.uuid() }; this.leases.set(owner, lease); return lease;
  }
  release(owner, id) { const l = this.leases.get(owner); if (l && (!id || id === l.id)) this.leases.delete(owner); }
  busy(dir, owner) { try { this.assert({ dir, owner }); return false; } catch { return true; } }
}
module.exports = { ExecutionGate };
