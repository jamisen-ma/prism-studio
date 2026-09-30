import { COLOR_RANGE_POLICY, COLOR_RANGE_LIMITS, COLOR_RANGE_PREVIEW_LIMITS, normalizeColorRangeSettings, type ColorRangeSettings } from '../shared/color-range.mjs';
import type { Backend, ColorRangePreview, Document } from './api';
import { capabilityStrings, denseCapabilityKey, previewDimensions, supportsDenseMasks } from './dense-mask';

export type ColorRangeDraft = { colors: string[]; tolerance: string; falloff: string; invert: boolean };
const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
export function parseColorRangeInteger(text: string): number | undefined {
  if (!numeric.test(text.trim())) return;
  const value = Number(text), mantissa = text.split(/e/i)[0];
  if (!Number.isInteger(value) || value < 0 || value > 255 || value === 0 && /[1-9]/.test(mantissa)) return;
  return value === 0 ? 0 : value;
}
export function parseColorRangeDraft(draft: ColorRangeDraft): ColorRangeSettings | undefined {
  const tolerance = parseColorRangeInteger(draft.tolerance), falloff = parseColorRangeInteger(draft.falloff);
  if (tolerance === undefined || falloff === undefined) return;
  try { return normalizeColorRangeSettings({ colors: draft.colors, tolerance, falloff, invert: draft.invert }); } catch { return; }
}
const bounded = (n: unknown, max: number, min = 1): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max;
const ownLimits = (value: unknown, keys: string[]): boolean => {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const fields = Reflect.ownKeys(value);
  return fields.length === keys.length && fields.every(key => typeof key === 'string' && keys.includes(key) && (() => { const field = Object.getOwnPropertyDescriptor(value, key); return Boolean(field?.enumerable && 'value' in field && typeof field.value === 'number' && Number.isSafeInteger(field.value)); })());
};
const limitsKey = (value: unknown, keys: string[]) => ownLimits(value, keys) ? keys.map(key => Object.getOwnPropertyDescriptor(value, key)!.value) : 'invalid';
export function colorRangeSupport(c?: Backend, document?: Pick<Document, 'backend' | 'width' | 'height'> | null) {
  const l = c?.colorRangeLimits, p = c?.colorRangePreviewLimits;
  const limits = Boolean(l && ownLimits(l, Object.keys(COLOR_RANGE_LIMITS)) && Object.keys(COLOR_RANGE_LIMITS).every(key => bounded(l[key as keyof typeof l], COLOR_RANGE_LIMITS[key as keyof typeof COLOR_RANGE_LIMITS], key === 'maxTolerance' || key === 'maxFalloff' ? 0 : 1)));
  const semantic = Boolean(c?.id === 'native' && c.connected && c.colorRangePolicy === COLOR_RANGE_POLICY && limits && (!document || document.backend === 'native'));
  const readLimits = Boolean(p && ownLimits(p, Object.keys(COLOR_RANGE_PREVIEW_LIMITS)) && bounded(p.minEdge, COLOR_RANGE_PREVIEW_LIMITS.maxEdge, COLOR_RANGE_PREVIEW_LIMITS.minEdge) && bounded(p.maxEdge, COLOR_RANGE_PREVIEW_LIMITS.maxEdge, p.minEdge!) && bounded(p.defaultMaxEdge, p.maxEdge!, p.minEdge!) && bounded(p.maxBytes, COLOR_RANGE_PREVIEW_LIMITS.maxBytes) && bounded(p.maxWorkingBytes, COLOR_RANGE_PREVIEW_LIMITS.maxWorkingBytes));
  const commands = capabilityStrings(c?.commands);
  const dense = supportsDenseMasks(c) && (!document || document.width <= c!.denseMaskLimits!.maxDimension! && document.height <= c!.denseMaskLimits!.maxDimension! && document.width * document.height <= c!.denseMaskLimits!.maxPixels!);
  return { semantic, preview: semantic && readLimits && commands.includes('get_color_range_preview'), load: semantic && dense && commands.includes('load_color_range_selection'), maxColors: limits ? l!.maxColors! : 8, maxTolerance: limits ? l!.maxTolerance! : 255, maxFalloff: limits ? l!.maxFalloff! : 255, maxComparisons: limits ? l!.maxComparisons! : 0, minEdge: readLimits ? p!.minEdge! : 32, maxEdge: readLimits ? p!.maxEdge! : 0, defaultEdge: readLimits ? p!.defaultMaxEdge! : 700, maxBytes: readLimits ? p!.maxBytes! : 0 };
}
export function colorRangeCapabilityKey(c?: Backend, scope: 'preview' | 'load' = 'preview') {
  return JSON.stringify([c?.id, c?.connected, c?.colorRangePolicy, limitsKey(c?.colorRangeLimits, Object.keys(COLOR_RANGE_LIMITS)), capabilityStrings(c?.commands).includes(scope === 'preview' ? 'get_color_range_preview' : 'load_color_range_selection'), scope === 'preview' ? limitsKey(c?.colorRangePreviewLimits, Object.keys(COLOR_RANGE_PREVIEW_LIMITS)) : denseCapabilityKey(c)]);
}
export function colorRangeSettingsAllowed(settings: ColorRangeSettings | undefined, support: ReturnType<typeof colorRangeSupport>) {
  return Boolean(settings && settings.colors.length <= support.maxColors && settings.tolerance <= support.maxTolerance && settings.falloff <= support.maxFalloff);
}
export function validateColorRangePreview(result: ColorRangePreview, doc: Pick<Document, 'id' | 'revision' | 'width' | 'height'>, settings: ColorRangeSettings, maxEdge: number, maxBytes: number) {
  const size = previewDimensions(doc.width, doc.height, maxEdge);
  if (result.documentId !== doc.id || result.revision !== doc.revision || result.sourceWidth !== doc.width || result.sourceHeight !== doc.height || result.width !== size.width || result.height !== size.height || JSON.stringify(result.colors) !== JSON.stringify(settings.colors) || result.tolerance !== settings.tolerance || result.falloff !== settings.falloff || result.invert !== settings.invert || result.maxEdge !== maxEdge || result.coveragePolicy !== COLOR_RANGE_POLICY || result.sampling !== 'nearest-pixel-center' || result.mimeType !== 'image/png' || typeof result.data !== 'string' || !result.data.length || result.data.length > Math.ceil(maxBytes / 3) * 4) throw Error('The Color Range response does not match this document, revision or coverage request. Preview again.');
}
