'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../public/task-history.js'),'utf8');
function fixture(){
 const storage=new Map(),events=new Map(),calls=[],box={dataset:{p:'p',t:'t'},innerHTML:'',textContent:'',hidden:true};const stats={loads:0,toasts:0},intervals=[],timers=[];let serial=0,view={generation:1,auto:null};
 const c=vm.createContext({renderedMainKey:'',UI:{text:x=>x,message:x=>x,html:x=>x,template:(ss,...vs)=>ss.reduce((s,x,i)=>s+x+(vs[i]??''),'')},$:()=>box,esc:String,CSS:{escape:String},URLSearchParams,TypeError,crypto:{randomUUID:()=>String(++serial)},localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},document:{documentElement:{},querySelectorAll:()=>[],hidden:false,querySelector:()=>({disabled:false,textContent:''}),addEventListener:(n,cb)=>events.set(n,cb)},setInterval(cb){intervals.push(cb);},setTimeout(cb,ms){timers.push({cb,ms});},clearTimeout(){},toast(){stats.toasts++;},load:async()=>{stats.loads++;},render(){}});
 c.api=async(url,body)=>{calls.push([url,body]);if(!body)return view;view={generation:1,auto:{id:'job',generation:1,requestId:body.requestId,stage:'reserved'}};return view;};
 vm.runInContext(source,c);return {c,calls,storage,stats,box,timers,intervals,set:v=>view=v};
}
test('manual auto-start is replaced by one continuation entry; polling never posts a second job',async()=>{
 const f=fixture();f.set({generation:1,auto:{stage:'reserved',generation:1,requestId:'saved'}});await f.c.refreshAuto('p','t');assert.equal(f.calls.filter(([,b])=>b).length,0);
 assert.doesNotMatch(source,/function startAuto|function autoRequest|data-history-field|<textarea/);assert.match(source,/history-selection/);assert.match(source,/continueRequest/);
});

for(const saved of [false,true])test('terminal SSE and reset refresh immediately, coalesce polling, and load/toast once, saved='+saved,async()=>{
 const f=fixture(),active={generation:1,auto:{stage:'selecting',generation:1,model:'Opus 5.5'}},done={generation:2,auto:{stage:'done',generation:1}};
 f.c.drawAuto('p','t',active);if(saved)f.c.continueRequest('p','t',{requestId:'saved',status:'pending'});
 let release;const blocked=new Promise(r=>release=r);f.c.api=async url=>{f.calls.push([url]);if(url.includes('/continue/status'))return {status:'done',result:{generation:2}};await blocked;return done;};
 assert.equal(f.c.HubTaskHistory.resetAuto('p','t'),true);f.c.HubTaskHistory.receiveAuto('p','t',done);f.c.HubTaskHistory.receiveAuto('p','t',done);
 assert.equal(f.calls.length,1,'SSE通知の時点でGETを開始');release();await f.c.refreshAuto('p','t');
 assert.equal(f.stats.loads,1);assert.equal(f.stats.toasts,1);assert.equal(f.c.HubChatGenerations.get('p\0t'),2);
 f.c.HubTaskHistory.receiveAuto('p','t',done);await f.c.refreshAuto('p','t');assert.equal(f.stats.loads,1);assert.equal(f.stats.toasts,1);
});
test('terminal event during a stale poll rechecks immediately, and failed selection never reloads',async()=>{
 const f=fixture(),active={generation:1,auto:{stage:'selecting',generation:1}};f.c.drawAuto('p','t',active);
 let release,n=0;const blocked=new Promise(r=>release=r);f.c.api=async()=>{n++;if(n===1){await blocked;return active;}return {generation:2,auto:{stage:'done',generation:1}};};
 const poll=f.c.refreshAuto('p','t');f.c.HubTaskHistory.receiveAuto('p','t',{generation:2,auto:{stage:'done',generation:1}});release();await poll;assert.equal(f.stats.loads,1);
 const g=fixture();g.c.drawAuto('p','t',active);g.c.continueRequest('p','t',{requestId:'saved'});
 g.c.api=async url=>url.includes('/continue/status')?{status:'failed',result:{error:'失敗'}}:{generation:1,auto:{stage:'failed',generation:1,error:'失敗'}};
 g.c.HubTaskHistory.receiveAuto('p','t',{generation:1,auto:{stage:'failed',generation:1,error:'失敗'}});await g.c.refreshAuto('p','t');assert.equal(g.stats.loads,0);assert.match(g.box.textContent,/失敗/);
});
test('summary progress shows model and a ticking elapsed time in Japanese and Traditional Chinese without estimates',()=>{
 for(const lang of ['ja','zh-TW']){
  const f=fixture();f.c.HUB_LOCALE={locale:lang,messages:lang==='zh-TW'?require('../../langpacks/zh-TW/ui.json'):{}};
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/locale.js'),'utf8'),f.c);f.c.UI=f.c.HubI18n;
  const view={generation:1,auto:{stage:'selecting',model:'Opus 5.5',stageStarted:new Date(Date.now()-80000).toISOString()}};
  f.c.drawAuto('p','t',view);assert.match(f.box.innerHTML,/Opus 5.5/);assert.match(f.box.innerHTML,lang==='ja'?/経過 1分20秒/:/已經過 1分20秒/);
  assert.doesNotMatch(f.box.innerHTML,/\d+%|残り|選別/);if(lang==='zh-TW')assert.doesNotMatch(f.box.innerHTML,/[\u3041-\u3096\u30a1-\u30fa]/);
  view.auto.stageStarted=new Date(Date.now()-81000).toISOString();f.intervals[0]();f.intervals[0]();assert.match(f.box.innerHTML,/1分21秒/);
 }
});

test('failed completion reload retains reconciliation intent and recovers without a second success toast',async()=>{
 const f=fixture();f.c.drawAuto('p','t',{generation:1,auto:{stage:'selecting',generation:1}});f.set({generation:2,auto:{stage:'done',generation:1}});
 f.c.load=async()=>{f.stats.loads++;if(f.stats.loads===1)throw Error('fixture network loss while loading');};
 await f.c.refreshAuto('p','t');assert.equal(f.stats.loads,1);assert.equal(f.stats.toasts,0);assert.ok(f.timers.some(x=>x.ms===3000));
 await f.c.refreshAuto('p','t');assert.equal(f.stats.loads,2);assert.equal(f.stats.toasts,1);assert.equal(f.box.textContent,'');
 await f.c.refreshAuto('p','t');assert.equal(f.stats.loads,2);assert.equal(f.stats.toasts,1);
});
