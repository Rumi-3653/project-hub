'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { fixture, U } = require('./idea-fixture.cjs'), { Ideas } = require('../lib/ideas'), IM = require('../lib/idea-images');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8DA8B+MgBgAHfAD/dPQfSYAAAAASUVORK5CYII=', 'base64');
const upload = (f, more = {}, bytes = PNG) => f.ideas.uploadImage('P', { opId: U.uuid(), name: 'スクショ.png', ...more }, bytes);
const add = (f, refs, more = {}) => f.ideas.add('P', { opId: U.uuid(), text: '', images: refs.map(x => x.image.id), intent: 'record', ...more }, { human: true });
test('images: 原本・PNG参照・画像だけ/本文付き複数・再開・同じopの照合・手編集md保全', t => {
  const f = fixture(t, { bind: false }), b = { opId: U.uuid(), name: 'スクショ.png' }, a = upload(f, b), a2 = upload(f, { name: '参考.png' });
  assert.deepEqual(f.ideas.image('P', a.image.id).bytes, PNG); assert.equal(upload(f, b).image.id, a.image.id);
  assert.throws(() => upload(f, { ...b, name: '別.png' }), e => e.code === 'op-conflict');
  const r = add(f, [a]), s = f.ideas.resolve('P'); fs.writeFileSync(s.md, '人の手編集\n'); const both = add(f, [a, a2], { text: '説明付き' });
  assert.equal(f.ideas.read('P').items[r.id].text, ''); assert.equal(f.ideas.read('P').items[r.id].grant, null); assert.equal(f.ideas.read('P').settings.auto.enabled, false);
  assert.equal(f.ideas.read('P').items[both.id].images.length, 2); assert.equal(fs.readFileSync(s.md, 'utf8'), '人の手編集\n');
  f.ideas.close(); const reopened = new Ideas({ store: f.store }); t.after(() => reopened.close()); assert.deepEqual(reopened.image('P', a.image.id).bytes, PNG); assert.equal(reopened.receipt('P', b.opId).image.hash, U.hash(PNG));
  assert.deepEqual(fs.readdirSync(path.join(s.controlDir,'image-staging',b.opId)),[]);
  assert.deepEqual(fs.readdirSync(path.join(s.controlDir,'image-staging',a2.image.id)),[]);
});
test('images: PNG保存失敗時は原本を保全し、再開成功で今回の中間PNGだけを除く',t=>{
  const f=fixture(t,{bind:false});f.ideas.initialize('P',U.uuid());const b={opId:U.uuid(),name:'再開.png'},s=f.ideas.resolve('P'),other=path.join(s.controlDir,'image-staging',U.uuid(),'keep.png');
  fs.mkdirSync(path.dirname(other),{recursive:true});fs.writeFileSync(other,PNG);const sync=f.ideas.atomicDirectory.bind(f.ideas);let armed=true;
  f.ideas.atomicDirectory=file=>{if(armed&&file.endsWith('.preview.png')){armed=false;throw Error('preview-sync-failed');}return sync(file);};
  assert.throws(()=>upload(f,b),/preview-sync-failed/);assert.equal(f.ideas.receipt('P',b.opId).saved,false);
  const staging=path.join(s.controlDir,'image-staging',b.opId),preserved=fs.readdirSync(staging);assert.equal(preserved.length,1);const original=path.join(s.controlDir,'images',U.hash(PNG)+'.png');assert.deepEqual(fs.readFileSync(original),PNG);
  const a=upload(f,b);assert.deepEqual(f.ideas.image('P',a.image.id).bytes,PNG);assert.equal(f.ideas.receipt('P',b.opId).saved,true);assert.deepEqual(fs.readdirSync(staging),preserved);
  assert.equal(upload(f,b).image.id,a.image.id);assert.deepEqual(fs.readdirSync(staging),preserved);assert.deepEqual(fs.readFileSync(other),PNG);assert.deepEqual(fs.readFileSync(path.join(staging,preserved[0])).subarray(0,8),PNG.subarray(0,8));
});
test('images: 偽形式・破損・空・容量・枚数・総容量・他所属・URL/パスを拒否', t => {
  const f = fixture(t, { bind: false });
  for (const [name, bytes] of [['x.svg', Buffer.from('<svg/>')], ['x.jpg', PNG], ['x.png', Buffer.alloc(50)], ['x.png', PNG.subarray(0, 16)]]) assert.throws(() => upload(f, { name }, bytes), e => ['image-format', 'image-decode'].includes(e.code));
  assert.throws(() => upload(f, {}, Buffer.alloc(IM.MAX + 1)), e => e.status === 413); assert.throws(() => upload(f, {}, Buffer.alloc(0)), e => e.status === 413);
  assert.throws(() => upload(f, { name: '../a.png' }), e => e.code === 'image-name');
  const a = upload(f); assert.throws(() => add(f, Array(11).fill(a)), e => e.code === 'image-count'); assert.throws(() => add(f, [a, a]), e => e.code === 'image-count');
  assert.throws(() => add(f, [{ image: { id: U.uuid() } }]), e => e.code === 'image-owner');
  assert.throws(() => f.ideas.add('P', { opId: U.uuid(), text: '', images: ['https://example.com/x.png'] }, { human: true }), e => e.code === 'op-id');
  const dir2=path.join(f.root,'Product/Q');fs.mkdirSync(dir2,{recursive:true});const read=f.store.readProject;f.store.readProject=id=>id==='Q'?{...f.project,id:'Q',dir:dir2}:read(id);
  assert.throws(()=>f.ideas.add('Q',{opId:U.uuid(),text:'',images:[a.image.id]},{human:true}),e=>e.code==='image-owner');

});
for (const stage of ['image-original', 'image-preview', 'staging', 'intent', 'rename', 'directory-sync']) test('images: upload耐久境界の停止とreceipt復旧 ' + stage, t => {
  const f = fixture(t, { bind: false }); f.ideas.initialize('P', U.uuid()); const b = { opId: U.uuid(), name: '原本.png' }; let armed = true;
  f.ideas.fault = (at, { file }) => { if (armed && at === stage && (at.startsWith('image-') || file.endsWith('/ideas.json'))) { armed = false; throw Error('fault-' + stage); } };
  assert.throws(() => upload(f, b), /fault/); f.ideas.close(); const reopened = new Ideas({ store: f.store }); t.after(() => reopened.close());
  const receipt = reopened.receipt('P', b.opId); assert.equal(receipt.saved, ['intent','rename','directory-sync'].includes(stage));
  const result = reopened.uploadImage('P', b, PNG); assert.equal(Object.keys(reopened.read('P').images).length, 1); assert.deepEqual(reopened.image('P', result.image.id).bytes, PNG);
  assert.deepEqual(fs.readdirSync(path.join(reopened.resolve('P').controlDir,'image-staging',b.opId)),[]);
});
test('images: JPEG・GIF・WebPも原本を保持し、CLI用PNGで参照できる', t => {
  const f=fixture(t,{bind:false}),input=path.join(f.root,'source.png'),jpg=path.join(f.root,'source.jpg');fs.writeFileSync(input,PNG);
  require('node:child_process').execFileSync('/usr/bin/sips',['-s','format','jpeg',input,'--out',jpg],{stdio:'pipe'});
  const variants=[['写真.JPEG',fs.readFileSync(jpg)],['図.gif',Buffer.from('R0lGODdhAgACAIEAAFpujAAAAAAAAAAAACwAAAAAAgACAAAIBgABCAQQEAA7','base64')],['図.webp',Buffer.from('UklGRjIAAABXRUJQVlA4ICYAAABQAQCdASoCAAIAAUAmJQBOgC6gAP7rjl+KHmt7B3J1xc2Q3gAAAA==','base64')]];
  for(const [name,bytes] of variants){const a=upload(f,{name},bytes);assert.deepEqual(f.ideas.image('P',a.image.id).bytes,bytes);assert.deepEqual(f.ideas.image('P',a.image.id,true).bytes.subarray(0,8),PNG.subarray(0,8));}
});
for (const colocated of [false,true]) test('images: '+(colocated?'Git同居':'別台帳')+' backup/relocateで原本と下書き画像を復元', t => {
  const f=fixture(t,{bind:false});if(colocated)U.git(f.dir,['init','-q']);const a=upload(f),draft=upload(f,{name:'未使用.png'}),r=add(f,[a]);const s=f.ideas.resolve('P'),saved=f.ideas.backup('P',{opId:U.uuid()});
  assert.equal(require('../lib/resource-scope').commonGit(f.ideas.image('P',a.image.id).file),'');const images=path.join(s.controlDir,'images');fs.renameSync(images,images+'.preserved'); const moved=path.join(f.root,'Product/moved');fs.renameSync(f.dir,moved);f.project.dir=moved;
  f.ideas.relocate('P',{opId:U.uuid(),confirm:true,projectUid:s.projectUid,backupFile:saved.backupFile,backupHash:saved.backupHash});assert.deepEqual(f.ideas.image('P',a.image.id).bytes,PNG);assert.deepEqual(f.ideas.image('P',draft.image.id).bytes,PNG);assert.equal(f.ideas.read('P').items[r.id].images[0].hash,a.image.hash);assert.equal(f.ideas.read('P').settings.manualPaused,true);
});

test('images: 合計50MBを超える実画像の組を拒否', t => {
 const f=fixture(t,{bind:false}),bytes=Buffer.alloc(18*1024*1024);PNG.copy(bytes);const refs=[upload(f,{},bytes),upload(f,{},bytes),upload(f,{},bytes)];assert.throws(()=>add(f,refs),e=>e.code==='image-total');
});
