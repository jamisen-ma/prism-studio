import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { MORPHOLOGY_LIMITS, morphMask } from '../server/mask-morphology.mjs';

function brute(input, width, height, radius, maximum) {
  const output = Buffer.alloc(input.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let value = maximum ? 0 : 255;
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const sample = x + dx < 0 || y + dy < 0 || x + dx >= width || y + dy >= height ? 0 : input[(y + dy) * width + x + dx];
      value = maximum ? Math.max(value, sample) : Math.min(value, sample);
    }
    output[y * width + x] = value;
  }
  return output;
}
function reference(input, width, height, radius, operation) {
  if (operation === 'smooth') {
    let result = input;
    for (const maximum of [false, true, true, false]) result = brute(result, width, height, radius, maximum);
    return result;
  }
  const dilated = brute(input, width, height, radius, true), eroded = brute(input, width, height, radius, false);
  if (operation === 'border') return Buffer.from(dilated.map((value, i) => value - eroded[i]));
  return operation === 'expand' ? dilated : eroded;
}

test('all operations match independent two-dimensional brute force for random grayscale masks', async () => {
  let seed = 523476;
  const random = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % n; };
  for (let sample = 0; sample < 120; sample++) {
    const width = 1 + random(11), height = 1 + random(9), radius = 1 + random(5);
    const alpha = Buffer.from(Array.from({ length: width * height }, () => random(256))), before = Buffer.from(alpha);
    for (const operation of ['expand', 'contract', 'border', 'smooth']) {
      const actual = await morphMask({ alpha, width, height, radius, operation });
      assert.deepEqual(actual, reference(alpha, width, height, radius, operation), `${operation} ${width}x${height} r${radius}`);
      assert.deepEqual(alpha, before);
    }
  }
});

test('soft alpha, oversized radius and zero outside the canvas are exact', async () => {
  for (const [alpha, width, height] of [[Buffer.from([1, 128, 255]), 3, 1], [Buffer.from([255]), 1, 1], [Buffer.alloc(9, 128), 3, 3], [Buffer.alloc(20), 4, 5]]) {
    for (const radius of [1, 100]) for (const operation of ['expand', 'contract', 'border', 'smooth']) {
      assert.deepEqual(await morphMask({ alpha, width, height, radius, operation }), reference(alpha, width, height, radius, operation));
    }
  }
  const options = { alpha: Buffer.alloc(25, 128), width: 5, height: 5, radius: 1 };
  const contracted = await morphMask({ ...options, operation: 'contract' });
  assert.equal(contracted[12], 128); assert.equal(contracted[0], 0);
  const border = await morphMask({ ...options, operation: 'border' });
  assert.equal(border[12], 0); assert.equal(border[0], 128);
});

test('smooth is explicitly opening followed by closing, and retains intermediate grayscale', async () => {
  const width = 11, height = 11, alpha = Buffer.alloc(width * height);
  for (let y = 2; y < 9; y++) for (let x = 2; x < 9; x++) alpha[y * width + x] = 128;
  alpha[5 * width + 5] = 0; alpha[0] = 255;
  const output = await morphMask({ alpha, width, height, radius: 1, operation: 'smooth' });
  assert.deepEqual(output, reference(alpha, width, height, 1, 'smooth'));
  assert.equal(output[0], 0); assert.equal(output[5 * width + 5], 128);
  assert.ok(output.includes(128)); assert.ok(!output.includes(255));
});

test('input snapshots and owned output survive mutation while the asynchronous operation yields', async () => {
  const width = 257, height = 96, alpha = Buffer.alloc(width * height, 128), before = Buffer.from(alpha);
  const promise = morphMask({ alpha, width, height, radius: 3, operation: 'border' });
  alpha.fill(255);
  const output = await promise;
  assert.deepEqual(output, reference(before, width, height, 3, 'border'));
  output.fill(17); assert.ok(alpha.every((value) => value === 255));
  alpha.fill(41); assert.ok(output.every((value) => value === 17));
});

test('pre-aborted and in-progress operations cancel without mutating source bytes', async () => {
  const alpha = Buffer.alloc(512 * 512, 128), before = Buffer.from(alpha), controller = new AbortController();
  const options = { alpha, width: 512, height: 512, radius: 100, operation: 'smooth', signal: controller.signal };
  const pending = morphMask(options); await nextTurn(); controller.abort(new Error('Sensitive caller reason'));
  await assert.rejects(pending, { name: 'AbortError', code: 'ABORTED', message: 'Mask operation was cancelled.' });
  assert.deepEqual(alpha, before);
  await assert.rejects(morphMask(options), { code: 'ABORTED' });
});

test('malformed arguments and size limits reject before allocating working planes', async () => {
  const base = { alpha: Buffer.from([128]), width: 1, height: 1, radius: 1, operation: 'expand' };
  for (const options of [null, [], { ...base, unexpected: true }, { ...base, alpha: new Uint8Array(1) }, { ...base, alpha: Buffer.alloc(2) }, { ...base, width: NaN }, { ...base, height: 0 }, { ...base, width: 1.5 }, { ...base, radius: 0 }, { ...base, radius: 101 }, { ...base, radius: 1.5 }, { ...base, operation: 'blur' }, { ...base, signal: { aborted: false } }]) {
    await assert.rejects(morphMask(options), { code: 'INVALID_ARGUMENT' });
  }
  for (const options of [{ ...base, width: 8193 }, { ...base, width: 6000, height: 4001 }]) await assert.rejects(morphMask(options), { code: 'LIMIT_EXCEEDED' });
  assert.equal(MORPHOLOGY_LIMITS.workingPlanes, 3); assert.ok(Object.isFrozen(MORPHOLOGY_LIMITS));
});

test('one-megapixel smoothing yields to the event loop and retains the immutable input', async () => {
  const alpha = Buffer.alloc(1024 * 1024, 128); let heartbeats = 0;
  const timer = setInterval(() => heartbeats++, 1);
  try {
    const output = await morphMask({ alpha, width: 1024, height: 1024, radius: 100, operation: 'smooth' });
    assert.ok(heartbeats > 0); assert.equal(output[512 * 1024 + 512], 128); assert.ok(alpha.every((value) => value === 128));
  } finally { clearInterval(timer); }
});
