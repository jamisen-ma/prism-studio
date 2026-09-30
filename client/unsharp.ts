import type { LayerFilterParameters, UnsharpMaskParameters } from './api';

export const UNSHARP_DEFAULT: UnsharpMaskParameters = { amount: 100, sigma: 1, threshold: 0 };
export type UnsharpDraft = { amount: string; sigma: string; threshold: string };
export function unsharpParameters(supplied?: LayerFilterParameters): UnsharpMaskParameters {
  return { amount: supplied && 'amount' in supplied ? supplied.amount : 100, sigma: supplied && 'sigma' in supplied ? supplied.sigma : 1, threshold: supplied && 'threshold' in supplied ? supplied.threshold : 0 };
}
export function toUnsharpDraft(supplied?: LayerFilterParameters): UnsharpDraft {
  const p = unsharpParameters(supplied);
  return { amount: String(p.amount), sigma: String(p.sigma), threshold: String(p.threshold) };
}
function finite(text: string): number | undefined {
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text.trim())) return;
  const value = Number(text); return Number.isFinite(value) ? value === 0 ? 0 : value : undefined;
}
export function parseUnsharpDraft(draft?: UnsharpDraft): UnsharpMaskParameters | null {
  if (!draft) return null;
  const amount = finite(draft.amount), sigma = finite(draft.sigma), threshold = finite(draft.threshold);
  if (amount === undefined || amount < 0 || amount > 500 || Math.round(amount * 100) / 100 !== amount || sigma === undefined || sigma < 0 || sigma > 50 || threshold === undefined || threshold < 0 || threshold > 255 || !Number.isInteger(threshold)) return null;
  return { amount, sigma, threshold };
}
