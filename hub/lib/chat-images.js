'use strict';
// Built-in generated images are saved outside the text-only CLI stream.
// Read only the selected Codex session and the time window of this reply.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { noLinks } = require('./remove');
function sessionImages(session, codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(session || '')) return [];
  const dir = path.join(codexHome, 'generated_images', session);
  try {
    noLinks(dir);
    return fs.readdirSync(dir).filter(name => /\.(png|jpe?g|gif|webp)$/i.test(name)).flatMap(name => {
      try {
        const file = path.join(dir, name), stat = fs.lstatSync(file);
        return stat.isFile() && stat.size > 0 && stat.size <= 30 * 1024 * 1024
          ? [{ path: file, name, mtime: stat.mtimeMs }] : [];
      } catch { return []; } // One disappearing file must not hide the other images.
    });
  } catch { return []; }
}
function inWindow(images, start, end) {
  const from = Date.parse(start), until = Date.parse(end);
  if (!Number.isFinite(from) || !Number.isFinite(until) || until < from) return [];
  return images.filter(x => x.mtime >= from && x.mtime <= until).map(({ path, name }) => ({ path, name }));
}
function generatedImages(session, start, end, codexHome) {
  return inWindow(sessionImages(session, codexHome), start, end);
}
function recoverImages(rows, session, codexHome) {
  let start, candidates;
  return rows.map(row => {
    if (row.role === 'user') start = row.startedAt || row.at;
    if (row.role !== 'assistant' || row.ai !== 'codex' || row.generatedImages !== undefined) return row;
    candidates ||= sessionImages(session, codexHome);
    const images = inWindow(candidates, start, row.at);
    return images.length ? { ...row, generatedImages: images } : row;
  });
}
module.exports = { generatedImages, recoverImages };
