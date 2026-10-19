'use strict';
// No name/cwd based killing. Keep the identity of each positively owned process.
const platforms = require('./platform');
const snapshot = () => platforms.processSnapshot();
const ownerValid = value => Number.isSafeInteger(value) && value >= 0 || typeof value === 'string' && Boolean(value.trim());
function sameOwner(a,b,platform=platforms){if(!a||!b)return false;const owner=platform.processOwner(a);return ownerValid(owner)&&owner===platform.processOwner(b);}
function valid(p,platform){return Boolean(p&&Number.isSafeInteger(p.pid)&&p.pid>1&&ownerValid(platform.processOwner(p))&&typeof p.since==='string'&&p.since.trim()&&typeof p.command==='string'&&p.command.trim());}
function currentOwner(p,platform){const owner=platform.processOwner(p);return ownerValid(owner)&&owner===platform.currentProcessOwner();}
function same(a,b,platform=platforms){return Boolean(valid(a,platform)&&valid(b,platform)&&a.pid===b.pid&&sameOwner(a,b,platform)&&a.since===b.since&&a.command===b.command&&a.pgid===b.pgid);}
function capture(pid,rows=snapshot(),platform=platforms){const p=rows.find(p=>p.pid===pid);if(!valid(p,platform)||p.pid===process.pid||!currentOwner(p,platform))throw Error('Hubが起動したプロセスの所有を確認できません');return p;}
// Windows must provide a working native ownership probe BEFORE launching a CLI.
// This is no replacement for capture/rechecking the newly spawned child.
function assertLaunchOwnership(platform=platforms){
  if(platform.name!=='win32')return;
  const self=platform.processSnapshot().find(p=>p.pid===process.pid);
  if(!valid(self,platform)||!currentOwner(self,platform))throw Error('プロセスの所有確認が使えないためAIを開始しません');
}
class OwnedProcesses{
  constructor(identity,{platform=platforms,scan=()=>platform.processSnapshot(),kill=(pid,s)=>process.kill(pid,s)}={}){this.identity=identity;this.platform=platform;this.scan=scan;this.kill=kill;this.known=new Map([[identity.pid,identity]]);}
  collect(){const rows=this.scan(),by=new Map(rows.map(p=>[p.pid,p]));
    if(!valid(this.identity,this.platform)||!currentOwner(this.identity,this.platform))throw Error('Hubが起動したプロセスの所有を確認できません');
    for(const p of this.known.values())if(by.has(p.pid)&&!same(p,by.get(p.pid),this.platform))throw Error('プロセスの識別が変わったため信号を送っていません');
    const active=new Set([...this.known.values()].filter(p=>same(p,by.get(p.pid),this.platform)).map(p=>p.pid));
    // Descendants can change process group or be reparented after capture.
    let changed=true;while(changed){changed=false;for(const p of rows)if(!active.has(p.pid)&&active.has(p.ppid)&&valid(p,this.platform)&&sameOwner(p,this.identity,this.platform)&&p.pid!==process.pid){active.add(p.pid);this.known.set(p.pid,p);changed=true;}}
    return [...active].map(pid=>by.get(pid));
  }
  signal(signal){const targets=this.collect().reverse(),out=[];for(const p of targets){const now=this.scan().find(r=>r.pid===p.pid);if(!same(now,p,this.platform)){out.push({pid:p.pid,state:'identity-changed'});continue;}try{this.kill(p.pid,signal);out.push({pid:p.pid,state:'signalled',signal});}catch(e){out.push({pid:p.pid,state:e.code==='ESRCH'?'exited':'failed',error:e.code||e.message});}}return out;}
}
// A terminal ancestry is positive evidence. Missing ancestry (including
// reparented Hub children) stays unknown and never becomes "external".
function independentExternal(item,rows,owned=()=>false,platform=platforms){
  const by=new Map(rows.map(p=>[p.pid,p])),p=by.get(item.pid);
  if(!p||!item.since||Date.parse(p.since)!==Date.parse(item.since)||!Number.isFinite(Date.parse(item.since)))return false;
  const seen=new Set();let terminal=false;
  for(let r=p;r&&r.pid>1&&!seen.has(r.pid);r=by.get(r.ppid)){
    if(r.pid===process.pid||owned(r.pid)||!currentOwner(r,platform))return false;seen.add(r.pid);
    if(platform.isExternalTerminal(r.command))terminal=true;
    if(r.ppid===1)return terminal;
    if(!by.has(r.ppid))return false;
  }
  return false;
}
module.exports={snapshot,same,sameOwner,capture,assertLaunchOwnership,OwnedProcesses,independentExternal};
