'use strict';
// Portable version of the five policy checks returned by the Windows trial.
const test = require('node:test'), assert = require('node:assert/strict'), http = require('node:http');
const { applyWindowPolicy } = require('../lib/platform/win32-window-policy');
async function response(options) {
  const server = http.createServer((req, res) => { applyWindowPolicy(res, options); res.end('fixture'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: server.address().port }, res => {
      res.resume(); res.once('end', () => resolve(res.headers));
    }).on('error', reject));
  } finally { await new Promise(resolve => server.close(resolve)); }
}
test('Windows window sends restrictive CSP on actual HTTP response', async () => {
  const headers = await response({ platform: 'win32', launch: 'fixture', port: 4545 });
  const policy = headers['content-security-policy'];
  assert(policy.includes("default-src 'self'"));
  assert(policy.includes("connect-src 'self' ws://127.0.0.1:4545"));
  assert(policy.includes("form-action 'self'"));
  assert(policy.includes("object-src 'none'"));
  assert(!policy.includes('*'));
});
test('ordinary Windows browser receives no new CSP', async () => {
  assert.equal((await response({ platform: 'win32', launch: '', port: 4545 }))['content-security-policy'], undefined);
});
test('Mac receives no new CSP even with window launch environment', async () => {
  assert.equal((await response({ platform: 'darwin', launch: 'fixture', port: 4545 }))['content-security-policy'], undefined);
});
test('invalid port rejects before header construction', () => {
  for (const port of [0, 80, 65536, 4545.5, '4545; *']) {
    assert.throws(() => applyWindowPolicy({ setHeader() { assert.fail('must not set header'); } }, {
      platform: 'win32', launch: 'fixture', port,
    }), /window_policy_port_invalid/);
  }
});
test('non-Windows does not touch an existing response policy', () => {
  applyWindowPolicy({ setHeader() { assert.fail('response must remain unchanged'); } }, {
    platform: 'darwin', launch: 'fixture', port: 4545,
  });
});
