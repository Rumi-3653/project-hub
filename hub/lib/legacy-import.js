'use strict';
// Additive local import. Never executes imported code or opens credentials.
const fs = require('node:fs'), path = require('node:path'), c = require('node:crypto');
const { excluded, atomic, inside, fileHash } = require('./move');
const { noLinks } = require('./license/storage');
const { parseDoc, parseYaml, setScalar } = require('./frontmatter');
const hash = b => c.createHash('sha256').update(b).digest('hex');
const check = (v, code) => { if (!v) throw Object.assign(Error(code), { status: 409 }); };
const missing = p => !fs.existsSync(p);
const privateName = n => /^(?:\.env(?:\..*)?|credentials.*|.*\.(?:pem|p12|pfx|key)|registration-(?:claimed|result)\.json)$/i.test(n);
function createRelocator(maps, talkIds) {
  const sorted = [...maps].sort((a,b) => b.from.length - a.from.length);
  const escaped = sorted.map(m => m.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const prefixes = new RegExp(escaped.join('|'), 'g');
  const plain = (text, talk) => {
    // One pass prevents a destination under another source prefix being rewritten again.
    let out = text.replace(prefixes, (s, offset, whole) => {
      const previous = whole[offset - 1];
      if (previous && /[\p{L}\p{N}_.\/\\-]/u.test(previous) && !/file:\/\/\/?$/.test(whole.slice(0, offset))) return s;
      const next = whole[offset + s.length];
      return next && !/[\/\\\s"'`),:;\]}]/.test(next) ? s : sorted.find(m => m.from === s).to;
    });
    if (talk) for (const [from, to] of talkIds) out = out.replace(new RegExp('(?<![\\w.-])' + from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w-])', 'g'), to);
    return out;
  };
  const json = (text, talk) => {
    // Validate before replacing string values. Preserve keys, whitespace and
    // unrelated escape sequences rather than reserializing the whole record.
    try { JSON.parse(text); } catch { check(false, 'import_format'); }
    return text.replace(/"(?:\\.|[^"\\])*"/g, (token, offset, whole) => {
      if (/^\s*:/.test(whole.slice(offset + token.length))) return token;
      const value = JSON.parse(token), moved = plain(value, talk);
      return moved === value ? token : JSON.stringify(moved);
    });
  };
  return (text, talk = false, format = '') => {
    if (format === '.json') return json(text, talk);
    if (format === '.jsonl') return text.replace(/[^\r\n]+/g, line => line.trim() ? json(line, talk) : line);
    if (format === '.yaml' || format === '.yml') {
      // The project's YAML subset also accepts literal backslashes in quotes.
      // Decode JSON-compatible double quotes and YAML single quotes; retain
      // literal-backslash scalars when they are not JSON-compatible.
      return text.split(/(\r?\n)/).map(line => {
        if (/^\s*#/.test(line)) return line;
        let end = 0, out = '';
        const quotes = /"(?:\\.|[^"\\])*"|'(?:''|[^'])*'/g;
        for (const m of line.matchAll(quotes)) {
          out += plain(line.slice(end, m.index), talk);
          const token = m[0];
          if (/^\s*:/.test(line.slice(m.index + token.length))) out += token;
          else if (token[0] === "'") {
            const value = token.slice(1,-1).replace(/''/g, "'"), moved = plain(value, talk);
            out += moved === value ? token : "'" + moved.replace(/'/g, "''") + "'";
          } else {
            let value;
            try { value = JSON.parse(token); } catch { /* Legacy literal-backslash scalar. */ }
            if (value === undefined) out += plain(token, talk);
            else {
              const moved = plain(value, talk);
              out += moved === value ? token : JSON.stringify(moved);
            }
          }
          end = m.index + token.length;
        }
        return out + plain(line.slice(end), talk);
      }).join('');
    }
    return plain(text, talk);
  };
}
function portableView(file) {
  const v=new (require('./model-view').ModelView)(file),data=v.read(true);
  const order=require('../public/model-order');
  return {order:v.saved(data),phone:v.phone(data),hidden:Object.fromEntries(order.ais.map(ai=>[ai,v.hidden(data)[ai].filter(s=>s.length<=180&&!/[\x00-\x1f]/.test(s)).slice(0,500)]))};
}
function portableRoles(text) {
  const raw = parseYaml(text), out = ['roles:'];
  for (const [name, role] of Object.entries(raw.roles || {})) {
    check(/^[\p{L}\p{N}_ -]{1,60}$/u.test(name), 'import_roles');
    const slots = [];
    for (const slot of ['main', 'backup']) {
      const a = role[slot]; if (!Array.isArray(a)) continue;
      check(a.length <= 3 && a.every(x => typeof x === 'string' && !/[\n\r\[\],#]/.test(x) && x.length <= 120), 'import_roles');
      check(['claude-code', 'codex', 'agy', 'grok', '人'].includes(a[0]), 'import_roles');
      slots.push(slot + ': [' + a.join(', ') + ']');
    }
    out.push('  ' + name + ': { ' + slots.join(', ') + ' }');
  }
  return out.length > 1 ? out.join('\n') + '\n' : '';
}
class LegacyImport {
  constructor({ root, home, freetalk, prepareTalk=()=>{}, busy = () => false, barrier = () => () => {}, fault = async () => {} }) {
    Object.assign(this, { root, home, freetalk, prepareTalk, busy, barrier, fault });
    this.dir = path.join(root, '_hub/legacy-import'); this.running = false; this.plans = new Map();
  }
  defaults() { return { workspace: path.join(this.home, 'Documents/AI-Workspace'), freetalk: path.join(this.home, 'Documents/freetalk') }; }
  source(p) {
    check(typeof p === 'string' && path.isAbsolute(p) && path.normalize(p) === p && inside(this.home, p) && p !== this.home, 'import_source');
    check(!inside(this.root, p) && !inside(p, this.root), 'import_overlap');
    check(!path.relative(this.home, p).split(path.sep).some(n => ['.ssh', '.codex', '.claude', '.gemini', '.grok', '.Trash', '.hub-accounts', 'Library', 'AppData'].includes(n)), 'import_source');
    noLinks(p); check(fs.statSync(p).isDirectory(), 'import_source'); return p;
  }
  async preview(input = {}) {
    check(!this.running && !this.busy(), 'import_busy');
    const source = this.source(input.workspace || this.defaults().workspace);
    const oldTalk = input.freetalk || this.defaults().freetalk;
    if (!missing(oldTalk)) this.source(oldTalk);
    const id = hash(source).slice(0, 16), folder = path.join(this.dir, id), journalFile = path.join(folder, 'journal.json'); noLinks(folder);
    if (fs.existsSync(journalFile)) {
      const j = JSON.parse(fs.readFileSync(journalFile)); this.validate(j);
      const token = c.randomUUID(); this.plans.set(token, { journal: j, folder });
      return { token, mode: j.complete ? 'complete' : 'interrupted', files: j.files.length, projects: j.projects, settings: j.settings, excluded: j.excluded };
    }
    const maps = [], projects = [], files = [], skipped = [], destinations = new Set(); let total=0;
    const storage = path.join(this.root, 'Imported', id);
    const addMap = (from, to) => { if (!maps.some(m => m.from === from)) maps.push({ from, to }); };
    addMap(source, path.join(storage, 'workspace'));
    const product = path.join(source, 'Product'); noLinks(product);
    for (const name of fs.readdirSync(product)) {
      check(!/[\\\0\r\n]/.test(name), 'import_name');
      const ledger = path.join(product, name); noLinks(ledger);
      if (!fs.statSync(ledger).isDirectory() || missing(path.join(ledger, 'PROJECT.md'))) continue;
      if (name === 'freetalk') continue;
      let target = path.join(this.root, 'Product', name);
      if (!missing(target)) target += '-import-' + id;
      check(missing(target), 'import_destination_exists');
      addMap(ledger, target); projects.push({ name, target });
      const doc = parseDoc(fs.readFileSync(path.join(ledger, 'PROJECT.md'), 'utf8')).data;
      for (const value of Object.values(doc.folders || {})) {
        if (typeof value !== 'string') continue;
        const loc = value.startsWith('~') ? path.join(this.home, value.slice(1)) : path.resolve(ledger,value);
        if (inside(source, loc)) continue;
        this.source(loc);
        check(!inside(loc, source), 'import_overlap');
        addMap(loc, path.join(storage, 'bodies', hash(loc).slice(0, 16)));
      }
    }
    const talkLedger = path.join(product, 'freetalk');
    const hasTalk = !missing(talkLedger) || !missing(oldTalk);
    const talkIds = new Map();
    if (hasTalk) {
      check(!missing(talkLedger) && !missing(oldTalk), 'import_freetalk_pair');
      const markerFile = path.join(oldTalk, '.ai/freetalk.json'); noLinks(markerFile);
      const marker = JSON.parse(fs.readFileSync(markerFile));
      noLinks(path.join(talkLedger, 'PROJECT.md'));
      const meta = parseDoc(fs.readFileSync(path.join(talkLedger, 'PROJECT.md'), 'utf8')).data;
      check(marker.owner && marker.owner === meta.freetalkOwner && marker.ledger === talkLedger, 'import_freetalk_pair');
      addMap(oldTalk, this.freetalk); addMap(talkLedger, path.join(this.root, 'Product/freetalk'));
      const tasks=path.join(talkLedger,'.ai/tasks');noLinks(tasks);
      for (const name of missing(tasks)?[]:fs.readdirSync(tasks)) {
        if (!name.endsWith('.md')) continue;
        const task = name.slice(0, -3); check(/^[\w.-]+$/.test(task), 'import_topic');
        // Always namespace old topics: current conversations are never merged by accident.
        talkIds.set(task, 'import-' + id + '-' + task);
      }
    }
    const relocate = createRelocator(maps, talkIds);
    async function collect(base, dest, rel = '', talk = false, targetRoot = dest, onlyName) {
      noLinks(base);
      for (const name of onlyName === undefined ? fs.readdirSync(base) : [onlyName]) {
        const r = rel ? rel + '/' + name : name, from = path.join(base, name);
        check(!/[\\\0\r\n]/.test(name), 'import_name');
        if (excluded(r, false) || privateName(name) || name === '.git' || name === 'Work' || name === '_hub') { skipped.push(r); continue; }
        const s = fs.lstatSync(from); check(!s.isSymbolicLink(), 'import_link');
        // freetalk's rules/identity come from the destination's own registration.
        if (talk && (['PROJECT.md', 'AGENTS.md', 'CLAUDE.md', '.ai/rules.md', '.ai/freetalk.json'].includes(r))) continue;
        let output = path.join(dest, name);
        if (talk) for (const [id, next] of talkIds) {
          if (name === id || name.startsWith(id + '.')) { output = path.join(dest, next + name.slice(id.length)); break; }
        }
        if (s.isDirectory()) { await collect(from, output, r, talk, targetRoot); continue; }
        if (talk && !output.split(path.sep).some(part=>[...talkIds.values()].some(id=>part===id || part.startsWith(id+'.')))) { skipped.push(r); continue; }
        // Old queues, CLI sessions, continuations and automatic idea/promotion
        // journals are records, never live instructions on the new installation.
        const archived = r.startsWith('.ai/') && !(/^\.ai\/tasks\/[^/]+\.md$/.test(r) || r==='.ai/rules.md' || /^\.ai\/(?:memory|chat\/history)\/.*\.md$/.test(r) || /^\.ai\/chat\/[^/]+\.jsonl$/.test(r));
        if(archived) output=path.join(storage,'archived-metadata',hash(targetRoot).slice(0,16),r);
        check(s.isFile() && s.nlink === 1 && s.size <= 128 * 1024 * 1024, 'import_file');
        let bytes = fs.readFileSync(from);
        check(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(bytes.toString('latin1')), 'import_secret');
        const sha256 = hash(bytes);
        if (/\.(?:md|json|jsonl|yaml|yml|txt)$/i.test(name)) {
          let text = relocate(bytes.toString('utf8'), talk, path.extname(name).toLowerCase());
          if (!talk && r === 'PROJECT.md') {
            const meta=parseDoc(bytes.toString('utf8')).data;
            for (const [label,value] of Object.entries(meta.folders || {})) {
              if (typeof value !== 'string') continue;
              const expanded=value.startsWith('~') ? path.join(osHome,value.slice(1)) : path.resolve(base,value);
              const remapped=relocate(expanded);
              check(remapped!==expanded || inside(storage,remapped),'import_unmapped_folder');
              const lines=text.split('\n'); let inFolders=false;
              for(let i=0;i<lines.length;i++) {
                if(/^folders:/.test(lines[i])) {inFolders=true;continue;}
                if(inFolders && /^\S/.test(lines[i])) inFolders=false;
                if(inFolders && lines[i].trimStart().startsWith(label+':')) lines[i]='  '+label+': '+require('./frontmatter').scalar(remapped);
              }
              text=lines.join('\n');
            }
          }
          // Old worktrees are intentionally not copied. Reopen imported tasks
          // against their imported project body; never keep an old workdir.
          if (r.startsWith('.ai/tasks/') && name.endsWith('.md')) {
            const body = talk ? talkDestination : projects.find(p => inside(p.target, output))?.body;
            text = text.replace(/^(workdir:)[^\r\n]*/m, '$1 ' + (body || storage));
            text = text.replace(/^workspaceMode:[^\r\n]*/m, 'workspaceMode: direct');
            text = setScalar(text,'continuation',false);
            text = setScalar(text,'state',parseDoc(text).data.state==='完了'?'完了':'未着手');
            text = setScalar(text,'question','');
          }
          bytes = Buffer.from(text);
        }
        check(!destinations.has(output) && missing(output), 'import_destination_exists'); destinations.add(output);
        files.push({ from, to: output, inputSha: sha256, sha256: hash(bytes), size: bytes.length, mode: s.mode & 0o777 & ~0o022, bytes });
        total+=bytes.length; check(total<=512*1024*1024,'import_too_large');
        check(files.length < 100000, 'import_too_many');
      }
    }
    const osHome=this.home, talkDestination=this.freetalk;
    // Copy ledgers and mapped source trees separately; no current data is replaced.
    for (const p of projects) {
      const meta = parseDoc(fs.readFileSync(path.join(product, p.name, 'PROJECT.md'), 'utf8')).data;
      const oldBody = meta.folders?.['本体'];
      const expanded = typeof oldBody === 'string' ? oldBody.startsWith('~') ? path.join(this.home, oldBody.slice(1)) : path.resolve(product,p.name,oldBody) : null;
      p.body = typeof expanded === 'string' ? relocate(expanded) : p.target;
    }
    for (const p of projects) await collect(path.join(product, p.name), p.target);
    const bodies = maps.filter(m => !inside(product, m.from) && m.from !== oldTalk && m.from !== source);
    for (const m of bodies) await collect(m.from, m.to);
    // Remaining workspace content contains project bodies and materials, never runtime settings.
    for (const name of fs.readdirSync(source)) {
      if (['Product', 'Work', '_hub', 'Backups'].includes(name)) continue;
      if (excluded(name, false) || privateName(name) || name === '.git') { skipped.push(name); continue; }
      const from = path.join(source, name); noLinks(from);
      if (fs.statSync(from).isDirectory()) await collect(from, path.join(storage, 'workspace', name));
      else await collect(source, path.join(storage, 'workspace'), '', false, path.join(storage, 'workspace'), name);
    }
    if (hasTalk) { await collect(talkLedger, path.join(this.root, 'Product/freetalk'), '', true); await collect(oldTalk, this.freetalk, '', true); }
    const settings = { roles: '', view:'', preserved: '今の設定を優先。以前の担当・モデルとモデル表示設定は別に保存し、確認して適用できます。認証・購入情報・権限・端末固有設定は移しません。配色などブラウザ内の設定は手動で選び直してください。' };
    const rolesFile = path.join(source, '_hub/roles.yaml'); noLinks(rolesFile);
    if (!missing(rolesFile)) {
      const bytes = Buffer.from(portableRoles(fs.readFileSync(rolesFile, 'utf8')));
      if (bytes.length) {
        const to = path.join(folder, 'previous-roles.yaml');
        files.push({ from: rolesFile, to, inputSha: await fileHash(rolesFile), sha256: hash(bytes), size: bytes.length, mode: 0o600, bytes }); settings.roles = to;
      }
    }
    const viewFile=path.join(source,'_hub/model-view.json');noLinks(viewFile);
    if(!missing(viewFile)) {
      const bytes=Buffer.from(JSON.stringify(portableView(viewFile))+'\n'),to=path.join(folder,'previous-view.json');
      files.push({from:viewFile,to,inputSha:await fileHash(viewFile),sha256:hash(bytes),size:bytes.length,mode:0o600,bytes});settings.view=to;
    }
    const token = c.randomUUID();
    // PROJECT.md and topic task indexes appear only after their related data.
    files.sort((a,b) => Number(/(?:PROJECT\.md|\.ai\/tasks\/[^/]+\.md)$/.test(a.to)) - Number(/(?:PROJECT\.md|\.ai\/tasks\/[^/]+\.md)$/.test(b.to)));
    const journal = { version: 1, source, id, files, projects, topics: [...talkIds.values()], settings, excluded: [...new Set(skipped)], complete: false };
    this.plans.clear(); this.plans.set(token, { journal, folder });
    return { token, mode: 'preview', projects, topics: talkIds.size, files: files.length, settings, excluded: journal.excluded, notice: '元と今のデータを残して追加します。同名プロジェクト・話題は別名です。Git登録・作業用コピー・認証は移しません。' };
  }
  validate(j) {
    check(j?.version === 1 && Array.isArray(j.files) && j.files.length < 100000 && j.id === hash(j.source).slice(0, 16) && Array.isArray(j.projects) && Array.isArray(j.topics), 'import_journal');
    check(typeof j.source==='string' && path.normalize(j.source)===j.source && inside(this.home, j.source) && !inside(this.root, j.source) && !inside(j.source,this.root), 'import_journal');
    check(j.topics.every(id=>typeof id==='string' && new RegExp('^import-'+j.id+'-[\\w.-]+$').test(id)), 'import_journal');
    const storage = path.join(this.root, 'Imported', j.id), roles = path.join(this.dir,j.id,'previous-roles.yaml'), view=path.join(this.dir,j.id,'previous-view.json'), seen = new Set();
    const ledgers = j.projects.map(p => {
      check(typeof p.name === 'string' && p.name !== 'freetalk' && path.basename(p.name) === p.name, 'import_journal');
      const initial = path.join(this.root,'Product',p.name), suffix = initial + '-import-' + j.id;
      check(p.target === initial || p.target === suffix, 'import_journal'); return p.target;
    });
    for (const f of j.files) {
      check(typeof f.to === 'string' && path.normalize(f.to) === f.to && !seen.has(f.to), 'import_journal'); seen.add(f.to);
      const talkRel = inside(this.freetalk,f.to) ? path.relative(this.freetalk,f.to) : inside(path.join(this.root,'Product/freetalk'),f.to) ? path.relative(path.join(this.root,'Product/freetalk'),f.to) : null;
      const talkAllowed = talkRel && !['PROJECT.md','AGENTS.md','CLAUDE.md','.ai/rules.md','.ai/freetalk.json'].includes(talkRel.split(path.sep).join('/')) && j.topics.some(id => id.startsWith('import-'+j.id+'-') && talkRel.split(path.sep).some(part=>part===id || part.startsWith(id+'.')));
      check(f.to === roles || f.to === view || inside(storage,f.to) && f.to !== storage || ledgers.some(p=>inside(p,f.to) && f.to !== p) || talkAllowed, 'import_journal');
      check(typeof f.from==='string' && path.normalize(f.from)===f.from && inside(this.home,f.from) && !inside(this.root,f.from) && !privateName(path.basename(f.from)), 'import_journal');
      noLinks(f.to); check(/^[a-f0-9]{64}$/.test(f.sha256) && Number.isSafeInteger(f.mode) && (f.mode & ~0o755) === 0, 'import_journal');
    }
  }
  async apply(token) {
    check(!this.running && !this.busy(), 'import_busy');
    const plan = this.plans.get(token); check(plan, 'import_preview_required');
    const { journal: j, folder } = plan; this.validate(j); const unblock=this.barrier(); this.running = true;
    try {
      const record = path.join(folder, 'journal.json'), stage = path.join(folder, 'stage'); noLinks(folder);
      if (j.complete) return { mode: 'complete', projects: j.projects, settings: j.settings };
      if (j.files.some(f => f.bytes)) {
        fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
        for (let i=0; i<j.files.length; i++) {
          const f=j.files[i]; noLinks(f.from); check(await fileHash(f.from) === f.inputSha, 'import_source_changed');
          const part=path.join(stage, String(i));
          if (!missing(part)) check(await fileHash(part) === f.sha256, 'import_stage_changed');
          else { const fd=fs.openSync(part, 'wx', 0o600); try { fs.writeFileSync(fd, f.bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
        }
        j.files.forEach(f=>delete f.bytes); await atomic(record, j);
      }
      if(j.topics.length) this.prepareTalk();
      // No-clobber exclusive publication. Partial publication is hash-checked on resume.
      for (let i=0; i<j.files.length; i++) {
        const f=j.files[i], part=path.join(stage, String(i)); noLinks(part); noLinks(f.to);
        check(await fileHash(part) === f.sha256, 'import_stage_changed');
        if (!missing(f.to)) check(await fileHash(f.to) === f.sha256, 'import_destination_changed');
        else {
          fs.mkdirSync(path.dirname(f.to), { recursive: true, mode: 0o700 }); noLinks(f.to);
          // Stage next to the destination, then publish atomically without
          // replacing anything. An interrupted copy never claims the final name.
          const tmp=f.to+'.import-'+j.id; noLinks(tmp);
          if (missing(tmp)) fs.copyFileSync(part,tmp,fs.constants.COPYFILE_EXCL);
          check(await fileHash(tmp) === f.sha256,'import_partial_file'); fs.chmodSync(tmp,f.mode);
          const fd=fs.openSync(tmp, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
          fs.linkSync(tmp,f.to); fs.unlinkSync(tmp);
        }
        // Recover the narrowly owned temporary hardlink if interruption happened
        // between publication and unlink. Never remove an unrelated file.
        const tmp=f.to+'.import-'+j.id;
        if(!missing(tmp)) {const a=fs.statSync(tmp),b=fs.statSync(f.to);check(a.ino===b.ino&&a.dev===b.dev,'import_partial_file');fs.unlinkSync(tmp);}
        if(process.platform==='win32') require('./platform').persistence.syncDirectory(path.dirname(f.to));
        else {const fd=fs.openSync(path.dirname(f.to),'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
        await this.fault(i);
      }
      j.complete=true; await atomic(record, j);
      return { mode: 'complete', projects: j.projects, settings: j.settings, notice: '引き継ぎました。元データと今の設定は保持しています。' };
    } finally { this.running=false; unblock(); }
  }
  settings(token) {
    const plan=this.plans.get(token); check(plan?.journal.complete,'import_incomplete'); this.validate(plan.journal);
    const read=file=>{const f=plan.journal.files.find(f=>f.to===file);check(f && hash(fs.readFileSync(file))===f.sha256,'import_settings_changed');return fs.readFileSync(file,'utf8');};
    const {roles,view}=plan.journal.settings;
    const current=path.join(this.root,'_hub/model-view.json');noLinks(current);
    return { roles:roles?require('./roles').normalize(parseYaml(read(roles))).roles:[],view:view?JSON.parse(read(view)):null,viewRevision:missing(current)?'missing':hash(fs.readFileSync(current)) };
  }
  async applyView(token,revision) {
    check(!this.running&&!this.busy(),'import_busy');const settings=this.settings(token);check(settings.view,'import_settings_changed');
    check(revision===settings.viewRevision,'import_settings_changed');const unblock=this.barrier();this.running=true;
    try {
      const file=path.join(this.root,'_hub/model-view.json'),backup=path.join(this.plans.get(token).folder,'view-before-apply.json');noLinks(backup);
      if(missing(backup))await atomic(backup,{present:!missing(file),value:missing(file)?null:JSON.parse(fs.readFileSync(file))});
      const v=new (require('./model-view').ModelView)(file);v.write({...v.read(true),...settings.view});return {applied:true};
    }finally{this.running=false;unblock();}
  }
}
module.exports = { LegacyImport, portableRoles, createRelocator };
