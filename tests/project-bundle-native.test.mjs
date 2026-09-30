import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { encodeProjectBundle, decodeProjectBundle, PROJECT_BUNDLE_LIMITS } from '../server/project-bundle.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const coded = (code) => (cause) => cause.code === code;
const edit = async (native, doc, command, args = {}) => (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document;
const graphOf = (native, doc) => { const project = native.project(doc.id); return structuredClone(project.states[project.cursor].graph); };
const rgba = async (color, width = 8, height = 8) => sharp({ create: { width, height, channels: 4, background: color } }).png().toBuffer();
async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-bundle-native-'));
  const native = await new NativeBackend({ dataDir, ...options }).init();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return { dataDir, native };
}
async function richDocument(t) {
  const width = 16, height = 12, { native, dataDir } = await fixture(t, { segmentSubject: async () => ({ width, height, alpha: Buffer.from(Array.from({ length: width * height }, (_, index) => index % width >= 3 && index % width < 9 ? index % 3 ? 255 : 128 : 0)), model: 'bundle-test' }) });
  const source = await sharp({ create: { width, height, channels: 3, background: '#e2964e' } }).jpeg({ quality: 96 }).toBuffer();
  let doc = (await native.execute('import_image', { name: 'Editable original', data: source.toString('base64'), mimeType: 'image/jpeg' })).document;
  doc = await edit(native, doc, 'extract_subject', { layerId: doc.layers[0].id }); const cutout = doc.layers.at(-1).id;
  doc = await edit(native, doc, 'set_layer_effects', { layerId: cutout, effects: { shadow: { color: '#332211', x: 2, y: 0, blur: 1 } } });
  doc = await edit(native, doc, 'set_layer_outline', { layerId: cutout, width: 1 });
  doc = await edit(native, doc, 'add_text', { text: 'Autumn', x: 0, y: 0, fontSize: 5, color: '#ffffff' }); const text = doc.layers.at(-1).id;
  doc = await edit(native, doc, 'group_layers', { layerIds: [cutout, text], name: 'Editable subject' });
  doc = await edit(native, doc, 'add_shape', { shape: 'ellipse', x: 11, y: 7, width: 3, height: 3, fill: '#882200' });
  doc = await edit(native, doc, 'select_region', { shape: 'ellipse', x: 1, y: 1, width: 8, height: 7, feather: 1, invert: true });
  doc = await edit(native, doc, 'save_selection', { name: 'Reusable background selection' });
  doc = await edit(native, doc, 'add_adjustment', { kind: 'brightness', value: 10 });
  return { native, dataDir, doc, source, cutout, text };
}
async function bundleWithAssets(native, graph, assets) { return encodeProjectBundle({ graph, validateGraph: native.validateGraph.bind(native), readAsset: async (id) => assets.get(id) }); }

test('portable native roundtrip preserves editable graph, pixels, original bytes and all referenced assets with fresh independent history', async (t) => {
  const { native: original, dataDir, doc, source, cutout, text } = await richDocument(t), target = await fixture(t);
  const beforeGraph = graphOf(original, doc), pixels = await original.renderGraph(doc), originalFile = await fs.readFile(path.join(dataDir, 'projects', `${doc.id}.json`));
  const exported = await original.exportProject({ documentId: doc.id, expectedRevision: doc.revision });
  assert.equal(exported.mimeType, 'application/x-prism-project'); assert.equal(exported.filename, 'Editable original.prism'); assert.equal(exported.documentId, doc.id); assert.equal(exported.revision, doc.revision); assert.equal(exported.historyIncluded, false);
  assert.deepEqual(await fs.readFile(path.join(dataDir, 'projects', `${doc.id}.json`)), originalFile);
  const imported = await target.native.importProject({ data: exported.data, name: 'Independent copy' });
  let copy = imported.document;
  assert.notEqual(copy.id, doc.id); assert.equal(copy.revision, 1); assert.equal(copy.history.length, 1); assert.equal(copy.canUndo, false); assert.equal(copy.canRedo, false); assert.equal(imported.historyIncluded, false);
  assert.deepEqual(graphOf(target.native, copy), { ...beforeGraph, name: 'Independent copy' });
  assert.deepEqual(await target.native.renderGraph(copy), pixels);
  assert.equal(copy.layers.find((layer) => layer.id === cutout).protected, true); assert.equal(copy.savedSelections[0].id, doc.savedSelections[0].id);
  const decoded = decodeProjectBundle(exported.data, { validateGraph: original.validateGraph.bind(original) });
  for (const [id, bytes] of decoded.assets) assert.deepEqual(await fs.readFile(path.join(target.dataDir, 'assets', id)), bytes);
  assert.deepEqual(await fs.readFile(path.join(target.dataDir, 'assets', copy.layers[0].sourceAsset)), source);
  copy = await edit(target.native, copy, 'update_text', { layerId: text, text: 'Outfits' });
  assert.equal(copy.layers.find((layer) => layer.id === text).text, 'Outfits'); assert.equal(graphOf(original, doc).layers.find((layer) => layer.id === text).text, 'Autumn');
  const reopened = await new NativeBackend({ dataDir: target.dataDir }).init(); assert.equal(reopened.loadWarnings.length, 0);
  assert.deepEqual(await reopened.renderGraph((await reopened.execute('get_document', { documentId: copy.id })).document), await target.native.renderGraph(copy));
  const caps = await target.native.execute('capabilities'); assert.deepEqual(caps.projectFormats, ['prism']); assert.equal(caps.projectBundleVersion, 1); assert.equal(caps.limits.maxProjectBundleBytes, PROJECT_BUNDLE_LIMITS.maxBundleBytes);
});

test('export uses the same edit queue and revision guard; import owns caller bytes before waiting', async (t) => {
  const { native, doc } = await richDocument(t), { native: target } = await fixture(t);
  const editing = native.execute('set_layer', { documentId: doc.id, expectedRevision: doc.revision, layerId: doc.layers.at(-1).id, name: 'Queued edit' });
  const stale = native.exportProject({ documentId: doc.id, expectedRevision: doc.revision });
  const latest = (await editing).document; await assert.rejects(stale, coded('REVISION_CONFLICT'));
  const bundle = await native.exportProject({ documentId: doc.id }); assert.equal(bundle.revision, latest.revision);
  let release; const gate = new Promise((resolve) => { release = resolve; }); target.enqueue(() => gate);
  const bytes = Buffer.from(bundle.data), importing = target.importProject({ data: bytes }); bytes.fill(0); release();
  assert.equal((await importing).document.layers.at(-1).name, 'Queued edit');
});

test('all referenced image payloads are decoded and checked before any writes, including bad preserved sources and alpha sizes', async (t) => {
  const { native } = await fixture(t), good = await rgba('#446688'), working = hash(good);
  const base = { name: 'Valid graph with untrusted assets', width: 8, height: 8, selection: null, layers: [{ id: randomUUID(), name: 'Raster', type: 'raster', visible: true, opacity: 1, blendMode: 'normal', width: 8, height: 8, transforms: [], asset: working, sourceAsset: working, sourceFormat: 'png' }] };
  const badSources = [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.invalid/image.png"/></svg>'), good.subarray(0, Math.floor(good.length / 2)), await rgba('#ffffff', 8193, 1)];
  let writes = 0; const store = native.storeAsset.bind(native); native.storeAsset = (...args) => { writes++; return store(...args); };
  for (const invalid of badSources) {
    const graph = structuredClone(base), bad = hash(invalid); graph.layers[0].sourceAsset = bad;
    const bundle = await bundleWithAssets(native, graph, new Map([[working, good], [bad, invalid]]));
    await assert.rejects(native.importProject({ data: bundle }));
  }
  const small = await rgba('#ffffff', 1, 1), smallId = hash(small);
  for (const field of ['asset', 'alphaAsset']) {
    const graph = structuredClone(base); graph.layers[0][field] = smallId;
    const bundle = await bundleWithAssets(native, graph, new Map([[working, good], [smallId, small]]));
    await assert.rejects(native.importProject({ data: bundle }), coded('INVALID_PROJECT_BUNDLE'));
  }
  assert.equal(writes, 0); assert.deepEqual(await fs.readdir(native.assetsDir), []); assert.deepEqual(await fs.readdir(native.projectsDir), []); assert.equal(native.projects.size, 0);
});

test('a failure after publishing a fresh asset rolls it back without removing a preexisting deduplicated asset', async (t) => {
  const source = await richDocument(t), { native } = await fixture(t), bundle = await source.native.exportProject({ documentId: source.doc.id });
  const decoded = decodeProjectBundle(bundle.data, { validateGraph: native.validateGraph.bind(native) });
  const [existingId, existing] = decoded.assets.entries().next().value; await native.storeAsset(existing);
  const store = native.storeAsset.bind(native); let failed = false;
  native.storeAsset = async (bytes, options) => {
    const result = await store(bytes, options);
    if (!failed && options?.createdAssets?.size) { failed = true; throw Object.assign(new Error('Injected /private/storage error'), { code: 'EIO' }); }
    return result;
  };
  await assert.rejects(native.importProject({ data: bundle.data }), (cause) => cause.code === 'PROJECT_IMPORT_FAILED' && !cause.message.includes('/private'));
  assert.equal(failed, true); assert.deepEqual(await fs.readdir(native.assetsDir), [existingId]); assert.deepEqual(await fs.readFile(path.join(native.assetsDir, existingId)), existing);
  assert.deepEqual(await fs.readdir(native.projectsDir), []); assert.equal(native.projects.size, 0);
});

test('project persistence failure removes all newly created import assets and leaves current projects untouched', async (t) => {
  const source = await richDocument(t), { native } = await fixture(t), bundle = await source.native.exportProject({ documentId: source.doc.id });
  const existing = (await native.execute('create_document', { name: 'Keep me', width: 4, height: 4 })).document;
  const projectFile = path.join(native.projectsDir, `${existing.id}.json`), saved = await fs.readFile(projectFile);
  native.persist = async () => { throw Object.assign(new Error('Injected storage failure'), { code: 'EACCES' }); };
  await assert.rejects(native.importProject({ data: bundle.data }), coded('PROJECT_IMPORT_FAILED'));
  assert.deepEqual(await fs.readdir(native.assetsDir), []); assert.deepEqual(await fs.readdir(native.projectsDir), [`${existing.id}.json`]); assert.deepEqual(await fs.readFile(projectFile), saved);
  assert.deepEqual((await native.execute('list_documents')).documents, [existing]);
});

test('a corrupt preexisting asset is never overwritten or deleted when import rolls back', async (t) => {
  const source = await richDocument(t), { native } = await fixture(t), bundle = await source.native.exportProject({ documentId: source.doc.id });
  const decoded = decodeProjectBundle(bundle.data, { validateGraph: native.validateGraph.bind(native) }), existingId = [...decoded.assets.keys()].at(-1), corrupt = Buffer.from('preexisting corrupt bytes');
  await fs.writeFile(path.join(native.assetsDir, existingId), corrupt);
  await assert.rejects(native.importProject({ data: bundle.data }), coded('CORRUPT_ASSET'));
  assert.deepEqual(await fs.readdir(native.assetsDir), [existingId]); assert.deepEqual(await fs.readFile(path.join(native.assetsDir, existingId)), corrupt); assert.equal(native.projects.size, 0);
});

test('current-state metadata must fit the persisted project envelope before a project or asset is written', async (t) => {
  const { native } = await fixture(t);
  const doc = (await native.execute('create_document', { width: 1, height: 1 })).document, graph = graphOf(native, doc);
  graph.layers[0].notes = '';
  const empty = await bundleWithAssets(native, graph, new Map()), length = empty.readUInt32BE(8);
  graph.layers[0].notes = 'x'.repeat(PROJECT_BUNDLE_LIMITS.maxManifestBytes - length);
  const bundle = await bundleWithAssets(native, graph, new Map());
  assert.equal(bundle.readUInt32BE(8), PROJECT_BUNDLE_LIMITS.maxManifestBytes);
  let writes = 0; native.persist = async () => { writes++; assert.fail('Metadata preflight must precede persistence'); };
  await assert.rejects(native.importProject({ data: bundle }), coded('LIMIT_EXCEEDED'));
  assert.equal(writes, 0); assert.equal(native.projects.size, 1); assert.deepEqual(await fs.readdir(native.assetsDir), []);
});

test('imported AI provenance is preserved but cannot impersonate a live generation installation receipt', async (t) => {
  const { native: source } = await fixture(t), { native: target } = await fixture(t), jobId = randomUUID();
  const image = await rgba('#cc6600'), nextImage = await rgba('#0066cc');
  const original = (await source.installGeneratedImage({ data: image, provenance: { jobId, mode: 'generate', model: 'codex-imagegen' } })).document;
  const bundle = await source.exportProject({ documentId: original.id });
  const decoded = decodeProjectBundle(bundle.data, { validateGraph: source.validateGraph.bind(source) });
  decoded.graph.layers[0].provenance.imported = false;
  const crafted = await bundleWithAssets(source, decoded.graph, decoded.assets);
  const imported = (await target.importProject({ data: crafted })).document;
  assert.equal(imported.layers[0].provenance.jobId, jobId); assert.equal(imported.layers[0].provenance.imported, true);
  const completed = (await target.installGeneratedImage({ data: nextImage, provenance: { jobId, mode: 'generate', model: 'codex-imagegen' } })).document;
  assert.notEqual(completed.id, imported.id); assert.equal((await target.execute('list_documents')).documents.length, 2);
  assert.deepEqual(await fs.readFile(path.join(target.assetsDir, imported.layers[0].sourceAsset)), image);
  assert.deepEqual(await fs.readFile(path.join(target.assetsDir, completed.layers[0].sourceAsset)), nextImage);
  const replay = await target.installGeneratedImage({ data: nextImage, provenance: { jobId, mode: 'generate' } }); assert.equal(replay.document.id, completed.id);
});

test('export rejects missing or changed referenced images without altering document state or leaking paths', async (t) => {
  const { native, doc } = await richDocument(t), projectFile = path.join(native.projectsDir, `${doc.id}.json`), before = await fs.readFile(projectFile);
  await fs.unlink(path.join(native.assetsDir, doc.layers[0].sourceAsset));
  await assert.rejects(native.exportProject({ documentId: doc.id }), (cause) => cause.code === 'INVALID_PROJECT_BUNDLE' && !cause.message.includes(native.dataDir));
  assert.deepEqual(await fs.readFile(projectFile), before); assert.equal(native.project(doc.id).revision, doc.revision);
});

test('unrenderable text control characters are rejected during bundle validation before import writes', async (t) => {
  const { native } = await fixture(t);
  const graph = { name: 'Invalid text', width: 8, height: 8, selection: null, layers: [{ id: randomUUID(), type: 'text', name: 'Text', visible: true, opacity: 1, blendMode: 'normal', width: 8, height: 8, transforms: [], text: 'Hello\u0000world', x: 0, y: 0, fontSize: 4, color: '#ffffff' }] };
  const bundle = await encodeProjectBundle({ graph, validateGraph: () => true, readAsset: () => assert.fail('No raster assets') });
  await assert.rejects(native.importProject({ data: bundle }), coded('INVALID_PROJECT_BUNDLE'));
  assert.equal(native.projects.size, 0); assert.deepEqual(await fs.readdir(native.projectsDir), []); assert.deepEqual(await fs.readdir(native.assetsDir), []);
});
