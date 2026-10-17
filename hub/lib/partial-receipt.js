'use strict';
// 途中受領は保存と通知だけ。子の状態・管理記録・コピーを片付けない。
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {randomUUID,createHash}=require('node:crypto');
const git=require('./git'),chat=require('./chat'),{lt}=require('./locale');
const {exists,noLinks,inside,snapshot}=require('./remove');
const digest=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const expand=s=>s?.startsWith('~/')?path.join(os.homedir(),s.slice(2)):s;
module.exports={
  // Schema 2 keeps every completed receipt, including legacy retained receipts.
  receiptHistory(r) {
    // Reject malformed history; treating it as empty could allow a new receipt or cleanup.
    if(r?.received!==undefined&&!Array.isArray(r.received))throw Error(lt('受領履歴の形式が不正です。原物を保持して記録を確認してください'));
    const rows=[...(r?.received||[])];
    for(const row of rows)if(!row||typeof row!=='object'||Array.isArray(row)||!row.target||typeof row.target!=='object'||Array.isArray(row.target)||typeof row.target.project!=='string'||!row.target.project||typeof row.target.task!=='string'||!row.target.task||row.target.dir!=null&&typeof row.target.dir!=='string')throw Error(lt('受領履歴の形式が不正です。原物を保持して記録を確認してください'));
    if(r?.complete&&r.retained&&!rows.some(x=>x.id===r.id))rows.push({id:r.id,integration:r.integrating,head:r.sourceHead||null,sourceHead:r.sourceHead||null,disposition:r.disposition||'continue',previous:r.previous||rows.at(-1)?.id||null,at:r.at||null,target:{project:r.targetProject,task:r.targetTask,dir:r.integrated?.dir||null},destination:r.destination,files:r.files||[],bundles:(r.bundles||[]).map(({destination,expected})=>({destination,expected})),integrated:r.integrated,review:r.review,results:r.results,taskHash:r.taskHash,manifest:r.manifest});
    return rows;
  },
  lastReceipt(r,targetProject,targetTask) {return this.receiptHistory(r).filter(x=>(!targetProject||x.target.project===targetProject)&&(!targetTask||x.target.task===targetTask)).at(-1);},
  rememberReceipt(r) {
    r.received=this.receiptHistory(r);
    if(!r.received.some(x=>x.id===r.id))r.received.push({schemaVersion:2,id:r.id,integration:r.integrating,head:r.sourceHead||null,sourceHead:r.sourceHead||null,disposition:r.disposition,previous:r.previous||r.received.at(-1)?.id||null,at:new Date().toISOString(),target:{project:r.targetProject,task:r.targetTask,dir:r.integrated?.dir||null},destination:r.destination,files:r.files,bundles:(r.bundles||[]).map(({destination,expected})=>({destination,expected})),integrated:r.integrated,review:r.review,results:r.results,taskHash:r.taskHash,manifest:r.manifest});
  },
  partialSource(p,t,r=this.read(p.id,t.id)) {
    const dir=expand(t.workdir),root=this.removal.workRoot(p);
    if(!dir||path.resolve(dir)===path.resolve(this.baseOf(p)))return null;
    if(!inside(root,path.resolve(dir))||path.resolve(dir)===path.resolve(root))throw Error(lt('子の作業場所の記録が不正です'));
    noLinks(dir);if(!exists(dir))throw Error(lt('子の作業用コピーが見つかりません。記録を確認してください'));
    const source=git.inspect(dir);if(!source||source.status||git.merging(dir))throw Error(lt('途中の成果を渡す前に、子の変更を保存してください'));
    const last=this.lastReceipt(r);
    if(last?.head&&!git.isAncestor(dir,last.head))throw Error(lt('前回受領した保存が子の履歴にありません。履歴を確認してください'));
    return source;
  },
  newReceiptFiles(files,r,targetProject=r?.targetProject) {
    const history=this.receiptHistory(r).filter(x=>x.target.project===targetProject);
    for(const receipt of history){
      for(const saved of receipt.files||[]){noLinks(saved.to);if(!exists(saved.to)||digest(saved.to)!==saved.digest||(fs.statSync(saved.to).mode&0o777)!==saved.mode)throw Error(lt('以前受け取った成果が変わっています。元の成果を保持しています'));}
      for(const bundle of receipt.bundles||[])if(JSON.stringify(this.bundleTree(bundle.destination))!==JSON.stringify(bundle.expected))throw Error(lt('以前受け取った成果が変わっています。元の成果を保持しています'));
    }
    return files.filter(f=>{
      const old=history.flatMap(x=>x.files).find(x=>x.id===f.id&&x.digest===digest(f.path)&&x.mode===(fs.statSync(f.path).mode & 0o777));
      if(!old)return true;
      noLinks(old.to);
      if(!exists(old.to)||digest(old.to)!==old.digest||(fs.statSync(old.to).mode & 0o777)!==old.mode)throw Error(lt('以前受け取った成果が変わっています。元の成果を保持しています'));
      return false;
    });
  },
  assertPartialOffer(p,t,r,files,source) {
    if(!r?.partial||!r.handedUp)throw Error(lt('途中の成果を先に渡してください'));
    if(r.sourceHead!==(source?.head||null)||JSON.stringify(files)!==JSON.stringify(r.files))throw Error(lt('渡し済みの成果が変わっています。成果を渡し直してください'));
  },
  questionHash(t) {return createHash('sha256').update(t.question||'').digest('hex');},
  questionOfferScope(r) {return createHash('sha256').update(JSON.stringify([r.sourceHead,r.taskHash,r.results,r.remaining,r.files])).digest('hex');},
  // Only a formal, unchanged partial offer authorizes leaving a question open.
  // Recheck live data even when the integration uses its frozen snapshot.
  assertQuestionOffer(p,t,r,i,{keep,integration}={}) {
    const fail=()=>{throw Error('子の質問・固定成果が変わりました。新しい成果として渡し直してください');};
    const b=r?.questionBinding;
    if(!t?.question||!i.partial||keep!==true||!r?.partial||!r.handedUp||r.complete||r.id!==i.offerId||
       (r.integrating&&r.integrating!==integration)||b?.version!==1||b.hash!==this.questionHash(t)||
       JSON.stringify(b)!==JSON.stringify(i.questionBinding)||b.scope!==this.questionOfferScope(r))fail();
    const queue=chat.files(p.dir,t.id).queue;noLinks(queue);
    const queued=exists(queue)?JSON.parse(fs.readFileSync(queue,'utf8')):[];
    if(this.removal.busy(p.id,t.id)||this.removal.locked(p.id)||!Array.isArray(queued)||queued.length)throw Error('子のAI・順番待ちの終了を待ってください');
    const source=this.partialSource(p,t,r);
    if((source?.head||null)!==r.sourceHead||t.completionHash!==r.taskHash||i.taskHash!==r.taskHash||
       (i.source?.head||null)!==r.sourceHead||i.needsResults||(!r.resultReady&&!r.files.length)||i.remaining?.status==='不明'||
       JSON.stringify(this.results(p,t))!==JSON.stringify(r.results)||
       JSON.stringify(require('./task-continuation').declaration(this.store.taskFile(p.id,t.id)))!==JSON.stringify(r.remaining)||
       ['files','results','remaining'].some(k=>JSON.stringify(i[k])!==JSON.stringify(r[k])))fail();
    for(const f of r.files)if(snapshot(f.path)!==f.fingerprint||(fs.statSync(f.path).mode&0o777)!==f.mode)fail();
    return true;
  },
  // 予約された旧成果を固定して再開する。新しい子HEADを旧受領に混ぜない。
  partialSnapshot(p,t,r,item,integration,target) {
    if(r?.integrating!==integration || r.id!==item.offerId)throw Error(lt('子の統合予約が変わりました'));
    this.assertPartialOffer(p,t,r,item.files,item.source);
    const live=this.partialSource(p,t,r),copy=expand(t.workdir);
    if((item.copy||null)!==(live?copy:null) || (item.source?.head && !git.isAncestor(copy,item.source.head)))throw Error(lt('確認した子の保存が履歴にありません'));
    const receipt=r.partialReceipt;
    if(receipt && (receipt.integration!==integration || receipt.head!==(item.source?.head||null) || receipt.target.project!==target.project || receipt.target.task!==target.task || JSON.stringify(receipt.files.map(f=>Object.fromEntries(Object.keys(item.files.find(x=>x.id===f.id)||{}).map(k=>[k,f[k]]))))!==JSON.stringify(item.files)))throw Error(lt('子の受領記録が変わりました'));
    // コピー済みの成果が残っていれば原本の次の編集を許す。未保存の原本は旧指紋必須。
    for(const f of item.files){
      const saved=receipt?.files.find(x=>x.id===f.id);if(saved)noLinks(saved.to);
      if(saved && exists(saved.to)){
        if(digest(saved.to)!==saved.digest || (fs.statSync(saved.to).mode & 0o777)!==saved.mode)throw Error(lt('受け取った成果が変更されています。上書きしません'));
      }else if(snapshot(f.path)!==f.fingerprint || (fs.statSync(f.path).mode & 0o777)!==f.mode)throw Error(lt('成果ファイルが変わりました。元の記録は残しています'));
    }
    return live;
  },
  receivePartial({project,task,targetProject,targetTask,integrating,files,integrated,sourceHead,frozen,preserveQuestionConversation=false}) {
    if(this.integrationTargetGuard)this.integrationTargetGuard({integrating,targetProject,targetTask});
    let r=this.read(project,task);
    if(r?.received?.some(x=>x.integration===integrating))return {ok:true,duplicate:true,record:r.received.find(x=>x.integration===integrating).id};
    if(r?.integrating!==integrating)throw Error(lt('子の統合予約が変わりました'));
    const c=this.context(project,task,{targetProject,targetTask,integrating,partial:true});
    if(c.d.blockers.length)throw Error(c.d.blockers.join(' / '));
    if(frozen){
      const live=this.partialSnapshot(c.p,c.t,r,frozen,integrating,{project:targetProject,task:targetTask});
      if(JSON.stringify(live)!==JSON.stringify(frozen.approvedSource||frozen.source))throw Error(lt('確認中に子の保存が変わりました'));
      const targetDir=expand(c.target.task.workdir)||this.baseOf(c.target.project);
      if(sourceHead && path.resolve(integrated?.dir||'.')!==path.resolve(targetDir))throw Error(lt('統合先が変わりました'));
      if(sourceHead!==(frozen.source?.head||null) || (sourceHead && (!integrated?.dir || !git.isAncestor(integrated.dir,sourceHead))))throw Error(lt('済んだ子の取り込みが現在の統合先にありません：')+c.t.title);
    }else{
      if((this.partialSource(c.p,c.t,r)?.head||null)!==sourceHead)throw Error(lt('確認中に子の保存が変わりました'));
      for(const f of files)if(snapshot(f.path)!==f.fingerprint||(fs.statSync(f.path).mode & 0o777)!==f.mode)throw Error(lt('成果ファイルが変わりました。元の記録は残しています'));
    }
    let receipt=r.partialReceipt;
    if(!receipt){
      const id=randomUUID(),destination=path.join(c.target.project.dir,'成果物','受取',id);noLinks(destination);
      receipt={schemaVersion:2,disposition:'partial',previous:this.lastReceipt(r)?.id||null,sourceHead,id,integration:integrating,head:sourceHead,at:new Date().toISOString(),target:{project:targetProject,task:targetTask,dir:integrated?.dir||null},destination,files:this.receiptFiles(files,c.target.project,destination),integrated,results:frozen?.results||this.results(c.p,c.t),taskHash:c.t.completionHash};
      receipt.bundles=this.bundleScopes(receipt.files).map(({destination,expected})=>({destination,expected}));
      r.partialReceipt=receipt;this.save(r);
    }
    for(const f of receipt.files){
      noLinks(f.to);
      if(exists(f.to)){if(digest(f.to)!==f.digest||(fs.statSync(f.to).mode & 0o777)!==f.mode)throw Error(lt('受け取った成果が変更されています。上書きしません'));continue;}
      if(f.existing)throw Error(lt('保存済みの同内容成果が失われました。元の記録は保持しています'));
      fs.mkdirSync(path.dirname(f.to),{recursive:true});const tmp=f.to+'.partial-tmp';noLinks(tmp);fs.copyFileSync(f.path,tmp);fs.chmodSync(tmp,f.mode);
      if(digest(tmp)!==f.digest)throw Error(lt('成果を正しく保存できませんでした'));require('./integration-writes').write(f.to,()=>fs.renameSync(tmp,f.to));
    }
    const text=lt`途中受領：「${c.t.title}」の保存 ${sourceHead?.slice(0,7)||'—'} を受け取りました（${receipt.at}）。子作業・会話・コピーと残手順はそのまま続けられます。`;
    for(const [p,t] of (preserveQuestionConversation&&frozen?.questionBinding?[[c.target.project,c.target.task]]:[[c.target.project,c.target.task],[c.p,c.t]]))if(!chat.read(p.dir,t.id).some(x=>x.partialReceipt===receipt.id))chat.append(p.dir,t.id,{role:'user',text,from:'subtask',partialReceipt:receipt.id,child:task,childProject:project,childTitle:c.t.title});
    const parentFile=this.store.taskFile(targetProject,targetTask);noLinks(parentFile);
    if(!fs.readFileSync(parentFile,'utf8').includes(receipt.id))this.store.appendSection(targetProject,targetTask,'やったこと',text+' '+lt`受領記録：${receipt.id}`);
    // 通知の失敗も同じreceiptで再開する。保存が済むまで予約を解除しない。
    this.notify(targetProject,targetTask,receipt.id);this.notify(project,task,receipt.id);
    for(const f of receipt.files){noLinks(f.to);if(digest(f.to)!==f.digest||(fs.statSync(f.to).mode & 0o777)!==f.mode)throw Error(lt('受け取った成果が変更されています。元の記録を保持します'));}
    r.schemaVersion=2;r.disposition='partial';r.previous=receipt.previous;r.sourceHead=sourceHead;r.received=[...this.receiptHistory(r),receipt];r.handedUp=false;delete r.partialReceipt;delete r.integrating;this.save(r);
    return {ok:true,record:receipt.id};
  },
  receiptStatus(r,{inspect=true}={}) {
    const last=this.lastReceipt(r);if(!last)return null;
    const file=this.store.taskFile(r.project,r.task),t=file&&this.store.readTask(file);
    let pendingCommits=null;
    if(inspect&&t?.workdir)try{pendingCommits=git.commitsSince(expand(t.workdir),last.head);}catch{/* 不明を0と扱わない */}
    return {head:last.head,at:last.at,target:last.target,pendingCommits};
  }
};
