import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';

async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-pro-test-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const backend = await new NativeBackend({ dataDir }).init();
  const { document } = await backend.execute('create_document', { name: 'Professional tools', width: 32, height: 24, background: '#406080', ...options });
  const run = (command, args = {}) => backend.execute(command, { documentId: document.id, ...args });
  const render = async () => {
    const result = await run('export_document', { format: 'png' });
    return sharp(Buffer.from(result.data, 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  };
  return { backend, document, dataDir, run, render };
}
const code = (expected) => (cause) => cause.code === expected;
const stroke = { tool: 'brush', points: [{ x: 8, y: 8 }], size: 10, hardness: 1, opacity: 1, color: '#ff0000' };

test('levels and curves default to exact identity, update existing parameters, and validate atomically', async (t) => {
  const { run, render } = await fixture(t);
  const initial = (await render()).data;
  await run('add_adjustment', { kind: 'levels', value: 0 });
  let { document } = await run('add_adjustment', { kind: 'curves', value: 0 });
  assert.deepEqual((await render()).data, initial);
  const curve = document.layers.at(-1);
  ({ document } = await run('update_adjustment', { layerId: curve.id, parameters: { channel: 'red', points: [{ x: 0, y: 20 }, { x: 128, y: 180 }, { x: 255, y: 255 }] } }));
  const edited = (await render()).data;
  assert.equal(document.layers.length, 3);
  assert.ok(edited[0] > initial[0]); assert.equal(edited[1], initial[1]); assert.equal(edited[2], initial[2]); assert.equal(edited[3], initial[3]);
  const revision = document.revision;
  await assert.rejects(run('update_adjustment', { layerId: curve.id, parameters: { points: [{ x: 0, y: 0 }, { x: 0, y: 40 }, { x: 255, y: 255 }] } }), code('INVALID_ARGUMENT'));
  assert.equal((await run('get_document')).document.revision, revision);
  assert.deepEqual((await render()).data, edited);
  await assert.rejects(run('update_adjustment', { layerId: curve.id, parameters: null }), code('INVALID_ARGUMENT'));
  await run('update_adjustment', { layerId: document.layers[1].id, parameters: { black: 20, white: 200, gamma: 1.4, outputBlack: 10, outputWhite: 230 } });
  await assert.rejects(run('update_adjustment', { layerId: document.layers[1].id, parameters: { black: 210 } }), code('INVALID_ARGUMENT'));
});

test('new scalar controls are real and neutral settings do not alter pixels', async (t) => {
  const { run, render } = await fixture(t, { background: '#ff0000' });
  const initial = (await render()).data;
  for (const kind of ['hue', 'vibrance', 'highlights', 'shadows']) await run('add_adjustment', { kind, value: 0 });
  assert.deepEqual((await render()).data, initial);
  await run('add_adjustment', { kind: 'hue', value: 120 });
  const green = (await render()).data;
  assert.deepEqual([...green.subarray(0, 4)], [0, 255, 0, 255]);
  await run('undo');
  await run('add_adjustment', { kind: 'vibrance', value: -100 });
  assert.deepEqual((await render()).data, initial, 'fully saturated colors receive no vibrance increase or decrease in this documented approximation');
  await run('add_adjustment', { kind: 'shadows', value: 60 });
  assert.ok((await render()).data[1] > 0);
});

test('ellipse and polygon masks restrict adjustments, retain feather/inversion, and follow geometry', async (t) => {
  const { run, render } = await fixture(t, { width: 20, height: 20 });
  const before = (await render()).data;
  await run('select_region', { shape: 'ellipse', x: 2, y: 2, width: 16, height: 16, feather: 2 });
  let { document } = await run('add_adjustment', { kind: 'brightness', value: 40 });
  const mask = document.layers.at(-1).mask;
  assert.equal(mask.shape, 'ellipse'); assert.equal(mask.feather, 2);
  const ellipse = (await render()).data;
  assert.deepEqual(ellipse.subarray((2 * 20 + 2) * 4, (2 * 20 + 2) * 4 + 4), before.subarray((2 * 20 + 2) * 4, (2 * 20 + 2) * 4 + 4));
  assert.ok(ellipse[(10 * 20 + 10) * 4] > before[(10 * 20 + 10) * 4]);
  await run('update_adjustment', { layerId: document.layers.at(-1).id, mask: { shape: 'polygon', points: [{ x: 2, y: 2 }, { x: 18, y: 2 }, { x: 2, y: 18 }] } });
  const polygon = (await render()).data;
  assert.ok(polygon[(4 * 20 + 4) * 4] > before[(4 * 20 + 4) * 4]);
  assert.deepEqual(polygon.subarray((16 * 20 + 16) * 4, (16 * 20 + 16) * 4 + 4), before.subarray((16 * 20 + 16) * 4, (16 * 20 + 16) * 4 + 4));
  await run('crop_document', { x: 4, y: 4, width: 12, height: 12 });
  ({ document } = await run('resize_document', { width: 6, height: 6 }));
  assert.deepEqual(document.layers.at(-1).mask.points, [{ x: -1, y: -1 }, { x: 7, y: -1 }, { x: -1, y: 7 }]);
  assert.equal((await render()).info.width, 6);
  await run('modify_selection', { feather: 1, invert: true });
  assert.equal((await run('get_document')).document.selection.invert, true);
  await run('clear_selection');
  await assert.rejects(run('modify_selection', { invert: false }), code('NO_SELECTION'));
});

test('layer masks control alpha, can be removed, and histogram counts visible pixels only', async (t) => {
  const { run, document, render } = await fixture(t, { width: 8, height: 8, background: '#ff0000' });
  await run('set_layer_mask', { layerId: document.layers[0].id, mask: { x: 2, y: 2, width: 4, height: 4 } });
  const masked = (await render()).data;
  assert.equal(masked[3], 0); assert.equal(masked[(3 * 8 + 3) * 4 + 3], 255);
  const histogram = await run('get_histogram');
  assert.equal(histogram.pixelCount, 16); assert.equal(histogram.red[255], 16); assert.equal(histogram.green[0], 16);
  assert.equal(histogram.luminance.reduce((a, b) => a + b, 0), 16);
  await run('set_layer_mask', { layerId: document.layers[0].id, mask: null });
  assert.equal((await run('get_histogram')).pixelCount, 64);
});

test('paint creates editable layers; selections clip coverage and erasing preserves prior asset/history', async (t) => {
  const { run, render, dataDir, document } = await fixture(t);
  await assert.rejects(run('paint_stroke', { ...stroke, layerId: document.layers[0].id }), code('INVALID_TARGET'));
  const before = (await render()).data;
  await run('select_region', { shape: 'ellipse', x: 5, y: 5, width: 6, height: 6 });
  let result = await run('paint_stroke', stroke);
  const paint = result.document.layers.at(-1);
  assert.equal(paint.role, 'paint'); assert.equal(paint.type, 'raster');
  const painted = (await render()).data;
  assert.deepEqual(painted.subarray((5 * 32 + 5) * 4, (5 * 32 + 5) * 4 + 4), before.subarray((5 * 32 + 5) * 4, (5 * 32 + 5) * 4 + 4));
  assert.deepEqual([...painted.subarray((8 * 32 + 8) * 4, (8 * 32 + 8) * 4 + 4)], [255, 0, 0, 255]);
  const originalAsset = await fs.readFile(path.join(dataDir, 'assets', paint.sourceAsset));
  await run('clear_selection');
  result = await run('paint_stroke', { ...stroke, layerId: paint.id, tool: 'eraser' });
  assert.notEqual(result.document.layers.at(-1).asset, paint.asset);
  assert.deepEqual((await render()).data, before);
  assert.deepEqual(await fs.readFile(path.join(dataDir, 'assets', paint.sourceAsset)), originalAsset);
  await run('undo');
  assert.deepEqual((await render()).data, painted);
});

test('rasterization and strokes work in an atomic transaction with one undo step', async (t) => {
  const { run, render, document, dataDir } = await fixture(t);
  const initial = (await render()).data;
  let result = await run('apply_transaction', { label: 'Retouch background', operations: [
    { command: 'rasterize_layer', args: { layerId: document.layers[0].id } },
    { command: 'paint_stroke', args: { ...stroke, layerId: document.layers[0].id } },
  ] });
  assert.equal(result.document.revision, 2); assert.equal(result.document.layers[0].type, 'raster');
  assert.notDeepEqual((await render()).data, initial);
  await run('undo'); assert.deepEqual((await render()).data, initial);
  assert.equal((await run('get_document')).document.layers[0].type, 'solid');
  const saved = await fs.readFile(path.join(dataDir, 'projects', `${document.id}.json`));
  await assert.rejects(run('apply_transaction', { operations: [
    { command: 'rasterize_layer', args: { layerId: document.layers[0].id } },
    { command: 'paint_stroke', args: { ...stroke, layerId: document.layers[0].id } },
    { command: 'update_text', args: { layerId: document.layers[0].id, text: 'invalid target' } },
  ] }), code('INVALID_TARGET'));
  assert.deepEqual(await fs.readFile(path.join(dataDir, 'projects', `${document.id}.json`)), saved);
  assert.deepEqual((await render()).data, initial);
});

test('affine transforms translate, flip, scale and rotate within bounded canvas, preserving undo', async (t) => {
  const { run, render, document } = await fixture(t, { width: 8, height: 8, background: '#ffffff' });
  await run('paint_stroke', { ...stroke, points: [{ x: 2.5, y: 3.5 }], size: 1 });
  const paint = (await run('get_document')).document.layers.at(-1);
  const initial = (await render()).data;
  await run('transform_layer', { layerId: paint.id, x: 2, y: 1 });
  const moved = (await render()).data;
  assert.deepEqual([...moved.subarray((4 * 8 + 4) * 4, (4 * 8 + 4) * 4 + 4)], [255, 0, 0, 255]);
  assert.deepEqual([...moved.subarray((3 * 8 + 2) * 4, (3 * 8 + 2) * 4 + 4)], [255, 255, 255, 255]);
  await run('undo'); assert.deepEqual((await render()).data, initial);
  await run('transform_layer', { layerId: paint.id, x: 0, y: 0, flipX: true });
  assert.deepEqual([...(await render()).data.subarray((3 * 8 + 5) * 4, (3 * 8 + 5) * 4 + 4)], [255, 0, 0, 255]);
  await run('undo');
  await run('transform_layer', { layerId: paint.id, x: 0, y: 0, rotation: 90 });
  assert.deepEqual([...(await render()).data.subarray((2 * 8 + 4) * 4, (2 * 8 + 4) * 4 + 4)], [255, 0, 0, 255]);
  await run('transform_layer', { layerId: paint.id, x: 0, y: 0, scaleX: 8, scaleY: 8 });
  assert.equal((await render()).data.length, 8 * 8 * 4);
  await run('set_layer_mask', { layerId: document.layers[0].id, mask: { x: 0, y: 0, width: 4, height: 8 } });
  await run('transform_layer', { layerId: document.layers[0].id, x: 2, y: 0 });
  assert.equal((await run('get_document')).document.layers[0].mask.x, 0, 'layer masks intentionally remain in document coordinates');
});

test('editable text, masks and color parameters survive reopen without flattening', async (t) => {
  const { run, render, dataDir, document } = await fixture(t, { width: 200, height: 100 });
  let result = await run('add_text', { text: 'Before', x: 80, y: 10, fontSize: 24, color: '#ffffff' });
  const textId = result.document.layers.at(-1).id;
  const before = (await render()).data;
  result = await run('update_text', { layerId: textId, text: 'After <&>', fontFamily: 'monospace', fontWeight: 'bold', fontStyle: 'italic', align: 'center', color: '#ffcc00' });
  assert.equal(result.document.layers.at(-1).text, 'After <&>'); assert.equal(result.document.layers.length, 2);
  assert.notDeepEqual((await render()).data, before);
  await run('set_layer_mask', { layerId: textId, mask: { shape: 'ellipse', x: 20, y: 0, width: 140, height: 80, feather: 3 } });
  await run('add_adjustment', { kind: 'levels', value: 0, parameters: { gamma: 1.3 } });
  const final = (await render()).data;
  const reopened = await new NativeBackend({ dataDir }).init();
  const loaded = (await reopened.execute('get_document', { documentId: document.id })).document;
  assert.equal(loaded.layers[1].fontFamily, 'monospace'); assert.equal(loaded.layers[1].mask.shape, 'ellipse'); assert.equal(loaded.layers[2].parameters.gamma, 1.3);
  const exported = await reopened.execute('export_document', { documentId: document.id, format: 'png' });
  assert.deepEqual(await sharp(Buffer.from(exported.data, 'base64')).ensureAlpha().raw().toBuffer(), final);
});

test('clone samples a frozen visible composite and unsupported target errors preserve the document', async (t) => {
  const { run, render } = await fixture(t);
  await run('paint_stroke', stroke);
  let { document } = await run('add_paint_layer', { name: 'Cloned detail' });
  const target = document.layers.at(-1);
  await run('paint_stroke', { ...stroke, layerId: target.id, tool: 'clone', points: [{ x: 24, y: 8 }], source: { x: 8, y: 8 } });
  const rendered = (await render()).data;
  assert.deepEqual([...rendered.subarray((8 * 32 + 24) * 4, (8 * 32 + 24) * 4 + 4)], [255, 0, 0, 255]);
  ({ document } = await run('get_document'));
  await assert.rejects(run('paint_stroke', { ...stroke, layerId: target.id, tool: 'heal' }), code('INVALID_ARGUMENT'));
  assert.equal((await run('get_document')).document.revision, document.revision);
});

test('color selections and flood fills use the visible composite and intersect active selection', async (t) => {
  const { run, render } = await fixture(t, { width: 10, height: 8, background: '#ffffff' });
  await run('add_shape', { shape: 'rectangle', x: 4, y: 0, width: 2, height: 8, fill: '#000000' });
  let { document } = await run('select_color', { x: 1, y: 1, tolerance: 0, contiguous: true });
  assert.equal(document.selection.shape, 'bitmap'); assert.equal(document.selection.width, 10); assert.equal(document.selection.height, 8);
  assert.equal(document.selection.runs.filter((_, index) => index % 3 === 1).reduce((sum, length) => sum + length, 0), 32);
  ({ document } = await run('select_color', { x: 1, y: 1, tolerance: 0, contiguous: false }));
  assert.equal(document.selection.runs.filter((_, index) => index % 3 === 1).reduce((sum, length) => sum + length, 0), 64);
  const selected = doc => doc.selection.runs.filter((_, index) => index % 3 === 1).reduce((sum, length) => sum + length, 0);
  ({ document } = await run('select_color', { x: 1, y: 1, tolerance: 0, contiguous: true }));
  ({ document } = await run('select_color', { x: 4, y: 1, tolerance: 0, contiguous: true, mode: 'add' })); assert.equal(selected(document), 48);
  ({ document } = await run('select_color', { x: 1, y: 1, tolerance: 0, contiguous: true, mode: 'subtract' })); assert.equal(selected(document), 16);
  ({ document } = await run('select_color', { x: 8, y: 1, tolerance: 0, contiguous: false, mode: 'intersect' })); assert.equal(selected(document), 0);
  await run('clear_selection');
  await assert.rejects(run('select_color', { x: 1, y: 1, mode: 'subtract' }), code('NO_SELECTION'));
  await run('select_region', { shape: 'rectangle', x: 0, y: 2, width: 10, height: 3 });
  ({ document } = await run('add_paint_layer'));
  const target = document.layers.at(-1);
  const before = (await render()).data;
  await run('fill_area', { layerId: target.id, x: 1, y: 3, tolerance: 0, color: '#ff0000' });
  const filled = (await render()).data;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 10; x++) {
    const i = (y * 10 + x) * 4;
    if (x < 4 && y >= 2 && y < 5) assert.deepEqual([...filled.subarray(i, i + 4)], [255, 0, 0, 255]);
    else assert.deepEqual(filled.subarray(i, i + 4), before.subarray(i, i + 4));
  }
  await run('fill_area', { layerId: target.id, mode: 'erase' });
  assert.deepEqual((await render()).data, before);
  await run('undo'); assert.deepEqual((await render()).data, filled);
});

test('painted selections and copied layer masks remain independent, reversible bitmap graphs', async (t) => {
  const { run, render, document: initial } = await fixture(t, { width: 20, height: 20 });
  const before = (await render()).data;
  let { document } = await run('paint_selection', { points: [{ x: 10, y: 10 }], size: 8, hardness: 1, opacity: 1, mode: 'replace' });
  assert.equal(document.selection.shape, 'bitmap');
  const selection = structuredClone(document.selection);
  await run('mask_from_selection', { layerId: initial.layers[0].id });
  await run('paint_selection', { points: [{ x: 10.5, y: 10.5 }], size: 2, hardness: 1, opacity: 1, mode: 'subtract' });
  ({ document } = await run('get_document'));
  assert.deepEqual(document.layers[0].mask, selection);
  assert.notDeepEqual(document.selection.runs, selection.runs);
  const masked = (await render()).data;
  assert.equal(masked[3], 0); assert.equal(masked[(10 * 20 + 10) * 4 + 3], 255);
  await run('set_layer_mask', { layerId: initial.layers[0].id, mask: null });
  await run('add_adjustment', { kind: 'brightness', value: 30 });
  const adjusted = (await render()).data;
  assert.deepEqual(adjusted.subarray(0, 4), before.subarray(0, 4));
  assert.deepEqual(adjusted.subarray((10 * 20 + 10) * 4, (10 * 20 + 10) * 4 + 4), before.subarray((10 * 20 + 10) * 4, (10 * 20 + 10) * 4 + 4));
  assert.ok(adjusted[(10 * 20 + 7) * 4] > before[(10 * 20 + 7) * 4]);
});

test('paint masks follow crop/resize, persist at canvas dimensions, and reject mismatched bitmaps atomically', async (t) => {
  const { run, render, dataDir, document: initial } = await fixture(t, { width: 20, height: 20 });
  await run('paint_mask', { layerId: initial.layers[0].id, points: [{ x: 10, y: 10 }], size: 8, hardness: 0.5, opacity: 0.8, mode: 'add' });
  let { document } = await run('get_document');
  assert.equal(document.layers[0].mask.shape, 'bitmap');
  assert.equal((await render()).data[3], 0, 'painting an absent mask starts from empty coverage');
  await run('crop_document', { x: 4, y: 4, width: 12, height: 12 });
  ({ document } = await run('resize_document', { width: 6, height: 6 }));
  assert.equal(document.layers[0].mask.width, 6); assert.equal(document.layers[0].mask.height, 6);
  const final = (await render()).data;
  const reopened = await new NativeBackend({ dataDir }).init();
  const loaded = (await reopened.execute('get_document', { documentId: initial.id })).document;
  assert.equal(loaded.layers[0].mask.width, 6);
  const exported = await reopened.execute('export_document', { documentId: initial.id, format: 'png' });
  assert.deepEqual(await sharp(Buffer.from(exported.data, 'base64')).ensureAlpha().raw().toBuffer(), final);
  await assert.rejects(run('set_layer_mask', { layerId: initial.layers[0].id, mask: { shape: 'bitmap', x: 0, y: 0, width: 7, height: 6, runs: [0, 1, 255] } }), code('INVALID_ARGUMENT'));
  assert.equal((await run('get_document')).document.revision, document.revision);
});

test('eyedropper samples actual adjusted composite without changing history', async (t) => {
  const { run } = await fixture(t, { width: 8, height: 8, background: '#ff0000' });
  const { document } = await run('add_adjustment', { kind: 'hue', value: 120 });
  const sample = await run('sample_color', { x: 2, y: 3, radius: 1 });
  assert.equal(sample.hex, '#00ff00'); assert.equal(sample.alpha, 255); assert.equal(sample.green, 255);
  const after = (await run('get_document')).document;
  assert.equal(after.revision, document.revision); assert.deepEqual(after.history, document.history);
  await assert.rejects(run('sample_color', { x: 8, y: 0 }), code('INVALID_ARGUMENT'));
});

test('nonseparable color blending preserves backdrop luminosity, opacity and masks through reopening', async (t) => {
  const { run, render, backend, dataDir, document: initial } = await fixture(t, { width: 8, height: 8, background: '#404040' });
  const { document } = await run('add_shape', { shape: 'rectangle', x: 0, y: 0, width: 8, height: 8, fill: '#ff0000' });
  const layer = document.layers.at(-1);
  await run('set_layer', { layerId: layer.id, blendMode: 'color', opacity: 0.5 });
  await run('set_layer_mask', { layerId: layer.id, mask: { x: 0, y: 0, width: 4, height: 8 } });
  const pixels = (await render()).data;
  assert.ok(pixels[0] > pixels[1] && pixels[1] === pixels[2]);
  assert.ok(Math.abs(pixels[0] * 0.3 + pixels[1] * 0.59 + pixels[2] * 0.11 - 64) < 1);
  assert.equal(pixels[3], 255);
  assert.deepEqual([...pixels.subarray(7 * 4, 7 * 4 + 4)], [64, 64, 64, 255]);
  const reopened = await new NativeBackend({ dataDir }).init();
  assert.equal((await reopened.execute('get_document', { documentId: initial.id })).document.layers.at(-1).blendMode, 'color');
  const exported = await reopened.execute('export_document', { documentId: initial.id, format: 'png' });
  assert.deepEqual(await sharp(Buffer.from(exported.data, 'base64')).ensureAlpha().raw().toBuffer(), pixels);
  assert.equal((await backend.execute('capabilities')).blendModes.length, 27);
  const adjustment = (await run('add_adjustment', { kind: 'brightness', value: 1 })).document.layers.at(-1);
  await assert.rejects(run('set_layer', { layerId: adjustment.id, blendMode: 'hue' }), code('UNSUPPORTED'));
});

test('dissolve combines alpha, layer opacity and mask coverage deterministically with reversible history', async (t) => {
  const { run, render, document: initial } = await fixture(t, { width: 16, height: 16 });
  await run('set_layer', { layerId: initial.layers[0].id, visible: false });
  const { document } = await run('add_shape', { shape: 'rectangle', x: 0, y: 0, width: 16, height: 16, fill: '#ff0000' });
  const target = document.layers.at(-1);
  await run('set_layer', { layerId: target.id, blendMode: 'hue', opacity: 0.5 });
  const translucent = (await render()).data;
  assert.deepEqual([...translucent.subarray(0, 4)], [255, 0, 0, 128], 'transparent backdrop must retain source color and fractional alpha');
  await run('set_layer_mask', { layerId: target.id, mask: { x: 0, y: 0, width: 8, height: 16, feather: 2 } });
  const before = (await render()).data;
  await run('set_layer', { layerId: target.id, blendMode: 'dissolve' });
  const dissolved = (await render()).data;
  assert.deepEqual((await render()).data, dissolved);
  let opaque = 0;
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const alpha = dissolved[(y * 16 + x) * 4 + 3];
    assert.ok(alpha === 0 || alpha === 255);
    if (x >= 8) assert.equal(alpha, 0);
    if (alpha === 255) opaque++;
  }
  assert.ok(opaque > 0 && opaque < 128);
  await run('undo'); assert.deepEqual((await render()).data, before);
  await run('redo'); assert.deepEqual((await render()).data, dissolved);
});
