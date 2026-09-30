import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PreviewCache, PREVIEW_CACHE_LIMITS } from '../server/preview-cache.mjs';

const key = (documentId = randomUUID(), revision = 1, maxWidth = 1600) => ({ documentId, revision, maxWidth });
const png = (n = 10) => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(n, 17)]).toString('base64');
const value = (revision = 1, bytes = 10) => ({ data: png(bytes), mimeType: 'image/png', width: 24, height: 32, revision });

test('exact revision/width keys and detached results retain successful encoded previews only', () => {
  const cache = new PreviewCache(), id = randomUUID(), k = key(id), input = value();
  assert.equal(cache.get(k), undefined); assert.equal(cache.set(k, input), true);
  input.width = 2; input.data = 'changed'; k.maxWidth = 32;
  const expected = value(), exact = key(id);
  assert.deepEqual(cache.get(exact), expected);
  const output = cache.get(exact); output.data = 'mutated'; output.revision = 999;
  assert.deepEqual(cache.get(exact), expected);
  assert.equal(cache.get(key(id, 2)), undefined); assert.equal(cache.get(key(id, 1, 32)), undefined);
  assert.equal(cache.get(key(randomUUID())), undefined);
  const stats = cache.stats(); stats.bytes = -10; stats.entries = -20;
  assert.ok(cache.stats().bytes > 0); assert.equal(cache.stats().entries, 1);
});

test('get promotes LRU, replacement promotes too, and entry eviction is deterministic', () => {
  const cache = new PreviewCache({ maxEntries: 2 }), a = key(), b = key(), c = key();
  cache.set(a, value()); cache.set(b, value()); cache.get(a); cache.set(c, value());
  assert.equal(cache.get(b), undefined); assert.ok(cache.get(a)); assert.ok(cache.get(c));
  cache.set(a, value(1, 20)); cache.set(b, value());
  assert.equal(cache.get(c), undefined); assert.deepEqual(cache.get(a), value(1, 20));
  assert.equal(cache.stats().entries, 2);
});

test('byte eviction uses exact UTF16 payload accounting and replacement subtracts old costs', () => {
  const probe = new PreviewCache(), a = key(), b = key(), c = key(), small = value();
  probe.set(a, small); const one = probe.stats().bytes;
  const encodedKey = JSON.stringify([a.documentId, a.revision, a.maxWidth]);
  const metadata = JSON.stringify({ mimeType: small.mimeType, width: small.width, height: small.height, revision: small.revision });
  assert.equal(one, 2 * small.data.length + 2 * encodedKey.length + 2 * metadata.length + 512);
  const cache = new PreviewCache({ maxBytes: one * 2 });
  cache.set(a, small); cache.set(b, small); assert.equal(cache.stats().bytes, one * 2);
  cache.set(a, value(1, 100));
  assert.equal(cache.get(b), undefined); assert.equal(cache.stats().entries, 1);
  assert.equal(cache.stats().bytes, one + 2 * (png(100).length - png().length));
  cache.set(a, small); assert.equal(cache.stats().bytes, one);
  cache.set(c, small); assert.equal(cache.stats().bytes, one * 2);
});

test('oversize bypass removes a same-key stale value without evicting unrelated entries', () => {
  const cache = new PreviewCache({ maxBytes: 2000 }), a = key(), b = key();
  assert.ok(cache.set(a, value())); assert.ok(cache.set(b, value()));
  assert.equal(cache.set(a, value(1, 2000)), false);
  assert.equal(cache.get(a), undefined); assert.deepEqual(cache.get(b), value());
  const before = cache.stats(); assert.equal(cache.set(key(), value(1, 2000)), false);
  assert.deepEqual(cache.stats(), before);
});

test('document invalidation removes every cached revision/width while other documents survive', () => {
  const cache = new PreviewCache(), id = randomUUID(), other = key();
  cache.set(key(id), value()); cache.set(key(id, 2), value(2)); cache.set(key(id, 2, 32), value(2)); cache.set(other, value());
  const probe = new PreviewCache(); probe.set(other, value());
  assert.equal(cache.invalidateDocument(id), 3); assert.equal(cache.invalidateDocument(id), 0);
  assert.deepEqual(cache.stats(), probe.stats()); assert.deepEqual(cache.get(other), value());
  cache.clear(); assert.equal(cache.stats().bytes, 0); assert.equal(cache.stats().entries, 0);
});

test('malformed metadata, error objects and noncanonical base64 reject without replacing old entries', () => {
  const cache = new PreviewCache(), k = key(), initial = value(); cache.set(k, initial);
  const noncanonical = png(11).slice(0, -3) + 'B==';
  const malformed = [null, { error: 'failed' }, { ...initial, extra: true }, { ...initial, data: '' }, { ...initial, data: 'not base64' }, { ...initial, data: png() + '====' }, { ...initial, data: noncanonical }, { ...initial, data: 'iVBORw0KGgp=' }, { ...initial, mimeType: 'image/jpeg' }, { ...initial, revision: 2 }, { ...initial, width: 1601 }, { ...initial, height: 8193 }, { ...initial, width: NaN }, { ...initial, height: 1.5 }];
  for (const input of malformed) assert.throws(() => cache.set(k, input), { code: 'INVALID_ARGUMENT' });
  const accessor = { ...initial }; Object.defineProperty(accessor, 'data', { get() { throw new Error('Getter must not execute'); } });
  assert.throws(() => cache.set(k, accessor), { code: 'INVALID_ARGUMENT' });
  const symbolic = { ...initial, [Symbol('metadata')]: true };
  assert.throws(() => cache.set(k, symbolic), { code: 'INVALID_ARGUMENT' });
  assert.deepEqual(cache.get(k), initial); assert.equal(cache.stats().entries, 1);
});

test('invalid keys and configured bounds reject; successful maximum preview dimensions remain valid', () => {
  const cache = new PreviewCache(), k = key();
  for (const malformed of [null, [], { ...k, extra: 1 }, { ...k, documentId: '../project' }, { ...k, revision: 0 }, { ...k, revision: Number.MAX_SAFE_INTEGER + 1 }, { ...k, maxWidth: 31 }, { ...k, maxWidth: 2401 }]) assert.throws(() => cache.get(malformed), { code: 'INVALID_ARGUMENT' });
  for (const options of [{ maxEntries: 0 }, { maxEntries: 33 }, { maxEntries: 1.5 }, { maxBytes: 0 }, { maxBytes: PREVIEW_CACHE_LIMITS.maxBytes + 1 }, { maxBytes: Infinity }]) assert.throws(() => new PreviewCache(options), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => cache.invalidateDocument('bad'), { code: 'INVALID_ARGUMENT' });
  assert.ok(cache.set(key(k.documentId, 1, 2400), { ...value(), width: 2400, height: 8192 }));
  assert.deepEqual(new PreviewCache().stats(), { entries: 0, bytes: 0, maxEntries: 32, maxBytes: 64 * 1024 * 1024 });
});
