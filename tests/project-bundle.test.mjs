import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { encodeProjectBundle, decodeProjectBundle, PROJECT_BUNDLE_LIMITS } from '../server/project-bundle.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const coded = code => cause => cause.code === code;
const solidGraph = () => ({ name: 'Portable fixture', width: 16, height: 12, selection: null, layers: [{
  id: randomUUID(), name: 'Background', type: 'solid', visible: true, opacity: 1, blendMode: 'normal', color: '#224466', width: 16, height: 12, transforms: [],
}] });
const validator = graph => NativeBackend.prototype.validateGraph.call({}, graph);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
function rawBundle(manifest, payloads = [], rawJSON) {
  const bytes = Buffer.from(rawJSON ?? JSON.stringify(canonical(manifest))), prefix = Buffer.alloc(12);
  prefix.write('PRISMB01'); prefix.writeUInt32BE(bytes.length, 8);
  return Buffer.concat([prefix, bytes, ...payloads]);
}
function unpack(data) { return JSON.parse(data.subarray(12, 12 + data.readUInt32BE(8)).toString()); }
const envelope = graph => ({ format: 'prism-project', version: 1, history: 'current-state-only', graph, assets: [] });
async function noAssets(graph = solidGraph()) { return encodeProjectBundle({ graph, validateGraph: validator, readAsset: async () => assert.fail('No assets should be read.') }); }

test('current-state-only graph is deterministic, editable, identity-free and requires semantic validation', async () => {
  const graph = solidGraph(), bundle = await noAssets(graph);
  assert.equal(bundle.subarray(0, 8).toString(), 'PRISMB01');
  assert.deepEqual(await noAssets(graph), bundle);
  const decoded = decodeProjectBundle(bundle, { validateGraph: validator });
  assert.deepEqual(decoded.graph, graph); assert.equal(decoded.assets.size, 0);
  assert.equal(decoded.formatVersion, 1); assert.equal(decoded.historyIncluded, false);
  assert.equal(unpack(bundle).history, 'current-state-only');
  assert.throws(() => decodeProjectBundle(bundle), coded('INVALID_PROJECT_BUNDLE'));
  await assert.rejects(encodeProjectBundle({ graph, readAsset: async () => Buffer.alloc(0) }), coded('INVALID_PROJECT_BUNDLE'));
  for (const field of ['id', 'revision', 'states', 'history', 'backend']) await assert.rejects(noAssets({ ...graph, [field]: 'Not portable state' }), coded('INVALID_PROJECT_BUNDLE'));
  const invalid = structuredClone(graph); invalid.layers[0].opacity = 2;
  assert.throws(() => decodeProjectBundle(rawBundle(envelope(invalid)), { validateGraph: validator }), coded('INVALID_PROJECT_BUNDLE'));
});

test('real native graph round-trips groups, cutout source/working/alpha, effects and named selections byte-for-byte', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-project-codec-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const native = await new NativeBackend({ dataDir: directory, segmentSubject: async () => ({ width: 16, height: 12,
    alpha: Buffer.from(Array.from({ length: 192 }, (_, index) => index % 16 < 10 ? index % 3 === 0 ? 128 : 255 : 0)), model: 'bundle-fixture' }) }).init();
  const original = await sharp({ create: { width: 16, height: 12, channels: 3, background: '#e2964e' } }).jpeg({ quality: 97 }).toBuffer();
  let doc = (await native.execute('import_image', { name: 'Preserved source', data: original.toString('base64'), mimeType: 'image/jpeg' })).document;
  const edit = async (command, args) => { doc = (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document; };
  await edit('extract_subject', { layerId: doc.layers[0].id });
  const cutout = doc.layers.at(-1).id;
  await edit('set_layer_effects', { layerId: cutout, effects: { shadow: { color: '#332211', opacity: 0.5, x: 1, y: 1, blur: 0 } } });
  await edit('group_layers', { layerIds: [cutout], name: 'Protected subject group' });
  await edit('select_region', { shape: 'ellipse', x: 1.25, y: 1.5, width: 8, height: 7, feather: 1.2, invert: true });
  await edit('save_selection', { name: 'Original detailed selection' });
  await edit('clear_selection', {});
  const project = native.projects.get(doc.id), graph = structuredClone(project.states[project.cursor].graph), beforeGraph = structuredClone(graph);
  const beforeFiles = await fs.readdir(native.assetsDir), beforeProject = await fs.readFile(path.join(native.projectsDir, `${doc.id}.json`));
  const readCounts = new Map();
  const bundle = await encodeProjectBundle({ graph, validateGraph: native.validateGraph.bind(native), readAsset: async id => {
    readCounts.set(id, (readCounts.get(id) ?? 0) + 1); return fs.readFile(path.join(native.assetsDir, id));
  } });
  const decoded = decodeProjectBundle(bundle, { validateGraph: native.validateGraph.bind(native) });
  assert.deepEqual(decoded.graph, beforeGraph); assert.deepEqual(graph, beforeGraph);
  assert.equal(decoded.graph.layers.find(layer => layer.id === cutout).protected, true);
  assert.deepEqual(decoded.graph.savedSelections, graph.savedSelections);
  assert.equal(decoded.assets.size, 3, 'Preserved JPEG, normalized working PNG and separate alpha PNG.');
  assert.ok([...readCounts.values()].every(count => count === 1), 'Shared references are stored once.');
  for (const [id, bytes] of decoded.assets) assert.deepEqual(bytes, await fs.readFile(path.join(native.assetsDir, id)));
  assert.deepEqual(await native.renderGraph(decoded.graph), await native.renderGraph(graph));
  const importedSource = decoded.graph.layers.find(layer => layer.type === 'raster').sourceAsset;
  assert.deepEqual(decoded.assets.get(importedSource), original);
  assert.deepEqual(await fs.readdir(native.assetsDir), beforeFiles);
  assert.deepEqual(await fs.readFile(path.join(native.projectsDir, `${doc.id}.json`)), beforeProject);
  const owned = Buffer.from(decoded.assets.get(importedSource)); bundle.fill(0);
  assert.deepEqual(decoded.assets.get(importedSource), owned, 'Decoded bytes never alias caller-owned bundle memory.');
});

test('export captures graph before async reads and rejects missing or hash-mismatched source bytes', async () => {
  const bytes = Buffer.from('immutable bytes'), id = hash(bytes), graph = solidGraph();
  graph.layers[0] = { ...graph.layers[0], type: 'raster', asset: id, sourceAsset: id }; delete graph.layers[0].color;
  let release; const gate = new Promise(resolve => { release = resolve; });
  const expected = structuredClone(graph);
  const pending = encodeProjectBundle({ graph, validateGraph: validator, readAsset: async () => { await gate; return bytes; } });
  graph.name = 'Later mutation'; graph.layers[0].opacity = 0.3; release();
  const decoded = decodeProjectBundle(await pending, { validateGraph: validator });
  assert.deepEqual(decoded.graph, expected);
  bytes.fill(0); assert.equal(decoded.assets.get(id).toString(), 'immutable bytes');
  for (const readAsset of [async () => Buffer.from('wrong'), async () => { throw Error('/private/path must not escape'); }, async () => Buffer.alloc(0)]) {
    await assert.rejects(encodeProjectBundle({ graph, validateGraph: validator, readAsset }), cause => cause.code === 'INVALID_PROJECT_BUNDLE' && !cause.message.includes('/private'));
  }
});

test('asset tables reject traversal, missing/unreferenced/duplicate blobs, wrong digests, lengths, order and trailing data', async () => {
  const a = Buffer.from('one'), b = Buffer.from('two'), ids = [hash(a), hash(b)].sort(), blobs = new Map([[hash(a), a], [hash(b), b]]);
  const graph = solidGraph(); graph.layers[0] = { ...graph.layers[0], type: 'raster', asset: ids[0], sourceAsset: ids[1] }; delete graph.layers[0].color;
  const valid = { ...envelope(graph), assets: ids.map(sha256 => ({ sha256, bytes: blobs.get(sha256).length })) };
  const payloads = ids.map(id => blobs.get(id));
  const reject = (manifest, data = payloads) => assert.throws(() => decodeProjectBundle(rawBundle(manifest, data), { validateGraph: validator }), coded('INVALID_PROJECT_BUNDLE'));
  for (const bad of ['../asset', '/absolute.png', `${ids[0]}.png`, ids[0].toUpperCase()]) {
    const next = structuredClone(valid); next.assets[0].sha256 = bad; reject(next);
    const badGraph = structuredClone(graph); badGraph.layers[0].asset = bad; reject({ ...valid, graph: badGraph });
  }
  reject({ ...valid, assets: valid.assets.slice(1) });
  reject({ ...valid, assets: [...valid.assets, valid.assets[0]] });
  reject({ ...valid, assets: [valid.assets[0], valid.assets[0]] });
  reject({ ...valid, assets: [...valid.assets].reverse() }, [...payloads].reverse());
  reject(valid, [Buffer.from('bad'), payloads[1]]);
  reject(valid, [payloads[0], payloads[1].subarray(1)]);
  for (const length of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) reject({ ...valid, assets: [{ ...valid.assets[0], bytes: length }, valid.assets[1]] });
  const validBytes = rawBundle(valid, payloads);
  assert.throws(() => decodeProjectBundle(Buffer.concat([validBytes, Buffer.from([0])]), { validateGraph: validator }), coded('INVALID_PROJECT_BUNDLE'));
  assert.equal(decodeProjectBundle(validBytes, { validateGraph: validator }).assets.size, 2);
});

test('malformed metadata rejects invalid UTF-8, duplicate keys, unsafe prototypes, non-finite numbers and excessive nesting', async () => {
  const graph = solidGraph(), valid = envelope(graph), encoded = await noAssets(graph);
  const prefix = Buffer.from(encoded.subarray(0, 12)); prefix.writeUInt32BE(2, 8);
  assert.throws(() => decodeProjectBundle(Buffer.concat([prefix, Buffer.from([0xc3, 0x28])]), { validateGraph: validator }), coded('INVALID_PROJECT_BUNDLE'));
  const text = JSON.stringify(canonical(valid));
  for (const badText of [text.replace('"version":1', '"version":1,"version":1'), text.replace('"version":1', '"version":1e309'), text.replace('"version":1', '"__proto__":{},"version":1'), text.replace('"version":1', '"constructor":{},"version":1')]) {
    assert.throws(() => decodeProjectBundle(rawBundle(null, [], badText), { validateGraph: validator }), coded('INVALID_PROJECT_BUNDLE'));
  }
  const duplicateLayers = structuredClone(graph); duplicateLayers.layers.push(structuredClone(duplicateLayers.layers[0]));
  await assert.rejects(noAssets(duplicateLayers), coded('INVALID_PROJECT_BUNDLE'));
  for (const badValue of [NaN, Infinity, undefined, () => {}, 2n, new Date()]) await assert.rejects(noAssets({ ...graph, name: badValue }), coded('INVALID_PROJECT_BUNDLE'));
  const cyclic = structuredClone(graph); cyclic.selection = cyclic;
  await assert.rejects(noAssets(cyclic), coded('INVALID_PROJECT_BUNDLE'));
  let nested = {}; for (let index = 0; index < 66; index++) nested = { child: nested };
  await assert.rejects(noAssets({ ...graph, selection: nested }), coded('LIMIT_EXCEEDED'));
  const hidden = structuredClone(graph); Object.defineProperty(hidden, 'secret', { value: 'not serializable' });
  await assert.rejects(noAssets(hidden), coded('INVALID_PROJECT_BUNDLE'));
  const accessors = structuredClone(graph); Object.defineProperty(accessors, 'name', { enumerable: true, get() { assert.fail('Do not invoke metadata accessors.'); } });
  await assert.rejects(noAssets(accessors), coded('INVALID_PROJECT_BUNDLE'));
});

test('declared metadata and asset bounds reject before decoding payloads or accepting an unsupported version', async () => {
  const graph = solidGraph(), bytes = await noAssets(graph);
  for (const input of [Buffer.alloc(0), bytes.subarray(0, 11), Buffer.from('not a bundle')]) assert.throws(() => decodeProjectBundle(input, { validateGraph: validator }), coded('INVALID_PROJECT_BUNDLE'));
  const tooLong = Buffer.from(bytes); tooLong.writeUInt32BE(PROJECT_BUNDLE_LIMITS.maxManifestBytes + 1, 8);
  assert.throws(() => decodeProjectBundle(tooLong, { validateGraph: validator }), coded('LIMIT_EXCEEDED'));
  const truncated = Buffer.from(bytes); truncated.writeUInt32BE(bytes.length, 8);
  assert.throws(() => decodeProjectBundle(truncated, { validateGraph: validator }), coded('INVALID_PROJECT_BUNDLE'));
  for (const altered of [{ version: 2 }, { history: 'all-history' }, { extra: true }, { format: 'zip' }]) assert.throws(() => decodeProjectBundle(rawBundle({ ...envelope(graph), ...altered }), { validateGraph: validator }), coded('INVALID_PROJECT_BUNDLE'));
  const id = hash(Buffer.from('x')), raster = structuredClone(graph); raster.layers[0] = { ...raster.layers[0], type: 'raster', asset: id, sourceAsset: id }; delete raster.layers[0].color;
  assert.throws(() => decodeProjectBundle(rawBundle({ ...envelope(raster), assets: [{ sha256: id, bytes: PROJECT_BUNDLE_LIMITS.maxAssetBytes + 1 }] }), { validateGraph: validator }), coded('LIMIT_EXCEEDED'));
  assert.throws(() => decodeProjectBundle(rawBundle({ ...envelope(graph), assets: Array.from({ length: 194 }, () => ({ sha256: id, bytes: 1 })) }), { validateGraph: validator }), coded('LIMIT_EXCEEDED'));
  assert.throws(() => decodeProjectBundle(bytes, { validateGraph: async () => {} }), coded('INVALID_PROJECT_BUNDLE'));
});
