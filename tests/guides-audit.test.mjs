import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';

const edit = async (native, doc, command, args = {}) => (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document;
const get = async (native, doc) => (await native.execute('get_document', { documentId: doc.id })).document;
async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-guide-audit-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return { dataDir, native: await new NativeBackend({ dataDir, ...options }).init() };
}
const guideOperations = (width, height) => [
  ...[0, 1, 3, width - 1, width].map(position => ({ command: 'add_guide', args: { axis: 'vertical', position } })),
  ...[0, 1, 2, height - 1, height].map(position => ({ command: 'add_guide', args: { axis: 'horizontal', position } })),
];

test('guide metadata performs no rendering or source I/O and leaves every image inspection/export/AI input byte unchanged', async t => {
  const width = 32, height = 24, alpha = Buffer.from(Array.from({ length: width * height }, (_, i) => i % width >= 8 && i % width < 20 ? [1, 128, 255][i % 3] : 0));
  const { native } = await fixture(t, { segmentSubject: async () => ({ width, height, alpha, model: 'guide-audit-only' }) });
  const raw = Buffer.from(Array.from({ length: width * height }, (_, i) => [i * 29 % 256, i * 43 % 256, i * 61 % 256, 255]).flat());
  const source = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
  let doc = (await native.execute('import_image', { data: source.toString('base64'), mimeType: 'image/png' })).document;
  doc = await edit(native, doc, 'extract_subject', { layerId: doc.layers[0].id, hideOriginal: false }); const cutout = doc.layers.at(-1).id;
  doc = await edit(native, doc, 'select_region', { shape: 'ellipse', x: 1, y: 1, width: 25, height: 18, feather: 1.3, invert: true });
  doc = await edit(native, doc, 'save_selection', { name: 'Unaffected selection' });
  async function imageReads(document) {
    const args = { documentId: document.id }, previews = {};
    for (const view of ['layer', 'source', 'mask']) previews[view] = (await native.execute('get_layer_preview', { ...args, layerId: cutout, view })).data;
    const exports = {};
    for (const format of ['png', 'jpeg', 'webp', 'tiff']) exports[format] = (await native.execute('export_document', { ...args, format })).data;
    const snapshot = await native.snapshotForGeneration({ ...args, scope: 'canvas', expectedRevision: document.revision });
    return { previews, exports, preview: (await native.execute('get_preview', args)).data,
      histogram: await native.execute('get_histogram', args), sample: await native.execute('sample_color', { ...args, x: 7, y: 9, radius: 1 }),
      snapshotImage: snapshot.image, snapshotMask: snapshot.mask, psd: (await native.exportPsd({ ...args, expectedRevision: document.revision })).data };
  }
  const before = await imageReads(doc), initial = structuredClone(doc), files = await fs.readdir(native.assetsDir), assets = await Promise.all(files.map(name => fs.readFile(path.join(native.assetsDir, name))));
  const methods = ['renderGraph', 'renderLayer', 'readAlpha', 'readProjectAsset', 'sourcePixels', 'storeAsset', 'storeAlpha'], original = new Map(methods.map(name => [name, native[name]]));
  for (const name of methods) native[name] = async () => { assert.fail(`Guide-only edit must not call ${name}`); };
  try {
    doc = await edit(native, doc, 'add_guide', { axis: 'vertical', position: width });
    doc = await edit(native, doc, 'add_guide', { axis: 'horizontal', position: height });
    doc = await edit(native, doc, 'update_guide', { guideId: doc.guides[0].id, position: 3 });
    doc = await edit(native, doc, 'delete_guide', { guideId: doc.guides[1].id });
  } finally { for (const [name, value] of original) native[name] = value; }
  assert.deepEqual(doc.layers, initial.layers); assert.deepEqual(doc.selection, initial.selection); assert.deepEqual(doc.savedSelections, initial.savedSelections);
  assert.equal(doc.revision, initial.revision + 4); assert.equal(native.previewCache.stats().entries, 0);
  assert.deepEqual(await imageReads(doc), before);
  assert.deepEqual(await fs.readdir(native.assetsDir), files); assert.deepEqual(await Promise.all(files.map(name => fs.readFile(path.join(native.assetsDir, name)))), assets);
});

test('all nine anchors use exact odd-delta offsets, crop drops only outside guides, and resize retains coincident IDs', async t => {
  const { native, dataDir } = await fixture(t);
  const anchors = { 'top-left': [0, 0], top: [1, 0], 'top-right': [2, 0], left: [0, 1], center: [1, 1], right: [2, 1], 'bottom-left': [0, 2], bottom: [1, 2], 'bottom-right': [2, 2] };
  for (const [anchor, axes] of Object.entries(anchors)) {
    let doc = (await native.execute('create_document', { width: 7, height: 5 })).document;
    doc = await edit(native, doc, 'apply_transaction', { operations: guideOperations(7, 5) }); const original = structuredClone(doc.guides);
    for (const [width, height, offsets] of [[10, 8, [0, 1, 3]], [4, 2, [0, -2, -3]]]) {
      doc = await edit(native, doc, 'resize_canvas', { width, height, anchor });
      const expected = original.map(guide => ({ ...guide, position: guide.position + offsets[axes[guide.axis === 'vertical' ? 0 : 1]] }))
        .filter(guide => guide.position >= 0 && guide.position <= (guide.axis === 'vertical' ? width : height));
      assert.deepEqual(doc.guides, expected, `${anchor} to ${width}×${height}`);
      doc = await edit(native, doc, 'undo'); assert.deepEqual(doc.guides, original);
    }
    doc = await edit(native, doc, 'resize_document', { width: 3, height: 2 });
    assert.deepEqual(doc.guides, original.map(guide => ({ ...guide, position: Math.round(guide.position * (guide.axis === 'vertical' ? 3 / 7 : 2 / 5)) })));
    assert.equal(doc.guides.length, original.length); assert.equal(doc.guides[0].position, doc.guides[1].position); assert.notEqual(doc.guides[0].id, doc.guides[1].id);
    doc = await edit(native, doc, 'undo');
    doc = await edit(native, doc, 'crop_document', { x: 1, y: 1, width: 5, height: 3 });
    const expectedCrop = original.map(guide => ({ ...guide, position: guide.position - 1 })).filter(guide => guide.position >= 0 && guide.position <= (guide.axis === 'vertical' ? 5 : 3));
    assert.deepEqual(doc.guides, expectedCrop);
    const reopened = await new NativeBackend({ dataDir }).init(); assert.equal(reopened.loadWarnings.length, 0); assert.deepEqual((await get(reopened, doc)).guides, expectedCrop);
  }
});

test('invalid guide transactions, stale updates and actual save failure retain guide identities, history, project bytes and warm cache', async t => {
  const { native } = await fixture(t);
  let doc = (await native.execute('create_document', { width: 11, height: 7 })).document;
  doc = await edit(native, doc, 'add_guide', { axis: 'vertical', position: 11 }); const guideId = doc.guides[0].id;
  const file = path.join(native.projectsDir, `${doc.id}.json`), bytes = await fs.readFile(file), preview = await native.execute('get_preview', { documentId: doc.id }), cache = native.previewCache.stats();
  for (const [command, args] of [
    ['update_guide', { guideId, position: 7, axis: 'horizontal' }],
    ['update_guide', { guideId, position: 0.5 }],
    ['add_guide', { axis: 'horizontal', position: 8 }],
    ['add_guide', { axis: 'vertical', position: 12 }],
    ['delete_guide', { guideId: randomUUID() }],
    ['clear_guides', { axis: 'vertical' }],
    ['apply_transaction', { operations: [{ command: 'update_guide', args: { guideId, position: 0 } }, { command: 'add_guide', args: { axis: 'horizontal', position: 8 } }] }],
  ]) await assert.rejects(edit(native, doc, command, args));
  await assert.rejects(native.execute('delete_guide', { documentId: doc.id, expectedRevision: doc.revision - 1, guideId }), { code: 'REVISION_CONFLICT' });
  const directory = native.projectsDir; native.projectsDir = file;
  try { await assert.rejects(edit(native, doc, 'clear_guides')); } finally { native.projectsDir = directory; }
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await fs.readFile(file), bytes); assert.deepEqual(native.previewCache.stats(), cache);
  assert.deepEqual(await native.execute('get_preview', { documentId: doc.id }), preview);
});

test('canonical bundles containing malformed guide metadata reject before asset validation or publication', async t => {
  const { native: source } = await fixture(t), { native: target } = await fixture(t);
  const png = await sharp({ create: { width: 9, height: 5, channels: 4, background: '#553377' } }).png().toBuffer();
  const doc = (await source.execute('import_image', { data: png.toString('base64'), mimeType: 'image/png' })).document;
  const { data: valid } = await source.exportProject({ documentId: doc.id }), length = valid.readUInt32BE(8), manifest = JSON.parse(valid.subarray(12, 12 + length));
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const guide = { id: randomUUID(), axis: 'vertical', position: 9 };
  const invalid = [[{ ...guide, position: 10 }], [{ ...guide, position: 0.5 }], [{ ...guide, axis: 'diagonal' }], [{ ...guide, color: '#ff0000' }], [guide, structuredClone(guide)], Array.from({ length: 65 }, () => ({ ...guide, id: randomUUID() }))];
  target.storeAsset = target.validateProjectAsset = async () => { assert.fail('Invalid guides must reject before image validation or storage.'); };
  for (const guides of invalid) {
    const body = Buffer.from(JSON.stringify(canonical({ ...manifest, graph: { ...manifest.graph, guides } }))), prefix = Buffer.from(valid.subarray(0, 12)); prefix.writeUInt32BE(body.length, 8);
    await assert.rejects(target.importProject({ data: Buffer.concat([prefix, body, valid.subarray(12 + length)]) }), { code: guides.length > 64 ? 'LIMIT_EXCEEDED' : 'INVALID_PROJECT_BUNDLE' });
  }
  assert.equal(target.projects.size, 0); assert.deepEqual(await fs.readdir(target.projectsDir), []); assert.deepEqual(await fs.readdir(target.assetsDir), []);
});
