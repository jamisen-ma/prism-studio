import test from 'node:test';
import assert from 'node:assert/strict';
import { COLOR_LOOKUP_LIMITS as limits, normalizeColorLookupParameters as normalize, mergeColorLookupParameters as merge, colorLookupBase64Bytes as byteLength } from '../shared/color-lookup.mjs';

const descriptor = () => ({ asset: 'ab'.repeat(32), bytes: 122, gridSize: 2, inputSpace: 'srgb', sourceName: ' 秋日 look.cube ', title: 'Warm #1 🎨' });

test('Color Lookup descriptors own exact complete metadata and replace rather than combine files', () => {
  const original = descriptor(), normalized = normalize(original);
  assert.deepEqual(normalized, original); assert.notEqual(normalized, original);
  assert.deepEqual(normalize(Object.assign(Object.create(null), original)), original);
  assert.deepEqual(merge(original, undefined), original); assert.deepEqual(merge(original, {}), original);
  assert.notEqual(merge(original, {}), original);
  const replacement = { ...descriptor(), asset: 'cd'.repeat(32), bytes: 500, gridSize: 3, title: undefined };
  assert.deepEqual(merge(original, replacement), { asset: replacement.asset, bytes: 500, gridSize: 3, inputSpace: 'srgb', sourceName: replacement.sourceName });
  assert.equal(normalize({ ...original, title: '' }).title, '');
  for (const patch of [{ asset: replacement.asset }, { bytes: 500 }, { title: undefined }, { sourceName: 'rename.cube' }]) assert.throws(() => merge(original, patch));
  assert.deepEqual(original, descriptor());
});

test('Color Lookup strict data descriptors reject forged metadata without invoking accessors', () => {
  let reads = 0; const accessor = descriptor(); Object.defineProperty(accessor, 'asset', { enumerable: true, get() { reads++; return 'cd'.repeat(32); } });
  const hidden = descriptor(); Object.defineProperty(hidden, 'extra', { value: true });
  const symbol = { ...descriptor(), [Symbol('extra')]: true };
  for (const bad of [accessor, hidden, symbol, { ...descriptor(), path: '/private/look.cube' }, Object.assign(Object.create({}), descriptor()), [], null, undefined]) assert.throws(() => normalize(bad));
  assert.equal(reads, 0);
  const patch = {}; Object.defineProperty(patch, 'title', { enumerable: true, get() { reads++; return ''; } });
  assert.throws(() => merge(descriptor(), patch)); assert.equal(reads, 0);
  for (const [key, values] of Object.entries({
    asset: ['AB'.repeat(32), 'ab'.repeat(32) + '\n', 'short'], bytes: [0, -1, 1.5, limits.maxBytes + 1, NaN, Infinity, '122'],
    gridSize: [1, 34, 2.5, '2'], inputSpace: [undefined, 'linear', 'log'],
    sourceName: ['', ' ', '.', '..', '/look.cube', 'a\\b.cube', 'a\n.cube', '\ud800', 'a'.repeat(201)],
    title: [null, 'a"b', 'a\\b', 'a\t', '\udc00', 'a'.repeat(201)],
  })) for (const value of values) assert.throws(() => normalize({ ...descriptor(), [key]: value }), `${key}:${String(value)}`);
  assert.equal(normalize({ ...descriptor(), bytes: limits.maxBytes, gridSize: limits.maxGridSize, sourceName: 'a'.repeat(200), title: 'b'.repeat(200) }).bytes, limits.maxBytes);
});

test('Color Lookup base64 rejects alternate pad bits, separators and oversized decoded bytes before allocation', () => {
  for (const [text, size] of [['AA==', 1], ['AQ==', 1], ['/w==', 1], ['AAA=', 2], ['//8=', 2], ['AAAA', 3], ['////', 3]]) assert.equal(byteLength(text), size);
  for (const bad of ['', 'AAA', 'AA===', 'AA=A', 'A===', 'AAAA====', 'AAA\n', 'AAAA\n', 'AAAA\r', 'AA A', 'AA-A', 'AA_A', 'AB==', 'AAB=', '/x==', '//9=', 'éAAA', null]) assert.throws(() => byteLength(bad));
  // These three source lengths have the same rounded-up character bound;
  // checking only the base64 string length would accept both oversized files.
  const boundary = Buffer.alloc(limits.maxBytes + 2, 231);
  assert.equal(byteLength(boundary.subarray(0, limits.maxBytes).toString('base64')), limits.maxBytes);
  assert.throws(() => byteLength(boundary.subarray(0, limits.maxBytes + 1).toString('base64')));
  assert.throws(() => byteLength(boundary.toString('base64')));
});
