'use strict';

module.exports = function taskbodywriteRoutes(ctx) {
  const { send, textBudget, record } = ctx;
  return {
    write: {
      matches: (req, url) => ['/api/task/body/apply','/api/task/body/recover','/api/task/body/summary'].includes(url.pathname),
      handle(req, res, url, b) {
        if(['/api/task/body/apply','/api/task/body/recover','/api/task/body/summary'].includes(url.pathname)){
          try{const out=url.pathname.endsWith('/recover')?textBudget.recover(b):url.pathname.endsWith('/summary')?textBudget.replaceSummary(b):textBudget.apply(b);record('text-body',b,{id:out.id});return send(res,200,out);}catch(e){return send(res,409,{error:e.message});}
        }
      },
    },
  };
};
