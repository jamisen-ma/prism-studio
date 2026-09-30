import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTonalParameters, tonalColorTransform, TONAL_COLOR_ROUND_GUARD } from '../server/tonal-color.mjs';

const W = [2126n, 7152n, 722n], D = 2_550_000n;
const round = (n, d) => n <= 0n ? 0 : n >= 255n * d ? 255 : Number((2n * n + d) / (2n * d));
const luma = rgb => rgb.reduce((sum, value, index) => sum + Number(W[index]) * value, 0) / 10_000;
function oracleBalance(rgb, p) {
  const source = rgb.map(BigInt), L = source.reduce((sum, value, index) => sum + W[index] * value, 0n);
  const shadow = D > 2n * L ? D - 2n * L : 0n, highlight = 2n * L > D ? 2n * L - D : 0n;
  const weights = [shadow, D - shadow - highlight, highlight], rows = [p.shadows, p.midtones, p.highlights];
  // Deliberately keep the original, uncancelled numerator: all arithmetic is
  // BigInt rather than sharing the production Number simplification.
  const denominator = D * 10_000n;
  const desired = source.map((value, index) => value * denominator + 255n * weights.reduce((sum, weight, tone) => sum + weight * BigInt(Math.round(rows[tone][index] * 100)), 0n));
  if (!p.preserveLuminosity) return desired.map(value => round(value, denominator));
  const mean = desired.reduce((sum, value, index) => sum + W[index] * value, 0n), chroma = desired.map(value => 10_000n * value - mean), chromaDenominator = 10_000n * denominator;
  let factorN = 1n, factorD = 1n;
  for (const component of chroma) if (component !== 0n) {
    const gap = component > 0n ? D - L : L, candidateN = gap * chromaDenominator, candidateD = 10_000n * (component < 0n ? -component : component);
    if (candidateN * factorD < factorN * candidateD) { factorN = candidateN; factorD = candidateD; }
  }
  return chroma.map(component => round(L * chromaDenominator * factorD + 10_000n * component * factorN, 10_000n * chromaDenominator * factorD));
}
function oracleBW(rgb, p) {
  const [r, g, b] = rgb, low = Math.min(...rgb), high = Math.max(...rgb), c = high - low;
  const anchors = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas'].map(key => BigInt(Math.round(p[key] * 100)));
  let gray = low;
  if (c) {
    // Conventional hue angle gives an independent sector route for integer
    // differences; exact arithmetic then uses the rounded integer distance.
    let angle = high === r ? (g - b) / c : high === g ? 2 + (b - r) / c : 4 + (r - g) / c;
    if (angle < 0) angle += 6;
    const sector = Math.floor(angle), distance = Math.round((angle - sector) * c);
    gray = round(BigInt(low) * 10_000n + BigInt(c - distance) * anchors[sector] + BigInt(distance) * anchors[(sector + 1) % 6], 10_000n);
  }
  if (!p.tint || p.tintAmount === 0) return [gray, gray, gray];
  const color = [1, 3, 5].map(index => BigInt(parseInt(p.tintColor.slice(index, index + 2), 16))), mean = color.reduce((sum, value, index) => sum + W[index] * value, 0n);
  const chroma = color.map(value => value * 10_000n - mean);
  let factorN = 1n, factorD = 1n;
  for (const component of chroma) if (component !== 0n) {
    const candidateN = BigInt(component > 0n ? 255 - gray : gray) * 10_000n, candidateD = component < 0n ? -component : component;
    if (candidateN * factorD < factorN * candidateD) { factorN = candidateN; factorD = candidateD; }
  }
  const amount = BigInt(Math.round(p.tintAmount * 100));
  return chroma.map(component => round(BigInt(gray) * 100_000_000n * factorD + component * factorN * amount, 100_000_000n * factorD));
}
function random(seed = 0x8fb4631) {
  return () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
}

test('tonal parameters are complete independent copies with strict types, bounds and hundredth-percent precision', () => {
  assert.deepEqual(normalizeTonalParameters('color_balance'), { shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0], preserveLuminosity: true });
  const input = { shadows: [-12.34, 100, -100], preserveLuminosity: false }, normalized = normalizeTonalParameters('color_balance', input);
  input.shadows[0] = 9; assert.equal(normalized.shadows[0], -12.34); assert.deepEqual(normalized.midtones, [0, 0, 0]);
  const bw = normalizeTonalParameters('black_white', { tint: false, tintColor: '#AbCdEf', tintAmount: 13.27 });
  assert.equal(bw.tintColor, '#abcdef'); assert.equal(bw.tintAmount, 13.27); assert.equal(bw.reds, 40);
  for (const p of [null, [], { shadows: [0, 0] }, { midtones: [0, , 0] }, { highlights: [0, 0, 100.01] }, { shadows: [0, 0, .001] }, { preserveLuminosity: 1 }, { bogus: 0 }, { shadows: [NaN, 0, 0] }]) assert.throws(() => normalizeTonalParameters('color_balance', p), { code: 'INVALID_ARGUMENT' });
  for (const p of [{ reds: -200.01 }, { blues: 300.01 }, { tintAmount: 100.01 }, { tintAmount: .001 }, { tint: 0 }, { tintColor: '#fff' }, { tintColor: null }, { tint: false, tintAmount: Infinity }]) assert.throws(() => normalizeTonalParameters('black_white', p), { code: 'INVALID_ARGUMENT' });
  const getter = Object.defineProperty({}, 'shadows', { enumerable: true, get() { throw Error('Must not evaluate accessors'); } });
  assert.throws(() => normalizeTonalParameters('color_balance', getter), { code: 'INVALID_ARGUMENT' });
});

test('Color Balance defaults preserve all gray and seeded RGB inputs exactly; preserved black and white stay fixed', () => {
  const identity = tonalColorTransform('color_balance'), next = random();
  for (let gray = 0; gray < 256; gray++) assert.deepEqual(identity(gray, gray, gray), [gray, gray, gray]);
  for (let i = 0; i < 3000; i++) { const rgb = [next() % 256, next() % 256, next() % 256]; assert.deepEqual(identity(...rgb), rgb); }
  const extreme = tonalColorTransform('color_balance', { shadows: [100, -100, 31.37], midtones: [-100, 92.17, 100], highlights: [99, -100, 100] });
  assert.deepEqual(extreme(0, 0, 0), [0, 0, 0]); assert.deepEqual(extreme(255, 255, 255), [255, 255, 255]);
});

test('Color Balance both preservation modes match an independent uncancelled BigInt oracle over extreme and seeded controls', () => {
  const next = random(0x9862541);
  for (let settings = 0; settings < 30; settings++) for (const preserveLuminosity of [false, true]) {
    const row = () => Array.from({ length: 3 }, () => ((next() % 20001) - 10000) / 100);
    const p = normalizeTonalParameters('color_balance', { shadows: row(), midtones: row(), highlights: row(), preserveLuminosity }), transform = tonalColorTransform('color_balance', p);
    for (let pixel = 0; pixel < 180; pixel++) {
      const rgb = [next() % 256, next() % 256, next() % 256], result = transform(...rgb);
      assert.deepEqual(result, oracleBalance(rgb, p), JSON.stringify({ rgb, p }));
      if (preserveLuminosity) assert.ok(Math.abs(luma(result) - luma(rgb)) <= .500000000001);
    }
  }
});

test('near-half fitting recomputes exact constraints without adding an output epsilon', () => {
  const rows = { shadows: [100, -100, 100], midtones: [100, -100, 100], highlights: [100, -100, 100] }, transform = tonalColorTransform('color_balance', rows);
  for (let r = 0; r < 32; r++) assert.deepEqual(transform(r, 89, r), [r + 224, 0, r + 224]);
  assert.deepEqual(transform(1, 89, 1), [225, 0, 225]);
  assert.ok(TONAL_COLOR_ROUND_GUARD > 6 * 255 * Number.EPSILON / 2 && TONAL_COLOR_ROUND_GUARD < 1e-10);
  for (const value of [99.99, 99.98, 99.97, -99.99]) {
    const p = normalizeTonalParameters('color_balance', { ...rows, midtones: [value, -100, 100] }), mapped = tonalColorTransform('color_balance', p);
    for (let r = 0; r < 32; r++) assert.deepEqual(mapped(r, 89, r), oracleBalance([r, 89, r], p));
  }
});

test('Black & White hue anchors, tie sectors, grayscale and wraparound match exact mixing', () => {
  const p = normalizeTonalParameters('black_white'), transform = tonalColorTransform('black_white');
  const anchors = [[255, 0, 0], [255, 255, 0], [0, 255, 0], [0, 255, 255], [0, 0, 255], [255, 0, 255]];
  anchors.forEach((rgb, index) => assert.deepEqual(transform(...rgb), Array(3).fill([102, 153, 102, 153, 51, 204][index])));
  for (let gray = 0; gray < 256; gray++) assert.deepEqual(transform(gray, gray, gray), [gray, gray, gray]);
  for (const rgb of [[255, 0, 1], [255, 1, 0], [255, 254, 0], [255, 255, 1], [1, 255, 255], [127, 127, 1], [1, 127, 127], [127, 1, 127]]) assert.deepEqual(transform(...rgb), oracleBW(rgb, p));
});

test('Black & White and integer tint fitting match independent BigInt arithmetic including off-state retention and neutral tint', () => {
  const next = random(0x8471956), keys = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas'];
  for (let settings = 0; settings < 35; settings++) {
    const controls = Object.fromEntries(keys.map(key => [key, ((next() % 50001) - 20000) / 100]));
    const p = normalizeTonalParameters('black_white', { ...controls, tint: settings % 3 !== 0, tintColor: `#${(next() & 0xffffff).toString(16).padStart(6, '0')}`, tintAmount: (next() % 10001) / 100 }), transform = tonalColorTransform('black_white', p);
    for (let pixel = 0; pixel < 180; pixel++) { const rgb = [next() % 256, next() % 256, next() % 256]; assert.deepEqual(transform(...rgb), oracleBW(rgb, p), JSON.stringify({ rgb, p })); }
    assert.deepEqual(transform(0, 0, 0), [0, 0, 0]); assert.deepEqual(transform(255, 255, 255), [255, 255, 255]);
  }
  for (const tint of [{ tint: false, tintColor: '#ff0000' }, { tint: true, tintColor: '#ff0000', tintAmount: 0 }, { tint: true, tintColor: '#808080' }]) {
    const ordinary = tonalColorTransform('black_white'), transform = tonalColorTransform('black_white', tint);
    for (let i = 0; i < 300; i++) { const rgb = [next() % 256, next() % 256, next() % 256]; assert.deepEqual(transform(...rgb), ordinary(...rgb)); }
  }
});
