import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { commandSchemas } from '../shared/commands.mjs';
import { maskCoverage } from '../server/masks.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-cutout-selection-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const width = 10, height = 8;
  const rgba = Buffer.alloc(width * height * 4);
  const alpha = Buffer.alloc(width * height);
  for (let i = 0; i < alpha.length; i++) {
    rgba.set([i + 30, 220 - i, 90 + i, i === 0 ? 0 : i === 1 ? 128 : 255], i * 4);
    alpha[i] = i % 4 === 0 ? 0 : i % 4 === 1 ? 64 : 255;
  }
  const original = await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const native = await new NativeBackend({ dataDir: directory, segmentSubject: async () => ({ alpha, width, height, model: 'fixture' }) }).init();
  let document = (await native.execute('import_image', { name: 'Preserved source', mimeType: 'image/png', data: original.toString('base64') })).document;
  document = (await native.execute('extract_subject', { documentId: document.id, layerId: document.layers[0].id })).document;
  return { directory, native, document, rgba, original, alpha, width, height };
}
async function command(native, document, name, args = {}) {
  return (await native.execute(name, { documentId: document.id, expectedRevision: document.revision, ...args })).document;
}

test('selection refinement restores source details and handles feathered add/subtract/intersect/replace without changing RGB', async t => {
  const { directory, native, rgba, original, alpha, width, height, document: initial } = await fixture(t);
  const document = await command(native, initial, 'select_region', { shape: 'ellipse', x: 0, y: 0, width: 7, height: 6, feather: 1.5 });
  const before = document.layers.at(-1);
  const selected = maskCoverage(document.selection);
  for (const mode of ['add', 'subtract', 'intersect', 'replace']) {
    const latest = (await native.execute('get_document', { documentId: document.id })).document;
    const result = await command(native, latest, 'refine_cutout_from_selection', { layerId: before.id, mode });
    const layer = result.layers.at(-1);
    assert.equal(layer.asset, before.asset);
    assert.equal(layer.sourceAsset, before.sourceAsset);
    assert.equal(layer.protected, true);
    const changedAlpha = await native.readAlpha(layer.alphaAsset, width, height);
    const pixels = await native.renderLayer(layer);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = y * width + x, coverage = selected(x, y);
      const expected = mode === 'add' ? Math.max(alpha[i], Math.round(255 * coverage))
        : mode === 'subtract' ? Math.round(alpha[i] * (1 - coverage))
        : mode === 'intersect' ? Math.round(alpha[i] * coverage) : Math.round(255 * coverage);
      assert.equal(changedAlpha[i], expected);
      assert.deepEqual(pixels.subarray(i * 4, i * 4 + 3), rgba.subarray(i * 4, i * 4 + 3));
      assert.equal(pixels[i * 4 + 3], Math.round(rgba[i * 4 + 3] * expected / 255));
    }
    assert.deepEqual(result.selection, document.selection);
    const reopened = await new NativeBackend({ dataDir: directory }).init();
    const saved = (await reopened.execute('get_document', { documentId: result.id })).document;
    assert.deepEqual(await reopened.renderLayer(saved.layers.at(-1)), pixels);
    const undone = await command(native, result, 'undo');
    assert.equal(undone.layers.at(-1).alphaAsset, before.alphaAsset);
  }
  assert.deepEqual(await fs.readFile(path.join(directory, 'assets', before.sourceAsset)), original);
});

test('lasso restoration covers a missed accessory while background stays hidden and original alpha remains authoritative', async t => {
  const { native, document: initial, rgba } = await fixture(t);
  let document = await command(native, initial, 'select_region', {
    shape: 'polygon', points: [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 3 }, { x: 0, y: 3 }],
  });
  const before = document.layers.at(-1);
  const oldAlpha = await native.readAlpha(before.alphaAsset, document.width, document.height);
  document = await command(native, document, 'refine_cutout_from_selection', { layerId: before.id, mode: 'add' });
  const restored = await native.renderLayer(document.layers.at(-1));
  assert.deepEqual(restored.subarray(0, 4), rgba.subarray(0, 4), 'A fully transparent original pixel cannot become visible.');
  assert.deepEqual(restored.subarray(4, 8), rgba.subarray(4, 8), 'Partial original transparency is restored exactly.');
  assert.equal(restored[(2 * 10 + 2) * 4 + 3], 255);
  assert.equal(restored[(7 * 10 + 2) * 4 + 3], oldAlpha[7 * 10 + 2]);
});

test('missing selection, moved cutout and invalid mode fail atomically; transaction rollback leaves alpha unchanged', async t => {
  const { native, document: initial } = await fixture(t);
  const layerId = initial.layers.at(-1).id;
  await assert.rejects(command(native, initial, 'refine_cutout_from_selection', { layerId }), { code: 'NO_SELECTION' });
  assert.deepEqual((await native.execute('get_document', { documentId: initial.id })).document, initial);
  const selected = await command(native, initial, 'select_rectangle', { x: 0, y: 0, width: 2, height: 2 });
  await assert.rejects(command(native, selected, 'refine_cutout_from_selection', { layerId, mode: 'invent' }), { code: 'INVALID_ARGUMENT' });
  assert.equal(commandSchemas.refine_cutout_from_selection.safeParse({ documentId: initial.id, layerId, mode: 'invent' }).success, false);
  await assert.rejects(command(native, selected, 'apply_transaction', { operations: [
    { command: 'refine_cutout_from_selection', args: { layerId, mode: 'replace' } },
    { command: 'set_layer_outline', args: { layerId, width: 1000 } },
  ] }), { code: 'INVALID_ARGUMENT' });
  assert.deepEqual((await native.execute('get_document', { documentId: selected.id })).document, selected);
  const moved = await command(native, selected, 'transform_layer', { layerId, x: 1, y: 0 });
  await assert.rejects(command(native, moved, 'refine_cutout_from_selection', { layerId }), { code: 'INVALID_TARGET' });
  assert.deepEqual((await native.execute('get_document', { documentId: moved.id })).document, moved);
});
