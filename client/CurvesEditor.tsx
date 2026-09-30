import { useEffect, useRef, useState } from 'react';
import type { CurveBankName, Histogram } from './api';
import { compileCurvesBankLookup } from '../shared/curves-banks.mjs';
import { CurvesControl } from './CurvesControl';
import { CURVE_BANK_NAMES, collapseCurvesDraft, invalidCurveBanks, parseCurvesEditorDraft, parseCurvesDraft, resetCurvesEditorDraft, upgradeCurvesDraft, type CurvesEditorDraft } from './curves';
import './curves-banks.css';

export type CurvesInspection = { bank: CurveBankName; points: Record<CurveBankName, number> };
export const createCurvesInspection = (): CurvesInspection => ({ bank: 'master', points: { master: 0, red: 0, green: 0, blue: 0 } });
type Props = { draft: CurvesEditorDraft; onChange: (draft: CurvesEditorDraft) => void; histogram: Histogram | null; disabled: boolean; bankSupported: boolean; smoothSupported: boolean; contextKey: string; sessionKey: string; inspection: CurvesInspection; onDragging: (dragging: boolean) => void };
const title = (bank: CurveBankName) => bank[0].toUpperCase() + bank.slice(1);
export function CurvesEditor(props: Props) {
  const { draft, onChange, inspection, disabled, bankSupported, smoothSupported, histogram, contextKey, sessionKey, onDragging } = props;
  const [dragging, setDragging] = useState(false), [, renderInspection] = useState(0), [keep, setKeep] = useState<CurveBankName | ''>('');
  const recovery = useRef<{ sessionKey: string; draft: CurvesEditorDraft } | null>(null);
  if (recovery.current?.sessionKey !== sessionKey) recovery.current = null;
  const reportDragging = (value: boolean) => { setDragging(value); onDragging(value); };
  useEffect(() => { setKeep(''); }, [sessionKey]);
  const chooseBank = (value: CurveBankName) => { if (dragging || !CURVE_BANK_NAMES.includes(value)) return; inspection.bank = value; renderInspection(value => value + 1); };
  const restore = () => { if (disabled || dragging || !recovery.current || recovery.current.sessionKey !== sessionKey) return; const previous = recovery.current.draft; recovery.current = null; onChange(structuredClone(previous)); setKeep(''); };
  const banked = draft.mode === 'banks', bank = inspection.bank, current = banked ? { ...draft.banks[bank], channel: bank === 'master' ? 'rgb' as const : bank } : draft.single;
  const parsedBank = parseCurvesDraft(current), invalid = invalidCurveBanks(draft);
  const complete = parseCurvesEditorDraft(draft);
  const immutable = disabled || banked && !bankSupported;
  const lookup = banked && parsedBank ? compileCurvesBankLookup({ points: parsedBank.points, interpolation: current.interpolation }) : undefined;
  return <div className="curves-bank-editor">
    {banked ? <>
      <label className="field-label">Curve bank<select aria-label="Curve bank" disabled={dragging} value={bank} onChange={event => chooseBank(event.target.value as CurveBankName)}>{CURVE_BANK_NAMES.map(name => <option key={name} value={name}>{title(name)}{invalid.includes(name) ? ' · incomplete' : ''}{draft.banks[name].interpolation === 'smooth' && !smoothSupported ? ' · Smooth unavailable' : ''}</option>)}</select></label>
      <p className="property-hint">Master runs first; each color curve maps its result. Apply saves all four curves.</p>
      {invalid.length > 0 && <p className="inline-panel-error">Review {invalid.map(title).join(', ')} before applying. Every bank needs valid ordered points.</p>}
      {!bankSupported && <p className="tonal-unavailable">This companion does not advertise native Master and component curve banks. You can inspect every bank; saved settings stay unchanged.</p>}
      {!smoothSupported && CURVE_BANK_NAMES.some(name => draft.banks[name].interpolation === 'smooth') && <p className="tonal-unavailable">A saved or draft bank uses unavailable Smooth interpolation. All banks are checked before Apply.</p>}
    </> : recovery.current?.draft.mode === 'banks' && <p className="curve-conversion-note">Single-curve replacement pending Apply. Only {current.channel === 'rgb' ? 'Master as RGB composite' : title(current.channel)} will be kept.</p>}
    <CurvesControl key={banked ? bank : 'single'} draft={current} histogram={histogram} disabled={immutable} smoothSupported={smoothSupported} contextKey={`${contextKey}:${draft.mode}:${banked ? bank : 'single'}`} sessionKey={`${sessionKey}:${draft.mode}:${banked ? bank : 'single'}`} onDragging={reportDragging} bankName={banked ? title(bank) : undefined} lookup={lookup} selectedPoint={banked ? inspection.points[bank] : undefined} onSelectedPoint={banked ? index => { inspection.points[bank] = index; renderInspection(value => value + 1); } : undefined} onChange={value => {
      if (banked) onChange({ mode: 'banks', banks: { ...draft.banks, [bank]: { points: value.points, interpolation: value.interpolation } } });
      else onChange({ mode: 'single', single: value });
    }} />
    {banked ? <>
      <button type="button" className="button mini subtle" disabled={immutable || dragging} onClick={() => { if (!immutable && !dragging) { onChange(resetCurvesEditorDraft(draft)); for (const name of CURVE_BANK_NAMES) inspection.points[name] = 0; } }}>Reset all banks</button>
      <details className="curve-details curve-bank-help"><summary>How channel banks work</summary><p>Master maps each input RGB byte first. Red, Green and Blue then map their channel's Master output. The selected graph shows that bank's byte lookup, with authored fractional points marked separately; it does not show the combined four-curve result. The composite histogram is a reference, not the histogram entering a component bank.</p><p>Numeric Input and Output retain exact fractions. Add point inserts a local midpoint; near-coincident points remain reachable in the point list. Graph dragging changes whole units only on moved axes. If a whole-unit input cannot fit its neighbors, the precise input stays unchanged.</p><p>Each bank has its own Linear or native Smooth interpolation. Master is the RGB composite curve; upgrading a single component curve puts it in the matching component bank. Replacing banks with one curve discards the other three and generally changes the result.</p><p>Filter blend and opacity act once after all banks; the effect mask follows the completed stack. Source filters preserve alpha and leave fully transparent RGB ungraded. Global adjustments retain their existing mask and hidden-RGB behavior. Identity banks can still change colors under a non-Normal filter blend.</p><p>Smooth's defined byte rounding can differ from Linear at half boundaries. These native curves do not recover clipped detail or promise Photoshop pixel parity. All edits stay local until Apply.</p></details>
      <details className="curve-details curve-conversion"><summary>Replace with one curve</summary><label className="field-label">Keep bank<select aria-label="Keep curve bank" disabled={immutable || dragging} value={keep} onChange={event => setKeep(event.target.value as CurveBankName | '')}><option value="">Choose a bank</option>{CURVE_BANK_NAMES.map(name => <option key={name} value={name}>{name === 'master' ? 'Master → RGB composite' : `${title(name)} → ${title(name)} channel`}</option>)}</select></label><p>Use only the chosen curve. The other three curves will be discarded when you Apply; the combined result is not preserved.</p><button type="button" className="button mini subtle" disabled={immutable || dragging || !keep || !complete} onClick={() => { if (immutable || dragging || !keep) return; const next = collapseCurvesDraft(draft, keep); if (next) { recovery.current = { sessionKey, draft: structuredClone(draft) }; onChange(next); } }}>Use only this curve</button></details>
    </> : <>
      <button type="button" className="button mini subtle" disabled={immutable || dragging || !bankSupported || !complete} onClick={() => { if (immutable || dragging || !bankSupported) return; const next = upgradeCurvesDraft(draft); if (next) { recovery.current = { sessionKey, draft: structuredClone(draft) }; inspection.bank = current.channel === 'rgb' ? 'master' : current.channel; onChange(next); } }}>Upgrade to channel banks</button>
      <p className="property-hint">Keep this curve and add independent Master, Red, Green and Blue curves.{!bankSupported && ' Native curve-bank support is unavailable here.'}</p>
    </>}
    {recovery.current && <button type="button" className="button mini subtle curve-conversion-recover" disabled={immutable || dragging} onClick={restore}>{recovery.current.draft.mode === 'banks' ? 'Restore bank draft' : 'Return to single draft'}</button>}
  </div>;
}
