'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {StaticFiles}=require('../lib/static-files'),{preload}=require('../lib/runtime-generation');
test('static boot snapshot survives disk replacement, deletion, addition and gzip; next boot changes',async t=>{
 const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-generation-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'asset.js');fs.writeFileSync(file,'old '.repeat(600));const old=new StaticFiles({root:dir});
 let assets=old;const server=http.createServer((req,res)=>assets.send(req,res,path.join(dir,req.url.slice(1)),'text/javascript',(r,s,b)=>{r.writeHead(s);r.end(b);}));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const url='http://127.0.0.1:'+server.address().port;
 const first=await fetch(url+'/asset.js'),tag=first.headers.get('etag');assert.equal(await first.text(),'old '.repeat(600));
 fs.writeFileSync(file,'new '.repeat(600));fs.writeFileSync(path.join(dir,'added.js'),'new module');
 assert.equal(await(await fetch(url+'/asset.js')).text(),'old '.repeat(600));assert.equal((await fetch(url+'/added.js')).status,404);
 fs.unlinkSync(file);assert.equal((await fetch(url+'/asset.js',{headers:{'If-None-Match':tag}})).status,304);assert.equal(await(await fetch(url+'/asset.js',{headers:{'Accept-Encoding':'gzip'}})).text(),'old '.repeat(600));
 fs.writeFileSync(file,'new');assets=new StaticFiles({root:dir});assert.equal(await(await fetch(url+'/asset.js')).text(),'new');assert.equal((await fetch(url+'/added.js')).status,200);
});
test('preload pins server lazy relative dependencies and their transitive imports',t=>{
 const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-modules-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.writeFileSync(path.join(dir,'child.js'),'module.exports="old"');fs.writeFileSync(path.join(dir,'dep.js'),'module.exports=()=>require("./child")');const server=path.join(dir,'server.js');fs.writeFileSync(server,'module.exports=()=>require("./dep")');
 const loaded=preload(server);assert.ok(loaded.includes(path.join(dir,'dep.js')));fs.writeFileSync(path.join(dir,'child.js'),'module.exports="new"');fs.writeFileSync(path.join(dir,'dep.js'),'module.exports="mixed"');assert.equal(require(server)()(),'old');
 for(const n of ['server','dep','child'])delete require.cache[path.join(dir,n+'.js')];preload(server);assert.equal(require(server)(),'mixed');
});
test('preload permits only an explicitly optional absent marker and still pins present markers',t=>{
 const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-optional-marker-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const server=path.join(dir,'server.js'),marker=path.join(dir,'owner-edition');
 fs.writeFileSync(server,'module.exports=()=>{try{return require("./owner-edition").ownerEdition===true}catch(e){if(e.code==="MODULE_NOT_FOUND")return false;throw e}}');
 assert.throws(()=>preload(server),{code:'MODULE_NOT_FOUND'});
 assert.deepEqual(preload(server,{optional:[marker]}),[]);assert.equal(require(server)(),false);
 fs.writeFileSync(marker+'.js','module.exports={ownerEdition:true}');
 assert.deepEqual(preload(server,{optional:[marker]}),[marker+'.js']);fs.writeFileSync(marker+'.js','module.exports={ownerEdition:false}');assert.equal(require(server)(),true);
 delete require.cache[marker+'.js'];fs.writeFileSync(marker+'.js','module.exports=require("./missing-child")');
 assert.throws(()=>preload(server,{optional:[marker]}),{code:'MODULE_NOT_FOUND'});
 delete require.cache[server];fs.writeFileSync(server,'module.exports=()=>require("./required")');
 assert.throws(()=>preload(server,{optional:[marker]}),{code:'MODULE_NOT_FOUND'});
});
