// Controlled export only: no PSD parser, decompressor, canvas, file or network
// access. Layout follows Adobe's public PSD v1 specification; raw channels are
// independently exercised with Pillow and psd-tools.
import { layerFillOpacity, layerOutsideEffects } from './layer-fill.mjs';
export const PSD_EXPORT_LIMITS = Object.freeze({ maxOutputBytes: 64 * 1024 * 1024, maxWorkingBytes: 256 * 1024 * 1024, maxDimension: 8192, maxPixels: 24_000_000, maxLayers: 64, maxIccBytes: 64 * 1024 });
export const PSD_MIME_TYPE = 'image/vnd.adobe.photoshop';
const validObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, report) => { throw Object.assign(new Error(message), { code, ...(report ? { report } : {}) }); };
const check = (valid, message) => { if (!valid) fail('INVALID_ARGUMENT', message); };
const aligned = (bytes, alignment) => Math.ceil(bytes / alignment) * alignment;
const validName = (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 200 && value.isWellFormed() && !/[\u0000-\u001f\u007f]/.test(value);

function exactOpacity(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return false;
  const quantized = Math.round(value * 255) / 255;
  return value === quantized || Math.abs(value - quantized) <= Number.EPSILON * Math.max(Math.abs(value), Math.abs(quantized));
}

function layerLayout(layer, pixelCount) {
  const hasMask = layer.mask !== undefined && layer.mask !== null;
  const nameBytes = layer.name.length, pascalBytes = aligned(1 + nameBytes, 4), unicodeBytes = 16 + nameBytes * 2;
  const extraBytes = 4 + (hasMask ? 20 : 0) + 4 + pascalBytes + unicodeBytes;
  const channelCount = hasMask ? 5 : 4;
  return { hasMask, pascalBytes, unicodeBytes, extraBytes, channelCount, recordBytes: 34 + channelCount * 6 + extraBytes, channelBytes: channelCount * (pixelCount + 2) };
}

/** Metadata-only compatibility report. Pixel buffers, mask quantization, and
 * an opaque final composite still require validation before export. */
export function preflightPsdExport(graph, { iccProfileBytes = 480 } = {}) {
  const issues = [], warnings = [
    { code: 'NATIVE_METADATA_NOT_EMBEDDED', message: 'PSD does not retain Prism undo history, immutable source files, selections, guides, saved styles, edit recipes or source geometry. Keep the .prism project.' },
    { code: 'RECOMPOSITION_MAY_DIFFER', message: 'The file includes the current rendered image and separate layers. Another editor may show slight color differences when it recombines transparent layers.' },
  ];
  const issue = (code, message, layerId) => issues.push({ code, message, ...(typeof layerId === 'string' ? { layerId } : {}) });
  const report = { format: 'psd', version: 1, bitsPerChannel: 8, colorMode: 'RGB', mergedComposite: 'opaque', supported: false, requiresPixelValidation: true, issues, warnings, estimatedBytes: null, estimatedWorkingBytes: null, maxBytes: PSD_EXPORT_LIMITS.maxOutputBytes, maxWorkingBytes: PSD_EXPORT_LIMITS.maxWorkingBytes, layerCount: Array.isArray(graph?.layers) ? graph.layers.length : 0 };
  if (!validObject(graph)) { issue('INVALID_DOCUMENT', 'A document graph is required.'); return report; }
  const { width, height, layers } = graph;
  const validDimensions = Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1 && width <= PSD_EXPORT_LIMITS.maxDimension && height <= PSD_EXPORT_LIMITS.maxDimension && width * height <= PSD_EXPORT_LIMITS.maxPixels;
  if (!validDimensions) issue('DIMENSION_LIMIT', 'PSD export uses the native 8192-axis and 24-megapixel limits.');
  if (!Array.isArray(layers) || layers.length < 1 || layers.length > PSD_EXPORT_LIMITS.maxLayers) issue('LAYER_LIMIT', 'PSD export requires 1–64 flat content layers.');
  if (!Number.isInteger(iccProfileBytes) || iccProfileBytes < 132 || iccProfileBytes > PSD_EXPORT_LIMITS.maxIccBytes) issue('INVALID_PROFILE_SIZE', 'The sRGB ICC profile must be 132 bytes to 64 KiB.');
  const identifiers = new Set();
  for (const layer of Array.isArray(layers) ? layers : []) {
    if (!validObject(layer)) { issue('INVALID_LAYER', 'Every layer must be a valid metadata object.'); continue; }
    const id = layer.id;
    if (typeof id !== 'string' || !id || identifiers.has(id)) issue('INVALID_LAYER_ID', 'Layer identifiers must be nonempty and unique.', id);
    identifiers.add(id);
    if (!['raster', 'solid'].includes(layer.type)) issue('LAYER_TYPE_UNSUPPORTED', 'The first PSD export supports raster and solid layers only.', id);
    if (layer.parentId !== undefined && layer.parentId !== null) issue('GROUPS_UNSUPPORTED', 'Ungroup this layer before this strict PSD export.', id);
    if (layer.clipBaseId !== undefined) issue('CLIPPING_UNSUPPORTED', 'Clipping chains are not supported by this strict PSD export. Keep the editable .prism project or export a flattened image.', id);
    if (layer.blendMode !== 'normal') issue('BLEND_MODE_UNSUPPORTED', 'Only normal blending is supported by this strict PSD export.', id);
    if (!validName(layer.name)) issue('INVALID_LAYER_NAME', 'Layer names need 1–200 valid Unicode characters without control characters.', id);
    if (typeof layer.visible !== 'boolean') issue('INVALID_VISIBILITY', 'Layer visibility must be boolean.', id);
    if (!exactOpacity(layer.opacity)) issue('OPACITY_NOT_REPRESENTABLE', 'Layer opacity must equal an integer from 0 to 255 divided by 255; PSD opacity is stored as one byte.', id);
    if (layer.filters !== undefined && (!Array.isArray(layer.filters) || layer.filters.length)) issue('FILTER_STACK_UNSUPPORTED', 'Clear the editable filter stack before this strict PSD export, including disabled entries.', id);
    let effects;
    try {
      if (layerFillOpacity(layer) !== 1) issue('FILL_UNSUPPORTED', 'Reset Layer Fill to 100% or keep the editable native project and export a flattened image.', id);
      effects = layerOutsideEffects(layer);
    } catch { issue('INVALID_LAYER', 'Layer Fill or outside-style metadata is invalid.', id); }
    if (effects !== undefined && effects !== null) issue('LAYER_EFFECTS_UNSUPPORTED', 'Clear outside layer effects before this strict PSD export.', id);
    if (layer.outline && layer.outline.width !== 0) issue('OUTLINE_UNSUPPORTED', 'Clear the outside outline before this strict PSD export.', id);
    if (layer.role === 'generated' || Boolean(layer.provenance?.jobId)) issue('CONTEXTUAL_GENERATION_UNSUPPORTED', 'Layers with contextual generation protection cannot be exported as independent raster layers in this subset.', id);
    if (layer.protected) warnings.push({ code: 'PROTECTION_NOT_PORTABLE', layerId: id, message: 'Prism pixel protection is not a PSD editing restriction; exported pixels can be edited in other applications.' });
    if (layer.transforms?.length) warnings.push({ code: 'GEOMETRY_RASTERIZED', layerId: id, message: 'Current geometry is baked into this exported raster copy; native transforms and original files remain unchanged in Prism.' });
    if (layer.mask) warnings.push({ code: 'MASK_RASTERIZED', layerId: id, message: 'The own layer mask is exported as an editable alpha8 raster mask, with density, feather and inversion baked into its pixels. Its effective coverage must be exactly representable before export.' });
    if (layer.mask?.shape === 'positioned') warnings.push({ code: 'MASK_POSITION_NOT_PORTABLE', layerId: id, message: 'The exported mask covers the current canvas only. Independent mask position and retained off-canvas coverage are omitted; the editable native mask remains unchanged in Prism.' });
    if (layer.type === 'solid') warnings.push({ code: 'SOLID_RASTERIZED', layerId: id, message: 'The solid color becomes an editable raster layer in the PSD copy.' });
  }
  if (validDimensions && Array.isArray(layers) && layers.length >= 1 && layers.length <= PSD_EXPORT_LIMITS.maxLayers && layers.every(layer => validObject(layer) && validName(layer.name)) && Number.isInteger(iccProfileBytes) && iccProfileBytes >= 132 && iccProfileBytes <= PSD_EXPORT_LIMITS.maxIccBytes) {
    const count = width * height, layout = layers.map(layer => layerLayout(layer, count));
    const records = layout.reduce((sum, layer) => sum + layer.recordBytes, 0), channels = layout.reduce((sum, layer) => sum + layer.channelBytes, 0);
    const layerInfoBytes = aligned(2 + records + channels, 2);
    const imageResourcesBytes = 12 + aligned(iccProfileBytes, 2);
    report.estimatedBytes = 26 + 4 + 4 + imageResourcesBytes + 4 + 4 + layerInfoBytes + 4 + 2 + count * 3;
    // Callers still hold their input frames while the writer owns snapshots.
    // Account for both sets, the ICC snapshots, and the final bounded buffer.
    const inputBytes = count * 4 + layers.length * count * 4 + layout.filter(layer => layer.hasMask).length * count + iccProfileBytes;
    report.estimatedWorkingBytes = inputBytes * 2 + report.estimatedBytes;
    if (report.estimatedBytes > PSD_EXPORT_LIMITS.maxOutputBytes) issue('OUTPUT_LIMIT', 'The uncompressed PSD would exceed 64 MiB. Reduce document size or layer count.');
    if (report.estimatedWorkingBytes > PSD_EXPORT_LIMITS.maxWorkingBytes) issue('WORKING_MEMORY_LIMIT', 'PSD input snapshots and output would exceed the 256 MiB working budget. Reduce document size or layer count.');
  }
  report.supported = issues.length === 0;
  return report;
}

function validateProfile(profile) {
  check(Buffer.isBuffer(profile) && profile.length >= 132 && profile.length <= PSD_EXPORT_LIMITS.maxIccBytes, 'Provide the bounded known sRGB ICC profile as a Buffer.');
  check(profile.readUInt32BE(0) === profile.length && profile.toString('ascii', 36, 40) === 'acsp' && profile.toString('ascii', 16, 20) === 'RGB ' && ['XYZ ', 'Lab '].includes(profile.toString('ascii', 20, 24)), 'Invalid RGB ICC profile header.');
  const tags = profile.readUInt32BE(128), end = 132 + tags * 12;
  check(tags > 0 && tags <= 1024 && end <= profile.length, 'Invalid RGB ICC profile tag table.');
  for (let i = 0; i < tags; i++) {
    const at = 132 + i * 12, offset = profile.readUInt32BE(at + 4), bytes = profile.readUInt32BE(at + 8);
    check(offset >= end && bytes >= 8 && offset + bytes <= profile.length && offset % 4 === 0, 'Invalid RGB ICC profile tag bounds.');
  }
}

/** Write an opaque-composite PSD from bottom-to-top full-canvas raster data.
 * The caller has already performed native metadata compatibility checks and
 * provides a known sRGB ICC profile; header validation is not color conversion.
 * This synchronous function owns copies before encoding and never mutates input.
 */
export function writePsdExport({ width, height, layers, composite, iccProfile } = {}) {
  check(Array.isArray(layers), 'PSD layers must be an array.');
  const allowed = new Set(['id', 'name', 'visible', 'opacity', 'pixels', 'mask']);
  check(layers.every(layer => validObject(layer) && Object.keys(layer).every(key => allowed.has(key))), 'PSD pixel layers contain unsupported fields. Perform native compatibility checks before rendering.');
  const metadata = layers.map(layer => ({ id: layer.id, name: layer.name, visible: layer.visible, opacity: layer.opacity, type: 'raster', blendMode: 'normal', mask: layer.mask }));
  const report = preflightPsdExport({ width, height, layers: metadata }, { iccProfileBytes: Buffer.isBuffer(iccProfile) ? iccProfile.length : 0 });
  if (!report.supported) fail(report.issues.some(issue => ['OUTPUT_LIMIT', 'WORKING_MEMORY_LIMIT', 'DIMENSION_LIMIT', 'LAYER_LIMIT'].includes(issue.code)) ? 'LIMIT_EXCEEDED' : 'PSD_UNSUPPORTED', 'This document is outside the supported PSD export subset.', report);
  const count = width * height;
  check(Buffer.isBuffer(composite) && composite.length === count * 4, 'The merged composite must be full-canvas RGBA8 bytes.');
  for (const layer of layers) {
    check(Buffer.isBuffer(layer.pixels) && layer.pixels.length === count * 4, 'Every PSD layer must contain full-canvas RGBA8 bytes.');
    check(layer.mask === undefined || layer.mask === null || (Buffer.isBuffer(layer.mask) && layer.mask.length === count), 'Every PSD mask must contain one alpha8 byte per canvas pixel.');
  }
  validateProfile(iccProfile);
  for (let i = 3; i < composite.length; i += 4) if (composite[i] !== 255) {
    const rejected = { ...report, supported: false, issues: [{ code: 'TRANSPARENT_COMPOSITE', message: 'This first PSD export requires an opaque final composite. Individual layers may retain transparency.' }] };
    fail('PSD_UNSUPPORTED', rejected.issues[0].message, rejected);
  }
  const ownedLayers = layers.map(layer => ({ ...layer, pixels: Buffer.from(layer.pixels), ...(layer.mask ? { mask: Buffer.from(layer.mask) } : {}) }));
  const merged = Buffer.from(composite), profile = Buffer.from(iccProfile), data = Buffer.alloc(report.estimatedBytes);
  let offset = 0;
  const u8 = (value) => { data.writeUInt8(value, offset); offset++; };
  const u16 = (value) => { data.writeUInt16BE(value, offset); offset += 2; };
  const i16 = (value) => { data.writeInt16BE(value, offset); offset += 2; };
  const u32 = (value) => { data.writeUInt32BE(value, offset); offset += 4; };
  const ascii = (value) => { data.write(value, offset, value.length, 'ascii'); offset += value.length; };
  const zeros = (bytes) => { offset += bytes; };
  const layout = ownedLayers.map(layer => layerLayout(layer, count));
  const infoBytes = aligned(2 + layout.reduce((sum, layer) => sum + layer.recordBytes + layer.channelBytes, 0), 2);
  ascii('8BPS'); u16(1); zeros(6); u16(3); u32(height); u32(width); u16(8); u16(3);
  u32(0); // RGB has no color-mode data.
  u32(12 + aligned(profile.length, 2)); ascii('8BIM'); u16(1039); zeros(2); u32(profile.length);
  profile.copy(data, offset); offset += profile.length; zeros(profile.length % 2);
  u32(4 + infoBytes + 4); u32(infoBytes); const infoStart = offset; i16(ownedLayers.length);
  // PSD records/channels stay in bottom-to-top order, matching both independent
  // readers and the application's canonical flat content ordering.
  for (let index = 0; index < ownedLayers.length; index++) {
    const layer = ownedLayers[index], spec = layout[index];
    u32(0); u32(0); u32(height); u32(width); u16(spec.channelCount);
    for (const id of spec.hasMask ? [-1, 0, 1, 2, -2] : [-1, 0, 1, 2]) { i16(id); u32(count + 2); }
    ascii('8BIM'); ascii('norm'); u8(Math.round(layer.opacity * 255)); u8(0); u8(8 | (layer.visible ? 0 : 2)); u8(0); u32(spec.extraBytes);
    u32(spec.hasMask ? 20 : 0);
    if (spec.hasMask) { u32(0); u32(0); u32(height); u32(width); u8(0); u8(0); zeros(2); }
    u32(0); // Default blending ranges.
    u8(layer.name.length);
    for (let i = 0; i < layer.name.length; i++) u8(layer.name.charCodeAt(i) <= 127 ? layer.name.charCodeAt(i) : 63);
    zeros(spec.pascalBytes - 1 - layer.name.length);
    ascii('8BIM'); ascii('luni'); u32(4 + layer.name.length * 2); u32(layer.name.length);
    for (let i = 0; i < layer.name.length; i++) u16(layer.name.charCodeAt(i));
  }
  for (let index = 0; index < ownedLayers.length; index++) {
    const layer = ownedLayers[index];
    for (const channel of [3, 0, 1, 2]) { u16(0); for (let i = channel; i < layer.pixels.length; i += 4) data[offset++] = layer.pixels[i]; }
    if (layout[index].hasMask) { u16(0); layer.mask.copy(data, offset); offset += layer.mask.length; }
  }
  zeros(infoBytes - (offset - infoStart)); u32(0); // No global layer mask.
  u16(0); // Uncompressed opaque merged RGB planes.
  for (const channel of [0, 1, 2]) for (let i = channel; i < merged.length; i += 4) data[offset++] = merged[i];
  check(offset === data.length, 'PSD output sizing mismatch.');
  return { data, mimeType: PSD_MIME_TYPE, bytes: data.length };
}
