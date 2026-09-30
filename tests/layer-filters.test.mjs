import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { NativeBackend } from '../server/native.mjs';
import { applyLayerFilters, normalizeLayerFilter, editedFilterStack, LAYER_FILTER_KINDS, MAX_FILTER_WORK } from '../server/layer-filters.mjs';

const filter = (kind, value, extra = {}) => ({ id: randomUUID(), kind, value, enabled: true, opacity: 1, ...extra });
const coded = (code) => (cause) => cause.code === code;
const pixel = (pixels, x, y, width) => [...pixels.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
const edit = async (native, doc, command, args = {}) => (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document;
const current = async (native, doc) => (await native.execute('get_document', { documentId: doc.id })).document;
const find = (doc, id) => doc.layers.find((layer) => layer.id === id);
async function fixture(t, { width = 8, height = 6, raw, segmentSubject } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-layer-filter-'));
  const native = await new NativeBackend({ dataDir, segmentSubject }).init();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const pixels = raw ?? Buffer.alloc(width * height * 4);
  if (!raw) for (let i = 0; i < pixels.length; i += 4) pixels.set([20 + i % 120, 40 + i % 90, 70 + i % 110, 255], i);
  const png = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const doc = (await native.execute('import_image', { data: png.toString('base64'), mimeType: 'image/png' })).document;
  return { native, doc, dataDir, png, pixels };
}
const add = (native, doc, layerId, kind, value, extra = {}) => edit(native, doc, 'add_layer_filter', { layerId, kind, value, ...extra });

test('filter order, per-entry opacity and threshold zero have independent expected RGB while alpha and hidden RGB remain exact', async () => {
  const input = Buffer.from([30, 80, 150, 255, 80, 100, 220, 128, 240, 20, 60, 1, 211, 17, 29, 0]), original = Buffer.from(input);
  const a = filter('brightness', 20), b = filter('invert', 100, { opacity: 0.5 });
  const out = await applyLayerFilters(input, 4, 1, [a, b]);
  for (let p = 0; p < 4; p++) for (let c = 0; c < 4; c++) {
    const i = p * 4 + c, first = Math.min(255, input[i] + 51);
    assert.equal(out[i], c === 3 || input[p * 4 + 3] === 0 ? input[i] : Math.round(first + (255 - first * 2) * 0.5));
  }
  assert.notDeepEqual(await applyLayerFilters(input, 4, 1, [b, a]), out);
  const threshold = await applyLayerFilters(input, 4, 1, [filter('threshold', 0)]);
  for (let p = 0; p < 3; p++) assert.deepEqual(pixel(threshold, p, 0, 4), [255, 255, 255, input[p * 4 + 3]]);
  assert.deepEqual(threshold.subarray(12), input.subarray(12)); assert.deepEqual(input, original);
  assert.equal(await applyLayerFilters(input, 4, 1, []), input);
  assert.equal(await applyLayerFilters(input, 4, 1, [filter('invert', 100, { enabled: false }), filter('threshold', 0, { opacity: 0 })]), input);
});

test('levels and per-channel curves match explicit transfer functions and reject malformed or unsupported entries', async () => {
  const input = Buffer.from([0, 64, 255, 1, 64, 128, 192, 128]);
  const levels = filter('levels', 0, { parameters: { black: 0, white: 255, gamma: 2, outputBlack: 10, outputWhite: 210 } });
  const result = await applyLayerFilters(input, 2, 1, [levels]);
  for (let i = 0; i < input.length; i++) assert.equal(result[i], i % 4 === 3 ? input[i] : Math.round(10 + Math.sqrt(input[i] / 255) * 200));
  const curves = await applyLayerFilters(input, 2, 1, [filter('curves', 0, { parameters: { channel: 'green', points: [{ x: 0, y: 255 }, { x: 255, y: 0 }] } })]);
  assert.deepEqual(curves, Buffer.from([0, 191, 255, 1, 64, 127, 192, 128]));
  assert.equal(LAYER_FILTER_KINDS.length, 32);
  for (const entry of [filter('brightness', 101), filter('posterize', 2.5), filter('median', 2), filter('unknown_filter', 1), filter('levels', 0, { parameters: { black: 200, white: 100 } }), filter('invert', 20, { mask: null }), filter('invert', 20, { extra: 1 })]) assert.throws(() => normalizeLayerFilter(entry));
  const first = filter('brightness', 10), entries = [first, filter('invert', 100)], before = structuredClone(entries);
  assert.throws(() => editedFilterStack(entries, 'update_layer_filter', { filterId: first.id, value: 500 }));
  assert.throws(() => editedFilterStack(entries, 'update_layer_filter', { filterId: first.id }));
  assert.deepEqual(entries, before);
});

test('alpha-weighted mosaic and median ignore invisible red samples and preserve alpha-one fringes and input buffers', async () => {
  const input = Buffer.from([255, 0, 0, 0, 0, 0, 255, 1, 0, 255, 0, 128, 0, 0, 255, 255]), before = Buffer.from(input);
  const output = await applyLayerFilters(input, 4, 1, [filter('mosaic', 4)]);
  const green = Math.round(255 * 128 / 384), blue = Math.round(255 * 256 / 384);
  assert.deepEqual(pixel(output, 0, 0, 4), [255, 0, 0, 0]);
  for (let x = 1; x < 4; x++) assert.deepEqual(pixel(output, x, 0, 4), [0, green, blue, input[x * 4 + 3]]);
  const median = await applyLayerFilters(input, 4, 1, [filter('median', 3)]);
  assert.deepEqual(pixel(median, 0, 0, 4), [255, 0, 0, 0]);
  assert.deepEqual(pixel(median, 1, 0, 4), [0, 255, 0, 1]);
  assert.deepEqual(pixel(median, 2, 0, 4), [0, 0, 255, 128]);
  assert.deepEqual(input, before);
});

test('filter edits remain graph-only, independent through duplicates, undo, reopen and editable project transfer', async (t) => {
  const { native, dataDir, doc: initial, png } = await fixture(t); let doc = initial; const id = doc.layers[0].id;
  const originalView = await native.execute('get_layer_preview', { documentId: doc.id, layerId: id, view: 'source' });
  const assets = await fs.readdir(path.join(dataDir, 'assets'));
  doc = await add(native, doc, id, 'brightness', 20); const brightness = find(doc, id).filters[0].id;
  doc = await add(native, doc, id, 'invert', 100); const inverted = await native.renderGraph(doc);
  doc = await edit(native, doc, 'reorder_layer_filter', { layerId: id, filterId: brightness, index: 1 }); const reordered = await native.renderGraph(doc);
  assert.notDeepEqual(reordered, inverted);
  doc = await edit(native, doc, 'undo'); assert.deepEqual(await native.renderGraph(doc), inverted);
  doc = await edit(native, doc, 'redo'); assert.deepEqual(await native.renderGraph(doc), reordered);
  doc = await edit(native, doc, 'duplicate_layer', { layerId: id }); const copy = doc.layers.at(-1).id;
  assert.deepEqual(find(doc, copy).filters, find(doc, id).filters);
  doc = await edit(native, doc, 'update_layer_filter', { layerId: copy, filterId: brightness, value: 40 });
  assert.equal(find(doc, id).filters.find((entry) => entry.id === brightness).value, 20);
  doc = await edit(native, doc, 'delete_layer_filter', { layerId: copy, filterId: brightness }); assert.equal(find(doc, copy).filters.length, 1);
  const source = await native.execute('get_layer_preview', { documentId: doc.id, layerId: id, view: 'source' }); assert.equal(source.data, originalView.data);
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'assets')), assets); assert.deepEqual(await fs.readFile(path.join(dataDir, 'assets', find(doc, id).sourceAsset)), png);
  const reopened = await new NativeBackend({ dataDir }).init(); assert.equal(reopened.loadWarnings.length, 0); assert.deepEqual(await current(reopened, doc), doc);
  const bundle = await native.exportProject({ documentId: doc.id }), imported = (await reopened.importProject({ data: bundle.data })).document;
  assert.deepEqual(imported.layers, doc.layers); assert.deepEqual(await reopened.renderGraph(imported), await native.renderGraph(doc));
});

test('filters use source pixels before geometry while masks, opacity, outside effects and groups remain separate', async (t) => {
  const { native, doc: initial } = await fixture(t, { width: 6, height: 4 }); let doc = initial; const id = doc.layers[0].id;
  doc = await add(native, doc, id, 'mosaic', 2);
  const stack = structuredClone(find(doc, id).filters);
  const filteredSource = await native.renderLayer(find(doc, id));
  doc = await edit(native, doc, 'transform_layer', { layerId: id, x: 1, y: 1 });
  const shifted = await native.renderLayer(find(doc, id));
  for (let y = 0; y < 3; y++) for (let x = 0; x < 5; x++) assert.deepEqual(pixel(shifted, x + 1, y + 1, 6), pixel(filteredSource, x, y, 6));
  doc = await edit(native, doc, 'set_layer_mask', { layerId: id, mask: { x: 1, y: 1, width: 2, height: 2 } });
  doc = await edit(native, doc, 'set_layer', { layerId: id, opacity: 0.5 });
  doc = await edit(native, doc, 'set_layer_effects', { layerId: id, effects: { shadow: { blur: 0, x: 2, y: 0, opacity: 1 } } });
  doc = await edit(native, doc, 'group_layers', { layerIds: [id] }); const group = doc.layers.find((layer) => layer.type === 'group').id;
  doc = await edit(native, doc, 'set_layer', { layerId: group, opacity: 0.5 });
  const rendered = await native.renderGraph(doc);
  assert.deepEqual(pixel(rendered, 1, 1, 6), [...pixel(filteredSource, 0, 0, 6).slice(0, 3), 64]);
  assert.deepEqual(pixel(rendered, 3, 1, 6), [0, 0, 0, 64]);
  assert.deepEqual(find(doc, id).filters, stack);
});

test('contextual RGB restoration protects lower content through transformed filters and isolated group/leaf previews', async (t) => {
  const { native, doc: initial } = await fixture(t); let doc = initial;
  doc = await edit(native, doc, 'set_layer_protection', { layerId: doc.layers[0].id, protected: true });
  doc = await edit(native, doc, 'set_layer_mask', { layerId: doc.layers[0].id, mask: { x: 0, y: 0, width: 3, height: 6 } });
  doc = await edit(native, doc, 'add_paint_layer'); const id = doc.layers.at(-1).id;
  doc = await edit(native, doc, 'fill_area', { layerId: id, color: '#204060' });
  // Existing protected-aware fill leaves a hole; make an independent unprotected
  // source layer so this fixture compares the same pre-filter upper appearance.
  doc = await edit(native, doc, 'duplicate_layer', { layerId: initial.layers[0].id }); const upper = doc.layers[1].id;
  doc = await edit(native, doc, 'set_layer_protection', { layerId: upper, protected: false });
  doc = await edit(native, doc, 'set_layer_mask', { layerId: upper, mask: null });
  doc = await edit(native, doc, 'transform_layer', { layerId: upper, x: 1, y: 0 });
  const before = await native.renderGraph(doc), sourceBefore = await native.renderLayer(find(doc, upper));
  doc = await add(native, doc, upper, 'invert', 100);
  doc = await edit(native, doc, 'group_layers', { layerIds: [upper] }); const group = doc.layers.find((layer) => layer.type === 'group').id;
  const after = await native.renderGraph(doc);
  for (let y = 0; y < doc.height; y++) for (let x = 0; x < 3; x++) assert.deepEqual(pixel(after, x, y, doc.width), pixel(before, x, y, doc.width));
  for (const layerId of [upper, group]) {
    const preview = await native.execute('get_layer_preview', { documentId: doc.id, layerId });
    const pixels = await sharp(Buffer.from(preview.data, 'base64')).raw().toBuffer();
    for (let y = 0; y < doc.height; y++) for (let x = 1; x < 3; x++) assert.deepEqual(pixel(pixels, x, y, doc.width), pixel(sourceBefore, x, y, doc.width));
    assert.deepEqual(pixel(pixels, 4, 2, doc.width).slice(0, 3), pixel(sourceBefore, 4, 2, doc.width).slice(0, 3).map((channel) => 255 - channel));
  }
});

test('filtered backgrounds below soft protected cutouts remain editable rather than creating holes or global exclusions', async (t) => {
  const raw = Buffer.from([20, 40, 60, 255, 20, 40, 60, 255]);
  const { native, doc: initial } = await fixture(t, { width: 2, height: 1, raw }); let doc = initial; const background = doc.layers[0].id;
  doc = await edit(native, doc, 'add_shape', { shape: 'rectangle', x: 0, y: 0, width: 1, height: 1, fill: '#ff0000' }); const person = doc.layers.at(-1).id;
  doc = await edit(native, doc, 'set_layer', { layerId: person, opacity: 0.5 });
  doc = await edit(native, doc, 'set_layer_protection', { layerId: person, protected: true });
  doc = await add(native, doc, background, 'invert', 100);
  const output = await native.renderGraph(doc); assert.deepEqual(pixel(output, 1, 0, 2), [235, 215, 195, 255]);
  assert.deepEqual(pixel(output, 0, 0, 2), [245, 108, 98, 255]);
});

test('active/bypassed protection rules and every source-writing guard preserve revision, assets and rendered appearance', async (t) => {
  const width = 8, height = 6;
  const { native, doc: initial, dataDir } = await fixture(t, { segmentSubject: async () => ({ alpha: Buffer.alloc(width * height, 255), width, height, model: 'test' }) });
  let doc = await edit(native, initial, 'extract_subject', { layerId: initial.layers[0].id, protect: false }); const id = doc.layers.at(-1).id;
  doc = await edit(native, doc, 'select_rectangle', { x: 0, y: 0, width: 4, height: 4 });
  doc = await add(native, doc, id, 'brightness', 0); const entry = find(doc, id).filters[0].id;
  await assert.rejects(edit(native, doc, 'set_layer_protection', { layerId: id, protected: true }), coded('PROTECTED_LAYER'));
  doc = await edit(native, doc, 'update_layer_filter', { layerId: id, filterId: entry, enabled: false });
  const file = path.join(dataDir, 'projects', `${doc.id}.json`), bytes = await fs.readFile(file), assets = await fs.readdir(path.join(dataDir, 'assets')), before = await native.renderGraph(doc);
  for (const [command, args] of [
    ['paint_stroke', { layerId: id, tool: 'brush', color: '#ffffff', size: 2, points: [{ x: 1, y: 1 }] }],
    ['fill_area', { layerId: id, color: '#ffffff' }], ['extract_subject', { layerId: id }],
    ['paint_cutout_mask', { layerId: id, points: [{ x: 1, y: 1 }], size: 2 }], ['refine_cutout_from_selection', { layerId: id }],
    ['place_layer', { sourceDocumentId: doc.id, sourceLayerId: id, x: 0, y: 0, width, height }],
  ]) await assert.rejects(edit(native, doc, command, args), coded('FILTER_STACK_ACTIVE'));
  assert.deepEqual(await current(native, doc), doc); assert.deepEqual(await fs.readFile(file), bytes); assert.deepEqual(await fs.readdir(path.join(dataDir, 'assets')), assets); assert.deepEqual(await native.renderGraph(doc), before);
  doc = await edit(native, doc, 'set_layer_protection', { layerId: id, protected: true });
  for (const [command, args] of [['add_layer_filter', { kind: 'invert', value: 100 }], ['update_layer_filter', { filterId: entry, enabled: true }], ['reorder_layer_filter', { filterId: entry, index: 0 }], ['delete_layer_filter', { filterId: entry }], ['clear_layer_filters', {}]]) await assert.rejects(edit(native, doc, command, { layerId: id, ...args }), coded('PROTECTED_LAYER'));
  doc = await edit(native, doc, 'set_layer_protection', { layerId: id, protected: false }); doc = await edit(native, doc, 'clear_layer_filters', { layerId: id });
  doc = await edit(native, doc, 'paint_cutout_mask', { layerId: id, points: [{ x: 1, y: 1 }], size: 2, mode: 'subtract' });
  assert.deepEqual(find(doc, id).filters, []);
});

test('entry counts, invalid mutations and transactions reject before committing; default capabilities state real limits', async (t) => {
  const { native, doc: initial } = await fixture(t); let doc = initial; const id = doc.layers[0].id;
  const caps = await native.execute('capabilities', {}); assert.equal(caps.layerFilterKinds.length, 32); assert.equal(caps.layerFilterCoordinates, 'source'); assert.equal(caps.limits.maxFilterWork, MAX_FILTER_WORK);
  for (let i = 0; i < 8; i++) doc = await add(native, doc, id, 'invert', 100, { enabled: false });
  await assert.rejects(add(native, doc, id, 'invert', 50), coded('LIMIT_EXCEEDED'));
  const before = doc;
  await assert.rejects(edit(native, doc, 'apply_transaction', { operations: [
    { command: 'clear_layer_filters', args: { layerId: id } }, { command: 'add_layer_filter', args: { layerId: id, kind: 'median', value: 2 } },
  ] }), coded('INVALID_ARGUMENT'));
  assert.deepEqual(await current(native, doc), before);
  for (let i = 1; i < 8; i++) doc = await edit(native, doc, 'duplicate_layer', { layerId: id });
  const full = doc; await assert.rejects(edit(native, doc, 'duplicate_layer', { layerId: id }), coded('LIMIT_EXCEEDED')); assert.deepEqual(await current(native, doc), full);
});

test('hidden workload and combined ancestor/filter scratch reject before rendering or disk writes', async (t) => {
  const { native, doc: initial, dataDir } = await fixture(t); const id = initial.layers[0].id;
  let graph = { name: 'Large metadata fixture', width: 4000, height: 4000, selection: null, layers: [{ ...initial.layers[0], width: 4000, height: 4000, filters: [] }] };
  const project = await native.newProject(graph, 'Metadata-only resource fixture'); let doc = project.document;
  doc = await edit(native, doc, 'set_layer', { layerId: id, visible: false });
  const file = path.join(dataDir, 'projects', `${doc.id}.json`), bytes = await fs.readFile(file), assets = await fs.readdir(path.join(dataDir, 'assets'));
  await assert.rejects(add(native, doc, id, 'median', 15), coded('LIMIT_EXCEEDED'));
  assert.deepEqual(await current(native, doc), doc); assert.deepEqual(await fs.readFile(file), bytes); assert.deepEqual(await fs.readdir(path.join(dataDir, 'assets')), assets);
  doc = await add(native, doc, id, 'invert', 100);
  doc = await edit(native, doc, 'group_layers', { layerIds: [id] }); const inner = doc.layers.find((layer) => layer.type === 'group').id;
  doc = await edit(native, doc, 'set_layer', { layerId: inner, opacity: 0.5 });
  doc = await edit(native, doc, 'group_layers', { layerIds: [inner] }); const outer = doc.layers.find((layer) => layer.type === 'group' && layer.id !== inner).id;
  const before = doc; await assert.rejects(edit(native, doc, 'set_layer', { layerId: outer, opacity: 0.5 }), coded('LIMIT_EXCEEDED')); assert.deepEqual(await current(native, doc), before);
});

test('malformed persisted stacks are rejected without rewriting the project or any original assets', async (t) => {
  const { native, doc: initial, dataDir } = await fixture(t); const id = initial.layers[0].id;
  const doc = await add(native, initial, id, 'brightness', 20), file = path.join(dataDir, 'projects', `${doc.id}.json`), valid = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const change of [
    (entry) => { entry.mask = null; }, (entry) => { entry.enabled = 'yes'; }, (entry) => { entry.value = Infinity; }, (entry) => { entry.kind = 'unknown_filter'; },
  ]) {
    const corrupt = structuredClone(valid); change(corrupt.states.at(-1).graph.layers[0].filters[0]); const bytes = JSON.stringify(corrupt); await fs.writeFile(file, bytes);
    const reopened = await new NativeBackend({ dataDir }).init(); assert.equal(reopened.projects.has(doc.id), false); assert.equal(reopened.loadWarnings.length, 1); assert.equal(await fs.readFile(file, 'utf8'), bytes);
  }
});

test('explicit subject selection sees unfiltered working pixels while raw source and cutout-alpha views remain unchanged', async (t) => {
  const width = 8, height = 6, calls = [];
  const { native, doc: initial } = await fixture(t, { segmentSubject: async (input) => {
    calls.push(await sharp(input).ensureAlpha().raw().toBuffer());
    return { alpha: Buffer.alloc(width * height, 255), width, height, model: 'test' };
  } });
  let doc = await edit(native, initial, 'extract_subject', { layerId: initial.layers[0].id, protect: false }); const id = doc.layers.at(-1).id;
  const unfiltered = await native.visibleLayerPixels(doc, find(doc, id));
  const maskBefore = await native.execute('get_layer_preview', { documentId: doc.id, layerId: id, view: 'mask' });
  const sourceBefore = await native.execute('get_layer_preview', { documentId: doc.id, layerId: id, view: 'source' });
  doc = await add(native, doc, id, 'invert', 100);
  doc = await edit(native, doc, 'select_subject', { layerId: id }); assert.deepEqual(calls.at(-1), unfiltered);
  assert.equal((await native.execute('get_layer_preview', { documentId: doc.id, layerId: id, view: 'mask' })).data, maskBefore.data);
  assert.equal((await native.execute('get_layer_preview', { documentId: doc.id, layerId: id, view: 'source' })).data, sourceBefore.data);
  doc = await edit(native, doc, 'select_subject'); assert.notDeepEqual(calls.at(-1), unfiltered, 'composite subject selection still observes the visible document');
});
