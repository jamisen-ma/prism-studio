import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { preflightPsdExport, writePsdExport, PSD_EXPORT_LIMITS } from '../server/psd-export.mjs';
import { NativeBackend } from '../server/native.mjs';
import { bitmapMask } from '../server/masks.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profilePng = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } }).withIccProfile('srgb').png().toBuffer();
const profile = (await sharp(profilePng).metadata()).icc;
function fixture(width, height) {
  const count = width * height, base = Buffer.alloc(count * 4), top = Buffer.alloc(count * 4), mask = Buffer.alloc(count);
  for (let i = 0; i < count; i++) {
    base.set([37, 89, 173, 255], i * 4);
    top.set([(i * 61 + 219) % 256, (i * 37 + 17) % 256, (i * 11 + 73) % 256, [0, 1, 128, 255][i % 4]], i * 4);
    mask[i] = [0, 1, 128, 255][(i + 1) % 4];
  }
  return { width, height, iccProfile: Buffer.from(profile), composite: Buffer.from(base), layers: [
    { id: 'base', name: 'Fond 🌿', visible: true, opacity: 1, pixels: base },
    { id: 'soft', name: '隐藏 Ω', visible: false, opacity: 128 / 255, pixels: top, mask },
  ] };
}
const graphOf = (input) => ({ width: input.width, height: input.height, layers: input.layers.map(({ pixels, ...layer }) => ({ ...layer, type: 'raster', blendMode: 'normal' })) });

// An original fixture-only byte walker, not a PSD input parser for the app.
// Independent assertions follow Adobe's header/section/channel layout.
function verifyBytes(data, input) {
  let at = 0;
  const bytes = (length) => { assert.ok(length >= 0 && at + length <= data.length); const value = data.subarray(at, at + length); at += length; return value; };
  const u8 = () => bytes(1).readUInt8(), u16 = () => bytes(2).readUInt16BE(), i16 = () => bytes(2).readInt16BE(), u32 = () => bytes(4).readUInt32BE();
  assert.equal(bytes(4).toString(), '8BPS'); assert.equal(u16(), 1); assert.deepEqual(bytes(6), Buffer.alloc(6));
  assert.equal(u16(), 3); assert.equal(u32(), input.height); assert.equal(u32(), input.width); assert.equal(u16(), 8); assert.equal(u16(), 3);
  assert.equal(u32(), 0);
  const resourceBytes = u32(), resourcesEnd = at + resourceBytes;
  assert.equal(bytes(4).toString(), '8BIM'); assert.equal(u16(), 1039);
  const resourceNameLength = u8(); bytes(resourceNameLength); if ((resourceNameLength + 1) % 2) assert.equal(u8(), 0);
  const profileBytes = u32(); assert.deepEqual(bytes(profileBytes), input.iccProfile); if (profileBytes % 2) assert.equal(u8(), 0);
  assert.equal(at, resourcesEnd);
  const sectionBytes = u32(), sectionEnd = at + sectionBytes, infoBytes = u32(), infoEnd = at + infoBytes;
  assert.equal(infoBytes % 2, 0); assert.equal(i16(), input.layers.length);
  const records = [];
  for (const layer of input.layers) {
    assert.deepEqual([u32(), u32(), u32(), u32()], [0, 0, input.height, input.width]);
    const channels = [], count = u16(); assert.equal(count, layer.mask ? 5 : 4);
    for (let c = 0; c < count; c++) channels.push({ id: i16(), length: u32() });
    assert.equal(bytes(4).toString(), '8BIM'); assert.equal(bytes(4).toString(), 'norm');
    assert.equal(u8(), Math.round(layer.opacity * 255)); assert.equal(u8(), 0);
    const flags = u8(); assert.equal(Boolean(flags & 2), !layer.visible); assert.equal(flags & 1, 0, 'Prism protection must not pretend to be a Photoshop editing restriction'); assert.equal(u8(), 0);
    const extraBytes = u32(), extraEnd = at + extraBytes, maskLength = u32();
    assert.equal(maskLength, layer.mask ? 20 : 0);
    if (layer.mask) { assert.deepEqual([u32(), u32(), u32(), u32()], [0, 0, input.height, input.width]); assert.deepEqual(bytes(4), Buffer.alloc(4)); }
    assert.equal(u32(), 0);
    const nameLength = u8(); bytes(nameLength); bytes((4 - ((1 + nameLength) % 4)) % 4);
    assert.equal(bytes(4).toString(), '8BIM'); assert.equal(bytes(4).toString(), 'luni');
    const unicodeLength = u32(), units = u32(); assert.equal(unicodeLength, 4 + 2 * layer.name.length); assert.equal(units, layer.name.length);
    for (let i = 0; i < units; i++) assert.equal(u16(), layer.name.charCodeAt(i));
    assert.equal(at, extraEnd); records.push({ layer, channels });
  }
  for (const { layer, channels } of records) for (const channel of channels) {
    assert.equal(channel.length, input.width * input.height + 2); assert.equal(u16(), 0);
    const plane = bytes(channel.length - 2);
    const expected = channel.id === -2 ? layer.mask : Buffer.from(Array.from({ length: input.width * input.height }, (_, i) => layer.pixels[i * 4 + (channel.id === -1 ? 3 : channel.id)]));
    assert.deepEqual(plane, expected, `raw channel ${channel.id} of ${layer.name}`);
  }
  const infoPadding = infoEnd - at;
  assert.ok(infoPadding >= 0 && infoPadding <= 1); assert.deepEqual(bytes(infoPadding), Buffer.alloc(infoPadding));
  assert.equal(u32(), 0); assert.equal(at, sectionEnd); assert.equal(u16(), 0);
  for (let channel = 0; channel < 3; channel++) assert.deepEqual(bytes(input.width * input.height), Buffer.from(Array.from({ length: input.width * input.height }, (_, i) => input.composite[i * 4 + channel])));
  assert.equal(at, data.length, 'No unaccounted trailing bytes or truncated rows');
}

test('independent byte walk verifies odd sizes, raw hidden RGB/alpha, masks, Unicode and ICC', () => {
  for (const [width, height] of [[1, 1], [1, 3], [3, 1], [3, 3], [2, 5]]) {
    const input = fixture(width, height), before = structuredClone(input), report = preflightPsdExport(graphOf(input), { iccProfileBytes: profile.length });
    assert.equal(report.supported, true);
    const result = writePsdExport(input); assert.equal(result.bytes, report.estimatedBytes); assert.equal(result.data.length, result.bytes);
    verifyBytes(result.data, input);
    for (let i = 0; i < input.layers.length; i++) assert.deepEqual(input.layers[i].pixels, Buffer.from(before.layers[i].pixels));
    assert.deepEqual(input.composite, Buffer.from(before.composite)); assert.deepEqual(input.iccProfile, Buffer.from(before.iccProfile));
    result.data.fill(0); assert.deepEqual(input.layers[0].pixels, Buffer.from(before.layers[0].pixels));
  }
});

test('Pillow and psd-tools independently decode the strict exported subset', async (t) => {
  const python = path.join(root, 'test-results', 'psd-evaluation', 'python', 'bin', 'python');
  try { await fs.access(python); } catch { t.skip('Optional isolated PSD evaluation decoders are not installed.'); return; }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-psd-audit-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const expectations = [];
  for (const [width, height] of [[1, 1], [1, 3], [3, 1], [3, 3], [2, 5]]) {
    const input = fixture(width, height), filename = `${width}x${height}.psd`;
    await fs.writeFile(path.join(directory, filename), writePsdExport(input).data);
    expectations.push({ filename, width, height, profile: input.iccProfile.toString('base64'), composite: [...input.composite], layers: input.layers.map((layer) => ({ name: layer.name, visible: layer.visible, opacity: Math.round(layer.opacity * 255), pixels: [...layer.pixels], mask: layer.mask ? [...layer.mask] : null })) });
  }
  await fs.writeFile(path.join(directory, 'expected.json'), JSON.stringify(expectations));
  const script = `import sys,json,pathlib,base64\nfrom PIL import Image\nfrom psd_tools import PSDImage\nroot=pathlib.Path(sys.argv[1])\nfixtures=json.loads((root/'expected.json').read_text())\nfor fixture in fixtures:\n image=Image.open(root/fixture['filename'])\n assert image.size==(fixture['width'],fixture['height'])\n assert image.info['icc_profile']==base64.b64decode(fixture['profile'])\n assert list(image.convert('RGBA').tobytes())==fixture['composite']\n psd=PSDImage.open(root/fixture['filename'])\n assert len(psd)==len(fixture['layers'])\n for layer,expected in zip(psd,fixture['layers']):\n  assert not layer.is_group()\n  assert layer.name==expected['name']\n  assert layer.visible==expected['visible']\n  assert layer.opacity==expected['opacity']\n  assert layer.bbox==(0,0,fixture['width'],fixture['height'])\n  assert list(layer.topil(apply_icc=False).convert('RGBA').tobytes())==expected['pixels']\n  if expected['mask'] is not None:\n   assert layer.mask.bbox==(0,0,fixture['width'],fixture['height'])\n   assert list(layer.mask.topil().convert('L').tobytes())==expected['mask']\nprint(json.dumps({'fixtures':len(fixtures),'pillowMergedExact':True,'psdToolsRawLayersExact':True,'maskAndUnicodeExact':True,'iccExact':True}))\n`;
  const decoded = spawnSync(python, ['-c', script, directory], { encoding: 'utf8', timeout: 20_000, maxBuffer: 1_000_000 });
  assert.equal(decoded.status, 0, decoded.stderr);
  const warnings = decoded.stderr.trim().split(/\r?\n/).filter(Boolean);
  assert.ok(warnings.every((line) => line === "Invalid signature (b'\\x00\\x00\\x00\\x00')"), decoded.stderr);
  const report = JSON.parse(decoded.stdout);
  assert.equal(report.fixtures, 5); assert.equal(report.psdToolsRawLayersExact, true);
  await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
  await fs.writeFile(path.join(root, 'test-results', 'psd-export-audit-report.json'), JSON.stringify({
    ...report, decoders: ['Pillow 12.3.0', 'psd-tools 1.19.0'], dimensions: [[1, 1], [1, 3], [3, 1], [3, 3], [2, 5]], warnings,
    warningExplanation: 'psd-tools skips the required zero-length global-mask field when fewer than17 file bytes remain, then treats its four zeros as a tagged-block signature. Exact section walking and decoded pixels remain correct. No other warnings accepted.',
  }, null, 2) + '\n');
});

test('strict preflight reports every unsupported feature including hidden layers before pixel allocation', () => {
  const input = fixture(3, 3), base = graphOf(input);
  for (const [changed, expectedCode] of [
    [{ type: 'group' }, 'LAYER_TYPE_UNSUPPORTED'], [{ type: 'adjustment' }, 'LAYER_TYPE_UNSUPPORTED'], [{ type: 'text' }, 'LAYER_TYPE_UNSUPPORTED'], [{ type: 'gradient' }, 'LAYER_TYPE_UNSUPPORTED'],
    [{ parentId: 'group' }, 'GROUPS_UNSUPPORTED'], [{ blendMode: 'multiply' }, 'BLEND_MODE_UNSUPPORTED'], [{ opacity: 0.5 }, 'OPACITY_NOT_REPRESENTABLE'],
    [{ filters: [{ enabled: false }] }, 'FILTER_STACK_UNSUPPORTED'], [{ effects: {} }, 'LAYER_EFFECTS_UNSUPPORTED'], [{ outline: { width: 1 } }, 'OUTLINE_UNSUPPORTED'], [{ role: 'generated' }, 'CONTEXTUAL_GENERATION_UNSUPPORTED'], [{ provenance: { jobId: 'retained-job' } }, 'CONTEXTUAL_GENERATION_UNSUPPORTED'],
    [{ name: 'unpaired\ud800' }, 'INVALID_LAYER_NAME'], [{ name: 'control\u0000name' }, 'INVALID_LAYER_NAME'], [{ visible: 1 }, 'INVALID_VISIBILITY'],
  ]) {
    const graph = structuredClone(base); Object.assign(graph.layers[1], changed);
    const report = preflightPsdExport(graph); assert.equal(report.supported, false); assert.ok(report.issues.some((issue) => issue.code === expectedCode && issue.layerId === 'soft'));
  }
  const exact = preflightPsdExport({ ...base, layers: [{ ...base.layers[0], protected: true, transforms: [{}] }] });
  assert.equal(exact.supported, true); assert.ok(exact.warnings.some((item) => item.code === 'PROTECTION_NOT_PORTABLE')); assert.ok(exact.warnings.some((item) => item.code === 'GEOMETRY_RASTERIZED'));
});

test('the exact one-byte-over output boundary rejects with metadata before validating tiny supplied buffers', () => {
  const width = 4095, height = 2341, layer = { id: 'single', name: 'A', visible: true, opacity: 1, type: 'raster', blendMode: 'normal' };
  let profileBytes;
  for (let size = 132; size <= 65536; size += 2) {
    const report = preflightPsdExport({ width, height, layers: [layer] }, { iccProfileBytes: size });
    if (report.estimatedBytes === PSD_EXPORT_LIMITS.maxOutputBytes + 1) { profileBytes = size; break; }
  }
  assert.ok(profileBytes, 'Fixture must exercise an exact one-byte overflow');
  const accepted = preflightPsdExport({ width, height, layers: [layer] }, { iccProfileBytes: profileBytes - 2 });
  assert.equal(accepted.estimatedBytes, PSD_EXPORT_LIMITS.maxOutputBytes - 1); assert.equal(accepted.supported, true);
  assert.throws(() => writePsdExport({ width, height, layers: [{ id: layer.id, name: layer.name, visible: true, opacity: 1, pixels: Buffer.alloc(0) }], composite: Buffer.alloc(0), iccProfile: Buffer.alloc(profileBytes) }), (cause) => cause.code === 'LIMIT_EXCEEDED' && cause.report.issues.some((item) => item.code === 'OUTPUT_LIMIT'));
});

test('malformed channels, transparent composites and invalid ICC reject without changing caller buffers', () => {
  const original = fixture(3, 3), before = Buffer.from(original.layers[1].pixels);
  const cases = [
    { ...original, composite: Buffer.alloc(4) },
    { ...original, composite: Buffer.alloc(3 * 3 * 4) },
    { ...original, layers: original.layers.map((layer, i) => i ? { ...layer, pixels: Buffer.alloc(3) } : layer) },
    { ...original, layers: original.layers.map((layer, i) => i ? { ...layer, mask: Buffer.alloc(1) } : layer) },
    { ...original, layers: original.layers.map((layer, i) => i ? { ...layer, opacity: 0.5 } : layer) },
    { ...original, layers: original.layers.map((layer, i) => i ? { ...layer, type: 'group' } : layer) },
    { ...original, iccProfile: Buffer.alloc(480) },
  ];
  const brokenTags = Buffer.from(profile); brokenTags.writeUInt32BE(0xffffffff, 128); cases.push({ ...original, iccProfile: brokenTags });
  const brokenBounds = Buffer.from(profile); brokenBounds.writeUInt32BE(profile.length - 4, 136); cases.push({ ...original, iccProfile: brokenBounds });
  for (const input of cases) assert.throws(() => writePsdExport(input), (cause) => ['INVALID_ARGUMENT', 'PSD_UNSUPPORTED'].includes(cause.code));
  assert.deepEqual(original.layers[1].pixels, before);
  assert.equal(writePsdExport(original).bytes, preflightPsdExport(graphOf(original), { iccProfileBytes: profile.length }).estimatedBytes);
});

test('native export preserves exact source alpha/mask bytes and performs no history, asset or cache publication', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-psd-native-audit-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const native = await new NativeBackend({ dataDir }).init();
  let doc = (await native.execute('create_document', { width: 6, height: 4, background: '#315579' })).document;
  const synthetic = fixture(6, 4), original = await sharp(synthetic.layers[1].pixels, { raw: { width: 6, height: 4, channels: 4 } }).png().toBuffer();
  const source = (await native.execute('import_image', { data: original.toString('base64'), mimeType: 'image/png' })).document;
  const edit = async (command, args = {}) => { doc = (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document; };
  await edit('place_layer', { sourceDocumentId: source.id, sourceLayerId: source.layers[0].id, x: 0, y: 0, width: 6, height: 4, fit: 'contain', protect: true });
  const top = doc.layers.at(-1), maskBytes = Buffer.from(Array.from({ length: 24 }, (_, i) => [0, 1, 128, 255][i % 4]));
  await edit('set_layer_mask', { layerId: top.id, mask: bitmapMask(maskBytes, 6, 4) });
  await edit('set_layer', { layerId: top.id, name: 'Preserved 🌿 Ω' });
  await native.execute('get_preview', { documentId: doc.id });
  const file = path.join(dataDir, 'projects', `${doc.id}.json`), bytes = await fs.readFile(file), cache = native.previewCache.stats(), assets = await fs.readdir(native.assetsDir);
  const report = await native.inspectPsdExport({ documentId: doc.id, expectedRevision: doc.revision });
  assert.equal(report.supported, true); assert.equal(report.requiresPixelValidation, false); assert.equal(report.revision, doc.revision);
  assert.ok(report.warnings.some((warning) => warning.code === 'PROTECTION_NOT_PORTABLE' && warning.layerName === 'Preserved 🌿 Ω'));
  const output = await native.exportPsd({ documentId: doc.id, expectedRevision: doc.revision });
  const expectedInput = { width: doc.width, height: doc.height, iccProfile: profile, composite: await native.renderGraph(doc), layers: [] };
  for (const layer of doc.layers) expectedInput.layers.push({ id: layer.id, name: layer.name, visible: layer.visible, opacity: layer.opacity, pixels: await native.renderLayer(layer), ...(layer.mask ? { mask: maskBytes } : {}) });
  verifyBytes(output.data, expectedInput);
  assert.deepEqual(await fs.readFile(file), bytes); assert.deepEqual(native.previewCache.stats(), cache);
  assert.deepEqual(await fs.readdir(native.assetsDir), assets);
  assert.deepEqual(await fs.readFile(path.join(native.assetsDir, source.layers[0].sourceAsset)), original);
  assert.deepEqual((await native.execute('get_document', { documentId: doc.id })).document, doc);
  await assert.rejects(native.exportPsd({ documentId: doc.id, expectedRevision: doc.revision - 1 }), { code: 'REVISION_CONFLICT' });
});

test('native compatibility identifies fractional masks and groups without publishing or flattening them', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-psd-reject-audit-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const native = await new NativeBackend({ dataDir }).init();
  let doc = (await native.execute('create_document', { width: 12, height: 10 })).document;
  const id = doc.layers[0].id;
  doc = (await native.execute('set_layer_mask', { documentId: doc.id, expectedRevision: doc.revision, layerId: id, mask: { shape: 'ellipse', x: 1, y: 1, width: 9, height: 7, feather: 1.2 } })).document;
  const before = await fs.readFile(path.join(native.projectsDir, `${doc.id}.json`));
  const report = await native.inspectPsdExport({ documentId: doc.id, expectedRevision: doc.revision });
  assert.equal(report.supported, false); assert.ok(report.issues.some((issue) => issue.code === 'MASK_NOT_REPRESENTABLE' && issue.layerId === id));
  await assert.rejects(native.exportPsd({ documentId: doc.id, expectedRevision: doc.revision }), (cause) => cause.code === 'PSD_UNSUPPORTED' && cause.report.issues.some((issue) => issue.code === 'MASK_NOT_REPRESENTABLE'));
  assert.deepEqual(await fs.readFile(path.join(native.projectsDir, `${doc.id}.json`)), before);
  doc = (await native.execute('group_layers', { documentId: doc.id, expectedRevision: doc.revision, layerIds: [id] })).document;
  const originalRender = native.renderGraph; let rendered = false;
  native.renderGraph = async () => { rendered = true; throw new Error('Metadata rejection must precede rendering'); };
  try {
    const grouped = await native.inspectPsdExport({ documentId: doc.id, expectedRevision: doc.revision });
    assert.equal(grouped.supported, false); assert.ok(grouped.issues.some((issue) => issue.code === 'GROUPS_UNSUPPORTED'));
    await assert.rejects(native.exportPsd({ documentId: doc.id }), { code: 'PSD_UNSUPPORTED' });
    assert.equal(rendered, false);
  } finally { native.renderGraph = originalRender; }
  assert.deepEqual((await native.execute('get_document', { documentId: doc.id })).document, doc);
});
