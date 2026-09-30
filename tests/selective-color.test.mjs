import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SELECTIVE_COLOR_POLICY, SELECTIVE_COLOR_RANGES, SELECTIVE_COLOR_METHODS,
  normalizeSelectiveColorParameters, selectiveColorIsIdentity, selectiveColorTransform,
} from '../server/selective-color.mjs';

const RANGES = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'whites', 'neutrals', 'blacks'];
const normalize = normalizeSelectiveColorParameters, compile = selectiveColorTransform;
const all = row => Object.fromEntries(RANGES.map(range => [range, [...row]]));
const invalid = { code: 'INVALID_ARGUMENT' };
function random(seed) { return () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0); }
function oracle(rgb, parameters) {
  const [r, g, b] = rgb, lo = Math.min(...rgb), hi = Math.max(...rgb);
  // Nine direct membership expressions, rather than the optimized four-row
  // high/middle/low selection in production. Keep virtual ink and its common
  // denominator uncancelled, using BigInt throughout the final correction.
  const weights = [
    Math.max(0, r - Math.max(g, b)), Math.max(0, Math.min(r, g) - b),
    Math.max(0, g - Math.max(r, b)), Math.max(0, Math.min(g, b) - r),
    Math.max(0, b - Math.max(r, g)), Math.max(0, Math.min(r, b) - g),
    Math.max(0, hi + lo - 255), 2 * Math.min(lo, 255 - hi), Math.max(0, 255 - hi - lo),
  ].map(BigInt);
  return rgb.map((value, channel) => {
    let correction = 0n;
    for (let i = 0; i < 9; i++) {
      correction += weights[i] * BigInt(Math.round(parameters[RANGES[i]][channel] * 100));
      correction += weights[i] * BigInt(Math.round(parameters[RANGES[i]][3] * 100));
    }
    const denominator = 2_550_000n, ink = 255n - BigInt(value);
    const nextInk = ink * denominator + correction * (parameters.method === 'relative' ? ink : 255n);
    const numerator = 255n * denominator - nextInk;
    return numerator <= 0n ? 0 : numerator >= 255n * denominator ? 255 : Number((2n * numerator + denominator) / (2n * denominator));
  });
}

test('Selective Color has complete owned zero defaults, stable enums and strict centipercent tuples', () => {
  assert.equal(SELECTIVE_COLOR_POLICY, 'rgb-partition-cmyk-v1');
  assert.deepEqual(SELECTIVE_COLOR_RANGES, RANGES); assert.deepEqual(SELECTIVE_COLOR_METHODS, ['relative', 'absolute']);
  assert.ok(Object.isFrozen(SELECTIVE_COLOR_RANGES)); assert.ok(Object.isFrozen(SELECTIVE_COLOR_METHODS));
  assert.deepEqual(normalize(), { method: 'relative', ...all([0, 0, 0, 0]) });
  const input = { method: 'absolute', reds: [-0, -100, 100, 13.37] }, output = normalize(input);
  assert.equal(Object.is(output.reds[0], -0), false); input.reds[1] = 0; assert.equal(output.reds[1], -100);
  output.blacks[0] = 50; assert.deepEqual(output.whites, [0, 0, 0, 0]); assert.deepEqual(normalize().blacks, [0, 0, 0, 0]);
  assert.deepEqual(normalize(Object.assign(Object.create(null), { blues: [-.01, .01, 0, 0] })).blues, [-.01, .01, 0, 0]);
  const malformed = [null, [], 0, 'relative', { method: null }, { method: 'Absolute' }, { extra: 0 }, { reds: null }, { reds: [] }, { reds: [0, 0, 0] }, { reds: [0, 0, 0, 0, 0] }, { reds: [0, , 0, 0] }, { reds: [0, 0, 0, .001] }, { reds: [0, 0, 0, NaN] }, { reds: [0, 0, 0, Infinity] }, { reds: [0, 0, 0, -100.01] }, { reds: [0, 0, 0, 100.01] }, { reds: [0, 0, 0, '0'] }, { reds: new Float64Array(4) }, Object.create({ method: 'relative' })];
  for (const parameters of malformed) for (const fn of [normalize, selectiveColorIsIdentity, compile]) assert.throws(() => fn(parameters), invalid);
});

test('metadata accessors, symbols, sparse rows and custom prototypes reject without evaluating getters', () => {
  let reads = 0;
  const getter = () => { reads++; throw Error('Getter must not run'); };
  const parameters = Object.defineProperty({}, 'method', { enumerable: true, get: getter });
  const row = [0, 0, 0, 0]; Object.defineProperty(row, '1', { enumerable: true, get: getter });
  const cases = [parameters, { reds: row }, { [Symbol('extra')]: 0 }, Object.defineProperty({}, 'method', { value: 'relative' }), { reds: Object.assign([0, 0, 0, 0], { extra: 0 }) }, { reds: Object.assign([0, 0, 0, 0], { [Symbol('extra')]: 0 }) }, { reds: Object.setPrototypeOf([0, 0, 0, 0], null) }];
  for (const value of cases) assert.throws(() => normalize(value), invalid);
  assert.equal(reads, 0);
  const hidden = [0, 0, 0, 0]; Object.defineProperty(hidden, '0', { value: 0, enumerable: false });
  assert.throws(() => normalize({ whites: hidden }), invalid);
});

test('sparse row replacement retains other effective rows and method; compiled functions own their settings', () => {
  const retained = normalize({ method: 'absolute', reds: [1, 2, 3, 4], blacks: [5, 6, 7, 8] });
  const updated = normalize({ ...retained, reds: [0, 0, 0, 0] });
  assert.equal(updated.method, 'absolute'); assert.deepEqual(updated.blacks, [5, 6, 7, 8]);
  assert.deepEqual(updated.reds, [0, 0, 0, 0]); assert.notEqual(updated.blacks, retained.blacks);
  const parameters = normalize({ method: 'absolute', whites: [10, 0, 0, 0] }), first = compile(parameters), second = compile({ method: 'relative' });
  parameters.whites[0] = -100; parameters.method = 'relative';
  for (let i = 0; i < 20; i++) { assert.deepEqual(first(255, 255, 255), [230, 255, 255]); assert.deepEqual(second(255, 255, 255), [255, 255, 255]); }
  const tuple = first(255, 255, 255); tuple.fill(0); assert.deepEqual(first(255, 255, 255), [230, 255, 255]);
  assert.equal(Object.hasOwn(first, 'plan'), false);
});

test('literal membership, method, cancellation and single-round boundaries follow the native contract', () => {
  const cases = [
    [[255, 255, 255], { method: 'absolute', whites: [10, 0, 0, 0] }, [230, 255, 255]],
    [[255, 255, 255], { whites: [100, -100, 50, 100] }, [255, 255, 255]],
    [[255, 128, 255], { method: 'absolute', whites: [50, 0, 0, 0] }, [191, 128, 255]],
    [[255, 128, 255], { method: 'absolute', whites: [1, 0, 0, 0], magentas: [1, 0, 0, 0] }, [252, 128, 255]],
    [[128, 128, 128], { method: 'absolute', ...all([10, 0, 0, 0]) }, [103, 128, 128]],
    [[128, 128, 128], all([10, 0, 0, 0]), [115, 128, 128]],
    [[5, 5, 5], all([-1, 0, 0, 0]), [8, 5, 5]],
    [[0, 0, 0], { blacks: [-10, 0, 0, 0] }, [26, 0, 0]],
    [[255, 0, 0], { reds: [0, 0, 0, 100] }, [255, 0, 0]],
    [[255, 0, 0], { method: 'absolute', reds: [0, 0, 0, 50] }, [128, 0, 0]],
    [[200, 100, 50], { method: 'absolute', reds: [100, 0, 0, 0], neutrals: [-100, 0, 0, 0] }, [200, 100, 50]],
    [[200, 150, 100], { method: 'absolute', reds: [100, 0, 0, 0], whites: [-100, 0, 0, 0] }, [195, 150, 100]],
  ];
  for (const [rgb, parameters, expected] of cases) assert.deepEqual(compile(parameters)(...rgb), expected);
  for (const method of SELECTIVE_COLOR_METHODS) for (const channel of [0, 1, 2]) {
    const row = [0, 0, 0, 0]; row[channel] = 10;
    const output = compile({ method, ...all(row) })(128, 128, 128);
    for (let c = 0; c < 3; c++) assert.equal(output[c], c === channel ? (method === 'absolute' ? 103 : 115) : 128);
  }
});

test('both methods agree with independent uncancelled virtual-ink BigInt math over extrema, ties and seeded settings', () => {
  const next = random(0x2142a8f3), settings = [];
  for (const method of SELECTIVE_COLOR_METHODS) for (const range of RANGES) for (let channel = 0; channel < 4; channel++) for (const value of [-100, -.01, .01, 100]) {
    const row = [0, 0, 0, 0]; row[channel] = value; settings.push(normalize({ method, [range]: row }));
  }
  for (let i = 0; i < 64; i++) settings.push(normalize({ method: i % 2 ? 'absolute' : 'relative', ...Object.fromEntries(RANGES.map(range => [range, Array.from({ length: 4 }, () => (next() % 20001 - 10000) / 100)])) }));
  for (const parameters of settings) {
    const transform = compile(parameters);
    for (let i = 0; i < 128; i++) {
      const rgb = i < 32 ? [[0, 0, 0], [255, 255, 255], [127, 127, 127], [128, 128, 128], [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 255], [255, 128, 255], [200, 150, 100], [1, 1, 255], [255, 1, 1], [1, 255, 1], [127, 128, 127]][i % 16] : [next() >>> 24, next() >>> 24, next() >>> 24];
      assert.deepEqual(transform(...rgb), oracle(rgb, parameters));
    }
  }
});

test('all-zero identity is exact for every gray and seeded RGB, while nonzero cancellation is not an authored-zero identity', () => {
  const next = random(0xa5b4128);
  for (const method of SELECTIVE_COLOR_METHODS) {
    assert.equal(selectiveColorIsIdentity({ method }), true); const transform = compile({ method });
    const cancel = { method, ...all([50, 50, 50, -50]) }, canceled = compile(cancel);
    assert.equal(selectiveColorIsIdentity(cancel), false);
    for (let i = 0; i < 4096; i++) {
      const rgb = i < 256 ? [i, i, i] : [next() >>> 24, next() >>> 24, next() >>> 24];
      assert.deepEqual(transform(...rgb), rgb); assert.deepEqual(canceled(...rgb), rgb);
    }
  }
  assert.equal(selectiveColorIsIdentity({ blues: [0, 0, 0, -.01] }), false);
});
