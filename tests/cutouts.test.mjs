import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { NativeBackend } from '../server/native.mjs';
import { GenerationManager } from '../server/generation.mjs';
import { maskCoverage } from '../server/masks.mjs';
import { outsideOutline, combineAlpha } from '../server/cutout-pixels.mjs';

const width = 8, height = 8;
const rgba = Buffer.alloc(width * height * 4);
for (let index = 0; index < width * height; index++) rgba.set([20 + index, 110 + index, 210 - index, 255], index * 4);
rgba[3] = 0;
rgba[(3 * width + 3) * 4 + 3] = 128;
const alpha = Buffer.alloc(width * height);
for (let y = 1; y <= 5; y++) for (let x = 2; x <= 4; x++) alpha[y * width + x] = 255;
alpha[3 * width + 3] = 128;
const png = await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
const blue = await sharp({ create: { width, height, channels: 4, background: '#0000ff' } }).png().toBuffer();
const coded = (code) => (cause) => cause.code === code;
const pixel = (pixels, x, y, canvasWidth = width) => [...pixels.subarray((y * canvasWidth + x) * 4, (y * canvasWidth + x) * 4 + 4)];
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-cutout-test-'));
  const calls = [];
  const segmentSubject = async (input) => {
    const decoded = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    calls.push(decoded);
    assert.equal(decoded.info.width, width); assert.equal(decoded.info.height, height);
    return { alpha: Buffer.from(alpha), width, height, model: 'birefnet-general-lite' };
  };
  const native = await new NativeBackend({ dataDir, segmentSubject }).init();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const document = (await native.execute('import_image', { data: png.toString('base64'), mimeType: 'image/png', name: 'Source photograph' })).document;
  return { native, dataDir, document, calls, segmentSubject };
}
const edit = async (native, document, command, args = {}) => (await native.execute(command, { documentId: document.id, expectedRevision: document.revision, ...args })).document;
const extract = (native, document, args = {}) => edit(native, document, 'extract_subject', { layerId: document.layers[0].id, ...args });
const pixels = (native, document) => native.render(native.project(document.id));

test('extraction stores separate alpha while preserving every source RGB byte, originals and reversible history', async (t) => {
  const { native, dataDir, document: original, calls } = await fixture(t);
  const document = await extract(native, original);
  const layer = document.layers[1], source = original.layers[0];
  assert.equal(layer.asset, source.asset); assert.equal(layer.sourceAsset, source.sourceAsset);
  assert.equal(layer.role, 'cutout'); assert.equal(layer.protected, true); assert.equal(document.layers[0].visible, false);
  assert.equal(layer.provenance, undefined); assert.ok(layer.alphaAsset); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].data, rgba);
  const cutout = await native.renderLayer(layer);
  for (let i = 0; i < alpha.length; i++) {
    assert.deepEqual(cutout.subarray(i * 4, i * 4 + 3), rgba.subarray(i * 4, i * 4 + 3));
    assert.equal(cutout[i * 4 + 3], Math.round(rgba[i * 4 + 3] * alpha[i] / 255));
  }
  assert.deepEqual(await fs.readFile(path.join(dataDir, 'assets', source.sourceAsset)), png);
  assert.deepEqual(await native.readAlpha(layer.alphaAsset, width, height), alpha);
  const undone = await edit(native, document, 'undo');
  assert.equal(undone.layers.length, 1); assert.equal(undone.layers[0].visible, true);
  const redone = await edit(native, undone, 'redo');
  assert.equal(redone.layers[1].alphaAsset, layer.alphaAsset);
  assert.deepEqual(await native.renderLayer(redone.layers[1]), cutout);
});

test('subject selection intersects source transparency and failed extraction transactions preserve the complete graph', async (t) => {
  const { native, document: original } = await fixture(t);
  const selected = await edit(native, original, 'select_subject', { layerId: original.layers[0].id });
  assert.equal(selected.selection.shape, 'bitmap');
  const coverage = maskCoverage(selected.selection);
  assert.equal(coverage(3, 3), 64 / 255); assert.equal(coverage(2, 1), 1); assert.equal(coverage(0, 0), 0);
  await assert.rejects(native.execute('apply_transaction', { documentId: selected.id, expectedRevision: selected.revision, operations: [
    { command: 'extract_subject', args: { layerId: selected.layers[0].id } },
    { command: 'set_layer_outline', args: { layerId: selected.layers[0].id, width: 65 } },
  ] }), coded('INVALID_ARGUMENT'));
  assert.deepEqual((await native.execute('get_document', { documentId: selected.id })).document, selected);
});

test('cross-document placement keeps full subject bounds and exact 1:1 pixels, with proportional scaling and one undo step', async (t) => {
  const { native, document: original } = await fixture(t);
  const source = await extract(native, original), cutout = source.layers[1];
  let target = (await native.execute('create_document', { name: 'Layout', width: 12, height: 12, background: '#445566' })).document;
  await assert.rejects(edit(native, target, 'place_layer', { sourceDocumentId: source.id, sourceLayerId: cutout.id, sourceExpectedRevision: source.revision - 1, x: 3, y: 2, width: 3, height: 5 }), coded('REVISION_CONFLICT'));
  assert.deepEqual((await native.execute('get_document', { documentId: target.id })).document, target);
  target = await edit(native, target, 'place_layer', { sourceDocumentId: source.id, sourceLayerId: cutout.id, sourceExpectedRevision: source.revision, x: 3, y: 2, width: 3, height: 5 });
  const layer = target.layers[1], placed = await native.renderLayer(layer), sourcePixels = await native.renderLayer(cutout);
  assert.equal(layer.sourceAsset, cutout.sourceAsset); assert.equal(layer.protected, true);
  assert.deepEqual(layer.placement, { x: 3, y: 2, width: 3, height: 5, sourceBounds: { left: 2, top: 1, width: 3, height: 5 } });
  for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) assert.deepEqual(pixel(placed, x + 3, y + 2, 12), pixel(sourcePixels, x + 2, y + 1));
  assert.equal(pixel(placed, 2, 2, 12)[3], 0);
  const before = await pixels(native, target);
  target = await edit(native, target, 'add_adjustment', { kind: 'brightness', value: 40 });
  const after = await pixels(native, target);
  assert.deepEqual(pixel(after, 4, 4, 12), pixel(before, 4, 4, 12), 'soft subject pixels remain unchanged by global adjustments');
  assert.notDeepEqual(pixel(after, 0, 0, 12), pixel(before, 0, 0, 12));
  const scaled = await edit(native, target, 'place_layer', { sourceDocumentId: source.id, sourceLayerId: cutout.id, x: 0, y: 0, width: 10, height: 10 });
  assert.equal(scaled.layers.at(-1).placement.width, 6); assert.equal(scaled.layers.at(-1).placement.height, 10);
  assert.equal(scaled.layers.at(-1).placement.x, 2);
  assert.equal((await edit(native, scaled, 'undo')).layers.length, target.layers.length);
});

test('outside outlines preserve all subject pixels including translucent edges and survive reopen and geometry edits', async (t) => {
  const { native, dataDir, segmentSubject, document: original } = await fixture(t);
  let document = await extract(native, original);
  const before = await pixels(native, document);
  document = await edit(native, document, 'set_layer_outline', { layerId: document.layers[1].id, width: 1, color: '#ffffff' });
  const after = await pixels(native, document);
  for (let i = 0; i < alpha.length; i++) if (before[i * 4 + 3]) assert.deepEqual(after.subarray(i * 4, i * 4 + 4), before.subarray(i * 4, i * 4 + 4));
  assert.deepEqual(pixel(after, 1, 1), [255, 255, 255, 255]);
  assert.deepEqual(pixel(after, 3, 3), pixel(before, 3, 3));
  const reopened = await new NativeBackend({ dataDir, segmentSubject }).init();
  assert.equal(reopened.loadWarnings.length, 0); assert.deepEqual(await pixels(reopened, document), after);
  document = await edit(reopened, document, 'resize_document', { width: 16, height: 16 });
  assert.equal((await pixels(reopened, document)).length, 16 * 16 * 4);
  document = await edit(reopened, document, 'undo');
  assert.deepEqual(await pixels(reopened, document), after);
});

test('AI snapshots and application exclude both captured and current protected footprints, including soft edges and outlines', async (t) => {
  const { native, document: original } = await fixture(t);
  let document = await extract(native, original);
  const cutoutId = document.layers[1].id;
  document = await edit(native, document, 'set_layer_outline', { layerId: cutoutId, width: 1 });
  const snapshot = await native.snapshotForGeneration({ documentId: document.id, expectedRevision: document.revision, scope: 'canvas' });
  const mask = await sharp(snapshot.mask).ensureAlpha().raw().toBuffer();
  assert.equal(pixel(mask, 3, 3)[3], 255); assert.equal(pixel(mask, 1, 1)[3], 255); assert.equal(pixel(mask, 7, 7)[3], 0);
  document = await edit(native, document, 'transform_layer', { layerId: cutoutId, x: 2, y: 0 });
  const before = await pixels(native, document), protectedNow = await native.protectedPixels(document);
  await assert.rejects(native.installGeneratedImage({ documentId: document.id, expectedRevision: snapshot.revision, data: blue, mask: snapshot.mask, provenance: { mode: 'edit' } }), coded('REVISION_CONFLICT'));
  document = (await native.installGeneratedImage({ documentId: document.id, expectedRevision: document.revision, data: blue, mask: snapshot.mask, provenance: { mode: 'edit', jobId: randomUUID() } })).document;
  const after = await pixels(native, document), generated = await native.renderLayer(document.layers.at(-1));
  for (let i = 0; i < alpha.length; i++) {
    if (protectedNow[i]) assert.deepEqual(after.subarray(i * 4, i * 4 + 4), before.subarray(i * 4, i * 4 + 4));
    if (protectedNow[i] || mask[i * 4 + 3] === 255) assert.equal(generated[i * 4 + 3], 0);
  }
  assert.deepEqual(pixel(after, 7, 7), [0, 0, 255, 255]);
  const undo = await edit(native, document, 'undo'); assert.deepEqual(await pixels(native, undo), before);
});

test('protected pixels reject destructive edits; explicit unprotection bakes alpha once for paint and fill', async (t) => {
  const { native, document: original } = await fixture(t);
  let document = await extract(native, original), layerId = document.layers[1].id;
  for (const [command, args] of [
    ['paint_stroke', { tool: 'brush', points: [{ x: 3, y: 3 }], size: 2, color: '#ff0000' }],
    ['fill_area', { color: '#ff0000' }], ['delete_layer', {}], ['set_layer', { blendMode: 'multiply' }],
  ]) await assert.rejects(edit(native, document, command, { layerId, ...args }), coded('PROTECTED_LAYER'));
  document = await edit(native, document, 'set_layer_protection', { layerId, protected: false });
  document = await edit(native, document, 'transform_layer', { layerId, x: 1, y: 0 });
  const before = await native.renderLayer(document.layers[1]);
  document = await edit(native, document, 'paint_stroke', { layerId, tool: 'brush', points: [{ x: 0, y: 0 }], size: 1, hardness: 1, color: '#ff0000', opacity: 0 });
  assert.equal(document.layers[1].alphaAsset, undefined); assert.equal(document.layers[1].transforms.length, 0);
  assert.deepEqual(await native.renderLayer(document.layers[1]), before);
  document = await edit(native, document, 'undo');
  document = await edit(native, document, 'fill_area', { layerId, color: '#00ff00', opacity: 0 });
  assert.equal(document.layers[1].alphaAsset, undefined); assert.deepEqual(await native.renderLayer(document.layers[1]), before);
});

test('generation into a protected document sends no input/mask to the generation provider and clips its retained result locally', async (t) => {
  const { native, dataDir, document: original } = await fixture(t);
  const document = await extract(native, original);
  const before = await pixels(native, document);
  let calls = 0;
  const manager = await new GenerationManager({ dataDir, native, getKey: async () => 'injected-unit-test-key', provider: async (args) => {
    calls++; assert.equal(args.image, undefined); assert.equal(args.mask, undefined);
    return { data: blue, mimeType: 'image/png', model: args.model };
  } }).init();
  t.after(() => manager.close());
  const { job } = await manager.start({ provider: 'openai', mode: 'generate', prompt: 'Test blue background', documentId: document.id, expectedRevision: document.revision });
  const deadline = Date.now() + 4000;
  while (!['succeeded', 'failed'].includes(manager.get(job.id).job.status) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(manager.get(job.id).job.status, 'succeeded', JSON.stringify(manager.get(job.id).job)); assert.equal(calls, 1);
  const after = await pixels(native, document);
  for (let i = 0; i < alpha.length; i++) if (before[i * 4 + 3]) assert.deepEqual(after.subarray(i * 4, i * 4 + 4), before.subarray(i * 4, i * 4 + 4));
  assert.deepEqual(pixel(after, 7, 7), [0, 0, 255, 255]);
});

test('cutout pixel helpers never modify invisible RGB and outside outlines use bounded Euclidean distances', () => {
  assert.deepEqual(combineAlpha(rgba, alpha), (() => { const result = Buffer.from(rgba); for (let i = 0; i < alpha.length; i++) result[i * 4 + 3] = Math.round(result[i * 4 + 3] * alpha[i] / 255); return result; })());
  const point = Buffer.alloc(7 * 7 * 4); point.set([18, 25, 92, 1], (3 * 7 + 3) * 4);
  const original = Buffer.from(point), outline = outsideOutline(point, 7, 7, { width: 2, color: '#ffffff' });
  assert.deepEqual(point, original); assert.equal(pixel(outline, 3, 3, 7)[3], 0);
  assert.equal(pixel(outline, 5, 3, 7)[3], 255); assert.equal(pixel(outline, 6, 3, 7)[3], 0);
  assert.equal(pixel(outline, 5, 5, 7)[3], Math.round(255 * (3 - Math.sqrt(8))));
});

test('AI protection follows subjects and generated layers after installation, including later reorder and reopen', async (t) => {
  const { native, dataDir, segmentSubject, document: original } = await fixture(t);
  let document = await extract(native, original), cutoutId = document.layers[1].id;
  document = (await native.installGeneratedImage({ documentId: document.id, expectedRevision: document.revision, data: blue, provenance: { mode: 'generate', jobId: randomUUID() } })).document;
  const generatedId = document.layers.at(-1).id;
  document = await edit(native, document, 'transform_layer', { layerId: cutoutId, x: 2, y: 1 });
  document = await edit(native, document, 'transform_layer', { layerId: generatedId, x: 1, y: 0, scaleX: 1.2, scaleY: 1.2 });
  document = await edit(native, document, 'reorder_layer', { layerId: generatedId, index: 0 });
  document = await edit(native, document, 'reorder_layer', { layerId: generatedId, index: 2 });
  const graphWithoutAI = { ...document, layers: document.layers.filter((layer) => layer.id !== generatedId) };
  const sourceOnly = await native.renderGraph(graphWithoutAI), after = await pixels(native, document);
  const protectedPixels = await native.protectedPixels(document);
  for (let i = 0; i < protectedPixels.length; i++) if (protectedPixels[i]) assert.deepEqual(after.subarray(i * 4, i * 4 + 4), sourceOnly.subarray(i * 4, i * 4 + 4));
  assert.equal(protectedPixels[4 * width + 5], 1, 'translucent subject pixel moved to its new location');
  const reopened = await new NativeBackend({ dataDir, segmentSubject }).init();
  assert.deepEqual(await pixels(reopened, document), after);
});

test('painting and filling other raster layers cannot cover protected subjects or change their translucent appearance', async (t) => {
  const { native, document: original } = await fixture(t);
  let document = await extract(native, original);
  document = await edit(native, document, 'add_paint_layer', { name: 'Overlay paint' });
  const paintId = document.layers.at(-1).id, before = await pixels(native, document), protectedPixels = await native.protectedPixels(document);
  document = await edit(native, document, 'paint_stroke', { layerId: paintId, tool: 'brush', points: [{ x: 4, y: 4 }], size: 12, hardness: 1, opacity: 1, color: '#ff0000' });
  let after = await pixels(native, document);
  for (let i = 0; i < protectedPixels.length; i++) if (protectedPixels[i]) assert.deepEqual(after.subarray(i * 4, i * 4 + 4), before.subarray(i * 4, i * 4 + 4));
  assert.deepEqual(pixel(after, 0, 0), [255, 0, 0, 255]);
  document = await edit(native, document, 'fill_area', { layerId: paintId, color: '#00ff00', opacity: 1 });
  after = await pixels(native, document);
  for (let i = 0; i < protectedPixels.length; i++) if (protectedPixels[i]) assert.deepEqual(after.subarray(i * 4, i * 4 + 4), before.subarray(i * 4, i * 4 + 4));
  assert.deepEqual(pixel(after, 0, 0), [0, 255, 0, 255]);
});

test('generate-mode retained output applies to a resized protected canvas without an obsolete edit mask', async (t) => {
  const { native, dataDir, document: original } = await fixture(t);
  let document = await extract(native, original), release;
  const started = new Promise((resolve) => { release = resolve; });
  const manager = await new GenerationManager({ dataDir, native, getKey: async () => 'injected-unit-test-key', provider: async (args) => {
    assert.equal(args.image, undefined); assert.equal(args.mask, undefined);
    await started; return { data: blue, mimeType: 'image/png', model: args.model };
  } }).init();
  t.after(() => manager.close());
  const { job } = await manager.start({ provider: 'openai', mode: 'generate', prompt: 'Test background', documentId: document.id, expectedRevision: document.revision });
  document = await edit(native, document, 'resize_document', { width: 16, height: 16 });
  release();
  const deadline = Date.now() + 4000;
  while (!(manager.get(job.id).job.status === 'ready' && manager.get(job.id).job.error) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(manager.get(job.id).job.error?.code, 'REVISION_CONFLICT');
  const applied = await manager.apply({ jobId: job.id, expectedRevision: document.revision });
  assert.equal(applied.job.status, 'succeeded'); assert.equal(applied.document.width, 16); assert.equal(applied.document.height, 16);
  const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'generation', 'jobs', `${job.id}.json`), 'utf8'));
  assert.equal(saved.maskAsset, undefined);
});

test('explicitly protected generated duplicates retain normal stacking without mutually erasing each other', async (t) => {
  const { native } = await fixture(t);
  let document = (await native.installGeneratedImage({ data: blue, provenance: { mode: 'generate', jobId: randomUUID() } })).document;
  document = await edit(native, document, 'set_layer_protection', { layerId: document.layers[0].id, protected: true });
  const before = await pixels(native, document);
  document = await edit(native, document, 'duplicate_layer', { layerId: document.layers[0].id });
  assert.equal(document.layers[1].protected, true); assert.deepEqual(await pixels(native, document), before);
  assert.deepEqual(pixel(await pixels(native, document), 0, 0), [0, 0, 255, 255]);
});

test('cutout alpha refinement restores missed original RGB, hides pixels reversibly and respects original transparency while protected', async (t) => {
  const { native, dataDir, segmentSubject, document: original } = await fixture(t);
  let document = await extract(native, original), layerId = document.layers[1].id;
  const initialLayer = document.layers[1], initial = await native.renderLayer(initialLayer);
  assert.equal(pixel(initial, 5, 3)[3], 0);
  document = await edit(native, document, 'paint_cutout_mask', { layerId, mode: 'add', points: [{ x: 5.5, y: 3.5 }], size: 1 });
  let layer = document.layers[1], restored = await native.renderLayer(layer);
  assert.deepEqual(pixel(restored, 5, 3), pixel(rgba, 5, 3));
  assert.equal(layer.asset, initialLayer.asset); assert.equal(layer.sourceAsset, initialLayer.sourceAsset); assert.equal(layer.protected, true);
  assert.notEqual(layer.alphaAsset, initialLayer.alphaAsset);
  document = await edit(native, document, 'paint_cutout_mask', { layerId, mode: 'subtract', points: [{ x: 2.5, y: 1.5 }], size: 1 });
  restored = await native.renderLayer(document.layers[1]); assert.equal(pixel(restored, 2, 1)[3], 0);
  assert.deepEqual(pixel(restored, 2, 1).slice(0, 3), pixel(rgba, 2, 1).slice(0, 3));
  document = await edit(native, document, 'paint_cutout_mask', { layerId, mode: 'add', points: [{ x: 0.5, y: 0.5 }], size: 1 });
  restored = await native.renderLayer(document.layers[1]); assert.equal(pixel(restored, 0, 0)[3], 0, 'source transparency still bounds final alpha');
  document = await edit(native, document, 'paint_cutout_mask', { layerId, mode: 'replace', points: [{ x: 5.5, y: 3.5 }], size: 1 });
  restored = await native.renderLayer(document.layers[1]); assert.equal(pixel(restored, 3, 3)[3], 0); assert.deepEqual(pixel(restored, 5, 3), pixel(rgba, 5, 3));
  document = await edit(native, document, 'undo');
  assert.equal(pixel(await native.renderLayer(document.layers[1]), 3, 3)[3], 64);
  const reopened = await new NativeBackend({ dataDir, segmentSubject }).init();
  assert.deepEqual(await pixels(reopened, document), await pixels(native, document));
  document = await edit(native, document, 'transform_layer', { layerId, x: 1, y: 0 });
  await assert.rejects(edit(native, document, 'paint_cutout_mask', { layerId, points: [{ x: 5, y: 3 }], size: 1 }), (cause) => cause.code === 'INVALID_TARGET' && cause.message.includes('before placement'));
  assert.deepEqual((await native.execute('get_document', { documentId: document.id })).document, document);
});

test('a generated background beneath protected original cutouts remains opaque through translucent subject edges', async (t) => {
  const { native, document: original } = await fixture(t);
  const source = await extract(native, original);
  let document = (await native.installGeneratedImage({ data: blue, provenance: { mode: 'generate', jobId: randomUUID() } })).document;
  document = await edit(native, document, 'add_adjustment', { kind: 'brightness', value: 20 });
  document = await edit(native, document, 'place_layer', { sourceDocumentId: source.id, sourceLayerId: source.layers[1].id, x: 2, y: 1, width: 3, height: 5, protect: false });
  const before = await pixels(native, document);
  document = await edit(native, document, 'set_layer_protection', { layerId: document.layers.at(-1).id, protected: true });
  const after = await pixels(native, document);
  assert.deepEqual(after, before, 'protecting a cutout must preserve existing background compositing and lower adjustments');
  assert.equal(pixel(after, 3, 3)[3], 255, 'translucent original pixels remain composited onto the opaque AI background');
  assert.notDeepEqual(pixel(after, 3, 3).slice(0, 3), pixel(await native.renderLayer(document.layers.at(-1)), 3, 3).slice(0, 3), 'background contributes through soft edges');
});

async function rejectProtectedWithoutChanges(native, document, command, args) {
  const preview = await native.execute('get_preview', { documentId: document.id });
  await assert.rejects(edit(native, document, command, args), (cause) => cause.code === 'PROTECTED_LAYER' && /Unprotect.*explicitly/.test(cause.message));
  assert.deepEqual((await native.execute('get_document', { documentId: document.id })).document, document, 'rejected edits must not change revision, layer graph or history');
  assert.deepEqual(await native.execute('get_preview', { documentId: document.id }), preview, 'rejected edits must not change any preview byte');
}

test('protected layers reject changed opacity and nonuniform transform scales atomically, including defaulted axes', async (t) => {
  const { native, document: original } = await fixture(t);
  let document = await extract(native, original), layerId = document.layers[1].id;
  await rejectProtectedWithoutChanges(native, document, 'set_layer', { layerId, name: 'Must roll back', visible: false, opacity: 0.5 });
  await rejectProtectedWithoutChanges(native, document, 'transform_layer', { layerId, x: 0, y: 0, scaleX: 2, scaleY: 1 });
  await rejectProtectedWithoutChanges(native, document, 'transform_layer', { layerId, x: 1, y: 2, scaleX: 2 });
  await rejectProtectedWithoutChanges(native, document, 'transform_layer', { layerId, x: 0, y: 0, scaleY: 0.5 });
  const before = await pixels(native, document);
  document = await edit(native, document, 'set_layer', { layerId, opacity: document.layers[1].opacity });
  assert.deepEqual(await pixels(native, document), before, 'identical opacity remains an allowed no-op');
  document = await edit(native, document, 'transform_layer', { layerId, x: 1, y: 0, scaleX: 0.75, scaleY: 0.75, rotation: 30 });
  assert.equal(document.layers[1].protected, true);
  assert.equal(document.layers[1].transforms.at(-1).scaleX, document.layers[1].transforms.at(-1).scaleY);
  document = await edit(native, document, 'set_layer', { layerId, visible: false });
  document = await edit(native, document, 'set_layer_mask', { layerId, mask: { x: 1, y: 1, width: 6, height: 6 } });
  assert.equal(document.layers[1].visible, false); assert.ok(document.layers[1].mask);
  document = await edit(native, document, 'set_layer_protection', { layerId, protected: false });
  document = await edit(native, document, 'set_layer', { layerId, opacity: 0.5, visible: true });
  document = await edit(native, document, 'transform_layer', { layerId, x: 0, y: 0, scaleX: 2, scaleY: 0.5 });
  assert.equal(document.layers[1].opacity, 0.5); assert.equal(document.layers[1].transforms.at(-1).scaleY, 0.5);
});

test('document stretch cannot bypass hidden or fully masked protection, while explicit unprotection permits it', async (t) => {
  const { native, document: original } = await fixture(t);
  let document = await extract(native, original), layerId = document.layers[1].id;
  await rejectProtectedWithoutChanges(native, document, 'resize_document', { width: 16, height: 8 });
  await rejectProtectedWithoutChanges(native, document, 'resize_document', { width: 16, height: 15 });
  document = await edit(native, document, 'set_layer', { layerId, visible: false });
  await rejectProtectedWithoutChanges(native, document, 'resize_document', { width: 16, height: 12 });
  document = await edit(native, document, 'set_layer', { layerId, visible: true });
  document = await edit(native, document, 'set_layer_mask', { layerId, mask: { x: 0, y: 0, width: 8, height: 8, invert: true } });
  assert.equal((await native.protectedPixels(document)).some((value) => value > 0), false);
  await rejectProtectedWithoutChanges(native, document, 'resize_document', { width: 16, height: 12 });
  document = await edit(native, document, 'set_layer_protection', { layerId, protected: false });
  document = await edit(native, document, 'resize_document', { width: 16, height: 12 });
  assert.equal(document.width, 16); assert.equal(document.height, 12);
});

test('protected content allows proportional raster rounding and canvas bounds changes without stretching', async (t) => {
  const { native, document: original } = await fixture(t);
  let document = await extract(native, original);
  const before = await pixels(native, document);
  document = await edit(native, document, 'resize_canvas', { width: 13, height: 10, anchor: 'top-left' });
  const expanded = await pixels(native, document);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) assert.deepEqual(pixel(expanded, x, y, 13), pixel(before, x, y));
  document = await edit(native, document, 'crop_document', { x: 0, y: 0, width: 8, height: 8 });
  assert.deepEqual(await pixels(native, document), before);
  document = await edit(native, document, 'resize_document', { width: 16, height: 16 });
  assert.equal(document.layers[1].protected, true); assert.equal((await pixels(native, document)).length, 16 * 16 * 4);

  for (const [sourceWidth, sourceHeight, nextWidth, nextHeight] of [[3, 2, 7, 5], [2, 3, 5, 7], [4, 2, 7, 4]]) {
    let small = (await native.execute('create_document', { width: sourceWidth, height: sourceHeight, background: '#234567' })).document;
    small = await edit(native, small, 'set_layer_protection', { layerId: small.layers[0].id, protected: true });
    small = await edit(native, small, 'resize_document', { width: nextWidth, height: nextHeight });
    assert.equal(small.width, nextWidth); assert.equal(small.height, nextHeight);
    assert.equal(pixel(await pixels(native, small), 0, 0, nextWidth)[3], 255);
  }
  let tiny = (await native.execute('create_document', { width: 3, height: 2, background: '#234567' })).document;
  tiny = await edit(native, tiny, 'set_layer_protection', { layerId: tiny.layers[0].id, protected: true });
  await rejectProtectedWithoutChanges(native, tiny, 'resize_document', { width: 7, height: 6 });
});
