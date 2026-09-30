export type CurvesBankName = 'master' | 'red' | 'green' | 'blue';
export type CurvesBankInterpolation = 'linear' | 'smooth';
export interface CurvesBankPoint { x: number; y: number; }
export interface CurvesBankSpec { points: CurvesBankPoint[]; interpolation: CurvesBankInterpolation; }
export interface CurvesBanksParameters { mode: 'banks'; banks: Record<CurvesBankName, CurvesBankSpec>; }
export interface CurvesBanksPatch { mode: 'banks'; banks?: Partial<Record<CurvesBankName, Partial<CurvesBankSpec>>>; }
export const CURVES_BANKS_POLICY: 'master-byte-then-channel-byte-v1';
export const CURVES_BANK_NAMES: readonly ['master', 'red', 'green', 'blue'];
export const CURVES_BANKS_CACHE_BYTES: 1280;
export function normalizeCurvesBanksParameters(parameters: unknown): CurvesBanksParameters;
export function mergeCurvesBanksParameters(previous: unknown, patch: unknown): CurvesBanksParameters;
export function compileCurvesBankLookup(spec?: Partial<CurvesBankSpec>): Uint8Array;
export function compileCurvesBanksLookup(parameters: unknown): Uint8Array;
