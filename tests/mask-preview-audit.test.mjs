import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { renderMaskPreview, maskPreviewDimensions, estimateMaskPreviewBytes, MASK_PREVIEW_LIMITS } from '../server/mask-preview.mjs';

// These oracles deliberately avoid production mask/selection helpers. Integer
// rational arithmetic pins half ties independently of JS operation ordering.
const byte = value => Math.max(0, Math.min(255, Math.round(value)));
const ratioRound = (numerator, denominator) => Number((2n * BigInt(numerator) + BigInt(denominator)) / (2n * BigInt(denominator)));
const dimensions = (width, height, edge) => {
  const longest = Math.max(width, height);
  return longest <= edge ? { width, height } : { width: Math.max(1, ratioRound(width * edge, longest)), height: Math.max(1, ratioRound(height * edge, longest)) };
};
const sample = (pixel, source, output) => Number(BigInt(2 * pixel + 1) * BigInt(source) / BigInt(2 * output));
const bitmap = (values, width, height) => ({ shape: 'bitmap', x: 0, y: 0, width, height, feather: 0, invert: false,
  runs: [...values].flatMap((value, index) => value ? [index, 1, value] : []) });
const unpack = mask => {
  const result = Buffer.alloc(mask.width * mask.height);
  for (let i = 0; i < mask.runs.length; i += 3) result.fill(mask.runs[i + 2], mask.runs[i], mask.runs[i] + mask.runs[i + 1]);
  return result;
};
async function gray(result) {
  const image = Buffer.isBuffer(result.data) ? result.data : Buffer.from(result.data, 'base64');
  const { data, info } = await sharp(image).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, result.width); assert.equal(info.height, result.height); assert.equal(info.channels, 4);
  const values = Buffer.alloc(info.width * info.height);
  for (let i = 0; i < values.length; i++) {
    values[i] = data[4 * i];
    assert.deepEqual([...data.subarray(4 * i, 4 * i + 4)], [values[i], values[i], values[i], 255]);
  }
  return values;
}
const common = extra => ({ id: randomUUID(), name: 'Mask inspection audit', visible: true, opacity: 1, blendMode: 'normal', ...extra });
const solid = (width, height, extra = {}) => common({ type: 'solid', width, height, transforms: [], color: '#2476a3', ...extra });
const edit = async (native, doc, command, args = {}) => (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document;
const read = (native, doc, args = {}) => native.execute('get_mask_preview', { documentId: doc.id, expectedRevision: doc.revision, ...args });
const get = async (native, doc) => (await native.execute('get_document', { documentId: doc.id })).document;
const files = async directory => Object.fromEntries(await Promise.all((await fs.readdir(directory)).sort().map(async file => [file, await fs.readFile(path.join(directory, file))])));
const project = async (native, width, height, layers, extra = {}) => (await native.newProject({ name: 'Independent mask preview', width, height, layers, selection: null, ...extra }, 'Audit fixture')).document;
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-mask-preview-audit-'));
  const native = await new NativeBackend({ dataDir, segmentSubject: () => assert.fail('Mask inspection must not invoke segmentation') }).init();
  t.after(async () => { await native.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { native, dataDir };
}
function geometry(mask, x, y) {
  const px = x + 0.5, py = y + 0.5;
  let distance;
  if (mask.shape === 'ellipse') distance = (1 - Math.hypot((px - mask.x - mask.width / 2) / (mask.width / 2), (py - mask.y - mask.height / 2) / (mask.height / 2))) * Math.min(mask.width, mask.height) / 2;
  else distance = Math.min(px - mask.x, py - mask.y, mask.x + mask.width - px, mask.y + mask.height - py);
  let value = distance <= 0 ? 0 : mask.feather ? Math.min(1, distance / mask.feather) : 1;
  if (mask.invert) value = 1 - value;
  if (mask.clip && (px < mask.clip.x || py < mask.clip.y || px >= mask.clip.x + mask.clip.width || py >= mask.clip.y + mask.clip.height)) value = 0;
  return value;
}
function rawPsdMasks(data) {
  // Independently walk this export subset's section lengths and raw channel
  // records, without invoking the production PSD parser or writer helpers.
  assert.equal(data.toString('ascii', 0, 4), '8BPS');
  let at = 26;
  const u32 = () => { const value = data.readUInt32BE(at); at += 4; return value; };
  const u16 = () => { const value = data.readUInt16BE(at); at += 2; return value; };
  const i16 = () => { const value = data.readInt16BE(at); at += 2; return value; };
  for (let i = 0; i < 2; i++) { const length = u32(); at += length; }
  u32(); const layerInfoBytes = u32(), layerInfoEnd = at + layerInfoBytes, count = Math.abs(i16()), records = [];
  for (let i = 0; i < count; i++) {
    at += 16; const channels = [], channelCount = u16();
    for (let j = 0; j < channelCount; j++) channels.push({ id: i16(), length: u32() });
    at += 12; const extraBytes = u32(); at += extraBytes; records.push(channels);
  }
  const masks = [];
  for (const channels of records) for (const channel of channels) {
    assert.equal(u16(), 0); const pixels = Buffer.from(data.subarray(at, at + channel.length - 2)); at += channel.length - 2;
    if (channel.id === -2) masks.push(pixels);
  }
  assert.ok(at <= layerInfoEnd && layerInfoEnd - at <= 1); return masks;
}

test('independent rational sizing and pixel-center oracle covers half ties, narrow canvases and no enlargement', async () => {
  for (const [w, h, edge, expected] of [[420, 840, 457, [229, 457]], [220, 520, 299, [127, 299]], [1265, 2024, 1340, [838, 1340]], [102, 204, 105, [53, 105]], [2871, 3806, 519, [392, 519]], [1, 8192, 2400, [1, 2400]]]) {
    assert.deepEqual(maskPreviewDimensions(w, h, edge), { width: expected[0], height: expected[1] });
  }
  let seed = 871321;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let i = 0; i < 8000; i++) {
    const width = 1 + next() % 8192, height = 1 + next() % Math.min(8192, Math.floor(24_000_000 / width)), maxEdge = 32 + next() % 2369;
    assert.deepEqual(maskPreviewDimensions(width, height, maxEdge), dimensions(width, height, maxEdge));
  }
  for (const [width, height, maxEdge] of [[83, 127, 32], [1, 8192, 2400], [8192, 1, 700], [7, 3, 2400]]) {
    const values = Buffer.from(Array.from({ length: width * height }, (_, index) => (index * 71 + Math.floor(index / width) * 29) % 256));
    const result = await renderMaskPreview({ width, height, layers: [], selection: bitmap(values, width, height) }, { maxEdge });
    const out = dimensions(width, height, maxEdge), expected = Buffer.alloc(out.width * out.height);
    for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) expected[y * out.width + x] = values[sample(y, height, out.height) * width + sample(x, width, out.width)];
    assert.deepEqual(await gray(result), expected); assert.equal(result.sourceWidth, width); assert.equal(result.sourceHeight, height);
  }
});

test('all256 raw and density grayscale bytes match an integer oracle, including inverted bitmap half ties and loaded selections', async t => {
  const { native } = await fixture(t), width = 256, height = 1, values = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  for (const invert of [false, true]) for (const quarters of [0, 1, 2, 3, 4]) {
    const mask = { ...bitmap(values, width, height), invert }, layer = solid(width, height, { mask, maskDensity: quarters / 4 });
    let doc = await project(native, width, height, [layer], { selection: mask });
    const expectedRaw = Buffer.from([...values].map(value => invert ? 255 - value : value));
    const expectedEffective = Buffer.from([...expectedRaw].map(value => ratioRound(255 * (4 - quarters) + quarters * value, 4)));
    assert.deepEqual(await gray(await read(native, doc)), expectedRaw);
    for (const maskMode of ['raw', 'effective']) {
      const expected = maskMode === 'raw' ? expectedRaw : expectedEffective;
      assert.deepEqual(await gray(await read(native, doc, { source: 'layer-mask', layerId: layer.id, maskMode })), expected, `invert=${invert}, density=${quarters}/4, ${maskMode}`);
      doc = await edit(native, doc, 'load_layer_selection', { layerId: layer.id, source: 'layer-mask', maskMode });
      assert.deepEqual(unpack(doc.selection), expected);
    }
    const actual = await native.renderGraph(native.project(doc.id).states[native.project(doc.id).cursor].graph);
    assert.deepEqual(Buffer.from(Array.from({ length: width }, (_, i) => actual[i * 4 + 3])), expectedEffective, 'native source alpha uses the same corrected density');
  }
});

test('continuous geometric feather is evaluated once before density and sampling; bitmap feather stays byte-quantized', async () => {
  const width = 91, height = 57, maxEdge = 32;
  for (const shape of ['rectangle', 'ellipse']) for (const invert of [false, true]) {
    const mask = { shape, x: 0.3, y: 1.7, width: 83.2, height: 49.6, feather: 7.9, invert, clip: { x: 9.4, y: 3.2, width: 57.1, height: 47.6 } };
    const layer = { id: 'target', mask, maskDensity: 0.37 }, graph = { width, height, selection: mask, layers: [layer] }, before = structuredClone(graph);
    for (const maskMode of ['raw', 'effective']) {
      const result = await renderMaskPreview(graph, { source: 'layer-mask', layerId: layer.id, maskMode, maxEdge }), expected = Buffer.alloc(result.width * result.height);
      for (let y = 0; y < result.height; y++) for (let x = 0; x < result.width; x++) {
        const coverage = geometry(mask, sample(x, width, result.width), sample(y, height, result.height));
        expected[y * result.width + x] = byte(maskMode === 'raw' ? 255 * coverage : 255 * (1 - 0.37) + 255 * coverage * 0.37);
      }
      assert.deepEqual(await gray(result), expected);
    }
    assert.deepEqual(graph, before);
  }
  const values = Buffer.from([255, 128, 1, 64, 255, 255, 192, 240, 255]);
  for (const invert of [false, true]) {
    const mask = { ...bitmap(values, 3, 3), feather: 2, invert }, expected = Buffer.from([...values].map((value, index) => { const feathered = Math.round(value * (index === 4 ? 0.75 : 0.25)); return invert ? 255 - feathered : feathered; }));
    assert.deepEqual(await gray(await renderMaskPreview({ width: 3, height: 3, layers: [], selection: mask })), expected);
  }
});

test('independent preview ledger bounds buffers and transfer copies without a full geometric gray canvas', async () => {
  const E = 8 * 1024 * 1024, B = 4 * Math.ceil(E / 3);
  for (const [width, height, maxEdge] of [[6000, 4000, 2400], [4898, 4899, 2400], [1, 8192, 32], [420, 840, 457]]) for (const shape of ['rectangle', 'bitmap']) for (const feather of [0, 1.5]) for (const source of ['selection', 'layer-mask']) for (const maskMode of ['raw', 'effective']) for (const density of [0, 0.5, 1]) {
    const graph = { width, height }, mask = { shape, width, height, feather, runs: [] }, out = dimensions(width, height, maxEdge), P = out.width * out.height;
    const C = shape !== 'bitmap' || source === 'layer-mask' && maskMode === 'effective' && density === 0 ? 0 : width * height * (feather ? 5 : 1);
    assert.deepEqual(estimateMaskPreviewBytes({ graph, mask, source, maskMode, density, maxEdge }), {
      ...out, coverageBytes: C, sampledBytes: P, codecBytes: 4 * P, encodedBytes: E, base64Bytes: B, transferBytes: 5 * B,
      estimatedWorkingBytes: C + 5 * P + E + 5 * B, maxWorkingBytes: 256 * 1024 * 1024,
    });
    assert.ok(C + 5 * P + E + 5 * B < MASK_PREVIEW_LIMITS.maxWorkingBytes);
  }
  let heartbeats = 0; const timer = setInterval(() => heartbeats++, 0);
  try {
    const result = await renderMaskPreview({ width: 1000, height: 1000, layers: [], selection: { x: 0.4, y: 0.3, width: 998.7, height: 999.1, feather: 38.2 } }, { maxEdge: 1000 });
    assert.equal(result.width * result.height, 1_000_000); assert.ok(result.data.length <= E); assert.ok(heartbeats > 0);
  } finally { clearInterval(timer); }
  const tiny = await renderMaskPreview({ width: 8000, height: 3000, layers: [], selection: { x: 0, y: 0, width: 8000, height: 3000 } }, { maxEdge: 32 });
  assert.deepEqual([tiny.width, tiny.height], [32, 12]);
});

test('native mask reads ignore hidden content, group context and missing RGB while preserving project, assets, history and cache', async t => {
  const { native } = await fixture(t), width = 9, height = 7;
  const mask = { shape: 'ellipse', x: 0.2, y: 0.4, width: 8.6, height: 6.2, feather: 1.8, invert: true, clip: { x: 2, y: 1, width: 6, height: 5 } };
  const group = common({ type: 'group', mode: 'isolated', visible: false, opacity: 0.2, blendMode: 'multiply', mask, maskDensity: 0.5 });
  const raster = common({ type: 'raster', width, height, transforms: [], asset: 'a'.repeat(64), sourceAsset: 'b'.repeat(64), alphaAsset: 'c'.repeat(64), parentId: group.id, mask, maskDensity: 0, opacity: 0, visible: false });
  const adjustment = common({ type: 'adjustment', kind: 'invert', value: 100, mask, maskDensity: 1, visible: false });
  const doc = await project(native, width, height, [group, raster, adjustment], { selection: { ...bitmap(Buffer.alloc(width * height), width, height), invert: true }, savedSelections: [{ id: randomUUID(), name: 'Unchanged saved mask', mask }] });
  const warm = (await native.execute('create_document', { width: 8, height: 8 })).document; await native.execute('get_preview', { documentId: warm.id });
  const original = structuredClone(native.project(doc.id)), projectFiles = await files(native.projectsDir), assets = await files(native.assetsDir), cache = native.previewCache.stats();
  const forbidden = () => assert.fail('Mask-only inspection cannot render pixels, publish, access assets or use the composite cache');
  for (const method of ['renderLayer', 'renderGraph', 'readAlpha', 'storeAsset', 'persist', 'sourcePixels', 'readProjectAsset']) native[method] = forbidden;
  for (const method of ['get', 'set', 'invalidateDocument', 'clear']) native.previewCache[method] = forbidden;
  assert.deepEqual(await gray(await read(native, doc)), Buffer.alloc(width * height, 255));
  for (const layer of [group, raster, adjustment]) for (const maskMode of ['raw', 'effective']) {
    const result = await read(native, doc, { source: 'layer-mask', layerId: layer.id, maskMode }), expected = Buffer.from(Array.from({ length: width * height }, (_, i) => {
      const raw = geometry(mask, i % width, Math.floor(i / width)), density = maskMode === 'raw' ? 1 : layer.maskDensity;
      return byte(255 * (1 - density) + 255 * raw * density);
    }));
    assert.deepEqual(await gray(result), expected); result.width = 999; result.data = 'caller changed response';
  }
  assert.deepEqual(native.project(doc.id), original); assert.deepEqual(await get(native, doc), doc);
  assert.deepEqual(await files(native.projectsDir), projectFiles); assert.deepEqual(await files(native.assetsDir), assets); assert.deepEqual(native.previewCache.stats(), cache);
});

test('queued reads bind one revision and failures never populate cache or corrupt later fresh reads', async t => {
  const { native } = await fixture(t), width = 7, height = 3, values = Buffer.from(Array.from({ length: 21 }, (_, i) => i * 11));
  const doc = await project(native, width, height, [solid(width, height)], { selection: bitmap(values, width, height) });
  let release; const gate = new Promise(resolve => { release = resolve; }); void native.enqueue(() => gate);
  const before = read(native, doc), mutation = edit(native, doc, 'modify_selection', { invert: true }), stale = assert.rejects(read(native, doc), { code: 'REVISION_CONFLICT' });
  const current = native.execute('get_mask_preview', { documentId: doc.id }); release();
  const a = await before, changed = await mutation, b = await current; await stale;
  assert.equal(a.revision, doc.revision); assert.equal(b.revision, changed.revision);
  assert.deepEqual(await gray(a), values); assert.deepEqual(await gray(b), Buffer.from([...values].map(value => 255 - value)));
  const expected = structuredClone(b); b.data = ''; b.width = 0;
  assert.deepEqual(await read(native, changed), expected); assert.equal(native.previewCache.stats().entries, 0);
  const undone = await edit(native, changed, 'undo'); assert.deepEqual(await gray(await read(native, undone)), values);
});

test('invalid descriptors cannot hide behind density zero, while null and explicit empty selections remain distinct', async t => {
  const { native } = await fixture(t), width = 4, height = 3, layer = solid(width, height), doc = await project(native, width, height, [layer]);
  const disk = await files(native.projectsDir), before = structuredClone(native.project(doc.id));
  await assert.rejects(read(native, doc), { code: 'NO_SELECTION' });
  await assert.rejects(read(native, doc, { source: 'layer-mask', layerId: layer.id }), { code: 'NO_MASK' });
  for (const args of [{ source: null }, { layerId: layer.id }, { maskMode: 'raw' }, { source: 'layer-mask' }, { source: 'layer-mask', layerId: 'missing' }, { maxEdge: 31 }, { maxEdge: 2401 }, { maxEdge: 32.5 }]) await assert.rejects(read(native, doc, args));
  for (const mask of [
    { ...bitmap([255], 4, 3), runs: [0, 13, 255] },
    { ...bitmap([255], 4, 3), runs: [0, 1, 128, 0, 1, 255] },
    bitmap([255], 3, 3),
    { x: 0, y: 0, width, height, feather: NaN },
    { x: 0, y: 0, width, height, clip: { x: 0, y: 0, width, height, density: 0 } },
  ]) await assert.rejects(renderMaskPreview({ width, height, layers: [{ id: 'x', mask, maskDensity: 0 }] }, { source: 'layer-mask', layerId: 'x' }), { code: 'INVALID_ARGUMENT' });
  for (const invert of [false, true]) assert.deepEqual(await gray(await renderMaskPreview({ width, height, layers: [], selection: { ...bitmap(Buffer.alloc(width * height), width, height), invert } })), Buffer.alloc(width * height, invert ? 255 : 0));
  assert.deepEqual(native.project(doc.id), before); assert.deepEqual(await files(native.projectsDir), disk); assert.equal(native.previewCache.stats().entries, 0);
});

test('PSD still distinguishes exact density bytes from fractional half-byte masks after numerical correction', async t => {
  const { native } = await fixture(t), width = 8, height = 1, values = Buffer.from([1, 9, 39, 71, 103, 135, 169, 233]);
  const bg = solid(width, height, { color: '#ffffff' }), fg = solid(width, height, { mask: bitmap(values, width, height), maskDensity: 0.5 });
  let doc = await project(native, width, height, [bg, fg]);
  const before = structuredClone(native.project(doc.id)), disk = await files(native.projectsDir);
  const report = await native.inspectPsdExport({ documentId: doc.id, expectedRevision: doc.revision });
  assert.equal(report.supported, true, 'odd source bytes produce exact integer effective bytes at half density');
  const exact = Buffer.from([...values].map(value => (255 + value) / 2));
  assert.deepEqual(await gray(await read(native, doc, { source: 'layer-mask', layerId: fg.id })), exact);
  assert.deepEqual(rawPsdMasks((await native.exportPsd({ documentId: doc.id, expectedRevision: doc.revision })).data), [exact]);
  assert.deepEqual(native.project(doc.id), before); assert.deepEqual(await files(native.projectsDir), disk);
  const raw = native.project(doc.id).states[native.project(doc.id).cursor].graph.layers.find(layer => layer.id === fg.id).mask;
  // This separate fixture changes only one source byte from odd to even.
  doc = await project(native, width, height, [bg, { ...fg, mask: { ...raw, runs: [0, 1, 10, ...raw.runs.slice(3)] } }]);
  const fractional = await native.inspectPsdExport({ documentId: doc.id, expectedRevision: doc.revision });
  assert.equal(fractional.supported, false); assert.ok(fractional.issues.some(issue => issue.code === 'MASK_NOT_REPRESENTABLE'));
  await assert.rejects(native.exportPsd({ documentId: doc.id }), { code: 'PSD_UNSUPPORTED' });
  assert.equal((await gray(await read(native, doc, { source: 'layer-mask', layerId: fg.id })))[0], 133, 'inspection quantizes but PSD exact export refuses132.5');
});
