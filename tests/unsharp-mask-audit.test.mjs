import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { normalizeUnsharpParameters, compileUnsharpAmount, unsharpChannelByte } from '../server/unsharp-mask.mjs';
import { normalizeLayerFilter, applyLayerFilters, validateLayerFilterResources, filterWork } from '../server/layer-filters.mjs';
import { sourceSpatialPlan } from '../server/source-spatial-filters.mjs';
import { estimateFilterBakeBytes, bakeFilterSource } from '../server/filter-bake.mjs';
import { layerTree } from '../server/groups.mjs';
import { encodeProjectBundle } from '../server/project-bundle.mjs';

const base = extra => ({ id: randomUUID(), name: 'Independent Unsharp audit', visible: true, opacity: 1, blendMode: 'normal', ...extra });
const filter = (parameters, extra = {}) => ({ id: randomUUID(), kind: 'unsharp_mask', value: 0, enabled: true, opacity: 1, ...(parameters === undefined ? {} : { parameters }), ...extra });
const image = (w, h, fn) => Buffer.from(Array.from({ length: w * h }, (_, i) => typeof fn === 'function' ? fn(i % w, Math.floor(i / w), i) : fn).flat());
const edit = (native, doc, command, args = {}) => native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...(command === 'apply_transaction' ? { label: 'Unsharp audit transaction' } : {}), ...args });
const get = async (native, doc) => (await native.execute('get_document', { documentId: doc.id })).document;
const files = async dir => Object.fromEntries(await Promise.all((await fs.readdir(dir)).sort().map(async name => [name, await fs.readFile(path.join(dir, name))])));
const decode = bytes => sharp(bytes).toColourspace('srgb').ensureAlpha().raw().toBuffer();
const project = async (native, width, height, layers, extra = {}) => (await native.newProject({ name: 'Unsharp audit', width, height, selection: null, layers, ...extra }, 'Fixture')).document;
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-unsharp-audit-'));
  const native = await new NativeBackend({ dataDir, segmentSubject: () => assert.fail('Unsharp must not call a model') }).init();
  t.after(async () => { await native.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { native, dataDir };
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
function exactByte(c, n, d, amount, threshold) {
  const C = BigInt(c), N = BigInt(n), D = BigInt(d), R = C * D - N;
  if ((R < 0n ? -R : R) <= BigInt(threshold) * D) return c;
  const denominator = 10000n * D, numerator = C * denominator + BigInt(Math.round(amount * 100)) * R;
  return numerator <= 0n ? 0 : numerator >= 255n * denominator ? 255 : Number((2n * numerator + denominator) / (2n * denominator));
}
function kernel(sigma) {
  const r = Math.ceil(3 * sigma), sides = Array.from({ length: r }, (_, i) => Math.exp(-((i + 1) ** 2) / (2 * sigma * sigma))), z = 1 + 2 * sides.reduce((a, b) => a + b, 0), q = sides.map(v => Math.round(v * 65536 / z));
  return [...q].reverse().concat(65536 - 2 * q.reduce((a, b) => a + b, 0), q);
}
function reference(input, w, h, { amount = 100, sigma = 1, threshold = 0 } = {}) {
  const out = Buffer.from(input); if (!amount || !sigma || threshold === 255) return out;
  const k = kernel(sigma), radius = (k.length - 1) / 2;
  const axis = (position, size) => { const sums = Array(size).fill(0n); k.forEach((weight, i) => { sums[Math.max(0, Math.min(size - 1, position + i - radius))] += BigInt(weight); }); return sums; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const at = (y * w + x) * 4; if (!input[at + 3]) continue;
    const xs = axis(x, w), ys = axis(y, h), sum = [0n, 0n, 0n]; let d = 0n;
    for (let sy = 0; sy < h; sy++) for (let sx = 0; sx < w; sx++) { const i = (sy * w + sx) * 4, weight = xs[sx] * ys[sy] * BigInt(input[i + 3]); d += weight; for (let c = 0; c < 3; c++) sum[c] += weight * BigInt(input[i + c]); }
    for (let c = 0; c < 3; c++) out[at + c] = exactByte(input[at + c], sum[c], d, amount, threshold);
  }
  return out;
}
function mix(before, candidate, opacity) { const out = Buffer.from(before); for (let i = 0; i < out.length; i += 4) if (out[i + 3]) for (let c = 0; c < 3; c++) out[i + c] = Math.round(before[i + c] + (candidate[i + c] - before[i + c]) * opacity); return out; }

test('production reduced and generic channel arithmetic match BigInt near thresholds, half ties and safe-integer bounds', () => {
  const maxD = 255 * 65536 ** 2, amounts = [.01, 5, 6.25, 12.5, 25, 37, 100, 110, 133.33, 300, 500];
  let state = 98731; const next = () => state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  for (let i = 0; i < 20000; i++) { const d = 1 + (next() * 257) % maxD, c = next() % 256, amount = (next() % 50001) / 100, threshold = next() % 256, n = Math.floor(next() / 2 ** 32 * 255 * d); assert.equal(unsharpChannelByte(c, n, d, compileUnsharpAmount(amount), threshold), exactByte(c, n, d, amount, threshold)); }
  for (const amount of amounts) for (const d of [1, 2, 65536 ** 2, maxD - 1, maxD]) for (const c of [0, 1, 80, 128, 254, 255]) for (const target of [0, 1, 77, 127, 254]) for (const delta of [-1n, 0n, 1n]) {
    const D = BigInt(d), C = BigInt(c), A = BigInt(Math.round(amount * 100)), residual = ((BigInt(2 * target + 1) - 2n * C) * 5000n * D) / A, N = C * D - residual + delta;
    if (N >= 0n && N <= 255n * D) assert.equal(unsharpChannelByte(c, Number(N), d, compileUnsharpAmount(amount), 0), exactByte(c, N, d, amount, 0));
  }
  for (const d of [1, maxD - 1, maxD]) for (const threshold of [1, 64, 127]) for (const sign of [-1, 1]) for (const delta of [-1, 0, 1]) {
    const n = 128 * d - sign * threshold * d + delta;
    assert.equal(unsharpChannelByte(128, n, d, compileUnsharpAmount(500), threshold), exactByte(128, n, d, 500, threshold));
    if (!delta) assert.equal(unsharpChannelByte(128, n, d, compileUnsharpAmount(500), threshold), 128);
  }
});

test('real source stacks use unrounded per-channel threshold and preserve alpha/hidden RGB with default sharpen parity', async () => {
  for (const rightAlpha of [127, 128, 129]) {
    const input = Buffer.from([80, 100, 120, 128, 208, 100, 184, rightAlpha]), params = { amount: 500, sigma: .3977, threshold: 5 };
    const expected = reference(input, 2, 1, params), actual = await applyLayerFilters(input, 2, 1, [filter(params)]);
    assert.deepEqual(actual, expected); assert.equal(actual[1], 100); assert.equal(actual[2], 120);
    assert.equal(actual[3], 128); assert.equal(actual[7], rightAlpha);
    if (rightAlpha === 128) assert.deepEqual(actual, input, 'exact five-level channel differences do not sharpen');
    if (rightAlpha === 129) assert.notEqual(actual[0], input[0], 'fraction just above5 sharpens although rounded Gaussian difference is still5');
    if (rightAlpha === 127) assert.equal(actual[0], input[0], 'fraction below5 remains unchanged');
  }
  const params = [{}, { amount: .01, sigma: Number.MIN_VALUE }, { amount: 37, sigma: .528474 }, { amount: 133.33, sigma: 1.7, threshold: 13 }, { amount: 500, sigma: 50 }, { amount: 12.5, sigma: .3977 }, { sigma: 0 }, { amount: 0, sigma: 50 }, { threshold: 255, sigma: 50 }];
  for (const [w, h] of [[1, 7], [9, 1], [7, 5]]) {
    const input = image(w, h, (x, y, i) => [i * 47 % 256, x * 31, y * 43, [0, 1, 128, 255][i % 4]]), saved = Buffer.from(input);
    for (const p of params) assert.deepEqual(await applyLayerFilters(input, w, h, [filter(p)]), reference(input, w, h, p));
    for (const sigma of [0, Number.MIN_VALUE, .1, .3977, 1, 10]) assert.deepEqual(await applyLayerFilters(input, w, h, [filter({ sigma })]), await applyLayerFilters(input, w, h, [{ ...filter(), kind: 'sharpen', value: sigma, parameters: undefined }]));
    assert.deepEqual(input, saved);
    const hidden = Buffer.from(input); for (let i = 0; i < hidden.length; i += 4) if (!hidden[i + 3]) for (let c = 0; c < 3; c++) hidden[i + c] ^= 255;
    const original = await applyLayerFilters(input, w, h, [filter({ amount: 500, sigma: 3 })]), changed = await applyLayerFilters(hidden, w, h, [filter({ amount: 500, sigma: 3 })]);
    for (let i = 0; i < input.length; i += 4) assert.deepEqual(changed.subarray(i, i + 4), (input[i + 3] ? original : hidden).subarray(i, i + 4));
  }
});

test('sparse defaults, partial native updates and recipe canonicalization preserve source-only semantics', async t => {
  const { native } = await fixture(t), w = 7, h = 5, source = await raster(native, image(w, h, (x, y) => [x * 31, y * 47, 190, 255]), w, h);
  assert.deepEqual(normalizeUnsharpParameters(), { amount: 100, sigma: 1, threshold: 0 });
  assert.deepEqual(normalizeLayerFilter(filter({ threshold: 13 })).parameters, { amount: 100, sigma: 1, threshold: 13 });
  for (const parameters of [{ amount: 10.001 }, { sigma: 50.1 }, { threshold: 1.5 }, { amount: NaN }, { threshold: Infinity }, { radius: 1 }]) assert.throws(() => normalizeLayerFilter(filter(parameters, { enabled: false })));
  assert.throws(() => normalizeLayerFilter(filter({}, { value: 1 })));
  let doc = await project(native, w, h, [{ ...source, filters: [filter({ amount: 37 })] }]); const assets = await files(native.assetsDir), id = doc.layers[0].filters[0].id;
  doc = (await edit(native, doc, 'update_layer_filter', { layerId: source.id, filterId: id, parameters: { sigma: 2.75 } })).document;
  assert.deepEqual(doc.layers[0].filters[0].parameters, { amount: 37, sigma: 2.75, threshold: 0 });
  doc = (await edit(native, doc, 'update_layer_filter', { layerId: source.id, filterId: id, parameters: { threshold: 7 } })).document;
  assert.deepEqual(doc.layers[0].filters[0].parameters, { amount: 37, sigma: 2.75, threshold: 7 });
  const saved = await edit(native, doc, 'save_edit_recipe', { name: 'Independent Unsharp preset', slots: [{ key: 'photo', type: 'raster' }], steps: [{ command: 'add_layer_filter', target: 'photo', args: { kind: 'unsharp_mask', value: 0, parameters: { threshold: 9 } } }] }); doc = saved.document;
  const stored = doc.editRecipes.find(r => r.id === saved.recipeId).steps[0].args;
  assert.deepEqual(stored.parameters, { amount: 100, sigma: 1, threshold: 9 }); assert.equal(stored.value, 0); assert.equal(stored.enabled, true); assert.equal(stored.opacity, 1);
  const args = { recipeId: saved.recipeId, bindings: { photo: source.id } };
  assert.equal((await noPixels(native, () => edit(native, doc, 'validate_edit_recipe', args), true)).valid, true);
  doc = (await noPixels(native, () => edit(native, doc, 'apply_edit_recipe', args))).document;
  assert.deepEqual(doc.layers[0].filters.at(-1).parameters, stored.parameters);
  await assert.rejects(edit(native, doc, 'add_adjustment', { kind: 'unsharp_mask', value: 0, parameters: {} }));
  const global = base({ type: 'adjustment', kind: 'unsharp_mask', value: 0, parameters: {} }); assert.throws(() => native.validateGraph({ ...doc, layers: [source, global] }));
  assert.deepEqual(await files(native.assetsDir), assets);
});

test('source-alpha filtering and fractional stack order remain exact through geometry/masks and bake', async t => {
  const { native } = await fixture(t), w = 9, h = 7, input = image(w, h, (x, y, i) => [x * 29, y * 37, i * 53 % 256, [0, 1, 128, 255][i % 4]]), alpha = Buffer.from(Array.from({ length: w * h }, (_, i) => [255, 1, 128, 197, 0][i % 5]));
  const first = { amount: 133.33, sigma: .8, threshold: 3 }, second = { amount: 37, sigma: 1.7, threshold: 0 }, entries = [filter(first, { opacity: .37 }), filter(second, { opacity: .61 })];
  const group = base({ type: 'group', mode: 'isolated', blendMode: 'multiply', opacity: .7, mask: { x: 1, y: 0, width: 7, height: 6 }, maskDensity: .4 });
  const content = await raster(native, input, w, h, { parentId: group.id, filters: entries, alphaAsset: await native.storeAlpha(alpha, w, h), transforms: [{ type: 'affine', width: w, height: h, x: .4, y: -.3, scaleX: 1.1, scaleY: .9, rotation: 17, flipX: false, flipY: false }], mask: { shape: 'positioned', sourceWidth: w, sourceHeight: h, x: 1, y: -1, source: { shape: 'ellipse', x: 1, y: 1, width: 5, height: 4, feather: 1.2, invert: true } }, maskDensity: .5 });
  const effective = Buffer.from(input); for (let i = 0; i < alpha.length; i++) effective[i * 4 + 3] = Math.round(input[i * 4 + 3] * alpha[i] / 255);
  const a = mix(effective, reference(effective, w, h, first), .37), expected = mix(a, reference(a, w, h, second), .61);
  assert.deepEqual(await native.renderLayer({ ...content, transforms: [] }), expected);
  const clip = base({ type: 'solid', width: w, height: h, color: '#7d4ac1', transforms: [], parentId: group.id, clipBaseId: content.id, opacity: .43 });
  let doc = await project(native, w, h, [base({ type: 'solid', width: w, height: h, transforms: [], color: '#aabbcc' }), group, content, clip]);
  const before = await native.renderGraph(doc), assets = await files(native.assetsDir), old = structuredClone(content);
  doc = (await edit(native, doc, 'bake_layer_filters', { layerId: content.id })).document;
  const baked = doc.layers.find(l => l.id === content.id), stored = await decode(await fs.readFile(path.join(native.assetsDir, baked.asset)));
  for (let i = 0; i < alpha.length; i++) expected[i * 4 + 3] = input[i * 4 + 3]; assert.deepEqual(stored, expected);
  assert.deepEqual(await native.renderGraph(doc), before); for (const key of Object.keys(old).filter(k => !['asset', 'filters'].includes(k))) assert.deepEqual(baked[key], old[key]);
  for (const [name, data] of Object.entries(assets)) assert.deepEqual(await fs.readFile(path.join(native.assetsDir, name)), data);
});

test('protected contextual RGB, generated clipped previews and metadata identities retain the same safety guards', async t => {
  const { native } = await fixture(t), w = 9, h = 7, person = await raster(native, image(w, h, (x, y) => [188, 127, 81, x < 3 && y > 1 ? [1, 128, 255][x] : 0]), w, h, { protected: true });
  const group = base({ type: 'group', mode: 'isolated', opacity: .6 }), original = image(w, h, (x, y) => [x % 2 ? 220 : 20, y * 35, 150, 255]);
  const content = await raster(native, original, w, h, { parentId: group.id, filters: [filter({ amount: 37, sigma: .528474 })] });
  const generated = await raster(native, image(w, h, [33, 88, 199, 173]), w, h, { parentId: group.id, clipBaseId: content.id, role: 'generated', provenance: { jobId: randomUUID(), mode: 'generate' }, filters: [filter({ amount: 500, sigma: 2 })] });
  const doc = await project(native, w, h, [person, group, content, generated]), footprint = await native.protectedPixels(doc, { beforeLayerId: content.id }), altered = await native.renderLayer(content, { protectedPixels: footprint });
  for (let i = 0; i < w * h; i++) if (footprint[i]) assert.deepEqual(altered.subarray(i * 4, i * 4 + 3), original.subarray(i * 4, i * 4 + 3));
  const actual = await native.renderGraph(doc), control = await native.renderGraph({ ...doc, layers: doc.layers.filter(l => l.id !== generated.id).map(l => l.id === content.id ? { ...l, filters: [] } : l) });
  for (let i = 0; i < w * h; i++) if (footprint[i]) assert.deepEqual(actual.subarray(i * 4, i * 4 + 4), control.subarray(i * 4, i * 4 + 4));
  const preview = await native.execute('get_layer_preview', { documentId: doc.id, layerId: generated.id, view: 'layer', maxWidth: 32 }), rgba = await decode(Buffer.from(preview.data, 'base64'));
  for (let i = 0; i < w * h; i++) if (footprint[i]) assert.equal(rgba[i * 4 + 3], 0);
  for (const parameters of [{ amount: 0 }, { sigma: 0 }, { threshold: 255 }, { sigma: Number.MIN_VALUE }]) {
    const target = { ...content, parentId: undefined, filters: [filter(parameters)] }, identity = await project(native, w, h, [{ ...person, visible: false }, target]);
    await noPixels(native, () => assert.rejects(edit(native, identity, 'bake_layer_filters', { layerId: target.id }), { code: 'FILTER_BAKE_PROTECTED_CONTEXT' }));
    await assert.rejects(edit(native, identity, 'set_layer_protection', { layerId: target.id, protected: true }), { code: 'PROTECTED_LAYER' });
  }
});

test('parameter-driven work and ring phases revalidate identities, partial updates and combined retained masks', async t => {
  const { native } = await fixture(t), w = 3000, h = 2000, s = w * h;
  const layer = base({ type: 'raster', width: w, height: h, asset: 'a'.repeat(64), sourceAsset: 'a'.repeat(64), transforms: [{ type: 'crop', x: 0, y: 0, width: 1, height: 1 }], visible: false, filters: [filter({ amount: 0, sigma: 50 })] });
  let doc = await project(native, 1, 1, [layer]); const id = doc.layers[0].filters[0].id;
  for (const params of [{ amount: 0, sigma: 50 }, { sigma: 0 }, { sigma: 50, threshold: 255 }]) { const f = filter(params), plan = sourceSpatialPlan(f, w, h); assert.equal(plan.work, s); assert.equal(plan.cacheBytes, 0); assert.equal(filterWork(f, s), s); }
  assert.equal(sourceSpatialPlan(filter({ sigma: Number.MIN_VALUE }), w, h).work, s * 46);
  await noPixels(native, () => assert.rejects(edit(native, doc, 'update_layer_filter', { layerId: layer.id, filterId: id, parameters: { amount: 100 } }), { code: 'LIMIT_EXCEEDED' }));
  doc = (await edit(native, doc, 'update_layer_filter', { layerId: layer.id, filterId: id, parameters: { sigma: 1, amount: 100 } })).document;
  assert.equal(filterWork(doc.layers[0].filters[0], s), 324_000_000);
  const prior = structuredClone(doc); await noPixels(native, () => assert.rejects(edit(native, doc, 'update_layer_filter', { layerId: layer.id, filterId: id, parameters: { sigma: 1.6667 } }), { code: 'LIMIT_EXCEEDED' })); assert.deepEqual(await get(native, doc), prior);
  const bw = 8192, bh = 64, n = bw * bh, k = 301, ring = 16 * bw * bh + 4 * bh + 8 * k;
  const wide = { ...layer, width: bw, height: bh, transforms: [], filters: [filter({ sigma: 50 })] }, masked = base({ type: 'solid', width: bw, height: bh, transforms: [], color: '#ffffff', visible: false, mask: { shape: 'positioned', sourceWidth: 6000, sourceHeight: 4000, x: 0, y: 0, source: { shape: 'bitmap', width: 6000, height: 4000, x: 0, y: 0, runs: [], feather: 0, invert: false } } });
  const graph = { name: 'Unsharp retained source', width: bw, height: bh, selection: null, layers: [wide, masked] };
  assert.equal(validateLayerFilterResources(graph, layerTree(graph.layers)).estimatedScratchBytes, 8 * n + ring + n + 48_000_000);
  assert.deepEqual(await fs.readdir(native.assetsDir), []);
});

test('bake ring preflight accounts actual encoded sizes before decoding admitted large unsharp source', async t => {
  const { native, dataDir } = await fixture(t), w = 8192, h = 1000, s = w * h, entries = [filter({ sigma: .01 })], ring = 16 * w * 3 + 36;
  assert.ok(filterWork(entries[0], s) <= 384_000_000);
  const args = { width: w, height: h, hasAlpha: true, encodedWorkingBytes: 70_000_000, encodedAlphaBytes: 59_000_000 };
  const old = estimateFilterBakeBytes(args), actual = estimateFilterBakeBytes({ ...args, filters: entries });
  assert.equal(actual.filterBytes, old.filterBytes + ring); assert.ok(old.estimatedWorkingBytes <= old.maxWorkingBytes); assert.ok(actual.estimatedWorkingBytes > actual.maxWorkingBytes);
  const source = await raster(native, Buffer.from([31, 121, 231, 128]), 1, 1), alphaAsset = await native.storeAlpha(Buffer.from([173]), 1, 1);
  // Sparse test-owned files provide the exact encoded lengths; rejection must
  // happen before decoding or digest-checking this intentionally invalid data.
  await fs.truncate(path.join(native.assetsDir, source.asset), args.encodedWorkingBytes); await fs.truncate(path.join(native.assetsDir, alphaAsset), args.encodedAlphaBytes);
  await assert.rejects(bakeFilterSource({ layer: { ...source, width: w, height: h, alphaAsset }, filters: entries, assetsDir: native.assetsDir, tempRoot: dataDir }), { code: 'LIMIT_EXCEEDED' });
  assert.equal((await fs.readdir(dataDir)).some(name => name.startsWith('.filter-bake-')), false);
});

test('real publication failure and malformed portable source-only records preserve assets and history', async t => {
  const { native } = await fixture(t), w = 7, h = 5, source = await raster(native, image(w, h, (x, y) => [x % 2 ? 220 : 20, y * 47, 180, 255]), w, h, { filters: [filter({ amount: 37, sigma: .528474 })] });
  const doc = await project(native, w, h, [source]); await native.execute('get_preview', { documentId: doc.id, maxWidth: 32 });
  const assets = await files(native.assetsDir), projects = await files(native.projectsDir), cache = native.previewCache.stats();
  const oldStore = native.storeAsset.bind(native); let publications = 0; native.storeAsset = async (...args) => { const result = await oldStore(...args); publications++; return result; };
  const dir = native.projectsDir; native.projectsDir = path.join(native.assetsDir, source.asset);
  try { await assert.rejects(edit(native, doc, 'update_layer_filter', { layerId: source.id, filterId: source.filters[0].id, parameters: { amount: 200 } }), { code: 'ENOTDIR' }); await assert.rejects(edit(native, doc, 'bake_layer_filters', { layerId: source.id }), { code: 'ENOTDIR' }); } finally { native.projectsDir = dir; }
  await assert.rejects(edit(native, doc, 'apply_transaction', { operations: [{ command: 'bake_layer_filters', args: { layerId: source.id } }, { command: 'set_layer', args: { layerId: randomUUID(), visible: false } }] }), { code: 'NOT_FOUND' });
  assert.equal(publications, 2); assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await files(native.assetsDir), assets); assert.deepEqual(await files(native.projectsDir), projects); assert.deepEqual(native.previewCache.stats(), cache);
  const bytes = assets[source.asset];
  for (const layers of [[{ ...source, filters: [filter({ amount: 100.001 }, { enabled: false })] }], [{ ...source, filters: [filter({ sigma: 51 })] }], [{ ...source, filters: [filter({ threshold: .5 })] }], [{ ...source, filters: [filter({ radius: 1 })] }], [{ ...source, filters: [filter({}, { value: 1 })] }], [source, base({ type: 'adjustment', kind: 'unsharp_mask', value: 0, parameters: {} })]]) {
    const data = await encodeProjectBundle({ graph: { name: 'Malformed Unsharp', width: w, height: h, selection: null, layers }, validateGraph: () => {}, readAsset: async () => bytes });
    await noPixels(native, () => assert.rejects(native.importProject({ data }), { code: 'INVALID_PROJECT_BUNDLE' }), true);
  }
  assert.deepEqual(await files(native.assetsDir), assets); assert.deepEqual(await files(native.projectsDir), projects);
});

test('existing global blur/LAB sharpen pixels are unchanged and real fractional-tie source evaluation yields', async t => {
  const { native } = await fixture(t), w = 7, h = 5, input = image(w, h, (x, y, i) => [x * 37, y * 53, i * 41 % 256, [0, 1, 128, 255][i % 4]]);
  for (const kind of ['blur', 'sharpen']) {
    const pipeline = sharp(input, { raw: { width: w, height: h, channels: 4 } }), candidate = await (kind === 'blur' ? pipeline.blur(.3) : pipeline.sharpen({ sigma: .1 })).raw().toBuffer(), expected = Buffer.from(candidate);
    for (let i = 3; i < input.length; i += 4) expected[i] = input[i];
    assert.deepEqual(await native.applyAdjustment(input, w, h, { kind, value: .1, opacity: 1 }), expected);
  }
  const width = 8192, height = 16, stripes = image(width, height, x => [x % 2 ? 208 : 80, x % 2 ? 208 : 80, x % 2 ? 208 : 80, 255]), saved = Buffer.from(stripes); let ticked = false;
  const pending = applyLayerFilters(stripes, width, height, [filter({ amount: 5, sigma: .3977 })]); setImmediate(() => { ticked = true; }); const output = await pending;
  assert.equal(ticked, true); assert.deepEqual(stripes, saved);
  for (let y = 0; y < height; y++) for (let x = 1; x < width - 1; x++) assert.deepEqual([...output.subarray((y * width + x) * 4, (y * width + x + 1) * 4)], [x % 2 ? 209 : 80, x % 2 ? 209 : 80, x % 2 ? 209 : 80, 255]);
});
