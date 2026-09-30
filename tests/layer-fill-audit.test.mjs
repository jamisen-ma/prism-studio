import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { normalizeEffects } from '../server/layer-effects.mjs';
import { normalizeLayerFillEffects, layerFillOpacity, layerOutsideEffects, setLayerFillOpacity, setLayerOutsideEffects, projectLayerFill } from '../server/layer-fill.mjs';
import { denseDecorationBytes, estimateDenseMaskResources } from '../server/dense-mask-resources.mjs';
import { preflightPsdExport } from '../server/psd-export.mjs';
import { encodeProjectBundle, decodeProjectBundle } from '../server/project-bundle.mjs';
import { layerFillPixelReference, layerFillReference, layerFillExactPixelComparison, fillMaskCoverage, LAYER_FILL_GOLDENS, LAYER_FILL_COVERAGE_GOLDENS, LAYER_FILL_REFERENCE_MODES } from './fixtures/layer-fill/reference.mjs';

const base = extra => ({ id: randomUUID(), name: 'Independent Fill audit', visible: true, opacity: 1, blendMode: 'normal', ...extra });
const fake = (width, height, extra = {}) => base({ type: 'raster', width, height, asset: 'a'.repeat(64), sourceAsset: 'a'.repeat(64), transforms: [], ...extra });
const graph = (width, height, layers, extra = {}) => ({ name: 'Fill audit', width, height, selection: null, layers, ...extra });
const stored = (native, doc) => { const p = native.projects.get(doc.id); return structuredClone(p.states[p.cursor].graph); };
const project = async (native, width, height, layers, extra = {}) => (await native.newProject(graph(width, height, layers, extra), 'Fill audit fixture')).document;
const get = async (native, doc) => (await native.execute('get_document', { documentId: doc.id })).document;
const edit = (native, doc, command, args = {}) => native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...(command === 'apply_transaction' ? { label: 'Fill audit' } : {}), ...args });
const wrap = (fillOpacity, styles = null) => ({ version: 1, fillOpacity, styles });
const bitmap = (alpha, width, height, extra = {}) => ({ shape: 'bitmap', width, height, x: 0, y: 0, feather: 0, invert: false, runs: Array.from(alpha).flatMap((a, i) => a ? [i, 1, a] : []), ...extra });
const image = (width, height) => Buffer.from(Array.from({ length: width * height }, (_, p) => [(p * 37 + 11) % 256, (p * 73 + 29) % 256, (p * 97 + 53) % 256, [0, 1, 128, 255][p % 4]]).flat());
const files = async directory => Object.fromEntries(await Promise.all((await fs.readdir(directory)).sort().map(async name => [name, await fs.readFile(path.join(directory, name))])));
async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-layer-fill-audit-'));
  const native = await new NativeBackend({ dataDir, ...options }).init();
  t.after(async () => { await native.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { native, dataDir };
}
async function raster(native, pixels, width, height, extra = {}) {
  const asset = await native.storeAsset(await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer());
  return fake(width, height, { asset, sourceAsset: asset, ...extra });
}
async function noPixels(native, operation, allIO = false) {
  const restore = [], calls = [];
  for (const name of ['render', 'renderGraph', 'renderLayer', 'readAlpha', 'readDenseMask', 'storeAsset', 'storeAlpha', 'readProjectAsset', 'validateProjectAsset']) {
    const old = native[name]; native[name] = () => { calls.push(name); assert.fail(`Unexpected ${name}`); }; restore.push(() => { native[name] = old; });
  }
  if (allIO) for (const name of ['readFile', 'writeFile', 'open', 'rename', 'link', 'stat']) {
    const old = fs[name]; fs[name] = () => { calls.push(`fs.${name}`); assert.fail(`Unexpected fs.${name}`); }; restore.push(() => { fs[name] = old; });
  }
  try { return await operation(); }
  finally { restore.reverse().forEach(fn => fn()); assert.deepEqual(calls, [], 'A swallowed I/O assertion is not a metadata refusal.'); }
}

test('Fill canonical metadata owns updates and projection while preserving literal legacy and rejecting executable nested wrappers', () => {
  const legacyForms = [undefined, null, {}, { shadow: {} }, { glow: { color: '#ABCDEF', opacity: 0 } }];
  for (const effects of legacyForms) {
    const layer = fake(1, 1, effects === undefined ? {} : { effects }), original = structuredClone(layer);
    assert.deepEqual(setLayerFillOpacity(layer, 1), original);
    assert.deepEqual(projectLayerFill(layer), original);
    const changed = setLayerFillOpacity(layer, .375);
    assert.equal(layerFillOpacity(changed), .375);
    assert.deepEqual(layerOutsideEffects(changed), effects === undefined ? null : normalizeEffects(effects));
    const projected = projectLayerFill(changed); assert.equal(projected.fillOpacity, .375); assert.equal(projected.opacity, 1);
    assert.throws(() => layerFillOpacity(projected), { code: 'INVALID_ARGUMENT' });
    if (projected.effects) projected.effects[Object.keys(projected.effects)[0]].opacity = .123;
    assert.deepEqual(layer, original);
    const cleared = setLayerOutsideEffects(changed, null); assert.equal(layerFillOpacity(cleared), .375); assert.equal(layerOutsideEffects(cleared), null);
    assert.equal(Object.hasOwn(setLayerFillOpacity(cleared, 1), 'effects'), false);
  }
  let calls = 0;
  const getter = () => { calls++; return .5; };
  const malformed = [wrap(1), wrap(NaN), wrap(-1), wrap(.5, {}), wrap(.5, { shadow: {} }), wrap(.5, { glow: {} }),
    { version: 2, fillOpacity: .5, styles: null }, { version: 1, fillOpacity: .5 }, { ...wrap(.5), extra: true },
    Object.assign(Object.create({ version: 1 }), { fillOpacity: .5, styles: null }),
    Object.defineProperty(wrap(.5), 'fillOpacity', { enumerable: true, get: getter }),
    Object.defineProperty(wrap(.5), 'styles', { enumerable: true, get: getter }),
    Object.defineProperty(wrap(.5), 'extra', { value: 1, enumerable: false }), { ...wrap(.5), [Symbol('extra')]: 1 }];
  const nested = { color: '#ffffff', opacity: 1, blur: 0 }; Object.defineProperty(nested, 'opacity', { enumerable: true, get: getter }); malformed.push(wrap(.5, { glow: nested }));
  for (const effects of malformed) {
    assert.throws(() => normalizeLayerFillEffects(effects), { code: 'INVALID_ARGUMENT' });
    for (const read of [layerFillOpacity, layerOutsideEffects, projectLayerFill]) assert.throws(() => read(fake(1, 1, { effects })), { code: 'INVALID_ARGUMENT' });
  }
  assert.equal(calls, 0);
  for (const fill of [0, Number.MIN_VALUE, .375, 1 - 2 ** -53]) {
    const effects = wrap(fill);
    assert.throws(() => normalizeEffects(effects), { code: 'INVALID_ARGUMENT' }, 'The pre-Fill strict style validator fails closed.');
    assert.equal(layerFillOpacity(fake(1, 1, { effects })), fill);
  }
});

test('Fill reference literals and actual source composition retain alpha, soft density and declared Normal/nonNormal/Dissolve order', async t => {
  for (const item of LAYER_FILL_GOLDENS) {
    assert.deepEqual(layerFillPixelReference(item), item.expected, item.name);
    assert.deepEqual(layerFillExactPixelComparison(item), item.expected, `${item.name} rational comparison`);
  }
  for (const item of LAYER_FILL_COVERAGE_GOLDENS) assert.equal(fillMaskCoverage(item.raw, item.options), item.expected);
  const { native } = await fixture(t), width = 12, height = 1, original = image(width, height), background = Buffer.from(Array.from({ length: width }, (_, i) => [23, 91, 207, [0, 128, 255][i % 3]]).flat());
  const lower = await raster(native, background, width, height), source = await raster(native, original, width, height), snapshot = await files(native.assetsDir);
  const backdrop = layerFillReference(Buffer.alloc(background.length), background), rawMask = Array.from({ length: width }, (_, i) => (i * 67) % 256);
  const mask = bitmap(rawMask, width, height, { invert: true }), maskCoverage = rawMask.map(a => fillMaskCoverage(a / 255, { invert: true, density: .375, byteMask: true }));
  for (const blendMode of LAYER_FILL_REFERENCE_MODES) for (const fillOpacity of [0, Number.MIN_VALUE, .375, .5, 1]) {
    const opacity = .73, layer = { ...source, opacity, blendMode, mask, maskDensity: .375, ...(fillOpacity === 1 ? {} : { effects: wrap(fillOpacity) }) };
    const actual = await native.renderGraph(graph(width, height, [lower, layer]));
    assert.deepEqual(actual, layerFillReference(backdrop, original, { opacity, fillOpacity, maskCoverage, blendMode }), `${blendMode} F=${fillOpacity}`);
  }
  const tiny = await raster(native, Buffer.from([128, 64, 32, 1]), 1, 1, { opacity: .5, effects: wrap(.5) });
  assert.deepEqual([...await native.renderGraph(graph(1, 1, [tiny]))], [128, 64, 32, 0]);
  const continuous = await raster(native, Buffer.from([128, 64, 32, 69]), 1, 1, { mask: { shape: 'rectangle', x: 0, y: 0, width: 1, height: 1, feather: 3 } });
  assert.deepEqual([...await native.renderGraph(graph(1, 1, [continuous]))], [128, 64, 32, 11]);
  for (const [name, contents] of Object.entries(snapshot)) assert.deepEqual(await fs.readFile(path.join(native.assetsDir, name)), contents);
});

test('Fill leaves shadow alpha and occupied silhouette independent of the body and does not apply its mask twice', async t => {
  const { native } = await fixture(t), width = 5, height = 1;
  const sourcePixels = Buffer.from([7, 11, 19, 0, 201, 31, 79, 128, 23, 29, 37, 0, 61, 173, 97, 255, 41, 43, 47, 0]);
  const source = await raster(native, sourcePixels, width, height), background = Buffer.from(Array.from({ length: width }, () => [20, 40, 80, 128]).flat()), lower = await raster(native, background, width, height);
  const styles = { shadow: { color: '#204080', opacity: 1, blur: 0, x: 1, y: 0 } }, alpha = [0, 128, 0, 255, 0];
  const coverage = alpha.map(a => fillMaskCoverage(a / 255, { density: .5, byteMask: true }));
  const decoration = Buffer.alloc(width * 4); decoration.set([32, 64, 128, 96], 8); decoration.set([32, 64, 128, 255], 16);
  const backdrop = layerFillReference(Buffer.alloc(background.length), background);
  for (const fillOpacity of [0, .375, 1]) for (const opacity of [0, .5, 1]) for (const blendMode of ['normal', 'multiply', 'screen', 'dissolve']) {
    const layer = { ...source, opacity, blendMode, mask: bitmap(alpha, width, height), maskDensity: .5, effects: fillOpacity === 1 ? styles : wrap(fillOpacity, styles) };
    assert.deepEqual(await native.renderGraph(graph(width, height, [lower, layer])), layerFillReference(backdrop, sourcePixels, { opacity, fillOpacity, maskCoverage: coverage, decoration, blendMode }));
  }
  const alone = await native.renderGraph(graph(width, height, [{ ...source, effects: wrap(0, styles) }]));
  assert.equal(alone[7], 0); assert.equal(alone[15], 0); assert.equal(alone[11], 128); assert.equal(alone[19], 255);
});

test('Fill protection keeps exact-zero bodies open and positive tiny bodies protected across generated and original-context reads', async t => {
  const { native } = await fixture(t), width = 3, height = 1;
  const lower = await raster(native, Buffer.from([40, 50, 60, 255, 40, 50, 60, 255, 40, 50, 60, 255]), width, height);
  const body = Buffer.from([0, 0, 0, 0, 201, 31, 79, 255, 0, 0, 0, 0]), source = await raster(native, body, width, height, { protected: true, opacity: .5 });
  const styles = { shadow: { color: '#204080', opacity: 1, blur: 0, x: 1, y: 0 } };
  for (const fill of [0, Number.MIN_VALUE, .375]) {
    const person = { ...source, effects: wrap(fill, styles) }, scene = graph(width, height, [lower, person]);
    assert.deepEqual([...await native.protectedPixels(scene)], [0, fill === 0 ? 0 : 1, 1]);
    const baseline = await native.renderGraph(scene), grade = base({ type: 'adjustment', kind: 'invert', value: 100 });
    const expected = Buffer.from(baseline); for (const p of fill === 0 ? [0, 1] : [0]) for (let c = 0; c < 3; c++) expected[p * 4 + c] = 255 - expected[p * 4 + c];
    assert.deepEqual(await native.renderGraph({ ...scene, layers: [...scene.layers, grade] }), expected);
    const green = Buffer.from([20, 240, 20, 255, 20, 240, 20, 255, 20, 240, 20, 255]);
    const generated = await raster(native, green, width, height, { role: 'generated', provenance: { jobId: randomUUID() } });
    const composed = Buffer.from(baseline); for (const p of fill === 0 ? [0, 1] : [0]) green.copy(composed, p * 4, p * 4, p * 4 + 4);
    assert.deepEqual(await native.renderGraph({ ...scene, layers: [...scene.layers, generated] }), composed);
    const filtered = { ...generated, role: undefined, provenance: undefined, filters: [{ id: randomUUID(), kind: 'invert', value: 100, enabled: true, opacity: 1 }] };
    const context = { ...scene, layers: [...scene.layers, filtered] }, isolated = graph(width, height, [filtered]);
    const reference = Buffer.from(green); for (const p of fill === 0 ? [0, 1] : [0]) for (let c = 0; c < 3; c++) reference[p * 4 + c] = 255 - reference[p * 4 + c];
    assert.deepEqual(await native.renderGraph(isolated, { filterContextGraph: context }), reference);
  }
  const plain = await raster(native, body, width, height, { effects: wrap(.375) }), context = graph(width, height, [source, plain]);
  const original = native.protectedPixels; let calls = 0;
  native.protectedPixels = async function (...args) { calls++; return original.apply(this, args); };
  try { await native.renderGraph(graph(width, height, [plain]), { filterContextGraph: context }); }
  finally { native.protectedPixels = original; }
  assert.equal(calls, 0, 'A Fill-only wrapper must not introduce contextual prefix renders.');
});

test('Fill metadata editing covers all six content types without changing raw pixels, geometry or overall opacity', async t => {
  const { native } = await fixture(t), width = 8, height = 6;
  const layers = [
    await raster(native, image(width, height), width, height),
    base({ type: 'solid', width, height, transforms: [], color: '#4388c1' }),
    base({ type: 'text', width, height, transforms: [], text: 'I', x: 1, y: 0, fontSize: 6, color: '#ffaa33' }),
    base({ type: 'shape', width, height, transforms: [], vector: { shape: 'ellipse', x: 1, y: 1, width: 5, height: 4, fill: '#223344', stroke: '#ff0000', strokeWidth: 1 } }),
    base({ type: 'path', width, height, transforms: [], vector: { nodes: [{ x: 1, y: 1 }, { x: 6, y: 4 }], stroke: '#7799dd', strokeWidth: 2, fill: null } }),
    base({ type: 'gradient', width, height, transforms: [], gradient: { kind: 'linear', start: { x: 0, y: 0 }, end: { x: width, y: height }, stops: [{ offset: 0, color: '#2277aa', opacity: .2 }, { offset: 1, color: '#dd9944', opacity: 1 }] } }),
  ];
  for (const layer of layers) {
    layer.opacity = .5;
    let doc = await project(native, width, height, [layer]);
    const raw = await native.renderLayer(layer), original = stored(native, doc).layers[0];
    for (const fill of [0, .375, 1]) {
      doc = (await noPixels(native, () => edit(native, doc, 'set_layer_fill', { layerId: layer.id, fillOpacity: fill }))).document;
      const changed = stored(native, doc).layers[0];
      assert.equal(doc.layers[0].opacity, .5); assert.equal(doc.layers[0].fillOpacity ?? 1, fill);
      assert.deepEqual(await native.renderLayer(changed), raw, `${layer.type} Fill must not enter source generation`);
      assert.deepEqual(await native.renderGraph(stored(native, doc)), layerFillReference(Buffer.alloc(raw.length), raw, { opacity: .5, fillOpacity: fill }));
      if (fill === 1) assert.deepEqual(changed, original, `${layer.type} restores literal legacy metadata`);
    }
  }
});

test('Fill source/display consumers retain raw extraction, unfilled placement, rasterization and filtered Distort Bake', async t => {
  const samples = [], { native } = await fixture(t, { segmentSubject: async png => {
    const decoded = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); samples.push(decoded.data);
    return { alpha: Buffer.alloc(decoded.info.width * decoded.info.height, 255), width: decoded.info.width, height: decoded.info.height, model: 'independent-fill-audit' };
  } });
  const width = 3, height = 1, input = Buffer.from([7, 11, 19, 0, 201, 31, 79, 128, 23, 29, 37, 0]);
  const styles = { shadow: { color: '#204080', opacity: 1, blur: 0, x: 1, y: 0 } };
  const source = await raster(native, input, width, height, { opacity: .5, effects: wrap(0, styles) });
  let doc = await project(native, width, height, [source]);
  doc = (await edit(native, doc, 'load_layer_selection', { layerId: source.id, source: 'content' })).document;
  assert.deepEqual(doc.selection.runs, [1, 1, 128]);
  // Arrangement must inspect its body bounds; this is a real pixel-dependent
  // empty-body refusal, distinct from metadata-only clipping/type guards.
  await assert.rejects(edit(native, doc, 'align_layers', { layerIds: [source.id], relativeTo: 'canvas', axis: 'horizontal', alignment: 'start' }), { code: 'EMPTY_LAYER' });
  const display = await native.visibleLayerPixels(stored(native, doc), stored(native, doc).layers[0], { filters: false });
  doc = (await edit(native, doc, 'select_subject', { layerId: source.id })).document; assert.deepEqual(samples.at(-1), display);
  doc = (await edit(native, doc, 'extract_subject', { layerId: source.id, hideOriginal: false })).document;
  assert.deepEqual(samples.at(-1), input); const cutout = doc.layers.find(layer => layer.id !== source.id);
  assert.equal(cutout.fillOpacity, 0); assert.equal(cutout.protected, true); assert.equal(cutout.sourceAsset, source.sourceAsset);
  let destination = await project(native, width, height, []);
  destination = (await edit(native, destination, 'place_layer', { sourceDocumentId: doc.id, sourceExpectedRevision: doc.revision, sourceLayerId: source.id, x: 0, y: 0, width, height })).document;
  const placed = stored(native, destination).layers[0];
  assert.equal(destination.layers[0].fillOpacity, 0); assert.equal(placed.opacity, .5); assert.equal(placed.protected, true);
  assert.deepEqual([...await native.readAlpha(placed.alphaAsset, width, height)], [0, 128, 0]);
  assert.equal(placed.sourceAsset, source.sourceAsset); assert.deepEqual(layerOutsideEffects(placed), styles);
  const solid = base({ type: 'solid', width, height, transforms: [], color: '#406080', opacity: .5, effects: wrap(.375) });
  let solidDoc = await project(native, width, height, [solid]); const solidBefore = await native.renderGraph(stored(native, solidDoc));
  solidDoc = (await edit(native, solidDoc, 'rasterize_layer', { layerId: solid.id })).document;
  assert.equal(solidDoc.layers[0].fillOpacity, .375); assert.deepEqual(await native.renderGraph(stored(native, solidDoc)), solidBefore);
  assert.deepEqual([...await native.renderLayer(stored(native, solidDoc).layers[0])], [64, 96, 128, 255, 64, 96, 128, 255, 64, 96, 128, 255]);
  const w = 8, h = 2, original = image(w, h), grade = await raster(native, original, w, h, { effects: wrap(.375), opacity: .73,
    filters: { version: 1, entries: [{ id: randomUUID(), kind: 'invert', value: 100, enabled: true, opacity: .5, blendMode: 'multiply' }], mask: { sourceWidth: w, sourceHeight: h, enabled: true, density: .5, coverage: bitmap(Array.from({ length: w * h }, (_, p) => p * 47 % 256), w, h) } } });
  let graded = await project(native, w, h, [grade]);
  graded = (await edit(native, graded, 'add_layer_distort', { layerId: grade.id, corners: [{ x: 1, y: 0 }, { x: w + 1, y: 0 }, { x: w + 1, y: h }, { x: 1, y: h }] })).document;
  const before = stored(native, graded).layers[0], appearance = await native.renderGraph(stored(native, graded));
  graded = (await edit(native, graded, 'bake_layer_filters', { layerId: grade.id })).document;
  const baked = stored(native, graded).layers[0], raw = await sharp(await fs.readFile(path.join(native.assetsDir, baked.asset))).ensureAlpha().raw().toBuffer();
  assert.equal(graded.layers[0].fillOpacity, .375); assert.deepEqual(baked.effects, before.effects); assert.deepEqual(baked.transforms, before.transforms); assert.equal(baked.sourceAsset, grade.sourceAsset);
  for (let p = 0; p < w * h; p++) { assert.equal(raw[4 * p + 3], original[4 * p + 3]); if (!original[4 * p + 3]) assert.deepEqual(raw.subarray(p * 4, p * 4 + 3), original.subarray(p * 4, p * 4 + 3)); }
  assert.deepEqual(await native.renderGraph(stored(native, graded)), appearance);
});

test('Fill styles, recipes, opacity edits and explicit protection retain their independent metadata roles', async t => {
  const { native } = await fixture(t), source = await raster(native, image(4, 2), 4, 2, { effects: wrap(.375) });
  let doc = await project(native, 4, 2, [source]);
  await noPixels(native, () => assert.rejects(edit(native, doc, 'save_layer_style', { layerId: source.id, name: 'Empty style' }), { code: 'NO_LAYER_STYLE' }));
  doc = (await edit(native, doc, 'set_layer_effects', { layerId: source.id, effects: { glow: { color: '#123456', opacity: .75, blur: 0 } } })).document;
  assert.equal(doc.layers[0].fillOpacity, .375);
  doc = (await edit(native, doc, 'save_layer_style', { layerId: source.id, name: 'Decoration only' })).document;
  const style = doc.layerStyles[0]; assert.equal(Object.hasOwn(style, 'fillOpacity'), false); assert.deepEqual(Object.keys(style.effects), ['glow']);
  doc = (await edit(native, doc, 'set_layer_effects', { layerId: source.id, effects: null })).document;
  assert.equal(doc.layers[0].fillOpacity, .375); assert.equal(doc.layers[0].effects, undefined);
  doc = (await edit(native, doc, 'apply_layer_style', { styleId: style.id, layerIds: [source.id] })).document;
  assert.equal(doc.layers[0].fillOpacity, .375); assert.deepEqual(doc.layers[0].effects, style.effects);
  const saved = await edit(native, doc, 'save_edit_recipe', { name: 'Clear decoration', slots: [{ key: 'content', type: 'content' }], steps: [{ command: 'set_layer_effects', target: 'content', args: { effects: null } }] }); doc = saved.document;
  const definition = structuredClone(doc.editRecipes[0]);
  doc = (await edit(native, doc, 'apply_edit_recipe', { recipeId: saved.recipeId, bindings: { content: source.id } })).document;
  assert.equal(doc.layers[0].fillOpacity, .375); assert.deepEqual(doc.editRecipes[0], definition); assert.equal(doc.layers[0].effects, undefined);
  doc = (await edit(native, doc, 'set_layer', { layerId: source.id, opacity: .12345678901234568, visible: false })).document;
  assert.equal(doc.layers[0].fillOpacity, .375); assert.equal(doc.layers[0].opacity, .12345678901234568);
  doc = (await edit(native, doc, 'set_layer_protection', { layerId: source.id, protected: true })).document;
  doc = (await noPixels(native, () => edit(native, doc, 'set_layer_fill', { layerId: source.id, fillOpacity: .375 }))).document;
  await noPixels(native, () => assert.rejects(edit(native, doc, 'set_layer_fill', { layerId: source.id, fillOpacity: .5 }), { code: 'PROTECTED_LAYER' }), true);
  doc = (await edit(native, doc, 'apply_transaction', { operations: [
    { command: 'set_layer_protection', args: { layerId: source.id, protected: false } },
    { command: 'set_layer_fill', args: { layerId: source.id, fillOpacity: Number.MIN_VALUE } },
    { command: 'set_layer_protection', args: { layerId: source.id, protected: true } },
  ] })).document;
  assert.equal(doc.layers[0].fillOpacity, Number.MIN_VALUE); assert.equal(doc.layers[0].protected, true);
});

test('Fill structural, PSD and joined-resource refusals precede pixels and retain legacy style resource accounting', async t => {
  const { native } = await fixture(t), source = fake(2, 1, { effects: wrap(.375) }), member = fake(2, 1, { visible: false }), group = base({ type: 'group', mode: 'pass-through' }), grade = base({ type: 'adjustment', kind: 'brightness', value: 0 });
  let doc = await project(native, 2, 1, [source, member, group, grade]);
  await noPixels(native, async () => {
    for (const layerId of [group.id, grade.id]) await assert.rejects(edit(native, doc, 'set_layer_fill', { layerId, fillOpacity: 1 }), { code: 'INVALID_TARGET' });
    await assert.rejects(edit(native, doc, 'set_clipping_chain', { baseLayerId: source.id, layerIds: [member.id] }), { code: 'INVALID_TARGET' });
    const report = await native.inspectPsdExport({ documentId: doc.id, expectedRevision: doc.revision });
    assert.equal(report.supported, false); assert.ok(report.issues.some(issue => issue.code === 'FILL_UNSUPPORTED' && issue.layerId === source.id));
    await assert.rejects(native.exportPsd({ documentId: doc.id, expectedRevision: doc.revision }), error => error.code === 'PSD_UNSUPPORTED' && error.report.issues.some(issue => issue.code === 'FILL_UNSUPPORTED'));
  });
  doc = (await edit(native, doc, 'set_layer_fill', { layerId: source.id, fillOpacity: 1 })).document;
  const unlinked = structuredClone(doc);
  await noPixels(native, () => assert.rejects(edit(native, doc, 'apply_transaction', { operations: [
    { command: 'set_layer_fill', args: { layerId: source.id, fillOpacity: .5 } },
    { command: 'set_clipping_chain', args: { baseLayerId: source.id, layerIds: [member.id] } },
    { command: 'paint_stroke', args: { layerId: source.id, tool: 'brush', color: '#ff0000', size: 1, hardness: 1, opacity: 1, points: [{ x: 0, y: 0 }] } },
  ] }), { code: 'INVALID_TARGET' }), true);
  assert.deepEqual(await get(native, doc), unlinked);
  doc = (await edit(native, doc, 'set_clipping_chain', { baseLayerId: source.id, layerIds: [member.id] })).document;
  await noPixels(native, async () => { for (const layerId of [source.id, member.id]) await assert.rejects(edit(native, doc, 'set_layer_fill', { layerId, fillOpacity: .5 }), { code: 'INVALID_TARGET' }); }, true);
  const styles = { glow: { color: '#ffffff', opacity: .5, blur: 8 }, shadow: { color: '#000000', opacity: .35, blur: 8, x: 4, y: 6 } };
  const mask = { shape: 'alpha8', width: 4000, height: 4000, bytes: 16_000_032, asset: 'b'.repeat(64), x: 0, y: 0, feather: 0, invert: false };
  for (const fill of [0, Number.MIN_VALUE, .375]) {
    const ordinary = fake(4000, 4000, { effects: styles, mask, outline: { width: 1, color: '#ffffff' } }), wrapped = { ...ordinary, effects: wrap(fill, styles) };
    assert.deepEqual(estimateDenseMaskResources(graph(4000, 4000, [wrapped])), estimateDenseMaskResources(graph(4000, 4000, [ordinary])));
    assert.equal(denseDecorationBytes(wrapped, 4000, 4000), 240_080_008);
    await noPixels(native, async () => { assert.throws(() => native.validateGraph(graph(4000, 4000, [wrapped])), { code: 'LIMIT_EXCEEDED' }); }, true);
    const bare = fake(4000, 4000, { mask }), fillOnly = { ...bare, effects: wrap(fill) };
    assert.deepEqual(estimateDenseMaskResources(graph(4000, 4000, [fillOnly])), estimateDenseMaskResources(graph(4000, 4000, [bare])));
  }
  const onlyFill = fake(1, 1, { effects: wrap(0) });
  assert.deepEqual(preflightPsdExport(graph(1, 1, [onlyFill])).issues.map(issue => issue.code), ['FILL_UNSUPPORTED']);
  assert.equal(preflightPsdExport(graph(1, 1, [setLayerFillOpacity(onlyFill, 1)])).supported, true);
});

test('Fill current and retained history round-trip while malformed canonical portable wrappers fail before assets', async t => {
  const { native, dataDir } = await fixture(t), source = await raster(native, image(4, 2), 4, 2, { effects: wrap(.375), protected: true, visible: false });
  let doc = await project(native, 4, 2, [source]);
  const initial = stored(native, doc), bundle = await encodeProjectBundle({ graph: initial, validateGraph: value => native.validateGraph(value), readAsset: asset => fs.readFile(path.join(native.assetsDir, asset)) });
  const size = bundle.readUInt32BE(8), manifest = JSON.parse(bundle.subarray(12, 12 + size));
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const forged = value => { const bytes = Buffer.from(JSON.stringify(canonical({ ...manifest, graph: value }))), header = Buffer.from(bundle.subarray(0, 12)); header.writeUInt32BE(bytes.length, 8); return Buffer.concat([header, bytes, bundle.subarray(12 + size)]); };
  assert.deepEqual(decodeProjectBundle(forged(initial), { validateGraph: value => native.validateGraph(value) }).graph, initial, 'Canonical valid control retains the original image asset.');
  const transferred = (await native.importProject({ data: bundle })).document;
  assert.equal(transferred.layers[0].fillOpacity, .375); assert.equal(transferred.layers[0].protected, true); assert.equal(transferred.layers[0].effects, undefined);
  for (const patch of [{ fillOpacity: 1 }, { fillOpacity: .375 }, { effects: wrap(1) }, { effects: { version: 1, fillOpacity: .5 } },
    { effects: wrap(.5, {}) }, { effects: wrap(.5, { shadow: {} }) }, { effects: wrap(.5, { glow: { color: '#ffffff', opacity: .5 } }) }, { effects: wrap(null) }]) {
    const bad = { ...initial, layers: [{ ...initial.layers[0], ...patch, visible: false, opacity: 0 }] };
    await noPixels(native, () => assert.rejects(native.importProject({ data: forged(bad) }), { code: 'INVALID_PROJECT_BUNDLE' }), true);
  }
  doc = (await edit(native, doc, 'set_layer_protection', { layerId: source.id, protected: false })).document;
  doc = (await edit(native, doc, 'set_layer_fill', { layerId: source.id, fillOpacity: 1 })).document;
  assert.equal(doc.layers[0].fillOpacity, undefined);
  const reopened = await new NativeBackend({ dataDir }).init();
  try { assert.deepEqual(await get(reopened, doc), doc); assert.equal(reopened.projects.get(doc.id).states[0].graph.layers[0].effects.fillOpacity, .375); }
  finally { await reopened.close(); }
  const file = path.join(native.projectsDir, `${doc.id}.json`), saved = await fs.readFile(file), projectData = JSON.parse(saved);
  projectData.states[0].graph.layers[0].effects.styles = { shadow: {} }; await fs.writeFile(file, JSON.stringify(projectData));
  const reader = new NativeBackend({ dataDir }); let assetReads = 0;
  const previous = fs.readFile; fs.readFile = function (file, ...args) { if (String(file).startsWith(`${native.assetsDir}${path.sep}`)) { assetReads++; assert.fail('Malformed history read a pixel asset'); } return previous.call(this, file, ...args); };
  try { await reader.init(); assert.equal(reader.projects.has(doc.id), false); assert.ok(reader.loadWarnings.some(warning => warning.includes(doc.id))); }
  finally { fs.readFile = previous; await reader.close(); await fs.writeFile(file, saved); }
  assert.equal(assetReads, 0);
});

test('Fill real save failure and later pixel-transaction failure leave state, history and assets unchanged', async t => {
  const { native } = await fixture(t), source = await raster(native, image(8, 6), 8, 6, { effects: wrap(.375) });
  const doc = await project(native, 8, 6, [source]), assets = await files(native.assetsDir), projects = await files(native.projectsDir), directory = native.projectsDir;
  native.projectsDir = path.join(native.assetsDir, source.asset);
  try { await assert.rejects(edit(native, doc, 'set_layer_fill', { layerId: source.id, fillOpacity: .5 }), { code: 'ENOTDIR' }); }
  finally { native.projectsDir = directory; }
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await files(native.projectsDir), projects); assert.deepEqual(await files(native.assetsDir), assets);
  const original = native.storeAsset; let writes = 0;
  native.storeAsset = async function (...args) { writes++; return original.apply(this, args); };
  try { await assert.rejects(edit(native, doc, 'apply_transaction', { operations: [
    { command: 'set_layer_fill', args: { layerId: source.id, fillOpacity: .5 } },
    { command: 'paint_stroke', args: { layerId: source.id, tool: 'brush', color: '#ff0011', points: [{ x: 2, y: 2 }], size: 3, hardness: 1, opacity: 1 } },
    { command: 'set_layer', args: { layerId: randomUUID(), opacity: .5 } },
  ] }), { code: 'NOT_FOUND' }); }
  finally { native.storeAsset = original; }
  assert.ok(writes > 0, 'The later failure follows a real pixel asset write.');
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await files(native.projectsDir), projects); assert.deepEqual(await files(native.assetsDir), assets);
});
