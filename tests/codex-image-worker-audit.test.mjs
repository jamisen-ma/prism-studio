import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { GenerationManager } from '../server/generation.mjs';
import { CodexWorker, CODEX_WORKER_POLL_MS } from '../server/codex-worker.mjs';

const blue = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#0000ff' } }).png().toBuffer();
const green = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#00ff00' } }).png().toBuffer();
const hash = data => createHash('sha256').update(data).digest('hex');
const coded = code => cause => cause.code === code;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const edit = async (native, doc, command, args = {}) => (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document;
const pixel = (pixels, x, y) => [...pixels.subarray((y * 8 + x) * 4, (y * 8 + x) * 4 + 4)];

async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-codex-worker-audit-'));
  const native = await new NativeBackend({ dataDir }).init();
  const calls = { keys: 0, api: 0 };
  const managers = [], workers = [];
  const getKey = async () => { calls.keys++; throw Error('No credential access is authorized.'); };
  const provider = async () => { calls.api++; throw Error('No API call is authorized.'); };
  async function open(extra = {}) {
    const manager = await new GenerationManager({ dataDir, native, getKey, provider, automaticCodex: true, ...options, ...extra }).init();
    managers.push(manager); return manager;
  }
  async function worker(manager, adapter) {
    const value = new CodexWorker({ manager, adapter }); workers.push(value); await value.start(); return value;
  }
  t.after(async () => {
    for (const item of workers) await item.close();
    for (const item of managers) await item.close();
    assert.deepEqual(calls, { keys: 0, api: 0 });
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, native, manager: await open(), open, worker, calls,
    receipt: async id => JSON.parse(await fs.readFile(path.join(dataDir, 'generation', 'jobs', `${id}.json`), 'utf8')) };
}

test('automatic ownership is durable before generation; overlapping ticks and manual handoffs cannot duplicate it', { timeout: 10000 }, async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(); let generations = 0;
  const { job } = await f.manager.start({ mode: 'generate', prompt: 'Authored blue fixture', requestId: 'worker-owned' });
  assert.equal((await f.receipt(job.id)).automation.state, 'queued');
  for (const action of [() => f.manager.handoff(job.id), () => f.manager.complete({ jobId: job.id, data: blue })]) await assert.rejects(action(), coded('JOB_CLAIMED'));
  const worker = await f.worker(f.manager, { check: async () => ({ available: true }), generate: async ({ handoff, workDir, signal }) => {
    generations++;
    const receipt = await f.receipt(job.id);
    assert.equal(receipt.automation.state, 'generating');
    assert.match(receipt.automation.attemptId, /^[0-9a-f-]{36}$/);
    assert.equal(path.basename(workDir), receipt.automation.attemptId);
    assert.equal(handoff.job.id, job.id); assert.equal(signal.aborted, false);
    entered.resolve(); await release.promise; return blue;
  } });
  assert.equal(CODEX_WORKER_POLL_MS, 5000);
  const first = worker.tick(); await entered.promise;
  const second = worker.tick(); assert.equal(first, second);
  assert.equal(worker.status().activeJobId, job.id);
  await assert.rejects(f.manager.handoff(job.id), coded('JOB_CLAIMED'));
  await assert.rejects(f.manager.complete({ jobId: job.id, data: green }), coded('JOB_CLAIMED'));
  release.resolve(); await first; await worker.tick();
  assert.equal(generations, 1); assert.equal(f.manager.get(job.id).job.status, 'succeeded');
  assert.equal((await f.native.execute('list_documents')).documents.length, 1);
  assert.equal(hash((await f.manager.output(job.id)).data), hash(blue));
  const receipt = await f.receipt(job.id);
  assert.equal(receipt.outputAsset, hash(blue)); assert.equal(receipt.automation, undefined);
  assert.deepEqual(await fs.readdir(worker.directory), []);
});

test('claim persistence failure prevents generation; legacy manual jobs are never adopted', async t => {
  const f = await fixture(t, { automaticCodex: false }); let generations = 0;
  const legacy = (await f.manager.start({ mode: 'generate', prompt: 'Manual legacy fixture' })).job;
  f.manager.automaticCodex = true;
  const auto = (await f.manager.start({ mode: 'generate', prompt: 'Claim must persist' })).job;
  const write = f.manager.writeJob.bind(f.manager);
  f.manager.writeJob = async record => { if (record.automation?.state === 'generating') throw Object.assign(Error('private-token-must-not-leak'), { code: 'EIO' }); return write(record); };
  const worker = await f.worker(f.manager, { check: async () => ({ available: true }), generate: async () => { generations++; return blue; } });
  await worker.tick(); assert.equal(generations, 0); assert.equal((await f.receipt(auto.id)).automation.state, 'queued');
  assert.equal(JSON.stringify(worker.status()).includes('private-token'), false);
  f.manager.writeJob = write;
  await f.manager.cancel(auto.id); await worker.tick(); assert.equal(generations, 0);
  assert.equal((await f.manager.handoff(legacy.id)).request.prompt, 'Manual legacy fixture');
  assert.equal((await f.manager.complete({ jobId: legacy.id, data: blue })).job.status, 'succeeded');
});

test('restart interrupts a claimed attempt and does not regenerate an uncertain image', async t => {
  const f = await fixture(t); let generations = 0;
  const { job } = await f.manager.start({ mode: 'generate', prompt: 'Interrupted fixture' });
  const claim = await f.manager.claimCodexJob(); assert.equal(claim.jobId, job.id);
  await f.manager.close(); const reopened = await f.open();
  assert.equal(reopened.get(job.id).job.automation.state, 'interrupted');
  assert.equal((await f.receipt(job.id)).automation.state, 'interrupted');
  const worker = await f.worker(reopened, { check: async () => ({ available: true }), generate: async () => { generations++; return blue; } });
  await worker.tick(); await worker.tick(); assert.equal(generations, 0);
  assert.equal((await f.native.execute('list_documents')).documents.length, 0);
  // Explicit manual recovery remains possible; no automatic ownership survives.
  assert.equal((await reopened.handoff(job.id)).job.id, job.id);
});

test('returning receipt is immutable and recovers the exact saved PNG without another generation', async t => {
  const f = await fixture(t); let generations = 0;
  const { job } = await f.manager.start({ mode: 'generate', prompt: 'Saved output fixture' });
  const claim = await f.manager.claimCodexJob();
  const saved = await f.manager.recordCodexOutput({ ...claim, data: blue });
  assert.equal(saved.outputAsset, hash(blue));
  assert.deepEqual(await f.manager.recordCodexOutput({ ...claim, data: Buffer.from(blue) }), saved);
  await assert.rejects(f.manager.recordCodexOutput({ ...claim, data: green }), coded('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(f.manager.complete({ ...claim, data: green }), coded('IDEMPOTENCY_CONFLICT'));
  await f.manager.close(); const reopened = await f.open();
  const worker = await f.worker(reopened, { check: async () => ({ available: false, reason: 'private-key' }), generate: async () => { generations++; return green; } });
  await worker.tick(); assert.equal(generations, 0); assert.equal(reopened.get(job.id).job.status, 'succeeded');
  const doc = (await f.native.execute('list_documents')).documents[0];
  const full = (await f.native.execute('get_document', { documentId: doc.id })).document;
  assert.deepEqual(await fs.readFile(path.join(f.dataDir, 'assets', full.layers[0].sourceAsset)), blue);
  assert.equal(JSON.stringify(worker.status()).includes('private-key'), false);
});

test('returning tamper or symlink never installs a different valid PNG and never regenerates', async t => {
  const f = await fixture(t); let generations = 0;
  const { job } = await f.manager.start({ mode: 'generate', prompt: 'Tamper fixture' });
  const claim = await f.manager.claimCodexJob(); const saved = await f.manager.recordCodexOutput({ ...claim, data: blue });
  const file = path.join(f.manager.assetsDirectory, saved.outputAsset);
  await fs.writeFile(file, green);
  const worker = await f.worker(f.manager, { check: async () => ({ available: true }), generate: async () => { generations++; return blue; } });
  await worker.tick(); assert.equal(f.manager.get(job.id).job.automation.state, 'returning');
  assert.equal((await f.native.execute('list_documents')).documents.length, 0);
  await fs.rm(file); const external = path.join(f.dataDir, 'external.png'); await fs.writeFile(external, blue); await fs.symlink(external, file);
  await worker.tick(); assert.equal((await f.native.execute('list_documents')).documents.length, 0);
  assert.equal(generations, 0);
  await fs.rm(file); await fs.writeFile(file, blue); await worker.tick();
  assert.equal(f.manager.get(job.id).job.status, 'succeeded'); assert.equal(generations, 0);
});

test('cancel and shutdown abort the adapter; late output cannot publish or requeue', { timeout: 10000 }, async t => {
  for (const action of ['cancel', 'close']) {
    const f = await fixture(t), entered = deferred(), aborted = deferred(); let calls = 0;
    const { job } = await f.manager.start({ mode: 'generate', prompt: `Abort ${action}` });
    const worker = await f.worker(f.manager, { check: async () => ({ available: true }), generate: async ({ signal }) => {
      calls++; entered.resolve(); signal.addEventListener('abort', () => aborted.resolve(), { once: true });
      await aborted.promise; return blue; // Deliberately returns after cancellation.
    } });
    const tick = worker.tick(); await entered.promise;
    if (action === 'cancel') await f.manager.cancel(job.id); else await worker.close();
    await tick; assert.equal(calls, 1); assert.equal((await f.native.execute('list_documents')).documents.length, 0);
    assert.equal(f.manager.get(job.id).job.status, action === 'cancel' ? 'cancelled' : 'awaiting_image');
    if (action === 'close') assert.equal(f.manager.get(job.id).job.automation.state, 'interrupted');
    assert.deepEqual(await fs.readdir(f.manager.assetsDirectory), []);
    assert.deepEqual(await fs.readdir(worker.directory), []);
  }
});

test('worker stale completion retains exact output and captured hard mask for explicit protected application', { timeout: 10000 }, async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(); let generations = 0;
  let doc = (await f.native.execute('create_document', { width: 8, height: 8, background: '#804020' })).document;
  doc = await edit(f.native, doc, 'select_rectangle', { x: 0, y: 0, width: 4, height: 8 });
  const original = await f.native.renderGraph(doc);
  const { job } = await f.manager.start({ mode: 'edit', prompt: 'Change only captured selection', documentId: doc.id, expectedRevision: doc.revision, scope: 'selection' });
  const worker = await f.worker(f.manager, { check: async () => ({ available: true }), generate: async ({ handoff }) => {
    generations++;
    assert.deepEqual(await sharp(await fs.readFile(handoff.assets.input.path)).ensureAlpha().raw().toBuffer(), original);
    const mask = await sharp(await fs.readFile(handoff.assets.mask.path)).ensureAlpha().raw().toBuffer();
    assert.equal(pixel(mask, 1, 2)[3], 0); assert.equal(pixel(mask, 6, 2)[3], 255);
    entered.resolve(); await release.promise; return blue;
  } });
  const ticking = worker.tick(); await entered.promise;
  doc = await edit(f.native, doc, 'add_shape', { shape: 'rectangle', x: 2, y: 2, width: 1, height: 1, fill: '#00ff00' });
  doc = await edit(f.native, doc, 'set_layer_protection', { layerId: doc.layers.at(-1).id, protected: true });
  const before = await f.native.renderGraph(doc), revision = doc.revision;
  release.resolve(); await ticking;
  assert.equal(f.manager.get(job.id).job.status, 'ready'); assert.equal(f.manager.get(job.id).job.error.code, 'REVISION_CONFLICT');
  await worker.tick(); assert.equal(generations, 1);
  assert.equal((await f.native.execute('get_document', { documentId: doc.id })).document.revision, revision);
  const applied = await f.manager.apply({ jobId: job.id, expectedRevision: revision });
  const result = await f.native.renderGraph(applied.document);
  assert.deepEqual(pixel(result, 1, 1), [0, 0, 255, 255]); assert.deepEqual(pixel(result, 2, 2), [0, 255, 0, 255]);
  for (let y = 0; y < 8; y++) for (let x = 4; x < 8; x++) assert.deepEqual(pixel(result, x, y), pixel(original, x, y));
  assert.deepEqual(await f.native.renderGraph(await edit(f.native, applied.document, 'undo')), before);
});

test('invalid output and private adapter failures stop once without leaking provider details', async t => {
  const f = await fixture(t); let calls = 0, result = blue.subarray(0, Math.floor(blue.length / 2));
  const worker = await f.worker(f.manager, { check: async () => ({ available: true }), generate: async () => { calls++; if (result) return result; throw Error('secret-api-key and private subprocess stderr'); } });
  for (const output of [result, await sharp(blue).jpeg().toBuffer(), null]) {
    result = output;
    const { job } = await f.manager.start({ mode: 'generate', prompt: 'Invalid output fixture' });
    const before = calls; await worker.tick(); await worker.tick();
    assert.equal(calls, before + 1); assert.equal(f.manager.get(job.id).job.automation.state, 'failed');
    assert.equal(JSON.stringify(f.manager.get(job.id)).includes('secret-api-key'), false);
    assert.equal(JSON.stringify(worker.status()).includes('private subprocess'), false);
    await f.manager.cancel(job.id);
  }
  assert.equal((await f.native.execute('list_documents')).documents.length, 0);
  assert.deepEqual(await fs.readdir(f.manager.assetsDirectory), []);
});

test('saved input and mask reads reject changed bytes, links and oversize before invoking the adapter', async t => {
  for (const mutation of ['different-valid-png', 'symlink', 'oversize']) {
    const f = await fixture(t); let calls = 0;
    let doc = (await f.native.execute('create_document', { width: 8, height: 8, background: '#804020' })).document;
    doc = await edit(f.native, doc, 'select_rectangle', { x: 0, y: 0, width: 4, height: 8 });
    const { job } = await f.manager.start({ mode: 'edit', prompt: 'Saved reference integrity', documentId: doc.id, expectedRevision: doc.revision, scope: 'selection' });
    const receipt = await f.receipt(job.id), file = path.join(f.manager.assetsDirectory, receipt.maskAsset);
    if (mutation === 'different-valid-png') await fs.writeFile(file, green);
    if (mutation === 'symlink') { await fs.rm(file); const external = path.join(f.dataDir, 'external.png'); await fs.writeFile(external, blue); await fs.symlink(external, file); }
    if (mutation === 'oversize') await fs.truncate(file, 32 * 1024 * 1024 + 1);
    const worker = await f.worker(f.manager, { check: async () => ({ available: true }), generate: async () => { calls++; return blue; } });
    await worker.tick(); assert.equal(calls, 0); assert.equal(f.manager.get(job.id).job.automation.state, 'failed');
    assert.equal((await f.native.execute('get_document', { documentId: doc.id })).document.revision, doc.revision);
  }
});

test('shutdown during saved-output read or native installation cannot apply after the cancellation boundary', { timeout: 10000 }, async t => {
  for (const phase of ['returning-read', 'native-application']) {
    const f = await fixture(t), entered = deferred(), release = deferred(); let applications = 0;
    const { job } = await f.manager.start({ mode: 'generate', prompt: `Shutdown during ${phase}` });
    const worker = await f.worker(f.manager, { check: async () => ({ available: true }), generate: async () => blue });
    const install = f.native.installGeneratedImage.bind(f.native);
    f.native.installGeneratedImage = async args => {
      applications++;
      if (phase === 'native-application') { entered.resolve(); await release.promise; assert.equal(args.signal.aborted, true); }
      return install(args);
    };
    if (phase === 'returning-read') {
      const read = worker.returningBytes.bind(worker);
      worker.returningBytes = async args => { entered.resolve(); await release.promise; return read(args); };
    }
    const running = worker.tick(); await entered.promise;
    const closing = worker.close(); release.resolve(); await closing; await running;
    assert.equal((await f.native.execute('list_documents')).documents.length, 0);
    assert.equal(applications, phase === 'returning-read' ? 0 : 1);
    const receipt = await f.receipt(job.id);
    assert.equal(receipt.automation?.outputAsset ?? receipt.outputAsset, hash(blue), 'The accepted PNG is retained without regenerating.');
    if (phase === 'returning-read') assert.equal(receipt.automation.state, 'returning');
    else assert.equal(receipt.status, 'cancelled');
  }
});
