import { useEffect, useRef, useState } from 'react';
import { Check, CircleAlert, Download, FolderOpen, LoaderCircle, RefreshCw } from 'lucide-react';
import { downloadBlob, importLayeredPsd, inspectPsdImport, type Document, type PsdImportIssue, type PsdImportOptions, type PsdImportReport } from './api';
import './psd-import.css';

type ImportSession = { id: string; file: File; name: string; assumeSrgb: boolean; frozen?: PsdImportOptions; publicationUncertain?: boolean };
type Inspection = { key: string; report?: PsdImportReport; error?: string; loading?: boolean };
type ImportFailure = { message: string; code?: string; report?: PsdImportReport };
// These validation failures occur before native publication. Once any earlier
// response was ambiguous, keep the original identity even after a later refusal.
const REVIEW_REJECTIONS = new Set(['INVALID_PSD', 'PSD_UNSUPPORTED', 'INSPECTION_STALE', 'INVALID_ARGUMENT', 'INVALID_ARGUMENTS', 'LIMIT_EXCEEDED']);

function matches(report: PsdImportReport, file: File, policy: string, assumeSrgb: boolean) {
  return report?.format === 'psd' && report.importerVersion === 1 && report.subsetId === policy && report.input?.bytes === file.size && /^[a-f0-9]{64}$/.test(report.input?.sha256 || '') && report.options?.assumeSrgb === assumeSrgb;
}

export function usePsdImport({ enabled, active, policy, maxBytes, onImported }: { enabled: boolean; active: boolean; policy: string; maxBytes: number; onImported: (document: Document, report: PsdImportReport) => Promise<void> }) {
  const [session, setSession] = useState<ImportSession | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [retry, setRetry] = useState(0), [importing, setImporting] = useState(false), [failure, setFailure] = useState<ImportFailure | null>(null);
  const locked = useRef(false), alive = useRef(true);
  const key = session ? `${session.id}:${session.assumeSrgb}:${policy}:${retry}` : '';
  const latestKey = useRef(key); latestKey.current = key;
  const callback = useRef(onImported); callback.current = onImported;
  const current = inspection?.key === key ? inspection : null;
  const report = failure?.report || current?.report;
  const inspecting = Boolean(active && enabled && session && !session.frozen && (!current || current.loading));
  const canReplaceRejected = Boolean(failure?.code && REVIEW_REJECTIONS.has(failure.code) && !session?.publicationUncertain && !importing);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!enabled || !active || !session || session.frozen) return;
    const abort = new AbortController(); let live = true;
    setInspection({ key, loading: true }); setFailure(null);
    void inspectPsdImport(session.file, session.assumeSrgb, abort.signal).then(result => {
      if (!live || latestKey.current !== key) return;
      if (!matches(result, session.file, policy, session.assumeSrgb)) throw Error('The inspection does not match this file or importer version. Inspect again.');
      setInspection({ key, report: result });
    }).catch(error => {
      if (!live || abort.signal.aborted || latestKey.current !== key) return;
      const candidate = error?.report as PsdImportReport | undefined;
      setInspection({ key, error: error instanceof Error ? error.message : 'The PSD could not be inspected.', ...(candidate && matches(candidate, session.file, policy, session.assumeSrgb) ? { report: candidate } : {}) });
    });
    return () => { live = false; abort.abort(); };
  }, [key, active, enabled, Boolean(session?.frozen)]);
  const begin = (file: File) => {
    if (locked.current || (session?.frozen && !canReplaceRejected)) return false;
    if (!enabled) throw Error('Open PSD files in the Native workspace when layered import is available.');
    if (!/\.ps[db]$/i.test(file.name)) throw Error('Choose a Photoshop PSD file for compatibility review.');
    if (file.name.length > 200 || /[\u0000-\u001f\u007f]/.test(file.name)) throw Error('Use a PSD filename up to 200 characters without control characters.');
    if (!file.size || file.size > maxBytes) throw Error(`Choose a nonempty PSD file up to ${Math.floor(maxBytes / 1024 / 1024)} MiB.`);
    setSession({ id: crypto.randomUUID(), file, name: file.name.replace(/\.ps[db]$/i, '').slice(0, 200), assumeSrgb: false }); setInspection(null); setFailure(null); setRetry(0); return true;
  };
  const eligible = Boolean(enabled && session && report && matches(report, session.file, policy, session.assumeSrgb) && report.supported && report.validation === 'complete' && !inspecting && !current?.error && !failure && session.name.trim().length > 0);
  const publish = async () => {
    if (locked.current || !session || !enabled || (!session.frozen && !eligible)) return;
    const options: PsdImportOptions = session.frozen || { requestId: crypto.randomUUID(), expectedSha256: report!.input.sha256, importerVersion: 1, sourceName: session.file.name, name: session.name.trim(), assumeSrgb: session.assumeSrgb };
    const operationKey = key;
    locked.current = true; setImporting(true); setFailure(null); setSession(previous => previous ? { ...previous, frozen: options } : previous);
    try {
      const result = await importLayeredPsd(session.file, options);
      if (!alive.current || latestKey.current !== operationKey) return;
      await callback.current(result.document, result.report);
      if (alive.current && latestKey.current === operationKey) { setSession(null); setInspection(null); }
    } catch (error) {
      if (!alive.current || latestKey.current !== operationKey) return;
      const candidate = (error as ImportFailure)?.report;
      if (!REVIEW_REJECTIONS.has((error as ImportFailure)?.code || '')) setSession(value => value ? { ...value, publicationUncertain: true } : value);
      setFailure({ message: error instanceof Error ? error.message : 'The PSD import reply was not received. Retry this request to recover its result.', code: (error as ImportFailure)?.code, ...(candidate && matches(candidate, session.file, policy, session.assumeSrgb) ? { report: candidate } : {}) });
    } finally { locked.current = false; if (alive.current) setImporting(false); }
  };
  return { session, report, error: failure?.message || current?.error, importing, inspecting, eligible, frozen: Boolean(session?.frozen),
    begin, publish, canReplaceRejected, canReinspect: canReplaceRejected, retryInspection: () => { if (!session?.frozen) setRetry(value => value + 1); },
    reinspectRejected: () => { if (!locked.current && canReplaceRejected) { setFailure(null); setInspection(null); setSession(value => value ? { ...value, id: crypto.randomUUID(), frozen: undefined } : value); } },
    setName: (name: string) => setSession(value => value && !value.frozen ? { ...value, name } : value),
    setAssumeSrgb: (assumeSrgb: boolean) => { if (!session?.frozen) { setInspection(null); setSession(value => value ? { ...value, assumeSrgb } : value); } },
    discard: () => { if (!locked.current && (!session?.frozen || canReplaceRejected)) { setSession(null); setInspection(null); setFailure(null); } },
  };
}

type Controller = ReturnType<typeof usePsdImport>;
const PROPERTY_LABELS: Record<string, string> = { 'raster-rgb-alpha': 'Raster pixels and transparency', 'editable-user-masks': 'Editable layer masks', 'layer-order': 'Layer names and stacking order', 'opacity-visibility': 'Opacity and visibility', 'original-psd-archive': 'Exact original PSD archive', 'photoshop-history': 'Photoshop undo history', 'photoshop-editing-lock-semantics': 'Photoshop editing locks' };
const propertyLabel = (key: string) => PROPERTY_LABELS[key] || key.replace(/[-_]/g, ' ');
export function PsdImport({ controller, onChoose, onClose }: { controller: Controller; onChoose: () => void; onClose: () => void }) {
  const { session, report, inspecting, importing, frozen, error } = controller;
  if (!session) return null;
  const issues = (items: PsdImportIssue[]) => <ul>{items.map((issue, index) => <li key={`${issue.code}:${index}`}>
    {(issue.layerName || issue.layerIndex !== undefined) && <strong>{issue.layerName || report?.layers?.find(layer => layer.index === issue.layerIndex)?.name || `Layer ${issue.layerIndex! + 1}`}</strong>}
    <span>{issue.message}</span>{issue.recordKey && <small>Record: {issue.recordKey}</small>}
  </li>)}</ul>;
  return <div className="psd-import">
    <span className="eyebrow">EDITABLE COMPATIBLE LAYERS</span><h1 id="modal-title">Open layered PSD.</h1>
    <p className="modal-intro">Review this file before creating a new Prism document. This version supports a limited subset: flat RGB8 raster layers and masks, normal blending, and raw or PackBits compression.</p>
    <div className="psd-import-file"><strong>{session.file.name}</strong><span>{(session.file.size / 1024 / 1024).toFixed(2)} MiB · original file retained</span></div>
    <div className="psd-import-review" aria-label="PSD import compatibility">
      {inspecting && <p className="psd-import-progress" role="status"><LoaderCircle size={14} className="spin" />Inspecting PSD…</p>}
      {error && <div className="psd-import-error" role="alert"><CircleAlert size={15} /><span>{error}</span></div>}
      {report && <>
        <div className={`psd-import-state ${report.supported && report.validation === 'complete' ? 'supported' : ''}`} role="status">{report.supported && report.validation === 'complete' ? <Check size={15} /> : <CircleAlert size={15} />}<span>{report.supported && report.validation === 'complete' ? 'Compatible with this PSD subset' : 'This PSD cannot be imported'}{report.document && <small>{report.document.width} × {report.document.height} px · {report.document.layerCount} layers · {report.document.bitsPerChannel}-bit {report.document.colorMode}</small>}</span></div>
        {(report.issues?.length > 0 || Boolean(report.issuesOmitted)) && <div className="psd-import-issues"><h2>Unsupported content</h2>{issues(report.issues || [])}{Boolean(report.issuesOmitted) && <p>{report.issuesOmitted} additional unsupported issues are omitted from this bounded report.</p>}</div>}
        {(report.requiresSrgbAssumption || session.assumeSrgb) && <label className="psd-import-assumption"><input aria-label="Interpret untagged RGB as sRGB" type="checkbox" checked={session.assumeSrgb} disabled={frozen || importing} onChange={event => controller.setAssumeSrgb(event.target.checked)} /><span>Interpret untagged RGB as sRGB<small>This file has no recognized color profile. Reinspection uses this explicit interpretation; unknown embedded profiles cannot be overridden.</small></span></label>}
        {(report.warnings?.length > 0 || Boolean(report.warningsOmitted)) && <div className="psd-import-warnings"><h2>What to review</h2>{issues(report.warnings || [])}{Boolean(report.warningsOmitted) && <p>{report.warningsOmitted} additional review warnings are omitted from this bounded report.</p>}</div>}
        {report.comparison && (report.comparison.differingChannels > 0 || !report.comparison.alphaComparable) && <div className="psd-import-warnings"><h2>Appearance comparison</h2>{report.comparison.differingChannels > 0 && <p>The native layer rendering differs from the PSD’s saved merged image in {report.comparison.differingChannels.toLocaleString()} RGB channel values, with a maximum difference of {report.comparison.maxChannelDifference} out of 255. Editable layers will be imported; the saved merged image will not replace them.</p>}{!report.comparison.alphaComparable && <p>Transparency could not be compared with the saved RGB image.</p>}</div>}
        {report.supported && report.validation === 'complete' && report.preserves?.length > 0 && <div className="psd-import-properties"><h2>Preserved editable properties</h2><ul>{report.preserves.map(item => <li key={item}>{propertyLabel(item)}</li>)}</ul></div>}
        {report.omits?.length > 0 && <div className="psd-import-properties"><h2>Not transferred to native editing</h2><ul>{report.omits.map(item => <li key={item}>{propertyLabel(item)}</li>)}</ul></div>}
      </>}
      <p className="psd-import-disclosure">Unsupported features are rejected. Nothing is silently flattened or substituted with the saved merged image. Your existing documents stay unchanged.</p>
      <label className="field-label">New document name<input aria-label="PSD document name" value={session.name} maxLength={200} disabled={frozen || importing} onChange={event => controller.setName(event.target.value)} /></label>
      <p className="psd-import-disclosure">The original PSD archive is preserved separately from editable layer pixels and included in .prism projects. Imported history starts here.</p>
      {frozen && <p className="psd-import-recovery">{controller.canReplaceRejected ? 'This request was rejected before creating a document. Inspect again or choose another file.' : 'This import attempt keeps the same file, interpretation and request ID. Retry recovers its result if a successful reply was lost.'}</p>}
    </div>
    <div className="psd-import-secondary"><button className="button subtle" disabled={importing || (frozen && !controller.canReplaceRejected)} onClick={onChoose}><FolderOpen size={13} />Choose another PSD</button><button className="button subtle" onClick={() => downloadBlob(session.file, session.file.name)}><Download size={13} />Download original PSD</button></div>
    <div className="psd-import-actions"><button className="button secondary" disabled={importing} onClick={onClose}>{frozen ? 'Close review' : 'Cancel'}</button>{!frozen && <button className="button secondary" disabled={inspecting || importing} onClick={controller.retryInspection}><RefreshCw size={13} />Inspect again</button>}{controller.canReinspect ? <button className="button primary" disabled={importing} onClick={controller.reinspectRejected}><RefreshCw size={13} />Inspect this file again</button> : <button className="button primary" disabled={importing || (!frozen && !controller.eligible)} onClick={() => void controller.publish()}>{importing ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}{importing ? 'Importing PSD…' : frozen ? 'Retry same PSD import' : 'Import as new document'}</button>}</div>
  </div>;
}
