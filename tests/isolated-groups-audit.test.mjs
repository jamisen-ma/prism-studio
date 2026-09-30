import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { layerTree, validateGroupResources } from '../server/groups.mjs';
import { validateLayerFilterResources } from '../server/layer-filters.mjs';

const edit = async (native, doc, command, args = {}) => (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document;
const get = async (native, doc) => (await native.execute('get_document', { documentId: doc.id })).document;
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-isolation-audit-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return { native: await new NativeBackend({ dataDir }).init(), dataDir };
}
const pixel = (bytes, index) => [...bytes.subarray(index * 4, index * 4 + 4)];
function over(back, front, amount = 1, mode = 'normal') {
  const a = front[3] / 255 * amount, b = back[3] / 255;
  if (!a) return [...back];
  const alpha = a + b * (1 - a);
  const colors = [0, 1, 2].map(c => {
    const d = back[c] / 255, s = front[c] / 255;
    const blended = mode === 'multiply' ? d * s : mode === 'screen' ? 1 - (1 - d) * (1 - s) : s;
    return Math.round(255 * (d * b * (1 - a) + s * a * (1 - b) + blended * a * b) / alpha);
  });
  return [...colors, Math.round(alpha * 255)];
}
function mix(before, after, amount) {
  if (amount === 0) return [...before];
  if (amount === 1) return [...after];
  const a = before[3] / 255, b = after[3] / 255, alpha = a * (1 - amount) + b * amount;
  return [...[0, 1, 2].map(c => alpha ? Math.round((before[c] * a * (1 - amount) + after[c] * b * amount) / alpha) : before[c]), Math.round(alpha * 255)];
}
function reference(nodes, index, background = [0, 0, 0, 0]) {
  let result = [...background];
  for (const node of nodes) {
    if (node.visible === false || node.opacity === 0) continue;
    const amount = (node.opacity ?? 1) * (node.mask?.[index] ?? 255) / 255;
    if (node.children) {
      result = node.mode === 'isolated' ? over(result, reference(node.children, index), amount, node.blendMode ?? 'normal')
        : mix(result, reference(node.children, index, result), amount);
    } else result = over(result, pixel(node.pixels, index), amount, node.blendMode ?? 'normal');
  }
  return result;
}
function bitmap(bytes, width, height) {
  return { shape: 'bitmap', x: 0, y: 0, width, height, feather: 0, invert: false, runs: bytes.flatMap((alpha, index) => alpha ? [index, 1, alpha] : []) };
}
async function nativeNodes(native, nodes, width, height, parentId) {
  const layers = [];
  for (const node of nodes) {
    const id = randomUUID(), common = { id, name: 'Independent fixture', visible: node.visible !== false, opacity: node.opacity ?? 1, blendMode: node.blendMode ?? 'normal',
      ...(parentId ? { parentId } : {}), ...(node.mask ? { mask: bitmap(node.mask, width, height) } : {}) };
    if (node.children) layers.push({ ...common, type: 'group', mode: node.mode ?? 'pass-through' }, ...await nativeNodes(native, node.children, width, height, id));
    else {
      const png = await sharp(node.pixels, { raw: { width, height, channels: 4 } }).png().toBuffer(), hash = await native.storeAsset(png);
      layers.push({ ...common, type: 'raster', asset: hash, sourceAsset: hash, sourceFormat: 'png', width, height, transforms: [] });
    }
  }
  return layers;
}

test('nested isolated/pass-through masks and normal/multiply/screen match an independent premultiplied pixel reference', async t => {
  const { native } = await fixture(t), width = 4, height = 3, count = width * height;
  const samples = Array.from({ length: 4 }, (_, layer) => {
    const bytes = Buffer.alloc(count * 4);
    for (let i = 0; i < count; i++) bytes.set([(i * 37 + layer * 53) % 256, (i * 61 + layer * 79) % 256, (i * 83 + layer * 29) % 256, [0, 1, 2, 64, 128, 254, 255][(i + layer) % 7]], i * 4);
    return bytes;
  });
  for (let trial = 0; trial < 36; trial++) {
    const modes = ['normal', 'multiply', 'screen'], outerMode = trial % 4 === 0 ? 'pass-through' : 'isolated', innerMode = trial % 2 ? 'isolated' : 'pass-through';
    const nodes = [{ pixels: samples[0] }, { mode: outerMode, blendMode: outerMode === 'isolated' ? modes[trial % 3] : 'normal', opacity: [1, 0.37, 0.71][trial % 3],
      mask: Array.from({ length: count }, (_, i) => [0, 1, 64, 128, 255][(i + trial) % 5]), children: [
        { pixels: samples[1], blendMode: modes[(trial + 1) % 3], opacity: 0.61 },
        { mode: innerMode, blendMode: innerMode === 'isolated' ? modes[(trial + 2) % 3] : 'normal', opacity: 0.83,
          mask: Array.from({ length: count }, (_, i) => [255, 128, 1][(i + trial) % 3]), children: [{ pixels: samples[2], opacity: 0.53 }, { pixels: samples[3], blendMode: modes[trial % 3], opacity: 0.47 }] },
      ] }];
    const graph = { name: 'Isolated reference', width, height, selection: null, layers: await nativeNodes(native, nodes, width, height) };
    native.validateGraph(graph);
    const expected = Buffer.from(Array.from({ length: count }, (_, i) => reference(nodes, i)).flat());
    assert.deepEqual(await native.renderGraph(graph), expected, `Reference mismatch in nested fixture ${trial}`);
  }
});

test('normal isolation has explicit RGBA8 rounding and refuses protected mode/context changes without disturbing published state', async t => {
  const { native, dataDir } = await fixture(t);
  const nodes = [{ pixels: Buffer.from([73, 118, 197, 1]) }, { mode: 'pass-through', children: [
    { pixels: Buffer.from([0, 255, 201, 1]) }, { pixels: Buffer.from([73, 201, 182, 1]) },
  ] }];
  const graph = { name: 'Alpha-one isolation', width: 1, height: 1, selection: null, layers: await nativeNodes(native, nodes, 1, 1) };
  let doc = (await native.newProject(graph, 'Independent rounding fixture')).document;
  const group = doc.layers[1].id, subject = doc.layers[3].id;
  assert.deepEqual([...await native.renderGraph(doc)], [48, 192, 193, 3]);
  doc = await edit(native, doc, 'set_group_compositing', { layerId: group, mode: 'isolated' });
  assert.deepEqual([...await native.renderGraph(doc)], [49, 192, 193, 3]);
  doc = await edit(native, doc, 'set_layer_protection', { layerId: subject, protected: true });
  doc = await edit(native, doc, 'create_group', { parentId: group, name: 'Same isolation context' }); const neutral = doc.layers.at(-1).id;
  doc = await edit(native, doc, 'move_layer', { layerId: subject, parentId: neutral });
  doc = await edit(native, doc, 'set_layer', { layerId: subject, visible: false });
  const file = path.join(dataDir, 'projects', `${doc.id}.json`), bytes = await fs.readFile(file);
  const preview = await native.execute('get_preview', { documentId: doc.id }), cache = native.previewCache.stats();
  for (const [command, args] of [
    ['set_group_compositing', { layerId: group, mode: 'pass-through' }],
    ['set_group_compositing', { layerId: neutral, mode: 'isolated' }],
    ['set_layer', { layerId: group, blendMode: 'multiply' }],
    ['move_layer', { layerId: subject, parentId: null }],
    ['move_layer', { layerId: neutral, parentId: null }],
  ]) await assert.rejects(edit(native, doc, command, args), { code: 'PROTECTED_LAYER' });
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await fs.readFile(file), bytes); assert.deepEqual(native.previewCache.stats(), cache);
  assert.deepEqual(await native.execute('get_preview', { documentId: doc.id }), preview);
  doc = await edit(native, doc, 'duplicate_layer', { layerId: group });
  const copied = doc.layers.find(layer => layer.name === 'Independent fixture copy'); assert.equal(copied.mode, 'isolated');
  const reopened = await new NativeBackend({ dataDir }).init(); assert.equal(reopened.loadWarnings.length, 0); assert.deepEqual(await get(reopened, doc), doc);
});

test('inherited outside protection excludes isolated generated pixels, filters, adjustment and decoration, with exact mask snapshots', async t => {
  const { native } = await fixture(t), width = 12, height = 8, raw = Buffer.alloc(width * height * 4);
  for (let y = 2; y < 6; y++) for (let x = 4; x < 8; x++) raw.set([27 + x, 133 + y, 219, [1, 128, 255][x % 3]], (y * width + x) * 4);
  const png = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
  let doc = (await native.execute('import_image', { data: png.toString('base64'), mimeType: 'image/png' })).document;
  const subject = doc.layers[0].id;
  const generatedData = await sharp({ create: { width, height, channels: 4, background: '#467153' } }).png().toBuffer();
  doc = (await native.installGeneratedImage({ documentId: doc.id, expectedRevision: doc.revision, data: generatedData, provenance: { jobId: randomUUID(), mode: 'generate' } })).document;
  const generated = doc.layers.at(-1).id;
  doc = await edit(native, doc, 'group_layers', { layerIds: [generated], name: 'Independent AI isolation' }); const group = doc.layers.find(layer => layer.type === 'group').id;
  doc = await edit(native, doc, 'set_group_compositing', { layerId: group, mode: 'isolated', blendMode: 'screen' });
  doc = await edit(native, doc, 'set_layer_protection', { layerId: subject, protected: true });
  const before = await native.renderGraph(doc), asset = await fs.readFile(path.join(native.assetsDir, doc.layers[0].sourceAsset));
  doc = await edit(native, doc, 'add_layer_filter', { layerId: generated, kind: 'invert', value: 100 });
  doc = await edit(native, doc, 'set_layer_effects', { layerId: generated, effects: { shadow: { blur: 2, x: 3, y: 0, opacity: 1 } } });
  doc = await edit(native, doc, 'add_adjustment', { kind: 'brightness', value: 70 }); const adjustment = doc.layers.at(-1).id;
  doc = await edit(native, doc, 'move_layer', { layerId: adjustment, parentId: group });
  const after = await native.renderGraph(doc), footprint = await native.protectedPixels(doc);
  for (let i = 0; i < footprint.length; i++) {
    assert.equal(footprint[i], raw[i * 4 + 3] ? 1 : 0);
    if (footprint[i]) assert.deepEqual(pixel(after, i), pixel(before, i));
  }
  const snapshot = await native.snapshotForGeneration({ documentId: doc.id, expectedRevision: doc.revision, scope: 'canvas' });
  const mask = await sharp(snapshot.mask).ensureAlpha().raw().toBuffer();
  for (let i = 0; i < footprint.length; i++) assert.equal(mask[i * 4 + 3], footprint[i] ? 255 : 0);
  assert.deepEqual(await fs.readFile(path.join(native.assetsDir, doc.layers[0].sourceAsset)), asset);
  await assert.rejects(edit(native, doc, 'align_layers', { layerIds: [generated], axis: 'horizontal', alignment: 'center', relativeTo: 'canvas' }), { code: 'INVALID_TARGET' });
});

test('hidden isolated groups consume five retained bytes per pixel and share their exact budget with layer filters', async t => {
  const { native } = await fixture(t), width = 4000, height = 4000;
  const groups = Array.from({ length: 4 }, () => ({ id: randomUUID(), name: 'Hidden isolation', type: 'group', mode: 'isolated', visible: false, opacity: 1, blendMode: 'normal' }));
  for (let i = 1; i < groups.length; i++) groups[i].parentId = groups[i - 1].id;
  assert.doesNotThrow(() => validateGroupResources(layerTree(groups.slice(0, 3)), width, height)); // 240,000,000 retained bytes.
  assert.throws(() => validateGroupResources(layerTree(groups), width, height), { code: 'LIMIT_EXCEEDED' }); // 320,000,000 bytes.
  const raster = { id: randomUUID(), name: 'Unrendered source', type: 'raster', visible: false, opacity: 1, blendMode: 'normal', width, height, transforms: [],
    asset: 'a'.repeat(64), sourceAsset: 'a'.repeat(64), filters: [{ id: randomUUID(), kind: 'brightness', value: 1, opacity: 1, enabled: true }] };
  const one = { name: 'Within combined scratch', width, height, selection: null, layers: [groups[0], { ...raster, parentId: groups[0].id }] };
  const two = { ...one, layers: [groups[0], groups[1], { ...raster, parentId: groups[1].id }] };
  assert.doesNotThrow(() => validateLayerFilterResources(one, layerTree(one.layers))); // 80,000,000 + 144,000,000 bytes.
  assert.throws(() => validateLayerFilterResources(two, layerTree(two.layers)), { code: 'LIMIT_EXCEEDED' }); // 160,000,000 + 144,000,000 bytes.
  assert.doesNotThrow(() => native.validateGraph(one));
  assert.throws(() => native.validateGraph(two), { code: 'LIMIT_EXCEEDED' });
  assert.deepEqual(await fs.readdir(native.assetsDir), []);
  assert.deepEqual(await fs.readdir(native.projectsDir), []);
});
