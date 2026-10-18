'use strict';
const platform = require('./platform');
const { lt } = require('./locale');
const fs = require('node:fs'), path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { noLinks, exists } = require('./remove');
const { scalar } = require('./frontmatter');
const chat = require('./chat');
const SETTINGS = ['AGENTS.md','CLAUDE.md','GEMINI.md','.ai/rules.md','.ai/freetalk.json'];
function nextMonth(value) {
  const d = new Date(value), day = d.getDate();
  d.setDate(1); d.setMonth(d.getMonth()+1);
  const last = new Date(d.getFullYear(),d.getMonth()+1,0).getDate(); d.setDate(Math.min(day,last));
  return d.toISOString();
}
const dayNumber = d => Date.UTC(d.getFullYear(),d.getMonth(),d.getDate()) / 86400000;
class FreetalkLifecycle {
  constructor(history, busy = () => '', now = () => new Date(), template) {
    this.history=history; this.ft=history.ft; this.store=this.ft.store; this.busy=busy; this.now=now; this.template=template; this.operating=false; this.error='';
    this.file=path.join(this.ft.ledger,'.ai/freetalk-maintenance.json');
    this.ft.lifecycle=this;
  }
  state() {
    this.ft.verify(); noLinks(this.file);
    if (exists(this.file)) {
      const s=JSON.parse(fs.readFileSync(this.file,'utf8'));
      if (!Number.isFinite(Date.parse(s.lastClean)) || !Number.isFinite(Date.parse(s.due))) throw Error(lt('掃除の期限を確認できません'));
      return s;
    }
    const activated=fs.statSync(path.join(this.ft.dir,'.ai/freetalk.json')).mtime.toISOString();
    const s={lastClean:activated,due:nextMonth(activated)}; this.save(s); return s;
  }
  save(state) {
    noLinks(this.file); const tmp=this.file+'.'+randomUUID(); fs.writeFileSync(tmp,JSON.stringify(state)+'\n',{flag:'wx'});
    try { fs.renameSync(tmp,this.file); } catch(e) { fs.unlinkSync(tmp); throw e; }
  }
  reason() { return this.operating ? lt('プロジェクト化・掃除の途中です。終了後に操作してください') : this.ft.uploadReason() || this.busy(); }
  status() {
    const s=this.state(), now=this.now(), days=Math.ceil(dayNumber(new Date(s.due))-dayNumber(now));
    const overdue=now.getTime()>=Date.parse(s.due), reason=this.reason();
    return {...s,days,overdue,notice:days<=7,reason,error:this.error,delayed:overdue && Boolean(reason)};
  }
  // 話題の添付と共通相談ファイルだけ。別話題・AI設定・話題メモリは移さない。
  // 検査量は領域ごとに制限。未選択の共通資料で話題添付の検査を使い切らない。
  files(task,{topicOnly=false}={}) {
    this.history.topic(task); const rows=[], limit=256*1024*1024;
    const scan=(root,excluded,scope)=>{
      const budget={count:0,hashed:0};
      const names=dir=>{
        const out=[], handle=fs.opendirSync(dir);
        try {let entry;while((entry=handle.readSync())){if(++budget.count>20000)throw Error(lt('ファイルが多すぎます'));out.push(entry.name);}}
        finally{handle.closeSync();}return out.sort();
      };
      const candidate=file=>{
        const files=[];let bytes=0;
        const walk=p=>{
          noLinks(p);const st=fs.lstatSync(p),rel=path.relative(this.ft.dir,p);
          if(st.isDirectory()){for(const n of names(p))walk(path.join(p,n));return;}
          if(!st.isFile())throw Error(lt('特殊なファイルは移せません'));
          bytes+=st.size;if(bytes>limit)throw Error(lt('移すファイルが大きすぎます'));
          files.push({path:rel,size:st.size,scope});
        };
        try {
          if(budget.count>20000)throw Error(lt('ファイルが多すぎます'));
          walk(file);
          if(budget.hashed+bytes>limit)throw Error(lt('ファイルの検査量が上限に達しました。資料を減らしてもう一度確認してください'));
          budget.hashed+=bytes;
          for(const f of files)f.hash=this.fileHash(path.join(this.ft.dir,f.path),f.size);
          rows.push(...files);
        }catch(e){rows.push({path:path.relative(this.ft.dir,file),scope,reason:e.message});}
      };
      noLinks(root);if(!exists(root))return;
      let entries;try{entries=names(root);}catch(e){rows.push({path:path.relative(this.ft.dir,root)||'.',scope,reason:e.message});return;}
      for(const n of entries)if(!excluded.includes(n))candidate(path.join(root,n));
    };
    if(!topicOnly)scan(this.ft.dir,['.ai','AGENTS.md','CLAUDE.md','GEMINI.md','topics'],'shared');
    scan(path.join(this.ft.dir,'topics',task),['.ai','.derived'],'topic');
    return rows;
  }
  fileHash(file,size) {
    noLinks(file);
    const fd=fs.openSync(file,fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK),hash=createHash('sha256');
    try {
      const before=fs.fstatSync(fd);
      if(!before.isFile() || before.size!==size || size>256*1024*1024)throw Error(lt('移すファイルが更新されました'));
      const buffer=Buffer.alloc(64*1024);let total=0,n;
      while((n=fs.readSync(fd,buffer,0,Math.min(buffer.length,size-total+1),null))){total+=n;if(total>size)throw Error(lt('移すファイルが更新されました'));hash.update(buffer.subarray(0,n));}
      const after=fs.fstatSync(fd);
      if(total!==size || before.mtimeMs!==after.mtimeMs || before.ctimeMs!==after.ctimeMs)throw Error(lt('移すファイルが更新されました'));
      return hash.digest('hex');
    }finally{fs.closeSync(fd);}
  }
  preview(task,{topicOnly=false}={}) {
    this.history.idle(task); const h=this.history.status(task), files=this.files(task,{topicOnly});
    if(!h.draft || h.stale)throw Error(h.staleReason || lt('この話題のAIが作った要約を確認してください'));
    const s=this.history.state(task); let promotion=s.promotion;
    if(!promotion || !promotion.files || promotion.generation!==h.generation || promotion.summaryId!==h.summaryId || promotion.filesHash!==this.filesHash(files)) {
      // この保存もrevisionへ含まれるため、保存後のrevisionを確認画面へ返す。
      promotion={id:randomUUID(),generation:h.generation,summaryId:h.summaryId,filesHash:this.filesHash(files),files};
      this.history.save(task,{...s,promotion});
    }
    return {operationId:promotion.id,revision:this.history.revision(task),summaryId:h.summaryId,generation:h.generation,summary:h.draft,name:this.history.topic(task).t.title,files};
  }
  // An explicit one-click request is durable. Legacy previews never opt in.
  automaticName(task) {
    const title=this.history.topic(task).t.title || ('自由対話 '+task);
    let base=String(title).normalize('NFKC').replace(/[\/\\\0\r\n]/g,' ').replace(/^[._\s]+/,'').trim().slice(0,60) || ('自由対話 '+task);
    if(base.toLowerCase()==='freetalk')base+=' プロジェクト';
    const names=new Set(this.store.listProjects().map(p=>p.name.toLowerCase()));
    for(let n=1;n<10000;n++) {
      const suffix=n===1?'':' ('+n+')',name=base.slice(0,60-suffix.length)+suffix;
      if(!names.has(name.toLowerCase()) && !exists(path.join(this.store.product,name)))return name;
    }
    throw Error(lt('自動でプロジェクト名を決められませんでした'));
  }
  automaticError(task,error,uncertain=false) {
    const state=this.history.state(task);
    if(!state.summary?.automatic || state.summary.intent!=='promote' || state.migrated)return;
    this.history.save(task,{...state,summary:{...state.summary,automatic:{...state.summary.automatic,error:String(error),uncertain}}});
  }
  completeAutomatic(task) {
    const state=this.history.state(task);
    if(state.migrated)return this.cleanupAutomatic(task);
    if(state.summary?.intent!=='promote' || !state.summary.automatic || state.summary.automatic.error)return null;
    const h=this.history.status(task);
    if(h.reason || this.reason())return null; // finish only after the AI has ended
    try {
      if(h.stale || !h.draft)throw Error(h.staleReason || h.summaryError || lt('要約を確認できませんでした'));
      // Never replace an operation whose stage survived an uncertain interruption.
      if(state.promotion && exists(path.join(this.store.product,'.freetalk-'+state.promotion.id))) {
        this.automaticError(task,lt('前回の作成結果を確認できません。作成途中の資料を確認してください'),true);return null;
      }
      const p=this.preview(task,{topicOnly:true}), files=p.files.filter(f=>!f.reason && f.scope==='topic').map(f=>f.path);
      this.promote(task,{...p,name:this.automaticName(task),files,confirm:true,automatic:true});
      return this.cleanupAutomatic(task);
    }catch(e){this.automaticError(task,e.message);return null;}
  }
  // Delete uses the same topic scope as the existing delete button. Shared files stay put.
  topicTargets(task) {
    const targets=[this.store.taskFile('freetalk',task),this.history.file(task)].filter(Boolean);
    for(const dir of ['chat','handoff','memory','work']) {
      const base=path.join(this.ft.ledger,'.ai',dir);noLinks(base);
      if(exists(base))for(const name of fs.readdirSync(base))if(name===task || name.startsWith(task+'.') || name.startsWith(task+'-'))targets.push(path.join(base,name));
    }
    targets.push(path.join(this.ft.dir,'topics',task));
    for(const target of targets)noLinks(target);
    return targets;
  }
  automaticTasks() {
    const tasks=new Set((this.store.readProject('freetalk')?.tasks || []).map(t=>t.id));
    const dir=path.join(this.ft.ledger,'.ai/freetalk');noLinks(dir);
    if(exists(dir))for(const name of fs.readdirSync(dir))if(name.endsWith('.json')) {
      try{const id=name.slice(0,-5),state=this.history.state(id);if(state.migrated?.cleanupPending)tasks.add(id);}
      catch(e){this.error=e.message;}
    }
    return [...tasks];
  }
  cleanupAutomatic(task) {
    let state=this.history.state(task),migrated=state.migrated;
    if(!migrated)return null;
    if(!migrated.cleanupPending)return {...migrated,ok:true,repeated:true};
    if(migrated.cleanupError || this.reason() || this.history.busy(task))return null;
    let cleanup=migrated.cleanup;
    const moved=[];this.operating=true;
    try {
      if(!cleanup) {
        this.history.topic(task);
        const trash=this.trash('topic '+task);
        const planned=this.topicTargets(task).filter(from=>from!==this.history.file(task) && exists(from)).map((from,i)=>({from,to:path.join(trash,String(i))}));
        cleanup={trash,planned};
        fs.writeFileSync(path.join(trash,'manifest.json'),JSON.stringify({task,operationId:migrated.operationId,project:migrated.project,planned})+'\n',{flag:'wx'});
        fs.writeFileSync(path.join(trash,'original-state.json'),JSON.stringify(state)+'\n',{flag:'wx'});
        // Persist the plan before the first rename; resume even if the topic file is gone.
        migrated={...migrated,cleanup};state={...state,migrated};this.history.save(task,state);
      }
      for(const {from,to} of cleanup.planned) {
        noLinks(from);noLinks(to);
        const source=exists(from),dest=exists(to);
        if(source && !dest){fs.renameSync(from,to);moved.push({from,to});}
        else if(!source && dest){/* already moved before an interruption */}
        else throw Error(lt('移行元の削除状態を確認できませんでした'));
      }
      const receipt={operationId:migrated.operationId,project:migrated.project,task:migrated.task,automatic:true,sourceTrash:cleanup.trash};
      // No source conversation, summary, memory or task survives; only a routing receipt.
      this.history.save(task,{generation:state.generation,migrated:receipt});
      return {...receipt,ok:true};
    }catch(e) {
      let rollbackError='';
      for(const {from,to} of moved.reverse())try{fs.renameSync(to,from);}catch(back){rollbackError=back.message;}
      const current=this.history.state(task);
      this.history.save(task,{...current,migrated:{...current.migrated,cleanupError:lt('プロジェクトは作成済みですが、移行元の削除を完了できませんでした：')+e.message+(rollbackError?' / '+rollbackError:'')}});
      return null;
    }finally{this.operating=false;}
  }
  filesHash(files) { return createHash('sha256').update(JSON.stringify(files)).digest('hex'); }
  promote(task,b) {
    const s=this.history.state(task);
    if(s.migrated) {
      if(s.migrated.operationId===b.operationId)return {...s.migrated,ok:true,repeated:true};
      throw Error(lt('この話題は移行済みです'));
    }
    this.history.idle(task); const reason=this.reason();if(reason)throw Error(reason);
    const h=this.history.status(task), all=s.promotion?.files || [];
    if(b.confirm!==true || !s.promotion || b.operationId!==s.promotion.id || b.revision!==h.revision || b.summaryId!==h.summaryId || !h.draft || h.stale || !s.promotion.files || s.promotion.generation!==h.generation)throw Error(lt('会話やファイルが更新されました。もう一度確認してください'));
    if(typeof b.summary!=='string' || !b.summary.trim() || b.summary.length>50000)throw Error(lt('引き継ぐ要約を確認してください'));
    const name=typeof b.name==='string'?b.name.trim():'';
    if(!name || name.length>60 || /[\/\\\0\r\n]/.test(name) || /^[._]/.test(name) || name.toLowerCase()==='freetalk')throw Error(lt('プロジェクト名を確認してください'));
    if(!Array.isArray(b.files) || new Set(b.files).size!==b.files.length || b.files.some(f=>!all.some(a=>a.path===f && !a.reason)))throw Error(lt('移すファイルを選び直してください'));
    if(all.filter(f=>b.files.includes(f.path)).reduce((n,f)=>n+f.size,0)>256*1024*1024)throw Error(lt('選んだファイルの合計が256MBを超えています。選び直してください'));
    // 確認後の競合は選択した資料だけで判定し、未選択の更新に巻き込まれない。
    for(const rel of b.files){const f=all.find(a=>a.path===rel);if(this.fileHash(path.join(this.ft.dir,rel),f.size)!==f.hash)throw Error(lt('移すファイルが更新されました'));}
    const dest=path.join(this.store.product,name); noLinks(dest);
    if(exists(dest) || this.store.listProjects().some(p=>p.name.toLowerCase()===name.toLowerCase()))throw Error(lt('同じ名前のプロジェクトがあります'));
    const stage=path.join(this.store.product,'.freetalk-'+b.operationId);noLinks(stage);
    if(exists(stage))throw Error(lt('前回の作成結果を確認できません。作成途中の資料を確認してください'));
    const trash=this.trash('project');
    const moved=[]; let published=false; this.operating=true;
    try {
      fs.mkdirSync(stage);
      if(this.template)fs.cpSync(this.template,stage,{recursive:true,filter:src=>!['PROJECT.md','.gitkeep'].includes(path.basename(src))});
      for(const dir of ['資料','作業','成果物','.ai/tasks','.ai/memory','.ai/work','.ai/chat'])fs.mkdirSync(path.join(stage,dir),{recursive:true});
      fs.writeFileSync(path.join(stage,'PROJECT.md'),`---\nname: ${scalar(name)}\nstatus: 進行中\nupdated: ${this.now().toISOString().slice(0,10)}\nphases:\n  - { name: 計画, state: 進行中 }\n  - { name: 作る, state: 未着手 }\n  - { name: チェック, state: 未着手 }\nfolders:\n  本体: ${scalar(dest)}\nrelated: []\nchats: []\nissues: []\n---\n# メモ\n${b.automatic?'freetalkのボタン操作で自動作成しました。':'freetalkから確認済み要約で独立しました。'}会話原文と移した資料は「資料」に保存しています。\n`);
      const {t,file}=this.history.topic(task),id=this.now().toISOString().slice(0,10).replace(/-/g,'')+'-01';
      fs.writeFileSync(path.join(stage,'.ai/tasks',id+'.md'),`---\nid: ${id}\ntitle: ${scalar(name)}\nstate: 未着手\nworkspaceMode: direct\nworkdir: ${scalar(dest)}\nowner: ${scalar(t.owner)}\nmodel: ${scalar(t.model)}\neffort: ${scalar(t.effort)}\nquestion:\n---\n## 手順\n- [ ] 引き継いだ内容を確認し、進め方を決める\n`);
      const transcript=chat.files(this.ft.ledger,task).log;
      fs.copyFileSync(transcript,path.join(stage,'資料/自由対話原文.jsonl'));
      const mapping=b.files.map(rel=>({from:path.join(this.ft.dir,rel),to:path.join(dest,'資料/相談ファイル',rel)}));
      fs.writeFileSync(path.join(stage,'資料/ファイル移行.json'),JSON.stringify(mapping,null,2)+'\n');
      chat.append(stage,id,{role:'user',text:(b.automatic?lt('ボタン操作で自動作成した引き継ぎ要約：\n'):lt('人が確認した引き継ぎ要約：\n'))+b.summary.trim()+lt('\n\n会話原文：資料/自由対話原文.jsonl\n移したファイル：資料/ファイル移行.json'),summaryApproved:!b.automatic,automaticPromotion:Boolean(b.automatic)});
      chat.writeMeta(stage,id,{sessions:{},models:{}});
      fs.writeFileSync(path.join(trash,'manifest.json'),JSON.stringify({task,project:name,operationId:b.operationId,stage,dest,planned:mapping})+'\n');
      for(const rel of b.files) { const from=path.join(this.ft.dir,rel),to=path.join(stage,'資料/相談ファイル',rel);noLinks(from);if(this.fileHash(from,all.find(f=>f.path===rel).size)!==all.find(f=>f.path===rel).hash)throw Error(lt('移すファイルが更新されました'));fs.mkdirSync(path.dirname(to),{recursive:true});fs.renameSync(from,to);moved.push({from,to}); }
      fs.renameSync(stage,dest);published=true;
      const migrated={operationId:b.operationId,project:name,task:id,...(b.automatic?{automatic:true,cleanupPending:true}:{})};
      // 最後に元話題を確定。失敗なら新プロジェクトと移動を戻す。
      this.history.save(task,{...s,summary:s.summary?{...s.summary,intent:undefined}:undefined,migrated});
      return {...migrated,ok:true};
    } catch(e) {
      if(published)fs.renameSync(dest,stage);
      for(const {from,to} of moved.reverse())fs.renameSync(to,from);
      if(exists(stage))fs.renameSync(stage,path.join(trash,'failed-project'));
      throw Error(lt('プロジェクト化に失敗し、元の話題とファイルを保持しました：')+e.message);
    } finally { this.operating=false; }
  }
  trash(label) { const dir=path.join(platform.trashDir(this.ft.home),'ProjectHub freetalk '+label+' '+randomUUID());noLinks(dir);fs.mkdirSync(dir,{recursive:true});return dir; }
  clean({confirm,automatic=false}={}) {
    this.ft.verify();const reason=this.reason();if(reason)throw Error(reason);
    const s=this.state();if(automatic && this.now().getTime()<Date.parse(s.due))return {ok:false,notDue:true};
    if(!automatic && confirm!==true)throw Error(lt('掃除する内容を確認してください'));
    const targets=[];
    const collect=(root,allowed)=>{
      const walk=(dir,rel='')=>{noLinks(dir);for(const n of fs.readdirSync(dir)) {
        const key=rel?rel+'/'+n:n,file=path.join(dir,n);
        if(allowed.includes(key)){noLinks(file);if(!fs.lstatSync(file).isFile())throw Error(lt('AI設定・管理情報は通常ファイルで保管してください'));continue;}
        if(allowed.some(a=>a.startsWith(key+'/')))walk(file,key);
        else targets.push(file);
      }};walk(root);
    };
    collect(this.ft.dir,SETTINGS);collect(this.ft.ledger,['PROJECT.md','.ai/freetalk-maintenance.json']);
    const moved=[],trash=this.trash('cleanup'); this.operating=true;
    try {
      fs.writeFileSync(path.join(trash,'manifest.json'),JSON.stringify({lastClean:s.lastClean,planned:targets.map((from,i)=>({from,to:path.join(trash,String(i))}))})+'\n');
      for(const [i,from] of targets.entries()){const to=path.join(trash,String(i));fs.renameSync(from,to);moved.push({from,to});}
      const at=this.now().toISOString();this.save({lastClean:at,due:nextMonth(at),lastOperation:randomUUID()});
      this.error=''; return {ok:true,trash,due:nextMonth(at)};
    }catch(e){for(const {from,to} of moved.reverse())fs.renameSync(to,from);throw Error(lt('掃除に失敗し、元の話題とファイルを保持しました：')+e.message);}
    finally{this.operating=false;}
  }
  // 話題1つを丸ごとゴミ箱へ。移行済みでも可（移行先プロジェクトの写しには触らない）。他の話題・AI設定・共通相談ファイルは残す。
  remove(task,{confirm}={}) {
    this.history.topic(task);if(confirm!==true)throw Error(lt('削除する話題を確認してください'));
    const reason=this.operating?lt('プロジェクト化・掃除の途中です。終了後に操作してください'):this.history.busy(task);if(reason)throw Error(reason);
    const targets=this.topicTargets(task);
    const moved=[],trash=this.trash('topic '+task);this.operating=true;
    try {
      fs.writeFileSync(path.join(trash,'manifest.json'),JSON.stringify({task,planned:targets.map((from,i)=>({from,to:path.join(trash,String(i))}))})+'\n');
      for(const [i,from] of targets.entries())if(exists(from)){const to=path.join(trash,String(i));fs.renameSync(from,to);moved.push({from,to});}
      return {ok:true,trash};
    }catch(e){for(const {from,to} of moved.reverse())fs.renameSync(to,from);throw Error(lt('削除に失敗し、元の話題を保持しました：')+e.message);}
    finally{this.operating=false;}
  }
  tick() { try {if(!this.ft.status().ready){this.ft.verify();this.ft.result={ready:true,reason:''};}if(this.status().overdue && !this.reason())return this.clean({automatic:true});}catch(e){this.error=e.message;return {error:e.message};}return null; }
}
module.exports={FreetalkLifecycle,nextMonth,SETTINGS};
