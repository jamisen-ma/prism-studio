import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { groupNeedsSurface, layerTree, validateGroupResources } from '../server/groups.mjs';

const coded = code => error => error.code === code;
const edit = async (native, document, command, args = {}) => (await native.execute(command, { documentId: document.id, expectedRevision: document.revision, ...args })).document;
const get = async (native, document) => (await native.execute('get_document', { documentId: document.id })).document;
const render = (native, document) => native.render(native.project(document.id));
const px = (bytes, x, y, width = 6) => [...bytes.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
const layer = (document, id) => document.layers.find(item => item.id === id);
async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-isolated-groups-'));
  const native = await new NativeBackend({ dataDir, ...options }).init();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const document = (await native.execute('create_document', { width: 6, height: 4, background: '#285078' })).document;
  return { native, document, dataDir };
}
async function wrap(native, document, layerIds) {
  const next = await edit(native, document, 'group_layers', { layerIds });
  return { document: next, id: next.layers.find(item => item.type === 'group' && !document.layers.some(old => old.id === item.id)).id };
}
const shape = (native, doc, fill, values = {}) => edit(native, doc, 'add_shape', { shape: 'rectangle', x: 1, y: 1, width: 2, height: 2, fill, ...values });
function over(backdrop, source, opacity = 1, mode = 'normal') {
  const a = backdrop[3] / 255, b = source[3] / 255 * opacity, alpha = b + a * (1 - b);
  if (b === 0) return [...backdrop];
  return [...source.slice(0, 3).map((s, c) => {
    const d = backdrop[c], mixed = mode === 'multiply' ? d * s / 255 : mode === 'screen' ? 255 - (255 - d) * (255 - s) / 255 : s;
    return Math.round(((1 - b) * a * d + (1 - a) * b * s + b * a * mixed) / alpha);
  }), Math.round(alpha * 255)];
}

test('isolated adjustments cannot see outside backdrop and group opacity/blending/masks follow independent RGBA references', async t => {
  const { native, document: initial } = await fixture(t);
  let document = await shape(native, initial, '#c82850'), subject = document.layers.at(-1).id;
  document = await edit(native, document, 'set_layer', { layerId: subject, opacity: 0.5 });
  document = await edit(native, document, 'add_adjustment', { kind: 'invert', value: 100 }); const adjustment = document.layers.at(-1).id;
  const grouped = await wrap(native, document, [subject, adjustment]); document = grouped.document;
  const pass = await render(native, document); assert.deepEqual(px(pass, 0, 0), [215, 175, 135, 255]);
  document = await edit(native, document, 'set_group_compositing', { layerId: grouped.id, mode: 'isolated' });
  let pixels = await render(native, document);
  assert.deepEqual(px(pixels, 0, 0), [40, 80, 120, 255]);
  assert.deepEqual(px(pixels, 1, 1), over([40, 80, 120, 255], [55, 215, 175, 128]));
  document = await edit(native, document, 'set_layer_mask', { layerId: grouped.id, mask: { x: 0, y: 0, width: 2, height: 4 } });
  document = await edit(native, document, 'set_layer', { layerId: grouped.id, opacity: 0.5, blendMode: 'multiply' });
  pixels = await render(native, document);
  assert.deepEqual(px(pixels, 1, 1), over([40, 80, 120, 255], [55, 215, 175, 128], 0.5, 'multiply'));
  assert.deepEqual(px(pixels, 2, 1), [40, 80, 120, 255]);
  document = await edit(native, document, 'set_layer', { layerId: grouped.id, blendMode: 'screen' });
  assert.deepEqual(px(await render(native, document), 1, 1), over([40, 80, 120, 255], [55, 215, 175, 128], 0.5, 'screen'));
});

test('nested isolated and pass-through groups round each alpha stage once and preserve empty/hidden output', async t => {
  const { native } = await fixture(t);
  const source = Buffer.from([100, 120, 140, 1, 12, 34, 56, 0]);
  const png = await sharp(source, { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer();
  let document = (await native.execute('import_image', { mimeType: 'image/png', data: png.toString('base64') })).document, id = document.layers[0].id;
  const inner = await wrap(native, document, [id]); document = inner.document;
  document = await edit(native, document, 'set_group_compositing', { layerId: inner.id, mode: 'isolated' });
  document = await edit(native, document, 'set_layer', { layerId: inner.id, opacity: 0.5 });
  const outer = await wrap(native, document, [inner.id]); document = outer.document;
  document = await edit(native, document, 'set_layer', { layerId: outer.id, opacity: 0.5 });
  const before = await render(native, document); assert.deepEqual(px(before, 0, 0, 2), [100, 120, 140, 1]); assert.equal(before[7], 0);
  document = await edit(native, document, 'set_group_compositing', { layerId: outer.id, mode: 'isolated', blendMode: 'screen' });
  assert.deepEqual(await render(native, document), before);
  document = await edit(native, document, 'create_group'); const empty = document.layers.at(-1).id;
  document = await edit(native, document, 'set_group_compositing', { layerId: empty, mode: 'isolated', blendMode: 'multiply' });
  assert.deepEqual(await render(native, document), before);
  document = await edit(native, document, 'ungroup_layer', { layerId: empty }); assert.deepEqual(await render(native, document), before);
  document = await edit(native, document, 'set_layer', { layerId: outer.id, visible: false }); assert.ok((await render(native, document)).every(value => value === 0));
  const sourceView = await native.execute('get_layer_preview', { documentId: document.id, layerId: id, view: 'source' });
  assert.deepEqual(await sharp(Buffer.from(sourceView.data, 'base64')).raw().toBuffer(), source);
  const groupView = await native.execute('get_layer_preview', { documentId: document.id, layerId: outer.id });
  assert.deepEqual(await sharp(Buffer.from(groupView.data, 'base64')).raw().toBuffer(), before);
});

test('protected hidden descendants forbid mode changes, nonnormal ancestors and moves across any isolation boundary', async t => {
  const { native, document: initial } = await fixture(t);
  let document = await shape(native, initial, '#be5522'), subject = document.layers.at(-1).id;
  document = await edit(native, document, 'set_layer', { layerId: subject, blendMode: 'multiply', visible: false });
  const outer = await wrap(native, document, [subject]); document = outer.document;
  document = await edit(native, document, 'set_layer_protection', { layerId: subject, protected: true });
  await assert.rejects(edit(native, document, 'set_group_compositing', { layerId: outer.id, mode: 'isolated' }), coded('PROTECTED_LAYER'));
  document = await edit(native, document, 'set_group_compositing', { layerId: outer.id, mode: 'pass-through' });
  document = await edit(native, document, 'create_group'); const destination = document.layers.at(-1).id;
  document = await edit(native, document, 'set_group_compositing', { layerId: destination, mode: 'isolated' });
  const before = document, file = await fs.readFile(path.join(native.projectsDir, `${document.id}.json`));
  await assert.rejects(edit(native, document, 'move_layer', { layerId: subject, parentId: destination }), coded('PROTECTED_LAYER'));
  await assert.rejects(edit(native, document, 'move_layer', { layerId: outer.id, parentId: destination }), coded('PROTECTED_LAYER'));
  assert.deepEqual(await get(native, document), before); assert.deepEqual(await fs.readFile(path.join(native.projectsDir, `${document.id}.json`)), file);
  document = await edit(native, document, 'set_layer_protection', { layerId: subject, protected: false });
  document = await edit(native, document, 'move_layer', { layerId: outer.id, parentId: destination });
  document = await edit(native, document, 'set_layer_protection', { layerId: subject, protected: true });
  await assert.rejects(edit(native, document, 'set_layer', { layerId: destination, blendMode: 'screen' }), coded('PROTECTED_LAYER'));
  await assert.rejects(edit(native, document, 'set_group_compositing', { layerId: destination, mode: 'pass-through' }), coded('PROTECTED_LAYER'));
  await assert.rejects(edit(native, document, 'move_layer', { layerId: outer.id, parentId: null }), coded('PROTECTED_LAYER'));
  const inner = await wrap(native, document, [subject]); document = inner.document;
  document = await edit(native, document, 'move_layer', { layerId: subject, parentId: outer.id });
  document = await edit(native, document, 'ungroup_layer', { layerId: inner.id });
  document = await edit(native, document, 'duplicate_layer', { layerId: destination });
  assert.equal(document.layers.filter(item => item.protected).length, 2, 'new copied IDs preserve protection within their copied isolation scope');
});

test('scope guards distinguish two isolated groups and preflight protection creation on invalid ancestors', async t => {
  let calls = 0;
  const { native, document: initial } = await fixture(t, { segmentSubject: async () => { calls++; return { width: 6, height: 4, alpha: Buffer.alloc(24, 255), model: 'test' }; } });
  let document = await edit(native, initial, 'rasterize_layer', { layerId: initial.layers[0].id }), raster = document.layers[0].id;
  const group = await wrap(native, document, [raster]); document = group.document;
  document = await edit(native, document, 'set_group_compositing', { layerId: group.id, mode: 'isolated', blendMode: 'multiply' });
  const assets = await fs.readdir(native.assetsDir);
  await assert.rejects(edit(native, document, 'set_layer_protection', { layerId: raster, protected: true }), coded('PROTECTED_LAYER'));
  await assert.rejects(edit(native, document, 'extract_subject', { layerId: raster }), coded('PROTECTED_LAYER')); assert.equal(calls, 0); assert.deepEqual(await fs.readdir(native.assetsDir), assets);
  document = await edit(native, document, 'extract_subject', { layerId: raster, protect: false }); assert.equal(calls, 1);
  const cutout = document.layers.find(item => item.role === 'cutout').id; assert.equal(layer(document, cutout).parentId, group.id);
  document = await edit(native, document, 'set_group_compositing', { layerId: group.id, mode: 'isolated' });
  document = await edit(native, document, 'set_layer_protection', { layerId: cutout, protected: true });
  document = await edit(native, document, 'create_group'); const other = document.layers.at(-1).id;
  document = await edit(native, document, 'set_group_compositing', { layerId: other, mode: 'isolated' });
  await assert.rejects(edit(native, document, 'move_layer', { layerId: cutout, parentId: other }), coded('PROTECTED_LAYER'));
});

test('internal/external adjustments and generated styles honor inherited and newly protected footprints', async t => {
  const { native, document: initial } = await fixture(t);
  let document = await shape(native, initial, '#bf4d29'), subject = document.layers.at(-1).id;
  const inside = await wrap(native, document, [subject]); document = inside.document;
  document = await edit(native, document, 'set_group_compositing', { layerId: inside.id, mode: 'isolated' });
  document = await edit(native, document, 'set_layer_protection', { layerId: subject, protected: true });
  const original = px(await render(native, document), 1, 1);
  document = await edit(native, document, 'add_adjustment', { kind: 'invert', value: 100 }); const adjustment = document.layers.at(-1).id;
  document = await edit(native, document, 'move_layer', { layerId: adjustment, parentId: inside.id });
  assert.deepEqual(px(await render(native, document), 1, 1), original);
  document = await edit(native, document, 'add_adjustment', { kind: 'brightness', value: 10 });
  assert.deepEqual(px(await render(native, document), 1, 1), original);
  const raw = Buffer.alloc(6 * 4 * 4); for (let y = 1; y < 3; y++) for (let x = 1; x < 3; x++) raw.set([0, 255, 0, 255], (y * 6 + x) * 4);
  const generated = await sharp(raw, { raw: { width: 6, height: 4, channels: 4 } }).png().toBuffer();
  document = (await native.installGeneratedImage({ documentId: document.id, expectedRevision: document.revision, data: generated, provenance: { jobId: randomUUID(), mode: 'generate' } })).document;
  const generatedId = document.layers.at(-1).id;
  // Restore the pre-protection source to prove dynamic clipping, rather than
  // relying only on installation's already-clipped working asset.
  const currentProject = native.project(document.id), graph = structuredClone(currentProject.states[currentProject.cursor].graph);
  layer(graph, generatedId).asset = await native.storeAsset(generated); await native.commit(currentProject, graph, 'Fixture full generated source'); document = await get(native, document);
  const generatedGroup = await wrap(native, document, [generatedId]); document = generatedGroup.document;
  document = await edit(native, document, 'set_group_compositing', { layerId: generatedGroup.id, mode: 'isolated', blendMode: 'screen' });
  const before = await render(native, document);
  document = await edit(native, document, 'set_layer_effects', { layerId: generatedId, effects: { shadow: { color: '#ff0000', x: 2, y: 0, blur: 0, opacity: 1 } } });
  assert.deepEqual(await render(native, document), before, 'fully inherited-protection-clipped image casts no shadow');
  const snapshot = await native.snapshotForGeneration({ documentId: document.id, expectedRevision: document.revision, scope: 'canvas' });
  const mask = await sharp(snapshot.mask).ensureAlpha().raw().toBuffer(); assert.equal(px(mask, 1, 1)[3], 255); assert.equal(px(mask, 5, 3)[3], 0);
});

test('placement/arrangement/ungroup reject isolation while rasterization retains context and exact rendering', async t => {
  const { native, document: initial } = await fixture(t);
  let document = await shape(native, initial, '#ca8a47'), subject = document.layers.at(-1).id;
  const grouped = await wrap(native, document, [subject]); document = grouped.document;
  document = await edit(native, document, 'set_group_compositing', { layerId: grouped.id, mode: 'isolated' });
  const pixels = await render(native, document);
  document = await edit(native, document, 'rasterize_layer', { layerId: subject });
  assert.equal(layer(document, subject).parentId, grouped.id); assert.deepEqual(await render(native, document), pixels);
  await assert.rejects(edit(native, document, 'align_layers', { layerIds: [subject], axis: 'horizontal', alignment: 'center', relativeTo: 'canvas' }), coded('INVALID_TARGET'));
  await assert.rejects(edit(native, document, 'ungroup_layer', { layerId: grouped.id }), coded('INVALID_TARGET'));
  const target = (await native.execute('create_document', { width: 6, height: 4 })).document;
  await assert.rejects(edit(native, target, 'place_layer', { sourceDocumentId: document.id, sourceLayerId: subject, x: 0, y: 0, width: 6, height: 4 }), error => error.code === 'INVALID_TARGET' && /isolated/.test(error.message));
  document = await edit(native, document, 'set_group_compositing', { layerId: grouped.id, mode: 'pass-through' });
  document = await edit(native, document, 'ungroup_layer', { layerId: grouped.id }); assert.deepEqual(await render(native, document), pixels);
});

test('hidden isolation and filter scratch reject before commit without allocating large surfaces', async t => {
  const { native } = await fixture(t);
  let document = (await native.execute('create_document', { width: 8192, height: 2929 })).document;
  const root = document.layers[0].id;
  const ids = []; for (let i = 0; i < 3; i++) { const grouped = await wrap(native, document, [ids.at(-1) ?? root]); document = grouped.document; ids.push(grouped.id); }
  for (const id of ids.slice(0, 2)) document = await edit(native, document, 'set_group_compositing', { layerId: id, mode: 'isolated' });
  document = await edit(native, document, 'set_layer', { layerId: ids[2], visible: false });
  const before = document, file = await fs.readFile(path.join(native.projectsDir, `${document.id}.json`));
  await assert.rejects(edit(native, document, 'set_group_compositing', { layerId: ids[2], mode: 'isolated' }), coded('LIMIT_EXCEEDED'));
  assert.deepEqual(await get(native, document), before); assert.deepEqual(await fs.readFile(path.join(native.projectsDir, `${document.id}.json`)), file);
  const one = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#555555' } }).png().toBuffer();
  let filtered = (await native.execute('import_image', { mimeType: 'image/png', data: one.toString('base64') })).document, raster = filtered.layers[0].id;
  filtered = await edit(native, filtered, 'resize_canvas', { width: 5000, height: 3000 });
  filtered = await edit(native, filtered, 'add_layer_filter', { layerId: raster, kind: 'brightness', value: 1 });
  const inner = await wrap(native, filtered, [raster]); filtered = inner.document;
  const outer = await wrap(native, filtered, [inner.id]); filtered = outer.document;
  filtered = await edit(native, filtered, 'set_group_compositing', { layerId: inner.id, mode: 'isolated' });
  const candidate = structuredClone(filtered); layer(candidate, outer.id).mode = 'isolated';
  assert.doesNotThrow(() => validateGroupResources(layerTree(candidate.layers), candidate.width, candidate.height), 'group surfaces alone remain below the cap');
  await assert.rejects(edit(native, filtered, 'set_group_compositing', { layerId: outer.id, mode: 'isolated' }), error => error.code === 'LIMIT_EXCEEDED' && /filter/i.test(error.message));
  assert.deepEqual(await get(native, filtered), filtered);
  assert.equal(groupNeedsSurface({ mode: 'isolated', opacity: 1 }), true); assert.equal(groupNeedsSurface({ mode: 'pass-through', opacity: 1 }), false);
});

test('mode edits are revision-guarded and reversible; persistence/transactions remain atomic and portable', async t => {
  const { native, dataDir, document: initial } = await fixture(t);
  let document = await shape(native, initial, '#cfa56b'), id = document.layers.at(-1).id;
  const wrapped = await wrap(native, document, [id]); document = wrapped.document;
  const before = document, initialPixels = await render(native, document);
  document = await edit(native, document, 'set_group_compositing', { layerId: wrapped.id, mode: 'isolated', blendMode: 'multiply' });
  const after = await render(native, document); assert.notDeepEqual(after, initialPixels);
  document = await edit(native, document, 'undo'); assert.equal(layer(document, wrapped.id).mode, 'pass-through'); assert.deepEqual(await render(native, document), initialPixels);
  document = await edit(native, document, 'redo'); assert.deepEqual(await render(native, document), after);
  await assert.rejects(edit(native, document, 'set_group_compositing', { layerId: wrapped.id, mode: 'pass-through', expectedRevision: before.revision }), coded('REVISION_CONFLICT'));
  await assert.rejects(edit(native, document, 'apply_transaction', { operations: [{ command: 'set_group_compositing', args: { layerId: wrapped.id, mode: 'pass-through' } }, { command: 'set_layer', args: { layerId: wrapped.id, blendMode: 'screen' } }] }), coded('UNSUPPORTED'));
  assert.deepEqual(await get(native, document), document);
  const bytes = await fs.readFile(path.join(native.projectsDir, `${document.id}.json`)), persist = native.persist.bind(native);
  native.persist = async () => { throw Object.assign(new Error('Injected disk failure'), { code: 'EIO' }); };
  await assert.rejects(edit(native, document, 'set_group_compositing', { layerId: wrapped.id, mode: 'pass-through' }), coded('EIO')); native.persist = persist;
  assert.deepEqual(await get(native, document), document); assert.deepEqual(await fs.readFile(path.join(native.projectsDir, `${document.id}.json`)), bytes);
  const reopened = await new NativeBackend({ dataDir }).init(); assert.equal(reopened.loadWarnings.length, 0); assert.deepEqual(await render(reopened, document), after);
  const bundle = await native.exportProject({ documentId: document.id }); const imported = (await reopened.importProject({ data: bundle.data })).document;
  assert.deepEqual(imported.layers, document.layers); assert.deepEqual(await render(reopened, imported), after);
  const caps = await native.execute('capabilities'); assert.deepEqual(caps.groupModes, ['pass-through', 'isolated']); assert.equal(caps.groupBlendModes.length, 27);
  await assert.rejects(native.exportPsd({ documentId: document.id }), coded('PSD_UNSUPPORTED'));
});
