// Prism's encoded-sRGB tonal mappings. These are explicit native algorithms,
// not a claim of Adobe numerical parity. Compile parameters once per render;
// the returned functions accept RGB8 and own no image buffers or pixel cache.
export const TONAL_COLOR_KINDS = Object.freeze(['color_balance', 'black_white']);
export const TONAL_COLOR_ROUND_GUARD = 64 * Number.EPSILON * 255;
const WEIGHTS = [2126, 7152, 722];
const TONE_DENOMINATOR = 2_550_000;
const CHANNEL_DENOMINATOR = 100_000_000;
const CHROMA_DENOMINATOR = 1_000_000_000_000;
const BALANCE_KEYS = ['shadows', 'midtones', 'highlights', 'preserveLuminosity'];
const HUE_KEYS = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas'];
const BW_KEYS = [...HUE_KEYS, 'tint', 'tintColor', 'tintAmount'];
const fail = message => { throw Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' }); };
const byte = value => Math.max(0, Math.min(255, Math.round(value)));

function parametersObject(value, keys) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('Tonal adjustment parameters must be a plain object.');
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !keys.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('Unsupported tonal adjustment parameter.');
  }
  return value;
}
function percent(value, label, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${label} must be between ${min} and ${max}.`);
  if (Math.round(value * 100) / 100 !== value) fail(`${label} must use 0.01% increments.`);
  return value === 0 ? 0 : value;
}
function boolean(value, label) {
  if (typeof value !== 'boolean') fail(`${label} must be boolean.`);
  return value;
}
function row(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== 3 || Reflect.ownKeys(value).length !== 4) fail(`${label} requires exactly three percentages: cyan/red, magenta/green and yellow/blue.`);
  return Array.from({ length: 3 }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(`${label} requires three numeric percentages.`);
    return percent(descriptor.value, `${label} percentage`, -100, 100);
  });
}

export function normalizeTonalParameters(kind, parameters) {
  if (kind === 'color_balance') {
    const input = parametersObject(parameters, BALANCE_KEYS);
    return {
      shadows: row(input.shadows === undefined ? [0, 0, 0] : input.shadows, 'Shadows'),
      midtones: row(input.midtones === undefined ? [0, 0, 0] : input.midtones, 'Midtones'),
      highlights: row(input.highlights === undefined ? [0, 0, 0] : input.highlights, 'Highlights'),
      preserveLuminosity: boolean(input.preserveLuminosity === undefined ? true : input.preserveLuminosity, 'Preserve luminosity'),
    };
  }
  if (kind === 'black_white') {
    const input = parametersObject(parameters, BW_KEYS), defaults = [40, 60, 40, 60, 20, 80];
    const result = Object.fromEntries(HUE_KEYS.map((key, index) => [key, percent(input[key] === undefined ? defaults[index] : input[key], key, -200, 300)]));
    result.tint = boolean(input.tint === undefined ? false : input.tint, 'Tint');
    const color = input.tintColor === undefined ? '#b98952' : input.tintColor;
    if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) fail('Tint color must use #RRGGBB.');
    result.tintColor = color.toLowerCase();
    result.tintAmount = percent(input.tintAmount === undefined ? 100 : input.tintAmount, 'Tint amount', 0, 100);
    return result;
  }
  fail('Unsupported tonal adjustment kind.');
}

function roundedRational(numerator, denominator) {
  if (numerator <= 0n) return 0;
  if (numerator >= 255n * denominator) return 255;
  return Number((2n * numerator + denominator) / (2n * denominator));
}

/** Exact whole-pixel fallback, including constraint selection. The integers
 * are bounded by RGB8/control limits; no iteration depends on their magnitude.
 * Cancel 1e8 from the selected factor before constructing final rationals. */
function fitExact(luma, chroma) {
  let gap, denominator;
  for (let index = 0; index < 3; index++) {
    const component = chroma[index];
    if (component === 0) continue;
    const nextGap = BigInt(component > 0 ? TONE_DENOMINATOR - luma : luma), nextDenominator = BigInt(Math.abs(component));
    if (denominator === undefined || nextGap * denominator < gap * nextDenominator) { gap = nextGap; denominator = nextDenominator; }
  }
  // Called only when exact integer membership detected an out-of-gamut
  // channel. Therefore there is a nonzero constraint strictly below one.
  const target = BigInt(luma), divisor = 10_000n * denominator;
  return chroma.map(component => roundedRational(target * denominator + BigInt(component) * gap, divisor));
}

function fitBalance(luma, chroma) {
  const centered = chroma.map(component => luma * CHANNEL_DENOMINATOR + component);
  if (centered.every(value => value >= 0 && value <= 255 * CHROMA_DENOMINATOR)) return centered.map(value => byte(value / CHROMA_DENOMINATOR));
  let factor = 1;
  for (const component of chroma) if (component !== 0) {
    const gap = component > 0 ? TONE_DENOMINATOR - luma : luma;
    factor = Math.min(factor, gap * CHANNEL_DENOMINATOR / Math.abs(component));
  }
  const target = luma / 10_000, fitted = chroma.map(component => target + (component / CHROMA_DENOMINATOR) * factor);
  // All integer coefficients above are exact. Three multiplicative roundings,
  // target division and addition contribute <6*255u; this decision guard is
  // 128*255u. It selects exact arithmetic and NEVER biases channel values.
  if (fitted.some(value => Math.abs(value - (Math.floor(value) + 0.5)) <= TONAL_COLOR_ROUND_GUARD)) return fitExact(luma, chroma);
  return fitted.map(byte);
}

function colorBalance(parameters) {
  const rows = [parameters.shadows, parameters.midtones, parameters.highlights].map(values => values.map(value => Math.round(value * 100)));
  if (rows.every(values => values.every(value => value === 0))) return (r, g, b) => [r, g, b];
  return (r, g, b) => {
    const luma = 2126 * r + 7152 * g + 722 * b;
    if (parameters.preserveLuminosity && (luma === 0 || luma === TONE_DENOMINATOR)) return [r, g, b];
    const shadows = Math.max(0, TONE_DENOMINATOR - 2 * luma), highlights = Math.max(0, 2 * luma - TONE_DENOMINATOR), midtones = TONE_DENOMINATOR - shadows - highlights;
    const shifts = [0, 1, 2].map(index => shadows * rows[0][index] + midtones * rows[1][index] + highlights * rows[2][index]);
    if (shifts.every(value => value === 0)) return [r, g, b];
    // The canceled numerator is at most5.1e10, keeping subsequent weighted
    // luma/chroma integers below2^53 instead of overflowing via an extra255.
    const desired = [r, g, b].map((value, index) => value * CHANNEL_DENOMINATOR + shifts[index]);
    if (!parameters.preserveLuminosity) return desired.map(value => byte(value / CHANNEL_DENOMINATOR));
    const desiredLuma = WEIGHTS.reduce((sum, weight, index) => sum + weight * desired[index], 0);
    return fitBalance(luma, desired.map(value => 10_000 * value - desiredLuma));
  };
}

function tintTransform(parameters) {
  if (!parameters.tint || parameters.tintAmount === 0) return gray => [gray, gray, gray];
  const color = [1, 3, 5].map(index => parseInt(parameters.tintColor.slice(index, index + 2), 16)), luma = WEIGHTS.reduce((sum, weight, index) => sum + weight * color[index], 0);
  const chroma = color.map(value => 10_000 * value - luma), amount = Math.round(parameters.tintAmount * 100);
  if (chroma.every(value => value === 0)) return gray => [gray, gray, gray];
  return gray => {
    if (gray === 0 || gray === 255) return [gray, gray, gray];
    if (chroma.every(component => gray * 10_000 + component >= 0 && gray * 10_000 + component <= TONE_DENOMINATOR))
      return chroma.map(component => byte((gray * CHANNEL_DENOMINATOR + component * amount) / CHANNEL_DENOMINATOR));
    let gap, denominator;
    for (const component of chroma) if (component !== 0) {
      const nextGap = component > 0 ? 255 - gray : gray, nextDenominator = Math.abs(component);
      if (denominator === undefined || nextGap * denominator < gap * nextDenominator) { gap = nextGap; denominator = nextDenominator; }
    }
    // Cancel1e4 from the fitted factor; final numerators remain below1.4e13.
    return chroma.map(component => byte((gray * 10_000 * denominator + component * gap * amount) / (10_000 * denominator)));
  };
}

function blackWhite(parameters) {
  const anchors = HUE_KEYS.map(key => Math.round(parameters[key] * 100)), tint = tintTransform(parameters);
  return (r, g, b) => {
    const low = Math.min(r, g, b), high = Math.max(r, g, b), chroma = high - low;
    if (chroma === 0) return tint(low);
    let hue = high === r ? g - b : high === g ? b - r + 2 * chroma : r - g + 4 * chroma;
    if (hue < 0) hue += 6 * chroma;
    const sector = Math.floor(hue / chroma), distance = hue - sector * chroma;
    const gray = byte((low * 10_000 + (chroma - distance) * anchors[sector] + distance * anchors[(sector + 1) % 6]) / 10_000);
    return tint(gray);
  };
}

export function tonalColorTransform(kind, parameters) {
  const normalized = normalizeTonalParameters(kind, parameters);
  return kind === 'color_balance' ? colorBalance(normalized) : blackWhite(normalized);
}
