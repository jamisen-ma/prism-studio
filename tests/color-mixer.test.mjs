import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { normalizeParameters, adjustmentTransform, ADJUSTMENTS } from '../server/color.mjs';
import { applyLayerFilters, filterWork, MAX_FILTER_WORK } from '../server/layer-filters.mjs';

const coded = code => cause => cause.code === code;
const transform = (kind, parameters) => adjustmentTransform({ kind, value: 0, parameters });
const edit = async (native, doc, command, args = {}) => (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document;
const get = async (native, doc) => (await native.execute('get_document', { documentId: doc.id })).document;
const render = (native, doc) => native.render(native.project(doc.id));
const gray = [0, 0, 0, 0], swap = { red: [0, 0, 100, 0], blue: [100, 0, 0, 0] };
const rgba = Buffer.from([10, 30, 200, 255, 60, 120, 240, 128, 1, 20, 90, 1, 50, 110, 180, 0, 255, 0, 80, 255, 0, 177, 68, 255, 0, 204, 36, 255, 100, 130, 190, 200]);
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-color-mixer-'));
  const native = await new NativeBackend({ dataDir }).init(); t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const original = await sharp(rgba, { raw: { width: 4, height: 2, channels: 4 } }).png().toBuffer();
  const document = (await native.execute('import_image', { data: original.toString('base64'), mimeType: 'image/png', name: 'Color fixture' })).document;
  return { native, document, dataDir, original };
}
const entry = (kind, parameters, options = {}) => ({ id: randomUUID(), kind, value: 0, enabled: true, opacity: 1, parameters: normalizeParameters(kind, parameters), ...options });
function exactRow(pixel, row) {
  const units = row.map(value => BigInt(Math.round(value * 100)));
  const numerator = BigInt(pixel[0]) * units[0] + BigInt(pixel[1]) * units[1] + BigInt(pixel[2]) * units[2] + 255n * units[3];
  return numerator <= 0n ? 0 : numerator >= 2550000n ? 255 : Number((2n * numerator + 10000n) / 20000n);
}

test('canonical mixer percentages use exact integer full sums, identity, swaps and retained monochrome rows', () => {
  const identity = transform('channel_mixer'); assert.deepEqual(identity(15, 60, 199), [15, 60, 199]);
  assert.deepEqual(transform('channel_mixer', swap)(15, 60, 199), [199, 60, 15]);
  assert.deepEqual(transform('channel_mixer', { red: [200, -100, 0, 0] })(150, 100, 20), [200, 100, 20], 'negative contributions are summed before clamping');
  assert.deepEqual(transform('channel_mixer', { red: [-100, 0, 0, 100] })(50, 100, 200), [205, 100, 200]);
  const mono = normalizeParameters('channel_mixer', { ...swap, monochrome: true, gray: [0, 100, 0, 0] });
  assert.deepEqual(transform('channel_mixer', mono)(15, 60, 199), [60, 60, 60]);
  assert.deepEqual(transform('channel_mixer', { ...mono, monochrome: false })(15, 60, 199), [199, 60, 15]);
  let seed = 8017; const random = () => seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  for (let trial = 0; trial < 2000; trial++) {
    const rows = Array.from({ length: 3 }, () => Array.from({ length: 4 }, () => (random() % 40001 - 20000) / 100)), input = [random() % 256, random() % 256, random() % 256];
    assert.deepEqual(transform('channel_mixer', { red: rows[0], green: rows[1], blue: rows[2] })(...input), rows.map(row => exactRow(input, row)), `Exact mixer trial ${trial}`);
  }
  assert.deepEqual(transform('channel_mixer', { red: [0, 0, 0, 10] })(0, 0, 0), [26, 0, 0]);
});

test('normalization owns rows/stops, rejects sub-hundredth percentages and invalid parameter families', () => {
  const rows = { red: [99.99, 0.01, -100.01, 0] }, normalized = normalizeParameters('channel_mixer', rows);
  rows.red.fill(0); assert.deepEqual(normalized.red, [99.99, 0.01, -100.01, 0]);
  for (const parameters of [{ red: [1.001, 0, 0, 0] }, { red: [NaN, 0, 0, 0] }, { red: [Infinity, 0, 0, 0] }, { red: [201, 0, 0, 0] }, { red: [0, 0, 0] }, { red: Array(4) }, { monochrome: 1 }, { gamma: 1 }, { stops: [] }])
    assert.throws(() => normalizeParameters('channel_mixer', parameters), coded('INVALID_ARGUMENT'));
  const stops = [{ offset: 0, color: '#AABBCC' }, { offset: 1, color: '#DDEEFF' }], map = normalizeParameters('gradient_map', { stops });
  stops[0].color = '#000000'; assert.equal(map.stops[0].color, '#aabbcc');
  for (const parameters of [
    { stops: [{ offset: 0.1, color: '#000000' }, { offset: 1, color: '#ffffff' }] },
    { stops: [{ offset: 0, color: '#000000' }, { offset: 0, color: '#ffffff' }] },
    { stops: [{ offset: 0, color: '#000000', opacity: 1 }, { offset: 1, color: '#ffffff' }] },
    { stops: [{ offset: 0, color: '#000000' }, { offset: Infinity, color: '#ffffff' }] },
    { stops: Array(2) }, { reverse: 1 }, { dither: true }, { gray },
  ]) assert.throws(() => normalizeParameters('gradient_map', parameters), coded('INVALID_ARGUMENT'));
});

test('Gradient Map maps unquantized tones to unequal RGB stops, exact endpoints and reverse half ties', () => {
  assert.deepEqual(transform('gradient_map')(255, 0, 0), [54, 54, 54]);
  assert.deepEqual(transform('gradient_map')(0, 255, 0), [182, 182, 182]);
  assert.deepEqual(transform('gradient_map')(0, 0, 255), [18, 18, 18]);
  assert.deepEqual(transform('gradient_map', { reverse: true })(0, 177, 68), [124, 124, 124]);
  assert.deepEqual(transform('gradient_map', { reverse: true })(0, 204, 36), [107, 107, 107]);
  assert.deepEqual(transform('gradient_map', { stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#666666' }] })(0, 35, 190), [16, 16, 16]);
  assert.deepEqual(transform('gradient_map', { stops: [{ offset: 0, color: '#010101' }, { offset: 1, color: '#9a9a9a' }] })(0, 123, 132), [60, 60, 60]);
  const exactTone = 42598 / 2550000, closeSpacing = Number.EPSILON * exactTone;
  assert.notEqual(exactTone * 2550000, 42598, 'fixture exposes scaled-position rounding');
  assert.deepEqual(transform('gradient_map', { stops: [{ offset: 0, color: '#000000' }, { offset: exactTone - closeSpacing, color: '#ff0000' }, { offset: exactTone, color: '#abcdef' }, { offset: exactTone + closeSpacing, color: '#0000ff' }, { offset: 1, color: '#ffffff' }] })(0, 0, 59), [171, 205, 239]);
  const stops = [{ offset: 0, color: '#112233' }, { offset: 0.2, color: '#20a080' }, { offset: 0.8, color: '#f04488' }, { offset: 1, color: '#aabbcc' }];
  const mapped = transform('gradient_map', { stops });
  assert.deepEqual(mapped(0, 0, 0), [17, 34, 51]); assert.deepEqual(mapped(255, 255, 255), [170, 187, 204]);
  assert.deepEqual(mapped(51, 51, 51), [32, 160, 128]); assert.deepEqual(mapped(204, 204, 204), [240, 68, 136]);
  const narrow = [{ offset: 0, color: '#000000' }, { offset: 18.59 / 255, color: '#000000' }, { offset: 18.6 / 255, color: '#ffffff' }, { offset: 1, color: '#ffffff' }];
  assert.deepEqual(transform('gradient_map', { stops: narrow })(10, 20, 30), [153, 153, 153], 'tone 18.596 is not rounded to nineteen before sampling');
  const sixteen = Array.from({ length: 16 }, (_, i) => ({ offset: i / 15, color: `#${(i * 17).toString(16).padStart(2, '0').repeat(3)}` }));
  for (let channel = 0; channel < 256; channel++) assert.deepEqual(transform('gradient_map', { stops: sixteen })(channel, channel, channel), [channel, channel, channel]);
});

test('new filters preserve alpha/invisible RGB, identity/bypass and sequential ordering without mutating inputs', async () => {
  const original = Buffer.from(rgba);
  assert.deepEqual(await applyLayerFilters(rgba, 4, 2, [entry('channel_mixer')]), original);
  for (const kind of ['channel_mixer', 'gradient_map']) for (const options of [{ enabled: false }, { opacity: 0 }]) assert.deepEqual(await applyLayerFilters(rgba, 4, 2, [entry(kind, kind === 'channel_mixer' ? swap : undefined, options)]), original);
  const first = await applyLayerFilters(rgba, 4, 2, [entry('channel_mixer', swap), entry('gradient_map')]);
  const second = await applyLayerFilters(rgba, 4, 2, [entry('gradient_map'), entry('channel_mixer', swap)]);
  assert.notDeepEqual(first, second);
  for (let i = 0; i < rgba.length; i += 4) { assert.equal(first[i + 3], rgba[i + 3]); assert.equal(second[i + 3], rgba[i + 3]); if (!rgba[i + 3]) assert.deepEqual(first.subarray(i, i + 4), rgba.subarray(i, i + 4)); }
  assert.deepEqual(rgba, original);
});

test('global value-zero color adjustments preserve hidden RGB and yield while retaining mask/protection semantics', async t => {
  const { native, document: start } = await fixture(t);
  for (const kind of ['channel_mixer', 'gradient_map']) {
    const layer = { kind, value: 0, parameters: normalizeParameters(kind, kind === 'channel_mixer' ? swap : undefined), opacity: 1 };
    const out = await native.applyAdjustment(rgba, 4, 2, layer, Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0]));
    assert.deepEqual(out.subarray(0, 4), rgba.subarray(0, 4)); assert.deepEqual(out.subarray(12, 16), rgba.subarray(12, 16)); assert.notDeepEqual(out.subarray(4, 12), rgba.subarray(4, 12));
    for (let i = 3; i < out.length; i += 4) assert.equal(out[i], rgba[i]);
  }
  let doc = await edit(native, start, 'select_rectangle', { x: 1, y: 0, width: 2, height: 2 });
  const before = await render(native, doc);
  doc = await edit(native, doc, 'add_adjustment', { kind: 'channel_mixer', value: 0, parameters: swap });
  const after = await render(native, doc);
  for (let p = 0; p < 8; p++) {
    const i = p * 4, selected = p % 4 === 1 || p % 4 === 2;
    assert.deepEqual([...after.subarray(i, i + 4)], selected ? [before[i + 2], before[i + 1], before[i], before[i + 3]] : [...before.subarray(i, i + 4)]);
  }
  let yielded = false; setImmediate(() => { yielded = true; });
  await native.applyAdjustment(Buffer.alloc(32 * 4, 255), 1, 32, { kind: 'gradient_map', value: 0, opacity: 1 }, null);
  assert.ok(yielded);
});

test('partial parameter updates retain complete unrelated rows and stops; stable filter IDs and source files survive undo/reopen/bundles', async t => {
  const { native, document: start, dataDir, original } = await fixture(t); const layerId = start.layers[0].id;
  let doc = await edit(native, start, 'add_layer_filter', { layerId, kind: 'channel_mixer', value: 0, parameters: swap });
  const id = doc.layers[0].filters[0].id;
  doc = await edit(native, doc, 'update_layer_filter', { layerId, filterId: id, parameters: { monochrome: true, gray: [0, 100, 0, 0] } });
  assert.deepEqual(doc.layers[0].filters[0].parameters.red, swap.red); assert.equal(doc.layers[0].filters[0].id, id);
  doc = await edit(native, doc, 'update_layer_filter', { layerId, filterId: id, parameters: { monochrome: false } });
  doc = await edit(native, doc, 'add_layer_filter', { layerId, kind: 'gradient_map', value: 0, parameters: { stops: [{ offset: 0, color: '#112244' }, { offset: 1, color: '#ffbb55' }] } });
  const map = doc.layers[0].filters[1], savedStops = structuredClone(map.parameters.stops);
  doc = await edit(native, doc, 'update_layer_filter', { layerId, filterId: map.id, parameters: { reverse: true } });
  assert.deepEqual(doc.layers[0].filters[1].parameters.stops, savedStops); const pixels = await render(native, doc);
  doc = await edit(native, doc, 'undo'); assert.equal(doc.layers[0].filters[1].parameters.reverse, false);
  doc = await edit(native, doc, 'redo'); assert.deepEqual(await render(native, doc), pixels);
  const exported = await native.exportProject({ documentId: doc.id, expectedRevision: doc.revision }), imported = (await native.importProject({ data: exported.data })).document;
  assert.deepEqual(await render(native, imported), pixels); assert.deepEqual(imported.layers[0].filters, doc.layers[0].filters);
  const reopened = await new NativeBackend({ dataDir }).init(); assert.deepEqual(await render(reopened, doc), pixels);
  assert.deepEqual(await fs.readFile(path.join(native.assetsDir, doc.layers[0].sourceAsset)), original);
  const source = await native.execute('get_layer_preview', { documentId: doc.id, layerId, view: 'source' });
  assert.deepEqual(await sharp(Buffer.from(source.data, 'base64')).raw().toBuffer(), rgba);
});

test('invalid new-kind edits, precision, stale revision and storage failures preserve committed graph/files', async t => {
  const { native, document: start } = await fixture(t); const layerId = start.layers[0].id;
  let doc = await edit(native, start, 'add_adjustment', { kind: 'channel_mixer', value: 0 }); const adjustmentId = doc.layers.at(-1).id;
  doc = await edit(native, doc, 'update_adjustment', { layerId: adjustmentId, parameters: { red: swap.red } });
  assert.deepEqual(doc.layers.at(-1).parameters.green, [0, 100, 0, 0]);
  const before = await native.execute('get_preview', { documentId: doc.id }), file = await fs.readFile(path.join(native.projectsDir, `${doc.id}.json`)), assets = await fs.readdir(native.assetsDir);
  for (const [command, args] of [
    ['add_adjustment', { kind: 'gradient_map', value: 1 }], ['add_layer_filter', { layerId, kind: 'channel_mixer', value: -1 }],
    ['update_adjustment', { layerId: adjustmentId, parameters: { red: [0.001, 0, 0, 0] } }], ['update_adjustment', { layerId: adjustmentId, parameters: { reverse: true } }],
  ]) await assert.rejects(edit(native, doc, command, args), coded('INVALID_ARGUMENT'));
  await assert.rejects(edit(native, doc, 'update_adjustment', { expectedRevision: start.revision, layerId: adjustmentId, parameters: { monochrome: true } }), coded('REVISION_CONFLICT'));
  const persist = native.persist; native.persist = async () => { throw Object.assign(new Error('Injected full disk'), { code: 'ENOSPC' }); };
  await assert.rejects(edit(native, doc, 'update_adjustment', { layerId: adjustmentId, parameters: { monochrome: true } }), coded('ENOSPC')); native.persist = persist;
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await fs.readFile(path.join(native.projectsDir, `${doc.id}.json`)), file); assert.deepEqual(await fs.readdir(native.assetsDir), assets);
  assert.deepEqual(await native.execute('get_preview', { documentId: doc.id }), before);
});

test('color work is weighted before any rendering including hidden targets; counts, protection and legacy kinds remain compatible', async t => {
  assert.equal(filterWork(entry('channel_mixer'), 24_000_000), 72_000_000); assert.equal(filterWork(entry('gradient_map'), 24_000_000), 120_000_000);
  assert.equal(filterWork(entry('gradient_map', undefined, { enabled: false }), 24_000_000), 0);
  const { native, document } = await fixture(t), project = native.project(document.id), graph = structuredClone(project.states[project.cursor].graph);
  graph.width = 4000; graph.height = 6000; graph.layers[0].visible = false; graph.layers[0].transforms.push({ type: 'resize', width: 4000, height: 6000 });
  graph.layers[0].width = 4000; graph.layers[0].height = 6000; graph.layers[0].transforms = [];
  graph.layers[0].filters = Array.from({ length: 3 }, () => entry('gradient_map'));
  assert.ok(3 * 120_000_000 <= MAX_FILTER_WORK); assert.doesNotThrow(() => native.validateGraph(graph));
  graph.layers[0].filters.push(entry('channel_mixer')); assert.throws(() => native.validateGraph(graph), coded('LIMIT_EXCEEDED'));
  graph.layers[0].filters = [entry('channel_mixer')]; graph.layers[0].protected = true; assert.throws(() => native.validateGraph(graph), coded('PROTECTED_LAYER'));
  graph.layers[0].filters[0].enabled = false; assert.doesNotThrow(() => native.validateGraph(graph));
  const capabilities = await native.execute('capabilities'); assert.equal(capabilities.adjustmentKinds.length, 28); assert.equal(capabilities.layerFilterKinds.length, 32);
  assert.deepEqual(ADJUSTMENTS.channel_mixer, [0, 0]); assert.deepEqual(ADJUSTMENTS.gradient_map, [0, 0]);
  for (const kind of ['levels', 'curves']) for (let byte = 0; byte < 256; byte++) assert.deepEqual(transform(kind)(byte, 255 - byte, byte), [byte, 255 - byte, byte]);
});
