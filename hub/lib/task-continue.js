'use strict';
const {lt}=require('./locale');
// 本文だけをここで整理し、選別・保管・切替は同じ送信IDのautoJobへ渡す。
function continueTask({history,budget},b){
  const project=b?.project,task=b?.task;
  if(b?.confirm!==true)throw Error(lt('整理する内容を確認してください'));
  if(!/^[a-f0-9-]{36}$/.test(b.requestId||''))throw Error(lt('会話が変わりました。内容を確認し直してください'));
  const previous=history.continueRecord(project,task),old=history.state(project,task);
  if(previous?.requestId===b.requestId){const s=history.continueStatus(project,task,b.requestId);return {...s.result,ok:s.status==='done',duplicate:true,pending:s.status==='pending',rotate:s.result?.rotate||(s.status==='done'?'ok':s.status)};}
  // 同時に押した別タブも、受け付け済みの同じ処理へ接続する。
  if(b.automatic===true&&previous&&b.generation===previous.generation&&(['pending','uncertain'].includes(previous.status)||previous.status==='done'&&b.revision===(previous.initialRevision||previous.revision))){const s=history.continueStatus(project,task,previous.requestId);return {...s.result,requestId:previous.requestId,ok:s.status==='done',duplicate:true,pending:s.status==='pending',rotate:s.result?.rotate||(s.status==='done'?'ok':s.status)};}
  if(previous&&['pending','uncertain'].includes(previous.status))throw Error(lt('会話整理の結果が未確認です。再送せず記録を確認してください'));
  if(history.autoJob(project,task)&&!['done','failed','cancelled'].includes(history.autoJob(project,task).stage))throw Error(lt('会話を整理中です'));
  if(b.generation!==old.generation||b.revision!==history.revision(project,task))throw Error(lt('会話が変わりました。内容を確認し直してください'));
  history.idle(project,task);
  if(history.topic(project,task).t.state==='完了')throw Error(lt('完了した作業は、再開してから要約してください'));
  if(b.body&&b.body.confirm!==true)throw Error(lt('移す量と保管先を確認してください'));
  const request={requestId:b.requestId,generation:old.generation,revision:b.revision,initialRevision:b.revision,body:'skipped',bodyRequest:b.body?.token||'',phase:b.body?'body':'selection',status:'pending'};
  history.saveContinue(project,task,request);
  if(b.body){
    try{const r=budget.apply({project,task,token:b.body.token,confirm:true});request.body=r.noChanges?'skipped':'ok';}
    catch(e){const pending=budget.pending(project).some(x=>x.j.task===task);
      // プレビュー後の共有ロック・版変更は本文だけ省く。書込み中断は復旧を優先する。
      if(b.automatic===true&&!pending){request.body='skipped';request.bodyRequest='';request.bodySkippedReason=e.message;}
      else{const result={ok:false,body:'failed',rotate:'skipped',error:e.message,pending};history.saveContinue(project,task,{...request,status:pending?'uncertain':'failed',result});return result;}
    }
    request.revision=history.revision(project,task);request.phase='selection';history.saveContinue(project,task,request);
  }
  history.checkpoint('body',request);
  const job=history.autoStart(project,task,{requestId:b.requestId,generation:old.generation,trigger:'continue'});
  const result={ok:false,pending:true,body:request.body,rotate:'pending',generation:old.generation,autoId:job.id};
  history.saveContinue(project,task,{...request,phase:'selection',status:'pending',result});
  return result;
}
function recoverContinue({history,budget},b){
  if(b.confirm!==true)throw Error(lt('復旧内容を確認してください'));
  const r=history.continueRecord(b.project,b.task);
  if(!r||r.requestId!==b.requestId)throw Error(lt('会話整理の送信記録を確認してください'));
  if(budget.pending(b.project).some(x=>x.j.task===b.task))throw Error(lt('本文整理の復旧が必要です'));
  if(r.phase==='body'&&r.bodyRequest&&budget.requestStatus(b.project,b.task,r.bodyRequest)==='done'){history.saveContinue(b.project,b.task,{...r,body:'ok',phase:'selection',revision:history.revision(b.project,b.task)});return history.recoverContinue(b.project,b.task,b.requestId);}
  if(r.status==='uncertain'&&r.result?.body==='failed'&&r.result.rotate==='skipped'){
    const result={ok:false,body:'ok',rotate:'failed',error:lt('本文整理は済みました。会話の切り替えは未実行です：')};
    history.saveContinue(b.project,b.task,{...r,body:'ok',phase:'selection',revision:history.revision(b.project,b.task),status:'failed',result});return result;
  }
  return history.recoverContinue(b.project,b.task,b.requestId);
}
module.exports={continueTask,recoverContinue};
