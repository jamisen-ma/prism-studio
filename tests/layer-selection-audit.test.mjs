import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { combineSelections } from '../server/saved-selections.mjs';
import { estimateLayerSelectionBytes, loadLayerSelection, combineSelectionAlpha, encodeSelectionAlpha } from '../server/layer-selection.mjs';
import { authoredFrame, runCount } from './fixtures/dense-mask/reference.mjs';

// Independent numerical contract. Source mask coverage is quantized before
// optional whole-canvas byte inversion, then combined with active coverage.
const byte = amount => Math.min(255, Math.max(0, Math.round(amount * 255)));
const sourceBytes = (coverage, { density = 1, effective = false, invert = false } = {}) =>
  Buffer.from(coverage.map(amount => {
    const value = byte(effective ? 1 - density * (1 - amount) : amount);
    return invert ? 255 - value : value;
  }));
const referenceCombine = (active, loaded, mode) => Buffer.from([...loaded].map((value, index) => {
  if (mode === 'replace' || !active) return value;
  const a = active[index], b = value / 255;
  return byte(mode === 'add' ? Math.max(a, b) : mode === 'subtract' ? a * (1 - b) : a * b);
}));
const bitmap = (bytes, width, height) => ({ shape: 'bitmap', width, height, x: 0, y: 0, feather: 0, invert: false,
  runs: [...bytes].flatMap((value, index) => value ? [index, 1, value] : []) });
function unpack(mask) {
  assert.equal(mask.shape, 'bitmap'); assert.equal(mask.feather, 0); assert.equal(mask.invert, false);
  assert.equal(mask.clip, undefined); assert.equal(mask.density, undefined); assert.equal(mask.maskDensity, undefined);
  const out = Buffer.alloc(mask.width * mask.height);
  for (let i = 0; i < mask.runs.length; i += 3) out.fill(mask.runs[i + 2], mask.runs[i], mask.runs[i] + mask.runs[i + 1]);
  return out;
}
function rectangleCoverage(mask, width, height) {
  return Array.from({ length: width * height }, (_, index) => {
    const x = index % width + 0.5, y = Math.floor(index / width) + 0.5;
    const distance = Math.min(x - mask.x, y - mask.y, mask.x + mask.width - x, mask.y + mask.height - y);
    let amount = distance <= 0 ? 0 : mask.feather ? Math.min(1, distance / mask.feather) : 1;
    if (mask.invert) amount = 1 - amount;
    if (mask.clip && (x < mask.clip.x || y < mask.clip.y || x >= mask.clip.x + mask.clip.width || y >= mask.clip.y + mask.clip.height)) amount = 0;
    return amount;
  });
}

// Independently enumerate retained byte buffers in the documented phases.
// Metadata and image-library internals are not claimed as whole-process RSS.
function memoryOracle({ graph, layer, source = 'content', maskMode = 'effective', mode = 'replace', encodedSourceBytes = 0, encodedAlphaBytes = 0 }) {
  const canvas = graph.width * graph.height;
  const callbackBytes = mask => mask?.shape === 'bitmap' ? mask.width * mask.height * (mask.feather > 0 ? 5 : 1) : 0;
  let sourceBytes = 0, maskBytes = 0;
  if (source === 'content') {
    const original = layer.width * layer.height;
    let previous = original;
    const live = [4 * original, ...(layer.alphaAsset ? [9 * original] : [])];
    for (const transform of layer.transforms) {
      const next = transform.width * transform.height;
      live.push(4 * original + 4 * previous + 4 * next); previous = next;
    }
    const procedural = layer.type === 'gradient' ? 4 * original : ['text', 'shape', 'path'].includes(layer.type) ? 1024 * 1024 : 0;
    sourceBytes = encodedSourceBytes + encodedAlphaBytes + procedural + Math.max(...live) + canvas;
  } else maskBytes = canvas + (maskMode === 'effective' && layer.maskDensity === 0 ? 0 : callbackBytes(layer.mask));
  const combinationBytes = canvas + (mode !== 'replace' && graph.selection ? canvas + callbackBytes(graph.selection) : 0);
  return { sourceBytes, maskBytes, combinationBytes, estimatedWorkingBytes: Math.max(sourceBytes, maskBytes, combinationBytes), maxWorkingBytes: 256 * 1024 * 1024 };
}
const common = extra => ({ id: randomUUID(), name: 'Selection audit', visible: true, opacity: 1, blendMode: 'normal', ...extra });
const solid = (width, height, extra = {}) => common({ type: 'solid', width, height, transforms: [], color: '#3162a8', ...extra });
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-layer-selection-audit-'));
  const native = await new NativeBackend({ dataDir, segmentSubject: () => assert.fail('Loading alpha must not invoke a model') }).init();
  t.after(async () => { await native.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { native, dataDir };
}
const edit = async (native, doc, command, args = {}) => (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document;
const get = async (native, doc) => (await native.execute('get_document', { documentId: doc.id })).document;
const files = async directory => Object.fromEntries(await Promise.all((await fs.readdir(directory)).sort().map(async name => [name, await fs.readFile(path.join(directory, name))])));
const project = async (native, width, height, layers, extra = {}) => (await native.newProject({ name: 'Independent layer selection', width, height, selection: null, layers, ...extra }, 'Audit fixture')).document;
async function raster(native, pixels, width, height, extra = {}) {
  const asset = await native.storeAsset(await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer());
  return common({ type: 'raster', asset, sourceAsset: asset, sourceFormat: 'png', width, height, transforms: [], ...extra });
}

test('independent layer-selection oracle fixes density quantization, inversion and existing combination semantics', async () => {
  assert.deepEqual(sourceBytes([0, 0.5, 1], { density: 0.5, effective: true }), Buffer.from([128, 191, 255]));
  assert.deepEqual(sourceBytes([0, 0.5, 1], { density: 0.5, effective: true, invert: true }), Buffer.from([127, 64, 0]));
  const width = 9, height = 6, mask = { shape: 'rectangle', x: 0.3, y: 0.1, width: 6.8, height: 5.2, feather: 1.7, invert: true, clip: { x: 1.5, y: 0, width: 6, height: 5 } };
  const raw = rectangleCoverage(mask, width, height), active = { ...mask, invert: false, feather: 1.3 }, activeCoverage = rectangleCoverage(active, width, height);
  for (const density of [0, 0.17, 0.5, 1]) for (const effective of [false, true]) for (const invert of [false, true]) {
    const loaded = sourceBytes(raw, { density, effective, invert }), source = bitmap(loaded, width, height), before = structuredClone({ source, active });
    for (const mode of ['replace', 'add', 'subtract', 'intersect']) {
      assert.deepEqual(unpack(combineSelections(active, source, width, height, mode)), referenceCombine(activeCoverage, loaded, mode));
      assert.deepEqual(unpack(await combineSelectionAlpha(active, loaded, width, height, mode)), referenceCombine(activeCoverage, loaded, mode));
    }
    assert.deepEqual({ source, active }, before);
  }
  let seed = 0xcea172b;
  const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  for (let sample = 0; sample < 200; sample++) {
    const a = Buffer.from(Array.from({ length: width * height }, () => next() % 256)), b = Buffer.from(Array.from({ length: width * height }, () => next() % 256));
    for (const mode of ['replace', 'add', 'subtract', 'intersect']) {
      const reference = referenceCombine([...a].map(value => value / 255), b, mode);
      assert.deepEqual(unpack(combineSelections(bitmap(a, width, height), bitmap(b, width, height), width, height, mode)), reference);
      assert.deepEqual(unpack(await combineSelectionAlpha(bitmap(a, width, height), b, width, height, mode)), reference);
    }
  }
  const empty = bitmap(Buffer.alloc(width * height), width, height);
  const replaced = combineSelections(null, empty, width, height, 'replace'); assert.ok(replaced); assert.deepEqual(replaced.runs, []);
  assert.deepEqual(unpack(combineSelections(null, empty, width, height, 'add')), Buffer.alloc(width * height));
  for (const mode of ['subtract', 'intersect']) assert.throws(() => combineSelections(null, empty, width, height, mode), { code: 'NO_SELECTION' });
});

test('phase memory estimates account encoded assets, original and geometry frames, alpha combination and feather callbacks', async () => {
  const selection = { ...bitmap([128], 1, 1), width: 6000, height: 4000, feather: 1 };
  for (const type of ['raster', 'solid', 'text', 'shape', 'path', 'gradient']) for (const alphaAsset of [undefined, 'a'.repeat(64)]) for (const mode of ['replace', 'add']) {
    const layer = { type, width: 8000, height: 2000, alphaAsset, transforms: [{ type: 'crop', width: 6000, height: 1000 }, { type: 'resize', width: 6000, height: 4000 }, { type: 'affine', width: 6000, height: 4000 }] };
    const options = { graph: { width: 6000, height: 4000, selection }, layer, mode, encodedSourceBytes: 173, encodedAlphaBytes: 257 };
    assert.deepEqual(estimateLayerSelectionBytes(options), memoryOracle(options));
  }
  for (const feather of [0, 1]) for (const density of [0, 0.5, 1]) for (const maskMode of ['raw', 'effective']) for (const mode of ['replace', 'intersect']) {
    const options = { graph: { width: 6000, height: 4000, selection }, layer: { mask: { ...selection, feather }, maskDensity: density }, source: 'layer-mask', maskMode, mode };
    assert.deepEqual(estimateLayerSelectionBytes(options), memoryOracle(options));
  }
  const width = 3000, height = 2000, layer = { ...solid(width, height), type: 'raster', asset: 'a'.repeat(64), alphaAsset: 'b'.repeat(64) }, graph = { width, height, selection: null, layers: [layer] };
  const base = memoryOracle({ graph, layer }).sourceBytes, limit = 256 * 1024 * 1024, encodedSourceBytes = 128 * 1024 * 1024, encodedAlphaBytes = limit - base - encodedSourceBytes;
  assert.ok(encodedAlphaBytes > 0 && encodedAlphaBytes <= 128 * 1024 * 1024);
  let renderCalls = 0;
  const renderLayer = () => { renderCalls++; throw Error('Sentinel: no large pixel allocation needed'); };
  await assert.rejects(loadLayerSelection(graph, { layerId: layer.id }, { renderLayer, sourceAssetBytes: async () => ({ encodedSourceBytes, encodedAlphaBytes }) }), { code: 'INVALID_IMAGE' });
  assert.equal(renderCalls, 1, 'exact accounted limit reaches the renderer');
  await assert.rejects(loadLayerSelection(graph, { layerId: layer.id }, { renderLayer, sourceAssetBytes: async () => ({ encodedSourceBytes, encodedAlphaBytes: encodedAlphaBytes + 1 }) }), { code: 'LIMIT_EXCEEDED' });
  assert.equal(renderCalls, 1, 'one byte above the limit rejects before rendering');
  const large = solid(8000, 3000, { transforms: [{ type: 'affine', width: 8000, height: 3000, x: 1, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }] });
  await assert.rejects(loadLayerSelection({ width: 8000, height: 3000, layers: [large] }, { layerId: large.id }, { renderLayer }), { code: 'LIMIT_EXCEEDED' });
  assert.equal(renderCalls, 1);
});

test('transparency uses transformed working alpha and separate cutout alpha, ignoring all display settings without image writes', async t => {
  const { native, dataDir } = await fixture(t), width = 7, height = 5, sourceWidth = 4, sourceHeight = 3;
  const rgba = Buffer.from(Array.from({ length: 12 }, (_, i) => [17 + i * 11, 81, 230 - i, [0, 1, 128, 255][i % 4]]).flat());
  const source = await raster(native, Buffer.alloc(4 * 12, 255), 4, 3), working = await raster(native, rgba, 4, 3);
  const alpha = Buffer.from(Array.from({ length: 12 }, (_, i) => [255, 128, 64, 1][Math.floor(i / 4)])), alphaAsset = await native.storeAlpha(alpha, 4, 3);
  const group = common({ type: 'group', mode: 'isolated', visible: false, opacity: 0.3, blendMode: 'multiply', mask: { x: 0, y: 0, width: 1, height: 1 } });
  const layer = { ...working, sourceAsset: source.asset, alphaAsset, parentId: group.id, opacity: 0, visible: false, blendMode: 'dissolve', mask: { x: 0, y: 0, width: 1, height: 1 }, maskDensity: 0.5,
    transforms: [{ type: 'canvas', width, height, x: 1, y: 1 }, { type: 'affine', width, height, x: 1, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }],
    effects: { shadow: { opacity: 0.8, blur: 0, x: 1, y: 1, color: '#000000' } }, filters: [{ id: randomUUID(), kind: 'brightness', value: 80, enabled: true, opacity: 1 }] };
  const initial = await project(native, width, height, [group, layer]), assets = await files(native.assetsDir), render = native.renderLayer;
  let renderCalls = 0; native.renderLayer = async function (target, options) { renderCalls++; assert.equal(options.filters, false); return render.call(this, target, options); };
  const store = native.storeAsset; native.storeAsset = () => assert.fail('Selection loading must not write image assets');
  let doc;
  try { doc = await edit(native, initial, 'load_layer_selection', { layerId: layer.id }); }
  finally { native.renderLayer = render; native.storeAsset = store; }
  const expected = Buffer.alloc(width * height);
  for (let y = 0; y < sourceHeight; y++) for (let x = 0; x < sourceWidth; x++) expected[(y + 1) * width + x + 2] = Math.round(rgba[(y * sourceWidth + x) * 4 + 3] * alpha[y * sourceWidth + x] / 255);
  assert.deepEqual(unpack(doc.selection), expected); assert.equal(renderCalls, 1); assert.deepEqual(doc.layers, initial.layers); assert.deepEqual(await files(native.assetsDir), assets);
  assert.equal(doc.revision, initial.revision + 1); assert.equal(doc.history.length, initial.history.length + 1);
  doc = await edit(native, doc, 'save_selection', { name: 'Independent working silhouette' });
  const saved = structuredClone(doc.savedSelections);
  doc = await edit(native, doc, 'load_layer_selection', { layerId: layer.id, invert: true });
  assert.deepEqual(unpack(doc.selection), Buffer.from([...expected].map(value => 255 - value))); assert.deepEqual(doc.savedSelections, saved);
  const undone = await edit(native, doc, 'undo'); assert.deepEqual(unpack(undone.selection), expected);
  const reopened = await new NativeBackend({ dataDir }).init(); t.after(() => reopened.close());
  assert.deepEqual((await get(reopened, undone)).selection, undone.selection);
  const imported = await native.importProject({ data: (await native.exportProject({ documentId: undone.id })).data });
  assert.deepEqual(imported.document.selection, undone.selection); assert.deepEqual(imported.document.layers, undone.layers);
});

test('raw and effective additional masks work on groups, adjustments and missing-image rasters without reading pixels', async t => {
  const { native } = await fixture(t), width = 9, height = 6;
  const mask = { shape: 'rectangle', x: 0.3, y: 0.1, width: 6.8, height: 5.2, feather: 1.7, invert: true, clip: { x: 1.5, y: 0, width: 6, height: 5 } };
  const active = { ...mask, invert: false, feather: 1.3 }, raw = rectangleCoverage(mask, width, height), a = rectangleCoverage(active, width, height);
  const saved = [{ id: randomUUID(), name: 'Do not modify saved mask', mask: structuredClone(active) }];
  const prototypes = [common({ type: 'group', mode: 'isolated', visible: false }), common({ type: 'adjustment', kind: 'invert', value: 100, visible: false }), common({ type: 'raster', width, height, transforms: [{ type: 'affine', width, height, x: 2, y: 1, scaleX: 1, scaleY: 1, rotation: 0 }], asset: 'a'.repeat(64), sourceAsset: 'b'.repeat(64), protected: true, opacity: 0 })];
  const render = native.renderLayer, store = native.storeAsset;
  native.renderLayer = () => assert.fail('Additional mask selection must not render image pixels'); native.storeAsset = () => assert.fail('Additional mask selection must not write image pixels');
  try {
    for (const prototype of prototypes) for (const density of [0, 0.5, 1]) {
      const layer = { ...prototype, mask: structuredClone(mask), maskDensity: density };
      const doc = await project(native, width, height, [layer], { selection: active, savedSelections: saved }), graph = { width, height, layers: [layer], selection: active, savedSelections: saved }, before = structuredClone(graph);
      for (const maskMode of ['raw', 'effective']) for (const invert of [false, true]) for (const mode of ['replace', 'add', 'subtract', 'intersect']) {
        const result = await loadLayerSelection(graph, { layerId: layer.id, source: 'layer-mask', maskMode, invert, mode }, { renderLayer: () => assert.fail('Unexpected render'), sourceAssetBytes: () => assert.fail('Unexpected asset stat') });
        const loaded = sourceBytes(raw, { density, effective: maskMode === 'effective', invert });
        assert.deepEqual(unpack(result.selection), referenceCombine(a, loaded, mode)); assert.deepEqual(graph, before);
      }
      const loaded = await edit(native, doc, 'load_layer_selection', { layerId: layer.id, source: 'layer-mask', maskMode: 'effective', invert: true, mode: 'intersect' });
      assert.deepEqual(unpack(loaded.selection), referenceCombine(a, sourceBytes(raw, { density, effective: true, invert: true }), 'intersect'));
      assert.deepEqual(loaded.layers, doc.layers); assert.deepEqual(loaded.savedSelections, saved);
    }
  } finally { native.renderLayer = render; native.storeAsset = store; }
  assert.deepEqual(await files(native.assetsDir), {});
});

test('clipping and generated source alpha ignore display windows while subsequent selected edits preserve protected people', async t => {
  const { native } = await fixture(t), width = 6, height = 4, count = width * height;
  const protectMask = { x: 0, y: 0, width: 3, height }, person = solid(width, height, { protected: true, mask: protectMask, color: '#4b729d' });
  const base = await raster(native, Buffer.from(Array.from({ length: count }, (_, i) => [91, 120, 170, i % width === 4 ? 128 : 0]).flat()), width, height);
  const alpha = Buffer.from(Array.from({ length: count }, (_, i) => [0, 1, 128, 255, 255, 128][i % width]));
  const member = await raster(native, Buffer.from([...alpha].flatMap((a, i) => [31 + i, 64, 207, a])), width, height, { clipBaseId: base.id, role: 'generated', opacity: 0.25, mask: { x: 3, y: 0, width: 2, height }, provenance: { jobId: randomUUID(), mode: 'edit' } });
  let doc = await project(native, width, height, [person, base, member]);
  const assets = await files(native.assetsDir), before = await native.renderGraph(doc);
  doc = await edit(native, doc, 'load_layer_selection', { layerId: member.id });
  assert.deepEqual(unpack(doc.selection), alpha); assert.deepEqual(await files(native.assetsDir), assets); assert.deepEqual(await native.renderGraph(doc), before);
  const snapshot = await native.snapshotForGeneration({ documentId: doc.id, expectedRevision: doc.revision, scope: 'selection' });
  const maskPixels = await sharp(snapshot.mask).ensureAlpha().raw().toBuffer();
  for (let i = 0; i < count; i++) assert.equal(maskPixels[i * 4 + 3], i % width < 3 ? 255 : 255 - alpha[i]);
  doc = await edit(native, doc, 'add_adjustment', { kind: 'invert', value: 100 });
  const after = await native.renderGraph(doc);
  for (let i = 0; i < count; i++) if (i % width < 3) assert.deepEqual(after.subarray(i * 4, i * 4 + 4), before.subarray(i * 4, i * 4 + 4));
  assert.deepEqual(await files(native.assetsDir), assets);
  doc = await edit(native, doc, 'load_layer_selection', { layerId: base.id });
  assert.deepEqual(unpack(doc.selection), Buffer.from(Array.from({ length: count }, (_, i) => i % width === 4 ? 128 : 0)));
});

test('empty transparency stays a restrictive selection and survives a single metadata transaction and undo', async t => {
  const { native } = await fixture(t), width = 5, height = 4;
  const background = solid(width, height), empty = await raster(native, Buffer.from(Array.from({ length: width * height }, () => [91, 67, 220, 0]).flat()), width, height);
  const initial = await project(native, width, height, [background, empty]), before = await native.renderGraph(initial), assets = await files(native.assetsDir);
  const doc = await edit(native, initial, 'apply_transaction', { label: 'Load empty silhouette and save', operations: [
    { command: 'load_layer_selection', args: { layerId: empty.id } },
    { command: 'save_selection', args: { name: 'Actually empty' } },
    { command: 'add_adjustment', args: { kind: 'invert', value: 100 } },
  ] });
  assert.ok(doc.selection); assert.deepEqual(doc.selection.runs, []); assert.deepEqual(doc.savedSelections[0].mask.runs, []);
  assert.equal(doc.revision, initial.revision + 1); assert.equal(doc.history.length, initial.history.length + 1);
  assert.deepEqual(await native.renderGraph(doc), before); assert.deepEqual(await files(native.assetsDir), assets);
  await assert.rejects(native.snapshotForGeneration({ documentId: doc.id, expectedRevision: doc.revision, scope: 'selection' }), { code: 'EMPTY_SELECTION' });
  const undone = await edit(native, doc, 'undo'); assert.deepEqual(undone.layers, initial.layers); assert.equal(undone.selection, null); assert.deepEqual(undone.savedSelections, initial.savedSelections);
});

test('invalid sources, stale revisions, memory refusal and late dense publication failures preserve all state', async t => {
  const { native, dataDir } = await fixture(t), width = 8, height = 5;
  const source = await raster(native, Buffer.alloc(width * height * 4, 255), width, height), group = common({ type: 'group', mode: 'pass-through' });
  const doc = await project(native, width, height, [source, group]);
  await native.execute('get_preview', { documentId: doc.id });
  const assets = await files(native.assetsDir), projects = await files(native.projectsDir), cache = native.previewCache.stats();
  const render = native.renderLayer, store = native.storeAsset; let rendered = 0;
  native.renderLayer = async (...args) => { rendered++; return render.apply(native, args); }; native.storeAsset = () => assert.fail('Selection attempted an asset write');
  for (const [args, code] of [[{ layerId: source.id, expectedRevision: doc.revision + 1 }, 'REVISION_CONFLICT'], [{ layerId: group.id }, 'INVALID_TARGET'], [{ layerId: randomUUID() }, 'NOT_FOUND'], [{ layerId: source.id, source: 'layer-mask' }, 'NO_MASK'], [{ layerId: source.id, maskMode: 'raw' }, 'INVALID_ARGUMENT'], [{ layerId: source.id, mode: 'subtract' }, 'NO_SELECTION'], [{ layerId: source.id, mode: 'intersect' }, 'NO_SELECTION'], [{ layerId: source.id, invert: 1 }, 'INVALID_ARGUMENT']]) await assert.rejects(edit(native, doc, 'load_layer_selection', args), { code });
  assert.equal(rendered, 0);
  const persist = native.persist; native.persist = () => { throw Object.assign(Error('Injected save failure'), { code: 'EIO' }); };
  try { await assert.rejects(edit(native, doc, 'load_layer_selection', { layerId: source.id }), { code: 'EIO' }); }
  finally { native.persist = persist; }
  assert.equal(rendered, 1);
  const filename = path.join(native.assetsDir, source.asset), original = await fs.readFile(filename); await fs.unlink(filename);
  try { await assert.rejects(edit(native, doc, 'load_layer_selection', { layerId: source.id }), cause => cause.code === 'INVALID_IMAGE' && !cause.message.includes(dataDir)); }
  finally { await fs.writeFile(filename, original); native.renderLayer = render; native.storeAsset = store; }
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await files(native.assetsDir), assets); assert.deepEqual(await files(native.projectsDir), projects); assert.deepEqual(native.previewCache.stats(), cache);
  const large = solid(8000, 3000, { transforms: [{ type: 'affine', width: 8000, height: 3000, x: 1, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }] }), largeDoc = await project(native, 8000, 3000, [large]);
  native.renderLayer = () => assert.fail('Memory refusal must precede raster allocation');
  try { await assert.rejects(edit(native, largeDoc, 'load_layer_selection', { layerId: large.id }), { code: 'LIMIT_EXCEEDED' }); }
  finally { native.renderLayer = render; }
  assert.deepEqual(await get(native, largeDoc), largeDoc);
  const complex = Buffer.from(Array.from({ length: 201_000 }, (_, i) => 1 + i % 2));
  await assert.rejects(encodeSelectionAlpha(complex, 1000, 201), { code: 'LIMIT_EXCEEDED' });
  const complexLayer = await raster(native, Buffer.from([...complex].flatMap(a => [19, 79, 167, a])), 1000, 201), complexDoc = await project(native, 1000, 201, [complexLayer]);
  const complexAssets = await files(native.assetsDir), complexProjects = await files(native.projectsDir);
  await assert.rejects(edit(native, complexDoc, 'apply_transaction', { label: 'Dense selection rollback', operations: [
    { command: 'set_layer', args: { layerId: complexLayer.id, name: 'Must not publish' } },
    { command: 'load_layer_selection', args: { layerId: complexLayer.id } },
    { command: 'set_layer', args: { layerId: randomUUID(), opacity: 0.5 } },
  ] }), { code: 'NOT_FOUND' });
  assert.deepEqual(await get(native, complexDoc), complexDoc); assert.deepEqual(await files(native.assetsDir), complexAssets); assert.deepEqual(await files(native.projectsDir), complexProjects);
  const directory = native.projectsDir; native.projectsDir = path.join(native.assetsDir, complexLayer.asset);
  try { await assert.rejects(edit(native, complexDoc, 'load_layer_selection', { layerId: complexLayer.id }), { code: 'ENOTDIR' }); }
  finally { native.projectsDir = directory; }
  assert.deepEqual(await get(native, complexDoc), complexDoc); assert.deepEqual(await files(native.assetsDir), complexAssets); assert.deepEqual(await files(native.projectsDir), complexProjects);
  const loaded = await edit(native, complexDoc, 'load_layer_selection', { layerId: complexLayer.id }), reference = authoredFrame(complex, 1000, 201);
  assert.equal(runCount(complex), 201_000); assert.deepEqual(loaded.selection, reference.descriptor);
  assert.deepEqual(await fs.readFile(path.join(native.assetsDir, loaded.selection.asset)), reference.bytes);
  assert.deepEqual(loaded.layers, complexDoc.layers);
});

test('bitmap feather combination matches established semantics and async sampling/encoding yields before completion', async () => {
  const width = 11, height = 7, pixels = Buffer.from(Array.from({ length: width * height }, (_, i) => [0, 1, 128, 255][i % 4]));
  for (const feather of [0.3, 1, 2.7]) for (const invert of [false, true]) {
    const active = { ...bitmap(pixels, width, height), feather, invert }, before = structuredClone(active);
    for (const mode of ['add', 'subtract', 'intersect']) assert.deepEqual(await combineSelectionAlpha(active, pixels, width, height, mode), combineSelections(active, bitmap(pixels, width, height), width, height, mode));
    assert.deepEqual(active, before); assert.deepEqual(pixels, Buffer.from(Array.from({ length: width * height }, (_, i) => [0, 1, 128, 255][i % 4])));
  }
  const alpha = Buffer.alloc(1024 * 1024, 128), before = Buffer.from(alpha); let beats = 0;
  const timer = setInterval(() => beats++, 1);
  try {
    const output = await encodeSelectionAlpha(alpha, 1024, 1024);
    assert.deepEqual(output.runs, [0, alpha.length, 128]); assert.ok(beats > 0, 'encoding yields before returning');
  } finally { clearInterval(timer); }
  assert.deepEqual(alpha, before);
});
