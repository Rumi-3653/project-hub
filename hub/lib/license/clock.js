'use strict';
const { MAX_TERM, int, verifyEnvelope } = require('./codec');
const c = require('node:crypto');
function validState(s) {
  return Boolean(s && Number.isFinite(s.lastSeenAt) && s.lastSeenAt >= 0 && Number.isFinite(s.uptimeSinceAnchor) &&
    s.uptimeSinceAnchor >= 0 && int(s.maxSeq) && s.anchor && int(s.anchor.serverTime) && int(s.anchor.seq));
}
class LicenseClock {
  constructor({ state, elapsed, wall = () => Date.now() / 1000, save }) {
    this.valid = validState(state); this.state = this.valid ? structuredClone(state) : null;
    this.elapsed = elapsed; this.wall = wall; this.save = save;
    this.last = elapsed(); this.mode = 'U'; this.tPrev = 0; this.pending = null;
  }
  tick() {
    const now = this.elapsed(), delta = Math.max(0, now - this.last); this.last = now;
    if (this.state) {
      const s = { ...this.state, uptimeSinceAnchor: this.state.uptimeSinceAnchor + delta };
      if (this.mode === 'T') s.lastSeenAt = Math.max(this.tPrev, this.acceptedTime + now - this.acceptedAt);
      else s.lastSeenAt += delta;
      this.save(s); this.state = s; // Publish only after durable replacement.
      if (s.uptimeSinceAnchor > MAX_TERM) this.mode = 'U';
    }
    const t = this.mode === 'T' ? Math.max(this.tPrev, this.acceptedTime + now - this.acceptedAt) :
      Math.max(this.tPrev, this.wall(), this.state?.lastSeenAt || 0);
    this.tPrev = t;
    return { t, mode: this.mode, valid: this.valid, wall: this.wall(), ...(this.state || {}) };
  }
  request(dev) {
    if (this.pending) throw Error('time_pending');
    this.pending = { nonce: c.randomBytes(32).toString('base64url'), dev, at: this.elapsed() };
    return { nonce: this.pending.nonce, dev, lastSeq: this.state?.maxSeq || 0 };
  }
  accept(envelope, keys) {
    const pending = this.pending, now = this.elapsed();
    // Check lifetime first. Rejected responses do not tick or mutate state.
    if (!pending || now - pending.at < 0 || now - pending.at > 60) return false;
    try {
      const p = verifyEnvelope(envelope, keys, 'time');
      if (p.v !== 1 || p.typ !== 'time' || p.dev !== pending.dev || p.nonce !== pending.nonce ||
          !int(p.serverTime) || !int(p.seq) || p.seq <= (this.state?.maxSeq || 0)) return false;
      const s = { lastSeenAt: p.serverTime, uptimeSinceAnchor: 0, maxSeq: p.seq, anchor: { serverTime: p.serverTime, seq: p.seq } };
      this.save(s);
      this.state = s; this.valid = true; this.mode = 'T'; this.last = now;
      this.acceptedTime = p.serverTime; this.acceptedAt = now; this.tPrev = p.serverTime; this.pending = null;
      return true;
    } catch { return false; }
  }
  resume() { this.pending = null; try { this.tick(); } finally { this.mode = 'U'; } }
  cancel() { this.pending = null; }
}
module.exports = { LicenseClock, validState };
