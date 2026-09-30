import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { updatedLayerStyles } from '../server/layer-styles.mjs';

const edit = async (native, doc, command, args = {}) => (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document;
const settings = { outline: { width: 2, color: '#ffeedd' }, effects: { shadow: { color: '#775533', opacity: 0.7, blur: 1, x: 4, y: 1 }, glow: { color: '#f0ab60', opacity: 0.5, blur: 2 } } };
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-style-audit-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const native = await new NativeBackend({ dataDir }).init();
  return { native, dataDir };
}
function freeze(value) { if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; }

test('preset styles preserve soft protected source pixels and cannot cast ghosts from protection-clipped generated content', async t => {
  const { native } = await fixture(t), width = 32, height = 24, raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set([x * 7, y * 9, 141, x >= 12 && x <= 19 && y >= 7 && y <= 16 ? [1, 128, 255][x % 3] : 0], (y * width + x) * 4);
  const png = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
  let doc = (await native.execute('import_image', { data: png.toString('base64'), mimeType: 'image/png' })).document;
  const subject = doc.layers[0].id;
  doc = (await native.installGeneratedImage({ documentId: doc.id, expectedRevision: doc.revision, data: png, provenance: { jobId: randomUUID(), mode: 'generate' } })).document;
  const generated = doc.layers.at(-1).id;
  doc = await edit(native, doc, 'duplicate_layer', { layerId: subject }); const donor = doc.layers.find(layer => layer.id !== subject && layer.id !== generated).id;
  doc = await edit(native, doc, 'set_layer_outline', { layerId: donor, ...settings.outline });
  doc = await edit(native, doc, 'set_layer_effects', { layerId: donor, effects: settings.effects });
  doc = await edit(native, doc, 'set_layer', { layerId: donor, visible: false });
  doc = await edit(native, doc, 'save_layer_style', { layerId: donor, name: 'Hidden reusable decoration' }); const styleId = doc.layerStyles[0].id;
  doc = await edit(native, doc, 'set_layer_protection', { layerId: subject, protected: true });
  const before = await native.renderGraph(doc), files = await fs.readdir(native.assetsDir), bytes = await Promise.all(files.map(file => fs.readFile(path.join(native.assetsDir, file))));
  doc = await edit(native, doc, 'apply_layer_style', { styleId, layerIds: [generated] });
  assert.deepEqual(await native.renderGraph(doc), before, 'A fully clipped generated layer must cast no decoration.');
  doc = await edit(native, doc, 'apply_layer_style', { styleId, layerIds: [subject] });
  const styled = await native.renderGraph(doc);
  for (let i = 0; i < raw.length; i += 4) if (raw[i + 3]) assert.deepEqual(styled.subarray(i, i + 4), before.subarray(i, i + 4));
  assert.notDeepEqual(styled, before);
  assert.deepEqual(await fs.readdir(native.assetsDir), files);
  assert.deepEqual(await Promise.all(files.map(file => fs.readFile(path.join(native.assetsDir, file)))), bytes);
  const undo = await edit(native, doc, 'undo'); assert.deepEqual(await native.renderGraph(undo), before);
  const direct = await edit(native, undo, 'apply_transaction', { operations: [
    { command: 'set_layer_outline', args: { layerId: subject, ...settings.outline } },
    { command: 'set_layer_effects', args: { layerId: subject, effects: settings.effects } },
  ] });
  assert.deepEqual(await native.renderGraph(direct), styled, 'Preset rendering must be the exact existing style renderer.');
});

test('pure style application detaches every style copy and leaves frozen non-style metadata and selection intact', () => {
  const styleId = randomUUID(), ids = [randomUUID(), randomUUID()];
  const graph = freeze({ width: 16, height: 16, name: 'Independent copies', selection: { x: 1, y: 1, width: 3, height: 4 },
    layerStyles: [{ id: styleId, name: 'Outline only', outline: { width: 2, color: '#ABCDEF' } }],
    layers: ids.map((id, index) => ({ id, type: 'raster', name: `Layer ${index}`, visible: !index, opacity: 0.75, protected: true, parentId: randomUUID(),
      filters: [{ id: randomUUID(), enabled: false }], transforms: [{ type: 'affine', x: index, y: 0 }], mask: { invert: true, feather: 1 },
      outline: { width: 8, color: '#ff00ff' }, effects: settings.effects })) });
  const before = structuredClone(graph), applied = updatedLayerStyles(graph, 'apply_layer_style', { styleId, layerIds: ids }).graph;
  assert.deepEqual(graph, before); assert.deepEqual(applied.selection, graph.selection);
  for (const [index, layer] of applied.layers.entries()) {
    const { outline, effects, ...rest } = layer, { outline: oldOutline, effects: oldEffects, ...expected } = graph.layers[index];
    assert.deepEqual(rest, expected); assert.equal(effects, undefined); assert.deepEqual(outline, { width: 2, color: '#abcdef' });
  }
  applied.layers[0].outline.color = '#000000';
  assert.equal(applied.layers[1].outline.color, '#abcdef'); assert.equal(graph.layerStyles[0].outline.color, '#ABCDEF');
  assert.notEqual(applied.layers[0].outline, applied.layerStyles[0].outline);
});

test('malformed portable style libraries reject before source assets or projects are published', async t => {
  const { native: source } = await fixture(t), { native: target } = await fixture(t);
  const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#765432' } }).png().toBuffer();
  const doc = (await source.execute('import_image', { data: png.toString('base64'), mimeType: 'image/png' })).document;
  const { data: valid } = await source.exportProject({ documentId: doc.id });
  const manifestLength = valid.readUInt32BE(8), manifest = JSON.parse(valid.subarray(12, 12 + manifestLength));
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const style = { id: randomUUID(), name: 'Valid outline', outline: { width: 1, color: '#ffffff' } };
  const invalid = [
    [{ ...style, outline: { width: 1.5, color: '#ffffff' } }],
    [{ ...style, outline: { width: 1, color: '#ffffff', inside: true } }],
    [{ ...style, effects: { shadow: { blur: 65 } } }],
    [{ ...style, filters: [] }], [style, structuredClone(style)],
    [{ ...style, outline: { width: 0, color: '#ffffff' } }],
    [{ ...style, name: '   ' }], Array.from({ length: 33 }, () => ({ ...style, id: randomUUID() })),
  ];
  let writes = 0; const store = target.storeAsset.bind(target); target.storeAsset = (...args) => { writes++; return store(...args); };
  for (const layerStyles of invalid) {
    // Construct hostile but canonical metadata without invoking the production
    // encoder's own style guard. Keep its original asset table and bytes.
    const body = Buffer.from(JSON.stringify(canonical({ ...manifest, graph: { ...manifest.graph, layerStyles } })));
    const prefix = Buffer.from(valid.subarray(0, 12)); prefix.writeUInt32BE(body.length, 8);
    const data = Buffer.concat([prefix, body, valid.subarray(12 + manifestLength)]);
    await assert.rejects(target.importProject({ data }), { code: layerStyles.length > 32 ? 'LIMIT_EXCEEDED' : 'INVALID_PROJECT_BUNDLE' });
  }
  assert.equal(writes, 0); assert.equal(target.projects.size, 0);
  assert.deepEqual(await fs.readdir(target.projectsDir), []); assert.deepEqual(await fs.readdir(target.assetsDir), []);
});

test('hidden adjustment targets reject atomically; persistence failure and stale style edits retain published cache and graph', async t => {
  const { native } = await fixture(t);
  let doc = (await native.execute('create_document', { width: 16, height: 16 })).document;
  const contentId = doc.layers[0].id;
  doc = await edit(native, doc, 'set_layer_outline', { layerId: contentId, width: 1 });
  doc = await edit(native, doc, 'save_layer_style', { layerId: contentId }); const styleId = doc.layerStyles[0].id;
  doc = await edit(native, doc, 'add_adjustment', { kind: 'brightness', value: 10 }); const adjustmentId = doc.layers.at(-1).id;
  doc = await edit(native, doc, 'set_layer', { layerId: adjustmentId, visible: false });
  const preview = await native.execute('get_preview', { documentId: doc.id }), cache = native.previewCache.stats();
  const file = path.join(native.projectsDir, `${doc.id}.json`), bytes = await fs.readFile(file);
  await assert.rejects(edit(native, doc, 'apply_transaction', { operations: [
    { command: 'rename_layer_style', args: { styleId, name: 'Must be rolled back' } },
    { command: 'apply_layer_style', args: { styleId, layerIds: [contentId, adjustmentId] } },
  ] }), { code: 'INVALID_TARGET' });
  await assert.rejects(edit(native, doc, 'save_layer_style', { layerId: adjustmentId }), { code: 'INVALID_TARGET' });
  for (const layerIds of [[contentId, contentId], [contentId, randomUUID()]]) await assert.rejects(edit(native, doc, 'apply_layer_style', { styleId, layerIds }));
  await assert.rejects(native.execute('apply_layer_style', { documentId: doc.id, expectedRevision: doc.revision - 1, styleId, layerIds: [contentId] }), { code: 'REVISION_CONFLICT' });
  const directory = native.projectsDir; native.projectsDir = file; // Actual filesystem ENOTDIR before publication.
  try { await assert.rejects(edit(native, doc, 'rename_layer_style', { styleId, name: 'Cannot persist' })); }
  finally { native.projectsDir = directory; }
  assert.deepEqual((await native.execute('get_document', { documentId: doc.id })).document, doc);
  assert.deepEqual(await fs.readFile(file), bytes); assert.deepEqual(native.previewCache.stats(), cache);
  assert.deepEqual(await native.execute('get_preview', { documentId: doc.id }), preview);
});
