import type { Backend, Document, Layer } from './api';

export type Corner = { x: number; y: number };
export type Corners = [Corner, Corner, Corner, Corner];
export type CornerDraft = { x: string; y: string }[];
export type DistortStage = { type: 'distort'; width: number; height: number; corners: Corners };
export const CORNER_NAMES = ['Top left', 'Top right', 'Bottom right', 'Bottom left'] as const;
export const DISTORT_TYPES = ['raster', 'solid', 'text', 'shape', 'path', 'gradient'];
export const isDistortStage = (value: Record<string, unknown>): value is DistortStage => value.type === 'distort' && Array.isArray(value.corners) && value.corners.length === 4;
export const rectangleCorners = (width: number, height: number): Corners => [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }];
export const cornerDraft = (corners: Corners): CornerDraft => corners.map(point => ({ x: String(point.x), y: String(point.y) }));
const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
export function parseCorners(draft: CornerDraft, limit = 16384): Corners | undefined {
  if (draft.length !== 4 || !Number.isFinite(limit) || limit <= 0 || limit > 16384) return;
  const points = draft.map(point => {
    if (!point || !['x', 'y'].every(key => { const value = point[key as 'x' | 'y']; return typeof value === 'string' && numeric.test(value.trim()) && Number.isFinite(Number(value)) && Math.abs(Number(value)) <= limit; })) return;
    return { x: Number(point.x) || 0, y: Number(point.y) || 0 };
  });
  return points.every(Boolean) ? points as Corners : undefined;
}
export function distortFrame(layer: Layer, index: number | 'new') {
  const transforms = layer.transforms || [], position = index === 'new' ? transforms.length : index;
  const previous = transforms[position - 1];
  return { width: Number(previous?.width ?? layer.width), height: Number(previous?.height ?? layer.height) };
}
export function distortSupport(capabilities: Backend | undefined, layer: Layer | undefined) {
  const list = capabilities?.layerDistortContentTypes, limit = capabilities?.limits?.maxDistortCorner, work = capabilities?.limits?.maxDistortWork, bytes = capabilities?.limits?.maxDistortWorkingBytes;
  const policy = Boolean(capabilities?.id === 'native' && capabilities.connected && capabilities.layerDistortPolicy === 'fixed-frame-projective-bilinear-v1' && capabilities.layerDistortCoordinates === 'stage-pixel-edges' && Array.isArray(list) && list.every(item => typeof item === 'string') && layer && DISTORT_TYPES.includes(layer.type) && list.includes(layer.type) && Number.isInteger(limit) && limit! > 0 && limit! <= 16384 && Number.isSafeInteger(work) && work! > 0 && work! <= 384000000 && Number.isSafeInteger(bytes) && bytes! > 0 && bytes! <= 256 * 1024 * 1024);
  const commands = Array.isArray(capabilities?.commands) && capabilities.commands.every(item => typeof item === 'string') ? capabilities.commands : [];
  return { policy, limit: policy ? limit! : 16384, add: policy && commands.includes('add_layer_distort'), update: policy && commands.includes('update_layer_distort'), remove: policy && commands.includes('delete_layer_distort') };
}
export const distortCapabilityKey = (capabilities?: Backend) => JSON.stringify([capabilities?.id, capabilities?.connected, capabilities?.commands, capabilities?.layerDistortPolicy, capabilities?.layerDistortCoordinates, capabilities?.layerDistortContentTypes, capabilities?.limits?.maxDistortCorner, capabilities?.limits?.maxDistortWork, capabilities?.limits?.maxDistortWorkingBytes]);
/** Validate the exact owned metadata transition before acknowledging its revision. */
export function distortResultMatches(before: Document, layerId: string, index: number | 'new', corners: Corners | undefined, result: Document): boolean {
  if (result.id !== before.id || result.backend !== before.backend || result.revision !== before.revision + 1 || result.width !== before.width || result.height !== before.height) return false;
  const layer = before.layers.find(item => item.id === layerId), next = result.layers.find(item => item.id === layerId);
  if (!layer || !next || layer.type !== next.type || !next.transforms) return false;
  const transforms = structuredClone(layer.transforms || []), frame = distortFrame(layer, index);
  if (index === 'new') { if (!corners) return false; transforms.push({ type: 'distort', ...frame, corners }); }
  else { if (!transforms[index] || !isDistortStage(transforms[index])) return false; if (corners) transforms[index] = { type: 'distort', ...frame, corners }; else transforms.splice(index, 1); }
  return JSON.stringify(next.transforms) === JSON.stringify(transforms);
}
