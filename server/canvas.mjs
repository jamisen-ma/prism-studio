import { bitmapMask, maskCoverage, normalizeMask } from './masks.mjs';

const MAX_AXIS = 8192;
const MAX_PIXELS = 24_000_000;
const ANCHORS = Object.freeze({
  'top-left': [0, 0], top: [0.5, 0], 'top-right': [1, 0],
  left: [0, 0.5], center: [0.5, 0.5], right: [1, 0.5],
  'bottom-left': [0, 1], bottom: [0.5, 1], 'bottom-right': [1, 1]
});

function fail(message, code = 'INVALID_ARGUMENT') {
  throw Object.assign(new Error(message), { code });
}
function dimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_AXIS || height > MAX_AXIS) {
    fail('Canvas dimensions must be integers between 1 and 8192 pixels.');
  }
  if (width * height > MAX_PIXELS) fail('Canvas dimensions exceed the 24-megapixel limit.', 'LIMIT_EXCEEDED');
}
function validateTransform(oldWidth, oldHeight, transform) {
  dimensions(oldWidth, oldHeight);
  if (!transform || typeof transform !== 'object' || Array.isArray(transform) || transform.type !== 'canvas') fail('A canvas transform is required.');
  dimensions(transform.width, transform.height);
  if (!Number.isInteger(transform.x) || !Number.isInteger(transform.y) || Math.abs(transform.x) > MAX_AXIS || Math.abs(transform.y) > MAX_AXIS) {
    fail('Canvas offsets must be integers between -8192 and 8192 pixels.');
  }
}
function intersection(oldWidth, oldHeight, transform) {
  const sourceX = Math.max(0, -transform.x), sourceY = Math.max(0, -transform.y);
  const targetX = Math.max(0, transform.x), targetY = Math.max(0, transform.y);
  return {
    sourceX, sourceY, targetX, targetY,
    width: Math.max(0, Math.min(oldWidth - sourceX, transform.width - targetX)),
    height: Math.max(0, Math.min(oldHeight - sourceY, transform.height - targetY))
  };
}

/**
 * Translate the existing pixels into a new canvas. This changes canvas bounds,
 * never image scale. Center anchors use floor(delta / 2), including for crops.
 */
export function canvasTransform(oldWidth, oldHeight, newWidth, newHeight, anchor = 'center') {
  dimensions(oldWidth, oldHeight);
  dimensions(newWidth, newHeight);
  if (typeof anchor !== 'string' || !Object.prototype.hasOwnProperty.call(ANCHORS, anchor)) fail('Choose one of the nine supported canvas anchors.');
  const [horizontal, vertical] = ANCHORS[anchor];
  return {
    type: 'canvas', width: newWidth, height: newHeight,
    x: Math.floor((newWidth - oldWidth) * horizontal) || 0,
    y: Math.floor((newHeight - oldHeight) * vertical) || 0
  };
}

/** Copy the original intersection byte-for-byte, with transparent RGBA padding. */
export function resizeCanvasPixels(rgbaBuffer, oldWidth, oldHeight, transform) {
  validateTransform(oldWidth, oldHeight, transform);
  if (!Buffer.isBuffer(rgbaBuffer) || rgbaBuffer.length !== oldWidth * oldHeight * 4) fail('Canvas pixels must be a Buffer containing exactly one RGBA8 pixel per source position.');
  const output = Buffer.alloc(transform.width * transform.height * 4);
  const area = intersection(oldWidth, oldHeight, transform);
  if (!area.width || !area.height) return output;
  for (let row = 0; row < area.height; row++) {
    const sourceStart = ((area.sourceY + row) * oldWidth + area.sourceX) * 4;
    const targetStart = ((area.targetY + row) * transform.width + area.targetX) * 4;
    rgbaBuffer.copy(output, targetStart, sourceStart, sourceStart + area.width * 4);
  }
  return output;
}

/**
 * Preserve geometric coverage without quantizing feathered edges. A translated
 * clip excludes newly exposed canvas, including when the mask is inverted.
 * Bitmap coverage is already 8-bit and is baked before translation so cropping
 * cannot introduce new feathered edges. The shared RLE limit still applies.
 */
export function resizeCanvasMask(mask, oldWidth, oldHeight, transform) {
  validateTransform(oldWidth, oldHeight, transform);
  if (mask === null || mask === undefined) return null;
  // Persisted masks can extend outside the source canvas after previous crops.
  const normalized = normalizeMask(mask, oldWidth, oldHeight, { persisted: true });
  if (normalized.shape === 'alpha8') fail('Alpha8 canvas masks require asynchronous prepared coverage.');
  if (transform.width === oldWidth && transform.height === oldHeight && transform.x === 0 && transform.y === 0) return structuredClone(mask);
  if (normalized.shape !== 'bitmap') {
    const result = structuredClone(normalized);
    result.x += transform.x;
    result.y += transform.y;
    if (result.points) result.points = result.points.map(({ x, y }) => ({ x: x + transform.x, y: y + transform.y }));

    // Intersect the previous clip, the old canvas, and the new canvas in target
    // coordinates. Clamping both ends also gives a canonical empty clip when
    // the original content lies entirely beyond the new canvas.
    const previous = normalized.clip ?? { x: 0, y: 0, width: oldWidth, height: oldHeight };
    const clampX = (x) => Math.max(0, Math.min(transform.width, x));
    const clampY = (y) => Math.max(0, Math.min(transform.height, y));
    const x = clampX(Math.max(transform.x, previous.x + transform.x));
    const y = clampY(Math.max(transform.y, previous.y + transform.y));
    const right = clampX(Math.min(oldWidth + transform.x, previous.x + previous.width + transform.x));
    const bottom = clampY(Math.min(oldHeight + transform.y, previous.y + previous.height + transform.y));
    result.clip = { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
    return result;
  }
  const coverage = maskCoverage(normalized);
  const output = new Uint8Array(transform.width * transform.height);
  const area = intersection(oldWidth, oldHeight, transform);
  for (let row = 0; row < area.height; row++) {
    const sourceY = area.sourceY + row;
    const targetStart = (area.targetY + row) * transform.width + area.targetX;
    for (let column = 0; column < area.width; column++) {
      output[targetStart + column] = Math.round(coverage(area.sourceX + column, sourceY) * 255);
    }
  }
  return bitmapMask(output, transform.width, transform.height);
}
