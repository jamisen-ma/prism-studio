import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { scanPsd, decodePsdPlan, decodePackBitsRow, knownSrgbProfile, PSD_IMPORT_LIMITS } from '../server/psd-import.mjs';
import { PsdImportPool } from '../server/psd-import-pool.mjs';
import { writePsdExport } from '../server/psd-export.mjs';
import { decodeProjectBundle } from '../server/project-bundle.mjs';
import { maskCoverage } from '../server/masks.mjs';
import { safePsdFilename, validateSourceDocument } from '../server/source-document.mjs';

const fixtureDir = new URL('./fixtures/psd-import/', import.meta.url);
const digest = data => createHash('sha256').update(data).digest('hex');
const input = async name => fs.readFile(new URL(name, fixtureDir));
const raw = async bytes => sharp(bytes).ensureAlpha().raw().toBuffer();
async function setup(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-psd-import-'));
  const native = await new NativeBackend({ dataDir }).init();
  t.after(async () => { await native.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { native, dataDir };
}
function args(data, overrides = {}) { return { data, expectedSha256: digest(data), importerVersion: 1, requestId: randomUUID(), assumeSrgb: true, ...overrides }; }
async function snapshot(native) { return { projects: (await fs.readdir(native.projectsDir)).sort(), assets: (await fs.readdir(native.assetsDir)).sort(), docs: await native.execute('list_documents') }; }

test('foreign raw and PackBits sources decode every RGB/alpha and independent mask without changing caller bytes', async () => {
  const expected = JSON.parse(await input('expected.json'));
  for (const fixture of expected) {
    const data = await input(fixture.filename), original = Buffer.from(data), plan = scanPsd(data, { assumeSrgb: true });
    assert.equal(plan.report.issues.length, 0); const result = await decodePsdPlan(plan, { sourceName: 'Independent.psd' });
    assert.equal(result.graph.layers.length, fixture.layers.length);
    for (let i = 0; i < fixture.layers.length; i++) {
      const expectedLayer = fixture.layers[i], layer = result.graph.layers[i];
      assert.equal(layer.name, expectedLayer.name); assert.equal(layer.opacity, expectedLayer.opacity / 255); assert.equal(layer.visible, expectedLayer.visible);
      assert.deepEqual(await raw(result.assets[i].data), Buffer.from(expectedLayer.rgba));
      if (expectedLayer.mask) {
        const sample = maskCoverage(layer.mask), [left, top, right, bottom] = expectedLayer.maskBounds;
        for (let y = 0; y < fixture.height; y++) for (let x = 0; x < fixture.width; x++) {
          const value = x >= left && x < right && y >= top && y < bottom ? expectedLayer.mask[(y - top) * (right - left) + x - left] : expectedLayer.maskDefault;
          assert.equal(sample(x, y), value / 255);
        }
      }
    }
    assert.equal(result.report.comparison.maxChannelDifference, 1); assert.deepEqual(data, original);
  }
});

test('PackBits literal/repeat limits, no-op padding and exact row boundaries use an independent oracle', () => {
  for (let length = 1; length <= 128; length++) {
    const bytes = Buffer.from(Array.from({ length }, (_, i) => (i * 73 + length) % 256));
    const encoded = Buffer.concat([Buffer.from([128, length - 1]), bytes, Buffer.from([128, 128])]);
    assert.deepEqual(decodePackBitsRow(encoded, Buffer.alloc(length)), bytes);
    if (length > 1) assert.deepEqual(decodePackBitsRow(Buffer.from([257 - length, length]), Buffer.alloc(length)), Buffer.alloc(length, length));
  }
  for (const [encoded, size] of [[Buffer.from([0]), 1], [Buffer.from([255]), 2], [Buffer.from([1, 3]), 2], [Buffer.from([0, 3]), 2], [Buffer.from([254, 7]), 2], [Buffer.from([0, 3, 0, 4]), 1]]) {
    assert.throws(() => decodePackBitsRow(encoded, Buffer.alloc(size)), { code: 'INVALID_PSD' });
  }
  const input = Buffer.from([99, 0, 73, 211]), output = Buffer.alloc(3, 182);
  decodePackBitsRow(input.subarray(1, 3), output, 1, 1); assert.deepEqual(output, Buffer.from([182, 73, 182]));
});

test('color policy distinguishes exact known sRGB, explicit untagged assignment and unsupported embedded profiles', async () => {
  const external = await input('flat-raw.psd'); const rejected = scanPsd(external).report;
  assert.equal(rejected.requiresSrgbAssumption, true); assert.equal(rejected.validation, 'rejected');
  assert.ok(rejected.issues.some(x => x.code === 'UNTAGGED_COLOR_REQUIRES_ASSUMPTION'));
  const profile = await knownSrgbProfile(), pixels = Buffer.from([17, 31, 67, 255]);
  const encoded = writePsdExport({ width: 1, height: 1, layers: [{ id: 'a', name: '  exact name Ω 🌿  ', visible: true, opacity: 1, pixels }], composite: pixels, iccProfile: profile }).data;
  const accepted = scanPsd(encoded, { knownSrgbProfile: profile }); assert.deepEqual(accepted.report.issues, []);
  assert.equal((await decodePsdPlan(accepted)).graph.layers[0].name, '  exact name Ω 🌿  ');
  const unknown = Buffer.from(encoded), at = unknown.indexOf(profile); assert.ok(at > 0); unknown[at + 80] ^= 1;
  const unsupported = scanPsd(unknown, { knownSrgbProfile: profile, assumeSrgb: true }).report;
  assert.equal(unsupported.requiresSrgbAssumption, false); assert.ok(unsupported.issues.some(x => x.code === 'ICC_PROFILE_UNSUPPORTED'));
  const alphaHeader = Buffer.from(encoded); alphaHeader.writeUInt16BE(4, 12); assert.ok(scanPsd(alphaHeader).report.issues.some(x => x.code === 'MERGED_TRANSPARENCY_UNSUPPORTED'));
});

test('inspection owns call-time bytes and leaves disk, history and assets unchanged', async t => {
  const { native } = await setup(t), data = await input('flat-rle.psd'), expected = digest(data), before = await snapshot(native);
  const operation = native.inspectPsdImport({ data, assumeSrgb: true }); data.fill(0);
  const report = await operation; assert.equal(report.supported, true); assert.equal(report.validation, 'complete'); assert.equal(report.input.sha256, expected);
  assert.deepEqual(await snapshot(native), before);
  const rejected = await native.inspectPsdImport({ data: await input('flat-raw.psd') }); assert.equal(rejected.supported, false); assert.equal(rejected.validation, 'rejected'); assert.equal(rejected.requiresSrgbAssumption, true);
  assert.deepEqual(await snapshot(native), before);
});

test('imports retain immutable archive and native editable layers across independent history, reopening and portable cloning', async t => {
  const { native, dataDir } = await setup(t), data = await input('flat-rle.psd');
  const imported = await native.importPsd(args(data, { sourceName: '../Photographs Ω.psd', name: 'My editable photo' }));
  const { document } = imported; assert.equal(document.name, 'My editable photo'); assert.equal(document.history.length, 1); assert.equal(document.canUndo, false);
  assert.equal(document.sourceDocument.name, 'Photographs _.psd'); assert.ok(document.layers.every(x => x.provenance.colorPolicy === 'assumed-srgb' && !x.provenance.jobId));
  const before = (await native.execute('get_preview', { documentId: document.id })).data;
  const changed = (await native.execute('set_layer', { documentId: document.id, expectedRevision: document.revision, layerId: document.layers[1].id, visible: true })).document;
  assert.notDeepEqual((await native.execute('get_preview', { documentId: document.id })).data, before);
  assert.deepEqual((await native.exportOriginalPsd({ documentId: document.id, expectedRevision: changed.revision })).data, data);
  await assert.rejects(native.exportOriginalPsd({ documentId: document.id, expectedRevision: 1 }), { code: 'REVISION_CONFLICT' });
  const bundle = await native.exportProject({ documentId: document.id }); const decoded = decodeProjectBundle(bundle.data, { validateGraph: native.validateGraph.bind(native) });
  assert.deepEqual(decoded.assets.get(document.sourceDocument.asset), data);
  const clone = (await native.importProject({ data: bundle.data })).document; assert.notEqual(clone.id, document.id); assert.equal(clone.history.length, 1); assert.deepEqual(clone.sourceDocument, document.sourceDocument);
  assert.equal(native.projects.get(clone.id).psdImportReceipt, undefined);
  const reopened = await new NativeBackend({ dataDir }).init(); t.after(() => reopened.close());
  assert.deepEqual((await reopened.exportOriginalPsd({ documentId: document.id })).data, data);
  const ordinary = (await native.execute('create_document', { width: 1, height: 1 })).document;
  await assert.rejects(native.exportOriginalPsd({ documentId: ordinary.id }), { code: 'NO_SOURCE_DOCUMENT' });
});

test('durable import receipts coalesce retries and reject changed interpretation or bytes across restart', async t => {
  const { native, dataDir } = await setup(t), data = await input('flat-raw.psd'), options = args(data);
  const [a, b] = await Promise.all([native.importPsd(options), native.importPsd(options)]); assert.equal(a.document.id, b.document.id);
  const reopened = await new NativeBackend({ dataDir }).init(); t.after(() => reopened.close());
  assert.equal((await reopened.importPsd(options)).document.id, a.document.id);
  for (const change of [{ assumeSrgb: false }, { name: 'changed' }, { sourceName: 'changed.psd' }]) await assert.rejects(async () => reopened.importPsd({ ...options, ...change }), { code: 'REQUEST_CONFLICT' });
  const changed = Buffer.from(data); changed[changed.length - 1] ^= 1;
  await assert.rejects(async () => reopened.importPsd({ ...options, data: changed }), { code: 'INSPECTION_STALE' });
  await assert.rejects(async () => reopened.importPsd({ ...options, importerVersion: 2 }), { code: 'INSPECTION_STALE' });
  assert.equal((await reopened.execute('list_documents')).documents.length, 1);
});

test('full validation and persistence failures reject before publication, preserving deduplicated assets', async t => {
  const { native } = await setup(t), original = await input('flat-rle.psd'), before = await snapshot(native);
  for (const data of [original.subarray(0, original.length - 1), Buffer.concat([original, Buffer.from([0])]), Buffer.from('8BPS')]) {
    await assert.rejects(native.inspectPsdImport({ data, assumeSrgb: true }), { code: 'INVALID_PSD' }); assert.deepEqual(await snapshot(native), before);
  }
  const first = await native.importPsd(args(original)), baseline = await snapshot(native), sourceBytes = await native.exportOriginalPsd({ documentId: first.document.id });
  const persist = native.persist; native.persist = async project => { await persist.call(native, project); throw new Error('Injected publication failure'); };
  await assert.rejects(native.importPsd(args(original, { name: 'must rollback' })), { code: 'PSD_IMPORT_FAILED' }); native.persist = persist;
  assert.deepEqual(await snapshot(native), baseline); assert.deepEqual((await native.exportOriginalPsd({ documentId: first.document.id })).data, sourceBytes.data);
});

test('worker admission, allocation handshake, cancellation, timeout and shutdown release their bounded reservations', async () => {
  class HeldWorker extends EventEmitter {
    static all = [];
    constructor() { super(); HeldWorker.all.push(this); this.posts = []; this.terminations = 0; }
    postMessage(value) { this.posts.push(value); }
    async terminate() { this.terminations++; return 0; }
  }
  const pool = new PsdImportPool({ WorkerClass: HeldWorker, timeoutMs: 1000 }), controller = new AbortController(), data = Buffer.alloc(64, 1);
  const first = pool.run(data, { signal: controller.signal }, () => assert.fail('Cancelled worker cannot publish'));
  const second = pool.run(data, {}, () => assert.fail('Closed worker cannot publish'));
  const third = pool.run(data, {}, () => assert.fail('Closed worker cannot publish'));
  await assert.rejects(pool.run(data, {}, () => {}), { code: 'LIMIT_EXCEEDED' });
  const outcomes = Promise.allSettled([first, second, third]); controller.abort(); await pool.close();
  assert.ok((await outcomes).every(x => x.status === 'rejected' && x.reason.code === 'PSD_IMPORT_CANCELLED')); assert.equal(pool.reserved, 0); assert.equal(HeldWorker.all[0].terminations, 1);
  const budgetPool = new PsdImportPool({ WorkerClass: HeldWorker, timeoutMs: 1000 });
  const rejected = budgetPool.run(data, {}, () => assert.fail('Oversized decode cannot publish')), worker = HeldWorker.all.at(-1);
  worker.emit('message', { type: 'plan', workingBytes: PSD_IMPORT_LIMITS.maxWorkingBytes + 1 });
  await assert.rejects(rejected, { code: 'LIMIT_EXCEEDED' }); assert.equal(worker.posts.length, 1); await budgetPool.close(); assert.equal(budgetPool.reserved, 0);
  const timeoutPool = new PsdImportPool({ WorkerClass: HeldWorker, timeoutMs: 5 });
  await assert.rejects(timeoutPool.run(data, {}, () => {}), { code: 'PSD_IMPORT_TIMEOUT' }); await timeoutPool.close(); assert.equal(timeoutPool.reserved, 0);
});

test('parent validation binds decoded project and archive to the report before enabling support', async t => {
  const { native } = await setup(t), data = await input('flat-raw.psd');
  const make = async () => { const result = await decodePsdPlan(scanPsd(data, { assumeSrgb: true })); return { ...result, input: Uint8Array.from(data).buffer }; };
  for (const change of [x => x.report.input.sha256 = '0'.repeat(64), x => x.report.input.bytes++, x => x.report.document.width++, x => x.report.document.layerCount--, x => x.graph.layers[0].visible = false, x => x.report.supported = true]) {
    const result = await make(); change(result); await assert.rejects(native.checkedPsdResult(result, () => false), { code: 'PSD_IMPORT_FAILED' });
  }
  assert.equal((await snapshot(native)).projects.length, 0);
});

test('native mask-run complexity rejects before files and large compressed dimensions reject during allocation-free planning', async t => {
  const { native } = await setup(t), before = await snapshot(native), width = 801, height = 501, pixels = Buffer.alloc(width * height * 4, 255), mask = Buffer.alloc(width * height);
  for (let i = 0; i < mask.length; i++) mask[i] = 1 + i % 2;
  const data = writePsdExport({ width, height, layers: [{ id: 'a', name: 'Complex mask', visible: true, opacity: 1, pixels, mask }], composite: pixels, iccProfile: await knownSrgbProfile() }).data;
  await assert.rejects(native.inspectPsdImport({ data }), error => error.code === 'LIMIT_EXCEEDED' && /mask.*complexity/.test(error.message));
  assert.deepEqual(await snapshot(native), before);

  // Independently write a very compressible 16MP flat PSD. No 16MP image
  // buffer is created: only row tables and PackBits repeated-value packets.
  const u16 = value => { const b = Buffer.alloc(2); b.writeUInt16BE(value); return b; }, u32 = value => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; };
  const w = 4096, h = 4096, row = Buffer.from(Array.from({ length: w / 128 }, () => [129, 73]).flat()), table = Buffer.concat(Array.from({ length: h }, () => u16(row.length))), payload = Buffer.concat(Array.from({ length: h }, () => row));
  const channel = Buffer.concat([u16(1), table, payload]), header = Buffer.alloc(26); header.write('8BPS'); header.writeUInt16BE(1, 4); header.writeUInt16BE(3, 12); header.writeUInt32BE(h, 14); header.writeUInt32BE(w, 18); header.writeUInt16BE(8, 22); header.writeUInt16BE(3, 24);
  const extra = Buffer.concat([u32(0), u32(0), Buffer.from([1, 65, 0, 0])]);
  const record = Buffer.concat([u32(0), u32(0), u32(h), u32(w), u16(3), ...[0, 1, 2].flatMap(id => [u16(id), u32(channel.length)]), Buffer.from('8BIMnorm'), Buffer.from([255, 0, 8, 0]), u32(extra.length), extra]);
  const info = Buffer.concat([u16(1), record, channel, channel, channel]), outer = Buffer.concat([u32(info.length), info, u32(0)]), merged = Buffer.concat([u16(1), table, table, table, payload, payload, payload]);
  const hugePlan = Buffer.concat([header, u32(0), u32(0), u32(outer.length), outer, merged]); assert.ok(hugePlan.length < 2 * 1024 * 1024);
  assert.throws(() => scanPsd(hugePlan, { assumeSrgb: true }), error => error.code === 'LIMIT_EXCEEDED' && /working budget/.test(error.message));
});

test('passive archive filenames are bounded PSD basenames and cannot borrow an active filename extension', () => {
  assert.equal(safePsdFilename('../folder/image.html'), 'image.html.psd'); assert.equal(safePsdFilename('C:\\folder\\original.PSD'), 'original.psd');
  const name = safePsdFilename('a'.repeat(200) + '.psd'); assert.equal(name.length, 160); assert.ok(name.endsWith('.psd'));
  const source = { format: 'psd', asset: 'a'.repeat(64), bytes: 26, name: 'image.html' };
  assert.throws(() => validateSourceDocument({ layers: [], sourceDocument: source }), { code: 'INVALID_PROJECT_BUNDLE' });
  validateSourceDocument({ layers: [], sourceDocument: { ...source, name: 'image.html.psd' } });
});
