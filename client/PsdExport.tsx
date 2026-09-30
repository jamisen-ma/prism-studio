import { useEffect, useRef, useState } from 'react';
import { Check, CircleAlert, Download, LoaderCircle, RefreshCw } from 'lucide-react';
import { downloadBlob, exportLayeredPsd, inspectPsdExport, type Document, type PsdIssue, type PsdReport } from './api';

type Result = { key: string; report?: PsdReport; error?: string; stale?: boolean };
export function PsdExport({ document, busy, onBusyChange, onRefreshDocument, onProject, importAvailable = false }: { document: Document; busy: boolean; onBusyChange: (busy: boolean) => void; onRefreshDocument: () => Promise<Document | null>; onProject?: () => void; importAvailable?: boolean }) {
  const [attempt, setAttempt] = useState(0), [result, setResult] = useState<Result | null>(null);
  const [downloading, setDownloading] = useState(false), [refreshing, setRefreshing] = useState(false), [downloaded, setDownloaded] = useState(false);
  const locked = useRef(false), alive = useRef(true);
  const key = `${document.backend}:${document.id}:${document.revision}:${attempt}`;
  const latestKey = useRef(key); latestKey.current = key;
  const current = result?.key === key ? result : null;
  const report = current?.report;
  const loading = !current;
  useEffect(() => { alive.current = true; return () => { alive.current = false; onBusyChange(false); }; }, [onBusyChange]);
  useEffect(() => { onBusyChange(loading || downloading || refreshing); }, [loading, downloading, refreshing, onBusyChange]);
  useEffect(() => {
    let active = true; setDownloaded(false);
    void inspectPsdExport(document).then(report => {
      if (!active) return;
      if (report.documentId !== document.id || report.revision !== document.revision || report.format !== 'psd') throw Error('Compatibility results do not match the current document. Refresh compatibility.');
      setResult({ key, report });
    }).catch(error => { if (active) setResult({ key, error: error instanceof Error ? error.message : 'PSD compatibility could not be checked.', stale: error?.code === 'REVISION_CONFLICT' }); });
    return () => { active = false; };
  }, [key]);
  const refresh = async () => {
    if (locked.current || busy) return;
    locked.current = true; setRefreshing(true);
    try {
      const fresh = await onRefreshDocument();
      if (alive.current && fresh?.id === document.id && fresh.revision === document.revision) setAttempt(value => value + 1);
    } catch (error) {
      if (alive.current && latestKey.current === key) setResult({ key, error: error instanceof Error ? error.message : 'The current document could not be refreshed. Try again.' });
    } finally { locked.current = false; if (alive.current) setRefreshing(false); }
  };
  const download = async () => {
    if (locked.current || busy || !report?.supported || report.requiresPixelValidation) return;
    locked.current = true; setDownloading(true); setDownloaded(false);
    try {
      const exported = await exportLayeredPsd({ id: report.documentId, revision: report.revision, name: document.name });
      if (alive.current && latestKey.current === key) { downloadBlob(exported.data, exported.filename); setDownloaded(true); }
    } catch (error) {
      if (alive.current && latestKey.current === key) {
        const failure = error as Error & { code?: string; report?: PsdReport };
        const rejectedReport = failure.report?.documentId === document.id && failure.report.revision === document.revision ? failure.report : undefined;
        setResult({ key, ...(rejectedReport ? { report: rejectedReport } : {}), error: failure.message || 'The PSD could not be exported.', stale: failure.code === 'REVISION_CONFLICT' });
      }
    } finally { locked.current = false; if (alive.current) setDownloading(false); }
  };
  const items = (entries: PsdIssue[]) => <ul>{entries.map((item, index) => <li key={`${item.code}-${item.layerId || ''}-${index}`}>{item.layerId && <strong>{item.layerName || document.layers.find(layer => layer.id === item.layerId)?.name || 'Layer'}:</strong>}<span>{item.message}</span></li>)}</ul>;
  return <section className="psd-export" aria-label="Layered PSD compatibility">
    <strong>Layered PSD · limited supported subset</strong>
    <p>8-bit sRGB, flat raster/solid layers, normal blending and an opaque final image. Compatible layer masks remain editable. {importAvailable ? 'Import compatible PSD files separately through File → Open PSD.' : 'No PSD import is provided.'}</p>
    <p>Keep a <b>.prism</b> project for native editable features, original source files and selections. PSD exports only the compatible representation described below.</p>
    {loading && <p className="psd-checking" role="status"><LoaderCircle size={14} className="spin" />Inspecting document revision {document.revision}…</p>}
    {current?.error && <div className="psd-error" role="alert"><CircleAlert size={15} /><span>{current.stale ? 'The document changed after this revision was selected. Refresh compatibility to inspect the latest canvas before downloading.' : current.error}</span></div>}
    {report && <><div className={`psd-compatibility-state ${report.supported ? 'supported' : 'unsupported'}`} role="status">{report.supported ? <Check size={15} /> : <CircleAlert size={15} />}<span>{report.supported && !report.requiresPixelValidation ? 'Compatible with this PSD subset' : 'This document cannot be exported as layered PSD'}<small>Inspected revision {report.revision} · {report.layerCount} layers{report.estimatedBytes !== null && ` · approximately ${(report.estimatedBytes / 1024 / 1024).toFixed(2)} MiB`} · maximum 64 MiB</small></span></div>
      {report.issues.length > 0 && <div className="psd-issues"><h2>Unsupported layers or settings</h2>{items(report.issues)}</div>}
      {report.warnings.length > 0 && <div className="psd-warnings"><h2>What changes in the exported copy</h2>{items(report.warnings)}</div>}
    </>}
    <div className="psd-actions"><button className="button secondary" disabled={busy || downloading || refreshing || loading} onClick={() => void refresh()}>{refreshing ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}Refresh compatibility</button><button className="button primary" disabled={busy || loading || downloading || refreshing || !report?.supported || report.requiresPixelValidation || Boolean(current?.error)} onClick={() => void download()}>{downloading ? <LoaderCircle size={14} className="spin" /> : <Download size={14} />}Download layered PSD</button></div>
    {downloaded && <p className="psd-download-success" role="status">Layered PSD download started. Your Prism project is unchanged.</p>}
    {!report?.supported && !loading && <p className="psd-no-fallback">Nothing is flattened or changed automatically.{onProject && <> <button className="text-button" onClick={onProject}>Download the full .prism project instead</button></>}</p>}
  </section>;
}
