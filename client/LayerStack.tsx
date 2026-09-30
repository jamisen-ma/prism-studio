import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Eye, EyeOff, Folder, FolderOpen, FolderPlus, Layers, ListChecks, ShieldCheck, SlidersHorizontal, Type } from 'lucide-react';
import type { Backend, Document, Layer } from './api';
import type { RunCommand } from './CanvasTools';
import { displayLayers, hasProtectedContent, layerAncestors, layerSubtree } from './layer-tree';
import { LayerArrangement } from './LayerArrangement';
import { LayerStyles } from './LayerStyles';
import { LayerClipping } from './LayerClipping';
import { clippingChainFor, includesWholeChains } from './clipping';
import './layer-stack.css';

export function LayerStack({ document, selectedId, preview, busy, can, run, onSelect, capabilities }: { capabilities?: Backend; document: Document | null; selectedId: string; preview: string; busy: boolean; can: (name: string) => boolean; run: RunCommand; onSelect: (id: string) => void }) {
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [choosing, setChoosing] = useState(false);
  const [checked, setChecked] = useState(new Set<string>());
  const [destination, setDestination] = useState('');
  const [renaming, setRenaming] = useState('');
  const all = displayLayers(document), rows = displayLayers(document, collapsed);
  const selected = all.find(layer => layer.id === selectedId);
  const nativeGroups = document?.backend === 'native' && can('create_group');
  const nativeArrangement = document?.backend === 'native' && (can('align_layers') || can('distribute_layers'));
  const nativeStyles = document?.backend === 'native' && Boolean(capabilities?.layerStyleProperties?.length) && can('save_layer_style');
  const canChoose = document?.backend === 'native' && (can('group_layers') || nativeArrangement || nativeStyles || can('set_clipping_chain'));
  const nativeClipping = document?.backend === 'native' && capabilities?.clippingBlendPolicy === 'grouped-base' && can('set_clipping_chain');
  const selectedChain = document && clippingChainFor(document.layers, selected);
  const selectedSubtree = selected ? layerSubtree(document?.layers || [], selected) : [];
  const protectedContent = hasProtectedContent(document?.layers || [], selected);
  const destinations = all.filter(layer => layer.type === 'group' && !selectedSubtree.some(item => item.id === layer.id));
  const isolatedContext = (ancestors: Layer[]) => ancestors.filter(parent => parent.mode === 'isolated').map(parent => parent.id).reverse().join(':');
  const sourceContext = isolatedContext(layerAncestors(document?.layers || [], selected));
  const destinationReason = (layer?: Layer) => {
    if (!protectedContent) return '';
    const parents = layer ? [layer, ...layerAncestors(document?.layers || [], layer)] : [];
    if (parents.some(parent => parent.opacity !== 1 || parent.mode === 'isolated' && parent.blendMode !== 'normal')) return 'protected pixels require 100% opacity and normal blending';
    if (isolatedContext(parents) !== sourceContext) return 'protected pixels must stay in the same isolated context';
    return '';
  };
  const destinationBlocked = (layer?: Layer) => Boolean(destinationReason(layer));
  const picks = document?.layers.filter(layer => checked.has(layer.id)) || [];
  const parentId = picks[0]?.parentId || null;
  const siblings = document?.layers.filter(layer => (layer.parentId || null) === parentId) || [];
  const indices = picks.map(layer => siblings.findIndex(sibling => sibling.id === layer.id)).sort((a, b) => a - b);
  const wholeChains = includesWholeChains(document?.layers || [], picks);
  const validGroup = wholeChains && picks.length > 0 && picks.every(layer => (layer.parentId || null) === parentId) && indices.every((index, position) => index === indices[0] + position);
  const canUngroup = selected?.type === 'group' && (selectedSubtree.length === 1 || selected.mode !== 'isolated' && selected.visible && selected.opacity === 1 && !selected.mask);
  useEffect(() => { setDestination(selected?.parentId || ''); }, [selectedId, selected?.parentId]);
  useEffect(() => {
    setChecked(previous => new Set([...previous].filter(id => document?.layers.some(layer => layer.id === id))));
  }, [document?.revision]);
  const expandParents = (layers: Layer[], layer?: Layer) => setCollapsed(previous => {
    const next = new Set(previous);
    for (const parent of layerAncestors(layers, layer)) next.delete(parent.id);
    if (layer) next.delete(layer.id);
    return next;
  });
  const create = async (groupSelection: boolean) => {
    if (!document) return;
    const existing = new Set(document.layers.map(layer => layer.id));
    const result = await run(groupSelection ? 'group_layers' : 'create_group', groupSelection ? { layerIds: picks.map(layer => layer.id) } : { parentId: selected?.type === 'group' ? selected.id : selected?.parentId || null }, groupSelection ? 'Grouping selected layers' : 'Creating layer group');
    if (!result?.document) return;
    const group = result.document.layers.find(layer => layer.type === 'group' && !existing.has(layer.id));
    if (group) { expandParents(result.document.layers, group); onSelect(group.id); }
    setChecked(new Set()); setChoosing(false);
  };
  const move = async () => {
    if (!selected) return;
    const result = await run('move_layer', { layerId: selected.id, parentId: destination || null }, 'Moving layer into group');
    if (result?.document) expandParents(result.document.layers, result.document.layers.find(layer => layer.id === selected.id));
  };
  return <>
    {(nativeGroups || canChoose) && <div className="layer-group-toolbar">
      {nativeGroups && <button className="button mini secondary" disabled={busy} onClick={() => void create(false)}><FolderPlus size={13} />New group</button>}
      {canChoose && <button className={`button mini subtle ${choosing ? 'active' : ''}`} aria-pressed={choosing} disabled={busy} onClick={() => { setChoosing(!choosing); setChecked(new Set()); }}><ListChecks size={13} />{choosing ? 'Cancel selection' : 'Select layers'}</button>}
    </div>}
    <div className={`layer-list ${nativeGroups ? 'nested-layer-list' : ''}`}>{rows.map(layer => {
      const group = layer.type === 'group' || Boolean(layer.children?.length);
      const expanded = !collapsed.has(layer.id);
      return <div key={layer.id} data-layer-id={layer.id} data-layer-depth={layer.depth} style={{ marginLeft: layer.depth * 10 }} className={`layer-row ${selectedId === layer.id ? 'selected' : ''} ${!layer.visible ? 'invisible-layer' : ''}`} onClick={() => onSelect(layer.id)} role="button" tabIndex={0} onKeyDown={event => { if (event.target === event.currentTarget && ['Enter', ' '].includes(event.key)) { event.preventDefault(); onSelect(layer.id); } }}>
        {choosing && <input className="layer-group-checkbox" type="checkbox" aria-label={`Select layer ${layer.name}`} checked={checked.has(layer.id)} disabled={busy} onClick={event => event.stopPropagation()} onChange={event => setChecked(previous => { const next = new Set(previous); if (event.target.checked) next.add(layer.id); else next.delete(layer.id); return next; })} />}
        {group && <button className="layer-collapse" aria-label={`${expanded ? 'Collapse' : 'Expand'} ${layer.name}`} aria-expanded={expanded} onClick={event => { event.stopPropagation(); setCollapsed(previous => { const next = new Set(previous); if (expanded) next.add(layer.id); else next.delete(layer.id); return next; }); if (expanded && selected && layerAncestors(all, selected).some(parent => parent.id === layer.id)) onSelect(layer.id); }}>{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>}
        <button className="layer-eye" aria-label={`${layer.visible ? 'Hide' : 'Show'} ${layer.name}`} disabled={busy || !can('set_layer')} onClick={event => { event.stopPropagation(); void run('set_layer', { layerId: layer.id, visible: !layer.visible }); }}>{layer.visible ? <Eye size={14} /> : <EyeOff size={14} />}</button>
        <span className={`layer-thumb ${layer.type === 'adjustment' ? 'adjustment-thumb' : ''} ${group ? 'group-thumb' : ''}`}>{group ? expanded ? <FolderOpen size={18} /> : <Folder size={18} /> : layer.type === 'text' ? <Type size={19} /> : layer.type === 'adjustment' ? <SlidersHorizontal size={17} /> : <img src={preview || undefined} alt="" />}</span>
        <span className="layer-label">{renaming === layer.id ? <input className="layer-rename-input" aria-label={`Rename ${layer.name}`} autoFocus defaultValue={layer.name} maxLength={200} onClick={event => event.stopPropagation()} onFocus={event => event.currentTarget.select()} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter') event.currentTarget.blur(); else if (event.key === 'Escape') { event.currentTarget.value = layer.name; event.currentTarget.blur(); } }} onBlur={event => { const name = event.currentTarget.value.trim(); setRenaming(''); if (name && name !== layer.name) void run('set_layer', { layerId: layer.id, name }, 'Renaming layer'); }} /> : <span title="Double-click to rename" onDoubleClick={event => { if (busy || !can('set_layer')) return; event.stopPropagation(); onSelect(layer.id); setRenaming(layer.id); }}>{layer.name}</span>}<small>{({ group: layer.mode === 'isolated' ? 'Isolated group' : 'Pass-through group', adjustment: 'Adjustment layer', text: 'Text layer', shape: 'Vector shape', path: 'Vector path', gradient: 'Gradient layer', solid: 'Solid fill', raster: layer.role === 'cutout' ? 'Subject cutout' : layer.role === 'paint' ? 'Paint layer' : 'Image layer' } as Record<string, string>)[layer.type] || `${layer.type} layer`}</small></span>
        {layer.protected && <span className="layer-protection-badge" title="Original pixels protected" aria-label="Original pixels protected"><ShieldCheck size={12} /></span>}{layer.clipBaseId && <span className="layer-clipping-badge" title={`Clipped to ${document?.layers.find(base => base.id === layer.clipBaseId)?.name || 'base layer'}`} aria-label="Clipped layer">↳</span>}{(layer.mask || layer.alphaAsset) && <span className="layer-mask-badge" title="Layer mask" />}{selectedId === layer.id && <span className="layer-selected-dot" />}
      </div>;
    })}{!document && <div className="panel-empty"><Layers size={24} /><p>Your layers will appear here.</p></div>}</div>
    {choosing && <div className="layer-group-selection">{nativeArrangement && document && <LayerArrangement document={document} layers={picks} busy={busy} can={can} run={run} />}{can('group_layers') && <div className="layer-selection-grouping"><button className="button secondary wide" disabled={busy || !validGroup} onClick={() => void create(true)}><FolderPlus size={13} />Group selected ({picks.length})</button><p className="property-hint">{!wholeChains ? 'Select the complete clipping chain to group it, or release the chain first.' : picks.length && !validGroup ? 'Grouping needs consecutive layers with the same parent group.' : 'Grouping preserves the stacking order of consecutive sibling layers.'}</p></div>}</div>}
    {nativeClipping && document && <LayerClipping document={document} selected={selected} checked={picks} choosing={choosing} capabilities={capabilities!} busy={busy} run={run} onChoose={() => { setChoosing(true); setChecked(new Set()); }} />}
    {nativeStyles && document && <LayerStyles document={document} layer={selected} targets={choosing ? picks : selected ? [selected] : []} choosing={choosing} maxStyles={capabilities?.limits?.maxLayerStyles} busy={busy} can={can} run={run} />}
    {nativeGroups && selected && <div className="layer-group-properties">
      {can('move_layer') && <><label className="field-label">Parent group<select aria-label="Move to group" value={destination} disabled={busy || Boolean(selectedChain)} onChange={event => setDestination(event.target.value)}><option value="" disabled={destinationBlocked()}>Canvas root{destinationBlocked() ? " · protected context" : ""}</option>{destinations.map(layer => <option key={layer.id} value={layer.id} disabled={destinationBlocked(layer)}>{'› '.repeat(layer.depth)}{layer.name}{destinationBlocked(layer) ? ' · protected context' : ''}</option>)}</select></label><button className="button mini secondary wide" disabled={busy || Boolean(selectedChain) || destination === (selected.parentId || '') || destinationBlocked(destinations.find(layer => layer.id === destination)) || Boolean(destination && !destinations.some(layer => layer.id === destination))} onClick={() => void move()}>Move to selected group</button>{selectedChain && <p className="property-hint">Release this clipping chain before moving an individual participant to another group.</p>}{protectedContent && <p className="property-hint">Protected content can move only within the same isolated group context, through parents at 100% opacity with normal blending.</p>}</>}
      {selected.type === 'group' && <>{can('set_group_compositing') && capabilities?.groupModes?.includes('isolated') && <div className="group-compositing"><label className="field-label">Group compositing<select aria-label="Group compositing" value={selected.mode === 'isolated' ? `isolated:${selected.blendMode}` : 'pass-through'} disabled={busy || protectedContent} onChange={event => { const value = event.target.value; void run('set_group_compositing', { layerId: selected.id, mode: value === 'pass-through' ? 'pass-through' : 'isolated', blendMode: value === 'pass-through' ? 'normal' : value.slice(9) }, 'Changing group compositing'); }}><option value="pass-through">Pass through</option>{(capabilities.groupBlendModes || []).map(mode => <option key={mode} value={`isolated:${mode}`}>Isolated · {(mode.charAt(0).toUpperCase() + mode.slice(1)).replaceAll('_', ' ')}</option>)}</select></label><p className="property-hint">{selected.mode === 'isolated' ? 'Children blend on their own transparent surface. Adjustments stay inside this group; its result then blends with the canvas.' : 'Children blend with the canvas below. Adjustments can affect layers outside this group.'}</p>{protectedContent && <p className="property-hint">Protected descendants lock group compositing. Changing isolation or blending requires explicitly removing their protection.</p>}</div>}<p className="property-hint">{protectedContent ? "Group masks remain editable; protected descendants keep group opacity at 100%." : "Group masks and opacity remain editable. Children keep their own layers."}</p>{can('ungroup_layer') && <button className="button mini subtle wide" disabled={busy || !canUngroup} onClick={() => void run('ungroup_layer', { layerId: selected.id }, 'Ungrouping layers')}>Ungroup</button>}{!canUngroup && <p className="property-hint">To ungroup, use Pass through, show the group, set opacity to 100%, and remove its mask.</p>}{protectedContent && <p className="property-hint">Protected descendants keep this group at 100% opacity and prevent deletion.</p>}</>}
    </div>}
  </>;
}
