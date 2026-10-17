'use strict';
const U = require('./idea-utils');
const saveRoutes = new Set(['/api/ideas/add', '/api/ideas/update', '/api/ideas/image', '/api/ideas/reorder', '/api/ideas/delete']);
function isSaveRoute(route) { return saveRoutes.has(route); }
function humanRequest(req) {
  if (req.headers['x-hub-ui'] !== 'ideas' || !req.headers.origin) return false;
  try { const u = new URL(req.headers.origin); return u.host === req.headers.host && ['http:', 'https:'].includes(u.protocol); } catch { return false; }
}
class IdeaAPI {
  constructor({ ideas, source, runner, release, available = () => false, wake = () => {}, lane, authorizeRecord } = {}) { Object.assign(this, { ideas, source, runner, release, available, wake, lane, authorizeRecord }); }
  async handle(req, res, url, b, send) {
    const route = url.pathname, project = b?.project || url.searchParams.get('project');
    try {
      if (req.headers['x-hub'] !== '1') throw U.fail('forbidden', '接続を確認してください', 403);
      this.ideas.project(project);
      if (req.method === 'GET') {
        if (route === '/api/ideas/image') { const image = this.ideas.image(project, url.searchParams.get('id'), url.searchParams.get('preview') === '1'); return send(res, 200, image.bytes, image.type); }
        if (route === '/api/ideas') return send(res, 200, { ...this.ideas.view(project, Math.max(0, Number(url.searchParams.get('offset')) || 0), 100, url.searchParams.get('category') || ''), deleteAvailability:url.searchParams.has('deleteId')?this.ideas.eraseAvailability(project,url.searchParams.get('deleteId')):null, automationAvailable: this.available(), candidates: this.lane?.candidates(project) || [], profiles:this.lane?.profiles?.list()||[],laneSnapshot:(()=>{try{return U.snapshot(this.lane.resolve(project).workdirReal);}catch{return null;}})() });
        if (route === '/api/ideas/receipt') return send(res, 200, this.ideas.receipt(project, url.searchParams.get('opId')));
        if (route === '/api/ideas/item') { const i = this.ideas.read(project).items[url.searchParams.get('id')]; U.check(i, 'item', '項目が見つかりません', 404); return send(res, 200, { item: i }); }
      }
      U.check(req.method === 'POST' && b && typeof b === 'object' && !Array.isArray(b), 'method', '送信方法を確認してください', 400); U.opId(b.opId);
      const human = humanRequest(req);
      if (!human) U.check(route === '/api/ideas/add' && b.intent !== 'build' && this.authorizeRecord?.(req, b), 'permission', 'この操作はアイデア台帳の画面から行ってください', 403);
      let out, status = 200;
      if (route === '/api/ideas/add') {
        // A retry checks the original body before recapturing a conversation that may have moved.
        const old = this.ideas.read(project).receipts[b.opId];
        const payload = { kind: 'add', ...b, project };
        if (old) { U.check(old.bodyHash === U.hash(payload), 'op-conflict', '同じ送信識別の内容が変わっています'); out = { saved: true, ...old.result, receipt: old }; }
        else { const capture = b.sourceRef ? this.source.capture(project, b.sourceRef, b.sourceText) : null; out = this.ideas.add(project, { ...b, text: capture?.text ?? b.text, operationPayload: payload }, { human, source: capture?.source }); }
        status = 201;
      } else if (route === '/api/ideas/backup') out = this.ideas.backup(project,b);
      else if (route === '/api/ideas/relocate') out = this.ideas.relocate(project,b);
      else if (route === '/api/ideas/update') out = this.ideas.update(project, b);
      else if (route === '/api/ideas/reorder') out = this.ideas.reorder(project, b);
      else if (route === '/api/ideas/delete') out = this.ideas.erase(project, b);
      else if (route === '/api/ideas/auto') { U.check(!b.enabled || this.available(), 'not-installed', '自動進行は導入後に利用できます'); out = this.ideas.auto(project, b); }
      else if (route === '/api/ideas/lane') { U.check(this.lane, 'not-installed', '実行先の設定は導入後に利用できます'); out = this.lane.set(project, b); }
      else if (route.startsWith('/api/ideas/release/') || route === '/api/ideas/runtime-confirm') { U.check(this.release && this.available(), 'not-installed', '反映準備は導入後に利用できます'); const action = route === '/api/ideas/runtime-confirm' ? 'runtimeConfirm' : route.split('/').at(-1); U.check(['prepare', 'apply', 'cancel', 'keepalive', 'runtimeConfirm'].includes(action), 'route', '操作が見つかりません', 404); out = await this.release[action](project, b); if (action === 'prepare') status = 202; }
      else throw U.fail('route', '操作が見つかりません', 404);
      this.wake(project); return send(res, status, out);
    } catch (e) { return send(res, e.status || 503, { error: e.message, message: e.message, code: e.code || 'storage', saved: e.saved ?? false, opId: b?.opId, retry: e.saved === 'unknown' ? 'receipt' : 'after-change' }); }
  }
}
module.exports = { IdeaAPI, isSaveRoute, humanRequest };
