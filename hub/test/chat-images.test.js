'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { generatedImages, recoverImages } = require('../lib/chat-images');
const chat = require('../lib/chat');
const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
test('保存済み生成画像だけを同じsession・返信時間へ復元し、原文と他の返信を保持する', t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chat-images-'))), original = os.homedir;
  os.homedir = () => home;
  t.after(() => { os.homedir = original; fs.rmSync(home, { recursive: true, force: true }); });
  const dir = path.join(home, '.codex/generated_images', sid); fs.mkdirSync(dir, { recursive: true });
  const start = '2026-10-10T11:28:55.704Z', end = '2026-10-10T11:31:28.574Z';
  function image(name, when, data = 'image') {
    const file = path.join(dir, name); fs.writeFileSync(file, data); fs.utimesSync(file, new Date(when), new Date(when)); return file;
  }
  const file = image('generated.png', '2026-10-10T11:31:17Z');
  image('earlier.png', '2026-10-10T11:20:00Z'); image('later.png', '2026-10-10T12:00:00Z');
  image('empty.png', end, ''); image('other.txt', end);
  fs.symlinkSync(file, path.join(dir, 'alias.png')); fs.mkdirSync(path.join(dir, 'folder.png'));
  assert.deepEqual(generatedImages(sid, start, end), [{ path: file, name: 'generated.png' }]);
  for (const session of ['../' + sid, 'bad', 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee']) assert.deepEqual(generatedImages(session, start, end), []);
  assert.deepEqual(generatedImages(sid, 'invalid', end), []);
  // Named accounts save beneath their own CODEX_HOME, not the default account.
  const accountHome = path.join(home, 'account'), accountDir = path.join(accountHome, 'generated_images', sid);
  fs.mkdirSync(accountDir, { recursive: true });
  const accountFile = path.join(accountDir, 'account.png'); fs.copyFileSync(file, accountFile);
  fs.utimesSync(accountFile, new Date('2026-10-10T11:30:00Z'), new Date('2026-10-10T11:30:00Z'));
  assert.deepEqual(generatedImages(sid, start, end, accountHome), [{ path: accountFile, name: 'account.png' }]);
  const rows = [{ role: 'user', startedAt: start }, { role: 'assistant', ai: 'agy', at: end }, { role: 'assistant', ai: 'codex', at: end }];
  const recovered = recoverImages(rows, sid); assert.equal(rows[2].generatedImages, undefined);
  assert.equal(recovered[1], rows[1]); assert.equal(recovered[2].generatedImages[0].path, file);
  // Existing replies are enriched on read, without rewriting any log or metadata.
  const log = chat.files(home, 'topic').log; fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, rows.map(JSON.stringify).join('\n') + '\n'); chat.writeMeta(home, 'topic', { sessions: { codex: sid } });
  const before = fs.readFileSync(log); assert.equal(chat.read(home, 'topic')[2].generatedImages[0].path, file);
  assert.deepEqual(fs.readFileSync(log), before);
  chat.writeMeta(home, 'topic', { sessions: { codex: sid }, sessionAccounts: { codex: 'missing-account' } });
  assert.equal(chat.read(home, 'topic').length, rows.length);
  assert.equal(recoverImages([{ ...rows[2], generatedImages: [] }], sid)[0].generatedImages.length, 0);
  fs.renameSync(dir, dir + '-original'); fs.symlinkSync(dir + '-original', dir);
  assert.deepEqual(generatedImages(sid, start, end), []);
});
