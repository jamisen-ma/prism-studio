import { projectAssetUses, validateColorLookupHistory } from './lookup-assets.mjs';
import { createHash } from 'node:crypto';
import { validateLayerStyles } from './layer-styles.mjs';
import { validateGuides } from './guides.mjs';
import { validateEditRecipes } from './edit-recipes.mjs';
import { validateSourceDocument } from './source-document.mjs';

// Prism bundle v1: PRISMB01 (8 bytes), uint32BE manifest byte length, canonical
// UTF-8 JSON manifest, then the raw blobs in manifest.assets order. No archive
// filenames, compression, executable content, history, or filesystem writes.
export const PROJECT_BUNDLE_LIMITS = Object.freeze({
  maxBundleBytes: 256 * 1024 * 1024,
  maxManifestBytes: 16 * 1024 * 1024,
  maxAssetBytes: 128 * 1024 * 1024,
  maxAssets: 193,
  maxJsonDepth: 64,
});
const MAGIC = Buffer.from('PRISMB01');
const PREFIX_BYTES = 12;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ASSET_FIELDS = ['asset', 'sourceAsset', 'alphaAsset'];
const GRAPH_FIELDS = new Set(['name', 'width', 'height', 'selection', 'savedSelections', 'layerStyles', 'guides', 'editRecipes', 'layers', 'sourceDocument']);
const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const fail = (message, code = 'INVALID_PROJECT_BUNDLE') => { throw Object.assign(new Error(message), { code }); };
const limit = message => fail(message, 'LIMIT_EXCEEDED');
const assert = (condition, message) => { if (!condition) fail(message); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function exactFields(value, fields, label) {
  assert(object(value) && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key)), `Invalid ${label} fields.`);
}

// Reject unsupported JS values before JSON.stringify could coerce or omit them.
// Depth is checked before recursive serialization, including unused metadata.
function checkJSON(value, depth = 0, seen = new Set()) {
  if (depth > PROJECT_BUNDLE_LIMITS.maxJsonDepth) limit('Project metadata nesting exceeds the bundle limit.');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (value.length > PROJECT_BUNDLE_LIMITS.maxManifestBytes) limit('Project metadata exceeds the bundle limit.');
    return;
  }
  if (typeof value === 'number') { assert(Number.isFinite(value), 'Project metadata contains a non-finite number.'); return; }
  assert(typeof value === 'object' && value !== null, 'Project metadata must contain only JSON values.');
  assert(!seen.has(value), 'Project metadata cannot contain cycles.');
  const prototype = Object.getPrototypeOf(value);
  assert(Array.isArray(value) ? prototype === Array.prototype : prototype === Object.prototype || prototype === null, 'Project metadata must contain plain objects.');
  seen.add(value);
  if (Array.isArray(value)) {
    assert(Reflect.ownKeys(value).length === value.length + 1, 'Project metadata arrays cannot contain custom fields.');
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      assert(descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value'), 'Project metadata cannot contain sparse arrays or accessors.');
      checkJSON(descriptor.value, depth + 1, seen);
    }
  } else {
    for (const key of Reflect.ownKeys(value)) {
      assert(typeof key === 'string' && !BAD_KEYS.has(key), 'Project metadata contains an unsupported object key.');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      assert(descriptor.enumerable && Object.hasOwn(descriptor, 'value'), 'Project metadata cannot contain accessors or hidden fields.');
      checkJSON(descriptor.value, depth + 1, seen);
    }
  }
  seen.delete(value);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const serialize = value => JSON.stringify(canonical(value));

function validateGraphAndReferences(graph, validateGraph) {
  assert(object(graph) && Object.keys(graph).every(key => GRAPH_FIELDS.has(key)), 'Bundle contains document identity, history, or unsupported graph metadata.');
  assert(typeof graph.name === 'string' && graph.name.trim() && graph.name.length <= 200, 'Invalid project name.');
  assert(Number.isInteger(graph.width) && Number.isInteger(graph.height) && graph.width > 0 && graph.height > 0 && graph.width <= 8192 && graph.height <= 8192 && graph.width * graph.height <= 24_000_000, 'Invalid project dimensions.');
  assert(Array.isArray(graph.layers) && graph.layers.length <= 64, 'Invalid project layer collection.');
  const ids = new Set(), references = new Set();
  for (const layer of graph.layers) {
    assert(object(layer) && typeof layer.id === 'string' && UUID.test(layer.id) && !ids.has(layer.id), 'Layer identifiers must be unique UUIDs.');
    ids.add(layer.id);
    for (const field of ASSET_FIELDS) if (Object.hasOwn(layer, field)) {
      assert(layer.type === 'raster' && typeof layer[field] === 'string' && HASH.test(layer[field]), 'Asset references must be immutable SHA-256 identifiers on raster layers.');
      references.add(layer[field]);
    }
    if (layer.type === 'raster') assert(HASH.test(layer.asset) && HASH.test(layer.sourceAsset), 'Raster layers require working and preserved source assets.');
  }
  validateSourceDocument(graph);
  if (graph.sourceDocument) references.add(graph.sourceDocument.asset);
  if (graph.savedSelections !== undefined) {
    assert(Array.isArray(graph.savedSelections) && graph.savedSelections.length <= 16, 'Invalid saved selection collection.');
    const selections = new Set();
    for (const selection of graph.savedSelections) {
      assert(object(selection) && typeof selection.id === 'string' && UUID.test(selection.id) && !selections.has(selection.id), 'Saved selection identifiers must be unique UUIDs.');
      selections.add(selection.id);
    }
  }
  try { validateLayerStyles(graph); }
  catch (cause) { if (cause.code === 'LIMIT_EXCEEDED') limit('The saved layer style collection exceeds its limit.'); fail('The bundled saved layer style collection is invalid.'); }
  try { validateGuides(graph); }
  catch (cause) { if (cause.code === 'LIMIT_EXCEEDED') limit('The document guide collection exceeds its limit.'); fail('The bundled document guide collection is invalid.'); }
  try { validateEditRecipes(graph); }
  catch (cause) { if (cause.code === 'LIMIT_EXCEEDED') limit('The edit recipe library exceeds its limit.'); fail('The bundled edit recipe library is invalid.'); }
  try {
    for (const hash of projectAssetUses(graph).keys()) references.add(hash);
    validateColorLookupHistory([graph]);
  } catch (cause) {
    if (cause.code === 'LIMIT_EXCEEDED') limit('The bundled Color Lookup assets exceed their metadata limits.');
    fail('The bundled typed asset references are invalid or incompatible.');
  }
  if (references.size > PROJECT_BUNDLE_LIMITS.maxAssets) limit('Too many referenced project assets.');
  assert(typeof validateGraph === 'function', 'A native graph validator is required to process an editable bundle.');
  try {
    const result = validateGraph(graph);
    if (result && typeof result.then === 'function') {
      Promise.resolve(result).catch(() => {});
      fail('The graph validator must be synchronous.');
    }
    assert(result !== false, 'The bundled layer graph is invalid.');
  } catch {
    fail('The bundled layer graph is invalid or unsupported.');
  }
  return [...references].sort();
}

/** Encode one editable graph. The callback returns bytes for a bare SHA-256 ID.
 * Native graph validation is mandatory; image decoding remains the importer's
 * responsibility. No current document ID or undo history belongs in graph. */
export async function encodeProjectBundle({ graph, readAsset, validateGraph } = {}) {
  assert(typeof readAsset === 'function', 'An asset reader is required to export an editable bundle.');
  checkJSON(graph);
  const graphJSON = serialize(graph);
  if (Buffer.byteLength(graphJSON) > PROJECT_BUNDLE_LIMITS.maxManifestBytes) limit('Project metadata exceeds the bundle limit.');
  const snapshot = JSON.parse(graphJSON);
  const references = validateGraphAndReferences(snapshot, validateGraph);
  const assets = [], payloads = [];
  let payloadBytes = 0;
  for (const sha256 of references) {
    let supplied;
    try { supplied = await readAsset(sha256); }
    catch { fail('A referenced project asset could not be read.'); }
    assert(Buffer.isBuffer(supplied) && supplied.length > 0, 'A referenced project asset is empty or unavailable.');
    if (supplied.length > PROJECT_BUNDLE_LIMITS.maxAssetBytes) limit('A project asset exceeds the 128 MiB bundle asset limit.');
    payloadBytes += supplied.length;
    if (payloadBytes + PREFIX_BYTES + Buffer.byteLength(graphJSON) > PROJECT_BUNDLE_LIMITS.maxBundleBytes) limit('The project bundle exceeds 256 MiB.');
    const bytes = Buffer.from(supplied);
    assert(hash(bytes) === sha256, 'A referenced project asset does not match its SHA-256 identifier.');
    assets.push({ sha256, bytes: bytes.length }); payloads.push(bytes);
  }
  const manifest = Buffer.from(serialize({ format: 'prism-project', version: 1, history: 'current-state-only', graph: snapshot, assets }), 'utf8');
  if (manifest.length > PROJECT_BUNDLE_LIMITS.maxManifestBytes) limit('Project metadata exceeds the bundle limit.');
  const totalBytes = PREFIX_BYTES + manifest.length + payloadBytes;
  if (totalBytes > PROJECT_BUNDLE_LIMITS.maxBundleBytes) limit('The project bundle exceeds 256 MiB.');
  const prefix = Buffer.alloc(PREFIX_BYTES); MAGIC.copy(prefix); prefix.writeUInt32BE(manifest.length, MAGIC.length);
  return Buffer.concat([prefix, manifest, ...payloads], totalBytes);
}

/** Decode and validate without filesystem writes. Returned buffers own a copy
 * of the input, and the caller must validate image payloads before publishing a
 * fresh document. This v1 format intentionally contains no undo history. */
export function decodeProjectBundle(data, { validateGraph } = {}) {
  assert(Buffer.isBuffer(data), 'Project bundle data must be bytes.');
  if (data.length > PROJECT_BUNDLE_LIMITS.maxBundleBytes) limit('The project bundle exceeds 256 MiB.');
  assert(data.length >= PREFIX_BYTES && data.subarray(0, MAGIC.length).equals(MAGIC), 'This is not a supported Prism project bundle.');
  const manifestLength = data.readUInt32BE(MAGIC.length);
  if (manifestLength > PROJECT_BUNDLE_LIMITS.maxManifestBytes) limit('Project metadata exceeds the bundle limit.');
  assert(manifestLength > 0 && PREFIX_BYTES + manifestLength <= data.length, 'The project bundle metadata is truncated.');
  const owned = Buffer.from(data);
  let text, manifest;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(owned.subarray(PREFIX_BYTES, PREFIX_BYTES + manifestLength));
    manifest = JSON.parse(text);
  } catch { fail('Project bundle metadata must be valid UTF-8 JSON.'); }
  checkJSON(manifest);
  // Canonical encoding detects duplicate JSON keys and ambiguous coercions.
  assert(serialize(manifest) === text, 'Project bundle metadata must use the canonical v1 encoding.');
  exactFields(manifest, ['format', 'version', 'history', 'graph', 'assets'], 'project manifest');
  assert(manifest.format === 'prism-project' && manifest.version === 1 && manifest.history === 'current-state-only', 'Unsupported project bundle format or history mode.');
  assert(Array.isArray(manifest.assets), 'Invalid project asset table.');
  if (manifest.assets.length > PROJECT_BUNDLE_LIMITS.maxAssets) limit('Too many project assets.');
  const references = validateGraphAndReferences(manifest.graph, validateGraph);
  assert(manifest.assets.length === references.length, 'The bundle has missing or unreferenced assets.');
  let offset = PREFIX_BYTES + manifestLength;
  const assets = new Map();
  for (let index = 0; index < manifest.assets.length; index++) {
    const entry = manifest.assets[index]; exactFields(entry, ['sha256', 'bytes'], 'asset table');
    assert(typeof entry.sha256 === 'string' && HASH.test(entry.sha256) && entry.sha256 === references[index] && !assets.has(entry.sha256), 'Asset identifiers must be unique, referenced SHA-256 hashes in sorted order.');
    assert(Number.isSafeInteger(entry.bytes) && entry.bytes > 0, 'Invalid project asset byte length.');
    if (entry.bytes > PROJECT_BUNDLE_LIMITS.maxAssetBytes) limit('A project asset exceeds the 128 MiB bundle asset limit.');
    assert(offset + entry.bytes <= owned.length, 'A project asset is truncated.');
    const bytes = owned.subarray(offset, offset + entry.bytes);
    assert(hash(bytes) === entry.sha256, 'A project asset does not match its SHA-256 digest.');
    assets.set(entry.sha256, bytes); offset += entry.bytes;
  }
  assert(offset === owned.length, 'The project bundle contains trailing bytes.');
  return { graph: manifest.graph, assets, formatVersion: 1, historyIncluded: false };
}
