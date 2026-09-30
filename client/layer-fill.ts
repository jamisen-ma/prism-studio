import { LAYER_FILL_CONTENT_TYPES, LAYER_FILL_POLICY } from '../shared/layer-fill.mjs';
import type { Backend, BackendId, Document, Layer } from './api';
import { filterOpacityPercent } from './filter-blend';

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
export const isFillContent = (type: string) => (LAYER_FILL_CONTENT_TYPES as readonly string[]).includes(type);
export const effectiveLayerFill = (layer?: Pick<Layer, 'fillOpacity'>) => layer?.fillOpacity ?? 1;
export const fillPercent = (value: number) => filterOpacityPercent(value);
export function parseFillDraft(text: string, saved = 1): number | undefined {
  const value = text.trim();
  if (!decimal.test(value)) return;
  const percent = Number(value);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return;
  if (percent === 0 && /[1-9]/.test(value.split(/e/i)[0])) return;
  if (Number.isFinite(saved) && saved >= 0 && saved <= 1 && percent === Number(fillPercent(saved))) return saved;
  const fill = percent / 100;
  if (percent > 0 && fill === 0) return;
  return fill === 0 ? 0 : fill;
}
export const fillCapabilityKey = (c?: Backend) => JSON.stringify([c?.id, c?.connected, c?.commands, c?.layerFillPolicy, c?.layerFillContentTypes]);
export function supportsLayerFill(c: Backend | undefined, backend: BackendId, type: string): boolean {
  const types: unknown = c?.layerFillContentTypes;
  return Boolean(backend === 'native' && c?.id === backend && c.connected && c.layerFillPolicy === LAYER_FILL_POLICY && strings(c.commands) && c.commands.includes('set_layer_fill') && strings(types) && types.length && new Set(types).size === types.length && types.every(isFillContent) && isFillContent(type) && types.includes(type));
}
export function layerFillReason(document: Document, layer: Layer, capabilities?: Backend): string {
  if (!supportsLayerFill(capabilities, document.backend, layer.type)) return 'Fill editing is unavailable with this connection. Saved values remain readable.';
  const value = effectiveLayerFill(layer);
  if (!Number.isFinite(value) || value < 0 || value > 1) return 'The saved Fill value is unavailable. Refresh this document.';
  if (layer.protected) return 'Unprotect this layer to change Fill.';
  if (layer.clipBaseId || document.layers.some(candidate => candidate.clipBaseId === layer.id)) return 'Release this clipping chain before changing Fill.';
  return '';
}
