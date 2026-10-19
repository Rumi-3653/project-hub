'use strict';
// Called only inside git.withCommonGit, before legacy auto-save/bookkeeping/cleanup.
const U=require('./idea-utils'),{binding,sameBinding}=require('./idea-location');
function mergeFrozen(o) {
  const {dir,target,sourceHead,targetHead,sourceTree,strictFrozen:f}=o;
  try {
    U.check(f?.schema===1&&f.releaseId&&f.operationId&&sourceHead&&targetHead&&sourceTree&&!o.cleanup,'frozen-input','固定した反映操作だけを受け付けます');
    U.check(sameBinding(f.sourceBinding,binding(dir))&&sameBinding(f.targetBinding,binding(target)),'frozen-binding','承認した場所やGitが変わっています');
    U.check(f.sourceBinding.gitCommonReal===f.targetBinding.gitCommonReal&&f.sourceBinding.realpath!==f.targetBinding.realpath,'frozen-git','同じGitの別の作業場所が必要です');
    let s=U.snapshot(dir),t=U.snapshot(target);U.check(s.head===sourceHead&&s.tree===sourceTree&&t.head===targetHead&&!s.dirty&&!t.dirty&&!s.merging&&!t.merging,'frozen-stale','承認した対象・本体・保存状態が変わっています');
    U.check(U.ancestor(dir,targetHead,sourceHead),'frozen-base','本体の基準を先に包含してください');o.frozenGuard?.();
    const already=U.ancestor(target,sourceHead,targetHead);
    if(!already)U.git(target,['merge','--no-ff','--no-edit','-m','アイデア台帳の固定反映 '+f.releaseId,sourceHead]);
    t=U.snapshot(target);s=U.snapshot(dir);const parents=U.git(target,['show','-s','--format=%P',t.head]).split(' ');
    U.check(s.head===sourceHead&&s.tree===sourceTree&&!s.dirty&&!t.dirty&&!t.merging&&t.tree===sourceTree&&U.ancestor(target,sourceHead,t.head)&&(already||parents.length===2&&parents[0]===targetHead&&parents[1]===sourceHead),'frozen-effect','取り込み後のtreeと履歴の照合が必要です');
    return {ok:true,main:target,commit:t.head,already,strictFrozen:true,tree:t.tree,parents,sourceHead,targetHead,releaseId:f.releaseId,operationId:f.operationId,disposition:'continue'};
  } catch(e) { let notSent=false;try{const t=U.snapshot(target);notSent=t.head===targetHead&&!t.dirty&&!t.merging;}catch{}return {ok:false,error:e.message,delivery:{state:notSent?'not-sent':'unknown'}}; }
}
module.exports={mergeFrozen};
