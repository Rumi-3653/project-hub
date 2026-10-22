'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {Store}=require('../../lib/store'),{Removal}=require('../../lib/remove'),{TaskTransfer}=require('../../lib/task-transfer'),{TaskIntegrate}=require('../../lib/task-integrate'),{IntegrateAuto}=require('../../lib/integrate-auto'),git=require('../../lib/git'),sibling=require('../../lib/integration-sibling'),chat=require('../../lib/chat');
const g=(d,...args)=>execFileSync('git',['-C',d,...args],{encoding:'utf8',stdio:'pipe'}).trim();
async function fixture(t){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-sibling-')),oldTrash=process.env.HUB_TRASH;process.env.HUB_TRASH=path.join(root,'Trash');
 t.after(()=>{if(oldTrash===undefined)delete process.env.HUB_TRASH;else process.env.HUB_TRASH=oldTrash;fs.rmSync(root,{recursive:true,force:true});});
 const dir=path.join(root,'Product','Fixture'),body=path.join(root,'Body'),write=(f,s)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,s);};
 write(path.join(dir,'PROJECT.md'),'---\nname: Fixture\n---\n');write(path.join(body,'base'),'base');g(body,'init','-q');g(body,'config','user.name','Fixture');g(body,'config','user.email','fixture@localhost');g(body,'add','.');g(body,'commit','-qm','base');
 const store=new Store(root),parent=store.createTask('Fixture',{title:'親',steps:['未済']}),removal=new Removal({store,trash:path.join(root,'Trash')}),transfer=new TaskTransfer({store,removal,baseOf:()=>body}),h=new TaskIntegrate({store,transfer,removal,baseOf:()=>body});
 const pw=git.prepare({base:body,workRoot:removal.workRoot({id:'Fixture'}),taskId:parent.id});store.updateTask('Fixture',parent.id,{workdir:pw.dir});
 const requests=[],closed=new Map();let mains=0;const auto=new IntegrateAuto({integrate:h,dispatch:async q=>{requests.push(q);return {delivery:{state:'accepted'}};},mergeMain:async()=>{mains++;throw Error('must not merge main');}});
 auto.pendingRequest=(r,k)=>!closed.has(k);auto.savedCompletion=(r,k)=>closed.get(k);
 function child(title,report=false){const c=store.createTask('Fixture',{title,parent:parent.id,steps:['確認残り']});const w=git.prepare({base:body,workRoot:removal.workRoot({id:'Fixture'}),taskId:c.id});store.updateTask('Fixture',c.id,{workdir:w.dir});write(path.join(w.dir,report?'成果物/'+c.id+'/report.md':'web-code.txt'),title);git.save(w.dir,'child');
  store.appendSection('Fixture',c.id,'成果',report?'- 本体保存済み：body:.@'+git.inspect(w.dir).head:'- なし：保存コード');store.appendSection('Fixture',c.id,'残件申告','```json\n'+JSON.stringify({status:'あり',items:'実機未確認',undecided:'なし',evidence:'合成検証'})+'\n```');chat.append(dir,c.id,{role:'assistant',text:'元の会話'});return store.readTask(store.taskFile('Fixture',c.id));}
 const oldChild=child('Web');let d=auto.preview({project:'Fixture',task:parent.id,simple:true});h.apply({project:'Fixture',task:parent.id,token:d.token,confirm:true,auto:true,thenMain:false,mode:'single',selected:[{project:'Fixture',task:oldChild.id,keep:true}]});await auto.tick();
 let old=h.read('Fixture',parent.id);assert.equal(old.items[0].state,'検証中',JSON.stringify(old.auto.stopped));const oldKey=Object.keys(old.auto.attempts)[0],req=requests[0];
 closed.set(oldKey,{request:req.requestKey,role:'assistant',text:'合格なし',integrationAuto:{key:oldKey,phase:'review',closed:true,isolation:{version:1,resumed:false,request:req.requestKey}}});old.auto.stopped={reason:'独立確認の合格を確認できません',at:'2026-10-19T20:35:16.600Z'};h.save(old);
 const original=fs.readFileSync(h.file('Fixture',parent.id)),offer=fs.readFileSync(transfer.file('Fixture',oldChild.id)),oldTask=fs.readFileSync(store.taskFile('Fixture',oldChild.id));
 const report=child('Windows報告',true),preview=()=>auto.preview({project:'Fixture',task:parent.id,simple:true,sibling:true});
 const start=(patch={})=>{const d=preview();return h.apply({project:'Fixture',task:parent.id,token:d.token,confirm:true,auto:true,thenMain:false,mode:'single',selected:[{project:'Fixture',task:report.id,keep:true}],...patch});};
 const lane=()=>sibling.read(h,'Fixture',parent.id),unchanged=()=>{assert.deepEqual(fs.readFileSync(h.file('Fixture',parent.id)),original);assert.deepEqual(fs.readFileSync(transfer.file('Fixture',oldChild.id)),offer);assert.deepEqual(fs.readFileSync(store.taskFile('Fixture',oldChild.id)),oldTask);assert.equal(mains,0);};
 return {root,dir,body,store,parent,removal,transfer,h,auto,requests,closed,old,oldChild,oldKey,report,preview,start,lane,unchanged,write,child,copy:pw.dir,original};
}
module.exports={fixture};
