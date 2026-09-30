import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import { maskCoverage, normalizeMask } from './masks.mjs';
import { normalizeDenseMaskDescriptor } from '../shared/dense-mask.mjs';
import { prepareMaskCoverage, maskBufferBytes, chargeMaskPreparation } from './dense-mask.mjs';

export const FILTER_MASK_POLICY = 'source-stack-alpha8-v1';
export const FILTER_MASK_COMMANDS = Object.freeze(['set_layer_filter_mask', 'modify_layer_filter_mask', 'clear_layer_filter_mask']);
export const FILTER_MASK_SOURCES = Object.freeze(['selection', 'all', 'none', 'mask']);
export const FILTER_MASK_SHAPES = Object.freeze(['rectangle', 'ellipse', 'bitmap', 'alpha8']);
export const FILTER_MASK_PROPERTIES = Object.freeze(['feather', 'invert', 'density', 'enabled']);
export const FILTER_MASK_CAPTURE_GEOMETRY = 'integer-copy-v1';
export const FILTER_MASK_LIMITS = Object.freeze({ maxWorkingBytes: 256 * 1024 * 1024, maxCaptureWork: 384_000_000, maxMaskScalars: 600_000, yieldVisits: 65_536 });
const fail = (message, code = 'INVALID_ARGUMENT') => { throw Object.assign(new Error(message), { code }); };
const check = (condition, message, code) => { if (!condition) fail(message, code); };
const quantize = value => Math.max(0, Math.min(255, Math.round(value)));
function plain(value, allowed, required, label) {
  check(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)), `${label} must be a plain object.`);
  check(required.every(key => Object.hasOwn(value, key)), `${label} is missing required fields.`);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    check(typeof key === 'string' && allowed.includes(key) && descriptor.enumerable && Object.hasOwn(descriptor, 'value'), `${label} contains unsupported metadata.`);
  }
}
function pixels(width, height) {
  check([width, height].every(value => Number.isInteger(value) && value >= 1 && value <= 8192) && width * height <= 24_000_000, 'Filter-mask dimensions exceed the native source limits.', 'LIMIT_EXCEEDED');
  return width * height;
}
function bounded(value, min, max, label, integer = false) {
  check(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value)), `${label} must be ${integer ? 'an integer ' : ''}between ${min} and ${max}.`);
  return value;
}
export function filterEntries(value) {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  plain(value, ['version', 'entries', 'mask'], ['version', 'entries', 'mask'], 'Masked filter stack');
  check(value.version === 1 && Array.isArray(value.entries) && value.entries.length >= 1 && value.entries.length <= 8, 'Masked filter stacks require version 1 and one to eight entries.');
  plain(value.mask, ['sourceWidth', 'sourceHeight', 'coverage', 'density', 'enabled'], ['sourceWidth', 'sourceHeight', 'coverage', 'density', 'enabled'], 'Filter mask');
  return value.entries;
}
export function storedFilterMask(value) {
  filterEntries(value);
  return value !== undefined && !Array.isArray(value) ? value.mask : undefined;
}
export function normalizeSourceFilterMaskDescriptor(input, width, height) {
  pixels(width, height);
  check(input && typeof input === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(input)), 'Source masks require a plain object.');
  const shape = Object.getOwnPropertyDescriptor(input ?? {}, 'shape');
  if (shape) check(shape.enumerable && Object.hasOwn(shape, 'value'), 'Source mask shape requires an ordinary data property.');
  if (shape?.value === 'alpha8') {
    const mask = normalizeDenseMaskDescriptor(input);
    check(mask.width === width && mask.height === height, 'Alpha8 filter masks must match the source frame.');
    return mask;
  }
  const bitmap = input?.shape === 'bitmap';
  const allowed = bitmap ? ['shape', 'x', 'y', 'width', 'height', 'runs', 'feather', 'invert'] : ['shape', 'x', 'y', 'width', 'height', 'feather', 'invert'];
  plain(input, allowed, bitmap ? ['shape', 'width', 'height', 'runs'] : ['shape', 'x', 'y', 'width', 'height'], 'Source filter mask');
  check(FILTER_MASK_SHAPES.includes(input.shape), 'Source filter masks support rectangle, ellipse or bitmap.');
  if (bitmap) {
    check(input.width === width && input.height === height && (input.x === undefined || input.x === 0) && (input.y === undefined || input.y === 0), 'Bitmap filter masks must match the source dimensions and have zero x/y.');
    check(Array.isArray(input.runs) && input.runs.length <= FILTER_MASK_LIMITS.maxMaskScalars && input.runs.length % 3 === 0, 'Bitmap filter-mask runs exceed the scalar limit or contain incomplete runs.');
    check(Reflect.ownKeys(input.runs).length === input.runs.length + 1, 'Bitmap filter-mask runs must be a dense array.');
    for (let i = 0; i < input.runs.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(input.runs, i);
      check(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'), 'Bitmap filter-mask runs cannot contain accessors or holes.');
    }
  } else {
    bounded(input.x, 0, width, 'Mask x', true); bounded(input.y, 0, height, 'Mask y', true);
    bounded(input.width, 1, width, 'Mask width', true); bounded(input.height, 1, height, 'Mask height', true);
    check(input.x + input.width <= width && input.y + input.height <= height, 'Source filter-mask bounds must fit the source frame.');
  }
  bounded(input.feather === undefined ? 0 : input.feather, 0, 100, 'Mask feather');
  if (input.invert !== undefined) check(typeof input.invert === 'boolean', 'Mask invert must be boolean.');
  return normalizeMask(input, width, height);
}
export function normalizeFilterMask(value, width = value?.sourceWidth, height = value?.sourceHeight) {
  plain(value, ['sourceWidth', 'sourceHeight', 'coverage', 'density', 'enabled'], ['sourceWidth', 'sourceHeight', 'coverage', 'density', 'enabled'], 'Filter mask');
  pixels(width, height);
  check(value.sourceWidth === width && value.sourceHeight === height, 'Filter-mask dimensions must match the working source.');
  bounded(value.density, 0, 1, 'Filter-mask density');
  check(typeof value.enabled === 'boolean', 'Filter-mask enabled must be boolean.');
  return { sourceWidth: width, sourceHeight: height, coverage: normalizeSourceFilterMaskDescriptor(value.coverage, width, height), density: value.density, enabled: value.enabled };
}
export function retainFilterMask(stack, entries) {
  const mask = storedFilterMask(stack);
  return entries.length && mask ? { version: 1, entries, mask: structuredClone(mask) } : entries;
}
export function filterMaskEvaluates(stack) {
  const entries = filterEntries(stack), mask = storedFilterMask(stack);
  return Boolean(mask && mask.enabled && mask.density > 0 && entries.some(entry => entry.enabled && entry.opacity > 0));
}
export function filterMaskStorageBytes(mask, { raw = false } = {}) {
  if (!mask || (!raw && (!mask.enabled || mask.density === 0))) return { coverageBytes: 0, lutBytes: 0 };
  const coverage = mask.coverage;
  return { coverageBytes: maskBufferBytes(coverage),
    lutBytes: !raw && mask.density > 0 && mask.density < 1 ? 256 : 0 };
}
export function filterMaskWork(stack, count) { return filterMaskEvaluates(stack) ? 8 * count : 0; }
export function estimateFilterMaskSourceBytes({ width, height, stack, spatialCacheBytes = 0, sharedBytes = 0 }) {
  const count = pixels(width, height), mask = storedFilterMask(stack);
  if (!filterMaskEvaluates(stack)) return { coverageBytes: 0, lutBytes: 0, maskBytes: 0, estimatedWorkingBytes: 0 };
  const { coverageBytes, lutBytes } = filterMaskStorageBytes(mask);
  const maskBytes = 8 * count + coverageBytes + lutBytes;
  return { coverageBytes, lutBytes, maskBytes, estimatedWorkingBytes: Math.max(12 * count + spatialCacheBytes, maskBytes) + sharedBytes };
}

/** Native byte-density policy, compiled once. No exact-real/IEEE reinterpretation. */
export function compileFilterMaskDensity(density) {
  bounded(density, 0, 1, 'Filter-mask density');
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i++) table[i] = density === 0 ? 255 : density === 1 ? i : quantize(255 - density * (255 - i));
  return table;
}

/** Exact legacy bitmap feather order, with bounded new-path scheduling. The
 * distance plane is local; only the alpha8 callback escapes preparation. */
export async function prepareBitmapCoverage(mask) {
  chargeMaskPreparation(mask);
  const { width, height } = mask, bytes = new Uint8Array(pixels(width, height));
  let visits = 0;
  for (let r = 0; r < mask.runs.length; r += 3) {
    const start = mask.runs[r], end = start + mask.runs[r + 1], value = mask.runs[r + 2];
    for (let i = start; i < end; i++) { bytes[i] = value; if (++visits === 65_536) { await yieldEventLoop(); visits = 0; } }
  }
  if (mask.feather > 0) {
    const distance = new Float32Array(bytes.length), maximum = mask.feather + 2;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = y * width + x;
      distance[i] = bytes[i] === 0 ? 0 : x === 0 || y === 0 || x === width - 1 || y === height - 1 ? 0.5 : maximum;
      if ((i + 1) % 65_536 === 0) await yieldEventLoop();
    }
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (x) distance[i] = Math.min(distance[i], distance[i - 1] + 1);
      if (y) distance[i] = Math.min(distance[i], distance[i - width] + 1);
      if (x && y) distance[i] = Math.min(distance[i], distance[i - width - 1] + Math.SQRT2);
      if (x < width - 1 && y) distance[i] = Math.min(distance[i], distance[i - width + 1] + Math.SQRT2);
      if ((i + 1) % 65_536 === 0) await yieldEventLoop();
    }
    for (let y = height - 1; y >= 0; y--) for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      if (x < width - 1) distance[i] = Math.min(distance[i], distance[i + 1] + 1);
      if (y < height - 1) distance[i] = Math.min(distance[i], distance[i + width] + 1);
      if (x < width - 1 && y < height - 1) distance[i] = Math.min(distance[i], distance[i + width + 1] + Math.SQRT2);
      if (x && y < height - 1) distance[i] = Math.min(distance[i], distance[i + width - 1] + Math.SQRT2);
      if (i % 65_536 === 0) await yieldEventLoop();
    }
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.round(bytes[i] * Math.min(1, distance[i] / mask.feather));
      if ((i + 1) % 65_536 === 0) await yieldEventLoop();
    }
  }
  return (x, y) => {
    const amount = x >= 0 && y >= 0 && x < width && y < height ? bytes[Math.floor(y) * width + Math.floor(x)] / 255 : 0;
    return mask.invert ? 1 - amount : amount;
  };
}
export async function prepareFilterMaskBytes(mask, { raw = false, resolveAlpha8 } = {}) {
  if (!raw && (!mask.enabled || mask.density === 0)) return () => 255;
  const table = !raw && mask.density < 1 ? compileFilterMaskDensity(mask.density) : null;
  const coverage = mask.coverage.shape === 'alpha8' ? await prepareMaskCoverage(mask.coverage, resolveAlpha8) : mask.coverage.shape === 'bitmap' ? await prepareBitmapCoverage(mask.coverage) : maskCoverage(mask.coverage);
  return (x, y) => { const value = quantize(255 * coverage(x, y)); return table ? table[value] : value; };
}
/** Called only after the stack evaluator returns its private output. No mask
 * callback or LUT escapes into later geometry/encoding. */
export async function mixFilterMask(original, filtered, width, height, mask, options = {}) {
  const count = pixels(width, height);
  check(Buffer.isBuffer(original) && Buffer.isBuffer(filtered) && original.length === count * 4 && filtered.length === original.length && original !== filtered, 'Filter-mask mixing requires a private filtered surface.');
  const coverage = await prepareFilterMaskBytes(mask, options);
  for (let p = 0; p < count; p++) {
    const i = p * 4;
    if (original[i + 3]) {
      const amount = coverage(p % width, Math.floor(p / width));
      for (let c = 0; c < 3; c++) filtered[i + c] = Math.floor((2 * (original[i + c] * (255 - amount) + filtered[i + c] * amount) + 255) / 510);
    } else for (let c = 0; c < 3; c++) filtered[i + c] = original[i + c];
    filtered[i + 3] = original[i + 3];
    if ((p + 1) % 65_536 === 0) await yieldEventLoop();
  }
  return filtered;
}

export function planFilterMaskCapture(layer, graph) {
  pixels(layer.width, layer.height); pixels(graph.width, graph.height);
  let dx = 0, dy = 0, left = 0, top = 0, right = layer.width, bottom = layer.height, width = layer.width, height = layer.height;
  check(Array.isArray(layer.transforms) && layer.transforms.length <= 500, 'Invalid source geometry.');
  for (const transform of layer.transforms) {
    pixels(transform.width, transform.height);
    if (transform.type === 'crop' && [transform.x, transform.y].every(Number.isInteger)) { dx -= transform.x; dy -= transform.y; }
    else if (transform.type === 'canvas' && [transform.x, transform.y].every(Number.isInteger)) { dx += transform.x; dy += transform.y; }
    else if (transform.type === 'affine' && transform.scaleX === 1 && transform.scaleY === 1 && transform.rotation === 0 && !transform.flipX && !transform.flipY && Number.isInteger(transform.x) && Number.isInteger(transform.y) && transform.width === width && transform.height === height) { dx += transform.x; dy += transform.y; }
    else fail('Capture requires only integer moves, crops and canvas bounds. Author a source-coordinate mask or capture before resampling, Distort or other affine transforms.', 'FILTER_MASK_CAPTURE_GEOMETRY');
    width = transform.width; height = transform.height;
    left = Math.max(left, -dx); top = Math.max(top, -dy); right = Math.min(right, width - dx); bottom = Math.min(bottom, height - dy);
  }
  check(width === graph.width && height === graph.height, 'Source geometry does not match the document.');
  const sampledWidth = Math.max(0, right - left), sampledHeight = Math.max(0, bottom - top), sampledPixels = sampledWidth * sampledHeight;
  return { dx, dy, left, top, right, bottom, sampledPixels, sampledRows: sampledPixels ? sampledHeight : 0 };
}
export function estimateFilterMaskCapture({ layer, graph }) {
  check(graph.selection, 'Create a selection before capturing a filter mask.', 'NO_SELECTION');
  const plan = planFilterMaskCapture(layer, graph), selection = normalizeMask(graph.selection, graph.width, graph.height, { persisted: true });
  if (['bitmap', 'alpha8'].includes(selection.shape)) check(selection.width === graph.width && selection.height === graph.height, 'Selection byte-mask dimensions must match the canvas.');
  const count = pixels(layer.width, layer.height), canvas = graph.width * graph.height, polygon = selection.shape === 'polygon', bitmap = ['bitmap', 'alpha8'].includes(selection.shape), points = polygon ? selection.points.length : 0;
  const rowWork = polygon ? points * (2 + Math.ceil(Math.log2(points))) : 0, pixelWork = 8 + 2 * points;
  const captureWork = count + pixelWork * plan.sampledPixels + rowWork * plan.sampledRows + (bitmap ? canvas * (selection.feather > 0 ? 8 : 1) : 0);
  const coverageBytes = maskBufferBytes(selection);
  return { ...plan, selection, captureWork, rowWork, pixelWork, coverageBytes, estimatedWorkingBytes: count + coverageBytes, maxWorkingBytes: FILTER_MASK_LIMITS.maxWorkingBytes, maxCaptureWork: FILTER_MASK_LIMITS.maxCaptureWork };
}
export async function encodeFilterMaskAlpha(alpha, width, height) {
  const count = pixels(width, height);
  check(alpha instanceof Uint8Array && alpha.length === count, 'Captured filter-mask alpha must match the source dimensions.');
  const runs = [];
  let start = 0, value = 0;
  const flush = end => {
    if (!value) return;
    check(runs.length + 3 <= FILTER_MASK_LIMITS.maxMaskScalars, 'The captured filter mask exceeds the bitmap complexity limit. Simplify the selection or reduce source dimensions.', 'LIMIT_EXCEEDED');
    runs.push(start, end - start, value);
  };
  for (let i = 0; i < count; i++) {
    const next = alpha[i];
    if (next !== value) { flush(i); start = i; value = next; }
    if ((i + 1) % 65_536 === 0) await yieldEventLoop();
  }
  flush(count);
  return { shape: 'bitmap', x: 0, y: 0, width, height, runs, feather: 0, invert: false };
}
export async function captureFilterMask(layer, graph, { resolveAlpha8, returnAlpha = false } = {}) {
  const plan = estimateFilterMaskCapture({ layer, graph });
  check(plan.captureWork <= plan.maxCaptureWork, 'Selection capture exceeds the 384-million filter-mask capture-work limit. Simplify the selection polygon or reduce source dimensions.', 'LIMIT_EXCEEDED');
  check(plan.estimatedWorkingBytes <= plan.maxWorkingBytes, 'Selection capture exceeds the 256 MiB filter-mask buffer limit.', 'LIMIT_EXCEEDED');
  const coverage = plan.selection.shape === 'alpha8' ? await prepareMaskCoverage(plan.selection, resolveAlpha8) : plan.selection.shape === 'bitmap' ? await prepareBitmapCoverage(plan.selection) : maskCoverage(plan.selection);
  const alpha = new Uint8Array(layer.width * layer.height);
  let pending = 0;
  for (let y = plan.top; y < plan.bottom && plan.sampledPixels; y++) {
    if (pending + plan.rowWork > 65_536) { await yieldEventLoop(); pending = 0; } pending += plan.rowWork;
    for (let x = plan.left; x < plan.right; x++) {
      if (pending + plan.pixelWork > 65_536) { await yieldEventLoop(); pending = 0; } pending += plan.pixelWork;
      alpha[y * layer.width + x] = quantize(255 * coverage(x + plan.dx, y + plan.dy));
    }
  }
  return returnAlpha ? alpha : encodeFilterMaskAlpha(alpha, layer.width, layer.height);
}
export async function editedFilterMask(layer, graph, command, args, options = {}) {
  const entries = filterEntries(layer.filters);
  check(entries.length > 0, 'Add a filter before creating or editing its shared mask.', 'NO_FILTERS');
  if (command === 'clear_layer_filter_mask') {
    check(storedFilterMask(layer.filters), 'This stack has no filter mask.', 'NO_FILTER_MASK');
    return structuredClone(entries);
  }
  let mask;
  if (command === 'modify_layer_filter_mask') {
    check(storedFilterMask(layer.filters), 'This stack has no filter mask.', 'NO_FILTER_MASK');
    mask = normalizeFilterMask(storedFilterMask(layer.filters), layer.width, layer.height);
    check(FILTER_MASK_PROPERTIES.some(key => args[key] !== undefined), 'Provide at least one filter-mask property.');
    for (const key of ['density', 'enabled']) if (args[key] !== undefined) mask[key] = args[key];
    for (const key of ['feather', 'invert']) if (args[key] !== undefined) mask.coverage[key] = args[key];
    mask = normalizeFilterMask(mask, layer.width, layer.height);
  } else {
    check(command === 'set_layer_filter_mask' && FILTER_MASK_SOURCES.includes(args.source), 'Choose a supported filter-mask source.');
    check((args.source === 'mask') === (args.mask !== undefined), 'A source descriptor is required only with source mask.');
    const coverage = args.source === 'selection' ? (options.captureSelection ? await options.captureSelection(layer, graph) : await captureFilterMask(layer, graph, options))
      : args.source === 'mask' ? normalizeSourceFilterMaskDescriptor(args.mask, layer.width, layer.height)
      : args.source === 'all' ? { shape: 'rectangle', x: 0, y: 0, width: layer.width, height: layer.height, feather: 0, invert: false }
      : { shape: 'bitmap', x: 0, y: 0, width: layer.width, height: layer.height, runs: [], feather: 0, invert: false };
    mask = { sourceWidth: layer.width, sourceHeight: layer.height, coverage, density: 1, enabled: true };
  }
  return { version: 1, entries: structuredClone(entries), mask };
}
