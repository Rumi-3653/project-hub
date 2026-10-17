'use strict';
const { randomUUID } = require('node:crypto');
const history = require('./role-history');
const roles = require('./roles');
const launch = require('./launch');
const { lt } = require('./locale');
const TARGETS = [{ ai: 'claude', model: 'claude-opus-5-5' }, { ai: 'codex', model: 'gpt-6.1-sol' }];
const OPEN = '[[役割見直し結果]]', CLOSE = '[[/役割見直し結果]]';
function result(text) {
  const start = text.indexOf(OPEN), end = text.indexOf(CLOSE);
  if (start < 0 || end < start || text.indexOf(OPEN, start + OPEN.length) >= 0) throw Error(lt('見直し結果の形式を確認できないため、保存していません'));
  const r = JSON.parse(text.slice(start + OPEN.length, end).trim());
  if (!Array.isArray(r.roles) || typeof r.reason !== 'string' || !r.reason.trim()) throw Error(lt('見直し結果に設定または理由がありません'));
  return r;
}
function validateDecision(decision, current, candidates) {
  if (decision.roles.length !== current.length || decision.roles.some((r, i) => r.name !== current[i].name || r.job !== current[i].job)) throw Error(lt('役割の名前・内容・順序は見直しで変更できません'));
  for (const r of decision.roles) {
    const before = current.find(x => x.name === r.name);
    for (const key of ['main', 'backup']) {
      const s = r[key];
      if (history.same(s, before[key])) continue;
      if (!s || Object.keys(s).sort().join(',') !== 'ai,effort,model') throw Error(lt('役割設定の形式が違います'));
      const ai = s.ai === 'claude-code' ? 'claude' : s.ai;
      const model = candidates.find(c => c.ai === ai && c.label === s.model);
      if (!model || !model.efforts.includes(s.effort) || model.id === 'claude-opus-4-6') throw Error(lt('契約内で確認できたモデル・思考の組合せ以外は保存しません'));
      if (ai === 'agy' && (!Object.values({ main: before.main, backup: before.backup }).some(x => x.ai === 'agy'))) throw Error(lt('Agy は人が割り当てた役割で指定のモデルだけを使えます'));
    }
    if (!history.same(r, before)) {
      const evidence = decision.evidence?.find(e => e.role === r.name);
      if (!evidence || typeof evidence.reason !== 'string' || !evidence.reason.trim() || !Array.isArray(evidence.sources) || !evidence.sources.length || evidence.sources.some(s => typeof s !== 'string' || !s.trim())) throw Error(lt('変更する役割に改善の根拠がありません。設定は維持しました'));
    }
  }
}
class RoleReview {
  constructor(options) { Object.assign(this, options); this.working = false; }
  recover() {
    const pending = history.load(this.file).journal.review;
    if (pending) { this.removeQueued?.(pending); this.fail(pending.id, lt('Hubの再起動で見直しを中断しました。設定と最終見直し日時は維持しています')); }
  }
  start({ expectedRevision }) {
    const current = history.load(this.file);
    if (current.journal.review) throw Object.assign(Error(lt('手動見直しはすでに受付済みです')), { status: 409 });
    if (expectedRevision !== current.revision) throw Object.assign(Error(lt('役割設定が変わりました。読み直してください')), { status: 409 });
    const id = randomUUID();
    // Reserve before creating a topic. Concurrent requests cannot create a
    // second topic; a restart interrupts the intent instead of replaying it.
    history.updateReview(this.file, null, j => { j.review = { id, project: 'freetalk', task: '', baseRevision: current.revision, roles: current.roles,
      at: new Date().toISOString(), status: 'creating', message: lt('見直し用の新しい話題を作成しています'), stage: 0, responses: [], participants: [] }; });
    try {
      const topic = this.createTopic();
      this.target('freetalk', topic.id);
      history.updateReview(this.file, id, j => Object.assign(j.review, { task: topic.id, status: 'waiting', message: lt('新しい話題で見直しを始めます') }));
    } catch (e) { this.fail(id, e.message); throw e; }
    void this.tick();
    return { ok: true, id, management: roles.read(this.file).data.management };
  }
  fail(id, message) {
    if (history.load(this.file).journal.review?.id !== id) return;
    history.updateReview(this.file, id, j => { j.lastReview = { project: j.review.project, task: j.review.task, at: new Date().toISOString(), status: 'failed', message }; j.review = null; });
    this.notice?.(message);
  }
  cancel() {
    const p = history.load(this.file).journal.review;
    if (p) { this.removeQueued?.(p); this.fail(p.id, lt('見直しを中断しました。設定と最終見直し日時は維持しています')); }
    return roles.read(this.file).data;
  }
  async tick() {
    if (this.working) return;
    const p = history.load(this.file).journal.review;
    if (!p) return;
    if (p.status === 'running') {
      const problem = this.pendingError?.(p);
      if (problem) this.fail(p.id, problem);
      return;
    }
    this.working = true;
    try {
      this.target(p.project, p.task);
      if (!this.ready(p)) return;
      if (!p.plan) {
        history.updateReview(this.file, p.id, j => { j.review.status = 'checking'; j.review.message = lt('契約ログイン・モデル一覧・利用上限を確認しています'); });
        const available = await this.availability(p, TARGETS);
        if (history.load(this.file).journal.review?.id !== p.id) return;
        const participants = available.participants;
        if (!participants.length) throw Error(lt('Opus 5.5とGPT-6.1-Solを利用できません。') + available.reason);
        const plan = participants.length === 2 ? [participants[0], participants[1], participants[0]] : participants;
        history.updateReview(this.file, p.id, j => Object.assign(j.review, { plan, candidates: available.candidates, availability: available.reason, status: 'waiting' }));
      }
      const pending = history.load(this.file).journal.review;
      if (!pending || pending.id !== p.id) return;
      if (!this.ready(pending)) return;
      const slot = pending.plan[pending.stage], request = `role-review-${p.id}-${pending.stage}`;
      // Save intent before dispatch. A restart aborts instead of resending it.
      history.updateReview(this.file, p.id, j => Object.assign(j.review, { request, status: 'running', message: lt('役割を相談しています') + `（${pending.stage + 1}/${pending.plan.length}）` }));
      await this.dispatch({ ...pending, request, ...slot, text: this.prompt(pending) });
    } catch (e) { this.fail(p.id, e.message); }
    finally { this.working = false; }
  }
  prompt(p) {
    const final = p.stage === p.plan.length - 1;
    return [lt('人が［手動見直し］を押しました。全役割の主担当・思考・上限時交代先を検討してください。設定の保存はHubが行います。ファイル編集、CLI起動、委任API、追加課金、API従量課金、認証変更は禁止です。'),
      lt('最新という理由だけでは変更しません。役割適性・安定性・待ち時間・思考の効果に確かめられる改善根拠がある場合だけ変更します。能力や速度の数値を推測しません。モデル一覧は今回契約ログインで確認しましたが、一覧への掲載は全機能の動作保証ではありません。根拠不足なら現設定を維持してください。'),
      lt('標準は司令塔・チェック・最終確認がFable 5.1、調査・デザイン・文章がOpus 5.5、画像生成・コーディングがGPT-6.1-Solです。古いモデル（claude-opus-4-6等）には戻しません。Agyは既存の割当役割に限り今回確認した候補一覧から選択。デフォルト設定自体と利用上限の保持フラグは変更しません。'),
      lt('役割名・job・順序は維持してください。変更するモデルと思考は候補一覧のlabelとeffortsを正確に使います。思考がCLIから得られない場合は人が保存済みの組合せだけを使います。候補外の現設定はそのまま維持できます。'),
      '現在の設定：' + JSON.stringify(p.roles), '今回確認した候補：' + JSON.stringify(p.candidates),
      '利用可否：' + p.availability,
      ...p.responses.map((r, i) => `相談相手${i + 1}（起動設定 ${r.ai}/${r.model}）の意見：\n${r.text}`),
      final ? lt('相手の意見がある場合は検討して最善案を決めてください。追加承認は不要です。次の印の中にJSONを1個だけ返してください。rolesは全役割、reasonは全体の理由、evidenceは変更する役割ごとの改善理由と確認した根拠（資料・モデル一覧等）です。変更なしならevidenceは空配列です。') +
        `\n${OPEN}\n{"roles":[...],"reason":"...","evidence":[{"role":"...","reason":"...","sources":["..."]}]}\n${CLOSE}` : lt('相談案と改善の根拠を簡潔に返してください。次のAIがこの意見を検討します。')
    ].join('\n\n');
  }
  async settled(o, row) {
    const p = history.load(this.file).journal.review;
    if (!p || p.status !== 'running' || o.project !== p.project || o.task !== p.task || ![p.request, `limit-${p.request}`].includes(o.request)) return;
    try {
      if (row.error) {
        // Only ChatRunner's official limit handoff permits continuation.
        if (this.handoffPending?.(p)) return;
        throw Error(row.error);
      }
      if (row.asks?.length || !row.text?.trim()) throw Error(lt('見直しが判断まで完了しなかったため、設定は維持しました'));
      const actual = { ai: row.ai, model: launch.flagFor(row.ai, row.model) || row.model };
      const participants = [...p.participants.filter(x => x.ai !== actual.ai || x.model !== actual.model), actual];
      // A formal handoff can leave only one of the two requested models. Accept
      // a decision from that model, but never pretend two models participated.
      const final = p.stage === p.plan.length - 1;
      if (final) {
        const decision = result(row.text);
        validateDecision(decision, p.roles, p.candidates);
        const reasons = [decision.reason, ...(decision.evidence || []).map(e => `${e.role}：${e.reason}（${e.sources.join(' / ')}）`)].join('\n');
        const saved = roles.write(this.file, decision.roles, undefined, false, undefined, { reviewId: p.id, expectedRevision: p.baseRevision, reviewed: true, kind: 'review', reason: reasons, participants });
        if (!saved.ok) throw Error(saved.errors.join(' / '));
        this.notice?.(saved.data.management.lastReview.changed ? lt('役割の見直しを保存しました。次の起動から反映します。') : lt('役割の見直しが終わりました。変更はありません。'));
      } else {
        history.updateReview(this.file, p.id, j => { j.review.responses.push({ ...actual, text: row.text.slice(0, 24000) }); j.review.participants = participants; j.review.stage++; j.review.status = 'waiting'; j.review.message = lt('相談相手の検討を待っています'); });
      }
    } catch (e) { this.fail(p.id, e.message); }
  }
}
module.exports = { RoleReview, TARGETS, result, validateDecision };
