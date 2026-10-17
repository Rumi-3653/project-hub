'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
// An explicit inventory, not a blanket .ai exclusion. Every added/changed fs
// mutation (including references/aliases) requires a reviewed destination reason.
const readOnly=new Set(['accessSync','constants','closeSync','existsSync','fstatSync','fsyncSync','lstatSync','readdirSync','readFileSync','readSync','readlinkSync','realpathSync','statSync','access','close','lstat','readFile','readdir','readlink','realpath','stat']);
function sites(source){return source.split('\n').filter(line=>/require\(['"](?:node:)?fs(?:\/promises)?['"]\)/.test(line)||/\bfs\s*\[/.test(line)||[...line.matchAll(/\bfs\.([A-Za-z_$][\w$]*)/g)].some(m=>!readOnly.has(m[1]))).map(line=>crypto.createHash('sha256').update(line.trim()).digest('hex'));}
const dir=path.join(__dirname,'../lib'),inventory=require('./fixtures/integration-write-audit.json');
function verify(name,source){const expected=inventory[name];assert.ok(expected?.reason,'Unreviewed filesystem writer: '+name);assert.deepEqual(sites(source),expected.sites,'Filesystem writer changed; verify provenance or document exact non-ledger destination: '+name);}
test('P3 全libの書込みは証拠経由か理由付きの既存例外だけ',()=>{for(const name of fs.readdirSync(dir).filter(n=>n.endsWith('.js'))){const source=fs.readFileSync(path.join(dir,name),'utf8');if(sites(source).length)verify(name,source);}});
test('P3 既存・新規moduleの生台帳書込み・alias・promisesを検出',()=>{const source=fs.readFileSync(path.join(dir,'store.js'),'utf8');for(const addition of ["fs.writeFileSync('.ai/chat/task.jsonl','unproven');","const write=fs.appendFileSync;","fs.promises.writeFile('PROJECT.md','unproven');","fs['writeFileSync']('PROJECT.md','unproven');","const {writeFileSync:w}=require('node:fs');"]){assert.throws(()=>verify('store.js',source+'\n'+addition));assert.throws(()=>verify('new-writer.js',addition));}});
module.exports={sites};
