import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { applyStroke } from '../server/retouch.mjs';

const base = extra => ({ id: randomUUID(), name: 'Independent retouch fixture', visible: true, opacity: 1, blendMode: 'normal', ...extra });
const image = (w, h, value = [0, 0, 0, 0]) => Buffer.from(Array.from({ length: w * h }, (_, i) => typeof value === 'function' ? value(i % w, Math.floor(i / w), i) : value).flat());
const stroke = extra => ({ tool: 'clone', points: [{ x: 9.5, y: 4.5 }, { x: 13.5, y: 4.5 }], source: { x: 2.5, y: 4.5 }, size: 3, hardness: 1, opacity: 0.7, ...extra });
const find = (doc, id) => doc.layers.find(layer => layer.id === id);
const edit = (native, doc, command, args = {}) => native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args });
const files = async directory => Object.fromEntries(await Promise.all((await fs.readdir(directory)).sort().map(async file => [file, await fs.readFile(path.join(directory, file))])));
const rgba = async bytes => sharp(bytes).ensureAlpha().raw().toBuffer();
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-retouch-audit-'));
  const native = await new NativeBackend({ dataDir }).init();
  t.after(async () => { await native.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { native, dataDir };
}
async function raster(native, pixels, width, height, extra = {}) {
  const asset = await native.storeAsset(await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer());
  return base({ type: 'raster', asset, sourceAsset: asset, sourceFormat: 'png', width, height, transforms: [], ...extra });
}
const project = async (native, width, height, layers, extra = {}) => (await native.newProject({ name: 'Retouch independent audit', width, height, layers, selection: null, ...extra }, 'Fixture')).document;
const assetPixels = async (native, doc, id) => rgba(await fs.readFile(path.join(native.assetsDir, find(doc, id).asset)));

test('legacy defaults are byte-identical; current samples frozen working alpha while excluding all display context', async t => {
  const { native } = await fixture(t), width = 16, height = 9;
  const input = image(width, height, (x, y) => [20 + x * 7, 40 + y * 9, 210 - x * 5, [0, 1, 128, 255][x % 4]]);
  const target = await raster(native, input, width, height, { opacity: 0.4, mask: { x: 0, y: 0, width: 2, height }, maskDensity: 0.3 });
  target.alphaAsset = await native.storeAlpha(Buffer.from(Array.from({ length: width * height }, (_, i) => [255, 128, 1, 0][i % 4])), width, height);
  const group = base({ type: 'group', mode: 'isolated', visible: false, opacity: 0.2 }); target.parentId = group.id;
  target.visible = false; target.outline = { width: 1, color: '#ffffff' }; target.effects = { glow: { opacity: 0.4, blur: 1, color: '#ffffff' } };
  const above = base({ type: 'solid', color: '#ee4422', width, height, transforms: [] });
  const originalFiles = await files(native.assetsDir), targetFrozen = await native.renderLayer(target);
  for (const tool of ['clone', 'heal']) {
    const args = stroke({ tool, layerId: target.id });
    const old = await project(native, width, height, [group, target, above]);
    const explicit = await project(native, width, height, [group, target, above]);
    const a = (await edit(native, old, 'paint_stroke', args)).document;
    const b = (await edit(native, explicit, 'paint_stroke', { ...args, sampleMode: 'all', ignoreAdjustments: false })).document;
    assert.deepEqual(await assetPixels(native, a, target.id), await assetPixels(native, b, target.id));
    const raw = await project(native, width, height, [group, target, above]), renderGraph = native.renderGraph;
    native.renderGraph = async () => { throw new Error('Current sampling must not allocate a composite'); };
    let output;
    try { output = (await edit(native, raw, 'paint_stroke', { ...args, sampleMode: 'current' })).document; }
    finally { native.renderGraph = renderGraph; }
    assert.deepEqual(await assetPixels(native, output, target.id), applyStroke({ ...args, pixels: targetFrozen, composite: targetFrozen, width, height }));
    const changed = find(output, target.id);
    for (const key of ['parentId', 'sourceAsset', 'opacity', 'mask', 'maskDensity', 'visible', 'outline', 'effects']) assert.deepEqual(changed[key], target[key]);
    assert.equal(changed.alphaAsset, undefined); assert.deepEqual(changed.transforms, []);
  }
  for (const [file, bytes] of Object.entries(originalFiles)) assert.deepEqual(await fs.readFile(path.join(native.assetsDir, file)), bytes);
});

test('root cutoff survives hidden and zero-opacity targets and keeps complete nested groups and clipping chains', async t => {
  const { native } = await fixture(t), width = 16, height = 9;
  const background = base({ type: 'solid', color: '#203050', width, height, transforms: [] });
  const outer = base({ type: 'group', mode: 'isolated', opacity: 0.7, blendMode: 'screen' });
  const inner = base({ type: 'group', mode: 'pass-through', parentId: outer.id });
  const clippedBase = await raster(native, image(width, height, [55, 110, 165, 128]), width, height, { parentId: inner.id });
  const member = await raster(native, image(width, height, [150, 30, 70, 192]), width, height, { parentId: inner.id, clipBaseId: clippedBase.id, blendMode: 'multiply' });
  const grade = base({ type: 'adjustment', kind: 'invert', value: 100, parentId: inner.id });
  const lower = [background, outer, inner, clippedBase, member, grade];
  const above = base({ type: 'solid', color: '#fa1020', width, height, transforms: [] });
  for (const targetStyle of [{ visible: false }, { opacity: 0 }]) for (const ignoreAdjustments of [false, true]) {
    const target = await raster(native, image(width, height, [90, 70, 30, 200]), width, height, targetStyle);
    const doc = await project(native, width, height, [...lower, target, above]);
    // Oracle uses a separately constructed, complete lower tree, not the new
    // stopAfterRootId/ignoreAdjustments render options under audit.
    const sampled = await native.renderGraph({ ...doc, layers: lower.filter(layer => !ignoreAdjustments || layer.type !== 'adjustment') });
    const args = stroke({ layerId: target.id, sampleMode: 'current-and-below', ignoreAdjustments });
    const expected = applyStroke({ ...args, pixels: await native.renderLayer(target), composite: sampled, width, height });
    const output = (await edit(native, doc, 'paint_stroke', args)).document;
    assert.deepEqual(await assetPixels(native, output, target.id), expected);
    assert.deepEqual(output.layers.slice(0, lower.length), doc.layers.slice(0, lower.length));
  }
});

test('adjustment skipping keeps source filters active and full-document protection gates scoped writes', async t => {
  const { native } = await fixture(t), width = 16, height = 9;
  const source = await raster(native, image(width, height, [20, 50, 90, 255]), width, height, { filters: [{ id: randomUUID(), kind: 'brightness', value: 20, opacity: 1, enabled: true }] });
  const target = await raster(native, image(width, height), width, height);
  const grade = base({ type: 'adjustment', kind: 'invert', value: 100 });
  const person = await raster(native, image(width, height, (x, y) => x === 11 && y === 4 ? [240, 200, 150, 1] : [67, 83, 91, 0]), width, height, { protected: true, outline: { width: 1, color: '#ffffff' } });
  const doc = await project(native, width, height, [source, target, grade, person]);
  const protectedMap = await native.protectedPixels(doc), args = stroke({ layerId: target.id, sampleMode: 'current-and-below', ignoreAdjustments: true });
  assert.ok(protectedMap[4 * width + 11]); assert.ok(protectedMap[4 * width + 10], 'Outside white outline is protected too');
  const expected = applyStroke({ ...args, pixels: image(width, height), composite: image(width, height, [71, 101, 141, 255]), width, height, coverage: (x, y) => protectedMap[Math.floor(y) * width + Math.floor(x)] ? 0 : 1 });
  const output = (await edit(native, doc, 'paint_stroke', args)).document, actual = await assetPixels(native, output, target.id);
  assert.deepEqual(actual, expected);
  assert.ok(actual.some((byte, index) => index % 4 === 3 && byte > 0));
  for (let i = 0; i < protectedMap.length; i++) if (protectedMap[i]) assert.deepEqual([...actual.subarray(i * 4, i * 4 + 4)], [0, 0, 0, 0]);
  assert.deepEqual(find(output, source.id), source); assert.deepEqual(find(output, person.id), person);
});

test('repair insertion and preallocated transaction IDs remain ordinary, independent and portable through undo/reopen', async t => {
  const { native, dataDir } = await fixture(t), width = 16, height = 9;
  const source = await raster(native, image(width, height, (x, y) => [20 + x * 8, 30 + y * 7, 90, 255]), width, height);
  const upper = base({ type: 'group', mode: 'pass-through' });
  const upperChild = base({ type: 'solid', color: '#ffffff', width, height, transforms: [], parentId: upper.id });
  let doc = await project(native, width, height, [source, upper, upperChild]); const original = structuredClone(doc), id = randomUUID();
  doc = (await edit(native, doc, 'apply_transaction', { label: 'One repair edit', operations: [
    { command: 'create_repair_layer', args: { sourceLayerId: source.id, newLayerId: id, name: 'Independent repair' } },
    { command: 'paint_stroke', args: stroke({ layerId: id, sampleMode: 'current-and-below', ignoreAdjustments: true }) },
  ] })).document;
  assert.equal(doc.revision, original.revision + 1); assert.deepEqual(doc.layers.map(layer => layer.id), [source.id, id, upper.id, upperChild.id]);
  const repair = find(doc, id); assert.equal(repair.role, 'paint'); assert.equal(repair.visible, true); assert.equal(repair.opacity, 1);
  for (const field of ['parentId', 'clipBaseId', 'mask', 'maskDensity', 'effects', 'outline', 'filters', 'provenance', 'protected', 'alphaAsset']) assert.ok(repair[field] === undefined || field === 'protected' && repair[field] === false, field);
  assert.notEqual(repair.sourceAsset, source.sourceAsset); assert.notEqual(repair.asset, repair.sourceAsset);
  assert.ok((await rgba(await fs.readFile(path.join(native.assetsDir, repair.sourceAsset)))).every(byte => byte === 0));
  const pixels = await assetPixels(native, doc, id), complete = structuredClone(doc);
  doc = (await edit(native, doc, 'undo')).document; assert.deepEqual(doc.layers, original.layers);
  doc = (await edit(native, doc, 'redo')).document; assert.deepEqual(doc.layers, complete.layers);
  const reopened = await new NativeBackend({ dataDir }).init(); t.after(() => reopened.close());
  assert.deepEqual((await reopened.execute('get_document', { documentId: doc.id })).document, doc);
  const bundle = await native.exportProject({ documentId: doc.id }), imported = (await native.importProject({ data: bundle.data })).document;
  assert.deepEqual(imported.layers, doc.layers); assert.deepEqual(await assetPixels(native, imported, id), pixels);
  const result = await edit(native, doc, 'create_repair_layer', { sourceLayerId: source.id });
  assert.ok(result.layerId); assert.equal(result.document.layers[1].id, result.layerId);
});

test('late transaction and outer persistence failures delete all fresh scoped assets but retain shared blobs, project and cache', async t => {
  const { native } = await fixture(t), width = 16, height = 9;
  const source = await raster(native, image(width, height, [120, 55, 180, 255]), width, height);
  const doc = await project(native, width, height, [source]);
  // Force reuse of the exact empty canvas PNG so rollback must distinguish EEXIST.
  await native.addPaintLayer({ width, height, layers: [] }, 'Preexisting blank');
  await native.execute('get_preview', { documentId: doc.id, maxWidth: 32 });
  const beforeAssets = await files(native.assetsDir), beforeProjects = await files(native.projectsDir), beforeCache = native.previewCache.stats();
  const operations = id => [{ command: 'create_repair_layer', args: { sourceLayerId: source.id, newLayerId: id } }, { command: 'paint_stroke', args: stroke({ layerId: id, sampleMode: 'current-and-below' }) }];
  const late = [...operations(randomUUID()), { command: 'set_layer', args: { layerId: randomUUID(), name: 'Missing target' } }];
  await assert.rejects(edit(native, doc, 'apply_transaction', { operations: late }));
  assert.deepEqual(await files(native.assetsDir), beforeAssets); assert.deepEqual(await files(native.projectsDir), beforeProjects); assert.deepEqual(native.previewCache.stats(), beforeCache);
  const originalDir = native.projectsDir;
  native.projectsDir = path.join(native.assetsDir, source.asset); // Real ENOTDIR before any project rename.
  try {
    await assert.rejects(edit(native, doc, 'apply_transaction', { operations: operations(randomUUID()) }));
    await assert.rejects(edit(native, doc, 'create_repair_layer', { sourceLayerId: source.id }));
  } finally { native.projectsDir = originalDir; }
  assert.deepEqual(await files(native.assetsDir), beforeAssets); assert.deepEqual(await files(native.projectsDir), beforeProjects); assert.deepEqual(native.previewCache.stats(), beforeCache);
  assert.deepEqual((await native.execute('get_document', { documentId: doc.id })).document, doc);
  const next = await edit(native, doc, 'apply_transaction', { operations: operations(randomUUID()) });
  assert.equal(next.document.revision, doc.revision + 1); assert.ok((await fs.readdir(native.assetsDir)).length > Object.keys(beforeAssets).length);
});

test('scoped rollback excludes unrelated direct helper publication while a repair transaction is suspended', async t => {
  const { native } = await fixture(t), width = 16, height = 9;
  const source = await raster(native, image(width, height, [90, 120, 70, 255]), width, height), doc = await project(native, width, height, [source]);
  const before = await files(native.assetsDir), original = native.storeAsset.bind(native);
  let signal, resume; const reached = new Promise(resolve => { signal = resolve; }), gate = new Promise(resolve => { resume = resolve; });
  let trapped = false;
  native.storeAsset = async (...args) => {
    const result = await original(...args);
    if (!trapped) { trapped = true; signal(); await gate; }
    return result;
  };
  const id = randomUUID(), pending = edit(native, doc, 'apply_transaction', { operations: [
    { command: 'create_repair_layer', args: { sourceLayerId: source.id, newLayerId: id } },
    { command: 'paint_stroke', args: stroke({ layerId: id, sampleMode: 'current-and-below' }) },
    { command: 'set_layer', args: { layerId: randomUUID(), opacity: 0.5 } },
  ] });
  const rejected = assert.rejects(pending);
  await reached;
  const unrelatedBytes = await sharp(image(2, 2, [31, 67, 101, 199]), { raw: { width: 2, height: 2, channels: 4 } }).png().toBuffer();
  const unrelated = await original(unrelatedBytes); resume(); await rejected; native.storeAsset = original;
  assert.deepEqual(await files(native.assetsDir), { ...before, [unrelated]: unrelatedBytes });
  assert.deepEqual((await native.execute('get_document', { documentId: doc.id })).document, doc);
});
