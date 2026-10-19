'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const files=['test','paid/test'].flatMap(dir=>fs.existsSync(path.join(__dirname,'..',dir))?fs.readdirSync(path.join(__dirname,'..',dir)).filter(name=>name.endsWith('.test.js')).sort().map(name=>path.join(dir,name)):[]);
const result=spawnSync(process.execPath,['--test',...files],{cwd:path.join(__dirname,'..'),env:{...process.env,HUB_LANG:'ja'},stdio:'inherit'});
if(result.error)throw result.error;process.exitCode=result.status??1;
