import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { ADJUSTMENTS, adjustmentTransform, normalizeParameters } from '../server/color.mjs';
import { applyLayerFilters, filterWork } from '../server/layer-filters.mjs';
import { NativeBackend } from '../server/native.mjs';
import { validateCommand, validateBackendOptions } from '../shared/commands.mjs';

const defaults = { monochrome: false, red: [100, 0, 0, 0], green: [0, 100, 0, 0], blue: [0, 0, 100, 0], gray: [21.26, 71.52, 7.22, 0] };
const transform = (kind, parameters) => adjustmentTransform({ kind, value: 0, parameters });
const filter = (kind, parameters, extra = {}) => ({ id: randomUUID(), kind, value: 0, parameters, enabled: true, opacity: 1, ...extra });
const roundFraction = (numerator, denominator) => numerator <= 0n ? 0 : numerator >= 255n * denominator ? 255 : Number((2n * numerator + denominator) / (2n * denominator));
function exactMixer(rgb, parameters = {}) {
  const p = { ...defaults, ...parameters };
  const row = coefficients => roundFraction([...rgb, 255].reduce((sum, byte, index) => sum + BigInt(byte) * BigInt(Math.round(coefficients[index] * 100)), 0n), 10000n);
  return p.monochrome ? Array(3).fill(row(p.gray)) : [row(p.red), row(p.green), row(p.blue)];
}
const rgb = color => [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16));
function exactDyadicGradient(input, parameters) {
  let numerator = BigInt(2126 * input[0] + 7152 * input[1] + 722 * input[2]);
  const denominator = 2550000n;
  if (parameters.reverse) numerator = denominator - numerator;
  const scaled = numerator * 16n;
  let right = 1;
  while (right < parameters.stops.length - 1 && BigInt(parameters.stops[right].offset * 16) * denominator < scaled) right++;
  const left = parameters.stops[right - 1], end = parameters.stops[right];
  const from = BigInt(left.offset * 16) * denominator, length = BigInt((end.offset - left.offset) * 16) * denominator;
  const amount = scaled - from, a = rgb(left.color), b = rgb(end.color);
  return a.map((color, index) => roundFraction(BigInt(color) * length + BigInt(b[index] - color) * amount, length));
}
let seed = 0x6176ca;
const random = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
const edit = async (native, doc, command, args = {}) => (await native.execute(command, validateCommand(command, { documentId: doc.id, expectedRevision: doc.revision, ...args }))).document;
const get = async (native, doc) => (await native.execute('get_document', { documentId: doc.id })).document;
const files = async directory => Object.fromEntries(await Promise.all((await fs.readdir(directory)).sort().map(async name => [name, await fs.readFile(path.join(directory, name))])));
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-color-audit-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return { dataDir, native: await new NativeBackend({ dataDir }).init() };
}
async function importPixels(native, pixels, width, height) {
  const data = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
  return (await native.execute('import_image', { data: data.toString('base64'), mimeType: 'image/png' })).document;
}
const pixelsAt = (pixels, p) => [...pixels.subarray(p * 4, p * 4 + 4)];

test('Channel Mixer uses one exact full integer sum per output row, including seeded negative/constant/monochrome ties', () => {
  const identity = transform('channel_mixer');
  for (let r = 0; r < 256; r++) assert.deepEqual(identity(r, 255 - r, r * 53 % 256), [r, 255 - r, r * 53 % 256]);
  assert.deepEqual(transform('channel_mixer', { red: [0, 100, 0, 0], green: [0, 0, 100, 0], blue: [100, 0, 0, 0] })(12, 80, 201), [80, 201, 12]);
  assert.deepEqual(transform('channel_mixer', { red: [200, -200, 100, 0] })(255, 255, 127), [127, 255, 127], 'clamp only after cancellation in the full sum');
  assert.equal(transform('channel_mixer', { red: [0.5, 0, 0, 0] })(100, 0, 0)[0], 1, 'exact positive half byte rounds upward');
  assert.deepEqual(transform('channel_mixer', { monochrome: true, gray: [-100, 0, 0, 100] })(12, 80, 201), [243, 243, 243]);
  for (let trial = 0; trial < 1600; trial++) {
    const parameters = { monochrome: trial % 3 === 0 };
    for (const channel of ['red', 'green', 'blue', 'gray']) parameters[channel] = Array.from({ length: 4 }, () => (random(40001) - 20000) / 100);
    const input = [random(256), random(256), random(256)];
    assert.deepEqual(transform('channel_mixer', parameters)(...input), exactMixer(input, parameters), `exact matrix fixture ${trial}`);
  }
});

test('Gradient Map preserves exact endpoints, close interior stops, reverse half-byte ties and nonuniform 16-stop interpolation', () => {
  for (const [input, expected] of [[[0, 177, 68], 124], [[0, 204, 36], 107], [[0, 232, 188], 76], [[1, 178, 69], 123]]) {
    assert.deepEqual(transform('gradient_map', { reverse: true })(...input), [expected, expected, expected]);
  }
  for (const [input, left, right, expected] of [[[0, 35, 190], '#000000', '#666666', 16], [[0, 123, 132], '#010101', '#9a9a9a', 60], [[0, 211, 74], '#666666', '#000000', 40], [[0, 211, 74], '#676767', '#010101', 41]]) {
    assert.deepEqual(transform('gradient_map', { stops: [{ offset: 0, color: left }, { offset: 1, color: right }] })(...input), [expected, expected, expected], 'nonzero/descending endpoint exact half byte');
  }
  const close = { stops: [{ offset: 0, color: '#000000' }, { offset: 0.21259, color: '#ff0000' }, { offset: 0.2126, color: '#123456' }, { offset: 0.21261, color: '#0000ff' }, { offset: 1, color: '#ffffff' }] };
  assert.deepEqual(transform('gradient_map', close)(255, 0, 0), [18, 52, 86], 'tone must not be quantized through a byte lookup');
  assert.deepEqual(transform('gradient_map', close)(0, 0, 0), [0, 0, 0]);
  assert.deepEqual(transform('gradient_map', close)(255, 255, 255), [255, 255, 255]);
  const adjacent = { stops: [{ offset: 0, color: '#000000' }, { offset: 0.0008494117647058823, color: '#ff0000' }, { offset: 0.0008494117647058824, color: '#00ff00' }, { offset: 1, color: '#ffffff' }] };
  assert.equal(adjacent.stops[1].offset * 2550000, adjacent.stops[2].offset * 2550000, 'fixture positions collapse only after scaling');
  assert.deepEqual(transform('gradient_map', adjacent)(0, 0, 3), [0, 255, 0], 'an exact authored stop must survive scaled-position collision');
  const positions = [0, 1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
  const stops = positions.map((position, index) => ({ offset: position / 16, color: '#' + [index * 17, index * 43 % 256, 255 - index * 17].map(channel => channel.toString(16).padStart(2, '0')).join('') }));
  for (const reverse of [false, true]) {
    const parameters = { stops, reverse }, actual = transform('gradient_map', parameters);
    for (let trial = 0; trial < 640; trial++) {
      const input = [random(256), random(256), random(256)];
      assert.deepEqual(actual(...input), exactDyadicGradient(input, parameters), `exact gradient fixture ${reverse}:${trial}`);
    }
  }
});

test('normalization owns canonical rows/stops and both command schemas reject wrong families and finer percentages', () => {
  const input = { red: [21.26, 71.52, 7.22, 0] }, p = normalizeParameters('channel_mixer', input);
  p.red[0] = 0; assert.equal(input.red[0], 21.26);
  input.red[1] = 0; assert.equal(p.red[1], 71.52);
  assert.deepEqual(normalizeParameters('channel_mixer'), defaults);
  const stops = [{ offset: 0, color: '#ABCDEF' }, { offset: 1, color: '#123456' }], mapped = normalizeParameters('gradient_map', { stops });
  assert.equal(mapped.stops[0].color, '#abcdef'); mapped.stops[0].offset = 0.1; assert.equal(stops[0].offset, 0);
  const invalid = [
    ['channel_mixer', { red: [1, 2, 3] }], ['channel_mixer', { red: [200.01, 0, 0, 0] }], ['channel_mixer', { red: [0.001, 0, 0, 0] }],
    ['channel_mixer', { gray: Array(4) }], ['channel_mixer', { red: [NaN, 0, 0, 0] }], ['channel_mixer', { monochrome: 1 }], ['channel_mixer', { reverse: false }],
    ['gradient_map', { monochrome: false }], ['gradient_map', { reverse: 'yes' }], ['gradient_map', { stops: [{ offset: 0, color: '#fff' }, { offset: 1, color: '#ffffff' }] }],
    ['gradient_map', { stops: [{ offset: 0, color: '#000000', opacity: 1 }, { offset: 1, color: '#ffffff' }] }],
    ['gradient_map', { stops: [{ offset: 0.1, color: '#000000' }, { offset: 1, color: '#ffffff' }] }],
    ['gradient_map', { stops: [{ offset: 0, color: '#000000' }, { offset: 0, color: '#ffffff' }, { offset: 1, color: '#ffffff' }] }],
    ['gradient_map', { stops: Array.from({ length: 17 }, (_, i) => ({ offset: i / 16, color: '#000000' })) }],
    ['gradient_map', { stops: [{ offset: 0, color: '#000000' }, { offset: Infinity, color: '#ffffff' }] }],
  ];
  for (const [kind, parameters] of invalid) {
    assert.throws(() => normalizeParameters(kind, parameters), { code: 'INVALID_ARGUMENT' });
    for (const command of ['add_adjustment', 'add_layer_filter']) assert.throws(() => validateCommand(command, { documentId: 'fixture', ...(command === 'add_layer_filter' ? { layerId: 'layer' } : {}), kind, value: 0, parameters }), { code: 'INVALID_ARGUMENTS' });
  }
  for (const kind of ['channel_mixer', 'gradient_map']) {
    assert.equal(validateCommand('add_adjustment', { documentId: 'fixture', kind, value: 0, parameters: {} }).value, 0);
    assert.throws(() => validateCommand('add_adjustment', { documentId: 'fixture', kind, value: 1 }), { code: 'INVALID_ARGUMENTS' });
    assert.throws(() => validateBackendOptions('photoshop', 'add_adjustment', { kind, value: 0 }), { code: 'UNSUPPORTED_COMMAND' });
  }
});

test('new zero-value adjustments and source filters preserve alpha and invisible RGB through partial opacity and masks', async t => {
  const { native } = await fixture(t), input = Buffer.from([217, 23, 51, 0, 0, 177, 68, 1, 83, 39, 201, 128, 193, 41, 17, 255]);
  const original = Buffer.from(input), mixer = { red: [0, 100, 0, 0], green: [0, 0, 100, 0], blue: [100, 0, 0, 0] };
  const entries = [filter('channel_mixer', mixer, { opacity: 0.5 }), filter('gradient_map', { reverse: true }, { opacity: 0.25 })];
  const expected = Buffer.from(input);
  for (const entry of entries) for (let p = 0; p < 4; p++) if (expected[p * 4 + 3]) {
    const source = pixelsAt(expected, p).slice(0, 3), result = entry.kind === 'channel_mixer' ? exactMixer(source, mixer) : exactDyadicGradient(source, { reverse: true, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] });
    result.forEach((value, c) => { expected[p * 4 + c] = Math.round(source[c] + (value - source[c]) * entry.opacity); });
  }
  assert.deepEqual(await applyLayerFilters(input, 4, 1, entries), expected);
  assert.deepEqual(await applyLayerFilters(input, 4, 1, entries.map(entry => ({ ...entry, enabled: false }))), input);
  assert.deepEqual(await applyLayerFilters(input, 4, 1, entries.map(entry => ({ ...entry, opacity: 0 }))), input);
  for (const [kind, parameters] of [['channel_mixer', mixer], ['gradient_map', { reverse: true }]]) {
    const mask = { shape: 'bitmap', x: 0, y: 0, width: 4, height: 1, feather: 0, invert: false, runs: [0, 1, 255, 1, 1, 128, 3, 1, 255] };
    const result = await native.applyAdjustment(input, 4, 1, { kind, value: 0, parameters, opacity: 0.5, mask }, Uint8Array.from([0, 0, 0, 1]));
    assert.deepEqual(result.subarray(0, 4), input.subarray(0, 4), 'invisible RGB retained');
    assert.deepEqual(result.subarray(8), input.subarray(8), 'zero mask and protected pixel retained');
    const source = pixelsAt(input, 1).slice(0, 3), changed = kind === 'channel_mixer' ? exactMixer(source, mixer) : [124, 124, 124];
    assert.deepEqual(pixelsAt(result, 1), [...changed.map((value, c) => Math.round(source[c] + (value - source[c]) * 0.5 * 128 / 255)), 1]);
  }
  assert.deepEqual(input, original);
});

test('existing native APIs capture adjustment selection, ignore it for filters, preserve partial updates and roundtrip editable parameters', async t => {
  const { native, dataDir } = await fixture(t), width = 8, height = 6, input = Buffer.from(Array.from({ length: width * height }, (_, p) => [p * 23 % 256, p * 41 % 256, p * 71 % 256, [0, 1, 128, 255][p % 4]]).flat());
  let doc = await importPixels(native, input, width, height); const layerId = doc.layers[0].id, sourceAssets = await files(native.assetsDir);
  doc = await edit(native, doc, 'select_region', { shape: 'rectangle', x: 2, y: 1, width: 3, height: 3 });
  const selection = structuredClone(doc.selection), baseline = await native.renderGraph(doc);
  doc = await edit(native, doc, 'add_adjustment', { kind: 'channel_mixer', value: 0, parameters: { red: [0, 100, 0, 0] } });
  const adjustmentId = doc.layers.at(-1).id; assert.deepEqual(doc.layers.at(-1).mask, selection);
  const adjusted = await native.renderGraph(doc);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = y * width + x;
    if (x < 2 || x >= 5 || y < 1 || y >= 4 || !baseline[p * 4 + 3]) assert.deepEqual(pixelsAt(adjusted, p), pixelsAt(baseline, p));
    else assert.deepEqual(pixelsAt(adjusted, p), [baseline[p * 4 + 1], baseline[p * 4 + 1], baseline[p * 4 + 2], baseline[p * 4 + 3]]);
  }
  const prior = structuredClone(doc.layers.at(-1).parameters);
  doc = await edit(native, doc, 'update_adjustment', { layerId: adjustmentId, parameters: { monochrome: true, gray: [0, 0, 100, 0] } });
  assert.deepEqual(doc.layers.at(-1).parameters.red, prior.red);
  doc = await edit(native, doc, 'update_adjustment', { layerId: adjustmentId, parameters: { monochrome: false } });
  assert.deepEqual(doc.layers.at(-1).parameters.gray, [0, 0, 100, 0]);
  doc = await edit(native, doc, 'delete_layer', { layerId: adjustmentId });
  doc = await edit(native, doc, 'add_layer_filter', { layerId, kind: 'gradient_map', value: 0 });
  const filterId = doc.layers[0].filters[0].id;
  doc = await edit(native, doc, 'update_layer_filter', { layerId, filterId, parameters: { reverse: true } });
  const stops = structuredClone(doc.layers[0].filters[0].parameters.stops);
  assert.deepEqual(stops, [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }]);
  const actual = await native.renderLayer(doc.layers[0]);
  for (let p = 0; p < width * height; p++) {
    const expected = input[p * 4 + 3] ? exactDyadicGradient(pixelsAt(input, p).slice(0, 3), { stops, reverse: true }) : pixelsAt(input, p).slice(0, 3);
    assert.deepEqual(pixelsAt(actual, p), [...expected, input[p * 4 + 3]], 'filter is source-wide even outside selection');
  }
  doc = await edit(native, doc, 'update_layer_filter', { layerId, filterId, parameters: {} });
  assert.equal(doc.layers[0].filters[0].id, filterId); assert.equal(doc.layers[0].filters[0].parameters.reverse, true);
  const filtered = await native.renderGraph(doc);
  doc = await edit(native, doc, 'update_layer_filter', { layerId, filterId, enabled: false }); assert.deepEqual(await native.renderGraph(doc), baseline);
  doc = await edit(native, doc, 'undo'); assert.deepEqual(await native.renderGraph(doc), filtered);
  const imported = (await native.importProject({ data: (await native.exportProject({ documentId: doc.id })).data })).document;
  assert.deepEqual(imported.layers, doc.layers); assert.deepEqual(await native.renderGraph(imported), filtered);
  const reopened = await new NativeBackend({ dataDir }).init(); assert.deepEqual(reopened.loadWarnings, []); assert.deepEqual(await reopened.renderGraph(await get(reopened, doc)), filtered);
  assert.deepEqual(await files(native.assetsDir), sourceAssets);
  const sourceView = await native.execute('get_layer_preview', { documentId: doc.id, layerId, view: 'source', maxWidth: 32 });
  assert.deepEqual(await sharp(Buffer.from(sourceView.data, 'base64')).ensureAlpha().raw().toBuffer(), input);
});

test('new color mappings honor original protected footprints inside isolated clipping chains and preserve unfiltered source inspection', async t => {
  const { native } = await fixture(t), width = 9, height = 7, count = width * height;
  const raw = [
    Buffer.from(Array.from({ length: count }, (_, p) => [37, 117, 209, p % width >= 3 && p % width <= 5 ? [1, 128, 255][p % 3] : 0]).flat()),
    Buffer.from(Array.from({ length: count }, (_, p) => [113, 47, 83, [1, 128, 255][p % 3]]).flat()),
    Buffer.from(Array.from({ length: count }, (_, p) => [29, 157, 71, [128, 255][p % 2]]).flat()),
  ];
  const originals = await Promise.all(raw.map(bytes => importPixels(native, bytes, width, height)));
  const person = { ...originals[0].layers[0], protected: true, outline: { width: 1, color: '#ffffff' } };
  const group = { id: randomUUID(), name: 'Isolated protected context', type: 'group', mode: 'isolated', visible: true, opacity: 1, blendMode: 'normal' };
  const base = { ...originals[1].layers[0], parentId: group.id };
  const member = { ...originals[2].layers[0], parentId: group.id, clipBaseId: base.id, role: 'generated', provenance: { jobId: randomUUID(), mode: 'generate' }, visible: false };
  let doc = (await native.newProject({ name: 'Color clipping protection', width, height, selection: null, layers: [person, group, base, member] }, 'Independent fixture')).document;
  const baseline = await native.renderGraph(doc), assets = await files(native.assetsDir), footprint = await native.protectedPixels(doc);
  const swap = { red: [0, 100, 0, 0], green: [0, 0, 100, 0], blue: [100, 0, 0, 0] };
  doc = await edit(native, doc, 'add_layer_filter', { layerId: base.id, kind: 'channel_mixer', value: 0, parameters: swap });
  doc = await edit(native, doc, 'add_layer_filter', { layerId: member.id, kind: 'gradient_map', value: 0, parameters: { reverse: true } });
  doc = await edit(native, doc, 'set_layer', { layerId: member.id, visible: true });
  for (const [kind, parameters] of [['channel_mixer', { monochrome: true }], ['gradient_map', { stops: [{ offset: 0, color: '#cc8844' }, { offset: 1, color: '#2233cc' }] }]]) {
    doc = await edit(native, doc, 'add_adjustment', { kind, value: 0, parameters });
    doc = await edit(native, doc, 'move_layer', { layerId: doc.layers.at(-1).id, parentId: group.id });
  }
  const actual = await native.renderGraph(doc);
  const preview = async (layerId, view = 'layer') => {
    const result = await native.execute('get_layer_preview', { documentId: doc.id, layerId, view, maxWidth: 32 });
    return sharp(Buffer.from(result.data, 'base64')).ensureAlpha().raw().toBuffer();
  };
  const baseView = await preview(base.id), memberView = await preview(member.id);
  let outsideChanged = 0;
  for (let p = 0; p < count; p++) if (footprint[p]) {
    assert.deepEqual(pixelsAt(actual, p), pixelsAt(baseline, p), `protected source or outline pixel ${p}`);
    assert.equal(memberView[p * 4 + 3], 0, 'isolated generated member contribution excludes original footprint');
    assert.deepEqual(pixelsAt(baseView, p), pixelsAt(raw[1], p), 'base inspection restores its unfiltered source under original protection');
  } else if (!actual.subarray(p * 4, p * 4 + 4).equals(baseline.subarray(p * 4, p * 4 + 4))) outsideChanged++;
  assert.ok(outsideChanged > 0); assert.deepEqual(await preview(member.id, 'source'), raw[2]);
  let sampled;
  native.segmentSubject = async image => { sampled = await sharp(image).ensureAlpha().raw().toBuffer(); return { width, height, alpha: Buffer.alloc(count, 255), model: 'independent-fixture' }; };
  doc = await edit(native, doc, 'select_subject', { layerId: member.id }); assert.deepEqual(sampled, raw[2]);
  assert.deepEqual(await files(native.assetsDir), assets);
  await assert.rejects(edit(native, doc, 'add_layer_filter', { layerId: person.id, kind: 'channel_mixer', value: 0 }), { code: 'PROTECTED_LAYER' });
  // Identity parameters still represent an active stack entry; protection is
  // explicit rather than dependent on inspecting the transform's mathematics.
  const independent = originals[1];
  const identity = await edit(native, independent, 'add_layer_filter', { layerId: independent.layers[0].id, kind: 'channel_mixer', value: 0 });
  await assert.rejects(edit(native, identity, 'set_layer_protection', { layerId: identity.layers[0].id, protected: true }), { code: 'PROTECTED_LAYER' });
});

test('invalid native parameter updates and real storage failure retain revision, history, pixels, cache and source assets', async t => {
  const { native } = await fixture(t), input = Buffer.from(Array.from({ length: 16 }, (_, p) => [13 + p, 81, 199 - p, 255]).flat());
  let doc = await importPixels(native, input, 4, 4); const layerId = doc.layers[0].id;
  doc = await edit(native, doc, 'add_layer_filter', { layerId, kind: 'channel_mixer', value: 0 }); const filterId = doc.layers[0].filters[0].id;
  doc = await edit(native, doc, 'add_adjustment', { kind: 'gradient_map', value: 0 }); const adjustmentId = doc.layers.at(-1).id;
  const preview = await native.execute('get_preview', { documentId: doc.id }), cache = native.previewCache.stats(), sourceFiles = await files(native.assetsDir), projectFiles = await files(native.projectsDir);
  for (const [command, args] of [
    ['update_layer_filter', { layerId, filterId, parameters: { reverse: true } }], ['update_layer_filter', { layerId, filterId, value: 1 }],
    ['update_adjustment', { layerId: adjustmentId, parameters: { monochrome: true } }], ['update_adjustment', { layerId: adjustmentId, value: 1 }],
    ['update_layer_filter', { layerId, filterId, parameters: { red: [0.001, 0, 0, 0] } }],
    ['apply_transaction', { operations: [{ command: 'update_layer_filter', args: { layerId, filterId, parameters: { red: [0, 100, 0, 0] } } }, { command: 'update_adjustment', args: { layerId: adjustmentId, parameters: { red: [100, 0, 0, 0] } } }] }],
  ]) await assert.rejects(native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args }));
  await assert.rejects(native.execute('update_layer_filter', { documentId: doc.id, expectedRevision: doc.revision - 1, layerId, filterId, parameters: { monochrome: true } }), { code: 'REVISION_CONFLICT' });
  const directory = native.projectsDir; native.projectsDir = path.join(directory, `${doc.id}.json`);
  try { await assert.rejects(edit(native, doc, 'update_adjustment', { layerId: adjustmentId, parameters: { reverse: true } })); } finally { native.projectsDir = directory; }
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(native.previewCache.stats(), cache);
  assert.deepEqual(await files(native.assetsDir), sourceFiles); assert.deepEqual(await files(native.projectsDir), projectFiles);
  assert.deepEqual(await native.execute('get_preview', { documentId: doc.id }), preview);
});

test('malformed color parameters in canonical portable bundles reject before images or projects are touched', async t => {
  const { native: source } = await fixture(t), { native: target } = await fixture(t);
  let doc = await importPixels(source, Buffer.alloc(4 * 4 * 4, 255), 4, 4); const layerId = doc.layers[0].id;
  doc = await edit(source, doc, 'add_layer_filter', { layerId, kind: 'channel_mixer', value: 0 });
  doc = await edit(source, doc, 'add_adjustment', { kind: 'gradient_map', value: 0 });
  const valid = (await source.exportProject({ documentId: doc.id })).data, length = valid.readUInt32BE(8), manifest = JSON.parse(valid.subarray(12, 12 + length));
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const invalid = [
    layers => { layers[0].filters[0].parameters.red = [0.001, 0, 0, 0]; }, layers => { layers[0].filters[0].parameters.red = [201, 0, 0, 0]; },
    layers => { layers[0].filters[0].parameters.red = [1, 2, 3]; }, layers => { layers[0].filters[0].parameters.reverse = true; },
    layers => { layers[1].parameters.stops[0].offset = 0.01; }, layers => { layers[1].parameters.stops[0].opacity = 1; },
    layers => { layers[1].parameters.reverse = 'true'; }, layers => { layers[1].value = 1; },
  ];
  let touched = 0; target.validateProjectAsset = target.storeAsset = async () => { touched++; assert.fail('Invalid color metadata reached an image operation'); };
  for (const mutate of invalid) {
    const modified = structuredClone(manifest); mutate(modified.graph.layers);
    const body = Buffer.from(JSON.stringify(canonical(modified))), prefix = Buffer.from(valid.subarray(0, 12)); prefix.writeUInt32BE(body.length, 8);
    await assert.rejects(target.importProject({ data: Buffer.concat([prefix, body, valid.subarray(12 + length)]) }), { code: 'INVALID_PROJECT_BUNDLE' });
  }
  assert.equal(touched, 0); assert.equal(target.projects.size, 0); assert.deepEqual(await files(target.assetsDir), {}); assert.deepEqual(await files(target.projectsDir), {});
});

test('new kinds advertise exact capabilities and charge hidden source work before allocating pixel surfaces', async t => {
  const { native } = await fixture(t), caps = await native.execute('capabilities');
  assert.equal(Object.keys(ADJUSTMENTS).length, 28); assert.equal(caps.adjustmentKinds.length, 28); assert.equal(caps.layerFilterKinds.length, 32);
  for (const kind of ['channel_mixer', 'gradient_map']) assert.ok(caps.adjustmentKinds.includes(kind) && caps.layerFilterKinds.includes(kind));
  assert.equal(filterWork(filter('channel_mixer'), 24_000_000), 72_000_000); assert.equal(filterWork(filter('gradient_map'), 24_000_000), 120_000_000);
  const graph = (kind, count) => ({ name: 'Hidden accounting fixture', width: 6000, height: 4000, selection: null, layers: [{ id: randomUUID(), name: 'Hidden source', type: 'raster', visible: false, opacity: 1, blendMode: 'normal',
    width: 6000, height: 4000, transforms: [], asset: 'a'.repeat(64), sourceAsset: 'a'.repeat(64), sourceFormat: 'png', filters: Array.from({ length: count }, () => filter(kind)) }] });
  assert.doesNotThrow(() => native.validateGraph(graph('channel_mixer', 5))); // 360 million weighted pixels.
  assert.throws(() => native.validateGraph(graph('channel_mixer', 6)), { code: 'LIMIT_EXCEEDED' });
  assert.doesNotThrow(() => native.validateGraph(graph('gradient_map', 3))); // 360 million weighted pixels.
  const over = graph('gradient_map', 4); assert.throws(() => native.validateGraph(over), { code: 'LIMIT_EXCEEDED' });
  over.layers[0].filters[3].enabled = false; assert.doesNotThrow(() => native.validateGraph(over));
  over.layers[0].filters[3].enabled = true; over.layers[0].filters[3].opacity = 0; assert.doesNotThrow(() => native.validateGraph(over));
  assert.deepEqual(await files(native.assetsDir), {}); assert.deepEqual(await files(native.projectsDir), {});
});
