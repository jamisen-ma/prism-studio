import { Alpha8SelectionOverlay } from './Alpha8SelectionOverlay';
import { maskShapeLabel, paintSelectionCoverage, supportsMask } from './dense-mask';
import { filterStackActionHint, supportsFilterBake } from './filter-bake';
import { useEffect, useId, useRef, useState, type PointerEvent } from 'react';
import { Layers, Plus, RefreshCw } from 'lucide-react';
import { captureGesture, releaseGesturePointer, type GestureContext, type PointerCapture } from './gesture';
import { canEditCutoutAlpha, isPositionedMask, type Backend, type Document, type Layer, type Mask, type Point } from './api';

import { POSITION_MATERIALIZATION_NOTICE } from './MaskPosition';
import { DEFAULT_RETOUCH, effectiveRetouch, isRetouch, retouchArgs, retouchScopeReason, type RetouchSampling } from './RetouchTools';
import { acceptCloneDocument, beginCloneStroke, cancelCloneStroke, cloneSampleCenter, createCloneSession, finishCloneStroke, ownsCloneStroke, setCloneAligned, setCloneAnchor, submitCloneStroke, syncCloneSession, type CloneContext, type CloneTicket } from './clone-session';

export type PaintTool = 'brush' | 'eraser' | 'clone' | 'heal' | 'dodge' | 'burn' | 'pencil' | 'blur' | 'sharpen' | 'smudge' | 'sponge' | 'red_eye' | 'color_replace';
export type CanvasTool = 'pointer' | 'move' | 'select' | 'ellipse' | 'lasso' | 'crop' | 'text' | 'hand' | 'shape' | 'pen' | 'gradient' | 'path_edit' | 'magic_wand' | 'bucket' | 'magic_eraser' | 'eyedropper' | 'selection_brush' | 'mask_brush' | 'cutout_brush' | 'row_select' | 'column_select' | PaintTool;
export type BrushSettings = { size: number; hardness: number; opacity: number; flow?: number; color: string; strength: number; tolerance: number; mode: 'add' | 'subtract' | 'replace' };
export type RunCommand = (command: string, args?: Record<string, unknown>, label?: string, gesture?: GestureContext) => Promise<{ document?: Document; layerId?: string; filterId?: string } | null>;
const FLOW_TOOLS: CanvasTool[] = ['brush', 'eraser', 'clone'];
export const PAINT_TOOLS: PaintTool[] = ['brush', 'eraser', 'clone', 'heal', 'dodge', 'burn', 'pencil', 'blur', 'sharpen', 'smudge', 'sponge', 'red_eye', 'color_replace'];
export const isPaintTool = (tool: CanvasTool): tool is PaintTool => PAINT_TOOLS.includes(tool as PaintTool);
export const isBrushTool = (tool: CanvasTool) => isPaintTool(tool) || tool === 'selection_brush' || tool === 'mask_brush' || tool === 'cutout_brush';
export const isSelectionTool = (tool: CanvasTool) => ['select', 'ellipse', 'lasso'].includes(tool);

type CanvasToolsProps = {
  document: Document | null; layer?: Layer; tool: CanvasTool; brush: BrushSettings;
  busy: boolean; enabled: boolean; selectionFeather: number; selectionInvert: boolean;
  sampling?: RetouchSampling; capabilities?: Backend;
  run: RunCommand; notify: (message: string, error?: boolean) => void;
};

export function useCanvasTools(props: CanvasToolsProps) {
  const { document, layer, tool, brush, busy, enabled, run, notify } = props;
  const [cursor, setCursor] = useState<Point | null>(null);
  const session = useRef(createCloneSession());
  const [, renderSession] = useState(0);
  const overlayTicket = useRef<CloneTicket | null>(null);
  const [stroke, setStroke] = useState<Point[]>([]);
  const [polygon, setPolygon] = useState<Point[]>([]);
  const [ellipse, setEllipse] = useState<Mask | null>(null);
  const drag = useRef<{ mode: 'paint' | 'selection' | 'mask' | 'cutout' | 'lasso' | 'ellipse'; points: Point[]; start: Point; layerId?: string; filterId?: string; context: GestureContext; tool: CanvasTool; brush: BrushSettings; source: Point | null; ticket?: CloneTicket; feather: number; invert: boolean; pointer: PointerCapture; sampling: RetouchSampling; samplingArgs: Record<string, unknown>; samplingKey: string; rect: { left: number; top: number; width: number; height: number } } | null>(null);
  const propsRef = useRef(props); propsRef.current = props;
  const sampling = effectiveRetouch(props.sampling || DEFAULT_RETOUCH, props.capabilities, tool);
  const samplingKey = JSON.stringify(retouchArgs(sampling, props.capabilities, tool));
  const liveContext = (): CloneContext => {
    const latest = propsRef.current, cap = latest.capabilities;
    return { backend: latest.document?.backend || '', documentId: latest.document?.id || '', targetLayerId: latest.layer?.id || '', width: latest.document?.width || 0, height: latest.document?.height || 0, revision: latest.document?.revision || 0, tool: latest.tool,
      available: Boolean(latest.document?.backend === 'native' && cap?.id === 'native' && cap.connected && cap.commands.includes('paint_stroke') && latest.enabled),
      samplingKey: JSON.stringify(retouchArgs(latest.sampling || DEFAULT_RETOUCH, cap, latest.tool)),
      capabilityKey: JSON.stringify([cap?.id, Boolean(cap?.connected), Boolean(cap?.commands.includes('paint_stroke')), Boolean(cap?.retouchSamplingTools?.includes(latest.tool)), cap?.retouchSampleModes?.slice().sort(), cap?.retouchIgnoreAdjustments, cap?.retouchCurrentAndBelowScope]),
    };
  };
  syncCloneSession(session.current, liveContext());
  const source = session.current.anchor;
  const sessionCurrent = (ticket: CloneTicket) => { syncCloneSession(session.current, liveContext()); return ownsCloneStroke(session.current, ticket); };
  const position = (event: PointerEvent<HTMLDivElement>): Point => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(document!.width - 0.001, (event.clientX - bounds.left) / bounds.width * document!.width)), y: Math.max(0, Math.min(document!.height - 0.001, (event.clientY - bounds.top) / bounds.height * document!.height)), pressure: event.pointerType === 'pen' ? event.pressure : 1 };
  };
  const clear = () => { const previous = drag.current; drag.current = null; if (previous?.ticket) cancelCloneStroke(session.current, previous.ticket); releaseGesturePointer(previous?.pointer); if (!overlayTicket.current) setStroke([]); setPolygon([]); setEllipse(null); };
  const resetSource = () => { clear(); setCloneAnchor(session.current, null); overlayTicket.current = null; setStroke([]); renderSession(value => value + 1); };
  useEffect(() => { clear(); setCursor(null); }, [document?.backend, document?.id, document?.width, document?.height, layer?.id]);
  useEffect(() => { clear(); setCursor(null); }, [tool]);
  useEffect(() => { if (isRetouch(tool)) clear(); }, [samplingKey]);
  useEffect(() => { if (drag.current?.ticket && !sessionCurrent(drag.current.ticket)) clear(); if (overlayTicket.current && !sessionCurrent(overlayTicket.current)) { overlayTicket.current = null; setStroke([]); } }, [session.current.epoch]);
  useEffect(() => { if (drag.current?.tool === 'mask_brush') clear(); }, [document?.revision]);
  const retouchContextChanged = (current: NonNullable<typeof drag.current>) => {
    if (!isRetouch(current.tool)) return false;
    const latest = propsRef.current, rect = current.pointer.element.getBoundingClientRect();
    if ((['left', 'top', 'width', 'height'] as const).some(key => Math.abs(rect[key] - current.rect[key]) > 0.05)) { clear(); notify('Retouch stroke cancelled because the canvas view changed. Start again at the current zoom and scroll position.', true); return true; }
    if (current.context.expectedRevision !== latest.document?.revision || current.samplingKey !== JSON.stringify(retouchArgs(latest.sampling || DEFAULT_RETOUCH, latest.capabilities, latest.tool)) || (current.ticket && !sessionCurrent(current.ticket))) { clear(); return true; }
    return false;
  };
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => { if (event.key === 'Escape') clear(); };
    window.addEventListener('keydown', cancel); return () => window.removeEventListener('keydown', cancel);
  }, []);

  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (!isBrushTool(tool) && tool !== 'ellipse' && tool !== 'lasso') return false;
    if (!document || busy || !enabled || event.button !== 0 || drag.current || (isRetouch(tool) && session.current.stroke)) return true;
    const active = document.selection && 'shape' in document.selection ? document.selection : null;
    if ((isPaintTool(tool) || tool === 'selection_brush' && brush.mode !== 'replace') && !supportsMask(active, props.capabilities) || tool === 'mask_brush' && brush.mode !== 'replace' && !supportsMask(layer?.mask, props.capabilities)) { notify('This connection cannot paint through this pixel mask. The current selection and mask are retained.', true); return true; }
    const point = position(event); setCursor(point);
    const rect = event.currentTarget.getBoundingClientRect();
    const captured = { sampling: { ...sampling }, samplingArgs: retouchArgs(sampling, props.capabilities, tool), samplingKey, rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, context: captureGesture(document, layer?.id), tool, brush: { ...brush }, source, feather: props.selectionFeather, invert: props.selectionInvert, pointer: { element: event.currentTarget, pointerId: event.pointerId } };
    if (isBrushTool(tool)) {
      const samplingReason = isRetouch(tool) ? retouchScopeReason(document, layer, sampling) : '';
      if (samplingReason) { notify(samplingReason, true); return true; }
      if ((tool === 'clone' || tool === 'heal') && event.altKey) { setCloneAnchor(session.current, point); overlayTicket.current = null; setStroke([]); renderSession(value => value + 1); notify('Sample source set. Paint to retouch.'); return true; }
      if ((tool === 'clone' || tool === 'heal') && !source) { notify('Hold Option / Alt and click the image to choose a sample source first.', true); return true; }
      // Like painting on a fresh Photoshop document: Brush/Pencil on a non-pixel layer
      // (solid background, text, shape…) paints onto a new paint layer instead of failing.
      const newPaintLayer = (tool === 'brush' || tool === 'pencil') && (!layer || layer.type !== 'raster' && layer.type !== 'group' || layer.protected);
      if (isPaintTool(tool) && !newPaintLayer && (!layer || layer.type !== 'raster')) { notify(layer && ['solid', 'text', 'shape', 'path', 'gradient'].includes(layer.type) ? `“${layer.name}” is not a pixel layer. Use Rasterize in the tool options, or paint on a paint layer.` : 'Choose a pixel layer, or add a paint layer, before using this tool.', true); return true; }
      if (isPaintTool(tool) && !newPaintLayer && layer?.protected) { notify('This layer’s original pixels are protected. Use Refine mask, or unprotect it in Layer properties before painting.', true); return true; }
      if ((isPaintTool(tool) && !newPaintLayer || tool === 'cutout_brush') && layer?.filters?.length) { notify(`${filterStackActionHint(supportsFilterBake(props.capabilities), 'painting or repairing source alpha')} A separate paint layer or additional layer mask stays editable.`, true); return true; }
      if ((tool === 'mask_brush' || tool === 'cutout_brush') && !layer) { notify('Choose a layer to paint its mask.', true); return true; }
      if (tool === 'cutout_brush' && !canEditCutoutAlpha(layer, document)) { notify('Refine the original source cutout before transforming or placing it. This layer can still use a regular layer mask.', true); return true; }
      if (isPaintTool(tool) && !newPaintLayer && layer && (!layer.visible || layer.opacity === 0)) { notify('Show this layer and raise its opacity before painting.', true); return true; }
      const ticket = isRetouch(tool) ? beginCloneStroke(session.current, point) : null;
      if (isRetouch(tool) && !ticket) return true;
      if (ticket) {
        captured.source = { ...ticket.source };
        captured.context.isCurrent = () => sessionCurrent(ticket);
        captured.context.retouch = { width: document.width, height: document.height,
          onDispatch: () => sessionCurrent(ticket) && submitCloneStroke(session.current, ticket),
          acceptDocument: next => sessionCurrent(ticket) && acceptCloneDocument(session.current, ticket, { ...liveContext(), backend: next.backend, documentId: next.id, width: next.width, height: next.height, revision: next.revision }),
        };
      }
      drag.current = { mode: tool === 'selection_brush' ? 'selection' : tool === 'mask_brush' ? 'mask' : tool === 'cutout_brush' ? 'cutout' : 'paint', points: [point], start: point, layerId: newPaintLayer ? undefined : layer?.id, ...captured, ...(ticket ? { ticket } : {}) }; setStroke([point]);
    } else if (tool === 'lasso') { drag.current = { mode: 'lasso', points: [point], start: point, ...captured }; setPolygon([point]); }
    else { drag.current = { mode: 'ellipse', points: [point], start: point, ...captured }; setEllipse({ shape: 'ellipse', x: point.x, y: point.y, width: 0, height: 0 }); }
    event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); return true;
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!document || (!isBrushTool(tool) && tool !== 'ellipse' && tool !== 'lasso')) return false;
    const current = drag.current;
    if (current && isRetouch(current.tool) && current.pointer.pointerId !== event.pointerId) return true;
    if (!current && session.current.stroke?.phase === 'pending' && isRetouch(tool)) return true;
    if (current && current.pointer.pointerId === event.pointerId && retouchContextChanged(current)) return true;
    const point = position(event); setCursor(point);
    if (!current || current.pointer.pointerId !== event.pointerId) return true;
    if (current.mode === 'ellipse') setEllipse({ shape: 'ellipse', x: Math.min(current.start.x, point.x), y: Math.min(current.start.y, point.y), width: Math.abs(current.start.x - point.x), height: Math.abs(current.start.y - point.y) });
    else {
      // Browsers deliver pointermove once per frame; the coalesced samples between frames keep fast strokes smooth instead of polygonal.
      const bounds = event.currentTarget.getBoundingClientRect(), spacing = Math.max(0.35, Math.min(4, current.brush.size / 8));
      const between = current.mode === 'lasso' ? [] : (event.nativeEvent.getCoalescedEvents?.() || []).slice(0, -1).map((sample): Point => ({ x: Math.max(0, Math.min(document.width - 0.001, (sample.clientX - bounds.left) / bounds.width * document.width)), y: Math.max(0, Math.min(document.height - 0.001, (sample.clientY - bounds.top) / bounds.height * document.height)), pressure: sample.pointerType === 'pen' ? sample.pressure : 1 }));
      for (const sample of between) { const last = current.points.at(-1)!; if (Math.hypot(sample.x - last.x, sample.y - last.y) >= spacing && Math.hypot(point.x - sample.x, point.y - sample.y) >= spacing) current.points.push(sample); }
      const previous = current.points.at(-1)!;
      const distance = Math.hypot(point.x - previous.x, point.y - previous.y);
      if (distance < (current.mode === 'lasso' ? 2 : 0.35)) { if (between.length) setStroke([...current.points]); return true; }
      current.points.push(point);
      if (current.ticket) current.ticket.lastPoint = { x: point.x, y: point.y };
      if (current.points.length > (current.mode === 'lasso' ? 250 : 1900)) current.points = current.points.filter((_, index) => index === 0 || index % 2 === 1);
      if (['paint', 'selection', 'mask', 'cutout'].includes(current.mode)) setStroke([...current.points]); else setPolygon([...current.points]);
    }
    return true;
  };
  const up = (event: PointerEvent<HTMLDivElement>) => {
    if (!isBrushTool(tool) && tool !== 'ellipse' && tool !== 'lasso') return false;
    const current = drag.current;
    if (!current || current.pointer.pointerId !== event.pointerId) return true;
    if (retouchContextChanged(current)) return true;
    // A deliberate release may synchronously dispatch lostpointercapture.
    // Detach the completed gesture first so that cancellation cannot re-enter.
    drag.current = null;
    releaseGesturePointer(current.pointer);
    const settings = propsRef.current;
    if (current.context.documentId !== settings.document?.id || current.context.backend !== settings.document?.backend || current.context.targetLayerId !== settings.layer?.id || current.tool !== settings.tool) { clear(); return true; }
    if (['paint', 'selection', 'mask', 'cutout'].includes(current.mode)) {
      const points = current.points.map(({ x, y, pressure }) => ({ x, y, pressure }));
      if (current.ticket) current.ticket.lastPoint = { x: points.at(-1)!.x, y: points.at(-1)!.y };
      const { mode, flow, ...paintSettings } = current.brush;
      const name = current.mode === 'selection' ? 'paint_selection' : current.mode === 'mask' ? 'paint_mask' : current.mode === 'cutout' ? 'paint_cutout_mask' : 'paint_stroke';
      const settings = current.mode === 'paint' ? { layerId: current.layerId, tool: current.tool, ...paintSettings, ...(flow !== undefined && flow < 1 && FLOW_TOOLS.includes(current.tool) ? { flow } : {}), ...(isRetouch(current.tool) ? current.samplingArgs : {}), ...((current.tool === 'clone' || current.tool === 'heal') && current.source ? { source: current.source } : {}) } : { ...(['mask', 'cutout'].includes(current.mode) ? { layerId: current.layerId } : {}), size: current.brush.size, hardness: current.brush.hardness, opacity: current.brush.opacity, mode };
      if (current.ticket) overlayTicket.current = current.ticket;
      void run(name, { points, ...settings }, `Applying ${current.tool.replaceAll('_', ' ')} stroke`, current.context).then(result => {
        if (result?.document && current.mode === 'paint' && !current.layerId) notify(`Painted on a new paint layer${current.context.targetLayerId ? '  — the selected layer can’t be painted directly' : ''}.`);
        if (current.ticket) {
          sessionCurrent(current.ticket);
          if (current.ticket.phase === 'drag') cancelCloneStroke(session.current, current.ticket);
          else {
            // App has gated and installed this exact own response; it may resolve
            // before React renders the new revision into propsRef.
            if (result?.document && ownsCloneStroke(session.current, current.ticket)) syncCloneSession(session.current, { ...liveContext(), revision: result.document.revision });
            finishCloneStroke(session.current, current.ticket, Boolean(result?.document));
          }
          renderSession(value => value + 1);
        }
      }).finally(() => { if (!current.ticket || overlayTicket.current === current.ticket) { overlayTicket.current = null; setStroke([]); } });
      drag.current = null;
    } else {
      if (current.mode === 'lasso' && current.points.length >= 3) void run('select_region', { shape: 'polygon', points: current.points.map(({ x, y }) => ({ x, y })), feather: current.feather, invert: current.invert }, 'Creating lasso selection', current.context);
      if (current.mode === 'ellipse' && ellipse && ellipse.width >= 1 && ellipse.height >= 1) void run('select_region', { shape: 'ellipse', x: Math.floor(ellipse.x), y: Math.floor(ellipse.y), width: Math.max(1, Math.min(document!.width - Math.floor(ellipse.x), Math.round(ellipse.width))), height: Math.max(1, Math.min(document!.height - Math.floor(ellipse.y), Math.round(ellipse.height))), feather: current.feather, invert: current.invert }, 'Creating elliptical selection', current.context);
      // A click without a drag deselects, like Photoshop's marquee and lasso tools.
      else if (current.mode === 'ellipse' && document?.selection) void run('clear_selection', {}, 'Deselecting', current.context);
      if (current.mode === 'lasso' && current.points.length < 3 && document?.selection) void run('clear_selection', {}, 'Deselecting', current.context);
      clear();
    }
    return true;
  };
  return {
    down, move, up,
    cancel: (event: PointerEvent<HTMLDivElement>) => { if (!drag.current || drag.current.pointer.pointerId !== event.pointerId) return false; clear(); return true; },
    leave: () => { if (!drag.current) setCursor(null); },
    cursor, source, sampleCenter: cloneSampleCenter(session.current, cursor), aligned: session.current.aligned, established: Boolean(session.current.offset), pendingSource: session.current.stroke?.phase === 'pending',
    setAligned: (value: boolean) => { clear(); setCloneAligned(session.current, value); overlayTicket.current = null; setStroke([]); renderSession(next => next + 1); },
    stroke, polygon, ellipse, clearSource: resetSource,
    dragging: Boolean(drag.current),
  };
}

export function CanvasProOverlay({ document, tool, brush, cursor, source, stroke, polygon, ellipse }: { document: Document; tool: CanvasTool; brush: BrushSettings; cursor: Point | null; source: Point | null; stroke: Point[]; polygon: Point[]; ellipse: Mask | null }) {
  const strokeColor = tool === 'brush' ? brush.color : tool === 'eraser' ? '#e8d9fb' : '#c4b2ec';
  const line = stroke.map((point) => `${point.x},${point.y}`).join(' ');
  const retouch = tool === 'clone' || tool === 'heal';
  // Screen-constant marker size (document px per screen px) and Photoshop's Option/Alt target cursor.
  const svg = useRef<SVGSVGElement>(null), [unit, setUnit] = useState(1), [altHeld, setAltHeld] = useState(false);
  useEffect(() => { const element = svg.current; if (!element) return; const update = () => { const width = element.getBoundingClientRect().width; if (width > 0) setUnit(document.width / width); }; update(); const observer = new ResizeObserver(update); observer.observe(element); return () => observer.disconnect(); }, [document.width]);
  useEffect(() => { if (!retouch) { setAltHeld(false); return; } const key = (event: KeyboardEvent) => setAltHeld(event.altKey); const blur = () => setAltHeld(false); window.addEventListener('keydown', key); window.addEventListener('keyup', key); window.addEventListener('blur', blur); return () => { window.removeEventListener('keydown', key); window.removeEventListener('keyup', key); window.removeEventListener('blur', blur); }; }, [retouch]);
  return <svg ref={svg} className="canvas-pro-overlay" viewBox={`0 0 ${document.width} ${document.height}`} aria-hidden="true">
    {stroke.length > 0 && <g opacity={tool === 'brush' ? brush.opacity : 0.4}><polyline points={line} stroke={strokeColor} strokeWidth={brush.size} strokeLinecap="round" strokeLinejoin="round" fill="none" opacity=".55" />{stroke.length === 1 && <circle cx={stroke[0].x} cy={stroke[0].y} r={brush.size / 2 * (stroke[0].pressure ?? 1)} fill={strokeColor} />}</g>}
    {polygon.length > 0 && <polyline className="selection-outline" points={polygon.map((point) => `${point.x},${point.y}`).join(' ')} fill="#b299df22" />}
    {ellipse && <ellipse className="selection-outline" cx={ellipse.x + ellipse.width / 2} cy={ellipse.y + ellipse.height / 2} rx={ellipse.width / 2} ry={ellipse.height / 2} fill="#b299df11" />}
    {source && (tool === 'clone' || tool === 'heal') && <g className="sample-crosshair" transform={`translate(${source.x},${source.y})`}><g transform={`scale(${unit})`}><circle r="9" /><path d="M-15 0H15M0-15V15" /></g></g>}
    {cursor && isBrushTool(tool) && <g><circle className="brush-cursor-shadow" cx={cursor.x} cy={cursor.y} r={brush.size / 2} /><circle className="brush-cursor-outline" cx={cursor.x} cy={cursor.y} r={brush.size / 2} />{brush.hardness < 1 && <circle className="brush-cursor-inner" cx={cursor.x} cy={cursor.y} r={brush.size / 2 * brush.hardness} />}{retouch && altHeld && <g className="sample-target-cursor" transform={`translate(${cursor.x},${cursor.y}) scale(${unit})`}><circle r="6" /><path d="M-11 0H11M0-11V11" /></g>}</g>}
  </svg>;
}

export function SelectionOverlay({ selection, document, crop, capabilities }: { selection: Mask; document: Document; crop: boolean; capabilities?: Backend }) {
  const clipId = useId();
  const { x, y, width, height } = selection;
  if (crop) return <div className="canvas-selection crop-selection" style={{ left: `${x / document.width * 100}%`, top: `${y / document.height * 100}%`, width: `${width / document.width * 100}%`, height: `${height / document.height * 100}%` }}><i /><i /><i /><i /><div className="crop-thirds" /></div>;
  if (selection.shape === 'alpha8') return <Alpha8SelectionOverlay selection={selection} document={document} capabilities={capabilities} />;
  if (selection.shape === 'bitmap') return <BitmapSelectionOverlay selection={selection} />;
  const clip = selection.clip;
  if (clip && (clip.width <= 0 || clip.height <= 0)) return null;
  const outer = clip || { x: 1, y: 1, width: Math.max(0, document.width - 2), height: Math.max(0, document.height - 2) };
  return <svg className="selection-overlay canvas-selection" viewBox={`0 0 ${document.width} ${document.height}`} aria-label={`${selection.invert ? 'Inverted ' : ''}${selection.shape || 'rectangle'} selection${selection.feather ? `, feather ${selection.feather} pixels` : ''}`}>
    {clip && <defs><clipPath id={clipId}><rect x={clip.x} y={clip.y} width={clip.width} height={clip.height} /></clipPath></defs>}
    {selection.invert && <rect className="selection-outline selection-outer-boundary" x={outer.x} y={outer.y} width={outer.width} height={outer.height} />}
    <g clipPath={clip ? `url(#${clipId})` : undefined}>{selection.shape === 'ellipse' ? <ellipse className="selection-outline" cx={x + width / 2} cy={y + height / 2} rx={width / 2} ry={height / 2} /> : selection.shape === 'polygon' && selection.points ? <polygon className="selection-outline" points={selection.points.map((point) => `${point.x},${point.y}`).join(' ')} /> : <rect className="selection-outline" x={x} y={y} width={width} height={height} />}</g>
  </svg>;
}

function BitmapSelectionOverlay({ selection }: { selection: Exclude<Mask, { shape: 'alpha8' }> }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current; if (!canvas) return;
    const scale = Math.min(1, 1600 / selection.width);
    canvas.width = Math.ceil(selection.width * scale); canvas.height = Math.ceil(selection.height * scale);
    const context = canvas.getContext('2d'); if (!context) return;
    const image = context.createImageData(canvas.width, canvas.height), coverage = new Uint8Array(canvas.width * canvas.height);
    if (selection.invert) coverage.fill(255);
    const runs = selection.runs || [];
    for (let index = 0; index < runs.length; index += 3) {
      const start = runs[index], count = runs[index + 1], alpha = runs[index + 2];
      const firstRow = Math.floor(start / selection.width), lastRow = Math.floor((start + count - 1) / selection.width);
      for (let row = firstRow; row <= lastRow; row++) {
        const from = Math.max(start, row * selection.width) - row * selection.width, to = Math.min(start + count, (row + 1) * selection.width) - row * selection.width;
        const py = Math.min(canvas.height - 1, Math.floor(row * scale));
        for (let x = Math.floor(from * scale); x < Math.ceil(to * scale); x++) {
          coverage[py * canvas.width + x] = selection.invert ? 255 - alpha : alpha;
        }
      }
    }
    paintSelectionCoverage(image.data, canvas.width, canvas.height, index => coverage[index]);
    context.putImageData(image, 0, 0);
  }, [selection]);
  return <canvas ref={ref} className="bitmap-selection-overlay canvas-selection" aria-label="Painted pixel selection overlay" />;
}

export function BrushOptions({ canBakeFilters = false, brush, setBrush, layer, busy, run, hasSource, clearSource, tool, setTool, canRefineCutout }: { canBakeFilters?: boolean; brush: BrushSettings; setBrush: (value: BrushSettings) => void; layer?: Layer; busy: boolean; run: RunCommand; hasSource: boolean; clearSource: () => void; tool: CanvasTool; setTool: (tool: CanvasTool) => void; canRefineCutout: boolean }) {
  return <div className="pro-tool-options brush-options"><label>Size<input aria-label="Brush size" type="number" min="1" max="512" value={brush.size} onChange={(event) => setBrush({ ...brush, size: Math.max(1, Math.min(512, Number(event.target.value))) })} /><span>px</span></label><label>Hardness<input aria-label="Brush hardness" type="range" min="0" max="100" value={Math.round(brush.hardness * 100)} onChange={(event) => setBrush({ ...brush, hardness: Number(event.target.value) / 100 })} /><span>{Math.round(brush.hardness * 100)}%</span></label><label>Opacity<input aria-label="Brush opacity" type="range" min="1" max="100" value={Math.round(brush.opacity * 100)} onChange={(event) => setBrush({ ...brush, opacity: Number(event.target.value) / 100 })} /><span>{Math.round(brush.opacity * 100)}%</span></label>{FLOW_TOOLS.includes(tool) && <label>Flow<input aria-label="Brush flow" type="range" min="1" max="100" value={Math.round((brush.flow ?? 1) * 100)} onChange={(event) => setBrush({ ...brush, flow: Number(event.target.value) / 100 })} /><span>{Math.round((brush.flow ?? 1) * 100)}%</span></label>}{(tool === 'selection_brush' || tool === 'mask_brush' || tool === 'cutout_brush') && <label>Mode<select aria-label="Mask brush mode" value={brush.mode} onChange={(event) => setBrush({ ...brush, mode: event.target.value as BrushSettings['mode'] })}><option value="add">Add</option><option value="subtract">Subtract</option><option value="replace">Replace</option></select></label>}{(tool === 'mask_brush' || tool === 'cutout_brush') && <label>Target<select aria-label="Mask brush target" value={tool} onChange={(event) => setTool(event.target.value as CanvasTool)}><option value="mask_brush">Layer mask</option><option value="cutout_brush" disabled={!canRefineCutout}>Subject cutout</option></select></label>}<input className="brush-color" type="color" aria-label="Brush color" value={brush.color} onChange={(event) => setBrush({ ...brush, color: event.target.value })} />{['blur', 'sharpen', 'smudge', 'sponge', 'red_eye', 'color_replace'].includes(tool) && <label>Strength<input aria-label="Brush strength" type="range" min={tool === 'sponge' ? -100 : 0} max="100" value={brush.strength} onChange={(event) => setBrush({ ...brush, strength: Number(event.target.value) })} /><span>{brush.strength}%</span></label>}{tool === 'color_replace' && <label>Tolerance<input aria-label="Color replacement tolerance" type="number" min="0" max="255" value={brush.tolerance} onChange={(event) => setBrush({ ...brush, tolerance: Math.max(0, Math.min(255, Number(event.target.value))) })} /></label>}<span className="brush-pressure">Pen pressure enabled</span>{isPaintTool(tool) && Boolean(layer?.filters?.length) && <span className="target-warning">{canBakeFilters ? 'Review Bake or Clear in Layers, or use a paint layer.' : 'Remove layer filters before painting, or add a paint layer.'}</span>}{isPaintTool(tool) && layer?.protected && <span className="protected-brush-notice">Pixels protected<button className="button mini subtle" disabled={busy} onClick={() => void run('set_layer_protection', { layerId: layer.id, protected: false }, 'Unprotecting pixels')}>Unprotect</button></span>}<span className="flex-spacer" />{isPaintTool(tool) && <button className="button mini secondary" disabled={busy} onClick={() => void run('add_paint_layer', { name: 'Paint layer' }, 'Adding paint layer')}><Plus size={12} />Paint layer</button>}{isPaintTool(tool) && layer && layer.type !== 'raster' && layer.type !== 'adjustment' && layer.type !== 'group' && <button className="button mini subtle" disabled={busy} onClick={() => void run('rasterize_layer', { layerId: layer.id }, 'Rasterizing layer')}><RefreshCw size={12} />Rasterize</button>}{isPaintTool(tool) && layer?.type !== 'raster' && <span className="target-warning"><Layers size={12} />Choose a raster target</span>}{tool === 'mask_brush' && isPositionedMask(layer?.mask) && <p className="positioned-brush-notice">{POSITION_MATERIALIZATION_NOTICE}</p>}</div>;
}

export function SelectionOptions({ onOpenLibrary, selection, feather, setFeather, invert, setInvert, busy, run }: { selection: Mask | null; feather: number; setFeather: (value: number) => void; invert: boolean; setInvert: (value: boolean) => void; busy: boolean; run: RunCommand; onOpenLibrary?: () => void }) {
  return <div className="pro-tool-options selection-options"><label>Feather<input aria-label="Selection feather" type="number" min="0" max="100" value={feather} onChange={(event) => setFeather(Math.max(0, Math.min(100, Number(event.target.value))))} /><span>px</span></label><label className="checkbox-label"><input type="checkbox" checked={invert} onChange={(event) => setInvert(event.target.checked)} />Invert selection</label><button className="button mini secondary" disabled={!selection || busy} onClick={() => void run('modify_selection', { feather, invert }, 'Refining selection')}>Apply to selection</button>{onOpenLibrary && <button className="button mini subtle" onClick={onOpenLibrary}><Layers size={12} />Saved selections</button>}<span className="selection-guidance">{selection ? `${maskShapeLabel(selection)} · ${selection.feather || 0}px feather${selection.invert ? ' · inverted' : ''}` : 'Draw a selection. Feather softens its inner edge.'}</span></div>;
}
