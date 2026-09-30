import { mergeColorLookupParameters } from '../shared/color-lookup.mjs';
import { colorLookupCacheBytes, validateColorLookupPreparation } from './color-lookup.mjs';
import { CURVES_BANKS_CACHE_BYTES } from '../shared/curves-banks.mjs';
import { randomUUID } from 'node:crypto';
import { validateLayerMaskResources } from './layer-mask.mjs';
import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import { ADJUSTMENTS, PARAMETERIZED_ADJUSTMENTS, normalizeParameters, mergeCurvesParameters, globalCurvesBanksCacheBytes, adjustmentTransform, colorTransformYieldRows } from './color.mjs';
import { spatialAdjustment } from './adjustment-filters.mjs';
import { MAX_GROUP_SCRATCH_BYTES, groupNeedsSurface } from './groups.mjs';
import { clippingIndex, CLIPPING_RETAINED_BYTES_PER_PIXEL } from './clipping.mjs';
import { SOURCE_SPATIAL_FILTER_KINDS, MAX_SOURCE_FILTER_WORK, sourceSpatialPlan, sourceSpatialCandidate } from './source-spatial-filters.mjs';
import { normalizeUnsharpParameters } from './unsharp-mask.mjs';
import { normalizeNoiseParameters, sourceNoiseCandidate } from './source-noise-filters.mjs';
import { normalizeLocalToneParameters, localTonePlan, localToneCandidate } from './local-tone.mjs';
import { selectiveColorIsIdentity } from './selective-color.mjs';
import { hueSaturationIsIdentity } from './hue-saturation.mjs';
import { photoFilterIsIdentity, mergePhotoFilterParameters } from './photo-filter.mjs';
import { GAUSSIAN_NOISE_TABLE_BYTES } from './noise-table.mjs';
import { normalizeFilterBlendMode, compileFilterBlend, layerFilterBlendWork } from './filter-blend.mjs';
import { filterEntries, storedFilterMask, normalizeFilterMask, retainFilterMask, filterMaskEvaluates, filterMaskWork, filterMaskStorageBytes, estimateFilterMaskSourceBytes, mixFilterMask } from './filter-mask.mjs';

export const LAYER_FILTER_RANGES = Object.freeze({ ...ADJUSTMENTS, unsharp_mask: Object.freeze([0, 0]), add_noise: Object.freeze([0, 0]), high_pass: Object.freeze([0, 50]), shadows_highlights: Object.freeze([0, 0]) });
export const LAYER_FILTER_KINDS = Object.freeze(Object.keys(LAYER_FILTER_RANGES));
export const LAYER_FILTER_PARAMETERIZED_KINDS = Object.freeze([...PARAMETERIZED_ADJUSTMENTS, 'unsharp_mask', 'add_noise', 'shadows_highlights']);
export const normalizeLayerFilterParameters = (kind, parameters) => kind === 'unsharp_mask' ? normalizeUnsharpParameters(parameters)
  : kind === 'add_noise' ? normalizeNoiseParameters(parameters) : kind === 'shadows_highlights' ? normalizeLocalToneParameters(parameters) : normalizeParameters(kind, parameters);
export const LAYER_FILTER_COMMANDS = Object.freeze(['add_layer_filter', 'update_layer_filter', 'reorder_layer_filter', 'delete_layer_filter', 'clear_layer_filters']);
export const MAX_FILTERS_PER_LAYER = 8;
export const MAX_FILTERS_PER_DOCUMENT = 64;
export const MAX_FILTER_WORK = MAX_SOURCE_FILTER_WORK;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const FIELDS = new Set(['id', 'kind', 'value', 'parameters', 'enabled', 'opacity', 'blendMode']);
const INTEGER_KINDS = new Set(['posterize', 'threshold', 'median', 'mosaic']);
const fail = (message, code = 'INVALID_ARGUMENT') => { throw Object.assign(new Error(message), { code }); };
const check = (valid, message, code) => { if (!valid) fail(message, code); };
const byte = (value) => Math.max(0, Math.min(255, Math.round(value)));
export const hasActiveFilters = (layer) => filterEntries(layer.filters).some((entry) => entry.enabled && entry.opacity > 0);

export function normalizeLayerFilter(entry, { defaults = false } = {}) {
  check(entry && typeof entry === 'object' && !Array.isArray(entry) && Object.keys(entry).every((key) => FIELDS.has(key)), 'Unsupported layer filter fields.');
  check(typeof entry.id === 'string' && UUID.test(entry.id), 'A layer filter requires a UUID identifier.');
  check(LAYER_FILTER_KINDS.includes(entry.kind), 'This kind is unavailable as an editable layer filter.', 'UNSUPPORTED');
  const [min, max] = LAYER_FILTER_RANGES[entry.kind], value = entry.value;
  check(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && (!INTEGER_KINDS.has(entry.kind) || Number.isInteger(value)), `Filter ${entry.kind} value must be ${INTEGER_KINDS.has(entry.kind) ? 'an integer ' : ''}between ${min} and ${max}.`);
  check(entry.kind !== 'median' || value % 2 === 1, 'Median size must be odd.');
  const enabled = defaults && entry.enabled === undefined ? true : entry.enabled;
  const opacity = defaults && entry.opacity === undefined ? 1 : entry.opacity;
  check(typeof enabled === 'boolean', 'Filter enabled must be boolean.');
  check(typeof opacity === 'number' && Number.isFinite(opacity) && opacity >= 0 && opacity <= 1, 'Filter opacity must be between zero and one.');
  const parameters = normalizeLayerFilterParameters(entry.kind, entry.parameters);
  const blendMode = normalizeFilterBlendMode(entry.blendMode);
  return { id: entry.id, kind: entry.kind, value, enabled, opacity, ...(parameters ? { parameters } : {}), ...(blendMode ? { blendMode } : {}) };
}

export function normalizeLayerFilters(entries = []) {
  const mask = storedFilterMask(entries);
  if (mask) normalizeFilterMask(mask);
  entries = filterEntries(entries);
  check(Array.isArray(entries), 'Layer filters must be an array.');
  check(entries.length <= MAX_FILTERS_PER_LAYER, 'A raster layer supports at most eight editable filters.', 'LIMIT_EXCEEDED');
  const seen = new Set();
  return entries.map((entry) => {
    const result = normalizeLayerFilter(entry);
    check(!seen.has(result.id), 'Filter identifiers must be unique within a layer.'); seen.add(result.id);
    return result;
  });
}

export function editedFilterStack(entries, command, args) {
  return retainFilterMask(entries, editedFilterEntries(entries, command, args));
}
function editedFilterEntries(entries, command, args) {
  const stack = normalizeLayerFilters(entries);
  if (command === 'clear_layer_filters') return [];
  if (command === 'add_layer_filter') {
    check(stack.length < MAX_FILTERS_PER_LAYER, 'A raster layer supports at most eight editable filters.', 'LIMIT_EXCEEDED');
    const entry = { id: randomUUID(), kind: args.kind, value: args.value };
    for (const key of ['parameters', 'enabled', 'opacity', 'blendMode']) if (args[key] !== undefined) entry[key] = args[key];
    stack.push(normalizeLayerFilter(entry, { defaults: true })); return stack;
  }
  check(typeof args.filterId === 'string' && UUID.test(args.filterId), 'Choose an existing layer filter.');
  const index = stack.findIndex((entry) => entry.id === args.filterId);
  check(index >= 0, 'Layer filter was not found.', 'NOT_FOUND');
  if (command === 'delete_layer_filter') stack.splice(index, 1);
  else if (command === 'reorder_layer_filter') {
    check(Number.isInteger(args.index) && args.index >= 0 && args.index < stack.length, 'Filter index must identify a position in the current stack.');
    stack.splice(args.index, 0, stack.splice(index, 1)[0]);
  } else if (command === 'update_layer_filter') {
    check(['value', 'parameters', 'enabled', 'opacity', 'blendMode'].some((key) => args[key] !== undefined), 'Provide at least one filter setting to update.');
    const entry = { ...stack[index] };
    for (const key of ['value', 'enabled', 'opacity', 'blendMode']) if (args[key] !== undefined) entry[key] = args[key];
    if (args.parameters !== undefined) {
      check(args.parameters && typeof args.parameters === 'object' && !Array.isArray(args.parameters), 'Filter parameters must be an object.');
      entry.parameters = entry.kind === 'photo_filter' ? mergePhotoFilterParameters(entry.parameters, args.parameters) : entry.kind === 'color_lookup' ? mergeColorLookupParameters(entry.parameters, args.parameters) : entry.kind === 'curves' ? mergeCurvesParameters(entry.parameters, args.parameters) : { ...entry.parameters, ...args.parameters };
    }
    stack[index] = normalizeLayerFilter(entry);
  } else fail('Unsupported layer filter command.', 'UNSUPPORTED');
  return stack;
}

// Conservative admission weights include authored images that hit the exact
// Color Balance fallback at every pixel; this is not a blanket 24 MP promise.
// Median accounts for sliding-window updates and histogram lookup.
function candidateWork(entry, pixels) {
  if (entry.kind === 'photo_filter') {
    const identity = photoFilterIsIdentity(entry.parameters);
    return entry.enabled && entry.opacity > 0 ? pixels * (identity ? 1 : 16) : 0;
  }
  if (entry.kind === 'color_lookup') return entry.enabled && entry.opacity > 0 ? 32 * pixels : 0;
  if (entry.kind === 'hue_saturation') {
    const identity = hueSaturationIsIdentity(entry.parameters);
    return entry.enabled && entry.opacity > 0 ? pixels * (identity ? 1 : 32) : 0;
  }
  if (entry.kind === 'selective_color') {
    const identity = selectiveColorIsIdentity(entry.parameters);
    return entry.enabled && entry.opacity > 0 ? pixels * (identity ? 1 : 12) : 0;
  }
  if (entry.kind === 'shadows_highlights') {
    const { shadows, highlights, sigma } = normalizeLocalToneParameters(entry.parameters);
    return entry.enabled && entry.opacity > 0 ? pixels * (shadows === 0 && highlights === 0 ? 1 : sigma === 0 ? 16 : 2 * (2 * Math.ceil(3 * sigma) + 1) + 20) : 0;
  }
  if (entry.kind === 'add_noise') {
    const { amount } = normalizeNoiseParameters(entry.parameters);
    return entry.enabled && entry.opacity > 0 ? pixels * (amount > 0 ? 8 : 1) : 0;
  }
  if (entry.kind === 'unsharp_mask') {
    const { amount, sigma, threshold } = normalizeUnsharpParameters(entry.parameters);
    const identity = amount === 0 || sigma === 0 || threshold === 255;
    return entry.enabled && entry.opacity > 0 ? pixels * (identity ? 1 : 2 * (2 * Math.ceil(3 * sigma) + 1) + 40) : 0;
  }
  if (SOURCE_SPATIAL_FILTER_KINDS.includes(entry.kind)) {
    const taps = 2 * Math.ceil(3 * entry.value) + 1;
    return entry.enabled && entry.opacity > 0 ? pixels * (entry.value === 0 ? 1 : 2 * taps + 8) : 0;
  }
  const weight = entry.kind === 'color_balance' ? (entry.parameters?.preserveLuminosity === false ? 10 : 40)
    : entry.kind === 'black_white' ? 7 : entry.kind === 'median' ? 32 + 2 * entry.value
      : entry.kind === 'gradient_map' ? 5 : ['mosaic', 'channel_mixer'].includes(entry.kind) ? 3 : 1;
  return entry.enabled && entry.opacity > 0 ? pixels * weight : 0;
}

export function filterWork(entry, pixels) {
  return candidateWork(entry, pixels) + layerFilterBlendWork(entry, pixels);
}

/** Entries run sequentially. The largest spatial ring or Curves compiler
 * table belongs only to its candidate, not later geometry or another entry. */
export function layerFilterSpatialCacheBytes(filters, width, height) {
  return filterEntries(filters).reduce((maximum, entry) => entry.kind === 'color_lookup' && entry.enabled && entry.opacity > 0 ? Math.max(maximum, colorLookupCacheBytes(entry.parameters)) : entry.kind === 'curves' && entry.parameters?.mode === 'banks' && entry.enabled && entry.opacity > 0
    ? Math.max(maximum, CURVES_BANKS_CACHE_BYTES) : entry.kind === 'shadows_highlights'
    ? Math.max(maximum, localTonePlan(entry, width, height).cacheBytes) : SOURCE_SPATIAL_FILTER_KINDS.includes(entry.kind)
      ? Math.max(maximum, sourceSpatialPlan(entry, width, height).cacheBytes) : maximum, 0);
}

/** Unlike a sequential spatial ring, this one private table remains resident
 * through later entries, other graph leaves and every bake phase. Metadata
 * checks must not initialize it. Charge once for each operation using it. */
export function layerFilterSharedBytes(filters) {
  return filterEntries(filters).some(entry => {
    if (entry.kind !== 'add_noise' || !entry.enabled || entry.opacity <= 0) return false;
    const parameters = normalizeNoiseParameters(entry.parameters);
    return parameters.amount > 0 && parameters.distribution === 'gaussian';
  })
    ? GAUSSIAN_NOISE_TABLE_BYTES : 0;
}

export function validateLayerFilterResources(graph, tree) {
  const clipping = clippingIndex(tree);
  let count = 0, work = 0, sharedBytes = 0;
  for (const layer of graph.layers) {
    check(!Object.hasOwn(layer, 'filterMask'), 'filterMask is read-only document projection metadata; persisted graphs require the strict filters wrapper.');
    if (layer.filters !== undefined) check(layer.type === 'raster', 'Editable filter stacks require raster layers.', 'INVALID_TARGET');
    const entries = normalizeLayerFilters(layer.filters);
    const mask = storedFilterMask(layer.filters);
    if (mask) normalizeFilterMask(mask, layer.width, layer.height);
    count += entries.length;
    sharedBytes = Math.max(sharedBytes, layerFilterSharedBytes(entries));
    check(!layer.protected || !hasActiveFilters({ filters: entries }), 'Disable or clear every active filter before protecting this layer.', 'PROTECTED_LAYER');
    for (const entry of entries) work += filterWork(entry, layer.width * layer.height);
    work += filterMaskWork(layer.filters, layer.width * layer.height);
  }
  check(count <= MAX_FILTERS_PER_DOCUMENT, 'A document supports at most 64 editable filter entries, including disabled entries.', 'LIMIT_EXCEEDED');
  check(work <= MAX_FILTER_WORK, 'Editable filters exceed the 384-million weighted source-pixel work budget. Every nonnormal filter blend adds 40 visits per source pixel. Source blur/sharpen/High Pass cost 2*(2*ceil(3*sigma)+1)+8 when positive; Unsharp Mask costs 2*(2*ceil(3*sigma)+1)+40. Local Shadows / Highlights costs 16 at sigma zero or 2*(2*ceil(3*sigma)+1)+20 when positive. Add Noise costs 8; Photo Filter costs 16 when computing; Color Lookup costs 32 even for identity tables; known identity candidates and High Pass at zero sigma cost 1 before blending. Color Balance costs 40 with luminosity preservation or 10 without; Black & White costs 7. Reduce filter count, spatial sigma or source dimensions, or choose Normal blending.', 'LIMIT_EXCEEDED');
  const canvasPixels = graph.width * graph.height;
  let retainedScratchBytes = 0;
  function visit(node, retained = 0) {
    const layer = node.layer;
    if (layer.type === 'group') {
      if (groupNeedsSurface(layer)) retained += canvasPixels * 5;
      retainedScratchBytes = Math.max(retainedScratchBytes, retained);
      for (const child of node.children) visit(child, retained);
    } else {
      if (clipping.participants.has(layer.id)) retained += canvasPixels * CLIPPING_RETAINED_BYTES_PER_PIXEL;
      retainedScratchBytes = Math.max(retainedScratchBytes, retained);
      check(retained <= MAX_GROUP_SCRATCH_BYTES, 'Combined group and clipping-chain scratch exceeds 256 MiB. Reduce nesting or canvas dimensions.', 'LIMIT_EXCEEDED');
      if (!hasActiveFilters(layer)) return;
      let largest = layer.width * layer.height;
      for (const transform of layer.transforms) largest = Math.max(largest, transform.width * transform.height);
      // In addition to the existing base renderer: one mutable filter surface,
      // one spatial candidate/original geometry surface, and contextual alpha.
      const sourcePixels = layer.width * layer.height;
      const spatialCache = layerFilterSpatialCacheBytes(layer.filters ?? [], layer.width, layer.height);
      let maskScratch = 0;
      if (filterMaskEvaluates(layer.filters)) {
        const estimate = estimateFilterMaskSourceBytes({ width: layer.width, height: layer.height, stack: layer.filters, spatialCacheBytes: spatialCache, sharedBytes });
        check(estimate.estimatedWorkingBytes <= MAX_GROUP_SCRATCH_BYTES, 'The complete masked filter source exceeds 256 MiB before decoding. Reduce source dimensions, mask feather or spatial sigma, or disable the filter mask.', 'LIMIT_EXCEEDED');
        maskScratch = sourcePixels * 4 + estimate.coverageBytes + estimate.lutBytes;
      }
      const scratch = Math.max(largest * 8, sourcePixels * 8 + spatialCache, maskScratch) + canvasPixels;
      retainedScratchBytes = Math.max(retainedScratchBytes, retained + scratch);
      check(retained + scratch <= MAX_GROUP_SCRATCH_BYTES, 'Combined group and editable-filter scratch exceeds 256 MiB. Reduce group nesting, source spatial sigma or image dimensions.', 'LIMIT_EXCEEDED');
    }
  }
  for (const node of tree.roots) visit(node);
  return validateLayerMaskResources(graph, retainedScratchBytes + sharedBytes + globalCurvesBanksCacheBytes(graph));
}

async function mosaicCandidate(input, width, height, size) {
  const output = Buffer.from(input);
  for (let top = 0; top < height; top += size) {
    for (let left = 0; left < width; left += size) {
      const bottom = Math.min(height, top + size), right = Math.min(width, left + size);
      let red = 0, green = 0, blue = 0, alpha = 0;
      for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
        const i = (y * width + x) * 4, a = input[i + 3];
        red += input[i] * a; green += input[i + 1] * a; blue += input[i + 2] * a; alpha += a;
      }
      if (!alpha) continue;
      red = byte(red / alpha); green = byte(green / alpha); blue = byte(blue / alpha);
      for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
        const i = (y * width + x) * 4;
        if (input[i + 3]) { output[i] = red; output[i + 1] = green; output[i + 2] = blue; }
      }
    }
    if (size >= 32 || (top / size + 1) % Math.ceil(32 / size) === 0) await yieldEventLoop();
  }
  return output;
}

export async function applyLayerFilters(input, width, height, filters = [], options = {}) {
  check(Buffer.isBuffer(input) && Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 24_000_000 && input.length === width * height * 4, 'Invalid editable filter image dimensions.');
  const entries = normalizeLayerFilters(filters);
  validateColorLookupPreparation(entries);
  check(entries.reduce((sum, entry) => sum + filterWork(entry, width * height), 0) + filterMaskWork(filters, width * height) <= MAX_FILTER_WORK, 'Editable filters and their shared mask exceed the weighted source-pixel work budget.', 'LIMIT_EXCEEDED');
  const mask = storedFilterMask(filters);
  if (mask) {
    normalizeFilterMask(mask, width, height);
    const evaluates = filterMaskEvaluates(filters);
    if (evaluates) {
      const estimate = estimateFilterMaskSourceBytes({ width, height, stack: filters, spatialCacheBytes: layerFilterSpatialCacheBytes(entries, width, height), sharedBytes: layerFilterSharedBytes(entries) });
      check(estimate.estimatedWorkingBytes <= MAX_GROUP_SCRATCH_BYTES, 'The complete masked filter source exceeds the 256 MiB buffer limit.', 'LIMIT_EXCEEDED');
    }
    // Finish the existing evaluator first: its candidate/ring cannot be
    // retained by the later mask callback. Inactive stacks return input.
    const filtered = await applyLayerFilters(input, width, height, entries, options);
    return evaluates ? mixFilterMask(input, filtered, width, height, mask, options) : filtered;
  }
  const sharedBytes = layerFilterSharedBytes(entries);
  if (sharedBytes || entries.some(entry => (entry.kind === 'color_lookup' || entry.kind === 'curves' && entry.parameters?.mode === 'banks') && entry.enabled && entry.opacity > 0)) check(width * height * 8 + layerFilterSpatialCacheBytes(entries, width, height) + sharedBytes <= MAX_GROUP_SCRATCH_BYTES,
    'Editable-filter candidates, spatial cache and shared noise table exceed 256 MiB.', 'LIMIT_EXCEEDED');
  if (!hasActiveFilters({ filters: entries })) return input;
  if (entries.some(entry => entry.kind === 'color_lookup' && entry.enabled && entry.opacity > 0)) check(typeof options.prepareColorLookup === 'function', 'Color Lookup requires a verified asset resolver.');
  const output = Buffer.from(input);
  for (const entry of entries) {
    if (!entry.enabled || entry.opacity === 0) continue;
    const identityCandidate = SOURCE_SPATIAL_FILTER_KINDS.includes(entry.kind) && !sourceSpatialPlan(entry, width, height).computesCandidate
      || entry.kind === 'add_noise' && entry.parameters.amount === 0
      || entry.kind === 'shadows_highlights' && !localTonePlan(entry, width, height).computesCandidate;
    if (identityCandidate && !entry.blendMode) continue;
    // Opacity compilation precedes the candidate peak; its tiny IEEE view is
    // not retained. Normal keeps its original interpolation and yield path.
    const blend = entry.blendMode ? compileFilterBlend(entry.blendMode, entry.opacity) : null;
    const back = blend ? [0, 0, 0] : null, front = blend ? [0, 0, 0] : null, mixed = blend ? [0, 0, 0] : null;
    // The working output is private. Each candidate observes the complete
    // previous stage before RGB interpolation changes any current-stage pixel.
    const candidate = identityCandidate ? output : SOURCE_SPATIAL_FILTER_KINDS.includes(entry.kind) ? await sourceSpatialCandidate(output, width, height, entry)
      : entry.kind === 'add_noise' ? await sourceNoiseCandidate(output, width, height, entry)
      : entry.kind === 'shadows_highlights' ? await localToneCandidate(output, width, height, entry)
      : entry.kind === 'mosaic' ? await mosaicCandidate(output, width, height, entry.value)
      : entry.kind === 'median' ? await spatialAdjustment(output, width, height, entry) : null;
    if (entry.kind === 'color_lookup') check(typeof options.prepareColorLookup === 'function', 'Color Lookup requires a verified asset resolver.');
    const transform = candidate ? null : entry.kind === 'color_lookup' ? await options.prepareColorLookup(entry.parameters) : adjustmentTransform(entry);
    const oldYieldRows = entry.kind === 'shadows_highlights' || (entry.kind === 'curves' && entry.parameters?.mode === 'banks') ? Math.min(32, Math.max(1, Math.floor(65_536 / width))) : colorTransformYieldRows(entry.kind, width);
    const yieldRows = blend ? Math.min(oldYieldRows, Math.max(1, Math.floor(16_384 / width))) : oldYieldRows;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (!output[i + 3]) continue;
        const adjusted = candidate ? null : transform(output[i], output[i + 1], output[i + 2]);
        if (blend) {
          for (let channel = 0; channel < 3; channel++) { back[channel] = output[i + channel]; front[channel] = candidate ? candidate[i + channel] : adjusted[channel]; }
          blend(back, front, mixed);
          for (let channel = 0; channel < 3; channel++) output[i + channel] = mixed[channel];
          continue;
        }
        for (let channel = 0; channel < 3; channel++) output[i + channel] = byte(output[i + channel] + ((candidate ? candidate[i + channel] : adjusted[channel]) - output[i + channel]) * entry.opacity);
      }
      if ((y + 1) % yieldRows === 0) await yieldEventLoop();
    }
  }
  return output;
}
