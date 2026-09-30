import { filterEntries, storedFilterMask } from './filter-mask.mjs';
import { DENSE_MASK_LIMITS, normalizeDenseMaskDescriptor } from '../shared/dense-mask.mjs';
import { validateSourceDocument } from './source-document.mjs';
import { COLOR_LOOKUP_LIMITS, normalizeColorLookupParameters } from '../shared/color-lookup.mjs';
const HASH = /^[a-f0-9]{64}$/;
const fail = (message, code = 'INVALID_PROJECT_BUNDLE') => { throw Object.assign(new Error(message), { code }); };
const compatible = (a, b) => a.bytes === b.bytes && a.gridSize === b.gridSize && a.inputSpace === b.inputSpace && a.title === b.title;
function add(uses, hash, use) {
  if (typeof hash !== 'string' || !HASH.test(hash)) fail('Project assets require immutable SHA-256 identifiers.');
  const prior = uses.get(hash);
  if (prior && (prior[0].type !== use.type || use.type === 'color-lookup' && !compatible(prior[0].parameters, use.parameters)
    || use.type === 'alpha8' && ['width', 'height', 'bytes'].some(key => prior[0].mask[key] !== use.mask[key])))
    fail('A project asset has incompatible typed references.');
  if (prior) prior.push(use); else uses.set(hash, [use]);
}
export function colorLookupEntries(graph) {
  const entries = [];
  for (const layer of graph.layers) {
    if (layer.type === 'adjustment' && layer.kind === 'color_lookup') entries.push(layer);
    for (const entry of filterEntries(layer.filters)) if (entry.kind === 'color_lookup') entries.push(entry);
  }
  return entries;
}
export const hasColorLookup = graph => colorLookupEntries(graph).length > 0;
export const hasActiveColorLookup = graph => colorLookupEntries(graph).some(entry => entry.enabled !== false && entry.opacity > 0);
/** One typed walker serves native validation, bundle references and history. */
export function projectAssetUses(graph) {
  const uses = new Map();
  const mask = (input, owner, field) => {
    const source = input?.shape === 'positioned' ? input.source : input;
    if (source?.shape === 'alpha8') { const descriptor = normalizeDenseMaskDescriptor(source, { persisted: true }); add(uses, descriptor.asset, { type: 'alpha8', mask: descriptor, owner, field }); }
  };
  mask(graph.selection, graph, 'selection');
  for (const saved of graph.savedSelections ?? []) mask(saved.mask, saved, 'savedSelection');
  for (const layer of graph.layers) {
    mask(layer.mask, layer, 'layerMask');
    mask(storedFilterMask(layer.filters)?.coverage, layer, 'filterMask');
    if (layer.type === 'raster') for (const field of ['asset', 'sourceAsset', 'alphaAsset']) if (layer[field] !== undefined) add(uses, layer[field], { type: 'raster', layer, field });
    const entries = layer.type === 'adjustment' ? [layer, ...filterEntries(layer.filters)] : filterEntries(layer.filters);
    for (const entry of entries) if (entry.kind === 'color_lookup') {
      const parameters = normalizeColorLookupParameters(entry.parameters);
      add(uses, parameters.asset, { type: 'color-lookup', layer, entry, parameters, field: 'colorLookup' });
    }
  }
  validateSourceDocument(graph);
  if (graph.sourceDocument) add(uses, graph.sourceDocument.asset, { type: 'source-document', sourceDocument: graph.sourceDocument, field: 'sourceDocument' });
  return uses;
}
export function validateColorLookupHistory(states) {
  const uses = new Map(), lookups = new Map(), masks = new Map();
  for (const state of states) for (const [hash, entries] of projectAssetUses(state.graph ?? state)) {
    for (const entry of entries) add(uses, hash, entry);
    if (entries[0].type === 'color-lookup') lookups.set(hash, entries[0].parameters);
    if (entries[0].type === 'alpha8') masks.set(hash, entries[0].mask);
  }
  let bytes = 0; for (const parameters of lookups.values()) bytes += parameters.bytes;
  if (lookups.size > COLOR_LOOKUP_LIMITS.maxHistoryAssets || bytes > COLOR_LOOKUP_LIMITS.maxHistoryBytes)
    fail('Retained history exceeds 128 Color Lookup assets or 64 MiB of original LUT files.', 'LIMIT_EXCEEDED');
  const maskBytes = [...masks.values()].reduce((sum, mask) => sum + mask.bytes, 0);
  if (masks.size > DENSE_MASK_LIMITS.maxHistoryAssets || maskBytes > DENSE_MASK_LIMITS.maxHistoryBytes)
    fail('Retained history exceeds 256 alpha8 masks or 3 GiB of framed mask bytes.', 'LIMIT_EXCEEDED');
  return lookups;
}
export function denseMaskHistoryAssets(states) {
  validateColorLookupHistory(states);
  const masks = new Map();
  for (const state of states) for (const [hash, uses] of projectAssetUses(state.graph ?? state)) if (uses[0].type === 'alpha8') masks.set(hash, uses[0].mask);
  return masks;
}
