'use strict';
const path = require('node:path'), os = require('node:os'), fs = require('node:fs');
const { preflight, freePort } = require('./start-windows');
const window = require('./lib/platform/win32-window');
async function main() {
  const platform = require('./lib/platform');
  const root = path.resolve(process.env.HUB_ROOT || path.join(os.homedir(), 'Documents', 'ProjectHub-Windows-Trial'));
  const port = Number(process.env.HUB_PORT || 4545);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw Error('起動する番号は1024〜65535で指定してください');
  await freePort(port);
  preflight({ platform, root });
  const { UpdateStore } = require('./lib/platform/win32-update-store');
  const { selectLaunch, failedLaunch } = require('./lib/app-update-windows');
  const store = new UpdateStore(root), origin = fs.realpathSync.native(__dirname);
  const launch = (recovering = false) => {
    const selected = selectLaunch(store, origin);
    const config = window.configuration({ root: fs.realpathSync.native(root), runtime: selected.runtime, node: process.execPath,
      port, localAppData: process.env.LOCALAPPDATA, bootstrap: origin, updateConfirm: selected.token });
    try { require('node:module').createRequire(path.join(selected.runtime, 'package.json'))('node-pty'); }
    catch {
      if (selected.token && !recovering && failedLaunch(store, origin, selected.token)) return launch(true);
      throw Error('Windows用の依存部品の準備が必要です。自動では導入しません');
    }
    const bridge = window.create();
    let child;
    try { child = bridge.launch(config); } catch (e) {
      bridge.close();
      if (selected.token && !recovering && failedLaunch(store, origin, selected.token)) return launch(true);
      throw e;
    }
    child.once('error', e => { console.error(e.message); process.exitCode = 1; });
    child.once('exit', (code, signal) => {
      // Only the owned native window may return 42, after its owned backend and
      // listening socket have stopped. Never restart next to a running backend.
      // A terminated window may have left its backend alive. Do not change the
      // pointer or start another process until the listening port is free.
      if (signal) { process.exitCode = 1; return; }
      freePort(port).then(() => {
        const failed = selected.token && failedLaunch(store, origin, selected.token);
        if (code === 42 || failed) return launch(Boolean(failed));
        process.exitCode = code ?? 1;
      }).catch(e => { console.error(e.message); process.exitCode = 1; });
    });
  };
  launch();
  process.on('SIGINT', () => console.log('専用窓の閉じる操作で、保存と本体の終了を確認してください。'));
  process.on('SIGTERM', () => console.log('専用窓の閉じる操作で、保存と本体の終了を確認してください。'));
}
if (require.main === module) main().catch(e => { console.error('起動を止めました：' + e.message); process.exitCode = 1; });
module.exports = { main };
