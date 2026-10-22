'use strict';
// Exercise the real JS launcher control flow with owned fake windows/ports.
// No C#, PowerShell, Windows API or child process is executed on this host.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(path.join(__dirname, '../start-window.js'), 'utf8');
function fixture({ pending = false, dependencyFailure = false } = {}) {
  const children = [], calls = [], p = new EventEmitter(), origin = 'C:\\Hub\\hub', next = 'C:\\updates\\next\\hub';
  let current = pending, portBusy = false;
  p.env = { HUB_ROOT: 'C:\\ledger', HUB_PORT: '4545', LOCALAPPDATA: 'C:\\user\\local' }; p.execPath='C:\\node\\node.exe';
  const mod = { exports: {} }, select = () => { calls.push('select'); return { runtime:current?next:origin,token:current?'pending-token':'' }; };
  const rollback = (store, base, token) => { assert.equal(base,origin);calls.push('rollback:'+token);if(!current||token!=='pending-token')return false;current=false;return true; };
  const requireMock = name => {
    if(name==='node:path')return path.win32;
    if(name==='node:os')return { homedir:()=> 'C:\\user' };
    if(name==='node:fs')return { realpathSync:{native:x=>x} };
    if(name==='./start-windows')return { preflight:()=>calls.push('preflight'),freePort:async()=>{calls.push('free-port');if(portBusy)throw Error('port busy');} };
    if(name==='./lib/platform')return {};
    if(name==='./lib/platform/win32-update-store')return { UpdateStore:class {} };
    if(name==='./lib/app-update-windows')return { selectLaunch:select,failedLaunch:rollback };
    if(name==='node:module')return { createRequire:runtime=>()=>{calls.push('dependencies:'+runtime);if(dependencyFailure&&runtime.includes('next'))throw Error('missing native module');} };
    if(name==='./lib/platform/win32-window')return { configuration:x=>x, create:()=>({ launch(config){const child=new EventEmitter();child.config=config;children.push(child);calls.push('window:'+config.runtime);return child;},close(){calls.push('close-bridge');} }) };
    throw Error('Unexpected dependency: '+name);
  };
  const logs=[];vm.runInNewContext(source,{require:requireMock,module:mod,__dirname:origin,process:p,console:{log:x=>logs.push(x),error:x=>logs.push(x)}});
  return { children,calls,p,origin,next,logs,start:()=>mod.exports.main(),busy:()=>{portBusy=true;},settle:async()=>{for(let i=0;i<3;i++)await new Promise(setImmediate);} };
}
test('Windows launcher hands update restart to a fresh owned window only after the port is free',async()=>{
  const f=fixture();await f.start();assert.equal(f.children.length,1);
  assert.equal(f.children[0].config.bootstrap,f.origin);f.children[0].emit('exit',42,null);await f.settle();
  assert.equal(f.children.length,2);assert.deepEqual(f.calls.slice(-4),['free-port','select','dependencies:C:\\Hub\\hub\\package.json','window:'+f.origin]);
});
test('Windows launcher never rolls back or starts another backend after a signal or a still-listening backend',async t=>{
  for(const failure of ['signal','busy'])await t.test(failure,async()=>{
    const f=fixture({pending:true});await f.start();if(failure==='busy')f.busy();f.children[0].emit('exit',1,failure==='signal'?'SIGTERM':null);await f.settle();
    assert.equal(f.children.length,1);assert.equal(f.calls.some(x=>x.startsWith('rollback:')),false);assert.equal(f.p.exitCode,1);
  });
});
test('Windows pending launch failure uses its token to revert once, after owned shutdown, before starting the previous runtime',async()=>{
  const f=fixture({pending:true});await f.start();assert.equal(f.children[0].config.updateConfirm,'pending-token');
  f.children[0].emit('exit',1,null);await f.settle();assert.equal(f.children.length,2);assert.equal(f.children[1].config.runtime,f.origin);
  const at=f.calls.indexOf('rollback:pending-token');assert.equal(f.calls[at-1],'free-port');assert.equal(f.calls.filter(x=>x==='rollback:pending-token').length,1);
  f.children[1].emit('exit',1,null);await f.settle();assert.equal(f.children.length,2);assert.equal(f.p.exitCode,1);
});
test('Missing Windows native dependencies in a pending release revert before any window/server launch',async()=>{
  const f=fixture({pending:true,dependencyFailure:true});await f.start();assert.equal(f.children.length,1);assert.equal(f.children[0].config.runtime,f.origin);
  assert.equal(f.calls.filter(x=>x.startsWith('rollback:')).length,1);assert.ok(f.calls.indexOf('rollback:pending-token')<f.calls.indexOf('window:'+f.origin));
});
