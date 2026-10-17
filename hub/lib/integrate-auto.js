'use strict';
// Durable authorization, single dispatch, and one formal main merge. No CLI here.
const {lt}=require('./locale');
const {createHash,randomUUID}=require('node:crypto');
const {legacyRefusal,completedRefusal}=require('./integration-delivery');
const {childrenComplete,closed}=require('./task-continuation');
const done=i=>['片付け済み','受領済み','保持受領済み'].includes(i.state);
const stamp=()=>new Date().toISOString();
class IntegrateAuto {
  constructor({integrate,busy=()=>false,waitStatus,dispatch,mergeMain,notify=()=>{}}){Object.assign(this,{integrate,busy,waitStatus,dispatch,mergeMain,notify});this.active=false;}
  stop(project,task,reason=lt('人が停止しました')){
    const evidence=reason instanceof Error?{code:reason.code,stage:reason.stage,paths:reason.paths}:{};if(reason instanceof Error)reason=reason.message;
    const r=this.integrate.read(project,task);if(!r?.auto||r.auto.stopped||r.auto.main?.state==='done')return false;
    r.auto.stopped={reason,at:stamp(),...evidence};this.integrate.save(r);this.notify(r);return true;
  }
  settled(o,row){
    let r=this.integrate.read(o.project,o.task);
    const marker=String(o.limitSwitch?.original||o.text||'').match(/\[integration-auto:([a-f0-9]{64}):(code|review|organize|order)\]/);
    if(!marker)return;
    if(marker[2]==='organize')r=this.integrate.pending().map(x=>this.integrate.read(x.project,x.task)).find(r=>r?.auto?.attempts[marker[1]]?.phase==='organize');
    if(!r?.auto||r.abandoned||r.auto.stopped)return;
    try{require('./integration-assignment').completion(r,r.auto.attempts[marker[1]],row);}catch(e){this.stop(r.project,r.task,e);return;}
    if(['organize','order'].includes(marker[2])){try{this.integrate.simple.settled(this,r,marker[1],marker[2],row);}catch(e){this.stop(r.project,r.task,e);}return;}
    const a=r.auto.attempts[marker[1]];if(!a||a.phase!==marker[2])return;
    // Only a formal limit with its own queued/running successor may defer failure.
    if(row.error&&row.integrationAuto?.limit===true&&row.request&&this.pendingRequest?.(r,marker[1],marker[2],row.request))return;
    if(row.error||row.asks?.length){this.stop(r.project,r.task,row.error||lt('統合の判断待ちがあります'));return;}
    const head=require('./integration-safety').target(this.integrate,{target:r.target,p:this.integrate.store.readProject(r.project)});
    if((!head&&!a.fileReview)||head?.status||this.integrate.gitw.merging(r.target)){this.stop(r.project,r.task,lt('解消後の保存を確認できません'));return;}
    if(marker[2]==='code'){
      const i=r.items.find(i=>i.project===a.project&&i.task===a.task);
      if(!i?.source?.head||!this.integrate.gitw.isAncestor(r.target,i.source.head)||!this.integrate.gitw.isAncestor(r.target,a.targetHead)){this.stop(r.project,r.task,lt('同じ衝突が解消されていません。再依頼はしません'));return;}
      a.phase='needs-review';a.reviewHead=head.head;i.state='検証中';
    }else{
      if(a.savedResults){try{this.verifySavedReview(r,a);}catch(e){this.stop(r.project,r.task,e);return;}}
      if(a.fileReview){try{require('./integration-review').verifyFiles(a.fileReview,r.target);this.integrate.simple.validate(r);}catch(e){this.stop(r.project,r.task,e);return;}}
      if((head?.head??null)!==a.reviewHead){
        try{this.refreshReview(r,a,marker[1],head.head);}catch(e){this.stop(r.project,r.task,e);return;}
        this.integrate.save(r);return;
      }
      if(!String(row.text||'').includes(`[integration-review:${marker[1]}:pass]`)||a.isolatedReview&&!this.isolatedCompletion(a,row)){this.stop(r.project,r.task,lt('独立確認の合格を確認できません'));return;}
      a.phase='verified';r.auto.targetHead=a.reviewHead;
    }
    this.integrate.save(r);
  }
  refreshReview(r,a,k,head,manual=false){
    if(!manual&&(a.refreshCount||0)>=1)throw Error(lt('確認中に統合先HEADが再び変わりました。保存後に統合を再開してください'));
    if(![a.targetHead,a.reviewHead,a.sourceHead].every(h=>h&&this.integrate.gitw.isAncestor(r.target,h)))throw Error(lt('確認した履歴が現在の統合先にありません'));
    const next=createHash('sha256').update(a.project+'\0'+a.task+'\0'+a.sourceHead+'\0'+a.targetHead+'\0review\0'+head).digest('hex');
    if(r.auto.attempts[next])throw Error(lt('同じHEADの確認は依頼済みです。再送はしません'));
    a.phase='superseded';a.supersededBy=next;
    r.auto.attempts[next]={project:a.project,task:a.task,sourceHead:a.sourceHead,targetHead:a.targetHead,reviewHead:head,phase:'needs-review',previousAttempt:k,refreshCount:manual?0:(a.refreshCount||0)+1};
  }
  isolatedCompletion(a,row){
    const proof=row.integrationAuto?.isolation;
    return row.integrationAuto?.closed===true&&proof?.version===1&&proof.resumed===false&&Boolean(a.delivery?.request)&&proof.request===a.delivery.request&&(!a.savedResults||Boolean(proof.session))&&(!a.scopeRecovery||proof.session!==a.scopeRecovery.previousSession);
  }
  verifySavedReview(r,a,seen=new Set()){
    if(seen.has(a))throw Error('Original insufficient scope request changed');seen.add(a);
    const i=r.items.find(i=>i.project===a.project&&i.task===a.task);
    require('./integration-review-results').verify(a.savedResults,this.integrate,r,i);
    if(a.evidenceRecovery)require('./integration-review-results').verifyRecovery(a.evidenceRecovery,this.savedCompletion(r,a.previousAttempt,'review'));
    if(a.scopeRecovery){
      const previous=r.auto.attempts[a.previousAttempt];
      if(!previous||previous.phase!=='superseded')throw Error('Original insufficient scope request changed');
      require('./integration-review-results').verifyScopeRecovery(a.scopeRecovery,previous,this.savedCompletion(r,a.previousAttempt,'review'));
      this.verifySavedReview(r,previous,seen);
    }
  }
  recoverReview(r,a,k,head){
    // A legacy review reused the implementation conversation. Keep its terminal
    // result and authorize a different, isolated check once; never resend it.
    if(a.isolatedReview||![a.targetHead,a.reviewHead,a.sourceHead].every(h=>h&&this.integrate.gitw.isAncestor(r.target,h)))throw Error(lt('確認した履歴が現在の統合先にありません'));
    const next=createHash('sha256').update(r.id+'\0'+k+'\0isolated-review-v1\0'+head).digest('hex');
    if(r.auto.attempts[next])throw Error(lt('同じHEADの確認は依頼済みです。再送はしません'));
    a.phase='superseded';a.supersededBy=next;
    r.auto.attempts[next]={project:a.project,task:a.task,sourceHead:a.sourceHead,targetHead:a.targetHead,reviewHead:head,phase:'needs-review',previousAttempt:k,contextRecovery:true,isolatedReview:true};
  }
  waiting(b){
    const out=this.waitStatus?this.waitStatus(b):this.busy(b)?[{kind:'busy',message:lt('AI・整理・確認が動いています')}]:[];
    return [...out,...(this.active||this.integrate.active?[{kind:'integration',message:lt('統合の処理が進行中です')}]:[])];
  }
  startWaiting(b){ return this.waiting(b); }
  preview(b){
    const prior=this.integrate.read(b.project,b.task),fresh=b.simple&&(!prior||closed(prior));
    const waiting=this.startWaiting(fresh?{...b,selected:[]}:b);
    if(waiting.length)for(const [token,x]of this.integrate.tokens)if(x.value.project===b.project&&x.value.task===b.task)this.integrate.tokens.delete(token);
    // Read-only progress remains visible while busy, but supplies no execution token.
    const d={...this.integrate.preview(b.project,b.task,b.only,{allowBusy:waiting.length>0,issueToken:waiting.length===0,...(b.simple?{simple:true}:{}),assignments:b.assignments}),waiting};
    if(fresh)for(const i of d.items){const plan=require('../public/integration-selection').select(d.items,'single',[i]);i.waiting=this.waiting({...b,selected:plan.items.length?plan.items:[i]});}
    if(d.auto?.stopped){
      if(this.abandon)d.abandon=this.abandon.status(b.project,b.task);
      const r=this.integrate.read(b.project,b.task),status=this.resumeStatus(r);
      d.resumeAllowed=status.allowed;d.resumeMessage=status.message;
      if(!status.allowed){d.blockers=[...(d.blockers||[]),status.message];this.integrate.tokens.delete(d.token);delete d.token;}
    }
    return d;
  }
  assertIdle(b,message){
    const waiting=b.mode?this.startWaiting(b):this.waiting(b);
    if(waiting.length){
      this.integrate.tokens.delete(b.token);
      const e=Error(message+'：'+waiting.map(x=>x.message).join(' / '));
      Object.assign(e,{code:'INTEGRATION_BUSY',stage:'waiting',waiting});throw e;
    }
  }
  apply(b){
    this.assertIdle(b,lt('統合の開始は待機中です'));
    return this.integrate.apply(b);
  }
  requestFor(r,k,a){
    if(a.request)return a.request;
    if(a.phase==='organize'&&this.integrate.simple?.organizeRequest){
      const i=r.items.find(i=>i.project===a.project&&i.task===a.task);if(i)return this.integrate.simple.organizeRequest(r,i,k);
    }
    return null;
  }
  resumeStatus(r){
    try{require('./task-continuation').assertNoArchive(this.integrate.dir,r);}catch(e){return {allowed:false,message:e.message,retry:[]};}
    try{require('./integration-assignment').validate(r);}catch(e){return {allowed:false,message:e.message};}
    const retry=[],reviewRecovery=[],questionRecovery=[],evidenceRecovery=[];
    const blocked=message=>({allowed:false,message,retry:[]});
    if(r?.auto?.main?.state==='intent')return blocked(lt('本体取り込みの結果が不明です。再送はしません'));
    if(r?.auto?.mode&&this.integrate.simple?.resumeBaseline){try{this.integrate.simple.resumeBaseline(r);}catch(e){return blocked(e.message);}}
    for(const [k,a]of Object.entries(r?.auto?.attempts||{})){
      if(['verified','superseded','needs-review'].includes(a.phase))continue;
      const row=this.savedCompletion?.(r,k,a.phase);
      if(this.pendingRequest?.(r,k,a.phase))continue;
      if(row){
        if(row.error)return blocked(row.error);
        if(a.savedResults){try{this.verifySavedReview(r,a);}catch(e){return blocked(e.message);}}
        if(a.phase==='organize'&&!row.asks?.length&&this.integrate.simple?.organizedItem){try{this.integrate.simple.organizedItem(r,a,row);}catch(e){return blocked(e.message);}}
        if(a.phase==='order'&&!row.asks?.length&&this.integrate.simple?.orderHead){try{this.integrate.simple.orderHead(r,k,row);}catch(e){return blocked(e.message);}}
        if(row.asks?.length){
          const proof=a.phase==='code'&&this.questionResolution?.(r,k,a,row),current=require('./integration-safety').target(this.integrate,{target:r.target,p:this.integrate.store.readProject(r.project)});
          if(!proof||!current||current.status||this.integrate.gitw.merging(r.target)||![a.targetHead,a.sourceHead,proof.answerHead].every(h=>this.integrate.gitw.isAncestor(r.target,h,proof.savedHead))||!this.integrate.gitw.isAncestor(r.target,proof.savedHead))return blocked(lt('統合の判断待ちがあります'));
          questionRecovery.push({k,proof});continue;
        }
        if(a.phase==='review'&&!String(row.text||'').includes(`[integration-review:${k}:pass]`)){
          try{
            const i=r.items.find(i=>i.project===a.project&&i.task===a.task),head=require('./integration-safety').target(this.integrate,{target:r.target,p:this.integrate.store.readProject(r.project)})?.head;
            const proof=head===a.reviewHead&&require('./integration-review-results').recovery(this.integrate,r,i,a,k,row);
            if(proof){this.integrate.simple.validate(r);evidenceRecovery.push({k,proof});continue;}
          }catch(e){return blocked(e.message);}
          // Only a closed, accepted legacy check can migrate at the same HEAD.
          // An isolated failure requires an actual saved fix, never another try.
          const head=require('./integration-safety').target(this.integrate,{target:r.target,p:this.integrate.store.readProject(r.project)})?.head;
          if(row.integrationAuto?.closed!==true||row.integrationAuto.key!==k||row.integrationAuto.phase!=='review'||a.delivery?.state!=='accepted'||a.isolatedReview&&head===a.reviewHead)return blocked(lt('独立確認の合格を確認できません'));
          if(!a.isolatedReview&&head===a.reviewHead)reviewRecovery.push(k);
        }else if(a.phase==='review'&&a.isolatedReview&&!this.isolatedCompletion(a,row))return blocked(lt('独立確認の合格を確認できません'));
        continue;
      }
      const proof=this.deliveryEvidence?.(r,k,a),legacy=legacyRefusal(r,k,a,proof),completed=completedRefusal(r,k,a,proof);
      if(!legacy&&!completed&&(a.delivery?.state!=='not-sent'||!proof?.complete||proof.sent))return blocked(lt('委任の送信結果が不明です。再開せず、受付・終了記録を確認してください'));
      const request=this.requestFor(r,k,a);if(!request||!this.probeRequest)return blocked(lt('委任の停止原因を解消してから最新の記録を確認してください'));
      try{this.probeRequest(request);}catch(e){return blocked(e.message);}
      retry.push({k,proof,legacy,completed});
    }
    if(retry.length&&this.integrate.simple?.validate){try{this.integrate.simple.validate(r,{notSent:retry.map(x=>x.k)});}catch(e){return blocked(e.message);}}
    return {allowed:true,retry,reviewRecovery,questionRecovery,evidenceRecovery,message:retry.length?lt('委任は開始前に拒否されていました。修正済みの担当で再開できます'):lt('保存された受付・終了記録から続けます')};
  }
  async dispatchAttempt(r,a,k,request){
    if(a.retryReady){
      // Authorization may survive a restart. Recheck immediately before the
      // send; a newly arrived receipt belongs to the original request.
      if(this.savedCompletion?.(r,k,a.phase)||this.pendingRequest?.(r,k,a.phase)){delete a.retryReady;this.integrate.save(r);return {deferred:true};}
      if(r.auto.mode&&(require('./integration-safety').target(this.integrate,{target:r.target,p:this.integrate.store.readProject(r.project)})?.head??null)!==r.auto.targetHead)throw Error(lt('開始後に統合先HEADが変わりました'));
      const status=this.resumeStatus(r);
      if(!status.allowed||!status.retry.some(x=>x.k===k))throw Error(status.message||lt('委任の送信結果が不明です。再開せず、受付・終了記録を確認してください'));
    }
    request=require('./integration-assignment').bind(r,a,k,request);
    const id=randomUUID();
    delete a.retryReady;a.request={...request};a.delivery={state:'intent',request:id,at:stamp()};this.integrate.save(r);
    let result,error;
    try{result=await this.dispatch({...request,requestKey:id});}catch(e){error=e;}
    // A fast completion may have saved refreshed scope or a stop while dispatch
    // awaited startup. Never overwrite that newer record with the old snapshot.
    const fresh=this.integrate.read(r.project,r.task),current=fresh?.auto?.attempts[k];
    if(current?.delivery?.request===id){
      current.delivery={...(error?.delivery||result?.delivery||{state:'unknown'}),request:id,at:stamp(),...(error?{reason:error.message}:{})};
      this.integrate.save(fresh);
    }
    if(error)throw error;
    return result;
  }
  resume(b){
    this.assertIdle(b,lt('統合の再開は待機中です'));
    // Validate and prepare in memory first. A rejected resume never edits the record.
    const status=this.resumeStatus(this.integrate.read(b.project,b.task));
    if(!status.allowed)throw Object.assign(Error(status.message),{code:'INTEGRATION_DELIVERY_BLOCKED'});
    const r=this.integrate.resumeRecord(b),head=require('./integration-safety').target(this.integrate,{target:r.target,p:this.integrate.store.readProject(r.project)}).head;
    for(const {k,proof} of status.evidenceRecovery){
      const a=r.auto.attempts[k],i=r.items.find(i=>i.project===a.project&&i.task===a.task),fresh=require('./integration-review-results').recovery(this.integrate,r,i,a,k,this.savedCompletion(r,k,'review'));
      if(JSON.stringify(fresh)!==JSON.stringify(proof))throw Error('Saved result review evidence changed');
      const next=createHash('sha256').update(r.id+'\0'+k+'\0'+(proof.scopeRecovery?'saved-results-scope-v1':'saved-results-v1')+'\0'+proof.savedResults.sha256).digest('hex');
      if(r.auto.attempts[next])throw Error(lt('同じHEADの確認は依頼済みです。再送はしません'));
      a.phase='superseded';a.supersededBy=next;
      r.auto.attempts[next]={project:a.project,task:a.task,targetHead:a.targetHead,reviewHead:head,phase:'needs-review',previousAttempt:k,...(proof.scopeRecovery?{scopeRecovery:{oldEvidence:proof.oldEvidence,completionHash:proof.completionHash,savedResultsHash:proof.savedResultsHash,deliveryHash:proof.deliveryHash,requestHash:proof.requestHash,previousSession:proof.previousSession}}:{evidenceRecovery:{oldEvidence:proof.oldEvidence,completionHash:proof.completionHash}}),savedResults:proof.savedResults,isolatedReview:true};
    }
    for(const {k,proof} of status.questionRecovery){
      const a=r.auto.attempts[k],i=r.items.find(i=>i.project===a.project&&i.task===a.task);
      a.codeQuestionResolution={...proof,delivery:{...a.delivery},authorizedAt:stamp(),reviewHead:head};
      a.phase='needs-review';a.reviewHead=head;i.state='検証中';
    }
    for(const [k,a]of Object.entries(r.auto.attempts))if(a.phase==='review'){
      if(a.reviewHead!==head)this.refreshReview(r,a,k,head,true);
      else if(status.reviewRecovery.includes(k))this.recoverReview(r,a,k,head);
    }
    for(const x of status.retry){const a=r.auto.attempts[x.k];a.deliveryHistory=[...(a.deliveryHistory||[]),{delivery:a.delivery||null,proof:x.proof,legacy:x.legacy,...(x.completed?{completedRefusal:true}:{}),authorizedAt:stamp(),by:'human'}];a.request=this.requestFor(r,x.k,a);a.retryReady=true;}
    this.integrate.save(r);this.integrate.tokens.delete(b.token);this.notify(r);
    return {ok:true,resumed:true,partial:!r.complete,complete:r.complete,thenMain:false,id:r.id};
  }
  async issue(r,i,a,k,phase){
    if(phase==='review'&&!i.source&&i.results?.some(x=>x.kind==='本体保存済み')){
      if(a.savedResults)this.verifySavedReview(r,a);
      else a.savedResults=require('./integration-review-results').collect(this.integrate,r,i,{scoped:true});
    }
    // Save intent BEFORE delegation. A crash/unknown response never reissues it.
    a.phase=phase;a.at=stamp();if(phase==='review')a.isolatedReview=true;this.integrate.save(r);
    const request={project:r.project,task:r.task,title:phase==='code'?lt`ぶつかりを解消：${i.title}`:lt`統合後の独立確認：${i.title}`,
      ...(phase==='review'?{isolatedReview:true}:{}),
      ...(phase==='review'?{review:{key:k,targetHead:a.targetHead,reviewHead:a.reviewHead,sourceHead:i.source?.head,...(a.fileReview?{fileReview:a.fileReview}:{}),...(a.savedResults?{savedResults:a.savedResults}:{})}}:{}),
      role:phase==='code'?'コーディング':'チェック',text:phase==='code'?`[integration-auto:${k}:code]\n目的：開始済み統合「${i.title}」を保存済み範囲で解消する。\n読む：統合先 ${r.target}、子HEAD ${i.source.head}、衝突パス ${JSON.stringify(i.conflictPaths||[])}。\nやる：同じ統合先で子HEADをmergeし、両側の意図を保って解消、関連試験と日繁の版・履歴を照合しcommitする。\n条件：新コピー・範囲追加・管理記録変更・本体適用・起動・pushなし。判断が必要なら質問して停止。\n出力：保存commitと試験結果をこの会話へ返す。\n次：番を終える。Hubが独立確認と正式受領を続ける。再委任しない。`:
        `[integration-auto:${k}:review]\n目的：統合差分を独立確認する。\n読む：${a.savedResults?'保存済み成果の申告原文・保存commit・成果manifest・関連試験原物（saved-resultsとoriginal）。製品差分0でも確認対象はこの成果一式。review-scopeのプロジェクト・作業・規則原文（SHAと行番号）と実保存履歴も読む':a.fileReview?'Gitのない本体でのファイル成果一式（保存差分原物のmanifestと本文）':r.target+' の '+a.targetHead+'..'+a.reviewHead+'、子 '+(i.source?.head||'ファイル成果のみ')}、直前の試験結果。\nやる：双方の機能と保存済み範囲、関連試験の意味と成功を照合する。確認する言語・版・履歴は当該プロジェクト/作業/規則の原文と実成果から根拠の行番号付きで判断する。日繁要件や成果がある場合は双方を照合し、要求・資料不足や不明を対象外にせず要修正とする。Hub共通の依頼文だけで別プロジェクトへ日繁履歴を追加要求しない。\n条件：読むだけ。修正・委任・本体取込・新版起動なし。要修正なら理由だけ返す。\n出力：確認範囲の原文根拠と判定。合格した時だけ [integration-review:${k}:pass] を返す。\n次：番を終える。Hubが正式受領${r.auto.thenMain?'と保持本体取込':'を続け、本体反映は別に確認'}する。`};
    await this.dispatchAttempt(r,a,k,request);this.notify(this.integrate.read(r.project,r.task));
  }
  async tick(){
    if(this.active||this.integrate.active||this.busy())return;
    this.active=true;
    try{
      for(const entry of this.integrate.pending()){
        let r=this.integrate.read(entry.project,entry.task);if(!r?.auto||r.abandoned||r.auto.stopped||childrenComplete(r)&&r.auto.main?.state==='done')continue;
        try{
          require('./integration-assignment').validate(r);
          if(this.busy(r))continue;
          const context=this.integrate.ancestor(r.project,r.task);
          if(context.t.question||context.t.state==='上限で停止')continue;
          if(context.t.mergeExcluded)throw Error(lt('取り込み対象から外されています'));
          const current=r.auto.mode?require('./integration-safety').target(this.integrate,context):require('./integration-safety').target(this.integrate,{target:r.target,p:this.integrate.store.readProject(r.project)});
          require('./integration-safety').assertTarget(this.integrate,context);
          if(r.auto.mode){if(!await this.integrate.simple.prepare(this,r))continue;}
          for(const scope of r.auto.scope){
            const i=r.items.find(i=>i.project===scope.project&&i.task===scope.task);
            if(!i||JSON.stringify(i.source)!==JSON.stringify(scope.source)||i.taskHash!==scope.taskHash||JSON.stringify(i.files)!==JSON.stringify(scope.files)||JSON.stringify(i.results)!==JSON.stringify(scope.results)||JSON.stringify(i.review)!==JSON.stringify(scope.review)||i.disposition!==scope.disposition)throw Error(lt('開始時の統合範囲が変わりました'));
          }
          if(!r.complete){
            const d=r.auto.mode?{blockers:[],recover:null}:this.integrate.resumePreview(context,r);
            if(d.blockers.length)throw Error(d.blockers.join(' / '));
            if(d.recover)throw Error(lt('開始後に子または統合先が変わりました'));
            const pending=Object.entries(r.auto.attempts).find(([,a])=>!['verified','superseded'].includes(a.phase));
            if(pending){
              const [k,a]=pending,i=r.items.find(i=>i.project===a.project&&i.task===a.task);
              if(a.retryReady){await this.dispatchAttempt(r,a,k,a.request);break;}
              if(a.phase==='needs-review'){await this.issue(r,i,a,k,'review');break;}
              // Saved outstanding request must settle before any receipt.
              // After restart the same conversation/queue owns it. If neither exists,
              // the server's pendingRequest hook identifies ambiguity, never repeats.
              const completion=this.savedCompletion?.(r,k,a.phase);
              if(completion){this.settled({project:r.project,task:r.task,text:`[integration-auto:${k}:${a.phase}]`},completion);continue;}
              if(!this.pendingRequest?.(r,k,a.phase))throw Error(lt('委任の終了記録を確認できません。再送はしません'));
              continue;
            }
            if(current.head!==r.auto.targetHead)throw Error(lt('開始時の統合先HEADがありません'));
            // A saved conflict is delegated once; do not repeat the failed merge.
            if(!r.items.some(i=>i.state==='衝突')){
              for(const a of Object.values(r.auto.attempts))if(a.savedResults&&a.phase==='verified'&&!done(r.items.find(i=>i.project===a.project&&i.task===a.task)))this.verifySavedReview(r,a);
              this.integrate.active=r;
              try{this.integrate.run(r);}finally{this.integrate.active=null;}
            }
            r=this.integrate.read(r.project,r.task);r.auto.targetHead=require('./integration-safety').target(this.integrate,{target:r.target,p:this.integrate.store.readProject(r.project)})?.head??null;this.integrate.save(r);
            const checking=r.auto.mode&&r.items.find(i=>i.state==='検証待ち');
            if(checking){const k=createHash('sha256').update(r.id+'\0'+checking.project+'\0'+checking.task+'\0review\0'+r.auto.targetHead).digest('hex');
              if(r.auto.attempts[k])throw Error(lt('同じHEADの確認は依頼済みです。再送はしません'));
              const a={project:checking.project,task:checking.task,sourceHead:checking.source?.head,targetHead:checking.integrated?.previousTargetHead||r.auto.targetHead,reviewHead:r.auto.targetHead};if(!r.auto.targetHead)a.fileReview=require('./integration-review').filesEvidence({dir:r.target,files:[this.integrate.store.taskFile(r.project,r.task),this.integrate.store.taskFile(checking.project,checking.task),...checking.files.map(f=>f.path),...checking.move.map(f=>f.path)].filter(f=>typeof f==='string')});r.auto.attempts[k]=a;checking.state='検証中';await this.issue(r,checking,a,k,'review');break;}

            const i=r.items.find(i=>i.state==='衝突');
            if(i){
              const targetHead=require('./integration-safety').target(this.integrate,{target:r.target,p:this.integrate.store.readProject(r.project)}).head;
              const prior=Object.entries(r.auto.attempts).find(([,a])=>a.project===i.project&&a.task===i.task&&a.sourceHead===i.source.head&&a.targetHead===targetHead);
              if(prior)throw Error(lt('同じ衝突が解消されていません。再依頼はしません'));
              const k=createHash('sha256').update(i.project+'\0'+i.task+'\0'+i.source.head+'\0'+targetHead).digest('hex');
              const a={project:i.project,task:i.task,sourceHead:i.source.head,targetHead};r.auto.attempts[k]=a;i.state='解消中';
              await this.issue(r,i,a,k,'code');break;
            }
          }
          if(r.complete&&(require('./integration-safety').target(this.integrate,{target:r.target,p:this.integrate.store.readProject(r.project)})?.head??null)!==r.auto.targetHead)throw Error(lt('開始後に統合先HEADが変わりました'));
          if(r.complete&&r.auto.thenMain&&r.auto.main?.state!=='done'){
            if(r.auto.main?.state==='intent')throw Error(lt('本体取り込みの結果が不明です。再送はしません'));
            if(['not-sent','aborted'].includes(r.auto.main?.state))throw Error(r.auto.main.reason||lt('本体取り込みの前提を確認できません'));
            if(this.busy(r))continue;
            if(!r.items.every(done))throw Error(lt('子の正式受領が残っています'));
            // Only the formal operation boundary can mark this as sent. A
            // preflight refusal is durable not-sent; a sent/unknown result is
            // still an intent across restarts and cannot be retried.
            let started=false,out;
            const begin=()=>{if(started)throw Error(lt('本体取り込みの結果が不明です。再送はしません'));r.auto.main={state:'intent',sourceHead:require('./integration-safety').target(this.integrate,{target:r.target,p:this.integrate.store.readProject(r.project)})?.head,at:stamp()};this.integrate.save(r);started=true;};
            try{out=await this.mergeMain(r,{begin});if(!out?.ok||!out.retained)throw Object.assign(Error(out?.error||lt('本体取り込みの結果が不明です。再送はしません')),{delivery:out?.delivery});}
            catch(e){if(!started||['not-sent','aborted'].includes(e.delivery?.state)){r.auto.main={...r.auto.main,state:!started?'not-sent':e.delivery.state,reason:e.message,...(e.delivery?{delivery:e.delivery}:{}),at:stamp()};this.integrate.save(r);}throw e;}
            r.auto.main={...r.auto.main,state:'done',main:out.main};this.integrate.save(r);this.notify(r);
          }else if(r.complete&&!r.auto.thenMain){r.auto.main={state:'done',skipped:true};this.integrate.save(r);this.notify(r);}
        }catch(e){this.stop(r.project,r.task,e);}
      }
    }finally{this.active=false;}
  }
}
module.exports={IntegrateAuto};
