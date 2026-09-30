// Independently authored maintained reference; no runtime/prototype imports.
// Channels produce alpha8 selection coverage, not unassociated intensity.
import { createHash } from 'node:crypto';
export const CHANNELS = Object.freeze(['red', 'green', 'blue', 'luma', 'alpha']);
const halfUp = (n, d) => Number((2n * BigInt(n) + BigInt(d)) / (2n * BigInt(d)));
export function channelCoverageReference(rgba, channel, { invert = false } = {}) {
  if (!Array.isArray(rgba) || rgba.length !== 4 || !rgba.every(value => Number.isInteger(value) && value >= 0 && value <= 255) || !CHANNELS.includes(channel) || typeof invert !== 'boolean') throw Error('Invalid channel fixture input');
  const [r, g, b, alpha] = rgba;
  let coverage;
  if (channel === 'alpha') coverage = alpha;
  else {
    const value = channel === 'luma' ? halfUp(2126n * BigInt(r) + 7152n * BigInt(g) + 722n * BigInt(b), 10000n) : rgba[CHANNELS.indexOf(channel)];
    coverage = halfUp(BigInt(value) * BigInt(alpha), 255n);
  }
  return invert ? 255 - coverage : coverage;
}

// Expected columns are Red, Green, Blue, encoded luma, Alpha respectively.
// Every number is literal. The luma double-round discriminator is intentional.
export const CHANNEL_GOLDENS = Object.freeze([
  { rgba: [255, 0, 0, 0], expected: [0, 0, 0, 0, 0] },
  { rgba: [255, 0, 0, 1], expected: [1, 0, 0, 0, 1] },
  { rgba: [255, 0, 0, 128], expected: [128, 0, 0, 27, 128] },
  { rgba: [255, 0, 0, 255], expected: [255, 0, 0, 54, 255] },
  { rgba: [0, 255, 0, 0], expected: [0, 0, 0, 0, 0] },
  { rgba: [0, 255, 0, 1], expected: [0, 1, 0, 1, 1] },
  { rgba: [0, 255, 0, 128], expected: [0, 128, 0, 91, 128] },
  { rgba: [0, 255, 0, 255], expected: [0, 255, 0, 182, 255] },
  { rgba: [0, 0, 255, 0], expected: [0, 0, 0, 0, 0] },
  { rgba: [0, 0, 255, 1], expected: [0, 0, 1, 0, 1] },
  { rgba: [0, 0, 255, 128], expected: [0, 0, 128, 9, 128] },
  { rgba: [0, 0, 255, 255], expected: [0, 0, 255, 18, 255] },
  { rgba: [128, 128, 128, 0], expected: [0, 0, 0, 0, 0] },
  { rgba: [128, 128, 128, 1], expected: [1, 1, 1, 1, 1] },
  { rgba: [128, 128, 128, 128], expected: [64, 64, 64, 64, 128] },
  { rgba: [128, 128, 128, 255], expected: [128, 128, 128, 128, 255] },
  { rgba: [255, 255, 255, 1], expected: [1, 1, 1, 1, 1] },
  { rgba: [13, 127, 253, 128], expected: [7, 64, 127, 56, 128] },
  { rgba: [14, 1, 122, 128], expected: [7, 1, 61, 7, 128] },
  { rgba: [14, 1, 122, 255], expected: [14, 1, 122, 13, 255] },
]);

export function channelPlaneReference(pixels, channel, options = {}) {
  const output = Buffer.alloc(pixels.length / 4);
  for (let i = 0; i < output.length; i++) output[i] = channelCoverageReference([...pixels.subarray(4 * i, 4 * i + 4)], channel, options);
  return output;
}

export function authoredFrame(alpha, width, height, extra = {}) {
  if (alpha.length !== width * height) throw Error('Authored frame dimensions do not match coverage.');
  const bytes = Buffer.alloc(32 + alpha.length);
  bytes.set([80, 82, 73, 83, 77, 65, 56, 0]);
  for (const [offset, value] of [[8, 1], [12, width], [16, height], [20, alpha.length], [24, 0], [28, 0]]) bytes.writeUInt32BE(value, offset);
  bytes.set(alpha, 32);
  return { bytes, descriptor: { shape: 'alpha8', asset: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, width, height, x: 0, y: 0, feather: 0, invert: false, ...extra } };
}

export function highFrequencyRGBA(width, height) {
  const pixels = Buffer.alloc(4 * width * height);
  for (let p = 0; p < width * height; p++) {
    const x = p % width, y = Math.floor(p / width);
    pixels.set([(x * 73 + y * 151 + 17) & 255, (x * 149 + y * 29 + 61) & 255, (x * 199 + y * 37 + 127) & 255, [0, 1, 128, 255][(x + 3 * y) & 3]], 4 * p);
  }
  return pixels;
}

export function runCount(alpha) {
  let count = 0;
  for (let i = 0; i < alpha.length;) {
    const value = alpha[i]; let next = i + 1;
    while (next < alpha.length && alpha[next] === value) next++;
    if (value) count++;
    i = next;
  }
  return count;
}
