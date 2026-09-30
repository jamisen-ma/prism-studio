import type { Document, Layer } from './api';

export function layerAncestors(layers: Layer[], layer?: Layer): Layer[] {
  const ancestors: Layer[] = [], seen = new Set<string>();
  let parent = layer?.parentId;
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    const item = layers.find(candidate => candidate.id === parent);
    if (!item) break;
    ancestors.push(item); parent = item.parentId;
  }
  return ancestors;
}

export function layerSubtree(layers: Layer[], layer: Layer): Layer[] {
  return layers.filter(item => item.id === layer.id || layerAncestors(layers, item).some(parent => parent.id === layer.id));
}

export function hasProtectedContent(layers: Layer[], layer?: Layer) {
  return Boolean(layer && layerSubtree(layers, layer).some(item => item.protected));
}

export function displayLayers(document: Document | null, collapsed = new Set<string>()): (Layer & { depth: number })[] {
  if (!document) return [];
  if (document.backend === 'native') {
    const visit = (parentId: string | null, depth: number): (Layer & { depth: number })[] => document.layers
      .filter(layer => (layer.parentId || null) === parentId).reverse()
      .flatMap(layer => [{ ...layer, depth }, ...(layer.type === 'group' && !collapsed.has(layer.id) ? visit(layer.id, depth + 1) : [])]);
    return visit(null, 0);
  }
  const flatten = (layers: Layer[], depth = 0): (Layer & { depth: number })[] => {
    const ordered = document.layerOrder === 'bottom-to-top' ? layers.slice().reverse() : layers;
    return ordered.flatMap(layer => [{ ...layer, depth }, ...(!collapsed.has(layer.id) ? flatten(layer.children || [], depth + 1) : [])]);
  };
  return flatten(document.layers);
}
