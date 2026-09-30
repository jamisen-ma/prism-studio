import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { GenerationManager } from '../server/generation.mjs';
import { NativeBackend } from '../server/native.mjs';
import { validateGeneration, CODEX_IMAGE_MODEL, DEFAULT_IMAGE_MODEL } from '../shared/generation.mjs';

const blue = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#0000ff' } }).png().toBuffer();
const red = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#ff0000' } }).png().toBuffer();
const coded = (code) => (cause) => cause.code === code;
const edit = async (native, doc, command, args = {}) => (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document;
const pixel = (pixels, x, y) => [...pixels.subarray((y * 8 + x) * 4, (y * 8 + x) * 4 + 4)];
async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-codex-generation-'));
  const native = await new NativeBackend({ dataDir }).init(), calls = { keys: 0, provider: 0 };
  const getKey = async () => { calls.keys++; throw Error('Credential callback must never be called for Codex.'); };
  const provider = async () => { calls.provider++; throw Error('API provider must never be called for Codex.'); };
  const manager = await new GenerationManager({ dataDir, native, getKey, provider, ...options }).init();
  t.after(async () => { await manager.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, native, manager, calls, getKey, provider };
}
async function create(native) { return (await native.execute('create_document', { width: 8, height: 8, background: '#804020' })).document; }

test('new jobs default to a durable conversation handoff and never read credentials or call an API', async (t) => {
  const { dataDir, native, manager, calls, getKey, provider } = await fixture(t);
  const input = { mode: 'generate', prompt: 'Warm autumn studio background', requestId: 'conversation-one' };
  const { job } = await manager.start(input);
  assert.equal(job.provider, 'codex'); assert.equal(job.model, CODEX_IMAGE_MODEL); assert.equal(job.status, 'awaiting_image');
  assert.equal(job.outputAvailable, false); assert.deepEqual(calls, { keys: 0, provider: 0 });
  assert.equal((await native.execute('list_documents')).documents.length, 0);
  const handoff = await manager.handoff(job.id);
  assert.equal(handoff.job.id, job.id); assert.equal(handoff.request.prompt, input.prompt); assert.equal(handoff.request.provider, 'codex');
  assert.equal(handoff.image, undefined); assert.equal(handoff.mask, undefined); assert.equal(handoff.snapshot, undefined);
  assert.equal(handoff.request.requestId, undefined); assert.equal(manager.reservedBytes(), 32 * 1024 * 1024);
  await manager.close();
  const reopened = await new GenerationManager({ dataDir, native, getKey, provider }).init(); t.after(() => reopened.close());
  assert.equal(reopened.get(job.id).job.status, 'awaiting_image'); assert.equal((await reopened.start(input)).job.id, job.id);
  assert.equal((await reopened.handoff({ jobId: job.id })).request.prompt, input.prompt); assert.deepEqual(calls, { keys: 0, provider: 0 });
});

test('completion creates one editable project, preserves tool output bytes and is immutable/idempotent across restart', async (t) => {
  const { dataDir, native, manager, calls, getKey, provider } = await fixture(t);
  const { job } = await manager.start({ mode: 'generate', prompt: 'Blue image', name: 'Conversation output' });
  const result = await manager.complete({ jobId: job.id, data: blue });
  assert.equal(result.job.status, 'succeeded'); assert.equal(result.document.name, 'Conversation output'); assert.equal(result.document.layers.length, 1);
  assert.equal(result.document.layers[0].provenance.model, CODEX_IMAGE_MODEL);
  assert.deepEqual(await fs.readFile(path.join(dataDir, 'assets', result.document.layers[0].sourceAsset)), blue);
  const receipt = await fs.readFile(path.join(dataDir, 'generation', 'jobs', `${job.id}.json`));
  assert.deepEqual((await manager.complete({ jobId: job.id, data: Buffer.from(blue) })).job, result.job);
  await assert.rejects(manager.complete({ jobId: job.id, data: red }), coded('IDEMPOTENCY_CONFLICT'));
  assert.deepEqual(await fs.readFile(path.join(dataDir, 'generation', 'jobs', `${job.id}.json`)), receipt);
  await manager.close();
  const reopened = await new GenerationManager({ dataDir, native, getKey, provider }).init(); t.after(() => reopened.close());
  assert.deepEqual((await reopened.complete({ jobId: job.id, data: blue })).job, result.job);
  assert.equal((await native.execute('list_documents')).documents.length, 1);
  assert.deepEqual((await reopened.output(job.id)).data, blue); assert.equal(reopened.reservedBytes(), 0); assert.deepEqual(calls, { keys: 0, provider: 0 });
});

test('selected Codex edits expose the captured PNG/mask and retain stale output for protected one-step application', async (t) => {
  const { native, manager, calls } = await fixture(t);
  let doc = await create(native);
  doc = await edit(native, doc, 'select_rectangle', { x: 0, y: 0, width: 4, height: 8 });
  const original = await native.renderGraph(doc);
  const { job } = await manager.start({ mode: 'edit', prompt: 'Make the selected area blue', documentId: doc.id, expectedRevision: doc.revision, scope: 'selection' });
  const handoff = await manager.handoff(job.id);
  assert.equal(handoff.snapshot.revision, doc.revision); assert.equal(handoff.snapshot.width, 8);
  assert.deepEqual(await sharp(handoff.image).ensureAlpha().raw().toBuffer(), original);
  const mask = await sharp(handoff.mask).ensureAlpha().raw().toBuffer(); assert.equal(pixel(mask, 1, 2)[3], 0); assert.equal(pixel(mask, 6, 2)[3], 255);
  doc = await edit(native, doc, 'add_shape', { shape: 'rectangle', x: 2, y: 2, width: 1, height: 1, fill: '#00ff00' });
  doc = await edit(native, doc, 'set_layer_protection', { layerId: doc.layers.at(-1).id, protected: true });
  const beforeApply = await native.renderGraph(doc), revision = doc.revision, layerCount = doc.layers.length;
  const completed = await manager.complete({ jobId: job.id, data: blue });
  assert.equal(completed.job.status, 'ready'); assert.equal(completed.job.error.code, 'REVISION_CONFLICT');
  assert.equal((await native.execute('get_document', { documentId: doc.id })).document.revision, revision);
  assert.deepEqual((await manager.complete({ jobId: job.id, data: blue })).job, completed.job, 'same-byte replay must not retry applying a stale result');
  await assert.rejects(manager.apply({ jobId: job.id }), coded('INVALID_ARGUMENT'));
  const applied = await manager.apply({ jobId: job.id, expectedRevision: revision });
  const pixels = await native.renderGraph(applied.document);
  assert.deepEqual(pixel(pixels, 1, 1), [0, 0, 255, 255]); assert.deepEqual(pixel(pixels, 2, 2), [0, 255, 0, 255]);
  for (let y = 0; y < 8; y++) for (let x = 4; x < 8; x++) assert.deepEqual(pixel(pixels, x, y), pixel(original, x, y));
  assert.equal(applied.document.layers.length, layerCount + 1); assert.equal(applied.document.revision, revision + 1);
  doc = await edit(native, applied.document, 'undo'); assert.deepEqual(await native.renderGraph(doc), beforeApply);
  assert.deepEqual(calls, { keys: 0, provider: 0 });
});

test('cancelled handoffs reject completion, invalid PNGs fail before writes, and pending storage reservations are bounded', async (t) => {
  const { dataDir, native, manager, calls } = await fixture(t);
  const { job } = await manager.start({ mode: 'generate', prompt: 'Validate output' });
  const receipt = await fs.readFile(path.join(dataDir, 'generation', 'jobs', `${job.id}.json`));
  const jpeg = await sharp(blue).jpeg().toBuffer();
  for (const data of [Buffer.from('not an image'), blue.subarray(0, Math.floor(blue.length / 2)), jpeg]) await assert.rejects(manager.complete({ jobId: job.id, data }), coded('AI_RESPONSE_INVALID'));
  assert.deepEqual(await fs.readFile(path.join(dataDir, 'generation', 'jobs', `${job.id}.json`)), receipt);
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'generation', 'assets')), []);
  await manager.cancel(job.id); assert.equal(manager.get(job.id).job.status, 'cancelled'); assert.equal(manager.reservedBytes(), 0);
  await assert.rejects(manager.handoff(job.id), coded('INVALID_TARGET')); await assert.rejects(manager.complete({ jobId: job.id, data: blue }), coded('INVALID_TARGET'));
  for (let index = 0; index < 6; index++) await manager.start({ mode: 'generate', prompt: `Waiting ${index}` });
  await assert.rejects(manager.start({ mode: 'generate', prompt: 'Too many waiting' }), coded('QUEUE_FULL'));
  assert.equal((await native.execute('list_documents')).documents.length, 0); assert.deepEqual(calls, { keys: 0, provider: 0 });
});

test('completed result replay is safe after a missing native success receipt and never installs twice', async (t) => {
  const { native, manager } = await fixture(t);
  const { job } = await manager.start({ mode: 'generate', prompt: 'Crash-safe installation' });
  const writeJob = manager.writeJob.bind(manager); let once = true;
  manager.writeJob = async (record) => { if (record.status === 'succeeded' && once) { once = false; throw Object.assign(new Error('Injected receipt failure'), { code: 'EIO' }); } return writeJob(record); };
  const ready = await manager.complete({ jobId: job.id, data: blue }); assert.equal(ready.job.status, 'ready');
  assert.equal((await native.execute('list_documents')).documents.length, 1);
  assert.equal((await manager.complete({ jobId: job.id, data: blue })).job.status, 'ready');
  const applied = await manager.apply({ jobId: job.id }); assert.equal(applied.job.status, 'succeeded');
  assert.equal((await native.execute('list_documents')).documents.length, 1);
});

test('explicit API jobs reject conversation handoff/completion and legacy receipts migrate without calling the provider', async (t) => {
  let calls = 0;
  const { native, manager, dataDir } = await fixture(t, { getKey: async () => 'fake-key', provider: async () => { calls++; return { data: blue, model: DEFAULT_IMAGE_MODEL }; } });
  const input = { provider: 'openai', mode: 'generate', prompt: 'Legacy API request', requestId: 'legacy-api-one' };
  const { job } = await manager.start(input);
  await assert.rejects(manager.handoff(job.id), coded('INVALID_TARGET')); await assert.rejects(manager.complete({ jobId: job.id, data: red }), coded('INVALID_TARGET'));
  await manager.worker; assert.equal(manager.get(job.id).job.status, 'succeeded'); assert.equal(calls, 1);
  await manager.close();
  const file = path.join(dataDir, 'generation', 'jobs', `${job.id}.json`), record = JSON.parse(await fs.readFile(file, 'utf8'));
  delete record.request.provider; record.fingerprint = '0'.repeat(64); await fs.writeFile(file, JSON.stringify(record));
  const reopened = await new GenerationManager({ dataDir, native, getKey: async () => { throw Error('No key needed for replay'); }, provider: async () => { calls++; throw Error('Never regenerate'); } }).init(); t.after(() => reopened.close());
  const replay = await reopened.start(input); assert.equal(replay.job.id, job.id); assert.equal(replay.job.provider, 'openai'); assert.equal(calls, 1);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).request.provider, 'openai');
  await assert.rejects(reopened.start({ ...input, provider: 'codex' }), coded('IDEMPOTENCY_CONFLICT'));
});

test('provider/model defaults are explicit and generation request revision guards remain unchanged', () => {
  assert.equal(validateGeneration({ mode: 'generate', prompt: 'Default' }).model, CODEX_IMAGE_MODEL);
  assert.equal(validateGeneration({ provider: 'openai', mode: 'generate', prompt: 'API' }).model, DEFAULT_IMAGE_MODEL);
  for (const args of [
    { provider: 'codex', model: DEFAULT_IMAGE_MODEL, mode: 'generate', prompt: 'Wrong model' },
    { provider: 'openai', model: CODEX_IMAGE_MODEL, mode: 'generate', prompt: 'Wrong model' },
    { mode: 'edit', prompt: 'Missing revision', documentId: 'some-document' },
  ]) assert.throws(() => validateGeneration(args), { code: 'INVALID_ARGUMENTS' });
});

test('close during completion cannot install an image and leaves the accepted handoff recoverable', async (t) => {
  const { native, manager } = await fixture(t);
  const { job } = await manager.start({ mode: 'generate', prompt: 'Close during handoff' });
  const store = manager.storeAsset.bind(manager); let entered, resume;
  const started = new Promise((resolve) => { entered = resolve; }), gate = new Promise((resolve) => { resume = resolve; });
  manager.storeAsset = async (...args) => { entered(); await gate; return store(...args); };
  const completion = manager.complete({ jobId: job.id, data: blue }); await started;
  const closed = manager.close(); resume();
  const result = await completion; await closed;
  assert.equal(result.job.status, 'ready'); assert.equal(result.job.outputAvailable, true);
  assert.equal((await native.execute('list_documents')).documents.length, 0);
});

test('cancellation also blocks a queued manual apply while allowing a later explicit retry of retained output', async (t) => {
  const { native, manager } = await fixture(t);
  let doc = await create(native);
  const { job } = await manager.start({ mode: 'generate', prompt: 'Retained layer', documentId: doc.id, expectedRevision: doc.revision });
  doc = await edit(native, doc, 'set_layer', { layerId: doc.layers[0].id, name: 'Revision changed' });
  assert.equal((await manager.complete({ jobId: job.id, data: blue })).job.status, 'ready');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  manager.locked(() => gate);
  const applying = manager.apply({ jobId: job.id, expectedRevision: doc.revision });
  const rejected = assert.rejects(applying, coded('AI_CANCELLED'));
  const cancelled = manager.cancel(job.id); release(); await rejected;
  assert.equal((await cancelled).job.status, 'cancelled');
  assert.equal((await native.execute('get_document', { documentId: doc.id })).document.revision, doc.revision);
  assert.equal((await manager.apply({ jobId: job.id, expectedRevision: doc.revision })).job.status, 'succeeded');
});
