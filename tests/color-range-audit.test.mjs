import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { normalizeColorRangeSettings } from '../shared/color-range.mjs';
import { compileColorRange, colorRangeComparisonWork, materializeColorRangeSelection, renderColorRangePreview } from '../server/color-range.mjs';
import { chargeMaskPreparation, withMaskPreparationBudget } from '../server/dense-mask.mjs';
import { estimateDenseMaskResources } from '../server/dense-mask-resources.mjs';
import { colorRangeReference, colorRangePlaneReference, colorRangePreviewReference, rangeMembershipReference, rangeAlphaReference, COLOR_RANGE_GOLDENS, COLOR_RANGE_PHOTO_GOLDENS } from './fixtures/color-range/reference.mjs';
import { authoredFrame, highFrequencyRGBA, runCount } from './fixtures/dense-mask/reference.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const base = extra => ({ id: randomUUID(), name: 'Independent Color Range', visible: true, opacity: 1, blendMode: 'normal', ...extra });
const scene = (width, height, layers, extra = {}) => ({ name: 'Independent Color Range', width, height, selection: null, layers, ...extra });
const graphOf = (native, doc) => { const project = native.projects.get(doc.id); return structuredClone(project.states[project.cursor].graph); };
const get = async (native, doc) => (await native.execute('get_document', { documentId: doc.id })).document;
const edit = (native, doc, command, args = {}) => native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...(command === 'apply_transaction' ? { label: 'Range audit' } : {}), ...args });
const files = async directory => Object.fromEntries(await Promise.all((await fs.readdir(directory)).sort().map(async name => [name, hash(await fs.readFile(path.join(directory, name)))])));
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-color-range-audit-'));
  const native = await new NativeBackend({ dataDir, segmentSubject: () => assert.fail('Color Range cannot call a model.') }).init();
  t.after(async () => { await native.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { native, dataDir };
}
async function raster(native, pixels, width, height, extra = {}) {
  const asset = await native.storeAsset(await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer());
  return base({ type: 'raster', width, height, asset, sourceAsset: asset, sourceFormat: 'png', transforms: [], ...extra });
}
async function project(native, width, height, layers, extra = {}) { return (await native.newProject(scene(width, height, layers, extra), 'Independent Color Range fixture')).document; }
async function coverage(native, mask) {
  assert.equal(mask.feather, 0); assert.equal(mask.invert, false);
  if (mask.shape === 'bitmap') { const plane = Buffer.alloc(mask.width * mask.height); for (let i = 0; i < mask.runs.length; i += 3) plane.fill(mask.runs[i + 2], mask.runs[i], mask.runs[i] + mask.runs[i + 1]); return plane; }
  assert.equal(mask.shape, 'alpha8');
  const frame = await fs.readFile(path.join(native.assetsDir, mask.asset));
  assert.equal(hash(frame), mask.asset); assert.equal(frame.length, mask.width * mask.height + 32);
  const plane = Buffer.from(frame.subarray(32)); assert.ok(frame.equals(authoredFrame(plane, mask.width, mask.height).bytes)); return plane;
}
async function gray(result) {
  const rgba = await sharp(Buffer.isBuffer(result.data) ? result.data : Buffer.from(result.data, 'base64')).toColourspace('srgb').ensureAlpha().raw().toBuffer();
  const plane = Buffer.alloc(rgba.length / 4);
  for (let i = 0; i < plane.length; i++) { plane[i] = rgba[4 * i]; assert.equal(rgba[4 * i + 1], plane[i]); assert.equal(rgba[4 * i + 2], plane[i]); assert.equal(rgba[4 * i + 3], 255); }
  return plane;
}
function sameBytes(actual, expected, label = 'coverage') { assert.equal(actual.length, expected.length, label); if (!actual.equals(expected)) { const at = actual.findIndex((byte, i) => byte !== expected[i]); assert.fail(`${label} byte${at}: actual${actual[at]}, expected${expected[at]}`); } }
async function noPixels(native, operation) {
  const originals = new Map(), calls = [];
  for (const name of ['render', 'renderGraph', 'renderLayer', 'readAlpha', 'readDenseMask', 'storeAlpha', 'storeAsset', 'readProjectAsset', 'validateProjectAsset', 'segmentSubject']) {
    originals.set(name, native[name]); native[name] = () => { calls.push(name); assert.fail(`Unexpected ${name}`); };
  }
  try { return await operation(); } finally { for (const [name, value] of originals) native[name] = value; assert.deepEqual(calls, [], 'A caught intercepted renderer failure is not metadata admission.'); }
}

test('Color Range actual private lookup matches independent half-up literals, all alpha products and selected complete distance ramps', () => {
  for (const g of COLOR_RANGE_GOLDENS) { assert.equal(colorRangeReference(g.rgba, g.parameters), g.expected); assert.equal(compileColorRange(g.parameters)(...g.rgba), g.expected); }
  for (const tolerance of [0, 1, 16, 32, 127, 200, 254, 255]) for (const falloff of [0, 1, 2, 4, 32, 100, 254, 255]) {
    const actual = compileColorRange({ colors: ['#000000'], tolerance, falloff });
    for (let d = 0; d < 256; d++) for (const alpha of [0, 1, 2, 128, 254, 255]) assert.equal(actual(d, 0, 0, alpha), rangeAlphaReference(rangeMembershipReference(d, tolerance, falloff), alpha));
  }
  for (let membership = 0; membership < 256; membership++) {
    const actual = compileColorRange({ colors: ['#000000'], tolerance: 0, falloff: 255 });
    for (let alpha = 0; alpha < 256; alpha++) assert.equal(actual(255 - membership, 0, 0, alpha), rangeAlphaReference(membership, alpha));
  }
  const supplied = { colors: ['#ABCDEF'], tolerance: 0, falloff: 0, invert: false }, transformed = compileColorRange(supplied), normalized = normalizeColorRangeSettings(supplied);
  supplied.colors[0] = '#000000'; normalized.colors[0] = '#ffffff'; supplied.invert = true;
  assert.equal(transformed(171, 205, 239, 128), 128);
  let getters = 0;
  for (const key of ['colors', 'tolerance', 'falloff', 'invert']) {
    const bad = { colors: ['#abcdef'] }; Object.defineProperty(bad, key, { enumerable: true, get() { getters++; return 0; } });
    assert.throws(() => normalizeColorRangeSettings(bad), { code: 'INVALID_ARGUMENT' });
  }
  const badArray = ['#abcdef']; Object.defineProperty(badArray, '0', { enumerable: true, get() { getters++; return '#abcdef'; } });
  for (const value of [{ colors: badArray }, { colors: ['#abcdef\n'] }, { colors: ['#ABCDEF', '#abcdef'] }, { colors: Array(1) }, { colors: ['#abcdef'], falloff: undefined }, Object.create({ get colors() { getters++; return ['#abcdef']; } })]) assert.throws(() => normalizeColorRangeSettings(value), { code: 'INVALID_ARGUMENT' });
  assert.equal(getters, 0);
  assert.deepEqual(normalizeColorRangeSettings(Object.freeze(Object.assign(Object.create(null), { colors: Object.freeze(['#ABCDEF']), tolerance: -0 }))), { colors: ['#abcdef'], tolerance: 0, falloff: 32, invert: false });
  assert.equal(colorRangeComparisonWork(24_000_000, 8), 192_000_000);
  assert.throws(() => colorRangeComparisonWork(24_000_001, 8), { code: 'LIMIT_EXCEEDED' });
  for (const [pixels, count] of [[0, 1], [1, 0], [1, 9], [1.5, 1], [Infinity, 1]]) assert.throws(() => colorRangeComparisonWork(pixels, count), { code: 'INVALID_ARGUMENT' });
});

test('Color Range helpers own settings before renderer awaits and preserve continuous geometric combination', async () => {
  const graph = scene(1, 1, [], { selection: { shape: 'rectangle', x: 0, y: 0, width: 1, height: 1, feather: 3, invert: false } });
  const settings = { colors: ['#000000'], tolerance: 0, falloff: 37 };
  const render = async () => Buffer.from([27, 0, 0, 255]); // Exact candidate69.
  for (const [mode, byte] of [['replace', 69], ['add', 69], ['subtract', 31], ['intersect', 11]]) sameBytes(await materializeColorRangeSelection(graph, { ...settings, mode }, render), Buffer.from([byte]));
  for (const mode of ['subtract', 'intersect']) await assert.rejects(materializeColorRangeSelection({ ...graph, selection: null }, { ...settings, mode }, () => assert.fail('No-selection refusal must precede rendering.')), { code: 'NO_SELECTION' });
  let release;
  const gate = new Promise(resolve => { release = resolve; }), args = { ...settings, colors: ['#000000'], mode: 'replace' };
  const pending = materializeColorRangeSelection(graph, args, async () => { await gate; return render(); });
  args.colors[0] = '#ffffff'; args.tolerance = 255; args.mode = 'subtract'; release();
  sameBytes(await pending, Buffer.from([69]));
  const input = highFrequencyRGBA(127, 63), original = Buffer.from(input), options = { colors: ['#123456', '#abcdef'], tolerance: 32, falloff: 37, invert: true, maxEdge: 37 };
  const preview = await renderColorRangePreview(scene(127, 63, []), options, async () => input), expected = colorRangePreviewReference(input, 127, 63, options, 37);
  assert.deepEqual([preview.width, preview.height], [expected.width, expected.height]); sameBytes(await gray(preview), expected.gray); sameBytes(input, original, 'source');
  await assert.rejects(materializeColorRangeSelection(scene(1, 1, []), settings, async () => Buffer.alloc(3)), { code: 'INVALID_ARGUMENT' });
});

test('Color Range queued Preview, Load and transaction own arrays before waits and reject raw accessors without invocation', async t => {
  const { native } = await fixture(t), source = await raster(native, Buffer.from([27, 0, 0, 255]), 1, 1);
  let doc = await project(native, 1, 1, [source]);
  const settings = { colors: ['#000000'], tolerance: 0, falloff: 37 };
  for (const command of ['get_color_range_preview', 'load_color_range_selection', 'apply_transaction']) {
    let release; const held = native.enqueue(() => new Promise(resolve => { release = resolve; })); await new Promise(resolve => setImmediate(resolve));
    const supplied = { ...settings, colors: [...settings.colors] }, args = command === 'apply_transaction' ? { label: 'Captured range', operations: [{ command: 'load_color_range_selection', args: supplied }] } : { ...supplied, ...(command === 'get_color_range_preview' ? { maxEdge: 32 } : {}) };
    const submitted = { documentId: doc.id, expectedRevision: doc.revision, ...args }, queued = native.execute(command, submitted);
    supplied.colors[0] = '#ffffff'; supplied.tolerance = 255;
    if (command !== 'apply_transaction') { submitted.tolerance = 255; submitted.invert = true; }
    release(); await held;
    const result = await queued;
    if (command === 'get_color_range_preview') { sameBytes(await gray(result), Buffer.from([69])); assert.deepEqual(result.colors, ['#000000']); }
    else { doc = result.document; sameBytes(await coverage(native, doc.selection), Buffer.from([69])); }
  }
  const before = await get(native, doc); let calls = 0;
  const malformed = () => { const args = { ...settings, colors: ['#000000'] }; Object.defineProperty(args.colors, '0', { enumerable: true, get() { calls++; return '#000000'; } }); return args; };
  for (const runner of [args => native.execute('load_color_range_selection', args), args => native.dispatch('load_color_range_selection', args)]) await assert.rejects(async () => runner({ documentId: doc.id, expectedRevision: doc.revision, ...malformed() }), error => ['INVALID_ARGUMENT', 'INVALID_ARGUMENTS'].includes(error.code));
  for (const dispatch of ['execute', 'dispatch']) {
    const operation = { command: 'load_color_range_selection', args: malformed() };
    await assert.rejects(async () => native[dispatch]('apply_transaction', { documentId: doc.id, expectedRevision: doc.revision, label: 'Reject raw accessor', operations: [operation] }), error => ['INVALID_ARGUMENT', 'INVALID_ARGUMENTS'].includes(error.code));
  }
  assert.equal(calls, 0); assert.deepEqual(await get(native, doc), before);
});

test('Color Range real photographic previews and loads match fixed full-plane goldens without changing source or read state', async t => {
  const { native } = await fixture(t), original = await fs.readFile(new URL('./fixtures/tonal-color/astronaut.png', import.meta.url));
  assert.equal(hash(original), '88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5');
  const pixels = await sharp(original).ensureAlpha().raw().toBuffer(), source = await raster(native, pixels, 512, 512);
  let doc = await project(native, 512, 512, [source]);
  for (const golden of COLOR_RANGE_PHOTO_GOLDENS) {
    const expected = colorRangePlaneReference(pixels, golden.parameters); assert.equal(hash(expected), golden.sha256);
    const beforeAssets = await files(native.assetsDir), beforeProjects = await files(native.projectsDir);
    const read = await native.execute('get_color_range_preview', { documentId: doc.id, expectedRevision: doc.revision, ...golden.parameters, maxEdge: 257 });
    const sampled = colorRangePreviewReference(pixels, 512, 512, golden.parameters, 257);
    sameBytes(await gray(read), sampled.gray); assert.equal(read.revision, doc.revision); assert.equal(read.coveragePolicy, 'sampled-rgb-chebyshev-alpha-v1'); assert.deepEqual(read.colors, golden.parameters.colors);
    assert.deepEqual(await files(native.assetsDir), beforeAssets); assert.deepEqual(await files(native.projectsDir), beforeProjects); assert.deepEqual(await get(native, doc), doc);
    doc = (await edit(native, doc, 'load_color_range_selection', golden.parameters)).document;
    sameBytes(await coverage(native, doc.selection), expected);
    assert.equal(doc.layers.find(layer => layer.id === source.id).sourceAsset, source.sourceAsset);
  }
  assert.ok((await fs.readFile(path.join(native.assetsDir, source.asset))).equals(await sharp(pixels, { raw: { width: 512, height: 512, channels: 4 } }).png().toBuffer()));
});

test('Color Range forces legacy graph admission before pixels and activates nested runtime budgets separately per transaction step', async t => {
  const { native } = await fixture(t), large = base({ type: 'raster', width: 4000, height: 4000, asset: 'a'.repeat(64), sourceAsset: 'a'.repeat(64), transforms: [], effects: { shadow: {} } });
  const legacy = scene(4000, 4000, [large]); assert.equal(estimateDenseMaskResources(legacy).enabled, false); assert.ok(estimateDenseMaskResources(legacy, { force: true }).estimatedWorkingBytes > 268_435_456);
  const big = (await native.newProject(legacy, 'Legacy metadata control')).document;
  await noPixels(native, async () => { for (const command of ['get_color_range_preview', 'load_color_range_selection']) await assert.rejects(edit(native, big, command, { colors: ['#ffffff'] }), { code: 'LIMIT_EXCEEDED' }); });
  let doc = (await native.execute('create_document', { name: 'Runtime scope', width: 1, height: 1, background: '#ffffff' })).document;
  const mask = { shape: 'alpha8', asset: 'b'.repeat(64), width: 6000, height: 4000, bytes: 24_000_032, x: 0, y: 0, feather: 1, invert: false }, small = { ...mask, width: 1, height: 1, bytes: 33, feather: 0 };
  const render = native.renderGraph;
  try {
    native.renderGraph = () => { chargeMaskPreparation(mask); return withMaskPreparationBudget(true, async () => { await Promise.resolve(); chargeMaskPreparation(mask); chargeMaskPreparation(small); return Buffer.from([255, 255, 255, 255]); }); };
    for (const command of ['get_color_range_preview', 'load_color_range_selection']) await assert.rejects(edit(native, doc, command, { colors: ['#ffffff'] }), { code: 'LIMIT_EXCEEDED' });
    native.renderGraph = () => { chargeMaskPreparation(mask); return withMaskPreparationBudget(true, async () => { await Promise.resolve(); chargeMaskPreparation(mask); return Buffer.from([255, 255, 255, 255]); }); };
    const before = doc.revision;
    doc = (await edit(native, doc, 'apply_transaction', { operations: [{ command: 'load_color_range_selection', args: { colors: ['#ffffff'] } }, { command: 'load_color_range_selection', args: { colors: ['#ffffff'], invert: true } }] })).document;
    assert.equal(doc.revision, before + 1); assert.equal(doc.selection.shape, 'bitmap'); assert.deepEqual(doc.selection.runs, []);
  } finally { native.renderGraph = render; }
});

test('Color Range exact1MP dense coverage survives saved selection, portable transfer, Undo and restart', async t => {
  const { native, dataDir } = await fixture(t), width = 1024, height = 1024, pixels = highFrequencyRGBA(width, height);
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
  const source = await raster(native, pixels, width, height), settings = { colors: ['#000000'], tolerance: 0, falloff: 255 };
  const expected = colorRangePlaneReference(pixels, settings);
  for (let i = 0; i < expected.length; i++) assert.equal(expected[i], 255 - Math.max(pixels[4 * i], pixels[4 * i + 1], pixels[4 * i + 2]));
  assert.ok(runCount(expected) > 200_000);
  let doc = await project(native, width, height, [source]);
  doc = (await edit(native, doc, 'load_color_range_selection', settings)).document;
  assert.equal(doc.selection.shape, 'alpha8'); assert.equal(doc.selection.bytes, 1_048_608);
  sameBytes(await coverage(native, doc.selection), expected);
  const authored = authoredFrame(expected, width, height); assert.equal(doc.selection.asset, authored.descriptor.asset);
  const first = structuredClone(doc.selection);
  doc = (await edit(native, doc, 'save_selection', { name: 'Exact Color Range' })).document;
  assert.equal(doc.savedSelections[0].mask.asset, first.asset);
  doc = (await edit(native, doc, 'load_color_range_selection', { ...settings, invert: true })).document;
  sameBytes(await coverage(native, doc.selection), Buffer.from(Uint8Array.from(expected, byte => 255 - byte)));
  doc = (await edit(native, doc, 'undo')).document;
  assert.equal(doc.selection.asset, first.asset);
  const bundle = await native.exportProject({ documentId: doc.id, expectedRevision: doc.revision });
  const { native: other } = await fixture(t), restored = (await other.importProject({ data: bundle.data })).document;
  sameBytes(await coverage(other, restored.selection), expected); assert.equal(restored.savedSelections[0].mask.asset, first.asset);
  await native.close(); const restarted = await new NativeBackend({ dataDir }).init();
  t.after(() => restarted.close());
  const reopened = await get(restarted, doc); assert.equal(reopened.revision, doc.revision); assert.equal(reopened.selection.asset, first.asset);
  sameBytes(await coverage(restarted, reopened.selection), expected);
});

test('Color Range real publication failure and late pixel transaction remove new assets while preserving shared dense history', async t => {
  const { native } = await fixture(t), width = 512, height = 512, pixels = highFrequencyRGBA(width, height);
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
  const source = await raster(native, pixels, width, height), settings = { colors: ['#000000'], tolerance: 0, falloff: 255 };
  let doc = await project(native, width, height, [source]);
  doc = (await edit(native, doc, 'load_color_range_selection', settings)).document;
  assert.equal(doc.selection.shape, 'alpha8');
  const beforeAssets = await files(native.assetsDir), beforeProjects = await files(native.projectsDir), directory = native.projectsDir;
  for (const invert of [false, true]) {
    native.projectsDir = path.join(native.assetsDir, source.asset);
    try { await assert.rejects(edit(native, doc, 'load_color_range_selection', { ...settings, invert }), { code: 'ENOTDIR' }); }
    finally { native.projectsDir = directory; }
    assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await files(native.assetsDir), beforeAssets); assert.deepEqual(await files(native.projectsDir), beforeProjects);
  }
  await assert.rejects(edit(native, doc, 'apply_transaction', { operations: [
    { command: 'load_color_range_selection', args: { ...settings, invert: true } },
    { command: 'paint_stroke', args: { layerId: source.id, tool: 'brush', color: '#cc5522', size: 3, hardness: 1, opacity: 1, points: [{ x: 3, y: 3 }] } },
    { command: 'set_layer', args: { layerId: randomUUID(), opacity: 0.5 } },
  ] }), { code: 'NOT_FOUND' });
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await files(native.assetsDir), beforeAssets); assert.deepEqual(await files(native.projectsDir), beforeProjects);
});

test('Color Range measures actual protected/generated/grouped/clipped/styled/filtered composition independently of active selection', async t => {
  const { native } = await fixture(t), width = 11, height = 7, count = width * height;
  const protectedPixels = Buffer.alloc(4 * count);
  for (let i = 0; i < count; i++) protectedPixels.set([31, 117, 209, i % width >= 3 && i % width <= 5 ? [1, 128, 255][i % 3] : 0], 4 * i);
  const person = await raster(native, protectedPixels, width, height, { protected: true, outline: { width: 1, color: '#ffffff' } });
  const group = base({ type: 'group', mode: 'isolated', opacity: .7, mask: { shape: 'rectangle', x: 0, y: 0, width: 10, height: 7, feather: 1, invert: false } });
  const source = await raster(native, highFrequencyRGBA(width, height), width, height, { parentId: group.id,
    filters: [{ id: randomUUID(), kind: 'brightness', value: 17, enabled: true, opacity: .5, blendMode: 'multiply' }],
    transforms: [{ type: 'distort', width, height, corners: [{ x: 1, y: 0 }, { x: width + 1, y: 0 }, { x: width + 1, y: height }, { x: 1, y: height }] }] });
  const member = await raster(native, Buffer.from(Array.from({ length: count }, () => [29, 157, 71, 177]).flat()), width, height, { parentId: group.id, clipBaseId: source.id, role: 'generated', provenance: { jobId: randomUUID(), mode: 'generate' } });
  const styled = await raster(native, Buffer.from(Array.from({ length: count }, (_, i) => [192, 83, 41, i % 3 ? 128 : 0]).flat()), width, height, {
    effects: { version: 1, fillOpacity: .5, styles: { shadow: { color: '#193d71', opacity: .4, blur: 0, x: 1, y: 1 } } } });
  const adjustment = base({ type: 'adjustment', kind: 'median', value: 1 });
  let doc = await project(native, width, height, [person, group, source, member, styled, adjustment], { selection: { shape: 'rectangle', x: 0, y: 0, width: 1, height: 1, feather: 0, invert: true } });
  const graph = graphOf(native, doc), pixels = await native.renderGraph(graph), settings = { colors: ['#1f75d1', '#c05329'], tolerance: 16, falloff: 73, invert: true };
  const expected = colorRangePlaneReference(pixels, settings), originals = await files(native.assetsDir);
  const read = await native.execute('get_color_range_preview', { documentId: doc.id, expectedRevision: doc.revision, ...settings, maxEdge: 32 });
  sameBytes(await gray(read), expected);
  doc = (await edit(native, doc, 'load_color_range_selection', settings)).document;
  sameBytes(await coverage(native, doc.selection), expected);
  const after = graphOf(native, doc); assert.deepEqual(after.layers, graph.layers); assert.deepEqual(await files(native.assetsDir), originals);
  sameBytes(await native.renderGraph(after), pixels, 'composite after selection');
});
