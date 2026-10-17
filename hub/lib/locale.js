'use strict';

// Only application-owned phrases are translated. Interpolated user text,
// filenames, persisted identifiers and CLI model names are kept verbatim.
const { activePack, packHeadings, headingNames } = require('./langpack');
const locale = () => activePack()?.manifest.id || 'ja';
function lt(source, ...values) {
  const template = Array.isArray(source) && Object.hasOwn(source, 'raw');
  const key = template ? source.map((part, i) => part + (i < values.length ? '${' + i + '}' : '')).join('') : String(source);
  const messages = activePack()?.backend.messages;
  const text = messages && Object.hasOwn(messages, key) ? messages[key] : key;
  return template ? text.replace(/\$\{(\d+)\}/g, (all, index) => String(values[Number(index)])) : text;
}
const headings = Object.fromEntries(Object.entries(headingNames).map(([key, names]) => [key, names[1]]));
const sectionNames = heading => {
  const packs = packHeadings();
  const canonical = Object.keys(headingNames).find(key => headingNames[key].includes(heading))
    || Object.keys(headingNames).find(key => packs.some(pack => pack[key] === heading)) || heading;
  return [...new Set([...(headingNames[canonical] || [canonical]), ...packs.map(pack => pack[canonical]).filter(Boolean)])];
};
// Legacy zh-TW packs predate headings metadata; keep their established output.
const sectionName = heading => {
  const name = activePack()?.backend.headings[heading];
  return name && packHeadings().some(pack => pack[heading] === name) ? name
    : locale() === 'zh-TW' ? headings[heading] || heading : heading;
};
const sectionPattern = heading => sectionNames(heading).map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
const label = value => {
  const labels = activePack()?.backend.labels;
  return labels && Object.hasOwn(labels, value) ? labels[value] : value;
};
function config() { const pack = activePack(), language = pack?.manifest.id || 'ja'; return { locale: language, language, dateLocale: pack?.dateLocale || 'ja-JP', messages: pack ? pack.messages : {} }; }
function configScript() {
  return 'window.HUB_LOCALE = ' + JSON.stringify(config()).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029') + ';';
}
module.exports = { lt, locale, config, configScript, sectionNames, sectionName, sectionPattern, label, activePack };
