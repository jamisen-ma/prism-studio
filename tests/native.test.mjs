import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-native-test-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const backend = await new NativeBackend({ dataDir }).init();
  return { backend, dataDir };
}
async function create(backend, options = {}) {
  return (await backend.execute('create_document', { name: 'Test document', width: 16, height: 12, background: '#406080', ...options })).document;
}
async function pixels(backend, documentId) {
  const result = await backend.execute('export_document', { documentId, format: 'png' });
  return sharp(Buffer.from(result.data, 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}
const coded = (code) => (cause) => cause.code === code;

test('masked adjustments preserve every outside RGBA byte and inward feathering has bounded support', async (t) => {
  const { backend } = await fixture(t);
  const width = 12, height = 10;
  const source = Buffer.alloc(width * height * 4);
  for (let i = 0; i < source.length; i += 4) { source[i] = 40 + i % 71; source[i + 1] = 80; source[i + 2] = 130; source[i + 3] = i % 3 ? 255 : 128; }
  const png = await sharp(source, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const { document } = await backend.execute('import_image', { name: 'Mask fixture', mimeType: 'image/png', data: png.toString('base64') });
  const before = (await pixels(backend, document.id)).data;
  await backend.execute('add_adjustment', { documentId: document.id, kind: 'exposure', value: 1, mask: { x: 3, y: 2, width: 5, height: 5, feather: 1 } });
  const after = (await pixels(backend, document.id)).data;
  let changed = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    if (x < 3 || x >= 8 || y < 2 || y >= 7) assert.deepEqual(after.subarray(i, i + 4), before.subarray(i, i + 4));
    else if (!after.subarray(i, i + 3).equals(before.subarray(i, i + 3))) changed++;
    assert.equal(after[i + 3], before[i + 3], 'adjustments must not change alpha');
  }
  assert.equal(changed, 25);
  await backend.execute('undo', { documentId: document.id });
  await backend.execute('add_adjustment', { documentId: document.id, kind: 'brightness', value: 25, mask: { x: 3, y: 2, width: 5, height: 5, invert: true } });
  const inverted = (await pixels(backend, document.id)).data;
  assert.deepEqual(inverted.subarray((3 * width + 4) * 4, (3 * width + 4) * 4 + 4), before.subarray((3 * width + 4) * 4, (3 * width + 4) * 4 + 4));
  assert.notDeepEqual(inverted.subarray(0, 3), before.subarray(0, 3));
});

test('original assets, history and redo survive reopening; undo revisions remain monotonic', async (t) => {
  const { backend, dataDir } = await fixture(t);
  const original = await sharp({ create: { width: 12, height: 8, channels: 3, background: '#345678' } }).jpeg().toBuffer();
  let { document } = await backend.execute('import_image', { name: 'Original.jpg', mimeType: 'image/jpeg', data: original.toString('base64') });
  const initial = (await pixels(backend, document.id)).data;
  const sourcePath = path.join(dataDir, 'assets', document.layers[0].sourceAsset);
  assert.deepEqual(await fs.readFile(sourcePath), original);
  ({ document } = await backend.execute('add_adjustment', { documentId: document.id, expectedRevision: document.revision, kind: 'temperature', value: 70 }));
  const edited = (await pixels(backend, document.id)).data;
  assert.notDeepEqual(edited, initial);
  ({ document } = await backend.execute('undo', { documentId: document.id, expectedRevision: document.revision }));
  assert.equal(document.revision, 3);
  assert.equal(document.canRedo, true);
  const reopened = await new NativeBackend({ dataDir }).init();
  const loaded = (await reopened.execute('get_document', { documentId: document.id })).document;
  assert.equal(loaded.revision, 3); assert.equal(loaded.canRedo, true);
  assert.deepEqual((await pixels(reopened, document.id)).data, initial);
  ({ document } = await reopened.execute('redo', { documentId: document.id, expectedRevision: 3 }));
  assert.equal(document.revision, 4);
  assert.deepEqual((await pixels(reopened, document.id)).data, edited);
  await reopened.execute('undo', { documentId: document.id });
  ({ document } = await reopened.execute('add_adjustment', { documentId: document.id, kind: 'brightness', value: -20 }));
  assert.equal(document.canRedo, false);
  assert.deepEqual(await fs.readFile(sourcePath), original);
  assert.deepEqual((await fs.readdir(path.join(dataDir, 'projects'))).filter((entry) => entry.endsWith('.tmp')), []);
});

test('transactions commit one history step and completely roll back invalid operations', async (t) => {
  const { backend, dataDir } = await fixture(t);
  const initial = await create(backend);
  const before = (await pixels(backend, initial.id)).data;
  const { document } = await backend.execute('apply_transaction', { documentId: initial.id, expectedRevision: 1, label: 'Warm and brighten', operations: [
    { command: 'add_adjustment', args: { kind: 'temperature', value: 50 } },
    { command: 'add_adjustment', args: { kind: 'brightness', value: 10 } },
  ] });
  assert.equal(document.revision, 2); assert.equal(document.history.length, 2); assert.equal(document.history[1].label, 'Warm and brighten');
  assert.equal(document.layers.length, 3);
  await backend.execute('undo', { documentId: initial.id });
  assert.deepEqual((await pixels(backend, initial.id)).data, before);
  const file = path.join(dataDir, 'projects', `${initial.id}.json`);
  const saved = await fs.readFile(file);
  await assert.rejects(backend.execute('apply_transaction', { documentId: initial.id, operations: [
    { command: 'add_adjustment', args: { kind: 'contrast', value: 30 } },
    { command: 'set_layer', args: { layerId: 'missing', visible: false } },
  ] }), coded('NOT_FOUND'));
  assert.deepEqual(await fs.readFile(file), saved);
  assert.equal((await backend.execute('get_document', { documentId: initial.id })).document.layers.length, 1);
  await assert.rejects(backend.execute('apply_transaction', { documentId: initial.id, operations: [{ command: 'undo', args: {} }] }), coded('INVALID_ARGUMENT'));
  await assert.rejects(backend.execute('apply_transaction', { documentId: initial.id, operations: [{ command: 'clear_selection', args: { documentId: 'another-document' } }] }), coded('INVALID_ARGUMENT'));
});

test('crop and resize keep originals and reversible layer geometry; selections constrain adjustments', async (t) => {
  const { backend } = await fixture(t);
  const document = await create(backend, { width: 20, height: 16 });
  const before = (await pixels(backend, document.id)).data;
  await backend.execute('select_rectangle', { documentId: document.id, x: 4, y: 4, width: 8, height: 8 });
  let next = (await backend.execute('add_adjustment', { documentId: document.id, kind: 'brightness', value: 20 })).document;
  assert.deepEqual(next.layers[1].mask, { x: 4, y: 4, width: 8, height: 8, feather: 0, invert: false });
  await backend.execute('crop_document', { documentId: document.id, x: 2, y: 2, width: 16, height: 12 });
  next = (await backend.execute('resize_document', { documentId: document.id, width: 8, height: 6 })).document;
  assert.equal(next.width, 8); assert.equal(next.height, 6);
  assert.deepEqual(next.layers[1].mask, { x: 1, y: 1, width: 4, height: 4, feather: 0, invert: false });
  const output = await pixels(backend, document.id);
  assert.equal(output.info.width, 8); assert.equal(output.info.height, 6);
  assert.deepEqual(output.data.subarray(0, 4), before.subarray(0, 4));
  for (let i = 0; i < 4; i++) await backend.execute('undo', { documentId: document.id });
  assert.deepEqual((await pixels(backend, document.id)).data, before);
});

test('layers render text safely, respect visibility and opacity, duplicate, reorder and delete', async (t) => {
  const { backend } = await fixture(t);
  const document = await create(backend, { width: 240, height: 100, background: '#ffffff' });
  const blank = (await pixels(backend, document.id)).data;
  let result = await backend.execute('add_text', { documentId: document.id, text: 'Hello <&> world', x: 8, y: 8, fontSize: 24, color: '#000000' });
  const textLayer = result.document.layers[1];
  const visible = (await pixels(backend, document.id)).data;
  assert.notDeepEqual(visible, blank);
  await backend.execute('set_layer', { documentId: document.id, layerId: textLayer.id, visible: false });
  assert.deepEqual((await pixels(backend, document.id)).data, blank);
  await backend.execute('set_layer', { documentId: document.id, layerId: textLayer.id, visible: true, opacity: 0.5, blendMode: 'multiply' });
  const translucent = (await pixels(backend, document.id)).data;
  assert.notDeepEqual(translucent, blank); assert.notDeepEqual(translucent, visible);
  result = await backend.execute('duplicate_layer', { documentId: document.id, layerId: textLayer.id });
  const copy = result.document.layers[2]; assert.notEqual(copy.id, textLayer.id);
  await backend.execute('reorder_layer', { documentId: document.id, layerId: copy.id, index: 0 });
  assert.equal((await backend.execute('get_document', { documentId: document.id })).document.layers[0].id, copy.id);
  await backend.execute('delete_layer', { documentId: document.id, layerId: copy.id });
  await backend.execute('delete_layer', { documentId: document.id, layerId: textLayer.id });
  assert.deepEqual((await pixels(backend, document.id)).data, blank);
});

test('validates actual image format, honors EXIF orientation, and rejects unsafe sizes and unsupported inputs', async (t) => {
  const { backend } = await fixture(t);
  await assert.rejects(create(backend, { width: 8193 }), coded('INVALID_ARGUMENT'));
  await assert.rejects(create(backend, { width: 8192, height: 8192 }), coded('LIMIT_EXCEEDED'));
  await assert.rejects(create(backend, { width: 1.5 }), coded('INVALID_ARGUMENT'));
  await assert.rejects(create(backend, { width: 0 }), coded('INVALID_ARGUMENT'));
  await assert.rejects(backend.execute('import_image', { mimeType: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64') }), coded('UNSUPPORTED'));
  await assert.rejects(backend.execute('import_image', { mimeType: 'image/png', data: 'not base64!' }), coded('INVALID_ARGUMENT'));
  const original = await sharp({ create: { width: 10, height: 6, channels: 3, background: '#123456' } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  await assert.rejects(backend.execute('import_image', { mimeType: 'image/png', data: original.toString('base64') }), coded('INVALID_ARGUMENT'));
  const { document } = await backend.execute('import_image', { mimeType: 'image/jpeg', data: original.toString('base64') });
  assert.equal(document.width, 6); assert.equal(document.height, 10);
  await assert.rejects(backend.execute('resize_document', { documentId: document.id, width: 8192, height: 8192 }), coded('LIMIT_EXCEEDED'));
  await assert.rejects(backend.execute('crop_document', { documentId: document.id, x: 4, y: 0, width: 6, height: 6 }), coded('INVALID_ARGUMENT'));
  await assert.rejects(backend.execute('select_subject', { documentId: document.id }), coded('UNSUPPORTED'));
});

test('previews report resized dimensions, exports decode and neutral adjustments do not drift', async (t) => {
  const { backend } = await fixture(t);
  const document = await create(backend, { width: 120, height: 80 });
  const before = (await pixels(backend, document.id)).data;
  for (const kind of ['brightness', 'contrast', 'exposure', 'saturation', 'temperature', 'blur', 'sharpen']) await backend.execute('add_adjustment', { documentId: document.id, kind, value: 0 });
  assert.deepEqual((await pixels(backend, document.id)).data, before);
  const preview = await backend.execute('get_preview', { documentId: document.id, maxWidth: 60 });
  assert.equal(preview.width, 60); assert.equal(preview.height, 40); assert.equal(preview.revision, 8);
  const actual = await sharp(Buffer.from(preview.data, 'base64')).metadata();
  assert.equal(actual.width, 60); assert.equal(actual.height, 40);
  for (const format of ['png', 'jpeg', 'webp']) {
    const result = await backend.execute('export_document', { documentId: document.id, format, quality: 85 });
    const metadata = await sharp(Buffer.from(result.data, 'base64')).metadata();
    assert.equal(metadata.format, format); assert.equal(metadata.width, 120); assert.equal(metadata.height, 80);
    assert.ok(metadata.icc);
  }
  await backend.execute('add_adjustment', { documentId: document.id, kind: 'blur', value: 2 });
  await backend.execute('add_adjustment', { documentId: document.id, kind: 'sharpen', value: 1 });
  assert.equal((await pixels(backend, document.id)).data.length, 120 * 80 * 4);
});

test('concurrent revisions cannot overwrite each other, and returned documents are detached copies', async (t) => {
  const { backend } = await fixture(t);
  const document = await create(backend);
  const results = await Promise.allSettled([
    backend.execute('add_adjustment', { documentId: document.id, expectedRevision: 1, kind: 'exposure', value: 1 }),
    backend.execute('add_adjustment', { documentId: document.id, expectedRevision: 1, kind: 'exposure', value: -1 }),
  ]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(results.find((item) => item.status === 'rejected').reason.code, 'REVISION_CONFLICT');
  const current = (await backend.execute('get_document', { documentId: document.id })).document;
  current.layers[0].visible = false;
  assert.equal((await backend.execute('get_document', { documentId: document.id })).document.layers[0].visible, true);
  const capabilities = await backend.execute('capabilities');
  assert.ok(capabilities.commands.includes('apply_transaction'));
  assert.ok(!capabilities.commands.includes('select_subject'));
  assert.ok(capabilities.limitations.some((line) => line.includes('8-bit')));
});

test('an edit exceeding the reopen size limit preserves the complete previous project on disk and in memory', async (t) => {
  const { backend, dataDir } = await fixture(t);
  const document = await create(backend, { width: 1, height: 1 });
  const file = path.join(dataDir, 'projects', `${document.id}.json`);
  const project = JSON.parse(await fs.readFile(file, 'utf8'));
  const graph = project.states[0].graph;
  const original = graph.layers[0];
  // Valid 1-pixel layers with long reversible geometry histories. The metadata
  // reproduces the size problem without generating or rendering large images.
  graph.layers = Array.from({ length: 64 }, (_, index) => ({
    ...original, id: randomUUID(), name: `Layer ${index}`, transforms: Array.from({ length: 400 }, () => ({ type: 'resize', width: 1, height: 1 })),
  }));
  const { maxProjectBytes } = (await backend.execute('capabilities')).limits;
  let serialized;
  for (;;) {
    const candidate = JSON.stringify(project);
    if (Buffer.byteLength(candidate, 'utf8') > maxProjectBytes) {
      project.states.pop(); project.cursor = project.states.length - 1;
      serialized = JSON.stringify(project);
      break;
    }
    project.states.push({ graph, history: { id: randomUUID(), label: 'Resize canvas', timestamp: new Date().toISOString() } });
    project.cursor = project.states.length - 1;
  }
  assert.ok(project.states.length < 100, 'fixture must exercise the size cap, not the history count cap');
  assert.ok(Buffer.byteLength(serialized, 'utf8') <= maxProjectBytes);
  await fs.writeFile(file, serialized);
  const reopened = await new NativeBackend({ dataDir }).init();
  assert.equal((await reopened.execute('list_documents')).documents.length, 1);
  const before = (await reopened.execute('get_document', { documentId: document.id })).document;
  await assert.rejects(reopened.execute('set_layer', { documentId: document.id, expectedRevision: before.revision, layerId: before.layers[0].id, visible: false }), coded('LIMIT_EXCEEDED'));
  const after = (await reopened.execute('get_document', { documentId: document.id })).document;
  assert.equal(after.revision, before.revision);
  assert.equal(after.layers[0].visible, true);
  assert.deepEqual(after.history, before.history);
  assert.equal(await fs.readFile(file, 'utf8'), serialized);
  assert.equal((await fs.readdir(path.join(dataDir, 'projects'))).filter((entry) => entry.endsWith('.tmp')).length, 0);
  const recovered = await new NativeBackend({ dataDir }).init();
  assert.equal((await recovered.execute('list_documents')).documents.length, 1);
});
