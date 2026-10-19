'use strict';
const fs = require('node:fs'), path = require('node:path');
const VERSION = 1;
const absent = () => ({
  active: () => false, read: () => ({ sessions: {} }), limitModels: () => ({}),
  verify() { throw Error('この版には含まれていません'); },
  recover() {}, tick: async () => {}, stop: () => false, settled: async () => {},
});
// Resolve absence separately from execution: a missing dependency inside a
// supplied bundle is a broken installation, never a silent free fallback.
function loadExtensions({ hub = path.join(__dirname, '..') } = {}) {
  const root = path.join(hub, 'paid'), marker = path.join(hub, 'paid-bundle.json');
  const expected = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, 'utf8')) : null;
  if (expected && (expected.version !== VERSION || !Array.isArray(expected.features))) throw Error('invalid paid bundle manifest');
  const definitions = new Map(), instances = new Map();
  if (fs.existsSync(root)) {
    const registry = path.resolve(hub) === path.resolve(__dirname, '..') ? require('../paid') : require(root);
    if (!Array.isArray(registry)) throw Error('invalid extension registry');
    for (const item of registry) {
      if (!item || item.version !== VERSION || !/^[a-z][a-z0-9_-]*$/.test(item.id) || item.feature !== item.id || typeof item.create !== 'function' || definitions.has(item.id)) throw Error('invalid extension contract');
      definitions.set(item.id, Object.freeze(item));
    }
  }
  const missing = (expected?.features || []).filter(id => !definitions.has(id));
  const notice = missing.length ? '有料部品が見つかりません：' + missing.join('、') : '';
  return Object.freeze({
    definition(id) { return definitions.get(id) || Object.freeze({ id, feature: id, version: VERSION, isRequest: () => false, basePrompt: '', create: absent }); },
    create(id, host) {
      const value = this.definition(id).create(Object.freeze(host));
      instances.set(id, value); return value;
    },
    state() { return { version: VERSION, included: [...definitions.keys()], missing, notice }; },
    route(id, req, res, url, body, send) {
      if (!definitions.has(id)) return send(res, 404, { code: 'feature_not_included', error: notice || 'この版には含まれていません' });
      const route = instances.get(id)?.routes?.find(r => r.method === req.method && r.path === url.pathname);
      if (!route) return send(res, 404, { code: 'feature_not_included', error: 'この版には含まれていません' });
      return route.handle({ url, body, res, send });
    },
    uiSource(kind = 'script') {
      if (!['script', 'style'].includes(kind)) throw Error('invalid extension UI kind');
      return [...definitions.values()].map(d => {
        const asset = d.ui?.[kind];
        if (!asset) return '';
        const suffix = kind === 'script' ? '.js' : '.css';
        if (!/^\/paid\/[a-z][a-z0-9_-]*\.(?:js|css)$/.test(asset) || !asset.endsWith(suffix)) throw Error('invalid extension UI path');
        return fs.readFileSync(path.join(hub, 'public', asset), 'utf8');
      }).join('\n;\n');
    },
  });
}
module.exports = { loadExtensions, VERSION };
