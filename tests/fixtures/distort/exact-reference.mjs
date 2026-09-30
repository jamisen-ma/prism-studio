// Independent exact-rational fixture generator for the design, not a runtime
// promise of exact-real projective pixels. No production sampling code used.
const gcd = (a, b) => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a; };
function rational(n, d) { if (d < 0n) { n = -n; d = -d; } if (!d) throw Error('Singular rational'); const g = gcd(n, d); return [n / g, d / g]; }
function dyadic(value) { let n = value, q = 1n; while (!Number.isInteger(n)) { n *= 2; q *= 2n; } return rational(BigInt(n), q); }
const floor = (n, d) => n / d - (n < 0n && n % d ? 1n : 0n);
const half = (n, d) => Number(n / d + (2n * (n % d) >= d ? 1n : 0n));
function adjugate([a, b, c, d, e, f, g, h, i]) { return [e * i - f * h, c * h - b * i, b * f - c * e, f * g - d * i, a * i - c * g, c * d - a * f, d * h - e * g, b * g - a * h, a * e - b * d]; }
export function exactMatrices(corners) {
  const fractions = corners.flat().map(dyadic), unit = fractions.reduce((q, f) => q > f[1] ? q : f[1], 1n);
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = [0, 1, 2, 3].map(i => fractions.slice(2 * i, 2 * i + 2).map(([p, q]) => p * (unit / q)));
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  const D = dx1 * dy2 - dx2 * dy1, G = dx3 * dy2 - dx2 * dy3, H = dx1 * dy3 - dx3 * dy1;
  if (!D) throw Error('Singular corner frame');
  const forward = [(x1 - x0) * D + G * x1, (x3 - x0) * D + H * x3, x0 * D,
    (y1 - y0) * D + G * y1, (y3 - y0) * D + H * y3, y0 * D, G * unit, H * unit, D * unit];
  let inverse = adjugate(forward);
  // Sign orientation is chosen at the image of the unit-square center.
  const cx = forward[0] + forward[1] + 2n * forward[2], cy = forward[3] + forward[4] + 2n * forward[5], cw = forward[6] + forward[7] + 2n * forward[8];
  const denominator = inverse[6] * cx + inverse[7] * cy + inverse[8] * cw;
  if ((denominator < 0n) !== (cw < 0n)) inverse = inverse.map(v => -v);
  return { forward, inverse };
}
export function mapPoint(matrix, x, y) {
  const [xn, xd] = dyadic(x), [yn, yd] = dyadic(y), Q = xd > yd ? xd : yd, X = xn * (Q / xd), Y = yn * (Q / yd);
  const D = matrix[6] * X + matrix[7] * Y + matrix[8] * Q;
  return [rational(matrix[0] * X + matrix[1] * Y + matrix[2] * Q, D), rational(matrix[3] * X + matrix[4] * Y + matrix[5] * Q, D)];
}
export function translation(corners, width, height) {
  const [x, y] = corners[0];
  return Number.isInteger(x) && Number.isInteger(y) && corners.every(([a, b], i) => a === x + [0, width, width, 0][i] && b === y + [0, 0, height, height][i]) ? { x, y } : null;
}
export function exactSample(input, width, height, corners, { copy = true } = {}) {
  const out = Buffer.alloc(input.length), shift = copy ? translation(corners, width, height) : null;
  if (shift) {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const sx = x - shift.x, sy = y - shift.y; if (sx >= 0 && sy >= 0 && sx < width && sy < height) input.copy(out, 4 * (y * width + x), 4 * (sy * width + sx), 4 * (sy * width + sx + 1)); }
    return out;
  }
  const { inverse: I } = exactMatrices(corners);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const X = BigInt(2 * x + 1), Y = BigInt(2 * y + 1), d = I[6] * X + I[7] * Y + 2n * I[8];
    if (d <= 0n) continue;
    const D = 2n * d, nx = 2n * BigInt(width) * (I[0] * X + I[1] * Y + 2n * I[2]) - d, ny = 2n * BigInt(height) * (I[3] * X + I[4] * Y + 2n * I[5]) - d;
    const left = floor(nx, D), top = floor(ny, D); if (left < -1n || top < -1n || left >= width || top >= height) continue;
    const fx = nx - left * D, fy = ny - top * D;
    let A = 0n; const rgb = [0n, 0n, 0n];
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const sx = Number(left) + dx, sy = Number(top) + dy; if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
      const i = 4 * (sy * width + sx), w = (dx ? fx : D - fx) * (dy ? fy : D - fy) * BigInt(input[i + 3]);
      A += w; for (let c = 0; c < 3; c++) rgb[c] += BigInt(input[i + c]) * w;
    }
    if (!A) continue;
    const i = 4 * (y * width + x); for (let c = 0; c < 3; c++) out[i + c] = half(rgb[c], A); out[i + 3] = half(A, D * D);
  }
  return out;
}
