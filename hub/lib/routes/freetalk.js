'use strict';

module.exports = function freetalkRoutes(ctx) {
  const { send, lt, freetalkHistory, freetalkAttachments, freetalk, specialMode, modelView, rolesData, freetalkLifecycle, chats, setUnread, cleanFreetalkMemory, startAutomaticFreetalk, delegateRequest } = ctx;
  return {
    status: {
      matches: (req, url) => req.method === 'GET' && url.pathname === '/api/freetalk/status',
      handle(req, res, url) {
        if (req.method === 'GET' && url.pathname === '/api/freetalk/status') {
          try {
            if (url.searchParams.get('project') !== 'freetalk') throw Error(lt('freetalk の話題を指定してください'));
            return send(res,200,freetalkHistory.status(url.searchParams.get('task')));
          } catch(e) { return send(res,409,{error:e.message}); }
        }
      },
    },
    attachment: {
      matches: (req, url) => req.method === 'GET' && url.pathname === '/api/freetalk/attachment',
      handle(req, res, url) {
        if (req.method === 'GET' && url.pathname === '/api/freetalk/attachment') {
          try {
            if(url.searchParams.get('project')!=='freetalk')throw Error('project');
            const preview=freetalkAttachments.preview(url.searchParams.get('task'),url.searchParams.get('id'));
            return send(res,200,preview.data,preview.type);
          } catch { return send(res,404,{error:lt('画像が見つかりません')}); }
        }
      },
    },
    ensure: {
      matches: (req, url) => url.pathname === '/api/freetalk/ensure',
      handle(req, res, url) {
        if (url.pathname === '/api/freetalk/ensure') return send(res, 200, freetalk.ensure());
      },
    },
    topic: {
      matches: (req, url) => url.pathname === '/api/freetalk/topic',
      handle(req, res, url) {
        if (url.pathname === '/api/freetalk/topic') {
          try { return send(res, 200, freetalk.createTopic(specialMode.pick(modelView.special(), rolesData(), '司令塔') || modelView.initial())); }
          catch (e) { return send(res, 409, { error: e.message }); }
        }
      },
    },
    lifecycle: {
      matches: (req, url) => ['/api/freetalk/project-preview','/api/freetalk/promote','/api/freetalk/clean','/api/freetalk/delete'].includes(url.pathname),
      handle(req, res, url, b) {
        if(['/api/freetalk/project-preview','/api/freetalk/promote','/api/freetalk/clean','/api/freetalk/delete'].includes(url.pathname)) {
          try {
            if(b.project!=='freetalk')throw Error(lt('freetalkを指定してください'));
            if(url.pathname==='/api/freetalk/project-preview')return send(res,200,freetalkLifecycle.preview(b.task));
            if(url.pathname==='/api/freetalk/promote') {
              const r=freetalkLifecycle.promote(b.task,b); chats.emit('freetalk',b.task,{type:'reset'});return send(res,200,r);
            }
            if(url.pathname==='/api/freetalk/delete') {
              const r=freetalkLifecycle.remove(b.task,{confirm:b.confirm});
              chats.base.delete(chats.key('freetalk',b.task));chats.queues.delete(chats.key('freetalk',b.task));
              chats.emit('freetalk',b.task,{type:'reset'});setUnread('freetalk',b.task,false);return send(res,200,r);
            }
            const r=freetalkLifecycle.clean({confirm:b.confirm});cleanFreetalkMemory();return send(res,200,r);
          }catch(e){return send(res,409,{error:e.message});}
        }
      },
    },
    projectStart: {
      matches: (req, url) => url.pathname === '/api/freetalk/project-start',
      async handle(req, res, url, b) {
        if(url.pathname==='/api/freetalk/project-start') {
          try {
            if(b.project!=='freetalk')throw Error(lt('freetalk の話題を指定してください'));
            return send(res,200,await startAutomaticFreetalk(b.task));
          }catch(e){return send(res,e.status || 409,{error:e.message});}
        }
      },
    },
    history: {
      matches: (req, url) => ['/api/freetalk/summary','/api/freetalk/rotate','/api/freetalk/promotion-intent'].includes(url.pathname),
      async handle(req, res, url, b) {
        if (['/api/freetalk/summary','/api/freetalk/rotate','/api/freetalk/promotion-intent'].includes(url.pathname)) {
          try {
            if (b.project !== 'freetalk') throw Error(lt('freetalk の話題を指定してください'));
            if(url.pathname==='/api/freetalk/promotion-intent')return send(res,200,freetalkHistory.promotionIntent(b.task,b.requested));
            if (url.pathname === '/api/freetalk/rotate') {
              const result = freetalkHistory.rotate(b.task,b);
              chats.base.delete(chats.key('freetalk',b.task)); chats.queues.delete(chats.key('freetalk',b.task));
              chats.emit('freetalk',b.task,{type:'reset'}); setUnread('freetalk',b.task,false);
              return send(res,200,result);
            }
            const request = freetalkHistory.prepareSummary(b.task,{intent:b.intent});

            return await delegateRequest({...request, project:'freetalk',task:b.task,title:lt('話題の整理用の要約')},res,{requestKey:freetalkHistory.state(b.task).summary.id,beforeStart:()=>freetalkHistory.idle(b.task)});
          } catch(e) { return send(res,e.status || 409,{error:e.message}); }
        }
      },
    },
  };
};
