'use strict';
// Actual UI script, synthetic DOM and backend. No live screen or receipt.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const file=require.resolve('./integration-abandon-ui.test'),source=fs.readFileSync(file,'utf8'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));m._compile(source.slice(0,source.indexOf("test('中止UI"))+'\nmodule.exports={ui};',file);
const child={project:'Fixture',task:'child',title:'Windows報告',keep:true,keepLocked:true,startable:true,descendants:[],reportScope:'報告4件だけを受け取ります。引継ぎメモ2件は子に残します'};
const lane={simple:true,sibling:true,project:'Fixture',task:'parent',token:'fresh',stoppedSibling:{id:'old',sha256:'fixed'},stoppedWarning:{items:[{title:'Web可能性'}],reason:'独立確認未合格'},items:[child]};
test('sibling UI keeps old stop visible, exposes explicit report action, preserves main unknown warning',async()=>{
 const screen=m.exports.ui(async()=>({simple:true,items:[],auto:{stopped:{reason:'旧停止'}},siblingOption:{allowed:true,message:'旧記録を残す'}}));await screen.show('Fixture');assert.match(screen.el('#integrate-sheet').innerHTML,/別の子の報告を受け取る/);
 screen.run('integratePreview='+JSON.stringify({...lane,mainPending:{id:'unknown',main:{state:'intent'},stopped:{reason:'本体未確認'}}})+';drawSimpleIntegration()');const html=screen.el('#integrate-sheet').innerHTML;for(const text of ['Web可能性','独立確認未合格','報告を受け取る','本体取り込みの結果が不明','以前の停止記録を見る','報告4件だけを受け取ります。引継ぎメモ2件は子に残します'])assert.ok(html.includes(text));assert.ok(!html.includes('data-integrate-action="batch"'));assert.ok(!html.includes('data-integrate-action="selected"'));
});
test('sibling UI submits one kept report with thenMain false and ignores batch',async()=>{
 const calls=[],screen=m.exports.ui(async(route,b)=>{calls.push({route,b});return {partial:true};});screen.run('globalThis.load=async()=>{};globalThis.render=()=>{};globalThis.toast=()=>{};integratePreview='+JSON.stringify(lane));await screen.run('startSimpleIntegration("batch",0)');assert.equal(calls.length,0);await screen.run('startSimpleIntegration("single",0)');assert.equal(calls.length,1);assert.equal(calls[0].b.thenMain,false);assert.equal(calls[0].b.selected.length,1);assert.equal(calls[0].b.selected[0].keep,true);assert.equal(calls[0].b.token,'fresh');
});
test('sibling refresh and wait retain lane identity; old primary uncertainty remains separate',async()=>{
 const calls=[],screen=m.exports.ui(async(route,b)=>{calls.push({route,b});return route.includes('/wait?')?{waiting:[]}:lane;});await screen.run('showTaskIntegration("Fixture","parent",undefined,false,true)');assert.equal(calls[0].b.sibling,true);await screen.run('integrationCheckLatest()');assert.equal(calls[1].b.sibling,true);
 screen.run('integratePreview.id="lane-id";integratePreview.waiting=[{message:"busy"}]');await screen.run('integrationCheckWait()');assert.match(calls[2].route,/id=lane-id&sibling=true/);assert.equal(calls[3].b.sibling,true);assert.notEqual(screen.run('integrationStartKey(integratePreview)'),screen.run('integrationStartKey({...integratePreview,sibling:false,stoppedSibling:null})'));
});
