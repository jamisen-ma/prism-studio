import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { PSD_EXPORT_LIMITS, PSD_MIME_TYPE, preflightPsdExport, writePsdExport } from '../server/psd-export.mjs';

const icc = (await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } }).withIccProfile('srgb').png().toBuffer().then(bytes => sharp(bytes).metadata())).icc;
const metadata = (changes = {}) => ({ id: 'layer-1', type: 'raster', name: 'Pixels', visible: true, opacity: 1, blendMode: 'normal', ...changes });
const rgba = (width, height, alpha = 255) => Buffer.from(Array.from({ length: width * height }, (_, i) => [(i * 37 + 11) % 256, (i * 61 + 23) % 256, (i * 17 + 71) % 256, typeof alpha === 'function' ? alpha(i) : alpha]).flat());
const fixture = (width = 3, height = 2) => ({ width, height, layers: [{ id: 'layer-1', name: 'Pixels', visible: true, opacity: 1, pixels: rgba(width, height) }], composite: rgba(width, height), iccProfile: icc });

// A specification-oriented walker: bounds/lengths/channels are checked without
// importing any production decoder or using the writer's size calculations.
function inspect(bytes) {
  let at = 0;
  const ascii = size => { const value = bytes.toString('ascii', at, at + size); at += size; return value; };
  const u8 = () => bytes[at++];
  const u16 = () => { const n = bytes.readUInt16BE(at); at += 2; return n; };
  const i16 = () => { const n = bytes.readInt16BE(at); at += 2; return n; };
  const u32 = () => { const n = bytes.readUInt32BE(at); at += 4; return n; };
  assert.equal(ascii(4), '8BPS'); assert.equal(u16(), 1); at += 6;
  assert.equal(u16(), 3); const height = u32(), width = u32(); assert.equal(u16(), 8); assert.equal(u16(), 3);
  assert.equal(u32(), 0);
  const resourceEnd = u32() + at;
  assert.equal(ascii(4), '8BIM'); assert.equal(u16(), 1039); assert.equal(u16(), 0);
  const profileSize = u32(), profile = bytes.subarray(at, at + profileSize); at += profileSize + profileSize % 2;
  assert.equal(at, resourceEnd);
  const sectionEnd = u32() + at, infoLength = u32(), infoEnd = at + infoLength;
  assert.equal(infoLength % 2, 0); const count = i16(), layers = [];
  for (let i = 0; i < count; i++) {
    const bounds = [u32(), u32(), u32(), u32()], channelCount = u16(), channels = [];
    for (let c = 0; c < channelCount; c++) channels.push({ id: i16(), bytes: u32() });
    assert.equal(ascii(4), '8BIM'); assert.equal(ascii(4), 'norm');
    const opacity = u8(); assert.equal(u8(), 0); const flags = u8(); assert.equal(u8(), 0);
    const extraEnd = u32() + at, maskSize = u32(); let maskBounds;
    if (maskSize) { assert.equal(maskSize, 20); maskBounds = [u32(), u32(), u32(), u32()]; assert.equal(u8(), 0); assert.equal(u8(), 0); assert.equal(u16(), 0); }
    assert.equal(u32(), 0);
    const nameStart = at, nameSize = u8(); at += nameSize; at = nameStart + Math.ceil((1 + nameSize) / 4) * 4;
    assert.equal(ascii(4), '8BIM'); assert.equal(ascii(4), 'luni');
    const unicodeLength = u32(), units = u32(); assert.equal(unicodeLength, 4 + units * 2);
    let name = ''; for (let j = 0; j < units; j++) name += String.fromCharCode(u16());
    assert.equal(at, extraEnd); layers.push({ bounds, channels, opacity, visible: !(flags & 2), name, maskBounds });
  }
  for (const layer of layers) for (const channel of layer.channels) {
    assert.equal(channel.bytes, width * height + 2); assert.equal(u16(), 0);
    channel.data = Buffer.from(bytes.subarray(at, at + width * height)); at += width * height;
  }
  assert.ok(infoEnd - at === 0 || infoEnd - at === 1); at = infoEnd; assert.equal(u32(), 0); assert.equal(at, sectionEnd);
  assert.equal(u16(), 0); const merged = Buffer.alloc(width * height * 4, 255);
  for (let c = 0; c < 3; c++) for (let i = 0; i < width * height; i++) merged[i * 4 + c] = u8();
  assert.equal(at, bytes.length);
  return { width, height, profile, layers, merged };
}

test('raw PSD records preserve full RGBA, zero-alpha RGB, masks, visibility, opacity and Unicode', () => {
  const input = fixture(3, 3);
  input.layers[0] = { ...input.layers[0], name: '髪 🌿 α', visible: false, opacity: 127 / 255, pixels: rgba(3, 3, i => [0, 1, 128, 255][i % 4]), mask: Buffer.from([0, 1, 2, 127, 128, 254, 255, 19, 76]) };
  const copies = { pixels: Buffer.from(input.layers[0].pixels), mask: Buffer.from(input.layers[0].mask), composite: Buffer.from(input.composite), profile: Buffer.from(icc) };
  const result = writePsdExport(input), decoded = inspect(result.data), layer = decoded.layers[0];
  assert.equal(result.mimeType, PSD_MIME_TYPE); assert.equal(result.bytes, result.data.length);
  assert.equal(layer.name, input.layers[0].name); assert.equal(layer.visible, false); assert.equal(layer.opacity, 127);
  assert.deepEqual(layer.bounds, [0, 0, 3, 3]); assert.deepEqual(layer.maskBounds, layer.bounds);
  for (const [id, index] of [[-1, 3], [0, 0], [1, 1], [2, 2]]) assert.deepEqual(layer.channels.find(c => c.id === id).data, Buffer.from(input.layers[0].pixels.filter((_, i) => i % 4 === index)));
  assert.deepEqual(layer.channels.find(c => c.id === -2).data, copies.mask);
  assert.deepEqual(decoded.merged, copies.composite); assert.deepEqual(decoded.profile, copies.profile);
  assert.deepEqual(input.layers[0].pixels, copies.pixels); assert.deepEqual(input.layers[0].mask, copies.mask); assert.deepEqual(input.composite, copies.composite); assert.deepEqual(icc, copies.profile);
  input.layers[0].pixels.fill(0); input.composite.fill(0); assert.deepEqual(inspect(result.data).merged, copies.composite);
});

test('one-pixel and odd-axis files have exact raw row sizes and metadata estimates', () => {
  for (const [width, height] of [[1, 1], [1, 3], [1, 9], [3, 1], [3, 5], [8, 7]]) {
    const input = fixture(width, height);
    input.layers[0].name = width === 1 ? '🌻' : 'Odd';
    const report = preflightPsdExport({ width, height, layers: [metadata({ name: input.layers[0].name })] }, { iccProfileBytes: icc.length });
    const result = writePsdExport(input), decoded = inspect(result.data);
    assert.equal(report.supported, true); assert.equal(report.requiresPixelValidation, true); assert.equal(result.bytes, report.estimatedBytes);
    assert.deepEqual(decoded.merged, input.composite); assert.equal(decoded.width, width); assert.equal(decoded.height, height);
  }
});

test('layer records keep bottom-to-top ordering and hidden layers intact', () => {
  const input = fixture(1, 1);
  input.layers = [
    { id: 'bottom', name: 'Bottom blue', visible: true, opacity: 1, pixels: Buffer.from([0, 0, 255, 255]) },
    { id: 'middle', name: 'Hidden green', visible: false, opacity: 1, pixels: Buffer.from([0, 255, 0, 255]) },
    { id: 'top', name: 'Top red', visible: true, opacity: 1, pixels: Buffer.from([255, 0, 0, 255]) },
  ];
  input.composite = Buffer.from([255, 0, 0, 255]);
  const decoded = inspect(writePsdExport(input).data);
  assert.deepEqual(decoded.layers.map(l => l.name), input.layers.map(l => l.name));
  assert.deepEqual(decoded.layers.map(l => l.visible), [true, false, true]);
});

test('strict metadata compatibility rejects editable features without silently flattening them', () => {
  const cases = [
    [{ type: 'group' }, 'LAYER_TYPE_UNSUPPORTED'], [{ parentId: 'group' }, 'GROUPS_UNSUPPORTED'], [{ blendMode: 'multiply' }, 'BLEND_MODE_UNSUPPORTED'],
    [{ clipBaseId: 'base' }, 'CLIPPING_UNSUPPORTED'],
    [{ opacity: 0.5 }, 'OPACITY_NOT_REPRESENTABLE'], [{ filters: [{ enabled: false }] }, 'FILTER_STACK_UNSUPPORTED'], [{ effects: {} }, 'LAYER_EFFECTS_UNSUPPORTED'],
    [{ outline: { width: 1 } }, 'OUTLINE_UNSUPPORTED'], [{ role: 'generated' }, 'CONTEXTUAL_GENERATION_UNSUPPORTED'], [{ provenance: { jobId: 'job' } }, 'CONTEXTUAL_GENERATION_UNSUPPORTED'],
  ];
  for (const [change, code] of cases) { const report = preflightPsdExport({ width: 2, height: 2, layers: [metadata(change)] }); assert.equal(report.supported, false); assert.ok(report.issues.some(i => i.code === code)); }
  const supported = preflightPsdExport({ width: 2, height: 2, layers: [metadata({ type: 'solid', filters: [], outline: { width: 0 }, transforms: [{ type: 'resize' }], protected: true, mask: { shape: 'rectangle' } })] });
  assert.equal(supported.supported, true); assert.deepEqual(supported.warnings.map(i => i.code), ['NATIVE_METADATA_NOT_EMBEDDED', 'RECOMPOSITION_MAY_DIFFER', 'PROTECTION_NOT_PORTABLE', 'GEOMETRY_RASTERIZED', 'MASK_RASTERIZED', 'SOLID_RASTERIZED']);
});

test('all byte opacities are accepted and nonrepresentable opacity is rejected', () => {
  for (let value = 0; value <= 255; value++) assert.equal(preflightPsdExport({ width: 1, height: 1, layers: [metadata({ opacity: value / 255 })] }).supported, true);
  for (const value of [-1, 2, NaN, Infinity, 0.5, 0.25, 0.1]) assert.ok(preflightPsdExport({ width: 1, height: 1, layers: [metadata({ opacity: value })] }).issues.some(i => i.code === 'OPACITY_NOT_REPRESENTABLE'));
});

test('size and memory estimates reject unsafe jobs without allocating their pixel frames', () => {
  const large = preflightPsdExport({ width: 4096, height: 4096, layers: [metadata()] });
  assert.equal(large.supported, false); assert.ok(large.estimatedBytes > PSD_EXPORT_LIMITS.maxOutputBytes); assert.ok(large.issues.some(i => i.code === 'OUTPUT_LIMIT'));
  assert.ok(preflightPsdExport({ width: 8193, height: 1, layers: [metadata()] }).issues.some(i => i.code === 'DIMENSION_LIMIT'));
  assert.ok(preflightPsdExport({ width: 1, height: 1, layers: Array.from({ length: 65 }, (_, i) => metadata({ id: String(i) })) }).issues.some(i => i.code === 'LAYER_LIMIT'));
  const input = fixture(1, 1); assert.throws(() => writePsdExport({ ...input, width: 4096, height: 4096 }), { code: 'LIMIT_EXCEEDED' });
});

test('invalid inputs and transparent merged composites fail before writing and preserve caller bytes', () => {
  const input = fixture(), prior = Buffer.from(input.layers[0].pixels);
  assert.throws(() => writePsdExport({ ...input, layers: [{ ...input.layers[0], pixels: Buffer.alloc(1) }] }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => writePsdExport({ ...input, layers: [{ ...input.layers[0], mask: Buffer.alloc(1) }] }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => writePsdExport({ ...input, layers: [{ ...input.layers[0], blendMode: 'multiply' }] }), { code: 'INVALID_ARGUMENT' });
  const transparent = Buffer.from(input.composite); transparent[3] = 254;
  assert.throws(() => writePsdExport({ ...input, composite: transparent }), error => error.code === 'PSD_UNSUPPORTED' && error.report.issues[0].code === 'TRANSPARENT_COMPOSITE');
  for (const change of [profile => profile.writeUInt32BE(1, 0), profile => profile.write('CMYK', 16), profile => profile.writeUInt32BE(10000, 128), profile => profile.writeUInt32BE(1, 136)]) {
    const profile = Buffer.from(icc); change(profile);
    assert.throws(() => writePsdExport({ ...input, iccProfile: profile }), { code: 'INVALID_ARGUMENT' });
  }
  assert.deepEqual(input.layers[0].pixels, prior);
});

test('invalid names, duplicate identifiers and malformed metadata return actionable issues', () => {
  for (const name of ['', ' ', 'a\0b', '\ud800', 'a'.repeat(201)]) assert.ok(preflightPsdExport({ width: 1, height: 1, layers: [metadata({ name })] }).issues.some(i => i.code === 'INVALID_LAYER_NAME'));
  assert.ok(preflightPsdExport({ width: 1, height: 1, layers: [metadata(), metadata()] }).issues.some(i => i.code === 'INVALID_LAYER_ID'));
  assert.equal(preflightPsdExport(null).supported, false);
});
