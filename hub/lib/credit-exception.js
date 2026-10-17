'use strict';
// One human grant for the existing Codex default balance. No billing operations.
const SCALE=10n**10n, CAP=62500n*SCALE;
const {lt}=require('./locale');
function amount(s){
  if(typeof s!=='string'||s.length>80||!/^\d+(?:\.\d{1,10})?$/.test(s))return null;
  const [whole,fraction='']=s.split('.');return BigInt(whole)*SCALE+BigInt(fraction.padEnd(10,'0'));
}
function decimal(n){return (n/SCALE).toString()+'.'+(n%SCALE).toString().padStart(10,'0');}
function fresh(p,now,maxAge){
  const a=Date.parse(p?.attemptedAt),b=Date.parse(p?.fetchedAt);
  return p?.status==='ok'&&Number.isFinite(a)&&Number.isFinite(b)&&a<=b&&b<=now+5000&&now-a<=maxAge;
}
function providers(snapshot){return Array.isArray(snapshot?.accountProviders)?snapshot.accountProviders:Object.entries(snapshot?.providers||{}).map(([ai,p])=>({...p,ai}));}
function valid(e){return e?.version===1&&e.ai==='codex'&&e.account==='default'&&e.grantedBy==='human'&&['active','ended'].includes(e.state)&&amount(e.startBalance)>0n&&amount(e.startBalance)<=CAP&&amount(e.lastBalance)!==null&&amount(e.consumed)!==null&&Number.isFinite(Date.parse(e.lastCheckedAt));}
const finish=(e,reason,now)=>({...e,state:'ended',endedAt:new Date(now).toISOString(),endReason:reason});
function observe(e,p,now,maxAge){
  if(!valid(e)||e.state!=='active'||p.ai!=='codex'||(p.account||'default')!=='default')return {exception:e,suppress:false};
  if(!fresh(p,now,maxAge)||Date.parse(p.attemptedAt)<Date.parse(e.lastCheckedAt))return {exception:e,preserve:true};
  const balance=amount(p.credits?.balance);
  if(p.credits?.hasCredits===false||balance===0n)return {exception:finish(e,'exhausted',now),suppress:false};
  if(Array.isArray(p.windows)&&p.windows.some(w=>['codex:primary','codex:secondary'].includes(w.id)&&w.label===lt('週間枠')&&Number.isFinite(w.usedPercent)&&w.usedPercent<100))return {exception:finish(e,'reset',now),suppress:false};
  if(balance===null||p.credits?.unlimited!==false)return {exception:e,preserve:true};
  const delta=amount(e.lastBalance)-balance,consumed=amount(e.consumed)+(delta>0n?delta:0n);
  const next={...e,lastBalance:p.credits.balance,lastCheckedAt:p.fetchedAt,consumed:decimal(consumed)};
  if(consumed>=amount(e.startBalance))return {exception:finish(next,'allowance-used',now),suppress:false};
  return {exception:next,suppress:true};
}
module.exports={amount,decimal,CAP,fresh,providers,valid,finish,observe};
