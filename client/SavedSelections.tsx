import { maskShapeLabel, supportsMask } from './dense-mask';
import { useEffect, useState, type ReactNode } from 'react';
import { Check, Download, Pencil, Save, SquareDashed, Trash2 } from 'lucide-react';
import type { Backend, Document, Mask } from './api';
import type { RunCommand } from './CanvasTools';
import './saved-selections.css';
import { MaskEdges } from './MaskEdges';

function describe(mask: Mask) {
  if (mask.shape === 'bitmap' && !mask.invert && Array.isArray(mask.runs) && mask.runs.length === 0) return 'Empty selection · no pixels selected';
  const shape = maskShapeLabel(mask);
  return `${shape} · ${mask.width} × ${mask.height}${mask.feather ? ` · ${mask.feather}px feather` : ''}${mask.invert ? ' · inverted' : ''}`;
}

export function SavedSelections({ document, selection, busy, can, run, onEdit, morphologyOperations = [], maxMorphologyRadius, sourceSection, onInspect, capabilities }: { capabilities?: Backend; document: Document | null; selection: Mask | null; busy: boolean; can: (name: string) => boolean; run: RunCommand; onEdit: () => void; morphologyOperations?: string[]; maxMorphologyRadius?: number; sourceSection?: ReactNode; onInspect?: () => void }) {
  const saved = document?.savedSelections || [];
  const [name, setName] = useState('');
  const [selectedId, setSelectedId] = useState(saved[0]?.id || '');
  const selected = saved.find(item => item.id === selectedId);
  const [rename, setRename] = useState(selected?.name || '');
  const [mode, setMode] = useState<'replace' | 'add' | 'subtract' | 'intersect'>('replace');
  useEffect(() => { if (!saved.some(item => item.id === selectedId)) setSelectedId(saved[0]?.id || ''); }, [document?.revision, selectedId]);
  useEffect(() => { setRename(selected?.name || ''); }, [selected?.id, selected?.name]);
  const activeSupported = supportsMask(selection, capabilities), savedSupported = supportsMask(selected?.mask, capabilities);
  const needsActive = mode === 'subtract' || mode === 'intersect';
  const save = async () => {
    const ids = new Set(saved.map(item => item.id));
    const result = await run('save_selection', name.trim() ? { name: name.trim() } : {}, 'Saving reusable selection');
    if (result?.document) { const created = result.document.savedSelections?.find(item => !ids.has(item.id)); if (created) setSelectedId(created.id); setName(''); }
  };
  const load = async () => {
    if (!selected || !savedSupported || mode !== 'replace' && !activeSupported) return;
    const result = await run('load_selection', { selectionId: selected.id, mode }, 'Loading saved selection');
    if (result) onEdit();
  };
  return <div className="saved-selections-panel">
    <section className="panel-section"><div className="section-heading"><span>Active selection</span><SquareDashed size={14} /></div>
      <p className="property-hint">{selection ? describe(selection) : 'Draw or paint a selection on the canvas, or load one from your library.'}</p>
      <button className="button secondary wide" disabled={!document || busy} onClick={onEdit}><Pencil size={12} />{selection ? 'Refine on canvas' : 'Draw a selection'}</button>
      {onInspect && <button className="button subtle wide mask-inspection-entry" disabled={!selection || busy} onClick={onInspect}>Inspect coverage</button>}
      {!activeSupported && <p className="property-hint">This connection cannot refine or copy this pixel selection. It may still be replaced or cleared.</p>}{sourceSection}
      {can('morph_selection') && <MaskEdges exists={Boolean(selection)} busy={busy || !activeSupported} operations={morphologyOperations} maxRadius={maxMorphologyRadius} run={run} />}
      {can('save_selection') && <><label className="field-label saved-selection-name">Selection name <span className="optional">Optional</span><input aria-label="New saved selection name" maxLength={120} value={name} disabled={!document || busy} onChange={event => setName(event.target.value)} placeholder={`Selection ${saved.length + 1}`} onKeyDown={event => { if (event.key === 'Enter' && activeSupported && selection && saved.length < 16 && !busy && can('save_selection')) { event.preventDefault(); void save(); } }} /></label>
      <button className="button primary wide" disabled={!activeSupported || !selection || busy || saved.length >= 16 || !can('save_selection')} onClick={() => void save()}><Save size={12} />Save current selection</button>
      {saved.length >= 16 && <p className="property-hint saved-selection-limit">All 16 slots are used. Update an existing entry or delete one to make room.</p>}</>}
    </section>
    {(can('save_selection') || can('load_selection')) && <section className="panel-section"><div className="section-heading"><span>Saved selections</span><span className="count-badge">{saved.length} / 16</span></div>
      <div className="saved-selection-list" role="listbox" aria-label="Saved selections">{saved.map(item => <button key={item.id} type="button" role="option" aria-selected={selectedId === item.id} className={`saved-selection-item ${selectedId === item.id ? 'selected' : ''}`} onClick={() => setSelectedId(item.id)}><SquareDashed size={15} /><span><strong>{item.name}</strong><small>{describe(item.mask)}</small></span>{selectedId === item.id && <Check size={12} />}</button>)}</div>
      {!saved.length && <p className="property-hint">Save areas you want to reuse for masks, adjustments, fills, or AI edits. Each document has its own library.</p>}
      {selected && <div className="saved-selection-properties">
        <label className="field-label">Load into active selection<select aria-label="Saved selection combination" value={mode} disabled={busy} onChange={event => setMode(event.target.value as typeof mode)}><option value="replace">Replace active selection</option><option value="add">Add to active selection</option><option value="subtract">Subtract from active selection</option><option value="intersect">Intersect with active selection</option></select></label>
        <button className="button secondary wide" disabled={busy || !savedSupported || mode !== 'replace' && !activeSupported || !can('load_selection') || needsActive && !selection} onClick={() => void load()}><Download size={12} />Load selection</button>
        {needsActive && !selection && <p className="property-hint saved-selection-limit">Create an active selection before using {mode === 'subtract' ? 'Subtract' : 'Intersect'}.</p>}
        <p className="property-hint saved-selection-copy-note">Loading creates an editable selection. Your saved copy changes only when you update it.</p>
        <button className="button subtle wide" disabled={busy || !activeSupported || !selection || !can('save_selection')} onClick={() => void run('save_selection', { selectionId: selected.id }, 'Updating saved selection')}><Save size={12} />Update from active selection</button>
        <div className="saved-selection-rename"><label className="field-label">Saved name<input aria-label="Saved selection name" value={rename} maxLength={120} disabled={busy} onChange={event => setRename(event.target.value)} /></label><button className="button mini secondary" disabled={busy || !rename.trim() || rename.trim() === selected.name || !can('rename_selection')} onClick={() => void run('rename_selection', { selectionId: selected.id, name: rename.trim() }, 'Renaming saved selection')}>Rename</button></div>
        <button className="button subtle wide" disabled={busy || !can('delete_selection')} onClick={() => void run('delete_selection', { selectionId: selected.id }, 'Deleting saved selection')}><Trash2 size={12} />Delete saved selection</button>
        <p className="property-hint saved-selection-undo-note">Library changes can be undone with your document history.</p>
      </div>}
    </section>}
  </div>;
}
