import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { bitmapBytes } from '../server/masks.mjs';
import { decodePackBitsRow, knownSrgbProfile } from '../server/psd-import.mjs';
import { PsdImportPool } from '../server/psd-import-pool.mjs';

const expected = JSON.parse(await fs.readFile(new URL('./fixtures/psd-import/expected.json', import.meta.url), 'utf8'));
const inputs = await Promise.all(expected.map(item => fs.readFile(new URL(`./fixtures/psd-import/${item.filename}`, import.meta.url))));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const files = async directory => Object.fromEntries(await Promise.all((await fs.readdir(directory)).sort().map(async name => [name, await fs.readFile(path.join(directory, name))])));
const edit = async (native, doc, command, args = {}) => (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document;
const current = async (native, doc) => (await native.execute('get_document', { documentId: doc.id })).document;
const request = (data, extra = {}) => ({ data, expectedSha256: hash(data), importerVersion: 1, requestId: randomUUID(), assumeSrgb: true, sourceName: 'Independent original.psd', ...extra });
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-psd-import-audit-'));
  const native = await new NativeBackend({ dataDir }).init();
  t.after(async () => { await native.close?.(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { native, dataDir };
}

// A trusted-fixture byte walker, independent of the production parser. It only
// locates records and payloads for exact assertions and bounded mutations.
function layout(data) {
  let at = 26;
  const u16 = () => { const n = data.readUInt16BE(at); at += 2; return n; };
  const i16 = () => { const n = data.readInt16BE(at); at += 2; return n; };
  const u32 = () => { const n = data.readUInt32BE(at); at += 4; return n; };
  const i32 = () => { const n = data.readInt32BE(at); at += 4; return n; };
  let size = u32(); at += size;
  const resources = [], resourceLengthAt = at; size = u32(); const resourcesEnd = at + size;
  while (at < resourcesEnd) {
    const start = at; assert.equal(data.toString('ascii', at, at + 4), '8BIM'); at += 4;
    const idAt = at, id = u16(), nameLength = data[at++]; at += nameLength;
    if ((nameLength + 1) % 2) at++;
    const sizeAt = at, bytes = u32(), payload = at; at += bytes + bytes % 2;
    resources.push({ start, idAt, id, sizeAt, bytes, payload });
  }
  assert.equal(at, resourcesEnd);
  const outerLengthAt = at, outerBytes = u32(), outerEnd = at + outerBytes;
  const infoLengthAt = at, infoBytes = u32(), infoEnd = at + infoBytes;
  const countAt = at, count = i16(), layers = [];
  for (let index = 0; index < count; index++) {
    const start = at, rectangle = [i32(), i32(), i32(), i32()], channels = [], channelCount = u16();
    for (let c = 0; c < channelCount; c++) { const idAt = at, id = i16(), lengthAt = at, bytes = u32(); channels.push({ idAt, id, lengthAt, bytes }); }
    assert.equal(data.toString('ascii', at, at + 4), '8BIM'); at += 4;
    const blendAt = at; at += 4; const opacityAt = at++, clippingAt = at++, flagsAt = at++, fillerAt = at++;
    const extraLengthAt = at, extraBytes = u32(), extraEnd = at + extraBytes;
    const maskLengthAt = at, maskBytes = u32(), maskAt = at; at += maskBytes;
    const rangesLengthAt = at, rangesBytes = u32(), rangesAt = at; at += rangesBytes;
    const pascalAt = at, nameLength = data[at++]; at += nameLength; at += (4 - ((nameLength + 1) % 4)) % 4;
    const tags = [];
    while (at < extraEnd) {
      const signature = data.toString('ascii', at, at + 4); assert.equal(signature, '8BIM'); at += 4;
      const keyAt = at, key = data.toString('ascii', at, at + 4); at += 4;
      const lengthAt = at, bytes = u32(), payload = at; at += bytes + bytes % 2; tags.push({ keyAt, key, lengthAt, bytes, payload });
    }
    assert.equal(at, extraEnd);
    layers.push({ start, rectangle, channels, blendAt, opacityAt, clippingAt, flagsAt, fillerAt, extraLengthAt, extraEnd, maskLengthAt, maskAt, maskBytes, rangesLengthAt, rangesBytes, rangesAt, pascalAt, tags });
  }
  for (const layer of layers) for (const channel of layer.channels) { channel.start = at; channel.compression = data.readUInt16BE(at); channel.payload = at + 2; at += channel.bytes; }
  assert.ok(at <= infoEnd && infoEnd - at <= 1);
  return { resources, resourceLengthAt, outerLengthAt, outerEnd, infoLengthAt, infoEnd, countAt, layers, mergedAt: outerEnd };
}

function projectedMask(entry, width, height) {
  if (!entry.mask) return undefined;
  const [left, top, right, bottom] = entry.maskBounds, maskWidth = right - left;
  return Buffer.from(Array.from({ length: width * height }, (_, index) => {
    const x = index % width, y = Math.floor(index / width);
    return x >= left && x < right && y >= top && y < bottom ? entry.mask[(y - top) * maskWidth + x - left] : entry.maskDefault;
  }));
}

test('independent raw and PackBits PSDs preserve exact source channels, masks, identity, names, archive and portable graph', async t => {
  const { native, dataDir } = await fixture(t);
  for (let index = 0; index < inputs.length; index++) {
    const data = inputs[index], foreign = expected[index], options = request(data), before = await files(native.assetsDir);
    const untagged = await native.inspectPsdImport({ data });
    assert.equal(untagged.supported, false); assert.equal(untagged.requiresSrgbAssumption, true);
    const report = await native.inspectPsdImport({ data, assumeSrgb: true });
    assert.equal(report.supported, true); assert.equal(report.validation, 'complete'); assert.equal(report.input.sha256, hash(data)); assert.equal(report.input.bytes, data.length);
    assert.equal(report.color.policy, 'assumed-srgb'); assert.equal(report.document.layerCount, 3); assert.deepEqual(await files(native.assetsDir), before);
    const result = await native.importPsd(options), doc = result.document;
    assert.equal(result.historyIncluded, false); assert.equal(doc.revision, 1); assert.equal(doc.history.length, 1); assert.equal(doc.layers.length, 3);
    assert.deepEqual([doc.width, doc.height], [foreign.width, foreign.height]); assert.equal(doc.sourceDocument.asset, hash(data)); assert.equal(doc.sourceDocument.bytes, data.length);
    assert.equal(doc.sourceDocument.format, 'psd'); assert.equal(doc.sourceDocument.name, options.sourceName);
    assert.equal(new Set(doc.layers.map(layer => layer.id)).size, 3);
    for (let l = 0; l < doc.layers.length; l++) {
      const layer = doc.layers[l], entry = foreign.layers[l];
      assert.equal(layer.type, 'raster'); assert.equal(layer.name, entry.name); assert.equal(layer.visible, entry.visible); assert.equal(layer.opacity, entry.opacity / 255); assert.ok(!layer.protected && !layer.provenance?.jobId);
      const raw = await sharp(await fs.readFile(path.join(native.assetsDir, layer.sourceAsset))).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      assert.deepEqual([raw.info.width, raw.info.height], [entry.bounds[2] - entry.bounds[0], entry.bounds[3] - entry.bounds[1]]); assert.deepEqual(raw.data, Buffer.from(entry.rgba));
      const mask = projectedMask(entry, foreign.width, foreign.height);
      if (mask) assert.deepEqual(Buffer.from(bitmapBytes(layer.mask)), mask); else assert.ok(!layer.mask);
    }
    assert.ok(result.report.warnings.some(item => item.code === 'OFF_CANVAS_GEOMETRY_CLIPPED'));
    assert.deepEqual((await native.exportOriginalPsd({ documentId: doc.id, expectedRevision: doc.revision })).data, data);
    const changed = await edit(native, doc, 'set_layer', { layerId: doc.layers[0].id, name: 'Edited native layer' });
    assert.deepEqual((await native.exportOriginalPsd({ documentId: doc.id })).data, data);
    const bundle = await native.exportProject({ documentId: doc.id }), imported = await native.importProject({ data: bundle.data });
    assert.notEqual(imported.document.id, doc.id); assert.deepEqual(imported.document.sourceDocument, doc.sourceDocument);
    assert.deepEqual(await native.renderGraph(imported.document), await native.renderGraph(changed));
    assert.deepEqual((await native.exportOriginalPsd({ documentId: imported.document.id })).data, data);
  }
  const reopened = await new NativeBackend({ dataDir }).init();
  for (const doc of (await reopened.execute('list_documents')).documents) assert.deepEqual((await reopened.exportOriginalPsd({ documentId: doc.id })).data, inputs.find(data => hash(data) === doc.sourceDocument.asset));
  await reopened.close?.();
});

test('simple disabled/inverted user masks retain independent source alpha and document-default coverage', async t => {
  const { native } = await fixture(t), original = inputs[0], structure = layout(original), target = structure.layers[2];
  assert.equal(target.maskBytes, 20);
  for (const maskDefault of [0, 255]) for (const flags of [0, 2, 4, 6]) {
    const data = Buffer.from(original); data[target.maskAt + 16] = maskDefault; data[target.maskAt + 17] = flags;
    const result = await native.importPsd(request(data)), layer = result.document.layers[2], entry = { ...expected[0].layers[2], maskDefault };
    assert.deepEqual(await sharp(await fs.readFile(path.join(native.assetsDir, layer.sourceAsset))).ensureAlpha().raw().toBuffer(), Buffer.from(entry.rgba));
    assert.deepEqual(Buffer.from(bitmapBytes(layer.mask)), projectedMask(entry, 9, 6));
    assert.equal(layer.mask.invert, Boolean(flags & 4)); assert.equal(layer.maskDensity ?? 1, flags & 2 ? 0 : 1);
    if (flags & 2) assert.ok(result.report.warnings.some(item => item.code === 'MASK_DISABLE_MAPPED_TO_DENSITY'));
    const visible = { ...result.document, layers: [{ ...layer, opacity: 1, visible: true }] }, image = await native.renderGraph(visible);
    for (let y = 0; y < 6; y++) for (let x = 0; x < 9; x++) {
      const within = x >= 3 && x < 6 && y < 5, alpha = within ? entry.rgba[(y * 3 + x - 3) * 4 + 3] : 0;
      let coverage = projectedMask(entry, 9, 6)[y * 9 + x] / 255;
      if (flags & 4) coverage = 1 - coverage;
      if (flags & 2) coverage = 1;
      assert.equal(image[(y * 9 + x) * 4 + 3], Math.round(alpha * coverage));
    }
  }
});

test('unsupported and corrupt PSD records never become partial raster imports, including disabled and hidden data', async t => {
  const { native } = await fixture(t), raw = inputs[0], structure = layout(raw), masked = structure.layers[1];
  const cases = [
    ['magic', data => data.write('NOPE', 0)], ['PSB', data => data.writeUInt16BE(2, 4)], ['depth', data => data.writeUInt16BE(16, 22)],
    ['CMYK', data => data.writeUInt16BE(4, 24)], ['merged alpha', data => data.writeUInt16BE(4, 12)], ['negative count', data => data.writeInt16BE(-3, structure.countAt)],
    ['zero count', data => data.writeInt16BE(0, structure.countAt)], ['non-normal hidden blend', data => data.write('mul ', masked.blendAt)],
    ['clipping', data => { data[masked.clippingAt] = 1; }], ['irrelevant pixels', data => { data[masked.flagsAt] |= 16; }],
    ['relative mask', data => { data[masked.maskAt + 17] = 1; }], ['parameter mask', data => { data[masked.maskAt + 17] = 16; }],
    ['unknown resource', data => data.writeUInt16BE(65534, structure.resources[0].idAt)], ['unknown tag', data => data.write('zzzz', masked.tags[0].keyAt)],
    ['non-default ranges', data => { data[masked.rangesAt] = 1; }], ['duplicate channel', data => data.writeInt16BE(0, masked.channels[0].idAt)],
    ['real mask channel', data => data.writeInt16BE(-3, masked.channels.find(channel => channel.id === -2).idAt)],
    ['ZIP channel', data => data.writeUInt16BE(2, masked.channels[0].start)], ['source bounds overlimit', data => data.writeInt32BE(9000, masked.start + 12)],
    ['section overrun', data => data.writeUInt32BE(0xffffffff, structure.infoLengthAt)], ['extra-data overrun', data => data.writeUInt32BE(0xffffffff, masked.extraLengthAt)],
    ['channel overrun', data => data.writeUInt32BE(0xffffffff, masked.channels[0].lengthAt)], ['Unicode overrun', data => data.writeUInt32BE(0xffffffff, masked.tags[0].payload)],
  ];
  const before = await files(native.assetsDir);
  for (const [label, change] of cases) {
    const data = Buffer.from(raw); change(data);
    let rejected = false;
    try { const report = await native.inspectPsdImport({ data, assumeSrgb: true }); rejected = report.supported === false; } catch (cause) { assert.ok(cause.code, `${label}: typed error`); rejected = true; }
    assert.ok(rejected, label);
    await assert.rejects(native.importPsd(request(data)), undefined, label);
  }
  for (const data of [raw.subarray(0, 25), raw.subarray(0, structure.layers[2].channels.at(-1).start + 1), raw.subarray(0, raw.length - 1), Buffer.concat([raw, Buffer.from([177])])]) await assert.rejects(native.importPsd(request(data)));
  const rle = inputs[1], compressed = layout(rle), channel = compressed.layers[1].channels[1];
  for (const mutate of [data => data.writeUInt16BE(0, channel.payload), data => data.writeUInt16BE(65535, channel.payload), data => { data[channel.payload + 6] = 127; }]) {
    const data = Buffer.from(rle); mutate(data); await assert.rejects(native.importPsd(request(data)));
  }
  assert.equal(native.projects.size, 0); assert.deepEqual(await files(native.assetsDir), before); assert.deepEqual(await files(native.projectsDir), {});
});

test('call-time input snapshots and exact logical views prevent queued mutation and backing-buffer overreads', async t => {
  const { native } = await fixture(t), original = inputs[0], mutable = Buffer.from(original), suppliedHash = hash(mutable);
  const pending = native.inspectPsdImport({ data: mutable, assumeSrgb: true }); mutable.fill(0);
  const report = await pending; assert.equal(report.supported, true); assert.equal(report.input.sha256, suppliedHash);
  const surrounded = Buffer.alloc(original.length + 64, 177); original.copy(surrounded, 23);
  const view = surrounded.subarray(23, 23 + original.length), good = await native.inspectPsdImport({ data: view, assumeSrgb: true });
  assert.equal(good.input.sha256, hash(original)); assert.equal(good.input.bytes, original.length);
  const truncated = view.subarray(0, view.length - 1);
  await assert.rejects(native.importPsd(request(truncated)), 'last byte cannot be borrowed from backing storage');
  const mutableImport = Buffer.from(original), operation = native.importPsd(request(mutableImport)); mutableImport.fill(0);
  const imported = await operation;
  const archived = await native.exportOriginalPsd({ documentId: imported.document.id }); assert.deepEqual(archived.data, original);
  archived.data.fill(0); archived.filename = 'Caller modified result';
  assert.deepEqual((await native.exportOriginalPsd({ documentId: imported.document.id })).data, original);
});

test('durable same-request identity coalesces imports, rejects changed bytes/options and survives restart without portable receipt inheritance', async t => {
  const { native, dataDir } = await fixture(t), options = request(inputs[1]);
  const [first, second] = await Promise.all([native.importPsd(options), native.importPsd(options)]);
  assert.equal(first.document.id, second.document.id); assert.equal(native.projects.size, 1);
  const projectFile = JSON.parse(await fs.readFile(path.join(native.projectsDir, `${first.document.id}.json`), 'utf8'));
  assert.equal(projectFile.psdImportReceipt.requestId, options.requestId);
  for (const changed of [{ name: 'Different interpretation name' }, { assumeSrgb: false }, { sourceName: 'Different original.psd' }]) await assert.rejects(async () => native.importPsd({ ...options, ...changed }), { code: 'REQUEST_CONFLICT' });
  await assert.rejects(async () => native.importPsd({ ...options, expectedSha256: '0'.repeat(64) }), { code: 'INSPECTION_STALE' });
  await assert.rejects(async () => native.importPsd({ ...options, importerVersion: 2 }), { code: 'INSPECTION_STALE' });
  const modified = await edit(native, first.document, 'set_layer', { layerId: first.document.layers[0].id, name: 'Edited after import' });
  const portable = await native.exportProject({ documentId: modified.id }), cloned = await native.importProject({ data: portable.data });
  const cloneFile = JSON.parse(await fs.readFile(path.join(native.projectsDir, `${cloned.document.id}.json`), 'utf8'));
  assert.equal(cloneFile.psdImportReceipt, undefined);
  const reopened = await new NativeBackend({ dataDir }).init(), repeated = await reopened.importPsd(options);
  assert.equal(repeated.document.id, first.document.id); assert.equal(repeated.document.revision, modified.revision); assert.equal(reopened.projects.size, 2);
  assert.deepEqual((await reopened.exportOriginalPsd({ documentId: repeated.document.id })).data, inputs[1]);
  await reopened.close?.();
});

test('failed asset publication and project persistence remove only newly created files and leave request identity retryable', async t => {
  const { native } = await fixture(t), data = inputs[0], options = request(data);
  // A shared existing archive is deliberately present before the failed import.
  const archive = await native.storeAsset(data), beforeAssets = await files(native.assetsDir), beforeProjects = await files(native.projectsDir);
  const originalStore = native.storeAsset; let calls = 0;
  native.storeAsset = async function (...args) { if (++calls === 3) throw Object.assign(new Error('Injected disk full'), { code: 'ENOSPC' }); return originalStore.apply(this, args); };
  try { await assert.rejects(native.importPsd(options)); } finally { native.storeAsset = originalStore; }
  assert.ok(calls >= 3); assert.deepEqual(await files(native.assetsDir), beforeAssets); assert.deepEqual(await files(native.projectsDir), beforeProjects); assert.equal(native.projects.size, 0);
  const originalPersist = native.persist;
  native.persist = async () => { throw Object.assign(new Error('Injected project save failure'), { code: 'EIO' }); };
  try { await assert.rejects(native.importPsd(options)); } finally { native.persist = originalPersist; }
  assert.deepEqual(await files(native.assetsDir), beforeAssets); assert.deepEqual(await files(native.projectsDir), beforeProjects); assert.equal(native.projects.size, 0);
  const successful = await native.importPsd(options); assert.equal(native.projects.size, 1);
  assert.deepEqual(await fs.readFile(path.join(native.assetsDir, archive)), data);
  assert.deepEqual((await native.exportOriginalPsd({ documentId: successful.document.id })).data, data);
});

test('explicit native cancellation rolls back before publication but preserves a document whose atomic save completed', async t => {
  const { native } = await fixture(t), data = inputs[0], controller = new AbortController(), options = request(data), originalStore = native.storeAsset;
  const beforeAssets = await files(native.assetsDir), beforeProjects = await files(native.projectsDir); let writes = 0;
  native.storeAsset = async function (...args) { const result = await originalStore.apply(this, args); if (++writes === 1) controller.abort(); return result; };
  try { await assert.rejects(native.importPsd({ ...options, signal: controller.signal }), { code: 'PSD_IMPORT_CANCELLED' }); }
  finally { native.storeAsset = originalStore; }
  assert.equal(writes, 1); assert.equal(native.projects.size, 0); assert.deepEqual(await files(native.assetsDir), beforeAssets); assert.deepEqual(await files(native.projectsDir), beforeProjects);

  const late = new AbortController(), originalPersist = native.persist;
  native.persist = async function (...args) { const result = await originalPersist.apply(this, args); late.abort(); return result; };
  let result;
  try { result = await native.importPsd({ ...options, signal: late.signal }); }
  finally { native.persist = originalPersist; }
  assert.ok(late.signal.aborted); assert.equal(native.projects.size, 1);
  const retry = await native.importPsd(options); assert.equal(retry.document.id, result.document.id);
  assert.deepEqual((await native.exportOriginalPsd({ documentId: result.document.id })).data, data);
});

test('original archive reads are fresh and checked; corrupted or symlinked archives cannot borrow cached preview success', async t => {
  const { native, dataDir } = await fixture(t), imported = await native.importPsd(request(inputs[0])), doc = imported.document;
  const preview = await native.execute('get_preview', { documentId: doc.id }), cache = native.previewCache.stats(), projectFiles = await files(native.projectsDir);
  const archivePath = path.join(native.assetsDir, doc.sourceDocument.asset), moved = `${archivePath}.audit-away`;
  await assert.rejects(native.exportOriginalPsd({ documentId: doc.id, expectedRevision: doc.revision + 1 }), { code: 'REVISION_CONFLICT' });
  const original = await fs.readFile(archivePath), corrupt = Buffer.from(original); corrupt[corrupt.length - 1] ^= 1;
  await fs.writeFile(archivePath, corrupt);
  try {
    await assert.rejects(native.exportOriginalPsd({ documentId: doc.id }), cause => Boolean(cause.code) && !cause.message.includes(dataDir));
    assert.deepEqual(await native.execute('get_preview', { documentId: doc.id }), preview);
  } finally { await fs.writeFile(archivePath, original); }
  await fs.rename(archivePath, moved); await fs.symlink(moved, archivePath);
  try { await assert.rejects(native.exportOriginalPsd({ documentId: doc.id })); }
  finally { await fs.unlink(archivePath); await fs.rename(moved, archivePath); }
  assert.deepEqual((await native.exportOriginalPsd({ documentId: doc.id })).data, original);
  assert.deepEqual(await current(native, doc), doc); assert.deepEqual(await files(native.projectsDir), projectFiles); assert.deepEqual(native.previewCache.stats(), cache);
});

test('portable archive metadata and raster/archive role collisions reject without asset writes', async t => {
  const { native } = await fixture(t), { native: target } = await fixture(t), imported = await native.importPsd(request(inputs[0]));
  const valid = (await native.exportProject({ documentId: imported.document.id })).data, length = valid.readUInt32BE(8), manifest = JSON.parse(valid.subarray(12, 12 + length));
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const mutations = [
    graph => { graph.sourceDocument.format = 'png'; }, graph => { graph.sourceDocument.asset = '../outside.psd'; },
    graph => { graph.sourceDocument.name = 'bad\u0000name.psd'; }, graph => { graph.sourceDocument.extra = true; },
    graph => { graph.layers[0].sourceAsset = graph.sourceDocument.asset; graph.layers[0].sourceFormat = 'png'; },
  ];
  const validateAsset = target.validateProjectAsset;
  let touched = 0; target.validateProjectAsset = target.storeAsset = async () => { touched++; assert.fail('Invalid archive metadata reached image/file processing'); };
  for (const mutate of mutations) {
    const next = structuredClone(manifest); mutate(next.graph); const body = Buffer.from(JSON.stringify(canonical(next))), prefix = Buffer.from(valid.subarray(0, 12)); prefix.writeUInt32BE(body.length, 8);
    await assert.rejects(target.importProject({ data: Buffer.concat([prefix, body, valid.subarray(12 + length)]) }));
  }
  assert.equal(touched, 0);
  // A plausible length is structurally valid; checking its actual archived
  // bytes belongs to passive asset validation, still before any writes.
  target.validateProjectAsset = validateAsset;
  const next = structuredClone(manifest); next.graph.sourceDocument.bytes++;
  const body = Buffer.from(JSON.stringify(canonical(next))), prefix = Buffer.from(valid.subarray(0, 12)); prefix.writeUInt32BE(body.length, 8);
  await assert.rejects(target.importProject({ data: Buffer.concat([prefix, body, valid.subarray(12 + length)]) }), { code: 'INVALID_PROJECT_BUNDLE' });
  assert.equal(touched, 0); assert.equal(target.projects.size, 0); assert.deepEqual(await files(target.assetsDir), {}); assert.deepEqual(await files(target.projectsDir), {});
});

test('PackBits literal/repeat/no-op packets obey exact row boundaries against independent seeded samples', () => {
  let seed = 0x157ea53;
  const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  for (let sample = 0; sample < 1000; sample++) {
    const width = 1 + next() % 513, packets = [], expected = [];
    while (expected.length < width) {
      packets.push(Buffer.from([128])); // Legal no-op, including at row end.
      const count = Math.min(width - expected.length, 1 + next() % 128);
      if (next() & 1) {
        const bytes = Array.from({ length: count }, () => next() % 256);
        packets.push(Buffer.from([count - 1, ...bytes])); expected.push(...bytes);
      } else {
        const value = next() % 256;
        if (count === 1) packets.push(Buffer.from([0, value]));
        else packets.push(Buffer.from([257 - count, value]));
        expected.push(...Array(count).fill(value));
      }
    }
    packets.push(Buffer.from([128, 128]));
    const output = Buffer.alloc(width + 14, 181), encoded = Buffer.concat(packets), before = Buffer.from(encoded);
    assert.equal(decodePackBitsRow(encoded, output, 7, width), output);
    assert.deepEqual(output.subarray(7, 7 + width), Buffer.from(expected));
    assert.deepEqual(output.subarray(0, 7), Buffer.alloc(7, 181)); assert.deepEqual(output.subarray(7 + width), Buffer.alloc(7, 181));
    assert.deepEqual(encoded, before);
  }
  for (const [encoded, width] of [[[], 1], [[127], 128], [[129], 128], [[255, 3], 1], [[0, 7], 2], [[0, 7, 0, 8], 1]]) {
    const output = Buffer.alloc(10, 193);
    assert.throws(() => decodePackBitsRow(Buffer.from(encoded), output, 3, width > 4 ? 4 : width), { code: 'INVALID_PSD' });
    assert.deepEqual(output.subarray(0, 3), Buffer.alloc(3, 193)); assert.deepEqual(output.subarray(7), Buffer.alloc(3, 193));
  }
  assert.deepEqual(decodePackBitsRow(Buffer.from([128, 128]), Buffer.alloc(0)), Buffer.alloc(0));
});

function addResource(data, id, payload) {
  const parsed = layout(data), resource = Buffer.alloc(12 + payload.length + payload.length % 2);
  resource.write('8BIM'); resource.writeUInt16BE(id, 4); resource.writeUInt32BE(payload.length, 8); payload.copy(resource, 12);
  const end = parsed.resourceLengthAt + 4 + data.readUInt32BE(parsed.resourceLengthAt);
  const result = Buffer.concat([data.subarray(0, end), resource, data.subarray(end)]);
  result.writeUInt32BE(data.readUInt32BE(parsed.resourceLengthAt) + resource.length, parsed.resourceLengthAt);
  return result;
}

test('known ICC accepts exact RGB while unknown, duplicate, malformed and contradictory profile records cannot be overridden', async t => {
  const { native } = await fixture(t), profile = await knownSrgbProfile(), tagged = addResource(inputs[0], 1039, profile);
  const report = await native.inspectPsdImport({ data: tagged }); assert.equal(report.supported, true); assert.equal(report.color.policy, 'known-srgb');
  const imported = await native.importPsd(request(tagged, { assumeSrgb: false }));
  for (let index = 0; index < 3; index++) assert.deepEqual(await sharp(await fs.readFile(path.join(native.assetsDir, imported.document.layers[index].sourceAsset))).ensureAlpha().raw().toBuffer(), Buffer.from(expected[0].layers[index].rgba));
  const unknown = Buffer.from(profile); unknown[80] ^= 1; // Valid bounded header, distinct profile bytes.
  const unknownReport = await native.inspectPsdImport({ data: addResource(inputs[0], 1039, unknown), assumeSrgb: true });
  assert.equal(unknownReport.supported, false); assert.equal(unknownReport.requiresSrgbAssumption, false); assert.ok(unknownReport.issues.some(issue => issue.code === 'ICC_PROFILE_UNSUPPORTED'));
  const malformed = Buffer.from(profile); malformed.writeUInt32BE(0xffffffff, 128);
  for (const data of [addResource(tagged, 1039, profile), addResource(inputs[0], 1039, malformed), addResource(tagged, 1041, Buffer.from([1]))]) await assert.rejects(native.inspectPsdImport({ data, assumeSrgb: true }), { code: 'INVALID_PSD' });
  const untagged = addResource(inputs[0], 1041, Buffer.from([1]));
  assert.equal((await native.inspectPsdImport({ data: untagged })).requiresSrgbAssumption, true);
  assert.equal((await native.inspectPsdImport({ data: untagged, assumeSrgb: true })).supported, true);
});

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settled = promise => promise.then(value => ({ value }), error => ({ error }));
async function eventually(predicate) {
  for (let count = 0; count < 100; count++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.fail('Bounded asynchronous condition did not complete.');
}

test('pool holds its admission slot until cancelled worker termination and ignores late results', async t => {
  const instances = [], termination = deferred(), consumed = [];
  class FakeWorker extends EventEmitter {
    constructor() { super(); this.index = instances.length; this.messages = []; instances.push(this); }
    postMessage(message) {
      this.messages.push(message);
      if (message.input) queueMicrotask(() => this.emit('message', { type: 'plan', workingBytes: 2 * 1024 * 1024 }));
      if (message.continue && this.index) queueMicrotask(() => this.emit('message', { type: 'result', result: this.index }));
    }
    async terminate() { this.terminating = true; if (!this.index) await termination.promise; this.terminated = true; return 0; }
  }
  const pool = new PsdImportPool({ WorkerClass: FakeWorker, timeoutMs: 1000, maxWorkingBytes: 8 * 1024 * 1024 }); t.after(() => pool.close());
  const abort = new AbortController(), first = settled(pool.run(inputs[0], { signal: abort.signal }, result => consumed.push(result)));
  await eventually(() => instances[0]?.messages.some(message => message.continue));
  const second = pool.run(inputs[0], {}, result => { consumed.push(result); return result; });
  const third = pool.run(inputs[0], {}, result => { consumed.push(result); return result; });
  await assert.rejects(pool.run(inputs[0], {}, () => assert.fail('Fourth input was admitted')), { code: 'LIMIT_EXCEEDED' });
  const reserved = pool.reserved; abort.abort(); await eventually(() => instances[0].terminating);
  instances[0].emit('message', { type: 'result', result: 'late cancelled result' });
  assert.equal(instances.length, 1); assert.equal(pool.reserved, reserved); assert.equal(pool.pending.length, 2); assert.equal(consumed.length, 0);
  termination.resolve(); assert.equal((await first).error.code, 'PSD_IMPORT_CANCELLED');
  assert.deepEqual(await Promise.all([second, third]), [1, 2]); await eventually(() => pool.reserved === 0);
  assert.deepEqual(consumed, [1, 2]); assert.ok(instances.every(worker => worker.terminated));
});

test('pool reserves shared decoded work before permission to decode and real deadline waits for termination', async t => {
  const instances = [];
  class BudgetWorker extends EventEmitter {
    constructor() { super(); this.messages = []; instances.push(this); }
    postMessage(message) { this.messages.push(message); if (message.input) queueMicrotask(() => this.emit('message', { type: 'plan', workingBytes: 4 * 1024 * 1024 })); }
    async terminate() { this.terminated = true; return 0; }
  }
  const pool = new PsdImportPool({ WorkerClass: BudgetWorker, timeoutMs: 1000, maxWorkingBytes: 4 * 1024 * 1024 }); t.after(() => pool.close());
  const first = settled(pool.run(inputs[0], {}, () => assert.fail('Overbudget decode was consumed')));
  const abort = new AbortController(), waiting = settled(pool.run(inputs[0], { signal: abort.signal }, () => assert.fail('Cancelled queue was consumed')));
  assert.equal((await first).error.code, 'LIMIT_EXCEEDED'); abort.abort();
  assert.equal((await waiting).error.code, 'PSD_IMPORT_CANCELLED'); await eventually(() => pool.reserved === 0);
  assert.ok(instances.every(worker => worker.terminated)); assert.ok(instances[0].messages.every(message => !message.continue));
  const real = [];
  class TrackedWorker extends Worker { constructor(...args) { super(...args); real.push(this); } }
  const timed = new PsdImportPool({ WorkerClass: TrackedWorker, timeoutMs: 1 }); t.after(() => timed.close());
  await assert.rejects(timed.run(inputs[0], { assumeSrgb: true }, () => assert.fail('Timed-out work was published')), { code: 'PSD_IMPORT_TIMEOUT' });
  assert.equal(real.length, 1); assert.equal(real[0].threadId, -1); await eventually(() => timed.reserved === 0);
});
