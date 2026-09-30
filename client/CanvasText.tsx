import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MutableRefObject } from 'react';
import { AlignCenter, AlignLeft, AlignRight, Bold, Check, Italic, X } from 'lucide-react';
import type { Document, Layer } from './api';
import type { RunCommand } from './CanvasTools';
import type { GestureContext } from './gesture';
import './canvas-text.css';

export type TextStyle = { fontSize: number; color: string; fontFamily: NonNullable<Layer['fontFamily']>; fontWeight: 'normal' | 'bold'; fontStyle: 'normal' | 'italic'; align: 'left' | 'center' | 'right' };
/** Source-pixel text frame. Point text has no width; box text wraps inside width. */
export type TextDraft = { x: number; y: number; width?: number; height?: number; context: GestureContext; /** Existing text layer edited in place; x/y are then its rendered anchor. */ layer?: Layer };

// Same preference order as assets/fonts/fonts.conf, so the preview and wrapping
// measure the faces the engine will draw.
const FAMILY_STACKS: Record<TextStyle['fontFamily'], string> = {
  'sans-serif': 'Helvetica, Arial, "Liberation Sans", "DejaVu Sans", sans-serif',
  serif: '"Times New Roman", Times, "Liberation Serif", "DejaVu Serif", serif',
  monospace: 'Menlo, "Courier New", "Liberation Mono", "DejaVu Sans Mono", monospace',
  Fraunces: '"Prism Fraunces", serif',
};
const cssFamily = (family: TextStyle['fontFamily']) => FAMILY_STACKS[family];
const MIN_BOX = 8;

/** Break text into explicit lines that fit maxWidth, measured with the same font the overlay shows. */
export function wrapText(text: string, maxWidth: number, style: TextStyle) {
  const context = globalThis.document?.createElement('canvas').getContext('2d');
  if (!context) return text;
  context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize}px ${cssFamily(style.fontFamily)}`;
  const fits = (value: string) => context.measureText(value).width <= maxWidth;
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/(\s+)/)) {
      if (!word) continue;
      if (fits(line + word)) { line += word; continue; }
      if (line.trim()) lines.push(line.trimEnd());
      line = /^\s+$/.test(word) ? '' : word;
      // A single word wider than the box breaks by character, as Photoshop does.
      while (line && !fits(line)) {
        let cut = 1;
        while (cut < line.length && fits(line.slice(0, cut + 1))) cut++;
        lines.push(line.slice(0, cut)); line = line.slice(cut);
      }
    }
    lines.push(line.trimEnd());
  }
  return lines.join('\n');
}

/** The engine puts the first baseline at y + fontSize; a CSS line box puts it at half-leading + ascent. */
function baselineShift(style: TextStyle, lineStep = style.fontSize * 1.2) {
  const context = globalThis.document?.createElement('canvas').getContext('2d');
  if (!context) return 0;
  context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize}px ${cssFamily(style.fontFamily)}`;
  const metrics = context.measureText('Hg'), ascent = metrics.fontBoundingBoxAscent, descent = metrics.fontBoundingBoxDescent;
  return Math.max(0, style.fontSize - ((lineStep - ascent - descent) / 2 + ascent));
}

/** Net source-to-canvas offset for geometry that only translates (moves, crops, canvas resizes); null for scale/rotate/distort. */
function translation(layer: Layer) {
  let dx = 0, dy = 0;
  for (const stage of layer.transforms ?? []) {
    const t = stage as { type?: string; x?: number; y?: number; scaleX?: number; scaleY?: number; rotation?: number; flipX?: boolean; flipY?: boolean };
    if (t.type === 'affine' && (t.scaleX ?? 1) === 1 && (t.scaleY ?? 1) === 1 && !t.rotation && !t.flipX && !t.flipY) { dx += t.x ?? 0; dy += t.y ?? 0; }
    else if (t.type === 'canvas') { dx += t.x ?? 0; dy += t.y ?? 0; }
    else if (t.type === 'crop') { dx -= t.x ?? 0; dy -= t.y ?? 0; }
    else return null;
  }
  return { dx, dy };
}

/** Rendered canvas bounds of a native text layer, measured with the fonts the engine draws. */
export function textLayerBounds(layer: Layer) {
  if (layer.type !== 'text' || !layer.text || layer.x === undefined || layer.y === undefined || !layer.fontSize) return null;
  const offset = translation(layer), context = globalThis.document?.createElement('canvas').getContext('2d');
  if (!offset || !context) return null;
  const size = layer.fontSize, step = layer.leading ?? size * 1.2, spacing = (layer.tracking ?? 0) * size / 1000;
  context.font = `${layer.fontStyle ?? 'normal'} ${layer.fontWeight ?? 'normal'} ${size}px ${cssFamily(layer.fontFamily ?? 'sans-serif')}`;
  const lines = layer.text.split('\n'), metrics = context.measureText('Hg');
  let left = Infinity, right = -Infinity;
  for (const line of lines) {
    const width = context.measureText(line).width + spacing * [...line].length;
    const start = layer.align === 'center' ? layer.x - width / 2 : layer.align === 'right' ? layer.x - width : layer.x;
    left = Math.min(left, start); right = Math.max(right, start + width);
  }
  const top = layer.y + size - (metrics.fontBoundingBoxAscent || size * 0.8), bottom = layer.y + size + (lines.length - 1) * step + (metrics.fontBoundingBoxDescent || size * 0.2);
  return { x: left + offset.dx, y: top + offset.dy, width: right - left, height: bottom - top, anchorX: layer.x + offset.dx, anchorY: layer.y + offset.dy };
}

/** Topmost visible, editable text layer under a canvas point (Photoshop's Type tool click-to-edit). */
export function textLayerAt(document: Document, point: { x: number; y: number }, pad = 4) {
  const hidden = new Set(document.layers.filter(layer => !layer.visible).map(layer => layer.id));
  const visible = (layer: Layer): boolean => !hidden.has(layer.id) && (!layer.parentId || visible(document.layers.find(item => item.id === layer.parentId) ?? { ...layer, parentId: null }));
  for (const layer of [...document.layers].reverse()) {
    if (layer.type !== 'text' || layer.protected || !visible(layer)) continue;
    const bounds = textLayerBounds(layer);
    if (bounds && point.x >= bounds.x - pad && point.x <= bounds.x + bounds.width + pad && point.y >= bounds.y - pad && point.y <= bounds.y + bounds.height + pad) return { layer, bounds };
  }
  return null;
}

const lightColor = (hex: string) => { const value = Number.parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16); return ((value >> 16 & 255) * 0.299 + (value >> 8 & 255) * 0.587 + (value & 255) * 0.114) > 140; };

export function isTextBox(draft: TextDraft) { return (draft.width ?? 0) >= MIN_BOX && (draft.height ?? 0) >= MIN_BOX; }

export function CanvasTextEditor({ document, draft, zoom, style: toolStyle, setStyle: setToolStyle, native, busy, run, commitRef, onClose }: { document: Document; draft: TextDraft; zoom: number; style: TextStyle; setStyle: (style: TextStyle) => void; native: boolean; busy: boolean; run: RunCommand; commitRef: MutableRefObject<(() => Promise<void>) | null>; onClose: () => void }) {
  const editing = draft.layer;
  // Editing an existing layer starts from that layer's own typography, not the tool defaults.
  const [original] = useState<TextStyle | null>(() => editing ? { fontSize: editing.fontSize ?? 64, color: editing.color || '#ffffff', fontFamily: editing.fontFamily || 'sans-serif', fontWeight: editing.fontWeight || 'normal', fontStyle: editing.fontStyle || 'normal', align: editing.align || 'left' } : null);
  const [layerStyle, setLayerStyle] = useState<TextStyle | null>(original);
  const style = layerStyle ?? toolStyle, setStyle = layerStyle ? setLayerStyle : setToolStyle;
  const [text, setText] = useState(editing?.text ?? '');
  const [minimum] = useState(() => editing ? textLayerBounds(editing) : null);
  const input = useRef<HTMLTextAreaElement>(null);
  const box = !editing && isTextBox(draft);
  const lineStep = editing?.leading ?? style.fontSize * 1.2;
  useEffect(() => {
    const element = input.current; if (!element) return;
    const focus = () => { element.focus(); if (editing) element.setSelectionRange(element.value.length, element.value.length); };
    focus();
  }, []);
  // Point text grows with its content; box text keeps the dragged width, wraps, and grows taller if it overflows.
  useLayoutEffect(() => {
    const element = input.current; if (!element) return;
    if (!box) { element.style.width = '0px'; element.style.width = `${Math.max(element.scrollWidth + 2, style.fontSize * zoom * 0.6, minimum ? minimum.width * zoom + 2 : 0)}px`; }
    element.style.height = '0px';
    // While editing, the backdrop keeps covering the layer's previously rendered glyphs.
    element.style.height = `${Math.max(element.scrollHeight, box ? draft.height! * zoom : 0, minimum ? (minimum.y + minimum.height - minimum.anchorY) * zoom : 0)}px`;
  }, [text, style, zoom, box, draft.height, editing, minimum]);

  const commit = async () => {
    if (busy) return;
    if (editing) {
      const unchanged = text === editing.text && original && (Object.keys(original) as (keyof TextStyle)[]).every(key => original[key] === style[key]);
      if (!text.trim() || unchanged) { onClose(); return; }
      const { fontSize, color, fontFamily, fontWeight, fontStyle, align } = style;
      const result = await run('update_text', { layerId: editing.id, text: text.slice(0, 2000), fontSize, color, fontFamily, fontWeight, fontStyle, align }, 'Updating text', draft.context);
      if (result) onClose();
      return;
    }
    if (!text.trim()) { onClose(); return; }
    const width = draft.width ?? 0;
    await globalThis.document?.fonts?.ready;
    const content = box ? wrapText(text, width, style) : text;
    const anchorX = !box || style.align === 'left' ? draft.x : style.align === 'center' ? draft.x + width / 2 : draft.x + width;
    const x = Math.max(0, Math.min(document.width - 1, Math.round(anchorX))), y = Math.max(0, Math.min(document.height - 1, Math.round(draft.y)));
    const { fontSize, color, fontFamily, fontWeight, fontStyle, align } = style;
    const result = await run('add_text', { text: content.slice(0, 2000), x, y, fontSize, color, ...(native ? { fontFamily, fontWeight, fontStyle, align: box ? align : 'left' } : {}) }, 'Adding text', draft.context);
    if (result) onClose();
  };

  commitRef.current = commit;
  const scaled = style.fontSize * zoom;
  const shiftX = editing && style.align === 'center' ? '-50%' : editing && style.align === 'right' ? '-100%' : null;
  const frame: CSSProperties = { left: draft.x * zoom, top: draft.y * zoom, ...(box ? { width: draft.width! * zoom, minHeight: draft.height! * zoom } : {}), ...(shiftX ? { transform: `translateX(${shiftX})` } : {}) };
  const textStyle: CSSProperties = { paddingTop: baselineShift(style, lineStep) * zoom, fontFamily: cssFamily(style.fontFamily), fontWeight: style.fontWeight, fontStyle: style.fontStyle, fontSize: scaled, lineHeight: editing?.leading ? `${lineStep * zoom}px` : 1.2, color: style.color, textAlign: box || editing ? style.align : 'left', ...(style.fontStyle === 'italic' && !box && (!editing || style.align === 'left') ? { paddingRight: scaled * 0.15 } : {}), ...(editing?.tracking ? { letterSpacing: `${editing.tracking / 1000}em` } : {}), ...(editing ? { background: lightColor(style.color) ? 'rgba(24, 22, 28, 0.86)' : 'rgba(246, 244, 248, 0.9)' } : {}) };
  const set = (patch: Partial<TextStyle>) => setStyle({ ...style, ...patch });
  return <div className={`canvas-text ${box ? 'box' : 'point'}${editing ? ' editing' : ''}`} style={frame} onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()} onPointerMove={event => event.stopPropagation()}>
    <div className="canvas-text-bar" role="toolbar" aria-label="Text options">
      {native && <select aria-label="Canvas text typeface" value={style.fontFamily} onChange={event => set({ fontFamily: event.target.value as TextStyle['fontFamily'] })}><option value="sans-serif">Sans serif</option><option value="serif">Serif</option><option value="Fraunces">Fraunces</option><option value="monospace">Monospace</option></select>}
      <input aria-label="Canvas text size" type="number" min="1" max="1000" value={style.fontSize} onChange={event => { const value = event.target.valueAsNumber; if (Number.isFinite(value) && value >= 1 && value <= 1000) set({ fontSize: value }); }} />
      <input aria-label="Canvas text color" type="color" value={style.color} onChange={event => set({ color: event.target.value })} />
      {native && <><button type="button" aria-label="Bold" aria-pressed={style.fontWeight === 'bold'} onClick={() => set({ fontWeight: style.fontWeight === 'bold' ? 'normal' : 'bold' })}><Bold size={13} /></button>
        <button type="button" aria-label="Italic" aria-pressed={style.fontStyle === 'italic'} onClick={() => set({ fontStyle: style.fontStyle === 'italic' ? 'normal' : 'italic' })}><Italic size={13} /></button></>}
      {native && (box || editing) && ([['left', AlignLeft], ['center', AlignCenter], ['right', AlignRight]] as const).map(([value, Icon]) => <button key={value} type="button" aria-label={`Align ${value}`} aria-pressed={style.align === value} onClick={() => set({ align: value })}><Icon size={13} /></button>)}
      <span className="canvas-text-divider" />
      <button type="button" className="commit" aria-label="Commit text" disabled={busy} onClick={() => void commit()}><Check size={14} /></button>
      <button type="button" aria-label="Cancel text" onClick={onClose}><X size={14} /></button>
    </div>
    <textarea ref={input} aria-label="Canvas text" spellCheck={false} maxLength={2000} value={text} style={textStyle} placeholder="Type here" data-layer-id={editing?.id} wrap={box ? 'soft' : 'off'}
      onChange={event => setText(event.target.value)}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); onClose(); }
        else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void commit(); }
      }} />
  </div>;
}
