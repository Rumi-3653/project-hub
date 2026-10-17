'use strict';
// Local test-only barriers. Hold one journal publication after its read, then
// release it only after another writer has published or encountered the lock.
const fs=require('node:fs'),path=require('node:path'),{spawn,execFileSync}=require('node:child_process'),{createHash}=require('node:crypto');
const nap=()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
function install(control,holdFile){
 const rename=fs.renameSync,mkdir=fs.mkdirSync,append=fs.appendFileSync,open=fs.openSync,close=fs.closeSync,unlink=fs.unlinkSync,marks=new Map();
 const record=x=>append(control+'.trace',JSON.stringify({pid:process.pid,at:new Date().toISOString(),...x})+'\n');
 const read=f=>{try{return JSON.parse(fs.readFileSync(f,'utf8'));}catch{return null;}};
 const state=f=>{try{return createHash('sha256').update(fs.readFileSync(f)).digest('hex')+':'+(fs.statSync(f).mode&0o777);}catch{return null;}};
 fs.openSync=function(file,flag,...a){const fd=open.call(fs,file,flag,...a);if(flag==='wx'&&String(file).includes('/_hub/integration-write-intents/'))marks.set(fd,file);return fd;};
 fs.closeSync=function(fd,...a){const file=marks.get(fd);marks.delete(fd);const out=close.call(fs,fd,...a);if(file){const intent=read(file),journal=read(path.join(path.dirname(path.dirname(file)),'integration-writes.json')),old=journal?.[intent.file],g=(...a)=>{try{return execFileSync('git',['-C',intent.top,...a],{encoding:'utf8',stdio:'pipe'}).trim();}catch{return null;}},head=g('rev-parse','HEAD'),rel=path.relative(intent.top,intent.file),blob=g('ls-tree','HEAD','--',rel);let baseline=null;if(blob){const id=blob.split(/\s+/)[2];baseline=createHash('sha256').update(execFileSync('git',['-C',intent.top,'cat-file','blob',id])).digest('hex')+':'+(blob.startsWith('100755')?'x':'-');}const normalized=intent.before===null?null:intent.before.split(':')[0]+':'+((Number(intent.before.split(':')[1])&0o111)?'x':'-');record({event:'begin-intent',intent,head,baseline,journal,beginTrusted:normalized===baseline||old?.top===intent.top&&old.after===intent.before&&old.bases?.includes(baseline)});}return out;};
 fs.unlinkSync=function(file,...a){if(String(file).includes('/_hub/integration-write-intents/')){const intent=read(file);record({event:'intent-retire',intent,state:intent&&state(intent.file),journal:read(path.join(path.dirname(path.dirname(file)),'integration-writes.json'))});}return unlink.call(fs,file,...a);};
 let held=false;
 fs.renameSync=function(from,to,...args){
  if(to.endsWith('/_hub/integration-writes.json')){
   const before=read(to),next=read(from);
   record({event:'publish',before,next});
   if(holdFile&&!held&&next?.[holdFile]?.after!==before?.[holdFile]?.after){
    held=true;fs.writeFileSync(control+'.ready','ready');const end=Date.now()+10000;
    while(!fs.existsSync(control+'.release')){if(Date.now()>end)throw Error('test journal barrier timeout');nap();}
   }
  }
  return rename.call(fs,from,to,...args);
 };
 fs.mkdirSync=function(file,...args){
  try{return mkdir.call(fs,file,...args);}catch(e){
   if(String(file).endsWith('/_hub/integration-writes.lock')&&e.code==='EEXIST'){
    fs.writeFileSync(control+'.contended','wait');record({event:'lock-contended'});
   }throw e;
  }
 };
 return ()=>{fs.renameSync=rename;fs.mkdirSync=mkdir;fs.openSync=open;fs.closeSync=close;fs.unlinkSync=unlink;};
}
function controller(control){
 return spawn(process.execPath,['-e',`
 const fs=require('node:fs'),c=process.argv[1],end=Date.now()+10000;
 const timer=setInterval(()=>{if(fs.existsSync(c+'.done')||fs.existsSync(c+'.contended')){fs.writeFileSync(c+'.release','release');clearInterval(timer);}else if(Date.now()>end){clearInterval(timer);process.exitCode=1;}},5);
 `,control],{stdio:'pipe'});
}
module.exports={install,controller};
