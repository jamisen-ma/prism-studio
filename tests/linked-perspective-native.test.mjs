import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { linkedPerspectiveCorners } from '../shared/linked-perspective.mjs';

const graphOf = (native, document) => native.project(document.id).states[native.project(document.id).cursor].graph;
const edit = async (native, document, command, args = {}) => (await native.execute(command, { documentId: document.id, expectedRevision: document.revision, ...args })).document;

test('Linked Perspective historical corners equal ordinary manual Distort through retained source filters, mask and resize', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-linked-perspective-'));
  const native = await new NativeBackend({ dataDir }).init();
  t.after(async () => { await native.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const width = 12, height = 10;
  const rgba = Buffer.from(Array.from({ length: width * height }, (_, i) => [(17 + i * 53) % 256, (40 + i * 173) % 256, (121 + i * 97) % 256, [0, 1, 128, 255][i % 4]]).flat());
  const source = await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const baseline = [{ x: .5, y: .25 }, { x: 11.5, y: -.25 }, { x: 11.75, y: 9.5 }, { x: -.25, y: 10 }];
  const documents = [];
  for (let copy = 0; copy < 2; copy++) {
    let document = (await native.execute('import_image', { mimeType: 'image/png', data: source.toString('base64') })).document;
    const layerId = document.layers[0].id;
    document = await edit(native, document, 'add_layer_filter', { layerId, kind: 'invert', value: 100, opacity: .625 });
    document = await edit(native, document, 'set_layer_filter_mask', { layerId, source: 'mask', mask: { shape: 'rectangle', x: 1, y: 1, width: 9, height: 8 } });
    document = await edit(native, document, 'add_layer_distort', { layerId, corners: baseline });
    document = await edit(native, document, 'set_layer_mask', { layerId, mask: { shape: 'rectangle', x: 1, y: 0, width: 10, height: 9, feather: 1 } });
    document = await edit(native, document, 'crop_document', { x: 1, y: 1, width: 10, height: 8 });
    document = await edit(native, document, 'resize_document', { width: 15, height: 12, resample: 'nearest' });
    documents.push(document);
  }
  const before = structuredClone(documents[0].layers[0]);
  const proposed = linkedPerspectiveCorners(baseline, { cornerIndex: 1, axis: 'horizontal', delta: -.625 });
  assert.equal(proposed.withinBounds, true);
  const manual = [{ x: 1.125, y: .25 }, { x: 10.875, y: -.25 }, { x: 11.75, y: 9.5 }, { x: -.25, y: 10 }];
  assert.deepEqual(proposed.corners, manual);
  for (let copy = 0; copy < 2; copy++) documents[copy] = await edit(native, documents[copy], 'update_layer_distort', { layerId: documents[copy].layers[0].id, transformIndex: 0, corners: copy ? manual : proposed.corners });
  assert.deepEqual(documents[0].layers[0].transforms, documents[1].layers[0].transforms);
  assert.deepEqual(documents[0].layers[0].transforms.slice(1), before.transforms.slice(1));
  assert.deepEqual(documents[0].layers[0].mask, before.mask);
  assert.deepEqual(documents[0].layers[0].filters, before.filters);
  assert.deepEqual(await native.renderGraph(graphOf(native, documents[0])), await native.renderGraph(graphOf(native, documents[1])));
  assert.deepEqual(await fs.readFile(path.join(native.assetsDir, before.asset)), source);
  assert.equal(documents[0].layers[0].sourceAsset, before.sourceAsset);
  const stable = JSON.stringify(native.project(documents[0].id));
  for (const corners of [
    linkedPerspectiveCorners(baseline, { cornerIndex: 0, axis: 'horizontal', delta: 32768 }).corners,
    linkedPerspectiveCorners(baseline, { cornerIndex: 0, axis: 'horizontal', delta: 8 }).corners
  ]) {
    await assert.rejects(edit(native, documents[0], 'update_layer_distort', { layerId: before.id, transformIndex: 0, corners }), { code: 'INVALID_ARGUMENT' });
    assert.equal(JSON.stringify(native.project(documents[0].id)), stable);
  }
});
