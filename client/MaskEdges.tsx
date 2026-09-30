import { Check, ScanLine } from 'lucide-react';
import { useState } from 'react';
import type { RunCommand } from './CanvasTools';
import './mask-edges.css';
import { POSITION_MATERIALIZATION_NOTICE } from './MaskPosition';

const descriptions: Record<string, string> = {
  expand: 'Grow coverage outward using the strongest alpha in a square neighborhood.',
  contract: 'Shrink coverage inward. Areas outside the canvas count as empty.',
  border: 'Keep a band on both sides of the current edge.',
  smooth: 'Remove narrow features and fill small gaps using opening, then closing. This changes coverage; it does not blur the edge.',
};

export function MaskEdges({ layerId, exists, busy, operations, maxRadius = 100, run, positioned = false }: { layerId?: string; exists: boolean; busy: boolean; operations: string[]; maxRadius?: number; run: RunCommand; positioned?: boolean }) {
  const supported = operations.filter(operation => operation in descriptions);
  const [operation, setOperation] = useState(supported[0] || 'expand');
  const [radius, setRadius] = useState(2);
  const scope = layerId ? 'Layer mask' : 'Selection';
  const valid = Number.isInteger(radius) && radius >= 1 && radius <= maxRadius && supported.includes(operation);
  if (!supported.length) return null;
  return <section className="mask-edges" aria-label={`${scope} edges`}>
    <div className="section-heading"><span>{scope} edges</span><ScanLine size={13} /></div>
    <div className="mask-edge-inputs"><label className="field-label">Operation<select aria-label={`${scope} edge operation`} value={operation} disabled={busy || !exists} onChange={event => setOperation(event.target.value)}>{supported.map(value => <option key={value} value={value}>{value.charAt(0).toUpperCase() + value.slice(1)}</option>)}</select></label><label className="field-label">Radius, px<input aria-label={`${scope} edge radius`} type="number" min="1" max={maxRadius} step="1" value={radius} disabled={busy || !exists} onChange={event => setRadius(Number(event.target.value))} /></label></div>
    <p className="property-hint">{exists ? descriptions[operation] : `Create ${layerId ? 'a layer mask' : 'an active selection'} first.`}</p>
    {!valid && <p className="inline-panel-error">Use a whole radius from 1 to {maxRadius} pixels.</p>}
    {positioned && <p className="mask-position-notice">{POSITION_MATERIALIZATION_NOTICE}</p>}
    <button className="button secondary wide" disabled={busy || !exists || !valid} onClick={() => void run(layerId ? 'morph_layer_mask' : 'morph_selection', { ...(layerId ? { layerId } : {}), operation, radius }, `Refining ${scope.toLowerCase()} edges`)}><Check size={12} />Apply {scope.toLowerCase()} edges</button>
    <p className="property-hint mask-edge-disclosure">Uses current feathered and inverted coverage{layerId ? ' before mask density; density stays editable' : ''}. Source pixels stay unchanged. Undo restores the previous {layerId ? 'mask' : 'selection; saved selections stay independent'}.</p>
  </section>;
}
