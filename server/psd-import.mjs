import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { PSD_IMPORT_VERSION, PSD_IMPORT_SUBSET, PSD_IMPORT_MAX_BYTES } from '../shared/psd-import.mjs';

export const PSD_IMPORT_LIMITS = Object.freeze({ maxBytes: PSD_IMPORT_MAX_BYTES, maxWorkingBytes: 256 * 1024 * 1024, maxDimension: 8192, maxPixels: 24_000_000, maxLayers: 64, maxMetadataBytes: 8 * 1024 * 1024, maxProjectBytes: 16 * 1024 * 1024, maxRecords: 4096, maxMaskScalars: 600_000, maxPixelWork: 384_000_000, timeoutMs: 30_000 });
const hash = data => createHash('sha256').update(data).digest('hex');
const fail = (message, code = 'INVALID_PSD') => { throw Object.assign(new Error(message), { code }); };
const check = (ok, message, code) => { if (!ok) fail(message, code); };
const safeName = value => typeof value === 'string' && value.length <= 200 && value.isWellFormed() && !/[\u0000-\u001f\u007f]/.test(value);

class Cursor {
  constructor(data, start = 0, end = data.length) { this.data = data; this.offset = start; this.end = end; }
  get remaining() { return this.end - this.offset; }
  take(n) { check(Number.isSafeInteger(n) && n >= 0 && n <= this.remaining, 'PSD section or channel data is truncated.'); const at = this.offset; this.offset += n; return this.data.subarray(at, this.offset); }
  u8() { return this.take(1)[0]; }
  u16() { return this.take(2).readUInt16BE(); }
  i16() { return this.take(2).readInt16BE(); }
  u32() { return this.take(4).readUInt32BE(); }
  i32() { return this.take(4).readInt32BE(); }
  ascii(n) { return this.take(n).toString('latin1'); }
  child(n) { const at = this.offset; this.take(n); return new Cursor(this.data, at, this.offset); }
  padding(max = 0) { check(this.remaining <= max && this.take(this.remaining).every(v => v === 0), 'PSD section contains unsupported trailing data.'); }
}

function dimensions(width, height) { check(Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1 && width <= 8192 && height <= 8192 && width * height <= 24_000_000, 'PSD image or mask dimensions exceed the native limits.', 'LIMIT_EXCEEDED'); }
function bounds(cursor) { const top = cursor.i32(), left = cursor.i32(), bottom = cursor.i32(), right = cursor.i32(); dimensions(right - left, bottom - top); check(Math.abs(left) <= 8192 && Math.abs(top) <= 8192, 'PSD layer or mask origin exceeds the native coordinate limits.', 'LIMIT_EXCEEDED'); return { x: left, y: top, width: right - left, height: bottom - top }; }
function unicode(cursor) { const length = cursor.u32(); check(length <= 200 && length * 2 <= cursor.remaining, 'PSD Unicode name exceeds its bound or is truncated.'); const bytes = cursor.take(length * 2); let value = ''; for (let i = 0; i < bytes.length; i += 2) value += String.fromCharCode(bytes.readUInt16BE(i)); check(safeName(value), 'PSD Unicode name contains invalid characters.'); return value; }
function add(report, field, code, message, details = {}) { if (report[field].length < 128) report[field].push({ code, message, ...details }); else report[`${field}Omitted`] = (report[`${field}Omitted`] ?? 0) + 1; }
function profileValid(profile) {
  if (profile.length < 132 || profile.length > 65536 || profile.readUInt32BE(0) !== profile.length || profile.toString('ascii', 36, 40) !== 'acsp' || profile.toString('ascii', 16, 20) !== 'RGB ') return false;
  const count = profile.readUInt32BE(128), end = 132 + count * 12;
  if (!count || count > 1024 || end > profile.length) return false;
  for (let i = 0; i < count; i++) { const at = 132 + i * 12, offset = profile.readUInt32BE(at + 4), bytes = profile.readUInt32BE(at + 8); if (offset < end || offset % 4 || bytes < 8 || offset + bytes > profile.length) return false; }
  return true;
}

/** Metadata/section scan, without decoded pixel allocation. All cursors are
 * bounded to their immediate parent; unknown semantics are reported, not read. */
export function scanPsd(data, { assumeSrgb = false, knownSrgbProfile } = {}) {
  check(Buffer.isBuffer(data) && data.length > 0, 'PSD import requires binary file bytes.');
  check(data.length <= PSD_IMPORT_MAX_BYTES, 'PSD input exceeds 64 MiB.', 'LIMIT_EXCEEDED');
  check(typeof assumeSrgb === 'boolean', 'PSD color assumption must be boolean.', 'INVALID_ARGUMENT');
  const report = { format: 'psd', importerVersion: PSD_IMPORT_VERSION, subsetId: PSD_IMPORT_SUBSET, input: { sha256: hash(data), bytes: data.length }, options: { assumeSrgb }, supported: false, validation: 'rejected', requiresSrgbAssumption: false, issues: [], warnings: [], layers: [], originalArchiveIncluded: true, preserves: ['raster-rgb-alpha', 'editable-user-masks', 'layer-order', 'opacity-visibility', 'original-psd-archive'], omits: ['photoshop-history', 'photoshop-editing-lock-semantics'] };
  const issue = (code, message, detail) => add(report, 'issues', code, message, detail), warning = (code, message, detail) => add(report, 'warnings', code, message, detail);
  const c = new Cursor(data); check(c.ascii(4) === '8BPS', 'This file is not a PSD document.');
  const version = c.u16(); if (version !== 1) { issue('PSD_VERSION_UNSUPPORTED', 'Only PSD version 1 is supported.'); return { report }; }
  check(c.take(6).every(v => v === 0), 'PSD reserved header fields are invalid.');
  const channels = c.u16(), height = c.u32(), width = c.u32(), depth = c.u16(), mode = c.u16(); dimensions(width, height);
  report.document = { width, height, layerCount: 0, bitsPerChannel: depth, colorMode: mode === 3 ? 'RGB' : 'unsupported', mergedChannels: channels };
  if (depth !== 8 || mode !== 3) { issue('COLOR_MODE_UNSUPPORTED', 'Only eight-bit RGB PSD documents are supported.'); return { report }; }
  if (channels !== 3) { issue('MERGED_TRANSPARENCY_UNSUPPORTED', 'This first PSD importer requires three merged RGB channels. Individual layers may be transparent.'); return { report }; }
  const colorLength = c.u32(); c.take(colorLength); if (colorLength) issue('COLOR_DATA_UNSUPPORTED', 'RGB PSD color-mode data must be empty.');
  let metadataBytes = 26 + 4 + colorLength, records = 0;
  const countRecord = () => check(++records <= PSD_IMPORT_LIMITS.maxRecords, 'PSD contains too many metadata records.', 'LIMIT_EXCEEDED');
  const addMetadata = length => { metadataBytes += length; check(metadataBytes <= PSD_IMPORT_LIMITS.maxMetadataBytes, 'PSD metadata exceeds 8 MiB.', 'LIMIT_EXCEEDED'); };
  const resourceLength = c.u32(); addMetadata(resourceLength + 4); const resources = c.child(resourceLength), seenResources = new Set(); let profile, untagged = false;
  while (resources.remaining) {
    countRecord(); check(resources.ascii(4) === '8BIM', 'PSD image resource signature is invalid.'); const id = resources.u16();
    check(!seenResources.has(id), 'PSD has duplicate image resource identifiers.'); seenResources.add(id);
    const nameLength = resources.u8(); resources.take(nameLength); if ((nameLength + 1) % 2) check(resources.u8() === 0, 'PSD resource padding is invalid.');
    const length = resources.u32(), resource = resources.child(length); if (length % 2) check(resources.u8() === 0, 'PSD resource padding is invalid.');
    if (id === 1039) { profile = resource.take(resource.remaining); check(profileValid(profile), 'PSD ICC profile is invalid.'); }
    else if (id === 1041) { check(length === 1, 'PSD untagged-profile resource is invalid.'); const value = resource.u8(); check(value <= 1, 'PSD untagged-profile flag is invalid.'); untagged = value === 1; }
    else if (id === 1057) { check(resource.u32() === 1, 'PSD version-information resource is invalid.'); const real = resource.u8(); check(real <= 1, 'PSD merged-data flag is invalid.'); if (!real) issue('MERGED_DATA_UNAVAILABLE', 'The PSD does not contain a real stored merged image.'); unicode(resource); unicode(resource); resource.u32(); resource.padding(); }
    else if ([1005, 1008, 1028, 1033, 1034, 1035, 1036, 1058, 1059, 1060].includes(id)) warning('DOCUMENT_METADATA_OMITTED', 'This document metadata remains in the original archive only.', { resourceId: id });
    else issue('RESOURCE_UNSUPPORTED', 'This PSD image resource is outside the supported import subset.', { resourceId: id });
  }
  if (profile) {
    check(!untagged, 'PSD profile and intentionally untagged state conflict.');
    if (!Buffer.isBuffer(knownSrgbProfile) || !profile.equals(knownSrgbProfile)) issue('ICC_PROFILE_UNSUPPORTED', 'The embedded color profile is not in the known sRGB profile registry.');
    else report.color = { policy: 'known-srgb', profileSha256: hash(profile) };
  } else if (!assumeSrgb) { report.requiresSrgbAssumption = true; issue('UNTAGGED_COLOR_REQUIRES_ASSUMPTION', 'This untagged RGB PSD requires an explicit sRGB interpretation choice.'); }
  else { report.color = { policy: 'assumed-srgb' }; warning('UNTAGGED_ASSUMED_SRGB', 'Untagged RGB samples are interpreted as sRGB without changing their values.'); }

  const outerLength = c.u32(), outer = c.child(outerLength); check(outer.remaining >= 4, 'PSD layer information is missing.');
  const infoLength = outer.u32(), info = outer.child(infoLength); check(info.remaining >= 2, 'PSD layer records are missing.');
  const signedCount = info.i16(), layerCount = Math.abs(signedCount); report.document.layerCount = layerCount;
  if (signedCount < 0) issue('MERGED_TRANSPARENCY_UNSUPPORTED', 'Merged transparency is not supported by this first PSD importer.');
  check(layerCount >= 1 && layerCount <= 64, 'PSD import requires 1–64 raster layers.', 'LIMIT_EXCEEDED');
  const layers = [];
  for (let index = 0; index < layerCount; index++) {
    countRecord(); const start = info.offset, rect = bounds(info), count = info.u16();
    check(count >= 3 && count <= 5, 'PSD raster layers require RGB with optional transparency and user mask.');
    const channelInfo = [], ids = new Set();
    for (let j = 0; j < count; j++) { const id = info.i16(), bytes = info.u32(); check(!ids.has(id) && [-2, -1, 0, 1, 2].includes(id) && bytes >= 2, 'PSD channel identifiers or lengths are invalid.'); ids.add(id); channelInfo.push({ id, bytes }); }
    check([0, 1, 2].every(id => ids.has(id)), 'PSD raster layer is missing an RGB channel.');
    check(info.ascii(4) === '8BIM', 'PSD layer blend signature is invalid.'); const blend = info.ascii(4), opacity = info.u8() / 255, clipping = info.u8(), flags = info.u8(); check(info.u8() === 0, 'PSD layer filler is invalid.');
    if (blend !== 'norm') issue('BLEND_MODE_UNSUPPORTED', 'Only normal layer blending is supported.', { layerIndex: index, recordKey: blend });
    if (clipping !== 0) issue('CLIPPING_UNSUPPORTED', 'Clipping layers are outside this PSD import subset.', { layerIndex: index });
    if (flags & ~15) issue('LAYER_FLAGS_UNSUPPORTED', 'This layer contains unsupported appearance flags.', { layerIndex: index });
    if (flags & 1) warning('EDITING_LOCK_OMITTED', 'PSD transparency locking does not become Prism pixel protection.', { layerIndex: index });
    const extraLength = info.u32(), extra = info.child(extraLength); addMetadata(info.offset - start);
    const maskLength = extra.u32(), maskCursor = extra.child(maskLength); let mask;
    if (maskLength) {
      if (maskLength !== 20) issue('MASK_PARAMETERS_UNSUPPORTED', 'Only simple raster user masks are supported.', { layerIndex: index });
      else { const maskBounds = bounds(maskCursor), background = maskCursor.u8(), maskFlags = maskCursor.u8(); check(background === 0 || background === 255, 'PSD user-mask default must be black or white.'); maskCursor.padding(2); if (maskFlags & ~6) issue('MASK_FLAGS_UNSUPPORTED', 'Relative, rendered, parameterized or unknown masks are unsupported.', { layerIndex: index }); mask = { ...maskBounds, background, invert: Boolean(maskFlags & 4), disabled: Boolean(maskFlags & 2) }; }
      check(ids.has(-2), 'PSD user-mask metadata has no mask channel.');
    } else check(!ids.has(-2), 'PSD user-mask channel has no mask metadata.');
    const rangesLength = extra.u32(), ranges = extra.take(rangesLength); check(rangesLength <= 512 && rangesLength % 8 === 0, 'PSD blending ranges are invalid.');
    if (ranges.some((v, i) => v !== (i % 4 < 2 ? 0 : 255))) issue('BLEND_RANGES_UNSUPPORTED', 'Nondefault blending ranges are unsupported.', { layerIndex: index });
    const nameLength = extra.u8(), legacyBytes = extra.take(nameLength); extra.take((4 - (1 + nameLength) % 4) % 4);
    let layerName = new TextDecoder('macintosh', { fatal: true }).decode(legacyBytes), hasUnicode = false; const tags = new Set();
    while (extra.remaining >= 12) {
      countRecord(); check(extra.ascii(4) === '8BIM', 'PSD layer information signature is invalid.'); const key = extra.ascii(4), length = extra.u32(), block = extra.child(length); if (length % 2) check(extra.u8() === 0, 'PSD layer information padding is invalid.');
      check(!tags.has(key), 'PSD layer has duplicate additional records.'); tags.add(key);
      if (key === 'luni') { layerName = unicode(block); block.padding(3); hasUnicode = true; }
      else if (key === 'lyid') { block.u32(); block.padding(); }
      else if (key === 'lspf') { block.u32(); block.padding(); warning('EDITING_LOCK_OMITTED', 'PSD editing locks remain in the original archive only.', { layerIndex: index }); }
      else if (key === 'lclr') { check(length === 8, 'PSD layer label is invalid.'); warning('LAYER_LABEL_OMITTED', 'PSD layer labels remain in the original archive only.', { layerIndex: index }); }
      else if (key === 'iOpa' && length === 1 && block.u8() === 255) { /* Verified identity fill opacity. */ }
      else issue('LAYER_RECORD_UNSUPPORTED', 'This layer record is outside the supported import subset.', { layerIndex: index, recordKey: key });
    }
    extra.padding(3);
    check(safeName(layerName), 'PSD layer name exceeds native limits or contains invalid characters.');
    if (!hasUnicode && legacyBytes.some(v => v > 127)) warning('LEGACY_NAME_ENCODING', 'A legacy layer name was interpreted as MacRoman.', { layerIndex: index });
    if (!layerName.trim()) { layerName = `Layer ${index + 1}`; warning('EMPTY_LAYER_NAME', 'An empty layer name received a native fallback.', { layerIndex: index }); }
    const outside = b => b.x < 0 || b.y < 0 || b.x + b.width > width || b.y + b.height > height;
    if (outside(rect) || (mask && outside(mask))) warning('OFF_CANVAS_GEOMETRY_CLIPPED', 'Source pixels are retained, but native canvas-stage clipping prevents later moves from revealing initially off-canvas pixels; off-canvas mask samples remain in the archive.', { layerIndex: index });
    if (mask?.disabled) warning('MASK_DISABLE_MAPPED_TO_DENSITY', 'The disabled user mask is retained with native mask density zero.', { layerIndex: index });
    const layer = { ...rect, name: layerName, opacity, visible: !(flags & 2), mask, channelInfo }; layers.push(layer);
    report.layers.push({ index, name: layerName, bounds: rect, opacity, visible: layer.visible, hasTransparency: ids.has(-1), hasMask: ids.has(-2) });
  }
  for (const layer of layers) for (const channel of layer.channelInfo) {
    const stream = info.child(channel.bytes), dimensions = channel.id === -2 ? layer.mask : layer;
    if (!dimensions) { channel.unsupported = true; continue; }
    channel.plan = channelPlan(stream, dimensions.width, dimensions.height, 1, issue);
  }
  info.padding(3);
  if (outer.remaining) { check(outer.remaining >= 4, 'PSD global-mask information is truncated.'); const globalLength = outer.u32(); outer.take(globalLength); addMetadata(globalLength + 4); if (globalLength) issue('GLOBAL_MASK_UNSUPPORTED', 'Global mask metadata is outside this PSD import subset.'); }
  while (outer.remaining >= 12) { countRecord(); check(['8BIM', '8B64'].includes(outer.ascii(4)), 'PSD global record signature is invalid.'); const key = outer.ascii(4), length = outer.u32(); outer.take(length); if (length % 2) check(outer.u8() === 0, 'PSD global record padding is invalid.'); addMetadata(12 + length); issue('GLOBAL_RECORD_UNSUPPORTED', 'Additional global records are outside this PSD import subset.', { recordKey: key }); }
  outer.padding(3);
  const merged = channelPlan(c, width, height, 3, issue); c.padding();
  const pixels = width * height, sourcePixels = layers.reduce((sum, l) => sum + l.width * l.height, 0), maskPixels = layers.reduce((sum, l) => sum + (l.mask ? l.mask.width * l.mask.height : 0), 0), maskCount = layers.filter(l => l.mask).length;
  check(sourcePixels * 6 + maskPixels + pixels * (maskCount + 3) <= PSD_IMPORT_LIMITS.maxPixelWork, 'PSD decoded pixel work exceeds its bounded limit.', 'LIMIT_EXCEEDED');
  const largest = Math.max(...layers.map(l => l.width * l.height)), largestMask = Math.max(0, ...layers.map(l => l.mask ? l.mask.width * l.mask.height : 0));
  const pngBound = layers.reduce((sum, l) => sum + Math.ceil((4 * l.width * l.height + l.height) * 1.01) + 65536, 0);
  // Account retained PNGs, overlapping source/channel/native validation frames,
  // comparison frames, mask materialization/metadata messages, and input copies.
  const workingBytes = data.length * 2 + 2 * pngBound + 9 * largest + largestMask + 8 * pixels + 64 * 1024 * 1024;
  check(workingBytes <= PSD_IMPORT_LIMITS.maxWorkingBytes, 'PSD decoding would exceed the 256 MiB working budget.', 'LIMIT_EXCEEDED');
  report.estimatedWorkingBytes = workingBytes;
  warning('NATIVE_RECOMPOSITION', 'Prism renders the imported layers with its native compositor; the saved merged image is not substituted for editable content.');
  return { report, data, width, height, layers, merged, workingBytes, pngBound };
}

function channelPlan(cursor, width, height, channelCount, issue) {
  const compression = cursor.u16(), bytes = width * height * channelCount;
  if (compression !== 0 && compression !== 1) { issue('COMPRESSION_UNSUPPORTED', 'Only raw and PackBits PSD channels are supported.'); cursor.take(cursor.remaining); return null; }
  if (compression === 0) { check(cursor.remaining === bytes, 'Raw PSD channel length does not match its dimensions.'); return { compression, data: cursor.take(bytes), width, height, channelCount }; }
  const rowCount = height * channelCount, table = cursor.take(rowCount * 2), start = cursor.offset; let total = 0;
  for (let row = 0; row < rowCount; row++) total += table.readUInt16BE(row * 2);
  check(total === cursor.remaining, 'PSD PackBits row lengths do not match the channel payload.');
  return { compression, data: cursor.take(total), table, start, width, height, channelCount };
}

export function decodePackBitsRow(input, output, start = 0, width = output.length - start) {
  check(Buffer.isBuffer(input) && Buffer.isBuffer(output) && Number.isInteger(start) && Number.isInteger(width) && start >= 0 && width >= 0 && start + width <= output.length, 'Invalid PackBits row buffers.');
  let at = 0, position = start; const end = start + width;
  while (at < input.length) {
    const control = input.readInt8(at++);
    if (control === -128) continue;
    const count = control >= 0 ? control + 1 : 1 - control;
    check(position + count <= end, 'PSD PackBits row produces too many pixels.');
    if (control >= 0) { check(at + count <= input.length, 'PSD PackBits literal is truncated.'); input.copy(output, position, at, at + count); at += count; }
    else { check(at < input.length, 'PSD PackBits repeat is truncated.'); output.fill(input[at++], position, position + count); }
    position += count;
  }
  check(position === end, 'PSD PackBits row produces too few pixels.'); return output;
}

export function decodePsdChannel(plan) {
  check(plan, 'Unsupported PSD channel cannot be decoded.');
  const output = Buffer.alloc(plan.width * plan.height * plan.channelCount);
  if (plan.compression === 0) { plan.data.copy(output); return output; }
  let at = 0;
  for (let row = 0; row < plan.height * plan.channelCount; row++) { const count = plan.table.readUInt16BE(row * 2); decodePackBitsRow(plan.data.subarray(at, at + count), output, row * plan.width, plan.width); at += count; }
  return output;
}

function documentMask(bytes, mask, width, height) {
  const runs = []; let previous = 0, start = 0;
  const append = end => { if (previous) { check(runs.length + 3 <= PSD_IMPORT_LIMITS.maxMaskScalars, 'PSD mask exceeds the native bitmap complexity limit.', 'LIMIT_EXCEEDED'); runs.push(start, end - start, previous); } };
  for (let i = 0; i < width * height; i++) {
    const x = i % width - mask.x, y = Math.floor(i / width) - mask.y;
    const value = x >= 0 && y >= 0 && x < mask.width && y < mask.height ? bytes[y * mask.width + x] : mask.background;
    if (value !== previous) { append(i); previous = value; start = i; }
  }
  append(width * height); return { shape: 'bitmap', x: 0, y: 0, width, height, runs, feather: 0, invert: mask.invert };
}

export async function knownSrgbProfile() {
  const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#000000' } }).withIccProfile('srgb').png().toBuffer();
  const { icc } = await sharp(png).metadata(); check(Buffer.isBuffer(icc) && profileValid(icc), 'Known sRGB profile is unavailable.', 'PSD_IMPORT_FAILED'); return icc;
}

/** Decode only after the caller reserves plan.workingBytes. Assets are in
 * memory only; no file paths, URLs, image imports or archive writes occur. */
export async function decodePsdPlan(plan, { sourceName = 'Original.psd', name } = {}) {
  const { report, width, height, layers } = plan;
  if (report.issues.length) return { report };
  const assets = [], graph = { name: name ?? (sourceName.replace(/\.psd$/i, '') || 'Imported PSD'), width, height, selection: null, layers: [], sourceDocument: { format: 'psd', asset: report.input.sha256, bytes: report.input.bytes, name: sourceName } };
  // Only native flat normal compositing is needed for a measured diagnostic.
  const composite = Buffer.alloc(width * height * 4); let stagedBytes = 0;
  for (let index = 0; index < layers.length; index++) {
    const source = layers[index], count = source.width * source.height, rgba = Buffer.alloc(count * 4); for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    let maskBytes;
    for (const channel of source.channelInfo) {
      const decoded = decodePsdChannel(channel.plan);
      if (channel.id === -2) maskBytes = decoded;
      else { const offset = channel.id === -1 ? 3 : channel.id; for (let pixel = 0; pixel < count; pixel++) rgba[pixel * 4 + offset] = decoded[pixel]; }
    }
    const mask = source.mask ? documentMask(maskBytes, source.mask, width, height) : undefined;
    const png = await sharp(rgba, { raw: { width: source.width, height: source.height, channels: 4 }, limitInputPixels: 24_000_000 }).png().toBuffer(); stagedBytes += png.length;
    check(stagedBytes <= plan.pngBound && stagedBytes + plan.data.length <= 240 * 1024 * 1024, 'PSD normalized asset staging exceeds its bounded size.', 'LIMIT_EXCEEDED');
    const asset = hash(png); assets.push({ hash: asset, data: png });
    graph.layers.push({ id: randomUUID(), name: source.name, type: 'raster', visible: source.visible, opacity: source.opacity, blendMode: 'normal', width: source.width, height: source.height, asset, sourceAsset: asset, sourceFormat: 'png', transforms: source.x || source.y || source.width !== width || source.height !== height ? [{ type: 'canvas', width, height, x: source.x, y: source.y }] : [], provenance: { sourceFormat: 'psd', colorPolicy: report.color.policy }, ...(mask ? { mask, ...(source.mask.disabled ? { maskDensity: 0 } : {}) } : {}) });
    if (source.visible) for (let sy = 0; sy < source.height; sy++) for (let sx = 0; sx < source.width; sx++) {
      const x = source.x + sx, y = source.y + sy; if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const from = (sy * source.width + sx) * 4, to = (y * width + x) * 4;
      let coverage = 1;
      if (source.mask && !source.mask.disabled) { const mx = x - source.mask.x, my = y - source.mask.y; coverage = (mx >= 0 && my >= 0 && mx < source.mask.width && my < source.mask.height ? maskBytes[my * source.mask.width + mx] : source.mask.background) / 255; if (source.mask.invert) coverage = 1 - coverage; }
      const sa = rgba[from + 3] / 255 * source.opacity * coverage, da = composite[to + 3] / 255, alpha = sa + da * (1 - sa); if (!sa) continue;
      for (let channel = 0; channel < 3; channel++) composite[to + channel] = Math.round((rgba[from + channel] * sa + composite[to + channel] * da * (1 - sa)) / alpha);
      composite[to + 3] = Math.round(alpha * 255);
    }
    check(Buffer.byteLength(JSON.stringify(graph)) <= PSD_IMPORT_LIMITS.maxProjectBytes - 4096, 'PSD masks and metadata exceed the native project limit.', 'LIMIT_EXCEEDED');
  }
  const merged = decodePsdChannel(plan.merged), count = width * height; let maxChannelDifference = 0, differingChannels = 0, transparentPixels = 0;
  for (let i = 0; i < count; i++) { if (composite[i * 4 + 3] !== 255) transparentPixels++; for (let channel = 0; channel < 3; channel++) { const difference = Math.abs(composite[i * 4 + channel] - merged[channel * count + i]); if (difference) differingChannels++; maxChannelDifference = Math.max(maxChannelDifference, difference); } }
  report.comparison = { reference: 'stored-merged-rgb', comparedWith: 'native-flat-recomposition', maxChannelDifference, differingChannels, transparentPixels, alphaComparable: transparentPixels === 0 };
  report.estimatedProjectBytes = Buffer.byteLength(JSON.stringify(graph)) + 4096;
  // Parent still validates the full native graph/envelope before advertising
  // complete support. No semantic graph trust is delegated to the worker.
  return { report, graph, assets };
}
