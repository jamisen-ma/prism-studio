import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { applyLayerFilters, filterWork, validateLayerFilterResources } from '../server/layer-filters.mjs';
import { sourceSpatialPlan, compileSourceGaussian, sourceSpatialCandidate } from '../server/source-spatial-filters.mjs';
import { estimateFilterBakeBytes, bakeFilterSource } from '../server/filter-bake.mjs';
import { layerTree } from '../server/groups.mjs';
import { encodeProjectBundle } from '../server/project-bundle.mjs';

const base = extra => ({ id: randomUUID(), name: 'Independent spatial audit', visible: true, opacity: 1, blendMode: 'normal', ...extra });
const entry = (kind, value, extra = {}) => ({ id: randomUUID(), kind, value, enabled: true, opacity: 1, ...extra });
const pixels = (w, h, fn) => Buffer.from(Array.from({ length: w * h }, (_, i) => typeof fn === 'function' ? fn(i % w, Math.floor(i / w), i) : fn).flat());
const bitmap = (w, h, feather = 0) => ({ shape: 'bitmap', x: 0, y: 0, width: w, height: h, feather, invert: false, runs: [] });
const positioned = (w, h) => ({ shape: 'positioned', sourceWidth: w, sourceHeight: h, x: 0, y: 0, source: bitmap(w, h) });
const edit = (native, doc, command, args = {}) => native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...(command === 'apply_transaction' ? { label: 'Spatial audit transaction' } : {}), ...args });
const get = async (native, doc) => (await native.execute('get_document', { documentId: doc.id })).document;
const files = async dir => Object.fromEntries(await Promise.all((await fs.readdir(dir)).sort().map(async name => [name, await fs.readFile(path.join(dir, name))])));
const decode = bytes => sharp(bytes).toColourspace('srgb').ensureAlpha().raw().toBuffer();
const project = async (native, width, height, layers, extra = {}) => (await native.newProject({ name: 'Source spatial audit', width, height, selection: null, layers, ...extra }, 'Audit fixture')).document;
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-spatial-audit-'));
  const native = await new NativeBackend({ dataDir, segmentSubject: () => assert.fail('Spatial filters cannot call a model') }).init();
  t.after(async () => { await native.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { native, dataDir };
}
async function raster(native, input, width, height, extra = {}) {
  const asset = await native.storeAsset(await sharp(input, { raw: { width, height, channels: 4 } }).png().toBuffer());
  return base({ type: 'raster', asset, sourceAsset: asset, sourceFormat: 'png', width, height, transforms: [], ...extra });
}
function kernel(sigma) {
  const r = Math.ceil(3 * sigma), sides = Array.from({ length: r }, (_, i) => Math.exp(-((i + 1) ** 2) / (2 * sigma * sigma)));
  const denominator = 1 + 2 * sides.reduce((sum, value) => sum + value, 0), integers = sides.map(value => Math.round(65536 * value / denominator));
  return [...integers].reverse().concat(65536 - 2 * integers.reduce((sum, value) => sum + value, 0), integers);
}
function reference(input, w, h, sigma, sharpen = false, roundBlurFirst = false) {
  if (sigma === 0) return Buffer.from(input);
  const k = kernel(sigma), radius = (k.length - 1) / 2, out = Buffer.from(input);
  // Independently merge repeated clamped edge addresses, then evaluate a
  // two-dimensional BigInt sum. No production separable/cache helper is used.
  const axis = (p, n) => { const sums = Array(n).fill(0n); k.forEach((weight, i) => { sums[Math.max(0, Math.min(n - 1, p + i - radius))] += BigInt(weight); }); return sums; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const at = (y * w + x) * 4; if (!input[at + 3]) continue;
    const xs = axis(x, w), ys = axis(y, h), sums = [0n, 0n, 0n]; let d = 0n;
    for (let sy = 0; sy < h; sy++) for (let sx = 0; sx < w; sx++) {
      const p = (sy * w + sx) * 4, weight = xs[sx] * ys[sy] * BigInt(input[p + 3]); d += weight;
      for (let c = 0; c < 3; c++) sums[c] += weight * BigInt(input[p + c]);
    }
    assert.ok(d > 0n);
    for (let c = 0; c < 3; c++) {
      const blur = roundBlurFirst ? ((2n * sums[c] + d) / (2n * d)) * d : sums[c];
      const n = sharpen ? 2n * BigInt(input[at + c]) * d - blur : blur;
      const clamped = n < 0n ? 0n : n > 255n * d ? 255n * d : n;
      out[at + c] = Number((2n * clamped + d) / (2n * d));
    }
  }
  return out;
}
function stackReference(input, w, h, entries) {
  let result = Buffer.from(input);
  for (const f of entries) {
    if (!f.enabled || !f.opacity) continue;
    const candidate = f.kind === 'invert' ? Buffer.from(result.map((v, i) => i % 4 === 3 ? v : 255 - v)) : reference(result, w, h, f.value, f.kind === 'sharpen');
    for (let i = 0; i < result.length; i += 4) if (result[i + 3]) for (let c = 0; c < 3; c++) result[i + c] = Math.round(result[i + c] + (candidate[i + c] - result[i + c]) * f.opacity);
  }
  return result;
}
async function noPixels(native, operation, noFilesystem = false) {
  const restorers = [];
  for (const key of ['render', 'renderGraph', 'renderLayer', 'storeAsset', 'storeAlpha', 'readAlpha', 'readProjectAsset', 'validateProjectAsset', 'segmentSubject']) if (typeof native[key] === 'function') { const old = native[key]; native[key] = () => assert.fail(`Unexpected ${key}`); restorers.push(() => { native[key] = old; }); }
  if (noFilesystem) for (const key of ['readFile', 'open', 'writeFile', 'rename', 'link', 'stat']) { const old = fs[key]; fs[key] = () => assert.fail(`Unexpected fs.${key}`); restorers.push(() => { fs[key] = old; }); }
  try { return await operation(); } finally { restorers.reverse().forEach(fn => fn()); }
}

test('actual rolling candidates match independent BigInt edge, alpha and one-round unsharp oracles', async () => {
  let state = 7431; const next = () => state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  for (let trial = 0; trial < 72; trial++) {
    const w = 1 + next() % 9, h = 1 + next() % 7, sigma = [Number.MIN_VALUE, .001, .1, .333, .75, 1, 2.125, 10, 50][trial % 9];
    const input = pixels(w, h, (_, __, i) => [next() % 256, next() % 256, next() % 256, [0, 1, 128, 255][i % 4]]), saved = Buffer.from(input);
    const compiled = compileSourceGaussian(sigma), wanted = kernel(sigma);
    assert.deepEqual([...compiled.weights], wanted); assert.equal(wanted.reduce((a, b) => a + b, 0), 65536); assert.ok(wanted[(wanted.length - 1) / 2] >= 68);
    for (const kind of sigma <= 10 ? ['blur', 'sharpen'] : ['blur']) {
      const f = entry(kind, sigma), expected = reference(input, w, h, sigma, kind === 'sharpen'), actual = await sourceSpatialCandidate(input, w, h, f);
      assert.deepEqual(actual, expected); assert.deepEqual(input, saved); assert.notEqual(actual, input);
      assert.deepEqual(await applyLayerFilters(input, w, h, [f]), expected);
      const hidden = Buffer.from(input); for (let p = 0; p < w * h; p++) if (!hidden[p * 4 + 3]) for (let c = 0; c < 3; c++) hidden[p * 4 + c] ^= 255;
      const altered = await sourceSpatialCandidate(hidden, w, h, f);
      for (let p = 0; p < w * h; p++) assert.deepEqual(altered.subarray(p * 4, p * 4 + 4), (input[p * 4 + 3] ? actual : hidden).subarray(p * 4, p * 4 + 4));
    }
  }
  // Exact reachable half ties: side weight2560 at sigma .3977 gives80+2.5
  // at the left pixel. Signed unsharp rounds77.5 to78, not160-round82.5=77.
  const tie = Buffer.from([80, 80, 80, 255, 144, 144, 144, 255]);
  assert.deepEqual(kernel(.3977), [0, 2560, 60416, 2560, 0]);
  const oneRound = reference(tie, 2, 1, .3977, true);
  assert.deepEqual(oneRound, Buffer.from([78, 78, 78, 255, 147, 147, 147, 255]));
  assert.notDeepEqual(oneRound, reference(tie, 2, 1, .3977, true, true));
  assert.deepEqual(await sourceSpatialCandidate(tie, 2, 1, entry('sharpen', .3977)), oneRound);
  for (const kind of ['blur', 'sharpen']) for (const a of [1, 2, 128, 255]) {
    const input = pixels(7, 5, (_, __, i) => i % 4 ? [31, 121, 231, a] : [253, 2, 189, 0]);
    assert.deepEqual(await applyLayerFilters(input, 7, 5, [entry(kind, 3)]), input);
  }
});

test('source alpha, order and opacity are evaluated before geometry and ignore additional mask sampling', async t => {
  const { native } = await fixture(t), w = 9, h = 7;
  const input = pixels(w, h, (x, y, i) => [x * 27, y * 33, (i * 53) % 256, [0, 1, 128, 255][i % 4]]), alpha = Buffer.from(Array.from({ length: w * h }, (_, i) => [255, 128, 1, 0, 197][i % 5]));
  const entries = [entry('blur', .73, { opacity: .37 }), entry('invert', 100, { opacity: .2 }), entry('sharpen', 1.2, { opacity: .61 })];
  const layer = await raster(native, input, w, h, { alphaAsset: await native.storeAlpha(alpha, w, h), filters: entries, mask: { x: 2, y: 1, width: 3, height: 4, feather: .7, invert: true }, maskDensity: .4, opacity: .7 });
  const effective = Buffer.from(input); for (let i = 0; i < alpha.length; i++) effective[i * 4 + 3] = Number((2n * BigInt(input[i * 4 + 3]) * BigInt(alpha[i]) + 255n) / 510n);
  const expected = stackReference(effective, w, h, entries), assets = await files(native.assetsDir);
  assert.deepEqual(await native.renderLayer(layer), expected);
  assert.notDeepEqual(expected, stackReference(effective, w, h, [...entries].reverse()));
  const transformed = { ...layer, transforms: [{ type: 'resample', width: 13, height: 5, kernel: 'nearest' }] }, resized = Buffer.alloc(13 * 5 * 4);
  for (let y = 0; y < 5; y++) for (let x = 0; x < 13; x++) { const sx = Number((BigInt(2 * x + 1) * BigInt(w)) / 26n), sy = Number((BigInt(2 * y + 1) * BigInt(h)) / 10n); expected.copy(resized, (y * 13 + x) * 4, (sy * w + sx) * 4, (sy * w + sx + 1) * 4); }
  assert.deepEqual(await native.renderLayer(transformed), resized); assert.deepEqual(await files(native.assetsDir), assets);
});

test('spatial bake keeps separate alpha, positioned masks, isolated clipping and upper protection exactly', async t => {
  const { native } = await fixture(t), w = 11, h = 9;
  const input = pixels(w, h, (x, y, i) => [x * 21, y * 27, (i * 43) % 256, [0, 1, 128, 255][i % 4]]), alpha = Buffer.from(Array.from({ length: w * h }, (_, i) => [255, 1, 128, 197][i % 4]));
  const group = base({ type: 'group', mode: 'isolated', blendMode: 'screen', opacity: .65, mask: { x: 1, y: 0, width: 9, height: 8 }, maskDensity: .5 });
  const filters = [entry('blur', .8, { opacity: .7 }), entry('sharpen', 1.3, { opacity: .43 })];
  const content = await raster(native, input, w, h, { parentId: group.id, alphaAsset: await native.storeAlpha(alpha, w, h), filters, transforms: [{ type: 'affine', width: w, height: h, x: .3, y: -.2, scaleX: 1.1, scaleY: .8, rotation: 17, flipX: false, flipY: true }], mask: { shape: 'positioned', sourceWidth: w, sourceHeight: h, x: 1, y: -1, source: { shape: 'ellipse', x: 1, y: 1, width: 7, height: 6, feather: 1.2, invert: true } }, maskDensity: .37 });
  const member = await raster(native, pixels(w, h, (x, y) => [x * 19, y * 23, 183, 183]), w, h, { parentId: group.id, clipBaseId: content.id, filters: [entry('blur', 1.7)] });
  const protectedTop = await raster(native, pixels(w, h, (x, y) => [177, 123, 81, x > 7 && y > 5 ? 255 : 0]), w, h, { protected: true });
  let doc = await project(native, w, h, [base({ type: 'solid', color: '#384756', width: w, height: h, transforms: [] }), group, content, member, protectedTop]);
  const before = await native.renderGraph(doc), oldFiles = await files(native.assetsDir), old = structuredClone(doc.layers);
  const effective = Buffer.from(input); for (let i = 0; i < alpha.length; i++) effective[i * 4 + 3] = Math.round(input[i * 4 + 3] * alpha[i] / 255);
  const expectedWorking = stackReference(effective, w, h, filters); for (let i = 0; i < alpha.length; i++) expectedWorking[i * 4 + 3] = input[i * 4 + 3];
  for (const layerId of [content.id, member.id]) doc = (await edit(native, doc, 'bake_layer_filters', { layerId })).document;
  assert.deepEqual(await native.renderGraph(doc), before);
  const baked = doc.layers.find(l => l.id === content.id); assert.deepEqual(await decode(await fs.readFile(path.join(native.assetsDir, baked.asset))), expectedWorking);
  for (const layerId of [content.id, member.id]) { const prior = old.find(l => l.id === layerId), current = doc.layers.find(l => l.id === layerId); for (const key of Object.keys(prior).filter(k => !['asset', 'filters'].includes(k))) assert.deepEqual(current[key], prior[key]); }
  for (const [name, bytes] of Object.entries(oldFiles)) assert.deepEqual(await fs.readFile(path.join(native.assetsDir, name)), bytes);
});

test('lower protected original RGB and generated clipping remain safe in isolated rendering and inspection', async t => {
  const { native } = await fixture(t), w = 9, h = 7;
  const person = await raster(native, pixels(w, h, (x, y) => [183, 126, 79, x < 3 && y > 1 ? [1, 128, 255][x] : 0]), w, h, { protected: true });
  const group = base({ type: 'group', mode: 'isolated', opacity: .7 });
  const original = pixels(w, h, (x, y) => [x * 29, y * 35, 190 - x * 7, 255]);
  const content = await raster(native, original, w, h, { parentId: group.id, filters: [entry('blur', 1)] });
  const generated = await raster(native, pixels(w, h, (x, y) => [230 - x * 13, 20 + y * 19, 40, 200]), w, h, { parentId: group.id, clipBaseId: content.id, role: 'generated', provenance: { jobId: randomUUID(), mode: 'generate' }, filters: [entry('sharpen', 1)] });
  const doc = await project(native, w, h, [person, group, content, generated]), footprint = await native.protectedPixels(doc, { beforeLayerId: content.id });
  const filtered = await native.renderLayer(content, { protectedPixels: footprint }); let kept = 0, changed = 0;
  for (let i = 0; i < w * h; i++) if (footprint[i]) { assert.deepEqual(filtered.subarray(i * 4, i * 4 + 3), original.subarray(i * 4, i * 4 + 3)); kept++; } else if (!filtered.subarray(i * 4, i * 4 + 3).equals(original.subarray(i * 4, i * 4 + 3))) changed++;
  assert.ok(kept && changed);
  const actual = await native.renderGraph(doc), control = await native.renderGraph({ ...doc, layers: doc.layers.filter(l => l.id !== generated.id).map(l => l.id === content.id ? { ...l, filters: [] } : l) });
  for (let i = 0; i < w * h; i++) if (footprint[i]) assert.deepEqual(actual.subarray(i * 4, i * 4 + 4), control.subarray(i * 4, i * 4 + 4));
  const preview = await native.execute('get_layer_preview', { documentId: doc.id, layerId: generated.id, view: 'layer', maxWidth: 32 }), inspected = await decode(Buffer.from(preview.data, 'base64'));
  for (let i = 0; i < w * h; i++) if (footprint[i]) assert.equal(inspected[i * 4 + 3], 0);
  for (const value of [0, Number.MIN_VALUE]) {
    const identity = { ...content, filters: [entry('blur', value)] }, identityDoc = await project(native, w, h, [{ ...person, visible: false }, { ...identity, parentId: undefined }]);
    await noPixels(native, () => assert.rejects(edit(native, identityDoc, 'bake_layer_filters', { layerId: identity.id }), { code: 'FILTER_BAKE_PROTECTED_CONTEXT' }));
    await assert.rejects(edit(native, identityDoc, 'set_layer_protection', { layerId: identity.id, protected: true }), { code: 'PROTECTED_LAYER' });
  }
});

test('phase maxima and retained mask/group/chain buffers include exactly one live Gaussian ring', async t => {
  const { native } = await fixture(t), w = 8192, h = 64, s = w * h, k = 301, rows = 64, ring = 16 * w * rows + 8 * k + 4 * rows;
  const f = entry('blur', 50), plan = sourceSpatialPlan(f, w, h);
  assert.equal(plan.cacheBytes, ring); assert.equal(plan.work, s * (2 * k + 8)); assert.equal(filterWork(f, s), plan.work);
  for (const [extra, work, bytes] of [[{ value: 0 }, s, 0], [{ value: Number.MIN_VALUE }, s * 14, 16 * w * 3 + 36], [{ enabled: false }, 0, 0], [{ opacity: 0 }, 0, 0]]) { const item = { ...f, ...extra }, estimate = sourceSpatialPlan(item, w, h); assert.equal(estimate.work, work); assert.equal(estimate.cacheBytes, bytes); assert.equal(filterWork(item, s), work); }
  const one = base({ type: 'raster', width: w, height: h, asset: 'a'.repeat(64), sourceAsset: 'a'.repeat(64), transforms: [], filters: [f] });
  let graph = { name: 'Phase budget', width: w, height: h, selection: null, layers: [one] };
  assert.equal(validateLayerFilterResources(graph, layerTree(graph.layers)).retainedScratchBytes, 8 * s + ring + s);
  graph = { ...graph, width: 1, height: 1, layers: [{ ...one, transforms: [{ type: 'resample', width: 6000, height: 4000, kernel: 'nearest' }, { type: 'crop', x: 0, y: 0, width: 1, height: 1 }] }] };
  assert.equal(validateLayerFilterResources(graph, layerTree(graph.layers)).retainedScratchBytes, 8 * 24_000_000 + 1, 'largest geometry and ring are separate phases');
  // Two sequential smaller kernels share one ring but work remains cumulative.
  const entries = [entry('blur', 10), entry('sharpen', 9)];
  graph = { ...graph, width: w, height: h, layers: [{ ...one, filters: entries }] };
  assert.equal(validateLayerFilterResources(graph, layerTree(graph.layers)).retainedScratchBytes, 8 * s + (16 * w * 61 + 12 * 61) + s);
  const outer = base({ type: 'group', mode: 'isolated', opacity: .5 }), inner = base({ type: 'group', mode: 'isolated', parentId: outer.id, opacity: .5 });
  const content = { ...one, parentId: inner.id }, member = base({ type: 'solid', width: w, height: h, transforms: [], color: '#ffffff', parentId: inner.id, clipBaseId: content.id });
  const masks = Array.from({ length: 6 }, (_, i) => base({ type: 'solid', width: w, height: h, transforms: [], color: '#ffffff', visible: false, mask: positioned(i < 5 ? 6000 : 1500, i < 5 ? 4000 : 2000) }));
  graph = { name: 'Combined ring admission', width: w, height: h, selection: null, layers: [outer, inner, content, member, ...masks] };
  native.validateGraph(graph);
  const estimate = validateLayerFilterResources(graph, layerTree(graph.layers));
  assert.equal(estimate.estimatedCallbackBytes, 246_000_000); assert.equal(estimate.estimatedScratchBytes, 246_000_000 + 15 * s + 8 * s + ring + s);
  graph.layers.at(-1).mask = positioned(2000, 2000);
  assert.throws(() => native.validateGraph(graph), { code: 'LIMIT_EXCEEDED' });
});

test('bake counts its live ring with retained source/alpha before reading an otherwise undecodable large source', async t => {
  const { native, dataDir } = await fixture(t), w = 8192, h = 1925, s = w * h, filters = [entry('blur', .01)], ring = 16 * w * 3 + 36;
  const without = estimateFilterBakeBytes({ width: w, height: h, hasAlpha: true }), withRing = estimateFilterBakeBytes({ width: w, height: h, hasAlpha: true, filters });
  assert.equal(withRing.spatialCacheBytes, ring); assert.equal(withRing.filterBytes, 17 * s + ring + 65536);
  assert.ok(without.estimatedWorkingBytes <= without.maxWorkingBytes); assert.ok(withRing.estimatedWorkingBytes > withRing.maxWorkingBytes);
  const tiny = await raster(native, Buffer.from([20, 80, 170, 255]), 1, 1), layer = { ...tiny, width: w, height: h, alphaAsset: tiny.asset, filters };
  await assert.rejects(bakeFilterSource({ layer, filters, assetsDir: native.assetsDir, tempRoot: dataDir }), { code: 'LIMIT_EXCEEDED' });
  assert.equal((await fs.readdir(dataDir)).some(name => name.startsWith('.filter-bake-')), false);
});

test('recipes stage spatial work without pixel I/O and fail atomically when later radius exceeds cumulative limits', async t => {
  const { native } = await fixture(t), w = 2200, h = 2200, source = base({ type: 'raster', width: w, height: h, transforms: [], asset: 'a'.repeat(64), sourceAsset: 'a'.repeat(64), sourceFormat: 'png', visible: false });
  let doc = await project(native, w, h, [source]);
  const definition = { name: 'Spatial recipe', slots: [{ key: 'photo', type: 'raster' }], steps: [{ command: 'add_layer_filter', target: 'photo', args: { kind: 'blur', value: 1 } }, { command: 'add_layer_filter', target: 'photo', args: { kind: 'sharpen', value: 10 } }] };
  const saved = await edit(native, doc, 'save_edit_recipe', definition); doc = saved.document;
  const args = { recipeId: saved.recipeId, bindings: { photo: source.id } };
  const report = await noPixels(native, () => edit(native, doc, 'validate_edit_recipe', args), true);
  assert.equal(report.valid, false); assert.equal(report.issues[0].stepIndex, 1); assert.equal(report.issues[0].code, 'LIMIT_EXCEEDED');
  await noPixels(native, () => assert.rejects(edit(native, doc, 'apply_edit_recipe', args), { code: 'LIMIT_EXCEEDED' }));
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await fs.readdir(native.assetsDir), []);
  const accepted = await edit(native, doc, 'save_edit_recipe', { ...definition, steps: [definition.steps[0]] }); doc = accepted.document;
  const validArgs = { recipeId: accepted.recipeId, bindings: args.bindings };
  assert.equal((await noPixels(native, () => edit(native, doc, 'validate_edit_recipe', validArgs), true)).valid, true);
  doc = (await noPixels(native, () => edit(native, doc, 'apply_edit_recipe', validArgs))).document; assert.equal(doc.layers[0].filters[0].kind, 'blur');
  const unchanged = structuredClone(doc);
  await noPixels(native, () => assert.rejects(edit(native, doc, 'update_layer_filter', { layerId: source.id, filterId: doc.layers[0].filters[0].id, value: 50 }), { code: 'LIMIT_EXCEEDED' }));
  assert.deepEqual(await get(native, doc), unchanged);
});

test('real publication and late transaction failures roll back spatial filter edits and baked asset ownership', async t => {
  const { native } = await fixture(t), w = 13, h = 9, source = await raster(native, pixels(w, h, (x, y) => [x * 17, y * 27, (x * y * 29) % 256, 255]), w, h, { filters: [entry('blur', 1.1), entry('sharpen', .7)] });
  const doc = await project(native, w, h, [source]); await native.execute('get_preview', { documentId: doc.id, maxWidth: 32 });
  const assets = await files(native.assetsDir), projects = await files(native.projectsDir), cache = native.previewCache.stats(), originalStore = native.storeAsset.bind(native); let publications = 0;
  native.storeAsset = async (...args) => { const result = await originalStore(...args); publications++; return result; };
  const directory = native.projectsDir; native.projectsDir = path.join(native.assetsDir, source.asset);
  try {
    await assert.rejects(edit(native, doc, 'update_layer_filter', { layerId: source.id, filterId: source.filters[0].id, value: .9 }), { code: 'ENOTDIR' });
    await assert.rejects(edit(native, doc, 'bake_layer_filters', { layerId: source.id }), { code: 'ENOTDIR' });
  } finally { native.projectsDir = directory; }
  await assert.rejects(edit(native, doc, 'apply_transaction', { operations: [{ command: 'bake_layer_filters', args: { layerId: source.id } }, { command: 'set_layer', args: { layerId: randomUUID(), visible: false } }] }), { code: 'NOT_FOUND' });
  assert.equal(publications, 2, 'both bake failures occur after actual fresh asset publication');
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await files(native.assetsDir), assets); assert.deepEqual(await files(native.projectsDir), projects); assert.deepEqual(native.previewCache.stats(), cache);
});

test('malformed and over-budget portable spatial stacks reject before asset access, even when hidden or disabled', async t => {
  const { native } = await fixture(t), source = await raster(native, pixels(2, 2, [31, 121, 231, 128]), 2, 2), bytes = await fs.readFile(path.join(native.assetsDir, source.asset));
  const invalid = [
    { ...source, filters: [entry('blur', 50.001)] },
    { ...source, filters: [entry('sharpen', 10.001, { enabled: false })] },
    { ...source, filters: [entry('blur', 1, { parameters: { amount: 2 } })] },
    { ...source, width: 2000, height: 2000, visible: false, transforms: [{ type: 'crop', x: 0, y: 0, width: 2, height: 2 }], filters: [entry('blur', 50)] },
  ];
  const before = { projects: await files(native.projectsDir), assets: await files(native.assetsDir) };
  for (const layer of invalid) {
    const graph = { name: 'Invalid portable spatial stack', width: 2, height: 2, selection: null, layers: [layer] };
    const data = await encodeProjectBundle({ graph, validateGraph: () => {}, readAsset: async () => bytes });
    await noPixels(native, () => assert.rejects(native.importProject({ data }), error => ['INVALID_PROJECT_BUNDLE', 'LIMIT_EXCEEDED'].includes(error.code)), true);
    assert.deepEqual(await files(native.projectsDir), before.projects); assert.deepEqual(await files(native.assetsDir), before.assets);
  }
});

test('legacy global Sharp blur and LAB sharpen remain pixel-identical while wide source loops yield', async t => {
  const { native } = await fixture(t), w = 9, h = 7, input = pixels(w, h, (x, y, i) => [x * 23, y * 31, i * 41 % 256, [0, 1, 128, 255][i % 4]]);
  for (const kind of ['blur', 'sharpen']) for (const value of [0, .1, 1]) {
    const pipeline = sharp(input, { raw: { width: w, height: h, channels: 4 } });
    const candidate = value ? await (kind === 'blur' ? pipeline.blur(Math.max(.3, value)) : pipeline.sharpen({ sigma: Math.max(.001, value) })).raw().toBuffer() : input;
    const expected = Buffer.from(input); for (let i = 0; i < input.length; i += 4) for (let c = 0; c < 3; c++) expected[i + c] = candidate[i + c];
    assert.deepEqual(await native.applyAdjustment(input, w, h, { kind, value, opacity: 1 }), expected);
  }
  const wide = pixels(8192, 5, (x, y, i) => [x % 256, y * 40, i * 31 % 256, [0, 1, 128, 255][i % 4]]), copy = Buffer.from(wide); let ticked = false;
  const pending = sourceSpatialCandidate(wide, 8192, 5, entry('blur', 10)); setImmediate(() => { ticked = true; });
  const output = await pending; assert.equal(ticked, true); assert.deepEqual(wide, copy);
  for (let i = 3; i < output.length; i += 4) assert.equal(output[i], wide[i]);
});
