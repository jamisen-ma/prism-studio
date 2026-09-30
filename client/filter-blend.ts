import { supportsLookupEntry } from './color-lookup';
import { supportsCurves } from './curves';
import { LAYER_FILTER_BLEND_MODES, LAYER_FILTER_BLEND_POLICY } from '../shared/filter-blend-modes.mjs';
import type { Backend, BackendId } from './api';
import { isPolicySourceKind, supportsPolicySourceKind } from './source-spatial-filters';

export const effectiveFilterBlend = (mode?: unknown): string => mode === undefined ? 'normal' : typeof mode === 'string' ? mode : 'unavailable';
export const filterBlendLabel = (mode: string) => mode.replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase());
// Shift the saved decimal representation by two places without rounding the
// underlying opacity or introducing display noise such as 7.000000000000001%.
export function filterOpacityPercent(opacity: number): string {
  if (!Number.isFinite(opacity) || opacity < 0) return String(opacity * 100);
  const [mantissa, exponent] = String(opacity).split('e');
  if (exponent !== undefined) return `${mantissa}e${Number(exponent) + 2}`;
  const [whole, fraction = ''] = mantissa.split('.');
  return `${whole}${fraction.padEnd(2, '0').slice(0, 2)}${fraction.length > 2 ? `.${fraction.slice(2)}` : ''}`.replace(/^0+(?=\d)/, '');
}
export function filterBlendModes(capabilities: Backend, backend: BackendId, kind: unknown): string[] {
  const advertised: unknown = capabilities.layerFilterBlendModes;
  if (backend !== 'native' || capabilities.id !== backend || capabilities.layerFilterCoordinates !== 'source' || capabilities.layerFilterBlendPolicy !== LAYER_FILTER_BLEND_POLICY || typeof kind !== 'string' || !capabilities.layerFilterKinds?.includes(kind) || !Array.isArray(advertised) || !advertised.every(mode => typeof mode === 'string')) return ['normal'];
  return ['normal', ...LAYER_FILTER_BLEND_MODES.filter(mode => mode !== 'normal' && advertised.includes(mode))];
}
export function supportsFilterBlend(capabilities: Backend, backend: BackendId, kind: unknown, mode?: unknown): boolean {
  return filterBlendModes(capabilities, backend, kind).includes(effectiveFilterBlend(mode));
}
export function supportsSourceFilterEntry(capabilities: Backend, backend: BackendId, kind: unknown, mode?: unknown, parameters?: unknown): boolean {
  return (kind !== 'color_lookup' || supportsLookupEntry(capabilities, backend, 'source', parameters)) && (kind !== 'curves' || supportsCurves(capabilities, backend, parameters, 'source')) && typeof kind === 'string' && capabilities.layerFilterKinds?.includes(kind) === true && (!isPolicySourceKind(kind) || supportsPolicySourceKind(capabilities, backend, kind)) && supportsFilterBlend(capabilities, backend, kind, mode);
}
