import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { alphaBounds } from '../server/cutout-pixels.mjs';
import { planAlignment, planDistribution } from '../server/arrangement.mjs';

const edit = async (native, doc, command, args = {}) => (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document;
const read = async (native, doc) => (await native.execute('get_document', { documentId: doc.id })).document;
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-arrange-audit-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return { dataDir, native: await new NativeBackend({ dataDir }).init() };
}

test('randomized arrangement plans retain endpoints, bounded gaps and alignment anchors', () => {
  let seed = 74121;
  const random = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let iteration = 0; iteration < 1000; iteration++) {
    const count = 3 + random(12), items = [], widths = Array.from({ length: count }, () => 1 + random(13));
    const gaps = Array.from({ length: count - 1 }, () => random(17));
    let cursor = random(5);
    for (let i = 0; i < count; i++) {
      items.push({ id: String(i), bounds: { x: cursor, y: 2, width: widths[i], height: 3 } });
      cursor += widths[i] + (gaps[i] ?? 0);
    }
    const width = cursor + random(9), height = 9;
    for (const spacing of ['gaps', 'centers']) {
      const moves = planDistribution({ items, width, height, axis: 'horizontal', spacing });
      assert.deepEqual([moves[0].x, moves.at(-1).x], [0, 0]);
      const positioned = moves.map((move, i) => ({ x: items[i].bounds.x + move.x, width: widths[i] }));
      assert.ok(positioned.every((box) => box.x >= 0 && box.x + box.width <= width));
      const distances = positioned.slice(1).map((box, i) => spacing === 'gaps'
        ? box.x - (positioned[i].x + positioned[i].width)
        : box.x + box.width / 2 - positioned[i].x - positioned[i].width / 2);
      if (spacing === 'gaps') { assert.ok(Math.min(...distances) >= 0); assert.ok(Math.max(...distances) - Math.min(...distances) <= 1); }
      else {
        const start = positioned[0].x + positioned[0].width / 2, end = positioned.at(-1).x + positioned.at(-1).width / 2;
        positioned.forEach((box, i) => assert.ok(Math.abs(box.x + box.width / 2 - (start + (end - start) * i / (count - 1))) <= 0.5));
      }
    }
    for (const alignment of ['start', 'center', 'end']) {
      const moves = planAlignment({ items, width, height, axis: 'horizontal', alignment });
      for (let i = 0; i < count; i++) {
        const x = items[i].bounds.x + moves[i].x;
        if (alignment === 'start') assert.equal(x, 0);
        else if (alignment === 'end') assert.equal(x + widths[i], width);
        else assert.ok(Math.abs(x + widths[i] / 2 - width / 2) <= 0.5);
      }
    }
  }
});

test('alignment translates already-clipped transformed raster bytes without reconstructing lost canvas pixels', async (t) => {
  const { native, dataDir } = await fixture(t), width = 28, height = 20;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    pixels.set([(x * 29 + y) % 256, (y * 37) % 256, (x * 11) % 256, x < 14 && y < 11 ? (x % 3 === 0 ? 1 : x % 3 === 1 ? 128 : 255) : 0], i);
  }
  const original = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
  let doc = (await native.execute('import_image', { data: original.toString('base64'), mimeType: 'image/png' })).document;
  const id = doc.layers[0].id, sourceAsset = doc.layers[0].sourceAsset;
  doc = await edit(native, doc, 'transform_layer', { layerId: id, x: -4, y: -2, rotation: 11, scaleX: 0.8, scaleY: 0.8 });
  doc = await edit(native, doc, 'crop_document', { x: 1, y: 1, width: 23, height: 17 });
  doc = await edit(native, doc, 'resize_canvas', { width: 31, height: 23, anchor: 'top-left' });
  doc = await edit(native, doc, 'set_layer_protection', { layerId: id, protected: true });
  const before = doc, rasterBefore = await native.renderLayer(doc.layers[0]), box = alphaBounds(rasterBefore, doc.width, doc.height);
  assert.equal(box.left, 0, 'fixture actually has clipped content');
  assert.ok(box.width < doc.width);
  const assetsBefore = await fs.readdir(path.join(dataDir, 'assets'));
  doc = await edit(native, doc, 'align_layers', { layerIds: [id], axis: 'horizontal', alignment: 'end' });
  const dx = doc.width - box.width, shifted = Buffer.alloc(rasterBefore.length);
  for (let y = 0; y < doc.height; y++) for (let x = 0; x < doc.width - dx; x++) {
    const from = (y * doc.width + x) * 4, to = (y * doc.width + x + dx) * 4;
    rasterBefore.copy(shifted, to, from, from + 4);
  }
  assert.deepEqual(await native.renderLayer(doc.layers[0]), shifted);
  assert.equal(doc.layers[0].sourceAsset, sourceAsset);
  assert.deepEqual(await fs.readFile(path.join(dataDir, 'assets', sourceAsset)), original);
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'assets')), assetsBefore);
  assert.deepEqual(doc.layers[0].transforms.slice(0, -1), before.layers[0].transforms);
  const reopened = await new NativeBackend({ dataDir }).init();
  assert.deepEqual(await reopened.renderLayer((await read(reopened, doc)).layers[0]), shifted);
  doc = await edit(reopened, doc, 'undo');
  assert.deepEqual(await reopened.renderLayer(doc.layers[0]), rasterBefore);
});

test('geometry cap, stale revision and persistence failure leave the entire alignment unpublished', async (t) => {
  const { native, dataDir } = await fixture(t);
  let doc = (await native.execute('create_document', { width: 20, height: 12 })).document;
  for (const x of [3, 8]) doc = await edit(native, doc, 'add_shape', { shape: 'rectangle', x, y: 2, width: 2, height: 3, fill: '#56789a' });
  const ids = doc.layers.slice(1).map((layer) => layer.id), project = native.projects.get(doc.id);
  // Seed a valid near-limit persisted fixture directly; avoid 500 unrelated edits.
  project.states[project.cursor].graph.layers.at(-1).transforms = Array.from({ length: 500 }, () => ({ type: 'affine', width: 20, height: 12, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, flipX: false, flipY: false }));
  await native.persist(project); doc = await read(native, doc);
  const file = path.join(dataDir, 'projects', `${doc.id}.json`), bytes = await fs.readFile(file), rendered = await native.renderGraph(doc);
  await assert.rejects(edit(native, doc, 'align_layers', { layerIds: ids, axis: 'horizontal', alignment: 'end' }), /Too many geometry transforms/);
  assert.deepEqual(await read(native, doc), doc); assert.deepEqual(await fs.readFile(file), bytes);
  await assert.rejects(edit(native, doc, 'align_layers', { layerIds: [ids[0]], axis: 'horizontal', alignment: 'end', expectedRevision: doc.revision - 1 }), { code: 'REVISION_CONFLICT' });
  const persist = native.persist;
  native.persist = async () => { throw Object.assign(new Error('Synthetic storage failure'), { code: 'ENOSPC' }); };
  try { await assert.rejects(edit(native, doc, 'align_layers', { layerIds: [ids[0]], axis: 'horizontal', alignment: 'end' }), { code: 'ENOSPC' }); }
  finally { native.persist = persist; }
  assert.deepEqual(await read(native, doc), doc); assert.deepEqual(await fs.readFile(file), bytes);
  assert.deepEqual(await native.renderGraph(doc), rendered);
});
