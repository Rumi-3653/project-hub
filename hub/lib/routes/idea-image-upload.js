'use strict';

module.exports = function ideaimageRoutes(ctx) {
  const { send, ideas } = ctx;
  return {
    upload: {
      matches: (req, url) => url.pathname === '/api/ideas/image',
      async handle(req, res, url, b) {
        try {
          const { humanRequest } = require('../idea-api'), images = require('../idea-images');
          if (req.headers['x-hub'] !== '1' || !humanRequest(req)) { req.resume(); return send(res,403,{error:'この操作はアイデア台帳の画面から行ってください',saved:false}); }
          const project = url.searchParams.get('project'); ideas.project(project);
          const body = { opId: url.searchParams.get('opId'), name: url.searchParams.get('name') }; require('../idea-utils').opId(body.opId);
          // Drain an oversized body and return a typed rejection without destroying the response socket.
          const chunks = []; let size = 0;
          for await (const chunk of req) { size += chunk.length; if (size <= images.MAX) chunks.push(chunk); }
          if (size > images.MAX) return send(res,413,{error:'画像は1枚20MBまでです',saved:false});
          return send(res,201,ideas.uploadImage(project,body,Buffer.concat(chunks)));
        } catch (e) { req.resume(); return send(res,e.status||503,{error:e.message,message:e.message,code:e.code||'storage',saved:e.saved??false,retry:e.saved==='unknown'?'receipt':'after-change'}); }
      },
    },
  };
};
