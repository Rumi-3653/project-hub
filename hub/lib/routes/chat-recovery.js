'use strict';

module.exports = function chatrecoveryRoutes(ctx) {
  const { send, chats, store } = ctx;
  return {
    handoff: {
      matches: (req, url) => url.pathname === '/api/chat/handoff/recover',
      handle(req, res, url, b) {
        try{return send(res,200,chats.recoverHandoff(b));}
        catch(e){return send(res,409,{error:e.message,delivery:'not-sent'});}
      },
    },
    unfinished: {
      matches: (req, url) => url.pathname === '/api/chat/unfinished/resolve',
      handle(req, res, url, b) {
        const p=store.readProject(b.project);
        if(!p||!store.taskFile(b.project,b.task))return send(res,400,{error:'作業が見つかりません'});
        try{return send(res,200,{ok:true,entry:require('../chat-continuation').resolve(p.dir,b.task,b)});}
        catch(e){return send(res,409,{error:e.message});}
      },
    },
  };
};
