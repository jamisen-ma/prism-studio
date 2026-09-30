import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { generateImage } from './openai-images.mjs';
import { validateGeneration, IMAGE_MODELS } from '../shared/generation.mjs';
import { openBoundedFile, readBoundedHandle } from './bounded-file.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const MAX_JOBS = 100, MAX_PENDING = 6, MAX_ASSET = 32 * 1024 * 1024, MAX_STORAGE = 512 * 1024 * 1024;
const STATUSES = ['awaiting_image', 'queued', 'running', 'ready', 'succeeded', 'failed', 'cancelled'];
const PENDING = ['awaiting_image', 'queued', 'running'];
const AUTOMATION_STATES = ['queued', 'generating', 'returning', 'interrupted', 'failed'];
const AUTOMATION_OWNED = ['queued', 'generating', 'returning'];
const AUTOMATION_INTERRUPTED = 'The local Codex attempt was interrupted. It was not regenerated automatically. Start a new request only after reviewing this attempt.';
const MESSAGES = {
  AI_NOT_CONFIGURED: 'Configure an image-generation API key before starting a job.',
  AI_AUTHENTICATION: 'The image provider rejected the configured API key.',
  AI_QUOTA: 'The image provider reported that this account has no available quota.',
  AI_RATE_LIMIT: 'The image provider rate limit was reached. No automatic retry was made.',
  AI_CONTENT_POLICY: 'The image provider could not fulfill this request under its content rules.',
  AI_MODEL_UNAVAILABLE: 'The requested image model is unavailable for this account.',
  AI_UNAVAILABLE: 'The image provider is temporarily unavailable. No automatic retry was made.',
  AI_NETWORK: 'The image provider could not be reached. No automatic retry was made.',
  AI_CANCELLED: 'Image generation or application was cancelled.',
  AI_TIMEOUT: 'The image provider timed out. No automatic retry was made.',
  AI_RESPONSE_INVALID: 'The image provider returned an invalid image response.',
  AI_LIMIT_EXCEEDED: 'The image provider response exceeds local image limits.',
  AI_REQUEST_REJECTED: 'The image provider rejected the request. Check the selected model and generation options.',
  AI_STORAGE_FULL: 'Local generation storage cannot reserve space for this result. No image provider request was sent.',
  AI_STORAGE_FAILURE: 'Image job data could not be read or saved. Resolve the local storage problem before retrying. API jobs are never retried automatically.',
  REVISION_CONFLICT: 'The document changed while generation was running. The result is retained; review it and apply it explicitly to the current document.',
  SNAPSHOT_DIMENSIONS_CHANGED: 'The canvas dimensions no longer match the saved edit mask. The result is retained; restore the original canvas dimensions before applying it.',
  LIMIT_EXCEEDED: 'A local image, layer, history or storage limit prevented this operation. Any generated result is retained for retry.',
  INVALID_ARGUMENT: 'Image application received invalid arguments.',
  INVALID_ARGUMENTS: 'Image generation received invalid arguments.',
  INVALID_IMAGE: 'The generated image could not be decoded.',
  INVALID_TARGET: 'This operation requires an active Codex image handoff job.',
  IDEMPOTENCY_CONFLICT: 'This job or request already has different immutable image-generation data.',
  NOT_READY: 'This job has no generated result ready to apply.',
  NOT_FOUND: 'The target document was not found. The generated result is retained.',
  INTERRUPTED: 'The application stopped while this job was pending. It was not retried automatically because a provider request may already have been charged.',
  CLOSED: 'The image-generation manager is closed.',
  JOB_CLAIMED: 'This image request is reserved for the automatic local Codex worker.',
  AI_FAILED: 'Image generation failed. No automatic retry was made.',
};
const failure = (code, message = MESSAGES[code] ?? MESSAGES.AI_FAILED) => Object.assign(new Error(message), { code });
function assert(value, code, message) { if (!value) throw failure(code, message); }
function safeError(cause) {
  const code = Object.hasOwn(MESSAGES, cause?.code) ? cause.code : 'AI_FAILED';
  return { code, message: MESSAGES[code] };
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, stable(value[key])]));
  return value;
}
function fingerprintOf(args) {
  const { requestId, ...request } = args;
  return createHash('sha256').update(JSON.stringify(stable(request))).digest('hex');
}
function usageOnly(input, depth = 0) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || depth > 3) return undefined;
  const output = {};
  for (const [key, value] of Object.entries(input).slice(0, 32)) if (/^[a-z_]{1,64}$/.test(key)) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) output[key] = value;
    else { const nested = usageOnly(value, depth + 1); if (nested && Object.keys(nested).length) output[key] = nested; }
  }
  return Object.keys(output).length ? output : undefined;
}
function idOf(input) {
  const id = typeof input === 'string' ? input : input?.jobId;
  assert(typeof id === 'string' && UUID.test(id), 'INVALID_ARGUMENT', 'Invalid generation job identifier.');
  return id;
}
function publicJob(record) {
  const { provider, mode, prompt, model, quality, size, background, scope, fit } = record.request;
  return structuredClone({ id: record.id, provider, mode, prompt, model, quality, size, background, scope, status: record.status, createdAt: record.createdAt, updatedAt: record.updatedAt,
    ...(fit ? { fit } : {}),
    ...(record.error ? { error: record.error } : {}),
    ...(record.documentId ?? record.request.documentId ? { documentId: record.documentId ?? record.request.documentId } : {}),
    ...(record.layerId ? { layerId: record.layerId } : {}), ...(record.revision ? { revision: record.revision } : {}),
    outputAvailable: Boolean(record.outputAsset), ...(record.usage ? { usage: record.usage } : {}),
    ...(record.automation ? { automation: { state: record.automation.state, ...(record.automation.message ? { message: record.automation.message } : {}) } } : {}),
  });
}

export class GenerationManager {
  constructor({ dataDir, native, getKey = async () => null, provider = generateImage, automaticCodex = false }) {
    assert(typeof dataDir === 'string' && native && typeof getKey === 'function' && typeof provider === 'function', 'INVALID_ARGUMENT', 'GenerationManager requires a data directory, native backend, key callback and provider.');
    this.directory = path.join(path.resolve(dataDir), 'generation');
    this.jobsDirectory = path.join(this.directory, 'jobs'); this.assetsDirectory = path.join(this.directory, 'assets');
    this.native = native; this.getKey = getKey; this.provider = provider;
    this.jobs = new Map(); this.bytes = 0; this.closed = false; this.initialized = false;
    this.serial = Promise.resolve(); this.worker = null; this.active = null; this.applications = new Map(); this.closePromise = null;
    this.pendingCancellations = new Map();
    this.halted = false;
    this.automaticCodex = automaticCodex === true;
    this.codexWorker = null;
  }

  async init() {
    await fs.mkdir(this.jobsDirectory, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.assetsDirectory, { recursive: true, mode: 0o700 });
    for (const file of await fs.readdir(this.assetsDirectory)) if (HASH.test(file)) {
      const stat = await fs.stat(path.join(this.assetsDirectory, file));
      assert(stat.isFile() && stat.size <= MAX_ASSET, 'LIMIT_EXCEEDED'); this.bytes += stat.size;
    }
    assert(this.bytes <= MAX_STORAGE, 'LIMIT_EXCEEDED');
    const files = (await fs.readdir(this.jobsDirectory)).filter((file) => file.endsWith('.json') && UUID.test(file.slice(0, -5)));
    assert(files.length <= MAX_JOBS, 'LIMIT_EXCEEDED', 'The maximum of 100 stored generation jobs has been reached.');
    for (const file of files) {
      const stat = await fs.stat(path.join(this.jobsDirectory, file));
      assert(stat.size <= 128 * 1024, 'LIMIT_EXCEEDED', 'A generation job metadata file exceeds its size limit.');
      const record = JSON.parse(await fs.readFile(path.join(this.jobsDirectory, file), 'utf8'));
      assert(record.version === 1 && record.id === file.slice(0, -5) && STATUSES.includes(record.status) && HASH.test(record.fingerprint), 'INVALID_ARGUMENT', 'Invalid persisted generation job.');
      // Existing receipts predate the conversation handoff and always used the
      // explicit API provider. Never reinterpret or rerun those paid requests.
      const legacy = record.request?.provider === undefined;
      record.request = validateGeneration(legacy ? { ...record.request, provider: 'openai' } : record.request);
      if (legacy) record.fingerprint = fingerprintOf(record.request);
      assert(record.status !== 'awaiting_image' || record.request.provider === 'codex', 'INVALID_ARGUMENT', 'Invalid persisted image handoff.');
      assert(record.request.provider !== 'codex' || !['queued', 'running'].includes(record.status), 'INVALID_ARGUMENT', 'Codex handoffs cannot run through the API queue.');
      for (const key of ['inputAsset', 'maskAsset', 'outputAsset']) if (record[key]) assert(HASH.test(record[key]), 'INVALID_ARGUMENT', 'Invalid generation asset reference.');
      if (record.automation !== undefined) {
        const automation = record.automation;
        assert(record.request.provider === 'codex' && automation && typeof automation === 'object' && !Array.isArray(automation) && AUTOMATION_STATES.includes(automation.state), 'INVALID_ARGUMENT', 'Invalid Codex worker receipt.');
        assert(automation.state === 'queued' ? automation.attemptId === undefined : UUID.test(automation.attemptId), 'INVALID_ARGUMENT', 'Invalid Codex worker attempt.');
        assert(automation.outputAsset === undefined || HASH.test(automation.outputAsset), 'INVALID_ARGUMENT', 'Invalid Codex worker output.');
        assert(automation.state !== 'returning' || HASH.test(automation.outputAsset), 'INVALID_ARGUMENT', 'Missing Codex worker output.');
        assert(automation.message === undefined || (typeof automation.message === 'string' && automation.message.length <= 300), 'INVALID_ARGUMENT', 'Invalid Codex worker message.');
      }
      if (record.error) record.error = safeError(record.error);
      record.usage = usageOnly(record.usage);
      this.jobs.set(record.id, record);
      if (record.status === 'awaiting_image' && record.automation?.state === 'generating') await this.writeJob({ ...record, automation: { ...record.automation, state: 'interrupted', message: AUTOMATION_INTERRUPTED }, updatedAt: new Date().toISOString() });
      else if (record.status === 'queued' || record.status === 'running') await this.writeJob({ ...record, status: 'failed', error: safeError({ code: 'INTERRUPTED' }), updatedAt: new Date().toISOString() });
      else if (legacy) await this.writeJob(record);
    }
    this.initialized = true;
    return this;
  }

  locked(operation) {
    const result = this.serial.then(operation); this.serial = result.catch(() => {}); return result;
  }
  available() { assert(this.initialized, 'INVALID_ARGUMENT', 'Initialize the generation manager first.'); assert(!this.closed, 'CLOSED'); }
  record(id) { const job = this.jobs.get(idOf(id)); assert(job, 'NOT_FOUND', 'Generation job was not found.'); return job; }
  list() { return { jobs: [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicJob) }; }
  get(id) { return { job: publicJob(this.record(id)) }; }

  async readKey() {
    let key;
    try { key = await this.getKey(); } catch { throw failure('AI_NOT_CONFIGURED'); }
    assert(typeof key === 'string' && key.trim().length > 0, 'AI_NOT_CONFIGURED');
    return key;
  }

  async writeJob(record) {
    const serialized = JSON.stringify(record);
    assert(Buffer.byteLength(serialized) <= 128 * 1024, 'LIMIT_EXCEEDED', 'Generation job metadata is too large.');
    const file = path.join(this.jobsDirectory, `${record.id}.json`), temporary = path.join(this.jobsDirectory, `.${record.id}-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600); await handle.writeFile(serialized); await handle.sync(); await handle.close(); handle = null;
      await fs.rename(temporary, file);
    } finally { if (handle) await handle.close(); await fs.unlink(temporary).catch(() => {}); }
    this.jobs.set(record.id, record);
    return record;
  }

  reservedBytes(excludeId) {
    return [...this.jobs.values()].filter((job) => job.id !== excludeId && !job.outputAsset && PENDING.includes(job.status)).length * MAX_ASSET;
  }

  async storeAsset(data, { reservationId, extraReserve = 0 } = {}) {
    assert(Buffer.isBuffer(data) && data.length > 0 && data.length <= MAX_ASSET, 'AI_LIMIT_EXCEEDED');
    const hash = createHash('sha256').update(data).digest('hex'), file = path.join(this.assetsDirectory, hash);
    let exists = false;
    try {
      await fs.lstat(file); exists = true;
    } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    if (exists) { await this.readAsset(hash); return hash; }
    assert(this.bytes + data.length + this.reservedBytes(reservationId) + extraReserve <= MAX_STORAGE, 'AI_STORAGE_FULL');
    const temporary = path.join(this.assetsDirectory, `.${hash}-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600); await handle.writeFile(data); await handle.sync(); await handle.close(); handle = null;
      await fs.rename(temporary, file); this.bytes += data.length;
    } finally { if (handle) await handle.close(); await fs.unlink(temporary).catch(() => {}); }
    return hash;
  }
  async readAsset(hash) {
    assert(HASH.test(hash), 'INVALID_IMAGE');
    const opened = await openBoundedFile(path.join(this.assetsDirectory, hash), { maxBytes: MAX_ASSET, code: 'AI_STORAGE_FAILURE', message: MESSAGES.AI_STORAGE_FAILURE });
    try { return (await readBoundedHandle(opened.handle, { bytes: opened.bytes, expectedHash: hash, code: 'AI_STORAGE_FAILURE', message: MESSAGES.AI_STORAGE_FAILURE })).data; }
    finally { await opened.handle.close(); }
  }

  async start(input) {
    const args = validateGeneration(input), { requestId } = args;
    const fingerprint = fingerprintOf(args);
    return this.locked(async () => {
      this.available();
      if (requestId) {
        const existing = [...this.jobs.values()].find((job) => job.request.requestId === requestId);
        if (existing) {
          assert(existing.fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT', 'This requestId was already used for different generation arguments.');
          return { job: publicJob(existing) };
        }
      }
      assert(this.jobs.size < MAX_JOBS, 'LIMIT_EXCEEDED', 'The maximum of 100 stored generation jobs has been reached.');
      assert([...this.jobs.values()].filter((job) => PENDING.includes(job.status)).length < MAX_PENDING, 'QUEUE_FULL', 'The generation queue is full. Finish or cancel a pending image job.');
      assert(this.bytes + this.reservedBytes() + MAX_ASSET <= MAX_STORAGE, 'AI_STORAGE_FULL');
      if (args.provider === 'openai') await this.readKey(); // Conversation handoffs never read credentials.
      const snapshot = args.documentId ? await this.native.snapshotForGeneration(args) : null;
      this.available();
      const now = new Date().toISOString();
      const job = { version: 1, id: randomUUID(), request: args, fingerprint, status: args.provider === 'codex' ? 'awaiting_image' : 'queued', createdAt: now, updatedAt: now };
      if (args.provider === 'codex' && this.automaticCodex) job.automation = { state: 'queued' };
      if (snapshot) {
        job.snapshot = { documentId: snapshot.documentId, revision: snapshot.revision, width: snapshot.width, height: snapshot.height };
        if (args.mode === 'edit') job.inputAsset = await this.storeAsset(snapshot.image, { extraReserve: MAX_ASSET });
        if (args.mode === 'edit' && snapshot.mask) job.maskAsset = await this.storeAsset(snapshot.mask, { extraReserve: MAX_ASSET });
      }
      assert(this.bytes + this.reservedBytes() + MAX_ASSET <= MAX_STORAGE, 'AI_STORAGE_FULL');
      await this.writeJob(job);
      if (args.provider === 'openai') this.kick(true);
      return { job: publicJob(job) };
    });
  }

  assertCodexOwnership(record, attemptId) {
    if (attemptId !== undefined) assert(UUID.test(attemptId) && record.automation?.attemptId === attemptId && ['generating', 'returning'].includes(record.automation.state), 'INVALID_TARGET', 'This local Codex attempt no longer owns the request.');
    else assert(!AUTOMATION_OWNED.includes(record.automation?.state), 'JOB_CLAIMED');
  }

  claimCodexJob() {
    return this.locked(async () => {
      this.available();
      const record = [...this.jobs.values()].filter(job => job.status === 'awaiting_image' && job.automation?.state === 'queued' && !this.pendingCancellations.has(job.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (!record) return null;
      const attemptId = randomUUID();
      await this.writeJob({ ...record, automation: { state: 'generating', attemptId }, updatedAt: new Date().toISOString() });
      return { jobId: record.id, attemptId };
    });
  }

  returningCodexJob() {
    const record = [...this.jobs.values()].find(job => job.status === 'awaiting_image' && job.automation?.state === 'returning' && !this.pendingCancellations.has(job.id));
    return record ? { jobId: record.id, attemptId: record.automation.attemptId, outputAsset: record.automation.outputAsset } : null;
  }

  recordCodexOutput({ jobId, attemptId, data }) {
    const image = Buffer.isBuffer(data) && data.length > 0 && data.length <= 30 * 1024 * 1024 ? Buffer.from(data) : null;
    return this.locked(async () => {
      this.available();
      const record = this.record(jobId); this.assertCodexOwnership(record, attemptId);
      assert(record.status === 'awaiting_image' && !this.pendingCancellations.has(record.id), 'AI_CANCELLED');
      assert(image, 'AI_LIMIT_EXCEEDED');
      if (record.automation.state === 'returning') {
        assert(createHash('sha256').update(image).digest('hex') === record.automation.outputAsset, 'IDEMPOTENCY_CONFLICT');
        return { jobId: record.id, attemptId, outputAsset: record.automation.outputAsset };
      }
      try {
        const decoded = sharp(image, { limitInputPixels: 24_000_000, failOn: 'warning' }), metadata = await decoded.metadata();
        assert(metadata.format === 'png' && metadata.width > 0 && metadata.height > 0 && metadata.width <= 8192 && metadata.height <= 8192 && metadata.width * metadata.height <= 24_000_000 && (metadata.pages ?? 1) === 1, 'AI_RESPONSE_INVALID');
        await decoded.raw().toBuffer();
      } catch { throw failure('AI_RESPONSE_INVALID'); }
      assert(!this.pendingCancellations.has(record.id), 'AI_CANCELLED');
      const outputAsset = await this.storeAsset(image, { reservationId: record.id });
      assert(!this.pendingCancellations.has(record.id), 'AI_CANCELLED');
      await this.writeJob({ ...record, automation: { state: 'returning', attemptId, outputAsset }, updatedAt: new Date().toISOString() });
      return { jobId: record.id, attemptId, outputAsset };
    });
  }

  interruptCodexAttempt({ jobId, attemptId, failed = false }) {
    return this.locked(async () => {
      this.available();
      const record = this.record(jobId);
      if (record.status !== 'awaiting_image' || record.automation?.attemptId !== attemptId || record.automation.state !== 'generating') return;
      await this.writeJob({ ...record, automation: { state: failed ? 'failed' : 'interrupted', attemptId, message: failed ? 'The local Codex attempt could not return a valid image. It was not regenerated automatically.' : AUTOMATION_INTERRUPTED }, updatedAt: new Date().toISOString() });
    });
  }

  abortCodexApplication(jobId) { this.applications.get(jobId)?.abort(); }

  handoff(input, { attemptId } = {}) {
    const id = idOf(input);
    return this.locked(async () => {
      this.available();
      const record = this.record(id);
      assert(record.request.provider === 'codex' && ['awaiting_image', 'ready', 'succeeded'].includes(record.status), 'INVALID_TARGET', 'Handoff requires an active Codex conversation image job; cancelled, failed and API jobs are unsupported.');
      this.assertCodexOwnership(record, attemptId);
      const { requestId, documentId, expectedRevision, ...request } = record.request;
      try {
        return { job: publicJob(record), request: structuredClone(request), ...(record.snapshot ? { snapshot: structuredClone(record.snapshot) } : {}),
          ...(record.inputAsset ? { image: await this.readAsset(record.inputAsset) } : {}),
          ...(record.maskAsset ? { mask: await this.readAsset(record.maskAsset) } : {}), mimeType: 'image/png' };
      } catch { throw failure('AI_STORAGE_FAILURE'); }
    });
  }

  complete({ jobId, data, attemptId } = {}) {
    const id = idOf(jobId);
    const image = Buffer.isBuffer(data) && data.length <= MAX_ASSET ? Buffer.from(data) : null;
    return this.locked(async () => {
      this.available();
      const record = this.record(id);
      assert(record.request.provider === 'codex' && ['awaiting_image', 'ready', 'succeeded'].includes(record.status), 'INVALID_TARGET', 'Complete only an active Codex conversation image job. Cancelled, failed and API jobs cannot accept an image handoff.');
      if (!record.outputAsset) this.assertCodexOwnership(record, attemptId);
      assert(!this.pendingCancellations.has(id), 'AI_CANCELLED');
      assert(image && image.length > 0, 'AI_LIMIT_EXCEEDED');
      // Bytes were copied at method entry, before waiting for the serial queue.
      const hash = createHash('sha256').update(image).digest('hex');
      if (record.automation?.state === 'returning') assert(record.automation.outputAsset === hash, 'IDEMPOTENCY_CONFLICT');
      if (record.outputAsset) {
        assert(record.outputAsset === hash, 'IDEMPOTENCY_CONFLICT', 'This Codex job already has a different immutable image result. Start a new job for a different image.');
        return { job: publicJob(record) }; // Replays never reapply a ready result.
      }
      assert(record.status === 'awaiting_image', 'NOT_READY');
      const controller = new AbortController(); this.applications.set(id, controller);
      try {
        let metadata;
        try {
          const decoded = sharp(image, { limitInputPixels: 24_000_000, failOn: 'warning' });
          metadata = await decoded.metadata();
          assert(metadata.format === 'png' && Number.isInteger(metadata.width) && Number.isInteger(metadata.height) && metadata.width > 0 && metadata.height > 0 && metadata.width <= 8192 && metadata.height <= 8192 && metadata.width * metadata.height <= 24_000_000 && (metadata.pages ?? 1) === 1, 'AI_RESPONSE_INVALID');
          // Metadata alone accepts truncated PNG streams. Decode fully before
          // publishing an immutable output asset or changing the job receipt.
          await decoded.raw().toBuffer();
        } catch { throw failure('AI_RESPONSE_INVALID'); }
        this.available(); assert(!controller.signal.aborted, 'AI_CANCELLED');
        let ready;
        try {
          const outputAsset = await this.storeAsset(image, { reservationId: id });
          ready = await this.writeJob({ ...record, automation: undefined, outputAsset, outputMimeType: 'image/png', providerMetadata: { provider: 'codex', model: record.request.model }, status: 'ready', updatedAt: new Date().toISOString(), error: undefined });
        } catch (cause) { throw failure(Object.hasOwn(MESSAGES, cause?.code) ? cause.code : 'AI_STORAGE_FAILURE'); }
        if (this.closed || controller.signal.aborted) return { job: publicJob(ready) };
        return await this.applyLocked(ready, ready.snapshot?.revision, true, controller);
      } finally { if (this.applications.get(id) === controller) this.applications.delete(id); }
    });
  }

  kick(resume = false) {
    if (resume) this.halted = false;
    if (this.worker || this.closed || this.halted) return;
    this.worker = Promise.resolve().then(() => this.drain()).catch(async () => {
      this.halted = true;
      const interruptedId = this.active?.id; this.active = null;
      await this.locked(async () => {
        const interrupted = interruptedId ? this.jobs.get(interruptedId) : [...this.jobs.values()].find((job) => job.status === 'queued');
        if (!interrupted || !['queued', 'running'].includes(interrupted.status)) return;
        const failed = { ...interrupted, status: 'failed', error: safeError({ code: 'AI_STORAGE_FAILURE' }), updatedAt: new Date().toISOString() };
        try { await this.writeJob(failed); } catch { this.jobs.set(failed.id, failed); }
      });
    }).finally(() => {
      this.worker = null;
      if (!this.closed && !this.halted && [...this.jobs.values()].some((job) => job.status === 'queued')) this.kick();
    });
    // A disk error must not become an unhandled rejection in the UI process.
    this.worker.catch(() => {});
  }

  async drain() {
    while (!this.closed) {
      const job = await this.locked(async () => {
        if (this.closed) return null;
        const next = [...this.jobs.values()].find((item) => item.status === 'queued' && !this.pendingCancellations.has(item.id));
        if (!next) return null;
        this.active = { id: next.id, controller: new AbortController() };
        return this.writeJob({ ...next, status: 'running', updatedAt: new Date().toISOString(), error: undefined });
      });
      if (!job) return;
      const controller = this.active.controller;
      try {
        await this.locked(() => assert(this.bytes + this.reservedBytes() <= MAX_STORAGE, 'AI_STORAGE_FULL'));
        const apiKey = await this.readKey();
        assert(!controller.signal.aborted && !this.closed, 'AI_CANCELLED');
        const image = job.inputAsset ? await this.readAsset(job.inputAsset) : undefined;
        const mask = job.request.mode === 'edit' && job.maskAsset ? await this.readAsset(job.maskAsset) : undefined;
        assert(!controller.signal.aborted && !this.closed, 'AI_CANCELLED');
        // Wait for this provider call to settle even after cancellation so a
        // second request can never overlap an in-flight first request. The
        // provider owns the network deadline and honors this abort signal.
        const response = await this.provider({ apiKey, prompt: job.request.prompt, model: job.request.model, size: job.request.size, quality: job.request.quality, background: job.request.background, image, mask, signal: controller.signal });
        await this.locked(async () => {
          const current = this.record(job.id);
          if (current.status !== 'running' || this.closed || controller.signal.aborted) return;
          assert(response && Buffer.isBuffer(response.data) && response.data.length <= MAX_ASSET, 'AI_RESPONSE_INVALID');
          let metadata;
          try { metadata = await sharp(response.data, { limitInputPixels: 24_000_000, failOn: 'warning' }).metadata(); }
          catch { throw failure('AI_RESPONSE_INVALID'); }
          assert(metadata.format === 'png' && metadata.width <= 8192 && metadata.height <= 8192 && (metadata.pages ?? 1) === 1, 'AI_RESPONSE_INVALID');
          const outputAsset = await this.storeAsset(response.data, { reservationId: job.id });
          const providerMetadata = {};
          if (IMAGE_MODELS.some((model) => model.id === response.model)) providerMetadata.model = response.model;
          if (typeof response.requestId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(response.requestId) && !response.requestId.includes(apiKey)) providerMetadata.requestId = response.requestId;
          if (typeof response.revisedPrompt === 'string' && response.revisedPrompt.length <= 16000 && !response.revisedPrompt.includes(apiKey)) providerMetadata.revisedPrompt = response.revisedPrompt;
          const ready = await this.writeJob({ ...current, outputAsset, outputMimeType: 'image/png', providerMetadata, usage: usageOnly(response.usage), status: this.closed || controller.signal.aborted ? 'cancelled' : 'ready', updatedAt: new Date().toISOString(), error: undefined });
          if (!this.closed && !controller.signal.aborted && ready.status === 'ready') await this.applyLocked(ready, ready.snapshot?.revision, true);
        });
      } catch (cause) {
        await this.locked(async () => {
          const current = this.record(job.id);
          if (current.status === 'succeeded' || current.status === 'cancelled') return;
          const cancelled = this.closed || controller.signal.aborted || cause?.code === 'AI_CANCELLED';
          await this.writeJob({ ...current, status: cancelled ? 'cancelled' : current.outputAsset ? 'ready' : 'failed', error: safeError(cancelled ? { code: 'AI_CANCELLED' } : cause), updatedAt: new Date().toISOString() });
        }).catch(() => {});
      } finally { if (this.active?.id === job.id) this.active = null; }
    }
  }

  async applyLocked(record, expectedRevision, automatic = false, controller = new AbortController()) {
    if (record.status === 'succeeded') return { job: publicJob(record) };
    assert(!this.pendingCancellations.has(record.id), 'AI_CANCELLED');
    assert(record.outputAsset && ['ready', 'cancelled'].includes(record.status), 'NOT_READY', 'This job has no generated result ready to apply.');
    this.available();
    this.applications.set(record.id, controller);
    try {
      const result = await this.native.installGeneratedImage({ data: await this.readAsset(record.outputAsset), name: record.request.name,
        documentId: record.request.documentId, expectedRevision, mask: record.request.mode === 'edit' && record.maskAsset ? await this.readAsset(record.maskAsset) : undefined,
        provenance: { jobId: record.id, mode: record.request.mode, model: record.request.model, quality: record.request.quality, size: record.request.size, scope: record.request.scope, fit: record.request.fit, createdAt: record.createdAt }, signal: controller.signal });
      const succeeded = await this.writeJob({ ...record, status: 'succeeded', documentId: result.document.id, layerId: result.layerId, revision: result.document.revision, error: undefined, updatedAt: new Date().toISOString() });
      return { job: publicJob(succeeded), document: result.document };
    } catch (cause) {
      const sanitized = safeError(cause);
      const retained = await this.writeJob({ ...record, status: this.closed || controller.signal.aborted ? 'cancelled' : 'ready', error: sanitized, updatedAt: new Date().toISOString() });
      if (!automatic) throw failure(sanitized.code, sanitized.message);
      return { job: publicJob(retained) };
    } finally { this.applications.delete(record.id); }
  }

  apply({ jobId, expectedRevision } = {}) {
    idOf(jobId);
    if (expectedRevision !== undefined) assert(Number.isSafeInteger(expectedRevision) && expectedRevision >= 1, 'INVALID_ARGUMENT', 'expectedRevision must be a positive integer.');
    return this.locked(() => {
      this.available();
      const job = this.record(jobId);
      if (job.request.documentId && job.status !== 'succeeded') assert(expectedRevision !== undefined, 'INVALID_ARGUMENT', 'Review the current document and supply its expectedRevision before applying this result.');
      return this.applyLocked(job, expectedRevision);
    });
  }

  cancel(input) {
    const id = idOf(input);
    const marked = ['awaiting_image', 'queued', 'running', 'ready'].includes(this.jobs.get(id)?.status);
    if (marked) this.pendingCancellations.set(id, (this.pendingCancellations.get(id) ?? 0) + 1);
    if (this.active?.id === id) this.active.controller.abort();
    this.codexWorker?.cancel(id);
    this.applications.get(id)?.abort();
    return this.locked(async () => {
      try {
        this.available();
        const job = this.record(id);
        if (!['awaiting_image', 'queued', 'running', 'ready'].includes(job.status)) return { job: publicJob(job) };
        const cancelled = await this.writeJob({ ...job, status: 'cancelled', error: safeError({ code: 'AI_CANCELLED' }), updatedAt: new Date().toISOString() });
        return { job: publicJob(cancelled) };
      } finally {
        if (marked) {
          const remaining = (this.pendingCancellations.get(id) ?? 1) - 1;
          if (remaining > 0) this.pendingCancellations.set(id, remaining);
          else this.pendingCancellations.delete(id);
        }
      }
    });
  }

  async output(input) {
    const job = this.record(input);
    assert(job.outputAsset, 'NOT_READY', 'This job has no generated output yet.');
    return { data: await this.readAsset(job.outputAsset), mimeType: job.outputMimeType ?? 'image/png' };
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.active?.controller.abort();
    for (const controller of this.applications.values()) controller.abort();
    this.closePromise = (async () => {
      await this.locked(async () => {
        for (const job of this.jobs.values()) if (job.status === 'queued' || job.status === 'running') await this.writeJob({ ...job, status: 'cancelled', error: safeError({ code: 'AI_CANCELLED' }), updatedAt: new Date().toISOString() });
      });
      await this.worker?.catch(() => {});
      await this.serial;
    })();
    return this.closePromise;
  }
}
