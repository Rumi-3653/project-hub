'use strict';
// These fixtures keep the existing Japanese error-message contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reveal-http-'));
const home = path.join(root, 'home');
const originalHomedir = os.homedir;
os.homedir = () => home;
process.env.HUB_ROOT = root;
process.env.HUB_DRY_RUN = '1';
process.env.HUB_AI_HOME = home;
const project = '子育て支援センター探しプロジェクト', task = '20261008-01';
const product = path.join(root, 'Product'), ledger = path.join(product, project);
const body = path.join(root, 'System', project), work = path.join(root, 'Work', project, task);
function write(file, text = 'fixture') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}
for (const dir of [home, body, work]) fs.mkdirSync(dir, { recursive: true });
write(path.join(ledger, 'PROJECT.md'), `---\nname: ${project}\nfolders:\n  本体: ${body}\n---\n`);
write(path.join(ledger, '.ai/tasks', task + '.md'), `---\nid: ${task}\nworkdir: ${work}\n---\n`);
let server, base;
test.before(async () => {
  const probe = require('node:net').createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  process.env.HUB_PORT = String(port);
  ({ server } = require('../server'));
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + port;
});
test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  os.homedir = originalHomedir;
  fs.rmSync(root, { recursive: true, force: true });
});
async function reveal(file, extra = {}, headers = {}) {
  const response = await fetch(base + '/api/reveal', {
    method: 'POST', headers: { 'X-Hub': '1', 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ project, task, path: file, how: 'info', ...extra })
  });
  return { status: response.status, body: await response.json() };
}
const pixels = fs.readFileSync(path.join(__dirname, '../public/icon.png'));
const viewUrl = file => base + '/api/file/view?' + new URLSearchParams({ project, task, path: file });
const viewImage = (file, headers = {}) => fetch(viewUrl(file), { headers });
async function resolves(raw, expected, extra) {
  const result = await reveal(raw, extra);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.path, expected);
  return result.body;
}

test('プロジェクト名から始まる再現例をProduct基準で解決し、開き方を保持する', async () => {
  const raw = `${project}/作業/${task}/説明資料.pdf`, file = write(path.join(product, raw));
  const info = await resolves(raw, file);
  assert.equal(info.dir, false); assert.equal(info.r, undefined);
  assert.equal(info.view, true); assert.equal(info.viewKind, 'pdf'); assert.equal(info.remote, false);
  for (const how of ['finder', 'open']) {
    const result = await resolves(raw, file, { how });
    assert.deepEqual(result.r.args, how === 'finder' ? ['-R', file] : [file]);
  }
  const app = await resolves(raw, file, { how: 'open', app: true });
  assert.equal(app.byApp, true); assert.equal(app.how, 'open');
  await resolves(raw, file, { project: '', task: '' });
});

for (const [name, dir] of [['作業用コピー', work], ['本体', body], ['台帳', ledger], ['ワークスペース', root]]) {
  test(`${name}基準の相対パスを従来どおり解決する`, async () => {
    const raw = `${name}/固有資料.pdf`;
    await resolves(raw, write(path.join(dir, raw)));
  });
}
test('ホーム記号と絶対パスを従来どおり解決する', async () => {
  const file = write(path.join(home, '資料/絶対.pdf'));
  await resolves('~/資料/絶対.pdf', file);
  await resolves(file, file);
});
test('同名ファイルは作業用コピー→本体→台帳→ROOT→Productの順で選ぶ', async () => {
  const raw = '同名.pdf', files = [work, body, ledger, root, product].map(dir => write(path.join(dir, raw)));
  for (const file of files) {
    await resolves(raw, file);
    fs.unlinkSync(file);
  }
  assert.equal((await reveal(raw)).status, 404);
});
test('ホーム外・ROOT外とその隣接名への絶対/相対参照は拒否する', async () => {
  const outside = root + '-outside', file = write(path.join(outside, '秘密.pdf'));
  try {
    for (const raw of [file, path.relative(product, file), path.relative(ledger, file)]) {
      assert.equal((await reveal(raw)).status, 404, raw);
    }
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
});
test('新旧候補の読み取り拒否は403のまま、後順位の同名ファイルへ迂回しない', async () => {
  const originalReaddir = fs.readdirSync;
  for (const dir of [work, product]) {
    const blocked = path.join(dir, '拒否フォルダ'), file = write(path.join(blocked, '秘密.pdf'));
    write(path.join(product, '拒否フォルダ/秘密.pdf'));
    fs.readdirSync = function (candidate, ...args) {
      if (path.resolve(candidate) === blocked) throw Object.assign(Error('denied fixture'), { code: 'EACCES' });
      return originalReaddir.call(this, candidate, ...args);
    };
    try {
      for (const how of ['info', 'list', 'open', 'finder']) {
        const result = await reveal('拒否フォルダ/秘密.pdf', { how, app: true });
        assert.equal(result.status, 403); assert.match(result.body.error, /Mac の許可/);
        assert.equal(result.body.byApp, undefined);
      }
      assert.equal((await viewImage('拒否フォルダ/秘密.pdf')).status, 403);
    } finally { fs.readdirSync = originalReaddir; fs.unlinkSync(file); }
  }
});

test('画像を同じ候補順で配信し、種類・内容・キャッシュ抑止を返す', async () => {
  const formats = [['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['gif', 'image/gif'], ['webp', 'image/webp'], ['PNG', 'image/png']];
  for (const [ext, type] of formats) {
    const raw = `画像/空 白&名前.${ext}`, file = write(path.join(work, raw), pixels);
    const info = await resolves(raw, file);
    assert.equal(info.view, true); assert.equal(info.viewKind, 'image'); assert.equal(info.remote, false);
    const response = await viewImage(raw);
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), type);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('content-disposition'), 'inline');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), pixels);
  }
  const raw = '画像/同名.png', locations = [work, body, ledger, root, product];
  for (const [i, dir] of locations.entries()) write(path.join(dir, raw), Buffer.concat([pixels, Buffer.from(String(i))]));
  for (const [i, dir] of locations.entries()) {
    const response = await viewImage(raw);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.concat([pixels, Buffer.from(String(i))]));
    fs.unlinkSync(path.join(dir, raw));
  }
  const homeImage = write(path.join(home, '画像.png'), pixels);
  for (const raw of ['~/画像.png', homeImage]) assert.equal((await viewImage(raw)).status, 200);
  // fetchはHostを書き換えないため、実際のHTTPヘッダーでアクセス制御を確かめる。
  const status = await new Promise((resolve, reject) => {
    require('node:http').get(viewUrl(homeImage), { headers: { Host: 'evil.example' } }, response => {
      response.resume(); resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(status, 403);
});

test('画像以外・フォルダ・不存在・home/ROOT外・外を指すリンクは配信しない', async () => {
  for (const ext of ['html', 'svg', 'heic', 'xlsx', 'pptx', 'key', 'pages', 'numbers', 'zip']) {
    const file = write(path.join(work, '対象外.' + ext));
    assert.equal((await resolves(file, file)).view, false);
    assert.equal((await viewImage(file)).status, 415);
  }
  const folder = path.join(work, 'フォルダ.png'); fs.mkdirSync(folder);
  assert.equal((await viewImage(folder)).status, 415);
  for (const raw of ['/etc/hosts', '/etc/hosts.png', '不存在.png']) assert.equal((await viewImage(raw)).status, 404);
  const outside = root + '-outside', external = write(path.join(outside, '秘密.png'), pixels);
  try {
    for (const raw of [external, path.relative(work, external)]) assert.equal((await viewImage(raw)).status, 404);
    const linked = path.join(work, '外へのリンク.png'); fs.symlinkSync(external, linked);
    assert.equal((await resolves(linked, linked)).view, false);
    assert.equal((await viewImage(linked)).status, 404);
    const linkedDir = path.join(work, '外のフォルダ'); fs.symlinkSync(outside, linkedDir);
    assert.equal((await viewImage(path.join(linkedDir, '秘密.png'))).status, 404);
    const internal = write(path.join(home, '内部.png'), pixels), alias = path.join(work, '内部リンク.png');
    fs.symlinkSync(internal, alias);
    assert.equal((await resolves(alias, alias)).view, true);
    assert.deepEqual(Buffer.from(await (await viewImage(alias)).arrayBuffer()), pixels);
    // 実体確認後、open直前に外向きリンクへ交換されても配信しない。
    const changing = write(path.join(work, '交換.png'), pixels), open = fs.openSync;
    fs.openSync = function (candidate, ...args) {
      if (candidate === fs.realpathSync(changing)) {
        fs.unlinkSync(changing); fs.symlinkSync(external, changing);
      }
      return open.call(this, candidate, ...args);
    };
    try { assert.equal((await viewImage(changing)).status, 404); }
    finally { fs.openSync = open; }
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
});

test('30MBまでは表示でき、それを超えるファイルはinfoでも対象外になる', async () => {
  const file = write(path.join(work, '大きい.png'), pixels), fd = fs.openSync(file, 'r+');
  const limit = 30 * 1024 * 1024;
  try {
    fs.ftruncateSync(fd, limit);
    assert.equal((await resolves(file, file)).view, true);
    const response = await viewImage(file);
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-length'), String(limit));
    await response.body.cancel();
    fs.ftruncateSync(fd, limit + 1);
    assert.equal((await resolves(file, file)).view, false);
    assert.equal((await viewImage(file)).status, 415);
  } finally { fs.closeSync(fd); }
});

test('PDFと各テキスト形式は内容を変えず、安全ヘッダー付きで配信する', async () => {
  for (const ext of ['pdf', 'txt', 'md', 'csv', 'tsv', 'json', 'log', 'yaml', 'yml']) {
    const contents = ext === 'pdf' ? '%PDF-1.7\nfixture' : '# 見出し\n<script>bad()</script>\n本文';
    const file = write(path.join(work, '資料.' + ext), contents), info = await resolves(file, file);
    assert.equal(info.view, true); assert.equal(info.viewKind, ext === 'pdf' ? 'pdf' : 'text');
    const response = await viewImage(file);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), ext === 'pdf' ? 'application/pdf' : 'text/plain; charset=utf-8');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('content-disposition'), 'inline');
    assert.equal(await response.text(), contents);
  }
});
test('PDFの先頭・末尾・開いた範囲と不正なRangeを扱う', async () => {
  const contents = '%PDF-1.7\nfixture', file = write(path.join(work, '範囲.pdf'), contents);
  for (const [range, start, end] of [['bytes=0-0', 0, 0], ['bytes=3-', 3, contents.length - 1], ['bytes=-4', contents.length - 4, contents.length - 1], ['bytes=0-999', 0, contents.length - 1]]) {
    const response = await viewImage(file, { Range: range });
    assert.equal(response.status, 206); assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${contents.length}`);
    assert.equal(await response.text(), contents.slice(start, end + 1));
  }
  for (const range of ['bytes=999-', 'bytes=3-1', 'bytes=-0', 'bytes=-', 'bytes=0-0,2-2', 'invalid']) {
    const response = await viewImage(file, { Range: range }); assert.equal(response.status, 416);
    assert.equal(response.headers.get('content-range'), `bytes */${contents.length}`); await response.text();
  }
});
test('Word等4形式を実際のtextutilでHTMLへ変換しCSP sandboxを付ける', async () => {
  const { execFileSync } = require('child_process');
  for (const ext of ['docx', 'doc', 'rtf', 'odt']) {
    const bytes = execFileSync('/usr/bin/textutil', ['-convert', ext, '-format', 'txt', '-inputencoding', 'UTF-8', '-stdin', '-stdout'], { input: 'Document fixture 日本語 <safe>', timeout: 15000 });
    const file = write(path.join(work, '文書.' + ext), bytes), info = await resolves(file, file);
    assert.equal(info.viewKind, 'doc');
    const response = await fetch(viewUrl(file) + '&as=html'); assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(response.headers.get('content-security-policy'), "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const html = await response.text(); assert.match(html, /Document fixture/); assert.match(html, /日本語/); assert.match(html, /&lt;safe&gt;/);
  }
});
test('文書変換の失敗・時間切れ・出力上限は汎用エラーだけを返す', async () => {
  const cp = require('child_process'), original = cp.execFile, file = write(path.join(work, '変換失敗.docx'));
  try {
    for (const [error, status] of [[Error('private path and contents'), 415], [Object.assign(Error('timeout'), { killed: true }), 500], [Object.assign(Error('overflow'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), 500]]) {
      cp.execFile = (bin, args, options, cb) => {
        assert.equal(bin, '/usr/bin/textutil'); assert.ok(args.includes('-stdin')); assert.ok(!args.includes(file));
        assert.equal(options.timeout, 15000); assert.equal(options.maxBuffer, 5 * 1024 * 1024);
        const stdin = new (require('stream').PassThrough)(); stdin.resume(); queueMicrotask(() => cb(error, 'secret html'));
        return { stdin };
      };
      const response = await viewImage(file); assert.equal(response.status, status);
      const body = await response.text(); assert.match(body, /このファイルを表示できません/); assert.doesNotMatch(body, /private|secret|timeout|overflow/);
    }
  } finally { cp.execFile = original; }
});
test('実textutilが終了0でも壊れた文書の空出力は415にする', async () => {
  const file = write(path.join(work, '壊れた.docx'), 'invalid document');
  const response = await viewImage(file); assert.equal(response.status, 415);
  assert.doesNotMatch(await response.text(), /invalid document|stdin|correct format/);
});
test('PDF50MB・テキスト2MB・文書20MBの上限前後を確認する', async () => {
  const cp = require('child_process'), original = cp.execFile;
  cp.execFile = (bin, args, options, cb) => { const stdin = new (require('stream').PassThrough)(); stdin.resume(); queueMicrotask(() => cb(null, '<html><body>fixture</body></html>')); return { stdin }; };
  try {
    for (const [ext, mb] of [['pdf', 50], ['txt', 2], ['docx', 20]]) {
      const file = write(path.join(work, '上限.' + ext)), fd = fs.openSync(file, 'r+'), limit = mb * 1024 * 1024;
      try {
        for (const size of [limit - 1, limit]) {
          fs.ftruncateSync(fd, size); assert.equal((await resolves(file, file)).view, true);
          const response = await viewImage(file); assert.equal(response.status, 200); await response.body.cancel();
        }
        fs.ftruncateSync(fd, limit + 1); const info = await resolves(file, file);
        assert.equal(info.view, false); assert.equal(info.viewKind, ''); assert.equal((await viewImage(file)).status, 415);
      } finally { fs.closeSync(fd); }
    }
  } finally { cp.execFile = original; }
});
test('PDF・テキスト・文書も外を指すリンクとopen直前の交換を拒否する', async () => {
  const outside = root + '-documents-outside';
  try {
    for (const ext of ['pdf', 'md', 'docx']) {
      const external = write(path.join(outside, '秘密.' + ext), 'external'), linked = path.join(work, '外への文書リンク.' + ext);
      fs.symlinkSync(external, linked);
      assert.equal((await resolves(linked, linked)).view, false); assert.equal((await viewImage(linked)).status, 404);
      const changing = write(path.join(work, '交換文書.' + ext)), open = fs.openSync;
      fs.openSync = function (candidate, ...args) { if (candidate === changing) { fs.unlinkSync(changing); fs.symlinkSync(external, changing); } return open.call(this, candidate, ...args); };
      try { assert.equal((await viewImage(changing)).status, 404); } finally { fs.openSync = open; }
    }
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
});

test('外からは従来のログインが必要で、画像閲覧を遠隔操作として記録する', async () => {
  const headers = { 'X-Forwarded-Host': 'fixture.tailnet.ts.net', 'X-Forwarded-For': '100.64.0.7' };
  const file = write(path.join(work, '遠隔.png'), pixels);
  assert.equal((await viewImage(file, headers)).status, 403);
  const post = (route, body, extra = {}) => fetch(base + route, { method: 'POST', headers: { 'X-Hub': '1', 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });
  assert.equal((await post('/api/remote', { enabled: true, passcode: 'fixture-image-pass' })).status, 200);
  assert.equal((await viewImage(file, headers)).status, 401);
  assert.equal((await viewImage(file, { ...headers, Cookie: 'hub_session=forged' })).status, 401);
  const login = await post('/api/login', { passcode: 'fixture-image-pass' }, headers);
  assert.equal(login.status, 200);
  const authenticated = { ...headers, Cookie: login.headers.get('set-cookie').split(';')[0] };
  const info = await reveal(file, {}, authenticated);
  assert.equal(info.status, 200); assert.equal(info.body.view, true); assert.equal(info.body.remote, true);
  const response = await viewImage(file, authenticated);
  assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), pixels);
  for (const [ext, kind, contents] of [['pdf', 'pdf', '%PDF-fixture'], ['md', 'text', '本文'], ['rtf', 'doc', '{\\rtf1 fixture}']]) {
    const document = write(path.join(work, '遠隔文書.' + ext), contents);
    assert.equal((await viewImage(document, headers)).status, 401);
    const info = await reveal(document, {}, authenticated); assert.equal(info.body.viewKind, kind); assert.equal(info.body.remote, true);
    const response = await viewImage(document, authenticated); assert.equal(response.status, 200); await response.text();
  }
  const log = fs.readFileSync(path.join(root, '_hub/log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(log.some(row => row.action === 'fileview' && row.remote && row.project === project && row.task === task && row.path === file && row.kind === 'image'));
  assert.deepEqual(log.filter(row => row.action === 'fileview').map(row => row.kind), ['image', 'pdf', 'text', 'doc']);
});
