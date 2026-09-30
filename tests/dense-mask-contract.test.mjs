import test from 'node:test';
import assert from 'node:assert/strict';
import { DENSE_MASK_POLICY, DENSE_MASK_LIMITS as limits, CHANNEL_SELECTION_POLICY, CHANNEL_SELECTION_CHANNELS,
  CHANNEL_PREVIEW_LIMITS, normalizeDenseMaskDescriptor as normalize } from '../shared/dense-mask.mjs';

const descriptor = (width = 512, height = 512) => ({ shape: 'alpha8', asset: 'ab'.repeat(32), bytes: width * height + 32, width, height });
const rejects = value => assert.throws(() => normalize(value), { code: 'INVALID_ARGUMENT' });

test('Dense descriptors keep exact source frames, explicit defaults and detached owned metadata', () => {
  const input = descriptor(), output = normalize(input);
  assert.deepEqual(output, { ...input, x: 0, y: 0, feather: 0, invert: false });
  assert.deepEqual(input, descriptor()); assert.notEqual(input, output);
  assert.deepEqual(normalize(Object.assign(Object.create(null), input)), output);
  assert.deepEqual(normalize(Object.freeze(input)), output);
  assert.deepEqual(normalize({ ...input, x: undefined, y: -0, feather: undefined, invert: undefined }), output);
  assert.equal(Object.is(normalize({ ...input, feather: -0 }).feather, -0), false);
  const custom = normalize({ ...input, feather: 37.125, invert: true });
  assert.equal(custom.feather, 37.125); assert.equal(custom.invert, true);
  output.width = 1; output.asset = 'cd'.repeat(32);
  assert.deepEqual(normalize(input), { ...input, x: 0, y: 0, feather: 0, invert: false });
  assert.equal(normalize(descriptor(1, 1)).bytes, 33);
  assert.equal(normalize(descriptor(8192, 1)).width, 8192);
  assert.equal(normalize(descriptor(6000, 4000)).bytes, 24_000_032);
});

test('Dense descriptors reject malformed frames, coercion and unsupported metadata without I/O', () => {
  for (const key of ['shape', 'asset', 'bytes', 'width', 'height']) {
    const missing = descriptor(); delete missing[key]; rejects(missing);
    rejects({ ...descriptor(), [key]: undefined });
  }
  const malformed = {
    shape: ['bitmap', 'rectangle', '', null],
    asset: ['AB'.repeat(32), 'ab'.repeat(32) + '\n', 'ab'.repeat(31), 'g'.repeat(64), null, 10],
    width: [0, -1, 8193, 512.5, '512', null, true, NaN, Infinity],
    height: [0, -1, 8193, 512.5, '512', null, false, NaN, Infinity],
    bytes: [262175, 262177, '262176', null, NaN, Infinity, 2 ** 32 + 262176],
    x: [1, -1, '0', null, NaN], y: [1, -1, '0', null, Infinity],
    feather: [null, '0', false, -1, 100.0001, NaN, Infinity],
    invert: [null, 0, 1, '', 'false'],
  };
  for (const [key, values] of Object.entries(malformed)) for (const value of values) rejects({ ...descriptor(), [key]: value });
  rejects(descriptor(6001, 4000));
  for (const key of ['runs', 'clip', 'density', 'maskDensity', 'source', 'path', 'url', 'filename', 'version'])
    rejects({ ...descriptor(), [key]: undefined });
  assert.equal(normalize({ ...descriptor(), feather: 100 }).feather, 100);
  assert.equal(normalize({ ...descriptor(), feather: 1_000_000 }, { persisted: true }).feather, 1_000_000);
  assert.throws(() => normalize({ ...descriptor(), feather: 1_000_000.001 }, { persisted: true }));
  assert.throws(() => normalize({ ...descriptor(), feather: null }, { persisted: true }));
});

test('Dense normalization examines own data properties before values and never invokes descriptor getters', () => {
  let reads = 0;
  for (const key of ['shape', 'asset', 'bytes', 'width', 'height', 'x', 'y', 'feather', 'invert']) {
    const input = descriptor(); Object.defineProperty(input, key, { enumerable: true, get() { reads++; return 0; } });
    rejects(input);
  }
  assert.equal(reads, 0);
  const hiddenRequired = descriptor(); Object.defineProperty(hiddenRequired, 'asset', { value: hiddenRequired.asset, enumerable: false });
  const hiddenExtra = descriptor(); Object.defineProperty(hiddenExtra, 'extra', { value: 0 });
  const setter = descriptor(); Object.defineProperty(setter, 'invert', { enumerable: true, set() { reads++; } });
  for (const value of [undefined, null, [], new Map(), new Date(), Object.assign(Object.create({}), descriptor()),
    hiddenRequired, hiddenExtra, setter, { ...descriptor(), [Symbol('mask')]: 1 }]) rejects(value);
  assert.equal(reads, 0);
});

test('Dense and channel contracts expose frozen independent storage, preparation and preview limits', () => {
  assert.equal(DENSE_MASK_POLICY, 'framed-raw-alpha8-v1');
  assert.equal(CHANNEL_SELECTION_POLICY, 'composite-byte-alpha-v1');
  assert.deepEqual(CHANNEL_SELECTION_CHANNELS, ['red', 'green', 'blue', 'luma', 'alpha']);
  assert.equal(limits.headerBytes, 32); assert.equal(limits.maxHistoryAssets, 256);
  assert.equal(limits.maxHistoryBytes, 3_221_225_472); assert.ok(limits.maxHistoryBytes > 2 ** 31);
  assert.equal(limits.maxWorkingBytes, 268_435_456); assert.equal(limits.maxPrepareWork, 384_000_000);
  assert.equal(CHANNEL_PREVIEW_LIMITS.maxEdge, 2400); assert.equal(CHANNEL_PREVIEW_LIMITS.defaultMaxEdge, 700);
  assert.equal(CHANNEL_PREVIEW_LIMITS.maxBytes, 8_388_608); assert.equal(CHANNEL_PREVIEW_LIMITS.yieldVisits, 65_536);
  for (const value of [limits, CHANNEL_SELECTION_CHANNELS, CHANNEL_PREVIEW_LIMITS]) assert.ok(Object.isFrozen(value));
});
