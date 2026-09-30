import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Trash2 } from 'lucide-react';
import type { Histogram } from './api';
import { compileSmoothCurveLookup } from '../shared/smooth-curves.mjs';
import { dragCurvePoint, insertCurvePoint, parseCurvesDraft, toCurvesDraft, type CurvesDraft } from './curves';
import './curves.css';

type Props = { bankName?: string; lookup?: Uint8Array; selectedPoint?: number; onSelectedPoint?: (index: number) => void; draft: CurvesDraft; onChange: (draft: CurvesDraft) => void; histogram: Histogram | null; disabled?: boolean; smoothSupported: boolean; contextKey: string; sessionKey: string; onDragging: (dragging: boolean) => void };
type Ticket = { sessionKey: string; epoch: number; pointerId: number; element: SVGSVGElement; index: number; before: CurvesDraft; base: CurvesDraft; clientX: number; clientY: number; matrix: DOMMatrix; inverse: DOMMatrix };
export function CurvesControl(props: Props) {
  const { draft, onChange, histogram, disabled = false, smoothSupported, contextKey, onDragging } = props;
  const [localSelected, setLocalSelected] = useState(0), ticket = useRef<Ticket | null>(null), epoch = useRef(0);
  const current = useRef(props); current.current = props;
  const owner = useRef(contextKey);
  const selected = props.selectedPoint ?? localSelected, setSelected = (index: number) => { setLocalSelected(index); props.onSelectedPoint?.(index); };
  const valid = parseCurvesDraft(draft), index = Math.min(selected, draft.points.length - 1), point = draft.points[index];
  const release = (t: Ticket) => { if (t.element.hasPointerCapture(t.pointerId)) t.element.releasePointerCapture(t.pointerId); };
  const cancel = (restore = true) => { const t = ticket.current; ticket.current = null; epoch.current++; if (t) { if (restore && t.sessionKey === current.current.sessionKey) current.current.onChange(structuredClone(t.before)); release(t); current.current.onDragging(false); } };
  useEffect(() => { if (owner.current !== contextKey) { cancel(); owner.current = contextKey; } }, [contextKey]);
  useEffect(() => { if (disabled) cancel(); }, [disabled]);
  useEffect(() => { const escape = (e: KeyboardEvent) => { if (e.key === 'Escape' && ticket.current) { e.preventDefault(); e.stopPropagation(); cancel(); } }; window.addEventListener('keydown', escape, true); return () => { window.removeEventListener('keydown', escape, true); cancel(false); }; }, []);
  const local = (change: (value: CurvesDraft) => CurvesDraft) => { const base = ticket.current?.before ?? draft; cancel(); onChange(change(structuredClone(base))); };
  const sameBounds = (t: Ticket) => { const m = t.element.getScreenCTM(); return m && (['a', 'b', 'c', 'd', 'e', 'f'] as const).every(k => m[k] === t.matrix[k]); };
  const move = (event: PointerEvent<SVGSVGElement>) => {
    const t = ticket.current; if (!t || t.pointerId !== event.pointerId) return;
    event.stopPropagation();
    if (t.epoch !== epoch.current || owner.current !== current.current.contextKey || current.current.disabled || !sameBounds(t)) { cancel(); return; }
    const dx = event.clientX - t.clientX, dy = event.clientY - t.clientY;
    onChange(dragCurvePoint(t.base, t.index, t.inverse.a * dx + t.inverse.c * dy, -(t.inverse.b * dx + t.inverse.d * dy)));
  };
  let line = '';
  if (valid) line = props.lookup || draft.interpolation === 'smooth' ? Array.from(props.lookup ?? compileSmoothCurveLookup(valid.points), (y, x) => `${x},${255 - y}`).join(' ') : valid.points.map(p => `${p.x},${255 - p.y}`).join(' ');
  const histogramValues = histogram && (draft.channel === 'rgb' ? histogram.luminance : histogram[draft.channel]), max = Math.max(1, ...(histogramValues ?? []));
  return <div className="curves-controls">
    <div className="curve-mode-fields">{!props.bankName && <label className="curve-channel">Channel<select aria-label="Curve channel" disabled={disabled} value={draft.channel} onChange={e => local(v => ({ ...v, channel: e.target.value as CurvesDraft['channel'] }))}>{['rgb', 'red', 'green', 'blue'].map(c => <option key={c} value={c}>{c === 'rgb' ? 'RGB composite' : c[0].toUpperCase() + c.slice(1)}</option>)}</select></label>}
      <label className="curve-channel">Interpolation<select aria-label="Curve interpolation" disabled={disabled} value={draft.interpolation} onChange={e => local(v => ({ ...v, interpolation: e.target.value as CurvesDraft['interpolation'] }))}><option value="linear">Linear</option><option value="smooth" disabled={!smoothSupported}>Smooth · native{!smoothSupported ? ' · unavailable' : ''}</option></select></label></div>
    <svg className={`curve-editor channel-${draft.channel}`} viewBox="0 0 255 255" role="img" aria-disabled={disabled || !valid} aria-label="Interactive tone curve: click to add points, drag to adjust" onPointerDown={event => {
      event.stopPropagation(); if (disabled || !valid || ticket.current || event.button !== 0) return;
      const matrix = event.currentTarget.getScreenCTM(); if (!matrix) return; const inverse = matrix.inverse(); if (![inverse.a, inverse.b, inverse.c, inverse.d, inverse.e, inverse.f].every(Number.isFinite)) return;
      const screen = new DOMPoint(event.clientX, event.clientY).matrixTransform(inverse), p = { x: screen.x, y: 255 - screen.y };
      const nearest = valid.points.map((v, i) => ({ i, distance: Math.hypot(v.x - p.x, v.y - p.y) })).sort((a, b) => a.distance - b.distance);
      let chosen = nearest[0].distance < 14 ? nearest[0].i : -1, base = structuredClone(draft);
      if (chosen < 0 && base.points.length < 16) { const x = Math.max(0, Math.min(255, Math.round(p.x))), y = Math.max(0, Math.min(255, Math.round(p.y))); if (x <= 0 || x >= 255 || valid.points.some(v => v.x === x)) return; base.points.push({ x: String(x), y: String(y) }); base.points.sort((a, b) => Number(a.x) - Number(b.x)); chosen = base.points.findIndex(v => Number(v.x) === x); }
      if (chosen < 0) return;
      owner.current = contextKey; const t = { sessionKey: props.sessionKey, epoch: ++epoch.current, pointerId: event.pointerId, element: event.currentTarget, index: chosen, before: structuredClone(draft), base, clientX: event.clientX, clientY: event.clientY, matrix, inverse }; ticket.current = t;
      setSelected(chosen); onChange(base); onDragging(true); event.currentTarget.setPointerCapture(event.pointerId);
    }} onPointerMove={move} onPointerUp={event => { const t = ticket.current; if (!t || t.pointerId !== event.pointerId) return; move(event); if (ticket.current === t) { ticket.current = null; release(t); onDragging(false); } }} onPointerCancel={event => { if (ticket.current?.pointerId === event.pointerId) { event.stopPropagation(); cancel(); } }} onLostPointerCapture={event => { if (ticket.current?.pointerId === event.pointerId && !event.currentTarget.hasPointerCapture(event.pointerId)) cancel(); }}>
      <path className="curve-grid" d="M64 0V255M128 0V255M192 0V255M0 64H255M0 128H255M0 192H255" />
      {histogramValues && <path className="curve-histogram" d={`M0 255 ${histogramValues.map((v, x) => `L${x} ${255 - Math.sqrt(v / max) * 252}`).join(' ')} L255 255 Z`} />}
      <path className="curve-diagonal" d="M0 255L255 0" />{line && <polyline className="curve-line" points={line} />}
      {valid?.points.map((p, i) => <circle key={i} className={`curve-point ${index === i ? 'selected' : ''}`} cx={p.x} cy={255 - p.y} r="4" />)}
    </svg>
    <label className="curve-point-selector">Point<select aria-label="Selected curve point" value={index} onChange={e => { cancel(); setSelected(Number(e.target.value)); }}>{draft.points.map((p, i) => <option key={i} value={i}>{i + 1} · {p.x || '…'} → {p.y || '…'}</option>)}</select></label>
    <div className="curve-point-fields"><label>Input<input aria-label="Curve point input" type="text" inputMode="decimal" step="any" value={point.x} disabled={disabled || index === 0 || index === draft.points.length - 1} onChange={e => local(v => { v.points[index].x = e.target.value; return v; })} /></label><label>Output<input aria-label="Curve point output" type="text" inputMode="decimal" step="any" value={point.y} disabled={disabled} onChange={e => local(v => { v.points[index].y = e.target.value; return v; })} /></label><button type="button" aria-label="Delete curve point" className="icon-button" disabled={disabled || index === 0 || index === draft.points.length - 1} onClick={() => { local(v => ({ ...v, points: v.points.filter((_, i) => i !== index) })); setSelected(0); }}><Trash2 size={13} /></button></div>
    <div className="curve-local-actions"><button type="button" className="button mini subtle" aria-label="Add curve point" disabled={disabled || !valid || draft.points.length >= 16 || Boolean(ticket.current)} onClick={() => { const next = insertCurvePoint(draft); if (next) { local(() => next.draft); setSelected(next.index); } }}>Add point</button>
    <button type="button" className="button mini subtle curve-reset" aria-label={props.bankName ? 'Reset this bank' : 'Reset curve points'} disabled={disabled} onClick={() => local(() => toCurvesDraft())}>{props.bankName ? 'Reset this bank' : 'Reset curve'}</button></div>
    {!valid && <p className="inline-panel-error">Use 2–16 finite points from 0 to 255, with strictly increasing inputs and endpoints at 0 and 255. Fractions are retained.</p>}
    {draft.interpolation === 'smooth' && !smoothSupported && <p className="tonal-unavailable">This companion does not advertise native Smooth Curves. Your mode and points are retained.</p>}
    <p className="curve-help">{props.bankName ? `${props.bankName} maps input tones to output tones. Apply saves all banks.` : 'Maps input tones to output tones. Changes are saved with Apply.'}{draft.interpolation === 'smooth' ? " Smooth uses Prism's shape-preserving 8-bit lookup." : ' Linear connects the entered points.'}</p>
    {!props.bankName && <details className="curve-details"><summary>How Curves works</summary><p>One point set maps the selected channel. Numeric fields accept exact fractions; choose a point from the list when points overlap. Add point inserts a local midpoint in the largest input gap; review its values before Apply.</p><p>Graph dragging authors whole units only on moved axes. If an input cannot fit between close neighbors, its saved input stays unchanged; use the numeric field for precise placement.</p><p>Smooth draws the actual 256 input-byte outputs, with fractional knots marked separately. It preserves each interval's shape. Two-point curves are mathematically straight; rounding at half boundaries can differ from Linear. This native curve does not recover clipped detail.</p><p>Source filters preserve transparency and blend with their input before the stack effect mask. Even an identity curve can change colors with a nonnormal filter blend. Global adjustments keep their existing selection and layer-mask scope.</p></details>}
  </div>;
}
