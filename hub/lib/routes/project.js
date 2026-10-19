'use strict';

module.exports = function projectRoutes(ctx) {
  const { send, projectNotes, store, expandHome, github, githubProject, fs, path, gitw, lt, handoff, sessions, chats, record, reportChild, activePack, __dirname } = ctx;
  return {
    notes: {
      matches: (req, url) => req.method === 'GET' && url.pathname === '/api/project/notes',
      handle(req, res, url) {
        if(req.method==='GET'&&url.pathname==='/api/project/notes'){
          try{const value=projectNotes.read(url.searchParams.get('project')),tag='"'+value.hash+'"';if(req.headers['if-none-match']===tag){res.writeHead(304,{ETag:tag,'Cache-Control':'no-store'});return res.end();}res.setHeader('ETag',tag);return send(res,200,value);}catch(e){return send(res,404,{error:e.message});}
        }
      },
    },
    github: {
      matches: (req, url) => req.method === 'GET' && url.pathname === '/api/project/github',
      handle(req, res, url) {
        if (req.method === 'GET' && url.pathname === '/api/project/github') {
          const p = store.readProject(url.searchParams.get('project'));
          const task = url.searchParams.get('task');
          const file = p && task ? store.taskFile(p.id, task) : null;
          const wd = file ? expandHome(store.readTask(file).workdir) : '';
          // コピーのブランチはコピーから、本体の接続先は選択済み製品Gitから読む。
          let info = null;
          if (p) {
            const main = github.projectRemote(githubProject(p), { fresh: true }).value;
            if (wd && fs.existsSync(wd) && (!main?.target || main.target === '.')) info = gitw.remoteInfo(wd, { fresh: true });
            else if (wd && main?.target) {
              const candidate = path.join(wd, main.target);
              info = fs.existsSync(path.join(candidate, '.git')) ? gitw.remoteInfo(candidate, { fresh: true }) : null;
            } else info = main;
          }
          return info ? send(res, 200, info) : send(res, 404, { error: lt('GitHub の場所が見つかりません') });
        }
      },
    },
    children: {
      matches: (req, url) => req.method === 'GET' && url.pathname === '/api/project/children',
      handle(req, res, url) {
        if (req.method === 'GET' && url.pathname === '/api/project/children') {
          const r = handoff.childrenSummary(store, url.searchParams.get('project'));
          return r ? send(res, 200, r) : send(res, 404, { error: lt('プロジェクトが見つかりません') });
        }
      },
    },
    status: {
      matches: (req, url) => url.pathname === '/api/project/status',
      handle(req, res, url, b) {
        if (url.pathname === '/api/project/status') {
          if (b.status === '完了' && b.confirm !== true) return send(res, 400, { error: lt('完了に移すか確認してください') });
          const current = store.readProject(b.project);
          if ((b.status === '完了' || b.expectedHash) && current?.completionHash !== b.expectedHash) return send(res, 409, { error: lt('確認中にプロジェクトが更新されました') });
          if (!['完了', '進行中'].includes(b.status)) return send(res, 400, { error: lt('形式が違います') });
          if (b.status === '完了') {
          if (sessions.list().some(x => x.project === b.project && x.running) || [...chats.running.keys()].some(k => k.startsWith(b.project + '\u0000'))) return send(res, 409, { error: lt('このプロジェクトでAIが作業中です。終わってから完了を確認してください') });
          }
          const p = store.setProjectStatus(b.project, b.status);
          if (p) record(b.status === '完了' ? 'projectdone' : 'projectreopen', { project: b.project });
          if (p && b.status === '完了' && p.status === '完了') reportChild(p, '完了', handoff.completionText(p));
          return p ? send(res, 200, { ok: true, status: p.status }) : send(res, 400, { error: lt('プロジェクトが見つかりません') });
        }
      },
    },
    handoff: {
      matches: (req, url) => url.pathname === '/api/project/handoff',
      handle(req, res, url, b) {
        if (url.pathname === '/api/project/handoff') {
          const p = store.readProject(b.project);
          if (!p) return send(res, 400, { error: lt('プロジェクトが見つかりません') });
          const t = handoff.newestTask(p);
          const text = (typeof b.text === 'string' && b.text.trim()) || (t ? handoff.lastEntry(t.done) : '');
          if (!text) return send(res, 400, { error: lt('渡す内容がありません。文を書くか、作業の「やったこと」を書いてください') });
          if (text.length > 4000) return send(res, 400, { error: lt('渡す文は4000文字までです') });
          const r = reportChild(p, lt('報告'), text);
          if (!r) return send(res, 400, { error: lt('親プロジェクトが見つかりません') });
          return send(res, 200, { ok: true, parent: r.parent, task: r.task, duplicate: r.duplicate });
        }
      },
    },
    archive: {
      matches: (req, url) => ['/api/project/notes/archive/preview', '/api/project/notes/archive'].includes(url.pathname),
      handle(req, res, url, b) {
        if(url.pathname==='/api/project/notes/archive/preview'||url.pathname==='/api/project/notes/archive'){
          try{const out=url.pathname.endsWith('/preview')?projectNotes.preview(b.project,b.keepLines):projectNotes.apply(b);if(out.ok)record('project-notes-archive',b,{archive:out.archive});return send(res,200,out);}catch(e){return send(res,409,{error:e.message});}
        }
      },
    },
    refs: {
      matches: (req, url) => url.pathname === '/api/project/refs',
      handle(req, res, url, b) {
        if (url.pathname === '/api/project/refs') {
          const paths = (Array.isArray(b.paths) ? b.paths : []).map(x => expandHome(String(x))).filter(x => path.isAbsolute(x) && fs.existsSync(x)).slice(0, 30);
          if (!paths.length) return send(res, 400, { error: lt('フォルダが見つかりません') });
          const r = store.addRefs(b.project, paths);
          if (!r) return send(res, 400, { error: lt('プロジェクトが見つかりません') });
          record('refs', { project: b.project }, { paths: paths.join(' , ') });
          return send(res, 200, { ok: true, added: r.added, folders: r.project.folders });
        }
      },
    },
    create: {
      matches: (req, url) => url.pathname === '/api/project/new',
      handle(req, res, url, b) {
        if (url.pathname === '/api/project/new') {
          const body = expandHome(b.body || '');
          if (body && !fs.existsSync(body)) return send(res, 400, { error: lt`本体のフォルダが見つかりません: ${body}` });
          if (body && !fs.statSync(body).isDirectory()) return send(res, 400, { error: lt`フォルダではありません（ファイルです）: ${body}` });
          const refs = (Array.isArray(b.refs) ? b.refs : []).map(x => expandHome(String(x))).filter(x => path.isAbsolute(x) && fs.existsSync(x));
          const pack = activePack(['templates']);
          const r = store.createProject({ ...b, body, refs }, pack ? path.join(pack.directory, 'templates', 'project') : path.join(__dirname, '..', 'docs', 'project-hub', 'templates', 'project'));
          if (r.error) return send(res, 400, { error: r.error });
          record('newproject', { project: r.project.id });
          return send(res, 200, r.project);
        }
      },
    },
  };
};
