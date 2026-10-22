'use strict';
// Host HTTP integration with an injected Windows native bridge. This exercises
// actual server policy/UI and restart persistence, not Windows APIs or power loss.
const test = require('node:test'), assert = require('node:assert/strict');
const cp = require('node:child_process'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
test('Windows adapter boots and cold-loads saved data with enabled issuer routes and offline transport failures', { timeout: 60000 }, () => {
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-win-http-'));
  const script = String.raw`
    const fs=require('node:fs'),path=require('node:path');
    Object.defineProperty(process,'platform',{value:'win32'});
    const mod=require('./lib/platform/win32'),original=mod.create;
    const posix=require('./lib/platform/persistence').create('darwin');
    mod.create=()=>original({native:{call(action,data){
      if(action==='snapshot')return [{pid:process.pid,ppid:process.ppid,sid:'S-1-5-21-1-2-3-1001',since:'2026-10-18T00:00:00.0000000Z',command:'C:\\node.exe'}];
      if(action==='directory'){posix.syncDirectory(data.path);const s=fs.statSync(data.path);const binding=s.dev+':'+s.ino;if(data.expected&&data.expected!==binding)throw Error('directory changed');return binding;}
      if(action==='file'){posix.syncFile(data.path);return true;}
      if(action==='rename'){fs.renameSync(data.from,data.to);return true;}throw Error('unexpected native request '+action);
    }}});
    // The private source copy has a legitimate owner edition. Exercise the
    // public-edition guard in this isolated fixture without editing its marker.
    const licensing=require('./lib/license'),OriginalLicense=licensing.License;
    const licenseFiles=new Map(),secrets=new Map(),issuerCalls=[];
    const policy=require('./lib/license/policy').forPlatform('win32');
    licensing.License=class extends OriginalLicense {constructor(options){super({...options,owner:false,
      store:{read:k=>licenseFiles.get(k),write:(k,v)=>licenseFiles.set(k,v)},
      secret:{get:k=>secrets.get(k),put:(k,v)=>secrets.set(k,v),elapsed:()=>0},machineHint:()=> 'A'.repeat(43),
      fetcher:(url,init)=>{if(new URL(url).origin!==policy.endpoint)throw Error('unexpected issuer origin');issuerCalls.push(JSON.parse(init.body));return Response.json({code:'issuer_unavailable'},{status:503});}});}};
    (async()=>{
      const probe=require('node:net').createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));
      const port=probe.address().port;await new Promise(r=>probe.close(r));process.env.HUB_PORT=String(port);
      process.env.HUB_WINDOW_LAUNCH='fixture-launch-generation';
      let hub=require('./server'); await hub.restoreReady;
      await new Promise(r=>hub.server.listen(port,'127.0.0.1',r));
      const request=async(route,body)=>{
        const response=await fetch('http://127.0.0.1:'+hub.server.address().port+route,{method:body?'POST':'GET',headers:{connection:'close','X-Hub':'1','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
        return {status:response.status,value:await response.json()};
      };
      const ping=await request('/api/ping');if(ping.value.windowRoot!==process.env.HUB_ROOT||ping.value.windowLaunch!=='fixture-launch-generation'||!ping.value.instance)throw Error('window identity missing');
      const reject=await request('/api/quit',{reason:'windows-window',instance:ping.value.instance,windowLaunch:'wrong'});if(reject.status!==409)throw Error('window mismatch accepted');
      let state=await request('/api/state'); if(state.status!==200||!state.value.windowsStorage)throw Error(JSON.stringify(state));
      if(!state.value.license.activationAvailable||state.value.license.purchaseUrl!==policy.purchaseUrl)throw Error('Windows issuer setting missing');
      const created=await request('/api/project/new',{name:'Windows fixture'});if(created.status!==200)throw Error(JSON.stringify(created));
      const license=await request('/api/license/activate',{code:'fixture-not-a-real-code'});
      if(license.status!==400||license.value.code!=='issuer_unavailable'||!license.value.error.includes('発行先からエラー応答があり、登録を完了できませんでした。'))throw Error('Windows issuer failure not held: '+JSON.stringify(license));
      if(!issuerCalls.some(c=>c.purpose==='activate'&&c.os==='windows'&&c.buildId===policy.build.buildId))throw Error('Windows activation route missing');
      hub.stopControl.cleanExit(); hub.server.closeAllConnections(); await new Promise(r=>hub.server.close(r));
      delete require.cache[require.resolve('./server')];hub=require('./server');await hub.restoreReady;
      await new Promise(r=>hub.server.listen(port,'127.0.0.1',r));
      state=await request('/api/state');if(state.status!==200||!state.value.projects.some(p=>p.name==='Windows fixture'))throw Error('cold saved state missing');
      hub.stopControl.cleanExit();hub.server.closeAllConnections();await new Promise(r=>hub.server.close(r));
      console.log('WINDOWS_FIXTURE_RESULT '+JSON.stringify({http:true,coldSavedState:true,issuerRoutesEnabled:true,externalIssuerCalls:0,nativeExecuted:false}));
      process.exit(0);
    })().catch(e=>{console.error(e.stack);process.exit(1)});
  `;
  try {
    const result = cp.spawnSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 55000,
      env: { ...process.env, TEMP: temp, TMP: temp, HUB_ROOT: path.join(temp, 'root'), HUB_DRY_RUN: '1', HUB_AI_HOME: path.join(temp, 'home'), HUB_FREETALK_HOME: path.join(temp, 'freetalk'), HUB_LANG: 'ja' }, maxBuffer: 1024 * 1024 });
    assert.equal(result.status, 0, String(result.error || '') + result.stdout + result.stderr);
    assert.match(result.stdout, /WINDOWS_FIXTURE_RESULT .*"coldSavedState":true/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
