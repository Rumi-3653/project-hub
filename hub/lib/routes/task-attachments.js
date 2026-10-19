'use strict';

module.exports = function taskattachmentsRoutes(ctx) {
  const { send, lt, store, taskHistory, freetalk, freetalkAttachments, readRaw, MAX_UPLOAD, record, saveUpload, launch, sessions, path, fs } = ctx;
  return {
    upload: {
      matches: (req, url) => url.pathname === '/api/task/upload',
      async handle(req, res, url, b) {
        const q = k => url.searchParams.get(k) || '';
        const p = store.readProject(q('project'));
        const file = p && store.taskFile(p.id, q('task'));
        if(file&&p.kind!=='freetalk'){const generation=taskHistory.state(p.id,q('task')).generation;if((q('generation')||req.headers.origin&&generation>1)&&Number(q('generation'))!==generation){req.resume();return send(res,409,{error:lt('会話が切り替わりました。新しい会話を開いてください')});}}
        if (!file) { req.resume(); return send(res, 400, { error: lt('作業が見つかりません') }); }
        if (p.kind === 'freetalk') {
          let release;
          try {
            const generation=Number(q('generation'));
            release=freetalk.holdUpload(q('task'),generation);
            let data;
            try { data=await readRaw(req,MAX_UPLOAD); } catch { return send(res,413,{error:lt('ファイルが大きすぎます（50MB まで）')}); }
            const attachment=await freetalkAttachments.upload(q('task'),q('name'),data,generation);
            store.updateTask(p.id,q('task'),{memo:lt`ファイルを渡した: ${attachment.referencePaths.join(' , ')}`});
            record('upload',{project:p.id,task:q('task')},{file:attachment.path,bytes:data.length});
            return send(res,200,{ok:true,...attachment,typed:false});
          } catch(e) { req.resume();return send(res,409,{error:e.message}); }
          finally { release?.(); }
        }
        let data;
        try { data = await readRaw(req, MAX_UPLOAD); } catch (e) { return send(res, 413, { error: lt('ファイルが大きすぎます（50MB まで）') }); }
        let saved;
        try { saved = saveUpload(q('name'), data); }
        catch (e) { return send(res, 409, { error: e.message }); }
        store.updateTask(p.id, q('task'), { memo: lt`ファイルを渡した: ${saved}` });
        const ai = launch.AIS.includes(q('ai')) ? q('ai') : '';
        const typed = ai ? sessions.write(p.id, q('task'), ai, (/\s/.test(saved) ? `"${saved}"` : saved) + ' ') : false;
        record('upload', { project: p.id, task: q('task'), ai }, { file: saved, bytes: data.length });
        return send(res, 200, { ok: true, path: saved, typed });
      },
    },
    attach: {
      matches: (req, url) => url.pathname === '/api/task/attach',
      async handle(req, res, url, b) {
        const p = store.readProject(b.project);
        const file = p && store.taskFile(p.id, b.task);
        if(p?.kind==='freetalk') {
          let release;const attachments=[];
          try {
            if(!Array.isArray(b.paths)||!b.paths.length||b.paths.length>20)throw Error(lt('添付ファイルの指定が正しくありません'));
            release=freetalk.holdUpload(b.task,b.generation);
            for(const raw of b.paths)attachments.push(await freetalkAttachments.fromPath(b.task,raw,b.generation));
            const paths=attachments.flatMap(a=>a.referencePaths);
            store.updateTask(p.id,b.task,{memo:lt`ファイルを渡した: ${paths.join(' , ')}`});
            record('upload',{project:p.id,task:b.task},{file:paths.join(' , ')});
            return send(res,200,{ok:true,attachments,paths,typed:false});
          }catch(e){for(const attachment of attachments)freetalkAttachments.discard(b.task,attachment);return send(res,409,{error:e.message});}
          finally{release?.();}
        }
        const paths = (Array.isArray(b.paths) ? b.paths : []).map(x => String(x)).filter(x => path.isAbsolute(x) && fs.existsSync(x)).slice(0, 20);
        if (!file) return send(res, 400, { error: lt('作業が見つかりません') });
        if (!paths.length) return send(res, 400, { error: lt('ファイルが見つかりません') });
        store.updateTask(p.id, b.task, { memo: lt`ファイルを渡した: ${paths.join(' , ')}` });
        const ai = launch.AIS.includes(b.ai) ? b.ai : '';
        const typed = ai ? sessions.write(p.id, b.task, ai, paths.map(x => (/\s/.test(x) ? `"${x}"` : x)).join(' ') + ' ') : false;
        record('upload', { project: p.id, task: b.task, ai }, { file: paths.join(' , ') });
        return send(res, 200, { ok: true, paths, typed });
      },
    },
  };
};
