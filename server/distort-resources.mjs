import { globalCurvesBanksCacheBytes } from './color.mjs';
import { DISTORT_LIMITS, DISTORT_CONTENT_TYPES } from './distort.mjs';
import { layerTree, groupNeedsSurface } from './groups.mjs';
import { clippingIndex, CLIPPING_RETAINED_BYTES_PER_PIXEL } from './clipping.mjs';
import { estimateLayerMaskCallbacks } from './layer-mask.mjs';
import { hasActiveFilters, layerFilterSpatialCacheBytes, layerFilterSharedBytes } from './layer-filters.mjs';
import { filterMaskEvaluates, filterMaskStorageBytes, storedFilterMask } from './filter-mask.mjs';
const fail = message => { throw Object.assign(new Error(message), { code: 'LIMIT_EXCEEDED' }); };
function count(value) { if (!Number.isSafeInteger(value) || value < 0) fail('Invalid Distort buffer/work estimate.'); return value; }
export const hasDistort = graph => graph.layers.some(layer => layer.transforms?.some(transform => transform.type === 'distort'));

/** Decoded phases only. Original source stays live; first previous aliases
 * input. Ring, deferred source mask and geometry are sequential maxima. */
export function estimateDistortLeafBytes(layer, { canvasPixels, filters = true } = {}) {
  const source = count(layer.width * layer.height), active = filters && hasActiveFilters(layer);
  let peak = source * (layer.alphaAsset ? 9 : 4), previous = source;
  const spatialCacheBytes = active ? layerFilterSpatialCacheBytes(layer.filters, layer.width, layer.height) : 0;
  if (active) peak = Math.max(peak, 12 * source + spatialCacheBytes);
  let maskBytes = 0;
  if (active && filterMaskEvaluates(layer.filters)) {
    const { coverageBytes, lutBytes } = filterMaskStorageBytes(storedFilterMask(layer.filters));
    maskBytes = 8 * source + coverageBytes + lutBytes;
    peak = Math.max(peak, maskBytes);
  }
  let first = true;
  for (const transform of layer.transforms ?? []) {
    const next = count(transform.width * transform.height), previousBytes = first ? 0 : 4 * previous;
    peak = Math.max(peak, (active ? 8 : 4) * source + previousBytes + 4 * next);
    if (active) peak = Math.max(peak, 8 * source + 4 * canvasPixels + previousBytes + 4 * next);
    first = false; previous = next;
  }
  const proceduralBytes = layer.type === 'gradient' ? 4 * source : ['text', 'shape', 'path'].includes(layer.type) ? 1024 * 1024 : 0;
  return { sourcePixels: source, spatialCacheBytes, maskBytes, proceduralBytes, estimatedWorkingBytes: count(peak + proceduralBytes) };
}

/** Stronger opt-in graph envelope. Cross-branch protected inspection can
 * render a legacy sibling while another branch's ancestors remain retained.
 * Root6N, global ancestor maximum, all bitmap callbacks and shared table join
 * the largest decoded leaf phase. Encoded buffers/codec/styles/RSS excluded. */
export function estimateDistortResources(graph, tree = layerTree(graph.layers)) {
  if (!hasDistort(graph)) return { enabled: false, work: 0, estimatedWorkingBytes: 0, maxWorkingBytes: DISTORT_LIMITS.maxWorkingBytes, maxWork: DISTORT_LIMITS.maxWork };
  const canvasPixels = count(graph.width * graph.height), clipping = clippingIndex(tree);
  let retainedBytes = 0, leafBytes = 0, sharedBytes = 0, work = 0;
  function visit(node, retained = 0) {
    const layer = node.layer;
    if (layer.type === 'group') {
      if (groupNeedsSurface(layer)) retained += canvasPixels * 5;
      retainedBytes = Math.max(retainedBytes, retained);
      for (const child of node.children) visit(child, retained);
      return;
    }
    if (clipping.participants.has(layer.id)) retained += canvasPixels * CLIPPING_RETAINED_BYTES_PER_PIXEL;
    retainedBytes = Math.max(retainedBytes, retained);
    if (!DISTORT_CONTENT_TYPES.includes(layer.type)) return;
    leafBytes = Math.max(leafBytes, estimateDistortLeafBytes(layer, { canvasPixels }).estimatedWorkingBytes);
    sharedBytes = Math.max(sharedBytes, layerFilterSharedBytes(layer.filters));
    for (const transform of layer.transforms) if (transform.type === 'distort') work += 16 * count(transform.width * transform.height);
  }
  for (const node of tree.roots) visit(node);
  const callbackBytes = estimateLayerMaskCallbacks(graph, { force: true }).estimatedCallbackBytes, rootBytes = 6 * canvasPixels, globalCurvesBytes = globalCurvesBanksCacheBytes(graph);
  return { enabled: true, work: count(work), rootBytes, retainedBytes: count(retainedBytes), callbackBytes: count(callbackBytes), sharedBytes, leafBytes, ...(globalCurvesBytes ? { globalCurvesBytes } : {}), estimatedWorkingBytes: count(rootBytes + retainedBytes + callbackBytes + sharedBytes + leafBytes + globalCurvesBytes), maxWorkingBytes: DISTORT_LIMITS.maxWorkingBytes, maxWork: DISTORT_LIMITS.maxWork };
}
export function validateDistortResources(graph, tree) {
  const estimate = estimateDistortResources(graph, tree);
  if (estimate.work > estimate.maxWork) fail('Distort stages exceed the 384-million weighted stage-pixel work limit. Reduce stage count or frame dimensions.');
  if (estimate.estimatedWorkingBytes > estimate.maxWorkingBytes) fail('Distort graph decoded frames, masks and retained renderer surfaces exceed 256 MiB. Reduce source/canvas dimensions, geometry stages, mask feather or group nesting.');
  return estimate;
}
