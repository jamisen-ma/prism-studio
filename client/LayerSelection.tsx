import { supportsMask } from './dense-mask';
import { useState } from 'react';
import { Download, Layers } from 'lucide-react';
import type { Backend, Document, Layer, Mask } from './api';
import type { RunCommand } from './CanvasTools';
import { captureGesture } from './gesture';
import { displayLayers } from './layer-tree';
import './layer-selection.css';

export function LayerSelection({ document, layer, capabilities, selection, busy, run, onSelectLayer }: { document: Document; layer?: Layer; capabilities: Backend; selection: Mask | null; busy: boolean; run: RunCommand; onSelectLayer: (id: string) => void }) {
  const contentAllowed = Boolean(layer && capabilities.layerSelectionSources?.includes('content') && capabilities.layerSelectionContentTypes?.includes(layer.type));
  const maskAllowed = Boolean(layer?.mask && capabilities.layerSelectionSources?.includes('layer-mask') && capabilities.layerSelectionMaskModes?.length);
  const [source, setSource] = useState<'content' | 'layer-mask'>(contentAllowed ? 'content' : maskAllowed ? 'layer-mask' : 'content');
  const [maskMode, setMaskMode] = useState<'raw' | 'effective'>(capabilities.layerSelectionMaskModes?.includes('effective') ? 'effective' : 'raw');
  const [mode, setMode] = useState<'replace' | 'add' | 'subtract' | 'intersect'>('replace');
  const [invert, setInvert] = useState(false);
  const needsSelection = mode === 'subtract' || mode === 'intersect';
  const sourceAllowed = source === 'content' ? contentAllowed : supportsMask(layer?.mask, capabilities) && maskAllowed && capabilities.layerSelectionMaskModes?.includes(maskMode);
  const eligible = layer && sourceAllowed && (mode === 'replace' || supportsMask(selection, capabilities)) && (!needsSelection || selection) && !busy;
  const load = () => {
    if (!eligible || !layer) return;
    void run('load_layer_selection', { layerId: layer.id, source, ...(source === 'layer-mask' ? { maskMode } : {}), mode, invert }, 'Loading selection from layer', captureGesture(document, layer.id));
  };
  return <section className="layer-selection" aria-label="Selection from a layer">
    <div className="section-heading"><span>From a layer</span><Layers size={14} /></div>
    <label className="field-label">Layer<select aria-label="Selection source layer" value={layer?.id || ''} disabled={busy} onChange={event => onSelectLayer(event.target.value)}>{!layer && <option value="">Choose a layer</option>}{displayLayers(document).map(item => <option key={item.id} value={item.id}>{'— '.repeat(item.depth)}{item.name}</option>)}</select></label>
    <label className="field-label">Source<select aria-label="Layer selection source" value={source} disabled={busy} onChange={event => setSource(event.target.value as typeof source)}><option value="content" disabled={!contentAllowed}>Content transparency</option><option value="layer-mask" disabled={!maskAllowed}>Layer mask</option></select></label>
    {!layer ? <p className="property-hint">Choose a layer to load its coverage.</p> : !contentAllowed && !maskAllowed ? <p className="property-hint">{['group', 'adjustment'].includes(layer.type) ? 'Groups and adjustments have no individual content transparency. Add an own layer mask to use its coverage.' : 'This layer has no supported content or additional mask source.'}</p> : source === 'content' ? <><p className="property-hint">Uses transformed working transparency, including source cutout alpha. Ignores visibility, opacity, layer masks and effects.</p><details><summary>About content coverage</summary><p className="property-hint">Parent settings, clipping coverage and protected-layer display exclusions are also ignored. This selects stored content transparency, not the visible composite. Source pixels stay unchanged.</p></details></> : <><label className="field-label">Coverage<select aria-label="Layer selection mask coverage" value={maskMode} disabled={busy} onChange={event => setMaskMode(event.target.value as typeof maskMode)}><option value="effective" disabled={!capabilities.layerSelectionMaskModes?.includes('effective')}>With density</option><option value="raw" disabled={!capabilities.layerSelectionMaskModes?.includes('raw')}>Before density</option></select></label><p className="property-hint">Uses this layer’s additional mask in canvas coordinates, including feather and mask inversion. {maskMode === 'effective' ? `Includes its ${Number(((layer.maskDensity ?? 1) * 100).toFixed(3))}% density.` : 'Ignores mask density.'} Source cutout alpha is separate.</p></>}
    {!maskAllowed && contentAllowed && <p className="property-hint layer-selection-reason">No additional layer mask is attached.</p>}
    <label className="field-label">Combine<select aria-label="Layer selection combination" value={mode} disabled={busy} onChange={event => setMode(event.target.value as typeof mode)}><option value="replace">Replace active selection</option><option value="add">Add to active selection</option><option value="subtract">Subtract from active selection</option><option value="intersect">Intersect with active selection</option></select></label>
    <label className="layer-selection-invert"><input aria-label="Invert layer selection source" type="checkbox" checked={invert} disabled={busy} onChange={event => setInvert(event.target.checked)} />Invert source before combining</label>
    {needsSelection && !selection && <p className="property-hint layer-selection-reason">Create an active selection before using {mode === 'subtract' ? 'Subtract' : 'Intersect'}.</p>}
    <button className="button secondary wide" disabled={!eligible} onClick={load}><Download size={12} />Load from layer</button>
  </section>;
}
