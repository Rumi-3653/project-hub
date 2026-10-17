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
// Model capacity is not a subscription limit. Reuse only the explicitly saved
// role destination, without recording a limit or changing the default role.
function capacityRoute(data, o) {
  if (o.ai !== 'codex' || o.limitSwitch || o.automation || o.discussionTurn || o.discussion ||
      o.readOnly || o.freshContext || o.isolatedReview || o.selectionOnly || o.integrationReviewRequest ||
      o.integrationAssignment || o.limitPolicy || o.resultsOrganize || o.resultsRecoveryHash ||
      /\[(?:integration-auto|idea-run):/.test(o.text || '')) return null;
  const target = limitRoute(data, o);
  const flag = target && launch.flagFor(target.ai, target.model);
  return target && (target.ai === 'claude' && flag === 'claude-opus-5-5' ||
    target.ai === 'codex' && flag === 'gpt-6-astra') ? target : null;
}
module.exports = { limitRoute, limitIdentity, capacityRoute };
