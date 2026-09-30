import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { maskCoverage, bitmapBytes, bitmapMask } from '../server/masks.mjs';
import { createCompanion } from '../server/index.mjs';
import { authoredFrame, runCount } from './fixtures/dense-mask/reference.mjs';

const edit = async (native, doc, command, args = {}) => (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document;
const current = async (native, doc) => (await native.execute('get_document', { documentId: doc.id })).document;
const effective = (mask, width, height) => { const coverage = maskCoverage(mask); return Buffer.from(Array.from({ length: width * height }, (_, i) => Math.round(coverage(i % width, Math.floor(i / width)) * 255))); };
function primitive(alpha, width, height, radius, maximum) {
  return Buffer.from(Array.from({ length: alpha.length }, (_, index) => {
    const x = index % width, y = Math.floor(index / width); let value = maximum ? 0 : 255;
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const sample = x + dx < 0 || y + dy < 0 || x + dx >= width || y + dy >= height ? 0 : alpha[(y + dy) * width + x + dx];
      value = maximum ? Math.max(value, sample) : Math.min(value, sample);
    }
    return value;
  }));
}
function expected(alpha, width, height, radius, operation) {
  if (operation === 'smooth') {
    for (const maximum of [false, true, true, false]) alpha = primitive(alpha, width, height, radius, maximum);
    return alpha;
  }
  const expanded = primitive(alpha, width, height, radius, true), contracted = primitive(alpha, width, height, radius, false);
  return operation === 'expand' ? expanded : operation === 'contract' ? contracted : Buffer.from(expanded.map((value, i) => value - contracted[i]));
}
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-morph-audit-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return { dataDir, native: await new NativeBackend({ dataDir }).init() };
}

test('selection morphology bakes clipped fractional feather and inversion once without changing saved copies or sources', async (t) => {
  const { native, dataDir } = await fixture(t);
  const original = await sharp({ create: { width: 24, height: 20, channels: 4, background: '#4268ab' } }).png().toBuffer();
  let doc = (await native.execute('import_image', { data: original.toString('base64'), mimeType: 'image/png' })).document;
  const source = doc.layers[0].sourceAsset;
  doc = await edit(native, doc, 'select_region', { shape: 'ellipse', x: 1.3, y: 2.8, width: 10.2, height: 11.3, feather: 2.2, invert: true });
  doc = await edit(native, doc, 'resize_canvas', { width: 32, height: 28, anchor: 'center' });
  assert.ok(doc.selection.clip);
  doc = await edit(native, doc, 'save_selection', { name: 'Untouched fractional source mask' });
  const initial = structuredClone(doc.selection), saved = structuredClone(doc.savedSelections), alpha = effective(initial, doc.width, doc.height), assets = await fs.readdir(path.join(dataDir, 'assets'));
  for (const operation of ['expand', 'contract', 'border', 'smooth']) {
    const revision = doc.revision;
    doc = await edit(native, doc, 'morph_selection', { operation, radius: 2 });
    assert.equal(doc.revision, revision + 1); assert.equal(doc.selection.feather, 0); assert.equal(doc.selection.invert, false); assert.equal(doc.selection.clip, undefined);
    assert.deepEqual(Buffer.from(bitmapBytes(doc.selection)), expected(alpha, doc.width, doc.height, 2, operation));
    assert.deepEqual(doc.savedSelections, saved);
    assert.deepEqual(await fs.readdir(path.join(dataDir, 'assets')), assets);
    assert.deepEqual(await fs.readFile(path.join(dataDir, 'assets', source)), original);
    doc = await edit(native, doc, 'undo'); assert.deepEqual(doc.selection, initial);
  }
  doc = await edit(native, doc, 'morph_selection', { operation: 'border', radius: 1 });
  const reopened = await new NativeBackend({ dataDir }).init();
  assert.deepEqual((await current(reopened, doc)).selection, doc.selection);
});

test('protected content, group and adjustment mask operations have strictly local scope', async (t) => {
  const { native, dataDir } = await fixture(t);
  const original = await sharp({ create: { width: 18, height: 14, channels: 4, background: '#4268ab' } }).png().toBuffer();
  let doc = (await native.execute('import_image', { data: original.toString('base64'), mimeType: 'image/png' })).document;
  const id = doc.layers[0].id;
  doc = await edit(native, doc, 'set_layer_mask', { layerId: id, mask: { shape: 'ellipse', x: 3, y: 2, width: 8, height: 8, feather: 1.2, invert: true } });
  doc = await edit(native, doc, 'set_layer_protection', { layerId: id, protected: true });
  doc = await edit(native, doc, 'group_layers', { layerIds: [id] }); const group = doc.layers.find((layer) => layer.type === 'group').id;
  doc = await edit(native, doc, 'set_layer_mask', { layerId: group, mask: { x: 1, y: 1, width: 14, height: 11, feather: 0.8 } });
  doc = await edit(native, doc, 'select_region', { shape: 'ellipse', x: 4, y: 3, width: 6, height: 7, feather: 1.5 });
  doc = await edit(native, doc, 'save_selection', { name: 'Do not reshape me' });
  doc = await edit(native, doc, 'add_adjustment', { kind: 'brightness', value: 10 }); const adjustment = doc.layers.at(-1).id;
  const sourcePixels = await native.sourcePixels(doc.layers.find((layer) => layer.id === id)), assets = await fs.readdir(path.join(dataDir, 'assets'));
  for (const target of [id, group, adjustment]) {
    const before = structuredClone(doc), layer = before.layers.find((item) => item.id === target), alpha = effective(layer.mask, doc.width, doc.height);
    doc = await edit(native, doc, 'morph_layer_mask', { layerId: target, operation: 'border', radius: 1 });
    assert.deepEqual(Buffer.from(bitmapBytes(doc.layers.find((item) => item.id === target).mask)), expected(alpha, doc.width, doc.height, 1, 'border'));
    assert.deepEqual(doc.selection, before.selection); assert.deepEqual(doc.savedSelections, before.savedSelections);
    for (let i = 0; i < doc.layers.length; i++) {
      const currentLayer = structuredClone(doc.layers[i]), originalLayer = structuredClone(before.layers[i]);
      if (currentLayer.id === target) { delete currentLayer.mask; delete originalLayer.mask; }
      assert.deepEqual(currentLayer, originalLayer);
    }
    assert.deepEqual(await native.sourcePixels(doc.layers.find((item) => item.id === id)), sourcePixels);
    assert.deepEqual(await fs.readdir(path.join(dataDir, 'assets')), assets);
  }
});

test('complex morphology uses exact dense fallback and a later invalid target rolls back frames and persisted edits', async (t) => {
  const { native, dataDir } = await fixture(t), width = 800, height = 1600;
  let doc = (await native.execute('create_document', { width, height })).document;
  const alpha = Buffer.alloc(width * height);
  for (let y = 2; y < height; y += 4) for (let x = 2; x < width; x += 4) alpha[y * width + x] = 128;
  const graph = { name: 'Sparse input with exact dense expansion', width, height, selection: bitmapMask(alpha, width, height), layers: structuredClone(doc.layers) };
  assert.equal(graph.selection.runs.length / 3, 80_000);
  doc = (await native.newProject(graph, 'Audit fixture')).document;
  const file = path.join(dataDir, 'projects', `${doc.id}.json`), bytes = await fs.readFile(file);
  await assert.rejects(edit(native, doc, 'apply_transaction', { operations: [
    { command: 'set_layer', args: { layerId: doc.layers[0].id, name: 'Should roll back' } },
    { command: 'morph_selection', args: { operation: 'expand', radius: 1 } },
    { command: 'set_layer', args: { layerId: randomUUID(), opacity: 0.5 } },
  ] }), { code: 'NOT_FOUND' });
  assert.deepEqual(await current(native, doc), doc); assert.deepEqual(await fs.readFile(file), bytes);
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'assets')), []);
  const expanded = Buffer.alloc(alpha.length);
  for (let y = 2; y < height; y += 4) for (let x = 2; x < width; x += 4) for (let dy = -1; dy <= 1; dy++) expanded.fill(128, (y + dy) * width + x - 1, (y + dy) * width + x + 2);
  assert.equal(runCount(expanded), 240_000);
  doc = await edit(native, doc, 'morph_selection', { operation: 'expand', radius: 1 });
  const reference = authoredFrame(expanded, width, height);
  assert.deepEqual(doc.selection, reference.descriptor);
  assert.deepEqual(await fs.readFile(path.join(dataDir, 'assets', doc.selection.asset)), reference.bytes);
});

test('absent selection/mask, invalid input and stale revisions fail without a mutation', async (t) => {
  const { native, dataDir } = await fixture(t);
  const doc = (await native.execute('create_document', { width: 12, height: 10 })).document;
  const file = path.join(dataDir, 'projects', `${doc.id}.json`), bytes = await fs.readFile(file);
  for (const [command, args, code] of [
    ['morph_selection', { operation: 'expand', radius: 1 }, 'NO_SELECTION'],
    ['morph_layer_mask', { layerId: doc.layers[0].id, operation: 'expand', radius: 1 }, 'NO_MASK'],
    ['morph_selection', { operation: 'expand', radius: 101 }, 'INVALID_ARGUMENT'],
    ['morph_selection', { operation: 'feather', radius: 1 }, 'INVALID_ARGUMENT'],
    ['morph_selection', { operation: 'expand', radius: 1, expectedRevision: doc.revision + 1 }, 'REVISION_CONFLICT'],
  ]) await assert.rejects(edit(native, doc, command, args), { code });
  assert.deepEqual(await current(native, doc), doc); assert.deepEqual(await fs.readFile(file), bytes);
});

test('HTTP status and native capabilities expose identical morphology operations and bounds', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-morph-status-'));
  const companion = await createCompanion({ dataDir, port: 0 }); const port = await companion.listen();
  t.after(async () => { await companion.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const response = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { Authorization: `Bearer ${companion.token}` } });
  assert.equal(response.status, 200); const status = await response.json();
  const backend = status.backends.find((item) => item.id === 'native');
  const capabilityResponse = await fetch(`http://127.0.0.1:${port}/api/command`, { method: 'POST', headers: { Authorization: `Bearer ${companion.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ backend: 'native', command: 'capabilities', args: {} }) });
  assert.equal(capabilityResponse.status, 200);
  const body = await capabilityResponse.json(), capabilities = body.result ?? body;
  assert.deepEqual(backend.morphologyOperations, ['expand', 'contract', 'border', 'smooth']);
  assert.deepEqual(backend.morphologyOperations, capabilities.morphologyOperations);
  assert.equal(backend.limits.maxMorphologyRadius, 100); assert.equal(capabilities.limits.maxMorphologyRadius, 100);
  assert.ok(backend.commands.includes('morph_selection')); assert.ok(backend.commands.includes('morph_layer_mask'));
});
