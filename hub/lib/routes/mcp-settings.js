'use strict';

module.exports = function mcpsettingsRoutes(ctx) {
  const { send, lt, gpt, readBody, freetalkHistory, codexMcpStatus, codexMcpRegister, record } = ctx;
  return {
    tools: {
      matches: (req, url) => url.pathname.startsWith('/api/mcp/'),
      async handle(req, res, url, b) {
        if (req.headers['x-hub'] !== '1') return send(res, 403, { error: 'forbidden' });
        if (['/api/mcp/http','/api/mcp/rpc'].includes(url.pathname)) return send(res,410,{error:'Dot event adapter retired'});
        if (req.method === 'GET' && url.pathname === '/api/mcp/tools') return send(res, 200, { tools: gpt.tools(), work: gpt.settings().work });
        if (req.method === 'POST' && url.pathname === '/api/mcp/call') {
          const b = await readBody(req);
          if(b?.origin==='hub-internal')return send(res,403,{error:lt('内部依頼の指定はHubからだけ受け付けます'),delivery:'not-sent'});
          try { if(b.arguments?.project==='freetalk' && b.arguments.task && !['hub_get_task','hub_get_chat','hub_read_file','hub_list_tasks'].includes(b.name) && freetalkHistory.state(b.arguments.task).migrated)return send(res,409,{error:lt('移行済みの話題は読み取り専用です')}); const r = await gpt.call(String(b.name || ''), b.arguments && typeof b.arguments === 'object' ? b.arguments : {}); return send(res, 200, { text: typeof r === 'string' ? r : JSON.stringify(r, null, 2) }); }
          catch (e) { return send(res, e.status || 500, { error: String(e.message || e), unknown: e.status === 404 && e.unknown === true }); }
        }
        return send(res, 404, { error: 'not found' });
      },
    },
    read: {
      matches: (req, url) => req.method === 'GET' && url.pathname === '/api/chatgpt',
      handle(req, res, url, b) {
        return send(res, 200, { ...gpt.settings(), ...codexMcpStatus() });
      },
    },
    register: {
      matches: (req, url) => url.pathname === '/api/chatgpt/register',
      handle(req, res, url, b) {
        const r = codexMcpRegister();
        if (r.error) return send(res, 400, { error: r.error });
        record('chatgptregister', {}, { file: r.file, added: r.added });
        return send(res, 200, { ...gpt.settings(), ...codexMcpStatus(), ...r });
      },
    },
    write: {
      matches: (req, url) => url.pathname === '/api/chatgpt',
      handle(req, res, url, b) {
        if (typeof b.work !== 'boolean') return send(res, 400, { error: lt('形式が違います') });
        const s = gpt.save({ work: b.work }); record('chatgptwork', {}, { work: s.work });
        return send(res, 200, s);
      },
    },
  };
};
