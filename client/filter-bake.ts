import type { Backend, Document, Layer } from './api';

export const supportsFilterBake = (backend?: Backend) => backend?.id === 'native' && backend.layerFilterBaking === 'source-rgb' && backend.commands.includes('bake_layer_filters');
export const hasActiveLayerFilters = (layer: Layer) => Boolean(layer.filters?.some(filter => filter.enabled && filter.opacity > 0));

// Native metadata is already in canonical depth-first order. Display order,
// visibility, masks and group collapse must not weaken this structural guard.
export function earlierProtectedFilterContent(document: Document, layer: Layer): Layer | undefined {
  const index = document.layers.findIndex(item => item.id === layer.id);
  return document.backend === 'native' && index >= 0 && hasActiveLayerFilters(layer)
    ? document.layers.slice(0, index).find(item => item.protected && !['group', 'adjustment'].includes(item.type)) : undefined;
}

export function filterStackActionHint(canBake: boolean, operation: string, sourceDocument = false) {
  return canBake
    ? `Review Bake filters or Clear filters in ${sourceDocument ? 'the source document’s Layers panel' : 'Layers'} before ${operation}. Disabled entries also count.`
    : `Remove every layer filter before ${operation}. Disabled filters also count.`;
}
