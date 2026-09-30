import { CHANNEL_SELECTION_CHANNELS, CHANNEL_SELECTION_POLICY, DENSE_MASK_POLICY, DENSE_MASK_LIMITS, CHANNEL_PREVIEW_LIMITS, normalizeDenseMaskDescriptor } from '../shared/dense-mask.mjs';
import type { AdditionalMask, Backend, ChannelPreview, ChannelSelectionChannel, Document, Mask } from './api';

const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
export const capabilityStrings = (value: unknown): string[] => Array.isArray(value) && value.every(item => typeof item === 'string') ? value : [];
const strings = capabilityStrings;
export const denseMaskSource = (mask?: AdditionalMask | null): Mask | null => mask?.shape === 'positioned' ? mask.source : mask || null;
export const isDenseMask = (mask?: AdditionalMask | null) => denseMaskSource(mask)?.shape === 'alpha8';
export const maskShapeLabel = (mask: Mask) => mask.shape === 'alpha8' || mask.shape === 'bitmap' ? 'Pixel mask' : mask.shape === 'polygon' ? 'Lasso' : mask.shape === 'ellipse' ? 'Ellipse' : 'Rectangle';
export const denseCapabilityKey = (c?: Backend) => JSON.stringify([c?.id, c?.connected, c?.denseMaskPolicy, c?.denseMaskLimits]);
export const channelCapabilityKey = (c?: Backend) => JSON.stringify([denseCapabilityKey(c), c?.commands, c?.channelSelectionPolicy, c?.channelSelectionChannels, c?.channelPreviewLimits]);
/** Submission ownership ignores unrelated producer command changes. */
export const channelSubmissionCapabilityKey = (c?: Backend) => JSON.stringify([denseCapabilityKey(c), ['load_channel_selection', 'get_channel_preview'].map(command => strings(c?.commands).includes(command)), c?.channelSelectionPolicy, c?.channelSelectionChannels, c?.channelPreviewLimits]);
export function supportsDenseMasks(c?: Backend): boolean {
  const l = c?.denseMaskLimits;
  return Boolean(c?.id === 'native' && c.connected && c.denseMaskPolicy === DENSE_MASK_POLICY && l && l.headerBytes === 32 &&
    ['maxDimension', 'maxPixels', 'maxWorkingBytes', 'maxPrepareWork', 'maxHistoryAssets', 'maxHistoryBytes', 'yieldVisits'].every(key => integer(l[key as keyof typeof l]) && l[key as keyof typeof l]! <= DENSE_MASK_LIMITS[key as keyof typeof DENSE_MASK_LIMITS]) &&
    l.maxDimension! <= 8192 && l.maxPixels! <= 24_000_000 && l.maxHistoryBytes! >= 33);
}
export function supportsMask(mask: AdditionalMask | null | undefined, c?: Backend): boolean {
  const source = denseMaskSource(mask);
  if (source?.shape !== 'alpha8') return true;
  if (!supportsDenseMasks(c)) return false;
  try { normalizeDenseMaskDescriptor(source, { persisted: true }); } catch { return false; }
  return source.width <= c!.denseMaskLimits!.maxDimension! && source.height <= c!.denseMaskLimits!.maxDimension! && source.width * source.height <= c!.denseMaskLimits!.maxPixels! && source.bytes <= c!.denseMaskLimits!.maxHistoryBytes!;
}
export function channelSupport(c?: Backend, document?: Pick<Document, 'backend' | 'width' | 'height'> | null) {
  const l = c?.channelPreviewLimits;
  const semantic = Boolean(supportsDenseMasks(c) && c?.channelSelectionPolicy === CHANNEL_SELECTION_POLICY && CHANNEL_SELECTION_CHANNELS.every(channel => strings(c.channelSelectionChannels).includes(channel)) && (!document || document.backend === 'native' && document.width <= c!.denseMaskLimits!.maxDimension! && document.height <= c!.denseMaskLimits!.maxDimension! && document.width * document.height <= c!.denseMaskLimits!.maxPixels!));
  const readLimits = Boolean(l && Object.values(l).every(integer) && ['maxEdge', 'defaultMaxEdge', 'maxBytes', 'maxWorkingBytes', 'yieldVisits'].every(key => integer(l[key as keyof typeof l]) && l[key as keyof typeof l]! <= CHANNEL_PREVIEW_LIMITS[key as keyof typeof CHANNEL_PREVIEW_LIMITS]) && l.maxEdge! >= 32 && l.defaultMaxEdge! >= 32 && l.defaultMaxEdge! <= l.maxEdge!);
  return { semantic, load: semantic && strings(c?.commands).includes('load_channel_selection'), preview: semantic && readLimits && strings(c?.commands).includes('get_channel_preview'), maxEdge: readLimits ? l!.maxEdge! : 0, defaultEdge: readLimits ? l!.defaultMaxEdge! : 700, maxBytes: readLimits ? l!.maxBytes! : 0 };
}
export const previewDimensions = (width: number, height: number, maxEdge: number) => {
  const longest = Math.max(width, height), size = (n: number) => maxEdge >= longest ? n : Math.max(1, Math.floor((2 * n * maxEdge + longest) / (2 * longest)));
  return { width: size(width), height: size(height) };
};
export function validateChannelPreview(result: ChannelPreview, doc: Pick<Document, 'id' | 'revision' | 'width' | 'height'>, channel: ChannelSelectionChannel, invert: boolean, maxEdge: number, maxBytes: number) {
  const size = previewDimensions(doc.width, doc.height, maxEdge);
  if (result.documentId !== doc.id || result.revision !== doc.revision || result.sourceWidth !== doc.width || result.sourceHeight !== doc.height || result.width !== size.width || result.height !== size.height || result.channel !== channel || result.invert !== invert || result.maxEdge !== maxEdge || result.coveragePolicy !== CHANNEL_SELECTION_POLICY || result.sampling !== 'nearest-pixel-center' || result.mimeType !== 'image/png' || typeof result.data !== 'string' || !result.data.length || result.data.length > Math.ceil(maxBytes / 3) * 4) throw Error('The channel response does not match this document, revision or coverage request. Preview again.');
}

/** Only masks actually consumed by this operation; independent Replace never samples the old selection. */
export function denseCommandMasks(name: string, args: Record<string, unknown>, document: Document): AdditionalMask[] {
  const masks: AdditionalMask[] = [], add = (mask: unknown) => { if (mask && typeof mask === 'object' && 'shape' in mask && isDenseMask(mask as AdditionalMask)) masks.push(mask as AdditionalMask); };
  const layer = document.layers.find(item => item.id === args.layerId);
  if (['modify_selection', 'morph_selection', 'save_selection', 'mask_from_selection', 'refine_cutout_from_selection', 'paint_stroke', 'fill_area'].includes(name) || name === 'add_adjustment' && !('mask' in args) || name === 'import_color_lookup' && args.target === 'adjustment' && !args.layerId || name === 'paint_selection' && args.mode !== 'replace' || ['load_selection', 'load_layer_selection', 'load_channel_selection', 'load_color_range_selection', 'select_color'].includes(name) && (args.mode ?? 'replace') !== 'replace' || name === 'set_layer_filter_mask' && args.source === 'selection') add(document.selection);
  if (name === 'add_adjustment' || name === 'set_layer_mask' || name === 'set_layer_filter_mask') add(args.mask);
  if (name === 'load_selection') add(document.savedSelections?.find(item => item.id === args.selectionId)?.mask);
  if (['update_adjustment', 'modify_layer_mask', 'morph_layer_mask', 'set_layer_mask_position', 'apply_layer_mask_position'].includes(name) || name === 'paint_mask' && args.mode !== 'replace' || name === 'load_layer_selection' && args.source === 'layer-mask') add(layer?.mask);
  if (['modify_layer_filter_mask', 'add_layer_filter', 'update_layer_filter', 'reorder_layer_filter', 'bake_layer_filters'].includes(name) || name === 'import_color_lookup' && args.target === 'layer-filter' || name === 'delete_layer_filter' && (layer?.filters?.length || 0) > 1) add(layer?.filterMask?.coverage);
  if (['crop_document', 'resize_canvas', 'resize_document'].includes(name)) { add(document.selection); document.savedSelections?.forEach(item => add(item.mask)); document.layers.forEach(item => { add(item.mask); add(item.filterMask?.coverage); }); }
  return masks;
}

/** Tints selected coverage and traces a dashed black/white edge (marching ants) where coverage crosses 50%. */
export function paintSelectionCoverage(data: Uint8ClampedArray, width: number, height: number, coverage: (index: number) => number) {
  const inside = new Uint8Array(width * height);
  for (let i = 0; i < inside.length; i++) inside[i] = coverage(i) >= 128 ? 1 : 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x, o = i * 4, value = coverage(i);
    const edge = inside[i] && (x === 0 || y === 0 || x === width - 1 || y === height - 1 || !inside[i - 1] || !inside[i + 1] || !inside[i - width] || !inside[i + width]);
    if (edge) { const light = ((x + y) >> 2) % 2 === 0 ? 255 : 20; data[o] = light; data[o + 1] = light; data[o + 2] = light; data[o + 3] = 255; }
    else { data[o] = 187; data[o + 1] = 151; data[o + 2] = 234; data[o + 3] = Math.round(value * .24); }
  }
}
