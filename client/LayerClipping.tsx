import { ArrowDownToLine, Layers, Link2, Unlink } from 'lucide-react';
import type { Backend, Document, Layer } from './api';
import type { RunCommand } from './CanvasTools';
import { clippingChainFor, clippingSelectionError } from './clipping';
import './layer-clipping.css';

export function LayerClipping({ document, selected, checked, choosing, capabilities, busy, run, onChoose }: { document: Document; selected?: Layer; checked: Layer[]; choosing: boolean; capabilities: Backend; busy: boolean; run: RunCommand; onChoose: () => void }) {
  const chain = clippingChainFor(document.layers, selected), base = checked[0], members = checked.slice(1);
  const existing = base && clippingChainFor(document.layers, base);
  const error = clippingSelectionError(document.layers, checked, capabilities.clippingLayerTypes || []);
  const same = Boolean(existing && base && existing.base.id === base.id && existing.members.length === members.length && existing.members.every((layer, index) => layer.id === members[index]?.id));
  return <section className="layer-clipping" aria-label="Layer clipping">
    <div className="section-heading"><span>Clipping chain</span><Layers size={14} /></div>
    {chain && <div className="current-clipping-chain"><strong>Base: {chain.base.name}</strong><span>{chain.members.length} upper {chain.members.length === 1 ? 'layer' : 'layers'} clipped to its transparency</span><p className="property-hint">{selected?.id === chain.base.id ? 'Moving this base moves the clipping window. Its preview shows the assembled chain.' : 'Moving this member moves its image inside the base. Its preview shows only its clipped contribution.'}</p><button className="button secondary wide" disabled={busy} onClick={() => void run('set_clipping_chain', { baseLayerId: chain.base.id, layerIds: [] }, 'Releasing clipping chain')}><Unlink size={12} />Release clipping chain</button><p className="property-hint">Release can reveal the upper layers outside the base. Undo restores the chain. Release before individual reorder, regroup, duplicate, delete, arrange, extract or place.</p></div>}
    {choosing ? <><p className="clipping-proposed-base"><ArrowDownToLine size={12} /><span>Lowest checked layer: <strong>{base?.name || 'None'}</strong></span></p>{members.length > 0 && <p className="property-hint">Upper members: {members.map(layer => layer.name).join(', ')}.</p>}{error && <p className="clipping-eligibility" role="status">{error}</p>}<button className="button secondary wide" disabled={busy || Boolean(error) || Boolean(same)} onClick={() => base && void run('set_clipping_chain', { baseLayerId: base.id, layerIds: members.map(layer => layer.id) }, existing ? 'Replacing clipping chain' : 'Creating clipping chain')}><Link2 size={12} />{existing ? 'Replace clipping chain' : 'Create clipping chain'}</button>{existing && <p className="property-hint">Replacing uses exactly these checked members and releases old members omitted from the selection.</p>}</> : <button className="button subtle wide" disabled={busy} onClick={onChoose}><Link2 size={12} />Choose layers for clipping</button>}
    <p className="property-hint">The base keeps its soft transparency. Upper layers fill inside it; base opacity and blending apply to the assembled result. Source pixels and editable layers stay intact.</p>
  </section>;
}
