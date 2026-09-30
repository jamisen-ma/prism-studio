import { useMemo, useState } from 'react';
import { ArrowUpRight, Check, CircleHelp, Search, SlidersHorizontal } from 'lucide-react';

export type CatalogEntry = { id: string; name: string; category: string; source?: string; engine?: 'native'; command?: string; tool?: string; status: 'available' | 'partial' | 'planned'; note?: string };

const PAINT = [
  ['brush', 'Brush', 'Paint pressure-sensitive strokes on a raster layer.'], ['pencil', 'Pencil', 'Draw crisp strokes with a hard tip.'], ['eraser', 'Eraser', 'Erase target pixels to transparency.'],
  ['clone', 'Clone stamp', 'Alt-click a source, then copy pixels from the visible composite.'], ['heal', 'Healing brush', 'Blend sampled texture into the target area.'], ['dodge', 'Dodge', 'Lighten pixels along your stroke.'], ['burn', 'Burn', 'Darken pixels along your stroke.'],
  ['blur', 'Blur brush', 'Soften details along your stroke.'], ['sharpen', 'Sharpen brush', 'Sharpen details along your stroke.'], ['smudge', 'Smudge', 'Drag pixels along your stroke.'], ['sponge', 'Sponge', 'Increase or decrease local saturation.'], ['red_eye', 'Red eye', 'Reduce red coloration in painted pupil areas.'], ['color_replace', 'Color replacement', 'Replace pixels near the sampled color.'],
] as const;
const BASE_CATALOG: CatalogEntry[] = [
  ...PAINT.map(([tool, name, note]) => ({ id: tool, name, note, tool, category: ['brush', 'pencil', 'eraser'].includes(tool) ? 'Painting' : 'Retouching', command: 'paint_stroke', status: 'available' as const })),
  { id: 'rectangle', name: 'Rectangular marquee', category: 'Selections', command: 'select_rectangle', tool: 'select', status: 'available', note: 'Drag a rectangle; refine its feathering or invert it.' },
  { id: 'ellipse', name: 'Elliptical marquee', category: 'Selections', command: 'select_region', tool: 'ellipse', status: 'available', note: 'Create an elliptical selection.' },
  { id: 'lasso', name: 'Lasso', category: 'Selections', command: 'select_region', tool: 'lasso', status: 'available', note: 'Draw a closed polygon around your subject.' },
  { id: 'crop', name: 'Crop', category: 'Composition', command: 'crop_document', tool: 'crop', status: 'available' },
  { id: 'transform', name: 'Layer transform', category: 'Composition', command: 'transform_layer', status: 'available', note: 'Move, scale, rotate, or flip the selected layer.' },
  { id: 'resize', name: 'Image size', category: 'Composition', command: 'resize_document', status: 'available' },
  { id: 'text', name: 'Horizontal type', category: 'Typography', command: 'add_text', tool: 'text', status: 'available', note: 'Create text, then edit typography in layer properties.' },
  { id: 'adjustments', name: 'Color adjustments', category: 'Color', command: 'add_adjustment', status: 'available' },
  { id: 'hand', name: 'Hand', category: 'Navigation', tool: 'hand', status: 'available' },
  { id: 'zoom', name: 'Zoom', category: 'Navigation', tool: 'zoom', status: 'available' },
];

export function ToolBrowser({ catalog, backend, commands, canOpen, onChoose }: { catalog?: CatalogEntry[]; backend: 'native' | 'photoshop'; commands: string[]; canOpen: (entry: CatalogEntry) => boolean; onChoose: (entry: CatalogEntry) => void }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All tools');
  const [onlyAvailable, setOnlyAvailable] = useState(false);
  const entries = catalog || BASE_CATALOG;
  const available = (entry: CatalogEntry) => entry.status !== 'planned' && (!entry.engine || entry.engine === backend) && (!entry.command || commands.includes(entry.command)) && canOpen(entry);
  const photoshopCount = entries.filter((entry) => entry.source && !entry.engine).length;
  const nativeCount = entries.filter((entry) => entry.engine === 'native').length;
  const categories = ['All tools', ...new Set(entries.map((entry) => entry.category))];
  const filtered = useMemo(() => entries.filter((entry) => (category === 'All tools' || entry.category === category) && `${entry.name} ${entry.category} ${entry.note || ''}`.toLowerCase().includes(query.toLowerCase()) && (!onlyAvailable || available(entry))), [entries, backend, category, query, onlyAvailable, commands, canOpen]);
  return <><span className="eyebrow">YOUR CREATIVE TOOLKIT</span><h1 id="modal-title">Find the right tool.</h1><p className="modal-intro">Browse editing tools and see what this engine supports. Available tools open their actual editing controls.</p>{nativeCount > 0 && <p className="catalog-inventory">{photoshopCount} Photoshop reference tools · {nativeCount} separate Prism Native capabilities</p>}<div className="tools-search"><Search size={15} /><input autoFocus aria-label="Search editing tools" placeholder="Search tools, techniques, and categories…" value={query} onChange={(event) => setQuery(event.target.value)} /></div><div className="catalog-filters"><select aria-label="Tool category" value={category} onChange={(event) => setCategory(event.target.value)}>{categories.map((name) => <option key={name}>{name}</option>)}</select><label><input type="checkbox" checked={onlyAvailable} onChange={(event) => setOnlyAvailable(event.target.checked)} />Available here</label><span>{filtered.length} tools</span></div><div className="tool-catalog">{filtered.map((entry) => {
    const enabled = available(entry);
    return <div className="catalog-entry" key={entry.id}><button className="catalog-tool" disabled={!enabled} onClick={() => onChoose(entry)}>{enabled ? <SlidersHorizontal size={17} /> : <CircleHelp size={17} />}<span><strong>{entry.name}</strong><small>{entry.engine === 'native' && <b className="catalog-engine">Prism Native · </b>}{entry.note || entry.category}</small></span>{enabled ? <span className="catalog-available">{entry.status === 'partial' ? 'Limited' : 'Open'}<ArrowUpRight size={11} /></span> : <span className="catalog-unavailable">{entry.status === 'planned' ? 'Not implemented yet' : entry.engine && entry.engine !== backend ? 'Prism Native only' : 'Unavailable in this engine'}</span>}</button>{entry.source && <a className="catalog-source" href={entry.source} target="_blank" rel="noreferrer" aria-label={`${entry.name}: Adobe reference`}>Adobe reference<ArrowUpRight size={10} /></a>}</div>;
  })}{!filtered.length && <p className="catalog-note">No matching tools. Try another name or category.</p>}</div><p className="catalog-note">{backend === 'native' ? 'Prism’s standalone tools preserve editable projects and undo history. Tool availability reflects this local editor’s current capabilities.' : 'This optional Photoshop connection exposes only the tools its connected plugin supports.'}</p></>;
}
