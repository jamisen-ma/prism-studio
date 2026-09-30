import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { adjustmentTransform, normalizeParameters, colorTransformYieldRows } from '../server/color.mjs';
import { applyLayerFilters, filterWork } from '../server/layer-filters.mjs';
import { validateCommand } from '../shared/commands.mjs';

const W = [2126, 7152, 722], D = 2550000;
const balanceDefaults = () => ({ shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0], preserveLuminosity: true });
const bwDefaults = () => ({ reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80, tint: false, tintColor: '#b98952', tintAmount: 100 });
const tie = { shadows: [100, -100, 100], midtones: [100, -100, 100], highlights: [100, -100, 100] };
const hueKeys = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas'];
const round = (n, d) => n <= 0n ? 0 : n >= 255n * d ? 255 : Number((2n * n + d) / (2n * d));
// Keep the original uncanceled255 factor and rational desired denominator.
// This is deliberately different from production's Number A/C compilation.
function exactBalance(rgb, parameters = {}) {
  const p = { ...balanceDefaults(), ...parameters }, L = rgb.reduce((sum, value, i) => sum + W[i] * value, 0);
  const weights = [Math.max(0, D - 2 * L), 0, Math.max(0, 2 * L - D)]; weights[1] = D - weights[0] - weights[2];
  const rows = [p.shadows, p.midtones, p.highlights].map(row => row.map(value => Math.round(value * 100)));
  const shifts = rgb.map((_, i) => weights.reduce((sum, value, j) => sum + value * rows[j][i], 0));
  if (shifts.every(value => value === 0)) return [...rgb];
  const scale = BigInt(D) * 10000n, desired = rgb.map((value, i) => BigInt(value) * scale + 255n * BigInt(shifts[i]));
  if (!p.preserveLuminosity) return desired.map(value => round(value, scale));
  const tone = BigInt(L), desiredLuma = desired.reduce((sum, value, i) => sum + BigInt(W[i]) * value, 0n), chroma = desired.map(value => value * 10000n - desiredLuma);
  let numerator = 1n, denominator = 1n;
  for (const value of chroma) if (value !== 0n) {
    const nextN = (value > 0n ? BigInt(D) - tone : tone) * scale, nextD = value < 0n ? -value : value;
    if (nextN * denominator < numerator * nextD) { numerator = nextN; denominator = nextD; }
  }
  return chroma.map(value => round(tone * scale * denominator + value * numerator, 10000n * scale * denominator));
}
function exactBlackWhite([r, g, b], parameters = {}) {
  const p = { ...bwDefaults(), ...parameters }, low = Math.min(r, g, b), c = Math.max(r, g, b) - low;
  // Independent six channel-order regions, including boundary ties.
  const [sector, distance] = r >= g && g >= b ? [0, g - b] : g >= r && r >= b ? [1, g - r] : g >= b && b >= r ? [2, b - r] : b >= g && g >= r ? [3, b - g] : b >= r && r >= g ? [4, r - g] : [5, r - b];
  const anchors = hueKeys.map(key => Math.round(p[key] * 100));
  const gray = c === 0 ? low : round(BigInt(low * 10000 + (c - distance) * anchors[sector] + distance * anchors[(sector + 1) % 6]), 10000n);
  if (!p.tint || p.tintAmount === 0) return [gray, gray, gray];
  const tint = [1, 3, 5].map(i => parseInt(p.tintColor.slice(i, i + 2), 16)), tone = tint.reduce((sum, value, i) => sum + W[i] * value, 0), chroma = tint.map(value => BigInt(value * 10000 - tone));
  let numerator = 1n, denominator = 1n;
  for (const value of chroma) if (value !== 0n) {
    const n = BigInt(value > 0n ? 255 - gray : gray) * 10000n, d = value < 0n ? -value : value;
    if (n * denominator < numerator * d) { numerator = n; denominator = d; }
  }
  return chroma.map(value => round(BigInt(gray) * 100000000n * denominator + value * numerator * BigInt(Math.round(p.tintAmount * 100)), 100000000n * denominator));
}
const exact = (kind, rgb, parameters) => kind === 'color_balance' ? exactBalance(rgb, parameters) : exactBlackWhite(rgb, parameters);
const base = extra => ({ id: randomUUID(), name: 'Tonal audit', visible: true, opacity: 1, blendMode: 'normal', ...extra });
const entry = (kind, parameters, extra = {}) => ({ id: randomUUID(), kind, value: 0, enabled: true, opacity: 1, parameters, ...extra });
const pixels = (w, h, fn) => Buffer.from(Array.from({ length: w * h }, (_, p) => fn(p % w, Math.floor(p / w), p)).flat());
const pixel = (bytes, p) => [...bytes.subarray(p * 4, p * 4 + 4)];
const edit = (native, doc, command, args = {}) => native.execute(command, validateCommand(command, { documentId: doc.id, expectedRevision: doc.revision, ...args }));
const get = async (native, doc) => (await native.execute('get_document', { documentId: doc.id })).document;
const files = async dir => Object.fromEntries(await Promise.all((await fs.readdir(dir)).sort().map(async name => [name, await fs.readFile(path.join(dir, name))])));
const project = async (native, width, height, layers, extra = {}) => (await native.newProject({ name: 'Tonal audit project', width, height, layers, selection: null, ...extra }, 'Independent fixture')).document;
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-tonal-audit-'));
  const native = await new NativeBackend({ dataDir, segmentSubject: () => assert.fail('Tonal edits cannot call segmentation') }).init();
  t.after(async () => { await native.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { native, dataDir };
}
async function raster(native, bytes, width, height, extra = {}) {
  const asset = await native.storeAsset(await sharp(bytes, { raw: { width, height, channels: 4 } }).png().toBuffer());
  return base({ type: 'raster', asset, sourceAsset: asset, sourceFormat: 'png', width, height, transforms: [], ...extra });
}
async function noPixels(native, run, noFileReads = false) {
  const restore = [];
  for (const key of ['render', 'renderGraph', 'renderLayer', 'visibleLayerPixels', 'storeAsset', 'storeAlpha', 'readAlpha', 'readProjectAsset', 'validateProjectAsset', 'segmentSubject']) if (typeof native[key] === 'function') {
    const old = native[key]; native[key] = () => assert.fail(`Unexpected ${key}`); restore.push(() => { native[key] = old; });
  }
  if (noFileReads) for (const key of ['readFile', 'open', 'stat']) { const old = fs[key]; fs[key] = () => assert.fail(`Unexpected fs.${key}`); restore.push(() => { fs[key] = old; }); }
  try { return await run(); } finally { restore.reverse().forEach(fn => fn()); }
}

test('actual color dispatcher matches independent rational half ties, hue boundaries and seeded settings', () => {
  let seed = 0x52d55ac1; const random = n => Math.floor(((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x100000000) * n);
  for (let r = 0; r < 32; r++) assert.deepEqual(adjustmentTransform({ kind: 'color_balance', value: 0, parameters: tie })(r, 89, r), [r + 224, 0, r + 224]);
  for (let n = 0; n < 1000; n++) {
    const rgb = [random(256), random(256), random(256)], balance = { shadows: Array.from({ length: 3 }, () => (random(20001) - 10000) / 100), midtones: Array.from({ length: 3 }, () => (random(20001) - 10000) / 100), highlights: Array.from({ length: 3 }, () => (random(20001) - 10000) / 100), preserveLuminosity: n % 5 !== 0 };
    const bw = { ...Object.fromEntries(hueKeys.map(key => [key, (random(50001) - 20000) / 100])), tint: n % 3 !== 0, tintColor: '#' + [random(256), random(256), random(256)].map(v => v.toString(16).padStart(2, '0')).join(''), tintAmount: random(10001) / 100 };
    for (const [kind, parameters] of [['color_balance', balance], ['black_white', bw]]) assert.deepEqual(adjustmentTransform({ kind, value: 0, parameters })(...rgb), exact(kind, rgb, parameters));
  }
  for (const rgb of [[255, 0, 0], [255, 1, 0], [255, 0, 1], [255, 255, 0], [0, 255, 255], [255, 0, 255], [89, 89, 89], [0, 0, 0], [255, 255, 255]]) {
    const p = { reds: -200, yellows: 300, greens: 0.01, cyans: 70.49, blues: -123.45, magentas: 234.56, tint: true, tintColor: '#ff0037', tintAmount: 79.13 };
    assert.deepEqual(adjustmentTransform({ kind: 'black_white', value: 0, parameters: p })(...rgb), exactBlackWhite(rgb, p));
  }
});

test('native adjustment and source-filter paths preserve alpha/hidden RGB and apply density/opacity/protection once', async t => {
  const { native } = await fixture(t), input = Buffer.from([217, 23, 51, 0, 1, 89, 1, 1, 83, 39, 201, 128, 193, 41, 17, 255]), original = Buffer.from(input);
  const configs = [['color_balance', tie], ['black_white', { reds: 125.5, blues: -80, tint: true, tintColor: '#32ca79', tintAmount: 50.25 }]];
  const entries = configs.map(([kind, parameters], i) => entry(kind, parameters, { opacity: i ? 0.25 : 0.5 }));
  const expected = Buffer.from(input);
  for (const item of entries) for (let p = 0; p < 4; p++) if (expected[p * 4 + 3]) {
    const rgb = pixel(expected, p).slice(0, 3), result = exact(item.kind, rgb, item.parameters);
    result.forEach((v, c) => { expected[p * 4 + c] = Math.round(rgb[c] + (v - rgb[c]) * item.opacity); });
  }
  assert.deepEqual(await applyLayerFilters(input, 4, 1, entries), expected);
  assert.deepEqual(await applyLayerFilters(input, 4, 1, entries.map(item => ({ ...item, enabled: false }))), input);
  assert.deepEqual(await applyLayerFilters(input, 4, 1, entries.map(item => ({ ...item, opacity: 0 }))), input);
  const rawMask = [255, 128, 0, 255], mask = { shape: 'bitmap', x: 0, y: 0, width: 4, height: 1, feather: 0, invert: false, runs: [0, 1, 255, 1, 1, 128, 3, 1, 255] };
  for (const [kind, parameters] of configs) {
    const result = await native.applyAdjustment(input, 4, 1, { kind, value: 0, parameters, opacity: 0.5, mask, maskDensity: 0.5 }, Uint8Array.from([0, 0, 0, 1]));
    for (let p = 0; p < 4; p++) {
      const rgb = pixel(input, p).slice(0, 3), adjusted = exact(kind, rgb, parameters), amount = 0.5 * (127.5 + rawMask[p] / 2) / 255;
      const want = !input[p * 4 + 3] || p === 3 ? pixel(input, p) : [...adjusted.map((v, c) => Math.round(rgb[c] + (v - rgb[c]) * amount)), input[p * 4 + 3]];
      assert.deepEqual(pixel(result, p), want);
    }
  }
  assert.deepEqual(input, original);
});

test('native metadata edits retain sparse effective defaults, partial rows/tint and selection/source scope without asset writes', async t => {
  const { native } = await fixture(t), width = 8, height = 6, source = pixels(width, height, (x, y, p) => [p * 13 % 256, p * 31 % 256, p * 57 % 256, [0, 1, 128, 255][p % 4]]);
  const photo = await raster(native, source, width, height); let doc = await project(native, width, height, [photo]);
  const assets = await files(native.assetsDir), baseline = await native.renderGraph(doc);
  doc = (await edit(native, doc, 'select_region', { shape: 'rectangle', x: 2, y: 1, width: 3, height: 3 })).document;
  doc = (await edit(native, doc, 'add_adjustment', { kind: 'color_balance', value: 0, parameters: { shadows: [-10, 2, 4], preserveLuminosity: false } })).document;
  const adjustmentId = doc.layers.at(-1).id, mask = structuredClone(doc.layers.at(-1).mask);
  doc = (await edit(native, doc, 'update_adjustment', { layerId: adjustmentId, parameters: { midtones: [20.25, -5, 8] } })).document;
  const p = doc.layers.at(-1).parameters;
  assert.deepEqual(p, { shadows: [-10, 2, 4], midtones: [20.25, -5, 8], highlights: [0, 0, 0], preserveLuminosity: false });
  assert.deepEqual(doc.layers.at(-1).mask, mask);
  const rendered = await native.renderGraph(doc);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x, rgb = pixel(baseline, i).slice(0, 3), inside = x >= 2 && x < 5 && y >= 1 && y < 4 && baseline[i * 4 + 3];
    assert.deepEqual(pixel(rendered, i), inside ? [...exactBalance(rgb, p), baseline[i * 4 + 3]] : pixel(baseline, i));
  }
  doc = (await edit(native, doc, 'delete_layer', { layerId: adjustmentId })).document;
  doc = (await edit(native, doc, 'add_layer_filter', { layerId: photo.id, kind: 'black_white', value: 0, parameters: { tint: false, tintColor: '#FF0037', tintAmount: 51.25 } })).document;
  const filterId = doc.layers[0].filters[0].id;
  doc = (await edit(native, doc, 'update_layer_filter', { layerId: photo.id, filterId, parameters: { blues: -88.25 } })).document;
  const beforeTint = structuredClone(doc.layers[0].filters[0].parameters);
  assert.equal(beforeTint.tintColor, '#ff0037'); assert.equal(beforeTint.tintAmount, 51.25); assert.equal(beforeTint.reds, 40);
  doc = (await edit(native, doc, 'update_layer_filter', { layerId: photo.id, filterId, parameters: { tint: true } })).document;
  const output = await native.renderLayer(doc.layers[0]);
  for (let i = 0; i < width * height; i++) assert.deepEqual(pixel(output, i), source[i * 4 + 3] ? [...exactBlackWhite(pixel(source, i).slice(0, 3), { ...beforeTint, tint: true }), source[i * 4 + 3]] : pixel(source, i));
  assert.deepEqual(await files(native.assetsDir), assets);
  const sparse = base({ type: 'adjustment', kind: 'black_white', value: 0, parameters: { tint: false } });
  const sparseDoc = await project(native, width, height, [photo, sparse]);
  const prior = await get(native, sparseDoc); await native.renderGraph(sparseDoc);
  assert.deepEqual(await get(native, sparseDoc), prior, 'rendering effective defaults does not rewrite sparse metadata');
});

test('new mappings respect original lower protection in isolated clipping context and source inspection remains unfiltered', async t => {
  const { native } = await fixture(t), width = 9, height = 7, count = width * height;
  const personRaw = pixels(width, height, (x, y, i) => [37, 117, 209, x >= 3 && x <= 5 ? [1, 128, 255][i % 3] : 0]);
  const baseRaw = pixels(width, height, (x, y, i) => [113, 47, 83, [1, 128, 255][i % 3]]), memberRaw = pixels(width, height, (x, y, i) => [29, 157, 71, [128, 255][i % 2]]);
  const person = await raster(native, personRaw, width, height, { protected: true, outline: { width: 1, color: '#ffffff' } });
  const group = base({ type: 'group', mode: 'isolated' }), content = await raster(native, baseRaw, width, height, { parentId: group.id });
  const member = await raster(native, memberRaw, width, height, { parentId: group.id, clipBaseId: content.id, role: 'generated', provenance: { jobId: randomUUID(), mode: 'generate' }, visible: false });
  let doc = await project(native, width, height, [person, group, content, member]);
  const baseline = await native.renderGraph(doc), footprint = await native.protectedPixels(doc), assets = await files(native.assetsDir);
  doc = (await edit(native, doc, 'add_layer_filter', { layerId: content.id, kind: 'color_balance', value: 0, parameters: tie })).document;
  doc = (await edit(native, doc, 'add_layer_filter', { layerId: member.id, kind: 'black_white', value: 0, parameters: { tint: true } })).document;
  doc = (await edit(native, doc, 'set_layer', { layerId: member.id, visible: true })).document;
  for (const [kind, parameters] of [['color_balance', { shadows: [-50, 20, 40] }], ['black_white', { tint: true, tintColor: '#d4712c' }]]) {
    doc = (await edit(native, doc, 'add_adjustment', { kind, value: 0, parameters })).document;
    doc = (await edit(native, doc, 'move_layer', { layerId: doc.layers.at(-1).id, parentId: group.id })).document;
  }
  const actual = await native.renderGraph(doc);
  const preview = async (layerId, view = 'layer') => { const p = await native.execute('get_layer_preview', { documentId: doc.id, layerId, view, maxWidth: 32 }); return sharp(Buffer.from(p.data, 'base64')).ensureAlpha().raw().toBuffer(); };
  const contentView = await preview(content.id), memberView = await preview(member.id);
  let changed = 0;
  for (let i = 0; i < count; i++) if (footprint[i]) {
    assert.deepEqual(pixel(actual, i), pixel(baseline, i));
    assert.deepEqual(pixel(contentView, i), pixel(baseRaw, i));
    assert.equal(memberView[i * 4 + 3], 0);
  } else if (!actual.subarray(i * 4, i * 4 + 4).equals(baseline.subarray(i * 4, i * 4 + 4))) changed++;
  assert.ok(changed > 0); assert.deepEqual(await preview(member.id, 'source'), memberRaw);
  await assert.rejects(edit(native, doc, 'add_layer_filter', { layerId: person.id, kind: 'black_white', value: 0 }), { code: 'PROTECTED_LAYER' });
  assert.deepEqual(await files(native.assetsDir), assets);
});

test('canonical tonal recipes ignore target defaults, preserve masks and reproduce explicit edits on three unrelated documents without pixel work', async t => {
  const { native } = await fixture(t), width = 8, height = 6;
  const expectedBalance = { ...balanceDefaults(), midtones: [12.25, -9, 3] }, expectedBW = { ...bwDefaults(), tint: false, tintColor: '#ff0037', tintAmount: 18.23 };
  const definition = { name: 'Tonal independent reuse', slots: [{ key: 'photo', type: 'raster' }, { key: 'balance', type: 'adjustment', kind: 'color_balance' }, { key: 'mono', type: 'adjustment', kind: 'black_white' }], steps: [
    { command: 'add_layer_filter', target: 'photo', args: { kind: 'color_balance', value: 0, parameters: { midtones: [12.25, -9, 3] } } },
    { command: 'update_adjustment', target: 'balance', args: { value: 0, parameters: { midtones: [12.25, -9, 3] } } },
    { command: 'update_adjustment', target: 'mono', args: { value: 0, parameters: { tint: false, tintColor: '#FF0037', tintAmount: 18.23 } } },
  ] };
  for (let variant = 0; variant < 3; variant++) {
    const photo = await raster(native, pixels(width, height, (x, y, p) => [25 + variant + x * 17, 20 + y * 21, 174 - x * 11, [1, 128, 255][p % 3]]), width, height);
    const balance = base({ type: 'adjustment', kind: 'color_balance', value: 0, parameters: { ...tie, preserveLuminosity: false }, opacity: 0.5, mask: { shape: 'rectangle', x: 0, y: 0, width: 4, height: 4, feather: 0, invert: false }, maskDensity: 0.25 });
    const mono = base({ type: 'adjustment', kind: 'black_white', value: 0, parameters: { reds: -200, tint: true, tintColor: '#00ffff', tintAmount: 80 } });
    let doc = await project(native, width, height, [photo, balance, mono]); let control = await project(native, width, height, [photo, balance, mono]);
    const saved = await edit(native, doc, 'save_edit_recipe', definition); doc = saved.document;
    const recipe = doc.editRecipes.find(item => item.id === saved.recipeId);
    assert.deepEqual(recipe.steps[0].args.parameters, expectedBalance); assert.deepEqual(recipe.steps[1].args.parameters, expectedBalance); assert.deepEqual(recipe.steps[2].args.parameters, expectedBW);
    const args = { recipeId: saved.recipeId, bindings: { photo: photo.id, balance: balance.id, mono: mono.id } }, assets = await files(native.assetsDir), prior = structuredClone(doc);
    const report = await noPixels(native, () => edit(native, doc, 'validate_edit_recipe', args), true); assert.equal(report.valid, true); assert.deepEqual(await get(native, doc), prior);
    doc = (await noPixels(native, () => edit(native, doc, 'apply_edit_recipe', args))).document;
    for (const step of recipe.steps) control = (await edit(native, control, step.command, { layerId: args.bindings[step.target], ...step.args })).document;
    assert.deepEqual(await native.renderGraph(doc), await native.renderGraph(control));
    assert.deepEqual(doc.layers[1].parameters, expectedBalance); assert.deepEqual(doc.layers[1].mask, balance.mask); assert.equal(doc.layers[1].maskDensity, 0.25);
    assert.deepEqual(doc.layers[2].parameters, expectedBW); assert.equal(doc.history.length, prior.history.length + 1); assert.deepEqual(await files(native.assetsDir), assets);
    const undone = (await edit(native, doc, 'undo')).document; assert.deepEqual(undone.layers, prior.layers);
  }
});

test('preservation and cumulative filter budgets preflight hidden source metadata and reject activation without assets or partial publication', async t => {
  const { native } = await fixture(t), width = 4000, height = 2400;
  const photo = base({ type: 'raster', width, height, transforms: [], visible: false, asset: 'a'.repeat(64), sourceAsset: 'a'.repeat(64), sourceFormat: 'png' });
  let doc = await project(native, width, height, [photo]);
  assert.equal(filterWork(entry('color_balance'), width * height), 384000000);
  assert.equal(filterWork(entry('color_balance', { preserveLuminosity: false }), width * height), 96000000);
  assert.equal(filterWork(entry('black_white'), width * height), 67200000);
  doc = (await noPixels(native, () => edit(native, doc, 'add_layer_filter', { layerId: photo.id, kind: 'color_balance', value: 0 }))).document;
  const filterId = doc.layers[0].filters[0].id;
  await noPixels(native, () => assert.rejects(edit(native, doc, 'add_layer_filter', { layerId: photo.id, kind: 'brightness', value: 1 }), { code: 'LIMIT_EXCEEDED' }));
  assert.deepEqual(await get(native, doc), doc);
  doc = (await noPixels(native, () => edit(native, doc, 'update_layer_filter', { layerId: photo.id, filterId, parameters: { preserveLuminosity: false } }))).document;
  doc = (await noPixels(native, () => edit(native, doc, 'add_layer_filter', { layerId: photo.id, kind: 'brightness', value: 1 }))).document;
  const rejected = () => noPixels(native, () => assert.rejects(edit(native, doc, 'update_layer_filter', { layerId: photo.id, filterId, parameters: { preserveLuminosity: true } }), { code: 'LIMIT_EXCEEDED' }));
  await rejected(); assert.deepEqual(await get(native, doc), doc);
  doc = (await noPixels(native, () => edit(native, doc, 'update_layer_filter', { layerId: photo.id, filterId, enabled: false, parameters: { preserveLuminosity: true } }))).document;
  await noPixels(native, () => assert.rejects(edit(native, doc, 'update_layer_filter', { layerId: photo.id, filterId, enabled: true }), { code: 'LIMIT_EXCEEDED' }));
  assert.deepEqual(await get(native, doc), doc);
  const accepted = await edit(native, doc, 'save_edit_recipe', { name: 'Cumulative tonal budget', slots: [{ key: 'photo', type: 'raster' }], steps: [{ command: 'add_layer_filter', target: 'photo', args: { kind: 'color_balance', value: 0, parameters: { preserveLuminosity: false } } }, { command: 'add_layer_filter', target: 'photo', args: { kind: 'color_balance', value: 0 } }] }); doc = accepted.document;
  const args = { recipeId: accepted.recipeId, bindings: { photo: photo.id } };
  const report = await noPixels(native, () => edit(native, doc, 'validate_edit_recipe', args), true); assert.equal(report.valid, false); assert.equal(report.issues[0].stepIndex, 1); assert.equal(report.issues[0].code, 'LIMIT_EXCEEDED');
  await noPixels(native, () => assert.rejects(edit(native, doc, 'apply_edit_recipe', args), { code: 'LIMIT_EXCEEDED' }));
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await fs.readdir(native.assetsDir), []);
});

test('real persistence failure and stale revision preserve tonal parameters, sources, history and preview cache', async t => {
  const { native } = await fixture(t), width = 8, height = 6, photo = await raster(native, pixels(width, height, () => [1, 89, 1, 255]), width, height);
  let doc = await project(native, width, height, [photo]); doc = (await edit(native, doc, 'add_layer_filter', { layerId: photo.id, kind: 'color_balance', value: 0, parameters: tie })).document;
  await native.execute('get_preview', { documentId: doc.id, maxWidth: 32 });
  const assets = await files(native.assetsDir), projects = await files(native.projectsDir), cache = native.previewCache.stats(), args = { layerId: photo.id, filterId: doc.layers[0].filters[0].id, parameters: { preserveLuminosity: false } };
  await assert.rejects(edit(native, doc, 'update_layer_filter', { ...args, expectedRevision: doc.revision - 1 }), { code: 'REVISION_CONFLICT' });
  const directory = native.projectsDir; native.projectsDir = path.join(native.assetsDir, photo.asset);
  try { await assert.rejects(edit(native, doc, 'update_layer_filter', args), { code: 'ENOTDIR' }); } finally { native.projectsDir = directory; }
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await files(native.assetsDir), assets); assert.deepEqual(await files(native.projectsDir), projects); assert.deepEqual(native.previewCache.stats(), cache);
});

test('Color Balance yields bounded pixel chunks in both real paths, including an 8192-wide authored tie image', async t => {
  const { native } = await fixture(t);
  for (let width = 1; width <= 8192; width++) { const rows = colorTransformYieldRows('color_balance', width); assert.ok(rows >= 1 && rows <= 32 && rows * width <= 65536); }
  const width = 8192, height = 32, input = Buffer.alloc(width * height * 4);
  for (let i = 0; i < input.length; i += 4) { input[i] = 1; input[i + 1] = 89; input[i + 2] = 1; input[i + 3] = 255; }
  for (const mode of ['adjustment', 'filter']) for (const preserveLuminosity of [true, false]) {
    let heartbeats = 0; const interval = setInterval(() => { heartbeats++; }, 0);
    let output;
    try { output = mode === 'adjustment' ? await native.applyAdjustment(input, width, height, { kind: 'color_balance', value: 0, opacity: 1, parameters: { ...tie, preserveLuminosity } }) : await applyLayerFilters(input, width, height, [entry('color_balance', { ...tie, preserveLuminosity })]); } finally { clearInterval(interval); }
    assert.ok(heartbeats > 0, `${mode}/${preserveLuminosity} must yield before completion`);
    const expected = [...exactBalance([1, 89, 1], { ...tie, preserveLuminosity }), 255];
    for (let i = 0; i < width * height; i++) assert.deepEqual(pixel(output, i), expected);
  }
  assert.deepEqual(pixel(input, 0), [1, 89, 1, 255]);
});
