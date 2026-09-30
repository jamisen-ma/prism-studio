import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { ADJUSTMENTS, PARAMETERIZED_ADJUSTMENTS, COLOR_MAPPING_KINDS, normalizeParameters } from '../server/color.mjs';
import { normalizeSelectiveColorParameters, SELECTIVE_COLOR_POLICY, SELECTIVE_COLOR_METHODS, SELECTIVE_COLOR_RANGES } from '../server/selective-color.mjs';
import { applyLayerFilters, normalizeLayerFilter, LAYER_FILTER_KINDS, filterWork, layerFilterSpatialCacheBytes, layerFilterSharedBytes } from '../server/layer-filters.mjs';
import { LAYER_FILTER_BLEND_MODES, compileFilterBlend } from '../server/filter-blend.mjs';
import { estimateFilterBakeBytes } from '../server/filter-bake.mjs';
import { filterEntries } from '../server/filter-mask.mjs';
import { combineAlpha } from '../server/cutout-pixels.mjs';
import { normalizeEditRecipe } from '../server/edit-recipes.mjs';
import { selectiveColorReference } from './fixtures/selective-color/exact-reference.mjs';

const coded = code => error => error.code === code;
const parameters = { method: 'absolute', reds: [-8.13, 2.37, 10, -2], blacks: [8, 2, -8, 0], whites: [13.37, -20, 7, 0] };
const entry = (p = parameters, extra = {}) => ({ id: randomUUID(), kind: 'selective_color', value: 0, parameters: p, enabled: true, opacity: 1, ...extra });
const graphOf = (native, doc) => structuredClone(native.project(doc.id).states[native.project(doc.id).cursor].graph);
const edit = async (native, doc, command, args = {}) => (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document;
const pixels = (width, height) => { const output = Buffer.alloc(width * height * 4); for (let p = 0; p < width * height; p++) output.set([p % 256, (p * 37 + 29) % 256, (p * 101 + 40) % 256, [0, 1, 128, 255][p % 4]], p * 4); return output; };
const byte = x => Math.max(0, Math.min(255, Math.round(x)));
async function fixture(t, { alpha = false } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-selective-color-')), native = await new NativeBackend({ dataDir }).init();
  t.after(async () => { await native.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const width = 16, height = 16, input = pixels(width, height), png = await sharp(input, { raw: { width, height, channels: 4 } }).png().toBuffer();
  let doc = (await native.execute('import_image', { mimeType: 'image/png', data: png.toString('base64') })).document;
  const cutout = Buffer.from(Array.from({ length: width * height }, (_, p) => [0, 1, 128, 255, 191][p % 5]));
  if (alpha) { const graph = graphOf(native, doc); graph.layers[0].alphaAsset = await native.storeAlpha(cutout, width, height); doc = (await native.commit(native.project(doc.id), graph, 'Alpha fixture')).document; }
  return { native, doc, input, cutout, width, height, dataDir };
}
function sourceReference(input, entries) {
  const output = Buffer.from(input);
  for (const selected of entries) {
    if (!selected.enabled || selected.opacity === 0) continue;
    const blend = selected.blendMode ? compileFilterBlend(selected.blendMode, selected.opacity) : null;
    for (let i = 0; i < output.length; i += 4) if (output[i + 3]) {
      const original = [...output.subarray(i, i + 3)], candidate = selectiveColorReference(original, selected.parameters);
      output.set(blend ? blend(original, candidate) : original.map((c, j) => byte(c + (candidate[j] - c) * selected.opacity)), i);
    }
  }
  return output;
}

test('Selective Color global/source discovery, label and effective sparse updates are metadata-only', async t => {
  const { native, doc: initial } = await fixture(t); let doc = initial; const id = doc.layers[0].id;
  assert.equal(Object.keys(ADJUSTMENTS).length, 28); assert.equal(LAYER_FILTER_KINDS.length, 32);
  assert.ok(PARAMETERIZED_ADJUSTMENTS.includes('selective_color')); assert.ok(COLOR_MAPPING_KINDS.includes('selective_color'));
  assert.deepEqual(normalizeParameters('selective_color'), normalizeSelectiveColorParameters());
  const render = native.renderLayer, store = native.storeAsset; native.renderLayer = native.storeAsset = async () => { throw Error('Metadata touched pixels'); };
  try {
    doc = await edit(native, doc, 'add_layer_filter', { layerId: id, kind: 'selective_color', value: 0, parameters: { method: 'absolute', reds: [1, 2, 3, 4] } });
    const filterId = doc.layers[0].filters[0].id;
    doc = await edit(native, doc, 'update_layer_filter', { layerId: id, filterId, parameters: { blacks: [5, 6, 7, 8] } });
    assert.deepEqual(doc.layers[0].filters[0].parameters.reds, [1, 2, 3, 4]); assert.equal(doc.layers[0].filters[0].parameters.method, 'absolute');
    doc = await edit(native, doc, 'update_layer_filter', { layerId: id, filterId, parameters: { reds: [0, 0, 0, 0], method: 'relative' } });
    assert.deepEqual(doc.layers[0].filters[0].parameters.blacks, [5, 6, 7, 8]);
    doc = await edit(native, doc, 'add_adjustment', { kind: 'selective_color', value: 0, parameters: { whites: [1, 2, 3, 4] } });
    const adjustmentId = doc.layers.at(-1).id; assert.equal(doc.layers.at(-1).name, 'Selective Color');
    doc = await edit(native, doc, 'update_adjustment', { layerId: adjustmentId, parameters: { method: 'absolute' } });
    assert.deepEqual(doc.layers.at(-1).parameters.whites, [1, 2, 3, 4]);
    doc = await edit(native, doc, 'set_layer', { layerId: adjustmentId, name: 'Authored label' });
    doc = await edit(native, doc, 'update_adjustment', { layerId: adjustmentId, parameters: { neutrals: [-.01, .01, 0, 0] } });
    assert.equal(doc.layers.at(-1).name, 'Authored label');
  } finally { native.renderLayer = render; native.storeAsset = store; }
  const caps = await native.execute('capabilities'); assert.equal(caps.selectiveColorPolicy, SELECTIVE_COLOR_POLICY); assert.deepEqual(caps.selectiveColorMethods, SELECTIVE_COLOR_METHODS); assert.deepEqual(caps.selectiveColorRanges, SELECTIVE_COLOR_RANGES);
  assert.throws(() => normalizeLayerFilter(entry({}, { value: 1 })), coded('INVALID_ARGUMENT'));
});

test('byte candidates precede all 26 entry blends and the complete stack mask without changing source alpha or hidden RGB', async () => {
  const input = pixels(16, 16), immutable = Buffer.from(input);
  for (const blendMode of LAYER_FILTER_BLEND_MODES) {
    const selected = entry(parameters, { opacity: .625, blendMode });
    assert.deepEqual(await applyLayerFilters(input, 16, 16, [selected]), sourceReference(input, [selected]), blendMode);
  }
  const entries = [entry(parameters, { opacity: .625 }), entry({ reds: [10, -3, 7, -5] }, { opacity: .375, blendMode: 'screen' })];
  const graded = sourceReference(input, entries), runs = [];
  for (let p = 1; p < 256; p++) runs.push(p, 1, p);
  const stack = { version: 1, entries, mask: { sourceWidth: 16, sourceHeight: 16, coverage: { shape: 'bitmap', x: 0, y: 0, width: 16, height: 16, runs, feather: 0, invert: false }, density: .1, enabled: true } };
  const actual = await applyLayerFilters(input, 16, 16, stack), expected = Buffer.from(input);
  for (let p = 0; p < 256; p++) { const mask = Math.round(255 - .1 * (255 - p)); for (let c = 0; c < 3; c++) expected[p * 4 + c] = Math.floor((2 * (input[p * 4 + c] * (255 - mask) + graded[p * 4 + c] * mask) + 255) / 510); }
  assert.deepEqual(actual, expected); assert.deepEqual(input, immutable);
  for (const [blendMode, value] of [['multiply', 64], ['screen', 192], ['difference', 0]]) assert.deepEqual([...await applyLayerFilters(Buffer.from([128, 128, 128, 1, 21, 31, 41, 0]), 2, 1, [entry({}, { blendMode })])], [value, value, value, 1, 21, 31, 41, 0]);
});

test('global Selective Color preserves alpha/hidden RGB and protected bytes while retaining mask density and opacity order', async () => {
  const width = 16, height = 16, input = pixels(width, height), protectedPixels = Buffer.from(Array.from({ length: 256 }, (_, p) => p % 11 === 0 ? 255 : 0));
  const layer = { ...entry(parameters, { opacity: .5 }), mask: { shape: 'rectangle', x: 0, y: 0, width: 8, height: 16 }, maskDensity: .25 };
  const actual = await NativeBackend.prototype.applyAdjustment(input, width, height, layer, protectedPixels);
  for (let p = 0; p < 256; p++) { const i = p * 4, expected = selectiveColorReference([...input.subarray(i, i + 3)], parameters), amount = .5 * (p % 16 < 8 ? 1 : .75); assert.equal(actual[i + 3], input[i + 3]); for (let c = 0; c < 3; c++) assert.equal(actual[i + c], !input[i + 3] || protectedPixels[p] ? input[i + c] : byte(input[i + c] + (expected[c] - input[i + c]) * amount)); }
});

test('stable 12/1 work and zero cache use existing Bake phases; identity activation refuses before reads at cumulative boundaries', async t => {
  const identity = entry({}), computing = entry(), pixels = 16_000_000;
  assert.equal(filterWork(identity, pixels), pixels); assert.equal(filterWork(computing, pixels), 12 * pixels); assert.equal(filterWork({ ...computing, blendMode: 'multiply' }, pixels), 52 * pixels);
  assert.equal(filterWork({ ...identity, blendMode: 'screen' }, pixels), 41 * pixels); assert.equal(filterWork({ ...computing, enabled: false }, pixels), 0); assert.equal(filterWork({ ...computing, opacity: 0 }, pixels), 0);
  const cancellation = entry(Object.fromEntries(SELECTIVE_COLOR_RANGES.map(key => [key, [50, 50, 50, -50]]))); assert.equal(filterWork(cancellation, pixels), 12 * pixels);
  assert.equal(layerFilterSpatialCacheBytes([computing], 4000, 4000), 0); assert.equal(layerFilterSharedBytes([computing]), 0);
  const bake = { width: 2048, height: 2048, hasAlpha: true, encodedWorkingBytes: 500, encodedAlphaBytes: 500 }; const plain = { ...entry(), kind: 'brightness', value: 10, parameters: undefined };
  assert.deepEqual(estimateFilterBakeBytes({ ...bake, filters: [computing] }), estimateFilterBakeBytes({ ...bake, filters: [plain] }));
  const { native, doc: initial } = await fixture(t); const graph = graphOf(native, initial); graph.width = graph.height = graph.layers[0].width = graph.layers[0].height = 4000; graph.layers[0].transforms = []; graph.layers[0].filters = [computing, entry()]; native.validateGraph(graph);
  graph.layers[0].filters.push(plain); assert.throws(() => native.validateGraph(graph), coded('LIMIT_EXCEEDED'));
  graph.layers[0].filters = [computing, identity, plain]; const doc = (await native.commit(native.project(initial.id), graph, 'Metadata-only work fixture')).document;
  const before = JSON.stringify(native.project(doc.id)), open = fs.open, render = native.renderLayer, store = native.storeAsset;
  fs.open = native.renderLayer = native.storeAsset = async () => { throw Error('Over-budget operation touched I/O'); };
  try { await assert.rejects(edit(native, doc, 'update_layer_filter', { layerId: doc.layers[0].id, filterId: identity.id, parameters }), coded('LIMIT_EXCEEDED')); } finally { fs.open = open; native.renderLayer = render; native.storeAsset = store; }
  assert.equal(JSON.stringify(native.project(doc.id)), before);
});

test('complete recipe defaults reset global controls and append under an existing source mask with metadata-only validation and one Undo', async t => {
  const { native, doc: initial } = await fixture(t); let doc = initial; const sourceId = doc.layers[0].id;
  doc = await edit(native, doc, 'add_layer_filter', { layerId: sourceId, kind: 'selective_color', value: 0, parameters });
  doc = await edit(native, doc, 'set_layer_filter_mask', { layerId: sourceId, source: 'none' });
  doc = await edit(native, doc, 'add_adjustment', { kind: 'selective_color', value: 0, parameters }); const toneId = doc.layers.at(-1).id;
  const definition = normalizeEditRecipe({ id: randomUUID(), version: 1, name: 'Selective defaults', slots: [{ key: 'photo', type: 'raster' }, { key: 'tone', type: 'adjustment', kind: 'selective_color' }], steps: [{ command: 'add_layer_filter', target: 'photo', args: { kind: 'selective_color', value: 0, parameters: { reds: [1, 2, 3, 4] } } }, { command: 'update_adjustment', target: 'tone', args: { value: 0, parameters: {} } }] });
  assert.deepEqual(definition.steps[1].args.parameters, normalizeSelectiveColorParameters());
  const saved = await native.execute('save_edit_recipe', { documentId: doc.id, expectedRevision: doc.revision, name: definition.name, slots: definition.slots, steps: definition.steps }); doc = saved.document;
  const prior = structuredClone(doc.layers), mask = doc.layers[0].filterMask, render = native.renderLayer, store = native.storeAsset; native.renderLayer = native.storeAsset = async () => { throw Error('Recipe touched pixels'); };
  try { const before = JSON.stringify(native.project(doc.id)); assert.equal((await native.execute('validate_edit_recipe', { documentId: doc.id, expectedRevision: doc.revision, recipeId: saved.recipeId, bindings: { photo: sourceId, tone: toneId } })).valid, true); assert.equal(JSON.stringify(native.project(doc.id)), before); doc = (await native.execute('apply_edit_recipe', { documentId: doc.id, expectedRevision: doc.revision, recipeId: saved.recipeId, bindings: { photo: sourceId, tone: toneId } })).document; } finally { native.renderLayer = render; native.storeAsset = store; }
  assert.deepEqual(doc.layers.at(-1).parameters, normalizeSelectiveColorParameters()); assert.deepEqual(doc.layers[0].filterMask, mask); assert.equal(doc.layers[0].filters.length, 2); assert.deepEqual(doc.layers[0].filters[1].parameters.blacks, [0, 0, 0, 0]);
  doc = await edit(native, doc, 'undo'); assert.deepEqual(doc.layers, prior);
});

test('source filter mask and Distort Bake preserve exact raw working alpha, original assets, portable/restart and rollback', async t => {
  const { native, doc: initial, input, cutout, width, height, dataDir } = await fixture(t, { alpha: true }); let doc = initial; const sourceId = doc.layers[0].id, originalAsset = doc.layers[0].asset, original = await fs.readFile(path.join(native.assetsDir, originalAsset));
  for (const selected of [entry(parameters, { opacity: .625 }), entry({ reds: [10, -3, 7, -5] }, { opacity: .375, blendMode: 'screen' })]) doc = await edit(native, doc, 'add_layer_filter', { layerId: sourceId, kind: selected.kind, value: 0, parameters: selected.parameters, opacity: selected.opacity, blendMode: selected.blendMode });
  const runs = []; for (let p = 1; p < width * height; p++) runs.push(p, 1, p);
  doc = await edit(native, doc, 'set_layer_filter_mask', { layerId: sourceId, source: 'mask', mask: { shape: 'bitmap', width, height, runs } });
  doc = await edit(native, doc, 'modify_layer_filter_mask', { layerId: sourceId, density: .1 });
  doc = await edit(native, doc, 'add_layer_distort', { layerId: sourceId, corners: [{ x: .25, y: 0 }, { x: width + .25, y: 0 }, { x: width + .25, y: height }, { x: .25, y: height }] });
  const prior = structuredClone(doc.layers[0]), before = await native.renderGraph(graphOf(native, doc)), effective = combineAlpha(input, cutout), graded = sourceReference(effective, prior.filters), expected = Buffer.from(input);
  for (let p = 0; p < width * height; p++) { const mask = Math.round(255 - .1 * (255 - p)); for (let c = 0; c < 3; c++) expected[p * 4 + c] = Math.floor((2 * (effective[p * 4 + c] * (255 - mask) + graded[p * 4 + c] * mask) + 255) / 510); }
  const project = JSON.stringify(native.project(doc.id)), assets = await fs.readdir(native.assetsDir), directory = native.projectsDir;
  native.projectsDir = path.join(native.assetsDir, originalAsset); try { await assert.rejects(edit(native, doc, 'bake_layer_filters', { layerId: sourceId }), coded('ENOTDIR')); } finally { native.projectsDir = directory; }
  assert.equal(JSON.stringify(native.project(doc.id)), project); assert.deepEqual(await fs.readdir(native.assetsDir), assets);
  await assert.rejects(edit(native, doc, 'apply_transaction', { label: 'Selective rollback', operations: [{ command: 'bake_layer_filters', args: { layerId: sourceId } }, { command: 'paint_stroke', args: { tool: 'brush', layerId: sourceId, points: [{ x: 2.5, y: 1.5 }], size: 1, hardness: 1, opacity: 1, color: '#ff0033' } }, { command: 'delete_layer', args: { layerId: randomUUID() } }] }), coded('NOT_FOUND'));
  assert.equal(JSON.stringify(native.project(doc.id)), project); assert.deepEqual(await fs.readdir(native.assetsDir), assets);
  doc = await edit(native, doc, 'bake_layer_filters', { layerId: sourceId });
  assert.deepEqual(await native.renderGraph(graphOf(native, doc)), before); assert.deepEqual(doc.layers[0].transforms, prior.transforms); assert.equal(doc.layers[0].alphaAsset, prior.alphaAsset);
  const raw = await sharp(await fs.readFile(path.join(native.assetsDir, doc.layers[0].asset))).ensureAlpha().raw().toBuffer(); assert.deepEqual(raw, expected); assert.deepEqual(await fs.readFile(path.join(native.assetsDir, originalAsset)), original);
  doc = await edit(native, doc, 'undo'); const bundle = await native.exportProject({ documentId: doc.id }), copy = (await native.importProject({ data: bundle.data })).document;
  assert.deepEqual(copy.layers[0].filters, prior.filters); assert.deepEqual(await native.renderGraph(graphOf(native, copy)), before);
  const restarted = await new NativeBackend({ dataDir }).init(); try { assert.deepEqual(await restarted.renderGraph(graphOf(restarted, doc)), before); } finally { await restarted.close(); }
});

test('hidden malformed Selective metadata rejects before I/O and both wide pixel paths honor bounded yields', async t => {
  const { native, doc } = await fixture(t); const graph = graphOf(native, doc), open = fs.open; graph.layers[0].visible = false; graph.layers[0].filters = [entry({ method: 'future' }, { enabled: false, opacity: 0 })];
  fs.open = async () => { throw Error('Metadata touched files'); }; try { assert.throws(() => native.validateGraph(graph), coded('INVALID_ARGUMENT')); } finally { fs.open = open; }
  const width = 8192, height = 64, input = pixels(width, height), selected = entry(parameters, { opacity: .625 });
  const expected = Array.from({ length: 256 }, (_, p) => selectiveColorReference([p, (p * 37 + 29) % 256, (p * 101 + 40) % 256], parameters));
  for (const scope of ['source', 'global']) { let running = true, ticks = 0; const tick = () => { if (running) { ticks++; setImmediate(tick); } }; setImmediate(tick);
    try { const output = scope === 'source' ? await applyLayerFilters(input, width, height, [selected]) : await NativeBackend.prototype.applyAdjustment(input, width, height, selected);
      assert.ok(ticks >= 8, `${scope} batches yielded ${ticks}`); for (let i = 0; i < input.length; i++) assert.equal(output[i], i % 4 === 3 || !input[i - i % 4 + 3] ? input[i] : byte(input[i] + (expected[Math.floor(i / 4) % 256][i % 4] - input[i]) * .625));
    } finally { running = false; }
  }
});
