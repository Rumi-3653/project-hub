'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),create=require('../lib/routes/chat-note');
function fixture(){
 const calls=[],value={project:{id:'p',dir:'/ledger'},file:'task.md',failure:null},row={id:'row'};
 const route=create({send:(res,status,body)=>{calls.push(['send',status]);return {status,body};},lt:s=>s,store:{readProject:id=>{calls.push(['project',id]);return value.project;},taskFile:(...args)=>{calls.push(['file',...args]);return value.file;}},freetalk:{nameTopic:(...args)=>calls.push(['name',...args])},chat:{append:(...args)=>{calls.push(['append',...args]);if(value.failure)throw value.failure;return row;}},chats:{emit:(...args)=>calls.push(['emit',...args])}}).write;
 assert.deepEqual(calls,[]);return {calls,value,row,route,run:b=>route.handle({method:'POST'}, {},new URL('/api/chat/note','http://localhost'),{project:'p',task:'t',...b})};
}
test('note route matches only the exact path',()=>{const f=fixture();assert.equal(f.route.matches({},new URL('/api/chat/note','http://localhost')),true);assert.equal(f.route.matches({},new URL('/api/chat/note/','http://localhost')),false);assert.equal(f.route.matches({},new URL('/api/chat/send','http://localhost')),false);});
test('invalid notes and missing tasks do not append, emit or name a topic',()=>{
 const f=fixture();for(const text of [null,3,'','  ','x'.repeat(8001)]){f.calls.length=0;assert.equal(f.run({text}).status,400);assert.deepEqual(f.calls.map(x=>x[0]),['project','file','send']);}
 f.value.project=null;f.calls.length=0;assert.equal(f.run({text:'note'}).status,400);assert.deepEqual(f.calls.map(x=>x[0]),['project','send']);
});
test('notes are trimmed and durably appended before broadcasting the same row without starting an AI',()=>{
 const f=fixture();assert.deepEqual(f.run({text:' \nメモ\n ',to:'z'.repeat(25)}),{status:200,body:{ok:true}});assert.deepEqual(f.calls.find(x=>x[0]==='append'),['append','/ledger','t',{role:'user',text:'メモ',to:'z'.repeat(20)}]);assert.deepEqual(f.calls.find(x=>x[0]==='emit'),['emit','p','t',{type:'row',row:f.row}]);assert.deepEqual(f.calls.map(x=>x[0]),['project','file','append','emit','send']);
});
test('only a freetalk note names its topic, before appending; the 8000-character boundary remains valid',()=>{
 const f=fixture();f.value.project={id:'freetalk',dir:'/topic',kind:'freetalk'};assert.equal(f.run({text:'x'.repeat(8000)}).status,200);assert.deepEqual(f.calls.map(x=>x[0]),['project','file','name','append','emit','send']);assert.equal(f.calls.find(x=>x[0]==='append')[3].to,'');
});
test('append failures propagate without emitting a row or a successful response',()=>{
 const f=fixture();f.value.failure=Error('save failed');assert.throws(()=>f.run({text:'note'}),/save failed/);assert.deepEqual(f.calls.map(x=>x[0]),['project','file','append']);
});
