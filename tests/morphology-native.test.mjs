import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { NativeBackend } from '../server/native.mjs';
import { maskCoverage } from '../server/masks.mjs';

const edit = async (native, doc, command, args = {}) => (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document;
const get = async (native, doc) => (await native.execute('get_document', { documentId: doc.id })).document;
function coverage(mask, width, height) {
  const at = maskCoverage(mask);
  return Buffer.from(Array.from({ length: width * height }, (_, i) => Math.round(at(i % width, Math.floor(i / width)) * 255)));
}
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-morphology-native-'));
  const native = await new NativeBackend({ dataDir }).init();
  const original = await sharp({ create: { width: 12, height: 12, channels: 4, background: '#285078' } }).png().toBuffer();
  const doc = (await native.execute('import_image', { data: original.toString('base64'), mimeType: 'image/png' })).document;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return { native, doc, dataDir, original };
}

test('expanded selection scopes real edits while original assets and saved selection remain exact', async t => {
  const { native, doc: initial, dataDir, original } = await fixture(t);
  let doc = await edit(native, initial, 'select_rectangle', { x: 4, y: 4, width: 4, height: 4 });
  doc = await edit(native, doc, 'save_selection', { name: 'Original region' });
  const checkpoint = structuredClone(doc), pixelsBefore = await native.renderGraph(doc), assetsBefore = await fs.readdir(path.join(dataDir, 'assets'));
  doc = await edit(native, doc, 'morph_selection', { operation: 'expand', radius: 2 });
  assert.equal(doc.selection.shape, 'bitmap'); assert.equal(doc.selection.feather, 0); assert.equal(doc.selection.invert, false);
  const alpha = coverage(doc.selection, 12, 12);
  for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) assert.equal(alpha[y * 12 + x], x >= 2 && x < 10 && y >= 2 && y < 10 ? 255 : 0);
  assert.deepEqual(doc.savedSelections, checkpoint.savedSelections);
  assert.equal(doc.history.length, checkpoint.history.length + 1);
  assert.deepEqual(await native.renderGraph(doc), pixelsBefore);
  doc = await edit(native, doc, 'add_adjustment', { kind: 'invert', value: 100 });
  const pixels = await native.renderGraph(doc);
  for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) assert.deepEqual([...pixels.subarray((y * 12 + x) * 4, (y * 12 + x + 1) * 4)], alpha[y * 12 + x] ? [215, 175, 135, 255] : [40, 80, 120, 255]);
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'assets')), assetsBefore);
  assert.deepEqual(await fs.readFile(path.join(dataDir, 'assets', initial.layers[0].sourceAsset)), original);
  doc = await edit(native, doc, 'undo'); doc = await edit(native, doc, 'undo');
  assert.deepEqual(doc.selection, checkpoint.selection); assert.deepEqual(doc.layers, checkpoint.layers);
});

test('protected layer mask contracts without changing source, protection, selection or independent masks', async t => {
  const { native, doc: initial, dataDir } = await fixture(t);
  const id = initial.layers[0].id;
  let doc = await edit(native, initial, 'set_layer_protection', { layerId: id, protected: true });
  doc = await edit(native, doc, 'set_layer_mask', { layerId: id, mask: { x: 2, y: 2, width: 8, height: 8 } });
  doc = await edit(native, doc, 'select_rectangle', { x: 0, y: 0, width: 2, height: 2 });
  const before = structuredClone(doc);
  doc = await edit(native, doc, 'morph_layer_mask', { layerId: id, operation: 'contract', radius: 2 });
  const expected = Buffer.alloc(12 * 12 * 4);
  for (let y = 4; y < 8; y++) for (let x = 4; x < 8; x++) expected.set([40, 80, 120, 255], (y * 12 + x) * 4);
  assert.deepEqual(await native.renderGraph(doc), expected);
  assert.deepEqual({ ...doc.layers[0], mask: before.layers[0].mask }, before.layers[0]);
  assert.deepEqual(doc.selection, before.selection);
  const reopened = await new NativeBackend({ dataDir }).init();
  assert.equal(reopened.loadWarnings.length, 0); assert.deepEqual(await get(reopened, doc), doc);
  doc = await edit(reopened, doc, 'undo'); assert.deepEqual(doc.layers, before.layers);
  doc = await edit(reopened, doc, 'redo'); assert.deepEqual(await reopened.renderGraph(doc), expected);
});

test('feathered inverted clipped masks are sampled once before border shaping and portable reopening', async t => {
  const { native, doc: initial } = await fixture(t);
  let doc = await edit(native, initial, 'select_region', { shape: 'ellipse', x: 2, y: 2, width: 8, height: 8, feather: 2, invert: true });
  doc = await edit(native, doc, 'resize_canvas', { width: 16, height: 16, anchor: 'center' });
  const input = coverage(doc.selection, 16, 16), expected = Buffer.alloc(16 * 16);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const samples = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) samples.push(x + dx < 0 || x + dx >= 16 || y + dy < 0 || y + dy >= 16 ? 0 : input[(y + dy) * 16 + x + dx]);
    expected[y * 16 + x] = Math.max(...samples) - Math.min(...samples);
  }
  doc = await edit(native, doc, 'morph_selection', { operation: 'border', radius: 1 });
  assert.deepEqual(coverage(doc.selection, 16, 16), expected);
  assert.ok(expected.some(value => value > 0 && value < 255));
  const portable = await native.exportProject({ documentId: doc.id, expectedRevision: doc.revision });
  const restored = (await native.importProject({ data: portable.data })).document;
  assert.deepEqual(restored.selection, doc.selection);
  assert.deepEqual(coverage(restored.selection, 16, 16), expected);
});

test('group and adjustment masks shape independently with single transaction undo', async t => {
  const { native, doc: initial } = await fixture(t);
  let doc = await edit(native, initial, 'group_layers', { layerIds: [initial.layers[0].id] });
  const group = doc.layers.find(layer => layer.type === 'group').id;
  doc = await edit(native, doc, 'set_layer_mask', { layerId: group, mask: { x: 2, y: 2, width: 8, height: 8 } });
  doc = await edit(native, doc, 'add_adjustment', { kind: 'invert', value: 100, mask: { x: 4, y: 4, width: 4, height: 4 } });
  const adjustment = doc.layers.at(-1).id, before = structuredClone(doc), pixelsBefore = await native.renderGraph(doc);
  doc = await edit(native, doc, 'apply_transaction', { label: 'Refine two masks', operations: [
    { command: 'morph_layer_mask', args: { layerId: group, operation: 'contract', radius: 1 } },
    { command: 'morph_layer_mask', args: { layerId: adjustment, operation: 'expand', radius: 1 } },
  ] });
  assert.equal(doc.history.length, before.history.length + 1);
  assert.notDeepEqual(await native.renderGraph(doc), pixelsBefore);
  assert.deepEqual(doc.layers.find(layer => layer.type === 'raster'), before.layers.find(layer => layer.type === 'raster'));
  doc = await edit(native, doc, 'undo'); assert.deepEqual(doc.layers, before.layers); assert.deepEqual(await native.renderGraph(doc), pixelsBefore);
});

test('missing scopes, invalid radius, stale requests, failed transaction and persistence errors preserve project bytes', async t => {
  const { native, doc: initial, dataDir } = await fixture(t);
  await assert.rejects(edit(native, initial, 'morph_selection', { operation: 'expand', radius: 1 }), { code: 'NO_SELECTION' });
  await assert.rejects(edit(native, initial, 'morph_layer_mask', { layerId: initial.layers[0].id, operation: 'expand', radius: 1 }), { code: 'NO_MASK' });
  let doc = await edit(native, initial, 'select_rectangle', { x: 2, y: 2, width: 8, height: 8 });
  const file = path.join(dataDir, 'projects', `${doc.id}.json`), bytes = await fs.readFile(file), assets = await fs.readdir(path.join(dataDir, 'assets'));
  for (const radius of [0, 101, 1.5, NaN]) await assert.rejects(edit(native, doc, 'morph_selection', { operation: 'expand', radius }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(edit(native, doc, 'morph_selection', { operation: 'contract', radius: 1, expectedRevision: doc.revision - 1 }), { code: 'REVISION_CONFLICT' });
  await assert.rejects(edit(native, doc, 'apply_transaction', { operations: [
    { command: 'morph_selection', args: { operation: 'expand', radius: 1 } },
    { command: 'morph_layer_mask', args: { layerId: randomUUID(), operation: 'smooth', radius: 2 } },
  ] }), { code: 'NOT_FOUND' });
  const persist = native.persist;
  native.persist = async () => { throw new Error('Injected save failure'); };
  await assert.rejects(edit(native, doc, 'morph_selection', { operation: 'smooth', radius: 1 }), /Injected save failure/);
  native.persist = persist;
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await fs.readFile(file), bytes); assert.deepEqual(await fs.readdir(path.join(dataDir, 'assets')), assets);
  doc = await edit(native, doc, 'morph_selection', { operation: 'contract', radius: 100 });
  assert.equal(doc.selection.runs.length, 0, 'Radius larger than the document may intentionally produce an empty selection.');
});
