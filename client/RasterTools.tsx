import { filterStackActionHint } from './filter-bake';
import type { PointerEvent } from 'react';
import type { Document, Layer } from './api';
import type { BrushSettings, CanvasTool, RunCommand } from './CanvasTools';

export const CLICK_TOOLS = ['magic_wand', 'bucket', 'magic_eraser', 'eyedropper', 'row_select', 'column_select'];
export const CLICK_COMMANDS: Record<string, string> = { magic_wand: 'select_color', bucket: 'fill_area', magic_eraser: 'fill_area', eyedropper: 'sample_color', row_select: 'select_region', column_select: 'select_region' };

export function rasterPointerDown(event: PointerEvent<HTMLDivElement>, { tool, document, layer, brush, contiguous, canBakeFilters = false, run, notify, sampleColor, busy, can }: { tool: CanvasTool; document: Document | null; layer?: Layer; brush: BrushSettings; contiguous: boolean; canBakeFilters?: boolean; run: RunCommand; notify: (message: string, error?: boolean) => void; sampleColor: (x: number, y: number, background?: boolean) => void; busy: boolean; can: (command: string) => boolean }) {
  if (!CLICK_TOOLS.includes(tool)) return false;
  if (!document || busy || event.button !== 0 || !can(CLICK_COMMANDS[tool])) return true;
  const bounds = event.currentTarget.getBoundingClientRect();
  const x = Math.max(0, Math.min(document.width - 1, Math.floor((event.clientX - bounds.left) / bounds.width * document.width))), y = Math.max(0, Math.min(document.height - 1, Math.floor((event.clientY - bounds.top) / bounds.height * document.height)));
  if (tool === 'eyedropper') sampleColor(x, y, event.altKey);
  else if (tool === 'magic_wand') {
    const mode = event.shiftKey && event.altKey ? 'intersect' : event.shiftKey ? 'add' : event.altKey ? 'subtract' : 'replace';
    if (mode !== 'replace' && mode !== 'add' && !document.selection) { notify('Create a selection before subtracting or intersecting.', true); return true; }
    void run('select_color', { x, y, tolerance: brush.tolerance, contiguous, ...(mode === 'replace' ? {} : { mode }) }, mode === 'add' ? 'Adding color region' : mode === 'subtract' ? 'Subtracting color region' : mode === 'intersect' ? 'Intersecting color region' : 'Selecting color region');
  }
  else if (tool === 'row_select' || tool === 'column_select') void run('select_region', { shape: 'rectangle', x: tool === 'row_select' ? 0 : x, y: tool === 'row_select' ? y : 0, width: tool === 'row_select' ? document.width : 1, height: tool === 'row_select' ? 1 : document.height }, `Selecting one ${tool === 'row_select' ? 'row' : 'column'}`);
  else {
    if (!layer || layer.type !== 'raster') { notify('Select a raster layer, or rasterize your layer before filling or erasing.', true); return true; }
    if (layer.filters?.length) { notify(filterStackActionHint(canBakeFilters, 'filling or erasing'), true); return true; }
    if (layer.protected) { notify('This layer’s pixels are protected. Unprotect it in Layer properties before filling or erasing.', true); return true; }
    void run('fill_area', { layerId: layer.id, x, y, color: brush.color, opacity: brush.opacity, tolerance: brush.tolerance, contiguous, mode: tool === 'magic_eraser' ? 'erase' : 'color' }, tool === 'magic_eraser' ? 'Erasing color region' : 'Filling color region');
  }
  return true;
}

export function RasterOptions({ tool, brush, setBrush, contiguous, setContiguous, radius, setRadius }: { tool: CanvasTool; brush: BrushSettings; setBrush: (brush: BrushSettings) => void; contiguous: boolean; setContiguous: (value: boolean) => void; radius: number; setRadius: (value: number) => void }) {
  return <div className="pro-tool-options raster-options">{tool === 'eyedropper' ? <><label>Sample radius<input aria-label="Eyedropper sample radius" type="number" min="0" max="50" value={radius} onChange={(event) => setRadius(Math.max(0, Math.min(50, Number(event.target.value))))} /><span>px</span></label><span>Samples actual composite pixels, including all visible layers. Option / Alt-click sets the background color.</span></> : tool === 'row_select' || tool === 'column_select' ? <span>Click the canvas to select a single pixel-wide {tool === 'row_select' ? 'row' : 'column'}.</span> : <><label>Tolerance<input aria-label="Region tolerance" type="number" min="0" max="255" value={brush.tolerance} onChange={(event) => setBrush({ ...brush, tolerance: Math.max(0, Math.min(255, Number(event.target.value))) })} /></label><label><input aria-label="Contiguous region" type="checkbox" checked={contiguous} onChange={(event) => setContiguous(event.target.checked)} />Contiguous</label>{tool === 'bucket' && <label>Fill<input aria-label="Fill color" type="color" value={brush.color} onChange={(event) => setBrush({ ...brush, color: event.target.value })} /></label>}{tool !== 'magic_wand' && <label>Opacity<input aria-label="Fill opacity" type="number" min="0" max="100" value={Math.round(brush.opacity * 100)} onChange={(event) => setBrush({ ...brush, opacity: Math.max(0, Math.min(100, Number(event.target.value))) / 100 })} /><span>%</span></label>}<span className="selection-guidance">{tool === 'magic_wand' ? 'Click to select · Shift adds · Alt subtracts · Shift+Alt intersects.' : 'Click an area of the canvas to apply.'}</span></>}</div>;
}
