import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { CURVES_INTERPOLATION_POLICY, CURVES_INTERPOLATION_MODES, compileSmoothCurveLookup } from '../shared/smooth-curves.mjs';
import { ADJUSTMENTS, normalizeParameters, adjustmentTransform } from '../server/color.mjs';
import { normalizeLayerFilter, editedFilterStack, applyLayerFilters, filterWork, layerFilterSpatialCacheBytes, layerFilterSharedBytes, LAYER_FILTER_KINDS } from '../server/layer-filters.mjs';
import { estimateFilterBakeBytes } from '../server/filter-bake.mjs';
import { NativeBackend } from '../server/native.mjs';
import { normalizeEditRecipe, editRecipeHash } from '../server/edit-recipes.mjs';

const points = [{ x: 0, y: 0 }, { x: 64, y: 46 }, { x: 192, y: 211 }, { x: 255, y: 255 }];
const coded = code => error => error.code === code;
const byte = value => Math.max(0, Math.min(255, Math.round(value)));
const entry = (parameters = {}, extra = {}) => ({ id: randomUUID(), kind: 'curves', value: 0, parameters: { points, channel: 'rgb', interpolation: 'smooth', ...parameters }, enabled: true, opacity: 1, ...extra });
const graphOf = (native, doc) => structuredClone(native.project(doc.id).states[native.project(doc.id).cursor].graph);
const edit = async (native, doc, command, args = {}) => (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document;
const image = (w, h) => Buffer.from(Array.from({ length: w * h }, (_, p) => [p % 256, (p * 37 + 29) % 256, (p * 101 + 40) % 256, [0, 1, 128, 255][p % 4]]).flat());
async function fixture(t, width = 16, height = 16) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-smooth-curves-')), native = await new NativeBackend({ dataDir }).init();
  t.after(async () => { await native.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const input = image(width, height), png = await sharp(input, { raw: { width, height, channels: 4 } }).png().toBuffer(), doc = (await native.execute('import_image', { mimeType: 'image/png', data: png.toString('base64') })).document;
  return { native, doc, input };
}
function legacy(points, input) { let i = 1; while (i < points.length - 1 && points[i].x < input) i++; const a = points[i - 1], b = points[i]; return byte(a.y + (b.y - a.y) * (input - a.x) / (b.x - a.x)); }
// Independent ordinary-range PCHIP: direct secants/one-sided derivatives and
// Hermite basis, distinct from production exponent ratios/Bezier evaluation.
function reference(points) {
  const h = [], delta = []; for (let i = 1; i < points.length; i++) { h.push(points[i].x - points[i - 1].x); delta.push((points[i].y - points[i - 1].y) / h.at(-1)); }
  const derivatives = Array(points.length).fill(0);
  function end(h0, h1, d0, d1) { let v = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1); if (Math.sign(v) !== Math.sign(d0)) v = 0; else if (Math.sign(d0) !== Math.sign(d1) && Math.abs(v) > 3 * Math.abs(d0)) v = 3 * d0; return v; }
  if (points.length === 2) derivatives.fill(delta[0]);
  else { derivatives[0] = end(h[0], h[1], delta[0], delta[1]); derivatives[points.length - 1] = end(h.at(-1), h.at(-2), delta.at(-1), delta.at(-2)); }
  for (let i = 1; i < points.length - 1; i++) if (delta[i - 1] && delta[i] && Math.sign(delta[i - 1]) === Math.sign(delta[i])) { const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1]; derivatives[i] = (w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i]); }
  return Array.from({ length: 256 }, (_, input) => { let s = 0; while (s < h.length - 1 && points[s + 1].x < input) s++; const a = points[s], b = points[s + 1], t = (input - a.x) / h[s]; if (input === a.x) return a.y; if (input === b.x) return b.y; return (2*t**3-3*t*t+1)*a.y + (t**3-2*t*t+t)*h[s]*derivatives[s] + (-2*t**3+3*t*t)*b.y + (t**3-t*t)*h[s]*derivatives[s+1]; });
}

test('normalization preserves linear records, exposes strict smooth mode and retains exact authored knot precedence', () => {
  const defaults = { points: [{ x: 0, y: 0 }, { x: 255, y: 255 }], channel: 'rgb' };
  assert.deepEqual(normalizeParameters('curves'), defaults); assert.deepEqual(normalizeParameters('curves', { interpolation: 'linear' }), defaults);
  assert.deepEqual(normalizeParameters('curves', { interpolation: 'smooth' }), { ...defaults, interpolation: 'smooth' });
  assert.deepEqual(CURVES_INTERPOLATION_MODES, ['linear', 'smooth']); assert.equal(Object.keys(ADJUSTMENTS).length, 28); assert.equal(LAYER_FILTER_KINDS.length, 32);
  for (const interpolation of [null, false, 0, 'cubic', 'Smooth', {}]) assert.throws(() => normalizeParameters('curves', { interpolation }), coded('INVALID_ARGUMENT'));
  const adversarial = [{ x: 0, y: 255 }, { x: 255, y: .49999999999999994 }];
  assert.equal(compileSmoothCurveLookup(adversarial)[255], 0); assert.equal(legacy(adversarial, 255), 1);
  const identity = [{ x: 0, y: 0 }, { x: Number.MIN_VALUE, y: Number.MIN_VALUE }, { x: 1, y: 1 }, { x: 1 + Number.EPSILON, y: 1 + Number.EPSILON }, { x: 255, y: 255 }];
  assert.deepEqual([...compileSmoothCurveLookup(identity)], Array.from({ length: 256 }, (_, i) => i));
  const oldPointKeys = [{ x: 0, y: 0, ignored: true }, { x: 255, y: 255 }];
  assert.deepEqual(normalizeParameters('curves', { points: oldPointKeys }), defaults); // Existing native acceptance is unchanged.
});

test('bounded smooth lookup agrees with independent Hermite references and preserves local extrema through fractional/subnormal gaps', () => {
  let random = 0x126abfed; const next = () => ((random = (Math.imul(random, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const curves = [points, [{ x: 0, y: 0 }, { x: 40, y: 180 }, { x: 100, y: 180 }, { x: 160, y: 20 }, { x: 255, y: 200 }]];
  for (let n = 0; n < 500; n++) { const xs = new Set([0, 255]); while (xs.size < 2 + n % 15) xs.add(next() * 255); curves.push([...xs].sort((a, b) => a - b).map(x => ({ x, y: next() * 255 }))); }
  for (const p of curves) { const actual = compileSmoothCurveLookup(p), expected = reference(p); for (let i = 0; i < 256; i++) if (actual[i] !== byte(expected[i])) { assert.ok(Math.abs(actual[i] - byte(expected[i])) <= 1); assert.ok(Math.abs(expected[i] - Math.floor(expected[i]) - .5) < 1e-10); } }
  for (const gap of [Number.MIN_VALUE, 2 ** -1022, 2 ** -1000, 2 ** -100, Number.EPSILON, 1e-10, .1]) for (const yy of [[0, 255, 0, 255], [255, 0, 255, 0], [0, Number.MIN_VALUE, 1, 255], [.5 - Number.EPSILON, .5, .5 + Number.EPSILON, .5 + 2 * Number.EPSILON]]) {
    const p = [{ x: 0, y: yy[0] }, { x: gap, y: yy[1] }, { x: 1, y: yy[2] }, { x: 255, y: yy[3] }], lookup = compileSmoothCurveLookup(p);
    for (let s = 0; s < p.length - 1; s++) for (let i = Math.ceil(p[s].x); i <= Math.floor(p[s + 1].x); i++) { assert.ok(lookup[i] >= byte(Math.min(p[s].y, p[s + 1].y)) && lookup[i] <= byte(Math.max(p[s].y, p[s + 1].y))); if (i > Math.ceil(p[s].x)) assert.ok(Math.sign(p[s + 1].y - p[s].y) * (lookup[i] - lookup[i - 1]) >= 0); }
    for (const point of p) if (Number.isInteger(point.x)) assert.equal(lookup[point.x], byte(point.y));
  }
  const first = compileSmoothCurveLookup(points); first.fill(0); assert.ok(compileSmoothCurveLookup(points).some(Boolean));
  for (const p of [[], [{ x: 0, y: 0 }], [{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 255, y: 255 }], [{ x: 0, y: Infinity }, { x: 255, y: 255 }]]) assert.throws(() => compileSmoothCurveLookup(p), coded('INVALID_ARGUMENT'));
});

test('legacy Linear LUT remains literal at all bytes and channels, while Smooth uses the independently compiled candidate', () => {
  const fixtures = [points, [{ x: 0, y: 255 }, { x: 255, y: .49999999999999994 }], [{ x: 0, y: 0 }, { x: Number.MIN_VALUE, y: 255 }, { x: 255, y: 0 }]];
  for (const p of fixtures) for (const channel of ['rgb', 'red', 'green', 'blue']) for (const interpolation of [undefined, 'linear']) { const transform = adjustmentTransform({ kind: 'curves', value: 0, parameters: { points: p, channel, ...(interpolation ? { interpolation } : {}) } }); for (let i = 0; i < 256; i++) { const rgb = [i, 255 - i, (i * 97) % 256], expected = rgb.map((v, c) => channel === 'rgb' || c === ['red', 'green', 'blue'].indexOf(channel) ? legacy(p, v) : v); assert.deepEqual(transform(...rgb), expected); } }
  for (const channel of ['rgb', 'red', 'green', 'blue']) { const transform = adjustmentTransform({ kind: 'curves', value: 0, parameters: { points, channel, interpolation: 'smooth' } }), lookup = compileSmoothCurveLookup(points); for (let i = 0; i < 256; i++) assert.deepEqual(transform(i, i, i), [0, 1, 2].map(c => channel === 'rgb' || c === ['red', 'green', 'blue'].indexOf(channel) ? lookup[i] : i)); }
});

test('source and global Curves retain their distinct hidden-RGB rules, exact alpha, masks, protection and opacity', async t => {
  const { native, input } = await fixture(t), lookup = compileSmoothCurveLookup(points), selected = { ...entry(), opacity: .625 };
  const source = await applyLayerFilters(input, 16, 16, [selected]);
  const protectedPixels = Buffer.from(Array.from({ length: 256 }, (_, i) => i % 11 === 0 ? 255 : 0));
  const global = await native.applyAdjustment(input, 16, 16, { ...selected, mask: { shape: 'rectangle', x: 0, y: 0, width: 16, height: 16 }, maskDensity: .3 }, protectedPixels);
  for (let p = 0; p < 256; p++) { const i = p * 4; assert.equal(source[i + 3], input[i + 3]); assert.equal(global[i + 3], input[i + 3]); for (let c = 0; c < 3; c++) { const changed = byte(input[i + c] + (lookup[input[i + c]] - input[i + c]) * .625); assert.equal(source[i + c], input[i + 3] ? changed : input[i + c]); assert.equal(global[i + c], protectedPixels[p] ? input[i + c] : changed); } }
  const multiply = await applyLayerFilters(input, 16, 16, [entry({ points: [{ x: 0, y: 0 }, { x: 255, y: 255 }] }, { blendMode: 'multiply' })]);
  assert.ok(multiply.some((v, i) => i % 4 !== 3 && v !== input[i]));
});

test('partial mode/channel updates preserve points; explicit Linear reset and ordinary metadata operations avoid image I/O', async t => {
  const { native, doc: initial } = await fixture(t); let doc = initial; const layerId = doc.layers[0].id;
  const render = native.renderLayer, store = native.storeAsset; native.renderLayer = native.storeAsset = async () => { throw Error('Metadata touched pixels'); };
  try {
    doc = await edit(native, doc, 'add_layer_filter', { layerId, kind: 'curves', value: 0, parameters: { points } });
    const filterId = doc.layers[0].filters[0].id; doc = await edit(native, doc, 'update_layer_filter', { layerId, filterId, parameters: { interpolation: 'smooth' } }); assert.deepEqual(doc.layers[0].filters[0].parameters.points, points);
    doc = await edit(native, doc, 'update_layer_filter', { layerId, filterId, parameters: { channel: 'blue' } }); assert.equal(doc.layers[0].filters[0].parameters.interpolation, 'smooth');
    doc = await edit(native, doc, 'update_layer_filter', { layerId, filterId, parameters: { interpolation: 'linear' } }); assert.ok(!Object.hasOwn(doc.layers[0].filters[0].parameters, 'interpolation')); assert.equal(doc.layers[0].filters[0].parameters.channel, 'blue');
    doc = await edit(native, doc, 'add_adjustment', { kind: 'curves', value: 0, parameters: { points, interpolation: 'smooth' } }); const adjustmentId = doc.layers.at(-1).id;
    doc = await edit(native, doc, 'update_adjustment', { layerId: adjustmentId, parameters: { channel: 'green' } }); assert.deepEqual(doc.layers.at(-1).parameters, { points, channel: 'green', interpolation: 'smooth' });
    doc = await edit(native, doc, 'update_adjustment', { layerId: adjustmentId, parameters: { interpolation: 'linear' } }); assert.deepEqual(doc.layers.at(-1).parameters, { points, channel: 'green' });
  } finally { native.renderLayer = render; native.storeAsset = store; }
  const caps = await native.execute('capabilities'); assert.equal(caps.curvesInterpolationPolicy, CURVES_INTERPOLATION_POLICY); assert.deepEqual(caps.curvesInterpolationModes, CURVES_INTERPOLATION_MODES);
});

test('canonical Linear recipes reset Smooth targets without changing old bodies/hashes, with metadata-only validation and one Undo', async t => {
  const { native, doc: initial } = await fixture(t); let doc = await edit(native, initial, 'add_adjustment', { kind: 'curves', value: 0, parameters: { points, channel: 'red', interpolation: 'smooth' } }); const adjustmentId = doc.layers.at(-1).id;
  const definition = { id: randomUUID(), version: 1, name: 'Linear reset', slots: [{ key: 'tone', type: 'adjustment', kind: 'curves' }], steps: [{ command: 'update_adjustment', target: 'tone', args: { value: 0, parameters: { points, channel: 'rgb' } } }] };
  assert.deepEqual(normalizeEditRecipe(definition), definition); const explicit = structuredClone(definition); explicit.steps[0].args.parameters.interpolation = 'linear'; assert.equal(editRecipeHash(explicit), editRecipeHash(definition));
  const saved = await native.execute('save_edit_recipe', { documentId: doc.id, expectedRevision: doc.revision, name: definition.name, slots: definition.slots, steps: definition.steps }); doc = saved.document;
  const before = JSON.stringify(native.project(doc.id)), render = native.renderLayer; native.renderLayer = async () => { throw Error('Recipe read pixels'); };
  try { const report = await native.execute('validate_edit_recipe', { documentId: doc.id, expectedRevision: doc.revision, recipeId: saved.recipeId, bindings: { tone: adjustmentId } }); assert.equal(report.valid, true); assert.equal(JSON.stringify(native.project(doc.id)), before); doc = (await native.execute('apply_edit_recipe', { documentId: doc.id, expectedRevision: doc.revision, recipeId: saved.recipeId, bindings: { tone: adjustmentId } })).document; } finally { native.renderLayer = render; }
  assert.deepEqual(doc.layers.at(-1).parameters, { points, channel: 'rgb' }); assert.deepEqual(doc.editRecipes[0].steps[0].args.parameters, { points, channel: 'rgb' });
  doc = await edit(native, doc, 'undo'); assert.equal(doc.layers.at(-1).parameters.interpolation, 'smooth');
});

test('Smooth source Bake preserves working alpha, source masks and Distort, with portable replay and actual persistence rollback', async t => {
  const { native, doc: initial } = await fixture(t); let doc = initial; const layerId = doc.layers[0].id, originalAsset = doc.layers[0].asset, source = await fs.readFile(path.join(native.assetsDir, originalAsset));
  doc = await edit(native, doc, 'add_layer_filter', { layerId, kind: 'curves', value: 0, parameters: { points, interpolation: 'smooth' }, opacity: .75, blendMode: 'screen' });
  doc = await edit(native, doc, 'set_layer_filter_mask', { layerId, source: 'mask', mask: { shape: 'ellipse', x: 1, y: 1, width: 14, height: 14, feather: 1 } });
  doc = await edit(native, doc, 'modify_layer_filter_mask', { layerId, density: .1 });
  doc = await edit(native, doc, 'add_layer_distort', { layerId, corners: [{ x: 1, y: 0 }, { x: 16, y: 1 }, { x: 15, y: 16 }, { x: 0, y: 15 }] });
  const before = await native.renderGraph(graphOf(native, doc)), project = JSON.stringify(native.project(doc.id)), assets = await fs.readdir(native.assetsDir), directory = native.projectsDir;
  native.projectsDir = path.join(native.assetsDir, originalAsset); try { await assert.rejects(edit(native, doc, 'bake_layer_filters', { layerId }), coded('ENOTDIR')); } finally { native.projectsDir = directory; }
  assert.equal(JSON.stringify(native.project(doc.id)), project); assert.deepEqual(await fs.readdir(native.assetsDir), assets);
  const saved = structuredClone(doc.layers[0]); doc = await edit(native, doc, 'bake_layer_filters', { layerId }); assert.deepEqual(await native.renderGraph(graphOf(native, doc)), before); assert.deepEqual(doc.layers[0].transforms, saved.transforms);
  const working = await sharp(await fs.readFile(path.join(native.assetsDir, doc.layers[0].asset))).ensureAlpha().raw().toBuffer(), raw = await sharp(source).ensureAlpha().raw().toBuffer(); for (let i = 3; i < raw.length; i += 4) assert.equal(working[i], raw[i]);
  doc = await edit(native, doc, 'undo'); const reopened = (await native.importProject({ data: (await native.exportProject({ documentId: doc.id })).data })).document; assert.equal(reopened.layers[0].filters[0].parameters.interpolation, 'smooth'); assert.deepEqual(await native.renderGraph(graphOf(native, reopened)), before); assert.deepEqual(await fs.readFile(path.join(native.assetsDir, originalAsset)), source);
});

test('Smooth has the same work/cache/Bake envelope and rejects malformed persisted metadata and late transactions atomically', async t => {
  const a = entry(), b = entry({ interpolation: 'linear' }); assert.equal(filterWork(a, 24_000_000), filterWork(b, 24_000_000)); assert.equal(filterWork(a, 24_000_000), 24_000_000); assert.equal(layerFilterSpatialCacheBytes([a], 4000, 6000), 0); assert.equal(layerFilterSharedBytes([a]), 0);
  const options = { width: 1024, height: 1024, encodedWorkingBytes: 1000, encodedAlphaBytes: 200, hasAlpha: true }; assert.deepEqual(estimateFilterBakeBytes({ ...options, filters: [a] }), estimateFilterBakeBytes({ ...options, filters: [b] }));
  const { native, doc: initial } = await fixture(t); let doc = await edit(native, initial, 'add_layer_filter', { layerId: initial.layers[0].id, kind: 'curves', value: 0, parameters: { interpolation: 'smooth' } }); const layerId = doc.layers[0].id, filterId = doc.layers[0].filters[0].id;
  const bad = graphOf(native, doc); bad.layers[0].filters[0].parameters.interpolation = 'spline'; bad.layers[0].filters[0].enabled = false; assert.throws(() => native.validateGraph(bad), coded('INVALID_ARGUMENT'));
  const before = JSON.stringify(native.project(doc.id)); await assert.rejects(edit(native, doc, 'apply_transaction', { label: 'Fail smooth edit', operations: [{ command: 'update_layer_filter', args: { layerId, filterId, parameters: { interpolation: 'linear' } } }, { command: 'delete_layer', args: { layerId: randomUUID() } }] }), coded('NOT_FOUND')); assert.equal(JSON.stringify(native.project(doc.id)), before);
});
