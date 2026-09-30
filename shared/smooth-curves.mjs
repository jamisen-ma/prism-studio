export const CURVES_INTERPOLATION_POLICY = 'shape-preserving-pchip-v1';
export const CURVES_INTERPOLATION_MODES = Object.freeze(['linear', 'smooth']);
const bound = (value, low, high) => Math.max(low, Math.min(high, value));
const byte = value => bound(Math.round(value), 0, 255);
const fail = message => { throw Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' }); };

/** PCHIP weighted harmonic tangents and limited one-sided endpoints.
 * See https://docs.scipy.org/doc/scipy/reference/generated/scipy.interpolate.PchipInterpolator.html
 * Work with m/d factors, never overflowing dy/dx. The eight-byte IEEE view
 * belongs only to this bounded setup and does not escape into the LUT. */
function curveSegments(points) {
  const view = new DataView(new ArrayBuffer(8));
  function parts(value) {
    let correction = 0;
    view.setFloat64(0, value, false);
    if (((view.getUint32(0, false) >>> 20) & 2047) === 0) {
      value *= 2 ** 1022; correction = -1022;
      view.setFloat64(0, value, false);
    }
    const high = view.getUint32(0, false), low = view.getUint32(4, false);
    return { m: 1 + ((high & 0xfffff) * 4294967296 + low) / 4503599627370496, e: ((high >>> 20) & 2047) - 1023 + correction };
  }
  const intervals = points.slice(1).map((point, index) => {
    const a = points[index], h = point.x - a.x, dy = point.y - a.y;
    if (!dy) return { a, b: point, h, dy, sign: 0, start: 0, end: 0 };
    const y = parts(Math.abs(dy)), x = parts(h);
    return { a, b: point, h, dy, sign: Math.sign(dy), m: y.m / x.m, e: y.e - x.e, start: 0, end: 0 };
  });
  function factor(target, other, targetWeight, otherWeight) {
    const exponent = target.e - other.e;
    if (exponent >= 0) {
      const inverse = other.m / target.m * 2 ** -exponent;
      return bound(inverse / (targetWeight * inverse + otherWeight), 0, 3);
    }
    const ratio = target.m / other.m * 2 ** exponent;
    return bound(1 / (targetWeight + otherWeight * ratio), 0, 3);
  }
  function scaledRatio(weight, numerator, denominator) {
    if (!weight || !numerator.sign) return 0;
    const z = parts(weight), exponent = z.e + numerator.e - denominator.e, mantissa = z.m * numerator.m / denominator.m;
    return mantissa * 2 ** exponent;
  }
  function endpoint(a, b) {
    if (!a.sign) return 0;
    const scale = Math.max(a.h, b.h), weight = (a.h / scale) / (a.h / scale + b.h / scale), product = scaledRatio(weight, b, a);
    // An overflowing ratio has the correct saturated endpoint direction.
    return bound(1 + weight + (a.sign === b.sign ? -product : product), 0, 3);
  }
  if (intervals.length === 1) { intervals[0].start = intervals[0].end = 1; return intervals; }
  for (let i = 1; i < intervals.length; i++) {
    const a = intervals[i - 1], b = intervals[i];
    if (!a.sign || a.sign !== b.sign) continue;
    const scale = Math.max(a.h, b.h), left = a.h / scale, right = b.h / scale;
    const leftWeight = (2 * right + left) / (3 * (left + right)), rightWeight = (right + 2 * left) / (3 * (left + right));
    a.end = factor(a, b, leftWeight, rightWeight);
    b.start = factor(b, a, rightWeight, leftWeight);
  }
  intervals[0].start = endpoint(intervals[0], intervals[1]);
  intervals.at(-1).end = endpoint(intervals.at(-1), intervals.at(-2));
  return intervals;
}

/** Fresh byte LUT with exact identity and authored integer knots. This is a
 * defined binary64 PCHIP evaluation, not exact-real or Adobe byte parity.
 * Source/global callers retain their own established alpha and opacity rules. */
export function compileSmoothCurveLookup(points) {
  if (!Array.isArray(points) || points.length < 2 || points.length > 16 || points[0]?.x !== 0 || points.at(-1)?.x !== 255)
    fail('Smooth Curves require 2–16 points with X endpoints at 0 and 255.');
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (!point || ![point.x, point.y].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 255) || (i && point.x <= points[i - 1].x))
      fail('Smooth curve points must be finite in 0–255 with strictly increasing X.');
  }
  const segments = curveSegments(points);
  const lookup = new Uint8Array(256), identity = points.every(point => point.x === point.y), linear = points.length === 2;
  let segment = 0;
  for (let i = 0; i < 256; i++) {
    while (segment < segments.length - 1 && segments[segment].b.x < i) segment++;
    const current = segments[segment]; let value;
    if (identity) value = i;
    else if (i === current.a.x) value = current.a.y;
    else if (i === current.b.x) value = current.b.y;
    else if (linear) value = current.a.y + current.dy * (i - current.a.x) / current.h;
    else {
      const low = Math.min(current.a.y, current.b.y), high = Math.max(current.a.y, current.b.y);
      const c1 = bound(current.a.y + current.dy * (current.start / 3), low, high), c2 = bound(current.b.y - current.dy * (current.end / 3), low, high);
      const t = (i - current.a.x) / current.h, lerp = (a, b) => a + (b - a) * t;
      value = bound(lerp(lerp(lerp(current.a.y, c1), lerp(c1, c2)), lerp(lerp(c1, c2), lerp(c2, current.b.y))), low, high);
    }
    lookup[i] = byte(value);
  }
  return lookup;
}
