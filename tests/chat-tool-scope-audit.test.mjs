import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCompanion } from '../server/index.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t, adapter) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-chat-scope-audit-'));
  let generationCalls = 0, apiCalls = 0;
  const app = await createCompanion({ dataDir: directory, port: 0, chatEnabled: true, chatAdapter: adapter,
    codexWorkerEnabled: true, codexImageAdapter: { check: async () => ({ available: true }), generate: async () => { generationCalls++; throw Error('No model call is expected.'); } },
    getImageKey: async () => { apiCalls++; throw Error('No credentials allowed.'); }, imageProvider: async () => { apiCalls++; throw Error('No API allowed.'); } });
  const base = `http://127.0.0.1:${await app.listen()}`;
  t.after(async () => { await app.close(); assert.equal(apiCalls, 0); assert.equal(generationCalls, 0); await fs.rm(directory, { recursive: true, force: true }); });
  const request = async (route, token, body, extraHeaders = {}) => {
    const response = await fetch(`${base}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { ok: response.ok, status: response.status, data: await response.json() };
  };
  return { app, request };
}

test('private chat capability is restricted to its active turn and cannot authorize public or cross-origin routes', { timeout: 10000 }, async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, { check: async () => ({ available: true }), run: async ({ toolContext, signal }) => {
    entered.resolve(toolContext);
    await Promise.race([release.promise, new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))]);
    return { reply: 'No edits requested in this fixture.' };
  } });
  const { turn } = await f.app.chat.start({ message: 'Inspect tool scope', requestId: 'scope-fixture' });
  const scope = await entered.promise, route = `/api/chat/${turn.id}/tools`;
  const allowed = await f.request(route, scope.capabilityToken); assert.equal(allowed.ok, true); assert.equal(allowed.data.tools.length, 5);
  assert.equal(JSON.stringify(allowed.data).includes(scope.capabilityToken), false);
  for (const [url, token, body, headers] of [
    [route, undefined], [route, f.app.token], [route, 'f'.repeat(64)],
    [`/api/chat/${randomUUID()}/tools`, scope.capabilityToken],
    ['/api/chat', scope.capabilityToken], ['/api/session', scope.capabilityToken],
    ['/api/command', scope.capabilityToken, { backend: 'native', command: 'create_document', args: { name: 'Forbidden', width: 8, height: 8 } }],
    [route, scope.capabilityToken, undefined, { Origin: 'https://untrusted.example' }],
  ]) { const result = await f.request(url, token, body, headers); assert.equal(result.ok, false, url); }
  const publicList = await f.app.chat.list(); assert.equal(JSON.stringify(publicList).includes(scope.capabilityToken), false);
  await f.app.chat.cancel(turn.id);
  assert.equal((await f.request(route, scope.capabilityToken)).ok, false);
  const refused = await f.request(`/api/chat/${turn.id}/tool`, scope.capabilityToken, { name: 'prism_execute', arguments: { name: 'create_document', args: { name: 'Too late', width: 8, height: 8 } }, callId: randomUUID() });
  assert.equal(refused.ok, false); assert.equal((await f.app.native.execute('list_documents')).documents.length, 0);
  release.resolve(); await f.app.chat.worker;
});

test('agent failure while generation tool waits cancels its durable job before the chat turn finishes', { timeout: 10000 }, async t => {
  const created = deferred(); let toolResponse;
  const f = await fixture(t, { check: async () => ({ available: true }), run: async ({ toolContext }) => {
    toolResponse = fetch(`${toolContext.baseUrl}/api/chat/${toolContext.turnId}/tool`, { method: 'POST', headers: { Authorization: `Bearer ${toolContext.capabilityToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'prism_generate_image', arguments: { prompt: 'Do not orphan this job' }, callId: randomUUID() }) }).then(response => response.json());
    await created.promise; throw Error('private adapter failure detail');
  } });
  const start = f.app.generation.start.bind(f.app.generation);
  f.app.generation.start = async args => { const result = await start(args); created.resolve(result.job.id); return result; };
  const { turn } = await f.app.chat.start({ message: 'Generate a fixture', requestId: 'failed-agent-fixture' });
  await f.app.chat.worker;
  const response = await toolResponse; assert.equal(response.isError, true);
  const current = (await f.app.chat.list()).turns.find(item => item.id === turn.id);
  assert.equal(current.status, 'failed'); assert.equal(JSON.stringify(current).includes('private adapter failure detail'), false);
  const jobId = await created.promise; assert.equal(f.app.generation.get(jobId).job.status, 'cancelled');
  assert.ok(current.generationJobIds.includes(jobId));
  await f.app.codexWorker.tick();
  assert.equal((await f.app.native.execute('list_documents')).documents.length, 0);
});
