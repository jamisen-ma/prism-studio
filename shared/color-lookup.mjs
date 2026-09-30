// Native interchange contract. Parsing/evaluation live in server/color-lookup;
// these bounded metadata checks are also safe to use before asset I/O.
export const COLOR_LOOKUP_POLICY = 'cube3d-f64-trilinear-srgb-v1';
export const COLOR_LOOKUP_FORMATS = Object.freeze(['cube-3d']);
export const COLOR_LOOKUP_INPUT_SPACES = Object.freeze(['srgb']);
export const COLOR_LOOKUP_LIMITS = Object.freeze({
  maxBytes: 4 * 1024 * 1024,
  minGridSize: 2,
  maxGridSize: 33,
  maxLineLength: 4096,
  maxNumberLength: 64,
  maxTitleLength: 200,
  maxSourceNameLength: 200,
  maxPrepareBytes: 32 * 1024 * 1024,
  maxHistoryAssets: 128,
  maxHistoryBytes: 64 * 1024 * 1024,
  maxTransactionBytes: 4 * 1024 * 1024,
  maxWorkingBytes: 256 * 1024 * 1024,
});
const fields = new Set(['asset', 'bytes', 'gridSize', 'inputSpace', 'sourceName', 'title']);
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const maxBase64Characters = 4 * Math.ceil(COLOR_LOOKUP_LIMITS.maxBytes / 3);
const fail = message => { throw Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' }); };

function descriptorFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('Color Lookup parameters must be a plain descriptor.');
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !fields.has(key) || !property?.enumerable || !Object.hasOwn(property, 'value')) fail('Unsupported Color Lookup descriptor field.');
    result[key] = property.value;
  }
  return result;
}

export function normalizeColorLookupParameters(value) {
  const input = descriptorFields(value);
  if (typeof input.asset !== 'string' || input.asset.length !== 64 || !/^[a-f0-9]{64}$/.test(input.asset)) fail('Color Lookup asset must be a lowercase SHA-256 identifier.');
  if (!Number.isInteger(input.bytes) || input.bytes < 1 || input.bytes > COLOR_LOOKUP_LIMITS.maxBytes) fail('Color Lookup original bytes must be between 1 and 4 MiB.');
  if (!Number.isInteger(input.gridSize) || input.gridSize < COLOR_LOOKUP_LIMITS.minGridSize || input.gridSize > COLOR_LOOKUP_LIMITS.maxGridSize) fail('Color Lookup grid size must be between 2 and 33.');
  if (input.inputSpace !== 'srgb') fail('Choose the encoded-sRGB Color Lookup interpretation explicitly.');
  if (typeof input.sourceName !== 'string' || !input.sourceName.isWellFormed() || !input.sourceName.trim() || input.sourceName.length > COLOR_LOOKUP_LIMITS.maxSourceNameLength || ['.', '..'].includes(input.sourceName) || /[\u0000-\u001f\u007f/\\]/.test(input.sourceName)) fail('Color Lookup source name must be a well-formed basename of at most 200 characters.');
  if (input.title !== undefined && (typeof input.title !== 'string' || !input.title.isWellFormed() || input.title.length > COLOR_LOOKUP_LIMITS.maxTitleLength || /[\u0000-\u001f\u007f"\\]/.test(input.title))) fail('Color Lookup title must be a well-formed literal of at most 200 characters.');
  return { asset: input.asset, bytes: input.bytes, gridSize: input.gridSize, inputSpace: 'srgb', sourceName: input.sourceName, ...(input.title === undefined ? {} : { title: input.title }) };
}

export function mergeColorLookupParameters(previous, patch) {
  const normalized = normalizeColorLookupParameters(previous);
  if (patch === undefined) return normalized;
  const input = descriptorFields(patch);
  return Object.keys(input).length === 0 ? normalized : normalizeColorLookupParameters(input);
}

/** Exact decoded length, without decoding. Enforce canonical padding bits as
 * well as alphabet/length so different spellings cannot identify one upload. */
export function colorLookupBase64Bytes(data) {
  if (typeof data !== 'string' || data.length < 4 || data.length > maxBase64Characters || data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(data)) fail('Color Lookup data must contain bounded canonical base64 bytes.');
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const firstPadding = data.indexOf('=');
  if (firstPadding !== -1 && firstPadding !== data.length - padding) fail('Color Lookup base64 padding must be terminal.');
  if ((padding === 2 && alphabet.indexOf(data[data.length - 3]) % 16 !== 0) || (padding === 1 && alphabet.indexOf(data[data.length - 2]) % 4 !== 0)) fail('Color Lookup base64 padding bits must be zero.');
  const bytes = data.length / 4 * 3 - padding;
  if (bytes > COLOR_LOOKUP_LIMITS.maxBytes) fail('Color Lookup original bytes exceed 4 MiB.');
  return bytes;
}
