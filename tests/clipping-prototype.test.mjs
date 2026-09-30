import test from 'node:test';
import assert from 'node:assert/strict';
import { prototypeClippingChain, CLIPPING_PROTOTYPE_LIMITS } from './prototypes/clipping-reference.mjs';

// Independent exact rational reference. Its arithmetic does not call the
// prototype, native compositing, mask processing or production blend helpers.
function gcd(a, b) { while (b) [a, b] = [b, a % b]; return a < 0n ? -a : a; }
function fraction(n, d = 1n) { n = BigInt(n); d = BigInt(d); const g = gcd(n, d); return [n / g, d / g]; }
const add = (a, b) => fraction(a[0] * b[1] + b[0] * a[1], a[1] * b[1]);
const neg = a => [-a[0], a[1]];
const sub = (a, b) => add(a, neg(b));
const mul = (a, b) => fraction(a[0] * b[0], a[1] * b[1]);
const div = (a, b) => fraction(a[0] * b[1], a[1] * b[0]);
const one = fraction(1), zero = fraction(0), max = fraction(255);
const round = a => Number((2n * a[0] + a[1]) / (2n * a[1]));
const numeric = value => Number(value[0]) / Number(value[1]);
function blended(b, s, mode) {
  if (mode === 'multiply') return div(mul(b, s), max);
  if (mode === 'screen') return sub(add(b, s), div(mul(b, s), max));
  return s;
}
function exactPixel(base, members, back, index, protectedPixel) {
  const offset = index * 4, colors = [...base.pixels.subarray(offset, offset + 3)], originalAlpha = base.pixels[offset + 3];
  const coverage = base.mask?.[index] ?? one;
  if (!base.visible || base.opacity[0] === 0n) return { interior: [...colors, originalAlpha], pixel: [...back.subarray(offset, offset + 4)] };
  if (originalAlpha && coverage[0] && !protectedPixel) for (const member of members) {
    if (!member.visible) continue;
    const amount = mul(mul(fraction(member.pixels[offset + 3], 255), member.opacity), member.mask?.[index] ?? one);
    for (let c = 0; c < 3; c++) colors[c] = round(add(mul(fraction(colors[c]), sub(one, amount)), mul(blended(fraction(colors[c]), fraction(member.pixels[offset + c]), member.blendMode), amount)));
  }
  const a = mul(mul(fraction(originalAlpha, 255), base.opacity), coverage), b = fraction(back[offset + 3], 255);
  if (!a[0]) return { interior: [...colors, originalAlpha], pixel: [...back.subarray(offset, offset + 4)] };
  const alpha = add(a, mul(b, sub(one, a))), output = [];
  for (let c = 0; c < 3; c++) {
    const d = fraction(back[offset + c]), s = fraction(colors[c]);
    const premultiplied = add(add(mul(mul(d, b), sub(one, a)), mul(mul(s, a), sub(one, b))), mul(mul(blended(d, s, base.blendMode), a), b));
    output.push(round(div(premultiplied, alpha)));
  }
  output.push(round(mul(alpha, max)));
  return { interior: [...colors, originalAlpha], pixel: output };
}
const runtimeLayer = value => ({ ...value, opacity: numeric(value.opacity), ...(value.mask ? { mask: value.mask.map(numeric) } : {}) });
const layer = (pixels, options = {}) => ({ pixels: Buffer.from(pixels), visible: true, opacity: one, blendMode: 'normal', ...options });

test('a clipped opaque fill retains alpha 128 instead of thickening it to 192, including repeated fills and alpha-one edges', () => {
  const base = { pixels: Buffer.from([200, 10, 30, 128, 30, 60, 90, 1, 120, 170, 20, 0]) }, member = { pixels: Buffer.from([0, 90, 250, 255, 0, 90, 250, 255, 255, 0, 0, 255]) };
  const backdrop = Buffer.from([71, 23, 99, 0, 19, 42, 151, 0, 78, 93, 207, 0]);
  const result = prototypeClippingChain({ width: 3, height: 1, base, members: [member, member, member], backdrop });
  assert.deepEqual([...result.pixels], [0, 90, 250, 128, 0, 90, 250, 1, 78, 93, 207, 0]);
  assert.deepEqual([...result.interior], [0, 90, 250, 128, 0, 90, 250, 1, 120, 170, 20, 0]);
  assert.equal(Math.round((128 / 255 + 128 / 255 * (1 - 128 / 255)) * 255), 192, 'The naive alpha-multiply/source-over alternative is observably wrong.');
});

test('small seeded clipping fixtures match independent exact rational color, mask, opacity and blending arithmetic', () => {
  let seed = 0x71a3c21; const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const ratios = [zero, fraction(1, 8), fraction(3, 8), fraction(5, 8), fraction(7, 8), one], alpha = [0, 1, 2, 64, 128, 254, 255], modes = ['normal', 'multiply', 'screen'];
  let pixelsChecked = 0;
  for (let trial = 0; trial < 120; trial++) {
    const count = 1 + random() % 16;
    const rgba = () => Buffer.from(Array.from({ length: count }, () => [random() % 256, random() % 256, random() % 256, alpha[random() % alpha.length]]).flat());
    const sample = () => layer(rgba(), { visible: random() % 7 !== 0, opacity: ratios[random() % ratios.length], blendMode: modes[random() % modes.length], mask: Array.from({ length: count }, () => ratios[random() % ratios.length]) });
    const base = sample(), members = Array.from({ length: random() % 5 }, sample), backdrop = rgba(), protection = Uint8Array.from({ length: count }, () => random() % 5 === 0 ? 1 : 0);
    const result = prototypeClippingChain({ width: count, height: 1, base: runtimeLayer(base), members: members.map(runtimeLayer), backdrop, protectedPixels: protection });
    for (let p = 0; p < count; p++) {
      const expected = exactPixel(base, members, backdrop, p, protection[p]);
      assert.deepEqual([...result.interior.subarray(p * 4, p * 4 + 4)], expected.interior, `Interior trial ${trial}, pixel ${p}`);
      assert.deepEqual([...result.pixels.subarray(p * 4, p * 4 + 4)], expected.pixel, `Composite trial ${trial}, pixel ${p}`);
      pixelsChecked++;
    }
  }
  assert.ok(pixelsChecked > 500);
});

test('base mask and opacity apply once; member masks do not accumulate base attenuation or erase hidden RGB', () => {
  const base = { pixels: Buffer.from([50, 100, 150, 128, 60, 120, 180, 255]), mask: [1 / 3, 0], opacity: 0.5 }, backdrop = Buffer.from([8, 9, 10, 0, 17, 19, 23, 0]);
  const fill = { pixels: Buffer.from([200, 160, 120, 255, 200, 160, 120, 255]), mask: [0.5, 1], opacity: 0.5 };
  const result = prototypeClippingChain({ width: 2, height: 1, base, members: [fill], backdrop });
  assert.deepEqual([...result.interior], [88, 115, 143, 128, 60, 120, 180, 255]);
  assert.deepEqual([...result.pixels], [88, 115, 143, 21, 17, 19, 23, 0]);
  for (const changed of [{ ...base, visible: false }, { ...base, opacity: 0 }]) assert.deepEqual(prototypeClippingChain({ width: 2, height: 1, base: changed, members: [fill], backdrop }).pixels, backdrop);
});

test('inherited protected pixels retain the base-only composite and all buffers and output objects remain independent', () => {
  const base = { pixels: Buffer.from([200, 80, 20, 128, 20, 80, 200, 255]), opacity: 0.7, mask: [0.8, 1], blendMode: 'multiply' };
  const member = { pixels: Buffer.from([20, 255, 80, 255, 255, 20, 80, 128]), opacity: 0.8, blendMode: 'screen' }, backdrop = Buffer.from([30, 70, 110, 255, 100, 140, 180, 128]), protection = Uint8Array.from([1, 0]);
  const snapshot = { base: Buffer.from(base.pixels), member: Buffer.from(member.pixels), backdrop: Buffer.from(backdrop), protection: Uint8Array.from(protection) };
  const args = { width: 2, height: 1, base, members: [member], backdrop, protectedPixels: protection };
  const before = prototypeClippingChain({ ...args, members: [] }), result = prototypeClippingChain(args);
  assert.deepEqual(result.pixels.subarray(0, 4), before.pixels.subarray(0, 4)); assert.notDeepEqual(result.pixels.subarray(4), before.pixels.subarray(4));
  assert.deepEqual(base.pixels, snapshot.base); assert.deepEqual(member.pixels, snapshot.member); assert.deepEqual(backdrop, snapshot.backdrop); assert.deepEqual(protection, snapshot.protection);
  const expected = Buffer.from(result.pixels); result.pixels.fill(0); result.interior.fill(0);
  assert.deepEqual(prototypeClippingChain(args).pixels, expected); assert.deepEqual(base.pixels, snapshot.base);
});

test('the prototype refuses unsupported scope and oversized or malformed fixtures', () => {
  const args = { width: 1, height: 1, base: { pixels: Buffer.from([20, 40, 60, 128]) }, backdrop: Buffer.alloc(4) };
  for (const bad of [
    { ...args, width: CLIPPING_PROTOTYPE_LIMITS.maxDimension + 1 },
    { ...args, members: Array(9).fill(args.base) },
    { ...args, base: { ...args.base, blendMode: 'dissolve' } },
    { ...args, base: { ...args.base, mask: [NaN] } },
    { ...args, base: { ...args.base, opacity: -0.1 } },
    { ...args, backdrop: Buffer.alloc(3) },
    { ...args, protectedPixels: Uint8Array.from([2]) },
  ]) assert.throws(() => prototypeClippingChain(bad), TypeError);
});
