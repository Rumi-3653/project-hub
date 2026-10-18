'use strict';
const platform = require('./platform');
const fs = require('node:fs'), path = require('node:path'), { spawn } = require('node:child_process');
const U = require('./idea-utils'), safe = require('./safe-file');
const birth=pid=>platform.processBirth(pid);
const alive=(pid,stamp)=>{try{process.kill(pid,0);return !stamp||birth(pid)===stamp;}catch(e){return e.code!=='ESRCH';}};
class IdeaVerification {
  constructor({ ideas, lane, gate, profiles, spawnProcess = spawn, environment = () => ({ node:process.version,platform:process.platform,arch:process.arch }) }) {
    Object.assign(this,{ideas,lane,gate,spawnProcess,environment}); this.active = new Map();
    // Profiles are installed by Hub code/configuration, never supplied by an AI result or an HTTP command.
    this.profiles = new Map((profiles || [{ id:'project-hub', executable:process.execPath, argv:['--test','--test-force-exit','test/idea-storage.test.js','test/idea-erasure.test.js','test/idea-delete-availability.test.js','test/idea-redesign.test.js','test/idea-api.test.js','test/idea-runner.test.js','test/idea-delivery.test.js','test/idea-review-release.test.js','test/idea-lifecycle.test.js','test/version-check.test.js','test/chat-history.test.js','test/queue-edit.test.js','test/integration-safety.test.js'], cwd:'hub', env:{HUB_LANG:'ja',TMPDIR:fs.realpathSync(require('node:os').tmpdir())}, timeout:180000, outputDirs:[], scope:['hub','langpacks','scripts'], lockfiles:['hub/package-lock.json'] }]).map(p=>[p.id,Object.freeze(U.clone(p))]));
  }
  get(id) {
    const p = this.profiles.get(id); U.check(p && path.isAbsolute(p.executable) && fs.existsSync(p.executable) && Array.isArray(p.argv) && p.argv.every(a=>typeof a==='string') && typeof p.cwd==='string' && !path.isAbsolute(p.cwd) && !p.cwd.split('/').includes('..') && p.timeout>0 && p.timeout<=1800000 && Array.isArray(p.scope) && p.scope.length && Array.isArray(p.outputDirs),'test-profile','登録済みの検証方法を設定してください'); return p;
  }
  list() { return [...this.profiles.values()].map(p=>({id:p.id,label:p.label||p.id})); }
  descriptor(project, head) {
    const d=this.ideas.read(project), lane=this.lane.resolve(project), p=this.get(d.settings.testProfile), dir=lane.workdirReal;
    const s=U.snapshot(dir); U.check(s.head===head && !s.dirty && !s.merging,'verify-dirty','検証前に開発場所の変更を保存してください');
    const locks=Object.fromEntries((p.lockfiles||[]).map(f=>{ U.check(!path.isAbsolute(f)&&!f.split('/').includes('..'),'test-profile','検証設定のパスが不正です'); const bytes=U.strictRead(path.join(dir,f)); return [f,bytes===null?null:U.hash(bytes)]; }));
    return { head,tree:s.tree,profile:p.id,profileHash:U.hash(p),scopeHash:U.hash(p.scope),lockHash:U.hash(locks),environment:{...this.environment(),allowEnvHash:U.hash({PATH:process.env.PATH,HOME:process.env.HOME,LANG:process.env.LANG})},bindingRev:lane.bindingRev };
  }
  async run(project,{head,authorize,baseline=false,releaseId}={}) {
    const lane=this.lane.resolve(project), d=this.ideas.read(project), p=this.get(d.settings.testProfile), descriptor=this.descriptor(project,head), key=U.hash(descriptor);
    const prior=Object.values(d.evidence).find(e=>e.type==='verification'&&e.key===key&&e.finished);
    if(prior)return prior;
    if(this.active.has(project))return this.active.get(project);
    const work=this.execute(project,{lane,p,descriptor,key,authorize,baseline,releaseId}).finally(()=>this.active.delete(project)); this.active.set(project,work); return work;
  }
  async execute(project,{lane,p,descriptor,key,authorize,baseline,releaseId}) {
    authorize?.(); const owner='idea-verify:'+U.uuid(), lease=this.gate.acquire({dir:lane.workdirReal,owner,kind:'verification'}), id=U.uuid(), where=this.ideas.resolve(project).controlDir, logDir=path.join(where,'verification',id);
    const itemIds=Object.keys(this.ideas.read(project).items);
    fs.mkdirSync(logDir,{recursive:true}); const outFile=path.join(logDir,'stdout'),errFile=path.join(logDir,'stderr'); const out=fs.openSync(outFile,'wx',0o600),err=fs.openSync(errFile,'wx',0o600);
    let child,timedOut=false,spawnError='',exitCode=null,signal=null,live=false;
    try {
      authorize?.(); const cwd=fs.realpathSync(path.join(lane.workdirReal,p.cwd)); U.check(U.inside(lane.workdirReal,cwd),'test-profile','検証場所が実行先の外です');
      this.ideas.internal(project,U.uuid(),{kind:'verify-start',id},d=>{d.evidence[id]={id,type:'verification',key,...descriptor,itemIds,baseline:Boolean(baseline),releaseId:releaseId||null,finished:false,owner:{pid:process.pid,birth:birth(process.pid)},child:null,stdout:{file:outFile},stderr:{file:errFile}};});
      child=this.spawnProcess(p.executable,p.argv,{cwd,env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:process.env.LANG,...p.env},shell:false,detached:process.platform!=='win32',stdio:['ignore',out,err]}); live=true;if(child.pid)this.ideas.internal(project,U.uuid(),{kind:'verify-child',id},d=>{d.evidence[id].child={pid:child.pid,birth:birth(child.pid)};});
      const kill=sig=>{try{platform.killTree(child,sig,{fallback:false});}catch(e){if(e.code!=='ESRCH')throw e;}};
      await new Promise(resolve=>{const timer=setTimeout(()=>{timedOut=true;kill('SIGTERM');force=setTimeout(()=>kill('SIGKILL'),500);force.unref?.();},p.timeout); let force;
        child.once('error',e=>{spawnError=e.message;live=false;clearTimeout(timer);clearTimeout(force);resolve();});
        child.once('close',(code,sig)=>{exitCode=code;signal=sig;live=false;clearTimeout(timer);clearTimeout(force);resolve();});});
      // The whole process group must be gone before another writer gets this lease.
      if(child.pid&&process.platform!=='win32') { let group=false;try{platform.killTree(child,0,{fallback:false});group=true;live=true;}catch(e){if(e.code!=='ESRCH')throw e;} if(group){kill('SIGKILL');for(let n=0;n<50;n++){try{platform.killTree(child,0,{fallback:false});await new Promise(r=>setTimeout(r,20));}catch(e){if(e.code==='ESRCH'){group=false;live=false;break;}throw e;}}U.check(!group,'verification-owner','検証の子プロセス終了を確認できません',503);} }
      fs.fsyncSync(out);fs.fsyncSync(err); const after=U.snapshot(lane.workdirReal),same=after.head===descriptor.head&&after.tree===descriptor.tree&&!after.dirty&&!after.merging;
      const evidence={id,type:'verification',key,...descriptor,itemIds,baseline:Boolean(baseline),releaseId:releaseId||null,finished:true,success:!spawnError&&!timedOut&&exitCode===0&&same,exitCode,signal,timedOut,spawnError,unchanged:same,stdout:{file:outFile,hash:U.hash(fs.readFileSync(outFile))},stderr:{file:errFile,hash:U.hash(fs.readFileSync(errFile))},at:new Date(this.ideas.clock()).toISOString()};
      this.ideas.internal(project,U.uuid(),{kind:'verification',id},x=>{x.evidence[id]=evidence;if(!same)x.observed={state:'blocked',reason:'検証中に開発場所が変わりました'};}); return evidence;
    } finally {fs.closeSync(out);fs.closeSync(err);if(!live)this.gate.release(owner,lease.id);else this.gate.block(owner,lane.workdirReal,'検証プロセスの終了を照合してください');}
  }
  restore(project) {
    const d=this.ideas.read(project);for(const e of Object.values(d.evidence).filter(e=>e.type==='verification'&&!e.finished)){
      const lane=this.lane.resolve(project);if(e.owner&&alive(e.owner.pid,e.owner.birth)||!e.child||alive(e.child.pid,e.child.birth)){this.gate.block('verification:'+e.id,lane.workdirReal,'検証プロセスの終了を照合する必要があります');continue;}
      this.ideas.internal(project,U.uuid(),{kind:'verify-recovered',id:e.id},x=>{x.evidence[e.id]={...e,finished:true,success:false,interrupted:true,reason:'Hub停止後の子プロセス終了を確認。成功は推定しません'};});
      this.gate.unblock('verification:'+e.id);
    }
  }
  acceptance(dir,item,reported,evidence,head) {
    U.check(Array.isArray(reported),'acceptance','受入条件ごとの確認資料が必要です');
    for(const a of item.acceptance.filter(a=>a.required!==false)) {
      const r=reported.find(x=>x.id===a.id);U.check(r&&Array.isArray(r.evidenceRefs)&&r.evidenceRefs.length,'acceptance','受入条件の確認資料が不足しています');
      U.check(a.verification!=='manual'||r.evidenceRefs.some(ref=>ref.kind==='manual'),'acceptance-manual','人による確認が必要な受入条件があります');
      U.check(a.verification!=='inspection'||r.evidenceRefs.some(ref=>ref.kind==='inspection'),'acceptance-inspection','原物の確認が必要な受入条件があります');
      U.check(a.verification!=='test'||r.evidenceRefs.some(ref=>ref.kind==='test'),'acceptance-test','登録した検証の証拠が必要な受入条件があります');
      for(const ref of r.evidenceRefs) {
        if(ref.kind==='test'){U.check(evidence.success&&evidence.head===head&&(ref.id===evidence.id||!ref.id&&ref.profile===evidence.profile),'acceptance-test','対象の検証成功を照合できません');ref.id=evidence.id;ref.head=head;}
        else if(ref.kind==='inspection'){U.check(typeof ref.path==='string'&&!path.isAbsolute(ref.path)&&!ref.path.split('/').includes('..')&&ref.head===head,'acceptance-inspection','確認した資料を照合できません');U.check(U.hash(U.gitRaw(dir,['show',head+':'+ref.path]))===ref.hash,'acceptance-inspection','確認した資料が変更されています');}
        else if(ref.kind==='manual')U.check(a.verification==='manual'&&item.manualEvidence?.some(e=>e.id===ref.id&&e.by==='human-ui'&&e.contentRev===item.contentRev&&e.acceptanceId===a.id&&e.head===head),'acceptance-manual','人による確認が必要な受入条件があります');else U.check(false,'acceptance-kind','確認資料の種類が一致しません');
      }
    }
    U.check(item.acceptance.length,'acceptance','原文に対応する受入条件がありません'); return true;
  }
}
module.exports={IdeaVerification};
