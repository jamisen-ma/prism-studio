import { useState } from 'react';
import { Check, Move, RotateCcw } from 'lucide-react';
import { isPositionedMask, type Backend, type Document, type Layer } from './api';
import type { RunCommand } from './CanvasTools';
import { captureGesture } from './gesture';
import './mask-position.css';

export function maskPositionCapabilities(capabilities?: Backend) {
  const recognized = capabilities?.id === 'native' && capabilities.layerMaskPositioning === 'independent-translation' && capabilities.layerMaskPositionUnits === 'document-pixels';
  const limit = capabilities?.limits?.maxLayerMaskPosition;
  return {
    set: Boolean(recognized && capabilities?.commands.includes('set_layer_mask_position') && capabilities.layerMaskPositionOperations?.includes('set') && Number.isInteger(limit) && limit! > 0),
    rasterize: Boolean(recognized && capabilities?.commands.includes('apply_layer_mask_position') && capabilities.layerMaskPositionOperations?.includes('rasterize')),
    limit: Number.isInteger(limit) && limit! > 0 ? Math.min(16384, limit!) : 16384,
  };
}

export const POSITION_MATERIALIZATION_NOTICE = 'This edit converts the positioned mask to 8-bit coverage on the current canvas and discards off-canvas coverage. Feather and inversion become pixels; density stays editable. Undo restores the retained mask.';

export function MaskPosition({ document, layer, capabilities, busy, run }: { document: Document; layer: Layer; capabilities?: Backend; busy: boolean; run: RunCommand }) {
  const positioned = isPositionedMask(layer.mask) ? layer.mask : null;
  const storedX = positioned?.x ?? 0, storedY = positioned?.y ?? 0;
  const [x, setX] = useState(String(storedX)), [y, setY] = useState(String(storedY));
  const support = maskPositionCapabilities(capabilities);
  const valid = [x, y].every(value => value.trim() !== '' && Number.isInteger(Number(value)) && Math.abs(Number(value)) <= support.limit);
  const changed = Number(x) !== storedX || Number(y) !== storedY;
  const dirty = (x !== String(storedX) || y !== String(storedY)) && (!valid || changed);
  const outOfRange = Math.abs(storedX) > support.limit || Math.abs(storedY) > support.limit;
  if (!layer.mask || (!positioned && !support.set)) return null;
  const move = (nextX: number, nextY: number) => run('set_layer_mask_position', { layerId: layer.id, x: nextX, y: nextY }, 'Positioning layer mask', captureGesture(document, layer.id));
  return <section className="mask-position" aria-label="Layer mask position" tabIndex={-1}>
    <div className="section-heading"><span>Mask position</span><Move size={13} /></div>
    <p className="property-hint">Move only this additional mask. Layer pixels and source cutout alpha stay in place. Positive X moves right; positive Y moves down. Off-canvas coverage is retained when repositioning.</p>
    {support.set ? <form onSubmit={event => { event.preventDefault(); if (!busy && valid && changed) void move(Number(x), Number(y)); }}>
      <div className="mask-position-fields"><label>X, px<input aria-label="Layer mask position X" type="number" step="1" min={-support.limit} max={support.limit} value={x} disabled={busy} onChange={event => setX(event.target.value)} /></label><label>Y, px<input aria-label="Layer mask position Y" type="number" step="1" min={-support.limit} max={support.limit} value={y} disabled={busy} onChange={event => setY(event.target.value)} /></label></div>
      {!valid && <p className="inline-panel-error">Enter whole pixels from −{support.limit.toLocaleString()} to {support.limit.toLocaleString()}. Stored positions are never clamped.</p>}
      {outOfRange && <p className="property-hint">Canvas geometry placed this mask outside the editable range. Enter a position in range, reset it, or rasterize its current coverage.</p>}
      <div className="mask-position-actions"><button className="button mini secondary" type="submit" disabled={busy || !valid || !changed}><Check size={12} />Apply position</button><button className="button mini subtle" type="button" disabled={busy || (!dirty && storedX === 0 && storedY === 0)} onClick={() => { if (storedX || storedY) void move(0, 0); else { setX('0'); setY('0'); } }}><RotateCcw size={12} />Reset position</button></div>
    </form> : <p className="mask-position-readonly">X: {storedX} px · Y: {storedY} px. Position editing is unavailable with this companion.</p>}
    {dirty && <p className="property-hint">Coverage inspection shows the saved mask, not this draft.</p>}
    {positioned && <>
      {storedX === 0 && storedY === 0 && <p className="property-hint">Position is zero; retained mask coverage is still active.</p>}
      <p className="property-hint mask-position-frame">Retained mask frame: {positioned.sourceWidth} × {positioned.sourceHeight} px{positioned.domain ? ' · clipped by canvas bounds' : ''}. Reset moves this frame to 0, 0; it does not rasterize it.</p>
      {support.rasterize ? <><p className="mask-position-notice">{POSITION_MATERIALIZATION_NOTICE}</p><button className="button subtle wide" disabled={busy || dirty} onClick={() => void run('apply_layer_mask_position', { layerId: layer.id }, 'Rasterizing mask position', captureGesture(document, layer.id))}>Rasterize mask position</button>{dirty && <p className="property-hint">Apply or reset the position draft before rasterizing.</p>}</> : <p className="property-hint">Rasterizing mask position requires an updated companion with that operation.</p>}
    </>}
  </section>;
}
