import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { createCompanion } from '../server/index.mjs';

// No real provider calls or local key configuration are used in this suite.
const TEST_KEY = 'sk-test-only-generation-http-not-a-real-credential';
const generated = await sharp({ create: { width: 64, height: 48, channels: 4, background: '#00bbdd' } }).png().toBuffer();
const output = () => ({ data: generated, mimeType: 'image/png', usage: { input_tokens: 5, output_tokens: 10 }, requestId: 'fake-http-provider-request' });

function controlledProvider() {
  const calls = [];
  return { calls, provider: args => new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error('Fake provider cancelled'), { code: 'AI_CANCELLED' }));
    args.signal.addEventListener('abort', abort, { once: true });
    calls.push({ args, resolve: result => { args.signal.removeEventListener('abort', abort); resolve(result); } });
    if (args.signal.aborted) abort();
  }) };
}

async function until(check, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

async function fixture(t, { provider = async () => output(), getKey = async () => TEST_KEY } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-generation-http-'));
  let app, baseUrl;
  const start = async keyReader => {
    app = await createCompanion({ dataDir, port: 0, imageProvider: provider, getImageKey: keyReader });
    baseUrl = `http://127.0.0.1:${await app.listen()}`;
  };
  t.after(async () => { if (app) await app.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  await start(getKey);
  const request = (route, { method = 'GET', body, authenticated = true, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest(baseUrl + route, { method, headers: {
      ...(authenticated ? { authorization: `Bearer ${app.token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers,
    } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        try { resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const post = (route, body) => request(route, { method: 'POST', body });
  const command = async (command, args = {}) => {
    const response = await post('/api/command', { backend: 'native', command, args });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.result;
  };
  const job = (id, wanted) => until(async () => {
    const response = await request(`/api/ai/jobs/${id}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const result = response.body.job;
    return (typeof wanted === 'function' ? wanted(result) : result.status === wanted) ? result : false;
  }, `job ${id} to reach ${typeof wanted === 'function' ? 'expected state' : wanted}`);
  const render = async documentId => sharp(Buffer.from((await command('get_preview', { documentId, maxWidth: 64 })).data, 'base64')).ensureAlpha().raw().toBuffer();
  return { dataDir, request, post, command, job, render, async reopen(keyReader = getKey) { await app.close(); await start(keyReader); } };
}

test('every AI route enforces authentication, loopback Host, and trusted Origin before dispatch', async t => {
  let providerCalls = 0;
  const env = await fixture(t, { provider: async () => { providerCalls++; return output(); } });
  const id = randomUUID();
  const routes = [
    ['/api/ai/status'], ['/api/ai/jobs'], [`/api/ai/jobs/${id}`], [`/api/ai/jobs/${id}/preview`],
    ['/api/ai/jobs', { provider: 'openai', mode: 'generate', prompt: 'Unauthorized request', requestId: 'unauthorized' }],
    [`/api/ai/jobs/${id}/cancel`, {}], [`/api/ai/jobs/${id}/apply`, {}],
    [`/api/ai/jobs/${id}/handoff`], [`/api/ai/jobs/${id}/complete`, {data:generated.toString('base64')}],
  ];
  for (const [route, body] of routes) {
    const options = { ...(body === undefined ? {} : { method: 'POST', body }) };
    for (const authenticated of [false, true]) {
      const response = await env.request(route, { ...options, authenticated, ...(authenticated ? { headers: { authorization: 'Bearer invalid-test-token' } } : {}) });
      assert.equal(response.status, 401, route);
      assert.equal(response.body.error.code, 'UNAUTHORIZED');
    }
    for (const headers of [{ origin: 'https://untrusted.example' }, { host: 'untrusted.example' }, { 'sec-fetch-site': 'cross-site' }]) {
      const response = await env.request(route, { ...options, headers });
      assert.equal(response.status, 403, route);
      assert.equal(response.body.error.code, 'FORBIDDEN');
      assert.equal(response.headers['access-control-allow-origin'], undefined);
    }
  }
  const status = await env.request('/api/ai/status');
  assert.equal(status.status, 200);
  assert.equal(status.body.configured, false);
  assert.equal(status.body.configurationChecked, false);
  assert.equal((await env.request('/api/ai/status?provider=openai')).body.configured, true);
  assert.equal(status.body.defaultProvider, 'codex');
  assert.equal(status.body.providers.find(provider => provider.id === 'codex').requiresApiKey, false);
  assert.ok(status.body.models.some(model => model.id === status.body.defaultModel));
  assert.ok(!JSON.stringify(status.body).includes(TEST_KEY));
  assert.deepEqual((await env.request('/api/ai/jobs')).body.jobs, []);
  assert.equal(providerCalls, 0);
});

test('AI routes reject malformed options and job actions before creating a paid job', async t => {
  let providerCalls = 0;
  const env = await fixture(t, { provider: async () => { providerCalls++; return output(); } });
  const valid = { provider: 'openai', mode: 'generate', prompt: 'Validation fixture', requestId: 'validation' };
  for (const args of [
    null, [], {}, { ...valid, prompt: '  ' }, { ...valid, mode: 'unknown' },
    { ...valid, unexpected: true }, { ...valid, requestId: 12 },
    { ...valid, quality: 'max', model: 'gpt-image-2' },
    { ...valid, mode: 'edit' }, { ...valid, documentId: randomUUID() },
    { ...valid, expectedRevision: 1 }, { ...valid, scope: 'selection' },
  ]) {
    const response = await env.post('/api/ai/jobs', args);
    assert.equal(response.status, 400, JSON.stringify(args));
    assert.equal(response.body.error.code, 'INVALID_ARGUMENTS');
  }
  assert.equal((await env.request('/api/ai/jobs/not-a-uuid')).status, 400);
  assert.equal((await env.request(`/api/ai/jobs/${randomUUID()}`)).status, 404);
  const fakeId = randomUUID();
  for (const maxWidth of ['0', '31', '2401', 'NaN', '64.5']) {
    const response = await env.request(`/api/ai/jobs/${fakeId}/preview?maxWidth=${maxWidth}`);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'INVALID_ARGUMENTS');
  }
  for (const body of [null, [], { retry: true }]) assert.equal((await env.post(`/api/ai/jobs/${fakeId}/cancel`, body)).body.error.code, 'INVALID_ARGUMENTS');
  for (const body of [{ expectedRevision: 0 }, { documentId: 'unexpected' }, null]) assert.equal((await env.post(`/api/ai/jobs/${fakeId}/apply`, body)).body.error.code, 'INVALID_ARGUMENTS');
  for (const body of [null, [], {}, {data:'not base64'}, {data:'AA=='}, {data:generated.toString('base64'),path:'/not-accepted.png'}]) {
    const response=await env.post(`/api/ai/jobs/${fakeId}/complete`,body);
    assert.equal(response.status, body?.data === 'AA==' ? 404 : 400);
  }
  assert.deepEqual((await env.request('/api/ai/jobs')).body.jobs, []);
  assert.equal(providerCalls, 0);
});

test('HTTP generation idempotency persists across restart and returns actual generated previews and installed pixels', async t => {
  let providerCalls = 0;
  const env = await fixture(t, { provider: async args => { providerCalls++; assert.equal(args.apiKey, TEST_KEY); assert.equal(args.image, undefined); return output(); } });
  const args = { provider: 'openai', mode: 'generate', prompt: 'An isolated turquoise test image', requestId: 'persistent-http-generation', name: 'HTTP generated fixture' };
  const responses = await Promise.all([env.post('/api/ai/jobs', args), env.post('/api/ai/jobs', args)]);
  for (const response of responses) assert.equal(response.status, 202, JSON.stringify(response.body));
  assert.equal(responses[0].body.job.id, responses[1].body.job.id);
  const id = responses[0].body.job.id;
  const complete = await env.job(id, 'succeeded');
  assert.equal(complete.outputAvailable, true);
  assert.ok(complete.documentId && complete.layerId);
  assert.equal(providerCalls, 1);
  const document = (await env.command('get_document', { documentId: complete.documentId })).document;
  assert.equal(document.layers.length, 1);
  assert.equal(document.layers[0].provenance.jobId, id);
  assert.equal(document.name, 'HTTP generated fixture');
  const expectedPixels = await sharp(generated).ensureAlpha().raw().toBuffer();
  assert.deepEqual(await env.render(document.id), expectedPixels);
  const preview = await env.request(`/api/ai/jobs/${id}/preview?maxWidth=32`);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.mimeType, 'image/png');
  assert.equal(preview.body.width, 32);
  assert.equal(preview.body.height, 24);
  const decoded = await sharp(Buffer.from(preview.body.data, 'base64')).metadata();
  assert.equal(decoded.width, 32);
  assert.equal(decoded.height, 24);
  const conflict = await env.post('/api/ai/jobs', { ...args, prompt: 'A different image' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
  await env.reopen(async () => null);
  assert.equal((await env.request('/api/ai/status')).body.configured, false);
  const retry = await env.post('/api/ai/jobs', args);
  assert.equal(retry.status, 202);
  assert.equal(retry.body.job.id, id);
  assert.equal(retry.body.job.status, 'succeeded');
  assert.equal((await env.request('/api/ai/jobs')).body.jobs.length, 1);
  assert.deepEqual(await env.render(document.id), expectedPixels);
  assert.equal(providerCalls, 1);
  for (const route of ['/api/ai/status', '/api/ai/jobs', `/api/ai/jobs/${id}`]) assert.ok(!JSON.stringify((await env.request(route)).body).includes(TEST_KEY));
});

test('HTTP selected edits retain stale output until explicitly applied using the current revision', async t => {
  const fake = controlledProvider();
  const env = await fixture(t, { provider: fake.provider });
  let document = (await env.command('create_document', { name: 'Protected image', width: 64, height: 48, background: '#804020' })).document;
  document = (await env.command('select_rectangle', { documentId: document.id, x: 0, y: 0, width: 32, height: 48 })).document;
  const response = await env.post('/api/ai/jobs', { provider: 'openai', mode: 'edit', prompt: 'Turquoise left half', documentId: document.id, expectedRevision: document.revision, scope: 'selection', requestId: 'selected-http-edit' });
  assert.equal(response.status, 202);
  const id = response.body.job.id;
  await until(() => fake.calls.length === 1, 'fake provider dispatch');
  assert.ok(Buffer.isBuffer(fake.calls[0].args.image));
  assert.ok(Buffer.isBuffer(fake.calls[0].args.mask));
  assert.equal((await env.request(`/api/ai/jobs/${id}/preview`)).body.error.code, 'NOT_READY');
  const current = (await env.command('set_layer', { documentId: document.id, layerId: document.layers[0].id, expectedRevision: document.revision, name: 'Changed while generating' })).document;
  const before = await env.render(document.id);
  fake.calls[0].resolve(output());
  const ready = await env.job(id, job => job.status === 'ready' && job.error?.code === 'REVISION_CONFLICT');
  assert.equal(ready.outputAvailable, true);
  assert.deepEqual(await env.render(document.id), before);
  assert.equal((await env.post(`/api/ai/jobs/${id}/apply`, {})).body.error.code, 'INVALID_ARGUMENT');
  const stale = await env.post(`/api/ai/jobs/${id}/apply`, { expectedRevision: document.revision });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'REVISION_CONFLICT');
  const applied = await env.post(`/api/ai/jobs/${id}/apply`, { expectedRevision: current.revision });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.job.status, 'succeeded');
  assert.equal(applied.body.document.layers.length, 2);
  const after = await env.render(document.id);
  for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++) {
    const offset = (y * 64 + x) * 4;
    if (x < 32) assert.deepEqual([...after.subarray(offset, offset + 4)], [0, 187, 221, 255]);
    else assert.deepEqual(after.subarray(offset, offset + 4), before.subarray(offset, offset + 4));
  }
  const again = await env.post(`/api/ai/jobs/${id}/apply`, {});
  assert.equal(again.body.job.id, id);
  assert.equal((await env.command('get_document', { documentId: document.id })).document.layers.length, 2);
  assert.equal(fake.calls.length, 1);
  await env.command('undo', { documentId: document.id });
  assert.deepEqual(await env.render(document.id), before);
});

test('HTTP cancellation aborts the fake provider and missing configuration fails before dispatch', async t => {
  const fake = controlledProvider();
  const env = await fixture(t, { provider: fake.provider });
  const started = await env.post('/api/ai/jobs', { provider: 'openai', mode: 'generate', prompt: 'Cancel this pending image', requestId: 'cancel-http' });
  const id = started.body.job.id;
  await until(() => fake.calls.length === 1, 'pending fake generation');
  const cancelled = await env.post(`/api/ai/jobs/${id}/cancel`, {});
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.job.status, 'cancelled');
  assert.equal(fake.calls[0].args.signal.aborted, true);
  assert.equal((await env.post(`/api/ai/jobs/${id}/cancel`, {})).body.job.status, 'cancelled');
  assert.deepEqual((await env.command('list_documents')).documents, []);
  assert.equal((await env.request(`/api/ai/jobs/${id}/preview`)).body.error.code, 'NOT_READY');
  await env.reopen(async () => null);
  const missing = await env.post('/api/ai/jobs', { provider: 'openai', mode: 'generate', prompt: 'No configuration', requestId: 'missing-configuration' });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'AI_NOT_CONFIGURED');
  assert.equal(fake.calls.length, 1);
  assert.equal((await env.request('/api/ai/jobs')).body.jobs.length, 1);
});
