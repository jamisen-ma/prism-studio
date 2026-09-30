// Native encoded-RGB partition and additive virtual CMY+K correction.
// The workflow uses Selective Color terminology; this is not a print-profile
// conversion or Adobe/FFmpeg pixel parity. No external implementation is used.
export const SELECTIVE_COLOR_POLICY = 'rgb-partition-cmyk-v1';
export const SELECTIVE_COLOR_RANGES = Object.freeze([
  'reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas',
  'whites', 'neutrals', 'blacks',
]);
export const SELECTIVE_COLOR_METHODS = Object.freeze(['relative', 'absolute']);
const PARAMETER_KEYS = ['method', ...SELECTIVE_COLOR_RANGES];
const fail = message => { throw Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' }); };

function parametersObject(parameters) {
  if (parameters === undefined) return {};
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters) || ![Object.prototype, null].includes(Object.getPrototypeOf(parameters)))
    fail('Selective Color parameters must be a plain object.');
  for (const key of Reflect.ownKeys(parameters)) {
    const descriptor = Object.getOwnPropertyDescriptor(parameters, key);
    if (typeof key !== 'string' || !PARAMETER_KEYS.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
      fail('Unsupported Selective Color parameter.');
  }
  return parameters;
}

function normalizeRow(row, label) {
  if (!Array.isArray(row) || Object.getPrototypeOf(row) !== Array.prototype || row.length !== 4 || Reflect.ownKeys(row).length !== 5)
    fail(`Selective Color ${label} requires four percentages: cyan, magenta, yellow and black.`);
  return Array.from({ length: 4 }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(row, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
      fail(`Selective Color ${label} requires four numeric data values.`);
    const value = descriptor.value;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < -100 || value > 100)
      fail(`Selective Color ${label} percentages must be between -100 and 100.`);
    if (Math.round(value * 100) / 100 !== value)
      fail('Selective Color percentages must use 0.01% increments.');
    return value === 0 ? 0 : value;
  });
}

/** Complete owned defaults; callers merge retained settings before this call.
 * A supplied range replaces its whole four-element row. No pixel setup occurs. */
export function normalizeSelectiveColorParameters(parameters) {
  const input = parametersObject(parameters), method = input.method === undefined ? 'relative' : input.method;
  if (!SELECTIVE_COLOR_METHODS.includes(method)) fail('Selective Color method must be relative or absolute.');
  const result = { method };
  for (const range of SELECTIVE_COLOR_RANGES)
    result[range] = normalizeRow(input[range] === undefined ? [0, 0, 0, 0] : input[range], range);
  return result;
}

const allControlsZero = parameters => SELECTIVE_COLOR_RANGES.every(range => parameters[range].every(value => value === 0));

/** Metadata/work predicate: nonzero controls that cancel still charge compute. */
export function selectiveColorIsIdentity(parameters) {
  return allControlsZero(normalizeSelectiveColorParameters(parameters));
}

function roundedByte(numerator, denominator) {
  if (numerator <= 0) return 0;
  if (numerator >= 255 * denominator) return 255;
  // All integer operations are exact: |S| <= 5,100,000, every U intermediate
  // < 2^31, and 2D <= 5,100,000 < 2^23. A noninteger quotient is > 2^-23
  // from an integer boundary, versus division half-ULP <= 2^-46 here.
  return Math.floor((2 * numerator + denominator) / (2 * denominator));
}

/** Compile bounded coefficients once. Accept RGB8, return a fresh RGB8 tuple.
 * Alpha, entry blend/opacity, masks and protection belong to existing callers. */
export function selectiveColorTransform(parameters) {
  const normalized = normalizeSelectiveColorParameters(parameters);
  if (allControlsZero(normalized)) return (r, g, b) => [r, g, b];
  const rows = SELECTIVE_COLOR_RANGES.map(range => {
    const row = normalized[range].map(value => Math.round(value * 100));
    return row.slice(0, 3).map(value => value + row[3]);
  });
  const relative = normalized.method === 'relative', denominator = relative ? 2_550_000 : 10_000;
  return (r, g, b) => {
    const high = Math.max(r, g, b), low = Math.min(r, g, b), middle = r + g + b - high - low;
    // RGB cube decomposition: primary H-M, secondary M-L; pair equal parts
    // of the remaining white L and black 255-H into Neutrals. These four
    // weights sum to 255. Tie-selected zero-weight rows cannot affect output.
    const primary = rows[r === high ? 0 : g === high ? 2 : 4];
    const secondary = rows[b === low ? 1 : r === low ? 3 : 5];
    const tone = rows[high + low >= 255 ? 6 : 8], neutral = rows[7];
    const primaryWeight = high - middle, secondaryWeight = middle - low;
    const toneWeight = Math.abs(high + low - 255), neutralWeight = 255 - (high - low) - toneWeight;
    const red = primaryWeight * primary[0] + secondaryWeight * secondary[0] + toneWeight * tone[0] + neutralWeight * neutral[0];
    const green = primaryWeight * primary[1] + secondaryWeight * secondary[1] + toneWeight * tone[1] + neutralWeight * neutral[1];
    const blue = primaryWeight * primary[2] + secondaryWeight * secondary[2] + toneWeight * tone[2] + neutralWeight * neutral[2];
    // Observe original RGB for all ranges; clamp/round only their complete sum.
    return relative ? [
      roundedByte(r * denominator - (255 - r) * red, denominator),
      roundedByte(g * denominator - (255 - g) * green, denominator),
      roundedByte(b * denominator - (255 - b) * blue, denominator),
    ] : [
      roundedByte(r * denominator - red, denominator),
      roundedByte(g * denominator - green, denominator),
      roundedByte(b * denominator - blue, denominator),
    ];
  };
}
