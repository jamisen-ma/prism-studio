import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { sourceSpatialPlan, compileSourceGaussian, sourceSpatialCandidate, SOURCE_SPATIAL_POLICY } from '../server/source-spatial-filters.mjs';
import { applyLayerFilters, filterWork, layerFilterSpatialCacheBytes, validateLayerFilterResources } from '../server/layer-filters.mjs';
import { estimateFilterBakeBytes, bakeFilterSource } from '../server/filter-bake.mjs';
import { layerTree } from '../server/groups.mjs';

const coded = code => cause => cause.code === code;
const entry = (kind, value, extra = {}) => ({ id: randomUUID(), kind, value, enabled: true, opacity: 1, ...extra });
const edit = async (native, doc, command, args = {}) => (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document;
const graphOf = (native, doc) => structuredClone(native.project(doc.id).states[native.project(doc.id).cursor].graph);
const png = (input, width, height) => sharp(input, { raw: { width, height, channels: 4 } }).png().toBuffer();
const data = (width, height) => Buffer.from(Array.from({ length: width * height * 4 }, (_, i) => i % 4 === 3 ? [0, 1, 128, 255][Math.floor(i / 4) % 4] : (Math.floor(i / 4) * 43 + i * 17 + 31) % 256));
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-spatial-source-'));
  const native = await new NativeBackend({ dataDir }).init();
  t.after(async () => { await native.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const original = await png(data(7, 5), 7, 5);
  const doc = (await native.execute('import_image', { mimeType: 'image/png', data: original.toString('base64') })).document;
  return { native, doc, dataDir, original };
}
function oracle(input, width, height, value, sharpen = false) {
  if (value === 0) return Buffer.from(input);
  // Independent 2D BigInt convolution, with its own coefficient compiler.
  const radius = Math.ceil(3 * value), sides = Array.from({ length: radius }, (_, i) => Math.exp(-((i + 1) ** 2) / (2 * value ** 2)));
  const denominator = 1 + 2 * sides.reduce((sum, coefficient) => sum + coefficient, 0), half = sides.map(coefficient => Math.round(65536 * coefficient / denominator));
  const weights = [...half.toReversed(), 65536 - 2 * half.reduce((sum, coefficient) => sum + coefficient, 0), ...half].map(BigInt);
  const output = Buffer.from(input), clamp = (p, n) => Math.max(0, Math.min(n - 1, p));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4; if (!input[i + 3]) continue;
    for (let c = 0; c < 3; c++) {
      let numerator = 0n, alpha = 0n;
      for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
        const j = (clamp(y + dy, height) * width + clamp(x + dx, width)) * 4;
        const weight = weights[dy + radius] * weights[dx + radius] * BigInt(input[j + 3]);
        numerator += BigInt(input[j + c]) * weight; alpha += weight;
      }
      if (sharpen) numerator = 2n * BigInt(input[i + c]) * alpha - numerator;
      output[i + c] = numerator <= 0n ? 0 : numerator >= 255n * alpha ? 255 : Number((2n * numerator + alpha) / (2n * alpha));
    }
  }
  return output;
}
function mix(input, candidate, opacity) {
  const output = Buffer.from(input);
  for (let i = 0; i < input.length; i += 4) if (input[i + 3]) for (let c = 0; c < 3; c++) output[i + c] = Math.round(input[i + c] + (candidate[i + c] - input[i + c]) * opacity);
  return output;
}

test('kernel normalization and metadata plans pin true sigma, exact sum, every bypass and bounds without allocations', () => {
  for (const sigma of [0, Number.MIN_VALUE, .001, .15, .3, .7, 1, 3, 10, 49.999, 50]) {
    const { radius, weights } = compileSourceGaussian(sigma);
    assert.equal(radius, Math.ceil(3 * sigma)); assert.equal(weights.length, 2 * radius + 1);
    assert.equal(weights.reduce((sum, weight) => sum + weight), 65536); assert.ok(weights[radius] > 67);
    assert.deepEqual([...weights], [...weights].reverse());
    if (sigma <= .15) assert.equal(weights[radius], 65536);
    const filter = entry('blur', sigma), plan = sourceSpatialPlan(filter, 8192, 23), rows = Math.min(23, weights.length);
    assert.equal(plan.work, 8192 * 23 * (sigma ? 2 * weights.length + 8 : 1));
    assert.equal(plan.cacheBytes, sigma ? 16 * 8192 * rows + 4 * rows + 8 * weights.length : 0);
    assert.equal(filterWork(filter, 8192 * 23), plan.work);
  }
  for (const extra of [{ enabled: false }, { opacity: 0 }]) { const plan = sourceSpatialPlan(entry('blur', 50, extra), 8192, 23); assert.equal(plan.work, 0); assert.equal(plan.cacheBytes, 0); }
  for (const value of [-1, 50.01, NaN, Infinity, '1', null]) assert.throws(() => compileSourceGaussian(value), coded('INVALID_ARGUMENT'));
  assert.throws(() => sourceSpatialPlan(entry('sharpen', 10.01, { enabled: false }), 1, 1), coded('INVALID_ARGUMENT'));
  assert.throws(() => sourceSpatialPlan(entry('blur', 1), 8192, 8192), coded('LIMIT_EXCEEDED'));
});

test('production Gaussian and single-round RGB unsharp equal independent 2D BigInt results, constant low-alpha and hidden-color invariants', async () => {
  for (const [width, height] of [[1, 1], [7, 1], [1, 5], [5, 3]]) for (const sigma of [Number.MIN_VALUE, .001, .15, .3, .7, 1.25, 3]) for (const kind of ['blur', 'sharpen']) {
    const input = data(width, height), before = Buffer.from(input);
    const actual = await sourceSpatialCandidate(input, width, height, entry(kind, sigma));
    assert.deepEqual(actual, oracle(input, width, height, sigma, kind === 'sharpen')); assert.deepEqual(input, before);
    const hidden = Buffer.from(input), constant = Buffer.from(input);
    for (let i = 0; i < input.length; i += 4) { if (!input[i + 3]) hidden.set([255, 5, 201], i); constant.set([31, 121, 231], i); }
    assert.deepEqual(await sourceSpatialCandidate(constant, width, height, entry(kind, sigma)), constant);
    const changed = await sourceSpatialCandidate(hidden, width, height, entry(kind, sigma));
    for (let i = 0; i < input.length; i += 4) { assert.equal(changed[i + 3], input[i + 3]); if (input[i + 3]) assert.deepEqual(changed.subarray(i, i + 4), actual.subarray(i, i + 4)); else assert.deepEqual(changed.subarray(i, i + 4), hidden.subarray(i, i + 4)); }
  }
});

test('candidate quantization precedes stack opacity; order, zero identity and disabled opacity remain exact', async () => {
  const input = data(7, 5), blur = entry('blur', .7, { opacity: .625 }), sharpen = entry('sharpen', 1.25, { opacity: .75 });
  const first = mix(input, oracle(input, 7, 5, .7), .625), expected = mix(first, oracle(first, 7, 5, 1.25, true), .75);
  assert.deepEqual(await applyLayerFilters(input, 7, 5, [blur, sharpen]), expected);
  assert.notDeepEqual(await applyLayerFilters(input, 7, 5, [sharpen, blur]), expected);
  for (const filter of [entry('blur', 0), entry('sharpen', 0), entry('blur', 50, { enabled: false }), entry('sharpen', 10, { opacity: 0 })]) assert.deepEqual(await applyLayerFilters(input, 7, 5, [filter]), input);
});

test('shared cache admission is a sequential phase maximum and combines with existing nested surfaces', async t => {
  const { native, doc } = await fixture(t), base = graphOf(native, doc), layer = base.layers[0];
  const filters = [entry('blur', 1), entry('sharpen', 3), entry('blur', 50, { opacity: 0 })];
  const cache = sourceSpatialPlan(filters[1], 400, 500).cacheBytes;
  assert.equal(layerFilterSpatialCacheBytes(filters, 400, 500), cache);
  const graph = structuredClone(base); graph.width = 1000; graph.height = 1000; Object.assign(graph.layers[0], { width: 400, height: 500, transforms: [{ type: 'resize', width: 1000, height: 1000 }], filters });
  assert.equal(validateLayerFilterResources(graph, layerTree(graph.layers)).estimatedScratchBytes, Math.max(8_000_000, 8 * 200000 + cache) + 1_000_000);
  const narrow = structuredClone(base); narrow.width = 2000; narrow.height = 2000;
  let parentId; const groups = Array.from({ length: 8 }, (_, index) => { const group = { id: randomUUID(), name: `Group${index}`, type: 'group', mode: 'isolated', visible: false, opacity: 1, blendMode: 'normal', ...(parentId ? { parentId } : {}) }; parentId = group.id; return group; });
  const large = { ...layer, parentId, width: 6500, height: 2000, transforms: [{ type: 'resize', width: 2000, height: 2000 }], filters: [entry('invert', 20)] };
  narrow.layers = [...groups, large]; native.validateGraph(narrow);
  assert.equal(validateLayerFilterResources(narrow, layerTree(narrow.layers)).estimatedScratchBytes, 268_000_000);
  large.filters.push(entry('blur', 1)); assert.throws(() => native.validateGraph(narrow), coded('LIMIT_EXCEEDED'));
});

test('bake estimator charges actual stack cache before bounded source reads, while disabled and zero estimates retain legacy costs', async t => {
  const { native, doc } = await fixture(t), filters = [entry('blur', 1), entry('sharpen', 2)];
  for (const hasAlpha of [false, true]) {
    const options = { width: 400, height: 500, hasAlpha, encodedWorkingBytes: 117, encodedAlphaBytes: hasAlpha ? 93 : 0 };
    const prior = estimateFilterBakeBytes(options), actual = estimateFilterBakeBytes({ ...options, filters });
    assert.equal(actual.spatialCacheBytes, layerFilterSpatialCacheBytes(filters, 400, 500)); assert.equal(actual.filterBytes, prior.filterBytes + actual.spatialCacheBytes);
    for (const field of ['decodeBytes', 'encodeBytes', 'publicationBytes', 'maxOutputBytes']) assert.equal(actual[field], prior[field]);
    for (const bypass of [entry('blur', 0), entry('blur', 50, { enabled: false }), entry('sharpen', 10, { opacity: 0 })]) assert.deepEqual(estimateFilterBakeBytes({ ...options, filters: [bypass] }), prior);
  }
  const sourceHash = 'a'.repeat(64), alphaHash = 'b'.repeat(64);
  await fs.writeFile(path.join(native.assetsDir, sourceHash), Buffer.alloc(1)); await fs.truncate(path.join(native.assetsDir, sourceHash), 1_000_000);
  await fs.writeFile(path.join(native.assetsDir, alphaHash), Buffer.alloc(100));
  const layer = { ...doc.layers[0], width: 7850, height: 2000, asset: sourceHash, alphaAsset: alphaHash }, stack = [entry('blur', 1)];
  const baseline = estimateFilterBakeBytes({ width: layer.width, height: layer.height, hasAlpha: true, encodedWorkingBytes: 1_000_000, encodedAlphaBytes: 100 });
  const actual = estimateFilterBakeBytes({ width: layer.width, height: layer.height, hasAlpha: true, encodedWorkingBytes: 1_000_000, encodedAlphaBytes: 100, filters: stack });
  assert.ok(baseline.estimatedWorkingBytes <= baseline.maxWorkingBytes); assert.ok(actual.estimatedWorkingBytes > actual.maxWorkingBytes);
  let reads = 0; const open = fs.open; fs.open = async (...args) => { const handle = await open(...args), read = handle.read.bind(handle); handle.read = (...values) => { reads++; return read(...values); }; return handle; };
  try { await assert.rejects(bakeFilterSource({ layer, filters: stack, assetsDir: native.assetsDir, tempRoot: native.dataDir }), coded('LIMIT_EXCEEDED')); } finally { fs.open = open; }
  assert.equal(reads, 0);
});

test('actual masked, transformed source grades bake exactly with separate alpha and remain structurally protected at identity', async t => {
  const { native, doc: start, original } = await fixture(t); let graph = graphOf(native, start);
  graph.layers[0].alphaAsset = await native.storeAlpha(Buffer.from(Array.from({ length: 35 }, (_, i) => [0, 1, 128, 255][i % 4])), 7, 5);
  let doc = (await native.commit(native.project(start.id), graph, 'Cutout fixture')).document, id = doc.layers[0].id;
  doc = await edit(native, doc, 'add_layer_filter', { layerId: id, kind: 'blur', value: .7, opacity: .625 });
  doc = await edit(native, doc, 'add_layer_filter', { layerId: id, kind: 'sharpen', value: 1.25, opacity: .75 });
  doc = await edit(native, doc, 'set_layer_mask', { layerId: id, mask: { shape: 'ellipse', x: 0, y: 0, width: 6, height: 4, feather: .5 } });
  doc = await edit(native, doc, 'modify_layer_mask', { layerId: id, density: .5 });
  doc = await edit(native, doc, 'set_layer_mask_position', { layerId: id, x: 1, y: 0 });
  doc = await edit(native, doc, 'transform_layer', { layerId: id, x: .25, y: .25, rotation: 9 });
  const before = await native.render(native.project(doc.id)), alpha = doc.layers[0].alphaAsset;
  doc = await edit(native, doc, 'bake_layer_filters', { layerId: id }); assert.deepEqual(await native.render(native.project(doc.id)), before); assert.equal(doc.layers[0].alphaAsset, alpha);
  assert.deepEqual(await fs.readFile(path.join(native.assetsDir, doc.layers[0].sourceAsset)), original);
  doc = await edit(native, doc, 'add_layer_filter', { layerId: id, kind: 'blur', value: 0 });
  await assert.rejects(edit(native, doc, 'set_layer_protection', { layerId: id, protected: true }), coded('PROTECTED_LAYER'));
  const asset = doc.layers[0].asset; doc = await edit(native, doc, 'bake_layer_filters', { layerId: id }); assert.equal(doc.layers[0].asset, asset);
  const caps = await native.execute('capabilities', {}); assert.equal(caps.layerFilterSpatialPolicy, SOURCE_SPATIAL_POLICY); assert.equal(caps.layerFilterKinds.length, 32);
});

test('global blur and LAB sharpen retain captured Sharp behavior including old floors and soft-alpha RGB', async t => {
  const { native } = await fixture(t), input = data(7, 5);
  for (const kind of ['blur', 'sharpen']) for (const value of [0, .001, .7, 3]) {
    const layer = { kind, value, opacity: .625 }, expected = Buffer.from(input);
    if (value) {
      let image = sharp(input, { raw: { width: 7, height: 5, channels: 4 }, limitInputPixels: 24_000_000 });
      image = kind === 'blur' ? image.blur(Math.max(.3, value)) : image.sharpen({ sigma: Math.max(.001, value) });
      const changed = await image.raw().toBuffer();
      for (let i = 0; i < input.length; i += 4) for (let c = 0; c < 3; c++) expected[i + c] = Math.max(0, Math.min(255, Math.round(input[i + c] + (changed[i + c] - input[i + c]) * .625)));
    }
    assert.deepEqual(await native.applyAdjustment(input, 7, 5, layer), expected);
  }
});

test('wide-source weighted tap loops yield while retaining exact alpha and current work limits', async () => {
  const width = 8192, height = 64, input = data(width, height);
  let beats = 0, running = true; const heartbeat = () => { if (running) { beats++; setImmediate(heartbeat); } }; setImmediate(heartbeat);
  const output = await sourceSpatialCandidate(input, width, height, entry('sharpen', 10)); running = false;
  assert.ok(beats >= 900, `Observed ${beats} weighted tap yields`);
  for (let i = 0; i < input.length; i += 4) { assert.equal(output[i + 3], input[i + 3]); if (!input[i + 3]) assert.deepEqual(output.subarray(i, i + 4), input.subarray(i, i + 4)); }
  const square = Buffer.alloc(1024 * 1024 * 4);
  await assert.rejects(sourceSpatialCandidate(square, 1024, 1024, entry('blur', 50)), coded('LIMIT_EXCEEDED'));
});
