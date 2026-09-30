import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { normalizeShape, normalizePath, normalizeGradient, vectorSvg, gradientPixels } from '../server/vector.mjs';
import { NativeBackend } from '../server/native.mjs';

const coded = (expected) => (cause) => cause.code === expected;
const shapeArgs = { shape: 'rectangle', x: 4, y: 4, width: 24, height: 24, fill: '#ff0000' };
const gradientArgs = { kind: 'linear', start: { x: 0.5, y: 0.5 }, end: { x: 7.5, y: 0.5 }, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] };
const rgba = (pixels, width, x, y) => [...pixels.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
async function vectorPixels(type, settings) { return sharp(Buffer.from(vectorSvg(type, settings, 32, 32))).ensureAlpha().raw().toBuffer(); }

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-vector-test-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const backend = await new NativeBackend({ dataDir }).init();
  const { document } = await backend.execute('create_document', { name: 'Vectors', width: 32, height: 32, background: '#ffffff' });
  const run = (command, args = {}) => backend.execute(command, { documentId: document.id, ...args });
  const render = async () => {
    const result = await run('export_document', { format: 'png' });
    return sharp(Buffer.from(result.data, 'base64')).ensureAlpha().raw().toBuffer();
  };
  return { dataDir, backend, document, run, render };
}

test('all six editable shapes rasterize real geometry, with safe defaults and clipped bounds', async () => {
  for (const shape of ['rectangle', 'ellipse', 'triangle', 'polygon', 'star', 'line']) {
    const pixels = await vectorPixels('shape', { ...shapeArgs, shape, stroke: shape === 'line' ? '#ff0000' : null });
    assert.ok(pixels.some((byte, index) => index % 4 === 3 && byte > 0), `${shape} should produce visible pixels`);
    assert.equal(rgba(pixels, 32, 0, 31)[3], 0, `${shape} must remain clipped to its geometry`);
  }
  const rectangle = await vectorPixels('shape', shapeArgs);
  const rounded = await vectorPixels('shape', { ...shapeArgs, radius: 10 });
  assert.equal(rgba(rectangle, 32, 4, 4)[3], 255); assert.equal(rgba(rounded, 32, 4, 4)[3], 0);
  assert.equal(normalizeShape({ ...shapeArgs, fill: undefined }).fill, '#ffffff');
  assert.equal(normalizeShape({ ...shapeArgs, shape: 'line', fill: undefined }).stroke, '#ffffff');
  const outside = await vectorPixels('shape', { ...shapeArgs, x: -20, y: -20 });
  assert.equal(rgba(outside, 32, 31, 31)[3], 0);
});

test('path nodes and absolute Bezier controls produce distinct editable curves and closures', async () => {
  const straight = { nodes: [{ x: 4, y: 20 }, { x: 28, y: 20 }], stroke: '#ffffff', strokeWidth: 3 };
  const curved = { ...straight, nodes: [{ x: 4, y: 20, out: { x: 4, y: 2 } }, { x: 28, y: 20, in: { x: 28, y: 2 } }] };
  const flat = await vectorPixels('path', straight), arc = await vectorPixels('path', curved);
  assert.equal(rgba(flat, 32, 16, 7)[3], 0); assert.ok(rgba(arc, 32, 16, 7)[3] > 0);
  const triangle = await vectorPixels('path', { nodes: [{ x: 4, y: 4 }, { x: 28, y: 4 }, { x: 16, y: 28 }], closed: true, fill: '#00ff00', stroke: null });
  assert.deepEqual(rgba(triangle, 32, 16, 10), [0, 255, 0, 255]);
  assert.equal(normalizePath(straight).closed, false);
});

test('SVG-producing settings reject markup injection and unsafe complexity or values', () => {
  assert.throws(() => vectorSvg('shape', { ...shapeArgs, fill: 'url(file:///secret)' }, 32, 32), coded('INVALID_ARGUMENT'));
  assert.throws(() => normalizeShape({ ...shapeArgs, shape: '<image />' }), coded('INVALID_ARGUMENT'));
  assert.throws(() => normalizeShape({ ...shapeArgs, sides: 101 }), coded('INVALID_ARGUMENT'));
  assert.throws(() => normalizeShape({ ...shapeArgs, width: Infinity }), coded('INVALID_ARGUMENT'));
  assert.throws(() => normalizePath({ nodes: Array.from({ length: 257 }, () => ({ x: 0, y: 0 })) }), coded('INVALID_ARGUMENT'));
  assert.throws(() => normalizePath({ nodes: [{ x: 0, y: 0, out: { x: '0"/>', y: 0 } }, { x: 3, y: 3 }] }), coded('INVALID_ARGUMENT'));
  assert.throws(() => vectorSvg('shape', shapeArgs, 8192, 8192), coded('LIMIT_EXCEEDED'));
});

test('gradient interpolation matches endpoints, supports multiple stops and premultiplied alpha', () => {
  const linear = gradientPixels(gradientArgs, 8, 1);
  assert.deepEqual(rgba(linear, 8, 0, 0), [0, 0, 0, 255]); assert.deepEqual(rgba(linear, 8, 7, 0), [255, 255, 255, 255]);
  assert.ok(linear[3 * 4] < linear[4 * 4]);
  const colored = gradientPixels({ ...gradientArgs, stops: [{ offset: 0, color: '#ff0000' }, { offset: 0.5, color: '#00ff00' }, { offset: 1, color: '#0000ff' }] }, 8, 1);
  assert.ok(rgba(colored, 8, 3, 0)[1] > 200); assert.ok(rgba(colored, 8, 4, 0)[1] > 200);
  const transparent = gradientPixels({ ...gradientArgs, stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff', opacity: 0 }] }, 8, 1);
  assert.deepEqual(rgba(transparent, 8, 3, 0).slice(0, 3), [255, 0, 0]);
  assert.ok(rgba(transparent, 8, 3, 0)[3] > 0 && rgba(transparent, 8, 3, 0)[3] < 255);
  assert.equal(rgba(transparent, 8, 7, 0)[3], 0);
});

test('radial, angle, reflected and diamond gradients follow their distinct spatial fields', () => {
  const settings = { ...gradientArgs, start: { x: 4.5, y: 4.5 }, end: { x: 8.5, y: 4.5 } };
  const linear = gradientPixels(settings, 9, 9);
  const radial = gradientPixels({ ...settings, kind: 'radial' }, 9, 9);
  const reflected = gradientPixels({ ...settings, kind: 'reflected' }, 9, 9);
  const diamond = gradientPixels({ ...settings, kind: 'diamond' }, 9, 9);
  const angle = gradientPixels({ ...settings, kind: 'angle' }, 9, 9);
  assert.equal(rgba(linear, 9, 0, 4)[0], 0); assert.equal(rgba(reflected, 9, 0, 4)[0], 255);
  assert.equal(rgba(radial, 9, 4, 0)[0], 255); assert.equal(rgba(reflected, 9, 4, 0)[0], 0);
  assert.equal(rgba(diamond, 9, 6, 6)[0], 255); assert.ok(rgba(radial, 9, 6, 6)[0] < 200);
  assert.equal(rgba(angle, 9, 8, 4)[0], 0); assert.equal(rgba(angle, 9, 4, 8)[0], 64); assert.equal(rgba(angle, 9, 0, 4)[0], 128); assert.equal(rgba(angle, 9, 4, 0)[0], 191);
});

test('gradient validation rejects invalid stop order, coincident endpoints and large canvases', () => {
  assert.throws(() => normalizeGradient({ ...gradientArgs, end: gradientArgs.start }), coded('INVALID_ARGUMENT'));
  assert.throws(() => normalizeGradient({ ...gradientArgs, stops: [{ offset: 0, color: '#000000' }, { offset: 0, color: '#ffffff' }] }), coded('INVALID_ARGUMENT'));
  assert.throws(() => normalizeGradient({ ...gradientArgs, stops: [{ offset: 0.1, color: '#000000' }, { offset: 1, color: '#ffffff' }] }), coded('INVALID_ARGUMENT'));
  assert.throws(() => gradientPixels(gradientArgs, 8192, 8192), coded('LIMIT_EXCEEDED'));
});

test('native shape updates preserve editability and support masks, opacity, transforms and rasterize undo', async (t) => {
  const { run, render } = await fixture(t);
  let { document } = await run('add_shape', shapeArgs);
  const layer = document.layers.at(-1);
  assert.equal(layer.type, 'shape'); assert.equal(layer.width, 32); assert.equal(layer.vector.width, 24);
  assert.deepEqual(rgba(await render(), 32, 10, 10), [255, 0, 0, 255]);
  ({ document } = await run('update_shape', { layerId: layer.id, fill: '#0000ff', width: 16, name: 'Blue shape' }));
  assert.equal(document.layers.length, 2); assert.equal(document.layers.at(-1).vector.x, 4); assert.equal(document.layers.at(-1).name, 'Blue shape');
  await run('set_layer_mask', { layerId: layer.id, mask: { x: 8, y: 8, width: 8, height: 8 } });
  await run('set_layer', { layerId: layer.id, opacity: 0.5 });
  const masked = await render();
  assert.deepEqual(rgba(masked, 32, 5, 5), [255, 255, 255, 255]); assert.deepEqual(rgba(masked, 32, 10, 10), [128, 128, 255, 255]);
  await run('transform_layer', { layerId: layer.id, x: 2, y: 0, rotation: 30 });
  const transformed = await render();
  ({ document } = await run('rasterize_layer', { layerId: layer.id }));
  assert.equal(document.layers.at(-1).type, 'raster'); assert.deepEqual(await render(), transformed);
  await run('undo'); assert.equal((await run('get_document')).document.layers.at(-1).type, 'shape');
  assert.deepEqual(await render(), transformed);
});

test('native path and gradient edits survive save/reopen and canvas geometry without flattening', async (t) => {
  const { run, render, dataDir, document: initial } = await fixture(t);
  let { document } = await run('add_gradient', { ...gradientArgs, end: { x: 31.5, y: 0.5 } });
  const gradientId = document.layers.at(-1).id;
  await run('update_gradient', { layerId: gradientId, kind: 'radial', start: { x: 16, y: 16 } });
  ({ document } = await run('add_path', { nodes: [{ x: 4, y: 16, out: { x: 4, y: 0 } }, { x: 28, y: 16, in: { x: 28, y: 0 } }], stroke: '#ff0000', strokeWidth: 3 }));
  const pathId = document.layers.at(-1).id;
  await run('update_path', { layerId: pathId, stroke: '#00ff00' });
  await run('crop_document', { x: 4, y: 4, width: 24, height: 24 });
  ({ document } = await run('resize_document', { width: 12, height: 12 }));
  assert.equal(document.layers[1].width, 32); assert.equal(document.layers[1].gradient.kind, 'radial');
  assert.equal(document.layers[2].vector.nodes[0].out.y, 0);
  const before = await render();
  const reopened = await new NativeBackend({ dataDir }).init();
  const loaded = (await reopened.execute('get_document', { documentId: initial.id })).document;
  assert.equal(loaded.layers[1].type, 'gradient'); assert.equal(loaded.layers[2].type, 'path');
  const exported = await reopened.execute('export_document', { documentId: initial.id, format: 'png' });
  assert.deepEqual(await sharp(Buffer.from(exported.data, 'base64')).ensureAlpha().raw().toBuffer(), before);
  await run('rasterize_layer', { layerId: gradientId }); assert.deepEqual(await render(), before);
});

test('vector transaction rollback rejects invalid settings without changing file, history or pixels', async (t) => {
  const { run, render, dataDir, document } = await fixture(t);
  const before = await render();
  const file = path.join(dataDir, 'projects', `${document.id}.json`), saved = await fs.readFile(file);
  await assert.rejects(run('apply_transaction', { operations: [
    { command: 'add_shape', args: shapeArgs },
    { command: 'add_gradient', args: { ...gradientArgs, stops: [] } },
  ] }), coded('INVALID_ARGUMENT'));
  assert.deepEqual(await fs.readFile(file), saved); assert.deepEqual(await render(), before);
  assert.equal((await run('get_document')).document.revision, 1);
  const result = await run('apply_transaction', { operations: [{ command: 'add_shape', args: shapeArgs }, { command: 'add_gradient', args: gradientArgs }] });
  assert.equal(result.document.revision, 2); assert.equal(result.document.history.length, 2);
  await run('undo'); assert.deepEqual(await render(), before);
});

test('a gradient drawn inside an active selection is confined to it by an editable layer mask', async (t) => {
  const { run, render } = await fixture(t);
  await run('select_region', { shape: 'rectangle', x: 8, y: 8, width: 16, height: 16 });
  const { document } = await run('add_gradient', { ...gradientArgs, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#000000' }] });
  assert.deepEqual(document.layers.at(-1).mask, { shape: 'rectangle', x: 8, y: 8, width: 16, height: 16, feather: 0, invert: false });
  const pixels = await render();
  assert.deepEqual(rgba(pixels, 32, 2, 2), [255, 255, 255, 255]);
  assert.deepEqual(rgba(pixels, 32, 16, 16), [0, 0, 0, 255]);
  await run('clear_selection');
  assert.equal((await run('add_gradient', gradientArgs)).document.layers.at(-1).mask, undefined);
});
