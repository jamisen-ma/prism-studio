import { useEffect, useState, type PointerEvent, type RefObject } from 'react';
import { ArrowLeft, Check, Plus, Ruler, Trash2 } from 'lucide-react';
import type { Backend, Document, Guide } from './api';
import type { RunCommand } from './CanvasTools';
import { uniqueGuides } from './guide-snapping';
import './guides.css';

export type GuideView = { rulers: boolean; guides: boolean; snap: boolean };
const defaults: GuideView = { rulers: false, guides: true, snap: false };
export function useGuideView() {
  const [view, setView] = useState<GuideView>(() => { try { const saved = JSON.parse(localStorage.getItem('prism:guide-view:v1') || '{}'); return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, typeof saved[key] === 'boolean' ? saved[key] : fallback])) as GuideView; } catch { return defaults; } });
  useEffect(() => { try { localStorage.setItem('prism:guide-view:v1', JSON.stringify(view)); } catch { /* Local view flags do not require storage. */ } }, [view]);
  return [view, setView] as const;
}

export function GuideOverlay({ document, highlighted = [] }: { document: Document; highlighted?: Guide[] }) {
  return <div className="canvas-guides" aria-hidden="true">{uniqueGuides(document.guides || []).map(guide => <i key={guide.id} data-guide-axis={guide.axis} data-guide-position={guide.position} className={`canvas-guide ${guide.axis} ${highlighted.some(item => item.axis === guide.axis && item.position === guide.position) ? 'snapped' : ''}`} style={guide.axis === 'vertical' ? { left: `${guide.position / document.width * 100}%` } : { top: `${guide.position / document.height * 100}%` }} />)}</div>;
}

type Geometry = { x: number; y: number; sx: number; sy: number; width: number; height: number };
type RulerDrag = { axis: Guide['axis']; offset: number; position: number | null; pointerId: number };
export function CanvasRulers({ document, viewportRef, artboardRef, measureKey, onLayout, onCreateGuide }: { document: Document; viewportRef: RefObject<HTMLDivElement | null>; artboardRef: RefObject<HTMLDivElement | null>; measureKey: string; onLayout: () => void; onCreateGuide?: (axis: Guide['axis'], position: number) => void }) {
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const [drag, setDrag] = useState<RulerDrag | null>(null);
  // Like Photoshop: drag out of the top ruler for a horizontal guide, the left ruler for a vertical one; release off the canvas area to cancel.
  const locate = (axis: Guide['axis'], event: PointerEvent<SVGSVGElement>): RulerDrag | null => {
    const viewport = viewportRef.current, board = artboardRef.current;
    if (!viewport || !board) return null;
    const horizontal = axis === 'horizontal', view = viewport.getBoundingClientRect(), rect = board.getBoundingClientRect();
    const client = horizontal ? event.clientY : event.clientX, offset = client - (horizontal ? view.top + viewport.clientTop : view.left + viewport.clientLeft);
    const inside = offset >= 0 && offset <= (horizontal ? viewport.clientHeight : viewport.clientWidth), limit = horizontal ? document.height : document.width;
    const position = Math.round((client - (horizontal ? rect.top : rect.left)) / ((horizontal ? rect.height : rect.width) / limit));
    return { axis, offset, position: inside && position >= 0 && position <= limit ? position : null, pointerId: event.pointerId };
  };
  const rulerEvents = (axis: Guide['axis']) => onCreateGuide ? {
    onPointerDown: (event: PointerEvent<SVGSVGElement>) => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); setDrag(locate(axis, event)); },
    onPointerMove: (event: PointerEvent<SVGSVGElement>) => { if (drag?.pointerId === event.pointerId) setDrag(locate(axis, event)); },
    onPointerUp: (event: PointerEvent<SVGSVGElement>) => { if (drag?.pointerId !== event.pointerId) return; const final = locate(axis, event); setDrag(null); if (final?.position != null) onCreateGuide(axis, final.position); },
    onPointerCancel: () => setDrag(null), onLostPointerCapture: () => setDrag(null),
  } : {};
  useEffect(() => {
    const viewport = viewportRef.current, artboard = artboardRef.current;
    if (!viewport || !artboard) return;
    let frame = 0;
    const update = () => {
      frame = 0; const view = viewport.getBoundingClientRect(), board = artboard.getBoundingClientRect();
      const next = { x: board.left - view.left - viewport.clientLeft, y: board.top - view.top - viewport.clientTop, sx: board.width / document.width, sy: board.height / document.height, width: viewport.clientWidth, height: viewport.clientHeight };
      if (next.sx > 0 && next.sy > 0) setGeometry(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const observer = new ResizeObserver(schedule); observer.observe(viewport); observer.observe(artboard);
    viewport.addEventListener('scroll', schedule, { passive: true }); window.addEventListener('resize', schedule); update();
    return () => { observer.disconnect(); viewport.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule); cancelAnimationFrame(frame); };
  }, [document.id, document.width, document.height, measureKey]);
  const ticks = (origin: number, scale: number, available: number, dimension: number) => {
    let interval = 1;
    outer: for (let exponent = 0; exponent < 7; exponent++) for (const factor of [1, 2, 5]) { const candidate = factor * 10 ** exponent; if (candidate * scale >= 64) { interval = candidate; break outer; } }
    const minor = interval % 5 === 0 && interval / 5 * scale >= 8 ? interval / 5 : interval;
    const first = Math.max(0, Math.ceil(-origin / scale / minor) * minor), end = Math.min(dimension, (available - origin) / scale);
    return Array.from({ length: Math.min(256, Math.max(0, Math.floor((end - first) / minor) + 1)) }, (_, index) => { const value = first + index * minor; return { value, screen: origin + value * scale, major: value % interval === 0 }; });
  };
  return <><button className="ruler-corner" aria-label="Open layout guides" onClick={onLayout}><Ruler size={12} /></button>
    <svg className={`canvas-ruler horizontal-ruler ${onCreateGuide ? 'guide-source' : ''}`} {...rulerEvents('horizontal')} role="img" aria-label="Horizontal ruler in document pixels" width={geometry?.width || 1} height="20">{geometry && ticks(geometry.x, geometry.sx, geometry.width, document.width).map(tick => <g key={tick.value} data-ruler-position={tick.value}><line x1={tick.screen} x2={tick.screen} y1={tick.major ? 12 : 16} y2="20" />{tick.major && <text x={tick.screen + 3} y="9">{tick.value}</text>}</g>)}</svg>
    <svg className={`canvas-ruler vertical-ruler ${onCreateGuide ? 'guide-source' : ''}`} {...rulerEvents('vertical')} role="img" aria-label="Vertical ruler in document pixels" width="20" height={geometry?.height || 1}>{geometry && ticks(geometry.y, geometry.sy, geometry.height, document.height).map(tick => <g key={tick.value} data-ruler-position={tick.value}><line y1={tick.screen} y2={tick.screen} x1={tick.major ? 12 : 16} x2="20" />{tick.major && <text transform={`translate(9 ${tick.screen + 3}) rotate(90)`}>{tick.value}</text>}</g>)}</svg>
    {drag && <i className={`canvas-guide ruler-drag-guide ${drag.axis} ${drag.position == null ? 'cancel' : ''}`} aria-hidden="true" style={drag.axis === 'horizontal' ? { top: 20 + drag.offset, left: 20, right: 0 } : { left: 20 + drag.offset, top: 20, bottom: 0 }} />}
  </>;
}

export function GuidesPanel({ document, capabilities, view, setView, busy, run, can, snapReason, onBack }: { document: Document; capabilities: Backend; view: GuideView; setView: (view: GuideView) => void; busy: boolean; run: RunCommand; can: (command: string) => boolean; snapReason: string; onBack: () => void }) {
  const guides = document.guides || [], max = capabilities.limits?.maxGuides || 64;
  const [axis, setAxis] = useState<Guide['axis']>('vertical'), [position, setPosition] = useState('0');
  const [id, setId] = useState(guides[0]?.id || ''), [updatedPosition, setUpdatedPosition] = useState('0');
  const selected = guides.find(guide => guide.id === id), limit = axis === 'vertical' ? document.width : document.height;
  const valid = (value: string, bound: number) => value.trim() !== '' && Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= bound;
  useEffect(() => { if (!guides.some(guide => guide.id === id)) setId(guides[0]?.id || ''); }, [document.revision, id]);
  useEffect(() => { setUpdatedPosition(String(selected?.position ?? 0)); }, [selected?.id, selected?.position]);
  const add = async () => { if (!valid(position, limit) || busy || guides.length >= max) return; const ids = new Set(guides.map(guide => guide.id)); const result = await run('add_guide', { axis, position: Number(position) }, 'Adding guide'); const created = result?.document?.guides?.find(guide => !ids.has(guide.id)); if (created) setId(created.id); };
  return <section className="panel-section guides-panel" aria-label="Canvas layout"><button className="button mini subtle" onClick={onBack}><ArrowLeft size={12} />Back to layers</button><div className="section-heading"><span>Rulers & guides</span><Ruler size={15} /></div>
    <div className="guide-view-options">{([['rulers', 'Show rulers'], ['guides', 'Show guides'], ['snap', 'Snap Move to guides']] as const).map(([key, label]) => <label key={key}><input type="checkbox" aria-label={label} checked={view[key]} disabled={key === 'snap' && !view.guides} onChange={event => setView({ ...view, [key]: event.target.checked })} />{label}</label>)}</div>
    <p className="property-hint">View switches stay on this device and do not create history. Guides never appear in rendered exports.</p>
    {!view.guides && <p className="guide-note">Show guides to enable snapping.</p>}{view.snap && view.guides && snapReason && <p className="guide-note">{snapReason}</p>}
    <p className="property-hint">Move snaps displayed bounds within 6 screen pixels. Hold Alt to bypass. Half-pixel centers are skipped; clipping can change final visible edges.</p>
    <form onSubmit={event => { event.preventDefault(); void add(); }}><div className="section-heading"><span>New guide</span><small>{guides.length} / {max}</small></div><label className="field-label">Orientation<select aria-label="New guide orientation" value={axis} disabled={busy} onChange={event => setAxis(event.target.value as Guide['axis'])}>{(capabilities.guideAxes || []).map(value => <option key={value} value={value}>{value === 'vertical' ? 'Vertical · X position' : 'Horizontal · Y position'}</option>)}</select></label><label className="field-label">Position, px · 0–{limit}<input type="number" aria-label="New guide position" min="0" max={limit} step="1" value={position} disabled={busy} onChange={event => setPosition(event.target.value)} /></label><button type="submit" className="button secondary wide" disabled={busy || !valid(position, limit) || guides.length >= max || !can('add_guide')}><Plus size={12} />Add guide</button></form>
    {guides.length >= max && <p className="guide-note">All {max} guides are used. Update or delete an existing guide.</p>}
    <div className="saved-guide-controls"><div className="section-heading"><span>Document guides</span></div>{guides.length ? <><label className="field-label">Saved guide<select aria-label="Saved guide" value={selected?.id || ''} disabled={busy} onChange={event => setId(event.target.value)}>{guides.map((guide, index) => <option key={guide.id} value={guide.id}>{index + 1}. {guide.axis === 'vertical' ? 'Vertical X' : 'Horizontal Y'} · {guide.position} px</option>)}</select></label>{selected && <><label className="field-label">Position, px · 0–{selected.axis === 'vertical' ? document.width : document.height}<input type="number" aria-label="Saved guide position" min="0" max={selected.axis === 'vertical' ? document.width : document.height} step="1" value={updatedPosition} disabled={busy} onChange={event => setUpdatedPosition(event.target.value)} /></label><button className="button secondary wide" disabled={busy || !valid(updatedPosition, selected.axis === 'vertical' ? document.width : document.height) || Number(updatedPosition) === selected.position || !can('update_guide')} onClick={() => void run('update_guide', { guideId: selected.id, position: Number(updatedPosition) }, 'Updating guide')}><Check size={12} />Update guide position</button><button className="button subtle wide" disabled={busy || !can('delete_guide')} onClick={() => void run('delete_guide', { guideId: selected.id }, 'Deleting guide')}><Trash2 size={12} />Delete guide</button></>}</> : <p className="property-hint">No guides in this document.</p>}<button className="button subtle wide" disabled={busy || !guides.length || !can('clear_guides')} onClick={() => void run('clear_guides', {}, 'Clearing guides')}>Clear all guides</button></div>
    <p className="property-hint">Guide edits can be undone and are included in .prism projects. Position uses document pixels, including canvas edges.</p>
  </section>;
}
