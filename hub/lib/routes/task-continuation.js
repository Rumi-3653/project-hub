'use strict';

module.exports = function taskcontinuationRoutes(ctx) {
  const { send, taskHistory, textBudget, autoTick, record } = ctx;
  return {
    recover: {
      matches: (req, url) => url.pathname==='/api/task/continue/recover',
      handle(req, res, url, b) {
        if(url.pathname==='/api/task/continue/recover'){
          try{const out=require('../task-continue').recoverContinue({history:taskHistory,budget:textBudget},b);if(out.pending)setImmediate(()=>autoTick(b.project,b.task));return send(res,200,out);}catch(e){return send(res,409,{error:e.message});}
        }
      },
    },
    continue: {
      matches: (req, url) => url.pathname==='/api/task/continue',
      handle(req, res, url, b) {
        if(url.pathname==='/api/task/continue'){
          try{const out=require('../task-continue').continueTask({history:taskHistory,budget:textBudget},b);record('task-continue',b,{body:out.body,rotate:out.rotate,generation:out.generation});if(out.pending)setImmediate(()=>autoTick(b.project,b.task));return send(res,200,out);}catch(e){
            let stage;try{const r=taskHistory.continueRecord(b.project,b.task);if(!r||r.requestId!==b.requestId)stage='not-started';}catch{}
            return send(res,409,{error:e.message,code:e.code,...(stage?{stage}:{})});
          }
        }
      },
    },
  };
};
