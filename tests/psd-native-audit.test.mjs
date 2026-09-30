import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';

const edit = async (native, doc, command, args = {}) => (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document;
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-psd-wrapper-audit-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return { dataDir, native: await new NativeBackend({ dataDir }).init() };
}

test('PSD inspection/export reads fresh rasters independently of cached previews and sanitizes missing-source failures', async (t) => {
  const { native, dataDir } = await fixture(t);
  const original = await sharp({ create: { width: 32, height: 24, channels: 4, background: '#284c7a' } }).png().toBuffer();
  const doc = (await native.execute('import_image', { data: original.toString('base64'), mimeType: 'image/png' })).document;
  const preview = await native.execute('get_preview', { documentId: doc.id }), cache = native.previewCache.stats();
  const file = path.join(native.projectsDir, `${doc.id}.json`), before = await fs.readFile(file), sourceBytes = await fs.readFile(path.join(native.assetsDir, doc.layers[0].asset));
  let renders = 0; const renderGraph = native.renderGraph;
  native.renderGraph = async function (...args) { renders++; return renderGraph.apply(this, args); };
  const request = { documentId: doc.id, expectedRevision: doc.revision };
  assert.equal((await native.inspectPsdExport(request)).supported, true);
  const first = await native.exportPsd(request), second = await native.exportPsd(request);
  assert.deepEqual(first.data, second.data); assert.equal(renders, 3); assert.deepEqual(native.previewCache.stats(), cache);
  first.data.fill(0); first.report.warnings[0].message = 'Caller changed report';
  const third = await native.exportPsd(request); assert.deepEqual(third.data, second.data); assert.notEqual(third.report.warnings[0].message, 'Caller changed report');
  const asset = path.join(native.assetsDir, doc.layers[0].asset), moved = `${asset}.audit-away`;
  await fs.rename(asset, moved);
  try {
    assert.deepEqual(await native.execute('get_preview', { documentId: doc.id }), preview);
    for (const operation of [() => native.inspectPsdExport(request), () => native.exportPsd(request)]) {
      await assert.rejects(operation(), (cause) => cause.code === 'PSD_RENDER_FAILED' && !cause.message.includes(dataDir) && !cause.message.includes('ENOENT'));
    }
    assert.deepEqual(native.previewCache.stats(), cache); assert.deepEqual(await fs.readFile(file), before);
  } finally { await fs.rename(moved, asset); }
  assert.deepEqual((await native.exportPsd(request)).data, second.data);
  assert.deepEqual(await fs.readFile(asset), sourceBytes); assert.deepEqual(await fs.readFile(file), before);
  assert.deepEqual((await native.execute('get_document', { documentId: doc.id })).document, doc);
});

test('queued PSD inspection captures its revision while later mutations and stale exports cannot race it', async (t) => {
  const { native } = await fixture(t);
  const doc = (await native.execute('create_document', { width: 16, height: 12 })).document;
  let release, entered; const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const render = native.renderGraph; let calls = 0;
  native.renderGraph = async function (...args) { calls++; if (calls === 1) { entered(); await gate; } return render.apply(this, args); };
  const before = native.inspectPsdExport({ documentId: doc.id, expectedRevision: doc.revision });
  await started;
  const mutation = edit(native, doc, 'set_layer', { layerId: doc.layers[0].id, visible: false });
  const staleExport = assert.rejects(native.exportPsd({ documentId: doc.id, expectedRevision: doc.revision }), { code: 'REVISION_CONFLICT' });
  const after = native.inspectPsdExport({ documentId: doc.id }); release();
  const first = await before, changed = await mutation, latest = await after; await staleExport;
  assert.equal(first.supported, true); assert.equal(first.revision, doc.revision);
  assert.equal(latest.supported, false); assert.equal(latest.revision, changed.revision);
  assert.ok(latest.issues.some(issue => issue.code === 'TRANSPARENT_COMPOSITE')); assert.equal(calls, 2);
  const unchanged = (await native.execute('get_document', { documentId: doc.id })).document;
  await assert.rejects(native.exportPsd({ documentId: doc.id, expectedRevision: changed.revision }), { code: 'PSD_UNSUPPORTED' });
  assert.deepEqual((await native.execute('get_document', { documentId: doc.id })).document, unchanged);
});

test('large metadata-only PSD refusal and stale reads occur before any image allocation or asset access', async (t) => {
  const { native } = await fixture(t);
  const doc = (await native.execute('create_document', { width: 8000, height: 3000 })).document;
  const file = path.join(native.projectsDir, `${doc.id}.json`), before = await fs.readFile(file);
  const renderGraph = native.renderGraph, renderLayer = native.renderLayer;
  native.renderGraph = native.renderLayer = async () => { assert.fail('An oversized PSD must fail metadata preflight before rendering'); };
  try {
    const report = await native.inspectPsdExport({ documentId: doc.id, expectedRevision: doc.revision });
    assert.equal(report.supported, false); assert.equal(report.requiresPixelValidation, true);
    assert.ok(report.issues.some(issue => issue.code === 'OUTPUT_LIMIT'));
    assert.ok(report.estimatedBytes > report.maxBytes);
    await assert.rejects(native.exportPsd({ documentId: doc.id, expectedRevision: doc.revision }), (cause) => cause.code === 'PSD_UNSUPPORTED' && cause.report.issues.some(issue => issue.code === 'OUTPUT_LIMIT'));
    await assert.rejects(native.inspectPsdExport({ documentId: doc.id, expectedRevision: doc.revision + 1 }), { code: 'REVISION_CONFLICT' });
    assert.deepEqual(await fs.readFile(file), before); assert.deepEqual(await fs.readdir(native.assetsDir), []);
  } finally { native.renderGraph = renderGraph; native.renderLayer = renderLayer; }
});
