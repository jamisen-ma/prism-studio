import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import { gaussianNoiseDeviate, GAUSSIAN_NOISE_TABLE_BYTES } from './noise-table.mjs';

export const SOURCE_NOISE_POLICY = 'seeded-rgb-discrete-v1';
const FIELDS = new Set(['amount', 'distribution', 'monochromatic', 'seed']);
const fail = (message, code = 'INVALID_ARGUMENT') => { throw Object.assign(new Error(message), { code }); };

export function normalizeNoiseParameters(parameters) {
  if (parameters === undefined) parameters = {};
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters) || !Object.keys(parameters).every(key => FIELDS.has(key)))
    fail('Add Noise parameters accept only amount, distribution, monochromatic and seed.');
  const { amount = 5, distribution = 'uniform', monochromatic = true, seed = 1 } = parameters;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > 400 || Math.round(amount * 100) / 100 !== amount)
    fail('Add Noise amount must be between 0 and 400 percent in increments of 0.01 percent.');
  if (!['uniform', 'gaussian'].includes(distribution)) fail('Add Noise distribution must be uniform or gaussian.');
  if (typeof monochromatic !== 'boolean') fail('Add Noise monochromatic must be boolean.');
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) fail('Add Noise seed must be an unsigned 32-bit integer.');
  return { amount, distribution, monochromatic, seed };
}

// lowbias32 permutation, Hash Function Prospector (UNLICENSE):
// https://github.com/skeeto/hash-prospector . Seed/counter mapping is native.
export function noiseHash32(value) {
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d) >>> 0;
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b) >>> 0;
  return (value ^ (value >>> 16)) >>> 0;
}
export function compileNoiseParameters(parameters) {
  const result = normalizeNoiseParameters(parameters);
  return { ...result, seedKey: noiseHash32((result.seed + 0x9e3779b9) >>> 0), factor: 255 * Math.round(result.amount * 100),
    denominator: (result.distribution === 'uniform' ? 65536 : 8192) * 10000 };
}
export function sourceNoiseSample(counter, compiled) {
  const word = noiseHash32((Math.imul(counter, 0x9e3779b9) ^ compiled.seedKey) >>> 0);
  return compiled.distribution === 'uniform' ? 2 * (word >>> 16) + 1 - 65536 : gaussianNoiseDeviate(word >>> 20);
}
export function sourceNoiseByte(current, deviate, compiled) {
  const numerator = current * compiled.denominator + deviate * compiled.factor;
  // All signed products/sums fit below2^40. After clamp the floor-boundary
  // separation exceeds binary64 division error by>32768x. No epsilon needed.
  return numerator <= 0 ? 0 : numerator >= 255 * compiled.denominator ? 255
    : Math.floor((2 * numerator + compiled.denominator) / (2 * compiled.denominator));
}

/** Metadata-only admission never compiles samples or initializes the table. */
export function sourceNoisePlan(entry, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 24_000_000)
    fail('Source noise requires dimensions up to 8192 per axis and 24 million pixels.', 'LIMIT_EXCEEDED');
  if (!entry || entry.kind !== 'add_noise' || entry.value !== 0) fail('Add Noise uses value zero and its parameter settings.');
  const parameters = normalizeNoiseParameters(entry.parameters), enabled = entry.enabled === undefined ? true : entry.enabled, opacity = entry.opacity === undefined ? 1 : entry.opacity;
  if (typeof enabled !== 'boolean' || typeof opacity !== 'number' || !Number.isFinite(opacity) || opacity < 0 || opacity > 1) fail('Invalid Add Noise enabled or opacity setting.');
  const active = enabled && opacity > 0, computesCandidate = active && parameters.amount > 0;
  return { work: active ? width * height * (computesCandidate ? 8 : 1) : 0, computesCandidate,
    sharedBytes: computesCandidate && parameters.distribution === 'gaussian' ? GAUSSIAN_NOISE_TABLE_BYTES : 0 };
}

/** One private candidate and a shared immutable table; no random field/state.
 * Original alpha and invisible RGB are copied exactly. Counter lookup is
 * independent of alpha skips, IDs, RGB and processing order. */
export async function sourceNoiseCandidate(input, width, height, entry) {
  const plan = sourceNoisePlan(entry, width, height);
  if (!Buffer.isBuffer(input) || input.length !== width * height * 4) fail('Source noise RGBA must match its dimensions.');
  if (!plan.computesCandidate) return input;
  const compiled = compileNoiseParameters(entry.parameters), output = Buffer.from(input), pixels = width * height;
  for (let p = 0; p < pixels; p++) {
    const i = p * 4;
    if (input[i + 3]) {
      const first = sourceNoiseSample(p * 3, compiled);
      output[i] = sourceNoiseByte(input[i], first, compiled);
      output[i + 1] = sourceNoiseByte(input[i + 1], compiled.monochromatic ? first : sourceNoiseSample(p * 3 + 1, compiled), compiled);
      output[i + 2] = sourceNoiseByte(input[i + 2], compiled.monochromatic ? first : sourceNoiseSample(p * 3 + 2, compiled), compiled);
    }
    if ((p + 1) % 65536 === 0) await yieldEventLoop();
  }
  return output;
}
