import { COLOR_LOOKUP_LIMITS } from '../shared/color-lookup.mjs';
import { colorLookupCacheBytes, colorLookupGlobalPhaseBytes, validateColorLookupPreparation } from './color-lookup.mjs';
import { colorLookupEntries, hasActiveColorLookup } from './lookup-assets.mjs';
import { layerTree, groupNeedsSurface } from './groups.mjs';
import { clippingIndex, CLIPPING_RETAINED_BYTES_PER_PIXEL } from './clipping.mjs';
import { layerMaskStorageBytes, estimateLayerMaskCallbacks } from './layer-mask.mjs';
import { estimateDistortLeafBytes } from './distort-resources.mjs';
import { DISTORT_CONTENT_TYPES } from './distort.mjs';
import { layerFilterSharedBytes } from './layer-filters.mjs';
import { globalCurvesBanksCacheBytes } from './color.mjs';
const fail = message => { throw Object.assign(new Error(message), { code: 'LIMIT_EXCEEDED' }); };
export function validateColorLookupGlobalBytes(layer, width, height) {
  const n = width * height;
  const bytes = 5 * n + Math.max(colorLookupCacheBytes(layer.parameters), 4 * n + 24 * layer.parameters.gridSize ** 3 + 512 + layerMaskStorageBytes(layer));
  if (bytes > COLOR_LOOKUP_LIMITS.maxWorkingBytes) fail('Global Color Lookup input, output, table and mask exceed 256 MiB. Reduce dimensions or mask feather.');
  return bytes;
}
/** Opt-in named content/lookup phases. Encoded image inputs, existing global
 * spatial/style internals, codecs and total process RSS are outside scope. */
export function estimateColorLookupResources(graph, tree = layerTree(graph.layers)) {
  const preparationBytes = validateColorLookupPreparation(colorLookupEntries(graph));
  if (!hasActiveColorLookup(graph)) return { enabled: false, preparationBytes, estimatedWorkingBytes: 0 };
  const n = graph.width * graph.height, clipping = clippingIndex(tree);
  let retainedBytes = 0, leafBytes = 0, globalBytes = 0, sharedBytes = 0;
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
      leafBytes = Math.max(leafBytes, estimateDistortLeafBytes(layer, { canvasPixels: n }).estimatedWorkingBytes);
      sharedBytes = Math.max(sharedBytes, layerFilterSharedBytes(layer.filters));
    }
    if (layer.type === 'adjustment' && layer.kind === 'color_lookup' && layer.opacity > 0) {
      validateColorLookupGlobalBytes(layer, graph.width, graph.height);
      globalBytes = Math.max(globalBytes, colorLookupGlobalPhaseBytes(layer.parameters, n));
    }
  }
  for (const node of tree.roots) visit(node);
  const rootBytes = 6 * n, callbackBytes = estimateLayerMaskCallbacks(graph, { force: true }).estimatedCallbackBytes, globalCurvesBytes = globalCurvesBanksCacheBytes(graph);
  return { enabled: true, preparationBytes, rootBytes, retainedBytes, callbackBytes, sharedBytes, leafBytes, globalBytes, globalCurvesBytes,
    estimatedWorkingBytes: rootBytes + retainedBytes + callbackBytes + sharedBytes + Math.max(leafBytes, globalBytes) + globalCurvesBytes };
}
export function validateColorLookupResources(graph, tree) {
  const estimate = estimateColorLookupResources(graph, tree);
  if (estimate.estimatedWorkingBytes > COLOR_LOOKUP_LIMITS.maxWorkingBytes) fail('Color Lookup decoded content, root/group/clipping surfaces, tables and masks exceed 256 MiB. Reduce dimensions, active lookups, mask feather or retained geometry.');
  return estimate;
}
