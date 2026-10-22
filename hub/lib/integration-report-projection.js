'use strict';
// A report projection is a new, single-parent commit. The source branch never
// becomes an ancestor: excluded re-entry notes remain unreceived in the child.
const fs=require('./platform/file-io'),path=require('node:path'),{execFileSync}=require('node:child_process'),{randomUUID,createHash}=require('node:crypto');
const git=require('./git'),{noLinks}=require('./remove');
const fail=message=>{throw Error(message);},hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
function run(dir,args,options={}){return execFileSync('git',['--literal-pathspecs','-C',dir,'-c','gc.auto=0',...args],{encoding:'utf8',maxBuffer:64*1024*1024,stdio:['pipe','pipe','pipe'],...options,env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',...options.env}});}
function entry(dir,ref,file){const rows=run(dir,['ls-tree','-z',ref,'--',file]).split('\0').filter(Boolean);if(!rows.length)return null;const m=rows[0].match(/^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/);if(rows.length!==1||!m||m[4]!==file)fail('報告の保存対象を確認できません');return {path:file,mode:m[1],kind:m[2],oid:m[3]};}
function memory(file,task){return file==='.ai/memory/INDEX.md'||new RegExp('^\\.ai/memory/\\d{4}-\\d{2}-\\d{2}-'+task.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\.md$').test(file);}
function report(file,task){return file.startsWith('成果物/'+task+'/')&&/\.(md|json|txt|py)$/i.test(file)&&!/[\\\x00-\x1f\x7f]/.test(file)&&file.split('/').every(x=>x&&x!=='.'&&x!=='..');}
function plan(target,i,targetHead=git.inspect(target,{readOnly:true})?.head){
 const paths=i.preview?.paths;if(!Array.isArray(paths)||!paths.some(f=>memory(f,i.task)))return null;
 if(!targetHead||!i.source?.head)fail('報告の元と保存先を確認できません');
 const base=run(target,['merge-base',targetHead,i.source.head]).trim();
 const actual=run(target,['diff','--no-renames','--name-only','-z',base,i.source.head,'--']).split('\0').filter(Boolean).sort();
 if(JSON.stringify(actual)!==JSON.stringify([...paths].sort()))fail('報告と引継ぎメモの保存範囲が変わりました');
 const notes=actual.filter(f=>memory(f,i.task)),reports=actual.filter(f=>report(f,i.task));
 if(!reports.length||reports.length+notes.length!==actual.length||notes.length>2||notes.filter(f=>f!=='.ai/memory/INDEX.md').length>1)fail('報告とこの子の引継ぎメモ以外の変更は受け取れません');
 const read=file=>{const e=entry(target,i.source.head,file);if(e?.mode!=='100644'||e.kind!=='blob')fail('報告・引継ぎメモの削除、種類や実行権限の変更は受け取れません');const local=path.join(i.copy,file);noLinks(local);const st=fs.statSync(local);if(!st.isFile()||st.nlink!==1||(st.mode&0o111))fail('報告・引継ぎメモのリンクや実行権限を確認してください');return e;};
 const entries=reports.map(read),excluded=notes.map(read);
 // Only new report paths are enabled. Existing reports needing a merge remain
 // blocked, even when the excluded INDEX alone caused merge-tree conflicts.
 for(const e of entries)if(entry(target,base,e.path)||entry(target,targetHead,e.path))fail('同じ場所にある報告の変更・競合は、この受領経路では扱いません');
 const value={version:1,task:i.task,sourceHead:i.source.head,targetHead,base,entries,excluded};return {...value,sha256:hash(value)};
}
function verify(dir,p,commit){
 const {sha256,...value}=p||{};if(value.version!==1||hash(value)!==sha256||!value.entries?.length||!value.excluded?.length)fail('報告だけを保存した範囲が一致しません');
 const parents=run(dir,['rev-list','--parents','-n','1',commit]).trim().split(' ');if(parents.length!==2||parents[1]!==p.targetHead)fail('報告以外の履歴を受け取ることはできません');
 const actual=run(dir,['diff','--no-renames','--name-only','-z',p.targetHead,commit,'--']).split('\0').filter(Boolean).sort();
 if(JSON.stringify(actual)!==JSON.stringify(p.entries.map(e=>e.path).sort()))fail('報告以外の変更が保存されています');
 for(const e of p.entries)if(!report(e.path,p.task)||e.mode!=='100644'||e.kind!=='blob'||JSON.stringify(entry(dir,p.sourceHead,e.path))!==JSON.stringify(e)||JSON.stringify(entry(dir,commit,e.path))!==JSON.stringify(e))fail('報告の内容・権限が元と一致しません');
 for(const e of p.excluded)if(!memory(e.path,p.task)||e.mode!=='100644'||e.kind!=='blob'||JSON.stringify(entry(dir,p.sourceHead,e.path))!==JSON.stringify(e)||JSON.stringify(entry(dir,p.targetHead,e.path))!==JSON.stringify(entry(dir,commit,e.path)))fail('子に残す引継ぎメモの範囲が変わりました');
 return true;
}
function apply(h,r,i){return git.withCommonGit(r.target,()=>{
 if(i.reportIntent)fail('報告保存の結果が未確認です。再送せず保存記録を確認してください');
 const p=plan(r.target,i);if(JSON.stringify(p)!==JSON.stringify(i.reportProjection))fail('報告の保存先・内容が変わりました');
 require('./integration-safety').assertTarget(h,{target:r.target,p:h.store.readProject(r.project)});
 if(git.mergeLocks(r.target).length)fail('Gitの保存処理が進行中です');
 for(const e of p.entries){const file=path.join(r.target,e.path);noLinks(file);try{fs.lstatSync(file);fail('報告の保存先に未受領のファイルやフォルダがあります');}catch(error){if(error.code!=='ENOENT')throw error;}}
 // Persist intent before creating objects or touching the worktree. Failures
 // retain the journal and temporary index; cold starts never reapply it.
 i.reportIntent={projection:p.sha256,targetHead:p.targetHead};h.save(r);
 const index=path.join(run(r.target,['rev-parse','--absolute-git-dir']).trim(),'hub-report-'+randomUUID()+'.index');noLinks(index);
 const env={GIT_INDEX_FILE:index};
 run(r.target,['read-tree',p.targetHead],{env});run(r.target,['update-index','-z','--index-info'],{env,input:p.entries.map(e=>e.mode+' '+e.oid+'\t'+e.path+'\0').join('')});
 const tree=run(r.target,['write-tree'],{env}).trim();
 const commit=run(r.target,['-c','commit.gpgsign=false','commit-tree',tree,'-p',p.targetHead],{input:'Receive saved reports only: '+i.task+'\n',env:{GIT_AUTHOR_NAME:'Project Hub',GIT_AUTHOR_EMAIL:'hub@localhost',GIT_COMMITTER_NAME:'Project Hub',GIT_COMMITTER_EMAIL:'hub@localhost'}}).trim();
 verify(r.target,p,commit);
 i.reportIntent.commit=commit;h.save(r);
 const current=require('./integration-safety').assertTarget(h,{target:r.target,p:h.store.readProject(r.project)});if(current.head!==p.targetHead||JSON.stringify(git.inspect(i.copy,{readOnly:true}))!==JSON.stringify(i.source))fail('報告の元・保存先が更新されました');
 run(r.target,['-c','core.hooksPath=/dev/null','-c','merge.autoStash=false','merge','--ff-only','--no-edit',commit]);
 const after=git.inspect(r.target,{readOnly:true});if(after?.head!==commit||after.status)fail('報告保存の完了を確認できません');verify(r.target,p,commit);
 for(const e of p.entries){const file=path.join(r.target,e.path);noLinks(file);const st=fs.statSync(file);if(!st.isFile()||st.nlink!==1||(st.mode&0o111)||!fs.readFileSync(file).equals(run(r.target,['cat-file','blob',e.oid],{encoding:null})))fail('保存した報告の内容・種類・権限が一致しません');}
 fs.unlinkSync(index);return {ok:true,commit,files:p.entries.map(e=>e.path),reportProjection:p};
 });}
module.exports={plan,verify,apply,memory,report};
