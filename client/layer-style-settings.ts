import type { Layer } from './api';

// Persisted projects may retain omitted values; match the native effect defaults.
export function hasEnabledOutsideStyle(layer: Pick<Layer, 'outline' | 'effects'>) {
  return Boolean((layer.outline?.width || 0) > 0 ||
    layer.effects?.shadow && (layer.effects.shadow.opacity ?? .35) > 0 ||
    layer.effects?.glow && (layer.effects.glow.opacity ?? .5) > 0);
}
