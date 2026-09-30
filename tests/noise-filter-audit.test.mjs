import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { normalizeNoiseParameters, compileNoiseParameters, noiseHash32, sourceNoiseSample, sourceNoiseByte, sourceNoisePlan, sourceNoiseCandidate } from '../server/source-noise-filters.mjs';
import { gaussianNoiseDeviate } from '../server/noise-table.mjs';
import { normalizeLayerFilter, applyLayerFilters, layerFilterSharedBytes, layerFilterSpatialCacheBytes, validateLayerFilterResources, filterWork } from '../server/layer-filters.mjs';
import { estimateFilterBakeBytes, bakeFilterSource } from '../server/filter-bake.mjs';
import { layerTree } from '../server/groups.mjs';
import { encodeProjectBundle } from '../server/project-bundle.mjs';

const tableBytes = await fs.readFile(new URL('./fixtures/noise/gaussian-positive-q8192.bin', import.meta.url));
assert.equal(tableBytes.length, 4096);
assert.equal(createHash('sha256').update(tableBytes).digest('hex'), '317cfb8ef5c5cb825f7f0530359f16c72bb981d69be1c4e7e0119d728ba15ea3');
const table = index => index < 2048 ? -tableBytes.readInt16LE((2047 - index) * 2) : tableBytes.readInt16LE((index - 2048) * 2);
const defaults = supplied => ({ amount: 5, distribution: 'uniform', monochromatic: true, seed: 1, ...supplied });
const mask32 = 0xffffffffn;
function bigHash(value) { let x = BigInt(value) & mask32; x = ((x ^ (x >> 16n)) * 0x7feb352dn) & mask32; x = ((x ^ (x >> 15n)) * 0x846ca68bn) & mask32; return x ^ (x >> 16n); }
function sample(counter, parameters) {
  const key = bigHash((BigInt(parameters.seed) + 0x9e3779b9n) & mask32), word = bigHash(((BigInt(counter) * 0x9e3779b9n) & mask32) ^ key);
  return parameters.distribution === 'uniform' ? Number(2n * (word >> 16n) + 1n - 65536n) : table(Number(word >> 20n));
}
function byte(c, q, p) {
  const d = BigInt(p.distribution === 'uniform' ? 65536 : 8192) * 10000n, n = BigInt(c) * d + BigInt(q) * 255n * BigInt(Math.round(p.amount * 100));
  return n <= 0n ? 0 : n >= 255n * d ? 255 : Number((2n * n + d) / (2n * d));
}
function reference(input, supplied) {
  const p = defaults(supplied), result = Buffer.from(input);
  for (let pixel = 0; pixel < input.length / 4; pixel++) if (input[pixel * 4 + 3]) for (let c = 0; c < 3; c++) result[pixel * 4 + c] = byte(input[pixel * 4 + c], sample(3 * pixel + (p.monochromatic ? 0 : c), p), p);
  return result;
}
const base = extra => ({ id: randomUUID(), name: 'Independent noise audit', visible: true, opacity: 1, blendMode: 'normal', ...extra });
const filter = (parameters, extra = {}) => ({ id: randomUUID(), kind: 'add_noise', value: 0, enabled: true, opacity: 1, ...(parameters === undefined ? {} : { parameters }), ...extra });
const image = (w, h, fn) => Buffer.from(Array.from({ length: w * h }, (_, i) => typeof fn === 'function' ? fn(i % w, Math.floor(i / w), i) : fn).flat());
const edit = (native, doc, command, args = {}) => native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...(command === 'apply_transaction' ? { label: 'Noise audit transaction' } : {}), ...args });
const get = async (native, doc) => (await native.execute('get_document', { documentId: doc.id })).document;
const files = async dir => Object.fromEntries(await Promise.all((await fs.readdir(dir)).sort().map(async name => [name, await fs.readFile(path.join(dir, name))])));
const decode = data => sharp(data).toColourspace('srgb').ensureAlpha().raw().toBuffer();
const project = async (native, width, height, layers, extra = {}) => (await native.newProject({ name: 'Noise audit', width, height, selection: null, layers, ...extra }, 'Fixture')).document;
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-noise-audit-'));
  const native = await new NativeBackend({ dataDir, segmentSubject: () => assert.fail('Noise must not call a model') }).init();
  t.after(async () => { await native.close(); await fs.rm(dataDir, { recursive: true, force: true }); }); return { native, dataDir };
}
async function raster(native, input, width, height, extra = {}) {
  const asset = await native.storeAsset(await sharp(input, { raw: { width, height, channels: 4 } }).png().toBuffer());
  return base({ type: 'raster', width, height, asset, sourceAsset: asset, sourceFormat: 'png', transforms: [], ...extra });
}
async function noPixels(native, run, noFilesystem = false) {
  const restore = [];
  for (const key of ['render', 'renderGraph', 'renderLayer', 'readAlpha', 'storeAlpha', 'storeAsset', 'readProjectAsset', 'validateProjectAsset', 'segmentSubject']) if (typeof native[key] === 'function') { const old = native[key]; native[key] = () => assert.fail(`Unexpected ${key}`); restore.push(() => { native[key] = old; }); }
  if (noFilesystem) for (const key of ['readFile', 'writeFile', 'open', 'rename', 'link', 'stat']) { const old = fs[key]; fs[key] = () => assert.fail(`Unexpected fs.${key}`); restore.push(() => { fs[key] = old; }); }
  try { return await run(); } finally { restore.reverse().forEach(fn => fn()); }
}
function mix(input, candidate, opacity) { const out = Buffer.from(input); for (let i = 0; i < out.length; i += 4) if (out[i + 3]) for (let c = 0; c < 3; c++) out[i + c] = Math.round(input[i + c] + (candidate[i + c] - input[i + c]) * opacity); return out; }

test('actual private table and final seeded counter/byte arithmetic match pinned certificate and BigInt', () => {
  for (let i = 0; i < 4096; i++) { assert.equal(gaussianNoiseDeviate(i), table(i)); assert.equal(gaussianNoiseDeviate(i), -gaussianNoiseDeviate(4095 - i)); }
  let state = 86191; const next = () => state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  for (let i = 0; i < 20000; i++) {
    const word = next(); assert.equal(noiseHash32(word), Number(bigHash(word)));
    const p = { amount: (next() % 40001) / 100, distribution: i % 2 ? 'uniform' : 'gaussian', monochromatic: false, seed: next() }, compiled = compileNoiseParameters(p), counter = next() % 72000000, q = sample(counter, p);
    assert.equal(sourceNoiseSample(counter, compiled), q);
    for (const c of [0, 1, 127, 128, 254, 255]) assert.equal(sourceNoiseByte(c, q, compiled), byte(c, q, p));
  }
  for (const seed of [0, 1, 0xffffffff]) for (const distribution of ['uniform', 'gaussian']) {
    const p = defaults({ amount: 400, distribution, seed }), compiled = compileNoiseParameters(p);
    for (const counter of [0, 1, 2, 3, 24575, 24576, 71999997, 71999998, 71999999]) assert.equal(sourceNoiseSample(counter, compiled), sample(counter, p));
    for (const q of distribution === 'uniform' ? [-65535, -1, 1, 65535] : [-30051, -3, 3, 30051]) for (let c = 0; c <= 255; c++) assert.equal(sourceNoiseByte(c, q, compiled), byte(c, q, p));
  }
});

test('actual source candidate and ordered stack keep alpha skips, same-seed coordinates and fractional opacity exact', async () => {
  const w = 11, h = 7, input = image(w, h, (x, y, i) => [x * 23, y * 37, i * 41 % 256, [0, 1, 128, 255][i % 4]]), unchanged = Buffer.from(input);
  for (const distribution of ['uniform', 'gaussian']) for (const monochromatic of [true, false]) for (const seed of [0, 1, 0xffffffff]) {
    const p = { amount: 137.31, distribution, monochromatic, seed }, full = Buffer.from(input); for (let i = 3; i < full.length; i += 4) full[i] = 255;
    const expected = reference(input, p), actual = await sourceNoiseCandidate(input, w, h, filter(p)), opaque = await sourceNoiseCandidate(full, w, h, filter(p));
    assert.deepEqual(actual, expected); assert.deepEqual(await applyLayerFilters(input, w, h, [filter(p)]), expected);
    for (let i = 0; i < input.length; i += 4) { assert.equal(actual[i + 3], input[i + 3]); assert.deepEqual(actual.subarray(i, i + 3), (input[i + 3] ? opaque : input).subarray(i, i + 3)); }
    assert.deepEqual(await applyLayerFilters(input, w, h, [filter({ ...p, amount: 0 })]), input);
  }
  const first = { amount: 37.11, distribution: 'uniform', monochromatic: false, seed: 0 }, second = { amount: 5, distribution: 'gaussian', monochromatic: true, seed: 0xffffffff };
  const one = mix(input, reference(input, first), .375), expected = mix(one, reference(one, second), .625);
  assert.deepEqual(await applyLayerFilters(input, w, h, [filter(first, { opacity: .375 }), filter(second, { opacity: .625 })]), expected);
  assert.notDeepEqual(await applyLayerFilters(input, w, h, [filter(second, { opacity: .625 }), filter(first, { opacity: .375 })]), expected);
  assert.deepEqual(input, unchanged);
});

test('sparse zero/false parameters, partial updates and recipes stay metadata-only and source-only', async t => {
  const { native } = await fixture(t), input = image(9, 5, (x, y) => [x * 29, y * 51, 127, 255]);
  const source = await raster(native, input, 9, 5, { filters: [filter({ seed: 0, monochromatic: false })] });
  assert.deepEqual(normalizeNoiseParameters(), defaults());
  assert.deepEqual(normalizeLayerFilter(filter({ amount: 0, seed: 0, monochromatic: false })).parameters, defaults({ amount: 0, seed: 0, monochromatic: false }));
  for (const p of [{ amount: .001 }, { seed: -.1 }, { seed: 2 ** 32 }, { seed: .5 }, { monochromatic: 0 }, { distribution: 'normal' }, { sigma: 1 }, { amount: NaN }, { seed: Infinity }]) assert.throws(() => normalizeLayerFilter(filter(p, { enabled: false })));
  let doc = await project(native, 9, 5, [source]), oldAssets = await files(native.assetsDir), filterId = source.filters[0].id;
  doc = (await noPixels(native, () => edit(native, doc, 'update_layer_filter', { layerId: source.id, filterId, parameters: { distribution: 'gaussian' } }))).document;
  assert.deepEqual(doc.layers[0].filters[0].parameters, defaults({ distribution: 'gaussian', seed: 0, monochromatic: false }));
  const saved = await noPixels(native, () => edit(native, doc, 'save_edit_recipe', { name: 'Saved noise, not target defaults', slots: [{ key: 'photo', type: 'raster' }], steps: [{ command: 'add_layer_filter', target: 'photo', args: { kind: 'add_noise', value: 0, parameters: { seed: 0xffffffff, monochromatic: false } } }] })); doc = saved.document;
  assert.deepEqual(doc.editRecipes.find(r => r.id === saved.recipeId).steps[0].args.parameters, defaults({ seed: 0xffffffff, monochromatic: false }));
  const args = { recipeId: saved.recipeId, bindings: { photo: source.id } };
  assert.equal((await noPixels(native, () => edit(native, doc, 'validate_edit_recipe', args), true)).valid, true);
  doc = (await noPixels(native, () => edit(native, doc, 'apply_edit_recipe', args))).document;
  await noPixels(native, () => assert.rejects(edit(native, doc, 'add_adjustment', { kind: 'add_noise', value: 0, parameters: defaults() })));
  await noPixels(native, () => assert.rejects(edit(native, doc, 'save_edit_recipe', { name: 'Invalid global slot', slots: [{ key: 'global', type: 'adjustment', kind: 'add_noise' }], steps: [{ command: 'update_adjustment', target: 'global', args: { value: 0, parameters: {} } }] })));
  assert.deepEqual(await files(native.assetsDir), oldAssets);
});

test('shared Gaussian table stays live at another leaf graph peak, beyond positioned masks, group and clipping buffers', async t => {
  const { native } = await fixture(t), hash = 'a'.repeat(64), small = base({ type: 'raster', width: 1, height: 1, asset: hash, sourceAsset: hash, transforms: [], filters: [filter({ distribution: 'uniform' })] });
  const retained = (width, height) => base({ type: 'solid', width: 1, height: 1, color: '#ffffff', transforms: [], visible: false, mask: { shape: 'positioned', sourceWidth: width, sourceHeight: height, x: 0, y: 0, source: { shape: 'bitmap', x: 0, y: 0, width, height, runs: [], feather: 0, invert: false } } });
  const group = base({ type: 'group', mode: 'isolated', opacity: .5, visible: false });
  const heavy = base({ type: 'raster', width: 6000, height: 4000, asset: hash, sourceAsset: hash, parentId: group.id, transforms: [{ type: 'crop', x: 0, y: 0, width: 1, height: 1 }], filters: [{ ...filter(), kind: 'brightness', value: 1 }] });
  const clip = base({ type: 'solid', width: 1, height: 1, color: '#ffffff', transforms: [], parentId: group.id, clipBaseId: heavy.id });
  const graph = { name: 'Shared table is not leaf-local', width: 1, height: 1, selection: null, layers: [small, retained(6000, 4000), retained(3554, 4000), group, heavy, clip] };
  const old = validateLayerFilterResources(graph, layerTree(graph.layers));
  assert.equal(old.estimatedScratchBytes, 8 * 24_000_000 + 11 + 2 * (24_000_000 + 14_216_000));
  assert.equal(256 * 1024 * 1024 - old.estimatedScratchBytes, 3445);
  const gaussian = filter({ distribution: 'gaussian' });
  assert.equal(layerFilterSharedBytes([gaussian, gaussian]), 4096); assert.equal(layerFilterSpatialCacheBytes([gaussian], 1, 1), 0);
  for (const extra of [{ enabled: false }, { opacity: 0 }, { parameters: { amount: 0, distribution: 'gaussian' } }]) assert.equal(layerFilterSharedBytes([{ ...gaussian, ...extra }]), 0);
  const changed = { ...graph, layers: graph.layers.map(l => l.id === small.id ? { ...l, filters: [gaussian] } : l) };
  assert.throws(() => validateLayerFilterResources(changed, layerTree(changed.layers)), { code: 'LIMIT_EXCEEDED' });
  const doc = await project(native, 1, 1, graph.layers), before = structuredClone(doc);
  await noPixels(native, () => assert.rejects(edit(native, doc, 'update_layer_filter', { layerId: small.id, filterId: small.filters[0].id, parameters: { distribution: 'gaussian' } }), { code: 'LIMIT_EXCEEDED' }));
  await noPixels(native, () => assert.rejects(edit(native, doc, 'apply_transaction', { operations: [{ command: 'update_layer_filter', args: { layerId: small.id, filterId: small.filters[0].id, parameters: { distribution: 'gaussian' } } }, { command: 'rasterize_layer', args: { layerId: clip.id } }] }), { code: 'LIMIT_EXCEEDED' }));
  assert.deepEqual(await get(native, doc), before); assert.deepEqual(await fs.readdir(native.assetsDir), []);
});

test('shared table adds once to every bake phase and a publication-dominant boundary refuses before reading source bytes', async t => {
  const { native, dataDir } = await fixture(t), entries = [filter({ distribution: 'gaussian' }), filter({ distribution: 'gaussian', seed: 0 })];
  const spatial = { ...filter(), kind: 'blur', value: .1 }, params = { width: 64, height: 64, encodedWorkingBytes: 1000, encodedAlphaBytes: 800, hasAlpha: true };
  const plain = estimateFilterBakeBytes({ ...params, filters: [spatial] }), noisy = estimateFilterBakeBytes({ ...params, filters: [spatial, ...entries] });
  for (const name of ['decodeBytes', 'filterBytes', 'encodeBytes', 'publicationBytes']) assert.equal(noisy[name], plain[name] + 4096, name);
  assert.equal(noisy.spatialCacheBytes, plain.spatialCacheBytes);
  const near = { width: 64, height: 64, encodedWorkingBytes: 133_139_456, encodedAlphaBytes: 133_139_456, hasAlpha: true };
  const before = estimateFilterBakeBytes(near), after = estimateFilterBakeBytes({ ...near, filters: entries });
  assert.equal(before.publicationBytes, before.estimatedWorkingBytes); assert.equal(before.maxWorkingBytes - before.estimatedWorkingBytes, 2048); assert.equal(after.estimatedWorkingBytes, before.estimatedWorkingBytes + 4096);
  const source = await raster(native, Buffer.from([90, 120, 170, 128]), 1, 1), alphaAsset = await native.storeAlpha(Buffer.from([177]), 1, 1);
  await fs.truncate(path.join(native.assetsDir, source.asset), near.encodedWorkingBytes); await fs.truncate(path.join(native.assetsDir, alphaAsset), near.encodedAlphaBytes);
  await assert.rejects(bakeFilterSource({ layer: { ...source, width: 64, height: 64, alphaAsset }, filters: entries, assetsDir: native.assetsDir, tempRoot: dataDir }), { code: 'LIMIT_EXCEEDED' });
  assert.equal((await fs.readdir(dataDir)).some(name => name.startsWith('.filter-bake-')), false);
});

test('noise over separate source alpha keeps retained geometry, mask density and clipping exact through Bake', async t => {
  const { native } = await fixture(t), w = 9, h = 7, input = image(w, h, (x, y, i) => [x * 29, y * 37, i * 53 % 256, [0, 1, 128, 255][i % 4]]), alpha = Buffer.from(Array.from({ length: w * h }, (_, i) => [255, 1, 128, 197, 0][i % 5]));
  const first = { amount: 35.79, distribution: 'uniform', monochromatic: false, seed: 0 }, second = { amount: 5, distribution: 'gaussian', monochromatic: true, seed: 0xffffffff }, entries = [filter(first, { opacity: .375 }), filter(second, { opacity: .625 })];
  const group = base({ type: 'group', mode: 'isolated', blendMode: 'multiply', opacity: .7, mask: { x: 1, y: 0, width: 7, height: 6 }, maskDensity: .4 });
  const content = await raster(native, input, w, h, { parentId: group.id, filters: entries, alphaAsset: await native.storeAlpha(alpha, w, h), transforms: [{ type: 'affine', width: w, height: h, x: .4, y: -.3, scaleX: 1.1, scaleY: .9, rotation: 17, flipX: false, flipY: false }], mask: { shape: 'positioned', sourceWidth: w, sourceHeight: h, x: 1, y: -1, source: { shape: 'ellipse', x: 1, y: 1, width: 5, height: 4, feather: 1.2, invert: true } }, maskDensity: .5 });
  const effective = Buffer.from(input); for (let i = 0; i < alpha.length; i++) effective[i * 4 + 3] = Math.round(input[i * 4 + 3] * alpha[i] / 255);
  const one = mix(effective, reference(effective, first), .375), expected = mix(one, reference(one, second), .625);
  assert.deepEqual(await native.renderLayer({ ...content, transforms: [] }), expected);
  const clip = base({ type: 'solid', width: w, height: h, color: '#7d4ac1', transforms: [], parentId: group.id, clipBaseId: content.id, opacity: .43 });
  let doc = await project(native, w, h, [base({ type: 'solid', width: w, height: h, transforms: [], color: '#aabbcc' }), group, content, clip]);
  const before = await native.renderGraph(doc), assets = await files(native.assetsDir), old = structuredClone(content);
  doc = (await edit(native, doc, 'bake_layer_filters', { layerId: content.id })).document;
  const baked = doc.layers.find(l => l.id === content.id), stored = await decode(await fs.readFile(path.join(native.assetsDir, baked.asset)));
  for (let i = 0; i < alpha.length; i++) expected[i * 4 + 3] = input[i * 4 + 3]; assert.deepEqual(stored, expected); assert.deepEqual(await native.renderGraph(doc), before);
  for (const key of Object.keys(old).filter(k => !['asset', 'filters'].includes(k))) assert.deepEqual(baked[key], old[key]);
  for (const [name, data] of Object.entries(assets)) assert.deepEqual(await fs.readFile(path.join(native.assetsDir, name)), data);
});

test('lower protected context and generated member previews keep noise outside the original protected footprint', async t => {
  const { native } = await fixture(t), w = 9, h = 7, person = await raster(native, image(w, h, (x, y) => [188, 127, 81, x < 3 && y > 1 ? [1, 128, 255][x] : 0]), w, h, { protected: true });
  const group = base({ type: 'group', mode: 'isolated', opacity: .6 }), original = image(w, h, (x, y) => [x % 2 ? 220 : 20, y * 35, 150, 255]);
  const content = await raster(native, original, w, h, { parentId: group.id, filters: [filter({ amount: 400, distribution: 'gaussian', seed: 0 })] });
  const generated = await raster(native, image(w, h, [33, 88, 199, 173]), w, h, { parentId: group.id, clipBaseId: content.id, role: 'generated', provenance: { jobId: randomUUID(), mode: 'generate' }, filters: [filter({ amount: 400, monochromatic: false, seed: 0xffffffff })] });
  const doc = await project(native, w, h, [person, group, content, generated]), footprint = await native.protectedPixels(doc, { beforeLayerId: content.id }), altered = await native.renderLayer(content, { protectedPixels: footprint });
  for (let i = 0; i < w * h; i++) if (footprint[i]) assert.deepEqual(altered.subarray(i * 4, i * 4 + 3), original.subarray(i * 4, i * 4 + 3));
  const actual = await native.renderGraph(doc), control = await native.renderGraph({ ...doc, layers: doc.layers.filter(l => l.id !== generated.id).map(l => l.id === content.id ? { ...l, filters: [] } : l) });
  for (let i = 0; i < w * h; i++) if (footprint[i]) assert.deepEqual(actual.subarray(i * 4, i * 4 + 4), control.subarray(i * 4, i * 4 + 4));
  const preview = await native.execute('get_layer_preview', { documentId: doc.id, layerId: generated.id, view: 'layer', maxWidth: 32 }), rgba = await decode(Buffer.from(preview.data, 'base64'));
  for (let i = 0; i < w * h; i++) if (footprint[i]) assert.equal(rgba[i * 4 + 3], 0);
  const identity = await project(native, w, h, [{ ...person, visible: false }, { ...content, parentId: undefined, filters: [filter({ amount: 0, distribution: 'gaussian' })] }]);
  await noPixels(native, () => assert.rejects(edit(native, identity, 'bake_layer_filters', { layerId: content.id }), { code: 'FILTER_BAKE_PROTECTED_CONTEXT' }));
  await assert.rejects(edit(native, identity, 'set_layer_protection', { layerId: content.id, protected: true }), { code: 'PROTECTED_LAYER' });
});

test('real bake/publication rollback and malformed portable noise leave graph, history, cache and files unchanged', async t => {
  const { native } = await fixture(t), source = await raster(native, image(9, 7, (x, y) => [x * 29, y * 37, 128, 255]), 9, 7, { filters: [filter({ distribution: 'gaussian', seed: 0 })] });
  const doc = await project(native, 9, 7, [source]); await native.execute('get_preview', { documentId: doc.id, maxWidth: 32 });
  const assets = await files(native.assetsDir), projects = await files(native.projectsDir), cache = native.previewCache.stats(), directory = native.projectsDir;
  native.projectsDir = path.join(native.assetsDir, source.asset);
  try { await assert.rejects(edit(native, doc, 'bake_layer_filters', { layerId: source.id }), { code: 'ENOTDIR' }); } finally { native.projectsDir = directory; }
  await assert.rejects(edit(native, doc, 'apply_transaction', { operations: [{ command: 'bake_layer_filters', args: { layerId: source.id } }, { command: 'set_layer', args: { layerId: randomUUID(), visible: false } }] }), { code: 'NOT_FOUND' });
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await files(native.assetsDir), assets); assert.deepEqual(await files(native.projectsDir), projects); assert.deepEqual(native.previewCache.stats(), cache);
  for (const parameters of [{ amount: 100.001 }, { distribution: 'normal' }, { seed: 2 ** 32 }, { monochromatic: 1 }, { radius: 1 }]) {
    const graph = { name: 'Malformed noise portable', width: 9, height: 7, selection: null, layers: [{ ...source, filters: [filter(parameters, { enabled: false })] }] };
    const data = await encodeProjectBundle({ graph, validateGraph: () => {}, readAsset: async () => assets[source.asset] });
    await noPixels(native, () => assert.rejects(native.importProject({ data }), { code: 'INVALID_PROJECT_BUNDLE' }), true);
  }
  assert.deepEqual(await files(native.assetsDir), assets); assert.deepEqual(await files(native.projectsDir), projects);
});

test('fixed work, zero identity and wide yielding do not depend on alpha or random outcomes', async () => {
  const gaussian = filter({ distribution: 'gaussian', monochromatic: false }), zero = filter({ amount: 0, distribution: 'gaussian' });
  assert.equal(filterWork(gaussian, 24_000_000), 192_000_000); assert.equal(filterWork(zero, 24_000_000), 24_000_000);
  assert.equal(sourceNoisePlan(gaussian, 6000, 4000).work, 192_000_000); assert.equal(sourceNoisePlan(zero, 6000, 4000).computesCandidate, false);
  const w = 8192, h = 32, input = image(w, h, (x, y, i) => [73, 129, 207, i % 4 ? 255 : 0]), saved = Buffer.from(input); let ticked = false;
  const pending = applyLayerFilters(input, w, h, [gaussian]); setImmediate(() => { ticked = true; }); const output = await pending;
  assert.equal(ticked, true); assert.deepEqual(input, saved);
  for (const pixel of [0, 1, 8191, 8192, 65535, 65536, w * h - 1]) for (let c = 0; c < 4; c++) assert.equal(output[4 * pixel + c], c === 3 || !input[4 * pixel + 3] ? input[4 * pixel + c] : byte(input[4 * pixel + c], sample(3 * pixel + c, defaults(gaussian.parameters)), defaults(gaussian.parameters)));
});
