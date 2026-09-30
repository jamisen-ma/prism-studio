import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { layerMaskCoverage, validateLayerMaskDensity } from '../server/layer-mask.mjs';
import { normalizeMask, maskCoverage, bitmapMask, transformMask } from '../server/masks.mjs';
import { canvasTransform, resizeCanvasMask } from '../server/canvas.mjs';

const coded = code => cause => cause.code === code;
const edit = async (native, doc, command, args = {}) => (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document;
const get = async (native, doc) => (await native.execute('get_document', { documentId: doc.id })).document;
const render = (native, doc) => native.render(native.project(doc.id));
const graph = (native, doc) => { const p = native.project(doc.id); return structuredClone(p.states[p.cursor].graph); };
const png = (pixels, width, height) => sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
const layer = (doc, id) => doc.layers.find(x => x.id === id);
const rectangle = { shape: 'rectangle', x: 0, y: 0, width: 2, height: 2, feather: 0, invert: false };
const patterned = (width, height) => Buffer.from(Array.from({ length: width * height }, (_, i) => [20 + i, 110 + i, 210 - i, [255, 128, 1, 0][i % 4]]).flat());
async function fixture(t, { width = 4, height = 2, layers, segmentSubject } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-mask-density-'));
  const native = await new NativeBackend({ dataDir, segmentSubject }).init(); t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const pixels = patterned(width, height), original = await png(pixels, width, height);
  let document = (await native.execute('import_image', { data: original.toString('base64'), mimeType: 'image/png' })).document;
  if (layers) {
    const current = graph(native, document); current.layers = [];
    for (const input of layers) {
      const { pixels: rgba, ...metadata } = input, asset = await native.storeAsset(await png(rgba, width, height));
      current.layers.push({ id: randomUUID(), name: 'Mask fixture', type: 'raster', visible: true, opacity: 1, blendMode: 'normal', width, height, transforms: [], asset, sourceAsset: asset, sourceFormat: 'png', ...metadata });
    }
    await native.commit(native.project(document.id), current, 'Fixture layers'); document = await get(native, document);
  }
  return { native, document, dataDir, pixels, original };
}
async function preview(native, doc, layerId, view = 'layer') {
  const result = await native.execute('get_layer_preview', { documentId: doc.id, layerId, view });
  return { ...result, pixels: await sharp(Buffer.from(result.data, 'base64')).ensureAlpha().raw().toBuffer() };
}

test('density wraps raw feather/invert/clip once, with exact defaults and zero disabling the whole additional mask', () => {
  const masks = [rectangle, { ...rectangle, feather: 1.7, invert: true, clip: { x: 1, y: 0, width: 1, height: 1 } }, bitmapMask(Uint8Array.from([0, 1, 128, 255, 255, 128, 1, 0]), 4, 2)];
  for (const mask of masks) {
    const raw = maskCoverage(mask);
    for (const density of [0, 0.125, 0.5, 128 / 255, 1]) for (let y = 0; y < 2; y++) for (let x = 0; x < 4; x++) {
      const actual = layerMaskCoverage({ mask, maskDensity: density })(x, y);
      assert.equal(actual, density === 1 ? raw(x, y) : density === 0 ? 1 : 1 - density * (1 - raw(x, y)));
    }
    for (let x = 0; x < 4; x++) assert.equal(layerMaskCoverage({ mask })(x, 0), raw(x, 0));
  }
  assert.equal(layerMaskCoverage({})(10, 10), 1);
  assert.throws(() => layerMaskCoverage({ mask: null, maskDensity: 0 }), coded('NO_MASK'));
  for (const density of [-1, 1.1, NaN, Infinity, '0.5']) assert.throws(() => validateLayerMaskDensity({ mask: rectangle, maskDensity: density }), coded('INVALID_ARGUMENT'));
});

test('misplaced density never enters raw masks, active/saved selections or internal clip metadata', async t => {
  const { native, document } = await fixture(t);
  for (const key of ['density', 'maskDensity']) {
    const invalid = { ...rectangle, [key]: 0.5 };
    assert.throws(() => normalizeMask(invalid, 4, 2), coded('INVALID_ARGUMENT'));
    assert.throws(() => maskCoverage(invalid), coded('INVALID_ARGUMENT'));
    assert.throws(() => transformMask(invalid, { type: 'resize', width: 4, height: 2 }, 4, 2), coded('INVALID_ARGUMENT'));
    await assert.rejects(edit(native, document, 'set_layer_mask', { layerId: document.layers[0].id, mask: invalid }), coded('INVALID_ARGUMENT'));
    for (const target of ['selection', 'saved', 'layer']) {
      const candidate = graph(native, document);
      if (target === 'selection') candidate.selection = invalid;
      else if (target === 'saved') candidate.savedSelections = [{ id: randomUUID(), name: 'Invalid', mask: invalid }];
      else candidate.layers[0].mask = invalid;
      assert.throws(() => native.validateGraph(candidate), coded('INVALID_ARGUMENT'));
    }
    assert.throws(() => normalizeMask({ ...rectangle, clip: { x: 0, y: 0, width: 2, height: 2, [key]: 0.5 } }, 4, 2, { persisted: true }), coded('INVALID_ARGUMENT'));
  }
  assert.deepEqual(await get(native, document), document);
});

test('density-only edits write no assets, preserve originals and undo, and zero equals removing only the additional mask', async t => {
  const { native, document: start, original } = await fixture(t); const id = start.layers[0].id;
  let doc = await edit(native, start, 'set_layer_mask', { layerId: id, mask: rectangle }); const rawMask = structuredClone(doc.layers[0].mask), baseline = await render(native, doc);
  const storeAsset = native.storeAsset; native.storeAsset = async () => { throw new Error('Density cannot write source assets'); };
  doc = await edit(native, doc, 'modify_layer_mask', { layerId: id }); assert.deepEqual(await render(native, doc), baseline, 'empty refinement remains accepted');
  doc = await edit(native, doc, 'modify_layer_mask', { layerId: id, density: 0.5 }); assert.deepEqual(doc.layers[0].mask, rawMask);
  const soft = await render(native, doc); assert.notDeepEqual(soft, baseline);
  doc = await edit(native, doc, 'modify_layer_mask', { layerId: id, density: 0 }); const disabled = await render(native, doc);
  doc = await edit(native, doc, 'set_layer_mask', { layerId: id, mask: null }); assert.deepEqual(await render(native, doc), disabled); assert.equal(doc.layers[0].maskDensity, undefined);
  doc = await edit(native, doc, 'undo'); assert.equal(doc.layers[0].maskDensity, 0);
  doc = await edit(native, doc, 'undo'); assert.deepEqual(await render(native, doc), soft);
  doc = await edit(native, doc, 'modify_layer_mask', { layerId: id, density: 1 }); assert.equal(doc.layers[0].maskDensity, undefined); assert.deepEqual(await render(native, doc), baseline);
  native.storeAsset = storeAsset; assert.deepEqual(await fs.readFile(path.join(native.assetsDir, doc.layers[0].sourceAsset)), original);
});

test('all canvas anchors transform raw masks once and density reveals outside old support without changing selections', () => {
  const masks = [{ ...rectangle, invert: true, feather: 1.5 }, { ...bitmapMask(Uint8Array.from([255, 0, 128, 0, 1, 255, 0, 0]), 4, 2), invert: true }];
  for (const anchor of ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right']) {
    const transform = canvasTransform(4, 2, 7, 5, anchor);
    for (const mask of masks) {
      const resized = resizeCanvasMask(mask, 4, 2, transform), raw = maskCoverage(resized), effective = layerMaskCoverage({ mask: resized, maskDensity: 0.5 });
      for (let y = 0; y < 5; y++) for (let x = 0; x < 7; x++) {
        assert.equal(effective(x, y), 0.5 + 0.5 * raw(x, y));
        if (x < transform.x || y < transform.y || x >= transform.x + 4 || y >= transform.y + 2) assert.equal(effective(x, y), 0.5);
        assert.equal(layerMaskCoverage({ mask: resized, maskDensity: 0 })(x, y), 1);
      }
    }
  }
});

test('paint and morphology retain density including brush replace; explicit replacements/removal reset it', async t => {
  const { native, document: start } = await fixture(t); const id = start.layers[0].id;
  let doc = await edit(native, start, 'set_layer_mask', { layerId: id, mask: rectangle });
  doc = await edit(native, doc, 'modify_layer_mask', { layerId: id, density: 0.25, invert: true });
  const raw = structuredClone(doc.layers[0].mask);
  for (const mode of ['add', 'subtract', 'replace']) {
    doc = await edit(native, doc, 'paint_mask', { layerId: id, points: [{ x: 2, y: 1 }], size: 1, hardness: 1, opacity: 1, mode });
    assert.equal(doc.layers[0].maskDensity, 0.25);
  }
  doc = await edit(native, doc, 'morph_layer_mask', { layerId: id, operation: 'expand', radius: 1 }); assert.equal(doc.layers[0].maskDensity, 0.25);
  doc = await edit(native, doc, 'select_rectangle', { x: 0, y: 0, width: 1, height: 2 });
  doc = await edit(native, doc, 'save_selection', { name: 'Raw selection' }); const saved = structuredClone(doc.savedSelections);
  doc = await edit(native, doc, 'mask_from_selection', { layerId: id }); assert.equal(doc.layers[0].maskDensity, undefined);
  doc = await edit(native, doc, 'modify_layer_mask', { layerId: id, density: 0.5 });
  doc = await edit(native, doc, 'set_layer_mask', { layerId: id, mask: raw }); assert.equal(doc.layers[0].maskDensity, undefined);
  assert.deepEqual(doc.savedSelections, saved);
  doc = await edit(native, doc, 'add_adjustment', { kind: 'invert', value: 100 }); const adjustment = doc.layers.at(-1).id;
  doc = await edit(native, doc, 'modify_layer_mask', { layerId: adjustment, density: 0.5 });
  doc = await edit(native, doc, 'update_adjustment', { layerId: adjustment, mask: rectangle }); assert.equal(layer(doc, adjustment).maskDensity, undefined);
  doc = await edit(native, doc, 'modify_layer_mask', { layerId: adjustment, density: 0.5 });
  doc = await edit(native, doc, 'update_adjustment', { layerId: adjustment, mask: null }); assert.equal(layer(doc, adjustment).maskDensity, undefined);
});

test('density survives source edits, rasterization, duplication and document geometry without baking into raw masks', async t => {
  const { native, document: start, dataDir } = await fixture(t); let doc = await edit(native, start, 'add_shape', { shape: 'rectangle', x: 0, y: 0, width: 4, height: 2, fill: '#44aacc' }); const id = doc.layers.at(-1).id;
  doc = await edit(native, doc, 'set_layer_mask', { layerId: id, mask: rectangle });
  doc = await edit(native, doc, 'modify_layer_mask', { layerId: id, density: 0.3 }); const before = await render(native, doc);
  doc = await edit(native, doc, 'rasterize_layer', { layerId: id }); assert.equal(layer(doc, id).maskDensity, 0.3); assert.deepEqual(await render(native, doc), before);
  doc = await edit(native, doc, 'fill_area', { layerId: id, color: '#aa2244' }); assert.equal(layer(doc, id).maskDensity, 0.3);
  doc = await edit(native, doc, 'duplicate_layer', { layerId: id }); const copy = doc.layers.at(-1).id;
  doc = await edit(native, doc, 'modify_layer_mask', { layerId: copy, density: 0.8 }); assert.equal(layer(doc, id).maskDensity, 0.3);
  for (const [command, args] of [['resize_canvas', { width: 7, height: 5, anchor: 'bottom-right' }], ['crop_document', { x: 1, y: 1, width: 5, height: 3 }], ['resize_document', { width: 10, height: 6 }]]) {
    doc = await edit(native, doc, command, args); assert.equal(layer(doc, id).maskDensity, 0.3); assert.equal(layer(doc, copy).maskDensity, 0.8);
  }
  const pixels = await render(native, doc), bundle = await native.exportProject({ documentId: doc.id, expectedRevision: doc.revision }), imported = (await native.importProject({ data: bundle.data })).document;
  assert.deepEqual(await render(native, imported), pixels); assert.equal(layer(imported, id).maskDensity, 0.3);
  const reopened = await new NativeBackend({ dataDir }).init(); assert.deepEqual(await render(reopened, doc), pixels);
});

test('content, adjustment and isolated/pass-through group masks apply density at their own stages', async t => {
  const pixels = Buffer.from([80, 120, 160, 128, 80, 120, 160, 128, 80, 120, 160, 128, 80, 120, 160, 128]);
  for (const mode of ['pass-through', 'isolated']) {
    const { native, document: start } = await fixture(t, { height: 1, layers: [{ pixels }] }); const id = start.layers[0].id;
    let doc = await edit(native, start, 'set_layer_mask', { layerId: id, mask: { x: 0, y: 0, width: 1, height: 1 } });
    doc = await edit(native, doc, 'modify_layer_mask', { layerId: id, density: 0.5 });
    doc = await edit(native, doc, 'group_layers', { layerIds: [id] }); const group = doc.layers[0].id;
    doc = await edit(native, doc, 'set_group_compositing', { layerId: group, mode });
    doc = await edit(native, doc, 'set_layer_mask', { layerId: group, mask: { x: 0, y: 0, width: 2, height: 1 } });
    doc = await edit(native, doc, 'modify_layer_mask', { layerId: group, density: 0.5 });
    assert.deepEqual([...await render(native, doc)], [80, 120, 160, 128, 80, 120, 160, 64, 80, 120, 160, 32, 80, 120, 160, 32]);
    doc = await edit(native, doc, 'add_adjustment', { kind: 'invert', value: 100, mask: { x: 0, y: 0, width: 1, height: 1 } }); const adjustment = doc.layers.at(-1).id;
    doc = await edit(native, doc, 'modify_layer_mask', { layerId: adjustment, density: 0.5 });
    const out = await render(native, doc); assert.deepEqual([...out.subarray(0, 4)], [175, 135, 95, 128]); assert.deepEqual([...out.subarray(4, 8)], [128, 128, 128, 64]);
  }
});

test('protected density expands current AI footprints but never source alpha; density cannot soften generated hard protection', async t => {
  const source = Buffer.from([200, 60, 20, 255, 200, 60, 20, 128, 200, 60, 20, 0, 200, 60, 20, 255]);
  const { native, document: start } = await fixture(t, { height: 1, layers: [{ pixels: source, protected: true }] }); const id = start.layers[0].id;
  let doc = await edit(native, start, 'set_layer_mask', { layerId: id, mask: { x: 0, y: 0, width: 1, height: 1 } });
  let capture = await native.snapshotForGeneration({ documentId: doc.id, expectedRevision: doc.revision, scope: 'canvas' });
  let alpha = await sharp(capture.mask).ensureAlpha().raw().toBuffer(); assert.deepEqual([alpha[3], alpha[7], alpha[11], alpha[15]], [255, 0, 0, 0]);
  doc = await edit(native, doc, 'modify_layer_mask', { layerId: id, density: 0 });
  capture = await native.snapshotForGeneration({ documentId: doc.id, expectedRevision: doc.revision, scope: 'canvas' });
  alpha = await sharp(capture.mask).ensureAlpha().raw().toBuffer(); assert.deepEqual([alpha[3], alpha[7], alpha[11], alpha[15]], [255, 255, 0, 255]);
  const baseline = await render(native, doc), generated = await png(Buffer.from(Array(4).fill([0, 255, 0, 255]).flat()), 4, 1);
  doc = (await native.installGeneratedImage({ data: generated, documentId: doc.id, expectedRevision: doc.revision, provenance: { jobId: randomUUID(), mode: 'generate' } })).document;
  const generatedId = doc.layers.at(-1).id;
  doc = await edit(native, doc, 'set_layer_mask', { layerId: generatedId, mask: { x: 0, y: 0, width: 1, height: 1 } });
  doc = await edit(native, doc, 'modify_layer_mask', { layerId: generatedId, density: 0 }); const after = await render(native, doc);
  for (const p of [0, 1, 3]) assert.deepEqual(after.subarray(p * 4, p * 4 + 4), baseline.subarray(p * 4, p * 4 + 4));
  assert.equal(after[11], 255); assert.equal((await preview(native, doc, id, 'source')).pixels[11], 0);
});

test('isolated generated and styled previews honor original lower protection without clipping ordinary source RGB', async t => {
  const lower = Buffer.from([0, 0, 0, 0, 80, 90, 100, 255, 80, 90, 100, 255, 0, 0, 0, 0]);
  const upper = Buffer.from([0, 0, 0, 0, 20, 200, 40, 255, 0, 0, 0, 0, 20, 200, 40, 255]);
  const { native, document: start } = await fixture(t, { height: 1, layers: [{ pixels: lower, protected: true }, { pixels: upper, role: 'generated', provenance: { jobId: randomUUID() }, effects: { shadow: { color: '#ff0000', opacity: 1, blur: 0, x: 1, y: 0 } } }] });
  const id = start.layers[1].id; let doc = await edit(native, start, 'set_layer_mask', { layerId: id, mask: { x: 3, y: 0, width: 1, height: 1 } });
  doc = await edit(native, doc, 'modify_layer_mask', { layerId: id, density: 0 }); let view = await preview(native, doc, id);
  assert.equal(view.pixels[7], 0); assert.equal(view.pixels[11], 0, 'clipped generated source casts no ghost shadow'); assert.equal(view.pixels[15], 255);
  const changed = graph(native, doc); delete changed.layers[1].role; delete changed.layers[1].provenance;
  await native.commit(native.project(doc.id), changed, 'Fixture ordinary source'); doc = await get(native, doc); view = await preview(native, doc, id);
  assert.deepEqual([...view.pixels.subarray(4, 8)], [20, 200, 40, 255], 'ordinary RGB remains independently inspectable'); assert.equal(view.pixels[11], 0, 'ordinary outside shadow still excludes original protected pixels');
});

test('PSD samples effective density exactly and refuses fractional alpha8 masks without mutating native data', async t => {
  const { native, document: start } = await fixture(t); let doc = await edit(native, start, 'set_layer', { layerId: start.layers[0].id, visible: false });
  doc = await edit(native, doc, 'add_shape', { shape: 'rectangle', x: 0, y: 0, width: 4, height: 2, fill: '#ffffff' }); const backdrop = doc.layers.at(-1).id;
  doc = await edit(native, doc, 'rasterize_layer', { layerId: backdrop });
  doc = await edit(native, doc, 'duplicate_layer', { layerId: backdrop }); const id = doc.layers.at(-1).id;
  doc = await edit(native, doc, 'set_layer_mask', { layerId: id, mask: rectangle });
  doc = await edit(native, doc, 'modify_layer_mask', { layerId: id, density: 0.5 });
  let report = await native.inspectPsdExport({ documentId: doc.id }); assert.ok(report.issues.some(issue => issue.code === 'MASK_NOT_REPRESENTABLE'));
  await assert.rejects(native.exportPsd({ documentId: doc.id }), coded('PSD_UNSUPPORTED'));
  doc = await edit(native, doc, 'modify_layer_mask', { layerId: id, density: 128 / 255 });
  report = await native.inspectPsdExport({ documentId: doc.id }); assert.ok(report.supported, JSON.stringify(report.issues));
  const file = await fs.readFile(path.join(native.projectsDir, `${doc.id}.json`)); await native.exportPsd({ documentId: doc.id });
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await fs.readFile(path.join(native.projectsDir, `${doc.id}.json`)), file);
});

test('invalid density, orphan fields, transactions, stale revisions and persist errors leave published state unchanged', async t => {
  const { native, document: start } = await fixture(t), id = start.layers[0].id;
  await assert.rejects(edit(native, start, 'modify_layer_mask', { layerId: id, density: 0 }), coded('NO_MASK'));
  let doc = await edit(native, start, 'set_layer_mask', { layerId: id, mask: rectangle });
  const before = await native.execute('get_preview', { documentId: doc.id }), file = await fs.readFile(path.join(native.projectsDir, `${doc.id}.json`));
  for (const density of [-1, 1.01, NaN, Infinity]) await assert.rejects(edit(native, doc, 'modify_layer_mask', { layerId: id, density }), coded('INVALID_ARGUMENT'));
  const candidate = graph(native, doc); candidate.layers[0].mask = null; candidate.layers[0].maskDensity = 1; assert.throws(() => native.validateGraph(candidate), coded('NO_MASK'));
  await assert.rejects(edit(native, doc, 'modify_layer_mask', { expectedRevision: start.revision, layerId: id, density: 0.5 }), coded('REVISION_CONFLICT'));
  await assert.rejects(edit(native, doc, 'apply_transaction', { operations: [{ command: 'modify_layer_mask', args: { layerId: id, density: 0.2 } }, { command: 'modify_layer_mask', args: { layerId: id, density: 2 } }] }), coded('INVALID_ARGUMENT'));
  const persist = native.persist; native.persist = async () => { throw Object.assign(new Error('Injected full disk'), { code: 'ENOSPC' }); };
  await assert.rejects(edit(native, doc, 'modify_layer_mask', { layerId: id, density: 0.5 }), coded('ENOSPC')); native.persist = persist;
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await fs.readFile(path.join(native.projectsDir, `${doc.id}.json`)), file); assert.deepEqual(await native.execute('get_preview', { documentId: doc.id }), before);
});
