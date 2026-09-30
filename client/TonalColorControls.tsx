import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import type { AdjustmentParameters, BlackWhiteParameters, ColorBalanceParameters, ColorBalanceRow } from './api';
import './tonal-color.css';

export const COLOR_BALANCE_DEFAULT: ColorBalanceParameters = Object.freeze({ shadows: Object.freeze([0, 0, 0]) as unknown as ColorBalanceRow, midtones: Object.freeze([0, 0, 0]) as unknown as ColorBalanceRow, highlights: Object.freeze([0, 0, 0]) as unknown as ColorBalanceRow, preserveLuminosity: true });
export const BLACK_WHITE_DEFAULT: BlackWhiteParameters = Object.freeze({ reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80, tint: false, tintColor: '#b98952', tintAmount: 100 });
export const TONES = ['shadows', 'midtones', 'highlights'] as const;
export const HUES = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas'] as const;
export type TonalKind = 'color_balance' | 'black_white';
export const isTonalKind = (kind: string): kind is TonalKind => kind === 'color_balance' || kind === 'black_white';
type DraftRow = [string, string, string];
export type ColorBalanceDraft = { kind: 'color_balance'; shadows: DraftRow; midtones: DraftRow; highlights: DraftRow; preserveLuminosity: boolean };
export type BlackWhiteDraft = { kind: 'black_white'; reds: string; yellows: string; greens: string; cyans: string; blues: string; magentas: string; tint: boolean; tintColor: string; tintAmount: string };
export type TonalDraft = ColorBalanceDraft | BlackWhiteDraft;

// Documents are server-validated. Merge only absent fields and deep-copy rows so
// sparse saved settings display effectively without changing persisted state.
export function tonalParameters(kind: TonalKind, supplied?: AdjustmentParameters): ColorBalanceParameters | BlackWhiteParameters {
  const value = structuredClone({ ...(kind === 'color_balance' ? COLOR_BALANCE_DEFAULT : BLACK_WHITE_DEFAULT), ...supplied }) as ColorBalanceParameters | BlackWhiteParameters;
  if (kind === 'black_white') (value as BlackWhiteParameters).tintColor = (value as BlackWhiteParameters).tintColor.toLowerCase();
  return value;
}
export function toTonalDraft(kind: TonalKind, supplied?: AdjustmentParameters): TonalDraft {
  const value = tonalParameters(kind, supplied);
  if (kind === 'color_balance') {
    const p = value as ColorBalanceParameters;
    return { kind, shadows: p.shadows.map(String) as DraftRow, midtones: p.midtones.map(String) as DraftRow, highlights: p.highlights.map(String) as DraftRow, preserveLuminosity: p.preserveLuminosity };
  }
  const p = value as BlackWhiteParameters;
  return { kind, reds: String(p.reds), yellows: String(p.yellows), greens: String(p.greens), cyans: String(p.cyans), blues: String(p.blues), magentas: String(p.magentas), tint: p.tint, tintColor: p.tintColor, tintAmount: String(p.tintAmount) };
}
function percentage(text: string, min: number, max: number): number | null {
  const value = Number(text);
  return text.trim() !== '' && Number.isFinite(value) && value >= min && value <= max && Math.round(value * 100) / 100 === value ? (value === 0 ? 0 : value) : null;
}
export function parseTonalDraft(draft?: TonalDraft): ColorBalanceParameters | BlackWhiteParameters | null {
  if (!draft) return null;
  if (draft.kind === 'color_balance') {
    const rows = TONES.map(tone => draft[tone].map(value => percentage(value, -100, 100)));
    if (rows.some(row => row.some(value => value === null))) return null;
    return { shadows: rows[0] as ColorBalanceRow, midtones: rows[1] as ColorBalanceRow, highlights: rows[2] as ColorBalanceRow, preserveLuminosity: draft.preserveLuminosity };
  }
  const values = HUES.map(hue => percentage(draft[hue], -200, 300)), amount = percentage(draft.tintAmount, 0, 100);
  if (values.some(value => value === null) || amount === null || !/^#[0-9a-f]{6}$/i.test(draft.tintColor)) return null;
  return { reds: values[0]!, yellows: values[1]!, greens: values[2]!, cyans: values[3]!, blues: values[4]!, magentas: values[5]!, tint: draft.tint, tintColor: draft.tintColor.toLowerCase(), tintAmount: amount };
}
export const tonalValidationMessage = (kind: string) => kind === 'color_balance' ? 'Use −100 to 100% in exact 0.01% steps for all three tones. Incomplete fields must be filled before applying.' : 'Use −200 to 300% for hue mixes and 0–100% for tint strength, in exact 0.01% steps. Fill every field before applying.';
const title = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
function PercentControl({ name, value, onChange, min, max, left, right, swatch }: { name: string; value: string; onChange: (value: string) => void; min: number; max: number; left: string; right?: string; swatch?: string }) {
  const valid = percentage(value, min, max) !== null;
  return <div className={`tonal-percent ${!valid ? 'invalid' : ''}`}><div className="tonal-percent-heading"><span>{swatch && <i style={{ background: swatch }} />}{left}{right && <span className="tonal-opponent"> / {right}</span>}</span><label><input aria-label={name} type="number" min={min} max={max} step="0.01" value={value} aria-invalid={!valid} onChange={event => onChange(event.target.value)} /><span>%</span></label></div><input aria-label={`${name} slider`} type="range" min={min} max={max} step="0.01" value={valid ? Number(value) : 0} onChange={event => onChange(event.target.value)} />{right && <div className="tonal-direction"><span>− {left}</span><span>+ {right}</span></div>}</div>;
}

export function ColorBalanceControl({ draft, onChange }: { draft: ColorBalanceDraft; onChange: (draft: ColorBalanceDraft) => void }) {
  const [tone, setTone] = useState<(typeof TONES)[number]>('midtones');
  return <section className="tonal-controls" aria-label="Color Balance settings">
    <div className="tonal-tabs" role="group" aria-label="Color Balance tone">{TONES.map(value => <button type="button" key={value} aria-pressed={tone === value} onClick={() => setTone(value)}>{title(value)}</button>)}</div>
    {([['Cyan', 'Red'], ['Magenta', 'Green'], ['Yellow', 'Blue']] as const).map(([left, right], index) => <PercentControl key={`${tone}:${index}`} name={`${title(tone)} ${left.toLowerCase()}–${right.toLowerCase()} percent`} value={draft[tone][index]} min={-100} max={100} left={left} right={right} onChange={value => onChange({ ...draft, [tone]: draft[tone].map((entry, i) => i === index ? value : entry) as DraftRow })} />)}
    <button className="button mini subtle" type="button" onClick={() => onChange({ ...draft, [tone]: ['0', '0', '0'] })}><RotateCcw size={11} />Reset tone</button>
    <label className="mapping-check"><input aria-label="Preserve luminosity" type="checkbox" checked={draft.preserveLuminosity} onChange={event => onChange({ ...draft, preserveLuminosity: event.target.checked })} />Preserve luminosity</label>
    <p className="property-hint">Preserves sRGB brightness; strong shifts may reduce color intensity near color limits. Tone settings stay together when switching tabs.</p>
  </section>;
}
export function BlackWhiteControl({ draft, onChange }: { draft: BlackWhiteDraft; onChange: (draft: BlackWhiteDraft) => void }) {
  const colors = ['#c87b83', '#c7b878', '#88b88d', '#7fb9be', '#859dd0', '#b98bbf'];
  return <section className="tonal-controls" aria-label="Black & White settings"><p className="property-hint">Adjust how each original color becomes gray.</p>
    {HUES.map((hue, index) => <PercentControl key={hue} name={`Black & White ${hue} percent`} value={draft[hue]} min={-200} max={300} left={title(hue)} swatch={colors[index]} onChange={value => onChange({ ...draft, [hue]: value })} />)}
    <div className="tonal-tint"><label className="mapping-check"><input aria-label="Black & White tint" type="checkbox" checked={draft.tint} onChange={event => onChange({ ...draft, tint: event.target.checked })} />Tint</label><label className="tonal-tint-color">Tint color<input aria-label="Tint color" type="color" value={draft.tintColor} onChange={event => onChange({ ...draft, tintColor: event.target.value.toLowerCase() })} /></label></div>
    <PercentControl name="Tint strength percent" value={draft.tintAmount} min={0} max={100} left="Tint strength" onChange={value => onChange({ ...draft, tintAmount: value })} />
    <p className="property-hint">Tint color and strength are kept while Tint is off. Apply settings to see the actual canvas result.</p>
  </section>;
}
export function TonalColorControl({ draft, onChange }: { draft: TonalDraft; onChange: (draft: TonalDraft) => void }) {
  return draft.kind === 'color_balance' ? <ColorBalanceControl draft={draft} onChange={onChange} /> : <BlackWhiteControl draft={draft} onChange={onChange} />;
}
