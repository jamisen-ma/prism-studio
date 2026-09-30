import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStroke } from '../server/retouch.mjs';

function image(width, height, fill = [0, 0, 0, 0]) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.set(typeof fill === 'function' ? fill(x, y) : fill, (y * width + x) * 4);
  return pixels;
}
function pixel(pixels, width, x, y) { return Array.from(pixels.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)); }
function options(overrides = {}) {
  return { pixels: image(32, 32), width: 32, height: 32, tool: 'brush', points: [{ x: 16.5, y: 16.5 }], size: 8, hardness: 1, opacity: 1, color: '#C86432', ...overrides };
}

test('brush uses source-over alpha and returns a new buffer without changing either input', () => {
  const pixels = image(32, 32, [10, 20, 30, 128]);
  const composite = image(32, 32, [80, 70, 60, 255]);
  const original = Buffer.from(pixels), frozenComposite = Buffer.from(composite);
  const result = applyStroke(options({ pixels, composite, opacity: 0.5 }));
  assert.ok(Buffer.isBuffer(result)); assert.notStrictEqual(result, pixels);
  assert.deepEqual(pixels, original); assert.deepEqual(composite, frozenComposite);
  const center = pixel(result, 32, 16, 16);
  assert.deepEqual(center, [137, 73, 43, 192]);
  assert.deepEqual(pixel(result, 32, 0, 0), [10, 20, 30, 128]);
});

test('eraser reduces alpha and preserves all RGB bytes, including hidden colors', () => {
  const pixels = image(32, 32, [71, 82, 93, 200]);
  const result = applyStroke(options({ pixels, tool: 'eraser', opacity: 0.5 }));
  assert.deepEqual(pixel(result, 32, 16, 16), [71, 82, 93, 100]);
  const erased = applyStroke(options({ pixels, tool: 'eraser' }));
  assert.deepEqual(pixel(erased, 32, 16, 16), [71, 82, 93, 0]);
  assert.deepEqual(pixel(pixels, 32, 16, 16), [71, 82, 93, 200]);
});

for (const tool of ['brush', 'pencil', 'eraser', 'clone', 'heal', 'dodge', 'burn', 'blur', 'sharpen', 'smudge', 'sponge', 'red_eye', 'color_replace']) {
  test(`${tool} leaves every pixel outside its tip or selection exactly unchanged`, () => {
    const pixels = image(32, 32, (x, y) => [100 + x, 70 + y, 50, x % 2 ? 123 : 255]);
    const composite = image(32, 32, [220, 160, 80, 255]);
    const original = Buffer.from(pixels);
    const result = applyStroke(options({ pixels, composite, tool, source: { x: 8.5, y: 8.5 }, coverage: (x) => x < 16.5 ? 1 : 0 }));
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      const outsideTip = Math.hypot(x - 16, y - 16) >= 4.5;
      if (outsideTip || x >= 16) assert.deepEqual(pixel(result, 32, x, y), pixel(original, 32, x, y));
    }
    assert.deepEqual(pixels, original);
  });
}

test('selection coverage scales opacity and receives pixel centers', () => {
  const seen = [];
  const result = applyStroke(options({ coverage: (x, y) => { seen.push([x, y]); return 0.25; } }));
  assert.equal(pixel(result, 32, 16, 16)[3], 64);
  assert.ok(seen.some(([x, y]) => x === 16.5 && y === 16.5));
  assert.ok(seen.every(([x, y]) => x % 1 === 0.5 && y % 1 === 0.5));
});

test('clone samples frozen pre-stroke composite even when buffers alias and regions overlap', () => {
  const pixels = image(20, 8, x => [x * 10, 30, 60, 255]);
  const original = Buffer.from(pixels);
  const result = applyStroke(options({ width: 20, height: 8, pixels, composite: pixels, tool: 'clone', points: [{ x: 4.5, y: 4.5 }, { x: 12.5, y: 4.5 }], source: { x: 0.5, y: 4.5 }, size: 4 }));
  assert.deepEqual(pixel(result, 20, 4, 4), [0, 30, 60, 255]);
  assert.deepEqual(pixel(result, 20, 8, 4), [40, 30, 60, 255]);
  assert.deepEqual(pixel(result, 20, 12, 4), [80, 30, 60, 255]);
  assert.deepEqual(pixels, original);
});

test('clone bilinear sampling is alpha-correct and out-of-image source contributes zero', () => {
  const pixels = image(8, 4);
  const composite = image(8, 4, x => x === 1 ? [255, 0, 0, 255] : [0, 255, 0, 0]);
  const args = options({ width: 8, height: 4, pixels, composite, tool: 'clone', points: [{ x: 5.5, y: 1.5 }], source: { x: 2, y: 1.5 }, size: 2 });
  assert.deepEqual(pixel(applyStroke(args), 8, 5, 1), [255, 0, 0, 128]);
  assert.deepEqual(applyStroke({ ...args, source: { x: -100, y: -100 } }), pixels);
});

test('sampled healing matches local destination color without generating content', () => {
  const width = 48, height = 24;
  const pixels = image(width, height, x => x < 24 ? [40 + (x % 3 - 1) * 4, 60, 80, 255] : [140, 160, 180, 255]);
  pixels.set([240, 245, 250, 255], (12 * width + 36) * 4);
  const original = Buffer.from(pixels);
  const args = options({ width, height, pixels, composite: pixels, points: [{ x: 36.5, y: 12.5 }], source: { x: 12.5, y: 12.5 }, size: 6 });
  const healed = pixel(applyStroke({ ...args, tool: 'heal' }), width, 36, 12);
  const cloned = pixel(applyStroke({ ...args, tool: 'clone' }), width, 36, 12);
  assert.ok(Math.abs(healed[0] - 140) < 8); assert.equal(healed[1], 160); assert.equal(healed[2], 180);
  assert.equal(cloned[0], 36); assert.equal(cloned[1], 60);
  assert.deepEqual(pixels, original);
});

test('dodge and burn adjust exposure while retaining alpha and fully transparent bytes', () => {
  for (const tool of ['dodge', 'burn']) {
    const pixels = image(32, 32, [128, 90, 60, 123]);
    pixels.set([12, 34, 56, 0], (16 * 32 + 17) * 4);
    const result = applyStroke(options({ pixels, tool }));
    const center = pixel(result, 32, 16, 16);
    assert.equal(center[3], 123);
    assert.ok(tool === 'dodge' ? center[0] > 128 : center[0] < 128);
    assert.deepEqual(pixel(result, 32, 17, 16), [12, 34, 56, 0]);
  }
});

test('fast strokes interpolate without holes; pressure changes radius and opacity', () => {
  const width = 128, height = 20;
  const args = options({ width, height, pixels: image(width, height), size: 3, points: [{ x: 4.5, y: 10.5, pressure: 0.1 }, { x: 122.5, y: 10.5, pressure: 1 }] });
  const result = applyStroke(args);
  for (let x = 5; x < 122; x++) assert.ok(pixel(result, width, x, 10)[3] > 0, `gap at x=${x}`);
  assert.ok(pixel(result, width, 8, 10)[3] < 80);
  assert.ok(pixel(result, width, 118, 10)[3] > 200);
  const full = applyStroke(options({ size: 16 }));
  const light = applyStroke(options({ size: 16, points: [{ x: 16.5, y: 16.5, pressure: 0.25 }] }));
  assert.equal(pixel(light, 32, 16, 16)[3], 64);
  assert.equal(pixel(light, 32, 22, 16)[3], 0);
  assert.equal(pixel(full, 32, 22, 16)[3], 255);
});

test('overlapping dabs do not build opacity from input event density', () => {
  const args = options({ size: 6, opacity: 0.25, points: [{ x: 4.5, y: 16.5 }, { x: 27.5, y: 16.5 }] });
  const sparse = applyStroke(args);
  const dense = applyStroke({ ...args, points: Array.from({ length: 47 }, (_, index) => ({ x: 4.5 + index * 0.5, y: 16.5 })) });
  for (let x = 5; x <= 27; x++) {
    assert.equal(pixel(sparse, 32, x, 16)[3], 64);
    assert.equal(pixel(dense, 32, x, 16)[3], 64);
  }
  for (let index = 3; index < dense.length; index += 4) assert.ok(dense[index] <= 64);
  const repeated = applyStroke(options({ opacity: 0.25, points: Array.from({ length: 100 }, () => ({ x: 16.5, y: 16.5 })) }));
  assert.equal(pixel(repeated, 32, 16, 16)[3], 64);
});

test('hardness controls falloff; zero pressure/opacity and off-canvas strokes are exact no-ops', () => {
  const soft = applyStroke(options({ hardness: 0 }));
  const hard = applyStroke(options({ hardness: 1 }));
  assert.ok(pixel(soft, 32, 18, 16)[3] < pixel(hard, 32, 18, 16)[3]);
  const pixels = image(32, 32, [11, 22, 33, 44]);
  for (const overrides of [{ opacity: 0 }, { points: [{ x: 16, y: 16, pressure: 0 }] }, { points: [{ x: -100, y: -100 }, { x: -50, y: -50 }] }]) {
    const result = applyStroke(options({ pixels, ...overrides }));
    assert.deepEqual(result, pixels); assert.notStrictEqual(result, pixels);
  }
  const crossing = applyStroke(options({ points: [{ x: -20, y: 16.5 }, { x: 50, y: 16.5 }] }));
  assert.equal(pixel(crossing, 32, 0, 16)[3], 255);
  assert.equal(pixel(crossing, 32, 31, 16)[3], 255);
});

test('direct module calls validate inputs, pressure, color, sampling and coverage values', () => {
  const invalid = [
    { width: 0 }, { width: 1.5 }, { height: Infinity }, { pixels: new Uint16Array(4096) },
    { pixels: Buffer.alloc(4) }, { composite: Buffer.alloc(4) }, { tool: 'generate' },
    { size: 513 }, { size: NaN }, { hardness: -0.1 }, { opacity: 1.1 }, { color: '#123' },
    { points: [] }, { points: Array(2) }, { points: [{ x: 1 }] }, { points: [{ x: 1, y: 1, pressure: -1 }] },
    { points: [{ x: -8193, y: 1 }] }, { points: [{ x: 1, y: 1, pressure: '1' }] },
    { points: Array.from({ length: 2001 }, () => ({ x: 1, y: 1 })) },
    { tool: 'clone' }, { tool: 'heal', source: { x: 1, y: 1 } },
    { source: { x: 1, y: Infinity } }, { coverage: true }, { coverage: () => NaN },
    { coverage: () => 2 }, { coverage: () => Promise.resolve(1) },
    { coverage: () => { throw new Error('broken mask'); } }
  ];
  for (const overrides of invalid) assert.throws(() => applyStroke(options(overrides)), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => applyStroke(null), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => applyStroke(options({ width: 8192, height: 8192 })), { code: 'LIMIT_EXCEEDED' });
});

test('resource limits reject excessive interpolation or tip work without changing source pixels', () => {
  const width = 1024, height = 64;
  const pixels = image(width, height, [11, 22, 33, 44]);
  const original = Buffer.from(pixels);
  const points = Array.from({ length: 200 }, (_, index) => ({ x: index % 2 ? 1023 : 0, y: 32 }));
  assert.throws(() => applyStroke(options({ width, height, pixels, points, size: 512 })), { code: 'LIMIT_EXCEEDED' });
  assert.deepEqual(pixels, original);
  assert.throws(() => applyStroke(options({ width, height, pixels, points, size: 1 })), { code: 'LIMIT_EXCEEDED' });
  assert.deepEqual(pixels, original);
});

test('pencil snaps to the pixel grid without antialiased edge pixels', () => {
  const args = options({ tool: 'pencil', size: 3, hardness: 0, points: [{ x: 8.2, y: 8.8 }, { x: 23.9, y: 8.1 }] });
  const result = applyStroke(args);
  for (let index = 3; index < result.length; index += 4) assert.ok(result[index] === 0 || result[index] === 255);
  for (let x = 8; x <= 23; x++) assert.equal(pixel(result, 32, x, 8)[3], 255);
  const dot = applyStroke(options({ tool: 'pencil', size: 1, points: [{ x: 4, y: 5 }] }));
  assert.equal(pixel(dot, 32, 4, 5)[3], 255);
  assert.equal(pixel(dot, 32, 5, 5)[3], 0);
});

test('localized blur smooths high-frequency detail with premultiplied alpha', () => {
  const pixels = image(32, 32, [0, 0, 0, 255]);
  pixels.set([255, 255, 255, 255], (16 * 32 + 16) * 4);
  const blurred = applyStroke(options({ pixels, tool: 'blur', strength: 100 }));
  assert.deepEqual(pixel(blurred, 32, 16, 16), [64, 64, 64, 255]);
  assert.deepEqual(pixel(blurred, 32, 17, 16), [32, 32, 32, 255]);
  const transparent = image(32, 32, [0, 255, 0, 0]);
  transparent.set([255, 0, 0, 255], (16 * 32 + 16) * 4);
  const alphaBlur = applyStroke(options({ pixels: transparent, tool: 'blur', strength: 100 }));
  assert.deepEqual(pixel(alphaBlur, 32, 17, 16), [255, 0, 0, 32]);
});

test('localized sharpening increases detail contrast and preserves alpha', () => {
  const pixels = image(32, 32, [100, 100, 100, 77]);
  pixels.set([150, 150, 150, 77], (16 * 32 + 16) * 4);
  const sharpened = applyStroke(options({ pixels, tool: 'sharpen', strength: 100 }));
  assert.deepEqual(pixel(sharpened, 32, 16, 16), [225, 225, 225, 77]);
  assert.ok(pixel(sharpened, 32, 17, 16)[0] < 100);
  const uniform = image(32, 32, [42, 123, 210, 255]);
  assert.deepEqual(applyStroke(options({ pixels: uniform, tool: 'sharpen', strength: 100 })), uniform);
});

test('smudge carries sampled pigment in the drag direction and leaves input unchanged', () => {
  const pixels = image(32, 16, x => x < 8 ? [255, 0, 0, 255] : [0, 0, 255, 255]);
  const original = Buffer.from(pixels);
  const args = options({ width: 32, height: 16, pixels, tool: 'smudge', size: 6, strength: 100 });
  const forward = applyStroke({ ...args, points: [{ x: 4.5, y: 8.5 }, { x: 20.5, y: 8.5 }] });
  assert.ok(pixel(forward, 32, 12, 8)[0] > 100);
  assert.ok(pixel(forward, 32, 12, 8)[2] < 155);
  const reverse = applyStroke({ ...args, points: [{ x: 20.5, y: 8.5 }, { x: 4.5, y: 8.5 }] });
  assert.ok(pixel(reverse, 32, 5, 8)[2] > 100);
  assert.deepEqual(pixels, original);
});

test('sponge supports saturation and desaturation while preserving alpha', () => {
  const pixels = image(32, 32, [200, 100, 50, 123]);
  const desaturated = pixel(applyStroke(options({ pixels, tool: 'sponge', strength: -100 })), 32, 16, 16);
  assert.deepEqual(desaturated, [125, 125, 125, 123]);
  const saturated = pixel(applyStroke(options({ pixels, tool: 'sponge', strength: 100 })), 32, 16, 16);
  assert.ok(saturated[0] > 200); assert.ok(saturated[2] < 50); assert.equal(saturated[3], 123);
});

test('red-eye correction suppresses red-dominant pixels and preserves neutral/brown pixels', () => {
  const pixels = image(32, 32, [220, 30, 30, 200]);
  pixels.set([240, 240, 240, 255], (16 * 32 + 17) * 4);
  pixels.set([140, 110, 90, 255], (16 * 32 + 15) * 4);
  const result = applyStroke(options({ pixels, tool: 'red_eye', strength: 100 }));
  assert.deepEqual(pixel(result, 32, 16, 16), [30, 30, 30, 200]);
  assert.deepEqual(pixel(result, 32, 17, 16), [240, 240, 240, 255]);
  assert.deepEqual(pixel(result, 32, 15, 16), [140, 110, 90, 255]);
});

test('color replacement honors sampled tolerance and preserves luminance/alpha', () => {
  const pixels = image(32, 32, [180, 40, 40, 177]);
  pixels.set([40, 180, 40, 177], (16 * 32 + 17) * 4);
  const args = options({ pixels, tool: 'color_replace', color: '#0044FF', strength: 100, tolerance: 0 });
  const result = applyStroke(args);
  const replaced = pixel(result, 32, 16, 16);
  const lum = rgb => rgb[0] * 0.3 + rgb[1] * 0.59 + rgb[2] * 0.11;
  assert.ok(replaced[2] > replaced[0]);
  assert.ok(Math.abs(lum(replaced) - lum([180, 40, 40])) < 1);
  assert.equal(replaced[3], 177);
  assert.deepEqual(pixel(result, 32, 17, 16), [40, 180, 40, 177]);
  assert.notDeepEqual(pixel(applyStroke({ ...args, tolerance: 255 }), 32, 17, 16), [40, 180, 40, 177]);
});

test('new tool parameters validate direct calls and zero strength does nothing', () => {
  const pixels = image(32, 32, [180, 60, 30, 177]);
  for (const tool of ['blur', 'sharpen', 'smudge', 'sponge', 'red_eye', 'color_replace']) {
    assert.deepEqual(applyStroke(options({ pixels, tool, strength: 0 })), pixels);
  }
  for (const overrides of [
    { tool: 'blur', strength: -1 }, { tool: 'smudge', strength: 101 },
    { tool: 'sponge', strength: -101 }, { tool: 'sponge', strength: Infinity },
    { tool: 'color_replace', color: undefined }, { tool: 'color_replace', tolerance: -1 },
    { tool: 'color_replace', tolerance: 256 }, { tool: 'color_replace', strength: '50' }
  ]) assert.throws(() => applyStroke(options({ pixels, ...overrides })), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => applyStroke(options({ tool: 'color_replace' })), { code: 'INVALID_ARGUMENT' });
});
