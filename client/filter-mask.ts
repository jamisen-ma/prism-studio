import { denseCapabilityKey } from './dense-mask';
import type { Backend, BackendId, FilterMask, Layer } from './api';
import { filterOpacityPercent } from './filter-blend';

export const FILTER_MASK_POLICY = 'source-stack-alpha8-v1';
export const strings = (value: unknown): string[] => Array.isArray(value) && value.every(item => typeof item === 'string') ? value : [];
export const supportsFilterMask = (capabilities: Backend, backend: BackendId) => backend === 'native' && capabilities.id === backend && capabilities.layerFilterMaskPolicy === FILTER_MASK_POLICY && capabilities.layerFilterMaskCoordinates === 'source';
export const filterMaskCapabilityKey = (c: Backend) => JSON.stringify([denseCapabilityKey(c), c.id, c.commands, c.layerFilterMaskPolicy, c.layerFilterMaskCoordinates, c.layerFilterMaskSources, c.layerFilterMaskShapes, c.layerFilterMaskProperties, c.layerFilterMaskCaptureGeometry, c.limits?.maxFilterMaskWorkingBytes, c.limits?.maxFilterMaskCaptureWork]);
export function filterMaskSupport(c: Backend, backend: BackendId) {
  const supported = supportsFilterMask(c, backend), has = (name: string) => supported && c.commands.includes(name);
  return { supported, set: has('set_layer_filter_mask'), modify: has('modify_layer_filter_mask'), clear: has('clear_layer_filter_mask'), sources: strings(c.layerFilterMaskSources), shapes: strings(c.layerFilterMaskShapes), properties: strings(c.layerFilterMaskProperties), capture: c.layerFilterMaskCaptureGeometry === 'integer-copy-v1', preview: supported && c.commands.includes('get_mask_preview') && strings(c.maskPreviewSources).includes('filter-mask') && strings(c.maskPreviewMaskModes).some(mode => ['raw', 'effective'].includes(mode)) };
}
export const maskNumber = (text: string): number | undefined => {
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text.trim())) return;
  const value = Number(text); return Number.isFinite(value) ? value === 0 ? 0 : value : undefined;
};
export function maskDensity(text: string, stored: number): number | undefined {
  const percent = maskNumber(text);
  if (percent === undefined || percent < 0 || percent > 100) return;
  // Do not turn an unrelated refinement into a lossy percent round trip.
  return percent === Number(filterOpacityPercent(stored)) ? stored : percent / 100;
}
export type FilterMaskDraft = { density: string; feather: string; invert: boolean; enabled: boolean };
export const filterMaskDraft = (mask: FilterMask): FilterMaskDraft => ({ density: filterOpacityPercent(mask.density), feather: String(mask.coverage.feather ?? 0), invert: mask.coverage.invert ?? false, enabled: mask.enabled });
export function maskChanges(draft: FilterMaskDraft, mask: FilterMask) {
  const density = maskDensity(draft.density, mask.density), feather = maskNumber(draft.feather);
  if (density === undefined || feather === undefined || feather < 0 || feather > 100) return;
  return { ...(density !== mask.density ? { density } : {}), ...(feather !== (mask.coverage.feather ?? 0) ? { feather } : {}), ...(draft.invert !== Boolean(mask.coverage.invert) ? { invert: draft.invert } : {}), ...(draft.enabled !== mask.enabled ? { enabled: draft.enabled } : {}) };
}
export function canCaptureFilterSelection(layer: Layer): boolean {
  if (!Number.isInteger(layer.width) || !Number.isInteger(layer.height) || !layer.width || !layer.height || !Array.isArray(layer.transforms)) return false;
  let width = layer.width, height = layer.height;
  for (const t of layer.transforms) {
    const w = t.width, h = t.height, x = t.x, y = t.y;
    if (![w, h, x, y].every(Number.isInteger) || typeof w !== 'number' || typeof h !== 'number' || typeof x !== 'number' || typeof y !== 'number' || w < 1 || h < 1) return false;
    if (t.type === 'crop') { if (x < 0 || y < 0 || x + w > width || y + h > height) return false; width = w; height = h; }
    else if (t.type === 'canvas') { width = w; height = h; }
    else if (t.type === 'affine' && w === width && h === height && t.scaleX === 1 && t.scaleY === 1 && t.rotation === 0 && !t.flipX && !t.flipY) { /* Exact copy branch. Native owns intermediate clipping. */ }
    else return false;
  }
  return true;
}
