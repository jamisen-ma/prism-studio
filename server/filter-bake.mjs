import fs from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import sharp from 'sharp';
import { normalizeLayerFilters, hasActiveFilters, applyLayerFilters, layerFilterSpatialCacheBytes, layerFilterSharedBytes } from './layer-filters.mjs';
import { openBoundedFile, readBoundedHandle } from './bounded-file.mjs';
import { retainFilterMask, storedFilterMask, normalizeFilterMask, filterMaskEvaluates, filterMaskStorageBytes } from './filter-mask.mjs';

export const FILTER_BAKE_LIMITS = Object.freeze({ maxWorkingBytes: 256 * 1024 * 1024, maxAssetBytes: 128 * 1024 * 1024 });
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const HASH = /^[a-f0-9]{64}$/;
const fail = (message, code = 'INVALID_ARGUMENT') => { throw Object.assign(new Error(message), { code }); };
const check = (valid, message, code) => { if (!valid) fail(message, code); };
function pixels(width, height) {
  check(Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1 && width <= 8192 && height <= 8192 && width * height <= 24_000_000, 'Filter bake dimensions exceed native source limits.', 'LIMIT_EXCEEDED');
  return width * height;
}

/** Named reachable buffer admission, not process RSS or native-codec memory.
 * Encoded inputs are conservatively retained across every phase. */
export function estimateFilterBakeBytes({ width, height, encodedWorkingBytes = 0, encodedAlphaBytes = 0, hasAlpha = false, filters = [] }) {
  const count = pixels(width, height);
  check(typeof hasAlpha === 'boolean' && [encodedWorkingBytes, encodedAlphaBytes].every(value => Number.isSafeInteger(value) && value >= 0 && value <= FILTER_BAKE_LIMITS.maxAssetBytes), 'Invalid encoded filter-bake input sizes.');
  check(hasAlpha || encodedAlphaBytes === 0, 'An alpha input size requires a separate alpha asset.');
  const encoded = encodedWorkingBytes + encodedAlphaBytes;
  const entries = normalizeLayerFilters(filters), sharedBytes = layerFilterSharedBytes(entries);
  if (storedFilterMask(filters)) normalizeFilterMask(storedFilterMask(filters), width, height);
  // This is a declared admission ceiling. Private-file encoding rejects a
  // larger PNG before allocating any JavaScript buffer for it.
  const maxOutputBytes = Math.min(FILTER_BAKE_LIMITS.maxAssetBytes, 5 * count + 1024 * 1024);
  const decodeBytes = encoded + (hasAlpha ? 9 : 4) * count + sharedBytes;
  const spatialCacheBytes = layerFilterSpatialCacheBytes(entries, width, height);
  const filterBytes = encoded + (hasAlpha ? 17 : 12) * count + spatialCacheBytes + 64 * 1024 + sharedBytes;
  const maskStorage = filterMaskEvaluates(filters) ? filterMaskStorageBytes(storedFilterMask(filters)) : { coverageBytes: 0, lutBytes: 0 };
  const maskBytes = filterMaskEvaluates(filters) ? encoded + (hasAlpha ? 13 : 8) * count + maskStorage.coverageBytes + maskStorage.lutBytes + sharedBytes : 0;
  const encodeBytes = encoded + 8 * count + maxOutputBytes + sharedBytes;
  const publicationBytes = encoded + 4 * count + 2 * maxOutputBytes + sharedBytes;
  return { decodeBytes, filterBytes, encodeBytes, publicationBytes, maxOutputBytes, spatialCacheBytes, sharedBytes, ...(storedFilterMask(filters) ? { maskBytes, maskCoverageBytes: maskStorage.coverageBytes, maskLutBytes: maskStorage.lutBytes } : {}),
    estimatedWorkingBytes: Math.max(decodeBytes, filterBytes, maskBytes, encodeBytes, publicationBytes), maxWorkingBytes: FILTER_BAKE_LIMITS.maxWorkingBytes };
}

export function planFilterBake(graph, layerId) {
  const index = graph.layers.findIndex(layer => layer.id === layerId), layer = graph.layers[index];
  check(layer, 'Layer was not found.', 'NOT_FOUND');
  check(layer.type === 'raster', 'Baking filters requires a raster layer.', 'INVALID_TARGET');
  check(!layer.protected, 'Unprotect this layer explicitly before baking its filters.', 'PROTECTED_LAYER');
  const entries = normalizeLayerFilters(layer.filters), filters = retainFilterMask(layer.filters, entries);
  check(entries.length > 0, 'This layer has no filter stack to bake.', 'NO_FILTERS');
  const active = hasActiveFilters({ filters });
  if (active) {
    const prior = graph.layers.slice(0, index).find(item => item.protected && !['group', 'adjustment'].includes(item.type));
    check(!prior, `Filters cannot be baked above earlier protected content${prior ? ` (${prior.name})` : ''}. The editable stack preserves that content through contextual RGB restoration.`, 'FILTER_BAKE_PROTECTED_CONTEXT');
  }
  return { layer, filters, active };
}

async function decodePng(data, width, height, alpha = false) {
  try {
    check(data.subarray(0, PNG.length).equals(PNG), 'Invalid PNG.');
    const image = sharp(data, { limitInputPixels: 24_000_000, failOn: 'warning' });
    const metadata = await image.metadata();
    check(metadata.format === 'png' && (metadata.pages ?? 1) === 1 && metadata.width === width && metadata.height === height, 'PNG dimensions do not match the source.');
    const decoded = await (alpha ? image.extractChannel(0) : image.toColourspace('srgb').ensureAlpha()).raw({ depth: 'uchar' }).toBuffer();
    check(decoded.length === width * height * (alpha ? 1 : 4), 'Invalid decoded PNG size.');
    return decoded;
  } catch { fail('The filter-bake source image could not be decoded.', 'INVALID_IMAGE'); }
}

// Own the original/effective/alpha surfaces only within this helper. Its sole
// returned surface has filtered RGB and the original working alpha restored.
async function materializeWorking(workingData, alphaData, layer, filters, prepareColorLookup, resolveAlpha8) {
  const original = await decodePng(workingData, layer.width, layer.height);
  const alpha = alphaData ? await decodePng(alphaData, layer.width, layer.height, true) : null;
  const effective = alpha ? Buffer.from(original) : original;
  if (alpha) for (let p = 0; p < alpha.length; p++) {
    effective[p * 4 + 3] = Math.round(original[p * 4 + 3] * alpha[p] / 255);
    if ((p + 1) % 65_536 === 0) await yieldEventLoop();
  }
  const filtered = await applyLayerFilters(effective, layer.width, layer.height, filters, { prepareColorLookup, resolveAlpha8 });
  let changed = false;
  for (let p = 0; p < original.length / 4; p++) {
    const i = p * 4;
    changed ||= filtered[i] !== original[i] || filtered[i + 1] !== original[i + 1] || filtered[i + 2] !== original[i + 2];
    filtered[i + 3] = original[i + 3];
    if ((p + 1) % 65_536 === 0) await yieldEventLoop();
  }
  return changed ? filtered : null;
}

/** Sharp streaming first creates a whole output Buffer. Use its real file
 * encoder instead, then admit the file before a bounded descriptor read. */
export async function encodeBakedPng(rgba, width, height, { tempRoot, maxBytes } = {}) {
  const count = pixels(width, height);
  check(Buffer.isBuffer(rgba) && rgba.length === count * 4 && typeof tempRoot === 'string' && Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= FILTER_BAKE_LIMITS.maxAssetBytes, 'Invalid filter-bake encoder inputs.');
  let directory, file;
  try {
    directory = await fs.mkdtemp(path.join(tempRoot, '.filter-bake-'));
    await fs.chmod(directory, 0o700);
    const output = path.join(directory, 'working.png');
    const info = await sharp(rgba, { raw: { width, height, channels: 4 }, limitInputPixels: 24_000_000 }).png({ palette: false, progressive: false }).toFile(output);
    check(info.width === width && info.height === height && info.channels === 4, 'The baked PNG dimensions are invalid.', 'INVALID_IMAGE');
    file = await openBoundedFile(output, { maxBytes });
    const { data } = await readBoundedHandle(file.handle, { bytes: file.bytes });
    check(data.subarray(0, PNG.length).equals(PNG), 'The baked output is not a PNG.', 'INVALID_IMAGE');
    return data;
  } catch (cause) {
    if (['LIMIT_EXCEEDED', 'INVALID_IMAGE'].includes(cause.code)) throw cause;
    fail('The baked working image could not be encoded.', 'FILTER_BAKE_FAILED');
  } finally {
    if (file) await file.handle.close().catch(() => {});
    if (directory) {
      try { await fs.rm(directory, { recursive: true, force: true }); }
      catch { fail('Temporary filter-bake output could not be removed; the document was not published.', 'FILTER_BAKE_FAILED'); }
    }
  }
}

export async function bakeFilterSource({ layer, filters, assetsDir, tempRoot, prepareColorLookup, resolveAlpha8 }) {
  check(HASH.test(layer.asset) && (!layer.alphaAsset || HASH.test(layer.alphaAsset)), 'Invalid filter-bake source asset.', 'INVALID_IMAGE');
  let working, alpha;
  try {
    working = await openBoundedFile(path.join(assetsDir, layer.asset), { maxBytes: FILTER_BAKE_LIMITS.maxAssetBytes });
    if (layer.alphaAsset) alpha = await openBoundedFile(path.join(assetsDir, layer.alphaAsset), { maxBytes: FILTER_BAKE_LIMITS.maxAssetBytes });
    const estimate = estimateFilterBakeBytes({ width: layer.width, height: layer.height, encodedWorkingBytes: working.bytes, encodedAlphaBytes: alpha?.bytes ?? 0, hasAlpha: !!alpha, filters });
    check(estimate.estimatedWorkingBytes <= estimate.maxWorkingBytes, 'Baking these filters exceeds the 256 MiB working-buffer limit. Reduce source dimensions or keep the editable stack.', 'LIMIT_EXCEEDED');
    const workingData = (await readBoundedHandle(working.handle, { bytes: working.bytes, expectedHash: layer.asset })).data;
    const alphaData = alpha ? (await readBoundedHandle(alpha.handle, { bytes: alpha.bytes, expectedHash: layer.alphaAsset })).data : null;
    const rgba = await materializeWorking(workingData, alphaData, layer, filters, prepareColorLookup, resolveAlpha8);
    return { data: rgba ? await encodeBakedPng(rgba, layer.width, layer.height, { tempRoot, maxBytes: estimate.maxOutputBytes }) : null };
  } finally {
    if (working) await working.handle.close().catch(() => {});
    if (alpha) await alpha.handle.close().catch(() => {});
  }
}
