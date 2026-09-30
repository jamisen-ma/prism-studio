import { setImmediate as yieldEventLoop } from 'node:timers/promises';

export const DISTORT_POLICY = 'fixed-frame-projective-bilinear-v1';
export const DISTORT_COORDINATES = 'stage-pixel-edges';
export const DISTORT_CONTENT_TYPES = Object.freeze(['raster', 'solid', 'text', 'shape', 'path', 'gradient']);
export const DISTORT_COMMANDS = Object.freeze(['add_layer_distort', 'update_layer_distort', 'delete_layer_distort']);
export const DISTORT_LIMITS = Object.freeze({ maxCorner: 16384, maxWork: 384_000_000, maxWorkingBytes: 256 * 1024 * 1024, minSpan: 0.25, minCross: 2 ** -20, maxCondition: 1e6, maxDenominatorRatio: 64, yieldPixels: 16_384 });
const fail = (message, code = 'INVALID_ARGUMENT') => { throw Object.assign(new Error(message), { code }); };
const check = (valid, message, code) => { if (!valid) fail(message, code); };
const byte = value => Math.max(0, Math.min(255, Math.round(value)));
function plain(value, fields, label) {
  check(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)), `${label} must be a plain object.`);
  const keys = Reflect.ownKeys(value);
  check(keys.length === fields.length && fields.every(key => Object.hasOwn(value, key)), `${label} requires exactly ${fields.join(', ')}.`);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    check(typeof key === 'string' && fields.includes(key) && descriptor.enumerable && Object.hasOwn(descriptor, 'value'), `${label} contains unsupported metadata.`);
  }
}
export function normalizeDistortCorners(corners) {
  check(Array.isArray(corners) && Object.getPrototypeOf(corners) === Array.prototype && corners.length === 4 && Reflect.ownKeys(corners).length === 5, 'Distort requires a dense four-corner array.');
  const result = [];
  for (let i = 0; i < 4; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(corners, i);
    check(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'), 'Distort corners cannot contain accessors or holes.');
    const point = descriptor.value;
    plain(point, ['x', 'y'], 'Distort corner');
    for (const key of ['x', 'y']) check(typeof point[key] === 'number' && Number.isFinite(point[key]) && Math.abs(point[key]) <= DISTORT_LIMITS.maxCorner, 'Distort corner coordinates must be finite and between -16384 and 16384.');
    result.push({ x: point.x === 0 ? 0 : point.x, y: point.y === 0 ? 0 : point.y });
  }
  return result;
}
function frame(width, height) {
  check([width, height].every(value => Number.isInteger(value) && value >= 1 && value <= 8192) && width * height <= 24_000_000, 'Distort frame exceeds native image limits.', 'LIMIT_EXCEEDED');
}
const norm = matrix => Math.max(...[0, 3, 6].map(i => Math.abs(matrix[i]) + Math.abs(matrix[i + 1]) + Math.abs(matrix[i + 2])));
function inverse(matrix) {
  const [a, b, c, d, e, f, g, h, i] = matrix;
  const adj = [e*i-f*h, c*h-b*i, b*f-c*e, f*g-d*i, a*i-c*g, c*d-a*f, d*h-e*g, b*g-a*h, a*e-b*d];
  const determinant = a * adj[0] + b * adj[3] + c * adj[6];
  check(Number.isFinite(determinant) && determinant !== 0, 'Distort quadrilateral has a singular mapping.');
  return adj.map(value => value / determinant);
}

/** Binary64 projective mapping, conditioned in destination coordinates.
 * The expanded denominator domain includes the complete bilinear fringe. */
export function compileDistort(width, height, corners) {
  frame(width, height);
  corners = normalizeDistortCorners(corners);
  const translation = { x: corners[0].x, y: corners[0].y };
  if (Number.isInteger(translation.x) && Number.isInteger(translation.y) && corners.every((point, i) => point.x === translation.x + [0, width, width, 0][i] && point.y === translation.y + [0, 0, height, height][i]))
    return { width, height, translation };
  const minX = Math.min(...corners.map(point => point.x)), maxX = Math.max(...corners.map(point => point.x));
  const minY = Math.min(...corners.map(point => point.y)), maxY = Math.max(...corners.map(point => point.y));
  const span = Math.max(maxX - minX, maxY - minY), cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  check(span >= DISTORT_LIMITS.minSpan, 'Distort quadrilateral must span at least 0.25 pixel.');
  const q = corners.map(point => ({ x: (point.x - cx) / span, y: (point.y - cy) / span }));
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    check((b.x-a.x)*(c.y-b.y) - (b.y-a.y)*(c.x-b.x) >= DISTORT_LIMITS.minCross, 'Distort corners must form a clockwise convex quadrilateral without crossing or thin collapsed edges.');
  }
  const dx1 = q[1].x-q[2].x, dx2 = q[3].x-q[2].x, dx3 = q[0].x-q[1].x+q[2].x-q[3].x;
  const dy1 = q[1].y-q[2].y, dy2 = q[3].y-q[2].y, dy3 = q[0].y-q[1].y+q[2].y-q[3].y;
  const denominator = dx1*dy2-dx2*dy1;
  const g = (dx3*dy2-dx2*dy3)/denominator, h = (dx1*dy3-dx3*dy1)/denominator;
  const matrix = [q[1].x-q[0].x+g*q[1].x, q[3].x-q[0].x+h*q[3].x, q[0].x, q[1].y-q[0].y+g*q[1].y, q[3].y-q[0].y+h*q[3].y, q[0].y, g, h, 1];
  const inverted = inverse(matrix), condition = norm(matrix) * norm(inverted);
  check(matrix.every(Number.isFinite) && inverted.every(Number.isFinite) && Number.isFinite(condition) && condition <= DISTORT_LIMITS.maxCondition, 'Distort mapping is too poorly conditioned. Use a less extreme quadrilateral.');
  const denominators = [];
  for (const u of [-.5 / width, 1 + .5 / width]) for (const v of [-.5 / height, 1 + .5 / height]) denominators.push(g * u + h * v + 1);
  const minimum = Math.min(...denominators), denominatorRatio = Math.max(...denominators) / minimum;
  check(minimum > 0 && Number.isFinite(denominatorRatio) && denominatorRatio <= DISTORT_LIMITS.maxDenominatorRatio, 'Distort mapping approaches a projective pole within its sampling support. Use a less extreme quadrilateral.');
  return { width, height, cx, cy, span, inverse: inverted, condition, denominatorRatio };
}
export function normalizeDistort(record, width, height) {
  plain(record, ['type', 'width', 'height', 'corners'], 'Distort transform');
  check(record.type === 'distort' && record.width === width && record.height === height, 'Distort must retain its preceding stage dimensions.');
  const corners = normalizeDistortCorners(record.corners);
  compileDistort(width, height, corners);
  return { type: 'distort', width, height, corners };
}
export function createDistort(width, height, corners) { return normalizeDistort({ type: 'distort', width, height, corners }, width, height); }

/** One new RGBA frame; no coordinate maps or premultiplied image planes.
 * Integer copies preserve hidden RGB. General sampling uses alpha-byte sums,
 * whose operation order intentionally does not replace legacy affine pixels. */
export async function distortPixels(input, width, height, record) {
  check(Buffer.isBuffer(input) && input.length === 4 * width * height, 'Distort source bytes must match its input frame.');
  const normalized = normalizeDistort(record, width, height), plan = compileDistort(width, height, normalized.corners);
  const output = Buffer.alloc(input.length);
  if (plan.translation) {
    const { x, y } = plan.translation, left = Math.max(0, -x), top = Math.max(0, -y), right = Math.min(width, width - x), bottom = Math.min(height, height - y);
    const rows = Math.max(1, Math.floor(65_536 / width));
    if (right > left) for (let sy = top; sy < bottom; sy++) {
      input.copy(output, ((sy + y) * width + left + x) * 4, (sy * width + left) * 4, (sy * width + right) * 4);
      if ((sy - top + 1) % rows === 0) await yieldEventLoop();
    }
    return output;
  }
  const m = plan.inverse, yieldRows = Math.max(1, Math.floor(DISTORT_LIMITS.yieldPixels / width));
  for (let y = 0; y < height; y++) {
    const Y = (y + .5 - plan.cy) / plan.span;
    for (let x = 0; x < width; x++) {
      const X = (x + .5 - plan.cx) / plan.span, D = m[6] * X + m[7] * Y + m[8];
      if (!(D > 0) || !Number.isFinite(D)) continue;
      const sx = (m[0] * X + m[1] * Y + m[2]) / D * width - .5, sy = (m[3] * X + m[4] * Y + m[5]) / D * height - .5;
      if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx <= -1 || sy <= -1 || sx >= width || sy >= height) continue;
      const left = Math.floor(sx), top = Math.floor(sy), fx = sx - left, fy = sy - top;
      let A = 0, R = 0, G = 0, B = 0;
      for (let oy = 0; oy < 2; oy++) for (let ox = 0; ox < 2; ox++) {
        const px = left + ox, py = top + oy;
        if (px < 0 || py < 0 || px >= width || py >= height) continue;
        const i = 4 * (py * width + px), w = (ox ? fx : 1 - fx) * (oy ? fy : 1 - fy) * input[i + 3];
        A += w; R += w * input[i]; G += w * input[i + 1]; B += w * input[i + 2];
      }
      if (A > 0) { const i = 4 * (y * width + x); output[i] = byte(R / A); output[i + 1] = byte(G / A); output[i + 2] = byte(B / A); output[i + 3] = byte(A); }
    }
    if ((y + 1) % yieldRows === 0) await yieldEventLoop();
  }
  return output;
}
