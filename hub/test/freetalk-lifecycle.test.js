'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Store}=require('../lib/store'),{Freetalk}=require('../lib/freetalk'),{FreetalkHistory}=require('../lib/freetalk-history'),{FreetalkLifecycle,nextMonth,SETTINGS}=require('../lib/freetalk-lifecycle'),chat=require('../lib/chat');
const pick={ai:'codex',model:'GPT-6.1-Sol',effort:'高'};
function fixture(t){
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'hub-freetalk-lifecycle-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const store=new Store(path.join(tmp,'root')),ft=new Freetalk(store,path.join(tmp,'home'));assert.equal(ft.ensure().ready,true);
 const a=ft.createTopic(pick),b=ft.createTopic(pick);let busy='',date=new Date('2026-01-31T12:30:00');
 const history=new FreetalkHistory(ft,()=>busy),lifecycle=new FreetalkLifecycle(history,()=>busy,()=>date,path.join(__dirname,'../../docs/project-hub/templates/project'));
 lifecycle.save({lastClean:date.toISOString(),due:nextMonth(date)});
 return {tmp,store,ft,a,b,history,lifecycle,busy:v=>busy=v,date:v=>date=new Date(v)};
}
function approved(f){const {ft,a,history:h,lifecycle:l}=f;chat.append(ft.ledger,a.id,{role:'assistant',ai:'codex',model:pick.model,text:'会話の原文'});const r=h.prepareSummary(a.id);chat.append(ft.ledger,a.id,{role:'user',text:r.text});chat.append(ft.ledger,a.id,{role:'assistant',ai:'codex',model:pick.model,text:'AIの要約'});const p=l.preview(a.id);return {...p,name:'独立した旅行',summary:'人が編集した計画',files:p.files.map(f=>f.path),confirm:true};}
function write(file,text='内容'){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);}
function tree(dir){const rows=[];const walk=p=>{for(const n of fs.readdirSync(p).sort()){const f=path.join(p,n);if(fs.lstatSync(f).isDirectory())walk(f);else rows.push([path.relative(dir,f),fs.readFileSync(f).toString('base64')]);}};walk(dir);return rows;}
test('1暦月は月末補正、閏年、年越し、時刻を維持',()=>{for(const [from,to] of [['2026-01-31','2026-02-28'],['2028-01-31','2028-02-29'],['2026-03-31','2026-04-30'],['2026-12-31','2027-01-31']]){const d=new Date(nextMonth(from+'T12:30:00'));assert.equal(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`,to);assert.equal(d.getHours(),12);assert.equal(d.getMinutes(),30);}});
test('プロジェクト化：編集要約、新セッション、原文と選択ファイル、元読取専用、二重作成なし',t=>{
 const f=fixture(t),{ft,a,b,lifecycle:l,history:h,store}=f;
 const selected=ft.upload(a.id,'写真.txt',Buffer.from('写真原文')),omitted=ft.upload(a.id,'残す.txt',Buffer.from('残す'));
 const other=ft.upload(b.id,'他話題.txt',Buffer.from('別話題'));write(path.join(ft.dir,'相談.txt'),'共通相談');
 write(path.join(ft.dir,'topics',a.id,'.ai/memory.md'),'話題メモリ');chat.writeMeta(ft.ledger,a.id,{sessions:{codex:'old',claude:'old'}});
 const body=approved(f);body.files=body.files.filter(v=>path.join(ft.dir,v)!==omitted);const original=fs.readFileSync(chat.files(ft.ledger,a.id).log);
 const r=l.promote(a.id,body),p=store.readProject(r.project);assert.ok(p);assert.equal(p.parent,'');assert.deepEqual(p.related,[]);
 assert.deepEqual(fs.readFileSync(path.join(p.dir,'資料/自由対話原文.jsonl')),original);assert.deepEqual(chat.readMeta(p.dir,r.task).sessions,{});
 assert.match(chat.read(p.dir,r.task)[0].text,/人が編集した計画/);assert.doesNotMatch(chat.read(p.dir,r.task)[0].text,/AIの要約/);
 assert.equal(fs.readFileSync(path.join(p.dir,'資料/相談ファイル',path.relative(ft.dir,selected)),'utf8'),'写真原文');assert.equal(fs.existsSync(selected),false);
 for(const file of [omitted,other,path.join(ft.dir,'topics',a.id,'.ai/memory.md'),path.join(ft.dir,'AGENTS.md')])assert.ok(fs.existsSync(file));
 assert.equal(h.status(a.id).migrated.project,r.project);assert.throws(()=>h.rotate(a.id,{confirm:true}),/移行済み/);assert.throws(()=>h.prepareSummary(a.id),/移行済み/);
 assert.equal(l.promote(a.id,body).repeated,true);assert.equal(store.listProjects().filter(p=>p.kind!=='freetalk').length,1);
 l.clean({confirm:true});assert.ok(store.readProject(r.project));assert.deepEqual(chat.readMeta(p.dir,r.task).sessions,{});assert.deepEqual(fs.readFileSync(path.join(p.dir,'資料/自由対話原文.jsonl')),original);
 assert.equal(store.readProject('freetalk').tasks.length,0);const next=ft.createTopic(pick);assert.notEqual(next.id,a.id);assert.notEqual(next.id,b.id);
});
test('GEMINI.mdは移す候補から除外し掃除後も保持、未配置なら作成しない',t=>{
 const f=fixture(t),file=path.join(f.ft.dir,'GEMINI.md'),settings=Buffer.from('Geminiの人の設定\n');
 assert.equal(fs.existsSync(file),false);write(file,settings);write(path.join(f.ft.dir,'相談.txt'),'相談');
 const body=approved(f);assert.deepEqual(body.files,['相談.txt']);
 const r=f.lifecycle.promote(f.a.id,body),dest=f.store.readProject(r.project).dir;
 assert.deepEqual(fs.readFileSync(file),settings);assert.equal(fs.existsSync(path.join(dest,'資料/相談ファイル/GEMINI.md')),false);
 f.lifecycle.clean({confirm:true});assert.deepEqual(fs.readFileSync(file),settings);
 assert.equal(fs.readFileSync(path.join(dest,'資料/相談ファイル/相談.txt'),'utf8'),'相談');
 const absent=fixture(t),missing=path.join(absent.ft.dir,'GEMINI.md');
 absent.lifecycle.promote(absent.a.id,approved(absent));assert.equal(fs.existsSync(missing),false);
 absent.lifecycle.clean({confirm:true});assert.equal(fs.existsSync(missing),false);
});
test('古い確認/ファイル改変/選択外パス/同名/別操作IDを拒否し元保持',t=>{
 for(const kind of ['confirm','revision','files','name','changed','operationId']){
  const f=fixture(t);write(path.join(f.ft.dir,'test.txt'),'元');const body=approved(f);
  if(kind==='confirm')body.confirm=false;if(kind==='revision')body.revision='old';if(kind==='files')body.files=['../outside'];if(kind==='name')body.name='FreeTalk';if(kind==='changed')write(path.join(f.ft.dir,'test.txt'),'更新');if(kind==='operationId')body.operationId='fake';
  const before=tree(f.ft.ledger);assert.throws(()=>f.lifecycle.promote(f.a.id,body));assert.deepEqual(tree(f.ft.ledger),before);assert.ok(fs.existsSync(path.join(f.ft.dir,'test.txt')));assert.equal(f.store.listProjects().length,1);
 }
 const f=fixture(t),body=approved(f);f.store.createProject({name:body.name});assert.throws(()=>f.lifecycle.promote(f.a.id,body),/同じ名前/);
});
test('AI/順番待ち/移行中はプロジェクト化・全体掃除を拒否し期限後も延期',t=>{
 const f=fixture(t),body=approved(f);f.date('2026-03-01T12:30:00');
 for(const reason of ['AIが作業中','順番待ち']){f.busy(reason);assert.equal(f.lifecycle.status().delayed,true);assert.throws(()=>f.lifecycle.promote(f.a.id,body),new RegExp(reason));assert.throws(()=>f.lifecycle.clean({confirm:true}),new RegExp(reason));assert.equal(f.lifecycle.tick(),null);assert.ok(f.store.readProject('freetalk').tasks.length);}
 f.busy('');f.lifecycle.operating=true;assert.throws(()=>f.lifecycle.clean({confirm:true}),/途中/);assert.equal(f.lifecycle.tick(),null);f.lifecycle.operating=false;assert.equal(f.lifecycle.tick().ok,true);assert.equal(f.store.readProject('freetalk').tasks.length,0);
});
test('7日前/前日案内、期限前自動掃除なし、手動成功から期限更新',t=>{
 const f=fixture(t);for(const [day,notice,days] of [['2026-02-20T12:30:00',false,8],['2026-02-21T12:30:00',true,7],['2026-02-27T12:30:00',true,1]]){f.date(day);const s=f.lifecycle.status();assert.equal(s.notice,notice);assert.equal(s.days,days);assert.equal(f.lifecycle.tick(),null);}
 f.date('2026-02-27T12:30:00');assert.throws(()=>f.lifecycle.clean({}),/確認/);f.lifecycle.clean({confirm:true});assert.equal(new Date(f.lifecycle.status().due).getDate(),27);assert.equal(new Date(f.lifecycle.status().due).getMonth(),2);
});
test('掃除は許可設定と最小管理だけ保持、隠し物/共通物/メモリも退避し外側を保護',t=>{
 const f=fixture(t),{ft,lifecycle:l}=f;for(const rel of SETTINGS)fs.appendFileSync(path.join(ft.dir,rel),rel.endsWith('.json')?'':'\n人の設定');
 // marker JSONは改変しない。
 write(path.join(ft.dir,'.hidden'),'隠し物');write(path.join(ft.dir,'.ai/private.json'),'秘密以外の一時物');write(path.join(ft.ledger,'.ai/memory/old.txt'),'古い記録');write(path.join(ft.ledger,'成果物/old.txt'),'一時成果');
 const external=path.join(f.tmp,'external');write(external,'外側');fs.symlinkSync(external,path.join(ft.dir,'外のリンク'));
 const before=SETTINGS.map(rel=>[rel,fs.readFileSync(path.join(ft.dir,rel))]);l.clean({confirm:true});
 for(const [rel,data]of before)assert.deepEqual(fs.readFileSync(path.join(ft.dir,rel)),data);
 assert.deepEqual(tree(ft.dir).map(r=>r[0]).sort(),SETTINGS.slice().sort());assert.deepEqual(tree(ft.ledger).map(r=>r[0]).sort(),['.ai/freetalk-maintenance.json','PROJECT.md']);assert.equal(fs.readFileSync(external,'utf8'),'外側');
 assert.equal(ft.verify().kind,'freetalk');
});
test('プロジェクト化の各書込/移動失敗は元台帳・資料を完全保持',t=>{
 // 非注入成功で経路を数え、その全書込/rename箇所で1回だけ失敗させる。
 const methods=['writeFileSync','renameSync','copyFileSync'];let count=0;
 {const f=fixture(t);write(path.join(f.ft.dir,'test.txt'),'元');const body=approved(f),orig=Object.fromEntries(methods.map(m=>[m,fs[m]]));for(const m of methods)fs[m]=(...args)=>{count++;return orig[m](...args);};try{f.lifecycle.promote(f.a.id,body);}finally{for(const m of methods)fs[m]=orig[m];}}
 for(let at=1;at<=count;at++){
  const f=fixture(t);write(path.join(f.ft.dir,'test.txt'),'元');const body=approved(f),before=tree(f.ft.ledger),docs=tree(f.ft.dir),orig=Object.fromEntries(methods.map(m=>[m,fs[m]]));let n=0;
  for(const m of methods)fs[m]=(...args)=>{if(++n===at)throw Error('injected EIO '+at);return orig[m](...args);};
  try{assert.throws(()=>f.lifecycle.promote(f.a.id,body));}finally{for(const m of methods)fs[m]=orig[m];}
  assert.deepEqual(tree(f.ft.ledger),before,'台帳 '+at);assert.deepEqual(tree(f.ft.dir),docs,'資料 '+at);assert.equal(f.store.listProjects().length,1,'別プロジェクト未作成 '+at);assert.equal(f.lifecycle.operating,false);
 }
});
test('掃除の各書込/移動失敗は設定と全話題を完全保持し期限不変',t=>{
 const methods=['writeFileSync','renameSync'];let count=0;
 {const f=fixture(t);const orig=Object.fromEntries(methods.map(m=>[m,fs[m]]));for(const m of methods)fs[m]=(...args)=>{count++;return orig[m](...args);};try{f.lifecycle.clean({confirm:true});}finally{for(const m of methods)fs[m]=orig[m];}}
 for(let at=1;at<=count;at++){
  const f=fixture(t),before=tree(f.ft.ledger),docs=tree(f.ft.dir),orig=Object.fromEntries(methods.map(m=>[m,fs[m]]));let n=0;
  for(const m of methods)fs[m]=(...args)=>{if(++n===at)throw Error('injected EIO '+at);return orig[m](...args);};
  try{assert.throws(()=>f.lifecycle.clean({confirm:true}));}finally{for(const m of methods)fs[m]=orig[m];}
  assert.deepEqual(tree(f.ft.ledger),before,'台帳 '+at);assert.deepEqual(tree(f.ft.dir),docs,'資料 '+at);assert.equal(f.lifecycle.operating,false);
 }
});
test('話題削除：その話題の記録・添付・メモリだけをゴミ箱へ、他の話題・設定・共通相談は残す',t=>{
 const f=fixture(t),{ft,a,b,history:h,lifecycle:l,store}=f;
 const own=ft.upload(a.id,'写真.txt',Buffer.from('写真')),other=ft.upload(b.id,'他.txt',Buffer.from('他'));write(path.join(ft.dir,'相談.txt'),'共通');
 write(path.join(ft.dir,'topics',a.id,'.ai/memory.md'),'話題メモリ');chat.append(ft.ledger,a.id,{role:'user',text:'消す会話'});chat.writeMeta(ft.ledger,a.id,{sessions:{codex:'old'}});
 chat.append(ft.ledger,b.id,{role:'user',text:'残す会話'});h.save(a.id,{generation:2});
 for(const dir of ['handoff','memory','work'])write(path.join(ft.ledger,'.ai',dir,a.id+'.md'),dir);write(path.join(ft.ledger,'.ai/memory',b.id+'.md'),'残す');
 assert.throws(()=>l.remove(a.id),/確認/);f.busy('AIが作業中です');assert.throws(()=>l.remove(a.id,{confirm:true}),/作業中/);f.busy('');
 const r=l.remove(a.id,{confirm:true});assert.equal(r.ok,true);assert.ok(r.trash.startsWith(path.join(ft.home,'.Trash')));
 assert.deepEqual(store.readProject('freetalk').tasks.map(t=>t.id),[b.id]);
 for(const file of [own,path.join(ft.dir,'topics',a.id),h.file(a.id),...Object.values(chat.files(ft.ledger,a.id)),...['handoff','memory','work'].map(d=>path.join(ft.ledger,'.ai',d,a.id+'.md'))])assert.equal(fs.existsSync(file),false,file);
 for(const file of [other,path.join(ft.dir,'相談.txt'),path.join(ft.ledger,'.ai/memory',b.id+'.md'),chat.files(ft.ledger,b.id).log,...SETTINGS.map(s=>path.join(ft.dir,s)).filter(s=>!s.endsWith('GEMINI.md'))])assert.ok(fs.existsSync(file),file);
 assert.equal(JSON.parse(fs.readFileSync(path.join(r.trash,'manifest.json'),'utf8')).task,a.id);
 assert.throws(()=>l.remove(a.id,{confirm:true}),/見つかりません/);
});
test('話題削除：移動に失敗したら移した分を元へ戻す',t=>{
 const f=fixture(t),{ft,a,lifecycle:l,store}=f;chat.append(ft.ledger,a.id,{role:'user',text:'残る会話'});const own=ft.upload(a.id,'写真.txt',Buffer.from('写真'));
 const rename=fs.renameSync;let n=0;fs.renameSync=(from,to)=>{if(++n===3)throw Error('移動できない');return rename(from,to);};
 try{assert.throws(()=>l.remove(a.id,{confirm:true}),/削除に失敗し、元の話題を保持/);}finally{fs.renameSync=rename;}
 assert.ok(store.readProject('freetalk').tasks.some(t=>t.id===a.id));assert.equal(chat.read(ft.ledger,a.id)[0].text,'残る会話');assert.ok(fs.existsSync(own));
});

test('回帰：symlink入りフォルダ/300MBを理由付きで除外し、移せる添付・共有ファイルで確認付き作成',t=>{
 const f=fixture(t),{ft,a,lifecycle:l,history:h}=f;
 const bad=path.join(ft.dir,'other/node_modules/.bin');fs.mkdirSync(bad,{recursive:true});fs.symlinkSync('/outside',path.join(bad,'tool'));
 const big=path.join(ft.dir,'300MB.bin');fs.closeSync(fs.openSync(big,'w'));fs.truncateSync(big,300*1024*1024);
 write(path.join(ft.dir,'相談.txt'),'共通');const attachment=ft.upload(a.id,'添付.txt',Buffer.from('添付原文'));const body=approved(f);
 const blocked=body.files.filter(p=>['other','300MB.bin'].includes(p));assert.equal(blocked.length,2);
 const p=l.preview(a.id);assert.match(p.files.find(f=>f.path==='other').reason,/リンク/);assert.match(p.files.find(f=>f.path==='300MB.bin').reason,/大きすぎ/);
 body.files=p.files.filter(f=>!f.reason).map(f=>f.path);const transcript=fs.readFileSync(chat.files(ft.ledger,a.id).log);
 assert.throws(()=>l.promote(a.id,{...body,files:['other']}),/選び直/);
 const r=l.promote(a.id,body),dest=f.store.readProject(r.project).dir;
 assert.deepEqual(fs.readFileSync(path.join(dest,'資料/自由対話原文.jsonl')),transcript);
 assert.equal(fs.readFileSync(path.join(dest,'資料/相談ファイル',path.relative(ft.dir,attachment)),'utf8'),'添付原文');
 assert.ok(fs.lstatSync(path.join(bad,'tool')).isSymbolicLink());assert.equal(fs.statSync(big).size,300*1024*1024);
 assert.equal(h.status(a.id).promotionRequested,false);assert.equal(l.promote(a.id,body).repeated,true);
});
test('選択合計256MBはサーバーで拒否し、未選択の大きな資料の更新は作成を妨げない',t=>{
 const f=fixture(t),{ft,a,lifecycle:l}=f;write(path.join(ft.dir,'safe.txt'),'資料');const bad=path.join(ft.dir,'huge.bin');fs.closeSync(fs.openSync(bad,'w'));fs.truncateSync(bad,300*1024*1024);
 const body=approved(f);body.files=['safe.txt'];fs.truncateSync(bad,301*1024*1024);assert.equal(l.promote(a.id,body).ok,true);
 const g=fixture(t);const previewTask=g.a.id;const check=g.lifecycle;
 // 大容量を読み込まず合計上限のサーバー境界を検査。
 const files=[{path:'a.bin',size:150*1024*1024,hash:'a'},{path:'b.bin',size:150*1024*1024,hash:'b'}];check.files=()=>files;
 const preview=approved(g),b={...preview,name:'大きな選択',summary:'確認',files:files.map(f=>f.path),confirm:true};
 assert.throws(()=>check.promote(previewTask,b),/合計が256MB/);assert.equal(g.store.listProjects().length,1);
});
test('移行確定保存の失敗は話題/原文/添付/共有資料/権限を復元し、同じ操作から再開できる',t=>{
 const f=fixture(t),{ft,a,history:h,lifecycle:l}=f;const attachment=ft.upload(a.id,'添付.txt',Buffer.from('添付'));write(path.join(ft.dir,'資料.txt'),'原資料');fs.chmodSync(attachment,0o640);
 const body=approved(f),before=tree(ft.ledger),docs=tree(ft.dir),save=h.save.bind(h);h.save=()=>{throw Error('確定保存の失敗');};
 try{assert.throws(()=>l.promote(a.id,body),/元の話題とファイルを保持/);}finally{h.save=save;}
 assert.deepEqual(tree(ft.ledger),before);assert.deepEqual(tree(ft.dir),docs);assert.equal(fs.statSync(attachment).mode&0o777,0o640);
 assert.equal(f.store.listProjects().length,1);const r=l.promote(a.id,body);assert.equal(r.ok,true);assert.equal(l.promote(a.id,body).repeated,true);
 assert.equal(fs.statSync(path.join(f.store.readProject(r.project).dir,'資料/相談ファイル',path.relative(ft.dir,attachment))).mode&0o777,0o640);
});
test('選択しない資料の変更・追加・欠落を許容し、選択添付と別話題を保全',t=>{
 const f=fixture(t),{ft,a,b,lifecycle:l}=f;
 const own=ft.upload(a.id,'選択.txt',Buffer.from('選択内容')),other=ft.upload(b.id,'他話題.txt',Buffer.from('他話題'));
 write(path.join(ft.dir,'共通.txt'),'前');write(path.join(ft.dir,'未選択.txt'),'残す');
 const body=approved(f);body.files=[path.relative(ft.dir,own)];
 write(path.join(ft.dir,'共通.txt'),'更新');write(path.join(ft.dir,'新しい資料.txt'),'新');fs.unlinkSync(path.join(ft.dir,'未選択.txt'));
 const r=l.promote(a.id,body);assert.equal(r.ok,true);
 assert.equal(fs.readFileSync(path.join(ft.dir,'共通.txt'),'utf8'),'更新');assert.equal(fs.readFileSync(other,'utf8'),'他話題');assert.ok(fs.existsSync(path.join(ft.dir,'新しい資料.txt')));
});
test('選択後のリンク化・欠落・同じ長さの変更を拒否、操作途中の資料も勝手に再利用しない',t=>{
 for(const kind of ['link','missing','content','stage']){
  const f=fixture(t),file=path.join(f.ft.dir,'選択.txt');write(file,'old');const body=approved(f);
  if(kind==='link'){fs.unlinkSync(file);fs.symlinkSync('/outside',file);}if(kind==='missing')fs.unlinkSync(file);if(kind==='content')write(file,'new');
  const stage=path.join(f.store.product,'.freetalk-'+body.operationId);
  if(kind==='stage')write(path.join(stage,'未確定.txt'),'途中の資料');
  assert.throws(()=>f.lifecycle.promote(f.a.id,body));assert.equal(f.history.status(f.a.id).migrated,null);assert.equal(f.store.listProjects().length,1);
  if(kind==='stage')assert.equal(fs.readFileSync(path.join(stage,'未確定.txt'),'utf8'),'途中の資料');
 }
});
test('共通資料のハッシュ検査は256MBで制限、話題の添付は別枠で確認できる',t=>{
 const f=fixture(t);for(const name of ['a.bin','b.bin']){const file=path.join(f.ft.dir,name);write(file,'');fs.truncateSync(file,150*1024*1024);}
 const attachment=f.ft.upload(f.a.id,'添付.txt',Buffer.from('資料'));
 const p=f.lifecycle.preview.bind(f.lifecycle);approved(f);const rows=p(f.a.id).files;
 assert.equal(rows.find(r=>r.path==='a.bin').scope,'shared');assert.match(rows.find(r=>r.path==='b.bin').reason,/検査量/);
 const own=rows.find(r=>r.path===path.relative(f.ft.dir,attachment));assert.equal(own.scope,'topic');assert.ok(own.hash);
});

function automaticReady(f){
 const {ft,a,history:h}=f;
 chat.append(ft.ledger,a.id,{role:'assistant',ai:'codex',model:pick.model,text:'相談の回答'});
 const r=h.prepareSummary(a.id,{intent:'promote',automatic:true});
 chat.append(ft.ledger,a.id,{role:'user',text:r.text});
 chat.append(ft.ledger,a.id,{role:'assistant',ai:'codex',model:pick.model,text:'自動引き継ぎ要約'});
}
test('ワンクリック：確認なしで話題添付と原文を引継ぎ、巨大な共通資料は検査せず保持',t=>{
 const f=fixture(t),{ft,a,b,history:h,lifecycle:l,store}=f;
 const own=ft.upload(a.id,'写真.txt',Buffer.from('添付原文')),other=ft.upload(b.id,'別話題.txt',Buffer.from('他の資料'));
 const big=path.join(ft.dir,'huge.bin');write(big,'');fs.truncateSync(big,300*1024*1024);fs.symlinkSync('/outside',path.join(ft.dir,'外のリンク'));write(path.join(ft.dir,'共通.txt'),'共通は保持');
 automaticReady(f);const original=fs.readFileSync(chat.files(ft.ledger,a.id).log);
 const oldFiles=l.files.bind(l);l.files=(task,opts)=>{assert.equal(opts.topicOnly,true);return oldFiles(task,opts);};
 const r=l.completeAutomatic(a.id);assert.equal(r.ok,true);const dest=store.readProject(r.project).dir;
 assert.deepEqual(fs.readFileSync(path.join(dest,'資料/自由対話原文.jsonl')),original);
 assert.equal(fs.readFileSync(path.join(dest,'資料/相談ファイル',path.relative(ft.dir,own)),'utf8'),'添付原文');
 assert.equal(chat.read(dest,r.task)[0].automaticPromotion,true);assert.equal(chat.read(dest,r.task)[0].summaryApproved,false);
 for(const file of [other,big,path.join(ft.dir,'共通.txt'),path.join(ft.dir,'外のリンク')])assert.ok(fs.lstatSync(file));
 assert.equal(h.status(a.id).automaticCompleted,true);assert.equal(l.completeAutomatic(a.id).repeated,true);assert.equal(store.listProjects().filter(p=>p.kind!=='freetalk').length,1);
 assert.equal(store.taskFile('freetalk',a.id),null);assert.equal(fs.existsSync(path.join(ft.dir,'topics',a.id)),false);assert.equal(fs.existsSync(chat.files(ft.ledger,a.id).log),false);
 assert.deepEqual(Object.keys(h.state(a.id)).sort(),['generation','migrated']);assert.equal(store.readProject('freetalk').tasks.some(t=>t.id===b.id),true);
});
test('ワンクリック：話題名の重複は番号を付け、禁止文字を除去',t=>{
 const f=fixture(t),l=f.lifecycle;f.ft.nameTopic(f.a.id,'.. / 旅行 \\ 計画');
 const name=l.automaticName(f.a.id);assert.doesNotMatch(name,/^[._]|[\/\\\r\n]/);f.store.createProject({name});assert.equal(l.automaticName(f.a.id),name+' (2)');
 automaticReady(f);assert.equal(l.completeAutomatic(f.a.id).project,name+' (2)');
});
test('ワンクリック：AI終了待ちから保存済みintentで再開、旧確認は自動作成しない',t=>{
 const f=fixture(t);approved(f);assert.equal(f.lifecycle.completeAutomatic(f.a.id),null);
 automaticReady(f);f.busy('AIが作業中です');assert.equal(f.lifecycle.completeAutomatic(f.a.id),null);assert.equal(f.history.state(f.a.id).migrated,undefined);
 f.busy('');const reconstructed=new FreetalkLifecycle(f.history,()=>'',()=>new Date('2026-01-31T12:30:00'));assert.equal(reconstructed.completeAutomatic(f.a.id).ok,true);
});
test('ワンクリック：取消と通常整理は自動作成を解除',t=>{
 for(const normal of [false,true]){const f=fixture(t);automaticReady(f);if(normal)f.history.prepareSummary(f.a.id);else f.history.promotionIntent(f.a.id,false);assert.equal(f.lifecycle.completeAutomatic(f.a.id),null);assert.equal(f.history.state(f.a.id).migrated,undefined);}
});
test('ワンクリック：古い要約と失敗は理由を保存し、自動再試行しない',t=>{
 const f=fixture(t);automaticReady(f);chat.append(f.ft.ledger,f.a.id,{role:'user',text:'追加の相談'});
 assert.equal(f.lifecycle.completeAutomatic(f.a.id),null);assert.match(f.history.status(f.a.id).automaticError,/会話が追加/);
 const state=fs.readFileSync(f.history.file(f.a.id));assert.equal(f.lifecycle.completeAutomatic(f.a.id),null);assert.deepEqual(fs.readFileSync(f.history.file(f.a.id)),state);
});
test('ワンクリック：移せない話題添付はリンクを辿らず削除と同じゴミ箱へ、正常添付は移行先へ',t=>{
 const f=fixture(t),dir=path.join(f.ft.dir,'topics',f.a.id);write(path.join(dir,'keep.txt'),'正常');fs.symlinkSync('/outside',path.join(dir,'link'));automaticReady(f);
 const r=f.lifecycle.completeAutomatic(f.a.id);assert.equal(r.ok,true);assert.equal(fs.existsSync(dir),false);
 const manifest=JSON.parse(fs.readFileSync(path.join(r.sourceTrash,'manifest.json'),'utf8'));const target=manifest.planned.find(p=>p.from===dir);assert.ok(fs.lstatSync(path.join(target.to,'link')).isSymbolicLink());
 assert.equal(fs.readFileSync(path.join(f.store.readProject(r.project).dir,'資料/相談ファイル/topics',f.a.id,'keep.txt'),'utf8'),'正常');
});
test('ワンクリック：会話・再開情報・話題メモリと添付フォルダを全部削除、別話題とAI設定は保全',t=>{
 const f=fixture(t),{ft,a,b,history:h,lifecycle:l,store}=f;automaticReady(f);
 for(const dir of ['handoff','memory','work']){write(path.join(ft.ledger,'.ai',dir,a.id,'内容.md'),'自分');write(path.join(ft.ledger,'.ai',dir,b.id,'内容.md'),'他話題');}
 write(path.join(ft.dir,'topics',a.id,'.ai/memory.md'),'元話題のメモリ');chat.writeMeta(ft.ledger,a.id,{sessions:{codex:'old-session'}});
 const targets=l.topicTargets(a.id).filter(p=>p!==h.file(a.id));const settings=fs.readFileSync(path.join(ft.dir,'AGENTS.md'));const r=l.completeAutomatic(a.id);assert.equal(r.ok,true);
 for(const p of targets)assert.equal(fs.existsSync(p),false,p);
 for(const dir of ['handoff','memory','work'])assert.equal(fs.readFileSync(path.join(ft.ledger,'.ai',dir,b.id,'内容.md'),'utf8'),'他話題');
 assert.deepEqual(fs.readFileSync(path.join(ft.dir,'AGENTS.md')),settings);assert.equal(h.status(a.id).automaticCompleted,true);assert.deepEqual(chat.readMeta(store.readProject(r.project).dir,r.task).sessions,{});
});
test('ワンクリック：削除失敗は作成済みを保持、重複作成せず削除だけ再開',t=>{
 const f=fixture(t);automaticReady(f);const p=f.lifecycle.preview(f.a.id,{topicOnly:true});const created=f.lifecycle.promote(f.a.id,{...p,name:'作成済み',files:[],confirm:true,automatic:true});
 const before=tree(f.ft.ledger),rename=fs.renameSync;let injected=false;
 fs.renameSync=(from,to)=>{if(!injected && from===chat.files(f.ft.ledger,f.a.id).log){injected=true;throw Error('削除の移動失敗');}return rename(from,to);};
 try{assert.equal(f.lifecycle.completeAutomatic(f.a.id),null);}finally{fs.renameSync=rename;}
 assert.ok(f.store.taskFile('freetalk',f.a.id));assert.match(f.history.status(f.a.id).automaticError,/削除を完了できません/);assert.equal(f.lifecycle.completeAutomatic(f.a.id),null);
 assert.ok(before.filter(([p])=>p!==path.relative(f.ft.ledger,f.history.file(f.a.id))).every(([p,data])=>fs.readFileSync(path.join(f.ft.ledger,p)).toString('base64')===data));
 const state=f.history.state(f.a.id);f.history.save(f.a.id,{...state,migrated:{...state.migrated,cleanupError:undefined}});const r=f.lifecycle.completeAutomatic(f.a.id);
 assert.equal(r.project,created.project);assert.equal(r.operationId,created.operationId);assert.equal(f.history.status(f.a.id).automaticCompleted,true);assert.equal(f.store.listProjects().filter(p=>p.kind!=='freetalk').length,1);
});
test('ワンクリック：削除途中の中断は保存計画から再開、元話題のtaskがなくても二重作成しない',t=>{
 const f=fixture(t);automaticReady(f);const p=f.lifecycle.preview(f.a.id,{topicOnly:true});f.lifecycle.promote(f.a.id,{...p,name:'中断から再開',files:[],confirm:true,automatic:true});
 const state=f.history.state(f.a.id),trash=f.lifecycle.trash('topic '+f.a.id),planned=f.lifecycle.topicTargets(f.a.id).filter(from=>from!==f.history.file(f.a.id) && fs.existsSync(from)).map((from,i)=>({from,to:path.join(trash,String(i))}));
 f.history.save(f.a.id,{...state,migrated:{...state.migrated,cleanup:{trash,planned}}});fs.renameSync(planned[0].from,planned[0].to);
 assert.equal(f.store.taskFile('freetalk',f.a.id),null);assert.ok(f.lifecycle.automaticTasks().includes(f.a.id));assert.equal(f.history.status(f.a.id).promotionAutomatic,true);
 const restarted=new FreetalkLifecycle(f.history,()=>'',()=>new Date());const r=restarted.completeAutomatic(f.a.id);assert.equal(r.ok,true);assert.equal(f.history.status(f.a.id).automaticCompleted,true);assert.equal(f.store.listProjects().filter(p=>p.kind!=='freetalk').length,1);
});
test('ワンクリック：削除確定receiptの保存失敗を巻き戻し、同じ作成済みから削除だけ再開',t=>{
 const f=fixture(t);automaticReady(f);const p=f.lifecycle.preview(f.a.id,{topicOnly:true});f.lifecycle.promote(f.a.id,{...p,name:'receipt保存失敗',files:[],confirm:true,automatic:true});
 const save=f.history.save.bind(f.history);f.history.save=(task,state)=>{if(state.migrated?.automatic && !state.migrated.cleanupPending)throw Error('receipt確定保存に失敗');return save(task,state);};
 try{assert.equal(f.lifecycle.completeAutomatic(f.a.id),null);}finally{f.history.save=save;}
 assert.ok(f.store.taskFile('freetalk',f.a.id));assert.equal(f.history.status(f.a.id).automaticCompleted,false);assert.ok(chat.read(f.ft.ledger,f.a.id).length);
 const state=f.history.state(f.a.id);save(f.a.id,{...state,migrated:{...state.migrated,cleanupError:undefined}});assert.equal(f.lifecycle.completeAutomatic(f.a.id).ok,true);assert.equal(f.store.listProjects().filter(p=>p.kind!=='freetalk').length,1);
});
test('ワンクリック：開始後の添付追加を拒否し、エラーで止まった時は編集可能に戻る',t=>{
 const f=fixture(t);automaticReady(f);assert.throws(()=>f.ft.holdUpload(f.a.id,1),/移行中/);f.lifecycle.automaticError(f.a.id,'試験の失敗');const release=f.ft.holdUpload(f.a.id,1);release();
});
test('ワンクリック：不明な作成途中stageは別操作で重複作成せず停止',t=>{
 const f=fixture(t);automaticReady(f);const p=f.lifecycle.preview(f.a.id,{topicOnly:true});fs.mkdirSync(path.join(f.store.product,'.freetalk-'+p.operationId));
 assert.equal(f.lifecycle.completeAutomatic(f.a.id),null);assert.equal(f.history.state(f.a.id).summary.automatic.uncertain,true);assert.equal(f.store.listProjects().filter(p=>p.kind!=='freetalk').length,0);
});
