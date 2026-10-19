'use strict';

module.exports = function hierarchyRoutes(ctx) {
  const { send, removal, removalReview, ideas, crypto, pruneUnread, record, projectOrder, store, sessions, chats } = ctx;
  return {
    remove: {
      matches: (req, url) => url.pathname.startsWith('/api/hierarchy/remove/'),
      async handle(req, res, url, b) {
        try {
          let result;
          if(url.pathname.endsWith('/preview')) {const review=b.task?null:removalReview.status(b.project);result={...removal.preview(b.project,b.task),review};}
          else if(url.pathname.endsWith('/review/start')) result=await removalReview.begin(b.token);
          else if(url.pathname.endsWith('/review/status')) {const review=removalReview.status(b.project);result={review,...(review?.status!=='running'?{preview:{...removal.preview(b.project),review}}:{})};}
          else if(url.pathname.endsWith('/apply')) {const removalTarget=removal.tokens.get(b.token)?.d;if(removalTarget&&!removalTarget.task&&ideas.resolve(removalTarget.project))ideas.backup(removalTarget.project,{opId:crypto.randomUUID()});result=removal.apply(b);pruneUnread();record('remove',{}, {transaction:result.record,moved:result.moved.length});}
          else if(url.pathname.endsWith('/restore')) {result=removal.restore(b.record,b.confirm);record('removerestore',{}, {transaction:b.record});}
          else if(url.pathname.endsWith('/history')) result={history:removal.history()};
          else return send(res,404,{error:'not found'});
          return send(res,200,result);
        }catch(e){return send(res,409,{error:e.message});}
      },
    },
    organize: {
      matches: (req, url) => ['/api/hierarchy/pin', '/api/hierarchy/order', '/api/hierarchy/rename'].includes(url.pathname),
      handle(req, res, url, b) {
        if (url.pathname === '/api/hierarchy/pin') {
          try {
            const result = projectOrder.pin(b);
            record('projectpin', { project: b.project }, { pinned: b.pinned });
            return send(res, 200, result);
          } catch (e) { return send(res, 409, { error: e.message }); }
        }
        if (url.pathname === '/api/hierarchy/order') {
          try {
            const result = projectOrder.save(b);
            record('projectorder', {}, { parent: b.parent, order: b.order });
            return send(res, 200, result);
          } catch (e) { return send(res, 409, { error: e.message }); }
        }
        if (url.pathname === '/api/hierarchy/rename') {
          try {
            const { Hierarchy } = require('../hierarchy');
            const value = new Hierarchy(store, id => sessions.list().some(s=>s.project===id && s.running) || [...chats.running.keys()].some(k=>k.startsWith(id+'\u0000'))).rename(b.project, b.task, b.name, b.expectedHash);
            record('rename', { project: b.project, task: b.task }); return send(res, 200, value);
          } catch(e) { return send(res, 409, { error: e.message }); }
        }
      },
    },
  };
};
