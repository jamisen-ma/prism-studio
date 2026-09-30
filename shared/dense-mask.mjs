// Metadata-only native contract. This module never reads or decodes assets.
export const DENSE_MASK_POLICY = 'framed-raw-alpha8-v1';
export const DENSE_MASK_LIMITS = Object.freeze({
  headerBytes: 32,
  maxDimension: 8192,
  maxPixels: 24_000_000,
  maxWorkingBytes: 256 * 1024 * 1024,
  maxPrepareWork: 384_000_000,
  maxHistoryAssets: 256,
  maxHistoryBytes: 3 * 1024 * 1024 * 1024,
  yieldVisits: 65_536,
});
export const CHANNEL_SELECTION_POLICY = 'composite-byte-alpha-v1';
export const CHANNEL_SELECTION_CHANNELS = Object.freeze(['red', 'green', 'blue', 'luma', 'alpha']);
export const CHANNEL_PREVIEW_LIMITS = Object.freeze({
  maxEdge: 2400,
  defaultMaxEdge: 700,
  maxBytes: 8 * 1024 * 1024,
  maxWorkingBytes: 256 * 1024 * 1024,
  yieldVisits: 65_536,
});

const fields = new Set(['shape', 'asset', 'bytes', 'width', 'height', 'x', 'y', 'feather', 'invert']);
const required = ['shape', 'asset', 'bytes', 'width', 'height'];
const fail = message => { throw Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' }); };

function descriptorFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    fail('An alpha8 mask must be a plain immutable-asset descriptor.');
  const input = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !fields.has(key) || !property?.enumerable || !Object.hasOwn(property, 'value'))
      fail('Unsupported alpha8 mask descriptor field.');
    input[key] = property.value;
  }
  if (required.some(key => !Object.hasOwn(input, key))) fail('An alpha8 mask descriptor is incomplete.');
  return input;
}

/** Snapshot scalar metadata before any await or asset read. A valid descriptor
 * proves its own shape/length only; the native reader must verify the frame and
 * digest separately. Context callers also enforce the appropriate source frame.
 */
export function normalizeDenseMaskDescriptor(value, { persisted = false } = {}) {
  const input = descriptorFields(value);
  if (input.shape !== 'alpha8') fail('Dense masks require the alpha8 shape.');
  if (![input.width, input.height].every(size => Number.isInteger(size) && size >= 1 && size <= DENSE_MASK_LIMITS.maxDimension)
    || input.width * input.height > DENSE_MASK_LIMITS.maxPixels)
    fail('Alpha8 mask dimensions must fit the native 8192-axis and 24-megapixel limits.');
  const bytes = input.width * input.height + DENSE_MASK_LIMITS.headerBytes;
  if (input.bytes !== bytes) fail('Alpha8 mask bytes must equal the framed source dimensions.');
  if (typeof input.asset !== 'string' || input.asset.length !== 64 || !/^[a-f0-9]{64}$/.test(input.asset))
    fail('An alpha8 asset must be a lowercase SHA-256 identifier.');
  if (input.x !== undefined && input.x !== 0 || input.y !== undefined && input.y !== 0)
    fail('Alpha8 source coordinates must be zero; position belongs to the layer-mask wrapper.');
  const feather = input.feather === undefined ? 0 : input.feather;
  if (typeof feather !== 'number' || !Number.isFinite(feather) || feather < 0 || feather > (persisted ? 1_000_000 : 100))
    fail('Alpha8 mask feather exceeds the supported range.');
  const invert = input.invert === undefined ? false : input.invert;
  if (typeof invert !== 'boolean') fail('Alpha8 mask inversion must be Boolean.');
  return { shape: 'alpha8', asset: input.asset, bytes, width: input.width, height: input.height,
    x: 0, y: 0, feather: feather === 0 ? 0 : feather, invert };
}
