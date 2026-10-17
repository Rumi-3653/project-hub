'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const scope=require('../lib/state-read'),{noLinks,readNoLinks}=require('../lib/remove'),{Store}=require('../lib/store'),{Webchat}=require('../lib/webchat');
function fixture(t){const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'state-read-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test('snapshot ends on success, throw, nested run and async continuation',async()=>{
 const owner={},read=()=>++calls;let calls=0;
 scope.run(()=>{assert.equal(scope.memo(owner,'a',read),1);assert.equal(scope.memo(owner,'a',read),1);scope.run(()=>assert.equal(scope.memo(owner,'a',read),2));assert.equal(scope.memo(owner,'a',read),1);});
 assert.equal(scope.memo(owner,'a',read),3);assert.throws(()=>scope.run(()=>{scope.memo(owner,'a',read);throw Error('fixture');}));assert.equal(scope.memo(owner,'a',read),5);
 await scope.run(async()=>{scope.memo(owner,'a',read);await Promise.resolve();assert.equal(scope.memo(owner,'a',read),7);assert.equal(scope.memo(owner,'a',read),8);});
});
test('failed path checks never cache a success; strict guards ignore the read snapshot',t=>{
 const root=fixture(t),dir=path.join(root,'d'),saved=path.join(root,'saved');fs.mkdirSync(dir);
 scope.run(()=>{readNoLinks(path.join(dir,'a'));fs.renameSync(dir,saved);fs.symlinkSync(saved,dir);assert.throws(()=>noLinks(path.join(dir,'a')),/リンク/);});
 assert.throws(()=>readNoLinks(path.join(dir,'a')),/リンク/);
 scope.run(()=>{assert.throws(()=>readNoLinks(dir),/リンク/);fs.unlinkSync(dir);fs.renameSync(saved,dir);readNoLinks(dir);});
});
test('display checks share ancestors once and recheck the next request',t=>{
 const root=fixture(t),original=fs.lstatSync;let calls=0;fs.lstatSync=function(...a){calls++;return original.apply(this,a);};
 try{let first;scope.run(()=>{readNoLinks(path.join(root,'a'));first=calls;readNoLinks(path.join(root,'a'));assert.equal(calls,first);readNoLinks(path.join(root,'b'));assert.equal(calls,first+1);});readNoLinks(path.join(root,'a'));assert.ok(calls>first+1);}finally{fs.lstatSync=original;}
});
test('projects, new/deleted tasks and WebChat settings are fresh outside each display build',t=>{
 const root=fixture(t),store=new Store(root),p=store.createProject({name:'Fixture'}).project;
 const web=new Webchat({root,store}),file=web.file;fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'{"enabled":false}');
 scope.run(()=>{const all=store.listProjects();assert.equal(store.listProjects(),all);assert.equal(store.readProject(p.id),all[0]);const settings=web.settings();assert.equal(web.settings(),settings);});
 const task=store.createTask(p.id,{title:'Fresh'});fs.writeFileSync(file,'{"enabled":true}');
 scope.run(()=>{assert.ok(store.readProject(p.id).tasks.some(x=>x.id===task.id));assert.equal(web.settings().enabled,true);});
 fs.unlinkSync(store.taskFile(p.id,task.id));assert.equal(store.readProject(p.id).tasks.length,0);
 fs.writeFileSync(file,'{"enabled":false}');assert.equal(web.settings().enabled,false);
});
