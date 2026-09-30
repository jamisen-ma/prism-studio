import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Backend, Document, Layer } from './api';
import type { RunCommand } from './CanvasTools';
import { captureGesture } from './gesture';
import { effectiveLayerFill, fillCapabilityKey, fillPercent, layerFillReason, parseFillDraft } from './layer-fill';
import './layer-fill.css';

type Props = { document: Document; layer: Layer; capabilities?: Backend; busy: boolean; run: RunCommand; opacityControl: ReactNode };
type Draft = { revision: number; saved: number; text: string };
export function LayerFill({ document, layer, capabilities, busy, run, opacityControl }: Props) {
  const saved = effectiveLayerFill(layer), reason = layerFillReason(document, layer, capabilities);
  const [draft, updateDraft] = useState<Draft>({ revision: document.revision, saved, text: fillPercent(saved) });
  const draftRef = useRef(draft), alive = useRef(true), accepted = useRef<Document | null>(null);
  const [pending, setPending] = useState(false), pendingRef = useRef(false);
  const key = JSON.stringify([document.backend, document.id, layer.id, layer.type, fillCapabilityKey(capabilities), reason]);
  const epoch = useRef({ key, value: 0 }); if (epoch.current.key !== key) epoch.current = { key, value: epoch.current.value + 1 };
  const latest = useRef({ document, layer, busy, reason }); latest.current = { document, layer, busy, reason };
  const setDraft = (next: Draft) => { draftRef.current = next; updateDraft(next); };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const current = draftRef.current;
    if (current.revision === document.revision || accepted.current?.revision === document.revision) return;
    if (parseFillDraft(current.text, current.saved) === current.saved) setDraft({ revision: document.revision, saved, text: saved === current.saved ? current.text : fillPercent(saved) });
  }, [document.revision, saved]);
  const parsed = parseFillDraft(draft.text, draft.saved), dirty = parsed === undefined || parsed !== draft.saved;
  const stale = draft.revision !== document.revision && accepted.current?.revision !== document.revision;
  const frozen = busy || pending || Boolean(reason), editable = !frozen && !stale;
  const reload = () => { if (busy || pending) return; accepted.current = null; setDraft({ revision: document.revision, saved, text: fillPercent(saved) }); };
  const apply = async () => {
    const current = latest.current, captured = draftRef.current, value = parseFillDraft(captured.text, captured.saved);
    if (current.busy || pendingRef.current || current.reason || current.document.revision !== captured.revision || value === undefined || value === captured.saved) return;
    const version = epoch.current.value;
    const owned = () => alive.current && epoch.current.value === version;
    pendingRef.current = true; setPending(true); accepted.current = null;
    try {
      const result = await run('set_layer_fill', { layerId: current.layer.id, fillOpacity: value }, 'Applying layer Fill', {
        ...captureGesture(current.document, current.layer.id), isCurrent: owned,
        fill: { value, acceptDocument: next => {
          if (!owned() || next.id !== current.document.id || next.backend !== current.document.backend || next.revision !== captured.revision + 1 || !next.layers.some(item => item.id === current.layer.id && item.type === current.layer.type && effectiveLayerFill(item) === value)) return false;
          accepted.current = next; return true;
        } },
      });
      if (owned() && result?.document && (accepted.current as Document | null) === result.document) setDraft({ revision: result.document.revision, saved: value, text: captured.text });
    } finally {
      accepted.current = null; pendingRef.current = false;
      if (alive.current) setPending(false);
    }
  };
  return <section className="layer-fill-controls" aria-label="Layer Fill and opacity">
    <div className="layer-opacity-fields">{opacityControl}<label>Fill<input aria-label="Layer Fill percent" aria-describedby="layer-fill-description" type="text" inputMode="decimal" value={draft.text} disabled={frozen} aria-invalid={parsed === undefined} onChange={event => setDraft({ ...draft, text: event.target.value })} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void apply(); } }} /><span>%</span></label></div>
    <div className="layer-fill-actions"><button className="button mini secondary" disabled={!editable || !dirty || parsed === undefined} onClick={() => void apply()}>Apply Fill</button><button className="button mini subtle" disabled={!editable} onClick={() => setDraft({ ...draft, text: '100' })}>Reset to 100%</button></div>
    <p id="layer-fill-description" className="property-hint">Fill fades the layer content. Overall Opacity also fades its outside styles.</p>
    {reason && <p className="property-hint layer-fill-reason">{reason}</p>}
    {stale && <p className="inline-panel-error" role="status">The layer changed. Reload saved Fill before applying another value; your draft is retained.</p>}
    {parsed === undefined && <p className="inline-panel-error" role="status">Enter a finite percentage from 0 to 100. Values are not rounded or clamped.</p>}
    {(stale || dirty || reason) && <button className="button mini subtle" disabled={busy || pending} onClick={reload}>Reload saved Fill</button>}
    {(parsed === 0 || saved === 0) && <p className="property-hint">At 0% Fill, only enabled outside styles can remain visible.</p>}
    {layer.opacity === 0 && <p className="property-hint">Overall Opacity is 0%, so both content and outside styles are hidden.</p>}
    <details className="layer-fill-help"><summary>How Layer Fill works</summary><p>Outside outlines, shadows and glows use the original unfilled silhouette. Fill does not add inner effects or reveal a shadow through the former body.</p><p>Fill is separate from vector fill color. Both a shape’s painted fill and its intrinsic stroke fade together. Source pixels, masks, RGB filters and geometry remain editable; baking filters keeps Fill as a layer setting.</p><p>Layer-content selections measure source transparency and ignore Fill. Composite channel selections and visible-composite sampling see its rendered result. Placement keeps the unfilled silhouette; a 0% Fill layer has no visible body bounds for arrangement.</p><p>Saved layer styles and recipes do not capture Fill. Their targets keep their own Fill. Editable .prism projects retain it; the current layered PSD subset requires 100% Fill.</p></details>
  </section>;
}
