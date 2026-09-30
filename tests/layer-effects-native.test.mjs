import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { NativeBackend } from '../server/native.mjs';

const width = 16, height = 16, source = Buffer.alloc(width * height * 4);
for (let y = 5; y <= 7; y++) for (let x = 5; x <= 7; x++) source.set([40 + x, 120 + y, 210, x === 5 && y === 5 ? 128 : 255], (y * width + x) * 4);
const png = await sharp(source, { raw: { width, height, channels: 4 } }).png().toBuffer();
const pixel = (pixels, x, y, w = width) => [...pixels.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)];
const coded = (code) => (cause) => cause.code === code;
const edit = async (native, document, command, args = {}) => (await native.execute(command, { documentId: document.id, expectedRevision: document.revision, ...args })).document;
const render = (native, document) => native.render(native.project(document.id));
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-layer-effects-'));
  const native = await new NativeBackend({ dataDir }).init();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const document = (await native.execute('import_image', { mimeType: 'image/png', data: png.toString('base64') })).document;
  return { native, dataDir, document };
}

test('editable shadow preserves every protected source pixel and immutable asset, with true opacity and reversible persistence', async (t) => {
  const { native, dataDir, document: original } = await fixture(t);
  const layerId = original.layers[0].id;
  let document = await edit(native, original, 'set_layer', { layerId, opacity: 0.5 });
  document = await edit(native, document, 'set_layer_protection', { layerId, protected: true });
  const before = await render(native, document), assets = await fs.readdir(path.join(dataDir, 'assets'));
  document = await edit(native, document, 'set_layer_effects', { layerId, effects: { shadow: { blur: 0, x: 4, y: 0, color: '#ff0000', opacity: 0.5 } } });
  const after = await render(native, document);
  for (let i = 0; i < source.length; i += 4) if (source[i + 3]) assert.deepEqual(after.subarray(i, i + 4), before.subarray(i, i + 4));
  assert.deepEqual(pixel(after, 10, 6), [255, 0, 0, 64], 'effect opacity and layer opacity each apply once');
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'assets')), assets);
  assert.deepEqual(await fs.readFile(path.join(dataDir, 'assets', original.layers[0].sourceAsset)), png);
  const reopened = await new NativeBackend({ dataDir }).init();
  assert.equal(reopened.loadWarnings.length, 0); assert.deepEqual(await render(reopened, document), after);
  const undo = await edit(reopened, document, 'undo'); assert.deepEqual(await render(reopened, undo), before);
  const redo = await edit(reopened, undo, 'redo'); assert.deepEqual(await render(reopened, redo), after);
});

test('outline sits over glow and shadow as one opacity group without darkening translucent source edges', async (t) => {
  const { native, document: original } = await fixture(t), layerId = original.layers[0].id;
  let document = await edit(native, original, 'set_layer', { layerId, opacity: 0.5 });
  document = await edit(native, document, 'set_layer_outline', { layerId, width: 1, color: '#ffffff' });
  const outlined = await render(native, document);
  document = await edit(native, document, 'set_layer_effects', { layerId, effects: { shadow: { x: 1, y: 0, blur: 0, opacity: 1 }, glow: { blur: 2, opacity: 1, color: '#ff0000' } } });
  const pixels = await render(native, document);
  assert.deepEqual(pixel(pixels, 8, 6), [255, 255, 255, 128], 'overlapping opaque outline and shadow must not apply half-opacity twice');
  assert.deepEqual(pixel(pixels, 5, 5), pixel(outlined, 5, 5));
  assert.ok(pixel(pixels, 10, 6)[3] > 0, 'glow reaches beyond the outline');
});

test('effects follow transformed masked alpha while retaining canvas-unit offsets and original inspection views', async (t) => {
  const { native, document: original } = await fixture(t), layerId = original.layers[0].id;
  let document = await edit(native, original, 'transform_layer', { layerId, x: 2, y: 1 });
  document = await edit(native, document, 'set_layer_mask', { layerId, mask: { x: 8, y: 0, width: 1, height: 16 } });
  const originalPreview = await native.execute('get_layer_preview', { documentId: document.id, layerId, view: 'source' });
  document = await edit(native, document, 'set_layer_effects', { layerId, effects: { shadow: { x: 3, y: 0, blur: 0, opacity: 1, color: '#ff0000' } } });
  const pixels = await render(native, document);
  assert.deepEqual(pixel(pixels, 11, 7), [255, 0, 0, 255]); assert.equal(pixel(pixels, 10, 7)[3], 0); assert.equal(pixel(pixels, 12, 7)[3], 0);
  const preview = await native.execute('get_layer_preview', { documentId: document.id, layerId });
  assert.deepEqual(preview.visibleBounds, { x: 8, y: 6, width: 4, height: 3 });
  assert.deepEqual(await sharp(Buffer.from(preview.data, 'base64')).raw().toBuffer(), pixels);
  assert.equal((await native.execute('get_layer_preview', { documentId: document.id, layerId, view: 'source' })).data, originalPreview.data);
  document = await edit(native, document, 'resize_document', { width: 32, height: 32 });
  assert.equal(document.layers[0].effects.shadow.x, 3); assert.equal(document.layers[0].effects.shadow.blur, 0);
});

test('rasterize and cross-document placement keep effects editable and avoid baking or fitting their decorative bounds', async (t) => {
  const { native, document: original } = await fixture(t), layerId = original.layers[0].id;
  let sourceDocument = await edit(native, original, 'set_layer_effects', { layerId, effects: { shadow: { x: 4, y: 0, blur: 0, opacity: 1 } } });
  sourceDocument = await edit(native, sourceDocument, 'set_layer_outline', { layerId, width: 1 });
  let target = (await native.execute('create_document', { width: 16, height: 16 })).document;
  target = await edit(native, target, 'place_layer', { sourceDocumentId: sourceDocument.id, sourceLayerId: layerId, x: 2, y: 2, width: 3, height: 3 });
  const placed = target.layers.at(-1);
  assert.deepEqual(placed.placement.sourceBounds, { left: 5, top: 5, width: 3, height: 3 });
  assert.deepEqual(placed.effects, sourceDocument.layers[0].effects); assert.equal(placed.sourceAsset, original.layers[0].sourceAsset);
  assert.deepEqual(pixel(await native.renderLayer(placed), 2, 2), pixel(source, 5, 5));
  target = await edit(native, target, 'add_shape', { shape: 'rectangle', x: 3, y: 3, width: 2, height: 2, fill: '#55aaff' });
  const shapeId = target.layers.at(-1).id;
  target = await edit(native, target, 'set_layer_effects', { layerId: shapeId, effects: { shadow: { blur: 1, x: 2, y: 3 }, glow: { blur: 2 } } });
  const before = await render(native, target), effects = target.layers.at(-1).effects;
  target = await edit(native, target, 'rasterize_layer', { layerId: shapeId });
  assert.equal(target.layers.at(-1).type, 'raster'); assert.deepEqual(target.layers.at(-1).effects, effects);
  assert.deepEqual(await render(native, target), before);
  target = await edit(native, target, 'set_layer_effects', { layerId: shapeId, effects: null });
  assert.equal(target.layers.at(-1).effects, undefined); assert.notDeepEqual(await render(native, target), before);
});

test('shadows on other layers and generated layers cannot alter protected lower subject pixels', async (t) => {
  const { native, document: original } = await fixture(t), layerId = original.layers[0].id;
  let document = await edit(native, original, 'set_layer_protection', { layerId, protected: true });
  const before = await render(native, document);
  document = await edit(native, document, 'add_shape', { shape: 'rectangle', x: 1, y: 5, width: 2, height: 3, fill: '#777777' });
  document = await edit(native, document, 'set_layer_effects', { layerId: document.layers.at(-1).id, effects: { shadow: { x: 4, y: 0, blur: 0, opacity: 1, color: '#ff0000' } } });
  let after = await render(native, document);
  for (let i = 0; i < source.length; i += 4) if (source[i + 3]) assert.deepEqual(after.subarray(i, i + 4), before.subarray(i, i + 4));
  const generated = await sharp({ create: { width, height, channels: 4, background: '#00ff00' } }).png().toBuffer();
  document = (await native.installGeneratedImage({ documentId: document.id, expectedRevision: document.revision, data: generated, provenance: { jobId: randomUUID(), mode: 'generate' } })).document;
  document = await edit(native, document, 'set_layer_effects', { layerId: document.layers.at(-1).id, effects: { shadow: { x: 2, y: 0, blur: 1, opacity: 1 } } });
  after = await render(native, document);
  for (let i = 0; i < source.length; i += 4) if (source[i + 3]) assert.deepEqual(after.subarray(i, i + 4), before.subarray(i, i + 4));
});

test('effects replace rather than merge, clear via empty/null, and invalid edits and transactions are atomic', async (t) => {
  const { native, dataDir, document: original } = await fixture(t), layerId = original.layers[0].id;
  let document = await edit(native, original, 'set_layer_effects', { layerId, effects: { shadow: {}, glow: {} } });
  document = await edit(native, document, 'set_layer_effects', { layerId, effects: { glow: { opacity: 0.3 } } });
  assert.equal(document.layers[0].effects.shadow, undefined); assert.equal(document.layers[0].effects.glow.blur, 8);
  const beforeFile = await fs.readFile(path.join(dataDir, 'projects', `${document.id}.json`)), before = await render(native, document);
  await assert.rejects(edit(native, document, 'set_layer_effects', { layerId, effects: { glow: { blur: 65 } } }), coded('INVALID_ARGUMENT'));
  await assert.rejects(edit(native, document, 'apply_transaction', { operations: [
    { command: 'set_layer_effects', args: { layerId, effects: { shadow: { x: 8 } } } },
    { command: 'set_layer_effects', args: { layerId, effects: { glow: { opacity: 2 } } } },
  ] }), coded('INVALID_ARGUMENT'));
  assert.deepEqual((await native.execute('get_document', { documentId: document.id })).document, document);
  assert.deepEqual(await render(native, document), before); assert.deepEqual(await fs.readFile(path.join(dataDir, 'projects', `${document.id}.json`)), beforeFile);
  document = await edit(native, document, 'set_layer_effects', { layerId, effects: {} }); assert.equal(document.layers[0].effects, undefined);
  document = await edit(native, document, 'add_adjustment', { kind: 'brightness', value: 10 });
  await assert.rejects(edit(native, document, 'set_layer_effects', { layerId: document.layers.at(-1).id, effects: { shadow: {} } }), coded('INVALID_TARGET'));
});

test('same-size placement preserves separate layer opacity and overlapping effect pixels exactly', async (t) => {
  const { native } = await fixture(t);
  const point = Buffer.alloc(21 * 21 * 4); point.set([80, 120, 160, 255], (10 * 21 + 10) * 4);
  const data = await sharp(point, { raw: { width: 21, height: 21, channels: 4 } }).png().toBuffer();
  let sourceDocument = (await native.execute('import_image', { data: data.toString('base64'), mimeType: 'image/png' })).document;
  const sourceLayerId = sourceDocument.layers[0].id;
  sourceDocument = await edit(native, sourceDocument, 'set_layer', { layerId: sourceLayerId, opacity: 0.5 });
  sourceDocument = await edit(native, sourceDocument, 'set_layer_effects', { layerId: sourceLayerId, effects: { shadow: { x: 1, y: 0, blur: 2, opacity: 0.8, color: '#ff0000' }, glow: { blur: 2, opacity: 0.8, color: '#00ff00' } } });
  const before = await render(native, sourceDocument);
  let target = (await native.execute('create_document', { width: 21, height: 21 })).document;
  target = await edit(native, target, 'set_layer', { layerId: target.layers[0].id, visible: false });
  target = await edit(native, target, 'place_layer', { sourceDocumentId: sourceDocument.id, sourceLayerId, x: 10, y: 10, width: 1, height: 1 });
  assert.equal(target.layers.at(-1).opacity, 0.5);
  assert.deepEqual(await render(native, target), before, 'placement must retain alpha and style rounding at every pixel');
});

test('fully protection-clipped generated content casts no ghost shadow or outline', async (t) => {
  const { native, document: original } = await fixture(t);
  let document = (await native.installGeneratedImage({ documentId: original.id, expectedRevision: original.revision, data: png, provenance: { jobId: randomUUID(), mode: 'generate' } })).document;
  const generatedId = document.layers.at(-1).id;
  document = await edit(native, document, 'set_layer_protection', { layerId: original.layers[0].id, protected: true });
  const before = await render(native, document);
  document = await edit(native, document, 'set_layer_effects', { layerId: generatedId, effects: { shadow: { blur: 0, x: 4, y: 0, opacity: 1, color: '#ff0000' }, glow: { blur: 2, opacity: 1 } } });
  document = await edit(native, document, 'set_layer_outline', { layerId: generatedId, width: 1 });
  assert.deepEqual(await render(native, document), before);
});
