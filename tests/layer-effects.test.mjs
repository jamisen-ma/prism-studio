import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEffects, renderOutsideEffects } from '../server/layer-effects.mjs';

const pixel = (pixels, x, y, width) => [...pixels.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
function point(width, height, x, y, alpha = 255) { const pixels = Buffer.alloc(width * height * 4); pixels.set([32, 91, 147, alpha], (y * width + x) * 4); return pixels; }
const coded = (code) => (cause) => cause.code === code;

test('effects normalize exact defaults without mutating input, and null/empty clear', () => {
  const input = { shadow: {}, glow: {} }, copy = structuredClone(input);
  assert.deepEqual(normalizeEffects(input), { shadow: { color: '#000000', opacity: 0.35, blur: 8, x: 4, y: 6 }, glow: { color: '#ffffff', opacity: 0.5, blur: 8 } });
  assert.deepEqual(input, copy); assert.equal(normalizeEffects(null), null); assert.equal(normalizeEffects({}), null);
  assert.equal(normalizeEffects({ shadow: { color: '#AaBBcc' } }).shadow.color, '#aabbcc');
  for (const invalid of [undefined, [], { innerShadow: {} }, { shadow: null }, { glow: { x: 1 } }, { shadow: { blur: 65 } }, { glow: { opacity: -1 } }, { shadow: { x: 257 } }, { shadow: { y: -257 } }, { glow: { color: 'red' } }, { shadow: { opacity: null } }, { shadow: { blur: NaN } }]) assert.throws(() => normalizeEffects(invalid), coded('INVALID_ARGUMENT'));
});

test('unblurred shadows translate exact coverage, retain soft alpha, and never modify source input or occupied pixels', async () => {
  const source = point(9, 7, 3, 3, 128), original = Buffer.from(source);
  source.set([8, 9, 10, 1], (3 * 9 + 5) * 4);
  const result = await renderOutsideEffects(source, 9, 7, { shadow: { x: 2, y: 0, blur: 0, opacity: 1, color: '#ff0000' } });
  assert.equal(pixel(result, 5, 3, 9)[3], 0, 'even an alpha1 source pixel is excluded from styles');
  assert.deepEqual(pixel(result, 7, 3, 9), [255, 0, 0, 1]);
  assert.equal(pixel(result, 3, 3, 9)[3], 0);
  const shifted = await renderOutsideEffects(original, 9, 7, { shadow: { x: 1, y: 0, blur: 0, opacity: 0.5, color: '#ff0000' } });
  assert.deepEqual(pixel(shifted, 4, 3, 9), [255, 0, 0, 64]);
  assert.deepEqual(original, point(9, 7, 3, 3, 128));
});

test('fractional offsets use bilinear alpha and masked-out pixels neither cast nor block effects', async () => {
  const source = point(9, 9, 3, 3);
  const result = await renderOutsideEffects(source, 9, 9, { shadow: { x: 1.5, y: 0, blur: 0, opacity: 1 } }, () => 0.5);
  assert.deepEqual(pixel(result, 4, 3, 9), [0, 0, 0, 64]); assert.deepEqual(pixel(result, 5, 3, 9), [0, 0, 0, 64]);
  assert.equal(await renderOutsideEffects(source, 9, 9, { shadow: {} }, () => 0), null);
  source.set([8, 9, 10, 255], (3 * 9 + 4) * 4);
  const masked = await renderOutsideEffects(source, 9, 9, { shadow: { x: 1, y: 0, blur: 0, opacity: 1 } }, (x) => x === 4 ? 0 : 1);
  assert.equal(pixel(masked, 4, 3, 9)[3], 255); assert.equal(pixel(masked, 5, 3, 9)[3], 0);
});

test('Gaussian glow spreads symmetrically outside the original silhouette and zero padding avoids edge replication', async () => {
  const centered = await renderOutsideEffects(point(31, 31, 15, 15), 31, 31, { glow: { blur: 2, opacity: 1, color: '#abcdef' } });
  assert.equal(pixel(centered, 15, 15, 31)[3], 0);
  assert.ok(pixel(centered, 16, 15, 31)[3] > pixel(centered, 19, 15, 31)[3]);
  assert.equal(pixel(centered, 16, 15, 31)[3], pixel(centered, 14, 15, 31)[3]);
  assert.equal(pixel(centered, 16, 15, 31)[3], pixel(centered, 15, 16, 31)[3]);
  const settings = { shadow: { blur: 2, opacity: 1, x: -2, y: 0, color: '#123456' } };
  const small = await renderOutsideEffects(point(15, 15, 0, 7), 15, 15, settings);
  const large = await renderOutsideEffects(point(31, 31, 8, 15), 31, 31, settings);
  for (let y = 0; y < 15; y++) for (let x = 0; x < 15; x++) assert.deepEqual(pixel(small, x, y, 15), pixel(large, x + 8, y + 8, 31));
});

test('resource and coverage validation reject unsafe inputs before allocating a large surface', async () => {
  await assert.rejects(renderOutsideEffects(Buffer.alloc(4), 8193, 1, { shadow: {} }), coded('LIMIT_EXCEEDED'));
  await assert.rejects(renderOutsideEffects(Buffer.alloc(4), 5000, 5000, { shadow: {} }), coded('LIMIT_EXCEEDED'));
  const source = point(2, 2, 0, 0);
  await assert.rejects(renderOutsideEffects(source, 2, 2, { shadow: {} }, () => Infinity), coded('INVALID_ARGUMENT'));
  await assert.rejects(renderOutsideEffects(source, 2, 2, { shadow: {} }, () => { throw new Error('private callback details'); }), (cause) => cause.code === 'INVALID_ARGUMENT' && !cause.message.includes('private'));
  assert.equal(await renderOutsideEffects(source, 2, 2, { shadow: { opacity: 0 }, glow: { opacity: 0 } }), null);
});
