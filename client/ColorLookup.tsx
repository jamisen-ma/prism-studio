import { denseCapabilityKey, supportsMask } from './dense-mask';
import { useEffect, useRef, useState } from 'react';
import { Check, FileUp, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { fileBase64, type Backend, type Document, type Layer, type LayerFilter } from './api';
import type { RunCommand } from './CanvasTools';
import { captureGesture, type GestureContext } from './gesture';
import { colorLookupCapabilityKey, colorLookupFileError, lookupParameters, supportsColorLookup, supportsLookupEntry, type LookupScope } from './color-lookup';
import './color-lookup.css';

type FileDraft = { id: number; file: File; revision: number; interpretation: '' | 'srgb'; uncertain?: boolean };
type Props = { document: Document; capabilities?: Backend; scope: LookupScope; layer?: Layer; filter?: LayerFilter; selectedLayerId?: string; busy: boolean; run: RunCommand; settingsDirty?: boolean; blocked?: boolean; supportKey?: string; onReviewChange?: (reviewing: boolean) => void; onImported?: (filterId: string) => void };
const DEFINITE_REJECTIONS = new Set(['INVALID_ARGUMENT', 'INVALID_ARGUMENTS', 'INVALID_COLOR_LOOKUP', 'INVALID_LUT', 'LIMIT_EXCEEDED', 'PROTECTED_LAYER', 'INVALID_TARGET', 'NOT_FOUND', 'REVISION_CONFLICT']);

export function ColorLookup(props: Props) {
  const { document, capabilities, scope, layer, filter, selectedLayerId, busy, run, settingsDirty = false, blocked = false } = props;
  const saved = lookupParameters(scope === 'source' ? filter?.parameters : layer?.parameters);
  const replacing = scope === 'source' ? Boolean(filter) : Boolean(layer);
  const target = layer?.id || selectedLayerId;
  const identity = `${document.backend}:${document.id}:${scope}:${layer?.id || 'new'}:${filter?.id || 'new'}`;
  const capabilitiesKey = `${denseCapabilityKey(capabilities)}:${colorLookupCapabilityKey(capabilities)}:${props.supportKey || ''}`;
  const [draft, setDraft] = useState<FileDraft | null>(null), [working, setWorking] = useState(false), [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null), sequence = useRef(0), choice = useRef<{ epoch: number; revision: number } | null>(null), locked = useRef(false), alive = useRef(true);
  const latest = useRef(props); latest.current = props;
  const draftRef = useRef(draft); draftRef.current = draft;
  const ownSelection = useRef<{ id: string; revision: number } | null>(null);
  const execution = useRef({ identity, capabilitiesKey, target, epoch: 0 });
  if (execution.current.identity !== identity || execution.current.capabilitiesKey !== capabilitiesKey || execution.current.target !== target) {
    const ownFirst = execution.current.identity === identity && execution.current.capabilitiesKey === capabilitiesKey && ownSelection.current?.id === target && ownSelection.current?.revision === document.revision;
    execution.current = { identity, capabilitiesKey, target, epoch: execution.current.epoch + (ownFirst ? 0 : 1) };
    ownSelection.current = null;
  }
  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++; latest.current.onReviewChange?.(false); }; }, []);
  const supported = supportsColorLookup(capabilities, document.backend, scope);
  const savedSupported = !replacing || supportsLookupEntry(capabilities, document.backend, scope, scope === 'source' ? filter?.parameters : layer?.parameters);
  const canImport = supported && savedSupported && capabilities?.commands.includes('import_color_lookup') === true;
  const denseSelection = scope === 'global' && !layer && document.selection && 'shape' in document.selection ? document.selection : null;
  const unavailable = !supportsMask(denseSelection, capabilities) || busy || working || blocked || Boolean(layer?.protected) || settingsDirty || !canImport;
  const stale = Boolean(draft && draft.revision !== document.revision);
  const updateDraft = (next: FileDraft | null) => { draftRef.current = next; setDraft(next); props.onReviewChange?.(Boolean(next)); };
  const current = (epoch: number) => alive.current && execution.current.epoch === epoch;
  const choose = () => {
    if (unavailable || locked.current) return;
    choice.current = { epoch: execution.current.epoch, revision: document.revision };
    input.current?.click();
  };
  const picked = (file?: File) => {
    const captured = choice.current; choice.current = null;
    if (!file || !captured || !current(captured.epoch) || latest.current.document.revision !== captured.revision || locked.current) return;
    const problem = colorLookupFileError(file, latest.current.capabilities);
    if (problem) { setError(problem); return; }
    updateDraft({ id: ++sequence.current, file, revision: captured.revision, interpretation: '' }); setError('');
  };
  const discard = () => { if (locked.current || draftRef.current?.uncertain) return; sequence.current++; choice.current = null; updateDraft(null); setError(''); };
  const review = async () => {
    if (locked.current || busy || !draft || !capabilities?.commands.includes('get_document')) return;
    const epoch = execution.current.epoch, savedDraft = draft, reviewDocument = document;
    locked.current = true; setWorking(true); setError('');
    const context: GestureContext = { ...captureGesture(reviewDocument, target), isCurrent: () => current(epoch), lookup: {
      requestId: crypto.randomUUID(),
      acceptResult: result => result.document?.id === reviewDocument.id && result.document.backend === reviewDocument.backend && result.document.revision >= reviewDocument.revision,
      onFailure: failure => { if (current(epoch)) setError(failure.message); },
    } };
    try {
      const result = await run('get_document', {}, 'Reviewing lookup target', context);
      if (result?.document && current(epoch) && draftRef.current?.id === savedDraft.id) {
        updateDraft({ ...savedDraft, revision: result.document.revision, uncertain: false });
        setError('Current target refreshed. Review its saved lookup and layers before deliberately applying this file.');
      }
    } finally { locked.current = false; if (alive.current) setWorking(false); }
  };
  const apply = async () => {
    if (unavailable || locked.current || !draft || draft.interpretation !== 'srgb' || stale || draft.uncertain) return;
    const captured = draft, capturedDocument = document, epoch = execution.current.epoch, requestId = crypto.randomUUID();
    const existingLayers = new Set(document.layers.map(item => item.id)), existingFilters = new Set(layer?.filters?.map(item => item.id));
    let dispatched = false, failed = false;
    locked.current = true; setWorking(true); setError('');
    const owned = () => current(epoch) && draftRef.current?.id === captured.id;
    const context: GestureContext = { ...captureGesture(capturedDocument, target), preciseColor: {}, isCurrent: owned, lookup: {
      requestId,
      onDispatch: () => { if (!owned() || latest.current.document.revision !== captured.revision) return false; dispatched = true; updateDraft({ ...captured, uncertain: true }); return true; },
      acceptResult: result => {
        if (!owned() || !result.document || result.document.id !== capturedDocument.id || result.document.backend !== capturedDocument.backend || result.document.revision !== captured.revision + 1 || !result.layerId) return false;
        const resultLayer = result.document.layers.find(item => item.id === result.layerId);
        const resultFilter = resultLayer?.filters?.find(item => item.id === result.filterId);
        if (scope === 'global' ? !resultLayer || resultLayer.type !== 'adjustment' || resultLayer.kind !== 'color_lookup' || result.filterId !== undefined || (replacing ? result.layerId !== layer?.id : existingLayers.has(result.layerId)) : result.layerId !== layer?.id || !resultFilter || resultFilter.kind !== 'color_lookup' || (replacing ? result.filterId !== filter?.id : existingFilters.has(result.filterId!))) return false;
        const descriptor = lookupParameters(scope === 'global' ? resultLayer?.parameters : resultFilter?.parameters);
        if (!descriptor || !supportsLookupEntry(latest.current.capabilities, capturedDocument.backend, scope, descriptor) || descriptor.bytes !== captured.file.size || descriptor.sourceName !== captured.file.name || descriptor.inputSpace !== 'srgb') return false;
        if (scope === 'global' && !replacing) ownSelection.current = { id: result.layerId, revision: result.document.revision };
        return true;
      },
      onFailure: failure => {
        if (!owned()) return;
        failed = true;
        const uncertain = dispatched && !DEFINITE_REJECTIONS.has(failure.code || '');
        updateDraft({ ...captured, uncertain });
        setError(uncertain ? 'The reply or preview could not be confirmed. Refresh this target and inspect its layers before applying another lookup.' : failure.message);
      },
    } };
    try {
      const data = await fileBase64(captured.file);
      if (!owned() || latest.current.document.revision !== captured.revision || colorLookupFileError(captured.file, latest.current.capabilities)) return;
      const result = await run('import_color_lookup', { target: scope === 'global' ? 'adjustment' : 'layer-filter', ...(layer ? { layerId: layer.id } : {}), ...(filter ? { filterId: filter.id } : {}), data, sourceName: captured.file.name, inputSpace: 'srgb' }, replacing ? 'Replacing Color Lookup' : 'Importing Color Lookup', context);
      if (!owned()) return;
      if (result?.document) { updateDraft(null); setError(''); if (scope === 'source' && result.filterId) props.onImported?.(result.filterId); }
      else if (dispatched && !failed) { updateDraft({ ...captured, uncertain: true }); setError('The result belongs to an earlier context. Refresh and inspect this target before applying another lookup.'); }
    } catch (failure) { if (owned()) setError(failure instanceof Error ? failure.message : 'The file could not be read.'); }
    finally { locked.current = false; if (alive.current) setWorking(false); }
  };
  return <section className="color-lookup" aria-label={scope === 'global' ? 'Global Color Lookup' : 'Source Color Lookup'}>
    <div className="section-heading"><span>Color Lookup</span><FileUp size={14} /></div>
    {saved && <dl className="lookup-metadata"><div><dt>File</dt><dd>{saved.sourceName}</dd></div>{saved.title !== undefined && <div><dt>Title</dt><dd>{saved.title || '(empty title)'}</dd></div>}<div><dt>Grid</dt><dd>{saved.gridSize} × {saved.gridSize} × {saved.gridSize}</dd></div><div><dt>Original</dt><dd>{saved.bytes.toLocaleString()} bytes</dd></div><div><dt>Interpretation</dt><dd>Encoded sRGB · Native trilinear</dd></div></dl>}
    <p className="property-hint">A 3D color lookup changes RGB using the imported file. Transparency is preserved.</p>
    {scope === 'global' && !replacing && <p className="property-hint">{document.selection ? 'The current selection becomes this adjustment’s mask.' : 'Applies to the whole canvas.'}</p>}
    {scope === 'source' && <p className="property-hint">Runs on source RGB in stack order, before transforms. The effect mask mixes the completed stack.</p>}
    <input ref={input} type="file" hidden accept=".cube,text/plain" aria-label="Choose Color Lookup file" onChange={event => { picked(event.target.files?.[0]); event.target.value = ''; }} />
    <button className="button secondary wide" disabled={unavailable || Boolean(draft?.uncertain)} onClick={choose}><FileUp size={13} />{draft ? 'Choose another .cube file' : replacing ? 'Replace .cube file' : 'Choose .cube file'}</button>
    {draft && <div className="lookup-file-draft"><strong>{draft.file.name}</strong><span>{draft.file.size.toLocaleString()} bytes · grid and title checked during import</span><label className="field-label">Input/output interpretation<select aria-label="Color Lookup interpretation" value={draft.interpretation} disabled={unavailable || stale || Boolean(draft.uncertain)} onChange={event => updateDraft({ ...draft, interpretation: event.target.value as '' | 'srgb' })}><option value="">Choose interpretation</option><option value="srgb">Encoded sRGB (0–1)</option></select></label><p>Interpret this file as encoded sRGB. It will be validated when applied.</p>{stale && <p className="lookup-warning">The document changed. Review the current target before applying this file.</p>}<div className="lookup-actions"><button className="button subtle" disabled={working || busy || Boolean(draft.uncertain)} onClick={discard}><X size={12} />Discard file draft</button>{(stale || draft.uncertain) && <button className="button secondary" disabled={working || busy || !capabilities?.commands.includes('get_document')} onClick={() => void review()}><RefreshCw size={12} />Review current target</button>}</div><button className="button primary wide" disabled={unavailable || stale || Boolean(draft.uncertain) || draft.interpretation !== 'srgb'} onClick={() => void apply()}>{working ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}{working ? 'Applying…' : replacing ? 'Replace lookup file' : 'Import Color Lookup'}</button></div>}
    {settingsDirty && <p className="lookup-warning">Apply or reset filter settings before replacing the file.</p>}
    {!canImport && <p className="lookup-warning">{!savedSupported ? 'This saved lookup is not supported by the advertised policy and limits. Its metadata is read-only; supported removal remains available.' : supported ? 'This companion does not advertise lookup-file import or replacement. Saved metadata remains available.' : 'This companion does not advertise the complete native Color Lookup policy and limits. Saved metadata remains available.'}</p>}
    {error && <p className="lookup-warning" role="alert">{error}</p>}
    <details className="lookup-help"><summary>About Color Lookup</summary><p>Accepts 3D .cube grids {capabilities?.colorLookupLimits?.minGridSize || 2}–{capabilities?.colorLookupLimits?.maxGridSize || 33}, a 0–1 domain and 0–1 RGB samples. Larger grids, 1D/shaper combinations and other domains are rejected, without silently changing the table.</p><p>A normalized table may still have been designed for log, HDR or scene-linear input. Its syntax cannot identify that intent. No input/output color conversion occurs; choose a look intended for encoded sRGB or explicitly accept this interpretation.</p><p>Native trilinear evaluation uses the original parsed samples. It does not promise Photoshop pixel parity. The original file travels in editable .prism projects. Recipes cannot carry lookup files yet.</p><p>{replacing ? 'Replacement preserves saved opacity, blending, masks and order. Undo restores the previous file.' : 'Import creates one editable entry and one Undo step.'} Cancelling before Apply writes nothing. After submission, navigation does not undo an accepted import.</p></details>
  </section>;
}
