import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { applyStroke } from '../server/retouch.mjs';
import { bitmapMask } from '../server/masks.mjs';
import { frozenRetouchSample, normalizeRetouchSampling } from '../server/retouch-sampling.mjs';

const coded = code => cause => cause.code === code;
const edit = async (native, doc, command, args = {}) => (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document;
const get = async (native, doc) => (await native.execute('get_document', { documentId: doc.id })).document;
const graphOf = (native, doc) => { const project = native.project(doc.id); return structuredClone(project.states[project.cursor].graph); };
const rgba = (width, height, pixel) => { const data = Buffer.alloc(width * height * 4); for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(typeof pixel === 'function' ? pixel(x, y) : pixel, (y * width + x) * 4); return data; };
const pixel = (data, width, x, y) => [...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
const png = (data, width, height) => sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
const stroke = { tool: 'clone', points: [{ x: 5.5, y: 2.5 }], source: { x: 1.5, y: 2.5 }, size: 1, hardness: 1, opacity: 1 };
async function fixture(t, width = 8, height = 5) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-sampling-'));
  const native = await new NativeBackend({ dataDir }).init();
  t.after(async () => { await native.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const pixels = rgba(width, height, (x, y) => [20 + x * 9, 40 + y * 7, 80 + x, 255]);
  const original = await png(pixels, width, height);
  const doc = (await native.execute('import_image', { data: original.toString('base64'), mimeType: 'image/png', name: 'Repair fixture' })).document;
  return { native, doc, dataDir, original, pixels };
}
async function paintLayer(native, doc, color, name = 'Overlay') {
  doc = await edit(native, doc, 'add_paint_layer', { name });
  return edit(native, doc, 'fill_area', { layerId: doc.layers.at(-1).id, color, opacity: 1 });
}

test('current sampling aliases frozen pixels without an extra full-frame buffer and produces the same overlapping clone/heal result as an owned copy', async () => {
  const width = 8, height = 5, pixels = rgba(width, height, (x, y) => [x * 20, y * 40, 30 + x + y, [0, 1, 128, 255][x % 4]]), original = Buffer.from(pixels);
  let renders = 0;
  const sample = frozenRetouchSample(pixels, normalizeRetouchSampling({ tool: 'clone', sampleMode: 'current' }), () => { renders++; });
  assert.equal(sample, pixels); assert.equal(renders, 0);
  for (const tool of ['clone', 'heal']) {
    const args = { ...stroke, tool, pixels, width, height, size: 3, points: [{ x: 2.5, y: 2.5 }, { x: 6.5, y: 2.5 }], source: { x: 1.5, y: 2.5 } };
    assert.deepEqual(applyStroke({ ...args, composite: sample }), applyStroke({ ...args, composite: Buffer.from(pixels) }));
    assert.deepEqual(pixels, original);
  }
});

test('legacy clone and heal default source pixels equal explicit all/false and independent frozen kernel', async t => {
  for (const tool of ['clone', 'heal']) {
    const { native, doc: start } = await fixture(t); const id = start.layers[0].id;
    let doc = await paintLayer(native, start, '#4f7742');
    const graph = graphOf(native, doc), target = await native.renderLayer(graph.layers[0]), composite = await native.renderGraph(graph);
    const args = { ...stroke, tool, layerId: id, size: 3, points: [{ x: 4.5, y: 2.5 }, { x: 6.5, y: 2.5 }] };
    const expected = applyStroke({ ...args, pixels: target, composite, width: doc.width, height: doc.height });
    doc = await edit(native, doc, 'paint_stroke', args);
    assert.deepEqual(await native.renderLayer(doc.layers[0]), expected);
    doc = await edit(native, doc, 'undo');
    doc = await edit(native, doc, 'paint_stroke', { ...args, sampleMode: 'all', ignoreAdjustments: false });
    assert.deepEqual(await native.renderLayer(doc.layers[0]), expected);
  }
});

test('current reads frozen working/source alpha with geometry while ignoring display settings and never renders composite', async t => {
  const { native, doc: start, original } = await fixture(t); const id = start.layers[0].id;
  const graph = graphOf(native, start), source = graph.layers[0];
  const alpha = Buffer.from(Array.from({ length: graph.width * graph.height }, (_, i) => [0, 1, 128, 255][i % 4]));
  source.alphaAsset = await native.storeAsset(await sharp(alpha, { raw: { width: graph.width, height: graph.height, channels: 1 } }).png().toBuffer());
  source.visible = false; source.opacity = 0; source.mask = { shape: 'rectangle', x: 0, y: 0, width: 1, height: 1, feather: 0, invert: false };
  source.effects = { shadow: { color: '#ff0000', opacity: 1, blur: 0, x: 2, y: 0 } };
  let doc = (await native.commit(native.project(start.id), graph, 'Source fixture')).document;
  doc = await edit(native, doc, 'transform_layer', { layerId: id, x: 1, y: 0 });
  const frozen = await native.renderLayer(doc.layers[0]);
  const args = { ...stroke, tool: 'heal', size: 3, source: { x: 3.5, y: 2.5 }, layerId: id, sampleMode: 'current' };
  const expected = applyStroke({ ...args, pixels: frozen, composite: frozen, width: doc.width, height: doc.height });
  let rendered = 0; const previous = native.renderGraph; native.renderGraph = async () => { rendered++; throw new Error('current must not composite'); };
  doc = await edit(native, doc, 'paint_stroke', args); native.renderGraph = previous;
  assert.equal(rendered, 0); assert.deepEqual(await native.renderLayer(doc.layers[0]), expected);
  assert.equal(doc.layers[0].alphaAsset, undefined); assert.deepEqual(doc.layers[0].transforms, []);
  assert.equal(doc.layers[0].mask.width, 1); assert.equal(doc.layers[0].opacity, 0); assert.equal(doc.layers[0].visible, false);
  assert.deepEqual(await fs.readFile(path.join(native.assetsDir, doc.layers[0].sourceAsset)), original);
});

test('current-and-below stops at hidden and zero-opacity roots and retains existing repair pixels', async t => {
  const { native, doc: start } = await fixture(t); const sourceId = start.layers[0].id;
  let response = await native.execute('create_repair_layer', { documentId: start.id, expectedRevision: start.revision, sourceLayerId: sourceId });
  let doc = response.document; const id = response.layerId;
  doc = await edit(native, doc, 'paint_stroke', { tool: 'brush', layerId: id, points: [{ x: 1.5, y: 2.5 }], size: 1, hardness: 1, opacity: 1, color: '#ee6611' });
  doc = await paintLayer(native, doc, '#0000ff');
  for (const settings of [{ visible: true, opacity: 1 }, { visible: false, opacity: 1 }, { visible: true, opacity: 0 }]) {
    const graph = graphOf(native, doc), layer = graph.layers.find(layer => layer.id === id); Object.assign(layer, settings);
    const sample = await native.renderGraph(graph, { stopAfterRootId: id });
    assert.deepEqual(pixel(sample, graph.width, 1, 2), settings.visible && settings.opacity ? [238, 102, 17, 255] : [29, 54, 81, 255]);
    assert.deepEqual(pixel(sample, graph.width, 5, 2), [65, 54, 85, 255]);
  }
  doc = await edit(native, doc, 'paint_stroke', { ...stroke, layerId: id, sampleMode: 'current-and-below' });
  assert.deepEqual(pixel(await native.renderLayer(doc.layers.find(layer => layer.id === id)), doc.width, 5, 2), [238, 102, 17, 255]);
});

test('ignore adjustments prevents double grading while sampled source raster filters remain enabled', async t => {
  const { native, doc: start } = await fixture(t); const sourceId = start.layers[0].id;
  let doc = await edit(native, start, 'add_layer_filter', { layerId: sourceId, kind: 'invert', value: 100 });
  doc = await edit(native, doc, 'add_adjustment', { kind: 'invert', value: 100 });
  const created = await native.execute('create_repair_layer', { documentId: doc.id, expectedRevision: doc.revision, sourceLayerId: sourceId }); doc = created.document; const id = created.layerId;
  doc = await edit(native, doc, 'paint_stroke', { ...stroke, layerId: id, sampleMode: 'all', ignoreAdjustments: true });
  assert.deepEqual(pixel(await native.renderLayer(doc.layers.find(layer => layer.id === id)), doc.width, 5, 2), [226, 201, 174, 255]);
  assert.deepEqual(pixel(await native.render(native.project(doc.id)), doc.width, 5, 2), [29, 54, 81, 255]);
  assert.equal(doc.layers[0].filters[0].kind, 'invert');
});

test('readonly prefix preserves complete lower isolated groups and clipping chains, with nested adjustments skipped only when requested', async t => {
  const { native, doc: start } = await fixture(t); let doc = start;
  doc = await paintLayer(native, doc, '#223355', 'Clip base'); const base = doc.layers.at(-1).id;
  doc = await paintLayer(native, doc, '#996633', 'Clip member'); const member = doc.layers.at(-1).id;
  doc = await edit(native, doc, 'set_clipping_chain', { baseLayerId: base, layerIds: [member] });
  doc = await edit(native, doc, 'group_layers', { layerIds: [base, member], name: 'Lower isolated' }); const group = doc.layers.find(layer => layer.type === 'group').id;
  doc = await edit(native, doc, 'set_group_compositing', { layerId: group, mode: 'isolated', blendMode: 'multiply' });
  doc = await edit(native, doc, 'add_adjustment', { kind: 'invert', value: 100 }); const adjustment = doc.layers.at(-1).id;
  doc = await edit(native, doc, 'move_layer', { layerId: adjustment, parentId: group, index: 2 });
  doc = await edit(native, doc, 'add_paint_layer', { name: 'Target' }); const id = doc.layers.at(-1).id;
  const beforeUpper = await native.renderGraph(graphOf(native, doc));
  const noAdjustGraph = graphOf(native, doc); noAdjustGraph.layers.find(layer => layer.id === adjustment).visible = false;
  const noAdjustment = await native.renderGraph(noAdjustGraph);
  doc = await paintLayer(native, doc, '#ffffff'); const graph = graphOf(native, doc);
  assert.deepEqual(await native.renderGraph(graph, { stopAfterRootId: id }), beforeUpper);
  assert.deepEqual(await native.renderGraph(graph, { stopAfterRootId: id, ignoreAdjustments: true }), noAdjustment);
  assert.notDeepEqual(beforeUpper, noAdjustment);
});

test('scoped sampling never weakens complete-document protection and explicit empty selection paints nothing', async t => {
  const { native, doc: start } = await fixture(t); const sourceId = start.layers[0].id;
  const created = await native.execute('create_repair_layer', { documentId: start.id, sourceLayerId: sourceId }); let doc = created.document; const id = created.layerId;
  doc = await paintLayer(native, doc, '#abcdef'); const protectedId = doc.layers.at(-1).id;
  doc = await edit(native, doc, 'set_layer_mask', { layerId: protectedId, mask: { shape: 'rectangle', x: 5, y: 2, width: 1, height: 1 } });
  doc = await edit(native, doc, 'set_layer_protection', { layerId: protectedId, protected: true });
  doc = await edit(native, doc, 'paint_stroke', { ...stroke, layerId: id, sampleMode: 'current-and-below', ignoreAdjustments: true });
  assert.deepEqual(pixel(await native.renderLayer(doc.layers.find(layer => layer.id === id)), doc.width, 5, 2), [0, 0, 0, 0]);
  const graph = graphOf(native, doc); graph.selection = bitmapMask(Buffer.alloc(graph.width * graph.height), graph.width, graph.height);
  doc = (await native.commit(native.project(doc.id), graph, 'Empty selection')).document;
  const before = await native.renderLayer(doc.layers.find(layer => layer.id === id));
  doc = await edit(native, doc, 'paint_stroke', { ...stroke, points: [{ x: 3.5, y: 2.5 }], layerId: id, sampleMode: 'current-and-below' });
  assert.deepEqual(await native.renderLayer(doc.layers.find(layer => layer.id === id)), before);
});

test('repair creation and first stroke compose one undoable transaction with portable independent sources', async t => {
  const { native, doc: start, dataDir, original } = await fixture(t); const sourceId = start.layers[0].id, newLayerId = randomUUID();
  let doc = await edit(native, start, 'add_adjustment', { kind: 'brightness', value: 10 });
  const prior = doc, before = await native.render(native.project(doc.id));
  doc = await edit(native, doc, 'apply_transaction', { label: 'Repair original', operations: [
    { command: 'create_repair_layer', args: { sourceLayerId: sourceId, newLayerId, name: 'Repair' } },
    { command: 'paint_stroke', args: { ...stroke, layerId: newLayerId, sampleMode: 'current-and-below', ignoreAdjustments: true } },
  ] });
  assert.equal(doc.revision, prior.revision + 1); assert.equal(doc.layers[1].id, newLayerId); assert.equal(doc.layers[2].type, 'adjustment');
  const layer = doc.layers[1]; assert.equal(layer.role, 'paint'); assert.equal(layer.blendMode, 'normal'); assert.equal(layer.protected, undefined); assert.equal(layer.provenance, undefined);
  assert.notEqual(layer.asset, layer.sourceAsset); const result = await native.render(native.project(doc.id));
  doc = await edit(native, doc, 'undo'); assert.equal(doc.layers.length, prior.layers.length); assert.deepEqual(await native.render(native.project(doc.id)), before);
  doc = await edit(native, doc, 'redo'); assert.deepEqual(await native.render(native.project(doc.id)), result);
  const bundle = await native.exportProject({ documentId: doc.id }), copy = (await native.importProject({ data: bundle.data })).document;
  assert.deepEqual(copy.layers, doc.layers); assert.deepEqual(await native.render(native.project(copy.id)), result);
  const reopened = await new NativeBackend({ dataDir }).init(); t.after(() => reopened.close()); assert.deepEqual((await get(reopened, doc)).layers, doc.layers);
  assert.deepEqual(await fs.readFile(path.join(native.assetsDir, doc.layers[0].sourceAsset)), original);
});

test('repair creation validates scope and UUID before bytes and preserves ordinary source metadata', async t => {
  const { native, doc: start } = await fixture(t); const sourceId = start.layers[0].id;
  let doc = await edit(native, start, 'set_layer_protection', { layerId: sourceId, protected: true });
  doc = await edit(native, doc, 'set_layer', { layerId: sourceId, visible: false });
  const before = structuredClone(doc.layers[0]), files = await fs.readdir(native.assetsDir);
  for (const newLayerId of [sourceId, 'x'.repeat(36), '00000000-0000-9000-0000-000000000000', randomUUID().toUpperCase()])
    await assert.rejects(edit(native, doc, 'create_repair_layer', { sourceLayerId: sourceId, newLayerId }), coded('INVALID_ARGUMENT'));
  assert.deepEqual(await fs.readdir(native.assetsDir), files); assert.deepEqual(await get(native, doc), doc);
  const created = await native.execute('create_repair_layer', { documentId: doc.id, sourceLayerId: sourceId }); doc = created.document;
  assert.deepEqual(doc.layers[0], before); assert.equal(doc.layers[1].visible, true); assert.equal(doc.layers[1].protected, undefined); assert.equal(created.layerId, doc.layers[1].id);
  doc = await edit(native, doc, 'group_layers', { layerIds: [created.layerId], name: 'Nested' });
  await assert.rejects(edit(native, doc, 'create_repair_layer', { sourceLayerId: created.layerId }), coded('INVALID_TARGET'));
});

test('invalid sampling combinations and unsupported cutoffs fail before any source render or asset write', async t => {
  const { native, doc: start } = await fixture(t); const id = start.layers[0].id; let doc = start;
  const previousRender = native.renderLayer, previousStore = native.storeAsset;
  let reads = 0, writes = 0; native.renderLayer = async () => { reads++; throw new Error('unexpected render'); }; native.storeAsset = async () => { writes++; throw new Error('unexpected write'); };
  for (const args of [{ tool: 'brush', sampleMode: 'all' }, { tool: 'eraser', ignoreAdjustments: false }, { sampleMode: 'invalid' }, { ignoreAdjustments: 'yes' }, { sampleMode: 'current', ignoreAdjustments: true }])
    await assert.rejects(edit(native, doc, 'paint_stroke', { ...stroke, layerId: id, ...args }), coded('INVALID_ARGUMENT'));
  assert.equal(reads, 0); assert.equal(writes, 0); native.renderLayer = previousRender; native.storeAsset = previousStore;
  doc = await edit(native, doc, 'group_layers', { layerIds: [id], name: 'Group' });
  await assert.rejects(edit(native, doc, 'paint_stroke', { ...stroke, layerId: id, sampleMode: 'current-and-below' }), coded('INVALID_TARGET'));
  doc = await edit(native, doc, 'add_layer_filter', { layerId: id, kind: 'invert', value: 100, enabled: false });
  await assert.rejects(edit(native, doc, 'paint_stroke', { ...stroke, layerId: id, sampleMode: 'current' }), coded('FILTER_STACK_ACTIVE'));
});

test('failed repair transactions clean new blank and painted assets across later operations while preserving deduplicated assets', async t => {
  const { native, doc: start } = await fixture(t); const id = start.layers[0].id;
  for (const preexistingBlank of [false, true]) {
    let doc = await get(native, start);
    if (preexistingBlank) doc = await edit(native, doc, 'add_paint_layer');
    const files = (await fs.readdir(native.assetsDir)).sort(), previous = await native.execute('get_preview', { documentId: doc.id, maxWidth: 100 });
    const newLayerId = randomUUID();
    await assert.rejects(edit(native, doc, 'apply_transaction', { operations: [
      { command: 'create_repair_layer', args: { sourceLayerId: id, newLayerId } },
      { command: 'paint_stroke', args: { ...stroke, layerId: newLayerId, sampleMode: 'current-and-below' } },
      { command: 'set_layer', args: { layerId: newLayerId, opacity: 2 } },
    ] }), coded('INVALID_ARGUMENT'));
    assert.deepEqual((await fs.readdir(native.assetsDir)).sort(), files); assert.deepEqual(await get(native, doc), doc);
    assert.deepEqual(await native.execute('get_preview', { documentId: doc.id, maxWidth: 100 }), previous);
  }
  const doc = await get(native, start), success = await native.execute('create_repair_layer', { documentId: doc.id, sourceLayerId: id });
  assert.ok(success.layerId); await fs.access(path.join(native.assetsDir, success.document.layers.find(layer => layer.id === success.layerId).asset));
});

test('real publication failure removes repair-owned assets and leaves project and preview intact', async t => {
  const { native, doc, dataDir } = await fixture(t); const files = (await fs.readdir(native.assetsDir)).sort();
  const before = await native.execute('get_preview', { documentId: doc.id, maxWidth: 100 }), projectBytes = await fs.readFile(path.join(native.projectsDir, `${doc.id}.json`));
  const originalDirectory = native.projectsDir, blocked = path.join(dataDir, 'not-a-directory'); await fs.writeFile(blocked, 'blocked'); native.projectsDir = blocked;
  await assert.rejects(edit(native, doc, 'create_repair_layer', { sourceLayerId: doc.layers[0].id }), coded('ENOTDIR')); native.projectsDir = originalDirectory;
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual((await fs.readdir(native.assetsDir)).sort(), files);
  assert.deepEqual(await fs.readFile(path.join(native.projectsDir, `${doc.id}.json`)), projectBytes);
  assert.deepEqual(await native.execute('get_preview', { documentId: doc.id, maxWidth: 100 }), before);
});

test('asset ownership scope preserves explicit collectors and does not capture unrelated direct asynchronous writes', async t => {
  const { native, doc } = await fixture(t); const files = (await fs.readdir(native.assetsDir)).sort(), originalStore = native.storeAsset.bind(native);
  let release, notify; const gate = new Promise(resolve => { release = resolve; }), reached = new Promise(resolve => { notify = resolve; });
  const explicit = new Set(); let storedRepair;
  native.storeAsset = async function(data, options) {
    storedRepair = await originalStore(data, { ...options, createdAssets: explicit }); notify(); await gate; return storedRepair;
  };
  const newLayerId = randomUUID(), pending = edit(native, doc, 'apply_transaction', { operations: [
    { command: 'create_repair_layer', args: { sourceLayerId: doc.layers[0].id, newLayerId } },
    { command: 'set_layer', args: { layerId: newLayerId, opacity: 2 } },
  ] });
  await reached;
  const unrelated = await originalStore(await png(rgba(doc.width, doc.height, [1, 2, 3, 4]), doc.width, doc.height));
  release(); await assert.rejects(pending, coded('INVALID_ARGUMENT')); native.storeAsset = originalStore;
  assert.ok(explicit.has(storedRepair)); assert.notEqual(unrelated, storedRepair);
  await assert.rejects(fs.access(path.join(native.assetsDir, storedRepair)), coded('ENOENT'));
  await fs.access(path.join(native.assetsDir, unrelated));
  assert.deepEqual((await fs.readdir(native.assetsDir)).sort(), [...files, unrelated].sort()); assert.deepEqual(await get(native, doc), doc);
});
