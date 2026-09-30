import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { LoaderCircle, Move, RefreshCw } from 'lucide-react';
import { command, type Document, type Guide, type Layer } from './api';
import type { CanvasTool, RunCommand } from './CanvasTools';
import { captureGesture, releaseGesturePointer, type GestureContext, type PointerCapture } from './gesture';
import { layerAncestors } from './layer-tree';
import { moveSnapReason, snapMove, uniqueGuides, type SnapResult } from './guide-snapping';
import './move-tool.css';

type Bounds = { x: number; y: number; width: number; height: number };
type PreviewBounds = { documentId: string; layerId: string; revision: number; boundsSpace: string; visibleBounds: Bounds | null };
type Drag = { context: GestureContext; pointer: PointerCapture; startX: number; startY: number; scaleX: number; scaleY: number; x: number; y: number; bounds: Bounds; rect: { left: number; top: number; width: number; height: number }; guides: Guide[]; lastX: number; lastY: number; width: number; height: number };
type Props = { document: Document | null; layer?: Layer; tool: CanvasTool; busy: boolean; enabled: boolean; run: RunCommand; snapEnabled?: boolean; showGuides?: boolean; viewKey?: string; notify: (message: string, error?: boolean) => void };

export function useMoveTool({ document, layer, tool, busy, enabled, run, notify, snapEnabled = false, showGuides = true, viewKey }: Props) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; bounds?: Bounds | null; error?: string } | null>(null);
  const [delta, setDelta] = useState<{ x: number; y: number } | null>(null);
  const [snapGuides, setSnapGuides] = useState<Guide[]>([]);
  const drag = useRef<Drag | null>(null);
  const nudge = useRef<{ layerId: string; x: number; y: number } | null>(null);
  const nudging = useRef(false);
  const [nudgeTick, setNudgeTick] = useState(0);
  const active = tool === 'move' && enabled && document?.backend === 'native';
  const ineligible = !document || !layer ? 'Select a content layer to move.' : ['group', 'adjustment'].includes(layer.type) ? 'Choose an image, text, shape, path or gradient. Groups and adjustments cannot be dragged.' : !layer.visible || layer.opacity === 0 ? 'Show the selected layer and raise its opacity before moving it.' : layerAncestors(document.layers, layer).some(parent => !parent.visible) ? 'Show the parent groups before moving this layer.' : '';
  const key = `${document?.backend}:${document?.id}:${document?.revision}:${layer?.id}:${active}:${attempt}`;
  const current = result?.key === key ? result : null;
  const loading = Boolean(active && !ineligible && !current);
  const bounds = current?.bounds || null;
  const reason = ineligible || current?.error || (!loading && current && !bounds ? 'This layer has no visible pixels inside the canvas to move.' : '');
  const snapReason = moveSnapReason(document, layer, bounds);
  const clear = () => { const previous = drag.current; drag.current = null; releaseGesturePointer(previous?.pointer); setDelta(null); setSnapGuides([]); };
  const resolved = (current: Drag, clientX: number, clientY: number, alt: boolean, shift = false): SnapResult => {
    let x = Math.round((clientX - current.startX) * current.scaleX), y = Math.round((clientY - current.startY) * current.scaleY);
    if (shift) { if (Math.abs(x) >= Math.abs(y)) y = 0; else x = 0; } // Photoshop: Shift-drag constrains to the dominant axis.
    if (shift) return { x, y, guides: [] };
    return alt || !current.guides.length ? { x, y, guides: [] } : snapMove(x, y, current.bounds, current.guides, 1 / current.scaleX, 1 / current.scaleY, current.width, current.height);
  };
  const geometryChanged = (current: Drag) => { const rect = current.pointer.element.getBoundingClientRect(); return (['left', 'top', 'width', 'height'] as const).some(key => Math.abs(rect[key] - current.rect[key]) > 0.05); };
  const cancelLayout = () => { clear(); notify('Move cancelled because the canvas view changed. Start again at the current zoom and scroll position.', true); };
  const applyPreview = (current: Drag, result: SnapResult) => { current.x = result.x; current.y = result.y; setDelta({ x: result.x, y: result.y }); setSnapGuides(result.guides); };
  const latest = useRef({ active, ineligible, document, layer });
  latest.current = { active, ineligible, document, layer };
  const flushNudge = useRef(() => {});
  flushNudge.current = () => {
    const pending = nudge.current;
    if (!pending || nudging.current || busy || !document || layer?.id !== pending.layerId || !active || ineligible) return;
    nudge.current = null;
    if (!pending.x && !pending.y) return;
    nudging.current = true;
    void run('transform_layer', { layerId: pending.layerId, x: pending.x, y: pending.y }, 'Nudging selected layer', captureGesture(document, pending.layerId)).finally(() => { nudging.current = false; setNudgeTick(value => value + 1); });
  };
  useEffect(() => { if (!busy) flushNudge.current(); }, [busy, document?.revision, nudgeTick]);
  useEffect(() => { nudge.current = null; }, [document?.id, layer?.id, tool]);
  useEffect(() => { clear(); }, [document?.backend, document?.id, document?.width, document?.height, layer?.id, tool, viewKey, snapEnabled, showGuides]);
  useEffect(() => {
    let valid = true;
    if (active && !ineligible && document && layer) void command<PreviewBounds>('native', 'get_layer_preview', { documentId: document.id, layerId: layer.id, view: 'layer', maxWidth: 32 }).then(preview => {
      if (!valid) return;
      if (preview.documentId !== document.id || preview.layerId !== layer.id || preview.revision !== document.revision || preview.boundsSpace !== 'document') throw Error('The document changed while reading layer bounds. Retry after the canvas refreshes.');
      setResult({ key, bounds: preview.visibleBounds });
    }).catch(error => { if (valid) setResult({ key, error: error instanceof Error ? error.message : 'Could not read layer bounds.' }); });
    return () => { valid = false; };
  }, [key, ineligible]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { clear(); return; }
      const current = drag.current;
      if ((event.key === 'Alt' || event.key === 'Shift') && current) { if (geometryChanged(current)) cancelLayout(); else applyPreview(current, resolved(current, current.lastX, current.lastY, event.altKey, event.shiftKey)); }
      const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (event.type !== 'keydown' || !step || current || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('input, textarea, select, [contenteditable], [role="dialog"]')) return;
      const state = latest.current;
      if (!state.active || state.ineligible || !state.document || !state.layer) return;
      event.preventDefault(); // Photoshop: arrows nudge 1 px, Shift+arrow 10 px.
      const amount = event.shiftKey ? 10 : 1;
      nudge.current = { layerId: state.layer.id, x: (nudge.current?.layerId === state.layer.id ? nudge.current.x : 0) + step[0] * amount, y: (nudge.current?.layerId === state.layer.id ? nudge.current.y : 0) + step[1] * amount };
      flushNudge.current();
    };
    window.addEventListener('keydown', key); window.addEventListener('keyup', key);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('keyup', key); };
  }, []);
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (tool !== 'move') return false;
    if (!active || !document || !layer || busy || event.button !== 0 || drag.current) return true;
    if (reason || !bounds) { notify(reason || 'Reading layer bounds. Try the drag again when they are ready.', true); return true; }
    const rect = event.currentTarget.getBoundingClientRect();
    drag.current = { context: captureGesture(document, layer.id), pointer: { element: event.currentTarget, pointerId: event.pointerId }, startX: event.clientX, startY: event.clientY, scaleX: document.width / rect.width, scaleY: document.height / rect.height, x: 0, y: 0, bounds: { ...bounds }, rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, guides: snapEnabled && showGuides && !snapReason ? uniqueGuides(document.guides || []) : [], lastX: event.clientX, lastY: event.clientY, width: document.width, height: document.height };
    setDelta({ x: 0, y: 0 }); event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); return true;
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (tool !== 'move') return false;
    const current = drag.current;
    if (current && current.pointer.pointerId === event.pointerId) { if (geometryChanged(current)) { cancelLayout(); return true; } current.lastX = event.clientX; current.lastY = event.clientY; applyPreview(current, resolved(current, event.clientX, event.clientY, event.altKey, event.shiftKey)); }
    return true;
  };
  const up = (event: PointerEvent<HTMLDivElement>) => {
    if (tool !== 'move') return false;
    const current = drag.current;
    if (!current || current.pointer.pointerId !== event.pointerId) return true;
    if (geometryChanged(current)) { cancelLayout(); return true; }
    const { x, y } = resolved(current, event.clientX, event.clientY, event.altKey, event.shiftKey);
    clear();
    if (x || y) void run('transform_layer', { layerId: current.context.targetLayerId, x, y }, 'Moving selected layer', current.context);
    return true;
  };
  return { down, move, up, cancel: (event: PointerEvent<HTMLDivElement>) => { if (drag.current?.pointer.pointerId === event.pointerId) clear(); }, dragging: Boolean(drag.current), bounds: drag.current?.bounds || bounds, delta, snapGuides, snapReason, loading, reason, retry: current?.error ? () => setAttempt(value => value + 1) : undefined, active };
}

export function MoveOptions({ layer, loading, reason, retry, delta, snapReason = '', snapping = false, snapGuides = [] }: { snapping?: boolean; snapReason?: string; snapGuides?: Guide[]; layer?: Layer; loading: boolean; reason: string; retry?: () => void; delta: { x: number; y: number } | null }) {
  return <div className="pro-tool-options move-options" role="status"><Move size={13} /><strong>{layer?.name || 'Move selected layer'}</strong>{loading ? <span><LoaderCircle size={12} className="spin" />Reading layer bounds…</span> : reason ? <span className="move-warning">{reason}</span> : <span>{delta ? `${delta.x} px horizontally · ${delta.y} px vertically` : 'Drag to translate · guide only until release · Esc cancels'}</span>}{retry && <button className="button mini subtle" onClick={retry}><RefreshCw size={12} />Retry bounds</button>}<small>{snapping ? snapReason || (snapGuides.length ? `Snapped to ${snapGuides.map(guide => `${guide.axis === 'vertical' ? 'X' : 'Y'} ${guide.position}`).join(' · ')} · Alt bypasses` : 'Snap to visible guides · Alt bypasses') : 'Layer masks stay fixed to the canvas. Edges may clip.'}</small></div>;
}

export function MoveGuide({ document, bounds, delta }: { document: Document; bounds: Bounds | null; delta: { x: number; y: number } | null }) {
  if (!bounds) return null;
  return <div className={`move-guide ${delta ? 'dragging' : ''}`} role="img" aria-label={delta ? `Movement guide: ${delta.x} pixels horizontally, ${delta.y} pixels vertically` : 'Selected layer visible bounds'} data-delta-x={delta?.x || 0} data-delta-y={delta?.y || 0} style={{ left: `${(bounds.x + (delta?.x || 0)) / document.width * 100}%`, top: `${(bounds.y + (delta?.y || 0)) / document.height * 100}%`, width: `${bounds.width / document.width * 100}%`, height: `${bounds.height / document.height * 100}%` }}>{delta && <span>Movement guide · pixels update on release</span>}</div>;
}
