'use strict';
// The only test launcher: the OS policy also covers shell/native descendants.
// There is deliberately no unisolated fallback or environment opt-out.
const fs = require('node:fs'), path = require('node:path'), { spawn, execFileSync } = require('node:child_process');
const net = require('node:net'), os = require('node:os');
const sandbox = '/usr/bin/sandbox-exec';
if (process.platform !== 'darwin' || !fs.existsSync(sandbox)) throw Error('test_isolation_unavailable: macOS sandbox-exec is required');
const preload = path.join(__dirname, 'offline.cjs'), entry = path.join(__dirname, 'execute.cjs');
for (const file of [preload, entry]) if (!fs.statSync(file).isFile()) throw Error('test_isolation_missing');
const profile = `(version 1) (allow default)
  (deny network-outbound)
  (allow network-outbound (remote ip "localhost:*"))
  (deny mach-lookup (global-name "com.apple.securityd"))
  (deny file-read* file-write* (regex #"/Library/Keychains(/|$)"))
  (deny process-exec (literal "/usr/bin/security") (literal "/usr/bin/open") (literal "/usr/bin/osascript"))`;
// macOS refuses setuid /bin/ps inside a sandbox. A read-only parent broker
// exposes only the fixed process-list formats used by the product, never an
// executable or arbitrary arguments supplied by a test.
const allowed = args => JSON.stringify(args) === JSON.stringify(['-axo', 'pid=,ppid=,pgid=,uid=,lstart=,stat=,comm='])
  || JSON.stringify(args) === JSON.stringify(['-axo', 'pid=,ppid=,lstart=,command='])
  || args.length === 4 && args[0] === '-p' && /^[1-9][0-9]*$/.test(args[1]) && args[2] === '-o' && ['tty=', 'lstart='].includes(args[3]);
function launch(socket, done) {
  const effective = profile + '\n(allow network-outbound (remote unix-socket (path-literal ' + JSON.stringify(socket) + ')))';
  const child = spawn(sandbox, ['-p', effective, process.execPath, '--require', preload, entry, ...process.argv.slice(2)], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, HUB_TEST_PROCESS_SOCKET: socket, HUB_TEST_OS_ISOLATION: 'macos-v1', HUB_LANG: 'ja' }, stdio: 'inherit',
  });
  child.once('error', error => { console.error(error); process.exitCode = 1; done(); });
  child.once('exit', code => { process.exitCode = code ?? 1; done(); });
}
if (process.env.HUB_TEST_PROCESS_SOCKET) launch(process.env.HUB_TEST_PROCESS_SOCKET, () => {});
else {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-test-process-'));
  fs.chmodSync(dir, 0o700);
  const socket = path.join(dir, 'ps.sock');
  const broker = net.createServer(client => {
    client.setTimeout(2500, () => client.destroy());
    let input = '';
    client.on('error', () => {});
    client.on('data', chunk => {
      input += chunk;
      if (input.length > 1024) return client.destroy();
      if (!input.includes('\n')) return;
      client.removeAllListeners('data');
      try {
        const args = JSON.parse(input.trim());
        if (!Array.isArray(args) || !allowed(args)) throw Error('test_process_arguments_rejected');
        const stdout = execFileSync('/bin/ps', args, { encoding: 'utf8', timeout: 1800, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } });
        client.end(JSON.stringify({ stdout, status: 0 }));
      } catch (error) { client.end(JSON.stringify({ error: error.message, status: 1 })); }
    });
  });
  broker.once('error', error => { console.error(error); process.exitCode = 1; fs.rmSync(dir, { recursive: true, force: true }); });
  broker.listen(socket, () => launch(socket, () => broker.close(() => fs.rmSync(dir, { recursive: true, force: true }))));
}
