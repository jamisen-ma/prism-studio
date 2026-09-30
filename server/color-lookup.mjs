// Native bounded .cube subset and fixed binary64 RGB8 trilinear policy.
// Format reference: OpenColorIO Iridas Cube documentation; no implementation copied.
import { setImmediate as yieldNow } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { COLOR_LOOKUP_LIMITS, normalizeColorLookupParameters } from '../shared/color-lookup.mjs';
const MAX_BYTES = COLOR_LOOKUP_LIMITS.maxBytes;
const decimal = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const fail = (message, code = 'INVALID_ARGUMENT') => { throw Object.assign(new Error(message), { code }); };
const check = (condition, message, code) => { if (!condition) fail(message, code); };
function numeric(token, exactDomain) {
  check(token.length <= 64 && decimal.test(token), 'Expected a bounded decimal number.');
  const negative = token[0] === '-', unsigned = /^[+-]/.test(token) ? token.slice(1) : token;
  const [mantissa, exponent = '0'] = unsigned.split(/[eE]/), point = mantissa.indexOf('.');
  const digits = mantissa.replace('.', ''), leading = digits.search(/[1-9]/);
  const zero = leading === -1;
  const significant = zero ? '' : digits.slice(leading);
  const order = (point === -1 ? mantissa.length : point) + Number(exponent) - (zero ? 0 : leading);
  const one = !zero && order === 1 && /^10*$/.test(significant);
  check(zero || (!negative && (order <= 0 || one)), 'Authored cube values must be between zero and one.');
  if (exactDomain !== undefined) check(exactDomain === 0 ? zero : one, 'Only the exact zero-to-one input domain is supported.');
  const n = Number(token);
  check(Number.isFinite(n) && n >= 0 && n <= 1, 'Cube values must be finite and between zero and one.');
  check(n !== 0 || zero, 'Nonzero cube values may not underflow to zero.');
  return n === 0 ? 0 : n;
}
async function parseCubeTable(bytes, { yieldFn = yieldNow, expected } = {}) {
  check(bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= MAX_BYTES, 'Cube file exceeds its byte limit.', 'LIMIT_EXCEEDED');
  if (expected) check(bytes.byteLength === expected.bytes, 'Cube byte length does not match its descriptor.');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail('Cube file must be valid UTF-8.'); }
  let start = text.charCodeAt(0) === 0xfeff ? 1 : 0, lineNumber = 0, visited = 0, rows = 0;
  let gridSize, title, table;
  const seen = new Set();
  while (start < text.length) {
    const newline = text.indexOf('\n', start), end = newline === -1 ? text.length : newline;
    let line = text.slice(start, end);
    const length = end - start + (newline === -1 ? 0 : 1);
    start = newline === -1 ? text.length : end + 1; lineNumber++;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    check(line.length <= 4096, `Cube line ${lineNumber} exceeds the line limit.`, 'LIMIT_EXCEEDED');
    if (visited + length > 65536) { await yieldFn(); visited = 0; }
    visited += length;
    check(!/[\u0000-\u0008\u000b-\u001f\u007f\ufeff]/.test(line), `Cube line ${lineNumber} contains unsupported controls.`);
    line = line.replace(/^[ \t]+|[ \t]+$/g, '');
    if (!line || line.startsWith('#')) continue;
    if (/^TITLE(?:[ \t]|$)/i.test(line)) {
      check(rows === 0 && !seen.has('TITLE'), 'Duplicate or late TITLE.');
      const match = /^TITLE[ \t]+"([^"\\]*)"[ \t]*(?:#.*)?$/i.exec(line);
      check(match && match[1].length <= 200 && !/[\u0000-\u001f\u007f]/.test(match[1]), 'Invalid TITLE.');
      // Force independent bounded storage: a regex substring may retain text.
      title = String.fromCharCode(...Array.from({ length: match[1].length }, (_, i) => match[1].charCodeAt(i)));
      seen.add('TITLE'); continue;
    }
    const comment = line.indexOf('#');
    if (comment !== -1) line = line.slice(0, comment).replace(/[ \t]+$/g, '');
    const parts = line.split(/[ \t]+/, 5), key = parts[0].toUpperCase();
    if (['LUT_3D_SIZE', 'DOMAIN_MIN', 'DOMAIN_MAX'].includes(key)) {
      check(rows === 0 && !seen.has(key), 'Duplicate or late cube header.'); seen.add(key);
      if (key === 'LUT_3D_SIZE') {
        check(parts.length === 2 && /^(?:[2-9]|[12]\d|3[0-3])$/.test(parts[1]), 'Cube grid size must be an integer from 2 to 33.');
        gridSize = Number(parts[1]);
        if (expected) check(gridSize === expected.gridSize, 'Cube grid does not match its descriptor.');
        table = new Float64Array(3 * gridSize ** 3);
      } else {
        check(parts.length === 4, 'A domain header needs three numbers.');
        const expected = key === 'DOMAIN_MIN' ? 0 : 1;
        for (let c = 1; c < 4; c++) numeric(parts[c], expected);
      }
      continue;
    }
    check(table && parts.length === 3, 'Expected a three-channel cube row after LUT_3D_SIZE.');
    check(rows < gridSize ** 3, 'Cube has too many data rows.');
    for (let c = 0; c < 3; c++) table[3 * rows + c] = numeric(parts[c]);
    rows++;
  }
  check(table && rows === gridSize ** 3, 'Cube row count does not match its grid.');
  if (expected) check(title === expected.title, 'Cube title does not match its descriptor.');
  return { gridSize, ...(title === undefined ? {} : { title }), table };
}
function compileCube(parsed) {
  const n = parsed.gridSize, table = parsed.table;
  const axis = new Uint8Array(512), greenStride = 3 * n, blueStride = 3 * n * n;
  for (let c = 0; c < 256; c++) {
    const p = c * (n - 1), lo = Math.min(n - 2, Math.floor(p / 255));
    axis[c] = lo; axis[256 + c] = p - 255 * lo;
  }
  return function transform(r, g, b, out = [0, 0, 0]) {
    const rf = axis[256 + r], gf = axis[256 + g], bf = axis[256 + b];
    const rl = 255 - rf, gl = 255 - gf, bl = 255 - bf;
    const a = 3 * axis[r] + greenStride * axis[g] + blueStride * axis[b];
    const w0 = rl * gl * bl, w1 = rf * gl * bl, w2 = rl * gf * bl, w3 = rf * gf * bl;
    const w4 = rl * gl * bf, w5 = rf * gl * bf, w6 = rl * gf * bf, w7 = rf * gf * bf;
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      sum += table[a + c] * w0;
      sum += table[a + 3 + c] * w1;
      sum += table[a + greenStride + c] * w2;
      sum += table[a + greenStride + 3 + c] * w3;
      sum += table[a + blueStride + c] * w4;
      sum += table[a + blueStride + 3 + c] * w5;
      sum += table[a + blueStride + greenStride + c] * w6;
      sum += table[a + blueStride + greenStride + 3 + c] * w7;
      out[c] = Math.max(0, Math.min(255, Math.round(sum / 65025)));
    }
    return out;
  };
}
/** Return only bounded metadata and a private transform, never a table view. */
export async function parseColorLookupBytes(bytes, options) {
  let expected;
  if (options?.expected !== undefined) {
    const supplied = options.expected;
    check(supplied && typeof supplied === 'object' && !Array.isArray(supplied) && [Object.prototype, null].includes(Object.getPrototypeOf(supplied)), 'Expected cube metadata must be a plain object.');
    expected = {};
    for (const key of Reflect.ownKeys(supplied)) {
      const property = Object.getOwnPropertyDescriptor(supplied, key);
      check(['bytes', 'gridSize', 'title'].includes(key) && property.enumerable && Object.hasOwn(property, 'value'), 'Unsupported expected cube metadata.');
      expected[key] = property.value;
    }
    const checked = normalizeColorLookupParameters({ asset: '0'.repeat(64), sourceName: 'expected.cube', inputSpace: 'srgb', ...expected });
    expected = { bytes: checked.bytes, gridSize: checked.gridSize, ...(checked.title === undefined ? {} : { title: checked.title }) };
  }
  const parsed = await parseCubeTable(bytes, { ...options, expected });
  return { gridSize: parsed.gridSize, ...(parsed.title === undefined ? {} : { title: parsed.title }), transform: compileCube(parsed) };
}
export async function validateColorLookupBytes(bytes, parameters) {
  const expected = normalizeColorLookupParameters(parameters);
  check(bytes instanceof Uint8Array && bytes.byteLength === expected.bytes, 'Color Lookup byte length does not match its descriptor.', 'INVALID_PROJECT_BUNDLE');
  check(createHash('sha256').update(bytes).digest('hex') === expected.asset, 'Color Lookup bytes do not match their immutable identifier.', 'INVALID_PROJECT_BUNDLE');
  let parsed;
  try { parsed = await parseCubeTable(bytes, { expected }); }
  catch (cause) { if (cause.code === 'LIMIT_EXCEEDED') throw cause; fail('A Color Lookup asset does not match its declared format or metadata.', 'INVALID_PROJECT_BUNDLE'); }
  return { gridSize: parsed.gridSize, ...(parsed.title === undefined ? {} : { title: parsed.title }) };
}
/** Reader and parser activations finish before only the pixel closure escapes. */
export async function prepareColorLookup(parameters, readAsset) {
  const expected = normalizeColorLookupParameters(parameters);
  check(typeof readAsset === 'function', 'Color Lookup requires a verified asset reader.');
  const bytes = await readAsset(expected.asset, { maxBytes: expected.bytes });
  check(bytes instanceof Uint8Array && bytes.byteLength === expected.bytes && createHash('sha256').update(bytes).digest('hex') === expected.asset,
    'Color Lookup asset no longer matches its descriptor.', 'INVALID_PROJECT_BUNDLE');
  let parsed;
  try { parsed = await parseCubeTable(bytes, { expected }); }
  catch (cause) { if (cause.code === 'LIMIT_EXCEEDED') throw cause; fail('A Color Lookup asset does not match its declared format or metadata.', 'INVALID_PROJECT_BUNDLE'); }
  return compileCube(parsed);
}
export function colorLookupCacheBytes(parameters) {
  const p = normalizeColorLookupParameters(parameters);
  return 3 * p.bytes + 24 * p.gridSize ** 3 + 65536;
}
export function colorLookupGlobalPhaseBytes(parameters, pixels) {
  const p = normalizeColorLookupParameters(parameters);
  return Math.max(colorLookupCacheBytes(p), 4 * pixels + 24 * p.gridSize ** 3 + 512);
}
export function validateColorLookupPreparation(entries) {
  let bytes = 0;
  for (const entry of entries) if (entry.kind === 'color_lookup' && entry.enabled !== false && entry.opacity > 0) bytes += normalizeColorLookupParameters(entry.parameters).bytes;
  check(bytes <= COLOR_LOOKUP_LIMITS.maxPrepareBytes, 'Color Lookup preparation exceeds 32 MiB per graph pass. Reduce active lookup entries.', 'LIMIT_EXCEEDED');
  return bytes;
}
