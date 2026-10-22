'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict');
const {readSteps}=require('../lib/store'),{sectionPattern}=require('../lib/locale');

test('step sections keep ordering and ignore checkboxes in notes and results',()=>{
  const text='- [x] outside\n## 手順\n- [ ] first\n### 第1回\n* [X] second😀\n## メモ\n- [x] ignored\n## 手順（追加）\r\n\t- [x] third\r\n## 成果\n- [ ] ignored too';
  assert.deepEqual(readSteps(text),[{text:'first',done:false},{text:'second😀',done:true},{text:'third',done:true}]);
  assert.deepEqual(readSteps('## 手順\n- [x] before\n##\r\n- [ ] still inside\n## メモ\n- [x] outside'),[{text:'before',done:true},{text:'still inside',done:false}]);
});

test('section scanning matches previous line parsing at whitespace and delimiter boundaries',()=>{
  const previous=body=>{const out=[];let inside=false;for(const line of body.split(/\r?\n/)){if(/^##\s/.test(line)){inside=new RegExp('^##\\s+(?:'+sectionPattern('手順')+')(?=$|\\s|（)').test(line);continue;}const m=inside&&line.match(/^\s*[-*]\s+\[([ xX])\]\s+(\S.*)$/);if(m)out.push({text:m[2].trim(),done:m[1]!==' '});}return out;};
  const headings=['## 手順','## 手順（再開）','##  手順 ','##\t手順','##\r手順','##\u2028手順','## メモ','## 手順外','##','##\r','### 手順','prefix ## 手順'];
  const steps=['- [ ] one','* [X] 😀','\t- [x] tab','\u00a0* [ ] unicode','- [x] a\u2028b','- [x] a\u2028','- [ ]','- [] invalid','plain'];
  const eols=['\n','\r\n','\r','\u2028','\u2029'];
  for(const a of headings)for(const b of headings)for(const eol of eols){const text=[a,...steps,b,...steps,'## 手順',...steps,'## 成果',...steps].join(eol);assert.deepEqual(readSteps(text),previous(text));}
  let seed=20261019;const next=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
  const fragments=[...headings,...steps,'##\n','\n','\r',''];
  for(let i=0;i<1000;i++){let text='';for(let j=0;j<30;j++)text+=fragments[next(fragments.length)]+eols[next(eols.length)];assert.deepEqual(readSteps(text),previous(text));}
});
