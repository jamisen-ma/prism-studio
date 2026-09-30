import { effectiveLayerFill } from './layer-fill';
import type { Layer } from './api';
import { hasEnabledOutsideStyle } from './layer-style-settings';

export function reorderSplitsClippingChain(siblings: Layer[], layerId: string, index: number) {
  const remaining = siblings.filter(layer => layer.id !== layerId);
  const above = remaining[index];
  // In canonical bottom-to-top order, every gap before a member is inside its chain.
  return Boolean(above?.clipBaseId);
}

export function clippingChainFor(layers: Layer[], layer?: Layer) {
  if (!layer) return null;
  const base = layer.clipBaseId ? layers.find(candidate => candidate.id === layer.clipBaseId) : layer;
  if (!base) return null;
  const members = layers.filter(candidate => candidate.clipBaseId === base.id);
  return members.length ? { base, members } : null;
}
export function includesWholeChains(layers: Layer[], picked: Layer[]) {
  const ids = new Set(picked.map(layer => layer.id));
  return picked.every(layer => { const chain = clippingChainFor(layers, layer); return !chain || [chain.base, ...chain.members].every(item => ids.has(item.id)); });
}
export function clippingSelectionError(layers: Layer[], picked: Layer[], types: string[]) {
  if (picked.length < 2) return 'Check at least two consecutive content layers. The lowest checked layer is the base.';
  const [base, ...members] = picked;
  if (picked.some(layer => !types.includes(layer.type))) return 'Groups and adjustment layers cannot participate. Choose individual content layers.';
  if (picked.some(layer => effectiveLayerFill(layer) !== 1)) return 'Set Fill to 100% on every participant before clipping, including hidden layers.';
  if (picked.some(layer => layer.protected)) return 'Explicitly remove protection from every participant before clipping, including hidden layers.';
  if (base.clipBaseId || members.some(layer => layer.clipBaseId && layer.clipBaseId !== base.id || clippingChainFor(layers, layer)?.base.id === layer.id)) return 'Release the other clipping chain before changing its base or combining chains.';
  if (base.role === 'generated' || base.provenance?.jobId) return 'Generated content can be an upper member, but cannot be the clipping base.';
  if (members.some(hasEnabledOutsideStyle)) return 'Remove outside outlines, shadows and glows from upper members. The base can keep its styles.';
  const siblings = layers.filter(layer => (layer.parentId || null) === (base.parentId || null)), first = siblings.findIndex(layer => layer.id === base.id);
  if (!picked.every((layer, index) => (layer.parentId || null) === (base.parentId || null) && siblings[first + index]?.id === layer.id)) return 'Choose consecutive direct siblings with the same parent group, starting at the base.';
  return '';
}
