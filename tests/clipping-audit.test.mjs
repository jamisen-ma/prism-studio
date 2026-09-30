import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { blendClippingInterior } from '../server/clipping.mjs';

const edit = async (native, doc, command, args = {}) => (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document;
const get = async (native, doc) => (await native.execute('get_document', { documentId: doc.id })).document;
async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-clipping-audit-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return { native: await new NativeBackend({ dataDir, ...options }).init(), dataDir };
}
const bytesAt = (pixels, index) => [...pixels.subarray(index * 4, index * 4 + 4)];
const files = async directory => Object.fromEntries(await Promise.all((await fs.readdir(directory)).sort().map(async name => [name, await fs.readFile(path.join(directory, name))])));
const bitmap = (values, width, height) => ({ shape: 'bitmap', x: 0, y: 0, width, height, feather: 0, invert: false, runs: values.flatMap((value, index) => value ? [index, 1, value] : []) });
const common = extra => ({ id: randomUUID(), name: 'Independent clipping fixture', visible: true, opacity: 1, blendMode: 'normal', ...extra });
async function raster(native, pixels, width, height, extra = {}) {
  const data = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer(), asset = await native.storeAsset(data);
  return common({ type: 'raster', asset, sourceAsset: asset, sourceFormat: 'png', width, height, transforms: [], ...extra });
}
function noiseAmount(alpha, opacity, coverage, mode, pixel) {
  const fraction = alpha / 255 * opacity * coverage;
  if (mode !== 'dissolve') return fraction;
  // Independent integer implementation of the editor's documented spatial
  // noise rule; no production blend/composite function enters the oracle.
  const mask32 = 0xffffffffn, factor = 0x45d9f3bn;
  let value = (BigInt(pixel + 1) * factor) & mask32;
  value = ((value ^ (value >> 16n)) * factor) & mask32;
  value ^= value >> 16n;
  return Number(value) / 2 ** 32 < fraction ? 1 : 0;
}
function blend(back, front, mode) {
  if (mode === 'multiply') return back * front / 255;
  if (mode === 'screen') return back + front - back * front / 255;
  return front;
}
function over(back, front, amount, mode) {
  if (!amount) return [...back];
  const b = back[3] / 255, alpha = amount + b * (1 - amount);
  return [...[0, 1, 2].map(c => Math.round((back[c] * b * (1 - amount) + front[c] * amount * (1 - b) + blend(back[c], front[c], mode) * amount * b) / alpha)), Math.round(255 * alpha)];
}
function reference(back, base, members, p, baseMask, memberMasks) {
  let interior = bytesAt(base.pixels, p);
  if (!base.visible || base.opacity === 0) return bytesAt(back, p);
  if (interior[3] && baseMask[p] > 0) for (const [index, member] of members.entries()) {
    if (!member.visible || member.opacity === 0) continue;
    const front = bytesAt(member.pixels, p), a = noiseAmount(front[3], member.opacity, memberMasks[index][p], member.blendMode, p);
    interior = [...[0, 1, 2].map(c => Math.round(interior[c] + (blend(interior[c], front[c], member.blendMode) - interior[c]) * a)), interior[3]];
  }
  return over(bytesAt(back, p), interior, noiseAmount(interior[3], base.opacity, baseMask[p], base.blendMode, p), base.blendMode);
}
async function decodedPreview(native, doc, layerId, view = 'layer') {
  const result = await native.execute('get_layer_preview', { documentId: doc.id, layerId, view, maxWidth: 100 });
  return { ...result, pixels: await sharp(Buffer.from(result.data, 'base64')).ensureAlpha().raw().toBuffer() };
}

test('actual native chains match independent color/alpha arithmetic, fractional base coverage and deterministic dissolve', async t => {
  const { native } = await fixture(t), width = 5, height = 3, count = width * height;
  const buffers = Array.from({ length: 4 }, (_, k) => Buffer.from(Array.from({ length: count }, (_, p) => [(p * 31 + k * 23) % 256, (p * 41 + k * 59) % 256, (p * 71 + k * 37) % 256, [0, 1, 128, 254, 255][(p + k) % 5]]).flat()));
  // An opaque external backdrop avoids an unrelated transparent-rounding stage.
  for (let p = 0; p < count; p++) buffers[0][p * 4 + 3] = 255;
  const nodes = await Promise.all(buffers.map(buffer => raster(native, buffer, width, height)));
  const baseMask = Array.from({ length: count }, (_, p) => {
    const x = p % width + 0.5, y = Math.floor(p / width) + 0.5;
    const inside = Math.min(x, width - x, y, height - y) / 1.3;
    return x >= 1 && x < 4 ? 1 - Math.min(1, inside) : 0;
  });
  const memberMaskBytes = [0, 1].map(k => Array.from({ length: count }, (_, p) => [1, 64, 128, 255][(p + k) % 4]));
  const modes = ['normal', 'multiply', 'screen', 'dissolve'];
  for (let trial = 0; trial < 32; trial++) {
    const base = { ...nodes[1], opacity: [1, 0.47, 0.83][trial % 3], blendMode: modes[trial % 4], visible: trial !== 30,
      mask: { shape: 'rectangle', x: 0, y: 0, width, height, feather: 1.3, invert: true, clip: { x: 1, y: 0, width: 3, height } } };
    const members = nodes.slice(2).map((node, index) => ({ ...node, clipBaseId: base.id, opacity: index ? 0.61 : 0.73, blendMode: modes[(trial + index + 1) % 4], visible: trial !== 29 || index !== 0, mask: bitmap(memberMaskBytes[index], width, height) }));
    if (trial === 31) base.opacity = 0;
    const graph = { name: 'Independent clipped arithmetic', width, height, selection: null, layers: [nodes[0], base, ...members] };
    const expected = Buffer.from(Array.from({ length: count }, (_, p) => reference(buffers[0], { ...base, pixels: buffers[1] }, members.map((member, index) => ({ ...member, pixels: buffers[index + 2] })), p, baseMask, memberMaskBytes.map(mask => mask.map(value => value / 255)))).flat());
    assert.deepEqual(await native.renderGraph(graph), expected, `Native reference trial ${trial}`);
  }
  const immutable = buffers.map(buffer => Buffer.from(buffer)), interior = Buffer.from(buffers[1]);
  await blendClippingInterior(interior, buffers[2], { width, opacity: 1 });
  for (let p = 0; p < count; p++) {
    assert.equal(interior[p * 4 + 3], buffers[1][p * 4 + 3]);
    if (!buffers[1][p * 4 + 3]) assert.deepEqual(bytesAt(interior, p), bytesAt(buffers[1], p), 'invisible base RGB is retained in the owned interior');
  }
  buffers.forEach((buffer, index) => assert.deepEqual(buffer, immutable[index]));
});

test('soft silhouette alpha is never thickened and hidden bases consume their entire member run', async t => {
  const { native, dataDir } = await fixture(t), width = 8, height = 4;
  const raw = Buffer.from(Array.from({ length: width * height }, (_, p) => [p * 13 % 256, p * 37 % 256, p * 59 % 256, [0, 1, 128, 255][p % 4]]).flat());
  const base = await raster(native, raw, width, height);
  const members = Array.from({ length: 3 }, (_, index) => common({ type: 'solid', color: ['#abcdef', '#3579bd', '#b97531'][index], width, height, transforms: [], clipBaseId: base.id }));
  const selection = { shape: 'rectangle', x: 1, y: 1, width: 4, height: 2, feather: 0, invert: false };
  let doc = (await native.newProject({ name: 'Soft chain', width, height, selection, layers: [base, ...members] }, 'Independent fixture')).document;
  const originalAssets = await files(native.assetsDir), before = await native.renderGraph(doc);
  for (let p = 0; p < width * height; p++) assert.equal(before[p * 4 + 3], raw[p * 4 + 3]);
  const original = await decodedPreview(native, doc, base.id, 'source'); assert.deepEqual(original.pixels, raw);
  doc = await edit(native, doc, 'set_layer', { layerId: base.id, visible: false });
  assert.deepEqual(await native.renderGraph(doc), Buffer.alloc(raw.length));
  assert.deepEqual((await decodedPreview(native, doc, base.id)).pixels, before, 'inspection reveals base without revealing hidden unrelated content');
  doc = await edit(native, doc, 'undo');
  doc = await edit(native, doc, 'set_layer', { layerId: base.id, opacity: 0 });
  assert.deepEqual(await native.renderGraph(doc), Buffer.alloc(raw.length));
  doc = await edit(native, doc, 'undo');
  doc = await edit(native, doc, 'set_layer', { layerId: members[2].id, visible: false });
  const member = await decodedPreview(native, doc, members[2].id);
  for (let p = 0; p < width * height; p++) {
    assert.equal(member.pixels[p * 4 + 3], raw[p * 4 + 3]);
    if (raw[p * 4 + 3]) assert.deepEqual(bytesAt(member.pixels, p).slice(0, 3), [185, 117, 49]);
  }
  assert.deepEqual(doc.selection, selection); assert.deepEqual(await files(native.assetsDir), originalAssets);
  const reopened = await new NativeBackend({ dataDir }).init();
  assert.deepEqual(reopened.loadWarnings, []); assert.deepEqual(await get(reopened, doc), doc);
  assert.deepEqual(await reopened.renderGraph(doc), await native.renderGraph(doc));
});

test('chain previews resolve original siblings, lower protection and independent member/base dissolve without source writes', async t => {
  const { native } = await fixture(t), width = 12, height = 6, count = width * height;
  const protectedRaw = Buffer.from(Array.from({ length: count }, (_, p) => [23, 131, 217, p % width >= 4 && p % width <= 6 ? [1, 128, 255][p % 3] : 0]).flat());
  const person = await raster(native, protectedRaw, width, height, { protected: true });
  const base = await raster(native, Buffer.from(Array.from({ length: count }, (_, p) => [137, 71, 29, [1, 128, 255][p % 3]]).flat()), width, height, { opacity: 0.83, blendMode: 'dissolve' });
  const member = await raster(native, Buffer.from(Array.from({ length: count }, (_, p) => [17, 43, 199, [128, 255][p % 2]]).flat()), width, height, {
    clipBaseId: base.id, opacity: 0.61, blendMode: 'dissolve', role: 'generated', provenance: { jobId: randomUUID(), mode: 'generate' },
    mask: bitmap(Array.from({ length: count }, (_, p) => [128, 255][p % 2]), width, height), filters: [{ id: randomUUID(), kind: 'invert', value: 100, opacity: 1, enabled: true }],
  });
  const group = common({ type: 'group', mode: 'isolated' }); base.parentId = group.id; member.parentId = group.id;
  let doc = (await native.newProject({ name: 'Protected chain inspection', width, height, selection: null, layers: [person, group, base, member] }, 'Independent fixture')).document;
  const assets = await files(native.assetsDir), complete = await native.renderGraph(doc), footprint = await native.protectedPixels(doc);
  const beforeLayers = doc.layers.map(layer => layer.id === member.id ? { ...layer, visible: false } : layer);
  const baseline = await native.renderGraph({ ...doc, layers: beforeLayers });
  const basePreview = await decodedPreview(native, doc, base.id), contribution = await decodedPreview(native, doc, member.id);
  for (let p = 0; p < count; p++) {
    const memberAlpha = [128, 255][p % 2], mask = [128, 255][p % 2] / 255;
    const expected = footprint[p] ? 0 : 255 * noiseAmount(memberAlpha, member.opacity, mask, member.blendMode, p) * noiseAmount([1, 128, 255][p % 3], base.opacity, 1, base.blendMode, p);
    assert.equal(contribution.pixels[p * 4 + 3], expected, `independent dissolve contribution ${p}`);
    if (footprint[p]) {
      assert.deepEqual(bytesAt(complete, p), bytesAt(baseline, p), `upper color must be suppressed on lower protection ${p}`);
      if (basePreview.pixels[p * 4 + 3]) assert.deepEqual(bytesAt(basePreview.pixels, p).slice(0, 3), [137, 71, 29], 'base inspection retains original protection context');
    } else if (expected) assert.deepEqual(bytesAt(contribution.pixels, p).slice(0, 3), [238, 212, 56]);
  }
  const snapshot = await native.snapshotForGeneration({ documentId: doc.id, expectedRevision: doc.revision, scope: 'canvas' });
  const aiImage = await sharp(snapshot.image).ensureAlpha().raw().toBuffer(); assert.deepEqual(aiImage, complete);
  const saved = structuredClone(doc); await decodedPreview(native, doc, member.id, 'source');
  assert.deepEqual(await get(native, doc), saved); assert.deepEqual(await files(native.assetsDir), assets);
});

test('nested pass-through and isolated groups apply their own soft masks and opacity after the completed clipping chain', async t => {
  const { native } = await fixture(t), width = 4, height = 3, count = width * height;
  const input = Array.from({ length: 3 }, (_, k) => Buffer.from(Array.from({ length: count }, (_, p) => [(p * 13 + k * 41) % 256, (p * 17 + k * 71) % 256, (p * 19 + k * 31) % 256, [1, 128, 255][(p + k) % 3]]).flat()));
  const leaves = await Promise.all(input.map(bytes => raster(native, bytes, width, height)));
  const parentMask = Array.from({ length: count }, (_, p) => [1, 128, 255][p % 3]);
  const childMask = Array.from({ length: count }, (_, p) => [255, 64, 0][p % 3]);
  const baseMask = Array.from({ length: count }, (_, p) => [128, 255, 1][p % 3]);
  const unit = Array(count).fill(1);
  function groupReference(back, layer, coverage, drawChildren) {
    const a = layer.opacity * coverage;
    if (layer.mode === 'isolated') {
      const front = drawChildren([0, 0, 0, 0]);
      return over(back, front, front[3] / 255 * a, layer.blendMode);
    }
    const changed = drawChildren(back), alpha = back[3] / 255 * (1 - a) + changed[3] / 255 * a;
    if (a === 0) return [...back];
    if (a === 1) return changed;
    return [...[0, 1, 2].map(c => alpha ? Math.round((back[c] * back[3] / 255 * (1 - a) + changed[c] * changed[3] / 255 * a) / alpha) : back[c]), Math.round(255 * alpha)];
  }
  for (let trial = 0; trial < 12; trial++) {
    const outer = common({ type: 'group', mode: trial % 2 ? 'isolated' : 'pass-through', opacity: 0.73, blendMode: trial % 2 ? ['normal', 'multiply', 'screen'][trial % 3] : 'normal', mask: bitmap(parentMask, width, height) });
    const inner = common({ type: 'group', parentId: outer.id, mode: trial % 3 ? 'isolated' : 'pass-through', opacity: 0.61, blendMode: trial % 3 ? ['normal', 'multiply', 'screen'][(trial + 1) % 3] : 'normal', mask: bitmap(childMask, width, height) });
    const base = { ...leaves[1], parentId: inner.id, opacity: 0.83, mask: bitmap(baseMask, width, height), blendMode: ['normal', 'multiply', 'screen'][trial % 3] };
    const member = { ...leaves[2], parentId: inner.id, clipBaseId: base.id, opacity: 0.47, blendMode: ['normal', 'multiply', 'screen'][(trial + 1) % 3] };
    const graph = { name: 'Nested clipping stages', width, height, selection: null, layers: [leaves[0], outer, inner, base, member] };
    const expected = Buffer.from(Array.from({ length: count }, (_, p) => {
      const background = bytesAt(input[0], p);
      return groupReference(background, outer, parentMask[p] / 255, outerBack => groupReference(outerBack, inner, childMask[p] / 255, innerBack => {
        const backdrop = Buffer.alloc(count * 4); backdrop.set(innerBack, p * 4);
        return reference(backdrop, { ...base, pixels: input[1] }, [{ ...member, pixels: input[2] }], p, baseMask.map(value => value / 255), [unit]);
      }));
    }).flat());
    assert.deepEqual(await native.renderGraph(graph), expected, `Nested clipping reference ${trial}`);
  }
});

test('base styles stay outside the unchanged silhouette and library application cannot enable member decorations', async t => {
  const { native } = await fixture(t), width = 15, height = 11, count = width * height;
  const raw = Buffer.from(Array.from({ length: count }, (_, p) => [91, 73, 57, p % width >= 5 && p % width <= 8 && Math.floor(p / width) >= 4 && Math.floor(p / width) <= 6 ? [1, 128, 255][p % 3] : 0]).flat());
  const base = await raster(native, raw, width, height, { opacity: 0.61, outline: { width: 1, color: '#f5e3c1' }, effects: {
    shadow: { color: '#192837', x: 2, y: 1, blur: 1, opacity: 0.6 }, glow: { color: '#abc123', blur: 2, opacity: 0.5 },
  } });
  const member = common({ type: 'solid', color: '#c14268', width, height, transforms: [], clipBaseId: base.id });
  let doc = (await native.newProject({ name: 'Clipped outside styles', width, height, selection: null, layers: [base, member] }, 'Independent fixture')).document;
  const styled = await native.renderGraph(doc), baseline = await native.renderGraph({ ...doc, layers: [base, { ...member, visible: false }] });
  const bareBase = { ...base }; delete bareBase.outline; delete bareBase.effects;
  const withoutStyles = await native.renderGraph({ ...doc, layers: [bareBase, member] });
  let seenDecoration = false;
  for (let p = 0; p < count; p++) {
    if (raw[p * 4 + 3]) assert.deepEqual(bytesAt(styled, p), bytesAt(withoutStyles, p), `no decoration enters source at ${p}`);
    else { assert.deepEqual(bytesAt(styled, p), bytesAt(baseline, p), `member colors cannot recolor base decoration at ${p}`); seenDecoration ||= styled[p * 4 + 3] > 0; }
    assert.equal(styled[p * 4 + 3], baseline[p * 4 + 3], `base opacity and alpha stay unchanged at ${p}`);
  }
  assert.ok(seenDecoration);
  doc = await edit(native, doc, 'save_layer_style', { layerId: base.id, name: 'Base decoration' });
  const before = structuredClone(doc), assets = await files(native.assetsDir);
  await assert.rejects(edit(native, doc, 'apply_layer_style', { styleId: doc.layerStyles[0].id, layerIds: [member.id] }), { code: 'INVALID_TARGET' });
  assert.deepEqual(await get(native, doc), before); assert.deepEqual(await files(native.assetsDir), assets);
  doc = await edit(native, doc, 'set_layer_effects', { layerId: member.id, effects: { glow: { blur: 1, opacity: 0, color: '#ffffff' } } });
  doc = await edit(native, doc, 'set_layer_outline', { layerId: member.id, width: 0 });
  assert.deepEqual(await native.renderGraph(doc), styled, 'disabled member decoration metadata is harmless');
});

test('ineligible chain edits, partial structures and actual persist failure preserve graph, cache, project and assets', async t => {
  const { native } = await fixture(t, { segmentSubject: async () => { assert.fail('No model call for an ineligible clipping participant'); } });
  let doc = (await native.execute('create_document', { width: 20, height: 12 })).document;
  doc = await edit(native, doc, 'add_text', { text: 'A', x: 1, y: 1, fontSize: 8, color: '#e2a45a' });
  const baseId = doc.layers.at(-1).id;
  doc = await edit(native, doc, 'add_gradient', { kind: 'linear', start: { x: 0, y: 0 }, end: { x: 20, y: 0 }, stops: [{ offset: 0, color: '#314159' }, { offset: 1, color: '#926535' }] });
  const memberId = doc.layers.at(-1).id;
  doc = await edit(native, doc, 'set_clipping_chain', { baseLayerId: baseId, layerIds: [memberId] });
  const warm = await native.execute('get_preview', { documentId: doc.id }), cache = native.previewCache.stats(), assetFiles = await files(native.assetsDir), projectFiles = await files(native.projectsDir);
  const methods = ['renderLayer', 'sourcePixels', 'storeAsset', 'storeAlpha'], originals = new Map(methods.map(name => [name, native[name]])), reached = [];
  for (const method of methods) native[method] = async () => { reached.push(method); assert.fail(`Rejected metadata edit reached ${method}`); };
  try {
    for (const [command, args] of [
      ['set_layer_protection', { layerId: baseId, protected: true }], ['set_layer_protection', { layerId: memberId, protected: true }],
      ['set_layer_outline', { layerId: memberId, width: 1, color: '#ffffff' }], ['set_layer_effects', { layerId: memberId, effects: { shadow: { opacity: 0.1 } } }],
      ['duplicate_layer', { layerId: memberId }], ['delete_layer', { layerId: baseId }], ['create_group', { index: 2 }],
      ['group_layers', { layerIds: [memberId] }], ['move_layer', { layerId: baseId, parentId: null, index: 0 }],
      ['reorder_layer', { layerId: memberId, index: 0 }], ['extract_subject', { layerId: memberId }],
      ['place_layer', { sourceDocumentId: doc.id, sourceLayerId: memberId, sourceExpectedRevision: doc.revision, x: 0, y: 0, width: 20, height: 12 }],
      ['align_layers', { layerIds: [baseId], axis: 'horizontal', alignment: 'center', relativeTo: 'canvas' }],
      ['set_clipping_chain', { baseLayerId: memberId, layerIds: [] }],
      ['apply_transaction', { operations: [{ command: 'set_layer', args: { layerId: baseId, name: 'Not published' } }, { command: 'delete_layer', args: { layerId: memberId } }] }],
    ]) await assert.rejects(edit(native, doc, command, args));
  } finally { for (const [name, method] of originals) native[name] = method; }
  assert.deepEqual(reached, [], 'invalid clipping operations must fail before source processing');
  await assert.rejects(native.execute('set_clipping_chain', { documentId: doc.id, expectedRevision: doc.revision - 1, baseLayerId: baseId, layerIds: [] }), { code: 'REVISION_CONFLICT' });
  const projectsDir = native.projectsDir; native.projectsDir = path.join(projectsDir, `${doc.id}.json`);
  try { await assert.rejects(edit(native, doc, 'set_clipping_chain', { baseLayerId: baseId, layerIds: [] })); } finally { native.projectsDir = projectsDir; }
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(native.previewCache.stats(), cache);
  assert.deepEqual(await files(native.assetsDir), assetFiles); assert.deepEqual(await files(native.projectsDir), projectFiles);
  assert.deepEqual(await native.execute('get_preview', { documentId: doc.id }), warm);
  // Both sides remain linked through rasterization, and a containing subtree
  // gets independent IDs and internal references when copied.
  doc = await edit(native, doc, 'rasterize_layer', { layerId: baseId });
  doc = await edit(native, doc, 'rasterize_layer', { layerId: memberId });
  assert.equal(doc.layers.find(layer => layer.id === memberId).clipBaseId, baseId);
  doc = await edit(native, doc, 'group_layers', { layerIds: [baseId, memberId], name: 'Whole chain' });
  const group = doc.layers.find(layer => layer.type === 'group');
  doc = await edit(native, doc, 'duplicate_layer', { layerId: group.id });
  const copy = doc.layers.find(layer => layer.type === 'group' && layer.id !== group.id), children = doc.layers.filter(layer => layer.parentId === copy.id);
  assert.equal(children[1].clipBaseId, children[0].id); assert.notEqual(children[0].id, baseId);
});

test('hash-valid portable graphs with malformed clipping references reject before any asset validation or write', async t => {
  const { native: source } = await fixture(t), { native: target } = await fixture(t), width = 5, height = 3;
  const base = await raster(source, Buffer.from(Array.from({ length: width * height }, () => [51, 73, 97, 128]).flat()), width, height);
  const member = common({ type: 'solid', color: '#bb9955', width, height, transforms: [], clipBaseId: base.id });
  const doc = (await source.newProject({ name: 'Valid portable chain', width, height, selection: null, layers: [base, member] }, 'Independent fixture')).document;
  const valid = (await source.exportProject({ documentId: doc.id })).data, length = valid.readUInt32BE(8), manifest = JSON.parse(valid.subarray(12, 12 + length));
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const cases = [
    layers => { layers[1].clipBaseId = randomUUID(); }, layers => { layers[1].clipBaseId = layers[1].id; },
    layers => { layers[0].clipBaseId = layers[1].id; }, layers => { layers[1].clipBaseId = 123; },
    layers => { layers[0].protected = true; layers[0].visible = false; }, layers => { layers[1].protected = true; layers[1].opacity = 0; },
    layers => { layers[0].role = 'generated'; }, layers => { layers[0].provenance = { jobId: randomUUID() }; },
    layers => { layers[1].effects = { glow: { blur: 1, opacity: 0.01, color: '#ffffff' } }; },
    layers => { layers.splice(1, 0, common({ type: 'solid', color: '#ffffff', width, height, transforms: [] })); },
    layers => { const group = common({ type: 'group', mode: 'pass-through' }); layers[1].parentId = group.id; layers.splice(1, 0, group); },
  ];
  let assetCalls = 0;
  target.validateProjectAsset = target.storeAsset = async () => { assetCalls++; assert.fail('Malformed clipping graph reached asset processing'); };
  for (const [index, mutate] of cases.entries()) {
    const altered = structuredClone(manifest); mutate(altered.graph.layers);
    const body = Buffer.from(JSON.stringify(canonical(altered))), prefix = Buffer.from(valid.subarray(0, 12)); prefix.writeUInt32BE(body.length, 8);
    await assert.rejects(target.importProject({ data: Buffer.concat([prefix, body, valid.subarray(12 + length)]) }), { code: 'INVALID_PROJECT_BUNDLE' }, `invalid portable chain ${index}`);
  }
  assert.equal(assetCalls, 0); assert.equal(target.projects.size, 0); assert.deepEqual(await files(target.assetsDir), {}); assert.deepEqual(await files(target.projectsDir), {});
});

test('hidden clipping chains share the exact retained-surface budget with groups and editable filters before allocations', async t => {
  const { native } = await fixture(t), width = 4000, height = 4000;
  const groups = Array.from({ length: 3 }, () => common({ type: 'group', mode: 'isolated', visible: false }));
  for (let i = 1; i < groups.length; i++) groups[i].parentId = groups[i - 1].id;
  const base = common({ type: 'solid', color: '#334455', width, height, transforms: [], visible: false });
  const member = common({ type: 'raster', asset: 'a'.repeat(64), sourceAsset: 'a'.repeat(64), sourceFormat: 'png', width, height, transforms: [], clipBaseId: base.id, visible: false });
  const graph = (depth, filtered) => ({ name: 'No allocated clipping pixels', width, height, selection: null, layers: [
    ...groups.slice(0, depth), { ...base, ...(depth ? { parentId: groups[depth - 1].id } : {}) },
    { ...member, ...(depth ? { parentId: groups[depth - 1].id } : {}), ...(filtered ? { filters: [{ id: randomUUID(), kind: 'brightness', value: 1, opacity: 1, enabled: true }] } : {}) },
  ] });
  assert.doesNotThrow(() => native.validateGraph(graph(2, false))); // (2 groups + chain) * 5 * 16M = 240M.
  assert.throws(() => native.validateGraph(graph(3, false)), { code: 'LIMIT_EXCEEDED' }); // 320M.
  assert.doesNotThrow(() => native.validateGraph(graph(0, true))); // (chain5 + filter9) * 16M = 224M.
  assert.throws(() => native.validateGraph(graph(1, true)), { code: 'LIMIT_EXCEEDED' }); // 304M.
  assert.deepEqual(await files(native.assetsDir), {}); assert.deepEqual(await files(native.projectsDir), {});
});
