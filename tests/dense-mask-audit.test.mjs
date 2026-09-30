import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { bitmapMask, maskCoverage } from '../server/masks.mjs';
import { layerMaskCoverage } from '../server/layer-mask.mjs';
import { encodeDenseMaskFrame, validateDenseMaskFrame, prepareMaskCoverage, prepareLayerMaskCoverage, encodeMaskAlpha, combineMaskAlpha, withMaskPreparationBudget, chargeMaskPreparation } from '../server/dense-mask.mjs';
import { estimateDenseMaskResources, validateDenseMaskResources, validateDenseMaskOperation, denseMaskPreparationWork, estimateDenseLeafBytes, denseSourceAuxiliaryBytes, denseDecorationBytes, denseGlobalBytes } from '../server/dense-mask-resources.mjs';
import { projectAssetUses, denseMaskHistoryAssets, validateColorLookupHistory } from '../server/lookup-assets.mjs';
import { encodeProjectBundle, decodeProjectBundle } from '../server/project-bundle.mjs';
import { CHANNELS, CHANNEL_GOLDENS, channelCoverageReference, channelPlaneReference, authoredFrame, highFrequencyRGBA, runCount } from './fixtures/dense-mask/reference.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const base = extra => ({ id: randomUUID(), name: 'Independent dense-mask audit', visible: true, opacity: 1, blendMode: 'normal', ...extra });
const filter = (kind = 'invert', extra = {}) => ({ id: randomUUID(), kind, value: kind === 'invert' ? 100 : 0, enabled: true, opacity: 1, ...extra });
const scene = (width, height, layers, extra = {}) => ({ name: 'Dense-mask audit', width, height, selection: null, layers, ...extra });
const graphOf = (native, doc) => { const project = native.projects.get(doc.id); return structuredClone(project.states[project.cursor].graph); };
const get = async (native, doc) => (await native.execute('get_document', { documentId: doc.id })).document;
const edit = (native, doc, command, args = {}) => native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...(command === 'apply_transaction' ? { label: 'Dense-mask audit' } : {}), ...args });
const files = async directory => Object.fromEntries(await Promise.all((await fs.readdir(directory)).sort().map(async name => [name, await fs.readFile(path.join(directory, name))])));
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-dense-mask-audit-'));
  const native = await new NativeBackend({ dataDir, segmentSubject: () => assert.fail('No model may be called by a channel or mask operation.') }).init();
  t.after(async () => { await native.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { native, dataDir };
}
async function raster(native, pixels, width, height, extra = {}) {
  const asset = await native.storeAsset(await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer());
  return base({ type: 'raster', width, height, asset, sourceAsset: asset, sourceFormat: 'png', transforms: [], ...extra });
}
async function dense(native, alpha, width, height, extra = {}) {
  const authored = authoredFrame(alpha, width, height, extra);
  assert.equal(await native.storeAsset(authored.bytes), authored.descriptor.asset);
  return authored.descriptor;
}
async function project(native, width, height, layers, extra = {}) { return (await native.newProject(scene(width, height, layers, extra), 'Independent dense fixture')).document; }
async function opaqueGray(result) {
  const pixels = await sharp(Buffer.isBuffer(result.data) ? result.data : Buffer.from(result.data, 'base64')).toColourspace('srgb').ensureAlpha().raw().toBuffer();
  const output = Buffer.alloc(pixels.length / 4);
  for (let p = 0; p < output.length; p++) { output[p] = pixels[4 * p]; assert.deepEqual([...pixels.subarray(4 * p, 4 * p + 4)], [output[p], output[p], output[p], 255]); }
  return output;
}
async function storedCoverage(native, mask) {
  assert.equal(mask.feather, 0); assert.equal(mask.invert, false);
  if (mask.shape === 'bitmap') { const alpha = Buffer.alloc(mask.width * mask.height); for (let r = 0; r < mask.runs.length; r += 3) alpha.fill(mask.runs[r + 2], mask.runs[r], mask.runs[r] + mask.runs[r + 1]); return alpha; }
  assert.equal(mask.shape, 'alpha8');
  const bytes = await fs.readFile(path.join(native.assetsDir, mask.asset));
  assert.equal(hash(bytes), mask.asset); assert.equal(bytes.length, mask.width * mask.height + 32); assert.equal(mask.bytes, bytes.length);
  assert.deepEqual([...bytes.subarray(0, 8)], [80, 82, 73, 83, 77, 65, 56, 0]);
  assert.deepEqual([8, 12, 16, 20, 24, 28].map(at => bytes.readUInt32BE(at)), [1, mask.width, mask.height, mask.width * mask.height, 0, 0]);
  return Buffer.from(bytes.subarray(32));
}
async function noAssetIO(native, operation) {
  const restore = [], calls = [];
  for (const name of ['render', 'renderGraph', 'renderLayer', 'readAlpha', 'readDenseMask', 'storeAlpha', 'storeAsset', 'readProjectAsset', 'validateProjectAsset', 'segmentSubject']) {
    const previous = native[name]; native[name] = () => { calls.push(name); assert.fail(`Unexpected ${name}`); }; restore.push(() => { native[name] = previous; });
  }
  for (const name of ['readFile', 'writeFile', 'open', 'rename', 'link', 'stat']) {
    const previous = fs[name]; fs[name] = () => { calls.push(`fs.${name}`); assert.fail(`Unexpected fs.${name}`); }; restore.push(() => { fs[name] = previous; });
  }
  try { return await operation(); } finally { restore.reverse().forEach(fn => fn()); assert.deepEqual(calls, [], 'An intercepted I/O exception is not a metadata rejection.'); }
}

test('Dense helper framing, corruption refusal and exact adaptive run boundary match independent authored bytes', async () => {
  for (const [width, height] of [[1, 1], [13, 9], [8192, 1]]) {
    const alpha = Buffer.from(Array.from({ length: width * height }, (_, i) => (i * 97 + 13) & 255)), expected = authoredFrame(alpha, width, height);
    const actual = await encodeDenseMaskFrame(alpha, width, height);
    assert.deepEqual(actual.frame, expected.bytes); assert.deepEqual(actual.descriptor, expected.descriptor);
    assert.deepEqual(await validateDenseMaskFrame(actual.frame, actual.descriptor), actual.descriptor);
    for (const at of [0, 7, 8, 12, 16, 20, 24, 28, 32]) {
      const corrupt = Buffer.from(actual.frame); corrupt[at] ^= 1;
      await assert.rejects(validateDenseMaskFrame(corrupt, actual.descriptor), { code: 'CORRUPT_ASSET' });
      if (at < 32) await assert.rejects(validateDenseMaskFrame(corrupt, { ...actual.descriptor, asset: hash(corrupt) }), { code: 'CORRUPT_ASSET' });
    }
    await assert.rejects(validateDenseMaskFrame(Buffer.concat([actual.frame, Buffer.from([0])]), actual.descriptor), { code: 'CORRUPT_ASSET' });
    assert.throws(() => maskCoverage(actual.descriptor), /asynchronous|prepared/);
  }
  const atLimit = Buffer.from(Array.from({ length: 400_000 }, (_, i) => i % 2 ? 0 : 137));
  const sparse = await encodeMaskAlpha(atLimit, 8000, 50);
  assert.equal(sparse.descriptor.shape, 'bitmap'); assert.equal(sparse.descriptor.runs.length, 600_000); assert.equal(sparse.frame, undefined);
  assert.deepEqual(sparse.descriptor, bitmapMask(atLimit, 8000, 50));
  const above = Buffer.alloc(8000 * 51); for (let i = 0; i < 400_002; i += 2) above[i] = 137;
  let yielded = false; const pending = encodeMaskAlpha(above, 8000, 51); setImmediate(() => { yielded = true; });
  const result = await pending; assert.equal(yielded, true); assert.equal(result.descriptor.shape, 'alpha8'); assert.deepEqual(result.frame, authoredFrame(above, 8000, 51).bytes);
  const zero = await encodeMaskAlpha(Buffer.alloc(4), 2, 2); assert.equal(zero.descriptor.shape, 'bitmap'); assert.deepEqual(zero.descriptor.runs, []);
});

test('Dense prepared callbacks own metadata, reject accessors before reads and retain legacy byte-density arithmetic', async () => {
  const width = 256, height = 1, alpha = Buffer.from(Array.from({ length: width }, (_, i) => i)), authored = authoredFrame(alpha, width, height);
  let release; const gate = new Promise(resolve => { release = resolve; });
  const layer = { mask: { ...authored.descriptor }, maskDensity: 0.1 };
  const pending = prepareLayerMaskCoverage(layer, async () => { await gate; return Buffer.from(authored.bytes); });
  layer.mask.shape = 'rectangle'; layer.mask.invert = true; layer.maskDensity = 0.9; release();
  const actual = await pending, expected = layerMaskCoverage({ mask: bitmapMask(alpha, width, height), maskDensity: 0.1 });
  for (let x = 0; x < width; x++) assert.equal(actual(x, 0), expected(x, 0));
  let getterCalls = 0, readCalls = 0;
  for (const field of ['shape', 'width', 'height', 'asset', 'bytes', 'feather', 'invert']) {
    const bad = { ...authored.descriptor }; Object.defineProperty(bad, field, { enumerable: true, get() { getterCalls++; return authored.descriptor[field]; } });
    for (const run of [() => prepareMaskCoverage(bad, async () => { readCalls++; return authored.bytes; }), () => prepareLayerMaskCoverage({ mask: bad, maskDensity: 0 }, async () => { readCalls++; return authored.bytes; })]) await assert.rejects(run(), { code: 'INVALID_ARGUMENT' });
  }
  const inheritedFields = { ...authored.descriptor }; delete inheritedFields.shape;
  const inherited = Object.assign(Object.create({ get shape() { getterCalls++; return 'alpha8'; } }), inheritedFields);
  for (const run of [() => prepareMaskCoverage(inherited, async () => { readCalls++; return authored.bytes; }), () => prepareLayerMaskCoverage({ mask: inherited, maskDensity: 0 }, async () => { readCalls++; return authored.bytes; })]) await assert.rejects(run(), { code: 'INVALID_ARGUMENT' });
  assert.equal(getterCalls, 0); assert.equal(readCalls, 0);
  for (const feather of [0, 0.1, 2.75, 100, 1_000_000]) for (const invert of [false, true]) {
    const descriptor = { ...authored.descriptor, feather, invert }, legacy = maskCoverage({ ...bitmapMask(alpha, width, height), feather, invert });
    const prepared = await prepareMaskCoverage(descriptor, async () => Buffer.from(authored.bytes));
    for (let x = -1; x <= width; x++) assert.equal(prepared(x, 0), legacy(x, 0));
  }
  const active = { shape: 'rectangle', x: 0, y: 0, width: 1, height: 1, feather: 3, invert: false };
  assert.deepEqual(await combineMaskAlpha(active, Buffer.from([69]), 1, 1, 'intersect'), Buffer.from([11]));
  assert.deepEqual(await combineMaskAlpha(active, Buffer.from([69]), 1, 1, 'subtract'), Buffer.from([31]));
});

test('Dense metadata resource gate joins callbacks, source auxiliaries, global spatial buffers, styles and repeated protection work', () => {
  const descriptor = (width, height, extra = {}) => ({ shape: 'alpha8', asset: 'b'.repeat(64), bytes: width * height + 32, width, height, x: 0, y: 0, feather: 0, invert: false, ...extra });
  const fake = (width, height, extra = {}) => base({ type: 'raster', width, height, asset: 'a'.repeat(64), sourceAsset: 'a'.repeat(64), transforms: [], ...extra });
  for (const [height, admitted] of [[2730, true], [2731, false]]) {
    const width = 8192, n = width * height, graph = scene(width, height, [fake(width, height, { mask: descriptor(width, height) })]);
    const estimate = estimateDenseMaskResources(graph);
    assert.equal(estimate.estimatedWorkingBytes, 12 * n + 64); assert.equal(estimate.preparationWork, n);
    if (admitted) assert.doesNotThrow(() => validateDenseMaskResources(graph)); else assert.throws(() => validateDenseMaskResources(graph), { code: 'LIMIT_EXCEEDED' });
  }
  const width = 4096, height = 3000, n = width * height, styled = fake(width, height, { mask: descriptor(width, height), effects: { glow: { color: '#ffffff', opacity: 1, blur: 0 } }, outline: { width: 1, color: '#ffffff' } });
  assert.equal(denseDecorationBytes(styled, width, height), 15 * n + 20 * height + 8);
  assert.equal(estimateDenseMaskResources(scene(width, height, [styled])).estimatedWorkingBytes, 282_684_072);
  assert.throws(() => validateDenseMaskResources(scene(width, height, [styled])), { code: 'LIMIT_EXCEEDED' });
  assert.equal(denseDecorationBytes(fake(1, 8192, { outline: { width: 1 } }), 1, 8192), 253_960);
  for (const [entry, bytes] of [[filter('median', { value: 3 }), 3264], [filter('levels', { parameters: {} }), 256], [filter('curves', { parameters: { channel: 'rgb', points: [{ x: 0, y: 0 }, { x: 255, y: 255 }] } }), 256], [filter('brightness', { value: 1, blendMode: 'multiply' }), 8]]) {
    const layer = fake(1, 1, { filters: [entry] });
    assert.equal(denseSourceAuxiliaryBytes(layer), bytes); assert.equal(estimateDenseLeafBytes(layer, 1), 12 + bytes);
  }
  assert.equal(denseGlobalBytes(base({ type: 'adjustment', kind: 'median', value: 3 }), 1), 8 + 3264);
  assert.equal(denseGlobalBytes(base({ type: 'adjustment', kind: 'levels', value: 0 }), 1), 4 + 256);
  const q = 1_000_000, group = base({ type: 'group', mode: 'isolated', mask: descriptor(1000, 1000, { feather: 1 }) });
  const clippedBase = fake(1000, 1000, { parentId: group.id, filters: [filter('add_noise', { parameters: { amount: 1, distribution: 'gaussian', monochromatic: true, seed: 7 } })], transforms: [{ type: 'distort', width: 1000, height: 1000, corners: [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }, { x: 0, y: 1000 }] }] });
  const clippedMember = fake(1000, 1000, { parentId: group.id, clipBaseId: clippedBase.id, filters: [filter('median', { value: 3 })], mask: { shape: 'positioned', x: 0, y: 0, sourceWidth: 500, sourceHeight: 600, source: { shape: 'bitmap', width: 500, height: 600, x: 0, y: 0, runs: [0, 300_000, 255], feather: 2, invert: false } } });
  const retainedLegacy = fake(2000, 2000, { visible: false, protected: true, transforms: [{ type: 'crop', x: 0, y: 0, width: 1000, height: 1000 }] });
  const banks = { mode: 'banks', banks: Object.fromEntries(['master', 'red', 'green', 'blue'].map(name => [name, { points: [{ x: 0, y: 0 }, { x: 255, y: 255 }], interpolation: 'linear' }])) };
  const mixed = scene(1000, 1000, [group, clippedBase, clippedMember, retainedLegacy, base({ type: 'adjustment', kind: 'median', value: 3 }), base({ type: 'adjustment', kind: 'curves', value: 0, parameters: banks }), base({ type: 'adjustment', kind: 'color_lookup', value: 0, parameters: { asset: 'c'.repeat(64), bytes: 4 * 1024 * 1024, gridSize: 33, inputSpace: 'srgb', sourceName: 'Authored metadata-only cube' } })]);
  const joined = estimateDenseMaskResources(mixed);
  assert.equal(joined.rootBytes, 6 * q); assert.equal(joined.retainedBytes, 10 * q);
  assert.equal(joined.callbackBytes, 6 * q + 600_000 + 64); assert.equal(joined.sharedBytes, 4096); assert.equal(joined.globalCurvesBytes, 1280);
  assert.equal(joined.leafBytes, 20 * q, 'The hidden legacy retained source exceeds the smaller Distort and median leaves.');
  assert.equal(joined.globalBytes, 3 * 4 * 1024 * 1024 + 24 * 33 ** 3 + 65_536, 'Bounded LUT parsing joins retained callbacks even though it loses the leaf maximum.');
  assert.equal(joined.estimatedWorkingBytes, 42 * q + 600_000 + 64 + 4096 + 1280);
  const strokeN = 16_000_000, strokeGraph = scene(4000, 4000, [fake(4000, 4000)], { selection: descriptor(4000, 4000) });
  for (const feather of [0, 1]) {
    strokeGraph.selection.feather = feather;
    const backing = strokeN + 32, constructor = backing + (feather ? 4 * strokeN : 0);
    // Current sampling aliases target; only All/Below retain another RGBA.
    const current = validateDenseMaskOperation(strokeGraph, { retainedBytes: 4 * strokeN + backing, phases: [11 * strokeN + constructor], additionalWork: (feather ? 8 : 1) * strokeN });
    assert.equal(current.estimatedWorkingBytes, (feather ? 16 : 15) * strokeN + 32);
    assert.throws(() => validateDenseMaskOperation(strokeGraph, { retainedBytes: 8 * strokeN + backing, phases: [15 * strokeN + constructor], additionalWork: (feather ? 8 : 1) * strokeN }), { code: 'LIMIT_EXCEEDED' });
  }
  const family = count => { const group = base({ type: 'group', mode: 'isolated', mask: descriptor(1000, 1000, { feather: 1 }) }); return scene(1000, 1000, [group, ...Array.from({ length: count }, () => fake(1000, 1000, { parentId: group.id, protected: true, outline: { width: 1, color: '#ffffff' } }))]); };
  const ten = family(10), eleven = family(11);
  assert.equal(denseMaskPreparationWork(eleven), 8_000_000);
  assert.equal(denseMaskPreparationWork(ten, { filterContextGraph: ten }), 368_000_000);
  assert.equal(denseMaskPreparationWork(eleven, { filterContextGraph: eleven }), 448_000_000);
  assert.doesNotThrow(() => validateDenseMaskResources(eleven));
  assert.doesNotThrow(() => validateDenseMaskResources(ten, { filterContextGraph: ten }));
  assert.throws(() => validateDenseMaskResources(eleven, { filterContextGraph: eleven }), { code: 'LIMIT_EXCEEDED' });
  const legacy = scene(6000, 4000, [fake(6000, 4000, { effects: { glow: { opacity: 1, blur: 64 } } })]);
  assert.equal(estimateDenseMaskResources(legacy).enabled, false);
  assert.throws(() => validateDenseMaskResources(legacy, { force: true }), { code: 'LIMIT_EXCEEDED' }, 'The first channel producer needs the stronger gate before any dense descriptor exists.');
});

test('Dense admission counts effective sparse legacy shadow and glow defaults before any image or mask I/O', async t => {
  const { native } = await fixture(t), width = 4000, height = 4000, n = width * height;
  const layer = base({ type: 'raster', width, height, asset: 'a'.repeat(64), sourceAsset: 'a'.repeat(64), transforms: [],
    mask: { shape: 'alpha8', asset: 'b'.repeat(64), bytes: n + 32, width, height, x: 0, y: 0, feather: 0, invert: false } });
  const expectedDecoration = 10 * n + 3 * 4052 ** 2; // Default sigma8 =>26 pixels of padding on each side.
  assert.equal(expectedDecoration, 209_256_112);
  const render = native.renderGraph.bind(native);
  await noAssetIO(native, async () => {
    const bare = scene(width, height, [layer]);
    assert.equal(estimateDenseMaskResources(bare).estimatedWorkingBytes, 192_000_064);
    assert.doesNotThrow(() => native.validateGraph(bare), 'The same graph without effective styles is admitted from metadata.');
    for (const effects of [{ shadow: {} }, { glow: {} }, { shadow: { color: '#123456' } }, { glow: { blur: 8 } }, { shadow: {}, glow: {} }]) {
      const candidate = { ...layer, effects }, graph = scene(width, height, [candidate]);
      assert.equal(denseDecorationBytes(candidate, width, height), expectedDecoration, 'Missing opacity/blur use accepted rendering defaults.');
      const estimate = estimateDenseMaskResources(graph);
      assert.equal(estimate.estimatedWorkingBytes, 337_256_176);
      assert.throws(() => native.validateGraph(graph), { code: 'LIMIT_EXCEEDED' });
      await assert.rejects(render(graph), { code: 'LIMIT_EXCEEDED' });
    }
    for (const effects of [undefined, null, {}, { shadow: { opacity: 0 } }, { glow: { opacity: 0 } }]) {
      const candidate = { ...layer, ...(effects === undefined ? {} : { effects }) };
      assert.equal(denseDecorationBytes(candidate, width, height), 0);
      assert.doesNotThrow(() => native.validateGraph(scene(width, height, [candidate])), 'No-style and explicitly disabled-style controls remain admitted.');
    }
    const outline = { ...layer, effects: { shadow: {} }, outline: { width: 1, color: '#ffffff' } };
    assert.equal(denseDecorationBytes(outline, width, height), 15 * n + 20 * height + 8);
    assert.throws(() => native.validateGraph(scene(width, height, [outline])), { code: 'LIMIT_EXCEEDED' });
  });
});

test('Dense typed traversal covers inactive current/history slots, rejects aliases and enforces exact 3GiB and256-reference quotas', () => {
  const make = (i, width, height) => ({ shape: 'alpha8', asset: i.toString(16).padStart(64, '0'), width, height, bytes: width * height + 32, x: 0, y: 0, feather: 0, invert: false });
  const mask = make(1, 2, 3), layer = base({ type: 'raster', width: 2, height: 3, asset: 'a'.repeat(64), sourceAsset: 'a'.repeat(64), transforms: [], visible: false, maskDensity: 0, mask: { shape: 'positioned', sourceWidth: 2, sourceHeight: 3, x: -1, y: 2, source: mask }, filters: { version: 1, entries: [filter('invert', { enabled: false })], mask: { sourceWidth: 2, sourceHeight: 3, coverage: mask, enabled: false, density: 0 } } });
  const graph = scene(2, 3, [layer], { selection: mask, savedSelections: [{ id: randomUUID(), name: 'Shared', mask }] });
  const uses = projectAssetUses(graph); assert.equal(uses.get(mask.asset).length, 4); assert(uses.get(mask.asset).every(use => use.type === 'alpha8'));
  assert.equal(denseMaskHistoryAssets([{ graph }, { graph: structuredClone(graph) }]).size, 1);
  for (const candidate of [{ ...graph, layers: [{ ...layer, asset: mask.asset }] }, { ...graph, selection: { ...mask, width: 3, height: 2 } }, { ...graph, sourceDocument: { asset: mask.asset, bytes: 38, format: 'psd', name: 'Alias.psd' } }]) assert.throws(() => projectAssetUses(candidate), { code: 'INVALID_PROJECT_BUNDLE' });
  assert.throws(() => validateColorLookupHistory([graph, scene(2, 3, [{ ...layer, mask: undefined, filters: undefined, asset: mask.asset }])]), { code: 'INVALID_PROJECT_BUNDLE' });
  const graphs = descriptors => descriptors.map(selection => scene(selection.width, selection.height, [], { selection }));
  const maximum = Array.from({ length: 134 }, (_, i) => make(i + 1, 6000, 4000));
  const exact = [...maximum, make(135, 8192, 637), make(136, 64, 44)];
  assert.equal([...denseMaskHistoryAssets(graphs(exact)).values()].reduce((sum, item) => sum + item.bytes, 0), 3_221_225_472);
  assert.throws(() => denseMaskHistoryAssets(graphs([...maximum, make(135, 8192, 637), make(136, 2817, 1)])), { code: 'LIMIT_EXCEEDED' });
  assert.equal(denseMaskHistoryAssets(graphs(Array.from({ length: 256 }, (_, i) => make(i + 1, 1, 1)))).size, 256);
  assert.throws(() => denseMaskHistoryAssets(graphs(Array.from({ length: 257 }, (_, i) => make(i + 1, 1, 1)))), { code: 'LIMIT_EXCEEDED' });
});

test('Dense preparation invariant shares nested awaits while isolating concurrent operations at the exact work bound', async () => {
  const mask = { shape: 'alpha8', asset: 'd'.repeat(64), bytes: 24_000_032, width: 6000, height: 4000, feather: 1, invert: false, x: 0, y: 0 };
  const exact = () => withMaskPreparationBudget(true, async () => {
    chargeMaskPreparation(mask);
    await Promise.resolve();
    return withMaskPreparationBudget(true, async () => { await Promise.resolve(); chargeMaskPreparation(mask); });
  });
  await Promise.all([exact(), exact()]);
  await assert.rejects(withMaskPreparationBudget(true, async () => {
    await exact();
    await withMaskPreparationBudget(false, async () => chargeMaskPreparation({ ...mask, width: 1, height: 1, bytes: 33, feather: 0 }));
  }), { code: 'LIMIT_EXCEEDED' });
  await exact();
});

test('Dense channel loading preserves independently computed full photo and high-frequency coverage without changing source bytes', async t => {
  const { native } = await fixture(t);
  const photo = await sharp(new URL('./fixtures/tonal-color/astronaut.png', import.meta.url).pathname).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (const [width, height, pixels, channels] of [[512, 512, photo.data, ['luma']], [1024, 1024, highFrequencyRGBA(1024, 1024), ['red', 'luma', 'alpha']]]) {
    const layer = await raster(native, pixels, width, height), original = await fs.readFile(path.join(native.assetsDir, layer.asset));
    let doc = await project(native, width, height, [layer]);
    const composite = await native.renderGraph(graphOf(native, doc));
    for (const channel of channels) {
      const expected = channelPlaneReference(composite, channel);
      assert(runCount(expected) > 200_000, 'This fixture must exercise exact dense fallback.');
      doc = (await edit(native, doc, 'load_channel_selection', { channel })).document;
      assert.equal(doc.selection.shape, 'alpha8'); assert.deepEqual(await storedCoverage(native, doc.selection), expected);
      const before = await files(native.assetsDir), revision = doc.revision;
      const preview = await native.execute('get_channel_preview', { documentId: doc.id, expectedRevision: revision, channel, maxEdge: 32 });
      const actual = await opaqueGray(preview), reduced = Buffer.alloc(preview.width * preview.height);
      for (let y = 0; y < preview.height; y++) for (let x = 0; x < preview.width; x++) reduced[y * preview.width + x] = expected[Math.floor((2 * y + 1) * height / (2 * preview.height)) * width + Math.floor((2 * x + 1) * width / (2 * preview.width))];
      assert.deepEqual(actual, reduced); assert.equal(preview.revision, revision); assert.equal(preview.coveragePolicy, 'composite-byte-alpha-v1');
      assert.deepEqual(await files(native.assetsDir), before); assert.deepEqual(await get(native, doc), doc);
    }
    assert.deepEqual(await fs.readFile(path.join(native.assetsDir, layer.asset)), original);
  }
});

test('Dense consumer preparation retains continuous geometric combination and exact density, feather, inversion and positioned domains', async t => {
  const { native } = await fixture(t);
  const single = await raster(native, Buffer.from([69, 69, 69, 255]), 1, 1);
  let doc = await project(native, 1, 1, [single], { selection: { shape: 'rectangle', x: 0, y: 0, width: 1, height: 1, feather: 3, invert: false } });
  doc = (await edit(native, doc, 'load_channel_selection', { channel: 'red', mode: 'intersect' })).document;
  assert.deepEqual(await storedCoverage(native, doc.selection), Buffer.from([11]));
  assert.notEqual(Math.round(Math.round(255 / 6) * 69 / 255), 11);
  const width = 13, height = 9, alpha = Buffer.from(Array.from({ length: width * height }, (_, i) => i % 7 ? (i * 97 + 3) & 255 : 0));
  const mask = await dense(native, alpha, width, height), layer = await raster(native, highFrequencyRGBA(width, height), width, height);
  for (const feather of [0, 0.1, 2.75]) for (const invert of [false, true]) for (const density of [0, 0.1, 0.375, 1]) {
    const source = { ...mask, feather, invert }, legacy = { ...bitmapMask(alpha, width, height), feather, invert };
    const wrapper = value => ({ shape: 'positioned', sourceWidth: width, sourceHeight: height, x: -2, y: 1, domain: { x: 1, y: 0, width: 9, height: 8 }, source: value });
    const denseLayer = { ...layer, mask: wrapper(source), maskDensity: density }, legacyLayer = { ...layer, mask: wrapper(legacy), maskDensity: density };
    assert.deepEqual(await native.renderGraph(scene(width, height, [denseLayer])), await native.renderGraph(scene(width, height, [legacyLayer])));
    const preparedDoc = await project(native, width, height, [denseLayer]);
    const expected = layerMaskCoverage(legacyLayer), preview = await native.execute('get_mask_preview', { documentId: preparedDoc.id, source: 'layer-mask', layerId: layer.id, maxEdge: 32 });
    assert.deepEqual(await opaqueGray(preview), Buffer.from(Array.from({ length: width * height }, (_, p) => Math.round(255 * expected(p % width, Math.floor(p / width))))));
  }
  // Saved coverage inspection must remain independent of a corrupt RGB asset.
  const scoped = await project(native, width, height, [layer], { selection: mask });
  const file = path.join(native.assetsDir, layer.asset), original = await fs.readFile(file); await fs.writeFile(file, Buffer.from('Unreadable RGB fixture'));
  try { assert.deepEqual(await opaqueGray(await native.execute('get_mask_preview', { documentId: scoped.id, maxEdge: 32 })), alpha); }
  finally { await fs.writeFile(file, original); }
});

test('Dense additional and source-effect masks preserve protected generated clipping, deferred filters, integer geometry and raw Bake', async t => {
  const { native } = await fixture(t), width = 11, height = 7, count = width * height;
  const alpha = Buffer.from(Array.from({ length: count }, (_, p) => (p * 53 + 17) & 255)), descriptor = await dense(native, alpha, width, height, { feather: 1, invert: true });
  const legacy = { ...bitmapMask(alpha, width, height), feather: 1, invert: true };
  const person = await raster(native, Buffer.from(Array.from({ length: count }, (_, p) => [31, 117, 209, p % width >= 3 && p % width <= 5 ? [1, 128, 255][p % 3] : 0]).flat()), width, height, { protected: true, outline: { width: 1, color: '#ffffff' } });
  const group = base({ type: 'group', mode: 'isolated', opacity: 0.7, mask: descriptor });
  const source = await raster(native, highFrequencyRGBA(width, height), width, height, { parentId: group.id });
  const member = await raster(native, Buffer.from(Array.from({ length: count }, () => [29, 157, 71, 177]).flat()), width, height, { parentId: group.id, clipBaseId: source.id, role: 'generated', provenance: { jobId: randomUUID(), mode: 'generate' }, mask: descriptor, maskDensity: 0.375 });
  const scope = coverage => ({ version: 1, entries: [filter(), filter('brightness', { value: 13, blendMode: 'multiply', opacity: 0.5 })], mask: { sourceWidth: width, sourceHeight: height, coverage, enabled: true, density: 0.1 } });
  source.filters = scope(descriptor);
  source.transforms = [{ type: 'distort', width, height, corners: [{ x: 1, y: 0 }, { x: width + 1, y: 0 }, { x: width + 1, y: height }, { x: 1, y: height }] }];
  const denseGraph = scene(width, height, [person, group, source, member]);
  const legacyGraph = structuredClone(denseGraph); legacyGraph.layers[1].mask = legacy; legacyGraph.layers[2].filters = scope(legacy); legacyGraph.layers[3].mask = legacy;
  assert.deepEqual(await native.renderGraph(denseGraph), await native.renderGraph(legacyGraph));
  let doc = await project(native, width, height, denseGraph.layers);
  const preview = await native.execute('get_layer_preview', { documentId: doc.id, layerId: group.id, maxWidth: 32 });
  const oldDoc = await project(native, width, height, legacyGraph.layers), oldPreview = await native.execute('get_layer_preview', { documentId: oldDoc.id, layerId: group.id, maxWidth: 32 });
  assert.deepEqual(Buffer.from(preview.data, 'base64'), Buffer.from(oldPreview.data, 'base64'));
  await noAssetIO(native, () => assert.rejects(edit(native, doc, 'bake_layer_filters', { layerId: source.id }), { code: 'FILTER_BAKE_PROTECTED_CONTEXT' }));
  doc = (await edit(native, doc, 'set_layer_protection', { layerId: person.id, protected: false })).document;
  const originalAsset = source.sourceAsset, beforeSource = await native.renderLayer(source);
  doc = (await edit(native, doc, 'bake_layer_filters', { layerId: source.id })).document;
  const baked = graphOf(native, doc).layers.find(item => item.id === source.id);
  assert.equal(baked.sourceAsset, originalAsset); assert.deepEqual(baked.filters, []);
  assert.deepEqual(await native.renderLayer(baked), beforeSource);
  assert.equal(graphOf(native, doc).layers.find(item => item.id === group.id).mask.asset, descriptor.asset);
});

test('Dense frame publication rolls back real ENOTDIR and late mixed pixel transactions, preserving deduplicated history assets', async t => {
  const { native } = await fixture(t), width = 512, height = 512;
  const pixels = highFrequencyRGBA(width, height); for (let at = 3; at < pixels.length; at += 4) pixels[at] = 255;
  const layer = await raster(native, pixels, width, height);
  let doc = await project(native, width, height, [layer]);
  doc = (await edit(native, doc, 'load_channel_selection', { channel: 'luma' })).document;
  assert.equal(doc.selection.shape, 'alpha8');
  const assets = await files(native.assetsDir), projects = await files(native.projectsDir), directory = native.projectsDir;
  for (const channel of ['luma', 'red']) {
    native.projectsDir = path.join(native.assetsDir, layer.asset);
    try { await assert.rejects(edit(native, doc, 'load_channel_selection', { channel }), { code: 'ENOTDIR' }); }
    finally { native.projectsDir = directory; }
    assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await files(native.assetsDir), assets); assert.deepEqual(await files(native.projectsDir), projects);
  }
  await assert.rejects(edit(native, doc, 'apply_transaction', { operations: [
    { command: 'load_channel_selection', args: { channel: 'red', invert: true } },
    { command: 'paint_stroke', args: { layerId: layer.id, tool: 'brush', color: '#cc5522', size: 3, hardness: 1, opacity: 1, points: [{ x: 3, y: 3 }] } },
    { command: 'set_layer', args: { layerId: randomUUID(), opacity: 0.5 } },
  ] }), { code: 'NOT_FOUND' });
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await files(native.assetsDir), assets); assert.deepEqual(await files(native.projectsDir), projects);
});

test('Dense native descriptor snapshots precede queueing and transaction copying, without invoking accessors', async t => {
  const { native } = await fixture(t), width = 3, height = 2;
  const mask = await dense(native, Buffer.from([0, 1, 128, 255, 37, 199]), width, height), layer = await raster(native, highFrequencyRGBA(width, height), width, height, { filters: [filter()] });
  let doc = await project(native, width, height, [layer]);
  let release; const gate = new Promise(resolve => { release = resolve; });
  const blocked = native.enqueue(() => gate), supplied = { ...mask }, original = structuredClone(supplied);
  const pending = edit(native, doc, 'set_layer_filter_mask', { layerId: layer.id, source: 'mask', mask: supplied });
  supplied.asset = 'f'.repeat(64); supplied.width = 2; supplied.height = 3; supplied.invert = true;
  release(); await blocked; doc = (await pending).document;
  assert.deepEqual(graphOf(native, doc).layers[0].filters.mask.coverage, original);
  let getters = 0;
  for (const key of ['shape', 'width', 'asset', 'feather']) {
    const bad = { ...mask }; Object.defineProperty(bad, key, { enumerable: true, get() { getters++; return mask[key]; } });
    await noAssetIO(native, () => assert.rejects(edit(native, doc, 'set_layer_filter_mask', { layerId: layer.id, source: 'mask', mask: bad })));
    await noAssetIO(native, () => assert.rejects(edit(native, doc, 'apply_transaction', { operations: [
      { command: 'set_layer_filter_mask', args: { layerId: layer.id, source: 'mask', mask: bad } },
      { command: 'bake_layer_filters', args: { layerId: layer.id } },
    ] })));
  }
  const inheritedFields = { ...mask }; delete inheritedFields.shape;
  const inherited = Object.assign(Object.create({ get shape() { getters++; return 'alpha8'; } }), inheritedFields);
  for (const operations of [false, true]) await noAssetIO(native, () => assert.rejects(operations ? edit(native, doc, 'apply_transaction', { operations: [
    { command: 'set_layer_filter_mask', args: { layerId: layer.id, source: 'mask', mask: inherited } },
    { command: 'bake_layer_filters', args: { layerId: layer.id } },
  ] }) : edit(native, doc, 'set_layer_filter_mask', { layerId: layer.id, source: 'mask', mask: inherited })));
  assert.equal(getters, 0); assert.deepEqual(await get(native, doc), doc);
});

test('Dense canonical malformed portable metadata rejects before asset I/O across every inactive mask slot', async t => {
  const { native } = await fixture(t), width = 3, height = 2, mask = await dense(native, Buffer.from([0, 1, 128, 255, 37, 199]), width, height);
  const layer = await raster(native, highFrequencyRGBA(width, height), width, height, { visible: false, maskDensity: 0, mask: { shape: 'positioned', sourceWidth: width, sourceHeight: height, x: 0, y: 0, source: mask }, filters: { version: 1, entries: [filter('invert', { enabled: false })], mask: { sourceWidth: width, sourceHeight: height, coverage: mask, enabled: false, density: 0 } } });
  const control = scene(width, height, [layer], { selection: mask, savedSelections: [{ id: randomUUID(), name: 'Inactive retained coverage', mask }] });
  const valid = await encodeProjectBundle({ graph: control, validateGraph: value => native.validateGraph(value), readAsset: asset => fs.readFile(path.join(native.assetsDir, asset)) });
  const size = valid.readUInt32BE(8), manifest = JSON.parse(valid.subarray(12, 12 + size));
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const forge = graph => { const data = Buffer.from(JSON.stringify(canonical({ ...manifest, graph }))), header = Buffer.from(valid.subarray(0, 12)); header.writeUInt32BE(data.length, 8); return Buffer.concat([header, data, valid.subarray(12 + size)]); };
  assert.deepEqual(decodeProjectBundle(forge(control), { validateGraph: value => native.validateGraph(value) }).graph, control);
  const slots = [graph => graph.selection, graph => graph.savedSelections[0].mask, graph => graph.layers[0].mask.source, graph => graph.layers[0].filters.mask.coverage];
  for (const slot of slots) for (const patch of [{ bytes: mask.bytes + 1 }, { invert: null }, { runs: [] }, { width: 2, height: 3 }]) {
    const graph = structuredClone(control); Object.assign(slot(graph), patch);
    await noAssetIO(native, () => assert.rejects(native.importProject({ data: forge(graph) }), { code: 'INVALID_PROJECT_BUNDLE' }));
  }
  const alias = structuredClone(control); alias.layers[0].asset = mask.asset;
  await noAssetIO(native, () => assert.rejects(native.importProject({ data: forge(alias) }), { code: 'INVALID_PROJECT_BUNDLE' }));
});

test('Dense portable transfer retains current coverage while restart verifies history-only frames', async t => {
  const { native, dataDir } = await fixture(t), width = 7, height = 5, first = await dense(native, Buffer.from(Array.from({ length: width * height }, (_, p) => p * 41 & 255)), width, height);
  const layer = await raster(native, highFrequencyRGBA(width, height), width, height);
  let doc = await project(native, width, height, [layer], { selection: first });
  doc = (await edit(native, doc, 'save_selection', { name: 'Original exact coverage' })).document;
  doc = (await edit(native, doc, 'load_channel_selection', { channel: 'alpha', invert: true })).document;
  doc = (await edit(native, doc, 'delete_selection', { selectionId: doc.savedSelections[0].id })).document;
  const bundle = await native.exportProject({ documentId: doc.id, expectedRevision: doc.revision });
  const { native: other } = await fixture(t), transferred = (await other.importProject({ data: bundle.data })).document;
  assert.deepEqual(graphOf(other, transferred), graphOf(native, doc)); assert.equal((await fs.readdir(other.assetsDir)).includes(first.asset), false);
  assert.deepEqual(await storedCoverage(other, transferred.selection), await storedCoverage(native, doc.selection));
  const restarted = await new NativeBackend({ dataDir }).init(); t.after(() => restarted.close()); assert.deepEqual(await get(restarted, doc), doc);
  const file = path.join(native.assetsDir, first.asset), original = await fs.readFile(file); await fs.writeFile(file, Buffer.alloc(original.length));
  try { const rejected = await new NativeBackend({ dataDir }).init(); t.after(() => rejected.close()); assert.equal(rejected.projects.has(doc.id), false); assert.equal(rejected.loadWarnings.length, 1); }
  finally { await fs.writeFile(file, original); }
  assert.deepEqual(await get(native, doc), doc);
});

test('Dense native activation, first-channel admission and canvas final-frame projection refuse before I/O', async t => {
  const { native } = await fixture(t);
  const descriptor = (width, height, extra = {}) => ({ shape: 'alpha8', asset: 'b'.repeat(64), bytes: width * height + 32, width, height, x: 0, y: 0, feather: 0, invert: false, ...extra });
  const fake = (width, height, extra = {}) => base({ type: 'raster', width, height, asset: 'a'.repeat(64), sourceAsset: 'a'.repeat(64), transforms: [], ...extra });
  const width = 8192, height = 2731, layer = fake(width, height, { mask: descriptor(width, height), maskDensity: 0 });
  const doc = await project(native, width, height, [layer]);
  await noAssetIO(native, () => assert.rejects(edit(native, doc, 'modify_layer_mask', { layerId: layer.id, density: 1 }), { code: 'LIMIT_EXCEEDED' }));
  assert.deepEqual(await get(native, doc), doc);
  const oversized = await project(native, 6000, 4000, [fake(6000, 4000, { effects: { glow: { color: '#ffffff', opacity: 1, blur: 64 } } })]);
  for (const command of ['load_channel_selection', 'get_channel_preview']) await noAssetIO(native, () => assert.rejects(edit(native, oversized, command, { channel: 'luma', ...(command === 'get_channel_preview' ? { maxEdge: 32 } : {}) }), { code: 'LIMIT_EXCEEDED' }));
  const empty = await project(native, 6000, 4000, [], { selection: descriptor(6000, 4000) });
  await noAssetIO(native, () => assert.rejects(edit(native, empty, 'paint_stroke', { tool: 'brush', color: '#cc5522', size: 3, hardness: 1, opacity: 1, points: [{ x: 3, y: 3 }] }), { code: 'LIMIT_EXCEEDED' }));
  assert.deepEqual(await get(native, empty), empty);
  const small = await project(native, 1, 1, [fake(1, 1, { mask: descriptor(1, 1) })]);
  const graph = graphOf(native, small);
  await noAssetIO(native, async () => assert.doesNotThrow(() => native.preflightMaskCanvas(graph, { type: 'resize', width: 8192, height: 2730 })));
  await noAssetIO(native, () => assert.rejects(edit(native, small, 'resize_document', { width: 8192, height: 2731 }), { code: 'LIMIT_EXCEEDED' }));
  assert.deepEqual(await get(native, small), small);
  assert.deepEqual(await fs.readdir(native.assetsDir), [], 'All admitted source projects were metadata-only; no asset was read or published.');
});

test('Dense serial canvas transformation rolls back later mask and final commit failures while preserving reused assets', async t => {
  const { native } = await fixture(t), width = 512, height = 512, newWidth = 514, newHeight = 513;
  const planes = Array.from({ length: 4 }, (_, k) => Buffer.from(Array.from({ length: width * height }, (_, i) => 1 + (i * (73 + 2 * k) + 61 * k) % 255)));
  const masks = await Promise.all(planes.map(alpha => dense(native, alpha, width, height)));
  const a = await raster(native, highFrequencyRGBA(width, height), width, height, { mask: masks[0] }), b = { ...a, id: randomUUID(), mask: masks[1] };
  let doc = await project(native, width, height, [a, b], { selection: masks[2], savedSelections: [{ id: randomUUID(), name: 'Fourth serial mask', mask: masks[3] }] });
  const padded = planes.map(alpha => { const output = Buffer.alloc(newWidth * newHeight); for (let y = 0; y < height; y++) alpha.copy(output, y * newWidth, y * width, (y + 1) * width); return output; });
  const deduplicated = await dense(native, padded[0], newWidth, newHeight);
  const assets = await files(native.assetsDir), projects = await files(native.projectsDir), originalRead = native.readDenseMask, originalStore = native.storeAsset;
  let reads = 0, stores = 0;
  native.readDenseMask = function (mask) { if (++reads === 3) throw Object.assign(new Error('Independent third-mask failure'), { code: 'CORRUPT_ASSET' }); return originalRead.call(this, mask); };
  native.storeAsset = function (...args) { stores++; return originalStore.apply(this, args); };
  try { await assert.rejects(edit(native, doc, 'resize_canvas', { width: newWidth, height: newHeight, anchor: 'top-left' }), { code: 'CORRUPT_ASSET' }); }
  finally { native.readDenseMask = originalRead; native.storeAsset = originalStore; }
  assert.equal(reads, 3); assert.equal(stores, 2, 'Two serial frames reached storage before the later reader failed.');
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await files(native.assetsDir), assets); assert.deepEqual(await files(native.projectsDir), projects);
  const directory = native.projectsDir; native.projectsDir = path.join(native.assetsDir, a.asset);
  try { await assert.rejects(edit(native, doc, 'resize_canvas', { width: newWidth, height: newHeight, anchor: 'top-left' }), { code: 'ENOTDIR' }); }
  finally { native.projectsDir = directory; }
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await files(native.assetsDir), assets); assert.deepEqual(await files(native.projectsDir), projects);
  doc = (await edit(native, doc, 'resize_canvas', { width: newWidth, height: newHeight, anchor: 'top-left' })).document;
  const graph = graphOf(native, doc), outputMasks = [graph.layers[0].mask, graph.layers[1].mask, graph.selection, graph.savedSelections[0].mask];
  for (let i = 0; i < outputMasks.length; i++) assert.deepEqual(await storedCoverage(native, outputMasks[i]), padded[i]);
  assert.equal(outputMasks[0].asset, deduplicated.asset); assert.equal(graph.layers[0].sourceAsset, a.sourceAsset);
});
