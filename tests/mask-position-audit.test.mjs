import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { maskCoverage, normalizeMask } from '../server/masks.mjs';
import { rawLayerMaskCoverage, layerMaskCoverage, setLayerMaskPosition, transformPositionedMask,
  estimateLayerMaskCallbacks, validateLayerMaskResources, layerMaskStorageBytes, sampleLayerMaskAlpha } from '../server/layer-mask.mjs';
import { validateLayerFilterResources } from '../server/layer-filters.mjs';
import { layerTree } from '../server/groups.mjs';
import { estimateMaskPreviewBytes } from '../server/mask-preview.mjs';
import { estimateLayerSelectionBytes } from '../server/layer-selection.mjs';
import { encodeProjectBundle } from '../server/project-bundle.mjs';

const common = extra => ({ id: randomUUID(), name: 'Independent positioned mask', visible: true, opacity: 1, blendMode: 'normal', ...extra });
const solid = (width, height, extra = {}) => common({ type: 'solid', width, height, color: '#234f81', transforms: [], ...extra });
const bitmap = (values, width, height, extra = {}) => ({ shape: 'bitmap', x: 0, y: 0, width, height, feather: 0, invert: false,
  runs: values.flatMap((value, index) => value ? [index, 1, value] : []), ...extra });
const wrap = (source, sourceWidth, sourceHeight, x, y, extra = {}) => ({ shape: 'positioned', source, sourceWidth, sourceHeight, x, y, ...extra });
const graph = (width, height, layers) => ({ name: 'Position audit', width, height, selection: null, layers });
const pixel = (rgba, i) => [...rgba.subarray(i * 4, i * 4 + 4)];
const edit = async (native, doc, command, args = {}) => (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document;
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-mask-position-audit-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return { native: await new NativeBackend({ dataDir }).init(), dataDir };
}
async function raster(native, rgba, width, height, extra = {}) {
  const png = await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer(), asset = await native.storeAsset(png);
  return common({ type: 'raster', width, height, transforms: [], asset, sourceAsset: asset, sourceFormat: 'png', ...extra });
}

test('positioned alpha8 uses exact density ties, inverted exterior and domain-before-density for all 256 values', async () => {
  const values = Array.from({ length: 256 }, (_, i) => i), source = bitmap(values, 256, 1);
  for (const invert of [false, true]) for (const [ox, oy] of [[3, 1], [-4, -1]]) for (const domain of [undefined, { x: 10, y: 0, width: 225, height: 1 }]) {
    const mask = wrap({ ...source, invert }, 256, 1, ox, oy, ...(domain ? [{ domain }] : []));
    for (const densityQuarters of [0, 1, 2, 3, 4]) {
      const layer = { mask, maskDensity: densityQuarters / 4 }, raw = rawLayerMaskCoverage(layer), effective = layerMaskCoverage(layer);
      for (let y = -2; y <= 3; y++) for (let x = -7; x <= 264; x++) {
        const sx = x - ox, sy = y - oy, stored = sy === 0 && sx >= 0 && sx < 256 ? values[sx] : 0;
        let rawByte = invert ? 255 - stored : stored;
        if (domain && !(sx >= domain.x && sx < domain.x + domain.width && sy >= domain.y && sy < domain.y + domain.height)) rawByte = 0;
        assert.equal(Math.round(raw(x, y) * 255), rawByte);
        const expected = Math.floor((4 * 255 - densityQuarters * (255 - rawByte)) / 4 + 0.5);
        assert.equal(Math.round(effective(x, y) * 255), expected, `alpha=${stored}, inversion=${invert}, density=${densityQuarters}/4`);
      }
      assert.deepEqual(await sampleLayerMaskAlpha(layer, 264, 4), await sampleLayerMaskAlpha({ mask }, 264, 4), 'raw materialization never bakes density');
    }
  }
  const empty = { mask: wrap(bitmap([], 3, 2, { invert: true }), 3, 2, 100, -100) };
  assert.equal(rawLayerMaskCoverage(empty)(0, 0), 1, 'positioning does not add a finite black exterior to an inverted source');
});

test('bitmap feather keeps original boundaries and fractional geometric movement is exactly reversible', () => {
  const width = 7, height = 5, source = bitmap(Array(width * height).fill(255), width, height, { feather: 1.5 });
  for (const invert of [false, true]) {
    const layer = { mask: wrap({ ...source, invert }, width, height, 4, -2) }, coverage = rawLayerMaskCoverage(layer);
    for (let y = -4; y < 8; y++) for (let x = -2; x < 14; x++) {
      const sx = x - 4, sy = y + 2;
      const byte = sx >= 0 && sx < width && sy >= 0 && sy < height
        ? Math.round(255 * Math.min(1, (Math.min(sx, sy, width - 1 - sx, height - 1 - sy) + 0.5) / 1.5)) : 0;
      assert.equal(Math.round(coverage(x, y) * 255), invert ? 255 - byte : byte);
    }
  }
  const ellipse = { shape: 'ellipse', x: -0.2, y: 0.3, width: 6.4, height: 4.1, feather: 1.2, invert: true, clip: { x: 0.125, y: 0.75, width: 5.875, height: 3.5 } };
  const original = structuredClone(ellipse), legacy = maskCoverage(ellipse);
  let layer = { mask: ellipse, maskDensity: 0.5 };
  for (const [x, y] of [[15000, -14000], [-16384, 16384], [3, -2], [0, 0]]) {
    layer = { ...layer, mask: setLayerMaskPosition(layer, width, height, x, y) };
    const coverage = rawLayerMaskCoverage(layer);
    for (let sy = -2; sy < 7; sy++) for (let sx = -2; sx < 9; sx++) assert.equal(coverage(sx + x, sy + y), legacy(sx, sy));
  }
  assert.deepEqual(layer.mask, original); assert.deepEqual(ellipse, original);
  assert.throws(() => normalizeMask(wrap(original, width, height, 1, 0), width, height, { persisted: true }), { code: 'INVALID_ARGUMENT' }, 'legacy readers fail closed');
});

test('crop and every canvas anchor match document-space oracle including retained-domain loss', () => {
  const width = 7, height = 5;
  const masks = [
    { shape: 'ellipse', x: -0.3, y: 0.2, width: 6.7, height: 4.3, feather: 1.7, invert: true, clip: { x: -1, y: 0.5, width: 8, height: 4 } },
    bitmap(Array.from({ length: width * height }, (_, i) => i % 4 === 0 ? 0 : 53 + i), width, height, { feather: 1.25, invert: true }),
  ];
  for (const source of masks) for (const [ox, oy] of [[-6, 3], [2, -1], [0, 0]]) {
    const initial = wrap(source, width, height, ox, oy), before = rawLayerMaskCoverage({ mask: initial });
    const crop = transformPositionedMask(initial, { type: 'crop', x: 2, y: 1, width: 4, height: 3 }, width, height);
    assert.deepEqual(crop.source, source); assert.equal(crop.sourceWidth, width); assert.equal(crop.sourceHeight, height); assert.equal(crop.domain, undefined);
    const cropped = rawLayerMaskCoverage({ mask: crop });
    for (let y = -8; y < 10; y++) for (let x = -8; x < 10; x++) assert.equal(cropped(x, y), before(x + 2, y + 1));
    for (const [newWidth, newHeight] of [[10, 8], [4, 3]]) for (const ax of [0, 0.5, 1]) for (const ay of [0, 0.5, 1]) {
      const dx = Math.floor((newWidth - width) * ax), dy = Math.floor((newHeight - height) * ay);
      const resized = transformPositionedMask(initial, { type: 'canvas', x: dx, y: dy, width: newWidth, height: newHeight }, width, height);
      const coverage = rawLayerMaskCoverage({ mask: resized });
      for (let y = -2; y < newHeight + 2; y++) for (let x = -2; x < newWidth + 2; x++) {
        const sx = x - dx, sy = y - dy;
        const expected = x >= 0 && x < newWidth && y >= 0 && y < newHeight && sx >= 0 && sx < width && sy >= 0 && sy < height ? before(sx, sy) : 0;
        assert.equal(coverage(x, y), expected);
      }
      assert.deepEqual(resized.source, source);
    }
  }
  const initial = wrap(bitmap([255, 0, 0, 0], 4, 1), 4, 1, 4, 0);
  assert.equal(rawLayerMaskCoverage({ mask: initial })(4, 0), 1);
  const expanded = transformPositionedMask(initial, { type: 'canvas', x: 0, y: 0, width: 8, height: 1 }, 4, 1);
  assert.equal(rawLayerMaskCoverage({ mask: expanded })(4, 0), 0);
  const reset = setLayerMaskPosition({ mask: expanded }, 8, 1, 0, 0);
  assert.equal(reset.shape, 'positioned'); assert.equal(rawLayerMaskCoverage({ mask: reset })(0, 0), 0, 'bounds domain deliberately cannot recover excluded coverage by resetting offsets');
});

test('retained-source callback and renderer budgets combine, including empty groups, filters and density-zero raw reads', () => {
  const source = bitmap([], 6000, 4000, { feather: 1 }), mask = wrap(source, 6000, 4000, 1, 0);
  const layer = solid(1000, 1000, { mask });
  assert.deepEqual(estimateLayerMaskCallbacks(graph(1000, 1000, [layer])), { bitmapBytes: 24_000_000, featherBytes: 96_000_000, estimatedCallbackBytes: 144_000_000, maxCallbackBytes: 268_435_456 });
  assert.equal(layerMaskStorageBytes(layer), 120_000_000);
  assert.equal(layerMaskStorageBytes({ ...layer, maskDensity: 0 }), 0);
  assert.equal(layerMaskStorageBytes({ ...layer, maskDensity: 0 }, { raw: true }), 120_000_000);
  const small = graph(1, 1, [{ ...layer, width: 1, height: 1 }]);
  assert.equal(estimateMaskPreviewBytes({ graph: small, mask, source: 'layer-mask', maskMode: 'raw' }).coverageBytes, 120_000_000);
  assert.equal(estimateLayerSelectionBytes({ graph: small, layer, source: 'layer-mask', maskMode: 'raw' }).maskBytes, 120_000_001);
  assert.equal(estimateLayerSelectionBytes({ graph: small, layer: { ...layer, maskDensity: 0 }, source: 'layer-mask', maskMode: 'effective' }).maskBytes, 1);

  // 24 MP bitmap reserve (144M) + a 24 MP masked group surface (120M)
  // is admitted, while another group surface raises the sum over
  // the256MiB cap. Both independently fit their older separate envelopes.
  const emptyGroup = common({ type: 'group', mode: 'isolated', mask });
  const emptyGraph = graph(6000, 4000, [emptyGroup]);
  assert.equal(validateLayerFilterResources(emptyGraph, layerTree(emptyGraph.layers)).estimatedScratchBytes, 264_000_000);
  const second = common({ type: 'group', mode: 'isolated', parentId: emptyGroup.id });
  const nested = graph(6000, 4000, [emptyGroup, second]);
  assert.throws(() => validateLayerFilterResources(nested, layerTree(nested.layers)), { code: 'LIMIT_EXCEEDED' });
  assert.throws(() => validateLayerMaskResources(small, 125_000_000), { code: 'LIMIT_EXCEEDED' });

  const filtered = common({ type: 'raster', width: 6000, height: 3000, transforms: [{ type: 'crop', x: 0, y: 0, width: 1, height: 1 }], mask,
    filters: [{ id: randomUUID(), kind: 'brightness', value: 2, enabled: true, opacity: 1 }] });
  const filteredGraph = graph(1, 1, [filtered]);
  assert.throws(() => validateLayerFilterResources(filteredGraph, layerTree(filteredGraph.layers)), { code: 'LIMIT_EXCEEDED' });
  delete filtered.mask;
  assert.equal(validateLayerFilterResources(filteredGraph, layerTree(filteredGraph.layers)).estimatedCallbackBytes, 0, 'legacy-only admission remains unchanged');
});

test('native raw/effective inspection, layer alpha and selection match independent positioned ramp bytes', async t => {
  const { native } = await fixture(t), width = 262, height = 3, ramp = Array.from({ length: 256 }, (_, i) => i);
  const source = bitmap(ramp, 256, 1, { invert: true }), layer = solid(width, height, { mask: wrap(source, 256, 1, 3, 1), maskDensity: 0.5 });
  let doc = (await native.newProject(graph(width, height, [layer]), 'Position fixture')).document;
  const assets = await fs.readdir(native.assetsDir), sourceBefore = structuredClone(doc.layers[0].mask), oldRevision = doc.revision;
  const effective = Buffer.alloc(width * height), raw = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sourceByte = y === 1 && x >= 3 && x < 259 ? x - 3 : 0, beforeDensity = 255 - sourceByte;
    raw[y * width + x] = beforeDensity;
    effective[y * width + x] = Math.floor((255 + beforeDensity) / 2 + 0.5);
  }
  for (const [maskMode, expected] of [['raw', raw], ['effective', effective]]) {
    const result = await native.execute('get_mask_preview', { documentId: doc.id, expectedRevision: doc.revision, layerId: layer.id, source: 'layer-mask', maskMode });
    const pixels = await sharp(Buffer.from(result.data, 'base64')).ensureAlpha().raw().toBuffer();
    assert.equal(result.sourceWidth, width); assert.equal(result.sourceHeight, height);
    for (let i = 0; i < expected.length; i++) assert.deepEqual(pixel(pixels, i), [expected[i], expected[i], expected[i], 255]);
  }
  assert.equal((await native.execute('get_document', { documentId: doc.id })).document.revision, oldRevision);
  const rendered = await native.renderGraph(doc);
  for (let i = 0; i < effective.length; i++) assert.equal(rendered[i * 4 + 3], effective[i]);
  doc = await edit(native, doc, 'load_layer_selection', { layerId: layer.id, source: 'layer-mask', maskMode: 'effective', invert: true });
  const selected = Buffer.alloc(width * height);
  for (let i = 0; i < doc.selection.runs.length; i += 3) selected.fill(doc.selection.runs[i + 2], doc.selection.runs[i], doc.selection.runs[i] + doc.selection.runs[i + 1]);
  assert.deepEqual(selected, Buffer.from(effective, undefined).map(value => 255 - value), 'selection quantizes first and then inverts bytes');
  assert.deepEqual(doc.layers[0].mask, sourceBefore); assert.deepEqual(await fs.readdir(native.assetsDir), assets);
});

test('moving own or ancestor masks immediately updates protected fill/filter/generation coverage, including alpha one', async t => {
  const { native } = await fixture(t), width = 8, height = 3, count = width * height;
  const originalBytes = Buffer.from(Array.from({ length: count }, (_, i) => [31 + i, 72, 153, [1, 128, 255][i % 3]]).flat());
  const generatedPng = await sharp({ create: { width, height, channels: 4, background: '#dd2299' } }).png().toBuffer();
  for (const owner of ['layer', 'group']) {
    const mask = { shape: 'rectangle', x: 0, y: 0, width: 3, height, feather: 0, invert: false };
    const subject = await raster(native, originalBytes, width, height, { protected: true, ...(owner === 'layer' ? { mask } : {}) });
    const groupLayer = owner === 'group' ? common({ type: 'group', mode: 'pass-through', mask }) : null;
    if (groupLayer) subject.parentId = groupLayer.id;
    const targetId = groupLayer?.id ?? subject.id;
    let doc = (await native.newProject(graph(width, height, [solid(width, height, { color: '#112233' }), ...(groupLayer ? [groupLayer] : []), subject]), 'Protection fixture')).document;
    const sourceFile = await fs.readFile(path.join(native.assetsDir, subject.sourceAsset));
    const captured = await native.snapshotForGeneration({ documentId: doc.id, expectedRevision: doc.revision, scope: 'document' });
    doc = await edit(native, doc, 'set_layer_mask_position', { layerId: targetId, x: 3, y: 0 });
    const protectedPixels = await native.protectedPixels(doc);
    for (let i = 0; i < count; i++) assert.equal(protectedPixels[i], i % width >= 3 && i % width < 6 ? 1 : 0);
    const fresh = await native.snapshotForGeneration({ documentId: doc.id, expectedRevision: doc.revision, scope: 'document' });
    const freshAlpha = await sharp(fresh.mask).ensureAlpha().raw().toBuffer();
    for (let i = 0; i < count; i++) assert.equal(freshAlpha[i * 4 + 3], protectedPixels[i] ? 255 : 0);

    // The saved request protects its old area, while installation also checks
    // the newly exposed current subject; no provider or generation API runs.
    const installed = await native.installGeneratedImage({ data: generatedPng, documentId: doc.id, expectedRevision: doc.revision, mask: captured.mask, provenance: { jobId: randomUUID(), mode: 'edit' } });
    doc = installed.document;
    const generatedLayer = doc.layers.find(item => item.id === installed.layerId), installedPixels = await native.renderLayer(generatedLayer);
    for (let i = 0; i < count; i++) assert.equal(installedPixels[i * 4 + 3], i % width < 6 ? 0 : 255);
    doc = await edit(native, doc, 'set_layer_mask_position', { layerId: targetId, x: 6, y: 0 });
    const generatedPreview = await native.execute('get_layer_preview', { documentId: doc.id, layerId: installed.layerId, view: 'layer' });
    const previewPixels = await sharp(Buffer.from(generatedPreview.data, 'base64')).ensureAlpha().raw().toBuffer();
    for (let i = 0; i < count; i++) assert.equal(previewPixels[i * 4 + 3], 0, 'original-context generated preview clips the later-revealed subject too');

    const blank = await raster(native, Buffer.alloc(count * 4), width, height, { role: 'paint' });
    const graphWithPaint = { ...doc, layers: [...doc.layers, blank] };
    // A new isolated test document lets the ordinary API fill the known blank
    // target without any direct private graph publication.
    let paintDoc = (await native.newProject(graph(width, height, graphWithPaint.layers), 'Protected write fixture')).document;
    paintDoc = await edit(native, paintDoc, 'fill_area', { layerId: blank.id, color: '#00ff00', mode: 'color' });
    const painted = await native.renderLayer(paintDoc.layers.find(item => item.id === blank.id));
    for (let i = 0; i < count; i++) assert.equal(painted[i * 4 + 3], i % width >= 6 ? 0 : 255);

    const upperBytes = Buffer.from(Array.from({ length: count }, () => [40, 90, 130, 255]).flat());
    const upper = await raster(native, upperBytes, width, height);
    let filterDoc = (await native.newProject(graph(width, height, [...doc.layers, upper]), 'Protected filter fixture')).document;
    filterDoc = await edit(native, filterDoc, 'add_layer_filter', { layerId: upper.id, kind: 'invert', value: 100 });
    const filtered = await native.execute('get_layer_preview', { documentId: filterDoc.id, layerId: upper.id, view: 'layer' });
    const filteredPixels = await sharp(Buffer.from(filtered.data, 'base64')).ensureAlpha().raw().toBuffer();
    for (let i = 0; i < count; i++) assert.deepEqual(pixel(filteredPixels, i), i % width >= 6 ? [40, 90, 130, 255] : [215, 165, 125, 255]);
    assert.deepEqual(await fs.readFile(path.join(native.assetsDir, subject.sourceAsset)), sourceFile);
  }
});

test('malformed positioned portable graphs reject before any asset read even when hidden and density zero', async t => {
  const { native } = await fixture(t), width = 4, height = 3;
  const hash = '1'.repeat(64), base = common({ type: 'raster', width, height, transforms: [], asset: hash, sourceAsset: hash, sourceFormat: 'png', visible: false, maskDensity: 0,
    mask: wrap(bitmap(Array(width * height).fill(255), width, height), width, height, 1, 0) });
  const mutations = [
    layer => { layer.mask.sourceWidth++; },
    layer => { layer.mask.source = structuredClone(layer.mask); },
    layer => { layer.mask.domain = { x: 999999, y: 0, width: 2, height: 1 }; },
    layer => { layer.mask.domain = { x: 0, y: 0, width: 2, height: 1, invert: true }; },
    layer => { layer.mask.source.maskDensity = 0; },
    layer => { layer.mask.source.source = {}; },
    layer => { layer.mask.x = 0.5; },
    layer => { layer.maskOffset = { x: 1, y: 2 }; },
    layer => { layer.mask.feather = 1; },
  ];
  let assetReads = 0;
  for (const mutate of mutations) {
    const layer = structuredClone(base); mutate(layer);
    await assert.rejects(encodeProjectBundle({ graph: graph(width, height, [layer]), validateGraph: candidate => native.validateGraph(candidate), readAsset: async () => { assetReads++; assert.fail('invalid masks must reject before reading even one asset'); } }), { code: 'INVALID_PROJECT_BUNDLE' });
  }
  assert.equal(assetReads, 0);
  for (const target of ['selection', 'savedSelections']) {
    const candidate = graph(width, height, [{ ...base, maskDensity: undefined, mask: null }]);
    delete candidate.layers[0].maskDensity;
    if (target === 'selection') candidate.selection = base.mask;
    else candidate.savedSelections = [{ id: randomUUID(), name: 'Illegal positioned selection', mask: base.mask }];
    assert.throws(() => native.validateGraph(candidate), { code: 'INVALID_ARGUMENT' });
  }
});

test('PSD phase budget includes completed masks, live composite/protection and decoded source before callbacks', async t => {
  const { native } = await fixture(t), width = 512, height = 512, count = width * height;
  const warm = (await native.newProject(graph(1, 1, [solid(1, 1)]), 'Warm fixed ICC')).document;
  assert.equal((await native.inspectPsdExport({ documentId: warm.id })).supported, true);
  const layers = Array.from({ length: 6 }, () => solid(width, height, {
    mask: wrap(bitmap([], 6000, 3700, { invert: true }), 6000, 3700, 1, 0),
  }));
  const sourceGraph = graph(width, height, layers), callbackReserve = 2 * 6 * 6000 * 3700, mapBytes = 6 * count;
  assert.ok(callbackReserve + mapBytes < 256 * 1024 * 1024, 'the former callback-only phase would incorrectly admit this fixture');
  assert.ok(callbackReserve + 9 * count > 256 * 1024 * 1024, 'even inspection needs simultaneous composite/protection/source frames');
  const doc = (await native.newProject(sourceGraph, 'PSD preparation boundary')).document;
  const oldArray = globalThis.Uint8Array, oldRender = native.renderGraph;
  let allocations = 0, renders = 0;
  globalThis.Uint8Array = class extends oldArray {
    constructor(...args) {
      if (typeof args[0] === 'number' && args[0] > 1_000_000) { allocations++; throw Error('Audit: large callback constructed before PSD preflight'); }
      super(...args);
    }
  };
  native.renderGraph = async () => { renders++; assert.fail('PSD resource refusal must precede rendering'); };
  try {
    const report = await native.inspectPsdExport({ documentId: doc.id, expectedRevision: doc.revision });
    assert.equal(report.supported, false); assert.ok(report.issues.some(issue => issue.code === 'WORKING_MEMORY_LIMIT'));
    assert.ok(report.estimatedWorkingBytes >= callbackReserve + 9 * count);
    await assert.rejects(native.exportPsd({ documentId: doc.id, expectedRevision: doc.revision }), cause => {
      assert.equal(cause.code, 'PSD_UNSUPPORTED');
      assert.ok(cause.report.estimatedWorkingBytes >= callbackReserve + mapBytes + 9 * count);
      return true;
    });
  } finally { globalThis.Uint8Array = oldArray; native.renderGraph = oldRender; }
  assert.equal(allocations, 0); assert.equal(renders, 0);
  assert.deepEqual((await native.execute('get_document', { documentId: doc.id })).document, doc);
});

test('PSD raw mask channel contains translated effective bytes and refuses half-byte density instead of silently quantizing', async t => {
  const { native } = await fixture(t), width = 9, height = 3;
  const layer = solid(width, height, { mask: wrap(bitmap([0, 1, 128, 255], 4, 1, { invert: true }), 4, 1, 2, 1, { domain: { x: -1, y: 0, width: 6, height: 1 } }) });
  let doc = (await native.newProject(graph(width, height, [solid(width, height, { color: '#ffffff' }), layer]), 'PSD mask byte fixture')).document;
  const before = structuredClone(doc.layers), result = await native.exportPsd({ documentId: doc.id, expectedRevision: doc.revision }), data = result.data;
  // Independent bounded reader of this writer's raw channel records. No
  // production mask callback or PSD parser is used to construct the oracle.
  let offset = 26;
  offset += 4 + data.readUInt32BE(offset);
  offset += 4 + data.readUInt32BE(offset);
  offset += 4; // complete layer/mask section length
  offset += 4; // layer information section length
  const count = Math.abs(data.readInt16BE(offset)); offset += 2;
  const records = [];
  for (let layerIndex = 0; layerIndex < count; layerIndex++) {
    offset += 16;
    const channels = data.readUInt16BE(offset); offset += 2;
    const record = [];
    for (let channel = 0; channel < channels; channel++) {
      record.push({ id: data.readInt16BE(offset), length: data.readUInt32BE(offset + 2) }); offset += 6;
    }
    offset += 12; // blend signature/key, opacity, clipping, flags and filler
    offset += 4 + data.readUInt32BE(offset);
    records.push(record);
  }
  const masks = [];
  for (const record of records) for (const channel of record) {
    assert.equal(data.readUInt16BE(offset), 0, 'audit fixture must use raw channels');
    if (channel.id === -2) masks.push(data.subarray(offset + 2, offset + channel.length));
    offset += channel.length;
  }
  const expected = Buffer.alloc(width * height);
  for (let x = 1; x < 7; x++) {
    const source = x - 2, stored = source >= 0 && source < 4 ? [0, 1, 128, 255][source] : 0;
    expected[width + x] = 255 - stored;
  }
  assert.equal(masks.length, 1); assert.deepEqual(masks[0], expected);
  assert.deepEqual((await native.execute('get_document', { documentId: doc.id })).document.layers, before);
  doc = await edit(native, doc, 'modify_layer_mask', { layerId: layer.id, density: 0.5 });
  const report = await native.inspectPsdExport({ documentId: doc.id, expectedRevision: doc.revision });
  assert.equal(report.supported, false); assert.ok(report.issues.some(issue => issue.code === 'MASK_NOT_REPRESENTABLE'));
  doc = await edit(native, doc, 'modify_layer_mask', { layerId: layer.id, density: 0 });
  assert.equal((await native.inspectPsdExport({ documentId: doc.id, expectedRevision: doc.revision })).supported, true, 'zero density bypasses coverage but retains valid source metadata');
});

test('transactions refuse a newly over-budget positioned graph before a later image operation', async t => {
  const { native } = await fixture(t);
  const retained = feather => wrap(bitmap([], 6000, 4000, { feather, invert: true }), 6000, 4000, 1, 0);
  const cases = [
    { width: 6000, height: 4000, mask: bitmap([], 6000, 4000, { feather: 1, invert: true }), command: 'set_layer_mask_position', args: { x: 1, y: 0 } },
    { width: 6000, height: 4000, mask: retained(1), maskDensity: 0, command: 'modify_layer_mask', args: { density: 1 } },
    { width: 4000, height: 4000, mask: retained(0), command: 'modify_layer_mask', args: { feather: 1 } },
    { width: 4000, height: 3000, mask: retained(1), command: 'resize_canvas', args: { width: 4000, height: 4000, anchor: 'top-left' } },
  ];
  for (const entry of cases) {
    const { width, height } = entry;
    const first = common({ type: 'group', mode: 'isolated', mask: entry.mask, ...(entry.maskDensity === undefined ? {} : { maskDensity: entry.maskDensity }) });
    const second = common({ type: 'group', mode: 'isolated', parentId: first.id });
    const leaf = solid(width, height, { parentId: second.id });
    const doc = (await native.newProject(graph(width, height, [first, second, leaf]), 'Admitted pre-transaction graph')).document;
    const projectFile = path.join(native.projectsDir, `${doc.id}.json`), beforeFile = await fs.readFile(projectFile), cacheBefore = native.previewCache.stats();
    const oldRender = native.renderLayer, oldStore = native.storeAsset;
    let calls = 0;
    native.renderLayer = async () => { calls++; throw Object.assign(Error('Audit: invalid positioned intermediate graph reached source rendering'), { code: 'AUDIT_RENDER' }); };
    native.storeAsset = async () => { calls++; assert.fail('invalid positioned intermediate graph reached asset write'); };
    try {
      await assert.rejects(edit(native, doc, 'apply_transaction', { operations: [
        { command: entry.command, args: { ...(entry.command === 'resize_canvas' ? {} : { layerId: first.id }), ...entry.args } },
        { command: 'rasterize_layer', args: { layerId: leaf.id } },
      ] }), { code: 'LIMIT_EXCEEDED' }, entry.command);
    } finally { native.renderLayer = oldRender; native.storeAsset = oldStore; }
    assert.equal(calls, 0); assert.deepEqual(await fs.readFile(projectFile), beforeFile); assert.deepEqual(native.previewCache.stats(), cacheBefore);
    assert.deepEqual((await native.execute('get_document', { documentId: doc.id })).document, doc);
    assert.deepEqual(await fs.readdir(native.assetsDir), []);
  }
});
