import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PythonSegmentationWorker } from '../server/python-segmentation-worker.mjs';

const model = 'birefnet-general-lite';
const workerData = { pythonPath: '/absolute/python3', modelPath: '/absolute/subject-model.onnx' };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function frame(id, alpha = Buffer.from([0, 10, 128, 255]), width = 2, height = 2) {
  return Buffer.concat([Buffer.from(`${JSON.stringify({ id, width, height, bytes: alpha.length, model })}\n`), alpha]);
}
class FakeChild extends EventEmitter {
  constructor({ ignoreTerm = false, writeError = false } = {}) {
    super(); this.signals = []; this.writes = []; this.ignoreTerm = ignoreTerm; this.unrefs = 0; this.refs = 0;
    this.stdin = new Writable({ write: (chunk, _encoding, callback) => {
      this.writes.push(Buffer.from(chunk));
      callback(writeError ? new Error('private stdin details') : null);
    } });
    this.stdout = new PassThrough(); this.stderr = new PassThrough();
    for (const stream of [this.stdin, this.stdout, this.stderr]) {
      stream.unrefs = 0; stream.refs = 0;
      stream.unref = () => { stream.unrefs++; };
      stream.ref = () => { stream.refs++; };
    }
  }
  unref() { this.unrefs++; }
  ref() { this.refs++; }
  kill(signal) {
    this.signals.push(signal);
    if (signal === 'SIGKILL' || !this.ignoreTerm) queueMicrotask(() => this.close(signal === 'SIGTERM' ? 0 : null));
    return true;
  }
  close(code = 0) {
    if (this.closed) return; this.closed = true;
    this.stdin.destroy(); this.stdout.destroy(); this.stderr.destroy(); this.emit('close', code);
  }
}
function fixture(t, childOptions = {}) {
  const child = new FakeChild(childOptions), spawns = [];
  const worker = new PythonSegmentationWorker({ workerData, killGraceMs: 15, spawnImpl: (...args) => { spawns.push(args); return child; } });
  t.after(() => worker.terminate());
  return { worker, child, spawns };
}

test('spawns fixed absolute arguments with a minimal environment and unrefs the idle process and every pipe', async (t) => {
  const { worker, child, spawns } = fixture(t);
  const [command, args, options] = spawns[0];
  assert.equal(command, workerData.pythonPath);
  assert.deepEqual(args, ['-u', fileURLToPath(new URL('../server/segmentation.py', import.meta.url)), workerData.modelPath]);
  assert.equal(options.shell, false); assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.deepEqual(options.env, { PYTHONUNBUFFERED: '1', PYTHONUTF8: '1', OMP_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '1', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' });
  worker.unref(); assert.equal(child.unrefs, 1);
  for (const stream of [child.stdin, child.stdout, child.stderr]) assert.equal(stream.unrefs, 1);
  child.stderr.write('private diagnostic content that must be drained');
  assert.equal(child.stderr.readableLength, 0);
});

test('request framing copies caller data and fragmented binary responses preserve newlines and soft alpha', async (t) => {
  const { worker, child } = fixture(t);
  const data = Buffer.from([137, 80, 78, 71, 0, 10, 255]);
  worker.postMessage({ id: 'first-id', data }); data.fill(0);
  assert.throws(() => worker.postMessage({ id: 'second-id', data }), { code: 'SEGMENTATION_BUSY' });
  await tick();
  assert.deepEqual(child.writes, [Buffer.from('{"id":"first-id","bytes":7}\n'), Buffer.from([137, 80, 78, 71, 0, 10, 255])]);
  const message = once(worker, 'message'), response = frame('first-id');
  for (let offset = 0; offset < response.length; offset += 3) child.stdout.write(response.subarray(offset, offset + 3));
  const [first] = await message;
  assert.deepEqual(first, { id: 'first-id', result: { alpha: Buffer.from([0, 10, 128, 255]), width: 2, height: 2, model } });
  worker.postMessage({ id: 'second-id', data: Buffer.from('next image') });
  const next = once(worker, 'message'); child.stdout.write(frame('second-id', Buffer.from([37]), 1, 1));
  assert.equal((await next)[0].result.alpha[0], 37); assert.deepEqual(child.signals, []);
});

test('child-reported errors are static, reveal no Python details, and leave the process reusable', async (t) => {
  const { worker, child } = fixture(t);
  worker.postMessage({ id: 'bad-input', data: Buffer.from('image') });
  const message = once(worker, 'message');
  child.stdout.write(`${JSON.stringify({ id: 'bad-input', error: { code: 'PRIVATE_EXCEPTION', message: 'secret traceback /private/path' } })}\n`);
  const [result] = await message;
  assert.equal(result.error.code, 'SEGMENTATION_FAILED'); assert.doesNotMatch(JSON.stringify(result), /secret|traceback|PRIVATE_EXCEPTION|private\/path/);
  worker.postMessage({ id: 'retry', data: Buffer.from('next image') });
  const next = once(worker, 'message'); child.stdout.write(frame('retry')); await next;
  assert.deepEqual(child.signals, []);
});

for (const [label, response] of [
  ['invalid JSON', Buffer.from('{broken JSON}\n')],
  ['oversized header', Buffer.alloc(4097, 65)],
  ['header beyond the limit including its newline', Buffer.from(' '.repeat(4096) + '\n')],
  ['mismatched identifier', frame('another-id')],
  ['oversized axis', Buffer.from(`${JSON.stringify({ id: 'request', width: 8193, height: 1, bytes: 8193, model })}\n`)],
  ['oversized pixel count', Buffer.from(`${JSON.stringify({ id: 'request', width: 8192, height: 8192, bytes: 67108864, model })}\n`)],
  ['incorrect binary length', Buffer.from(`${JSON.stringify({ id: 'request', width: 2, height: 2, bytes: 5, model })}\n`)],
  ['noninteger dimensions', Buffer.from(`${JSON.stringify({ id: 'request', width: 1.5, height: 2, bytes: 3, model })}\n`)],
  ['unknown model', Buffer.from(`${JSON.stringify({ id: 'request', width: 1, height: 1, bytes: 1, model: 'unexpected' })}\n`)],
  ['error header with bytes', Buffer.from(`${JSON.stringify({ id: 'request', bytes: 0, error: { message: 'private' } })}\n`)],
  ['extra bytes after a complete result', Buffer.concat([frame('request'), Buffer.from('unexpected')])],
]) test(`rejects ${label} without emitting a mask or leaking child details`, async (t) => {
  const { worker, child } = fixture(t); let messages = 0;
  worker.on('message', () => messages++);
  worker.postMessage({ id: 'request', data: Buffer.from('image') });
  const failed = once(worker, 'error'); child.stdout.write(response);
  const [cause] = await failed;
  assert.equal(cause.code, 'SEGMENTATION_FAILED'); assert.doesNotMatch(cause.message, /private|unexpected|broken JSON/);
  await worker.terminate(); assert.deepEqual(child.signals, ['SIGTERM']); assert.equal(messages, 0);
});

test('truncated headers, truncated alpha and unexpected process exit fail pending work safely', async (t) => {
  for (const mode of ['header', 'alpha', 'exit']) {
    const { worker, child } = fixture(t); worker.postMessage({ id: 'request', data: Buffer.from('image') });
    const failed = once(worker, 'error');
    if (mode === 'header') child.stdout.end('{"id":');
    if (mode === 'alpha') child.stdout.end(frame('request').subarray(0, -1));
    if (mode === 'exit') child.close(12);
    assert.equal((await failed)[0].code, 'SEGMENTATION_FAILED'); await worker.terminate();
  }
});

test('spawn failures and write failures are sanitized and safe even without an error subscriber', async (t) => {
  const worker = new PythonSegmentationWorker({ workerData, spawnImpl: () => { throw new Error('private launch path'); } });
  await tick(); assert.equal(await worker.terminate(), 1);
  const { worker: asynchronous, child: failedChild } = fixture(t);
  failedChild.emit('error', new Error('private spawn details')); await asynchronous.terminate();
  const { worker: writer, child } = fixture(t, { writeError: true });
  const failed = once(writer, 'error'); writer.postMessage({ id: 'request', data: Buffer.from('image') });
  assert.equal((await failed)[0].code, 'SEGMENTATION_FAILED'); await writer.terminate();
  assert.equal(child.writes.length, 1, 'a failed header write must not send the image body');
});

test('invalid requests are rejected before any writes and termination is idempotent', async (t) => {
  assert.throws(() => new PythonSegmentationWorker({ workerData: { ...workerData, pythonPath: 'python3' } }), { code: 'INVALID_ARGUMENT' });
  const { worker, child } = fixture(t);
  for (const message of [{ id: '', data: Buffer.from('a') }, { id: 'x'.repeat(129), data: Buffer.from('a') }, { id: 'ok', data: Buffer.alloc(0) }, { id: 'ok', data: 'not binary' }, { id: 'a\nb', data: Buffer.from('a') }, { id: 'ok', data: Buffer.alloc(32 * 1024 * 1024 + 1) }]) {
    assert.throws(() => worker.postMessage(message), { code: 'INVALID_IMAGE' });
  }
  assert.deepEqual(child.writes, []);
  const first = worker.terminate(), second = worker.terminate(); assert.equal(first, second); await first;
  assert.throws(() => worker.postMessage({ id: 'after-close', data: Buffer.from('a') }), { code: 'SEGMENTATION_FAILED' });
});

test('termination escalates to SIGKILL and resolves only after a real child closes', { timeout: 5000 }, async (t) => {
  let child;
  const worker = new PythonSegmentationWorker({ workerData, killGraceMs: 30, spawnImpl: (_python, _args, options) => {
    child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});process.stderr.write("ready");setInterval(()=>{},1000);'], options);
    return child;
  } });
  t.after(() => worker.terminate());
  await once(child.stderr, 'data');
  let closed = false; child.on('close', () => { closed = true; });
  worker.unref(); const start = Date.now();
  await worker.terminate();
  assert.equal(closed, true); assert.equal(child.signalCode, 'SIGKILL'); assert.ok(Date.now() - start >= 20);
});
