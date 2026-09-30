import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { normalizeLocalToneParameters, localTonePlan, localToneCandidate, localToneChannelByte } from '../server/local-tone.mjs';
import { normalizeLayerFilter, applyLayerFilters, filterWork, layerFilterSpatialCacheBytes, validateLayerFilterResources } from '../server/layer-filters.mjs';
import { estimateFilterBakeBytes, bakeFilterSource } from '../server/filter-bake.mjs';
import { estimateFilterMaskSourceBytes } from '../server/filter-mask.mjs';
import { layerTree } from '../server/groups.mjs';
import { encodeProjectBundle } from '../server/project-bundle.mjs';

const defaults = { shadows: 25, highlights: 0, shadowWidth: 50, highlightWidth: 50, sigma: 3 };
const base = extra => ({ id: randomUUID(), name: 'Independent local-tone audit', visible: true, opacity: 1, blendMode: 'normal', ...extra });
const filter = (parameters = {}, extra = {}) => ({ id: randomUUID(), kind: 'shadows_highlights', value: 0, parameters, enabled: true, opacity: 1, ...extra });
const image = (w, h, fn) => Buffer.from(Array.from({ length: w * h }, (_, i) => typeof fn === 'function' ? fn(i % w, Math.floor(i / w), i) : fn).flat());
const bitmap = (bytes, w, h, extra = {}) => { const runs = []; for (let i = 0; i < bytes.length;) { const v = bytes[i]; let end = i + 1; while (end < bytes.length && bytes[end] === v) end++; if (v) runs.push(i, end - i, v); i = end; } return { shape: 'bitmap', x: 0, y: 0, width: w, height: h, runs, feather: 0, invert: false, ...extra }; };
const mask = (w, h, coverage = { shape: 'rectangle', x: 0, y: 0, width: w, height: h, feather: 0, invert: false }, extra = {}) => ({ sourceWidth: w, sourceHeight: h, coverage, density: 1, enabled: true, ...extra });
const wrap = (entries, scope) => ({ version: 1, entries, mask: scope });
const edit = (native, doc, command, args = {}) => native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...(command === 'apply_transaction' ? { label: 'Local-tone audit' } : {}), ...args });
const get = async (native, doc) => (await native.execute('get_document', { documentId: doc.id })).document;
const graph = (native, doc) => { const p = native.projects.get(doc.id); return structuredClone(p.states[p.cursor].graph); };
const files = async dir => Object.fromEntries(await Promise.all((await fs.readdir(dir)).sort().map(async name => [name, await fs.readFile(path.join(dir, name))])));
const decode = data => sharp(data).toColourspace('srgb').ensureAlpha().raw().toBuffer();
const project = async (native, width, height, layers, extra = {}) => (await native.newProject({ name: 'Local-tone audit', width, height, selection: null, layers, ...extra }, 'Fixture')).document;
async function fixture(t) { const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-local-tone-audit-')); const native = await new NativeBackend({ dataDir, segmentSubject: () => assert.fail('No model for local tone') }).init(); t.after(async () => { await native.close(); await fs.rm(dataDir, { recursive: true, force: true }); }); return { native, dataDir }; }
async function raster(native, pixels, width, height, extra = {}) { const asset = await native.storeAsset(await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer()); return base({ type: 'raster', width, height, asset, sourceAsset: asset, sourceFormat: 'png', transforms: [], ...extra }); }
async function noPixels(native, run, noFilesystem = false) { const restore = []; for (const key of ['render', 'renderGraph', 'renderLayer', 'readAlpha', 'storeAlpha', 'storeAsset', 'readProjectAsset', 'validateProjectAsset', 'segmentSubject']) if (typeof native[key] === 'function') { const old = native[key]; native[key] = () => assert.fail(`Unexpected ${key}`); restore.push(() => { native[key] = old; }); } if (noFilesystem) for (const key of ['readFile', 'writeFile', 'open', 'rename', 'link', 'stat']) { const old = fs[key]; fs[key] = () => assert.fail(`Unexpected fs.${key}`); restore.push(() => { fs[key] = old; }); } try { return await run(); } finally { restore.reverse().forEach(fn => fn()); } }

// The oracle compiles the documented kernel independently, collapses edge
// duplicates, and accumulates direct 2D BigInt sums rather than a row ring.
const half = (n, d) => Number(n / d + (2n * (n % d) >= d ? 1n : 0n));
const luminance = rgb => half(2126n * BigInt(rgb[0]) + 7152n * BigInt(rgb[1]) + 722n * BigInt(rgb[2]), 10000n);
function weights(sigma) { const r = Math.ceil(3 * sigma); if (!sigma) return [65536]; let sum = 0; for (let d = 1; d <= r; d++) sum += Math.exp(-d * d / (2 * sigma * sigma)); const side = Array.from({ length: r }, (_, i) => Math.round(65536 * Math.exp(-((i + 1) ** 2) / (2 * sigma * sigma)) / (1 + 2 * sum))); return [...side].reverse().concat(65536 - 2 * side.reduce((a, b) => a + b, 0), side); }
function weight(amount, width, L) { const A = BigInt(Math.round(amount * 100)), T = 255n * BigInt(Math.round(width * 100)), distance = T - 10000n * BigInt(L); return distance <= 0n ? 0 : half(65536n * A * distance ** 2n, 10000n * T ** 2n); }
function channel(C, s, h) { const c = BigInt(C), a = 65536n + 3n * BigInt(s), b = 65536n + 3n * BigInt(h); return half(255n * a * c, b * (255n - c) + a * c); }
function reference(input, w, h, authored = {}, wrongRgbFirst = false) {
  const p = { ...defaults, ...authored }, out = Buffer.from(input), kernel = weights(p.sigma), r = (kernel.length - 1) / 2;
  const axis = (x, size) => { const result = Array(size).fill(0n); kernel.forEach((v, i) => { result[Math.max(0, Math.min(size - 1, x + i - r))] += BigInt(v); }); return result; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const at = 4 * (y * w + x); if (!input[at + 3]) continue;
    const xs = axis(x, w), ys = axis(y, h), rgb = [0n, 0n, 0n]; let N = 0n, D = 0n;
    for (let sy = 0; sy < h; sy++) for (let sx = 0; sx < w; sx++) { const i = 4 * (sy * w + sx), k = xs[sx] * ys[sy] * BigInt(input[i + 3]); N += BigInt(luminance(input.subarray(i, i + 3))) * k; D += k; if (wrongRgbFirst) for (let c = 0; c < 3; c++) rgb[c] += BigInt(input[i + c]) * k; }
    const L = wrongRgbFirst ? luminance(rgb.map(n => half(n, D))) : half(N, D), s = weight(p.shadows, p.shadowWidth, L), hi = weight(p.highlights, p.highlightWidth, 255 - L);
    for (let c = 0; c < 3; c++) out[at + c] = channel(input[at + c], s, hi);
  }
  return out;
}
function stack(input, w, h, entries) { let out = Buffer.from(input); for (const f of entries) { if (!f.enabled || !f.opacity) continue; const candidate = f.kind === 'invert' ? Buffer.from(out.map((v, i) => i % 4 === 3 ? v : 255 - v)) : reference(out, w, h, f.parameters); for (let i = 0; i < out.length; i += 4) if (out[i + 3]) for (let c = 0; c < 3; c++) { const b = out[i + c], front = candidate[i + c]; assert.ok(!f.blendMode || f.blendMode === 'multiply'); out[i + c] = f.blendMode === 'multiply' && f.opacity === 1 ? half(BigInt(b * front), 255n) : Math.round(b + (front - b) * f.opacity); } } return out; }
function masked(original, filtered, raw, scope) { const out = Buffer.from(filtered); for (let p = 0; p < raw.length; p++) { const e = !scope.enabled || scope.density === 0 ? 255 : scope.density === 1 ? raw[p] : Math.round(255 - scope.density * (255 - raw[p])); for (let c = 0; c < 3; c++) out[4 * p + c] = original[4 * p + 3] ? half(BigInt(original[4 * p + c] * (255 - e) + filtered[4 * p + c] * e), 255n) : original[4 * p + c]; out[4 * p + 3] = original[4 * p + 3]; } return out; }

test('local tone uses quantized input luminance then the exact alpha-weighted local byte, with distinct neighborhood behavior', async () => {
  let state = 0x973163; const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; }; let stageDiscriminators = 0;
  for (let n = 0; n < 36; n++) {
    const w = 1 + random() % 8, h = 1 + random() % 11, sigma = [0, Number.MIN_VALUE, .3977, .528474, 1, 3, 50][n % 7];
    const p = { shadows: [25, 100, 42.37][n % 3], highlights: [0, 100, 19.99][n % 3], shadowWidth: 73.21, highlightWidth: 87.65, sigma }, input = image(w, h, (_, __, i) => [random() & 255, random() & 255, random() & 255, [0, 1, 128, 255][i % 4]]), copy = Buffer.from(input), expected = reference(input, w, h, p);
    assert.deepEqual(await localToneCandidate(input, w, h, filter(p)), expected); assert.deepEqual(await applyLayerFilters(input, w, h, [filter(p)]), expected); assert.deepEqual(input, copy);
    if (!expected.equals(reference(input, w, h, p, true))) stageDiscriminators++;
    const hidden = Buffer.from(input); for (let i = 0; i < hidden.length; i += 4) if (!hidden[i + 3]) for (let c = 0; c < 3; c++) hidden[i + c] ^= 255;
    const altered = await localToneCandidate(hidden, w, h, filter(p)); for (let i = 0; i < input.length; i += 4) assert.deepEqual(altered.subarray(i, i + 4), (input[i + 3] ? expected : hidden).subarray(i, i + 4));
  }
  assert.ok(stageDiscriminators > 0, 'The fixture must distinguish luminance-before-Gaussian from rounded RGB blur first');
  for (const [C, s, h, byte] of [[5, 34488, 12, 13], [250, 12, 34488, 243]]) assert.equal(localToneChannelByte(C, s, h), byte);
  const surround = color => { const b = image(9, 1, [color, color, color, 255]); b.set([64, 64, 64, 255], 16); return b; };
  assert.equal((await applyLayerFilters(surround(0), 9, 1, [filter({ sigma: 1 })]))[16], 84); assert.equal((await applyLayerFilters(surround(255), 9, 1, [filter({ sigma: 1 })]))[16], 64);
  for (const color of [0, 255]) assert.equal((await applyLayerFilters(surround(color), 9, 1, [filter({ sigma: 0 })]))[16], 73);
  const identity = filter({ shadows: 0, highlights: 0, sigma: 50 }), input = image(3, 1, [128, 128, 128, 255]); assert.equal(await localToneCandidate(input, 3, 1, identity), input); assert.equal(localTonePlan(identity, 3, 1).cacheBytes, 0); assert.equal(filterWork(identity, 3), 3);
  assert.deepEqual(await applyLayerFilters(input, 3, 1, [{ ...identity, blendMode: 'multiply' }]), image(3, 1, [64, 64, 64, 255])); assert.equal(filterWork({ ...identity, blendMode: 'multiply' }, 3), 123);
});

test('sparse defaults, explicit zero partial updates and masked recipe application remain metadata-only', async t => {
  const { native } = await fixture(t), w = 1500, h = 1000, scope = mask(w, h), sparse = filter({ sigma: 0 }), source = base({ type: 'raster', width: w, height: h, asset: 'a'.repeat(64), sourceAsset: 'a'.repeat(64), transforms: [], visible: false, filters: wrap([sparse], scope) });
  let doc = await project(native, w, h, [source]); assert.deepEqual(graph(native, doc).layers[0].filters.entries[0].parameters, { sigma: 0 }); assert.deepEqual(normalizeLocalToneParameters({ sigma: 0 }), { ...defaults, sigma: 0 });
  doc = (await noPixels(native, () => edit(native, doc, 'update_layer_filter', { layerId: source.id, filterId: sparse.id, parameters: { shadows: 0, highlights: 0 } }))).document;
  assert.deepEqual(doc.layers[0].filters[0].parameters, { ...defaults, sigma: 0, shadows: 0, highlights: 0 }); assert.deepEqual(graph(native, doc).layers[0].filters.mask, scope);
  const definition = { name: 'Local tone with inherited source mask', slots: [{ key: 'photo', type: 'raster' }], steps: Array.from({ length: 3 }, () => ({ command: 'add_layer_filter', target: 'photo', args: { kind: 'shadows_highlights', value: 0 } })) };
  const saved = await noPixels(native, () => edit(native, doc, 'save_edit_recipe', definition)); doc = saved.document;
  const args = { recipeId: saved.recipeId, bindings: { photo: source.id } }, report = await noPixels(native, () => edit(native, doc, 'validate_edit_recipe', args), true); assert.equal(report.valid, true);
  doc = (await noPixels(native, () => edit(native, doc, 'apply_edit_recipe', args))).document; assert.equal(doc.layers[0].filters.length, 4); assert.deepEqual(graph(native, doc).layers[0].filters.mask, scope); assert.deepEqual(doc.layers[0].filters[3].parameters, defaults);
  const over = await noPixels(native, () => edit(native, doc, 'save_edit_recipe', { ...definition, steps: [definition.steps[0], definition.steps[0]] })); doc = over.document;
  const overArgs = { ...args, recipeId: over.recipeId }, rejected = await noPixels(native, () => edit(native, doc, 'validate_edit_recipe', overArgs), true); assert.equal(rejected.valid, false); assert.equal(rejected.issues[0].stepIndex, 1); assert.equal(rejected.issues[0].code, 'LIMIT_EXCEEDED');
  await noPixels(native, () => assert.rejects(edit(native, doc, 'apply_edit_recipe', overArgs), { code: 'LIMIT_EXCEEDED' })); assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await fs.readdir(native.assetsDir), []);
});

test('source alpha, preceding filters and whole-stack mask are staged exactly before geometry and Bake', async t => {
  const { native } = await fixture(t), w = 9, h = 7, input = image(w, h, (x, y, i) => [x * 29, y * 37, i * 53 % 256, [0, 1, 128, 255][i % 4]]), alpha = Buffer.from(Array.from({ length: w * h }, (_, i) => [255, 1, 128, 197, 0][i % 5])), raw = Uint8Array.from({ length: w * h }, (_, i) => i * 79 % 256), scope = mask(w, h, bitmap(raw, w, h, { invert: true }), { density: .1 });
  const entries = [{ id: randomUUID(), kind: 'invert', value: 100, enabled: true, opacity: .25 }, filter({ shadows: 87.65, highlights: 23.45, shadowWidth: 81.25, highlightWidth: 72.31, sigma: .528474 }, { opacity: .625 }), filter({ shadows: 0, highlights: 0 }, { blendMode: 'multiply' })];
  const effective = Buffer.from(input); for (let p = 0; p < alpha.length; p++) effective[4 * p + 3] = half(BigInt(input[4 * p + 3] * alpha[p]), 255n);
  const expected = masked(effective, stack(effective, w, h, entries), raw.map(v => 255 - v), scope);
  assert.notDeepEqual(expected, masked(effective, stack(effective, w, h, [...entries].reverse()), raw.map(v => 255 - v), scope));
  const group = base({ type: 'group', mode: 'isolated', blendMode: 'screen', opacity: .7 }), source = await raster(native, input, w, h, { parentId: group.id, alphaAsset: await native.storeAlpha(alpha, w, h), filters: wrap(entries, scope), transforms: [{ type: 'affine', width: w, height: h, x: .4, y: -.3, scaleX: 1.1, scaleY: .9, rotation: 17, flipX: false, flipY: false }], mask: { shape: 'positioned', sourceWidth: w, sourceHeight: h, x: 1, y: -1, source: { shape: 'ellipse', x: 1, y: 1, width: 5, height: 4, feather: 1.2, invert: true } }, maskDensity: .5 });
  assert.deepEqual(await native.renderLayer({ ...source, transforms: [] }), expected); assert.deepEqual(await native.renderLayer({ ...source, transforms: [] }, { filters: false }), effective);
  const member = base({ type: 'solid', width: w, height: h, color: '#7d4ac1', transforms: [], parentId: group.id, clipBaseId: source.id, opacity: .43 }), top = await raster(native, image(w, h, (x, y) => [177, 123, 81, x > 6 && y > 4 ? 255 : 0]), w, h, { protected: true });
  let doc = await project(native, w, h, [base({ type: 'solid', width: w, height: h, transforms: [], color: '#aabbcc' }), group, source, member, top], { selection: { shape: 'rectangle', x: 2, y: 2, width: 2, height: 2 } });
  const before = await native.renderGraph(graph(native, doc)), assets = await files(native.assetsDir); doc = (await edit(native, doc, 'bake_layer_filters', { layerId: source.id })).document;
  const baked = graph(native, doc).layers.find(l => l.id === source.id); for (let p = 0; p < alpha.length; p++) expected[4 * p + 3] = input[4 * p + 3]; assert.deepEqual(await decode(await fs.readFile(path.join(native.assetsDir, baked.asset))), expected); assert.deepEqual(await native.renderGraph(graph(native, doc)), before);
  for (const key of Object.keys(source).filter(k => !['asset', 'filters'].includes(k))) assert.deepEqual(baked[key], source[key]); assert.deepEqual(baked.filters, []); assert.equal(doc.layers.find(l => l.id === source.id).filterMask, undefined); for (const [name, bytes] of Object.entries(assets)) assert.deepEqual(await fs.readFile(path.join(native.assetsDir, name)), bytes);
});

test('protected original context and generated clipping exclusions survive both computing and dual-zero candidates', async t => {
  const { native } = await fixture(t), w = 9, h = 7, original = image(w, h, (x, y) => [x % 2 ? 80 : 20, y * 25, 90, 255]);
  const person = await raster(native, image(w, h, (x, y) => [188, 127, 81, x < 3 && y > 1 ? [1, 128, 255][x] : 0]), w, h, { protected: true }), group = base({ type: 'group', mode: 'isolated', opacity: .6 });
  const scope = mask(w, h, bitmap(Uint8Array.from({ length: w * h }, (_, i) => i * 53 % 256), w, h), { density: .5 });
  const source = await raster(native, original, w, h, { parentId: group.id }), generated = await raster(native, image(w, h, [33, 88, 199, 173]), w, h, { parentId: group.id, clipBaseId: source.id, role: 'generated', provenance: { jobId: randomUUID(), mode: 'generate' }, filters: [filter({ sigma: 1 })] });
  for (const entry of [filter({ sigma: 1 }), filter({ shadows: 0, highlights: 0 }, { blendMode: 'multiply' })]) {
    const current = { ...source, filters: wrap([entry], scope) }, doc = await project(native, w, h, [person, group, current, generated]), g = graph(native, doc), footprint = await native.protectedPixels(g, { beforeLayerId: source.id }), altered = await native.renderLayer(current, { protectedPixels: footprint });
    let restored = 0, changed = 0; for (let i = 0; i < w * h; i++) if (footprint[i]) { assert.deepEqual(altered.subarray(4 * i, 4 * i + 3), original.subarray(4 * i, 4 * i + 3)); restored++; } else if (!altered.subarray(4 * i, 4 * i + 3).equals(original.subarray(4 * i, 4 * i + 3))) changed++; assert.ok(restored && changed);
    const actual = await native.renderGraph(g), control = await native.renderGraph({ ...g, layers: g.layers.filter(l => l.id !== generated.id).map(l => l.id === source.id ? { ...l, filters: [] } : l) }); for (let i = 0; i < w * h; i++) if (footprint[i]) assert.deepEqual(actual.subarray(4 * i, 4 * i + 4), control.subarray(4 * i, 4 * i + 4));
    const preview = await native.execute('get_layer_preview', { documentId: doc.id, layerId: generated.id, view: 'layer', maxWidth: 32 }), rgba = await decode(Buffer.from(preview.data, 'base64')); for (let i = 0; i < w * h; i++) if (footprint[i]) assert.equal(rgba[4 * i + 3], 0);
  }
  const identity = filter({ shadows: 0, highlights: 0 }), hidden = await project(native, w, h, [{ ...person, visible: false }, { ...source, parentId: undefined, filters: wrap([identity], { ...scope, enabled: false }) }]);
  await noPixels(native, () => assert.rejects(edit(native, hidden, 'bake_layer_filters', { layerId: source.id }), { code: 'FILTER_BAKE_PROTECTED_CONTEXT' }));
  await noPixels(native, () => assert.rejects(edit(native, hidden, 'set_layer_protection', { layerId: source.id, protected: true }), { code: 'PROTECTED_LAYER' }));
  await noPixels(native, () => assert.rejects(edit(native, hidden, 'add_layer_filter', { layerId: person.id, kind: 'shadows_highlights', value: 0, parameters: { shadows: 0, highlights: 0 } }), { code: 'PROTECTED_LAYER' }));
});

test('tiny-positive activation accounts for the prepared row and LUT with groups, clipping, retained masks and other-leaf noise before reads', async t => {
  const { native } = await fixture(t), w = 8192, h = 64, S = w * h, hash = 'a'.repeat(64), outer = base({ type: 'group', mode: 'isolated', opacity: .5 }), inner = base({ type: 'group', mode: 'isolated', parentId: outer.id, opacity: .5 });
  const entry = filter({ sigma: 0 }), content = base({ type: 'raster', width: w, height: h, asset: hash, sourceAsset: hash, transforms: [], parentId: inner.id, filters: [entry] }), member = base({ type: 'solid', width: w, height: h, color: '#ffffff', transforms: [], parentId: inner.id, clipBaseId: content.id });
  const retained = (width, height) => base({ type: 'solid', width: w, height: h, color: '#ffffff', transforms: [], visible: false, mask: { shape: 'positioned', sourceWidth: width, sourceHeight: height, x: 0, y: 0, source: bitmap([], width, height) } });
  const noise = base({ type: 'raster', width: 1, height: 1, asset: hash, sourceAsset: hash, transforms: [{ type: 'resize', width: w, height: h }], filters: [{ id: randomUUID(), kind: 'add_noise', value: 0, enabled: true, opacity: 1, parameters: { distribution: 'gaussian' } }] });
  const g = { width: w, height: h, selection: null, layers: [noise, outer, inner, content, member, ...Array.from({ length: 5 }, () => retained(6000, 4000)), retained(3925, 2000)] };
  const estimate = validateLayerFilterResources(g, layerTree(g.layers)); assert.equal(estimate.estimatedScratchBytes, 24 * S + 2048 + 2 * 127850000 + 4096); assert.equal(estimate.estimatedScratchBytes, 268289056);
  const positive = { ...entry, parameters: { sigma: .01 } }; assert.equal(localTonePlan(positive, w, h).cacheBytes, 223268); assert.equal(layerFilterSpatialCacheBytes([positive], w, h), 223268);
  const over = { ...g, layers: g.layers.map(l => l.id === content.id ? { ...l, filters: [positive] } : l) }; assert.throws(() => validateLayerFilterResources(over, layerTree(over.layers)), { code: 'LIMIT_EXCEEDED' });
  const doc = await project(native, w, h, g.layers), args = { layerId: content.id, filterId: entry.id, parameters: { sigma: .01 } };
  await noPixels(native, () => assert.rejects(edit(native, doc, 'update_layer_filter', args), { code: 'LIMIT_EXCEEDED' }));
  await noPixels(native, () => assert.rejects(edit(native, doc, 'apply_transaction', { operations: [{ command: 'update_layer_filter', args }, { command: 'rasterize_layer', args: { layerId: noise.id } }] }), { code: 'LIMIT_EXCEEDED' }));
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await fs.readdir(native.assetsDir), []);
});

test('complete masked-source identity and Bake phase boundaries refuse before decoding or allocating source planes', async t => {
  const { native, dataDir } = await fixture(t), w = 8192, hash = 'a'.repeat(64), identity = filter({ shadows: 0, highlights: 0 });
  const source = h => base({ type: 'raster', width: w, height: h, asset: hash, sourceAsset: hash, transforms: [], visible: false, filters: wrap([identity], mask(w, h, undefined, { enabled: false })) });
  for (const [h, allowed] of [[2730, true], [2731, false]]) {
    const layer = source(h), doc = await project(native, w, h, [layer]), active = { ...layer.filters, mask: { ...layer.filters.mask, enabled: true } }, estimate = estimateFilterMaskSourceBytes({ width: w, height: h, stack: active });
    assert.equal(estimate.estimatedWorkingBytes, 12 * w * h); assert.equal(estimate.estimatedWorkingBytes <= 256 * 1024 * 1024, allowed);
    const call = () => edit(native, doc, 'modify_layer_filter_mask', { layerId: layer.id, enabled: true }); if (allowed) await noPixels(native, call); else { await noPixels(native, () => assert.rejects(call(), { code: 'LIMIT_EXCEEDED' })); assert.deepEqual(await get(native, doc), doc); }
  }
  const h = 1000, S = w * h, noise = { id: randomUUID(), kind: 'add_noise', value: 0, enabled: true, opacity: 1, parameters: { distribution: 'gaussian' } }, stackFor = sigma => wrap([filter({ sigma }), noise], mask(w, h)), args = { width: w, height: h, hasAlpha: true, encodedWorkingBytes: 70000000, encodedAlphaBytes: 59099776 };
  const zero = estimateFilterBakeBytes({ ...args, filters: stackFor(0) }), tiny = estimateFilterBakeBytes({ ...args, filters: stackFor(.01) });
  assert.equal(zero.spatialCacheBytes, 2048); assert.equal(zero.estimatedWorkingBytes, 256 * 1024 * 1024); assert.equal(tiny.estimatedWorkingBytes, zero.estimatedWorkingBytes + 221220); assert.equal(tiny.maskBytes, 70000000 + 59099776 + 13 * S + 4096); assert.equal(tiny.sharedBytes, 4096);
  for (const key of ['decodeBytes', 'maskBytes', 'encodeBytes', 'publicationBytes']) assert.equal(tiny[key], zero[key]);
  assert.equal(layerFilterSpatialCacheBytes([filter({ sigma: 1 }), { id: randomUUID(), kind: 'blur', value: 3, enabled: true, opacity: 1 }], 1024, 1024), 311524);
  const asset = 'b'.repeat(64), alphaAsset = 'c'.repeat(64); for (const [name, bytes] of [[asset, args.encodedWorkingBytes], [alphaAsset, args.encodedAlphaBytes]]) { await fs.writeFile(path.join(native.assetsDir, name), ''); await fs.truncate(path.join(native.assetsDir, name), bytes); }
  const open = fs.open; let reads = 0; fs.open = async (...args) => { const handle = await open(...args); handle.read = () => { reads++; assert.fail('Budget refusal must precede bounded content read'); }; return handle; };
  try { await assert.rejects(bakeFilterSource({ layer: { width: w, height: h, asset, alphaAsset }, filters: stackFor(.01), assetsDir: native.assetsDir, tempRoot: dataDir }), { code: 'LIMIT_EXCEEDED' }); } finally { fs.open = open; }
  assert.equal(reads, 0); assert.equal((await fs.readdir(dataDir)).some(name => name.startsWith('.filter-bake-')), false);
});

test('inactive malformed portable parameters and global placement reject before asset reads', async t => {
  const { native } = await fixture(t), source = await raster(native, image(3, 2, [30, 80, 190, 255]), 3, 2), bytes = await fs.readFile(path.join(native.assetsDir, source.asset)), doc = await project(native, 3, 2, [source]);
  const bad = [null, [], { shadows: -1 }, { shadows: 100.001 }, { shadows: .001 }, { highlights: null }, { shadowWidth: 0 }, { shadowWidth: 1.001 }, { highlightWidth: 101 }, { sigma: -Number.MIN_VALUE }, { sigma: 50.001 }, { sigma: '3' }, { radius: 3 }, { preserveLuminosity: true }];
  for (const parameters of bad) {
    const entry = filter(parameters, { enabled: false, opacity: 0 }); assert.throws(() => normalizeLayerFilter(entry));
    const data = await encodeProjectBundle({ graph: { name: 'Invalid local tone', width: 3, height: 2, selection: null, layers: [{ ...source, filters: wrap([entry], mask(3, 2)) }] }, validateGraph: () => {}, readAsset: async () => bytes });
    await noPixels(native, () => assert.rejects(native.importProject({ data }), { code: 'INVALID_PROJECT_BUNDLE' }), true);
  }
  assert.throws(() => normalizeLayerFilter(filter({}, { value: 1 }))); for (const sigma of [0, Number.MIN_VALUE, 50]) assert.equal(normalizeLocalToneParameters({ sigma }).sigma, sigma);
  await noPixels(native, () => assert.rejects(edit(native, doc, 'add_adjustment', { kind: 'shadows_highlights', value: 0, parameters: defaults })));
  await noPixels(native, () => assert.rejects(edit(native, doc, 'save_edit_recipe', { name: 'Invalid global local tone', slots: [{ key: 'global', type: 'adjustment', kind: 'shadows_highlights' }], steps: [{ command: 'update_adjustment', target: 'global', args: { value: 0, parameters: defaults } }] })));
  assert.deepEqual(await get(native, doc), doc);
});

test('real publication and late mixed-transaction failures preserve masked history and remove only newly owned assets', async t => {
  const { native } = await fixture(t), w = 9, h = 7, scope = mask(w, h, bitmap(Uint8Array.from({ length: w * h }, (_, i) => i * 41 % 256), w, h), { density: .37 }), entry = filter({ sigma: 1 }), source = await raster(native, image(w, h, (x, y) => [x * 21, y * 29, 93, 255]), w, h, { filters: wrap([entry], scope) }), doc = await project(native, w, h, [source]);
  await native.execute('get_preview', { documentId: doc.id, maxWidth: 32 }); const assets = await files(native.assetsDir), projects = await files(native.projectsDir), cache = native.previewCache.stats(), directory = native.projectsDir;
  const store = native.storeAsset.bind(native); let publications = 0; native.storeAsset = async (...args) => { const value = await store(...args); publications++; return value; };
  native.projectsDir = path.join(native.assetsDir, source.asset);
  try { await assert.rejects(edit(native, doc, 'update_layer_filter', { layerId: source.id, filterId: entry.id, parameters: { shadows: 50 } }), { code: 'ENOTDIR' }); await assert.rejects(edit(native, doc, 'bake_layer_filters', { layerId: source.id }), { code: 'ENOTDIR' }); } finally { native.projectsDir = directory; }
  await assert.rejects(edit(native, doc, 'apply_transaction', { operations: [{ command: 'update_layer_filter', args: { layerId: source.id, filterId: entry.id, parameters: { highlights: 19.99 } } }, { command: 'bake_layer_filters', args: { layerId: source.id } }, { command: 'paint_stroke', args: { layerId: source.id, tool: 'brush', points: [{ x: 3, y: 3, pressure: 1 }], size: 3, hardness: 1, opacity: 1, color: '#ff0000' } }, { command: 'set_layer', args: { layerId: randomUUID(), visible: false } }] }), { code: 'NOT_FOUND' });
  assert.ok(publications >= 3); assert.deepEqual(await get(native, doc), doc); assert.deepEqual(graph(native, doc).layers[0].filters, source.filters); assert.deepEqual(await files(native.assetsDir), assets); assert.deepEqual(await files(native.projectsDir), projects); assert.deepEqual(native.previewCache.stats(), cache);
});
