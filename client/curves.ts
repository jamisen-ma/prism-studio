import type { Backend, BackendId, CurvesParameters, SingleCurvesParameters, BankedCurvesParameters, CurveBankName, CurveBankParameters } from './api';
import { CURVES_INTERPOLATION_POLICY } from '../shared/smooth-curves.mjs';

export const CURVES_DEFAULT: SingleCurvesParameters = { points: [{ x: 0, y: 0 }, { x: 255, y: 255 }], channel: 'rgb' };
export type CurvesDraft = { points: { x: string; y: string }[]; channel: 'rgb' | 'red' | 'green' | 'blue'; interpolation: 'linear' | 'smooth' };
function singleCurveParameters(supplied?: unknown): SingleCurvesParameters {
  const p = supplied as Partial<SingleCurvesParameters> | undefined;
  return { points: structuredClone(p?.points ?? CURVES_DEFAULT.points), channel: p?.channel ?? 'rgb', ...(p?.interpolation === 'smooth' ? { interpolation: 'smooth' as const } : {}) };
}
export function toCurvesDraft(supplied?: unknown): CurvesDraft {
  const p = singleCurveParameters(supplied);
  return { points: p.points.map(({ x, y }) => ({ x: String(x), y: String(y) })), channel: p.channel ?? 'rgb', interpolation: p.interpolation ?? 'linear' };
}
export function curveNumber(text: string): number | undefined {
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text.trim())) return;
  const n = Number(text); return Number.isFinite(n) && n >= 0 && n <= 255 ? n === 0 ? 0 : n : undefined;
}
export function parseCurvesDraft(draft?: CurvesDraft): SingleCurvesParameters | null {
  if (!draft || !['rgb', 'red', 'green', 'blue'].includes(draft.channel) || !['linear', 'smooth'].includes(draft.interpolation) || draft.points.length < 2 || draft.points.length > 16) return null;
  const points = draft.points.map(p => ({ x: curveNumber(p.x), y: curveNumber(p.y) }));
  if (points[0].x !== 0 || points.at(-1)!.x !== 255 || points.some((p, i) => p.x === undefined || p.y === undefined || i > 0 && p.x <= points[i - 1].x!)) return null;
  return { points: points as SingleCurvesParameters['points'], channel: draft.channel, ...(draft.interpolation === 'smooth' ? { interpolation: 'smooth' } : {}) };
}
export const CURVE_BANK_NAMES: CurveBankName[] = ['master', 'red', 'green', 'blue'];
export const CURVES_BANKS_POLICY = 'master-byte-then-channel-byte-v1';
export const isBankedCurves = (parameters: unknown): parameters is BankedCurvesParameters => (parameters as { mode?: unknown } | undefined)?.mode === 'banks';
export type CurveBankDraft = Pick<CurvesDraft, 'points' | 'interpolation'>;
export type CurvesEditorDraft = { mode: 'single'; single: CurvesDraft } | { mode: 'banks'; banks: Record<CurveBankName, CurveBankDraft> };
const bankChannel = (bank: CurveBankName): CurvesDraft['channel'] => bank === 'master' ? 'rgb' : bank;
export function curveParameters(supplied?: unknown): CurvesParameters {
  if (!isBankedCurves(supplied)) return singleCurveParameters(supplied);
  return { mode: 'banks', banks: Object.fromEntries(CURVE_BANK_NAMES.map(name => {
    const bank = supplied.banks?.[name];
    return [name, { points: structuredClone(bank?.points ?? CURVES_DEFAULT.points), interpolation: bank?.interpolation ?? 'linear' }];
  })) as BankedCurvesParameters['banks'] };
}
export function toCurvesEditorDraft(supplied?: unknown): CurvesEditorDraft {
  const p = curveParameters(supplied);
  if (!isBankedCurves(p)) return { mode: 'single', single: toCurvesDraft(p) };
  return { mode: 'banks', banks: Object.fromEntries(CURVE_BANK_NAMES.map(name => [name, {
    points: p.banks[name].points.map(({ x, y }) => ({ x: String(x), y: String(y) })), interpolation: p.banks[name].interpolation,
  }])) as Record<CurveBankName, CurveBankDraft> };
}
export function invalidCurveBanks(draft: CurvesEditorDraft): CurveBankName[] {
  return draft.mode === 'banks' ? CURVE_BANK_NAMES.filter(name => !parseCurvesDraft({ ...draft.banks[name], channel: bankChannel(name) })) : [];
}
export function parseCurvesEditorDraft(draft?: CurvesEditorDraft): CurvesParameters | null {
  if (!draft) return null;
  if (draft.mode === 'single') return parseCurvesDraft(draft.single);
  if (draft.mode !== 'banks' || invalidCurveBanks(draft).length) return null;
  return { mode: 'banks', banks: Object.fromEntries(CURVE_BANK_NAMES.map(name => {
    const bank = parseCurvesDraft({ ...draft.banks[name], channel: bankChannel(name) })!;
    return [name, { points: bank.points, interpolation: draft.banks[name].interpolation }];
  })) as Record<CurveBankName, CurveBankParameters> };
}
export function upgradeCurvesDraft(draft: CurvesEditorDraft): CurvesEditorDraft | null {
  if (draft.mode !== 'single' || !parseCurvesDraft(draft.single)) return null;
  const result = toCurvesEditorDraft({ mode: 'banks' }) as Extract<CurvesEditorDraft, { mode: 'banks' }>;
  const bank = draft.single.channel === 'rgb' ? 'master' : draft.single.channel;
  result.banks[bank] = { points: structuredClone(draft.single.points), interpolation: draft.single.interpolation };
  return result;
}
export function collapseCurvesDraft(draft: CurvesEditorDraft, bank: CurveBankName): CurvesEditorDraft | null {
  if (draft.mode !== 'banks' || !CURVE_BANK_NAMES.includes(bank) || !parseCurvesEditorDraft(draft)) return null;
  return { mode: 'single', single: { ...structuredClone(draft.banks[bank]), channel: bankChannel(bank) } };
}
export const resetCurvesEditorDraft = (draft: CurvesEditorDraft): CurvesEditorDraft => toCurvesEditorDraft(draft.mode === 'banks' ? { mode: 'banks' } : undefined);
export function supportsCurveBanks(capabilities: Backend | undefined, backend: BackendId, scope: 'global' | 'source'): boolean {
  const names: unknown = capabilities?.curvesBankNames;
  return backend === 'native' && capabilities?.id === backend && capabilities.curvesBanksPolicy === CURVES_BANKS_POLICY && Array.isArray(names) && names.every(name => typeof name === 'string') && CURVE_BANK_NAMES.every(name => names.includes(name)) && (scope === 'global' ? capabilities.adjustmentKinds?.includes('curves') === true : capabilities.layerFilterCoordinates === 'source' && capabilities.layerFilterKinds?.includes('curves') === true);
}
export function supportsCurves(capabilities: Backend | undefined, backend: BackendId, parameters: unknown, scope: 'global' | 'source'): boolean {
  const banked = isBankedCurves(parameters);
  if (banked && !supportsCurveBanks(capabilities, backend, scope)) return false;
  const smooth = banked ? CURVE_BANK_NAMES.some(name => parameters.banks?.[name]?.interpolation === 'smooth') : (parameters as Partial<SingleCurvesParameters> | undefined)?.interpolation === 'smooth';
  if (!smooth) return true;
  const modes: unknown = capabilities?.curvesInterpolationModes;
  return backend === 'native' && capabilities?.id === backend && capabilities.curvesInterpolationPolicy === CURVES_INTERPOLATION_POLICY && Array.isArray(modes) && modes.every(mode => typeof mode === 'string') && modes.includes('smooth') && (scope === 'global' ? capabilities.adjustmentKinds?.includes('curves') === true : capabilities.layerFilterCoordinates === 'source' && capabilities.layerFilterKinds?.includes('curves') === true);
}
export const curvesCapabilityKey = (capabilities?: Backend) => JSON.stringify([capabilities?.id, capabilities?.curvesBanksPolicy, capabilities?.curvesBankNames, capabilities?.curvesInterpolationPolicy, capabilities?.curvesInterpolationModes, capabilities?.adjustmentKinds, capabilities?.layerFilterKinds, capabilities?.layerFilterCoordinates]);
export function curveCommandParameters(parameters: CurvesParameters, previous?: unknown): CurvesParameters | (SingleCurvesParameters & { mode: 'single' }) {
  if (isBankedCurves(parameters)) return parameters;
  if (isBankedCurves(previous)) return { mode: 'single', ...parameters, interpolation: parameters.interpolation ?? 'linear' };
  return parameters.interpolation !== 'smooth' && (previous as Partial<SingleCurvesParameters> | undefined)?.interpolation === 'smooth' ? { ...parameters, interpolation: 'linear' } : parameters;
}
/** Keyboard insertion changes no existing authored strings. The largest gap
 * always has a representable midpoint with at most sixteen points in 0..255. */
export function insertCurvePoint(draft: CurvesDraft): { draft: CurvesDraft; index: number } | null {
  const parsed = parseCurvesDraft(draft); if (!parsed || parsed.points.length >= 16) return null;
  let index = 1;
  for (let i = 2; i < parsed.points.length; i++) if (parsed.points[i].x - parsed.points[i - 1].x > parsed.points[index].x - parsed.points[index - 1].x) index = i;
  const a = parsed.points[index - 1], b = parsed.points[index], x = a.x + (b.x - a.x) / 2, y = a.y + (b.y - a.y) / 2;
  if (!(x > a.x && x < b.x)) return null;
  const next = structuredClone(draft); next.points.splice(index, 0, { x: String(x), y: String(y) }); return { draft: next, index };
}
/** Pointer edits quantize only axes with actual motion. Fractions on other axes
 * and X values in narrower-than-one-unit intervals remain byte-for-byte metadata. */
export function dragCurvePoint(draft: CurvesDraft, index: number, dx: number, dy: number): CurvesDraft {
  const p = parseCurvesDraft(draft); if (!p || !p.points[index]) return draft;
  const result = structuredClone(draft), point = p.points[index];
  if (dx !== 0 && index > 0 && index < p.points.length - 1) {
    const x = Math.max(0, Math.min(255, Math.round(point.x + dx)));
    if (x > p.points[index - 1].x && x < p.points[index + 1].x) result.points[index].x = String(x);
  }
  if (dy !== 0) result.points[index].y = String(Math.max(0, Math.min(255, Math.round(point.y + dy))));
  return result;
}
