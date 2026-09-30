import type { Backend, BackendId, SelectiveColorParameters, SelectiveColorRange, SelectiveColorRow } from './api';
export const SELECTIVE_RANGES = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'whites', 'neutrals', 'blacks'] as const;
export type SelectiveColorDraft = { method: 'relative' | 'absolute' } & Record<SelectiveColorRange, [string, string, string, string]>;
export function selectiveColorParameters(supplied?: unknown): SelectiveColorParameters {
  const p = supplied as Partial<SelectiveColorParameters> | undefined;
  return { method: p?.method ?? 'relative', ...Object.fromEntries(SELECTIVE_RANGES.map(range => [range, (p?.[range] ?? [0, 0, 0, 0]).map(value => value === 0 ? 0 : value)])) } as SelectiveColorParameters;
}
export function toSelectiveColorDraft(supplied?: unknown): SelectiveColorDraft {
  const p = selectiveColorParameters(supplied);
  return { method: p.method, ...Object.fromEntries(SELECTIVE_RANGES.map(range => [range, p[range].map(String)])) } as SelectiveColorDraft;
}
export function selectivePercentage(text: string): number | undefined {
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text.trim())) return;
  const value = Number(text);
  if (Number.isFinite(value) && value >= -100 && value <= 100 && Math.round(value * 100) / 100 === value) return value === 0 ? 0 : value;
}
export function invalidSelectiveRanges(draft: SelectiveColorDraft): SelectiveColorRange[] {
  return SELECTIVE_RANGES.filter(range => draft[range].some(value => selectivePercentage(value) === undefined));
}
export function parseSelectiveColorDraft(draft?: SelectiveColorDraft): SelectiveColorParameters | null {
  if (!draft || !['relative', 'absolute'].includes(draft.method) || invalidSelectiveRanges(draft).length) return null;
  return { method: draft.method, ...Object.fromEntries(SELECTIVE_RANGES.map(range => [range, draft[range].map(selectivePercentage) as SelectiveColorRow])) } as SelectiveColorParameters;
}
const completeList = (value: unknown, required: readonly string[]) => Array.isArray(value) && value.every(item => typeof item === 'string') && required.every(item => value.includes(item));
export function supportsSelectiveColor(capabilities: Backend | undefined, backend: BackendId, scope: 'global' | 'source'): boolean {
  return backend === 'native' && capabilities?.id === backend && capabilities.selectiveColorPolicy === 'rgb-partition-cmyk-v1' && completeList(capabilities.selectiveColorMethods, ['relative', 'absolute']) && completeList(capabilities.selectiveColorRanges, SELECTIVE_RANGES) && (scope === 'global' ? capabilities.adjustmentKinds?.includes('selective_color') === true : capabilities.layerFilterCoordinates === 'source' && capabilities.layerFilterKinds?.includes('selective_color') === true);
}
export const selectiveColorCapabilityKey = (capabilities?: Backend) => JSON.stringify([capabilities?.id, capabilities?.selectiveColorPolicy, capabilities?.selectiveColorMethods, capabilities?.selectiveColorRanges, capabilities?.adjustmentKinds, capabilities?.layerFilterKinds, capabilities?.layerFilterCoordinates]);
export const isPreciseColorKind = (kind: string) => kind === 'photo_filter' || kind === 'curves' || kind === 'selective_color' || kind === 'hue_saturation';
