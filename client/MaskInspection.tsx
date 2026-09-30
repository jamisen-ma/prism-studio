import { capabilityStrings, denseCapabilityKey, isDenseMask, supportsMask } from './dense-mask';
import { useEffect, useRef, useState } from 'react';
import { CircleAlert, LoaderCircle, RefreshCw, ScanEye } from 'lucide-react';
import { command, type Backend, type BackendId, type Document, type MaskPreview } from './api';
import './mask-inspection.css';
import { filterMaskSupport, filterMaskCapabilityKey, strings } from './filter-mask';
import { filterOpacityPercent } from './filter-blend';

export type MaskInspectionTarget = { backend: 'native'; documentId: string; source: 'selection' | 'layer-mask' | 'filter-mask'; layerId?: string };
type Request = { revision: number; maskMode: 'raw' | 'effective'; maxEdge: number; sequence: number };
type PreviewState = { key: string; image?: MaskPreview; error?: string; stale?: boolean };

function validatePreview(result: MaskPreview, document: Document, target: MaskInspectionTarget, request: Request, maxBytes: number) {
  const sourceLayer = document.layers.find(layer => layer.id === target.layerId);
  const sourceWidth = target.source === 'filter-mask' ? sourceLayer?.filterMask?.sourceWidth : document.width;
  const sourceHeight = target.source === 'filter-mask' ? sourceLayer?.filterMask?.sourceHeight : document.height;
  if (!sourceWidth || !sourceHeight || (target.source === 'filter-mask' && (sourceWidth !== sourceLayer?.width || sourceHeight !== sourceLayer?.height || result.coordinates !== 'source'))) throw Error('The coverage response does not match the retained source frame. Refresh coverage.');
  const longest = Math.max(sourceWidth, sourceHeight);
  const size = (dimension: number) => request.maxEdge >= longest ? dimension : Math.max(1, Math.floor((2 * dimension * request.maxEdge + longest) / (2 * longest)));
  if (result.documentId !== target.documentId || result.revision !== request.revision || result.source !== target.source || result.mimeType !== 'image/png' || result.sampling !== 'nearest-pixel-center' || result.maxEdge !== request.maxEdge || result.sourceWidth !== sourceWidth || result.sourceHeight !== sourceHeight || result.width !== size(sourceWidth) || result.height !== size(sourceHeight) || (target.source !== 'selection' ? result.layerId !== target.layerId || result.maskMode !== request.maskMode : result.layerId !== undefined || result.maskMode !== undefined) || typeof result.data !== 'string' || !result.data.length || result.data.length > Math.ceil(maxBytes / 3) * 4) throw Error('The coverage response does not match this source, revision or preview size. Refresh coverage.');
}

export function MaskInspection({ target, document, backend, selectedLayerId, capabilities, onClose }: { target: MaskInspectionTarget; document: Document; backend: BackendId; selectedLayerId?: string; capabilities: Backend; onClose: () => void }) {
  const maxEdge = Math.min(2400, capabilities.limits?.maxMaskPreviewEdge || 2400);
  const sizes = [...new Set([Math.min(700, maxEdge), Math.min(1400, maxEdge), maxEdge])].filter(value => value >= 32);
  const [edge, setEdge] = useState(sizes[0] || 700), [mode, setMode] = useState<'raw' | 'effective'>(capabilities.maskPreviewMaskModes?.includes('effective') ? 'effective' : 'raw');
  const [localDocument, setLocalDocument] = useState<Document | null>(null);
  const snapshot = localDocument && localDocument.id === document.id && localDocument.revision > document.revision ? localDocument : document;
  const layer = snapshot.layers.find(item => item.id === target.layerId);
  const filterMask = target.source === 'filter-mask';
  const filterSupport = filterMaskSupport(capabilities, backend);
  const selectedMask = target.source === 'selection' ? snapshot.selection && 'shape' in snapshot.selection ? snapshot.selection : null : filterMask ? layer?.filterMask?.coverage : layer?.mask;
  const dense = isDenseMask(selectedMask), strictRead = filterMask || dense;
  const denseReadSupported = !dense || supportsMask(selectedMask, capabilities) && Number.isInteger(capabilities.limits?.maxMaskPreviewEdge) && capabilities.limits!.maxMaskPreviewEdge! >= 32 && capabilities.limits!.maxMaskPreviewEdge! <= 2400 && Number.isSafeInteger(capabilities.limits?.maxMaskPreviewBytes) && capabilities.limits!.maxMaskPreviewBytes! > 0 && capabilities.limits!.maxMaskPreviewBytes! <= 8 * 1024 * 1024 && capabilityStrings(capabilities.commands).includes('get_mask_preview') && capabilityStrings(capabilities.maskPreviewSources).includes(target.source) && Number.isSafeInteger(capabilities.limits?.maxMaskPreviewWorkingBytes) && capabilities.limits!.maxMaskPreviewWorkingBytes! > 0 && capabilities.limits!.maxMaskPreviewWorkingBytes! <= 256 * 1024 * 1024;
  const coverageModes = strings(capabilities.maskPreviewMaskModes).filter(mode => ['raw', 'effective'].includes(mode));
  const modeSupported = target.source === 'selection' || !strictRead || coverageModes.includes(mode);
  const edgeSupported = !strictRead || Number.isInteger(maxEdge) && maxEdge >= 32 && sizes.includes(edge);
  const frameWidth = filterMask ? layer?.filterMask?.sourceWidth : snapshot.width, frameHeight = filterMask ? layer?.filterMask?.sourceHeight : snapshot.height;
  const contextValid = denseReadSupported && (!filterMask || filterSupport.preview) && backend === target.backend && document.id === target.documentId && (target.source === 'selection' || selectedLayerId === target.layerId) && capabilities.commands.includes('get_mask_preview') && capabilities.maskPreviewSources?.includes(target.source);
  const sourceExists = target.source === 'selection' ? Boolean(snapshot.selection) : filterMask ? Boolean(layer?.filterMask) : Boolean(layer?.mask);
  const [request, setRequest] = useState<Request | null>({ revision: snapshot.revision, maskMode: mode, maxEdge: edge, sequence: 0 });
  const [state, setState] = useState<PreviewState | null>(null), [refreshing, setRefreshing] = useState(false), [refreshError, setRefreshError] = useState(''), [viewScale, setViewScale] = useState<'fit' | 'actual'>('fit');
  const sequence = useRef(0), refreshAbort = useRef<AbortController | null>(null), alive = useRef(true);
  const readCapabilities = strictRead ? JSON.stringify([denseCapabilityKey(capabilities), filterMaskCapabilityKey(capabilities), capabilities.maskPreviewSources, capabilities.maskPreviewMaskModes, capabilities.limits?.maxMaskPreviewEdge, capabilities.limits?.maxMaskPreviewBytes, capabilities.limits?.maxMaskPreviewWorkingBytes]) : '';
  const contextKey = `${backend}:${document.id}:${target.source}:${target.source !== 'selection' ? selectedLayerId : ''}:${readCapabilities}`;
  const latestContext = useRef(contextKey); latestContext.current = contextKey;
  const key = request ? `${contextKey}:${request.revision}:${request.maskMode}:${request.maxEdge}:${request.sequence}` : '';
  const eligible = Boolean(contextValid && modeSupported && edgeSupported && sourceExists && request && (!strictRead || request.maxEdge <= maxEdge) && request.revision === snapshot.revision);
  const latestKey = useRef(''); latestKey.current = eligible ? key : '';
  const current = state?.key === key ? state : null;
  const stale = Boolean(request && request.revision < snapshot.revision || current?.stale);
  const loading = Boolean(eligible && !current && !refreshing);
  const image = eligible && !refreshing && !stale ? current?.image : undefined;
  useEffect(() => { alive.current = true; return () => { alive.current = false; refreshAbort.current?.abort(); }; }, []);
  useEffect(() => { if (!contextValid) { refreshAbort.current?.abort(); if (!dense || backend !== target.backend || document.id !== target.documentId || target.source !== 'selection' && selectedLayerId !== target.layerId) onClose(); } }, [contextValid, contextKey]);
  useEffect(() => {
    if (!eligible || !request) return;
    const abort = new AbortController(); let live = true;
    setState(null);
    void command<MaskPreview>('native', 'get_mask_preview', { documentId: target.documentId, expectedRevision: request.revision, source: target.source, ...(target.source !== 'selection' ? { layerId: target.layerId, maskMode: request.maskMode } : {}), maxEdge: request.maxEdge }, abort.signal).then(result => {
      if (!live || latestKey.current !== key) return;
      validatePreview(result, snapshot, target, request, capabilities.limits?.maxMaskPreviewBytes || 8 * 1024 * 1024);
      setState({ key, image: result });
    }).catch(error => {
      if (!live || abort.signal.aborted || latestKey.current !== key) return;
      setState({ key, error: error instanceof Error ? error.message : 'The coverage preview could not be loaded.', stale: error?.code === 'REVISION_CONFLICT' });
    });
    return () => { live = false; abort.abort(); };
  }, [key, eligible, snapshot.revision]);
  const changeOptions = (nextMode: typeof mode, nextEdge: number) => {
    refreshAbort.current?.abort(); setRefreshing(false); setRefreshError(''); setMode(nextMode); setEdge(nextEdge);
    setRequest({ revision: snapshot.revision, maskMode: nextMode, maxEdge: nextEdge, sequence: ++sequence.current });
  };
  const refresh = async () => {
    refreshAbort.current?.abort(); const abort = new AbortController(); refreshAbort.current = abort; const capturedContext = contextKey, capturedSequence = ++sequence.current;
    setRequest(null); setState(null); setRefreshing(true); setRefreshError('');
    try {
      const result = await command<{ document: Document }>('native', 'get_document', { documentId: target.documentId }, abort.signal);
      if (!alive.current || abort.signal.aborted || latestContext.current !== capturedContext || sequence.current !== capturedSequence) return;
      if (result.document.id !== target.documentId) throw Error('The document response does not match this mask. Close and inspect the current source again.');
      setLocalDocument(result.document);
      setRequest({ revision: result.document.revision, maskMode: mode, maxEdge: edge, sequence: capturedSequence });
    } catch (error) {
      if (!alive.current || abort.signal.aborted || latestContext.current !== capturedContext || sequence.current !== capturedSequence) return;
      setRefreshError(error instanceof Error ? error.message : 'The latest document could not be read.');
    } finally { if (alive.current && refreshAbort.current === abort) { refreshAbort.current = null; setRefreshing(false); } }
  };
  const isMask = target.source !== 'selection';
  return <div className="mask-inspection">
    <span className="eyebrow">READ-ONLY COVERAGE</span><h1 id="modal-title">{filterMask ? 'Filter effect coverage.' : isMask ? 'Layer mask coverage.' : 'Active selection coverage.'}</h1>
    <p className="mask-inspection-source"><strong>{snapshot.name}</strong>{isMask && <span>{layer?.name || 'Removed layer'}</span>}</p>
    <div className="mask-inspection-controls">{isMask && <label className="field-label">Coverage<select aria-label="Inspect mask coverage" value={mode} onChange={event => changeOptions(event.target.value as typeof mode, edge)}>{filterMask && !modeSupported && <option value={mode} disabled>{mode} · unavailable</option>}{capabilities.maskPreviewMaskModes?.includes('effective') && <option value="effective">{filterMask ? 'Effective effect coverage' : 'With density'}</option>}{capabilities.maskPreviewMaskModes?.includes('raw') && <option value="raw">{filterMask ? 'Raw mask before density/enable' : 'Before density'}</option>}</select></label>}<label className="field-label">Preview size<select aria-label="Mask preview longest edge" value={edge} onChange={event => changeOptions(mode, Number(event.target.value))}>{strictRead && !edgeSupported && <option value={edge} disabled>{edge} px · unavailable</option>}{sizes.map(size => <option key={size} value={size}>{size} px</option>)}</select></label><label className="field-label">View<select aria-label="Mask preview view scale" value={viewScale} onChange={event => setViewScale(event.target.value as typeof viewScale)}><option value="fit">Fit</option><option value="actual">100% preview pixels</option></select></label></div>
    <p className="mask-inspection-description">{filterMask ? `Source effect mask; layer transparency and source cutout alpha are separate. Feather and inversion are evaluated. ${mode === 'effective' ? `Includes ${filterOpacityPercent(layer?.filterMask?.density ?? 1)}% density and ${layer?.filterMask?.enabled ? 'enabled' : 'disabled'} state; disabled or 0% density reveals the full stack.` : 'Raw coverage ignores density and enabled state.'}` : isMask ? `Additional layer mask; source cutout alpha is separate. Feather, inversion and clipping are evaluated. ${mode === 'effective' ? `Includes ${Number(((layer?.maskDensity ?? 1) * 100).toFixed(3))}% density.` : 'Before density ignores only the density setting.'}` : 'Active selection coverage, including feather, inversion and clipping. Inspecting does not change the selection.'}</p>
    <div className={`mask-inspection-image ${viewScale}`} aria-busy={loading || refreshing}>
      {image && <img alt={filterMask ? `Grayscale source filter effect coverage for ${layer?.name}` : isMask ? `Grayscale additional mask coverage for ${layer?.name}` : 'Grayscale active selection coverage'} src={`data:image/png;base64,${image.data}`} width={image.width} height={image.height} onError={() => { if (alive.current && latestKey.current === key) setState({ key, error: 'The coverage PNG could not be displayed. Refresh coverage.' }); }} />}
      {!denseReadSupported ? <p role="status">This connection cannot display coverage for this pixel mask.</p> : !modeSupported ? <p role="status">This coverage mode is no longer advertised. Choose an available mode.</p> : !edgeSupported ? <p role="status">This preview size is no longer advertised. Choose an available size.</p> : !sourceExists ? <p role="status">{filterMask ? 'This layer no longer has a filter effect mask.' : isMask ? 'This layer no longer has an additional mask.' : 'There is no active selection.'} Refresh after creating one.</p> : stale ? <p role="status"><CircleAlert size={18} />The document changed. Refresh coverage.</p> : (current?.error || refreshError) ? <p role="alert"><CircleAlert size={18} />{refreshError || current?.error}</p> : (loading || refreshing) ? <p role="status"><LoaderCircle size={18} className="spin" />Loading coverage…</p> : null}
    </div>
    <p className="mask-inspection-caption">{image ? `${image.width} × ${image.height} px preview · ${image.sourceWidth} × ${image.sourceHeight} px ${filterMask ? 'source frame' : 'canvas'} · inspected revision ${image.revision}. ${image.width === image.sourceWidth && image.height === image.sourceHeight ? 'Native sampling.' : 'Nearest-sampled preview; small details may be omitted.'}` : `${frameWidth ?? '—'} × ${frameHeight ?? '—'} px ${filterMask ? 'source frame' : 'canvas'}`}</p>
    <div className="mask-inspection-legend"><span><i className="black" />Black: {filterMask ? 'original colors' : 'none'}</span><span><i className="gray" />Gray: {filterMask ? 'partial filter effect' : 'partial'}</span><span><i className="white" />White: {filterMask ? 'full filter effect' : 'full coverage'}</span></div><p className="mask-inspection-description">Coverage does not override protected pixels. Preview size changes sampling only; Fit and 100% change display scale.</p>
    <div className="mask-inspection-actions"><button className="button secondary" disabled={refreshing || !contextValid || !modeSupported || !edgeSupported} onClick={() => void refresh()}><RefreshCw size={14} />{current?.error || refreshError ? 'Retry coverage' : 'Refresh coverage'}</button><button className="button primary" onClick={onClose}><ScanEye size={14} />Close inspection</button></div>
  </div>;
}
