import { useEffect, useRef, useState } from 'react';
import { Download, Plus, ScanEye, X } from 'lucide-react';
import { command, type Backend, type ColorRangePreview, type Document } from './api';
import { capabilityStrings, previewDimensions } from './dense-mask';
import { colorRangeCapabilityKey, colorRangeSettingsAllowed, colorRangeSupport, parseColorRangeDraft, type ColorRangeDraft, validateColorRangePreview } from './color-range';
import type { ColorRangeLoadDraft, SelectionCombination, SelectionProducer } from './useChannelSelection';
import './channel-selection.css';
import './color-range.css';

type Props = { document: Document; capabilities: Backend; busy: boolean; foreground: string; load: (draft: ColorRangeLoadDraft) => Promise<void>; review: () => Promise<void>; state?: 'pending' | 'unconfirmed'; producer?: SelectionProducer; reviewing: boolean };
export function ColorRangeSelection({ document, capabilities, busy, foreground, load, review, state, producer, reviewing }: Props) {
  const support = colorRangeSupport(capabilities, document);
  const [samples, setSamples] = useState<{ id: number; color: string }[]>([]), nextId = useRef(0);
  const [values, setValues] = useState({ tolerance: '32', falloff: '32', invert: false });
  const [mode, setMode] = useState<SelectionCombination>('replace'), [notice, setNotice] = useState('');
  const [edge, setEdge] = useState<number>(support.defaultEdge), [scale, setScale] = useState('fit');
  const [request, setRequest] = useState(0), [open, setOpen] = useState(false), [requestedEpoch, setRequestedEpoch] = useState(-1);
  const [result, setResult] = useState<{ key: string; image?: ColorRangePreview; error?: string } | null>(null);
  const draft: ColorRangeDraft = { colors: samples.map(sample => sample.color), ...values }, settings = parseColorRangeDraft(draft);
  const validSettings = colorRangeSettingsAllowed(settings, support);
  const sizes = [...new Set([support.defaultEdge, Math.min(1400, support.maxEdge), support.maxEdge])].filter(size => size >= support.minEdge && size <= support.maxEdge);
  const validEdge = sizes.includes(edge), size = previewDimensions(document.width, document.height, edge);
  const readWork = Boolean(settings && size.width * size.height * settings.colors.length <= support.maxComparisons);
  const loadWork = Boolean(settings && document.width * document.height * settings.colors.length <= support.maxComparisons);
  const key = JSON.stringify([document.backend, document.id, document.revision, document.width, document.height, settings || draft, edge, colorRangeCapabilityKey(capabilities), busy, reviewing]);
  const epoch = useRef({ key, value: 0 }); if (epoch.current.key !== key) epoch.current = { key, value: epoch.current.value + 1 };
  const eligible = open && requestedEpoch === epoch.current.value && validSettings && support.preview && validEdge && readWork && !busy && !reviewing;
  const token = `${key}:${epoch.current.value}:${request}`, latestToken = useRef(''); latestToken.current = eligible ? token : '';
  const image = eligible && result?.key === token ? result.image : undefined, error = eligible && result?.key === token ? result.error : undefined;
  const loading = eligible && result?.key !== token;
  useEffect(() => {
    if (!eligible || !settings) return;
    const abort = new AbortController(), version = epoch.current.value;
    const owned = () => !abort.signal.aborted && latestToken.current === token && epoch.current.value === version;
    setResult(null);
    void command<ColorRangePreview>('native', 'get_color_range_preview', { documentId: document.id, expectedRevision: document.revision, ...settings, maxEdge: edge }, abort.signal).then(async value => {
      if (!owned()) return;
      validateColorRangePreview(value, document, settings, edge, support.maxBytes);
      const decoded = new Image(); decoded.src = `data:image/png;base64,${value.data}`; await decoded.decode();
      if (!owned()) return;
      if (decoded.naturalWidth !== value.width || decoded.naturalHeight !== value.height) throw Error('The Color Range PNG dimensions do not match the captured preview. Preview again.');
      setResult({ key: token, image: value });
    }).catch(error => { if (owned()) setResult({ key: token, error: error instanceof Error ? error.message : 'Color Range coverage could not be read.' }); });
    return () => abort.abort();
  }, [token, eligible]);
  const frozen = busy || reviewing || state === 'pending', needsSelection = ['subtract', 'intersect'].includes(mode) && !document.selection;
  const add = () => {
    if (frozen || samples.length >= support.maxColors) return;
    if (!/^#[\da-f]{6}$/i.test(foreground)) { setNotice('Choose a foreground color before copying it.'); return; }
    const color = foreground.toLowerCase(), existing = samples.findIndex(sample => sample.color.toLowerCase() === color);
    if (existing >= 0) { setNotice(`Foreground color already matches sample ${existing + 1}. Edit that sample or choose another foreground color.`); return; }
    const id = ++nextId.current; setSamples(previous => [...previous, { id, color }]); setNotice('Foreground color copied. Edit this sample to choose another color.');
    requestAnimationFrame(() => window.document.getElementById(`color-range-${document.id}-${id}`)?.focus());
  };
  const duplicate = samples.some((sample, index) => /^#[\da-f]{6}$/i.test(sample.color) && samples.slice(0, index).some(other => other.color.toLowerCase() === sample.color.toLowerCase()));
  const validation = !samples.length ? 'Add a foreground color, then edit the sample to match the colors you want.' : duplicate ? 'Each sample must have a distinct color.' : !settings ? 'Use full #rrggbb colors and whole Tolerance/Falloff values from 0 to 255.' : !validSettings ? 'These settings exceed the available color or distance limits. Your draft is retained.' : '';
  const previewStatus = error || (!support.preview ? 'Color Range preview is unavailable with this connection.' : !validEdge ? 'This preview size is unavailable. Choose an advertised size.' : !eligible ? 'The document or settings changed. Preview the current revision.' : 'Loading Color Range coverage…');
  return <section className="channel-selection color-range-selection" aria-label="Color Range selection">
    <div className="section-heading"><span>Color Range</span><ScanEye size={14} /></div>
    <p className="property-hint">Select similar colors in the visible composite. White selects fully; gray selects partially.</p>
    <div className="color-range-samples">{samples.map((sample, index) => <div className="color-range-sample" key={sample.id}>
      <span aria-hidden="true">{index + 1}</span><input type="color" aria-label={`Color Range sample ${index + 1} color`} value={/^#[\da-f]{6}$/i.test(sample.color) ? sample.color.toLowerCase() : '#000000'} disabled={frozen} onChange={event => { setSamples(samples.map(item => item.id === sample.id ? { ...item, color: event.target.value } : item)); setNotice(''); }} />
      <input id={`color-range-${document.id}-${sample.id}`} aria-label={`Color Range sample ${index + 1} hex`} type="text" spellCheck={false} autoComplete="off" value={sample.color} disabled={frozen} onChange={event => { setSamples(samples.map(item => item.id === sample.id ? { ...item, color: event.target.value } : item)); setNotice(''); }} />
      <button className="button subtle" aria-label={`Remove Color Range sample ${index + 1}`} disabled={frozen} onClick={() => { setSamples(samples.filter(item => item.id !== sample.id)); setNotice('Sample removed.'); }}><X size={13} /></button>
    </div>)}</div>
    <button className="button secondary wide" disabled={frozen || samples.length >= support.maxColors} onClick={add}><Plus size={13} />Add foreground color</button>
    <p className="property-hint">Copies the foreground color once. Edit any sample with its hex field or color picker. {samples.length}/{support.maxColors} samples.</p>
    {notice && <p className="property-hint" role="status">{notice}</p>}
    <div className="color-range-distances">{(['tolerance', 'falloff'] as const).map(name => <label className="field-label" key={name}>{name === 'tolerance' ? 'Tolerance' : 'Extra falloff'}<input aria-label={`Color Range ${name}`} type="text" inputMode="numeric" value={values[name]} disabled={frozen} onChange={event => { setValues({ ...values, [name]: event.target.value }); setNotice(''); }} /></label>)}</div>
    <label className="field-label">Combine<select aria-label="Color Range combination" value={mode} disabled={frozen} onChange={event => setMode(event.target.value as SelectionCombination)}><option value="replace">Replace active selection</option><option value="add">Add to active selection</option><option value="subtract">Subtract from active selection</option><option value="intersect">Intersect with active selection</option></select></label>
    <label className="channel-invert"><input aria-label="Invert Color Range coverage" type="checkbox" checked={values.invert} disabled={frozen} onChange={event => setValues({ ...values, invert: event.target.checked })} />Invert coverage</label>
    {values.invert && <p className="property-hint">Inversion also selects fully transparent pixels.</p>}
    {validation && <p className="property-hint" role="status">{validation}</p>}
    {!support.semantic ? <p className="inline-panel-error">Color Range is unavailable with this connection. Your settings are retained.</p> : !support.load && <p className="property-hint">Loading Color Range selections is unavailable with this connection.</p>}
    {validSettings && (!loadWork || !readWork) && <p className="property-hint">The available comparison limit is too small for {loadWork ? 'this preview' : 'a full-resolution selection'}. Reduce the sample count{!readWork ? ' or preview size' : ''}.</p>}
    {needsSelection && <p className="property-hint">Create an active selection before using {mode === 'subtract' ? 'Subtract' : 'Intersect'}.</p>}
    {state === 'unconfirmed' && <p role="alert">The previous {producer === 'channel' ? 'channel' : 'Color Range'} Load result is unconfirmed. Review the current selection before loading again.</p>}
    <div className="channel-actions"><button className="button secondary" aria-expanded={open} disabled={frozen || !validSettings || !support.preview || !validEdge || !readWork} onClick={() => { setRequest(value => value + 1); setRequestedEpoch(epoch.current.value); setOpen(true); }}><ScanEye size={13} />Preview coverage</button><button className="button primary" disabled={frozen || Boolean(state) || !validSettings || !support.load || !loadWork || needsSelection} onClick={() => { if (settings) void load({ ...settings, colors: [...settings.colors], mode }); }}><Download size={13} />Load selection</button></div>
    <button className="button subtle wide" disabled={frozen || !capabilities.connected || !capabilityStrings(capabilities.commands).includes('get_document')} onClick={() => void review()}>Review current selection</button>
    {open && <div className="channel-preview"><strong>Color Range coverage before combination</strong>
      <div className="channel-preview-controls"><label className="field-label">Preview size<select aria-label="Color Range preview longest edge" value={edge} disabled={frozen} onChange={event => setEdge(Number(event.target.value))}>{!validEdge && <option value={edge} disabled>{edge} px · unavailable</option>}{sizes.map(size => <option key={size} value={size}>{size} px</option>)}</select></label><label className="field-label">View<select aria-label="Color Range preview view scale" value={scale} onChange={event => setScale(event.target.value)}><option value="fit">Fit</option><option value="actual">100% preview pixels</option></select></label></div>
      <div className={`channel-preview-image ${scale}`} aria-busy={loading} aria-label="Color Range coverage preview">{image && <img src={`data:image/png;base64,${image.data}`} alt={`${values.invert ? 'Inverted ' : ''}Color Range selection coverage`} width={image.width} height={image.height} onError={() => { if (latestToken.current === token) setResult({ key: token, error: 'The Color Range PNG could not be displayed. Preview again.' }); }} />}</div>
      <p className="property-hint" role={error ? 'alert' : 'status'} aria-live="polite">{image ? `${image.width} × ${image.height} px preview · ${image.sourceWidth} × ${image.sourceHeight} px canvas · revision ${image.revision}. ${image.width === image.sourceWidth && image.height === image.sourceHeight ? 'Native sampling.' : 'Nearest-sampled preview; small details may be omitted.'}` : `${previewStatus} ${document.width} × ${document.height} px canvas.`}</p>
      <button className="button subtle wide" onClick={() => setOpen(false)}>Hide Color Range preview</button>
    </div>}
    <details className="channel-help"><summary>How Color Range works</summary><p>Tolerance selects matching colors at full strength. Extra falloff fades coverage over an additional RGB distance. Both range from 0 to 255; their sum may exceed 255. Distance uses the greatest difference in encoded Red, Green or Blue bytes, and the closest sample wins. Similar colors elsewhere may also match.</p><p>Coverage is multiplied by composite alpha, then inverted if selected. Preview shows the new coverage before combination. Add keeps the greater coverage; Subtract removes it proportionally and Intersect multiplies it with the current selection.</p><p>The selected layer and active selection do not limit measurement. Load measures the full visible composite again at the current revision and changes only the selection, with Undo. Save Selection stores the resulting mask. Foreground copying does not sample the canvas.</p></details>
  </section>;
}
