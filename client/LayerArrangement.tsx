import { useState } from 'react';
import { AlignHorizontalJustifyStart, AlignHorizontalJustifyCenter, AlignHorizontalJustifyEnd, AlignVerticalJustifyStart, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd } from 'lucide-react';
import type { Document, Layer } from './api';
import type { RunCommand } from './CanvasTools';
import { clippingChainFor } from './clipping';
import { layerAncestors } from './layer-tree';

export function LayerArrangement({ document, layers, busy, can, run }: { document: Document; layers: Layer[]; busy: boolean; can: (name: string) => boolean; run: RunCommand }) {
  const [relativeTo, setRelativeTo] = useState<'canvas' | 'layers'>('canvas');
  const [spacing, setSpacing] = useState<'centers' | 'gaps'>('gaps');
  const unsupported = layers.some(layer => layer.type === 'group' || layer.type === 'adjustment');
  const hidden = layers.some(layer => !layer.visible || layer.opacity <= 0);
  const masked = layers.some(layer => layer.mask);
  const blockedParent = layers.some(layer => layerAncestors(document.layers, layer).some(parent => !parent.visible || parent.opacity !== 1 || parent.mask));
  const isolatedParent = layers.some(layer => layerAncestors(document.layers, layer).some(parent => parent.mode === 'isolated'));
  const clipped = layers.some(layer => clippingChainFor(document.layers, layer));
  const reason = clipped ? 'Release clipping chains before arranging their layers.' : unsupported ? 'Choose content layers. Groups and adjustments cannot be arranged.' : hidden ? 'Show every selected layer and give it nonzero opacity before arranging.' : masked ? 'Layers with an additional layer mask cannot be arranged yet.' : blockedParent ? 'Parent groups must be visible, at 100% opacity, and have no masks.' : isolatedParent ? 'Move these layers outside isolated groups before arranging them.' : '';
  const alignDisabled = busy || Boolean(reason) || layers.length < (relativeTo === 'layers' ? 2 : 1);
  const distributeDisabled = busy || Boolean(reason) || layers.length < 3;
  const layerIds = layers.map(layer => layer.id);
  return <div className="layer-arrangement"><div className="section-heading"><span>Arrange selected layers</span><span className="count-badge">{layers.length}</span></div>
    {can('align_layers') && <><label className="field-label">Align relative to<select aria-label="Layer alignment reference" value={relativeTo} disabled={busy} onChange={event => setRelativeTo(event.target.value as typeof relativeTo)}><option value="canvas">Canvas</option><option value="layers">Selected layer bounds</option></select></label>
      <div className="layer-align-grid" role="group" aria-label="Align selected layers">{([
        ['horizontal', 'start', 'Left', AlignHorizontalJustifyStart], ['horizontal', 'center', 'Center', AlignHorizontalJustifyCenter], ['horizontal', 'end', 'Right', AlignHorizontalJustifyEnd],
        ['vertical', 'start', 'Top', AlignVerticalJustifyStart], ['vertical', 'center', 'Middle', AlignVerticalJustifyCenter], ['vertical', 'end', 'Bottom', AlignVerticalJustifyEnd],
      ] as const).map(([axis, alignment, label, Icon]) => <button key={label} className="button mini secondary" aria-label={`Align layers ${label.toLowerCase()}`} disabled={alignDisabled} onClick={() => void run('align_layers', { layerIds, axis, alignment, relativeTo }, 'Aligning selected layers')}><Icon size={14} />{label}</button>)}</div>
      {relativeTo === 'layers' && layers.length < 2 && !reason && <p className="property-hint">Select at least two content layers to align to their combined bounds.</p>}
    </>}
    {can('distribute_layers') && <><label className="field-label layer-spacing-label">Distribute by<select aria-label="Layer distribution spacing" value={spacing} disabled={busy} onChange={event => setSpacing(event.target.value as typeof spacing)}><option value="gaps">Equal gaps</option><option value="centers">Even centers</option></select></label><div className="layer-distribute-actions">{(['horizontal', 'vertical'] as const).map(axis => <button key={axis} className="button mini secondary" aria-label={`Distribute layers ${axis}`} disabled={distributeDisabled} onClick={() => void run('distribute_layers', { layerIds, axis, spacing }, 'Distributing selected layers')}>{axis === 'horizontal' ? 'Horizontal' : 'Vertical'}</button>)}</div><p className="property-hint">Select at least three layers. The outer layers stay fixed; positions round to whole pixels.</p></>}
    {reason && <p className="arrangement-eligibility" role="status">{reason}</p>}
    <p className="property-hint arrangement-bounds-note">Uses visible content bounds, excluding outlines, shadows, and glows. Protected cutouts keep their source pixels.</p>
  </div>;
}
