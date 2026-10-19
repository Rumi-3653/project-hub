'use strict';
// Worker-owned stdio lets synchronous callers wait without starving the guard.
const { parentPort, workerData } = require('node:worker_threads');
const { spawn } = require('node:child_process');
const header = new Int32Array(workerData.shared, 0, 4), bytes = new Uint8Array(workerData.shared, 16);
let child, pending = false, timer, rest = '', stopping = false;
function reply(value) {
  if (!pending) return;
  pending = false; clearTimeout(timer);
  let data = Buffer.from(JSON.stringify(value));
  if (data.length > bytes.length) data = Buffer.from('{"ok":false,"stage":"guard-liveness","code":"GUARD_PROTOCOL_FAILED"}');
  bytes.set(data); Atomics.store(header, 1, data.length); Atomics.store(header, 0, 1); Atomics.notify(header, 0);
}
function died(code = 'GUARD_EXITED') {
  Atomics.store(header, 2, 0);
  Atomics.notify(header, 2);
  reply({ ok: false, stage: 'guard-liveness', code });
  if (!stopping) parentPort.postMessage('dead');
}
parentPort.on('message', message => {
  if (message.op === 'terminate' || message.op === 'shutdown') {
    stopping = message.op === 'shutdown';
    if (message.op === 'terminate') child?.kill(); else child?.stdin.end();
    if (!child) parentPort.close();
    return;
  }
  if (pending) { died('GUARD_PROTOCOL_FAILED'); child?.kill(); return; }
  pending = true;
  timer = setTimeout(() => { died('GUARD_TIMEOUT'); child?.kill(); }, 30000);
  if (message.op === 'init') {
    child = spawn(workerData.powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', workerData.script],
      { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      rest += chunk;
      if (rest.length > bytes.length) { died('GUARD_PROTOCOL_FAILED'); child.kill(); return; }
      let newline;
      while ((newline = rest.indexOf('\n')) >= 0) {
        const line = rest.slice(0, newline).replace(/^\uFEFF/, '').trim(); rest = rest.slice(newline + 1);
        try { const value = JSON.parse(line); if (value.ok) Atomics.store(header, 2, 1); reply(value); }
        catch { died('GUARD_PROTOCOL_FAILED'); child.kill(); }
      }
    });
    child.once('error', () => died('GUARD_START_FAILED'));
    child.once('close', () => { died(); parentPort.close(); });
    child.stdin.on('error', () => died());
  }
  if (!child || child.exitCode !== null) { died(); return; }
  child.stdin.write(JSON.stringify(message) + '\n');
});
parentPort.on('close', () => { child?.stdin.end(); });

