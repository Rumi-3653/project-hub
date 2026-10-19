'use strict';

module.exports = function startRoutes(ctx) {
  const { store, start, send, fs, lt, readRaw, quickStart } = ctx;
  return {
    image: {
      matches: (req, url) => req.method === 'GET' && url.pathname === '/api/start/image',
      handle(req, res, url) {
        if (req.method === 'GET' && url.pathname === '/api/start/image') {
          const p = store.readProject(url.searchParams.get('project'));
          try {
            if (!p) throw Error(lt('プロジェクトがありません'));
            const f = start.imageFile(p, url.searchParams.get('id'), true);
            return send(res, 200, fs.readFileSync(f), /\.jpe?g$/i.test(f) ? 'image/jpeg' : 'image/png');
          } catch { return send(res, 404, { error: lt('画像が見つかりません') }); }
        }
      },
    },
    upload: {
      matches: (req, url) => url.pathname === '/api/start/image',
      async handle(req, res, url) {
        if (url.pathname === '/api/start/image') {
          const p = store.readProject(url.searchParams.get('project'));
          if (!p) { req.resume(); return send(res, 400, { error: lt('プロジェクトがありません') }); }
          if(p.kind==='freetalk'){req.resume();return send(res,409,{error:lt('freetalkの添付は話題を指定して追加してください')});}
          try { return send(res, 200, start.saveImage(p, url.searchParams.get('name') || 'image.png', await readRaw(req, start.MAX))); }
          catch (e) { return send(res, 400, { error: e.message }); }
        }
      },
    },
    write: {
      matches: (req, url) => ['/api/start/image-path', '/api/start'].includes(url.pathname),
      async handle(req, res, url, b) {
        if (url.pathname === '/api/start/image-path') {
          const p = store.readProject(b.project);
          try { if (!p) throw Error(lt('プロジェクトがありません')); return send(res, 200, start.imageFromPath(p, b.path)); }
          catch (e) { return send(res, 400, { error: e.message }); }
        }
        if (url.pathname === '/api/start') {
          const r = await quickStart(b);
          return send(res, r.status, r.body);
        }
      },
    },
  };
};
