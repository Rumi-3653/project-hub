'use strict';

module.exports = function taskhistorywriteRoutes(ctx) {
  const { send, lt, taskHistory, autoTick, autoView, rolesData, delegateRequest } = ctx;
  return {
    auto: {
      matches: (req, url) => url.pathname==='/api/task/history/auto',
      handle(req, res, url, b) {
        if(url.pathname==='/api/task/history/auto'){
          // 同じrequestIdの再送・他タブ・切替後の確認は、新しい仕事を作らず同じ仕事を返す。
          try{const job=taskHistory.autoStart(b.project,b.task,b);setImmediate(()=>autoTick(b.project,b.task));return send(res,200,autoView(b.project,b.task,job));}catch(e){return send(res,409,{error:e.message});}
        }
      },
    },
    cancel: {
      matches: (req, url) => url.pathname==='/api/task/history/auto/cancel',
      handle(req, res, url, b) {
        if(url.pathname==='/api/task/history/auto/cancel'){
          try{taskHistory.autoCancel(b.project,b.task);return send(res,200,autoView(b.project,b.task));}catch(e){return send(res,409,{error:e.message});}
        }
      },
    },
    rotate: {
      matches: (req, url) => url.pathname==='/api/task/history/rotate',
      handle(req, res, url, b) {
        if(url.pathname==='/api/task/history/rotate'){
          try{return send(res,200,taskHistory.rotate(b.project,b.task,b));}catch(e){return send(res,409,{error:e.message});}
        }
      },
    },
    summary: {
      matches: (req, url) => url.pathname==='/api/task/history/summary',
      async handle(req, res, url, b) {
        if(url.pathname==='/api/task/history/summary'){
          try{
            const role=rolesData().roles.find(r=>r.name==='文章');if(!role?.main.model)throw Error(lt('文章担当の設定を確認してください'));
            const request=taskHistory.prepareSummary(b.project,b.task);
            const release=taskHistory.hold(b.project,b.task);res.once('finish',release);res.once('close',release);
            return await delegateRequest({...b,text:request.text,title:lt('会話整理の要約'),ai:role.main.ai==='claude-code'?'claude':role.main.ai,model:role.main.model,effort:role.main.effort,role:role.name},res,{beforeStart:()=>{release();taskHistory.idle(b.project,b.task);if(request.revision!==taskHistory.revision(b.project,b.task))throw Error(lt('要約依頼の準備中に会話が変わりました'));}});
          }catch(e){return send(res,409,{error:e.message});}
        }
      },
    },
  };
};
