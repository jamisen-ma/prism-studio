import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { layerMaskCoverage } from '../server/layer-mask.mjs';

const edit = async (native, doc, command, args = {}) => (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document;
const current = async (native, doc) => (await native.execute('get_document', { documentId: doc.id })).document;
const files = async directory => Object.fromEntries(await Promise.all((await fs.readdir(directory)).sort().map(async name => [name, await fs.readFile(path.join(directory, name))])));
const pixel = (bytes, index) => [...bytes.subarray(index * 4, index * 4 + 4)];
const decode = async result => sharp(Buffer.from(result.data, 'base64')).ensureAlpha().raw().toBuffer();
const common = extra => ({ id: randomUUID(), name: 'Density audit', visible: true, opacity: 1, blendMode: 'normal', ...extra });
const bitmap = (values, width, height) => ({ shape: 'bitmap', x: 0, y: 0, width, height, feather: 0, invert: false, runs: values.flatMap((alpha, index) => alpha ? [index, 1, alpha] : []) });
const solid = (width, height, extra = {}) => common({ type: 'solid', color: '#3567a9', width, height, transforms: [], ...extra });
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-density-audit-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return { dataDir, native: await new NativeBackend({ dataDir }).init() };
}
async function raster(native, bytes, width, height, extra = {}) {
  const png = await sharp(bytes, { raw: { width, height, channels: 4 } }).png().toBuffer(), asset = await native.storeAsset(png);
  return common({ type: 'raster', asset, sourceAsset: asset, sourceFormat: 'png', width, height, transforms: [], ...extra });
}
async function project(native, width, height, layers, extra = {}) {
  return (await native.newProject({ name: 'Independent mask density fixture', width, height, selection: null, layers, ...extra }, 'Audit fixture')).document;
}
// Independent rectangle/ellipse/bitmap reference. Bitmap fixtures are not
// feathered; geometric fixtures independently calculate the inward feather.
function rawCoverage(mask, x, y) {
  if (!mask) return 1;
  const px = x + 0.5, py = y + 0.5;
  let amount = 0;
  if (mask.shape === 'bitmap') {
    const index = y * mask.width + x;
    for (let i = 0; i < mask.runs.length; i += 3) if (index >= mask.runs[i] && index < mask.runs[i] + mask.runs[i + 1]) amount = mask.runs[i + 2] / 255;
  } else if (px > mask.x && py > mask.y && px < mask.x + mask.width && py < mask.y + mask.height) {
    const distance = mask.shape === 'ellipse'
      ? (1 - Math.hypot((px - mask.x - mask.width / 2) / (mask.width / 2), (py - mask.y - mask.height / 2) / (mask.height / 2))) * Math.min(mask.width, mask.height) / 2
      : Math.min(px - mask.x, py - mask.y, mask.x + mask.width - px, mask.y + mask.height - py);
    amount = distance <= 0 ? 0 : mask.feather ? Math.min(1, distance / mask.feather) : 1;
  }
  if (mask.invert) amount = 1 - amount;
  if (mask.clip && !(px >= mask.clip.x && py >= mask.clip.y && px < mask.clip.x + mask.clip.width && py < mask.clip.y + mask.clip.height)) amount = 0;
  return amount;
}
const densityCoverage = (layer, x, y) => !layer.mask || layer.maskDensity === 0 ? 1 : (layer.maskDensity ?? 1) === 1 ? rawCoverage(layer.mask, x, y) : 1 - layer.maskDensity * (1 - rawCoverage(layer.mask, x, y));
function over(back, front, amount, mode = 'normal') {
  const a = front[3] / 255 * amount, b = back[3] / 255;
  if (!a) return [...back];
  const alpha = a + b * (1 - a);
  return [...[0, 1, 2].map(c => {
    const d = back[c] / 255, s = front[c] / 255, blend = mode === 'multiply' ? d * s : mode === 'screen' ? 1 - (1 - d) * (1 - s) : s;
    return Math.round(255 * ((1 - a) * b * d + (1 - b) * a * s + a * b * blend) / alpha);
  }), Math.round(alpha * 255)];
}
function mix(before, after, amount) {
  if (amount === 1) return [...after];
  if (amount === 0) return [...before];
  const a = before[3] / 255, b = after[3] / 255, alpha = a + (b - a) * amount;
  return [...[0, 1, 2].map(c => alpha ? Math.round((before[c] * a * (1 - amount) + after[c] * b * amount) / alpha) : before[c]), Math.round(alpha * 255)];
}

test('layer density follows feather, inversion and clip; exact endpoints preserve legacy coverage and raw masks', async t => {
  const { native } = await fixture(t), width = 7, height = 5;
  const descriptors = [
    bitmap(Array.from({ length: width * height }, (_, i) => [0, 1, 128, 255][i % 4]), width, height),
    { shape: 'rectangle', x: 0.2, y: 0.3, width: 5.4, height: 4.2, feather: 1.3, invert: false },
    { shape: 'ellipse', x: 0.2, y: 0.3, width: 5.4, height: 4.2, feather: 1.3, invert: true, clip: { x: 1, y: 1, width: 4, height: 3 } },
  ];
  const source = Buffer.from(Array.from({ length: width * height }, (_, i) => [17 + i, 91, 219 - i, 255]).flat());
  for (const mask of descriptors) for (const density of [0, 0.25, 0.5, 0.9, 1]) {
    const layer = { mask, maskDensity: density, kind: 'invert', value: 100, opacity: 0.7 }, before = structuredClone(layer);
    const effective = layerMaskCoverage(layer);
    const changed = await native.applyAdjustment(source, width, height, layer);
    for (let i = 0; i < width * height; i++) {
      // Algebraically equivalent continuous coverage can differ by a few ULPs
      // after the byte-unit density half-tie correction. Keep materialized
      // pixel assertions exact below; all256 byte ties have a rational oracle
      // in mask-preview-audit.test.mjs.
      assert.ok(Math.abs(effective(i % width, Math.floor(i / width)) - densityCoverage(layer, i % width, Math.floor(i / width))) <= 4 * Number.EPSILON);
      const amount = 0.7 * densityCoverage(layer, i % width, Math.floor(i / width));
      assert.deepEqual(pixel(changed, i), [...pixel(source, i).slice(0, 3).map(value => Math.round(value + (255 - 2 * value) * amount)), 255]);
    }
    if (density === 1) assert.deepEqual(changed, await native.applyAdjustment(source, width, height, { ...layer, maskDensity: undefined }));
    if (density === 0) assert.deepEqual(changed, await native.applyAdjustment(source, width, height, { ...layer, mask: null, maskDensity: undefined }));
    assert.deepEqual(layer, before);
  }
  assert.equal(densityCoverage({ mask: descriptors[2], maskDensity: 0.5 }, 0, 0), 0.5, 'old clip is inside density, not an absolute outer exclusion');
});

test('raw brush replacement and morphology preserve density while complete mask replacement resets it', async t => {
  const { native, dataDir } = await fixture(t), width = 12, height = 10;
  const initial = solid(width, height, { mask: { shape: 'ellipse', x: 2, y: 1, width: 7, height: 7, feather: 1.5, invert: true }, maskDensity: 0.3 });
  let doc = await project(native, width, height, [initial]);
  doc = await edit(native, doc, 'select_region', { shape: 'rectangle', x: 2, y: 2, width: 5, height: 5 });
  doc = await edit(native, doc, 'save_selection', { name: 'Raw selection stays raw' });
  const saved = structuredClone(doc.savedSelections), selection = structuredClone(doc.selection), assets = await files(native.assetsDir);
  for (const [command, args] of [
    ['paint_mask', { mode: 'replace', points: [{ x: 6, y: 5 }], size: 5, hardness: 0.4, opacity: 0.6 }],
    ['paint_mask', { mode: 'subtract', points: [{ x: 4, y: 4 }], size: 3, hardness: 1, opacity: 0.3 }],
    ['morph_layer_mask', { operation: 'expand', radius: 1 }],
    ['morph_layer_mask', { operation: 'border', radius: 1 }],
  ]) {
    const raw = structuredClone(doc.layers[0]); delete raw.maskDensity;
    let control = await project(native, width, height, [raw]);
    control = await edit(native, control, command, { layerId: initial.id, ...args });
    doc = await edit(native, doc, command, { layerId: initial.id, ...args });
    assert.equal(doc.layers[0].maskDensity, 0.3); assert.deepEqual(doc.layers[0].mask, control.layers[0].mask);
    assert.deepEqual(doc.selection, selection); assert.deepEqual(doc.savedSelections, saved);
  }
  doc = await edit(native, doc, 'modify_layer_mask', { layerId: initial.id, feather: 2, invert: true }); assert.equal(doc.layers[0].maskDensity, 0.3);
  doc = await edit(native, doc, 'modify_layer_mask', { layerId: initial.id }); assert.equal(doc.layers[0].maskDensity, 0.3, 'legacy empty refinement remains accepted');
  for (const command of ['set_layer_mask', 'mask_from_selection']) {
    doc = await edit(native, doc, command, { layerId: initial.id, ...(command === 'set_layer_mask' ? { mask: { x: 0, y: 0, width: 8, height: 8 } } : {}) });
    assert.equal(doc.layers[0].maskDensity, undefined);
    doc = await edit(native, doc, 'modify_layer_mask', { layerId: initial.id, density: 0.3 });
  }
  doc = await edit(native, doc, 'set_layer_mask', { layerId: initial.id, mask: null }); assert.equal(doc.layers[0].maskDensity, undefined);
  await assert.rejects(edit(native, doc, 'modify_layer_mask', { layerId: initial.id, density: 0 }), { code: 'NO_MASK' });
  doc = await edit(native, doc, 'add_adjustment', { kind: 'brightness', value: 10 }); const adjustment = doc.layers.at(-1).id;
  doc = await edit(native, doc, 'modify_layer_mask', { layerId: adjustment, density: 0.2 });
  doc = await edit(native, doc, 'update_adjustment', { layerId: adjustment, value: 20 }); assert.equal(doc.layers.at(-1).maskDensity, 0.2);
  doc = await edit(native, doc, 'update_adjustment', { layerId: adjustment, mask: { x: 0, y: 0, width: 4, height: 4 } }); assert.equal(doc.layers.at(-1).maskDensity, undefined);
  doc = await edit(native, doc, 'modify_layer_mask', { layerId: adjustment, density: 0 });
  doc = await edit(native, doc, 'update_adjustment', { layerId: adjustment, mask: null }); assert.equal(doc.layers.at(-1).maskDensity, undefined);
  assert.deepEqual(await files(native.assetsDir), assets);
  const reopened = await new NativeBackend({ dataDir }).init(); assert.deepEqual(await current(reopened, doc), doc);
});

test('source alpha, originals and authored masks survive density, clone, rasterize, extract, place and source edits', async t => {
  const { native } = await fixture(t), width = 6, height = 4, count = width * height;
  const bytes = Buffer.from(Array.from({ length: count }, (_, i) => [i * 7, 80, 211 - i, [0, 1, 128, 255][i % 4]]).flat());
  const source = await raster(native, bytes, width, height, { mask: bitmap(Array.from({ length: count }, (_, i) => i % 3 ? 255 : 0), width, height), maskDensity: 0.5 });
  let doc = await project(native, width, height, [source]), assets = await files(native.assetsDir);
  const rawMask = structuredClone(source.mask), rawPreview = await native.execute('get_layer_preview', { documentId: doc.id, layerId: source.id, view: 'source' });
  doc = await edit(native, doc, 'modify_layer_mask', { layerId: source.id, density: 0 });
  assert.deepEqual(doc.layers[0].mask, rawMask); assert.deepEqual(await files(native.assetsDir), assets);
  const disabled = await native.renderGraph(doc);
  doc = await edit(native, doc, 'undo'); assert.equal(doc.layers[0].maskDensity, 0.5); assert.deepEqual(doc.layers[0].mask, rawMask);
  doc = await edit(native, doc, 'redo'); assert.equal(doc.layers[0].maskDensity, 0); assert.deepEqual(await native.renderGraph(doc), disabled);
  assert.deepEqual(await decode(await native.execute('get_layer_preview', { documentId: doc.id, layerId: source.id, view: 'source' })), await decode(rawPreview));
  native.segmentSubject = async () => ({ alpha: Buffer.from(Array.from({ length: count }, (_, i) => [255, 128, 1, 0][i % 4])), width, height, model: 'density-fixture' });
  doc = await edit(native, doc, 'extract_subject', { layerId: source.id, protect: false }); const extracted = doc.layers[1].id;
  assert.equal(doc.layers[1].maskDensity, 0); assert.deepEqual(doc.layers[1].mask, rawMask);
  const alphaAsset = doc.layers[1].alphaAsset, alphaFile = await fs.readFile(path.join(native.assetsDir, alphaAsset));
  const rawAlpha = await decode(await native.execute('get_layer_preview', { documentId: doc.id, layerId: extracted, view: 'mask' }));
  doc = await edit(native, doc, 'modify_layer_mask', { layerId: extracted, density: 0.5 });
  assert.equal(doc.layers[1].alphaAsset, alphaAsset); assert.deepEqual(await fs.readFile(path.join(native.assetsDir, alphaAsset)), alphaFile);
  assert.deepEqual(await decode(await native.execute('get_layer_preview', { documentId: doc.id, layerId: extracted, view: 'mask' })), rawAlpha);
  doc = await edit(native, doc, 'duplicate_layer', { layerId: extracted }); const duplicate = doc.layers[2].id;
  doc = await edit(native, doc, 'modify_layer_mask', { layerId: duplicate, density: 0.8 }); assert.equal(doc.layers[1].maskDensity, 0.5);
  const placedSource = doc.layers[1], effectiveSource = await native.visibleLayerPixels(doc, placedSource, { outline: false, effects: false });
  doc = await edit(native, doc, 'place_layer', { sourceDocumentId: doc.id, sourceLayerId: extracted, sourceExpectedRevision: doc.revision, x: 0, y: 0, width, height, protect: false });
  const placed = doc.layers.at(-1); assert.equal(placed.mask, undefined); assert.equal(placed.maskDensity, undefined);
  assert.deepEqual(await native.renderLayer(placed), effectiveSource, 'full-size placement bakes effective own density once into source alpha');
  let selectedInput;
  native.segmentSubject = async data => { selectedInput = await sharp(data).ensureAlpha().raw().toBuffer(); return { alpha: Buffer.alloc(count, 255), width, height, model: 'density-selection-fixture' }; };
  doc = await edit(native, doc, 'select_subject', { layerId: extracted });
  assert.deepEqual(selectedInput, effectiveSource, 'source-oriented subject selection includes the additional layer density');
  doc = await edit(native, doc, 'fill_area', { layerId: duplicate, color: '#123456', opacity: 0.5 });
  assert.equal(doc.layers.find(layer => layer.id === duplicate).maskDensity, 0.8); assert.deepEqual(doc.layers.find(layer => layer.id === duplicate).mask, rawMask);
  doc = await edit(native, doc, 'paint_stroke', { layerId: duplicate, tool: 'pencil', color: '#ff8844', points: [{ x: 2, y: 2 }], size: 1, hardness: 1, opacity: 1 });
  assert.equal(doc.layers.find(layer => layer.id === duplicate).maskDensity, 0.8); assert.deepEqual(doc.layers.find(layer => layer.id === duplicate).mask, rawMask);
  for (const [asset, original] of Object.entries(assets)) assert.deepEqual(await fs.readFile(path.join(native.assetsDir, asset)), original);
  const vector = solid(width, height, { mask: rawMask, maskDensity: 0.37 }); let vectorDoc = await project(native, width, height, [vector]);
  const before = await native.renderGraph(vectorDoc);
  vectorDoc = await edit(native, vectorDoc, 'rasterize_layer', { layerId: vector.id });
  assert.equal(vectorDoc.layers[0].maskDensity, 0.37); assert.deepEqual(vectorDoc.layers[0].mask, rawMask); assert.deepEqual(await native.renderGraph(vectorDoc), before);
  const portable = await native.exportProject({ documentId: vectorDoc.id }); const imported = await native.importProject({ data: portable.data });
  assert.equal(imported.document.layers[0].maskDensity, 0.37); assert.deepEqual(await native.renderGraph(imported.document), before);
});

test('nested groups and clipping chains apply own and ancestor density once with independent premultiplied arithmetic', async t => {
  const { native } = await fixture(t), width = 4, height = 2, count = width * height;
  const source = Buffer.from(Array.from({ length: count }, (_, i) => [40 + i * 9, 90, 180 - i * 7, [1, 128, 255, 64][i % 4]]).flat());
  const memberPixels = Buffer.from(Array.from({ length: count }, (_, i) => [190, 30 + i, 80, [255, 128, 1, 0][i % 4]]).flat());
  const base = await raster(native, source, width, height), member = await raster(native, memberPixels, width, height);
  for (const mode of ['pass-through', 'isolated']) for (const density of [0, 0.5, 1]) {
    const background = solid(width, height, { color: '#21456a' }), outer = common({ type: 'group', mode, opacity: 0.7, blendMode: mode === 'isolated' ? 'multiply' : 'normal', mask: bitmap([0, 255, 128, 1, 255, 0, 1, 128], width, height), maskDensity: density });
    const inner = common({ type: 'group', mode: 'isolated', parentId: outer.id, opacity: 0.6, mask: bitmap([255, 0, 128, 1, 0, 255, 128, 1], width, height), maskDensity: 0.25 });
    const b = { ...base, parentId: inner.id, opacity: 0.8, mask: bitmap([0, 1, 128, 255, 255, 128, 1, 0], width, height), maskDensity: 0.5 };
    const m = { ...member, parentId: inner.id, clipBaseId: base.id, opacity: 0.5, mask: bitmap([128, 255, 0, 1, 1, 0, 255, 128], width, height), maskDensity: 0.4 };
    const graph = { name: 'Nested density oracle', width, height, layers: [background, outer, inner, b, m] }, actual = await native.renderGraph(graph);
    for (let i = 0; i < count; i++) {
      const x = i % width, y = Math.floor(i / width), interior = pixel(source, i), foreground = pixel(memberPixels, i), amount = foreground[3] / 255 * m.opacity * densityCoverage(m, x, y);
      for (let c = 0; c < 3; c++) interior[c] = Math.round(interior[c] + (foreground[c] - interior[c]) * amount);
      const basePixel = over([0, 0, 0, 0], interior, b.opacity * densityCoverage(b, x, y));
      const innerPixel = over([0, 0, 0, 0], basePixel, inner.opacity * densityCoverage(inner, x, y));
      const back = [33, 69, 106, 255], outerAmount = outer.opacity * densityCoverage(outer, x, y);
      const expected = mode === 'isolated' ? over(back, innerPixel, outerAmount, 'multiply') : mix(back, over(back, innerPixel, 1), outerAmount);
      assert.deepEqual(pixel(actual, i), expected, `${mode}, density ${density}, pixel ${i}`);
    }
  }
});

test('density zero equals removing the mask for outside styles, while generated previews and retained masks keep current protection hard', async t => {
  const { native } = await fixture(t), width = 7, height = 3, count = width * height;
  const sourcePixels = Buffer.alloc(count * 4); for (const [index, alpha] of [[8, 1], [9, 128], [10, 255]]) sourcePixels.set([35, 119, 71, alpha], index * 4);
  const own = await raster(native, sourcePixels, width, height, { mask: { x: 2, y: 1, width: 1, height: 1, feather: 0, invert: false }, maskDensity: 0, outline: { width: 1, color: '#ffffff' }, effects: { shadow: { opacity: 0.5, blur: 0, x: 1, y: 0 } } });
  assert.deepEqual(await native.renderGraph({ name: 'Masked styles', width, height, layers: [own] }), await native.renderGraph({ name: 'Unmasked styles', width, height, layers: [{ ...own, mask: null, maskDensity: undefined }] }));
  const group = common({ type: 'group', mode: 'pass-through', mask: { x: 2, y: 1, width: 1, height: 1 }, maskDensity: 1 });
  const person = { ...own, parentId: group.id, protected: true }; delete person.outline; delete person.effects; person.maskDensity = 1;
  const generatedPixels = Buffer.alloc(count * 4); for (let i = 0; i < count; i++) generatedPixels.set([219, 31, 43, 255], i * 4);
  const generated = await raster(native, generatedPixels, width, height, { role: 'generated', mask: bitmap(Array(count).fill(0), width, height), maskDensity: 0 });
  let doc = await project(native, width, height, [group, person, generated], { selection: { x: 0, y: 0, width, height, feather: 0, invert: false } });
  const captured = await native.snapshotForGeneration({ documentId: doc.id, expectedRevision: doc.revision, scope: 'selection' });
  const oldMask = await sharp(captured.mask).ensureAlpha().raw().toBuffer(); assert.equal(oldMask[9 * 4 + 3], 255); assert.equal(oldMask[8 * 4 + 3], 0);
  doc = await edit(native, doc, 'modify_layer_mask', { layerId: person.id, density: 0.5 });
  assert.deepEqual([...(await native.protectedPixels(doc))].flatMap((value, i) => value ? [i] : []), [9], 'ancestor mask still bounds newly revealed own source');
  doc = await edit(native, doc, 'modify_layer_mask', { layerId: group.id, density: 0 });
  const protectedPixels = await native.protectedPixels(doc); assert.deepEqual([...protectedPixels].flatMap((value, i) => value ? [i] : []), [8, 9, 10]);
  const preview = await decode(await native.execute('get_layer_preview', { documentId: doc.id, layerId: generated.id }));
  for (const index of [8, 9, 10]) assert.equal(preview[index * 4 + 3], 0, 'isolated generated preview retains original protected footprint');
  assert.equal(preview[3], 255);
  const currentSnapshot = await native.snapshotForGeneration({ documentId: doc.id, expectedRevision: doc.revision, scope: 'selection' });
  const currentMask = await sharp(currentSnapshot.mask).ensureAlpha().raw().toBuffer();
  for (const index of [8, 9, 10]) assert.equal(currentMask[index * 4 + 3], 255);
  const png = await sharp(generatedPixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const installed = await native.installGeneratedImage({ data: png, mask: captured.mask, documentId: doc.id, expectedRevision: doc.revision, provenance: { jobId: randomUUID(), mode: 'edit' } });
  const rawInstalled = await native.renderLayer(installed.document.layers.find(layer => layer.id === installed.layerId));
  for (const index of [8, 9, 10]) assert.equal(rawInstalled[index * 4 + 3], 0, 'retained result intersects current enlarged protection');
  assert.deepEqual(installed.document.selection, doc.selection);
});

test('all canvas anchors and subsequent crop/resize retain density beside independently transformed raw descriptors', async t => {
  const { native } = await fixture(t), width = 8, height = 6;
  for (const anchor of ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right']) for (const shape of ['ellipse', 'bitmap']) {
    const mask = shape === 'ellipse' ? { shape, x: 1.2, y: 0.7, width: 5.6, height: 4.5, feather: 1.2, invert: true } : bitmap(Array.from({ length: width * height }, (_, i) => [0, 1, 128, 255][i % 4]), width, height);
    const layer = solid(width, height, { mask, maskDensity: 0.5 }); let doc = await project(native, width, height, [layer]);
    let control = await project(native, width, height, [{ ...layer, maskDensity: undefined }]);
    for (const [command, args] of [['resize_canvas', { width: 12, height: 10, anchor }], ['crop_document', { x: 1, y: 1, width: 10, height: 8 }], ['resize_document', { width: 15, height: 12 }]]) {
      doc = await edit(native, doc, command, args); control = await edit(native, control, command, args);
      assert.equal(doc.layers[0].maskDensity, 0.5); assert.deepEqual(doc.layers[0].mask, control.layers[0].mask);
      const withZero = { ...doc, layers: doc.layers.map(item => ({ ...item, maskDensity: 0 })) }, removed = { ...doc, layers: doc.layers.map(item => ({ ...item, mask: null, maskDensity: undefined })) };
      assert.deepEqual(await native.renderGraph(withZero), await native.renderGraph(removed), `${anchor}/${shape}/${command}: density zero removes the whole additional mask`);
    }
  }
});

// Minimal independent reader for this writer's trusted raw-channel fixtures.
function psdMaskPlanes(data) {
  assert.equal(data.toString('ascii', 0, 4), '8BPS');
  let at = 26; const u16 = () => { const n = data.readUInt16BE(at); at += 2; return n; }, i16 = () => { const n = data.readInt16BE(at); at += 2; return n; }, u32 = () => { const n = data.readUInt32BE(at); at += 4; return n; };
  let length = u32(); at += length; length = u32(); at += length;
  u32(); const infoLength = u32(), end = at + infoLength, count = Math.abs(i16()), records = [];
  for (let i = 0; i < count; i++) {
    at += 16; const channelCount = u16(), channels = [];
    for (let j = 0; j < channelCount; j++) channels.push({ id: i16(), length: u32() });
    at += 12; length = u32(); at += length; records.push(channels);
  }
  const masks = [];
  for (const channels of records) for (const channel of channels) { assert.equal(u16(), 0); const bytes = Buffer.from(data.subarray(at, at + channel.length - 2)); at += channel.length - 2; if (channel.id === -2) masks.push(bytes); }
  assert.ok(at <= end && end - at <= 1); return masks;
}

test('PSD materializes effective exact alpha8 density and rejects fractional or partially gray cases without touching native state', async t => {
  const { native } = await fixture(t), width = 4, height = 2;
  const background = solid(width, height), front = solid(width, height, { color: '#e56f24', mask: bitmap([0, 255, 0, 255, 255, 0, 255, 0], width, height), maskDensity: 128 / 255 });
  let doc = await project(native, width, height, [background, front]); const assets = await files(native.assetsDir);
  const before = await files(native.projectsDir), preview = await native.execute('get_preview', { documentId: doc.id }), cache = native.previewCache.stats();
  const exported = await native.exportPsd({ documentId: doc.id, expectedRevision: doc.revision });
  assert.deepEqual(psdMaskPlanes(exported.data), [Buffer.from([127, 255, 127, 255, 255, 127, 255, 127])]);
  assert.ok(exported.report.warnings.some(item => /density/i.test(item.message)));
  assert.deepEqual(await files(native.projectsDir), before); assert.deepEqual(await files(native.assetsDir), assets); assert.deepEqual(native.previewCache.stats(), cache);
  assert.deepEqual(await native.execute('get_preview', { documentId: doc.id }), preview);
  doc = await edit(native, doc, 'modify_layer_mask', { layerId: front.id, density: 0.5 });
  assert.ok((await native.inspectPsdExport({ documentId: doc.id })).issues.some(item => item.code === 'MASK_NOT_REPRESENTABLE'));
  await assert.rejects(native.exportPsd({ documentId: doc.id }), { code: 'PSD_UNSUPPORTED' });
  doc = await edit(native, doc, 'modify_layer_mask', { layerId: front.id, density: 0 });
  assert.deepEqual(psdMaskPlanes((await native.exportPsd({ documentId: doc.id })).data), [Buffer.alloc(width * height, 255)]);
  const gray = { ...front, mask: bitmap([128, 255, 0, 255, 255, 0, 255, 0], width, height) };
  const grayDoc = await project(native, width, height, [background, gray]);
  assert.ok((await native.inspectPsdExport({ documentId: grayDoc.id })).issues.some(item => item.code === 'MASK_NOT_REPRESENTABLE'));
});

test('density rejection, stale revisions, transaction and real persistence failure preserve published metadata/assets/cache', async t => {
  const { native } = await fixture(t), width = 6, height = 4;
  const layer = solid(width, height, { mask: { x: 1, y: 1, width: 3, height: 2 }, maskDensity: 0.5 });
  const doc = await project(native, width, height, [layer]), preview = await native.execute('get_preview', { documentId: doc.id }), cache = native.previewCache.stats(), projectFiles = await files(native.projectsDir), assets = await files(native.assetsDir);
  for (const density of [-1, 1.01, NaN, Infinity, '0.5', null]) await assert.rejects(edit(native, doc, 'modify_layer_mask', { layerId: layer.id, density }));
  await assert.rejects(edit(native, doc, 'modify_layer_mask', { layerId: layer.id, density: 0.1, expectedRevision: doc.revision - 1 }), { code: 'REVISION_CONFLICT' });
  await assert.rejects(edit(native, doc, 'apply_transaction', { operations: [{ command: 'modify_layer_mask', args: { layerId: layer.id, density: 0 } }, { command: 'modify_layer_mask', args: { layerId: layer.id, density: 2 } }] }));
  const directory = native.projectsDir; native.projectsDir = path.join(directory, `${doc.id}.json`);
  try { await assert.rejects(edit(native, doc, 'modify_layer_mask', { layerId: layer.id, density: 0.25 })); } finally { native.projectsDir = directory; }
  assert.deepEqual(await current(native, doc), doc); assert.deepEqual(await files(native.projectsDir), projectFiles); assert.deepEqual(await files(native.assetsDir), assets); assert.deepEqual(native.previewCache.stats(), cache);
  assert.deepEqual(await native.execute('get_preview', { documentId: doc.id }), preview);
  // A zero-density mask still reserves its group surface before rendering.
  let parentId; const layers = [];
  for (let i = 0; i < 3; i++) { const group = common({ type: 'group', mode: 'pass-through', parentId, mask: { x: 0, y: 0, width: 6000, height: 4000 }, maskDensity: 0 }); layers.push(group); parentId = group.id; }
  layers.push(solid(6000, 4000, { parentId, visible: false }));
  assert.throws(() => native.validateGraph({ name: 'Density zero still accounts masked groups', width: 6000, height: 4000, layers }), { code: 'LIMIT_EXCEEDED' });
});

test('canonical hostile portable masks reject before any image access even when density is zero', async t => {
  const { native } = await fixture(t), { native: target } = await fixture(t), width = 4, height = 3;
  const layer = await raster(native, Buffer.alloc(width * height * 4, 255), width, height, { mask: bitmap(Array(width * height).fill(128), width, height), maskDensity: 0 });
  const doc = await project(native, width, height, [layer], { selection: { x: 0, y: 0, width: 2, height: 2 }, savedSelections: [{ id: randomUUID(), name: 'Raw saved mask', mask: { x: 0, y: 0, width: 2, height: 2 } }] });
  const valid = (await native.exportProject({ documentId: doc.id })).data, length = valid.readUInt32BE(8), manifest = JSON.parse(valid.subarray(12, 12 + length));
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const mutations = [
    graph => { delete graph.layers[0].mask; }, graph => { graph.layers[0].mask = null; graph.layers[0].maskDensity = 1; },
    graph => { graph.layers[0].maskDensity = -0.1; }, graph => { graph.layers[0].maskDensity = '0'; }, graph => { graph.layers[0].maskDensity = null; },
    graph => { graph.layers[0].mask.runs = [0, width * height + 1, 128]; }, graph => { graph.layers[0].mask.width = 1; },
    graph => { graph.layers[0].mask.density = 0.5; }, graph => { graph.layers[0].mask.maskDensity = 0.5; },
    graph => { graph.selection.density = 0; }, graph => { graph.savedSelections[0].mask.maskDensity = 0; },
    graph => { graph.layers[0].mask = { x: 0, y: 0, width, height, clip: { x: 0, y: 0, width, height, density: 0 } }; },
  ];
  let touched = 0; target.validateProjectAsset = target.storeAsset = async () => { touched++; assert.fail('Malformed disabled mask reached image processing'); };
  for (const mutate of mutations) {
    const next = structuredClone(manifest); mutate(next.graph); const body = Buffer.from(JSON.stringify(canonical(next))), prefix = Buffer.from(valid.subarray(0, 12)); prefix.writeUInt32BE(body.length, 8);
    await assert.rejects(target.importProject({ data: Buffer.concat([prefix, body, valid.subarray(12 + length)]) }), { code: 'INVALID_PROJECT_BUNDLE' });
  }
  assert.equal(touched, 0); assert.equal(target.projects.size, 0); assert.deepEqual(await files(target.assetsDir), {}); assert.deepEqual(await files(target.projectsDir), {});
});
