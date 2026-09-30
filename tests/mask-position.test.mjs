import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { maskCoverage, bitmapMask, normalizeMask } from '../server/masks.mjs';
import { canvasTransform } from '../server/canvas.mjs';
import { layerTree } from '../server/groups.mjs';
import { validateLayerFilterResources } from '../server/layer-filters.mjs';
import { rawLayerMaskCoverage, layerMaskCoverage, validateAdditionalLayerMask, setLayerMaskPosition, transformPositionedMask, estimateLayerMaskCallbacks, sampleLayerMaskAlpha } from '../server/layer-mask.mjs';
import { estimateMaskPreviewBytes } from '../server/mask-preview.mjs';
import { estimateLayerSelectionBytes } from '../server/layer-selection.mjs';
import { paintSelection } from '../server/raster-ops.mjs';
import { morphMask } from '../server/mask-morphology.mjs';

const coded = code => cause => cause.code === code;
const edit = async (native, doc, command, args = {}) => (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document;
const current = (native, doc) => structuredClone(native.project(doc.id).states[native.project(doc.id).cursor].graph);
const find = (doc, id) => doc.layers.find(layer => layer.id === id);
const quantize = value => Math.max(0, Math.min(255, Math.round(255 * value)));
const samples = (coverage, width, height) => Buffer.from(Array.from({ length: width * height }, (_, i) => quantize(coverage(i % width, Math.floor(i / width)))));
const rectangle = { shape: 'rectangle', x: .2, y: .3, width: 4.6, height: 2.4, feather: 1.3, invert: false };
async function fixture(t, width = 6, height = 4) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-mask-position-'));
  const native = await new NativeBackend({ dataDir }).init();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const pixels = Buffer.from(Array.from({ length: width * height }, (_, i) => [20 + i % 80, 110 + i % 100, 210 - i % 90, [0, 1, 128, 255][i % 4]]).flat());
  const original = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const document = (await native.execute('import_image', { data: original.toString('base64'), mimeType: 'image/png' })).document;
  return { native, document, dataDir, original, pixels };
}
async function commitMask(native, doc, mask, density) {
  const graph = current(native, doc); graph.layers[0].mask = structuredClone(mask);
  if (density !== undefined) graph.layers[0].maskDensity = density;
  await native.commit(native.project(doc.id), graph, 'Mask fixture');
  return (await native.execute('get_document', { documentId: doc.id })).document;
}

test('position-only moves preserve source descriptors, exterior inversion and exact fractional coverage', () => {
  const masks = [rectangle, { ...rectangle, shape: 'ellipse', invert: true, clip: { x: 0, y: 0, width: 5, height: 3 } }, { ...bitmapMask(Uint8Array.from({ length: 24 }, (_, i) => i * 11), 6, 4), feather: 1.9, invert: true }];
  for (const mask of masks) {
    const original = structuredClone(mask), source = maskCoverage(mask);
    for (const x of [-16384, -7, 2, 16384]) for (const y of [-6, 0, 5]) {
      const moved = { mask: setLayerMaskPosition({ mask }, 6, 4, x, y) }, raw = rawLayerMaskCoverage(moved);
      assert.deepEqual(moved.mask.source, original);
      for (let yy = -3; yy < 8; yy++) for (let xx = -3; xx < 9; xx++) assert.equal(raw(xx, yy), source(xx - x, yy - y));
      assert.deepEqual(setLayerMaskPosition(moved, 6, 4, 0, 0), original);
    }
    assert.deepEqual(mask, original);
  }
  const inverted = { mask: setLayerMaskPosition({ mask: { ...bitmapMask(Uint8Array.of(255), 1, 1), invert: true } }, 1, 1, 5, 0) };
  assert.equal(rawLayerMaskCoverage(inverted)(0, 0), 1, 'initial position adds no frame clipping');
  for (const point of [[.5, 0], [16385, 0], [0, Infinity]]) assert.throws(() => setLayerMaskPosition({ mask: rectangle }, 6, 4, ...point), coded('INVALID_ARGUMENT'));
});

test('density uses underlying bitmap bytes after moved hard domains, including every forward/inverted alpha value', () => {
  for (const invert of [false, true]) for (const density of [0, .25, .5, .75, 1]) {
    const source = { ...bitmapMask(Uint8Array.from({ length: 256 }, (_, i) => i), 256, 1), invert };
    const mask = setLayerMaskPosition({ mask: source }, 256, 1, 3, -1);
    mask.domain = { x: 10, y: 0, width: 230, height: 1 };
    const coverage = layerMaskCoverage({ mask, maskDensity: density });
    for (let byte = 0; byte < 256; byte++) {
      const raw = byte < 10 || byte >= 240 ? 0 : invert ? 255 - byte : byte;
      assert.equal(quantize(coverage(byte + 3, -1)), Math.round(255 - density * (255 - raw)));
    }
  }
});

test('crop retains intrinsic source and all canvas anchors preserve overlap with explicit zero-padding domains', () => {
  const sources = [rectangle, { ...rectangle, invert: true }, { ...bitmapMask(Uint8Array.from({ length: 24 }, (_, i) => i * 11), 6, 4), feather: 1.8, invert: true }];
  for (const source of sources) for (const x of [-5, 0, 3]) {
    const mask = { shape: 'positioned', sourceWidth: 6, sourceHeight: 4, x, y: -1, source }, before = rawLayerMaskCoverage({ mask });
    const cropped = transformPositionedMask(mask, { type: 'crop', x: 2, y: 1, width: 3, height: 2 }, 6, 4), cropCoverage = rawLayerMaskCoverage({ mask: cropped });
    assert.equal(cropped.sourceWidth, 6); assert.deepEqual(cropped.source, source);
    for (let yy = 0; yy < 2; yy++) for (let xx = 0; xx < 3; xx++) assert.equal(cropCoverage(xx, yy), before(xx + 2, yy + 1));
    for (const anchor of ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right']) {
      const transform = canvasTransform(6, 4, 9, 7, anchor), changed = transformPositionedMask(mask, transform, 6, 4), coverage = rawLayerMaskCoverage({ mask: changed });
      for (let yy = 0; yy < 7; yy++) for (let xx = 0; xx < 9; xx++) {
        const sx = xx - transform.x, sy = yy - transform.y;
        assert.equal(coverage(xx, yy), sx < 0 || sy < 0 || sx >= 6 || sy >= 4 ? 0 : before(sx, sy));
      }
    }
  }
  const source = bitmapMask(Uint8Array.of(255, 0, 0, 0), 4, 1), moved = setLayerMaskPosition({ mask: source }, 4, 1, 4, 0);
  const expanded = transformPositionedMask(moved, canvasTransform(4, 1, 8, 1, 'top-left'), 4, 1);
  assert.equal(rawLayerMaskCoverage({ mask: expanded })(4, 0), 0);
  assert.equal(rawLayerMaskCoverage({ mask: setLayerMaskPosition({ mask: expanded }, 8, 1, 0, 0) })(0, 0), 0, 'canvas bounds deliberately discard prior offcanvas support');
});

test('retained callback reserve joins group/filter/clipping budget and raw reads count source dimensions after a tiny crop', () => {
  const source = { shape: 'bitmap', x: 0, y: 0, width: 6000, height: 4000, runs: [], feather: 2, invert: false };
  const mask = { shape: 'positioned', sourceWidth: 6000, sourceHeight: 4000, source, x: -5999, y: -3999 };
  const layer = { id: randomUUID(), type: 'solid', visible: false, mask, maskDensity: 0, width: 1, height: 1, transforms: [], protected: false };
  const graph = { width: 1, height: 1, layers: [layer] };
  assert.equal(estimateLayerMaskCallbacks(graph).estimatedCallbackBytes, 0);
  assert.equal(estimateMaskPreviewBytes({ graph, mask, source: 'layer-mask', maskMode: 'raw', density: 0 }).coverageBytes, 120_000_000);
  assert.equal(estimateLayerSelectionBytes({ graph, layer, source: 'layer-mask', maskMode: 'raw' }).maskBytes, 120_000_001);
  assert.equal(estimateLayerSelectionBytes({ graph, layer, source: 'layer-mask', maskMode: 'effective' }).maskBytes, 1);
  delete layer.maskDensity;
  assert.equal(estimateLayerMaskCallbacks(graph).estimatedCallbackBytes, 144_000_000);
  graph.layers.push(...Array.from({ length: 2 }, () => ({ ...layer, id: randomUUID() })));
  assert.equal(validateLayerFilterResources(graph, layerTree(graph.layers)).estimatedScratchBytes, 240_000_000);
  const group = { id: randomUUID(), type: 'group', mode: 'isolated', opacity: 1, visible: false };
  const large = { width: 2500, height: 2500, layers: [group, ...graph.layers] };
  assert.throws(() => validateLayerFilterResources(large, layerTree(large.layers)), coded('LIMIT_EXCEEDED'), 'empty isolated group still contributes its peak31.25MB');
});

test('native positioning is metadata-only, protected-source safe, undoable and independently portable', async t => {
  const { native, document: initial, original } = await fixture(t); const id = initial.layers[0].id;
  let doc = await edit(native, initial, 'set_layer_mask', { layerId: id, mask: rectangle });
  doc = await edit(native, doc, 'set_layer_protection', { layerId: id, protected: true });
  const baseline = await native.render(native.project(doc.id)), source = find(doc, id).sourceAsset;
  const renderLayer = native.renderLayer, storeAsset = native.storeAsset;
  native.renderLayer = async () => { throw Error('Position metadata cannot render'); }; native.storeAsset = async () => { throw Error('Position metadata cannot store'); };
  doc = await edit(native, doc, 'set_layer_mask_position', { layerId: id, x: 2, y: -1 });
  const shifted = structuredClone(find(doc, id).mask);
  doc = await edit(native, doc, 'modify_layer_mask', { layerId: id, feather: 2.5, invert: true, density: .5 });
  assert.equal(find(doc, id).mask.source.feather, 2.5); assert.equal(find(doc, id).mask.source.invert, true); assert.equal(find(doc, id).mask.feather, undefined);
  doc = await edit(native, doc, 'undo'); assert.deepEqual(find(doc, id).mask, shifted);
  doc = await edit(native, doc, 'set_layer_mask_position', { layerId: id, x: 0, y: 0 });
  native.renderLayer = renderLayer; native.storeAsset = storeAsset;
  assert.deepEqual(await native.render(native.project(doc.id)), baseline); assert.deepEqual(await fs.readFile(path.join(native.assetsDir, source)), original);
  doc = await edit(native, doc, 'set_layer_mask_position', { layerId: id, x: -1, y: 1 });
  const bytes = (await native.exportProject({ documentId: doc.id })).data, imported = (await native.importProject({ data: bytes })).document;
  assert.deepEqual(imported.layers, doc.layers); assert.deepEqual(await native.render(native.project(imported.id)), await native.render(native.project(doc.id)));
  const reopened = await new NativeBackend({ dataDir: native.dataDir }).init();
  assert.deepEqual((await reopened.execute('get_document', { documentId: doc.id })).document.layers, doc.layers);
});

test('raw/effective previews and loaded selections share moved coverage without source image reads', async t => {
  const { native, document: initial } = await fixture(t); const id = initial.layers[0].id;
  let doc = await commitMask(native, initial, { ...rectangle, invert: true }, .5);
  doc = await edit(native, doc, 'set_layer_mask_position', { layerId: id, x: 2, y: -1 });
  const stored = structuredClone(find(doc, id).mask);
  native.renderLayer = async () => { throw Error('Mask sampling cannot render source pixels'); };
  for (const maskMode of ['raw', 'effective']) {
    const target = find(doc, id), coverage = maskMode === 'raw' ? rawLayerMaskCoverage(target) : layerMaskCoverage(target);
    const preview = await native.execute('get_mask_preview', { documentId: doc.id, layerId: id, source: 'layer-mask', maskMode });
    const gray = await sharp(Buffer.from(preview.data, 'base64')).toColourspace('b-w').raw().toBuffer();
    assert.deepEqual(gray, samples(coverage, doc.width, doc.height));
    doc = await edit(native, doc, 'load_layer_selection', { layerId: id, source: 'layer-mask', maskMode, invert: true });
    assert.deepEqual(samples(maskCoverage(doc.selection), doc.width, doc.height), Buffer.from(gray.map(value => 255 - value)));
    assert.deepEqual(find(doc, id).mask, stored);
  }
});

test('apply, paint and morphology rasterize raw positioned coverage once and preserve separate density', async t => {
  const { native, document: initial } = await fixture(t); const id = initial.layers[0].id;
  let doc = await commitMask(native, initial, { ...rectangle, invert: true }, .5);
  doc = await edit(native, doc, 'set_layer_mask_position', { layerId: id, x: 1, y: -1 });
  const before = structuredClone(doc), alpha = samples(rawLayerMaskCoverage(find(doc, id)), doc.width, doc.height);
  for (const operation of ['apply', 'paint', 'replace', 'morph']) {
    let expected;
    if (operation === 'apply') { expected = bitmapMask(alpha, doc.width, doc.height); doc = await edit(native, doc, 'apply_layer_mask_position', { layerId: id }); }
    else if (operation === 'morph') {
      expected = bitmapMask(await morphMask({ alpha, width: doc.width, height: doc.height, operation: 'expand', radius: 1 }), doc.width, doc.height);
      doc = await edit(native, doc, 'morph_layer_mask', { layerId: id, operation: 'expand', radius: 1 });
    } else {
      const args = { points: [{ x: 2, y: 2 }], size: 3, hardness: .5, opacity: .3, mode: operation === 'replace' ? 'replace' : 'add' };
      expected = paintSelection({ ...args, selection: bitmapMask(alpha, doc.width, doc.height), width: doc.width, height: doc.height });
      doc = await edit(native, doc, 'paint_mask', { layerId: id, ...args });
    }
    assert.deepEqual(find(doc, id).mask, expected); assert.equal(find(doc, id).maskDensity, .5);
    doc = await edit(native, doc, 'undo'); assert.deepEqual(doc.layers, before.layers);
  }
  assert.deepEqual(await sampleLayerMaskAlpha(find(doc, id), doc.width, doc.height), alpha);
});

test('crop and bounds persist retained frames, while all positioned image-resize blockers reject atomically until rasterized', async t => {
  const { native, document: initial } = await fixture(t); const id = initial.layers[0].id;
  let doc = await commitMask(native, initial, bitmapMask(Uint8Array.from({ length: 24 }, (_, i) => i * 11), 6, 4), 0);
  doc = await edit(native, doc, 'set_layer_mask_position', { layerId: id, x: 2, y: 1 });
  doc = await edit(native, doc, 'set_layer', { layerId: id, visible: false });
  const before = structuredClone(doc);
  await assert.rejects(edit(native, doc, 'resize_document', { width: 3, height: 2 }), coded('MASK_POSITION_REQUIRES_RASTERIZE'));
  assert.deepEqual((await native.execute('get_document', { documentId: doc.id })).document, before);
  doc = await edit(native, doc, 'crop_document', { x: 2, y: 1, width: 3, height: 2 });
  assert.equal(find(doc, id).mask.x, 0); assert.equal(find(doc, id).mask.y, 0); assert.equal(find(doc, id).mask.sourceWidth, 6);
  await assert.rejects(edit(native, doc, 'resize_document', { width: 2, height: 2 }), coded('MASK_POSITION_REQUIRES_RASTERIZE'));
  doc = await edit(native, doc, 'resize_canvas', { width: 5, height: 4, anchor: 'bottom-right' }); assert.ok(find(doc, id).mask.domain);
  doc = await edit(native, doc, 'apply_layer_mask_position', { layerId: id });
  doc = await edit(native, doc, 'resize_document', { width: 2, height: 2 }); assert.equal(find(doc, id).mask.width, 2); assert.equal(find(doc, id).maskDensity, 0);
});

test('malformed wrappers and misplaced raw fields reject including disabled masks; stale, transaction and disk failures preserve publication', async t => {
  const { native, document: initial } = await fixture(t); const id = initial.layers[0].id;
  let doc = await commitMask(native, initial, rectangle, 0);
  doc = await edit(native, doc, 'set_layer_mask_position', { layerId: id, x: 1, y: 1 });
  const good = structuredClone(find(doc, id).mask);
  const invalid = [ { ...good, x: .5 }, { ...good, source: good }, { ...good, density: 0 }, { ...good, sourceWidth: 9000 }, { ...good, source: { ...rectangle, maskOffset: { x: 0, y: 0 } } }, { ...good, domain: { x: 0, y: 0, width: -1, height: 1 } }, { ...good, domain: { x: 0, y: 0, width: 1, height: 1, density: 0 } } ];
  for (const mask of invalid) assert.throws(() => validateAdditionalLayerMask({ mask, maskDensity: 0 }, 6, 4), coded('INVALID_ARGUMENT'));
  assert.throws(() => normalizeMask(good, 6, 4, { persisted: true }), coded('INVALID_ARGUMENT'));
  const before = structuredClone(doc), preview = await native.execute('get_preview', { documentId: doc.id }), files = await fs.readdir(native.assetsDir);
  await assert.rejects(native.execute('set_layer_mask_position', { documentId: doc.id, expectedRevision: doc.revision - 1, layerId: id, x: 2, y: 2 }), coded('REVISION_CONFLICT'));
  await assert.rejects(native.execute('apply_transaction', { documentId: doc.id, expectedRevision: doc.revision, operations: [ { command: 'set_layer_mask_position', args: { layerId: id, x: 4, y: 0 } }, { command: 'set_layer', args: { layerId: randomUUID(), visible: false } } ] }), coded('NOT_FOUND'));
  const dir = native.projectsDir, blocker = path.join(native.dataDir, 'not-a-directory'); await fs.writeFile(blocker, 'blocker'); native.projectsDir = blocker;
  await assert.rejects(edit(native, doc, 'apply_layer_mask_position', { layerId: id })); native.projectsDir = dir;
  assert.deepEqual((await native.execute('get_document', { documentId: doc.id })).document, before);
  assert.deepEqual(await native.execute('get_preview', { documentId: doc.id }), preview); assert.deepEqual(await fs.readdir(native.assetsDir), files);
});

test('extraction preflights the copied retained source before image reads, segmentation or asset writes', async t => {
  const { native, document: initial } = await fixture(t);
  const graph = current(native, initial), template = graph.layers[0];
  graph.width = 6000; graph.height = 4000;
  const source = { shape: 'bitmap', x: 0, y: 0, width: 6000, height: 4000, runs: [], feather: 1, invert: false };
  graph.layers = Array.from({ length: 3 }, (_, index) => ({ ...template, id: randomUUID(), name: `Retained ${index}`, width: 6000, height: 4000,
    mask: { shape: 'positioned', sourceWidth: 6000, sourceHeight: 4000, x: 1, y: 0, source: structuredClone(source) } }));
  await native.commit(native.project(initial.id), graph, 'Metadata-only resource fixture');
  const doc = (await native.execute('get_document', { documentId: initial.id })).document;
  native.sourcePixels = async () => { throw Error('No source read before resource admission'); };
  native.segmentSubject = async () => { throw Error('No model before resource admission'); };
  native.storeAsset = async () => { throw Error('No asset write before resource admission'); };
  await assert.rejects(edit(native, doc, 'extract_subject', { layerId: doc.layers[0].id }), coded('LIMIT_EXCEEDED'));
  assert.deepEqual((await native.execute('get_document', { documentId: doc.id })).document, doc);
});
