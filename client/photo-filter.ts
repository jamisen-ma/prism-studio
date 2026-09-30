import type { Backend, BackendId, PhotoFilterParameters } from './api';
export const PHOTO_FILTER_DEFAULTS: Readonly<PhotoFilterParameters> = Object.freeze({ color: '#ff9500', density: 25, preserveLuminosity: true });
export type PhotoFilterDraft = { color: string; density: string; preserveLuminosity: boolean };
export const photoFilterColor = (value: string): string | undefined => value.length === 7 && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : undefined;
export function photoFilterParameters(supplied?: unknown): PhotoFilterParameters {
  const p = supplied as Partial<PhotoFilterParameters> | undefined;
  return { color: (p?.color ?? PHOTO_FILTER_DEFAULTS.color).toLowerCase(), density: p?.density === 0 ? 0 : p?.density ?? PHOTO_FILTER_DEFAULTS.density, preserveLuminosity: p?.preserveLuminosity ?? PHOTO_FILTER_DEFAULTS.preserveLuminosity };
}
export function toPhotoFilterDraft(supplied?: unknown): PhotoFilterDraft {
  const p = photoFilterParameters(supplied);
  return { color: p.color, density: String(p.density), preserveLuminosity: p.preserveLuminosity };
}
export function photoFilterDensity(text: string): number | undefined {
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text.trim())) return;
  const value = Number(text);
  if (Number.isFinite(value) && value >= 0 && value <= 100 && Math.round(value * 100) / 100 === value) return value === 0 ? 0 : value;
}
export function parsePhotoFilterDraft(draft?: PhotoFilterDraft): PhotoFilterParameters | null {
  if (!draft) return null;
  const color = photoFilterColor(draft.color), density = photoFilterDensity(draft.density);
  return color && density !== undefined && typeof draft.preserveLuminosity === 'boolean' ? { color, density, preserveLuminosity: draft.preserveLuminosity } : null;
}
export function photoFilterIdentity(parameters: PhotoFilterParameters): boolean {
  const color = parameters.color.toLowerCase();
  return parameters.density === 0 || color === '#ffffff' || parameters.preserveLuminosity && color.slice(1, 3) === color.slice(3, 5) && color.slice(3, 5) === color.slice(5, 7);
}
const advertisedKind = (value: unknown): boolean => Array.isArray(value) && value.every(kind => typeof kind === 'string') && value.includes('photo_filter');
export function supportsPhotoFilter(capabilities: Backend | undefined, backend: BackendId, scope: 'global' | 'source'): boolean {
  return backend === 'native' && capabilities?.id === backend && capabilities.photoFilterPolicy === 'rgb-transmission-luma-fit-v1' && (scope === 'global' ? advertisedKind(capabilities.adjustmentKinds) : capabilities.layerFilterCoordinates === 'source' && advertisedKind(capabilities.layerFilterKinds));
}
export const photoFilterCapabilityKey = (capabilities?: Backend) => JSON.stringify([capabilities?.id, capabilities?.photoFilterPolicy, capabilities?.adjustmentKinds, capabilities?.layerFilterKinds, capabilities?.layerFilterCoordinates]);
