'use strict';
// `agy models` の実際の TSV 一覧だけを受け付ける。推測した候補は補わない。
function agyModels(text) {
  const lines = String(text || '').split(/\r?\n/).filter(line => line.trim());
  if (lines.some(line => !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}\t[^\t\x00-\x1f]+$/.test(line))) {
    const error = Error('Invalid Agy model list'); error.code = 'INVALID_MODELS'; throw error;
  }
  const seen = new Set();
  return lines.map(line => {
    const [id, name] = line.split('\t');
    const label = name.trim();
    return { id, label: label && label.length <= 80 && !label.includes('|') ? label : id };
  }).filter(row => !seen.has(row.id) && seen.add(row.id));
}
module.exports = { agyModels };
