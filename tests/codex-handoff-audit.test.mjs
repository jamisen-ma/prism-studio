import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { GenerationManager } from '../server/generation.mjs';
import { NativeBackend } from '../server/native.mjs';
import { createCompanion } from '../server/index.mjs';

// Independent lifecycle regressions. All PNGs are synthetic; no real API key,
// generation tool, external request or production data directory is used.
const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#124578' } }).png().toBuffer();
const other = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#fedcba' } }).png().toBuffer();
const coded = code => cause => cause.code === code;
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-codex-audit-'));
  const native = await new NativeBackend({ dataDir }).init();
  const calls = { keys: 0, provider: 0 };
  const getKey = async () => { calls.keys++; throw Error('Codex must not read a credential.'); };
  const provider = async () => { calls.provider++; throw Error('Codex must not invoke the API.'); };
  const manager = await new GenerationManager({ dataDir, native, getKey, provider }).init();
  t.after(async () => { await manager.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, native, manager, calls };
}

test('default HTTP status and complete workflow never inspect optional API configuration', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-codex-http-audit-'));
  const calls = { keys: 0, provider: 0 };
  const companion = await createCompanion({ dataDir, port: 0,
    getImageKey: async () => { calls.keys++; throw Error('Do not inspect optional API configuration.'); },
    imageProvider: async () => { calls.provider++; throw Error('Do not call optional API.'); },
  });
  t.after(async () => { await companion.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${await companion.listen()}`;
  const request = async (route, body) => {
    const response = await fetch(origin + route, { method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${companion.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
  };
  assert.equal((await request('/api/ai/status')).defaultProvider, 'codex');
  const { job } = await request('/api/ai/jobs', { mode: 'generate', prompt: 'Local session fixture', requestId: 'audit-default-no-key' });
  assert.equal(job.status, 'awaiting_image');
  assert.equal((await request(`/api/ai/jobs/${job.id}/handoff`)).job.id, job.id);
  assert.equal((await request(`/api/ai/jobs/${job.id}/complete`, { data: png.toString('base64') })).job.status, 'succeeded');
  assert.deepEqual(calls, { keys: 0, provider: 0 });
});

test('cancelling a queued completion prevents installation before its controller exists', async t => {
  const { manager, native, calls } = await fixture(t);
  const { job } = await manager.start({ mode: 'generate', prompt: 'Cancel before dispatch' });
  const barrier = gate(), blocker = manager.locked(() => barrier.promise);
  const completion = manager.complete({ jobId: job.id, data: png });
  const cancellation = manager.cancel(job.id);
  barrier.release(); await blocker;
  const [completed, cancelled] = await Promise.allSettled([completion, cancellation]);
  assert.equal(cancelled.status, 'fulfilled'); assert.equal(cancelled.value.job.status, 'cancelled');
  if (completed.status === 'fulfilled') assert.notEqual(completed.value.job.status, 'succeeded');
  else assert.ok(['AI_CANCELLED', 'INVALID_TARGET'].includes(completed.reason.code));
  assert.equal((await native.execute('list_documents')).documents.length, 0);
  assert.deepEqual(calls, { keys: 0, provider: 0 });
});

test('completion owns its PNG bytes before waiting behind another operation', async t => {
  const { manager } = await fixture(t);
  const { job } = await manager.start({ mode: 'generate', prompt: 'Immutable caller buffer' });
  const barrier = gate(), blocker = manager.locked(() => barrier.promise), supplied = Buffer.from(png);
  const completion = manager.complete({ jobId: job.id, data: supplied });
  supplied.fill(0);
  barrier.release(); await blocker;
  assert.equal((await completion).job.status, 'succeeded');
  assert.deepEqual((await manager.output(job.id)).data, png);
});

test('concurrent identical completion installs once and a different completion cannot replace it', async t => {
  const { manager, native } = await fixture(t);
  const { job } = await manager.start({ mode: 'generate', prompt: 'Concurrent output' });
  const outcomes = await Promise.allSettled([
    manager.complete({ jobId: job.id, data: png }), manager.complete({ jobId: job.id, data: png }), manager.complete({ jobId: job.id, data: other }),
  ]);
  assert.equal(outcomes[0].status, 'fulfilled'); assert.equal(outcomes[1].status, 'fulfilled');
  assert.equal(outcomes[0].value.job.documentId, outcomes[1].value.job.documentId);
  assert.equal(outcomes[2].status, 'rejected'); assert.equal(outcomes[2].reason.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await native.execute('list_documents')).documents.length, 1);
  assert.deepEqual((await manager.output(job.id)).data, png);
});

test('oversized dimensions and truncated PNGs leave the pending receipt and all assets unchanged', async t => {
  const { manager, dataDir, native } = await fixture(t);
  const { job } = await manager.start({ mode: 'generate', prompt: 'Reject invalid pixels' });
  const file = path.join(dataDir, 'generation', 'jobs', `${job.id}.json`), before = await fs.readFile(file);
  const wide = await sharp({ create: { width: 8193, height: 1, channels: 4, background: '#abcdef' } }).png().toBuffer();
  for (const data of [wide, png.subarray(0, 48), Buffer.from('not a png')]) await assert.rejects(manager.complete({ jobId: job.id, data }), coded('AI_RESPONSE_INVALID'));
  await assert.rejects(manager.complete({ jobId: job.id, data: Buffer.alloc(32 * 1024 * 1024 + 1) }), coded('AI_LIMIT_EXCEEDED'));
  assert.deepEqual(await fs.readFile(file), before);
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'generation', 'assets')), []);
  assert.equal((await native.execute('list_documents')).documents.length, 0);
  assert.equal(manager.get(job.id).job.status, 'awaiting_image');
});

test('materialized MCP references reject changed bytes and cannot weaken the authoritative saved edit mask', { timeout: 15000 }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-codex-reference-audit-'));
  const calls = { keys: 0, provider: 0 };
  const companion = await createCompanion({ dataDir, port: 0,
    getImageKey: async () => { calls.keys++; throw Error('No API key access.'); },
    imageProvider: async () => { calls.provider++; throw Error('No provider access.'); },
  });
  const port = await companion.listen(), root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const client = new Client({ name: 'prism-codex-reference-audit', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server/mcp.mjs')], cwd: root,
    env: { PRISM_URL: `http://127.0.0.1:${port}`, PRISM_DATA_DIR: dataDir }, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  t.after(async () => { await client.close(); await companion.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  await client.connect(transport);
  const call = (name, args = {}) => client.callTool({ name: `prism_${name}`, arguments: args });
  const result = response => { assert.notEqual(response.isError, true, JSON.stringify(response.content)); return response.structuredContent; };
  let doc = result(await call('create_document', { backend: 'native', name: 'Immutable reference audit', width: 8, height: 8, background: '#abcdef' })).document;
  doc = result(await call('select_rectangle', { backend: 'native', documentId: doc.id, expectedRevision: doc.revision, x: 0, y: 0, width: 4, height: 8 })).document;
  const { job } = result(await call('edit_image', { documentId: doc.id, expectedRevision: doc.revision, scope: 'selection', prompt: 'Change only the left half', requestId: 'reference-immutability-audit' }));
  const handoff = result(await call('get_generation_handoff', { jobId: job.id }));
  const originalMask = await fs.readFile(handoff.assets.mask.path);
  await fs.writeFile(handoff.assets.mask.path, png);
  const rejected = await call('get_generation_handoff', { jobId: job.id });
  assert.equal(rejected.isError, true); assert.equal(JSON.parse(rejected.content.find(item => item.type === 'text').text).code, 'INVALID_IMAGE');
  assert.deepEqual(await fs.readFile(handoff.assets.mask.path), png, 'Changed materialized reference is never silently overwritten.');
  const filename = path.join(dataDir, 'synthetic-result.png'); await fs.writeFile(filename, png);
  const completed = result(await call('complete_generation', { jobId: job.id, path: filename }));
  const preview = await call('get_preview', { backend: 'native', documentId: doc.id, maxWidth: 32 });
  result(preview);
  const pixels = await sharp(Buffer.from(preview.content.find(item => item.type === 'image').data, 'base64')).ensureAlpha().raw().toBuffer();
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) assert.deepEqual([...pixels.subarray((y * 8 + x) * 4, (y * 8 + x) * 4 + 4)], x < 4 ? [18, 69, 120, 255] : [171, 205, 239, 255]);
  assert.equal(completed.job.status, 'succeeded');
  await fs.writeFile(handoff.assets.mask.path, originalMask);
  assert.deepEqual(result(await call('get_generation_handoff', { jobId: job.id })).assets, handoff.assets);
  assert.deepEqual(calls, { keys: 0, provider: 0 });
});
