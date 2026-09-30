import type { LayerFilterParameters, LocalToneParameters } from './api';

export const LOCAL_TONE_DEFAULT: LocalToneParameters = { shadows: 25, highlights: 0, shadowWidth: 50, highlightWidth: 50, sigma: 3 };
export type LocalToneDraft = { [Key in keyof LocalToneParameters]: string };
export function localToneParameters(supplied?: LayerFilterParameters): LocalToneParameters {
  const p = supplied as Partial<LocalToneParameters> | undefined;
  return { shadows: p?.shadows ?? 25, highlights: p?.highlights ?? 0, shadowWidth: p?.shadowWidth ?? 50, highlightWidth: p?.highlightWidth ?? 50, sigma: p?.sigma ?? 3 };
}
export function toLocalToneDraft(supplied?: LayerFilterParameters): LocalToneDraft {
  const p = localToneParameters(supplied);
  return { shadows: String(p.shadows), highlights: String(p.highlights), shadowWidth: String(p.shadowWidth), highlightWidth: String(p.highlightWidth), sigma: String(p.sigma) };
}
function finite(text: string): number | undefined {
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text.trim())) return;
  const value = Number(text); return Number.isFinite(value) ? value === 0 ? 0 : value : undefined;
}
export function parseLocalToneDraft(draft?: LocalToneDraft): LocalToneParameters | null {
  if (!draft) return null;
  const shadows = finite(draft.shadows), highlights = finite(draft.highlights), shadowWidth = finite(draft.shadowWidth), highlightWidth = finite(draft.highlightWidth), sigma = finite(draft.sigma);
  const percent = (value: number | undefined, min: number): value is number => value !== undefined && value >= min && value <= 100 && Math.round(value * 100) / 100 === value;
  if (!percent(shadows, 0) || !percent(highlights, 0) || !percent(shadowWidth, 1) || !percent(highlightWidth, 1) || sigma === undefined || sigma < 0 || sigma > 50) return null;
  return { shadows, highlights, shadowWidth, highlightWidth, sigma };
}
