'use strict';
// Owner-run, offline Windows completion. Never launches Hub or signs anything.
// Fresh sibling directories only; failed/previous outputs must be inspected.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {prepare}=require('./prepare-windows.cjs'),{finalize,verify}=require('./finalize-windows.cjs');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function finish({base,platform=process.platform,arch=process.arch,prepareBuild=prepare,finalizeBuild=finalize}={}){
 if(platform!=='win32'||arch!=='x64'||typeof base!=='string'||!path.isAbsolute(base))throw Error('windows_x64_required');
 base=path.resolve(base);const prepared=base+'-native-prepared',output=base+'-publisher-free',report=base+'-completion.json';
 if([prepared,output,report].some(p=>fs.existsSync(p)))throw Error('previous_output_retained_do_not_retry');
 const input=verify(base),before=sha(fs.readFileSync(path.join(base,'release-manifest.json')));
 const compilation=prepareBuild({base,output:prepared,platform});
 const completion=finalizeBuild({base,prepared,output,unsigned:true,platform,arch});
 const ready=verify(output);
 if(ready.manifest.publisherSigned!==false||ready.manifest.distribution!=='publisher-free'||ready.manifest.windowsNativePrepared!==true||ready.manifest.source!==input.manifest.source||sha(fs.readFileSync(path.join(base,'release-manifest.json')))!==before)throw Error('completion_not_verified');
 const result={format:'project-hub-publisher-free-completion-v1',source:input.manifest.source,version:input.manifest.releaseVersion,baseManifestSha256:before,prepared,output,publisherSigned:false,applicationLaunched:false,liveAcceptanceEnabled:false,compilation,completion};
 fs.writeFileSync(report,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});return {...result,report};
}
if(require.main===module){try{const a=process.argv.slice(2);if(a.length!==2||a[0]!=='--base')throw Error('usage: --base ABS');console.log(JSON.stringify(finish({base:a[1]}),null,2));}catch(e){console.error('作成を停止しました。元の一式と途中出力は保持されています。同じ操作を繰り返さず、この表示を担当へ伝えてください。');console.error(e.code||e.message);if(e.code==='release_windows_preparation_failed'&&e.diagnostic)console.error('HUB_PREPARE_DIAGNOSTIC:'+JSON.stringify(e.diagnostic));process.exitCode=1;}}
module.exports={finish};
