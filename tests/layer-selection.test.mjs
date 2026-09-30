import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { maskCoverage, bitmapMask, bitmapBytes } from '../server/masks.mjs';
import { combineSelections } from '../server/saved-selections.mjs';
import { loadLayerSelection, encodeSelectionAlpha, combineSelectionAlpha, estimateLayerSelectionBytes, LAYER_SELECTION_LIMITS } from '../server/layer-selection.mjs';

const coded = code => cause => cause.code === code;
const edit = async (native, doc, command, args = {}) => (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document;
const get = async (native, doc) => (await native.execute('get_document', { documentId: doc.id })).document;
const bytes = doc => Buffer.from(bitmapBytes(doc.selection));
const alpha = rgba => Buffer.from(Array.from({ length: rgba.length / 4 }, (_, i) => rgba[i * 4 + 3]));
const png = (pixels, width, height) => sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
const graphOf = (native, doc) => { const project = native.project(doc.id); return structuredClone(project.states[project.cursor].graph); };
async function fixture(t, { width = 8, height = 4 } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-layer-selection-'));
  const native = await new NativeBackend({ dataDir, segmentSubject: async () => { throw Error('Selection loading cannot call a model'); } }).init();
  t.after(async () => { await native.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const pixels = Buffer.from(Array.from({ length: width * height }, (_, p) => [p * 11 % 256, p * 17 % 256, p * 23 % 256, [0, 1, 128, 255][p % 4]]).flat());
  const original = await png(pixels, width, height);
  const doc = (await native.execute('import_image', { data: original.toString('base64'), mimeType: 'image/png' })).document;
  return { native, doc, dataDir, pixels, original };
}

test('async RLE matches canonical encoding, preserves empty selections, yields and rejects complexity before unbounded runs', async () => {
  const width = 513, height = 129, data = Buffer.alloc(width * height);
  for (let p = 0; p < data.length; p++) data[p] = p % 17 < 3 ? 0 : Math.floor(p / 400) % 255 + 1;
  let yielded = false; setImmediate(() => { yielded = true; });
  assert.deepEqual(await encodeSelectionAlpha(data, width, height), bitmapMask(data, width, height)); assert.equal(yielded, true);
  assert.deepEqual((await encodeSelectionAlpha(Buffer.alloc(9), 3, 3)).runs, []);
  const complex = Buffer.from(Array.from({ length: 501 * 400 }, (_, p) => p % 2 + 1));
  await assert.rejects(encodeSelectionAlpha(complex, 501, 400), coded('LIMIT_EXCEEDED'));
});

test('asynchronous combinations are byte-identical to named selections for seeded soft masks and all four modes', async () => {
  let seed = 0xa13fa77;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) & 255;
  for (let sample = 0; sample < 30; sample++) {
    const width = 11, height = 7, incoming = Buffer.from(Array.from({ length: width * height }, random));
    const active = sample % 3 === 0 ? { shape: 'ellipse', x: 1.1, y: -0.4, width: 7.8, height: 6.4, feather: 1.9, invert: !!(sample % 2), clip: { x: 2, y: 1, width: 8, height: 5 } }
      : { ...bitmapMask(Buffer.from(Array.from({ length: width * height }, random)), width, height), feather: sample % 3 === 1 ? 2.7 : 0, invert: !!(sample % 2) };
    for (const mode of ['replace', 'add', 'subtract', 'intersect']) {
      const expected = combineSelections(active, bitmapMask(incoming, width, height), width, height, mode);
      assert.deepEqual(await combineSelectionAlpha(active, incoming, width, height, mode), expected);
      const left = maskCoverage(active), actual = bitmapBytes(expected);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const p = y * width + x, a = left(x, y), b = incoming[p] / 255;
        assert.equal(actual[p], mode === 'replace' ? incoming[p] : Math.round(255 * (mode === 'add' ? Math.max(a, b) : mode === 'subtract' ? a * (1 - b) : a * b)));
      }
    }
  }
  const incoming = Buffer.from([0, 1, 128, 255]);
  assert.deepEqual(await combineSelectionAlpha(null, incoming, 4, 1, 'add'), bitmapMask(incoming, 4, 1));
  for (const mode of ['subtract', 'intersect']) await assert.rejects(combineSelectionAlpha(null, incoming, 4, 1, mode), coded('NO_SELECTION'));
  assert.deepEqual((await combineSelectionAlpha(bitmapMask(Buffer.alloc(4), 4, 1), incoming, 4, 1, 'intersect')).runs, []);
});

test('buffer estimates account retained originals, both geometry frames, alpha combination, encoded input and feather phases', () => {
  const graph = { width: 10, height: 5, selection: { ...bitmapMask(Buffer.alloc(50, 255), 10, 5), feather: 2 } };
  const layer = { type: 'raster', width: 20, height: 10, transforms: [{ type: 'resize', width: 30, height: 20 }, { type: 'crop', width: 10, height: 5 }] };
  let estimate = estimateLayerSelectionBytes({ graph, layer, encodedSourceBytes: 100, mode: 'intersect' });
  assert.equal(estimate.sourceBytes, 100 + 4 * 200 + 4 * 200 + 4 * 600 + 50);
  assert.equal(estimate.combinationBytes, 7 * 50);
  estimate = estimateLayerSelectionBytes({ graph: { width: 20, height: 10 }, layer: { ...layer, alphaAsset: 'x', transforms: [] }, encodedSourceBytes: 100, encodedAlphaBytes: 33 });
  assert.equal(estimate.sourceBytes, 133 + 9 * 200 + 200);
  estimate = estimateLayerSelectionBytes({ graph: { width: 20, height: 10 }, layer: { type: 'gradient', width: 20, height: 10, transforms: [] } });
  assert.equal(estimate.sourceBytes, 9 * 200);
  const masked = { mask: graph.selection, maskDensity: 0 };
  assert.equal(estimateLayerSelectionBytes({ graph, layer: masked, source: 'layer-mask', maskMode: 'effective' }).maskBytes, 50);
  assert.equal(estimateLayerSelectionBytes({ graph, layer: masked, source: 'layer-mask', maskMode: 'raw' }).maskBytes, 6 * 50);
  assert.equal(estimateLayerSelectionBytes({ graph, layer: masked, source: 'layer-mask', mode: 'replace' }).combinationBytes, 50);
});

test('oversized source/geometry and encoded inputs reject before render, and invalid/no-selection checks precede I/O', async () => {
  let reads = 0, renders = 0;
  const hooks = { sourceAssetBytes: async () => { reads++; return { encodedSourceBytes: LAYER_SELECTION_LIMITS.maxWorkingBytes }; }, renderLayer: async () => { renders++; throw Error('unexpected'); } };
  const layer = { id: 'layer', type: 'raster', width: 8192, height: 2929, transforms: [{ type: 'affine' }, { type: 'crop', width: 8, height: 4 }] }, graph = { width: 8, height: 4, layers: [layer], selection: null };
  await assert.rejects(loadLayerSelection(graph, { layerId: layer.id }, hooks), coded('LIMIT_EXCEEDED')); assert.equal(reads, 0); assert.equal(renders, 0);
  const small = { ...graph, layers: [{ ...layer, width: 8, height: 4, transforms: [] }] };
  for (const args of [{ mode: 'subtract' }, { mode: 'intersect' }, { source: 'layer-mask' }, { maskMode: 'raw' }, { invert: null }, { source: null }, { mode: null }])
    await assert.rejects(loadLayerSelection(small, { layerId: layer.id, ...args }, hooks));
  assert.equal(reads, 0);
  await assert.rejects(loadLayerSelection(small, { layerId: layer.id }, hooks), coded('LIMIT_EXCEEDED')); assert.equal(reads, 1); assert.equal(renders, 0);
  assert.equal(graph.selection, null);
});

test('native content uses working alpha plus source cutout once and transformed geometry while ignoring display settings', async t => {
  const { native, doc: start, pixels, original } = await fixture(t); const id = start.layers[0].id;
  const working = Buffer.from(pixels), cutout = Buffer.from(Array.from({ length: 32 }, (_, p) => [255, 128, 1, 0][Math.floor(p / 4) % 4]));
  working[3] = 255;
  let graph = graphOf(native, start); graph.layers[0].asset = await native.storeAsset(await png(working, 8, 4)); graph.layers[0].alphaAsset = await native.storeAlpha(cutout, 8, 4);
  await native.commit(native.project(start.id), graph, 'Working alpha fixture'); let doc = await get(native, start);
  doc = await edit(native, doc, 'set_layer', { layerId: id, opacity: 0, visible: false });
  doc = await edit(native, doc, 'set_layer_mask', { layerId: id, mask: { x: 0, y: 0, width: 1, height: 1, invert: true } });
  doc = await edit(native, doc, 'set_layer_effects', { layerId: id, effects: { shadow: { x: 2, y: 1, blur: 0 } } });
  doc = await edit(native, doc, 'set_layer_outline', { layerId: id, width: 2 });
  doc = await edit(native, doc, 'add_layer_filter', { layerId: id, kind: 'invert', value: 100 });
  doc = await edit(native, doc, 'group_layers', { layerIds: [id] }); const groupId = doc.layers[0].id;
  doc = await edit(native, doc, 'set_group_compositing', { layerId: groupId, mode: 'isolated' });
  doc = await edit(native, doc, 'set_layer', { layerId: groupId, opacity: 0.3, visible: false });
  doc = await edit(native, doc, 'transform_layer', { layerId: id, x: 1, y: 1 });
  const layers = structuredClone(doc.layers), files = await fs.readdir(native.assetsDir), preview = await native.render(native.project(doc.id));
  native.storeAsset = async () => { throw Error('No source writes'); };
  const renderLayer = native.renderLayer.bind(native); native.renderLayer = (layer, options) => { assert.equal(options.filters, false); return renderLayer(layer, options); };
  doc = await edit(native, doc, 'load_layer_selection', { layerId: id });
  const expected = Buffer.alloc(32);
  for (let y = 1; y < 4; y++) for (let x = 1; x < 8; x++) { const source = (y - 1) * 8 + x - 1; expected[y * 8 + x] = Math.round(working[source * 4 + 3] * cutout[source] / 255); }
  assert.deepEqual(bytes(doc), expected); assert.deepEqual(doc.layers, layers); assert.deepEqual(await fs.readdir(native.assetsDir), files);
  assert.deepEqual(await native.render(native.project(doc.id)), preview); assert.deepEqual(await fs.readFile(path.join(native.assetsDir, start.layers[0].sourceAsset)), original);
});

test('all six content types load source silhouettes; editable filters and outside styles do not enter alpha', async t => {
  const { native } = await fixture(t);
  let doc = (await native.execute('create_document', { width: 40, height: 30, background: '#123456' })).document;
  const solid = doc.layers[0].id;
  const commands = [
    ['add_paint_layer', {}],
    ['add_text', { text: 'A', x: 2, y: 1, fontSize: 20, color: '#ffffff' }],
    ['add_shape', { shape: 'ellipse', x: 5, y: 4, width: 19, height: 16, fill: '#aabbcc' }],
    ['add_path', { nodes: [{ x: 2, y: 2 }, { x: 24, y: 17 }], stroke: '#ffffff', strokeWidth: 3 }],
    ['add_gradient', { kind: 'linear', start: { x: 0, y: 0 }, end: { x: 40, y: 0 }, stops: [{ offset: 0, color: '#ffffff', opacity: 0 }, { offset: 1, color: '#000000', opacity: 1 }] }],
  ];
  const ids = [solid];
  for (const [command, args] of commands) { doc = await edit(native, doc, command, args); ids.push(doc.layers.at(-1).id); }
  const seen = new Set();
  for (const id of ids) {
    doc = await edit(native, doc, 'set_layer', { layerId: id, visible: false, opacity: 0 });
    const target = doc.layers.find(x => x.id === id), expected = alpha(await native.renderLayer(target, { filters: false })); seen.add(target.type);
    doc = await edit(native, doc, 'load_layer_selection', { layerId: id }); assert.deepEqual(bytes(doc), expected);
    if (target.type !== 'raster') assert.ok(expected.some(value => value > 0));
    if (['text', 'shape', 'path', 'gradient'].includes(target.type)) assert.ok(expected.some(value => value > 0 && value < 255));
  }
  assert.deepEqual([...seen].sort(), ['gradient', 'path', 'raster', 'shape', 'solid', 'text']);
});

test('mask loading is document anchored and includes raw feather/invert/clip before optional density and byte inversion', async t => {
  const { native, doc: start } = await fixture(t); const id = start.layers[0].id;
  let graph = graphOf(native, start);
  graph.layers[0].mask = { shape: 'rectangle', x: 0, y: 0, width: 5, height: 3, feather: 1, invert: true, clip: { x: 1, y: 1, width: 3, height: 2 } };
  graph.layers[0].maskDensity = 0.5;
  await native.commit(native.project(start.id), graph, 'Clipped mask fixture'); let doc = await get(native, start);
  doc = await edit(native, doc, 'transform_layer', { layerId: id, x: 3, y: 1 });
  native.renderLayer = async () => { throw Error('Mask loading must not decode pixels'); }; native.storeAsset = native.renderLayer;
  const raw = maskCoverage(doc.layers[0].mask), descriptor = structuredClone(doc.layers[0].mask);
  for (const density of [0, 0.5, 1]) {
    doc = await edit(native, doc, 'modify_layer_mask', { layerId: id, density });
    for (const maskMode of ['raw', 'effective']) for (const invert of [false, true]) {
      doc = await edit(native, doc, 'load_layer_selection', { layerId: id, source: 'layer-mask', maskMode, invert });
      const expected = Buffer.from(Array.from({ length: 32 }, (_, p) => {
        const value = raw(p % 8, Math.floor(p / 8)), q = Math.round(255 * (maskMode === 'raw' ? value : 1 - density * (1 - value)));
        return invert ? 255 - q : q;
      }));
      assert.deepEqual(bytes(doc), expected); assert.deepEqual(doc.layers[0].mask, descriptor);
      if (density === 0.5 && maskMode === 'effective' && invert) assert.equal(expected[0], 127);
      assert.equal(doc.selection.clip, undefined); assert.equal(doc.selection.maskDensity, undefined);
    }
  }
  doc = await edit(native, doc, 'group_layers', { layerIds: [id] }); const group = doc.layers[0].id;
  doc = await edit(native, doc, 'set_layer_mask', { layerId: group, mask: { x: 0, y: 0, width: 2, height: 4 } });
  doc = await edit(native, doc, 'add_adjustment', { kind: 'invert', value: 100, mask: { x: 0, y: 0, width: 4, height: 2 } }); const adjustment = doc.layers.at(-1).id;
  for (const layerId of [group, adjustment]) {
    await assert.rejects(edit(native, doc, 'load_layer_selection', { layerId }), coded('INVALID_TARGET'));
    doc = await edit(native, doc, 'load_layer_selection', { layerId, source: 'layer-mask' }); assert.ok(bytes(doc).some(Boolean));
  }
});

test('empty selections remain restrictive and combination copies survive undo, persistence and portable transfer', async t => {
  const { native, doc: start, dataDir } = await fixture(t); const source = start.layers[0].id;
  let doc = await edit(native, start, 'load_layer_selection', { layerId: source }); const sourceSelection = structuredClone(doc.selection);
  doc = await edit(native, doc, 'save_selection', { name: 'Source transparency' }); const saved = structuredClone(doc.savedSelections);
  doc = await edit(native, doc, 'add_paint_layer'); const empty = doc.layers.at(-1).id;
  doc = await edit(native, doc, 'load_layer_selection', { layerId: empty }); assert.deepEqual(doc.selection.runs, []);
  const before = await native.render(native.project(doc.id));
  doc = await edit(native, doc, 'fill_area', { layerId: empty, color: '#ff0000' }); assert.deepEqual(await native.render(native.project(doc.id)), before);
  doc = await edit(native, doc, 'apply_transaction', { label: 'Load and save', operations: [{ command: 'load_layer_selection', args: { layerId: source, mode: 'add' } }, { command: 'save_selection', args: { name: 'Copy' } }] });
  assert.deepEqual(doc.selection, sourceSelection); assert.deepEqual(doc.savedSelections[0], saved[0]);
  doc = await edit(native, doc, 'undo'); assert.deepEqual(doc.selection.runs, []); assert.deepEqual(doc.savedSelections, saved);
  doc = await edit(native, doc, 'redo');
  const bundle = await native.exportProject({ documentId: doc.id }), imported = (await native.importProject({ data: bundle.data })).document;
  assert.deepEqual(imported.selection, doc.selection); assert.deepEqual(imported.savedSelections, doc.savedSelections);
  const reopened = await new NativeBackend({ dataDir }).init(); t.after(() => reopened.close()); assert.deepEqual((await get(reopened, doc)).selection, doc.selection);
});

test('missing/corrupt images, stale revisions, transactions and persistence failures leave state and cached preview intact', async t => {
  const { native, doc } = await fixture(t); const id = doc.layers[0].id;
  const preview = await native.execute('get_preview', { documentId: doc.id }), assetPath = path.join(native.assetsDir, doc.layers[0].asset), original = await fs.readFile(assetPath);
  for (const contents of [null, Buffer.from('not an image')]) {
    if (contents) await fs.writeFile(assetPath, contents); else await fs.unlink(assetPath);
    await assert.rejects(edit(native, doc, 'load_layer_selection', { layerId: id }), cause => cause.code === 'INVALID_IMAGE' && !cause.message.includes(native.assetsDir));
    await fs.writeFile(assetPath, original); assert.deepEqual(await get(native, doc), doc);
  }
  await assert.rejects(native.execute('load_layer_selection', { documentId: doc.id, expectedRevision: doc.revision - 1, layerId: id }), coded('REVISION_CONFLICT'));
  await assert.rejects(edit(native, doc, 'apply_transaction', { operations: [{ command: 'load_layer_selection', args: { layerId: id } }, { command: 'load_layer_selection', args: { layerId: randomUUID() } }] }), coded('NOT_FOUND'));
  const persist = native.persist; native.persist = async () => { throw Object.assign(Error('Disk full'), { code: 'ENOSPC' }); };
  await assert.rejects(edit(native, doc, 'load_layer_selection', { layerId: id }), coded('ENOSPC')); native.persist = persist;
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await native.execute('get_preview', { documentId: doc.id }), preview); assert.deepEqual(await fs.readFile(assetPath), original);
});

test('content selection remains source-oriented for clipping and generated protection while later edits remain protected', async t => {
  const { native, doc: start, pixels } = await fixture(t); const base = start.layers[0].id;
  let doc = await edit(native, start, 'add_shape', { shape: 'rectangle', x: 0, y: 0, width: 8, height: 4, fill: '#00ff00' }); const upper = doc.layers.at(-1).id;
  doc = await edit(native, doc, 'set_clipping_chain', { baseLayerId: base, layerIds: [upper] });
  doc = await edit(native, doc, 'load_layer_selection', { layerId: upper }); assert.deepEqual(bytes(doc), Buffer.alloc(32, 255));
  doc = await edit(native, doc, 'load_layer_selection', { layerId: base }); assert.deepEqual(bytes(doc), alpha(pixels));
  doc = await edit(native, doc, 'set_clipping_chain', { baseLayerId: base, layerIds: [] });
  let graph = graphOf(native, doc); graph.layers[1].role = 'generated'; graph.layers[0].protected = true;
  await native.commit(native.project(doc.id), graph, 'Generated protection fixture'); doc = await get(native, doc);
  const before = await native.render(native.project(doc.id));
  doc = await edit(native, doc, 'load_layer_selection', { layerId: upper }); assert.deepEqual(bytes(doc), Buffer.alloc(32, 255));
  doc = await edit(native, doc, 'add_adjustment', { kind: 'invert', value: 100 }); const after = await native.render(native.project(doc.id));
  for (let p = 0; p < 32; p++) if (pixels[p * 4 + 3]) assert.deepEqual(after.subarray(p * 4, p * 4 + 4), before.subarray(p * 4, p * 4 + 4));
  assert.equal(doc.layers[0].protected, true);
});
