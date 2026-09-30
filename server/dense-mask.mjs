import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import { DENSE_MASK_POLICY, DENSE_MASK_LIMITS, normalizeDenseMaskDescriptor } from '../shared/dense-mask.mjs';
import { normalizeMask, maskCoverage } from './masks.mjs';
import { validateAdditionalLayerMask } from './layer-mask.mjs';
export { DENSE_MASK_POLICY, DENSE_MASK_LIMITS, normalizeDenseMaskDescriptor };
const MAGIC = Buffer.from('PRISMA8\0', 'ascii');
const fail = (message, code = 'INVALID_ARGUMENT') => { throw Object.assign(new Error(message), { code }); };
const quantize = value => Math.max(0, Math.min(255, Math.round(value * 255)));
const preparationScope = new AsyncLocalStorage();
/** Metadata admission remains primary. Nested consumers share this private
 * invariant counter; independent transaction steps start separate scopes. */
export function withMaskPreparationBudget(enabled, operation) {
  if (!enabled || preparationScope.getStore()) return operation();
  return preparationScope.run({ work: 0 }, operation);
}
export function chargeMaskPreparation(mask) {
  const scope = preparationScope.getStore();
  if (!scope) return;
  scope.work += maskPreparationWork(mask);
  if (scope.work > DENSE_MASK_LIMITS.maxPrepareWork) fail('Mask preparation exceeded its admitted operation budget.', 'LIMIT_EXCEEDED');
}
export const isByteMask = mask => mask?.shape === 'bitmap' || mask?.shape === 'alpha8';
export const maskSource = mask => mask?.shape === 'positioned' ? mask.source : mask;
export const isDenseMask = mask => maskSource(mask)?.shape === 'alpha8';
function checkedShape(mask) {
  if (mask && typeof mask === 'object' && ![Object.prototype, null].includes(Object.getPrototypeOf(mask))) fail('Prepared masks require a plain object.');
  const property = mask && Object.getOwnPropertyDescriptor(mask, 'shape');
  if (property && !Object.hasOwn(property, 'value')) fail('Mask shape must be an ordinary data property.');
  return property?.value;
}
function checkedMaskSource(mask) { return checkedShape(mask) === 'positioned' ? mask.source : mask; }
export function maskBufferBytes(mask, { feather = true } = {}) {
  const source = maskSource(mask);
  if (!isByteMask(source)) return 0;
  const n = source.width * source.height;
  return n + (source.shape === 'alpha8' ? 32 : 0) + (feather && source.feather > 0 ? 4 * n : 0);
}
export function maskPreparationWork(mask) {
  const source = maskSource(mask);
  return isByteMask(source) ? source.width * source.height * (source.feather > 0 ? 8 : 1) : 0;
}
function pixels(width, height) {
  if (![width, height].every(v => Number.isInteger(v) && v >= 1 && v <= 8192) || width * height > 24_000_000) fail('Invalid alpha8 dimensions.');
  return width * height;
}
export async function hashDenseMaskBytes(bytes) {
  const hash = createHash('sha256');
  for (let start = 0; start < bytes.length; start += 65536) { hash.update(bytes.subarray(start, start + 65536)); await yieldEventLoop(); }
  return hash.digest('hex');
}
/** Input is an operation-owned alpha plane. It remains live through framing;
 * native publication additionally reserves a possible existing dedup frame. */
export async function encodeDenseMaskFrame(alpha, width, height) {
  const n = pixels(width, height);
  if (!(alpha instanceof Uint8Array) || alpha.length !== n) fail('Alpha8 plane must match its dimensions.');
  const frame = Buffer.alloc(n + 32);
  MAGIC.copy(frame); frame.writeUInt32BE(1, 8); frame.writeUInt32BE(width, 12); frame.writeUInt32BE(height, 16); frame.writeUInt32BE(n, 20);
  for (let start = 0; start < n; start += 65536) { frame.set(alpha.subarray(start, start + 65536), 32 + start); await yieldEventLoop(); }
  const asset = await hashDenseMaskBytes(frame);
  return { frame, descriptor: normalizeDenseMaskDescriptor({ shape: 'alpha8', asset, bytes: frame.length, width, height }) };
}
export async function validateDenseMaskFrame(frame, input, { verifiedHash = false } = {}) {
  const descriptor = normalizeDenseMaskDescriptor(input, { persisted: true });
  if (!Buffer.isBuffer(frame) || frame.length !== descriptor.bytes || !frame.subarray(0, 8).equals(MAGIC)
    || frame.readUInt32BE(8) !== 1 || frame.readUInt32BE(12) !== descriptor.width || frame.readUInt32BE(16) !== descriptor.height
    || frame.readUInt32BE(20) !== descriptor.width * descriptor.height || frame.readUInt32BE(24) !== 0 || frame.readUInt32BE(28) !== 0)
    fail('The alpha8 frame does not match its immutable metadata.', 'CORRUPT_ASSET');
  if (!verifiedHash && await hashDenseMaskBytes(frame) !== descriptor.asset) fail('The alpha8 frame digest is invalid.', 'CORRUPT_ASSET');
  return descriptor;
}
/** Resolver must return a new private buffer. Only its verified payload may
 * be feathered in place; no shared cache, public plane or graph mutation. */
export async function prepareMaskCoverage(input, resolveOwnedAlpha8) {
  if (!input) return () => 1;
  const mask = checkedShape(input) === 'alpha8'
    ? normalizeDenseMaskDescriptor(input, { persisted: true })
    : normalizeMask(input, input.width ?? 8192, input.height ?? 8192, { persisted: true });
  if (!isByteMask(mask)) return maskCoverage(mask);
  if (mask.clip) {
    const { clip, ...source } = mask, coverage = await prepareMaskCoverage(source, resolveOwnedAlpha8);
    return (x, y) => x + .5 >= clip.x && y + .5 >= clip.y && x + .5 < clip.x + clip.width && y + .5 < clip.y + clip.height ? coverage(x, y) : 0;
  }
  chargeMaskPreparation(mask);
  let bytes;
  if (mask.shape === 'alpha8') {
    if (typeof resolveOwnedAlpha8 !== 'function') fail('Alpha8 coverage requires a verified asset resolver.');
    const frame = await resolveOwnedAlpha8(mask);
    await validateDenseMaskFrame(frame, mask);
    bytes = frame.subarray(32);
  } else {
    bytes = Buffer.alloc(pixels(mask.width, mask.height));
    let visits = 0;
    for (let r = 0; r < mask.runs.length; r += 3) {
      for (let i = mask.runs[r], end = i + mask.runs[r + 1]; i < end; i++) {
        bytes[i] = mask.runs[r + 2];
        if (++visits === 65536) { visits = 0; await yieldEventLoop(); }
      }
    }
  }
  await featherOwned(bytes, mask, yieldEventLoop);
  const { width, height, invert } = mask;
  return (x, y) => { x = Math.floor(x); y = Math.floor(y); const value = x >= 0 && y >= 0 && x < width && y < height ? bytes[y * width + x] / 255 : 0; return invert ? 1 - value : value; };
}
async function featherOwned(bytes, { width, height, feather }, yieldFn) {
  if (feather === 0) return;
  const distance = new Float32Array(bytes.length), maximum = feather + 2;
  let visits = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    distance[i] = !bytes[i] ? 0 : (x === 0 || y === 0 || x === width - 1 || y === height - 1 ? 0.5 : maximum);
    if (++visits === 65_536) { visits = 0; await yieldFn(); }
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    if (x) distance[i] = Math.min(distance[i], distance[i - 1] + 1);
    if (y) distance[i] = Math.min(distance[i], distance[i - width] + 1);
    if (x && y) distance[i] = Math.min(distance[i], distance[i - width - 1] + Math.SQRT2);
    if (x < width - 1 && y) distance[i] = Math.min(distance[i], distance[i - width + 1] + Math.SQRT2);
    if (++visits === 65_536) { visits = 0; await yieldFn(); }
  }
  for (let y = height - 1; y >= 0; y--) for (let x = width - 1; x >= 0; x--) {
    const i = y * width + x;
    if (x < width - 1) distance[i] = Math.min(distance[i], distance[i + 1] + 1);
    if (y < height - 1) distance[i] = Math.min(distance[i], distance[i + width] + 1);
    if (x < width - 1 && y < height - 1) distance[i] = Math.min(distance[i], distance[i + width + 1] + Math.SQRT2);
    if (x && y < height - 1) distance[i] = Math.min(distance[i], distance[i + width - 1] + Math.SQRT2);
    if (++visits === 65_536) { visits = 0; await yieldFn(); }
  }
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Math.round(bytes[i] * Math.min(1, distance[i] / feather));
    if (++visits === 65_536) { visits = 0; await yieldFn(); }
  }
}

export async function prepareRawLayerMaskCoverage(layer, resolver) {
  if (!layer?.mask) return () => 1;
  const inputSource = checkedMaskSource(layer.mask), source = checkedShape(inputSource) === 'alpha8' ? normalizeDenseMaskDescriptor(inputSource, { persisted: true }) : inputSource;
  validateAdditionalLayerMask(layer, source.width ?? 8192, source.height ?? 8192);
  const mask = structuredClone(layer.mask);
  if (mask.shape !== 'positioned') return prepareMaskCoverage(mask, resolver);
  const { x: offsetX, y: offsetY, domain } = mask;
  const coverage = await prepareMaskCoverage(mask.source, resolver);
  return (x, y) => { const u = x - offsetX, v = y - offsetY;
    return domain && !(u + .5 >= domain.x && v + .5 >= domain.y && u + .5 < domain.x + domain.width && v + .5 < domain.y + domain.height) ? 0 : coverage(u, v); };
}
export async function prepareLayerMaskCoverage(layer, resolver) {
  const inputSource = checkedMaskSource(layer?.mask), source = checkedShape(inputSource) === 'alpha8' ? normalizeDenseMaskDescriptor(inputSource, { persisted: true }) : inputSource, density = layer?.maskDensity ?? 1;
  if (layer?.mask) validateAdditionalLayerMask(layer, source.width ?? 8192, source.height ?? 8192);
  if (!layer?.mask || density === 0) return () => 1;
  const byteMask = isByteMask(source);
  const coverage = await prepareRawLayerMaskCoverage(layer, resolver);
  if (density === 1) return coverage;
  return (x, y) => { const value = coverage(x, y) * 255, byte = byteMask ? Math.round(value) : value;
    return (255 - density * (255 - byte)) / 255; };
}
export async function materializeMaskAlpha(mask, width, height, resolver, { layer, raw = true } = {}) {
  const coverage = layer ? await (raw ? prepareRawLayerMaskCoverage(layer, resolver) : prepareLayerMaskCoverage(layer, resolver)) : await prepareMaskCoverage(mask, resolver);
  const output = Buffer.allocUnsafe(pixels(width, height));
  for (let i = 0; i < output.length; i++) { output[i] = quantize(coverage(i % width, Math.floor(i / width))); if ((i + 1) % 65536 === 0) await yieldEventLoop(); }
  return output;
}
/** Returns metadata or owned frame; never publishes an asset. */
export async function encodeMaskAlpha(alpha, width, height) {
  const n = pixels(width, height);
  if (!(alpha instanceof Uint8Array) || alpha.length !== n) fail('Mask alpha must match its dimensions.');
  let previous = 0, count = 0;
  for (let i = 0; i < n; i++) { const value = alpha[i]; if (value !== previous) { if (value) count++; previous = value; } if ((i + 1) % 65536 === 0) await yieldEventLoop(); }
  if (count > 200000) return encodeDenseMaskFrame(alpha, width, height);
  const runs = []; let start = 0, value = 0;
  const flush = end => { if (value) runs.push(start, end - start, value); };
  for (let i = 0; i < n; i++) { if (alpha[i] !== value) { flush(i); start = i; value = alpha[i]; } if ((i + 1) % 65536 === 0) await yieldEventLoop(); }
  flush(n);
  return { descriptor: { shape: 'bitmap', x: 0, y: 0, width, height, runs, feather: 0, invert: false } };
}
export async function combineMaskAlpha(active, candidate, width, height, mode, resolver) {
  if (!['replace', 'add', 'subtract', 'intersect'].includes(mode)) fail('Invalid selection combination mode.');
  if (!active && ['subtract', 'intersect'].includes(mode)) fail('Create an active selection before combining.', 'NO_SELECTION');
  if (candidate.length !== pixels(width, height)) fail('Invalid selection plane.');
  if (mode === 'replace' || !active) return candidate;
  const coverage = await prepareMaskCoverage(active, resolver), output = Buffer.allocUnsafe(candidate.length);
  for (let i = 0; i < output.length; i++) { const left = coverage(i % width, Math.floor(i / width)), right = candidate[i] / 255;
    output[i] = quantize(mode === 'add' ? Math.max(left, right) : mode === 'subtract' ? left * (1 - right) : left * right);
    if ((i + 1) % 65536 === 0) await yieldEventLoop(); }
  return output;
}
