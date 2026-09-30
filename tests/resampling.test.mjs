import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { DOCUMENT_RESIZE_METHODS, DOCUMENT_RESIZE_DEFAULT, normalizeDocumentResizeMethod, normalizeResampleTransform, resamplePixels } from '../server/resampling.mjs';
import { bitmapMask, transformMask } from '../server/masks.mjs';
import { transformGuides } from '../server/guides.mjs';
import { encodeProjectBundle } from '../server/project-bundle.mjs';
import { estimateLayerSelectionBytes } from '../server/layer-selection.mjs';
import { validateLayerFilterResources } from '../server/layer-filters.mjs';
import { layerTree } from '../server/groups.mjs';

const coded = code => cause => cause.code === code;
const edit = async (native, doc, command, args = {}) => (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document;
const get = async (native, doc) => (await native.execute('get_document', { documentId: doc.id })).document;
const graphOf = (native, doc) => structuredClone(native.project(doc.id).states[native.project(doc.id).cursor].graph);
const content = layer => !['group', 'adjustment'].includes(layer.type);
const transform = (width, height, kernel = 'nearest') => ({ type: 'resample', width, height, kernel });
const pixels = (width, height) => Buffer.from(Array.from({ length: width * height * 4 }, (_, i) => i % 4 === 3 ? Math.floor(i / 4) % 256 : (i * 31 + Math.floor(i / 4) * 17 + 63) % 256));
const png = (data, width, height) => sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
const photo = (data, width, height, outWidth, outHeight, kernel) => sharp(data, { raw: { width, height, channels: 4 }, limitInputPixels: 24_000_000 }).resize(outWidth, outHeight, { fit: 'fill', kernel }).raw().toBuffer();
function nearestOracle(data, width, height, outWidth, outHeight) {
  const output = Buffer.alloc(outWidth * outHeight * 4);
  for (let y = 0; y < outHeight; y++) for (let x = 0; x < outWidth; x++) {
    const sx = Number(BigInt(2 * x + 1) * BigInt(width) / BigInt(2 * outWidth));
    const sy = Number(BigInt(2 * y + 1) * BigInt(height) / BigInt(2 * outHeight));
    data.copy(output, (y * outWidth + x) * 4, (sy * width + sx) * 4, (sy * width + sx + 1) * 4);
  }
  return output;
}
async function fixture(t, width = 13, height = 9) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-resampling-'));
  const native = await new NativeBackend({ dataDir }).init();
  t.after(async () => { await native.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const source = await png(pixels(width, height), width, height);
  const doc = (await native.execute('import_image', { data: source.toString('base64'), mimeType: 'image/png', name: 'Resize pixels' })).document;
  return { native, dataDir, doc, source };
}

test('strict resample records and method validation never silently substitute a kernel', async () => {
  assert.equal(normalizeDocumentResizeMethod(), 'lanczos3');
  assert.equal(DOCUMENT_RESIZE_DEFAULT, 'lanczos3');
  assert.deepEqual(DOCUMENT_RESIZE_METHODS, ['nearest', 'cubic', 'mitchell', 'lanczos3']);
  for (const value of [null, '', 'Nearest', 'linear', 0, {}, []]) assert.throws(() => normalizeDocumentResizeMethod(value), coded('INVALID_ARGUMENT'));
  for (const kernel of DOCUMENT_RESIZE_METHODS) assert.deepEqual(normalizeResampleTransform(transform(1, 1, kernel)), transform(1, 1, kernel));
  let access = 0;
  const bad = [null, [], {}, { ...transform(1, 1), kernel: undefined }, { ...transform(1, 1), type: 'resize' }, { ...transform(1, 1), extra: true }, { ...transform(1, 1), resample: 'nearest' }, Object.assign(Object.create({ inherited: true }), transform(1, 1)), { ...transform(1, 1), [Symbol('kernel')]: 'nearest' }];
  const getter = transform(1, 1); Object.defineProperty(getter, 'kernel', { enumerable: true, get: () => { access++; return 'nearest'; } }); bad.push(getter);
  for (const record of bad) assert.throws(() => normalizeResampleTransform(record), coded('INVALID_ARGUMENT'));
  assert.equal(access, 0);
  for (const [width, height] of [[0, 1], [1.5, 1], [8193, 1], [6000, 4001]]) assert.throws(() => normalizeResampleTransform(transform(width, height)), coded('LIMIT_EXCEEDED'));
  await assert.rejects(resamplePixels(Buffer.alloc(3), 1, 1, transform(1, 1)), coded('INVALID_ARGUMENT'));
});

test('native nearest copies exact RGBA for all alpha bytes and odd up/down/mixed center mappings, with bounded yields', async () => {
  for (const [width, height, outWidth, outHeight] of [[256, 1, 512, 3], [256, 1, 256, 1], [3, 1, 5, 1], [3, 1, 4, 1], [7, 5, 3, 2], [5, 3, 7, 8], [13, 7, 4, 11], [1, 13, 3, 5]]) {
    const source = pixels(width, height), before = Buffer.from(source);
    const output = await resamplePixels(source, width, height, transform(outWidth, outHeight));
    assert.deepEqual(output, nearestOracle(source, width, height, outWidth, outHeight));
    assert.deepEqual(source, before); assert.notEqual(output, source);
  }
  const fixture = Buffer.from([240, 7, 9, 0, 4, 121, 230, 1, 11, 23, 117, 128, 20, 40, 60, 255]);
  assert.notDeepEqual(await resamplePixels(fixture, 4, 1, transform(8, 2)), await photo(fixture, 4, 1, 8, 2, 'nearest'));
  let ticks = 0, running = true;
  const beat = () => { if (running) { ticks++; setImmediate(beat); } }; setImmediate(beat);
  const output = await resamplePixels(pixels(8192, 1), 8192, 1, transform(8192, 128)); running = false;
  assert.equal(output.length, 8192 * 128 * 4); assert.ok(ticks >= 16, `Observed ${ticks} scheduled yields`);
});

test('photo methods follow installed Sharp for reduction, enlargement and mixed axes while legacy default remains identical', async t => {
  const { native, doc } = await fixture(t);
  for (const [width, height] of [[5, 4], [23, 17], [5, 17], [23, 4], [13, 9]]) {
    const source = await native.renderLayer(doc.layers[0]), hashes = [];
    for (const kernel of ['cubic', 'mitchell', 'lanczos3']) {
      const output = await resamplePixels(source, 13, 9, transform(width, height, kernel));
      assert.deepEqual(output, await photo(source, 13, 9, width, height, kernel)); hashes.push(output);
    }
    if (width > 13 && height > 9) { assert.deepEqual(hashes[0], hashes[1]); assert.deepEqual(hashes[1], hashes[2]); }
    if (width < 13 || height < 9) assert.notDeepEqual(hashes[0], hashes[2]);
    let implicit = await edit(native, await get(native, doc), 'resize_document', { width, height });
    const expected = await photo(source, 13, 9, width, height, 'lanczos3');
    assert.deepEqual(await native.renderLayer(implicit.layers[0]), expected);
    assert.deepEqual(implicit.layers[0].transforms, [{ type: 'resize', width, height }]);
    const firstLayers = implicit.layers, firstPixels = await native.render(native.project(doc.id));
    implicit = await edit(native, implicit, 'undo');
    implicit = await edit(native, implicit, 'resize_document', { width, height, resample: 'lanczos3' });
    assert.deepEqual(implicit.layers, firstLayers); assert.deepEqual(await native.render(native.project(doc.id)), firstPixels);
    await edit(native, implicit, 'undo');
  }
});

test('every content type follows retained geometry without flattening, assets or source-coordinate changes', async t => {
  const { native, doc: start } = await fixture(t);
  let doc = await edit(native, start, 'add_text', { text: 'A&\nB', x: 1, y: 4, fontSize: 4, color: '#df1799', tracking: 30, leading: 4 });
  doc = await edit(native, doc, 'add_shape', { shape: 'ellipse', x: 1, y: 1, width: 8, height: 5, fill: '#14f922' });
  doc = await edit(native, doc, 'add_path', { nodes: [{ x: 1, y: 7 }, { x: 11, y: 2 }], stroke: '#2244ee', strokeWidth: 1 });
  doc = await edit(native, doc, 'add_gradient', { kind: 'linear', start: { x: 0, y: 0 }, end: { x: 12, y: 8 }, stops: [{ offset: 0, color: '#200044' }, { offset: 1, color: '#aaff00' }] });
  let graph = graphOf(native, doc);
  graph.layers.push({ id: randomUUID(), name: 'Solid', type: 'solid', visible: true, opacity: 1, blendMode: 'normal', color: '#783194', width: 13, height: 9, transforms: [] });
  doc = (await native.commit(native.project(doc.id), graph, 'Fixture solid')).document;
  doc = await edit(native, doc, 'crop_document', { x: 1, y: 1, width: 11, height: 7 });
  const before = doc, sources = new Map(); for (const layer of before.layers) sources.set(layer.id, await native.renderLayer(layer));
  const assets = await fs.readdir(native.assetsDir);
  for (const method of DOCUMENT_RESIZE_METHODS) {
    doc = await edit(native, await get(native, before), 'resize_document', { width: 8, height: 5, resample: method });
    for (const layer of doc.layers) {
      const prior = before.layers.find(item => item.id === layer.id);
      assert.deepEqual({ ...layer, transforms: prior.transforms }, prior);
      assert.deepEqual(await native.renderLayer(layer), method === 'nearest' ? nearestOracle(sources.get(layer.id), 11, 7, 8, 5) : await photo(sources.get(layer.id), 11, 7, 8, 5, method));
    }
    doc = await edit(native, doc, 'undo');
  }
  assert.deepEqual(await fs.readdir(native.assetsDir), assets);
  const caps = await native.execute('capabilities', {}); assert.deepEqual(caps.documentResizeMethods, DOCUMENT_RESIZE_METHODS); assert.equal(caps.documentResizeDefault, 'lanczos3');
});

test('masks on every node, density, saved selections and guides keep the legacy metadata transform for every image method', async t => {
  const { native, doc: initial } = await fixture(t);
  let doc = await edit(native, initial, 'add_adjustment', { kind: 'brightness', value: 17 });
  doc = await edit(native, doc, 'group_layers', { layerIds: doc.layers.map(layer => layer.id), name: 'Masks' });
  const graph = graphOf(native, doc), mask = { ...bitmapMask(Uint8Array.from({ length: 117 }, (_, i) => i * 37 % 256), 13, 9), feather: 1.25, invert: true };
  graph.layers[0].mask = { shape: 'ellipse', x: .5, y: 1, width: 10, height: 7, feather: 1.5, invert: true, clip: { x: 0, y: 1, width: 12, height: 7 } };
  graph.layers[1].mask = mask; graph.layers[1].maskDensity = .25;
  graph.layers[2].mask = { shape: 'polygon', points: [{ x: 1, y: 1 }, { x: 10, y: 1 }, { x: 5, y: 8 }], x: 1, y: 1, width: 9, height: 7, feather: 2, invert: false };
  graph.layers[2].visible = false; graph.layers[2].maskDensity = 0;
  graph.selection = { ...bitmapMask(new Uint8Array(117), 13, 9), invert: false };
  graph.savedSelections = [{ id: randomUUID(), name: 'Soft bitmap', mask: structuredClone(mask) }];
  graph.guides = [{ id: randomUUID(), axis: 'vertical', position: 13 }, { id: randomUUID(), axis: 'horizontal', position: 4 }];
  doc = (await native.commit(native.project(doc.id), graph, 'Mask metadata fixture')).document;
  const before = doc, geometry = { type: 'resize', width: 7, height: 4 };
  const render = native.renderLayer, store = native.storeAsset;
  native.renderLayer = async () => assert.fail('Resize mutation must not render'); native.storeAsset = async () => assert.fail('Resize mutation must not write assets');
  try {
    for (const resample of DOCUMENT_RESIZE_METHODS) {
      doc = await edit(native, await get(native, doc), 'resize_document', { width: 7, height: 4, resample });
      for (const layer of doc.layers) { const prior = before.layers.find(item => item.id === layer.id); assert.deepEqual(layer.mask, transformMask(prior.mask, geometry, 13, 9)); assert.equal(layer.maskDensity, prior.maskDensity); if (!content(layer)) assert.equal(layer.transforms, undefined); }
      assert.deepEqual(doc.selection, transformMask(before.selection, geometry, 13, 9)); assert.notEqual(doc.selection, null);
      assert.deepEqual(doc.savedSelections[0].mask, transformMask(before.savedSelections[0].mask, geometry, 13, 9));
      assert.deepEqual(doc.guides, transformGuides(before.guides, geometry, 13, 9));
      doc = await edit(native, doc, 'undo');
    }
  } finally { native.renderLayer = render; native.storeAsset = store; }
});

test('source cutout alpha and filters run before the new stage; contextual restoration follows matching nearest geometry', async t => {
  const { native, doc: initial } = await fixture(t, 7, 5);
  let graph = graphOf(native, initial), target = graph.layers[0];
  const cutout = Buffer.from(Array.from({ length: 35 }, (_, i) => [0, 1, 128, 255][i % 4]));
  target.alphaAsset = await native.storeAlpha(cutout, 7, 5);
  target.filters = [{ id: randomUUID(), kind: 'mosaic', value: 3, enabled: true, opacity: .6 }, { id: randomUUID(), kind: 'invert', value: 100, enabled: true, opacity: .4 }];
  let doc = (await native.commit(native.project(initial.id), graph, 'Source alpha filter fixture')).document;
  const graded = await native.renderLayer(doc.layers[0]), raw = await native.renderLayer(doc.layers[0], { filters: false });
  doc = await edit(native, doc, 'resize_document', { width: 11, height: 8, resample: 'nearest' });
  assert.deepEqual(await native.renderLayer(doc.layers[0]), nearestOracle(graded, 7, 5, 11, 8));
  const footprint = Uint8Array.from({ length: 88 }, (_, i) => i % 3 === 0 ? 1 : 0), expected = nearestOracle(graded, 7, 5, 11, 8), original = nearestOracle(raw, 7, 5, 11, 8);
  for (let i = 0; i < 88; i++) if (footprint[i]) original.copy(expected, i * 4, i * 4, i * 4 + 3);
  assert.deepEqual(await native.renderLayer(doc.layers[0], { protectedPixels: footprint }), expected);
  assert.equal(doc.layers[0].alphaAsset, target.alphaAsset); assert.deepEqual(doc.layers[0].filters, target.filters);
});

test('full generated clipping and isolated-group traversal preserves protected soft-alpha footprints under exact integer enlargement', async t => {
  const { native, doc: initial } = await fixture(t, 4, 2);
  const graph = graphOf(native, initial), lower = graph.layers[0];
  const source = Buffer.from(Array.from({ length: 8 }, (_, i) => [21 + i * 11, 53 + i * 9, 161 - i * 7, [0, 1, 128, 255][i % 4]]).flat());
  lower.asset = await native.storeAsset(await png(source, 4, 2)); lower.protected = true;
  const group = { id: randomUUID(), name: 'Isolated', type: 'group', mode: 'isolated', visible: true, opacity: .6, blendMode: 'normal' };
  const base = { ...structuredClone(lower), id: randomUUID(), name: 'Clip base', parentId: group.id, protected: false };
  base.mask = bitmapMask(Uint8Array.from([255, 128, 255, 0, 128, 255, 1, 255]), 4, 2);
  base.maskDensity = .5;
  const generated = { ...structuredClone(base), id: randomUUID(), name: 'Generated clip member', role: 'generated', provenance: { jobId: randomUUID() }, clipBaseId: base.id };
  delete generated.mask; delete generated.maskDensity;
  generated.filters = [{ id: randomUUID(), kind: 'brightness', value: 41, enabled: true, opacity: .7 }];
  graph.layers.push(group, base, generated);
  let doc = (await native.commit(native.project(initial.id), graph, 'Generated clipping fixture')).document;
  const before = await native.render(native.project(doc.id)), originalAssets = doc.layers.filter(content).map(layer => layer.asset);
  doc = await edit(native, doc, 'resize_document', { width: 8, height: 4, resample: 'nearest' });
  assert.deepEqual(await native.render(native.project(doc.id)), nearestOracle(before, 4, 2, 8, 4));
  assert.deepEqual(doc.layers.filter(content).map(layer => layer.asset), originalAssets);
  assert.equal(doc.layers.at(-1).clipBaseId, base.id); assert.equal(doc.layers.at(-1).role, 'generated');
});

test('all methods preserve protected proportions and reject positioned masks before any image I/O', async t => {
  const { native, doc: initial } = await fixture(t, 8, 6);
  let doc = await edit(native, initial, 'set_layer_protection', { layerId: initial.layers[0].id, protected: true });
  const render = native.renderLayer, store = native.storeAsset;
  native.renderLayer = async () => assert.fail('Guard must not render'); native.storeAsset = async () => assert.fail('Guard must not write');
  try {
    for (const resample of DOCUMENT_RESIZE_METHODS) {
      await assert.rejects(edit(native, doc, 'resize_document', { width: 8, height: 3, resample }), coded('PROTECTED_LAYER'));
      doc = await edit(native, doc, 'resize_document', { width: 4, height: 3, resample }); doc = await edit(native, doc, 'undo');
    }
    doc = await edit(native, doc, 'set_layer_mask', { layerId: doc.layers[0].id, mask: { x: 0, y: 0, width: 4, height: 3 } });
    doc = await edit(native, doc, 'set_layer_mask_position', { layerId: doc.layers[0].id, x: 1, y: 0 });
    doc = await edit(native, doc, 'modify_layer_mask', { layerId: doc.layers[0].id, density: 0 });
    doc = await edit(native, doc, 'set_layer', { layerId: doc.layers[0].id, visible: false });
    for (const resample of DOCUMENT_RESIZE_METHODS) {
      await assert.rejects(edit(native, doc, 'resize_document', { width: 4, height: 3, resample }), coded('MASK_POSITION_REQUIRES_RASTERIZE'));
      assert.deepEqual(await get(native, doc), doc);
    }
  } finally { native.renderLayer = render; native.storeAsset = store; }
});

test('strict portable records fail before asset reads and estimators retain original/current/next frame accounting', async t => {
  const { native, doc } = await fixture(t), original = graphOf(native, doc);
  const assets = new Map(); for (const field of ['asset', 'sourceAsset']) { const hash = doc.layers[0][field]; assets.set(hash, await fs.readFile(path.join(native.assetsDir, hash))); }
  const cases = [{ type: 'resize', width: 13, height: 9, kernel: 'nearest' }, { type: 'resize', width: 13, height: 9, resample: 'nearest' }, { type: 'resample', width: 13, height: 9 }, { ...transform(13, 9), kernel: 'linear' }, { ...transform(13, 9), foo: true }];
  for (const record of cases) {
    const graph = structuredClone(original); graph.layers[0].transforms = [record];
    const data = await encodeProjectBundle({ graph, readAsset: hash => assets.get(hash), validateGraph: () => {} });
    let imageReads = 0; const readFile = fs.readFile; fs.readFile = async (...args) => { imageReads++; return readFile(...args); };
    try { await assert.rejects(native.importProject({ data }), coded('INVALID_PROJECT_BUNDLE')); } finally { fs.readFile = readFile; }
    assert.equal(imageReads, 0);
  }
  const graph = structuredClone(original); graph.width = 7; graph.height = 5; graph.layers[0].transforms = [transform(100, 200), transform(7, 5)];
  const estimate = estimateLayerSelectionBytes({ graph, layer: graph.layers[0] });
  assert.equal(estimate.sourceBytes, 4 * 117 + 4 * 117 + 4 * 20000 + 35);
  graph.layers[0].filters = [{ id: randomUUID(), kind: 'invert', value: 100, enabled: true, opacity: 1 }];
  assert.equal(validateLayerFilterResources(graph, layerTree(graph.layers)).estimatedScratchBytes, 20000 * 8 + 35);
  const legacyTypes = new Set(['crop', 'resize', 'canvas', 'affine']); assert.equal(legacyTypes.has('resample'), false);
  const tooMany = structuredClone(original); tooMany.layers[0].transforms = Array.from({ length: 501 }, () => transform(13, 9));
  assert.throws(() => native.validateGraph(tooMany));
});

test('retained resampling survives transactions, undo, duplicate, portable reopen and real persistence failure without asset changes', async t => {
  const { native, doc: initial, dataDir } = await fixture(t), assets = await fs.readdir(native.assetsDir);
  const bytes = new Map(await Promise.all(assets.map(async hash => [hash, await fs.readFile(path.join(native.assetsDir, hash))])));
  let doc = await edit(native, initial, 'apply_transaction', { label: 'Two resamplers', operations: [{ command: 'resize_document', args: { width: 7, height: 5, resample: 'nearest' } }, { command: 'resize_document', args: { width: 11, height: 8, resample: 'mitchell' } }] });
  assert.equal(doc.history.length, initial.history.length + 1);
  const source = await native.renderLayer(initial.layers[0]), expected = await photo(nearestOracle(source, 13, 9, 7, 5), 7, 5, 11, 8, 'mitchell');
  assert.deepEqual(await native.renderLayer(doc.layers[0]), expected);
  const saved = doc; doc = await edit(native, doc, 'undo'); assert.deepEqual(doc.layers, initial.layers); doc = await edit(native, doc, 'redo'); assert.deepEqual(doc.layers, saved.layers);
  const portable = (await native.importProject({ data: (await native.exportProject({ documentId: doc.id })).data })).document;
  assert.deepEqual(portable.layers, doc.layers); assert.deepEqual(await native.renderLayer(portable.layers[0]), expected);
  doc = await edit(native, doc, 'duplicate_layer', { layerId: doc.layers[0].id }); assert.deepEqual(doc.layers[1].transforms, doc.layers[0].transforms);
  const reopened = await new NativeBackend({ dataDir }).init(); t.after(() => reopened.close());
  assert.deepEqual((await get(reopened, doc)).layers, doc.layers);
  await assert.rejects(native.execute('resize_document', { documentId: doc.id, expectedRevision: initial.revision, width: 2, height: 2, resample: 'nearest' }), coded('REVISION_CONFLICT'));
  const file = path.join(native.projectsDir, `${doc.id}.json`), beforeBytes = await fs.readFile(file); await native.execute('get_preview', { documentId: doc.id }); const cache = native.previewCache.stats();
  const badPath = path.join(dataDir, 'not-a-directory'); await fs.writeFile(badPath, 'block'); const projectsDir = native.projectsDir; native.projectsDir = badPath;
  try { await assert.rejects(edit(native, doc, 'resize_document', { width: 5, height: 4, resample: 'cubic' }), coded('ENOTDIR')); } finally { native.projectsDir = projectsDir; }
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await fs.readFile(file), beforeBytes); assert.deepEqual(native.previewCache.stats(), cache);
  assert.deepEqual(await fs.readdir(native.assetsDir), assets); for (const [hash, prior] of bytes) assert.deepEqual(await fs.readFile(path.join(native.assetsDir, hash)), prior);
});
