import { useEffect, useRef, useState } from 'react';
import { Download, ScanEye } from 'lucide-react';
import { command, type Backend, type ChannelPreview, type Document } from './api';
import { capabilityStrings, channelCapabilityKey, channelSupport, validateChannelPreview } from './dense-mask';
import type { ChannelDraft, SelectionProducer } from './useChannelSelection';
import './channel-selection.css';

type Props = { document: Document; capabilities: Backend; busy: boolean; load: (draft: ChannelDraft) => Promise<void>; review: () => Promise<void>; state?: 'pending' | 'unconfirmed'; reviewing: boolean; producer?: SelectionProducer };
export function ChannelSelection({ document, capabilities, busy, load, review, state, producer, reviewing }: Props) {
  const support = channelSupport(capabilities, document);
  const [draft, setDraft] = useState<ChannelDraft>({ channel: 'luma', mode: 'replace', invert: false });
  const [edge, setEdge] = useState(support.defaultEdge), [scale, setScale] = useState('fit');
  const [request, setRequest] = useState(0), [open, setOpen] = useState(false);
  const [result, setResult] = useState<{ key: string; image?: ChannelPreview; error?: string } | null>(null);
  const sizes = [...new Set([support.defaultEdge, Math.min(1400, support.maxEdge), support.maxEdge])].filter(size => size >= 32);
  const validEdge = sizes.includes(edge), capability = channelCapabilityKey(capabilities);
  const key = JSON.stringify([document.backend, document.id, document.revision, document.width, document.height, draft.channel, draft.invert, edge, capability, busy, reviewing]);
  const epoch = useRef({ key, value: 0 }); if (epoch.current.key !== key) epoch.current = { key, value: epoch.current.value + 1 };
  const latest = useRef(key); latest.current = key;
  const [requestedEpoch, setRequestedEpoch] = useState(-1);
  const eligible = open && requestedEpoch === epoch.current.value && support.preview && validEdge && !busy && !reviewing;
  const token = `${key}:${epoch.current.value}:${request}`;
  const latestToken = useRef(''); latestToken.current = eligible ? token : '';
  const image = eligible && result?.key === token ? result.image : undefined;
  const error = eligible && result?.key === token ? result.error : undefined;
  const loading = eligible && result?.key !== token;
  const previewStatus = error || (!support.preview ? 'Channel preview is unavailable with this connection.' : !validEdge ? 'This preview size is unavailable. Choose an advertised size.' : !eligible ? 'The document or settings changed. Preview the current revision.' : 'Loading channel coverage…');
  useEffect(() => {
    if (!eligible) return;
    const abort = new AbortController(), version = epoch.current.value;
    const owned = () => !abort.signal.aborted && latest.current === key && latestToken.current === token && epoch.current.value === version;
    setResult(null);
    void command<ChannelPreview>('native', 'get_channel_preview', { documentId: document.id, expectedRevision: document.revision, channel: draft.channel, invert: draft.invert, maxEdge: edge }, abort.signal).then(async value => {
      if (!owned()) return;
      validateChannelPreview(value, document, draft.channel, draft.invert, edge, support.maxBytes);
      const decoded = new Image(); decoded.src = `data:image/png;base64,${value.data}`; await decoded.decode();
      if (!owned()) return;
      if (decoded.naturalWidth !== value.width || decoded.naturalHeight !== value.height) throw Error('The channel PNG dimensions do not match the captured preview. Preview again.');
      setResult({ key: token, image: value });
    }).catch(error => { if (owned()) setResult({ key: token, error: error instanceof Error ? error.message : 'Channel coverage could not be read.' }); });
    return () => abort.abort();
  }, [token, eligible]);
  const preview = () => { setRequest(value => value + 1); setRequestedEpoch(epoch.current.value); setOpen(true); };
  const frozen = busy || reviewing || state === 'pending', needsSelection = ['subtract', 'intersect'].includes(draft.mode) && !document.selection;
  return <section className="channel-selection" aria-label="Selection from composite channel">
    <div className="section-heading"><span>From composite channel</span><ScanEye size={14} /></div>
    <p className="property-hint">Build a selection from the visible composite. White selects fully; gray selects partially.</p>
    <label className="field-label">Channel<select aria-label="Composite selection channel" value={draft.channel} disabled={frozen} onChange={event => setDraft({ ...draft, channel: event.target.value as ChannelDraft['channel'] })}>{[['red', 'Red'], ['green', 'Green'], ['blue', 'Blue'], ['luma', 'Encoded luma'], ['alpha', 'Alpha']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <label className="field-label">Combine<select aria-label="Channel selection combination" value={draft.mode} disabled={frozen} onChange={event => setDraft({ ...draft, mode: event.target.value as ChannelDraft['mode'] })}><option value="replace">Replace active selection</option><option value="add">Add to active selection</option><option value="subtract">Subtract from active selection</option><option value="intersect">Intersect with active selection</option></select></label>
    <label className="channel-invert"><input aria-label="Invert channel coverage" type="checkbox" checked={draft.invert} disabled={frozen} onChange={event => setDraft({ ...draft, invert: event.target.checked })} />Invert coverage</label>
    {draft.invert && <p className="property-hint">Inversion also selects fully transparent pixels.</p>}
    {!support.semantic && <p className="inline-panel-error">Channel selections are unavailable with this connection. Your settings are retained.</p>}
    {needsSelection && <p className="property-hint">Create an active selection before using {draft.mode === 'subtract' ? 'Subtract' : 'Intersect'}.</p>}
    {state === 'unconfirmed' && <p role="alert">The previous {producer === 'color-range' ? 'Color Range' : 'channel'} Load result is unconfirmed. Review the current selection before loading again.</p>}
    <div className="channel-actions"><button className="button secondary" aria-expanded={open} disabled={frozen || !support.preview || !validEdge} onClick={preview}><ScanEye size={13} />Preview coverage</button><button className="button primary" disabled={frozen || Boolean(state) || !support.load || needsSelection} onClick={() => void load({ ...draft })}><Download size={13} />Load selection</button></div>
    <button className="button subtle wide" disabled={frozen || !capabilityStrings(capabilities.commands).includes('get_document')} onClick={() => void review()}>Review current selection</button>
    {open && <div className="channel-preview">
      <strong>Channel coverage before combination</strong>
      <div className="channel-preview-controls"><label className="field-label">Preview size<select aria-label="Channel preview longest edge" value={edge} disabled={frozen} onChange={event => setEdge(Number(event.target.value))}>{!validEdge && <option value={edge} disabled>{edge} px · unavailable</option>}{sizes.map(size => <option key={size} value={size}>{size} px</option>)}</select></label><label className="field-label">View<select aria-label="Channel preview view scale" value={scale} onChange={event => setScale(event.target.value)}><option value="fit">Fit</option><option value="actual">100% preview pixels</option></select></label></div>
      <div className={`channel-preview-image ${scale}`} aria-busy={loading} aria-label="Channel coverage preview">{image && <img src={`data:image/png;base64,${image.data}`} alt={`${draft.invert ? 'Inverted ' : ''}${draft.channel} composite channel coverage`} width={image.width} height={image.height} onError={() => { if (latestToken.current === token) setResult({ key: token, error: 'The channel PNG could not be displayed. Preview again.' }); }} />}</div>
      <p className="property-hint" role={error ? 'alert' : 'status'} aria-live="polite">{image ? `${image.width} × ${image.height} px preview · ${image.sourceWidth} × ${image.sourceHeight} px canvas · revision ${image.revision}. ${image.width === image.sourceWidth && image.height === image.sourceHeight ? 'Native sampling.' : 'Nearest-sampled preview; small details may be omitted.'}` : `${previewStatus} ${document.width} × ${document.height} px canvas.`}</p>
      <button className="button subtle wide" onClick={() => setOpen(false)}>Hide channel preview</button>
    </div>}
    <details className="channel-help"><summary>How channel coverage works</summary><p>Uses the final visible composite, including adjustments, masks and effects. The selected layer and current selection do not limit measurement.</p><p>Red, Green and Blue coverage is multiplied by composite alpha. Encoded luma rounds the weighted RGB brightness to a byte first, then multiplies by alpha. Alpha uses transparency directly. Inversion happens last.</p><p>Add keeps the greater coverage. Subtract retains the current selection in proportion to one minus channel coverage; Intersect multiplies both. Preview shows the channel before this combination.</p><p>Load measures full-resolution pixels again at the current revision. It changes only the selection and can be undone. Save the selection explicitly to reuse it.</p></details>
  </section>;
}
