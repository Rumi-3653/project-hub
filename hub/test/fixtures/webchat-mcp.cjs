'use strict';
// Test-only stdio peer: no SDK, browser, credentials, HTTP listener or network.
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
const dir = path.dirname(path.dirname(__filename));
const settings = () => JSON.parse(fs.readFileSync(path.join(dir, 'fake.json'), 'utf8'));
const log = o => fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(o) + '\n');
const result = (id, value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: value }) + '\n');
const text = x => ({ content: [{ type: 'text', text: x }] });
let index = 0, previousNonce;
const session = new (require('./session.js').WebChatSession)();
log({ env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('WEBCHATMCP_'))), apiKey: Boolean(process.env.OPENAI_API_KEY) });
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const q = JSON.parse(line), s = settings();
  if (!('id' in q)) { log({ notification: q.method }); return; }
  if (q.method === 'initialize') return result(q.id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '1' } });
  if (q.method === 'tools/list') return result(q.id, { tools: ['webchat_ask', 'webchat_models', 'webchat_status', 'webchat_login', ...(s.noLogout ? [] : ['webchat_logout'])].map(name => ({ name })) });
  const { name, arguments: a } = q.params;
  log({ name, arguments: a });
  if (name === 'webchat_models') {
    if (s.modelsError) {
      if (s.modelsError.error === 'challenge_required' && session.page) session.page.title = async () => 'Verify you are human';
      return result(q.id, { isError: true, ...text(JSON.stringify(s.modelsError)) });
    }
    if (s.challenge) {
      try { await new (require('./session.js').WebChatSession)().passChallenge(); }
      catch(e) { return result(q.id, { isError: true, ...text(JSON.stringify({ error: e.code || 'unsafe_fallback', message: 'fixture verification screen' })) }); }
    }
    return result(q.id, text(JSON.stringify({ models: [{ label: s.model || 'Pro', current: !s.wrongCurrent }], thinking: [{ label: s.thinking || 'Extended', current: !s.wrongThinking }] })));
  }
  if (name === 'webchat_status') {
    try { return result(q.id, text(JSON.stringify(await session.statusAsync('chatgpt')))); }
    catch(e) { return result(q.id, { isError: true, ...text(JSON.stringify({ error: e.code || 'unsafe_fallback', message: e.message })) }); }
  }
  if (name === 'webchat_login') return result(q.id, text(JSON.stringify({ loggedIn: true })));
  if (name === 'webchat_logout') {
    if (s.logoutError) return result(q.id, { isError: true, ...text(JSON.stringify(s.logoutError)) });
    return result(q.id, text(JSON.stringify({ loggedIn: s.logoutUnknown ? 'unknown' : s.logoutStillLoggedIn === true, loggedOut: true })));
  }
  if (name === 'webchat_ask') {
    try { await session.ask('chatgpt'); }
    catch(e) { return result(q.id, { isError: true, ...text(JSON.stringify({ error: e.code || 'unsafe_fallback', message: e.message })) }); }
    const request = JSON.parse(a.prompt.match(/"request":("[^"]+")/)[1]);
    const nonce = JSON.parse(a.prompt.match(/"webchat":("[^"]+")/)?.[1] || '"conversation"');
    const jobs = JSON.parse(fs.readFileSync(path.resolve(process.env.WEBCHATMCP_PROFILE_DIR, '../../webchat-jobs.json'), 'utf8'));
    log({ sendingRecorded: jobs.some(j => j.request === request && j.state === 'sending' && j.sent), request });
    const reply = (s.answers || [{ answer: '完了しました' }])[Math.min(index++, (s.answers || [{}]).length - 1)];
    if (reply.exit) return process.exit(2);
    if (reply.delay) await new Promise(r => setTimeout(r, reply.delay));
    if (Object.hasOwn(reply, 'malformedMcp')) return process.stdout.write(JSON.stringify(reply.malformedMcp) + '\n');
    if (reply.error) return result(q.id, { isError: true, ...text(JSON.stringify({ error: reply.error, message: 'fake failure' })) });
    const replyNonce = reply.replayNonce ? previousNonce : nonce; previousNonce = nonce;
    if (reply.tool_calls) return result(q.id, text(JSON.stringify({ webchat: reply.badNonce ? 'wrong' : replyNonce, request: reply.badRequest ? 'wrong' : request, tool_calls: reply.tool_calls })));
    return result(q.id, text(reply.answer || '完了しました'));
  }
});
