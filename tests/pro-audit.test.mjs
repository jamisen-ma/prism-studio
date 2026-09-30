import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { validateCommand, validateBackendOptions } from '../shared/commands.mjs';
import { BLEND_MODES } from '../shared/blend-modes.mjs';
import { bitmapMask, maskCoverage, transformMask } from '../server/masks.mjs';

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-pro-audit-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const backend = await new NativeBackend({ dataDir }).init();
  const { document } = await backend.execute('create_document', { name: 'Audit', width: 20, height: 20, background: '#406080' });
  const run = (command, args = {}) => backend.execute(command, validateCommand(command, { documentId: document.id, ...args }));
  const render = async () => {
    const result = await run('export_document', { format: 'png' });
    return sharp(Buffer.from(result.data, 'base64')).ensureAlpha().raw().toBuffer();
  };
  return { backend, document, dataDir, run, render };
}

test('Photoshop rejects native-only blend modes before host execution, including transaction members', () => {
  const supported = new Set(['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'difference', 'exclusion']);
  for (const blendMode of BLEND_MODES) {
    const args = validateCommand('set_layer', { documentId: 'document', layerId: 'layer', blendMode });
    assert.doesNotThrow(() => validateBackendOptions('native', 'set_layer', args));
    const check = () => validateBackendOptions('photoshop', 'set_layer', args);
    const checkTransaction = () => validateBackendOptions('photoshop', 'apply_transaction', { operations: [{ command: 'set_layer', args }] });
    if (supported.has(blendMode)) { assert.doesNotThrow(check); assert.doesNotThrow(checkTransaction); }
    else { assert.throws(check, { code: 'UNSUPPORTED_COMMAND' }); assert.throws(checkTransaction, { code: 'UNSUPPORTED_COMMAND' }); }
  }
});

test('points-only polygon masks pass the public schema and protect all pixels outside the polygon', async t => {
  const { document, run, render } = await fixture(t);
  const before = await render();
  const mask = { shape: 'polygon', points: [{ x: 2, y: 2 }, { x: 18, y: 2 }, { x: 2, y: 18 }] };
  const { document: edited } = await run('add_adjustment', { kind: 'brightness', value: 40, mask });
  const after = await render();
  assert.ok(after[(4 * 20 + 4) * 4] > before[(4 * 20 + 4) * 4]);
  assert.deepEqual(after.subarray((16 * 20 + 16) * 4, (16 * 20 + 16) * 4 + 4), before.subarray((16 * 20 + 16) * 4, (16 * 20 + 16) * 4 + 4));
  await run('update_adjustment', { layerId: edited.layers.at(-1).id, mask });
  await run('set_layer_mask', { layerId: document.layers[0].id, mask });
  for (const shape of ['rectangle', 'ellipse']) assert.throws(() => validateCommand('set_layer_mask', { documentId: document.id, layerId: document.layers[0].id, mask: { shape, x: 1 } }), { code: 'INVALID_ARGUMENTS' });
});

test('subtracting the first layer-mask stroke hides only its footprint and survives undo and reopen', async t => {
  const { document, dataDir, run, render } = await fixture(t);
  const before = await render();
  await run('paint_mask', { layerId: document.layers[0].id, points: [{ x: 5.5, y: 5.5 }], size: 6, hardness: 1, opacity: 1, mode: 'subtract' });
  const after = await render();
  assert.equal(after[(5 * 20 + 5) * 4 + 3], 0);
  assert.deepEqual(after.subarray((15 * 20 + 15) * 4, (15 * 20 + 15) * 4 + 4), before.subarray((15 * 20 + 15) * 4, (15 * 20 + 15) * 4 + 4));
  await run('undo');
  assert.deepEqual(await render(), before);
  await run('redo');
  assert.deepEqual(await render(), after);
  const reopened = await new NativeBackend({ dataDir }).init();
  const output = await reopened.execute('export_document', { documentId: document.id, format: 'png' });
  assert.deepEqual(await sharp(Buffer.from(output.data, 'base64')).ensureAlpha().raw().toBuffer(), after);
});

test('failed transactions do not persist painted masks or selection changes', async t => {
  const { document, dataDir, run, render } = await fixture(t);
  const before = await render();
  const filename = path.join(dataDir, 'projects', `${document.id}.json`);
  const saved = await fs.readFile(filename);
  const stroke = { points: [{ x: 5.5, y: 5.5 }], size: 6, hardness: 1, opacity: 1 };
  await assert.rejects(run('apply_transaction', { label: 'Failed mask edit', operations: [
    { command: 'paint_mask', args: { ...stroke, layerId: document.layers[0].id, mode: 'subtract' } },
    { command: 'paint_selection', args: { ...stroke, mode: 'replace' } },
    { command: 'update_path', args: { layerId: document.layers[0].id, closed: true } },
  ] }), { code: 'INVALID_TARGET' });
  assert.deepEqual(await fs.readFile(filename), saved);
  assert.deepEqual(await render(), before);
  const { document: current } = await run('get_document');
  assert.equal(current.revision, document.revision);
  assert.equal(current.selection, null);
  assert.equal(current.layers[0].mask, undefined);
});

test('cropping feathered bitmap masks retains exact original coverage, including inversion', () => {
  const pixels = new Uint8Array(100).fill(255);
  pixels[4 * 10 + 4] = 128;
  const crop = { type: 'crop', x: 3, y: 3, width: 4, height: 4 };
  for (const invert of [false, true]) {
    const original = { ...bitmapMask(pixels, 10, 10), feather: 2, invert };
    const before = maskCoverage(original);
    const after = maskCoverage(transformMask(original, crop, 10, 10));
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) assert.equal(after(x, y), before(x + 3, y + 3));
  }
});

test('cropping a feathered color selection preserves retained image pixels and undo', async t => {
  const { document, run, render } = await fixture(t);
  await run('select_color', { x: 10, y: 10, tolerance: 0 });
  await run('modify_selection', { feather: 2 });
  await run('mask_from_selection', { layerId: document.layers[0].id });
  const before = await render();
  await run('crop_document', { x: 5, y: 5, width: 10, height: 10 });
  const after = await render();
  for (let y = 0; y < 10; y++) assert.deepEqual(after.subarray(y * 10 * 4, (y + 1) * 10 * 4), before.subarray(((y + 5) * 20 + 5) * 4, ((y + 5) * 20 + 15) * 4));
  await run('undo');
  assert.deepEqual(await render(), before);
});

test('resizing scales bitmap feather beyond the input limit and preserves that radius on reopen', async t => {
  const { document, dataDir, run, render } = await fixture(t);
  await run('select_color', { x: 10, y: 10, tolerance: 0 });
  await run('modify_selection', { feather: 100 });
  await run('mask_from_selection', { layerId: document.layers[0].id });
  const { document: resized } = await run('resize_document', { width: 40, height: 40 });
  assert.equal(resized.selection.feather, 200);
  assert.equal(resized.layers[0].mask.feather, 200);
  const beforeReopen = await render();
  const reopened = await new NativeBackend({ dataDir }).init();
  const { document: loaded } = await reopened.execute('get_document', { documentId: document.id });
  assert.equal(loaded.selection.feather, 200);
  assert.equal(loaded.layers[0].mask.feather, 200);
  const output = await reopened.execute('export_document', { documentId: document.id, format: 'png' });
  assert.deepEqual(await sharp(Buffer.from(output.data, 'base64')).ensureAlpha().raw().toBuffer(), beforeReopen);
});

for (const kind of ['bitmap', 'rectangle', 'polygon']) test(`existing ${kind} masks can be refined after crop and fractional resize without replacing geometry`, async t => {
  const { document, dataDir, run, render } = await fixture(t);
  const layerId = document.layers[0].id;
  await assert.rejects(run('modify_layer_mask', { layerId, feather: 2 }), { code: 'NO_MASK' });
  assert.equal((await run('get_document')).document.revision, document.revision);
  if (kind === 'bitmap') {
    await run('select_color', { x: 10, y: 10, tolerance: 0 });
    await run('modify_selection', { feather: 2 });
    await run('mask_from_selection', { layerId });
  } else {
    const mask = kind === 'polygon'
      ? { shape: 'polygon', points: [{ x: 0.5, y: 1.5 }, { x: 18.5, y: 1.5 }, { x: 0.5, y: 19.5 }], feather: 2 }
      : { x: 1, y: 1, width: 15, height: 15, feather: 2 };
    await run('set_layer_mask', { layerId, mask });
  }
  await run('crop_document', { x: 3, y: 4, width: 12, height: 12 });
  const { document: resized } = await run('resize_document', { width: 7, height: 9 });
  const originalMask = resized.layers[0].mask;
  if (kind !== 'bitmap') assert.ok(originalMask.x < 0 && !Number.isInteger(originalMask.x));
  const before = await render();
  const { document: refined } = await run('apply_transaction', { label: 'Refine existing mask', operations: [
    { command: 'modify_layer_mask', args: { layerId, feather: 1.25 } },
    { command: 'modify_layer_mask', args: { layerId, invert: true } },
  ] });
  assert.deepEqual(refined.layers[0].mask, { ...originalMask, feather: 1.25, invert: true });
  assert.equal(refined.history.length, resized.history.length + 1);
  const after = await render();
  assert.notDeepEqual(after, before);
  await run('undo');
  assert.deepEqual((await run('get_document')).document.layers[0].mask, originalMask);
  assert.deepEqual(await render(), before);
  await run('redo');
  const reopened = await new NativeBackend({ dataDir }).init();
  const { document: loaded } = await reopened.execute('get_document', { documentId: document.id });
  assert.deepEqual(loaded.layers[0].mask, refined.layers[0].mask);
  const output = await reopened.execute('export_document', { documentId: document.id, format: 'png' });
  assert.deepEqual(await sharp(Buffer.from(output.data, 'base64')).ensureAlpha().raw().toBuffer(), after);
});
