import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { blendClippingInterior, clipMemberContribution, clippingIndex } from '../server/clipping.mjs';
import { layerTree } from '../server/groups.mjs';
import { dissolveAlpha } from '../server/blend.mjs';
import { prototypeClippingChain } from './prototypes/clipping-reference.mjs';

const coded = code => cause => cause.code === code;
const edit = async (native, doc, command, args = {}) => (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document;
const get = async (native, doc) => (await native.execute('get_document', { documentId: doc.id })).document;
const render = (native, doc) => native.render(native.project(doc.id));
const currentGraph = (native, doc) => { const p = native.project(doc.id); return structuredClone(p.states[p.cursor].graph); };
const png = (pixels, width, height) => sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
const preview = async (native, doc, id, view = 'layer') => {
  const result = await native.execute('get_layer_preview', { documentId: doc.id, layerId: id, view, maxWidth: 32 });
  return { ...result, pixels: await sharp(Buffer.from(result.data, 'base64')).ensureAlpha().raw().toBuffer() };
};
async function fixture(t, { width = 4, height = 1, layers = [], ...options } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-clipping-'));
  const native = await new NativeBackend({ dataDir, ...options }).init();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let document = (await native.execute('create_document', { width, height })).document;
  if (layers.length) {
    const graph = currentGraph(native, document); graph.layers = [];
    for (const item of layers) {
      const pixels = item.pixels ?? Buffer.alloc(width * height * 4, 255), asset = await native.storeAsset(await png(pixels, width, height));
      const { pixels: ignored, ...settings } = item;
      graph.layers.push({ id: randomUUID(), name: 'Fixture image', type: 'raster', visible: true, opacity: 1, blendMode: 'normal',
        asset, sourceAsset: asset, sourceFormat: 'png', width, height, transforms: [], ...settings });
    }
    await native.commit(native.project(document.id), graph, 'Fixture raster layers'); document = await get(native, document);
  }
  return { native, document, dataDir };
}
const filled = (count, color) => Buffer.from(Array.from({ length: count }, () => color).flat());

test('production RGB-only interior matches the independently audited prototype and retains owned alpha and member bytes', async () => {
  for (const mode of ['normal', 'multiply', 'screen']) {
    const base = Buffer.from([201, 80, 20, 128, 30, 90, 160, 1, 77, 51, 93, 0, 80, 60, 40, 255]);
    const member = Buffer.from([20, 150, 220, 255, 230, 10, 80, 128, 9, 9, 9, 255, 90, 70, 110, 200]);
    const original = Buffer.from(base), untouched = Buffer.from(member), mask = [1 / 3, 1, 1, 0], coverage = [0.4, 0.8, 1, 1];
    const expected = prototypeClippingChain({ width: 4, height: 1, base: { pixels: base, mask }, members: [{ pixels: member, blendMode: mode, opacity: 0.7, mask: coverage }], backdrop: Buffer.alloc(16) });
    const result = await blendClippingInterior(base, member, { width: 4, opacity: 0.7, blendMode: mode, baseCoverage: x => mask[x], coverage: x => coverage[x] });
    assert.equal(result, base); assert.deepEqual(base, expected.interior); assert.deepEqual(member, untouched);
    assert.deepEqual([base[3], base[7], base[11], base[15]], [original[3], original[7], original[11], original[15]]);
  }
  // Exact half-byte ties previously rounded down when byte colors were first
  // normalized and interpolated as fractions. Exercise all three reference
  // modes with deterministic independent byte arithmetic at those boundaries.
  let seed = 12345; const random = () => seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  for (let trial = 0; trial < 1000; trial++) {
    const base = Buffer.from([random() % 256, random() % 256, random() % 256, [0, 1, 128, 255][random() % 4]]);
    const member = Buffer.from([random() % 256, random() % 256, random() % 256, [0, 1, 128, 255][random() % 4]]);
    const blendMode = ['normal', 'multiply', 'screen'][random() % 3], opacity = [0, 0.125, 0.5, 0.75, 1][random() % 5];
    const expected = prototypeClippingChain({ width: 1, height: 1, base: { pixels: base }, members: [{ pixels: member, blendMode, opacity }], backdrop: Buffer.alloc(4) }).interior;
    assert.deepEqual(await blendClippingInterior(base, member, { width: 1, blendMode, opacity }), expected, `Trial ${trial}`);
  }
});

test('native multiple clipping members preserve alpha 0/1/128/255 and fractional base-mask coverage exactly once', async t => {
  const base = Buffer.from([200, 10, 30, 128, 20, 60, 90, 1, 70, 80, 90, 0, 180, 100, 50, 255]);
  const upper = filled(4, [10, 100, 220, 255]);
  const { native, document: start } = await fixture(t, { layers: [{ pixels: base }, { pixels: upper }, { pixels: upper }] });
  let doc = start; const [baseId, ...memberIds] = doc.layers.map(x => x.id), originals = await Promise.all(doc.layers.map(x => fs.readFile(path.join(native.assetsDir, x.asset))));
  doc = await edit(native, doc, 'set_clipping_chain', { baseLayerId: baseId, layerIds: memberIds });
  assert.deepEqual(await render(native, doc), Buffer.from([10, 100, 220, 128, 10, 100, 220, 1, 0, 0, 0, 0, 10, 100, 220, 255]));
  doc = await edit(native, doc, 'set_layer', { layerId: baseId, opacity: 0.5 });
  doc = await edit(native, doc, 'set_layer_mask', { layerId: baseId, mask: { shape: 'rectangle', x: 0, y: 0, width: 4, height: 1, feather: 1.5 } });
  const graph = currentGraph(native, doc), coverage = (await import('../server/masks.mjs')).maskCoverage(graph.layers[0].mask);
  const expected = prototypeClippingChain({ width: 4, height: 1, base: { pixels: base, opacity: 0.5, mask: [0, 1, 2, 3].map(x => coverage(x, 0)) }, members: [{ pixels: upper }, { pixels: upper }], backdrop: Buffer.alloc(16) });
  assert.deepEqual(await render(native, doc), expected.pixels);
  for (const [i, layer] of doc.layers.entries()) assert.deepEqual(await fs.readFile(path.join(native.assetsDir, layer.asset)), originals[i]);
  doc = await edit(native, doc, 'set_layer', { layerId: baseId, visible: false }); assert.deepEqual(await render(native, doc), Buffer.alloc(16));
  doc = await edit(native, doc, 'set_layer', { layerId: baseId, visible: true, opacity: 0 }); assert.deepEqual(await render(native, doc), Buffer.alloc(16));
});

test('dissolve decisions are independent for members and final base, including isolated contributions', async t => {
  const width = 64, base = filled(width, [180, 60, 20, 128]), upper = filled(width, [20, 140, 230, 128]);
  const { native, document: start } = await fixture(t, { width, layers: [{ pixels: base, blendMode: 'dissolve', opacity: 0.8 }, { pixels: upper, blendMode: 'dissolve', opacity: 0.7 }] });
  const doc = await edit(native, start, 'set_clipping_chain', { baseLayerId: start.layers[0].id, layerIds: [start.layers[1].id] });
  const pixels = await render(native, doc); let nonzero = 0;
  for (let p = 0; p < width; p++) {
    const a = dissolveAlpha(128 / 255 * 0.8, p), b = dissolveAlpha(128 / 255 * 0.7, p);
    assert.deepEqual([...pixels.subarray(p * 4, p * 4 + 4)], a ? [...(b ? [20, 140, 230] : [180, 60, 20]), 255] : [0, 0, 0, 0]); nonzero += a;
  }
  assert.ok(nonzero > 0 && nonzero < width);
  const contribution = await clipMemberContribution(Buffer.from(upper), base, { width, memberLayer: doc.layers[1], baseLayer: doc.layers[0], coverage: () => 1, baseCoverage: () => 1 });
  for (let p = 0; p < width; p++) assert.equal(contribution[p * 4 + 3], 255 * dissolveAlpha(128 / 255 * 0.8, p) * dissolveAlpha(128 / 255 * 0.7, p));
});

test('base and member previews resolve original sibling context and bounds; source selection remains unclipped and unfiltered', async t => {
  let sampled;
  const base = Buffer.from([30, 90, 180, 0, 30, 90, 180, 128, 30, 90, 180, 255, 30, 90, 180, 0]);
  const upper = filled(4, [200, 50, 80, 255]);
  const { native, document: start } = await fixture(t, { layers: [{ pixels: base }, { pixels: upper }], segmentSubject: async image => {
    sampled = await sharp(image).ensureAlpha().raw().toBuffer(); return { alpha: Buffer.alloc(4, 255), width: 4, height: 1, model: 'test' };
  } });
  let doc = await edit(native, start, 'set_clipping_chain', { baseLayerId: start.layers[0].id, layerIds: [start.layers[1].id] });
  const baseView = await preview(native, doc, start.layers[0].id), memberView = await preview(native, doc, start.layers[1].id);
  assert.deepEqual(baseView.pixels, await render(native, doc)); assert.deepEqual(memberView.pixels, baseView.pixels);
  assert.deepEqual(memberView.visibleBounds, { x: 1, y: 0, width: 2, height: 1 });
  assert.deepEqual((await preview(native, doc, start.layers[1].id, 'source')).pixels, upper);
  doc = await edit(native, doc, 'add_layer_filter', { layerId: start.layers[1].id, kind: 'invert', value: 100 });
  doc = await edit(native, doc, 'select_subject', { layerId: start.layers[1].id }); assert.deepEqual(sampled, upper);
  doc = await edit(native, doc, 'select_subject'); assert.deepEqual(sampled, await render(native, doc));
  doc = await edit(native, doc, 'set_layer', { layerId: start.layers[0].id, visible: false });
  doc = await edit(native, doc, 'set_layer', { layerId: start.layers[1].id, visible: false });
  assert.ok((await preview(native, doc, start.layers[1].id)).pixels.some((v, i) => i % 4 === 3 && v > 0));
  assert.deepEqual(await get(native, doc), doc, 'inspection cannot change visibility or revision');
});

test('lower protected pixels suppress upper colors and filters in composite and isolated preview, including generated members', async t => {
  const protectedPixels = Buffer.from([240, 80, 20, 128, 0, 0, 0, 0, 40, 80, 160, 1, 0, 0, 0, 0]);
  const base = filled(4, [100, 120, 140, 128]), upper = filled(4, [20, 200, 40, 255]);
  const { native, document: start } = await fixture(t, { layers: [{ pixels: protectedPixels, protected: true }, { pixels: base }, { pixels: upper, role: 'generated', provenance: { jobId: randomUUID() } }] });
  const [lower, baseId, memberId] = start.layers.map(x => x.id);
  let doc = await edit(native, start, 'set_layer', { layerId: memberId, visible: false }); const baseline = await render(native, doc);
  doc = await edit(native, doc, 'set_layer', { layerId: memberId, visible: true });
  doc = await edit(native, doc, 'set_clipping_chain', { baseLayerId: baseId, layerIds: [memberId] });
  doc = await edit(native, doc, 'add_layer_filter', { layerId: baseId, kind: 'invert', value: 100 });
  doc = await edit(native, doc, 'add_layer_filter', { layerId: memberId, kind: 'invert', value: 100 });
  const pixels = await render(native, doc), view = await preview(native, doc, memberId), baseView = await preview(native, doc, baseId);
  for (const p of [0, 2]) { assert.deepEqual(pixels.subarray(p * 4, p * 4 + 4), baseline.subarray(p * 4, p * 4 + 4)); assert.equal(view.pixels[p * 4 + 3], 0); assert.deepEqual([...baseView.pixels.subarray(p * 4, p * 4 + 4)], [100, 120, 140, 128]); }
  assert.ok(view.pixels[7] > 0); assert.ok(doc.layers.find(x => x.id === lower).protected);
});

test('structural guards reject partial chains before source/model writes; whole subtree clones remap links', async t => {
  let modelCalls = 0;
  const { native, document: start } = await fixture(t, { layers: [{}, {}, {}], segmentSubject: async () => { modelCalls++; throw new Error('Must not segment'); } });
  const [base, a, b] = start.layers.map(x => x.id);
  let doc = await edit(native, start, 'set_clipping_chain', { baseLayerId: base, layerIds: [a, b] });
  const file = await fs.readFile(path.join(native.projectsDir, `${doc.id}.json`)), assets = await fs.readdir(native.assetsDir);
  for (const id of [base, a, b]) for (const [command, args] of [
    ['delete_layer', {}], ['duplicate_layer', {}], ['reorder_layer', { index: 0 }], ['move_layer', { parentId: null }], ['extract_subject', {}],
    ['align_layers', { layerIds: [id], axis: 'horizontal', alignment: 'start' }],
    ['place_layer', { sourceDocumentId: doc.id, sourceLayerId: id, x: 0, y: 0, width: 4, height: 1 }],
  ]) await assert.rejects(edit(native, doc, command, { layerId: id, ...args }), coded('INVALID_TARGET'));
  await assert.rejects(edit(native, doc, 'group_layers', { layerIds: [base, a] }), coded('INVALID_TARGET'));
  await assert.rejects(edit(native, doc, 'create_group', { index: 1 }), coded('INVALID_TARGET'));
  assert.equal(modelCalls, 0); assert.deepEqual(await fs.readdir(native.assetsDir), assets); assert.deepEqual(await fs.readFile(path.join(native.projectsDir, `${doc.id}.json`)), file);
  doc = await edit(native, doc, 'group_layers', { layerIds: [base, a, b] }); const group = doc.layers[0].id, pixels = await render(native, doc);
  doc = await edit(native, doc, 'duplicate_layer', { layerId: group });
  const copy = doc.layers.slice(4), map = clippingIndex(layerTree(doc.layers));
  assert.equal(map.chains.size, 2); assert.equal(copy[2].clipBaseId, copy[1].id); assert.equal(copy[3].clipBaseId, copy[1].id); assert.notEqual(copy[1].id, base);
  doc = await edit(native, doc, 'delete_layer', { layerId: copy[0].id }); assert.deepEqual(await render(native, doc), pixels);
  doc = await edit(native, doc, 'ungroup_layer', { layerId: group }); assert.deepEqual(await render(native, doc), pixels);
});

test('protection, enabled member styles, generated bases and malformed persisted links reject atomically', async t => {
  const { native, document: start } = await fixture(t, { layers: [{}, {}] }); const [base, upper] = start.layers.map(x => x.id);
  let doc = await edit(native, start, 'set_clipping_chain', { baseLayerId: base, layerIds: [upper] });
  for (const id of [base, upper]) await assert.rejects(edit(native, doc, 'set_layer_protection', { layerId: id, protected: true }), coded('PROTECTED_LAYER'));
  for (const [command, args] of [['set_layer_outline', { width: 1 }], ['set_layer_effects', { effects: { glow: {} } }]])
    await assert.rejects(edit(native, doc, command, { layerId: upper, ...args }), coded('INVALID_TARGET'));
  doc = await edit(native, doc, 'set_layer_effects', { layerId: upper, effects: { shadow: { opacity: 0 } } });
  doc = await edit(native, doc, 'set_layer_outline', { layerId: upper, width: 0 });
  const graph = currentGraph(native, doc);
  for (const mutate of [g => { g.layers[0].role = 'generated'; }, g => { g.layers[1].clipBaseId = randomUUID(); }, g => { g.layers[0].clipBaseId = upper; }, g => { g.layers[1].clipBaseId = null; }, g => { g.layers[1].protected = true; }, g => { g.layers[1].type = 'adjustment'; }]) {
    const bad = structuredClone(graph); mutate(bad); assert.throws(() => native.validateGraph(bad));
  }
  assert.deepEqual(await get(native, doc), doc);
  doc = await edit(native, doc, 'set_clipping_chain', { baseLayerId: base, layerIds: [] });
  doc = await edit(native, doc, 'set_layer_protection', { layerId: upper, protected: true }); assert.ok(doc.layers[1].protected);
});

test('rasterization and source edits preserve links; undo/reopen/portable snapshots retain exact rendering and source bytes', async t => {
  const { native, document: start, dataDir } = await fixture(t);
  let doc = await edit(native, start, 'add_shape', { shape: 'rectangle', x: 1, y: 0, width: 2, height: 1, fill: '#b94488' });
  const base = doc.layers.at(-1).id;
  doc = await edit(native, doc, 'add_shape', { shape: 'rectangle', x: 0, y: 0, width: 4, height: 1, fill: '#22aacc' }); const upper = doc.layers.at(-1).id;
  doc = await edit(native, doc, 'set_clipping_chain', { baseLayerId: base, layerIds: [upper] }); const before = await render(native, doc);
  for (const id of [base, upper]) doc = await edit(native, doc, 'rasterize_layer', { layerId: id });
  assert.equal(doc.layers.find(x => x.id === upper).clipBaseId, base); assert.deepEqual(await render(native, doc), before);
  const source = await fs.readFile(path.join(native.assetsDir, doc.layers.find(x => x.id === upper).sourceAsset));
  doc = await edit(native, doc, 'fill_area', { layerId: upper, color: '#ccaa11' }); const after = await render(native, doc);
  assert.notDeepEqual(after, before); assert.equal(doc.layers.find(x => x.id === upper).clipBaseId, base);
  assert.deepEqual(await fs.readFile(path.join(native.assetsDir, doc.layers.find(x => x.id === upper).sourceAsset)), source);
  doc = await edit(native, doc, 'undo'); assert.deepEqual(await render(native, doc), before);
  doc = await edit(native, doc, 'redo'); assert.deepEqual(await render(native, doc), after);
  const bundle = await native.exportProject({ documentId: doc.id, expectedRevision: doc.revision });
  const imported = (await native.importProject({ data: bundle.data })).document; assert.deepEqual(await render(native, imported), after);
  const reopened = await new NativeBackend({ dataDir }).init(); assert.deepEqual(await render(reopened, doc), after);
  assert.equal((await get(reopened, doc)).layers.find(x => x.id === upper).clipBaseId, base);
});

test('hidden chains without filters and group/filter combinations preflight scratch before rendering or publication', async t => {
  const { native } = await fixture(t); let doc = (await native.execute('create_document', { width: 4000, height: 4000 })).document;
  const base = doc.layers[0].id;
  doc = await edit(native, doc, 'add_shape', { shape: 'rectangle', x: 0, y: 0, width: 1, height: 1 }); const upper = doc.layers.at(-1).id;
  for (let i = 0; i < 3; i++) {
    const layerIds = i === 0 ? [base, upper] : [doc.layers[0].id];
    doc = await edit(native, doc, 'group_layers', { layerIds });
    doc = await edit(native, doc, 'set_group_compositing', { layerId: doc.layers[0].id, mode: 'isolated' });
  }
  doc = await edit(native, doc, 'set_layer', { layerId: doc.layers[0].id, visible: false });
  const before = doc, bytes = await fs.readFile(path.join(native.projectsDir, `${doc.id}.json`));
  native.renderLayer = async () => { throw new Error('No pixel allocation expected'); };
  await assert.rejects(edit(native, doc, 'set_clipping_chain', { baseLayerId: base, layerIds: [upper] }), coded('LIMIT_EXCEEDED'));
  assert.deepEqual(await get(native, doc), before); assert.deepEqual(await fs.readFile(path.join(native.projectsDir, `${doc.id}.json`)), bytes);
  doc = await edit(native, doc, 'set_group_compositing', { layerId: doc.layers[0].id, mode: 'pass-through' });
  doc = await edit(native, doc, 'set_clipping_chain', { baseLayerId: base, layerIds: [upper] });
  assert.equal(doc.layers.at(-1).clipBaseId, base);
});

test('stale revisions, failed transactions and persistence failures preserve committed graph, cache and files', async t => {
  const { native, document: start } = await fixture(t, { layers: [{}, {}] }); const [base, upper] = start.layers.map(x => x.id);
  let doc = await edit(native, start, 'set_clipping_chain', { baseLayerId: base, layerIds: [upper] });
  const before = await native.execute('get_preview', { documentId: doc.id }), file = await fs.readFile(path.join(native.projectsDir, `${doc.id}.json`));
  await assert.rejects(edit(native, doc, 'set_clipping_chain', { expectedRevision: start.revision, baseLayerId: base, layerIds: [] }), coded('REVISION_CONFLICT'));
  await assert.rejects(edit(native, doc, 'apply_transaction', { operations: [
    { command: 'set_clipping_chain', args: { baseLayerId: base, layerIds: [] } },
    { command: 'set_clipping_chain', args: { baseLayerId: base, layerIds: [upper, upper] } },
  ] }), coded('INVALID_ARGUMENT'));
  const persist = native.persist; native.persist = async () => { throw Object.assign(new Error('Injected storage failure'), { code: 'EIO' }); };
  await assert.rejects(edit(native, doc, 'set_clipping_chain', { baseLayerId: base, layerIds: [] }), coded('EIO')); native.persist = persist;
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await fs.readFile(path.join(native.projectsDir, `${doc.id}.json`)), file);
  assert.deepEqual(await native.execute('get_preview', { documentId: doc.id }), before);
});
