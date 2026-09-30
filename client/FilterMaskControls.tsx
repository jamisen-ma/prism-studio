import { maskShapeLabel, supportsMask } from './dense-mask';
import { useState } from 'react';
import type { Backend, Document, Layer } from './api';
import type { RunCommand } from './CanvasTools';
import type { GestureContext } from './gesture';
import { canCaptureFilterSelection, filterMaskDraft, filterMaskSupport, maskChanges, maskNumber, type FilterMaskDraft } from './filter-mask';
import './filter-mask.css';

type Source = 'all' | 'none' | 'selection' | 'rectangle' | 'ellipse';
const sources: { value: Source; label: string }[] = [{ value: 'all', label: 'Reveal all' }, { value: 'none', label: 'Hide all effects' }, { value: 'selection', label: 'Current selection' }, { value: 'rectangle', label: 'Source rectangle' }, { value: 'ellipse', label: 'Source ellipse' }];
const emptyDraft: FilterMaskDraft = { density: '100', feather: '0', invert: false, enabled: true };
export function FilterMaskControls({ document, layer, capabilities, busy, run, captureContext, onInspect }: { document: Document; layer: Layer; capabilities: Backend; busy: boolean; run: RunCommand; captureContext: () => GestureContext; onInspect?: () => void }) {
  const mask = layer.filterMask, support = filterMaskSupport(capabilities, document.backend), width = layer.width || 0, height = layer.height || 0;
  const key = `${document.backend}:${document.id}:${layer.id}:${document.revision}`;
  const savedDraft = () => mask ? filterMaskDraft(mask) : { ...emptyDraft };
  const [stored, setStored] = useState({ key, value: savedDraft() });
  const draft = stored.key === key ? stored.value : savedDraft();
  if (stored.key !== key) setStored({ key, value: draft });
  const setDraft = (value: FilterMaskDraft) => setStored({ key, value });
  const supportsSource = (source: Source) => support.sources.includes(source === 'rectangle' || source === 'ellipse' ? 'mask' : source) && (!(source === 'rectangle' || source === 'ellipse') || support.shapes.includes(source)) && (source !== 'selection' || support.capture && supportsMask(document.selection && 'shape' in document.selection ? document.selection : null, capabilities) && (document.selection && 'shape' in document.selection && document.selection.shape === 'alpha8' ? support.shapes.includes('alpha8') : true));
  const initialSource = sources.find(item => supportsSource(item.value))?.value || 'all';
  const [creation, setCreation] = useState({ key, source: initialSource, x: '0', y: '0', width: String(width), height: String(height) });
  const create = creation.key === key ? creation : { key, source: initialSource, x: '0', y: '0', width: String(width), height: String(height) };
  if (creation.key !== key) setCreation(create);
  const field = (name: 'x' | 'y' | 'width' | 'height', value: string) => setCreation({ ...create, [name]: value });
  const shape = create.source === 'rectangle' || create.source === 'ellipse';
  const bounds = { x: maskNumber(create.x), y: maskNumber(create.y), width: maskNumber(create.width), height: maskNumber(create.height) };
  const boundsValid = Object.values(bounds).every(value => value !== undefined && Number.isInteger(value)) && bounds.x! >= 0 && bounds.y! >= 0 && bounds.width! > 0 && bounds.height! > 0 && bounds.x! + bounds.width! <= width && bounds.y! + bounds.height! <= height;
  const captureEligible = canCaptureFilterSelection(layer), selection = Boolean(document.selection);
  const frozen = busy || Boolean(layer.protected), hasFilters = Boolean(layer.filters?.length);
  const property = (name: string) => supportsMask(mask?.coverage, capabilities) && (mask?.coverage.shape !== 'alpha8' || support.shapes.includes('alpha8')) && support.modify && support.properties.includes(name);
  const changes = mask ? maskChanges(draft, mask) : undefined;
  const dirty = Boolean(mask && (!changes || Object.keys(changes).length > 0));
  const canApply = !frozen && changes && Object.keys(changes).length > 0 && Object.keys(changes).every(property);
  const canCreate = !frozen && hasFilters && support.set && supportsSource(create.source) && (!shape || boundsValid) && (create.source !== 'selection' || selection && captureEligible);
  const submit = () => { if (!canCreate) return; void run('set_layer_filter_mask', { layerId: layer.id, source: shape ? 'mask' : create.source, ...(shape ? { mask: { shape: create.source, ...bounds, feather: 0, invert: false } } : {}) }, mask ? 'Replacing filter effect mask' : 'Adding filter effect mask', captureContext()); };
  if (!mask && !support.supported && !support.preview) return null;
  return <details className="filter-mask-controls" aria-label="Filter effect mask">
    <summary>Filter effect mask <span>· {mask ? `${maskShapeLabel(mask.coverage)} · ${mask.enabled ? 'enabled' : 'disabled'}` : 'none'}</span></summary>
    <p>Controls where the full filter stack changes colors. Layer transparency stays unchanged.</p>
    <p className="property-hint">{width} × {height} source pixels, before transforms.</p>
    {!support.supported && mask && <p className="filter-mask-unavailable">This companion does not advertise this effect-mask policy. Saved coverage and settings remain unchanged.</p>}
    {mask && <>
      <fieldset disabled={frozen} className="filter-mask-settings" aria-label="Saved effect mask settings">
        <label className="filter-mask-check"><input aria-label="Use filter effect mask" type="checkbox" checked={draft.enabled} disabled={!property('enabled')} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />Use effect mask</label>
        <label className="filter-mask-check"><input aria-label="Invert filter effect coverage" type="checkbox" checked={draft.invert} disabled={!property('invert')} onChange={event => setDraft({ ...draft, invert: event.target.checked })} />Invert coverage</label>
        <div className="filter-mask-grid"><label className="field-label">Density, %<input aria-label="Filter mask density percent" type="number" min="0" max="100" step="any" value={draft.density} disabled={!property('density')} onChange={event => setDraft({ ...draft, density: event.target.value })} /></label><label className="field-label">Feather, source px<input aria-label="Filter mask feather" type="number" min="0" max="100" step="any" value={draft.feather} disabled={!property('feather')} onChange={event => setDraft({ ...draft, feather: event.target.value })} /></label></div>
        {!draft.enabled && <p className="filter-mask-bypass">Mask disabled: the full filter stack is shown. Saved coverage and settings are retained.</p>}
        <p className="property-hint">Density 0% reveals the full filter result; 100% uses the full mask. Changes stay local until Apply.</p>
        {!changes && <p className="inline-panel-error">Enter finite Density 0–100% and Feather 0–100 source pixels.</p>}
        <div className="filter-mask-actions"><button type="button" className="button mini subtle" disabled={!dirty} onClick={() => setDraft(savedDraft())}>Reset mask changes</button><button type="button" className="button mini secondary" disabled={!canApply} onClick={() => canApply && void run('modify_layer_filter_mask', { layerId: layer.id, ...changes }, 'Updating filter effect mask', captureContext())}>Apply effect mask settings</button></div>
      </fieldset>
      {support.preview && onInspect && <button type="button" className="button mini subtle" disabled={busy} onClick={onInspect}>Inspect effect coverage</button>}
      {dirty && <p className="property-hint">Inspection and removal use the saved mask, without pending changes.</p>}
      {support.clear && <div className="filter-mask-remove"><button type="button" className="button mini subtle" disabled={frozen} onClick={() => void run('clear_layer_filter_mask', { layerId: layer.id }, 'Removing filter effect mask', captureContext())}>Remove effect mask</button><p className="property-hint">Keeps every filter and reveals the full stack.</p></div>}
    </>}
    {!hasFilters ? <p className="property-hint">Add a filter before creating an effect mask.</p> : support.set && <details className="filter-mask-create" open={!mask}>
      <summary>{mask ? 'Replace coverage' : 'Create coverage'}</summary>
      <label className="field-label">Coverage source<select aria-label="Filter mask coverage source" disabled={frozen} value={create.source} onChange={event => setCreation({ ...create, source: event.target.value as Source })}>{sources.map(item => <option key={item.value} value={item.value} disabled={!supportsSource(item.value)}>{item.label}{!supportsSource(item.value) ? ' · unavailable' : ''}</option>)}</select></label>
      {shape && <div className="filter-mask-grid">{(['x', 'y', 'width', 'height'] as const).map(name => <label className="field-label" key={name}>{name.toUpperCase()}, source px<input aria-label={`Filter mask source ${name}`} type="number" min={name === 'x' || name === 'y' ? 0 : 1} max={name === 'x' || name === 'width' ? width : height} step="1" value={create[name]} disabled={frozen || !supportsSource(create.source)} onChange={event => field(name, event.target.value)} /></label>)}</div>}
      {shape && !boundsValid && <p className="inline-panel-error">Use whole source pixels with positive width/height, entirely inside this source frame.</p>}
      {create.source === 'selection' && (!captureEligible ? <p className="filter-mask-capture-reason">This source has resampled or non-integer geometry. Create the mask before those transforms, or choose a source rectangle/ellipse.</p> : !selection ? <p className="filter-mask-capture-reason">Create a selection first. An explicit empty selection hides all effects.</p> : <p className="property-hint">Captures saved selection coverage once. Cropped source areas stay excluded; later selection edits do not update the mask.</p>)}
      {mask && <p className="property-hint">Replaces saved coverage and resets Density to 100%, Feather to 0, Invert off and Use effect mask on. Undo restores the previous mask.</p>}
      <button type="button" className="button mini secondary wide" disabled={!canCreate} onClick={submit}>{mask ? 'Replace effect mask' : 'Add effect mask'}</button>
    </details>}
    <details className="filter-mask-help"><summary>How the effect mask works</summary><p>Black restores colors before filters; white reveals the completed stack; gray partially reveals it. Every filter runs first, including its full source neighborhood.</p><p>Density 0% or disabling the mask reveals the full stack. Filter entries remain active; painting source pixels still requires Bake or Clear.</p><p>This source mask moves and resamples with the filtered image. Layer masks and source cutout alpha separately control transparency.</p><p>Draw or paint a selection with selection tools, then capture it explicitly. The layer mask brush edits the separate layer mask.</p><p>Bake, Clear filters and deleting the final filter consume this effect mask. Undo restores it.</p></details>
  </details>;
}
