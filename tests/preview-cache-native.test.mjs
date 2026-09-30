import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { PreviewCache } from '../server/preview-cache.mjs';

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-preview-cache-'));
  const native = await new NativeBackend({ dataDir }).init();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const document = (await native.execute('create_document', { name: 'Cache fixture', width: 96, height: 64, background: '#285078' })).document;
  const render = native.render.bind(native); let renders = 0;
  native.render = async (...args) => { renders++; return render(...args); };
  return { native, document, dataDir, renders: () => renders };
}
const preview = (native, doc, maxWidth = 96) => native.execute('get_preview', { documentId: doc.id, maxWidth });
const edit = async (native, doc, command, args = {}) => (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document;

test('repeat previews avoid rendering while width, document, successful edits and undo use correct pixels', async t => {
  const { native, document: initial, renders } = await fixture(t);
  const first = await preview(native, initial);
  assert.deepEqual(await preview(native, initial), first); assert.equal(renders(), 1);
  first.width = 1; first.data = 'Caller replacement';
  const untouched = await preview(native, initial); assert.equal(untouched.width, 96); assert.notEqual(untouched.data, first.data);
  const smaller = await preview(native, initial, 48); assert.equal(smaller.width, 48); assert.equal(renders(), 2);
  assert.deepEqual(await preview(native, initial, 48), smaller); assert.equal(renders(), 2);
  const other = (await native.execute('create_document', { name: 'Other', width: 96, height: 64, background: '#b09070' })).document;
  const otherPixels = await preview(native, other); assert.notEqual(otherPixels.data, untouched.data); assert.equal(renders(), 3);
  assert.deepEqual(await preview(native, initial), untouched); assert.equal(renders(), 3, 'Publishing another document keeps this cache.');
  let doc = await edit(native, initial, 'add_adjustment', { kind: 'invert', value: 100 });
  assert.equal(native.previewCache.stats().entries, 1, 'Only the changed document is invalidated.');
  const edited = await preview(native, doc); assert.notEqual(edited.data, untouched.data); assert.equal(edited.revision, doc.revision); assert.equal(renders(), 4);
  doc = await edit(native, doc, 'undo');
  const undone = await preview(native, doc); assert.equal(undone.data, untouched.data); assert.equal(undone.revision, doc.revision); assert.equal(renders(), 5);
  doc = await edit(native, doc, 'redo'); assert.equal((await preview(native, doc)).data, edited.data); assert.equal(renders(), 6);
});

test('validation and save failures keep the last published preview valid without caching partial edits', async t => {
  const { native, document: doc, dataDir, renders } = await fixture(t);
  const before = await preview(native, doc), bytes = await fs.readFile(path.join(dataDir, 'projects', `${doc.id}.json`));
  await assert.rejects(edit(native, doc, 'add_adjustment', { kind: 'invert', value: 101 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(edit(native, doc, 'add_adjustment', { kind: 'invert', value: 100, expectedRevision: 0 }), { code: 'REVISION_CONFLICT' });
  const persist = native.persist;
  native.persist = async () => { throw new Error('Injected save failure'); };
  await assert.rejects(edit(native, doc, 'add_adjustment', { kind: 'invert', value: 100 }), /Injected save failure/);
  native.persist = persist;
  assert.deepEqual(await preview(native, doc), before); assert.equal(renders(), 1);
  assert.deepEqual(await fs.readFile(path.join(dataDir, 'projects', `${doc.id}.json`)), bytes);
  assert.deepEqual((await native.execute('get_document', { documentId: doc.id })).document, doc);
});

test('render failures, oversize cache entries and legacy direct-native preview sizes safely bypass caching', async t => {
  const { native, document: doc, renders } = await fixture(t);
  const realRender = native.render;
  let attempts = 0;
  native.render = async () => { attempts++; throw new Error('Injected render failure'); };
  await assert.rejects(preview(native, doc), /Injected render failure/);
  await assert.rejects(preview(native, doc), /Injected render failure/);
  assert.equal(attempts, 2); assert.equal(native.previewCache.stats().entries, 0);
  native.render = realRender;
  native.previewCache = new PreviewCache({ maxBytes: 1 });
  const first = await preview(native, doc); assert.deepEqual(await preview(native, doc), first);
  assert.equal(native.previewCache.stats().entries, 0); assert.equal(renders(), 2);
  native.previewCache = new PreviewCache();
  const small = await preview(native, doc, 12); assert.equal(small.width, 12);
  assert.deepEqual(await preview(native, doc, 12), small); assert.equal(renders(), 4); assert.equal(native.previewCache.stats().entries, 0);
  await assert.rejects(preview(native, doc, 0), { code: 'INVALID_ARGUMENT' }); assert.equal(renders(), 4);
});

test('exports and reopened projects render independently and cache reads change no saved bytes', async t => {
  const { native, document: doc, dataDir, renders } = await fixture(t);
  const file = path.join(dataDir, 'projects', `${doc.id}.json`), before = await fs.readFile(file);
  const cached = await preview(native, doc);
  for (let i = 0; i < 2; i++) {
    const exported = await native.execute('export_document', { documentId: doc.id, format: 'png' });
    assert.equal(exported.data, cached.data);
    assert.equal((await sharp(Buffer.from(exported.data, 'base64')).metadata()).width, 96);
  }
  assert.equal(renders(), 3); assert.deepEqual(await preview(native, doc), cached); assert.equal(renders(), 3);
  assert.deepEqual(await fs.readFile(file), before);
  const reopened = await new NativeBackend({ dataDir }).init(); assert.equal(reopened.previewCache.stats().entries, 0);
  assert.deepEqual(await preview(reopened, doc), cached); assert.equal(reopened.previewCache.stats().entries, 1);
});
