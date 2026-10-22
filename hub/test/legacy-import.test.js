'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),c=require('node:crypto');
const {LegacyImport,portableRoles,createRelocator}=require('../lib/legacy-import'),{Store}=require('../lib/store'),{Freetalk}=require('../lib/freetalk');
const sha=b=>c.createHash('sha256').update(b).digest('hex');
const put=(file,text)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);};
function inventory(dir){const result={};function walk(p){for(const n of fs.readdirSync(p)){const f=path.join(p,n),s=fs.lstatSync(f);if(s.isDirectory())walk(f);else result[path.relative(dir,f)]=sha(fs.readFileSync(f));}}walk(dir);return result;}
function fixture(t){
 const home=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-import-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const source=path.join(home,'Documents/AI-Workspace'),root=path.join(home,'trial'),body=path.join(source,'Projects/日本語'),ledger=path.join(source,'Product/日本語');
 put(path.join(ledger,'PROJECT.md'),`---\nname: 日本語\nfolders:\n  本体: ${body}\n---\n# 保存した計画\n`);
 put(path.join(ledger,'.ai/tasks/20261001.md'),`---\nid: 20261001\nworkdir: ${source}/Work/旧作業\nworkspaceMode: isolated\n---\n旧会話 ${body}/資料.txt\n`);
 put(path.join(body,'資料.txt'),'日本語の資料');put(path.join(source,'_hub/roles.yaml'),'roles:\n  調査: { main: [codex, gpt-6.1-sol, 高], backup: [人] }\npermissions: { codex: danger }\nsecret: must-not-copy\n');
 put(path.join(source,'_hub/accounts.json'),'do-not-copy');put(path.join(body,'.env'),'do-not-copy');put(path.join(body,'node_modules/private/key.txt'),'do-not-copy');
 put(path.join(source,'_hub/model-view.json'),JSON.stringify({order:['codex|GPT-6.1-Sol'],phone:{labels:'full',names:{}},hidden:{codex:['old-model']},token:'never-import',specialMode:{enabled:true}}));
 put(path.join(ledger,'.ai/chat/20261001.queue.json'),'[{"text":"do not run"}]');put(path.join(ledger,'.ai/ideas.json'),'[{"auto":true}]');
 const oldFt=new Freetalk(new Store(source),home);assert.equal(oldFt.ensure().ready,true);
 const topic=oldFt.createTopic({ai:'codex',model:'gpt-6.1-sol'},{title:'以前の自由対話'});
 put(path.join(oldFt.ledger,'.ai/chat',topic.id+'.jsonl'),JSON.stringify({text:'日本語 '+oldFt.dir+'/topics/'+topic.id+'/添付.txt'})+'\n');
 put(path.join(oldFt.dir,'topics',topic.id,'添付.txt'),'以前の添付');
 const currentFt=new Freetalk(new Store(root),path.join(root,'_hub/freetalk-home'));assert.equal(currentFt.ensure().ready,true);
 put(path.join(root,'Product/日本語/PROJECT.md'),'現在の台帳');put(path.join(root,'_hub/roles.yaml'),'今の設定');
 const options={home,root,freetalk:currentFt.dir};return {home,source,root,body,ledger,oldFt,currentFt,topic,options,importer:new LegacyImport(options)};
}
test('preview is read-only; additive import relocates projects/topics/attachments and nonsecret settings without overwriting either side',async t=>{
 const f=fixture(t),before=inventory(f.home),p=await f.importer.preview();assert.deepEqual(inventory(f.home),before);assert.equal(p.topics,1);assert.match(p.projects[0].target,/-import-/);
 await f.importer.apply(p.token);assert.equal(fs.readFileSync(path.join(f.root,'Product/日本語/PROJECT.md'),'utf8'),'現在の台帳');
 const j=f.importer.plans.get(p.token).journal,newTask=fs.readFileSync(path.join(p.projects[0].target,'.ai/tasks/20261001.md'),'utf8');
 assert.ok(newTask.includes('workdir: '+p.projects[0].body));assert.ok(!newTask.includes(f.source));assert.match(newTask,/workspaceMode: direct/);
 const doc=fs.readFileSync(path.join(p.projects[0].target,'PROJECT.md'),'utf8');assert.ok(doc.includes(p.projects[0].body));assert.ok(fs.existsSync(path.join(p.projects[0].body,'資料.txt')));
 const id=j.topics[0],rows=fs.readFileSync(path.join(f.currentFt.ledger,'.ai/chat',id+'.jsonl'),'utf8');assert.ok(rows.includes(f.currentFt.dir+'/topics/'+id+'/添付.txt'));
 assert.ok(fs.existsSync(path.join(f.currentFt.dir,'topics',id,'添付.txt')));assert.equal(f.currentFt.verify().kind,'freetalk');
 const roles=f.importer.settings(p.token);assert.equal(roles.roles[0].main.model,'gpt-6.1-sol');assert.equal(fs.readFileSync(path.join(f.root,'_hub/roles.yaml'),'utf8'),'今の設定');
 assert.ok(!fs.existsSync(path.join(p.projects[0].target,'.ai/chat/20261001.queue.json')));assert.match(newTask,/continuation: false/);assert.match(newTask,/state: 未着手/);
 assert.deepEqual(roles.view.order,['codex|GPT-6.1-Sol']);assert.equal(JSON.stringify(roles.view).includes('never-import'),false);
 await f.importer.applyView(p.token,roles.viewRevision);const view=JSON.parse(fs.readFileSync(path.join(f.root,'_hub/model-view.json')));assert.equal(view.phone.labels,'full');assert.equal(view.specialMode,undefined);
 await assert.rejects(f.importer.applyView(p.token,roles.viewRevision),/import_settings_changed/);
 const imported=inventory(path.join(f.root,'Imported'));assert.ok(!Object.keys(imported).some(n=>/\.env|node_modules|accounts/.test(n)));
 for(const [rel,digest] of Object.entries(before))assert.equal(sha(fs.readFileSync(path.join(f.home,rel))),digest,rel);
 const next=await new LegacyImport(f.options).preview();assert.equal(next.mode,'complete');const disk=inventory(f.home);await f.importer.apply(p.token);assert.deepEqual(inventory(f.home),disk);
});
test('interrupted publication resumes by hash without duplicate topics; barriers are released',async t=>{
 const f=fixture(t);let held=false,failed=false;f.importer.barrier=()=>{assert.equal(held,false);held=true;return()=>held=false;};
 f.importer.fault=async i=>{if(i===2&&!failed){failed=true;throw Error('fixture-interruption');}};
 const p=await f.importer.preview();await assert.rejects(f.importer.apply(p.token),/fixture-interruption/);assert.equal(held,false);
 const next=new LegacyImport(f.options),resumed=await next.preview();assert.equal(resumed.mode,'interrupted');await next.apply(resumed.token);
 assert.equal((await new LegacyImport(f.options).preview()).mode,'complete');assert.equal(fs.readdirSync(path.join(f.currentFt.ledger,'.ai/tasks')).length,1);
});
test('changed sources, destination conflicts, unsafe paths and symlinks fail without replacing existing data',async t=>{
 const f=fixture(t),p=await f.importer.preview();put(path.join(f.body,'資料.txt'),'changed');await assert.rejects(f.importer.apply(p.token),/import_source_changed/);
 await assert.rejects(f.importer.preview({workspace:f.root}),/import_overlap/);
 const link=path.join(f.source,'Product/link');fs.symlinkSync(f.ledger,link);await assert.rejects(f.importer.preview(),/link/i);fs.unlinkSync(link);
 const g=fixture(t),q=await g.importer.preview(),dest=g.importer.plans.get(q.token).journal.files[0].to;put(dest,'concurrent');await assert.rejects(g.importer.apply(q.token),/import_destination_changed/);assert.equal(fs.readFileSync(dest,'utf8'),'concurrent');
});
test('journal cannot redirect resume into licence/keys/settings or overwrite the freetalk identity',async t=>{
 const f=fixture(t),p=await f.importer.preview(),j=f.importer.plans.get(p.token).journal;
 for(const dest of [path.join(f.root,'_hub/license/state.json'),path.join(f.root,'_hub/roles.yaml'),path.join(f.currentFt.dir,'.ai/freetalk.json')]){
   const altered={...j,files:[{...j.files[0],to:dest}]};assert.throws(()=>f.importer.validate(altered),/import_journal/);
 }
 const altered={...j,projects:[{name:'../_hub',target:path.join(f.root,'_hub')} ]};assert.throws(()=>f.importer.validate(altered),/import_journal/);
 assert.throws(()=>portableRoles('roles:\n  調査: {main: [unsupported, x]}'),/import_roles/);
});
test('workspace-root body includes direct materials with preview, interruption, dedup and source/current preservation',async t=>{
 const f=fixture(t);
 put(path.join(f.source,'Product/Root/PROJECT.md'),`---\nname: Root\nfolders:\n  本体: ${f.source}\n---\n`);
 put(path.join(f.source,'直下資料.txt'),'直下の資料');put(path.join(f.source,'notes.json'),JSON.stringify({material:f.source+'/直下資料.txt',unchanged:'日本語'}));
 put(path.join(f.source,'.env'),'excluded');put(path.join(f.source,'credentials.json'),'excluded');put(path.join(f.source,'registration-result.json'),'excluded');
 put(path.join(f.source,'node_modules/private.txt'),'excluded directory');put(path.join(f.source,'.git/config'),'excluded directory');
 const before=inventory(f.home),p=await f.importer.preview();assert.deepEqual(inventory(f.home),before);
 const body=p.projects.find(x=>x.name==='Root').body,j=f.importer.plans.get(p.token).journal;
 assert.ok(j.files.some(x=>x.to===path.join(body,'直下資料.txt')));
 for(const name of ['.env','credentials.json','registration-result.json','node_modules','.git'])assert.ok(p.excluded.includes(name));
 let once=false;f.importer.fault=async i=>{if(!once&&j.files[i].to===path.join(body,'直下資料.txt')){once=true;throw Error('root-interrupted');}};
 await assert.rejects(f.importer.apply(p.token),/root-interrupted/);
 const next=new LegacyImport(f.options),resumed=await next.preview();assert.equal(resumed.mode,'interrupted');await next.apply(resumed.token);
 assert.equal(fs.readFileSync(path.join(body,'直下資料.txt'),'utf8'),'直下の資料');
 const info=JSON.parse(fs.readFileSync(path.join(body,'notes.json')));assert.equal(info.material,path.join(body,'直下資料.txt'));assert.equal(info.unchanged,'日本語');
 assert.ok(fs.readFileSync(path.join(p.projects.find(x=>x.name==='Root').target,'PROJECT.md'),'utf8').includes(body));
 for(const name of ['.env','credentials.json','registration-result.json','node_modules','.git'])assert.equal(fs.existsSync(path.join(body,name)),false);
 for(const [rel,digest] of Object.entries(before))assert.equal(sha(fs.readFileSync(path.join(f.home,rel))),digest,rel);
 const complete=await new LegacyImport(f.options).preview();assert.equal(complete.mode,'complete');const disk=inventory(f.home);await next.apply(resumed.token);assert.deepEqual(inventory(f.home),disk);
});
test('direct root materials retain source-change, collision, secret, link and hardlink guards',async t=>{
 for(const fault of ['changed','collision','secret','link','hardlink'])await t.test(fault,async t=>{
   const f=fixture(t),file=path.join(f.source,'root.txt');put(file,'original');
   if(fault==='secret')put(file,'-----BEGIN PRIVATE KEY-----\nsynthetic');
   if(fault==='link'){fs.unlinkSync(file);fs.symlinkSync(path.join(f.body,'資料.txt'),file);}
   if(fault==='hardlink'){fs.unlinkSync(file);fs.linkSync(path.join(f.body,'資料.txt'),file);}
   if(['secret','link','hardlink'].includes(fault)){await assert.rejects(f.importer.preview(),/import_secret|link|import_file/i);return;}
   const p=await f.importer.preview(),item=f.importer.plans.get(p.token).journal.files.find(x=>x.from===file);assert.ok(item);
   if(fault==='changed'){put(file,'changed');await assert.rejects(f.importer.apply(p.token),/import_source_changed/);}
   else{put(item.to,'current');await assert.rejects(f.importer.apply(p.token),/import_destination_changed/);assert.equal(fs.readFileSync(item.to,'utf8'),'current');}
 });
});
test('Windows decoded JSON/JSONL and quoted YAML references point to the relocated attachment without changing keys or similar prefixes',()=>{
 const from=String.raw`C:\Users\fixture\Documents\freetalk`,to=String.raw`C:\Users\fixture\trial\freetalk`,old='20261001-01',next='import-fixture-'+old;
 const relocate=createRelocator([{from,to}],new Map([[old,next]])),source=from+'\\topics\\'+old+'\\添付.txt',dest=to+'\\topics\\'+next+'\\添付.txt';
 const obj={attachment:source,unrelated:from+'-other\\file.txt',number:42,flag:true,nothing:null,nested:[source,{name:'日本語'}],[source]:'unchanged key'};
 const input=JSON.stringify(obj,null,2)+'\r\n',json=relocate(input,true,'.json'),parsed=JSON.parse(json);
 assert.equal(parsed.attachment,dest);assert.equal(parsed.nested[0],dest);assert.equal(parsed.nested[1].name,'日本語');assert.equal(parsed.unrelated,obj.unrelated);assert.equal(parsed[source],'unchanged key');assert.equal(parsed.number,42);assert.equal(parsed.flag,true);assert.equal(parsed.nothing,null);
 assert.ok(json.endsWith('\r\n'));assert.equal(relocate(json,true,'.json'),json);
 const jsonl=relocate(JSON.stringify({attachment:source})+'\r\n \r\n'+JSON.stringify({text:'日本語'})+'\n',true,'.jsonl');
 const rows=jsonl.split(/\r?\n/).filter(x=>x.trim()).map(x=>JSON.parse(x));assert.equal(rows[0].attachment,dest);assert.equal(rows[1].text,'日本語');assert.ok(jsonl.includes('\r\n \r\n'));
 const unicode=JSON.stringify({attachment:source}).replace(/C:/g,'\\u0043:');assert.equal(JSON.parse(relocate(unicode,true,'.json')).attachment,dest);
 assert.equal(JSON.parse(relocate(JSON.stringify({text:'prefix'+from+'\\unrelated.txt'}),true,'.json')).text,'prefix'+from+'\\unrelated.txt');
 assert.equal(JSON.parse(relocate(JSON.stringify({uri:'file:///'+source}),true,'.json')).uri,'file:///'+dest);
 for(const extension of ['.yaml','.yml']){
   const yaml='attachment: '+JSON.stringify(source)+'\nother: '+JSON.stringify(obj.unrelated)+'\nlabel: "日本語"\n';
   const moved=relocate(yaml,true,extension);assert.equal(JSON.parse(moved.split('\n')[0].slice('attachment: '.length)),dest);assert.ok(moved.includes('other: '+JSON.stringify(obj.unrelated)));assert.ok(moved.includes('label: "日本語"'));
   const literal="attachment: '"+source+"'\n";assert.equal(relocate(literal,true,extension),"attachment: '"+dest+"'\n");
 }
 assert.throws(()=>relocate('{"attachment":',true,'.json'),/import_format/);
 assert.throws(()=>relocate('{}\n{"attachment":',true,'.jsonl'),/import_format/);
});
test('invalid structured material rejects preview without publishing or changing either side',async t=>{
 const f=fixture(t);put(path.join(f.source,'broken.json'),' {"path": ');const before=inventory(f.home);
 await assert.rejects(f.importer.preview(),/import_format/);assert.deepEqual(inventory(f.home),before);
});
test('escaped conversation rows resolve to real copied attachments after import and resume',async t=>{
 const f=fixture(t),chat=path.join(f.oldFt.ledger,'.ai/chat',f.topic.id+'.jsonl'),attachment=path.join(f.oldFt.dir,'topics',f.topic.id,'添付.txt');
 // JSON unicode escapes reproduce a serialized-path mismatch on this host;
 // Windows backslash cases above exercise the same production decoder.
 put(chat,JSON.stringify({attachment,text:'会話の保存'}).replace(/\//g,'\\u002f')+'\n');
 put(path.join(f.oldFt.dir,'topics',f.topic.id,'reference.yaml'),'attachment: '+JSON.stringify(attachment).replace(/\//g,'\\u002f')+'\n');
 const before=inventory(f.home),p=await f.importer.preview();await f.importer.apply(p.token);
 const id=f.importer.plans.get(p.token).journal.topics[0],row=JSON.parse(fs.readFileSync(path.join(f.currentFt.ledger,'.ai/chat',id+'.jsonl'),'utf8'));
 assert.equal(row.attachment,path.join(f.currentFt.dir,'topics',id,'添付.txt'));assert.equal(fs.readFileSync(row.attachment,'utf8'),'以前の添付');
 const yaml=fs.readFileSync(path.join(f.currentFt.dir,'topics',id,'reference.yaml'),'utf8'),ref=JSON.parse(yaml.slice('attachment: '.length).trim());
 assert.equal(ref,row.attachment);assert.equal(fs.readFileSync(ref,'utf8'),'以前の添付');
 for(const [rel,digest] of Object.entries(before))assert.equal(sha(fs.readFileSync(path.join(f.home,rel))),digest,rel);
 assert.equal((await new LegacyImport(f.options).preview()).mode,'complete');
});
