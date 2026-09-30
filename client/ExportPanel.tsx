import { useState } from 'react';
import { Download, Layers, LoaderCircle } from 'lucide-react';
import type { Backend, BackendId, Document } from './api';
import './export.css';
import { PsdExport } from './PsdExport';

type Format = 'png' | 'jpeg' | 'webp' | 'tiff';
export type ExportSettings = { format: Format; quality?: number; matte?: string; density?: number; lossless?: boolean };
const LABELS: Record<Format, string> = { png: 'PNG — lossless', jpeg: 'JPEG — smaller file', webp: 'WebP — optimized for web', tiff: 'TIFF — flattened, lossless' };

export function ExportPanel({ document, preview, backend, capabilities, busy, onExport, onExportProject, onRefreshDocument, initialKind = 'image' }: {
  document: Document; preview: string; backend: BackendId; capabilities?: Backend; busy: boolean; onExport: (settings: ExportSettings) => void; onExportProject?: () => void; onRefreshDocument?: () => Promise<Document | null>; initialKind?: 'image' | 'project';
}) {
  const [kind, setKind] = useState<'image' | 'project' | 'psd'>(initialKind);
  const [psdBusy, setPsdBusy] = useState(false);
  const [selectedFormat, setFormat] = useState<Format>('png');
  const [quality, setQuality] = useState(90);
  const [matte, setMatte] = useState('#ffffff');
  const [lossless, setLossless] = useState(false);
  const [densityEnabled, setDensityEnabled] = useState(false);
  const [density, setDensity] = useState(300);
  const native = backend === 'native';
  const canProject = native && Boolean(capabilities?.projectFormats?.includes('prism')) && Boolean(onExportProject);
  const canPsd = native && Boolean(capabilities?.layeredExportFormats?.includes('psd')) && Boolean(onRefreshDocument);
  const psd = canPsd && kind === 'psd';
  const project = canProject && kind === 'project';
  const advertised = native ? capabilities?.exportFormats || ['png', 'jpeg', 'webp'] : ['png', 'jpeg'];
  const formats = (['png', 'jpeg', 'webp', 'tiff'] as Format[]).filter(format => advertised.includes(format));
  const format = formats.includes(selectedFormat) ? selectedFormat : formats[0] || 'png';
  const supports = (option: string) => native && Boolean(capabilities?.exportOptions?.includes(option));
  const canMatte = format === 'jpeg' && supports('jpegMatte');
  const canLossless = format === 'webp' && supports('webpLossless');
  const canDensity = supports('density') && Boolean(capabilities?.exportDensityFormats?.includes(format));
  const useLossless = canLossless && lossless;
  const useDensity = canDensity && densityEnabled;
  const usesQuality = format === 'jpeg' || format === 'webp' && !useLossless;
  const validDensity = Number.isInteger(density) && density >= 1 && density <= 1200;
  const valid = formats.length > 0 && (!useDensity || validDensity) && (!usesQuality || Number.isInteger(quality) && quality >= 1 && quality <= 100);
  const descriptions: Record<Format, string> = {
    png: `${native ? '8-bit sRGB. ' : ''}Lossless PNG preserves transparency.`,
    jpeg: `${native ? '8-bit sRGB. ' : ''}JPEG flattens transparency${native ? ` onto ${canMatte ? matte.toUpperCase() : 'white'}` : ''}. Quality controls file size and compression.`,
    webp: `8-bit sRGB with transparency. ${useLossless ? 'Lossless encoding preserves visible colors and alpha.' : 'Quality controls file size and compression.'}`,
    tiff: 'Flattened 8-bit sRGB TIFF with transparency and lossless Deflate compression. This export does not contain editable layers.',
  };
  const settings = (): ExportSettings => ({ format, ...(usesQuality ? { quality } : {}), ...(canMatte ? { matte } : {}), ...(canLossless ? { lossless } : {}), ...(useDensity ? { density } : {}) });
  return <>
    <span className="eyebrow">READY FOR THE WORLD</span><h1 id="modal-title">Take it with you.</h1>
    <p className="modal-intro">{project ? 'Keep editing in Prism, on this computer or another one.' : psd ? 'Share compatible editable raster layers in a separate PSD copy.' : 'Export your finished image. Your editable project stays in the workspace.'}</p>{(canProject || canPsd) && <div className="export-kind-tabs" role="group" aria-label="Export type"><button aria-pressed={!project && !psd} className={!project && !psd ? 'selected' : ''} disabled={busy || psdBusy} onClick={() => setKind('image')}><Download size={14} />Image</button>{canProject && <button aria-pressed={project} className={project ? 'selected' : ''} disabled={busy || psdBusy} onClick={() => setKind('project')}><Layers size={14} />Editable project</button>}{canPsd && <button aria-pressed={psd} className={psd ? 'selected' : ''} disabled={busy || psdBusy} onClick={() => setKind('psd')}><Layers size={14} />Layered PSD</button>}</div>}
    <div className="export-preview">{preview && <img src={preview} alt="Export preview" style={!project && !psd && format === 'jpeg' ? { backgroundColor: canMatte ? matte : '#ffffff' } : undefined} />}<div><strong>{document.name}</strong><span>{document.width} × {document.height} px</span></div></div>
    {psd ? <PsdExport importAvailable={native && Boolean(capabilities?.layeredImportFormats?.includes('psd'))} key={`${backend}-${document.id}`} document={document} busy={busy} onBusyChange={setPsdBusy} onRefreshDocument={onRefreshDocument!} onProject={canProject ? () => setKind('project') : undefined} /> : project ? <div className="project-export-summary"><strong>Prism project · .prism</strong><p>Includes the current document’s editable layers, groups, masks, saved selections, and original image assets.</p><p>Undo history is not included. Opening this file creates a new project with fresh history; your existing projects stay in place.</p><button className="button primary wide" disabled={busy} onClick={onExportProject}>{busy ? <LoaderCircle size={15} className="spin" /> : <Download size={15} />}Download .prism project</button></div> : <><label className="field-label">Image format<select aria-label="Image format" value={format} disabled={busy} onChange={event => setFormat(event.target.value as Format)}>{formats.map(item => <option key={item} value={item}>{LABELS[item]}</option>)}</select></label>
    <p className="export-format-note" aria-live="polite">{descriptions[format]}</p>
    {canMatte && <label className="field-label color-field">JPEG matte color<input aria-label="JPEG matte color" type="color" value={matte} disabled={busy} onChange={event => setMatte(event.target.value)} /><span>{matte.toUpperCase()}</span></label>}
    {canLossless && <label className="export-check"><input aria-label="Lossless WebP" type="checkbox" checked={lossless} disabled={busy} onChange={event => setLossless(event.target.checked)} />Lossless WebP</label>}
    {usesQuality && <label className="field-label">Quality · {quality}%<input aria-label="Export quality" type="range" min="1" max="100" step="1" value={quality} disabled={busy} onChange={event => setQuality(Number(event.target.value))} /></label>}
    {canDensity && <div className="export-density"><label className="export-check"><input aria-label="Set print density" type="checkbox" checked={densityEnabled} disabled={busy} onChange={event => setDensityEnabled(event.target.checked)} />Set print density</label>{densityEnabled && <><label className="field-label">Pixels per inch<input aria-label="Export density" type="number" min="1" max="1200" step="1" value={density} disabled={busy} onChange={event => setDensity(Number(event.target.value))} /></label>{validDensity ? <p className="export-physical-size" aria-live="polite">{(document.width / density).toFixed(2)} × {(document.height / density).toFixed(2)} in at {density} ppi</p> : <p className="inline-panel-error">Use a whole number from 1 to 1,200 pixels per inch.</p>}<p className="export-density-note">Print metadata only. Pixel dimensions stay {document.width} × {document.height}.</p></>}</div>}
    {format === 'webp' && <p className="export-density-note">WebP exports use pixel dimensions without print-density metadata.</p>}
    <button className="button primary wide" disabled={busy || !valid} onClick={() => onExport(settings())}>{busy ? <LoaderCircle size={15} className="spin" /> : <Download size={15} />}Download {format.toUpperCase()}</button></>}
  </>;
}
