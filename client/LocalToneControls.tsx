import { parseLocalToneDraft, type LocalToneDraft } from './local-tone';
import './local-tone.css';

const fields = [
  { key: 'shadows', label: 'Amount, %', accessible: 'Local shadow amount percent', min: 0 },
  { key: 'highlights', label: 'Amount, %', accessible: 'Local highlight amount percent', min: 0 },
  { key: 'shadowWidth', label: 'Tonal width, %', accessible: 'Local shadow tonal width percent', min: 1 },
  { key: 'highlightWidth', label: 'Tonal width, %', accessible: 'Local highlight tonal width percent', min: 1 },
] as const;
export function LocalToneControls({ draft, onChange, disabled = false, blendMode = 'normal' }: { draft: LocalToneDraft; onChange: (draft: LocalToneDraft) => void; disabled?: boolean; blendMode?: string }) {
  const parsed = parseLocalToneDraft(draft);
  return <div className="local-tone-controls" role="region" aria-label="Local Shadows / Highlights settings">
    <div className="local-tone-grid"><strong>Shadows</strong><strong>Highlights</strong>{fields.map(field => <label className="field-label" key={field.key}>{field.label}<input aria-label={field.accessible} disabled={disabled} type="number" min={field.min} max="100" step="0.01" value={draft[field.key]} onChange={event => onChange({ ...draft, [field.key]: event.target.value })} /></label>)}</div>
    <label className="field-label local-tone-sigma">Sigma, source px<input aria-label="Local tone sigma source pixels" disabled={disabled} type="number" min="0" max="50" step="any" value={draft.sigma} onChange={event => onChange({ ...draft, sigma: event.target.value })} /></label>
    <div className="spatial-filter-guidance"><p>Balances source tones using nearby brightness. Transparency stays unchanged.</p>{parsed?.shadows === 0 && parsed.highlights === 0 && <p className="spatial-identity-note">{blendMode === 'normal' ? 'Both Amounts are 0: colors stay unchanged in Normal mode.' : 'Both Amounts are 0: the candidate is unchanged, but filter blending can still change colors.'} An enabled filter still belongs to the stack. Bake or Clear removes it before source editing.</p>}</div>
    <details className="local-tone-help"><summary>How Local Shadows / Highlights works</summary><div className="spatial-filter-guidance">
      <p>Tonal width controls how far Shadows or Highlights reaches toward other tones. The native brightness map has 256 encoded-RGB levels; this is not subject isolation. Strong local settings can create halos or change hue and saturation.</p>
      <p>Sigma uses source pixels before transforms. Sigma 0 uses each pixel’s own tone and can still change colors. Tiny positive sigma may use the same neighborhood while keeping its authored value and work charge.</p>
      <p>The native candidate preserves black 0 and white 255 channels; it cannot reconstruct clipped detail. Amount changes that candidate. Filter blend mode and opacity act afterward.</p>
      <p>Alpha and hidden RGB stay intact. The whole source neighborhood participates. Filter effect mask controls the completed stack afterward; it does not isolate the neighborhood. The additional layer mask controls visibility.</p>
      <p>Larger source images and sigma use more work. A limit refusal keeps the saved stack and your draft unchanged. Reduce settings explicitly before applying again.</p>
    </div></details>
  </div>;
}
