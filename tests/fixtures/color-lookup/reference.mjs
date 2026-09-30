// Independently authored Color Lookup acceptance fixtures, 2026-09-19.
// No third-party LUTs, copied implementation or production/prototype imports.
// The formulas and serializers here define test data, not a general CUBE reader.
import { createHash } from 'node:crypto';

export const AUTHORED_LOOKUP_NAMES = Object.freeze(['identity', 'rgb-cycle', 'cross-products', 'gain-half', 'gentle-crosscolor']);
const dyadicGrids = new Set([2, 3, 5, 9, 17, 33]);
const half = (numerator, denominator) => Number((2n * numerator + denominator) / (2n * denominator));
function point(name, r, g, b) {
  if (name === 'identity') return [r, g, b];
  if (name === 'rgb-cycle') return [g, b, r];
  if (name === 'cross-products') return [r * g, g * (1 - b), b * (1 - r)];
  if (name === 'gain-half') return [r * (255 / 256), g, b];
  if (name === 'gentle-crosscolor') return [(15 * r + b * (1 - r)) / 16, (31 * g + r * g) / 32, (15 * b + g * (1 - b)) / 16];
  throw new Error('Unknown authored fixture.');
}

/** Fresh bytes; red varies fastest. Grids with power-of-two interval counts
 * keep every authored sample exactly dyadic, including its decimal spelling. */
export function authoredCube(name, { gridSize = 2, domain = true, eol = '\n' } = {}) {
  if (!AUTHORED_LOOKUP_NAMES.includes(name) || !dyadicGrids.has(gridSize) || !['\n', '\r\n'].includes(eol)) throw new Error('Unsupported fixture arguments.');
  const lines = [`# Independently authored Prism fixture: ${name}`, `TITLE "Prism authored ${name}"`, `LUT_3D_SIZE ${gridSize}`];
  if (domain) lines.push('DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1');
  for (let b = 0; b < gridSize; b++) for (let g = 0; g < gridSize; g++) for (let r = 0; r < gridSize; r++) {
    lines.push(point(name, r / (gridSize - 1), g / (gridSize - 1), b / (gridSize - 1)).map(String).join(' '));
  }
  return Buffer.from(lines.join(eol) + eol, 'utf8');
}

/** Closed-form BigInt oracle for these authored multilinear cubes only.
 * It does not duplicate any generic interpolation implementation. */
export function authoredLookupGolden(name, rgb) {
  if (!Array.isArray(rgb) || rgb.length !== 3 || rgb.some(c => !Number.isInteger(c) || c < 0 || c > 255)) throw new Error('RGB8 required.');
  const [r, g, b] = rgb.map(BigInt), m = 255n;
  if (name === 'identity') return [...rgb];
  if (name === 'rgb-cycle') return [rgb[1], rgb[2], rgb[0]];
  if (name === 'cross-products') return [half(r * g, m), half(g * (m - b), m), half(b * (m - r), m)];
  if (name === 'gain-half') return [half(255n * r, 256n), rgb[1], rgb[2]];
  if (name === 'gentle-crosscolor') return [half(15n * r * m + b * (m - r), 16n * m), half(31n * g * m + r * g, 32n * m), half(15n * b * m + g * (m - b), 16n * m)];
  throw new Error('Unknown authored fixture.');
}

export const AUTHORED_LOOKUP_GOLDENS = Object.freeze([
  { name: 'identity', rgb: [0, 128, 255], expected: [0, 128, 255] },
  { name: 'rgb-cycle', rgb: [13, 127, 253], expected: [127, 253, 13] },
  { name: 'cross-products', rgb: [128, 64, 192], expected: [32, 16, 96] },
  { name: 'cross-products', rgb: [255, 255, 255], expected: [255, 0, 0] },
  { name: 'cross-products', rgb: [0, 255, 0], expected: [0, 255, 0] },
  { name: 'gain-half', rgb: [128, 64, 192], expected: [128, 64, 192] },
  { name: 'gain-half', rgb: [255, 1, 0], expected: [254, 1, 0] },
  { name: 'gentle-crosscolor', rgb: [64, 128, 192], expected: [69, 125, 182] },
].map(value => Object.freeze({ ...value, rgb: Object.freeze(value.rgb), expected: Object.freeze(value.expected) })));

/** Independent declared-order sampler for a fixture name, not for arbitrary
 * parsed files. This comparison helper validates the closed forms at native
 * half boundaries; production/parsing never feeds its sample values. */
export function authoredLookupNativeOrder(name, rgb, gridSize = 2) {
  if (!dyadicGrids.has(gridSize)) throw new Error('Dyadic fixture grid required.');
  const low = rgb.map(c => Math.min(gridSize - 2, Math.floor(c * (gridSize - 1) / 255)));
  const rem = rgb.map((c, i) => c * (gridSize - 1) - 255 * low[i]);
  const result = [0, 0, 0];
  for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) {
    const w = (r ? rem[0] : 255 - rem[0]) * (g ? rem[1] : 255 - rem[1]) * (b ? rem[2] : 255 - rem[2]);
    const values = point(name, (low[0] + r) / (gridSize - 1), (low[1] + g) / (gridSize - 1), (low[2] + b) / (gridSize - 1));
    for (let c = 0; c < 3; c++) result[c] += values[c] * w;
  }
  return result.map(value => Math.max(0, Math.min(255, Math.round(value / 65025))));
}

/** These clearly malformed/unsupported cases do not freeze optional BOM,
 * keyword-case, header-order or comment policy before the design does. */
export function malformedAuthoredCubes() {
  const original = authoredCube('identity').toString('utf8');
  const numeric = original.indexOf('\n0 0 0\n') + 1;
  const prefix = original.slice(0, numeric), rows = original.slice(numeric).trimEnd().split('\n');
  const compose = value => Buffer.from(prefix + value.join('\n') + '\n', 'utf8');
  const first = value => compose([value, ...rows.slice(1)]);
  return [
    ['missing-size', Buffer.from(original.replace('LUT_3D_SIZE 2\n', ''))],
    ['duplicate-size', Buffer.from(original.replace('LUT_3D_SIZE 2', 'LUT_3D_SIZE 2\nLUT_3D_SIZE 2'))],
    ['size-one', Buffer.from(original.replace('LUT_3D_SIZE 2', 'LUT_3D_SIZE 1'))],
    ['size-34', Buffer.from(original.replace('LUT_3D_SIZE 2', 'LUT_3D_SIZE 34'))],
    ['fractional-size', Buffer.from(original.replace('LUT_3D_SIZE 2', 'LUT_3D_SIZE 2.5'))],
    ['wrong-domain', Buffer.from(original.replace('DOMAIN_MAX 1 1 1', 'DOMAIN_MAX 2 1 1'))],
    ['domain-below-one-rounds-one', Buffer.from(original.replace('DOMAIN_MAX 1 1 1', 'DOMAIN_MAX .999999999999999999 1 1'))],
    ['domain-above-one-rounds-one', Buffer.from(original.replace('DOMAIN_MAX 1 1 1', 'DOMAIN_MAX 1.000000000000000001 1 1'))],
    ['domain-nonzero-underflow', Buffer.from(original.replace('DOMAIN_MIN 0 0 0', 'DOMAIN_MIN 1e-999 0 0'))],
    ['duplicate-domain', Buffer.from(original.replace('DOMAIN_MIN 0 0 0', 'DOMAIN_MIN 0 0 0\nDOMAIN_MIN 0 0 0'))],
    ['one-dimensional', Buffer.from(original.replace('LUT_3D_SIZE 2', 'LUT_1D_SIZE 2'))],
    ['combined-shaper', Buffer.from(original.replace('LUT_3D_SIZE 2', 'LUT_1D_SIZE 2\nLUT_3D_SIZE 2'))],
    ['missing-row', compose(rows.slice(1))], ['extra-row', compose([...rows, '0 0 0'])],
    ['two-components', first('0 0')], ['four-components', first('0 0 0 0')],
    ['nan', first('NaN 0 0')], ['infinity', first('Infinity 0 0')],
    ['negative', first('-0.01 0 0')], ['above-one', first('1.00001 0 0')],
    ['above-one-rounds-one', first('1.000000000000000001 0 0')],
    ['nonzero-underflow', first('1e-999 0 0')], ['negative-underflow', first('-1e-999 0 0')],
    ['hex', first('0x0 0 0')], ['incomplete-exponent', first('0e 0 0')],
    ['overflow-exponent', first('1e999 0 0')], ['token65', first(`0.${'0'.repeat(63)} 0 0`)],
    ['embedded-nul', first('0\0 0 0')],
    ['trailing-directive', Buffer.from(original + 'UNKNOWN_HEADER 1\n')],
    ['malformed-utf8', Buffer.concat([Buffer.from([0xc3, 0x28]), Buffer.from(original)])],
  ].map(([name, bytes]) => ({ name, bytes }));
}

export const cubeDigest = bytes => createHash('sha256').update(bytes).digest('hex');
