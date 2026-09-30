import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { layerTree } from '../server/groups.mjs';
import { maskCoverage } from '../server/masks.mjs';

async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-group-audit-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return { dataDir, native: await new NativeBackend({ dataDir, ...options }).init() };
}
const edit = async (native, doc, command, args) => (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document;
const rendered = (native, doc) => native.render(native.project(doc.id));
const pixel = (buffer, width, x, y) => [...buffer.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];

test('ancestor mask clips the final protected shadow, without changing its caster or generation exclusion', async t => {
  const { native, dataDir } = await fixture(t);
  const source = Buffer.alloc(9 * 7 * 4); source.set([30, 80, 130, 255], (3 * 9 + 2) * 4);
  const original = await sharp(source, { raw: { width: 9, height: 7, channels: 4 } }).png().toBuffer();
  let doc = (await native.execute('import_image', { name: 'Protected masked shadow', data: original.toString('base64'), mimeType: 'image/png' })).document;
  const leafId = doc.layers[0].id, sourceAsset = doc.layers[0].sourceAsset;
  doc = await edit(native, doc, 'set_layer_effects', { layerId: leafId, effects: { shadow: { x: 3, y: 0, blur: 0, opacity: 1, color: '#ff0000' } } });
  doc = await edit(native, doc, 'set_layer_protection', { layerId: leafId, protected: true });
  doc = await edit(native, doc, 'group_layers', { layerIds: [leafId] });
  doc = await edit(native, doc, 'set_layer_mask', { layerId: doc.layers[0].id, mask: { x: 5, y: 0, width: 1, height: 7 } });
  const before = await rendered(native, doc), protection = await native.protectedPixels(doc);
  assert.deepEqual(pixel(before, 9, 5, 3), [255, 0, 0, 255]);
  assert.equal(pixel(before, 9, 2, 3)[3], 0);
  for (let i = 0; i < protection.length; i++) assert.equal(protection[i], before[i * 4 + 3] > 0 ? 1 : 0);
  const snapshot = await native.snapshotForGeneration({ documentId: doc.id, expectedRevision: doc.revision, scope: 'document' });
  const providerMask = await sharp(snapshot.mask).ensureAlpha().raw().toBuffer();
  for (let i = 0; i < protection.length; i++) assert.equal(providerMask[i * 4 + 3], protection[i] ? 255 : 0);
  const generated = await sharp({ create: { width: 9, height: 7, channels: 4, background: '#ffffff' } }).png().toBuffer();
  doc = (await native.installGeneratedImage({ data: generated, documentId: doc.id, expectedRevision: doc.revision })).document;
  const after = await rendered(native, doc);
  assert.deepEqual(pixel(after, 9, 5, 3), [255, 0, 0, 255]);
  assert.deepEqual(pixel(after, 9, 2, 3), [255, 255, 255, 255]);
  assert.deepEqual(await fs.readFile(path.join(dataDir, 'assets', sourceAsset)), original);
});

test('nested neutral groups preserve mixed blending and selection-mask undo, with atomic cycle rejection', async t => {
  const { native, dataDir } = await fixture(t);
  let doc = (await native.execute('create_document', { width: 16, height: 12, background: '#3d7ba1' })).document;
  doc = await edit(native, doc, 'add_shape', { shape: 'rectangle', x: 1, y: 2, width: 11, height: 8, fill: '#e563a1' });
  doc = await edit(native, doc, 'set_layer', { layerId: doc.layers.at(-1).id, opacity: 0.43, blendMode: 'multiply' });
  doc = await edit(native, doc, 'add_adjustment', { kind: 'brightness', value: 17 });
  const before = await rendered(native, doc), originalIds = doc.layers.map(layer => layer.id);
  doc = await edit(native, doc, 'group_layers', { layerIds: [...originalIds].reverse() });
  const inner = doc.layers[0].id;
  doc = await edit(native, doc, 'group_layers', { layerIds: [inner] });
  const outer = doc.layers[0].id;
  assert.deepEqual(await rendered(native, doc), before);
  assert.deepEqual(doc.layers.filter(layer => layer.type !== 'group').map(layer => layer.id), originalIds);
  doc = await edit(native, doc, 'select_region', { shape: 'rectangle', x: 3, y: 2, width: 8, height: 7 });
  doc = await edit(native, doc, 'mask_from_selection', { layerId: outer });
  const masked = await rendered(native, doc);
  for (let y = 0; y < 12; y++) for (let x = 0; x < 16; x++) {
    if (x >= 3 && x < 11 && y >= 2 && y < 9) assert.deepEqual(pixel(masked, 16, x, y), pixel(before, 16, x, y));
    else assert.equal(pixel(masked, 16, x, y)[3], 0);
  }
  doc = await edit(native, doc, 'undo', {}); assert.deepEqual(await rendered(native, doc), before);
  const file = path.join(dataDir, 'projects', `${doc.id}.json`), disk = await fs.readFile(file);
  await assert.rejects(edit(native, doc, 'move_layer', { layerId: outer, parentId: inner }));
  assert.deepEqual(await fs.readFile(file), disk);
  assert.deepEqual((await native.execute('get_document', { documentId: doc.id })).document, doc);
  doc = await edit(native, doc, 'duplicate_layer', { layerId: outer });
  assert.equal(new Set(doc.layers.map(layer => layer.id)).size, doc.layers.length);
  const tree = layerTree(doc.layers); assert.equal(tree.roots.length, 2);
  assert.equal(tree.roots[1].children[0].children.length, 3);
  const reopened = await new NativeBackend({ dataDir }).init();
  assert.equal(reopened.loadWarnings.length, 0);
  assert.deepEqual(await rendered(reopened, doc), await rendered(native, doc));
});

test('subject selection sees alpha-one pixels retained by staged ancestor opacity', async t => {
  const { native } = await fixture(t, { segmentSubject: async () => ({ alpha: Buffer.from([255]), width: 1, height: 1, model: 'audit-fixture' }) });
  const png = await sharp(Buffer.from([100, 120, 140, 1]), { raw: { width: 1, height: 1, channels: 4 } }).png().toBuffer();
  let doc = (await native.execute('import_image', { data: png.toString('base64'), mimeType: 'image/png' })).document;
  const leafId = doc.layers[0].id;
  doc = await edit(native, doc, 'group_layers', { layerIds: [leafId] });
  const inner = doc.layers[0].id;
  doc = await edit(native, doc, 'set_layer', { layerId: inner, opacity: 0.5 });
  doc = await edit(native, doc, 'group_layers', { layerIds: [inner] });
  doc = await edit(native, doc, 'set_layer', { layerId: doc.layers[0].id, opacity: 0.5 });
  assert.equal((await rendered(native, doc))[3], 1);
  doc = await edit(native, doc, 'select_subject', { layerId: leafId });
  assert.equal(maskCoverage(doc.selection)(0, 0), 1 / 255);
});

test('group scratch rejection occurs before committing a large-canvas opacity edit', async t => {
  const { native, dataDir } = await fixture(t);
  let doc = (await native.execute('create_document', { width: 5000, height: 4000 })).document;
  doc = await edit(native, doc, 'group_layers', { layerIds: [doc.layers[0].id] });
  const inner = doc.layers[0].id;
  doc = await edit(native, doc, 'group_layers', { layerIds: [inner] });
  const middle = doc.layers[0].id;
  doc = await edit(native, doc, 'group_layers', { layerIds: [middle] });
  const outer = doc.layers[0].id;
  doc = await edit(native, doc, 'set_layer', { layerId: inner, opacity: 0.5 });
  doc = await edit(native, doc, 'set_layer', { layerId: middle, opacity: 0.5 });
  const file = path.join(dataDir, 'projects', `${doc.id}.json`), before = await fs.readFile(file), assets = await fs.readdir(path.join(dataDir, 'assets'));
  await assert.rejects(edit(native, doc, 'set_layer', { layerId: outer, opacity: 0.5 }), { code: 'LIMIT_EXCEEDED' });
  assert.deepEqual(await fs.readFile(file), before);
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'assets')), assets);
  assert.deepEqual((await native.execute('get_document', { documentId: doc.id })).document, doc);
});
