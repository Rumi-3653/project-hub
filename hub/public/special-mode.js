'use strict';
// Shared by the server and browser: the mode chooses an AI, never rewrites roles.
(function (root) {
  const normalize = value => value && typeof value.enabled === 'boolean' && ['claude', 'codex'].includes(value.ai)
    ? { enabled: value.enabled, ai: value.ai } : { enabled: false, ai: 'codex' };
  function pick(value, data, role) {
    const mode = normalize(value);
    if (!mode.enabled) return null;
    const key = mode.ai === 'claude' ? 'claude-code' : 'codex';
    const row = (data.roles || []).find(r => r.name === role);
    const slot = [row?.main, row?.backup].find(s => s?.ai === key && s.model);
    return { ai: mode.ai, model: slot?.model || (data.models?.[key] || [])[0] || '', effort: slot?.effort || '高' };
  }
  const api = { normalize, pick };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HubSpecialMode = api;
})(typeof globalThis === 'object' ? globalThis : this);
