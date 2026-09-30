import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import { normalizeUnsharpParameters, compileUnsharpAmount, unsharpChannelByte } from './unsharp-mask.mjs';

export const SOURCE_SPATIAL_FILTER_KINDS = Object.freeze(['blur', 'sharpen', 'unsharp_mask', 'high_pass']);
export const SOURCE_SPATIAL_POLICY = 'alpha-weighted-gaussian-rgb-v1';
export const SOURCE_HIGH_PASS_POLICY = 'alpha-weighted-residual-128-v1';
export const MAX_SOURCE_FILTER_WORK = 384_000_000;
const Q = 65536;
const fail = (message, code = 'INVALID_ARGUMENT') => { throw Object.assign(new Error(message), { code }); };
function dimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 24_000_000)
    fail('Source spatial filters require dimensions up to 8192 per axis and 24 million pixels.', 'LIMIT_EXCEEDED');
  return width * height;
}
function sigma(value, maximum = 50) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum) fail(`Source Gaussian sigma must be between 0 and ${maximum} pixels.`);
  return value;
}

/** Allocation-free metadata admission, including computational identities.
 * Structural filter activity/protection remains the caller's enabled/opacity
 * rule, independent of value or a kernel that later quantizes to identity. */
export function sourceSpatialPlan(entry, width, height) {
  const sourcePixels = dimensions(width, height);
  if (!entry || !SOURCE_SPATIAL_FILTER_KINDS.includes(entry.kind)) fail('A supported source spatial filter is required.');
  const unsharp = entry.kind === 'unsharp_mask', parameters = unsharp ? normalizeUnsharpParameters(entry.parameters) : null;
  if (unsharp && entry.value !== 0) fail('Unsharp Mask uses value zero and its parameter settings.');
  const value = unsharp ? parameters.sigma : sigma(entry.value, entry.kind === 'sharpen' ? 10 : 50);
  const enabled = entry.enabled === undefined ? true : entry.enabled, opacity = entry.opacity === undefined ? 1 : entry.opacity;
  if (typeof enabled !== 'boolean' || typeof opacity !== 'number' || !Number.isFinite(opacity) || opacity < 0 || opacity > 1) fail('Invalid source spatial filter enabled or opacity setting.');
  const active = enabled && opacity > 0;
  const highPass = entry.kind === 'high_pass';
  if (highPass && entry.parameters !== undefined && (!entry.parameters || typeof entry.parameters !== 'object' || Array.isArray(entry.parameters) || Object.keys(entry.parameters).length))
    fail('High Pass is a scalar source filter and accepts no additional parameters.');
  const identity = !highPass && (value === 0 || unsharp && (parameters.amount === 0 || parameters.threshold === 255));
  const computesCandidate = active && !identity;
  const radius = Math.ceil(3 * value), taps = 2 * radius + 1, cacheRows = computesCandidate && value > 0 ? Math.min(height, taps) : 0;
  const cacheBytes = cacheRows ? 16 * width * cacheRows + 4 * cacheRows + 8 * taps : 0;
  const work = active ? sourcePixels * (identity || highPass && value === 0 ? 1 : 2 * taps + (unsharp ? 40 : 8)) : 0;
  return { radius, taps, cacheRows, cacheBytes, work, computesCandidate };
}

/** Symmetric, truncated integer Gaussian. Side coefficients use the authored
 * sigma directly; a tiny positive sigma can produce an identity kernel. */
export function compileSourceGaussian(value) {
  sigma(value);
  const radius = Math.ceil(3 * value), weights = new Uint32Array(2 * radius + 1);
  if (value === 0) { weights[0] = Q; return { radius, weights }; }
  // No exponent array is retained alongside the ring cache. Literal center1
  // avoids 0/0 for subnormal sigma; side underflow naturally becomes zero.
  let sideTotal = 0;
  for (let d = 1; d <= radius; d++) sideTotal += Math.exp(-(d * d) / (2 * value * value));
  const total = 1 + 2 * sideTotal;
  let sides = 0;
  for (let d = 1; d <= radius; d++) {
    const weight = Math.round(Q * Math.exp(-(d * d) / (2 * value * value)) / total);
    if (!Number.isInteger(weight) || weight < 0 || weight > Q) fail('Invalid compiled source Gaussian coefficient.');
    weights[radius - d] = weights[radius + d] = weight; sides += weight;
  }
  const center = Q - 2 * sides;
  if (!Number.isInteger(center) || center <= 0 || center > Q) fail('Invalid compiled source Gaussian center.');
  weights[radius] = center;
  return { radius, weights };
}

// After clamping, both numerator operands are exact integers below2^49.
// The closest noninteger quotient is >32 division-rounding errors from an
// integer boundary. This yields exact half-up bytes without epsilon/BigInt.
const ratioByte = (numerator, denominator) => numerator <= 0 ? 0 : numerator >= 255 * denominator ? 255 : Math.floor((2 * numerator + denominator) / (2 * denominator));
const edge = (position, length) => Math.max(0, Math.min(length - 1, position));

/** RGB-only candidate. The original source alpha and invisible RGB are exact.
 * Uint32 horizontal sums fit below2^32; vertical Number integers stay below
 * 2^48. Only the candidate escapes this scope; all ring/kernel references die
 * before geometry or the next filter. Global/brush/effect kernels are separate. */
export async function sourceSpatialCandidate(input, width, height, entry) {
  const plan = sourceSpatialPlan(entry, width, height);
  if (!Buffer.isBuffer(input) || input.length !== width * height * 4) fail('Source spatial RGBA must match its dimensions.');
  if (plan.work > MAX_SOURCE_FILTER_WORK) fail('Source spatial filters exceed the 384-million weighted source-pixel work budget. Reduce sigma or source dimensions.', 'LIMIT_EXCEEDED');
  if (!plan.computesCandidate) return input;
  // A zero-radius High Pass is a gray candidate, never an identity shortcut.
  // Copy alpha/hidden RGB and avoid constructing an unnecessary Gaussian ring.
  if (entry.kind === 'high_pass' && entry.value === 0) {
    const output = Buffer.from(input);
    for (let p = 0; p < width * height; p++) {
      const i = p * 4;
      if (input[i + 3]) output[i] = output[i + 1] = output[i + 2] = 128;
      if ((p + 1) % 65_536 === 0) await yieldEventLoop();
    }
    return output;
  }
  const parameters = entry.kind === 'unsharp_mask' ? normalizeUnsharpParameters(entry.parameters) : null;
  const amount = parameters ? compileUnsharpAmount(parameters.amount) : null;
  const { radius, weights } = compileSourceGaussian(parameters ? parameters.sigma : entry.value), span = weights.length, rows = plan.cacheRows, stride = width * 4;
  const cache = new Uint32Array(rows * stride), tags = new Int32Array(rows).fill(-1), bases = new Int32Array(span), output = Buffer.from(input);
  const tapBatch = span * Math.floor(65536 / span), sharpen = entry.kind === 'sharpen', highPass = entry.kind === 'high_pass';
  let visits = 0;
  for (let y = 0; y < height; y++) {
    for (let sy = Math.max(0, y - radius); sy <= Math.min(height - 1, y + radius); sy++) {
      const slot = sy % rows;
      if (tags[slot] === sy) continue;
      for (let x = 0; x < width; x++) {
        let red = 0, green = 0, blue = 0, alpha = 0;
        for (let k = 0; k < span; k++) {
          const index = (sy * width + edge(x + k - radius, width)) * 4, weight = input[index + 3] * weights[k];
          red += input[index] * weight; green += input[index + 1] * weight; blue += input[index + 2] * weight; alpha += weight;
        }
        const i = slot * stride + x * 4;
        cache[i] = red; cache[i + 1] = green; cache[i + 2] = blue; cache[i + 3] = alpha;
        visits += span;
        if (visits >= tapBatch) { visits = 0; await yieldEventLoop(); }
      }
      tags[slot] = sy;
    }
    for (let k = 0; k < span; k++) bases[k] = (edge(y + k - radius, height) % rows) * stride;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (input[i + 3]) {
        let red = 0, green = 0, blue = 0, alpha = 0;
        for (let k = 0; k < span; k++) {
          const j = bases[k] + x * 4, weight = weights[k];
          red += cache[j] * weight; green += cache[j + 1] * weight; blue += cache[j + 2] * weight; alpha += cache[j + 3] * weight;
        }
        if (amount) {
          output[i] = unsharpChannelByte(input[i], red, alpha, amount, parameters.threshold);
          output[i + 1] = unsharpChannelByte(input[i + 1], green, alpha, amount, parameters.threshold);
          output[i + 2] = unsharpChannelByte(input[i + 2], blue, alpha, amount, parameters.threshold);
        } else if (highPass) {
          // M=(128+C)D-N is exact below2^49; clamp and round only once.
          output[i] = ratioByte((128 + input[i]) * alpha - red, alpha);
          output[i + 1] = ratioByte((128 + input[i + 1]) * alpha - green, alpha);
          output[i + 2] = ratioByte((128 + input[i + 2]) * alpha - blue, alpha);
        } else {
          output[i] = ratioByte(sharpen ? 2 * input[i] * alpha - red : red, alpha);
          output[i + 1] = ratioByte(sharpen ? 2 * input[i + 1] * alpha - green : green, alpha);
          output[i + 2] = ratioByte(sharpen ? 2 * input[i + 2] * alpha - blue : blue, alpha);
        }
      }
      visits += span;
      if (visits >= tapBatch) { visits = 0; await yieldEventLoop(); }
    }
  }
  return output;
}
