import { Crosshair, Plus } from 'lucide-react';
import type { Backend, Document, Layer, Point } from './api';
import type { CanvasTool } from './CanvasTools';
import './retouch-tools.css';

export type RetouchSampling = { sampleMode: 'current' | 'current-and-below' | 'all'; ignoreAdjustments: boolean };
export const DEFAULT_RETOUCH: RetouchSampling = { sampleMode: 'all', ignoreAdjustments: false };
export const isRetouch = (tool: CanvasTool) => tool === 'clone' || tool === 'heal';
export function retouchCapabilities(capabilities: Backend | undefined, tool: CanvasTool) {
  const supported = capabilities?.id === 'native' && isRetouch(tool) && capabilities.retouchSamplingTools?.includes(tool);
  return { modes: supported ? (capabilities.retouchSampleModes || []).filter(mode => mode !== 'current-and-below' || capabilities.retouchCurrentAndBelowScope === 'root-target') : [], ignore: Boolean(supported && capabilities.retouchIgnoreAdjustments), repair: Boolean(supported && capabilities.commands.includes('create_repair_layer') && capabilities.repairLayerPlacement === 'above-root-raster') };
}
export function effectiveRetouch(settings: RetouchSampling, capabilities: Backend | undefined, tool: CanvasTool): RetouchSampling {
  const can = retouchCapabilities(capabilities, tool), sampleMode = can.modes.includes(settings.sampleMode) ? settings.sampleMode : 'all';
  return { sampleMode, ignoreAdjustments: sampleMode !== 'current' && can.ignore && settings.ignoreAdjustments };
}
export function retouchArgs(settings: RetouchSampling, capabilities: Backend | undefined, tool: CanvasTool) {
  const can = retouchCapabilities(capabilities, tool), current = effectiveRetouch(settings, capabilities, tool);
  return { ...(can.modes.includes(current.sampleMode) ? { sampleMode: current.sampleMode } : {}), ...(can.ignore ? { ignoreAdjustments: current.ignoreAdjustments } : {}) };
}
export function repairSourceReason(document: Document | null, layer?: Layer) {
  if (!document || !layer || layer.type !== 'raster') return 'Select a root raster source to create a repair layer.';
  if (layer.parentId) return 'The source must be outside a group.';
  if (layer.clipBaseId || document.layers.some(item => item.clipBaseId === layer.id)) return 'Release the source’s clipping chain before creating a repair layer.';
  return '';
}
export function retouchScopeReason(document: Document | null, layer: Layer | undefined, sampling: RetouchSampling) {
  return sampling.sampleMode === 'current-and-below' && repairSourceReason(document, layer) ? 'Current & below needs a root raster target outside a clipping chain. Choose another scope or target.' : '';
}
const label = (mode: RetouchSampling['sampleMode']) => mode === 'current' ? 'Current layer' : mode === 'all' ? 'All layers' : 'Current & below';
export function RetouchOptions({ document, layer, tool, capabilities, sampling, onSamplingChange, source, sampleCenter, aligned, established, pendingSource, onAlignedChange, clearSource, busy, onCreate }: { document: Document | null; layer?: Layer; tool: CanvasTool; capabilities?: Backend; sampling: RetouchSampling; onSamplingChange: (value: RetouchSampling) => void; source: Point | null; sampleCenter: Point | null; aligned: boolean; established: boolean; pendingSource: boolean; onAlignedChange: (value: boolean) => void; clearSource: () => void; busy: boolean; onCreate: () => void }) {
  if (!isRetouch(tool)) return null;
  const can = retouchCapabilities(capabilities, tool), current = effectiveRetouch(sampling, capabilities, tool), reason = retouchScopeReason(document, layer, current), creationReason = repairSourceReason(document, layer);
  const alignmentSupported = capabilities?.id === 'native' && capabilities.connected && capabilities.commands.includes('paint_stroke');
  const coordinate = (value: number) => String(Number(value.toFixed(2)));
  const outside = Boolean(sampleCenter && document && (sampleCenter.x < 0 || sampleCenter.y < 0 || sampleCenter.x >= document.width || sampleCenter.y >= document.height));
  const presetSupported = can.modes.includes('current-and-below') && can.ignore;
  const help = current.sampleMode === 'current' ? 'Samples transformed working pixels and subject alpha, before layer masks, opacity, styles and surrounding layers.' : current.sampleMode === 'current-and-below' ? 'Samples this layer and the layers below. Existing repair pixels are included at the start of each stroke.' : 'Samples the visible composite at the start of each stroke.';
  return <section className="pro-tool-options retouch-options" aria-label="Retouch sampling">{can.modes.length > 0 && <label>Sample<select aria-label="Retouch sample mode" value={current.sampleMode} disabled={busy} onChange={event => { const sampleMode = event.target.value as RetouchSampling['sampleMode']; onSamplingChange({ sampleMode, ignoreAdjustments: sampleMode === 'current' ? false : current.ignoreAdjustments }); }}>{(['all', 'current', 'current-and-below'] as const).filter(mode => mode === 'all' || can.modes.includes(mode)).map(mode => <option key={mode} value={mode} disabled={mode === 'current-and-below' && Boolean(creationReason)}>{label(mode)}</option>)}</select></label>}{can.ignore && <label><input aria-label="Ignore adjustment layers" type="checkbox" disabled={busy || current.sampleMode === 'current'} checked={current.ignoreAdjustments} onChange={event => onSamplingChange({ ...current, ignoreAdjustments: event.target.checked })} />Ignore adjustment layers</label>}{alignmentSupported && <label className="retouch-aligned"><input aria-label="Aligned sampling" type="checkbox" checked={aligned} disabled={busy} onChange={event => onAlignedChange(event.target.checked)} />Aligned</label>}<button className={`sample-button ${source ? 'sample-ready' : ''}`} disabled={busy} onClick={clearSource}><Crosshair size={12} />{source ? 'Source set · Reset' : 'Alt-click to sample'}</button>{source && <span className="retouch-source" title="Display coordinates in document pixels; sampling retains full precision.">Anchor: {coordinate(source.x)}, {coordinate(source.y)}{sampleCenter && <> · Sample: {coordinate(sampleCenter.x)}, {coordinate(sampleCenter.y)}</>} · {label(current.sampleMode)}</span>}{can.repair && <button className="button mini secondary" disabled={busy || Boolean(creationReason) || !presetSupported} onClick={onCreate}><Plus size={12} />Create repair layer</button>}<p className="retouch-alignment-status" aria-live="polite">{pendingSource ? 'Saving the captured stroke.' : aligned ? established ? 'Offset established. Alt/Option-click to sample again.' : 'The first completed stroke sets the offset.' : 'Each stroke starts from the sampled anchor.'}{outside && ' Sample center is outside the canvas; edge samples may be partly transparent.'}</p><p className="retouch-help">{reason || help} {current.ignoreAdjustments ? 'Skips adjustment layers; source filters still apply.' : current.sampleMode === 'current' && can.ignore ? 'Adjustment-layer skipping does not apply to this scope.' : ''} {tool === 'heal' && 'Healing uses sampled texture blending.'}</p>{can.repair && <p className="retouch-help repair-help">{creationReason || (!presetSupported ? 'Repair preset requires Current & below and adjustment skipping support.' : <>Creates above <strong>{layer?.name}</strong>; starts Current &amp; below, ignoring adjustment layers.</>)} Protected pixels stay protected, including underneath a repair layer.</p>}</section>;
}
