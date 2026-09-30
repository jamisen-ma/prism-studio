import sharp from 'sharp';
import { setImmediate as yieldEventLoop } from 'node:timers/promises';

export const DOCUMENT_RESIZE_METHODS = Object.freeze(['nearest', 'cubic', 'mitchell', 'lanczos3']);
export const DOCUMENT_RESIZE_DEFAULT = 'lanczos3';
const MAX_PIXELS = 24_000_000;
const FIELDS = new Set(['type', 'width', 'height', 'kernel']);
const fail = (message, code = 'INVALID_ARGUMENT') => { throw Object.assign(new Error(message), { code }); };
function dimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > MAX_PIXELS)
    fail('Resize dimensions must be 1–8192 pixels per axis and at most 24 million pixels.', 'LIMIT_EXCEEDED');
}
export function normalizeDocumentResizeMethod(value = DOCUMENT_RESIZE_DEFAULT) {
  if (!DOCUMENT_RESIZE_METHODS.includes(value)) fail('Resample must be nearest, cubic, mitchell or lanczos3.');
  return value;
}

/** New persisted type is intentionally strict: old readers reject it instead
 * of silently ignoring a kernel property on their legacy resize records. */
export function normalizeResampleTransform(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || ![Object.prototype, null].includes(Object.getPrototypeOf(record))) fail('Invalid resample transform.');
  const keys = Reflect.ownKeys(record);
  if (keys.length !== FIELDS.size || keys.some(key => !FIELDS.has(key) || !Object.getOwnPropertyDescriptor(record, key)?.enumerable || !Object.hasOwn(Object.getOwnPropertyDescriptor(record, key), 'value'))) fail('Resample transforms require only type, width, height and kernel.');
  if (record.type !== 'resample') fail('A resample transform is required.');
  dimensions(record.width, record.height);
  if (record.kernel === undefined) fail('A resample transform requires an explicit kernel.');
  return { type: 'resample', width: record.width, height: record.height, kernel: normalizeDocumentResizeMethod(record.kernel) };
}

/** Nearest copies the current geometry-stage RGBA literally, including hidden
 * RGB and soft alpha. This is native pixel-center sampling, not Sharp nearest's
 * premultiplied or upsampling-coordinate behavior. Only one output frame is
 * allocated; source/current/next lifetime accounting belongs to the caller. */
export async function resamplePixels(input, oldWidth, oldHeight, record) {
  dimensions(oldWidth, oldHeight);
  const { width, height, kernel } = normalizeResampleTransform(record);
  if (!Buffer.isBuffer(input) || input.length !== oldWidth * oldHeight * 4) fail('Resize RGBA pixels must match the source dimensions.');
  if (kernel !== 'nearest') return sharp(input, { raw: { width: oldWidth, height: oldHeight, channels: 4 }, limitInputPixels: MAX_PIXELS })
    .resize(width, height, { fit: 'fill', kernel }).raw().toBuffer();
  const output = Buffer.allocUnsafe(width * height * 4);
  const yieldRows = Math.min(32, Math.max(1, Math.floor(65536 / width)));
  for (let y = 0; y < height; y++) {
    const sy = Math.floor(((2 * y + 1) * oldHeight) / (2 * height));
    for (let x = 0; x < width; x++) {
      const sx = Math.floor(((2 * x + 1) * oldWidth) / (2 * width));
      const source = (sy * oldWidth + sx) * 4, target = (y * width + x) * 4;
      output[target] = input[source]; output[target + 1] = input[source + 1];
      output[target + 2] = input[source + 2]; output[target + 3] = input[source + 3];
    }
    if ((y + 1) % yieldRows === 0) await yieldEventLoop();
  }
  return output;
}
