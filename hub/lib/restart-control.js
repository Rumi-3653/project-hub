'use strict';
const { lt } = require('./locale');
// Reservation does not lock ongoing work. Commit is synchronous: inspect, verify,
// then close the start gate before any asynchronous restart operation is scheduled.
class RestartControl {
  constructor({ blockers, verify, execute, now = () => new Date().toISOString() }) {
    Object.assign(this, { blockers, verify, execute, now });
    this.reserved = null; this.committed = false; this.executions = 0; this.error = '';
  }
  status(waiting) { return { reserved: this.reserved, committed: this.committed, executions: this.executions, error: this.error, waiting: this.reserved ? waiting ?? this.blockers() : [] }; }
  commit() {
    if (this.committed) return this.status();
    const waiting = this.blockers();
    if (waiting.length) throw Object.assign(Error(lt('AIの作業が終わるまで更新できません。')), { status: 409, waiting });
    this.verify();
    this.committed = true; this.reserved = null; this.error = ''; this.executions++;
    this.execute();
    return this.status();
  }
  request(reserve = false) {
    if (this.committed) return this.status();
    if (reserve) {
      if (!this.reserved) this.reserved = { at: this.now() };
      this.tick(); return this.status();
    }
    return this.commit();
  }
  cancel() { if (this.committed) throw Object.assign(Error(lt('再起動を開始しています')), { status: 409 }); this.reserved = null; this.error = ''; return this.status(); }
  tick() {
    if (!this.reserved || this.committed || this.blockers().length) return;
    try { this.commit(); } catch (e) { this.error = e.message; }
  }
}
module.exports = { RestartControl };
