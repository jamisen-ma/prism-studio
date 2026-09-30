import { denseCapabilityKey, maskShapeLabel, supportsMask } from './dense-mask';
import { PhotoFilterControls } from './PhotoFilterControls';
import { photoFilterParameters, toPhotoFilterDraft, parsePhotoFilterDraft, supportsPhotoFilter, photoFilterCapabilityKey, type PhotoFilterDraft } from './photo-filter';
import { ColorLookup } from './ColorLookup';
import { TargetedHSLControls } from './TargetedHSLControls';
import { targetedHSLParameters, toTargetedHSLDraft, parseTargetedHSLDraft, supportsTargetedHSL, targetedHSLCapabilityKey } from './targeted-hsl';
import { SelectiveColorControls } from './SelectiveColorControls';
import { selectiveColorParameters, toSelectiveColorDraft, parseSelectiveColorDraft, supportsSelectiveColor, selectiveColorCapabilityKey, isPreciseColorKind } from './selective-color';
import { displayLayers } from './layer-tree';
import { CurvesEditor, createCurvesInspection, type CurvesInspection } from './CurvesEditor';
import { curveParameters, toCurvesEditorDraft as toCurvesDraft, parseCurvesEditorDraft as parseCurvesDraft, resetCurvesEditorDraft, supportsCurveBanks, supportsCurves, curvesCapabilityKey, curveCommandParameters } from './curves';
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, CircleAlert, Crosshair, FlipHorizontal2, FlipVertical2, LineChart, LoaderCircle, Paintbrush, Plus, RotateCcw, SlidersHorizontal, Trash2, Type } from 'lucide-react';
import { command, maskSource, isPositionedMask, type Backend, type ChannelMixerParameters, type GradientMapParameters, type Document, type Histogram, type Layer, type LevelsParameters, type Mask } from './api';
import type { RunCommand } from './CanvasTools';
import { MaskEdges } from './MaskEdges';
import { MaskDensity } from './MaskDensity';
import { MaskPosition } from './MaskPosition';
import { captureGesture, type GestureContext } from './gesture';
import { TonalColorControl, isTonalKind, parseTonalDraft, toTonalDraft, tonalParameters, tonalValidationMessage } from './TonalColorControls';
import { ChannelMixerControl, GradientMapControl, MIXER_DEFAULT, GRADIENT_MAP_DEFAULT, mappingLabel, validColorMapping } from './ColorMappingControls';

export const LEVELS_DEFAULT: LevelsParameters = { black: 0, white: 255, gamma: 1, outputBlack: 0, outputWhite: 255 };
export { CURVES_DEFAULT } from './curves';
export { CurvesControl } from './CurvesControl';
type ScalarAdjustment = { id: string; label: string; min: number; max: number; step: number; unit: string; initial?: number; nativeOnly?: boolean };
export const SCALAR_ADJUSTMENTS: ScalarAdjustment[] = [
  { id: 'exposure', label: 'Exposure', min: -5, max: 5, step: 0.1, unit: 'EV' },
  { id: 'brightness', label: 'Brightness', min: -100, max: 100, step: 1, unit: '' },
  { id: 'contrast', label: 'Contrast', min: -100, max: 100, step: 1, unit: '' },
  { id: 'saturation', label: 'Saturation', min: -100, max: 100, step: 1, unit: '' },
  { id: 'vibrance', label: 'Vibrance', min: -100, max: 100, step: 1, unit: '' },
  { id: 'temperature', label: 'Temperature', min: -100, max: 100, step: 1, unit: '' },
  { id: 'hue', label: 'Hue', min: -180, max: 180, step: 1, unit: '°' },
  { id: 'highlights', label: 'Highlights', min: -100, max: 100, step: 1, unit: '' },
  { id: 'shadows', label: 'Shadows', min: -100, max: 100, step: 1, unit: '' },
  { id: 'blur', label: 'Gaussian blur', min: 0, max: 50, step: 0.5, unit: 'px' },
  { id: 'sharpen', label: 'Sharpen', min: 0, max: 10, step: 0.1, unit: '' },
  { id: 'invert', label: 'Invert', min: 0, max: 100, step: 1, unit: '%', initial: 100, nativeOnly: true },
  { id: 'grayscale', label: 'Grayscale', min: 0, max: 100, step: 1, unit: '%', initial: 100, nativeOnly: true },
  { id: 'sepia', label: 'Sepia', min: 0, max: 100, step: 1, unit: '%', initial: 60, nativeOnly: true },
  { id: 'posterize', label: 'Posterize', min: 2, max: 256, step: 1, unit: ' levels', initial: 6, nativeOnly: true },
  { id: 'threshold', label: 'Threshold', min: 0, max: 255, step: 1, unit: '', initial: 128, nativeOnly: true },
  { id: 'median', label: 'Median', min: 1, max: 15, step: 2, unit: ' px', initial: 3, nativeOnly: true },
  { id: 'mosaic', label: 'Mosaic', min: 1, max: 128, step: 1, unit: ' px', initial: 8, nativeOnly: true },
];
export function validAdjustmentValue(definition: ScalarAdjustment, value: number) {
  const step = (value - definition.min) / definition.step;
  return Number.isFinite(value) && value >= definition.min && value <= definition.max && Math.abs(step - Math.round(step)) < 0.000001;
}

function useHistogram(document: Document, enabled = true) {
  const [histogram, setHistogram] = useState<Histogram | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!enabled) { setHistogram(null); setLoading(false); setError(''); return; }
    let active = true; setLoading(true); setError('');
    void command<Histogram>(document.backend, 'get_histogram', { documentId: document.id }).then((result) => { if (active) setHistogram(result); }).catch((reason) => { if (active) setError(reason.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [document.id, document.revision, document.backend, enabled]);
  return { histogram, loading, error };
}

function histogramPath(values: number[], height = 100) {
  const max = Math.max(1, ...values);
  return `M0 ${height} ${values.map((value, x) => `L${x} ${height - Math.sqrt(value / max) * (height - 3)}`).join(' ')} L255 ${height} Z`;
}

export function HistogramView({ histogram, loading, error, compact = false }: { histogram: Histogram | null; loading?: boolean; error?: string; compact?: boolean }) {
  return <div className={`histogram-panel ${compact ? 'compact' : ''}`}>
    <div className="histogram-label"><span>Composite histogram</span>{loading ? <LoaderCircle size={11} className="spin" /> : <span>{histogram ? `${histogram.pixelCount.toLocaleString()} px` : '—'}</span>}</div>
    <svg className="histogram-graph" viewBox="0 0 255 100" preserveAspectRatio="none" role="img" aria-label="Histogram of actual composite pixels">
      <path d="M64 0V100M128 0V100M192 0V100M0 50H255" className="histogram-grid" />
      {histogram && <>{(['red', 'green', 'blue'] as const).map((channel) => <path key={channel} d={histogramPath(histogram[channel])} className={`histogram-${channel}`} />)}<path d={histogramPath(histogram.luminance)} className="histogram-luminance" /></>}
    </svg>
    {error && <span className="inline-panel-error"><CircleAlert size={11} />{error}</span>}
  </div>;
}

export function LevelsControl({ value, onChange }: { value: LevelsParameters; onChange: (parameters: LevelsParameters) => void }) {
  return <div className="levels-controls"><span className="small-section-label">INPUT LEVELS</span><div className="levels-inputs">{([
    ['black', 'Black point', 0, 254, 1], ['gamma', 'Midtone gamma', 0.1, 10, 0.05], ['white', 'White point', 1, 255, 1],
  ] as const).map(([key, label, min, max, step]) => <label key={key}><span className={`tone-dot ${key}`} />{label}<input aria-label={label} type="number" min={min} max={max} step={step} value={value[key]} onChange={(event) => onChange({ ...value, [key]: Number(event.target.value) })} /></label>)}</div><div className="levels-ramp" /><span className="small-section-label">OUTPUT LEVELS</span><div className="levels-output"><label>Black<input aria-label="Output black" type="number" min="0" max="255" value={value.outputBlack} onChange={(event) => onChange({ ...value, outputBlack: Number(event.target.value) })} /></label><label>White<input aria-label="Output white" type="number" min="0" max="255" value={value.outputWhite} onChange={(event) => onChange({ ...value, outputWhite: Number(event.target.value) })} /></label></div></div>;
}

export const PARAMETERIZED_COLOR_KINDS = ['levels', 'curves', 'channel_mixer', 'gradient_map', 'color_balance', 'black_white', 'selective_color', 'hue_saturation', 'photo_filter'];
type ColorWorkbenchProps = { document: Document; layer?: Layer; selectedLayerId?: string; capabilities?: Backend; busy: boolean; run: RunCommand; kinds?: string[] };
export function ColorWorkbench(props: ColorWorkbenchProps) {
  const { document, layer, kinds, capabilities, selectedLayerId } = props;
  const identity = `${document.backend}:${document.id}:${layer?.id || 'new'}`;
  const curveInspection = useRef({ identity, value: createCurvesInspection() });
  if (curveInspection.current.identity !== identity) curveInspection.current = { identity, value: createCurvesInspection() };
  const capabilityIdentity = `${denseCapabilityKey(capabilities)}:${identity}:${kinds?.join(',') || 'default'}:${capabilities?.commands.join(',')}:${curvesCapabilityKey(capabilities)}:${selectiveColorCapabilityKey(capabilities)}:${targetedHSLCapabilityKey(capabilities)}:${photoFilterCapabilityKey(capabilities)}`;
  const capabilityEpoch = useRef({ key: capabilityIdentity, epoch: 0 }); if (capabilityEpoch.current.key !== capabilityIdentity) capabilityEpoch.current = { key: capabilityIdentity, epoch: capabilityEpoch.current.epoch + 1 };
  const target = layer?.id || selectedLayerId;
  const acceptedSelection = useRef<{ target?: string; revision: number } | null>(null);
  const execution = useRef({ identity: capabilityIdentity, epoch: 0, target });
  if (execution.current.identity !== capabilityIdentity || execution.current.target !== target) {
    const ownFirstSelection = execution.current.identity === capabilityIdentity && execution.current.target === undefined && acceptedSelection.current?.target === target && acceptedSelection.current?.revision === document.revision;
    execution.current = { identity: capabilityIdentity, epoch: execution.current.epoch + (ownFirstSelection ? 0 : 1), target };
    acceptedSelection.current = null;
  }
  const latestIdentity = useRef(identity); latestIdentity.current = identity;
  const latestKind = useRef('');
  const draftCapabilities = useRef(capabilityIdentity), legacyDraftEpoch = useRef(0);
  if (draftCapabilities.current !== capabilityIdentity) { if (!isPreciseColorKind(latestKind.current)) legacyDraftEpoch.current++; draftCapabilities.current = capabilityIdentity; }
  const alive = useRef(true); useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const context = (kind: string): GestureContext => {
    const capturedEpoch = execution.current.epoch, capturedCapabilityEpoch = capabilityEpoch.current.epoch;
    return { ...captureGesture(document, target), ...(isPreciseColorKind(kind) ? { preciseColor: { acceptDocument: (result: Document) => {
      if (result.id !== document.id || result.backend !== document.backend || result.revision !== document.revision + 1) return false;
      if (!layer && target === undefined) acceptedSelection.current = { target: displayLayers(result)[0]?.id, revision: result.revision };
      return true;
    } } } : {}), isCurrent: () => alive.current && latestIdentity.current === identity && latestKind.current === kind && (isPreciseColorKind(kind) ? execution.current.epoch === capturedEpoch : capabilityEpoch.current.epoch === capturedCapabilityEpoch) };
  };
  return <ColorWorkbenchEditor key={`${identity}:${document.revision}:${selectedLayerId || 'none'}:${legacyDraftEpoch.current}`} {...props} curveInspection={curveInspection.current.value} captureContext={context} initialKind={latestKind.current} reportKind={kind => { if (latestKind.current !== kind) { latestKind.current = kind; execution.current.epoch++; } }} />;
}
function ColorWorkbenchEditor({ document, layer, capabilities, busy, run, kinds = ['levels', 'curves'], captureContext, reportKind, initialKind, curveInspection }: ColorWorkbenchProps & { curveInspection: CurvesInspection; captureContext: (kind: string) => GestureContext; initialKind: string; reportKind: (kind: string) => void }) {
  const available = PARAMETERIZED_COLOR_KINDS.filter(kind => kinds.includes(kind) && (kind !== 'photo_filter' || supportsPhotoFilter(capabilities, document.backend, 'global')) && (kind !== 'selective_color' || supportsSelectiveColor(capabilities, document.backend, 'global')) && (kind !== 'hue_saturation' || supportsTargetedHSL(capabilities, document.backend, 'global')));
  const editing = layer?.type === 'adjustment' && PARAMETERIZED_COLOR_KINDS.includes(layer.kind || '');
  const [kind, setKind] = useState(editing ? layer.kind! : available.includes(initialKind) ? initialKind : available[0] || 'levels');
  reportKind(kind);
  const [levels, setLevels] = useState<LevelsParameters>(() => structuredClone({ ...LEVELS_DEFAULT, ...(editing && layer.kind === 'levels' ? layer.parameters : {}) }));
  const [curves, setCurves] = useState(() => toCurvesDraft(editing && layer.kind === 'curves' ? layer.parameters : undefined));
  const [selective, setSelective] = useState(() => toSelectiveColorDraft(editing && layer.kind === 'selective_color' ? layer.parameters : undefined));
  const [photo, setPhoto] = useState<PhotoFilterDraft>(() => toPhotoFilterDraft(editing && layer.kind === 'photo_filter' ? layer.parameters : undefined));
  const [hsl, setHsl] = useState(() => toTargetedHSLDraft(editing && layer.kind === 'hue_saturation' ? layer.parameters : undefined));
  const [curveDragging, setCurveDragging] = useState(false);
  const savedCurveSupported = !editing || layer.kind !== 'curves' || supportsCurves(capabilities, document.backend, layer.parameters, 'global');
  const smoothSupported = supportsCurves(capabilities, document.backend, { interpolation: 'smooth' }, 'global');
  const bankSupported = supportsCurveBanks(capabilities, document.backend, 'global');
  const bankedDraftSupported = curves.mode !== 'banks' || supportsCurves(capabilities, document.backend, curves, 'global');
  const [mixer, setMixer] = useState<ChannelMixerParameters>(() => structuredClone({ ...MIXER_DEFAULT, ...(editing && layer.kind === 'channel_mixer' ? layer.parameters : {}) }));
  const [gradient, setGradient] = useState<GradientMapParameters>(() => structuredClone({ ...GRADIENT_MAP_DEFAULT, ...(editing && layer.kind === 'gradient_map' ? layer.parameters : {}) }));
  const [balance, setBalance] = useState(() => toTonalDraft('color_balance', editing && layer.kind === 'color_balance' ? layer.parameters : undefined));
  const [blackWhite, setBlackWhite] = useState(() => toTonalDraft('black_white', editing && layer.kind === 'black_white' ? layer.parameters : undefined));
  const can = (name: string) => capabilities ? capabilities.id === document.backend && capabilities.commands.includes(name) : true;
  const hasHistogram = can('get_histogram');
  const { histogram, loading, error } = useHistogram(document, hasHistogram);
  const tonal = kind === 'color_balance' ? balance : blackWhite;
  const parameters = kind === 'photo_filter' ? parsePhotoFilterDraft(photo) : kind === 'hue_saturation' ? parseTargetedHSLDraft(hsl) : kind === 'selective_color' ? parseSelectiveColorDraft(selective) : kind === 'levels' ? levels : kind === 'curves' ? parseCurvesDraft(curves) : kind === 'channel_mixer' ? mixer : kind === 'gradient_map' ? gradient : parseTonalDraft(tonal);
  const valid = available.includes(kind) && (kind === 'photo_filter' || kind === 'selective_color' || kind === 'hue_saturation' ? Boolean(parameters) : isTonalKind(kind) ? Boolean(parameters) : kind === 'curves' ? Boolean(parameters) && !curveDragging && savedCurveSupported && supportsCurves(capabilities, document.backend, parameters, 'global') : kind === 'levels' ? [levels.black, levels.white, levels.gamma, levels.outputBlack, levels.outputWhite].every(Number.isFinite) && levels.black >= 0 && levels.black <= 254 && levels.white >= 1 && levels.white <= 255 && levels.black < levels.white && levels.outputBlack >= 0 && levels.outputWhite <= 255 && levels.outputBlack <= levels.outputWhite && levels.gamma >= .1 && levels.gamma <= 10 : validColorMapping(kind, parameters));
  const unchanged = Boolean(editing && (isTonalKind(kind) || isPreciseColorKind(kind)) && parameters && JSON.stringify(parameters) === JSON.stringify(kind === 'photo_filter' ? photoFilterParameters(layer.parameters) : kind === 'hue_saturation' ? targetedHSLParameters(layer.parameters) : kind === 'selective_color' ? selectiveColorParameters(layer.parameters) : kind === 'curves' ? curveParameters(layer.parameters) : tonalParameters(kind, layer.parameters)));
  const display = mappingLabel(kind);
  const reset = () => { if (kind === 'photo_filter') setPhoto(toPhotoFilterDraft()); else if (kind === 'hue_saturation') setHsl(toTargetedHSLDraft()); else if (kind === 'selective_color') setSelective(toSelectiveColorDraft()); else if (kind === 'levels') setLevels(structuredClone(LEVELS_DEFAULT)); else if (kind === 'curves') setCurves(resetCurvesEditorDraft(curves)); else if (kind === 'channel_mixer') setMixer(structuredClone(MIXER_DEFAULT)); else if (kind === 'gradient_map') setGradient(structuredClone(GRADIENT_MAP_DEFAULT)); else if (kind === 'color_balance') setBalance(toTonalDraft('color_balance')); else setBlackWhite(toTonalDraft('black_white')); };
  const permitted = can(editing ? 'update_adjustment' : 'add_adjustment');
  const submit = () => { if (busy || !valid || unchanged || !permitted) return; void run(editing ? 'update_adjustment' : 'add_adjustment', { ...(editing ? { layerId: layer!.id } : { kind }), value: 0, parameters: kind === 'curves' ? curveCommandParameters(parameters as ReturnType<typeof curveParameters>, editing ? layer?.parameters : undefined) : parameters }, `${editing ? 'Updating' : 'Adding'} ${display}`, captureContext(kind)); };
  return <div className="color-workbench">{hasHistogram && <HistogramView histogram={histogram} loading={loading} error={error} />}<fieldset className="color-workbench-fieldset" disabled={busy && kind !== 'hue_saturation' && kind !== 'selective_color' && !(kind === 'curves' && curves.mode === 'banks')}>
    <div className={`color-mode-tabs ${available.length > 2 ? 'mapping-modes' : ''}`}>{available.map(mode => <button type="button" key={mode} className={kind === mode ? 'selected' : ''} disabled={busy || Boolean(editing && layer?.kind !== mode)} onClick={() => setKind(mode)}>{mode === 'curves' ? <LineChart size={13} /> : <SlidersHorizontal size={13} />}{mode === 'levels' ? 'Levels' : mode === 'curves' ? 'Curves' : mappingLabel(mode)}</button>)}</div>
    {!available.includes(kind) && !isPreciseColorKind(kind) ? <p className="tonal-unavailable">This companion does not advertise {display}. Its saved settings remain unchanged.</p> : kind === 'photo_filter' ? <PhotoFilterControls draft={photo} onChange={setPhoto} disabled={busy || !available.includes(kind)} /> : kind === 'hue_saturation' ? <TargetedHSLControls draft={hsl} onChange={setHsl} disabled={busy || !available.includes(kind)} /> : kind === 'selective_color' ? <SelectiveColorControls draft={selective} onChange={setSelective} disabled={busy || !available.includes(kind)} /> : kind === 'levels' ? <LevelsControl value={levels} onChange={setLevels} /> : kind === 'curves' ? <CurvesEditor draft={curves} inspection={curveInspection} bankSupported={bankSupported} onChange={setCurves} histogram={histogram} disabled={busy || !savedCurveSupported || !bankedDraftSupported || !available.includes(kind)} smoothSupported={smoothSupported} contextKey={`${document.backend}:${document.id}:${layer?.id || 'new'}:${document.revision}:${curvesCapabilityKey(capabilities)}:${capabilities?.commands.join(',')}`} sessionKey={`${document.backend}:${document.id}:${layer?.id || 'new'}:${document.revision}`} onDragging={setCurveDragging} /> : kind === 'channel_mixer' ? <ChannelMixerControl value={mixer} onChange={setMixer} /> : kind === 'gradient_map' ? <GradientMapControl value={gradient} onChange={setGradient} /> : <TonalColorControl draft={tonal} onChange={kind === 'color_balance' ? setBalance : setBlackWhite} />}
    {kind === 'photo_filter' && !available.includes(kind) && <p className="tonal-unavailable">This companion does not advertise the native Photo Filter policy. Saved settings remain unchanged.</p>}
    {kind === 'hue_saturation' && !available.includes(kind) && <p className="tonal-unavailable">This companion does not advertise the complete native Hue / Saturation policy and ranges. Saved settings remain unchanged.</p>}
    {kind === 'selective_color' && !available.includes(kind) && <p className="tonal-unavailable">This companion does not advertise the complete native Selective Color policy, methods and ranges. Saved settings remain unchanged.</p>}
    {!valid && available.includes(kind) && <p className="inline-panel-error">{kind === 'photo_filter' ? 'Use a six-digit #rrggbb color and Density 0–100% in exact 0.01% increments.' : kind === 'hue_saturation' ? 'Complete every range using Hue −180 to 180°, Saturation and Lightness −100 to 100%, in exact 0.01 increments.' : kind === 'selective_color' ? 'Complete every range using −100 to 100% in exact 0.01% increments.' : isTonalKind(kind) ? tonalValidationMessage(kind) : kind === 'channel_mixer' ? 'Use −200 to 200%, in exact 0.01% increments, for every row.' : kind === 'gradient_map' ? 'Stops must increase strictly from 0% to 100%, with 2–16 colors.' : kind === 'curves' ? 'Review the curve point values and interpolation support before applying.' : 'Use valid input and output levels; black must not exceed white.'}</p>}
    <p className="property-hint">{editing ? 'Updates this adjustment layer; its mask stays attached.' : document.selection ? 'Creates an editable adjustment using the active selection as its mask.' : 'Creates an editable adjustment for the entire canvas.'}</p>
    {!permitted && <p className="property-hint">This companion cannot {editing ? 'update' : 'add'} adjustment layers.</p>}
    <div className="workbench-actions"><button type="button" className="icon-button" aria-label={`Reset ${display}`} disabled={busy || !available.includes(kind) || kind === 'curves' && (!savedCurveSupported || !bankedDraftSupported || curveDragging)} onClick={reset}><RotateCcw size={13} /></button><button type="button" className="button secondary" disabled={busy || !valid || unchanged || !permitted} onClick={submit}>{editing ? <Check size={13} /> : <Plus size={13} />}{editing ? `Update ${display}` : `Add ${display} layer`}</button></div>
  </fieldset></div>;
}

export function AdjustmentProperties({ document, layer, busy, run, kinds, capabilities }: { document: Document; layer: Layer; busy: boolean; run: RunCommand; kinds?: string[]; capabilities?: Backend }) {
  const definition = SCALAR_ADJUSTMENTS.find((item) => item.id === layer.kind);
  const [value, setValue] = useState(layer.value || 0);
  useEffect(() => setValue(layer.value || 0), [layer.id, layer.value]);
  const valid = !definition || validAdjustmentValue(definition, value);
  return <div className="panel-section editable-adjustment"><div className="section-heading"><span>Edit adjustment</span><SlidersHorizontal size={14} /></div>{layer.kind === 'color_lookup' ? <ColorLookup key={`${document.backend}:${document.id}:${layer.id}`} document={document} capabilities={capabilities} scope="global" layer={layer} busy={busy} run={run} /> : PARAMETERIZED_COLOR_KINDS.includes(layer.kind || '') ? <ColorWorkbench document={document} layer={layer} capabilities={capabilities} busy={busy} run={run} kinds={kinds} /> : definition ? <><div className="editable-adjustment-value"><span>{definition.label}</span><input aria-label={`Edit ${definition.label}`} type="number" min={definition.min} max={definition.max} step={definition.step} value={value} onChange={(event) => setValue(Number(event.target.value))} /><span>{definition.unit}</span></div><input aria-label={`${definition.label} amount`} type="range" min={definition.min} max={definition.max} step={definition.step} value={value} onChange={(event) => setValue(Number(event.target.value))} /><button className="button secondary wide" disabled={busy || !valid || value === layer.value} onClick={() => void run('update_adjustment', { layerId: layer.id, value }, 'Updating adjustment')}><Check size={13} />Update adjustment</button>{!valid && <p className="inline-panel-error">Use {definition.min}–{definition.max} in steps of {definition.step}.</p>}<p className="property-hint">{definition.nativeOnly ? 'Prism Native · ' : ''}Updates this layer. Your mask stays attached.</p></> : <p className="property-hint">This adjustment is not editable in the current engine.</p>}</div>;
}

function LayerMaskFeather({ layer, busy, run }: { layer: Layer; busy: boolean; run: RunCommand }) {
  const [feather, setFeather] = useState(layer.mask ? maskSource(layer.mask).feather || 0 : 0);
  return <div className="mask-feather-control"><label>Feather<input aria-label="Layer mask feather" type="number" min="0" max="100" value={feather} disabled={busy} onChange={event => setFeather(Math.max(0, Math.min(100, Number(event.target.value))))} /><span>px</span></label><button className="button mini subtle" disabled={busy} onClick={() => void run('modify_layer_mask', { layerId: layer.id, feather }, 'Refining layer mask')}>Apply</button></div>;
}

export function LayerMaskProperties({ document, capabilities, layer, selection, busy, run, morphologyOperations = [], maxMorphologyRadius, maskProperties = [], contextKey, onInspect, onPaint }: { document: Document; capabilities?: Backend; layer: Layer; selection: Mask | null; busy: boolean; run: RunCommand; morphologyOperations?: string[]; maxMorphologyRadius?: number; maskProperties?: string[]; contextKey?: string; onInspect?: () => void; onPaint?: () => void }) {
  const source = layer.mask ? maskSource(layer.mask) : null;
  const positioned = isPositionedMask(layer.mask);
  const can = (name: string) => Boolean(capabilities?.commands.includes(name));
  const denseSupported = supportsMask(layer.mask, capabilities);
  const propertySupported = (name: string) => denseSupported && can('modify_layer_mask') && (capabilities?.layerMaskProperties === undefined || capabilities.layerMaskProperties.includes(name));
  const capturedRun: RunCommand = (name, args, label) => run(name, args, label, captureGesture(document, layer.id));
  return <div className="panel-section layer-mask-properties" tabIndex={-1}>
    <div className="section-heading"><span>Layer mask</span>{positioned && <span className="mask-position-badge">Positioned</span>}<Crosshair size={14} /></div>
    <p className="property-hint">{source ? `${maskShapeLabel(source)}${source.invert ? ' · inverted' : ''}. The original pixels are preserved.` : 'Use a selection to show only part of this layer.'}</p>
    {onInspect && <button className="button subtle wide mask-inspection-entry" disabled={!layer.mask || busy} onClick={onInspect}>Inspect coverage</button>}
    {can('mask_from_selection') && <button className="button secondary wide" disabled={!selection || busy || !supportsMask(selection, capabilities)} onClick={() => selection && void capturedRun('mask_from_selection', { layerId: layer.id }, 'Applying layer mask')}><Plus size={12} />{layer.mask ? 'Replace mask from selection' : 'Mask from selection'}</button>}
    {onPaint && can('paint_mask') && <button className="button subtle wide mask-paint-entry" disabled={busy || Boolean(layer.mask && !denseSupported)} onClick={onPaint}><Paintbrush size={12} />{layer.mask ? 'Paint mask' : 'Paint new mask'}</button>}
    {layer.mask && <>
      <MaskPosition key={`position:${contextKey}`} document={document} layer={layer} capabilities={capabilities} busy={busy || !denseSupported} run={run} />
      {denseSupported && maskProperties.includes('density') && <MaskDensity key={`${contextKey}:${layer.id}:${layer.maskDensity ?? 1}`} layer={layer} busy={busy} run={capturedRun} />}
      {propertySupported('feather') && <LayerMaskFeather key={`feather:${contextKey}`} layer={layer} busy={busy} run={capturedRun} />}
      {propertySupported('invert') && <div className="mask-actions"><button className="button mini subtle" disabled={busy} onClick={() => void capturedRun('modify_layer_mask', { layerId: layer.id, invert: !source?.invert }, 'Inverting mask')}>Invert mask</button></div>}
      <MaskEdges key={layer.id} layerId={layer.id} exists={true} positioned={positioned} busy={busy || !denseSupported} operations={morphologyOperations} maxRadius={maxMorphologyRadius} run={capturedRun} />
      {(source?.shape === 'bitmap' || source?.shape === 'alpha8') && <p className="property-hint">Pixel mask. Use the mask brush to refine coverage.</p>}
      {can('set_layer_mask') && <div className="mask-actions"><button className="button mini subtle" disabled={busy} onClick={() => void capturedRun('set_layer_mask', { layerId: layer.id, mask: null }, 'Removing mask')}><Trash2 size={12} />Remove</button></div>}
    </>}
  </div>;
}

export function TransformForm({ layer, busy, run, onComplete }: { layer: Layer; busy: boolean; run: RunCommand; onComplete: () => void }) {
  const [x, setX] = useState(0), [y, setY] = useState(0), [scaleX, setScaleX] = useState(100), [scaleY, setScaleY] = useState(100), [rotation, setRotation] = useState(0);
  const [flipX, setFlipX] = useState(false), [flipY, setFlipY] = useState(false);
  return <><span className="eyebrow">A NEW PERSPECTIVE</span><h1 id="modal-title">Transform your layer.</h1><p className="modal-intro">Move, scale, and rotate “{layer.name}”. Scale and rotation use the canvas center. Content outside the canvas is clipped; undo restores it.</p><form onSubmit={(event) => { event.preventDefault(); void run('transform_layer', { layerId: layer.id, x, y, scaleX: scaleX / 100, scaleY: scaleY / 100, rotation, flipX, flipY }, 'Transforming layer').then((result) => { if (result) onComplete(); }); }}><div className="form-grid"><label className="field-label">Move horizontally, px<input aria-label="Transform X" required type="number" value={x} onChange={(event) => setX(Number(event.target.value))} /></label><label className="field-label">Move vertically, px<input aria-label="Transform Y" required type="number" value={y} onChange={(event) => setY(Number(event.target.value))} /></label><label className="field-label">Scale width, %<input aria-label="Transform width scale" required type="number" min="5" max="800" value={scaleX} onChange={(event) => setScaleX(Number(event.target.value))} /></label><label className="field-label">Scale height, %<input aria-label="Transform height scale" required type="number" min="5" max="800" value={scaleY} onChange={(event) => setScaleY(Number(event.target.value))} /></label></div><label className="field-label">Rotation · {rotation}°<input aria-label="Transform rotation" type="range" min="-180" max="180" value={rotation} onChange={(event) => setRotation(Number(event.target.value))} /></label><div className="transform-flips"><label><input type="checkbox" checked={flipX} onChange={(event) => setFlipX(event.target.checked)} /><FlipHorizontal2 size={15} />Flip horizontal</label><label><input type="checkbox" checked={flipY} onChange={(event) => setFlipY(event.target.checked)} /><FlipVertical2 size={15} />Flip vertical</label></div><button className="button primary wide" disabled={busy} type="submit"><Check size={15} />Apply layer transform</button></form></>;
}
