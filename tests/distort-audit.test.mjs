import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { createDistort, normalizeDistort, distortPixels } from '../server/distort.mjs';
import { estimateDistortResources } from '../server/distort-resources.mjs';
import { estimateDistortPsdPreparation } from '../server/psd-native.mjs';
import { preflightPsdExport } from '../server/psd-export.mjs';
import { encodeProjectBundle } from '../server/project-bundle.mjs';
import { exactSample } from './fixtures/distort/exact-reference.mjs';

const base = extra => ({ id: randomUUID(), name: 'Independent Distort audit', visible: true, opacity: 1, blendMode: 'normal', ...extra });
const corners = (w, h, dx = 0, dy = 0) => [[dx, dy], [w + dx, dy], [w + dx, h + dy], [dx, h + dy]].map(([x, y]) => ({ x, y }));
const image = (w, h) => Buffer.from(Array.from({ length: w * h }, (_, p) => [p * 37 % 256, p * 73 % 256, p * 97 % 256, [0, 1, 128, 255][p % 4]]).flat());
const entry = extra => ({ id: randomUUID(), kind: 'invert', value: 100, enabled: true, opacity: .5, ...extra });
const fake = (w, h, extra = {}) => base({ type: 'raster', width: w, height: h, asset: 'a'.repeat(64), sourceAsset: 'a'.repeat(64), transforms: [], ...extra });
const bitmap = (bytes, width, height, extra = {}) => ({ shape: 'bitmap', x: 0, y: 0, width, height, runs: Array.from(bytes).flatMap((v, i) => v ? [i, 1, v] : []), feather: 0, invert: false, ...extra });
const graph = (native, doc) => { const p = native.projects.get(doc.id); return structuredClone(p.states[p.cursor].graph); };
const get = async (native, doc) => (await native.execute('get_document', { documentId: doc.id })).document;
const edit = (native, doc, command, args = {}) => native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...(command === 'apply_transaction' ? { label: 'Distort audit' } : {}), ...args });
const project = async (native, width, height, layers, extra = {}) => (await native.newProject({ name: 'Distort audit', width, height, selection: null, layers, ...extra }, 'Fixture')).document;
const files = async dir => Object.fromEntries(await Promise.all((await fs.readdir(dir)).sort().map(async name => [name, await fs.readFile(path.join(dir, name))])));
async function fixture(t) { const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-distort-audit-')); const native = await new NativeBackend({ dataDir, segmentSubject: () => assert.fail('No model for Distort') }).init(); t.after(async () => { await native.close(); await fs.rm(dataDir, { recursive: true, force: true }); }); return { native, dataDir }; }
async function raster(native, input, width, height, extra = {}) { const asset = await native.storeAsset(await sharp(input, { raw: { width, height, channels: 4 } }).png().toBuffer()); return fake(width, height, { asset, sourceAsset: asset, ...extra }); }
async function noPixels(native, operation) { const saved = new Map(); for (const key of ['render', 'renderGraph', 'renderLayer', 'readAlpha', 'storeAlpha', 'storeAsset', 'readProjectAsset', 'validateProjectAsset', 'segmentSubject']) { saved.set(key, native[key]); native[key] = () => assert.fail(`Unexpected pixel access: ${key}`); } try { return await operation(); } finally { for (const [key, value] of saved) native[key] = value; } }

test('Distort stable fixtures match an independent exact-rational projective sampler and copy all integer RGBA bytes', async () => {
  const w = 8, h = 6, input = image(w, h), unchanged = Buffer.from(input);
  const quads = [corners(w, h), corners(w, h, 1, -1), corners(w, h, .5, .25), [[1, 1], [7, 1], [8, 5], [0, 5]], [[1, 0], [9, 0], [7, 6], [-1, 6]], [[-3, -1], [6, 0], [9, 8], [-1, 5]]].map(q => q.map(p => Array.isArray(p) ? { x: p[0], y: p[1] } : p));
  for (const [index, quad] of quads.entries()) {
    const record = createDistort(w, h, quad), out = await distortPixels(input, w, h, record);
    assert.deepEqual(out, exactSample(input, w, h, quad.map(p => [p.x, p.y]))); assert.deepEqual(input, unchanged);
    assert.notEqual(out, input);
    const hidden = Buffer.from(input); for (let i = 0; i < hidden.length; i += 4) if (!hidden[i + 3]) for (let c = 0; c < 3; c++) hidden[i + c] ^= 255;
    const changed = await distortPixels(hidden, w, h, record);
    if (index < 2) assert.deepEqual(changed, exactSample(hidden, w, h, quad.map(p => [p.x, p.y]))); else assert.deepEqual(changed, out);
  }
  const wide = image(8192, 8); let yielded = false;
  const task = distortPixels(wide, 8192, 8, createDistort(8192, 8, corners(8192, 8, .25, .25)));
  setImmediate(() => { yielded = true; }); await task; assert.equal(yielded, true);
});

test('strict fixed-frame descriptors reject malformed or unsafe geometry before publication and portable asset reads', async t => {
  const { native } = await fixture(t), w = 8, h = 6, source = await raster(native, image(w, h), w, h), valid = createDistort(w, h, corners(w, h));
  const unsafe = [
    { ...valid, width: 7 }, { ...valid, sampler: 'nearest' }, { ...valid, corners: corners(w, h).slice(0, 3) },
    { ...valid, corners: [[0, 0], [8, 6], [8, 0], [0, 6]].map(([x, y]) => ({ x, y })) },
    { ...valid, corners: [[8, 0], [0, 0], [0, 6], [8, 6]].map(([x, y]) => ({ x, y })) },
    { ...valid, corners: [[0, 0], [8, 0], [8, 2 ** -20], [0, 2 ** -20]].map(([x, y]) => ({ x, y })) },
    { ...valid, corners: corners(w, h).map((p, i) => i ? p : { x: Infinity, y: 0 }) },
    { ...valid, corners: corners(w, h).map((p, i) => i ? p : { ...p, z: 0 }) },
  ];
  for (const record of unsafe) {
    assert.throws(() => normalizeDistort(record, w, h));
    const g = { name: 'Malformed Distort', width: w, height: h, selection: null, layers: [{ ...source, transforms: [record] }] };
    assert.throws(() => native.validateGraph(g));
    // JSON cannot represent Infinity; its resulting null remains invalid.
    const data = await encodeProjectBundle({ graph: JSON.parse(JSON.stringify(g)), validateGraph: () => {}, readAsset: asset => fs.readFile(path.join(native.assetsDir, asset)) });
    await noPixels(native, () => assert.rejects(native.importProject({ data }), { code: 'INVALID_PROJECT_BUNDLE' }));
  }
  const getter = { ...valid, corners: corners(w, h) }; Object.defineProperty(getter.corners[0], 'x', { enumerable: true, get() { assert.fail('A descriptor accessor ran'); } });
  assert.throws(() => normalizeDistort(getter, w, h), { code: 'INVALID_ARGUMENT' });
  const sparse = { ...valid, corners: corners(w, h) }; delete sparse.corners[1]; assert.throws(() => normalizeDistort(sparse, w, h), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => createDistort(1, 1, [[3.5, 0], [4.5, 0], [8, 6], [0, 6]].map(([x, y]) => ({ x, y }))), { code: 'INVALID_ARGUMENT' }, 'A pole in bilinear fringe must reject even when the unit quad is convex');
});

test('source alpha and complete masked filtering precede Distort; raw source Bake preserves geometry and appearance', async t => {
  const { native } = await fixture(t), w = 8, h = 6, input = image(w, h), alpha = Uint8Array.from({ length: w * h }, (_, i) => [255, 128, 1, 0, 199][i % 5]), raw = Uint8Array.from({ length: w * h }, (_, i) => i * 53 % 256);
  const mask = { sourceWidth: w, sourceHeight: h, coverage: bitmap(raw, w, h, { invert: true }), density: .1, enabled: true }, filters = { version: 1, entries: [entry()], mask };
  const source = await raster(native, input, w, h, { alphaAsset: await native.storeAlpha(Buffer.from(alpha), w, h), filters });
  let doc = await project(native, w, h, [source]); doc = (await edit(native, doc, 'add_layer_distort', { layerId: source.id, corners: corners(w, h, 1, -1) })).document;
  const effective = Buffer.from(input), wanted = Buffer.from(input);
  for (let p = 0; p < alpha.length; p++) {
    const a = Number((2n * BigInt(input[4 * p + 3] * alpha[p]) + 255n) / 510n); effective[4 * p + 3] = wanted[4 * p + 3] = a;
    const e = Math.round(255 - .1 * raw[p]);
    if (a) for (let c = 0; c < 3; c++) wanted[4 * p + c] = Number((2n * BigInt(input[4 * p + c] * (255 - e) + 128 * e) + 255n) / 510n);
  }
  const current = graph(native, doc).layers[0], quad = current.transforms[0].corners.map(p => [p.x, p.y]);
  assert.deepEqual(await native.renderLayer(current), exactSample(wanted, w, h, quad));
  assert.deepEqual(await native.renderLayer(current, { filters: false }), exactSample(effective, w, h, quad));
  const sourceFiles = await files(native.assetsDir), rendered = await native.renderGraph(graph(native, doc));
  doc = (await edit(native, doc, 'bake_layer_filters', { layerId: source.id })).document;
  const baked = graph(native, doc).layers[0], bytes = await sharp(await fs.readFile(path.join(native.assetsDir, baked.asset))).ensureAlpha().raw().toBuffer();
  for (let p = 0; p < alpha.length; p++) wanted[4 * p + 3] = input[4 * p + 3];
  assert.deepEqual(bytes, wanted); assert.deepEqual(baked.transforms, current.transforms); assert.equal(baked.alphaAsset, source.alphaAsset); assert.equal(baked.sourceAsset, source.sourceAsset);
  assert.deepEqual(await native.renderGraph(graph(native, doc)), rendered); for (const [name, contents] of Object.entries(sourceFiles)) assert.deepEqual(await fs.readFile(path.join(native.assetsDir, name)), contents);
});

test('historical full-index edits retain suffix frames and document masks, and protected stages remain readable but immutable', async t => {
  const { native } = await fixture(t), w = 8, h = 6, source = await raster(native, image(w, h), w, h, { mask: { shape: 'rectangle', x: 1, y: 1, width: 5, height: 4, feather: 0, invert: false }, maskDensity: .5 });
  let doc = await project(native, w, h, [source], { selection: { shape: 'rectangle', x: 2, y: 1, width: 3, height: 2 }, guides: [{ id: randomUUID(), axis: 'vertical', position: 4 }] });
  doc = (await edit(native, doc, 'add_layer_distort', { layerId: source.id, corners: corners(w, h, 1, 0) })).document;
  doc = (await edit(native, doc, 'crop_document', { x: 1, y: 1, width: 6, height: 4 })).document;
  doc = (await edit(native, doc, 'add_layer_distort', { layerId: source.id, corners: corners(6, 4, 0, -1) })).document;
  const before = structuredClone(doc), suffix = doc.layers[0].transforms.slice(1);
  doc = (await noPixels(native, () => edit(native, doc, 'update_layer_distort', { layerId: source.id, transformIndex: 0, corners: corners(w, h, -1, 0) }))).document;
  assert.deepEqual(doc.layers[0].transforms.slice(1), suffix); assert.equal(doc.layers[0].transforms[0].width, w);
  for (const key of ['selection', 'guides']) assert.deepEqual(doc[key], before[key]); assert.deepEqual(doc.layers[0].mask, before.layers[0].mask);
  await noPixels(native, () => assert.rejects(edit(native, doc, 'delete_layer_distort', { layerId: source.id, transformIndex: 1 }), { code: 'INVALID_TARGET' }));
  doc = (await noPixels(native, () => edit(native, doc, 'delete_layer_distort', { layerId: source.id, transformIndex: 0 }))).document; assert.deepEqual(doc.layers[0].transforms, suffix);
  doc = (await edit(native, doc, 'set_layer_protection', { layerId: source.id, protected: true })).document; native.validateGraph(graph(native, doc));
  for (const [command, args] of [['add_layer_distort', { corners: corners(6, 4) }], ['update_layer_distort', { transformIndex: 1, corners: corners(6, 4) }], ['delete_layer_distort', { transformIndex: 1 }]]) await noPixels(native, () => assert.rejects(edit(native, doc, command, { layerId: source.id, ...args }), { code: 'PROTECTED_LAYER' }));
  assert.deepEqual(await get(native, doc), doc);
});

test('combined root and decoded phases enforce exact14N/22N admission before image access', async t => {
  const { native } = await fixture(t);
  for (const [w, h, active, allowed] of [[8192, 2340, false, true], [8192, 2341, false, false], [4096, 2978, true, true], [4096, 2979, true, false]]) {
    const source = fake(w, h, { visible: false, ...(active ? { filters: [entry({ value: 0, opacity: 1 })] } : {}) }), doc = await project(native, w, h, [source]);
    assert.equal((active ? 22 : 14) * w * h <= 256 * 1024 * 1024, allowed); assert.ok(16 * w * h <= 384000000);
    const run = () => edit(native, doc, 'add_layer_distort', { layerId: source.id, corners: corners(w, h) });
    if (allowed) await noPixels(native, run); else { await noPixels(native, () => assert.rejects(run(), { code: 'LIMIT_EXCEEDED' })); assert.deepEqual(await get(native, doc), doc); }
  }
  // A legacy-only sibling can render during original-context inspection. Its
  // retained original+previous+next phases must participate in new admission.
  const legacy = fake(6000, 4000, { protected: true, visible: false, transforms: [{ type: 'resize', width: 6000, height: 4000 }, { type: 'resize', width: 6000, height: 4000 }, { type: 'crop', x: 0, y: 0, width: 512, height: 512 }] }), target = fake(512, 512);
  const doc = await project(native, 512, 512, [legacy, target]);
  await noPixels(native, () => assert.rejects(edit(native, doc, 'apply_transaction', { operations: [{ command: 'add_layer_distort', args: { layerId: target.id, corners: corners(512, 512) } }, { command: 'delete_layer_distort', args: { layerId: target.id, transformIndex: 0 } }] }), { code: 'LIMIT_EXCEEDED' }));
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await fs.readdir(native.assetsDir), []);
});

test('global group/clipping retention, ordinary bitmap callbacks and another leaf shared table are added to the same peak', async t => {
  const { native } = await fixture(t), w = 3200, h = 1252, N = w * h;
  const outer = base({ type: 'group', mode: 'isolated', opacity: .5 }), inner = base({ type: 'group', mode: 'isolated', parentId: outer.id, opacity: .5 });
  const source = fake(w, h, { parentId: inner.id, transforms: [createDistort(w, h, corners(w, h)), createDistort(w, h, corners(w, h))] });
  const member = base({ type: 'solid', color: '#ffffff', width: w, height: h, transforms: [], parentId: inner.id, clipBaseId: source.id });
  const noise = fake(1, 1, { visible: false, transforms: [{ type: 'resize', width: w, height: h }], filters: [entry({ kind: 'add_noise', value: 0, opacity: 1, parameters: { distribution: 'gaussian' } })] });
  const masked = extra => base({ type: 'adjustment', kind: 'brightness', value: 0, visible: false, mask: bitmap([], w, h), ...extra });
  const masks = Array.from({ length: 15 }, (_, i) => masked(i ? {} : { mask: bitmap([], w, h, { feather: 1 }) })), disabled = masked({ maskDensity: 0 });
  assert.equal(67 * N + 4096, 268432896);
  const doc = await project(native, w, h, [noise, outer, inner, source, member, ...masks, disabled]);
  // No positioned wrapper exists: ordinary bitmap callback accounting must
  // still be forced by the new stronger Distort envelope.
  const current = graph(native, doc), estimate = estimateDistortResources(current); native.validateGraph(current);
  assert.equal(estimate.rootBytes, 6 * N); assert.equal(estimate.retainedBytes, 15 * N); assert.equal(estimate.leafBytes, 12 * N); assert.equal(estimate.callbackBytes, 34 * N); assert.equal(estimate.sharedBytes, 4096); assert.equal(estimate.estimatedWorkingBytes, 268432896);
  const args = { layerId: disabled.id, density: 1 };
  await noPixels(native, () => assert.rejects(edit(native, doc, 'modify_layer_mask', args), { code: 'LIMIT_EXCEEDED' }));
  await noPixels(native, () => assert.rejects(edit(native, doc, 'apply_transaction', { operations: [
    { command: 'modify_layer_mask', args },
    { command: 'delete_layer_distort', args: { layerId: source.id, transformIndex: 0 } },
  ] }), { code: 'LIMIT_EXCEEDED' }));
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await fs.readdir(native.assetsDir), []);
});

test('retained procedural inputs participate in decoded phases before any procedural raster or font work', async t => {
  const { native } = await fixture(t);
  const gradient = { kind: 'linear', start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, stops: [{ offset: 0, color: '#000000', opacity: 1 }, { offset: 1, color: '#ffffff', opacity: 1 }] };
  for (const [w, h, type, settings, allowed] of [
    [8000, 1800, 'gradient', { gradient }, true], [8000, 1900, 'gradient', { gradient }, false],
    [8192, 2331, 'text', { text: 'x', x: 0, y: 0, fontSize: 10, color: '#ffffff' }, true],
    [8192, 2332, 'text', { text: 'x', x: 0, y: 0, fontSize: 10, color: '#ffffff' }, false],
    [8192, 2332, 'shape', { vector: { shape: 'rectangle', x: 0, y: 0, width: 1, height: 1 } }, false],
    [8192, 2332, 'path', { vector: { nodes: [{ x: 0, y: 0 }, { x: 1, y: 1 }] } }, false],
  ]) {
    const source = base({ type, width: w, height: h, transforms: [], ...settings }), doc = await project(native, w, h, [source]);
    const reserve = type === 'gradient' ? 4 * w * h : 1024 * 1024;
    assert.equal(14 * w * h + reserve <= 256 * 1024 * 1024, allowed);
    const run = () => edit(native, doc, 'add_layer_distort', { layerId: source.id, corners: corners(w, h) });
    if (allowed) await noPixels(native, run); else await noPixels(native, () => assert.rejects(run(), { code: 'LIMIT_EXCEEDED' }));
  }
});

test('every content source reaches projective geometry, while protected original RGB and generated clipped pixels keep their scope', async t => {
  const { native } = await fixture(t), w = 8, h = 6, quad = [[1, 1], [7, 1], [8, 5], [0, 5]].map(([x, y]) => ({ x, y }));
  const ordinary = [
    await raster(native, image(w, h), w, h),
    base({ type: 'solid', width: w, height: h, transforms: [], color: '#4388c1' }),
    base({ type: 'text', width: w, height: h, transforms: [], text: 'I', x: 1, y: 0, fontSize: 6, color: '#ffaa33' }),
    base({ type: 'shape', width: w, height: h, transforms: [], vector: { shape: 'ellipse', x: 1, y: 1, width: 5, height: 4, fill: '#223344', stroke: null } }),
    base({ type: 'path', width: w, height: h, transforms: [], vector: { nodes: [{ x: 1, y: 1 }, { x: 6, y: 4 }], stroke: '#7799dd', strokeWidth: 2, fill: null } }),
    base({ type: 'gradient', width: w, height: h, transforms: [], gradient: { kind: 'linear', start: { x: 0, y: 0 }, end: { x: 8, y: 6 }, stops: [{ offset: 0, color: '#2277aa', opacity: .2 }, { offset: 1, color: '#dd9944', opacity: 1 }] } }),
  ];
  for (const layer of ordinary) {
    let doc = await project(native, w, h, [layer]); const before = await native.renderLayer(layer);
    doc = (await edit(native, doc, 'add_layer_distort', { layerId: layer.id, corners: quad })).document;
    const output = await native.renderLayer(graph(native, doc).layers[0]), exact = exactSample(before, w, h, quad.map(p => [p.x, p.y]));
    for (let i = 0; i < output.length; i++) assert.ok(Math.abs(output[i] - exact[i]) <= 1, `${layer.type} byte${i}: bounded floating sampler diverged from the rational fixture`);
    doc = (await edit(native, doc, 'update_layer_distort', { layerId: layer.id, transformIndex: 0, corners: corners(w, h, 1, -1) })).document;
    assert.deepEqual(await native.renderLayer(graph(native, doc).layers[0]), exactSample(before, w, h, corners(w, h, 1, -1).map(p => [p.x, p.y])));
  }
  const skin = Buffer.alloc(w * h * 4); for (let y = 1; y < h; y++) for (let x = 0; x < 3; x++) skin.set([177, 122, 81, [1, 128, 255][x]], 4 * (y * w + x));
  const person = await raster(native, skin, w, h, { protected: true, transforms: [createDistort(w, h, corners(w, h, 1, 0))] });
  const group = base({ type: 'group', mode: 'isolated', opacity: .6 }), original = Buffer.alloc(w * h * 4); for (let p = 0; p < w * h; p++) original.set([p * 13 % 256, p * 37 % 256, 77, 255], 4 * p);
  const source = await raster(native, original, w, h, { parentId: group.id, filters: [entry({ opacity: 1 })], transforms: [createDistort(w, h, corners(w, h, -1, 0))], mask: { shape: 'positioned', sourceWidth: w, sourceHeight: h, x: 1, y: 0, source: { shape: 'rectangle', x: 0, y: 0, width: w, height: h, feather: 0, invert: false } }, maskDensity: .5 });
  const generated = await raster(native, Buffer.from(Array.from({ length: w * h }, () => [33, 88, 199, 173]).flat()), w, h, { parentId: group.id, clipBaseId: source.id, role: 'generated', provenance: { jobId: randomUUID(), mode: 'generate' }, transforms: [createDistort(w, h, corners(w, h, .5, .25))] });
  const doc = await project(native, w, h, [person, group, source, generated]), current = graph(native, doc), footprint = await native.protectedPixels(current, { beforeLayerId: source.id });
  assert.ok(footprint.some(Boolean)); const altered = await native.renderLayer(source, { protectedPixels: footprint }), expectedOriginal = exactSample(original, w, h, corners(w, h, -1, 0).map(p => [p.x, p.y]));
  for (let p = 0; p < w * h; p++) if (footprint[p]) assert.deepEqual(altered.subarray(4 * p, 4 * p + 3), expectedOriginal.subarray(4 * p, 4 * p + 3));
  const actual = await native.renderGraph(current), control = await native.renderGraph({ ...current, layers: current.layers.filter(l => l.id !== generated.id).map(l => l.id === source.id ? { ...l, filters: [] } : l) });
  for (let p = 0; p < w * h; p++) if (footprint[p]) assert.deepEqual(actual.subarray(4 * p, 4 * p + 4), control.subarray(4 * p, 4 * p + 4));
  const preview = await native.execute('get_layer_preview', { documentId: doc.id, layerId: generated.id, view: 'layer', maxWidth: 32 }), previewPixels = await sharp(Buffer.from(preview.data, 'base64')).ensureAlpha().raw().toBuffer();
  for (let p = 0; p < w * h; p++) if (footprint[p]) assert.equal(previewPixels[4 * p + 3], 0);
});

test('PSD reserves completed mask planes and collected layer RGBA concurrently with retained legacy source geometry', async t => {
  const { native } = await fixture(t), w = 128, h = 128, N = w * h;
  const large = fake(5590, 4000, { transforms: [
    { type: 'resize', width: 5590, height: 4000 }, { type: 'resize', width: 5590, height: 4000 },
    { type: 'crop', x: 0, y: 0, width: w, height: h }, createDistort(w, h, corners(w, h)),
  ] });
  const small = base({ type: 'solid', color: '#ffffff', width: w, height: h, transforms: [] }), mask = { shape: 'rectangle', x: 0, y: 0, width: w, height: h, feather: 0, invert: false };
  for (const layers of [[{ ...large, mask }, { ...small, mask }], [small, large]]) {
    const doc = await project(native, w, h, layers), current = graph(native, doc), normal = estimateDistortResources(current);
    assert.equal(normal.leafBytes, 12 * 5590 * 4000); assert.equal(normal.estimatedWorkingBytes, 268418304); assert.equal(preflightPsdExport(current).supported, true);
    assert.equal(estimateDistortPsdPreparation(current, { retain: false }), 268418304);
    assert.equal(estimateDistortPsdPreparation(current, { retain: true }), 268451072);
    await noPixels(native, () => assert.rejects(native.exportPsd({ documentId: doc.id, expectedRevision: doc.revision }), error => error.code === 'PSD_UNSUPPORTED' && error.report.issues.some(issue => issue.code === 'WORKING_MEMORY_LIMIT')));
    assert.deepEqual(await get(native, doc), doc);
  }
  const reordered = { name: 'Collection phases', width: w, height: h, selection: null, layers: [large, small] };
  assert.equal(estimateDistortPsdPreparation(reordered, { retain: true }), 268418304, 'A source rendered before retained small-layer RGBA needs only the graph phase');
  assert.equal(6 * N + 12 * 5590 * 4000, 268418304);
});

test('actual persistence and late pixel transaction failures preserve graph, source assets and owned geometry', async t => {
  const { native } = await fixture(t), w = 8, h = 6, source = await raster(native, image(w, h), w, h, { filters: [entry({ opacity: 1 })] });
  const doc = await project(native, w, h, [source]), originalAssets = await files(native.assetsDir), originalProjects = await files(native.projectsDir), originalDir = native.projectsDir;
  native.projectsDir = path.join(native.assetsDir, source.asset);
  try { await assert.rejects(edit(native, doc, 'add_layer_distort', { layerId: source.id, corners: corners(w, h, 1, 0) })); } finally { native.projectsDir = originalDir; }
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await files(native.assetsDir), originalAssets); assert.deepEqual(await files(native.projectsDir), originalProjects);
  const store = native.storeAsset; let assetWrites = 0; native.storeAsset = async function (...args) { assetWrites++; return store.apply(this, args); };
  try { await assert.rejects(edit(native, doc, 'apply_transaction', { operations: [
    { command: 'add_layer_distort', args: { layerId: source.id, corners: corners(w, h, 1, 0) } },
    { command: 'bake_layer_filters', args: { layerId: source.id } },
    { command: 'paint_stroke', args: { layerId: source.id, tool: 'brush', color: '#cc5522', size: 2, opacity: 1, hardness: 1, points: [{ x: 3, y: 3 }] } },
    { command: 'set_layer', args: { layerId: randomUUID(), opacity: .5 } },
  ] }), { code: 'NOT_FOUND' }); } finally { native.storeAsset = store; }
  assert.ok(assetWrites >= 2, 'Bake and paint must really run before the later failure');
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await files(native.assetsDir), originalAssets); assert.deepEqual(await files(native.projectsDir), originalProjects);
});
