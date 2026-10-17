'use strict';
const fs=require('node:fs'),path=require('node:path'),U=require('./idea-utils'),safe=require('./safe-file');
class IdeaReview {
  constructor({ideas,lane,verification}) {Object.assign(this,{ideas,lane,verification});}
  prepare(project,{baseHead,releaseId,final=false}={}) {
    const d=this.ideas.read(project),lane=this.lane.resolve(project),snap=U.snapshot(lane.workdirReal),base=baseHead||U.snapshot(lane.baseReal).head;
    U.check(!snap.dirty&&!snap.merging&&U.ancestor(lane.workdirReal,base,snap.head),'review-source','確認対象を保存し、本体との整合を先に行ってください');
    const descriptor=this.verification.descriptor(project,snap.head),e=Object.values(d.evidence).filter(e=>e.type==='verification'&&e.success&&e.key===U.hash(descriptor));
    U.check(e.length,'review-tests','固定した対象の検証が必要です');
    const id=U.uuid(),dir=path.join(this.ideas.resolve(project).controlDir,'reviews',id);fs.mkdirSync(dir,{recursive:true});
    const diff=U.gitRaw(lane.workdirReal,['diff','--binary','--no-ext-diff','--no-textconv',base,snap.head]),history=U.gitRaw(lane.workdirReal,['log','--format=fuller','--no-abbrev',base+'..'+snap.head]);
    const files=U.git(lane.workdirReal,['diff','--name-only','-z',base,snap.head]).split('\0').filter(Boolean),items=Object.values(d.items).filter(i=>i.intent==='build'&&i.status!=='withdrawn').map(i=>({id:i.id,contentRev:i.contentRev,planRev:i.planRev,grant:i.grant,text:i.text,...(i.images?.length?{images:i.images,imageReferences:this.ideas.imageReferences(project,i)}:{}),source:i.source,acceptance:i.acceptance,implementation:i.implementation}));
    U.check(items.every(i=>!i.implementation||i.implementation.laneBindingRev===lane.bindingRev),'review-lane','以前の実行先の実装は、新しい場所の確認に使えません');
    U.check(U.snapshot(lane.workdirReal).head===snap.head&&!U.snapshot(lane.workdirReal).dirty,'review-race','確認資料を作る間に対象が変わりました');
    const bundle={schema:1,id,projectUid:d.projectUid,releaseId:releaseId||null,final,baseHead:base,reviewHead:snap.head,treeHash:snap.tree,lane,files,items,testEvidence:e,diffHash:U.hash(diff),historyHash:U.hash(history)};
    const bundleHash=U.hash(bundle);for(const [name,data]of Object.entries({'diff.patch':diff,'history.txt':history,'bundle.json':U.bytes(bundle)})){const fd=fs.openSync(path.join(dir,name),'wx',0o400);try{fs.writeFileSync(fd,data);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}safe.syncDirectory(path.join(dir,name));}
    const review={id,itemContentRevs:items.map(i=>({itemId:i.id,contentRev:i.contentRev,planRev:i.planRev,grantHash:U.hash(i.grant)})),baseHead:base,reviewHead:snap.head,treeHash:snap.tree,bundleHash,testProfileHash:e[0].profileHash,testEvidenceRefs:e.map(x=>x.id),bundleFile:path.join(dir,'bundle.json'),diffFile:path.join(dir,'diff.patch'),historyFile:path.join(dir,'history.txt'),releaseId:releaseId||null,final,outcome:'unknown',findings:[],reviewerRun:null};
    this.ideas.internal(project,U.uuid(),{kind:'review-prepare',id},x=>{x.reviews[id]=review;});return review;
  }
  verify(project,review) {
    U.check(review&&review.bundleFile&&review.diffFile&&review.historyFile,'review-bundle','固定した確認資料がありません');const bundle=JSON.parse(fs.readFileSync(review.bundleFile,'utf8'));U.check(bundle.schema===1&&Array.isArray(bundle.items)&&bundle.items.length&&Array.isArray(bundle.testEvidence)&&bundle.testEvidence.length,'review-bundle','確認資料が空です');U.check(U.hash(bundle)===review.bundleHash&&U.hash(fs.readFileSync(review.diffFile))===bundle.diffHash&&U.hash(fs.readFileSync(review.historyFile))===bundle.historyHash,'review-bundle','固定した確認資料が変更されています');
    const lane=this.lane.resolve(project),s=U.snapshot(lane.workdirReal);U.check(U.hash(lane)===U.hash(bundle.lane)&&s.head===review.reviewHead&&s.tree===review.treeHash&&!s.dirty&&!s.merging,'review-stale','確認対象が変更されました');
    const descriptor=this.verification.descriptor(project,s.head);U.check(descriptor.profileHash===review.testProfileHash&&review.testEvidenceRefs.every(id=>{const e=this.ideas.read(project).evidence[id];return e?.success&&e.key===U.hash(descriptor);}),'review-tests','固定対象の検証設定または環境が変更されました');
    const d=this.ideas.read(project);U.check(U.hash(Object.values(d.items).filter(i=>i.intent==='build'&&i.status!=='withdrawn').map(i=>i.id).sort())===U.hash(review.itemContentRevs.map(t=>t.itemId).sort()),'review-stale','確認後に作る対象が変更されました');for(const t of review.itemContentRevs){const i=d.items[t.itemId];if(i)this.ideas.imageReferences(project,i);U.check(i&&i.contentRev===t.contentRev&&i.planRev===t.planRev&&i.status!=='withdrawn'&&U.hash(i.grant)===t.grantHash,'review-stale','確認対象の依頼が変更されました');}return review;
  }
  accept(project,run,result,row) {
    const review=this.ideas.read(project).reviews[run.reviewId];U.check(review&&row.automation?.isolation?.readOnly&&row.automation?.isolation?.fresh&&!row.automation?.isolation?.resumed,'review-isolation','専用の読み取り確認を証明できません');
    this.verify(project,review);
    U.check(result.reviewId===review.id&&result.bundleHash===review.bundleHash&&result.reviewHead===review.reviewHead&&['pass','changes','insufficient','unknown'].includes(result.outcome)&&Array.isArray(result.findings),'review-result','確認の対象または結果形式が一致しません');
    const outcome=result.outcome==='pass'&&result.findings.length?'changes':result.outcome;
    this.ideas.internal(project,U.uuid(),{kind:'review-result',run:run.id,hash:U.hash(result)},d=>{const r=d.reviews[review.id];r.reviewerRun=run.id;r.outcome=outcome;r.findings=result.findings;r.resultHash=U.hash(result);r.checkedAt=new Date(this.ideas.clock()).toISOString();if(outcome==='changes')for(const t of r.itemContentRevs){const i=d.items[t.itemId];if(i?.implementation){i.status='blocked';i.failure={runId:run.id,cause:JSON.stringify(result.findings),repairs:0,same:1,blocked:false};i.rev++;}}if(outcome==='pass')for(const t of r.itemContentRevs){const i=d.items[t.itemId];if(i?.implementation&&U.ancestor(this.lane.resolve(project).workdirReal,i.implementation.head,r.reviewHead))i.evidence.push({type:'review',id:r.id,head:r.reviewHead,contentRev:t.contentRev});}});return outcome;
  }
}
module.exports={IdeaReview};
