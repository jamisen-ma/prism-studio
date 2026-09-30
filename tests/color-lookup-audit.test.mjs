import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { parseColorLookupBytes, validateColorLookupBytes, prepareColorLookup, colorLookupCacheBytes, validateColorLookupPreparation } from '../server/color-lookup.mjs';
import { projectAssetUses, validateColorLookupHistory } from '../server/lookup-assets.mjs';
import { estimateColorLookupResources, validateColorLookupResources, validateColorLookupGlobalBytes } from '../server/color-lookup-resources.mjs';
import { estimateFilterBakeBytes } from '../server/filter-bake.mjs';
import { encodeProjectBundle, decodeProjectBundle } from '../server/project-bundle.mjs';
import { AUTHORED_LOOKUP_NAMES, AUTHORED_LOOKUP_GOLDENS, authoredCube, authoredLookupGolden, malformedAuthoredCubes } from './fixtures/color-lookup/reference.mjs';

const cap = 256 * 1024 * 1024, maxFile = 4 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const base = extra => ({ id: randomUUID(), name: 'Independent Color Lookup audit', visible: true, opacity: 1, blendMode: 'normal', ...extra });
const descriptor = (name = 'identity', gridSize = 2) => { const bytes = authoredCube(name, { gridSize }); return { asset: hash(bytes), bytes: bytes.length, gridSize, inputSpace: 'srgb', sourceName: `${name}.cube`, title: `Prism authored ${name}` }; };
const filter = (parameters = descriptor(), extra = {}) => ({ id: randomUUID(), kind: 'color_lookup', value: 0, enabled: true, opacity: 1, parameters, ...extra });
const grade = (parameters = descriptor(), extra = {}) => base({ type: 'adjustment', kind: 'color_lookup', value: 0, parameters, ...extra });
const fake = (width, height, extra = {}) => base({ type: 'raster', width, height, asset: 'a'.repeat(64), sourceAsset: 'a'.repeat(64), transforms: [], ...extra });
const scene = (width, height, layers, extra = {}) => ({ name: 'Color Lookup audit', width, height, selection: null, layers, ...extra });
const bitmap = (width, height, extra = {}) => ({ shape: 'bitmap', x: 0, y: 0, width, height, runs: [0, width * height, 255], feather: 0, invert: false, ...extra });
const get = async (native, doc) => (await native.execute('get_document', { documentId: doc.id })).document;
const edit = (native, doc, command, args = {}) => native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...(command === 'apply_transaction' ? { label: 'Color Lookup audit' } : {}), ...args });
const graphOf = (native, doc) => { const p = native.projects.get(doc.id); return structuredClone(p.states[p.cursor].graph); };
const files = async directory => Object.fromEntries(await Promise.all((await fs.readdir(directory)).sort().map(async name => [name, await fs.readFile(path.join(directory, name))])));
const imported = (name = 'identity', extra = {}) => ({ target: 'adjustment', data: authoredCube(name).toString('base64'), sourceName: `${name}.cube`, inputSpace: 'srgb', ...extra });
const half = (n, d) => Number((2n * BigInt(n) + BigInt(d)) / (2n * BigInt(d)));
const image = (w, h) => Buffer.from(Array.from({ length: w * h }, (_, p) => [(p * 37 + 13) % 256, (p * 73 + 19) % 256, (p * 113 + 127) % 256, [0, 1, 128, 255][p % 4]]).flat());
async function fixture(t) { const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-color-lookup-audit-')); const native = await new NativeBackend({ dataDir, segmentSubject: () => assert.fail('No provider for Color Lookup') }).init(); t.after(async () => { await native.close(); await fs.rm(dataDir, { recursive: true, force: true }); }); return { native, dataDir }; }
async function project(native, width, height, layers, extra = {}) { return (await native.newProject(scene(width, height, layers, extra), 'Independent fixture')).document; }
async function raster(native, rgba, width, height, extra = {}) { const asset = await native.storeAsset(await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer()); return fake(width, height, { asset, sourceAsset: asset, ...extra }); }
async function noAssetIO(native, operation) {
  const restores = [], calls = [];
  for (const key of ['render', 'renderGraph', 'renderLayer', 'readAlpha', 'storeAlpha', 'storeAsset', 'readProjectAsset', 'validateProjectAsset', 'segmentSubject']) { const old = native[key]; native[key] = () => { calls.push(key); assert.fail(`Unexpected ${key}`); }; restores.push(() => { native[key] = old; }); }
  for (const key of ['readFile', 'writeFile', 'open', 'rename', 'link', 'unlink', 'mkdir', 'stat']) { const old = fs[key]; fs[key] = () => { calls.push(`fs.${key}`); assert.fail(`Unexpected fs.${key}`); }; restores.push(() => { fs[key] = old; }); }
  try { return await operation(); } finally { restores.reverse().forEach(restore => restore()); assert.deepEqual(calls, [], 'A swallowed I/O failure is not a valid preflight rejection.'); }
}
function noTables(operation) {
  const originals = [globalThis.Float64Array, globalThis.Uint8Array], calls = [];
  for (const [i, name] of ['Float64Array', 'Uint8Array'].entries()) globalThis[name] = new Proxy(originals[i], { construct(target, args, newTarget) { if (typeof args[0] === 'number' && args[0] >= 512) { calls.push([name, args[0]]); assert.fail('Metadata must not allocate a table or pixel plane.'); } return Reflect.construct(target, args, newTarget); } });
  try { return operation(); } finally { [globalThis.Float64Array, globalThis.Uint8Array] = originals; assert.deepEqual(calls, []); }
}

test('Color Lookup actual private sampler matches independent authored closed forms, original files and half boundaries', async () => {
  for (const name of AUTHORED_LOOKUP_NAMES) {
    assert.deepEqual(await fs.readFile(new URL(`./fixtures/color-lookup/${name}-2.cube`, import.meta.url)), authoredCube(name));
    for (const gridSize of [2, 3, 5, 9, 17, 33]) {
      const bytes = authoredCube(name, { gridSize }), before = Buffer.from(bytes), parsed = await parseColorLookupBytes(bytes);
      assert.deepEqual(Object.keys(parsed).sort(), ['gridSize', 'title', 'transform']);
      assert.deepEqual(Object.keys(parsed.transform), []); assert.equal(parsed.gridSize, gridSize);
      for (let c = 0; c < 256; c++) {
        const rgb = [c, (c * 73 + 11) % 256, (c * 199 + 61) % 256];
        assert.deepEqual(parsed.transform(...rgb), authoredLookupGolden(name, rgb));
      }
      assert.deepEqual(bytes, before);
      const first = parsed.transform(13, 127, 253), second = parsed.transform(13, 127, 253);
      assert.notEqual(first, second); first.fill(0); assert.deepEqual(second, authoredLookupGolden(name, [13, 127, 253]));
      bytes.fill(0); assert.deepEqual(parsed.transform(13, 127, 253), second, 'No caller bytes are retained as mutable table storage.');
    }
  }
  for (const { name, rgb, expected } of AUTHORED_LOOKUP_GOLDENS) assert.deepEqual((await parseColorLookupBytes(authoredCube(name))).transform(...rgb), expected);
});

test('Color Lookup strict decimal grammar, descriptor preallocation checks and bounded TITLE preserve literal ownership', async () => {
  for (const { name, bytes } of malformedAuthoredCubes()) await assert.rejects(parseColorLookupBytes(bytes), undefined, name);
  const original = authoredCube('identity').toString(), replaceTitle = title => Buffer.from(original.replace('TITLE "Prism authored identity"', `TITLE "${title}"`));
  for (const title of ['', ' # Literal hash ', '🌈'.repeat(100), 'x'.repeat(200)]) {
    const bytes = replaceTitle(title), parsed = await parseColorLookupBytes(bytes, { expected: { bytes: bytes.length, gridSize: 2, title } });
    assert.equal(parsed.title, title); assert.equal(parsed.title.length, title.length);
  }
  for (const title of ['🌈'.repeat(101), 'x'.repeat(201)]) await assert.rejects(parseColorLookupBytes(replaceTitle(title)));
  for (const token of ['-0', '5e-324', '3e-324', '.999999999999999999', `0.${'0'.repeat(61)}1`]) await parseColorLookupBytes(Buffer.from(original.replace('\n0 0 0\n', `\n${token} 0 0\n`)));
  for (const token of ['1.0', '10e-1', '+0001.00', '.01e2']) await parseColorLookupBytes(Buffer.from(original.replace('DOMAIN_MAX 1 1 1', `DOMAIN_MAX ${token} 1 1`)));
  const largeGrid = authoredCube('identity', { gridSize: 33 }), old = globalThis.Float64Array; let allocations = 0;
  globalThis.Float64Array = new Proxy(old, { construct() { allocations++; assert.fail('Mismatched expected grid must reject before table allocation.'); } });
  try { await assert.rejects(parseColorLookupBytes(largeGrid, { expected: { bytes: largeGrid.length, gridSize: 2, title: 'Prism authored identity' } })); }
  finally { globalThis.Float64Array = old; assert.equal(allocations, 0); }
  const bytes = Buffer.alloc(maxFile, 32), prefix = authoredCube('identity'); prefix.copy(bytes); let at = prefix.length, yields = 0;
  while (at < bytes.length) { const end = Math.min(at + 4097, bytes.length); bytes[at] = 35; if (end < bytes.length) bytes[end - 1] = 10; at = end; }
  const result = await parseColorLookupBytes(bytes, { yieldFn: async () => { yields++; } });
  assert.ok(yields >= 60); assert.deepEqual(result.transform(13, 127, 253), [13, 127, 253]);
  await assert.rejects(parseColorLookupBytes(Buffer.concat([bytes, Buffer.from(' ')])), { code: 'LIMIT_EXCEEDED' });
});

test('Color Lookup prepared resolver snapshots descriptor, verifies immutable original and keeps tables private', async () => {
  const bytes = authoredCube('cross-products', { gridSize: 33 }), p = descriptor('cross-products', 33), pristine = structuredClone(p);
  let finish, called; const waiting = new Promise(resolve => { finish = resolve; });
  const pending = prepareColorLookup(p, async (...args) => { called = args; await waiting; return bytes; });
  p.asset = 'b'.repeat(64); p.gridSize = 2; p.title = 'Changed while queued'; finish();
  const transform = await pending;
  assert.deepEqual(called, [pristine.asset, { maxBytes: pristine.bytes }]); assert.deepEqual(Object.keys(transform), []);
  assert.deepEqual(transform(128, 64, 192), [32, 16, 96]);
  assert.deepEqual(await validateColorLookupBytes(bytes, pristine), { gridSize: 33, title: pristine.title });
  await assert.rejects(prepareColorLookup(pristine));
  await assert.rejects(prepareColorLookup(pristine, async () => bytes.subarray(1)), { code: 'INVALID_PROJECT_BUNDLE' });
  const corrupt = Buffer.from(bytes); corrupt[corrupt.length - 2] ^= 1;
  await assert.rejects(prepareColorLookup(pristine, async () => corrupt), { code: 'INVALID_PROJECT_BUNDLE' });
  await assert.rejects(validateColorLookupBytes(corrupt, pristine), { code: 'INVALID_PROJECT_BUNDLE' });
  bytes.fill(0); assert.deepEqual(transform(128, 64, 192), [32, 16, 96]);
});

test('Color Lookup typed walker preserves every role, masked and inactive reference and exact history aggregate', () => {
  const p = descriptor(), global = grade(p, { opacity: 0, visible: false }), source = fake(1, 1, { filters: { version: 1, entries: [filter({ ...p, sourceName: 'Another display name.cube' }, { enabled: false })], mask: { sourceWidth: 1, sourceHeight: 1, enabled: false, density: 0, coverage: { shape: 'rectangle', x: 0, y: 0, width: 1, height: 1, feather: 0, invert: false } } } });
  const graph = scene(1, 1, [source, global]), uses = projectAssetUses(graph);
  assert.equal(uses.get(p.asset).length, 2); assert.equal(uses.get('a'.repeat(64)).length, 2);
  assert.equal(validateColorLookupHistory([{ graph }, { graph: structuredClone(graph) }]).size, 1);
  for (const replacement of [{ ...p, bytes: p.bytes + 1 }, { ...p, gridSize: 3 }, { ...p, title: '' }]) assert.throws(() => projectAssetUses(scene(1, 1, [global, grade(replacement)])), { code: 'INVALID_PROJECT_BUNDLE' });
  for (const layers of [[fake(1, 1, { asset: p.asset }), global], [global, fake(1, 1, { asset: p.asset })]]) assert.throws(() => projectAssetUses(scene(1, 1, layers)), { code: 'INVALID_PROJECT_BUNDLE' });
  assert.throws(() => projectAssetUses(scene(1, 1, [global], { sourceDocument: { asset: p.asset, format: 'psd', bytes: 26, name: 'Original.psd' } })), { code: 'INVALID_PROJECT_BUNDLE' });
  assert.throws(() => validateColorLookupHistory([scene(1, 1, [global]), scene(1, 1, [fake(1, 1, { asset: p.asset })])]), { code: 'INVALID_PROJECT_BUNDLE' });
  const states = (count, bytes) => Array.from({ length: count }, (_, i) => ({ graph: scene(1, 1, [grade({ ...p, asset: hash(Buffer.from(`Unique lookup ${i}`)), bytes }, { opacity: 0 })]) }));
  noTables(() => {
    assert.equal(validateColorLookupHistory(states(16, maxFile)).size, 16);
    assert.throws(() => validateColorLookupHistory(states(17, maxFile)), { code: 'LIMIT_EXCEEDED' });
    assert.equal(validateColorLookupHistory(states(128, 1)).size, 128);
    assert.throws(() => validateColorLookupHistory(states(129, 1)), { code: 'LIMIT_EXCEEDED' });
    const repeated = Array.from({ length: 100 }, () => ({ graph })); assert.equal(validateColorLookupHistory(repeated).size, 1);
  });
});

test('Color Lookup joint graph phase rejects separately passing root/group/mask peaks and keeps sequential Bake maxima', () => {
  const p = { ...descriptor('identity', 33), bytes: maxFile }, table = 24 * 33 ** 3 + 512, preparation = 3 * maxFile + 24 * 33 ** 3 + 65536;
  noTables(() => {
    assert.equal(colorLookupCacheBytes(p), 13510936);
    assert.equal(validateColorLookupPreparation(Array.from({ length: 8 }, () => filter(p))), 32 * 1024 * 1024);
    assert.throws(() => validateColorLookupPreparation(Array.from({ length: 9 }, () => filter(p))), { code: 'LIMIT_EXCEEDED' });
    assert.equal(validateColorLookupPreparation([filter(p, { enabled: false }), filter(p, { opacity: 0 })]), 0);
    const n = 4096 ** 2, group = base({ type: 'group', mode: 'isolated' }), layer = grade(p, { parentId: group.id, mask: bitmap(4096, 4096, { feather: 1 }) });
    assert.equal(5 * n + 6 * n + 4 * n + table, 252521240); assert.ok(5 * n + 6 * n + 4 * n + table < cap);
    assert.equal(validateColorLookupGlobalBytes(layer, 4096, 4096), 235744024);
    const joint = estimateColorLookupResources(scene(4096, 4096, [group, layer]));
    assert.equal(joint.estimatedWorkingBytes, 353184536); assert.throws(() => validateColorLookupResources(scene(4096, 4096, [group, layer])), { code: 'LIMIT_EXCEEDED' });
    for (const [height, expected, accepted] of [[2041, 268380952, true], [2042, 268512024, false]]) {
      const graph = scene(8192, height, [grade(p, { mask: bitmap(8192, height, { feather: 1 }) })]);
      assert.equal(estimateColorLookupResources(graph).estimatedWorkingBytes, expected);
      if (accepted) validateColorLookupResources(graph); else assert.throws(() => validateColorLookupResources(graph), { code: 'LIMIT_EXCEEDED' });
    }
    assert.equal(validateColorLookupResources(scene(6000, 4000, [fake(6000, 4000), grade(p)])).estimatedWorkingBytes, 240863000);
    const noise = { id: randomUUID(), kind: 'add_noise', value: 0, parameters: { amount: 5, distribution: 'gaussian', monochromatic: true, seed: 0 }, enabled: true, opacity: 1 };
    const reserved = scene(6000, 4000, [fake(6000, 4000), fake(1, 1, { filters: [noise] }), fake(1, 1, { filters: [structuredClone(noise)] }), grade(p), base({ type: 'adjustment', kind: 'curves', value: 0, parameters: { mode: 'banks' } })]);
    const joined = validateColorLookupResources(reserved);
    assert.equal(joined.sharedBytes, 4096); assert.equal(joined.globalCurvesBytes, 1280);
    assert.equal(joined.estimatedWorkingBytes, 240863000 + 4096 + 1280, 'Other leaves reserve one shared noise table; global banks remain live beside LUT phases.');
    const near = scene(8192, 2041, [grade(p, { mask: bitmap(8192, 2041, { feather: 1 }) })]);
    near.layers.push(fake(1, 1, { mask: { shape: 'positioned', sourceWidth: 300, sourceHeight: 100, x: 0, y: 0, source: bitmap(300, 100) } }));
    assert.equal(estimateColorLookupResources(near).estimatedWorkingBytes, 268380952 + 60000);
    assert.throws(() => validateColorLookupResources(near), { code: 'LIMIT_EXCEEDED' });
    const legacy = fake(6000, 4000, { protected: true, visible: false, transforms: [{ type: 'resize', width: 6000, height: 4000 }, { type: 'resize', width: 6000, height: 4000 }, { type: 'crop', x: 0, y: 0, width: 1, height: 1 }] });
    const hidden = scene(1, 1, [legacy, grade(p)]);
    assert.equal(estimateColorLookupResources(hidden).estimatedWorkingBytes, 288000006);
    assert.throws(() => validateColorLookupResources(hidden), { code: 'LIMIT_EXCEEDED' });
    const pixels = 8000000, encoded = cap - 17 * pixels - preparation - 65536, filters = [filter(p)];
    const bake = estimateFilterBakeBytes({ width: 4000, height: 2000, hasAlpha: true, encodedWorkingBytes: 70000000, encodedAlphaBytes: encoded - 70000000, filters });
    assert.equal(bake.filterBytes, cap); assert.equal(bake.estimatedWorkingBytes, cap);
    const over = estimateFilterBakeBytes({ width: 4000, height: 2000, hasAlpha: true, encodedWorkingBytes: 70000001, encodedAlphaBytes: encoded - 70000000, filters });
    assert.equal(over.estimatedWorkingBytes, cap + 1);
  });
});

test('Color Lookup actual activation and retained-history refusals occur before image, asset or publication I/O', async t => {
  const { native } = await fixture(t), dormant = filter(descriptor(), { enabled: false }), layer = fake(6500, 2000, { filters: [dormant] });
  const doc = await project(native, 6500, 2000, [layer]);
  await noAssetIO(native, () => assert.rejects(edit(native, doc, 'update_layer_filter', { layerId: layer.id, filterId: dormant.id, enabled: true }), { code: 'LIMIT_EXCEEDED' }));
  assert.deepEqual(await get(native, doc), doc);
  const group = base({ type: 'group', mode: 'isolated' }), lookup = grade({ ...descriptor('identity', 33), bytes: maxFile }, { parentId: group.id, opacity: 0, mask: bitmap(4096, 4096, { feather: 1 }) });
  const global = await project(native, 4096, 4096, [group, lookup]);
  await noAssetIO(native, () => assert.rejects(edit(native, global, 'set_layer', { layerId: lookup.id, opacity: 1 }), { code: 'LIMIT_EXCEEDED' }));
  assert.deepEqual(await get(native, global), global);
  const originals = Array.from({ length: 16 }, (_, i) => grade({ ...descriptor(), asset: hash(Buffer.from(`History maximum ${i}`)), bytes: maxFile }, { opacity: 0 }));
  const history = await project(native, 1, 1, originals);
  await noAssetIO(native, () => assert.rejects(edit(native, history, 'import_color_lookup', imported('rgb-cycle')), { code: 'LIMIT_EXCEEDED' }));
  assert.deepEqual(await get(native, history), history);
  assert.deepEqual(await fs.readdir(native.assetsDir), []);
});

test('Color Lookup actual source/global alpha and sequential blend/mask stages precede Distort and exact Bake', async t => {
  const { native } = await fixture(t), w = 9, h = 7, input = image(w, h), alpha = Buffer.from(Array.from({ length: w * h }, (_, p) => [255, 128, 1, 0, 199][p % 5]));
  const raw = Array.from({ length: w * h }, (_, p) => p * 53 % 256), coverage = bitmap(w, h, { runs: raw.flatMap((v, p) => v ? [p, 1, v] : []), invert: true });
  const source = await raster(native, input, w, h, { alphaAsset: await native.storeAlpha(alpha, w, h), mask: { shape: 'positioned', sourceWidth: w, sourceHeight: h, x: 1, y: -1, source: { shape: 'ellipse', x: 1, y: 1, width: 5, height: 4, feather: 1.2, invert: true } }, maskDensity: .5 });
  let doc = await project(native, w, h, [source], { selection: { shape: 'rectangle', x: 0, y: 0, width: 1, height: 1, feather: 0, invert: false } });
  let result = await edit(native, doc, 'import_color_lookup', imported('rgb-cycle', { target: 'layer-filter', layerId: source.id })); doc = result.document;
  doc = (await edit(native, doc, 'update_layer_filter', { layerId: source.id, filterId: result.filterId, opacity: .625 })).document;
  result = await edit(native, doc, 'import_color_lookup', imported('cross-products', { target: 'layer-filter', layerId: source.id })); doc = result.document;
  doc = (await edit(native, doc, 'update_layer_filter', { layerId: source.id, filterId: result.filterId, opacity: .5, blendMode: 'multiply' })).document;
  doc = (await edit(native, doc, 'set_layer_filter_mask', { layerId: source.id, source: 'mask', mask: coverage })).document;
  doc = (await edit(native, doc, 'modify_layer_filter_mask', { layerId: source.id, density: .1 })).document;
  doc = (await edit(native, doc, 'add_layer_distort', { layerId: source.id, corners: [[1, 0], [w + 1, 0], [w + 1, h], [1, h]].map(([x, y]) => ({ x, y })) })).document;
  const wanted = Buffer.from(input);
  for (let p = 0; p < w * h; p++) {
    wanted[p * 4 + 3] = half(input[p * 4 + 3] * alpha[p], 255); if (!wanted[p * 4 + 3]) continue;
    const original = [...input.subarray(p * 4, p * 4 + 3)], a = authoredLookupGolden('rgb-cycle', original), first = original.map((c, i) => Math.round(c + (a[i] - c) * .625));
    const b = authoredLookupGolden('cross-products', first), second = first.map((c, i) => half(255 * c + c * b[i], 510)), effective = Math.round(255 - .1 * raw[p]);
    for (let c = 0; c < 3; c++) wanted[p * 4 + c] = half(original[c] * (255 - effective) + second[c] * effective, 255);
  }
  const previous = graphOf(native, doc).layers[0]; assert.deepEqual(await native.renderLayer({ ...previous, transforms: [] }), wanted);
  const shifted = Buffer.alloc(input.length); for (let y = 0; y < h; y++) wanted.copy(shifted, (y * w + 1) * 4, y * w * 4, (y * w + w - 1) * 4);
  assert.deepEqual(await native.renderLayer(previous), shifted);
  const global = grade(descriptor('rgb-cycle'), { opacity: .625 }), globalExpected = Buffer.from(input);
  for (let p = 0; p < w * h; p++) if (input[p * 4 + 3]) { const a = authoredLookupGolden('rgb-cycle', [...input.subarray(p * 4, p * 4 + 3)]); for (let c = 0; c < 3; c++) globalExpected[p * 4 + c] = Math.round(input[p * 4 + c] + (a[c] - input[p * 4 + c]) * .625); }
  assert.deepEqual(await native.applyAdjustment(input, w, h, global), globalExpected, 'The new global kind preserves hidden RGB as well as alpha.');
  const assets = await files(native.assetsDir), appearance = await native.renderGraph(graphOf(native, doc));
  doc = (await edit(native, doc, 'bake_layer_filters', { layerId: source.id })).document;
  const baked = graphOf(native, doc).layers[0], bakedBytes = await sharp(await fs.readFile(path.join(native.assetsDir, baked.asset))).ensureAlpha().raw().toBuffer();
  for (let p = 0; p < w * h; p++) { assert.deepEqual(bakedBytes.subarray(p * 4, p * 4 + 3), wanted.subarray(p * 4, p * 4 + 3)); assert.equal(bakedBytes[p * 4 + 3], input[p * 4 + 3]); }
  for (const key of Object.keys(previous).filter(k => !['asset', 'filters'].includes(k))) assert.deepEqual(baked[key], previous[key]);
  assert.deepEqual(baked.filters, []); assert.equal(doc.layers[0].filterMask, undefined); assert.deepEqual(await native.renderGraph(graphOf(native, doc)), appearance);
  for (const [name, bytes] of Object.entries(assets)) assert.deepEqual(await fs.readFile(path.join(native.assetsDir, name)), bytes);
});

test('Color Lookup generated clipping and isolated groups preserve protected context and source inspection', async t => {
  const { native } = await fixture(t), w = 9, h = 7, count = w * h;
  const personBytes = Buffer.from(Array.from({ length: count }, (_, p) => [31, 117, 209, p % w >= 3 && p % w <= 5 ? [1, 128, 255][p % 3] : 0]).flat());
  const person = await raster(native, personBytes, w, h, { protected: true, outline: { width: 1, color: '#ffffff' } }), group = base({ type: 'group', mode: 'isolated', opacity: .7 });
  const sourceBytes = image(w, h); for (let p = 0; p < count; p++) sourceBytes[p * 4 + 3] = 255;
  const source = await raster(native, sourceBytes, w, h, { parentId: group.id }), memberBytes = Buffer.from(Array.from({ length: count }, () => [29, 157, 71, 177]).flat());
  const member = await raster(native, memberBytes, w, h, { parentId: group.id, clipBaseId: source.id, role: 'generated', provenance: { jobId: randomUUID(), mode: 'generate' }, visible: false });
  let doc = await project(native, w, h, [person, group, source, member]); const baseline = await native.renderGraph(graphOf(native, doc)), footprint = await native.protectedPixels(graphOf(native, doc));
  for (const layerId of [source.id, member.id]) doc = (await edit(native, doc, 'import_color_lookup', imported('cross-products', { target: 'layer-filter', layerId }))).document;
  doc = (await edit(native, doc, 'set_layer', { layerId: member.id, visible: true })).document;
  const actual = await native.renderGraph(graphOf(native, doc)); let changed = 0;
  const preview = async (layerId, view = 'layer') => { const r = await native.execute('get_layer_preview', { documentId: doc.id, layerId, view, maxWidth: 32 }); return sharp(Buffer.from(r.data, 'base64')).ensureAlpha().raw().toBuffer(); };
  const sourceView = await preview(source.id), memberView = await preview(member.id);
  for (let p = 0; p < count; p++) if (footprint[p]) { assert.deepEqual(actual.subarray(p * 4, p * 4 + 4), baseline.subarray(p * 4, p * 4 + 4)); assert.deepEqual(sourceView.subarray(p * 4, p * 4 + 3), sourceBytes.subarray(p * 4, p * 4 + 3)); assert.equal(memberView[p * 4 + 3], 0); } else if (!actual.subarray(p * 4, p * 4 + 4).equals(baseline.subarray(p * 4, p * 4 + 4))) changed++;
  assert.ok(changed > 0); assert.deepEqual(await preview(member.id, 'source'), memberBytes);
  const assets = await files(native.assetsDir);
  await noAssetIO(native, () => assert.rejects(edit(native, doc, 'import_color_lookup', imported('identity', { target: 'layer-filter', layerId: person.id })), { code: 'PROTECTED_LAYER' }));
  await noAssetIO(native, () => assert.rejects(edit(native, doc, 'bake_layer_filters', { layerId: source.id }), { code: 'FILTER_BAKE_PROTECTED_CONTEXT' }));
  assert.deepEqual(await files(native.assetsDir), assets);
});

test('Color Lookup canonical malformed portable and recipe metadata rejects before assets, with a valid control', async t => {
  const { native } = await fixture(t), source = await raster(native, image(8, 6), 8, 6), doc = await project(native, 8, 6, [source]), assets = await files(native.assetsDir);
  const graph = graphOf(native, doc), bundle = await encodeProjectBundle({ graph, validateGraph: v => native.validateGraph(v), readAsset: asset => fs.readFile(path.join(native.assetsDir, asset)) });
  const size = bundle.readUInt32BE(8), manifest = JSON.parse(bundle.subarray(12, 12 + size));
  const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
  const forged = g => { const json = Buffer.from(JSON.stringify(canonical({ ...manifest, graph: g }))), header = Buffer.from(bundle.subarray(0, 12)); header.writeUInt32BE(json.length, 8); return Buffer.concat([header, json, bundle.subarray(12 + size)]); };
  assert.deepEqual(decodeProjectBundle(forged(graph), { validateGraph: v => native.validateGraph(v) }).graph, graph);
  for (const parameters of [{}, { ...descriptor(), gridSize: 34 }, { ...descriptor(), inputSpace: 'linear' }, { ...descriptor(), extra: true }, { ...descriptor(), title: null }, { ...descriptor(), bytes: maxFile + 1 }]) {
    for (const extra of [{ layers: [{ ...source, filters: [filter(parameters)] }] }, { layers: [source, grade(parameters)] }]) await noAssetIO(native, () => assert.rejects(native.importProject({ data: forged({ ...graph, ...extra }) }), { code: 'INVALID_PROJECT_BUNDLE' }));
  }
  for (const recipe of [
    { id: randomUUID(), version: 1, name: 'LUT slot refused', slots: [{ key: 'grade', type: 'adjustment', kind: 'color_lookup' }], steps: [{ command: 'update_adjustment', target: 'grade', args: { value: 0, parameters: descriptor() } }] },
    { id: randomUUID(), version: 1, name: 'Disabled LUT source refused', slots: [{ key: 'source', type: 'raster' }], steps: [{ command: 'add_layer_filter', target: 'source', args: { kind: 'color_lookup', value: 0, parameters: descriptor(), enabled: false } }] },
  ]) await noAssetIO(native, () => assert.rejects(native.importProject({ data: forged({ ...graph, editRecipes: [recipe] }) }), { code: 'INVALID_PROJECT_BUNDLE' }));
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await files(native.assetsDir), assets);
});

test('Color Lookup replacement retains settings and original files across portable transfer and history-only restart validation', async t => {
  const { native, dataDir } = await fixture(t), source = await raster(native, image(8, 6), 8, 6), selection = { shape: 'rectangle', x: 1, y: 1, width: 4, height: 3, feather: .5, invert: false };
  let doc = await project(native, 8, 6, [source], { selection });
  const added = await edit(native, doc, 'import_color_lookup', imported('identity')); doc = added.document;
  assert.deepEqual(graphOf(native, doc).layers.find(l => l.id === added.layerId).mask, selection);
  doc = (await edit(native, doc, 'set_layer', { layerId: added.layerId, name: 'Saved look', opacity: .375, visible: false })).document;
  const previous = graphOf(native, doc).layers.find(l => l.id === added.layerId), result = await edit(native, doc, 'import_color_lookup', imported('rgb-cycle', { layerId: added.layerId })); doc = result.document;
  assert.equal(result.layerId, added.layerId); const replaced = graphOf(native, doc).layers.find(l => l.id === added.layerId);
  assert.deepEqual({ ...replaced, parameters: previous.parameters }, previous);
  for (const name of ['identity', 'rgb-cycle']) assert.deepEqual(await fs.readFile(path.join(native.assetsDir, descriptor(name).asset)), authoredCube(name));
  const bundle = await native.exportProject({ documentId: doc.id, expectedRevision: doc.revision }), decoded = decodeProjectBundle(bundle.data, { validateGraph: v => native.validateGraph(v) });
  assert.deepEqual(decoded.graph, graphOf(native, doc));
  const { native: other } = await fixture(t), transferred = (await other.importProject({ data: bundle.data })).document;
  assert.deepEqual(graphOf(other, transferred), graphOf(native, doc)); assert.deepEqual(await fs.readFile(path.join(other.assetsDir, descriptor('rgb-cycle').asset)), authoredCube('rgb-cycle'));
  assert.equal((await fs.readdir(other.assetsDir)).includes(descriptor('identity').asset), false, 'Portable projects contain current references, not unrelated history assets.');
  const reopened = await new NativeBackend({ dataDir }).init(); t.after(() => reopened.close()); assert.deepEqual(await get(reopened, doc), doc);
  const historyAsset = path.join(native.assetsDir, descriptor('identity').asset), original = await fs.readFile(historyAsset); await fs.writeFile(historyAsset, Buffer.alloc(original.length, 32));
  const rejected = await new NativeBackend({ dataDir }).init(); t.after(() => rejected.close()); assert.equal(rejected.projects.has(doc.id), false); assert.equal(rejected.loadWarnings.length, 1);
  await fs.writeFile(historyAsset, original); assert.deepEqual(await get(native, doc), doc);
});

test('Color Lookup real ENOTDIR and late import/Bake/paint transaction rollback preserve prior and deduplicated assets', async t => {
  const { native } = await fixture(t), source = await raster(native, image(8, 6), 8, 6);
  let doc = await project(native, 8, 6, [source]); doc = (await edit(native, doc, 'import_color_lookup', imported('identity'))).document;
  const assets = await files(native.assetsDir), projects = await files(native.projectsDir), directory = native.projectsDir, store = native.storeAsset; let writes = 0;
  native.storeAsset = async function (...args) { writes++; return store.apply(this, args); };
  try {
    for (const name of ['identity', 'cross-products']) {
      native.projectsDir = path.join(native.assetsDir, source.asset);
      try { await assert.rejects(edit(native, doc, 'import_color_lookup', imported(name, { target: 'layer-filter', layerId: source.id })), { code: 'ENOTDIR' }); }
      finally { native.projectsDir = directory; }
      assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await files(native.assetsDir), assets); assert.deepEqual(await files(native.projectsDir), projects);
    }
    assert.equal(writes, 2, 'Both an existing and a newly published LUT reached real failed project persistence.'); writes = 0;
    await assert.rejects(edit(native, doc, 'apply_transaction', { operations: [
      { command: 'import_color_lookup', args: imported('cross-products', { target: 'layer-filter', layerId: source.id }) },
      { command: 'bake_layer_filters', args: { layerId: source.id } },
      { command: 'paint_stroke', args: { layerId: source.id, tool: 'brush', color: '#cc5522', size: 2, opacity: 1, hardness: 1, points: [{ x: 3, y: 3 }] } },
      { command: 'set_layer', args: { layerId: randomUUID(), opacity: .5 } },
    ] }), { code: 'NOT_FOUND' });
    assert.ok(writes >= 3, 'Imported LUT, baked pixels and painted pixels were produced before the final failure.');
  } finally { native.storeAsset = store; native.projectsDir = directory; }
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await files(native.assetsDir), assets); assert.deepEqual(await files(native.projectsDir), projects);
});
