'use strict';
// CLIのチケットIDはサーバー内だけに保持。未確定の使用要求は再起動しても同じ受付番号を使う。
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const validId = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 512;
const resetDetails = data => data?.rateLimits?.rateLimitResetCredits ?? data?.rateLimitResetCredits;
const expiry = value => {
  if (value === null) return Infinity;
  const ms = typeof value === 'number' ? value * 1000 : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && ms > 0 && ms < 4102444800000 ? ms : NaN;
};
const available = (item, now) => item?.status === 'available' && item.resetType === 'codexRateLimits' && validId(item.id) && expiry(item.expiresAt) > now;
const outcomes = new Set(['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed']);
const failure = code => Object.assign(new Error(code), { usageCode: code });

function checkTicket(data, request, now = Date.now()) {
  if (!validId(request.accountId) || data?.accountId !== request.accountId) throw failure('account-changed');
  const reset = resetDetails(data);
  if (request.creditId) {
    if (!Array.isArray(reset?.credits) || !reset.credits.some(item => item.id === request.creditId && available(item, now))) throw failure('ticket-changed');
  } else if (!(Number.isSafeInteger(reset?.availableCount) && reset.availableCount > 0) ||
      reset.credits !== null && !(Array.isArray(reset.credits) && reset.credits.some(item => available(item, now)))) throw failure('ticket-changed');
}

class ResetTickets {
  constructor({ file, now = Date.now } = {}) {
    this.file = file; this.now = now; this.actions = new Map(); this.records = {};
    try {
      if (file) {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!data || typeof data !== 'object' || Array.isArray(data) || Object.values(data).some(r =>
          !validId(r.token) || !validId(r.idempotencyKey) || !['uncertain', 'done'].includes(r.status) || r.status === 'done' && !outcomes.has(r.outcome))) throw failure('journal');
        this.records = data;
      }
    } catch (e) { if (e.code !== 'ENOENT') this.broken = true; }
  }
  identity(account, accountId, creditId) {
    return createHash('sha256').update(JSON.stringify([account, accountId, creditId || null])).digest('hex');
  }
  save(identity, record) {
    if (this.broken) throw failure('journal');
    const next = { ...this.records, [identity]: record };
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(next) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    }
    this.records = next;
  }
  decorate(account, data, reset, revision) {
    if (!reset || !validId(data.accountId) || this.broken) { this.discard(account); return; }
    const previous = this.actions.get(account), list = [], group = this.identity(account, data.accountId, undefined);
    const actionFor = creditId => {
      const identity = this.identity(account, data.accountId, creditId), saved = this.records[identity];
      const old = previous?.find(a => a.identity === identity && a.revision === revision && !a.done);
      const token = saved?.status === 'uncertain' ? saved.token : old?.token || randomUUID();
      list.push({ token, identity, group, creditId, accountId: data.accountId, revision });
      return { token, retry: saved?.status === 'uncertain' };
    };
    const details = resetDetails(data);
    if (this.records[group]?.status === 'uncertain' && reset.count > 0) {
      reset.action = actionFor(undefined);
    } else if (Array.isArray(details?.credits)) {
      const shown = details.credits.slice(0, 1000).filter(item => item?.status === 'available').slice(0, 20);
      reset.items.forEach((item, i) => { if (available(shown[i], this.now())) item.action = actionFor(shown[i].id); });
    } else if (details?.credits === null && reset.count > 0 && !Object.values(this.records).some(r => r.group === group && r.status === 'uncertain')) reset.action = actionFor(undefined);
    this.actions.set(account, list);
  }
  get(account, token, revision, retry) {
    const action = this.actions.get(account)?.find(a => a.token === token && a.revision === revision && !a.done);
    if (!action || this.broken) throw failure('ticket-changed');
    const saved = this.records[action.identity];
    if (saved?.status === 'uncertain' && retry !== true) throw failure('uncertain');
    return { ...action, idempotencyKey: saved?.status === 'uncertain' ? saved.idempotencyKey : randomUUID() };
  }
  start(action) {
    this.save(action.identity, { token: action.token, idempotencyKey: action.idempotencyKey, group:action.group, status: 'uncertain' });
  }
  finish(action, outcome) {
    this.save(action.identity, { token: action.token, idempotencyKey: action.idempotencyKey, group:action.group, status: 'done', outcome });
    const live = [...this.actions.values()].flat().find(a => a.token === action.token);
    if (live) live.done = true;
  }
  discard(account) { this.actions.delete(account); }
}
module.exports = { ResetTickets, checkTicket, validId, outcomes };
