'use strict';
// No name/cwd based killing. Keep the identity of each positively owned process.
const {execFileSync}=require('node:child_process');
function snapshot(){
  if(!['darwin','linux'].includes(process.platform))throw Error('このOSではプロセスの所有確認に対応していません');
  const out=execFileSync('ps',['-axo','pid=,ppid=,pgid=,uid=,lstart=,stat=,comm='],{encoding:'utf8',timeout:2000,maxBuffer:8*1024*1024,env:{...process.env,LC_ALL:'C',LANG:'C'}});
  const rows=[];
  for(const l of out.split('\n')){const m=l.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(\S+)\s+(.+)$/);if(m&&!m[6].startsWith('Z'))rows.push({pid:+m[1],ppid:+m[2],pgid:+m[3],uid:+m[4],since:m[5].replace(/\s+/g,' '),command:m[7]});}
  if(!rows.length)throw Error('プロセスの所有確認に失敗しました');return rows;
}
function same(a,b){return Boolean(a&&b&&a.pid===b.pid&&a.uid===b.uid&&a.since===b.since&&a.command===b.command&&a.pgid===b.pgid);}
function capture(pid,rows=snapshot()){const p=rows.find(p=>p.pid===pid);if(!p||p.pid<=1||p.pid===process.pid||p.uid!==process.getuid?.())throw Error('Hubが起動したプロセスの所有を確認できません');return p;}
class OwnedProcesses{
  constructor(identity,{scan=snapshot,kill=(pid,s)=>process.kill(pid,s)}={}){this.identity=identity;this.scan=scan;this.kill=kill;this.known=new Map([[identity.pid,identity]]);}
  collect(){const rows=this.scan(),by=new Map(rows.map(p=>[p.pid,p]));
    for(const p of this.known.values())if(by.has(p.pid)&&!same(p,by.get(p.pid)))throw Error('プロセスの識別が変わったため信号を送っていません');
    const active=new Set([...this.known.values()].filter(p=>same(p,by.get(p.pid))).map(p=>p.pid));
    // Descendants can change process group or be reparented after capture.
    let changed=true;while(changed){changed=false;for(const p of rows)if(!active.has(p.pid)&&active.has(p.ppid)&&p.uid===this.identity.uid&&p.pid!==process.pid){active.add(p.pid);this.known.set(p.pid,p);changed=true;}}
    return [...active].map(pid=>by.get(pid));
  }
  signal(signal){const targets=this.collect().reverse(),out=[];for(const p of targets){const now=this.scan().find(r=>r.pid===p.pid);if(!same(now,p)){out.push({pid:p.pid,state:'identity-changed'});continue;}try{this.kill(p.pid,signal);out.push({pid:p.pid,state:'signalled',signal});}catch(e){out.push({pid:p.pid,state:e.code==='ESRCH'?'exited':'failed',error:e.code||e.message});}}return out;}
}
// A terminal ancestry is positive evidence. Missing ancestry (including
// reparented Hub children) stays unknown and never becomes "external".
function independentExternal(item,rows,owned=()=>false){
  const by=new Map(rows.map(p=>[p.pid,p])),p=by.get(item.pid);
  if(!p||!item.since||Date.parse(p.since)!==Date.parse(item.since)||!Number.isFinite(Date.parse(item.since)))return false;
  const seen=new Set();let terminal=false;
  for(let r=p;r&&r.pid>1&&!seen.has(r.pid);r=by.get(r.ppid)){
    if(r.pid===process.pid||owned(r.pid)||r.uid!==process.getuid?.())return false;seen.add(r.pid);
    if(/\/(?:Terminal\.app\/Contents\/MacOS\/Terminal|iTerm\.app\/Contents\/MacOS\/iTerm2|kitty\.app\/Contents\/MacOS\/kitty)$/.test(r.command))terminal=true;
    if(r.ppid===1)return terminal;
    if(!by.has(r.ppid))return false;
  }
  return false;
}
module.exports={snapshot,same,capture,OwnedProcesses,independentExternal};
