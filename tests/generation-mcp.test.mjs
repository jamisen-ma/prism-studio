import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCompanion } from '../server/index.mjs';

// These are full SDK-to-HTTP-to-native tests with a controlled fake provider.
// They never read a configured image API key or invoke an external image API.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_KEY = 'sk-test-only-generation-mcp-not-a-real-credential';
const generated = await sharp({ create: { width: 64, height: 48, channels: 4, background: '#2255ff' } }).png().toBuffer();
const output = () => ({ data: generated, mimeType: 'image/png', usage: { input_tokens: 3, output_tokens: 7 }, requestId: 'fake-mcp-provider-request' });

async function until(check, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-generation-mcp-'));
  const calls = [];
  const imageProvider = args => new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error('Fake provider cancelled'), { code: 'AI_CANCELLED' }));
    args.signal.addEventListener('abort', abort, { once: true });
    calls.push({ args, resolve: response => { args.signal.removeEventListener('abort', abort); resolve(response); } });
    if (args.signal.aborted) abort();
  });
  const companion = await createCompanion({ dataDir, port: 0, imageProvider, getImageKey: async () => TEST_KEY });
  const port = await companion.listen();
  const client = new Client({ name: 'prism-generation-integration-tests', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(root, 'server/mcp.mjs')], cwd: root,
    env: { PRISM_URL: `http://127.0.0.1:${port}`, PRISM_DATA_DIR: dataDir }, stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr.on('data', bytes => { stderr += bytes.toString(); });
  t.after(async () => {
    await client.close();
    await companion.close();
    await fs.rm(dataDir, { recursive: true, force: true });
    assert.ok(!stderr.includes(TEST_KEY), 'The injected test credential must never reach MCP logs');
  });
  await client.connect(transport);
  const call = (name, args = {}) => client.callTool({ name: `prism_${name}`, arguments: ['generate_image', 'edit_image'].includes(name) ? { provider: 'openai', ...args } : args });
  const job = (id, predicate) => until(async () => {
    const value = result(await call('get_generation_job', { jobId: id })).job;
    return (typeof predicate === 'function' ? predicate(value) : value.status === predicate) ? value : false;
  }, `generation job to reach ${typeof predicate === 'function' ? 'expected state' : predicate}`);
  return { client, call, calls, job };
}

function result(response) {
  assert.notEqual(response.isError, true, JSON.stringify(response.content));
  const parsed = response.structuredContent ?? JSON.parse(response.content.find(item => item.type === 'text').text);
  assert.ok(parsed && typeof parsed === 'object', 'AI HTTP responses must not be incorrectly unwrapped as command result');
  assert.ok(!JSON.stringify(parsed).includes(TEST_KEY));
  return parsed;
}
function failure(response) {
  assert.equal(response.isError, true, JSON.stringify(response));
  return JSON.parse(response.content.find(item => item.type === 'text').text);
}
async function pixels(response) {
  result(response);
  const block = response.content.find(item => item.type === 'image');
  assert.ok(block, 'Preview tools must return a real MCP image content block');
  assert.equal(block.mimeType, 'image/png');
  return sharp(Buffer.from(block.data, 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

test('official MCP discovers all eight AI tools, requires retry IDs, and generates an actual native document once', { timeout: 15000 }, async t => {
  const { client, call, calls, job } = await fixture(t);
  const { tools } = await client.listTools();
  for (const name of ['ai_status', 'generate_image', 'edit_image', 'list_generation_jobs', 'get_generation_job', 'get_generation_preview', 'cancel_generation', 'apply_generation']) {
    assert.ok(tools.some(tool => tool.name === `prism_${name}`), name);
  }
  for (const name of ['generate_image', 'edit_image']) {
    const tool = tools.find(tool => tool.name === `prism_${name}`);
    assert.ok(tool.inputSchema.required.includes('requestId'));
    assert.equal(tool.annotations.openWorldHint, true);
    assert.equal(tool.annotations.readOnlyHint, false);
    const missing = await call(name, { prompt: 'Missing stable request ID', ...(name === 'edit_image' ? { documentId: 'fake-document', expectedRevision: 1 } : {}) });
    assert.equal(missing.isError, true);
    assert.match(missing.content.map(block => block.text || '').join(' '), /requestId/);
  }
  assert.equal(calls.length, 0);
  assert.equal(result(await call('ai_status', { provider: 'openai' })).configured, true);
  assert.deepEqual(result(await call('list_generation_jobs')).jobs, []);
  const args = { prompt: 'Blue integration fixture', name: 'MCP generated image', requestId: 'same-mcp-paid-request', quality: 'low' };
  const first = result(await call('generate_image', args)).job;
  await until(() => calls.length === 1, 'fake provider dispatch');
  const retry = result(await call('generate_image', args)).job;
  assert.equal(retry.id, first.id, 'Repeating a start after an uncertain response must return the same paid job');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.apiKey, TEST_KEY);
  assert.equal(calls[0].args.image, undefined);
  assert.equal(calls[0].args.quality, 'low');
  const conflict = failure(await call('generate_image', { ...args, prompt: 'Conflicting retry' }));
  assert.equal(conflict.code, 'IDEMPOTENCY_CONFLICT');
  calls[0].resolve(output());
  const complete = await job(first.id, 'succeeded');
  assert.equal(complete.outputAvailable, true);
  assert.equal(result(await call('list_generation_jobs')).jobs.length, 1);
  const preview = await call('get_generation_preview', { jobId: first.id, maxWidth: 32 });
  assert.equal(result(preview).width, 32);
  assert.equal(result(preview).height, 24);
  const rendered = await pixels(preview);
  assert.deepEqual([...rendered.data.subarray(0, 4)], [34, 85, 255, 255]);
  assert.equal(rendered.info.width, 32);
  const native = result(await call('get_document', { backend: 'native', documentId: complete.documentId })).document;
  assert.equal(native.name, 'MCP generated image');
  assert.equal(native.layers.length, 1);
  assert.equal(native.layers[0].provenance.jobId, first.id);
  assert.equal(native.layers[0].id, complete.layerId);
  const reapplied = result(await call('apply_generation', { jobId: first.id })).job;
  assert.equal(reapplied.id, first.id);
  assert.equal(reapplied.status, 'succeeded');
  assert.equal(result(await call('generate_image', args)).job.id, first.id);
  assert.equal(calls.length, 1);
});

test('MCP selection edits preview retained output and require explicit current-revision application without another provider call', { timeout: 15000 }, async t => {
  const { call, calls, job } = await fixture(t);
  const initial = result(await call('create_document', { backend: 'native', name: 'MCP protected selection', width: 64, height: 48, background: '#804020' })).document;
  const selected = result(await call('select_rectangle', { backend: 'native', documentId: initial.id, x: 0, y: 0, width: 32, height: 48 })).document;
  const args = { documentId: selected.id, expectedRevision: selected.revision, scope: 'selection', prompt: 'Make only the selected half blue', requestId: 'mcp-selected-edit' };
  const started = result(await call('edit_image', args)).job;
  await until(() => calls.length === 1, 'selected edit provider dispatch');
  assert.ok(Buffer.isBuffer(calls[0].args.image));
  assert.ok(Buffer.isBuffer(calls[0].args.mask));
  const current = result(await call('set_layer', { backend: 'native', documentId: initial.id, layerId: initial.layers[0].id, expectedRevision: selected.revision, name: 'Renamed while generating' })).document;
  const before = await pixels(await call('get_preview', { backend: 'native', documentId: initial.id, maxWidth: 64 }));
  calls[0].resolve(output());
  await job(started.id, value => value.status === 'ready' && value.error?.code === 'REVISION_CONFLICT');
  assert.equal(failure(await call('apply_generation', { jobId: started.id })).code, 'INVALID_ARGUMENT');
  assert.equal(failure(await call('apply_generation', { jobId: started.id, expectedRevision: selected.revision })).code, 'REVISION_CONFLICT');
  const retained = await pixels(await call('get_generation_preview', { jobId: started.id, maxWidth: 64 }));
  assert.deepEqual([...retained.data.subarray(0, 4)], [34, 85, 255, 255]);
  const applied = result(await call('apply_generation', { jobId: started.id, expectedRevision: current.revision }));
  assert.equal(applied.job.status, 'succeeded');
  assert.equal(applied.document.revision, current.revision + 1);
  assert.equal(applied.document.layers.length, current.layers.length + 1);
  const after = await pixels(await call('get_preview', { backend: 'native', documentId: initial.id, maxWidth: 64 }));
  for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++) {
    const offset = (y * 64 + x) * 4;
    if (x < 32) assert.deepEqual([...after.data.subarray(offset, offset + 4)], [34, 85, 255, 255]);
    else assert.deepEqual(after.data.subarray(offset, offset + 4), before.data.subarray(offset, offset + 4));
  }
  assert.equal(result(await call('edit_image', args)).job.id, started.id);
  assert.equal(calls.length, 1);
  await call('undo', { backend: 'native', documentId: initial.id, expectedRevision: applied.document.revision });
  assert.deepEqual((await pixels(await call('get_preview', { backend: 'native', documentId: initial.id, maxWidth: 64 }))).data, before.data);
});

test('MCP cancellation aborts pending work and replaying its stable request does not issue another charge', { timeout: 15000 }, async t => {
  const { call, calls, job } = await fixture(t);
  const args = { prompt: 'Cancel pending fake output', requestId: 'cancel-mcp-job' };
  const started = result(await call('generate_image', args)).job;
  await until(() => calls.length === 1, 'pending provider call');
  assert.equal(failure(await call('get_generation_preview', { jobId: started.id })).code, 'NOT_READY');
  assert.equal(result(await call('cancel_generation', { jobId: started.id })).job.status, 'cancelled');
  await job(started.id, 'cancelled');
  assert.equal(calls[0].args.signal.aborted, true);
  assert.equal(result(await call('generate_image', args)).job.status, 'cancelled');
  assert.equal(result(await call('cancel_generation', { jobId: started.id })).job.status, 'cancelled');
  assert.deepEqual(result(await call('list_documents', { backend: 'native' })).documents, []);
  assert.equal(calls.length, 1);
});
