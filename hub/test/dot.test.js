'use strict';
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Chatgpt } = require('../lib/chatgpt'), { Store } = require('../lib/store'), chat = require('../lib/chat');
const P = 'サンプルアプリ', T = 'sample-app-01';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-dot-'));
  for (const id of [P, '別プロジェクト']) fs.cpSync(path.join(__dirname, '../seed', P), path.join(root, 'Product', id), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root), rows = [], events = [];
  const deps = { file: path.join(root, '_hub/chatgpt.json'), store, chat, baseOf: () => '', emitRow: (...args) => rows.push(args), ended: (...args) => events.push(args), record() {} };
  return { root, store, deps, gpt: new Chatgpt(deps), rows, events, log: (p = P) => chat.read(store.readProject(p).dir, T), file: store.taskFile(P, T) };
}
test('Dot道具は公開せず、旧依頼の報告も原物を変えず拒否する', async t => {
  const f=fixture(t),p=f.store.readProject(P);
  chat.append(p.dir,T,{role:'user',to:'dot',request:'old-dot',text:'旧依頼'});
  const before=fs.readFileSync(f.file), rows=JSON.stringify(f.log());
  assert.equal(f.gpt.requestDot,undefined); assert.equal(f.gpt.dotInbox,undefined);
  assert.equal(f.gpt.tools().some(x=>x.name==='hub_dot_inbox'),false);
  await assert.rejects(f.gpt.call('hub_dot_inbox'),e=>e.status===404);
  await assert.rejects(f.gpt.call('hub_report',{project:P,task:T,request:'old-dot',text:'再送',done:true}),e=>e.status===404);
  assert.deepEqual(fs.readFileSync(f.file),before);assert.equal(JSON.stringify(f.log()),rows);assert.equal(f.events.length,0);
  await f.gpt.call('hub_report',{project:P,task:T,text:'通常MCP報告'});
  assert.equal(f.log().at(-1).ai,'chatgpt');
});
test('イベント署名鍵と認可設定をファイル読取/書込道具へ返さない（別名リンクも拒否）',async t=>{
  const f=fixture(t),p=f.store.readProject(P);
  const g=new Chatgpt({...f.deps,baseOf:()=>p.dir});g.save({work:true});
  for(const name of ['mcp-events.json','mcp-events.auth.json']){
    fs.writeFileSync(path.join(p.dir,name),'fixture secret');
    const alias=path.join(p.dir,'alias-'+name);fs.symlinkSync(path.join(p.dir,name),alias);
    for(const file of [name,path.basename(alias)]){
      await assert.rejects(g.call('hub_read_file',{project:P,path:file}),/秘密/);
      await assert.rejects(g.call('hub_write_file',{project:P,path:file,text:'overwrite'}),/秘密/);
    }
    assert.equal(fs.readFileSync(path.join(p.dir,name),'utf8'),'fixture secret');
  }
});
