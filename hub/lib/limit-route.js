'use strict';
const launch = require('./launch');
// 設定画面のmain/backupを実際の起動へ結ぶ。設定自体は書き換えない。
function limitIdentity(data, o) {
  const matches = slot => slot && launch.AI_KEY[o.ai] === slot.ai && launch.flagFor(o.ai, slot.model) === launch.flagFor(o.ai, o.model);
  const row = (data.roles || []).find(r => (!o.role || r.name === o.role) && (matches(r.main) || matches(r.backup)));
  if (!row) return null;
  return { role: row.name, limitSlot: matches(row.main) ? 'main' : 'backup' };
}
function limitRoute(data, o) {
  if (data.switch?.auto !== true) return null;
  // 起動時に一致していた欄は保持する。稼働中に設定を変えても、交代先は最新の保存値。
  const identity = ['main', 'backup'].includes(o.limitSlot) && o.role ? o : limitIdentity(data, o);
  const row = identity && (data.roles || []).find(r => r.name === identity.role);
  if (!row) return null;
  const limitSlot = identity.limitSlot === 'main' ? 'backup' : 'main', slot = row[limitSlot];
  if (!slot) return null;
  const ai = slot.ai === 'claude-code' ? 'claude' : slot.ai;
  const model = launch.flagFor(ai, slot.model);
  if (!launch.AIS.includes(ai) || !model || ai === o.ai && model === launch.flagFor(o.ai, o.model)) return null;
  return { ai, model: launch.modelLabel(ai, model), requiredModel: model, requireModel: true, role: row.name, limitSlot, effort: slot.effort || '高' };
}
// Only Sol -> Astra may return once. The returned Sol cannot start another
// capacity handoff, so a busy pair never loops or consumes waiting instructions.
function capacityModel(model) {
  const id = launch.flagFor('codex', model), match = /^gpt-(\d+(?:\.\d+)*)-(sol|astra)$/.exec(id);
  return match ? { id, version: match[1].split('.').map(Number), family: match[2] } : null;
}
function capacityReturnAllowed(o) {
  return o.limitSwitch?.reason === 'capacity' && o.ai === 'codex' &&
    capacityModel(o.model)?.family === 'astra' && o.limitSwitch.sourceAI === 'codex' &&
    capacityModel(o.limitSwitch.sourceModel)?.family === 'sol';
}
function newer(a, b) {
  for (let i = 0; i < Math.max(a.version.length, b.version.length); i++) {
    const diff = (b.version[i] || 0) - (a.version[i] || 0);
    if (diff) return diff;
  }
  return a.id.localeCompare(b.id);
}
// Capacity is separate from quota routing: only the current, discovered Codex
// Sol/Astra pair with positive subscription evidence may be used. Never guess IDs
// or use known-but-removed models, paid credits, or absence of a quota hold.
function capacityRoute(data, o, { models = [], available = () => false } = {}) {
  if (data.switch?.auto !== true || o.ai !== 'codex' || o.limitSwitch && !capacityReturnAllowed(o) || o.automation || o.discussionTurn || o.discussion ||
      o.readOnly || o.freshContext || o.isolatedReview || o.selectionOnly || o.integrationReviewRequest ||
      o.integrationAssignment || o.limitPolicy || o.resultsOrganize || o.resultsRecoveryHash ||
      /\[(?:integration-auto|idea-run):/.test(o.text || '')) return null;
  const source = capacityModel(o.model);
  if (!source) return null;
  const candidates = models.map(row => ({ ...capacityModel(row.id), row }))
    .filter(m => m.id && m.id === m.row.id && m.family !== source.family).sort(newer);
  const target = candidates[0];
  if (!target || available([source.id, target.id], o.account || 'default') !== true) return null;
  const row = (data.roles || []).find(r => r.name === o.role);
  const limitSlot = ['main', 'backup'].find(key => row?.[key]?.ai === 'codex' &&
    capacityModel(row[key].model)?.family === target.family);
  const effort = row?.[limitSlot]?.effort || o.effort || '高';
  if (Array.isArray(target.row.efforts) && !target.row.efforts.includes(effort)) return null;
  return { ai: 'codex', model: launch.modelLabel('codex', target.id), requiredModel: target.id,
    requireModel: true, role: o.role, ...(limitSlot ? { limitSlot } : {}), effort };
}
module.exports = { limitRoute, limitIdentity, capacityRoute, capacityReturnAllowed };
