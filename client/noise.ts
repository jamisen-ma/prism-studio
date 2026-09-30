import type { LayerFilterParameters, NoiseParameters } from './api';

export const NOISE_DEFAULT: NoiseParameters = { amount: 5, distribution: 'uniform', monochromatic: true, seed: 1 };
export type NoiseDraft = { amount: string; distribution: NoiseParameters['distribution']; monochromatic: boolean; seed: string };
export function noiseParameters(supplied?: LayerFilterParameters): NoiseParameters {
  return { amount: supplied && 'amount' in supplied ? supplied.amount : 5, distribution: supplied && 'distribution' in supplied ? supplied.distribution : 'uniform', monochromatic: supplied && 'monochromatic' in supplied ? supplied.monochromatic : true, seed: supplied && 'seed' in supplied ? supplied.seed : 1 };
}
export function toNoiseDraft(supplied?: LayerFilterParameters): NoiseDraft {
  const p = noiseParameters(supplied);
  return { amount: String(p.amount), distribution: p.distribution, monochromatic: p.monochromatic, seed: String(p.seed) };
}
function finite(text: string): number | undefined {
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text.trim())) return;
  const value = Number(text); return Number.isFinite(value) ? value === 0 ? 0 : value : undefined;
}
export function parseNoiseSeed(text: string): number | undefined {
  const seed = finite(text);
  return seed !== undefined && Number.isInteger(seed) && seed >= 0 && seed <= 4294967295 ? seed : undefined;
}
export function parseNoiseDraft(draft?: NoiseDraft): NoiseParameters | null {
  if (!draft) return null;
  const amount = finite(draft.amount), seed = parseNoiseSeed(draft.seed);
  if (amount === undefined || amount < 0 || amount > 400 || Math.round(amount * 100) / 100 !== amount || seed === undefined || !['uniform', 'gaussian'].includes(draft.distribution) || typeof draft.monochromatic !== 'boolean') return null;
  return { amount, distribution: draft.distribution, monochromatic: draft.monochromatic, seed };
}
// Called only by the explicit New pattern action, never during render or preview.
export function nextNoiseSeed(text: string): string {
  const current = parseNoiseSeed(text) ?? NOISE_DEFAULT.seed;
  const fallback = current === 4294967295 ? 0 : current + 1;
  try {
    const values = new Uint32Array(1);
    globalThis.crypto.getRandomValues(values);
    return String(values[0] === current ? fallback : values[0]);
  } catch { return String(fallback); }
}
