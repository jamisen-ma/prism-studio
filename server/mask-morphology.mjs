import { setImmediate as yieldEventLoop } from 'node:timers/promises';

export const MORPHOLOGY_LIMITS = Object.freeze({ maxDimension: 8192, maxPixels: 24_000_000, maxRadius: 100, workingPlanes: 3, yieldEveryLines: 32 });
const OPERATIONS = new Set(['expand', 'contract', 'border', 'smooth']);
const fail = (message, code = 'INVALID_ARGUMENT') => { throw Object.assign(new Error(message), { code }); };
const cancelled = (signal) => {
  if (signal?.aborted) throw Object.assign(new Error('Mask operation was cancelled.'), { name: 'AbortError', code: 'ABORTED' });
};

function validate(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('Mask morphology requires an options object.');
  if (Object.keys(options).some((key) => !['alpha', 'width', 'height', 'operation', 'radius', 'signal'].includes(key))) fail('Unsupported mask morphology option.');
  const { alpha, width, height, operation, radius, signal } = options;
  if (![width, height].every((value) => Number.isInteger(value) && value > 0)) fail('Mask dimensions must be positive integers.');
  if (width > MORPHOLOGY_LIMITS.maxDimension || height > MORPHOLOGY_LIMITS.maxDimension || width * height > MORPHOLOGY_LIMITS.maxPixels) fail('Mask dimensions exceed the native image limits.', 'LIMIT_EXCEEDED');
  if (!Buffer.isBuffer(alpha) || alpha.length !== width * height) fail('Mask pixels must be an 8-bit Buffer matching its dimensions.');
  if (!OPERATIONS.has(operation)) fail('Mask operation must be expand, contract, border or smooth.');
  if (!Number.isInteger(radius) || radius < 1 || radius > MORPHOLOGY_LIMITS.maxRadius) fail('Mask radius must be an integer from 1 to 100.');
  if (signal !== undefined && !(signal instanceof AbortSignal)) fail('Mask cancellation requires an AbortSignal.');
  cancelled(signal);
}

// A monotonic deque computes each row/column in linear time. The maximum of
// out-of-bounds zeros cannot exceed an in-bounds byte; the minimum is zero
// whenever the window crosses the boundary. No replicated edge samples.
async function pass(input, output, width, height, radius, maximum, vertical, deque, signal) {
  const lines = vertical ? width : height, length = vertical ? height : width, stride = vertical ? width : 1;
  for (let line = 0; line < lines; line++) {
    const base = vertical ? line : line * width;
    let head = 0, tail = 0, next = 0;
    for (let position = 0; position < length; position++) {
      const end = Math.min(length - 1, position + radius);
      while (next <= end) {
        const value = input[base + next * stride];
        while (tail > head) {
          const previous = input[base + deque[tail - 1] * stride];
          if (maximum ? previous > value : previous < value) break;
          tail--;
        }
        deque[tail++] = next++;
      }
      const start = position - radius;
      while (head < tail && deque[head] < start) head++;
      output[base + position * stride] = !maximum && (start < 0 || position + radius >= length)
        ? 0 : input[base + deque[head] * stride];
    }
    if ((line + 1) % MORPHOLOGY_LIMITS.yieldEveryLines === 0) { await yieldEventLoop(); cancelled(signal); }
  }
  cancelled(signal);
}

/**
 * Grayscale morphology on already-materialized document-space alpha.
 * Square/Chebyshev radius, zero beyond the canvas, no binary threshold:
 * expand = maximum; contract = minimum; border = expand - contract;
 * smooth = opening then closing (min, max, max, min), not a blur.
 *
 * Snapshot before the first await; never retain or mutate caller bytes. Three
 * owned byte planes + one max-axis Int32 deque bound working memory to
 * 3 * width * height + 4 * max(width, height), at most 72,032,768 bytes.
 * Every primitive is O(pixels), independent of radius. Smooth has four such
 * primitives. Native callers must bake mask feather/invert/clip before use.
 */
export async function morphMask(options) {
  validate(options);
  const { width, height, radius, operation, signal } = options;
  const input = Buffer.from(options.alpha), scratch = Buffer.allocUnsafe(input.length), output = Buffer.allocUnsafe(input.length);
  const deque = new Int32Array(Math.max(width, height));
  const primitive = async (source, destination, maximum) => {
    await pass(source, scratch, width, height, radius, maximum, false, deque, signal);
    await pass(scratch, destination, width, height, radius, maximum, true, deque, signal);
  };
  if (operation === 'smooth') {
    await primitive(input, output, false);
    await primitive(output, input, true);
    await primitive(input, output, true);
    await primitive(output, input, false);
    return input;
  }
  await primitive(input, output, operation !== 'contract');
  if (operation === 'border') {
    // Original input is no longer needed after the horizontal erosion pass.
    await primitive(input, input, false);
    for (let y = 0; y < height; y++) {
      const start = y * width, end = start + width;
      for (let i = start; i < end; i++) output[i] -= input[i];
      if ((y + 1) % MORPHOLOGY_LIMITS.yieldEveryLines === 0) { await yieldEventLoop(); cancelled(signal); }
    }
  }
  cancelled(signal);
  return output;
}
