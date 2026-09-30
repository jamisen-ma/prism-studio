import test from 'node:test';
import assert from 'node:assert/strict';
import { canvasTransform, resizeCanvasPixels, resizeCanvasMask } from '../server/canvas.mjs';
import { bitmapBytes, bitmapMask, maskCoverage } from '../server/masks.mjs';

function fixture(width, height) {
  const buffer = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) buffer.set([(i * 31) % 256, (i * 67) % 256, (i * 97) % 256, [0, 1, 64, 128, 254, 255][i % 6]], i * 4);
  return buffer;
}
const pixel = (buffer, width, x, y) => buffer.subarray((y * width + x) * 4, (y * width + x) * 4 + 4);

test('all nine anchors position expansion and crop correctly', () => {
  const anchors = {
    'top-left': [0, 0], top: [2, 0], 'top-right': [4, 0],
    left: [0, 3], center: [2, 3], right: [4, 3],
    'bottom-left': [0, 6], bottom: [2, 6], 'bottom-right': [4, 6]
  };
  for (const [anchor, [x, y]] of Object.entries(anchors)) {
    assert.deepEqual(canvasTransform(4, 4, 8, 10, anchor), { type: 'canvas', width: 8, height: 10, x, y });
    assert.deepEqual(canvasTransform(8, 10, 4, 4, anchor), { type: 'canvas', width: 4, height: 4, x: -x || 0, y: -y || 0 });
  }
});

test('center uses floor for odd positive and negative dimension differences', () => {
  assert.deepEqual(canvasTransform(3, 3, 6, 8), { type: 'canvas', width: 6, height: 8, x: 1, y: 2 });
  assert.deepEqual(canvasTransform(6, 8, 3, 3), { type: 'canvas', width: 3, height: 3, x: -2, y: -3 });
  const source = fixture(5, 3);
  const cropped = resizeCanvasPixels(source, 5, 3, canvasTransform(5, 3, 4, 2));
  assert.deepEqual(pixel(cropped, 4, 0, 0), pixel(source, 5, 1, 1));
  assert.deepEqual(pixel(cropped, 4, 3, 1), pixel(source, 5, 4, 2));
});

test('RGBA copying is byte-exact for every anchor, including hidden RGB and fractional alpha', () => {
  const source = fixture(3, 2), original = Buffer.from(source);
  for (const anchor of ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right']) {
    const transform = canvasTransform(3, 2, 8, 7, anchor);
    const result = resizeCanvasPixels(source, 3, 2, transform);
    assert.ok(Buffer.isBuffer(result)); assert.notStrictEqual(result, source);
    for (let y = 0; y < 7; y++) for (let x = 0; x < 8; x++) {
      const sx = x - transform.x, sy = y - transform.y;
      const expected = sx >= 0 && sy >= 0 && sx < 3 && sy < 2 ? pixel(source, 3, sx, sy) : Buffer.alloc(4);
      assert.deepEqual(pixel(result, 8, x, y), expected);
    }
  }
  assert.deepEqual(source, original);
});

test('mixed-axis crop/expansion and fully clipped transforms copy only the intersection', () => {
  const source = fixture(5, 3);
  const transform = canvasTransform(5, 3, 3, 5, 'bottom-right');
  const result = resizeCanvasPixels(source, 5, 3, transform);
  assert.deepEqual(pixel(result, 3, 0, 2), pixel(source, 5, 2, 0));
  assert.deepEqual(pixel(result, 3, 2, 4), pixel(source, 5, 4, 2));
  assert.deepEqual(result.subarray(0, 3 * 2 * 4), Buffer.alloc(3 * 2 * 4));
  const empty = resizeCanvasPixels(source, 5, 3, { type: 'canvas', width: 4, height: 4, x: 4, y: 4 });
  assert.deepEqual(empty, Buffer.alloc(4 * 4 * 4));
});

test('identity canvas returns a fresh exact pixel buffer', () => {
  const source = fixture(7, 5);
  const result = resizeCanvasPixels(source, 7, 5, canvasTransform(7, 5, 7, 5));
  assert.notStrictEqual(result, source); assert.deepEqual(result, source);
});

test('null masks remain null, including during expansion', () => {
  const transform = canvasTransform(3, 3, 5, 5);
  assert.equal(resizeCanvasMask(null, 3, 3, transform), null);
  assert.equal(resizeCanvasMask(undefined, 3, 3, transform), null);
});

test('fractional bitmap alpha translates exactly and source runs stay immutable', () => {
  const bytes = new Uint8Array([0, 1, 64, 128, 254, 255]);
  const mask = bitmapMask(bytes, 3, 2), original = structuredClone(mask);
  const transform = canvasTransform(3, 2, 5, 4);
  const result = resizeCanvasMask(mask, 3, 2, transform);
  const baked = bitmapBytes(result);
  assert.equal(result.shape, 'bitmap'); assert.equal(result.invert, false); assert.equal(result.feather, 0);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 3; x++) assert.equal(baked[(y + 1) * 5 + x + 1], bytes[y * 3 + x]);
  assert.deepEqual(mask, original);
});

test('feathered geometric masks preserve exact coverage through cropping and expansion', () => {
  const masks = [
    { x: 0.25, y: 0.25, width: 7.5, height: 7.5, feather: 3.7 },
    { shape: 'ellipse', x: 0.25, y: 0.25, width: 7.5, height: 7.5, feather: 2.3 },
    { shape: 'polygon', points: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 4, y: 8 }], x: 0, y: 0, width: 8, height: 8, feather: 2.3 }
  ];
  for (const input of masks) for (const invert of [false, true]) for (const [width, height] of [[4, 4], [11, 13], [5, 12]]) {
    const mask = { ...input, invert }, original = structuredClone(mask);
    const transform = canvasTransform(8, 8, width, height);
    const before = maskCoverage(mask);
    const result = resizeCanvasMask(mask, 8, 8, transform);
    const after = maskCoverage(result);
    assert.equal(result.shape, mask.shape);
    assert.equal(result.feather, mask.feather);
    assert.equal(result.invert, mask.invert);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const sx = x - transform.x, sy = y - transform.y;
      const expected = sx >= 0 && sy >= 0 && sx < 8 && sy < 8 ? before(sx, sy) : 0;
      assert.equal(after(x, y), expected);
    }
    assert.deepEqual(mask, original);
  }
});

test('inverted vector and bitmap masks never select newly exposed padding', () => {
  const masks = [
    { x: 1, y: 1, width: 2, height: 2, feather: 1, invert: true },
    { ...bitmapMask(new Uint8Array([0, 1, 64, 128, 254, 255, 0, 10, 100, 200, 255, 0, 0, 0, 0, 255]), 4, 4), invert: true },
    { ...bitmapMask(new Uint8Array(16).fill(255), 4, 4), feather: 2, invert: true }
  ];
  const transform = canvasTransform(4, 4, 7, 7);
  for (const mask of masks) {
    const before = maskCoverage(mask), result = resizeCanvasMask(mask, 4, 4, transform);
    const after = maskCoverage(result);
    if (mask.shape === 'bitmap') {
      assert.equal(result.invert, false); assert.equal(result.feather, 0);
    } else {
      assert.equal(result.invert, mask.invert); assert.equal(result.feather, mask.feather);
    }
    for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
      const sx = x - 1, sy = y - 1;
      const expected = sx >= 0 && sy >= 0 && sx < 4 && sy < 4 ? (mask.shape === 'bitmap' ? Math.round(before(sx, sy) * 255) / 255 : before(sx, sy)) : 0;
      assert.equal(after(x, y), expected);
    }
  }
});

test('persisted masks outside original bounds remain valid and only original coverage is copied', () => {
  const mask = { x: -3, y: -2, width: 10, height: 8, feather: 2, invert: false };
  const result = resizeCanvasMask(mask, 4, 4, canvasTransform(4, 4, 6, 6));
  const before = maskCoverage(mask), after = maskCoverage(result);
  assert.equal(after(0, 0), 0);
  assert.equal(after(1, 1), before(0, 0));
  assert.equal(after(4, 4), before(3, 3));
});

test('identity masks remain deeply equal without shared nested state', () => {
  const masks = [
    { x: 0.25, y: 0.5, width: 3, height: 2.5, feather: 1.7 },
    { shape: 'polygon', points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 2, y: 4 }], x: 0, y: 0, width: 4, height: 4, feather: 2.3, invert: true, clip: { x: 1, y: 0, width: 2, height: 4 } },
    { ...bitmapMask(new Uint8Array(16).fill(128), 4, 4), feather: 2.5, invert: true }
  ];
  for (const mask of masks) {
    const result = resizeCanvasMask(mask, 4, 4, canvasTransform(4, 4, 4, 4));
    assert.deepEqual(result, mask);
    assert.notStrictEqual(result, mask);
    for (const key of ['points', 'clip', 'runs']) if (mask[key]) assert.notStrictEqual(result[key], mask[key]);
  }
});

test('prior geometric clips survive cropping and repeated expansion without recovering discarded coverage', () => {
  const mask = { shape: 'ellipse', x: -1, y: -1, width: 10, height: 10, feather: 3.7, invert: true, clip: { x: 1.25, y: 0.25, width: 5.5, height: 6.5 } };
  const original = structuredClone(mask), before = maskCoverage(mask);
  const crop = canvasTransform(8, 8, 5, 5);
  const cropped = resizeCanvasMask(mask, 8, 8, crop);
  assert.deepEqual(cropped.clip, { x: 0, y: 0, width: 4.75, height: 4.75 });
  const expansion = canvasTransform(5, 5, 10, 10);
  const expanded = resizeCanvasMask(cropped, 5, 5, expansion), after = maskCoverage(expanded);
  assert.deepEqual(expanded.clip, { x: 2, y: 2, width: 4.75, height: 4.75 });
  for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) {
    const cx = x - expansion.x, cy = y - expansion.y;
    const expected = cx >= 0 && cy >= 0 && cx < 5 && cy < 5 ? before(cx - crop.x, cy - crop.y) : 0;
    assert.equal(after(x, y), expected);
  }
  assert.deepEqual(mask, original);
});

test('fully displaced geometric masks receive bounded empty clips after inversion', () => {
  const mask = { x: 0, y: 0, width: 4, height: 4, feather: 1.3, invert: true };
  for (const [x, y, expected] of [[8, 8, { x: 5, y: 5, width: 0, height: 0 }], [-8, -8, { x: 0, y: 0, width: 0, height: 0 }]]) {
    const result = resizeCanvasMask(mask, 4, 4, { type: 'canvas', width: 5, height: 5, x, y });
    assert.deepEqual(result.clip, expected);
    const coverage = maskCoverage(result);
    for (let py = 0; py < 5; py++) for (let px = 0; px < 5; px++) assert.equal(coverage(px, py), 0);
  }
});

test('dimensions, anchors, buffers, transforms and mask shape are validated directly', () => {
  for (const dimensions of [[0, 1, 1, 1], [1, -1, 1, 1], [1, 1, 8193, 1], [1, 1, 1.5, 2], [1, 1, 2, Infinity]]) {
    assert.throws(() => canvasTransform(...dimensions), { code: 'INVALID_ARGUMENT' });
  }
  assert.throws(() => canvasTransform(8192, 8192, 1, 1), { code: 'LIMIT_EXCEEDED' });
  assert.throws(() => canvasTransform(1, 1, 8192, 8192), { code: 'LIMIT_EXCEEDED' });
  for (const anchor of ['middle', '__proto__', null, {}]) assert.throws(() => canvasTransform(1, 1, 2, 2, anchor), { code: 'INVALID_ARGUMENT' });
  const source = fixture(2, 2), valid = canvasTransform(2, 2, 3, 3);
  for (const transform of [null, { ...valid, type: 'resize' }, { ...valid, x: 0.5 }, { ...valid, y: NaN }, { ...valid, x: -8193 }]) {
    assert.throws(() => resizeCanvasPixels(source, 2, 2, transform), { code: 'INVALID_ARGUMENT' });
    assert.throws(() => resizeCanvasMask(null, 2, 2, transform), { code: 'INVALID_ARGUMENT' });
  }
  assert.throws(() => resizeCanvasPixels(Buffer.alloc(4), 2, 2, valid), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => resizeCanvasPixels(new Uint8Array(source), 2, 2, valid), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => resizeCanvasMask({ shape: 'unsupported' }, 2, 2, valid), { code: 'INVALID_ARGUMENT' });
});

test('output bitmap masks enforce existing RLE complexity limits', () => {
  // Equal alphas at each old row boundary share a run. New transparent padding
  // splits those runs and pushes an otherwise valid mask over the output limit.
  const width = 503, height = 398;
  const bytes = Uint8Array.from({ length: width * height }, (_, i) => (i % width) % 2 + 1);
  const mask = bitmapMask(bytes, width, height);
  assert.ok(mask.runs.length <= 600_000);
  assert.throws(() => resizeCanvasMask(mask, width, height, canvasTransform(width, height, width + 1, height, 'top-left')), { code: 'LIMIT_EXCEEDED' });
  const excessive = { shape: 'bitmap', width, height, runs: Array.from({ length: 600003 }, (_, i) => i % 3 === 0 ? Math.floor(i / 3) : 1) };
  assert.throws(() => resizeCanvasMask(excessive, width, height, canvasTransform(width, height, width, height)), { code: 'INVALID_ARGUMENT' });
});
