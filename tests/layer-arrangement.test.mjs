import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { NativeBackend } from '../server/native.mjs';
import { planAlignment, planDistribution } from '../server/arrangement.mjs';
import { alphaBounds } from '../server/cutout-pixels.mjs';

const item = (id, x, width, y = 2, height = 2) => ({ id, bounds: { x, y, width, height } });
const coded = (code) => (cause) => cause.code === code;
const edit = async (native, doc, command, args = {}) => (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document;
const get = async (native, doc) => (await native.execute('get_document', { documentId: doc.id })).document;
const find = (doc, id) => doc.layers.find((layer) => layer.id === id);
const bounds = async (native, doc, id) => alphaBounds(await native.visibleLayerPixels(doc, find(doc, id), { outline: false, effects: false }), doc.width, doc.height);
async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-arrangement-'));
  const native = await new NativeBackend({ dataDir, segmentSubject: options.segmentSubject }).init();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const doc = (await native.execute('create_document', { width: options.width ?? 40, height: options.height ?? 24 })).document;
  return { native, doc, dataDir };
}
async function shape(native, doc, x, width, { y = 3, height = 3, ...options } = {}) {
  const next = await edit(native, doc, 'add_shape', { shape: 'rectangle', fill: '#2468ad', x, y, width, height, ...options });
  return { doc: next, id: next.layers.at(-1).id };
}

test('alignment uses intrinsic bounds, supports all axes/anchors and rounds half pixels deterministically', () => {
  const items = [item('a', 3, 3, 4, 5), item('b', 10, 6, 8, 2)], before = structuredClone(items);
  const base = { items, width: 21, height: 17, axis: 'horizontal' };
  assert.deepEqual(planAlignment({ ...base, alignment: 'start' }), [{ layerId: 'a', x: -3, y: 0 }, { layerId: 'b', x: -10, y: 0 }]);
  assert.deepEqual(planAlignment({ ...base, alignment: 'center' }), [{ layerId: 'a', x: 6, y: 0 }, { layerId: 'b', x: -2, y: 0 }]);
  assert.deepEqual(planAlignment({ ...base, alignment: 'end' }), [{ layerId: 'a', x: 15, y: 0 }, { layerId: 'b', x: 5, y: 0 }]);
  assert.deepEqual(planAlignment({ ...base, alignment: 'center', relativeTo: 'layers' }), [{ layerId: 'a', x: 5, y: 0 }, { layerId: 'b', x: -3, y: 0 }]);
  for (const [alignment, expected] of [['start', [-4, -8]], ['center', [2, 0]], ['end', [8, 7]]]) {
    assert.deepEqual(planAlignment({ ...base, axis: 'vertical', alignment }).map((move) => move.y), expected);
  }
  assert.deepEqual(items, before);
});

test('equal gaps preserve endpoints and distribute indivisible spacing within one pixel', () => {
  const items = [item('first', 1, 3), item('middle', 8, 4), item('last', 20, 2)];
  const moves = planDistribution({ items, width: 24, height: 8, axis: 'horizontal' });
  assert.deepEqual(moves, [{ layerId: 'first', x: 0, y: 0 }, { layerId: 'middle', x: 2, y: 0 }, { layerId: 'last', x: 0, y: 0 }]);
  const positioned = items.map((entry, index) => ({ ...entry.bounds, x: entry.bounds.x + moves[index].x }));
  const gaps = positioned.slice(1).map((box, index) => box.x - (positioned[index].x + positioned[index].width));
  assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 1);
  const vertical = items.map((entry) => ({ ...entry, bounds: { x: 2, y: entry.bounds.x, width: 2, height: entry.bounds.width } }));
  assert.deepEqual(planDistribution({ items: vertical, width: 8, height: 24, axis: 'vertical' }).map((move) => move.y), [0, 2, 0]);
});

test('center distribution uses stable canonical ties, permits overlap and rejects new clipping or impossible gaps', () => {
  const items = [item('wide', 0, 10), item('small', 4, 2), item('last', 10, 2)];
  assert.deepEqual(planDistribution({ items, width: 20, height: 8, axis: 'horizontal', spacing: 'centers' }), [{ layerId: 'wide', x: 0, y: 0 }, { layerId: 'small', x: 3, y: 0 }, { layerId: 'last', x: 0, y: 0 }]);
  assert.throws(() => planDistribution({ items, width: 20, height: 8, axis: 'horizontal' }), coded('INVALID_ARGUMENT'));
  assert.throws(() => planDistribution({ items: [item('a', 0, 1), item('b', 0, 20), item('c', 10, 1)], width: 20, height: 8, axis: 'horizontal', spacing: 'centers' }), coded('INVALID_ARGUMENT'));
  assert.throws(() => planAlignment({ items: [items[0]], width: 20, height: 8, axis: 'horizontal', alignment: 'start', relativeTo: 'layers' }), coded('INVALID_ARGUMENT'));
  assert.throws(() => planAlignment({ items: [items[0], items[0]], width: 20, height: 8, axis: 'horizontal', alignment: 'start' }), coded('INVALID_ARGUMENT'));
});

test('protected source cutouts translate byte-exactly, excluding editable styles, with independent selections and one undo', async (t) => {
  const width = 24, height = 14, raw = Buffer.alloc(width * height * 4), alpha = Buffer.alloc(width * height);
  for (let index = 0; index < width * height; index++) raw.set([index % 251, (index * 17) % 255, (index * 31) % 255, 255], index * 4);
  for (let y = 2; y < 6; y++) for (let x = 5; x < 8; x++) alpha[y * width + x] = x === 5 ? 1 : x === 6 ? 128 : 255;
  const { native, dataDir } = await fixture(t, { width, height, segmentSubject: async () => ({ alpha: Buffer.from(alpha), width, height, model: 'fixture' }) });
  const png = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
  let doc = (await native.execute('import_image', { data: png.toString('base64'), mimeType: 'image/png' })).document;
  doc = await edit(native, doc, 'extract_subject', { layerId: doc.layers[0].id }); const id = doc.layers.at(-1).id;
  doc = await edit(native, doc, 'set_layer_outline', { layerId: id, width: 2 });
  doc = await edit(native, doc, 'set_layer_effects', { layerId: id, effects: { shadow: { x: 4, y: 2, blur: 1 } } });
  doc = await edit(native, doc, 'select_rectangle', { x: 1, y: 1, width: 2, height: 2 });
  doc = await edit(native, doc, 'save_selection', { name: 'Independent layout region' });
  doc = await edit(native, doc, 'group_layers', { layerIds: [id], name: 'Neutral nesting' });
  const before = doc, source = await native.renderLayer(find(doc, id)), pixelsBefore = await native.renderGraph(doc), assets = await fs.readdir(path.join(dataDir, 'assets'));
  doc = await edit(native, doc, 'align_layers', { layerIds: [id], axis: 'horizontal', alignment: 'end' });
  assert.deepEqual(await bounds(native, doc, id), { left: 21, top: 2, width: 3, height: 4 });
  const after = await native.renderLayer(find(doc, id));
  for (let y = 0; y < height; y++) for (let x = 0; x < width - 16; x++) {
    assert.deepEqual(after.subarray((y * width + x + 16) * 4, (y * width + x + 17) * 4), source.subarray((y * width + x) * 4, (y * width + x + 1) * 4));
  }
  assert.equal(doc.history.length, before.history.length + 1); assert.equal(doc.revision, before.revision + 1);
  assert.deepEqual(doc.selection, before.selection); assert.deepEqual(doc.savedSelections, before.savedSelections);
  const moved = structuredClone(find(doc, id)); moved.transforms.pop(); assert.deepEqual(moved, find(before, id));
  assert.deepEqual(doc.layers.map((layer) => layer.id), before.layers.map((layer) => layer.id));
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'assets')), assets);
  assert.deepEqual(await fs.readFile(path.join(dataDir, 'assets', moved.sourceAsset)), png);
  const pixelsAfter = await native.renderGraph(doc), reopened = await new NativeBackend({ dataDir }).init();
  assert.equal(reopened.loadWarnings.length, 0); assert.deepEqual(await reopened.renderGraph(await get(reopened, doc)), pixelsAfter);
  doc = await edit(reopened, doc, 'undo'); assert.deepEqual(await reopened.renderGraph(doc), pixelsBefore);
  doc = await edit(reopened, doc, 'redo'); assert.deepEqual(await reopened.renderGraph(doc), pixelsAfter);
});

test('native distribution ignores requested ID order and outside effects while retaining endpoint transforms', async (t) => {
  const { native, doc: initial } = await fixture(t); let doc = initial;
  const a = await shape(native, doc, 2, 3); doc = a.doc;
  const b = await shape(native, doc, 8, 4); doc = b.doc;
  const c = await shape(native, doc, 30, 2); doc = c.doc;
  doc = await edit(native, doc, 'set_layer_effects', { layerId: b.id, effects: { glow: { blur: 3 }, shadow: { x: 10, y: 0, blur: 0 } } });
  const first = find(doc, a.id), last = find(doc, c.id), middleEffects = find(doc, b.id).effects;
  doc = await edit(native, doc, 'distribute_layers', { layerIds: [c.id, a.id, b.id], axis: 'horizontal' });
  assert.deepEqual(find(doc, a.id), first); assert.deepEqual(find(doc, c.id), last);
  assert.deepEqual(await bounds(native, doc, b.id), { left: 16, top: 3, width: 4, height: 3 });
  assert.deepEqual(find(doc, b.id).effects, middleEffects);
  doc = await edit(native, doc, 'align_layers', { layerIds: [a.id, b.id, c.id], axis: 'vertical', alignment: 'end', relativeTo: 'layers' });
  for (const id of [a.id, b.id, c.id]) assert.equal((await bounds(native, doc, id)).top, 3);
});

test('native center ties use document order, and a later invalid target rolls back every planned move', async (t) => {
  const { native, doc: initial, dataDir } = await fixture(t); let doc = initial;
  const a = await shape(native, doc, 0, 10); doc = a.doc;
  const b = await shape(native, doc, 4, 2); doc = b.doc;
  const c = await shape(native, doc, 10, 2); doc = c.doc;
  doc = await edit(native, doc, 'distribute_layers', { layerIds: [b.id, c.id, a.id], axis: 'horizontal', spacing: 'centers' });
  assert.equal((await bounds(native, doc, a.id)).left, 0); assert.equal((await bounds(native, doc, b.id)).left, 7); assert.equal((await bounds(native, doc, c.id)).left, 10);
  doc = await edit(native, doc, 'add_paint_layer'); const empty = doc.layers.at(-1).id;
  const before = await native.renderGraph(doc), file = path.join(dataDir, 'projects', `${doc.id}.json`), bytes = await fs.readFile(file);
  for (const [args, code] of [
    [{ layerIds: [a.id, empty] }, 'EMPTY_LAYER'], [{ layerIds: [a.id, randomUUID()] }, 'NOT_FOUND'],
    [{ layerIds: [a.id, a.id] }, 'INVALID_ARGUMENT'], [{ layerIds: [] }, 'INVALID_ARGUMENT'],
    [{ layerIds: [a.id], relativeTo: 'layers' }, 'INVALID_ARGUMENT'], [{ layerIds: [a.id], axis: 'depth' }, 'INVALID_ARGUMENT'],
  ]) await assert.rejects(edit(native, doc, 'align_layers', { axis: 'horizontal', alignment: 'end', ...args }), coded(code));
  await assert.rejects(edit(native, doc, 'apply_transaction', { operations: [
    { command: 'align_layers', args: { layerIds: [a.id], axis: 'vertical', alignment: 'end' } },
    { command: 'distribute_layers', args: { layerIds: [a.id, b.id, c.id], axis: 'horizontal', spacing: 'gaps' } },
  ] }), coded('INVALID_ARGUMENT'));
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await fs.readFile(file), bytes); assert.deepEqual(await native.renderGraph(doc), before);
});

test('masked or hidden targets and nonneutral ancestors reject before changes; neutral nested leaves remain supported', async (t) => {
  const { native, doc: initial } = await fixture(t);
  let result = await shape(native, initial, 5, 3), doc = result.doc; const id = result.id;
  doc = await edit(native, doc, 'group_layers', { layerIds: [id] }); const group = doc.layers.find((layer) => layer.type === 'group').id;
  doc = await edit(native, doc, 'group_layers', { layerIds: [group] }); const outer = doc.layers.find((layer) => layer.type === 'group' && layer.id !== group).id;
  const cases = [
    ['set_layer_mask', { layerId: id, mask: { x: 0, y: 0, width: 40, height: 24 } }],
    ['set_layer_mask', { layerId: outer, mask: { x: 0, y: 0, width: 40, height: 24 } }],
    ['set_layer', { layerId: outer, opacity: 0.9 }], ['set_layer', { layerId: group, visible: false }],
    ['set_layer', { layerId: id, visible: false }], ['set_layer', { layerId: id, opacity: 0 }],
  ];
  for (const [command, args] of cases) {
    doc = await edit(native, doc, command, args); const before = doc;
    await assert.rejects(edit(native, doc, 'align_layers', { layerIds: [id], axis: 'horizontal', alignment: 'start' }), coded('INVALID_TARGET'));
    assert.deepEqual(await get(native, doc), before); doc = await edit(native, doc, 'undo');
  }
  doc = await edit(native, doc, 'add_adjustment', { kind: 'brightness', value: 10 });
  for (const bad of [group, doc.layers.at(-1).id]) await assert.rejects(edit(native, doc, 'align_layers', { layerIds: [bad], axis: 'vertical', alignment: 'start' }), coded('INVALID_TARGET'));
  doc = await edit(native, doc, 'align_layers', { layerIds: [id], axis: 'horizontal', alignment: 'start' });
  assert.equal((await bounds(native, doc, id)).left, 0); assert.equal(find(doc, id).parentId, group);
});

test('native center spacing rejects a plan that would newly clip wide content, without publishing any history', async (t) => {
  const { native, doc: initial, dataDir } = await fixture(t, { width: 20, height: 8 }); let doc = initial;
  const a = await shape(native, doc, 0, 1); doc = a.doc;
  const b = await shape(native, doc, 0, 20); doc = b.doc;
  const c = await shape(native, doc, 10, 1); doc = c.doc;
  const before = await native.renderGraph(doc), files = await fs.readdir(path.join(dataDir, 'assets'));
  await assert.rejects(edit(native, doc, 'distribute_layers', { layerIds: [a.id, b.id, c.id], axis: 'horizontal', spacing: 'centers' }), coded('INVALID_ARGUMENT'));
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await native.renderGraph(doc), before); assert.deepEqual(await fs.readdir(path.join(dataDir, 'assets')), files);
});
