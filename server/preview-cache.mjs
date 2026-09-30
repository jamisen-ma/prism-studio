export const PREVIEW_CACHE_LIMITS = Object.freeze({ maxBytes: 64 * 1024 * 1024, maxEntries: 32 });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const KEY_FIELDS = ['documentId', 'revision', 'maxWidth'];
const VALUE_FIELDS = ['data', 'mimeType', 'width', 'height', 'revision'];
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const invalid = (message) => { throw Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' }); };
function exactObject(input, fields, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid(`Invalid ${label}.`);
  const keys = Reflect.ownKeys(input), descriptors = Object.getOwnPropertyDescriptors(input);
  if (keys.length !== fields.length || !fields.every((field) => keys.includes(field) && 'value' in descriptors[field])) invalid(`Invalid ${label} fields.`);
}
function documentId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) invalid('Preview cache requires a document UUID.');
  return value;
}
function checkedKey(key) {
  exactObject(key, KEY_FIELDS, 'preview cache key');
  documentId(key.documentId);
  if (!Number.isSafeInteger(key.revision) || key.revision < 1) invalid('Preview cache revision must be a positive safe integer.');
  if (!Number.isInteger(key.maxWidth) || key.maxWidth < 32 || key.maxWidth > 2400) invalid('Preview cache width must be between 32 and 2400.');
  return JSON.stringify([key.documentId, key.revision, key.maxWidth]);
}
function checkedValue(key, value) {
  exactObject(value, VALUE_FIELDS, 'encoded preview');
  const { data, mimeType, width, height, revision } = value;
  if (revision !== key.revision || mimeType !== 'image/png') invalid('Only matching successful PNG previews can be cached.');
  if (![width, height].every((n) => Number.isInteger(n) && n > 0 && n <= 8192) || width > key.maxWidth || width * height > 24_000_000) invalid('Invalid encoded preview dimensions.');
  // This is an internal cache, not an image decoder. Check bounded shape and
  // canonical base64 spelling without decoding or inspecting PNG chunks.
  if (typeof data !== 'string' || data.length < 12 || data.length % 4 !== 0 || !data.startsWith('iVBORw0KGgo') || /[^A-Za-z0-9+/=]/.test(data)) invalid('Preview data must be PNG base64.');
  const firstPadding = data.indexOf('=');
  if (firstPadding !== -1) {
    const padding = data.length - firstPadding;
    if (padding > 2 || (padding === 2 && data.at(-1) !== '=')) invalid('Preview base64 padding is invalid.');
    const last = ALPHABET.indexOf(data[firstPadding - 1]);
    if (last < 0 || (last & (padding === 1 ? 3 : 15)) !== 0) invalid('Preview base64 padding is not canonical.');
  }
  return { data, mimeType, width, height, revision };
}

/**
 * LRU of successful encoded get_preview results only. No image decoding,
 * promises, filesystem, raw pixels, exports or external-source caching.
 *
 * Accounted bytes use a pessimistic UTF-16 payload estimate plus serialized
 * key/metadata and 512 bytes of fixed overhead per entry. This is an explicit
 * cache-accounting bound, not a promise about whole-process RSS or JS heap.
 * Call invalidateDocument only after a successful document publication.
 */
export class PreviewCache {
  #entries = new Map();
  #bytes = 0;
  #maxBytes;
  #maxEntries;

  constructor({ maxBytes = PREVIEW_CACHE_LIMITS.maxBytes, maxEntries = PREVIEW_CACHE_LIMITS.maxEntries } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > PREVIEW_CACHE_LIMITS.maxBytes) invalid('Preview cache accounted-byte limit must be between 1 and 64 MiB.');
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > PREVIEW_CACHE_LIMITS.maxEntries) invalid('Preview cache entry limit must be between 1 and 32.');
    this.#maxBytes = maxBytes; this.#maxEntries = maxEntries;
  }

  get(key) {
    const serialized = checkedKey(key), entry = this.#entries.get(serialized);
    if (!entry) return undefined;
    this.#entries.delete(serialized); this.#entries.set(serialized, entry);
    return { ...entry.value };
  }

  set(key, value) {
    const serialized = checkedKey(key), snapshot = checkedValue(key, value);
    const metadata = JSON.stringify({ mimeType: snapshot.mimeType, width: snapshot.width, height: snapshot.height, revision: snapshot.revision });
    const accountedBytes = snapshot.data.length * 2 + serialized.length * 2 + metadata.length * 2 + 512;
    const old = this.#entries.get(serialized);
    if (old) { this.#entries.delete(serialized); this.#bytes -= old.accountedBytes; }
    // An oversize new result must not leave an older value under the same key,
    // but it must not evict other useful entries just to bypass this result.
    if (accountedBytes > this.#maxBytes) return false;
    while (this.#entries.size >= this.#maxEntries || this.#bytes + accountedBytes > this.#maxBytes) {
      const oldest = this.#entries.keys().next().value, entry = this.#entries.get(oldest);
      this.#entries.delete(oldest); this.#bytes -= entry.accountedBytes;
    }
    this.#entries.set(serialized, { documentId: key.documentId, value: snapshot, accountedBytes });
    this.#bytes += accountedBytes;
    return true;
  }

  invalidateDocument(id) {
    documentId(id); let removed = 0;
    for (const [key, entry] of this.#entries) if (entry.documentId === id) {
      this.#entries.delete(key); this.#bytes -= entry.accountedBytes; removed++;
    }
    return removed;
  }

  clear() { this.#entries.clear(); this.#bytes = 0; }

  stats() { return { entries: this.#entries.size, bytes: this.#bytes, maxEntries: this.#maxEntries, maxBytes: this.#maxBytes }; }
}
