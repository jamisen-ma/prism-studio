import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { normalizeEditRecipe } from '../server/edit-recipes.mjs';

const base = extra => ({ id: randomUUID(), name: 'Recipe audit layer', visible: true, opacity: 1, blendMode: 'normal', ...extra });
const image = (w, h, value) => Buffer.from(Array.from({ length: w * h }, (_, i) => typeof value === 'function' ? value(i % w, Math.floor(i / w), i) : value).flat());
const step = (command, target, args) => ({ command, target, args });
const filter = (kind, value = 0, extra = {}) => ({ id: randomUUID(), kind, value, enabled: true, opacity: 1, ...extra });
const mixer = () => ({ monochrome: false, red: [100, 0, 0, 0], green: [0, 100, 0, 0], blue: [0, 0, 100, 0], gray: [21.26, 71.52, 7.22, 0] });
const mapping = () => ({ stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }], reverse: false });
const levels = () => ({ black: 0, white: 255, gamma: 1, outputBlack: 0, outputWhite: 255 });
const curves = () => ({ points: [{ x: 0, y: 0 }, { x: 255, y: 255 }], channel: 'rgb' });
const edit = (native, doc, command, args = {}) => native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args });
const get = async (native, doc) => (await native.execute('get_document', { documentId: doc.id })).document;
const files = async directory => Object.fromEntries(await Promise.all((await fs.readdir(directory)).sort().map(async file => [file, await fs.readFile(path.join(directory, file))])));
const project = async (native, width, height, layers, extra = {}) => (await native.newProject({ name: 'Recipe independent audit', width, height, layers, selection: null, ...extra }, 'Audit fixture')).document;
const recipe = (steps = [step('add_layer_filter', 'photo', { kind: 'brightness', value: 12 })], slots = [{ key: 'photo', type: 'raster' }]) => ({ name: 'Reusable audit recipe', slots, steps });
const saved = (doc, id) => doc.editRecipes.find(item => item.id === id);
const noTransientIDs = layers => layers.map(layer => ({ ...layer, ...(layer.filters ? { filters: layer.filters.map(({ id, ...entry }) => entry) } : {}) }));
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-recipes-audit-'));
  const native = await new NativeBackend({ dataDir, segmentSubject: () => assert.fail('Recipes cannot invoke segmentation') }).init();
  t.after(async () => { await native.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { native, dataDir };
}
async function raster(native, pixels, width, height, extra = {}) {
  const asset = await native.storeAsset(await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer());
  return base({ type: 'raster', asset, sourceAsset: asset, sourceFormat: 'png', width, height, transforms: [], ...extra });
}
async function save(native, doc, definition) { const result = await edit(native, doc, 'save_edit_recipe', definition); return { doc: result.document, id: result.recipeId }; }
async function forbidPixelWork(native, run, filesystem = false) {
  const restorers = [], seen = [];
  for (const key of ['render', 'renderGraph', 'renderLayer', 'visibleLayerPixels', 'storeAsset', 'storeAlpha', 'readAlpha', 'readProjectAsset', 'validateProjectAsset', 'segmentSubject', ...(filesystem ? ['persist', 'commit'] : [])]) if (typeof native[key] === 'function') {
    const original = native[key]; native[key] = () => { seen.push(key); assert.fail(`Recipe unexpectedly called ${key}`); }; restorers.push(() => { native[key] = original; });
  }
  if (filesystem) for (const key of ['readFile', 'writeFile', 'open', 'rename', 'link', 'unlink', 'mkdir', 'stat']) {
    const original = fs[key]; fs[key] = () => { seen.push(`fs.${key}`); assert.fail(`Validation unexpectedly called fs.${key}`); }; restorers.push(() => { fs[key] = original; });
  }
  try { const value = await run(); assert.deepEqual(seen, []); return value; }
  finally { restorers.reverse().forEach(restore => restore()); }
}

test('saved parameterized configurations are complete independent defaults, while text reset instructions survive normalization', async t => {
  const { native } = await fixture(t), w = 8, h = 6;
  const photo = await raster(native, image(w, h, [31, 87, 142, 255]), w, h);
  const kinds = ['levels', 'curves', 'channel_mixer', 'gradient_map'];
  const old = [
    { black: 20, white: 220, gamma: 2, outputBlack: 30, outputWhite: 200 },
    { points: [{ x: 0, y: 255 }, { x: 255, y: 0 }], channel: 'blue' },
    { ...mixer(), red: [0, 100, 0, 15], green: [0, 0, 100, -15], gray: [100, 0, 0, 0] },
    { stops: [{ offset: 0, color: '#aa2200' }, { offset: 1, color: '#0033bb' }], reverse: true },
  ];
  const adjustments = kinds.map((kind, index) => base({ type: 'adjustment', kind, value: 0, parameters: old[index], opacity: 0.8, mask: { x: 0, y: 0, width: 3, height: 4 }, maskDensity: 0.25 }));
  const text = base({ type: 'text', width: w, height: h, transforms: [], text: 'A\n\nB', x: 0, y: 0, fontSize: 3, color: '#ABCDEF', fontFamily: 'serif', fontWeight: 'bold', fontStyle: 'italic', align: 'center', tracking: 123, leading: 5.25 });
  let doc = await project(native, w, h, [photo, ...adjustments, text]);
  const slots = [{ key: 'photo', type: 'raster' }, ...kinds.map(kind => ({ key: kind, type: 'adjustment', kind })), { key: 'title', type: 'text' }];
  // Existing public levels/curves accept either no parameters (defaults) or a
  // complete parameter object. Mixer/map additionally accept partial settings.
  const sparse = [undefined, undefined, { monochrome: true }, { reverse: true }];
  const expected = [levels(), curves(), { ...mixer(), monochrome: true }, { ...mapping(), reverse: true }];
  const definition = recipe([
    ...kinds.map((kind, i) => step('add_layer_filter', 'photo', { kind, value: 0, ...(sparse[i] ? { parameters: sparse[i] } : {}) })),
    ...kinds.map((kind, i) => step('update_adjustment', kind, { value: 0, ...(sparse[i] ? { parameters: sparse[i] } : {}) })),
    step('update_text', 'title', { tracking: 0, leading: null, color: '#FFFFFF' }),
  ], slots);
  const accepted = await save(native, doc, definition); doc = accepted.doc;
  const canonical = saved(doc, accepted.id);
  for (let i = 0; i < kinds.length; i++) {
    assert.deepEqual(canonical.steps[i].args.parameters, expected[i]); assert.equal(canonical.steps[i].args.enabled, true); assert.equal(canonical.steps[i].args.opacity, 1);
    assert.deepEqual(canonical.steps[i + kinds.length].args.parameters, expected[i]);
  }
  assert.deepEqual(canonical.steps.at(-1).args, { tracking: 0, leading: null, color: '#ffffff' });
  definition.steps[2].args.parameters.monochrome = false; canonical.steps[2].args.parameters.gray[0] = 200;
  const preserved = saved(await get(native, doc), accepted.id).steps[2].args.parameters;
  assert.equal(preserved.monochrome, true); assert.equal(preserved.gray[0], 21.26);
  const bindings = Object.fromEntries([['photo', photo.id], ...kinds.map((kind, i) => [kind, adjustments[i].id]), ['title', text.id]]);
  doc = (await edit(native, doc, 'apply_edit_recipe', { recipeId: accepted.id, bindings })).document;
  for (let i = 0; i < kinds.length; i++) {
    const layer = doc.layers[i + 1]; assert.deepEqual(layer.parameters, expected[i]);
    for (const key of ['mask', 'maskDensity', 'opacity', 'visible', 'name', 'kind']) assert.deepEqual(layer[key], adjustments[i][key]);
  }
  const changedText = doc.layers.at(-1); assert.equal(changedText.tracking, undefined); assert.equal(changedText.leading, undefined);
  for (const key of ['text', 'x', 'y', 'fontSize', 'fontFamily', 'fontWeight', 'fontStyle', 'align', 'width', 'height', 'transforms']) assert.deepEqual(changedText[key], text[key]);
});

test('one multi-target recipe binds three unrelated documents and matches explicit commands with exact immutable sources', async t => {
  const { native } = await fixture(t), width = 64, height = 48, allIDs = new Set();
  const definition = recipe([
    step('add_layer_filter', 'photo', { kind: 'temperature', value: 12 }),
    step('add_layer_filter', 'photo', { kind: 'gradient_map', value: 0, parameters: { reverse: true } }),
    step('update_adjustment', 'grade', { value: 0, parameters: { monochrome: true } }),
    step('update_text', 'title', { tracking: 0, leading: null, fontFamily: 'Fraunces', color: '#855F44' }),
    step('set_layer_effects', 'subject', { effects: { shadow: { blur: 0, x: 2, y: 1 } } }),
    step('set_layer_outline', 'subject', { width: 1 }),
  ], [{ key: 'photo', type: 'raster' }, { key: 'grade', type: 'adjustment', kind: 'channel_mixer' }, { key: 'title', type: 'text' }, { key: 'subject', type: 'content' }]);
  const expectedArgs = [
    { kind: 'temperature', value: 12, enabled: true, opacity: 1 },
    { kind: 'gradient_map', value: 0, parameters: { ...mapping(), reverse: true }, enabled: true, opacity: 1 },
    { value: 0, parameters: { ...mixer(), monochrome: true } },
    { tracking: 0, leading: null, fontFamily: 'Fraunces', color: '#855f44' },
    { effects: { shadow: { blur: 0, x: 2, y: 1, color: '#000000', opacity: 0.35 } } },
    { width: 1, color: '#ffffff' },
  ];
  for (let variant = 0; variant < 3; variant++) {
    const photo = await raster(native, image(width, height, (x, y) => [30 + x * 2 + variant, 40 + y * 2, 170 - x, 255]), width, height);
    const person = await raster(native, image(width, height, (x, y) => [190, 120, 70, x >= 4 && x < 12 && y >= 4 && y < 12 ? 255 : 0]), width, height, { protected: true });
    const grade = base({ type: 'adjustment', kind: 'channel_mixer', value: 0, parameters: { ...mixer(), gray: [100, 0, 0, 0] }, mask: { x: 0, y: 0, width: 50, height: 40 }, maskDensity: 0.4 });
    const title = base({ type: 'text', width, height, transforms: [], text: `Cover ${variant}`, x: 20, y: 24, fontSize: 10, color: '#ffffff', fontFamily: 'sans-serif', fontWeight: 'normal', fontStyle: 'normal', align: 'left', tracking: 90, leading: 14.25 });
    for (const layer of [photo, person, grade, title]) { assert.ok(!allIDs.has(layer.id)); allIDs.add(layer.id); }
    const selection = variant === 0 ? null : variant === 1 ? { shape: 'bitmap', x: 0, y: 0, width, height, feather: 0, invert: false, runs: [] } : { x: 30, y: 30, width: 2, height: 2 };
    let actual = await project(native, width, height, [photo, person, grade, title], { selection });
    let control = await project(native, width, height, [photo, person, grade, title], { selection });
    const start = structuredClone(actual), bindings = { photo: photo.id, subject: person.id, grade: grade.id, title: title.id };
    const accepted = await save(native, actual, definition); actual = accepted.doc;
    const beforeApply = structuredClone(actual), assets = await files(native.assetsDir);
    const report = await edit(native, actual, 'validate_edit_recipe', { recipeId: accepted.id, bindings }); assert.equal(report.valid, true);
    actual = (await edit(native, actual, 'apply_edit_recipe', { recipeId: accepted.id, bindings })).document;
    for (let i = 0; i < definition.steps.length; i++) control = (await edit(native, control, definition.steps[i].command, { layerId: bindings[definition.steps[i].target], ...expectedArgs[i] })).document;
    assert.deepEqual(noTransientIDs(actual.layers), noTransientIDs(control.layers)); assert.deepEqual(await native.renderGraph(actual), await native.renderGraph(control));
    assert.equal(actual.revision, beforeApply.revision + 1); assert.equal(actual.history.length, beforeApply.history.length + 1);
    assert.deepEqual(actual.selection, start.selection); assert.deepEqual(await files(native.assetsDir), assets);
    const pixels = await native.renderGraph(actual); assert.deepEqual([...pixels.subarray((6 * width + 6) * 4, (6 * width + 6) * 4 + 4)], [190, 120, 70, 255]);
    const undone = (await edit(native, actual, 'undo')).document; assert.deepEqual(undone.layers, beforeApply.layers);
  }
});

test('validation is stable metadata-only work and apply never enters source, asset, font-render or model paths', async t => {
  const { native } = await fixture(t), width = 8, height = 6;
  const photo = await raster(native, image(width, height, [28, 65, 145, 255]), width, height);
  const grade = base({ type: 'adjustment', kind: 'brightness', value: 0 });
  const text = base({ type: 'text', width, height, transforms: [], text: 'A', x: 0, y: 0, fontSize: 3, color: '#ffffff', fontFamily: 'serif', fontWeight: 'normal', fontStyle: 'normal', align: 'left' });
  let doc = await project(native, width, height, [photo, grade, text]);
  const accepted = await save(native, doc, recipe([
    step('add_layer_filter', 'photo', { kind: 'brightness', value: 12 }),
    step('update_adjustment', 'grade', { value: 5 }),
    step('update_text', 'title', { fontFamily: 'Fraunces', tracking: 50 }),
    step('set_layer_effects', 'photo', { effects: { shadow: { blur: 2 } } }),
    step('set_layer_outline', 'photo', { width: 1 }),
  ], [{ key: 'photo', type: 'raster' }, { key: 'grade', type: 'adjustment', kind: 'brightness' }, { key: 'title', type: 'text' }])); doc = accepted.doc;
  await native.execute('get_preview', { documentId: doc.id, maxWidth: 32 });
  const assets = await files(native.assetsDir), projects = await files(native.projectsDir), cache = native.previewCache.stats();
  // A missing source is deliberately unrelated to metadata validation/apply.
  const asset = path.join(native.assetsDir, photo.asset), absent = `${asset}.fixture`; await fs.rename(asset, absent);
  const args = { recipeId: accepted.id, bindings: { photo: photo.id, grade: grade.id, title: text.id } };
  try {
    const [first, second] = await forbidPixelWork(native, async () => [await edit(native, doc, 'validate_edit_recipe', args), await edit(native, doc, 'validate_edit_recipe', args)], true);
    assert.equal(first.valid, true); assert.deepEqual(first, second); assert.deepEqual(first.bindings, args.bindings);
    assert.equal(first.changes.length, 5); assert.equal(JSON.stringify(first).includes('filterId'), false);
    assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await files(native.projectsDir), projects); assert.deepEqual(native.previewCache.stats(), cache);
    const result = await forbidPixelWork(native, () => edit(native, doc, 'apply_edit_recipe', args));
    assert.equal(result.appliedSteps, 5); assert.equal(result.document.layers[0].filters.length, 1);
  } finally { await fs.rename(absent, asset); }
  assert.deepEqual(await files(native.assetsDir), assets);
});

test('binding and protected-target faults reject atomically, including late cumulative filter overflow and unsupported clipping styles', async t => {
  const { native } = await fixture(t), width = 8, height = 6;
  const a = await raster(native, image(width, height, [34, 81, 130, 255]), width, height), b = { ...a, id: randomUUID(), name: 'Other' };
  let doc = await project(native, width, height, [a, b]);
  const accepted = await save(native, doc, recipe([step('add_layer_filter', 'a', { kind: 'invert', value: 100 }), step('add_layer_filter', 'b', { kind: 'brightness', value: 8 })], [{ key: 'a', type: 'raster' }, { key: 'b', type: 'raster' }])); doc = accepted.doc;
  const assets = await files(native.assetsDir);
  for (const bindings of [{ a: a.id }, { a: a.id, b: b.id, extra: b.id }, { a: a.id, b: a.id }, { a: a.id, b: randomUUID() }]) {
    const report = await edit(native, doc, 'validate_edit_recipe', { recipeId: accepted.id, bindings }); assert.equal(report.valid, false); assert.deepEqual(report.changes, []);
    await assert.rejects(edit(native, doc, 'apply_edit_recipe', { recipeId: accepted.id, bindings })); assert.deepEqual(await get(native, doc), doc);
  }
  doc = (await edit(native, doc, 'set_layer_protection', { layerId: b.id, protected: true })).document;
  const failed = await edit(native, doc, 'validate_edit_recipe', { recipeId: accepted.id, bindings: { a: a.id, b: b.id } }); assert.equal(failed.valid, false); assert.equal(failed.issues[0].stepIndex, 1);
  await assert.rejects(edit(native, doc, 'apply_edit_recipe', { recipeId: accepted.id, bindings: { a: a.id, b: b.id } }), { code: 'PROTECTED_LAYER' }); assert.equal((await get(native, doc)).layers[0].filters, undefined);
  doc = (await edit(native, doc, 'set_layer_protection', { layerId: b.id, protected: false })).document;
  for (let i = 0; i < 7; i++) doc = (await edit(native, doc, 'add_layer_filter', { layerId: a.id, kind: 'brightness', value: i })).document;
  const overflow = await save(native, doc, recipe([step('add_layer_filter', 'photo', { kind: 'invert', value: 50 }), step('add_layer_filter', 'photo', { kind: 'grayscale', value: 50 })])); doc = overflow.doc;
  const report = await edit(native, doc, 'validate_edit_recipe', { recipeId: overflow.id, bindings: { photo: a.id } }); assert.equal(report.valid, false); assert.equal(report.issues[0].stepIndex, 1);
  await assert.rejects(edit(native, doc, 'apply_edit_recipe', { recipeId: overflow.id, bindings: { photo: a.id } }), { code: 'LIMIT_EXCEEDED' }); assert.deepEqual(await get(native, doc), doc);
  doc = (await edit(native, doc, 'set_clipping_chain', { baseLayerId: a.id, layerIds: [b.id] })).document;
  const style = await save(native, doc, recipe([step('set_layer_effects', 'member', { effects: { glow: {} } })], [{ key: 'member', type: 'content' }])); doc = style.doc;
  const styleReport = await edit(native, doc, 'validate_edit_recipe', { recipeId: style.id, bindings: { member: b.id } }); assert.equal(styleReport.valid, false);
  await assert.rejects(edit(native, doc, 'apply_edit_recipe', { recipeId: style.id, bindings: { member: b.id } })); assert.deepEqual(await get(native, doc), doc);
  assert.deepEqual(await files(native.assetsDir), assets);
});

test('hidden raster work budgets fail before image access and after each complete staged candidate', async t => {
  const { native } = await fixture(t), width = 6000, height = 4000;
  const photo = base({ type: 'raster', width, height, transforms: [], visible: false, asset: 'a'.repeat(64), sourceAsset: 'a'.repeat(64), sourceFormat: 'png' });
  let doc = await project(native, width, height, [photo]);
  const accepted = await save(native, doc, recipe([step('add_layer_filter', 'photo', { kind: 'brightness', value: 10 }), step('add_layer_filter', 'photo', { kind: 'median', value: 15 })])); doc = accepted.doc;
  const report = await forbidPixelWork(native, () => edit(native, doc, 'validate_edit_recipe', { recipeId: accepted.id, bindings: { photo: photo.id } }), true);
  assert.equal(report.valid, false); assert.equal(report.issues[0].stepIndex, 1); assert.equal(report.issues[0].code, 'LIMIT_EXCEEDED');
  await forbidPixelWork(native, () => assert.rejects(edit(native, doc, 'apply_edit_recipe', { recipeId: accepted.id, bindings: { photo: photo.id } }), { code: 'LIMIT_EXCEEDED' }));
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await fs.readdir(native.assetsDir), []);
});

test('real publication failure and stale/missing revisions preserve recipe, graph, history, cache and immutable files', async t => {
  const { native } = await fixture(t), width = 8, height = 6;
  const photo = await raster(native, image(width, height, [32, 88, 140, 255]), width, height); let doc = await project(native, width, height, [photo]);
  const accepted = await save(native, doc, recipe()); doc = accepted.doc;
  const args = { recipeId: accepted.id, bindings: { photo: photo.id } };
  await native.execute('get_preview', { documentId: doc.id, maxWidth: 32 });
  const projects = await files(native.projectsDir), assets = await files(native.assetsDir), cache = native.previewCache.stats();
  await assert.rejects(native.execute('apply_edit_recipe', { documentId: doc.id, ...args }));
  await assert.rejects(edit(native, doc, 'apply_edit_recipe', { ...args, expectedRevision: doc.revision - 1 }), { code: 'REVISION_CONFLICT' });
  const dir = native.projectsDir; native.projectsDir = path.join(native.assetsDir, photo.asset);
  try { await assert.rejects(edit(native, doc, 'apply_edit_recipe', args), { code: 'ENOTDIR' }); }
  finally { native.projectsDir = dir; }
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await files(native.projectsDir), projects); assert.deepEqual(await files(native.assetsDir), assets); assert.deepEqual(native.previewCache.stats(), cache);
  const result = await edit(native, doc, 'apply_edit_recipe', args); assert.equal(result.document.layers[0].filters.length, 1);
});

test('portable recipes are inert and malformed definitions reject before asset decode, reads or publication', async t => {
  const { native, dataDir } = await fixture(t), width = 8, height = 6;
  const photo = await raster(native, image(width, height, [20, 75, 153, 255]), width, height); let doc = await project(native, width, height, [photo]);
  const before = await native.renderGraph(doc), accepted = await save(native, doc, recipe()); doc = accepted.doc;
  assert.deepEqual(await native.renderGraph(doc), before);
  const output = await native.exportProject({ documentId: doc.id }), valid = output.data;
  const imported = (await native.importProject({ data: valid })).document; assert.deepEqual(imported.editRecipes, doc.editRecipes); assert.deepEqual(await native.renderGraph(imported), before);
  const reopened = await new NativeBackend({ dataDir }).init(); t.after(() => reopened.close()); assert.deepEqual((await get(reopened, doc)).editRecipes, doc.editRecipes);
  const length = valid.readUInt32BE(8), manifest = JSON.parse(valid.subarray(12, 12 + length));
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const mutations = [
    record => { record.version = 2; },
    record => { record.steps[0].args.layerId = photo.id; },
    record => { record.steps[0].command = 'paint_stroke'; },
    record => { record.steps[0].target = 'not_declared'; },
    record => { record.slots.push({ key: 'unused', type: 'raster' }); },
    record => { record.steps = Array.from({ length: 31 }, () => structuredClone(record.steps[0])); },
    record => { record.steps[0].args = { kind: 'channel_mixer', value: 0, parameters: { red: [100.001, 0, 0, 0] } }; },
  ];
  const projects = await files(native.projectsDir), assets = await files(native.assetsDir);
  for (const mutate of mutations) {
    const candidate = structuredClone(manifest); mutate(candidate.graph.editRecipes[0]);
    const body = Buffer.from(JSON.stringify(canonical(candidate))), prefix = Buffer.from(valid.subarray(0, 12)); prefix.writeUInt32BE(body.length, 8);
    const data = Buffer.concat([prefix, body, valid.subarray(12 + length)]);
    await forbidPixelWork(native, () => assert.rejects(native.importProject({ data })), true);
    assert.deepEqual(await files(native.projectsDir), projects); assert.deepEqual(await files(native.assetsDir), assets);
  }
});

test('metadata validation predicts the real 16 MiB prospective history boundary without publishing or truncating current history', async t => {
  const { native } = await fixture(t), width = 8, height = 6, maxBytes = 16 * 1024 * 1024;
  const photo = await raster(native, image(width, height, [25, 70, 130, 255]), width, height);
  const small = normalizeEditRecipe({ id: randomUUID(), version: 1, ...recipe() });
  const stops = Array.from({ length: 16 }, (_, i) => ({ offset: i / 15, color: `#${(i * 100000).toString(16).padStart(6, '0')}` }));
  const largeDefinition = recipe(Array.from({ length: 30 }, () => step('add_layer_filter', 'photo', { kind: 'gradient_map', value: 0, parameters: { stops, reverse: true } })));
  const library = [small];
  while (library.length < 16) {
    const next = normalizeEditRecipe({ id: randomUUID(), version: 1, ...largeDefinition });
    if (Buffer.byteLength(JSON.stringify([...library, next])) > 240000) break;
    library.push(next);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(library)) > 180000);
  let doc = await project(native, width, height, [photo], { editRecipes: library });
  const stored = native.projects.get(doc.id), graph = stored.states[0].graph;
  const state = { graph, history: { id: randomUUID(), label: 'Legal large recipe snapshot', timestamp: new Date().toISOString() } };
  const oneSize = Buffer.byteLength(JSON.stringify(state));
  let count = Math.floor((maxBytes - 1024) / (oneSize + 1)); assert.ok(count > 1 && count < 100);
  const envelope = n => ({ ...stored, revision: n, cursor: n - 1, states: Array.from({ length: n }, () => state) });
  while (Buffer.byteLength(JSON.stringify(envelope(count))) > maxBytes) count--;
  while (Buffer.byteLength(JSON.stringify(envelope(count + 1))) <= maxBytes) count++;
  const full = envelope(count); await native.persist(full); doc = await get(native, doc);
  const projectFile = path.join(native.projectsDir, `${doc.id}.json`), original = await fs.readFile(projectFile);
  assert.ok(original.length <= maxBytes); assert.ok(Buffer.byteLength(JSON.stringify(envelope(count + 1))) > maxBytes);
  const args = { recipeId: small.id, bindings: { photo: photo.id } };
  const report = await forbidPixelWork(native, () => edit(native, doc, 'validate_edit_recipe', args), true);
  assert.equal(report.valid, false); assert.equal(report.issues[0].code, 'LIMIT_EXCEEDED'); assert.equal(report.issues[0].stepIndex, undefined, 'Failure is prospective project publication after the valid step');
  await assert.rejects(edit(native, doc, 'apply_edit_recipe', args), { code: 'LIMIT_EXCEEDED' });
  assert.deepEqual(await fs.readFile(projectFile), original); assert.deepEqual(await get(native, doc), doc); assert.equal(native.projects.get(doc.id).states.length, count);
});
