import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import { maskCoverage, normalizeMask, assertMaskDensityOwnership } from './masks.mjs';

export const LAYER_MASK_PROPERTIES = Object.freeze(['feather', 'invert', 'density']);
export const LAYER_MASK_POSITION_COMMANDS = Object.freeze(['set_layer_mask_position', 'apply_layer_mask_position']);
export const LAYER_MASK_POSITION_OPERATIONS = Object.freeze(['set', 'rasterize']);
export const LAYER_MASK_POSITION_LIMITS = Object.freeze({ maxPosition: 16384, maxStoredPosition: 1_000_000, maxSourcePixels: 24_000_000, maxCallbackBytes: 256 * 1024 * 1024, maxWorkingBytes: 256 * 1024 * 1024 });
const fail = (message, code = 'INVALID_ARGUMENT') => { throw Object.assign(new Error(message), { code }); };
const positioned = mask => mask?.shape === 'positioned';
export const positionedLayerMask = positioned;
export const layerMaskSource = layer => positioned(layer?.mask) ? layer.mask.source : layer?.mask;

function plain(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${label} must be a plain object.`);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !keys.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(`${label} contains unsupported metadata.`);
  }
}
function integer(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) fail(`${label} must be an integer between ${min} and ${max}.`);
  return value;
}
function sourcePixels(width, height) {
  integer(width, 1, 8192, 'Mask source width'); integer(height, 1, 8192, 'Mask source height');
  if (width * height > LAYER_MASK_POSITION_LIMITS.maxSourcePixels) fail('Mask source exceeds 24 megapixels.', 'LIMIT_EXCEEDED');
  return width * height;
}
function validatePositioned(mask) {
  plain(mask, ['shape', 'sourceWidth', 'sourceHeight', 'x', 'y', 'source', 'domain'], 'Positioned mask');
  sourcePixels(mask.sourceWidth, mask.sourceHeight);
  integer(mask.x, -1_000_000, 1_000_000, 'Mask x position'); integer(mask.y, -1_000_000, 1_000_000, 'Mask y position');
  if (!mask.source || positioned(mask.source)) fail('Positioned masks require one legacy source mask; nested positions are unsupported.');
  const source = normalizeMask(mask.source, mask.sourceWidth, mask.sourceHeight, { persisted: true });
  if (['bitmap', 'alpha8'].includes(source.shape) && (source.width !== mask.sourceWidth || source.height !== mask.sourceHeight)) fail('Byte-mask dimensions must match its retained source frame.');
  if (mask.domain !== undefined) {
    plain(mask.domain, ['x', 'y', 'width', 'height'], 'Mask position domain');
    integer(mask.domain.x, -1_000_000, 1_000_000, 'Mask domain x'); integer(mask.domain.y, -1_000_000, 1_000_000, 'Mask domain y');
    integer(mask.domain.width, 0, 1_000_000, 'Mask domain width'); integer(mask.domain.height, 0, 1_000_000, 'Mask domain height');
    integer(mask.domain.x + mask.domain.width, -1_000_000, 1_000_000, 'Mask domain right');
    integer(mask.domain.y + mask.domain.height, -1_000_000, 1_000_000, 'Mask domain bottom');
  }
}

/** Additional masks alone may retain a translated source frame. Generic
 * selections remain ordinary canvas-sized descriptors. Validation allocates
 * no coverage planes, including disabled/hidden masks. */
export function validateAdditionalLayerMask(layer, width, height) {
  validateLayerMaskDensity(layer);
  for (const key of ['maskOffset', 'maskPosition']) if (Object.hasOwn(layer, key)) fail('Mask position belongs to the additional positioned mask descriptor.');
  if (!layer.mask) return;
  if (positioned(layer.mask)) validatePositioned(layer.mask);
  else {
    const mask = normalizeMask(layer.mask, width, height, { persisted: true });
    if (['bitmap', 'alpha8'].includes(mask.shape) && (mask.width !== width || mask.height !== height)) fail('Byte-mask dimensions must match the current canvas.');
  }
}

export function rawLayerMaskCoverage(layer) {
  const mask = layer?.mask;
  if (!positioned(mask)) return maskCoverage(mask);
  validatePositioned(mask);
  const coverage = maskCoverage(mask.source), { x: offsetX, y: offsetY, domain } = mask;
  return (x, y) => {
    const u = x - offsetX, v = y - offsetY;
    return domain && !(u + 0.5 >= domain.x && v + 0.5 >= domain.y && u + 0.5 < domain.x + domain.width && v + 0.5 < domain.y + domain.height) ? 0 : coverage(u, v);
  };
}

/** Source callback storage, including its one feather construction plane. */
export function layerMaskStorageBytes(layer, { raw = false } = {}) {
  const source = layerMaskSource(layer);
  return (!raw && layer?.maskDensity === 0) || !['bitmap', 'alpha8'].includes(source?.shape) ? 0 : sourcePixels(source.width, source.height) * (source.feather > 0 ? 5 : 1) + (source.shape === 'alpha8' ? 32 : 0);
}

/** Callback reserve for graphs opting into retained masks. Two
 * callback sets cover render ancestors plus original-context protection; only
 * one synchronous feather constructor owns a distance plane at a time. */
export function estimateLayerMaskCallbacks(graph, { force = false } = {}) {
  const retained = force || graph.layers.some(layer => positioned(layer.mask));
  let bitmapBytes = 0, featherBytes = 0;
  if (retained) for (const layer of graph.layers) {
    const source = layerMaskSource(layer);
    if (!['bitmap', 'alpha8'].includes(source?.shape) || layer.maskDensity === 0) continue;
    const count = sourcePixels(source.width, source.height);
    bitmapBytes += count + (source.shape === 'alpha8' ? 32 : 0);
    if (source.feather > 0) featherBytes = Math.max(featherBytes, 4 * count);
  }
  return { bitmapBytes, featherBytes, estimatedCallbackBytes: 2 * bitmapBytes + featherBytes, maxCallbackBytes: LAYER_MASK_POSITION_LIMITS.maxCallbackBytes };
}
export function validateLayerMaskResources(graph, retainedScratchBytes = 0) {
  if (!Number.isSafeInteger(retainedScratchBytes) || retainedScratchBytes < 0) fail('Invalid retained render buffer estimate.');
  const estimate = estimateLayerMaskCallbacks(graph);
  const estimatedScratchBytes = retainedScratchBytes + estimate.estimatedCallbackBytes;
  if (!Number.isSafeInteger(estimatedScratchBytes)) fail('Invalid retained mask buffer estimate.');
  if (estimatedScratchBytes > estimate.maxCallbackBytes) fail('Combined retained mask, group, clipping and editable-filter buffers exceed 256 MiB. Rasterize mask positions or reduce retained masks, nesting or image dimensions.', 'LIMIT_EXCEEDED');
  return { ...estimate, retainedScratchBytes, estimatedScratchBytes };
}

export function setLayerMaskPosition(layer, width, height, x, y) {
  validateAdditionalLayerMask(layer, width, height);
  if (!layer.mask) fail('Create an additional layer mask before positioning it.', 'NO_MASK');
  integer(x, -16384, 16384, 'Mask x position'); integer(y, -16384, 16384, 'Mask y position');
  if (!positioned(layer.mask) && x === 0 && y === 0) return structuredClone(layer.mask);
  const mask = positioned(layer.mask) ? structuredClone(layer.mask) : { shape: 'positioned', sourceWidth: width, sourceHeight: height, source: structuredClone(layer.mask) };
  mask.x = x; mask.y = y;
  if (x === 0 && y === 0 && mask.domain === undefined && mask.sourceWidth === width && mask.sourceHeight === height) return mask.source;
  validatePositioned(mask);
  return mask;
}

export function transformPositionedMask(mask, transform, oldWidth, oldHeight) {
  if (!positioned(mask)) fail('A positioned additional mask is required.');
  validatePositioned(mask); sourcePixels(oldWidth, oldHeight); sourcePixels(transform.width, transform.height);
  if (transform.type === 'resize') {
    if (transform.width === oldWidth && transform.height === oldHeight) return structuredClone(mask);
    fail('Rasterize this additional mask position before resizing the image. Crop and canvas-bounds changes remain available.', 'MASK_POSITION_REQUIRES_RASTERIZE');
  }
  if (!['crop', 'canvas'].includes(transform.type)) fail('Unsupported positioned-mask geometry operation.');
  integer(transform.x, -8192, 8192, 'Canvas x offset'); integer(transform.y, -8192, 8192, 'Canvas y offset');
  if (transform.type === 'canvas' && transform.width === oldWidth && transform.height === oldHeight && transform.x === 0 && transform.y === 0) return structuredClone(mask);
  const result = structuredClone(mask), sign = transform.type === 'crop' ? -1 : 1;
  result.x += sign * transform.x; result.y += sign * transform.y;
  if (transform.type === 'canvas') {
    const old = { x: -mask.x, y: -mask.y, width: oldWidth, height: oldHeight }, next = { x: -result.x, y: -result.y, width: transform.width, height: transform.height }, rectangles = [old, next, ...(mask.domain ? [mask.domain] : [])];
    const x = Math.max(...rectangles.map(rect => rect.x)), y = Math.max(...rectangles.map(rect => rect.y));
    const right = Math.min(...rectangles.map(rect => rect.x + rect.width)), bottom = Math.min(...rectangles.map(rect => rect.y + rect.height));
    result.domain = { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
  }
  validatePositioned(result);
  return result;
}

/** Intentional current-canvas alpha8 copy; density is never baked. The caller
 * encodes/publishes only after this staged sampling completes. */
export async function sampleLayerMaskAlpha(layer, width, height) {
  validateAdditionalLayerMask(layer, width, height);
  if (!layer.mask) fail('Create an additional layer mask first.', 'NO_MASK');
  const count = sourcePixels(width, height), working = count + layerMaskStorageBytes(layer, { raw: true });
  if (working > LAYER_MASK_POSITION_LIMITS.maxWorkingBytes) fail('Rasterizing this mask exceeds the 256 MiB working-buffer limit.', 'LIMIT_EXCEEDED');
  const coverage = rawLayerMaskCoverage(layer), alpha = Buffer.allocUnsafe(count);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) alpha[y * width + x] = Math.max(0, Math.min(255, Math.round(coverage(x, y) * 255)));
    if ((y + 1) % 32 === 0) await yieldEventLoop();
  }
  return alpha;
}

export function validateLayerMaskDensity(layer) {
  if (!layer || typeof layer !== 'object' || Array.isArray(layer)) fail('A layer is required for layer-mask coverage.');
  if (positioned(layer.mask)) validatePositioned(layer.mask);
  else assertMaskDensityOwnership(layer.mask);
  if (layer.maskDensity === undefined) return;
  if (!layer.mask) fail('Layer-mask density requires an existing additional layer mask.', 'NO_MASK');
  if (typeof layer.maskDensity !== 'number' || !Number.isFinite(layer.maskDensity) || layer.maskDensity < 0 || layer.maskDensity > 1)
    fail('Layer-mask density must be a finite number between zero and one.');
}

/** Density is an editable layer property, never a generic selection/source
 * mask field. Apply it after raw feather, inversion and internal canvas clip. */
export function layerMaskCoverage(layer) {
  validateLayerMaskDensity(layer);
  const density = layer.maskDensity ?? 1;
  if (!layer.mask || density === 0) return () => 1;
  const coverage = rawLayerMaskCoverage(layer);
  if (density === 1) return coverage;
  const bitmap = layerMaskSource(layer).shape === 'bitmap';
  return (x, y) => {
    // Compute density in byte units to preserve half-up alpha8 ties. Bitmap
    // coverage is inherently byte-valued after feathering; recover that byte
    // to remove cancellation from its stored inversion. Geometric coverage
    // remains continuous and must not be quantized before applying density.
    const raw = coverage(x, y) * 255, byte = bitmap ? Math.round(raw) : raw;
    return (255 - density * (255 - byte)) / 255;
  };
}
