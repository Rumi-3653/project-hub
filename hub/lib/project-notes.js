'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash,randomUUID}=require('node:crypto');
const {lt,sectionNames}=require('./locale'),{noLinks,exists}=require('./remove');
const hash=s=>createHash('sha256').update(s).digest('hex');
// PROJECT.md notes are newest first. Never infer their order from dates.
const order='newest-first',archiveLink=/^\[[^\]\r\n]+\]\((\.ai\/memory\/project-notes-archive-\d{6}\.md)\)\r?\n?$/;
function notesMetadata(notes){return {notesSummary:Array.from(notes.split(/\r?\n/).slice(0,3).join('\n')).slice(0,240).join(''),notesBytes:Buffer.byteLength(notes),notesHash:hash(notes)};}
class ProjectNotes {
  constructor({store,busy=()=>false}){this.store=store;this.busy=busy;this.tokens=new Map();}
  paths(project){
    const p=this.store.readProject(project);if(!p)throw Error(lt('プロジェクトが見つかりません'));
    const file=path.join(p.dir,'PROJECT.md'),memory=path.join(p.dir,'.ai/memory');noLinks(file);noLinks(memory);
    return {file,memory,journal:path.join(memory,'.project-notes-archive.json')};
  }
  read(project){this.paths(project);const p=this.store.readProject(project);return {project,notes:p.notes,hash:p.notesHash,bytes:p.notesBytes};}
  preview(project,keepLines=200){
    if(!Number.isInteger(keepLines)||keepLines<1||keepLines>10000)throw Error(lt('残すメモの行数を確認してください'));
    const {file,memory,journal}=this.paths(project);noLinks(journal);
    if(exists(journal)&&JSON.parse(fs.readFileSync(journal,'utf8')).state==='intent')throw Error(lt('メモ保管の結果が不明です。原文と保管先を確認してください'));
    const raw=fs.readFileSync(file,'utf8'),heading=[...raw.matchAll(/^# ([^\r\n]+)\r?\n/gm)].find(m=>sectionNames('メモ').includes(m[1]));
    if(!heading)return {project,noChanges:true,order};
    const start=heading.index+heading[0].length,endMatch=raw.slice(start).match(/^#\s/m),end=endMatch?start+endMatch.index:raw.length,body=raw.slice(start,end),lines=body.match(/[^\n]*\n|[^\n]+$/g)||[];
    const links=lines.map(line=>archiveLink.exec(line));
    if(links.filter(link=>!link).length<=keepLines)return {project,noChanges:true,order};
    // Existing archive pointers stay in the source and do not consume recent-note lines.
    const movedLines=[],keptLines=[];let contentLines=0;
    lines.forEach((line,i)=>{(links[i]||++contentLines<=keepLines?keptLines:movedLines).push(line);});
    const moved=movedLines.join(''),kept=keptLines.join('');
    const relative='.ai/memory/project-notes-archive-'+new Date().toISOString().slice(0,7).replace('-','')+'.md',archive=path.join(path.dirname(file),relative);noLinks(archive);
    const before=exists(archive)?fs.readFileSync(archive,'utf8'):'';
    const eol=heading[0].endsWith('\r\n')?'\r\n':'\n',link=links.some(m=>m&&m[1]===relative)?'':`[${lt('古いメモの保管先')}](${relative})${eol}`;
    const next=raw.slice(0,start)+link+kept+raw.slice(end),archived=before+`\n<!-- PROJECT.md ${hash(raw)} -->\n`+moved;
    const token=randomUUID();for(const [k,v]of this.tokens)if(Date.now()-v.at>600000)this.tokens.delete(k);
    this.tokens.set(token,{at:Date.now(),project,file,memory,journal,archive,relative,sourceHash:hash(raw),archiveHash:hash(before),next,archived,order,keepLines});
    return {project,token,sourceHash:hash(raw),archive:relative,movedBytes:Buffer.byteLength(moved),remainingBytes:Buffer.byteLength(next),keepLines,order};
  }
  apply({project,token,confirm}){
    const v=this.tokens.get(token);if(!v||v.project!==project||Date.now()-v.at>600000||confirm!==true)throw Error(lt('メモの保管内容を確認してください'));
    if(this.busy(project))throw Error(lt('AI・整理・確認が動いています。この返事が終わってから取り込んでください'));
    const {file,journal}=this.paths(project);noLinks(v.archive);noLinks(journal);
    if(exists(journal)&&JSON.parse(fs.readFileSync(journal,'utf8')).state==='intent')throw Error(lt('メモ保管の結果が不明です。原文と保管先を確認してください'));
    if(file!==v.file||hash(fs.readFileSync(file))!==v.sourceHash||hash(exists(v.archive)?fs.readFileSync(v.archive):'')!==v.archiveHash)throw Error(lt('確認中にメモまたは保管先が変わりました'));
    // Intent first; archive first. An interrupted write preserves the source and refuses replay.
    fs.mkdirSync(v.memory,{recursive:true});this.tokens.delete(token);
    const state={state:'intent',at:new Date().toISOString(),sourceHash:v.sourceHash,archive:v.relative,archiveHash:hash(v.archived),nextHash:hash(v.next),order:v.order,keepLines:v.keepLines};
    const write=require('./safe-file').atomic;
    write(journal,JSON.stringify(state));write(v.archive,v.archived,exists(v.archive)?fs.statSync(v.archive).mode&0o777:0o600);write(file,v.next,fs.statSync(file).mode&0o777);
    write(journal,JSON.stringify({...state,state:'done'}));
    return {ok:true,project,archive:v.relative,sourceHash:v.sourceHash,hash:hash(v.next),order:v.order,keepLines:v.keepLines};
  }
}
module.exports={ProjectNotes,notesMetadata};
