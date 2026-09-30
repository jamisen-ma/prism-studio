import fs from 'node:fs/promises';
import path from 'node:path';
import { openBoundedFile, readBoundedHandle } from './bounded-file.mjs';

export const CODEX_WORKER_POLL_MS = 5000;
const MAX_REFERENCE_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 30 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const unavailableMessage = 'The local Codex image runner is unavailable. Check its installation and sign-in. Queued requests have not been generated.';

/** One serial controller per manager. No keys, prompts or subprocess output
 * enter public status. The adapter owns only generation, never installation. */
export class CodexWorker {
  constructor({ manager, adapter, directory = path.join(manager.directory, 'codex-worker') }) {
    if (manager.codexWorker || !adapter || typeof adapter.check !== 'function' || typeof adapter.generate !== 'function') throw new TypeError('A generation manager accepts one Codex worker with a check/generate adapter.');
    this.manager = manager; this.adapter = adapter; this.directory = path.resolve(directory);
    this.available = false; this.state = 'checking'; this.message = undefined;
    this.active = null; this.pending = null; this.timer = null; this.closed = false; this.started = false;
    manager.codexWorker = this;
  }

  status() {
    return { enabled: true, available: this.available, state: this.state, ...(this.message ? { message: this.message } : {}), ...(this.active ? { activeJobId: this.active.jobId } : {}) };
  }

  async check() {
    this.state = 'checking'; this.message = undefined;
    let result;
    try { result = await this.adapter.check(); } catch { result = { available: false }; }
    this.available = result?.available === true;
    this.state = this.available ? 'ready' : 'unavailable';
    this.message = this.available ? undefined : unavailableMessage;
  }

  async start() {
    if (this.started || this.closed) return;
    this.started = true;
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    // No attempt is resumed by rerunning Codex. Only immutable returning output
    // in the manager's bounded asset store is eligible for completion recovery.
    for (const entry of await fs.readdir(this.directory, { withFileTypes: true })) {
      if (UUID.test(entry.name)) await fs.rm(path.join(this.directory, entry.name), { recursive: true, force: true });
    }
    await this.check();
    if (!this.closed) {
      this.timer = setInterval(() => { void this.tick(); }, CODEX_WORKER_POLL_MS);
      this.timer.unref?.();
    }
  }

  tick() {
    if (this.closed || !this.started) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.runTick().catch(() => {
      this.state = 'unavailable';
      this.message = 'The local Codex worker could not save or read its receipt. Resolve local storage before continuing; no automatic regeneration was made.';
    }).finally(() => { this.pending = null; });
    return this.pending;
  }

  async returningBytes(job) {
    const opened = await openBoundedFile(path.join(this.manager.assetsDirectory, job.outputAsset), { maxBytes: MAX_OUTPUT_BYTES });
    try { return (await readBoundedHandle(opened.handle, { bytes: opened.bytes, expectedHash: job.outputAsset })).data; }
    finally { await opened.handle.close(); }
  }

  async prepareHandoff(job, workDir) {
    const { image, mask, ...handoff } = await this.manager.handoff(job.jobId, { attemptId: job.attemptId });
    const assets = {};
    await fs.mkdir(workDir, { mode: 0o700 });
    for (const [role, bytes] of [['input', image], ['mask', mask]]) if (bytes) {
      if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_REFERENCE_BYTES) throw Object.assign(new Error('Invalid saved Codex reference.'), { code: 'AI_LIMIT_EXCEEDED' });
      const filename = path.join(workDir, `${role}.png`);
      await fs.writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
      assets[role] = { path: filename, mimeType: 'image/png' };
    }
    return { ...handoff, assets };
  }

  async runTick() {
    let job = this.manager.returningCodexJob();
    if (!job) {
      if (!this.available) await this.check();
      if (this.closed || !this.available) return;
      job = await this.manager.claimCodexJob();
    }
    if (!job || this.closed) {
      if (job) await this.manager.interruptCodexAttempt(job);
      return;
    }
    const controller = new AbortController(), workDir = path.join(this.directory, job.attemptId);
    this.active = { ...job, controller }; this.state = 'working'; this.message = undefined;
    try {
      if (!job.outputAsset) {
        const handoff = await this.prepareHandoff(job, workDir);
        if (controller.signal.aborted) throw Object.assign(new Error('Cancelled.'), { code: 'AI_CANCELLED' });
        const output = await this.adapter.generate({ handoff, workDir, signal: controller.signal, onProgress: () => {} });
        if (controller.signal.aborted) throw Object.assign(new Error('Cancelled.'), { code: 'AI_CANCELLED' });
        if (!Buffer.isBuffer(output) || !output.length || output.length > MAX_OUTPUT_BYTES) throw Object.assign(new Error('Invalid generated PNG.'), { code: 'AI_RESPONSE_INVALID' });
        job = await this.manager.recordCodexOutput({ ...job, data: output });
      }
      // The receipt and exact image survive a crash or completion failure.
      // Reconciliation only returns these bytes; it never calls the adapter.
      if (!controller.signal.aborted && !this.closed) {
        const data = await this.returningBytes(job);
        if (!controller.signal.aborted && !this.closed) await this.manager.complete({ jobId: job.jobId, attemptId: job.attemptId, data });
      }
    } catch (cause) {
      await this.manager.interruptCodexAttempt({ ...job, failed: !controller.signal.aborted && cause?.code !== 'AI_CANCELLED' });
      if (!controller.signal.aborted && this.manager.get(job.jobId).job.status === 'awaiting_image') {
        this.message = job.outputAsset ? 'The image is saved locally. The worker will retry returning that same image without generating again.' : 'The local Codex attempt stopped without a usable image. It will not regenerate automatically.';
      }
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
      this.active = null;
      this.state = this.available ? 'ready' : 'unavailable';
    }
  }

  cancel(jobId) {
    if (this.active?.jobId === jobId) this.active.controller.abort();
  }

  async close() {
    if (this.closed) { await this.pending; return; }
    this.closed = true; clearInterval(this.timer); this.timer = null;
    this.active?.controller.abort();
    if (this.active) this.manager.abortCodexApplication(this.active.jobId);
    await this.pending;
  }
}
