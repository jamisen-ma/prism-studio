// Independently authored from the declared native composition policy.
// No production, owner-prototype, image, or third-party implementation import.
export const LAYER_FILL_REFERENCE_MODES = Object.freeze([
  'normal', 'multiply', 'screen', 'difference', 'overlay', 'dissolve',
]);
const byte = x => Math.max(0, Math.min(255, Math.round(x)));
const unit = (x, label) => {
  if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 1) throw Error(`Invalid ${label}`);
  return x;
};
function rgba(value, label) {
  if (!value || value.length !== 4 || !Array.from(value).every(x => Number.isInteger(x) && x >= 0 && x <= 255)) throw Error(`Invalid ${label}`);
  return Array.from(value);
}

// Independent unsigned BigInt formulation of the existing deterministic
// spatial threshold. It does not call Math.imul or import the native helper.
export function fillDissolveThreshold(pixelIndex) {
  if (!Number.isSafeInteger(pixelIndex) || pixelIndex < 0 || pixelIndex >= 24_000_000) throw Error('Invalid pixel index');
  const mask = 0xffff_ffffn, factor = 0x45d9f3bn;
  let hash = ((BigInt(pixelIndex) + 1n) * factor) & mask;
  hash = ((hash ^ (hash >> 16n)) * factor) & mask;
  hash ^= hash >> 16n;
  return Number(hash) / 4294967296;
}

/** A single in-bounds raw mask sample after feather, before inversion/density.
 * Byte masks recover their byte before nonunit density; geometry stays
 * continuous. Position/domain clipping and feather generation are caller-owned. */
export function fillMaskCoverage(raw, { density = 1, invert = false, byteMask = false } = {}) {
  unit(raw, 'raw coverage'); unit(density, 'mask density');
  if (typeof invert !== 'boolean' || typeof byteMask !== 'boolean') throw Error('Invalid mask reference options');
  if (density === 0) return 1;
  const coverage = invert ? 1 - raw : raw;
  if (density === 1) return coverage;
  const alpha = byteMask ? Math.round(coverage * 255) : coverage * 255;
  return (255 - density * (255 - alpha)) / 255;
}

function blend(b, s, mode) {
  if (mode === 'multiply') return b * s;
  if (mode === 'screen') return b + s - b * s;
  if (mode === 'difference') return Math.abs(b - s);
  if (mode === 'overlay') return b <= .5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s);
  return s;
}
function compositePixel(backdrop, foreground, opacity, coverage, mode, pixelIndex) {
  let sourceAlpha = foreground[3] / 255 * opacity * coverage;
  if (mode === 'dissolve') sourceAlpha = fillDissolveThreshold(pixelIndex) < sourceAlpha ? 1 : 0;
  if (sourceAlpha === 0) return [...backdrop]; // Retains backdrop hidden RGB.
  const destinationAlpha = backdrop[3] / 255;
  const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
  const rgb = [0, 1, 2].map(channel => {
    const b = backdrop[channel] / 255, s = foreground[channel] / 255;
    const mixed = blend(b, s, mode);
    // The binary64 order is part of the existing policy. Do not rewrite this
    // as a pre-rounded alpha byte or an algebraically equivalent byte formula.
    return byte(255 * ((1 - sourceAlpha) * destinationAlpha * b
      + (1 - destinationAlpha) * sourceAlpha * s
      + sourceAlpha * destinationAlpha * mixed) / outputAlpha);
  });
  return [...rgb, byte(outputAlpha * 255)];
}
function pixelOptions(options) {
  const { backdrop, body, decoration = [0, 0, 0, 0], opacity = 1, fillOpacity = 1,
    maskCoverage = 1, decorationCoverage = 1, blendMode = 'normal', pixelIndex = 0 } = options;
  const result = { backdrop: rgba(backdrop, 'backdrop'), body: rgba(body, 'body'), decoration: rgba(decoration, 'decoration'),
    opacity: unit(opacity, 'overall opacity'), fillOpacity: unit(fillOpacity, 'Fill'),
    maskCoverage: unit(maskCoverage, 'mask coverage'), decorationCoverage: unit(decorationCoverage, 'decoration coverage'), blendMode, pixelIndex };
  if (!LAYER_FILL_REFERENCE_MODES.includes(blendMode)) throw Error('Reference does not implement this blend mode');
  if (!Number.isSafeInteger(pixelIndex) || pixelIndex < 0 || pixelIndex >= 24_000_000) throw Error('Invalid pixel index');
  return result;
}

/** Decoration is already generated from unfilled source alpha plus mask.
 * Its coverage here is only the final protection/exclusion coverage, so the
 * body mask must not be applied to it again. Returns a new RGBA tuple. */
export function layerFillPixelReference(options) {
  const p = pixelOptions(options);
  const decorated = compositePixel(p.backdrop, p.decoration, p.opacity, p.decorationCoverage, p.blendMode, p.pixelIndex);
  const bodyOpacity = p.fillOpacity === 1 ? p.opacity : p.opacity * p.fillOpacity;
  return compositePixel(decorated, p.body, bodyOpacity, p.maskCoverage, p.blendMode, p.pixelIndex);
}

/** Whole-image form. Coverage can be a scalar or one value per pixel.
 * Decoration must be a precomputed RGBA image; this fixture does not recreate
 * outline, blur, source filtering, geometry, ancestor rounding or protection. */
export function layerFillReference(backdrop, body, options = {}) {
  if (!backdrop || !body || backdrop.length !== body.length || body.length % 4 || body.length > 96_000_000) throw Error('Invalid RGBA buffers');
  const { decoration, maskCoverage = 1, decorationCoverage = 1, ...settings } = options;
  if (decoration && decoration.length !== body.length) throw Error('Decoration dimensions differ');
  const pixels = body.length / 4;
  for (const coverage of [maskCoverage, decorationCoverage]) if (typeof coverage !== 'number' && coverage?.length !== pixels) throw Error('Coverage dimensions differ');
  const output = Buffer.alloc(body.length);
  for (let index = 0; index < pixels; index++) {
    const start = index * 4, result = layerFillPixelReference({ ...settings,
      backdrop: backdrop.subarray(start, start + 4), body: body.subarray(start, start + 4),
      ...(decoration ? { decoration: decoration.subarray(start, start + 4) } : {}), pixelIndex: index,
      maskCoverage: typeof maskCoverage === 'number' ? maskCoverage : maskCoverage[index],
      decorationCoverage: typeof decorationCoverage === 'number' ? decorationCoverage : decorationCoverage[index] });
    output.set(result, start);
  }
  return output;
}

// Separate exact-rational comparison, not the native binary64 tie contract.
// It is intentionally expressed through fractions and source-over terms.
const gcd = (a, b) => { a = a < 0n ? -a : a; while (b) [a, b] = [b, a % b]; return a; };
function fraction(n, d = 1n) {
  n = BigInt(n); d = BigInt(d);
  if (!d) throw Error('Zero denominator');
  if (d < 0n) { n = -n; d = -d; }
  const g = gcd(n, d); return { n: n / g, d: d / g };
}
const plus = (a, b) => fraction(a.n * b.d + b.n * a.d, a.d * b.d);
const minus = (a, b) => fraction(a.n * b.d - b.n * a.d, a.d * b.d);
const times = (a, b) => fraction(a.n * b.n, a.d * b.d);
const over = (a, b) => fraction(a.n * b.d, a.d * b.n);
const cmp = (a, b) => a.n * b.d < b.n * a.d ? -1 : a.n * b.d > b.n * a.d ? 1 : 0;
const one = fraction(1), two = fraction(2), zero = fraction(0), scale = fraction(255);
function numberFraction(value) {
  if (value === 0) return zero;
  const view = new DataView(new ArrayBuffer(8)); view.setFloat64(0, value, false);
  const bits = view.getBigUint64(0, false), exponent = Number((bits >> 52n) & 2047n), mantissa = bits & ((1n << 52n) - 1n);
  const significand = exponent ? mantissa + (1n << 52n) : mantissa;
  const shift = exponent ? exponent - 1023 - 52 : -1074;
  return shift >= 0 ? fraction(significand << BigInt(shift)) : fraction(significand, 1n << BigInt(-shift));
}
function exactBlend(b, s, mode) {
  if (mode === 'multiply') return times(b, s);
  if (mode === 'screen') return minus(plus(b, s), times(b, s));
  if (mode === 'difference') return cmp(b, s) >= 0 ? minus(b, s) : minus(s, b);
  if (mode === 'overlay') return cmp(times(two, b), one) <= 0 ? times(two, times(b, s)) : minus(one, times(two, times(minus(one, b), minus(one, s))));
  return s;
}
const roundExact = value => Number((2n * value.n + value.d) / (2n * value.d));
function exactComposite(backdrop, foreground, opacity, coverage, mode, pixelIndex) {
  let sourceAlpha = times(fraction(foreground[3], 255), times(opacity, coverage));
  if (mode === 'dissolve') sourceAlpha = cmp(numberFraction(fillDissolveThreshold(pixelIndex)), sourceAlpha) < 0 ? one : zero;
  if (!sourceAlpha.n) return [...backdrop];
  const destinationAlpha = fraction(backdrop[3], 255), outputAlpha = plus(sourceAlpha, times(destinationAlpha, minus(one, sourceAlpha)));
  const rgb = [0, 1, 2].map(channel => {
    const b = fraction(backdrop[channel], 255), s = fraction(foreground[channel], 255);
    const destinationTerm = times(times(minus(one, sourceAlpha), destinationAlpha), b);
    const uncoveredTerm = times(times(minus(one, destinationAlpha), sourceAlpha), s);
    const blendTerm = times(times(sourceAlpha, destinationAlpha), exactBlend(b, s, mode));
    return roundExact(times(scale, over(plus(plus(destinationTerm, uncoveredTerm), blendTerm), outputAlpha)));
  });
  return [...rgb, roundExact(times(scale, outputAlpha))];
}
export function layerFillExactPixelComparison(options) {
  const p = pixelOptions(options), opacity = numberFraction(p.opacity), fill = numberFraction(p.fillOpacity);
  const decorated = exactComposite(p.backdrop, p.decoration, opacity, numberFraction(p.decorationCoverage), p.blendMode, p.pixelIndex);
  return exactComposite(decorated, p.body, times(opacity, fill), numberFraction(p.maskCoverage), p.blendMode, p.pixelIndex);
}

// Literal policy goldens. Additional nontrivial cases are appended only after
// checking native-order and independently expressed rational calculations.
export const LAYER_FILL_GOLDENS = Object.freeze([
  { name: 'no early alpha byte', backdrop: [0, 0, 0, 0], body: [128, 64, 32, 1], opacity: .5, fillOpacity: .5, expected: [128, 64, 32, 0] },
  { name: 'opaque body quarter amount', backdrop: [0, 0, 0, 0], body: [128, 64, 32, 255], opacity: .5, fillOpacity: .5, expected: [128, 64, 32, 64] },
  { name: 'Fill zero retains outside decoration', backdrop: [0, 0, 0, 0], body: [128, 64, 32, 0], decoration: [32, 64, 128, 255], opacity: .5, fillOpacity: 0, expected: [32, 64, 128, 128] },
  { name: 'overall zero suppresses both', backdrop: [7, 11, 19, 0], body: [128, 64, 32, 255], decoration: [32, 64, 128, 255], opacity: 0, fillOpacity: .5, expected: [7, 11, 19, 0] },
  { name: 'Fill zero leaves body backdrop exact', backdrop: [7, 11, 19, 128], body: [255, 0, 64, 255], fillOpacity: 0, expected: [7, 11, 19, 128] },
  { name: 'source alpha zero preserves hidden backdrop RGB', backdrop: [7, 11, 19, 0], body: [255, 0, 64, 0], fillOpacity: .375, expected: [7, 11, 19, 0] },
  { name: 'legacy Fill one opaque replacement', backdrop: [7, 11, 19, 128], body: [128, 64, 32, 255], fillOpacity: 1, expected: [128, 64, 32, 255] },
  { name: 'legacy Fill one alpha half tie', backdrop: [0, 0, 0, 0], body: [128, 64, 32, 1], opacity: .5, fillOpacity: 1, expected: [128, 64, 32, 1] },
  { name: 'continuous one-sixth mask stays continuous', backdrop: [0, 0, 0, 0], body: [128, 64, 32, 69], fillOpacity: 1, maskCoverage: 1 / 6, expected: [128, 64, 32, 11] },
  { name: 'partial RGBA and soft density', backdrop: [21, 93, 207, 128], body: [231, 74, 19, 128], opacity: .75, fillOpacity: .375, maskCoverage: .625, expected: [55, 90, 177, 139] },
  { name: 'multiply partial backdrop', backdrop: [21, 93, 207, 128], body: [231, 74, 19, 128], opacity: .75, fillOpacity: .375, maskCoverage: .625, blendMode: 'multiply', expected: [38, 86, 176, 139] },
  { name: 'screen partial backdrop', backdrop: [21, 93, 207, 128], body: [231, 74, 19, 128], opacity: .75, fillOpacity: .375, maskCoverage: .625, blendMode: 'screen', expected: [55, 95, 192, 139] },
  { name: 'difference partial backdrop', backdrop: [21, 93, 207, 128], body: [231, 74, 19, 128], opacity: .75, fillOpacity: .375, maskCoverage: .625, blendMode: 'difference', expected: [53, 85, 190, 139] },
  { name: 'overlay partial backdrop', backdrop: [21, 93, 207, 128], body: [231, 74, 19, 128], opacity: .75, fillOpacity: .375, maskCoverage: .625, blendMode: 'overlay', expected: [39, 88, 189, 139] },
  { name: 'alpha8 inverted mask with density', backdrop: [64, 128, 192, 255], body: [192, 64, 128, 255], opacity: .5, fillOpacity: .375, maskCoverage: 191 / 255, expected: [82, 119, 183, 255] },
  { name: 'Dissolve Fill one admits sample', backdrop: [21, 93, 207, 128], body: [231, 74, 19, 128], opacity: .5, fillOpacity: 1, blendMode: 'dissolve', pixelIndex: 0, expected: [231, 74, 19, 255] },
  { name: 'Dissolve partial Fill rejects same sample', backdrop: [21, 93, 207, 128], body: [231, 74, 19, 128], opacity: .5, fillOpacity: .5, blendMode: 'dissolve', pixelIndex: 0, expected: [21, 93, 207, 128] },
  { name: 'Dissolve lower threshold admits partial Fill', backdrop: [21, 93, 207, 128], body: [231, 74, 19, 128], opacity: .5, fillOpacity: .5, blendMode: 'dissolve', pixelIndex: 6, expected: [231, 74, 19, 255] },
  { name: 'Dissolve equality rejects strictly', backdrop: [21, 93, 207, 128], body: [231, 74, 19, 255], opacity: .19197247340343893, fillOpacity: 1, blendMode: 'dissolve', pixelIndex: 0, expected: [21, 93, 207, 128] },
  { name: 'Dissolve Fill zero retains decoration', backdrop: [21, 93, 207, 128], body: [231, 74, 19, 0], decoration: [32, 64, 128, 128], opacity: .5, fillOpacity: 0, blendMode: 'dissolve', pixelIndex: 0, expected: [32, 64, 128, 255] },
]);

export const LAYER_FILL_COVERAGE_GOLDENS = Object.freeze([
  { name: 'continuous soft mask with half density', raw: .25, options: { density: .5 }, expected: .625 },
  { name: 'continuous inverted soft mask', raw: .25, options: { density: .5, invert: true }, expected: .875 },
  { name: 'alpha8 recovery after inversion', raw: 128 / 255, options: { density: .5, invert: true, byteMask: true }, expected: 191 / 255 },
  { name: 'density zero reveals all', raw: 0, options: { density: 0 }, expected: 1 },
]);
