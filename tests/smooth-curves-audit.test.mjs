import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { compileSmoothCurveLookup } from '../shared/smooth-curves.mjs';
import { adjustmentTransform, normalizeParameters, COLOR_MAPPING_KINDS } from '../server/color.mjs';
import { applyLayerFilters, filterWork, layerFilterSpatialCacheBytes, layerFilterSharedBytes } from '../server/layer-filters.mjs';
import { editRecipeHash } from '../server/edit-recipes.mjs';
import { encodeProjectBundle } from '../server/project-bundle.mjs';

const base = extra => ({ id: randomUUID(), name: 'Independent smooth Curves audit', visible: true, opacity: 1, blendMode: 'normal', ...extra });
const peak = [{ x: 0, y: 0 }, { x: 127.5, y: 255 }, { x: 255, y: 0 }];
const identity = [{ x: 0, y: 0 }, { x: 255, y: 255 }];
const parameters = (extra = {}) => ({ points: structuredClone(peak), channel: 'rgb', interpolation: 'smooth', ...extra });
const entry = extra => ({ id: randomUUID(), kind: 'curves', value: 0, enabled: true, opacity: 1, parameters: parameters(), ...extra });
const image = (w, h) => Buffer.from(Array.from({ length: w * h }, (_, p) => [p * 37 % 256, p * 73 % 256, p * 97 % 256, [0, 1, 128, 255][p % 4]]).flat());
const fake = (w, h, extra = {}) => base({ type: 'raster', width: w, height: h, asset: 'a'.repeat(64), sourceAsset: 'a'.repeat(64), transforms: [], ...extra });
const bitmap = (bytes, width, height, extra = {}) => ({ shape: 'bitmap', x: 0, y: 0, width, height, runs: Array.from(bytes).flatMap((v, i) => v ? [i, 1, v] : []), feather: 0, invert: false, ...extra });
const graph = (native, doc) => { const p = native.projects.get(doc.id); return structuredClone(p.states[p.cursor].graph); };
const get = async (native, doc) => (await native.execute('get_document', { documentId: doc.id })).document;
const edit = (native, doc, command, args = {}) => native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...(command === 'apply_transaction' ? { label: 'Smooth Curves audit' } : {}), ...args });
const project = async (native, width, height, layers, extra = {}) => (await native.newProject({ name: 'Smooth Curves audit', width, height, selection: null, layers, ...extra }, 'Fixture')).document;
const files = async dir => Object.fromEntries(await Promise.all((await fs.readdir(dir)).sort().map(async name => [name, await fs.readFile(path.join(dir, name))])));
const rounded = (n, d) => Number((2n * BigInt(n) + BigInt(d)) / (2n * BigInt(d)));
// This symmetric three-knot PCHIP has endpoint derivatives ±4 and middle0.
// Direct Hermite expansion gives y=4*x*(255-x)/255, independent of the runtime
// secant ratios, Bezier construction or lookup implementation. Denominator255
// cannot produce an integer-input half tie.
const peakByte = x => rounded(4 * x * (255 - x), 255);
const legacyByte = (points, i) => { let k = 1; while (k < points.length - 1 && points[k].x < i) k++; const a = points[k - 1], b = points[k]; return Math.max(0, Math.min(255, Math.round(a.y + (b.y - a.y) * (i - a.x) / (b.x - a.x)))); };
async function fixture(t) { const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-smooth-curves-audit-')); const native = await new NativeBackend({ dataDir, segmentSubject: () => assert.fail('No model for Curves') }).init(); t.after(async () => { await native.close(); await fs.rm(dataDir, { recursive: true, force: true }); }); return { native }; }
async function raster(native, input, width, height, extra = {}) { const asset = await native.storeAsset(await sharp(input, { raw: { width, height, channels: 4 } }).png().toBuffer()); return fake(width, height, { asset, sourceAsset: asset, ...extra }); }
async function noPixels(native, operation, noIO = false) {
  const saved = [];
  for (const key of ['render', 'renderGraph', 'renderLayer', 'readAlpha', 'storeAlpha', 'storeAsset', 'readProjectAsset', 'validateProjectAsset', 'segmentSubject']) { const old = native[key]; native[key] = () => assert.fail(`Unexpected pixel access: ${key}`); saved.push(() => { native[key] = old; }); }
  if (noIO) for (const key of ['readFile', 'writeFile', 'open', 'rename', 'link', 'unlink', 'mkdir', 'stat']) { const old = fs[key]; fs[key] = () => assert.fail(`Unexpected fs.${key}`); saved.push(() => { fs[key] = old; }); }
  const view = globalThis.DataView; globalThis.DataView = class { constructor() { assert.fail('Metadata must not compile a Smooth LUT'); } }; saved.push(() => { globalThis.DataView = view; });
  try { return await operation(); } finally { saved.reverse().forEach(restore => restore()); }
}

test('Smooth LUT matches an independent polynomial, pins adversarial knots and retains arbitrary finite intervals', () => {
  const lut = compileSmoothCurveLookup(peak), valley = compileSmoothCurveLookup(peak.map(p => ({ ...p, y: 255 - p.y })));
  for (let i = 0; i < 256; i++) { assert.equal(lut[i], peakByte(i)); assert.equal(valley[i], 255 - peakByte(i)); }
  const second = compileSmoothCurveLookup(peak); lut.fill(0); assert.notDeepEqual(lut, second); assert.equal(second.byteLength, 256);
  const endpoint = [{ x: 0, y: 255 }, { x: 255, y: .5 - 2 ** -54 }];
  assert.equal(compileSmoothCurveLookup(endpoint)[255], 0); assert.equal(legacyByte(endpoint, 255), 1);
  for (const interpolation of [undefined, 'linear']) {
    const transform = adjustmentTransform({ kind: 'curves', value: 0, parameters: { points: endpoint, channel: 'rgb', ...(interpolation ? { interpolation } : {}) } });
    for (let i = 0; i < 256; i++) assert.deepEqual(transform(i, 255 - i, i), [legacyByte(endpoint, i), legacyByte(endpoint, 255 - i), legacyByte(endpoint, i)]);
  }
  const tiny = [Number.MIN_VALUE, 2 ** -1022, 2 ** -1000, 2 ** -500, 2 ** -52, 1];
  for (const dx of tiny) for (const dy of tiny) for (const reverse of [false, true]) {
    const points = [{ x: 0, y: 0 }, { x: dx, y: dy }, { x: 2, y: 2 }, { x: 255, y: 255 }].map(p => ({ ...p, y: reverse ? 255 - p.y : p.y }));
    const actual = compileSmoothCurveLookup(points);
    for (let i = 0; i < 256; i++) {
      assert.ok(actual[i] >= 0 && actual[i] <= 255);
      if (i) assert.ok(reverse ? actual[i] <= actual[i - 1] : actual[i] >= actual[i - 1]);
    }
    for (const p of points) if (Number.isInteger(p.x)) assert.equal(actual[p.x], Math.round(p.y));
  }
  const exactIdentity = [{ x: 0, y: 0 }, { x: Number.MIN_VALUE, y: Number.MIN_VALUE }, { x: 1, y: 1 }, { x: 1 + 2 ** -52, y: 1 + 2 ** -52 }, { x: 255, y: 255 }];
  assert.deepEqual([...compileSmoothCurveLookup(exactIdentity)], Array.from({ length: 256 }, (_, i) => i));
  for (const channel of ['rgb', 'red', 'green', 'blue']) {
    const transform = adjustmentTransform({ kind: 'curves', value: 0, parameters: parameters({ channel }) }), rgb = [31, 127, 233];
    assert.deepEqual(transform(...rgb), rgb.map((v, i) => channel === 'rgb' || channel === ['red', 'green', 'blue'][i] ? peakByte(v) : v));
  }
});

test('native sparse defaults and partial mode resets preserve points, masks, history metadata and existing work admission', async t => {
  const { native } = await fixture(t), w = 8, h = 6, source = fake(w, h, { filters: [entry({ parameters: { points: peak } })] });
  const adjustment = base({ type: 'adjustment', kind: 'curves', value: 0, parameters: { points: peak }, mask: { shape: 'rectangle', x: 0, y: 0, width: 4, height: h }, maskDensity: .25 });
  let doc = await project(native, w, h, [source, adjustment]); const old = structuredClone(doc), oldGraph = graph(native, doc);
  await noPixels(native, async () => { native.validateGraph(oldGraph); assert.deepEqual(await get(native, doc), old); });
  for (const [command, target] of [['update_layer_filter', { layerId: source.id, filterId: source.filters[0].id }], ['update_adjustment', { layerId: adjustment.id }]]) {
    doc = (await noPixels(native, () => edit(native, doc, command, { ...target, parameters: { interpolation: 'smooth' } }))).document;
    doc = (await noPixels(native, () => edit(native, doc, command, { ...target, parameters: { channel: 'red' } }))).document;
    let p = command === 'update_adjustment' ? doc.layers[1].parameters : doc.layers[0].filters[0].parameters;
    assert.deepEqual(p, parameters({ channel: 'red' }));
    doc = (await noPixels(native, () => edit(native, doc, command, { ...target, parameters: { interpolation: 'linear' } }))).document;
    p = command === 'update_adjustment' ? doc.layers[1].parameters : doc.layers[0].filters[0].parameters;
    assert.deepEqual(p, { points: peak, channel: 'red' }); assert.equal(Object.hasOwn(p, 'interpolation'), false);
  }
  assert.deepEqual(doc.layers[1].mask, adjustment.mask); assert.equal(doc.layers[1].maskDensity, .25);
  assert.deepEqual(await fs.readdir(native.assetsDir), []);
  for (const interpolation of [undefined, 'linear', 'smooth']) {
    const f = entry({ parameters: { points: peak, ...(interpolation ? { interpolation } : {}) } });
    assert.equal(filterWork(f, 24000000), 24000000); assert.equal(filterWork({ ...f, blendMode: 'multiply' }, 100), 4100);
    assert.equal(layerFilterSharedBytes([f]), 0); assert.equal(layerFilterSpatialCacheBytes([f], 6000, 4000), 0);
  }
  assert.deepEqual(normalizeParameters('curves', {}), { points: identity, channel: 'rgb' });
});

test('canonical omitted-Linear recipes reset Smooth adjustments without changing saved hashes and retain a target source mask', async t => {
  const { native } = await fixture(t), w = 8, h = 6;
  for (const requested of [undefined, 'linear', 'smooth']) {
    const filterMask = { sourceWidth: w, sourceHeight: h, coverage: bitmap(Uint8Array.from({ length: w * h }, (_, p) => p * 17 % 256), w, h), density: .37, enabled: true };
    const source = await raster(native, image(w, h), w, h, { filters: { version: 1, entries: [entry()], mask: filterMask } });
    const grade = base({ type: 'adjustment', kind: 'curves', value: 0, parameters: parameters({ channel: 'blue' }), opacity: .7, mask: { shape: 'rectangle', x: 0, y: 0, width: 4, height: h }, maskDensity: .31 });
    let doc = await project(native, w, h, [source, grade]), control = await project(native, w, h, [source, grade]);
    const p = { points: identity, channel: 'red', ...(requested ? { interpolation: requested } : {}) };
    const definition = { name: 'Independent mode defaults', slots: [{ key: 'photo', type: 'raster' }, { key: 'grade', type: 'adjustment', kind: 'curves' }], steps: [
      { command: 'update_adjustment', target: 'grade', args: { value: 0, parameters: p } },
      { command: 'add_layer_filter', target: 'photo', args: { kind: 'curves', value: 0, parameters: p } },
    ] };
    const saved = await noPixels(native, () => edit(native, doc, 'save_edit_recipe', definition)); doc = saved.document;
    const recipe = doc.editRecipes.find(r => r.id === saved.recipeId), hash = editRecipeHash(recipe), canonical = { points: identity, channel: 'red', ...(requested === 'smooth' ? { interpolation: requested } : {}) };
    assert.deepEqual(recipe.steps[0].args.parameters, canonical); assert.deepEqual(recipe.steps[1].args.parameters, canonical);
    const args = { recipeId: saved.recipeId, bindings: { photo: source.id, grade: grade.id } }, before = structuredClone(doc), assets = await files(native.assetsDir);
    const report = await noPixels(native, () => edit(native, doc, 'validate_edit_recipe', args), true); assert.equal(report.valid, true); assert.equal(report.recipeHash, hash); assert.deepEqual(await get(native, doc), before);
    doc = (await noPixels(native, () => edit(native, doc, 'apply_edit_recipe', args))).document;
    control = (await edit(native, control, 'update_adjustment', { layerId: grade.id, value: 0, parameters: { ...canonical, interpolation: requested === 'smooth' ? 'smooth' : 'linear' } })).document;
    control = (await edit(native, control, 'add_layer_filter', { layerId: source.id, ...recipe.steps[1].args })).document;
    assert.deepEqual(doc.layers[1].parameters, canonical); assert.deepEqual(doc.layers[1].mask, grade.mask); assert.equal(doc.layers[1].maskDensity, grade.maskDensity);
    assert.deepEqual(graph(native, doc).layers[0].filters.mask, filterMask); assert.deepEqual(await native.renderGraph(graph(native, doc)), await native.renderGraph(graph(native, control)));
    assert.deepEqual(doc.editRecipes.find(r => r.id === saved.recipeId), recipe); assert.equal(editRecipeHash(recipe), hash); assert.equal(doc.history.length, before.history.length + 1); assert.deepEqual(await files(native.assetsDir), assets);
    const undone = (await edit(native, doc, 'undo')).document; assert.deepEqual(undone.layers, before.layers);
  }
});

test('Smooth retains different established global and source hidden-RGB policies and existing opacity/mask/protection order', async t => {
  const { native } = await fixture(t), input = Buffer.from([0, 127, 255, 0, 255, 0, 127, 1, 127, 255, 0, 128, 0, 255, 127, 255]), before = Buffer.from(input);
  const p = { points: [{ x: 0, y: 37.5 }, { x: 127, y: .5 }, { x: 255, y: 254.5 }], channel: 'rgb', interpolation: 'smooth' }, lookup = { 0: 38, 127: 1, 255: 255 };
  const raw = [255, 128, 0, 255], layer = { kind: 'curves', value: 0, parameters: p, opacity: .5, mask: bitmap(raw, 4, 1), maskDensity: .5 };
  const actual = await native.applyAdjustment(input, 4, 1, layer, Uint8Array.from([0, 0, 0, 1]));
  assert.equal(COLOR_MAPPING_KINDS.includes('curves'), false);
  for (let i = 0; i < 4; i++) for (let c = 0; c < 4; c++) {
    const old = input[i * 4 + c], amount = .5 * (255 - .5 * (255 - raw[i])) / 255;
    assert.equal(actual[i * 4 + c], c === 3 || i === 3 ? old : Math.round(old + (lookup[old] - old) * amount));
  }
  assert.notDeepEqual(actual.subarray(0, 3), input.subarray(0, 3));
  const source = await applyLayerFilters(input, 4, 1, [entry({ parameters: p, opacity: .5 })]);
  for (let i = 0; i < 4; i++) for (let c = 0; c < 4; c++) { const old = input[i * 4 + c]; assert.equal(source[i * 4 + c], c === 3 || !input[i * 4 + 3] ? old : Math.round(old + (lookup[old] - old) * .5)); }
  assert.deepEqual(input, before);
  assert.deepEqual(await native.applyAdjustment(input, 4, 1, { ...layer, opacity: 0 }), input);
});

test('source alpha, exact curve candidate, Multiply and complete-stack mask precede geometry and survive exact Bake', async t => {
  const { native } = await fixture(t), w = 8, h = 6, input = image(w, h), alpha = Uint8Array.from({ length: w * h }, (_, p) => [255, 128, 1, 0, 199][p % 5]), raw = Uint8Array.from({ length: w * h }, (_, p) => p * 53 % 256);
  const mask = { sourceWidth: w, sourceHeight: h, coverage: bitmap(raw, w, h, { invert: true }), density: .1, enabled: true };
  const source = await raster(native, input, w, h, { alphaAsset: await native.storeAlpha(Buffer.from(alpha), w, h), filters: { version: 1, entries: [entry({ opacity: .5, blendMode: 'multiply' })], mask } });
  let doc = await project(native, w, h, [source]);
  const corners = [[1, 0], [w + 1, 0], [w + 1, h], [1, h]].map(([x, y]) => ({ x, y }));
  doc = (await edit(native, doc, 'add_layer_distort', { layerId: source.id, corners })).document;
  const wanted = Buffer.from(input);
  for (let p = 0; p < w * h; p++) {
    wanted[p * 4 + 3] = rounded(input[p * 4 + 3] * alpha[p], 255); const effective = Math.round(255 - .1 * raw[p]);
    if (wanted[p * 4 + 3]) for (let c = 0; c < 3; c++) {
      const before = input[p * 4 + c], filtered = rounded(255 * before + before * peakByte(before), 510);
      wanted[p * 4 + c] = rounded(before * (255 - effective) + filtered * effective, 255);
    }
  }
  const translated = Buffer.alloc(input.length); for (let y = 0; y < h; y++) wanted.copy(translated, (y * w + 1) * 4, y * w * 4, (y * w + w - 1) * 4);
  assert.deepEqual(await native.renderLayer(graph(native, doc).layers[0]), translated);
  const assets = await files(native.assetsDir), appearance = await native.renderGraph(graph(native, doc));
  doc = (await edit(native, doc, 'bake_layer_filters', { layerId: source.id })).document;
  const baked = graph(native, doc).layers[0], bytes = await sharp(await fs.readFile(path.join(native.assetsDir, baked.asset))).ensureAlpha().raw().toBuffer();
  for (let p = 0; p < w * h; p++) { assert.deepEqual(bytes.subarray(p * 4, p * 4 + 3), wanted.subarray(p * 4, p * 4 + 3)); assert.equal(bytes[p * 4 + 3], input[p * 4 + 3]); }
  assert.equal(baked.alphaAsset, source.alphaAsset); assert.equal(baked.sourceAsset, source.sourceAsset); assert.deepEqual(baked.filters, []); assert.deepEqual(baked.transforms[0].corners, corners);
  assert.deepEqual(await native.renderGraph(graph(native, doc)), appearance);
  for (const [name, bytes] of Object.entries(assets)) assert.deepEqual(await fs.readFile(path.join(native.assetsDir, name)), bytes);
});

test('smooth source grading and generated clipping obey lower protected context while isolated source inspection remains unfiltered', async t => {
  const { native } = await fixture(t), w = 9, h = 7, count = w * h;
  const personBytes = Buffer.from(Array.from({ length: count }, (_, p) => [31, 117, 209, p % w >= 3 && p % w <= 5 ? [1, 128, 255][p % 3] : 0]).flat());
  const person = await raster(native, personBytes, w, h, { protected: true, outline: { width: 1, color: '#ffffff' } }), group = base({ type: 'group', mode: 'isolated', opacity: .7 });
  const sourceBytes = image(w, h); for (let p = 0; p < count; p++) sourceBytes[p * 4 + 3] = 255;
  const source = await raster(native, sourceBytes, w, h, { parentId: group.id }), memberBytes = Buffer.from(Array.from({ length: count }, () => [29, 157, 71, 177]).flat());
  const member = await raster(native, memberBytes, w, h, { parentId: group.id, clipBaseId: source.id, role: 'generated', provenance: { jobId: randomUUID(), mode: 'generate' }, visible: false });
  let doc = await project(native, w, h, [person, group, source, member]); const baseline = await native.renderGraph(graph(native, doc)), footprint = await native.protectedPixels(graph(native, doc)), assets = await files(native.assetsDir);
  for (const layerId of [source.id, member.id]) doc = (await edit(native, doc, 'add_layer_filter', { layerId, kind: 'curves', value: 0, parameters: parameters() })).document;
  doc = (await edit(native, doc, 'set_layer', { layerId: member.id, visible: true })).document;
  const actual = await native.renderGraph(graph(native, doc)); let changed = 0;
  const preview = async (layerId, view = 'layer') => { const r = await native.execute('get_layer_preview', { documentId: doc.id, layerId, view, maxWidth: 32 }); return sharp(Buffer.from(r.data, 'base64')).ensureAlpha().raw().toBuffer(); };
  const sourceView = await preview(source.id), memberView = await preview(member.id);
  for (let p = 0; p < count; p++) if (footprint[p]) {
    assert.deepEqual(actual.subarray(p * 4, p * 4 + 4), baseline.subarray(p * 4, p * 4 + 4));
    assert.deepEqual(sourceView.subarray(p * 4, p * 4 + 3), sourceBytes.subarray(p * 4, p * 4 + 3)); assert.equal(memberView[p * 4 + 3], 0);
  } else if (!actual.subarray(p * 4, p * 4 + 4).equals(baseline.subarray(p * 4, p * 4 + 4))) changed++;
  assert.ok(changed > 0); assert.deepEqual(await preview(member.id, 'source'), memberBytes);
  await noPixels(native, () => assert.rejects(edit(native, doc, 'add_layer_filter', { layerId: person.id, kind: 'curves', value: 0, parameters: parameters({ points: identity }) }), { code: 'PROTECTED_LAYER' }));
  await noPixels(native, () => assert.rejects(edit(native, doc, 'bake_layer_filters', { layerId: source.id }), { code: 'FILTER_BAKE_PROTECTED_CONTEXT' }));
  assert.deepEqual(await files(native.assetsDir), assets);
});

test('malformed smooth global/source/recipe metadata rejects before portable assets and failed commands leave the graph unchanged', async t => {
  const { native } = await fixture(t), w = 8, h = 6, source = await raster(native, image(w, h), w, h), doc = await project(native, w, h, [source]), assets = await files(native.assetsDir);
  const validBundle = await encodeProjectBundle({ graph: graph(native, doc), validateGraph: value => native.validateGraph(value), readAsset: asset => fs.readFile(path.join(native.assetsDir, asset)) });
  const size = validBundle.readUInt32BE(8), manifest = JSON.parse(validBundle.subarray(12, 12 + size));
  const forged = graph => { const json = Buffer.from(JSON.stringify({ ...manifest, graph })), header = Buffer.from(validBundle.subarray(0, 12)); header.writeUInt32BE(json.length, 8); return Buffer.concat([header, json, validBundle.subarray(12 + size)]); };
  const invalid = [{ interpolation: null }, { interpolation: 'cubic' }, { interpolation: true }, { interpolation: 'smooth', extra: 1 }, { interpolation: 'smooth', points: [{ x: 0, y: 0 }, { x: 0, y: 50 }, { x: 255, y: 255 }] }];
  for (const parameters of invalid) {
    for (const command of ['add_adjustment', 'add_layer_filter']) await noPixels(native, () => assert.rejects(edit(native, doc, command, { ...(command === 'add_layer_filter' ? { layerId: source.id } : {}), kind: 'curves', value: 0, parameters })));
    const recipe = { id: randomUUID(), version: 1, name: 'Bad interpolation', slots: [{ key: 'grade', type: 'adjustment', kind: 'curves' }], steps: [{ command: 'update_adjustment', target: 'grade', args: { value: 0, parameters } }] };
    for (const extra of [
      { layers: [{ ...source, filters: [entry({ parameters })] }] },
      { layers: [source, base({ type: 'adjustment', kind: 'curves', value: 0, parameters })] },
      { layers: [source], editRecipes: [recipe] },
    ]) {
      const g = { name: 'Malformed interpolation', width: w, height: h, selection: null, ...extra };
      const data = forged(g);
      await noPixels(native, () => assert.rejects(native.importProject({ data }), { code: 'INVALID_PROJECT_BUNDLE' }), true);
    }
  }
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await files(native.assetsDir), assets);
});

test('real persistence refusal and late Bake/paint transaction failure keep prior modes, history and owned assets atomic', async t => {
  const { native } = await fixture(t), w = 8, h = 6, source = await raster(native, image(w, h), w, h, { filters: [entry({ parameters: { points: peak, channel: 'rgb' } })] });
  const grade = base({ type: 'adjustment', kind: 'curves', value: 0, parameters: { points: identity, channel: 'rgb' } }), doc = await project(native, w, h, [source, grade]);
  const assets = await files(native.assetsDir), projects = await files(native.projectsDir), directory = native.projectsDir;
  native.projectsDir = path.join(native.assetsDir, source.asset);
  try { await assert.rejects(edit(native, doc, 'update_adjustment', { layerId: grade.id, parameters: { interpolation: 'smooth' } })); } finally { native.projectsDir = directory; }
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await files(native.projectsDir), projects); assert.deepEqual(await files(native.assetsDir), assets);
  const store = native.storeAsset; let writes = 0; native.storeAsset = async function (...args) { writes++; return store.apply(this, args); };
  try { await assert.rejects(edit(native, doc, 'apply_transaction', { operations: [
    { command: 'update_adjustment', args: { layerId: grade.id, parameters: { interpolation: 'smooth' } } },
    { command: 'update_layer_filter', args: { layerId: source.id, filterId: source.filters[0].id, parameters: { interpolation: 'smooth' } } },
    { command: 'bake_layer_filters', args: { layerId: source.id } },
    { command: 'paint_stroke', args: { layerId: source.id, tool: 'brush', color: '#cc5522', size: 2, opacity: 1, hardness: 1, points: [{ x: 3, y: 3 }] } },
    { command: 'set_layer', args: { layerId: randomUUID(), opacity: .5 } },
  ] }), { code: 'NOT_FOUND' }); } finally { native.storeAsset = store; }
  assert.ok(writes >= 2); assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await files(native.assetsDir), assets); assert.deepEqual(await files(native.projectsDir), projects);
});
