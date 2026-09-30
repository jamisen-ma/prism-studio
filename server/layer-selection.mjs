import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import { normalizeMask, maskCoverage } from './masks.mjs';
import { prepareLayerMaskCoverage, prepareRawLayerMaskCoverage, combineMaskAlpha, maskBufferBytes, maskPreparationWork, DENSE_MASK_LIMITS } from './dense-mask.mjs';
import { layerMaskCoverage, rawLayerMaskCoverage, validateAdditionalLayerMask, layerMaskStorageBytes } from './layer-mask.mjs';

export const LAYER_SELECTION_SOURCES = Object.freeze(['content', 'layer-mask']);
export const LAYER_SELECTION_MASK_MODES = Object.freeze(['raw', 'effective']);
export const LAYER_SELECTION_CONTENT_TYPES = Object.freeze(['raster', 'solid', 'text', 'shape', 'path', 'gradient']);
export const LAYER_SELECTION_LIMITS = Object.freeze({ maxWorkingBytes: 256 * 1024 * 1024, maxMaskScalars: 600_000, yieldRows: 32 });
const MODES = ['replace', 'add', 'subtract', 'intersect'];
const fail = (message, code = 'INVALID_ARGUMENT') => { throw Object.assign(new Error(message), { code }); };
const quantize = value => Math.max(0, Math.min(255, Math.round(value * 255)));

function pixels(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 24_000_000)
    fail('Layer selection dimensions exceed native image limits.', 'LIMIT_EXCEEDED');
  return width * height;
}
function validateMask(mask, width, height) {
  const normalized = normalizeMask(mask, width, height, { persisted: true });
  if (['bitmap', 'alpha8'].includes(normalized.shape) && (normalized.width !== width || normalized.height !== height)) fail('Selection mask dimensions must match the canvas.');
}
function bitmapStorage(mask) {
  return maskBufferBytes(mask);
}
function byteCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('Invalid source buffer size.');
  return value;
}

/** Explicit binary-buffer accounting, not a process RSS or native-codec bound.
 * Keep encoded inputs and the original RGBA source through geometry. Count
 * previous/next geometry frames separately even when the first aliases source.
 * The materializer returns only alpha; its RGBA/callback references do not cross
 * into the combination phase. Feather distance storage is counted in full,
 * without relying on immediate garbage collection during callback creation. */
export function estimateLayerSelectionBytes({ graph, layer, source = 'content', maskMode = 'effective', mode = 'replace', encodedSourceBytes = 0, encodedAlphaBytes = 0 }) {
  const count = pixels(graph.width, graph.height);
  let sourceBytes = 0, maskBytes = 0;
  if (source === 'content') {
    const sourcePixels = pixels(layer.width, layer.height);
    let frames = layer.alphaAsset ? 9 * sourcePixels : 4 * sourcePixels, previous = sourcePixels;
    for (const transform of layer.transforms ?? []) {
      const next = transform.type === 'affine' ? previous : pixels(transform.width, transform.height);
      frames = Math.max(frames, 4 * sourcePixels + 4 * previous + 4 * next);
      previous = next;
    }
    if (previous !== count) fail('Layer geometry must end at the current canvas dimensions.');
    // Gradient input is an owned raw RGBA buffer retained by the sharp pipeline.
    // Generated SVG inputs are bounded well below 1 MiB by existing text/path
    // validation; reserve that bound instead of rendering twice to measure it.
    const proceduralInput = layer.type === 'gradient' ? 4 * sourcePixels : ['text', 'shape', 'path'].includes(layer.type) ? 1024 * 1024 : 0;
    sourceBytes = byteCount(encodedSourceBytes) + byteCount(encodedAlphaBytes) + proceduralInput + frames + count;
  } else if (source === 'layer-mask') {
    maskBytes = count + layerMaskStorageBytes(layer, { raw: maskMode === 'raw' });
  } else fail('Selection source must be content or layer-mask.');
  const combining = mode !== 'replace' && !!graph.selection;
  // The loaded bytes are used directly, rather than allocating a second bitmap
  // coverage buffer. Existing active coverage and output coexist with them.
  const combinationBytes = combining ? 2 * count + bitmapStorage(graph.selection) : count;
  return { sourceBytes, maskBytes, combinationBytes, estimatedWorkingBytes: Math.max(sourceBytes, maskBytes, combinationBytes), maxWorkingBytes: LAYER_SELECTION_LIMITS.maxWorkingBytes };
}
function preflight(options) {
  const estimate = estimateLayerSelectionBytes(options);
  if (estimate.estimatedWorkingBytes > estimate.maxWorkingBytes)
    fail('Loading this layer selection exceeds the 256 MiB working-buffer limit. Reduce the canvas or source dimensions first.', 'LIMIT_EXCEEDED');
  return estimate;
}

/** Canonical RLE with row yields and complexity checks before every run append.
 * Empty coverage remains an explicit bitmap selection, never null. */
export async function encodeSelectionAlpha(alpha, width, height) {
  const count = pixels(width, height);
  if (!(alpha instanceof Uint8Array) || alpha.length !== count) fail('Selection alpha must match the canvas dimensions.');
  const runs = [];
  let start = 0, value = 0;
  const flush = end => {
    if (!value) return;
    if (runs.length + 3 > LAYER_SELECTION_LIMITS.maxMaskScalars) fail('The loaded selection exceeds the bitmap complexity limit.', 'LIMIT_EXCEEDED');
    runs.push(start, end - start, value);
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x, next = alpha[index];
      if (next !== value) { flush(index); start = index; value = next; }
    }
    if ((y + 1) % LAYER_SELECTION_LIMITS.yieldRows === 0) await yieldEventLoop();
  }
  flush(count);
  return { shape: 'bitmap', x: 0, y: 0, width, height, runs, feather: 0, invert: false };
}

/** Async equivalent of combineSelections for an already-quantized source.
 * Arithmetic order is deliberately identical; tests compare every output byte
 * against the established saved-selection helper including feather/inversion. */
export async function combineSelectionAlpha(active, alpha, width, height, mode = 'replace') {
  if (!MODES.includes(mode)) fail('Selection mode must be replace, add, subtract or intersect.');
  const count = pixels(width, height);
  if (!(alpha instanceof Uint8Array) || alpha.length !== count) fail('Selection alpha must match the canvas dimensions.');
  if (!active && (mode === 'subtract' || mode === 'intersect')) fail('Create an active selection before subtracting or intersecting.', 'NO_SELECTION');
  // Validate the candidate itself before combinations can simplify its shape.
  let candidate = await encodeSelectionAlpha(alpha, width, height);
  if (mode === 'replace' || !active) return candidate;
  candidate = null;
  validateMask(active, width, height);
  const coverage = maskCoverage(active), output = Buffer.allocUnsafe(count);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x, left = coverage(x, y), right = alpha[index] / 255;
      const amount = mode === 'add' ? Math.max(left, right) : mode === 'subtract' ? left * (1 - right) : left * right;
      output[index] = quantize(amount);
    }
    if ((y + 1) % LAYER_SELECTION_LIMITS.yieldRows === 0) await yieldEventLoop();
  }
  return encodeSelectionAlpha(output, width, height);
}

async function materialize(graph, layer, options, renderLayer, resolveAlpha8) {
  const { width, height } = graph, { source, maskMode, invert } = options;
  if (source === 'content') {
    let rgba;
    try {
      rgba = await renderLayer(layer, { filters: false });
      if (!Buffer.isBuffer(rgba) || rgba.length !== width * height * 4) fail('Invalid image dimensions.');
    } catch { fail('The layer source image could not be read or decoded.', 'INVALID_IMAGE'); }
    const alpha = Buffer.allocUnsafe(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = y * width + x, value = rgba[index * 4 + 3];
        alpha[index] = invert ? 255 - value : value;
      }
      if ((y + 1) % LAYER_SELECTION_LIMITS.yieldRows === 0) await yieldEventLoop();
    }
    rgba = null;
    return alpha;
  }
  const coverage = await (maskMode === 'raw' ? prepareRawLayerMaskCoverage(layer, resolveAlpha8) : prepareLayerMaskCoverage(layer, resolveAlpha8)), alpha = Buffer.allocUnsafe(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = quantize(coverage(x, y));
      alpha[y * width + x] = invert ? 255 - value : value;
    }
    if ((y + 1) % LAYER_SELECTION_LIMITS.yieldRows === 0) await yieldEventLoop();
  }
  return alpha;
}

/** Resolve/validate/preflight and stage a complete selection. The caller owns
 * publication; failures never modify the source layer or active selection. */
export async function loadLayerSelection(graph, args, { renderLayer, sourceAssetBytes, resolveAlpha8, returnAlpha = false } = {}) {
  const source = args.source === undefined ? 'content' : args.source, maskMode = args.maskMode === undefined ? 'effective' : args.maskMode,
    mode = args.mode === undefined ? 'replace' : args.mode, invert = args.invert === undefined ? false : args.invert;
  if (!LAYER_SELECTION_SOURCES.includes(source)) fail('Selection source must be content or layer-mask.');
  if (!LAYER_SELECTION_MASK_MODES.includes(maskMode)) fail('Mask mode must be raw or effective.');
  if (source === 'content' && args.maskMode !== undefined) fail('Mask mode applies only to the layer-mask source.');
  if (!MODES.includes(mode)) fail('Selection mode must be replace, add, subtract or intersect.');
  if (typeof invert !== 'boolean') fail('Selection invert must be boolean.');
  const layer = graph.layers.find(item => item.id === args.layerId);
  if (!layer) fail('Layer was not found.', 'NOT_FOUND');
  if (source === 'content' && !LAYER_SELECTION_CONTENT_TYPES.includes(layer.type)) fail('Choose an individual content layer to load pixel transparency.', 'INVALID_TARGET');
  if (source === 'layer-mask' && !layer.mask) fail('Create an additional layer mask before loading it as a selection.', 'NO_MASK');
  if (!graph.selection && (mode === 'subtract' || mode === 'intersect')) fail('Create an active selection before subtracting or intersecting.', 'NO_SELECTION');
  if (source === 'layer-mask') validateAdditionalLayerMask(layer, graph.width, graph.height);
  if (graph.selection && mode !== 'replace') validateMask(graph.selection, graph.width, graph.height);
  const options = { graph, layer, source, maskMode, mode };
  preflight(options);
  if (returnAlpha) {
    const work = (source === 'layer-mask' && !(maskMode === 'effective' && layer.maskDensity === 0) ? maskPreparationWork(layer.mask) : 0) + (mode !== 'replace' ? maskPreparationWork(graph.selection) : 0);
    if (3 * graph.width * graph.height + 64 > DENSE_MASK_LIMITS.maxWorkingBytes || work > DENSE_MASK_LIMITS.maxPrepareWork) fail('Layer selection mask preparation exceeds native limits.', 'LIMIT_EXCEEDED');
  }
  if (source === 'content' && layer.type === 'raster') {
    let sizes;
    try { sizes = sourceAssetBytes ? await sourceAssetBytes(layer) : {}; }
    catch { fail('The layer source image could not be read or decoded.', 'INVALID_IMAGE'); }
    preflight({ ...options, ...sizes });
  }
  const alpha = await materialize(graph, layer, { source, maskMode, invert }, renderLayer, resolveAlpha8);
  const selection = returnAlpha ? await combineMaskAlpha(graph.selection, alpha, graph.width, graph.height, mode, resolveAlpha8) : await combineSelectionAlpha(graph.selection, alpha, graph.width, graph.height, mode);
  return { ...(returnAlpha ? { alpha: selection } : { selection }), label: source === 'content' ? 'Load layer transparency selection' : 'Load layer mask selection' };
}
