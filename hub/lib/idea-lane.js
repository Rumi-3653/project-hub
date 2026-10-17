'use strict';
const fs = require('node:fs'), scope = require('./resource-scope'), U = require('./idea-utils');
const expand = p => p?.startsWith('~/') ? require('node:path').join(require('node:os').homedir(), p.slice(2)) : p;
function binding(dir) {
  const realpath = fs.realpathSync(dir), gitCommonReal = scope.commonGit(realpath);
  U.check(gitCommonReal, 'lane-git', 'Gitの作業場所が必要です');
  U.check(U.git(realpath, ['rev-parse', '--show-toplevel']) === realpath, 'lane-root', '登録されたGitの作業場所を選んでください');
  const branchRef = U.git(realpath, ['symbolic-ref', '-q', 'HEAD']);
  return { realpath, identity: U.identity(realpath), gitCommonReal, branchRef };
}
function sameBinding(expected, actual) { return ['realpath','identity','gitCommonReal','branchRef'].every(k => U.hash(expected[k]) === U.hash(actual[k])); }
class IdeaLane {
  constructor({ ideas, store = ideas.store, baseOf = ideas.baseOf || (p => p.dir), gate, profiles } = {}) { Object.assign(this, { ideas, store, baseOf, gate, profiles }); }
  inspect(project, task) {
    const p = this.ideas.project(project), t = p.tasks?.find(t => t.id === task);
    U.check(t && t.kind === 'main' && !t.parent && t.workspaceMode === 'isolated' && t.workdir, 'lane-task', '既存の隔離された本作業を選んでください');
    const src = binding(expand(t.workdir)), target = binding(this.baseOf(p));
    U.check(src.realpath !== target.realpath && src.gitCommonReal === target.gitCommonReal, 'lane-worktree', '本体と同じGitの作業用コピーが必要です');
    const list = U.git(src.realpath, ['worktree', 'list', '--porcelain']).split('\n').filter(x => x.startsWith('worktree ')).map(x => scope.canonical(x.slice(9)));
    U.check(list.includes(src.realpath) && list.includes(target.realpath), 'lane-worktree', '登録されたworktreeを確認できません');
    return { task, workdirReal: src.realpath, workdirIdentity: src.identity, gitCommonReal: src.gitCommonReal, branchRef: src.branchRef, baseReal: target.realpath, targetBinding: target };
  }
  candidates(project) {
    const p = this.ideas.project(project); return (p.tasks || []).flatMap(t => { try { const l = this.inspect(project,t.id); return [{ task:t.id,title:t.title,...l }]; } catch { return []; } });
  }
  set(project, b) {
    const fresh = this.inspect(project,b.task); if (b.testProfile) this.profiles?.get(b.testProfile);
    const out = this.ideas.settings(project,b,d => {
      U.check(!Object.values(d.runs).some(r => !r.closed && !['not-sent','cancelled'].includes(r.delivery) || r.needsReconcile&&!r.reconcileRun) && !Object.values(d.releases).some(r => ['preparing','reviewing','ready','applying'].includes(r.state)), 'lane-busy','作業の区切りで実行先を変更してください');
      if(d.settings.lane&&fs.existsSync(d.settings.lane.workdirReal)){const old=U.snapshot(d.settings.lane.workdirReal);U.check(!old.dirty&&!old.merging,'lane-busy','元の開発場所の未保存変更を先に照合してください');}
      d.settings.lane = { ...fresh,bindingRev:(d.settings.lane?.bindingRev || 0)+1 }; if (b.testProfile) d.settings.testProfile = b.testProfile;
      this.ideas.stale(d,'lane changed');
    }); this.gate?.register(project,fresh.workdirReal); return out;
  }
  resolve(project, expectedRev) {
    const lane = this.ideas.read(project).settings.lane; U.check(lane, 'lane-missing', '実行先を設定してください');
    U.check(!expectedRev || lane.bindingRev === expectedRev,'lane-changed','実行先が変更されました');
    const fresh = this.inspect(project,lane.task);
    U.check(U.hash(fresh) === U.hash(Object.fromEntries(Object.entries(lane).filter(([k])=>k!=='bindingRev'))),'lane-binding','実行先の場所・Git・ブランチが変わっています');
    this.gate?.register(project,lane.workdirReal); return lane;
  }
}
module.exports = { IdeaLane, binding, sameBinding };
