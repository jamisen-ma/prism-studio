import { parseUnsharpDraft, type UnsharpDraft } from './unsharp';

const fields = [
  { key: 'amount', label: 'Amount, %', accessible: 'Unsharp amount percent', max: 500, step: '0.01', sliderStep: 1 },
  { key: 'sigma', label: 'Sigma, source px', accessible: 'Unsharp sigma source pixels', max: 50, step: 'any', sliderStep: .1 },
  { key: 'threshold', label: 'Threshold, per RGB channel', accessible: 'Unsharp threshold', max: 255, step: '1', sliderStep: 1 },
] as const;
export function UnsharpMaskControls({ draft, onChange, disabled = false, blendMode = 'normal' }: { draft: UnsharpDraft; onChange: (draft: UnsharpDraft) => void; disabled?: boolean; blendMode?: string }) {
  const parsed = parseUnsharpDraft(draft);
  return <div className="unsharp-controls" role="region" aria-label="Unsharp Mask settings">
    {fields.map(field => <div className="unsharp-control" key={field.key}><label className="field-label">{field.label}<input aria-label={field.accessible} disabled={disabled} type="number" min="0" max={field.max} step={field.step} value={draft[field.key]} onChange={event => onChange({ ...draft, [field.key]: event.target.value })} /></label><input aria-label={`${field.accessible} slider`} disabled={disabled} type="range" min="0" max={field.max} step={field.sliderStep} value={Number.isFinite(Number(draft[field.key])) ? Number(draft[field.key]) : 0} onChange={event => onChange({ ...draft, [field.key]: event.target.value })} /></div>)}
    <div className="spatial-filter-guidance"><p>Sharpens source RGB and preserves transparency.</p>{parsed && (parsed.amount === 0 || parsed.sigma === 0 || parsed.threshold === 255) && <p className="spatial-identity-note">{blendMode === 'normal' ? 'These settings leave pixels unchanged in Normal mode.' : 'These settings add no sharpening. Filter blending can still change colors.'} After saving, an enabled filter still belongs to the stack. Bake or Clear removes it before source editing.</p>}</div>
    <details className="unsharp-help"><summary>How Unsharp Mask works</summary><div className="spatial-filter-guidance"><p>Amount strengthens the RGB difference from an alpha-weighted Gaussian neighborhood. Filter opacity blends the finished result separately, after the selected filter blend.</p><p>Sharpening affects each RGB channel only when its difference is strictly greater than Threshold. Equal differences add no sharpening; filter blending can still change those channels.</p><p>Sigma uses source pixels before transforms. Alpha and the cutout silhouette stay unchanged; masks and layer opacity apply afterward.</p><p>Amount 0, Sigma 0 or Threshold 255 adds no sharpening. Very small positive sigma may also add none. Filter blending can still change colors.</p><p>Larger source images and sigma use more work. A limit refusal keeps the existing stack unchanged.</p></div></details>
  </div>;
}
