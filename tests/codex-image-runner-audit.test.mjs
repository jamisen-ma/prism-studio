import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import sharp from 'sharp';
import { createCodexImageRunner, readCodexImageArtifact } from '../server/codex-image-runner.mjs';

const threadId = '01234567-89ab-cdef-0123-456789abcdef';
const blue = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#0000ff' } }).png().toBuffer();
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-codex-artifact-audit-'));
  const directory = path.join(home, 'generated_images', threadId); await fs.mkdir(directory, { recursive: true });
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return { home, directory, file: path.join(directory, 'native.png'), read: () => readCodexImageArtifact({ codexHome: home, threadId, startedAt: Date.now() }) };
}
function child() {
  const value = new EventEmitter(); value.stdin = new PassThrough(); value.stdout = new PassThrough(); value.stderr = new PassThrough();
  value.signals = []; value.kill = signal => { value.signals.push(signal); queueMicrotask(() => value.emit('close', null)); return true; };
  return value;
}
const handoff = { request: { mode: 'generate', prompt: 'An authored test fixture', size: 'auto', background: 'opaque' } };
const events = id => `${JSON.stringify({ type: 'thread.started', thread_id: id })}\n${JSON.stringify({ type: 'turn.completed' })}\n`;

test('runner returns the exact fresh per-thread PNG and rejects stale, multiple, linked and out-of-bounds artifacts', async t => {
  const f = await fixture(t); await fs.writeFile(f.file, blue); assert.deepEqual(await f.read(), blue);
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(f.file, old, old); await assert.rejects(f.read()); await fs.utimes(f.file, new Date(), new Date());
  await fs.utimes(f.directory, old, old); await assert.rejects(f.read()); await fs.utimes(f.directory, new Date(), new Date());
  const extra = path.join(f.directory, 'second.png'); await fs.writeFile(extra, blue); await assert.rejects(f.read()); await fs.rm(extra);
  await fs.rm(f.file); const external = path.join(f.home, 'external.png'); await fs.writeFile(external, blue); await fs.symlink(external, f.file); await assert.rejects(f.read());
  await fs.rm(f.file); await fs.writeFile(f.file, blue); await fs.truncate(f.file, 30 * 1024 * 1024 + 1); await assert.rejects(f.read(), { code: 'LIMIT_EXCEEDED' });
  await fs.writeFile(f.file, blue); await assert.rejects(readCodexImageArtifact({ codexHome: f.home, threadId: '../escape', startedAt: Date.now() }));
  await fs.rename(f.directory, path.join(f.home, 'outside')); await fs.symlink(path.join(f.home, 'outside'), f.directory); await assert.rejects(f.read());
});

test('artifact validation fully decodes PNG and refuses wrong formats and excessive dimensions', async t => {
  const f = await fixture(t);
  for (const data of [Buffer.from('not an image'), blue.subarray(0, Math.floor(blue.length / 2)), await sharp(blue).jpeg().toBuffer(),
    await sharp({ create: { width: 8193, height: 1, channels: 4, background: '#000' } }).png().toBuffer()]) {
    await fs.writeFile(f.file, data); await assert.rejects(f.read());
  }
  await fs.writeFile(f.file, blue); assert.deepEqual(await f.read(), blue);
});

test('runner checks ChatGPT login on stderr, strips credentials and ignores model-reported artifact paths', async t => {
  const f = await fixture(t); await fs.writeFile(f.file, blue);
  const names = ['PRISM_AUDIT_API_KEY', 'PRISM_AUDIT_TOKEN', 'PRISM_AUDIT_SECRET', 'PRISM_AUDIT_PASSWORD'];
  const previous = names.map(name => process.env[name]); names.forEach(name => { process.env[name] = 'private-do-not-pass'; });
  let invocation = 0; const calls = [];
  let runner;
  try { runner = createCodexImageRunner({ codexHome: f.home, spawnProcess: (exe, args, options) => {
    const value = child(); calls.push({ exe, args, options, child: value }); const index = invocation++;
    queueMicrotask(() => {
      if (index === 0) value.stderr.write('Logged in using ChatGPT\n');
      else if (index === 1) value.stdout.write('image_generation stable true\n');
      else value.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: threadId })}\n${JSON.stringify({ type: 'item.completed', item: { text: '/private/untrusted/model-path.png' } })}\n${JSON.stringify({ type: 'turn.completed' })}\n`);
      value.emit('close', 0);
    }); return value;
  } }); } finally { names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; }); }
  assert.deepEqual(await runner.check(), { available: true });
  assert.deepEqual(await runner.generate({ handoff, workDir: f.home, signal: new AbortController().signal }), blue);
  assert.equal(calls.length, 3);
  for (const call of calls) { for (const name of names) assert.equal(call.options.env[name], undefined); assert.equal(call.options.shell, false); }
  const args = calls[2].args;
  assert.ok(args.includes('--ignore-user-config')); assert.ok(args.includes('forced_login_method="chatgpt"')); assert.ok(args.includes('read-only'));
  assert.equal(calls[2].options.env.CODEX_HOME, f.home);
  let starts = 0;
  const denied = createCodexImageRunner({ spawnProcess: () => { starts++; return child(); }, codexHome: f.home });
  await assert.rejects(denied.generate({ handoff: { ...handoff, assets: { input: { path: path.join(f.home, '..', 'unrelated.png') } } }, workDir: f.home }));
  assert.equal(starts, 0);
});

test('execution receipts reject duplicate threads, failure, incomplete JSON and excessive private logs without exposing them', async t => {
  const f = await fixture(t); await fs.writeFile(f.file, blue);
  const cases = [
    events(threadId) + events(threadId),
    events(threadId) + JSON.stringify({ type: 'turn.failed', error: { message: 'secret-provider-detail' } }) + '\n',
    '{malformed-private-secret}\n',
    JSON.stringify({ type: 'thread.started', thread_id: threadId }) + '\n',
    'x'.repeat(2 * 1024 * 1024 + 1),
  ];
  for (const output of cases) {
    const runner = createCodexImageRunner({ codexHome: f.home, spawnProcess: () => {
      const value = child(); queueMicrotask(() => { value.stdout.write(output); value.emit('close', 0); }); return value;
    } });
    await assert.rejects(runner.generate({ handoff, workDir: f.home }), error => !/secret-provider-detail|malformed-private-secret/.test(error.message));
  }
});

test('cancellation and timeout terminate a real injected dummy child without invoking Codex or a model', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  for (const kind of ['cancel', 'timeout']) {
    let pid, spawned;
    const ready = new Promise(resolve => { spawned = resolve; });
    const runner = createCodexImageRunner({ codexHome: f.home, timeoutMs: kind === 'timeout' ? 50 : 2000, spawnProcess: (_exe, _args, options) => {
      const value = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options); pid = value.pid; value.on('spawn', spawned); return value;
    } });
    const controller = new AbortController();
    const generated = runner.generate({ handoff, workDir: f.home, signal: controller.signal });
    const refused = assert.rejects(generated, { code: kind === 'cancel' ? 'AI_CANCELLED' : 'CODEX_TIMEOUT' });
    await ready; if (kind === 'cancel') controller.abort(); await refused;
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }
});
