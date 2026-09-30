import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import { compileSourceGaussian, MAX_SOURCE_FILTER_WORK } from './source-spatial-filters.mjs';

export const LOCAL_TONE_POLICY = 'alpha-weighted-local-tone-v1';
const Q = 65536;
const FIELDS = new Set(['shadows', 'highlights', 'shadowWidth', 'highlightWidth', 'sigma']);
const fail = (message, code = 'INVALID_ARGUMENT') => { throw Object.assign(new Error(message), { code }); };
function percentage(value, label, minimum = 0) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > 100 || Math.round(value * 100) / 100 !== value)
    fail(`Local Shadows / Highlights ${label} must be between ${minimum} and 100 percent in increments of 0.01 percent.`);
  return value === 0 ? 0 : value;
}

/** Complete source-only parameters. Metadata validation never compiles a
 * response table or Gaussian, including disabled and dual-zero entries. */
export function normalizeLocalToneParameters(parameters) {
  if (parameters === undefined) parameters = {};
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters) || ![Object.prototype, null].includes(Object.getPrototypeOf(parameters)))
    fail('Local Shadows / Highlights parameters must be a plain object.');
  for (const key of Reflect.ownKeys(parameters)) {
    const descriptor = Object.getOwnPropertyDescriptor(parameters, key);
    if (!FIELDS.has(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
      fail('Local Shadows / Highlights accepts only shadows, highlights, shadowWidth, highlightWidth and sigma data values.');
  }
  const shadows = percentage(parameters.shadows === undefined ? 25 : parameters.shadows, 'Shadows amount');
  const highlights = percentage(parameters.highlights === undefined ? 0 : parameters.highlights, 'Highlights amount');
  const shadowWidth = percentage(parameters.shadowWidth === undefined ? 50 : parameters.shadowWidth, 'Shadows tonal width', 1);
  const highlightWidth = percentage(parameters.highlightWidth === undefined ? 50 : parameters.highlightWidth, 'Highlights tonal width', 1);
  const sigma = parameters.sigma === undefined ? 3 : parameters.sigma;
  if (typeof sigma !== 'number' || !Number.isFinite(sigma) || sigma < 0 || sigma > 50)
    fail('Local Shadows / Highlights sigma must be between 0 and 50 source pixels.');
  return { shadows, highlights, shadowWidth, highlightWidth, sigma: sigma === 0 ? 0 : sigma };
}

/** No binary allocation. Table/row/ring cache is sequential with other source
 * candidates and deferred filter masks; it is not a persistent shared table. */
export function localTonePlan(entry, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 24_000_000)
    fail('Local Shadows / Highlights requires source dimensions up to 8192 per axis and 24 million pixels.', 'LIMIT_EXCEEDED');
  if (!entry || entry.kind !== 'shadows_highlights' || entry.value !== 0)
    fail('Local Shadows / Highlights uses value zero and its parameter settings.');
  const parameters = normalizeLocalToneParameters(entry.parameters);
  const enabled = entry.enabled === undefined ? true : entry.enabled, opacity = entry.opacity === undefined ? 1 : entry.opacity;
  if (typeof enabled !== 'boolean' || typeof opacity !== 'number' || !Number.isFinite(opacity) || opacity < 0 || opacity > 1)
    fail('Invalid Local Shadows / Highlights enabled or opacity setting.');
  const active = enabled && opacity > 0, computesCandidate = active && (parameters.shadows !== 0 || parameters.highlights !== 0);
  const radius = Math.ceil(3 * parameters.sigma), taps = 2 * radius + 1;
  const cacheRows = computesCandidate && parameters.sigma > 0 ? Math.min(height, taps) : 0;
  const cacheBytes = computesCandidate ? 2048 + (cacheRows ? 8 * width * cacheRows + 3 * width + 4 * cacheRows + 8 * taps : 0) : 0;
  const work = active ? width * height * (!computesCandidate ? 1 : parameters.sigma === 0 ? 16 : 2 * taps + 20) : 0;
  return { radius, taps, cacheRows, cacheBytes, work, computesCandidate };
}

function toneWeight(amount, width, level) {
  if (amount === 0) return 0;
  const amountUnits = BigInt(Math.round(amount * 100)), range = 255n * BigInt(Math.round(width * 100));
  const distance = range - 10000n * BigInt(level);
  if (distance <= 0n) return 0;
  const numerator = 65536n * amountUnits * distance * distance, denominator = 10000n * range * range;
  return Number((2n * numerator + denominator) / (2n * denominator));
}

/** One owned 2048-byte table; at most512 roughly72-bit exact calculations.
 * Zero-amount lanes remain exact zero. Setup yields every64 entries and is
 * separately bounded from source-pixel work, never repeated per output pixel. */
export async function compileLocalToneTables(parameters) {
  const p = normalizeLocalToneParameters(parameters), table = new Uint32Array(512);
  for (let i = 0; i < 512; i++) {
    table[i] = i < 256 ? toneWeight(p.shadows, p.shadowWidth, i) : toneWeight(p.highlights, p.highlightWidth, 511 - i);
    if ((i + 1) % 64 === 0) await yieldEventLoop();
  }
  return table;
}

const lumaByte = (r, g, b) => Math.floor((2126 * r + 7152 * g + 722 * b + 5000) / 10000);
const halfUp = (numerator, denominator) => Math.floor((2 * numerator + denominator) / (2 * denominator));
const edge = (position, length) => Math.max(0, Math.min(length - 1, position));

/** The positive denominator is <2^26 and doubled numerator is <2^35.
 * All operands are exact integers; floor-boundary separation exceeds the
 * binary64 division error by>500000x. Endpoints and equal gain are exact. */
export function localToneChannelByte(current, shadows, highlights) {
  const a = Q + 3 * shadows, b = Q + 3 * highlights;
  return halfUp(255 * a * current, b * (255 - current) + a * current);
}

/** Candidate RGB only: the complete preceding source and effective alpha
 * determine local tone before geometry or stack/layer masks. Only output
 * escapes; ring, prepared row and LUT die before the next caller phase. */
export async function localToneCandidate(input, width, height, entry) {
  const plan = localTonePlan(entry, width, height);
  if (!Buffer.isBuffer(input) || input.length !== width * height * 4) fail('Local Shadows / Highlights RGBA must match its source dimensions.');
  if (plan.work > MAX_SOURCE_FILTER_WORK) fail('Local Shadows / Highlights exceeds the 384-million weighted source-pixel work budget. Reduce sigma or source dimensions.', 'LIMIT_EXCEEDED');
  if (!plan.computesCandidate) return input;
  const parameters = normalizeLocalToneParameters(entry.parameters);
  const table = await compileLocalToneTables(parameters), output = Buffer.from(input);
  const write = (index, level) => {
    const shadows = table[level], highlights = table[256 + level];
    for (let channel = 0; channel < 3; channel++) output[index + channel] = localToneChannelByte(input[index + channel], shadows, highlights);
  };
  if (parameters.sigma === 0) {
    for (let p = 0; p < width * height; p++) {
      const i = p * 4;
      if (input[i + 3]) write(i, lumaByte(input[i], input[i + 1], input[i + 2]));
      if ((p + 1) % 65536 === 0) await yieldEventLoop();
    }
    return output;
  }
  const { radius, weights } = compileSourceGaussian(parameters.sigma), span = weights.length, rows = plan.cacheRows;
  const cache = new Uint32Array(2 * width * rows), tags = new Int32Array(rows).fill(-1), bases = new Int32Array(span);
  const rowLuma = new Uint16Array(width), rowAlpha = new Uint8Array(width);
  let visits = 0;
  for (let y = 0; y < height; y++) {
    for (let sy = Math.max(0, y - radius); sy <= Math.min(height - 1, y + radius); sy++) {
      const slot = sy % rows;
      if (tags[slot] === sy) continue;
      for (let x = 0; x < width; x++) {
        if (visits + 1 > 65536) { visits = 0; await yieldEventLoop(); } visits++;
        const i = 4 * (sy * width + x), alpha = input[i + 3];
        rowLuma[x] = lumaByte(input[i], input[i + 1], input[i + 2]) * alpha; rowAlpha[x] = alpha;
      }
      for (let x = 0; x < width; x++) {
        if (visits + span > 65536) { visits = 0; await yieldEventLoop(); } visits += span;
        let numerator = 0, denominator = 0;
        for (let k = 0; k < span; k++) {
          const sx = edge(x + k - radius, width), weight = weights[k];
          numerator += rowLuma[sx] * weight; denominator += rowAlpha[sx] * weight;
        }
        const i = 2 * (slot * width + x); cache[i] = numerator; cache[i + 1] = denominator;
      }
      tags[slot] = sy;
    }
    if (visits + span > 65536) { visits = 0; await yieldEventLoop(); } visits += span;
    for (let k = 0; k < span; k++) bases[k] = 2 * width * (edge(y + k - radius, height) % rows);
    for (let x = 0; x < width; x++) {
      if (visits + span > 65536) { visits = 0; await yieldEventLoop(); } visits += span;
      const i = 4 * (y * width + x);
      if (!input[i + 3]) continue;
      let numerator = 0, denominator = 0;
      for (let k = 0; k < span; k++) {
        const j = bases[k] + 2 * x, weight = weights[k];
        numerator += cache[j] * weight; denominator += cache[j + 1] * weight;
      }
      // Gaussian N<2^48,D<2^40; exact local-byte half-up, then LUT and
      // one final RGB ratio. Never substitute a rounded RGB blur candidate.
      write(i, halfUp(numerator, denominator));
    }
  }
  return output;
}
