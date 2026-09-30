import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { GenerationManager } from '../server/generation.mjs';
import { CodexWorker, CODEX_WORKER_POLL_MS } from '../server/codex-worker.mjs';
import { createCompanion } from '../server/index.mjs';

const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#2468ac' } }).png().toBuffer();
const different = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#fedcba' } }).png().toBuffer();
const denied = () => assert.fail('The optional API/key path must not be used.');
async function fixture(t, { automaticCodex = true, adapter } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-codex-worker-'));
  const native = await new NativeBackend({ dataDir: path.join(dataDir, 'native') }).init();
  const manager = await new GenerationManager({ dataDir, native, getKey: denied, provider: denied, automaticCodex }).init();
  let calls = 0;
  const runner = adapter ?? { check: async () => ({ available: true }), generate: async () => { calls++; return png; } };
  const worker = new CodexWorker({ manager, adapter: runner }); await worker.start();
  t.after(async () => { await worker.close(); await manager.close(); await native.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, native, manager, worker, calls: () => calls };
}

test('Codex worker durably reserves new jobs, never adopts manual jobs, and installs one immutable image', async t => {
  const { dataDir, native, manager, worker, calls } = await fixture(t, { automaticCodex: false });
  const manual = (await manager.start({ mode: 'generate', prompt: 'Manual request' })).job;
  manager.automaticCodex = true;
  const automatic = (await manager.start({ mode: 'generate', prompt: 'Automatic request', requestId: 'automatic-once' })).job;
  assert.deepEqual(automatic.automation, { state: 'queued' });
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'generation/jobs', `${automatic.id}.json`))).automation.state, 'queued');
  await assert.rejects(manager.handoff(automatic.id), { code: 'JOB_CLAIMED' });
  await assert.rejects(manager.complete({ jobId: automatic.id, data: png }), { code: 'JOB_CLAIMED' });
  await worker.tick(); await worker.tick();
  assert.equal(CODEX_WORKER_POLL_MS, 5000); assert.equal(calls(), 1);
  assert.equal(manager.get(automatic.id).job.status, 'succeeded');
  assert.equal(manager.get(automatic.id).job.automation, undefined);
  assert.equal(manager.get(manual.id).job.status, 'awaiting_image');
  assert.equal((await manager.handoff(manual.id)).request.prompt, 'Manual request');
  assert.equal((await native.execute('list_documents')).documents.length, 1);
  assert.deepEqual((await manager.output(automatic.id)).data, png);
  assert.deepEqual(await fs.readdir(worker.directory), []);
  assert.throws(() => new CodexWorker({ manager, adapter: worker.adapter }), /one Codex worker/);
});

test('Codex worker persists attempt before invocation, is single-flight, and cancellation aborts before installation', async t => {
  let entered, release; const started = new Promise(resolve => { entered = resolve; }); let calls = 0, observedSignal;
  const adapter = { check: async () => ({ available: true }), generate: async ({ handoff, workDir, signal }) => {
    calls++; observedSignal = signal;
    const receipt = JSON.parse(await fs.readFile(path.join(workDir, '../../jobs', `${handoff.job.id}.json`)));
    assert.equal(receipt.automation.state, 'generating'); assert.equal(receipt.automation.attemptId, path.basename(workDir));
    entered(); return new Promise(resolve => { release = resolve; });
  } };
  const { manager, worker, native } = await fixture(t, { adapter });
  const job = (await manager.start({ mode: 'generate', prompt: 'Cancelled attempt' })).job;
  const first = worker.tick(); await started; assert.equal(worker.tick(), first); assert.equal(calls, 1);
  await assert.rejects(manager.handoff(job.id), { code: 'JOB_CLAIMED' });
  await manager.cancel(job.id); assert.equal(observedSignal.aborted, true); release(png); await first;
  assert.equal(manager.get(job.id).job.status, 'cancelled'); assert.equal((await native.execute('list_documents')).documents.length, 0);
  await worker.tick(); assert.equal(calls, 1); assert.deepEqual(await fs.readdir(worker.directory), []);
});

test('Codex worker saved output recovery survives restart without regeneration and pins exact artifact bytes', async t => {
  const { dataDir, manager, native, worker } = await fixture(t);
  const job = (await manager.start({ mode: 'generate', prompt: 'Saved output' })).job;
  const claim = await manager.claimCodexJob();
  const receipt = await manager.recordCodexOutput({ ...claim, data: png });
  assert.deepEqual(await manager.recordCodexOutput({ ...claim, data: Buffer.from(png) }), receipt);
  await assert.rejects(manager.recordCodexOutput({ ...claim, data: different }), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(manager.complete({ ...claim, data: different }), { code: 'IDEMPOTENCY_CONFLICT' });
  await worker.close(); await manager.close();
  const reopened = await new GenerationManager({ dataDir, native, automaticCodex: true, getKey: denied, provider: denied }).init();
  const recovery = new CodexWorker({ manager: reopened, adapter: { check: async () => ({ available: false }), generate: denied } });
  t.after(async () => { await recovery.close(); await reopened.close(); });
  await recovery.start(); await recovery.tick();
  assert.equal(reopened.get(job.id).job.status, 'succeeded'); assert.deepEqual((await reopened.output(job.id)).data, png);
});

test('Codex worker restart does not regenerate an uncertain attempt and unavailable runner preserves its queue', async t => {
  const { dataDir, manager, native, worker } = await fixture(t);
  const uncertain = (await manager.start({ mode: 'generate', prompt: 'Uncertain attempt' })).job;
  await manager.claimCodexJob(); await worker.close(); await manager.close();
  const reopened = await new GenerationManager({ dataDir, native, automaticCodex: true, getKey: denied, provider: denied }).init();
  const unavailable = new CodexWorker({ manager: reopened, adapter: { check: async () => ({ available: false, reason: 'secret-looking untrusted adapter detail' }), generate: denied } });
  t.after(async () => { await unavailable.close(); await reopened.close(); });
  await unavailable.start();
  const queued = (await reopened.start({ mode: 'generate', prompt: 'Wait for sign-in' })).job;
  await unavailable.tick(); await unavailable.tick();
  assert.equal(reopened.get(uncertain.id).job.automation.state, 'interrupted');
  assert.equal(reopened.get(queued.id).job.automation.state, 'queued');
  assert.equal(unavailable.status().state, 'unavailable');
  assert.ok(!JSON.stringify(unavailable.status()).includes('secret-looking'));
  assert.equal((await native.execute('list_documents')).documents.length, 0);
});

test('Codex worker close aborts an already-returning application before native installation', async t => {
  const { manager, worker, native } = await fixture(t);
  const job = (await manager.start({ mode: 'generate', prompt: 'Stop before installation' })).job;
  let entered, release, applicationSignal;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const install = native.installGeneratedImage.bind(native);
  native.installGeneratedImage = async args => { applicationSignal = args.signal; entered(); await gate; return install(args); };
  const tick = worker.tick(); await started;
  const closing = worker.close(); assert.equal(applicationSignal.aborted, true);
  release(); await closing; await tick;
  assert.equal((await native.execute('list_documents')).documents.length, 0);
  assert.equal(manager.get(job.id).job.outputAvailable, true);
  assert.equal(manager.get(job.id).job.status, 'cancelled');
});

test('Companion exposes injected worker status and automatic completion retains stale saved-mask output', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-worker-http-')); let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const app = await createCompanion({ dataDir, port: 0, getImageKey: denied, imageProvider: denied, codexWorkerEnabled: true, codexImageAdapter: {
    check: async () => ({ available: true }), generate: async ({ handoff }) => {
      assert.equal(handoff.request.scope, 'selection');
      const mask = await sharp(await fs.readFile(handoff.assets.mask.path)).ensureAlpha().raw().toBuffer();
      assert.equal(mask[3], 0); assert.equal(mask[7 * 4 + 3], 255);
      entered(); return new Promise(resolve => { release = resolve; });
    },
  } });
  await app.listen(); t.after(async () => { await app.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const status = await fetch(`${base}/api/ai/status`, { headers: { Authorization: `Bearer ${app.token}` } }).then(response => response.json());
  assert.deepEqual(status.codexWorker, { enabled: true, available: true, state: 'ready' });
  let doc = (await app.native.execute('create_document', { width: 8, height: 8, background: '#ffffff' })).document;
  doc = (await app.native.execute('select_rectangle', { documentId: doc.id, expectedRevision: doc.revision, x: 0, y: 0, width: 4, height: 8 })).document;
  const job = (await app.generation.start({ mode: 'edit', prompt: 'Change selected area', documentId: doc.id, expectedRevision: doc.revision, scope: 'selection' })).job;
  const tick = app.codexWorker.tick(); await started;
  doc = (await app.native.execute('clear_selection', { documentId: doc.id, expectedRevision: doc.revision })).document;
  release(png); await tick;
  assert.equal(app.generation.get(job.id).job.status, 'ready');
  assert.equal(app.generation.get(job.id).job.error.code, 'REVISION_CONFLICT');
  const applied = await app.generation.apply({ jobId: job.id, expectedRevision: doc.revision });
  const pixels = await app.native.renderGraph(applied.document);
  assert.deepEqual([...pixels.subarray(0, 4)], [36, 104, 172, 255]);
  assert.deepEqual([...pixels.subarray(7 * 4, 8 * 4)], [255, 255, 255, 255]);
});
