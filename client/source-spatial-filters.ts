import { supportsPhotoFilter } from './photo-filter';
import { supportsColorLookup } from './color-lookup';
import { supportsTargetedHSL } from './targeted-hsl';
import { supportsSelectiveColor } from './selective-color';
import type { Backend, BackendId } from './api';

export const SOURCE_SPATIAL_POLICY = 'alpha-weighted-gaussian-rgb-v1';
export const SOURCE_SPATIAL_DEFINITIONS = [
  { id: 'blur', label: 'Gaussian Blur', min: 0, max: 50, step: .1, unit: 'source px', initial: 3 },
  { id: 'sharpen', label: 'Sharpen (RGB)', min: 0, max: 10, step: .1, unit: 'source px', initial: 1 },
  { id: 'high_pass', label: 'High Pass', min: 0, max: 50, step: .1, unit: 'source px', initial: 1 },
];
export const isSourceSpatialKind = (kind: unknown): kind is 'blur' | 'sharpen' | 'high_pass' => kind === 'blur' || kind === 'sharpen' || kind === 'high_pass';
export function supportsSourceSpatialKind(capabilities: Backend, backend: BackendId, kind: unknown) {
  return isSourceSpatialKind(kind) && backend === 'native' && capabilities.id === backend && capabilities.layerFilterCoordinates === 'source' && (kind === 'high_pass' ? capabilities.layerFilterHighPassPolicy === 'alpha-weighted-residual-128-v1' : capabilities.layerFilterSpatialPolicy === SOURCE_SPATIAL_POLICY) && capabilities.layerFilterKinds?.includes(kind) === true;
}
export function parseSourceSigma(kind: string, text?: string): number | undefined {
  if (!isSourceSpatialKind(kind) || typeof text !== 'string' || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text.trim())) return;
  const value = Number(text);
  if (Number.isFinite(value) && value >= 0 && value <= (kind === 'sharpen' ? 10 : 50)) return value === 0 ? 0 : value;
}

export const isPolicySourceKind = (kind: unknown): kind is 'blur' | 'sharpen' | 'high_pass' | 'unsharp_mask' | 'add_noise' | 'shadows_highlights' | 'selective_color' | 'hue_saturation' | 'color_lookup' | 'photo_filter' => isSourceSpatialKind(kind) || kind === 'unsharp_mask' || kind === 'add_noise' || kind === 'shadows_highlights' || kind === 'selective_color' || kind === 'hue_saturation' || kind === 'color_lookup' || kind === 'photo_filter';
export function supportsPolicySourceKind(capabilities: Backend, backend: BackendId, kind: unknown) {
  if (kind === 'photo_filter') return supportsPhotoFilter(capabilities, backend, 'source');
  if (kind === 'color_lookup') return supportsColorLookup(capabilities, backend, 'source');
  if (kind === 'hue_saturation') return supportsTargetedHSL(capabilities, backend, 'source');
  if (kind === 'selective_color') return supportsSelectiveColor(capabilities, backend, 'source');
  if (kind === 'shadows_highlights') return backend === 'native' && capabilities.id === backend && capabilities.layerFilterCoordinates === 'source' && capabilities.layerFilterLocalTonePolicy === 'alpha-weighted-local-tone-v1' && capabilities.layerFilterKinds?.includes('shadows_highlights') === true;
  if (kind === 'add_noise') return backend === 'native' && capabilities.id === backend && capabilities.layerFilterCoordinates === 'source' && capabilities.layerFilterNoisePolicy === 'seeded-rgb-discrete-v1' && capabilities.layerFilterKinds?.includes('add_noise') === true;
  if (kind !== 'unsharp_mask') return supportsSourceSpatialKind(capabilities, backend, kind);
  return backend === 'native' && capabilities.id === backend && capabilities.layerFilterCoordinates === 'source' && capabilities.layerFilterUnsharpPolicy === 'rgb-residual-threshold-v1' && capabilities.layerFilterKinds?.includes('unsharp_mask') === true;
}
