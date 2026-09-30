import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEGMENTATION_MODEL } from './segmentation-model.mjs';

const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_HEADER_BYTES = 4096;
const MAX_PIXELS = 24_000_000;
const SCRIPT = fileURLToPath(new URL('./segmentation.py', import.meta.url));
const REQUEST_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const failure = (code = 'SEGMENTATION_FAILED', message = 'The local subject extraction process stopped or returned an invalid response.') => Object.assign(new Error(message), { code });

// Worker-compatible adapter. Only framed image/alpha bytes cross this pipe;
// the child never receives the editor process's environment or API credentials.
export class PythonSegmentationWorker extends EventEmitter {
  constructor({ workerData, spawnImpl = spawn, killGraceMs = 500 } = {}) {
    super();
    if (!workerData || typeof workerData.pythonPath !== 'string' || !path.isAbsolute(workerData.pythonPath)
      || typeof workerData.modelPath !== 'string' || !path.isAbsolute(workerData.modelPath)
      || typeof spawnImpl !== 'function' || !Number.isInteger(killGraceMs) || killGraceMs < 10 || killGraceMs > 5000) {
      throw failure('INVALID_ARGUMENT', 'Subject extraction requires absolute Python and model paths.');
    }
    // Match a Worker without making an unobserved asynchronous error fatal to
    // the entire application. Registered consumers still receive this event.
    this.on('error', () => {});
    this.child = null;
    this.pending = null;
    this.header = [];
    this.headerBytes = 0;
    this.response = null;
    this.failed = false;
    this.stopping = false;
    this.closed = false;
    this.killTimer = null;
    this.killGraceMs = killGraceMs;
    this.closePromise = new Promise((resolve) => { this.resolveClose = resolve; });
    try {
      this.child = spawnImpl(workerData.pythonPath, ['-u', SCRIPT, workerData.modelPath], {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { PYTHONUNBUFFERED: '1', PYTHONUTF8: '1', OMP_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '1', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
      });
    } catch {
      queueMicrotask(() => { this.fail(); this.finish(1); });
      return;
    }
    const child = this.child;
    if (!child || typeof child.on !== 'function' || typeof child.kill !== 'function') {
      this.child = null;
      queueMicrotask(() => { this.fail(); this.finish(1); });
      return;
    }
    child.on('error', () => this.fail());
    child.on('close', (code) => this.finish(Number.isInteger(code) ? code : 1));
    if (!child.stdin || !child.stdout || !child.stderr) {
      queueMicrotask(() => this.fail());
      return;
    }
    child.stdin.on('error', () => this.fail());
    child.stdout.on('error', () => this.fail());
    child.stderr.on('error', () => this.fail());
    child.stdout.on('data', (chunk) => this.read(chunk));
    child.stdout.on('end', () => { if (!this.stopping && !this.closed) this.fail(); });
    // Drain diagnostics so a full stderr pipe cannot stall inference. Never
    // forward Python tracebacks, local paths, or arbitrary child error text.
    child.stderr.on('data', () => {});
  }

  postMessage(message) {
    if (this.closed || this.stopping || this.failed) throw failure();
    if (this.pending) throw failure('SEGMENTATION_BUSY', 'Another subject is being extracted. Wait for it to finish.');
    const id = message?.id, input = message?.data;
    if (typeof id !== 'string' || !REQUEST_ID.test(id) || !(input instanceof Uint8Array) || input.byteLength < 1 || input.byteLength > MAX_INPUT_BYTES) {
      throw failure('INVALID_IMAGE', 'Subject extraction requires an identifier and an image no larger than 32 MiB.');
    }
    const data = Buffer.from(input); // Match Worker message isolation.
    const header = Buffer.from(`${JSON.stringify({ id, bytes: data.length })}\n`);
    this.pending = id;
    try {
      this.child.stdin.write(header, (cause) => {
        if (cause) { this.fail(); return; }
        if (this.stopping || this.closed || this.pending !== id) return;
        try { this.child.stdin.write(data, (cause) => { if (cause) this.fail(); }); }
        catch { this.fail(); }
      });
    } catch { this.fail(); }
  }

  read(chunk) {
    if (this.stopping || this.closed || this.failed) return;
    if (!this.pending || !(chunk instanceof Uint8Array)) { this.fail(); return; }
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < data.length && !this.stopping && !this.failed) {
      if (!this.response) {
        const newline = data.indexOf(10, offset);
        const end = newline < 0 ? data.length : newline;
        const count = end - offset;
        if (this.headerBytes + count + (newline >= 0 ? 1 : 0) > MAX_HEADER_BYTES) { this.fail(); return; }
        if (count) { this.header.push(Buffer.from(data.subarray(offset, end))); this.headerBytes += count; }
        offset = end;
        if (newline < 0) return;
        offset++;
        let header;
        try { header = JSON.parse(Buffer.concat(this.header, this.headerBytes).toString('utf8')); }
        catch { this.fail(); return; }
        this.header = []; this.headerBytes = 0;
        if (!header || typeof header !== 'object' || Array.isArray(header) || header.id !== this.pending) { this.fail(); return; }
        if (Object.hasOwn(header, 'error')) {
          if (!header.error || typeof header.error !== 'object' || Array.isArray(header.error) || Object.hasOwn(header, 'bytes') || offset !== data.length) { this.fail(); return; }
          const id = this.pending; this.pending = null;
          this.emit('message', { id, error: { code: 'SEGMENTATION_FAILED', message: 'Local subject extraction failed. Verify the model and try a smaller image.' } });
          return;
        }
        const { width, height, bytes, model } = header;
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192
          || width * height > MAX_PIXELS || !Number.isInteger(bytes) || bytes !== width * height || model !== SEGMENTATION_MODEL.id) {
          this.fail(); return;
        }
        this.response = { width, height, model, alpha: Buffer.alloc(bytes), received: 0 };
      }
      const response = this.response;
      const count = Math.min(response.alpha.length - response.received, data.length - offset);
      if (count) { data.copy(response.alpha, response.received, offset, offset + count); response.received += count; offset += count; }
      if (response.received === response.alpha.length) {
        // There can be no second reply while one request is in flight.
        if (offset !== data.length) { this.fail(); return; }
        const id = this.pending;
        this.pending = null; this.response = null;
        this.emit('message', { id, result: { alpha: response.alpha, width: response.width, height: response.height, model: response.model } });
        return;
      }
    }
  }

  fail() {
    if (this.failed || this.closed || this.stopping) return;
    this.failed = true;
    this.emit('error', failure());
    this.terminate();
  }

  finish(code) {
    if (this.closed) return;
    if (!this.stopping && (this.pending || this.headerBytes || this.response)) {
      this.failed = true;
      this.emit('error', failure());
    }
    this.closed = true;
    clearTimeout(this.killTimer); this.killTimer = null;
    this.pending = null; this.response = null; this.header = []; this.headerBytes = 0;
    this.emit('exit', code);
    this.resolveClose(code);
  }

  unref() {
    this.child?.unref?.();
    for (const stream of [this.child?.stdin, this.child?.stdout, this.child?.stderr]) stream?.unref?.();
    return this;
  }

  terminate() {
    if (this.closed || this.stopping) return this.closePromise;
    this.stopping = true;
    this.pending = null; this.response = null; this.header = []; this.headerBytes = 0;
    if (!this.child) { this.finish(1); return this.closePromise; }
    // Keep termination alive even when an idle worker was explicitly unref'd.
    this.child.ref?.();
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) stream?.ref?.();
    this.killTimer = setTimeout(() => {
      if (!this.closed) { try { this.child.kill('SIGKILL'); } catch { /* close will settle shutdown */ } }
    }, this.killGraceMs);
    try { this.child.kill('SIGTERM'); } catch { /* a concurrently exited child still emits close */ }
    return this.closePromise;
  }
}
