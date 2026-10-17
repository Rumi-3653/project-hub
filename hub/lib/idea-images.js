'use strict';
// Immutable, ledger-owned originals. Upload is independent of conversation/terminal intake.
const fs = require('node:fs'), path = require('node:path'), { execFileSync } = require('node:child_process');
const U = require('./idea-utils'), { noLinks } = require('./remove');
const MAX = 20 * 1024 * 1024, COUNT = 10, TOTAL = 50 * 1024 * 1024;
function format(bytes, name) {
  let ext, type;
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) [ext, type] = ['png', 'image/png'];
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) [ext, type] = ['jpg', 'image/jpeg'];
  else if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())) [ext, type] = ['gif', 'image/gif'];
  else if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') [ext, type] = ['webp', 'image/webp'];
  U.check(ext && new RegExp('\\.(' + (ext === 'jpg' ? 'jpe?g' : ext) + ')$', 'i').test(name), 'image-format', 'PNG・JPEG・GIF・WebPの画像を選んでください。形式と中身が一致する必要があります。', 400);
  return { ext, type };
}
function safeRead(file, max = MAX) {
  noLinks(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { const st = fs.fstatSync(fd); U.check(st.isFile() && st.nlink === 1 && st.size > 0 && st.size <= max, 'image-file', '保存画像の容量・所属を照合できません', 503); return fs.readFileSync(fd); }
  finally { fs.closeSync(fd); }
}
function fileOf(s, image, preview = false) {
  U.check(image && /^[a-f0-9]{64}$/.test(image.hash) && ['png', 'jpg', 'gif', 'webp'].includes(image.ext) && /^[a-f0-9]{64}$/.test(image.previewHash), 'image-reference', '画像の保存記録を照合してください', 503);
  const file = path.join(s.controlDir, 'images', image.hash + (preview ? '.preview.png' : '.' + image.ext)); noLinks(file); return file;
}
function verify(s, image, preview = false) {
  const file = fileOf(s, image, preview), bytes = safeRead(file, preview ? 160 * 1024 * 1024 : MAX);
  U.check(U.hash(bytes) === (preview ? image.previewHash : image.hash) && (preview || bytes.length === image.bytes), 'image-integrity', '保存画像が変更されています。原本の照合が必要です', 503);
  return { file, bytes, type: preview ? 'image/png' : image.type };
}
function keep(ideas, file, bytes) {
  noLinks(file); ideas.outside(path.dirname(file)); fs.mkdirSync(path.dirname(file), { recursive: true }); noLinks(file);
  if (fs.existsSync(file)) U.check(U.hash(safeRead(file, 160 * 1024 * 1024)) === U.hash(bytes), 'image-integrity', '保存画像を上書きできません', 503);
  else ideas.atomic.recoverAtomic(file, bytes);
  ideas.syncFile(file); ideas.atomicDirectory(file);
  U.check(U.hash(safeRead(file, 160 * 1024 * 1024)) === U.hash(bytes), 'image-integrity', '画像を安全に保存できませんでした', 503);
}
function upload(ideas, project, b, bytes) {
  U.opId(b.opId); U.check(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX, 'image-size', '画像は1枚20MBまでです', 413);
  const name = typeof b.name === 'string' ? b.name.normalize('NFC') : '';
  U.check(name && name.length <= 200 && !/[\\/\x00-\x1f\x7f]/.test(name), 'image-name', '画像のファイル名を確認してください', 400);
  const { ext, type } = format(bytes, name), hash = U.hash(bytes);
  const out = ideas.mutate(project, b.opId, { kind: 'image', name, hash, bytes: bytes.length }, (d, s) => {
    const dir = path.join(s.controlDir, 'images'), file = path.join(dir, hash + '.' + ext), preview = path.join(dir, hash + '.preview.png');
    keep(ideas, file, bytes); ideas.fault('image-original', { file, op: b.opId });
    // Local OS decoder validates the image, bounds pixel allocation and creates a CLI-readable PNG.
    const staging = path.join(s.controlDir, 'image-staging', b.opId); noLinks(staging); fs.mkdirSync(staging, { recursive: true });
    let decoded, output;
    try {
      const info = execFileSync('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
      const w = Number(info.match(/pixelWidth:\s*(\d+)/)?.[1]), h = Number(info.match(/pixelHeight:\s*(\d+)/)?.[1]);
      U.check(w > 0 && h > 0, 'image-decode', '画像を読み取れませんでした', 400);
      U.check(w * h <= 40000000, 'image-dimensions', '画像は4000万画素までです', 413);
      output = path.join(staging, U.uuid() + '.png');
      execFileSync('/usr/bin/sips', ['-s', 'format', 'png', file, '--out', output], { timeout: 15000, maxBuffer: 65536, stdio: 'pipe' });
      decoded = safeRead(output, 160 * 1024 * 1024);
      U.check(decoded.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')), 'image-decode', '画像を読み取れませんでした', 400);
    } catch (e) { if (e.code === 'image-dimensions') throw e; throw U.fail('image-decode', '画像を読み取れません。PNGかJPEGに書き出し直して追加してください。', 400); }
    keep(ideas, preview, decoded);
    fs.unlinkSync(output); // Only this conversion's scratch file, after both durable copies are verified.
    ideas.fault('image-preview', { file: preview, op: b.opId });
    const image = { id: b.opId, projectUid: d.projectUid, name, hash, bytes: bytes.length, ext, type, previewHash: U.hash(decoded) };
    (d.images ||= {})[image.id] = image; return { image };
  });
  if(out.removed)return out;
  verify(ideas.resolve(project), out.image); verify(ideas.resolve(project), out.image, true); return out;
}
function select(ideas, project, d, ids = []) {
  U.check(Array.isArray(ids) && ids.length <= COUNT && new Set(ids).size === ids.length, 'image-count', '画像は重複なしで10枚までです', 400);
  const images = ids.map(id => { U.opId(id); const image = d.images?.[id]; U.check(image && image.projectUid === d.projectUid, 'image-owner', 'この台帳に保存した画像を選んでください', 400); verify(ideas.resolve(project), image); verify(ideas.resolve(project), image, true); return U.clone(image); });
  U.check(images.reduce((n, i) => n + i.bytes, 0) <= TOTAL, 'image-total', '画像は合計50MBまでです', 413); return images;
}
function references(ideas, project, item) {
  const d = ideas.read(project), s = ideas.resolve(project);
  return (item.images || []).map(image => {
    U.check(U.hash(d.images?.[image.id]) === U.hash(image), 'image-owner', '画像の所属を照合してください', 503);
    verify(s, image); return { ...image, path: verify(s, image, true).file, originalPath: fileOf(s, image) };
  });
}
// Keep the pre-image grant format byte-for-byte for existing text-only items.
function grantScope(i) { return { text: i.text, ...(i.images?.length ? { images: i.images } : {}), answers: i.questions.filter(q => q.answer !== undefined).map(q => ({ id: q.id, answer: q.answer })), dependencies: i.dependencies.filter(d => d.origin === 'human') }; }
module.exports = { format, safeRead, MAX, COUNT, TOTAL, upload, select, references, verify, fileOf, grantScope };
