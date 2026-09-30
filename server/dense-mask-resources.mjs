import { DENSE_MASK_LIMITS } from '../shared/dense-mask.mjs';
import { maskBufferBytes, maskPreparationWork, isDenseMask } from './dense-mask.mjs';
import { layerTree, ancestors, groupNeedsSurface } from './groups.mjs';
import { clippingIndex, CLIPPING_RETAINED_BYTES_PER_PIXEL } from './clipping.mjs';
import { layerMaskSource, estimateLayerMaskCallbacks } from './layer-mask.mjs';
import { filterEntries, storedFilterMask, filterMaskEvaluates } from './filter-mask.mjs';
import { hasActiveFilters, layerFilterSharedBytes, layerFilterSpatialCacheBytes } from './layer-filters.mjs';
import { estimateDistortLeafBytes } from './distort-resources.mjs';
import { DISTORT_CONTENT_TYPES } from './distort.mjs';
import { globalCurvesBanksCacheBytes } from './color.mjs';
import { colorLookupGlobalPhaseBytes } from './color-lookup.mjs';
import { normalizeEffects } from './layer-effects.mjs';
import { layerOutsideEffects } from './layer-fill.mjs';
const fail = message => { throw Object.assign(new Error(message), { code: 'LIMIT_EXCEEDED' }); };
const count = n => { if (!Number.isSafeInteger(n) || n < 0) fail('Invalid dense-mask resource estimate.'); return n; };
export const additionalMaskWork = layer => layer.maskDensity === 0 ? 0 : maskPreparationWork(layer.mask);
export const sourceMaskWork = layer => filterMaskEvaluates(layer.filters) ? maskPreparationWork(storedFilterMask(layer.filters).coverage) : 0;
export const hasDenseMasks = graph => isDenseMask(graph.selection) || (graph.savedSelections ?? []).some(item => isDenseMask(item.mask))
  || graph.layers.some(layer => isDenseMask(layer.mask) || isDenseMask(storedFilterMask(layer.filters)?.coverage));
export const hasEvaluatingDenseMasks = graph => graph.layers.some(layer => layer.maskDensity !== 0 && isDenseMask(layer.mask)
  || filterMaskEvaluates(layer.filters) && isDenseMask(storedFilterMask(layer.filters).coverage));

export function denseSourceAuxiliaryBytes(layer) {
  let bytes = 0;
  for (const entry of filterEntries(layer.filters)) if (entry.enabled && entry.opacity > 0) {
    if (entry.kind === 'median' && entry.value > 1) bytes = Math.max(bytes, 3264);
    if (entry.kind === 'levels' || entry.kind === 'curves' && entry.parameters?.mode !== 'banks') bytes = Math.max(bytes, 256);
    if (entry.blendMode && entry.blendMode !== 'normal') bytes = Math.max(bytes, 8);
  }
  return bytes;
}
export function estimateDenseLeafBytes(layer, canvasPixels, { filters = true } = {}) {
  const old = estimateDistortLeafBytes(layer, { canvasPixels, filters });
  const active = filters && hasActiveFilters(layer), source = layer.width * layer.height;
  return Math.max(old.estimatedWorkingBytes, active ? 12 * source + Math.max(layerFilterSpatialCacheBytes(layer.filters, layer.width, layer.height), denseSourceAuxiliaryBytes(layer)) + old.proceduralBytes : 0);
}
export function denseDecorationBytes(layer, width, height) {
  // Legacy saved effects may omit default opacity/blur fields. Estimate the
  // same effective settings that renderOutsideEffects normalizes before use.
  const outsideEffects = layerOutsideEffects(layer);
  const settings = outsideEffects === undefined ? null : normalizeEffects(outsideEffects);
  const n = width * height, effects = Object.values(settings ?? {}).filter(effect => effect.opacity > 0);
  let padded = 0;
  for (const effect of effects) if (effect.blur >= .3) {
    const padding = Math.ceil(effect.blur * Math.sqrt(-2 * Math.log(.01))) + 1;
    padded = Math.max(padded, (width + 2 * padding) * (height + 2 * padding));
  }
  return Math.max(effects.length ? 10 * n + 3 * padded : 0, layer.outline?.width > 0 ? (effects.length ? 15 : 11) * n + 20 * height + 8 : 0);
}
export function denseGlobalBytes(layer, pixels) {
  if (layer.type !== 'adjustment' || layer.opacity === 0) return 0;
  if (layer.kind === 'color_lookup') return colorLookupGlobalPhaseBytes(layer.parameters, pixels);
  if (['median', 'mosaic', 'blur', 'sharpen'].includes(layer.kind)) return 8 * pixels + (layer.kind === 'median' && layer.value > 1 ? 3264 : 0);
  return 4 * pixels + (layer.kind === 'levels' || layer.kind === 'curves' && layer.parameters?.mode !== 'banks' ? 256 : 0);
}
export function protectedMaskPreparationWork(graph, beforeLayerId) {
  const tree = layerTree(graph.layers); let work = 0;
  for (const layer of graph.layers) {
    if (layer.id === beforeLayerId) break;
    if (!layer.protected || !DISTORT_CONTENT_TYPES.includes(layer.type)) continue;
    work += additionalMaskWork(layer) + sourceMaskWork(layer);
    for (const node of ancestors(tree.nodes.get(layer.id))) work += additionalMaskWork(node.layer);
  }
  return count(work);
}
/** Conservative metadata schedule. Hidden branches may be counted; repeated
 * protected ancestors are intentionally not deduplicated by ID or asset. */
export function denseMaskPreparationWork(graph, { filterContextGraph } = {}) {
  let work = 0;
  for (const layer of graph.layers) {
    work += additionalMaskWork(layer) + sourceMaskWork(layer);
    if (filterContextGraph && DISTORT_CONTENT_TYPES.includes(layer.type)) work += protectedMaskPreparationWork(filterContextGraph, layer.id);
  }
  return count(work);
}
export function estimateDenseMaskResources(graph, { force = false, filterContextGraph } = {}) {
  const enabled = force || hasEvaluatingDenseMasks(graph) || filterContextGraph && hasEvaluatingDenseMasks(filterContextGraph);
  if (!enabled) return { enabled: false, estimatedWorkingBytes: 0, preparationWork: 0 };
  const context = filterContextGraph ?? graph, n = count(context.width * context.height), tree = layerTree(context.layers), clipping = clippingIndex(tree);
  let retainedBytes = 0, leafBytes = 0, globalBytes = 0, decorationBytes = 0, sharedBytes = 0;
  function visit(node, retained = 0) {
    const layer = node.layer;
    if (layer.type === 'group') {
      if (groupNeedsSurface(layer)) retained += 5 * n;
      retainedBytes = Math.max(retainedBytes, retained);
      for (const child of node.children) visit(child, retained);
      return;
    }
    if (clipping.participants.has(layer.id)) retained += n * CLIPPING_RETAINED_BYTES_PER_PIXEL;
    retainedBytes = Math.max(retainedBytes, retained);
    if (DISTORT_CONTENT_TYPES.includes(layer.type)) {
      leafBytes = Math.max(leafBytes, estimateDenseLeafBytes(layer, n));
      decorationBytes = Math.max(decorationBytes, denseDecorationBytes(layer, context.width, context.height));
      sharedBytes = Math.max(sharedBytes, layerFilterSharedBytes(layer.filters));
    }
    globalBytes = Math.max(globalBytes, denseGlobalBytes(layer, n));
  }
  for (const node of tree.roots) visit(node);
  const rootBytes = 6 * n, callbackBytes = estimateLayerMaskCallbacks(context, { force: true }).estimatedCallbackBytes,
    globalCurvesBytes = globalCurvesBanksCacheBytes(context), preparationWork = denseMaskPreparationWork(graph, { filterContextGraph });
  return { enabled: true, rootBytes, retainedBytes, callbackBytes, leafBytes, globalBytes, decorationBytes, sharedBytes, globalCurvesBytes, preparationWork,
    estimatedWorkingBytes: count(rootBytes + retainedBytes + callbackBytes + sharedBytes + Math.max(leafBytes, globalBytes, decorationBytes) + globalCurvesBytes) };
}
export function assertDenseMaskBudget(bytes, work = 0) {
  if (count(bytes) > DENSE_MASK_LIMITS.maxWorkingBytes) fail('Dense mask rendering and retained operation buffers exceed 256 MiB. Reduce dimensions, feather, effects or retained sources.');
  if (count(work) > DENSE_MASK_LIMITS.maxPrepareWork) fail('Mask preparation exceeds 384 million weighted visits. Reduce mask dimensions, feather or repeated protected contexts.');
}
export function validateDenseMaskResources(graph, options = {}) {
  const estimate = estimateDenseMaskResources(graph, options);
  assertDenseMaskBudget(estimate.estimatedWorkingBytes, estimate.preparationWork);
  return estimate;
}
export function validateDenseMaskOperation(graph, { retainedBytes = 0, phases = [], additionalWork = 0, ...options } = {}) {
  const estimate = estimateDenseMaskResources(graph, { force: true, ...options });
  const estimatedWorkingBytes = Math.max(estimate.estimatedWorkingBytes + retainedBytes, ...phases, 0), preparationWork = estimate.preparationWork + additionalWork;
  assertDenseMaskBudget(estimatedWorkingBytes, preparationWork);
  return { ...estimate, estimatedWorkingBytes, preparationWork };
}
export { maskBufferBytes, maskPreparationWork };
