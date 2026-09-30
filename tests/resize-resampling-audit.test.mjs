import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { resamplePixels, normalizeResampleTransform } from '../server/resampling.mjs';
import { estimateLayerSelectionBytes } from '../server/layer-selection.mjs';
import { validateLayerFilterResources } from '../server/layer-filters.mjs';
import { layerTree } from '../server/groups.mjs';
import { encodeProjectBundle } from '../server/project-bundle.mjs';

const base = extra => ({ id: randomUUID(), name: 'Independent resampling', visible: true, opacity: 1, blendMode: 'normal', ...extra });
const solid = (width, height, extra) => base({ type: 'solid', color: '#286fa1', width, height, transforms: [], ...extra });
const bitmap = (values, width, height, extra) => ({ shape: 'bitmap', x: 0, y: 0, width, height, feather: 0, invert: false, runs: [...values].flatMap((value, index) => value ? [index, 1, value] : []), ...extra });
const unpack = mask => { const out = Buffer.alloc(mask.width * mask.height); for (let i = 0; i < mask.runs.length; i += 3) out.fill(mask.runs[i + 2], mask.runs[i], mask.runs[i] + mask.runs[i + 1]); return out; };
const rgba = (width, height) => Buffer.from(Array.from({ length: width * height }, (_, i) => [i * 37 % 256, (i * 71 + 19) % 256, (i * 113 + 29) % 256, i % 256]).flat());
const nearest = (input, iw, ih, ow, oh, channels = 4) => {
  const output = Buffer.alloc(ow * oh * channels);
  for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
    const sx = Number(((2n * BigInt(x) + 1n) * BigInt(iw)) / (2n * BigInt(ow)));
    const sy = Number(((2n * BigInt(y) + 1n) * BigInt(ih)) / (2n * BigInt(oh)));
    for (let c = 0; c < channels; c++) output[(y * ow + x) * channels + c] = input[(sy * iw + sx) * channels + c];
  }
  return output;
};
const edit = async (native, doc, command, args = {}) => (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...(command === 'apply_transaction' ? { label: 'Resize audit transaction' } : {}), ...args })).document;
const get = async (native, doc) => (await native.execute('get_document', { documentId: doc.id })).document;
const files = async dir => Object.fromEntries(await Promise.all((await fs.readdir(dir)).sort().map(async name => [name, await fs.readFile(path.join(dir, name))])));
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-resampling-audit-'));
  const native = await new NativeBackend({ dataDir, segmentSubject: () => assert.fail('Resize cannot invoke segmentation') }).init();
  t.after(async () => { await native.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { native, dataDir };
}
const project = async (native, width, height, layers, extra) => (await native.newProject({ name: 'Resize audit', width, height, selection: null, layers, ...extra }, 'Fixture')).document;
async function raster(native, input, width, height, extra) {
  const asset = await native.storeAsset(await sharp(input, { raw: { width, height, channels: 4 } }).png().toBuffer());
  return base({ type: 'raster', width, height, transforms: [], asset, sourceAsset: asset, sourceFormat: 'png', ...extra });
}

test('nearest matches independent BigInt indices and every RGBA byte across odd, mixed, one-pixel and all-alpha fixtures', async () => {
  const sizes = [[16, 16, 32, 32], [16, 16, 16, 16], [1, 31, 17, 7], [29, 1, 7, 19], [3, 4, 5, 7], [13, 4, 5, 11], [4, 13, 11, 5]];
  let seed = 7931; const next = () => seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  for (let i = 0; i < 80; i++) sizes.push(Array.from({ length: 4 }, () => 1 + next() % 35));
  for (const [iw, ih, width, height] of sizes) {
    const input = rgba(iw, ih), saved = Buffer.from(input), record = { type: 'resample', width, height, kernel: 'nearest' };
    const output = await resamplePixels(input, iw, ih, record);
    assert.deepEqual(output, nearest(input, iw, ih, width, height)); assert.deepEqual(input, saved);
    assert.notEqual(output, input); output.fill(0); assert.deepEqual(input, saved);
  }
  const width = 8192, input = rgba(width, 2); let ticked = false;
  const pending = resamplePixels(input, width, 2, { type: 'resample', width, height: 17, kernel: 'nearest' });
  setImmediate(() => { ticked = true; }); const output = await pending;
  assert.equal(ticked, true, 'wide output yields before completing its full copy');
  assert.deepEqual(output, nearest(input, width, 2, width, 17));
});

test('default and explicit Lanczos3 retain the exact old descriptor and sequential Sharp geometry pixels', async t => {
  const { native } = await fixture(t), input = rgba(7, 5), layer = await raster(native, input, 7, 5);
  for (const resample of [undefined, 'lanczos3']) {
    let doc = await project(native, 7, 5, [layer]);
    const steps = [[3, 9], [11, 4], [5, 7]]; let expected = input, oldW = 7, oldH = 5;
    for (const [width, height] of steps) {
      doc = await edit(native, doc, 'resize_document', { width, height, ...(resample ? { resample } : {}) });
      expected = await sharp(expected, { raw: { width: oldW, height: oldH, channels: 4 } }).resize(width, height, { fit: 'fill', kernel: 'lanczos3' }).raw().toBuffer();
      assert.deepEqual(doc.layers[0].transforms.at(-1), { type: 'resize', width, height });
      assert.deepEqual(await native.renderLayer(doc.layers[0]), expected); oldW = width; oldH = height;
    }
  }
});

test('actual source alpha combines before filters and nearest geometry, including contextual RGB restoration', async t => {
  const { native } = await fixture(t), width = 7, height = 5, input = rgba(width, height), alpha = Buffer.from(Array.from({ length: width * height }, (_, i) => [0, 1, 128, 255][i % 4]));
  const layer = await raster(native, input, width, height, { alphaAsset: await native.storeAlpha(alpha, width, height), filters: [{ id: randomUUID(), kind: 'invert', value: 100, enabled: true, opacity: 0.5 }] });
  let doc = await project(native, width, height, [layer]); const sourceFiles = await files(native.assetsDir);
  doc = await edit(native, doc, 'resize_document', { width: 11, height: 8, resample: 'nearest' });
  const effective = Buffer.from(input), filtered = Buffer.from(input);
  for (let i = 0; i < width * height; i++) {
    const a = Number((BigInt(input[i * 4 + 3]) * BigInt(alpha[i]) * 2n + 255n) / 510n);
    effective[i * 4 + 3] = filtered[i * 4 + 3] = a;
    if (a) for (let c = 0; c < 3; c++) filtered[i * 4 + c] = 128;
  }
  const expected = nearest(filtered, width, height, 11, 8), original = nearest(effective, width, height, 11, 8), protectedPixels = Buffer.from(Array.from({ length: 88 }, (_, i) => i % 3 ? 0 : 1));
  assert.deepEqual(await native.renderLayer(doc.layers[0]), expected);
  for (let i = 0; i < 88; i++) if (protectedPixels[i]) original.copy(expected, i * 4, i * 4, i * 4 + 3);
  assert.deepEqual(await native.renderLayer(doc.layers[0], { protectedPixels }), expected);
  assert.deepEqual(await files(native.assetsDir), sourceFiles); assert.equal(doc.layers[0].alphaAsset, layer.alphaAsset);
  // A nonlinear resize cannot be moved before alpha multiplication. This
  // separate fixture pins existing photo behavior as well as nearest copying.
  const photo = await edit(native, await project(native, width, height, [{ ...layer, filters: [] }]), 'resize_document', { width: 4, height: 3, resample: 'mitchell' });
  const wanted = await sharp(effective, { raw: { width, height, channels: 4 } }).resize(4, 3, { fit: 'fill', kernel: 'mitchell' }).raw().toBuffer();
  assert.deepEqual(await native.renderLayer(photo.layers[0]), wanted);
});

test('image methods leave independent mask, density, group, saved selection and guide resize rules unchanged', async t => {
  const { native } = await fixture(t), width = 7, height = 5, w = 11, h = 3;
  const values = Buffer.from(Array.from({ length: width * height }, (_, i) => [0, 1, 128, 255][i % 4]));
  const mask = bitmap(values, width, height, { feather: 1.25, invert: true });
  const geometric = { shape: 'polygon', x: .25, y: .5, width: 5, height: 4, points: [{ x: .25, y: .5 }, { x: 5.25, y: .5 }, { x: 3, y: 4.5 }], feather: .75, invert: true, clip: { x: 1, y: .75, width: 4, height: 3 } };
  const group = base({ type: 'group', mode: 'pass-through', mask, maskDensity: .5, visible: false }), child = solid(width, height, { parentId: group.id });
  const adjustment = base({ type: 'adjustment', kind: 'brightness', value: 12, mask: geometric, maskDensity: .25 });
  const extra = { selection: bitmap(Buffer.alloc(width * height), width, height), savedSelections: [{ id: randomUUID(), name: 'Source gray', mask }, { id: randomUUID(), name: 'Polygon', mask: geometric }], guides: [{ id: randomUUID(), axis: 'vertical', position: 7 }, { id: randomUUID(), axis: 'horizontal', position: 2 }] };
  let reference;
  for (const resample of ['nearest', 'cubic', 'mitchell', 'lanczos3']) {
    const doc = await project(native, width, height, structuredClone([group, child, adjustment]), structuredClone(extra));
    const result = await edit(native, doc, 'resize_document', { width: w, height: h, resample });
    assert.deepEqual(unpack(result.layers[0].mask), nearest(values, width, height, w, h, 1));
    assert.equal(result.layers[0].mask.feather, 1.25 * Math.min(w / width, h / height)); assert.equal(result.layers[0].mask.invert, true); assert.equal(result.layers[0].maskDensity, .5);
    assert.deepEqual(result.selection.runs, []); assert.equal(result.selection.width, w); assert.equal(result.selection.height, h);
    assert.deepEqual(result.layers[2].mask.points, geometric.points.map(p => ({ x: p.x * (w / width), y: p.y * (h / height) })));
    assert.equal(result.layers[2].maskDensity, .25); assert.equal(result.layers[0].transforms, undefined);
    assert.deepEqual(result.guides.map(g => g.position), [11, 1]);
    const metadata = { masks: result.layers.map(l => l.mask), density: result.layers.map(l => l.maskDensity), saved: result.savedSelections, selection: result.selection, guides: result.guides };
    if (reference) assert.deepEqual(metadata, reference); else reference = metadata;
  }
});

test('protected proportions and every positioned wrapper reject before raster access and preserve complete project state', async t => {
  const { native } = await fixture(t), width = 8, height = 6;
  const layers = [solid(width, height, { protected: true, visible: false, mask: bitmap([], width, height) })];
  let doc = await project(native, width, height, layers);
  const render = native.renderLayer, store = native.storeAsset; native.renderLayer = () => assert.fail('No raster read'); native.storeAsset = () => assert.fail('No asset write');
  try {
    for (const resample of ['nearest', 'cubic', 'mitchell', 'lanczos3']) { await assert.rejects(edit(native, doc, 'resize_document', { width: 13, height: 6, resample }), { code: 'PROTECTED_LAYER' }); assert.deepEqual(await get(native, doc), doc); }
    doc = await edit(native, doc, 'resize_document', { width: 16, height: 12, resample: 'nearest' }); assert.equal(doc.layers[0].protected, true);
    for (const type of ['solid', 'group', 'adjustment']) {
      const mask = { shape: 'positioned', sourceWidth: 8, sourceHeight: 6, x: 0, y: 0, source: bitmap([], 8, 6), domain: { x: 1, y: 0, width: 6, height: 6 } };
      const layer = type === 'solid' ? solid(8, 6, { mask, visible: false, maskDensity: 0 }) : base({ type, ...(type === 'group' ? { mode: 'pass-through' } : { kind: 'brightness', value: 12 }), mask, visible: false, maskDensity: 0 });
      const original = await project(native, 8, 6, [layer]);
      await assert.rejects(edit(native, original, 'resize_document', { width: 16, height: 12, resample: 'nearest' }), { code: 'MASK_POSITION_REQUIRES_RASTERIZE' }); assert.deepEqual(await get(native, original), original);
      const identity = await edit(native, original, 'resize_document', { width: 8, height: 6, resample: 'nearest' }); assert.deepEqual(identity.layers[0].mask, mask);
    }
  } finally { native.renderLayer = render; native.storeAsset = store; }
});

test('strict resample records and reserved legacy fields reject before portable asset validation', async t => {
  const { native } = await fixture(t), layer = await raster(native, rgba(2, 2), 2, 2), assetBytes = await fs.readFile(path.join(native.assetsDir, layer.asset));
  const invalid = [
    { type: 'resample', width: 2, height: 2 }, { type: 'resample', width: 2, height: 2, kernel: 'automatic' },
    { type: 'resample', width: 2, height: 2, kernel: 'nearest', resample: 'nearest' },
    { type: 'resize', width: 2, height: 2, kernel: 'nearest' }, { type: 'resize', width: 2, height: 2, resample: 'nearest' },
  ];
  for (const transform of invalid) {
    const graph = { name: 'Invalid resize', width: 2, height: 2, selection: null, layers: [{ ...layer, transforms: [transform] }] };
    assert.throws(() => native.validateGraph(graph));
    const data = await encodeProjectBundle({ graph, validateGraph: () => {}, readAsset: async () => assetBytes });
    const validate = native.validateProjectAsset, store = native.storeAsset; native.validateProjectAsset = () => assert.fail('Invalid transform reached asset decode'); native.storeAsset = () => assert.fail('Invalid transform reached asset publication');
    try { await assert.rejects(native.importProject({ data }), { code: 'INVALID_PROJECT_BUNDLE' }); } finally { native.validateProjectAsset = validate; native.storeAsset = store; }
  }
  for (const kernel of ['nearest', 'cubic', 'mitchell', 'lanczos3']) assert.equal(normalizeResampleTransform({ type: 'resample', width: 2, height: 2, kernel }).kernel, kernel);
  // Captured old native allowlist, deliberately independent of the new helper.
  const legacyAccepts = record => ['crop', 'resize', 'affine', 'canvas'].includes(record.type);
  assert.equal(legacyAccepts({ type: 'resample', width: 2, height: 2, kernel: 'nearest' }), false);
});

test('intermediate resample dimensions remain in selection, filter and PSD resource estimates', async t => {
  const { native } = await fixture(t);
  const transforms = [{ type: 'resample', width: 6000, height: 4000, kernel: 'nearest' }, { type: 'resample', width: 6000, height: 4000, kernel: 'mitchell' }, { type: 'resample', width: 1, height: 1, kernel: 'cubic' }];
  const layer = base({ type: 'raster', width: 5000, height: 4000, asset: 'a'.repeat(64), sourceAsset: 'a'.repeat(64), transforms, filters: [{ id: randomUUID(), kind: 'brightness', value: 1, enabled: true, opacity: 1 }] });
  const graph = { name: 'Intermediate resource', width: 1, height: 1, selection: null, layers: [layer] };
  native.validateGraph(graph);
  const expected = 4 * 20_000_000 + 4 * 24_000_000 + 4 * 24_000_000 + 1;
  assert.equal(estimateLayerSelectionBytes({ graph, layer }).sourceBytes, expected); assert.ok(expected > 256 * 1024 * 1024);
  assert.equal(validateLayerFilterResources(graph, layerTree(graph.layers)).retainedScratchBytes, 8 * 24_000_000 + 1);
  const psdLayer = { ...layer, filters: [], mask: { shape: 'positioned', sourceWidth: 1, sourceHeight: 1, x: 0, y: 0, source: { x: 0, y: 0, width: 1, height: 1 } } };
  const doc = await project(native, 1, 1, [psdLayer]); const render = native.renderGraph; native.renderGraph = () => assert.fail('PSD resource refusal must precede source reads');
  try { const report = await native.inspectPsdExport({ documentId: doc.id, expectedRevision: doc.revision }); assert.equal(report.supported, false); assert.ok(report.issues.some(issue => issue.code === 'WORKING_MEMORY_LIMIT')); assert.ok(report.estimatedWorkingBytes >= expected); } finally { native.renderGraph = render; }
  const full = await project(native, 1, 1, [solid(1, 1, { transforms: Array.from({ length: 500 }, () => ({ type: 'resample', width: 1, height: 1, kernel: 'nearest' })) })]);
  await assert.rejects(edit(native, full, 'resize_document', { width: 2, height: 2, resample: 'nearest' }), /Too many geometry transforms/);
  assert.deepEqual(await get(native, full), full, 'retained-stage cap rejects the entire resize');
});

test('real persistence and late transaction failures discard every staged transform and mask without touching assets or cache', async t => {
  const { native } = await fixture(t), layer = await raster(native, rgba(7, 5), 7, 5, { mask: bitmap([255, 128, 1], 7, 5) });
  const doc = await project(native, 7, 5, [layer], { selection: { x: 1, y: 1, width: 3, height: 2 } }); await native.execute('get_preview', { documentId: doc.id, maxWidth: 32 });
  const original = { assets: await files(native.assetsDir), projects: await files(native.projectsDir), cache: native.previewCache.stats() };
  const oldDir = native.projectsDir; native.projectsDir = path.join(native.assetsDir, layer.asset);
  try { await assert.rejects(edit(native, doc, 'resize_document', { width: 13, height: 9, resample: 'nearest' }), { code: 'ENOTDIR' }); } finally { native.projectsDir = oldDir; }
  await assert.rejects(edit(native, doc, 'apply_transaction', { operations: [{ command: 'resize_document', args: { width: 13, height: 9, resample: 'mitchell' } }, { command: 'set_layer', args: { layerId: randomUUID(), visible: false } }] }), { code: 'NOT_FOUND' });
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await files(native.assetsDir), original.assets); assert.deepEqual(await files(native.projectsDir), original.projects); assert.deepEqual(native.previewCache.stats(), original.cache);
});
