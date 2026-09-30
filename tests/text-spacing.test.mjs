import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { ensureBundledFonts } from '../server/fonts.mjs';
import { bitmapBytes } from '../server/masks.mjs';
import { alphaBounds } from '../server/cutout-pixels.mjs';
import { normalizeTextSpacing, textLineBaseline, textTrackingAttribute } from '../server/text-spacing.mjs';

const coded = code => cause => cause.code === code;
const edit = async (native, doc, command, args = {}) => (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document;
const get = async (native, doc) => (await native.execute('get_document', { documentId: doc.id })).document;
const currentGraph = (native, doc) => { const project = native.project(doc.id); return structuredClone(project.states[project.cursor].graph); };
const target = (doc, id) => doc.layers.find(layer => layer.id === id);
const escapeXml = input => input.replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[value]);
async function reference(layer, { legacy = false } = {}) {
  if (layer.fontFamily === 'Fraunces') await ensureBundledFonts();
  const lines = layer.text.split('\n').map((line, index) => {
    const baseline = legacy || layer.leading === undefined ? layer.y + layer.fontSize + index * layer.fontSize * 1.2 : layer.y + layer.fontSize + index * layer.leading;
    return `<tspan x="${layer.x}" y="${baseline}">${escapeXml(line)}</tspan>`;
  }).join('');
  const anchor = { left: 'start', center: 'middle', right: 'end' }[layer.align ?? 'left'];
  const spacing = !legacy && layer.tracking ? ` letter-spacing="${(layer.fontSize * layer.tracking) / 1000}"` : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${layer.width}" height="${layer.height}"><text font-family="${layer.fontFamily ?? 'sans-serif'}" font-weight="${layer.fontWeight ?? 'normal'}" font-style="${layer.fontStyle ?? 'normal'}" text-anchor="${anchor}" font-size="${layer.fontSize}"${spacing} fill="${layer.color}" xml:space="preserve">${lines}</text></svg>`;
  return sharp(Buffer.from(svg)).toColourspace('srgb').ensureAlpha().raw().toBuffer();
}
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-text-spacing-'));
  const native = await new NativeBackend({ dataDir }).init();
  t.after(async () => { await native.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const original = await sharp({ create: { width: 480, height: 300, channels: 4, background: '#6f8861' } }).png().toBuffer();
  const doc = (await native.execute('import_image', { data: original.toString('base64'), mimeType: 'image/png' })).document;
  return { native, doc, original, dataDir };
}
const textArgs = { text: 'AUTUMN\nOUTFITS', x: 240, y: 20, fontSize: 52, fontFamily: 'Fraunces', align: 'center', color: '#ffffff' };

test('typography normalization validates exact fields and canonicalizes explicit resets without changing authored inputs', () => {
  const input = Object.freeze({ tracking: 250, leading: 72.5 });
  assert.deepEqual(normalizeTextSpacing(input), input);
  assert.deepEqual(normalizeTextSpacing({ tracking: 0, leading: null }, { command: true }), {});
  assert.deepEqual(normalizeTextSpacing({ tracking: undefined, leading: undefined }, { command: true }), {});
  assert.deepEqual(normalizeTextSpacing({ tracking: 0 }), {});
  for (const tracking of [-1001, 1001, 0.1, null, false, '100', NaN, Infinity, undefined]) assert.throws(() => normalizeTextSpacing({ tracking }), coded('INVALID_ARGUMENT'));
  for (const leading of [0, 0.9, 2001, null, false, '12', NaN, Infinity, undefined]) assert.throws(() => normalizeTextSpacing({ leading }), coded('INVALID_ARGUMENT'));
  for (const value of [-1000, -1, 1, 1000]) assert.equal(normalizeTextSpacing({ tracking: value }).tracking, value);
  for (const value of [1, 1.25, 2000]) assert.equal(normalizeTextSpacing({ leading: value }).leading, value);
  assert.equal(textTrackingAttribute({ fontSize: 72, tracking: 100 }), ' letter-spacing="7.2"');
  assert.equal(textTrackingAttribute({ fontSize: 72 }), ''); assert.equal(textTrackingAttribute({ fontSize: 72, tracking: 0 }), '');
});

test('Auto preserves the literal legacy multiplication order and explicit leading leaves the first baseline fixed', () => {
  let differingAlternative = 0;
  for (const fontSize of [1.1, 7.3, 27.3, 72.7, 99.99]) for (let index = 0; index < 100; index++) {
    const layer = { y: 13.2, fontSize }, legacy = layer.y + fontSize + index * fontSize * 1.2;
    assert.equal(textLineBaseline(layer, index), legacy);
    if (legacy !== layer.y + fontSize + index * (fontSize * 1.2)) differingAlternative++;
    assert.equal(textLineBaseline({ ...layer, leading: 43.5 }, index), layer.y + fontSize + index * 43.5);
  }
  assert.ok(differingAlternative > 0);
});

test('legacy and reset text remain pixel-identical to independent old SVG with blank lines, XML, Unicode and bundled font', async t => {
  const { native, doc: start, original } = await fixture(t); let doc = start;
  for (const fontFamily of ['sans-serif', 'Fraunces']) {
    doc = await edit(native, doc, 'add_text', { ...textArgs, text: 'A<&> "\'\n\ne\u0301 😀 AVA\n office', fontSize: 27.3, fontFamily }); const id = doc.layers.at(-1).id;
    const baseline = await reference(target(doc, id), { legacy: true }); assert.deepEqual(await native.renderLayer(target(doc, id)), baseline);
    doc = await edit(native, doc, 'update_text', { layerId: id, tracking: 160, leading: 49.7 });
    assert.notDeepEqual(await native.renderLayer(target(doc, id)), baseline);
    doc = await edit(native, doc, 'update_text', { layerId: id, tracking: 0, leading: null });
    assert.ok(!Object.hasOwn(target(doc, id), 'tracking')); assert.ok(!Object.hasOwn(target(doc, id), 'leading'));
    assert.deepEqual(await native.renderLayer(target(doc, id)), baseline);
  }
  assert.deepEqual(await fs.readFile(path.join(native.assetsDir, doc.layers[0].sourceAsset)), original); assert.equal((await fs.readdir(native.assetsDir)).length, 1);
});

test('positive and negative tracking, leading, anchors and font size render as independent equivalent SVG references', async t => {
  const { native, doc: start } = await fixture(t); let doc = start;
  for (const align of ['left', 'center', 'right']) for (const tracking of [-75, 150]) {
    doc = await edit(native, doc, 'add_text', { ...textArgs, text: 'AVA\n\nA A', align, tracking, leading: 61.25, fontSize: 42, x: align === 'left' ? 30 : align === 'right' ? 450 : 240 });
    const layer = doc.layers.at(-1); assert.deepEqual(await native.renderLayer(layer), await reference(layer));
    doc = await edit(native, doc, 'update_text', { layerId: layer.id, fontSize: 57.5 });
    const changed = target(doc, layer.id); assert.equal(changed.leading, 61.25); assert.equal(changed.tracking, tracking);
    assert.deepEqual(await native.renderLayer(changed), await reference(changed));
  }
  doc = await edit(native, doc, 'add_text', { ...textArgs, text: 'AUTUMN', align: 'left', x: 20, tracking: 0 }); const id = doc.layers.at(-1).id;
  const baseWidth = alphaBounds(await native.renderLayer(target(doc, id)), doc.width, doc.height).width;
  doc = await edit(native, doc, 'update_text', { layerId: id, tracking: 100 }); const wide = alphaBounds(await native.renderLayer(target(doc, id)), doc.width, doc.height).width;
  doc = await edit(native, doc, 'update_text', { layerId: id, tracking: -50 }); const narrow = alphaBounds(await native.renderLayer(target(doc, id)), doc.width, doc.height).width;
  assert.ok(narrow < baseWidth && baseWidth < wide);
});

test('partial updates and independent resets preserve authored spacing and source assets across clone, undo, reopen and portable transfer', async t => {
  const { native, doc: start, dataDir, original } = await fixture(t);
  let doc = await edit(native, start, 'add_text', { ...textArgs, tracking: 75, leading: 69.5 }); const id = doc.layers.at(-1).id;
  doc = await edit(native, doc, 'update_text', { layerId: id, color: '#ffeedd' }); assert.equal(target(doc, id).tracking, 75); assert.equal(target(doc, id).leading, 69.5);
  doc = await edit(native, doc, 'update_text', { layerId: id, tracking: undefined, leading: undefined }); assert.equal(target(doc, id).tracking, 75); assert.equal(target(doc, id).leading, 69.5);
  doc = await edit(native, doc, 'duplicate_layer', { layerId: id }); const copyId = doc.layers.at(-1).id;
  doc = await edit(native, doc, 'update_text', { layerId: copyId, tracking: 0 }); assert.equal(target(doc, copyId).tracking, undefined); assert.equal(target(doc, copyId).leading, 69.5); assert.equal(target(doc, id).tracking, 75);
  doc = await edit(native, doc, 'update_text', { layerId: copyId, leading: null }); assert.ok(!Object.hasOwn(target(doc, copyId), 'leading'));
  doc = await edit(native, doc, 'undo'); assert.equal(target(doc, copyId).leading, 69.5); doc = await edit(native, doc, 'redo');
  const before = await native.render(native.project(doc.id)), bundle = await native.exportProject({ documentId: doc.id });
  const imported = (await native.importProject({ data: bundle.data })).document; assert.deepEqual(imported.layers, doc.layers); assert.deepEqual(await native.render(native.project(imported.id)), before);
  const reopened = await new NativeBackend({ dataDir }).init(); t.after(() => reopened.close()); assert.deepEqual((await get(reopened, doc)).layers, doc.layers); assert.deepEqual(await reopened.render(reopened.project(doc.id)), before);
  assert.deepEqual(await fs.readFile(path.join(native.assetsDir, doc.layers[0].sourceAsset)), original);
});

test('invalid or misplaced typography, protected edits, stale revisions and failed transactions are atomic', async t => {
  const { native, doc: start } = await fixture(t);
  let doc = await edit(native, start, 'add_text', { ...textArgs, tracking: 100, leading: 72 }); const id = doc.layers.at(-1).id;
  const before = await native.render(native.project(doc.id)), files = await fs.readdir(native.assetsDir);
  for (const args of [{ tracking: 1001 }, { tracking: -1001 }, { tracking: 0.5 }, { tracking: null }, { leading: 0 }, { leading: 2001 }, { leading: 'Auto' }, { leading: Infinity }])
    await assert.rejects(edit(native, doc, 'update_text', { layerId: id, ...args }), coded('INVALID_ARGUMENT'));
  for (const field of ['tracking', 'leading']) for (const value of [null, undefined, 'bad']) {
    const graph = currentGraph(native, doc); graph.layers.at(-1)[field] = value; assert.throws(() => native.validateGraph(graph), coded('INVALID_ARGUMENT'));
  }
  for (const field of ['tracking', 'leading']) {
    const graph = currentGraph(native, doc); graph.layers[0][field] = 1; assert.throws(() => native.validateGraph(graph), coded('INVALID_TARGET'));
  }
  const graph = currentGraph(native, doc); graph.layers[0].unrelatedLegacyMetadata = { retained: true }; native.validateGraph(graph);
  await assert.rejects(edit(native, doc, 'apply_transaction', { operations: [{ command: 'update_text', args: { layerId: id, tracking: 200 } }, { command: 'update_text', args: { layerId: id, leading: 0 } }] }), coded('INVALID_ARGUMENT'));
  await assert.rejects(native.execute('update_text', { documentId: doc.id, expectedRevision: doc.revision - 1, layerId: id, tracking: 0 }), coded('REVISION_CONFLICT'));
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await native.render(native.project(doc.id)), before); assert.deepEqual(await fs.readdir(native.assetsDir), files);
  doc = await edit(native, doc, 'set_layer_protection', { layerId: id, protected: true });
  await assert.rejects(edit(native, doc, 'update_text', { layerId: id, tracking: 0, leading: null }), coded('PROTECTED_LAYER')); assert.deepEqual(await get(native, doc), doc);
});

test('one shared text renderer drives transformed source selection, clipping and rasterization without losing parent links', async t => {
  const { native, doc: start } = await fixture(t); const baseId = start.layers[0].id;
  let doc = await edit(native, start, 'add_text', { ...textArgs, tracking: 120, leading: 70 }); const textId = doc.layers.at(-1).id;
  doc = await edit(native, doc, 'set_clipping_chain', { baseLayerId: baseId, layerIds: [textId] });
  doc = await edit(native, doc, 'group_layers', { layerIds: [baseId, textId] }); const groupId = doc.layers[0].id;
  doc = await edit(native, doc, 'transform_layer', { layerId: textId, x: 3, y: 2 });
  const source = await native.renderLayer(target(doc, textId)), before = await native.render(native.project(doc.id));
  doc = await edit(native, doc, 'load_layer_selection', { layerId: textId });
  assert.deepEqual(Buffer.from(bitmapBytes(doc.selection)), Buffer.from(Array.from({ length: doc.width * doc.height }, (_, p) => source[p * 4 + 3])));
  doc = await edit(native, doc, 'rasterize_layer', { layerId: textId });
  const raster = target(doc, textId); assert.equal(raster.type, 'raster'); assert.equal(raster.parentId, groupId); assert.equal(raster.clipBaseId, baseId); assert.equal(raster.tracking, undefined); assert.equal(raster.leading, undefined);
  assert.deepEqual(await native.render(native.project(doc.id)), before);
});
