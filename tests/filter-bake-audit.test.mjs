import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { estimateFilterBakeBytes, encodeBakedPng, bakeFilterSource, FILTER_BAKE_LIMITS } from '../server/filter-bake.mjs';
import { openBoundedFile, readBoundedHandle } from '../server/bounded-file.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const base = extra => ({ id: randomUUID(), name: 'Bake independent audit', visible: true, opacity: 1, blendMode: 'normal', ...extra });
const filter = (kind = 'invert', value = 100, extra = {}) => ({ id: randomUUID(), kind, value, enabled: true, opacity: 1, ...extra });
const image = (width, height, fn) => Buffer.from(Array.from({ length: width * height }, (_, i) => typeof fn === 'function' ? fn(i % width, Math.floor(i / width), i) : fn).flat());
const edit = (native, doc, command, args = {}) => native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...(command === 'apply_transaction' ? { label: 'Independent bake transaction' } : {}), ...args });
const find = (doc, id) => doc.layers.find(layer => layer.id === id);
const get = async (native, doc) => (await native.execute('get_document', { documentId: doc.id })).document;
const files = async dir => Object.fromEntries(await Promise.all((await fs.readdir(dir)).sort().map(async name => [name, await fs.readFile(path.join(dir, name))])));
const rgba = bytes => sharp(bytes).toColourspace('srgb').ensureAlpha().raw().toBuffer();
const project = async (native, width, height, layers, extra = {}) => (await native.newProject({ name: 'Independent bake', width, height, layers, selection: null, ...extra }, 'Audit fixture')).document;
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-filter-bake-audit-'));
  const native = await new NativeBackend({ dataDir, segmentSubject: () => assert.fail('Baking must not call a model') }).init();
  t.after(async () => { await native.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { native, dataDir };
}
async function raster(native, bytes, width, height, extra = {}) {
  const asset = await native.storeAsset(await sharp(bytes, { raw: { width, height, channels: 4 } }).png().toBuffer());
  return base({ type: 'raster', asset, sourceAsset: asset, sourceFormat: 'png', width, height, transforms: [], ...extra });
}
async function forbidPixels(native, operation) {
  const restore = [];
  for (const key of ['render', 'renderGraph', 'renderLayer', 'readAlpha', 'storeAlpha', 'storeAsset', 'segmentSubject']) if (typeof native[key] === 'function') { const old = native[key]; native[key] = () => assert.fail(`Unexpected ${key}`); restore.push(() => { native[key] = old; }); }
  { const old = fs.readFile; fs.readFile = () => assert.fail('Unexpected fs.readFile'); restore.push(() => { fs.readFile = old; }); }
  { const old = fs.open; fs.open = (...args) => typeof args[0] === 'string' && path.dirname(args[0]) === native.projectsDir && args[1] === 'wx' ? old(...args) : assert.fail('Unexpected source fs.open'); restore.push(() => { fs.open = old; }); }
  try { return await operation(); } finally { restore.reverse().forEach(fn => fn()); }
}

test('bounded file readers reject growth, truncation, symlinks and corrupt digests without unbounded reads', async t => {
  const { dataDir } = await fixture(t), data = Buffer.from('exact-bounded-source'), file = path.join(dataDir, 'input');
  await fs.writeFile(file, data);
  const opened = await openBoundedFile(file, { maxBytes: 64, exactBytes: data.length });
  try { assert.deepEqual((await readBoundedHandle(opened.handle, { bytes: opened.bytes, expectedHash: hash(data) })).data, data); } finally { await opened.handle.close(); }
  await assert.rejects(openBoundedFile(file, { maxBytes: 64, exactBytes: data.length + 1 }), { code: 'INVALID_IMAGE' });
  await assert.rejects(openBoundedFile(file, { maxBytes: data.length - 1 }), { code: 'LIMIT_EXCEEDED' });
  const symlink = path.join(dataDir, 'link'); await fs.symlink(file, symlink); await assert.rejects(openBoundedFile(symlink, { maxBytes: 64 }), { code: 'INVALID_IMAGE' });
  let reads = 0, stats = 0;
  const fake = (afterSize, eof = false) => ({ stat: async () => ({ isFile: () => true, size: ++stats === 1 ? data.length : afterSize }), read: async (buffer, offset, length) => { reads++; const n = eof ? 0 : Math.min(3, length); data.copy(buffer, offset, offset, offset + n); return { bytesRead: n }; } });
  await assert.rejects(readBoundedHandle(fake(data.length + 1), { bytes: data.length }), { code: 'INVALID_IMAGE' }); assert.ok(reads > 1);
  reads = stats = 0; await assert.rejects(readBoundedHandle(fake(data.length, true), { bytes: data.length }), { code: 'INVALID_IMAGE' }); assert.equal(reads, 1);
  reads = stats = 0; await assert.rejects(readBoundedHandle(fake(data.length), { bytes: data.length, expectedHash: 'f'.repeat(64) }), { code: 'INVALID_IMAGE' });
  reads = 0; await assert.rejects(readBoundedHandle({ stat: async () => ({ isFile: () => true, size: data.length + 1 }), read: async () => { reads++; } }, { bytes: data.length }), { code: 'INVALID_IMAGE' }); assert.equal(reads, 0);
});

test('private-file PNG encoder preserves hidden RGBA and removes staging files on success and output refusal', async t => {
  const { dataDir } = await fixture(t), width = 7, height = 5, bytes = image(width, height, (x, y, i) => [i * 31 % 256, i * 47 % 256, i * 67 % 256, [0, 1, 128, 255][i % 4]]);
  const before = (await fs.readdir(dataDir)).sort();
  const encoded = await encodeBakedPng(bytes, width, height, { tempRoot: dataDir, maxBytes: 1024 * 1024 });
  assert.deepEqual(await rgba(encoded), bytes); assert.deepEqual((await fs.readdir(dataDir)).sort(), before);
  await assert.rejects(encodeBakedPng(bytes, width, height, { tempRoot: dataDir, maxBytes: 1 }), { code: 'LIMIT_EXCEEDED' });
  assert.deepEqual((await fs.readdir(dataDir)).sort(), before);
  assert.deepEqual(bytes, image(width, height, (x, y, i) => [i * 31 % 256, i * 47 % 256, i * 67 % 256, [0, 1, 128, 255][i % 4]]));
});

test('phase accounting includes encoded files, alpha and spatial candidates and refuses before decoding a metadata-only large source', async t => {
  for (const hasAlpha of [false, true]) for (const [width, height] of [[1, 1], [500, 500], [4000, 2400], [6000, 4000]]) {
    const s = width * height, ew = 12345, ea = hasAlpha ? 3456 : 0, encoded = ew + ea, p = Math.min(128 * 1024 * 1024, 5 * s + 1024 * 1024);
    const estimate = estimateFilterBakeBytes({ width, height, encodedWorkingBytes: ew, encodedAlphaBytes: ea, hasAlpha });
    assert.deepEqual([estimate.decodeBytes, estimate.filterBytes, estimate.encodeBytes, estimate.publicationBytes], [encoded + (hasAlpha ? 9 : 4) * s, encoded + (hasAlpha ? 17 : 12) * s + 65536, encoded + 8 * s + p, encoded + 4 * s + 2 * p]);
    assert.equal(estimate.estimatedWorkingBytes, Math.max(estimate.decodeBytes, estimate.filterBytes, estimate.encodeBytes, estimate.publicationBytes));
  }
  for (const input of [{ width: 8193, height: 1 }, { width: 8192, height: 8192 }, { width: 1, height: 1, encodedWorkingBytes: Infinity }, { width: 1, height: 1, encodedAlphaBytes: 1, hasAlpha: false }]) assert.throws(() => estimateFilterBakeBytes(input));
  const { native, dataDir } = await fixture(t), small = await raster(native, Buffer.from([1, 2, 3, 255]), 1, 1);
  const layer = { ...small, width: 4096, height: 4096, alphaAsset: small.asset };
  await assert.rejects(bakeFilterSource({ layer, filters: [filter()], assetsDir: native.assetsDir, tempRoot: dataDir }), { code: 'LIMIT_EXCEEDED' });
  // Valid tiny files stand in for a huge source: the work ledger must refuse
  // before the decoder could complain about their intentionally wrong size.
  assert.equal((await fs.readdir(dataDir)).some(name => name.startsWith('.filter-bake-')), false);
});

test('actual bake preserves original alpha and immutable cutout/original bytes while freezing only effective RGB', async t => {
  const { native } = await fixture(t), width = 8, height = 6;
  const bytes = image(width, height, (x, y, i) => [20 + i * 3 % 200, 40 + i * 7 % 180, 60 + i * 11 % 160, [0, 1, 128, 255][i % 4]]);
  const alpha = Buffer.from(Array.from({ length: width * height }, (_, i) => [0, 1, 128, 255, 193][i % 5]));
  const photo = await raster(native, bytes, width, height, { filters: [filter('invert', 100, { opacity: 0.5 }), filter('brightness', 20, { opacity: 0.25 })] });
  photo.alphaAsset = await native.storeAlpha(alpha, width, height);
  let doc = await project(native, width, height, [photo]); const before = await native.renderGraph(doc), oldFiles = await files(native.assetsDir), prior = structuredClone(doc);
  doc = (await edit(native, doc, 'bake_layer_filters', { layerId: photo.id })).document;
  const baked = find(doc, photo.id), stored = await rgba(await fs.readFile(path.join(native.assetsDir, baked.asset)));
  assert.deepEqual(baked.filters, []); assert.notEqual(baked.asset, photo.asset);
  assert.equal(baked.sourceAsset, photo.sourceAsset); assert.equal(baked.alphaAsset, photo.alphaAsset);
  for (let i = 0; i < width * height; i++) {
    const effective = Math.round(bytes[i * 4 + 3] * alpha[i] / 255);
    assert.equal(stored[i * 4 + 3], bytes[i * 4 + 3]);
    for (let c = 0; c < 3; c++) {
      const original = bytes[i * 4 + c], inverted = Math.round(original + (255 - 2 * original) * 0.5), brightened = Math.max(0, Math.min(255, Math.round(inverted + 20 * 2.55)));
      const expected = effective ? Math.round(inverted + (brightened - inverted) * 0.25) : original;
      assert.equal(stored[i * 4 + c], expected);
    }
  }
  assert.deepEqual(await native.renderGraph(doc), before);
  for (const [name, data] of Object.entries(oldFiles)) assert.deepEqual(await fs.readFile(path.join(native.assetsDir, name)), data);
  doc = (await edit(native, doc, 'undo')).document; assert.deepEqual(doc.layers, prior.layers);
});

test('active bake refuses every earlier protected scope before source I/O, while bypass clearing needs no source files', async t => {
  const { native } = await fixture(t), width = 8, height = 6;
  const source = await raster(native, image(width, height, [40, 80, 160, 255]), width, height, { filters: [filter()] });
  const earlier = await raster(native, image(width, height, [180, 120, 60, 255]), width, height, { protected: true });
  for (const variant of [{ visible: false }, { opacity: 0 }, { mask: { shape: 'bitmap', x: 0, y: 0, width, height, feather: 0, invert: false, runs: [] } }, { nested: true }]) {
    const group = base({ type: 'group', mode: 'isolated', visible: false }), person = { ...earlier, ...variant }; delete person.nested;
    if (variant.nested) person.parentId = group.id;
    const layers = variant.nested ? [group, person, source] : [person, source], doc = await project(native, width, height, layers);
    await forbidPixels(native, () => assert.rejects(edit(native, doc, 'bake_layer_filters', { layerId: source.id }), { code: 'FILTER_BAKE_PROTECTED_CONTEXT' }));
    assert.deepEqual(await get(native, doc), doc);
  }
  const inactive = { ...source, filters: [filter('invert', 100, { enabled: false }), filter('brightness', 20, { opacity: 0 })], asset: 'a'.repeat(64), sourceAsset: 'a'.repeat(64) };
  let doc = await project(native, width, height, [earlier, inactive]); const assets = await files(native.assetsDir);
  // Persist is the only allowed filesystem writer; there is no image read.
  const result = await forbidPixels(native, () => edit(native, doc, 'bake_layer_filters', { layerId: inactive.id })); doc = result.document;
  assert.deepEqual(find(doc, inactive.id).filters, []); assert.equal(find(doc, inactive.id).asset, inactive.asset); assert.deepEqual(await files(native.assetsDir), assets);
});

test('source baking keeps geometry, clipping/group context, later protected pixels and generated exclusion byte-exact', async t => {
  const { native } = await fixture(t), width = 9, height = 7;
  const group = base({ type: 'group', mode: 'isolated', blendMode: 'multiply', opacity: 0.6, mask: { x: 0, y: 0, width: 8, height: 6 }, maskDensity: 0.5 });
  const backdrop = base({ type: 'solid', color: '#aabbcc', width, height, transforms: [] });
  const content = await raster(native, image(width, height, (x, y, i) => [15 + i % 180, 80, 140, [0, 1, 128, 255][i % 4]]), width, height, { parentId: group.id, filters: [filter('mosaic', 3), filter('invert', 100, { opacity: 0.37 })], transforms: [{ type: 'affine', width, height, x: 0.25, y: -0.3, scaleX: 1.2, scaleY: 0.9, rotation: 17, flipX: true, flipY: false }], mask: { shape: 'positioned', sourceWidth: width, sourceHeight: height, x: 1, y: 0, source: { shape: 'ellipse', x: 1, y: 1, width: 5, height: 4, feather: 1.2, invert: true } }, maskDensity: 0.4 });
  const member = await raster(native, image(width, height, [100, 50, 150, 128]), width, height, { parentId: group.id, clipBaseId: content.id, filters: [filter('color_balance', 0, { parameters: { shadows: [100, -100, 100], midtones: [100, -100, 100], highlights: [100, -100, 100] } })] });
  const person = await raster(native, image(width, height, (x, y) => [120, 83, 41, x > 5 && y > 2 ? 255 : 0]), width, height, { protected: true, outline: { width: 1, color: '#ffffff' } });
  let doc = await project(native, width, height, [backdrop, group, content, member, person]); const before = await native.renderGraph(doc), preserved = structuredClone(doc.layers);
  for (const id of [content.id, member.id]) doc = (await edit(native, doc, 'bake_layer_filters', { layerId: id })).document;
  assert.deepEqual(await native.renderGraph(doc), before);
  for (const id of [content.id, member.id]) { const old = find({ layers: preserved }, id), now = find(doc, id); for (const key of Object.keys(old).filter(key => !['asset', 'filters'].includes(key))) assert.deepEqual(now[key], old[key]); }
  // Generated pixels keep dynamic display exclusion after becoming ordinary
  // working RGB; a later protected-layer move still changes that exclusion.
  const generated = await raster(native, image(width, height, [10, 20, 30, 255]), width, height, { role: 'generated', provenance: { jobId: randomUUID(), mode: 'generate' }, filters: [filter()] });
  let genDoc = await project(native, width, height, [generated, person]); const genBefore = await native.renderGraph(genDoc);
  genDoc = (await edit(native, genDoc, 'bake_layer_filters', { layerId: generated.id })).document;
  assert.deepEqual(await native.renderGraph(genDoc), genBefore); assert.equal(find(genDoc, generated.id).role, 'generated'); assert.deepEqual(find(genDoc, generated.id).provenance, generated.provenance);
  genDoc = (await edit(native, genDoc, 'reorder_layer', { layerId: person.id, index: 0 })).document;
  const footprint = await native.protectedPixels(genDoc), inspected = await native.execute('get_layer_preview', { documentId: genDoc.id, layerId: generated.id, view: 'layer', maxWidth: 32 });
  const visible = await rgba(Buffer.from(inspected.data, 'base64')); let excluded = 0;
  for (let i = 0; i < footprint.length; i++) if (footprint[i]) { excluded++; assert.equal(visible[i * 4 + 3], 0); }
  assert.ok(excluded > 0, 'baked generated content retains dynamic exclusion after lower protection moves into scope');
});

test('whole-operation asset ownership rolls back bake and later retouch on late or real persistence failure, retaining deduplicated originals', async t => {
  const { native } = await fixture(t), width = 16, height = 9;
  const source = await raster(native, image(width, height, (x, y) => [20 + x * 7, 40 + y * 9, 180 - x * 5, 255]), width, height, { filters: [filter()] });
  const doc = await project(native, width, height, [source]); await native.execute('get_preview', { documentId: doc.id, maxWidth: 32 });
  const beforeAssets = await files(native.assetsDir), beforeProjects = await files(native.projectsDir), beforeCache = native.previewCache.stats();
  const originalStore = native.storeAsset.bind(native); let publications = 0;
  native.storeAsset = async (...args) => { const result = await originalStore(...args); publications++; return result; };
  const operations = [{ command: 'bake_layer_filters', args: { layerId: source.id } }, { command: 'paint_stroke', args: { layerId: source.id, tool: 'clone', points: [{ x: 9.5, y: 4.5 }, { x: 13.5, y: 4.5 }], source: { x: 2.5, y: 4.5 }, size: 3, hardness: 1, opacity: 0.7, sampleMode: 'current' } }];
  await assert.rejects(edit(native, doc, 'apply_transaction', { operations: [...operations, { command: 'set_layer', args: { layerId: randomUUID(), name: 'Missing' } }] }), { code: 'NOT_FOUND' });
  assert.equal(publications, 2, 'bake and retouch both reach asset publication before the final target fails');
  assert.deepEqual(await files(native.assetsDir), beforeAssets); assert.deepEqual(await files(native.projectsDir), beforeProjects); assert.deepEqual(native.previewCache.stats(), beforeCache);
  const oldDir = native.projectsDir; native.projectsDir = path.join(native.assetsDir, source.asset);
  try { await assert.rejects(edit(native, doc, 'bake_layer_filters', { layerId: source.id }), { code: 'ENOTDIR' }); await assert.rejects(edit(native, doc, 'apply_transaction', { operations }), { code: 'ENOTDIR' }); } finally { native.projectsDir = oldDir; }
  assert.equal(publications, 5, 'standalone and transaction publication both precede actual filesystem refusal');
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await files(native.assetsDir), beforeAssets); assert.deepEqual(await files(native.projectsDir), beforeProjects); assert.deepEqual(native.previewCache.stats(), beforeCache);
  // Publish one valid identical bake so a later failed duplicate must retain
  // that preexisting hash instead of confusing EEXIST with ownership.
  const control = await project(native, width, height, [source]); const baked = (await edit(native, control, 'bake_layer_filters', { layerId: source.id })).document;
  const sharedFiles = await files(native.assetsDir);
  await assert.rejects(edit(native, doc, 'apply_transaction', { operations: [...operations, { command: 'set_layer', args: { layerId: randomUUID(), opacity: 0.5 } }] }), { code: 'NOT_FOUND' });
  assert.deepEqual(await files(native.assetsDir), sharedFiles); assert.ok(sharedFiles[find(baked, source.id).asset]);
  const repairId = randomUUID(), mixed = [operations[0], { command: 'create_repair_layer', args: { sourceLayerId: source.id, newLayerId: repairId } }, { ...operations[1], args: { ...operations[1].args, layerId: repairId, sampleMode: 'current-and-below' } }, { command: 'set_layer', args: { layerId: randomUUID(), opacity: 0.5 } }];
  const beforeMixed = publications;
  await assert.rejects(edit(native, doc, 'apply_transaction', { operations: mixed }), { code: 'NOT_FOUND' });
  assert.equal(publications - beforeMixed, 3, 'bake, empty repair layer and repair stroke all publish before rollback');
  assert.deepEqual(await files(native.assetsDir), sharedFiles); assert.deepEqual(await get(native, doc), doc);
});

test('source input limits and corruption reject without staging output or exposing paths', async t => {
  const { native, dataDir } = await fixture(t), photo = await raster(native, Buffer.from([20, 60, 110, 255]), 1, 1, { filters: [filter()] });
  const run = layer => bakeFilterSource({ layer, filters: layer.filters, assetsDir: native.assetsDir, tempRoot: dataDir });
  const missing = { ...photo, asset: 'a'.repeat(64) };
  await assert.rejects(run(missing), error => error.code === 'INVALID_IMAGE' && !error.message.includes(dataDir));
  const wrongFormat = await native.storeAsset(Buffer.from('<svg width="1" height="1"></svg>'));
  await assert.rejects(run({ ...photo, asset: wrongFormat }), { code: 'INVALID_IMAGE' });
  const wrongSize = { ...photo, width: 2 };
  await assert.rejects(run(wrongSize), { code: 'INVALID_IMAGE' });
  const alpha = await native.storeAlpha(Buffer.from([255, 128]), 2, 1);
  await assert.rejects(run({ ...photo, alphaAsset: alpha }), { code: 'INVALID_IMAGE' });
  const corruptPath = path.join(native.assetsDir, photo.asset), original = await fs.readFile(corruptPath);
  await fs.writeFile(corruptPath, Buffer.from(original.map((value, index) => index === 40 ? value ^ 1 : value)));
  await assert.rejects(run(photo), { code: 'INVALID_IMAGE' }); await fs.writeFile(corruptPath, original);
  const oversized = path.join(native.assetsDir, missing.asset), handle = await fs.open(oversized, 'wx');
  try { await handle.truncate(FILTER_BAKE_LIMITS.maxAssetBytes + 1); } finally { await handle.close(); }
  await assert.rejects(run(missing), { code: 'LIMIT_EXCEEDED' }); await fs.unlink(oversized);
  assert.equal((await fs.readdir(dataDir)).some(name => name.startsWith('.filter-bake-')), false);
});

test('failed bake transaction removes only its own new hashes while unrelated helper publication survives', async t => {
  const { native } = await fixture(t), width = 8, height = 6;
  const source = await raster(native, image(width, height, [90, 120, 70, 255]), width, height, { filters: [filter()] });
  const doc = await project(native, width, height, [source]), before = await files(native.assetsDir), originalStore = native.storeAsset.bind(native);
  let signal, resume, trapped = false;
  const reached = new Promise(resolve => { signal = resolve; }), gate = new Promise(resolve => { resume = resolve; });
  native.storeAsset = async (...args) => { const result = await originalStore(...args); if (!trapped) { trapped = true; signal(); await gate; } return result; };
  const pending = edit(native, doc, 'apply_transaction', { operations: [{ command: 'bake_layer_filters', args: { layerId: source.id } }, { command: 'set_layer', args: { layerId: randomUUID(), opacity: 0.5 } }] });
  const rejected = assert.rejects(pending, { code: 'NOT_FOUND' }); await Promise.race([reached, pending.then(() => assert.fail('Transaction unexpectedly completed before publication gate'), cause => { throw cause; })]);
  const unrelatedBytes = await sharp(Buffer.from([31, 67, 101, 199]), { raw: { width: 1, height: 1, channels: 4 } }).png().toBuffer();
  const unrelated = await originalStore(unrelatedBytes); resume(); await rejected; native.storeAsset = originalStore;
  assert.deepEqual(await files(native.assetsDir), { ...before, [unrelated]: unrelatedBytes }); assert.deepEqual(await get(native, doc), doc);
});

test('bounded dedupe refuses oversized or symlinked hash files before reading and preserves corrupt originals', async t => {
  const { native, dataDir } = await fixture(t), bytes = await sharp(Buffer.from([20, 60, 110, 255]), { raw: { width: 1, height: 1, channels: 4 } }).png().toBuffer();
  const id = hash(bytes), file = path.join(native.assetsDir, id), corrupt = Buffer.concat([bytes, Buffer.from('longer')]);
  await fs.writeFile(file, corrupt);
  const originalRead = fs.readFile; let unboundedReads = 0; fs.readFile = (...args) => { unboundedReads++; return originalRead(...args); };
  try { await assert.rejects(native.storeAsset(bytes), { code: 'CORRUPT_ASSET' }); } finally { fs.readFile = originalRead; }
  assert.equal(unboundedReads, 0); assert.deepEqual(await fs.readFile(file), corrupt); assert.deepEqual(await fs.readdir(native.assetsDir), [id]);
  await fs.unlink(file); const outside = path.join(dataDir, 'outside.png'); await fs.writeFile(outside, bytes); await fs.symlink(outside, file);
  await assert.rejects(native.storeAsset(bytes), { code: 'CORRUPT_ASSET' }); assert.equal((await fs.lstat(file)).isSymbolicLink(), true); assert.deepEqual(await fs.readFile(outside), bytes);
});
