import type { Document, Guide, Layer } from './api';
import { clippingChainFor } from './clipping';
import { layerAncestors } from './layer-tree';

export type MoveBounds = { x: number; y: number; width: number; height: number };
export type SnapResult = { x: number; y: number; guides: Guide[] };
export function uniqueGuides(guides: Guide[]) {
  return guides.slice().sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)).filter((guide, index, sorted) => !sorted.slice(0, index).some(other => other.axis === guide.axis && other.position === guide.position));
}
export function moveSnapReason(document: Document | null, layer: Layer | undefined, bounds: MoveBounds | null) {
  if (!document || !layer || !bounds) return 'Select a visible content layer to snap.';
  if (clippingChainFor(document.layers, layer)) return 'Snapping is off for clipping-chain participants. Free Move remains available.';
  const chain = [layer, ...layerAncestors(document.layers, layer)];
  if (chain.some(item => item.mask)) return 'Snapping is off for document-anchored masks. Free Move remains available.';
  if (chain.some(item => item.blendMode === 'dissolve')) return 'Snapping is off for dissolve blending. Free Move remains available.';
  if (!layer.protected && (layer.role === 'generated' || layer.provenance?.jobId)) return 'Snapping is off for generated layers with contextual clipping. Free Move remains available.';
  if (bounds.x <= 0 || bounds.y <= 0 || bounds.x + bounds.width >= document.width || bounds.y + bounds.height >= document.height) return 'Snapping is off when the starting bounds touch a canvas edge. Free Move remains available.';
  return '';
}
export function snapMove(rawX: number, rawY: number, bounds: MoveBounds, guides: Guide[], sx: number, sy: number, width: number, height: number): SnapResult {
  if (!rawX && !rawY) return { x: 0, y: 0, guides: [] };
  const choose = (axis: Guide['axis'], raw: number, start: number, size: number, scale: number, limit: number) => {
    const anchors = [start, start + size, start + size / 2].map((position, priority) => ({ position, priority })).filter(anchor => Number.isInteger(anchor.position));
    const candidates = guides.filter(guide => guide.axis === axis).flatMap(guide => anchors.map(anchor => {
      const delta = guide.position - anchor.position;
      return { delta, distance: Math.abs(delta - raw) * scale, priority: anchor.priority, guide };
    })).filter(item => item.distance <= 6 && start + item.delta >= 0 && start + size + item.delta <= limit);
    candidates.sort((a, b) => a.distance - b.distance || a.priority - b.priority || a.guide.position - b.guide.position || a.guide.id.localeCompare(b.guide.id));
    return candidates[0];
  };
  const horizontal = choose('vertical', rawX, bounds.x, bounds.width, sx, width), vertical = choose('horizontal', rawY, bounds.y, bounds.height, sy, height);
  const x = horizontal?.delta ?? rawX, y = vertical?.delta ?? rawY;
  if (bounds.x + x < 0 || bounds.y + y < 0 || bounds.x + bounds.width + x > width || bounds.y + bounds.height + y > height) return { x: rawX, y: rawY, guides: [] };
  return { x, y, guides: [horizontal?.guide, vertical?.guide].filter((guide): guide is Guide => Boolean(guide)) };
}
