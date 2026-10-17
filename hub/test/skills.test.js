'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { listSkills } = require('../lib/skills');
const { Accounts } = require('../lib/accounts');
function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-skills-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const accounts = { home, location: ai => path.join(home, '.' + ai) };
  const add = (ai, folder, text = '---\nname: Sample\ndescription: Sample use\n---\nPRIVATE BODY') => {
    const dir = path.join(home, '.' + ai, 'skills', folder); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), text); return dir;
  };
  return { home, accounts, add, list: (fresh = false) => listSkills({ accounts, fresh }) };
}
test('Only direct user skills and Codex system skills are listed, with bounded metadata and no body or file paths', t => {
  const f = fixture(t);
  f.add('claude', 'user'); f.add('codex', 'user', '---\nname: Codex user\ndescription: Draw\n---');
  f.add('codex', '.system/imagegen', '---\nname: imagegen\ndescription: Image\n---');
  f.add('claude', '.system/hidden'); f.add('codex', '_backup/copy'); f.add('codex', '.hidden'); f.add('codex', 'synced/nested');
  fs.mkdirSync(path.join(f.home, '.codex/skills/empty'));
  const result = f.list();
  assert.deepEqual(result.ais.codex.items, [{ name: 'Codex user', description: 'Draw', source: 'user' }, { name: 'imagegen', description: 'Image', source: 'system' }]);
  assert.equal(result.ais.claude.items.length, 1);
  assert.equal(result.ais.codex.dir, '~/.codex/skills');
  assert.equal(result.ais.claude.found, true);
  assert.deepEqual(result.ais.agy, { dir: '', found: false, items: [] });
  assert.deepEqual(result.ais.grok, { dir: '', found: false, items: [] });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE BODY|SKILL\.md|hub-skills-/);
});
test('Quoted, folded and literal descriptions, missing and malformed headers degrade safely', t => {
  const f = fixture(t);
  f.add('codex', 'quoted', '---\nname: "Quoted"\ndescription: "Use: # <script>"\n---');
  f.add('codex', 'folded', '---\nname: Folded\ndescription: >-\n  first line\n  next: line\nother: something\n---');
  f.add('codex', 'literal', '---\nname: Literal\ndescription: |\n  first\n  second\n---');
  f.add('codex', 'empty', '---\ndescription: false\n---');
  f.add('codex', 'broken', '---\nname: Should not leak\ndescription: oops\n');
  f.add('codex', 'plain', '# no header\n');
  const byName = Object.fromEntries(f.list().ais.codex.items.map(item => [item.name, item.description]));
  assert.equal(byName.Quoted, 'Use: # <script>');
  assert.equal(byName.Folded, 'first line next: line');
  assert.equal(byName.Literal, 'first second');
  for (const name of ['empty', 'broken', 'plain']) assert.equal(byName[name], '');
});
test('Reading is limited to 16 KiB and descriptions to 200 characters, including emoji', t => {
  const f = fixture(t);
  f.add('codex', 'long', '---\nname: Long\ndescription: ' + '🧵'.repeat(210) + '\n---\n' + 'BODY-SECRET'.repeat(10000));
  f.add('codex', 'oversized-header', '---\ndescription: ' + 'x'.repeat(17000) + '\n---\n');
  const original = fs.readSync, sizes = [];
  fs.readSync = function(fd, bytes, offset, length, position) { sizes.push(length); return original.call(this, fd, bytes, offset, length, position); };
  t.after(() => { fs.readSync = original; });
  const items = f.list().ais.codex.items;
  assert.equal(Array.from(items.find(item => item.name === 'Long').description).length, 200);
  assert.equal(items.find(item => item.name === 'oversized-header').description, '');
  assert.ok(sizes.length >= 2 && sizes.every(size => size <= 16384));
  assert.doesNotMatch(JSON.stringify(items), /BODY-SECRET/);
});
test('Directory links are followed and duplicate real files counted once per AI; broken and non-file links are ignored', t => {
  const f = fixture(t), dir = f.add('codex', 'original');
  fs.symlinkSync(dir, path.join(f.home, '.codex/skills/alias'));
  fs.symlinkSync(path.join(f.home, 'missing'), path.join(f.home, '.codex/skills/broken'));
  const other = f.add('claude', 'shared');
  fs.unlinkSync(path.join(other, 'SKILL.md')); fs.symlinkSync(path.join(dir, 'SKILL.md'), path.join(other, 'SKILL.md'));
  const notFile = path.join(f.home, '.codex/skills/not-file'); fs.mkdirSync(path.join(notFile, 'SKILL.md'), { recursive: true });
  assert.equal(f.list().ais.codex.items.length, 1);
  assert.equal(f.list().ais.claude.items.length, 1);
});
test('Missing directories and empty directories stay distinct; enumeration stops at 200 skills', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.home, '.claude/skills'), { recursive: true });
  assert.equal(f.list().ais.claude.found, true); assert.equal(f.list().ais.codex.found, false);
  for (let i = 0; i < 201; i++) f.add('codex', 's' + i);
  const row = f.list(true).ais.codex;
  assert.equal(row.items.length, 200); assert.equal(row.limited, true);
});
test('Cache lasts 30 seconds, refresh bypasses it, and a changed account location invalidates it', t => {
  const f = fixture(t); f.add('claude', 'one');
  const before = f.list(); f.add('claude', 'two');
  assert.strictEqual(f.list(), before);
  assert.equal(f.list(true).ais.claude.items.length, 2);
  f.add('claude', 'three');
  const now = Date.now; Date.now = () => now() + 31000; t.after(() => { Date.now = now; });
  assert.equal(f.list().ais.claude.items.length, 3);
  f.accounts.location = () => path.join(f.home, 'another');
  assert.equal(f.list().ais.claude.found, false);
});
test('Default Accounts location honors CLAUDE_CONFIG_DIR and CODEX_HOME and masks only the home path boundary', t => {
  const f = fixture(t), keys = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'], old = keys.map(key => process.env[key]);
  t.after(() => keys.forEach((key, i) => { if (old[i] === undefined) delete process.env[key]; else process.env[key] = old[i]; }));
  const accounts = new Accounts({ home: f.home, file: path.join(f.home, 'accounts.json'), dry: true });
  f.add('claude', 'configured'); f.add('codex', 'configured');
  process.env.CLAUDE_CONFIG_DIR = path.join(f.home, '.claude'); process.env.CODEX_HOME = path.join(f.home, '.codex');
  assert.equal(listSkills({ accounts }).ais.claude.items.length, 1);
  assert.equal(listSkills({ accounts }).ais.codex.dir, '~/.codex/skills');
  process.env.CODEX_HOME = f.home + '-external';
  assert.equal(listSkills({ accounts }).ais.codex.dir, f.home + '-external/skills');
});
