import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { normalizeLayerStyle, validateLayerStyles, updatedLayerStyles, MAX_LAYER_STYLES } from '../server/layer-styles.mjs';
import { encodeProjectBundle } from '../server/project-bundle.mjs';

const coded = code => error => error.code === code;
const edit = async (native, document, command, args = {}) => (await native.execute(command, { documentId: document.id, expectedRevision: document.revision, ...args })).document;
const get = async (native, document) => (await native.execute('get_document', { documentId: document.id })).document;
const style = (changes = {}) => ({ id: randomUUID(), name: 'Portrait', outline: { width: 2, color: '#FFFFFF' }, ...changes });
const render = (native, document) => native.render(native.project(document.id));
const width = 24, height = 20, source = Buffer.alloc(width * height * 4);
for (let y = 6; y < 10; y++) for (let x = 6; x < 10; x++) source.set([37 + x * 3, 141 + y, 207, [0, 1, 128, 255][x - 6]], (y * width + x) * 4);
const png = await sharp(source, { raw: { width, height, channels: 4 } }).png().toBuffer();
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-layer-styles-'));
  const native = await new NativeBackend({ dataDir }).init();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const document = (await native.execute('import_image', { mimeType: 'image/png', data: png.toString('base64') })).document;
  return { native, dataDir, document };
}
async function capture(native, document, settings = { shadow: { x: 3, y: 0, blur: 0, opacity: 0.7 } }) {
  const layerId = document.layers[0].id;
  document = await edit(native, document, 'set_layer_effects', { layerId, effects: settings });
  document = await edit(native, document, 'save_layer_style', { layerId, name: 'Portrait' });
  return document;
}

test('style normalization captures only supported settings, canonicalizes defaults, and validates enabled structure', () => {
  const original = style({ effects: { shadow: {}, glow: { color: '#AaBBcC', opacity: 0.2 } } }), before = structuredClone(original);
  const normalized = normalizeLayerStyle(original);
  assert.equal(normalized.outline.color, '#ffffff');
  assert.deepEqual(normalized.effects.shadow, { color: '#000000', opacity: 0.35, blur: 8, x: 4, y: 6 });
  assert.deepEqual(normalized.effects.glow, { color: '#aabbcc', opacity: 0.2, blur: 8 });
  normalized.effects.shadow.x = 77; assert.deepEqual(original, before);
  const zero = normalizeLayerStyle(style({ outline: { width: 0, color: '#ffffff' }, effects: { glow: { blur: 0, opacity: 1 } } }));
  assert.equal(zero.outline, undefined, 'disabled outline is omitted');
  assert.equal(zero.effects.glow.blur, 0, 'saving enabled settings does not promise rendered pixels');
  for (const bad of [style({ effects: {}, outline: { width: 0, color: '#ffffff' } }), { id: randomUUID(), name: 'None' }, style({ outline: undefined, effects: { shadow: { opacity: 0 } } })]) assert.throws(() => normalizeLayerStyle(bad), coded('NO_LAYER_STYLE'));
  for (const bad of [style({ opacity: 0.5 }), style({ name: ' ' }), style({ id: 'bad' }), style({ outline: { width: 0.5, color: '#ffffff' } }), style({ outline: { width: 2, color: '#ffffff', align: 'inside' } }), style({ effects: { bevel: {} } })]) assert.throws(() => normalizeLayerStyle(bad), coded('INVALID_ARGUMENT'));
  const duplicate = style(); assert.throws(() => validateLayerStyles({ layerStyles: [duplicate, duplicate] }), coded('INVALID_ARGUMENT'));
  assert.throws(() => validateLayerStyles({ layerStyles: Array.from({ length: MAX_LAYER_STYLES + 1 }, () => style()) }), coded('LIMIT_EXCEEDED'));
});

test('pure multi-target staging replaces both slots, deep-copies settings and never modifies its input', () => {
  const saved = style({ outline: undefined, effects: { shadow: { x: 2, color: '#ff0000' } } }); delete saved.outline;
  const first = { id: randomUUID(), type: 'raster', name: 'First', outline: { width: 5, color: '#ffffff' }, mask: { x: 1 }, opacity: 0.5, protected: true, filters: [{ id: 'unrelated' }] };
  const second = { ...structuredClone(first), id: randomUUID(), effects: { glow: { opacity: 1 } } };
  const graph = { layers: [first, second], layerStyles: [saved], selection: { x: 3 } }, before = structuredClone(graph);
  const staged = updatedLayerStyles(graph, 'apply_layer_style', { styleId: saved.id, layerIds: [first.id, second.id] }).graph;
  for (const changed of staged.layers) { assert.equal(changed.outline, undefined); assert.equal(changed.effects.glow, undefined); assert.equal(changed.effects.shadow.blur, 8); }
  staged.layers[0].effects.shadow.x = 13; assert.equal(staged.layers[1].effects.shadow.x, 2); assert.deepEqual(graph, before);
  assert.deepEqual(staged.layers[0].mask, first.mask); assert.equal(staged.layers[0].protected, true); assert.deepEqual(staged.selection, graph.selection);
  assert.throws(() => updatedLayerStyles(graph, 'apply_layer_style', { styleId: saved.id, layerIds: [first.id, randomUUID()] }), coded('NOT_FOUND')); assert.deepEqual(graph, before);
});

test('save/update/rename/delete keep copied settings independent, rendered pixels unchanged and assets untouched', async t => {
  const { native, dataDir, document: initial } = await fixture(t), layerId = initial.layers[0].id;
  assert.deepEqual(initial.layerStyles, []);
  let document = await edit(native, initial, 'set_layer_outline', { layerId, width: 2 });
  const pixels = await render(native, document), assets = await fs.readdir(native.assetsDir);
  document = await edit(native, document, 'save_layer_style', { layerId, name: '  White outline  ' });
  const styleId = document.layerStyles[0].id; assert.equal(document.layerStyles[0].name, 'White outline');
  assert.deepEqual(await render(native, document), pixels);
  document = await edit(native, document, 'set_layer_outline', { layerId, width: 3, color: '#ff0000' });
  assert.equal(document.layerStyles[0].outline.width, 2); assert.equal(document.layerStyles[0].outline.color, '#ffffff');
  const changedPixels = await render(native, document);
  document = await edit(native, document, 'save_layer_style', { layerId, styleId });
  assert.equal(document.layerStyles.length, 1); assert.equal(document.layerStyles[0].id, styleId); assert.equal(document.layerStyles[0].name, 'White outline'); assert.equal(document.layerStyles[0].outline.width, 3);
  document = await edit(native, document, 'rename_layer_style', { styleId, name: 'Red outline' });
  document = await edit(native, document, 'delete_layer_style', { styleId }); assert.deepEqual(document.layerStyles, []);
  assert.deepEqual(await render(native, document), changedPixels);
  document = await edit(native, document, 'undo'); assert.equal(document.layerStyles[0].name, 'Red outline');
  document = await edit(native, document, 'undo'); assert.equal(document.layerStyles[0].name, 'White outline');
  assert.deepEqual(await fs.readdir(native.assetsDir), assets); assert.deepEqual(await fs.readFile(path.join(dataDir, 'assets', initial.layers[0].sourceAsset)), png);
  document.layerStyles[0].outline.width = 50;
  assert.equal((await get(native, document)).layerStyles[0].outline.width, 3);
});

test('applying outside style to multiple protected/content targets preserves source pixels and all unrelated state in one undo', async t => {
  const { native, document: initial } = await fixture(t), layerId = initial.layers[0].id;
  let document = await capture(native, initial);
  document = await edit(native, document, 'set_layer_effects', { layerId, effects: null });
  document = await edit(native, document, 'set_layer_outline', { layerId, width: 1 });
  document = await edit(native, document, 'set_layer_protection', { layerId, protected: true });
  document = await edit(native, document, 'add_shape', { shape: 'rectangle', x: 17, y: 12, width: 2, height: 2, fill: '#bf845a' });
  const shapeId = document.layers.at(-1).id;
  document = await edit(native, document, 'select_rectangle', { x: 0, y: 0, width: 2, height: 2 });
  const before = document, pixels = await render(native, before), assets = await fs.readdir(native.assetsDir);
  document = await edit(native, document, 'apply_layer_style', { styleId: document.layerStyles[0].id, layerIds: [layerId, shapeId] });
  assert.equal(document.revision, before.revision + 1); assert.equal(document.history.length, before.history.length + 1); assert.deepEqual(document.selection, before.selection);
  assert.equal(document.layers[0].outline, undefined); assert.equal(document.layers[0].protected, true);
  const after = await render(native, document); assert.notDeepEqual(after, pixels);
  for (let i = 0; i < source.length; i += 4) if (source[i + 3]) assert.deepEqual(after.subarray(i, i + 4), pixels.subarray(i, i + 4));
  for (let index = 0; index < before.layers.length; index++) {
    const unchanged = ({ outline, effects, ...rest }) => rest;
    assert.deepEqual(unchanged(document.layers[index]), unchanged(before.layers[index]));
  }
  assert.deepEqual(await fs.readdir(native.assetsDir), assets);
  const undo = await edit(native, document, 'undo'); assert.deepEqual(await render(native, undo), pixels); assert.deepEqual(undo.layers, before.layers);
  const redo = await edit(native, undo, 'redo'); assert.deepEqual(await render(native, redo), after);
});

test('invalid targets, empty source, stale revisions and failed transactions leave graph, disk and previews unchanged', async t => {
  const { native, document: initial } = await fixture(t), layerId = initial.layers[0].id;
  await assert.rejects(edit(native, initial, 'save_layer_style', { layerId }), coded('NO_LAYER_STYLE'));
  let document = await capture(native, initial);
  document = await edit(native, document, 'create_group', { name: 'Hidden group' }); const groupId = document.layers.at(-1).id;
  document = await edit(native, document, 'set_layer', { layerId: groupId, visible: false });
  document = await edit(native, document, 'add_adjustment', { kind: 'brightness', value: 0 }); const adjustment = document.layers.at(-1).id;
  const before = document, file = path.join(native.projectsDir, `${document.id}.json`), bytes = await fs.readFile(file), pixels = await render(native, document), styleId = document.layerStyles[0].id;
  for (const bad of [groupId, adjustment]) {
    await assert.rejects(edit(native, document, 'apply_layer_style', { styleId, layerIds: [layerId, bad] }), coded('INVALID_TARGET'));
    await assert.rejects(edit(native, document, 'save_layer_style', { layerId: bad }), coded('INVALID_TARGET'));
  }
  await assert.rejects(edit(native, document, 'apply_layer_style', { styleId, layerIds: [layerId, randomUUID()] }), coded('NOT_FOUND'));
  await assert.rejects(edit(native, document, 'apply_layer_style', { styleId, layerIds: [layerId, layerId] }), coded('INVALID_ARGUMENT'));
  await assert.rejects(edit(native, document, 'rename_layer_style', { styleId, name: 'Stale', expectedRevision: document.revision - 1 }), coded('REVISION_CONFLICT'));
  await assert.rejects(edit(native, document, 'apply_transaction', { operations: [
    { command: 'rename_layer_style', args: { styleId, name: 'Must roll back' } },
    { command: 'apply_layer_style', args: { styleId, layerIds: [layerId, groupId] } },
  ] }), coded('INVALID_TARGET'));
  assert.deepEqual(await get(native, document), before); assert.deepEqual(await fs.readFile(file), bytes); assert.deepEqual(await render(native, document), pixels);
});

test('candidate resource validation and persistence failures reject all targets without publishing any mutation', async t => {
  const { native, document: initial } = await fixture(t);
  let document = await capture(native, initial), styleId = document.layerStyles[0].id, first = document.layers[0].id;
  document = await edit(native, document, 'set_layer_effects', { layerId: first, effects: null });
  document = await edit(native, document, 'duplicate_layer', { layerId: first }); const second = document.layers.at(-1).id;
  document = await edit(native, document, 'set_layer', { layerId: second, visible: false });
  const before = document, file = path.join(native.projectsDir, `${document.id}.json`), bytes = await fs.readFile(file), validate = native.validateGraph.bind(native);
  let checked = false;
  native.validateGraph = graph => {
    assert.equal(graph.layers[0].effects.shadow.x, 3); assert.equal(graph.layers[1].effects.shadow.x, 3); assert.equal(graph.layers[1].visible, false);
    checked = true; throw Object.assign(new Error('Injected resource rejection'), { code: 'LIMIT_EXCEEDED' });
  };
  await assert.rejects(edit(native, document, 'apply_layer_style', { styleId, layerIds: [first, second] }), coded('LIMIT_EXCEEDED')); assert.equal(checked, true);
  native.validateGraph = validate;
  assert.deepEqual(await get(native, document), before); assert.deepEqual(await fs.readFile(file), bytes);
  const persist = native.persist.bind(native); native.persist = async () => { throw Object.assign(new Error('Injected disk failure'), { code: 'EIO' }); };
  await assert.rejects(edit(native, document, 'apply_layer_style', { styleId, layerIds: [first, second] }), coded('EIO')); native.persist = persist;
  assert.deepEqual(await get(native, document), before); assert.deepEqual(await fs.readFile(file), bytes);
});

test('32-style cap permits overwrite at capacity and library values stay in canvas pixels through geometry and reopen', async t => {
  const { native, dataDir, document: initial } = await fixture(t), layerId = initial.layers[0].id;
  let document = await edit(native, initial, 'set_layer_outline', { layerId, width: 2 });
  for (let i = 0; i < MAX_LAYER_STYLES; i++) document = await edit(native, document, 'save_layer_style', { layerId, name: `Style ${i}` });
  await assert.rejects(edit(native, document, 'save_layer_style', { layerId, name: 'Overflow' }), coded('LIMIT_EXCEEDED'));
  const id = document.layerStyles[0].id;
  document = await edit(native, document, 'set_layer_outline', { layerId, width: 4 });
  document = await edit(native, document, 'save_layer_style', { layerId, styleId: id, name: 'Updated at capacity' });
  assert.equal(document.layerStyles.length, 32); assert.equal(document.layerStyles[0].id, id); assert.equal(document.layerStyles[0].outline.width, 4);
  const saved = structuredClone(document.layerStyles);
  document = await edit(native, document, 'resize_document', { width: 12, height: 10 });
  document = await edit(native, document, 'resize_canvas', { width: 16, height: 14, anchor: 'center' });
  document = await edit(native, document, 'crop_document', { x: 1, y: 1, width: 12, height: 10 });
  assert.deepEqual(document.layerStyles, saved);
  const reopened = await new NativeBackend({ dataDir }).init(); assert.equal(reopened.loadWarnings.length, 0); assert.deepEqual((await get(reopened, document)).layerStyles, saved);
  const caps = await native.execute('capabilities'); assert.equal(caps.limits.maxLayerStyles, 32); assert.deepEqual(caps.layerStyleProperties, ['outline', 'shadow', 'glow']);
});

test('portable projects preserve the independent style library and reject malformed preset metadata before asset writes', async t => {
  const { native, document: initial } = await fixture(t), target = await fixture(t);
  let document = await capture(native, initial), styleId = document.layerStyles[0].id;
  const exported = await native.exportProject({ documentId: document.id, expectedRevision: document.revision });
  const imported = await target.native.importProject({ data: exported.data });
  assert.notEqual(imported.document.id, document.id); assert.equal(imported.document.revision, 1); assert.deepEqual(imported.document.layerStyles, document.layerStyles); assert.deepEqual(await render(target.native, imported.document), await render(native, document));
  document = await edit(native, document, 'delete_layer_style', { styleId });
  assert.equal((await get(target.native, imported.document)).layerStyles.length, 1);
  const validGraph = native.project(document.id).states.at(-1).graph;
  for (const library of [[style({ extra: true })], [style({ outline: { width: 1.5, color: '#ffffff' } })], [style({ outline: undefined })]]) {
    await assert.rejects(encodeProjectBundle({ graph: { ...validGraph, layerStyles: library }, validateGraph: () => true, readAsset: async () => { assert.fail('Malformed library must fail before reading assets'); } }), coded('INVALID_PROJECT_BUNDLE'));
  }
  const data = exported.data, manifestLength = data.readUInt32BE(8), manifest = JSON.parse(data.subarray(12, 12 + manifestLength));
  manifest.graph.layerStyles[0].name = '';
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const bytes = Buffer.from(JSON.stringify(canonical(manifest))), header = Buffer.from(data.subarray(0, 12)); header.writeUInt32BE(bytes.length, 8);
  const invalid = Buffer.concat([header, bytes, data.subarray(12 + manifestLength)]), projectFiles = await fs.readdir(target.native.projectsDir), assetFiles = await fs.readdir(target.native.assetsDir);
  await assert.rejects(target.native.importProject({ data: invalid }), coded('INVALID_PROJECT_BUNDLE'));
  assert.deepEqual(await fs.readdir(target.native.projectsDir), projectFiles); assert.deepEqual(await fs.readdir(target.native.assetsDir), assetFiles);
});

test('style application preserves generated clipping and cannot create a ghost outside effect', async t => {
  const { native, document: initial } = await fixture(t), sourceId = initial.layers[0].id;
  let document = await capture(native, initial, { shadow: { x: 5, y: 0, blur: 0, opacity: 1, color: '#ff0000' }, glow: { blur: 2 } });
  document = await edit(native, document, 'set_layer_effects', { layerId: sourceId, effects: null });
  document = (await native.installGeneratedImage({ documentId: document.id, expectedRevision: document.revision, data: png, provenance: { jobId: randomUUID(), mode: 'generate' } })).document;
  const generatedId = document.layers.at(-1).id;
  document = await edit(native, document, 'set_layer_protection', { layerId: sourceId, protected: true });
  const before = await render(native, document);
  document = await edit(native, document, 'apply_layer_style', { styleId: document.layerStyles[0].id, layerIds: [generatedId] });
  assert.deepEqual(await render(native, document), before); assert.equal(document.layers.at(-1).role, 'generated');
});
