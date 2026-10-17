'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{Store}=require('../lib/store'),{ProjectNotes}=require('../lib/project-notes');
function fixture(t,lang='ja'){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-notes-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const dir=path.join(root,'Product','Fixture'),file=path.join(dir,'PROJECT.md');fs.mkdirSync(dir,{recursive:true});
 const old='- 原文一行 📝\r\n<!-- 原文コメント -->\r\n- 第三行\r\n',recent='- 最近\r\n- 続き（元改行保持）\r\n',prefix='---\r\nname: Fixture\r\n---\r\n# '+(lang==='ja'?'メモ':'備註')+'\r\n';fs.writeFileSync(file,prefix+recent+old);fs.chmodSync(file,0o640);
 const store=new Store(root),notes=new ProjectNotes({store});return {root,dir,file,old,recent,prefix,store,notes};
}
for(const lang of ['ja','zh-TW'])test('メモ保管は古い原文を改行・コメントごと移しリンク1行と最近の原文・権限を保持：'+lang,t=>{
 const f=fixture(t,lang),p=f.notes.preview('Fixture',2),before=fs.readFileSync(f.file,'utf8');assert.equal(fs.readFileSync(f.file,'utf8'),before);assert.equal(p.movedBytes,Buffer.byteLength(f.old));
 assert.equal(p.order,'newest-first');assert.equal(f.notes.tokens.get(p.token).order,p.order);
 const out=f.notes.apply({project:'Fixture',token:p.token,confirm:true});assert.equal(out.ok,true);const archive=path.join(f.dir,out.archive);assert.ok(fs.readFileSync(archive,'utf8').endsWith(f.old));assert.equal(fs.readFileSync(f.file,'utf8'),f.prefix+`[古いメモの保管先](${out.archive})\r\n`+f.recent);assert.equal(fs.statSync(f.file).mode&0o777,0o640);assert.throws(()=>f.notes.apply({project:'Fixture',token:p.token,confirm:true}));
 const notes=f.notes.read('Fixture');assert.ok(notes.notes.includes('最近'));assert.equal(notes.bytes,Buffer.byteLength(notes.notes));assert.equal(notes.hash,f.store.readProject('Fixture').notesHash);
});
test('新しい順の先頭を残し、日付を推定せず次の節と末尾の改行を保持',t=>{
 const f=fixture(t),recent='- 2026-10-09 最新の成果\n<!-- 最近のコメント -->\n',old='- 2026-09-26 古い成果\n- 日付なしの古い記録\n',suffix='# 他の記録\n最後（改行なし）';fs.writeFileSync(f.file,f.prefix+recent+old+suffix);
 const p=f.notes.preview('Fixture',2),out=f.notes.apply({project:'Fixture',token:p.token,confirm:true}),current=fs.readFileSync(f.file,'utf8'),archived=fs.readFileSync(path.join(f.dir,out.archive),'utf8');
 assert.ok(current.includes(recent));assert.ok(current.endsWith(suffix));assert.equal(current.includes(old),false);assert.ok(archived.endsWith(old));assert.equal(archived.includes(recent),false);
 // Date-like text is ordinary note content; retention follows the explicit newest-first contract.
 fs.writeFileSync(f.file,f.prefix+'- 2020-01-01 先頭の原文\n- 2030-01-01 後方の原文');const next=f.notes.preview('Fixture',1),r=f.notes.apply({project:'Fixture',token:next.token,confirm:true});assert.ok(fs.readFileSync(f.file,'utf8').includes('2020-01-01'));assert.ok(fs.readFileSync(path.join(f.dir,r.archive),'utf8').endsWith('- 2030-01-01 後方の原文'));
});
test('連続保管は既存リンクを残し、最近の行数から除外し、同月リンクと原文を重複しない',t=>{
 const f=fixture(t),first=f.notes.preview('Fixture',2),out=f.notes.apply({project:'Fixture',token:first.token,confirm:true}),archive=path.join(f.dir,out.archive),archived=fs.readFileSync(archive,'utf8'),kept=fs.readFileSync(f.file,'utf8');fs.chmodSync(archive,0o640);
 assert.equal(f.notes.preview('Fixture',2).noChanges,true);assert.equal(fs.readFileSync(f.file,'utf8'),kept);assert.equal(fs.readFileSync(archive,'utf8'),archived);
 const other='[前月の原文](.ai/memory/project-notes-archive-202001.md)\r\n',latest='- 新しい記録\r\n<!-- 新しいコメント -->\r\n';fs.writeFileSync(f.file,f.prefix+latest+kept.slice(f.prefix.length)+other);
 const next=f.notes.preview('Fixture',2);assert.equal(next.movedBytes,Buffer.byteLength(f.recent));f.notes.apply({project:'Fixture',token:next.token,confirm:true});
 const current=fs.readFileSync(f.file,'utf8'),all=fs.readFileSync(archive,'utf8');assert.ok(current.includes(latest));assert.ok(current.endsWith(other));assert.equal(current.split(']('+out.archive+')').length-1,1);assert.equal(current.includes(f.recent),false);assert.ok(all.startsWith(archived));assert.ok(all.endsWith(f.recent));assert.equal(all.includes(other),false);assert.equal(all.includes(']('+out.archive+')'),false);assert.equal(fs.statSync(archive).mode&0o777,0o640);assert.equal(fs.statSync(f.file).mode&0o777,0o640);assert.equal(f.notes.preview('Fixture',2).noChanges,true);
});
test('保管先の保存後に中断しても原文を残し、再起動した処理も再送を拒否',t=>{
 const f=fixture(t),p=f.notes.preview('Fixture',2),before=fs.readFileSync(f.file),archive=path.join(f.dir,p.archive),rename=fs.renameSync;
 fs.renameSync=(from,to)=>{if(to===f.file)throw Error('Fixture: source write interrupted');return rename(from,to);};
 try{assert.throws(()=>f.notes.apply({project:'Fixture',token:p.token,confirm:true}),/source write interrupted/);}finally{fs.renameSync=rename;}
 assert.deepEqual(fs.readFileSync(f.file),before);assert.ok(fs.readFileSync(archive,'utf8').endsWith(f.old));const journal=JSON.parse(fs.readFileSync(path.join(f.dir,'.ai/memory/.project-notes-archive.json'),'utf8'));assert.equal(journal.state,'intent');assert.equal(journal.order,'newest-first');assert.equal(journal.keepLines,2);
 assert.throws(()=>new ProjectNotes({store:f.store}).preview('Fixture',2),/結果が不明/);assert.throws(()=>f.notes.apply({project:'Fixture',token:p.token,confirm:true}));assert.deepEqual(fs.readFileSync(f.file),before);
});
for(const mask of [0o022,0o077])for(const [sourceMode,archiveMode] of [[0o664,0o660],[0o644,0o640],[0o754,0o715]])for(const existing of [false,true])test(`umask${mask.toString(8)}でも通常POSIX権限を保持・新規保管とjournalは0600：${sourceMode.toString(8)}/${archiveMode.toString(8)}/${existing?'既存':'新規'}`,t=>{
 const f=fixture(t),p=f.notes.preview('Fixture',2),archive=path.join(f.dir,p.archive),journal=path.join(f.dir,'.ai/memory/.project-notes-archive.json'),before='保管済み原文\r\n';
 fs.mkdirSync(path.dirname(archive),{recursive:true});fs.chmodSync(f.file,sourceMode);if(existing){fs.writeFileSync(archive,before);fs.chmodSync(archive,archiveMode);}
 // Include an existing journal with broader permissions; internal state always stays private.
 fs.writeFileSync(journal,JSON.stringify({state:'done'}));fs.chmodSync(journal,0o664);
 const q=existing?f.notes.preview('Fixture',2):p,oldMask=process.umask(mask),fchmod=fs.fchmodSync;let restored=0;
 fs.fchmodSync=(fd,mode)=>{assert.equal(fs.fstatSync(fd).mode&0o777,0o600);restored++;return fchmod(fd,mode);};
 try{
  f.notes.apply({project:'Fixture',token:q.token,confirm:true});assert.equal(process.umask(),mask);assert.equal(restored,4);assert.equal(fs.statSync(f.file).mode&0o777,sourceMode);assert.equal(fs.statSync(archive).mode&0o777,existing?archiveMode:0o600);assert.equal(fs.statSync(journal).mode&0o777,0o600);
  const first=fs.readFileSync(archive,'utf8'),kept=fs.readFileSync(f.file,'utf8');assert.ok(first.endsWith(f.old));if(existing)assert.ok(first.startsWith(before));assert.ok(kept.endsWith(f.recent));assert.equal(f.notes.preview('Fixture',2).noChanges,true);
  const latest='- 最新追加\r\n<!-- 最新コメント -->\r\n';fs.writeFileSync(f.file,f.prefix+latest+kept.slice(f.prefix.length));const next=f.notes.preview('Fixture',2);f.notes.apply({project:'Fixture',token:next.token,confirm:true});
  assert.equal(fs.statSync(f.file).mode&0o777,sourceMode);assert.equal(fs.statSync(archive).mode&0o777,existing?archiveMode:0o600);assert.equal(fs.statSync(journal).mode&0o777,0o600);assert.ok(fs.readFileSync(archive,'utf8').startsWith(first));assert.ok(fs.readFileSync(archive,'utf8').endsWith(f.recent));assert.equal(fs.readFileSync(f.file,'utf8'),f.prefix+latest+`[古いメモの保管先](${p.archive})\r\n`);assert.equal(f.notes.preview('Fixture',2).noChanges,true);
 }finally{fs.fchmodSync=fchmod;process.umask(oldMask);}
});
for(const stage of [1,2,3,4])test('権限復元失敗は置換前で停止し原文と権限・intent・再送拒否を保持：'+['','intent','archive','source','done'][stage],t=>{
 const f=fixture(t),p=f.notes.preview('Fixture',2),archive=path.join(f.dir,p.archive),journal=path.join(f.dir,'.ai/memory/.project-notes-archive.json');fs.mkdirSync(path.dirname(archive),{recursive:true});fs.writeFileSync(archive,'既存原文\r\n');fs.chmodSync(archive,0o660);fs.chmodSync(f.file,0o664);
 const q=f.notes.preview('Fixture',2),sourceBefore=fs.readFileSync(f.file),archiveBefore=fs.readFileSync(archive),chmod=fs.fchmodSync,close=fs.closeSync,rename=fs.renameSync,oldMask=process.umask(0o077);let calls=0,failedFd,closed=false,replaced=[];
 fs.fchmodSync=(fd,mode)=>{if(++calls===stage){failedFd=fd;throw Error('Fixture: permission restoration failed');}return chmod(fd,mode);};fs.closeSync=fd=>{if(fd===failedFd)closed=true;return close(fd);};fs.renameSync=(a,b)=>{replaced.push(b);return rename(a,b);};
 try{assert.throws(()=>f.notes.apply({project:'Fixture',token:q.token,confirm:true}),/permission restoration failed/);}finally{fs.fchmodSync=chmod;fs.closeSync=close;fs.renameSync=rename;process.umask(oldMask);}
 assert.equal(closed,true);assert.equal(replaced.length,stage-1);assert.equal(fs.statSync(f.file).mode&0o777,0o664);assert.equal(fs.statSync(archive).mode&0o777,0o660);assert.throws(()=>f.notes.apply({project:'Fixture',token:q.token,confirm:true}));
 if(stage<4)assert.deepEqual(fs.readFileSync(f.file),sourceBefore);else assert.ok(fs.readFileSync(f.file,'utf8').endsWith(f.recent));
 if(stage<=2)assert.deepEqual(fs.readFileSync(archive),archiveBefore);else{assert.ok(fs.readFileSync(archive).subarray(0,archiveBefore.length).equals(archiveBefore));assert.ok(fs.readFileSync(archive,'utf8').endsWith(f.old));}
 const restart=new ProjectNotes({store:f.store});if(stage===1){assert.equal(fs.existsSync(journal),false);const next=restart.preview('Fixture',2);assert.throws(()=>restart.apply({project:'Fixture',token:next.token,confirm:true}),/EEXIST/);}else{assert.equal(JSON.parse(fs.readFileSync(journal,'utf8')).state,'intent');assert.equal(fs.statSync(journal).mode&0o777,0o600);assert.throws(()=>restart.preview('Fixture',2),/結果が不明/);}
});
for(const destination of ['journal','archive','source'])test('権限復元でも一時パスのsymlinkを拒否しリンク先の原文と権限を保持：'+destination,t=>{
 const f=fixture(t),p=f.notes.preview('Fixture',2),archive=path.join(f.dir,p.archive),journal=path.join(f.dir,'.ai/memory/.project-notes-archive.json');fs.mkdirSync(path.dirname(archive),{recursive:true});fs.symlinkSync(f.file,({journal,archive,source:f.file})[destination]+'.tmp');
 const before=fs.readFileSync(f.file),mode=fs.statSync(f.file).mode&0o777;assert.throws(()=>f.notes.apply({project:'Fixture',token:p.token,confirm:true}));assert.deepEqual(fs.readFileSync(f.file),before);assert.equal(fs.statSync(f.file).mode&0o777,mode);
});
for(const mode of ['source','archive','confirm','busy','expired','symlink','interrupted'])test('保管の変更・不明・リンクは再送せず原文を保持：'+mode,t=>{
 const f=fixture(t),p=f.notes.preview('Fixture',2),archive=path.join(f.dir,p.archive);
 if(mode==='source')fs.appendFileSync(f.file,'追加');
 if(mode==='archive'){fs.mkdirSync(path.dirname(archive),{recursive:true});fs.writeFileSync(archive,'後追加');}
 if(mode==='busy')f.notes.busy=()=>true;
 if(mode==='expired')f.notes.tokens.get(p.token).at=0;
 if(mode==='symlink'){fs.mkdirSync(path.dirname(archive),{recursive:true});fs.symlinkSync(f.file,archive);}
 if(mode==='interrupted'){fs.mkdirSync(path.dirname(archive),{recursive:true});fs.writeFileSync(archive+'.tmp','別保存');}
 const before=fs.readFileSync(f.file);assert.throws(()=>f.notes.apply({project:'Fixture',token:p.token,confirm:mode!=='confirm'}));assert.deepEqual(fs.readFileSync(f.file),before);
 if(mode==='interrupted'){assert.throws(()=>f.notes.preview('Fixture',2),/結果が不明/);assert.throws(()=>f.notes.apply({project:'Fixture',token:p.token,confirm:true}));}
});
