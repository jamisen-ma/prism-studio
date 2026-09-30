import { useState } from 'react';
import type { Layer } from './api';
import type { RunCommand } from './CanvasTools';

export function MaskDensity({ layer, busy, run }: { layer: Layer; busy: boolean; run: RunCommand }) {
  const stored = layer.maskDensity ?? 1;
  const [percent, setPercent] = useState(String(stored * 100));
  const value = Number(percent), valid = percent.trim() !== '' && Number.isFinite(value) && value >= 0 && value <= 100;
  const density = value / 100;
  return <fieldset className="mask-density-control" aria-label="Additional layer mask density" disabled={busy}>
    <div className="mask-feather-control"><label>Density<input aria-label="Layer mask density percent" type="number" min="0" max="100" step="any" value={percent} onChange={event => setPercent(event.target.value)} /><span>%</span></label><button className="button mini subtle" disabled={!valid || density === stored} onClick={() => void run('modify_layer_mask', { layerId: layer.id, density }, 'Updating mask density')}>Apply mask density</button></div>
    <input aria-label="Layer mask density amount" type="range" min="0" max="100" step="1" value={valid ? value : stored * 100} onChange={event => setPercent(event.target.value)} />
    <div className="mask-density-labels"><span>0% · mask off</span><span>100% · full mask</span></div>
    {!valid && <p className="inline-panel-error">Use a density from 0 to 100%.</p>}
    <p className="property-hint">Lower density reveals pixels hidden by this additional mask. Source cutout alpha and layer opacity stay separate.</p>
  </fieldset>;
}
