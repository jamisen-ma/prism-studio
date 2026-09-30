import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { normalizeEditRecipe, normalizeEditRecipes, editRecipeHash, EDIT_RECIPE_LIMITS } from '../server/edit-recipes.mjs';

const coded = code => cause => cause.code === code;
const edit = async (native, doc, command, args = {}) => (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document;
const get = async (native, doc) => (await native.execute('get_document', { documentId: doc.id })).document;
const graphOf = (native, doc) => { const project = native.project(doc.id); return structuredClone(project.states[project.cursor].graph); };
const recipe = () => ({ name: 'Warm cover', slots: [{ key: 'photo', type: 'raster' }, { key: 'grade', type: 'adjustment', kind: 'channel_mixer' }, { key: 'title', type: 'text' }], steps: [
  { command: 'add_layer_filter', target: 'photo', args: { kind: 'temperature', value: 12 } },
  { command: 'update_adjustment', target: 'grade', args: { value: 0, parameters: { red: [90, 10, 0, 0] } } },
  { command: 'update_text', target: 'title', args: { color: '#FFEEAA', tracking: 0, leading: null, fontStyle: 'italic' } },
  { command: 'set_layer_effects', target: 'title', args: { effects: { shadow: { color: '#223344' } } } },
  { command: 'set_layer_outline', target: 'title', args: { width: 1 } },
] });
const filterRecipe = (steps = 1) => ({ name: 'Photo treatment', slots: [{ key: 'photo', type: 'raster' }], steps: Array.from({ length: steps }, () => ({ command: 'add_layer_filter', target: 'photo', args: { kind: 'temperature', value: 12 } })) });
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-recipes-'));
  const native = await new NativeBackend({ dataDir }).init();
  t.after(async () => { await native.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const width = 60, height = 40, pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set([20 + i % 180, 50 + i % 120, 80, 255], i);
  const original = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
  let doc = (await native.execute('import_image', { data: original.toString('base64'), mimeType: 'image/png', name: 'Cover' })).document;
  const photo = doc.layers[0].id;
  doc = await edit(native, doc, 'add_adjustment', { kind: 'channel_mixer', value: 0, parameters: { green: [20, 60, 20, 10], gray: [0, 0, 100, 0] } }); const grade = doc.layers.at(-1).id;
  doc = await edit(native, doc, 'add_text', { text: 'Autumn', x: 4, y: 5, fontSize: 12, color: '#ffffff', tracking: 100, leading: 30 }); const title = doc.layers.at(-1).id;
  doc = await edit(native, doc, 'select_rectangle', { x: 0, y: 0, width: 2, height: 2 });
  return { native, doc, dataDir, original, bindings: { photo, grade, title } };
}
async function save(native, doc, definition = recipe()) {
  return native.execute('save_edit_recipe', { documentId: doc.id, expectedRevision: doc.revision, ...definition });
}

test('canonical recipes fill color/effect defaults and retain text reset instructions as independent plain copies', () => {
  const input = { id: randomUUID(), version: 1, ...recipe() }, canonical = normalizeEditRecipe(input);
  assert.deepEqual(canonical.steps[0].args, { kind: 'temperature', value: 12, enabled: true, opacity: 1 });
  assert.deepEqual(canonical.steps[1].args.parameters.green, [0, 100, 0, 0]); assert.deepEqual(canonical.steps[1].args.parameters.gray, [21.26, 71.52, 7.22, 0]);
  assert.equal(canonical.steps[2].args.tracking, 0); assert.equal(canonical.steps[2].args.leading, null); assert.equal(canonical.steps[2].args.color, '#ffeeaa');
  assert.deepEqual(canonical.steps[3].args.effects.shadow, { color: '#223344', opacity: 0.35, blur: 8, x: 4, y: 6 });
  assert.deepEqual(canonical.steps[4].args, { width: 1, color: '#ffffff' });
  const hash = editRecipeHash(canonical); input.steps[0].args.value = 99; canonical.steps[0].args.value = 50;
  assert.notEqual(editRecipeHash(input), hash); assert.notEqual(editRecipeHash(canonical), hash);
  const map = normalizeEditRecipe({ id: randomUUID(), version: 1, name: 'Map', slots: [{ key: 'grade', type: 'adjustment', kind: 'gradient_map' }], steps: [{ command: 'update_adjustment', target: 'grade', args: { value: 0 } }] });
  assert.deepEqual(map.steps[0].args.parameters, { stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }], reverse: false });
});

test('recipe application equals explicit commands, keeps source/selection/content/geometry and commits one reversible step', async t => {
  const { native, doc: initial, bindings, original } = await fixture(t); let saved = await save(native, initial), doc = saved.document;
  const prior = doc, graph = graphOf(native, doc), savedRecipe = doc.editRecipes[0];
  const explicit = structuredClone(graph);
  for (const step of savedRecipe.steps) { await native.mutate(explicit, step.command, { layerId: bindings[step.target], ...step.args }); native.validateGraph(explicit); }
  const expected = await native.renderGraph(explicit), before = await native.render(native.project(doc.id));
  const applied = await native.execute('apply_edit_recipe', { documentId: doc.id, expectedRevision: doc.revision, recipeId: saved.recipeId, bindings }); doc = applied.document;
  assert.equal(applied.appliedSteps, 5); assert.equal(doc.revision, prior.revision + 1); assert.equal(doc.history.length, prior.history.length + 1);
  assert.deepEqual(await native.render(native.project(doc.id)), expected); assert.deepEqual(doc.selection, prior.selection);
  assert.deepEqual(doc.layers.map(layer => [layer.id, layer.asset, layer.sourceAsset, layer.transforms]), prior.layers.map(layer => [layer.id, layer.asset, layer.sourceAsset, layer.transforms]));
  assert.equal(doc.layers[2].text, 'Autumn'); assert.equal(doc.layers[2].x, 4); assert.equal(doc.layers[2].tracking, undefined); assert.equal(doc.layers[2].leading, undefined);
  assert.deepEqual(doc.layers[1].parameters.green, [0, 100, 0, 0]); assert.deepEqual(doc.editRecipes, prior.editRecipes);
  doc = await edit(native, doc, 'undo'); assert.deepEqual(await native.render(native.project(doc.id)), before);
  doc = await edit(native, doc, 'redo'); assert.deepEqual(await native.render(native.project(doc.id)), expected);
  assert.deepEqual(await fs.readFile(path.join(native.assetsDir, doc.layers[0].sourceAsset)), original);
});

test('validation is stable metadata-only, has no transient IDs, and leaves assets/history/cache untouched', async t => {
  const { native, doc: initial, bindings } = await fixture(t), saved = await save(native, initial), doc = saved.document;
  const preview = await native.execute('get_preview', { documentId: doc.id, maxWidth: 100 });
  const disk = await fs.readFile(path.join(native.projectsDir, `${doc.id}.json`)), assets = await fs.readdir(native.assetsDir);
  const blocked = ['renderGraph', 'renderLayer', 'sourcePixels', 'storeAsset', 'storeAlpha', 'readAlpha', 'persist'];
  const originals = new Map(blocked.map(key => [key, native[key]]));
  for (const key of blocked) native[key] = async () => { throw new Error(`Forbidden metadata-only side effect: ${key}`); };
  native.segmentSubject = async () => { throw new Error('Forbidden model call'); };
  const args = { documentId: doc.id, expectedRevision: doc.revision, recipeId: saved.recipeId, bindings };
  const first = await native.execute('validate_edit_recipe', args), second = await native.execute('validate_edit_recipe', args);
  assert.deepEqual(first, second); assert.equal(first.valid, true); assert.equal(first.validation, 'metadata-only'); assert.equal(first.changes.length, 5);
  assert.deepEqual(first.bindings, bindings); assert.ok(first.changes.every(change => !Object.hasOwn(change, 'filterId')));
  for (const [key, fn] of originals) native[key] = fn;
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await fs.readFile(path.join(native.projectsDir, `${doc.id}.json`)), disk); assert.deepEqual(await fs.readdir(native.assetsDir), assets);
  assert.deepEqual(await native.execute('get_preview', { documentId: doc.id, maxWidth: 100 }), preview);
});

test('missing, extra, duplicate, wrong-kind and incompatible bindings report bounded issues and never apply a partial graph', async t => {
  const { native, doc: initial, bindings } = await fixture(t), saved = await save(native, initial), doc = saved.document;
  const args = { documentId: doc.id, expectedRevision: doc.revision, recipeId: saved.recipeId };
  for (const map of [{}, { ...bindings, extra: randomUUID() }, { ...bindings, photo: bindings.title }, { ...bindings, grade: bindings.photo }, { ...bindings, title: randomUUID() }]) {
    const report = await native.execute('validate_edit_recipe', { ...args, bindings: map });
    assert.equal(report.valid, false); assert.deepEqual(report.changes, []); assert.ok(report.issues.length > 0 && report.issues.length <= 16);
    await assert.rejects(native.execute('apply_edit_recipe', { ...args, bindings: map }), coded(report.issues[0].code));
  }
  const graph = graphOf(native, doc); graph.layers[1].kind = 'gradient_map'; graph.layers[1].parameters = { stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }], reverse: false };
  const copy = (await native.newProject(graph, 'Other adjustment kind')).document;
  const report = await native.execute('validate_edit_recipe', { documentId: copy.id, recipeId: saved.recipeId, bindings }); assert.equal(report.valid, false); assert.equal(report.issues[0].target, 'grade');
  assert.deepEqual(await get(native, doc), doc);
});

test('cumulative filter caps and protected targets reject on the staged step before image access', async t => {
  const { native, doc: initial, bindings } = await fixture(t); let saved = await save(native, initial, filterRecipe(9)), doc = saved.document;
  const args = { documentId: doc.id, recipeId: saved.recipeId, bindings: { photo: bindings.photo } };
  let report = await native.execute('validate_edit_recipe', args); assert.equal(report.valid, false); assert.equal(report.issues[0].code, 'LIMIT_EXCEEDED'); assert.equal(report.issues[0].stepIndex, 8);
  await assert.rejects(native.execute('apply_edit_recipe', { ...args, expectedRevision: doc.revision }), coded('LIMIT_EXCEEDED')); assert.equal((await get(native, doc)).layers[0].filters, undefined);
  doc = await edit(native, doc, 'set_layer_protection', { layerId: bindings.photo, protected: true });
  report = await native.execute('validate_edit_recipe', args); assert.equal(report.valid, false); assert.equal(report.issues[0].code, 'PROTECTED_LAYER'); assert.equal(report.issues[0].stepIndex, 0);
  const styles = { name: 'Protected outside', slots: [{ key: 'photo', type: 'content' }], steps: [{ command: 'set_layer_outline', target: 'photo', args: { width: 2, color: '#ffffff' } }] };
  saved = await save(native, doc, styles); doc = saved.document;
  assert.equal((await native.execute('validate_edit_recipe', { ...args, recipeId: saved.recipeId })).valid, true);
  doc = await edit(native, doc, 'apply_edit_recipe', { recipeId: saved.recipeId, bindings: { photo: bindings.photo } }); assert.equal(doc.layers[0].protected, true); assert.equal(doc.layers[0].outline.width, 2);
});

test('library copies, overwrite at capacity, rename/delete undo and portable reopening remain independent and preserve original assets', async t => {
  const { native, doc: initial, dataDir, original } = await fixture(t); let doc = initial, firstId;
  assert.deepEqual(doc.editRecipes, []);
  for (let i = 0; i < EDIT_RECIPE_LIMITS.maxRecipes; i++) { const saved = await save(native, doc, { ...filterRecipe(), name: `Style ${i}` }); doc = saved.document; firstId ??= saved.recipeId; }
  await assert.rejects(save(native, doc, filterRecipe()), coded('LIMIT_EXCEEDED'));
  const updated = await native.execute('save_edit_recipe', { documentId: doc.id, recipeId: firstId, ...filterRecipe(), name: 'Replaced' }); doc = updated.document;
  assert.equal(updated.recipeId, firstId); assert.equal(doc.editRecipes.length, 16);
  const inspected = await native.execute('get_edit_recipe', { documentId: doc.id, recipeId: firstId }); inspected.recipe.steps[0].args.value = 99;
  assert.equal((await native.execute('get_edit_recipe', { documentId: doc.id, recipeId: firstId })).recipe.steps[0].args.value, 12);
  doc = await edit(native, doc, 'rename_edit_recipe', { recipeId: firstId, name: 'Renamed' }); doc = await edit(native, doc, 'delete_edit_recipe', { recipeId: firstId });
  assert.equal(doc.editRecipes.length, 15); doc = await edit(native, doc, 'undo'); assert.equal(doc.editRecipes[0].name, 'Renamed');
  const bundle = await native.exportProject({ documentId: doc.id }), copied = (await native.importProject({ data: bundle.data })).document;
  assert.deepEqual(copied.editRecipes, doc.editRecipes);
  const reopened = await new NativeBackend({ dataDir }).init(); t.after(() => reopened.close()); assert.deepEqual((await get(reopened, doc)).editRecipes, doc.editRecipes);
  assert.deepEqual(await fs.readFile(path.join(native.assetsDir, doc.layers[0].sourceAsset)), original);
});

test('mandatory and stale apply revisions reject, including after undo and a companion-independent restart', async t => {
  const { native, doc: initial, bindings, dataDir } = await fixture(t), saved = await save(native, initial, filterRecipe()), doc = saved.document;
  const args = { documentId: doc.id, recipeId: saved.recipeId, bindings: { photo: bindings.photo } };
  await assert.rejects(native.execute('apply_edit_recipe', args), coded('INVALID_ARGUMENTS'));
  let changed = (await native.execute('apply_edit_recipe', { ...args, expectedRevision: doc.revision })).document;
  await assert.rejects(native.execute('apply_edit_recipe', { ...args, expectedRevision: doc.revision }), coded('REVISION_CONFLICT'));
  changed = await edit(native, changed, 'undo'); assert.equal(changed.layers[0].filters, undefined);
  const reopened = await new NativeBackend({ dataDir }).init(); t.after(() => reopened.close());
  await assert.rejects(reopened.execute('apply_edit_recipe', { ...args, expectedRevision: doc.revision }), coded('REVISION_CONFLICT'));
  assert.equal((await get(reopened, changed)).layers[0].filters, undefined);
});

test('queued native inputs are captured at call time and saved/filter objects never alias caller data', async t => {
  const { native, doc } = await fixture(t); let release; const gate = new Promise(resolve => { release = resolve; }); const waiting = native.enqueue(() => gate);
  const input = { documentId: doc.id, expectedRevision: doc.revision, ...filterRecipe() }, pending = native.execute('save_edit_recipe', input);
  input.steps[0].args.value = 99; input.name = 'Caller changed it'; release(); await waiting;
  const result = await pending; assert.equal(result.document.editRecipes[0].name, 'Photo treatment'); assert.equal(result.document.editRecipes[0].steps[0].args.value, 12);
  const definition = result.document.editRecipes[0], args = { documentId: doc.id, expectedRevision: result.document.revision, recipeId: result.recipeId, bindings: { photo: doc.layers[0].id } };
  const applied = await native.execute('apply_edit_recipe', args); definition.steps[0].args.value = -99;
  assert.equal(applied.document.layers[0].filters[0].value, 12); assert.equal((await get(native, applied.document)).editRecipes[0].steps[0].args.value, 12);
});

test('late native validation and real publication failure preserve every file, committed graph and preview', async t => {
  const { native, doc: initial, bindings, dataDir } = await fixture(t); let doc = initial;
  doc = await edit(native, doc, 'set_layer_protection', { layerId: bindings.title, protected: true });
  const saved = await save(native, doc); doc = saved.document;
  const files = (await fs.readdir(native.assetsDir)).sort(), bytes = await fs.readFile(path.join(native.projectsDir, `${doc.id}.json`));
  const preview = await native.execute('get_preview', { documentId: doc.id, maxWidth: 100 });
  const args = { documentId: doc.id, expectedRevision: doc.revision, recipeId: saved.recipeId, bindings };
  const report = await native.execute('validate_edit_recipe', args); assert.equal(report.issues[0].stepIndex, 2);
  await assert.rejects(native.execute('apply_edit_recipe', args), coded('PROTECTED_LAYER')); assert.deepEqual(await get(native, doc), doc);
  assert.deepEqual(await fs.readFile(path.join(native.projectsDir, `${doc.id}.json`)), bytes);
  assert.deepEqual(await native.execute('get_preview', { documentId: doc.id, maxWidth: 100 }), preview);
  doc = await edit(native, doc, 'set_layer_protection', { layerId: bindings.title, protected: false });
  const validBytes = await fs.readFile(path.join(native.projectsDir, `${doc.id}.json`)), projectsDir = native.projectsDir, bad = path.join(dataDir, 'blocked'); await fs.writeFile(bad, 'x'); native.projectsDir = bad;
  await assert.rejects(native.execute('apply_edit_recipe', { ...args, expectedRevision: doc.revision }), coded('ENOTDIR')); native.projectsDir = projectsDir;
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await fs.readFile(path.join(native.projectsDir, `${doc.id}.json`)), validBytes); assert.deepEqual((await fs.readdir(native.assetsDir)).sort(), files);
});

test('prospective commit metadata, including history and redo truncation, is checked without persistence', async t => {
  const { native, doc: initial, bindings } = await fixture(t), saved = await save(native, initial, filterRecipe()), doc = saved.document;
  const project = native.project(doc.id), entry = project.states[project.cursor];
  // A valid existing large graph plus its next history snapshot exceeds 16 MiB.
  entry.graph.layers[0].legacyMetadata = 'x'.repeat(9 * 1024 * 1024);
  const args = { documentId: doc.id, expectedRevision: doc.revision, recipeId: saved.recipeId, bindings: { photo: bindings.photo } };
  const report = await native.execute('validate_edit_recipe', args); assert.equal(report.valid, false); assert.equal(report.issues[0].code, 'LIMIT_EXCEEDED'); assert.equal(report.issues[0].stepIndex, undefined);
  await assert.rejects(native.execute('apply_edit_recipe', args), coded('LIMIT_EXCEEDED')); assert.equal(native.project(doc.id).revision, doc.revision);
  delete entry.graph.layers[0].legacyMetadata;
  assert.equal((await native.execute('validate_edit_recipe', args)).valid, true);
  const future = structuredClone(entry); future.graph.layers[0].legacyMetadata = 'x'.repeat(9 * 1024 * 1024);
  project.states.push(future);
  assert.equal(project.cursor, project.states.length - 2);
  assert.equal((await native.execute('validate_edit_recipe', args)).valid, true, 'the discarded redo state must not count against the prospective commit');
  project.states.pop();
});

test('defaults expansion observes the per-recipe byte limit and the cumulative library has an independent byte ceiling', async t => {
  const { native, doc } = await fixture(t);
  const slots = Array.from({ length: 16 }, (_, i) => ({ key: `target_${i}`, label: '😀'.repeat(40), type: 'raster' }));
  const build = points => ({ id: randomUUID(), version: 1, name: '😀'.repeat(100), slots: structuredClone(slots), steps: Array.from({ length: 30 }, (_, i) => ({
    command: 'add_layer_filter', target: slots[i % 16].key, args: { kind: 'curves', value: 0, parameters: { points: structuredClone(points), channel: 'rgb' } },
  })) });
  const expanded = build(Array.from({ length: 16 }, (_, i) => ({ x: i === 0 ? 0 : i === 15 ? 255 : (i + 1) * 1.2345678912345678e-7, y: 1.2345678912345678e-7 })));
  assert.ok(Buffer.byteLength(JSON.stringify(expanded)) < EDIT_RECIPE_LIMITS.maxRecipeBytes);
  assert.throws(() => normalizeEditRecipe(expanded), coded('LIMIT_EXCEEDED'));
  const { id, version, ...definition } = expanded;
  await assert.rejects(save(native, doc, definition), coded('LIMIT_EXCEEDED')); assert.deepEqual(await get(native, doc), doc);
  const within = normalizeEditRecipe(build(Array.from({ length: 16 }, (_, i) => ({ x: i === 0 ? 0 : i === 15 ? 255 : i * 17.00000000000001, y: 199.12345678912345 }))));
  assert.ok(Buffer.byteLength(JSON.stringify(within)) < EDIT_RECIPE_LIMITS.maxRecipeBytes);
  const library = Array.from({ length: 8 }, () => ({ ...structuredClone(within), id: randomUUID() }));
  assert.equal(normalizeEditRecipes(library).length, 8);
  library.push({ ...structuredClone(within), id: randomUUID() });
  assert.throws(() => normalizeEditRecipes(library), coded('LIMIT_EXCEEDED'));
});

test('strict definition and library bounds reject non-JSON, aliases between saved IDs and unsupported commands before source reads', async t => {
  const { native, doc } = await fixture(t), record = { id: randomUUID(), version: 1, ...filterRecipe() };
  for (const changed of [
    { ...record, version: 2 }, { ...record, steps: [{ command: 'paint_stroke', target: 'photo', args: {} }] },
    { ...record, slots: [{ key: 'photo', type: 'content' }] }, { ...record, steps: [{ command: 'add_layer_filter', target: 'photo', args: { kind: 'temperature', value: 10, layerId: doc.layers[0].id } }] },
    { ...record, steps: Array.from({ length: 31 }, () => structuredClone(record.steps[0])) },
  ]) assert.throws(() => normalizeEditRecipe(changed), coded('INVALID_ARGUMENTS'));
  assert.throws(() => normalizeEditRecipes([record, structuredClone(record)]), coded('INVALID_ARGUMENTS'));
  const getters = { ...record }; Object.defineProperty(getters, 'name', { enumerable: true, get() { throw new Error('Accessor invoked'); } });
  assert.throws(() => normalizeEditRecipe(getters), coded('INVALID_ARGUMENTS'));
  const cyclic = { ...record }; cyclic.steps = cyclic; assert.throws(() => normalizeEditRecipe(cyclic), coded('INVALID_ARGUMENTS'));
  const library = []; for (let i = 0; i < 17; i++) library.push({ ...record, id: randomUUID() });
  assert.throws(() => normalizeEditRecipes(library), coded('LIMIT_EXCEEDED'));
  const sparse = Array(1); assert.throws(() => normalizeEditRecipes(sparse), coded('INVALID_ARGUMENTS'));
  const hidden = [record]; Object.defineProperty(hidden, '0', { enumerable: false }); assert.throws(() => normalizeEditRecipes(hidden), coded('INVALID_ARGUMENTS'));
  const data = await native.exportProject({ documentId: doc.id }), size = data.data.readUInt32BE(8), manifest = JSON.parse(data.data.subarray(12, 12 + size).toString());
  manifest.graph.editRecipes = [{ ...record, version: 99 }]; const encoded = Buffer.from(JSON.stringify(manifest)), header = Buffer.from(data.data.subarray(0, 12)); header.writeUInt32BE(encoded.length, 8);
  const corrupt = Buffer.concat([header, encoded, data.data.subarray(12 + size)]); let reads = 0;
  const checkAsset = native.validateProjectAsset; native.validateProjectAsset = async () => { reads++; throw new Error('Asset validation must not run'); };
  await assert.rejects(native.importProject({ data: corrupt }), coded('INVALID_PROJECT_BUNDLE')); native.validateProjectAsset = checkAsset; assert.equal(reads, 0);
});
