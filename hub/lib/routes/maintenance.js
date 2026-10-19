'use strict';

module.exports = function maintenanceRoutes(ctx) {
  const { send, maintenance, problemResolution, executionGate, baseOf, store, record, lt } = ctx;
  return {
    write: {
      matches: (req, url) => url.pathname.startsWith('/api/maintenance/'),
      async handle(req, res, url, b) {
        try {
          let result;
          if (url.pathname === '/api/maintenance/preview') result=maintenance.preview(b.project);
          else if (url.pathname === '/api/maintenance/apply') {result=maintenance.apply(b.project,b.token,b.selected,b.confirm);record('cleanup', {project:b.project}, {transaction:result.id,moved:result.moved});}
          else if (url.pathname === '/api/maintenance/restore') {result=maintenance.restore(b.project,b.transaction,b.confirm);record('restore',{project:b.project},{transaction:b.transaction});}
          else if (url.pathname === '/api/maintenance/solve') {result=await problemResolution.solve(b.project);record('problemsolve',{project:b.project,task:result.task},{reused:result.reused,clear:result.clear});}
          else if (url.pathname === '/api/maintenance/verify') {const owner='maintenance:'+b.project;let lease;try{result=await maintenance.verify(b.project,b.script,b.expectedHash,b.confirm,()=>{lease=executionGate.acquire({dir:baseOf(store.readProject(b.project)),owner,kind:'verification'});});}finally{if(lease)executionGate.release(owner,lease.id);}record('verify',{project:b.project},{ok:result.ok,script:b.script});}
          else return send(res,404,{error:lt('操作が見つかりません')});
          return send(res,200,result);
        } catch(e) {return send(res,409,{error:e.message,...(e.task?{task:e.task}:{})});}
      },
    },
  };
};
