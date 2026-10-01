import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { request as httpRequest } from 'node:http';
import sharp from 'sharp';
import { createCompanion } from '../server/index.mjs';

async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-service-test-'));
  const app = await createCompanion({ dataDir, port: 0, ...options });
  const port = await app.listen();
  const url = `http://127.0.0.1:${port}`;
  t.after(async () => { await app.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const request = (pathname, { method = 'GET', body, headers = {}, authenticated = true } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest(url + pathname, {
      method,
      headers: { ...(authenticated ? { authorization: `Bearer ${app.token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        try { resolve({ status: response.statusCode, headers: new Headers(response.headers), body: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const command = (command, args = {}, extra = {}) => request('/api/command', { method: 'POST', body: { backend: 'native', command, args, ...extra } });
  return { app, dataDir, port, url, request, command };
}

async function create(command, options = {}) {
  const response = await command('create_document', { name: 'HTTP integration', width: 64, height: 48, background: '#406080', ...options });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.result.document;
}

test('HTTP session bootstrap is local, APIs require the pairing key, and credentials are not exposed to other origins', async t => {
  const { app, dataDir, request } = await fixture(t);
  const session = await request('/api/session', { authenticated: false });
  assert.equal(session.status, 200);
  assert.equal(session.body.token, app.token);
  assert.match(session.body.token, /^[a-f0-9]{64}$/);
  assert.equal((await fs.stat(path.join(dataDir, 'bridge-token'))).mode & 0o777, 0o600);
  for (const endpoint of ['/api/status', '/api/setup', '/api/activity']) {
    const missing = await request(endpoint, { authenticated: false });
    assert.equal(missing.status, 401);
    assert.equal(missing.body.error.code, 'UNAUTHORIZED');
    const invalid = await request(endpoint, { headers: { authorization: 'Bearer wrong-key' } });
    assert.equal(invalid.status, 401);
    assert.ok(!JSON.stringify(invalid.body).includes(app.token));
  }
  for (const headers of [{ origin: 'https://example.com' }, { host: 'attacker.example' }, { 'sec-fetch-site': 'cross-site' }]) {
    const forbidden = await request('/api/session', { authenticated: false, headers });
    assert.equal(forbidden.status, 403, JSON.stringify(headers));
    assert.equal(forbidden.body.error.code, 'FORBIDDEN');
    assert.equal(forbidden.headers.get('access-control-allow-origin'), null);
    assert.ok(!JSON.stringify(forbidden.body).includes(app.token));
  }
  const setup = await request('/api/setup');
  assert.equal(setup.status, 200);
  assert.deepEqual(Object.keys(setup.body).sort(), ['mcpArgs', 'mcpCommand']);
  assert.ok(setup.body.mcpArgs[0].endsWith('server/mcp.mjs'));
});

test('HTTP commands reject invalid input before changing documents and expose accurate backend capabilities', async t => {
  const { request, command } = await fixture(t);
  const status = await request('/api/status');
  assert.equal(status.body.backends.find(backend => backend.id === 'native').connected, true);
  assert.deepEqual(status.body.backends.map(backend => backend.id), ['native']);
  assert.equal(status.body.bridge, undefined);
  assert.ok(status.body.backends.find(backend => backend.id === 'native').commands.includes('apply_transaction'));
  for (const [name, args, code] of [
    ['create_document', { name: 'Too large', width: 8192, height: 8192 }, 'IMAGE_TOO_LARGE'],
    ['create_document', { name: 'Invalid', width: -1, height: 24 }, 'INVALID_ARGUMENTS'],
    ['create_document', { name: 'Invalid', width: 24, height: 24, script: 'arbitrary' }, 'INVALID_ARGUMENTS'],
    ['add_adjustment', { documentId: 'missing', kind: 'exposure', value: 6 }, 'INVALID_ARGUMENTS'],
    ['eval', { script: 'arbitrary' }, 'UNSUPPORTED_COMMAND'],
  ]) {
    const response = await command(name, args);
    assert.equal(response.body.error.code, code);
    assert.ok(response.status >= 400 && response.status < 500);
  }
  const otherBackend = await command('list_documents', {}, { backend: 'photoshop' });
  assert.equal(otherBackend.status, 400);
  assert.equal(otherBackend.body.error.code, 'INVALID_ARGUMENTS');
  const missingAuth = await request('/api/command', { method: 'POST', authenticated: false, body: { backend: 'native', command: 'list_documents', args: {} } });
  assert.equal(missingAuth.status, 401);
  assert.deepEqual((await command('list_documents')).body.result.documents, []);
});

test('concurrent duplicate request IDs execute a real native edit exactly once and conflicting reuse is rejected', async t => {
  const { command, request } = await fixture(t);
  const document = await create(command);
  const args = { documentId: document.id, expectedRevision: document.revision, kind: 'exposure', value: 1 };
  const responses = await Promise.all([
    command('add_adjustment', args, { requestId: 'same-edit' }),
    command('add_adjustment', args, { requestId: 'same-edit' }),
  ]);
  for (const response of responses) assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(responses[0].body, responses[1].body);
  const current = (await command('get_document', { documentId: document.id })).body.result.document;
  assert.equal(current.layers.length, 2);
  assert.equal(current.revision, document.revision + 1);
  const conflict = await command('add_adjustment', { ...args, value: -1 }, { requestId: 'same-edit' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'REQUEST_CONFLICT');
  const activity = (await request('/api/activity')).body.activity;
  assert.equal(activity.filter(item => item.command === 'add_adjustment').length, 1);
  assert.equal(activity.find(item => item.command === 'add_adjustment').status, 'success');
});

test('HTTP transactions produce one undo step, preserve rendered pixels after undo, and reject unsafe members', async t => {
  const { command } = await fixture(t);
  const initial = await create(command);
  const preview = async () => {
    const result = (await command('get_preview', { documentId: initial.id, maxWidth: 64 })).body.result;
    return sharp(Buffer.from(result.data, 'base64')).raw().toBuffer();
  };
  const before = await preview();
  const transaction = await command('apply_transaction', { documentId: initial.id, expectedRevision: initial.revision, label: 'Warm and brighten', operations: [
    { command: 'add_adjustment', args: { kind: 'temperature', value: 40 } },
    { command: 'add_adjustment', args: { kind: 'brightness', value: 10 } },
  ] });
  assert.equal(transaction.status, 200, JSON.stringify(transaction.body));
  const edited = transaction.body.result.document;
  assert.equal(edited.revision, initial.revision + 1);
  assert.equal(edited.history.length, initial.history.length + 1);
  assert.equal(edited.history.at(-1).label, 'Warm and brighten');
  assert.equal(edited.layers.length, 3);
  assert.notDeepEqual(await preview(), before);
  const undone = await command('undo', { documentId: initial.id, expectedRevision: edited.revision });
  assert.equal(undone.status, 200);
  assert.equal(undone.body.result.document.layers.length, 1);
  assert.deepEqual(await preview(), before);
  for (const operation of [
    { command: 'undo', args: {} },
    { command: 'add_adjustment', args: { documentId: 'another-document', kind: 'brightness', value: 1 } },
    { command: 'add_adjustment', args: { expectedRevision: 1, kind: 'brightness', value: 1 } },
  ]) {
    const invalid = await command('apply_transaction', { documentId: initial.id, label: 'Invalid transaction', operations: [operation] });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'INVALID_TRANSACTION');
  }
});

test('stale HTTP revisions return conflict without overwriting the current image', async t => {
  const { command } = await fixture(t);
  const initial = await create(command);
  const first = await command('add_adjustment', { documentId: initial.id, expectedRevision: initial.revision, kind: 'brightness', value: 15 });
  assert.equal(first.status, 200);
  const stale = await command('add_adjustment', { documentId: initial.id, expectedRevision: initial.revision, kind: 'brightness', value: -15 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'REVISION_CONFLICT');
  assert.deepEqual((await command('get_document', { documentId: initial.id })).body.result.document, first.body.result.document);
});
