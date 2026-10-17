'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{checkVersion}=require('../lib/version-check');
const read=file=>fs.readFileSync(path.join(__dirname,'../..',file),'utf8');
test('固定前の版・日本語の変更履歴を出力副作用なしで検査する',()=>{const result=checkVersion(read);assert.equal(result.ok,true,result.error);assert.equal(result.version,JSON.parse(read('hub/package.json')).version);assert.deepEqual(result.languages,['ja']);});
test('日本語の版・履歴不一致と資料不足を固定前に拒否する',()=>{
  for(const [file,content] of [['hub/package.json','{"version":"invalid"}'],['hub/CHANGELOG.md','## 0.0.0'],['README.md',read('README.md').replace('開発中の版です（v','旧版（v')],['README.md',read('README.md').replace('現行版（','旧版（')]])assert.equal(checkVersion(f=>f===file?content:read(f)).ok,false,file);
  for(const missing of ['hub/package.json','hub/CHANGELOG.md','README.md'])assert.equal(checkVersion(f=>{if(f===missing)throw Error('missing');return read(f);}).ok,false,missing);
});
test('通常の自動検査は未更新・欠落した言語パックを読まず日本語だけで完了する',()=>{
  for(const unavailable of ['outdated','missing']){const reads=[];const result=checkVersion(f=>{reads.push(f);if(!['hub/package.json','hub/CHANGELOG.md','README.md'].includes(f))throw Error(unavailable);return read(f);});assert.equal(result.ok,true,result.error);assert.deepEqual(reads,['hub/package.json','hub/CHANGELOG.md','README.md']);}
});
test('標準の検証方法は日本語で通常試験を実行し言語パック専用試験を含めない',()=>{
  const p=new(require('../lib/idea-verification').IdeaVerification)({}).get('project-hub');assert.equal(p.env.HUB_LANG,'ja');assert.ok(p.argv.includes('test/version-check.test.js'));assert.equal(p.argv.some(a=>/langpacks|zh-TW|test:langpack/.test(a)),false);
});
