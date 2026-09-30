import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Check, Minus, Plus, Square, Trash2 } from 'lucide-react';
import type { Document, GradientSpec, Layer, PathNode, PathSpec, Point, ShapeSpec } from './api';
import type { CanvasTool, RunCommand } from './CanvasTools';
import { captureGesture, releaseGesturePointer, type GestureContext, type PointerCapture } from './gesture';

export const DEFAULT_SHAPE: Omit<ShapeSpec, 'x' | 'y' | 'width' | 'height'> = { shape: 'rectangle', fill: '#b49ad8', stroke: '#eadcf5', strokeWidth: 2, radius: 0, sides: 5, innerRadius: 0.5 };
export const DEFAULT_PATH: Omit<PathSpec, 'nodes'> = { closed: false, fill: null, stroke: '#d7b9ee', strokeWidth: 4 };
export const DEFAULT_GRADIENT: Omit<GradientSpec, 'start' | 'end'> = { kind: 'linear', stops: [{ offset: 0, color: '#322542', opacity: 1 }, { offset: 1, color: '#d4aecf', opacity: 1 }] };

export function pathData(nodes: PathNode[], closed = false) {
  if (!nodes.length) return '';
  let result = `M${nodes[0].x} ${nodes[0].y}`;
  for (let index = 1; index < nodes.length + (closed ? 1 : 0); index++) {
    const previous = nodes[(index - 1) % nodes.length], next = nodes[index % nodes.length];
    result += previous.out || next.in ? ` C${previous.out?.x ?? previous.x} ${previous.out?.y ?? previous.y} ${next.in?.x ?? next.x} ${next.in?.y ?? next.y} ${next.x} ${next.y}` : ` L${next.x} ${next.y}`;
  }
  return result + (closed ? ' Z' : '');
}

function vectorShapePath(shape: ShapeSpec) {
  const { x, y, width, height } = shape;
  if (shape.shape === 'line') return `M${x} ${y}L${x + width} ${y + height}`;
  if (shape.shape === 'triangle') return `M${x + width / 2} ${y}L${x + width} ${y + height}L${x} ${y + height}Z`;
  const count = shape.sides || 5, total = shape.shape === 'star' ? count * 2 : count;
  return Array.from({ length: total }, (_, i) => {
    const angle = i / total * Math.PI * 2 - Math.PI / 2, radius = shape.shape === 'star' && i % 2 ? shape.innerRadius || 0.5 : 1;
    return `${i === 0 ? 'M' : 'L'}${x + width / 2 + Math.cos(angle) * width / 2 * radius} ${y + height / 2 + Math.sin(angle) * height / 2 * radius}`;
  }).join(' ') + ' Z';
}

type VectorOptions = { document: Document | null; layer?: Layer; tool: CanvasTool; busy: boolean; can: (name: string) => boolean; run: RunCommand; shape: typeof DEFAULT_SHAPE; path: typeof DEFAULT_PATH; gradient: typeof DEFAULT_GRADIENT; notify: (message: string, error?: boolean) => void };

export function useVectorCanvas(props: VectorOptions) {
  const { document, layer, tool, busy, can, run, shape, path, gradient, notify } = props;
  const [nodes, setNodes] = useState<PathNode[]>([]);
  const [shapeDraft, setShapeDraft] = useState<ShapeSpec | null>(null);
  const [gradientDraft, setGradientDraft] = useState<{ start: Point; end: Point } | null>(null);
  const [editNodes, setEditNodes] = useState<PathNode[] | null>(null);
  const [selectedAnchor, setSelectedAnchor] = useState(0);
  const nodeRef = useRef(nodes); nodeRef.current = nodes;
  const drag = useRef<{ start: Point; end: Point; mode: 'shape' | 'gradient' | 'pen' | 'path_edit'; index?: number; handle?: 'in' | 'out'; gradientHandle?: 'start' | 'end'; anchor?: Point; originalNodes?: PathNode[]; context: GestureContext; pointer: PointerCapture; shape: typeof DEFAULT_SHAPE; gradient: typeof DEFAULT_GRADIENT } | null>(null);
  const pathContext = useRef<GestureContext | null>(null);
  const pathStyle = useRef(path);
  const point = (event: PointerEvent<HTMLDivElement>) => { const bounds = event.currentTarget.getBoundingClientRect(); return { x: Math.round(Math.max(0, Math.min(document!.width, (event.clientX - bounds.left) / bounds.width * document!.width))), y: Math.round(Math.max(0, Math.min(document!.height, (event.clientY - bounds.top) / bounds.height * document!.height))) }; };
  const clear = () => { const previous = drag.current; drag.current = null; releaseGesturePointer(previous?.pointer); setShapeDraft(null); setGradientDraft(null); setEditNodes(null); };
  useEffect(() => { clear(); setNodes([]); pathContext.current = null; setSelectedAnchor(0); }, [document?.backend, document?.id, document?.width, document?.height, tool, layer?.id]);
  const commitPath = (close = false) => { if (nodes.length < 2 || !pathContext.current || busy) return; const context = pathContext.current; const committed = structuredClone(nodes); clear(); setNodes([]); pathContext.current = null; void run('add_path', { ...pathStyle.current, ...(close ? { closed: true } : {}), nodes: committed }, 'Adding vector path', context); };
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (!['shape', 'gradient', 'pen', 'path_edit'].includes(tool)) return false;
    if (!document || busy || event.button !== 0 || drag.current) return true;
    const position = point(event), captured = { context: captureGesture(document, layer?.id), pointer: { element: event.currentTarget, pointerId: event.pointerId }, shape: structuredClone(shape), gradient: structuredClone(gradient) };
    if (tool === 'shape' && can('add_shape')) { drag.current = { mode: 'shape', start: position, end: position, ...captured }; setShapeDraft({ ...shape, ...position, width: 0, height: 0 }); }
    else if (tool === 'gradient' && can('add_gradient')) {
      // With a gradient layer selected, dragging one of its on-canvas end points edits it in place (Photoshop live gradient handles).
      const existing = layer?.gradient && !layer.transforms?.length && !layer.protected && can('update_gradient') ? layer.gradient : null, scale = event.currentTarget.getBoundingClientRect().width / document.width;
      const handle = existing ? (['end', 'start'] as const).find((key) => Math.hypot(existing[key].x - position.x, existing[key].y - position.y) * scale < 12) : undefined;
      if (existing && handle) { drag.current = { mode: 'gradient', start: existing.start, end: existing.end, gradientHandle: handle, anchor: handle === 'start' ? existing.end : existing.start, ...captured }; setGradientDraft({ start: existing.start, end: existing.end }); }
      else { drag.current = { mode: 'gradient', start: position, end: position, ...captured }; setGradientDraft({ start: position, end: position }); }
    }
    else if (tool === 'pen' && can('add_path')) {
      // Like Photoshop, clicking the first anchor again closes and finishes the path.
      if (nodes.length >= 2 && Math.hypot(nodes[0].x - position.x, nodes[0].y - position.y) * event.currentTarget.getBoundingClientRect().width / document.width < 8) { commitPath(true); return true; }
      if (nodes.length >= 256) { notify('Paths support up to 256 anchors. Finish this path first.', true); return true; }
      if (!nodes.length) { pathContext.current = captured.context; pathStyle.current = structuredClone(path); }
      drag.current = { mode: 'pen', start: position, end: position, index: nodes.length, ...captured }; setNodes([...nodes, position]);
    } else if (tool === 'path_edit' && can('update_path')) {
      if (!layer?.vector || !('nodes' in layer.vector)) { notify('Select a path layer to edit its anchors.', true); return true; }
      if (layer.protected) { notify('Unprotect this path before editing its anchors.', true); return true; }
      if (layer.transforms?.length) { notify('This path has canvas or layer transforms. Edit its source coordinates in layer properties.', true); return true; }
      const scale = event.currentTarget.getBoundingClientRect().width / document.width;
      const near = (target: Point) => Math.hypot(target.x - position.x, target.y - position.y) * scale < 15;
      let index = layer.vector.nodes.findIndex((node) => near(node)), handle: 'in' | 'out' | undefined;
      if (index === -1) for (const [i, node] of layer.vector.nodes.entries()) { const found = (['out', 'in'] as const).find((key) => node[key] && near(node[key]!)); if (found) { index = i; handle = found; break; } }
      if (index === -1) { notify('Drag an anchor point or Bézier handle, or edit its coordinates in layer properties.'); return true; }
      setSelectedAnchor(index); setEditNodes(layer.vector.nodes); drag.current = { mode: 'path_edit', start: position, end: position, index, handle, originalNodes: structuredClone(layer.vector.nodes), ...captured };
    } else return true;
    event.currentTarget.setPointerCapture(event.pointerId); return true;
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || !document) return false;
    if (drag.current.pointer.pointerId !== event.pointerId) return true;
    const position = point(event), current = drag.current; current.end = position;
    if (current.mode === 'shape') {
      // Shift constrains to equal proportions and Alt / Option draws from the center, as in Photoshop.
      let dx = position.x - current.start.x, dy = position.y - current.start.y;
      if (event.shiftKey && current.shape.shape !== 'line') { const size = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * size; dy = Math.sign(dy || 1) * size; }
      const draft = event.altKey ? { x: current.start.x - Math.abs(dx), y: current.start.y - Math.abs(dy), width: Math.abs(dx) * 2, height: Math.abs(dy) * 2 } : { x: Math.min(current.start.x, current.start.x + dx), y: Math.min(current.start.y, current.start.y + dy), width: Math.abs(dx), height: Math.abs(dy) };
      setShapeDraft({ ...current.shape, ...draft });
    }
    else if (current.mode === 'gradient') {
      // Shift constrains the gradient direction to 45° increments, like Photoshop.
      const anchor = current.anchor ?? current.start; let moving = position;
      if (event.shiftKey) { const dx = position.x - anchor.x, dy = position.y - anchor.y, angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), length = dx * Math.cos(angle) + dy * Math.sin(angle); moving = { x: Math.round(anchor.x + Math.cos(angle) * length), y: Math.round(anchor.y + Math.sin(angle) * length) }; }
      if (current.gradientHandle === 'start') { current.start = moving; current.end = anchor; } else current.end = moving;
      setGradientDraft({ start: current.start, end: current.end });
    }
    else if (current.mode === 'pen') {
      const dx = position.x - current.start.x, dy = position.y - current.start.y;
      if (Math.hypot(dx, dy) > 2) setNodes((existing) => existing.map((node, index) => index === current.index ? { ...node, in: { x: node.x - dx, y: node.y - dy }, out: { x: node.x + dx, y: node.y + dy } } : node));
    } else if (current.mode === 'path_edit') {
      const dx = position.x - current.start.x, dy = position.y - current.start.y, handle = current.handle;
      if (handle) {
        // Dragging a handle keeps a smooth point smooth: the opposite handle stays collinear at its own length.
        const opposite = handle === 'in' ? 'out' : 'in';
        setEditNodes(current.originalNodes!.map((node, index) => {
          if (index !== current.index) return node;
          const moved = { x: node[handle]!.x + dx, y: node[handle]!.y + dy }, other = node[opposite];
          if (!other || event.altKey) return { ...node, [handle]: moved };
          const length = Math.hypot(other.x - node.x, other.y - node.y), angle = Math.atan2(node.y - moved.y, node.x - moved.x);
          return { ...node, [handle]: moved, [opposite]: { x: Math.round((node.x + Math.cos(angle) * length) * 100) / 100, y: Math.round((node.y + Math.sin(angle) * length) * 100) / 100 } };
        }));
      } else setEditNodes(current.originalNodes!.map((node, index) => index === current.index ? { ...node, x: node.x + dx, y: node.y + dy, ...(node.in ? { in: { x: node.in.x + dx, y: node.in.y + dy } } : {}), ...(node.out ? { out: { x: node.out.x + dx, y: node.out.y + dy } } : {}) } : node));
    }
    return true;
  };
  const up = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return ['shape', 'gradient', 'pen', 'path_edit'].includes(tool);
    if (current.pointer.pointerId !== event.pointerId) return true;
    if (current.context.documentId !== document?.id || current.context.backend !== document?.backend || current.context.targetLayerId !== layer?.id || current.mode !== tool) { clear(); setNodes([]); pathContext.current = null; return true; }
    // Completing a pen anchor must keep the pending path. Mark this pointer
    // gesture complete before releasing capture so its lost event is a no-op.
    drag.current = null;
    releaseGesturePointer(current.pointer);
    if (current.mode === 'shape' && shapeDraft && shapeDraft.width > 0 && shapeDraft.height > 0) void run('add_shape', shapeDraft, 'Adding vector shape', current.context);
    else if (current.mode === 'gradient' && current.gradientHandle) { const before = layer?.gradient; if (before && Math.hypot(current.end.x - current.start.x, current.end.y - current.start.y) >= 1 && (before.start.x !== current.start.x || before.start.y !== current.start.y || before.end.x !== current.end.x || before.end.y !== current.end.y)) void run('update_gradient', { layerId: current.context.targetLayerId, start: current.start, end: current.end }, 'Moving gradient handle', current.context); }
    else if (current.mode === 'gradient' && gradientDraft && Math.hypot(current.end.x - current.start.x, current.end.y - current.start.y) >= 1) void run('add_gradient', { ...current.gradient, start: current.start, end: current.end }, 'Adding gradient', current.context);
    else if (current.mode === 'path_edit' && layer && editNodes) void run('update_path', { layerId: current.context.targetLayerId, nodes: editNodes }, 'Moving path anchor', current.context);
    clear(); return true;
  };
  useEffect(() => { const key = (event: KeyboardEvent) => { if ((event.target as HTMLElement)?.closest('input,textarea,select')) return; if (event.key === 'Escape') { clear(); setNodes([]); pathContext.current = null; } if (event.key === 'Enter' && tool === 'pen') commitPath(); }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [tool, nodes, path, run]);
  return { down, move, up, cancel: (event?: PointerEvent<HTMLDivElement>) => { if (event && (!drag.current || drag.current.pointer.pointerId !== event.pointerId)) return false; clear(); setNodes([]); pathContext.current = null; return true; }, nodes, setNodes, shapeDraft, gradientDraft, editNodes, selectedAnchor, commitPath, dragging: Boolean(drag.current) || nodes.length > 0 };
}

export function VectorOverlay({ document, tool, layer, nodes, shapeDraft, gradientDraft, editNodes, path }: { document: Document; tool: CanvasTool; layer?: Layer; nodes: PathNode[]; shapeDraft: ShapeSpec | null; gradientDraft: { start: Point; end: Point } | null; editNodes: PathNode[] | null; path: typeof DEFAULT_PATH }) {
  const handleRadius = Math.max(5, Math.max(document.width, document.height) / 120);
  const gradientHandles = gradientDraft || (tool === 'gradient' && layer?.gradient && !layer.transforms?.length ? layer.gradient : null);
  const visibleNodes = tool === 'pen' ? nodes : tool === 'path_edit' && !layer?.transforms?.length && layer?.vector && 'nodes' in layer.vector ? editNodes || layer.vector.nodes : [];
  return <svg className="canvas-pro-overlay vector-overlay" viewBox={`0 0 ${document.width} ${document.height}`} aria-hidden="true">{shapeDraft && <g fill={shapeDraft.fill || 'none'} stroke={shapeDraft.stroke || 'none'} strokeWidth={shapeDraft.strokeWidth} opacity=".7">{shapeDraft.shape === 'ellipse' ? <ellipse cx={shapeDraft.x + shapeDraft.width / 2} cy={shapeDraft.y + shapeDraft.height / 2} rx={shapeDraft.width / 2} ry={shapeDraft.height / 2} /> : shapeDraft.shape === 'rectangle' ? <rect x={shapeDraft.x} y={shapeDraft.y} width={shapeDraft.width} height={shapeDraft.height} rx={shapeDraft.radius} /> : <path d={vectorShapePath(shapeDraft)} />}</g>}{gradientHandles && <g className="gradient-handle"><line x1={gradientHandles.start.x} y1={gradientHandles.start.y} x2={gradientHandles.end.x} y2={gradientHandles.end.y} /><circle cx={gradientHandles.start.x} cy={gradientHandles.start.y} r={handleRadius} /><circle cx={gradientHandles.end.x} cy={gradientHandles.end.y} r={handleRadius} /></g>}{visibleNodes.length > 0 && <><path d={pathData(visibleNodes, tool === 'pen' ? path.closed : Boolean(layer?.vector && 'closed' in layer.vector && layer.vector.closed))} className="path-preview" />{visibleNodes.map((node, index) => <g className="path-anchor" key={index}>{node.in && <><line x1={node.x} y1={node.y} x2={node.in.x} y2={node.in.y} /><circle cx={node.in.x} cy={node.in.y} r="3" /></>}{node.out && <><line x1={node.x} y1={node.y} x2={node.out.x} y2={node.out.y} /><circle cx={node.out.x} cy={node.out.y} r="3" /></>}<rect x={node.x - 4} y={node.y - 4} width="8" height="8" /></g>)}</>}</svg>;
}

export function VectorToolOptions({ tool, shape, setShape, path, setPath, gradient, setGradient, nodes, onFinish, onClear, busy }: { tool: CanvasTool; shape: typeof DEFAULT_SHAPE; setShape: (shape: typeof DEFAULT_SHAPE) => void; path: typeof DEFAULT_PATH; setPath: (path: typeof DEFAULT_PATH) => void; gradient: typeof DEFAULT_GRADIENT; setGradient: (gradient: typeof DEFAULT_GRADIENT) => void; nodes: PathNode[]; onFinish: () => void; onClear: () => void; busy: boolean }) {
  return <div className="pro-tool-options vector-options">{tool === 'shape' && <><label>Shape<select aria-label="Shape type" value={shape.shape} onChange={(event) => setShape({ ...shape, shape: event.target.value as ShapeSpec['shape'] })}>{['rectangle', 'ellipse', 'triangle', 'polygon', 'star', 'line'].map((value) => <option key={value}>{value}</option>)}</select></label><PaintField label="Shape fill" value={shape.fill} onChange={(fill) => setShape({ ...shape, fill })} /><PaintField label="Shape stroke" value={shape.stroke} onChange={(stroke) => setShape({ ...shape, stroke })} /><label>Stroke<input aria-label="Shape stroke width" type="number" min="0" max="100" value={shape.strokeWidth} onChange={(event) => setShape({ ...shape, strokeWidth: Math.max(0, Math.min(100, Number(event.target.value))) })} /><span>px</span></label><span className="selection-guidance">Drag on the canvas to draw an editable shape.</span></>}{tool === 'gradient' && <><label>Gradient<select aria-label="Gradient type" value={gradient.kind} onChange={(event) => setGradient({ ...gradient, kind: event.target.value as GradientSpec['kind'] })}>{['linear', 'radial', 'angle', 'reflected', 'diamond'].map((value) => <option key={value}>{value}</option>)}</select></label><PaintField label="Gradient start" value={gradient.stops[0].color} onChange={(color) => color && setGradient({ ...gradient, stops: [{ ...gradient.stops[0], color }, ...gradient.stops.slice(1)] })} /><PaintField label="Gradient end" value={gradient.stops.at(-1)!.color} onChange={(color) => color && setGradient({ ...gradient, stops: [...gradient.stops.slice(0, -1), { ...gradient.stops.at(-1)!, color }] })} /><span className="selection-guidance">Drag to set gradient direction and extent (Shift snaps to 45°). Drag a selected gradient’s end points to edit it.</span></>}{tool === 'pen' && <><PaintField label="Path stroke" value={path.stroke} onChange={(stroke) => setPath({ ...path, stroke })} /><label>Width<input aria-label="Path stroke width" type="number" min="0" max="100" value={path.strokeWidth} onChange={(event) => setPath({ ...path, strokeWidth: Math.max(0, Math.min(100, Number(event.target.value))) })} /></label><label><input type="checkbox" checked={path.closed} onChange={(event) => setPath({ ...path, closed: event.target.checked })} />Closed path</label><PaintField label="Path fill" value={path.fill} onChange={(fill) => setPath({ ...path, fill })} /><span>{nodes.length} anchors</span><button className="button mini primary" disabled={nodes.length < 2 || busy} onClick={() => onFinish()}>Create path ↵</button><button className="button mini subtle" disabled={!nodes.length || busy} onClick={onClear}>Clear</button></>}{tool === 'path_edit' && <span>Drag an anchor or Bézier handle to reshape the path (Option / Alt breaks a smooth handle). Add or remove points in layer properties.</span>}</div>;
}

function PaintField({ label, value, onChange }: { label: string; value: string | null; onChange: (value: string | null) => void }) {
  return <label className="vector-paint-field"><input type="checkbox" aria-label={`Enable ${label.toLowerCase()}`} checked={value !== null} onChange={(event) => onChange(event.target.checked ? '#c5a5e2' : null)} />{label}<input aria-label={label} type="color" value={value || '#000000'} disabled={value === null} onChange={(event) => onChange(event.target.value)} /></label>;
}

export function ShapeProperties({ layer, busy, run }: { layer: Layer; busy: boolean; run: RunCommand }) {
  const spec = layer.vector as ShapeSpec;
  const [value, setValue] = useState(spec);
  useEffect(() => setValue(spec), [JSON.stringify(spec)]);
  return <form className="panel-section shape-properties" onSubmit={(event) => { event.preventDefault(); void run('update_shape', { layerId: layer.id, ...value }, 'Updating shape'); }}><div className="section-heading"><span>Edit vector shape</span><Square size={14} /></div><label className="field-label">Shape<select value={value.shape} onChange={(event) => setValue({ ...value, shape: event.target.value as ShapeSpec['shape'] })}>{['rectangle', 'ellipse', 'triangle', 'polygon', 'star', 'line'].map((shape) => <option key={shape}>{shape}</option>)}</select></label><div className="pro-form-grid">{(['x', 'y', 'width', 'height'] as const).map((key) => <label className="field-label" key={key}>{key}, px<input aria-label={`Shape ${key}`} type="number" required min={key === 'width' || key === 'height' ? 1 : undefined} value={value[key]} onChange={(event) => setValue({ ...value, [key]: Number(event.target.value) })} /></label>)}</div><div className="vector-color-row"><PaintField label="Shape fill" value={value.fill} onChange={(fill) => setValue({ ...value, fill })} /><PaintField label="Shape stroke" value={value.stroke} onChange={(stroke) => setValue({ ...value, stroke })} /></div><div className="pro-form-grid"><label className="field-label">Stroke, px<input type="number" min="0" max="100" value={value.strokeWidth} onChange={(event) => setValue({ ...value, strokeWidth: Number(event.target.value) })} /></label>{value.shape === 'rectangle' && <label className="field-label">Corner radius<input aria-label="Shape corner radius" type="number" min="0" max="4096" value={value.radius || 0} onChange={(event) => setValue({ ...value, radius: Number(event.target.value) })} /></label>}{(value.shape === 'polygon' || value.shape === 'star') && <label className="field-label">Sides / points<input aria-label="Shape sides" type="number" min="3" max="32" value={value.sides || 5} onChange={(event) => setValue({ ...value, sides: Number(event.target.value) })} /></label>}</div>{value.shape === 'star' && <label className="field-label">Inner radius<input aria-label="Star inner radius" type="range" min="0.05" max="0.95" step="0.01" value={value.innerRadius || 0.5} onChange={(event) => setValue({ ...value, innerRadius: Number(event.target.value) })} /></label>}<button className="button secondary wide" disabled={busy} type="submit"><Check size={13} />Update shape</button></form>;
}

export function GradientProperties({ layer, busy, run }: { layer: Layer; busy: boolean; run: RunCommand }) {
  const [value, setValue] = useState(layer.gradient!);
  useEffect(() => setValue(layer.gradient!), [JSON.stringify(layer.gradient)]);
  return <form className="panel-section gradient-properties" onSubmit={(event) => { event.preventDefault(); void run('update_gradient', { layerId: layer.id, ...value }, 'Updating gradient'); }}><div className="section-heading"><span>Edit gradient</span></div><div className="gradient-ramp" style={{ background: `linear-gradient(to right, ${value.stops.map((stop) => `${stop.color} ${stop.offset * 100}%`).join(', ')})` }} /><label className="field-label">Type<select aria-label="Edit gradient type" value={value.kind} onChange={(event) => setValue({ ...value, kind: event.target.value as GradientSpec['kind'] })}>{['linear', 'radial', 'angle', 'reflected', 'diamond'].map((kind) => <option key={kind}>{kind}</option>)}</select></label><div className="gradient-stops">{value.stops.map((stop, index) => <div key={index}><input aria-label={`Gradient stop ${index + 1} color`} type="color" value={stop.color} onChange={(event) => setValue({ ...value, stops: value.stops.map((item, i) => i === index ? { ...item, color: event.target.value } : item) })} /><label>Pos<input aria-label={`Gradient stop ${index + 1} position`} disabled={index === 0 || index === value.stops.length - 1} type="number" min="0" max="100" value={Math.round(stop.offset * 100)} onChange={(event) => setValue({ ...value, stops: value.stops.map((item, i) => i === index ? { ...item, offset: Number(event.target.value) / 100 } : item) })} /></label><label>α<input aria-label={`Gradient stop ${index + 1} opacity`} type="number" min="0" max="100" value={Math.round((stop.opacity ?? 1) * 100)} onChange={(event) => setValue({ ...value, stops: value.stops.map((item, i) => i === index ? { ...item, opacity: Number(event.target.value) / 100 } : item) })} /></label><button type="button" className="icon-button" aria-label={`Remove gradient stop ${index + 1}`} disabled={value.stops.length <= 2 || index === 0 || index === value.stops.length - 1} onClick={() => setValue({ ...value, stops: value.stops.filter((_, i) => i !== index) })}><Trash2 size={12} /></button></div>)}</div><button type="button" className="button subtle wide" disabled={value.stops.length >= 16} onClick={() => { const sorted = [...value.stops].sort((a, b) => a.offset - b.offset); let largest = 0; for (let i = 1; i < sorted.length - 1; i++) if (sorted[i + 1].offset - sorted[i].offset > sorted[largest + 1].offset - sorted[largest].offset) largest = i; setValue({ ...value, stops: [...value.stops, { offset: (sorted[largest].offset + sorted[largest + 1].offset) / 2, color: '#b99ed4', opacity: 1 }].sort((a, b) => a.offset - b.offset) }); }}><Plus size={12} />Add color stop</button><div className="pro-form-grid gradient-position-fields">{(['start', 'end'] as const).map((key) => (['x', 'y'] as const).map((axis) => <label className="field-label" key={`${key}-${axis}`}>{key} {axis}<input aria-label={`Gradient ${key} ${axis}`} type="number" value={value[key][axis]} onChange={(event) => setValue({ ...value, [key]: { ...value[key], [axis]: Number(event.target.value) } })} /></label>))}</div><button type="submit" className="button secondary wide" disabled={busy || value.stops.some((stop, index) => index > 0 && stop.offset <= value.stops[index - 1].offset)}><Check size={13} />Update gradient</button></form>;
}

export function PathProperties({ layer, busy, run, onEditAnchors }: { layer: Layer; busy: boolean; run: RunCommand; onEditAnchors: () => void }) {
  const [value, setValue] = useState(layer.vector as PathSpec);
  const [index, setIndex] = useState(0);
  useEffect(() => { setValue(layer.vector as PathSpec); setIndex((current) => Math.min(current, (layer.vector as PathSpec).nodes.length - 1)); }, [JSON.stringify(layer.vector)]);
  const node = value.nodes[index];
  const updateNode = (next: PathNode) => setValue({ ...value, nodes: value.nodes.map((point, i) => i === index ? next : point) });
  return <form className="panel-section path-properties" onSubmit={(event) => { event.preventDefault(); void run('update_path', { layerId: layer.id, ...value }, 'Updating path'); }}><div className="section-heading"><span>Edit vector path</span><span className="count-badge">{value.nodes.length}</span></div><button type="button" className="button subtle wide" disabled={Boolean(layer.transforms?.length)} onClick={onEditAnchors}>Edit anchors on canvas</button>{Boolean(layer.transforms?.length) && <p className="property-hint">This path is transformed. The numeric fields edit its original source coordinates.</p>}<label className="field-label anchor-select">Anchor point<select aria-label="Selected path anchor" value={index} onChange={(event) => setIndex(Number(event.target.value))}>{value.nodes.map((_, i) => <option key={i} value={i}>Point {i + 1}</option>)}</select></label>{node && <><div className="pro-form-grid">{(['x', 'y'] as const).map((axis) => <label className="field-label" key={axis}>Anchor {axis}<input aria-label={`Path anchor ${axis}`} type="number" value={node[axis]} onChange={(event) => updateNode({ ...node, [axis]: Number(event.target.value) })} /></label>)}</div><div className="anchor-actions"><button type="button" className="button mini subtle" disabled={value.nodes.length >= 256} onClick={() => { const next = value.nodes[(index + 1) % value.nodes.length]; const nodes = [...value.nodes]; nodes.splice(index + 1, 0, { x: (node.x + next.x) / 2, y: (node.y + next.y) / 2 }); setValue({ ...value, nodes }); setIndex(index + 1); }}><Plus size={11} />Insert</button><button type="button" className="button mini subtle" disabled={value.nodes.length <= 2} onClick={() => { setValue({ ...value, nodes: value.nodes.filter((_, i) => i !== index) }); setIndex(Math.max(0, index - 1)); }}><Minus size={11} />Delete</button><button type="button" className="button mini subtle" onClick={() => { if (node.in || node.out) updateNode({ x: node.x, y: node.y }); else updateNode({ ...node, in: { x: node.x - 40, y: node.y }, out: { x: node.x + 40, y: node.y } }); }}>{node.in || node.out ? 'Corner' : 'Smooth'}</button></div>{(['in', 'out'] as const).map((handle) => node[handle] && <div className="pro-form-grid" key={handle}>{(['x', 'y'] as const).map((axis) => <label className="field-label" key={axis}>{handle} handle {axis}<input aria-label={`Path ${handle} handle ${axis}`} type="number" value={node[handle]![axis]} onChange={(event) => updateNode({ ...node, [handle]: { ...node[handle], [axis]: Number(event.target.value) } })} /></label>)}</div>)}</>}<div className="vector-color-row"><PaintField label="Path fill" value={value.fill} onChange={(fill) => setValue({ ...value, fill })} /><PaintField label="Path stroke" value={value.stroke} onChange={(stroke) => setValue({ ...value, stroke })} /></div><div className="pro-form-grid"><label className="field-label">Stroke, px<input aria-label="Edit path stroke width" type="number" min="0" max="100" value={value.strokeWidth} onChange={(event) => setValue({ ...value, strokeWidth: Number(event.target.value) })} /></label><label className="checkbox-label"><input type="checkbox" checked={value.closed} onChange={(event) => setValue({ ...value, closed: event.target.checked })} />Closed path</label></div><button type="submit" className="button secondary wide" disabled={busy}><Check size={13} />Update path</button></form>;
}
