// Maintained independent HSL oracle. No production helper imports.
// Hue-arc memberships and a generic exact 12-period HSL conversion provide
// a separate reference; the native oracle pins the declared binary64 stage.
export const TARGETED_HSL_RANGES = Object.freeze(['master', 'reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas']);
const names = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas'];
const gcd = (x, y) => { x = x < 0n ? -x : x; while (y) [x, y] = [y, x % y]; return x; };
const q = (n, d = 1n) => { n = BigInt(n); d = BigInt(d); if (d < 0n) { n = -n; d = -d; } const g = gcd(n, d); return { n: n / g, d: d / g }; };
const plus = (a, b) => q(a.n * b.d + b.n * a.d, a.d * b.d);
const minus = (a, b) => q(a.n * b.d - b.n * a.d, a.d * b.d);
const times = (a, b) => q(a.n * b.n, a.d * b.d);
const divide = (a, b) => q(a.n * b.d, a.d * b.n);
const compare = (a, b) => { const n = a.n * b.d - b.n * a.d; return n < 0n ? -1 : n > 0n ? 1 : 0; };
const min = (a, b) => compare(a, b) <= 0 ? a : b;
const max = (a, b) => compare(a, b) >= 0 ? a : b;
const mod = (a, period) => { const d = BigInt(period) * a.d; return q((a.n % d + d) % d, a.d); };
const zero = q(0), one = q(1), negativeOne = q(-1);
const clampUnit = a => max(negativeOne, min(one, a));
const byte = a => a.n <= 0n ? 0 : a.n >= 255n * a.d ? 255 : Number((2n * a.n + a.d) / (2n * a.d));

export function targetedHslExactReference(rgb, supplied = {}) {
  const [r, g, b] = rgb, high = Math.max(...rgb), low = Math.min(...rgb), delta = high - low;
  const master = supplied.master ?? [0, 0, 0], rowUnits = row => row.map(v => Math.round(v * 100));
  const masterUnits = rowUnits(master), adjustments = [q(masterUnits[0], 100), q(masterUnits[1], 10000), q(masterUnits[2], 10000)];
  let hueArc = 0;
  if (delta) {
    hueArc = high === r ? g - b : high === g ? 2 * delta + b - r : 4 * delta + r - g;
    if (hueArc < 0) hueArc += 6 * delta;
    const sector = Math.floor(hueArc / delta), t = hueArc - sector * delta;
    const weights = Array(6).fill(0); weights[sector] = delta - t; weights[(sector + 1) % 6] = t;
    for (let j = 0; j < 6; j++) {
      const units = rowUnits(supplied[names[j]] ?? [0, 0, 0]);
      for (let c = 0; c < 3; c++) adjustments[c] = plus(adjustments[c], q(weights[j] * units[c], (c === 2 ? 255 : delta) * (c === 0 ? 100 : 10000)));
    }
  }
  const changeS = clampUnit(adjustments[1]), changeL = clampUnit(adjustments[2]);
  let light = q(high + low, 510);
  light = compare(changeL, zero) < 0 ? times(light, plus(one, changeL)) : plus(light, times(minus(one, light), changeL));
  let sat = delta ? q(delta, 255 - Math.abs(high + low - 255)) : zero;
  sat = min(one, times(sat, plus(one, changeS)));
  const hue = mod(plus(delta ? q(60 * hueArc, delta) : zero, adjustments[0]), 360);
  const amplitude = times(sat, min(light, minus(one, light)));
  const channel = n => {
    const k = mod(plus(q(n), divide(hue, q(30))), 12);
    const triangle = max(negativeOne, min(one, min(minus(k, q(3)), minus(q(9), k))));
    return times(q(255), minus(light, times(amplitude, triangle)));
  };
  const exact = [channel(0), channel(8), channel(4)];
  return { exact, bytes: exact.map(byte) };
}

export function targetedHslNativeReference(rgb, parameters = {}) {
  const maximum = Math.max(...rgb), minimum = Math.min(...rgb), c = maximum - minimum, total = maximum + minimum;
  const scale = c || 255, q = 10000 * scale, ql = 2550000;
  const master = (parameters.master ?? [0, 0, 0]).map(v => Math.round(v * 100));
  let hue = master[0] * scale, saturation = master[1] * scale, lightness = master[2] * 255, arc = 0;
  if (c) {
    const [r, g, b] = rgb;
    arc = maximum === r ? g - b : maximum === g ? 2 * c + b - r : 4 * c + r - g;
    if (arc < 0) arc += 6 * c;
    const sector = Math.floor(arc / c), remainder = arc - sector * c, weights = Array(6).fill(0);
    weights[sector] = c - remainder; weights[(sector + 1) % 6] = remainder;
    for (let j = 0; j < names.length; j++) {
      const row = (parameters[names[j]] ?? [0, 0, 0]).map(v => Math.round(v * 100));
      hue += weights[j] * row[0]; saturation += weights[j] * row[1]; lightness += weights[j] * row[2];
    }
  }
  saturation = Math.max(-q, Math.min(q, saturation)); lightness = Math.max(-ql, Math.min(ql, lightness));
  if (lightness === 0 && saturation === 0 && (hue === 0 || Math.abs(hue) === 36000 * scale)) return [...rgb];
  const nl = lightness < 0 ? total * (ql + lightness) : total * ql + (510 - total) * lightness;
  const gray = () => Array(3).fill(Math.floor((2 * nl + 2 * ql) / (4 * ql)));
  if (!c) return gray();
  if (nl === 0) return [0, 0, 0]; if (nl === 510 * ql) return [255, 255, 255];
  const k = 255 - Math.abs(total - 255), ds = k * q, ns = Math.min(ds, c * (q + saturation));
  if (ns === 0) return gray();
  const hb = 6000 * scale, dh = c * hb, period = 6 * dh;
  let nh = (arc * hb + hue * c) % period; if (nh < 0) nh += period;
  const sector = Math.floor(nh / dh), remainder = nh - sector * dh, triangle = sector % 2 ? dh - remainder : remainder;
  // This order is intentionally part of the byte contract, including half ties.
  const l = nl / (2 * ql), chroma = ((255 * ql - Math.abs(nl - 255 * ql)) / ql) * (ns / ds);
  const base = l - chroma / 2, secondary = base + chroma * (triangle / dh), high = base + chroma;
  const channels = [[high, secondary, base], [secondary, high, base], [base, high, secondary], [base, secondary, high], [secondary, base, high], [high, base, secondary]][sector];
  return channels.map(v => Math.max(0, Math.min(255, Math.round(v))));
}

export const TARGETED_HSL_GOLDENS = [
  { rgb: [32, 0, 0], parameters: { reds: [0, -100, 0] }, expected: [16, 16, 16] },
  { rgb: [255, 223, 223], parameters: { reds: [0, -100, 0] }, expected: [239, 239, 239] },
  { rgb: [128, 127, 127], parameters: { reds: [0, 0, 10] }, expected: [128, 127, 127] },
  { rgb: [1, 0, 0], parameters: { reds: [0, 0, 10] }, expected: [1, 0, 0] },
  { rgb: [160, 96, 96], parameters: { master: [0, 100, 0] }, expected: [192, 64, 64] },
  { rgb: [224, 1, 127], parameters: { reds: [0, -100, 0] }, expected: [176, 49, 121] },
  { rgb: [224, 127, 1], parameters: { reds: [0, -100, 0] }, expected: [176, 121, 49] },
  { rgb: [255, 0, 0], parameters: { master: [120, 0, 0], reds: [0, 0, 50], greens: [0, 0, -100] }, expected: [128, 255, 128] },
  { rgb: [255, 0, 0], parameters: { master: [0, -100, 0] }, expected: [128, 128, 128] },
];
