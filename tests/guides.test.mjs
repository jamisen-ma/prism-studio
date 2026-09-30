import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { normalizeGuides, updatedGuides, transformGuides, MAX_GUIDES } from '../server/guides.mjs';
import { canvasTransform } from '../server/canvas.mjs';
import { encodeProjectBundle } from '../server/project-bundle.mjs';

const coded = code => error => error.code === code;
const guide = (axis, position) => ({ id: randomUUID(), axis, position });
const edit = async (native, doc, command, args = {}) => (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document;
const get = async (native, doc) => (await native.execute('get_document', { documentId: doc.id })).document;
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-guides-'));
  const native = await new NativeBackend({ dataDir }).init();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const pixels = Buffer.alloc(9 * 7 * 4);
  for (let i = 0; i < 63; i++) pixels.set([i * 3 % 256, 19 + i % 79, 201 - i, 255], i * 4);
  const source = await sharp(pixels, { raw: { width: 9, height: 7, channels: 4 } }).png().toBuffer();
  const document = (await native.execute('import_image', { mimeType: 'image/png', data: source.toString('base64') })).document;
  return { native, dataDir, document, source };
}

test('guide coordinates use integer inclusive boundaries and unique IDs while coincident positions remain valid', () => {
  const entries = [guide('vertical', 0), guide('vertical', 9), guide('horizontal', 0), guide('horizontal', 7), guide('vertical', 9)], snapshot = structuredClone(entries);
  assert.deepEqual(normalizeGuides(entries, 9, 7), entries);
  const normalized = normalizeGuides(entries, 9, 7); normalized[0].position = 3; assert.deepEqual(entries, snapshot);
  for (const entry of [guide('horizontal', 8), guide('vertical', 10), guide('vertical', -1), guide('vertical', 0.5), guide('vertical', NaN), guide('horizontal', Infinity), guide('diagonal', 1), { ...entries[0], color: '#fff' }, { ...entries[0], id: 'bad' }]) assert.throws(() => normalizeGuides([entry], 9, 7), coded('INVALID_ARGUMENT'));
  assert.throws(() => normalizeGuides([entries[0], entries[0]], 9, 7), coded('INVALID_ARGUMENT'));
  assert.throws(() => normalizeGuides(Array.from({ length: 65 }, () => guide('vertical', 1)), 9, 7), coded('LIMIT_EXCEEDED'));
  const graph = { width: 9, height: 7, guides: entries };
  assert.throws(() => updatedGuides(graph, 'update_guide', { guideId: entries[0].id, position: 1, axis: 'horizontal' }), coded('INVALID_ARGUMENT'));
  assert.throws(() => updatedGuides(graph, 'add_guide', { axis: 'vertical', position: 1, visible: false }), coded('INVALID_ARGUMENT'));
  assert.deepEqual(graph.guides, snapshot);
});

test('geometry applies exactly once with stable order/IDs, resize collisions, crop boundaries and all nine canvas anchors', () => {
  const entries = [...[0, 1, 4, 8, 9].map(p => guide('vertical', p)), ...[0, 1, 3, 6, 7].map(p => guide('horizontal', p))], before = structuredClone(entries);
  const resized = transformGuides(entries, { type: 'resize', width: 5, height: 3 }, 9, 7);
  assert.deepEqual(resized.map(g => g.position), [0, 1, 2, 4, 5, 0, 0, 1, 3, 3]);
  assert.deepEqual(resized.map(g => g.id), entries.map(g => g.id));
  assert.notEqual(resized[5].id, resized[6].id);
  const cropped = transformGuides(entries, { type: 'crop', x: 2, y: 1, width: 5, height: 5 }, 9, 7);
  assert.deepEqual(cropped, [ { ...entries[2], position: 2 }, { ...entries[6], position: 0 }, { ...entries[7], position: 2 }, { ...entries[8], position: 5 } ]);
  const axes = { 'top-left': [0, 0], top: [1, 0], 'top-right': [2, 0], left: [0, 1], center: [1, 1], right: [2, 1], 'bottom-left': [0, 2], bottom: [1, 2], 'bottom-right': [2, 2] };
  for (const [anchor, [column, row]] of Object.entries(axes)) {
    for (const [width, height, offsets] of [[6, 4, [0, -2, -3]], [12, 10, [0, 1, 3]]]) {
      const actual = transformGuides(entries, canvasTransform(9, 7, width, height, anchor), 9, 7);
      const expected = entries.map(g => ({ ...g, position: g.position + offsets[g.axis === 'vertical' ? column : row] })).filter(g => g.position >= 0 && g.position <= (g.axis === 'vertical' ? width : height));
      assert.deepEqual(actual, expected, anchor);
    }
  }
  assert.deepEqual(entries, before);
  assert.throws(() => transformGuides(entries, { type: 'crop', x: 8, y: 0, width: 2, height: 1 }, 9, 7), coded('INVALID_ARGUMENT'));
});

test('guide CRUD is pixel-neutral across previews, histogram, sampling, AI snapshots and flattened/PSD exports', async t => {
  const { native, document: initial, source } = await fixture(t), layerId = initial.layers[0].id;
  assert.deepEqual(initial.guides, []);
  const assets = await fs.readdir(native.assetsDir), working = await fs.readFile(path.join(native.assetsDir, initial.layers[0].asset));
  const read = async doc => {
    const args = { documentId: doc.id }, preview = await native.execute('get_preview', args), layerView = await native.execute('get_layer_preview', { ...args, layerId }), sourceView = await native.execute('get_layer_preview', { ...args, layerId, view: 'source' });
    return { preview: preview.data, layer: layerView.data, source: sourceView.data, histogram: await native.execute('get_histogram', args), sample: await native.execute('sample_color', { ...args, x: 3, y: 2 }), snapshot: (await native.snapshotForGeneration({ ...args, expectedRevision: doc.revision, scope: 'canvas' })).image, png: (await native.execute('export_document', { ...args, format: 'png' })).data, psd: (await native.exportPsd(args)).data };
  };
  const before = await read(initial);
  native.storeAsset = async () => { assert.fail('Guide edits must not write image assets'); };
  let document = await edit(native, initial, 'add_guide', { axis: 'vertical', position: 9 }); const id = document.guides[0].id;
  document = await edit(native, document, 'add_guide', { axis: 'horizontal', position: 0 });
  document = await edit(native, document, 'update_guide', { guideId: id, position: 4 });
  assert.equal(document.guides[0].id, id); assert.equal(document.guides[0].axis, 'vertical');
  assert.deepEqual(await read(document), before); assert.deepEqual(document.layers, initial.layers); assert.deepEqual(document.selection, initial.selection);
  document = await edit(native, document, 'delete_guide', { guideId: id }); document = await edit(native, document, 'clear_guides');
  assert.deepEqual(document.guides, []); assert.deepEqual(await read(document), before);
  assert.deepEqual(await fs.readdir(native.assetsDir), assets); assert.deepEqual(await fs.readFile(path.join(native.assetsDir, initial.layers[0].asset)), working); assert.deepEqual(await fs.readFile(path.join(native.assetsDir, initial.layers[0].sourceAsset)), source);
});

test('native geometry and undo/reopen retain correct positions and recover guides dropped by bounds operations', async t => {
  const { native, dataDir, document: initial } = await fixture(t);
  let document = initial;
  for (const [axis, position] of [['vertical', 0], ['vertical', 4], ['vertical', 9], ['horizontal', 0], ['horizontal', 3], ['horizontal', 7]]) document = await edit(native, document, 'add_guide', { axis, position });
  const original = structuredClone(document.guides);
  document = await edit(native, document, 'crop_document', { x: 2, y: 1, width: 5, height: 5 });
  assert.deepEqual(document.guides, [{ ...original[1], position: 2 }, { ...original[4], position: 2 }]);
  document = await edit(native, document, 'undo'); assert.deepEqual(document.guides, original);
  document = await edit(native, document, 'resize_document', { width: 5, height: 3 });
  assert.deepEqual(document.guides.map(g => g.position), [0, 2, 5, 0, 1, 3]);
  document = await edit(native, document, 'resize_canvas', { width: 8, height: 6, anchor: 'center' });
  assert.deepEqual(document.guides.map(g => g.position), [1, 3, 6, 1, 2, 4]);
  const guideState = structuredClone(document.guides);
  document = await edit(native, document, 'transform_layer', { layerId: document.layers[0].id, x: 1, y: 1 }); assert.deepEqual(document.guides, guideState);
  const reopened = await new NativeBackend({ dataDir }).init(); assert.equal(reopened.loadWarnings.length, 0); assert.deepEqual(await get(reopened, document), document);
  document = await edit(reopened, document, 'clear_guides'); document = await edit(reopened, document, 'undo'); assert.deepEqual(document.guides, guideState);
  document = await edit(reopened, document, 'redo'); assert.deepEqual(document.guides, []);
});

test('capacity, malformed edits, revisions, transaction rollback and disk failures preserve prior guide state', async t => {
  const { native, document: initial } = await fixture(t);
  let document = initial;
  for (let i = 0; i < MAX_GUIDES; i++) document = await edit(native, document, 'add_guide', { axis: 'vertical', position: i % 10 });
  const id = document.guides[0].id;
  await assert.rejects(edit(native, document, 'add_guide', { axis: 'horizontal', position: 0 }), coded('LIMIT_EXCEEDED'));
  document = await edit(native, document, 'update_guide', { guideId: id, position: 9 }); assert.equal(document.guides.length, 64);
  const before = document, file = path.join(native.projectsDir, `${document.id}.json`), bytes = await fs.readFile(file);
  for (const position of [-1, 10, 0.25, NaN, Infinity]) await assert.rejects(edit(native, document, 'update_guide', { guideId: id, position }), coded('INVALID_ARGUMENT'));
  await assert.rejects(edit(native, document, 'delete_guide', { guideId: randomUUID() }), coded('NOT_FOUND'));
  await assert.rejects(edit(native, document, 'clear_guides', { expectedRevision: document.revision - 1 }), coded('REVISION_CONFLICT'));
  await assert.rejects(edit(native, document, 'apply_transaction', { operations: [{ command: 'clear_guides', args: {} }, { command: 'add_guide', args: { axis: 'horizontal', position: 8 } }] }), coded('INVALID_ARGUMENT'));
  const persist = native.persist.bind(native); native.persist = async () => { throw Object.assign(new Error('Injected disk failure'), { code: 'EIO' }); };
  await assert.rejects(edit(native, document, 'clear_guides'), coded('EIO')); native.persist = persist;
  assert.deepEqual(await get(native, document), before); assert.deepEqual(await fs.readFile(file), bytes);
  const caps = await native.execute('capabilities'); assert.equal(caps.limits.maxGuides, 64); assert.deepEqual(caps.guideAxes, ['horizontal', 'vertical']); assert.equal(caps.guideCoordinates, 'document-pixels');
});

test('portable transfer preserves guide IDs/order and rejects malformed canonical metadata before writing assets', async t => {
  const { native, document: initial } = await fixture(t), target = await fixture(t);
  let document = await edit(native, initial, 'add_guide', { axis: 'horizontal', position: 7 });
  document = await edit(native, document, 'add_guide', { axis: 'horizontal', position: 7 });
  const bundle = await native.exportProject({ documentId: document.id }), imported = (await target.native.importProject({ data: bundle.data })).document;
  assert.notEqual(imported.id, document.id); assert.deepEqual(imported.guides, document.guides); assert.equal(imported.revision, 1);
  document = await edit(native, document, 'clear_guides'); assert.equal((await get(target.native, imported)).guides.length, 2);
  const graph = native.project(document.id).states.at(-1).graph;
  for (const entries of [[guide('vertical', 10)], [guide('horizontal', 0.5)], [{ ...guide('horizontal', 0), color: 'red' }]]) await assert.rejects(encodeProjectBundle({ graph: { ...graph, guides: entries }, validateGraph: () => true, readAsset: async () => { assert.fail('Guide validation must precede asset reads'); } }), coded('INVALID_PROJECT_BUNDLE'));
  const length = bundle.data.readUInt32BE(8), manifest = JSON.parse(bundle.data.subarray(12, 12 + length));
  manifest.graph.guides[1].id = manifest.graph.guides[0].id;
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const bytes = Buffer.from(JSON.stringify(canonical(manifest))), prefix = Buffer.from(bundle.data.subarray(0, 12)); prefix.writeUInt32BE(bytes.length, 8);
  const invalid = Buffer.concat([prefix, bytes, bundle.data.subarray(12 + length)]), projects = await fs.readdir(target.native.projectsDir), assets = await fs.readdir(target.native.assetsDir);
  await assert.rejects(target.native.importProject({ data: invalid }), coded('INVALID_PROJECT_BUNDLE'));
  assert.deepEqual(await fs.readdir(target.native.projectsDir), projects); assert.deepEqual(await fs.readdir(target.native.assetsDir), assets);
});
