import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { DISTORT_POLICY, DISTORT_COORDINATES, DISTORT_CONTENT_TYPES, DISTORT_LIMITS, normalizeDistortCorners, normalizeDistort, createDistort, compileDistort, distortPixels } from '../server/distort.mjs';
import { estimateDistortResources, estimateDistortLeafBytes, validateDistortResources } from '../server/distort-resources.mjs';
import { estimateDistortPsdPreparation } from '../server/psd-native.mjs';
import { estimateLayerMaskCallbacks } from '../server/layer-mask.mjs';
import { estimateLayerSelectionBytes } from '../server/layer-selection.mjs';
import { applyLayerFilters } from '../server/layer-filters.mjs';

const coded = code => error => error.code === code;
const corners = (w, h, x = 0, y = 0) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const image = (w, h) => Buffer.from(Array.from({ length: w * h }, (_, p) => [(p * 53 + 17) % 256, (p * 173 + 40) % 256, (p * 97 + 121) % 256, [0, 1, 128, 255][p % 4]]).flat());
const graphOf = (native, doc) => structuredClone(native.project(doc.id).states[native.project(doc.id).cursor].graph);
const edit = async (native, doc, command, args = {}) => (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document;
const filter = (extra = {}) => ({ id: randomUUID(), kind: 'invert', value: 100, enabled: true, opacity: 1, ...extra });
const leaf = (w, h, transforms = [], extra = {}) => ({ id: randomUUID(), name: 'Source', type: 'raster', visible: true, opacity: 1, blendMode: 'normal', width: w, height: h, transforms, asset: 'a'.repeat(64), sourceAsset: 'a'.repeat(64), ...extra });
const graph = (w, h, layers) => ({ name: 'Bounds', width: w, height: h, selection: null, layers });
async function fixture(t, width = 8, height = 8) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-distort-')), native = await new NativeBackend({ dataDir }).init();
  t.after(async () => { await native.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const input = image(width, height), png = await sharp(input, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const doc = (await native.execute('import_image', { mimeType: 'image/png', data: png.toString('base64') })).document;
  return { native, doc, dataDir, input };
}
// Independent quarter-pixel translation sampler: integer weights and BigInt
// alpha/color ratios; the power-of-two frame mapping is exactly representable.
function quarterReference(input, width, height, dx, dy) {
  const out = Buffer.alloc(input.length), half = (n, d) => Number((2n * n + d) / (2n * d));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = 4 * x - dx, sy = 4 * y - dy, left = Math.floor(sx / 4), top = Math.floor(sy / 4), fx = sx - left * 4, fy = sy - top * 4;
    let a = 0n; const rgb = [0n, 0n, 0n];
    for (let oy = 0; oy < 2; oy++) for (let ox = 0; ox < 2; ox++) {
      const xx = left + ox, yy = top + oy;
      if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
      const i = (yy * width + xx) * 4, wa = BigInt((ox ? fx : 4 - fx) * (oy ? fy : 4 - fy) * input[i + 3]);
      a += wa; for (let c = 0; c < 3; c++) rgb[c] += wa * BigInt(input[i + c]);
    }
    if (a) { const i = (y * width + x) * 4; for (let c = 0; c < 3; c++) out[i + c] = half(rgb[c], a); out[i + 3] = half(a, 16n); }
  }
  return out;
}

test('strict fixed-frame metadata, numeric rejection and source-independent capability', () => {
  const expected = { type: 'distort', width: 8, height: 8, corners: corners(8, 8) };
  assert.deepEqual(createDistort(8, 8, corners(8, 8, -0, -0)), expected);
  assert.deepEqual(compileDistort(8, 8, corners(8, 8, 1, -2)).translation, { x: 1, y: -2 });
  for (const changed of [{ ...expected, extra: true }, { ...expected, width: 7 }, { ...expected, type: 'affine' }]) assert.throws(() => normalizeDistort(changed, 8, 8), coded('INVALID_ARGUMENT'));
  const malformed = [null, [], corners(8, 8).slice(0, 3), [...corners(8, 8), { x: 0, y: 0 }]];
  const hole = corners(8, 8); delete hole[1]; malformed.push(hole);
  const accessor = corners(8, 8); Object.defineProperty(accessor[0], 'x', { enumerable: true, get() { throw Error('Getter evaluated'); } }); malformed.push(accessor);
  const symbol = corners(8, 8); symbol[Symbol('hidden')] = 1; malformed.push(symbol);
  const inherited = corners(8, 8); inherited[0] = Object.assign(Object.create({ z: 1 }), inherited[0]); malformed.push(inherited);
  for (const points of malformed) assert.throws(() => normalizeDistortCorners(points), coded('INVALID_ARGUMENT'));
  for (const points of [corners(8, 8).reverse(), [{ x: 0, y: 0 }, { x: 8, y: 8 }, { x: 8, y: 0 }, { x: 0, y: 8 }], [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 8 }], corners(.1, .1), corners(8, .000001), corners(8, 8, 16384), corners(8, 8, Infinity)]) assert.throws(() => createDistort(8, 8, points), coded('INVALID_ARGUMENT'));
  assert.throws(() => createDistort(8193, 1, corners(8193, 1)), coded('LIMIT_EXCEEDED'));
});

test('integer copies preserve all bytes and quarter-pixel alpha-weighted sampling matches independent exact ratios', async () => {
  const input = image(8, 8);
  for (const [x, y] of [[0, 0], [1, -2], [-3, 2], [8, 0], [0, -8]]) {
    const expected = Buffer.alloc(input.length);
    for (let sy = 0; sy < 8; sy++) for (let sx = 0; sx < 8; sx++) if (sx + x >= 0 && sx + x < 8 && sy + y >= 0 && sy + y < 8) input.copy(expected, ((sy + y) * 8 + sx + x) * 4, (sy * 8 + sx) * 4, (sy * 8 + sx + 1) * 4);
    assert.deepEqual(await distortPixels(input, 8, 8, createDistort(8, 8, corners(8, 8, x, y))), expected);
  }
  for (const [x, y] of [[1, -1], [-3, 1], [2, 3], [7, -5]]) {
    const record = createDistort(8, 8, corners(8, 8, x / 4, y / 4)), actual = await distortPixels(input, 8, 8, record);
    assert.deepEqual(actual, quarterReference(input, 8, 8, x, y));
    const changed = Buffer.from(input); for (let i = 0; i < input.length; i += 4) if (!input[i + 3]) changed.set([255, 0, 99], i);
    assert.deepEqual(await distortPixels(changed, 8, 8, record), actual);
  }
});

test('strong graph envelope counts aliases, legacy siblings, procedural inputs, ordinary callbacks and PSD retained masks', () => {
  for (const [w, h, active, expected] of [[8000, 2396, false, true], [8000, 2397, false, false], [8000, 1525, true, true], [8000, 1526, true, false]]) {
    const layer = leaf(w, h, [createDistort(w, h, corners(w, h))], active ? { filters: [filter()] } : {}), g = graph(w, h, [layer]), estimate = estimateDistortResources(g);
    assert.equal(estimate.estimatedWorkingBytes, w * h * (active ? 22 : 14));
    if (expected) validateDistortResources(g); else assert.throws(() => validateDistortResources(g), coded('LIMIT_EXCEEDED'));
  }
  const cropped = leaf(4000, 6000, [{ type: 'crop', x: 0, y: 0, width: 512, height: 512 }, createDistort(512, 512, corners(512, 512))]);
  assert.equal(estimateDistortResources(graph(512, 512, [cropped])).estimatedWorkingBytes, 99_670_016);
  const plain = leaf(8000, 2000, [{ type: 'resize', width: 8000, height: 2000 }, { type: 'resize', width: 8000, height: 2000 }], { protected: true });
  const marker = leaf(1, 1, [createDistort(1, 1, corners(1, 1)), { type: 'resize', width: 8000, height: 2000 }]);
  assert.equal(estimateDistortResources(graph(8000, 2000, [plain])).enabled, false);
  assert.throws(() => validateDistortResources(graph(8000, 2000, [plain, marker])), coded('LIMIT_EXCEEDED'));
  const layer = leaf(8, 8, [createDistort(8, 8, corners(8, 8))]), g = graph(8, 8, [layer]);
  for (const [type, addition] of [['gradient', 256], ['text', 1024 * 1024], ['shape', 1024 * 1024], ['path', 1024 * 1024], ['solid', 0]]) assert.equal(estimateDistortLeafBytes({ ...layer, type }, { canvasPixels: 64 }).estimatedWorkingBytes - estimateDistortLeafBytes(layer, { canvasPixels: 64 }).estimatedWorkingBytes, addition);
  const base = estimateDistortResources(g).estimatedWorkingBytes;
  layer.mask = { shape: 'bitmap', x: 0, y: 0, width: 8, height: 8, runs: [0, 64, 255], feather: 1, invert: false };
  assert.equal(estimateLayerMaskCallbacks(g).estimatedCallbackBytes, 0);
  assert.equal(estimateDistortResources(g).estimatedWorkingBytes - base, 6 * 64);
  assert.equal(estimateDistortPsdPreparation(g, { retain: true }), estimateDistortResources(g).estimatedWorkingBytes + 64);
  layer.maskDensity = 0; assert.equal(estimateDistortResources(g).estimatedWorkingBytes, base);
  const selection = estimateLayerSelectionBytes({ graph: g, layer, encodedSourceBytes: 23 });
  assert.equal(selection.sourceBytes, 23 + 12 * 64 + 64);
});

test('all six content types render through the same stage; arbitrary historical update/remove preserve suffix and source files', async t => {
  const { native, doc: initial } = await fixture(t); let doc = initial;
  const rasterId = doc.layers[0].id, source = await fs.readFile(path.join(native.assetsDir, doc.layers[0].asset));
  const additions = [['add_text', { text: 'A', x: 1, y: 6, fontSize: 6, color: '#80aaff' }], ['add_shape', { shape: 'ellipse', x: 1, y: 1, width: 5, height: 5, fill: '#14f922' }], ['add_path', { nodes: [{ x: 1, y: 7 }, { x: 7, y: 2 }], stroke: '#2244ee', strokeWidth: 1 }], ['add_gradient', { kind: 'linear', start: { x: 0, y: 0 }, end: { x: 8, y: 8 }, stops: [{ offset: 0, color: '#200044' }, { offset: 1, color: '#aaff00' }] }]];
  for (const [command, args] of additions) doc = await edit(native, doc, command, args);
  const solid = (await native.execute('create_document', { name: 'Solid', width: 8, height: 8, background: '#125cae' })).document;
  let g = graphOf(native, doc); g.layers.push({ ...graphOf(native, solid).layers[0], id: randomUUID() }); doc = (await native.commit(native.project(doc.id), g, 'All content')).document;
  const quad = [{ x: 1, y: 0 }, { x: 8, y: 1 }, { x: 7, y: 8 }, { x: 0, y: 7 }];
  for (const layer of doc.layers) { const original = await native.renderLayer(layer); doc = await edit(native, doc, 'add_layer_distort', { layerId: layer.id, corners: quad }); assert.deepEqual(await native.renderLayer(doc.layers.find(item => item.id === layer.id)), await distortPixels(original, 8, 8, createDistort(8, 8, quad))); }
  assert.deepEqual(new Set(doc.layers.map(layer => layer.type)), new Set(DISTORT_CONTENT_TYPES));
  doc = await edit(native, doc, 'crop_document', { x: 1, y: 1, width: 6, height: 6 });
  doc = await edit(native, doc, 'resize_document', { width: 8, height: 8, resample: 'nearest' });
  const suffix = structuredClone(doc.layers[0].transforms.slice(1));
  doc = await edit(native, doc, 'update_layer_distort', { layerId: rasterId, transformIndex: 0, corners: corners(8, 8, 1, 0) });
  assert.deepEqual(doc.layers[0].transforms.slice(1), suffix); assert.equal(doc.layers[0].transforms[0].width, 8);
  await assert.rejects(edit(native, doc, 'update_layer_distort', { layerId: rasterId, transformIndex: 1, corners: corners(8, 8) }), coded('INVALID_TARGET'));
  const updated = structuredClone(doc.layers[0].transforms); doc = await edit(native, doc, 'delete_layer_distort', { layerId: rasterId, transformIndex: 0 }); assert.deepEqual(doc.layers[0].transforms, suffix);
  doc = await edit(native, doc, 'undo'); assert.deepEqual(doc.layers[0].transforms, updated);
  assert.deepEqual(await fs.readFile(path.join(native.assetsDir, doc.layers[0].asset)), source);
  const caps = await native.execute('capabilities'); assert.equal(caps.layerDistortPolicy, DISTORT_POLICY); assert.equal(caps.layerDistortCoordinates, DISTORT_COORDINATES); assert.deepEqual(caps.layerDistortContentTypes, DISTORT_CONTENT_TYPES); assert.equal(caps.adjustmentKinds.length, 28); assert.equal(caps.layerFilterKinds.length, 32);
});

test('filter and shared source-mask result precedes Distort; Bake, portable reopen and protection keep exact composite', async t => {
  const { native, doc: initial, input } = await fixture(t); let doc = initial; const layerId = doc.layers[0].id;
  doc = await edit(native, doc, 'add_layer_filter', { layerId, kind: 'invert', value: 100, opacity: .625 });
  doc = await edit(native, doc, 'set_layer_filter_mask', { layerId, source: 'mask', mask: { shape: 'rectangle', x: 1, y: 0, width: 5, height: 8 } });
  const stack = graphOf(native, doc).layers[0].filters, filtered = await applyLayerFilters(input, 8, 8, stack), quad = corners(8, 8, .25, -.25);
  doc = await edit(native, doc, 'add_layer_distort', { layerId, corners: quad });
  assert.deepEqual(await native.renderLayer(graphOf(native, doc).layers[0]), quarterReference(filtered, 8, 8, 1, -1));
  doc = await edit(native, doc, 'set_layer_mask', { layerId, mask: { shape: 'rectangle', x: 1, y: 1, width: 6, height: 6 } });
  doc = await edit(native, doc, 'set_layer_mask_position', { layerId, x: 1, y: 0 });
  const before = await native.renderGraph(graphOf(native, doc)), saved = structuredClone(doc.layers[0]);
  await assert.rejects(edit(native, doc, 'set_layer_filter_mask', { layerId, source: 'selection' }), error => ['NO_SELECTION', 'FILTER_MASK_CAPTURE_GEOMETRY'].includes(error.code));
  doc = await edit(native, doc, 'bake_layer_filters', { layerId }); assert.deepEqual(await native.renderGraph(graphOf(native, doc)), before); assert.deepEqual(doc.layers[0].transforms, saved.transforms); assert.deepEqual(doc.layers[0].mask, saved.mask);
  doc = await edit(native, doc, 'set_layer_protection', { layerId, protected: true });
  for (const [command, args] of [['add_layer_distort', { corners: corners(8, 8) }], ['update_layer_distort', { transformIndex: 0, corners: corners(8, 8) }], ['delete_layer_distort', { transformIndex: 0 }]]) await assert.rejects(edit(native, doc, command, { layerId, ...args }), coded('PROTECTED_LAYER'));
  const reopened = (await native.importProject({ data: (await native.exportProject({ documentId: doc.id })).data })).document;
  assert.deepEqual(reopened.layers[0].transforms, saved.transforms); assert.deepEqual(await native.renderGraph(graphOf(native, reopened)), before);
});

test('metadata admission and intermediate transaction activation reject before any pixel or asset operation', async t => {
  const { native, doc: seed } = await fixture(t);
  const g = graphOf(native, seed); Object.assign(g, { width: 8000, height: 1600 }); Object.assign(g.layers[0], { width: 8000, height: 1600, transforms: [createDistort(8000, 1600, corners(8000, 1600))], filters: [filter({ enabled: false })] });
  let doc = (await native.newProject(g, 'Large metadata')).document; const before = JSON.stringify(native.project(doc.id)); let reads = 0;
  const oldRender = native.renderLayer, oldStore = native.storeAsset; native.renderLayer = async () => { reads++; throw Error('Read pixels'); }; native.storeAsset = async () => { reads++; throw Error('Stored pixels'); };
  try {
    await assert.rejects(edit(native, doc, 'apply_transaction', { label: 'Distort transaction', operations: [{ command: 'update_layer_filter', args: { layerId: doc.layers[0].id, filterId: doc.layers[0].filters[0].id, enabled: true } }, { command: 'delete_layer_distort', args: { layerId: doc.layers[0].id, transformIndex: 0 } }] }), coded('LIMIT_EXCEEDED'));
    assert.equal(reads, 0); assert.equal(JSON.stringify(native.project(doc.id)), before);
    const workGraph = graphOf(native, doc); workGraph.width = 1; workGraph.height = 1; workGraph.layers[0].filters = []; workGraph.layers[0].transforms = [createDistort(8000, 1600, corners(8000, 1600)), createDistort(8000, 1600, corners(8000, 1600)), { type: 'resize', width: 1, height: 1 }];
    assert.throws(() => native.validateGraph(workGraph), coded('LIMIT_EXCEEDED'));
    const oldOnly = graphOf(native, doc); oldOnly.layers[0].transforms = []; oldOnly.layers[0].filters[0].enabled = true; native.validateGraph(oldOnly);
  } finally { native.renderLayer = oldRender; native.storeAsset = oldStore; }
});

test('call-time copying, strict native corners and actual durable/late failure preserve state, assets and previews', async t => {
  const { native, doc: initial } = await fixture(t); let doc = initial; const layerId = doc.layers[0].id;
  let release; const blocked = new Promise(resolve => { release = resolve; }); const blocker = native.enqueue(() => blocked);
  const args = { documentId: doc.id, expectedRevision: doc.revision, layerId, corners: corners(8, 8, 1, 0) }, pending = native.execute('add_layer_distort', args);
  args.corners[0].x = 999; args.layerId = randomUUID(); release(); await blocker; doc = (await pending).document; assert.equal(doc.layers[0].transforms[0].corners[0].x, 1);
  const bad = corners(8, 8); Object.defineProperty(bad[0], 'x', { enumerable: true, get() { throw Error('Getter ran'); } }); await assert.rejects(edit(native, doc, 'add_layer_distort', { layerId, corners: bad }), coded('INVALID_ARGUMENT'));
  await native.execute('get_preview', { documentId: doc.id }); const before = JSON.stringify(native.project(doc.id)), assets = await fs.readdir(native.assetsDir), cache = native.previewCache.stats(), directory = native.projectsDir;
  native.projectsDir = path.join(native.assetsDir, doc.layers[0].asset);
  try { await assert.rejects(edit(native, doc, 'update_layer_distort', { layerId, transformIndex: 0, corners: corners(8, 8, 0, 1) }), coded('ENOTDIR')); } finally { native.projectsDir = directory; }
  await assert.rejects(edit(native, doc, 'apply_transaction', { label: 'Distort transaction', operations: [{ command: 'update_layer_distort', args: { layerId, transformIndex: 0, corners: corners(8, 8) } }, { command: 'delete_layer_distort', args: { layerId, transformIndex: 9 } }] }), coded('NOT_FOUND'));
  assert.equal(JSON.stringify(native.project(doc.id)), before); assert.deepEqual(await fs.readdir(native.assetsDir), assets); assert.deepEqual(native.previewCache.stats(), cache);
});

test('general and exact-copy paths yield on maximum-width inputs with bounded output ownership', async () => {
  const width = 8192, height = 128, input = image(width, height);
  for (const quad of [corners(width, height, 1, 0), corners(width, height, .25, -.25)]) {
    let ticks = 0, active = true; const pulse = () => { if (active) { ticks++; setImmediate(pulse); } }; setImmediate(pulse);
    try { const output = await distortPixels(input, width, height, createDistort(width, height, quad)); assert.equal(output.length, input.length); assert.notEqual(output, input); assert.ok(ticks >= 16); } finally { active = false; }
  }
});
