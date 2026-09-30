import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import WebSocket from 'ws';
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

async function connect(t, fixture, hello = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${fixture.port}/bridge`);
  t.after(() => socket.terminate());
  await once(socket, 'open');
  const ready = once(socket, 'message');
  socket.send(JSON.stringify({ type: 'hello', token: fixture.app.token, pluginVersion: 'test-fake', appVersion: 'test-fake', capabilities: ['list_documents', 'get_document', 'add_adjustment'], ...hello }));
  const [bytes] = await ready;
  assert.deepEqual(JSON.parse(bytes.toString()), { type: 'welcome', protocolVersion: 1 });
  return socket;
}

async function eventually(check) {
  const deadline = Date.now() + 2000;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail('Expected state was not reached within 2 seconds');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
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
  assert.ok(setup.body.bridgeUrl.endsWith('/bridge'));
  assert.ok(setup.body.mcpArgs[0].endsWith('server/mcp.mjs'));
});

test('HTTP commands reject invalid input before changing documents and expose accurate backend capabilities', async t => {
  const { request, command } = await fixture(t);
  const status = await request('/api/status');
  assert.equal(status.body.backends.find(backend => backend.id === 'native').connected, true);
  assert.equal(status.body.backends.find(backend => backend.id === 'photoshop').connected, false);
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

// These tests exercise the actual companion protocol using a fake UXP peer. They
// do not establish compatibility with a running copy of Adobe Photoshop.
test('fake UXP peer pairs, advertises exact capabilities, receives commands, and disconnects cleanly', async t => {
  const env = await fixture(t);
  const unavailable = await env.command('list_documents', {}, { backend: 'photoshop' });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.error.code, 'PHOTOSHOP_DISCONNECTED');
  const socket = await connect(t, env);
  const status = (await env.request('/api/status')).body;
  assert.equal(status.bridge.connected, true);
  assert.equal(status.bridge.appVersion, 'test-fake');
  assert.deepEqual(status.backends.find(item => item.id === 'photoshop').commands, ['list_documents', 'get_document', 'add_adjustment']);
  const capabilities = await env.command('capabilities', {}, { backend: 'photoshop' });
  assert.deepEqual(capabilities.body.result.commands, ['list_documents', 'get_document', 'add_adjustment']);
  const received = once(socket, 'message');
  const result = env.command('get_document', { documentId: 'fake-document-1' }, { backend: 'photoshop' });
  const [bytes] = await received;
  const message = JSON.parse(bytes.toString());
  assert.equal(message.type, 'command');
  assert.equal(message.command, 'get_document');
  assert.deepEqual(message.args, { documentId: 'fake-document-1' });
  socket.send(JSON.stringify({ type: 'result', id: message.id, result: { document: { id: 'fake-document-1', revision: 7, backend: 'photoshop' } } }));
  assert.equal((await result).body.result.document.revision, 7);
  const unsupported = await env.command('select_subject', { documentId: 'fake-document-1' }, { backend: 'photoshop' });
  assert.equal(unsupported.status, 400);
  assert.equal(unsupported.body.error.code, 'UNSUPPORTED_COMMAND');
  const closed = once(socket, 'close');
  socket.close();
  await closed;
  await eventually(async () => !(await env.request('/api/status')).body.bridge.connected);
  assert.equal((await env.command('list_documents', {}, { backend: 'photoshop' })).status, 503);
});

test('fake UXP peers with invalid pairing credentials or capabilities are rejected, and a second peer cannot replace the first', async t => {
  const env = await fixture(t);
  for (const hello of [
    { type: 'hello', capabilities: [] },
    { type: 'hello', token: 'invalid', capabilities: [] },
    { type: 'hello', token: env.app.token, capabilities: 'invalid' },
  ]) {
    const socket = new WebSocket(`ws://127.0.0.1:${env.port}/bridge`);
    t.after(() => socket.terminate());
    await once(socket, 'open');
    const closed = once(socket, 'close');
    socket.send(JSON.stringify(hello));
    const [code] = await closed;
    assert.equal(code, hello.token === env.app.token ? 4002 : 4003);
  }
  const first = await connect(t, env);
  const second = new WebSocket(`ws://127.0.0.1:${env.port}/bridge`);
  t.after(() => second.terminate());
  await once(second, 'open');
  const rejected = once(second, 'close');
  second.send(JSON.stringify({ type: 'hello', token: env.app.token, capabilities: [] }));
  assert.equal((await rejected)[0], 4009);
  assert.equal(first.readyState, WebSocket.OPEN);
  assert.equal((await env.request('/api/status')).body.bridge.connected, true);
});

test('malformed and non-object WebSocket payloads cannot crash the companion', async t => {
  const env = await fixture(t);
  for (const payload of ['null', '[]', '42', '{invalid']) {
    const socket = new WebSocket(`ws://127.0.0.1:${env.port}/bridge`);
    t.after(() => socket.terminate());
    await once(socket, 'open');
    const closed = once(socket, 'close');
    socket.send(payload);
    assert.equal((await closed)[0], 4002);
    assert.equal((await env.request('/api/status')).status, 200);
  }
  const paired = await connect(t, env);
  const closed = once(paired, 'close');
  paired.send('null');
  assert.equal((await closed)[0], 4002);
  assert.equal((await env.request('/api/status')).status, 200);
});

test('a timed-out fake Photoshop mutation reports an uncertain result and is not automatically replayed', async t => {
  const env = await fixture(t, { commandTimeout: 60 });
  const socket = await connect(t, env);
  const commands = [];
  socket.on('message', bytes => commands.push(JSON.parse(bytes.toString())));
  const args = { documentId: 'fake-document-1', kind: 'brightness', value: 5 };
  const response = await env.command('add_adjustment', args, { backend: 'photoshop', requestId: 'timeout-mutation' });
  assert.equal(response.status, 504);
  assert.equal(response.body.error.code, 'COMMAND_TIMEOUT');
  assert.match(response.body.error.message, /unknown|inspect/i);
  const retry = await env.command('add_adjustment', args, { backend: 'photoshop', requestId: 'timeout-mutation' });
  assert.equal(retry.status, 504);
  assert.equal(commands.length, 1);
  socket.send(JSON.stringify({ type: 'result', id: commands[0].id, result: { document: { id: 'fake-document-1' } } }));
  assert.equal((await env.request('/api/status')).body.bridge.connected, true);
});

test('disconnect during a fake Photoshop mutation reports the uncertain outcome promptly', async t => {
  const env = await fixture(t);
  const socket = await connect(t, env);
  const received = once(socket, 'message');
  const pending = env.command('add_adjustment', { documentId: 'fake-document-1', kind: 'brightness', value: 5 }, { backend: 'photoshop' });
  await received;
  socket.close();
  const response = await pending;
  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, 'PHOTOSHOP_DISCONNECTED');
  assert.match(response.body.error.message, /may have completed|inspect/i);
});
