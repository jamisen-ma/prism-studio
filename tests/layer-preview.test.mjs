import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';

const width = 64, height = 32;
const source = Buffer.alloc(width * height * 4), alpha = Buffer.alloc(width * height);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  source.set([x * 3, y * 5, 80, 255], (y * width + x) * 4);
  if (x >= 20 && x < 44 && y >= 8 && y < 24) alpha[y * width + x] = 255;
}
source[(15 * width + 30) * 4 + 3] = 128; alpha[15 * width + 30] = 128;
const png = await sharp(source, { raw: { width, height, channels: 4 } }).png().toBuffer();
const pixel = (pixels, x, y, w = width) => [...pixels.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)];
const decoded = async (preview) => sharp(Buffer.from(preview.data, 'base64')).ensureAlpha().raw().toBuffer();
const coded = (code) => (cause) => cause.code === code;
const edit = async (native, document, command, args) => (await native.execute(command, { documentId: document.id, expectedRevision: document.revision, ...args })).document;
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-layer-preview-'));
  const native = await new NativeBackend({ dataDir, segmentSubject: async () => ({ alpha: Buffer.from(alpha), width, height, model: 'birefnet-general-lite' }) }).init();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const document = (await native.execute('import_image', { data: png.toString('base64'), mimeType: 'image/png', name: 'Original source' })).document;
  return { native, dataDir, document };
}
function preview(native, document, layerId, view = 'layer', maxWidth) {
  return native.execute('get_layer_preview', { documentId: document.id, layerId, view, ...(maxWidth === undefined ? {} : { maxWidth }) });
}

test('isolated layer preview includes geometry, soft alpha, mask, opacity and outside outline without other layers', async (t) => {
  const { native, document: original } = await fixture(t);
  let document = await edit(native, original, 'extract_subject', { layerId: original.layers[0].id, protect: false });
  const layerId = document.layers[1].id;
  document = await edit(native, document, 'transform_layer', { layerId, x: 2, y: 1 });
  document = await edit(native, document, 'set_layer_mask', { layerId, mask: { x: 0, y: 0, width: 40, height: 32 } });
  document = await edit(native, document, 'set_layer_outline', { layerId, width: 1, color: '#ffffff' });
  document = await edit(native, document, 'set_layer', { layerId, visible: false, opacity: 0.5 });
  document = await edit(native, document, 'add_shape', { shape: 'rectangle', x: 0, y: 0, width, height, fill: '#00ff00' });
  const result = await preview(native, document, layerId), pixels = await decoded(result);
  assert.equal(result.view, 'layer'); assert.equal(result.layerId, layerId); assert.equal(result.documentId, document.id); assert.equal(result.revision, document.revision);
  assert.equal(result.width, width); assert.equal(result.height, height); assert.equal(result.sourceWidth, width); assert.equal(result.sourceHeight, height);
  assert.deepEqual(pixel(pixels, 25, 10), [...pixel(source, 23, 9).slice(0, 3), 128]);
  assert.deepEqual(pixel(pixels, 32, 16), [...pixel(source, 30, 15).slice(0, 3), 32]);
  assert.deepEqual(pixel(pixels, 21, 9), [255, 255, 255, 128]);
  assert.equal(pixel(pixels, 43, 16)[3], 0, 'the isolated view must honor the document-coordinate layer mask');
  assert.equal(pixel(pixels, 0, 0)[3], 0, 'the other opaque green layer must not appear');
  const composite = await native.execute('get_preview', { documentId: document.id });
  assert.deepEqual(pixel(await decoded(composite), 25, 10), [0, 255, 0, 255]);
});

test('source and alpha previews expose distinct intrinsic coordinates and remain unaffected by layer edits', async (t) => {
  const { native, document: original } = await fixture(t);
  let document = await edit(native, original, 'extract_subject', { layerId: original.layers[0].id, protect: false });
  const layerId = document.layers[1].id;
  document = await edit(native, document, 'set_layer', { layerId, opacity: 0.25 });
  document = await edit(native, document, 'transform_layer', { layerId, x: 5, y: 3 });
  document = await edit(native, document, 'crop_document', { x: 10, y: 5, width: 40, height: 20 });
  const current = await preview(native, document, layerId), originalView = await preview(native, document, layerId, 'source'), mask = await preview(native, document, layerId, 'mask');
  assert.deepEqual([current.sourceWidth, current.sourceHeight], [40, 20]);
  for (const result of [originalView, mask]) assert.deepEqual([result.width, result.height, result.sourceWidth, result.sourceHeight], [64, 32, 64, 32]);
  assert.deepEqual(await decoded(originalView), source, 'the source view retains every original RGBA byte');
  const maskPixels = await decoded(mask);
  assert.deepEqual(pixel(maskPixels, 30, 15), [128, 128, 128, 255], 'mask view shows source alpha alone, not multiplied by source transparency or layer opacity');
  assert.deepEqual(pixel(maskPixels, 0, 0), [0, 0, 0, 255]);
  assert.deepEqual(pixel(maskPixels, 22, 10), [255, 255, 255, 255]);
});

test('source preview keeps immutable imported pixels after destructive working edits and normalizes EXIF orientation', async (t) => {
  const { native, document: original } = await fixture(t);
  let document = await edit(native, original, 'fill_area', { layerId: original.layers[0].id, color: '#ff0000', opacity: 1 });
  document = await edit(native, document, 'resize_document', { width: 32, height: 16 });
  const image = await preview(native, document, document.layers[0].id, 'source');
  assert.deepEqual(await decoded(image), source); assert.equal(image.sourceWidth, 64);
  const jpeg = await sharp({ create: { width: 8, height: 4, channels: 3, background: '#123456' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const oriented = (await native.execute('import_image', { mimeType: 'image/jpeg', data: jpeg.toString('base64') })).document;
  const orientedSource = await preview(native, oriented, oriented.layers[0].id, 'source');
  assert.deepEqual([orientedSource.width, orientedSource.height, orientedSource.sourceWidth, orientedSource.sourceHeight], [4, 8, 4, 8]);
  assert.deepEqual(await decoded(orientedSource), await decoded(await preview(native, oriented, oriented.layers[0].id)));
});

test('preview sizing is bounded and does not enlarge small images', async (t) => {
  const { native, document } = await fixture(t), layerId = document.layers[0].id;
  for (const view of ['layer', 'source']) {
    const smaller = await preview(native, document, layerId, view, 32);
    assert.deepEqual([smaller.width, smaller.height, smaller.sourceWidth, smaller.sourceHeight], [32, 16, 64, 32]);
    assert.equal((await sharp(Buffer.from(smaller.data, 'base64')).metadata()).width, 32);
    assert.equal((await preview(native, document, layerId, view, 2400)).width, 64);
  }
  for (const maxWidth of [0, 31, 2401, 32.5, Infinity]) await assert.rejects(preview(native, document, layerId, 'layer', maxWidth), coded('INVALID_ARGUMENT'));
});

test('previews serialize behind edits but never change project files, assets, revision or history', async (t) => {
  const { native, dataDir, document } = await fixture(t), layerId = document.layers[0].id;
  const moving = native.execute('transform_layer', { documentId: document.id, expectedRevision: document.revision, layerId, x: 1, y: 0 });
  const inspection = preview(native, document, layerId);
  const updated = (await moving).document; assert.equal((await inspection).revision, updated.revision);
  const projectFile = path.join(dataDir, 'projects', `${document.id}.json`), beforeFile = await fs.readFile(projectFile);
  const assets = await fs.readdir(path.join(dataDir, 'assets'));
  const beforeAssets = await Promise.all(assets.map((asset) => fs.readFile(path.join(dataDir, 'assets', asset))));
  await preview(native, updated, layerId); await preview(native, updated, layerId, 'source');
  assert.deepEqual((await native.execute('get_document', { documentId: document.id })).document, updated);
  assert.deepEqual(await fs.readFile(projectFile), beforeFile); assert.deepEqual(await fs.readdir(path.join(dataDir, 'assets')), assets);
  for (let i = 0; i < assets.length; i++) assert.deepEqual(await fs.readFile(path.join(dataDir, 'assets', assets[i])), beforeAssets[i]);
});

test('missing layers, unavailable sources/masks, adjustments and malformed assets produce safe errors', async (t) => {
  const { native, dataDir, document } = await fixture(t), layerId = document.layers[0].id;
  await assert.rejects(preview(native, document, randomUUID()), coded('NOT_FOUND'));
  await assert.rejects(preview(native, { id: randomUUID() }, layerId), coded('NOT_FOUND'));
  await assert.rejects(preview(native, document, layerId, 'mask'), coded('INVALID_TARGET'));
  await assert.rejects(preview(native, document, layerId, 'unknown'), coded('INVALID_ARGUMENT'));
  let solid = (await native.execute('create_document', { width: 32, height: 32 })).document;
  await assert.rejects(preview(native, solid, solid.layers[0].id, 'source'), coded('INVALID_TARGET'));
  solid = await edit(native, solid, 'add_adjustment', { kind: 'brightness', value: 10 });
  for (const view of ['layer', 'source', 'mask']) await assert.rejects(preview(native, solid, solid.layers.at(-1).id, view), coded('INVALID_TARGET'));
  const file = path.join(dataDir, 'assets', document.layers[0].sourceAsset);
  await fs.writeFile(file, 'private invalid image details');
  await assert.rejects(preview(native, document, layerId, 'source'), (cause) => cause.code === 'INVALID_IMAGE' && !cause.message.includes(dataDir) && !cause.message.includes('private'));
  await fs.unlink(file);
  await assert.rejects(preview(native, document, layerId, 'source'), (cause) => cause.code === 'INVALID_IMAGE' && !cause.message.includes(dataDir) && !cause.message.includes('ENOENT'));
});

test('bounds remain intrinsic after preview downsampling and include every nonzero alpha pixel in the correct coordinate space', async (t) => {
  const { native, document: original } = await fixture(t);
  let document = await edit(native, original, 'extract_subject', { layerId: original.layers[0].id });
  const layerId = document.layers[1].id;
  document = await edit(native, document, 'paint_cutout_mask', { layerId, points: [{ x: 59.5, y: 30.5 }], size: 1, hardness: 1, opacity: 1 / 255, mode: 'add' });
  document = await edit(native, document, 'transform_layer', { layerId, x: 3, y: 1 });
  const mask = await preview(native, document, layerId, 'mask', 32), layer = await preview(native, document, layerId, 'layer', 32);
  assert.equal(mask.width, 32); assert.equal(layer.width, 32);
  assert.deepEqual(mask.visibleBounds, { x: 20, y: 8, width: 40, height: 23 }); assert.equal(mask.boundsSpace, 'source');
  assert.deepEqual(layer.visibleBounds, { x: 23, y: 9, width: 40, height: 23 }); assert.equal(layer.boundsSpace, 'document');
  assert.deepEqual((await preview(native, document, layerId, 'layer', 2400)).visibleBounds, layer.visibleBounds);
  assert.deepEqual((await preview(native, document, layerId, 'mask', 2400)).visibleBounds, mask.visibleBounds);
  const sourcePreview = await preview(native, document, layerId, 'source', 32);
  assert.equal(Object.hasOwn(sourcePreview, 'visibleBounds'), false); assert.equal(Object.hasOwn(sourcePreview, 'boundsSpace'), false);
});

test('empty masks and transparent layer previews return null bounds without inventing a canvas-sized selection', async (t) => {
  const { native, document: original } = await fixture(t);
  let document = await edit(native, original, 'extract_subject', { layerId: original.layers[0].id });
  const layerId = document.layers[1].id;
  document = await edit(native, document, 'paint_cutout_mask', { layerId, points: [{ x: 20, y: 10 }], size: 1, opacity: 0, mode: 'replace' });
  const mask = await preview(native, document, layerId, 'mask', 32), layer = await preview(native, document, layerId, 'layer', 32);
  assert.equal(mask.visibleBounds, null); assert.equal(mask.boundsSpace, 'source');
  assert.equal(layer.visibleBounds, null); assert.equal(layer.boundsSpace, 'document');
  assert.deepEqual((await decoded(mask)).subarray(0, 4), Buffer.from([0, 0, 0, 255]), 'black mask pixels are displayed opaquely but do not count as selected coverage');
});
