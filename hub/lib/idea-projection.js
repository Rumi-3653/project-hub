'use strict';
const { hash } = require('./idea-utils');
function render(ledger) {
  const labels = { note: '記録', queued: '作る予定', planning: '作業中', running: '作業中', waiting: '答え待ち', blocked: '要対応', implemented: 'できた（確認待ち）', withdrawn: '停止済み' };
  return '# アイデア帳\n\nHubが生成した表示です。正式な記録と許可は ideas.json に保存しています。\n\n' + require('./idea-order').normalize(ledger).map(id => ledger.items[id]).map(i => {
    const laneRev=i.laneBindingRev||i.implementation?.laneBindingRev;
    const label=laneRev&&laneRev!==ledger.settings.lane?.bindingRev?'以前の実行先の記録':labels[i.status]||i.status;
    return `## ${i.text.split('\n')[0] || '画像の記録'}\n\n状態：${label}\n\n${i.text}\n${(i.images || []).map(x => '画像：' + x.name + '（' + x.id + '／SHA256 ' + x.hash + '）\n').join('')}${i.organized ? '\n背景（' + i.organized.background.kind + '）：' + i.organized.background.text + '\n' : ''}`;
  }).join('\n');
}
// Only entries in the legacy item sections are imported. Instructions remain source material.
function legacy(text) {
  let section = '', out = [], unknown = [];
  text.split(/\r?\n/).forEach((line, n) => {
    if (/^#{1,6}\s/.test(line)) { section = line.replace(/^#+\s*/, '').trim(); return; }
    if (!/^(?:アイデア|未着手|検討中|作る予定|対応済み|済み|記録)(?:（.*）)?$/.test(section)) return;
    const m = line.match(/^\s*[-*]\s+(?:\[([ xX])\]\s*)?(.+)$/);
    if (m) out.push({ text: m[2], historicalDone: Boolean(m[1] && m[1] !== ' '), line: n + 1, key: hash(text) + ':' + (n + 1) });
    else if (line.trim() && !line.trim().startsWith('<!--')) unknown.push({ line: n + 1, text: line });
  });
  return { entries: out, unknown };
}
module.exports = { render, legacy };
