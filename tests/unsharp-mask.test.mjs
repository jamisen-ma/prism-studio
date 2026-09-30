import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { normalizeUnsharpParameters, compileUnsharpAmount, unsharpChannelByte, UNSHARP_MASK_POLICY } from '../server/unsharp-mask.mjs';
import { ADJUSTMENTS, PARAMETERIZED_ADJUSTMENTS } from '../server/color.mjs';
import { sourceSpatialPlan, sourceSpatialCandidate } from '../server/source-spatial-filters.mjs';
import { normalizeLayerFilter, editedFilterStack, applyLayerFilters, filterWork, layerFilterSpatialCacheBytes, LAYER_FILTER_PARAMETERIZED_KINDS } from '../server/layer-filters.mjs';
import { estimateFilterBakeBytes } from '../server/filter-bake.mjs';

const coded = code => cause => cause.code === code;
const filter = (parameters, extra = {}) => ({ id: randomUUID(), kind: 'unsharp_mask', value: 0, enabled: true, opacity: 1, ...(parameters === undefined ? {} : { parameters }), ...extra });
const data = (width, height) => Buffer.from(Array.from({ length: width * height * 4 }, (_, i) => i % 4 === 3 ? [0, 1, 128, 255][Math.floor(i / 4) % 4] : (i * 173 + Math.floor(i / 4) * 11) % 256));
function oracleByte(c, n, d, amount, threshold) {
  d = BigInt(d); n = BigInt(n);
  const residual = BigInt(c) * d - n;
  if ((residual < 0n ? -residual : residual) <= BigInt(threshold) * d) return c;
  const denominator = d * 10000n, numerator = BigInt(c) * denominator + BigInt(Math.round(amount * 100)) * residual;
  return numerator <= 0n ? 0 : numerator >= 255n * denominator ? 255 : Number((2n * numerator + denominator) / (2n * denominator));
}
function oracle(input, width, height, parameters) {
  const { amount = 100, sigma = 1, threshold = 0 } = parameters;
  if (!amount || !sigma || threshold === 255) return Buffer.from(input);
  const radius = Math.ceil(3 * sigma), sides = Array.from({ length: radius }, (_, i) => Math.exp(-((i + 1) ** 2) / (2 * sigma ** 2)));
  const total = 1 + 2 * sides.reduce((sum, value) => sum + value, 0), side = sides.map(value => Math.round(65536 * value / total));
  const weights = [...side.toReversed(), 65536 - 2 * side.reduce((sum, value) => sum + value, 0), ...side].map(BigInt), out = Buffer.from(input);
  const edge = (p, size) => Math.max(0, Math.min(size - 1, p));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4; if (!input[i + 3]) continue;
    for (let c = 0; c < 3; c++) {
      let n = 0n, d = 0n;
      for (let ky = 0; ky < weights.length; ky++) for (let kx = 0; kx < weights.length; kx++) {
        const j = (edge(y + ky - radius, height) * width + edge(x + kx - radius, width)) * 4;
        const weight = weights[ky] * weights[kx] * BigInt(input[j + 3]); n += BigInt(input[j + c]) * weight; d += weight;
      }
      out[i + c] = oracleByte(input[i + c], n, d, amount, threshold);
    }
  }
  return out;
}
const mix = (input, candidate, opacity) => Buffer.from(input.map((value, i) => i % 4 === 3 || !input[i - i % 4 + 3] ? value : Math.round(value + (candidate[i] - value) * opacity)));
const edit = async (native, doc, command, args = {}) => (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document;
const graphOf = (native, doc) => structuredClone(native.project(doc.id).states[native.project(doc.id).cursor].graph);
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-unsharp-')), native = await new NativeBackend({ dataDir }).init();
  t.after(async () => { await native.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const pixels = data(7, 5), original = await sharp(pixels, { raw: { width: 7, height: 5, channels: 4 } }).png().toBuffer();
  const doc = (await native.execute('import_image', { mimeType: 'image/png', data: original.toString('base64') })).document;
  return { native, doc, dataDir, pixels, original };
}

test('source-only parameters are complete independent copies, strict at every bypass, and partial updates retain effective defaults', () => {
  assert.deepEqual(normalizeUnsharpParameters(), { amount: 100, sigma: 1, threshold: 0 });
  const supplied = Object.freeze({ amount: 37 }), normalized = normalizeUnsharpParameters(supplied);
  assert.deepEqual(normalized, { amount: 37, sigma: 1, threshold: 0 }); assert.notEqual(normalized, supplied);
  const initial = filter({ amount: 37 }), changed = editedFilterStack([initial], 'update_layer_filter', { filterId: initial.id, parameters: { threshold: 12 } });
  assert.deepEqual(changed[0].parameters, { amount: 37, sigma: 1, threshold: 12 }); assert.deepEqual(initial.parameters, { amount: 37 });
  assert.equal(Object.keys(ADJUSTMENTS).length, 28); assert.ok(!('unsharp_mask' in ADJUSTMENTS)); assert.ok(!PARAMETERIZED_ADJUSTMENTS.includes('unsharp_mask')); assert.ok(LAYER_FILTER_PARAMETERIZED_KINDS.includes('unsharp_mask'));
  for (const parameters of [null, [], { amount: 1.001 }, { amount: '5' }, { amount: 501 }, { sigma: Infinity }, { sigma: -1 }, { sigma: 50.001 }, { threshold: 1.5 }, { threshold: 256 }, { threshold: null }, { tint: true }, { points: [] }]) {
    assert.throws(() => normalizeLayerFilter(filter(parameters, { enabled: false, opacity: 0 })), coded('INVALID_ARGUMENT'));
  }
  assert.throws(() => normalizeLayerFilter(filter({ amount: 0 }, { value: 1 })), coded('INVALID_ARGUMENT'));
  assert.deepEqual(normalizeUnsharpParameters({ sigma: Number.MIN_VALUE }), { amount: 100, sigma: Number.MIN_VALUE, threshold: 0 });
});

test('exact rational shortcut and guarded generic arithmetic match BigInt at every eligible amount and seeded threshold boundary', () => {
  const dmax = 255 * 65536 ** 2;
  let plans = 0, checks = 0;
  for (let units = 0; units <= 50000; units++) {
    const amount = units / 100, plan = compileUnsharpAmount(amount);
    if (!plan.exact) continue; plans++;
    for (const d of [1, dmax - 1, dmax]) for (const c of [0, 1, 127, 128, 254, 255]) for (const n of [0, Math.floor(d / 2), 127 * d, 255 * d]) {
      assert.equal(unsharpChannelByte(c, n, d, plan, 0), oracleByte(c, n, d, amount, 0)); checks++;
    }
  }
  assert.equal(plans, 70); assert.equal(checks, 5040);
  let seed = 6771; const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let i = 0; i < 10000; i++) {
    const d = 1 + Math.floor(next() / 2 ** 32 * dmax), c = next() % 256, n = Math.floor(next() / 2 ** 32 * 255 * d), amount = (next() % 50001) / 100, threshold = next() % 256;
    assert.equal(unsharpChannelByte(c, n, d, compileUnsharpAmount(amount), threshold), oracleByte(c, n, d, amount, threshold));
  }
  for (const [amount, c, residual, expected] of [[5, 80, -10, 80], [5, 208, 10, 209], [37, 20, -50, 2], [37, 220, 50, 239]]) {
    assert.equal(compileUnsharpAmount(amount).exact, false);
    assert.equal(unsharpChannelByte(c, (c - residual) * dmax, dmax, compileUnsharpAmount(amount), 0), expected);
    assert.equal(unsharpChannelByte(c, (c - residual) * dmax, dmax, compileUnsharpAmount(amount), Math.abs(residual)), c);
  }
});

test('unrounded Gaussian RGB and single-round candidates agree with an independent 2D reference and fixed-sharpen defaults', async () => {
  for (const [width, height] of [[1, 1], [5, 1], [1, 3], [3, 2]]) for (const sigma of [Number.MIN_VALUE, .001, .3977, .528474, 1.25, 3]) for (const amount of [5, 25, 37, 100, 333.33]) {
    const input = data(width, height), parameters = { amount, sigma, threshold: amount === 25 ? 7 : 0 };
    const actual = await sourceSpatialCandidate(input, width, height, filter(parameters));
    assert.deepEqual(actual, oracle(input, width, height, parameters));
    if (amount === 100) assert.deepEqual(actual, await sourceSpatialCandidate(input, width, height, { kind: 'sharpen', value: sigma }));
  }
  for (const alpha of [1, 128, 255]) {
    const input = Buffer.from(Array.from({ length: 7 }, () => [31, 121, 231, alpha]).flat());
    assert.deepEqual(await sourceSpatialCandidate(input, 7, 1, filter({ amount: 499.99, sigma: 3 })), input);
  }
  const input = data(7, 5), changed = Buffer.from(input);
  for (let i = 0; i < input.length; i += 4) if (!input[i + 3]) changed.set([255, 9, 173], i);
  const normal = await sourceSpatialCandidate(input, 7, 5, filter({ amount: 37, sigma: .528474 })), hidden = await sourceSpatialCandidate(changed, 7, 5, filter({ amount: 37, sigma: .528474 }));
  for (let i = 0; i < input.length; i += 4) assert.deepEqual(hidden.subarray(i, i + 4), input[i + 3] ? normal.subarray(i, i + 4) : changed.subarray(i, i + 4));
});

test('threshold is per-channel and strict before rounding; amount and entry opacity remain distinct sequential operations', async () => {
  const input = Buffer.from([80, 100, 120, 128, 208, 100, 184, 128]), parameters = { amount: 500, sigma: .3977, threshold: 5 };
  assert.deepEqual(await sourceSpatialCandidate(input, 2, 1, filter(parameters)), input);
  const shifted = Buffer.from(input); shifted[3] = 127; shifted[7] = 129;
  assert.deepEqual(await sourceSpatialCandidate(shifted, 2, 1, filter(parameters)), oracle(shifted, 2, 1, parameters));
  assert.notDeepEqual(await sourceSpatialCandidate(shifted, 2, 1, filter(parameters)), shifted);
  const image = data(7, 5), first = filter({ amount: 333.33, sigma: .7 }, { opacity: .625 }), second = filter({ amount: 5, sigma: .3977 }, { opacity: .75 });
  const expected = mix(mix(image, oracle(image, 7, 5, first.parameters), first.opacity), oracle(mix(image, oracle(image, 7, 5, first.parameters), first.opacity), 7, 5, second.parameters), second.opacity);
  assert.deepEqual(await applyLayerFilters(image, 7, 5, [first, second]), expected);
  assert.notDeepEqual(await applyLayerFilters(image, 7, 5, [filter({ amount: 400, sigma: .7 }, { opacity: .5 })]), await applyLayerFilters(image, 7, 5, [filter({ amount: 200, sigma: .7 })]));
});

test('metadata work and render/bake cache follow sigma parameters, known identities and sequential phase maxima', () => {
  for (const sigma of [Number.MIN_VALUE, .3977, 1, 3, 10, 50]) {
    const entry = filter({ sigma }), plan = sourceSpatialPlan(entry, 8192, 23), taps = 2 * Math.ceil(3 * sigma) + 1, rows = Math.min(23, taps);
    assert.equal(plan.work, 8192 * 23 * (2 * taps + 40)); assert.equal(filterWork(entry, 8192 * 23), plan.work);
    assert.equal(plan.cacheBytes, 16 * 8192 * rows + 4 * rows + 8 * taps);
  }
  const options = { width: 400, height: 500, hasAlpha: true, encodedWorkingBytes: 77, encodedAlphaBytes: 99 }, base = estimateFilterBakeBytes(options);
  for (const entry of [filter({ amount: 0 }), filter({ sigma: 0 }), filter({ threshold: 255 }), filter({ sigma: 50 }, { enabled: false }), filter({ sigma: 50 }, { opacity: 0 })]) {
    const plan = sourceSpatialPlan(entry, 400, 500); assert.equal(plan.computesCandidate, false); assert.equal(plan.cacheBytes, 0);
    assert.equal(plan.work, entry.enabled && entry.opacity ? 200000 : 0); assert.deepEqual(estimateFilterBakeBytes({ ...options, filters: [entry] }), base);
  }
  const entries = [filter({ sigma: 1 }), filter({ sigma: 3 }), filter({ sigma: 50 }, { enabled: false })];
  const maximum = sourceSpatialPlan(entries[1], 400, 500).cacheBytes;
  assert.equal(layerFilterSpatialCacheBytes(entries, 400, 500), maximum);
  assert.equal(estimateFilterBakeBytes({ ...options, filters: entries }).filterBytes, base.filterBytes + maximum);
});

test('native defaults and partial edits are metadata-only, source-only and atomic across work activation and protected identity guards', async t => {
  const { native, doc: start, dataDir } = await fixture(t), id = start.layers[0].id, assets = await fs.readdir(native.assetsDir);
  const cap = await native.execute('capabilities'); assert.equal(cap.layerFilterKinds.length, 32); assert.equal(cap.adjustmentKinds.length, 28); assert.equal(cap.layerFilterUnsharpPolicy, UNSHARP_MASK_POLICY);
  native.renderLayer = async () => { throw new Error('Unexpected render'); };
  let doc = await edit(native, start, 'add_layer_filter', { layerId: id, kind: 'unsharp_mask', value: 0 });
  const filterId = doc.layers[0].filters[0].id; assert.deepEqual(doc.layers[0].filters[0].parameters, { amount: 100, sigma: 1, threshold: 0 });
  doc = await edit(native, doc, 'update_layer_filter', { layerId: id, filterId, parameters: { threshold: 255 } });
  const graph = graphOf(native, doc); graph.layers[0].width = 8000; graph.layers[0].height = 1000; graph.layers[0].transforms = [{ type: 'resize', width: 7, height: 5 }]; graph.layers[0].visible = false;
  doc = (await native.commit(native.project(doc.id), graph, 'Large hidden identity')).document;
  await assert.rejects(edit(native, doc, 'update_layer_filter', { layerId: id, filterId, parameters: { threshold: 0 } }), coded('LIMIT_EXCEEDED'));
  await assert.rejects(edit(native, doc, 'set_layer_protection', { layerId: id, protected: true }), coded('PROTECTED_LAYER'));
  await assert.rejects(edit(native, doc, 'add_adjustment', { kind: 'unsharp_mask', value: 0 }), coded('UNSUPPORTED'));
  assert.deepEqual((await native.execute('get_document', { documentId: doc.id })).document, doc); assert.deepEqual(await fs.readdir(native.assetsDir), assets);
  const reopened = await new NativeBackend({ dataDir }).init(); t.after(() => reopened.close()); assert.deepEqual((await reopened.execute('get_document', { documentId: doc.id })).document.layers, doc.layers);
});

test('actual separate-alpha source bake preserves transformed masked appearance, originals and one-undo transaction history', async t => {
  const { native, doc: start, pixels, original } = await fixture(t), id = start.layers[0].id;
  const graph = graphOf(native, start), alpha = Buffer.from(Array.from({ length: 35 }, (_, p) => [0, 1, 128, 255][p % 4]));
  graph.layers[0].alphaAsset = await native.storeAlpha(alpha, 7, 5);
  let doc = (await native.commit(native.project(start.id), graph, 'Separate alpha')).document;
  doc = await edit(native, doc, 'add_layer_filter', { layerId: id, kind: 'unsharp_mask', value: 0, parameters: { amount: 37, sigma: .528474, threshold: 3 }, opacity: .625 });
  doc = await edit(native, doc, 'set_layer_mask', { layerId: id, mask: { shape: 'ellipse', x: 0, y: 0, width: 6, height: 4, feather: .5 } });
  doc = await edit(native, doc, 'modify_layer_mask', { layerId: id, density: .5 });
  doc = await edit(native, doc, 'set_layer_mask_position', { layerId: id, x: 1, y: -1 });
  await assert.rejects(edit(native, doc, 'resize_document', { width: 14, height: 10, resample: 'nearest' }), coded('MASK_POSITION_REQUIRES_RASTERIZE'));
  doc = await edit(native, doc, 'transform_layer', { layerId: id, x: .25, y: -.25, scaleX: 1.1, scaleY: .9, rotation: 12 });
  const prior = doc, rendered = await native.renderGraph(doc), before = doc.layers[0];
  doc = await edit(native, doc, 'apply_transaction', { label: 'Bake unsharp', operations: [{ command: 'bake_layer_filters', args: { layerId: id } }] });
  assert.deepEqual(await native.renderGraph(doc), rendered); assert.deepEqual({ ...doc.layers[0], filters: before.filters, asset: before.asset }, before);
  assert.deepEqual(await fs.readFile(path.join(native.assetsDir, before.sourceAsset)), original);
  const decoded = await sharp(await fs.readFile(path.join(native.assetsDir, doc.layers[0].asset))).ensureAlpha().raw().toBuffer();
  for (let p = 0; p < alpha.length; p++) assert.equal(decoded[p * 4 + 3], pixels[p * 4 + 3]);
  assert.equal(doc.history.length, prior.history.length + 1); doc = await edit(native, doc, 'undo'); assert.deepEqual(doc.layers, prior.layers);
});

test('wide authored all-channel half ties yield and preserve exact bytes through the generic BigInt path', async () => {
  const width = 8192, height = 64, input = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) input.set([80 + 128 * (x % 2), 81 + 128 * (x % 2), 82 + 128 * (x % 2), 255], (y * width + x) * 4);
  let turns = 0, stopped = false; const tick = () => { if (!stopped) { turns++; setImmediate(tick); } }; setImmediate(tick);
  const output = await sourceSpatialCandidate(input, width, height, filter({ amount: 5, sigma: .3977 })); stopped = true;
  assert.ok(turns >= 70, `Expected bounded tap yields, observed ${turns}`);
  for (let y = 0; y < height; y++) for (let x = 2; x < width - 2; x++) for (let c = 0; c < 3; c++) assert.equal(output[(y * width + x) * 4 + c], (x % 2 ? 209 : 80) + c);
});
