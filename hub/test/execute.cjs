'use strict';
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process');
// Requiring offline.cjs here alone cannot install it: startup preloading is
// mandatory, before test or product modules can capture unguarded primitives.
if (!process[Symbol.for('hub.test.offline')]) throw Error('test_isolation_not_preloaded');
require('./offline.cjs').assertInstalled();
// Verify the OS policy is effective, rather than trusting an environment flag.
// This disposable path is deliberately covered by the same Keychain-path deny.
const os = require('node:os');
const probe = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-test-policy-'));
try {
  fs.mkdirSync(path.join(probe, 'Library'));
  let denied = false;
  try { fs.mkdirSync(path.join(probe, 'Library/Keychains')); }
  catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; denied = true; }
  if (!denied) throw Error('test_isolation_os_inactive');
} finally { fs.rmSync(probe, { recursive: true, force: true }); }
const requested = process.argv.slice(2);
const files = requested.length ? requested : ['test', 'paid/test'].flatMap(dir => fs.existsSync(path.join(__dirname, '..', dir))
  ? fs.readdirSync(path.join(__dirname, '..', dir)).filter(name => name.endsWith('.test.js')).sort().map(name => path.join(dir, name)) : []);
const result = spawnSync(process.execPath, ['--test', ...files], { cwd: path.join(__dirname, '..'), env: { ...process.env, HUB_LANG: 'ja' }, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
