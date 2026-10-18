'use strict';
const persistence = require('./platform').persistence;
const fs=require('node:fs'),path=require('node:path');
const {noLinks,readNoLinks,exists}=require('./remove');
// Exclusive temporary file, exact POSIX mode, durable intent before any source replacement.
function syncDirectory(file){persistence.syncDirectory(path.dirname(file));}
function atomic(file,bytes,mode=0o600){return require('./integration-writes').write(file,()=>{
  noLinks(file);const tmp=file+'.tmp';noLinks(tmp);
  const fd=fs.openSync(tmp,'wx',0o600);
  try{fs.writeFileSync(fd,bytes);fs.fchmodSync(fd,mode);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(tmp,file);
  syncDirectory(file);
});}
function read(file){readNoLinks(file);if(!exists(file))return null;const st=fs.statSync(file);if(!st.isFile()||st.nlink!==1)throw Error('原文は単独の通常ファイルにしてください');return {text:fs.readFileSync(file,'utf8'),mode:st.mode&0o777};}
// Recovery never recreates an ambiguous temp or substitutes another operation's bytes.
function recoverAtomic(file,bytes,mode=0o600){const tmp=read(file+'.tmp');if(!tmp)return atomic(file,bytes,mode);return require('./integration-writes').write(file,()=>{if(Buffer.isBuffer(bytes)?!fs.readFileSync(file+'.tmp').equals(bytes):tmp.text!==bytes)throw Error('一時原文の照合が必要です');const fd=fs.openSync(file+'.tmp','r+');try{fs.fchmodSync(fd,mode);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(file+'.tmp',file);syncDirectory(file);});}
module.exports={atomic,read,recoverAtomic,syncDirectory};
