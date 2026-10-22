'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {parseDoc,parseYaml,setScalar}=require('../lib/frontmatter');

test('frontmatter preserves the complete body with LF, CRLF, missing newline and Unicode',()=>{
  const body='## 手順\r\n- [ ] 原文😀\n\ud800\udc00\ud800\udc00\ud800\n---\n終端\r\n';
  for(const eol of ['\n','\r\n'])for(const closing of ['', '\n', '\r\n', '\r']){
    const text='---'+eol+'id: sample'+eol+'title: "# heading"'+eol+'---'+closing+body;
    assert.deepEqual(parseDoc(text),{data:{id:'sample',title:'# heading'},body});
    const updated=setScalar(text,'title','Updated');assert.equal(parseDoc(updated).body,body);assert.equal(parseDoc(updated).data.title,'Updated');
  }
  for(const text of ['plain\n','---\n','---\n---\n',' ---\nid: a\n---\n','---\rid: a\r---\n'])assert.deepEqual(parseDoc(text),{data:{},body:text});
  const large=body.repeat(12000),text='---\nid: large\n---\n'+large;
  assert.deepEqual(parseDoc(text),{data:{id:'large'},body:large});
});

test('frontmatter matches the previous document contract across delimiter edge cases',()=>{
  // Reference contract includes historical adjacent/partial closing delimiters.
  const previous=text=>{const m=text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);return m?{data:parseYaml(m[1]),body:m[2]}:{data:{},body:text};};
  const opens=['','---\n','---\r\n','---\r',' ---\n'];
  const headers=['','\n','id: x','id: x\n','id: x\r\n','---','skills:\n  - one\n# comment'];
  const closes=['','---','\n---','\r\n---','\n----','\n---\r','\n---\n','\n---\r\n'];
  const bodies=['','\n','body\n','\r\n','😀\ud800\udc00\ud800\u2028\u2029','\n---\nid: second\n---\n'];
  for(const a of opens)for(const b of headers)for(const c of closes)for(const d of bodies){const text=a+b+c+d;assert.deepEqual(parseDoc(text),previous(text));}
});
