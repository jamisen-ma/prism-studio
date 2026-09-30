import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { NativeBackend } from '../server/native.mjs';

const coded = (code) => (cause) => cause.code === code;
const edit = async (native, doc, command, args = {}) => (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document;
const get = async (native, doc) => (await native.execute('get_document', { documentId: doc.id })).document;
const render = (native, doc) => native.renderGraph(doc);
const pixel = (pixels, x, y, width = 8) => [...pixels.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
const groupId = (before, after) => after.layers.find((layer) => layer.type === 'group' && !before.layers.some((old) => old.id === layer.id)).id;
async function fixture(t, { width = 8, height = 8, segmentSubject } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-groups-'));
  const native = await new NativeBackend({ dataDir, segmentSubject }).init();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const document = (await native.execute('create_document', { width, height, background: '#000000' })).document;
  return { native, document, dataDir };
}
async function shape(native, doc, fill, options = {}) { return edit(native, doc, 'add_shape', { shape: 'rectangle', x: 0, y: 0, width: doc.width, height: doc.height, fill, ...options }); }
async function wrap(native, doc, ids, name = 'Group') {
  const document = await edit(native, doc, 'group_layers', { layerIds: ids, name });
  return { document, id: groupId(doc, document) };
}

test('neutral nested groups preserve blend, adjustment, soft-alpha and effects pixels exactly through reopen and undo', async (t) => {
  const { native, dataDir, document: initial } = await fixture(t);
  let doc = await shape(native, initial, '#ee4455', { x: 1, y: 1, width: 4, height: 4 });
  doc = await edit(native, doc, 'set_layer', { layerId: doc.layers.at(-1).id, opacity: 0.55, blendMode: 'screen' });
  doc = await edit(native, doc, 'set_layer_effects', { layerId: doc.layers.at(-1).id, effects: { shadow: { color: '#00ff00', x: 2, y: 0, blur: 1 } } });
  doc = await shape(native, doc, '#55bbff', { x: 3, y: 2, width: 3, height: 4 });
  doc = await edit(native, doc, 'set_layer', { layerId: doc.layers.at(-1).id, opacity: 0.7, blendMode: 'multiply' });
  doc = await edit(native, doc, 'add_adjustment', { kind: 'brightness', value: 20 });
  const before = await render(native, doc), ids = doc.layers.slice(1).map((layer) => layer.id);
  const inner = await wrap(native, doc, ids); doc = inner.document;
  assert.deepEqual(await render(native, doc), before);
  const outer = await wrap(native, doc, [initial.layers[0].id, inner.id]); doc = outer.document;
  assert.deepEqual(await render(native, doc), before);
  const reopened = await new NativeBackend({ dataDir }).init(); assert.equal(reopened.loadWarnings.length, 0);
  assert.deepEqual(await render(reopened, await get(reopened, doc)), before);
  doc = await edit(reopened, doc, 'undo'); assert.deepEqual(await render(reopened, doc), before);
  doc = await edit(reopened, doc, 'redo'); assert.deepEqual(await render(reopened, doc), before);
  doc = await edit(reopened, doc, 'ungroup_layer', { layerId: outer.id });
  assert.deepEqual(await render(reopened, doc), before); assert.equal(doc.layers.find((layer) => layer.id === inner.id).parentId, undefined);
});

test('group opacity interpolates the completed group once; mask zeros preserve backdrop bytes', async (t) => {
  const { native, document: initial } = await fixture(t);
  let doc = await shape(native, initial, '#ff0000'); const red = doc.layers.at(-1).id;
  doc = await shape(native, doc, '#0000ff'); const blue = doc.layers.at(-1).id;
  doc = await edit(native, doc, 'set_layer', { layerId: blue, opacity: 0.5 });
  const grouped = await wrap(native, doc, [red, blue]); doc = grouped.document;
  doc = await edit(native, doc, 'set_layer', { layerId: grouped.id, opacity: 0.5 });
  assert.deepEqual(pixel(await render(native, doc), 2, 2), [64, 0, 64, 255]);
  doc = await edit(native, doc, 'set_layer_mask', { layerId: grouped.id, mask: { x: 0, y: 0, width: 4, height: 8 } });
  assert.deepEqual(pixel(await render(native, doc), 6, 2), [0, 0, 0, 255]);
  const before = doc;
  await assert.rejects(edit(native, doc, 'ungroup_layer', { layerId: grouped.id }), coded('INVALID_TARGET'));
  assert.deepEqual(await get(native, doc), before);
  doc = await edit(native, doc, 'set_layer', { layerId: grouped.id, visible: false });
  assert.deepEqual(await render(native, doc), await render(native, initial));
});

test('subtree duplicate, reparent, reorder and delete keep canonical order and remap all parent IDs', async (t) => {
  const { native, document: initial } = await fixture(t);
  let doc = await shape(native, initial, '#aa0000'); const red = doc.layers.at(-1).id;
  doc = await shape(native, doc, '#0000aa'); const blue = doc.layers.at(-1).id;
  let grouped = await wrap(native, doc, [red, blue]); doc = grouped.document; const group = grouped.id;
  doc = await edit(native, doc, 'create_group', { parentId: group, index: 1, name: 'Nested' }); const nested = doc.layers.find((layer) => layer.name === 'Nested').id;
  doc = await edit(native, doc, 'move_layer', { layerId: blue, parentId: nested });
  doc = await edit(native, doc, 'reorder_layer', { layerId: nested, index: 0 });
  assert.deepEqual(doc.layers.map((layer) => layer.id), [initial.layers[0].id, group, nested, blue, red]);
  const priorIds = new Set(doc.layers.map((layer) => layer.id));
  doc = await edit(native, doc, 'duplicate_layer', { layerId: group });
  const copies = doc.layers.filter((layer) => !priorIds.has(layer.id)); assert.equal(copies.length, 4);
  assert.equal(copies[0].parentId, undefined); assert.equal(copies[1].parentId, copies[0].id); assert.equal(copies[2].parentId, copies[1].id); assert.equal(copies[3].parentId, copies[0].id);
  doc = await edit(native, doc, 'delete_layer', { layerId: copies[0].id }); assert.equal(doc.layers.length, 5);
  doc = await edit(native, doc, 'move_layer', { layerId: nested, parentId: null, index: 0 });
  assert.deepEqual(doc.layers.map((layer) => layer.id), [nested, blue, initial.layers[0].id, group, red]);
});

test('grouping and hierarchy errors roll back revision, project bytes and rendered pixels', async (t) => {
  const { native, document: initial, dataDir } = await fixture(t);
  let doc = await shape(native, initial, '#aa0000'); const red = doc.layers.at(-1).id;
  doc = await shape(native, doc, '#0000aa'); const blue = doc.layers.at(-1).id;
  const invalid = () => edit(native, doc, 'group_layers', { layerIds: [initial.layers[0].id, blue] });
  await assert.rejects(invalid(), coded('INVALID_ARGUMENT'));
  const grouped = await wrap(native, doc, [red, blue]); doc = grouped.document;
  const file = path.join(dataDir, 'projects', `${doc.id}.json`), bytes = await fs.readFile(file), before = await render(native, doc);
  for (const operation of [
    ['move_layer', { layerId: grouped.id, parentId: grouped.id }], ['move_layer', { layerId: grouped.id, parentId: red }],
    ['group_layers', { layerIds: [initial.layers[0].id, red] }], ['reorder_layer', { layerId: red, index: 3 }],
  ]) await assert.rejects(edit(native, doc, ...operation));
  await assert.rejects(edit(native, doc, 'apply_transaction', { operations: [{ command: 'create_group', args: { name: 'Rolled back' } }, { command: 'move_layer', args: { layerId: grouped.id, parentId: grouped.id } }] }));
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await fs.readFile(file), bytes); assert.deepEqual(await render(native, doc), before);
});

test('hidden protected descendants block fading, deletion and reparenting to faded ancestors; unprotection permits edits', async (t) => {
  const { native, document: initial } = await fixture(t);
  let doc = await shape(native, initial, '#aa0000'); const subject = doc.layers.at(-1).id;
  doc = await edit(native, doc, 'set_layer_protection', { layerId: subject, protected: true });
  const grouped = await wrap(native, doc, [subject]); doc = grouped.document;
  doc = await edit(native, doc, 'set_layer', { layerId: grouped.id, visible: false });
  doc = await edit(native, doc, 'create_group', { name: 'Faded' }); const faded = doc.layers.at(-1).id;
  doc = await edit(native, doc, 'set_layer', { layerId: faded, opacity: 0.5 });
  const before = await render(native, doc);
  for (const [command, args] of [
    ['set_layer', { layerId: grouped.id, opacity: 0.9 }], ['delete_layer', { layerId: grouped.id }],
    ['move_layer', { layerId: grouped.id, parentId: faded }], ['move_layer', { layerId: subject, parentId: faded }],
  ]) await assert.rejects(edit(native, doc, command, args), coded('PROTECTED_LAYER'));
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await render(native, doc), before);
  doc = await edit(native, doc, 'set_layer_protection', { layerId: subject, protected: false });
  doc = await edit(native, doc, 'move_layer', { layerId: subject, parentId: faded });
  await assert.rejects(edit(native, doc, 'set_layer_protection', { layerId: subject, protected: true }), coded('PROTECTED_LAYER'));
  doc = await edit(native, doc, 'delete_layer', { layerId: grouped.id });
  assert.ok(!doc.layers.some((layer) => layer.id === grouped.id));
});

test('ancestor masks and visibility scope protected snapshots and dynamically clip generated root layers', async (t) => {
  const { native, document: initial } = await fixture(t);
  let doc = await shape(native, initial, '#ff0000'); const subject = doc.layers.at(-1).id;
  const grouped = await wrap(native, doc, [subject]); doc = grouped.document;
  doc = await edit(native, doc, 'set_layer_mask', { layerId: grouped.id, mask: { x: 0, y: 0, width: 4, height: 8 } });
  const generated = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#00ff00' } }).png().toBuffer();
  doc = (await native.installGeneratedImage({ documentId: doc.id, expectedRevision: doc.revision, data: generated, provenance: { jobId: randomUUID(), mode: 'generate' } })).document;
  doc = await edit(native, doc, 'set_layer_protection', { layerId: subject, protected: true });
  let pixels = await render(native, doc);
  assert.deepEqual(pixel(pixels, 1, 2), [255, 0, 0, 255]); assert.deepEqual(pixel(pixels, 6, 2), [0, 255, 0, 255]);
  let snapshot = await native.snapshotForGeneration({ documentId: doc.id, expectedRevision: doc.revision, scope: 'canvas' });
  let mask = await sharp(snapshot.mask).ensureAlpha().raw().toBuffer(); assert.equal(pixel(mask, 1, 2)[3], 255); assert.equal(pixel(mask, 6, 2)[3], 0);
  doc = await edit(native, doc, 'set_layer', { layerId: grouped.id, visible: false });
  pixels = await render(native, doc); assert.deepEqual(pixel(pixels, 1, 2), [0, 255, 0, 255]);
  snapshot = await native.snapshotForGeneration({ documentId: doc.id, expectedRevision: doc.revision, scope: 'canvas' }); assert.equal(snapshot.mask, undefined);
});

test('group masks clip completed decorations and protection coverage without changing shadow caster geometry', async (t) => {
  const { native, document: initial } = await fixture(t);
  let doc = await shape(native, initial, '#ff0000', { x: 1, y: 1, width: 1, height: 1 }); const subject = doc.layers.at(-1).id;
  doc = await edit(native, doc, 'set_layer_effects', { layerId: subject, effects: { shadow: { blur: 0, x: 3, y: 0, color: '#00ff00', opacity: 1 } } });
  doc = await edit(native, doc, 'set_layer_protection', { layerId: subject, protected: true });
  const grouped = await wrap(native, doc, [subject]); doc = grouped.document;
  doc = await edit(native, doc, 'set_layer_mask', { layerId: grouped.id, mask: { x: 4, y: 0, width: 1, height: 8 } });
  const footprint = await native.protectedPixels(doc), pixels = await render(native, doc);
  assert.deepEqual(pixel(pixels, 4, 1), [0, 255, 0, 255]); assert.deepEqual(pixel(pixels, 1, 1), [0, 0, 0, 255]);
  assert.equal(footprint[1 * 8 + 4], 1); assert.equal(footprint[1 * 8 + 1], 0);
  doc = await edit(native, doc, 'add_adjustment', { kind: 'invert', value: 100 });
  assert.deepEqual(pixel(await render(native, doc), 4, 1), [0, 255, 0, 255]);
});

test('group/leaf previews inherit masks and opacity; source previews stay raw and reads do not mutate', async (t) => {
  const { native, document: initial } = await fixture(t);
  let doc = await shape(native, initial, '#ff0000'); const red = doc.layers.at(-1).id;
  const grouped = await wrap(native, doc, [red]); doc = grouped.document;
  doc = await edit(native, doc, 'set_layer', { layerId: grouped.id, opacity: 0.5, visible: false });
  doc = await edit(native, doc, 'set_layer_mask', { layerId: grouped.id, mask: { x: 0, y: 0, width: 4, height: 8 } });
  for (const layerId of [red, grouped.id]) {
    const preview = await native.execute('get_layer_preview', { documentId: doc.id, layerId });
    const pixels = await sharp(Buffer.from(preview.data, 'base64')).raw().toBuffer();
    assert.deepEqual(pixel(pixels, 1, 1), [255, 0, 0, 128]); assert.equal(pixel(pixels, 5, 1)[3], 0);
    assert.deepEqual(preview.visibleBounds, { x: 0, y: 0, width: 4, height: 8 });
  }
  await assert.rejects(native.execute('get_layer_preview', { documentId: doc.id, layerId: grouped.id, view: 'source' }), coded('INVALID_TARGET'));
  assert.deepEqual(await get(native, doc), doc);
});

test('document geometry transforms content and every group mask exactly once; rasterization retains parent', async (t) => {
  const { native, document: initial } = await fixture(t);
  let doc = await shape(native, initial, '#ffaa00', { x: 2, y: 2, width: 2, height: 2 }); const subject = doc.layers.at(-1).id;
  doc = await shape(native, doc, '#0066ff', { x: 3, y: 3, width: 1, height: 1 }); const following = doc.layers.at(-1).id;
  const grouped = await wrap(native, doc, [subject, following]); doc = grouped.document;
  doc = await edit(native, doc, 'set_layer_mask', { layerId: grouped.id, mask: { x: 2, y: 2, width: 2, height: 2 } });
  const before = await render(native, doc);
  doc = await edit(native, doc, 'rasterize_layer', { layerId: subject });
  assert.equal(doc.layers.find((layer) => layer.id === subject).parentId, grouped.id); assert.deepEqual(await render(native, doc), before);
  doc = await edit(native, doc, 'resize_canvas', { width: 12, height: 12, anchor: 'center' });
  assert.equal(doc.layers.find((layer) => layer.id === grouped.id).transforms, undefined);
  const mask = doc.layers.find((layer) => layer.id === grouped.id).mask;
  assert.deepEqual([mask.x, mask.y, mask.width, mask.height], [4, 4, 2, 2]);
  doc = await edit(native, doc, 'crop_document', { x: 2, y: 2, width: 8, height: 8 });
  assert.deepEqual(await render(native, doc), before);
  doc = await edit(native, doc, 'resize_document', { width: 16, height: 16 });
  assert.equal(doc.layers.find((layer) => layer.id === grouped.id).mask.width, 4);
  for (const command of ['transform_layer', 'rasterize_layer', 'set_layer_effects', 'set_layer_protection']) await assert.rejects(edit(native, doc, command, { layerId: grouped.id, x: 0, y: 0, effects: {}, protected: true }), coded('INVALID_TARGET'));
});

test('placing grouped content rejects nonneutral ancestors and preserves exact pixels from neutral nested groups', async (t) => {
  const { native, document: initial } = await fixture(t);
  let doc = await shape(native, initial, '#ffaa00'); const subject = doc.layers.at(-1).id;
  const grouped = await wrap(native, doc, [subject]); doc = grouped.document;
  doc = await edit(native, doc, 'set_layer', { layerId: grouped.id, opacity: 0.5 });
  doc = await edit(native, doc, 'set_layer_mask', { layerId: grouped.id, mask: { x: 2, y: 2, width: 2, height: 2 } });
  let target = (await native.execute('create_document', { width: 8, height: 8 })).document;
  target = await edit(native, target, 'set_layer', { layerId: target.layers[0].id, visible: false });
  const placement = { sourceDocumentId: doc.id, sourceLayerId: subject, x: 0, y: 0, width: 8, height: 8 };
  await assert.rejects(edit(native, target, 'place_layer', placement), (cause) => cause.code === 'INVALID_TARGET' && /mask/.test(cause.message));
  assert.deepEqual(await get(native, target), target);
  doc = await edit(native, doc, 'set_layer_mask', { layerId: grouped.id, mask: null });
  await assert.rejects(edit(native, target, 'place_layer', placement), (cause) => cause.code === 'INVALID_TARGET' && /opacity/.test(cause.message));
  doc = await edit(native, doc, 'set_layer', { layerId: grouped.id, opacity: 1 });
  const outer = await wrap(native, doc, [grouped.id]); doc = outer.document;
  target = await edit(native, target, 'place_layer', placement);
  const placed = target.layers.at(-1); assert.equal(placed.opacity, 1); assert.deepEqual(placed.placement.sourceBounds, { left: 0, top: 0, width: 8, height: 8 });
  assert.deepEqual(pixel(await render(native, target), 2, 2), [255, 170, 0, 255]);
  assert.equal(pixel(await native.renderLayer(placed), 2, 2)[3], 255);
  await assert.rejects(edit(native, target, 'place_layer', { sourceDocumentId: doc.id, sourceLayerId: grouped.id, x: 0, y: 0, width: 4, height: 4 }), coded('INVALID_TARGET'));
});

test('depth, total nodes and large masked-group scratch budgets reject before saving without rendering huge images', async (t) => {
  const { native, document: initial, dataDir } = await fixture(t, { width: 6000, height: 4000 });
  let doc = initial, parentId;
  for (let index = 0; index < 3; index++) { doc = await edit(native, doc, 'create_group', { parentId, name: `g${index}` }); parentId = doc.layers.at(-1).id; }
  const groups = doc.layers.filter((layer) => layer.type === 'group');
  for (const group of groups.slice(0, 2)) doc = await edit(native, doc, 'set_layer_mask', { layerId: group.id, mask: { x: 0, y: 0, width: 1, height: 1 } });
  const file = path.join(dataDir, 'projects', `${doc.id}.json`), bytes = await fs.readFile(file);
  await assert.rejects(edit(native, doc, 'set_layer_mask', { layerId: groups[2].id, mask: { x: 0, y: 0, width: 1, height: 1 } }), coded('LIMIT_EXCEEDED'));
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await fs.readFile(file), bytes);
  // Empty/neutral nesting needs no retained image buffers.
  for (let index = 3; index < 8; index++) { doc = await edit(native, doc, 'create_group', { parentId, name: `g${index}` }); parentId = doc.layers.at(-1).id; }
  await assert.rejects(edit(native, doc, 'create_group', { parentId }), coded('LIMIT_EXCEEDED'));
  const small = await fixture(t); let capped = small.document;
  for (let index = 0; index < 63; index++) capped = await edit(small.native, capped, 'create_group', {});
  await assert.rejects(edit(small.native, capped, 'create_group', {}), coded('LIMIT_EXCEEDED'));
  const empty = capped.layers.at(-1).id;
  capped = await edit(small.native, capped, 'set_layer', { layerId: empty, opacity: 0, visible: false });
  capped = await edit(small.native, capped, 'ungroup_layer', { layerId: empty }); assert.equal(capped.layers.length, 63);
});
