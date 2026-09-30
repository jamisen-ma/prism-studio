import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { bitmapMask, maskCoverage } from '../server/masks.mjs';
import { layerMaskCoverage } from '../server/layer-mask.mjs';
import { loadLayerSelection } from '../server/layer-selection.mjs';
import { renderMaskPreview, maskPreviewDimensions, estimateMaskPreviewBytes, MASK_PREVIEW_LIMITS } from '../server/mask-preview.mjs';

const coded = code => cause => cause.code === code;
const decoded = async result => sharp(Buffer.isBuffer(result.data) ? result.data : Buffer.from(result.data, 'base64')).toColourspace('srgb').ensureAlpha().raw().toBuffer();
const grayBytes = rgba => Buffer.from(Array.from({ length: rgba.length / 4 }, (_, p) => { assert.deepEqual([...rgba.subarray(p * 4, p * 4 + 4)], [rgba[p * 4], rgba[p * 4], rgba[p * 4], 255]); return rgba[p * 4]; }));
const edit = async (native, doc, command, args = {}) => (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document;
const get = async (native, doc) => (await native.execute('get_document', { documentId: doc.id })).document;
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-mask-preview-'));
  const native = await new NativeBackend({ dataDir, segmentSubject: async () => { throw Error('Forbidden model'); } }).init();
  t.after(async () => { await native.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const rgba = Buffer.from(Array.from({ length: 35 }, (_, p) => [p * 3, p * 5, p * 7, [0, 1, 128, 255][p % 4]]).flat());
  const original = await sharp(rgba, { raw: { width: 7, height: 5, channels: 4 } }).png().toBuffer();
  let doc = (await native.execute('import_image', { data: original.toString('base64'), mimeType: 'image/png' })).document;
  doc = await edit(native, doc, 'select_rectangle', { x: 1, y: 1, width: 5, height: 3, feather: 1.5 });
  return { native, doc, dataDir, original };
}

test('every alpha8 value encodes as exact opaque grayscale without ICC, palette or source dimensions changing', async () => {
  const values = Buffer.from(Array.from({ length: 256 }, (_, i) => i)), selection = bitmapMask(values, 256, 1);
  const graph = { width: 256, height: 1, selection, layers: [] }, before = structuredClone(graph);
  const result = await renderMaskPreview(graph);
  assert.deepEqual(grayBytes(await decoded(result)), values);
  const metadata = await sharp(result.data).metadata(); assert.equal(metadata.channels, 1); assert.equal(metadata.hasAlpha, false); assert.equal(metadata.icc, undefined); assert.equal(metadata.isPalette, false);
  assert.deepEqual({ ...result, data: undefined }, { data: undefined, mimeType: 'image/png', width: 256, height: 1, sourceWidth: 256, sourceHeight: 1, source: 'selection', sampling: 'nearest-pixel-center', maxEdge: 700 });
  assert.deepEqual(graph, before);
});

test('native resolution evaluates stored mask feather, inversion and clipping exactly once, including explicit empty selection', async () => {
  const width = 7, height = 5;
  const masks = [
    { shape: 'rectangle', x: 0, y: 0, width: 6, height: 4, feather: 2, invert: true, clip: { x: 1, y: 1, width: 4, height: 3 } },
    { shape: 'ellipse', x: 0.2, y: 0, width: 6.6, height: 5, feather: 1.5, invert: false },
    { shape: 'polygon', points: [{ x: 0, y: 0 }, { x: 7, y: 2 }, { x: 2, y: 5 }], x: 0, y: 0, width: 7, height: 5, feather: 1.3, invert: false },
    { ...bitmapMask(Buffer.from(Array.from({ length: 35 }, (_, p) => p % 5 ? [1, 128, 255][p % 3] : 0)), width, height), feather: 1.2, invert: true },
    bitmapMask(Buffer.alloc(35), width, height), { ...bitmapMask(Buffer.alloc(35), width, height), invert: true },
  ];
  for (const mask of masks) {
    const graph = { width, height, selection: mask, layers: [] }, before = structuredClone(graph), coverage = maskCoverage(mask);
    const result = await renderMaskPreview(graph, { maxEdge: 32 });
    assert.deepEqual(grayBytes(await decoded(result)), Buffer.from(Array.from({ length: 35 }, (_, p) => Math.round(255 * coverage(p % width, Math.floor(p / width))))));
    assert.deepEqual(graph, before);
  }
});

test('additional masks ignore all display context and raw/effective modes apply density only after quantized-independent coverage', async () => {
  const width = 7, height = 5, mask = { shape: 'rectangle', x: 0, y: 0, width: 6, height: 4, feather: 1, invert: true, clip: { x: 1, y: 1, width: 4, height: 3 } }, raw = maskCoverage(mask);
  for (const type of ['raster', 'group', 'adjustment']) for (const density of [0, 0.5, 1]) for (const maskMode of ['raw', 'effective']) {
    const layer = { id: 'target', type, opacity: 0, visible: false, protected: true, blendMode: 'multiply', mask, maskDensity: density, asset: 'missing' };
    const graph = { width, height, selection: null, layers: [layer] }, before = structuredClone(graph);
    const result = await renderMaskPreview(graph, { source: 'layer-mask', layerId: layer.id, maskMode });
    const expected = Buffer.from(Array.from({ length: 35 }, (_, p) => { const value = raw(p % width, Math.floor(p / width)); return Math.round(255 * (maskMode === 'raw' ? value : 1 - density * (1 - value))); }));
    assert.deepEqual(grayBytes(await decoded(result)), expected); assert.equal(result.maskMode, maskMode); assert.equal(result.layerId, layer.id); assert.deepEqual(graph, before);
    if (density === 0.5 && maskMode === 'effective') assert.equal(expected[0], 128);
  }
});

test('shared density preserves rational alpha8 half-up ties for every forward and inverted bitmap value', async () => {
  const ramp = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  for (const numerator of [1, 2, 3]) for (const invert of [false, true]) {
    const mask = { ...bitmapMask(ramp, 256, 1), invert }, layer = { id: 'ramp', type: 'solid', mask, maskDensity: numerator / 4 };
    const graph = { width: 256, height: 1, layers: [layer], selection: null }, coverage = layerMaskCoverage(layer);
    const expected = Buffer.from(ramp.map(byte => Math.round((255 * 4 - numerator * (255 - (invert ? 255 - byte : byte))) / 4)));
    assert.deepEqual(Buffer.from(ramp.map((_, x) => Math.round(coverage(x, 0) * 255))), expected);
    assert.deepEqual(grayBytes(await decoded(await renderMaskPreview(graph, { source: 'layer-mask', layerId: layer.id }))), expected);
    const selected = await loadLayerSelection(graph, { source: 'layer-mask', layerId: layer.id });
    const selectedCoverage = maskCoverage(selected.selection);
    assert.deepEqual(Buffer.from(ramp.map((_, x) => Math.round(selectedCoverage(x, 0) * 255))), expected);
  }
  // Continuous geometric coverage must remain continuous before density. This
  // point has raw coverage 1/7; early byte quantization changes its exact value.
  const geometric = { mask: { x: 0, y: 0, width: 10, height: 10, feather: 3.5, invert: false }, maskDensity: 0.5 };
  assert.ok(Math.abs(layerMaskCoverage(geometric)(0, 0) - 4 / 7) < 2e-16);
  assert.notEqual(layerMaskCoverage(geometric)(0, 0), (255 + Math.round(255 / 7)) / 510);
});

test('density byte-space rounding composes with independent source alpha and canvas-clipped inverted bitmap coverage', async t => {
  const { native } = await fixture(t), width = 256, height = 4, sourceAlpha = [0, 1, 128, 255];
  const rgba = Buffer.from(Array.from({ length: width * height }, (_, p) => [80, 120, 160, sourceAlpha[Math.floor(p / width)]]).flat());
  let doc = (await native.execute('import_image', { data: (await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer()).toString('base64'), mimeType: 'image/png' })).document;
  const layerId = doc.layers[0].id, sourceBytes = await fs.readFile(path.join(native.assetsDir, doc.layers[0].asset));
  for (const invert of [false, true]) for (const numerator of [1, 2, 3]) {
    const mask = { ...bitmapMask(Buffer.from(Array.from({ length: width * height }, (_, p) => p % width)), width, height), invert };
    doc = await edit(native, doc, 'set_layer_mask', { layerId, mask });
    doc = await edit(native, doc, 'modify_layer_mask', { layerId, density: numerator / 4 });
    const rendered = await native.render(native.project(doc.id));
    for (let p = 0; p < width * height; p++) {
      const b = invert ? 255 - p % width : p % width, a = sourceAlpha[Math.floor(p / width)];
      const rationalNumerator = BigInt(a * (1020 - numerator * (255 - b))), denominator = 1020n;
      const expected = Number((2n * rationalNumerator + denominator) / (2n * denominator));
      assert.equal(rendered[p * 4 + 3], expected);
    }
  }
  // Canvas expansion bakes the inverted raw bitmap and its old support into
  // alpha8. Density still reveals the new margins without reviving source alpha.
  doc = await edit(native, doc, 'resize_canvas', { width: 258, height: 6, anchor: 'center' });
  const result = await native.execute('get_mask_preview', { documentId: doc.id, source: 'layer-mask', layerId }), inspected = grayBytes(await decoded(result));
  for (let y = 0; y < 6; y++) for (let x = 0; x < 258; x++) {
    const b = x >= 1 && x < 257 && y >= 1 && y < 5 ? 256 - x : 0;
    assert.equal(inspected[y * 258 + x], Math.round((1020 - 3 * (255 - b)) / 4));
  }
  const expanded = await native.render(native.project(doc.id)); assert.equal(expanded[3], 0);
  assert.deepEqual(await fs.readFile(path.join(native.assetsDir, doc.layers[0].asset)), sourceBytes);
});

test('longest-edge rounding is exact at half ties and sampling uses source pixel centers without enlargement', async () => {
  const fixtures = [[420, 840, 457, 229, 457], [220, 520, 299, 127, 299], [1265, 2024, 1340, 838, 1340], [1, 8192, 32, 1, 32], [8192, 1, 32, 32, 1], [67, 41, 32, 32, 20], [3, 5, 32, 3, 5]];
  for (const [width, height, maxEdge, outWidth, outHeight] of fixtures) assert.deepEqual(maskPreviewDimensions(width, height, maxEdge), { width: outWidth, height: outHeight });
  for (const [width, height, maxEdge] of [[67, 41, 32], [1, 8192, 32], [8192, 1, 32], [3, 5, 32]]) {
    const data = Buffer.from(Array.from({ length: width * height }, (_, p) => (p * 37 + Math.floor(p / width) * 11) % 256));
    const result = await renderMaskPreview({ width, height, selection: bitmapMask(data, width, height), layers: [] }, { maxEdge });
    const actual = grayBytes(await decoded(result)), expected = Buffer.alloc(result.width * result.height);
    for (let y = 0; y < result.height; y++) for (let x = 0; x < result.width; x++) {
      const sx = Number((BigInt(2 * x + 1) * BigInt(width)) / BigInt(2 * result.width)), sy = Number((BigInt(2 * y + 1) * BigInt(height)) / BigInt(2 * result.height));
      expected[y * result.width + x] = data[sy * width + sx];
    }
    assert.deepEqual(actual, expected);
  }
});

test('resource ledger includes callback, sampled/codec planes, PNG cap and pessimistic base64/JSON/transfer copies', () => {
  const graph = { width: 6000, height: 4000 }, mask = { shape: 'bitmap', width: 6000, height: 4000, feather: 2, runs: [] };
  for (const source of ['selection', 'layer-mask']) for (const maskMode of ['raw', 'effective']) for (const density of [0, 0.5, 1]) {
    const result = estimateMaskPreviewBytes({ graph, mask, source, maskMode, density, maxEdge: 2400 });
    const count = 2400 * 1600, c = source === 'layer-mask' && maskMode === 'effective' && density === 0 ? 0 : 120_000_000, e = 8 * 1024 * 1024, b = 4 * Math.ceil(e / 3);
    assert.equal(result.coverageBytes, c); assert.equal(result.sampledBytes, count); assert.equal(result.codecBytes, 4 * count);
    assert.equal(result.encodedBytes, e); assert.equal(result.base64Bytes, b); assert.equal(result.transferBytes, 5 * b);
    assert.equal(result.estimatedWorkingBytes, c + 5 * count + e + 5 * b); assert.ok(result.estimatedWorkingBytes < result.maxWorkingBytes);
  }
  assert.equal(estimateMaskPreviewBytes({ graph, mask: { ...mask, feather: 0 } }).coverageBytes, 24_000_000);
  assert.equal(estimateMaskPreviewBytes({ graph, mask: { shape: 'rectangle' } }).coverageBytes, 0);
  assert.throws(() => maskPreviewDimensions(8192, 8192, 2400), coded('LIMIT_EXCEEDED'));
  for (const edge of [0, 31, 2401, 32.5, null, NaN]) assert.throws(() => maskPreviewDimensions(32, 32, edge), coded('INVALID_ARGUMENT'));
});

test('read-only native preview neither reads corrupt/missing image assets nor touches graph, files or composite cache', async t => {
  const { native, doc: start, original } = await fixture(t); const id = start.layers[0].id;
  let doc = await edit(native, start, 'set_layer_mask', { layerId: id, mask: { x: 1, y: 1, width: 5, height: 3, feather: 1 } });
  doc = await edit(native, doc, 'modify_layer_mask', { layerId: id, density: 0.5 });
  await native.execute('get_preview', { documentId: doc.id }); const cache = native.previewCache.stats();
  const projectFiles = await fs.readdir(native.projectsDir), projectBytes = await Promise.all(projectFiles.map(file => fs.readFile(path.join(native.projectsDir, file))));
  const sourcePath = path.join(native.assetsDir, doc.layers[0].asset); await fs.unlink(sourcePath);
  const forbidden = () => { throw Error('Mask inspection cannot render, read, save or mutate caches'); };
  for (const method of ['renderLayer', 'renderGraph', 'readAlpha', 'storeAsset', 'persist']) native[method] = forbidden;
  for (const method of ['get', 'set', 'invalidateDocument', 'clear']) native.previewCache[method] = forbidden;
  for (const args of [{}, { source: 'layer-mask', layerId: id }, { source: 'layer-mask', layerId: id, maskMode: 'raw' }]) {
    const result = await native.execute('get_mask_preview', { documentId: doc.id, expectedRevision: doc.revision, ...args });
    assert.equal(result.documentId, doc.id); assert.equal(result.revision, doc.revision); assert.equal(result.width, 7); assert.equal(result.height, 5); assert.ok((await decoded(result)).length);
  }
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(native.previewCache.stats(), cache);
  assert.deepEqual(await Promise.all(projectFiles.map(file => fs.readFile(path.join(native.projectsDir, file)))), projectBytes);
  await fs.writeFile(sourcePath, Buffer.from('corrupt image bytes'));
  await native.execute('get_mask_preview', { documentId: doc.id });
  await fs.writeFile(sourcePath, original);
});

test('invalid or stale previews fail without mutation and density zero does not bypass raw descriptor validation', async t => {
  const { native, doc } = await fixture(t), layerId = doc.layers[0].id;
  for (const args of [{ layerId }, { maskMode: 'raw' }, { source: 'bad' }, { source: null }, { source: 'layer-mask' }, { source: 'layer-mask', layerId: 'missing' }, { source: 'layer-mask', layerId }, { maxEdge: 2401 }])
    await assert.rejects(native.execute('get_mask_preview', { documentId: doc.id, ...args }));
  await assert.rejects(native.execute('get_mask_preview', { documentId: doc.id, expectedRevision: doc.revision - 1 }), coded('REVISION_CONFLICT'));
  await assert.rejects(renderMaskPreview({ width: 7, height: 5, selection: null, layers: [] }), coded('NO_SELECTION'));
  for (const mask of [{ shape: 'bitmap', width: 7, height: 5, runs: [0, 36, 255] }, { shape: 'rectangle', x: 0, y: 0, width: 7, height: 5, density: 0 }])
    await assert.rejects(renderMaskPreview({ width: 7, height: 5, layers: [{ id: 'x', mask, maskDensity: 0 }] }, { source: 'layer-mask', layerId: 'x' }), coded('INVALID_ARGUMENT'));
  assert.deepEqual(await get(native, doc), doc);
});

test('native queue binds pixels to the revision at execution and never relabels a stale queued request', async t => {
  const { native, doc } = await fixture(t);
  let release; const gate = new Promise(resolve => { release = resolve; }); native.enqueue(() => gate);
  const readBefore = native.execute('get_mask_preview', { documentId: doc.id, expectedRevision: doc.revision });
  const mutate = native.execute('modify_selection', { documentId: doc.id, expectedRevision: doc.revision, invert: true });
  const staleRead = native.execute('get_mask_preview', { documentId: doc.id, expectedRevision: doc.revision });
  const stale = assert.rejects(staleRead, coded('REVISION_CONFLICT'));
  release(); const before = await readBefore, changed = (await mutate).document; await stale;
  assert.equal(before.revision, doc.revision); assert.equal(changed.revision, doc.revision + 1);
  const after = await native.execute('get_mask_preview', { documentId: doc.id, expectedRevision: changed.revision });
  assert.equal(after.revision, changed.revision); assert.notDeepEqual(await decoded(after), await decoded(before));
  assert.deepEqual(await get(native, doc), changed);
});
