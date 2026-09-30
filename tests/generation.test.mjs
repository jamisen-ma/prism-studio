import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { GenerationManager } from '../server/generation.mjs';

const TEST_KEY = 'test-injected-key-never-persist';
const blue = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#0000ff' } }).png().toBuffer();
const output = () => ({ data: blue, mimeType: 'image/png', model: 'gpt-image-2.5-sunburst', usage: { input_tokens: 10, output_tokens: 20, input_tokens_details: { image_tokens: 5 } }, requestId: 'req_test123', revisedPrompt: 'A blue test image' });
const coded = (code) => (cause) => cause.code === code;
const pause = (milliseconds = 5) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function controlledProvider({ ignoreAbort = false } = {}) {
  const state = { calls: [], active: 0, peak: 0 };
  state.provider = (args) => {
    state.active++; state.peak = Math.max(state.peak, state.active);
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const cancel = () => reject(Object.assign(new Error('Cancelled fake request'), { code: 'AI_CANCELLED' }));
    if (!ignoreAbort) { args.signal.addEventListener('abort', cancel, { once: true }); if (args.signal.aborted) cancel(); }
    state.calls.push({ args, resolve, reject });
    return promise.finally(() => { state.active--; args.signal.removeEventListener('abort', cancel); });
  };
  return state;
}

async function until(check, label = 'condition') {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await pause(); }
  assert.fail(`Timed out waiting for ${label}`);
}
const status = (manager, id, desired) => until(() => {
  const job = manager.get(id).job;
  return (Array.isArray(desired) ? desired : [desired]).includes(job.status) ? job : false;
}, `generation job to become ${desired}`);

async function fixture(t, provider = async () => output(), getKey = async () => TEST_KEY) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-generation-test-'));
  const native = await new NativeBackend({ dataDir }).init();
  const manager = await new GenerationManager({ dataDir, native, getKey, provider }).init();
  t.after(async () => { await manager.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, native, manager };
}
async function document(native, options = {}) { return (await native.execute('create_document', { name: 'Original', width: 8, height: 8, background: '#804020', ...options })).document; }
async function render(native, documentId) {
  const result = await native.execute('export_document', { documentId, format: 'png' });
  return sharp(Buffer.from(result.data, 'base64')).ensureAlpha().raw().toBuffer();
}

test('generation creates a real project, preserves provider bytes/metadata, and never persists injected keys', async (t) => {
  const { manager, native, dataDir } = await fixture(t);
  const { job } = await manager.start({ provider: 'openai', mode: 'generate', prompt: 'Blue square', name: 'Generated square' });
  assert.equal(job.status, 'queued'); assert.equal(job.outputAvailable, false);
  const completed = await status(manager, job.id, 'succeeded');
  assert.equal(completed.outputAvailable, true); assert.equal(completed.usage.output_tokens, 20);
  const current = (await native.execute('get_document', { documentId: completed.documentId })).document;
  assert.equal(current.name, 'Generated square'); assert.equal(current.layers.length, 1);
  assert.equal(current.layers[0].role, 'generated'); assert.equal(current.layers[0].provenance.jobId, job.id);
  assert.deepEqual(await fs.readFile(path.join(dataDir, 'assets', current.layers[0].sourceAsset)), blue);
  assert.deepEqual((await manager.output(job.id)).data, blue);
  assert.equal((await render(native, current.id))[2], 255);
  const saved = await fs.readFile(path.join(dataDir, 'generation', 'jobs', `${job.id}.json`), 'utf8');
  assert.ok(!saved.includes(TEST_KEY)); assert.ok(!JSON.stringify(manager.list()).includes(TEST_KEY));
  assert.equal(JSON.parse(saved).providerMetadata.requestId, 'req_test123');
  assert.equal(JSON.parse(saved).providerMetadata.revisedPrompt, 'A blue test image');
  assert.ok(!Object.hasOwn(completed, 'data')); assert.ok(!Object.hasOwn(completed, 'inputAsset'));
});

test('missing configuration and invalid edit arguments fail before creating or charging a job', async (t) => {
  let calls = 0;
  const { manager } = await fixture(t, async () => { calls++; return output(); }, async () => null);
  await assert.rejects(manager.start({ provider: 'openai', mode: 'generate', prompt: 'Anything' }), coded('AI_NOT_CONFIGURED'));
  await assert.rejects(manager.start({ provider: 'openai', mode: 'edit', prompt: 'Anything' }), coded('INVALID_ARGUMENTS'));
  assert.equal(manager.list().jobs.length, 0); assert.equal(calls, 0);
});

test('request deduplication is persistent and never regenerates completed output', async (t) => {
  let calls = 0;
  const { manager, native, dataDir } = await fixture(t, async () => { calls++; return output(); });
  const args = { provider: 'openai', mode: 'generate', prompt: 'Deduplicated', requestId: 'request-one' };
  const first = await manager.start(args), second = await manager.start(args);
  assert.equal(first.job.id, second.job.id);
  await status(manager, first.job.id, 'succeeded');
  await assert.rejects(manager.start({ ...args, prompt: 'Different' }), coded('IDEMPOTENCY_CONFLICT'));
  await manager.close();
  const reopened = await new GenerationManager({ dataDir, native, getKey: async () => null, provider: async () => { calls++; return output(); } }).init();
  t.after(() => reopened.close());
  assert.equal((await reopened.start(args)).job.id, first.job.id, 'retrieving a duplicate result requires no configured key');
  assert.equal(calls, 1); assert.deepEqual((await reopened.output(first.job.id)).data, blue);
});

test('queue is bounded to one active and five waiting jobs and never overlaps provider requests', async (t) => {
  const fake = controlledProvider();
  const { manager } = await fixture(t, fake.provider);
  const jobs = [];
  for (let index = 0; index < 6; index++) jobs.push((await manager.start({ provider: 'openai', mode: 'generate', prompt: `Job ${index}` })).job);
  await until(() => fake.calls.length === 1);
  await assert.rejects(manager.start({ provider: 'openai', mode: 'generate', prompt: 'Queue overflow' }), coded('QUEUE_FULL'));
  await manager.cancel(jobs[2].id);
  fake.calls[0].resolve(output());
  await status(manager, jobs[0].id, 'succeeded');
  await until(() => fake.calls.length === 2);
  assert.equal(fake.peak, 1); assert.equal(fake.calls[1].args.prompt, 'Job 1');
  await manager.cancel(jobs[1].id);
  await until(() => fake.calls.length === 3);
  assert.equal(fake.calls[2].args.prompt, 'Job 3'); assert.equal(fake.peak, 1);
  await manager.close();
  assert.equal(manager.get(jobs[4].id).job.status, 'cancelled');
});

test('selected edits capture input/mask and retain stale results for one-step explicit application', async (t) => {
  const fake = controlledProvider();
  const { manager, native } = await fixture(t, fake.provider);
  let original = await document(native);
  original = (await native.execute('select_rectangle', { documentId: original.id, x: 0, y: 0, width: 4, height: 8 })).document;
  const { job } = await manager.start({ provider: 'openai', mode: 'edit', prompt: 'Make selected half blue', documentId: original.id, expectedRevision: original.revision, scope: 'selection' });
  await until(() => fake.calls.length === 1);
  const request = fake.calls[0].args;
  assert.equal(request.apiKey, TEST_KEY); assert.ok(Buffer.isBuffer(request.image)); assert.ok(Buffer.isBuffer(request.mask));
  const mask = await sharp(request.mask).ensureAlpha().raw().toBuffer();
  assert.equal(mask[3], 0); assert.equal(mask[7 * 4 + 3], 255);
  await native.execute('select_rectangle', { documentId: original.id, x: 4, y: 0, width: 4, height: 8 });
  const current = (await native.execute('add_adjustment', { documentId: original.id, kind: 'brightness', value: 10 })).document;
  const before = await render(native, original.id);
  fake.calls[0].resolve(output());
  const ready = await until(() => { const current = manager.get(job.id).job; return current.status === 'ready' && current.error ? current : false; });
  assert.equal(ready.error.code, 'REVISION_CONFLICT'); assert.equal(ready.outputAvailable, true);
  assert.deepEqual(await render(native, original.id), before);
  await assert.rejects(manager.apply({ jobId: job.id }), coded('INVALID_ARGUMENT'));
  await assert.rejects(manager.apply({ jobId: job.id, expectedRevision: original.revision }), coded('REVISION_CONFLICT'));
  assert.equal(fake.calls.length, 1);
  const applied = await manager.apply({ jobId: job.id, expectedRevision: current.revision });
  assert.equal(applied.job.status, 'succeeded'); assert.equal(applied.document.revision, current.revision + 1);
  assert.equal(applied.document.layers.length, current.layers.length + 1);
  const after = await render(native, original.id);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const pixel = (y * 8 + x) * 4;
    if (x < 4) assert.deepEqual([...after.subarray(pixel, pixel + 4)], [0, 0, 255, 255]);
    else assert.deepEqual(after.subarray(pixel, pixel + 4), before.subarray(pixel, pixel + 4), 'current selection must not replace captured selection');
  }
  await native.execute('undo', { documentId: original.id }); assert.deepEqual(await render(native, original.id), before);
  await native.execute('redo', { documentId: original.id }); assert.deepEqual(await render(native, original.id), after);
  await manager.apply({ jobId: job.id }); assert.equal(fake.calls.length, 1);
});

test('mask dimensions reject a changed canvas, retaining the paid result for later application', async (t) => {
  const fake = controlledProvider();
  const { manager, native } = await fixture(t, fake.provider);
  let doc = await document(native);
  doc = (await native.execute('select_rectangle', { documentId: doc.id, x: 0, y: 0, width: 4, height: 8 })).document;
  const { job } = await manager.start({ provider: 'openai', mode: 'edit', prompt: 'Blue area', scope: 'selection', documentId: doc.id, expectedRevision: doc.revision });
  await until(() => fake.calls.length === 1);
  let current = (await native.execute('resize_document', { documentId: doc.id, width: 4, height: 4 })).document;
  fake.calls[0].resolve(output()); await status(manager, job.id, 'ready');
  await assert.rejects(manager.apply({ jobId: job.id, expectedRevision: current.revision }), coded('SNAPSHOT_DIMENSIONS_CHANGED'));
  assert.equal(manager.get(job.id).job.status, 'ready'); assert.equal(manager.get(job.id).job.outputAvailable, true);
  current = (await native.execute('undo', { documentId: doc.id })).document;
  assert.equal((await manager.apply({ jobId: job.id, expectedRevision: current.revision })).job.status, 'succeeded');
  assert.equal(fake.calls.length, 1);
});

test('cancellation prevents late provider output from applying and does not start a second call prematurely', async (t) => {
  const fake = controlledProvider({ ignoreAbort: true });
  const { manager, native } = await fixture(t, fake.provider);
  const first = (await manager.start({ provider: 'openai', mode: 'generate', prompt: 'Slow one' })).job;
  const second = (await manager.start({ provider: 'openai', mode: 'generate', prompt: 'Next one' })).job;
  await until(() => fake.calls.length === 1);
  await manager.cancel(first.id); await pause(10);
  assert.equal(fake.calls.length, 1); assert.equal(fake.calls[0].args.signal.aborted, true);
  fake.calls[0].resolve(output());
  await until(() => fake.calls.length === 2);
  assert.equal((await native.execute('list_documents')).documents.length, 0);
  fake.calls[1].resolve(output()); await status(manager, second.id, 'succeeded');
  assert.equal(fake.peak, 1); assert.equal(manager.get(first.id).job.status, 'cancelled');
});

test('close aborts pending work and no document appears after it returns', async (t) => {
  const fake = controlledProvider();
  const { manager, native } = await fixture(t, fake.provider);
  const { job } = await manager.start({ provider: 'openai', mode: 'generate', prompt: 'Close before finish' });
  await until(() => fake.calls.length === 1);
  await manager.close();
  assert.equal(fake.calls[0].args.signal.aborted, true); assert.equal(manager.get(job.id).job.status, 'cancelled');
  fake.calls[0].resolve(output()); await pause(10);
  assert.equal((await native.execute('list_documents')).documents.length, 0);
  await assert.rejects(manager.start({ provider: 'openai', mode: 'generate', prompt: 'After close' }), coded('CLOSED'));
});

test('restart marks queued/running jobs interrupted without another provider call', async (t) => {
  const { manager, native, dataDir } = await fixture(t);
  const jobs = [];
  for (let i = 0; i < 2; i++) {
    const { job } = await manager.start({ provider: 'openai', mode: 'generate', prompt: `Persisted ${i}`, requestId: `restart-${i}` });
    await status(manager, job.id, 'succeeded'); jobs.push(job);
  }
  await manager.close();
  for (let i = 0; i < jobs.length; i++) {
    const file = path.join(dataDir, 'generation', 'jobs', `${jobs[i].id}.json`), record = JSON.parse(await fs.readFile(file, 'utf8'));
    record.status = i ? 'running' : 'queued'; delete record.outputAsset;
    await fs.writeFile(file, JSON.stringify(record));
  }
  let calls = 0;
  const reopened = await new GenerationManager({ dataDir, native, getKey: async () => TEST_KEY, provider: async () => { calls++; return output(); } }).init();
  t.after(() => reopened.close());
  for (const job of jobs) { assert.equal(reopened.get(job.id).job.status, 'failed'); assert.equal(reopened.get(job.id).job.error.code, 'INTERRUPTED'); }
  assert.equal(calls, 0);
});

test('unsafe provider exception text and usage strings never reach persisted or public errors', async (t) => {
  const { manager, dataDir } = await fixture(t, async () => { throw new Error(`Authorization: Bearer ${TEST_KEY}`); });
  const { job } = await manager.start({ provider: 'openai', mode: 'generate', prompt: 'Fail safely' });
  const failed = await status(manager, job.id, 'failed');
  assert.equal(failed.error.code, 'AI_FAILED'); assert.ok(!JSON.stringify(failed).includes(TEST_KEY));
  const saved = await fs.readFile(path.join(dataDir, 'generation', 'jobs', `${job.id}.json`), 'utf8');
  assert.ok(!saved.includes(TEST_KEY));
});

test('a missing success receipt cannot duplicate an already installed generated layer', async (t) => {
  let calls = 0;
  const { manager, native } = await fixture(t, async () => { calls++; return output(); });
  const writeJob = manager.writeJob.bind(manager); let failedReceipt = false;
  manager.writeJob = async (record) => {
    if (record.status === 'succeeded' && !failedReceipt) { failedReceipt = true; throw Object.assign(new Error('Simulated receipt failure'), { code: 'EIO' }); }
    return writeJob(record);
  };
  const { job } = await manager.start({ provider: 'openai', mode: 'generate', prompt: 'Install exactly once' });
  await until(() => { const current = manager.get(job.id).job; return current.status === 'ready' && current.error; });
  const before = (await native.execute('list_documents')).documents;
  assert.equal(before.length, 1); assert.equal(before[0].layers.length, 1);
  const result = await manager.apply({ jobId: job.id });
  assert.equal(result.job.status, 'succeeded'); assert.equal(result.document.id, before[0].id); assert.equal(result.document.revision, before[0].revision);
  assert.equal((await native.execute('list_documents')).documents.length, 1); assert.equal(calls, 1);
});

test('generation into a document contains the image while edits cover the captured canvas', async (t) => {
  const { manager, native } = await fixture(t);
  const doc = await document(native, { width: 16, height: 8 });
  const first = (await manager.start({ provider: 'openai', mode: 'generate', prompt: 'Square image layer', documentId: doc.id, expectedRevision: doc.revision })).job;
  await status(manager, first.id, 'succeeded');
  const contained = await render(native, doc.id);
  assert.deepEqual([...contained.subarray(0, 4)], [128, 64, 32, 255]);
  assert.deepEqual([...contained.subarray(8 * 4, 8 * 4 + 4)], [0, 0, 255, 255]);
  const current = (await native.execute('get_document', { documentId: doc.id })).document;
  const second = (await manager.start({ provider: 'openai', mode: 'edit', prompt: 'Cover the canvas', documentId: doc.id, expectedRevision: current.revision })).job;
  await status(manager, second.id, 'succeeded');
  assert.deepEqual([...(await render(native, doc.id)).subarray(0, 4)], [0, 0, 255, 255]);
});

test('a running-receipt disk failure halts dispatch without a retry loop or provider charge', async (t) => {
  let providerCalls = 0, attempts = 0;
  const { manager } = await fixture(t, async () => { providerCalls++; return output(); });
  const writeJob = manager.writeJob.bind(manager);
  manager.writeJob = async (record) => {
    if (record.status === 'running') { attempts++; throw Object.assign(new Error('Simulated full disk'), { code: 'ENOSPC' }); }
    return writeJob(record);
  };
  const { job } = await manager.start({ provider: 'openai', mode: 'generate', prompt: 'Do not retry disk failures' });
  const failed = await status(manager, job.id, 'failed');
  assert.equal(failed.error.code, 'AI_STORAGE_FAILURE');
  await pause(30); assert.equal(attempts, 1); assert.equal(providerCalls, 0);
  manager.writeJob = writeJob;
  const resumed = await manager.start({ provider: 'openai', mode: 'generate', prompt: 'Explicit request after repair' });
  await status(manager, resumed.job.id, 'succeeded'); assert.equal(providerCalls, 1);
});

test('output storage is reserved before queue acceptance or any paid provider request', async (t) => {
  const fake = controlledProvider();
  const { manager } = await fixture(t, fake.provider);
  const limit = 512 * 1024 * 1024, reserve = 32 * 1024 * 1024;
  manager.bytes = limit;
  await assert.rejects(manager.start({ provider: 'openai', mode: 'generate', prompt: 'No room' }), coded('AI_STORAGE_FULL'));
  assert.equal(fake.calls.length, 0); assert.equal(manager.list().jobs.length, 0);
  manager.bytes = limit - reserve;
  const first = await manager.start({ provider: 'openai', mode: 'generate', prompt: 'One reservation fits' });
  await until(() => fake.calls.length === 1);
  await assert.rejects(manager.start({ provider: 'openai', mode: 'generate', prompt: 'Existing reservation consumes remaining room' }), coded('AI_STORAGE_FULL'));
  assert.equal(fake.calls.length, 1);
  fake.calls[0].resolve(output()); await status(manager, first.job.id, 'succeeded');
});

test('cover generation fills wide and tall canvases without stretching image proportions or forwarding local fit to the provider', async (t) => {
  const source = Buffer.alloc(8 * 8 * 4);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) source.set(x >= 3 && x <= 4 && y >= 3 && y <= 4 ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * 8 + x) * 4);
  const data = await sharp(source, { raw: { width: 8, height: 8, channels: 4 } }).png().toBuffer();
  const { manager, native } = await fixture(t, async (args) => {
    assert.equal(args.fit, undefined); return { ...output(), data };
  });
  for (const [width, height] of [[16, 8], [8, 16]]) {
    const doc = await document(native, { width, height });
    const { job } = await manager.start({ provider: 'openai', mode: 'generate', prompt: 'Proportional background', documentId: doc.id, expectedRevision: doc.revision, fit: 'cover' });
    assert.equal(job.fit, 'cover'); await status(manager, job.id, 'succeeded');
    const applied = (await native.execute('get_document', { documentId: doc.id })).document, layer = applied.layers.at(-1);
    assert.equal(layer.provenance.fit, 'cover');
    const pixels = await native.renderLayer(layer), red = [];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      assert.equal(pixels[(y * width + x) * 4 + 3], 255, 'cover must not introduce letterboxing');
      if (pixels[(y * width + x) * 4] > 128) red.push({ x, y });
    }
    assert.ok(red.length > 0);
    const markerWidth = Math.max(...red.map(({ x }) => x)) - Math.min(...red.map(({ x }) => x)) + 1;
    const markerHeight = Math.max(...red.map(({ y }) => y)) - Math.min(...red.map(({ y }) => y)) + 1;
    assert.equal(markerWidth, markerHeight, 'a square marker must remain square after proportional cover');
    assert.ok(markerWidth >= 3 && markerWidth <= 5, 'the centered marker scales uniformly without being stretched across the canvas');
  }
  await assert.rejects(manager.start({ provider: 'openai', mode: 'edit', prompt: 'Invalid local fit', documentId: (await native.execute('list_documents')).documents[0].id, expectedRevision: 1, fit: 'cover' }), coded('INVALID_ARGUMENTS'));
  await assert.rejects(native.installGeneratedImage({ data, provenance: { fit: 'stretch' } }), coded('INVALID_ARGUMENT'));
});
