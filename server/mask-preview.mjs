import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import sharp from 'sharp';
import { normalizeMask, maskCoverage } from './masks.mjs';
import { layerMaskCoverage, rawLayerMaskCoverage, validateAdditionalLayerMask, layerMaskStorageBytes } from './layer-mask.mjs';
import { storedFilterMask, normalizeFilterMask, prepareFilterMaskBytes } from './filter-mask.mjs';
import { prepareMaskCoverage, prepareLayerMaskCoverage, prepareRawLayerMaskCoverage } from './dense-mask.mjs';

export const MASK_PREVIEW_SOURCES = Object.freeze(['selection', 'layer-mask', 'filter-mask']);
export const MASK_PREVIEW_MASK_MODES = Object.freeze(['raw', 'effective']);
export const MASK_PREVIEW_LIMITS = Object.freeze({ maxEdge: 2400, defaultMaxEdge: 700, maxBytes: 8 * 1024 * 1024, maxWorkingBytes: 256 * 1024 * 1024, yieldRows: 32 });
const fail = (message, code = 'INVALID_ARGUMENT') => { throw Object.assign(new Error(message), { code }); };

export function maskPreviewDimensions(sourceWidth, sourceHeight, maxEdge = MASK_PREVIEW_LIMITS.defaultMaxEdge) {
  if (![sourceWidth, sourceHeight].every(value => Number.isInteger(value) && value >= 1 && value <= 8192) || sourceWidth * sourceHeight > 24_000_000)
    fail('Mask dimensions exceed native image limits.', 'LIMIT_EXCEEDED');
  if (!Number.isInteger(maxEdge) || maxEdge < 32 || maxEdge > MASK_PREVIEW_LIMITS.maxEdge)
    fail('Mask preview maxEdge must be an integer from 32 to 2400.');
  const longest = Math.max(sourceWidth, sourceHeight);
  if (longest <= maxEdge) return { width: sourceWidth, height: sourceHeight };
  // Exact rational half-up rounding avoids IEEE drift at authored half pixels
  // (420 × 840 at edge 457 must be 229 × 457, not 228 × 457).
  const rounded = value => Math.max(1, Math.floor((2 * value * maxEdge + longest) / (2 * longest)));
  return { width: rounded(sourceWidth), height: rounded(sourceHeight) };
}

/** Conservative explicit buffer/transfer ledger, not total process RSS. Keep
 * coverage construction storage through encoding, even though feather distance
 * data may become unreachable sooner. Reserve a grayscale plane, 4P codec
 * surface, full encoded cap, two UTF16 base64/JSON copies and a UTF8 transfer.
 * JS graph/polygon caches and native codec caches are separately bounded. */
export function estimateMaskPreviewBytes({ graph, mask, source = 'selection', maskMode = 'effective', density = 1, enabled = true, maxEdge = MASK_PREVIEW_LIMITS.defaultMaxEdge }) {
  const { width, height } = maskPreviewDimensions(graph.width, graph.height, maxEdge), count = width * height;
  const bypass = maskMode === 'effective' && (source === 'layer-mask' && density === 0 || source === 'filter-mask' && (!enabled || density === 0));
  const coverageBytes = bypass ? 0 : layerMaskStorageBytes({ mask }, { raw: true });
  const lutBytes = source === 'filter-mask' && maskMode === 'effective' && !bypass && density < 1 ? 256 : 0;
  const sampledBytes = count, codecBytes = 4 * count, encodedBytes = MASK_PREVIEW_LIMITS.maxBytes;
  const base64Bytes = 4 * Math.ceil(encodedBytes / 3), transferBytes = 5 * base64Bytes;
  return { width, height, coverageBytes, sampledBytes, codecBytes, encodedBytes, base64Bytes, transferBytes,
    ...(source === 'filter-mask' ? { lutBytes } : {}), estimatedWorkingBytes: coverageBytes + lutBytes + sampledBytes + codecBytes + encodedBytes + transferBytes, maxWorkingBytes: MASK_PREVIEW_LIMITS.maxWorkingBytes };
}

/** Read only the chosen descriptor; no RGB renderer, asset reader, model,
 * project/cache writer or source-alpha preview is involved. */
export async function renderMaskPreview(graph, args = {}, { resolveAlpha8 } = {}) {
  const source = args.source === undefined ? 'selection' : args.source, maskMode = args.maskMode === undefined ? 'effective' : args.maskMode,
    maxEdge = args.maxEdge === undefined ? MASK_PREVIEW_LIMITS.defaultMaxEdge : args.maxEdge;
  if (!MASK_PREVIEW_SOURCES.includes(source)) fail('Mask preview source must be selection, layer-mask or filter-mask.');
  if (!MASK_PREVIEW_MASK_MODES.includes(maskMode)) fail('Mask preview mode must be raw or effective.');
  if (source === 'selection' && (args.layerId !== undefined || args.maskMode !== undefined)) fail('Layer and mask mode apply only to the layer-mask source.');
  let layer, mask, filterMask, sourceWidth = graph.width, sourceHeight = graph.height;
  if (source === 'selection') {
    mask = graph.selection;
    if (!mask) fail('Create a selection before inspecting its coverage.', 'NO_SELECTION');
  } else {
    if (typeof args.layerId !== 'string' || !args.layerId) fail('Choose a layer to inspect its additional mask.');
    layer = graph.layers.find(item => item.id === args.layerId);
    if (!layer) fail('Layer was not found.', 'NOT_FOUND');
    if (source === 'filter-mask') {
      const stored = storedFilterMask(layer.filters);
      if (!stored) fail('Create a shared filter mask before inspecting its coverage.', 'NO_FILTER_MASK');
      if (layer.type !== 'raster') fail('Filter-mask inspection requires a raster layer.', 'INVALID_TARGET');
      filterMask = normalizeFilterMask(stored, layer.width, layer.height);
      mask = filterMask.coverage; sourceWidth = layer.width; sourceHeight = layer.height;
    } else {
      mask = layer.mask;
      if (!mask) fail('Create an additional layer mask before inspecting its coverage.', 'NO_MASK');
      validateAdditionalLayerMask(layer, graph.width, graph.height);
    }
  }
  const dimensions = maskPreviewDimensions(sourceWidth, sourceHeight, maxEdge);
  if (source === 'selection') {
    const normalized = normalizeMask(mask, graph.width, graph.height, { persisted: true });
    if (['bitmap', 'alpha8'].includes(normalized.shape) && (normalized.width !== graph.width || normalized.height !== graph.height)) fail('Mask preview dimensions must match the canvas.');
  }
  const estimate = estimateMaskPreviewBytes({ graph: { width: sourceWidth, height: sourceHeight }, mask, source, maskMode, density: filterMask?.density ?? layer?.maskDensity ?? 1, enabled: filterMask?.enabled ?? true, maxEdge });
  if (estimate.estimatedWorkingBytes > estimate.maxWorkingBytes) fail('The mask preview exceeds the 256 MiB working-buffer limit.', 'LIMIT_EXCEEDED');
  const coverage = filterMask ? await prepareFilterMaskBytes(filterMask, { raw: maskMode === 'raw', resolveAlpha8 }) : source === 'layer-mask'
    ? await (maskMode === 'effective' ? prepareLayerMaskCoverage(layer, resolveAlpha8) : prepareRawLayerMaskCoverage(layer, resolveAlpha8)) : await prepareMaskCoverage(mask, resolveAlpha8);
  const { width, height } = dimensions, gray = Buffer.allocUnsafe(width * height);
  for (let y = 0; y < height; y++) {
    const sourceY = Math.min(sourceHeight - 1, Math.floor(((2 * y + 1) * sourceHeight) / (2 * height)));
    for (let x = 0; x < width; x++) {
      const sourceX = Math.min(sourceWidth - 1, Math.floor(((2 * x + 1) * sourceWidth) / (2 * width)));
      gray[y * width + x] = filterMask ? coverage(sourceX, sourceY) : Math.max(0, Math.min(255, Math.round(255 * coverage(sourceX, sourceY))));
    }
    if ((y + 1) % MASK_PREVIEW_LIMITS.yieldRows === 0) await yieldEventLoop();
  }
  let data;
  try {
    // Explicit b-w prevents sharp from expanding a single-channel input to RGB
    // before encoding. No ICC/color metadata or palette quantization is added.
    data = await sharp(gray, { raw: { width, height, channels: 1 }, limitInputPixels: 24_000_000 })
      .toColourspace('b-w').png({ compressionLevel: 6, adaptiveFiltering: false, palette: false }).toBuffer();
  } catch { fail('The mask preview could not be encoded.', 'INVALID_IMAGE'); }
  if (!Buffer.isBuffer(data) || data.length > MASK_PREVIEW_LIMITS.maxBytes) fail('The mask preview exceeds the 8 MiB encoded-image limit.', 'LIMIT_EXCEEDED');
  return { data, mimeType: 'image/png', width, height, sourceWidth, sourceHeight, source, ...(filterMask ? { coordinates: 'source' } : {}),
    ...(layer ? { layerId: layer.id, maskMode } : {}), sampling: 'nearest-pixel-center', maxEdge };
}
