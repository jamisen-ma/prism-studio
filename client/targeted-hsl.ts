import type { Backend, BackendId, HueSaturationParameters, HueSaturationRange, HueSaturationRow } from './api';
export const HSL_RANGES = ['master', 'reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas'] as const;
export type TargetedHSLDraft = Record<HueSaturationRange, [string, string, string]>;
export function targetedHSLParameters(supplied?: unknown): HueSaturationParameters {
  const p = supplied as Partial<HueSaturationParameters> | undefined;
  return Object.fromEntries(HSL_RANGES.map(range => [range, (p?.[range] ?? [0, 0, 0]).map(value => value === 0 ? 0 : value)])) as HueSaturationParameters;
}
export function toTargetedHSLDraft(supplied?: unknown): TargetedHSLDraft {
  const p = targetedHSLParameters(supplied);
  return Object.fromEntries(HSL_RANGES.map(range => [range, p[range].map(String)])) as TargetedHSLDraft;
}
export function targetedHSLNumber(text: string, channel: number): number | undefined {
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text.trim()) || ![0, 1, 2].includes(channel)) return;
  const value = Number(text), limit = channel === 0 ? 180 : 100;
  if (Number.isFinite(value) && value >= -limit && value <= limit && Math.round(value * 100) / 100 === value) return value === 0 ? 0 : value;
}
export function invalidTargetedHSLRanges(draft: TargetedHSLDraft): HueSaturationRange[] {
  return HSL_RANGES.filter(range => draft[range].some((value, channel) => targetedHSLNumber(value, channel) === undefined));
}
export function parseTargetedHSLDraft(draft?: TargetedHSLDraft): HueSaturationParameters | null {
  if (!draft || invalidTargetedHSLRanges(draft).length) return null;
  return Object.fromEntries(HSL_RANGES.map(range => [range, draft[range].map(targetedHSLNumber) as HueSaturationRow])) as HueSaturationParameters;
}
export function supportsTargetedHSL(capabilities: Backend | undefined, backend: BackendId, scope: 'global' | 'source'): boolean {
  const ranges: unknown = capabilities?.hueSaturationRanges;
  return backend === 'native' && capabilities?.id === backend && capabilities.hueSaturationPolicy === 'rgb-hue-triangle-hsl-v1' && Array.isArray(ranges) && ranges.every(range => typeof range === 'string') && HSL_RANGES.every(range => ranges.includes(range)) && (scope === 'global' ? capabilities.adjustmentKinds?.includes('hue_saturation') === true : capabilities.layerFilterCoordinates === 'source' && capabilities.layerFilterKinds?.includes('hue_saturation') === true);
}
export const targetedHSLCapabilityKey = (capabilities?: Backend) => JSON.stringify([capabilities?.id, capabilities?.hueSaturationPolicy, capabilities?.hueSaturationRanges, capabilities?.adjustmentKinds, capabilities?.layerFilterKinds, capabilities?.layerFilterCoordinates]);
