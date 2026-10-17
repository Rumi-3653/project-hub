'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{execFileSync}=require('node:child_process'),{createHash}=require('node:crypto');
const results=require('../lib/integration-review-results'),review=require('../lib/integration-review');
const hash=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const insufficient='要修正（確認資料不足）です。\n\n成果の整合は確認できました。\nただし、依頼の「日繁履歴」は照合できません。保存差分のhistory欄は空で、繁體中文の履歴と保存範囲を確認できる証跡がありません。該当原物の提示、または対象外とする範囲の明記が必要です。';
function fixture(t,bilingual=false){
 const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-review-scope-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));require('../lib/integration-writes').register(dir);
 const g=(...a)=>execFileSync('git',['-C',dir,...a],{encoding:'utf8',stdio:'pipe'}).trim();g('init','-q');g('config','user.name','Fixture');g('config','user.email','fixture@localhost');
 const task='20261013-01',parent='20261013-02',file=id=>path.join(dir,'.ai/tasks/'+id+'.md');
 fs.mkdirSync(path.join(dir,'.ai/tasks'),{recursive:true});fs.mkdirSync(path.join(dir,'.ai/work'));fs.writeFileSync(file(task),'---\nparent: '+parent+'\n---\n## 成果\n保存済み\n');fs.writeFileSync(file(parent),'## 手順\n- [ ] 実機未確認\n');
 fs.writeFileSync(path.join(dir,'PROJECT.md'),'# プロジェクト\n日本語Macアプリ\n');fs.writeFileSync(path.join(dir,'.ai/rules.md'),'# 規則\n資料が足りなければ停止\n'+(bilingual?'日本語・繁體中文の版と履歴が必要\n':''));
 fs.writeFileSync(path.join(dir,'saved.txt'),'saved behavior');fs.writeFileSync(path.join(dir,'.ai/work/'+task+'-core.log'),'# pass 1\n# fail 0\n');
 if(bilingual)fs.writeFileSync(path.join(dir,'README.zh-TW.md'),'# 繁體中文履歷\nfixture繁體中文履歴1\n');
 g('add','.');g('commit','-qm','saved behavior');const head=g('rev-parse','HEAD'),i={project:'Fixture',task,source:null,files:[{path:path.join(dir,'saved.txt')}],results:[{kind:'本体保存済み',dir,commit:head}]},h={store:{readProject:()=>({dir}),taskFile:(p,id)=>fs.existsSync(file(id))?file(id):null}},r={project:'Fixture',task:parent,target:dir};
 const k='b'.repeat(64),a={project:i.project,task,targetHead:head,reviewHead:head,isolatedReview:true,delivery:{state:'accepted',request:'old-scope-request'},evidenceRecovery:{oldEvidence:{},completionHash:'prior'},savedResults:results.collect(h,r,i),request:{text:'やる：双方の機能・日繁履歴と保存済み範囲、関連試験の意味と成功を照合する。'}};
 const old=review.prepare({dir,pdir:dir,task:parent,key:k,targetHead:head,reviewHead:head,savedResults:a.savedResults}),row={text:insufficient,integrationAuto:{key:k,phase:'review',closed:true,isolation:{version:1,request:a.delivery.request,resumed:false,session:'fresh-old-session'}}};
 return {dir,g,i,h,r,k,a,row,old,head};
}
test('D4 原文の全行SHA/範囲と実保存履歴を固定し、言語を自動で対象外にしない',t=>{
 const f=fixture(t),e=results.collect(f.h,f.r,f.i,{scoped:true});assert.equal(e.version,2);assert.ok(e.scope.originals.some(x=>x.kind==='project'&&x.languageReferences[0].line===2));assert.equal(e.scope.originals.filter(x=>x.kind==='task').length,2);assert.match(e.scope.histories[0].text,/saved behavior/);assert.equal('bilingualRequired' in e.scope,false);assert.match(e.scope.policy,/no automatic exemption/);results.verify(e,f.h,f.r,f.i);
 fs.appendFileSync(path.join(f.dir,'.ai/rules.md'),'\n'+Array.from({length:300},(_,n)=>'rule '+n).join('\n')+'\n繁體中文も必要\n');const long=results.collect(f.h,f.r,f.i,{scoped:true});const rules=long.scope.originals.find(x=>x.kind==='project-rules');assert.equal(rules.ranges[0].end,rules.lineCount);assert.match(results.render(long),/繁體中文も必要/);
});
test('D4 実際の日繁要件と既存繁体字文書は成果manifest外でも原文で渡す',t=>{const f=fixture(t,true),e=results.collect(f.h,f.r,f.i,{scoped:true});assert.ok(e.scope.originals.some(x=>x.path.endsWith('README.zh-TW.md')));assert.match(results.render(e),/日本語・繁體中文の版と履歴が必要/);assert.match(results.render(e),/fixture繁體中文履歴1/);});
for(const mode of ['project','rules','parent','task-rule-add','document','missing-project','missing-parent','symlink'])test('D4 範囲原文の変更/不足/リンクを照合で拒否 '+mode,t=>{
 const f=fixture(t,true),e=results.collect(f.h,f.r,f.i,{scoped:true}),p=path.join(f.dir,'PROJECT.md');
 if(mode==='missing-project')fs.unlinkSync(p);else if(mode==='missing-parent')fs.unlinkSync(path.join(f.dir,'.ai/tasks/'+f.r.task+'.md'));else if(mode==='symlink'){fs.unlinkSync(p);fs.symlinkSync(path.join(f.dir,'saved.txt'),p);}else if(mode==='task-rule-add'){fs.mkdirSync(path.join(f.dir,'.ai/chat'),{recursive:true});fs.writeFileSync(path.join(f.dir,'.ai/chat/'+f.i.task+'.rules.md'),'新しい範囲');}else fs.appendFileSync(mode==='project'?p:mode==='rules'?path.join(f.dir,'.ai/rules.md'):mode==='parent'?path.join(f.dir,'.ai/tasks/'+f.r.task+'.md'):path.join(f.dir,'README.zh-TW.md'),'changed');
 assert.throws(()=>results.verify(e,f.h,f.r,f.i));
});
test('D4 旧日繁資料不足だけ新資料への正式補足証拠を作り、旧v1/TXTを保持',t=>{
 const f=fixture(t),before=fs.readFileSync(f.old.file),proof=results.recovery(f.h,f.r,f.i,f.a,f.k,f.row);assert.equal(proof.scopeRecovery,true);assert.equal(proof.savedResults.version,2);assert.notEqual(proof.savedResults.sha256,f.a.savedResults.sha256);results.verifyScopeRecovery(proof,f.a,f.row);assert.deepEqual(fs.readFileSync(f.old.file),before);results.verify(f.a.savedResults,f.h,f.r,f.i);
 assert.throws(()=>results.verifyScopeRecovery(proof,{...f.a,delivery:{...f.a.delivery,request:'other'}},f.row));assert.throws(()=>results.verifyScopeRecovery(proof,f.a,{...f.row,text:'late changed reply'}));
});
for(const mode of ['true-fail','unknown','open','no-fresh','wrong-request','missing-history-reason','new-scope-already','same-scope-retry','old-text-changed','old-request-changed','extra-finding'])test('D4 一般非合格/不明/未終了/同資料再試行は補足を許可しない '+mode,t=>{
 const f=fixture(t),a=structuredClone(f.a),row=structuredClone(f.row);
 if(mode==='true-fail')row.text+='\n製品不良があります。';else if(mode==='unknown')a.delivery.state='unknown';else if(mode==='open')row.integrationAuto.closed=false;else if(mode==='no-fresh')row.integrationAuto.isolation.resumed=true;else if(mode==='wrong-request')row.integrationAuto.isolation.request='other';else if(mode==='missing-history-reason')row.text='要修正（確認資料不足）。';else if(mode==='new-scope-already')a.savedResults=results.collect(f.h,f.r,f.i,{scoped:true});else if(mode==='same-scope-retry')a.scopeRecovery={};else if(mode==='extra-finding')row.text+='\n別の整合性問題を確認したので修正が必要です。';else if(mode==='old-text-changed')fs.appendFileSync(f.old.file,'changed');else a.request.text='勝手な対象外';
 assert.equal(results.recovery(f.h,f.r,f.i,a,f.k,row),null);
});

test('D4 実closed原文の進捗3段落を含む資料不足だけ補足可能',t=>{const f=fixture(t);f.row.text="保存差分と試験原物を読み、機能・日繁履歴・保存範囲を照合して判定します。編集や試験の再実行は行いません。\n\n保存差分原物のSHA-256は指定値と一致しました。integration・child・resolution・history欄は空ですが、保存成果・3件のcommit・試験原物は含まれているため、その一式を確認しています。\n\nmanifestの68ファイルと、保存commit 3件の差分は原物に一致しています。試験ログは同時稼働・削除・失敗復旧のローカル検査成功を示しています。後続の受信箱改修も存在するため、今回の1.4.0成果の保存範囲と、日繁履歴の確認根拠を分けて照合します。\n\n"+'要修正（確認資料不足）です。\n\n保存commit 3件、manifest 68ファイル、試験原物61件の整合は確認できました。同時稼働・削除・失敗復旧のローカル試験も成功しています。\n\nただし、依頼の「日繁履歴」は照合できません。保存差分のhistory欄は空で、繁體中文の履歴と保存範囲を確認できる証跡がありません。該当原物の提示、または対象外とする範囲の明記が必要です。';assert.equal(results.recovery(f.h,f.r,f.i,f.a,f.k,f.row).scopeRecovery,true);f.row.text='製品不良があります。\n'+f.row.text;assert.equal(results.recovery(f.h,f.r,f.i,f.a,f.k,f.row),null);});
