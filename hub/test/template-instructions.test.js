'use strict';
process.env.HUB_LANG = 'ja';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../lib/store');
const templates = path.join(__dirname, '../../docs/project-hub/templates');
const read = file => fs.readFileSync(file, 'utf8');
const cases = [
  {
    language: 'ja', base: templates,
    identity: ai => `あなたは ${ai}。役割と作業IDは起動時に伝えられる。`,
    permissions: /許可済み作業内の通常操作は再確認不要/,
    approval: /本体反映・push・公開・本番適用は対象・変更・検証を示し人へ最終確認/,
    ruleApproval: /本体反映・push・公開・本番適用は、対象・変更・検証結果を示して人の最終確認/,
    artifactHeading: '## 成果と保管', artifactFormat: '### 「## 成果」の書き方',
  },
  {
    language: 'zh-TW', base: path.join(__dirname, '../../langpacks/zh-TW/templates'),
    identity: ai => `你是 ${ai}，啟動時會告知角色與任務ID。`,
    permissions: /已授權範圍內的一般操作不需再次確認/,
    approval: /合併、push、發布與正式環境套用須列出對象、變更與驗證結果，交由人做最終確認/,
    ruleApproval: /合併到主專案、push、發布與正式環境套用須列出對象、變更與驗證結果，取得人的最終確認/,
    artifactHeading: '## 成果與保存', artifactFormat: '### 「## 成果」的寫法',
  },
];

for (const spec of cases) {
  test(`${spec.language}: CLI入口は名前とAI名以外を同期し、読込先と500字上限を保つ`, () => {
    const project = path.join(spec.base, 'project');
    const bodies = [];
    for (const [file, ai] of [['CLAUDE.md', 'Claude Code'], ['AGENTS.md', 'Codex']]) {
      const text = read(path.join(project, file));
      const [heading, identity, ...body] = text.split('\n');
      assert.equal(heading, `# ${file}`);
      assert.equal(identity, spec.identity(ai));
      assert.ok([...text].length <= 500, `${file}: ${[...text].length} characters`);
      assert.match(text, spec.permissions);
      assert.match(text, spec.approval);
      for (const ref of ['.ai/rules.md', 'PROJECT.md', '.ai/tasks/']) assert.ok(text.includes(ref), ref);
      for (const ref of ['.ai/rules.md', 'PROJECT.md', '.ai/tasks/_template.md']) assert.ok(fs.existsSync(path.join(project, ref)), ref);
      bodies.push(body.join('\n'));
    }
    assert.equal(bodies[0], bodies[1]);
  });

  test(`${spec.language}: 新規プロジェクトへ権限・成果規則と両CLI入口を欠落なく写す`, t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-template-instructions-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = new Store(root);
    const source = path.join(spec.base, 'project');
    const result = store.createProject({ name: `Template-${spec.language}` }, source);
    assert.ok(!result.error, result.error);
    const dir = result.project.dir;
    for (const file of ['CLAUDE.md', 'AGENTS.md', '.ai/rules.md']) {
      assert.deepEqual(fs.readFileSync(path.join(dir, file)), fs.readFileSync(path.join(source, file)), file);
    }
    const rules = read(path.join(dir, '.ai/rules.md'));
    assert.match(rules, spec.ruleApproval);
    assert.ok(rules.includes(spec.artifactHeading));
    assert.ok(rules.includes(spec.artifactFormat));
    const policy = rules.slice(rules.indexOf(spec.artifactHeading), rules.indexOf(spec.artifactFormat));
    assert.deepEqual([...policy.matchAll(/^(\d)\. /gm)].map(m => m[1]), ['1', '2', '3', '4', '5', '6']);
    // Both languages keep the artifact parser's record markers and path bases.
    for (const marker of ['body:', 'project:', '## 成果', '- ファイル：作業/<作業ID>/確認結果.md', '- 本体保存済み：', '- なし：']) {
      assert.ok(rules.includes(marker), marker);
    }
    assert.equal(result.project.status, '進行中');
    assert.deepEqual(store.readProject(result.project.id).tasks, []);
    assert.ok(!fs.existsSync(path.join(dir, '_hub')), 'role settings are not copied into a project');
  });
}
