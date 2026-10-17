'use strict';
const fs=require('node:fs'),path=require('node:path'),U=require('./idea-utils');
// Only explicit human/Hub lifecycle operations can change the stable registry binding.
function backup(ideas,project,b={}) {
  U.opId(b.opId);const s=ideas.resolve(project);U.check(s,'backup-empty','保存済みの台帳がありません');const d=ideas.read(project,{recover:true}),dir=path.join(ideas.control,'backups',d.projectUid,b.opId),index=path.join(dir,'backup.json');
  const prior=U.json(index);if(prior)return {saved:true,backupFile:index,backupHash:U.hash(prior),projectUid:d.projectUid};
  for(const image of Object.values(d.images||{})){require('./idea-images').verify(s,image);require('./idea-images').verify(s,image,true);}
  fs.mkdirSync(dir,{recursive:true});const ledger=U.strictRead(s.file),md=U.strictRead(s.md),files=[];
  function keep(relative,bytes){if(bytes===null)return;bytes=Buffer.from(bytes);const dest=path.join(dir,relative);ideas.writeFile(dest,{base64:bytes.toString('base64')},U.uuid());files.push({path:relative,hash:U.hash(bytes)});}
  keep('ledger',ledger);keep('markdown',md);
  function walk(root,relative='control'){if(!fs.existsSync(root))return;for(const name of fs.readdirSync(root)){const from=path.join(root,name),stat=fs.lstatSync(from);U.check(!stat.isSymbolicLink(),'backup-link','台帳の保管場所にリンクがあるため照合が必要です');if(stat.isDirectory())walk(from,relative+'/'+name);else if(stat.isFile()&&name!=='writer.owner')keep(relative+'/'+name,fs.readFileSync(from));}}
  walk(s.controlDir);const record={schema:1,projectUid:d.projectUid,project,entry:s,ledgerHash:U.hash(ledger),files,at:new Date(ideas.clock()).toISOString()};ideas.writeFile(index,record,b.opId);return {saved:true,backupFile:index,backupHash:U.hash(record),projectUid:d.projectUid};
}
function relocate(ideas,project,b) {
  const registered=Object.values(ideas.readRegistry().projects).find(e=>e.projectUid===b.projectUid);
  if(registered)require('./idea-erase').recover(ideas,project,{...registered,file:path.join(registered.dir,'ideas.json'),controlDir:path.join(ideas.control,'projects',registered.projectUid)});
  U.opId(b.opId);U.check(b.confirm===true&&typeof b.backupFile==='string'&&U.inside(path.join(ideas.control,'backups'),b.backupFile),'registry-relocate','保管した台帳を選んで移転を確認してください');
  const saved=U.json(b.backupFile);U.check(saved?.schema===1&&U.hash(saved)===b.backupHash&&saved.projectUid===b.projectUid,'registry-backup','保管記録が一致しません');const base=path.dirname(b.backupFile);
  const files=new Map(saved.files.map(f=>{U.check(!path.isAbsolute(f.path)&&!f.path.split('/').includes('..'),'registry-backup','保管パスが不正です');const bytes=Buffer.from(U.json(path.join(base,f.path)).base64,'base64');U.check(U.hash(bytes)===f.hash,'registry-backup','保管内容が変更されています');return [f.path,bytes];}));
  const p=ideas.project(project),real=fs.realpathSync(p.dir),lock=path.join(ideas.control,'registry.owner');ideas.lock(lock);
  try{
    ideas.recoverFile(ideas.registryFile);const registry=ideas.readRegistry(),old=Object.values(registry.projects).find(e=>e.projectUid===b.projectUid);
    U.check(old&&(!registry.projects[project]||registry.projects[project].projectUid===b.projectUid),'registry-alias','別の台帳が登録されています');
    if(old.relocatedByOp===b.opId){const d=ideas.read(project,{recover:true}),r=d.receipts[b.opId];U.check(r&&r.bodyHash===U.hash({kind:'relocate',...b}),'op-conflict','同じ送信識別の内容が変わっています');return {saved:true,receipt:r,...r.result};}
    const source=U.strictRead(path.join(old.dir,'ideas.json'))||U.strictRead(path.join(real,'.ai/ideas.json'))||files.get('ledger');U.check(source&&U.hash(source)===saved.ledgerHash,'registry-newer','保管後に台帳が更新されています。新しい保管が必要です');const d=JSON.parse(source);require('./ideas').validate(d);U.check(!Object.values(d.runs).some(r=>!r.closed)&&!Object.values(d.releases).some(r=>r.state==='applying'),'registry-busy','実行結果を照合してから移転してください');
    const dest=path.join(ideas.control,'ledgers',b.projectUid),file=path.join(dest,'ideas.json');ideas.lock(path.join(ideas.control,'projects',b.projectUid,'writer.owner'));d.settings.auto.enabled=false;d.settings.manualPaused=true;d.settings.auto.generation++;d.settings.stopGeneration++;d.settings.rev++;d.settings.lane=null;ideas.stale(d,'台帳の移転後は実行先を再設定してください');d.rev++;const receipt={opId:b.opId,bodyHash:U.hash({kind:'relocate',...b}),ledgerRev:d.rev,at:new Date(ideas.clock()).toISOString(),result:{projectUid:b.projectUid,rev:d.rev}};d.receipts[b.opId]=receipt;ideas.writeFile(file,d,b.opId);
    // Preserve original and hand-edited markdown independently of any destination markdown.
    if(files.has('markdown'))ideas.writeFile(path.join(dest,'preserved-markdown.json'),{base64:files.get('markdown').toString('base64')},b.opId);
    for(const [name,bytes] of files)if(name.startsWith('control/')){const target=path.join(ideas.control,'projects',b.projectUid,name.slice(8));if(!fs.existsSync(target)){fs.mkdirSync(path.dirname(target),{recursive:true});require('./safe-file').recoverAtomic(target,bytes);}else U.check(U.hash(fs.readFileSync(target))===U.hash(bytes),'registry-control','現行の制御記録を上書きできません');}
    const entry={projectUid:b.projectUid,name:project,realpath:real,identity:U.identity(real),dir:dest,colocated:true,relocatedByOp:b.opId};for(const [key,e]of Object.entries(registry.projects))if(e.projectUid===b.projectUid)delete registry.projects[key];registry.projects[project]=entry;
    ideas.writeFile(ideas.registryFile,registry,b.opId); // registry switch is the sole authoritative boundary
    return {saved:true,receipt,...receipt.result};
  }finally{ideas.unlock(lock);}
}
module.exports={backup,relocate};
