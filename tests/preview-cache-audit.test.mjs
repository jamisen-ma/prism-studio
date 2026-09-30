import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';

const edit = async (native, doc, command, args = {}) => (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document;
const preview = (native, doc, fields = {}) => native.execute('get_preview', { documentId: doc.id, ...fields });
const pixels = async (result) => sharp(Buffer.from(result.data, 'base64')).ensureAlpha().raw().toBuffer();
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-preview-audit-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return { dataDir, native: await new NativeBackend({ dataDir }).init() };
}

test('queued preview, mutation, stale read and fresh read retain correct revisions without response aliases', async (t) => {
  const { native } = await fixture(t);
  const doc = (await native.execute('create_document', { width: 48, height: 32, background: '#305070' })).document;
  const output = native.output; let calls = 0, release, entered;
  const started = new Promise((resolve) => { entered = resolve; }), gate = new Promise((resolve) => { release = resolve; });
  native.output = async function (...args) {
    calls++;
    if (calls === 1) { entered(); await gate; }
    return output.apply(this, args);
  };
  const oldRead = preview(native, doc, { expectedRevision: doc.revision });
  await started;
  const mutation = edit(native, doc, 'set_layer', { layerId: doc.layers[0].id, visible: false });
  const staleRead = assert.rejects(preview(native, doc, { expectedRevision: doc.revision }), { code: 'REVISION_CONFLICT' });
  const nextRead = preview(native, doc);
  release();
  const before = await oldRead, updated = await mutation, after = await nextRead; await staleRead;
  assert.equal(before.revision, doc.revision); assert.equal(after.revision, updated.revision);
  assert.deepEqual([...(await pixels(before)).subarray(0, 4)], [48, 80, 112, 255]);
  assert.deepEqual([...(await pixels(after)).subarray(0, 4)], [0, 0, 0, 0]);
  assert.equal(calls, 2);
  const expected = { ...after }; after.data = 'modified first response'; after.width = 999;
  const hit = await preview(native, updated); assert.deepEqual(hit, expected); hit.data = 'modified cache hit';
  assert.deepEqual(await preview(native, updated), expected); assert.equal(calls, 2);
  const undone = await edit(native, updated, 'undo'); const undonePreview = await preview(native, undone);
  assert.equal(undonePreview.revision, undone.revision); assert.deepEqual(await pixels(undonePreview), await pixels(before)); assert.equal(calls, 3);
  assert.equal(native.previewCache.stats().entries, 1);
});

test('failed publication leaves a valid cached revision intact; failed fresh renders are retried', async (t) => {
  const { native, dataDir } = await fixture(t);
  const doc = (await native.execute('create_document', { width: 48, height: 32, background: '#517293' })).document;
  const cached = await preview(native, doc), initialStats = native.previewCache.stats();
  const projectPath = path.join(native.projectsDir, `${doc.id}.json`), projectBytes = await fs.readFile(projectPath), originalDirectory = native.projectsDir;
  native.projectsDir = path.join(dataDir, 'does-not-exist', 'nested');
  try { await assert.rejects(edit(native, doc, 'set_layer', { layerId: doc.layers[0].id, visible: false }), { code: 'ENOENT' }); }
  finally { native.projectsDir = originalDirectory; }
  assert.deepEqual(native.previewCache.stats(), initialStats);
  assert.deepEqual(await fs.readFile(projectPath), projectBytes);
  const render = native.render; let renders = 0;
  native.render = async function (...args) { renders++; if (renders === 1) throw Object.assign(new Error('Synthetic render failure'), { code: 'RENDER_ERROR' }); return render.apply(this, args); };
  assert.deepEqual(await preview(native, doc), cached); assert.equal(renders, 0);
  await assert.rejects(preview(native, doc, { maxWidth: 32 }), { code: 'RENDER_ERROR' });
  assert.equal(native.previewCache.stats().entries, 1);
  const recovered = await preview(native, doc, { maxWidth: 32 }); assert.equal(recovered.width, 32); assert.equal(renders, 2);
  assert.deepEqual(await preview(native, doc, { maxWidth: 32 }), recovered); assert.equal(renders, 2);
  await native.execute('save_document', { documentId: doc.id, expectedRevision: doc.revision });
  assert.equal(native.previewCache.stats().entries, 0);
  assert.deepEqual(await preview(native, doc), cached); assert.equal(renders, 3);
});

test('cached composite does not hide fresh export, layer-source or generation-snapshot failures', async (t) => {
  const { native } = await fixture(t);
  const png = await sharp({ create: { width: 40, height: 36, channels: 4, background: '#715239' } }).png().toBuffer();
  const doc = (await native.execute('import_image', { data: png.toString('base64'), mimeType: 'image/png' })).document;
  const cached = await preview(native, doc), layerId = doc.layers[0].id;
  const source = await native.execute('get_layer_preview', { documentId: doc.id, layerId, view: 'source' });
  assert.deepEqual(await pixels(source), await pixels(cached));
  const hashes = [...new Set([doc.layers[0].asset, doc.layers[0].sourceAsset])], moved = [];
  try {
    // Deliberately violate the immutable-asset assumption externally. Only the
    // previously encoded composite may be reused; source consumers stay fresh.
    for (const hash of hashes) {
      const file = path.join(native.assetsDir, hash), temporary = `${file}.audit-away`;
      await fs.rename(file, temporary); moved.push([file, temporary]);
    }
    assert.deepEqual(await preview(native, doc), cached);
    await assert.rejects(native.execute('export_document', { documentId: doc.id, format: 'png' }));
    await assert.rejects(native.execute('get_layer_preview', { documentId: doc.id, layerId, view: 'source' }), { code: 'INVALID_IMAGE' });
    await assert.rejects(native.execute('get_layer_preview', { documentId: doc.id, layerId, view: 'layer' }), { code: 'INVALID_IMAGE' });
    await assert.rejects(native.snapshotForGeneration({ documentId: doc.id, expectedRevision: doc.revision, scope: 'canvas' }));
    assert.equal(native.previewCache.stats().entries, 1);
    await native.execute('save_document', { documentId: doc.id, expectedRevision: doc.revision });
    await assert.rejects(preview(native, doc)); assert.equal(native.previewCache.stats().entries, 0);
  } finally { for (const [file, temporary] of moved) await fs.rename(temporary, file); }
  assert.deepEqual(await preview(native, doc), cached);
  const snapshot = await native.snapshotForGeneration({ documentId: doc.id, expectedRevision: doc.revision, scope: 'canvas' });
  assert.deepEqual(await sharp(snapshot.image).ensureAlpha().raw().toBuffer(), await pixels(cached));
  await native.init(); assert.equal(native.previewCache.stats().entries, 0);
  assert.deepEqual(await preview(native, doc), cached);
});
