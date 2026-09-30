// Strict metadata-only Color Range contract; no renderer or asset access.
export const COLOR_RANGE_POLICY = 'sampled-rgb-chebyshev-alpha-v1';
export const COLOR_RANGE_LIMITS = Object.freeze({
  maxColors: 8, maxTolerance: 255, maxFalloff: 255,
  maxComparisons: 192_000_000, comparisonBatch: 65_536,
});
export const COLOR_RANGE_PREVIEW_LIMITS = Object.freeze({
  minEdge: 32, maxEdge: 2400, defaultMaxEdge: 700,
  maxBytes: 8 * 1024 * 1024, maxWorkingBytes: 256 * 1024 * 1024,
});
const fail = message => { throw Object.assign(new TypeError(message), { code: 'INVALID_ARGUMENT' }); };
export function normalizeColorRangeSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('Range settings require a plain object.');
  const fields = ['colors', 'tolerance', 'falloff', 'invert'], input = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !fields.includes(key) || !property.enumerable || !Object.hasOwn(property, 'value')) fail('Range settings require known own data fields.');
    input[key] = property.value;
  }
  const colors = input.colors;
  if (!Array.isArray(colors) || Object.getPrototypeOf(colors) !== Array.prototype) fail('One to eight swatches are required.');
  const length = Object.getOwnPropertyDescriptor(colors, 'length').value;
  if (length < 1 || length > COLOR_RANGE_LIMITS.maxColors || Reflect.ownKeys(colors).length !== length + 1) fail('One to eight dense swatches are required.');
  const result = [];
  for (let i = 0; i < length; i++) {
    const property = Object.getOwnPropertyDescriptor(colors, String(i));
    if (!property?.enumerable || !Object.hasOwn(property, 'value')) fail('Swatches must be own data strings.');
    const color = property.value;
    if (typeof color !== 'string' || color.length !== 7 || !/^#[a-fA-F0-9]{6}$/.test(color)) fail('Each swatch must be a six-digit RGB hex color.');
    const normalized = color.toLowerCase();
    if (result.includes(normalized)) fail('Duplicate swatches are not allowed.');
    result.push(normalized);
  }
  const tolerance = Object.hasOwn(input, 'tolerance') ? input.tolerance : 32;
  const falloff = Object.hasOwn(input, 'falloff') ? input.falloff : 32;
  const invert = Object.hasOwn(input, 'invert') ? input.invert : false;
  if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > COLOR_RANGE_LIMITS.maxTolerance || !Number.isInteger(falloff) || falloff < 0 || falloff > COLOR_RANGE_LIMITS.maxFalloff || typeof invert !== 'boolean') fail('Invalid tolerance, falloff or inversion.');
  return { colors: result, tolerance: tolerance === 0 ? 0 : tolerance, falloff: falloff === 0 ? 0 : falloff, invert };
}
