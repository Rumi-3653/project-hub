'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const src=require('./fixtures/app-source.cjs').readApp();
const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function fixture(){let click;const ctx=vm.createContext({esc,linkify:t=>`PLAIN:${esc(t)}`,document:{addEventListener:(k,cb)=>click=cb},setTimeout(){},copyText:async()=>true});vm.runInContext(src.slice(src.indexOf('// 囲みの中はリンク'),src.indexOf('// コピーできたか')),ctx);return {ctx,click};}
const bodies = html => [...html.matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)].map(m => m[1]
 .replaceAll('&#13;', '\r').replaceAll('&quot;', '"').replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&'));
test('引用は説明を除き、1段だけ外した原文を1ボタンでコピーする', async()=>{
 const f=fixture(),value='　本文 **強調** [リンク](https://example.com/?a=1&b=2) <script>"x"</script>\n> 内側\n>さらに内側\n\n  空白を残す\r\n';
 const out=f.ctx.richText('送り先の説明\n> 　本文 **強調** [リンク](https://example.com/?a=1&b=2) <script>"x"</script>\n> > 内側\n>>さらに内側\n>\n>   空白を残す\r\n枠外の説明');
 assert.deepEqual(bodies(out),[value]);assert.equal((out.match(/class="cb-copy quote-copy"/g)||[]).length,1);
 assert.match(out,/⧉ 引用をコピー/);assert.doesNotMatch(out,/<script>|<strong>|data-url=|data-path=/);
 let copied;f.ctx.copyText=async x=>{copied=x;return true;};
 await f.click({target:{closest:()=>({disabled:false,classList:{contains:()=>true},closest:()=>({querySelector:()=>({textContent:bodies(out)[0]})})})}});
 assert.equal(copied,value);
});
test('複数の引用・空行・入れ子・改行なし末尾は別の本文として保持する',()=>{
 const f=fixture(),out=f.ctx.richText('前\n> 一\n>\n> 二\n\n間\n> 三\n普通の文\n>末尾');
 assert.deepEqual(bodies(out),['一\n\n二\n','三\n','末尾']);assert.equal((out.match(/quote-copy/g)||[]).length,3);
 assert.deepEqual(bodies(f.ctx.richText('>\n>>> 入れ子\n>\tタブ\n>  空白')),['\n>> 入れ子\n\tタブ\n 空白']);
});
test('生成中の引用にボタンを出さず、完了後だけコピーできる',()=>{
 const f=fixture(),value='> 途中\n> 続';
 assert.match(f.ctx.richText(value,true),/書きかけ/);assert.doesNotMatch(f.ctx.richText(value,true),/cb-copy/);
 assert.match(f.ctx.richText(value),/quote-copy/);assert.deepEqual(bodies(f.ctx.richText(value,true)),bodies(f.ctx.richText(value)));
});
test('引用コピーの失敗を成功と表示せず、再操作のラベルを復元する',async()=>{
 const f=fixture();let reset;f.ctx.setTimeout=cb=>reset=cb;f.ctx.copyText=async()=>false;
 const b={disabled:false,textContent:'',classList:{contains:()=>true},closest:()=>({querySelector:()=>({textContent:'本文'})})};
 await f.click({target:{closest:()=>b}});assert.match(b.textContent,/コピーできませんでした/);assert.doesNotMatch(b.textContent,/コピーしました/);
 reset();assert.equal(b.textContent,'⧉ 引用をコピー');assert.equal(b.disabled,false);
});
test('普通の段落と箇条書きは送信文と判定せず、コード枠内の引用記号は外さない',()=>{
 const f=fixture(),plain='送り先：AI\n本文です a > b\n- > 項目\n1. 本文\n    > インデントの本文';
 assert.doesNotMatch(f.ctx.richText(plain),/cb-copy|quote-block/);
 const out=f.ctx.richText('> 引用\n```text\n> コード内\n>> 内側\n```\n> 次の引用');
 assert.deepEqual(bodies(out),['引用\n','> コード内\n>> 内側\n','次の引用']);
 assert.equal((out.match(/quote-copy/g)||[]).length,2);assert.equal((out.match(/class="cb-copy"/g)||[]).length,1);
});
test('fences preserve exact whitespace, multiline Japanese, HTML and path text without links',()=>{
 const f=fixture(),value='　全角  spaces\n<script>"x"</script>\n/Users/a/file.md\n';const out=f.ctx.richText('before\n```text\n'+value+'```\nafter');assert.ok(out.includes('<code>'+esc(value)+'</code>'));assert.doesNotMatch(out,/<script>|data-path=/);assert.match(out,/cb-copy/);assert.match(out,/PLAIN:before/);assert.match(out,/PLAIN:after/);
});
test('multiple/no-language/long fences and incomplete stream fences are distinct',()=>{
 const f=fixture();const out=f.ctx.richText('```\none\n```\n````bash\ntwo\n```\n````\n');assert.equal((out.match(/class="codeblock"/g)||[]).length,2);assert.match(out,/>テキスト</);assert.match(out,/>bash</);assert.match(out,/two\n```\n<\/code>/);
 const partial=f.ctx.richText('```text\nnot yet');assert.match(partial,/書きかけ/);assert.doesNotMatch(partial,/cb-copy/);assert.match(partial,/not yet/);
});
test('copy click passes exact code text, and only success shows success state',async()=>{
 const f=fixture(),text='　h\n"quotes"\n';let copied;
 const b={disabled:false,textContent:'',closest:()=>({querySelector:()=>({textContent:text})})};f.ctx.copyText=async x=>{copied=x;return true;};await f.click({target:{closest:()=>b}});assert.equal(copied,text);assert.equal(b.textContent,'✓ コピーしました');b.disabled=false;f.ctx.copyText=async()=>false;await f.click({target:{closest:()=>b}});assert.doesNotMatch(b.textContent,/コピーしました/);assert.match(b.textContent,/できません/);
});

test('paths and URLs outside fences retain normal links, with no links inside',()=>{
 const c=vm.createContext({esc,document:{addEventListener(){}},setTimeout(){}});
 const start=src.indexOf('const LINK_RE');vm.runInContext(src.slice(start,src.indexOf('// コピーできたか',start)),c);
 const out=c.richText('/Users/example/source.md https://example.com/page\n```text\n/Users/example/source.md\n```');
 assert.match(out,/data-path=/);assert.match(out,/data-url=/);assert.doesNotMatch(out.match(/<code>([\s\S]*?)<\/code>/)[1],/data-path=|data-url=/);
});

test('CRLF in a fenced block is preserved as a character reference through HTML parsing',()=>{assert.match(fixture().ctx.richText('```text\r\nline\r\n```'),/<code>line&#13;\n<\/code>/);});

function linkedFixture(){
 const ctx=vm.createContext({window:{HubChatHistory:require('../public/chat-history')},esc,fileViewUrl:p=>'/api/file/view?path='+encodeURIComponent(p),document:{addEventListener(){}},setTimeout(){}});
 const start=src.indexOf('const LINK_RE');vm.runInContext(src.slice(start,src.indexOf('// コピーできたか',start)),ctx);return ctx;
}
test('ローカルMarkdown画像を会話と表に表示し、コード枠内の原文は保持',()=>{
 const ctx=linkedFixture(),image='![390pxでの画像](</Users/test/空 白/画像.png>)';
 for(const html of [ctx.linkify(image),ctx.richText(image),ctx.richText('| 画像 |\n|---|\n| '+image+' |')]) {
  assert.match(html,/data-path="\/Users\/test\/空 白\/画像.png"/);assert.match(html,/>390pxでの画像<\/span><\/a>/);
  assert.doesNotMatch(html,/!<a/);assert.match(html,/<img src="\/api\/file\/view\?path=/);
 }
 assert.equal(ctx.linkify('普通の ! は残す'),'普通の ! は残す');
 assert.match(ctx.richText('```text\n'+image+'\n```'),/!\[390pxでの画像\]/);
});
test('tables render semantic headers, alignment and padded short rows',()=>{
 const text='前\n| 名前 | 比較 | 数 |\n| :--- | :--: | ---: |\n| 一 | 二 | 12 |\n| 三 |\n\n後';
 const out=linkedFixture().richText(text);
 assert.match(out,/前\n<div class="rt-table-wrap"/);assert.match(out,/<th scope="col" class="rt-left">名前<\/th>/);
 assert.match(out,/<th scope="col" class="rt-center">比較<\/th>/);assert.match(out,/<td class="rt-right">12<\/td>/);
 assert.match(out,/<tr><td class="rt-left">三<\/td><td class="rt-center"><\/td><td class="rt-right"><\/td><\/tr>/);
 assert.match(out,/<\/table><\/div>\n後$/);assert.equal((out.match(/<tr>/g)||[]).length,3);
});
test('outer pipes are optional and a one-column table is supported',()=>{
 const ctx=linkedFixture();assert.match(ctx.richText('名前 | 値\n--- | ---\n一 | 二'),/<td class="rt-left">二<\/td>/);
 assert.match(ctx.richText('| 見出し |\n| --- |\n| 本文 |'),/<td class="rt-left">本文<\/td>/);
});
test('escaped pipes remain text and even backslashes still delimit cells',()=>{
 const out=linkedFixture().richText('| A\\|B | C |\n| --- | --- |\n| x\\|y | z |\n| end\\\\|next |');
 assert.match(out,/>A\|B<\/th>/);assert.match(out,/>x\|y<\/td>/);
 assert.match(out,/>end\\\\<\/td><td class="rt-left">next<\/td>/);
 assert.doesNotMatch(out,/A\\\|B|x\\\|y/);
});
test('malformed or missing separators and escaped-only pipes retain the original text',()=>{
 const ctx=linkedFixture();
 for(const value of ['| A | B |\n| text | text |','A | B\n--- | invalid','A | B\n--- | --- | ---','A | B\n---','A | B\n- | -','A\\|B\n---\\|---','|\n|---|']) {
  assert.equal(ctx.richText(value),ctx.linkify(value));
 }
});
test('overflow columns are preserved as plain text instead of losing data',()=>{
 const out=linkedFixture().richText('A | B\n--- | ---\none | two | extra\nafter');
 assert.match(out,/<tbody><\/tbody><\/table><\/div>one \| two \| extra\nafter$/);
});
test('tables stop at blank or non-pipe lines and multiple tables stay separate',()=>{
 const out=linkedFixture().richText('A | B\n--- | ---\none | two\n通常の文\nC | D\n--- | ---\nthree | four\n\n終わり');
 assert.equal((out.match(/<table /g)||[]).length,2);assert.match(out,/<\/table><\/div>通常の文\n<div/);assert.match(out,/<\/table><\/div>\n終わり$/);
});
test('table cells support bold, inline code, existing links and path actions safely',()=>{
 const value='| **名前** | `値` |\n|---|---|\n| **[資料](</Users/a/My File.md:12>)** | `a < b` |\n| [Web](<https://example.com/a_(b)>) | `/Users/a/file.md` |\n| **`bold code`** | `https://example.com` |';
 const out=linkedFixture().richText(value);
 assert.match(out,/<strong>名前<\/strong>/);assert.match(out,/<code class="rt-inline">値<\/code>/);
 assert.match(out,/<strong><a[^>]*data-path="\/Users\/a\/My File.md:12"[^>]*>資料<\/a><\/strong>/);
 assert.match(out,/<code class="rt-inline">a &lt; b<\/code>/);assert.match(out,/data-url="https:\/\/example.com\/a_\(b\)"/);
 assert.match(out,/<code class="rt-inline"><a[^>]*data-path="\/Users\/a\/file.md"/);
 assert.match(out,/<strong><code class="rt-inline">bold code<\/code><\/strong>/);assert.match(out,/class="cp" data-copy="https:\/\/example.com"/);
});
test('HTML and attribute injection are escaped in all table cell formatting',()=>{
 const out=linkedFixture().richText('| <img src=x onerror=evil()> | **<script>evil()</script>** |\n|---|---|\n| `<svg onload=evil()>` | [<b>](https://example.com/?q=%22) |');
 assert.doesNotMatch(out,/<img|<script|<svg|<b>/);assert.match(out,/&lt;img/);assert.match(out,/<strong>&lt;script&gt;evil\(\)&lt;\/script&gt;<\/strong>/);
 assert.match(out,/<code class="rt-inline">&lt;svg/);assert.match(out,/>\&lt;b\&gt;<\/a>/);
});
test('table-like text inside complete and streaming fences stays exact code',()=>{
 const ctx=linkedFixture(),table='| A | B |\n|---|---|\n| **x** | `y` |\n';
 for(const end of ['```','']) {
  const out=ctx.richText('```text\n'+table+end);assert.doesNotMatch(out,/<table|<strong>|rt-inline/);assert.match(out,/<code>\| A \| B \|/);assert.ok(out.includes(esc(table)));
 }
 const mixed=ctx.richText(table+'```text\n'+table+'```\n'+table);assert.equal((mixed.match(/<table /g)||[]).length,2);assert.equal((mixed.match(/class="codeblock"/g)||[]).length,1);
});
test('streaming tables render immediately after a valid separator and keep the source untouched',()=>{
 const ctx=linkedFixture(),head='| A | B |\n';assert.doesNotMatch(ctx.richText(head),/<table/);
 assert.doesNotMatch(ctx.richText(head+'|---|-'),/<table/);
 const base=head+'|---|---|';assert.match(ctx.richText(base),/<thead>.*<\/thead><tbody><\/tbody>/);
 assert.match(ctx.richText(base+'\n| first'),/<td class="rt-left">first<\/td><td class="rt-left"><\/td>/);
 const source=base+'\n| **done** | `code` |';assert.match(ctx.richText(source),/<strong>done<\/strong>/);
 ctx.AI_ICON={codex:'C'};ctx.AI_LABEL={codex:'Codex'};
 vm.runInContext(src.slice(src.indexOf('function msgHtml(r)'),src.indexOf('// 質問ごとに選択')),ctx);
 const row={role:'assistant',ai:'codex',text:source},message=ctx.msgHtml(row);
 assert.match(message,/<table /);assert.ok(message.includes(`class="cp cp-msg" data-copy="${esc(source)}"`));assert.equal(row.text,source);
});
test('CRLF table input and plain text around it render without changing fenced CRLF',()=>{
 const out=linkedFixture().richText('前\r\nA | B\r\n--- | ---\r\none | two\r\n\r\n後');
 assert.match(out,/^前\r\n<div/);assert.match(out,/>two<\/td>/);assert.match(out,/<\/div>\r\n後$/);
});
