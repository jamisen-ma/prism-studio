// Native encoded-RGB transmission, followed optionally
// by encoded Rec.709 luma restoration and a shared neutral-axis gamut fit.
export const PHOTO_FILTER_POLICY = 'rgb-transmission-luma-fit-v1';
export const PHOTO_FILTER_DEFAULTS = Object.freeze({ color: '#ff9500', density: 25, preserveLuminosity: true });
const DENOMINATOR = 2_550_000;
const fail = message => { throw Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' }); };

function checkedInput(parameters) {
  const input = parameters === undefined ? {} : parameters;
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)))
    fail('Photo Filter parameters must be a plain object.');
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== 'string' || !['color', 'density', 'preserveLuminosity'].includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
      fail('Unsupported Photo Filter parameter.');
  }
  return input;
}

export function normalizePhotoFilterParameters(parameters) {
  const input = checkedInput(parameters);
  const color = input.color === undefined ? PHOTO_FILTER_DEFAULTS.color : input.color;
  const density = input.density === undefined ? PHOTO_FILTER_DEFAULTS.density : input.density;
  const preserveLuminosity = input.preserveLuminosity === undefined ? PHOTO_FILTER_DEFAULTS.preserveLuminosity : input.preserveLuminosity;
  if (typeof color !== 'string' || color.length !== 7 || !/^#[\da-fA-F]{6}$/.test(color)) fail('Photo Filter color must be a six-digit RGB hex color.');
  if (typeof density !== 'number' || !Number.isFinite(density) || density < 0 || density > 100 || Math.round(density * 100) / 100 !== density)
    fail('Photo Filter density must be between 0 and 100 in 0.01 increments.');
  if (typeof preserveLuminosity !== 'boolean') fail('Photo Filter Preserve Luminosity must be a boolean.');
  return { color: color.toLowerCase(), density: density === 0 ? 0 : density, preserveLuminosity };
}

/** Validate the patch before spreading so direct callers cannot smuggle an
 * accessor, symbol or prototype through the ordinary flat update merge. */
export function mergePhotoFilterParameters(previous, patch) {
  const input = checkedInput(patch);
  return normalizePhotoFilterParameters({ ...normalizePhotoFilterParameters(previous), ...input });
}

const identity = p => p.density === 0 || p.color === '#ffffff' || (p.preserveLuminosity && p.color.slice(1, 3) === p.color.slice(3, 5) && p.color.slice(3, 5) === p.color.slice(5, 7));
export function photoFilterIsIdentity(parameters) { return identity(normalizePhotoFilterParameters(parameters)); }
const roundedRatio = (n, d) => Math.floor((2 * n + d) / (2 * d));

/** All integer numerators and doubled round boundaries remain below 2^52.
 * D<=6502500000000 leaves >5x margin against binary64 division error at the
 * floor boundary. This evaluates exact rational half-up bytes without BigInt.
 * Alpha, opacity, masks and source blend modes remain caller-owned stages. */
export function photoFilterTransform(parameters) {
  const p = normalizePhotoFilterParameters(parameters);
  if (identity(p)) return (r, g, b) => [r, g, b];
  const d = Math.round(p.density * 100), base = 255 * (10_000 - d);
  const tr = base + d * parseInt(p.color.slice(1, 3), 16);
  const tg = base + d * parseInt(p.color.slice(3, 5), 16);
  const tb = base + d * parseInt(p.color.slice(5, 7), 16);
  if (!p.preserveLuminosity) return (r, g, b) => [roundedRatio(r * tr, DENOMINATOR), roundedRatio(g * tg, DENOMINATOR), roundedRatio(b * tb, DENOMINATOR)];
  return (r, g, b) => {
    const mr = r * tr, mg = g * tg, mb = b * tb;
    const k = 2126 * r + 7152 * g + 722 * b;
    const j = 2126 * mr + 7152 * mg + 722 * mb;
    if (j === 0) return [r, g, b];
    const maximum = Math.max(mr, mg, mb);
    const peak = maximum * k;
    if (peak <= 255 * j) return [roundedRatio(mr * k, j), roundedRatio(mg * k, j), roundedRatio(mb * k, j)];
    const neutral = peak - 255 * j, scale = DENOMINATOR - k, denominator = 10_000 * maximum - j;
    return [roundedRatio(neutral + scale * mr, denominator), roundedRatio(neutral + scale * mg, denominator), roundedRatio(neutral + scale * mb, denominator)];
  };
}
