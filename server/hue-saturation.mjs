// Native encoded-RGB HSL: hue triangles for Hue/Saturation, chroma-softened
// named Lightness, and proportional Saturation. Not Adobe pixel equivalence.
export const HUE_SATURATION_POLICY = 'rgb-hue-triangle-hsl-v1';
export const HUE_SATURATION_RANGES = Object.freeze([
  'master', 'reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas',
]);
const LIGHT_DENOMINATOR = 2_550_000;
const fail = message => { throw Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' }); };
const bounded = (value, low, high) => Math.max(low, Math.min(high, value));
const byte = value => bounded(Math.round(value), 0, 255);

/** Complete owned defaults. Callers merge retained settings first on update;
 * each supplied row replaces a complete Hue/Saturation/Lightness tuple. */
export function normalizeHueSaturationParameters(parameters) {
  const input = parameters === undefined ? {} : parameters;
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)))
    fail('Hue / Saturation parameters must be a plain object.');
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== 'string' || !HUE_SATURATION_RANGES.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
      fail('Unsupported Hue / Saturation parameter.');
  }
  const result = {};
  for (const range of HUE_SATURATION_RANGES) {
    const row = input[range] === undefined ? [0, 0, 0] : input[range];
    if (!Array.isArray(row) || Object.getPrototypeOf(row) !== Array.prototype || row.length !== 3 || Reflect.ownKeys(row).length !== 4)
      fail(`Hue / Saturation ${range} requires three values: hue, saturation and lightness.`);
    result[range] = Array.from({ length: 3 }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(row, String(index));
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
        fail(`Hue / Saturation ${range} requires three numeric data values.`);
      const value = descriptor.value, limit = index === 0 ? 180 : 100;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < -limit || value > limit)
        fail(`Hue / Saturation ${index === 0 ? 'hue' : index === 1 ? 'saturation' : 'lightness'} must be between ${-limit} and ${limit}.`);
      if (Math.round(value * 100) / 100 !== value)
        fail('Hue / Saturation controls must use 0.01-unit increments.');
      return value === 0 ? 0 : value;
    });
  }
  return result;
}

const allControlsZero = parameters => HUE_SATURATION_RANGES.every(range => parameters[range].every(value => value === 0));

/** Metadata-only work predicate; nonzero controls that cancel still compute. */
export function hueSaturationIsIdentity(parameters) {
  return allControlsZero(normalizeHueSaturationParameters(parameters));
}

const grayByte = numerator => Math.floor((2 * numerator + 2 * LIGHT_DENOMINATOR) / (4 * LIGHT_DENOMINATOR));

/** Compile private bounded coefficients, return a fresh RGB8 tuple per call.
 * Alpha, blend/opacity, masks and protection are the existing callers' stages.
 * The general conversion deliberately fixes binary64 operation order; native
 * half ties may differ by one byte from exact-real HSL. No epsilon/fallback. */
export function hueSaturationTransform(parameters) {
  const normalized = normalizeHueSaturationParameters(parameters);
  if (allControlsZero(normalized)) return (r, g, b) => [r, g, b];
  const rows = HUE_SATURATION_RANGES.map(range => normalized[range].map(value => Math.round(value * 100)));
  const master = rows[0];
  return (r, g, b) => {
    const high = Math.max(r, g, b), low = Math.min(r, g, b), delta = high - low;
    const sum = high + low, middle = r + g + b - high - low;
    const primary = rows[r === high ? 1 : g === high ? 3 : 5];
    const secondary = rows[b === low ? 2 : r === low ? 4 : 6];
    const a = high - middle, z = middle - low;
    const q = 10_000 * delta, hueBase = 6000 * delta;
    // All ranges observe the same original RGB. H/S weights sum to one for
    // chromatic pixels; named Lightness influence instead sums to delta/255.
    const hue = delta * master[0] + a * primary[0] + z * secondary[0];
    const saturation = bounded(delta * master[1] + a * primary[1] + z * secondary[1], -q, q);
    const lightness = bounded(255 * master[2] + a * primary[2] + z * secondary[2], -LIGHT_DENOMINATOR, LIGHT_DENOMINATOR);
    if (lightness === 0 && saturation === 0 && (hue === 0 || Math.abs(hue) === 36_000 * delta)) return [r, g, b];
    const lightNumerator = lightness < 0 ? sum * (LIGHT_DENOMINATOR + lightness)
      : sum * LIGHT_DENOMINATOR + (510 - sum) * lightness;
    if (delta === 0) { const gray = grayByte(lightNumerator); return [gray, gray, gray]; }
    if (lightNumerator === 0) return [0, 0, 0];
    if (lightNumerator === 510 * LIGHT_DENOMINATOR) return [255, 255, 255];
    const k = 255 - Math.abs(sum - 255), saturationDenominator = k * q;
    const saturationNumerator = Math.min(saturationDenominator, delta * (q + saturation));
    if (saturationNumerator === 0) { const gray = grayByte(lightNumerator); return [gray, gray, gray]; }
    let h6 = high === r ? g - b : high === g ? 2 * delta + b - r : 4 * delta + r - g;
    if (h6 < 0) h6 += 6 * delta;
    const hueDenominator = delta * hueBase, period = 6 * hueDenominator;
    let hueNumerator = (h6 * hueBase + hue * delta) % period;
    if (hueNumerator < 0) hueNumerator += period;
    // Integer setup is <2^33. hueDenominator<=390150000 gives an exact
    // sector decision with ample separation from a floating integer boundary.
    const sector = Math.floor(hueNumerator / hueDenominator), remainder = hueNumerator - sector * hueDenominator;
    const triangle = sector % 2 ? hueDenominator - remainder : remainder;
    const adjustedLight = lightNumerator / (2 * LIGHT_DENOMINATOR);
    const chroma = ((255 * LIGHT_DENOMINATOR - Math.abs(lightNumerator - 255 * LIGHT_DENOMINATOR)) / LIGHT_DENOMINATOR)
      * (saturationNumerator / saturationDenominator);
    const base = adjustedLight - chroma / 2;
    const secondaryChannel = base + chroma * (triangle / hueDenominator), maximum = base + chroma;
    const output = sector === 0 ? [maximum, secondaryChannel, base] : sector === 1 ? [secondaryChannel, maximum, base]
      : sector === 2 ? [base, maximum, secondaryChannel] : sector === 3 ? [base, secondaryChannel, maximum]
        : sector === 4 ? [secondaryChannel, base, maximum] : [maximum, base, secondaryChannel];
    for (let channel = 0; channel < 3; channel++) output[channel] = byte(output[channel]);
    return output;
  };
}
