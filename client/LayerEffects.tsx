import { useEffect, useState } from 'react';
import { Check, Layers, Trash2 } from 'lucide-react';
import type { Layer, LayerEffects as Effects } from './api';
import type { RunCommand } from './CanvasTools';

const SHADOW = { color: '#000000', opacity: 0.35, blur: 8, x: 4, y: 6 };
const GLOW = { color: '#ffffff', opacity: 0.5, blur: 8 };
const inRange = (value: number, min: number, max: number) => Number.isFinite(value) && value >= min && value <= max;

export function LayerEffects({ layer, busy, run }: { layer: Layer; busy: boolean; run: RunCommand }) {
  const [shadowEnabled, setShadowEnabled] = useState(Boolean(layer.effects?.shadow));
  const [glowEnabled, setGlowEnabled] = useState(Boolean(layer.effects?.glow));
  const [shadow, setShadow] = useState({ ...SHADOW, ...layer.effects?.shadow });
  const [glow, setGlow] = useState({ ...GLOW, ...layer.effects?.glow });
  useEffect(() => {
    setShadowEnabled(Boolean(layer.effects?.shadow)); setGlowEnabled(Boolean(layer.effects?.glow));
    setShadow({ ...SHADOW, ...layer.effects?.shadow }); setGlow({ ...GLOW, ...layer.effects?.glow });
  }, [layer.id, JSON.stringify(layer.effects)]);
  const clipped = Boolean(layer.clipBaseId);
  const effects: Effects | null = shadowEnabled || glowEnabled ? { ...(shadowEnabled ? { shadow } : {}), ...(glowEnabled ? { glow } : {}) } : null;
  const current = layer.effects ? { ...(layer.effects.shadow ? { shadow: layer.effects.shadow } : {}), ...(layer.effects.glow ? { glow: layer.effects.glow } : {}) } : null;
  const dirty = JSON.stringify(effects) !== JSON.stringify(current);
  const valid = (!shadowEnabled || inRange(shadow.opacity, 0, 1) && inRange(shadow.blur, 0, 64) && inRange(shadow.x, -256, 256) && inRange(shadow.y, -256, 256)) && (!glowEnabled || inRange(glow.opacity, 0, 1) && inRange(glow.blur, 0, 64));
  return <section className="panel-section layer-effects" aria-label="Layer effects">
    <div className="section-heading"><span>Layer effects</span><Layers size={14} /></div>
    <fieldset disabled={busy || clipped}><label className="effect-toggle"><input aria-label="Drop shadow" type="checkbox" checked={shadowEnabled} onChange={event => setShadowEnabled(event.target.checked)} /><span>Drop shadow</span></label>
      {shadowEnabled && <div className="effect-parameters">
        <label>Color<input aria-label="Shadow color" type="color" value={shadow.color} onChange={event => setShadow({ ...shadow, color: event.target.value })} /></label>
        <label>Opacity, %<input aria-label="Shadow opacity" type="number" min="0" max="100" step="1" value={Math.round(shadow.opacity * 100)} onChange={event => setShadow({ ...shadow, opacity: Number(event.target.value) / 100 })} /></label>
        <label>Blur, px<input aria-label="Shadow blur" type="number" min="0" max="64" step="1" value={shadow.blur} onChange={event => setShadow({ ...shadow, blur: Number(event.target.value) })} /></label>
        <label>X offset, px<input aria-label="Shadow X offset" type="number" min="-256" max="256" step="1" value={shadow.x} onChange={event => setShadow({ ...shadow, x: Number(event.target.value) })} /></label>
        <label>Y offset, px<input aria-label="Shadow Y offset" type="number" min="-256" max="256" step="1" value={shadow.y} onChange={event => setShadow({ ...shadow, y: Number(event.target.value) })} /></label>
      </div>}
      <label className="effect-toggle"><input aria-label="Outer glow" type="checkbox" checked={glowEnabled} onChange={event => setGlowEnabled(event.target.checked)} /><span>Outer glow</span></label>
      {glowEnabled && <div className="effect-parameters">
        <label>Color<input aria-label="Glow color" type="color" value={glow.color} onChange={event => setGlow({ ...glow, color: event.target.value })} /></label>
        <label>Opacity, %<input aria-label="Glow opacity" type="number" min="0" max="100" step="1" value={Math.round(glow.opacity * 100)} onChange={event => setGlow({ ...glow, opacity: Number(event.target.value) / 100 })} /></label>
        <label>Blur, px<input aria-label="Glow blur" type="number" min="0" max="64" step="1" value={glow.blur} onChange={event => setGlow({ ...glow, blur: Number(event.target.value) })} /></label>
      </div>}
    </fieldset>
    {!valid && <p className="inline-panel-error">Use 0–100% opacity, 0–64 px blur and offsets between −256 and 256 px.</p>}
    <div className="effect-actions"><button className="button secondary" disabled={busy || clipped || !valid || !dirty} onClick={() => void run('set_layer_effects', { layerId: layer.id, effects }, 'Applying layer effects')}><Check size={12} />Apply effects</button><button className="button subtle" disabled={busy || !layer.effects} onClick={() => void run('set_layer_effects', { layerId: layer.id, effects: null }, 'Clearing layer effects')}><Trash2 size={12} />Clear effects</button></div>
    {clipped && <p className="property-hint">Release clipping before adding outside effects to an upper clipped layer. The base can retain its own effects.</p>}
    <p className="property-hint">Editable effects sit outside the visible content. Blur and offsets use canvas pixels; canvas edges clip the result.</p>
  </section>;
}
