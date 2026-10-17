'use strict';
const fs=require('node:fs'),path=require('node:path');
// Pin all literal relative imports, including imports inside not-yet-called
// functions in dependent modules. This generation never reads new code later.
function preload(file,{optional=[]}={}){
 const optionalFiles=new Set(optional.map(f=>path.resolve(f))),seen=new Set([file]),loaded=[];
 function walk(parent){
  if(!parent.endsWith('.js')&&!parent.endsWith('.cjs'))return;
  const source=fs.readFileSync(parent,'utf8');
  for(const m of source.matchAll(/require\((['"])(\.[^'"]+)\1\)/g)){
   const target=path.resolve(path.dirname(parent),m[2]);let resolved;
   try{resolved=require.resolve(target);}
   catch(e){
    // Only explicitly optional, absent modules may be omitted from a build.
    // Existing modules and errors in their own dependencies remain fatal.
    if(e.code==='MODULE_NOT_FOUND'&&optionalFiles.has(target)&&!fs.existsSync(target)&&!fs.existsSync(target+'.js'))continue;
    throw e;
   }
   if(seen.has(resolved))continue;seen.add(resolved);require(resolved);loaded.push(resolved);walk(resolved);
  }
 }
 walk(file);return loaded;
}
module.exports={preload};
