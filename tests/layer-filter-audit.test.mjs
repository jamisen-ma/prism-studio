import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { NativeBackend } from '../server/native.mjs';
import { applyLayerFilters, validateLayerFilterResources } from '../server/layer-filters.mjs';
import { layerTree } from '../server/groups.mjs';

const filter = (kind, value, extra = {}) => ({ id: randomUUID(), kind, value, enabled: true, opacity: 1, ...extra });
const edit = async (native, doc, command, args = {}) => (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document;
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-filter-audit-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return { dataDir, native: await new NativeBackend({ dataDir }).init() };
}

test('layer filters independently preserve alpha, invisible RGB and per-stage fractional rounding', async () => {
  const input = Buffer.from([201, 12, 33, 0, 10, 70, 220, 1, 150, 80, 3, 128, 0, 90, 250, 255]);
  const before = Buffer.from(input), entries = [filter('brightness', 10, { opacity: 0.5 }), filter('invert', 100, { opacity: 0.25 }), filter('threshold', 0, { opacity: 0.125 })];
  const expected = Buffer.from(input);
  for (let i = 0; i < expected.length; i += 4) if (expected[i + 3]) for (let channel = 0; channel < 3; channel++) {
    let v = expected[i + channel];
    v = Math.round(v + (Math.min(255, Math.round(v + 25.5)) - v) * 0.5);
    v = Math.round(v + (255 - 2 * v) * 0.25);
    v = Math.round(v + (255 - v) * 0.125);
    expected[i + channel] = v;
  }
  assert.deepEqual(await applyLayerFilters(input, 4, 1, entries), expected);
  assert.deepEqual(input, before);
  const spatial = await applyLayerFilters(input, 4, 1, [filter('mosaic', 4)]);
  const total = 1 + 128 + 255;
  const average = [0, 1, 2].map((channel) => Math.round((input[4 + channel] + input[8 + channel] * 128 + input[12 + channel] * 255) / total));
  assert.deepEqual([...spatial.subarray(0, 4)], [...input.subarray(0, 4)]);
  for (let i = 1; i < 4; i++) { assert.deepEqual([...spatial.subarray(i * 4, i * 4 + 3)], average); assert.equal(spatial[i * 4 + 3], input[i * 4 + 3]); }
});

test('source-space mosaic precedes asymmetric geometry and clear/undo preserve immutable pixels', async (t) => {
  const { native, dataDir } = await fixture(t), width = 9, height = 7;
  const input = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) input.set([(i * 29) % 256, (i * 43) % 256, (i * 73) % 256, i % 5 === 0 ? 0 : i % 5 === 1 ? 1 : i % 5 === 2 ? 128 : 255], i * 4);
  const original = await sharp(input, { raw: { width, height, channels: 4 } }).png().toBuffer();
  let doc = (await native.execute('import_image', { data: original.toString('base64'), mimeType: 'image/png' })).document;
  const id = doc.layers[0].id, asset = doc.layers[0].asset;
  doc = await edit(native, doc, 'transform_layer', { layerId: id, x: 1, y: -1, rotation: 13, scaleX: 1.2, scaleY: 0.8 });
  doc = await edit(native, doc, 'resize_canvas', { width: 13, height: 11, anchor: 'center' });
  const unfiltered = await native.renderLayer(doc.layers[0]), assets = await fs.readdir(path.join(dataDir, 'assets'));
  doc = await edit(native, doc, 'add_layer_filter', { layerId: id, kind: 'mosaic', value: 3 });
  const layer = doc.layers[0];
  // Independent alpha-weighted source-cell reference, then established geometry.
  const candidate = Buffer.from(input);
  for (let top = 0; top < height; top += 3) for (let left = 0; left < width; left += 3) {
    let weight = 0; const sums = [0, 0, 0];
    for (let y = top; y < Math.min(height, top + 3); y++) for (let x = left; x < Math.min(width, left + 3); x++) {
      const i = (y * width + x) * 4; weight += input[i + 3];
      for (let c = 0; c < 3; c++) sums[c] += input[i + c] * input[i + 3];
    }
    if (weight) for (let y = top; y < Math.min(height, top + 3); y++) for (let x = left; x < Math.min(width, left + 3); x++) {
      const i = (y * width + x) * 4;
      if (input[i + 3]) for (let c = 0; c < 3; c++) candidate[i + c] = Math.round(sums[c] / weight);
    }
  }
  const expected = await native.renderLayerGeometry(layer, candidate);
  assert.deepEqual(await native.renderLayer(layer), expected);
  for (let i = 3; i < expected.length; i += 4) assert.equal(expected[i], unfiltered[i]);
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'assets')), assets);
  assert.deepEqual(await fs.readFile(path.join(dataDir, 'assets', asset)), original);
  doc = await edit(native, doc, 'clear_layer_filters', { layerId: id });
  assert.deepEqual(await native.renderLayer(doc.layers[0]), unfiltered);
  doc = await edit(native, doc, 'undo');
  assert.deepEqual(await native.renderLayer(doc.layers[0]), expected);
  const reopened = await new NativeBackend({ dataDir }).init();
  const restored = (await reopened.execute('get_document', { documentId: doc.id })).document;
  assert.deepEqual(await reopened.renderLayer(restored.layers[0]), expected);
});

test('filter resource validation counts hidden work and combines scratch with nonneutral groups', () => {
  const width = 4800, height = 4800, raster = { id: randomUUID(), type: 'raster', visible: false, opacity: 1, width, height, transforms: [], filters: [filter('median', 3)] };
  let graph = { width, height, layers: [raster] };
  assert.throws(() => validateLayerFilterResources(graph, layerTree(graph.layers)), { code: 'LIMIT_EXCEEDED' });
  raster.filters[0].enabled = false;
  assert.doesNotThrow(() => validateLayerFilterResources(graph, layerTree(graph.layers)));
  const group = { id: randomUUID(), type: 'group', visible: true, opacity: 0.5 };
  raster.filters = [filter('brightness', 1)]; raster.parentId = group.id;
  graph = { width, height, layers: [group, raster] };
  assert.throws(() => validateLayerFilterResources(graph, layerTree(graph.layers)), { code: 'LIMIT_EXCEEDED' });
  group.opacity = 1;
  assert.doesNotThrow(() => validateLayerFilterResources(graph, layerTree(graph.layers)));
});
