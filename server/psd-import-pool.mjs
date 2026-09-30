import { Worker } from 'node:worker_threads';
import { PSD_IMPORT_LIMITS } from './psd-import.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });
/** Admission covers direct native callers too. A plan handshake reserves all
 * binary work before the worker allocates decoded raster or mask buffers. */
export class PsdImportPool {
  constructor({ WorkerClass = Worker, timeoutMs = PSD_IMPORT_LIMITS.timeoutMs, maxWorkingBytes = PSD_IMPORT_LIMITS.maxWorkingBytes } = {}) {
    this.WorkerClass = WorkerClass; this.timeoutMs = timeoutMs; this.maxWorkingBytes = maxWorkingBytes;
    this.pending = []; this.active = null; this.reserved = 0; this.closed = false;
  }
  run(data, options, consume) {
    if (this.closed) return Promise.reject(fail('PSD_IMPORT_CLOSED', 'PSD import processing is closed.'));
    if (!Buffer.isBuffer(data) || !data.length) return Promise.reject(fail('INVALID_PSD', 'PSD import requires binary file bytes.'));
    if (data.length > PSD_IMPORT_LIMITS.maxBytes) return Promise.reject(fail('LIMIT_EXCEEDED', 'PSD input exceeds 64 MiB.'));
    if (options.signal?.aborted) return Promise.reject(fail('PSD_IMPORT_CANCELLED', 'PSD import was cancelled before publication.'));
    const reservation = 2 * data.length + 1024 * 1024;
    if (this.pending.length >= 2 || this.reserved + reservation > this.maxWorkingBytes) return Promise.reject(fail('LIMIT_EXCEEDED', 'PSD processing is at its bounded input or queue capacity.'));
    const input = new ArrayBuffer(data.length); new Uint8Array(input).set(data);
    this.reserved += reservation;
    return new Promise((resolve, reject) => {
      const job = { input, options, consume, resolve, reject, reservation, aborted: false };
      job.abort = () => { job.aborted = true; if (this.active === job) job.stop?.(fail('PSD_IMPORT_CANCELLED', 'PSD import was cancelled before publication.')); else { const index = this.pending.indexOf(job); if (index >= 0) { this.pending.splice(index, 1); this.release(job); reject(fail('PSD_IMPORT_CANCELLED', 'PSD import was cancelled before publication.')); } } };
      options.signal?.addEventListener('abort', job.abort, { once: true }); this.pending.push(job); this.kick();
    });
  }
  release(job) { this.reserved -= job.reservation; job.options.signal?.removeEventListener('abort', job.abort); }
  kick() { if (this.active || this.closed || !this.pending.length) return; const job = this.active = this.pending.shift(); this.process(job).then(job.resolve, job.reject).finally(() => { this.release(job); this.active = null; this.kick(); }); }
  async process(job) {
    let worker, timer, settled = false;
    try {
      const result = await new Promise((resolve, reject) => {
        const finish = (error, output) => { if (settled) return; settled = true; error ? reject(error) : resolve(output); };
        job.stop = error => finish(error);
        worker = new this.WorkerClass(new URL('./psd-import-worker.mjs', import.meta.url), { execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 } });
        timer = setTimeout(() => finish(fail('PSD_IMPORT_TIMEOUT', 'PSD processing exceeded its worker deadline.')), this.timeoutMs);
        worker.on('error', () => finish(fail('PSD_IMPORT_FAILED', 'PSD worker failed before publication.')));
        worker.on('exit', () => finish(fail('PSD_IMPORT_FAILED', 'PSD worker exited before completing validation.')));
        worker.on('message', message => {
          if (settled) return;
          if (message?.type === 'plan') {
            const required = message.workingBytes;
            if (!Number.isSafeInteger(required) || required < job.reservation || required > this.maxWorkingBytes || this.reserved - job.reservation + required > this.maxWorkingBytes) return finish(fail('LIMIT_EXCEEDED', 'PSD decoding exceeds the shared working-memory budget.'));
            this.reserved += required - job.reservation; job.reservation = required;
            try { worker.postMessage({ continue: true }); } catch { finish(fail('PSD_IMPORT_FAILED', 'PSD worker communication failed.')); }
          } else if (message?.type === 'result') finish(null, message.result);
          else if (message?.type === 'error') {
            const allowed = ['INVALID_PSD', 'INVALID_ARGUMENT', 'LIMIT_EXCEEDED', 'PSD_HASH_MISMATCH', 'PSD_IMPORT_FAILED'];
            const code = allowed.includes(message.error?.code) ? message.error.code : 'PSD_IMPORT_FAILED';
            finish(fail(code, typeof message.error?.message === 'string' && message.error.message.length <= 300 ? message.error.message : 'PSD processing failed before publication.'));
          } else finish(fail('PSD_IMPORT_FAILED', 'PSD worker returned an invalid message.'));
        });
        const { signal, ...options } = job.options;
        try { worker.postMessage({ input: job.input, options }, [job.input]); } catch { finish(fail('PSD_IMPORT_FAILED', 'PSD worker communication failed.')); }
      });
      clearTimeout(timer); await worker.terminate(); worker = null;
      if (job.aborted || this.closed) throw fail('PSD_IMPORT_CANCELLED', 'PSD import was cancelled before publication.');
      // Retain reservation through parent validation and native publication.
      return await job.consume(result, () => job.aborted || this.closed);
    } finally { clearTimeout(timer); if (worker) await worker.terminate().catch(() => {}); }
  }
  async close() {
    this.closed = true;
    for (const job of this.pending.splice(0)) { this.release(job); job.reject(fail('PSD_IMPORT_CANCELLED', 'PSD processing closed before publication.')); }
    if (this.active) { const job = this.active; job.aborted = true; job.stop?.(fail('PSD_IMPORT_CANCELLED', 'PSD processing closed before publication.')); while (this.active === job) await new Promise(resolve => setTimeout(resolve, 5)); }
  }
}
