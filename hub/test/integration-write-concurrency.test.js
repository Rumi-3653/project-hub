'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn,execFileSync}=require('node:child_process');
const writes=require('../lib/integration-writes'),race=require('./fixtures/integration-write-race.cjs');
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-write-concurrency-'));
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
const g=(dir,...a)=>execFileSync('git',['-C',dir,...a],{encoding:'utf8',stdio:'pipe'}).trim();
function fixture(name){const r=path.join(root,name),dir=path.join(r,'Product','P');fs.mkdirSync(path.join(dir,'.ai/chat'),{recursive:true});const a=path.join(dir,'.ai/chat/child.jsonl'),b=path.join(dir,'.ai/chat/parent.jsonl');for(const f of [a,b])fs.writeFileSync(f,'baseline\n');g(dir,'init','-q');g(dir,'config','user.name','Fixture');g(dir,'config','user.email','fixture@localhost');g(dir,'add','.');g(dir,'commit','-qm','baseline');writes.register(r);return {r,dir,a,b,c:path.join(r,'barrier')};}
const wait=async f=>{const end=Date.now()+10000;while(!fs.existsSync(f)){assert.ok(Date.now()<end,'barrier was reached');await new Promise(r=>setTimeout(r,10));}};
const end=p=>new Promise((resolve,reject)=>{let err='';p.stderr.on('data',b=>err+=b);p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(Error('local writer exit '+code+': '+err)));});
for(const retire of [false,true])test('別プロセスのjournal更新を保持：'+(retire?'正式保存の証拠退役':'2ファイルの書込み'),async t=>{
 const f=fixture(retire?'retire':'write');if(retire){writes.write(f.b,()=>fs.appendFileSync(f.b,'saved\n'));g(f.dir,'commit','--only','-qm','record saved','--','.ai/chat/parent.jsonl');}
 const p=spawn(process.execPath,['-e',String.raw`const fs=require('node:fs'),w=require(process.argv[1]);w.register(process.argv[2]);require(process.argv[3]).install(process.argv[4],process.argv[5]);w.write(process.argv[5],()=>fs.appendFileSync(process.argv[5],'child\n'));`,require.resolve('../lib/integration-writes'),f.r,require.resolve('./fixtures/integration-write-race.cjs'),f.c,f.a],{stdio:'pipe'}),pDone=end(p);
 pDone.catch(()=>{});await wait(f.c+'.ready');const ctl=race.controller(f.c),ctlDone=end(ctl),restore=race.install(f.c);
 try{if(retire)writes.committed(f.b);else writes.write(f.b,()=>fs.appendFileSync(f.b,'parent\n'));fs.writeFileSync(f.c+'.done','done');}finally{restore();}
 await Promise.all([pDone,ctlDone]);const journal=JSON.parse(fs.readFileSync(path.join(f.r,'_hub/integration-writes.json'))),ignored=writes.ignored(f.dir);
 t.diagnostic(JSON.stringify({head:g(f.dir,'rev-parse','HEAD'),states:{a:writes.state(f.a),b:writes.state(f.b)},journal,trace:fs.readFileSync(f.c+'.trace','utf8').trim().split('\n').map(JSON.parse)}));
 assert.ok(ignored.includes('.ai/chat/child.jsonl'));if(retire)assert.equal(journal[f.b],undefined,'retired entry cannot be resurrected');else assert.ok(ignored.includes('.ai/chat/parent.jsonl'),'parent write retains exact provenance');
});
test('中断したjournal所有者は自動解除せず、未確定書込みをcoldでも拒否',async()=>{
 const f=fixture('crash'),p=spawn(process.execPath,['-e',String.raw`const fs=require('node:fs'),w=require(process.argv[1]);w.register(process.argv[2]);require(process.argv[3]).install(process.argv[4],process.argv[5]);w.write(process.argv[5],()=>fs.appendFileSync(process.argv[5],'interrupted\n'));`,require.resolve('../lib/integration-writes'),f.r,require.resolve('./fixtures/integration-write-race.cjs'),f.c,f.a],{stdio:'pipe'});
 const closed=new Promise(resolve=>p.on('exit',(code,signal)=>resolve({code,signal})));await wait(f.c+'.ready');p.kill('SIGKILL');assert.equal((await closed).signal,'SIGKILL');
 const lock=path.join(f.r,'_hub/integration-writes.lock');assert.ok(fs.existsSync(lock));assert.equal(writes.pending(f.a),true);
 assert.throws(()=>writes.write(f.b,()=>fs.appendFileSync(f.b,'unconfirmed\n')),e=>e.code==='INTEGRATION_WRITE_BUSY');assert.equal(writes.pending(f.b),true);assert.ok(fs.existsSync(lock));assert.deepEqual(writes.ignored(f.dir),[]);
 const cold=execFileSync(process.execPath,['-e',`const w=require(process.argv[1]);w.register(process.argv[2]);console.log(JSON.stringify({ignored:w.ignored(process.argv[3]),a:w.pending(process.argv[4]),b:w.pending(process.argv[5])}));`,require.resolve('../lib/integration-writes'),f.r,f.dir,f.a,f.b],{encoding:'utf8'});
 assert.deepEqual(JSON.parse(cold),{ignored:[],a:true,b:true});assert.ok(fs.existsSync(lock));
});
test('証拠公開失敗はintentを残す；外部変更・stage・権限変更を信頼しない',()=>{
 const f=fixture('failure'),rename=fs.renameSync;fs.renameSync=function(from,to,...a){if(to===path.join(f.r,'_hub/integration-writes.json'))throw Error('injected journal publication failure');return rename.call(fs,from,to,...a);};
 try{assert.throws(()=>writes.write(f.a,()=>fs.appendFileSync(f.a,'unfinished\n')),/publication failure/);}finally{fs.renameSync=rename;}
 assert.equal(writes.pending(f.a),true);assert.ok(!fs.existsSync(path.join(f.r,'_hub/integration-writes.lock')));assert.deepEqual(writes.ignored(f.dir),[]);
 fs.appendFileSync(f.b,'external\n');writes.write(f.b,()=>fs.appendFileSync(f.b,'Hub append cannot launder external change\n'));assert.deepEqual(writes.ignored(f.dir),[]);
 const c=path.join(f.dir,'.ai/chat/staged.jsonl');writes.write(c,()=>fs.writeFileSync(c,'Hub new file'));assert.ok(writes.ignored(f.dir).includes('.ai/chat/staged.jsonl'));g(f.dir,'add','.ai/chat/staged.jsonl');assert.ok(!writes.ignored(f.dir).includes('.ai/chat/staged.jsonl'));
 const d=path.join(f.dir,'.ai/chat/chmod.jsonl');writes.write(d,()=>fs.writeFileSync(d,'Hub new file'));fs.chmodSync(d,0o600);assert.ok(!writes.ignored(f.dir).includes('.ai/chat/chmod.jsonl'));
});
