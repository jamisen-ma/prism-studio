import { effectiveLayerFill } from './layer-fill';
import { useEffect, useState } from 'react';
import { Check, ChevronDown, Palette, Save, Trash2 } from 'lucide-react';
import type { Document, Layer, SavedLayerStyle } from './api';
import type { RunCommand } from './CanvasTools';
import { hasEnabledOutsideStyle } from './layer-style-settings';
import './layer-styles.css';

const content = (layer?: Layer) => Boolean(layer && ['raster', 'solid', 'text', 'shape', 'path', 'gradient'].includes(layer.type));
const enabledStyle = (layer?: Layer) => Boolean(content(layer) && layer && hasEnabledOutsideStyle(layer));
function StyleSettings({ style }: { style: SavedLayerStyle }) {
  return <ul className="saved-style-settings">
    <li>{style.outline ? <><i style={{ background: style.outline.color }} />Outline · {style.outline.width} px · {style.outline.color}</> : 'Outline · cleared'}</li>
    <li>{style.effects?.shadow ? <><i style={{ background: style.effects.shadow.color }} />Shadow · {Math.round(style.effects.shadow.opacity * 100)}% · {style.effects.shadow.blur} px blur · {style.effects.shadow.x}, {style.effects.shadow.y} px</> : 'Shadow · cleared'}</li>
    <li>{style.effects?.glow ? <><i style={{ background: style.effects.glow.color }} />Glow · {Math.round(style.effects.glow.opacity * 100)}% · {style.effects.glow.blur} px blur</> : 'Glow · cleared'}</li>
  </ul>;
}

export function LayerStyles({ document, layer, targets, choosing, maxStyles = 32, busy, can, run }: { document: Document; layer?: Layer; targets: Layer[]; choosing: boolean; maxStyles?: number; busy: boolean; can: (name: string) => boolean; run: RunCommand }) {
  const styles = document.layerStyles || [];
  const [open, setOpen] = useState(false), [name, setName] = useState('');
  const [styleId, setStyleId] = useState(styles[0]?.id || '');
  const selected = styles.find(style => style.id === styleId);
  const [rename, setRename] = useState(selected?.name || '');
  useEffect(() => { if (!styles.some(style => style.id === styleId)) setStyleId(styles[0]?.id || ''); }, [document.revision, styleId]);
  useEffect(() => { setRename(selected?.name || ''); }, [selected?.id, selected?.name]);
  const canCapture = enabledStyle(layer);
  const targetError = targets.some(target => target.clipBaseId) ? 'Release clipping before applying outside styles to an upper clipped layer.' : !targets.length ? choosing ? 'Check content layers above to apply a saved style.' : 'Select a content layer to apply a saved style.' : targets.some(target => !content(target)) ? 'Choose individual content layers. Groups and adjustments cannot receive styles.' : targets.length > 64 ? 'Choose up to 64 content layers.' : '';
  const save = async () => {
    if (!layer || !canCapture || busy || styles.length >= maxStyles) return;
    const previousIds = new Set(styles.map(style => style.id));
    const result = await run('save_layer_style', { layerId: layer.id, ...(name.trim() ? { name: name.trim() } : {}) }, 'Saving layer style');
    if (result?.document) { const created = result.document.layerStyles?.find(style => !previousIds.has(style.id)); if (created) setStyleId(created.id); setName(''); }
  };
  return <section className="layer-styles" aria-label="Saved layer styles">
    <button className="saved-styles-heading" aria-expanded={open} onClick={() => setOpen(!open)}><Palette size={14} /><span>Saved layer styles</span><small>{styles.length} / {maxStyles}</small><ChevronDown size={13} className={open ? 'expanded' : ''} /></button>
    {open && <div className="saved-styles-body">
      <p className="property-hint">Save outside outlines, shadows and glows from the selected layer. Settings use canvas pixels.</p>
      {layer && effectiveLayerFill(layer) !== 1 && <p className="property-hint">Layer Fill is not included; the target keeps its own Fill.</p>}
      <p className="saved-style-source">Source: <strong>{layer?.name || 'No layer selected'}</strong></p>
      <form onSubmit={event => { event.preventDefault(); void save(); }}><label className="field-label">New style name <span className="optional">Optional</span><input aria-label="New layer style name" maxLength={200} value={name} disabled={busy} onChange={event => setName(event.target.value)} placeholder="My layer style" /></label><button className="button secondary wide" type="submit" disabled={busy || !canCapture || styles.length >= maxStyles || !can('save_layer_style')}><Save size={12} />Save style from selected layer</button></form>
      {!canCapture && <p className="property-hint saved-style-eligibility">Select a content layer with a nonzero outline, shadow or glow. Hidden layers can also supply settings.</p>}
      {styles.length >= maxStyles && <p className="property-hint saved-style-eligibility">All {maxStyles} slots are used. Overwrite or delete a saved style to make room.</p>}
      {styles.length > 0 ? <div className="saved-style-editor">
        <label className="field-label">Style library<select aria-label="Saved layer style" value={selected?.id || ''} disabled={busy} onChange={event => setStyleId(event.target.value)}>{styles.map(style => <option key={style.id} value={style.id}>{style.name}</option>)}</select></label>
        {selected && <><StyleSettings style={selected} />
          <p className="saved-style-replaces">Applying replaces the outline, shadow and glow. Missing settings clear existing effects. Pixels, overall opacity, Fill, blending, masks and filters stay unchanged.</p>
          <button className="button primary wide" disabled={busy || Boolean(targetError) || !can('apply_layer_style')} onClick={() => void run('apply_layer_style', { styleId: selected.id, layerIds: targets.map(target => target.id) }, 'Applying saved layer style')}><Check size={12} />{choosing ? `Apply style to checked layers (${targets.length})` : 'Apply style to selected layer'}</button>
          {targetError && <p className="property-hint saved-style-eligibility">{targetError}</p>}
          <button className="button subtle wide" disabled={busy || !canCapture || !can('save_layer_style')} onClick={() => layer && void run('save_layer_style', { layerId: layer.id, styleId: selected.id }, 'Overwriting saved layer style')}><Save size={12} />Overwrite style from selected layer</button>
          <div className="saved-style-rename"><label className="field-label">Saved name<input aria-label="Saved layer style name" maxLength={200} value={rename} disabled={busy} onChange={event => setRename(event.target.value)} /></label><button className="button mini secondary" disabled={busy || !rename.trim() || rename.trim() === selected.name || !can('rename_layer_style')} onClick={() => void run('rename_layer_style', { styleId: selected.id, name: rename.trim() }, 'Renaming saved layer style')}>Rename style</button></div>
          <button className="button subtle wide" disabled={busy || !can('delete_layer_style')} onClick={() => void run('delete_layer_style', { styleId: selected.id }, 'Deleting saved layer style')}><Trash2 size={12} />Delete saved style</button>
        </>}
      </div> : <p className="property-hint">No styles saved in this document yet.</p>}
      <p className="property-hint saved-style-copy-note">Each document has its own library, included in .prism projects. Applied styles are independent copies; overwriting or deleting a preset leaves existing layers unchanged. Library and apply actions can be undone.</p>
    </div>}
  </section>;
}
