import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { createCompanion } from '../server/index.mjs';
import { ChatManager, normalizeChatRequest } from '../server/chat.mjs';

const deny = () => assert.fail('No real API/key/CLI call belongs in this test.');
const pause = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(check) { const end = Date.now() + 5000; while (Date.now() < end) { const result = await check(); if (result) return result; await pause(); } assert.fail('Timed out waiting for isolated chat work.'); }
async function fixture(t, adapter, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-chat-'));
  const app = await createCompanion({ dataDir, port: 0, chatEnabled: true, chatAdapter: { check: async () => ({ available: true }), ...adapter }, imageProvider: deny, getImageKey: deny, ...options });
  const baseUrl = `http://127.0.0.1:${await app.listen()}`;
  t.after(async () => { await app.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const request = async (route, body, token = app.token) => {
    const response = await fetch(baseUrl + route, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  return { app, dataDir, baseUrl, request };
}
async function privateCall(context, name, args, callId = randomUUID()) {
  const response = await fetch(`${context.baseUrl}/api/chat/${context.turnId}/tool`, { method: 'POST', headers: { Authorization: `Bearer ${context.capabilityToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name, arguments: args, callId }) });
  assert.equal(response.status, 200); return response.json();
}
const terminal = async (app, id) => until(async () => (await app.chat.list()).turns.find(turn => turn.id === id && !['queued', 'running'].includes(turn.status)));

test('Chat durable request and tool receipts deduplicate actual native edits and keep capabilities private', async t => {
  let context, calls = 0, release, runnerFailure; const gate = new Promise(resolve => { release = resolve; });
  const { app, dataDir, request } = await fixture(t, { run: async ({ turn, toolContext, onEvent }) => {
    try {
    calls++; context = toolContext;
    const receipt = JSON.parse(await fs.readFile(path.join(dataDir, 'chat/turns', `${turn.id}.json`)));
    assert.equal(receipt.status, 'running'); assert.ok(!JSON.stringify(receipt).includes(toolContext.capabilityToken));
    await gate;
    const callId = randomUUID(), args = { name: 'create_document', args: { name: 'Chat native fixture', width: 8, height: 8, background: '#42688a' } };
    const [first, second] = await Promise.all([privateCall(toolContext, 'prism_execute', args, callId), privateCall(toolContext, 'prism_execute', args, callId)]);
    assert.deepEqual(first, second); assert.equal(first.isError, undefined, JSON.stringify(first.structuredContent)); assert.ok(first.structuredContent.document.id);
    await onEvent({ label: `Private ${toolContext.capabilityToken}`, status: 'succeeded' });
    return { reply: `Created a document. ${toolContext.capabilityToken}` };
    } catch (cause) { runnerFailure = cause; throw cause; }
  } });
  const args = { message: 'Make a small blue document', requestId: 'chat-native-once' };
  const started = await request('/api/chat', args); assert.equal(started.status, 202);
  assert.equal((await request('/api/chat', args)).body.turn.id, started.body.turn.id);
  assert.equal((await request('/api/chat', { ...args, message: 'Changed request' })).body.error.code, 'IDEMPOTENCY_CONFLICT');
  await until(() => context);
  assert.equal((await request(`/api/chat/${context.turnId}/tools`)).status, 401);
  assert.equal((await request(`/api/chat/${context.turnId}/tools`, undefined, context.capabilityToken)).body.tools.length, 5);
  assert.equal((await request('/api/chat', undefined, context.capabilityToken)).status, 401);
  assert.equal((await request('/api/session', undefined, context.capabilityToken)).status, 401);
  release(); const done = await terminal(app, context.turnId); assert.equal(done.status, 'succeeded', runnerFailure?.stack); assert.ok(done.resultDocumentId);
  assert.equal(calls, 1); assert.equal((await app.native.execute('list_documents')).documents.length, 1);
  assert.ok(!JSON.stringify(done).includes(context.capabilityToken));
  const receipt = JSON.parse(await fs.readFile(path.join(dataDir, 'chat/turns', `${done.id}.json`)));
  assert.equal(receipt.calls.length, 1); assert.equal(receipt.calls[0].status, 'succeeded'); assert.ok(!JSON.stringify(receipt).includes(context.capabilityToken));
  assert.equal((await request(`/api/chat/${done.id}/tools`, undefined, context.capabilityToken)).status, 401);
});

test('Chat cancellation revokes its private capability and a cancelled queued turn never invokes the runner', async t => {
  let context, release, calls = 0;
  const { app } = await fixture(t, { run: async ({ toolContext, signal }) => { calls++; context = toolContext; await new Promise(resolve => { release = resolve; }); assert.equal(signal.aborted, true); return { reply: 'Too late' }; } });
  const first = (await app.chat.start({ message: 'First request', requestId: 'first' })).turn;
  await until(() => context);
  const second = (await app.chat.start({ message: 'Queued request', requestId: 'second' })).turn;
  await app.chat.cancel(second.id); await app.chat.cancel(first.id);
  assert.throws(() => app.chat.authenticate(first.id, context.capabilityToken), { code: 'UNAUTHORIZED' });
  release(); await until(() => !app.chat.worker);
  assert.equal(calls, 1); assert.deepEqual((await app.chat.list()).turns.map(turn => turn.status), ['cancelled', 'cancelled']);
});

test('Chat real generation tool records a synthetic worker result and continues with native editing', async t => {
  const generated = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#985632' } }).png().toBuffer();
  let imageCalls = 0;
  const { app } = await fixture(t, { run: async ({ toolContext }) => {
    const request = privateCall(toolContext, 'prism_generate_image', { prompt: 'A tiny synthetic fixture' });
    await until(() => app.generation.list().jobs.length === 1); await app.codexWorker.tick();
    const image = await request; assert.equal(image.isError, undefined); const document = image.structuredContent.document;
    const edited = await privateCall(toolContext, 'prism_execute', { name: 'add_shape', args: { documentId: document.id, expectedRevision: document.revision, shape: 'rectangle', x: 0, y: 0, width: 2, height: 2, fill: '#ffffff' } });
    assert.equal(edited.isError, undefined); return { reply: 'Created an image and added an editable rectangle.' };
  } }, { codexWorkerEnabled: true, codexImageAdapter: { check: async () => ({ available: true }), generate: async () => { imageCalls++; return generated; } } });
  const turn = (await app.chat.start({ message: 'Generate then add a rectangle', requestId: 'mixed' })).turn;
  const done = await terminal(app, turn.id); assert.equal(done.status, 'succeeded'); assert.equal(imageCalls, 1); assert.equal(done.generationJobIds.length, 1);
  const document = (await app.native.execute('get_document', { documentId: done.resultDocumentId })).document;
  assert.equal(document.layers.length, 2); assert.equal(document.layers[1].type, 'shape');
});

test('Chat runner failure aborts a pending generation tool before waiting for its tail', async t => {
  let pendingTool;
  const { app } = await fixture(t, { run: async ({ toolContext }) => {
    pendingTool = privateCall(toolContext, 'prism_generate_image', { prompt: 'Never reach the worker' });
    await until(() => app.generation.list().jobs.length === 1);
    throw new Error('Private runner failure text');
  } }, { codexWorkerEnabled: true, codexImageAdapter: { check: async () => ({ available: true }), generate: deny } });
  const turn = (await app.chat.start({ message: 'An interrupted image request', requestId: 'fail-before-image' })).turn;
  const done = await terminal(app, turn.id); await pendingTool;
  assert.equal(done.status, 'failed'); assert.ok(!JSON.stringify(done).includes('Private runner failure'));
  assert.equal(app.generation.get(done.generationJobIds[0]).job.status, 'cancelled');
  await app.codexWorker.tick(); assert.equal((await app.native.execute('list_documents')).documents.length, 0);
});

test('Chat startup interrupts durable pending turns and cancels their queued image jobs without replay', async t => {
  const { app, dataDir } = await fixture(t, { run: deny }, { codexWorkerEnabled: true, codexImageAdapter: { check: async () => ({ available: true }), generate: deny } });
  app.chat.kick = () => {};
  const turn = (await app.chat.start({ message: 'A stored unstarted request', requestId: 'restart' })).turn;
  const job = (await app.generation.start({ mode: 'generate', prompt: 'Stored child request' })).job;
  await app.chat.update(turn.id, current => ({ ...current, status: 'running', generationJobIds: [job.id] }));
  const reopened = await new ChatManager({ dataDir, native: app.native, generation: app.generation, adapter: { check: async () => ({ available: true }), run: deny }, enabled: true, createToolContext: deny }).init();
  t.after(() => reopened.close());
  assert.equal((await reopened.list()).turns[0].status, 'interrupted'); assert.equal(app.generation.get(job.id).job.status, 'cancelled');
  await app.codexWorker.tick(); assert.equal((await app.native.execute('list_documents')).documents.length, 0);
  assert.equal((await reopened.start({ message: turn.message, requestId: turn.requestId })).turn.status, 'interrupted');
});

test('Chat captures request settings and carries bounded verified result context into follow-up turns', async t => {
  let seenHistory;
  const { app } = await fixture(t, { run: async ({ turn, history, toolContext }) => {
    if (turn.requestId === 'context-first') { const result = await privateCall(toolContext, 'prism_execute', { name: 'create_document', args: { name: 'Context fixture', width: 8, height: 8, background: '#000000' } }); assert.equal(result.isError, undefined); return { reply: 'Created the document.' }; }
    seenHistory = history; return { reply: 'I can inspect that document next.' };
  } });
  const input = { message: 'Create a document', requestId: 'context-first' }, pending = app.chat.start(input); input.message = 'Mutated after call';
  const first = await terminal(app, (await pending).turn.id); assert.equal(first.message, 'Create a document'); assert.equal(typeof first.resultDocumentId, 'string');
  await terminal(app, (await app.chat.start({ message: 'Make it warmer', requestId: 'context-next' })).turn.id);
  assert.deepEqual(seenHistory.map(item => item.role), ['user', 'assistant']); assert.equal(seenHistory[1].resultDocumentId, first.resultDocumentId);
  let getters = 0; assert.throws(() => normalizeChatRequest({ requestId: 'getter', get message() { getters++; return 'No'; } }), { code: 'INVALID_ARGUMENTS' }); assert.equal(getters, 0);
});

test('Chat tool input limits refuse oversized and excessive queued arguments before dispatch without invoking getters', async t => {
  let context, finishTurn, finishTool, toolCalls = 0;
  const turnGate = new Promise(resolve => { finishTurn = resolve; }), toolGate = new Promise(resolve => { finishTool = resolve; });
  const { app, request } = await fixture(t, { run: async ({ toolContext }) => { context = toolContext; await turnGate; return { reply: 'Finished bounded test.' }; } }, {
    chatToolContextFactory: () => ({ manifest: [], call: async () => { toolCalls++; await toolGate; return { content: [{ type: 'text', text: 'ok' }] }; }, close: async () => {} }),
  });
  const turn = (await app.chat.start({ message: 'Bounded arguments fixture', requestId: 'argument-limits' })).turn; await until(() => context);
  const payload = 'x'.repeat(1_040_000), requests = Array.from({ length: 8 }, () => ({ name: 'bounded', arguments: { payload }, callId: randomUUID() }));
  const pending = requests.map(input => app.chat.tool(turn.id, context.capabilityToken, input));
  assert.equal(app.chat.tool(turn.id, context.capabilityToken, requests[0]), pending[0]);
  assert.throws(() => app.chat.tool(turn.id, context.capabilityToken, { name: 'bounded', arguments: { payload }, callId: randomUUID() }), { code: 'LIMIT_EXCEEDED' });
  await until(() => toolCalls === 1);
  let getters = 0;
  assert.throws(() => app.chat.tool(turn.id, context.capabilityToken, { name: 'bounded', arguments: { get secret() { getters++; return 'no'; } }, callId: randomUUID() }), { code: 'INVALID_ARGUMENTS' });
  assert.equal(getters, 0);
  const oversized = await request(`/api/chat/${turn.id}/tool`, { name: 'bounded', arguments: { payload: 'x'.repeat(1024 * 1024) }, callId: randomUUID() }, context.capabilityToken);
  assert.equal(oversized.status, 413); assert.equal(toolCalls, 1);
  finishTool(); await Promise.all(pending); assert.equal(toolCalls, 8); assert.equal(app.chat.active.pendingInputBytes, 0);
  finishTurn(); assert.equal((await terminal(app, turn.id)).status, 'succeeded');
});

test('Chat cancellation intent prevents runner launch while the cancelled receipt is still being saved', async t => {
  let runnerCalls = 0;
  const { app } = await fixture(t, { run: async () => { runnerCalls++; return { reply: 'Unexpected runner invocation' }; } });
  const run = app.chat.run.bind(app.chat), write = app.chat.write.bind(app.chat);
  let enteredRun, releaseRun, enteredSave, releaseSave;
  const beforeRun = new Promise(resolve => { enteredRun = resolve; }), runGate = new Promise(resolve => { releaseRun = resolve; });
  const beforeSave = new Promise(resolve => { enteredSave = resolve; }), saveGate = new Promise(resolve => { releaseSave = resolve; });
  app.chat.run = async record => { enteredRun(); await runGate; return run(record); };
  app.chat.write = async record => { if (record.status === 'cancelled') { enteredSave(); await saveGate; } return write(record); };
  const turn = (await app.chat.start({ message: 'Stop before the runner exists', requestId: 'cancel-before-controller' })).turn;
  await beforeRun; const cancelled = app.chat.cancel(turn.id); await beforeSave;
  releaseRun(); await pause(); await pause(); releaseSave(); await cancelled;
  await until(() => !app.chat.worker); assert.equal((await app.chat.list()).turns[0].status, 'cancelled'); assert.equal(runnerCalls, 0);
});


test('known runner failures retain safe specific reasons through public history and durable receipts', async t => {
  let failureCode;
  const { app, dataDir, request } = await fixture(t, { run: async () => { throw Object.assign(new Error('private-secret raw process output'), { code: failureCode }); } });
  for (const code of ['CHAT_OUTPUT_LIMIT', 'CHAT_INVALID_RECEIPT', 'CHAT_PROCESS_FAILED', 'CHAT_INCOMPLETE_REPLY', 'CHAT_AGENT_FAILED', 'CHAT_START_FAILED', 'UNRECOGNIZED_PRIVATE_FAILURE']) {
    failureCode = code;
    const accepted = (await request('/api/chat', { message: 'Inspect this test document', requestId: randomUUID() })).body.turn;
    const done = await terminal(app, accepted.id);
    assert.equal(done.status, 'failed');
    assert.equal(done.error.code, code === 'UNRECOGNIZED_PRIVATE_FAILURE' ? 'CHAT_FAILED' : code);
    assert.ok(!JSON.stringify(done).includes('private-secret'));
    const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'chat/turns', `${done.id}.json`)));
    assert.deepEqual(saved.error, done.error);
    const history = (await request('/api/chat')).body.turns.find(turn => turn.id === done.id);
    assert.deepEqual(history.error, done.error);
    assert.ok(!JSON.stringify(history).includes('raw process output'));
  }
});
