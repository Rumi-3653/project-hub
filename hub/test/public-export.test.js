'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { excluded, selected, inspect } = require('../../scripts/export-public');
const entry = (name, text) => ({ name, content: Buffer.from(text) });
const publicNames = ['README.zh-TW.md', 'CONTRIBUTING.zh-TW.md', 'THIRD_PARTY_NOTICES.zh-TW.md',
  'docs/idea-ledger.md', 'docs/idea-ledger-verification.md',
  '.github/PULL_REQUEST_TEMPLATE/zh-TW.md', '.github/workflows/macos-app.yml'];
const sourceNames = ['langpacks/zh-TW/ui.json', 'hub/lib/locale.js',
  'langpacks/zh-TW/templates/project/.ai/rules.md',
  'langpacks/zh-TW/templates/_hub/roles.yaml', 'langpacks/zh-TW/seed/範例文件/.ai/tasks/example.md'];
test('Completed App updater exports its verifier and empty trust, excluding the private publisher and its DMG fixture', () => {
  for (const name of ['hub/lib/update-trust.js', 'hub/lib/app-update-packaged.js']) {
    assert.equal(selected(name, false), true); assert.equal(excluded(name), false);
  }
  for (const name of ['scripts/package-update.js', 'hub/test/app-update-packaged.test.js']) assert.equal(excluded(name), true);
});
test('Public overlay selects Chinese documents, PR templates and only the intended workflow', () => {
  for (const name of publicNames) assert.equal(selected(name, true), true, name);
  for (const name of ['.github/workflows/private.yml', '.github/secrets.txt', 'private.md']) assert.equal(selected(name, true), false, name);
});
test('Both template languages and fictional seeds remain selected and inspected', () => {
  for (const name of [...sourceNames, 'docs/project-hub/templates/project/.ai/rules.md', 'docs/project-hub/templates/_hub/roles.yaml', 'hub/seed/example/.ai/tasks/one.md']) {
    assert.equal(selected(name, false), true, name);
    assert.equal(excluded(name), false, name);
    assert.throws(() => inspect([entry(name, '-----BEGIN '+'PRIVATE KEY-----')]), /private key/);
  }
});
test('Chinese allowlists never expose personal ledger or runtime management metadata', () => {
  for (const name of ['hub/personal/.ai/tasks/private.md', 'hub/personal/_hub/config.json',
    'langpacks/zh-TW/templates/project/.ai/chat/private.md',
    'langpacks/zh-TW/seed/example/.ai/work/private.md', 'langpacks/zh-TW/seed/example/.ai/handoff/private.md',
    'langpacks/zh-TW/templates/_hub/state.log', 'langpacks/zh-TW/seed/example/_hub/accounts.json',
    'langpacks/zh-TW/seed/example/.codex/config.toml', 'langpacks/zh-TW/seed/example/.claude/settings.json']) assert.equal(excluded(name), true, name);
});
test('Secret files and generated outputs remain excluded inside all public allowlists', () => {
  for (const prefix of ['langpacks/zh-TW/seed/example/', 'langpacks/zh-TW/templates/project/']) {
    for (const tail of ['.env', '.env.local', '.npmrc', 'secret.key', 'private.pem', 'state.log', 'node_modules/file', 'public-release/file', '.git/config']) assert.equal(excluded(prefix+tail), true, prefix+tail);
  }
});
test('Public export excludes skill trees and detects renamed private specialty material', () => {
  for (const prefix of ['hub/', 'hub/seed/example/', 'docs/project-hub/templates/project/', 'langpacks/zh-TW/seed/example/']) {
    for (const tail of ['skills/example/SKILL.md', 'Skills/example/notes.md', 'SKILL.md', 'skill.MD']) {
      const name = prefix + tail;
      assert.equal(excluded(name), true, name);
      assert.throws(() => inspect([entry(name, 'Local instructions')]), /excluded path/);
    }
  }
  const names = ['human' + '-design', 'ヒューマン' + 'デザイン', '人類' + '圖', '人类' + '图', 'b' + 'g5', 'reference-gate-' + 'library', 'h' + 'dsl', '人类' + '设计', '人類' + '設計'];
  for (const name of names) {
    assert.throws(() => inspect([entry('hub/seed/example/notes.md', name)]), /private (specialty material|service)/);
    assert.throws(() => inspect([entry('hub/seed/' + name + '/notes.md', 'Renamed content')]), /private specialty path/);
  }
  assert.throws(() => inspect([entry('hub/seed/example/notes.md', names[1].normalize('NFD'))]), /private specialty material/);
  // The reader for locally installed skills is product code, not a bundled skill.
  assert.equal(excluded('hub/lib/skills.js'), false);
  assert.doesNotThrow(() => inspect([entry('hub/lib/skills.js', 'Local skill metadata reader')]));
});
test('Chinese documents and workflows still reject every privacy rule', () => {
  const privateTexts = ['k'+'kminim4', 'person'+'@invalid.example', 'gh'+'p_PRIVATE_TEST', 'sk-'+'0123456789abcdefgh',
    '-----BEGIN '+'PRIVATE KEY-----', 'h'+'dsl', 'https://discord.com/api/'+'webhooks/123/private', '192.'+'168.1.2', '/Users/'+'private'];
  for (const name of publicNames) for (const text of privateTexts) assert.throws(() => inspect([entry(name,text)]), /Public inspection failed/, name);
  assert.doesNotThrow(() => inspect([...publicNames,...sourceNames].map(name => entry(name,'Public documentation'))));
});
test('Reviewed literals are exact and file-specific; unknown binaries require review', () => {
  assert.doesNotThrow(() => inspect([entry('hub/lib/git.js','git'+'@github.com')]));
  assert.throws(() => inspect([entry('README.zh-TW.md','git'+'@github.com')]), /email/);
  assert.doesNotThrow(() => inspect([entry('hub/test/accounts.test.js','a'+'@example.test')]));
  assert.doesNotThrow(() => inspect([entry('hub/test/move.test.js','a'+'@example.test')]));
  assert.throws(() => inspect([entry('hub/test/move.test.js','other'+'@example.test')]), /email/);
  assert.throws(() => inspect([entry('README.zh-TW.md','a'+'@example.test')]), /email/);
  assert.throws(() => inspect([entry('hub/test/accounts.test.js','other'+'@example.test')]), /email/);
  assert.throws(() => inspect([entry('langpacks/zh-TW/seed/example/secret.png','not reviewed')]), /binary file needs review/);
});
test('CI keeps read-only permissions, Japanese core and optional pack tests, guard-preserving bundle build and signature verification', () => {
  const workflow=fs.readFileSync(path.resolve(__dirname,'../../.github/workflows/macos-app.yml'),'utf8');
  assert.match(workflow,/contents: read/);assert.ok(!workflow.includes('contents: write'));
  assert.match(workflow,/TMPDIR: \/private\/tmp/);assert.match(workflow,/HUB_SKIP_APP: "1"/);
  assert.match(workflow,/env -u HUB_LANG npm --prefix hub test/);assert.match(workflow,/npm --prefix hub run test:langpack/); assert.doesNotMatch(workflow,/HUB_LANG=zh-TW npm --prefix hub test/);
  assert.match(workflow,/HUB_BUNDLE_RUNTIME: "1"/);assert.match(workflow,/codesign --verify --deep --strict/);
  assert.ok(!/gh release|git push/.test(workflow));
});

test('retired Dot paths have no private-network export exceptions',()=>{
  for(const name of ['hub/lib/mcp-webhook.js','hub/test/mcp-events.test.js'])
    for(const text of ['10.'+'0.0.0','10.'+'1.1.1'])assert.throws(()=>inspect([entry(name,text)]),/private IP/);
});

test('Committed dry export includes all A-D runtime inputs and Chinese metadata without Git history or local outputs', () => {
  const {execFileSync}=require('node:child_process'),root=path.resolve(__dirname,'../..');
  const stdout=execFileSync(process.execPath,['scripts/export-public.js'],{cwd:root,encoding:'utf8',timeout:30000});
  assert.match(stdout,/inspection: 0 findings/);
  const output=path.join(root,'public-release/ProjectHub');
  for(const name of [...publicNames,'hub/lib/trash.js','hub/lib/app-update.js','hub/lib/app-update-workflow.js','hub/lib/app-update-packaged.js','hub/lib/update-trust.js',
    'hub/public/locale.js','hub/lib/locale.js','hub/lib/langpack.js']) assert.ok(fs.existsSync(path.join(output,name)),name);
  const installed = execFileSync('git',['ls-tree','--name-only','HEAD','langpacks/zh-TW/pack.json'],{cwd:root,encoding:'utf8'}).trim();
  if (installed) for (const name of ['langpacks/zh-TW/ui.json','langpacks/zh-TW/backend.json','langpacks/zh-TW/native.json',
    'langpacks/zh-TW/templates/project/.ai/rules.md','langpacks/zh-TW/templates/project/.ai/tasks/_template.md',
    'langpacks/zh-TW/templates/_hub/roles.yaml','langpacks/zh-TW/seed/Project Hub/.ai/tasks/sample-hub-01.md']) assert.ok(fs.existsSync(path.join(output,name)),name);
  else assert.equal(fs.existsSync(path.join(output,'langpacks/zh-TW')), false);
  for(const name of ['.git','.ai','hub/node_modules','hub/pr-c-ja-full.log','table-preview-dark.png','scripts/package-update.js','hub/test/app-update-packaged.test.js']) assert.equal(fs.existsSync(path.join(output,name)),false,name);
  assert.match(execFileSync('git',['check-ignore','public-release/ProjectHub/README.md'],{cwd:root,encoding:'utf8'}),/public-release/);
});

test('A committed new-language folder exports only pack data and repository tests, with ID matching', t => {
  const { execFileSync } = require('node:child_process'), os = require('node:os');
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-language-export-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const write = (name, value) => { const file = path.join(directory, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
  const source = path.resolve(__dirname, '../..');
  for (const name of [...publicNames.filter(name => !name.startsWith('.github/PULL')), 'README.md', 'CONTRIBUTING.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
    'scripts/export-public.js', 'scripts/public.gitignore', '.github/ISSUE_TEMPLATE/feedback.md', '.github/ISSUE_TEMPLATE/bug_report.md', '.github/ISSUE_TEMPLATE/config.yml',
    '.github/pull_request_template.md', 'hub/package.json', 'hub/CHANGELOG.md', 'hub/server.js', 'hub/mcp.js', 'hub/public/index.html', 'hub/lib/langpack.js', 'hub/lib/locale.js', 'hub/lib/version-check.js']) {
    write(name, fs.readFileSync(path.join(source, name)));
  }
  write('langpacks/en/pack.json', JSON.stringify({ id: 'en', name: 'Test English', verifiedWith: '4.109.1', dateLocale: 'en-US' }));
  write('langpacks/en/ui.json', '{}'); write('langpacks/en/backend.json', '{"messages":{},"labels":{}}');
  write('langpacks/en/docs/README.md', 'Test documentation'); write('langpacks/en/templates/project/.ai/rules.md', 'Test rules');
  write('langpacks/en/ui.css', 'must not export'); write('langpacks/en/install.js', 'must not export');
  write('langpacks/en/docs/theme.js', 'must not export'); write('langpacks/en/test/fixture.test.js', 'repository test fixture');
  write('langpacks/fr/pack.json', '{"id":"en"}'); write('langpacks/fr/ui.json', '{}');
  const git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8' });
  git(['init', '-q']); git(['add', '.']); git(['-c', 'user.name=Test', '-c', 'user.email=test' + '@example.invalid', 'commit', '-qm', 'Export fixture']);
  const result = execFileSync(process.execPath, ['scripts/export-public.js'], { cwd: directory, encoding: 'utf8', timeout: 30000 });
  assert.match(result, /inspection: 0 findings/);
  const output = path.join(directory, 'public-release/ProjectHub');
  for (const name of ['pack.json', 'ui.json', 'backend.json', 'docs/README.md', 'templates/project/.ai/rules.md', 'test/fixture.test.js']) assert.ok(fs.existsSync(path.join(output, 'langpacks/en', name)), name);
  for (const name of ['ui.css', 'install.js', 'docs/theme.js']) assert.equal(fs.existsSync(path.join(output, 'langpacks/en', name)), false, name);
  assert.equal(fs.existsSync(path.join(output, 'langpacks/fr')), false);
});
